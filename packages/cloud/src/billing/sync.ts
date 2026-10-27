/**
 * Catalog sync: makes Stripe's products, prices and meter match pricing.ts.
 *
 * Idempotent by construction. Every object has a stable key that Stripe can
 * look up directly, so a re-run finds what the last run made instead of
 * making it again:
 *
 *  - products get a fixed id (`provenant_cloud`, `provenant_payg_bundle`, ...);
 *  - prices get a lookup key (`provenant_cloud_month`, ...). Stripe prices are
 *    immutable, so a price that drifted from pricing.ts is REPLACED: a new
 *    price takes over the lookup key and the old one is archived, never
 *    deleted, so existing subscriptions keep billing on it;
 *  - the overage meter is found by its event name.
 *
 * Each object also carries `provenant_key` metadata naming its catalog entry.
 *
 * A run that fails part-way is safe to repeat: it only does what is still
 * missing.
 */
import { z } from 'zod';
import { defineAction, LacreError, type NextAction } from '@lacre/core';
import { stripeCatalog } from './stripe.js';
import {
  loadBillingConfig, createStripeClient, redact as redactSecretShapes, PRICE_ENV,
  type BillingMode, type CatalogKey,
} from './config.js';

type Metadata = Record<string, string>;
type Interval = 'month' | 'year';
type UsageType = 'licensed' | 'metered';

interface ProductRecord { id: string; name: string; description?: string | null; metadata: Metadata }
interface PriceRecord {
  id: string;
  product: string | { id: string };
  active: boolean;
  unit_amount: number | null;
  currency: string;
  lookup_key: string | null;
  recurring: { interval: string; usage_type: string; meter?: string | null } | null;
}
interface MeterRecord { id: string; event_name: string; status: string }

interface PriceCreate {
  product: string;
  unit_amount: number;
  currency: string;
  lookup_key: string;
  transfer_lookup_key?: boolean;
  metadata: Metadata;
  recurring?: { interval: Interval; usage_type?: UsageType; meter?: string };
}

/** The slice of Stripe the sync uses. The real client satisfies it; tests
 *  use an in-memory fake, so no test reaches the Stripe network. */
export interface CatalogClient {
  products: {
    list(params: { ids: string[]; limit: number }): PromiseLike<{ data: ProductRecord[] }>;
    create(params: { id: string; name: string; description?: string; metadata: Metadata }): Promise<ProductRecord>;
    update(id: string, params: { name: string; description?: string; metadata: Metadata }): Promise<ProductRecord>;
  };
  prices: {
    list(params: { lookup_keys: string[]; active: boolean; limit: number }): PromiseLike<{ data: PriceRecord[] }>;
    create(params: PriceCreate): Promise<PriceRecord>;
    update(id: string, params: { active: boolean }): Promise<PriceRecord>;
  };
  billing: {
    meters: {
      list(params: { status: 'active'; limit: number }): PromiseLike<{ data: MeterRecord[] }>;
      create(params: {
        display_name: string;
        event_name: string;
        default_aggregation: { formula: 'count' };
        customer_mapping: { type: 'by_id'; event_payload_key: string };
      }): Promise<MeterRecord>;
    };
  };
}

const PriceShape = z.object({
  unit_amount: z.number().int().nonnegative(),
  currency: z.string(),
  recurring: z.object({ interval: z.enum(['month', 'year']), usage_type: z.enum(['licensed', 'metered']).optional() }).optional(),
});
type PriceShape = z.infer<typeof PriceShape>;

const CatalogEntry = z.object({
  product: z.object({ name: z.string(), description: z.string().optional() }),
  price: PriceShape,
  meter: z.object({ event_name: z.string(), display_name: z.string() }).optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
});

interface Desired {
  key: CatalogKey;
  lookupKey: string;
  productId: string;
  product: { name: string; description?: string; metadata: Metadata };
  price: PriceShape;
  meter?: { event_name: string; display_name: string };
  metadata: Metadata;
}

/** pricing.ts, as the objects Stripe should hold. */
function desiredCatalog(): Desired[] {
  return stripeCatalog().map((raw) => {
    const entry = CatalogEntry.parse(raw);
    const kind = entry.metadata.kind;
    const key = (typeof kind === 'string' ? kind : `${entry.metadata.plan_id}_${entry.metadata.billing_interval}`) as CatalogKey;
    if (!(key in PRICE_ENV)) throw new Error(`catalog entry '${key}' has no price variable in PRICE_ENV`);
    const productId = `provenant_${typeof kind === 'string' ? kind : String(entry.metadata.plan_id)}`;
    // Stripe metadata is strings only; nulls mean "not set" and are dropped.
    const metadata: Metadata = { provenant_key: key };
    for (const [k, v] of Object.entries(entry.metadata)) if (v !== null) metadata[k] = String(v);
    return {
      key,
      lookupKey: `provenant_${key}`,
      productId,
      product: {
        name: entry.product.name,
        ...(entry.product.description ? { description: entry.product.description } : {}),
        metadata: { provenant_key: productId },
      },
      price: entry.price,
      ...(entry.meter ? { meter: entry.meter } : {}),
      metadata,
    };
  });
}

export interface SyncStep {
  op: 'create' | 'update' | 'replace' | 'unchanged';
  object: 'meter' | 'product' | 'price';
  key: string;
  detail: string;
  /** For price steps: the price as pricing.ts defines it. */
  price?: { unit_amount: number; currency: string; recurring: { interval: Interval; usage_type: UsageType } | null };
}

export interface SyncResult {
  mode: BillingMode;
  dry_run: boolean;
  steps: SyncStep[];
  summary: Record<SyncStep['op'], number>;
  /** Which price id goes in which variable. Null in a dry run when the price
   *  does not exist yet or is about to be replaced. */
  prices: Array<{ key: CatalogKey; env_var: string; lookup_key: string; price_id: string | null }>;
}

const productIdOf = (p: PriceRecord) => (typeof p.product === 'string' ? p.product : p.product.id);

function priceMatches(existing: PriceRecord, want: Desired, meterId: string | null): boolean {
  const r = want.price.recurring;
  if (productIdOf(existing) !== want.productId) return false;
  if (existing.unit_amount !== want.price.unit_amount || existing.currency !== want.price.currency) return false;
  if (!r) return existing.recurring === null;
  if (!existing.recurring || existing.recurring.interval !== r.interval) return false;
  if (existing.recurring.usage_type !== (r.usage_type ?? 'licensed')) return false;
  if (r.usage_type === 'metered' && (meterId === null || existing.recurring.meter !== meterId)) return false;
  return true;
}

function describePrice(p: PriceShape): string {
  const amount = `${(p.unit_amount / 100).toFixed(2)} ${p.currency.toUpperCase()}`;
  if (!p.recurring) return `${amount} one-time`;
  return `${amount}/${p.recurring.interval}${p.recurring.usage_type === 'metered' ? ' per metered event' : ''}`;
}

/** Stripe errors that a later retry could fix. */
const TRANSIENT = new Set(['StripeConnectionError', 'StripeRateLimitError', 'StripeAPIError']);

export async function syncCatalog(
  client: CatalogClient,
  opts: { mode: BillingMode; apply: boolean; redact?: (text: string) => string },
): Promise<SyncResult> {
  const clean = (t: string) => redactSecretShapes(opts.redact ? opts.redact(t) : t);
  try {
    return await plan(client, opts.mode, opts.apply);
  } catch (err) {
    if (err instanceof LacreError) throw err;
    const type = (err as { type?: unknown }).type;
    throw new LacreError({
      code: 'INVALID_INPUT',
      message: `A Stripe call failed during billing.sync: ${clean(err instanceof Error ? err.message : String(err))}`,
      retryable: typeof type === 'string' && TRANSIENT.has(type),
      fix: {
        action: 'billing.sync',
        arguments: { mode: opts.mode },
        note:
          'Steps before the failure may have been applied. Re-running is safe: the sync is idempotent and ' +
          'only does what is still missing. Run it with --dry-run first to see what remains.',
      },
    });
  }
}

async function plan(client: CatalogClient, mode: BillingMode, apply: boolean): Promise<SyncResult> {
  const desired = desiredCatalog();
  const steps: SyncStep[] = [];

  // Meters first: a metered price must name one.
  const meterIds = new Map<string, string | null>();
  const wantedMeters = [...new Map(desired.flatMap((d) => (d.meter ? [[d.meter.event_name, d.meter] as const] : []))).values()];
  if (wantedMeters.length) {
    const active = (await client.billing.meters.list({ status: 'active', limit: 100 })).data;
    for (const m of wantedMeters) {
      const found = active.find((a) => a.event_name === m.event_name);
      if (found) {
        meterIds.set(m.event_name, found.id);
        steps.push({ op: 'unchanged', object: 'meter', key: m.event_name, detail: `meter ${m.event_name} exists` });
        continue;
      }
      steps.push({ op: 'create', object: 'meter', key: m.event_name, detail: `create meter ${m.event_name} (count of events)` });
      meterIds.set(
        m.event_name,
        apply
          ? (await client.billing.meters.create({
              display_name: m.display_name,
              event_name: m.event_name,
              default_aggregation: { formula: 'count' },
              customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
            })).id
          : null,
      );
    }
  }

  // Products, once each: Cloud monthly and annual share one.
  const products = [...new Map(desired.map((d) => [d.productId, d.product] as const))];
  const existingProducts = (await client.products.list({ ids: products.map(([id]) => id), limit: 100 })).data;
  for (const [id, want] of products) {
    const found = existingProducts.find((p) => p.id === id);
    if (!found) {
      steps.push({ op: 'create', object: 'product', key: id, detail: `create product "${want.name}"` });
      if (apply) await client.products.create({ id, ...want });
      continue;
    }
    const drifted =
      found.name !== want.name ||
      (found.description ?? undefined) !== want.description ||
      Object.entries(want.metadata).some(([k, v]) => found.metadata[k] !== v);
    if (drifted) {
      steps.push({ op: 'update', object: 'product', key: id, detail: `update product "${want.name}" to match pricing.ts` });
      if (apply) await client.products.update(id, want);
    } else {
      steps.push({ op: 'unchanged', object: 'product', key: id, detail: `product "${want.name}" matches` });
    }
  }

  // Prices, by lookup key.
  const existingPrices = (await client.prices.list({
    lookup_keys: desired.map((d) => d.lookupKey), active: true, limit: 100,
  })).data;
  const prices: SyncResult['prices'] = [];
  for (const d of desired) {
    const meterId = d.meter ? meterIds.get(d.meter.event_name) ?? null : null;
    const found = existingPrices.find((p) => p.lookup_key === d.lookupKey);
    const shape: SyncStep['price'] = {
      unit_amount: d.price.unit_amount,
      currency: d.price.currency,
      recurring: d.price.recurring
        ? { interval: d.price.recurring.interval, usage_type: d.price.recurring.usage_type ?? 'licensed' }
        : null,
    };
    const entry = { key: d.key, env_var: PRICE_ENV[d.key], lookup_key: d.lookupKey };

    if (found && priceMatches(found, d, meterId)) {
      steps.push({ op: 'unchanged', object: 'price', key: d.lookupKey, detail: `${describePrice(d.price)} matches`, price: shape });
      prices.push({ ...entry, price_id: found.id });
      continue;
    }

    steps.push({
      op: found ? 'replace' : 'create',
      object: 'price',
      key: d.lookupKey,
      detail: found
        ? `replace with ${describePrice(d.price)}; the old price is archived and keeps billing existing subscriptions`
        : `create ${describePrice(d.price)}`,
      price: shape,
    });
    if (!apply) {
      prices.push({ ...entry, price_id: null });
      continue;
    }
    const created = await client.prices.create({
      product: d.productId,
      unit_amount: d.price.unit_amount,
      currency: d.price.currency,
      lookup_key: d.lookupKey,
      ...(found ? { transfer_lookup_key: true } : {}),
      metadata: d.metadata,
      ...(d.price.recurring
        ? {
            recurring: {
              interval: d.price.recurring.interval,
              usage_type: d.price.recurring.usage_type ?? 'licensed',
              ...(d.price.recurring.usage_type === 'metered' && meterId ? { meter: meterId } : {}),
            },
          }
        : {}),
    });
    if (found) await client.prices.update(found.id, { active: false });
    prices.push({ ...entry, price_id: created.id });
  }

  const summary = { create: 0, update: 0, replace: 0, unchanged: 0 };
  for (const s of steps) summary[s.op] += 1;
  return { mode, dry_run: !apply, steps, summary, prices };
}

const StepOut = z.object({
  op: z.enum(['create', 'update', 'replace', 'unchanged']),
  object: z.enum(['meter', 'product', 'price']),
  key: z.string(),
  detail: z.string(),
  price: z.object({
    unit_amount: z.number(),
    currency: z.string(),
    recurring: z.object({ interval: z.enum(['month', 'year']), usage_type: z.enum(['licensed', 'metered']) }).nullable(),
  }).optional(),
});

/** Loads config, checks the requested mode against it, and runs the sync. */
async function run(mode: BillingMode, apply: boolean): Promise<SyncResult> {
  const config = loadBillingConfig(process.env, ['stripe']);
  if (mode !== config.mode) {
    throw new LacreError({
      code: 'INVALID_INPUT',
      message:
        `billing.sync was asked for ${mode} mode but LACRE_BILLING_MODE is ${config.mode}. ` +
        `Nothing was executed.`,
      retryable: false,
      fix: mode === 'live'
        ? {
            note:
              'Live mode is for the owner, after the manual test-mode check: set LACRE_BILLING_MODE=live ' +
              'and a live key in your own shell, then re-run with --mode live.',
          }
        : { action: 'billing.sync', arguments: { mode: config.mode }, note: `Re-run with --mode ${config.mode}, or change LACRE_BILLING_MODE.` },
    });
  }
  return syncCatalog(createStripeClient(config), { mode, apply, redact: config.redact });
}

export const billingSyncAction = defineAction({
  name: 'billing.sync',
  summary: 'Create or update the Stripe products, prices and meter from pricing.ts',
  sideEffect: 'write',
  description: {
    what: 'Makes the Stripe account match pricing.ts: the Cloud monthly and annual prices, the extra-identity price, the pay-as-you-go bundle and the metered overage bundle, plus the meter the overage counts on. Idempotent; a second run changes nothing.',
    when: 'Once per Stripe account when setting up billing, test mode first, and again whenever pricing.ts changes. Run with --dry-run first to see exactly what it would create.',
    whenNot: 'Not for checking prices in code: read pricing.ts or call stripeCatalog() instead. Not for live mode until the owner has done the manual test-mode check; use --mode test until then.',
    cost: 'A few Stripe API reads over the network, plus one write per object that is missing or drifted. No money moves: it creates catalog objects, never charges.',
    returns: 'Every step (create, update, replace or unchanged) per meter, product and price, a count of each, and the price id that belongs in each STRIPE_PRICE_* variable.',
  },
  input: z.object({
    mode: z.enum(['test', 'live']).default('test')
      .describe('Which Stripe mode to sync. Must match LACRE_BILLING_MODE (default test). Live is for the owner only.'),
  }),
  output: z.object({
    mode: z.enum(['test', 'live']),
    dry_run: z.boolean(),
    steps: z.array(StepOut),
    summary: z.object({ create: z.number(), update: z.number(), replace: z.number(), unchanged: z.number() }),
    prices: z.array(z.object({
      key: z.string(), env_var: z.string(), lookup_key: z.string(), price_id: z.string().nullable(),
    })),
  }),
  handler: (input) => run(input.mode, true),
  dryRun: (input) => run(input.mode, false),
  nextActions(input, output): NextAction[] {
    if (output.dry_run && output.summary.create + output.summary.update + output.summary.replace > 0) {
      return [{ action: 'billing.sync', arguments: { mode: input.mode }, why: 'Apply the plan above.' }];
    }
    return [];
  },
  examples: [
    { description: 'Preview the test-mode catalog', arguments: { mode: 'test' } },
  ],
});

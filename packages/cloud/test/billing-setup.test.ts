import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { inspect } from 'node:util';
import { runCli, getAction, ProvenantError } from '@lacre/core';
import { loadBillingConfig, redact, PRICE_ENV } from '../src/billing/config.js';
import { syncCatalog, type CatalogClient, type SyncResult } from '../src/billing/sync.js';
import { stripeCatalog, OVERAGE_METER_EVENT } from '../src/billing/stripe.js';
import '../src/register.js';

/*
 * Secret-shaped values are assembled at runtime so this file never contains
 * one: the repo-wide secret search at the bottom must find nothing, here
 * included.
 */
const u = (...parts: string[]) => parts.join('_');
const TEST_KEY = u('sk', 'test', 'x'.repeat(24));
const LIVE_KEY = u('sk', 'live', 'y'.repeat(24));
const LIVE_RESTRICTED_KEY = u('rk', 'live', 'z'.repeat(24));
const WEBHOOK_SECRET = u('whsec', 'w'.repeat(24));
const DB_USER = 'neondb_owner';
const DB_PASSWORD = 'npg' + 'Q7r2'.repeat(4);
const DB_HOST = 'ep-quiet-lake-a1b2c3d4.us-east-2.aws.neon.tech';
const DATABASE_URL = `postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}/neondb?sslmode=require`;
const SECRETS = [TEST_KEY, LIVE_KEY, LIVE_RESTRICTED_KEY, WEBHOOK_SECRET, DATABASE_URL, DB_PASSWORD, DB_USER, DB_HOST];

function expectNoSecrets(text: string) {
  for (const s of SECRETS) expect(text, 'a secret value leaked').not.toContain(s);
}

/** Runs `fn` and returns its thrown error. Fails the test if it does not throw. */
function thrown(fn: () => unknown): ProvenantError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProvenantError);
    return err as ProvenantError;
  }
  throw new Error('expected a throw');
}

/** Everything a caller could print from an error. */
function surface(err: ProvenantError): string {
  return [err.message, JSON.stringify(err.toJSON()), inspect(err)].join('\n');
}

let store: string;
beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), 'provenant-billing-'));
  for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'DATABASE_URL', 'PROVENANT_BILLING_MODE']) {
    vi.stubEnv(name, '');
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(store, { recursive: true, force: true });
});

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runCli([...argv, '--json', '--store', store], {
    out: (t) => (out += t + '\n'),
    err: (t) => (err += t + '\n'),
  });
  return { code, out, err };
}

describe('billing config: environment only, validated, never echoed', () => {
  it('fails on a missing STRIPE_SECRET_KEY, names it and prints no value', () => {
    const err = thrown(() => loadBillingConfig({ DATABASE_URL }, ['stripe', 'database']));
    expect(err.message).toMatch(/STRIPE_SECRET_KEY/);
    expect(err.retryable).toBe(false);
    expectNoSecrets(surface(err));
  });

  it('fails on a missing DATABASE_URL, names it and prints no value', () => {
    const err = thrown(() => loadBillingConfig({ STRIPE_SECRET_KEY: TEST_KEY }, ['stripe', 'database']));
    expect(err.message).toMatch(/DATABASE_URL/);
    expectNoSecrets(surface(err));
  });

  it('treats an empty variable as missing', () => {
    const err = thrown(() => loadBillingConfig({ STRIPE_SECRET_KEY: '' }, ['stripe']));
    expect(err.message).toMatch(/STRIPE_SECRET_KEY/);
  });

  it('rejects malformed values without echoing them', () => {
    const err = thrown(() =>
      loadBillingConfig(
        { STRIPE_SECRET_KEY: 'not-a-key-' + DB_PASSWORD, DATABASE_URL: 'mysql://' + DB_PASSWORD + '@' + DB_HOST },
        ['stripe', 'database'],
      ),
    );
    expect(err.message).toMatch(/STRIPE_SECRET_KEY/);
    expect(err.message).toMatch(/DATABASE_URL/);
    expectNoSecrets(surface(err));
  });

  it('only requires what the caller needs', () => {
    const cfg = loadBillingConfig({ STRIPE_SECRET_KEY: TEST_KEY }, ['stripe']);
    expect(cfg.mode).toBe('test');
    expect(cfg.databaseUrl).toBeUndefined();
  });

  it('reads every price id from its named variable', () => {
    const env: Record<string, string> = { STRIPE_SECRET_KEY: TEST_KEY };
    for (const [key, name] of Object.entries(PRICE_ENV)) env[name] = u('price', 'test' + key.replace(/_/g, ''));
    const cfg = loadBillingConfig(env, ['stripe', 'prices']);
    expect(cfg.prices.cloud_month).toBe(u('price', 'testcloudmonth'));
    expect(cfg.prices.overage_bundle).toBe(u('price', 'testoveragebundle'));

    delete env[PRICE_ENV.overage_bundle];
    expect(thrown(() => loadBillingConfig(env, ['stripe', 'prices'])).message).toMatch(/STRIPE_PRICE_BUNDLE_OVERAGE/);
  });

  it('never prints a secret when the config object itself is logged', () => {
    const cfg = loadBillingConfig(
      { STRIPE_SECRET_KEY: TEST_KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, DATABASE_URL },
      ['stripe', 'webhook', 'database'],
    );
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 5 }))).join(' '));
    });
    try {
      console.log(cfg);
      console.log('%o', cfg);
      console.log(JSON.stringify(cfg));
      console.log(String(cfg));
    } finally {
      spy.mockRestore();
    }
    expect(logged.join('\n')).toMatch(/redacted/);
    expectNoSecrets(logged.join('\n'));
    // The values are still there for the code that needs them.
    expect(cfg.stripeSecretKey).toBe(TEST_KEY);
    expect(cfg.databaseUrl).toBe(DATABASE_URL);
  });

  it('redacts keys, webhook secrets and every part of DATABASE_URL from arbitrary text', () => {
    const cfg = loadBillingConfig(
      { STRIPE_SECRET_KEY: TEST_KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, DATABASE_URL },
      ['stripe', 'webhook', 'database'],
    );
    const leaky =
      `connect failed for ${DATABASE_URL}; user ${DB_USER} host ${DB_HOST} password ${DB_PASSWORD}; ` +
      `key ${TEST_KEY}, webhook ${WEBHOOK_SECRET}, and a stray ${LIVE_RESTRICTED_KEY}`;
    const clean = cfg.redact(leaky);
    expectNoSecrets(clean);
    expect(clean).toMatch(/connect failed/);
    // The pattern pass works even without a config in hand.
    expectNoSecrets(redact(`key ${LIVE_KEY} url ${DATABASE_URL}`));
  });
});

describe('test mode comes first', () => {
  for (const [label, key] of [['sk live', LIVE_KEY], ['rk live', LIVE_RESTRICTED_KEY]] as const) {
    it(`refuses a ${label} key unless PROVENANT_BILLING_MODE=live`, () => {
      const err = thrown(() => loadBillingConfig({ STRIPE_SECRET_KEY: key }, ['stripe']));
      expect(err.message).toMatch(/PROVENANT_BILLING_MODE/);
      expectNoSecrets(surface(err));

      const live = loadBillingConfig({ STRIPE_SECRET_KEY: key, PROVENANT_BILLING_MODE: 'live' }, ['stripe']);
      expect(live.mode).toBe('live');
    });
  }

  it('refuses live mode with a test key, so a "live" sync can never quietly hit test data', () => {
    const err = thrown(() => loadBillingConfig({ STRIPE_SECRET_KEY: TEST_KEY, PROVENANT_BILLING_MODE: 'live' }, ['stripe']));
    expect(err.message).toMatch(/PROVENANT_BILLING_MODE/);
  });

  it('rejects an unknown PROVENANT_BILLING_MODE', () => {
    const err = thrown(() => loadBillingConfig({ STRIPE_SECRET_KEY: TEST_KEY, PROVENANT_BILLING_MODE: 'prod' }, ['stripe']));
    expect(err.message).toMatch(/PROVENANT_BILLING_MODE/);
  });

  it('the sync command refuses a live key with no live mode set, and exits non-zero', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', LIVE_KEY);
    const r = await cli(['billing', 'sync', '--dry-run']);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/PROVENANT_BILLING_MODE/);
    expectNoSecrets(r.out + r.err);
  });

  it('the sync command refuses --mode live while the environment is in test mode', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', TEST_KEY);
    const r = await cli(['billing', 'sync', '--mode', 'live', '--dry-run']);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/PROVENANT_BILLING_MODE/);
    expectNoSecrets(r.out + r.err);
  });

  it('the sync command exits non-zero on a missing key, naming the variable', async () => {
    const r = await cli(['billing', 'sync', '--dry-run']);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/STRIPE_SECRET_KEY/);
  });

  it('is registered as a write action with a dry run', () => {
    const action = getAction('billing.sync');
    expect(action?.sideEffect).toBe('write');
    expect(action?.dryRun).toBeTypeOf('function');
  });
});

/** In-memory stand-in for the slice of Stripe the sync uses. No network. */
function fakeStripe() {
  let n = 0;
  const id = (prefix: string) => `fake-${prefix}-${++n}`;
  const products = new Map<string, { id: string; name: string; description: string | null; metadata: Record<string, string> }>();
  const prices: Array<{
    id: string; product: string; active: boolean; unit_amount: number | null; currency: string;
    lookup_key: string | null; metadata: Record<string, string>;
    recurring: { interval: string; usage_type: string; meter: string | null } | null;
  }> = [];
  const meters: Array<{ id: string; event_name: string; display_name: string; status: string }> = [];
  const writes: string[] = [];

  const client: CatalogClient = {
    products: {
      async list(p) {
        return { data: [...products.values()].filter((x) => p.ids.includes(x.id)) };
      },
      async create(p) {
        writes.push(`product.create ${p.id}`);
        const product = { id: p.id, name: p.name, description: p.description ?? null, metadata: { ...p.metadata } };
        products.set(p.id, product);
        return product;
      },
      async update(productId, p) {
        writes.push(`product.update ${productId}`);
        const product = products.get(productId)!;
        Object.assign(product, { ...p, metadata: { ...product.metadata, ...p.metadata } });
        return product;
      },
    },
    prices: {
      async list(p) {
        return { data: prices.filter((x) => x.active && x.lookup_key !== null && p.lookup_keys.includes(x.lookup_key)) };
      },
      async create(p) {
        writes.push(`price.create ${p.lookup_key}`);
        if (p.transfer_lookup_key) for (const x of prices) if (x.lookup_key === p.lookup_key) x.lookup_key = null;
        const price = {
          id: id('price'), product: p.product, active: true, unit_amount: p.unit_amount, currency: p.currency,
          lookup_key: p.lookup_key, metadata: { ...p.metadata },
          recurring: p.recurring
            ? { interval: p.recurring.interval, usage_type: p.recurring.usage_type ?? 'licensed', meter: p.recurring.meter ?? null }
            : null,
        };
        prices.push(price);
        return price;
      },
      async update(priceId, p) {
        writes.push(`price.update ${priceId}`);
        const price = prices.find((x) => x.id === priceId)!;
        price.active = p.active;
        return price;
      },
    },
    billing: {
      meters: {
        async list() {
          return { data: meters.filter((m) => m.status === 'active') };
        },
        async create(p) {
          writes.push(`meter.create ${p.event_name}`);
          const meter = { id: id('meter'), event_name: p.event_name, display_name: p.display_name, status: 'active' };
          meters.push(meter);
          return meter;
        },
      },
    },
  };
  return { client, products, prices, meters, writes };
}

const steps = (r: SyncResult, object: string, ops: string[]) =>
  r.steps.filter((s) => s.object === object && ops.includes(s.op));

describe('catalog sync', () => {
  it('generates the overage bundle as a metered monthly price on a meter', () => {
    const overage = stripeCatalog().find((c) => (c.metadata as { kind?: string }).kind === 'overage_bundle')!;
    expect(overage.price).toMatchObject({ unit_amount: 1000, recurring: { interval: 'month', usage_type: 'metered' } });
    expect(overage.meter).toMatchObject({ event_name: OVERAGE_METER_EVENT });
  });

  it('a dry run in test mode plans exactly the 5 catalog prices and writes nothing', async () => {
    const fake = fakeStripe();
    const plan = await syncCatalog(fake.client, { mode: 'test', apply: false });

    expect(plan.dry_run).toBe(true);
    expect(fake.writes).toEqual([]);

    const created = steps(plan, 'price', ['create']).map((s) => s.price!);
    expect(created).toHaveLength(5);
    const shape = created
      .map((p) => `${p.unit_amount}/${p.recurring ? `${p.recurring.interval}:${p.recurring.usage_type}` : 'one-time'}`)
      .sort();
    expect(shape).toEqual(['1000/month:metered', '1500/one-time', '400/month:licensed', '4900/month:licensed', '49000/year:licensed']);

    expect(steps(plan, 'meter', ['create'])).toHaveLength(1);
    expect(steps(plan, 'product', ['create'])).toHaveLength(4);
    expect(plan.prices.map((p) => p.env_var).sort()).toEqual(Object.values(PRICE_ENV).sort());
    expect(plan.prices.every((p) => p.price_id === null)).toBe(true);
  });

  it('applies the plan, then a second run creates nothing', async () => {
    const fake = fakeStripe();
    const first = await syncCatalog(fake.client, { mode: 'test', apply: true });
    expect(first.dry_run).toBe(false);
    expect(fake.prices).toHaveLength(5);
    expect(fake.meters).toHaveLength(1);
    expect(first.prices.every((p) => typeof p.price_id === 'string')).toBe(true);

    const metered = fake.prices.find((p) => p.recurring?.usage_type === 'metered')!;
    expect(metered.recurring!.meter).toBe(fake.meters[0]!.id);

    fake.writes.length = 0;
    const again = await syncCatalog(fake.client, { mode: 'test', apply: true });
    expect(fake.writes).toEqual([]);
    expect(again.steps.every((s) => s.op === 'unchanged')).toBe(true);
    expect(again.prices.map((p) => p.price_id)).toEqual(first.prices.map((p) => p.price_id));

    const dry = await syncCatalog(fake.client, { mode: 'test', apply: false });
    expect(dry.steps.every((s) => s.op === 'unchanged')).toBe(true);
  });

  it('replaces a price whose amount drifted, moving the lookup key and archiving the old one', async () => {
    const fake = fakeStripe();
    await syncCatalog(fake.client, { mode: 'test', apply: true });
    const payg = fake.prices.find((p) => p.lookup_key === 'provenant_payg_bundle')!;
    payg.unit_amount = 999;

    const r = await syncCatalog(fake.client, { mode: 'test', apply: true });
    expect(steps(r, 'price', ['replace'])).toHaveLength(1);
    expect(payg.active).toBe(false);
    const current = fake.prices.find((p) => p.lookup_key === 'provenant_payg_bundle')!;
    expect(current.unit_amount).toBe(1500);
    expect(current.id).not.toBe(payg.id);
  });

  it('redacts secrets from a Stripe failure and says a re-run is safe', async () => {
    const fake = fakeStripe();
    fake.client.products.list = async () => {
      throw Object.assign(new Error(`Invalid API Key provided: ${TEST_KEY} (db ${DATABASE_URL})`), { type: 'StripeAuthenticationError' });
    };
    const cfg = loadBillingConfig({ STRIPE_SECRET_KEY: TEST_KEY, DATABASE_URL }, ['stripe', 'database']);
    let err: unknown;
    try {
      await syncCatalog(fake.client, { mode: 'test', apply: true, redact: cfg.redact });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProvenantError);
    expectNoSecrets(surface(err as ProvenantError));
    expect((err as ProvenantError).fix?.note).toMatch(/idempotent/);
  });
});

describe('no secret ever lands in the repo', () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));

  it('finds no live key, test key, webhook secret or price id in any tracked file', () => {
    const patterns = [
      new RegExp(u('sk', 'live', '')),
      new RegExp(u('rk', 'live', '')),
      new RegExp(u('sk', 'test', '') + '[A-Za-z0-9]{10,}'),
      new RegExp(u('whsec', '') + '[A-Za-z0-9]{10,}'),
      new RegExp(u('price', '') + '[A-Za-z0-9]{8,}'),
    ];
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    const hits: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(join(root, f), 'utf8');
      } catch {
        continue; // deleted in the working tree
      }
      for (const p of patterns) if (p.test(text)) hits.push(`${f}: ${p.source}`);
    }
    expect(hits).toEqual([]);
  });

  it('keeps .env and .env.local ignored', () => {
    const out = execFileSync('git', ['check-ignore', '.env', '.env.local'], { cwd: root, encoding: 'utf8' });
    expect(out.trim().split('\n').sort()).toEqual(['.env', '.env.local']);
  });
});

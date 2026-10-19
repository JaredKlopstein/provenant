/**
 * Overage bundles: every evidence bundle a Cloud subscriber exports beyond the
 * month's allowance (pricing.ts, includedBundlesPerMonth) is reported to Stripe
 * as one meter event on the metered overage price.
 *
 *  - The database counts. Each export by a Cloud subscriber is recorded in
 *    billing_bundle_exports under its UTC calendar month, so the allowance
 *    resets with the month and never rolls over. Only the exports beyond it
 *    get a billing_usage_reports row, one per (subscription, bundle).
 *
 *  - Each meter event's identifier is the bundle id, on the first send and on
 *    every retry. Stripe dedupes an identifier for 24 hours only, so the row is
 *    the lasting guard: it is marked reported once Stripe accepts the event, and
 *    a reported row is never sent again.
 *
 *  - Unreported rows are retried at the start of every bundle export, and by
 *    retryPendingOverage, which a cron tick can call the way it calls
 *    runAnchorTick.
 *
 *  - Stripe requires every price on a subscription to share one interval. A
 *    monthly subscriber's overage bills on their own subscription. An annual
 *    subscriber gets a separate monthly subscription holding only the metered
 *    overage price, created on their first bundle beyond the allowance with the
 *    payment method saved at annual checkout, and reused after that. The annual
 *    subscription is only ever read, never updated.
 *
 *  - Billing never blocks an export. A Stripe failure, or a database without
 *    0001_overage.sql, is logged redacted and the export goes ahead; the row, if
 *    there is one, stays unreported for the next retry.
 *
 * Free and pay-as-you-go users have no Cloud subscription and are never
 * reported here: they buy bundles through checkout.
 *
 * The Stripe key, the overage price id and the meter event name come from the
 * environment through config.ts, and nowhere else. Nothing is reported until a
 * deployment installs a reporter with installOverageReporter.
 */
import {
  and, asc, desc, eq, sha256Hex, deriveAgentId,
  type ActionContext,
} from '@provenant/core';
import type { Bundle } from '@provenant/verifier';
import { PLANS, type PlanId } from '../pricing.js';
import { bundleToJson } from '../bundle/export.js';
import { loadBillingConfig, createStripeClient, redact, type BillingConfig, type BillingMode } from './config.js';
import {
  billingSchema, billingCustomers, billingSubscriptions, billingBundleExports, billingUsageReports,
  billingOverageSubscriptions,
} from './schema.js';
import type { BillingDb } from './store.js';

type Ref = string | { id: string } | null | undefined;

export interface MeterEventParams {
  event_name: string;
  identifier: string;
  /** Unix seconds: when the bundle was exported, so it bills in that month. */
  timestamp: number;
  payload: { stripe_customer_id: string; value: string };
}

export interface StripeRequestOptions {
  idempotencyKey?: string;
}

/** The slice of Stripe overage reporting uses: meter events, and creating the
 *  annual customer's overage subscription (which reads the payment method they
 *  saved at checkout). Injected; tests pass a fake. */
export interface OverageStripe {
  billing: {
    meterEvents: {
      create(params: MeterEventParams, options?: StripeRequestOptions): Promise<unknown>;
    };
  };
  subscriptions: {
    create(params: Record<string, unknown>, options?: StripeRequestOptions): Promise<{ id: string }>;
    retrieve(id: string): Promise<{ id: string; default_payment_method?: Ref }>;
  };
  customers: {
    retrieve(id: string): Promise<{ invoice_settings?: { default_payment_method?: Ref } | null }>;
  };
}

export interface OverageReporterOptions {
  /** Defaults to process.env. Read once. Needs STRIPE_SECRET_KEY, the
   *  STRIPE_PRICE_* ids, STRIPE_METER_EVENT_NAME and, unless `db` is given,
   *  DATABASE_URL. A live key is refused unless PROVENANT_BILLING_MODE=live. */
  env?: Record<string, string | undefined>;
  /** Defaults to a real Stripe client for the loaded config. */
  stripe?: OverageStripe;
  /** Defaults to the Neon serverless driver over DATABASE_URL, opened on first use. */
  db?: BillingDb;
  /** Injected clock. Defaults to the system clock. */
  now?: () => Date;
  /** Receives each line already redacted. Defaults to console.error. */
  log?: (line: string) => void;
  /** The Provenant account an export bills to: the account id checkout links
   *  to the Stripe customer. Defaults to the exporting agent's id. */
  account?: (ctx: ActionContext) => string | null;
  /** Most rows one retry pass sends. Defaults to 100. */
  retryLimit?: number;
}

export type OverageOutcome =
  /** No Cloud subscription: free or pay-as-you-go. Nothing recorded. */
  | { status: 'not_subscribed' }
  /** Within the month's allowance. Counted, not billed. */
  | { status: 'included'; month: string; count: number; included: number }
  /** This bundle was already recorded for this subscription. */
  | { status: 'duplicate' }
  /** Beyond the allowance, and Stripe accepted the meter event. */
  | { status: 'reported'; month: string; count: number; subscription: string }
  /** Beyond the allowance, and the event did not go through. The row is kept
   *  and retried. */
  | { status: 'unreported'; month: string; count: number; error: string }
  /** Counting itself failed, for example before 0001_overage.sql is applied. */
  | { status: 'failed'; error: string };

export type OverageRetryResult =
  | { status: 'idle'; reported: 0; failed: 0; errors: [] }
  | { status: 'done'; reported: number; failed: number; errors: string[] }
  | { status: 'failed'; reported: 0; failed: 0; errors: string[] };

export interface OverageReporter {
  mode: BillingMode;
  /** Records one export for the account, and reports it if it is beyond the
   *  month's allowance. Never throws. */
  recordExport(e: { accountId: string; bundleId: string }): Promise<OverageOutcome>;
  /** Sends every unreported row, oldest first. Never throws. */
  retryPending(): Promise<OverageRetryResult>;
  /** The account an export in this action context bills to. May throw. */
  accountOf(ctx: ActionContext): string | null;
  /** Logs one line, redacted. */
  log(line: string): void;
}

/** Subscription statuses that still hold the plan, and so its allowance. */
const ACTIVE = new Set(['active', 'trialing', 'past_due']);
const REDACTED = '[redacted]';
const STRIPE_ID = /\b(cus|sub|si|cs|pi|in|il|ii|ch|evt|price|prod|pm|seti|src|card|mtr)_[A-Za-z0-9]+/g;
const ACCOUNT_ID = /\burn:provenant:agent:[A-Za-z0-9_-]+/g;

/**
 * Loads the config and builds a reporter. Throws, naming the variables and no
 * values, when any is missing or malformed, or when a live key is set without
 * PROVENANT_BILLING_MODE=live.
 */
export function createOverageReporter(opts: OverageReporterOptions = {}): OverageReporter {
  const config = loadBillingConfig(opts.env ?? process.env, [
    'stripe', 'prices', 'meter', ...(opts.db ? [] : ['database' as const]),
  ]);
  const stripe = opts.stripe ?? (createStripeClient(config) as unknown as OverageStripe);
  const now = opts.now ?? (() => new Date());
  const sink = opts.log ?? ((line: string) => console.error(line));
  const log = (line: string) => sink(scrub(config, line));
  const account = opts.account ?? ((ctx: ActionContext) => deriveAgentId(ctx.identity().publicKey));
  const retryLimit = opts.retryLimit ?? 100;

  let db: Promise<BillingDb> | null = opts.db ? Promise.resolve(opts.db) : null;
  const database = (): Promise<BillingDb> => {
    db ??= connectNeon(config.databaseUrl!, log).catch((err: unknown) => {
      db = null; // try again next time
      throw err;
    });
    return db;
  };

  const r = new Reporter(config, stripe, database, now, log);
  return {
    mode: config.mode,
    recordExport: (e) => r.recordExport(e),
    retryPending: () => r.retryPending(retryLimit),
    accountOf: account,
    log,
  };
}

let installed: OverageReporter | null = null;

/** Turns overage reporting on for bundle exports in this process, or off with
 *  null. Off by default, so self-hosted and local exports never touch Stripe. */
export function installOverageReporter(reporter: OverageReporter | null): void {
  installed = reporter;
}

/**
 * Sends every unreported overage row. Stateless, so a cron tick can call it
 * with its own reporter; the bundle export calls it with the installed one.
 * Returns null when there is no reporter. Never throws.
 */
export async function retryPendingOverage(
  reporter: OverageReporter | null = installed,
): Promise<OverageRetryResult | null> {
  return reporter ? reporter.retryPending() : null;
}

/**
 * The bundle export's hook: counts this export against the exporting account
 * and reports it if it is beyond the allowance. Returns null when there is no
 * reporter. Never throws.
 */
export async function recordBundleOverage(
  ctx: ActionContext,
  bundle: Bundle,
  reporter: OverageReporter | null = installed,
): Promise<OverageOutcome | null> {
  if (!reporter) return null;
  let accountId: string | null;
  try {
    accountId = reporter.accountOf(ctx);
  } catch (err) {
    reporter.log(`billing overage: the exporting account could not be determined: ${describe(err)}. The export went ahead and was not counted.`);
    return { status: 'failed', error: 'the exporting account could not be determined' };
  }
  if (!accountId) return { status: 'not_subscribed' };
  return reporter.recordExport({ accountId, bundleId: bundleIdOf(bundle) });
}

/** A bundle's id: the SHA-256 of its JSON, exactly as `bundle export --out`
 *  writes it, so a customer can match a charge to the file they hold. */
export function bundleIdOf(bundle: Bundle): string {
  return `bundle_${sha256Hex(new TextEncoder().encode(bundleToJson(bundle)))}`;
}

interface CloudSubscription {
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  plan: PlanId;
  interval: string;
}

interface ReportRow {
  id: number;
  stripeSubscriptionId: string;
  bundleId: string;
  exportedAt: Date;
}

class Reporter {
  constructor(
    private readonly config: BillingConfig,
    private readonly stripe: OverageStripe,
    private readonly database: () => Promise<BillingDb>,
    private readonly now: () => Date,
    private readonly log: (line: string) => void,
  ) {}

  async recordExport(e: { accountId: string; bundleId: string }): Promise<OverageOutcome> {
    let counted: { sub: CloudSubscription; month: string; count: number; included: number } | 'not_subscribed' | 'duplicate';
    try {
      counted = await this.count(e);
    } catch (err) {
      this.log(`billing overage: counting the export failed: ${describe(err)}. The export went ahead and nothing was reported.`);
      return { status: 'failed', error: scrub(this.config, describe(err)) };
    }
    if (counted === 'not_subscribed' || counted === 'duplicate') return { status: counted };

    const { sub, month, count, included } = counted;
    if (count <= included) return { status: 'included', month, count, included };
    try {
      const db = await this.database();
      const [row] = await db
        .select({
          id: billingUsageReports.id,
          stripeSubscriptionId: billingUsageReports.stripeSubscriptionId,
          bundleId: billingUsageReports.bundleId,
          exportedAt: billingUsageReports.exportedAt,
        })
        .from(billingUsageReports)
        .where(and(
          eq(billingUsageReports.stripeSubscriptionId, sub.stripeSubscriptionId),
          eq(billingUsageReports.bundleId, e.bundleId),
        ));
      if (!row) throw new Error('usage report row vanished after it was written');
      return { status: 'reported', month, count, subscription: await this.report(row) };
    } catch (err) {
      this.log(`billing overage: reporting an overage bundle failed: ${describe(err)}. The export went ahead; the bundle stays unreported and is retried.`);
      return { status: 'unreported', month, count, error: scrub(this.config, describe(err)) };
    }
  }

  async retryPending(limit: number): Promise<OverageRetryResult> {
    let rows: ReportRow[];
    try {
      const db = await this.database();
      rows = await db
        .select({
          id: billingUsageReports.id,
          stripeSubscriptionId: billingUsageReports.stripeSubscriptionId,
          bundleId: billingUsageReports.bundleId,
          exportedAt: billingUsageReports.exportedAt,
        })
        .from(billingUsageReports)
        .where(eq(billingUsageReports.reported, false))
        .orderBy(asc(billingUsageReports.id))
        .limit(limit);
    } catch (err) {
      this.log(`billing overage: listing unreported bundles failed: ${describe(err)}. Nothing was sent.`);
      return { status: 'failed', reported: 0, failed: 0, errors: [scrub(this.config, describe(err))] };
    }
    if (rows.length === 0) return { status: 'idle', reported: 0, failed: 0, errors: [] };

    let reported = 0;
    const errors: string[] = [];
    for (const row of rows) {
      try {
        await this.report(row);
        reported++;
      } catch (err) {
        errors.push(scrub(this.config, describe(err)));
        this.log(`billing overage: retrying an overage bundle failed: ${describe(err)}. It stays unreported.`);
      }
    }
    return { status: 'done', reported, failed: errors.length, errors };
  }

  /** Records the export and, in the same transaction, a usage report if it is
   *  beyond the allowance. Exports for one subscription serialize on its row,
   *  so two at once cannot both be the fifth. */
  private async count(e: { accountId: string; bundleId: string }) {
    const db = await this.database();
    const sub = await this.cloudSubscription(db, e.accountId);
    if (!sub) return 'not_subscribed' as const;

    const at = this.now();
    const month = at.toISOString().slice(0, 7);
    const included = PLANS[sub.plan].includedBundlesPerMonth;
    const count = await db.transaction(async (tx) => {
      await tx
        .select({ id: billingSubscriptions.id })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.stripeSubscriptionId, sub.stripeSubscriptionId))
        .for('update');
      const inserted = await tx
        .insert(billingBundleExports)
        .values({ stripeSubscriptionId: sub.stripeSubscriptionId, bundleId: e.bundleId, month, exportedAt: at })
        .onConflictDoNothing()
        .returning({ id: billingBundleExports.id });
      if (inserted.length === 0) return null;
      const thisMonth = await tx
        .select({ id: billingBundleExports.id })
        .from(billingBundleExports)
        .where(and(
          eq(billingBundleExports.stripeSubscriptionId, sub.stripeSubscriptionId),
          eq(billingBundleExports.month, month),
        ));
      if (thisMonth.length > included) {
        await tx
          .insert(billingUsageReports)
          .values({ stripeSubscriptionId: sub.stripeSubscriptionId, bundleId: e.bundleId, exportedAt: at });
      }
      return thisMonth.length;
    });
    if (count === null) return 'duplicate' as const;
    return { sub, month, count, included };
  }

  /** The account's current Cloud subscription, never its overage one. */
  private async cloudSubscription(db: BillingDb, accountId: string): Promise<CloudSubscription | null> {
    const [customer] = await db
      .select({ stripeCustomerId: billingCustomers.stripeCustomerId })
      .from(billingCustomers)
      .where(eq(billingCustomers.accountId, accountId));
    if (!customer) return null;

    const rows = await db
      .select({
        stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId,
        stripeCustomerId: billingSubscriptions.stripeCustomerId,
        plan: billingSubscriptions.plan,
        interval: billingSubscriptions.interval,
        status: billingSubscriptions.status,
        // Set when this row is itself an annual subscription's overage
        // subscription, which the webhook records like any other.
        overageOf: billingOverageSubscriptions.stripeSubscriptionId,
      })
      .from(billingSubscriptions)
      .leftJoin(
        billingOverageSubscriptions,
        eq(billingOverageSubscriptions.overageSubscriptionId, billingSubscriptions.stripeSubscriptionId),
      )
      .where(eq(billingSubscriptions.stripeCustomerId, customer.stripeCustomerId))
      .orderBy(desc(billingSubscriptions.id));

    const sub = rows.find((s) =>
      s.overageOf === null &&
      ACTIVE.has(s.status) &&
      (s.interval === 'month' || s.interval === 'year') &&
      meteredPlan(s.plan));
    return sub ? { ...sub, plan: sub.plan as PlanId } : null;
  }

  /** Sends one row's meter event and marks it reported. Returns the
   *  subscription that bills it. */
  private async report(row: ReportRow): Promise<string> {
    const db = await this.database();
    const [sub] = await db
      .select({ stripeCustomerId: billingSubscriptions.stripeCustomerId, interval: billingSubscriptions.interval })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.stripeSubscriptionId, row.stripeSubscriptionId));
    if (!sub) throw new Error('the subscription for this bundle is not recorded');

    let billedOn: string;
    if (sub.interval === 'month') billedOn = row.stripeSubscriptionId;
    else if (sub.interval === 'year') billedOn = await this.overageSubscription(db, row.stripeSubscriptionId, sub.stripeCustomerId);
    else throw new Error(`the subscription has interval "${sub.interval}", which overage cannot bill`);

    // The bundle id is the identifier on every send, and the idempotency key
    // is derived from it, so a resend inside Stripe's window is the same event.
    await this.stripe.billing.meterEvents.create({
      event_name: this.config.meterEventName!,
      identifier: row.bundleId,
      timestamp: Math.floor(row.exportedAt.getTime() / 1000),
      payload: { stripe_customer_id: sub.stripeCustomerId, value: '1' },
    }, { idempotencyKey: `provenant-overage-${row.bundleId}` });

    await db
      .update(billingUsageReports)
      .set({ reported: true, reportedAt: this.now(), reportedSubscriptionId: billedOn })
      .where(and(eq(billingUsageReports.id, row.id), eq(billingUsageReports.reported, false)));
    return billedOn;
  }

  /** The annual subscription's monthly overage subscription, created on first
   *  use. It holds only the metered overage price, charges the payment method
   *  saved at annual checkout, and leaves the annual subscription untouched. */
  private async overageSubscription(db: BillingDb, annualId: string, customer: string): Promise<string> {
    const stored = async () => {
      const [link] = await db
        .select({ id: billingOverageSubscriptions.overageSubscriptionId })
        .from(billingOverageSubscriptions)
        .where(eq(billingOverageSubscriptions.stripeSubscriptionId, annualId));
      return link?.id ?? null;
    };
    const existing = await stored();
    if (existing) return existing;

    const price = this.config.prices.overage_bundle;
    if (!price) throw new Error('the overage price id is not configured');
    const annual = await this.stripe.subscriptions.retrieve(annualId);
    let paymentMethod = idOf(annual.default_payment_method);
    if (!paymentMethod) {
      const owner = await this.stripe.customers.retrieve(customer);
      paymentMethod = idOf(owner.invoice_settings?.default_payment_method);
    }
    if (!paymentMethod) {
      throw new Error('the annual subscription has no saved default payment method to bill overage to');
    }

    const created = await this.stripe.subscriptions.create({
      customer,
      items: [{ price }],
      default_payment_method: paymentMethod,
      proration_behavior: 'none',
      metadata: { provenant_purchase: 'overage_bundle', provenant_annual_subscription: annualId },
    }, { idempotencyKey: `provenant-overage-subscription-${annualId}` });

    await db
      .insert(billingOverageSubscriptions)
      .values({ stripeSubscriptionId: annualId, overageSubscriptionId: created.id })
      .onConflictDoNothing();
    // A concurrent creator may have stored first; theirs is the one to use.
    return (await stored()) ?? created.id;
  }
}

/** A paid plan with a finite monthly allowance: the only kind with overage. */
function meteredPlan(plan: string): boolean {
  if (!Object.hasOwn(PLANS, plan)) return false;
  const p = PLANS[plan as PlanId];
  return (p.monthlyUsd ?? 0) > 0 && Number.isFinite(p.includedBundlesPerMonth);
}

function idOf(ref: Ref): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

/** The Neon serverless driver over a WebSocket pool, loaded only when a
 *  deployment reports without passing its own database. */
async function connectNeon(databaseUrl: string, onError: (line: string) => void): Promise<BillingDb> {
  const [{ Pool }, { drizzle }] = await Promise.all([
    import('@neondatabase/serverless'),
    import('drizzle-orm/neon-serverless'),
  ]);
  const pool = new Pool({ connectionString: databaseUrl });
  pool.on('error', (err: unknown) => onError(`billing overage: database pool error: ${describe(err)}`));
  return drizzle({ client: pool, schema: billingSchema });
}

/** Secrets, DATABASE_URL and its parts, the meter event name, account ids and
 *  anything shaped like a Stripe id. */
function scrub(config: BillingConfig, text: string): string {
  return config.redact(redact(text)).replace(STRIPE_ID, REDACTED).replace(ACCOUNT_ID, REDACTED);
}

/**
 * Name, SQLSTATE and message of the underlying error, with the fix for a
 * database the overage tables are not in yet. drizzle wraps a failed query in
 * an error whose message lists its parameters, so the cause is described
 * instead of the wrapper.
 */
function describe(err: unknown): string {
  let e = err;
  while (e && typeof e === 'object' && 'cause' in e && e.cause && /Failed query/.test(String((e as Error).message))) {
    e = e.cause;
  }
  let out = String(e);
  if (e && typeof e === 'object') {
    const x = e as { name?: unknown; code?: unknown; message?: unknown };
    const parts = [x.name, x.code, x.message].filter((v) => v !== undefined && v !== null && v !== '');
    if (parts.length) out = parts.map(String).join(' ');
    if (x.code === '42P01' || x.code === '42703') out += ' (apply 0001_overage.sql to the billing database)';
  }
  return out;
}

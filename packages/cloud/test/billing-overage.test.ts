import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import {
  openDb, closeDb, appendReceipt, generateKeypair, deriveAgentId, LacreError,
  type Db, type Keypair, type ActionContext,
} from '@lacre/core';
import {
  billingSchema, billingCustomers, billingSubscriptions, billingBundleCredits, billingBundleExports,
  billingUsageReports, billingOverageSubscriptions,
} from '../src/billing/schema.js';
import {
  createOverageReporter, installOverageReporter, retryPendingOverage, recordBundleOverage, bundleIdOf,
  type OverageStripe, type MeterEventParams, type OverageReporterOptions,
} from '../src/billing/overage.js';
import { PRICE_ENV, METER_EVENT_ENV, loadBillingConfig } from '../src/billing/config.js';
import { OVERAGE_METER_EVENT } from '../src/billing/stripe.js';
import { bundleExportAction } from '../src/actions/bundle.js';
import type { BillingDb } from '../src/billing/store.js';

/*
 * No test calls Stripe or a real database. Stripe is the fake below, Postgres is
 * PGlite in process. Secret-shaped values are assembled at run time, so this
 * file never holds one.
 */
const u = (...parts: string[]) => parts.join('_');
const TEST_KEY = u('sk', 'test', 'x'.repeat(24));
const LIVE_KEY = u('sk', 'live', 'y'.repeat(24));
const PRICE_OVERAGE = u('price', 'testoveragebundle');
const PRICE_YEAR = u('price', 'testcloudyear');
// Deliberately not the catalog's name, so a hard-coded one would show.
const METER_NAME = 'test-configured-overage-meter';

const ENV: Record<string, string> = { STRIPE_SECRET_KEY: TEST_KEY, [METER_EVENT_ENV]: METER_NAME };
for (const [key, name] of Object.entries(PRICE_ENV)) ENV[name] = u('price', 'test' + key.replace(/_/g, ''));

const MONTHLY = { account: 'urn:lacre:agent:test-monthly', customer: 'cus_test_monthly', subscription: 'sub_test_monthly', interval: 'month' as const };
const ANNUAL = { account: 'urn:lacre:agent:test-annual', customer: 'cus_test_annual', subscription: 'sub_test_annual', interval: 'year' as const };
const SAVED_PM = 'pm_test_saved_at_checkout';

const MIGRATIONS = ['0000_billing.sql', '0001_overage.sql', '0002_overage_retry.sql']
  .map((f) => fileURLToPath(new URL(`../migrations/${f}`, import.meta.url)));
const SRC = (p: string) => fileURLToPath(new URL(`../src/${p}`, import.meta.url));

const DAY = 24 * 60 * 60_000;
const OCT_15 = Date.UTC(2026, 9, 15, 12);
const OCT_31_LATE = Date.UTC(2026, 9, 31, 23, 59);
const NOV_1 = Date.UTC(2026, 10, 1, 0, 1);

// --------------------------------------------------------------- fake Stripe --

type Failure = 'reject' | 'lose';

/**
 * Stands in for the slice of Stripe overage uses, plus the calls it must never
 * make. A meter event identifier is deduped for 24 hours of the fake's clock,
 * as Stripe does, and only that long.
 */
function fakeStripe(clock: () => number) {
  const calls: string[] = [];
  const meterCalls: Array<{ params: MeterEventParams; idempotencyKey?: string }> = [];
  /** Events the meter counted: what the customer is billed for. */
  const billed: MeterEventParams[] = [];
  const seen = new Map<string, number>();
  const created: Array<{ params: Record<string, unknown>; idempotencyKey?: string }> = [];
  const forbidden: string[] = [];
  const subscriptions = new Map<string, { id: string; customer: string; items: Array<{ price: string }>; default_payment_method: string | null }>([
    [ANNUAL.subscription, { id: ANNUAL.subscription, customer: ANNUAL.customer, items: [{ price: PRICE_YEAR }], default_payment_method: SAVED_PM }],
  ]);
  const failures = { meter: [] as Failure[], create: [] as Failure[] };

  const client: OverageStripe = {
    billing: {
      meterEvents: {
        async create(params, options) {
          calls.push('meterEvents.create');
          meterCalls.push({ params, ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) });
          const failure = failures.meter.shift();
          if (failure === 'reject') throw new Error('Stripe is unavailable');
          const first = seen.get(params.identifier);
          if (first === undefined || clock() - first >= DAY) {
            seen.set(params.identifier, clock());
            billed.push(params);
          }
          if (failure === 'lose') throw new Error('socket hang up after the request was sent');
          return { object: 'billing.meter_event', identifier: params.identifier };
        },
      },
    },
    subscriptions: {
      async create(params, options) {
        calls.push('subscriptions.create');
        const failure = failures.create.shift();
        if (failure === 'reject') throw new Error('Stripe is unavailable');
        created.push({ params, ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) });
        const id = `sub_test_overage_${created.length}`;
        subscriptions.set(id, {
          id, customer: String(params.customer), items: params.items as Array<{ price: string }>,
          default_payment_method: String(params.default_payment_method),
        });
        return { id };
      },
      async retrieve(id) {
        calls.push('subscriptions.retrieve');
        const s = subscriptions.get(id);
        if (!s) throw new Error('No such subscription');
        return structuredClone(s);
      },
    },
    customers: {
      async retrieve() {
        calls.push('customers.retrieve');
        return { invoice_settings: { default_payment_method: null } };
      },
    },
  };
  // Methods a correct implementation never reaches for: changing the annual
  // subscription, or adding a consent or confirmation step.
  const extra = {
    subscriptions: { update: async () => { forbidden.push('subscriptions.update'); return {}; } },
    subscriptionItems: { create: async () => { forbidden.push('subscriptionItems.create'); return {}; } },
    setupIntents: { create: async () => { forbidden.push('setupIntents.create'); return {}; } },
    paymentIntents: { create: async () => { forbidden.push('paymentIntents.create'); return {}; } },
    checkout: { sessions: { create: async () => { forbidden.push('checkout.sessions.create'); return {}; } } },
  };
  Object.assign(client.subscriptions, extra.subscriptions);
  Object.assign(client, { subscriptionItems: extra.subscriptionItems, setupIntents: extra.setupIntents, paymentIntents: extra.paymentIntents, checkout: extra.checkout });

  return { client, calls, meterCalls, billed, created, forbidden, subscriptions, failures };
}

// ------------------------------------------------------------------ database --

let pg: PGlite;
let db: BillingDb;

beforeAll(async () => {
  pg = await PGlite.create();
  for (const m of MIGRATIONS) await pg.exec(readFileSync(m, 'utf8'));
  db = drizzle({ client: pg, schema: billingSchema });
});
afterAll(async () => {
  await pg.close();
});

let now: number;
let fake: ReturnType<typeof fakeStripe>;
let logs: string[];

beforeEach(async () => {
  await pg.exec(
    'TRUNCATE billing_usage_reports, billing_bundle_exports, billing_overage_subscriptions, billing_bundle_credits, ' +
      'billing_subscriptions, billing_customers, billing_webhook_events RESTART IDENTITY CASCADE',
  );
  now = OCT_15;
  fake = fakeStripe(() => now);
  logs = [];
});
afterEach(() => installOverageReporter(null));

function reporter(o: Partial<OverageReporterOptions> = {}) {
  return createOverageReporter({
    env: ENV, stripe: fake.client, db, now: () => new Date(now), log: (l) => logs.push(l), ...o,
  });
}

async function subscriber(s: { account: string; customer: string; subscription: string; interval: 'month' | 'year'; status?: string }) {
  await db.insert(billingCustomers).values({ stripeCustomerId: s.customer, accountId: s.account }).onConflictDoNothing();
  await db.insert(billingSubscriptions).values({
    stripeSubscriptionId: s.subscription, stripeCustomerId: s.customer, plan: 'cloud', interval: s.interval,
    status: s.status ?? 'active', stripePriceId: s.interval === 'year' ? PRICE_YEAR : null,
  });
}

/** Exports `n` distinct bundles for the account; returns their outcomes. */
async function exportBundles(r: ReturnType<typeof reporter>, account: string, n: number, prefix = 'test-bundle') {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await r.recordExport({ accountId: account, bundleId: `${prefix}-${randomUUID()}` }));
  return out;
}

const reports = () => db.select().from(billingUsageReports).orderBy(billingUsageReports.id);
const exportsRows = () => db.select().from(billingBundleExports);

// ---------------------------------------------------------------- the count --

describe('monthly Cloud subscriber', () => {
  it('the 6th, 7th and 8th bundles in a month create 3 rows and 3 meter events; the first 5 create none', async () => {
    await subscriber(MONTHLY);
    const r = reporter();

    const first = await exportBundles(r, MONTHLY.account, 5);
    expect(first.map((o) => o.status)).toEqual(['included', 'included', 'included', 'included', 'included']);
    expect(await reports()).toHaveLength(0);
    expect(fake.meterCalls).toHaveLength(0);

    const over = await exportBundles(r, MONTHLY.account, 3);
    expect(over.map((o) => o.status)).toEqual(['reported', 'reported', 'reported']);
    const rows = await reports();
    expect(rows).toHaveLength(3);
    expect(fake.billed).toHaveLength(3);
    // Each event carries its own bundle's id as its identifier.
    expect(fake.meterCalls.map((c) => c.params.identifier)).toEqual(rows.map((row) => row.bundleId));
    for (const c of fake.meterCalls) {
      expect(c.params.event_name).toBe(METER_NAME);
      expect(c.params.payload).toEqual({ stripe_customer_id: MONTHLY.customer, value: '1' });
    }
    // Billed on the main subscription; no overage subscription for monthly.
    expect(rows.every((row) => row.reported && row.reportedSubscriptionId === MONTHLY.subscription)).toBe(true);
    expect(fake.calls).not.toContain('subscriptions.create');
    expect(await db.select().from(billingOverageSubscriptions)).toHaveLength(0);
  });

  it('a new calendar month resets the count, with no rollover', async () => {
    await subscriber(MONTHLY);
    const r = reporter();
    // Only 2 of October's 5 used; the 3 left do not carry into November.
    now = OCT_31_LATE;
    await exportBundles(r, MONTHLY.account, 2);

    now = NOV_1;
    const nov = await exportBundles(r, MONTHLY.account, 6);
    expect(nov.slice(0, 5).map((o) => o.status)).toEqual(Array(5).fill('included'));
    expect(nov[0]).toMatchObject({ status: 'included', month: '2026-11', count: 1, included: 5 });
    expect(nov[5]).toMatchObject({ status: 'reported', month: '2026-11', count: 6 });
    expect(await reports()).toHaveLength(1);
    expect(fake.billed).toHaveLength(1);
  });
});

// ------------------------------------------------------------- durable dedupe --

describe('durable dedupe', () => {
  it('the unique constraint rejects a second row for the same (subscription, bundle)', async () => {
    await subscriber(MONTHLY);
    const row = { stripeSubscriptionId: MONTHLY.subscription, bundleId: 'test-bundle-dup', exportedAt: new Date(now) };
    await db.insert(billingUsageReports).values(row);
    await expect(db.insert(billingUsageReports).values(row)).rejects.toMatchObject({
      cause: expect.objectContaining({ code: '23505' }),
    });
    await db.insert(billingBundleExports).values({ ...row, month: '2026-10' });
    await expect(db.insert(billingBundleExports).values({ ...row, month: '2026-10' })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: '23505' }),
    });
  });

  it('recording the same bundle again counts nothing and sends nothing', async () => {
    await subscriber(MONTHLY);
    const r = reporter();
    await exportBundles(r, MONTHLY.account, 5);
    const bundleId = 'test-bundle-sixth';
    expect((await r.recordExport({ accountId: MONTHLY.account, bundleId })).status).toBe('reported');
    expect((await r.recordExport({ accountId: MONTHLY.account, bundleId })).status).toBe('duplicate');
    expect(await exportsRows()).toHaveLength(6);
    expect(await reports()).toHaveLength(1);
    expect(fake.meterCalls).toHaveLength(1);
  });

  it('re-running reporting, even more than 24 hours later, never resends a reported row', async () => {
    await subscriber(MONTHLY);
    const r = reporter();
    await exportBundles(r, MONTHLY.account, 6);
    expect(fake.meterCalls).toHaveLength(1);

    for (const later of [1, 25, 48, 24 * 20].map((h) => OCT_15 + h * 60 * 60_000)) {
      now = later;
      // Past 24 hours Stripe would bill a resend again; only the row stops it.
      expect(await retryPendingOverage(r)).toMatchObject({ status: 'idle', reported: 0 });
    }
    expect(fake.meterCalls).toHaveLength(1);
    expect(fake.billed).toHaveLength(1);
  });

  it('a lost response: Stripe accepted, the row stays unreported, the retry resends the same identifier, billed once', async () => {
    await subscriber(MONTHLY);
    const r = reporter();
    await exportBundles(r, MONTHLY.account, 5);

    fake.failures.meter.push('lose');
    const outcome = await r.recordExport({ accountId: MONTHLY.account, bundleId: 'test-bundle-lost' });
    expect(outcome.status).toBe('unreported');
    expect(fake.billed).toHaveLength(1); // Stripe has it
    let [row] = await reports();
    expect(row!.reported).toBe(false);

    now += 60 * 60_000;
    expect(await retryPendingOverage(r)).toMatchObject({ status: 'done', reported: 1, failed: 0 });
    expect(fake.meterCalls).toHaveLength(2);
    const [sent, resent] = fake.meterCalls;
    expect(resent!.params.identifier).toBe('test-bundle-lost');
    expect(resent!.params).toEqual(sent!.params);
    expect(resent!.idempotencyKey).toBe(sent!.idempotencyKey);
    [row] = await reports();
    expect(row).toMatchObject({ reported: true, reportedSubscriptionId: MONTHLY.subscription });
    expect(fake.billed).toHaveLength(1); // once, not twice
  });
});

// ---------------------------------------------------------- never blocks export --

describe('billing never blocks the export', () => {
  let core: Db;
  let kp: Keypair;
  let store: string;

  beforeEach(() => {
    core = openDb(':memory:');
    kp = generateKeypair();
    store = mkdtempSync(join(tmpdir(), 'provenant-overage-'));
  });
  afterEach(() => {
    closeDb(core);
    rmSync(store, { recursive: true, force: true });
  });

  const sessionId = randomUUID();
  const ctx = (): ActionContext => ({ db: core, storeDir: store, identity: () => kp, sessionId });
  const agent = () => deriveAgentId(kp.publicKey);

  /** One real export through the action, after a new receipt so each bundle differs. */
  async function exportOnce() {
    appendReceipt(core, {
      agentId: agent(), agentVersion: '1.0.0', trustLevel: 'L1', keyId: kp.keyId, secretKey: kp.secretKey,
      action: 'refund.issue', actionType: 'tool_call', actionDetail: { amount_usd: 42 },
      sideEffectClass: 'irreversible', outcome: 'success', sessionId,
    } as Parameters<typeof appendReceipt>[1]);
    return bundleExportAction.handler(bundleExportAction.input.parse({}), ctx());
  }

  it('with no reporter installed, the export runs exactly as before and touches nothing', async () => {
    const out = await exportOnce();
    expect(out.receipt_count).toBe(1);
    expect(await recordBundleOverage(ctx(), out.bundle as never)).toBeNull();
    expect(await retryPendingOverage()).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it('a Stripe failure: the export is still produced, the row is retried first on the next export', async () => {
    await subscriber({ ...MONTHLY, account: agent() });
    installOverageReporter(reporter());
    for (let i = 0; i < 5; i++) await exportOnce();

    fake.failures.meter.push('reject');
    const sixth = await exportOnce();
    expect(sixth.receipt_count).toBe(6);
    expect(sixth.bundle).toBeDefined();
    const sixthId = bundleIdOf(sixth.bundle as never);
    expect(await reports()).toMatchObject([{ bundleId: sixthId, reported: false }]);
    expect(fake.billed).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/stays unreported/);

    const seventh = await exportOnce();
    expect(seventh.receipt_count).toBe(7);
    // The retry ran at the start of the export, before the new bundle's event.
    expect(fake.meterCalls.map((c) => c.params.identifier)).toEqual([sixthId, sixthId, bundleIdOf(seventh.bundle as never)]);
    expect((await reports()).map((row) => row.reported)).toEqual([true, true]);
    expect(fake.billed).toHaveLength(2);
  });

  it('a Stripe failure is also retried by retryPendingOverage, the cron entry point', async () => {
    await subscriber({ ...MONTHLY, account: agent() });
    const r = reporter();
    installOverageReporter(r);
    for (let i = 0; i < 5; i++) await exportOnce();
    fake.failures.meter.push('reject');
    await exportOnce();
    expect((await reports())[0]!.reported).toBe(false);

    expect(await retryPendingOverage(r)).toMatchObject({ status: 'done', reported: 1, failed: 0 });
    expect((await reports())[0]!.reported).toBe(true);
    expect(fake.billed).toHaveLength(1);
  });

  it('a database without 0001_overage.sql: the export is still produced and nothing is sent', async () => {
    const old = await PGlite.create();
    try {
      await old.exec(readFileSync(MIGRATIONS[0]!, 'utf8'));
      const oldDb = drizzle({ client: old, schema: billingSchema });
      await oldDb.insert(billingCustomers).values({ stripeCustomerId: MONTHLY.customer, accountId: agent() });
      await oldDb.insert(billingSubscriptions).values({
        stripeSubscriptionId: MONTHLY.subscription, stripeCustomerId: MONTHLY.customer, plan: 'cloud', interval: 'month', status: 'active',
      });
      const r = reporter({ db: oldDb });
      installOverageReporter(r);

      for (let i = 0; i < 7; i++) {
        const out = await exportOnce();
        expect(out.receipt_count).toBe(i + 1);
        expect(out.bundle).toBeDefined();
      }
      expect(fake.calls).toEqual([]);
      expect(logs.join('\n')).toMatch(/0001_overage\.sql/);
      expect(await retryPendingOverage(r)).toMatchObject({ status: 'failed' });
    } finally {
      await old.close();
    }
  });

  it('a dry run counts nothing', async () => {
    await subscriber({ ...MONTHLY, account: agent() });
    installOverageReporter(reporter());
    for (let i = 0; i < 6; i++) await bundleExportAction.dryRun!(bundleExportAction.input.parse({}), ctx());
    expect(await exportsRows()).toHaveLength(0);
    expect(fake.calls).toEqual([]);
  });
});

// ------------------------------------------------------------------ routing --

describe('routing: annual customers get a separate monthly overage subscription', () => {
  it('created once on the 6th bundle, reused after, billed instead of the annual one, which is never changed', async () => {
    await subscriber(ANNUAL);
    const r = reporter();
    await exportBundles(r, ANNUAL.account, 5);
    expect(fake.calls).toEqual([]);

    const [sixth, seventh] = await exportBundles(r, ANNUAL.account, 2);
    expect(fake.created).toHaveLength(1);
    const { params, idempotencyKey } = fake.created[0]!;
    // Only the metered overage price: no Cloud base price.
    expect(params.items).toEqual([{ price: PRICE_OVERAGE }]);
    expect(params.proration_behavior).toBe('none');
    expect(params.customer).toBe(ANNUAL.customer);
    // The payment method saved at annual checkout, and no consent step.
    expect(params.default_payment_method).toBe(SAVED_PM);
    expect(idempotencyKey).toBeTruthy();

    const overageId = 'sub_test_overage_1';
    expect(sixth).toMatchObject({ status: 'reported', subscription: overageId });
    expect(seventh).toMatchObject({ status: 'reported', subscription: overageId });
    expect(await db.select().from(billingOverageSubscriptions)).toMatchObject([
      { stripeSubscriptionId: ANNUAL.subscription, overageSubscriptionId: overageId },
    ]);
    expect((await reports()).map((row) => row.reportedSubscriptionId)).toEqual([overageId, overageId]);
    expect(fake.billed.map((e) => e.payload.stripe_customer_id)).toEqual([ANNUAL.customer, ANNUAL.customer]);

    // The $490/yr subscription is untouched: no update, items unchanged.
    expect(fake.forbidden).toEqual([]);
    expect(fake.subscriptions.get(ANNUAL.subscription)!.items).toEqual([{ price: PRICE_YEAR }]);
    expect(new Set(fake.calls)).toEqual(new Set(['subscriptions.retrieve', 'subscriptions.create', 'meterEvents.create']));
  });

  it('exports keep counting against the annual subscription after the webhook records the overage one', async () => {
    await subscriber(ANNUAL);
    const r = reporter();
    await exportBundles(r, ANNUAL.account, 6);
    // customer.subscription.updated for the overage subscription lands it in
    // billing_subscriptions as a monthly row like any other.
    await db.insert(billingSubscriptions).values({
      stripeSubscriptionId: 'sub_test_overage_1', stripeCustomerId: ANNUAL.customer, plan: 'cloud', interval: 'month', status: 'active',
    });
    await exportBundles(r, ANNUAL.account, 1);
    expect(new Set((await exportsRows()).map((row) => row.stripeSubscriptionId))).toEqual(new Set([ANNUAL.subscription]));
    expect(fake.created).toHaveLength(1);
    expect((await reports()).map((row) => row.reportedSubscriptionId)).toEqual(['sub_test_overage_1', 'sub_test_overage_1']);
  });

  it('a failed creation leaves the rows unreported; the retry creates it once and reports them', async () => {
    await subscriber(ANNUAL);
    const r = reporter();
    await exportBundles(r, ANNUAL.account, 5);
    fake.failures.create.push('reject', 'reject');
    const out = await exportBundles(r, ANNUAL.account, 2);
    expect(out.map((o) => o.status)).toEqual(['unreported', 'unreported']);
    expect(fake.meterCalls).toHaveLength(0);
    expect(await db.select().from(billingOverageSubscriptions)).toHaveLength(0);

    expect(await retryPendingOverage(r)).toMatchObject({ status: 'done', reported: 2, failed: 0 });
    expect(fake.created).toHaveLength(1);
    expect(fake.billed).toHaveLength(2);
    expect((await reports()).every((row) => row.reported && row.reportedSubscriptionId === 'sub_test_overage_1')).toBe(true);
  });

  it("a monthly customer's 6th bundle bills their main subscription and creates no overage subscription", async () => {
    await subscriber(MONTHLY);
    const r = reporter();
    const out = await exportBundles(r, MONTHLY.account, 6);
    expect(out[5]).toMatchObject({ status: 'reported', subscription: MONTHLY.subscription });
    expect(fake.calls).toEqual(['meterEvents.create']);
    expect(fake.created).toHaveLength(0);
  });
});

// ------------------------------------------------------------- not subscribed --

describe('free and pay-as-you-go users', () => {
  it('never create usage rows or meter events', async () => {
    const r = reporter();
    // Free: no Stripe customer at all.
    expect((await exportBundles(r, 'urn:lacre:agent:test-free', 8)).every((o) => o.status === 'not_subscribed')).toBe(true);
    // Pay-as-you-go: a customer with a bundle credit and no subscription.
    await db.insert(billingCustomers).values({ stripeCustomerId: 'cus_test_payg', accountId: 'urn:lacre:agent:test-payg' });
    await db.insert(billingBundleCredits).values({ stripeCheckoutSessionId: 'cs_test_payg', stripeCustomerId: 'cus_test_payg' });
    expect((await exportBundles(r, 'urn:lacre:agent:test-payg', 8)).every((o) => o.status === 'not_subscribed')).toBe(true);
    // A canceled Cloud subscription no longer has the plan.
    await subscriber({ ...MONTHLY, status: 'canceled' });
    expect((await exportBundles(r, MONTHLY.account, 8)).every((o) => o.status === 'not_subscribed')).toBe(true);

    expect(await exportsRows()).toHaveLength(0);
    expect(await reports()).toHaveLength(0);
    expect(fake.calls).toEqual([]);
  });
});

// ------------------------------------------------------------------- config --

describe('configuration: env only, test mode first, never logged', () => {
  it('reads STRIPE_METER_EVENT_NAME and refuses to start without it, naming it', () => {
    const { [METER_EVENT_ENV]: _gone, ...rest } = ENV;
    const err = (() => {
      try {
        createOverageReporter({ env: rest, stripe: fake.client, db });
      } catch (e) {
        return e as LacreError;
      }
      throw new Error('expected a throw');
    })();
    expect(err).toBeInstanceOf(LacreError);
    expect(err.message).toMatch(/STRIPE_METER_EVENT_NAME/);
    expect(() => createOverageReporter({ env: { ...ENV, [METER_EVENT_ENV]: 'not a name!' }, stripe: fake.client, db }))
      .toThrow(/STRIPE_METER_EVENT_NAME is not a Stripe meter event name/);
    expect(() => createOverageReporter({ env: { ...ENV, [PRICE_ENV.overage_bundle]: '' }, stripe: fake.client, db }))
      .toThrow(/STRIPE_PRICE_BUNDLE_OVERAGE/);
  });

  it('refuses a live key unless LACRE_BILLING_MODE=live', () => {
    expect(() => createOverageReporter({ env: { ...ENV, STRIPE_SECRET_KEY: LIVE_KEY }, stripe: fake.client, db }))
      .toThrow(/LACRE_BILLING_MODE/);
    const live = createOverageReporter({
      env: { ...ENV, STRIPE_SECRET_KEY: LIVE_KEY, LACRE_BILLING_MODE: 'live' }, stripe: fake.client, db,
    });
    expect(live.mode).toBe('live');
  });

  it('never prints the key, the price ids or the meter event name, from the config or a failure', async () => {
    const cfg = loadBillingConfig(ENV, ['stripe', 'prices', 'meter']);
    expect(cfg.meterEventName).toBe(METER_NAME);
    const printed = [inspect(cfg, { depth: 5 }), JSON.stringify(cfg), String(cfg), Object.keys(cfg).join(' ')].join('\n');
    expect(printed).toMatch(/redacted/);

    await subscriber(MONTHLY);
    await subscriber(ANNUAL);
    const leak = `key ${TEST_KEY} price ${PRICE_OVERAGE} meter ${METER_NAME} customer ${MONTHLY.customer} ${ANNUAL.subscription} pm ${SAVED_PM} account ${MONTHLY.account}`;
    const leaky: OverageStripe = {
      ...fake.client,
      billing: { meterEvents: { create: async () => { throw new Error(`rejected: ${leak}`); } } },
      subscriptions: { ...fake.client.subscriptions, create: async () => { throw new Error(`rejected: ${leak}`); } },
    };
    const r = reporter({ stripe: leaky });
    await exportBundles(r, MONTHLY.account, 6);
    await exportBundles(r, ANNUAL.account, 6);
    const retried = await retryPendingOverage(r);
    expect(logs.length).toBeGreaterThanOrEqual(4);

    const surfaces = [printed, ...logs, ...(retried?.errors ?? [])].join('\n');
    for (const value of [TEST_KEY, METER_NAME, ...Object.values(PRICE_ENV).map((n) => ENV[n]!), MONTHLY.customer, ANNUAL.subscription, SAVED_PM, MONTHLY.account]) {
      expect(surfaces, 'a configured value or id leaked').not.toContain(value);
    }
    expect(logs.join('\n')).toMatch(/rejected/);
  });

  it('no meter event name is hard-coded: the event carries only the configured one', async () => {
    for (const file of ['billing/overage.ts', 'actions/bundle.ts']) {
      const src = readFileSync(SRC(file), 'utf8');
      expect(src, file).not.toContain(OVERAGE_METER_EVENT);
      expect(src, file).not.toMatch(/OVERAGE_METER_EVENT/);
      expect(src, file).not.toMatch(/event_name:\s*['"`]/);
    }
    await subscriber(MONTHLY);
    await exportBundles(reporter(), MONTHLY.account, 6);
    expect(fake.meterCalls.map((c) => c.params.event_name)).toEqual([METER_NAME]);
  });
});

// ---------------------------------------------------------------- migration --

describe('0001_overage.sql', () => {
  const tables = [billingBundleExports, billingUsageReports, billingOverageSubscriptions] as PgTable[];

  it('applies after 0000 to a fresh in-process Postgres and matches the drizzle schema', async () => {
    const fresh = await PGlite.create();
    try {
      for (const m of MIGRATIONS) await fresh.exec(readFileSync(m, 'utf8'));
      for (const table of tables) {
        const config = getTableConfig(table);
        const { rows: columns } = await fresh.query<{ column_name: string; data_type: string; is_nullable: string }>(
          'SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name',
          [config.name],
        );
        expect(columns, config.name).toEqual(
          config.columns
            .map((c) => ({ column_name: c.name, data_type: c.getSQLType(), is_nullable: c.notNull ? 'NO' : 'YES' }))
            .sort((a, b) => a.column_name.localeCompare(b.column_name)),
        );
        const { rows: constraints } = await fresh.query<{ constraint_name: string }>(
          "SELECT constraint_name FROM information_schema.table_constraints WHERE table_name = $1 AND constraint_type IN ('UNIQUE', 'FOREIGN KEY') ORDER BY constraint_name",
          [config.name],
        );
        const expected = [
          ...config.columns.filter((c) => c.isUnique).map((c) => c.uniqueName!),
          ...config.uniqueConstraints.map((c) => c.getName()),
          ...config.foreignKeys.map((fk) => fk.getName()),
        ].sort();
        expect(constraints.map((c) => c.constraint_name), config.name).toEqual(expected);
      }
    } finally {
      await fresh.close();
    }
  });

  it('changes no table 0000 created, so the webhook keeps working before it is applied', () => {
    const sql = readFileSync(MIGRATIONS[1]!, 'utf8');
    expect(sql).not.toMatch(/ALTER\s+TABLE|DROP\s/i);
    const created = [...sql.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]);
    expect(created).toEqual(tables.map((t) => getTableConfig(t).name));
  });
});

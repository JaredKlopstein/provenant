import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import {
  billingSchema, billingCustomers, billingSubscriptions, billingBundleExports, billingUsageReports,
  billingOverageSubscriptions,
} from '../src/billing/schema.js';
import { createOverageReporter, type OverageStripe, type MeterEventParams } from '../src/billing/overage.js';
import { PRICE_ENV, METER_EVENT_ENV } from '../src/billing/config.js';
import type { BillingDb } from '../src/billing/store.js';

/*
 * When an annual subscriber's meter event is timestamped. Stripe bills meter
 * usage only inside a subscription's billing period, and the overage
 * subscription starts at report time, after the export. Stripe is the fake
 * below, Postgres is PGlite in process; nothing touches the network.
 * Secret-shaped values are assembled at run time.
 */
const u = (...parts: string[]) => parts.join('_');
const TEST_KEY = u('sk', 'test', 'x'.repeat(24));
const PRICE_OVERAGE = u('price', 'testoveragebundle');
const PRICE_YEAR = u('price', 'testcloudyear');
const ENV: Record<string, string> = { STRIPE_SECRET_KEY: TEST_KEY, [METER_EVENT_ENV]: 'test-overage-meter' };
for (const [key, name] of Object.entries(PRICE_ENV)) ENV[name] = u('price', 'test' + key.replace(/_/g, ''));

const MONTHLY = { account: 'urn:lacre:agent:test-monthly', customer: 'cus_test_monthly', subscription: 'sub_test_monthly', interval: 'month' as const };
const ANNUAL = { account: 'urn:lacre:agent:test-annual', customer: 'cus_test_annual', subscription: 'sub_test_annual', interval: 'year' as const };
const SAVED_PM = 'pm_test_saved_at_checkout';

const MIGRATIONS = ['0000_billing.sql', '0001_overage.sql', '0002_overage_retry.sql']
  .map((f) => fileURLToPath(new URL(`../migrations/${f}`, import.meta.url)));

const MINUTE = 60_000;
const OCT_15 = Date.UTC(2026, 9, 15, 12);
const OCT_31_LATE = Date.UTC(2026, 9, 31, 23, 59);
const NOV_1 = Date.UTC(2026, 10, 1, 0, 1);
const secs = (ms: number) => Math.floor(ms / 1000);

/** Stripe's side: a subscription it creates starts at Stripe's clock, which
 *  the test moves independently of the reporter's. */
function fakeStripe(stripeClock: () => number) {
  const meterCalls: MeterEventParams[] = [];
  const created: Array<{ params: Record<string, unknown>; startDate: number }> = [];
  const forbidden: string[] = [];
  const failures = { create: [] as string[] };
  const annual = { id: ANNUAL.subscription, customer: ANNUAL.customer, items: [{ price: PRICE_YEAR }], default_payment_method: SAVED_PM };

  const client: OverageStripe = {
    billing: {
      meterEvents: {
        async create(params) {
          meterCalls.push(params);
          return { object: 'billing.meter_event', identifier: params.identifier };
        },
      },
    },
    subscriptions: {
      async create(params) {
        if (failures.create.shift()) throw new Error('Stripe is unavailable');
        const startDate = secs(stripeClock());
        created.push({ params, startDate });
        return { id: `sub_test_overage_${created.length}`, start_date: startDate };
      },
      async retrieve(id) {
        if (id !== annual.id) throw new Error('No such subscription');
        return structuredClone(annual);
      },
    },
    customers: {
      async retrieve() {
        return { invoice_settings: { default_payment_method: null } };
      },
    },
  };
  // Changing the annual subscription is never the answer.
  Object.assign(client.subscriptions, { update: async () => { forbidden.push('subscriptions.update'); return {}; } });
  Object.assign(client, { subscriptionItems: { create: async () => { forbidden.push('subscriptionItems.create'); return {}; } } });

  return { client, meterCalls, created, forbidden, failures, annual };
}

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

/** The reporter's clock: when a bundle is exported or a retry runs. */
let now: number;
/** Stripe's clock: when a subscription it creates starts. */
let stripeNow: number;
let fake: ReturnType<typeof fakeStripe>;

beforeEach(async () => {
  await pg.exec(
    'TRUNCATE billing_usage_reports, billing_bundle_exports, billing_overage_subscriptions, billing_bundle_credits, ' +
      'billing_subscriptions, billing_customers, billing_webhook_events RESTART IDENTITY CASCADE',
  );
  now = OCT_15;
  stripeNow = OCT_15;
  fake = fakeStripe(() => stripeNow);
});

function reporter() {
  return createOverageReporter({ env: ENV, stripe: fake.client, db, now: () => new Date(now), log: () => {} });
}

async function subscriber(s: { account: string; customer: string; subscription: string; interval: 'month' | 'year' }) {
  await db.insert(billingCustomers).values({ stripeCustomerId: s.customer, accountId: s.account });
  await db.insert(billingSubscriptions).values({
    stripeSubscriptionId: s.subscription, stripeCustomerId: s.customer, plan: 'cloud', interval: s.interval,
    status: 'active', stripePriceId: s.interval === 'year' ? PRICE_YEAR : null,
  });
}

async function exportBundle(r: ReturnType<typeof reporter>, account: string) {
  const bundleId = `test-bundle-${randomUUID()}`;
  return { bundleId, outcome: await r.recordExport({ accountId: account, bundleId }) };
}

async function exportBundles(r: ReturnType<typeof reporter>, account: string, n: number) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await exportBundle(r, account));
  return out;
}

const eventFor = (bundleId: string) => fake.meterCalls.find((e) => e.identifier === bundleId);

describe('annual subscriber: the meter event falls inside the overage subscription', () => {
  it("the 6th bundle, exported at t0 with the overage subscription created at t1 > t0, is sent at t1 or later", async () => {
    await subscriber(ANNUAL);
    const r = reporter();
    await exportBundles(r, ANNUAL.account, 5);

    const t0 = OCT_15;
    const t1 = t0 + 2 * MINUTE;
    stripeNow = t1;
    const sixth = await exportBundle(r, ANNUAL.account);

    expect(sixth.outcome).toMatchObject({ status: 'reported', subscription: 'sub_test_overage_1' });
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]!.startDate).toBe(secs(t1));
    expect(eventFor(sixth.bundleId)!.timestamp).toBeGreaterThanOrEqual(secs(t1));
    // The stored link carries the subscription's start.
    const [link] = await db.select().from(billingOverageSubscriptions);
    expect(link!.createdAt.getTime()).toBe(t1);
    // The export itself is still recorded at t0.
    const [row] = await db.select().from(billingUsageReports);
    expect(row!.exportedAt.getTime()).toBe(t0);
  });

  it('bundles exported before a retry created the subscription are sent at its start', async () => {
    await subscriber(ANNUAL);
    const r = reporter();
    await exportBundles(r, ANNUAL.account, 5);
    fake.failures.create.push('reject', 'reject');
    const [sixth, seventh] = await exportBundles(r, ANNUAL.account, 2);
    expect([sixth!.outcome.status, seventh!.outcome.status]).toEqual(['unreported', 'unreported']);

    const t1 = OCT_15 + 30 * MINUTE;
    now = t1;
    stripeNow = t1;
    expect(await r.retryPending()).toMatchObject({ status: 'done', reported: 2, failed: 0 });
    expect(fake.created).toHaveLength(1);
    expect(eventFor(sixth!.bundleId)!.timestamp).toBe(secs(t1));
    expect(eventFor(seventh!.bundleId)!.timestamp).toBe(secs(t1));
  });

  it('a later over-allowance bundle on the existing overage subscription is sent at its own export time', async () => {
    await subscriber(ANNUAL);
    const r = reporter();
    await exportBundles(r, ANNUAL.account, 5);
    stripeNow = OCT_15 + MINUTE;
    await exportBundle(r, ANNUAL.account);

    const t2 = OCT_15 + 3 * 60 * MINUTE;
    now = t2;
    stripeNow = t2 + 10 * MINUTE; // Stripe's clock is irrelevant once the subscription exists
    const seventh = await exportBundle(r, ANNUAL.account);
    expect(seventh.outcome).toMatchObject({ status: 'reported', subscription: 'sub_test_overage_1' });
    expect(eventFor(seventh.bundleId)!.timestamp).toBe(secs(t2));
    expect(fake.created).toHaveLength(1);
  });

  it('an existing link is read for the start: its created time, not the time of the report', async () => {
    await subscriber(ANNUAL);
    const start = OCT_15 + 60 * MINUTE;
    await db.insert(billingOverageSubscriptions).values({
      stripeSubscriptionId: ANNUAL.subscription, overageSubscriptionId: 'sub_test_overage_existing', createdAt: new Date(start),
    });
    const r = reporter();
    await exportBundles(r, ANNUAL.account, 5);
    const sixth = await exportBundle(r, ANNUAL.account);
    expect(sixth.outcome).toMatchObject({ status: 'reported', subscription: 'sub_test_overage_existing' });
    expect(eventFor(sixth.bundleId)!.timestamp).toBe(secs(start));
    expect(fake.created).toHaveLength(0);
  });

  it('the overage subscription is created once: only the metered price, no proration, no backdating, annual untouched', async () => {
    await subscriber(ANNUAL);
    const r = reporter();
    await exportBundles(r, ANNUAL.account, 5);
    stripeNow = OCT_15 + MINUTE;
    await exportBundles(r, ANNUAL.account, 3);

    expect(fake.created).toHaveLength(1);
    const { params } = fake.created[0]!;
    expect(params.items).toEqual([{ price: PRICE_OVERAGE }]);
    expect(params.proration_behavior).toBe('none');
    expect(params.default_payment_method).toBe(SAVED_PM);
    for (const backdate of ['backdate_start_date', 'billing_cycle_anchor', 'trial_end', 'start_date']) {
      expect(params).not.toHaveProperty(backdate);
    }
    expect(fake.forbidden).toEqual([]);
    expect(fake.annual.items).toEqual([{ price: PRICE_YEAR }]);
    expect(fake.meterCalls).toHaveLength(3);
  });
});

describe('the allowance still counts by export time', () => {
  it('a bundle exported on the last day of a month counts in that month, though its event is sent in the next', async () => {
    await subscriber(ANNUAL);
    const r = reporter();
    now = OCT_31_LATE;
    await exportBundles(r, ANNUAL.account, 5);
    fake.failures.create.push('reject');
    const sixth = await exportBundle(r, ANNUAL.account);
    expect(sixth.outcome).toMatchObject({ status: 'unreported', month: '2026-10', count: 6 });

    now = NOV_1;
    stripeNow = NOV_1;
    expect(await r.retryPending()).toMatchObject({ status: 'done', reported: 1 });
    expect(eventFor(sixth.bundleId)!.timestamp).toBe(secs(NOV_1));

    const exported = await db.select().from(billingBundleExports);
    expect(exported.filter((e) => e.month === '2026-10')).toHaveLength(6);
    expect(exported.filter((e) => e.month === '2026-11')).toHaveLength(0);
    // November's allowance is untouched by October's overage.
    const novFirst = await exportBundle(r, ANNUAL.account);
    expect(novFirst.outcome).toMatchObject({ status: 'included', month: '2026-11', count: 1 });
  });
});

describe('monthly subscriber', () => {
  it("the event timestamp is still the export time", async () => {
    await subscriber(MONTHLY);
    const r = reporter();
    await exportBundles(r, MONTHLY.account, 5);
    stripeNow = OCT_15 + 60 * MINUTE;
    const sixth = await exportBundle(r, MONTHLY.account);
    expect(sixth.outcome).toMatchObject({ status: 'reported', subscription: MONTHLY.subscription });
    expect(eventFor(sixth.bundleId)!.timestamp).toBe(secs(OCT_15));
    expect(fake.created).toHaveLength(0);
  });
});

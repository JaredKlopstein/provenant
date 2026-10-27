import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Stripe from 'stripe';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { openDb, closeDb, type Db } from '@lacre/core';
import {
  billingSchema, billingCustomers, billingSubscriptions, billingBundleCredits, billingWebhookEvents,
} from '../src/billing/schema.js';
import {
  createBillingWebhook, BILLING_WEBHOOK_PATH, type BillingWebhookOptions, type DuplicateGuardStripe,
} from '../src/billing/webhook.js';
import { createCustomerLookup, type BillingDb } from '../src/billing/store.js';
import { createCollector } from '../src/collector/server.js';
import { PRICE_ENV } from '../src/billing/config.js';
import type { StripeLike, SubscriptionLister } from '../src/billing/stripe.js';

/*
 * Every secret-shaped value is assembled at run time, so this file never holds
 * one; the repo-wide secret search in billing-setup.test.ts covers it. Fixture
 * events are built here and signed with Stripe's own test-header helper. No
 * test calls Stripe or a real database: Postgres is PGlite, in process.
 */
const u = (...parts: string[]) => parts.join('_');
const WEBHOOK_SECRET = u('whsec', 'w'.repeat(24));
const OTHER_SECRET = u('whsec', 'v'.repeat(24));
const DB_USER = 'test-db-user';
const DB_PASSWORD = 'test-db-password';
const DB_HOST = 'db.lacre.test';
const DATABASE_URL = ['postgresql:', '', `${DB_USER}:${DB_PASSWORD}@${DB_HOST}`, 'billing'].join('/');
const STRIPE_KEY = u('sk', 'test', 'k'.repeat(24));
const SECRETS = [WEBHOOK_SECRET, OTHER_SECRET, DATABASE_URL, DB_USER, DB_PASSWORD, DB_HOST, STRIPE_KEY];
const ENV = {
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, DATABASE_URL,
  STRIPE_SECRET_KEY: STRIPE_KEY, [PRICE_ENV.overage_bundle]: u('price', 'testoveragebundle'),
};

/** The duplicate-metered guard's Stripe, for a customer with no other
 *  subscription: it lists nothing, so it never cancels or refunds.
 *  billing-webhook-duplicate-metered.test.ts covers the guard itself. */
function noOtherSubscriptions(): DuplicateGuardStripe {
  const never = async (): Promise<never> => {
    throw new Error('the guard acted with no duplicate');
  };
  return {
    subscriptions: { list: async () => ({ data: [] }), cancel: never },
    invoices: { retrieve: never },
    refunds: { list: never, create: never },
  };
}

const PRICE_MONTH = u('price', 'testcloudmonth');
const PRICE_YEAR = u('price', 'testcloudyear');
const CUSTOMER = 'cus_test_alpha';
const OTHER_CUSTOMER = 'cus_test_beta';
const SUBSCRIPTION = 'sub_test_alpha';
const ACCOUNT = 'urn:lacre:agent:test-account-one';
const OTHER_ACCOUNT = 'urn:lacre:agent:test-account-two';

const MIGRATION = fileURLToPath(new URL('../migrations/0000_billing.sql', import.meta.url));
const SRC = fileURLToPath(new URL('../src', import.meta.url));

// 2026-10-01 and 2026-11-01, 2026-11-01 and 2027-11-01, UTC.
const OCT_1 = 1_790_812_800;
const NOV_1 = 1_793_491_200;
const NOV_1_NEXT_YEAR = 1_825_027_200;

// ---------------------------------------------------------------- fixtures --

let seq = 0;
function stripeEvent(type: string, object: Record<string, unknown>, id = `evt_test_${++seq}`) {
  return {
    id, object: 'event', type, api_version: '2026-09-30', created: OCT_1, livemode: false,
    pending_webhooks: 1, request: { id: null, idempotency_key: null }, data: { object },
  };
}

function subscriptionCheckout(o: { session?: string; customer?: string; ref?: string | null; interval?: 'month' | 'year' } = {}) {
  const interval = o.interval ?? 'month';
  return stripeEvent('checkout.session.completed', {
    id: o.session ?? 'cs_test_subscription', object: 'checkout.session', mode: 'subscription',
    payment_status: 'paid', status: 'complete', customer: o.customer ?? CUSTOMER, subscription: SUBSCRIPTION,
    payment_intent: null, client_reference_id: o.ref ?? null,
    metadata: { provenant_plan: 'cloud', provenant_interval: interval },
  });
}

function bundleCheckout(o: { session?: string; customer?: string; ref?: string | null; paid?: boolean } = {}) {
  return stripeEvent('checkout.session.completed', {
    id: o.session ?? 'cs_test_bundle', object: 'checkout.session', mode: 'payment',
    payment_status: o.paid === false ? 'unpaid' : 'paid', status: 'complete', customer: o.customer ?? CUSTOMER,
    subscription: null, payment_intent: 'pi_test_bundle', client_reference_id: o.ref ?? null,
    metadata: { provenant_purchase: 'payg_bundle' },
  });
}

function subscriptionObject(o: { interval?: 'month' | 'year'; status?: string; end?: number; customer?: string } = {}) {
  const interval = o.interval ?? 'month';
  return {
    id: SUBSCRIPTION, object: 'subscription', customer: o.customer ?? CUSTOMER, status: o.status ?? 'active',
    // Checkout's metadata is not updated when the plan switches in the
    // portal; the price is what the customer actually pays for.
    metadata: { provenant_plan: 'cloud', provenant_interval: 'month' },
    items: {
      object: 'list',
      data: [{
        id: 'si_test_alpha', object: 'subscription_item',
        current_period_start: NOV_1, current_period_end: o.end ?? NOV_1_NEXT_YEAR,
        price: { id: interval === 'year' ? PRICE_YEAR : PRICE_MONTH, object: 'price', recurring: { interval }, metadata: {} },
      }],
    },
  };
}

function invoiceObject(o: { subscription?: string | null; start?: number; end?: number } = {}) {
  return {
    id: 'in_test_alpha', object: 'invoice', customer: CUSTOMER,
    parent: o.subscription === null
      ? null
      : { type: 'subscription_details', quote_details: null, subscription_details: { subscription: o.subscription ?? SUBSCRIPTION, metadata: {} } },
    lines: {
      object: 'list',
      data: [{ id: 'il_test_alpha', object: 'line_item', period: { start: o.start ?? OCT_1, end: o.end ?? NOV_1 }, parent: { type: 'subscription_item_details' } }],
    },
  };
}

type Fixture = ReturnType<typeof stripeEvent>;

/** The request Stripe would send. The signature covers `payload` exactly. */
function signed(event: Fixture, o: { secret?: string; timestamp?: number; header?: string | null; payload?: string } = {}): Request {
  const payload = o.payload ?? JSON.stringify(event);
  const header = o.header !== undefined
    ? o.header
    : Stripe.webhooks.generateTestHeaderString({
        payload: JSON.stringify(event),
        secret: o.secret ?? WEBHOOK_SECRET,
        ...(o.timestamp ? { timestamp: o.timestamp } : {}),
      });
  return new Request(`https://lacre.test${BILLING_WEBHOOK_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(header === null ? {} : { 'stripe-signature': header }) },
    body: payload,
  });
}

// ---------------------------------------------------------------- database --

let pg: PGlite;
let db: BillingDb;

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(readFileSync(MIGRATION, 'utf8'));
  db = drizzle({ client: pg, schema: billingSchema });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(
    'TRUNCATE billing_webhook_events, billing_bundle_credits, billing_subscriptions, billing_customers RESTART IDENTITY',
  );
});

async function rows() {
  return {
    customers: await db.select().from(billingCustomers).orderBy(billingCustomers.id),
    subscriptions: await db.select().from(billingSubscriptions),
    credits: await db.select().from(billingBundleCredits),
    events: await db.select().from(billingWebhookEvents),
  };
}

async function counts() {
  const r = await rows();
  return { customers: r.customers.length, subscriptions: r.subscriptions.length, credits: r.credits.length, events: r.events.length };
}

const EMPTY = { customers: 0, subscriptions: 0, credits: 0, events: 0 };

function webhook(overrides: Partial<BillingWebhookOptions> = {}) {
  const warnings: string[] = [];
  const errors: string[] = [];
  const connect = vi.fn(() => db);
  const w = createBillingWebhook({
    env: ENV,
    stripe: noOtherSubscriptions(),
    connect,
    log: { warn: (l) => warnings.push(l), error: (l) => errors.push(l) },
    ...overrides,
  });
  return { ...w, warnings, errors, connect };
}

async function deliver(w: ReturnType<typeof webhook>, event: Fixture, o: Parameters<typeof signed>[1] = {}) {
  const res = await w.webhook(signed(event, o));
  return { status: res.status, body: (await res.json()) as { ok?: boolean; result?: { duplicate: boolean; handled: boolean }; error?: { code: string } } };
}

// ------------------------------------------------------------------- tests --

describe('signature verification on the raw body', () => {
  it('accepts an event signed with the webhook secret', async () => {
    const w = webhook();
    const res = await deliver(w, subscriptionCheckout());
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ handled: true, duplicate: false });
    expect(await counts()).toMatchObject({ customers: 1, subscriptions: 1, events: 1 });
  });

  it.each([
    ['signed with another secret', () => ({ secret: OTHER_SECRET })],
    ['missing its signature header', () => ({ header: null })],
    ['carrying a garbage signature header', () => ({ header: 't=1,v1=00' })],
    ['signed more than five minutes ago', () => ({ timestamp: Math.floor(Date.now() / 1000) - 10 * 60 })],
    ['re-serialized after signing', (event: Fixture) => ({ payload: JSON.stringify(event, null, 2) })],
  ])('rejects an event %s with 400, never opening the database', async (_label, options) => {
    const w = webhook();
    const event = subscriptionCheckout();
    const res = await deliver(w, event, options(event));
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('SIGNATURE_INVALID');
    expect(w.connect).not.toHaveBeenCalled();
    expect(await counts()).toEqual(EMPTY);
  });

  it('refuses anything but POST', async () => {
    const w = webhook();
    const res = await w.webhook(new Request(`https://lacre.test${BILLING_WEBHOOK_PATH}`));
    expect(res.status).toBe(405);
    expect(await counts()).toEqual(EMPTY);
  });

  it('will not build without STRIPE_WEBHOOK_SECRET and DATABASE_URL, naming them and no value', () => {
    expect(() => createBillingWebhook({ env: {} })).toThrow(/STRIPE_WEBHOOK_SECRET.*DATABASE_URL|DATABASE_URL.*STRIPE_WEBHOOK_SECRET/s);
  });
});

describe('fixture events', () => {
  it('completed subscription checkout creates the customer and an active subscription', async () => {
    const w = webhook();
    expect((await deliver(w, subscriptionCheckout({ interval: 'year' }))).status).toBe(200);
    const r = await rows();
    expect(r.customers).toEqual([expect.objectContaining({ stripeCustomerId: CUSTOMER, accountId: null })]);
    expect(r.subscriptions).toEqual([
      expect.objectContaining({
        stripeSubscriptionId: SUBSCRIPTION, stripeCustomerId: CUSTOMER, plan: 'cloud', interval: 'year', status: 'active',
      }),
    ]);
    expect(r.credits).toEqual([]);
  });

  it('completed one-time bundle checkout creates the customer and one bundle credit', async () => {
    const w = webhook();
    expect((await deliver(w, bundleCheckout())).status).toBe(200);
    const r = await rows();
    expect(r.customers).toHaveLength(1);
    expect(r.subscriptions).toEqual([]);
    expect(r.credits).toEqual([
      expect.objectContaining({
        stripeCheckoutSessionId: 'cs_test_bundle', stripeCustomerId: CUSTOMER, stripePaymentIntentId: 'pi_test_bundle', credits: 1,
      }),
    ]);
  });

  it('credits nothing for a bundle checkout that is not paid yet', async () => {
    const w = webhook();
    expect((await deliver(w, bundleCheckout({ paid: false }))).status).toBe(200);
    expect((await rows()).credits).toEqual([]);
  });

  it('subscription updated changes the interval, price and status, and records the period', async () => {
    const w = webhook();
    await deliver(w, subscriptionCheckout());
    await deliver(w, stripeEvent('customer.subscription.updated', subscriptionObject({ interval: 'year' })));
    let [sub] = (await rows()).subscriptions;
    expect(sub).toMatchObject({ interval: 'year', status: 'active', stripePriceId: PRICE_YEAR });
    expect(sub!.currentPeriodStart).toEqual(new Date(NOV_1 * 1000));
    expect(sub!.currentPeriodEnd).toEqual(new Date(NOV_1_NEXT_YEAR * 1000));

    await deliver(w, stripeEvent('customer.subscription.updated', subscriptionObject({ interval: 'year', status: 'past_due' })));
    [sub] = (await rows()).subscriptions;
    expect(sub).toMatchObject({ interval: 'year', status: 'past_due' });
  });

  it('subscription updated before checkout completes records the subscription, and checkout then keeps it', async () => {
    const w = webhook();
    await deliver(w, stripeEvent('customer.subscription.updated', subscriptionObject({ interval: 'year' })));
    await deliver(w, subscriptionCheckout({ interval: 'month' }));
    expect((await rows()).subscriptions).toEqual([expect.objectContaining({ interval: 'year', stripePriceId: PRICE_YEAR })]);
  });

  it('subscription deleted marks it canceled', async () => {
    const w = webhook();
    await deliver(w, subscriptionCheckout());
    await deliver(w, stripeEvent('customer.subscription.deleted', subscriptionObject({ status: 'canceled' })));
    expect((await rows()).subscriptions).toEqual([expect.objectContaining({ status: 'canceled' })]);
  });

  it('invoice paid records the period it paid for', async () => {
    const w = webhook();
    await deliver(w, subscriptionCheckout());
    expect((await deliver(w, stripeEvent('invoice.paid', invoiceObject({ start: NOV_1, end: NOV_1_NEXT_YEAR })))).status).toBe(200);
    expect((await rows()).subscriptions).toEqual([
      expect.objectContaining({
        status: 'active', currentPeriodStart: new Date(NOV_1 * 1000), currentPeriodEnd: new Date(NOV_1_NEXT_YEAR * 1000),
      }),
    ]);
  });

  it('payment failed marks it past_due', async () => {
    const w = webhook();
    await deliver(w, subscriptionCheckout());
    expect((await deliver(w, stripeEvent('invoice.payment_failed', invoiceObject()))).status).toBe(200);
    expect((await rows()).subscriptions).toEqual([expect.objectContaining({ status: 'past_due' })]);
  });

  it('an invoice for a subscription not recorded yet writes nothing and asks Stripe to retry, and the retry applies', async () => {
    const w = webhook();
    const paid = stripeEvent('invoice.paid', invoiceObject());
    const first = await deliver(w, paid);
    expect(first.status).toBe(409);
    expect(await counts()).toEqual(EMPTY);

    await deliver(w, subscriptionCheckout());
    expect((await deliver(w, paid)).status).toBe(200);
    expect((await rows()).subscriptions[0]!.currentPeriodEnd).toEqual(new Date(NOV_1 * 1000));
  });

  it('acknowledges an invoice with no subscription, and an event type it does not handle, writing nothing', async () => {
    const w = webhook();
    expect((await deliver(w, stripeEvent('invoice.paid', invoiceObject({ subscription: null })))).status).toBe(200);
    expect(await counts()).toMatchObject({ customers: 0, subscriptions: 0, credits: 0 });

    await pg.exec('TRUNCATE billing_webhook_events');
    const other = await deliver(w, stripeEvent('customer.created', { id: CUSTOMER, object: 'customer' }));
    expect(other.status).toBe(200);
    expect(other.body.result).toMatchObject({ handled: false });
    expect(await counts()).toEqual(EMPTY);
  });
});

describe('replaying an event id is a no-op', () => {
  it.each([
    ['a subscription checkout', [], () => subscriptionCheckout({ ref: ACCOUNT })],
    ['a bundle checkout', [], () => bundleCheckout({ ref: ACCOUNT })],
    ['an invoice payment', [subscriptionCheckout], () => stripeEvent('invoice.paid', invoiceObject())],
    ['a subscription update', [subscriptionCheckout], () => stripeEvent('customer.subscription.updated', subscriptionObject({ interval: 'year' }))],
  ])('%s, delivered twice, writes once', async (_label, before: Array<() => Fixture>, make) => {
    const w = webhook();
    for (const b of before) await deliver(w, b());
    const event = make();
    expect((await deliver(w, event)).body.result).toMatchObject({ duplicate: false });
    const after = await rows();

    const again = await deliver(w, event);
    expect(again.status).toBe(200);
    expect(again.body.result).toMatchObject({ duplicate: true });
    expect(await rows()).toEqual(after);
  });

  it('never credits one bundle checkout twice, even under a second event id', async () => {
    const w = webhook();
    await deliver(w, bundleCheckout());
    await deliver(w, bundleCheckout());
    expect(await counts()).toMatchObject({ credits: 1, customers: 1, events: 2 });
  });

  it('a late replay cannot undo a later change', async () => {
    const w = webhook();
    await deliver(w, subscriptionCheckout());
    const updated = stripeEvent('customer.subscription.updated', subscriptionObject({ status: 'active' }));
    await deliver(w, updated);
    await deliver(w, stripeEvent('customer.subscription.deleted', subscriptionObject({ status: 'canceled' })));
    expect((await deliver(w, updated)).body.result).toMatchObject({ duplicate: true });
    expect((await rows()).subscriptions[0]!.status).toBe('canceled');
  });
});

describe('account link from client_reference_id', () => {
  it('links a new customer on its first completed checkout', async () => {
    const w = webhook();
    await deliver(w, subscriptionCheckout({ ref: ACCOUNT }));
    expect((await rows()).customers).toEqual([expect.objectContaining({ stripeCustomerId: CUSTOMER, accountId: ACCOUNT })]);
    expect(w.warnings).toEqual([]);
  });

  it('links an existing customer whose link is empty', async () => {
    const w = webhook();
    await deliver(w, stripeEvent('customer.subscription.updated', subscriptionObject()));
    expect((await rows()).customers[0]!.accountId).toBeNull();
    await deliver(w, bundleCheckout({ ref: ACCOUNT }));
    expect((await rows()).customers).toEqual([expect.objectContaining({ stripeCustomerId: CUSTOMER, accountId: ACCOUNT })]);
    expect(w.warnings).toEqual([]);
  });

  it('lets the billing portal find the linked customer by the caller agent id', async () => {
    const w = webhook();
    await deliver(w, subscriptionCheckout({ ref: ACCOUNT }));
    const lookup = createCustomerLookup(db);
    expect(await lookup.stripeCustomerId({ keyId: 'k', agentId: ACCOUNT })).toBe(CUSTOMER);
    expect(await lookup.stripeCustomerId({ keyId: 'k', agentId: OTHER_ACCOUNT })).toBeNull();
  });

  it('never overwrites a link: a second checkout for the customer with another account changes nothing', async () => {
    const w = webhook();
    await deliver(w, subscriptionCheckout({ ref: ACCOUNT }));
    const before = (await rows()).customers;

    const res = await deliver(w, bundleCheckout({ ref: OTHER_ACCOUNT }));
    expect(res.status).toBe(200);
    expect((await rows()).customers).toEqual(before);
    expectOneRedactedWarning(w.warnings);
  });

  it('never moves an account: a new customer naming an already-linked account changes no row', async () => {
    const w = webhook();
    await deliver(w, subscriptionCheckout({ ref: ACCOUNT }));
    const before = (await rows()).customers;

    const res = await deliver(w, bundleCheckout({ customer: OTHER_CUSTOMER, ref: ACCOUNT, session: 'cs_test_other' }));
    expect(res.status).toBe(200);
    const after = (await rows()).customers;
    // Every existing row is unchanged; the new customer is recorded, so its
    // purchase is not lost, with no link.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual([expect.objectContaining({ stripeCustomerId: OTHER_CUSTOMER, accountId: null })]);
    expectOneRedactedWarning(w.warnings);
  });

  function expectOneRedactedWarning(warnings: string[]) {
    expect(warnings).toHaveLength(1);
    for (const id of [ACCOUNT, OTHER_ACCOUNT, CUSTOMER, OTHER_CUSTOMER]) {
      expect(warnings[0], 'an id leaked into the warning').not.toContain(id);
    }
    expect(warnings[0]).toMatch(/already linked/);
  }
});

describe('plan state changes only through verified webhooks', () => {
  const u2 = (...p: string[]) => p.join('_');
  const prices = Object.fromEntries(Object.values(PRICE_ENV).map((name) => [name, u2('price', name.toLowerCase().replace(/_/g, ''))]));
  const billingEnv = { STRIPE_SECRET_KEY: u2('sk', 'test', 'x'.repeat(24)), ...prices };
  const stripe: StripeLike & SubscriptionLister = {
    checkout: { sessions: { create: async () => ({ id: 'cs_test_route', url: 'https://checkout.stripe.test/1' }) } },
    billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.test/1' }) } },
    subscriptions: { list: async () => ({ data: [] }) },
  };

  let coreDb: Db;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    coreDb = openDb(':memory:');
    server = createCollector({
      db: coreDb,
      billing: {
        env: billingEnv, stripe, customers: createCustomerLookup(db),
        successUrl: 'https://lacre.test/ok', cancelUrl: 'https://lacre.test/no', returnUrl: 'https://lacre.test/a',
        log: () => {},
      },
      billingWebhook: { env: ENV, stripe: noOtherSubscriptions(), connect: () => db, log: { warn: () => {}, error: () => {} } },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    closeDb(coreDb);
  });

  async function post(path: string, body: string, headers: Record<string, string> = {}) {
    return fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  }

  it('the collector applies a signed event from the raw body it received', async () => {
    const event = subscriptionCheckout({ ref: ACCOUNT });
    const payload = JSON.stringify(event);
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const res = await post(BILLING_WEBHOOK_PATH, payload, { 'stripe-signature': header });
    expect(res.status).toBe(200);
    expect(await counts()).toMatchObject({ customers: 1, subscriptions: 1 });
  });

  it('no route lets a client set its own plan', async () => {
    const forged = JSON.stringify(stripeEvent('customer.subscription.updated', subscriptionObject({ interval: 'year' })));
    const attempts = [
      await post(BILLING_WEBHOOK_PATH, forged),
      await post(BILLING_WEBHOOK_PATH, forged, { 'stripe-signature': 't=1,v1=00' }),
      await post('/billing/checkout', JSON.stringify({ plan: 'cloud', interval: 'year', client_reference_id: ACCOUNT })),
      await post('/billing/subscription', JSON.stringify({ plan: 'cloud', status: 'active' })),
      await post('/billing/plan', JSON.stringify({ plan: 'enterprise' })),
      await post('/billing/portal', JSON.stringify({ plan: 'cloud' })),
    ];
    expect(attempts.map((r) => r.status)).toEqual([400, 400, 200, 401, 401, 401]);
    expect(await counts()).toEqual(EMPTY);
  });

  it('only the webhook writes the billing tables', () => {
    const files = walk(SRC);
    const written = (f: string) => [...readFileSync(f, 'utf8').matchAll(/\.(?:insert|update|delete)\((billing\w*)/g)].map((m) => m[1]);
    const writers = files.filter((f) => written(f).length > 0);
    // Overage reporting (#28) writes its own usage tables, and never plan state.
    expect(writers.map((f) => relative(SRC, f))).toEqual([join('billing', 'overage.ts'), join('billing', 'store.ts')]);
    const overage = new Set(written(join(SRC, 'billing', 'overage.ts')));
    expect([...overage].sort()).toEqual(['billingBundleExports', 'billingOverageSubscriptions', 'billingUsageReports']);
    const writeFns = /\b(applyEventOnce|linkCustomer|saveSubscription|updateSubscription|creditBundle|ensureCustomer)\b/;
    const callers = files.filter((f) => !f.endsWith(join('billing', 'store.ts')) && writeFns.test(readFileSync(f, 'utf8')));
    expect(callers.map((f) => relative(SRC, f))).toEqual([join('billing', 'webhook.ts')]);
  });
});

describe('migration', () => {
  const tables = [billingCustomers, billingSubscriptions, billingBundleCredits, billingWebhookEvents] as PgTable[];

  it('applies cleanly to a fresh in-process Postgres and matches the drizzle schema', async () => {
    const fresh = await PGlite.create();
    try {
      await fresh.exec(readFileSync(MIGRATION, 'utf8'));
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
          ...config.foreignKeys.map((fk) => fk.getName()),
        ].sort();
        expect(constraints.map((c) => c.constraint_name), config.name).toEqual(expected);
      }
    } finally {
      await fresh.close();
    }
  });

  it('is never run automatically: nothing in cloud reads the migrations or calls a migrator', () => {
    const files = [...walk(SRC), fileURLToPath(new URL('../bin/lacre-cloud.mjs', import.meta.url))];
    // Code only: the schema's doc comment names the migration on purpose.
    const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const offenders = files.filter((f) => /migrations|0000_billing|\bmigrate\s*\(|\/migrator['"]/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('adds no billing table to core', () => {
    const core = fileURLToPath(new URL('../../core/migrations', import.meta.url));
    const sql = readdirSync(core).filter((f) => f.endsWith('.sql')).map((f) => readFileSync(join(core, f), 'utf8')).join('\n');
    expect(sql).not.toMatch(/billing_/);
  });
});

describe('redaction', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Everything a request could leak: its body, its header, and every secret. */
  function forbidden(event: Fixture, request: Request) {
    return [JSON.stringify(event), request.headers.get('stripe-signature') ?? '', ...SECRETS];
  }

  function expectClean(lines: string[], leaks: string[]) {
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      for (const s of leaks.filter(Boolean)) expect(line, 'a secret, payload or header leaked').not.toContain(s);
      for (const id of [CUSTOMER, SUBSCRIPTION, ACCOUNT, 'cs_test_subscription']) expect(line, 'an id leaked').not.toContain(id);
    }
  }

  it('a failing database: the log names the failure, never the URL, payload, header or ids', async () => {
    const event = subscriptionCheckout({ ref: ACCOUNT });
    const request = signed(event);
    const w = webhook({
      connect: () => {
        throw new Error(`connect ECONNREFUSED ${DATABASE_URL} (host ${DB_HOST}, user ${DB_USER}, password ${DB_PASSWORD})`);
      },
    });
    const res = await w.webhook(request);
    expect(res.status).toBe(500);
    expect(w.errors[0]).toMatch(/ECONNREFUSED/);
    expectClean(w.errors, forbidden(event, request));
    expect(await res.text()).not.toMatch(/ECONNREFUSED/);
  });

  it('a failing query: drizzle lists the parameters in its message, and none of them is logged', async () => {
    const empty = await PGlite.create(); // no migration: every query fails
    try {
      const event = subscriptionCheckout({ ref: ACCOUNT });
      const request = signed(event);
      const w = webhook({ connect: () => drizzle({ client: empty, schema: billingSchema }) });
      expect((await w.webhook(request)).status).toBe(500);
      expect(w.errors[0]).toMatch(/does not exist/);
      expectClean(w.errors, [...forbidden(event, request), event.id]);
    } finally {
      await empty.close();
    }
  });

  it('a bad signature and a link mismatch, through the default console log, leak nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = createBillingWebhook({ env: ENV, stripe: noOtherSubscriptions(), connect: () => db });

    const forged = subscriptionCheckout({ ref: ACCOUNT });
    const bad = signed(forged, { secret: OTHER_SECRET });
    expect((await w.webhook(bad)).status).toBe(400);

    await w.webhook(signed(subscriptionCheckout({ ref: ACCOUNT })));
    const mismatch = bundleCheckout({ ref: OTHER_ACCOUNT });
    const request = signed(mismatch);
    expect((await w.webhook(request)).status).toBe(200);

    const lines = [...warn.mock.calls, ...error.mock.calls].map((args) => args.map(String).join(' '));
    expect(lines).toHaveLength(2);
    expectClean(lines, [...forbidden(forged, bad), ...forbidden(mismatch, request), OTHER_ACCOUNT]);
  });
});

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (full.endsWith('.ts')) files.push(full);
  }
  return files;
}

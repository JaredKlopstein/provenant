import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { billingSchema, billingCustomers, billingSubscriptions, billingWebhookEvents } from '../src/billing/schema.js';
import { BILLING_WEBHOOK_PATH, type BillingWebhookOptions, type DuplicateGuardStripe } from '../src/billing/webhook.js';
import type { BillingDb } from '../src/billing/store.js';
import { PRICE_ENV } from '../src/billing/config.js';
import { POST, createBillingWebhookRoute } from '../api/billing/webhook.js';

/*
 * The mounted Stripe webhook (#90): the Vercel function in api/billing/webhook.ts
 * and the vercel.json rewrite from the documented path. Events are signed with
 * Stripe's own test-header helper and a test secret; Postgres is PGlite, in
 * process; nothing calls Stripe. Every secret-shaped value is assembled at run
 * time, so this file never holds one (billing-setup.test.ts searches the repo).
 */
const u = (...parts: string[]) => parts.join('_');
const WEBHOOK_SECRET = u('whsec', 'r'.repeat(24));
const OTHER_SECRET = u('whsec', 'q'.repeat(24));
const DATABASE_URL = ['postgresql:', '', 'route-db-user:route-db-password@db.route.test', 'billing'].join('/');
const TEST_KEY = u('sk', 'test', 'r'.repeat(24));
const LIVE_KEY = u('sk', 'live', 'r'.repeat(24));
const OVERAGE_PRICE = u('price', 'testoveragebundle');
const SECRETS = [WEBHOOK_SECRET, OTHER_SECRET, DATABASE_URL, TEST_KEY, LIVE_KEY, 'route-db-password'];
const ENV = {
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  DATABASE_URL,
  STRIPE_SECRET_KEY: TEST_KEY,
  [PRICE_ENV.overage_bundle]: OVERAGE_PRICE,
};

const CUSTOMER = 'cus_test_route';
const SUBSCRIPTION = 'sub_test_route';
const PRICE_MONTH = u('price', 'testcloudmonth');
// 2026-11-01 and 2026-12-01, UTC.
const NOV_1 = 1_793_491_200;
const DEC_1 = 1_796_083_200;

const MIGRATIONS = ['0000_billing.sql', '0001_overage.sql', '0002_overage_retry.sql'].map((f) =>
  fileURLToPath(new URL(`../migrations/${f}`, import.meta.url)),
);
const ROUTE_FILE = fileURLToPath(new URL('../api/billing/webhook.ts', import.meta.url));
const VERCEL_JSON = fileURLToPath(new URL('../vercel.json', import.meta.url));

/** The duplicate-metered guard's Stripe, for a customer with no other subscription. */
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

let seq = 0;
/** A completed subscription checkout: the event that records the subscription. */
function checkoutEvent() {
  return {
    id: `evt_test_route_${++seq}`, object: 'event', type: 'checkout.session.completed', api_version: '2026-09-30',
    created: NOV_1, livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: 'cs_test_route', object: 'checkout.session', mode: 'subscription', payment_status: 'paid', status: 'complete',
        customer: CUSTOMER, subscription: SUBSCRIPTION, payment_intent: null, client_reference_id: null,
        metadata: { provenant_plan: 'cloud', provenant_interval: 'month' },
      },
    },
  };
}

function subscriptionEvent(type: 'customer.subscription.created' | 'customer.subscription.updated', status: string) {
  return {
    id: `evt_test_route_${++seq}`, object: 'event', type, api_version: '2026-09-30', created: NOV_1, livemode: false,
    pending_webhooks: 1, request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: SUBSCRIPTION, object: 'subscription', customer: CUSTOMER, status,
        metadata: { provenant_plan: 'cloud', provenant_interval: 'month' },
        items: {
          object: 'list',
          data: [{
            id: 'si_test_route', object: 'subscription_item', current_period_start: NOV_1, current_period_end: DEC_1,
            price: { id: PRICE_MONTH, object: 'price', recurring: { interval: 'month' }, metadata: {} },
          }],
        },
      },
    },
  };
}

/** What Stripe sends: the signature covers `payload`, byte for byte. */
function signed(payload: string, o: { secret?: string; header?: string | null; path?: string; body?: string } = {}): Request {
  const header = o.header !== undefined
    ? o.header
    : Stripe.webhooks.generateTestHeaderString({ payload, secret: o.secret ?? WEBHOOK_SECRET });
  return new Request(`https://cloud.example${o.path ?? '/api/billing/webhook'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(header === null ? {} : { 'stripe-signature': header }) },
    body: o.body ?? payload,
  });
}

let pg: PGlite;
let db: BillingDb;
let logged: string[];

beforeAll(async () => {
  pg = await PGlite.create();
  for (const migration of MIGRATIONS) await pg.exec(readFileSync(migration, 'utf8'));
  db = drizzle({ client: pg, schema: billingSchema });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec('TRUNCATE billing_webhook_events, billing_bundle_credits, billing_subscriptions, billing_customers RESTART IDENTITY CASCADE');
  logged = [];
  for (const level of ['error', 'warn', 'log', 'info', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function route(overrides: Partial<BillingWebhookOptions> = {}) {
  const connect = vi.fn(() => db);
  const handler = createBillingWebhookRoute({
    env: ENV,
    stripe: noOtherSubscriptions(),
    connect,
    log: { warn: (l) => logged.push(l), error: (l) => logged.push(l) },
    ...overrides,
  });
  return { handler, connect };
}

async function state() {
  return {
    customers: (await db.select().from(billingCustomers)).length,
    subscriptions: await db.select().from(billingSubscriptions),
    events: (await db.select().from(billingWebhookEvents)).length,
  };
}

describe('mounted route', () => {
  it('is a Vercel function at api/billing/webhook.ts exporting POST, and nothing for GET', async () => {
    expect(existsSync(ROUTE_FILE)).toBe(true);
    const mod = await import('../api/billing/webhook.js');
    expect(typeof mod.POST).toBe('function');
    expect('GET' in mod).toBe(false);
  });

  it('vercel.json rewrites the documented path, BILLING_WEBHOOK_PATH, to that function', () => {
    const config = JSON.parse(readFileSync(VERCEL_JSON, 'utf8')) as { rewrites?: Array<{ source: string; destination: string }> };
    const rewrite = config.rewrites?.find((r) => r.source === BILLING_WEBHOOK_PATH);
    expect(rewrite?.destination).toBe('/api/billing/webhook');
    expect(existsSync(fileURLToPath(new URL(`..${rewrite!.destination}.ts`, import.meta.url)))).toBe(true);
  });

  it('serves a request addressed to the documented path the same way', async () => {
    const { handler } = route();
    const res = await handler(signed(JSON.stringify(checkoutEvent()), { path: BILLING_WEBHOOK_PATH }));
    expect(res.status).toBe(200);
    expect((await state()).subscriptions).toHaveLength(1);
  });
});

describe('a validly signed test event', () => {
  it('is processed and persists the subscription, then its change', async () => {
    const { handler } = route();
    const checkout = await handler(signed(JSON.stringify(checkoutEvent())));
    expect(checkout.status).toBe(200);
    let s = await state();
    expect(s.customers).toBe(1);
    expect(s.subscriptions).toHaveLength(1);
    expect(s.subscriptions[0]).toMatchObject({ stripeSubscriptionId: SUBSCRIPTION, stripeCustomerId: CUSTOMER, plan: 'cloud', interval: 'month' });

    const updated = await handler(signed(JSON.stringify(subscriptionEvent('customer.subscription.updated', 'past_due'))));
    expect(updated.status).toBe(200);
    s = await state();
    expect(s.subscriptions).toHaveLength(1);
    expect(s.subscriptions[0]!.status).toBe('past_due');
    expect(s.events).toBe(2);
  });

  it('is verified on the raw body: a payload signed with its own whitespace is accepted as sent', async () => {
    const { handler } = route();
    // Pretty-printed bytes: JSON parsed and re-serialized would no longer match the signature.
    const payload = JSON.stringify(checkoutEvent(), null, 2);
    expect((await handler(signed(payload))).status).toBe(200);
    expect((await state()).subscriptions).toHaveLength(1);
  });
});

describe('a missing or invalid signature', () => {
  const event = () => JSON.stringify(subscriptionEvent('customer.subscription.created', 'active'));

  it.each<[string, (payload: string) => Request]>([
    ['no Stripe-Signature header', (p) => signed(p, { header: null })],
    ['a signature from another secret', (p) => signed(p, { secret: OTHER_SECRET })],
    ['a malformed header', (p) => signed(p, { header: 't=1,v1=00' })],
    ['a body re-serialized after signing', (p) => signed(JSON.stringify(JSON.parse(p), null, 2), { header: Stripe.webhooks.generateTestHeaderString({ payload: p, secret: WEBHOOK_SECRET }) })],
    ['a body changed after signing', (p) => signed(p, { body: p.replace('"active"', '"canceled"') })],
    ['a signature older than the tolerance', (p) => signed(p, { header: Stripe.webhooks.generateTestHeaderString({ payload: p, secret: WEBHOOK_SECRET, timestamp: Math.floor(Date.now() / 1000) - 3600 }) })],
  ])('%s gets 400, changes no state and never opens the database', async (_, request) => {
    const { handler, connect } = route();
    const res = await handler(request(event()));
    expect(res.status).toBe(400);
    expect(connect).not.toHaveBeenCalled();
    expect(await state()).toEqual({ customers: 0, subscriptions: [], events: 0 });
  });
});

describe('configuration and secrets', () => {
  it('answers a generic 500 with a request id, the variable only in the log, and recovers once it is set', async () => {
    const env: Record<string, string | undefined> = { ...ENV, STRIPE_WEBHOOK_SECRET: undefined };
    const { handler, connect } = route({ env });
    const res = await handler(signed(JSON.stringify(subscriptionEvent('customer.subscription.created', 'active'))));
    expect(res.status).toBe(500);
    const body = await res.text();
    const parsed = JSON.parse(body);
    expect(parsed.error.code).toBe('BILLING_NOT_CONFIGURED');
    expect(parsed.error.message).toBe('Billing is not available right now.');
    expect(parsed.error.fix.note).not.toMatch(/Set the named variables/);
    const headers = JSON.stringify([...res.headers]);
    for (const exposed of [body, headers]) expect(exposed).not.toMatch(/STRIPE_|PROVENANT_|DATABASE_URL|CRON_SECRET/);
    const requestId = res.headers.get('x-request-id');
    expect(requestId).toBeTruthy();
    expect(parsed.requestId).toBe(requestId);
    const line = logged.find((l) => l.includes(requestId!));
    expect(line).toContain('STRIPE_WEBHOOK_SECRET');
    expect(connect).not.toHaveBeenCalled();
    for (const secret of SECRETS) expect(body).not.toContain(secret);

    // Not cached as a failure: the next request after the fix is processed.
    env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    expect((await handler(signed(JSON.stringify(subscriptionEvent('customer.subscription.created', 'active'))))).status).toBe(200);
  });

  it('stays in test mode: a live key without PROVENANT_BILLING_MODE=live is refused, and nothing is processed', async () => {
    const { handler, connect } = route({ env: { ...ENV, STRIPE_SECRET_KEY: LIVE_KEY } });
    const res = await handler(signed(JSON.stringify(subscriptionEvent('customer.subscription.created', 'active'))));
    expect(res.status).toBe(500);
    expect(connect).not.toHaveBeenCalled();
    expect(await res.text()).not.toContain(LIVE_KEY);
  });

  it('the deployed POST reads process.env and, with nothing set, refuses without touching anything', async () => {
    for (const name of ['STRIPE_WEBHOOK_SECRET', 'DATABASE_URL', 'STRIPE_SECRET_KEY', PRICE_ENV.overage_bundle]) vi.stubEnv(name, '');
    const res = await POST(signed(JSON.stringify(subscriptionEvent('customer.subscription.created', 'active'))));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('BILLING_NOT_CONFIGURED');
  });

  it('never puts a secret value in a response or a log line', async () => {
    const { handler } = route();
    const payload = JSON.stringify(subscriptionEvent('customer.subscription.created', 'active'));
    const responses = [
      await handler(signed(payload)),
      await handler(signed(payload, { secret: OTHER_SECRET })),
      await handler(signed(payload, { header: null })),
      await route({ env: { ...ENV, DATABASE_URL: undefined } }).handler(signed(payload)),
      await route({ env: { ...ENV, STRIPE_SECRET_KEY: LIVE_KEY } }).handler(signed(payload)),
    ];
    const exposed = [...(await Promise.all(responses.map((r) => r.text()))), ...logged].join('\n');
    for (const secret of SECRETS) expect(exposed).not.toContain(secret);
  });

  it('holds no secret-shaped value in the route source', () => {
    const src = readFileSync(ROUTE_FILE, 'utf8');
    expect(src).not.toMatch(/\b(whsec|sk_live|sk_test|rk_live|rk_test)_[A-Za-z0-9]/);
  });
});

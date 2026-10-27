/**
 * The webhook's guard against two subscriptions carrying the metered overage
 * price (#64). Meter events are scoped to the customer, so Stripe would bill
 * each overage bundle on both. Checkout refuses a second one, but two
 * checkouts opened at once both pass that check; the webhook catches them when
 * they complete: it refunds the newer one's paid charge in full, cancels it
 * with no proration, and logs one redacted alert. Replays do nothing more.
 *
 * Stripe is the in-memory fake below, shared by checkout and the webhook: no
 * network. Postgres is PGlite, in process. Secret-shaped values are assembled
 * at run time, so this file never holds one.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { billingSchema, billingSubscriptions } from '../src/billing/schema.js';
import { createBillingWebhook, BILLING_WEBHOOK_PATH, type DuplicateGuardStripe } from '../src/billing/webhook.js';
import { createBillingRoutes } from '../src/billing/routes.js';
import { createCustomerLookup, type BillingDb } from '../src/billing/store.js';
import type { StripeLike, SubscriptionLister, SubscriptionSummary } from '../src/billing/stripe.js';
import { PRICE_ENV, type CatalogKey } from '../src/billing/config.js';

const u = (...parts: string[]) => parts.join('_');
const STRIPE_KEY = u('sk', 'test', 'd'.repeat(24));
const WEBHOOK_SECRET = u('whsec', 'd'.repeat(24));
const DATABASE_URL = ['postgresql:', '', 'test-user:test-password@db.lacre.test', 'billing'].join('/');
const PRICES: Record<CatalogKey, string> = {
  cloud_month: u('price', 'testcloudmonth'),
  cloud_year: u('price', 'testcloudyear'),
  extra_identity: u('price', 'testextraidentity'),
  payg_bundle: u('price', 'testpaygbundle'),
  overage_bundle: u('price', 'testoveragebundle'),
};
const ENV: Record<string, string> = {
  STRIPE_SECRET_KEY: STRIPE_KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, DATABASE_URL,
  ...Object.fromEntries((Object.entries(PRICE_ENV) as Array<[CatalogKey, string]>).map(([k, name]) => [name, PRICES[k]])),
};

const ACCOUNT = 'urn:lacre:agent:test-racing-account';
const CUSTOMER = 'cus_test_racer';
const FIRST = 'sub_test_first';
const SECOND = 'sub_test_second';
const FIRST_CHARGE = 'ch_test_first';
const SECOND_CHARGE = 'ch_test_second';
const OCT_1 = 1_790_812_800;

const MIGRATION = fileURLToPath(new URL('../migrations/0000_billing.sql', import.meta.url));

// ------------------------------------------------------------------- Stripe --

interface FakeSubscription extends SubscriptionSummary {
  customer: string;
  latest_invoice: string | null;
}

/** One Stripe account: checkout sessions, the subscriptions they become, their
 *  invoices and payments, and every refund and cancel asked of it. */
function fakeStripe() {
  const sessions: Array<Record<string, unknown> & { id: string }> = [];
  const subscriptions = new Map<string, FakeSubscription>();
  const invoices = new Map<string, Awaited<ReturnType<DuplicateGuardStripe['invoices']['retrieve']>>>();
  const refunds: Array<{ id: string; charge: string }> = [];
  const refundRequests: Array<{ params: Record<string, unknown>; idempotencyKey: string }> = [];
  const cancels: Array<{ id: string; params: Record<string, unknown> }> = [];
  /** When set, list() serves subscriptions as they were, as a lagging read would. */
  let staleList: FakeSubscription[] | null = null;

  const client: StripeLike & SubscriptionLister & DuplicateGuardStripe = {
    checkout: {
      sessions: {
        async create(params) {
          const id = `cs_test_race_${sessions.length + 1}`;
          sessions.push({ ...params, id });
          return { id, url: `https://checkout.stripe.test/${id}` };
        },
      },
    },
    billingPortal: { sessions: { async create() { return { url: 'https://billing.stripe.test/portal' }; } } },
    subscriptions: {
      async list(params) {
        const all = staleList ?? [...subscriptions.values()].map((s) => ({ ...s }));
        return { data: all.filter((s) => s.customer === params.customer && s.status === params.status) };
      },
      async cancel(id, params) {
        cancels.push({ id, params });
        const sub = subscriptions.get(id)!;
        sub.status = 'canceled';
        return { id, status: sub.status };
      },
    },
    invoices: {
      async retrieve(id) {
        return invoices.get(id)!;
      },
    },
    refunds: {
      async list(params) {
        return { data: refunds.filter((r) => r.charge === params.charge) };
      },
      async create(params, options) {
        refundRequests.push({ params, idempotencyKey: options.idempotencyKey });
        const refund = { id: `re_test_${refunds.length + 1}`, charge: String(params.charge) };
        refunds.push(refund);
        return refund;
      },
    },
  };

  /** Stripe completes a session: the subscription is created from its line
   *  items, and its first invoice is paid. */
  function complete(session: (typeof sessions)[number], o: { subscription: string; created: number; charge: string; viaIntent?: boolean }) {
    const invoice = `in_${o.subscription}`;
    const items = (session.line_items as Array<{ price: string }>).map((i) => ({ price: { id: i.price } }));
    subscriptions.set(o.subscription, {
      id: o.subscription, customer: CUSTOMER, status: 'active', created: o.created,
      metadata: session.metadata as Record<string, string>, items: { data: items }, latest_invoice: invoice,
    });
    invoices.set(invoice, {
      id: invoice,
      payments: {
        data: [{
          status: 'paid',
          payment: o.viaIntent
            ? { payment_intent: { id: `pi_${o.subscription}`, latest_charge: o.charge } }
            : { charge: o.charge },
        }],
      },
    });
  }

  return {
    client, sessions, subscriptions, refunds, refundRequests, cancels, complete,
    freezeList: () => { staleList = [...subscriptions.values()].map((s) => ({ ...s })); },
  };
}

// ----------------------------------------------------------------- webhook --

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
  await pg.exec('TRUNCATE billing_webhook_events, billing_bundle_credits, billing_subscriptions, billing_customers RESTART IDENTITY');
});

let seq = 0;
function stripeEvent(type: string, object: Record<string, unknown>, id = `evt_test_dup_${++seq}`) {
  return {
    id, object: 'event', type, api_version: '2026-08-26.dahlia', created: OCT_1, livemode: false,
    pending_webhooks: 1, request: { id: null, idempotency_key: null }, data: { object },
  };
}

function completedEvent(session: Record<string, unknown> & { id: string }, subscription: string) {
  return stripeEvent('checkout.session.completed', {
    id: session.id, object: 'checkout.session', mode: 'subscription', payment_status: 'paid', status: 'complete',
    customer: CUSTOMER, subscription, payment_intent: null, client_reference_id: session.client_reference_id ?? null,
    metadata: session.metadata,
  });
}

/** A subscription event carrying the subscription as the fake holds it now. */
function subscriptionEvent(type: string, sub: FakeSubscription) {
  return stripeEvent(type, {
    id: sub.id, object: 'subscription', customer: sub.customer, status: sub.status, metadata: sub.metadata,
    latest_invoice: sub.latest_invoice,
    items: {
      object: 'list',
      data: sub.items.data.map((item, i) => ({
        id: `si_test_${sub.id}_${i}`, object: 'subscription_item',
        current_period_start: OCT_1, current_period_end: OCT_1 + 31 * 86_400,
        price: { id: item.price.id, object: 'price', recurring: { interval: 'month' }, metadata: {} },
      })),
    },
  });
}

function harness() {
  const stripe = fakeStripe();
  const errors: string[] = [];
  const warnings: string[] = [];
  const hook = createBillingWebhook({
    env: ENV,
    stripe: stripe.client,
    connect: () => db,
    log: { warn: (l) => warnings.push(l), error: (l) => errors.push(l) },
  });
  const routes = createBillingRoutes({
    env: ENV,
    stripe: stripe.client,
    customers: createCustomerLookup(db),
    authenticate: () => ({ ok: false, reason: 'unused' }),
    successUrl: 'https://lacre.test/ok',
    cancelUrl: 'https://lacre.test/no',
    returnUrl: 'https://lacre.test/account',
    log: (l) => errors.push(l),
  });

  async function deliver(event: ReturnType<typeof stripeEvent>) {
    const payload = JSON.stringify(event);
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const res = await hook.webhook(new Request(`https://lacre.test${BILLING_WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      body: payload,
    }));
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as { result: { duplicate: boolean } };
  }

  async function checkout() {
    return routes.checkout(new Request('https://lacre.test/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'cloud', interval: 'month', client_reference_id: ACCOUNT }),
    }));
  }

  /** Two monthly checkouts opened at once: both pass the lookup, both complete. */
  async function race() {
    expect((await checkout()).status).toBe(200);
    expect((await checkout()).status).toBe(200);
    expect(stripe.sessions).toHaveLength(2);
    stripe.complete(stripe.sessions[0]!, { subscription: FIRST, created: OCT_1, charge: FIRST_CHARGE });
    stripe.complete(stripe.sessions[1]!, { subscription: SECOND, created: OCT_1 + 5, charge: SECOND_CHARGE, viaIntent: true });
    const first = completedEvent(stripe.sessions[0]!, FIRST);
    const second = completedEvent(stripe.sessions[1]!, SECOND);
    await deliver(first);
    await deliver(second);
    return { first, second };
  }

  return { stripe, errors, warnings, deliver, checkout, race };
}

function expectOneRedactedAlert(errors: string[]) {
  expect(errors).toHaveLength(1);
  const alert = errors[0]!;
  expect(alert).toMatch(/alert/);
  expect(alert).toContain(CUSTOMER);
  expect(alert).toContain(SECOND);
  expect(alert).toMatch(/refunded its paid charge in full/);
  for (const leak of [...Object.values(PRICES), STRIPE_KEY, WEBHOOK_SECRET, DATABASE_URL, SECOND_CHARGE, `pi_${SECOND}`, `in_${SECOND}`]) {
    expect(alert, 'the alert carries more than customer and subscription ids').not.toContain(leak);
  }
}

// ------------------------------------------------------------------- tests --

describe('two checkouts that race past the lookup', () => {
  it('both sessions carry the metered price, so both subscriptions would bill the same overage', async () => {
    const h = harness();
    expect((await h.checkout()).status).toBe(200);
    expect((await h.checkout()).status).toBe(200);
    for (const s of h.stripe.sessions) {
      expect(s.line_items).toEqual([{ price: PRICES.cloud_month, quantity: 1 }, { price: PRICES.overage_bundle }]);
    }
  });

  it('cancels the newer with no proration, refunds its paid charge keyed on the charge id, alerts once, and keeps the older', async () => {
    const h = harness();
    await h.race();

    expect(h.stripe.cancels).toEqual([{ id: SECOND, params: { prorate: false, invoice_now: false } }]);
    expect(h.stripe.refundRequests).toEqual([
      { params: expect.objectContaining({ charge: SECOND_CHARGE }), idempotencyKey: SECOND_CHARGE },
    ]);
    expect(h.stripe.refundRequests[0]!.params).not.toHaveProperty('amount'); // in full
    expect(h.stripe.subscriptions.get(FIRST)!.status).toBe('active');
    expect(h.stripe.subscriptions.get(SECOND)!.status).toBe('canceled');
    expect(h.stripe.refunds.map((r) => r.charge)).toEqual([SECOND_CHARGE]);
    expectOneRedactedAlert(h.errors);
    expect(h.warnings).toEqual([]);
  });

  it('replaying the webhooks, and the follow-up update events, cancels, refunds and alerts no more', async () => {
    const h = harness();
    const { first, second } = await h.race();

    // Stripe redelivers both completions under their own ids...
    expect((await h.deliver(first)).result.duplicate).toBe(true);
    expect((await h.deliver(second)).result.duplicate).toBe(true);
    // ...sends the update that follows the cancel, the older one's update, and
    // a creation event for the newer one that it queued before the cancel.
    await h.deliver(subscriptionEvent('customer.subscription.updated', h.stripe.subscriptions.get(SECOND)!));
    await h.deliver(subscriptionEvent('customer.subscription.updated', h.stripe.subscriptions.get(FIRST)!));
    await h.deliver(subscriptionEvent('customer.subscription.created', { ...h.stripe.subscriptions.get(SECOND)!, status: 'active' }));

    expect(h.stripe.cancels).toHaveLength(1);
    expect(h.stripe.refundRequests).toHaveLength(1);
    expect(h.stripe.refundRequests[0]!.idempotencyKey).toBe(SECOND_CHARGE);
    expectOneRedactedAlert(h.errors);
    expect(h.stripe.subscriptions.get(FIRST)!.status).toBe('active');

    const rows = await db.select().from(billingSubscriptions);
    expect(rows.find((r) => r.stripeSubscriptionId === SECOND)).toMatchObject({ status: 'canceled' });
    expect(rows.find((r) => r.stripeSubscriptionId === FIRST)).toMatchObject({ status: 'active' });
  });

  it('acts once per subscription even when Stripe still lists the cancelled one as active', async () => {
    const h = harness();
    await h.checkout();
    await h.checkout();
    h.stripe.complete(h.stripe.sessions[0]!, { subscription: FIRST, created: OCT_1, charge: FIRST_CHARGE });
    h.stripe.complete(h.stripe.sessions[1]!, { subscription: SECOND, created: OCT_1 + 5, charge: SECOND_CHARGE, viaIntent: true });
    h.stripe.freezeList();

    await h.deliver(completedEvent(h.stripe.sessions[1]!, SECOND));
    await h.deliver(subscriptionEvent('customer.subscription.created', { ...h.stripe.subscriptions.get(SECOND)!, status: 'active' }));

    expect(h.stripe.cancels).toHaveLength(1);
    expect(h.stripe.refundRequests).toHaveLength(1);
    expectOneRedactedAlert(h.errors);
  });

  it('does not refund a charge that already has a refund', async () => {
    const h = harness();
    await h.checkout();
    await h.checkout();
    h.stripe.complete(h.stripe.sessions[0]!, { subscription: FIRST, created: OCT_1, charge: FIRST_CHARGE });
    h.stripe.complete(h.stripe.sessions[1]!, { subscription: SECOND, created: OCT_1 + 5, charge: SECOND_CHARGE });
    h.stripe.refunds.push({ id: 're_test_manual', charge: SECOND_CHARGE });

    await h.deliver(completedEvent(h.stripe.sessions[1]!, SECOND));

    expect(h.stripe.refundRequests).toEqual([]);
    expect(h.stripe.cancels.map((c) => c.id)).toEqual([SECOND]);
    expectOneRedactedAlert(h.errors);
  });

  it('leaves a lone subscription alone, and reads nothing from Stripe for one without the metered price', async () => {
    const h = harness();
    await h.checkout();
    h.stripe.complete(h.stripe.sessions[0]!, { subscription: FIRST, created: OCT_1, charge: FIRST_CHARGE });
    await h.deliver(completedEvent(h.stripe.sessions[0]!, FIRST));
    await h.deliver(subscriptionEvent('customer.subscription.created', h.stripe.subscriptions.get(FIRST)!));

    const list = h.stripe.client.subscriptions.list;
    let listed = 0;
    h.stripe.client.subscriptions.list = async (params) => {
      listed++;
      return list(params);
    };
    await h.deliver(subscriptionEvent('customer.subscription.updated', {
      ...h.stripe.subscriptions.get(FIRST)!, id: 'sub_test_annual', items: { data: [{ price: { id: PRICES.cloud_year } }] },
    }));

    expect(listed).toBe(0);
    expect(h.stripe.cancels).toEqual([]);
    expect(h.stripe.refundRequests).toEqual([]);
    expect(h.errors).toEqual([]);
  });
});

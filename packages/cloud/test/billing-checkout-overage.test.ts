/**
 * Monthly Cloud checkout carries the metered overage price, so the overage the
 * reporter sends against a monthly subscription is invoiced (#64). Annual
 * checkout does not: Stripe allows one interval per subscription, and annual
 * overage bills on its own monthly subscription.
 *
 * Meter events are scoped to the customer, so a second subscription carrying
 * the metered price would bill every bundle twice. Checkout looks the account's
 * customer up first and refuses with a 409 pointing to the billing portal.
 *
 * Stripe is the fake below: no network, no secrets. Secret-shaped values and
 * price ids are assembled at run time, so this file never holds one.
 */
import { describe, it, expect } from 'vitest';
import { createBillingRoutes } from '../src/billing/routes.js';
import {
  createCheckoutSession, type StripeLike, type SubscriptionLister, type SubscriptionSummary,
} from '../src/billing/stripe.js';
import { PRICE_ENV, type CatalogKey } from '../src/billing/config.js';

const u = (...parts: string[]) => parts.join('_');
const TEST_KEY = u('sk', 'test', 'o'.repeat(24));
const PRICES: Record<CatalogKey, string> = {
  cloud_month: u('price', 'testcloudmonth'),
  cloud_year: u('price', 'testcloudyear'),
  extra_identity: u('price', 'testextraidentity'),
  payg_bundle: u('price', 'testpaygbundle'),
  overage_bundle: u('price', 'testoveragebundle'),
};
const ACCOUNT = 'urn:provenant:agent:test-overage-account';
const CUSTOMER = 'cus_test_overage';
const URLS = {
  successUrl: 'https://provenant.test/billing/ok',
  cancelUrl: 'https://provenant.test/billing/cancelled',
  returnUrl: 'https://provenant.test/account',
};

function billingEnv(without: CatalogKey[] = []): Record<string, string> {
  const env: Record<string, string> = { STRIPE_SECRET_KEY: TEST_KEY };
  for (const [key, name] of Object.entries(PRICE_ENV) as Array<[CatalogKey, string]>) {
    if (!without.includes(key)) env[name] = PRICES[key];
  }
  return env;
}

function subscription(id: string, prices: string[], metadata: Record<string, string>): SubscriptionSummary {
  return { id, status: 'active', created: 1_790_812_800, metadata, items: { data: prices.map((p) => ({ price: { id: p } })) } };
}

/** The customer's subscriptions, the sessions Stripe was asked for, and the
 *  subscription lists it was asked for. */
function fakeStripe(existing: SubscriptionSummary[] = []) {
  const checkouts: Array<Record<string, unknown>> = [];
  const lists: Array<Record<string, unknown>> = [];
  const stripe: StripeLike & SubscriptionLister = {
    checkout: {
      sessions: {
        async create(params) {
          checkouts.push(params);
          return { id: `session-${checkouts.length}`, url: `https://checkout.stripe.test/session-${checkouts.length}` };
        },
      },
    },
    billingPortal: { sessions: { async create() { return { url: 'https://billing.stripe.test/portal' }; } } },
    subscriptions: {
      async list(params) {
        lists.push(params);
        return { data: params.customer === CUSTOMER ? existing.filter((s) => s.status === params.status) : [] };
      },
    },
  };
  return { stripe, checkouts, lists };
}

function routes(o: { env?: Record<string, string>; existing?: SubscriptionSummary[] } = {}) {
  const fake = fakeStripe(o.existing);
  const logs: string[] = [];
  const r = createBillingRoutes({
    env: o.env ?? billingEnv(),
    stripe: fake.stripe,
    customers: { stripeCustomerId: (c) => (c.agentId === ACCOUNT ? CUSTOMER : null) },
    authenticate: () => ({ ok: false, reason: 'no signature' }),
    log: (line) => logs.push(line),
    ...URLS,
  });
  return { ...r, ...fake, logs };
}

const checkout = (r: ReturnType<typeof routes>, body: Record<string, unknown>) =>
  r.checkout(new Request('https://billing.provenant.test/billing/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));

const monthly = { plan: 'cloud', interval: 'month', client_reference_id: ACCOUNT };
const annual = { plan: 'cloud', interval: 'year', client_reference_id: ACCOUNT };

function expectNoSecrets(text: string) {
  for (const s of [TEST_KEY, ...Object.values(PRICES)]) expect(text, 'a key or price id leaked').not.toContain(s);
}

describe('line items', () => {
  it('monthly Cloud checkout sells the monthly price, quantity 1, and the metered overage price, no quantity', async () => {
    const r = routes();
    const res = await checkout(r, monthly);
    expect(res.status).toBe(200);

    expect(r.checkouts).toHaveLength(1);
    expect(r.checkouts[0]).toMatchObject({ mode: 'subscription', client_reference_id: ACCOUNT });
    expect(r.checkouts[0]!.line_items).toEqual([
      { price: PRICES.cloud_month, quantity: 1 },
      { price: PRICES.overage_bundle },
    ]);
  });

  it('annual Cloud checkout is unchanged: the annual price only, no overage price anywhere', async () => {
    const r = routes();
    expect((await checkout(r, annual)).status).toBe(200);

    expect(r.checkouts[0]!.line_items).toEqual([{ price: PRICES.cloud_year, quantity: 1 }]);
    expect(JSON.stringify(r.checkouts[0])).not.toContain(PRICES.overage_bundle);
  });

  it('still adds the extra-identity price when it is configured, monthly and annual', async () => {
    const urls = { successUrl: URLS.successUrl, cancelUrl: URLS.cancelUrl };
    const { stripe, checkouts } = fakeStripe();
    const extra = { extraIdentityPriceId: PRICES.extra_identity, overagePriceId: PRICES.overage_bundle };
    await createCheckoutSession(stripe, { planId: 'cloud', interval: 'month', priceId: PRICES.cloud_month, ...extra, ...urls });
    await createCheckoutSession(stripe, { planId: 'cloud', interval: 'year', priceId: PRICES.cloud_year, ...extra, ...urls });

    expect(checkouts.map((c) => c.line_items)).toEqual([
      [{ price: PRICES.cloud_month, quantity: 1 }, { price: PRICES.overage_bundle }, { price: PRICES.extra_identity }],
      [{ price: PRICES.cloud_year, quantity: 1 }, { price: PRICES.extra_identity }],
    ]);
  });

  it('pay-as-you-go bundle checkout is unchanged, and looks no subscription up', async () => {
    const r = routes();
    expect((await checkout(r, { kind: 'payg_bundle', client_reference_id: ACCOUNT })).status).toBe(200);

    expect(r.checkouts[0]).toMatchObject({ mode: 'payment', line_items: [{ price: PRICES.payg_bundle, quantity: 1 }] });
    expect(JSON.stringify(r.checkouts[0])).not.toContain(PRICES.overage_bundle);
    expect(r.lists).toHaveLength(0);
  });
});

describe('without STRIPE_PRICE_BUNDLE_OVERAGE', () => {
  it('refuses monthly checkout as not configured, without calling Stripe; annual and bundle checkout still work', async () => {
    const r = routes({ env: billingEnv(['overage_bundle']) });

    const res = await checkout(r, monthly);
    expect(res.status).toBe(503);
    const text = await res.text();
    const body = JSON.parse(text) as { error: { code: string; message: string; details?: unknown } };
    expect(body.error.code).toBe('BILLING_UNAVAILABLE');
    expect(body.error.message).toMatch(/not configured.*Nothing was charged/);
    expect(body.error.details).toBeUndefined();
    expect(text).not.toContain('STRIPE_PRICE_BUNDLE_OVERAGE');
    expect(r.logs.join('\n')).toContain('STRIPE_PRICE_BUNDLE_OVERAGE');
    expect(r.checkouts).toHaveLength(0);
    expect(r.lists).toHaveLength(0);

    expect((await checkout(r, annual)).status).toBe(200);
    expect((await checkout(r, { kind: 'payg_bundle' })).status).toBe(200);
    expect(r.checkouts.map((c) => c.line_items)).toEqual([
      [{ price: PRICES.cloud_year, quantity: 1 }],
      [{ price: PRICES.payg_bundle, quantity: 1 }],
    ]);
  });

  it('still refuses to start when it is set but malformed', () => {
    expect(() => routes({ env: { ...billingEnv(), [PRICE_ENV.overage_bundle]: 'not-a-price' } }))
      .toThrow(/STRIPE_PRICE_BUNDLE_OVERAGE/);
  });
});

describe('one subscription carrying the metered price per customer', () => {
  it('refuses monthly checkout with no client_reference_id, since it cannot be checked', async () => {
    const r = routes();
    const res = await checkout(r, { plan: 'cloud', interval: 'month' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/client_reference_id.*Nothing was charged/s);
    expect(r.checkouts).toHaveLength(0);
    expect(r.lists).toHaveLength(0);
  });

  it('checks the customer linked to the account, and sells to one with nothing active', async () => {
    const r = routes({ existing: [{ ...subscription('sub_test_old', [PRICES.cloud_month, PRICES.overage_bundle], { provenant_plan: 'cloud' }), status: 'canceled' }] });
    expect((await checkout(r, monthly)).status).toBe(200);
    expect(r.lists).toEqual([expect.objectContaining({ customer: CUSTOMER, status: 'active' })]);
    expect(r.checkouts).toHaveLength(1);
  });

  it.each([
    [
      'monthly checkout, by a customer with an active monthly Cloud subscription',
      monthly,
      subscription('sub_test_monthly', [PRICES.cloud_month, PRICES.overage_bundle], { provenant_plan: 'cloud', provenant_interval: 'month' }),
    ],
    [
      "monthly checkout, by an annual customer whose separate overage subscription is active",
      monthly,
      subscription('sub_test_annual_overage', [PRICES.overage_bundle], { provenant_purchase: 'overage_bundle' }),
    ],
    [
      'annual checkout, by a customer with an active monthly Cloud subscription',
      annual,
      subscription('sub_test_monthly', [PRICES.cloud_month, PRICES.overage_bundle], { provenant_plan: 'cloud', provenant_interval: 'month' }),
    ],
  ])('refuses %s with a 409 pointing to the billing portal, and creates no session', async (_label, body, existing) => {
    const r = routes({ existing: [existing] });
    const res = await checkout(r, body);
    expect(res.status).toBe(409);
    const text = await res.text();
    const error = (JSON.parse(text) as { error: { code: string; message: string; retryable: boolean; fix: { note: string } } }).error;
    expect(error.code).toBe('ALREADY_SUBSCRIBED');
    expect(error.message).toMatch(/Nothing was charged/);
    expect(error.retryable).toBe(false);
    expect(error.fix.note).toContain('/billing/portal');

    // No session, so Stripe never sees a second metered item.
    expect(r.checkouts).toHaveLength(0);
    expect(r.lists).toEqual([expect.objectContaining({ customer: CUSTOMER, status: 'active' })]);
    expectNoSecrets(text);
    expectNoSecrets(r.logs.join('\n'));
  });

  it('refuses annual checkout beside any active Cloud subscription, found by its metadata after a portal plan switch', async () => {
    const r = routes({ existing: [subscription('sub_test_switched', [u('price', 'someotherprice')], { provenant_plan: 'cloud' })] });
    expect((await checkout(r, annual)).status).toBe(409);
    expect(r.checkouts).toHaveLength(0);
  });

  it('creates no session when Stripe cannot list the subscriptions, and logs nothing secret', async () => {
    const r = routes();
    r.stripe.subscriptions.list = async () => {
      throw Object.assign(new Error(`list failed for ${PRICES.overage_bundle} with ${TEST_KEY}`), { type: 'StripeAPIError' });
    };
    const res = await checkout(r, monthly);
    expect(res.status).toBe(502);
    expect(r.checkouts).toHaveLength(0);
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toMatch(/StripeAPIError/);
    expectNoSecrets(await res.text());
    expectNoSecrets(r.logs.join('\n'));
  });
});

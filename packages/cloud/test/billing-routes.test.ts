import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  openDb, closeDb, generateKeypair, deriveAgentId, publicKeyToJwk, signRequest, ProvenantError,
  type Db, type Keypair,
} from '@lacre/core';
import { createCollector } from '../src/collector/server.js';
import { createBillingRoutes, type BillingCaller, type BillingRoutesOptions } from '../src/billing/routes.js';
import { stripeCatalog, type StripeLike, type SubscriptionLister } from '../src/billing/stripe.js';
import { PRICE_ENV } from '../src/billing/config.js';

/*
 * Secret-shaped values and price ids are assembled at runtime so this file
 * never contains one; the repo-wide secret search in billing-setup.test.ts
 * covers it.
 */
const u = (...parts: string[]) => parts.join('_');
const TEST_KEY = u('sk', 'test', 'x'.repeat(24));
const LIVE_KEY = u('sk', 'live', 'y'.repeat(24));
const PRICES: Record<keyof typeof PRICE_ENV, string> = {
  cloud_month: u('price', 'testcloudmonth'),
  cloud_year: u('price', 'testcloudyear'),
  extra_identity: u('price', 'testextraidentity'),
  payg_bundle: u('price', 'testpaygbundle'),
  overage_bundle: u('price', 'testoveragebundle'),
};
const CUSTOMER = u('cus', 'fakecustomer');

function billingEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { STRIPE_SECRET_KEY: TEST_KEY };
  for (const [key, name] of Object.entries(PRICE_ENV)) env[name] = PRICES[key as keyof typeof PRICE_ENV];
  return { ...env, ...overrides };
}

function expectNoSecrets(text: string) {
  for (const s of [TEST_KEY, LIVE_KEY, ...Object.values(PRICES)]) {
    expect(text, 'a key or price id leaked').not.toContain(s);
  }
}

/** In-memory stand-in for the slice of Stripe the routes use. No network. */
function fakeStripe() {
  const checkouts: Array<Record<string, unknown>> = [];
  const portals: Array<Record<string, unknown>> = [];
  const stripe: StripeLike & SubscriptionLister = {
    subscriptions: { list: async () => ({ data: [] }) },
    checkout: {
      sessions: {
        async create(params) {
          checkouts.push(params);
          return { id: `session-${checkouts.length}`, url: `https://checkout.stripe.test/session-${checkouts.length}` };
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(params) {
          portals.push(params);
          return { url: 'https://billing.stripe.test/portal-1' };
        },
      },
    },
  };
  return { stripe, checkouts, portals };
}

const URLS = {
  successUrl: 'https://provenant.test/billing/ok',
  cancelUrl: 'https://provenant.test/billing/cancelled',
  returnUrl: 'https://provenant.test/account',
};

function routes(overrides: Partial<BillingRoutesOptions> = {}) {
  const fake = fakeStripe();
  const logs: string[] = [];
  const r = createBillingRoutes({
    env: billingEnv(),
    stripe: fake.stripe,
    customers: { stripeCustomerId: () => null },
    authenticate: () => ({ ok: false, reason: 'no signature' }),
    log: (line) => logs.push(line),
    ...URLS,
    ...overrides,
  });
  return { ...r, ...fake, logs };
}

const post = (path: string, body?: unknown) =>
  new Request(`https://billing.provenant.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('checkout', () => {
  it.each([
    // Monthly overage bills on the subscription itself (#64).
    ['month', [{ price: PRICES.cloud_month, quantity: 1 }, { price: PRICES.overage_bundle }]],
    ['year', [{ price: PRICES.cloud_year, quantity: 1 }]],
  ] as const)('creates a Cloud subscription session billed per %s with the matching price ids', async (interval, lineItems) => {
    const r = routes();
    const res = await r.checkout(
      post('/billing/checkout', { plan: 'cloud', interval, client_reference_id: 'urn:provenant:agent:test-account' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: { url: string; mode: string } };
    expect(body.ok).toBe(true);
    expect(body.result).toEqual({ url: 'https://checkout.stripe.test/session-1', mode: 'subscription' });

    expect(r.checkouts).toHaveLength(1);
    expect(r.checkouts[0]).toMatchObject({
      mode: 'subscription',
      line_items: lineItems,
      success_url: URLS.successUrl,
      cancel_url: URLS.cancelUrl,
    });
  });

  it('sells one pay-as-you-go bundle as a payment-mode session with the $15 price', async () => {
    const r = routes();
    const res = await r.checkout(post('/billing/checkout', { kind: 'payg_bundle' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { mode: string } }).result.mode).toBe('payment');

    expect(r.checkouts[0]).toMatchObject({ mode: 'payment', line_items: [{ price: PRICES.payg_bundle, quantity: 1 }] });
    expect(r.checkouts[0]!.subscription_data).toBeUndefined();
    // The variable it reads holds the catalog's $15 one-time price.
    const payg = stripeCatalog().find((c) => (c.metadata as { kind?: string }).kind === 'payg_bundle')!;
    expect(payg.price).toEqual({ unit_amount: 1500, currency: 'usd' });
  });

  it('forwards client_reference_id to the session when given, and omits it otherwise', async () => {
    const r = routes();
    const account = 'urn:provenant:agent:test-account';
    await r.checkout(post('/billing/checkout', { plan: 'cloud', interval: 'month', client_reference_id: account }));
    await r.checkout(post('/billing/checkout', { kind: 'payg_bundle', client_reference_id: account }));
    await r.checkout(post('/billing/checkout', { plan: 'cloud', interval: 'year' }));
    expect(r.checkouts.map((c) => c.client_reference_id)).toEqual([account, account, undefined]);
  });

  it('rejects enterprise with a 4xx that says how to buy it, and calls Stripe for nothing', async () => {
    const r = routes();
    const res = await r.checkout(post('/billing/checkout', { plan: 'enterprise', interval: 'month' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string; fix: { note: string } } };
    expect(body.error.code).toBe('INVALID_INPUT');
    expect(body.error.message).toMatch(/Enterprise is not sold through self-serve checkout/);
    expect(body.error.fix.note).toMatch(/contract/);
    expect(r.checkouts).toHaveLength(0);
  });

  it.each([
    ['free', { plan: 'free', interval: 'month' }],
    ['an unknown plan', { plan: 'platinum', interval: 'month' }],
    ['no plan', { interval: 'month' }],
    ['a bad interval', { plan: 'cloud', interval: 'week' }],
    ['a bundle with a plan', { kind: 'payg_bundle', plan: 'cloud' }],
    ['an unknown field', { plan: 'cloud', interval: 'month', price: 'anything' }],
    ['a client_reference_id with spaces', { plan: 'cloud', interval: 'month', client_reference_id: 'a b' }],
    ['a client_reference_id over 200 characters', { plan: 'cloud', interval: 'month', client_reference_id: 'a'.repeat(201) }],
  ])('rejects %s with 400 and an example of a valid request', async (_label, input) => {
    const r = routes();
    const res = await r.checkout(post('/billing/checkout', input));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; fix: { note: string } } };
    expect(body.error.message).toMatch(/Nothing was charged/);
    expect(body.error.fix.note.length).toBeGreaterThan(0);
    expect(r.checkouts).toHaveLength(0);
  });

  it('rejects a body that is not JSON', async () => {
    const r = routes();
    const req = new Request('https://billing.provenant.test/billing/checkout', { method: 'POST', body: '{nope' });
    expect((await r.checkout(req)).status).toBe(400);
  });

  it('rejects anything but POST', async () => {
    const r = routes();
    const res = await r.checkout(new Request('https://billing.provenant.test/billing/checkout'));
    expect(res.status).toBe(405);
  });

  it('answers a missing price with a generic 503 and a request id, and logs the variable under that id', async () => {
    const env = billingEnv();
    delete env[PRICE_ENV.overage_bundle];
    const r = routes({ env });
    const res = await r.checkout(
      post('/billing/checkout', { plan: 'cloud', interval: 'month', client_reference_id: 'urn:provenant:agent:test-account' }),
    );
    expect(res.status).toBe(503);

    const text = await res.text();
    const body = JSON.parse(text) as { error: { code: string; details?: unknown }; requestId: string };
    expect(body.error.code).toBe('BILLING_UNAVAILABLE');
    expect(body.error.details).toBeUndefined();
    const requestId = res.headers.get('x-request-id');
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.requestId).toBe(requestId);
    expect(text).toContain(requestId!);

    // No environment variable name in the body or headers.
    const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n');
    for (const name of [...Object.values(PRICE_ENV), 'STRIPE_', 'PROVENANT_', 'DATABASE_URL', 'CRON_SECRET']) {
      expect(text).not.toContain(name);
      expect(headers).not.toContain(name);
    }
    expect(r.checkouts).toHaveLength(0);

    // The cause is in the server log under the same id.
    const line = r.logs.find((l) => l.includes(requestId!));
    expect(line).toContain(PRICE_ENV.overage_bundle);
  });
});

describe('billing portal', () => {
  const caller: BillingCaller = { keyId: 'test-key-id', agentId: 'urn:provenant:agent:test' };

  it('returns a portal URL for a known authenticated customer', async () => {
    const r = routes({
      authenticate: () => ({ ok: true, caller }),
      customers: { stripeCustomerId: (c) => (c.agentId === caller.agentId ? CUSTOMER : null) },
    });
    const res = await r.portal(post('/billing/portal'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { url: string } }).result.url).toBe('https://billing.stripe.test/portal-1');
    expect(r.portals).toEqual([{ customer: CUSTOMER, return_url: URLS.returnUrl }]);
  });

  it('returns 404 for an authenticated caller with no linked customer', async () => {
    const r = routes({ authenticate: () => ({ ok: true, caller }) });
    const res = await r.portal(post('/billing/portal'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; fix: { note: string } } };
    expect(body.error.code).toBe('CUSTOMER_NOT_FOUND');
    expect(body.error.fix.note).toMatch(/client_reference_id/);
    expect(r.portals).toHaveLength(0);
  });

  it('returns 401 for an unauthenticated caller and never looks up a customer', async () => {
    const lookup = vi.fn(() => CUSTOMER);
    const r = routes({ customers: { stripeCustomerId: lookup } });
    const res = await r.portal(post('/billing/portal'));
    expect(res.status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
    expect(r.portals).toHaveLength(0);
  });
});

describe('test mode comes first', () => {
  it('refuses to build the routes, or start the collector, with a live key and no PROVENANT_BILLING_MODE=live', () => {
    const db = openDb(':memory:');
    try {
      const billing = { env: billingEnv({ STRIPE_SECRET_KEY: LIVE_KEY }), stripe: fakeStripe().stripe, customers: { stripeCustomerId: () => null }, ...URLS };
      let err: unknown;
      try {
        createCollector({ db, billing });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ProvenantError);
      expect((err as ProvenantError).message).toMatch(/PROVENANT_BILLING_MODE/);
      expectNoSecrets(JSON.stringify((err as ProvenantError).toJSON()));

      // The owner's explicit opt-in is what allows it.
      const live = createCollector({ db, billing: { ...billing, env: { ...billing.env, PROVENANT_BILLING_MODE: 'live' } } });
      expect(live.listening).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  it('refuses to start when billing is requested but its config is missing, naming the variables', () => {
    const db = openDb(':memory:');
    try {
      expect(() =>
        createCollector({ db, billing: { env: {}, stripe: fakeStripe().stripe, customers: { stripeCustomerId: () => null }, ...URLS } }),
      ).toThrow(/STRIPE_SECRET_KEY.*STRIPE_PRICE_CLOUD_MONTHLY/s);
    } finally {
      closeDb(db);
    }
  });
});

describe('redaction', () => {
  // A Stripe failure whose message and raw body carry the key and a price id.
  const leaky = () =>
    Object.assign(new Error(`No such price: '${PRICES.cloud_month}'; key ${TEST_KEY}; stray ${u('price', 'someoneelses')}`), {
      type: 'StripeInvalidRequestError',
      statusCode: 400,
      raw: { message: `key ${TEST_KEY}`, param: PRICES.cloud_month },
    });

  it('never echoes a key, price id or Stripe error body in a checkout response or log', async () => {
    const r = routes();
    r.stripe.checkout.sessions.create = async () => {
      throw leaky();
    };
    const res = await r.checkout(
      post('/billing/checkout', { plan: 'cloud', interval: 'month', client_reference_id: 'urn:provenant:agent:test-account' }),
    );
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toMatch(/Nothing was charged/);
    expect(text).not.toMatch(/No such price|someoneelses/);
    expectNoSecrets(text);

    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toMatch(/StripeInvalidRequestError/);
    expect(r.logs[0]).not.toMatch(/someoneelses/);
    expectNoSecrets(r.logs.join('\n'));
  });

  it('never echoes them from a portal failure either, through the default console log', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    try {
      const fake = fakeStripe();
      fake.stripe.billingPortal.sessions.create = async () => {
        throw leaky();
      };
      const r = createBillingRoutes({
        env: billingEnv(),
        stripe: fake.stripe,
        customers: { stripeCustomerId: () => CUSTOMER },
        authenticate: () => ({ ok: true, caller: { keyId: 'test-key-id', agentId: 'test-agent' } }),
        ...URLS,
      });
      const res = await r.portal(post('/billing/portal'));
      expect(res.status).toBe(502);
      expectNoSecrets(await res.text());
    } finally {
      spy.mockRestore();
    }
    expect(logged.length).toBeGreaterThan(0);
    expectNoSecrets(logged.join('\n'));
  });
});

describe('mounted in the collector', () => {
  let db: Db;
  let server: Server;
  let authority: string;
  let base: string;
  let kp: Keypair;
  let agentId: string;
  const fake = fakeStripe();
  const customers = new Map<string, string>();

  beforeAll(async () => {
    db = openDb(':memory:');
    kp = generateKeypair();
    agentId = deriveAgentId(kp.publicKey);
    server = createCollector({
      db,
      billing: {
        env: billingEnv(),
        stripe: fake.stripe,
        customers: { stripeCustomerId: (c) => customers.get(c.agentId) ?? null },
        log: () => {},
        ...URLS,
      },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    authority = `127.0.0.1:${port}`;
    base = `http://${authority}`;
    const reg = await fetch(`${base}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId, display_name: 'billing-agent', public_key_jwk: publicKeyToJwk(kp.publicKey) }),
    });
    expect(reg.status).toBe(201);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    closeDb(db);
  });

  function signed(path: string, key: Keypair = kp, body?: unknown) {
    const bodyBytes = body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body));
    const headers = signRequest(
      { method: 'POST', authority, path, headers: {}, ...(bodyBytes ? { body: bodyBytes } : {}) },
      key.secretKey,
      key.keyId,
    );
    return { headers: { ...headers, 'content-type': 'application/json' }, ...(bodyBytes ? { body: bodyBytes } : {}) };
  }

  it('serves checkout with no request signature and forwards client_reference_id', async () => {
    const res = await fetch(`${base}/billing/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'cloud', interval: 'year', client_reference_id: agentId }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { url: string } }).result.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(fake.checkouts.at(-1)).toMatchObject({
      mode: 'subscription',
      client_reference_id: agentId,
      line_items: [{ price: PRICES.cloud_year, quantity: 1 }],
    });
  });

  it('rejects an unsigned portal request with 401', async () => {
    const res = await fetch(`${base}/billing/portal`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SIGNATURE_INVALID');
  });

  it('rejects a portal request signed by an unregistered key with 401', async () => {
    const res = await fetch(`${base}/billing/portal`, { method: 'POST', ...signed('/billing/portal', generateKeypair()) });
    expect(res.status).toBe(401);
  });

  it('returns 404 for a signed agent with no billing account', async () => {
    const res = await fetch(`${base}/billing/portal`, { method: 'POST', ...signed('/billing/portal') });
    expect(res.status).toBe(404);
  });

  it('returns a portal URL for a signed agent with a linked customer, and refuses a replay', async () => {
    customers.set(agentId, CUSTOMER);
    const req = signed('/billing/portal', kp, {});
    const res = await fetch(`${base}/billing/portal`, { method: 'POST', ...req });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { url: string } }).result.url).toBe('https://billing.stripe.test/portal-1');
    expect(fake.portals.at(-1)).toEqual({ customer: CUSTOMER, return_url: URLS.returnUrl });

    // Same nonce cache as every other signed endpoint.
    const replay = await fetch(`${base}/billing/portal`, { method: 'POST', ...req });
    expect(replay.status).toBe(401);
  });

  it('leaves receipt ingestion behind the signature check, as before', async () => {
    const unsigned = await fetch(`${base}/receipts`, { method: 'POST', body: JSON.stringify({ agent_id: agentId }) });
    expect(unsigned.status).toBe(401);
    const res = await fetch(`${base}/receipts`, { method: 'POST', ...signed('/receipts', kp, { agent_id: agentId }) });
    expect(res.status).not.toBe(401);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/never holds agent secret keys/);
  });
});

describe('not served without billing config', () => {
  let db: Db;
  let server: Server;
  let authority: string;
  let kp: Keypair;

  beforeAll(async () => {
    db = openDb(':memory:');
    kp = generateKeypair();
    server = createCollector({ db });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    authority = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    await fetch(`http://${authority}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: deriveAgentId(kp.publicKey), display_name: 'a', public_key_jwk: publicKeyToJwk(kp.publicKey) }),
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    closeDb(db);
  });

  it('treats /billing/* like any unknown path: 401 unsigned, 404 signed', async () => {
    for (const path of ['/billing/checkout', '/billing/portal']) {
      const unsigned = await fetch(`http://${authority}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan: 'cloud', interval: 'month' }),
      });
      expect(unsigned.status).toBe(401);

      const headers = signRequest({ method: 'POST', authority, path, headers: {} }, kp.secretKey, kp.keyId);
      const res = await fetch(`http://${authority}${path}`, { method: 'POST', headers });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    }
  });
});

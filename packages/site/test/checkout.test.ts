import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { billingSchema, billingCustomers } from '@provenant/cloud/dist/billing/schema.js';
import { PRICE_ENV } from '@provenant/cloud/dist/billing/config.js';
import type { StripeLike, SubscriptionLister, SubscriptionSummary } from '@provenant/cloud/dist/billing/stripe.js';
import { POST } from '../app/api/checkout/route.js';
import CheckoutPage from '../app/checkout/page.js';
import WelcomePage from '../app/welcome/page.js';
import { BRAND } from '../src/brand.js';
import { accountIdFor, sessionCookie } from '../src/auth/session.js';
import type { BillingDb } from '../src/billing-db.js';
import { CHECKOUT_API_PATH, createCheckoutRoute, type CheckoutRouteOptions } from '../src/checkout.js';
import { OFF_SALE_PLANS, annualOverageDisclosure } from '../src/plans.js';

/**
 * Authenticated checkout (#59). Stripe is an in-memory fake handed to cloud's own
 * checkout handler, and the billing database is PGlite with cloud's migrations
 * applied: nothing here touches the network.
 *
 * Secret-shaped values and price ids are assembled at runtime so this file never
 * contains one (cloud's billing-setup test searches the repo for them).
 */

const pageCookie = vi.hoisted(() => ({ value: '' }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ cookie: pageCookie.value }) }));

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
const SECRET = 'test-session-secret-for-checkout-tests';
const SITE = 'https://site.example.test';
const DATABASE_URL = ['postgresql:', '', 'test-user:test-password@db.site.test', 'billing'].join('/');
const SECRETS = [TEST_KEY, LIVE_KEY, DATABASE_URL, ...Object.values(PRICES)];
const MIGRATIONS = ['0000_billing.sql', '0001_overage.sql', '0002_overage_retry.sql'].map(
  (f) => new URL(`../../cloud/migrations/${f}`, import.meta.url),
);

let pg: PGlite;
let db: BillingDb;
let logged: string[];
let fake: ReturnType<typeof fakeStripe>;

/** In-memory stand-in for the slice of Stripe cloud's checkout uses. No network. */
function fakeStripe(subscriptions: SubscriptionSummary[] = []) {
  const checkouts: Array<Record<string, unknown>> = [];
  const listed: Array<Record<string, unknown>> = [];
  const stripe: StripeLike & SubscriptionLister = {
    subscriptions: {
      async list(params) {
        listed.push(params);
        return { data: subscriptions };
      },
    },
    checkout: {
      sessions: {
        async create(params) {
          checkouts.push(params);
          return { id: `cs_test_${checkouts.length}`, url: `https://checkout.stripe.test/session-${checkouts.length}` };
        },
      },
    },
    billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.test/unused' }) } },
  };
  return { stripe, checkouts, listed };
}

beforeAll(async () => {
  pg = await PGlite.create();
  for (const migration of MIGRATIONS) await pg.exec(readFileSync(migration, 'utf8'));
  db = drizzle({ client: pg, schema: billingSchema }) as unknown as BillingDb;
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec('TRUNCATE billing_customers RESTART IDENTITY CASCADE');
  fake = fakeStripe();
  logged = [];
  for (const level of ['error', 'warn', 'log', 'info', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  }
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('SITE_BASE_URL', SITE);
  vi.stubEnv('VERCEL_URL', '');
  vi.stubEnv('DATABASE_URL', DATABASE_URL);
  vi.stubEnv('PROVENANT_BILLING_MODE', '');
  vi.stubEnv('STRIPE_SECRET_KEY', TEST_KEY);
  for (const [key, name] of Object.entries(PRICE_ENV)) vi.stubEnv(name, PRICES[key as keyof typeof PRICE_ENV]);
  pageCookie.value = '';
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const route = (opts: CheckoutRouteOptions = {}) =>
  createCheckoutRoute({ stripe: fake.stripe, connect: () => db, log: (line) => logged.push(line), ...opts });
/** Cloud is off sale (#95); this route puts it back on sale to test cloud's own handler. */
const cloudOnSale = () => route({ offSale: new Set() });

async function signedInCookie(email = 'ada@example.com'): Promise<string> {
  return (await sessionCookie(await accountIdFor(email), SECRET)).split(';')[0]!;
}

async function postJson(body: unknown, headers: Record<string, string> = {}, handler = route()) {
  return handler(
    new Request(`http://site.test${CHECKOUT_API_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await signedInCookie(), ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

async function postForm(fields: Record<string, string>, cookie?: string, handler = route()) {
  return handler(
    new Request(`http://site.test${CHECKOUT_API_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookie ?? (await signedInCookie()),
      },
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

const lastCheckout = () => fake.checkouts.at(-1) as Record<string, unknown>;

/** The redirect a server component asked for, read from Next's thrown redirect error. */
async function redirectOf(render: () => Promise<unknown>): Promise<string | null> {
  try {
    await render();
    return null;
  } catch (err) {
    const digest = String((err as { digest?: unknown }).digest ?? '');
    if (!digest.startsWith('NEXT_REDIRECT')) throw err;
    return digest.split(';')[2] ?? null;
  }
}

describe('not signed in', () => {
  it('answers JSON with 401 and never calls Stripe', async () => {
    const res = await postJson({ plan: 'cloud', interval: 'month' }, { cookie: '' });
    expect(res.status).toBe(401);
    const { error } = await res.json();
    expect(error.code).toBe('NOT_SIGNED_IN');
    expect(error.fix.note).toContain('/signup');
    expect(fake.checkouts).toEqual([]);
    expect(fake.listed).toEqual([]);
  });

  it('sends a form post to the signup page and never calls Stripe', async () => {
    const res = await postForm({ plan: 'cloud', interval: 'year' }, '');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/signup');
    expect(fake.checkouts).toEqual([]);
  });

  it('refuses a forged or expired session cookie', async () => {
    const forged = (await sessionCookie(await accountIdFor('ada@example.com'), 'another-secret-long-enough-to-be-used')).split(';')[0]!;
    expect((await postJson({ plan: 'cloud', interval: 'year' }, { cookie: forged })).status).toBe(401);
    expect(fake.checkouts).toEqual([]);
  });

  it('the deployed route answers 401 too, before any configuration is read', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    vi.stubEnv('DATABASE_URL', '');
    const res = await POST(
      new Request(`http://site.test${CHECKOUT_API_PATH}`, { method: 'POST', body: '{"kind":"payg_bundle"}' }),
    );
    expect(res.status).toBe(401);
  });
});

describe('the account', () => {
  it('is always the signed-in acct_<64 hex> id, whatever the body sends', async () => {
    const res = await postJson({
      plan: 'cloud',
      interval: 'month',
      client_reference_id: 'acct_attacker',
      account_id: 'acct_attacker',
      accountId: 'acct_attacker',
    }, {}, cloudOnSale());
    expect(res.status).toBe(200);
    const ref = lastCheckout().client_reference_id;
    expect(ref).toBe(await accountIdFor('ada@example.com'));
    expect(ref).toMatch(/^acct_[0-9a-f]{64}$/);
    expect(JSON.stringify(fake.checkouts)).not.toContain('attacker');
  });

  it('links a pay-as-you-go bundle to the account as well', async () => {
    await postJson({ kind: 'payg_bundle' });
    expect(lastCheckout().client_reference_id).toBe(await accountIdFor('ada@example.com'));
  });
});

describe("cloud's checkout handler", () => {
  it('sells Cloud monthly and annual as subscriptions and the bundle as a one-time payment', async () => {
    for (const [body, mode] of [
      [{ plan: 'cloud', interval: 'month' }, 'subscription'],
      [{ plan: 'cloud', interval: 'year' }, 'subscription'],
      [{ kind: 'payg_bundle' }, 'payment'],
    ] as const) {
      const res = await postJson(body, {}, cloudOnSale());
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect((await res.json()).result).toEqual({ url: expect.stringMatching(/^https:\/\/checkout\.stripe\.test\//), mode });
      expect(lastCheckout().mode).toBe(mode);
    }
    expect(fake.checkouts).toHaveLength(3);
  });

  it('refuses Enterprise without calling Stripe', async () => {
    const res = await postJson({ plan: 'enterprise', interval: 'year' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.fix.note).toMatch(/contact/i);
    expect(fake.checkouts).toEqual([]);
  });

  it("refuses a second Cloud subscription for the account's linked customer", async () => {
    await db.insert(billingCustomers).values({ stripeCustomerId: CUSTOMER, accountId: await accountIdFor('ada@example.com') });
    fake = fakeStripe([
      { id: u('sub', 'existing'), status: 'active', created: 1, metadata: { provenant_plan: 'cloud' }, items: { data: [{ price: { id: PRICES.cloud_year } }] } },
    ]);
    const res = await postJson({ plan: 'cloud', interval: 'month' }, {}, cloudOnSale());
    expect(res.status).toBe(409);
    expect(fake.listed).toEqual([expect.objectContaining({ customer: CUSTOMER })]);
    expect(fake.checkouts).toEqual([]);

    const form = await postForm({ plan: 'cloud', interval: 'year' }, undefined, cloudOnSale());
    expect(form.headers.get('location')).toBe('/checkout?checkout=subscribed');
  });

  it('sends a successful form post straight to Stripe', async () => {
    const res = await postForm({ plan: 'cloud', interval: 'year' }, undefined, cloudOnSale());
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://checkout.stripe.test/session-1');
  });

  it('sends a refused form post back to the checkout page with its outcome', async () => {
    const res = await postForm({ plan: 'enterprise', interval: 'year' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/checkout?checkout=invalid');
  });

  it('carries the annual overage disclosure from cloud on annual checkout only', async () => {
    await postJson({ plan: 'cloud', interval: 'year' }, {}, cloudOnSale());
    expect(JSON.stringify(lastCheckout())).toContain(JSON.stringify(annualOverageDisclosure()).slice(1, -1));
    await postJson({ plan: 'cloud', interval: 'month' }, {}, cloudOnSale());
    expect(JSON.stringify(lastCheckout())).not.toContain(JSON.stringify(annualOverageDisclosure()).slice(1, -1));
  });

  it('rejects a body that is not a JSON object, or is oversized, without calling Stripe', async () => {
    for (const body of ['not json', '[1,2]', JSON.stringify({ plan: 'cloud', pad: 'x'.repeat(5000) })]) {
      const res = await postJson(body);
      expect(res.status, body.slice(0, 20)).toBe(400);
    }
    expect(fake.checkouts).toEqual([]);
  });
});

describe('Cloud off sale (#95)', () => {
  it('is flagged off sale in the plans source', () => {
    expect(OFF_SALE_PLANS.has('cloud')).toBe(true);
  });

  it('refuses Cloud monthly and annual as JSON with 403, without calling Stripe', async () => {
    for (const interval of ['month', 'year']) {
      const res = await postJson({ plan: 'cloud', interval });
      expect(res.status, interval).toBe(403);
      const { error } = await res.json();
      expect(error.code).toBe('PLAN_NOT_ON_SALE');
      expect(error.message).toMatch(/early access/);
      expect(error.fix.note).toContain('payg_bundle');
    }
    expect(fake.checkouts).toEqual([]);
    expect(fake.listed).toEqual([]);
  });

  it('sends a Cloud form post back to the checkout page as unavailable, without calling Stripe', async () => {
    for (const interval of ['month', 'year']) {
      const res = await postForm({ plan: 'cloud', interval });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/checkout?checkout=unavailable');
    }
    expect(fake.checkouts).toEqual([]);
  });

  it('refuses Cloud on the deployed route too', async () => {
    const res = await POST(
      new Request(`http://site.test${CHECKOUT_API_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: await signedInCookie() },
        body: '{"plan":"cloud","interval":"month"}',
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('PLAN_NOT_ON_SALE');
  });

  it('still sells the pay-as-you-go bundle', async () => {
    const res = await postJson({ kind: 'payg_bundle' });
    expect(res.status).toBe(200);
    expect(lastCheckout().mode).toBe('payment');
  });
});

describe('return URLs', () => {
  const brand = BRAND as { domain: string | null };
  afterEach(() => {
    brand.domain = null;
  });

  it('sends success to the welcome page with the session id and cancel to pricing', async () => {
    await postJson({ kind: 'payg_bundle' });
    expect(lastCheckout().success_url).toBe(`${SITE}/welcome?session_id={CHECKOUT_SESSION_ID}`);
    expect(lastCheckout().cancel_url).toBe(`${SITE}/pricing?checkout=cancelled`);
  });

  it('prefers BRAND.domain, then SITE_BASE_URL, then VERCEL_URL', async () => {
    vi.stubEnv('VERCEL_URL', 'preview.example.test');
    brand.domain = 'brand.example.test';
    await postJson({ kind: 'payg_bundle' });
    expect(lastCheckout().success_url).toMatch(/^https:\/\/brand\.example\.test\/welcome/);

    brand.domain = null;
    await postJson({ kind: 'payg_bundle' });
    expect(lastCheckout().success_url).toMatch(new RegExp(`^${SITE}/welcome`));

    vi.stubEnv('SITE_BASE_URL', '');
    await postJson({ kind: 'payg_bundle' });
    expect(lastCheckout().cancel_url).toBe('https://preview.example.test/pricing?checkout=cancelled');
  });

  it('refuses with 500 and creates no session when there is no base', async () => {
    vi.stubEnv('SITE_BASE_URL', '');
    const res = await postJson({ kind: 'payg_bundle' }, { host: 'attacker.example' });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('CHECKOUT_UNAVAILABLE');
    expect(fake.checkouts).toEqual([]);
  });

  it('ignores a spoofed Host or X-Forwarded-Host header', async () => {
    await postJson({ kind: 'payg_bundle' }, { host: 'attacker.example', 'x-forwarded-host': 'attacker.example' });
    expect(JSON.stringify(lastCheckout())).not.toContain('attacker');
    expect(lastCheckout().success_url).toMatch(new RegExp(`^${SITE}/`));
  });
});

describe('configuration and secrets', () => {
  const noStripe = () => createCheckoutRoute({ connect: () => db, log: (l) => logged.push(l) });
  const MISSING = [
    { name: 'no base URL', unset: 'SITE_BASE_URL', status: 500, code: 'CHECKOUT_UNAVAILABLE', handler: route, cause: 'SITE_BASE_URL' },
    { name: 'no DATABASE_URL', unset: 'DATABASE_URL', status: 503, code: 'CHECKOUT_UNAVAILABLE', handler: route, cause: 'DATABASE_URL' },
    { name: 'no Stripe key', unset: 'STRIPE_SECRET_KEY', status: 503, code: 'BILLING_NOT_CONFIGURED', handler: noStripe, cause: 'STRIPE_SECRET_KEY' },
  ] as const;
  const NAMES = ['SITE_BASE_URL', 'VERCEL_URL', 'BRAND', 'DATABASE_URL', 'STRIPE', 'PROVENANT_', 'migration', ...Object.values(PRICE_ENV)];

  /** Every header and the body, as one string to search. */
  async function everything(res: Response): Promise<string> {
    return [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n') + '\n' + (await res.text());
  }

  for (const c of MISSING) {
    it(`${c.name}: JSON keeps its status and code, names nothing, and carries a logged request id`, async () => {
      vi.stubEnv(c.unset, '');
      const res = await postJson({ kind: 'payg_bundle' }, {}, c.handler());
      expect(res.status).toBe(c.status);
      const requestId = res.headers.get('x-request-id');
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      const text = await everything(res.clone());
      for (const name of [...NAMES, ...SECRETS]) expect(text).not.toContain(name);
      const body = await res.json();
      expect(body.error.code).toBe(c.code);
      expect(body.requestId).toBe(requestId);
      expect(logged.find((l) => l.includes(requestId!))).toContain(c.cause);
      expect(fake.checkouts).toEqual([]);
    });

    it(`${c.name}: a form post goes back with checkout=unavailable and a logged request id`, async () => {
      vi.stubEnv(c.unset, '');
      const res = await postForm({ kind: 'payg_bundle' }, undefined, c.handler());
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/checkout?checkout=unavailable');
      const requestId = res.headers.get('x-request-id');
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      const text = await everything(res);
      for (const name of [...NAMES, ...SECRETS]) expect(text).not.toContain(name);
      expect(logged.find((l) => l.includes(requestId!))).toContain(c.cause);
      expect(fake.checkouts).toEqual([]);
    });
  }

  it('stays in test mode: a live key without PROVENANT_BILLING_MODE=live is refused', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', LIVE_KEY);
    const res = await postJson({ kind: 'payg_bundle' });
    expect(res.status).toBe(503);
    expect(fake.checkouts).toEqual([]);
    expect(JSON.stringify(await res.json())).not.toContain(LIVE_KEY);
  });

  it('never logs or returns a key, price id or the database URL', async () => {
    await postJson({ plan: 'cloud', interval: 'month' });
    await postJson({ plan: 'enterprise' });
    vi.stubEnv('STRIPE_SECRET_KEY', LIVE_KEY);
    await postJson({ kind: 'payg_bundle' });
    for (const secret of SECRETS) expect(logged.join('\n')).not.toContain(secret);
  });
});

describe('checkout page', () => {
  it('redirects to signup for checkout when no one is signed in', async () => {
    expect(await redirectOf(() => CheckoutPage({ searchParams: Promise.resolve({}) }))).toBe('/signup?for=checkout');
  });

  it('offers Cloud monthly, Cloud annual and the bundle as form posts, and links Enterprise', async () => {
    pageCookie.value = await signedInCookie();
    const html = renderToStaticMarkup(await CheckoutPage({ searchParams: Promise.resolve({}) }));
    const options = [...html.matchAll(/data-option="([^"]+)"/g)].map((m) => m[1]);
    expect(options).toEqual(['cloud-monthly', 'cloud-annual', 'bundle', 'enterprise']);
    const forms = html.match(/<form\b[^>]*>/g) ?? [];
    expect(forms).toHaveLength(3);
    for (const form of forms) {
      expect(form).toContain(`action="${CHECKOUT_API_PATH}"`);
      expect(form).toContain('method="post"');
    }
    expect(html).toContain('name="interval" value="month"');
    expect(html).toContain('name="interval" value="year"');
    expect(html).toContain('name="kind" value="payg_bundle"');
    expect(html).not.toContain('client_reference_id');
    expect(html).toContain('href="/enterprise"');
  });

  it('shows the annual overage disclosure from cloud, word for word', async () => {
    pageCookie.value = await signedInCookie();
    const html = renderToStaticMarkup(await CheckoutPage({ searchParams: Promise.resolve({}) }));
    expect(html.replace(/&#x27;/g, "'")).toContain(annualOverageDisclosure());
  });

  it('shows the outcome it was sent back with, and nothing for an unknown one', async () => {
    pageCookie.value = await signedInCookie();
    const render = async (checkout: string) =>
      renderToStaticMarkup(await CheckoutPage({ searchParams: Promise.resolve({ checkout }) }));
    expect(await render('subscribed')).toMatch(/role="status"[^>]*>[^<]*already has a Cloud subscription/);
    expect(await render('<script>')).not.toContain('role="status"');
  });

  it('types no price into its source', () => {
    const src = readFileSync(new URL('../app/checkout/page.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\$\d/);
  });
});

describe('welcome page', () => {
  const guide = readFileSync(new URL('../../../docs/getting-started.md', import.meta.url), 'utf8');
  const guideBlocks = [...guide.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
  const unescape = (html: string) =>
    html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const render = async (params: Record<string, string> = {}) => {
    pageCookie.value = await signedInCookie();
    return renderToStaticMarkup(await WelcomePage({ searchParams: Promise.resolve(params) }));
  };

  it('redirects to signup for welcome when no one is signed in', async () => {
    expect(await redirectOf(() => WelcomePage({ searchParams: Promise.resolve({ session_id: 'cs_test_abc' }) }))).toBe('/signup?for=welcome');
  });

  it('shows the from-source commands exactly as the getting-started guide has them', async () => {
    const html = await render();
    const blocks = [...html.matchAll(/<pre><code>([^<]*)<\/code><\/pre>/g)].map((m) => unescape(m[1]!));
    expect(blocks).toEqual(guideBlocks.slice(0, 5));
    expect(blocks[0]).toMatch(/^git clone /);
  });

  it('has no npm or npx commands', async () => {
    expect(unescape(await render())).not.toMatch(/\bnpm\b|\bnpx\b/);
  });

  it('confirms a well-formed checkout session without showing its id', async () => {
    const id = 'cs_test_a1B2c3D4';
    const html = await render({ session_id: id });
    expect(html).toMatch(/role="status"[^>]*>Thank you/);
    expect(html).not.toContain(id);
    expect(await render({ session_id: '<script>' })).not.toContain('role="status"');
    expect(await render()).not.toContain('role="status"');
  });
});

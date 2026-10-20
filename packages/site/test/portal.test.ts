import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { billingSchema, billingCustomers } from '@provenant/cloud/dist/billing/schema.js';
import { PRICE_ENV } from '@provenant/cloud/dist/billing/config.js';
import type { StripeLike, SubscriptionLister } from '@provenant/cloud/dist/billing/stripe.js';
import { POST } from '../app/api/account/portal/route.js';
import AccountPage from '../app/account/page.js';
import { BRAND } from '../src/brand.js';
import { accountIdFor, sessionCookie } from '../src/auth/session.js';
import type { BillingDb } from '../src/billing-db.js';
import { PORTAL_API_PATH, createPortalRoute, type PortalRouteOptions } from '../src/portal.js';

/**
 * The billing portal for signed-in customers (#62). Stripe is an in-memory fake
 * handed to cloud's own portal handler, and the billing database is PGlite with
 * cloud's migrations applied: nothing here touches the network.
 *
 * Secret-shaped values and ids are assembled at runtime so this file never
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
const ADA_CUSTOMER = u('cus', 'adacustomer');
const GRACE_CUSTOMER = u('cus', 'gracecustomer');
const SECRET = 'test-session-secret-for-portal-tests';
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

/** In-memory stand-in for the slice of Stripe cloud's portal uses. No network. */
function fakeStripe(fail = false) {
  const portals: Array<Record<string, unknown>> = [];
  const stripe: StripeLike & SubscriptionLister = {
    subscriptions: { list: async () => ({ data: [] }) },
    checkout: { sessions: { create: async () => ({ id: 'cs_test_unused', url: 'https://checkout.stripe.test/unused' }) } },
    billingPortal: {
      sessions: {
        async create(params) {
          portals.push(params);
          if (fail) throw Object.assign(new Error('Stripe is down'), { type: 'StripeAPIError', statusCode: 500 });
          return { url: `https://billing.stripe.test/portal-${portals.length}` };
        },
      },
    },
  };
  return { stripe, portals };
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
  await db.insert(billingCustomers).values([
    { stripeCustomerId: ADA_CUSTOMER, accountId: await accountIdFor('ada@example.com') },
    { stripeCustomerId: GRACE_CUSTOMER, accountId: await accountIdFor('grace@example.com') },
  ]);
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

const route = (opts: PortalRouteOptions = {}) =>
  createPortalRoute({ stripe: fake.stripe, connect: () => db, log: (line) => logged.push(line), ...opts });

async function cookieFor(email: string): Promise<string> {
  return (await sessionCookie(await accountIdFor(email), SECRET)).split(';')[0]!;
}

async function postJson(
  body: unknown = {},
  { email = 'ada@example.com', headers = {}, query = '', handler = route() }: {
    email?: string | null;
    headers?: Record<string, string>;
    query?: string;
    handler?: (request: Request) => Promise<Response>;
  } = {},
) {
  return handler(
    new Request(`http://site.test${PORTAL_API_PATH}${query}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(email ? { cookie: await cookieFor(email) } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function postForm(email: string | null = 'ada@example.com') {
  return route()(
    new Request(`http://site.test${PORTAL_API_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(email ? { cookie: await cookieFor(email) } : {}),
      },
      body: '',
    }),
  );
}

const lastPortal = () => fake.portals.at(-1) as Record<string, unknown>;

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
    const res = await postJson({}, { email: null });
    expect(res.status).toBe(401);
    const { error } = await res.json();
    expect(error.code).toBe('NOT_SIGNED_IN');
    expect(error.fix.note).toContain('/signup');
    expect(fake.portals).toEqual([]);
  });

  it('sends a form post to the signup page and never calls Stripe', async () => {
    const res = await postForm(null);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/signup');
    expect(fake.portals).toEqual([]);
  });

  it('refuses a forged session cookie', async () => {
    const forged = (await sessionCookie(await accountIdFor('ada@example.com'), 'another-secret-long-enough-to-be-used')).split(';')[0]!;
    expect((await postJson({}, { email: null, headers: { cookie: forged } })).status).toBe(401);
    expect(fake.portals).toEqual([]);
  });

  it('the deployed route answers 401 too, before any configuration is read', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    vi.stubEnv('DATABASE_URL', '');
    const res = await POST(new Request(`http://site.test${PORTAL_API_PATH}`, { method: 'POST', body: '{}' }));
    expect(res.status).toBe(401);
  });
});

describe('the portal session', () => {
  it("opens the portal for the signed-in account's own Stripe customer", async () => {
    const res = await postJson();
    expect(res.status).toBe(200);
    expect((await res.json()).result).toEqual({ url: 'https://billing.stripe.test/portal-1' });
    expect(lastPortal()).toEqual({ customer: ADA_CUSTOMER, return_url: `${SITE}/account` });
  });

  it('ignores an account id in the body or the query', async () => {
    const grace = await accountIdFor('grace@example.com');
    const res = await postJson(
      { account_id: grace, accountId: grace, client_reference_id: grace, customer: GRACE_CUSTOMER },
      { query: `?account_id=${grace}&customer=${GRACE_CUSTOMER}` },
    );
    expect(res.status).toBe(200);
    expect(fake.portals).toEqual([{ customer: ADA_CUSTOMER, return_url: `${SITE}/account` }]);
  });

  it('sends a form post straight to the Stripe portal', async () => {
    const res = await postForm();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://billing.stripe.test/portal-1');
  });

  it('answers a clear "no billing account yet, see /pricing" when no customer is linked, without calling Stripe', async () => {
    const res = await postJson({}, { email: 'newcomer@example.com' });
    expect(res.status).toBe(404);
    const { error } = await res.json();
    expect(error.code).toBe('NO_BILLING_ACCOUNT');
    expect(error.message).toMatch(/no billing account yet/i);
    expect(error.fix.note).toContain('/pricing');
    expect(fake.portals).toEqual([]);

    const form = await postForm('newcomer@example.com');
    expect(form.headers.get('location')).toBe('/account?billing=none');
  });

  it('answers 502 when Stripe refuses, without leaking its error, and a form goes back with billing=failed', async () => {
    fake = fakeStripe(true);
    const res = await postJson();
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('Stripe is down');
    expect((await postForm()).headers.get('location')).toBe('/account?billing=failed');
  });
});

describe('return URL', () => {
  const brand = BRAND as { domain: string | null };
  afterEach(() => {
    brand.domain = null;
  });

  it('prefers BRAND.domain, then SITE_BASE_URL, then VERCEL_URL', async () => {
    vi.stubEnv('VERCEL_URL', 'preview.example.test');
    brand.domain = 'brand.example.test';
    await postJson();
    expect(lastPortal().return_url).toBe('https://brand.example.test/account');

    brand.domain = null;
    await postJson();
    expect(lastPortal().return_url).toBe(`${SITE}/account`);

    vi.stubEnv('SITE_BASE_URL', '');
    await postJson();
    expect(lastPortal().return_url).toBe('https://preview.example.test/account');
  });

  it('refuses with 500 and creates no session when there is no base', async () => {
    vi.stubEnv('SITE_BASE_URL', '');
    const res = await postJson({}, { headers: { host: 'attacker.example' } });
    expect(res.status).toBe(500);
    expect((await res.json()).error.fix.note).toContain('SITE_BASE_URL');
    expect(fake.portals).toEqual([]);
  });

  it('ignores a spoofed Host or X-Forwarded-Host header', async () => {
    await postJson({}, { headers: { host: 'attacker.example', 'x-forwarded-host': 'attacker.example' } });
    expect(lastPortal().return_url).toBe(`${SITE}/account`);
  });
});

describe('configuration and secrets', () => {
  it('answers 503 naming DATABASE_URL when it is unset, and calls no one', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const res = await postJson();
    expect(res.status).toBe(503);
    expect((await res.json()).error.fix.note).toContain('DATABASE_URL');
    expect(fake.portals).toEqual([]);
  });

  it('answers 503 naming the missing Stripe key, never its value', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    const res = await postJson({}, { handler: createPortalRoute({ connect: () => db, log: (l) => logged.push(l) }) });
    expect(res.status).toBe(503);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('STRIPE_SECRET_KEY');
    for (const secret of SECRETS) expect(body).not.toContain(secret);
  });

  it('stays in test mode: a live key without PROVENANT_BILLING_MODE=live is refused', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', LIVE_KEY);
    const res = await postJson();
    expect(res.status).toBe(503);
    expect(fake.portals).toEqual([]);
  });

  it('never logs or returns a key, price id, customer id or the database URL', async () => {
    await postJson();
    await postJson({}, { email: 'newcomer@example.com' });
    fake = fakeStripe(true);
    await postJson();
    vi.stubEnv('STRIPE_SECRET_KEY', LIVE_KEY);
    await postJson();
    const log = logged.join('\n');
    for (const secret of [...SECRETS, ADA_CUSTOMER, GRACE_CUSTOMER]) expect(log).not.toContain(secret);
  });
});

describe('account page', () => {
  it('redirects to signup when no one is signed in', async () => {
    expect(await redirectOf(() => AccountPage({ searchParams: Promise.resolve({}) }))).toBe('/signup');
  });

  it('has one "Manage billing" form posting to the portal route, and no account field', async () => {
    pageCookie.value = await cookieFor('ada@example.com');
    const html = renderToStaticMarkup(await AccountPage({ searchParams: Promise.resolve({}) }));
    const forms = html.match(/<form\b[^>]*>/g) ?? [];
    expect(forms).toHaveLength(1);
    expect(forms[0]).toContain(`action="${PORTAL_API_PATH}"`);
    expect(forms[0]).toContain('method="post"');
    expect(html).toContain('Manage billing');
    expect(html).not.toMatch(/<input\b/);
  });

  it('points to pricing when there is no billing account yet, and shows nothing for an unknown outcome', async () => {
    pageCookie.value = await cookieFor('ada@example.com');
    const render = async (billing: string) =>
      renderToStaticMarkup(await AccountPage({ searchParams: Promise.resolve({ billing }) }));
    expect(await render('none')).toMatch(/role="status"[^>]*>[^<]*no billing account yet[\s\S]*href="\/pricing"/);
    expect(await render('<script>')).not.toContain('role="status"');
  });
});

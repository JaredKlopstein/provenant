import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { billingSchema, billingCustomers, billingSubscriptions } from '@provenant/cloud/dist/billing/schema.js';
import { POST as signOut, GET as signOutGet } from '../app/api/auth/sign-out/route.js';
import { POST as callback } from '../app/api/auth/callback/route.js';
import CheckoutPage from '../app/checkout/page.js';
import AccountPage from '../app/account/page.js';
import WelcomePage from '../app/welcome/page.js';
import RootLayout from '../app/layout.js';
import HomePage from '../app/page.js';
import {
  CALLBACK_PATH,
  SESSION_COOKIE,
  SIGN_OUT_PATH,
  accountIdFor,
  createLinkToken,
  getSignedInAccount,
  sessionCookie,
} from '../src/auth/session.js';
import { usedTokenSchema } from '../src/auth/used-tokens.js';
import { priceCards, WAITLIST_HREF } from '../src/plans.js';

/**
 * #101: signed-in pages say who is signed in and let them sign out; checkout lists
 * what each option includes; /account shows the email, plus the plan and renewal
 * date once the webhook has stored them. Postgres is PGlite in process (the Neon
 * driver's drizzle() is swapped for one over it): nothing here touches the network.
 */

const pg = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('drizzle-orm/neon-serverless', () => ({ drizzle: vi.fn(() => pg.db) }));
const pageCookie = vi.hoisted(() => ({ value: '' }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ cookie: pageCookie.value }) }));

const SECRET = 'test-session-secret-for-signed-in-pages-tests';
const SITE = 'https://site.example.test';
const ADA = 'ada@example.com';
const CUSTOMER = ['cus', 'signedinpages'].join('_');
const MIGRATIONS = [
  '../../cloud/migrations/0000_billing.sql',
  '../../cloud/migrations/0001_overage.sql',
  '../../cloud/migrations/0002_overage_retry.sql',
  '../migrations/0000_magic_link_used.sql',
  '../migrations/0001_magic_link_rate.sql',
].map((f) => new URL(f, import.meta.url));

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  for (const m of MIGRATIONS) await db.exec(readFileSync(m, 'utf8'));
  pg.db = drizzle({ client: db, schema: { ...billingSchema, ...usedTokenSchema } });
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.exec('TRUNCATE billing_subscriptions, billing_customers, site_magic_link_used RESTART IDENTITY CASCADE');
  for (const level of ['error', 'warn', 'log', 'info', 'debug'] as const) vi.spyOn(console, level).mockImplementation(() => {});
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('EMAIL_API_URL', 'https://email.example.test/send');
  vi.stubEnv('EMAIL_API_KEY', 'test-email-api-key');
  vi.stubEnv('EMAIL_FROM', 'signin@example.test');
  vi.stubEnv('SITE_BASE_URL', SITE);
  vi.stubEnv('VERCEL_URL', '');
  vi.stubEnv('DATABASE_URL', 'postgresql://test-user:test-password@db.site.test/site');
  pageCookie.value = '';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const cookiePair = (setCookie: string) => setCookie.split(';')[0]!;
const asRequest = (cookie: string) => new Request(`${SITE}/account`, { headers: { cookie } });

async function signedIn(email = ADA): Promise<string> {
  return cookiePair(await sessionCookie(await accountIdFor(email), SECRET, email));
}

const renderPage = async (Page: (p: { searchParams: Promise<Record<string, string>> }) => Promise<unknown>, params = {}) =>
  renderToStaticMarkup((await Page({ searchParams: Promise.resolve(params) })) as Parameters<typeof renderToStaticMarkup>[0]);

const unescape = (html: string) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

describe('session carries the email it was signed in with', () => {
  it('reads back the account id and the email from a new session', async () => {
    const account = await getSignedInAccount(asRequest(await signedIn()));
    expect(account).toEqual({ accountId: await accountIdFor(ADA), email: ADA });
  });

  it('a session issued before this change still works, with no email', async () => {
    const legacy = cookiePair(await sessionCookie(await accountIdFor(ADA), SECRET));
    expect(await getSignedInAccount(asRequest(legacy))).toEqual({ accountId: await accountIdFor(ADA) });
  });

  it('drops an email that does not hash to the session account, keeping the account', async () => {
    const mismatched = cookiePair(await sessionCookie(await accountIdFor(ADA), SECRET, 'grace@example.com'));
    expect(await getSignedInAccount(asRequest(mismatched))).toEqual({ accountId: await accountIdFor(ADA) });
  });

  it('signing in through the confirm page stores the email in the session', async () => {
    const token = await createLinkToken(ADA, SECRET);
    const res = await callback(
      new Request(`${SITE}${CALLBACK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE },
        body: new URLSearchParams({ token }).toString(),
      }),
    );
    const cookie = cookiePair(res.headers.get('set-cookie') ?? '');
    expect((await getSignedInAccount(asRequest(cookie)))?.email).toBe(ADA);
  });
});

describe('sign out', () => {
  const post = (cookie: string, headers: Record<string, string> = { origin: SITE }) =>
    signOut(new Request(`${SITE}${SIGN_OUT_PATH}`, { method: 'POST', headers: { cookie, ...headers } }));

  it('a same-origin POST clears the session cookie and goes home', async () => {
    const res = await post(await signedIn());
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    const cleared = res.headers.get('set-cookie') ?? '';
    expect(cleared.startsWith(`${SESSION_COOKIE}=;`)).toBe(true);
    const attributes = cleared.split(';').slice(1).map((a) => a.trim());
    expect(attributes).toEqual(expect.arrayContaining(['Path=/', 'Max-Age=0', 'HttpOnly', 'Secure', 'SameSite=Lax']));
    expect(await getSignedInAccount(asRequest(cookiePair(cleared)))).toBeNull();
  });

  it('also answers a signed-out POST, so a second click is harmless', async () => {
    const res = await post('');
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
  });

  it('a GET does not sign out', async () => {
    const res = await signOutGet();
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a POST from another site, leaving the session alone', async () => {
    const res = await post(await signedIn(), { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('account bar on signed-in pages', () => {
  const pages = [
    ['checkout', CheckoutPage],
    ['account', AccountPage],
    ['welcome', WelcomePage],
  ] as const;

  it.each(pages)('/%s shows the signed-in email and a Sign out button that POSTs', async (_, Page) => {
    pageCookie.value = await signedIn();
    const html = await renderPage(Page);
    expect(html).toMatch(/Signed in as <strong>ada@example\.com<\/strong>/);
    const form = /<form\b[^>]*action="\/api\/auth\/sign-out"[^>]*>/.exec(html)?.[0] ?? '';
    expect(form).toContain('method="post"');
    expect(html).toMatch(/<button type="submit">Sign out<\/button>/);
  });

  it.each(pages)('/%s says "Signed in" without an address for a session from before the change', async (_, Page) => {
    pageCookie.value = cookiePair(await sessionCookie(await accountIdFor(ADA), SECRET));
    const html = await renderPage(Page);
    expect(html).toContain('Signed in');
    expect(html).not.toContain('Signed in as');
    expect(html).toContain('>Sign out</button>');
  });

  it('marketing pages stay unchanged: the layout reads no session and shows no account bar', () => {
    const html = renderToStaticMarkup(RootLayout({ children: HomePage() }));
    expect(html).not.toContain('Sign out');
    expect(readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8')).not.toMatch(/getSignedInAccount|signedInFromCookie|headers\(\)/);
  });

  it('escapes the email it shows', async () => {
    const odd = 'a<b>"x"@example.com';
    pageCookie.value = cookiePair(await sessionCookie(await accountIdFor(odd), SECRET, odd));
    const html = await renderPage(AccountPage);
    expect(html).not.toContain('<b>');
    expect(unescape(html)).toContain(`Signed in as <strong>${odd}</strong>`);
  });
});

describe('checkout lists what each option includes', () => {
  beforeEach(async () => {
    pageCookie.value = await signedIn();
  });

  it('the bundle option lists its terms from pricing.ts and keeps its payment form', async () => {
    const html = unescape(await renderPage(CheckoutPage));
    const bundle = /<article data-option="bundle">([\s\S]*?)<\/article>/.exec(html)?.[1] ?? '';
    for (const term of priceCards('monthly').find((c) => c.id === 'bundle')!.terms) expect(bundle).toContain(`<li>${term}</li>`);
    expect(bundle).toContain('>Continue to payment</button>');
  });

  it('off-sale Cloud options list their planned terms, say Early access, and offer the waitlist, not payment', async () => {
    const html = unescape(await renderPage(CheckoutPage));
    const cloud = priceCards('monthly').find((c) => c.id === 'cloud')!;
    expect(cloud.offSale).toBe(true);
    for (const id of ['cloud-monthly', 'cloud-annual']) {
      const option = new RegExp(`<article data-option="${id}">([\\s\\S]*?)</article>`).exec(html)?.[1] ?? '';
      for (const term of cloud.terms) expect(option, id).toContain(`<li>${term}</li>`);
      expect(option, id).toContain('Early access');
      expect(option, id).toContain(`href="${WAITLIST_HREF}"`);
      expect(option, id).not.toContain('Continue to payment');
    }
  });

  it('the already-subscribed message links /account', async () => {
    const html = await renderPage(CheckoutPage, { checkout: 'subscribed' });
    expect(html).toMatch(/role="status"[^>]*>[^<]*already has a Cloud subscription[\s\S]*?<a href="\/account">/);
  });
});

describe('/account shows the email, and the plan once the webhook stored it', () => {
  beforeEach(async () => {
    pageCookie.value = await signedIn();
  });

  async function subscribe(status: string, interval: 'month' | 'year', periodEnd: string) {
    const [customer] = await (pg.db as ReturnType<typeof drizzle>)
      .insert(billingCustomers)
      .values({ stripeCustomerId: CUSTOMER, accountId: await accountIdFor(ADA) })
      .returning();
    await (pg.db as ReturnType<typeof drizzle>).insert(billingSubscriptions).values({
      stripeSubscriptionId: ['sub', 'signedinpages'].join('_'),
      stripeCustomerId: customer!.stripeCustomerId,
      plan: 'cloud',
      interval,
      status,
      currentPeriodEnd: new Date(periodEnd),
    });
  }

  it('shows the plan, billing period and renewal date of an active subscription', async () => {
    await subscribe('active', 'year', '2027-10-22T00:00:00Z');
    const html = await renderPage(AccountPage);
    expect(html).toContain('ada@example.com');
    expect(html).toMatch(/Cloud, annual/);
    expect(html).toMatch(/Renews on <time dateTime="2027-10-22">22 October 2027<\/time>/);
  });

  it('flags a past-due subscription and points to Manage billing', async () => {
    await subscribe('past_due', 'month', '2026-11-22T00:00:00Z');
    const html = await renderPage(AccountPage);
    expect(html).toMatch(/Cloud, monthly/);
    expect(html).toMatch(/payment is past due/i);
  });

  it('says honestly that no plan is recorded yet, before the webhook has stored one', async () => {
    const html = await renderPage(AccountPage);
    expect(html).toMatch(/No plan recorded for this account yet/);
    expect(html).toContain('href="/pricing"');
  });

  it('ignores a canceled subscription', async () => {
    await subscribe('canceled', 'month', '2026-11-22T00:00:00Z');
    expect(await renderPage(AccountPage)).toMatch(/No plan recorded for this account yet/);
  });

  it('says plan details are unavailable, without failing the page, when the billing database is not configured', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const html = await renderPage(AccountPage);
    expect(html).toContain('ada@example.com');
    expect(html).toMatch(/Plan details are not available right now/);
    expect(html).toContain('>Manage billing</button>');
  });
});

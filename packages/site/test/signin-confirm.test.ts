import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { GET, POST } from '../app/api/auth/callback/route.js';
import SigninPage, { metadata } from '../app/signin/page.js';
import { SIGNUP_PATH } from '../src/auth/email.js';
import { CALLBACK_PATH, CHECKOUT_PATH, CONFIRM_PATH, SESSION_COOKIE, createLinkToken } from '../src/auth/session.js';
import { usedTokenSchema } from '../src/auth/used-tokens.js';

/**
 * #89: opening a magic link (GET) only shows a confirm page; only the page's POST
 * uses the link up and signs in. Postgres is PGlite in process (the Neon driver's
 * drizzle() is swapped for one over PGlite): nothing here touches the network.
 */

const pgHolder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('drizzle-orm/neon-serverless', () => ({ drizzle: vi.fn(() => pgHolder.db) }));

const SECRET = 'test-session-secret-for-signin-confirm-tests';
const SITE = 'https://site.example.test';
const NOT_VALID = '/signup?signup=expired';
const MIGRATIONS = ['0000_magic_link_used.sql', '0001_magic_link_rate.sql'].map(
  (f) => new URL(`../migrations/${f}`, import.meta.url),
);

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  for (const migration of MIGRATIONS) await pg.exec(readFileSync(migration, 'utf8'));
  pgHolder.db = drizzle({ client: pg, schema: usedTokenSchema });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec('TRUNCATE site_magic_link_used, site_magic_link_rate');
  for (const level of ['error', 'warn', 'log', 'info', 'debug'] as const) vi.spyOn(console, level).mockImplementation(() => {});
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('EMAIL_API_URL', 'https://email.example.test/send');
  vi.stubEnv('EMAIL_API_KEY', 'test-email-api-key');
  vi.stubEnv('EMAIL_FROM', 'signin@example.test');
  vi.stubEnv('SITE_BASE_URL', SITE);
  vi.stubEnv('VERCEL_URL', '');
  vi.stubEnv('DATABASE_URL', 'postgresql://test-user:test-password@db.site.test/site');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const usedCount = async () => (await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM site_magic_link_used')).rows[0]!.n;

/** Opens the emailed link: renders the confirm page for this token. */
const openPage = async (token: string) =>
  renderToStaticMarkup(await SigninPage({ searchParams: Promise.resolve({ token }) }));

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

const getCallback = (token: string) =>
  GET(new Request(`${SITE}${CALLBACK_PATH}?${new URLSearchParams({ token })}`));

const post = (token: string, headers: Record<string, string> = { origin: SITE }) =>
  POST(
    new Request(`${SITE}${CALLBACK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ token }).toString(),
    }),
  );

const unescape = (html: string) => html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

/** The honest failure when a link is present but it cannot be checked. Nothing is signed in. */
function expectCouldNotCheck(html: string) {
  const text = unescape(html)
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ');
  expect(text).toContain(
    "We couldn't check your sign-in link just now, so no one was signed in and the link hasn't been used. Try it again in a few minutes, or request a new link.",
  );
  expect(html).toContain(`<a href="${SIGNUP_PATH}">request a new link</a>`);
  expect(html).not.toContain('<form');
}

describe('GET of the emailed link', () => {
  it('renders a confirm page with a "Sign in" button that POSTs the token, and writes nothing', async () => {
    const token = await createLinkToken('ada@example.com', SECRET);
    const html = await openPage(token);
    expect(html).toContain('<h1>Sign in</h1>');
    expect(html).toContain('ada@example.com');
    const form = html.match(/<form\b[^>]*>/)?.[0] ?? '';
    expect(form).toContain(`action="${CALLBACK_PATH}"`);
    expect(form).toContain('method="post"');
    expect(unescape(html)).toContain(`name="token" value="${token}"`);
    expect(html).toMatch(/<button type="submit">Sign in<\/button>/);
    expect(await usedCount()).toBe(0);
  });

  it('keeps the token out of Referer headers and search engines', () => {
    expect(metadata.referrer).toBe('no-referrer');
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it('a GET on the callback URL sets no cookie and only forwards to the confirm page', async () => {
    const token = await createLinkToken('ada@example.com', SECRET);
    const res = await getCallback(token);
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toBeNull();
    const location = new URL(res.headers.get('location')!, SITE);
    expect(location.pathname).toBe(CONFIRM_PATH);
    expect(location.searchParams.get('token')).toBe(token);
    expect(await usedCount()).toBe(0);
  });

  it('leaves the link usable after repeated GETs, as a mail scanner would make', async () => {
    const token = await createLinkToken('ada@example.com', SECRET);
    for (let i = 0; i < 5; i++) {
      await openPage(token);
      expect((await getCallback(token)).headers.get('set-cookie')).toBeNull();
    }
    expect(await usedCount()).toBe(0);
    const res = await post(token);
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
  });

  it('sends a used, expired or tampered link to the same generic error', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
    const used = await createLinkToken('ada@example.com', SECRET);
    await post(used);
    const expiring = await createLinkToken('grace@example.com', SECRET);
    const forged = await createLinkToken('ada@example.com', 'another-secret-that-is-long-enough-to-use');

    expect(await redirectOf(() => openPage(used))).toBe(NOT_VALID);
    expect(await redirectOf(() => openPage(forged))).toBe(NOT_VALID);
    vi.setSystemTime(new Date('2026-10-21T12:15:01Z'));
    expect(await redirectOf(() => openPage(expiring))).toBe(NOT_VALID);
  });

  it('sends a visit with no token to the signup page, even when auth is not configured', async () => {
    expect(await redirectOf(() => SigninPage({ searchParams: Promise.resolve({}) }))).toBe(SIGNUP_PATH);
    vi.stubEnv('SESSION_SECRET', '');
    vi.stubEnv('EMAIL_API_URL', '');
    vi.stubEnv('EMAIL_API_KEY', '');
    vi.stubEnv('EMAIL_FROM', '');
    vi.stubEnv('DATABASE_URL', '');
    expect(await redirectOf(() => SigninPage({ searchParams: Promise.resolve({}) }))).toBe(SIGNUP_PATH);
    expect(await redirectOf(() => SigninPage({ searchParams: Promise.resolve({ token: ['a', 'b'] }) }))).toBe(
      SIGNUP_PATH,
    );
    expect(await usedCount()).toBe(0);
  });

  it('says the link could not be checked, and redirects nowhere, when the database is not configured', async () => {
    const token = await createLinkToken('ada@example.com', SECRET);
    vi.stubEnv('DATABASE_URL', '');
    const html = await openPage(token);
    expectCouldNotCheck(html);
    expect(await usedCount()).toBe(0);
  });

  it('says the link could not be checked when a token is present but auth is not configured', async () => {
    const token = await createLinkToken('ada@example.com', SECRET);
    vi.stubEnv('SESSION_SECRET', '');
    const html = await openPage(token);
    expectCouldNotCheck(html);
    expect(html).not.toContain('ada@example.com');
    expect(await usedCount()).toBe(0);
  });
});

describe('POST from the confirm page', () => {
  it('uses up the link and signs in; a second POST of the same link is refused', async () => {
    const token = await createLinkToken('ada@example.com', SECRET);
    const first = await post(token);
    expect(first.status).toBe(303);
    expect(first.headers.get('location')).toBe(CHECKOUT_PATH);
    expect(first.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(await usedCount()).toBe(1);

    const second = await post(token);
    expect(second.status).toBe(303);
    expect(second.headers.get('location')).toBe(NOT_VALID);
    expect(second.headers.get('set-cookie')).toBeNull();
  });

  it('refuses an expired or tampered link with the generic error, before any write', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
    const token = await createLinkToken('ada@example.com', SECRET);
    const forged = await createLinkToken('ada@example.com', 'another-secret-that-is-long-enough-to-use');
    const bad = [await post(forged)];
    vi.setSystemTime(new Date('2026-10-21T12:15:01Z'));
    bad.push(await post(token));
    for (const res of bad) {
      expect(res.headers.get('location')).toBe(NOT_VALID);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    expect(await usedCount()).toBe(0);
  });

  describe('CSRF', () => {
    it.each<[string, Record<string, string>]>([
      ['another origin', { origin: 'https://evil.example' }],
      ['an http origin for an https site', { origin: 'http://site.example.test' }],
      ['an opaque null origin', { origin: 'null' }],
      ['no Origin and a cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
      ['no Origin and no fetch metadata', {}],
      ['a spoofed Host and X-Forwarded-Host', { origin: 'https://evil.example', host: 'evil.example', 'x-forwarded-host': 'evil.example' }],
    ])('refuses a POST from %s with 403, no cookie, and the link still usable', async (_, headers) => {
      const token = await createLinkToken('ada@example.com', SECRET);
      const res = await post(token, headers);
      expect(res.status).toBe(403);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(await usedCount()).toBe(0);
      expect((await post(token)).headers.get('set-cookie')).not.toBeNull();
    });

    it('accepts a same-origin POST that carries Sec-Fetch-Site instead of Origin', async () => {
      const token = await createLinkToken('ada@example.com', SECRET);
      const res = await post(token, { 'sec-fetch-site': 'same-origin' });
      expect(res.headers.get('set-cookie')).not.toBeNull();
    });

    it('fails closed with 403 when the site has no base URL to compare against', async () => {
      vi.stubEnv('SITE_BASE_URL', '');
      const token = await createLinkToken('ada@example.com', SECRET);
      expect((await post(token)).status).toBe(403);
      expect(await usedCount()).toBe(0);
    });
  });

  it('reads the token only from a small form body, never the query string', async () => {
    const token = await createLinkToken('ada@example.com', SECRET);
    const viaQuery = await POST(
      new Request(`${SITE}${CALLBACK_PATH}?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE },
        body: '',
      }),
    );
    expect(viaQuery.headers.get('location')).toBe(NOT_VALID);
    const viaJson = await POST(
      new Request(`${SITE}${CALLBACK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: SITE },
        body: JSON.stringify({ token }),
      }),
    );
    expect(viaJson.headers.get('location')).toBe(NOT_VALID);
    expect(await usedCount()).toBe(0);
  });
});

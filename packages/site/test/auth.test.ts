import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { POST } from '../app/api/auth/magic-link/route.js';
import { GET } from '../app/api/auth/callback/route.js';
import SignupPage, { metadata } from '../app/signup/page.js';
import { BRAND } from '../src/brand.js';
import { AUTH_ENV, MAGIC_LINK_PATH, linkBase } from '../src/auth/email.js';
import {
  CALLBACK_PATH,
  CHECKOUT_PATH,
  SESSION_COOKIE,
  accountIdFor,
  createLinkToken,
  getSignedInAccount,
  sessionCookie,
  verifyLinkToken,
} from '../src/auth/session.js';
import { usedTokenSchema } from '../src/auth/used-tokens.js';

/**
 * Magic-link signup: the send route, the callback, the session cookie and the
 * account id. The email provider's fetch is mocked throughout, and the callback's
 * used-link table is PGlite in process: nothing here touches the network.
 */

const pgHolder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('drizzle-orm/neon-serverless', () => ({ drizzle: vi.fn(() => pgHolder.db) }));

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  for (const migration of ['0000_magic_link_used.sql', '0001_magic_link_rate.sql']) {
    await pg.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }
  pgHolder.db = drizzle({ client: pg, schema: usedTokenSchema });
});

afterAll(async () => {
  await pg.close();
});

const SECRET = 'test-session-secret-for-auth-tests-only';
const OTHER_SECRET = 'test-session-secret-rotated-for-auth-tests';
const EMAIL_API_URL = 'https://email.example.test/send';
const EMAIL_API_KEY = 'test-email-api-key';
const EMAIL_FROM = 'signin@example.test';
const SITE = 'https://site.example.test';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let fetchMock: Mock;
let logged: string[];

beforeEach(async () => {
  // Each test starts with fresh send counts; rate-limit.test.ts covers the limits.
  await pg.exec('TRUNCATE site_magic_link_rate, site_magic_link_used');
  fetchMock = vi.fn(async () => new Response('{"id":"test-message"}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  logged = [];
  for (const level of ['error', 'warn', 'log', 'info', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  }
  vi.stubEnv('MAGIC_LINK_ENABLED', '1');
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('EMAIL_API_URL', EMAIL_API_URL);
  vi.stubEnv('EMAIL_API_KEY', EMAIL_API_KEY);
  vi.stubEnv('EMAIL_FROM', EMAIL_FROM);
  vi.stubEnv('SITE_BASE_URL', SITE);
  vi.stubEnv('VERCEL_URL', '');
  vi.stubEnv('DATABASE_URL', 'postgresql://test-user:test-password@db.site.test/site');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const sendJson = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request(`http://site.test${MAGIC_LINK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

const sendForm = (fields: Record<string, string>) =>
  POST(
    new Request(`http://site.test${MAGIC_LINK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    }),
  );

/** Clicks a link: the callback URL with the given query parameters. */
const callback = (params: Record<string, string>) => {
  const url = new URL(CALLBACK_PATH, 'http://site.test');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return GET(new Request(url));
};

const withCookie = (setCookie: string) =>
  new Request('http://site.test/checkout', { headers: { cookie: setCookie.split(';')[0] ?? '' } });

/** What the last call to the email provider carried. */
function sentEmail(): { url: string; init: RequestInit; body: Record<string, unknown>; text: string } {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  const body = JSON.parse(String(call[1].body)) as Record<string, unknown>;
  return { url: call[0], init: call[1], body, text: String(body.text) };
}

function sentLink(): URL {
  const urls = sentEmail().text.match(/https?:\/\/\S+/g) ?? [];
  expect(urls).toHaveLength(1);
  return new URL(urls[0]!);
}

const sentToken = () => sentLink().searchParams.get('token') ?? '';

const expectedId = (normalized: string) =>
  `acct_${createHash('sha256').update(`site-account:v1:${normalized}`).digest('hex')}`;

/** Flips one character of a base64url string at the given index. */
const flip = (text: string, at: number) =>
  text.slice(0, at) + (text[at] === 'A' ? 'B' : 'A') + text.slice(at + 1);

const parts = (token: string) => token.split('.') as [string, string];

describe('launch guard', () => {
  it.each([undefined, '', '0', 'true', 'yes'])('MAGIC_LINK_ENABLED=%j: 503 and nothing sent', async (value) => {
    if (value === undefined) delete process.env.MAGIC_LINK_ENABLED;
    else vi.stubEnv('MAGIC_LINK_ENABLED', value);
    const res = await sendJson({ email: 'ada@example.com' });
    expect(res.status).toBe(503);
    const { error } = await res.json();
    expect(error.code).toBe('SIGNUP_UNAVAILABLE');
    expect(error.fix.note).toContain('MAGIC_LINK_ENABLED=1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redirects a form post back with signup=unavailable', async () => {
    vi.stubEnv('MAGIC_LINK_ENABLED', '');
    const res = await sendForm({ email: 'ada@example.com' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/signup?signup=unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('configuration', () => {
  it.each(AUTH_ENV)('with %s unset, both routes answer 503 and nothing is sent', async (name) => {
    const token = await createLinkToken('ada@example.com', SECRET);
    vi.stubEnv(name, '');

    const send = await sendJson({ email: 'ada@example.com' });
    expect(send.status).toBe(503);
    expect((await send.json()).error.fix.note).toContain(name);

    const click = await callback({ token });
    expect(click.status).toBe(503);
    expect(click.headers.get('set-cookie')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged.join('\n')).toContain(name);
  });

  it('treats a SESSION_SECRET shorter than 32 characters as unset', async () => {
    vi.stubEnv('SESSION_SECRET', 'test-too-short');
    expect((await sendJson({ email: 'ada@example.com' })).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged.join('\n')).not.toContain('test-too-short');
  });

  it('treats an EMAIL_API_URL that is not https as unset', async () => {
    vi.stubEnv('EMAIL_API_URL', 'http://email.example.test/send');
    expect((await sendJson({ email: 'ada@example.com' })).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged.join('\n')).not.toContain('email.example.test');
  });
});

describe('sending a link', () => {
  it('sends one email through the configured provider and answers 200', async () => {
    const res = await sendJson({ email: 'ada@example.com' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const { url, init, body } = sentEmail();
    expect(url).toBe(EMAIL_API_URL);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${EMAIL_API_KEY}`);
    expect(body).toMatchObject({ from: EMAIL_FROM, to: 'ada@example.com' });
    expect(String(body.subject)).toContain(BRAND.name);
  });

  it('sends to the normalized address', async () => {
    await sendJson({ email: '  Ada@Example.COM ' });
    expect(sentEmail().body.to).toBe('ada@example.com');
  });

  it('redirects a native form post back to the page with signup=sent', async () => {
    const res = await sendForm({ email: 'ada@example.com' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/signup?signup=sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('answers the same whether or not the address already has an account', async () => {
    const first = await sendJson({ email: 'ada@example.com' });
    const signedUp = await callback({ token: sentToken() });
    expect(signedUp.headers.get('location')).toBe(CHECKOUT_PATH);

    const existing = await sendJson({ email: 'ada@example.com' });
    const fresh = await sendJson({ email: 'grace@example.com' });
    const answer = async (res: Response) => ({
      status: res.status,
      body: await res.text(),
      headers: [...res.headers].filter(([key]) => key !== 'date'),
    });
    const expected = await answer(first);
    expect(await answer(existing)).toEqual(expected);
    expect(await answer(fresh)).toEqual(expected);
  });

  it.each(['', 'ada', 'ada@example', 'ada lovelace@example.com', `${'a'.repeat(250)}@example.com`])(
    'rejects the email %j and sends nothing',
    async (email) => {
      const res = await sendJson({ email });
      expect(res.status).toBe(400);
      const { error } = await res.json();
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.fix.note).toContain('email');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('rejects a body that is not JSON or is oversized, and sends nothing', async () => {
    for (const body of ['not json', '[1]', 'null', JSON.stringify({ email: 'ada@example.com', pad: 'x'.repeat(5000) })]) {
      expect((await sendJson(body)).status, body.slice(0, 20)).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redirects an invalid form post back with signup=invalid', async () => {
    const res = await sendForm({ email: 'not-an-email' });
    expect(res.headers.get('location')).toBe('/signup?signup=invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 502 when the provider rejects or fetch throws, logging only a status or error name', async () => {
    fetchMock.mockResolvedValueOnce(new Response(`bad key ${EMAIL_API_KEY}`, { status: 401 }));
    const rejected = await sendJson({ email: 'ada@example.com' });
    expect(rejected.status).toBe(502);
    expect((await rejected.json()).error).toMatchObject({ code: 'EMAIL_SEND_FAILED', retryable: true });

    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed: ${EMAIL_API_URL}`));
    expect((await sendJson({ email: 'ada@example.com' })).status).toBe(502);

    const log = logged.join('\n');
    expect(log).toContain('HTTP 401');
    expect(log).toContain('TypeError');
    expect(log).not.toContain('email.example.test');
    expect(log).not.toContain(EMAIL_API_KEY);
  });

  it('never logs or returns a secret, token, address or email body', async () => {
    const res = await sendJson({ email: 'ada@example.com' });
    const token = sentToken();
    const click = await callback({ token });
    const exposed = [
      await res.text(),
      JSON.stringify([...res.headers]),
      JSON.stringify([...click.headers].filter(([key]) => key !== 'set-cookie')),
      ...logged,
    ].join('\n');
    for (const secret of [SECRET, EMAIL_API_KEY, token, parts(token)[1], 'ada@example.com', sentEmail().text]) {
      expect(exposed).not.toContain(secret);
    }
  });
});

describe('the email', () => {
  it('holds only the link, the 15-minute expiry and the ignore line', async () => {
    await sendJson({ email: 'ada@example.com' });
    const { body, text } = sentEmail();
    expect(Object.keys(body).sort()).toEqual(['from', 'subject', 'text', 'to']);
    expect(text).not.toMatch(/<img|<[a-z]|pixel|unsubscribe/i);

    const lines = text.split('\n').filter((line) => line.trim() !== '');
    expect(lines).toEqual([
      sentLink().toString(),
      'This link expires in 15 minutes.',
      "If you didn't ask for this, ignore this email.",
    ]);
    // No other URL or bare domain anywhere in the message.
    expect(text.match(/https?:\/\//g)).toHaveLength(1);
    expect(text.replace(sentLink().toString(), '')).not.toMatch(/www\.|\.(com|test|dev|io)\b/);
  });

  it('links to the base plus the fixed callback path, carrying only the token', async () => {
    await sendJson({ email: 'ada@example.com' });
    const link = sentLink();
    expect(link.origin).toBe(SITE);
    expect(link.pathname).toBe(CALLBACK_PATH);
    expect([...link.searchParams.keys()]).toEqual(['token']);
    expect(link.hash).toBe('');
  });
});

describe('link base', () => {
  const brand = BRAND as { domain: string | null };
  afterEach(() => {
    brand.domain = null;
  });

  it('prefers BRAND.domain over SITE_BASE_URL and VERCEL_URL', async () => {
    brand.domain = 'brand.example.test';
    vi.stubEnv('VERCEL_URL', 'preview.example.test');
    await sendJson({ email: 'ada@example.com' });
    expect(sentLink().origin).toBe('https://brand.example.test');
  });

  it('uses SITE_BASE_URL next, ahead of VERCEL_URL', async () => {
    vi.stubEnv('VERCEL_URL', 'preview.example.test');
    await sendJson({ email: 'ada@example.com' });
    expect(sentLink().origin).toBe(SITE);
  });

  it('falls back to https plus VERCEL_URL', async () => {
    vi.stubEnv('SITE_BASE_URL', '');
    vi.stubEnv('VERCEL_URL', 'preview.example.test');
    await sendJson({ email: 'ada@example.com' });
    expect(sentLink().origin).toBe('https://preview.example.test');
  });

  it('refuses with 503 and sends nothing when there is no base', async () => {
    vi.stubEnv('SITE_BASE_URL', '');
    const res = await sendJson({ email: 'ada@example.com' }, { host: 'attacker.example' });
    expect(res.status).toBe(503);
    expect((await res.json()).error.fix.note).toContain('SITE_BASE_URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a SITE_BASE_URL that is not https (http only for localhost)', () => {
    vi.stubEnv('SITE_BASE_URL', 'http://site.example.test');
    expect(linkBase()).toBeNull();
    vi.stubEnv('SITE_BASE_URL', 'javascript:alert(1)');
    expect(linkBase()).toBeNull();
    vi.stubEnv('SITE_BASE_URL', 'http://localhost:3000/ignored/path');
    expect(linkBase()).toBe('http://localhost:3000');
  });

  it('refuses a VERCEL_URL that is not a bare host', () => {
    vi.stubEnv('SITE_BASE_URL', '');
    vi.stubEnv('VERCEL_URL', 'evil.example/@site.example.test');
    expect(linkBase()).toBeNull();
  });

  it('ignores a spoofed Host or X-Forwarded-Host header', async () => {
    await sendJson(
      { email: 'ada@example.com' },
      { host: 'attacker.example', 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http' },
    );
    expect(sentLink().origin).toBe(SITE);
    expect(sentEmail().text).not.toContain('attacker');
  });
});

describe('link tokens', () => {
  it('verifies a genuine token and carries the normalized email and a 128-bit jti', async () => {
    const claims = await verifyLinkToken(await createLinkToken(' Ada@Example.com', SECRET), SECRET);
    expect(claims).toMatchObject({ typ: 'link', email: 'ada@example.com' });
    expect(claims?.jti).toMatch(/^[0-9a-f]{32}$/);
  });

  it('gives every token its own jti', async () => {
    const a = await verifyLinkToken(await createLinkToken('ada@example.com', SECRET), SECRET);
    const b = await verifyLinkToken(await createLinkToken('ada@example.com', SECRET), SECRET);
    expect(a?.jti).not.toBe(b?.jti);
  });

  it('expires after 15 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    const token = await createLinkToken('ada@example.com', SECRET);
    vi.setSystemTime(new Date('2026-10-20T12:14:59Z'));
    expect(await verifyLinkToken(token, SECRET)).not.toBeNull();
    vi.setSystemTime(new Date('2026-10-20T12:15:00Z'));
    expect(await verifyLinkToken(token, SECRET)).toBeNull();
  });

  it('rejects a token whose claims or signature were tampered with', async () => {
    const [body, sig] = parts(await createLinkToken('ada@example.com', SECRET));
    for (let at = 0; at < body.length; at += 7) {
      expect(await verifyLinkToken(`${flip(body, at)}.${sig}`, SECRET), `body ${at}`).toBeNull();
    }
    for (let at = 0; at < sig.length - 1; at += 5) {
      expect(await verifyLinkToken(`${body}.${flip(sig, at)}`, SECRET), `sig ${at}`).toBeNull();
    }
    for (const bad of ['', body, `${body}.`, `.${sig}`, `${body}.${sig}.${sig}`, `${body}.!!`]) {
      expect(await verifyLinkToken(bad, SECRET), bad).toBeNull();
    }
  });

  it('rejects a token signed for another email', async () => {
    const [, adaSig] = parts(await createLinkToken('ada@example.com', SECRET));
    const [graceBody] = parts(await createLinkToken('grace@example.com', SECRET));
    // Grace's claims under Ada's signature.
    expect(await verifyLinkToken(`${graceBody}.${adaSig}`, SECRET)).toBeNull();

    // Ada's claims rewritten to Grace's address, keeping Ada's signature.
    const [adaBody] = parts(await createLinkToken('ada@example.com', SECRET));
    const claims = JSON.parse(Buffer.from(adaBody, 'base64url').toString('utf8'));
    const forged = Buffer.from(JSON.stringify({ ...claims, email: 'grace@example.com' })).toString('base64url');
    expect(await verifyLinkToken(`${forged}.${adaSig}`, SECRET)).toBeNull();
  });

  it('rejects a token signed with another secret, and a session cookie offered as a link', async () => {
    expect(await verifyLinkToken(await createLinkToken('ada@example.com', OTHER_SECRET), SECRET)).toBeNull();
    const cookieValue = (await sessionCookie(await accountIdFor('ada@example.com'), SECRET)).split(';')[0]!;
    expect(await verifyLinkToken(cookieValue.slice(SESSION_COOKIE.length + 1), SECRET)).toBeNull();
  });

  it('checks signatures with crypto.subtle.verify only, never by signing again and comparing', async () => {
    const token = await createLinkToken('ada@example.com', SECRET);
    const cookie = await sessionCookie(await accountIdFor('ada@example.com'), SECRET);
    const verify = vi.spyOn(crypto.subtle, 'verify');
    const sign = vi.spyOn(crypto.subtle, 'sign');

    expect(await verifyLinkToken(token, SECRET)).not.toBeNull();
    expect(await getSignedInAccount(withCookie(cookie))).not.toBeNull();
    const [body, sig] = parts(token);
    expect(await verifyLinkToken(`${body}.${flip(sig, 0)}`, SECRET)).toBeNull();

    expect(verify).toHaveBeenCalledTimes(3);
    expect(sign).not.toHaveBeenCalled();
  });
});

describe('callback', () => {
  it('sets a 7-day HttpOnly, Secure, SameSite=Lax session cookie and redirects to checkout', async () => {
    await sendJson({ email: 'ada@example.com' });
    const res = await callback({ token: sentToken() });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(CHECKOUT_PATH);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    const attributes = cookie.split(';').slice(1).map((a) => a.trim());
    expect(attributes).toEqual(
      expect.arrayContaining(['Path=/', 'Max-Age=604800', 'HttpOnly', 'Secure', 'SameSite=Lax']),
    );
    expect(cookie).not.toMatch(/Domain=/i);

    expect(await getSignedInAccount(withCookie(cookie))).toEqual({ accountId: expectedId('ada@example.com') });
  });

  it.each<Record<string, string>>([
    { next: 'https://evil.example/steal' },
    { redirect: '//evil.example' },
    { redirect_uri: 'https://evil.example', returnTo: '/admin', url: 'javascript:alert(1)' },
  ])('ignores %j and always redirects to checkout', async (extra) => {
    await sendJson({ email: 'ada@example.com' });
    const res = await callback({ token: sentToken(), ...extra });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(CHECKOUT_PATH);
  });

  it('sends a missing, expired or tampered token back to signup without a cookie', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    await sendJson({ email: 'ada@example.com' });
    const token = sentToken();
    const [body, sig] = parts(token);

    const bad = [
      await callback({}),
      await callback({ token: `${body}.${flip(sig, 3)}`, next: 'https://evil.example' }),
    ];
    vi.setSystemTime(new Date('2026-10-20T12:15:01Z'));
    bad.push(await callback({ token }));

    for (const res of bad) {
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/signup?signup=expired');
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });
});

describe('session cookie', () => {
  it('rejects an expired signed exp even when the browser still sends the cookie', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    const cookie = await sessionCookie(await accountIdFor('ada@example.com'), SECRET);
    vi.setSystemTime(new Date(Date.parse('2026-10-20T12:00:00Z') + 7 * DAY - MINUTE));
    expect(await getSignedInAccount(withCookie(cookie))).not.toBeNull();
    vi.setSystemTime(new Date(Date.parse('2026-10-20T12:00:00Z') + 7 * DAY));
    expect(await getSignedInAccount(withCookie(cookie))).toBeNull();
  });

  it('rejects a tampered cookie, a link token as a cookie, and a cookie from another secret', async () => {
    const cookie = await sessionCookie(await accountIdFor('ada@example.com'), SECRET);
    const value = cookie.split(';')[0]!.slice(SESSION_COOKIE.length + 1);
    const [body, sig] = parts(value);
    const as = (v: string) => withCookie(`${SESSION_COOKIE}=${v}`);

    expect(await getSignedInAccount(as(`${flip(body, 10)}.${sig}`))).toBeNull();
    expect(await getSignedInAccount(as(`${body}.${flip(sig, 10)}`))).toBeNull();
    expect(await getSignedInAccount(as(await createLinkToken('ada@example.com', SECRET)))).toBeNull();
    const other = await sessionCookie(await accountIdFor('ada@example.com'), OTHER_SECRET);
    expect(await getSignedInAccount(withCookie(other))).toBeNull();
  });

  it('reads the cookie among others and returns null without one or without SESSION_SECRET', async () => {
    const cookie = (await sessionCookie(await accountIdFor('ada@example.com'), SECRET)).split(';')[0]!;
    const mixed = new Request('http://site.test/', { headers: { cookie: `theme=dark; ${cookie}; other=1` } });
    expect(await getSignedInAccount(mixed)).toEqual({ accountId: expectedId('ada@example.com') });
    expect(await getSignedInAccount(new Request('http://site.test/'))).toBeNull();
    vi.stubEnv('SESSION_SECRET', '');
    expect(await getSignedInAccount(mixed)).toBeNull();
  });
});

describe('account id', () => {
  it('is acct_ plus the full hex SHA-256 of the prefixed, normalized email', async () => {
    const id = await accountIdFor(' A@B.com ');
    expect(id).toMatch(/^acct_[0-9a-f]{64}$/);
    expect(id).toBe(await accountIdFor('a@b.com'));
    expect(id).toBe(expectedId('a@b.com'));
  });

  it('keeps dots and +tags', async () => {
    expect(await accountIdFor('a.b+x@b.com')).not.toBe(await accountIdFor('ab@b.com'));
    expect(await accountIdFor('a.b@b.com')).not.toBe(await accountIdFor('ab@b.com'));
  });

  it('gives the same account through signup for " A@B.com " and "a@b.com"', async () => {
    const signIn = async (email: string) => {
      await sendJson({ email });
      const res = await callback({ token: sentToken() });
      return getSignedInAccount(withCookie(res.headers.get('set-cookie') ?? ''));
    };
    const spaced = await signIn(' A@B.com ');
    expect(spaced).toEqual({ accountId: expectedId('a@b.com') });
    expect(await signIn('a@b.com')).toEqual(spaced);
  });

  it('does not change when SESSION_SECRET is rotated', async () => {
    const signIn = async () => {
      await sendJson({ email: 'ada@example.com' });
      const res = await callback({ token: sentToken() });
      return getSignedInAccount(withCookie(res.headers.get('set-cookie') ?? ''));
    };
    const before = await signIn();
    vi.stubEnv('SESSION_SECRET', OTHER_SECRET);
    const after = await signIn();
    expect(after).toEqual(before);
    expect(after?.accountId).toBe(expectedId('ada@example.com'));
  });
});

describe('signup page', () => {
  const render = async (signup?: string) =>
    renderToStaticMarkup(await SignupPage({ searchParams: Promise.resolve(signup ? { signup } : {}) }));

  it('posts a required email field to the magic-link route', async () => {
    const html = await render();
    expect(html).toContain(`action="${MAGIC_LINK_PATH}"`);
    expect(html).toContain('method="post"');
    const input = /<input\b[^>]*\bname="email"[^>]*>/.exec(html)?.[0] ?? '';
    expect(input).toContain('type="email"');
    expect(input).toContain('required=""');
  });

  it('takes brand text from BRAND', () => {
    expect(metadata.title).toBe(`Sign up: ${BRAND.name}`);
    expect(metadata.description).toContain(BRAND.name);
  });

  it('shows the outcome it was redirected back with, and nothing for an unknown one', async () => {
    expect(await render('sent')).toContain('<p role="status">If that address can receive email');
    expect(await render('expired')).toContain('not valid or has expired');
    expect(await render('unavailable')).toContain('not open yet');
    expect(await render('<script>')).not.toContain('role="status"');
    expect(await render()).not.toContain('role="status"');
  });
});

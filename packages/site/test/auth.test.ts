import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { POST } from '../app/api/auth/magic-link/route.js';
import { GET } from '../app/api/auth/callback/route.js';
import SignupPage from '../app/signup/page.js';
import { magicLinkEmail } from '../src/auth/email.js';
import {
  CALLBACK_PATH,
  LINK_TTL_SECONDS,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  accountIdFor,
  createMagicLinkToken,
  getSignedInAccount,
  resolveLinkBase,
  sessionCookie,
  verifyMagicLinkToken,
} from '../src/auth/session.js';

/**
 * Email magic-link signup (#55). The email provider is a mocked global fetch,
 * so nothing here touches the network.
 */

const SECRET = 'test-session-secret-000000000000000';
const OTHER_SECRET = 'test-other-session-secret-111111111';
const BASE = 'https://site.test';
const ENV = {
  MAGIC_LINK_ENABLED: '1',
  SESSION_SECRET: SECRET,
  EMAIL_API_URL: 'https://email.test/send',
  EMAIL_API_KEY: 'test-email-api-key',
  EMAIL_FROM: 'signin@site.test',
  SITE_BASE_URL: BASE,
} as const;
const KEYS = [...Object.keys(ENV), 'VERCEL_URL'];
const REQUIRED = ['SESSION_SECRET', 'EMAIL_API_URL', 'EMAIL_API_KEY', 'EMAIL_FROM'] as const;

const saved = new Map<string, string | undefined>();
let fetchMock: Mock<(url: string, init: RequestInit) => Promise<Response>>;
let logged: MockInstance[];

beforeEach(() => {
  for (const k of KEYS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  Object.assign(process.env, ENV);
  fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
});

afterEach(() => {
  // Nothing in the auth path logs: no secret, token, address or email body.
  for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function send(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request('https://site.test/api/auth/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function callback(token: string | null, extra: Record<string, string> = {}): Promise<Response> {
  const url = new URL(CALLBACK_PATH, BASE);
  if (token !== null) url.searchParams.set('token', token);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return GET(new Request(url));
}

/** The provider request the route made, parsed. */
function sentEmail(call = 0) {
  const [url, init] = fetchMock.mock.calls[call]!;
  return { url, init, body: JSON.parse(init.body as string) as Record<string, string> };
}

function linkIn(text: string): URL {
  const urls = text.match(/https?:\/\/\S+/g) ?? [];
  expect(urls).toHaveLength(1);
  return new URL(urls[0]!);
}

const cookieValue = (setCookie: string) => setCookie.split(';')[0]!.slice(SESSION_COOKIE.length + 1);
const withCookie = (value: string) =>
  new Request('https://site.test/checkout', { headers: { cookie: `other=1; ${SESSION_COOKIE}=${value}` } });

describe('launch guard and configuration', () => {
  it('returns 503 and sends nothing while MAGIC_LINK_ENABLED is unset', async () => {
    delete process.env.MAGIC_LINK_ENABLED;
    const res = await send({ email: 'a@b.com' });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SIGNUP_UNAVAILABLE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['0', 'true', 'yes', ''])('treats MAGIC_LINK_ENABLED=%j as off', async (value) => {
    process.env.MAGIC_LINK_ENABLED = value;
    expect((await send({ email: 'a@b.com' })).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(REQUIRED)('returns 503 from both routes and sends nothing when %s is unset', async (name) => {
    const token = await createMagicLinkToken('a@b.com', SECRET);
    delete process.env[name];
    expect((await send({ email: 'a@b.com' })).status).toBe(503);
    const cb = await callback(token);
    expect(cb.status).toBe(503);
    expect(cb.headers.get('set-cookie')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a SESSION_SECRET shorter than 32 characters', async () => {
    process.env.SESSION_SECRET = 'test-short-secret';
    expect((await send({ email: 'a@b.com' })).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an EMAIL_API_URL that is not https', async () => {
    process.env.EMAIL_API_URL = 'http://email.test/send';
    expect((await send({ email: 'a@b.com' })).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to send when there is no link base', async () => {
    delete process.env.SITE_BASE_URL;
    const res = await send({ email: 'a@b.com' }, { host: 'evil.test', 'x-forwarded-host': 'evil.test' });
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never puts a secret in a 503', async () => {
    delete process.env.EMAIL_FROM;
    const text = await (await send({ email: 'a@b.com' })).text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(ENV.EMAIL_API_KEY);
  });
});

describe('link base', () => {
  it('prefers BRAND.domain, then SITE_BASE_URL, then VERCEL_URL', () => {
    const env = { SITE_BASE_URL: 'https://base.test', VERCEL_URL: 'app-x.vercel.test' };
    expect(resolveLinkBase(env, 'brand.test')).toBe('https://brand.test');
    expect(resolveLinkBase(env, null)).toBe('https://base.test');
    expect(resolveLinkBase({ VERCEL_URL: 'app-x.vercel.test' }, null)).toBe('https://app-x.vercel.test');
    expect(resolveLinkBase({}, null)).toBeNull();
  });

  it('refuses a base that is not an https origin rather than falling through', () => {
    expect(resolveLinkBase({ SITE_BASE_URL: 'http://base.test', VERCEL_URL: 'v.test' }, null)).toBeNull();
    expect(resolveLinkBase({ SITE_BASE_URL: 'not a url' }, null)).toBeNull();
    expect(resolveLinkBase({ SITE_BASE_URL: 'javascript:alert(1)' }, null)).toBeNull();
    expect(resolveLinkBase({ SITE_BASE_URL: 'https://user:pw@base.test' }, null)).toBeNull();
    expect(resolveLinkBase({ SITE_BASE_URL: 'http://localhost:3000' }, null)).toBe('http://localhost:3000');
  });

  it('ignores a spoofed Host header and the request URL', async () => {
    const res = await POST(
      new Request('https://evil.test/api/auth/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'evil.test', 'x-forwarded-host': 'evil.test' },
        body: JSON.stringify({ email: 'a@b.com' }),
      }),
    );
    expect(res.status).toBe(202);
    const link = linkIn(sentEmail().body.text!);
    expect(link.origin).toBe(BASE);
    expect(link.pathname).toBe(CALLBACK_PATH);
  });

  it('uses VERCEL_URL over https when nothing else is set', async () => {
    delete process.env.SITE_BASE_URL;
    process.env.VERCEL_URL = 'app-x.vercel.test';
    expect((await send({ email: 'a@b.com' })).status).toBe(202);
    expect(linkIn(sentEmail().body.text!).origin).toBe('https://app-x.vercel.test');
  });
});

describe('send-link route', () => {
  it('posts the email to the provider with the API key', async () => {
    expect((await send({ email: ' A@B.com ' })).status).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init, body } = sentEmail();
    expect(url).toBe(ENV.EMAIL_API_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${ENV.EMAIL_API_KEY}`);
    expect(Object.keys(body).sort()).toEqual(['from', 'subject', 'text', 'to']);
    expect(body.from).toBe(ENV.EMAIL_FROM);
    expect(body.to).toBe('a@b.com');
  });

  it('gives the same reply for every address and never returns the token or link', async () => {
    const replies: string[] = [];
    for (const email of ['a@b.com', 'a@b.com', 'new-person@c.test']) {
      const res = await send({ email });
      expect(res.status).toBe(202);
      replies.push(await res.text());
    }
    expect(new Set(replies).size).toBe(1);
    const token = linkIn(sentEmail().body.text!).searchParams.get('token')!;
    expect(replies[0]).not.toContain(token);
    expect(replies[0]).not.toContain(CALLBACK_PATH);
  });

  it('accepts a form post', async () => {
    const res = await POST(
      new Request('https://site.test/api/auth/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'email=a%40b.com',
      }),
    );
    expect(res.status).toBe(202);
    expect(sentEmail().body.to).toBe('a@b.com');
  });

  it.each([{}, { email: 'not-an-email' }, { email: 42 }, { email: `${'a'.repeat(260)}@b.com` }])(
    'rejects %j with 400 and sends nothing',
    async (body) => {
      const res = await send(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { fix: { note: string } } }).error.fix.note).toContain('email');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('returns 502 when the provider fails, without passing its reply on', async () => {
    fetchMock.mockResolvedValueOnce(new Response('provider-internal-detail', { status: 500 }));
    const res = await send({ email: 'a@b.com' });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('provider-internal-detail');
  });

  it('returns 502 when the provider is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await send({ email: 'a@b.com' })).status).toBe(502);
  });
});

describe('the email', () => {
  it('holds only the link, the 15-minute expiry and the ignore line', async () => {
    await send({ email: 'a@b.com' });
    const { text } = sentEmail().body;
    const paragraphs = text!.split('\n\n');
    expect(paragraphs).toHaveLength(3);
    const link = linkIn(text!);
    expect(paragraphs[0]).toBe(link.href);
    expect([...link.searchParams.keys()]).toEqual(['token']);
    expect(paragraphs[1]).toBe('This link expires in 15 minutes.');
    expect(paragraphs[2]).toMatch(/^If you didn't ask for this email, ignore it\.$/);
  });

  it('has no HTML, image or tracking pixel', async () => {
    await send({ email: 'a@b.com' });
    const { body } = sentEmail();
    expect(body).not.toHaveProperty('html');
    for (const part of [body.subject!, body.text!]) {
      expect(part).not.toMatch(/<img|<[a-z]/i);
    }
    expect(magicLinkEmail('https://x.test/l', 15).subject).not.toMatch(/https?:/);
  });
});

describe('magic-link token', () => {
  const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

  it('verifies for its own email and carries a 128-bit jti', async () => {
    const token = await createMagicLinkToken(' A@B.com ', SECRET, NOW);
    const claims = await verifyMagicLinkToken(token, SECRET, NOW);
    expect(claims?.email).toBe('a@b.com');
    expect(claims?.jti).toMatch(/^[0-9a-f]{32}$/);
    expect(claims?.exp).toBe(NOW / 1000 + LINK_TTL_SECONDS);
    const again = await verifyMagicLinkToken(await createMagicLinkToken('a@b.com', SECRET, NOW), SECRET, NOW);
    expect(again?.jti).not.toBe(claims?.jti);
  });

  it('is rejected once 15 minutes have passed', async () => {
    const token = await createMagicLinkToken('a@b.com', SECRET, NOW);
    expect(await verifyMagicLinkToken(token, SECRET, NOW + LINK_TTL_SECONDS * 1000 - 1000)).not.toBeNull();
    expect(await verifyMagicLinkToken(token, SECRET, NOW + LINK_TTL_SECONDS * 1000)).toBeNull();
  });

  it('is rejected when tampered with', async () => {
    const token = await createMagicLinkToken('a@b.com', SECRET, NOW);
    const [payload, sig] = token.split('.') as [string, string];
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
    for (const bad of [
      `${flip(payload, 5)}.${sig}`,
      `${payload}.${flip(sig, 3)}`,
      `${payload}.`,
      payload,
      `${payload}.${sig}.${sig}`,
      '',
      'garbage',
    ]) {
      expect(await verifyMagicLinkToken(bad, SECRET, NOW), bad).toBeNull();
    }
  });

  it('is rejected when its signature belongs to another email', async () => {
    const ours = await createMagicLinkToken('a@b.com', SECRET, NOW);
    const theirs = await createMagicLinkToken('victim@b.com', SECRET, NOW);
    const forged = `${theirs.split('.')[0]}.${ours.split('.')[1]}`;
    expect(await verifyMagicLinkToken(forged, SECRET, NOW)).toBeNull();
  });

  it('is rejected under another secret', async () => {
    const token = await createMagicLinkToken('a@b.com', OTHER_SECRET, NOW);
    expect(await verifyMagicLinkToken(token, SECRET, NOW)).toBeNull();
  });

  it('is not interchangeable with a session cookie', async () => {
    const cookie = cookieValue(await sessionCookie(await accountIdFor('a@b.com'), SECRET, NOW));
    expect(await verifyMagicLinkToken(cookie, SECRET, NOW)).toBeNull();
    const token = await createMagicLinkToken('a@b.com', SECRET, NOW);
    expect(await getSignedInAccount(withCookie(token), ENV, NOW)).toBeNull();
  });

  it('checks signatures with crypto.subtle.verify only', async () => {
    const verify = vi.spyOn(crypto.subtle, 'verify');
    const token = await createMagicLinkToken('a@b.com', SECRET, NOW);
    await verifyMagicLinkToken(token, SECRET, NOW);
    await getSignedInAccount(withCookie(cookieValue(await sessionCookie(await accountIdFor('a@b.com'), SECRET, NOW))), ENV, NOW);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify.mock.calls.every(([alg]) => alg === 'HMAC')).toBe(true);

    const src = readFileSync(new URL('../src/auth/session.ts', import.meta.url), 'utf8');
    expect(src).toContain('crypto.subtle.verify(');
    expect(src).not.toMatch(/timingSafeEqual/);
    // No signature is ever compared as a string.
    for (const line of src.split('\n')) {
      if (/sig/i.test(line)) expect(line, line).not.toMatch(/[!=]==?/);
    }
  });
});

describe('session cookie', () => {
  const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

  it('is HttpOnly, Secure, SameSite=Lax with a 7-day Max-Age', async () => {
    const header = await sessionCookie(await accountIdFor('a@b.com'), SECRET, NOW);
    const attrs = header.split('; ').slice(1);
    expect(SESSION_MAX_AGE_SECONDS).toBe(604_800);
    expect(attrs.sort()).toEqual(['HttpOnly', 'Max-Age=604800', 'Path=/', 'SameSite=Lax', 'Secure']);
  });

  it('reads back as the account until its signed exp, then is refused', async () => {
    const accountId = await accountIdFor('a@b.com');
    const req = withCookie(cookieValue(await sessionCookie(accountId, SECRET, NOW)));
    expect(await getSignedInAccount(req, ENV, NOW)).toEqual({ accountId });
    expect(await getSignedInAccount(req, ENV, NOW + (SESSION_MAX_AGE_SECONDS - 1) * 1000)).toEqual({ accountId });
    // The browser still sends it; the server refuses it anyway.
    expect(await getSignedInAccount(req, ENV, NOW + SESSION_MAX_AGE_SECONDS * 1000)).toBeNull();
  });

  it('is refused when missing, tampered with, under another secret or with auth unconfigured', async () => {
    const value = cookieValue(await sessionCookie(await accountIdFor('a@b.com'), SECRET, NOW));
    const [payload, sig] = value.split('.') as [string, string];
    expect(await getSignedInAccount(new Request(BASE), ENV, NOW)).toBeNull();
    expect(await getSignedInAccount(withCookie(`${payload}.${sig.slice(1)}`), ENV, NOW)).toBeNull();
    const forgedPayload = btoa(JSON.stringify({ typ: 'session', acct: await accountIdFor('victim@b.com'), exp: 9e9 }))
      .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    expect(await getSignedInAccount(withCookie(`${forgedPayload}.${sig}`), ENV, NOW)).toBeNull();
    expect(await getSignedInAccount(withCookie(value), { ...ENV, SESSION_SECRET: OTHER_SECRET }, NOW)).toBeNull();
    expect(await getSignedInAccount(withCookie(value), { ...ENV, SESSION_SECRET: undefined }, NOW)).toBeNull();
  });
});

describe('callback route', () => {
  it('sets the session and redirects to the checkout page', async () => {
    const res = await callback(await createMagicLinkToken('a@b.com', SECRET));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/checkout');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(await getSignedInAccount(withCookie(cookieValue(setCookie)))).toEqual({
      accountId: await accountIdFor('a@b.com'),
    });
  });

  it('ignores next, redirect and external-URL parameters', async () => {
    const token = await createMagicLinkToken('a@b.com', SECRET);
    const res = await callback(token, {
      next: 'https://evil.test/',
      redirect: '//evil.test',
      redirect_uri: 'https://evil.test/',
      returnTo: '/admin',
      url: 'https://evil.test/',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/checkout');
  });

  it('gives every bad link the same 400 and no cookie', async () => {
    const expired = await createMagicLinkToken('a@b.com', SECRET, Date.now() - (LINK_TTL_SECONDS + 1) * 1000);
    const foreign = await createMagicLinkToken('a@b.com', OTHER_SECRET);
    const bodies = new Set<string>();
    for (const token of [expired, foreign, 'garbage', null]) {
      const res = await callback(token);
      expect(res.status).toBe(400);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(res.headers.get('location')).toBeNull();
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
  });

  it('completes the round trip from the emailed link', async () => {
    await send({ email: ' New.Person+site@Example.com ' });
    const link = linkIn(sentEmail().body.text!);
    const res = await GET(new Request(link));
    expect(res.status).toBe(303);
    const account = await getSignedInAccount(withCookie(cookieValue(res.headers.get('set-cookie')!)));
    expect(account?.accountId).toBe(await accountIdFor('new.person+site@example.com'));
  });
});

describe('account id', () => {
  it('normalizes with trim and lowercase only', async () => {
    const id = await accountIdFor(' A@B.com ');
    expect(id).toMatch(/^acct_[0-9a-f]{64}$/);
    expect(await accountIdFor('a@b.com')).toBe(id);
    expect(await accountIdFor('a.b+x@b.com')).not.toBe(await accountIdFor('ab@b.com'));
  });

  it('is the full unkeyed SHA-256 of the prefixed email', async () => {
    const expected = createHash('sha256').update('site-account:v1:a@b.com', 'utf8').digest('hex');
    expect(await accountIdFor('a@b.com')).toBe(`acct_${expected}`);
  });

  it('does not change when SESSION_SECRET changes', async () => {
    const ids = [];
    for (const secret of [SECRET, OTHER_SECRET]) {
      process.env.SESSION_SECRET = secret;
      const res = await callback(await createMagicLinkToken('a@b.com', secret));
      ids.push((await getSignedInAccount(withCookie(cookieValue(res.headers.get('set-cookie')!))))?.accountId);
    }
    expect(ids[0]).toBe(await accountIdFor('a@b.com'));
    expect(ids[1]).toBe(ids[0]);
  });
});

describe('signup page', () => {
  // react-dom is a dependency of the site, not of the workspace root.
  const siteRequire = createRequire(new URL('../package.json', import.meta.url));
  const { renderToStaticMarkup } = siteRequire('react-dom/server') as typeof import('react-dom/server');
  const { createElement } = siteRequire('react') as typeof import('react');

  it('takes an email and posts it to the send-link route', () => {
    const html = renderToStaticMarkup(createElement(SignupPage));
    const form = /<form[^>]*>/.exec(html)?.[0];
    expect(form, html).toMatch(/method="post"/);
    expect(form, html).toMatch(/action="\/api\/auth\/magic-link"/);
    const input = /<input[^>]*>/.exec(html)?.[0];
    expect(input, html).toMatch(/name="email"/);
    expect(input, html).toMatch(/type="email"/);
    expect(html).toContain('15 minutes');
  });
});

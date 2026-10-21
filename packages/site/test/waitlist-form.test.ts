import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { POST } from '../app/api/contact/route.js';
import PricingPage from '../app/pricing/page.js';
import {
  WAITLIST_FIELDS,
  WAITLIST_MAX_LENGTH,
  WAITLIST_NEED,
  WaitlistForm,
  waitlistBody,
  waitlistResult,
} from '../app/pricing/waitlist-form.js';
import { usedTokenSchema } from '../src/auth/used-tokens.js';
import { CONTACT_PATH, FLEET_SIZES, HONEYPOT_FIELD } from '../src/contact.js';

/**
 * The Cloud waitlist form posts to the existing contact route with that route's
 * keys. The route runs for real here with the forward mocked; the rate limit's
 * Postgres is PGlite, in process, as in contact.test.ts.
 */

const pgHolder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('drizzle-orm/neon-serverless', () => ({ drizzle: vi.fn(() => pgHolder.db) }));

const RATE_MIGRATION = new URL('../migrations/0001_magic_link_rate.sql', import.meta.url);
const DATABASE_URL = ['postgresql:', '', 'test-user:test-password@db.site.test', 'site'].join('/');
const FORWARD_URL = 'https://forward.example.test/waitlist';

let pg: PGlite;
let fetchMock: Mock;

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(readFileSync(RATE_MIGRATION, 'utf8'));
  pgHolder.db = drizzle({ client: pg, schema: usedTokenSchema });
});
afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec('TRUNCATE site_magic_link_rate');
  fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('CONTACT_FORWARD_URL', FORWARD_URL);
  vi.stubEnv('DATABASE_URL', DATABASE_URL);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const html = renderToStaticMarkup(createElement(WaitlistForm));

/** The opening tag of the field named `name`. */
const field = (name: string) => new RegExp(`<(?:input|select|textarea)\\b[^>]*\\bname="${name}"[^>]*>`).exec(html)?.[0] ?? '';

const fieldNames = () => [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]);

const postToRoute = (body: unknown) =>
  POST(
    new Request(`http://site.test${CONTACT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const filled = (values: Record<string, string>) => waitlistBody(new Map(Object.entries(values)));

describe('waitlist form fields', () => {
  it('sends exactly the contact route keys', () => {
    expect([...WAITLIST_FIELDS]).toEqual(['name', 'email', 'company', 'fleetSize', 'need']);
    expect(fieldNames()).toEqual([...WAITLIST_FIELDS]);
    expect(Object.keys(filled({ name: 'x', [HONEYPOT_FIELD]: 'bot', extra: 'y' }))).toEqual([...WAITLIST_FIELDS]);
  });

  it('renders no honeypot and no payment fields', () => {
    expect(html).not.toContain(HONEYPOT_FIELD);
    expect(html).not.toMatch(/card|cvc|cvv|expiry|iban|billing|payment|checkout/i);
    expect(html).not.toMatch(/\baction=/);
  });

  it('offers the fleet sizes from FLEET_SIZES', () => {
    const options = [...html.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
    expect(options).toEqual([...FLEET_SIZES]);
  });

  it("caps each field at the route's limits", () => {
    expect(WAITLIST_MAX_LENGTH).toEqual({ name: 200, email: 254, company: 200, need: 5000 });
    for (const [name, max] of Object.entries(WAITLIST_MAX_LENGTH)) {
      expect(field(name), name).toContain(`maxLength="${max}"`);
    }
  });

  it('prefills need with the waitlist label', () => {
    expect(WAITLIST_NEED).toBe('Cloud early access waitlist');
    expect(html).toMatch(new RegExp(`<textarea\\b[^>]*name="need"[^>]*>${WAITLIST_NEED}</textarea>`));
  });

  it('is rendered on the Cloud card only', async () => {
    const page = renderToStaticMarkup(await PricingPage({ searchParams: Promise.resolve({}) }));
    const cloud = /<article data-tier="cloud">([\s\S]*?)<\/article>/.exec(page)?.[1] ?? '';
    expect(cloud).toContain('aria-label="Cloud early access waitlist"');
    expect(page.match(/aria-label="Cloud early access waitlist"/g)).toHaveLength(1);
  });
});

describe('waitlist body against the contact route', () => {
  it('passes validation and forwards once', async () => {
    const body = filled({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      company: 'Analytical Engines Ltd',
      fleetSize: FLEET_SIZES[1],
      need: WAITLIST_NEED,
    });
    const res = await postToRoute(body);
    expect(res.status).toBe(200);
    expect(waitlistResult(res.status, undefined)).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(FORWARD_URL);
    expect(JSON.parse(String(init.body))).toMatchObject(body);
  });

  it('passes at every maximum length', async () => {
    const domain = '@example.com';
    const body = filled({
      name: 'n'.repeat(WAITLIST_MAX_LENGTH.name),
      email: 'e'.repeat(WAITLIST_MAX_LENGTH.email - domain.length) + domain,
      company: 'c'.repeat(WAITLIST_MAX_LENGTH.company),
      fleetSize: FLEET_SIZES[0],
      need: 'w'.repeat(WAITLIST_MAX_LENGTH.need),
    });
    expect(body.email).toHaveLength(254);
    const res = await postToRoute(body);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads an invalid answer from its status and error code', async () => {
    const res = await postToRoute(filled({ email: 'ada@example.com' }));
    const { error } = await res.json();
    expect(waitlistResult(res.status, error.code)).toBe('invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('waitlist result', () => {
  it('branches on status and error code, never message text', () => {
    expect(waitlistResult(200, undefined)).toBe('sent');
    expect(waitlistResult(400, 'INVALID_INPUT')).toBe('invalid');
    expect(waitlistResult(400, 'SOMETHING_ELSE')).toBe('error');
    expect(waitlistResult(413, 'BODY_TOO_LARGE')).toBe('too_large');
    expect(waitlistResult(429, 'RATE_LIMITED')).toBe('rate_limited');
    expect(waitlistResult(502, 'CONTACT_FORWARD_FAILED')).toBe('failed');
    expect(waitlistResult(503, 'CONTACT_UNAVAILABLE')).toBe('unavailable');
    expect(waitlistResult(500, undefined)).toBe('error');
  });

  it('posts JSON with fetch to CONTACT_PATH', () => {
    const src = readFileSync(new URL('../app/pricing/waitlist-form.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/^'use client';\n/);
    expect(src).toContain('fetch(CONTACT_PATH,');
    expect(src).toContain("'content-type': 'application/json'");
    expect(src).not.toMatch(/\.message\b/);
  });
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { POST } from '../app/api/auth/magic-link/route.js';
import { MAGIC_LINK_PATH } from '../src/auth/email.js';
import {
  CONTACT_IP_LIMIT,
  EMAIL_LIMIT,
  IP_LIMIT,
  UNKNOWN_CONTACT_IP_BUCKET,
  UNKNOWN_IP_BUCKET,
  allowContact,
  allowSend,
  clientIp,
  siteMagicLinkRate,
} from '../src/auth/rate-limit.js';
import { usedTokenSchema, type UsedTokenDb } from '../src/auth/used-tokens.js';

/**
 * Magic-link send rate limiting (#63). Postgres is PGlite, in process: the Neon
 * driver's drizzle() is swapped for one over PGlite, and the email provider's
 * fetch is mocked, so nothing here touches the network.
 */

const pgHolder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('drizzle-orm/neon-serverless', () => ({ drizzle: vi.fn(() => pgHolder.db) }));

const MIGRATIONS = ['0000_magic_link_used.sql', '0001_magic_link_rate.sql'].map(
  (f) => new URL(`../migrations/${f}`, import.meta.url),
);
const MINUTE = 60_000;
const T0 = new Date('2026-10-20T12:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * MINUTE);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

let pg: PGlite;
let db: UsedTokenDb;
let fetchMock: Mock;

beforeAll(async () => {
  pg = await PGlite.create();
  for (const migration of MIGRATIONS) await pg.exec(readFileSync(migration, 'utf8'));
  db = drizzle({ client: pg, schema: usedTokenSchema });
  pgHolder.db = db;
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec('TRUNCATE site_magic_link_rate, site_magic_link_used');
  fetchMock = vi.fn(async () => new Response('{"id":"test-message"}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  for (const level of ['error', 'warn', 'log', 'info', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
  vi.stubEnv('MAGIC_LINK_ENABLED', '1');
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-for-rate-limit-tests');
  vi.stubEnv('EMAIL_API_URL', 'https://email.example.test/send');
  vi.stubEnv('EMAIL_API_KEY', 'test-email-api-key');
  vi.stubEnv('EMAIL_FROM', 'signin@example.test');
  vi.stubEnv('SITE_BASE_URL', 'https://site.example.test');
  vi.stubEnv('VERCEL_URL', '');
  vi.stubEnv('DATABASE_URL', 'postgresql://test-user:test-password@db.site.test/site');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const rows = async () =>
  (await pg.query<{ bucket: string; count: number }>('SELECT bucket, count FROM site_magic_link_rate ORDER BY bucket')).rows;

const send = (email: string, headers: Record<string, string> = {}) =>
  POST(
    new Request(`http://site.test${MAGIC_LINK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ email }),
    }),
  );

const sendForm = (email: string, headers: Record<string, string> = {}) =>
  POST(
    new Request(`http://site.test${MAGIC_LINK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ email }).toString(),
    }),
  );

const answer = async (res: Response) => ({
  status: res.status,
  body: await res.text(),
  headers: [...res.headers].filter(([key]) => key !== 'date'),
});

const VERCEL_IP = (ip: string) => ({ 'x-vercel-forwarded-for': ip });

/**
 * Checks a send's sign-in-unavailable answer: the given status, a request id, no
 * header or body naming configuration, and the cause logged under the id.
 */
async function expectUnavailable(res: Response, status: number, cause: string): Promise<void> {
  expect(res.status).toBe(status);
  const requestId = res.headers.get('x-request-id');
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  const body = await res.text();
  if (status !== 303) {
    const json = JSON.parse(body);
    expect(json.error.message).toContain('Sign-in is unavailable right now.');
    expect(json.requestId).toBe(requestId);
  }
  const everything = [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n') + '\n' + body;
  for (const name of ['MAGIC_LINK', 'DATABASE_URL', 'migrations', '.sql']) expect(everything).not.toContain(name);
  const logged = vi.mocked(console.error).mock.calls.map((args) => args.map(String).join(' '));
  expect(logged.find((line) => line.includes(requestId!))).toContain(cause);
}

describe('migration', () => {
  it('applies cleanly to a fresh Postgres and matches the drizzle table column for column', async () => {
    const fresh = await PGlite.create();
    try {
      for (const migration of MIGRATIONS) await fresh.exec(readFileSync(migration, 'utf8'));
      const config = getTableConfig(siteMagicLinkRate);
      const { rows: columns } = await fresh.query<{ column_name: string; data_type: string; is_nullable: string }>(
        'SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name',
        [config.name],
      );
      expect(columns).toEqual(
        config.columns
          .map((c) => ({ column_name: c.name, data_type: c.getSQLType(), is_nullable: c.notNull ? 'NO' : 'YES' }))
          .sort((a, b) => a.column_name.localeCompare(b.column_name)),
      );
      const { rows: pk } = await fresh.query<{ column_name: string }>(
        `SELECT k.column_name FROM information_schema.table_constraints c
           JOIN information_schema.key_column_usage k ON k.constraint_name = c.constraint_name
          WHERE c.table_name = $1 AND c.constraint_type = 'PRIMARY KEY' ORDER BY k.ordinal_position`,
        [config.name],
      );
      expect(pk.map((r) => r.column_name)).toEqual(['bucket', 'window_start']);
    } finally {
      await fresh.close();
    }
  });
});

describe('clientIp', () => {
  const ip = (headers: Record<string, string>) => clientIp(new Headers(headers));

  it('takes x-vercel-forwarded-for, then x-real-ip', () => {
    expect(ip({ 'x-vercel-forwarded-for': '203.0.113.7', 'x-real-ip': '198.51.100.1' })).toBe('203.0.113.7');
    expect(ip({ 'x-real-ip': '198.51.100.1' })).toBe('198.51.100.1');
    expect(ip({ 'x-vercel-forwarded-for': ' 203.0.113.7 , 10.0.0.1' })).toBe('203.0.113.7');
  });

  it('never reads the client-supplied x-forwarded-for', () => {
    expect(ip({ 'x-forwarded-for': '192.0.2.99' })).toBeNull();
    expect(ip({ 'x-forwarded-for': '192.0.2.99', 'x-real-ip': '198.51.100.1' })).toBe('198.51.100.1');
  });

  it('is null with neither trusted header', () => {
    expect(ip({})).toBeNull();
    expect(ip({ 'x-vercel-forwarded-for': '  ' })).toBeNull();
  });
});

describe('allowSend', () => {
  it(`allows ${EMAIL_LIMIT} sends per email per window and refuses the next`, async () => {
    const results = [];
    for (let i = 0; i < EMAIL_LIMIT + 1; i++) results.push(await allowSend(db, 'ada@example.com', `198.51.100.${i}`, T0));
    expect(results).toEqual([true, true, true, false]);
  });

  it(`allows ${IP_LIMIT} sends per IP per window and refuses the next`, async () => {
    const results = [];
    for (let i = 0; i < IP_LIMIT + 1; i++) results.push(await allowSend(db, `user${i}@example.com`, '203.0.113.7', T0));
    expect(results.filter(Boolean)).toHaveLength(IP_LIMIT);
    expect(results.at(-1)).toBe(false);
  });

  it('pools every request without a trusted IP into one shared bucket', async () => {
    for (let i = 0; i < IP_LIMIT; i++) expect(await allowSend(db, `user${i}@example.com`, null, T0)).toBe(true);
    expect(await allowSend(db, 'another@example.com', null, T0)).toBe(false);
    expect((await rows()).map((r) => r.bucket)).toContain(UNKNOWN_IP_BUCKET);
  });

  it('counts the normalized address, so case and spaces share a bucket', async () => {
    for (const email of ['Ada@Example.com', ' ada@example.com ', 'ADA@EXAMPLE.COM']) {
      expect(await allowSend(db, email, null, T0)).toBe(true);
    }
    expect(await allowSend(db, 'ada@example.com', null, T0)).toBe(false);
  });

  it('starts a fresh count in the next 15-minute window and prunes the old one', async () => {
    for (let i = 0; i < EMAIL_LIMIT; i++) await allowSend(db, 'ada@example.com', null, at(1));
    expect(await allowSend(db, 'ada@example.com', null, at(14))).toBe(false);
    expect(await allowSend(db, 'ada@example.com', null, at(15))).toBe(true);
    const { rows: windows } = await pg.query<{ w: string }>('SELECT DISTINCT window_start::text AS w FROM site_magic_link_rate');
    expect(windows).toHaveLength(1);
  });

  it('cannot be raced past the limit: concurrent sends get exactly the limit', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => allowSend(db, 'ada@example.com', null, T0)));
    expect(results.filter(Boolean)).toHaveLength(EMAIL_LIMIT);
    const email = (await rows()).find((r) => r.bucket.startsWith('email:'));
    expect(email?.count).toBe(10);
  });

  it('stores no raw address or IP, only their SHA-256', async () => {
    await allowSend(db, 'ada@example.com', '203.0.113.7', T0);
    const buckets = (await rows()).map((r) => r.bucket).sort();
    expect(buckets).toEqual([`email:${sha256('ada@example.com')}`, `ip:${sha256('203.0.113.7')}`].sort());
    const dump = JSON.stringify((await pg.query('SELECT * FROM site_magic_link_rate')).rows);
    expect(dump).not.toContain('ada@example.com');
    expect(dump).not.toContain('203.0.113.7');
  });
});

describe('allowContact', () => {
  it(`allows ${CONTACT_IP_LIMIT} contact forwards per IP per window and refuses the next`, async () => {
    const results = [];
    for (let i = 0; i < CONTACT_IP_LIMIT + 1; i++) results.push(await allowContact(db, '203.0.113.7', T0));
    expect(results).toEqual([...Array(CONTACT_IP_LIMIT).fill(true), false]);
    expect(await allowContact(db, '198.51.100.1', T0)).toBe(true);
  });

  it('starts a fresh count in the next window', async () => {
    for (let i = 0; i < CONTACT_IP_LIMIT; i++) await allowContact(db, '203.0.113.7', at(1));
    expect(await allowContact(db, '203.0.113.7', at(14))).toBe(false);
    expect(await allowContact(db, '203.0.113.7', at(15))).toBe(true);
  });

  it('pools requests without a trusted IP into one shared contact bucket', async () => {
    for (let i = 0; i < CONTACT_IP_LIMIT; i++) expect(await allowContact(db, null, T0)).toBe(true);
    expect(await allowContact(db, null, T0)).toBe(false);
    expect((await rows()).map((r) => r.bucket)).toEqual([UNKNOWN_CONTACT_IP_BUCKET]);
  });

  it('keeps its buckets apart from the magic-link IP bucket and stores only the SHA-256', async () => {
    for (let i = 0; i < CONTACT_IP_LIMIT + 1; i++) await allowContact(db, '203.0.113.7', T0);
    expect(await allowSend(db, 'ada@example.com', '203.0.113.7', T0)).toBe(true);
    const buckets = (await rows()).map((r) => r.bucket).sort();
    expect(buckets).toEqual(
      [`contact-ip:${sha256('203.0.113.7')}`, `email:${sha256('ada@example.com')}`, `ip:${sha256('203.0.113.7')}`].sort(),
    );
    expect(JSON.stringify((await pg.query('SELECT * FROM site_magic_link_rate')).rows)).not.toContain('203.0.113.7');
  });

  it('throws when the store is down, so the caller can fail closed', async () => {
    await pg.exec('ALTER TABLE site_magic_link_rate RENAME TO site_magic_link_rate_moved');
    try {
      await expect(allowContact(db, '203.0.113.7', T0)).rejects.toThrow();
    } finally {
      await pg.exec('ALTER TABLE site_magic_link_rate_moved RENAME TO site_magic_link_rate');
    }
  });
});

describe('send route', () => {
  it(`sends no email for the ${EMAIL_LIMIT + 1}th request to one address in 15 minutes`, async () => {
    for (let i = 0; i < EMAIL_LIMIT + 1; i++) await send('ada@example.com', VERCEL_IP(`198.51.100.${i}`));
    expect(fetchMock).toHaveBeenCalledTimes(EMAIL_LIMIT);
  });

  it(`sends no email for the ${IP_LIMIT + 1}th request from one IP`, async () => {
    for (let i = 0; i < IP_LIMIT + 1; i++) await send(`user${i}@example.com`, VERCEL_IP('203.0.113.7'));
    expect(fetchMock).toHaveBeenCalledTimes(IP_LIMIT);
  });

  it('answers a limited request byte for byte like a normal one, JSON and form', async () => {
    const normal = await answer(await send('ada@example.com'));
    for (let i = 1; i < EMAIL_LIMIT; i++) await send('ada@example.com');
    const limited = await answer(await send('ada@example.com'));
    expect(fetchMock).toHaveBeenCalledTimes(EMAIL_LIMIT);
    expect(limited).toEqual(normal);

    const normalForm = await answer(await sendForm('grace@example.com'));
    for (let i = 1; i < EMAIL_LIMIT; i++) await sendForm('grace@example.com');
    const limitedForm = await answer(await sendForm('grace@example.com'));
    expect(limitedForm).toEqual(normalForm);
    expect(limitedForm.headers).toContainEqual(['location', '/signup?signup=sent']);
  });

  it('does not let a spoofed x-forwarded-for reset the IP bucket', async () => {
    for (let i = 0; i < IP_LIMIT + 1; i++) {
      await send(`user${i}@example.com`, { ...VERCEL_IP('203.0.113.7'), 'x-forwarded-for': `192.0.2.${i}` });
    }
    expect(fetchMock).toHaveBeenCalledTimes(IP_LIMIT);
  });

  it('with no trusted IP header, counts every request in the shared unknown bucket', async () => {
    for (let i = 0; i < IP_LIMIT + 1; i++) await send(`user${i}@example.com`, { 'x-forwarded-for': `192.0.2.${i}` });
    expect(fetchMock).toHaveBeenCalledTimes(IP_LIMIT);
  });

  it('does not count an invalid address against the limits', async () => {
    for (let i = 0; i < 5; i++) expect((await send('not-an-email')).status).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it('sends with MAGIC_LINK_ENABLED=1 and the limiter wired in, and answers 503 without the flag', async () => {
    expect((await send('ada@example.com')).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.stubEnv('MAGIC_LINK_ENABLED', '');
    const res = await send('grace@example.com');
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('answers a generic 503 and sends nothing when DATABASE_URL is unset, even with the flag on', async () => {
    vi.stubEnv('DATABASE_URL', '');
    await expectUnavailable(await send('ada@example.com'), 503, 'DATABASE_URL');
    await expectUnavailable(await sendForm('ada@example.com'), 303, 'DATABASE_URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a generic 503 and sends nothing when the rate table is missing, logging the migration', async () => {
    await pg.exec('ALTER TABLE site_magic_link_rate RENAME TO site_magic_link_rate_moved');
    try {
      await expectUnavailable(await send('ada@example.com'), 503, '42P01');
      await expectUnavailable(await send('ada@example.com'), 503, '0001_magic_link_rate.sql');
      await expectUnavailable(await sendForm('ada@example.com'), 303, '0001_magic_link_rate.sql');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await pg.exec('ALTER TABLE site_magic_link_rate_moved RENAME TO site_magic_link_rate');
    }
  });
});

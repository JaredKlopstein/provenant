import { createRequire } from 'node:module';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { POST } from '../app/api/auth/callback/route.js';
import { CALLBACK_PATH, CHECKOUT_PATH, SESSION_COOKIE, createLinkToken } from '../src/auth/session.js';
import {
  DATABASE_URL_ENV,
  markTokenUsed,
  siteMagicLinkUsed,
  usedTokenDb,
  usedTokenSchema,
  type UsedTokenDb,
} from '../src/auth/used-tokens.js';

/**
 * Single-use magic links (#61). Postgres is PGlite, in process: the Neon driver's
 * drizzle() is swapped for one over PGlite, so the route and the module run their
 * real code and nothing touches the network.
 */

const pgHolder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('drizzle-orm/neon-serverless', () => ({ drizzle: vi.fn(() => pgHolder.db) }));

const MIGRATION = new URL('../migrations/0000_magic_link_used.sql', import.meta.url).pathname;
const SITE = new URL('..', import.meta.url).pathname;
const SECRET = 'test-session-secret-for-used-token-tests';
const SITE_ORIGIN = 'https://site.example.test';
const DATABASE_URL = ['postgresql:', '', 'test-user:test-password@db.site.test', 'site'].join('/');
const MINUTE = 60_000;
const T0 = new Date('2026-10-20T12:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * MINUTE);

let pg: PGlite;
let db: UsedTokenDb;
let logged: string[];

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(readFileSync(MIGRATION, 'utf8'));
  db = drizzle({ client: pg, schema: usedTokenSchema });
  pgHolder.db = db;
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec('TRUNCATE site_magic_link_used');
  logged = [];
  for (const level of ['error', 'warn', 'log', 'info', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  }
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('EMAIL_API_URL', 'https://email.example.test/send');
  vi.stubEnv('EMAIL_API_KEY', 'test-email-api-key');
  vi.stubEnv('EMAIL_FROM', 'signin@example.test');
  vi.stubEnv(DATABASE_URL_ENV, DATABASE_URL);
  vi.stubEnv('SITE_BASE_URL', SITE_ORIGIN);
  vi.stubEnv('VERCEL_URL', '');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const rows = async () =>
  (await pg.query<{ jti: string }>('SELECT jti FROM site_magic_link_used ORDER BY jti')).rows.map((r) => r.jti);

const jti = (n: number) => n.toString(16).padStart(32, '0');

/**
 * Checks the callback's sign-in-unavailable answer: 503, a request id, no header
 * or body naming configuration, and the cause logged under the id.
 */
async function expectUnavailable(res: Response, cause: string): Promise<void> {
  expect(res.status).toBe(503);
  const requestId = res.headers.get('x-request-id');
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  const body = await res.clone().text();
  expect(body).toContain('Sign-in is unavailable right now.');
  expect(body).toContain(requestId);
  const everything = [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n') + '\n' + body;
  for (const name of [DATABASE_URL_ENV, 'SESSION_SECRET', 'EMAIL_', 'migrations', '.sql']) {
    expect(everything).not.toContain(name);
  }
  expect(logged.find((line) => line.includes(requestId!))).toContain(cause);
}

/** Presses the confirm page's "Sign in" button: a same-origin form POST of the token. */
const click = (token: string) =>
  POST(
    new Request(new URL(CALLBACK_PATH, SITE_ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE_ORIGIN },
      body: new URLSearchParams({ token }).toString(),
    }),
  );

describe('migration', () => {
  it('applies cleanly to a fresh Postgres and matches the drizzle table column for column', async () => {
    const fresh = await PGlite.create();
    try {
      await fresh.exec(readFileSync(MIGRATION, 'utf8'));
      const config = getTableConfig(siteMagicLinkUsed);
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
          WHERE c.table_name = $1 AND c.constraint_type = 'PRIMARY KEY'`,
        [config.name],
      );
      expect(pk).toEqual([{ column_name: 'jti' }]);
    } finally {
      await fresh.close();
    }
  });

  it('is never run automatically: nothing in the site reads the migrations folder', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(full)) out.push(full);
      }
      return out;
    };
    const readers = [...walk(join(SITE, 'src')), ...walk(join(SITE, 'app'))].filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /\/migrator['"]/.test(src) || (/\b(readFileSync|readFile|readdirSync|readdir)\b/.test(src) && /migrations/.test(src));
    });
    expect(readers).toEqual([]);
  });
});

describe('markTokenUsed', () => {
  it('returns true the first time a jti is used and false on every replay', async () => {
    expect(await markTokenUsed(db, jti(1), at(15), T0)).toBe(true);
    expect(await markTokenUsed(db, jti(1), at(15), T0)).toBe(false);
    expect(await markTokenUsed(db, jti(1), at(15), at(1))).toBe(false);
    expect(await rows()).toEqual([jti(1)]);
  });

  it('lets exactly one of many concurrent uses of the same jti win', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => markTokenUsed(db, jti(2), at(15), T0)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await rows()).toEqual([jti(2)]);
  });

  it('keeps distinct jtis independent', async () => {
    expect(await markTokenUsed(db, jti(3), at(15), T0)).toBe(true);
    expect(await markTokenUsed(db, jti(4), at(15), T0)).toBe(true);
    expect(await rows()).toEqual([jti(3), jti(4)]);
  });

  it('deletes rows past expires_at on the next write and keeps live ones', async () => {
    await markTokenUsed(db, jti(5), at(15), T0);
    await markTokenUsed(db, jti(6), at(30), T0);
    // At T0+20m the first link has expired and the second has not.
    await markTokenUsed(db, jti(7), at(35), at(20));
    expect(await rows()).toEqual([jti(6), jti(7)]);
  });

  it('never prunes the row of a link that is still live, so it cannot be replayed', async () => {
    await markTokenUsed(db, jti(8), at(15), T0);
    // One second before the link expires, a write prunes; the link's own row stays.
    expect(await markTokenUsed(db, jti(8), at(15), new Date(at(15).getTime() - 1000))).toBe(false);
    expect(await rows()).toEqual([jti(8)]);
  });
});

describe('usedTokenDb', () => {
  it('is null when DATABASE_URL is unset or blank', () => {
    vi.stubEnv(DATABASE_URL_ENV, '');
    expect(usedTokenDb()).toBeNull();
    vi.stubEnv(DATABASE_URL_ENV, '   ');
    expect(usedTokenDb()).toBeNull();
  });

  it('opens the database for DATABASE_URL without logging it', () => {
    expect(usedTokenDb()).toBe(db);
    expect(logged.join('\n')).not.toContain(DATABASE_URL);
  });
});

describe('callback', () => {
  it('signs in on the first use of a link', async () => {
    const res = await click(await createLinkToken('ada@example.com', SECRET));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(CHECKOUT_PATH);
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(await rows()).toHaveLength(1);
  });

  it('refuses a second use with the generic "not valid" outcome and no cookie (#89)', async () => {
    const token = await createLinkToken('ada@example.com', SECRET);
    expect((await click(token)).headers.get('set-cookie')).not.toBeNull();

    const replay = await click(token);
    expect(replay.status).toBe(303);
    expect(replay.headers.get('location')).toBe('/signup?signup=expired');
    expect(replay.headers.get('set-cookie')).toBeNull();
    expect(replay.headers.get('cache-control')).toBe('no-store');
  });

  it('gives exactly one session when the same link is clicked concurrently', async () => {
    const token = await createLinkToken('ada@example.com', SECRET);
    const responses = await Promise.all(Array.from({ length: 5 }, () => click(token)));
    expect(responses.filter((r) => r.headers.get('set-cookie') !== null)).toHaveLength(1);
    expect(responses.filter((r) => r.headers.get('location') === '/signup?signup=expired')).toHaveLength(4);
  });

  it('refuses a bad signature or an expired link before any database write', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const token = await createLinkToken('ada@example.com', SECRET);
    const forged = await createLinkToken('ada@example.com', 'another-secret-that-is-long-enough-to-use');

    const bad = [await click(forged)];
    vi.setSystemTime(at(15.02));
    bad.push(await click(token));

    for (const res of bad) {
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/signup?signup=expired');
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    expect(await rows()).toEqual([]);
  });

  it('answers a generic 503 and signs no one in when DATABASE_URL is unset, logging the variable', async () => {
    vi.stubEnv(DATABASE_URL_ENV, '');
    const res = await click(await createLinkToken('ada@example.com', SECRET));
    expect(res.headers.get('set-cookie')).toBeNull();
    await expectUnavailable(res, `missing ${DATABASE_URL_ENV}`);
    expect(await rows()).toEqual([]);
  });

  it('answers a generic 503 with no cookie when the table is missing, logging the code and migration', async () => {
    await pg.exec('ALTER TABLE site_magic_link_used RENAME TO site_magic_link_used_moved');
    try {
      const token = await createLinkToken('ada@example.com', SECRET);
      const res = await click(token);
      expect(res.headers.get('set-cookie')).toBeNull();
      await expectUnavailable(res, '42P01');
      await expectUnavailable(res, '0000_magic_link_used.sql');
      const log = logged.join('\n');
      expect(log).not.toContain(token);
      expect(log).not.toContain(DATABASE_URL);
    } finally {
      await pg.exec('ALTER TABLE site_magic_link_used_moved RENAME TO site_magic_link_used');
    }
  });
});

describe('drizzle-orm', () => {
  it('resolves to one instance across core, cloud and the site (#47)', () => {
    const resolved = ['core', 'cloud', 'site'].map((pkg) =>
      realpathSync(createRequire(new URL(`../../${pkg}/package.json`, import.meta.url)).resolve('drizzle-orm')),
    );
    expect(new Set(resolved).size).toBe(1);
  });

  it('the site depends on the same drizzle-orm range as core and cloud, and not on core', () => {
    const manifest = (pkg: string) =>
      JSON.parse(readFileSync(new URL(`../../${pkg}/package.json`, import.meta.url), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
    const site = manifest('site').dependencies ?? {};
    for (const pkg of ['core', 'cloud']) expect(site['drizzle-orm']).toBe(manifest(pkg).dependencies?.['drizzle-orm']);
    expect(site['@lacre/core']).toBeUndefined();
  });
});

/**
 * Single-use magic links: the table of used link ids and the one write that
 * claims a link.
 *
 * The callback verifies a link's signature and expiry first, then calls
 * `markTokenUsed` with its jti, and sets a session cookie only when that returns
 * true. The claim is one `INSERT … ON CONFLICT (jti) DO NOTHING RETURNING jti`, so
 * two clicks racing on the same link get exactly one row and one session.
 *
 * Each write first prunes rows whose link has expired. "Expired" is judged by the
 * site's clock, the same clock `verifyLinkToken` uses, so a row is never pruned
 * while its link would still verify; a database clock ahead of the site's would
 * otherwise reopen a short replay window.
 *
 * The table is created by migrations/0000_magic_link_used.sql, which the owner
 * applies by hand. Nothing here runs a migration. DATABASE_URL is never logged.
 */
import { Pool } from '@neondatabase/serverless';
import { lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { pgTable, text, timestamp, type PgDatabase, type PgQueryResultHKT } from 'drizzle-orm/pg-core';

export const DATABASE_URL_ENV = 'DATABASE_URL';

export const siteMagicLinkUsed = pgTable('site_magic_link_used', {
  jti: text('jti').primaryKey(),
  usedAt: timestamp('used_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const usedTokenSchema = { siteMagicLinkUsed };

/** A drizzle Postgres database over the used-token table: Neon in production,
 *  PGlite in tests. */
export type UsedTokenDb = PgDatabase<PgQueryResultHKT, typeof usedTokenSchema>;

/**
 * Claims a link. True the first time `jti` is seen; false on every later use,
 * including a use that lost a race. `expiresAt` is the link's own expiry, after
 * which its row may be pruned. `now` is the site's clock.
 */
export async function markTokenUsed(db: UsedTokenDb, jti: string, expiresAt: Date, now: Date = new Date()): Promise<boolean> {
  await db.delete(siteMagicLinkUsed).where(lt(siteMagicLinkUsed.expiresAt, now));
  const claimed = await db
    .insert(siteMagicLinkUsed)
    .values({ jti, expiresAt })
    .onConflictDoNothing({ target: siteMagicLinkUsed.jti })
    .returning({ jti: siteMagicLinkUsed.jti });
  return claimed.length === 1;
}

let opened: { url: string; db: UsedTokenDb } | null = null;

/**
 * The used-token database for DATABASE_URL, or null when it is unset. The Neon
 * pool connects on the first query and is reused while the instance stays warm.
 */
export function usedTokenDb(): UsedTokenDb | null {
  const url = process.env[DATABASE_URL_ENV]?.trim();
  if (!url) {
    console.error(`auth: not configured; missing ${DATABASE_URL_ENV}`);
    return null;
  }
  if (opened?.url !== url) {
    opened = { url, db: drizzle({ client: new Pool({ connectionString: url }), schema: usedTokenSchema }) };
  }
  return opened.db;
}

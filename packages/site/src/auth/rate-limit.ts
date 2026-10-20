/**
 * Rate limits for magic-link sends, kept in Postgres because serverless
 * instances share no memory.
 *
 * Every valid send request counts once against its email bucket and once
 * against its IP bucket, in fixed 15-minute windows: 3 per email and 20 per IP.
 * Each count is one `INSERT … ON CONFLICT DO UPDATE SET count = count + 1
 * RETURNING count`, so concurrent requests cannot slip past a limit. Fixed
 * windows are an accepted tradeoff: a sender can burst up to twice a limit across
 * a window boundary.
 *
 * Buckets hold only SHA-256 digests, never a raw address or IP. The IP comes only
 * from headers Vercel's edge sets (x-vercel-forwarded-for, then x-real-ip); the
 * client's own x-forwarded-for is never read. Without either, every request falls
 * into one shared "ip:unknown" bucket and the email limit still applies.
 *
 * The table is created by migrations/0001_magic_link_rate.sql, which the owner
 * applies by hand. Nothing here runs a migration.
 */
import { createHash } from 'node:crypto';
import { lt, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, text, timestamp, type PgDatabase, type PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { normalizeEmail } from './session';

export const EMAIL_LIMIT = 3;
export const IP_LIMIT = 20;
export const WINDOW_MS = 15 * 60 * 1000;
export const UNKNOWN_IP_BUCKET = 'ip:unknown';
/** Set by Vercel's edge, in order of preference. A client cannot forge them there. */
const TRUSTED_IP_HEADERS = ['x-vercel-forwarded-for', 'x-real-ip'] as const;

export const siteMagicLinkRate = pgTable(
  'site_magic_link_rate',
  {
    bucket: text('bucket').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull(),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.windowStart] })],
);

/** The client IP from the edge's own headers, or null when it sent none. */
export function clientIp(headers: Headers): string | null {
  for (const name of TRUSTED_IP_HEADERS) {
    const first = headers.get(name)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return null;
}

/**
 * Counts one send for this email and IP, and says whether it is within both
 * limits. `now` is the site's clock. Rows from earlier windows are pruned first.
 */
export async function allowSend<TSchema extends Record<string, unknown>>(
  db: PgDatabase<PgQueryResultHKT, TSchema>,
  email: string,
  ip: string | null,
  now: Date = new Date(),
): Promise<boolean> {
  const windowStart = new Date(Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS);
  await db.delete(siteMagicLinkRate).where(lt(siteMagicLinkRate.windowStart, windowStart));
  const emailCount = await increment(db, `email:${sha256(normalizeEmail(email))}`, windowStart);
  const ipCount = await increment(db, ip ? `ip:${sha256(ip)}` : UNKNOWN_IP_BUCKET, windowStart);
  return emailCount <= EMAIL_LIMIT && ipCount <= IP_LIMIT;
}

async function increment<TSchema extends Record<string, unknown>>(
  db: PgDatabase<PgQueryResultHKT, TSchema>,
  bucket: string,
  windowStart: Date,
): Promise<number> {
  const [row] = await db
    .insert(siteMagicLinkRate)
    .values({ bucket, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [siteMagicLinkRate.bucket, siteMagicLinkRate.windowStart],
      set: { count: sql`${siteMagicLinkRate.count} + 1` },
    })
    .returning({ count: siteMagicLinkRate.count });
  return row!.count;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

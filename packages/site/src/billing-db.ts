/**
 * The billing database, opened from DATABASE_URL: the same Neon database whose
 * billing_customers rows the Stripe webhook writes. Checkout reads it to refuse a
 * second Cloud subscription; the billing portal reads it to find the customer.
 *
 * The tables are cloud's (packages/cloud/migrations), applied by the owner by
 * hand. Nothing here runs a migration or writes a billing table: the webhook is
 * the only writer. DATABASE_URL is never logged.
 */
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { billingSchema } from '@provenant/cloud/dist/billing/schema.js';
import type { BillingDb } from '@provenant/cloud/dist/billing/store.js';

export const BILLING_DATABASE_ENV = 'DATABASE_URL';

export type { BillingDb };

/** Opens the database for a URL. The deployed site uses Neon; tests pass PGlite. */
export type ConnectBillingDb = (databaseUrl: string) => BillingDb;

const connectNeon: ConnectBillingDb = (url) =>
  drizzle({ client: new Pool({ connectionString: url }), schema: billingSchema });

let opened: { url: string; connect: ConnectBillingDb; db: BillingDb } | null = null;

/**
 * The billing database for DATABASE_URL, or null when it is unset. The pool
 * connects on the first query and is reused while the instance stays warm.
 */
export function billingDb(connect: ConnectBillingDb = connectNeon): BillingDb | null {
  const url = process.env[BILLING_DATABASE_ENV]?.trim();
  if (!url) {
    console.error(`billing: not configured; missing ${BILLING_DATABASE_ENV}`);
    return null;
  }
  if (opened?.url !== url || opened.connect !== connect) {
    opened = { url, connect, db: connect(url) };
  }
  return opened.db;
}

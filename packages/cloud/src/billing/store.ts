/**
 * Billing persistence: the only code that writes the billing tables, and only
 * the verified webhook calls it.
 *
 * Every write happens inside `applyEventOnce`, one transaction per Stripe
 * event. The event id is inserted first; if it is already there the event is a
 * replay and nothing else runs. If anything after it fails, the transaction
 * rolls back, the id goes with it, and Stripe's retry gets a clean second try.
 *
 * Operators come from core, the same drizzle-orm instance as its schema (#47).
 * Nothing here logs: callers decide what to say, and say it redacted.
 */
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { eq } from '@provenant/core';
import {
  billingSchema, billingCustomers, billingSubscriptions, billingBundleCredits, billingWebhookEvents,
} from './schema.js';
import type { CustomerLookup } from './routes.js';

type Schema = typeof billingSchema;

/** A drizzle Postgres database over the billing schema: Neon in production,
 *  PGlite in tests. */
export type BillingDb = PgDatabase<PgQueryResultHKT, Schema>;
export type BillingTx = Parameters<Parameters<BillingDb['transaction']>[0]>[0];

export type EventOutcome<T> = { duplicate: true } | { duplicate: false; result: T };

/**
 * Runs `apply` once per Stripe event id. A replay returns `{ duplicate: true }`
 * and writes nothing.
 */
export async function applyEventOnce<T>(
  db: BillingDb,
  event: { id: string; type: string },
  apply: (tx: BillingTx) => Promise<T>,
): Promise<EventOutcome<T>> {
  return db.transaction(async (tx) => {
    // Concurrent deliveries of one event serialize on the primary key: the
    // second waits for the first to commit, then conflicts.
    const claimed = await tx
      .insert(billingWebhookEvents)
      .values({ stripeEventId: event.id, type: event.type })
      .onConflictDoNothing()
      .returning({ id: billingWebhookEvents.stripeEventId });
    if (claimed.length === 0) return { duplicate: true } as const;
    return { duplicate: false, result: await apply(tx) } as const;
  });
}

/** Creates the customer row if it does not exist. Never changes an existing one. */
export async function ensureCustomer(tx: BillingTx, stripeCustomerId: string): Promise<void> {
  await tx.insert(billingCustomers).values({ stripeCustomerId }).onConflictDoNothing();
}

export type LinkResult =
  | 'linked'
  /** No account id was given, or the customer is already linked to it. */
  | 'unchanged'
  /** The customer is linked to a different account. Nothing was changed. */
  | 'customer_linked_elsewhere'
  /** The account is linked to a different customer. Nothing was changed. */
  | 'account_linked_elsewhere';

/**
 * Ensures the customer row exists and links it to `accountId` if, and only if,
 * its link is empty and the account is not already linked to another customer.
 * An existing link is never overwritten and a customer never moves account:
 * checkout is public, so the account id is whatever the buyer typed.
 */
export async function linkCustomer(
  tx: BillingTx,
  stripeCustomerId: string,
  accountId: string | null,
): Promise<LinkResult> {
  await ensureCustomer(tx, stripeCustomerId);
  if (!accountId) return 'unchanged';

  const [row] = await tx
    .select({ id: billingCustomers.id, accountId: billingCustomers.accountId })
    .from(billingCustomers)
    .where(eq(billingCustomers.stripeCustomerId, stripeCustomerId))
    .for('update');
  if (!row) throw new Error('billing customer row vanished inside its own transaction');
  if (row.accountId === accountId) return 'unchanged';
  if (row.accountId) return 'customer_linked_elsewhere';

  const [holder] = await tx
    .select({ id: billingCustomers.id })
    .from(billingCustomers)
    .where(eq(billingCustomers.accountId, accountId))
    .for('update');
  if (holder) return 'account_linked_elsewhere';

  // The unique index on account_id backs this check against a concurrent
  // link: the loser's transaction fails and Stripe retries it into the
  // branch above.
  await tx
    .update(billingCustomers)
    .set({ accountId, updatedAt: new Date() })
    .where(eq(billingCustomers.id, row.id));
  return 'linked';
}

export interface SubscriptionState {
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  stripePriceId?: string | null;
  plan: string;
  interval: string;
  status: string;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
}

/**
 * Records a subscription. `insert-only` keeps a row that already exists as it
 * is (checkout knows less than Stripe's subscription object); `upsert` replaces
 * its state, but never moves it to another customer.
 */
export async function saveSubscription(
  tx: BillingTx,
  s: SubscriptionState,
  how: 'insert-only' | 'upsert',
): Promise<void> {
  await ensureCustomer(tx, s.stripeCustomerId);
  const values = {
    stripeSubscriptionId: s.stripeSubscriptionId,
    stripeCustomerId: s.stripeCustomerId,
    stripePriceId: s.stripePriceId ?? null,
    plan: s.plan,
    interval: s.interval,
    status: s.status,
    currentPeriodStart: s.currentPeriodStart ?? null,
    currentPeriodEnd: s.currentPeriodEnd ?? null,
  };
  const insert = tx.insert(billingSubscriptions).values(values);
  if (how === 'insert-only') {
    await insert.onConflictDoNothing();
    return;
  }
  const { stripeSubscriptionId: _id, stripeCustomerId: _customer, ...state } = values;
  await insert.onConflictDoUpdate({
    target: billingSubscriptions.stripeSubscriptionId,
    set: { ...state, updatedAt: new Date() },
  });
}

/** Changes the given fields of a known subscription. Returns false when the
 *  subscription has not been recorded yet. */
export async function updateSubscription(
  tx: BillingTx,
  stripeSubscriptionId: string,
  set: Partial<Pick<SubscriptionState, 'status' | 'currentPeriodStart' | 'currentPeriodEnd'>>,
): Promise<boolean> {
  const updated = await tx
    .update(billingSubscriptions)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(billingSubscriptions.stripeSubscriptionId, stripeSubscriptionId))
    .returning({ id: billingSubscriptions.id });
  return updated.length > 0;
}

/** Credits one paid Checkout Session. Returns false when it was already credited. */
export async function creditBundle(
  tx: BillingTx,
  credit: { stripeCheckoutSessionId: string; stripeCustomerId: string | null; stripePaymentIntentId: string | null },
): Promise<boolean> {
  if (credit.stripeCustomerId) await ensureCustomer(tx, credit.stripeCustomerId);
  const inserted = await tx
    .insert(billingBundleCredits)
    .values({ ...credit, credits: 1 })
    .onConflictDoNothing()
    .returning({ id: billingBundleCredits.id });
  return inserted.length > 0;
}

/**
 * Backs the billing portal's customer lookup with the account link the
 * webhook stores. The link is checkout's client_reference_id, which is the
 * caller's agent id.
 */
export function createCustomerLookup(db: BillingDb): CustomerLookup {
  return {
    async stripeCustomerId(caller) {
      const [row] = await db
        .select({ stripeCustomerId: billingCustomers.stripeCustomerId })
        .from(billingCustomers)
        .where(eq(billingCustomers.accountId, caller.agentId));
      return row?.stripeCustomerId ?? null;
    },
  };
}

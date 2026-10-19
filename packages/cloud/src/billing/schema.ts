/**
 * Billing tables. Postgres (Neon in production, PGlite in tests), owned by
 * cloud; core's SQLite schema is a separate thing and is not changed here.
 *
 * `migrations/0000_billing.sql` is the hand-written migration for exactly these
 * tables. The owner applies it to Neon by hand. Nothing in this package runs it,
 * at startup or at deploy. A test applies it to an in-process Postgres and
 * checks it matches this file column for column.
 *
 * Plan state is written by the verified Stripe webhook and nothing else.
 */
import { pgTable, text, integer, timestamp, bigint, foreignKey } from 'drizzle-orm/pg-core';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** One row per Stripe customer. */
export const billingCustomers = pgTable('billing_customers', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  stripeCustomerId: text('stripe_customer_id').notNull().unique(),
  /** The Provenant account this customer pays for: checkout's
   *  client_reference_id. Set once, when the row is new or the link is empty,
   *  and never overwritten. Unique, so an account has one Stripe customer. */
  accountId: text('account_id').unique(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

/** One row per Stripe subscription. */
export const billingSubscriptions = pgTable('billing_subscriptions', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  stripeSubscriptionId: text('stripe_subscription_id').notNull().unique(),
  stripeCustomerId: text('stripe_customer_id').notNull(),
  stripePriceId: text('stripe_price_id'),
  /** A PlanId from pricing.ts. */
  plan: text('plan').notNull(),
  /** Stripe's recurring interval: 'month' or 'year' for the Cloud plan. */
  interval: text('interval').notNull(),
  /** Stripe's subscription status, as Stripe names it. */
  status: text('status').notNull(),
  currentPeriodStart: timestamptz('current_period_start'),
  currentPeriodEnd: timestamptz('current_period_end'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
}, (t) => [
  foreignKey({
    name: 'billing_subscriptions_customer_fk',
    columns: [t.stripeCustomerId],
    foreignColumns: [billingCustomers.stripeCustomerId],
  }),
]);

/** Pay-as-you-go evidence bundles bought one at a time. One row per paid
 *  Checkout Session, so a session can never be credited twice. */
export const billingBundleCredits = pgTable('billing_bundle_credits', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  stripeCheckoutSessionId: text('stripe_checkout_session_id').notNull().unique(),
  /** Null only for a session Stripe completed without creating a customer. */
  stripeCustomerId: text('stripe_customer_id'),
  stripePaymentIntentId: text('stripe_payment_intent_id'),
  credits: integer('credits').notNull().default(1),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
}, (t) => [
  foreignKey({
    name: 'billing_bundle_credits_customer_fk',
    columns: [t.stripeCustomerId],
    foreignColumns: [billingCustomers.stripeCustomerId],
  }),
]);

/** Every Stripe event id the webhook has applied. A replay finds its id here
 *  and changes nothing. */
export const billingWebhookEvents = pgTable('billing_webhook_events', {
  stripeEventId: text('stripe_event_id').primaryKey(),
  type: text('type').notNull(),
  processedAt: timestamptz('processed_at').notNull().defaultNow(),
});

export const billingSchema = {
  billingCustomers, billingSubscriptions, billingBundleCredits, billingWebhookEvents,
};

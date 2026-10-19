/**
 * Billing tables. Postgres (Neon in production, PGlite in tests), owned by
 * cloud; core's SQLite schema is a separate thing and is not changed here.
 *
 * `migrations/0000_billing.sql` is the hand-written migration for the first
 * four tables, and `migrations/0001_overage.sql` for the three overage tables
 * after them. The owner applies them to Neon by hand, in that order. Nothing in
 * this package runs them, at startup or at deploy. Tests apply them to an
 * in-process Postgres and check they match this file column for column.
 *
 * Plan state is written by the verified Stripe webhook and nothing else. The
 * overage tables are written by billing/overage.ts and nothing else.
 */
import { pgTable, text, integer, timestamp, bigint, boolean, foreignKey, unique } from 'drizzle-orm/pg-core';

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

/** Every evidence bundle a Cloud subscriber exports, so the month's count is
 *  the database's and survives restarts. The first exports of a month are
 *  covered by the plan; only the ones beyond it get a usage report. */
export const billingBundleExports = pgTable('billing_bundle_exports', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  /** The Cloud subscription the export counts against. */
  stripeSubscriptionId: text('stripe_subscription_id').notNull(),
  bundleId: text('bundle_id').notNull(),
  /** UTC calendar month, 'YYYY-MM'. The allowance resets with it. */
  month: text('month').notNull(),
  exportedAt: timestamptz('exported_at').notNull(),
}, (t) => [
  unique('billing_bundle_exports_subscription_bundle_unique').on(t.stripeSubscriptionId, t.bundleId),
  foreignKey({
    name: 'billing_bundle_exports_subscription_fk',
    columns: [t.stripeSubscriptionId],
    foreignColumns: [billingSubscriptions.stripeSubscriptionId],
  }),
]);

/** One row per bundle beyond the month's allowance: one meter event to send.
 *  Stripe dedupes a meter event identifier for 24 hours only, so this table is
 *  the lasting guard. A row is marked reported only after Stripe accepts it. */
export const billingUsageReports = pgTable('billing_usage_reports', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  /** The Cloud subscription the bundle counted against. */
  stripeSubscriptionId: text('stripe_subscription_id').notNull(),
  /** Also the meter event's identifier, on the first send and on every retry. */
  bundleId: text('bundle_id').notNull(),
  exportedAt: timestamptz('exported_at').notNull(),
  reported: boolean('reported').notNull().default(false),
  reportedAt: timestamptz('reported_at'),
  /** The subscription that bills the event: the Cloud subscription itself when
   *  it is monthly, the separate overage subscription when it is annual. */
  reportedSubscriptionId: text('reported_subscription_id'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
}, (t) => [
  unique('billing_usage_reports_subscription_bundle_unique').on(t.stripeSubscriptionId, t.bundleId),
  foreignKey({
    name: 'billing_usage_reports_subscription_fk',
    columns: [t.stripeSubscriptionId],
    foreignColumns: [billingSubscriptions.stripeSubscriptionId],
  }),
]);

/** An annual Cloud subscription's separate monthly overage subscription. Stripe
 *  requires one billing interval per subscription, so the metered overage price
 *  cannot sit on the yearly one. Its own table rather than a column on
 *  billing_subscriptions, so the webhook's inserts there keep working before
 *  0001 is applied. */
export const billingOverageSubscriptions = pgTable('billing_overage_subscriptions', {
  /** The annual Cloud subscription. */
  stripeSubscriptionId: text('stripe_subscription_id').primaryKey(),
  overageSubscriptionId: text('overage_subscription_id').notNull().unique(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
}, (t) => [
  foreignKey({
    name: 'billing_overage_subscriptions_subscription_fk',
    columns: [t.stripeSubscriptionId],
    foreignColumns: [billingSubscriptions.stripeSubscriptionId],
  }),
]);

export const billingSchema = {
  billingCustomers, billingSubscriptions, billingBundleCredits, billingWebhookEvents,
  billingBundleExports, billingUsageReports, billingOverageSubscriptions,
};

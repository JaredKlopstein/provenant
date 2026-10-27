-- Lacre Cloud billing tables (Postgres / Neon). Hand-written; matches
-- packages/cloud/src/billing/schema.ts, which a test checks column for column.
--
-- The owner applies this to Neon by hand. Nothing runs it automatically, at
-- startup or at deploy. It runs in one transaction, so it applies whole or not
-- at all. Core's SQLite migrations are separate and unaffected.

BEGIN;

CREATE TABLE billing_customers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stripe_customer_id text NOT NULL,
  account_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_customers_stripe_customer_id_unique UNIQUE (stripe_customer_id),
  CONSTRAINT billing_customers_account_id_unique UNIQUE (account_id)
);

CREATE TABLE billing_subscriptions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stripe_subscription_id text NOT NULL,
  stripe_customer_id text NOT NULL,
  stripe_price_id text,
  plan text NOT NULL,
  interval text NOT NULL,
  status text NOT NULL,
  current_period_start timestamptz,
  current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_subscriptions_stripe_subscription_id_unique UNIQUE (stripe_subscription_id),
  CONSTRAINT billing_subscriptions_customer_fk
    FOREIGN KEY (stripe_customer_id) REFERENCES billing_customers (stripe_customer_id)
);

CREATE TABLE billing_bundle_credits (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stripe_checkout_session_id text NOT NULL,
  stripe_customer_id text,
  stripe_payment_intent_id text,
  credits integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_bundle_credits_stripe_checkout_session_id_unique UNIQUE (stripe_checkout_session_id),
  CONSTRAINT billing_bundle_credits_customer_fk
    FOREIGN KEY (stripe_customer_id) REFERENCES billing_customers (stripe_customer_id)
);

CREATE TABLE billing_webhook_events (
  stripe_event_id text PRIMARY KEY,
  type text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;

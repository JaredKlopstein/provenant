-- Provenant Cloud overage-bundle tables (Postgres / Neon). Hand-written;
-- matches the overage tables in packages/cloud/src/billing/schema.ts, which a
-- test checks column for column.
--
-- The owner applies this to Neon by hand, after 0000_billing.sql. Nothing runs
-- it automatically, at startup or at deploy. It runs in one transaction, so it
-- applies whole or not at all. Until it is applied, overage reporting fails
-- safe: bundle exports still succeed and nothing is reported. No existing table
-- is changed.

BEGIN;

CREATE TABLE billing_bundle_exports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stripe_subscription_id text NOT NULL,
  bundle_id text NOT NULL,
  month text NOT NULL,
  exported_at timestamptz NOT NULL,
  CONSTRAINT billing_bundle_exports_subscription_bundle_unique UNIQUE (stripe_subscription_id, bundle_id),
  CONSTRAINT billing_bundle_exports_subscription_fk
    FOREIGN KEY (stripe_subscription_id) REFERENCES billing_subscriptions (stripe_subscription_id)
);

CREATE TABLE billing_usage_reports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stripe_subscription_id text NOT NULL,
  bundle_id text NOT NULL,
  exported_at timestamptz NOT NULL,
  reported boolean NOT NULL DEFAULT false,
  reported_at timestamptz,
  reported_subscription_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_usage_reports_subscription_bundle_unique UNIQUE (stripe_subscription_id, bundle_id),
  CONSTRAINT billing_usage_reports_subscription_fk
    FOREIGN KEY (stripe_subscription_id) REFERENCES billing_subscriptions (stripe_subscription_id)
);

CREATE TABLE billing_overage_subscriptions (
  stripe_subscription_id text PRIMARY KEY,
  overage_subscription_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_overage_subscriptions_overage_subscription_id_unique UNIQUE (overage_subscription_id),
  CONSTRAINT billing_overage_subscriptions_subscription_fk
    FOREIGN KEY (stripe_subscription_id) REFERENCES billing_subscriptions (stripe_subscription_id)
);

COMMIT;

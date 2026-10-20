-- Provenant Cloud overage retry state (Postgres / Neon). Hand-written; matches
-- billing_usage_reports in packages/cloud/src/billing/schema.ts, which a test
-- checks column for column.
--
-- The owner applies this to Neon by hand, after 0000_billing.sql and
-- 0001_overage.sql, and before deploying the code that reads these columns.
-- Nothing runs it automatically, at startup or at deploy. It runs in one
-- transaction, so it applies whole or not at all.
--
-- Additive only: four new columns, each nullable or defaulted, so every
-- existing row stays valid. Nothing is dropped or renamed.

BEGIN;

ALTER TABLE billing_usage_reports
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN last_error_kind text,
  ADD COLUMN last_attempt_at timestamptz,
  ADD COLUMN abandoned_at timestamptz;

COMMIT;

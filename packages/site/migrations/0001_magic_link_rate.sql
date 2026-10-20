-- Site magic-link send rate limits (Postgres / Neon). Hand-written; matches
-- siteMagicLinkRate in packages/site/src/auth/rate-limit.ts, which a test
-- checks column for column.
--
-- One counter per bucket per fixed 15-minute window. A bucket is either
-- "email:<sha-256 of the normalized address>" or "ip:<sha-256 of the client
-- IP>", or the shared "ip:unknown" when the edge sent no client IP. No raw
-- address or IP is stored. Rows from earlier windows are pruned on write.
--
-- The owner applies this to Neon by hand, after 0000_magic_link_used.sql and
-- before deploying the send route that writes it. Nothing runs it
-- automatically, at startup or at deploy. It runs in one transaction, so it
-- applies whole or not at all.

BEGIN;

CREATE TABLE site_magic_link_rate (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

COMMIT;

-- Site single-use magic links (Postgres / Neon). Hand-written; matches
-- siteMagicLinkUsed in packages/site/src/auth/used-tokens.ts, which a test
-- checks column for column.
--
-- One row per sign-in link that has been used, keyed by the link's jti. The
-- callback inserts the row before it sets a session cookie, so a second use of
-- the same link finds the row and is refused. Rows are pruned once their link
-- has expired, because an expired link is refused before the database is read.
--
-- The owner applies this to Neon by hand, before deploying the callback that
-- writes it. Nothing runs it automatically, at startup or at deploy. It is kept
-- apart from packages/cloud/migrations so the numbering never collides. It runs
-- in one transaction, so it applies whole or not at all.

BEGIN;

CREATE TABLE site_magic_link_used (
  jti text PRIMARY KEY,
  used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

COMMIT;

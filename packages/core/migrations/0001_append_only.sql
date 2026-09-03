-- Append-only enforcement.
--
-- Receipts are never mutated and never deleted. These triggers make the
-- application physically unable to do either, which turns a whole class of
-- "oops, an ORM update touched the audit table" bug into a loud failure.
--
-- HONEST LIMIT: an operator with direct database access can DROP these triggers.
-- Local integrity controls cannot bind the operator -- that is exactly why a
-- self-hosted chain is self-attested and why external anchoring is the paid
-- tier. These triggers stop accidents and application bugs, not a determined
-- operator. Do not oversell them.

CREATE TRIGGER receipts_no_update
BEFORE UPDATE ON receipts
BEGIN
  SELECT RAISE(ABORT, 'receipts are append-only: UPDATE is forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER receipts_no_delete
BEFORE DELETE ON receipts
BEGIN
  SELECT RAISE(ABORT, 'receipts are append-only: DELETE is forbidden');
END;

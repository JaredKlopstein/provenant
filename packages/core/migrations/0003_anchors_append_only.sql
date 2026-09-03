-- Anchors are append-only for the same reason receipts are, but the stake is
-- higher: an anchor is the one record that can CONTRADICT a rewritten history.
-- If an operator could quietly delete an inconvenient attestation, anchoring
-- would prove nothing.
--
-- Same honest limit as the receipts triggers: an operator with direct database
-- access can DROP these. What they cannot do is produce a replacement timestamp
-- token, because they do not hold the authority's key. The cryptography is the
-- real control here; these triggers only stop accidents.

CREATE TRIGGER anchors_no_update
BEFORE UPDATE ON anchors
BEGIN
  SELECT RAISE(ABORT, 'anchors are append-only: UPDATE is forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER anchors_no_delete
BEFORE DELETE ON anchors
BEGIN
  SELECT RAISE(ABORT, 'anchors are append-only: DELETE is forbidden');
END;

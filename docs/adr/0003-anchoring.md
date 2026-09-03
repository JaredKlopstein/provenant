# ADR 0003: Anchoring — what the paywall actually sells

**Status:** Accepted (Phase 2)

## Context

Provenant's revenue thesis is that writing and chaining receipts locally is free,
and what we charge for is making the chain provable to **someone who does not
trust the operator**. That only works if the free and paid tiers differ in a way
that is *technically real* rather than artificially withheld.

They do, and the difference is not a matter of degree:

A self-hosted hash chain is **self-attested**. An operator with database access
can rebuild the entire history — recompute every hash, relink every record,
re-sign every receipt with the agents' own keys — and the result verifies
perfectly. `packages/cloud/test/forgery.test.ts` demonstrates exactly this: the
first test in the suite forges a chain and watches local verification pass.

That is not a bug we could fix with better local code. Nothing stored on the
operator's own disk can constrain the operator.

## Decision

Anchor the chain head to an authority the operator does not control, using
**RFC 3161 trusted timestamps**, with the backend pluggable (`noop`, `tsa`,
future `transparency-log`) so the OSS build runs unchanged.

### What gets timestamped, and why not just the head hash

We timestamp a JCS-canonicalized **statement**, not the bare head hash:

```json
{ "v":"1", "chain_id":"…", "seq":9, "head_hash":"…", "receipt_count":10 }
```

Timestamping only the hash would leave a genuine token replayable against a
different position, or against a different store that happened to reach the same
head. Binding `chain_id` and `seq` closes both. There is a test that steals a
valid token from one chain and confirms it is rejected by another.

### What an anchor proves, precisely

- **Anything at or before the anchored seq is frozen.** Editing any receipt
  changes its hash, which changes every subsequent link, which changes the head —
  and the operator cannot mint a replacement attestation.
- **Backdating after the anchor is detectable.** An anchor proves the chain had
  already reached seq N at time T, so a receipt at seq > N claiming a timestamp
  before T is claiming to predate something it demonstrably follows. Reported as
  `ANCHOR_TEMPORAL_VIOLATION`, with a 5-minute tolerance so ordinary NTP drift is
  not called forgery.

### What an anchor does NOT prove

**Completeness since the last anchor.** Truncating the un-anchored tail leaves a
valid chain. This is why anchor cadence is a pricing tier rather than a checkbox:
daily anchoring bounds the forgeable window to a day, monthly to a month. Stated
plainly in `anchor.list` output and in the bundle summary.

### Trust is separate from cryptographic soundness

`verifyTimestampToken` returns `ok` (the signature verifies, the imprint matches,
the signer may issue timestamps) **separately from** `trusted` (a certificate in
the chain was in the caller's trust list).

Collapsing these was a bug we caught during implementation. A self-signed root
embedded in a token proves nothing — an attacker can mint one. If `ok` implied
trust, a forged bundle carrying its own CA would verify. The forgery suite tests
exactly that case.

A related real-world correction: DigiCert and Sectigo deliberately **omit** their
root from tokens, shipping only up to an intermediate. Treating an incomplete
chain as a cryptographic failure would have rejected genuine evidence from the
most credible authorities. Chain completeness is therefore a reported status, not
a failure.

### Re-anchoring a changed head is refused, not silently allowed

If an anchor already commits a position to one head and the chain now reports a
different head there, `createAnchor` throws `ANCHOR_CONTRADICTION` rather than
minting a fresh timestamp over the new version. Allowing it would let an operator
launder a forgery by over-writing the only evidence that anything changed.

Re-anchoring an **unchanged** head is an idempotent no-op, because anchoring is a
paid, rate-limited network call and asking twice for proof of the same fact
should not cost twice.

## Testing honestly

The parser is tested against **genuine tokens from freetsa, DigiCert and
Sectigo** (`packages/verifier/test/fixtures`), not only against tokens from our
own encoder. Testing an RFC 3161 implementation solely against itself is
circular: a shared misreading of the spec passes on both sides.

The forgery suite models the worst-case adversary — full database access, dropped
triggers, and the agents' signing keys — and asserts the bundle still fails to
verify. The only thing the adversary lacks is the authority's key.

## Consequences

- The paid tier's value is a property the free tier physically cannot have. We
  are not withholding a feature.
- `chain verify` states on every single invocation that a local chain is
  self-attested. An operator who forgets this would overstate what they can prove.

# ADR 0002: Receipt shape, and where we diverge from the AAT draft

**Status:** Accepted (Phase 1)

## Context

`draft-sharif-agent-audit-trail-00` (AAT) specifies a JSON logging format for
autonomous AI systems: mandatory identity and outcome fields, RFC 8785
canonicalization, SHA-256 hash chaining, optional signatures. Adopting it costs
us nothing now and avoids being leapfrogged by a standard later.

We follow it. We diverge in three places, and each divergence is deliberate.

## Decision

### 1. Signature algorithm: Ed25519, not ECDSA P-256

AAT-00 mandates ECDSA P-256. We default to **Ed25519** because agent identity is
converging on it: RFC 9421 HTTP Message Signatures and the Web Bot Auth drafts
that Cloudflare and Google are pushing use Ed25519, and deterministic signatures
remove a whole class of nonce-reuse failure.

To keep this honest rather than silent, every receipt carries
`provenant.signature_alg`. A verifier never guesses. Adding P-256 later is
additive, not a migration.

**We therefore do not claim AAT conformance.** We claim alignment, and we name
the gap.

### 2. No `self_hash` field inside the record

AAT defines `prev_hash(N) = hex(SHA-256(JCS(record(N-1))))` over the *complete
stored record, including all fields as stored*. A `self_hash` field inside the
record would have to hash itself -- circular and unimplementable.

So `self_hash` is a **materialized database column only**. It is an index into
the chain, never part of the canonical record. This keeps us byte-exact with the
AAT chaining rule while retaining O(1) append.

Note a useful consequence of AAT's rule: because the chain hash covers the whole
stored record, it covers the *signature* too. A re-signature cannot be swapped in
without breaking the next link.

### 3. Provenant fields live under a `provenant` namespace

`side_effect_class`, `seq`, `key_id`, `signature_alg`, and the future contract,
lease and approval fields are not AAT concepts. Putting them at the top level
would pollute a record an AAT validator is meant to recognise. They live under a
single `provenant` object instead.

### 4. `seq` is signed, and the chain is global

A pure hash chain cannot detect **truncation**: lopping off the tail leaves a
perfectly valid chain. Carrying a monotonic `seq` inside the signed record makes
a gap detectable, and a missing tail detectable once you know the expected head.

The chain is global (one chain for the whole store), not per-agent, because one
head means **one anchor commits the entire fleet's history**. Per-agent chains
would multiply the marginal cost of the thing we sell by fleet size. Cost: write
serialization, which SQLite imposes anyway. When that becomes real, the answer is
a per-org chain plus a Merkle root over org heads -- additive.

## The absent-vs-null invariant

`{"a":null}` and `{}` are different JSON values and hash differently. So:

- Fields AAT declares mandatory-but-nullable (`prev_hash`, `parent_record_id`)
  are **always present**, explicitly `null` when empty.
- Every other optional field is **omitted** when absent, never `null`.

`stripUndefined()` enforces this at the boundary, and canonicalization *throws*
on a stray `undefined` rather than dropping it -- a dropped key would change the
hash without changing what the caller believed they signed. That is the single
most dangerous silent failure mode in this design, so it fails loudly.

## Caveat

AAT has **no formal IETF standing** and may change. The version we implement is
pinned in `AAT_DRAFT_VERSION` so a future divergence is detectable rather than
silent.

# ADR 0004: Tool-call receipts, and what a receipt proves

Provenant was renamed Lacre on 27 October 2026.

**Status:** Accepted

## Context

Framework and MCP developers want one verifiable record per tool call that
says who recorded it, which run, turn and attempt it belongs to, and how much
trust to place in it (#10, #13). The receipt from
[ADR 0002](0002-receipt-shape.md) already carries `session_id`, `input_hash`
and `output_hash`. It has no run, turn or attempt ids, no issuer kind and no
provenance class, and `appendReceipt` had no way to set them.

## Decision

### 1. Five optional fields under `lacre`

The AAT core stays untouched and nothing new goes at the top level (ADR 0002,
decision 3). The new fields live in the `lacre` extension:

| Field | Type | Meaning |
|---|---|---|
| `issuer_kind` | `sdk` \| `gateway` | Who wrote the receipt. `sdk`: the agent's own process, in-band. `gateway`: an intermediary, such as an MCP proxy, that saw the call on the wire. |
| `run_id` | non-empty string | One agent run: a task or conversation execution. |
| `turn_id` | non-empty string | One model turn within the run. |
| `attempt_id` | non-empty string | One try of a tool call. Retries share `run_id` and `turn_id` and differ here. |
| `provenance_class` | `attested` \| `observed` \| `claimed` | How much trust the recorded content deserves. `attested`: vouched for by the party that performed the action. `observed`: seen by the issuer itself on the wire. `claimed`: reported to the issuer and not independently seen. |

`AppendInput` gains `issuerKind`, `runId`, `turnId`, `attemptId` and
`provenanceClass`. Each is **omitted** from the receipt when undefined, never
written as `null`, following the absent-vs-null invariant in ADR 0002. A
receipt appended without them therefore has exactly the canonical bytes and
hash it had before this ADR. Existing chains are unaffected and need no
migration.

The ids are opaque strings rather than UUIDs. Frameworks already mint their own
run and turn identifiers, and forcing a format would make callers keep a
mapping table.

The fields are not in the idempotency fingerprint. `attempt_id` changes on
every legitimate retry, which is exactly the case idempotency exists for.

### 2. No new hash fields for tool calls

For a tool call, `input_hash` is SHA-256 over the JCS (RFC 8785) of the call's
arguments, and `output_hash` is SHA-256 over the JCS of its result. We do not
add `args_hash` or `result_hash`. Two names for the same digest would invite a
verifier to check one and trust the other.

### 3. Mapping to draft-noa-scitt-ai-agent-receipt-01

The draft-side names below have **not yet been checked against the -01 text**.
Confirm them before relying on this table, in particular before the verifier
run check (#16).

| Lacre | draft-noa-scitt-ai-agent-receipt-01 |
|---|---|
| `lacre.issuer_kind` | issuer type (to confirm) |
| `lacre.run_id` | run identifier (to confirm) |
| `lacre.turn_id` | turn identifier (to confirm) |
| `lacre.attempt_id` | attempt identifier (to confirm) |
| `lacre.provenance_class` | provenance or assurance class (to confirm) |
| `input_hash` | arguments digest (to confirm) |
| `output_hash` | result digest (to confirm) |

As with AAT, we claim alignment, not conformance. That draft has no formal IETF
standing either.

## What a receipt proves

A receipt that verifies proves:

- **Issuer authentication.** The holder of the key named by
  `lacre.key_id` signed these exact bytes.
- **Unaltered recorded bytes.** Nothing in the signed record has changed since
  signing, including the hashes of the arguments and result.
- **Chain linkage.** The receipt sits at its `seq` in an unbroken chain.
  Tail truncation is only exposed against a known head, and only an anchored
  head binds the operator (ADR 0003).

It does **not** prove:

- **Complete capture.** A tool call that was never recorded leaves no gap.
  `seq` exposes deleted receipts, not ones that were never written.
- **That the tool's effect happened.** A receipt records what the issuer
  recorded. It does not show that the refund settled or the file was written.
- **Correctness.** The arguments may have been wrong and the result false. A
  receipt shows what was said, not that it was right. `provenance_class` states
  how the issuer came to know it. It does not upgrade a claim into a fact.
- **Legal or regulatory compliance.** Lacre is not a compliance product.

## Consequences

- MCP wrapper (#15) and verifier run check (#16) build on these fields.
- `issuer_kind` and `provenance_class` are self-declared by the issuer and
  signed by it. They state what the issuer asserts about itself; they are not
  verified independently.

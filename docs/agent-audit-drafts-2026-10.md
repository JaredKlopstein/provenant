# Provenant receipts and the October 2026 agent-audit drafts

A gap note for #41, not a format change and not a conformance claim. It maps the
current receipt (`packages/core/src/receipt/schema.ts`, ADR 0002, ADR 0003,
ADR 0004) against five individual Internet-Drafts. Checked 2026-10-22.

**Status of the drafts.** All five are individual submissions. None is a working
group document: on the IETF datatracker each shows no group and "I-D Exists". So
**none is a normative dependency of Provenant**, and none will be until a working
group adopts it (#41's acceptance criteria). Several contradict each other on
basic choices: JWS vs COSE_Sign1 vs DSSE, Ed25519 vs ES256 vs ML-DSA, and one
chain per store vs per job vs per agent.

| Draft | Revision read | Newer revision |
|---|---|---|
| draft-zambo-aer1 (AER-1, execution receipt) | -22, 18 Oct 2026 | -24, 20 Oct 2026: "no vector, check, or rule changes" |
| draft-sharif-agent-audit-trail (AAT) | -07, 11 Oct 2026, and -08, 13 Oct 2026 | none |
| draft-nelson-agent-delegation-receipts | -14, 15 Oct 2026 | -15, 22 Oct 2026: adds `delegateeKey`, which changes no cell below |
| draft-mih-scitt-agent-action-capsule | -05, 26 Sep 2026 | none |
| draft-emirdag-scitt-ai-agent-execution (AIR) | -01, 12 Oct 2026 | none |

Provenant's schema pins `AAT_DRAFT_VERSION = 'draft-sharif-agent-audit-trail-00'`,
and ADR 0002 already says "we do not claim AAT conformance". That stays true.

## Mapping

**matches**: same concept and construction. **partial**: same concept, different
fields or narrower. **absent**: not recorded.

### AAT, draft-sharif-agent-audit-trail-08

| Concept | Provenant | Cell |
|---|---|---|
| Outcome enum (§3.1) | `outcome`: success, failure, timeout, denied, escalated (schema.ts:55) | matches |
| Chain: `prev_hash` = SHA-256 over the JCS of the full previous record, signatures included (§6.1) | the same construction (ADR 0002; receipt/hash.ts) | matches |
| `principal`, REQUIRED since -07: the party the agent acted for (§3.1) | no field | absent |
| `record_phase` pre/post/concurrent; a denial is `pre_execution` (§4.2) | no field | absent |
| Signature: `sig_alg` ES256 or ML-DSA-65 (§6.2) | Ed25519 only (`signature_alg: 'ed25519'`) | partial |
| External anchor: per-record `external_timestamp` (RFC 3161), Merkle batch (§6.4) | RFC 3161 over the chain head, Cloud only (ADR 0003); no Merkle batch | partial |
| `policy_ref`, `authorization_record_id` on decision records (§7.3) | reserved `contract_id`, `approval_id`, not built (Phase 3) | absent |

AAT -07 says a verifier SHOULD read a missing `principal` on older records as
"principal not recorded", not as a validation failure. Records against -00, as
Provenant pins, fall under that rule.

### AER-1, draft-zambo-aer1-22

| Concept | Provenant | Cell |
|---|---|---|
| Provenance class: executed / observed / logged (§5) | `provenance_class`: attested / observed / claimed (ADR 0004) | matches (labels differ) |
| Output commitment: `canonical_bytes`, `output_hash` (§3) | `output_hash` = SHA-256 of the JCS of the result; no canonical bytes | partial |
| Hash-chained timeline (§7) | one global signed chain with `seq`; a different digest construction from AER-1's per-job timeline | partial |
| Anchors: rfc3161, scitt, ots, ... (§10) | rfc3161 over the head; no scitt or ots | partial |
| Signature | AER-1 defines none (§13); Provenant signs every receipt | not comparable |

### Delegation receipt, draft-nelson-agent-delegation-receipts-14

| Concept | Provenant | Cell |
|---|---|---|
| Signed pre-action authorization: scope, boundaries, time window, hash of the operator's instructions (§4.2) | none; `approval_id` is reserved for Phase 3 | absent |
| Gate signs every permit and deny (§10) | a caller can record `outcome: denied`, but no signed scope backs it | partial |
| Wire format: JWS over JCS, ES256 required, EdDSA optional (§6.5) | Ed25519 over JCS, not JWS | not comparable |

The draft describes a separate record. If Provenant adopts one, a receipt
should **reference** it by id, not absorb its fields.

### Action capsule, draft-mih-scitt-agent-action-capsule-05

| Concept | Provenant | Cell |
|---|---|---|
| A capsule for every verdict, including blocked, denied, errored, engine_failure and timeout (§5.5) | denied, timeout, escalated and failure exist; no blocked, errored-vs-failed or engine_failure; recording every verdict is not required | partial |
| Effect status: dispatched vs confirmed, with a confirmation bound to the response digest (§5.3) | `attempt_id` only tells retries apart; ADR 0004 disclaims proving that the effect happened | absent |
| `operator`: the accountable party the action was for (§5.1) | only `agent_id` | absent |
| Registration with a SCITT transparency service (§3.3) | no transparency-log backend (ADR 0003: "future") | absent |

### AIR, draft-emirdag-scitt-ai-agent-execution-01

| Concept | Provenant | Cell |
|---|---|---|
| `principal_id`, `delegation_chain` (§5.2) | no fields | absent |
| `policy_refs`, REQUIRED and may be empty (§5.2) | reserved `contract_id` only | absent |
| `outcome_state`: completed, failed, partially_completed, reversed, pending_confirmation (§5.3) | `outcome` has failure; no partial, reversed or pending | partial |
| An independent Evidence Custodian runs the transparency service (§3.2) | an RFC 3161 TSA the operator doesn't control timestamps the head (Cloud); self-hosted, the operator is its own custodian | partial |
| COSE_Sign1 with ES256 (§3.1) | Ed25519 | absent |

## What Provenant does not claim

- **A self-hosted chain is not an independent Evidence Custodian.** AIR §11.2
  says the tamper-evidence guarantees are void when one party is both operator
  and custodian. A local chain proves internal consistency only (README;
  security page). Anchoring the head to an RFC 3161 authority (ADR 0003) fixes
  when the head existed. It still doesn't prove the un-anchored tail is complete.
- **A receipt is not EU AI Act Article 12 compliance.** Articles 12 and 19
  (automatic logs, retention) are obligations on providers and deployers of
  high-risk systems. A receipt format can support them; it can't satisfy them.
  AER-1's author says the same of AER-1.
- **A signature does not prove the action happened as described.** It proves
  who signed which bytes. ADR 0004 already says a receipt does not prove the
  tool's effect. Provenant does not record the dispatched-vs-confirmed
  distinction that the action capsule draft makes.
- **No conformance to any of these drafts** is claimed. None is adopted, and
  they disagree with each other.

## Decisions

#41 asked for two decisions. The owner made both on 2026-10-22, taking the
recommendations below, and closed #41:

1. **Refused calls get a receipt**, as a documented convention: record them with
   `outcome: denied` (the getting-started guide says so). No schema change. Finer
   verdicts are deferred.
2. **`principal`, a delegation-receipt id and a policy hash wait for a later
   Phase 3 profile.** They are not fields now.

The reasoning behind each:

1. **Do denied and rejected tool calls get a receipt?**
   - The action capsule draft requires a record for every verdict.
     NIST/NSA/CISA Practice 5 (16 Oct 2026) asks for rejected actions and tool
     calls to be preserved, though it's scoped to frontier training and
     evaluation.
   - **Decided:** in scope as a documented convention, with no schema
     change. `outcome: denied` already exists, so the getting-started guide and
     `discover` should say that a refused consequential action is recorded with
     it.
   - Defer finer verdicts (errored vs failed, engine_failure, blocked) until a
     working group settles the vocabulary.
2. **Are `principal`, a delegation-receipt id and a policy hash optional
   extension fields now, or a later profile?**
   - **Decided:** a later profile, built with Phase 3 (contracts and
     approvals), where `approval_id` and `contract_id` are already reserved.
   - Adding them now would build Phase 3 vocabulary ahead of Phase 3.
     AAT's "principal not recorded" rule means a missing principal doesn't fail
     validation.
   - When the profile is built, reference delegation receipts and policy
     snapshots by id and hash. Don't absorb their fields.

## Constraints kept

- **No verifier change, and no network fetch.** ADR 0001's offline verifier is
  untouched.
- **No draft implemented, no field added.**
- **Anchoring stays in ADR 0003.** A transparency-log backend remains future
  work there.

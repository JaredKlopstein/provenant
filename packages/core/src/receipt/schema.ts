/**
 * The receipt: the atomic unit and the product.
 *
 * Shape is aligned with draft-sharif-agent-audit-trail-00 (AAT), which specifies
 * hash-chained JSON records canonicalized with RFC 8785 and hashed with SHA-256.
 * Adopting it costs us nothing and avoids being leapfrogged by a standard.
 *
 * WHERE WE DIVERGE FROM AAT-00, and why (see docs/adr/0002-receipt-shape.md):
 *
 *  1. Signature algorithm. AAT-00 mandates ECDSA P-256. We default to Ed25519
 *     for consistency with RFC 9421 agent identity, and record the algorithm
 *     explicitly in `provenant.signature_alg` so a verifier never guesses.
 *
 *  2. No `self_hash` field. The brief called for one, but AAT defines
 *     prev_hash(N) = hex(SHA-256(JCS(record(N-1)))) over the COMPLETE stored
 *     record. A `self_hash` field inside the record would therefore have to
 *     hash itself. We materialize self_hash as a database column only -- it is
 *     an index into the chain, never part of the canonical record. This keeps
 *     us byte-exact with AAT while retaining O(1) append.
 *
 *  3. Provenant-specific governance fields live under a single `provenant`
 *     object rather than at the top level, so the AAT core stays cleanly
 *     separable and an AAT validator sees a record it recognises.
 *
 * The draft has NO formal IETF standing and may change. We pin what we
 * implement in `AAT_DRAFT_VERSION` so a future divergence is detectable rather
 * than silent.
 */
import { z } from 'zod';

export const AAT_DRAFT_VERSION = 'draft-sharif-agent-audit-trail-00' as const;
export const PROVENANT_RECEIPT_VERSION = '1' as const;

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// RFC 3339 with an explicit offset. A timestamp without an offset is ambiguous,
// and ambiguity in an audit record is a defect.
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

/** AAT action_type enum, verbatim from the draft. */
export const ActionType = z.enum([
  'tool_call',
  'tool_response',
  'decision',
  'delegation',
  'escalation',
  'error',
  'lifecycle',
]);
export type ActionType = z.infer<typeof ActionType>;

/** AAT outcome enum, verbatim. Maps cleanly onto our governance results:
 *  a contract rejection is `denied`; an approval escalation is `escalated`. */
export const Outcome = z.enum(['success', 'failure', 'timeout', 'denied', 'escalated']);
export type Outcome = z.infer<typeof Outcome>;

/** AAT trust_level enum, verbatim. */
export const TrustLevel = z.enum(['L0', 'L1', 'L2', 'L3', 'L4']);
export type TrustLevel = z.infer<typeof TrustLevel>;

/**
 * How dangerous the action is. Drives dry-run defaults, contract strictness and
 * approval routing. `irreversible` is the class that must never be replayed.
 */
export const SideEffectClass = z.enum(['read', 'write', 'irreversible']);
export type SideEffectClass = z.infer<typeof SideEffectClass>;

export const ContractResult = z.enum(['passed', 'rejected', 'not_applicable']);
export type ContractResult = z.infer<typeof ContractResult>;

/** Provenant extension namespace. Everything here is outside AAT's schema. */
export const ProvenantExtension = z.object({
  v: z.literal(PROVENANT_RECEIPT_VERSION),
  /** Fully-qualified action name, e.g. "refund.issue". */
  action: z.string().min(1).max(200),
  side_effect_class: SideEffectClass,
  /** Monotonic per-agent-chain sequence. Makes truncation detectable, not just
   *  tampering: a chain that verifies but skips seq 7 has been cut. */
  seq: z.number().int().nonnegative(),
  signature_alg: z.literal('ed25519'),
  /** RFC 7638 thumbprint of the signing key. Makes rotation auditable. */
  key_id: z.string().min(1),

  /** Phase 3 -- contracts. Absent until a contract governs the action. */
  contract_id: z.string().min(1).nullish(),
  contract_result: ContractResult.nullish(),
  /** Phase 3 -- approvals, bound to a specific action hash. */
  approval_id: z.string().min(1).nullish(),
  /** Phase 4 -- leases and fencing. */
  lease_id: z.string().min(1).nullish(),
  fencing_token: z.number().int().nonnegative().nullish(),

  /** Replay key. A repeat with the same key returns the original receipt. */
  idempotency_key: z.string().min(1).max(255).nullish(),
});
export type ProvenantExtension = z.infer<typeof ProvenantExtension>;

/**
 * A receipt without its signature. This exact object -- canonicalized with JCS --
 * is the signing preimage. AAT: "signing process excludes the signature field".
 */
export const UnsignedReceipt = z.object({
  // --- AAT mandatory ---
  record_id: z.string().regex(UUID, 'record_id must be a UUID'),
  timestamp: z.string().regex(RFC3339, 'timestamp must be RFC 3339 with an explicit offset'),
  agent_id: z.string().min(1).max(512),
  agent_version: z.string().regex(SEMVER, 'agent_version must be semver'),
  session_id: z.string().regex(UUID, 'session_id must be a UUID'),
  action_type: ActionType,
  action_detail: z.record(z.string(), z.unknown()),
  outcome: Outcome,
  trust_level: TrustLevel,
  parent_record_id: z.string().regex(UUID).nullable(),
  /** null only for the genesis record of a chain (AAT). */
  prev_hash: z.string().regex(HEX64).nullable(),

  // --- AAT optional, which we always populate for consequential actions ---
  input_hash: z.string().regex(HEX64).nullish(),
  output_hash: z.string().regex(HEX64).nullish(),
  risk_score: z.number().min(0).max(1).nullish(),
  model_id: z.string().max(200).nullish(),
  latency_ms: z.number().int().nonnegative().nullish(),

  // --- Provenant extension ---
  provenant: ProvenantExtension,
});
export type UnsignedReceipt = z.infer<typeof UnsignedReceipt>;

/** A complete, stored receipt. `signature` is base64url over the JCS of the
 *  unsigned form. The chain hash covers this whole object, signature included. */
export const Receipt = UnsignedReceipt.extend({
  signature: z.string().min(1),
});
export type Receipt = z.infer<typeof Receipt>;

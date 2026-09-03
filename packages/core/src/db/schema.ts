/**
 * Storage schema.
 *
 * DESIGN: ONE GLOBAL CHAIN, not a chain per agent.
 *
 * A single chain means a single head, which means ONE anchor commits the entire
 * fleet's history. Per-agent chains would need N anchors (or a Merkle root over
 * N heads) per interval, and anchoring is the paid tier -- so per-agent chains
 * would multiply the marginal cost of the thing we sell by fleet size. A global
 * chain also gives total ordering across agents for free, which is what an
 * incident reviewer actually wants ("what happened next", not "what did agent 7
 * do next").
 *
 * The cost is write serialization. On single-node SQLite that is not a real
 * cost: SQLite serializes writes anyway. When it becomes one, the answer is a
 * per-org chain plus a Merkle root over org heads -- additive, not a rewrite.
 * Noted as future work rather than built on speculation.
 *
 * canonical_json is the SOURCE OF TRUTH for every receipt. The typed columns
 * beside it are a QUERY INDEX and nothing more. Verification always re-parses
 * canonical_json, so it can never depend on our ability to faithfully
 * reconstruct field presence (absent vs null) from columns -- the exact bug that
 * would silently break cross-implementation verification.
 */
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const agents = sqliteTable(
  'agents',
  {
    agentId: text('agent_id').primaryKey(),
    displayName: text('display_name').notNull(),
    agentVersion: text('agent_version').notNull().default('0.0.0'),
    trustLevel: text('trust_level').notNull().default('L1'),

    /** RFC 8037 OKP JWK, JSON text. */
    publicKeyJwk: text('public_key_jwk').notNull(),
    /** RFC 7638 thumbprint of the CURRENT key. */
    keyId: text('key_id').notNull(),
    /**
     * TOFU anchor: the thumbprint of the FIRST key ever seen for this agent id.
     * Never updated. A key rotation changes key_id but not this, so the whole
     * rotation history stays attributable to one origin of trust.
     */
    tofuKeyId: text('tofu_key_id').notNull(),

    /** JSON array of self-declared capability strings. Advisory, not enforced. */
    declaredCapabilities: text('declared_capabilities').notNull().default('[]'),

    registeredAt: text('registered_at').notNull(),
    lastSeenAt: text('last_seen_at'),
  },
  (t) => [index('agents_key_id_idx').on(t.keyId)],
);

export const receipts = sqliteTable(
  'receipts',
  {
    /** Global monotonic chain position. Genesis is 0. */
    seq: integer('seq').primaryKey(),

    recordId: text('record_id').notNull(),
    agentId: text('agent_id').notNull(),
    sessionId: text('session_id').notNull(),

    /** RFC 3339 with explicit offset, as recorded by the agent. */
    timestamp: text('timestamp').notNull(),
    /** Server receive time. Kept separate: agent clocks lie, and an anchor
     *  proves things about when WE saw a record, not when the agent claims. */
    receivedAt: text('received_at').notNull(),

    action: text('action').notNull(),
    actionType: text('action_type').notNull(),
    outcome: text('outcome').notNull(),
    sideEffectClass: text('side_effect_class').notNull(),
    trustLevel: text('trust_level').notNull(),

    prevHash: text('prev_hash'),
    /** hex(SHA-256(JCS(complete stored record))). Materialized index into the
     *  chain -- deliberately NOT a field inside the record, which would make the
     *  AAT hash definition circular. */
    selfHash: text('self_hash').notNull(),

    keyId: text('key_id').notNull(),
    signature: text('signature').notNull(),

    idempotencyKey: text('idempotency_key'),

    /** The authoritative bytes. Everything above is derived from this. */
    canonicalJson: text('canonical_json').notNull(),
  },
  (t) => [
    uniqueIndex('receipts_record_id_idx').on(t.recordId),
    uniqueIndex('receipts_self_hash_idx').on(t.selfHash),
    /** Idempotency is scoped per agent: two agents may legitimately use the
     *  same key string for unrelated work. */
    uniqueIndex('receipts_idem_idx').on(t.agentId, t.idempotencyKey),
    index('receipts_agent_seq_idx').on(t.agentId, t.seq),
    index('receipts_timestamp_idx').on(t.timestamp),
    index('receipts_action_idx').on(t.action),
    index('receipts_session_idx').on(t.sessionId),
  ],
);

export type AgentRow = typeof agents.$inferSelect;
export type ReceiptRow = typeof receipts.$inferSelect;

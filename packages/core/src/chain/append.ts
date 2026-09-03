/**
 * The hot path. Everything else in this package exists to make this function
 * trustworthy; this function exists to make it fast.
 *
 * One synchronous IMMEDIATE transaction: take the write lock up front, read the
 * head, link, sign, insert. Taking the lock up front matters -- a deferred
 * transaction that reads the head and then tries to upgrade to a write can fail
 * or deadlock under concurrency, and two writers that both read the same head
 * would fork the chain.
 */
import { desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import { receipts } from '../db/schema.js';
import { signReceipt, receiptHash, canonicalReceiptJson, payloadHash } from '../receipt/hash.js';
import {
  UnsignedReceipt,
  type Receipt,
  type ActionType,
  type Outcome,
  type SideEffectClass,
  type TrustLevel,
  PROVENANT_RECEIPT_VERSION,
} from '../receipt/schema.js';
import { ProvenantError } from '../errors.js';

export interface AppendInput {
  agentId: string;
  agentVersion: string;
  trustLevel: TrustLevel;
  keyId: string;
  secretKey: Uint8Array;

  action: string;
  actionType: ActionType;
  actionDetail: Record<string, unknown>;
  sideEffectClass: SideEffectClass;
  outcome: Outcome;

  sessionId: string;
  parentRecordId?: string | null;
  input?: unknown;
  output?: unknown;
  modelId?: string;
  riskScore?: number;
  latencyMs?: number;
  idempotencyKey?: string;
  /** Overridable only for tests and backfill; defaults to now. */
  timestamp?: string;
}

export interface AppendResult {
  receipt: Receipt;
  seq: number;
  selfHash: string;
  /** True when an idempotency key replayed a previously recorded result. */
  replayed: boolean;
}

export function nowRfc3339(): string {
  return new Date().toISOString();
}

/** O(1) head read: seq is INTEGER PRIMARY KEY, so this is an index seek. */
export function readHead(db: Db): { seq: number; selfHash: string } | null {
  const row = db
    .select({ seq: receipts.seq, selfHash: receipts.selfHash })
    .from(receipts)
    .orderBy(desc(receipts.seq))
    .limit(1)
    .get();
  return row ?? null;
}

export function appendReceipt(db: Db, input: AppendInput): AppendResult {
  const run = db.$client.transaction((): AppendResult => {
    // --- idempotency: a replay returns the ORIGINAL recorded result ---
    if (input.idempotencyKey != null) {
      const existing = db.$client
        .prepare(
          'SELECT seq, self_hash as selfHash, canonical_json as canonicalJson FROM receipts WHERE agent_id = ? AND idempotency_key = ?',
        )
        .get(input.agentId, input.idempotencyKey) as
        | { seq: number; selfHash: string; canonicalJson: string }
        | undefined;

      if (existing) {
        return {
          receipt: JSON.parse(existing.canonicalJson) as Receipt,
          seq: existing.seq,
          selfHash: existing.selfHash,
          replayed: true,
        };
      }
    }

    const head = readHead(db);
    const seq = head ? head.seq + 1 : 0;

    const unsigned: UnsignedReceipt = UnsignedReceipt.parse({
      record_id: randomUUID(),
      timestamp: input.timestamp ?? nowRfc3339(),
      agent_id: input.agentId,
      agent_version: input.agentVersion,
      session_id: input.sessionId,
      action_type: input.actionType,
      action_detail: input.actionDetail,
      outcome: input.outcome,
      trust_level: input.trustLevel,
      parent_record_id: input.parentRecordId ?? null,
      prev_hash: head ? head.selfHash : null,

      // Optional fields are OMITTED when absent, never null -- see the
      // absent-vs-null invariant in receipt/hash.ts.
      ...(input.input !== undefined ? { input_hash: payloadHash(input.input) } : {}),
      ...(input.output !== undefined ? { output_hash: payloadHash(input.output) } : {}),
      ...(input.modelId !== undefined ? { model_id: input.modelId } : {}),
      ...(input.riskScore !== undefined ? { risk_score: input.riskScore } : {}),
      ...(input.latencyMs !== undefined ? { latency_ms: input.latencyMs } : {}),

      provenant: {
        v: PROVENANT_RECEIPT_VERSION,
        action: input.action,
        side_effect_class: input.sideEffectClass,
        seq,
        signature_alg: 'ed25519',
        key_id: input.keyId,
        ...(input.idempotencyKey !== undefined ? { idempotency_key: input.idempotencyKey } : {}),
      },
    });

    const receipt = signReceipt(unsigned, input.secretKey);
    const canonicalJson = canonicalReceiptJson(receipt);
    const selfHash = receiptHash(receipt);

    try {
      db.insert(receipts)
        .values({
          seq,
          recordId: receipt.record_id,
          agentId: receipt.agent_id,
          sessionId: receipt.session_id,
          timestamp: receipt.timestamp,
          receivedAt: nowRfc3339(),
          action: receipt.provenant.action,
          actionType: receipt.action_type,
          outcome: receipt.outcome,
          sideEffectClass: receipt.provenant.side_effect_class,
          trustLevel: receipt.trust_level,
          prevHash: receipt.prev_hash,
          selfHash,
          keyId: receipt.provenant.key_id,
          signature: receipt.signature,
          idempotencyKey: input.idempotencyKey ?? null,
          canonicalJson,
        })
        .run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE') && msg.includes('seq')) {
        throw new ProvenantError({
          code: 'CHAIN_CONFLICT',
          message:
            `Another writer appended to the chain concurrently; sequence ${seq} was taken. ` +
            `No receipt was written.`,
          retryable: true,
          fix: {
            action: 'record',
            note: 'Retry the identical call. Supply an idempotency_key so a retry cannot double-record.',
          },
        });
      }
      throw err;
    }

    return { receipt, seq, selfHash, replayed: false };
  });

  // IMMEDIATE: acquire the write lock before reading the head, so concurrent
  // writers serialize instead of forking the chain.
  return run.immediate();
}

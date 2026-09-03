import { randomUUID } from 'node:crypto';
import { eq, and, asc, desc, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { anchors, meta, receipts, type AnchorRow } from '../db/schema.js';
import { canonicalBytes } from '../canonical/jcs.js';
import { sha256Hex, fromHex } from '../crypto/hash.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { nowRfc3339 } from '../chain/append.js';
import { ProvenantError } from '../errors.js';
import {
  getAnchorBackend,
  anchorBackendNames,
  type AnchorRecord,
  type AnchorStatement,
} from './types.js';

/** Stable identity for this store. Generated once; binds anchors to this chain
 *  so a genuine token cannot be replayed as evidence for a different chain. */
export function chainId(db: Db): string {
  const row = db.select().from(meta).where(eq(meta.key, 'chain_id')).get();
  if (row) return row.value;
  const id = randomUUID();
  db.insert(meta).values({ key: 'chain_id', value: id }).run();
  return id;
}

/**
 * The exact bytes an authority timestamps.
 *
 * Deliberately a JCS-canonicalized STATEMENT, not the bare head hash: the
 * imprint then commits to the chain id, the position and the receipt count
 * together. Timestamping only the hash would leave a genuine token replayable
 * against a different seq, or against a different store that reached the same
 * head.
 */
export function anchorImprint(statement: AnchorStatement): Uint8Array {
  return sha256(canonicalBytes(statement));
}

export function buildStatement(db: Db): AnchorStatement | null {
  const head = db
    .select({ seq: receipts.seq, selfHash: receipts.selfHash })
    .from(receipts)
    .orderBy(desc(receipts.seq))
    .limit(1)
    .get();
  if (!head) return null;

  const count = db.select({ c: sql<number>`count(*)` }).from(receipts).get();
  return {
    v: '1',
    chain_id: chainId(db),
    seq: head.seq,
    head_hash: head.selfHash,
    receipt_count: count?.c ?? 0,
  };
}

export async function createAnchor(db: Db, backendName: string): Promise<AnchorRecord> {
  const backend = getAnchorBackend(backendName);
  if (!backend) {
    throw new ProvenantError({
      code: 'INVALID_INPUT',
      message: `Unknown anchor backend '${backendName}'. Nothing was anchored. Available: ${anchorBackendNames().join(', ')}.`,
      retryable: false,
      fix: {
        action: 'anchor.now',
        arguments: { backend: 'noop' },
        note:
          "The open-source build ships only 'noop', which produces no external proof. " +
          'Real timestamp authority backends are part of Provenant Cloud.',
      },
    });
  }

  const statement = buildStatement(db);
  if (!statement) {
    throw new ProvenantError({
      code: 'INVALID_INPUT',
      message: 'The chain is empty; there is no head to anchor. Nothing was anchored.',
      retryable: false,
      fix: {
        action: 'record',
        arguments: { action: 'example.action', side_effect_class: 'write' },
        note: 'Record at least one receipt before anchoring.',
      },
    });
  }

  // An anchor already covering this exact position, from this backend, is one
  // of two very different situations -- and conflating them would either spam
  // the authority or hide a forgery.
  const existing = db
    .select()
    .from(anchors)
    .where(and(eq(anchors.seq, statement.seq), eq(anchors.backend, backend.name)))
    .get();

  if (existing) {
    if (existing.headHash === statement.head_hash) {
      // Same position, same content: nothing has changed since we last anchored.
      // Re-anchoring would burn an authority request to prove the same fact, so
      // this is an idempotent no-op.
      return toAnchorRecord(existing);
    }
    // Same position, DIFFERENT content. The history was rewritten underneath an
    // existing attestation. This is the exact signature of tampering, and the
    // system should refuse to paper over it by minting a fresh timestamp for the
    // new version.
    throw new ProvenantError({
      code: 'ANCHOR_CONTRADICTION',
      message:
        `Anchor ${existing.id} already commits seq ${statement.seq} to head ${existing.headHash}, ` +
        `but the chain now reports ${statement.head_hash} at that position. The history was altered ` +
        `after it was anchored. No new anchor was created, and the original attestation is unchanged.`,
      retryable: false,
      details: {
        anchored_head: existing.headHash,
        current_head: statement.head_hash,
        seq: statement.seq,
        anchored_at: existing.provenTime ?? existing.createdAt,
      },
      fix: {
        action: 'chain.verify',
        arguments: { to_seq: statement.seq },
        note:
          'Do NOT re-anchor. Run chain.verify to find which receipt changed, and preserve the ' +
          'original anchor -- it is the evidence that the alteration happened.',
      },
    });
  }

  const proof = await backend.anchor(statement, anchorImprint(statement));

  const record: AnchorRecord = {
    id: randomUUID(),
    statement,
    backend: backend.name,
    proof,
    created_at: nowRfc3339(),
  };

  db.insert(anchors)
    .values({
      id: record.id,
      seq: statement.seq,
      headHash: statement.head_hash,
      receiptCount: statement.receipt_count,
      chainId: statement.chain_id,
      backend: backend.name,
      proofType: proof.type,
      proofToken: proof.token ?? null,
      provenTime: proof.proven_time ?? null,
      authority: proof.authority ?? null,
      createdAt: record.created_at,
    })
    .run();

  return record;
}

export function listAnchors(db: Db): AnchorRow[] {
  return db.select().from(anchors).orderBy(asc(anchors.seq)).all();
}

/** The most recent anchor at or before a chain position. */
export function anchorCovering(db: Db, seq: number): AnchorRow | null {
  return (
    db.select().from(anchors).where(lte(anchors.seq, seq)).orderBy(desc(anchors.seq)).limit(1).get() ??
    null
  );
}

export function toAnchorRecord(row: AnchorRow): AnchorRecord {
  return {
    id: row.id,
    statement: {
      v: '1',
      chain_id: row.chainId,
      seq: row.seq,
      head_hash: row.headHash,
      receipt_count: row.receiptCount,
    },
    backend: row.backend,
    proof: {
      type: row.proofType as 'rfc3161' | 'none',
      ...(row.proofToken ? { token: row.proofToken } : {}),
      ...(row.provenTime ? { proven_time: row.provenTime } : {}),
      ...(row.authority ? { authority: row.authority } : {}),
    },
    created_at: row.createdAt,
  };
}

/** Re-derive the imprint hex an authority should have timestamped. Used by
 *  verification on both sides, so the two can never disagree about what was
 *  supposed to have been signed. */
export function imprintHex(statement: AnchorStatement): string {
  return sha256Hex(canonicalBytes(statement));
}

export { fromHex };

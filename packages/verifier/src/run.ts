/**
 * Run check -- is one agent run's chain intact, and did it repeat a side effect?
 *
 * INDEPENDENT of core, for the reasons in jcs.ts: the chain walk is
 * re-implemented here over the verifier's own receiptHash and
 * verifyReceiptSignature rather than calling core's verifyChain. The meaning
 * matches core's: prev_hash(N) must equal the hash of record N-1, seq must run
 * contiguously from 0 (core's SEQUENCE_GAP), and the first record's prev_hash
 * must be null.
 *
 * Keys are looked up by `provenant.key_id`, not `agent_id`, so a run that
 * crosses a key rotation (ADR 0002) verifies as long as the caller supplies
 * every key it was signed under.
 *
 * Duplicate attempts are REPORTED, not failed. Two attempt ids for the same
 * action, input and turn is exactly what a retry or a resumed graph produces;
 * whether it was a bug is a question for the reader, not the verifier.
 *
 * Fully offline and pure: no filesystem, no network, never throws on
 * adversarial input.
 */
import { receiptHash, verifyReceiptSignature, jwkToPublicKey } from './receipt.js';

/** key_id -> public key, as an RFC 8037 OKP JWK or raw 32 Ed25519 bytes. */
export type RunKeys = Record<string, unknown>;

export type BrokenLinkKind = 'MALFORMED' | 'UNKNOWN_KEY' | 'SIGNATURE_INVALID' | 'LINK_BROKEN';

export interface BrokenLink {
  /** Position in the array given to checkRun. */
  index: number;
  seq: number | null;
  record_id: string | null;
  kind: BrokenLinkKind;
  message: string;
  expected?: string;
  actual?: string;
}

export interface Gap {
  index: number;
  seq: number | null;
  record_id: string | null;
  /** The seq this position should hold if nothing were missing. */
  expectedSeq: number;
  message: string;
}

export interface DuplicateAttempt {
  action: string;
  inputHash: string;
  turnId: string;
  attempts: Array<{ attemptId: string; seqs: Array<number | null> }>;
}

export interface RunReport {
  /** False only for broken links or gaps. Duplicate attempts never fail a run. */
  ok: boolean;
  receiptsChecked: number;
  brokenLinks: BrokenLink[];
  gaps: Gap[];
  duplicateAttempts: DuplicateAttempt[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function resolveKey(key: unknown): Uint8Array | null {
  if (key instanceof Uint8Array) return key.length === 32 ? key : null;
  return jwkToPublicKey(key);
}

function safeHash(r: Record<string, unknown>): string | null {
  try {
    return receiptHash(r);
  } catch {
    return null;
  }
}

/**
 * Check a whole run, in the order given. `receipts` are signed receipts in
 * stored form (the complete record, signature included), ascending by seq.
 */
export function checkRun(receipts: readonly unknown[], keys: RunKeys): RunReport {
  const brokenLinks: BrokenLink[] = [];
  const gaps: Gap[] = [];
  // action \0 input_hash \0 turn_id -> attempt_id -> seqs, in first-seen order.
  const groups = new Map<string, { action: string; inputHash: string; turnId: string; attempts: Map<string, Array<number | null>> }>();

  let prevHash: string | null = null;
  let prevSeq: number | null = null;

  receipts.forEach((raw, index) => {
    if (!isObj(raw) || !isObj(raw.provenant)) {
      brokenLinks.push({
        index, seq: null, record_id: null, kind: 'MALFORMED',
        message: 'Not a receipt: expected an object with a provenant extension.',
      });
      prevHash = null;
      prevSeq = prevSeq === null ? 0 : prevSeq + 1;
      return;
    }
    const p = raw.provenant;
    const seq = typeof p.seq === 'number' && Number.isSafeInteger(p.seq) && p.seq >= 0 ? p.seq : null;
    const record_id = str(raw.record_id);
    const at = { index, seq, record_id };

    // --- sequence: contiguous from 0. Catches deleted records and a missing
    //     head, which the hash links alone cannot place. ---
    const expectedSeq = prevSeq === null ? 0 : prevSeq + 1;
    if (seq === null) {
      gaps.push({ ...at, expectedSeq, message: `provenant.seq is missing or not a non-negative integer; expected ${expectedSeq}.` });
    } else if (seq !== expectedSeq) {
      const msg = prevSeq === null
        ? `Run starts at seq ${seq}; expected genesis at seq 0. Records before ${seq} are missing.`
        : seq > expectedSeq
          ? `Sequence jumps from ${prevSeq} to ${seq}; ${seq - expectedSeq} receipt(s) missing.`
          : `Sequence goes from ${prevSeq} to ${seq}; it repeats or runs backwards.`;
      gaps.push({ ...at, expectedSeq, message: msg });
    }
    prevSeq = seq ?? expectedSeq;

    // --- linkage ---
    if (index === 0) {
      if (raw.prev_hash !== null) {
        gaps.push({ ...at, expectedSeq: 0, message: `The first record's prev_hash must be null; found ${String(raw.prev_hash)}. Records before it are missing.` });
      }
    } else if (prevHash === null || raw.prev_hash !== prevHash) {
      brokenLinks.push({
        ...at, kind: 'LINK_BROKEN',
        message: "prev_hash does not match the previous record's hash. A record was inserted, removed, altered or reordered here.",
        expected: prevHash ?? 'unknown (previous record unreadable)',
        actual: typeof raw.prev_hash === 'string' ? raw.prev_hash : String(raw.prev_hash),
      });
    }

    // --- signature, under the key this record names ---
    const keyId = str(p.key_id);
    const known = keyId !== null && Object.prototype.hasOwnProperty.call(keys, keyId);
    const pk = known ? resolveKey(keys[keyId!]) : null;
    if (!known) {
      brokenLinks.push({
        ...at, kind: 'UNKNOWN_KEY',
        message: `No public key supplied for key_id ${keyId ?? '(missing)'}; its signature cannot be checked. Add it to the keys file if it is a legitimate rotated key.`,
      });
    } else if (!pk) {
      brokenLinks.push({
        ...at, kind: 'UNKNOWN_KEY',
        message: `The key supplied for key_id ${keyId} is not an Ed25519 public key (OKP JWK or 32 raw bytes).`,
      });
    } else if (!verifyReceiptSignature(raw, pk)) {
      brokenLinks.push({
        ...at, kind: 'SIGNATURE_INVALID',
        message: `Signature does not verify under key_id ${keyId}. This record was modified after it was signed, or signed by another key.`,
      });
    }

    prevHash = safeHash(raw);

    // --- duplicate attempts ---
    const action = str(p.action);
    const inputHash = str(raw.input_hash);
    const turnId = str(p.turn_id);
    const attemptId = str(p.attempt_id);
    if (action && inputHash && turnId && attemptId) {
      const k = `${action}\0${inputHash}\0${turnId}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { action, inputHash, turnId, attempts: new Map() }));
      const seqs = g.attempts.get(attemptId);
      if (seqs) seqs.push(seq);
      else g.attempts.set(attemptId, [seq]);
    }
  });

  const duplicateAttempts: DuplicateAttempt[] = [];
  for (const g of groups.values()) {
    if (g.attempts.size < 2) continue;
    duplicateAttempts.push({
      action: g.action, inputHash: g.inputHash, turnId: g.turnId,
      attempts: [...g.attempts].map(([attemptId, seqs]) => ({ attemptId, seqs })),
    });
  }

  return {
    ok: brokenLinks.length === 0 && gaps.length === 0,
    receiptsChecked: receipts.length,
    brokenLinks,
    gaps,
    duplicateAttempts,
  };
}

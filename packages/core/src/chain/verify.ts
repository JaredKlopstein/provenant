/**
 * Chain verification.
 *
 * The definition of done for the tamper test is precise: identify exactly which
 * receipt broke, AND prove every other receipt is intact. A boolean is useless
 * during an incident -- "your chain is broken" tells an on-call engineer nothing
 * about blast radius. So this reports per-receipt failures plus the contiguous
 * ranges that still verify.
 *
 * Deliberately pure and transport-free: it takes an array of records and a key
 * directory, so the identical logic runs over database rows and over an exported
 * bundle. Nothing here touches the network or the filesystem.
 */
import { receiptHash, verifyReceiptSignature } from '../receipt/hash.js';
import { Receipt } from '../receipt/schema.js';
import { jwkToPublicKey, type AgentJwk } from '../crypto/keys.js';

export type FailureKind =
  | 'SCHEMA_INVALID'
  | 'HASH_MISMATCH'
  | 'LINK_BROKEN'
  | 'SIGNATURE_INVALID'
  | 'UNKNOWN_AGENT'
  | 'SEQUENCE_GAP'
  | 'GENESIS_INVALID'
  | 'DUPLICATE_RECORD_ID';

export interface ChainFailure {
  seq: number;
  record_id: string | null;
  kind: FailureKind;
  message: string;
  expected?: string;
  actual?: string;
}

export interface ChainWarning {
  seq: number;
  kind: 'CLOCK_REGRESSION';
  message: string;
}

export interface VerifyResult {
  ok: boolean;
  receipts_checked: number;
  head: { seq: number; self_hash: string } | null;
  failures: ChainFailure[];
  /** Contiguous [from,to] seq ranges that fully verified. The proof of what is
   *  still trustworthy after a tamper is found. */
  intact_ranges: Array<{ from_seq: number; to_seq: number }>;
  warnings: ChainWarning[];
}

/** One stored record: the authoritative canonical JSON plus its stored hashes. */
export interface VerifiableRecord {
  seq: number;
  canonical_json: string;
  /** The self_hash as STORED. Recomputed and compared, never trusted. */
  self_hash: string;
}

export type KeyDirectory = Record<string, AgentJwk>;

export function verifyChain(
  records: VerifiableRecord[],
  keys: KeyDirectory,
  opts: { expectGenesis?: boolean } = {},
): VerifyResult {
  const expectGenesis = opts.expectGenesis ?? true;
  const failures: ChainFailure[] = [];
  const warnings: ChainWarning[] = [];
  const intactSeqs: number[] = [];

  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  const seenRecordIds = new Map<string, number>();

  let prevSelfHash: string | null = null;
  let prevSeq: number | null = null;
  let prevTimestamp: string | null = null;
  let head: { seq: number; self_hash: string } | null = null;

  for (const rec of sorted) {
    let parsed: Receipt;
    let recordId: string | null = null;

    const fail = (kind: FailureKind, message: string, extra: Partial<ChainFailure> = {}) => {
      failures.push({ seq: rec.seq, record_id: recordId, kind, message, ...extra });
    };

    // --- 1. schema ---
    try {
      const raw: unknown = JSON.parse(rec.canonical_json);
      recordId = (raw as { record_id?: string }).record_id ?? null;
      parsed = Receipt.parse(raw);
    } catch (err) {
      fail('SCHEMA_INVALID', `Receipt does not parse as a valid receipt: ${String(err)}`);
      prevSelfHash = rec.self_hash;
      prevSeq = rec.seq;
      continue;
    }

    let recordOk = true;

    // --- 2. sequence contiguity: catches TRUNCATION, which a pure hash chain
    //        cannot see (chopping the tail leaves a perfectly valid chain) ---
    if (prevSeq === null) {
      if (expectGenesis && rec.seq !== 0) {
        fail('SEQUENCE_GAP', `Chain starts at seq ${rec.seq}; expected genesis at seq 0. Records before ${rec.seq} are missing.`);
        recordOk = false;
      }
    } else if (rec.seq !== prevSeq + 1) {
      fail('SEQUENCE_GAP', `Sequence jumps from ${prevSeq} to ${rec.seq}; ${rec.seq - prevSeq - 1} receipt(s) missing.`, {
        expected: String(prevSeq + 1),
        actual: String(rec.seq),
      });
      recordOk = false;
    }

    if (parsed.provenant.seq !== rec.seq) {
      fail('SEQUENCE_GAP', `Stored position ${rec.seq} disagrees with the signed seq ${parsed.provenant.seq}.`, {
        expected: String(rec.seq),
        actual: String(parsed.provenant.seq),
      });
      recordOk = false;
    }

    // --- 3. duplicate record ids ---
    const dupOf = seenRecordIds.get(parsed.record_id);
    if (dupOf !== undefined) {
      fail('DUPLICATE_RECORD_ID', `record_id ${parsed.record_id} already used at seq ${dupOf}.`);
      recordOk = false;
    }
    seenRecordIds.set(parsed.record_id, rec.seq);

    // --- 4. self hash: recompute, never trust the stored value ---
    const computed = receiptHash(parsed);
    if (computed !== rec.self_hash) {
      fail('HASH_MISMATCH', `Receipt content does not match its stored hash. This receipt was modified after it was written.`, {
        expected: rec.self_hash,
        actual: computed,
      });
      recordOk = false;
    }

    // --- 5. linkage ---
    if (prevSelfHash === null && expectGenesis && rec.seq === 0) {
      if (parsed.prev_hash !== null) {
        fail('GENESIS_INVALID', `Genesis receipt must have prev_hash null; found ${parsed.prev_hash}.`);
        recordOk = false;
      }
    } else if (prevSelfHash !== null && parsed.prev_hash !== prevSelfHash) {
      fail('LINK_BROKEN', `prev_hash does not match the previous receipt's hash. A receipt was inserted, removed, or reordered here.`, {
        expected: prevSelfHash,
        actual: parsed.prev_hash ?? 'null',
      });
      recordOk = false;
    }

    // --- 6. signature ---
    const jwk = keys[parsed.agent_id];
    if (!jwk) {
      fail('UNKNOWN_AGENT', `No public key for agent ${parsed.agent_id}; its signature cannot be checked.`);
      recordOk = false;
    } else {
      let sigOk = false;
      try {
        sigOk = verifyReceiptSignature(parsed, jwkToPublicKey(jwk));
      } catch {
        sigOk = false;
      }
      if (!sigOk) {
        fail('SIGNATURE_INVALID', `Signature does not verify under the registered key for ${parsed.agent_id}.`);
        recordOk = false;
      }
    }

    // --- 7. clock: a WARNING, not a failure ---
    // AAT asks for non-decreasing timestamps, but agent clocks genuinely skew
    // and we will not invalidate an otherwise sound chain over NTP drift. The
    // authoritative ordering is seq; this is reported so a reviewer can see it.
    if (prevTimestamp !== null && parsed.timestamp < prevTimestamp) {
      warnings.push({
        seq: rec.seq,
        kind: 'CLOCK_REGRESSION',
        message: `Agent-reported timestamp ${parsed.timestamp} precedes the previous receipt's ${prevTimestamp}. Chain order (seq) is authoritative; this indicates agent clock skew.`,
      });
    }

    if (recordOk) intactSeqs.push(rec.seq);

    prevSelfHash = rec.self_hash;
    prevSeq = rec.seq;
    prevTimestamp = parsed.timestamp;
    head = { seq: rec.seq, self_hash: rec.self_hash };
  }

  return {
    ok: failures.length === 0,
    receipts_checked: sorted.length,
    head,
    failures,
    intact_ranges: toRanges(intactSeqs),
    warnings,
  };
}

function toRanges(seqs: number[]): Array<{ from_seq: number; to_seq: number }> {
  const out: Array<{ from_seq: number; to_seq: number }> = [];
  for (const s of seqs) {
    const last = out[out.length - 1];
    if (last && s === last.to_seq + 1) last.to_seq = s;
    else out.push({ from_seq: s, to_seq: s });
  }
  return out;
}

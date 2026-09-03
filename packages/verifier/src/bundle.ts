/**
 * The evidence bundle format, and its verification.
 *
 * A bundle is a self-contained archive: everything needed to check it is inside
 * it, except the trust anchor for the timestamp authority, which must come from
 * outside by definition (a bundle that carried its own trust anchor would be
 * proving itself).
 *
 * Schema validation is hand-rolled rather than done with Zod, because this
 * package takes no third-party dependencies beyond @noble. A skeptical reader
 * should be able to audit the entire trust path here without reading anyone
 * else's library.
 */
import { X509Certificate } from 'node:crypto';
import { canonicalBytes } from './jcs.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  receiptHash, verifyReceiptSignature, jwkToPublicKey, toHex,
} from './receipt.js';
import { verifyTimestampToken, type TimestampVerdict } from './rfc3161.js';

export const BUNDLE_FORMAT = 'provenant-bundle-v1';

export interface BundleAnchor {
  id: string;
  statement: { v: string; chain_id: string; seq: number; head_hash: string; receipt_count: number };
  backend: string;
  proof: { type: 'rfc3161' | 'none'; token?: string; proven_time?: string; authority?: string };
  created_at: string;
}

export interface BundleReceipt {
  seq: number;
  /** The authoritative bytes. Everything else is derived from this. */
  canonical_json: string;
  self_hash: string;
}

export interface Bundle {
  format: string;
  chain_id: string;
  generated_at: string;
  range: { from_seq: number; to_seq: number };
  receipts: BundleReceipt[];
  /** agent_id -> OKP JWK. */
  agents: Record<string, unknown>;
  anchors: BundleAnchor[];
  /** Contracts in force over this range. Populated from Phase 3. */
  contracts?: unknown[];
  summary?: Record<string, unknown>;
}

export type FailureKind =
  | 'SCHEMA_INVALID' | 'HASH_MISMATCH' | 'LINK_BROKEN' | 'SIGNATURE_INVALID'
  | 'UNKNOWN_AGENT' | 'SEQUENCE_GAP' | 'GENESIS_INVALID' | 'DUPLICATE_RECORD_ID'
  | 'ANCHOR_HEAD_MISMATCH' | 'ANCHOR_INVALID' | 'ANCHOR_CHAIN_MISMATCH'
  | 'ANCHOR_TEMPORAL_VIOLATION' | 'BUNDLE_MALFORMED';

export interface Failure {
  seq: number | null;
  record_id: string | null;
  kind: FailureKind;
  message: string;
  expected?: string;
  actual?: string;
}

export interface AnchorVerdict {
  id: string;
  seq: number;
  backend: string;
  /** Did the bundle's own receipts reproduce the head this anchor commits to? */
  head_matches: boolean;
  /** Cryptographic verdict on the timestamp token, when there is one. */
  timestamp: TimestampVerdict | null;
  /** True when this anchor actually constrains the operator: an external proof
   *  that verifies AND commits to the head we recomputed. */
  is_evidence: boolean;
  proven_time: string | null;
  note: string;
}

export interface BundleVerdict {
  ok: boolean;
  format: string;
  chain_id: string | null;
  receipts_checked: number;
  range: { from_seq: number; to_seq: number } | null;
  failures: Failure[];
  intact_ranges: Array<{ from_seq: number; to_seq: number }>;
  anchors: AnchorVerdict[];
  /** True if at least one anchor is real evidence. NOTE: this does NOT mean every
   *  receipt in the bundle is anchored -- read `anchored_through_seq`. */
  anchored: boolean;
  /**
   * The highest chain position covered by a verified external anchor, or null.
   *
   * Receipts ABOVE this position are not externally anchored: an operator could
   * have appended them freely. A machine consumer that reads only `anchored`
   * would treat a bundle as fully proven when its tail is unproven, so this
   * field carries what the prose conclusion always said.
   */
  anchored_through_seq: number | null;
  /** Count of receipts beyond `anchored_through_seq`. Zero when fully anchored. */
  unanchored_receipt_count: number;
  /** True when at least one verified anchor came from an authority in the
   *  caller's trust list. `anchored` alone says nothing about who vouches. */
  anchor_authority_trusted: boolean;
  warnings: string[];
  /** Plain-language statement of exactly what was and was not established. */
  conclusion: string;
}

export interface VerifyOptions {
  /** SHA-256 fingerprints of timestamp-authority certificates you trust. */
  trustedFingerprints?: string[];
  /** Trust anchors as certificates, to complete a chain the token left open. */
  trustAnchors?: X509Certificate[];
  /** How far before an anchor's attested time a later receipt may claim to have
   *  happened before it is treated as backdating rather than clock skew. */
  backdateToleranceMs?: number;
}

const DEFAULT_BACKDATE_TOLERANCE_MS = 5 * 60 * 1000;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function verifyBundle(input: unknown, opts: VerifyOptions = {}): BundleVerdict {
  const verdict: BundleVerdict = {
    ok: false, format: 'unknown', chain_id: null, receipts_checked: 0, range: null,
    failures: [], intact_ranges: [], anchors: [], anchored: false,
    anchored_through_seq: null, unanchored_receipt_count: 0,
    anchor_authority_trusted: false, warnings: [],
    conclusion: '',
  };

  // ---------------------------------------------------------------- schema
  if (!isObj(input)) {
    verdict.failures.push({ seq: null, record_id: null, kind: 'BUNDLE_MALFORMED', message: 'bundle is not a JSON object' });
    verdict.conclusion = 'Nothing could be verified: the input is not a bundle.';
    return verdict;
  }
  const bundle = input as unknown as Bundle;
  verdict.format = typeof bundle.format === 'string' ? bundle.format : 'unknown';

  if (bundle.format !== BUNDLE_FORMAT) {
    verdict.failures.push({
      seq: null, record_id: null, kind: 'BUNDLE_MALFORMED',
      message: `unsupported bundle format '${String(bundle.format)}'; this verifier reads '${BUNDLE_FORMAT}'`,
    });
    verdict.conclusion = 'Nothing could be verified: unrecognised bundle format.';
    return verdict;
  }
  if (!Array.isArray(bundle.receipts) || !isObj(bundle.agents) || !Array.isArray(bundle.anchors)) {
    verdict.failures.push({
      seq: null, record_id: null, kind: 'BUNDLE_MALFORMED',
      message: 'bundle is missing one of: receipts[], agents{}, anchors[]',
    });
    verdict.conclusion = 'Nothing could be verified: the bundle is structurally incomplete.';
    return verdict;
  }

  verdict.chain_id = typeof bundle.chain_id === 'string' ? bundle.chain_id : null;

  // ---------------------------------------------------------------- chain
  const sorted = [...bundle.receipts].sort((a, b) => a.seq - b.seq);
  verdict.receipts_checked = sorted.length;
  if (sorted.length > 0) {
    verdict.range = { from_seq: sorted[0]!.seq, to_seq: sorted[sorted.length - 1]!.seq };
  }

  const intactSeqs: number[] = [];
  /** seq -> recomputed hash, used to check anchors against real content. */
  const hashAt = new Map<number, string>();
  const timestampAt = new Map<number, string>();
  const seenRecordIds = new Map<string, number>();

  let prevHash: string | null = null;
  let prevSeq: number | null = null;
  const startsAtGenesis = sorted.length > 0 && sorted[0]!.seq === 0;

  for (const rec of sorted) {
    let recordOk = true;
    let recordId: string | null = null;
    const fail = (kind: FailureKind, message: string, extra: Partial<Failure> = {}) => {
      verdict.failures.push({ seq: rec.seq, record_id: recordId, kind, message, ...extra });
      recordOk = false;
    };

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rec.canonical_json) as Record<string, unknown>;
      if (!isObj(parsed)) throw new Error('not an object');
      recordId = typeof parsed.record_id === 'string' ? parsed.record_id : null;
    } catch (err) {
      fail('SCHEMA_INVALID', `receipt JSON could not be parsed: ${String(err)}`);
      prevHash = rec.self_hash;
      prevSeq = rec.seq;
      continue;
    }

    // sequence contiguity -- catches truncation, which hashing alone cannot
    if (prevSeq !== null && rec.seq !== prevSeq + 1) {
      fail('SEQUENCE_GAP', `sequence jumps from ${prevSeq} to ${rec.seq}; ${rec.seq - prevSeq - 1} receipt(s) missing`,
        { expected: String(prevSeq + 1), actual: String(rec.seq) });
    }
    const signedSeq = isObj(parsed.provenant) ? (parsed.provenant as Record<string, unknown>).seq : undefined;
    if (signedSeq !== rec.seq) {
      fail('SEQUENCE_GAP', `stored position ${rec.seq} disagrees with the signed seq ${String(signedSeq)}`,
        { expected: String(rec.seq), actual: String(signedSeq) });
    }

    if (recordId) {
      const dup = seenRecordIds.get(recordId);
      if (dup !== undefined) fail('DUPLICATE_RECORD_ID', `record_id ${recordId} already used at seq ${dup}`);
      seenRecordIds.set(recordId, rec.seq);
    }

    // recompute the hash; never trust the stored value
    const computed = receiptHash(parsed);
    hashAt.set(rec.seq, computed);
    if (computed !== rec.self_hash) {
      fail('HASH_MISMATCH', 'receipt content does not match its stored hash: this receipt was modified after it was written',
        { expected: rec.self_hash, actual: computed });
    }

    // linkage
    if (prevHash === null && startsAtGenesis && rec.seq === 0) {
      if (parsed.prev_hash !== null) {
        fail('GENESIS_INVALID', `genesis receipt must have prev_hash null; found ${String(parsed.prev_hash)}`);
      }
    } else if (prevHash !== null && parsed.prev_hash !== prevHash) {
      fail('LINK_BROKEN', 'prev_hash does not match the previous receipt: a receipt was inserted, removed or reordered here',
        { expected: prevHash, actual: String(parsed.prev_hash ?? 'null') });
    }

    // signature
    const agentId = typeof parsed.agent_id === 'string' ? parsed.agent_id : '';
    const jwk = (bundle.agents as Record<string, unknown>)[agentId];
    if (!jwk) {
      fail('UNKNOWN_AGENT', `bundle carries no public key for agent ${agentId}; its signature cannot be checked`);
    } else {
      const pk = jwkToPublicKey(jwk);
      if (!pk) fail('UNKNOWN_AGENT', `public key for agent ${agentId} is not a valid Ed25519 OKP JWK`);
      else if (!verifyReceiptSignature(parsed, pk)) {
        fail('SIGNATURE_INVALID', `signature does not verify under the bundled key for ${agentId}`);
      }
    }

    if (typeof parsed.timestamp === 'string') timestampAt.set(rec.seq, parsed.timestamp);
    if (recordOk) intactSeqs.push(rec.seq);

    prevHash = rec.self_hash;
    prevSeq = rec.seq;
  }

  verdict.intact_ranges = toRanges(intactSeqs);

  // ---------------------------------------------------------------- anchors
  const tolerance = opts.backdateToleranceMs ?? DEFAULT_BACKDATE_TOLERANCE_MS;

  for (const anchor of bundle.anchors) {
    const av = verifyAnchor(anchor, bundle, hashAt, verdict, opts);
    verdict.anchors.push(av);

    if (av.is_evidence && av.proven_time) {
      // An anchor proves receipts 0..seq existed at proven_time. A receipt AFTER
      // it that claims an earlier timestamp is claiming to predate something it
      // demonstrably follows. Tolerance covers ordinary clock skew, not hours.
      const provenMs = Date.parse(av.proven_time);
      for (const [seq, ts] of timestampAt) {
        if (seq <= anchor.statement.seq) continue;
        const claimed = Date.parse(ts);
        if (Number.isFinite(claimed) && claimed < provenMs - tolerance) {
          verdict.failures.push({
            seq, record_id: null, kind: 'ANCHOR_TEMPORAL_VIOLATION',
            message:
              `receipt at seq ${seq} claims timestamp ${ts}, but anchor at seq ${anchor.statement.seq} ` +
              `proves the chain had already reached that point at ${av.proven_time}. ` +
              `A receipt appended after an anchor cannot predate it. This is backdating.`,
            expected: `>= ${av.proven_time}`, actual: ts,
          });
        }
      }
    }
  }

  verdict.anchored = verdict.anchors.some((a) => a.is_evidence);
  verdict.anchor_authority_trusted = verdict.anchors.some(
    (a) => a.is_evidence && a.timestamp?.trusted === true,
  );

  const evidence = verdict.anchors.filter((a) => a.is_evidence).map((a) => a.seq);
  verdict.anchored_through_seq = evidence.length ? Math.max(...evidence) : null;
  verdict.unanchored_receipt_count =
    verdict.anchored_through_seq === null
      ? sorted.length
      : sorted.filter((r) => r.seq > verdict.anchored_through_seq!).length;

  // A tail beyond the last anchor is a real limitation, not a footnote: a pure
  // hash chain cannot detect receipts appended (or removed) after the anchor.
  if (verdict.anchored && verdict.unanchored_receipt_count > 0) {
    verdict.warnings.push(
      `${verdict.unanchored_receipt_count} receipt(s) after seq ${verdict.anchored_through_seq} are NOT covered by any external anchor. ` +
        `Those were appended after the last attestation and are backed only by the operator's own chain.`,
    );
  }

  verdict.ok = verdict.failures.length === 0;
  verdict.conclusion = describe(verdict);
  return verdict;
}

function verifyAnchor(
  anchor: BundleAnchor,
  bundle: Bundle,
  hashAt: Map<number, string>,
  verdict: BundleVerdict,
  opts: VerifyOptions,
): AnchorVerdict {
  const av: AnchorVerdict = {
    id: String(anchor?.id ?? 'unknown'),
    seq: anchor?.statement?.seq ?? -1,
    backend: String(anchor?.backend ?? 'unknown'),
    head_matches: false, timestamp: null, is_evidence: false, proven_time: null,
    note: '',
  };

  if (!isObj(anchor) || !isObj(anchor.statement)) {
    verdict.failures.push({ seq: null, record_id: null, kind: 'ANCHOR_INVALID', message: 'anchor entry is malformed' });
    av.note = 'malformed anchor entry';
    return av;
  }

  // 1. Does the bundle's own content reproduce the head this anchor commits to?
  const recomputed = hashAt.get(anchor.statement.seq);
  if (recomputed === undefined) {
    av.note = `anchor commits to seq ${anchor.statement.seq}, which is outside this bundle's range; it cannot be checked here`;
    verdict.warnings.push(av.note);
    return av;
  }
  av.head_matches = recomputed === anchor.statement.head_hash;
  if (!av.head_matches) {
    // THE forgery detector. Any edit anywhere at or before this seq lands here.
    verdict.failures.push({
      seq: anchor.statement.seq, record_id: null, kind: 'ANCHOR_HEAD_MISMATCH',
      message:
        `the receipts in this bundle produce head ${recomputed} at seq ${anchor.statement.seq}, ` +
        `but the anchor commits to ${anchor.statement.head_hash}. The history was altered after it was anchored.`,
      expected: anchor.statement.head_hash, actual: recomputed,
    });
  }

  if (bundle.chain_id && anchor.statement.chain_id !== bundle.chain_id) {
    verdict.failures.push({
      seq: anchor.statement.seq, record_id: null, kind: 'ANCHOR_CHAIN_MISMATCH',
      message: `anchor belongs to chain ${anchor.statement.chain_id}, not ${bundle.chain_id}; it may have been replayed from another store`,
    });
  }

  // 2. The proof itself.
  if (anchor.proof?.type !== 'rfc3161' || !anchor.proof.token) {
    av.note =
      `backend '${av.backend}' produced no external proof. This anchor is self-attested and ` +
      `establishes nothing to a third party.`;
    verdict.warnings.push(`anchor at seq ${anchor.statement.seq}: ${av.note}`);
    return av;
  }

  // The imprint is over the STATEMENT, so the token commits to chain id, seq and
  // count -- not just the head hash. Recompute it from the anchor's own claims,
  // then the head_matches check above ties those claims to real receipt content.
  const imprint = sha256(canonicalBytes(anchor.statement));
  let tokenBytes: Uint8Array;
  try {
    tokenBytes = new Uint8Array(Buffer.from(anchor.proof.token, 'base64'));
  } catch {
    verdict.failures.push({ seq: anchor.statement.seq, record_id: null, kind: 'ANCHOR_INVALID', message: 'timestamp token is not valid base64' });
    return av;
  }

  av.timestamp = verifyTimestampToken(tokenBytes, {
    expectedImprint: imprint,
    ...(opts.trustedFingerprints ? { trustedFingerprints: opts.trustedFingerprints } : {}),
    ...(opts.trustAnchors ? { trustAnchors: opts.trustAnchors } : {}),
  });
  av.proven_time = av.timestamp.proven_time;

  if (!av.timestamp.ok) {
    for (const f of av.timestamp.failures) {
      verdict.failures.push({
        seq: anchor.statement.seq, record_id: null, kind: 'ANCHOR_INVALID',
        message: `timestamp token at seq ${anchor.statement.seq}: ${f}`,
      });
    }
    av.note = 'the timestamp token did not verify';
    return av;
  }

  av.is_evidence = av.head_matches;
  av.note = av.head_matches
    ? `verified: '${av.timestamp.signer ?? 'unknown authority'}' attests this chain reached seq ${anchor.statement.seq} at ${av.proven_time}` +
      (av.timestamp.trusted ? ' (authority is in your trust list)' : ' (authority NOT in your trust list -- confirm you trust it)')
    : 'the timestamp token is valid but commits to a different history than the receipts in this bundle';
  return av;
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

/** Plain language, because the audience for a failed verification is a human
 *  under time pressure who must decide what it means. */
function describe(v: BundleVerdict): string {
  if (v.failures.length > 0) {
    const kinds = [...new Set(v.failures.map((f) => f.kind))];
    const anchorBreak = v.failures.find((f) => f.kind === 'ANCHOR_HEAD_MISMATCH');
    if (anchorBreak) {
      return (
        `FORGERY DETECTED. The receipts in this bundle do not produce the head that was ` +
        `externally timestamped at seq ${anchorBreak.seq}. Someone altered the history after it ` +
        `was anchored, and could not forge a replacement timestamp. Do not trust this bundle.`
      );
    }
    return (
      `VERIFICATION FAILED (${kinds.join(', ')}). ${v.failures.length} problem(s) found across ` +
      `${v.receipts_checked} receipts. Receipts still provably intact: ` +
      `${v.intact_ranges.map((r) => `${r.from_seq}-${r.to_seq}`).join(', ') || 'none'}.`
    );
  }
  if (v.anchored) {
    const ev = v.anchors.filter((a) => a.is_evidence);
    const tail =
      v.unanchored_receipt_count > 0
        ? ` ${v.unanchored_receipt_count} receipt(s) after seq ${v.anchored_through_seq} are NOT anchored and are backed only by the operator's own chain.`
        : '';
    return (
      `VERIFIED AND ANCHORED THROUGH SEQ ${v.anchored_through_seq}. All ${v.receipts_checked} receipts are ` +
      `internally consistent and correctly signed, and ${ev.length} external timestamp(s) prove the history ` +
      `up to seq ${v.anchored_through_seq} existed at ${ev.map((a) => a.proven_time).join(', ')}. The operator ` +
      `could not have altered anything at or before that position without breaking the timestamp.` +
      tail +
      (v.anchor_authority_trusted
        ? ''
        : ' NOTE: the timestamp authority was not in your trust list -- confirm you trust it before relying on this.')
    );
  }
  return (
    `VERIFIED BUT NOT ANCHORED. All ${v.receipts_checked} receipts are internally consistent and ` +
    `correctly signed, but nothing here constrains the operator: with database access they could have ` +
    `rebuilt this entire history, and it would still verify exactly like this. Treat it as ` +
    `self-attested, not as evidence.`
  );
}

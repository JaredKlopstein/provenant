/**
 * Anchoring: committing the chain head to something the operator cannot forge.
 *
 * THIS IS THE PAYWALL, and it is worth being precise about what it buys.
 *
 * A local hash chain proves internal consistency. It cannot prove the operator
 * left history alone, because the operator can rebuild the entire chain -- every
 * hash, every signature, every verification result -- from scratch. Nothing
 * stored on the operator's own disk can rule that out.
 *
 * An anchor breaks that, by getting a third party the operator does not control
 * to attest "this head hash existed at this time". Afterwards:
 *
 *   - Editing ANY receipt at seq <= anchored seq changes that receipt's hash,
 *     which changes every subsequent link, which changes the head. The head no
 *     longer matches the anchored value, and the operator cannot produce a
 *     replacement attestation because they do not hold the TSA's key.
 *
 *   - Appending a receipt AFTER the anchor and backdating its timestamp is
 *     detectable too: the anchor proves receipts 0..N existed at time T, so a
 *     receipt at seq > N claiming a timestamp before T is claiming to have been
 *     written before something it demonstrably follows.
 *
 * What an anchor does NOT prove: that receipts recorded since the last anchor
 * are complete. Truncating the un-anchored tail leaves a valid chain. That is
 * why anchor cadence is a product tier -- daily anchoring bounds the forgeable
 * window to a day; monthly bounds it to a month.
 */

/** What we ask the external authority to timestamp.
 *
 *  We timestamp a STATEMENT rather than the bare head hash, so the attestation
 *  binds the position and size of the chain too. Timestamping only the hash
 *  would let an operator replay a genuine old token against a different seq. */
export interface AnchorStatement {
  v: '1';
  /** Identifies this store, so a token from one chain cannot be replayed onto
   *  another. Generated once at init. */
  chain_id: string;
  seq: number;
  head_hash: string;
  receipt_count: number;
}

export type AnchorProofType = 'rfc3161' | 'none';

export interface AnchorProof {
  type: AnchorProofType;
  /** base64 DER of the RFC 3161 TimeStampToken. Absent for 'none'. */
  token?: string;
  /** The time the external authority attests to, RFC 3339. Absent for 'none'. */
  proven_time?: string;
  /** Human-readable authority name, for the incident view. */
  authority?: string;
}

export interface AnchorRecord {
  id: string;
  statement: AnchorStatement;
  backend: string;
  proof: AnchorProof;
  /** Our local clock when we created it. Untrusted; proven_time is the one that
   *  carries weight. Kept so a gap between the two is visible. */
  created_at: string;
}

/**
 * Pluggable so the OSS build runs with `noop` and the commercial build uses a
 * real authority. Keeping the interface in core (MIT) means a self-hoster can
 * write their own backend against their own TSA and owe us nothing -- which is
 * the honest version of open core. What they buy from us is a managed authority,
 * retention, and the bundle that packages it.
 */
export interface AnchorBackend {
  readonly name: string;
  /** Human-readable description used by `provenant anchor status`. */
  readonly description: string;
  /** Does this backend produce a proof a third party can check? `noop` does not. */
  readonly isExternal: boolean;
  anchor(statement: AnchorStatement, imprintSha256: Uint8Array): Promise<AnchorProof>;
}

const backends = new Map<string, AnchorBackend>();

export function registerAnchorBackend(backend: AnchorBackend): void {
  backends.set(backend.name, backend);
}

export function getAnchorBackend(name: string): AnchorBackend | undefined {
  return backends.get(name);
}

export function anchorBackendNames(): string[] {
  return [...backends.keys()].sort();
}

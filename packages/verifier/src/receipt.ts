/**
 * Receipt verification -- INDEPENDENT of core, for the reasons in jcs.ts.
 *
 * Implements the chain rule from draft-sharif-agent-audit-trail-00:
 *   prev_hash(N) = hex(SHA-256(JCS(record(N-1))))
 * over the complete stored record INCLUDING its signature, and the signing rule
 * that excludes the signature field from the signed bytes.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { canonicalBytes } from './jcs.js';

ed.hashes.sha512 = sha512;

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromBase64Url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

/** Drop undefined keys; preserve null exactly. Mirrors core's rule: an omitted
 *  key and a null key are different JSON values with different hashes. */
export function stripUndefined<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripUndefined) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = stripUndefined(v);
  }
  return out as T;
}

/** The chain link value for a complete stored receipt. */
export function receiptHash(receipt: Record<string, unknown>): string {
  return toHex(sha256(canonicalBytes(stripUndefined(receipt))));
}

/** Verify the Ed25519 signature over the receipt minus its signature field. */
export function verifyReceiptSignature(
  receipt: Record<string, unknown>,
  publicKey: Uint8Array,
): boolean {
  const sigB64 = receipt.signature;
  if (typeof sigB64 !== 'string') return false;

  let sig: Uint8Array;
  try {
    sig = fromBase64Url(sigB64);
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;

  const { signature: _drop, ...unsigned } = receipt;
  try {
    return ed.verify(sig, canonicalBytes(stripUndefined(unsigned)), publicKey);
  } catch {
    // Malformed points and signatures are verification failures, never crashes.
    return false;
  }
}

/** RFC 8037 OKP JWK -> raw 32-byte Ed25519 public key. */
export function jwkToPublicKey(jwk: unknown): Uint8Array | null {
  if (!jwk || typeof jwk !== 'object') return null;
  const j = jwk as Record<string, unknown>;
  if (j.kty !== 'OKP' || j.crv !== 'Ed25519' || typeof j.x !== 'string') return null;
  try {
    const pk = fromBase64Url(j.x);
    return pk.length === 32 ? pk : null;
  } catch {
    return null;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return toHex(sha256(bytes));
}

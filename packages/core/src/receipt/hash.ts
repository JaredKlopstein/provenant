/**
 * Receipt hashing and signing.
 *
 * CRITICAL INVARIANT -- absent vs null.
 *   {"a":null} and {} are different JSON values and hash differently. An
 *   optional field must therefore be either consistently omitted or
 *   consistently null, forever. Our rule:
 *
 *     - Fields AAT declares mandatory-but-nullable (prev_hash,
 *       parent_record_id) are ALWAYS present, explicitly null when empty.
 *     - Every other optional field is OMITTED when absent, never null.
 *
 *   stripUndefined() enforces this at the boundary. Because a `undefined` value
 *   left in place would make canonicalize() throw, the failure is loud rather
 *   than a silently-different hash.
 */
import { canonicalize, canonicalBytes } from '../canonical/jcs.js';
import { sha256Hex, toBase64Url, fromBase64Url } from '../crypto/hash.js';
import { sign, verify } from '../crypto/keys.js';
import type { Receipt, UnsignedReceipt } from './schema.js';

/**
 * Recursively drop keys whose value is undefined. Nulls are preserved exactly.
 * Applied before every hash so presence/absence is deterministic.
 */
export function stripUndefined<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripUndefined(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = stripUndefined(v);
  }
  return out as T;
}

/**
 * The signing preimage: JCS of the receipt WITHOUT its signature.
 * AAT-00: "Signing process excludes the signature field itself from the hash."
 */
export function signingPreimage(unsigned: UnsignedReceipt): Uint8Array {
  return canonicalBytes(stripUndefined(unsigned));
}

export function signReceipt(unsigned: UnsignedReceipt, secretKey: Uint8Array): Receipt {
  const signature = toBase64Url(sign(signingPreimage(unsigned), secretKey));
  return { ...unsigned, signature };
}

export function verifyReceiptSignature(receipt: Receipt, publicKey: Uint8Array): boolean {
  const { signature, ...unsigned } = receipt;
  let sig: Uint8Array;
  try {
    sig = fromBase64Url(signature);
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  return verify(sig, signingPreimage(unsigned as UnsignedReceipt), publicKey);
}

/**
 * The canonical JSON text of a complete stored receipt. This exact string is
 * persisted and exported: verification must never depend on our ability to
 * reconstruct field presence from database columns.
 */
export function canonicalReceiptJson(receipt: Receipt): string {
  return canonicalize(stripUndefined(receipt));
}

/**
 * The chain link value: hex(SHA-256(JCS(complete stored record))), per AAT-00.
 * This is what the NEXT receipt carries as its prev_hash.
 *
 * Note the signature is INSIDE this hash -- the chain therefore commits to the
 * signatures too, so a valid-looking resignature cannot be swapped in silently.
 */
export function receiptHash(receipt: Receipt): string {
  return sha256Hex(new TextEncoder().encode(canonicalReceiptJson(receipt)));
}

/** Hash of an arbitrary payload, for input_hash / output_hash. */
export function payloadHash(payload: unknown): string {
  return sha256Hex(canonicalBytes(stripUndefined(payload)));
}

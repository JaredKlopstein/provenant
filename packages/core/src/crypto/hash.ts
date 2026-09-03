import { sha256 } from '@noble/hashes/sha2.js';
import { canonicalBytes } from '../canonical/jcs.js';

/** Lowercase hex, as required for prev_hash by the AAT draft. */
export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`not lowercase hex: ${hex.slice(0, 32)}`);
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromBase64Url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

/** SHA-256 of raw bytes, lowercase hex. */
export function sha256Hex(bytes: Uint8Array): string {
  return toHex(sha256(bytes));
}

/**
 * SHA-256 over the RFC 8785 canonical form of a JSON value.
 * This is THE hash primitive of the system: chain links, input_hash,
 * output_hash and approval binding all route through it.
 */
export function hashJson(value: unknown): string {
  return sha256Hex(canonicalBytes(value));
}

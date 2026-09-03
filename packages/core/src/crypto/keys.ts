/**
 * Ed25519 agent identity.
 *
 * Choice of algorithm, stated plainly because it diverges from the AAT draft:
 * draft-sharif-agent-audit-trail-00 mandates ECDSA P-256. We default to Ed25519
 * to line up with the direction agent identity is actually moving (RFC 9421 HTTP
 * Message Signatures and the Web Bot Auth drafts, which Cloudflare and Google are
 * pushing, use Ed25519), and because deterministic signatures remove an entire
 * class of nonce-reuse failure. Every receipt carries an explicit
 * `provenant.signature_alg`, so a verifier never has to guess -- and adding
 * P-256 later is an additive change, not a migration.
 *
 * NOTE: the Web Bot Auth drafts are individual IETF submissions with no working
 * group adoption as of this writing. The wire format may shift.
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { canonicalBytes } from '../canonical/jcs.js';
import { toBase64Url, fromBase64Url, toHex } from './hash.js';

// @noble/ed25519 v3 is hash-agnostic; wire up sync SHA-512 once, at load.
// Without this every sign/verify throws "hashes.sha512 not set".
ed.hashes.sha512 = sha512;

export const SIGNATURE_ALG = 'ed25519' as const;
export type SignatureAlg = typeof SIGNATURE_ALG;

/** Public key as an RFC 8037 OKP JWK -- the shape the key directory serves. */
export interface AgentJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string; // base64url raw public key
  kid?: string;
}

export interface Keypair {
  /** 32-byte Ed25519 seed. Secret. Never leaves the machine, never logged. */
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  /** RFC 7638 JWK thumbprint, base64url. Stable name for this key. */
  keyId: string;
}

export function generateKeypair(): Keypair {
  const secretKey = ed.utils.randomSecretKey();
  return fromSecretKey(secretKey);
}

export function fromSecretKey(secretKey: Uint8Array): Keypair {
  if (secretKey.length !== 32) {
    throw new Error(`Ed25519 secret key must be 32 bytes, got ${secretKey.length}`);
  }
  const publicKey = ed.getPublicKey(secretKey);
  return { secretKey, publicKey, keyId: jwkThumbprint(publicKeyToJwk(publicKey)) };
}

export function publicKeyToJwk(publicKey: Uint8Array): AgentJwk {
  return { kty: 'OKP', crv: 'Ed25519', x: toBase64Url(publicKey) };
}

export function jwkToPublicKey(jwk: AgentJwk): Uint8Array {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') {
    throw new Error(`unsupported key type ${jwk.kty}/${jwk.crv}; expected OKP/Ed25519`);
  }
  const pk = fromBase64Url(jwk.x);
  if (pk.length !== 32) throw new Error(`Ed25519 public key must be 32 bytes, got ${pk.length}`);
  return pk;
}

/**
 * RFC 7638 JWK thumbprint. The required members for an OKP key are exactly
 * {crv, kty, x}, hashed in lexicographic order with no whitespace -- which is
 * precisely what our JCS canonicalizer produces, so we reuse it rather than
 * hand-rolling a second ordering rule that could drift.
 */
export function jwkThumbprint(jwk: AgentJwk): string {
  return toBase64Url(sha256(canonicalBytes({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })));
}

/**
 * Self-certifying agent id. Deriving the default id from the key means a
 * substituted key yields a different id, so silent impersonation of the default
 * identity is not possible. Agents may still declare their own id; TOFU then
 * binds that id to the first key observed.
 */
export function deriveAgentId(publicKey: Uint8Array): string {
  return `urn:provenant:agent:${jwkThumbprint(publicKeyToJwk(publicKey))}`;
}

export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ed.sign(message, secretKey);
}

export function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return ed.verify(signature, message, publicKey);
  } catch {
    // A malformed signature or point is a verification failure, not a crash.
    // The verifier must never throw on adversarial input.
    return false;
  }
}

/** Hex fingerprint for human display (incident review, key rotation diffing). */
export function fingerprint(publicKey: Uint8Array): string {
  return toHex(sha256(publicKey)).slice(0, 16);
}

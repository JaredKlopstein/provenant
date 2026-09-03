/**
 * @provenant/verifier -- standalone, offline evidence verifier. MIT.
 *
 * This package is the credibility anchor of the whole product. Constraints,
 * enforced by scripts/check-boundaries.mjs in CI:
 *
 *   1. No import of @provenant/cloud. The paid package cannot be required to
 *      check the paid package's output.
 *   2. No import of @provenant/core either. A verifier sharing its hashing and
 *      canonicalization with the system it audits is not independent -- a bug
 *      there would be invisible to both. JCS, the chain walk and signature
 *      checking are reimplemented here from RFC 8785, RFC 8032 and the AAT
 *      draft; test/cross-impl.test.ts asserts the two agree byte-for-byte.
 *   3. No network module. "Can I run this on an air-gapped machine" is the
 *      first question a security reviewer asks, and the answer must never
 *      quietly become no. node:crypto is a platform builtin, not a dependency,
 *      and is used for RSA/ECDSA and X.509 in RFC 3161 tokens.
 *   4. Only @noble/ed25519 and @noble/hashes as dependencies.
 */
export { verifyBundle, BUNDLE_FORMAT } from './bundle.js';
export type {
  Bundle, BundleVerdict, BundleReceipt, BundleAnchor, AnchorVerdict,
  Failure, FailureKind, VerifyOptions,
} from './bundle.js';
export { verifyTimestampToken } from './rfc3161.js';
export type { TimestampVerdict, ChainStatus, CertRef } from './rfc3161.js';
export { canonicalize, canonicalBytes, CanonicalizationError } from './jcs.js';
export { receiptHash, verifyReceiptSignature, jwkToPublicKey, stripUndefined } from './receipt.js';
export { parseDer, DerError } from './der.js';

export const VERIFIER_VERSION = '0.1.0';

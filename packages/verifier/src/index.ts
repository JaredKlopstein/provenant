/**
 * @provenant/verifier -- the standalone, offline evidence verifier. MIT.
 *
 * STATUS: Phase 2. This package is scaffolded, licensed and boundary-enforced
 * in Phase 1, but deliberately not implemented yet: it verifies *bundles*, and
 * bundles are produced by the anchoring work in Phase 2. Shipping a half-built
 * verifier would be worse than shipping none, because this package is the single
 * thing a skeptical third party is asked to trust.
 *
 * Local chain verification is available today, free, via `provenant chain verify`.
 *
 * THE CONSTRAINTS THIS PACKAGE MUST HONOUR (CI-enforced, see
 * scripts/check-boundaries.mjs):
 *
 *   1. It must not import @provenant/cloud. Obvious: the paid package cannot be
 *      required to check the paid package's output.
 *
 *   2. It must not import @provenant/core either. This is STRICTER than the
 *      original requirement, deliberately. A verifier that shares its hashing and
 *      canonicalization code with the system it audits is not independent -- a bug
 *      or a backdoor in that shared code would be invisible to both. So the JCS
 *      canonicalizer, the chain walk and the signature check are reimplemented
 *      here from the specifications (RFC 8785, RFC 8032, SHA-256), and
 *      test/cross-impl.test.ts asserts the two implementations agree byte-for-byte
 *      on a shared corpus. That test is what stops the two from drifting.
 *
 *   3. It must not import any network module. No http, https, net, tls, dgram,
 *      no fetch libraries. A verifier that phones home is a verifier whose result
 *      you cannot trust in an air-gapped security review -- and "can I run this
 *      offline" is the first question an auditor asks.
 *
 *   4. Its only permitted dependencies are @noble/ed25519 and @noble/hashes.
 *
 * Planned surface:
 *   verifyBundle(bundle: unknown): BundleVerdict
 *   CLI: provenant-verify <bundle.json> [--json]
 */

export const VERIFIER_VERSION = '0.1.0';

/** Phase 2. Present so the intended contract is legible from Phase 1. */
export interface BundleVerdict {
  ok: boolean;
  /** Whether an external anchor was present AND validated. Without this, the
   *  bundle proves internal consistency only. */
  anchored: boolean;
  receipts_checked: number;
  failures: Array<{ seq: number; kind: string; message: string }>;
  intact_ranges: Array<{ from_seq: number; to_seq: number }>;
}

export function verifyBundle(_bundle: unknown): BundleVerdict {
  throw new Error(
    'provenant-verify is not implemented yet (Phase 2). ' +
      'For local chain integrity today, run: provenant chain verify --json',
  );
}

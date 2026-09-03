# @provenant/verifier

**MIT. Offline. Zero Provenant runtime dependencies.**

The standalone verifier for Provenant evidence bundles. Give it a bundle and it
tells you whether the records are intact, which ones are not, and whether the
chain was externally anchored -- with **no network access** and **no code from
the commercial package**.

That independence is the entire credibility of the product. It is enforced in CI,
not by convention:

- may not import `@provenant/cloud`
- may not import `@provenant/core` (so an audit of this code is a complete audit)
- may not import any network module
- only permitted dependencies: `@noble/ed25519`, `@noble/hashes`

Because it reimplements canonicalization and hashing rather than sharing them
with core, `test/cross-impl.test.ts` asserts the two implementations agree
byte-for-byte on a shared corpus.

## Status

Phase 2. Scaffolded and boundary-enforced now; implemented alongside the bundle
format it verifies.

For local chain integrity today: `provenant chain verify --json` (free, in core).

# @provenant/cloud

**Commercial. Not MIT.** See `LICENSE.commercial`.

This package is the paid tier: external anchoring, signed export bundles, the
hosted collector, and billing.

## Why the paywall is here and not somewhere else

Writing and chaining receipts locally is free and open source, because we want
Provenant to become the default thing agents write to. What we charge for is
making the chain provable to **someone who does not trust the operator**.

A self-hosted hash chain is self-attested. The operator could rewrite the whole
history, including the verification output that says the history is fine. That
makes it near-worthless in a security review. An externally anchored chain is
evidence, because the anchor is a commitment the operator cannot forge or
backdate.

That gap is the paywall. It is technically honest rather than artificial: we are
not withholding a feature, we are selling the one property a local system
physically cannot provide about itself.

## Boundary rules (enforced in CI)

- `core` must never import from `cloud`.
- `verifier` must never import from `cloud` **or** `core`, and must not import
  any network module.

`node scripts/check-boundaries.mjs` fails the build on violation.

## Status

Phase 1 ships `pricing.ts` only. Everything else lands in Phase 2.

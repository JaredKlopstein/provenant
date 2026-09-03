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

Shipped: RFC 3161 anchoring against real timestamp authorities, evidence bundle
export (JSON / PDF / HTML), and invoice computation derived from `pricing.ts`.

**Not shipped, despite scaffolding existing — do not present these as working:**

- **Receipt ingestion over HTTP.** The collector authenticates correctly
  (RFC 9421, replay and body-swap rejection all tested), but `POST /receipts`
  returns a documented "not implemented". The collector must never hold agent
  secret keys — otherwise a hosted deployment could forge its customers' records,
  which destroys the thing being sold — so agents sign locally and the submission
  protocol for pre-signed receipts still needs its own design pass.
- **Stripe integration.** `computeInvoice` and the catalog builder are real and
  tested, but there is no `stripe` dependency, no webhook handling and no
  subscription persistence. The client is an injected interface; nothing has ever
  called Stripe.

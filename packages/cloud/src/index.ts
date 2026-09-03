/**
 * Provenant Cloud -- COMMERCIAL, not MIT.
 *
 * Nothing in packages/core or packages/verifier may import from here; CI
 * enforces it (scripts/check-boundaries.mjs). The verifier in particular must
 * be able to validate a bundle with no network access and no code from this
 * package. That independence IS the product's credibility -- if it is ever
 * compromised, an anchored bundle stops being evidence and the business model
 * fails with it.
 *
 * Phase 2 will add, in this order:
 *   - Anchoring service, pluggable backend (TSA | transparency-log | noop),
 *     with a real RFC 3161 TSA as the default
 *   - Export bundle generator (JSON and PDF)
 *   - Hosted collector endpoint
 *   - Stripe billing against pricing.ts
 *
 * Phase 2 is where money starts. Nothing else gets built until it ships and
 * someone has paid.
 */
export * from './pricing.js';

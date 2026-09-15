# AGENTS.md

Operating guide for coding agents working this repository. Facts here are
derived from [README.md](README.md), the ADRs in `docs/adr/`, `package.json`
and `.github/workflows/ci.yml`. When they disagree, those sources win.

## Product

Provenant: tamper-evident receipts for autonomous agents. Agents write
structured receipts of every consequential action; Provenant hash-chains and
signs them so anyone can later prove the record was not altered.

## Purpose

Agents are the users; humans read the record during incidents, audits and
security reviews. The write path is designed for agents, the read path for
humans. The free tier proves internal consistency. The paid tier anchors the
chain head to an RFC 3161 timestamp authority the operator does not control,
which is what turns a log into evidence (see README, "What this is honestly
worth", and [ADR 0003](docs/adr/0003-anchoring.md)).

## Repository

- GitHub: https://github.com/JaredKlopstein/provenant
- pnpm workspace (`packages/*`), TypeScript, Vitest. Node >= 22.5.0, pnpm 11.15.1.
- Published packages: `@provenant/core`, `@provenant/verifier` (both MIT).
  `@provenant/cloud` is private and commercial.
- ADRs: `docs/adr/`. Landing page source: `docs/index.html`.

## Rules

1. Read [PRODUCT.md](PRODUCT.md) first.
2. Never expose secrets. Do not touch `.env*` files or `.github/workflows/`.
3. Run `pnpm run ci` before opening a PR. It must pass.
4. Keep changes scoped to the issue. No drive-by refactors or dependency changes.
5. From the README: "Test-first is mandatory for anything touching the hash
   chain, fencing tokens, idempotency or signature verification. Those are the
   only places correctness genuinely matters, and the places where a bug
   destroys the product's credibility."
6. The verifier package must stay offline and independent of `core` and
   `cloud`. `core` must never import `cloud`. This is enforced by
   `scripts/check-boundaries.mjs` as the first CI step, per
   [ADR 0001](docs/adr/0001-open-core-boundary.md).
7. Follow the README "Design laws": CLI is the reference surface, one typed
   action registry, every error teaches its own fix, idempotency and dry-run on
   every mutation.
8. Do not present partly built cloud features as working (README, "Status").

## Architecture

- `packages/core` (MIT): receipts, chaining, identity, CLI, local verify.
- `packages/verifier` (MIT): standalone offline verifier of evidence bundles;
  zero cloud, zero core, no network module.
- `packages/cloud` (commercial): anchoring, evidence bundles, collector, billing.

Design decisions live in `docs/adr/`: 0001 open-core boundary, 0002 receipt
shape, 0003 anchoring.

## Testing

```bash
pnpm install --frozen-lockfile
pnpm run ci
```

`ci` runs, in order: `lint:boundaries` (open-core import check), `typecheck`,
`test` (Vitest, all packages), `test:offline` (verifier tests only, proving it
works with no network and no code from core or cloud). CI runs this on Node
22.x and 24.x for every pull request and every push to `main`.

## Deployment

- npm publish of `@provenant/core` and `@provenant/verifier` via
  `pnpm run release` (`pnpm run release:dry` to rehearse). Human only.
- Landing page at https://jaredklopstein.github.io/provenant, served by
  GitHub Pages from `docs/`.

## Monitoring

None.

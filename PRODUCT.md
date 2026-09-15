# PRODUCT.md

Product facts for the AI Command Center. Derived from [README.md](README.md),
`docs/adr/`, `package.json` and `.github/workflows/ci.yml`. Operating rules for
agents are in [AGENTS.md](AGENTS.md).

## Identity

- Name: Provenant
- Tagline: tamper-evident receipts for autonomous agents
- Repository: https://github.com/JaredKlopstein/provenant
- Site: https://jaredklopstein.github.io/provenant
- Packages: `@provenant/core` (MIT), `@provenant/verifier` (MIT),
  `@provenant/cloud` (commercial, private, not published)
- Owner: Jared Klopstein

## Status

Development. README: "Phase 2 complete". Not built yet: contracts and
approvals (Phase 3); leases and fencing tokens (Phase 4); MCP adapter
(Phase 5). Parts of `cloud` are partly built and must not be presented as
working; see README "Status" and `packages/cloud/README.md`.

## Stack

- TypeScript, Node >= 22.5.0, pnpm 11.15.1 workspace, Vitest
- `core`: `@noble/ed25519`, `@noble/hashes`, `better-sqlite3`, `drizzle-orm`, `zod`
- `verifier`: `@noble/ed25519`, `@noble/hashes` only (no network module, by ADR 0001)
- `cloud`: `core`, `verifier`, `drizzle-orm`, `pdfkit`, `zod`
- Standards implemented: RFC 8785 canonicalization, SHA-256 chaining, Ed25519
  signatures, RFC 9421 HTTP Message Signatures, RFC 3161 timestamps

## Deployment

- npm: `pnpm run release` publishes `core` and `verifier`. Human action only.
- Landing page: GitHub Pages from `docs/` (`docs/index.html`, `docs/.nojekyll`).
- No other deployment target is described in the repository.

## Monitoring

None.

## Agents

- Coding agents (Claude, Hermes via the AI Command Center) work issues labeled
  `ai-ready`, following [AGENTS.md](AGENTS.md).
- Provenant's own end users are agents; they self-describe the service with
  `provenant discover --json` (README, "For agents").

## Permissions

| Scope | Allowed |
|---|---|
| Repository read/write (branches, commits, PRs) | yes |
| Production write (npm publish) | no |
| Secrets, `.env*`, `.github/workflows/` | no |

## Approval Policy

| Action | Approver |
|---|---|
| Production deployment (npm publish) | human |
| Destructive actions (history rewrite, deletes, data loss) | human |
| Permission changes | human |

## Important Constraints

- The open-core boundary is enforced in CI, not by convention: `core` never
  imports `cloud`; `verifier` imports neither and no network module
  ([ADR 0001](docs/adr/0001-open-core-boundary.md)).
- Test-first is mandatory for the hash chain, fencing tokens, idempotency and
  signature verification (README, "Development").
- Unmeasurable reliability rates are reported as `null` with a reason, never
  as `0` (README, "Agent reliability is a signal, not a guarantee").
- Provenant is not a compliance product and claims alignment, not
  conformance, with `draft-sharif-agent-audit-trail` (README, "Honest risks",
  [ADR 0002](docs/adr/0002-receipt-shape.md)).
- Unknown CLI options are rejected, not ignored (README, "Status").

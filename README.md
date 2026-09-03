# Provenant

**Tamper-evident receipts for autonomous agents.**

[jaredklopstein.github.io/provenant](https://jaredklopstein.github.io/provenant) ·
[`@provenant/core`](https://www.npmjs.com/package/@provenant/core) ·
[`@provenant/verifier`](https://www.npmjs.com/package/@provenant/verifier)

Agents write structured receipts of every consequential action they take.
Provenant hash-chains and signs them, so anyone can later prove the record was
not altered — and see exactly which record was, if one was.

Agents are the users. Humans read this during incidents, audits and security
reviews. The write path is designed for agents; the read path for humans.

```bash
provenant init --json
provenant record --action refund.issue \
  --action-detail '{"customer_id":"c_8812","amount_usd":42.50}' \
  --side-effect-class irreversible \
  --idempotency-key refund-c_8812-0001 --json
provenant chain verify --json
```

## Status: Phase 2 complete

**Free — Provenant Core (MIT):**

- Receipt recording with RFC 8785 canonicalization, SHA-256 chaining, Ed25519 signatures
- Self-registration with trust-on-first-use identity; RFC 9421 HTTP Message Signatures
- Local chain verification that names the exact broken receipt and proves the rest intact
- Derived agent reliability, with unmeasurable rates reported as `null` and a stated
  reason — never as a flattering `0`
- Idempotency replay (argument-checked), dry-run on every mutation, cursor
  pagination, field projection
- A CLI with `--json` on every command, and a self-describing manifest

Commands: `init`, `keygen`, `agent register`, `agent list`, `record`,
`chain verify`, `chain head`, `receipts query`, `anchor now`, `anchor list`,
`discover`. Unknown options are **rejected**, not ignored — a mistyped flag
could otherwise change what gets recorded — so the documented shorthands
(`--agent`, `--from`, `--to`) are real aliases and every alias is listed in
`discover`.

**Free — `provenant-verify` (MIT):** standalone offline bundle verification,
including full RFC 3161 timestamp checking. Verifying is never paywalled.

**Paid — Provenant Cloud:** RFC 3161 anchoring against a real timestamp
authority, and evidence bundle export (JSON, PDF, HTML).

**Partly built, and not to be presented as working** — the collector
authenticates correctly (RFC 9421, with replay and body-swap rejection tested)
but `POST /receipts` is a documented "not implemented"; and invoice computation
is real while nothing has ever called Stripe. Details in
[packages/cloud/README.md](packages/cloud/README.md).

Not built yet: contracts and approvals (Phase 3); leases and fencing tokens
(Phase 4); MCP adapter (Phase 5).

```bash
# free: record and verify locally
provenant record --action refund.issue --action-detail '{"amount_usd":42}' --json
provenant chain verify --json

# paid: anchor to an authority you don't control, then export evidence
provenant-cloud anchor now --backend tsa --json
provenant-cloud bundle export --format both --out evidence.json --json

# anyone, offline, with no Provenant server and no commercial code
npx @provenant/verifier evidence.json --trust digicert-root.pem
```

## What this is honestly worth

**A self-hosted chain is self-attested.** It proves internal consistency. It does
*not* prove the operator left history alone — an operator with database access
could rewrite everything, including the verification output that says everything
is fine. `chain verify` says so in its own response, every time.

That gap is the product boundary. External anchoring (paid) commits the chain
head to an RFC 3161 timestamp authority the operator does not control, which is
what turns a log into evidence. We are not withholding a feature; we are selling
the one property a local system physically cannot provide about itself.

How seriously we take this: `packages/cloud/test/forgery.test.ts` models an
adversary with full database access, the append-only triggers dropped, **and the
agents' signing keys**. It rebuilds the entire chain — every hash relinked, every
receipt re-signed — and confirms local verification is completely fooled. Then it
confirms the anchored bundle still fails, because the one thing the adversary
cannot forge is the authority's signature. See
[ADR 0003](docs/adr/0003-anchoring.md).

The local append-only database triggers stop application bugs and accidents, not
a determined operator. Do not oversell them.

## Honest risks

- **This does not make you compliant with anything.** Provenant produces
  tamper-evident records that *support* logging obligations such as EU AI Act
  Article 12. It is not a compliance product, we are not lawyers, and this is not
  legal advice. Compliance claims are legal exposure.
- **The regulatory deadline may move.** A Digital Omnibus proposal to delay parts
  of the EU AI Act has been under negotiation. If enforcement slips, the
  compliance pitch softens. The reliability and debugging pitch does not depend
  on regulation — lead with whichever lands.
- **The standard we align with is a draft with no IETF standing.**
  `draft-sharif-agent-audit-trail` may change. We pin the version we implement
  and document exactly where we diverge (see
  [ADR 0002](docs/adr/0002-receipt-shape.md)) — notably we default to Ed25519
  where the draft specifies ECDSA P-256, so **we claim alignment, not
  conformance**.
- **Web Bot Auth / RFC 9421 agent identity drafts are individual submissions**
  with no working group adoption. The wire format may shift.
- **An anchor does not prove completeness.** Truncating the un-anchored tail
  leaves a valid chain. Anchor cadence bounds the forgeable window; it does not
  eliminate it. The verifier reports `anchored_through_seq` and warns about
  un-anchored receipts rather than letting "anchored: true" imply more than it
  should.

## Agent reliability is a signal, not a guarantee

`agent list` derives per-agent contract-violation, lease-expiry and
approval-escalation rates. Two design choices worth knowing:

**Unmeasurable is `null`, never `0`.** Contracts are Phase 3 and leases are
Phase 4, so those rates cannot be computed yet. Reporting `0.0` would render a
flawless compliance record for an agent nobody has ever checked — precisely the
flattering false signal this product exists to prevent. A `null` carries a
plain-language reason instead.

**The numbers describe self-reported conduct.** They are derived from receipts
the agent chose to write. An agent that silently declines to record its failures
will look perfect. Receipts make recorded behaviour tamper-evident; they cannot
make unrecorded behaviour visible. Useful for spotting a degrading agent, useless
against a deliberately deceptive one — and that caveat ships inside the response,
not just here.

## What an anchor does and does not prove

| | Local chain | Anchored chain |
|---|---|---|
| Detects casual tampering | yes | yes |
| Detects a full rebuild by the operator | **no** | yes |
| Detects backdating after the anchor | no | yes |
| Detects truncation of the un-anchored tail | no | **no** |

That last row is why anchor cadence is a pricing tier rather than a checkbox:
daily anchoring bounds the forgeable window to a day, monthly to a month. The
CLI says so in `anchor list` output rather than leaving you to work it out.

## Architecture

```
packages/
  core/       MIT.        Receipts, chaining, identity, CLI, local verify.
  verifier/   MIT.        Standalone offline verifier. Zero cloud, zero core.
  cloud/      Commercial. Anchoring, bundles, collector, billing.
```

`core` must never import `cloud`. `verifier` must never import *either*, and must
not import a network module. This is enforced by
`scripts/check-boundaries.mjs` as the first CI step, not by convention — see
[ADR 0001](docs/adr/0001-open-core-boundary.md) for why the verifier's
independence is stricter than it strictly had to be.

## Design laws

1. **CLI is the reference surface.** MCP and HTTP are generated adapters, not the
   contract. CLI beats MCP on reliability and token cost for developer-shaped
   workflows.
2. **One typed action registry.** Every capability defined once — name,
   description, Zod input/output schemas, handler, side-effect class. A test
   fails the build if the surfaces expose different action sets.
3. **Descriptions are load-bearing.** Each action's description is a *structured
   type* with five required fields — what, when, when-not, cost, returns — so an
   incomplete description is a compile error, and a stub one is a test failure.
4. **Every error teaches its own fix.** Errors carry a `fix` block with
   ready-to-execute arguments and state whether the action executed.
5. **Every success states what's legal next.** `next_actions` carries fully-formed
   calls with ids filled in, not endpoint names.
6. **Token-budgeted by default.** Cursor pagination, `--fields`, `--depth`,
   explicit `truncated`.
7. **Idempotency and dry-run on every mutation.** A replay returns the *original*
   receipt. A dry run returns the exact receipt that would be written, applying
   nothing.

## For agents

Everything needed to operate this service is in one unauthenticated call:

```bash
provenant discover --json
```

It returns the full action list with input/output JSON Schemas, the error code
table with `fix` shapes, pagination conventions, and a literal ordered quickstart
from nothing to a first verified receipt. If an agent needs this README, the
manifest is incomplete — that is a bug in the manifest.

Reference clients: [TypeScript](examples/reference_client.ts) ·
[Python](examples/reference_client.py)

## Development

```bash
pnpm install
pnpm run ci     # boundaries, typecheck, tests
```

Test-first is mandatory for anything touching the hash chain, fencing tokens,
idempotency or signature verification. Those are the only places correctness
genuinely matters, and the places where a bug destroys the product's credibility.

## License

`core` and `verifier` are MIT. `cloud` is commercial — see
`packages/cloud/LICENSE.commercial`.

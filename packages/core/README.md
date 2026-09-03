# Provenant

**Tamper-evident receipts for autonomous agents.**

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
- Idempotency replay, dry-run on every mutation, cursor pagination, field projection
- A CLI with `--json` on every command, and a self-describing manifest

**Free — `provenant-verify` (MIT):** standalone offline bundle verification,
including full RFC 3161 timestamp checking. Verifying is never paywalled.

**Paid — Provenant Cloud:** RFC 3161 anchoring against a real timestamp
authority, evidence bundle export (JSON + PDF), the hosted collector, and billing.

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

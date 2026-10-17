# Getting started from source

`@provenant/core` and `@provenant/verifier` are not published to npm yet, so
`npx @provenant/...` will not work. Until they are, run both CLIs from a source
checkout. Every command below runs as written from a fresh clone, in order.

You need Node 22.5.0 or later and pnpm 11 (`corepack enable` provides the pnpm
version pinned in `package.json`).

## 1. Clone and build

```bash
git clone https://github.com/JaredKlopstein/provenant.git
cd provenant
pnpm install --frozen-lockfile
pnpm run build
```

`pnpm run build` compiles each package into its `dist/`. The bin scripts below
load from `dist/`, so they fail until this step has run.

## 2. Record and verify locally

Keep this walkthrough's keys and database inside the checkout rather than in
`~/.provenant`. `.provenant/` is gitignored.

```bash
export PROVENANT_HOME="$PWD/.provenant"
```

Create a keypair and register this agent. Running it again reuses the key.

```bash
node packages/core/bin/provenant.mjs init --json
```

The result carries your `agent_id`, the store path, the key fingerprint and
`key_created: true` on the first run.

Write a receipt:

```bash
node packages/core/bin/provenant.mjs record --action refund.issue \
  --action-detail '{"customer_id":"c_8812","amount_usd":42.50}' \
  --side-effect-class irreversible \
  --idempotency-key refund-c_8812-0001 --json
```

The result is the signed receipt plus its `seq`, `self_hash` and `prev_hash`.
The first receipt is `seq: 0` with `prev_hash: null`. Running the same command
again returns the original receipt with `replayed: true` and writes nothing,
because the idempotency key matches.

Verify the chain:

```bash
node packages/core/bin/provenant.mjs chain verify --json
```

| Field | Meaning |
|---|---|
| `ok` | `true` when every hash, link and signature checks out |
| `receipts_checked` | How many receipts were re-hashed and re-verified |
| `head` | The latest `seq` and its `self_hash` |
| `failures` | Each broken receipt by `seq`, with the reason |
| `intact_ranges` | The `seq` ranges that are still provably sound |
| `warnings` | Things that are not integrity failures, such as agent clock skew |
| `anchored` | Always `false` locally |
| `anchor_note` | The local chain is self-attested and proves internal consistency only |

That last row matters. An operator with database access could rewrite the
whole local chain and it would still verify. Anchoring to an external timestamp
authority closes that gap; see [ADR 0003](adr/0003-anchoring.md).

## 3. Verify a real anchored evidence bundle

[`examples/sample-evidence/evidence.json`](../examples/sample-evidence/evidence.json)
holds 3 receipts with the chain head timestamped by DigiCert's production
RFC 3161 authority. The verifier checks it offline, with no code from core or
cloud.

```bash
node packages/verifier/bin/provenant-verify.mjs examples/sample-evidence/evidence.json
```

It exits `0` and prints `VERIFIED / ANCHORED`, with
`trusted by you: NO -- pass --trust or --trust-fingerprint` under the anchor.
The timestamp is mathematically sound, but nothing has told the verifier to
trust DigiCert. A root certificate embedded in a bundle proves nothing, because
anyone can mint one, so trust has to come from you.

Pin DigiCert Trusted Root G4 by its certificate fingerprint:

```bash
node packages/verifier/bin/provenant-verify.mjs examples/sample-evidence/evidence.json \
  --trust-fingerprint 33846b545a49c9be4903c60e01713c1bd4e4ef31ea65cd95d69e62794f30b941
```

It exits `0`, prints `VERIFIED / ANCHORED`, and reports `trusted by you: yes`.
Confirm that fingerprint against DigiCert directly rather than taking it from
this file. A repository is exactly where an attacker would plant a fingerprint
they wanted you to trust.

To see a failure, copy the bundle, edit a value inside any `canonical_json`
string, and run the verifier on the copy. It names the broken receipt and
still reports which receipts around it remain intact.

## What each verdict line means

The banner at the top is one of three:

| Banner | Meaning | Exit code |
|---|---|---|
| `VERIFIED / ANCHORED` | Every receipt is consistent and correctly signed, and at least one external timestamp commits to this history | `0` |
| `VERIFIED / NOT ANCHORED` | Every receipt is consistent and correctly signed, but nothing external constrains the operator. Treat it as self-attested | `0` |
| `VERIFICATION FAILED` | At least one hash, link, signature or anchor did not check out | `1` |

A bundle that cannot be read at all exits `2`.

The sentence under the banner states the conclusion in plain language:

- `VERIFIED AND ANCHORED THROUGH SEQ n`: nothing at or before seq `n` could
  have been altered without breaking the timestamp. If receipts follow seq `n`,
  it says how many are backed only by the operator's own chain. If the
  authority is not in your trust list, it ends with a `NOTE` saying so.
- `VERIFIED BUT NOT ANCHORED`: internally consistent, but the operator could
  have rebuilt the whole history and it would verify the same way.
- `FORGERY DETECTED`: the receipts do not produce the head that was externally
  timestamped. History was altered after it was anchored.
- `VERIFICATION FAILED (KINDS)`: the failure kinds found, such as
  `HASH_MISMATCH` or `SIGNATURE_INVALID`, and the receipt ranges still intact.

Then:

| Line | Meaning |
|---|---|
| `chain` | The chain id the bundle covers |
| `range` | The first and last `seq` checked, and the receipt count |
| `seq n  [tsa]  EVIDENCE` | An anchor at seq `n` whose timestamp verifies and commits to these receipts. `not evidence` means it does not |
| `attested time` | The time the authority signed |
| `authority` | The certificate that signed the timestamp |
| `chain top` / `fingerprint` | The top of the authority's certificate chain and its SHA-256 fingerprint, the value to pin with `--trust-fingerprint` |
| `trusted by you` | `yes` only when a certificate in that chain matched `--trust` or `--trust-fingerprint` |
| `FAILURES` | Each problem by `seq`, with expected and actual values where they apply |
| `STILL PROVABLY INTACT` | The ranges unaffected by those failures |
| `WARNINGS` | Things worth knowing that are not failures |

Add `--json` to either verifier command for the machine-readable verdict.

## Once the packages are published

When `@provenant/core` and `@provenant/verifier` are on npm,
`npx @provenant/verifier <bundle.json>` will replace
`node packages/verifier/bin/provenant-verify.mjs <bundle.json>` and need no
checkout. Until then, use the commands above.

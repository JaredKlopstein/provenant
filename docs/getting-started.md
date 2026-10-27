# Getting started from source

`@lacre/core` and `@lacre/verifier` are not published to npm yet, so
`npx @lacre/...` and a global `lacre` command will not work. Until they
are, run everything from a source checkout. Every command below runs from the
repository root, in order, with no edits.

You need Node 22.5.0 or later and pnpm 11 (`corepack enable` provides the pinned
version).

## 1. Clone and build

```bash
git clone https://github.com/JaredKlopstein/lacre.git
cd lacre
pnpm install
pnpm run build
```

`pnpm run build` compiles each package into its `dist/` directory, which is
what the `bin/*.mjs` entry points load. Skip it and the commands below fail
with a module-not-found error.

## 2. Record and verify a receipt locally

By default Lacre keeps its store in `~/.lacre`. To keep this
walkthrough out of your home directory, point it at a store inside the checkout
(`.lacre/` is gitignored):

```bash
export LACRE_HOME="$PWD/.lacre"
```

Create a signing key and register this agent:

```bash
node packages/core/bin/lacre.mjs init --json
```

The response has `"ok": true`, your new `agent_id`, the store path and a
`next_actions` list suggesting what to call next.

Record one receipt:

```bash
node packages/core/bin/lacre.mjs record --action refund.issue \
  --action-detail '{"customer_id":"c_8812","amount_usd":42.50}' \
  --side-effect-class irreversible \
  --idempotency-key refund-c_8812-0001 --json
```

The response holds the signed receipt (`seq` 0, `prev_hash` null because it
is the first in the chain) and its `self_hash`. Run the same command again and
you get the original receipt back with `"replayed": true`. Nothing new is
written.

Record refusals too. When a consequential action is refused, by a policy, a
person or the agent itself, record it with `--outcome denied`, so the chain
shows the control working and not only what went through. `--outcome` also
takes `failure`, `timeout` and `escalated`; the default is `success`.

Verify the chain:

```bash
node packages/core/bin/lacre.mjs chain verify --json
```

Expect `"ok": true`, `"failures": []` and `"anchored": false`, together with an
`anchor_note` saying the chain is self-attested. That note is the honest limit
of a local chain: it proves internal consistency, not that the operator left
history alone. See "What this is honestly worth" in the
[README](../README.md#what-this-is-honestly-worth).

## 3. Verify a real anchored evidence bundle, offline

[`examples/sample-evidence/evidence.json`](../examples/sample-evidence/README.md)
is a genuine bundle of 3 receipts whose chain head was timestamped by DigiCert's
production RFC 3161 authority. The verifier needs no network access and no code
from `core` or `cloud`:

```bash
node packages/verifier/bin/lacre-verify.mjs examples/sample-evidence/evidence.json
```

It exits `0` and prints:

```
------------------------------------------------------------------------
VERIFIED / ANCHORED
------------------------------------------------------------------------
...
ANCHORS
  seq 2  [tsa]  EVIDENCE
    attested time : 2026-09-03T18:42:30.000Z
    authority     : C=US, O=DigiCert\, Inc., CN=DigiCert SHA256 RSA4096 Timestamp Responder 2026 1
    chain top     : C=US, O=DigiCert Inc, OU=www.digicert.com, CN=DigiCert Trusted Root G4
    fingerprint   : 33846b545a49c9be4903c60e01713c1bd4e4ef31ea65cd95d69e62794f30b941
    trusted by you: NO -- pass --trust or --trust-fingerprint
```

The mathematics checks out, but the authority is **not in your trust list**.
Trust has to come from you, not from the bundle, because anyone can embed a
self-signed root. To close that loop, pin DigiCert Trusted Root G4 by its
fingerprint:

```bash
node packages/verifier/bin/lacre-verify.mjs examples/sample-evidence/evidence.json \
  --trust-fingerprint 33846b545a49c9be4903c60e01713c1bd4e4ef31ea65cd95d69e62794f30b941
```

It still exits `0` with `VERIFIED / ANCHORED`, and the anchor now reports
`trusted by you: yes`. Confirm that fingerprint with DigiCert directly rather
than taking it from this file. A repository is exactly where an attacker would
plant a fingerprint they wanted you to trust.

Add `--json` to either command for a machine-readable verdict.

## What each verdict line means

The first line of the verifier's output is the verdict:

| Verdict | Exit | Meaning |
|---|---|---|
| `VERIFIED / ANCHORED` | 0 | Every receipt is intact and correctly signed, and at least one external timestamp commits to the chain head that was recomputed. Receipts after the highest anchored `seq` are still unanchored; the verifier warns about them. |
| `VERIFIED / NOT ANCHORED` | 0 | Every receipt is intact and correctly signed, but no external timestamp commits to the chain. The record is self-attested, the same guarantee as a local `chain verify`. |
| `VERIFICATION FAILED` | 1 | At least one receipt is altered, missing or wrongly signed. `FAILURES` names each one by `seq` (for example `HASH_MISMATCH`, `SIGNATURE_INVALID`), and `STILL PROVABLY INTACT` lists the ranges you can still rely on. |
| *(usage message on stderr)* | 2 | The bundle could not be read, or an option was unknown or malformed. No verdict is given. |

Each entry under `ANCHORS` reports:

- `EVIDENCE` or `not evidence`: whether this anchor actually constrains the
  operator, meaning its timestamp verifies **and** commits to the chain head
  the verifier recomputed.
- `attested time`: when the authority says the chain had reached this `seq`.
- `authority` and `chain top`: who signed the timestamp, and the top of the
  certificate chain that was found.
- `trusted by you`: whether a certificate in that chain matched `--trust` or
  `--trust-fingerprint`. Soundness and trust are reported separately and never
  merged.

To see a failure, edit any value inside a `canonical_json` string in a copy of
`evidence.json` and run the verifier on the copy. It names the exact receipt
and exits `1`.

## Once the packages are published

When `@lacre/core` and `@lacre/verifier` are on npm, `npx
@lacre/verifier` replaces `node packages/verifier/bin/lacre-verify.mjs`,
and an installed `lacre` command replaces `node
packages/core/bin/lacre.mjs`. The arguments stay the same.

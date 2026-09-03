# ADR 0001: The open-core boundary is a directory boundary, enforced in CI

**Status:** Accepted (Phase 1)

## Context

Provenant is open core. Receipts, chaining, contracts, leases and local
verification are MIT and free. Anchoring and evidence bundles are paid.

The temptation in every open-core codebase is to let the boundary become a
convention: a comment, a folder name, a code-review habit. It then erodes, and
by the time anyone notices, the open package cannot be built or audited without
the commercial one.

For Provenant that erosion is not a licensing inconvenience. It is fatal. The
product's entire claim is "a third party who does not trust the operator can
verify this." If verification requires code from the package the operator pays
for and controls, the claim is circular and the evidence is worthless.

## Decision

Three packages, with import rules enforced by `scripts/check-boundaries.mjs`
running as the **first** CI step:

| Package | License | May import |
|---|---|---|
| `packages/core` | MIT | anything except `cloud` |
| `packages/verifier` | MIT | **neither `core` nor `cloud`**, and no network module |
| `packages/cloud` | Commercial | anything |

Two decisions here are stricter than strictly required:

**The verifier may not import `core`.** The brief only required independence
from the *paid* package. We went further. A verifier that shares its
canonicalization and hashing code with the system it audits is not independent:
a bug or a backdoor in that shared code is invisible to both sides. So the
verifier reimplements JCS, the chain walk and signature checking from the
specifications, and a cross-implementation test asserts the two agree
byte-for-byte on a shared corpus. The duplication is the point; the test is what
stops it drifting.

**The verifier may not import any network module.** "Can I run this offline, on
an air-gapped machine, without talking to you" is the first question a security
reviewer asks. Enforcing it mechanically means the answer can never quietly
become "no".

The check is a dependency-free source scan rather than an ESLint rule,
specifically so it cannot be silenced with an inline disable comment.

## Consequences

- Some code is duplicated between `core` and `verifier`. Accepted, and guarded
  by a cross-implementation test.
- Adding a network call to the verifier fails the build. Intended.
- The commercial package can freely depend on `core`.

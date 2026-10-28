# ADR 0005: Self-serve evidence bundles, without the receipts leaving the buyer

**Status:** Proposed. Not built. Needs the owner's decision on the open question below.

## Context

An evidence bundle can be bought today (`/checkout`, $15). A paid checkout
records a bundle credit (`billing_bundle_credits`, written by the billing
webhook), but nothing redeems it. The bundle is made by hand: the buyer emails
their chain file (`lacre.db`, never `agent.key.json`), it is anchored with
`lacre-cloud anchor now`, exported with `lacre-cloud bundle export`, and emailed
back. The site says exactly that (`BUNDLE_FULFILMENT` in
`packages/site/src/plans.ts`).

That works, and it is honest, but it has two costs beyond time:

- **The buyer sends us their receipts.** Those include action details their
  agents recorded. The Privacy Policy has to describe receiving and keeping them.
- **Anchoring happens when we get to it**, not when the buyer asks, so the
  timestamp lands later than it could. An anchor proves the chain existed when it
  was anchored, not earlier (ADR 0003), so every hour of delay is an hour of
  history the anchor does not cover.

The receipts are not needed to anchor. ADR 0003 timestamps a JCS statement,
`{ v, chain_id, seq, head_hash, receipt_count }`, which the buyer can compute
locally from their own store.

## Proposed decision

### 1. An anchoring endpoint that redeems a credit and sees only the statement

`POST /api/anchor` on the site, for a signed-in account (or an account API key,
for agents):

- **Request:** the statement above, plus an `idempotency_key`. No receipts and
  no keys.
- **Server:** validates the statement's shape, then in one transaction
  **consumes exactly one unredeemed bundle credit** for the account, keyed by
  `idempotency_key`. It calls the configured RFC 3161 authority through the
  existing `tsa` backend over the statement's canonical bytes and returns the
  token, the proven time and the authority.
- **Idempotency:** a retry with the same key and the same statement returns the
  same token and consumes nothing. The same key with a different statement is
  refused (`IDEMPOTENCY_CONFLICT`), matching how `record` treats a reused key
  with different arguments.
- **No credit:** `402` with a typed error whose `fix` says to buy a bundle. The
  route never calls the authority before a credit is held.
- The server stores the statement and token against the redeemed credit, so a
  copy of the anchor exists if the buyer loses theirs (the "we hold a copy"
  promise), without holding any receipt.

### 2. The buyer's CLI files the token and exports the bundle locally

`lacre anchor import --token <file>` (or `anchor now --backend remote`) stores
the returned token as an anchor in the buyer's own store. It applies the same
checks as a local anchor: the statement must match the store's chain at that
seq, and a contradicting head is refused (`ANCHOR_CONTRADICTION`, ADR 0003).

`bundle export` then runs on the buyer's machine and produces the same
`lacre-bundle-v1` the verifier already checks. Nothing in the verifier changes.

### Open question for the owner: where `bundle export` lives

Export packages receipts, public keys and anchor tokens into a file. Today it is
in `@lacre/cloud` (commercial, not distributed). For step 2 to run on the
buyer's machine it has to ship to them. The options:

- **(a) Move JSON export into `@lacre/core` (MIT).** The paid property stays
  the external anchor, which is what ADR 0003 says is sold. A bundle with no
  external anchor already verifies only as `VERIFIED / NOT ANCHORED`, so a free
  export adds no proof. PDF and HTML rendering can stay in cloud or move with it.
  This amends ADR 0001's "anchoring and evidence bundles are paid" to "anchoring
  is paid".
- **(b) Ship a commercial CLI** (a published, licensed `lacre-cloud`) that holds
  export and the remote anchor client. It keeps ADR 0001 as written, at the cost
  of a second distributed package and its licence terms.

Recommendation: **(a)**. It keeps one CLI (README design law: the CLI is the
reference surface) and draws the paywall where the technical difference
actually is.

## Testing (test-first, per the README)

These touch idempotency and anchoring, so their tests come first:

- **Credit consumption:**
  - Two concurrent requests with one credit yield one token and one `402`.
  - A retry with the same key consumes nothing.
  - The same key with a different statement is refused.
- **Statement binding:**
  - A token minted for one statement is rejected on import into a store whose
    chain id, seq or head differs (this reuses the stolen-token test from ADR 0003).
- **No receipt reaches the server:**
  - The route rejects any body field beyond the statement and key.
  - A test asserts the stored row has no receipt content.
- **End to end:**
  - Record → `chain head` → `POST /api/anchor` (TSA mocked as the existing
    test authority) → `anchor import` → `bundle export`.
  - The verifier reports `VERIFIED / ANCHORED`.

## Consequences

- Receipts never leave the buyer, so the Privacy Policy's chain-file section and
  the `bundleRetention` fact can be retired once the manual path is.
- Anchoring happens when the buyer asks, so the anchor covers more of their
  history.
- Manual fulfilment remains the fallback until this ships. The site copy changes
  in the same PR that turns this on, and not before (Cloud-style "never shown as
  working" applies to this path too).
- Under option (a), ADR 0001 is amended in the same PR, and
  `scripts/check-boundaries.mjs` is unchanged: core still never imports cloud.

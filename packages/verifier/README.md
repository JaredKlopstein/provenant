# @provenant/verifier

**MIT. Offline. Zero Provenant runtime dependencies.**

Verifies a Provenant evidence bundle and tells you whether the records are
intact, exactly which ones are not, and whether the chain was externally
anchored — with **no network access** and **no code from the commercial
package**.

```bash
npx @provenant/verifier evidence.json --trust digicert-root.pem
```

Exit codes: `0` verified, `1` verification failed, `2` bundle unreadable.

## Why this package is deliberately paranoid

It is the credibility anchor of the whole product, so its independence is
enforced in CI rather than by convention:

- may not import `@provenant/cloud`
- may not import `@provenant/core` — so auditing this package is a *complete*
  audit of the verification path
- may not import any network module (`node:crypto` is a platform builtin, not a
  dependency, and is used for RSA/ECDSA and X.509 inside RFC 3161 tokens)
- only permitted dependencies: `@noble/ed25519`, `@noble/hashes`

Because it reimplements JCS canonicalization, receipt hashing and signature
checking rather than sharing them with core, `test/cross-impl.test.ts` asserts
the two implementations agree byte-for-byte across the RFC 8785 vectors and 500
randomized structures. The duplication is the point; the test prevents drift.

The DER parser and RFC 3161 verifier are written from the specifications for the
same reason: a few hundred lines of explicit parsing is a smaller thing to audit
than a general-purpose ASN.1 library, and it keeps the trust path free of
third-party code.

## Soundness and trust are reported separately

`ok` means the mathematics checks out: the signature verifies under the signer
certificate, the signed attributes bind the timestamped content, the signer
carries the `timeStamping` extended key usage, and the digest is the one we
expected.

`trusted` means a certificate in the chain was in **your** trust list.

These are different claims and the tool never merges them. A self-signed root
embedded in a bundle proves nothing — anyone can mint one — so trust only ever
comes from `--trust` or `--trust-fingerprint`.

Real-world note: DigiCert and Sectigo deliberately omit their root from tokens
and expect you to hold it. An incomplete chain is therefore reported as a chain
*status*, not a cryptographic failure.

## Tested against real authorities

`test/fixtures/` holds genuine timestamp tokens from freetsa, DigiCert and
Sectigo. Testing an RFC 3161 parser only against tokens from our own encoder
would be circular — a shared misreading of the spec would pass on both sides.

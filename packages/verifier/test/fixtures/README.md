# Real timestamp-token fixtures

These are **genuine RFC 3161 TimeStampTokens** fetched from three public
timestamp authorities on 2026-09-03, each timestamping
`SHA-256("provenant-tsa-probe")` (see `probe_digest.bin`).

They are committed deliberately. Testing an RFC 3161 parser only against tokens
produced by our own encoder is circular: a shared misreading of the spec would
pass on both sides. These prove the parser handles what real authorities
actually emit — including the awkward parts:

- **freetsa** embeds its self-signed root, so the chain completes inside the token.
- **digicert** and **sectigo** deliberately omit the root and ship only up to an
  intermediate, expecting the verifier to hold the root. That is normal
  commercial PKI practice and is why chain completeness is reported separately
  from cryptographic soundness.

They do not expire as tests: certificate validity is checked against the token's
own attested time, not against the wall clock.

# A real anchored evidence bundle

`evidence.json` is a genuine Provenant bundle: 3 receipts, hash-chained and
Ed25519-signed, with the chain head timestamped by **DigiCert's production
RFC 3161 authority** on 2026-09-03.

Nothing here is mocked. You can check it yourself, offline, right now:

```bash
npx @provenant/verifier examples/sample-evidence/evidence.json
```

It will report `VERIFIED / ANCHORED` and print DigiCert as the attesting
authority — while also telling you the authority is **not in your trust list**,
because trust has to come from you, not from the bundle. To close that loop, pin
the root:

```bash
npx @provenant/verifier examples/sample-evidence/evidence.json \
  --trust-fingerprint 33846b545a49c9be4903c60e01713c1bd4e4ef31ea65cd95d69e62794f30b941
```

That fingerprint is DigiCert Trusted Root G4. Confirm it against DigiCert
directly rather than taking it from this file — a repository is exactly the kind
of place an attacker would put a fingerprint they wanted you to trust.

## Try to break it

The point of the bundle is that tampering is detectable. Edit any value inside a
`canonical_json` string and re-run the verifier: it will name the exact receipt,
report `HASH_MISMATCH` and `SIGNATURE_INVALID`, and still prove which receipts
around it remain intact.

For the harder attack — rebuilding the whole chain with valid signatures, which
defeats local verification entirely — see
`packages/cloud/test/forgery.test.ts`. The anchor is what catches that one.

## evidence.pdf and evidence.html

The human-readable summaries. Both say on their own face that they are **not**
the evidence: neither carries cryptography and anyone can edit them. They exist
so an auditor can understand what the bundle says and how to check it themselves.

`evidence.html` is the primitive behind the hosted verifier page. It is fully
self-contained — no scripts, no CDN, no external fonts or images — because an
evidence report that phones out to a third party cannot be opened in the
air-gapped room where audits actually happen, and would leak the reader's
identity if it could.

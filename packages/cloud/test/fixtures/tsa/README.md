# Test timestamp authority — THROWAWAY KEYS, NOT SECRETS

**The private keys in this directory are deliberately public.** They belong to a
throwaway CA generated solely so the forgery and tamper tests can mint real
RFC 3161 tokens offline and deterministically. They protect nothing, they are
trusted by nobody, and leaking them costs nothing.

If a secret scanner flags `ca.key.pem` or `tsa.key.pem`, this is why.

## Why mint tokens at all instead of mocking

The forgery test needs to timestamp a digest that is only known at test time (the
chain head varies per run), so a pre-recorded token cannot work. Mocking the
verification would test nothing — the point of that suite is to exercise the real
cryptographic path.

## Why this is not circular

An authority we build ourselves risks the encoder and the parser sharing a
misreading of the spec, agreeing with each other, and both being wrong. That is
guarded separately: `packages/verifier/test/fixtures/` holds genuine tokens from
freetsa, DigiCert and Sectigo, and the parser is tested against those too.

## Regenerating

```bash
openssl req -x509 -newkey rsa:2048 -keyout ca.key.pem -out ca.cert.pem \
  -days 7300 -nodes -subj "/O=Provenant Test/CN=Provenant Test Root CA"

openssl req -newkey rsa:2048 -keyout tsa.key.pem -out tsa.csr.pem -nodes \
  -subj "/O=Provenant Test/CN=Provenant Test TSA"

openssl x509 -req -in tsa.csr.pem -CA ca.cert.pem -CAkey ca.key.pem \
  -CAcreateserial -out tsa.cert.pem -days 7300 \
  -extfile tsa.cnf -extensions ext && rm tsa.csr.pem ca.cert.srl
```

The `timeStamping` extended key usage in `tsa.cnf` is not optional: the verifier
rejects a signer without it, because otherwise any certificate from a trusted CA
could mint timestamps. That is a classic RFC 3161 implementation hole.

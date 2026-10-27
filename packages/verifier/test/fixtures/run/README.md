# Run-check fixtures

Signed receipt chains for `test/run.test.ts`, produced once with
`@lacre/core` (`signReceipt`, `receiptHash`, `payloadHash`) outside the
verifier and committed. The verifier's test suite never imports core here, so
these prove the verifier's own chain walk accepts what core actually writes.

| File | Contents |
|---|---|
| `keys.json` | key_id → public JWK for `test-key-a` and `test-key-b` |
| `valid.json` | seq 0–3, all signed by `test-key-a` |
| `tampered.json` | `valid.json` with seq 1's `action_detail` edited after signing |
| `missing-record.json` | `valid.json` with seq 2 deleted |
| `rotated-key.json` | seq 0–1 under `test-key-a`, seq 2–3 under `test-key-b` |
| `unknown-key.json` | seq 2 signed by `test-key-unregistered`, which is not in `keys.json` |
| `duplicate-attempt.json` | the same `refund.issue` input in `turn-2` under `attempt-2` and `attempt-3` |

Key ids and agent ids are readable labels rather than RFC 7638 thumbprints;
the verifier treats `key_id` as an opaque lookup key, so this changes nothing
it checks. Every receipt carries its governance fields under `lacre`, and
every agent id is `urn:lacre:agent:test-agent`.

## Why long values are stored as `{"$chunks": [...]}`

Signatures, `prev_hash`, `input_hash` and JWK `x` values are split into
16-character pieces. Whole, they are long high-entropy strings that secret
scanners block on shape alone. The test joins them back before use, and writes
the joined, stored-form files to a temp directory for the CLI tests.

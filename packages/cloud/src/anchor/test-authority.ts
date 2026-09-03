/**
 * In-process timestamp authority, for tests only.
 *
 * Exists so the forgery and tamper tests run offline and deterministically. It
 * mints genuine RFC 3161 tokens with a committed test CA, so the tests exercise
 * the real verification path rather than a mock.
 *
 * The obvious risk with a self-built authority is circularity: if the encoder
 * and the parser share a misreading of the spec, both agree and the tests pass
 * anyway. That is guarded separately -- the parser is also tested against real
 * tokens from freetsa, DigiCert and Sectigo in
 * packages/verifier/test/fixtures.
 */
import { readFileSync } from 'node:fs';
import { createPrivateKey, X509Certificate, type KeyObject } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnchorBackend, AnchorProof } from '@provenant/core';
import { mintTimeStampToken } from './cms.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/tsa');

export interface TestAuthorityOptions {
  /** Attested time. Defaults to now. Lets a test place an anchor in time. */
  now?: () => Date;
}

export interface TestAuthority extends AnchorBackend {
  /** SHA-256 fingerprint of the test root, for trust pinning in assertions. */
  rootFingerprint: string;
  caCertPem: string;
}

export function createTestAuthority(opts: TestAuthorityOptions = {}): TestAuthority {
  const tsaCertPem = readFileSync(join(FIXTURES, 'tsa.cert.pem'), 'utf8');
  const caCertPem = readFileSync(join(FIXTURES, 'ca.cert.pem'), 'utf8');
  const key: KeyObject = createPrivateKey(readFileSync(join(FIXTURES, 'tsa.key.pem'), 'utf8'));
  let serial = 1;

  return {
    name: 'test-tsa',
    description: 'In-process RFC 3161 authority backed by a committed test CA. Tests only; never trust it in production.',
    isExternal: true,
    rootFingerprint: new X509Certificate(caCertPem).fingerprint256.replace(/:/g, '').toLowerCase(),
    caCertPem,

    async anchor(_statement, imprint): Promise<AnchorProof> {
      const time = opts.now ? opts.now() : new Date();
      const token = mintTimeStampToken({
        imprint,
        signerCertPem: tsaCertPem,
        signerKey: key,
        chainPem: [tsaCertPem, caCertPem],
        time,
        serial: serial++,
      });
      return {
        type: 'rfc3161',
        token: Buffer.from(token).toString('base64'),
        proven_time: time.toISOString(),
        authority: 'Provenant Test TSA',
      };
    },
  };
}

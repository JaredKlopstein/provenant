import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, createHash, X509Certificate } from 'node:crypto';
import { verifyTimestampToken, parseDer } from '@provenant/verifier';
import { mintTimeStampToken } from '../src/anchor/cms.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const F = join(HERE, 'fixtures/tsa');
const tsaCert = readFileSync(join(F, 'tsa.cert.pem'), 'utf8');
const caCert = readFileSync(join(F, 'ca.cert.pem'), 'utf8');
const key = createPrivateKey(readFileSync(join(F, 'tsa.key.pem'), 'utf8'));

/** Pull a real, well-known root out of the committed sample bundle -- exactly
 *  what an attacker would do, since that file is public. */
function digicertRootPem(): string {
  const bundle = JSON.parse(
    readFileSync(join(HERE, '../../../examples/sample-evidence/evidence.json'), 'utf8'),
  ) as { anchors: Array<{ proof: { token: string } }> };
  const token = new Uint8Array(Buffer.from(bundle.anchors[0]!.proof.token, 'base64'));
  const stack = [parseDer(token)];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.cls === 2 && n.tagNumber === 0 && n.constructed) {
      for (const c of n.children ?? []) {
        try {
          const x = new X509Certificate(Buffer.from(c.full));
          if (x.subject.includes('Trusted Root G4')) return x.toString();
        } catch { /* not a cert */ }
      }
    }
    for (const c of n.children ?? []) stack.push(c);
  }
  throw new Error('DigiCert root not found in the sample bundle');
}

const imprint = new Uint8Array(createHash('sha256').update('forged-statement').digest());
const mint = (chainPem: string[]) =>
  mintTimeStampToken({ imprint, signerCertPem: tsaCert, signerKey: key, chainPem, time: new Date(), serial: 7 });

/**
 * REGRESSION: a decoy certificate in the token must not confer trust.
 *
 * This shipped as a real vulnerability. `trusted` was computed by matching the
 * caller's pins against every certificate in the token's CertificateSet -- which
 * is entirely attacker-controlled. An attacker could append a genuine
 * well-known root that was never used to verify anything, and be reported as
 * trusted. The root is trivially obtainable: the one used here is lifted from
 * this repository's own public sample bundle.
 *
 * Trust must be derived ONLY from certificates the chain walk actually verified.
 */
describe('a decoy certificate in the token cannot confer trust', () => {
  const decoy = digicertRootPem();
  const realRootFp = new X509Certificate(decoy).fingerprint256.replace(/:/g, '').toLowerCase();

  it('does not trust an attacker token that merely carries a trusted root', () => {
    const v = verifyTimestampToken(mint([tsaCert, caCert, decoy]), {
      expectedImprint: imprint,
      trustedFingerprints: [realRootFp], // the victim trusts ONLY DigiCert
    });

    // The token is internally well-formed and self-consistent...
    expect(v.ok).toBe(true);
    // ...but it was signed by the attacker, so it must NOT be trusted.
    expect(v.trusted).toBe(false);
    expect(v.signer).toContain('Provenant Test TSA');
    expect(v.chain.root?.subject).toContain('Provenant Test Root CA');
  });

  it('excludes unverified certificates from the eligible-for-trust set', () => {
    const v = verifyTimestampToken(mint([tsaCert, caCert, decoy]), { expectedImprint: imprint });
    const fps = v.chain.verified.map((c) => c.fingerprint_sha256);
    expect(fps).not.toContain(realRootFp);
    // Only the signer and its genuine issuer were verified.
    expect(v.chain.verified).toHaveLength(2);
  });

  it('still trusts the token when the pin matches a certificate actually in the chain', () => {
    const caFp = new X509Certificate(caCert).fingerprint256.replace(/:/g, '').toLowerCase();
    const v = verifyTimestampToken(mint([tsaCert, caCert]), {
      expectedImprint: imprint,
      trustedFingerprints: [caFp],
    });
    expect(v.trusted).toBe(true);
  });

  it('honours trustAnchors and trustedFingerprints together, not one or the other', () => {
    // Previously an if/else-if: supplying fingerprints silently disabled anchors.
    const caFp = new X509Certificate(caCert).fingerprint256.replace(/:/g, '').toLowerCase();
    const withBoth = verifyTimestampToken(mint([tsaCert, caCert]), {
      expectedImprint: imprint,
      trustedFingerprints: ['00'.repeat(32)],
      trustAnchors: [new X509Certificate(caCert)],
    });
    expect(withBoth.trusted).toBe(true);

    const anchorsOnly = verifyTimestampToken(mint([tsaCert, caCert]), {
      expectedImprint: imprint,
      trustAnchors: [new X509Certificate(caCert)],
    });
    expect(anchorsOnly.trusted).toBe(true);
    expect(caFp).toBeTruthy();
  });
});

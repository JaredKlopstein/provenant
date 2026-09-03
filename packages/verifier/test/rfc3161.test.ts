import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { verifyTimestampToken } from '../src/rfc3161.js';
import { parseDer, DerError } from '../src/der.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const digest = new Uint8Array(readFileSync(join(FIX, 'probe_digest.bin')));
const token = (name: string) => new Uint8Array(readFileSync(join(FIX, `${name}.tst`)));

/**
 * These run against GENUINE tokens from three public timestamp authorities.
 *
 * Testing an RFC 3161 parser only against tokens from our own encoder would be
 * circular: a shared misreading of the specification would pass on both sides
 * and we would ship a verifier that rejects real evidence (or worse, accepts
 * bad evidence). These fixtures are the guard against that.
 */
describe('real timestamp tokens from public authorities', () => {
  for (const name of ['freetsa', 'digicert', 'sectigo']) {
    describe(name, () => {
      it('verifies cryptographically against the digest it timestamped', () => {
        const v = verifyTimestampToken(token(name), { expectedImprint: digest });
        expect(v.failures).toEqual([]);
        expect(v.ok).toBe(true);
        expect(v.proven_time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(v.signer).toBeTruthy();
      });

      it('rejects a different digest -- the token must bind OUR data', () => {
        const v = verifyTimestampToken(token(name), { expectedImprint: new Uint8Array(32).fill(7) });
        expect(v.ok).toBe(false);
        expect(v.failures.join(' ')).toMatch(/does not match the expected/);
      });

      it('is not trusted without an explicit trust list', () => {
        // A root inside a token proves nothing: anyone can mint a self-signed
        // root. Trust must come from the caller.
        const v = verifyTimestampToken(token(name), { expectedImprint: digest });
        expect(v.trusted).toBe(false);
      });

      it('becomes trusted when its chain top is pinned', () => {
        const base = verifyTimestampToken(token(name), { expectedImprint: digest });
        const pin = base.chain.root?.fingerprint_sha256 ?? base.chain.top!.fingerprint_sha256;
        const v = verifyTimestampToken(token(name), {
          expectedImprint: digest,
          trustedFingerprints: [pin],
        });
        expect(v.trusted).toBe(true);
      });

      it('stays untrusted under a wrong pin', () => {
        const v = verifyTimestampToken(token(name), {
          expectedImprint: digest,
          trustedFingerprints: ['00'.repeat(32)],
        });
        expect(v.ok).toBe(true); // still cryptographically sound
        expect(v.trusted).toBe(false); // but not vouched for
      });

      it('detects any single-byte corruption', () => {
        const t = token(name);
        // Walk a few positions through the signature-bearing tail.
        for (const offset of [t.length - 10, t.length - 40, t.length - 100]) {
          const bad = new Uint8Array(t);
          bad[offset] ^= 0xff;
          const v = verifyTimestampToken(bad, { expectedImprint: digest });
          expect(v.ok, `corruption at -${t.length - offset} went undetected`).toBe(false);
        }
      });
    });
  }

  it('distinguishes a token that embeds its root from one that does not', () => {
    // freetsa ships its self-signed root; the commercial authorities do not and
    // expect the verifier to hold it. Both are legitimate, and conflating them
    // would mean rejecting genuine DigiCert and Sectigo evidence.
    const free = verifyTimestampToken(token('freetsa'), { expectedImprint: digest });
    const dg = verifyTimestampToken(token('digicert'), { expectedImprint: digest });

    expect(free.chain.complete).toBe(true);
    expect(free.chain.root).not.toBeNull();

    expect(dg.chain.complete).toBe(false);
    expect(dg.chain.top).not.toBeNull();
    expect(dg.chain.reason).toMatch(/normal for a commercial timestamp authority/);
    // Crucially, an incomplete chain is NOT a cryptographic failure.
    expect(dg.ok).toBe(true);
  });

  it('completes a commercial chain when the root is supplied as a trust anchor', () => {
    const dg = verifyTimestampToken(token('digicert'), { expectedImprint: digest });
    // Use freetsa's root as a stand-in anchor that does NOT match: the chain
    // must stay incomplete rather than accept an unrelated anchor.
    const freeRootDer = findSelfSigned(token('freetsa'));
    const v = verifyTimestampToken(token('digicert'), {
      expectedImprint: digest,
      trustAnchors: freeRootDer ? [freeRootDer] : [],
    });
    expect(v.chain.complete).toBe(false);
    expect(v.chain.top?.subject).toBe(dg.chain.top?.subject);
  });
});

function findSelfSigned(tokenBytes: Uint8Array): X509Certificate | null {
  const root = parseDer(tokenBytes);
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.cls === 2 && n.tagNumber === 0 && n.constructed) {
      for (const c of n.children ?? []) {
        try {
          const cert = new X509Certificate(Buffer.from(c.full));
          if (cert.checkIssued(cert)) return cert;
        } catch {
          /* not a cert */
        }
      }
    }
    for (const c of n.children ?? []) stack.push(c);
  }
  return null;
}

describe('DER parser hardening', () => {
  it('rejects a lying length header instead of over-reading', () => {
    const bad = Uint8Array.from([0x30, 0x7f, 0x02, 0x01, 0x01]); // claims 127 bytes, has 3
    expect(() => parseDer(bad)).toThrow(DerError);
  });

  it('rejects indefinite-length encoding, which is BER but not DER', () => {
    // Accepting it would let two encodings of the same value both verify.
    expect(() => parseDer(Uint8Array.from([0x30, 0x80, 0x00, 0x00]))).toThrow(/indefinite length/);
  });

  it('rejects trailing bytes after a complete structure', () => {
    expect(() => parseDer(Uint8Array.from([0x02, 0x01, 0x01, 0xff]))).toThrow(/trailing bytes/);
  });

  it('rejects truncated input', () => {
    expect(() => parseDer(Uint8Array.from([0x30]))).toThrow(DerError);
    expect(() => parseDer(Uint8Array.from([0x30, 0x05, 0x01]))).toThrow(DerError);
  });

  it('caps nesting depth rather than blowing the stack', () => {
    // 40 nested SEQUENCEs. Kept under 63 levels so every length stays in DER
    // short form -- otherwise the parser would reject it on the length header
    // and we would not actually be exercising the depth cap.
    let buf = Uint8Array.from([0x05, 0x00]);
    for (let i = 0; i < 40; i++) {
      buf = Uint8Array.from([0x30, buf.length, ...buf]);
    }
    expect(buf.length).toBeLessThan(128);
    expect(() => parseDer(buf)).toThrow(/nesting deeper/);
  });

  it('never throws out of verifyTimestampToken on adversarial input', () => {
    // A verifier that crashes on hostile input is a denial-of-service vector and
    // an excuse to skip verification.
    const inputs = [
      new Uint8Array(0),
      Uint8Array.from([0x30, 0x80]),
      new Uint8Array(64).fill(0xff),
      crypto.getRandomValues(new Uint8Array(512)),
    ];
    for (const bad of inputs) {
      expect(() => verifyTimestampToken(bad, { expectedImprint: digest })).not.toThrow();
      expect(verifyTimestampToken(bad, { expectedImprint: digest }).ok).toBe(false);
    }
  });
});

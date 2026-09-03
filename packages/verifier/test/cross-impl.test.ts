import { describe, it, expect } from 'vitest';
import { canonicalize as verifierJcs } from '../src/jcs.js';
import { receiptHash as verifierHash, verifyReceiptSignature as verifierVerify } from '../src/receipt.js';

// The ONE place the verifier's test suite is allowed to reference core, and only
// to prove the two implementations agree. The runtime code in src/ never imports
// it -- scripts/check-boundaries.mjs fails the build if it ever does.
import { canonicalize as coreJcs } from '@provenant/core';
import {
  receiptHash as coreHash, signReceipt, generateKeypair, deriveAgentId,
} from '@provenant/core';

/**
 * THE ANTI-DRIFT GUARD.
 *
 * packages/verifier deliberately reimplements JCS canonicalization, receipt
 * hashing and signature verification rather than importing core's. A verifier
 * that shares those with the system it audits is not independent: a bug -- or a
 * deliberate backdoor -- in the shared code would be invisible to both sides,
 * and "verified" would mean only "self-consistent".
 *
 * The obvious risk of duplication is silent divergence: core changes, the
 * verifier does not, and bundles stop verifying (or worse, keep verifying when
 * they should not). This file makes that divergence a build failure.
 *
 * Independence is preserved because these are two genuinely separate code paths
 * that merely agree on their output.
 */
describe('verifier and core agree byte-for-byte', () => {
  const corpus: unknown[] = [
    null, true, false, 0, -0, 1, -1, 1.5, 1e30, 1e-27, 5e-324,
    '', 'plain', 'unicode €', 'astral \u{1f600}', 'quote " backslash \\ slash /',
    String.fromCharCode(0x0a) + String.fromCharCode(0x0f) + String.fromCharCode(0x1f),
    [], {}, [1, 2, 3], [[1], [2, [3]]],
    { a: 1, b: 2 },
    { b: 2, a: 1 },
    { z: 1, a: 2, m: 3, '': 4, '\u{1f600}': 5, '': 6 },
    { nested: { deep: { deeper: { value: [1, { x: null }] } } } },
    { 'key with spaces': 1, 'key\nwith\nnewlines': 2 },
    { mixed: [1, 'two', null, true, { three: 3 }] },
    { num: 333333333.33333329, exp: 1e21, neg: -1.7976931348623157e308 },
    // Shapes that look like real receipts.
    {
      record_id: 'a-b-c', timestamp: '2026-09-03T12:00:00.000Z',
      action_detail: { amount_usd: 42.5, nested: { list: [1, 2, 3] } },
      prev_hash: null, parent_record_id: null,
      provenant: { v: '1', seq: 0, side_effect_class: 'irreversible' },
    },
  ];

  for (const [i, value] of corpus.entries()) {
    it(`canonicalizes corpus[${i}] identically`, () => {
      expect(verifierJcs(value)).toBe(coreJcs(value));
    });
  }

  it('agrees across a large randomized corpus', () => {
    // Randomized structures catch orderings and shapes a hand-written corpus
    // would not think to include.
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const gen = (depth: number): unknown => {
      const r = rand();
      if (depth > 3 || r < 0.2) {
        if (r < 0.05) return null;
        if (r < 0.1) return rand() > 0.5;
        if (r < 0.15) return (rand() - 0.5) * 1e6;
        return String.fromCharCode(0x20 + Math.floor(rand() * 200)).repeat(1 + Math.floor(rand() * 4));
      }
      if (r < 0.5) return Array.from({ length: Math.floor(rand() * 5) }, () => gen(depth + 1));
      const obj: Record<string, unknown> = {};
      for (let k = 0; k < Math.floor(rand() * 6); k++) {
        obj[String.fromCharCode(0x20 + Math.floor(rand() * 300)) + k] = gen(depth + 1);
      }
      return obj;
    };

    for (let i = 0; i < 500; i++) {
      const v = gen(0);
      expect(verifierJcs(v), `divergence on random value ${i}: ${JSON.stringify(v)}`).toBe(coreJcs(v));
    }
  });

  it('computes identical receipt hashes', () => {
    const kp = generateKeypair();
    for (let i = 0; i < 25; i++) {
      const receipt = signReceipt(
        {
          record_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          timestamp: '2026-09-03T12:00:00.000Z',
          agent_id: deriveAgentId(kp.publicKey),
          agent_version: '1.0.0',
          session_id: '00000000-0000-4000-8000-000000000000',
          action_type: 'tool_call',
          action_detail: { i, nested: { list: [1, 2, 3], s: 'unicode €\u{1f600}' } },
          outcome: 'success',
          trust_level: 'L1',
          parent_record_id: null,
          prev_hash: i === 0 ? null : 'a'.repeat(64),
          provenant: {
            v: '1', action: 'refund.issue', side_effect_class: 'irreversible',
            seq: i, signature_alg: 'ed25519', key_id: kp.keyId,
          },
        },
        kp.secretKey,
      );

      expect(verifierHash(receipt as unknown as Record<string, unknown>)).toBe(coreHash(receipt));
      // And the verifier accepts a signature core produced.
      expect(verifierVerify(receipt as unknown as Record<string, unknown>, kp.publicKey)).toBe(true);
    }
  });

  it('both reject a tampered receipt identically', () => {
    const kp = generateKeypair();
    const receipt = signReceipt(
      {
        record_id: '00000000-0000-4000-8000-000000000001',
        timestamp: '2026-09-03T12:00:00.000Z',
        agent_id: deriveAgentId(kp.publicKey),
        agent_version: '1.0.0',
        session_id: '00000000-0000-4000-8000-000000000000',
        action_type: 'tool_call',
        action_detail: { amount_usd: 10 },
        outcome: 'success',
        trust_level: 'L1',
        parent_record_id: null,
        prev_hash: null,
        provenant: {
          v: '1', action: 'refund.issue', side_effect_class: 'irreversible',
          seq: 0, signature_alg: 'ed25519', key_id: kp.keyId,
        },
      },
      kp.secretKey,
    );

    const tampered = { ...receipt, action_detail: { amount_usd: 999999 } };
    expect(verifierVerify(tampered as unknown as Record<string, unknown>, kp.publicKey)).toBe(false);
    expect(verifierHash(tampered as unknown as Record<string, unknown>)).not.toBe(coreHash(receipt));
  });
});

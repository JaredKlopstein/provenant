import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  signReceipt,
  verifyReceiptSignature,
  receiptHash,
  canonicalReceiptJson,
  stripUndefined,
  signingPreimage,
} from '../src/receipt/hash.js';
import { Receipt, UnsignedReceipt } from '../src/receipt/schema.js';
import { generateKeypair, deriveAgentId } from '../src/crypto/keys.js';

function makeUnsigned(over: Partial<UnsignedReceipt> = {}): UnsignedReceipt {
  const kp = generateKeypair();
  return {
    record_id: randomUUID(),
    timestamp: '2026-09-03T12:00:00.000Z',
    agent_id: deriveAgentId(kp.publicKey),
    agent_version: '1.0.0',
    session_id: randomUUID(),
    action_type: 'tool_call',
    action_detail: { tool: 'refund.issue', amount_usd: 42 },
    outcome: 'success',
    trust_level: 'L1',
    parent_record_id: null,
    prev_hash: null,
    input_hash: 'a'.repeat(64),
    provenant: {
      v: '1',
      action: 'refund.issue',
      side_effect_class: 'irreversible',
      seq: 0,
      signature_alg: 'ed25519',
      key_id: kp.keyId,
    },
    ...over,
  };
}

describe('receipt schema', () => {
  it('accepts a well-formed receipt', () => {
    expect(() => UnsignedReceipt.parse(makeUnsigned())).not.toThrow();
  });

  it('rejects a timestamp without an explicit UTC offset', () => {
    // An audit record with an ambiguous timestamp is a defect, not a convenience.
    expect(() => UnsignedReceipt.parse(makeUnsigned({ timestamp: '2026-09-03T12:00:00' }))).toThrow();
  });

  it('rejects a non-hex prev_hash', () => {
    expect(() => UnsignedReceipt.parse(makeUnsigned({ prev_hash: 'nope' }))).toThrow();
  });

  it('requires prev_hash to be present, using null for genesis', () => {
    const r = makeUnsigned();
    delete (r as Record<string, unknown>).prev_hash;
    expect(() => UnsignedReceipt.parse(r)).toThrow();
  });
});

describe('stripUndefined -- the absent-vs-null invariant', () => {
  it('drops undefined keys but preserves null exactly', () => {
    expect(stripUndefined({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null });
  });

  it('recurses into nested objects and arrays', () => {
    expect(stripUndefined({ a: { b: undefined, c: 1 }, d: [{ e: undefined, f: 2 }] })).toEqual({
      a: { c: 1 },
      d: [{ f: 2 }],
    });
  });

  it('makes omitted and null hash DIFFERENTLY, as JSON requires', () => {
    // Documenting the hazard the invariant exists to prevent.
    const a = signingPreimage(makeUnsigned({ model_id: null }) as UnsignedReceipt);
    const b = signingPreimage(makeUnsigned({ model_id: undefined }) as UnsignedReceipt);
    expect(new TextDecoder().decode(a)).not.toBe(new TextDecoder().decode(b));
  });
});

describe('signing', () => {
  it('round-trips a signature', () => {
    const kp = generateKeypair();
    const receipt = signReceipt(makeUnsigned(), kp.secretKey);
    expect(Receipt.parse(receipt)).toBeTruthy();
    expect(verifyReceiptSignature(receipt, kp.publicKey)).toBe(true);
  });

  it('fails verification under a different key', () => {
    const kp = generateKeypair();
    const other = generateKeypair();
    const receipt = signReceipt(makeUnsigned(), kp.secretKey);
    expect(verifyReceiptSignature(receipt, other.publicKey)).toBe(false);
  });

  it('detects mutation of ANY signed field', () => {
    const kp = generateKeypair();
    const receipt = signReceipt(makeUnsigned(), kp.secretKey);

    const mutations: Array<[string, Receipt]> = [
      ['action_detail', { ...receipt, action_detail: { tool: 'refund.issue', amount_usd: 4200 } }],
      ['outcome', { ...receipt, outcome: 'failure' }],
      ['timestamp', { ...receipt, timestamp: '2020-01-01T00:00:00.000Z' }],
      ['agent_id', { ...receipt, agent_id: 'urn:provenant:agent:someone-else' }],
      ['trust_level', { ...receipt, trust_level: 'L4' }],
      ['input_hash', { ...receipt, input_hash: 'b'.repeat(64) }],
      ['prev_hash', { ...receipt, prev_hash: 'c'.repeat(64) }],
      [
        'provenant.side_effect_class',
        { ...receipt, provenant: { ...receipt.provenant, side_effect_class: 'read' } },
      ],
      ['provenant.seq', { ...receipt, provenant: { ...receipt.provenant, seq: 99 } }],
    ];

    for (const [field, mutated] of mutations) {
      expect(verifyReceiptSignature(mutated, kp.publicKey), `mutation of ${field} went undetected`).toBe(
        false,
      );
    }
  });

  it('does not throw on adversarial signature input', () => {
    // A verifier that crashes on malformed input is a denial-of-service vector
    // and, worse, an excuse to skip verification.
    const kp = generateKeypair();
    const receipt = signReceipt(makeUnsigned(), kp.secretKey);
    for (const bad of ['', '!!!!', 'AAAA', 'a'.repeat(200)]) {
      expect(() => verifyReceiptSignature({ ...receipt, signature: bad }, kp.publicKey)).not.toThrow();
      expect(verifyReceiptSignature({ ...receipt, signature: bad }, kp.publicKey)).toBe(false);
    }
  });
});

describe('receiptHash (the chain link)', () => {
  it('is stable regardless of key insertion order', () => {
    const kp = generateKeypair();
    const receipt = signReceipt(makeUnsigned(), kp.secretKey);
    const shuffled = Object.fromEntries(
      Object.entries(receipt).reverse(),
    ) as unknown as Receipt;
    expect(receiptHash(shuffled)).toBe(receiptHash(receipt));
  });

  it('covers the signature, so a resignature cannot be swapped in silently', () => {
    const kp = generateKeypair();
    const unsigned = makeUnsigned();
    const a = signReceipt(unsigned, kp.secretKey);
    const b: Receipt = { ...a, signature: 'A'.repeat(86) };
    expect(receiptHash(b)).not.toBe(receiptHash(a));
  });

  it('produces 64 lowercase hex characters', () => {
    const kp = generateKeypair();
    expect(receiptHash(signReceipt(makeUnsigned(), kp.secretKey))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('canonical JSON round-trips through JSON.parse to the same hash', () => {
    // Export/import fidelity: what we write to a bundle must verify after a
    // parse on the other side.
    const kp = generateKeypair();
    const receipt = signReceipt(makeUnsigned(), kp.secretKey);
    const json = canonicalReceiptJson(receipt);
    expect(receiptHash(JSON.parse(json))).toBe(receiptHash(receipt));
  });
});

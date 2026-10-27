import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ed from '@noble/ed25519';
import { verifyBundle, type BundleAnchor, type BundleReceipt } from '../src/bundle.js';
import { canonicalBytes } from '../src/jcs.js';
import { receiptHash } from '../src/receipt.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

function allSources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) allSources(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * "Can I run this on an air-gapped machine, without talking to you?" is the
 * first question a security reviewer asks about a verifier. The answer must
 * never quietly become no, so it is enforced three ways: statically here, by
 * scripts/check-boundaries.mjs in CI, and by the dependency allowlist.
 */
describe('the verifier is offline by construction', () => {
  it('imports no network module anywhere in its source', () => {
    const banned = ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram',
                    'axios', 'node-fetch', 'undici', 'got'];
    for (const file of allSources(SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const mod of banned) {
        expect(src, `${file} imports ${mod}`).not.toMatch(
          new RegExp(`from\\s+['"]${mod.replace('/', '\\/')}['"]`),
        );
      }
    }
  });

  it('never calls fetch, XMLHttpRequest or WebSocket', () => {
    for (const file of allSources(SRC)) {
      const src = readFileSync(file, 'utf8')
        // Strip comments so prose about networking does not trip the check.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(src, `${file} references fetch`).not.toMatch(/\bfetch\s*\(/);
      expect(src, `${file} references WebSocket`).not.toMatch(/\bWebSocket\b/);
      expect(src, `${file} references XMLHttpRequest`).not.toMatch(/\bXMLHttpRequest\b/);
    }
  });

  it('declares only the two permitted dependencies', () => {
    const pkg = JSON.parse(
      readFileSync(join(SRC, '../package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@noble/ed25519', '@noble/hashes']);
  });

  it('verifies a bundle with fetch removed from the runtime entirely', () => {
    // A blunt runtime proof: if any code path reached for the network, this
    // would throw rather than silently succeed.
    const saved = globalThis.fetch;
    // @ts-expect-error deliberately removing a global for the duration of the test
    delete globalThis.fetch;
    try {
      const verdict = verifyBundle({
        format: 'lacre-bundle-v1',
        chain_id: 'c1',
        generated_at: '2026-09-03T00:00:00.000Z',
        range: { from_seq: 0, to_seq: 0 },
        receipts: [],
        agents: {},
        anchors: [],
      });
      expect(verdict.ok).toBe(true);
      expect(verdict.anchored).toBe(false);
    } finally {
      globalThis.fetch = saved;
    }
  });
});

describe('bundle schema validation', () => {
  it('rejects a non-object', () => {
    expect(verifyBundle('nope').ok).toBe(false);
    expect(verifyBundle(null).failures[0]!.kind).toBe('BUNDLE_MALFORMED');
  });

  it('rejects an unknown format rather than guessing', () => {
    const v = verifyBundle({ format: 'something-else' });
    expect(v.ok).toBe(false);
    expect(v.failures[0]!.message).toMatch(/unknown bundle format/);
    expect(v.conclusion).toMatch(/unknown bundle format/);
  });

  it('rejects the previous bundle format as an unknown format', () => {
    const legacy = 'provenant-bundle-v1';
    const v = verifyBundle({ format: legacy, receipts: [], agents: {}, anchors: [] });
    expect(v.ok).toBe(false);
    expect(v.format).toBe(legacy);
    expect(v.failures[0]).toMatchObject({ kind: 'BUNDLE_MALFORMED' });
    expect(v.failures[0]!.message).toBe(`unknown bundle format '${legacy}'; this verifier reads 'lacre-bundle-v1'`);
    expect(v.conclusion).toBe('Nothing could be verified: unknown bundle format.');
  });

  it('rejects a structurally incomplete bundle', () => {
    const v = verifyBundle({ format: 'lacre-bundle-v1', receipts: [] });
    expect(v.ok).toBe(false);
    expect(v.failures[0]!.message).toMatch(/missing one of/);
  });

  it('never throws on adversarial input', () => {
    const inputs = [
      undefined, 0, [], { format: 'lacre-bundle-v1', receipts: 'no', agents: {}, anchors: [] },
      { format: 'lacre-bundle-v1', receipts: [{ seq: 'x', canonical_json: '{', self_hash: 1 }], agents: {}, anchors: [] },
      { format: 'lacre-bundle-v1', receipts: [], agents: {}, anchors: [{ nonsense: true }] },
    ];
    for (const bad of inputs) {
      expect(() => verifyBundle(bad)).not.toThrow();
      expect(verifyBundle(bad).ok).toBe(false);
    }
  });
});

/**
 * A small signed chain built here with the verifier's own primitives, so this
 * suite still never imports core. The key is a fixed, obviously fake seed.
 */
function signedChain(length: number): { receipts: BundleReceipt[]; agents: Record<string, unknown> } {
  const secret = new Uint8Array(32).fill(7);
  const x = Buffer.from(ed.getPublicKey(secret)).toString('base64url');
  const agentId = 'test-agent';
  const receipts: BundleReceipt[] = [];
  let prev: string | null = null;
  for (let seq = 0; seq < length; seq++) {
    const unsigned = {
      record_id: `test-record-${seq}`,
      agent_id: agentId,
      timestamp: `2026-09-03T00:00:0${seq}.000Z`,
      action: 'test.action',
      prev_hash: prev,
      lacre: { v: '1', seq },
    };
    const signature = Buffer.from(ed.sign(canonicalBytes(unsigned), secret)).toString('base64url');
    const full = { ...unsigned, signature };
    const selfHash = receiptHash(full);
    receipts.push({ seq, canonical_json: JSON.stringify(full), self_hash: selfHash });
    prev = selfHash;
  }
  return { receipts, agents: { [agentId]: { kty: 'OKP', crv: 'Ed25519', x } } };
}

function anchorAt(receipt: BundleReceipt, receiptCount: number): BundleAnchor {
  return {
    id: `test-anchor-${receipt.seq}`,
    statement: { v: '1', chain_id: 'c1', seq: receipt.seq, head_hash: receipt.self_hash, receipt_count: receiptCount },
    backend: 'noop',
    proof: { type: 'none' },
    created_at: '2026-09-03T00:01:00.000Z',
  };
}

function bundleOf(receipts: BundleReceipt[], agents: Record<string, unknown>, anchors: BundleAnchor[]) {
  return {
    format: 'lacre-bundle-v1',
    chain_id: 'c1',
    generated_at: '2026-09-03T00:02:00.000Z',
    range: { from_seq: receipts[0]!.seq, to_seq: receipts[receipts.length - 1]!.seq },
    receipts, agents, anchors,
  };
}

describe('anchor receipt_count', () => {
  const { receipts, agents } = signedChain(4);

  it('passes a full bundle whose anchor count matches its receipts', () => {
    const v = verifyBundle(bundleOf(receipts, agents, [anchorAt(receipts[2]!, 3), anchorAt(receipts[3]!, 4)]));
    expect(v.failures).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).not.toMatch(/receipt_count check skipped/);
  });

  for (const [label, claimed] of [['one too few', 2], ['one too many', 4]] as const) {
    it(`fails a full bundle whose anchor count is ${label}`, () => {
      const v = verifyBundle(bundleOf(receipts, agents, [anchorAt(receipts[2]!, claimed)]));
      expect(v.ok).toBe(false);
      expect(v.failures).toHaveLength(1);
      const f = v.failures[0]!;
      expect(f).toMatchObject({ seq: 2, kind: 'ANCHOR_COUNT_MISMATCH', expected: String(claimed), actual: '3' });
      expect(f.message).toContain(`commits to ${claimed} receipt(s)`);
      expect(f.message).toContain('holds 3 receipt(s)');
    });
  }

  it('skips the check on a partial bundle and says so', () => {
    const partial = receipts.slice(2);
    const v = verifyBundle(bundleOf(partial, agents, [anchorAt(receipts[3]!, 4)]));
    expect(v.failures).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/anchor at seq 3: receipt_count check skipped/);
  });
});

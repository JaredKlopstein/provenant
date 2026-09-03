import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundle } from '../src/bundle.js';

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
        format: 'provenant-bundle-v1',
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
    expect(v.failures[0]!.message).toMatch(/unsupported bundle format/);
  });

  it('rejects a structurally incomplete bundle', () => {
    const v = verifyBundle({ format: 'provenant-bundle-v1', receipts: [] });
    expect(v.ok).toBe(false);
    expect(v.failures[0]!.message).toMatch(/missing one of/);
  });

  it('never throws on adversarial input', () => {
    const inputs = [
      undefined, 0, [], { format: 'provenant-bundle-v1', receipts: 'no', agents: {}, anchors: [] },
      { format: 'provenant-bundle-v1', receipts: [{ seq: 'x', canonical_json: '{', self_hash: 1 }], agents: {}, anchors: [] },
      { format: 'provenant-bundle-v1', receipts: [], agents: {}, anchors: [{ nonsense: true }] },
    ];
    for (const bad of inputs) {
      expect(() => verifyBundle(bad)).not.toThrow();
      expect(verifyBundle(bad).ok).toBe(false);
    }
  });
});

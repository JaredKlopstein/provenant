import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EXHIBIT_DATA } from '../src/exhibit-data.js';
import {
  ALTERED_AMOUNT,
  ExhibitChain,
  computeChain,
  jcs,
  sha256hex,
  storedChain,
  verdictOf,
} from '../src/exhibit-chain.js';

/**
 * Site revamp 4/9 (component only): Exhibit A, the live tamper demo from the
 * Pages landing page. The hashing port has to be byte-exact, so the chain is
 * recomputed here with Node's WebCrypto, cross-checked with node:crypto, and the
 * data is held byte-identical to the landing page's DATA constant.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const nodeSha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const { anchor, receipts } = EXHIBIT_DATA;

describe('Exhibit A data', () => {
  it('is byte-identical to the DATA constant on the Pages landing page', () => {
    const pages = /^const DATA = (.*);$/m.exec(read('../../../docs/index.html'))?.[1];
    const ours = /^export const EXHIBIT_DATA: ExhibitData = (.*);$/m.exec(read('../src/exhibit-data.ts'))?.[1];
    expect(pages).toBeDefined();
    expect(ours).toBe(pages);
    expect(EXHIBIT_DATA).toEqual(JSON.parse(pages!));
  });

  it('is a real chain: each canonical string hashes to its self_hash and links to the one before', () => {
    let prev: string | null = null;
    for (const r of receipts) {
      expect(nodeSha256(r.canonical)).toBe(r.self_hash);
      expect(JSON.parse(r.canonical).prev_hash).toBe(prev);
      prev = r.self_hash;
    }
    expect(anchor.seq).toBe(receipts.length - 1);
    expect(prev).toBe(anchor.head);
  });

  it('canonicalizes each receipt back to exactly its stored bytes (RFC 8785 port)', () => {
    for (const r of receipts) expect(jcs(JSON.parse(r.canonical))).toBe(r.canonical);
  });

  it('hashes with WebCrypto exactly as node:crypto does', async () => {
    for (const s of ['', 'abc', receipts[0]!.canonical, '{"é":"✓"}']) expect(await sha256hex(s)).toBe(nodeSha256(s));
  });
});

describe('Exhibit A chain recompute', () => {
  it('intact: every link holds and the head equals the anchor', async () => {
    const rows = await computeChain('intact');
    expect(rows.map((r) => r.self)).toEqual(receipts.map((r) => r.self_hash));
    expect(rows.every((r) => r.linkOk)).toBe(true);
    expect(rows[rows.length - 1]!.self).toBe(anchor.head);
    expect(verdictOf(rows)).toBe('intact');
    expect(rows).toEqual(storedChain());
  });

  it('tampered: the altered refund breaks the link at seq 1', async () => {
    const rows = await computeChain('tampered');
    expect(rows[0]!.amount).toBe(ALTERED_AMOUNT);
    expect(rows[0]!.self).not.toBe(receipts[0]!.self_hash);
    expect(rows.map((r) => r.linkOk)).toEqual([true, false, true]);
    expect(verdictOf(rows)).toBe('tampered');
  });

  it('re-signed: every link holds again, but the head no longer equals the anchor', async () => {
    const rows = await computeChain('resigned');
    expect(rows.every((r) => r.linkOk)).toBe(true);
    expect(rows[rows.length - 1]!.self).not.toBe(anchor.head);
    expect(verdictOf(rows)).toBe('forged');
  });
});

describe('Exhibit A component', () => {
  const html = renderToStaticMarkup(createElement(ExhibitChain));
  const src = read('../src/exhibit-chain.tsx');
  const css = read('../src/exhibit-chain.module.css').replace(/\/\*[\s\S]*?\*\//g, '');

  it('server-renders the intact state: three receipts, the anchor row and the Intact verdict', () => {
    expect(html).toMatch(/^<section aria-labelledby="exhibit-title"/);
    expect(html).toContain('<h2 id="exhibit-title">Exhibit A: live chain</h2>');
    expect(html.match(/>SEQ \d</g)).toHaveLength(3);
    expect(html).toContain('>ANCHOR<');
    expect(html).toContain('>matches<');
    expect(html.match(/>linked</g)).toHaveLength(3);
    expect(html).not.toMatch(/>broken<|>mismatch</);
    expect(html).toContain('<strong>Intact</strong>');
    expect(html).toContain('$42.50');
  });

  it('announces the verdict politely', () => {
    expect(html).toMatch(/<div class="[^"]*" aria-live="polite"><strong>Intact<\/strong>/);
  });

  it('renders three native buttons, with only the ones that apply enabled', () => {
    const buttons = [...html.matchAll(/<button\b([^>]*)>([^<]+)<\/button>/g)].map((m) => ({
      label: m[2],
      type: /type="button"/.test(m[1]!),
      disabled: /\bdisabled=""/.test(m[1]!),
    }));
    expect(buttons).toEqual([
      { label: 'Alter the refund to $99,999', type: true, disabled: false },
      { label: 'Re-sign the chain like the operator would', type: true, disabled: true },
      { label: 'Reset', type: true, disabled: true },
    ]);
  });

  it('shows hashes shortened, with the full value as a tooltip and as screen-reader text', () => {
    for (const r of receipts) {
      expect(html).toContain(`title="${r.self_hash}"`);
      expect(html).toContain(`>${r.self_hash}</span>`);
      expect(html).toContain(`<span aria-hidden="true">${r.self_hash.slice(0, 12)}…</span>`);
    }
    expect(html).toContain(`title="${anchor.head}"`);
  });

  it('cannot overflow sideways: no <pre>, no nowrap rows, wrapping allowed everywhere', () => {
    expect(html).not.toMatch(/<pre[ >]/);
    expect(css).toMatch(/\.exhibit \{[^}]*overflow-wrap: anywhere;/);
    expect(css).not.toMatch(/overflow-x: (auto|scroll)/);
    // Only the visually-hidden helper may use nowrap.
    expect(css.match(/white-space: nowrap/g)).toHaveLength(1);
    expect(css).toMatch(/\.srOnly \{[^}]*white-space: nowrap;/);
  });

  it('animates only under prefers-reduced-motion: no-preference', () => {
    const motion = /@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(motion).toContain('animation: flash');
    expect(motion).toContain('animation: pulse');
    expect(css.replace(motion, '').match(/animation:/g)).toBeNull();
  });

  it('hides the controls without JavaScript, leaving the intact chain readable', () => {
    expect(css).toMatch(/@media \(scripting: none\) \{\s*\.controls \{\s*display: none;/);
  });

  it('is a client component that imports nothing from core, verifier or cloud', () => {
    expect(src).toMatch(/^'use client';\n/);
    const specifiers = [...src.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]);
    expect(specifiers).toEqual(['react', './exhibit-data', './exhibit-chain.module.css']);
    expect(read('../src/exhibit-data.ts')).not.toMatch(/\bimport\b/);
  });
});

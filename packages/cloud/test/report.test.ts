import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bundle } from '@provenant/verifier';
import { bundleToHtml } from '../src/bundle/html.js';

const SAMPLE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../examples/sample-evidence/evidence.json',
);
const bundle = JSON.parse(readFileSync(SAMPLE, 'utf8')) as Bundle;

describe('HTML evidence report', () => {
  const html = bundleToHtml(bundle, { title: 'Q3 Agent Activity', organization: 'Acme Corp' });

  it('renders the verdict and the attesting authority', () => {
    expect(html).toContain('DigiCert');
    expect(html).toContain('Q3 Agent Activity');
  });

  it('does NOT claim settled proof when the authority is untrusted', () => {
    // The sample carries a real DigiCert token but no trust list. Calling that
    // "externally anchored" in the headline while the anchor row says "not in
    // your trust list" would contradict itself on the same page -- and would be
    // the exact overclaim the product exists to avoid.
    expect(html).toContain('Verified — anchored by an unverified authority');
    expect(html).not.toContain('Verified — externally anchored');
    expect(html).toContain('not in your trust list');
    expect(html).toContain('It does not yet establish that the history is unaltered');
  });

  it('claims proof only once the authority is actually trusted', () => {
    const DIGICERT_ROOT_FP =
      '33846b545a49c9be4903c60e01713c1bd4e4ef31ea65cd95d69e62794f30b941';
    const trusted = bundleToHtml(bundle, { trustedFingerprints: [DIGICERT_ROOT_FP] });
    expect(trusted).toContain('Verified — externally anchored');
    expect(trusted).toContain('a timestamp authority you have told this tool to trust');
    expect(trusted).toContain('authority trusted');
  });

  it('states that the page is not the evidence', () => {
    // The framing is the product's integrity, not decoration. If this line ever
    // disappears we are selling a pretty page people mistake for proof.
    expect(html).toContain('This page is a summary, not the evidence');
    expect(html).toContain('carries no cryptography');
  });

  it('keeps the compliance disclaimer', () => {
    expect(html).toContain('not make anyone compliant');
    expect(html).toContain('not legal advice');
  });

  it('tells the reader how to check it without trusting the operator', () => {
    expect(html).toContain('npx @provenant/verifier');
    expect(html).toContain('without trusting whoever operates this');
  });

  it('reports trust separately from validity', () => {
    // The sample is anchored by a real authority but carries no trust list.
    expect(html).toContain('In your trust list');
    expect(html).toContain('NO — confirm independently');
  });

  it('is fully self-contained: no external resource of any kind', () => {
    // An evidence report that phones out to a CDN cannot be opened in the
    // air-gapped room where audits actually happen.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\/[^"'\s)]+\.(js|css|woff2?|png|jpg|svg)/i);
    expect(html).not.toMatch(/<link[^>]+rel=["']stylesheet/i);
    expect(html).not.toMatch(/@import/);
  });

  it('escapes attacker-controlled receipt content', () => {
    // Agents choose their own action names, and a hosted verifier page renders
    // bundles uploaded by strangers. Both are untrusted input.
    const hostile: Bundle = {
      ...bundle,
      chain_id: '<img src=x onerror=alert(1)>',
      summary: { ...(bundle.summary as object), by_action: { '<script>alert(1)</script>': 1 } },
    };
    const out = bundleToHtml(hostile);
    expect(out).not.toContain('<img src=x');
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('warns loudly when a bundle is not anchored', () => {
    const unanchored = bundleToHtml({ ...bundle, anchors: [] });
    expect(unanchored).toContain('Verified — not anchored');
    expect(unanchored).toContain('could have rebuilt');
    expect(unanchored).toContain('does NOT establish that the history is unaltered');
  });

  it('renders a failure report when the bundle is broken', () => {
    const broken: Bundle = {
      ...bundle,
      receipts: bundle.receipts.map((r, i) =>
        i === 1 ? { ...r, canonical_json: r.canonical_json.replace(/"amount_usd":\d+/, '"amount_usd":999999') } : r,
      ),
    };
    const out = bundleToHtml(broken);
    expect(out).toContain('Verification failed');
    expect(out).toContain('HASH_MISMATCH');
    expect(out).toContain('Still provably intact');
  });
});

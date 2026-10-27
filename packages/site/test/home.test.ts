import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { metadata as layoutMetadata } from '../app/layout.js';
import HomePage, { metadata } from '../app/page.js';
import SecurityPage from '../app/security/page.js';
import { BRAND } from '../src/brand.js';
import { GETTING_STARTED_URL } from '../src/plans.js';
import { PROOF_TABLE } from '../src/proof-table.js';

const html = renderToStaticMarkup(HomePage());

const unescape = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The visible text of the page, with tags stripped. */
const text = unescape(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

const hero = /<section><h1>[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';

/** Each table body row as [property, local, anchored]. */
const tableRows = (page: string) =>
  [...(/<tbody>([\s\S]*?)<\/tbody>/.exec(page)?.[1] ?? '').matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
    [...row!.matchAll(/<t[hd][^>]*>([^<]*)<\/t[hd]>/g)].map(([, cell]) => unescape(cell!)),
  );

describe('home page', () => {
  it('labels the getting-started link as leaving the site for GitHub', () => {
    expect(html).toContain(
      `<a href="${BRAND.repository}/blob/main/docs/getting-started.md">Getting started (GitHub)</a>`,
    );
  });

  it('leads with an outcome-led H1 and sub-line in sentence case', () => {
    expect(hero).toContain('<h1>Prove what your AI agents did.</h1>');
    expect(unescape(hero)).toContain(
      '<p>Every consequential action gets a signed, hash-chained receipt, timestamped by an authority you don’t control. Anyone can verify the record offline, without trusting you.</p>',
    );
  });

  it('keeps the standards out of the hero and in the proof points below it', () => {
    for (const standard of ['RFC 8785', 'SHA-256', 'Ed25519', 'RFC 3161']) {
      expect(hero).not.toContain(standard);
      const proofPoints = /<section aria-label="Proof points">[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
      expect(proofPoints).toContain(standard);
    }
  });

  it('says "AI agents", never "autonomous agents"', () => {
    expect(text).toContain('AI agents');
    expect(text).not.toMatch(/autonomous/i);
  });

  it('shows exactly one static example receipt, labelled as an example', () => {
    const section = /<section aria-label="Example receipt">[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(section).toContain('<h2>Example receipt</h2>');
    expect(section).toMatch(/illustrative example, not a real receipt/);
    expect(section).toContain('Example only.');
    expect(html.match(/<pre[ >]/g)).toHaveLength(1);
    const code = unescape(/<code>([\s\S]*?)<\/code>/.exec(section)?.[1] ?? '');
    expect(code).toContain('"action_type": "tool_call"');
    expect(code).toContain('"signature_alg": "ed25519"');
    // Placeholders, not real hashes or signatures: nothing in it could verify.
    expect(code).not.toMatch(/[0-9a-f]{64}/);
  });

  it('hard-codes the example: nothing generates, signs or fetches it', () => {
    const src = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bfetch\(|\bawait\b|@lacre\/|packages\/core|\bsign\(/);
  });

  it('renders the limits table from the shared PROOF_TABLE under its own heading', () => {
    expect(html).toContain('<h2>An audit trail your agents can’t rewrite, and neither can you.</h2>');
    expect(tableRows(html)).toEqual(PROOF_TABLE.map((r) => [r.property, r.local, r.anchored]));
  });

  it('shares PROOF_TABLE with the security page, which renders the same rows unchanged', () => {
    expect(tableRows(renderToStaticMarkup(SecurityPage()))).toEqual(tableRows(html));
    expect(PROOF_TABLE.map((r) => [r.property, r.local, r.anchored])).toEqual([
      ['Detects casual tampering', 'yes', 'yes'],
      ['Detects a full rebuild by the operator', 'no', 'yes'],
      ['Detects backdating after the anchor', 'no', 'yes'],
      ['Detects truncation of the un-anchored tail', 'no', 'no'],
    ]);
    for (const page of ['../app/page.tsx', '../app/security/page.tsx']) {
      const src = readFileSync(new URL(page, import.meta.url), 'utf8');
      expect(src).toMatch(/import \{ PROOF_TABLE \} from '[./]+src\/proof-table'/);
      expect(src).not.toMatch(/const PROOF_TABLE\b/);
    }
  });

  it('exports its own meta description, leaving the layout’s unchanged', () => {
    expect(metadata.description).toContain('tamper-evident receipts for AI agents');
    expect(layoutMetadata.description).toBe(`${BRAND.name}: ${BRAND.tagline}.`);
  });

  it('keeps the two hero buttons from #94 with the same labels and links', () => {
    const links = [...hero.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(([, href, label]) => ({ label, href }));
    expect(links).toEqual([
      { label: 'Start free', href: GETTING_STARTED_URL },
      { label: 'See pricing', href: '/pricing' },
    ]);
  });
});

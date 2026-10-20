import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { BRAND } from '../packages/site/src/brand.js';
import HomePage from '../packages/site/app/page.js';

/**
 * The Next.js site in packages/site. Copy and metadata read from BRAND so the
 * rename is a one-line change, and the pages make no claim the product cannot
 * back: nothing on npm to install yet, and no compliance certifications.
 */

const APP = new URL('../packages/site/app/', import.meta.url).pathname;
const SUB_HEADLINE =
  'Signed, hash-chained receipts for every consequential agent action, anchored to a public timestamp authority, verifiable offline by anyone.';

// react-dom is a dependency of the site, not of the workspace root.
const siteRequire = createRequire(new URL('../packages/site/package.json', import.meta.url));
const { renderToStaticMarkup } = siteRequire('react-dom/server') as typeof import('react-dom/server');

const sources = readdirSync(APP, { recursive: true, encoding: 'utf8' })
  .filter((f) => /\.(tsx?|jsx?|mdx?)$/.test(f))
  .map((f) => ({ file: f, src: readFileSync(join(APP, f), 'utf8') }));

const home = renderToStaticMarkup(HomePage());
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('site app folder', () => {
  it('has the layout and the home page', () => {
    expect(sources.map((s) => s.file).sort()).toEqual(['layout.tsx', 'page.tsx']);
  });

  it('never hard-codes the brand name or repository', () => {
    for (const { file, src } of sources) {
      expect(src, file).not.toMatch(new RegExp(BRAND.name, 'i'));
      expect(src, file).not.toContain('github.com');
    }
  });

  it('takes layout metadata from BRAND', async () => {
    const { metadata } = await import('../packages/site/app/layout.js');
    expect(metadata.title).toBe(`${BRAND.name}: ${BRAND.tagline}`);
    expect(metadata.description).toContain(BRAND.tagline);
  });

  it('has the six nav entries and a footer', () => {
    const layout = sources.find((s) => s.file === 'layout.tsx')!.src;
    for (const label of ['Home', 'Pricing', 'How it works', 'Verify', 'Security', 'Enterprise']) {
      expect(layout).toContain(`label: '${label}'`);
    }
    expect(layout).toContain('<footer>');
  });

  it('imports nothing from core, verifier or cloud', () => {
    for (const { file, src } of sources) {
      expect(src, file).not.toMatch(/@provenant\/(core|verifier|cloud)|packages\/(core|verifier|cloud)/);
    }
  });
});

describe('home page', () => {
  it('leads with the tagline and the sub-headline', () => {
    expect(home).toContain(`<h1>${BRAND.tagline}</h1>`);
    expect(text(home)).toContain(SUB_HEADLINE);
  });

  it('shows the three proof points', () => {
    const body = text(home);
    expect(home.match(/<h2>/g)).toHaveLength(3);
    for (const term of ['RFC 8785', 'SHA-256', 'Ed25519', 'RFC 3161', 'offline verifier']) {
      expect(body).toContain(term);
    }
  });

  it('links to GitHub and the getting-started guide', () => {
    expect(home).toContain(`href="${BRAND.repository}"`);
    expect(home).toContain(`href="${BRAND.repository}/blob/main/docs/getting-started.md"`);
  });
});

describe('site claims', () => {
  const all = [home, ...sources.map((s) => s.src)].join('\n');

  it('does not tell readers to install or npx a package', () => {
    expect(all).not.toMatch(/\bnpm\s+(i|install)\b|\bnpx\b|\bpnpm\s+add\b|\byarn\s+add\b/i);
  });

  it('makes no SOC 2 or standards-compliance claims', () => {
    expect(all).not.toMatch(/SOC\s*2|complian|certified|conform/i);
  });
});

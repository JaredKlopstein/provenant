import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { BRAND } from '../packages/site/src/brand.js';
import HomePage from '../packages/site/app/page.js';
import HowItWorksPage from '../packages/site/app/how-it-works/page.js';
import VerifyPage from '../packages/site/app/verify/page.js';
import SecurityPage from '../packages/site/app/security/page.js';

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
const howItWorks = renderToStaticMarkup(HowItWorksPage());
const verify = renderToStaticMarkup(VerifyPage());
const security = renderToStaticMarkup(SecurityPage());
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const unescape = (html: string) =>
  html
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

describe('site app folder', () => {
  it('has the layout, the home, pricing, how-it-works, verify, security, enterprise and signup pages, and the contact and auth routes', () => {
    expect(sources.map((s) => s.file).sort()).toEqual([
      'api/auth/callback/route.ts',
      'api/auth/magic-link/route.ts',
      'api/contact/route.ts',
      'enterprise/page.tsx',
      'how-it-works/page.tsx',
      'layout.tsx',
      'page.tsx',
      'pricing/page.tsx',
      'security/page.tsx',
      'signup/page.tsx',
      'verify/page.tsx',
    ]);
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

  it('links the how-it-works, verify and security pages from the nav', () => {
    const layout = sources.find((s) => s.file === 'layout.tsx')!.src;
    for (const href of ['/how-it-works', '/verify', '/security']) {
      expect(layout).toContain(`href: '${href}'`);
    }
  });

  it('imports nothing from core, verifier or cloud', () => {
    // Import specifiers only: the verify page shows repository paths inside its commands.
    for (const { file, src } of sources) {
      const specifiers = [...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map(
        (m) => m[1] ?? m[2],
      );
      expect(specifiers.length, file).toBeGreaterThan(0);
      for (const spec of specifiers) {
        expect(spec, file).not.toMatch(/@provenant\/(core|verifier|cloud)|packages\/(core|verifier|cloud)/);
      }
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

describe('how-it-works page', () => {
  const body = text(unescape(howItWorks));

  it('walks record, hash chain, anchor, evidence bundle and offline verify in order', () => {
    const headings = [...howItWorks.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);
    expect(headings.slice(0, 5)).toEqual([
      '1. Record',
      '2. Hash chain',
      '3. Anchor',
      '4. Evidence bundle',
      '5. Verify offline',
    ]);
  });

  it('states the anchoring cadence the Cloud scheduler enforces', () => {
    expect(body).toContain('anchored at most every 15 minutes');
    expect(body).toContain('RFC 3161');
  });

  it('links to the verify and security pages', () => {
    expect(howItWorks).toContain('href="/verify"');
    expect(howItWorks).toContain('href="/security"');
  });
});

describe('verify page', () => {
  const body = text(unescape(verify));
  const guide = readFileSync(new URL('../docs/getting-started.md', import.meta.url), 'utf8');
  const guideBlocks = [...guide.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
  const pageBlocks = [...verify.matchAll(/<pre><code>([^<]*)<\/code><\/pre>/g)].map((m) => unescape(m[1]!));

  it('says the verifier is free, MIT and never paywalled', () => {
    expect(body).toContain('Verifying is never paywalled');
    expect(body).toContain('MIT');
    expect(body).toContain('no network');
  });

  it('shows the from-source commands exactly as the getting-started guide has them', () => {
    const clone = guideBlocks.filter((b) => b.startsWith('git clone '));
    const verifier = guideBlocks.filter((b) => b.startsWith('node packages/verifier/'));
    expect(clone).toHaveLength(1);
    expect(verifier).toHaveLength(2);
    expect(pageBlocks).toEqual([...clone, ...verifier]);
  });

  it('links the getting-started guide', () => {
    expect(verify).toContain(`href="${BRAND.repository}/blob/main/docs/getting-started.md"`);
  });
});

describe('security page', () => {
  const body = text(unescape(security));

  it('names each standard the code implements', () => {
    const headings = [...security.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
    expect(headings).toEqual(['RFC 8785', 'SHA-256', 'Ed25519', 'RFC 9421', 'RFC 3161']);
  });

  it('does not present HTTP receipt submission as working', () => {
    expect(body).toContain('Receipt submission over HTTP is not built yet');
  });

  it('covers the open-core boundary and the limits of a self-hosted chain', () => {
    expect(body).toContain('The verifier imports neither Core nor Cloud');
    expect(body).toContain('A self-hosted chain is self-attested');
    expect(body).toContain('Detects truncation of the un-anchored tail no no');
  });
});

describe('site claims', () => {
  const all = [home, howItWorks, verify, security, ...sources.map((s) => s.src)].join('\n');

  it('does not tell readers to install or npx a package', () => {
    expect(all).not.toMatch(/\bnpm\s+(i|install)\b|\bnpx\b|\bpnpm\s+add\b|\byarn\s+add\b/i);
  });

  it('makes no SOC 2 or standards-compliance claims', () => {
    expect(all).not.toMatch(/SOC\s*2|complian|certified|conform/i);
  });
});

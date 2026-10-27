import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import RootLayout from '../app/layout.js';
import { BRAND } from '../src/brand.js';
import { LEGAL } from '../src/legal.js';
import { EARLY_ACCESS_LABEL, OFF_SALE_PLANS } from '../src/plans.js';

/**
 * Site revamp 2b: the four-column footer. It keeps #96's legal nav exactly as
 * shipped, takes every name and URL from BRAND, plans.ts and the legal module,
 * and leaves room for #113's entity and contact line without inventing one.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = renderToStaticMarkup(RootLayout({ children: null }));
const footer = /<footer>([\s\S]*?)<\/footer>/.exec(html)?.[1] ?? '';
const text = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

/** True if a site path is a route in app/, or the link points into the repository. */
function resolves(href: string): boolean {
  if (href === BRAND.repository || href.startsWith(`${BRAND.repository}/`)) return true;
  if (href.startsWith('mailto:')) return true;
  if (!href.startsWith('/')) return false;
  const route = href.split(/[?#]/)[0]!.replace(/^\/|\/$/g, '');
  return existsSync(new URL(`../app/${route ? `${route}/` : ''}page.tsx`, import.meta.url));
}

describe('site footer', () => {
  it('renders inside the layout footer', () => {
    expect(footer).not.toBe('');
  });

  it('has the four column headings, in order', () => {
    expect([...footer.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1])).toEqual([
      'Product',
      'Developers',
      'Project',
      'Status',
    ]);
  });

  it('links every page it names, and every href resolves to a route or the repository', () => {
    const links = [...footer.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => ({ href: m[1]!, label: m[2]! }));
    expect(links.map((l) => l.label)).toEqual([
      'How it works',
      'Pricing',
      'Security',
      'Enterprise',
      'Getting started (GitHub)',
      'Verify a bundle',
      'Source on GitHub',
      'Terms',
      'Privacy',
      'Contact',
    ]);
    for (const link of links) expect(resolves(link.href), link.href).toBe(true);
  });

  it('keeps the #96 legal nav exactly as it shipped', () => {
    const contact = LEGAL.contactEmail
      ? `<a href="mailto:${LEGAL.contactEmail}">Contact</a>`
      : '<a href="/enterprise">Contact</a>';
    expect(footer).toContain(
      `<nav aria-label="Legal"><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · ${contact}</nav>`,
    );
    expect(html.match(/<nav aria-label="Legal">/g)).toHaveLength(1);
  });

  it('ends with the name, tagline and disclaimer, and no invented entity or address', () => {
    expect(text(footer)).toContain(`${BRAND.name} · ${BRAND.tagline} · Not legal advice.`);
    expect(read('../src/site-footer.tsx')).toContain('#113');
    expect(footer).not.toMatch(/LLC|Inc\.|Ltd|©/);
  });

  it('describes Cloud as early access while it is off sale, and claims nothing else', () => {
    const body = text(footer);
    expect(body).toContain('Core and verifier: run from source.');
    if (OFF_SALE_PLANS.has('cloud')) expect(body).toContain(`Cloud: ${EARLY_ACCESS_LABEL.toLowerCase()}.`);
    expect(body).not.toMatch(/autonomous|compliant|certified|trusted by/i);
  });

  it('hard-codes no product name or domain, and its stylesheet loads nothing', () => {
    const src = read('../src/site-footer.tsx');
    expect(src).not.toMatch(new RegExp(BRAND.name, 'i'));
    expect(src).not.toMatch(/github\.com|https?:\/\//);
    expect(read('../src/site-footer.module.css')).not.toMatch(/@import|url\(/);
  });
});

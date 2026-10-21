import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import RootLayout from '../app/layout.js';
import PricingPage from '../app/pricing/page.js';
import { NAV_LIST_ID } from '../src/nav-menu.js';

/**
 * The global stylesheet. Pages carry no class names, so app/globals.css targets
 * the elements and aria-labels they render; these tests pin both sides of that
 * contract, plus the header markup the collapsing nav relies on.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = read('../app/globals.css');
const layoutSrc = read('../app/layout.tsx');
// Comments out, whitespace collapsed, so rules can be matched as written.
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function block(selector: string, within = rules): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new RegExp(`(?:^|[}{;]) ?${escaped} \\{([^}]*)\\}`).exec(within)?.[1];
  expect(found, selector).toBeDefined();
  return found!;
}

/** The body of the first @media block with this query. */
function media(query: string): string {
  const start = rules.indexOf(`@media ${query} {`);
  expect(start, query).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = rules.indexOf('{', start); i < rules.length; i++) {
    if (rules[i] === '{') depth++;
    if (rules[i] === '}' && --depth === 0) return rules.slice(rules.indexOf('{', start) + 1, i);
  }
  throw new Error(`unclosed ${query}`);
}

describe('global stylesheet', () => {
  it('is loaded by the root layout, so every page gets it', () => {
    expect(layoutSrc).toMatch(/^import '\.\/globals\.css';$/m);
  });

  it('adds no runtime CSS dependency', () => {
    const pkg = JSON.parse(read('../package.json')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@neondatabase/serverless',
      '@provenant/cloud',
      'drizzle-orm',
      'next',
      'react',
      'react-dom',
    ]);
    expect(css).not.toMatch(/@import|url\(/);
  });

  it('defines sans-serif and monospace font tokens and uses them', () => {
    expect(block(':root')).toMatch(/--font-sans: [^;]*sans-serif;/);
    expect(block(':root')).toMatch(/--font-mono: [^;]*monospace;/);
    expect(block('body')).toContain('font-family: var(--font-sans)');
    expect(block('code, pre')).toContain('font-family: var(--font-mono)');
  });

  it('holds body text to a 68ch column', () => {
    expect(block(':root')).toContain('--measure: 68ch');
    expect(block('main > *')).toContain('max-width: var(--measure)');
  });

  it('scrolls command blocks inside their own box', () => {
    const pre = block('pre');
    expect(pre).toContain('overflow-x: auto');
    expect(pre).toContain('max-width: 100%');
    expect(pre).toMatch(/padding: /);
    expect(block('body')).toContain('overflow-wrap: break-word');
  });

  it('styles buttons and form fields', () => {
    expect(block("button, input[type='submit']")).toContain('background: var(--color-accent)');
    expect(
      block("input:not([type='hidden']):not([type='submit']):not([type='checkbox']):not([type='radio']), select, textarea"),
    ).toContain('width: 100%');
  });

  it('has a clearly visible focus-visible style', () => {
    expect(block(':focus-visible')).toMatch(/outline: 3px solid /);
  });

  it('collapses the nav behind the menu button under 640px, only once the script is ready', () => {
    expect(block('.nav-toggle')).toContain('display: none');
    expect(block('.site-nav ul')).toContain('display: flex');
    const narrow = media('(max-width: 640px)');
    expect(block('.site-nav[data-ready] .nav-toggle', narrow)).toContain('display: inline-flex');
    expect(block('.site-nav[data-ready] ul', narrow)).toContain('display: none');
    expect(block('.site-nav[data-ready][data-open] ul', narrow)).toContain('display: flex');
  });

  it('lays out pricing as a card grid that stacks when narrow, with Cloud emphasised', async () => {
    const grid = block("main > section[aria-label='Plans']");
    expect(grid).toContain('display: grid');
    expect(grid).toContain('grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr))');
    expect(grid).toContain('max-width: none');
    expect(block("section[aria-label='Plans'] > article[data-tier='cloud']")).toMatch(/border: 2px solid/);

    // The selectors above have to match what the pricing page renders.
    const html = renderToStaticMarkup(await PricingPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('<section aria-label="Plans"><article data-tier="core">');
    expect(html).toContain('<article data-tier="cloud">');
    expect(html).toContain('<nav aria-label="Billing period">');
  });

  it('leaves dark mode for later', () => {
    expect(block(':root')).toContain('color-scheme: light');
    expect(rules).not.toContain('prefers-color-scheme');
  });
});

describe('site header', () => {
  const html = renderToStaticMarkup(RootLayout({ children: null }));

  it('renders the six nav links next to a menu button that controls them', () => {
    const nav = /<nav aria-label="Main"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';
    const button = /<button\b[^>]*>Menu<\/button>/.exec(nav)?.[0] ?? '';
    expect(button).toContain('type="button"');
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain(`aria-controls="${NAV_LIST_ID}"`);
    expect(nav).toContain(`<ul id="${NAV_LIST_ID}">`);
    expect([...nav.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1])).toEqual([
      '/',
      '/pricing',
      '/how-it-works',
      '/verify',
      '/security',
      '/enterprise',
    ]);
  });

  it('renders the nav uncollapsed before hydration, so it works without JavaScript', () => {
    const nav = /<nav aria-label="Main"[^>]*>/.exec(html)?.[0] ?? '';
    expect(nav).toContain('class="site-nav"');
    expect(nav).not.toContain('data-ready');
    expect(nav).not.toContain('data-open');
  });

  it('marks the nav client component as a client component', () => {
    expect(read('../src/nav-menu.tsx')).toMatch(/^'use client';\n/);
  });
});

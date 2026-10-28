import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import RootLayout from '../app/layout.js';
import PricingPage from '../app/pricing/page.js';
import HowItWorksPage from '../app/how-it-works/page.js';
import { NAV_LIST_ID, navKeyAction } from '../src/nav-menu.js';
import { SIGNUP_PATH } from '../src/auth/email.js';
import { isDue } from '../src/reveal.js';
import { BRAND } from '../src/brand.js';
import { GETTING_STARTED_URL } from '../src/plans.js';

/**
 * The global stylesheet. Pages carry no class names, so app/globals.css targets
 * the elements and aria-labels they render; these tests pin both sides of that
 * contract, plus the header markup the collapsing nav relies on.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = read('../app/globals.css');
const layoutSrc = read('../app/layout.tsx');
const fontsSrc = read('../src/fonts.ts');
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
      '@lacre/cloud',
      '@neondatabase/serverless',
      'drizzle-orm',
      'next',
      'react',
      'react-dom',
    ]);
    expect(css).not.toMatch(/@import|url\(/);
  });

  it('defines sans-serif and monospace font tokens and uses them', () => {
    expect(block(':root')).toMatch(/--font-sans: var\(--font-plex-sans\),[^;]*sans-serif;/);
    expect(block(':root')).toMatch(/--font-mono: var\(--font-plex-mono\),[^;]*monospace;/);
    expect(block('body')).toContain('font-family: var(--font-sans)');
    expect(block('code, pre')).toContain('font-family: var(--font-mono)');
  });

  it('sets headings in Plex Serif, with a serif fallback', () => {
    expect(block(':root')).toMatch(/--font-serif: var\(--font-plex-serif\),[^;]*serif;/);
    expect(block('h1, h2, h3')).toContain('font-family: var(--font-serif)');
  });

  it('loads Plex through Next\'s font loader in src/fonts.ts and applies it to <html>', () => {
    expect(fontsSrc).toMatch(/from 'next\/font\/google'/);
    for (const name of ['--font-plex-serif', '--font-plex-sans', '--font-plex-mono']) {
      expect(fontsSrc).toContain(`variable: '${name}'`);
    }
    expect(layoutSrc).toContain("import { FONT_VARIABLES } from '../src/fonts';");
    expect(layoutSrc).toContain('<html lang="en" className={FONT_VARIABLES}>');
  });

  it('holds body text to a 68ch column', () => {
    expect(block(':root')).toContain('--measure: 68ch');
    expect(block('main > *')).toContain('max-width: var(--measure)');
  });

  it('wraps command blocks inside their own box, scrolling as the fallback', () => {
    const pre = block('pre');
    expect(pre).toContain('white-space: pre-wrap');
    expect(pre).toContain('overflow-wrap: anywhere');
    expect(block('pre code')).not.toContain('overflow-wrap: normal');
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

  it('gives form fields and the menu button a 3:1 boundary, never --rule', () => {
    expect(block(':root')).toContain('--field-border: #7a7a72');
    const fields = block(
      "input:not([type='hidden']):not([type='submit']):not([type='checkbox']):not([type='radio']), select, textarea",
    );
    expect(fields).toContain('border: 1px solid var(--field-border)');
    expect(block('.nav-toggle')).toContain('border-color: var(--field-border)');
    expect(block('.nav-toggle:hover')).toContain('border-color: var(--field-border)');
    for (const control of [fields, block('.nav-toggle'), block("button, input[type='submit']")]) {
      expect(control).not.toMatch(/var\(--(rule|color-border)\)/);
    }
  });

  it('defines the paper and ink palette, the band utilities and the wide grid', () => {
    const root = block(':root');
    for (const token of [
      '--ink: #141a22', '--ink-2: #2c3542', '--paper: #e8e8e4', '--card: #f6f6f3', '--rule: #ccccc4',
      '--seal-red: #a3201b', '--seal-green: #2c6449', '--plate: #171d26', '--plate-ink: #d8dbe0',
      '--wide-grid: 76rem',
    ]) {
      expect(root).toContain(token);
    }
    expect(block('.eyebrow')).toContain('letter-spacing: 0.12em');
    expect(block('.eyebrow')).toContain('font-family: var(--font-mono)');
    for (const band of ['.band', '.band--card', '.band--plate']) block(band);
    expect(media('(min-width: 960px)')).toContain('grid-template-columns: repeat(12, minmax(0, 1fr))');
  });

  it('has a clearly visible focus-visible style', () => {
    expect(block(':focus-visible')).toMatch(/outline: 3px solid /);
  });

  it('collapses the nav behind the menu button under 640px from first paint, with no hydration gate', () => {
    expect(block('.nav-toggle')).toContain('display: none');
    expect(block('.site-nav ul')).toContain('display: flex');
    const narrow = media('(max-width: 640px)');
    expect(narrow).not.toContain('data-ready');
    expect(rules).not.toContain('data-ready');
    expect(block('.site-nav .nav-toggle', narrow)).toContain('display: inline-flex');
    expect(block('.site-nav ul', narrow)).toContain('display: none');
    expect(block('.site-nav[data-open] ul', narrow)).toContain('display: flex');
  });

  it('keeps the header row one height: a fixed-size Menu button and an overlay panel', () => {
    const toggle = block('.nav-toggle');
    expect(toggle).toMatch(/width: \d/);
    expect(toggle).toContain('min-height: 2.75rem');
    const narrow = media('(max-width: 640px)');
    expect(block('.site-header-inner', narrow)).toContain('flex-wrap: nowrap');
    const panel = block('.site-nav[data-open] ul', narrow);
    expect(panel).toContain('position: absolute');
    expect(panel).toContain('top: 100%');
    expect(block('.site-header')).toContain('position: relative');
  });

  it('shows the links and hides the Menu button when scripting is off', () => {
    const noScript = media('(scripting: none)');
    expect(block('.site-nav ul', noScript)).toContain('display: flex');
    expect(block('.site-nav .nav-toggle', noScript)).toContain('display: none');
    // It comes after the narrow-screen rules, so it wins over them.
    expect(rules.indexOf('@media (scripting: none)')).toBeGreaterThan(rules.indexOf('@media (max-width: 640px)'));
  });

  it('lays out pricing as a card grid that stacks when narrow, with Cloud bordered and no generated badge', async () => {
    const grid = block("main > section[aria-label='Plans']");
    expect(grid).toContain('display: grid');
    expect(grid).toContain('grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr))');
    expect(grid).toContain('max-width: none');
    expect(block("section[aria-label='Plans'] > article[data-tier='cloud']")).toMatch(/border: 2px solid/);
    // The Early access badge is markup (pricing.test.ts); CSS generates no badge text.
    expect(rules).not.toMatch(/article\[data-tier='cloud'\]::before/);
    expect(block("section[aria-label='Plans'] > article > p[data-badge]")).toContain('position: absolute');
    expect(block("section[aria-label='Plans'] > article > p[data-cta]")).toContain('margin-top: auto');
    expect(block('details')).toContain('border: 1px solid var(--field-border)');
    expect(block('summary')).toContain('min-height: 2.75rem');
    expect(block("nav[aria-label='Billing period'] ul")).toContain('border: 1px solid var(--field-border)');

    // The selectors above have to match what the pricing page renders.
    const html = renderToStaticMarkup(await PricingPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('<section aria-label="Plans"><article data-tier="core">');
    expect(html).toContain('<article data-tier="cloud">');
    expect(html).toContain('<nav aria-label="Billing period">');
  });

  it('hides [data-reveal] content only under html[data-reveal-ready] inside prefers-reduced-motion: no-preference', () => {
    const motion = media('(prefers-reduced-motion: no-preference)');
    // Every rule that mentions [data-reveal], anywhere, must be inside that query and scoped to reveal-ready.
    const outside = rules.replace(`@media (prefers-reduced-motion: no-preference) {${motion}}`, '');
    expect(outside).not.toContain('[data-reveal]');
    const revealRules = [...motion.matchAll(/([^{}]*\[data-reveal\][^{}]*)\{([^}]*)\}/g)];
    expect(revealRules.length).toBeGreaterThan(0);
    for (const [, selector] of revealRules) expect(selector!.trim()).toMatch(/^html\[data-reveal-ready\] /);
    expect(block('html[data-reveal-ready] [data-reveal]:not([data-revealed])', motion)).toContain('opacity: 0');
    // Hover lift and press only animate there too.
    expect(outside).not.toMatch(/:hover \{[^}]*translateY|:active[^{]*\{[^}]*translateY/);
  });

  it('marks the how-it-works steps for reveal and mounts the Reveal client component', async () => {
    const html = renderToStaticMarkup(HowItWorksPage());
    expect(html.match(/<li data-reveal="true">/g)).toHaveLength(5);
    expect(html).not.toContain('data-revealed');
    expect(read('../src/reveal.tsx')).toMatch(/^'use client';\n/);
    expect(read('../src/reveal.tsx')).toContain("root.setAttribute('data-reveal-ready', '')");
  });

  it('reveals anything at or above the reveal line, so a jump past a step never leaves it hidden', () => {
    expect(isDue(-500, 800)).toBe(true); // scrolled past entirely
    expect(isDue(100, 800)).toBe(true);
    expect(isDue(719, 800)).toBe(true);
    expect(isDue(720, 800)).toBe(false); // the bottom tenth is not yet due
    expect(isDue(2000, 800)).toBe(false);
  });

  it('draws the how-it-works chain diagram server-side, named and described, scaling with its column', () => {
    const html = renderToStaticMarkup(HowItWorksPage());
    const svg = /<svg class="chain-diagram"[^>]*>[\s\S]*?<\/svg>/.exec(html)?.[0] ?? '';
    expect(svg).toMatch(/role="img"/);
    expect(svg).toMatch(/aria-labelledby="chain-diagram-title chain-diagram-desc"/);
    expect(svg).toContain('<title id="chain-diagram-title">A hash chain anchored by a timestamp</title>');
    expect(svg).toMatch(/<desc id="chain-diagram-desc">[^<]*prev_hash[^<]*RFC 3161/);
    expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/);
    expect(svg).not.toMatch(/<image|href="http|url\((?!#)/);
    expect(block('.chain-diagram')).toContain('width: 100%');
    // Its own narrow-screen block (the first 640px block is the nav's).
    expect(rules).toContain(
      '@media (max-width: 640px) { .chain-diagram-small { display: none; } .chain-diagram-label { font-size: 24px; } }',
    );
  });

  it('edges the limits callout in seal red and gives each step a mono snippet', () => {
    expect(block("section[aria-label='Limits']")).toContain('border-left: 4px solid var(--seal-red)');
    const html = renderToStaticMarkup(HowItWorksPage());
    expect(html.match(/<p data-snippet="true"><code>/g)).toHaveLength(5);
    expect(html).toContain('prev_hash = SHA-256(JCS(previous receipt))');
  });

  it('leaves dark mode for later', () => {
    expect(block(':root')).toContain('color-scheme: light');
    expect(rules).not.toContain('prefers-color-scheme');
  });
});

describe('site header', () => {
  const html = renderToStaticMarkup(RootLayout({ children: null }));

  it('renders the five page links, Sign in and Start free next to a menu button that controls them', () => {
    const nav = /<nav aria-label="Main"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';
    const button = /<button\b[^>]*>Menu<\/button>/.exec(nav)?.[0] ?? '';
    expect(button).toContain('type="button"');
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain(`aria-controls="${NAV_LIST_ID}"`);
    expect(nav).toContain(`<ul id="${NAV_LIST_ID}">`);
    const links = [...nav.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[2], m[1]]);
    expect(links).toEqual([
      ['How it works', '/how-it-works'],
      ['Verify', '/verify'],
      ['Security', '/security'],
      ['Pricing', '/pricing'],
      ['Enterprise', '/enterprise'],
      ['Sign in', SIGNUP_PATH],
      ['Start free', GETTING_STARTED_URL],
    ]);
    expect(nav).toContain(`<li class="nav-cta"><a href="${GETTING_STARTED_URL}">Start free</a></li>`);
    expect(nav).not.toMatch(/>Home<|>Account<|href="\/signin"/);
  });

  it('renders the same nav before and after hydration, closed, so it works without JavaScript', () => {
    const nav = /<nav aria-label="Main"[^>]*>/.exec(html)?.[0] ?? '';
    expect(nav).toBe('<nav aria-label="Main" class="site-nav">');
    // With scripting off the CSS shows these links (see the stylesheet tests above).
    expect(html).toContain(`<ul id="${NAV_LIST_ID}">`);
  });

  it('marks the logo mark decorative, so the link is named by the brand alone', () => {
    const brand = /<a class="site-brand" href="\/">([\s\S]*?)<\/a>/.exec(html)?.[1] ?? '';
    expect(brand).toMatch(/^<svg aria-hidden="true" focusable="false"/);
    expect(brand.replace(/<svg[\s\S]*<\/svg>/, '')).toBe(BRAND.name);
  });

  it('closes on Escape and sends focus back to the Menu button', () => {
    expect(navKeyAction('Escape', true)).toEqual({ open: false, focusToggle: true });
  });

  it('ignores Escape while closed and every other key', () => {
    expect(navKeyAction('Escape', false)).toBeNull();
    expect(navKeyAction('Enter', true)).toBeNull();
    expect(navKeyAction('Tab', true)).toBeNull();
  });

  it('marks the nav client component as a client component', () => {
    expect(read('../src/nav-menu.tsx')).toMatch(/^'use client';\n/);
  });
});

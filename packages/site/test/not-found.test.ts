import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import RootLayout from '../app/layout.js';
import NotFound, { metadata } from '../app/not-found.js';
import { BRAND } from '../src/brand.js';

/**
 * The branded 404. Next serves app/not-found.tsx, inside the root layout and with
 * HTTP 404, for any URL that no page or route handler matches. These tests pin the
 * page itself and the routing facts that guarantee the 404: every route is static,
 * and nothing (a catch-all, middleware or proxy) can answer an unknown URL first.
 *
 * A live request is not made here: starting Next writes .next/ and next-env.d.ts
 * into the package, which a unit test run must not do.
 */

const SITE = new URL('../', import.meta.url);
const APP = new URL('../app/', import.meta.url);

const html = renderToStaticMarkup(RootLayout({ children: NotFound() }));
const main = /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? '';

/** Every URL a page or route handler answers, from the app folder. */
const routes = readdirSync(APP, { recursive: true, encoding: 'utf8' })
  .map((f) => f.split('\\').join('/'))
  .filter((f) => /(^|\/)(page|route)\.(tsx?|jsx?|mdx?)$/.test(f))
  .map((f) => {
    const segments = f.split('/').slice(0, -1).filter((s) => !/^\(.*\)$/.test(s));
    return `/${segments.join('/')}`;
  });

/** The status Next answers a GET with, given the routes above. */
const statusFor = (path: string) => (routes.includes(path) ? 200 : 404);

describe('not-found page', () => {
  it('sits at the app root, where Next uses it for every unmatched URL', () => {
    expect(existsSync(new URL('not-found.tsx', APP))).toBe(true);
  });

  it('renders inside the site layout, under the header and nav', () => {
    expect(html).toContain('<header class="site-header">');
    expect(html).toContain('<nav aria-label="Main"');
    expect(html).toContain('<footer>');
    expect(main).toContain('<h1>Page not found</h1>');
  });

  it('links back to Home, Pricing and Verify from the page body', () => {
    const links = [...main.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
    expect(links).toEqual([
      ['/', 'Home'],
      ['/pricing', 'Pricing'],
      ['/verify', 'Verify a bundle'],
    ]);
  });

  it('sets a short title and leaves the brand to the layout template', () => {
    expect(metadata.title).toBe('Page not found');
    const code = readFileSync(new URL('not-found.tsx', APP), 'utf8');
    expect(code).not.toContain(BRAND.name);
  });

  it('sets no status or redirect of its own', () => {
    const code = readFileSync(new URL('not-found.tsx', APP), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/'use client'|redirect|permanentRedirect|status/i);
  });
});

describe('unknown routes', () => {
  it('answer 404, while the pages the 404 links to answer 200', () => {
    for (const path of ['/docs', '/docs/getting-started', '/pricing/extra', '/api/unknown']) {
      expect(statusFor(path), path).toBe(404);
    }
    for (const path of ['/', '/pricing', '/verify']) expect(statusFor(path), path).toBe(200);
  });

  it('cannot be caught by a dynamic or catch-all segment', () => {
    const dynamic = routes.filter((r) => r.includes('['));
    expect(dynamic).toEqual([]);
  });

  it('cannot be answered by middleware or a proxy before routing', () => {
    for (const dir of ['', 'src/']) {
      for (const name of ['middleware', 'proxy']) {
        for (const ext of ['ts', 'tsx', 'js', 'mjs']) {
          expect(existsSync(new URL(`${dir}${name}.${ext}`, SITE)), `${dir}${name}.${ext}`).toBe(false);
        }
      }
    }
  });

  it('are not rewritten or redirected by the Next config', () => {
    const config = readFileSync(new URL('next.config.ts', SITE), 'utf8');
    expect(config).not.toMatch(/rewrites|redirects|trailingSlash|basePath/);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The landing page in docs/ is a public site. These tests pin the launch-readiness
 * files a crawler and a browser expect to find: robots.txt, sitemap.xml, and the
 * security policy (docs/_headers for a header-capable host, meta equivalents for
 * GitHub Pages, which cannot send custom headers).
 */

const DOCS = new URL('../docs/', import.meta.url).pathname;
const SITE = 'https://jaredklopstein.github.io/provenant';

const read = (name: string) => readFileSync(join(DOCS, name), 'utf8');

describe('robots.txt', () => {
  const robots = read('robots.txt');

  it('allows crawlers', () => {
    expect(robots).toMatch(/^User-agent:\s*\*$/m);
    expect(robots).toMatch(/^Allow:\s*\/$/m);
    expect(robots).not.toMatch(/^Disallow:\s*\/$/m);
  });

  it('points at the sitemap that exists', () => {
    expect(robots).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });
});

describe('sitemap.xml', () => {
  const sitemap = read('sitemap.xml');

  it('is a sitemap document listing the landing page', () => {
    expect(sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(sitemap).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    expect(sitemap).toContain(`<loc>${SITE}/</loc>`);
  });
});

describe('_headers', () => {
  const headers = read('_headers');

  it('applies the policy to every path', () => {
    expect(headers).toMatch(/^\/\*$/m);
  });

  it('sets the four headers preflight checks', () => {
    expect(headers).toMatch(/^\s+X-Content-Type-Options: nosniff$/m);
    expect(headers).toMatch(
      /^\s+Referrer-Policy: (no-referrer|strict-origin|strict-origin-when-cross-origin)$/m,
    );
    expect(headers).toMatch(/^\s+X-Frame-Options: DENY$/m);
    expect(headers).toMatch(/^\s+Content-Security-Policy: .*frame-ancestors 'none'/m);
  });
});

describe('index.html', () => {
  const html = read('index.html');

  it('declares the CSP a browser can honour from a meta tag', () => {
    expect(html).toMatch(
      /<meta http-equiv="Content-Security-Policy" content="[^"]*frame-ancestors 'none'[^"]*">/,
    );
  });

  it('declares a referrer policy', () => {
    expect(html).toMatch(
      /<meta name="referrer" content="(no-referrer|strict-origin|strict-origin-when-cross-origin)">/,
    );
  });

  it('keeps a clickjacking guard, since GitHub Pages cannot send X-Frame-Options', () => {
    expect(html).toContain('if (self !== top)');
  });

  it('keeps the CSP compatible with what the page actually loads', () => {
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1];
    expect(csp).toBeDefined();
    // The page has an inline <style>, an inline <script> and Google-hosted fonts.
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain('font-src https://fonts.gstatic.com');
    expect(html).toContain('https://fonts.googleapis.com/css2?');
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OVERAGE_BUNDLE_PRICE_USD,
  PAYG_BUNDLE_PRICE_USD,
  PLANS,
} from '../packages/cloud/src/pricing.js';

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

/**
 * The pricing cards are the public price list. Each card carries a data-tier
 * attribute so these assertions can be scoped to one card: a term that moves to
 * the wrong card, or drops out of it, must fail here even if it still appears
 * somewhere else on the page.
 */
describe('pricing cards', () => {
  const html = read('index.html');

  /** The markup of every card, keyed by its data-tier value. */
  function cards(): Map<string, string> {
    const start = html.indexOf('<div class="tiers">');
    expect(start).toBeGreaterThan(-1);
    const block = html.slice(start, html.indexOf('</section>', start));
    const found = new Map<string, string>();
    const parts = block.split(/(?=<div class="tier[^"]*" data-tier=")/).slice(1);
    for (const part of parts) {
      const tier = /data-tier="([^"]+)"/.exec(part)?.[1];
      if (tier) found.set(tier, part);
    }
    return found;
  }

  const price = (card: string) => /<div class="price">([^<]*)<\/div>/.exec(card)?.[1];

  it('shows exactly four cards, in order', () => {
    expect([...cards().keys()]).toEqual(['core', 'bundle', 'cloud', 'enterprise']);
    expect(html.match(/<div class="tier[ "]/g)).toHaveLength(4);
  });

  it('prices each card', () => {
    const c = cards();
    expect(price(c.get('core')!)).toMatch(/free/i);
    expect(price(c.get('bundle')!)).toBe(`$${PAYG_BUNDLE_PRICE_USD} each`);
    expect(price(c.get('cloud')!)).toBe(
      `$${PLANS.cloud.monthlyUsd}/mo or $${PLANS.cloud.annualUsd}/yr`,
    );
    expect(price(c.get('enterprise')!)).toMatch(/contact us/i);
  });

  it('no longer advertises the old $99 bundle price', () => {
    expect(html).not.toContain('$99 per bundle');
    // The tamper demo's dollar figure is part of the exhibit, not a price.
    expect(html).toContain('Alter the refund to $99,999');
  });

  it('lists every Cloud term on the Cloud card', () => {
    const cloud = cards().get('cloud')!;
    expect(cloud).toContain('$49/mo or $490/yr');
    expect(cloud).toMatch(/5 bundles\/month, no rollover/);
    expect(cloud).toContain('$10 per extra bundle');
    expect(cloud).toMatch(/\b10 agent identities included/);
    expect(cloud).toContain('$4/mo per extra identity');
    expect(cloud).toContain('90-day retention');
    expect(cloud).toMatch(/\b(1M|1,000,000) receipts\/month fair-use cap/);
    expect(cloud).toMatch(/at most 15 minutes/);
  });

  it('matches the cloud plan in pricing.ts', () => {
    const cloud = cards().get('cloud')!;
    const p = PLANS.cloud;
    expect(p.fairUseReceiptsPerMonth).toBe(1_000_000);
    expect(cloud).toContain(`${p.includedBundlesPerMonth} bundles/month, no rollover`);
    expect(cloud).toContain(`$${OVERAGE_BUNDLE_PRICE_USD} per extra bundle`);
    expect(cloud).toContain(`${p.includedAgentIdentities} agent identities included`);
    expect(cloud).toContain(`$${p.perExtraIdentityUsd}/mo per extra identity`);
    expect(cloud).toContain(`${p.retentionDays}-day retention`);
    expect(cloud).toContain(`at most ${p.maxAnchorIntervalMinutes} minutes`);
  });

  it('shows no price on the Enterprise card', () => {
    expect(cards().get('enterprise')!).not.toMatch(/\$\s*\d/);
  });

  it('has no Team plan anywhere on the site', () => {
    expect(html).not.toMatch(/\bTeam\b/);
  });

  it('does not claim checkout is live', () => {
    expect(html).not.toMatch(/stripe|checkout/i);
  });
});

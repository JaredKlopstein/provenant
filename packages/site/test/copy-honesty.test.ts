import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import HowItWorksPage from '../app/how-it-works/page.js';
import PricingPage from '../app/pricing/page.js';
import SecurityPage from '../app/security/page.js';
import {
  BUNDLE_DELIVERY_BUSINESS_DAYS,
  BUNDLE_FORMAT,
  BUNDLE_FULFILMENT,
  BUNDLE_TODAY_ID,
  OFF_SALE_PLANS,
  pricingAnnualOverageDisclosure,
} from '../src/plans.js';

/**
 * Honest copy pass (13): Cloud is never described as working while it is off
 * sale, the bundle is described one way everywhere, and the page says how a
 * bundle is actually made today (by hand: the buyer sends their chain file, never
 * their signing key, and gets the anchored bundle back by email).
 */

const unescape = (s: string) =>
  s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const text = (html: string) => unescape(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

const pages = {
  howItWorks: renderToStaticMarkup(HowItWorksPage()),
  security: renderToStaticMarkup(SecurityPage()),
  pricing: renderToStaticMarkup(await PricingPage({ searchParams: Promise.resolve({}) })),
  pricingAnnual: renderToStaticMarkup(await PricingPage({ searchParams: Promise.resolve({ billing: 'annual' }) })),
};

describe('Cloud is never described as working', () => {
  it('no page says Cloud anchors, exports or batches in the present tense', () => {
    expect(OFF_SALE_PLANS.has('cloud')).toBe(true);
    for (const [name, html] of Object.entries(pages)) {
      const body = text(html);
      expect(body, name).not.toMatch(/\bCloud (anchors|exports|batches)\b/);
      expect(body, name).not.toMatch(/\bCloud \([^)]*\) (anchors|exports|batches)\b/);
      expect(body, name).not.toMatch(/\bOn Cloud, /);
    }
  });

  it('describes Cloud anchoring as planned and early access wherever it comes up', () => {
    expect(text(pages.howItWorks)).toContain('Cloud (early access, not available yet) is planned to anchor');
    expect(text(pages.security)).toContain('Cloud (early access, not available yet) is planned to anchor');
  });

  it('puts the annual overage disclosure in the future tense', () => {
    expect(pricingAnnualOverageDisclosure()).toMatch(/^When Cloud is available, .* will be charged /);
    expect(text(pages.pricingAnnual)).toContain(pricingAnnualOverageDisclosure());
    expect(text(pages.pricingAnnual)).not.toContain('billed to your card');
  });
});

describe('the evidence bundle, described one way', () => {
  it('uses the same format phrase on /how-it-works and /pricing, and no other', () => {
    expect(text(pages.howItWorks)).toContain(BUNDLE_FORMAT);
    expect(text(pages.pricing)).toContain(BUNDLE_FORMAT);
    for (const html of [pages.howItWorks, pages.pricing]) {
      expect(text(html)).not.toMatch(/human-readable report alongside|PDF and HTML renderings/);
    }
  });

  it('says how a bundle is made today, linked from the pricing intro', () => {
    expect(pages.pricing).toContain(`anchored bundles today (<a href="#${BUNDLE_TODAY_ID}">how a bundle is made today</a>)`);
    expect(pages.pricing).toContain(`<h2 id="${BUNDLE_TODAY_ID}">How a bundle is made today</h2>`);
    expect(text(pages.pricing)).toContain(BUNDLE_FULFILMENT);
    expect(BUNDLE_FULFILMENT).toContain(`within ${BUNDLE_DELIVERY_BUSINESS_DAYS} business days`);
    expect(text(pages.howItWorks)).toContain('Today that happens when you buy an evidence bundle');
  });

  it('never asks for a signing key and never overclaims the timestamp', () => {
    expect(BUNDLE_FULFILMENT).toContain('your signing key stays with you and we never ask for it');
    expect(BUNDLE_FULFILMENT).toContain('not earlier');
  });
});

describe('small fixes', () => {
  it('leaves the step numbers to the <ol> on /how-it-works', () => {
    expect(pages.howItWorks).not.toMatch(/<h2>\d+\. /);
    expect(pages.howItWorks).toContain('<ol role="list"><li data-reveal="true"><h2>Record</h2>');
  });

  it('spells behavior the US way, like the rest of the site', () => {
    for (const html of Object.values(pages)) expect(html).not.toMatch(/behaviour/i);
    expect(readFileSync(new URL('../app/security/page.tsx', import.meta.url), 'utf8')).not.toMatch(/behaviour/);
  });
});

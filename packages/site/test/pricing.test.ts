import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import RootLayout from '../app/layout.js';
import HomePage from '../app/page.js';
import PricingPage, { metadata } from '../app/pricing/page.js';
import { BRAND } from '../src/brand.js';
import { ACCOUNT_PATH, CHECKOUT_PAGE_PATH } from '../src/checkout.js';
import {
  BUNDLE_DEFINITION,
  OFF_SALE_PLANS,
  WAITLIST_HREF,
  annualOverageDisclosure,
  annualSavingsLine,
  annualSavingsMonths,
  cardCta,
  cloudTerms,
  coreTerms,
  priceCards,
  pricingAnnualOverageDisclosure,
  pricingFaq,
} from '../src/plans.js';
import { OVERAGE_BUNDLE_PRICE_USD, PAYG_BUNDLE_PRICE_USD, PLANS } from '../../cloud/src/pricing.js';
import { createCheckoutSession, type StripeLike } from '../../cloud/src/billing/stripe.js';

/**
 * The pricing page renders its cards from cloud's PLANS. Expected values here are
 * built from the pricing source itself, so the test pins the page to PLANS rather
 * than to a second copy of the prices.
 */

const render = async (billing?: string, extra: Record<string, string> = {}) =>
  renderToStaticMarkup(
    await PricingPage({ searchParams: Promise.resolve({ ...(billing ? { billing } : {}), ...extra }) }),
  );

const unescape = (html: string) =>
  html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Each card's title, price, list items and full markup, in page order. */
function cards(html: string) {
  return [...html.matchAll(/<article data-tier="([^"]+)">([\s\S]*?)<\/article>/g)].map(([, id, body]) => ({
    id,
    title: unescape(/<h2>([^<]*)<\/h2>/.exec(body!)?.[1] ?? ''),
    price: unescape(/<\/h2><p>([^<]*)<\/p>/.exec(body!)?.[1] ?? ''),
    terms: [...body!.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => unescape(m[1]!)),
    html: body!,
  }));
}

/** Every link's href, in markup order. */
const hrefs = (html: string) => [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((m) => unescape(m[1]!));

/** The text and href of each link, in markup order. */
const links = (html: string) =>
  [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(([, href, label]) => ({
    label: unescape(label!),
    href: unescape(href!),
  }));

const card = (html: string, id: string) => {
  const found = cards(html).find((c) => c.id === id);
  expect(found, id).toBeDefined();
  return found!;
};

const { cloud } = PLANS;
const CLOUD_TERMS = [
  `Continuous anchoring, batched, at most ${cloud.maxAnchorIntervalMinutes} minutes apart`,
  `${cloud.includedBundlesPerMonth} bundles/month, no rollover`,
  `$${OVERAGE_BUNDLE_PRICE_USD} per extra bundle`,
  `${cloud.includedAgentIdentities} agent identities included`,
  `$${cloud.perExtraIdentityUsd}/mo per extra identity`,
  `${cloud.retentionDays}-day retention`,
  `${cloud.fairUseReceiptsPerMonth! / 1_000_000}M receipts/month fair-use cap (not billed)`,
];

/** The sentence the annual Cloud checkout shows, taken from the checkout itself. */
async function checkoutDisclosure(): Promise<string> {
  let message: string | undefined;
  const stripe: StripeLike = {
    checkout: {
      sessions: {
        async create(params) {
          message = (params.custom_text as { submit?: { message?: string } } | undefined)?.submit?.message;
          return { id: 'cs_test_pricing_page', url: null };
        },
      },
    },
    billingPortal: { sessions: { async create() { return { url: 'https://portal.test' }; } } },
  };
  await createCheckoutSession(stripe, {
    planId: 'cloud',
    interval: 'year',
    priceId: 'price_test_cloud_year',
    successUrl: 'https://site.test/ok',
    cancelUrl: 'https://site.test/no',
  });
  expect(message).toBeDefined();
  return message!;
}

describe('pricing cards', () => {
  it('renders four cards, Core, bundle, Cloud and Enterprise, in that order', async () => {
    for (const billing of [undefined, 'annual']) {
      expect(cards(await render(billing)).map((c) => c.id)).toEqual(['core', 'bundle', 'cloud', 'enterprise']);
    }
  });

  it('shows Core as free with the features PLANS lists for it, minus the CLI name (#100)', async () => {
    const core = card(await render(), 'core');
    expect(PLANS.free.monthlyUsd).toBe(0);
    expect(core.price).toBe('Free');
    expect(core.terms).toEqual(PLANS.free.features.map((f) => f.replace(/ \(lacre-verify\)$/, '')));
    expect(core.terms).toContain('Offline evidence-bundle verification');
    expect(core.html).not.toMatch(/lacre-/i);
  });

  it('strips only a parenthesised CLI name from the Core terms (#100)', () => {
    const terms = coreTerms({ ...PLANS.free, features: ['Verify offline (lacre-verify)', 'Batched (at most hourly)'] });
    expect(terms).toEqual(['Verify offline', 'Batched (at most hourly)']);
  });

  it('prices the evidence bundle from PAYG_BUNDLE_PRICE_USD', async () => {
    expect(card(await render(), 'bundle').price).toBe(`$${PAYG_BUNDLE_PRICE_USD} each`);
  });

  it('prices Cloud from PLANS per billing period', async () => {
    expect(card(await render(), 'cloud').price).toBe(`$${cloud.monthlyUsd}/mo`);
    expect(card(await render('annual'), 'cloud').price).toBe(`$${cloud.annualUsd}/yr`);
  });

  it('lists every Cloud term with the PLANS values, and no term is missing', async () => {
    for (const billing of [undefined, 'annual']) {
      const c = card(await render(billing), 'cloud');
      expect(c.title).toBe(cloud.name);
      expect(c.terms).toEqual(CLOUD_TERMS);
    }
  });

  it('matches the bundle and Cloud cards on the Pages site', async () => {
    const pages = readFileSync(new URL('../../../docs/index.html', import.meta.url), 'utf8');
    const pagesCard = (tier: string) => {
      const body = new RegExp(`data-tier="${tier}">([\\s\\S]*?)</ul>`).exec(pages)?.[1] ?? '';
      const plain = (s: string) => unescape(s.replace(/&nbsp;/g, ' ')).trim();
      return {
        price: plain(/<div class="price">([^<]*)<\/div>/.exec(body)?.[1] ?? ''),
        terms: [...body.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => plain(m[1]!)),
      };
    };
    const monthly = await render();
    const annual = await render('annual');
    expect(card(monthly, 'bundle').price).toBe(pagesCard('bundle').price);
    expect(`${card(monthly, 'cloud').price} or ${card(annual, 'cloud').price}`).toBe(pagesCard('cloud').price);
    expect(card(monthly, 'cloud').terms).toEqual(pagesCard('cloud').terms);
  });

  it('generates the Cloud terms from the plan it is given', () => {
    const changed = cloudTerms({ ...cloud, retentionDays: 30, includedBundlesPerMonth: 7, fairUseReceiptsPerMonth: 2_500_000 });
    expect(changed).toContain('30-day retention');
    expect(changed).toContain('7 bundles/month, no rollover');
    expect(changed).toContain('2,500,000 receipts/month fair-use cap (not billed)');
  });

  it('refuses to render a Cloud card with a term missing from PLANS', () => {
    expect(() => cloudTerms({ ...cloud, retentionDays: null })).toThrow(/retentionDays/);
  });
});

describe('Cloud in early access (#95)', () => {
  it('labels the Cloud card Early access and describes its terms as planned', async () => {
    for (const billing of [undefined, 'annual']) {
      const c = card(await render(billing), 'cloud');
      expect(c.html).toMatch(/<p data-status="early-access"><strong>Early access<\/strong>: not on sale yet\./);
      expect(c.html).toContain('<h3>Planned, not available yet</h3>');
      expect(c.html.indexOf('<h3>')).toBeLessThan(c.html.indexOf('<ul>'));
    }
  });

  it('has no checkout button, form or link on the Cloud card, only the waitlist link and form (#129)', async () => {
    for (const billing of [undefined, 'annual']) {
      const c = card(await render(billing), 'cloud');
      expect(hrefs(c.html)).toEqual(['/pricing#waitlist']);
      expect(c.html).not.toMatch(/\/checkout/);
      expect(c.html.match(/<form\b[^>]*>/g)).toEqual(['<form aria-label="Cloud early access waitlist">']);
      expect(c.html.match(/<button\b/g)).toHaveLength(1);
    }
  });

  it('flags Cloud, and only Cloud, off sale in the plans source', () => {
    expect([...OFF_SALE_PLANS]).toEqual(['cloud']);
    expect(priceCards('monthly').filter((c) => c.offSale).map((c) => c.id)).toEqual(['cloud']);
  });

  it('does not describe Cloud as a subscription you can buy now', async () => {
    expect(metadata.description).toMatch(/Cloud is in early access/);
    expect(await render()).not.toMatch(/Cloud is a subscription/);
  });
});

describe('calls to action (#94)', () => {
  /** An internal href resolves when app/ has a page for its path. */
  const resolves = (href: string) => {
    const path = new URL(href, 'https://site.test').pathname;
    return existsSync(new URL(`../app${path === '/' ? '' : path}/page.tsx`, import.meta.url));
  };
  const getStarted = `${BRAND.repository}/blob/main/docs/getting-started.md`;

  it('gives each pricing card exactly one button, to its intended route', async () => {
    for (const billing of [undefined, 'annual']) {
      const html = await render(billing);
      const ctas = Object.fromEntries(
        cards(html).map((c) => [c.id, links(c.html).filter((l) => l.label !== 'Monthly' && l.label !== 'Annual')]),
      );
      expect(ctas).toEqual({
        core: [{ label: 'Start free', href: getStarted }],
        bundle: [{ label: 'Buy a bundle', href: '/checkout' }],
        cloud: [{ label: 'Join the waitlist', href: '/pricing#waitlist' }],
        enterprise: [{ label: 'Contact the team', href: '/enterprise' }],
      });
      for (const c of cards(html)) {
        for (const href of hrefs(c.html)) if (href.startsWith('/')) expect(resolves(href), href).toBe(true);
      }
    }
  });

  it('points the Bundle button straight at /checkout', async () => {
    expect(resolves(CHECKOUT_PAGE_PATH)).toBe(true);
    expect(priceCards('monthly').find((c) => c.id === 'bundle')!.cta.href).toBe(CHECKOUT_PAGE_PATH);
    expect(hrefs(card(await render(), 'bundle').html)).toEqual([CHECKOUT_PAGE_PATH]);
  });

  it('points the Cloud button at /pricing#waitlist and never at checkout, monthly or annual', async () => {
    for (const billing of ['monthly', 'annual'] as const) {
      const cta = priceCards(billing).find((c) => c.id === 'cloud')!.cta;
      expect(cta).toEqual({ label: 'Join the waitlist', href: '/pricing#waitlist' });
      const html = card(await render(billing), 'cloud').html;
      expect(hrefs(html)).toEqual(['/pricing#waitlist']);
      // No link or form on the Cloud card may go to checkout.
      expect(html).not.toMatch(/(?:href|action)="[^"]*(?:checkout|billing=|interval=)/);
      expect(html).not.toMatch(/name="(?:plan|interval|kind)"/);
    }
  });

  it('gives any off-sale card the waitlist button, never a checkout link', () => {
    for (const id of ['core', 'bundle', 'cloud', 'enterprise'] as const) {
      expect(cardCta(id, true)).toEqual({ label: 'Join the waitlist', href: WAITLIST_HREF });
    }
    for (const c of [...priceCards('monthly'), ...priceCards('annual')]) {
      if (c.offSale) expect(c.cta.href).toBe(WAITLIST_HREF);
      else expect(c.cta.href).not.toBe(WAITLIST_HREF);
    }
  });

  it('renders the waitlist form inside an element with id="waitlist"', async () => {
    for (const billing of [undefined, 'annual']) {
      const html = await render(billing);
      expect(html.match(/\bid="waitlist"/g)).toHaveLength(1);
      expect(html).toMatch(/<div id="waitlist"><form aria-label="Cloud early access waitlist"/);
    }
  });

  it('gives the home hero a primary and a secondary call to action', () => {
    // The hero's copy column, before the Exhibit A slot (revamp 3/9).
    const hero = /<section aria-label="Hero"[^>]*>[\s\S]*?(?=<div data-slot="exhibit")/.exec(renderToStaticMarkup(HomePage()))?.[0] ?? '';
    expect(links(hero)).toEqual([
      { label: 'Start free', href: getStarted },
      { label: 'See pricing', href: '/pricing' },
    ]);
    expect(resolves('/pricing')).toBe(true);
  });

  it('has one static Account link to /account in the header', () => {
    const html = renderToStaticMarkup(RootLayout({ children: null }));
    const header = /<header\b[\s\S]*?<\/header>/.exec(html)?.[0] ?? '';
    expect(links(header).filter((l) => l.label === 'Account')).toEqual([{ label: 'Account', href: ACCOUNT_PATH }]);
    expect(resolves(ACCOUNT_PATH)).toBe(true);
  });

  it('keeps the root layout static: no cookies, headers or session lookup', () => {
    const src = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
    expect(src).not.toMatch(/next\/headers|cookies\(|headers\(|auth\/|signedIn|session/i);
    expect(src).not.toMatch(/\bdynamic\b|force-dynamic/);
  });
});

describe('enterprise and team', () => {
  it('shows Enterprise with no dollar figure', async () => {
    for (const billing of [undefined, 'annual']) {
      const e = card(await render(billing), 'enterprise');
      expect(e.title).toBe(PLANS.enterprise.name);
      expect(e.price).toBe('Contact us');
      expect(e.html).not.toMatch(/\$\s*\d|USD|\/mo\b|\/yr\b/);
      expect(e.html).toContain('href="/enterprise"');
    }
  });

  it('has no Team card anywhere', async () => {
    for (const billing of [undefined, 'annual']) {
      const html = await render(billing);
      expect(html).not.toMatch(/\bTeam\b/);
      expect(cards(html).map((c) => c.id)).not.toContain('team');
    }
  });
});

describe('billing toggle', () => {
  it('links Monthly and Annual and marks the current one', async () => {
    // React does not keep attribute order, so find each link and then check it.
    const link = (html: string, label: string) => new RegExp(`<a\\b[^>]*>${label}</a>`).exec(html)?.[0] ?? '';
    const monthly = await render();
    const annual = await render('annual');
    expect(link(monthly, 'Monthly')).toContain('href="/pricing"');
    expect(link(monthly, 'Annual')).toContain('href="/pricing?billing=annual"');
    expect(link(monthly, 'Monthly')).toContain('aria-current="page"');
    expect(link(monthly, 'Annual')).not.toContain('aria-current');
    expect(link(annual, 'Annual')).toContain('aria-current="page"');
    expect(link(annual, 'Monthly')).not.toContain('aria-current');
  });

  it('treats an unknown billing value as monthly', async () => {
    expect(card(await render('weekly'), 'cloud').price).toBe(`$${cloud.monthlyUsd}/mo`);
  });

  it('shows the pricing-page overage disclosure under Annual, billed to your card (#100)', async () => {
    const annualCloud = unescape(card(await render('annual'), 'cloud').html);
    expect(annualCloud).toContain(`<p role="note">${pricingAnnualOverageDisclosure()}</p>`);
    expect(pricingAnnualOverageDisclosure()).toBe(
      `Evidence bundles over the ${cloud.includedBundlesPerMonth} included each month are charged monthly, ` +
        `at $${OVERAGE_BUNDLE_PRICE_USD} per bundle, billed to your card.`,
    );
    expect(annualCloud).not.toContain('this checkout');
  });

  it('keeps the checkout its own sentence, unchanged (#100)', async () => {
    const disclosure = await checkoutDisclosure();
    expect(disclosure).toBe(annualOverageDisclosure());
    expect(disclosure).toBe(
      `Evidence bundles over the ${cloud.includedBundlesPerMonth} included each month are billed monthly, ` +
        `at $${OVERAGE_BUNDLE_PRICE_USD} per bundle, to the card saved at this checkout.`,
    );
  });

  it('does not show the disclosure under Monthly', async () => {
    expect(await render()).not.toContain('role="note"');
    expect(unescape(await render())).not.toContain(pricingAnnualOverageDisclosure());
  });
});

describe('pricing content (#100)', () => {
  it('defines the evidence bundle in one line on the page', async () => {
    expect(BUNDLE_DEFINITION).toBe(
      'An evidence bundle is a signed, timestamped export of a chain range that an auditor verifies offline.',
    );
    for (const billing of [undefined, 'annual']) {
      expect(await render(billing)).toContain(`<p data-definition="evidence-bundle">${BUNDLE_DEFINITION}</p>`);
    }
  });

  it('shows "2 months free" under the annual Cloud price, computed from PLANS', async () => {
    const months = (12 * cloud.monthlyUsd! - cloud.annualUsd!) / cloud.monthlyUsd!;
    expect(annualSavingsMonths()).toBe(months);
    expect(annualSavingsLine()).toBe(`${months} months free against 12 monthly payments`);
    expect(annualSavingsLine()).toMatch(/^2 months free/);
    const annualCloud = card(await render('annual'), 'cloud').html;
    expect(annualCloud).toContain(`<p>$${cloud.annualUsd}/yr</p><p data-price-note="true">${annualSavingsLine()}</p>`);
    expect(await render()).not.toContain('months free');
  });

  it('computes the saving from the plan it is given', () => {
    expect(annualSavingsLine({ ...cloud, monthlyUsd: 20, annualUsd: 220 })).toBe('1 month free against 12 monthly payments');
    expect(annualSavingsMonths({ ...cloud, monthlyUsd: 10, annualUsd: 90 })).toBe(3);
    expect(() => annualSavingsMonths({ ...cloud, annualUsd: null })).toThrow(/annualUsd/);
  });

  it('describes the bundle card plainly', async () => {
    const bundle = card(await render(), 'bundle');
    expect(bundle.terms).toContain('A human-readable report alongside the JSON');
    expect(bundle.terms).toContain('The timestamp proves the chain existed when it was anchored, not earlier');
    expect(bundle.html).not.toMatch(/will not read JSON|whole point/);
  });

  it('answers the FAQ in terms the cards already use', async () => {
    const html = unescape(await render());
    const faq = pricingFaq();
    expect(faq.map((e) => e.question)).toEqual([
      'What is a receipt?',
      'What is an evidence bundle?',
      'What does the receipts/month fair-use cap mean?',
      'Do I need a subscription to buy an evidence bundle?',
    ]);
    for (const { question, answer } of faq) expect(html).toContain(`<dt>${question}</dt><dd>${answer}</dd>`);
    expect(faq[1]!.answer).toContain(BUNDLE_DEFINITION);
    expect(faq[2]!.answer).toContain(`${cloud.fairUseReceiptsPerMonth! / 1_000_000}M receipts/month`);
    expect(faq[2]!.answer).toMatch(/not billed/);
    expect(faq[3]!.answer).toContain('pay as you go, no subscription');
    expect(faq[3]!.answer).toContain(`$${PAYG_BUNDLE_PRICE_USD} each`);
    // No price in the FAQ other than the ones on the cards.
    const prices = [...faq.map((e) => e.answer).join(' ').matchAll(/\$\d+/g)].map((m) => m[0]);
    expect(prices).toEqual([`$${PAYG_BUNDLE_PRICE_USD}`]);
  });

  it('notes a cancelled checkout, and nothing otherwise', async () => {
    const note = '<p role="status">Checkout cancelled, nothing was charged.</p>';
    expect(await render(undefined, { checkout: 'cancelled' })).toContain(note);
    expect(await render('annual', { checkout: 'cancelled' })).toContain(note);
    expect(await render()).not.toContain('role="status"');
    expect(await render(undefined, { checkout: '<script>' })).not.toContain('role="status"');
  });

  it('gives no card a "Most popular" badge', async () => {
    for (const billing of [undefined, 'annual']) {
      const html = await render(billing);
      expect(html).not.toMatch(/most popular|recommended|data-featured/i);
    }
  });
});

describe('site source', () => {
  const files = ['../app/pricing/page.tsx', '../src/plans.ts'].map((f) => ({
    file: f,
    src: readFileSync(new URL(f, import.meta.url), 'utf8'),
  }));
  const priced = [
    cloud.monthlyUsd,
    cloud.annualUsd,
    cloud.perExtraIdentityUsd,
    cloud.includedAgentIdentities,
    cloud.retentionDays,
    cloud.maxAnchorIntervalMinutes,
    cloud.includedBundlesPerMonth,
    PAYG_BUNDLE_PRICE_USD,
    OVERAGE_BUNDLE_PRICE_USD,
  ];

  it('types no price or plan number', () => {
    for (const { file, src } of files) {
      expect(src, file).not.toMatch(/\$\s*\d/);
      for (const n of priced) expect(src, `${file}: ${n}`).not.toMatch(new RegExp(`(?<![\\w.])${n}(?![\\w.])`));
    }
  });

  it('takes brand text from BRAND only', () => {
    expect(metadata.title).toBe('Pricing');
    expect(metadata.description).toContain(BRAND.name);
    for (const { file, src } of files) {
      // The cloud import specifier names the package scope, which is not page copy.
      const copy = src.replace(/from\s+'[^']+'/g, '');
      expect(copy, file).not.toMatch(new RegExp(BRAND.name, 'i'));
    }
  });

  it('titles the Core card from BRAND', async () => {
    expect(card(await render(), 'core').title).toBe(`${BRAND.name} Core`);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import PricingPage, { metadata } from '../app/pricing/page.js';
import { BRAND } from '../src/brand.js';
import { cloudTerms } from '../src/plans.js';
import { OVERAGE_BUNDLE_PRICE_USD, PAYG_BUNDLE_PRICE_USD, PLANS } from '../../cloud/src/pricing.js';
import { createCheckoutSession, type StripeLike } from '../../cloud/src/billing/stripe.js';

/**
 * The pricing page renders its cards from cloud's PLANS. Expected values here are
 * built from the pricing source itself, so the test pins the page to PLANS rather
 * than to a second copy of the prices.
 */

const render = async (billing?: string) =>
  renderToStaticMarkup(await PricingPage({ searchParams: Promise.resolve(billing ? { billing } : {}) }));

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

  it('shows Core as free with the features PLANS lists for it', async () => {
    const core = card(await render(), 'core');
    expect(PLANS.free.monthlyUsd).toBe(0);
    expect(core.price).toBe('Free');
    expect(core.terms).toEqual(PLANS.free.features);
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

  it('shows the annual checkout overage disclosure under Annual, word for word', async () => {
    const disclosure = await checkoutDisclosure();
    expect(disclosure).toMatch(/billed monthly/);
    const annualCloud = card(await render('annual'), 'cloud').html;
    expect(unescape(annualCloud)).toContain(`<p role="note">${disclosure}</p>`);
  });

  it('does not show the disclosure under Monthly', async () => {
    expect(await render()).not.toContain('role="note"');
    expect(unescape(await render())).not.toContain(await checkoutDisclosure());
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
    expect(metadata.title).toBe(`Pricing: ${BRAND.name}`);
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

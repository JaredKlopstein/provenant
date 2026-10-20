import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  OVERAGE_BUNDLE_PRICE_USD,
  PAYG_BUNDLE_PRICE_USD,
  PLANS,
} from '../../cloud/src/pricing.js';
import { createCheckoutSession, type StripeLike } from '../../cloud/src/billing/stripe.js';
import { BRAND } from '../src/brand.js';
import PricingPage from '../app/pricing/page.js';

/**
 * The pricing page renders every figure from the cloud package's pricing
 * module. Nothing in the site's source carries a price, so a price change is a
 * one-file edit in pricing.ts and this page follows it.
 */

const siteRequire = createRequire(new URL('../package.json', import.meta.url));
const { renderToStaticMarkup } = siteRequire('react-dom/server') as typeof import('react-dom/server');

async function render(billing?: string): Promise<string> {
  const searchParams = Promise.resolve(billing === undefined ? {} : { billing });
  return renderToStaticMarkup(await PricingPage({ searchParams }));
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** The markup of one card, found by its data-plan attribute. */
function card(html: string, id: string): string {
  const match = new RegExp(`<article data-plan="${id}">([\\s\\S]*?)</article>`).exec(html);
  expect(match, `card ${id}`).not.toBeNull();
  return match![1]!;
}

const cloud = PLANS.cloud;

/** Every Cloud term the card must show. Removing one from the page fails this. */
const CLOUD_TERMS = [
  `Continuous anchoring, batched, at most ${cloud.maxAnchorIntervalMinutes} minutes apart`,
  `${cloud.includedBundlesPerMonth} bundles/month, no rollover`,
  `$${OVERAGE_BUNDLE_PRICE_USD} per extra bundle`,
  `${cloud.includedAgentIdentities} agent identities included`,
  `$${cloud.perExtraIdentityUsd}/mo per extra identity`,
  `${cloud.retentionDays}-day retention`,
  `${cloud.fairUseReceiptsPerMonth! / 1_000_000}M receipts/month fair-use cap (not billed)`,
];

async function checkoutDisclosure(): Promise<string> {
  const calls: Array<Record<string, unknown>> = [];
  const stripe: StripeLike = {
    checkout: { sessions: { async create(params) { calls.push(params); return { id: 'cs_test', url: null }; } } },
    billingPortal: { sessions: { async create() { return { url: 'https://portal.test' }; } } },
  };
  await createCheckoutSession(stripe, {
    planId: 'cloud', interval: 'year', priceId: 'price_test_year',
    successUrl: 'https://site.test/ok', cancelUrl: 'https://site.test/no',
  });
  return (calls[0]!.custom_text as { submit: { message: string } }).submit.message;
}

describe('pricing cards', () => {
  it('renders four cards: Core, evidence bundle, Cloud, Enterprise', async () => {
    const html = await render();
    expect([...html.matchAll(/<article data-plan="([a-z]+)">/g)].map((m) => m[1])).toEqual([
      'free', 'bundle', 'cloud', 'enterprise',
    ]);
  });

  it('shows Core as free, under the brand name', async () => {
    const core = card(await render(), 'free');
    expect(PLANS.free.monthlyUsd).toBe(0);
    expect(`${BRAND.name} Core`).toBe(PLANS.free.name);
    expect(core).toContain(`<h2>${BRAND.name} Core</h2>`);
    expect(text(core)).toContain('Free');
    expect(core).not.toMatch(/\$\d/);
    for (const feature of PLANS.free.features) expect(text(core)).toContain(feature);
  });

  it('prices the evidence bundle from PAYG_BUNDLE_PRICE_USD', async () => {
    expect(text(card(await render(), 'bundle'))).toContain(`$${PAYG_BUNDLE_PRICE_USD} each`);
  });

  it('shows the Cloud monthly price with the annual price beside it', async () => {
    const body = text(card(await render(), 'cloud'));
    expect(body).toContain(cloud.name);
    expect(body).toContain(`$${cloud.monthlyUsd}/mo`);
    expect(body).toContain(`$${cloud.annualUsd}/yr`);
  });

  it('shows every Cloud term, and only those', async () => {
    const cloudCard = card(await render(), 'cloud');
    const terms = [...cloudCard.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]!));
    expect(terms).toEqual(CLOUD_TERMS);
  });

  it('shows Enterprise with no dollar figure', async () => {
    const enterprise = card(await render(), 'enterprise');
    expect(PLANS.enterprise.monthlyUsd).toBeNull();
    expect(text(enterprise)).toContain(PLANS.enterprise.name);
    expect(text(enterprise)).toContain('Contact us');
    expect(enterprise).not.toContain('$');
  });

  it('has no Team card or tier anywhere', async () => {
    for (const html of [await render(), await render('annual')]) {
      expect(html).not.toMatch(/\bteam\b/i);
    }
  });
});

describe('billing toggle', () => {
  it('links to both billing views and marks the current one', async () => {
    const monthly = await render();
    expect(monthly).toContain('href="?billing=monthly" aria-current="page"');
    expect(monthly).toContain('href="?billing=annual"');
    const annual = await render('annual');
    expect(annual).toContain('href="?billing=annual" aria-current="page"');
  });

  it('leads the Cloud card with the annual price under the annual toggle', async () => {
    const cloudCard = card(await render('annual'), 'cloud');
    expect(text(cloudCard).indexOf(`$${cloud.annualUsd}/yr`)).toBeLessThan(
      text(cloudCard).indexOf(`$${cloud.monthlyUsd}/mo`),
    );
  });

  it('shows the checkout overage disclosure, word for word, under the annual toggle only', async () => {
    const disclosure = await checkoutDisclosure();
    expect(disclosure).toMatch(/billed monthly/);
    expect(text(await render('annual'))).toContain(disclosure);
    expect(text(await render('monthly'))).not.toContain(disclosure);
    expect(text(await render())).not.toContain(disclosure);
  });

  it('treats an unknown billing value as monthly', async () => {
    expect(await render('weekly')).toBe(await render('monthly'));
  });
});

describe('pricing source', () => {
  const SITE = new URL('../', import.meta.url).pathname;
  const files = [
    ...readdirSync(join(SITE, 'app'), { recursive: true, encoding: 'utf8' }).map((f) => join('app', f)),
    ...readdirSync(join(SITE, 'src'), { recursive: true, encoding: 'utf8' }).map((f) => join('src', f)),
  ].filter((f) => /\.(tsx?|jsx?)$/.test(f));
  const sources = files.map((file) => ({ file, src: readFileSync(join(SITE, file), 'utf8') }));

  it('types no price or plan figure into the site', () => {
    const figures = [
      PAYG_BUNDLE_PRICE_USD, OVERAGE_BUNDLE_PRICE_USD, cloud.monthlyUsd, cloud.annualUsd,
      cloud.includedAgentIdentities, cloud.perExtraIdentityUsd, cloud.retentionDays,
      cloud.maxAnchorIntervalMinutes, cloud.includedBundlesPerMonth, cloud.fairUseReceiptsPerMonth,
    ];
    for (const { file, src } of sources) {
      expect(src, file).not.toMatch(/\$\d/);
      for (const n of figures) {
        expect(src, `${file}: ${n}`).not.toMatch(new RegExp(`(?<![\\w.])${n}(?![\\w])`));
      }
      expect(src, file).not.toMatch(/1_000_000|\b1M\b/);
    }
  });

  it('reads PLANS from the cloud pricing module', () => {
    const plans = sources.find((s) => s.file === join('src', 'plans.ts'))!.src;
    expect(plans).toContain("from '@provenant/cloud/src/pricing'");
  });

  it('never hard-codes the brand name', () => {
    // The npm scope in an import specifier is a package name, not brand text.
    for (const { file, src } of sources.filter((s) => s.file !== join('src', 'brand.ts'))) {
      expect(src.replace(/from '[^']*'/g, ''), file).not.toMatch(new RegExp(BRAND.name, 'i'));
    }
  });
});

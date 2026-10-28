/**
 * The pricing page's cards, built from cloud's pricing module.
 *
 * Every number on the page comes from PLANS and the bundle prices there; none is
 * typed into the site, so a price change in cloud is the only edit a price needs.
 * The import names the compiled module rather than the package root: pricing has
 * no imports of its own, so the page does not pull in the rest of cloud.
 */
import {
  OVERAGE_BUNDLE_PRICE_USD,
  PAYG_BUNDLE_PRICE_USD,
  PLANS,
  type Plan,
} from '@lacre/cloud/dist/pricing.js';
import { BRAND } from './brand';

export type Billing = 'monthly' | 'annual';
export const BILLINGS = ['monthly', 'annual'] as const satisfies readonly Billing[];

/** The query parameter the page's toggle sets: `/pricing?billing=annual`. */
export const BILLING_PARAM = 'billing';

/**
 * Plans checkout refuses and the pricing page shows as Early access. Cloud stays
 * off sale until the hosted collector and continuous anchoring are live: a buyer
 * would otherwise pay for a service they cannot use yet.
 */
export const OFF_SALE_PLANS: ReadonlySet<string> = new Set(['cloud']);

export const EARLY_ACCESS_LABEL = 'Early access';

/** The getting-started guide, on GitHub until the site has its own docs. */
export const GETTING_STARTED_URL = `${BRAND.repository}/blob/main/docs/getting-started.md`;

/** Where an off-sale card's button goes: the waitlist form on the pricing page. */
export const WAITLIST_HREF = '/pricing#waitlist';

export interface CallToAction {
  readonly label: string;
  readonly href: string;
}

export type CardId = 'core' | 'bundle' | 'cloud' | 'enterprise';

export interface PriceCard {
  readonly id: CardId;
  readonly title: string;
  readonly price: string;
  /** A line under the price, such as the annual Cloud saving. */
  readonly priceNote?: string;
  readonly terms: readonly string[];
  /** Off-sale cards: their terms are planned features, and they have no checkout. */
  readonly offSale?: boolean;
  /** The card's one button. Off-sale cards always get the waitlist, never checkout. */
  readonly cta: CallToAction;
}

const ON_SALE_CTAS: Record<CardId, CallToAction> = {
  core: { label: 'Start free', href: GETTING_STARTED_URL },
  bundle: { label: 'Buy a bundle', href: '/checkout' },
  cloud: { label: 'Buy Cloud', href: '/checkout' },
  enterprise: { label: 'Contact the team', href: '/enterprise' },
};

const WAITLIST_CTA: CallToAction = { label: 'Join the waitlist', href: WAITLIST_HREF };

/** A card's button, from its off-sale flag first and its id second. */
export function cardCta(id: CardId, offSale: boolean): CallToAction {
  return offSale ? WAITLIST_CTA : ON_SALE_CTAS[id];
}

function withCta(card: Omit<PriceCard, 'cta'>): PriceCard {
  return { ...card, cta: cardCta(card.id, card.offSale === true) };
}

const usd = (amount: number) => `$${amount}`;

/** 1000000 reads as "1M"; anything that is not whole millions is written out. */
function count(n: number): string {
  const million = 1_000_000;
  return n % million === 0 ? `${n / million}M` : n.toLocaleString('en-US');
}

/** A value the Cloud card cannot render without. Fails the render, not silently. */
function required<T>(value: T | null, field: keyof Plan): T {
  if (value === null) throw new Error(`PLANS.cloud.${field} is null; the Cloud pricing card needs it.`);
  return value;
}

function cloudPrice(plan: Plan, billing: Billing): string {
  return billing === 'annual'
    ? `${usd(required(plan.annualUsd, 'annualUsd'))}/yr`
    : `${usd(required(plan.monthlyUsd, 'monthlyUsd'))}/mo`;
}

/** The Cloud plan's terms, in the order the Pages site lists them. */
export function cloudTerms(plan: Plan = PLANS.cloud): string[] {
  return [
    `Continuous anchoring, batched, at most ${required(plan.maxAnchorIntervalMinutes, 'maxAnchorIntervalMinutes')} minutes apart`,
    `${plan.includedBundlesPerMonth} bundles/month, no rollover`,
    `${usd(OVERAGE_BUNDLE_PRICE_USD)} per extra bundle`,
    `${required(plan.includedAgentIdentities, 'includedAgentIdentities')} agent identities included`,
    `${usd(required(plan.perExtraIdentityUsd, 'perExtraIdentityUsd'))}/mo per extra identity`,
    `${required(plan.retentionDays, 'retentionDays')}-day retention`,
    `${count(required(plan.fairUseReceiptsPerMonth, 'fairUseReceiptsPerMonth'))} receipts/month fair-use cap (not billed)`,
  ];
}

/**
 * The sentence the annual Cloud checkout shows before the customer pays: annual
 * overage bills monthly to the saved card.
 */
export function annualOverageDisclosure(plan: Plan = PLANS.cloud): string {
  return (
    `Evidence bundles over the ${plan.includedBundlesPerMonth} included each month are billed ` +
    `monthly, at ${usd(OVERAGE_BUNDLE_PRICE_USD)} per bundle, to the card saved at this checkout.`
  );
}

/**
 * The pricing page's wording of the same terms, shown under the annual toggle.
 * There is no checkout on that page, so it names the card, not "this checkout".
 */
export function pricingAnnualOverageDisclosure(plan: Plan = PLANS.cloud): string {
  return (
    `Evidence bundles over the ${plan.includedBundlesPerMonth} included each month are charged ` +
    `monthly, at ${usd(OVERAGE_BUNDLE_PRICE_USD)} per bundle, billed to your card.`
  );
}

/**
 * Months an annual Cloud plan saves against twelve monthly payments:
 * (12 × monthly − annual) / monthly, from PLANS rather than typed in.
 */
export function annualSavingsMonths(plan: Plan = PLANS.cloud): number {
  const monthly = required(plan.monthlyUsd, 'monthlyUsd');
  const months = (12 * monthly - required(plan.annualUsd, 'annualUsd')) / monthly;
  return Number(months.toFixed(1));
}

/** Shown under the annual Cloud price: "2 months free against 12 monthly payments". */
export function annualSavingsLine(plan: Plan = PLANS.cloud): string {
  const months = annualSavingsMonths(plan);
  return `${months} ${months === 1 ? 'month' : 'months'} free against 12 monthly payments`;
}

/** What an evidence bundle is, in one line, for the pricing page. */
export const BUNDLE_DEFINITION =
  'An evidence bundle is a signed, timestamped export of a chain range that an auditor verifies offline.';

/**
 * The Core card's terms: the free plan's features without the CLI name, which
 * PLANS carries in parentheses after a feature. The bins are named after the
 * brand, so a parenthetical starting with it stays off the card.
 */
export function coreTerms(plan: Plan = PLANS.free): string[] {
  const prefix = BRAND.name.toLowerCase();
  return plan.features.map((feature) =>
    feature.replace(/\s*\(([^)]*)\)/g, (match, inner: string) =>
      inner.toLowerCase().startsWith(prefix) ? '' : match,
    ),
  );
}

export interface FaqEntry {
  readonly question: string;
  readonly answer: string;
}

/** The pricing page's questions, answered in terms the cards already use. */
export function pricingFaq(plan: Plan = PLANS.cloud): FaqEntry[] {
  return [
    {
      question: 'What is a receipt?',
      answer:
        'A record of one action an agent took, hash-chained to the receipts before it so a later change shows. ' +
        'Writing receipts and verifying them is free on every plan.',
    },
    {
      question: 'What is an evidence bundle?',
      answer: `${BUNDLE_DEFINITION} Your chain head is timestamped by a public RFC 3161 authority.`,
    },
    {
      question: 'What does the receipts/month fair-use cap mean?',
      answer:
        `Cloud lists a ${count(required(plan.fairUseReceiptsPerMonth, 'fairUseReceiptsPerMonth'))} receipts/month ` +
        'fair-use cap. It is not billed: receipts are not charged for. Volume beyond the Cloud fair-use cap is an Enterprise term.',
    },
    {
      question: 'Do I need a subscription to buy an evidence bundle?',
      answer: `No. The evidence bundle is pay as you go, no subscription, at ${usd(PAYG_BUNDLE_PRICE_USD)} each.`,
    },
  ];
}

export function priceCards(billing: Billing): PriceCard[] {
  const { free, cloud, enterprise } = PLANS;
  const cards: Omit<PriceCard, 'cta'>[] = [
    {
      id: 'core',
      // PLANS.free.name carries the product name, which the site takes from BRAND.
      title: `${BRAND.name} Core`,
      price: free.monthlyUsd === 0 ? 'Free' : `${usd(required(free.monthlyUsd, 'monthlyUsd'))}/mo`,
      terms: coreTerms(free),
    },
    {
      id: 'bundle',
      title: 'Evidence bundle',
      price: `${usd(PAYG_BUNDLE_PRICE_USD)} each`,
      terms: [
        'Pay as you go, no subscription',
        'Your chain head timestamped by a public RFC 3161 authority',
        'A self-contained archive an auditor verifies offline',
        'A human-readable report alongside the JSON',
        'The timestamp proves the chain existed when it was anchored, not earlier',
      ],
    },
    {
      id: 'cloud',
      title: cloud.name,
      price: cloudPrice(cloud, billing),
      ...(billing === 'annual' ? { priceNote: annualSavingsLine(cloud) } : {}),
      terms: cloudTerms(cloud),
      offSale: OFF_SALE_PLANS.has(cloud.id),
    },
    {
      id: 'enterprise',
      title: enterprise.name,
      // Enterprise is never priced, matching the checkout routes' "contact us".
      price: 'Contact us',
      terms: [
        'Retention and anchoring cadence set by contract',
        'Volume beyond the Cloud fair-use cap',
        'Terms agreed with you, not listed here',
      ],
    },
  ];
  return cards.map(withCta);
}

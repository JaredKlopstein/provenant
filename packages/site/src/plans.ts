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
} from '@provenant/cloud/dist/pricing.js';
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

export interface PriceCard {
  readonly id: 'core' | 'bundle' | 'cloud' | 'enterprise';
  readonly title: string;
  readonly price: string;
  readonly terms: readonly string[];
  /** Off-sale cards: their terms are planned features, and they have no checkout. */
  readonly offSale?: boolean;
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
 * Shown under the annual toggle. The same sentence the annual Cloud checkout
 * shows before the customer pays: annual overage bills monthly to the saved card.
 */
export function annualOverageDisclosure(plan: Plan = PLANS.cloud): string {
  return (
    `Evidence bundles over the ${plan.includedBundlesPerMonth} included each month are billed ` +
    `monthly, at ${usd(OVERAGE_BUNDLE_PRICE_USD)} per bundle, to the card saved at this checkout.`
  );
}

export function priceCards(billing: Billing): PriceCard[] {
  const { free, cloud, enterprise } = PLANS;
  return [
    {
      id: 'core',
      // PLANS.free.name carries the product name, which the site takes from BRAND.
      title: `${BRAND.name} Core`,
      price: free.monthlyUsd === 0 ? 'Free' : `${usd(required(free.monthlyUsd, 'monthlyUsd'))}/mo`,
      terms: free.features,
    },
    {
      id: 'bundle',
      title: 'Evidence bundle',
      price: `${usd(PAYG_BUNDLE_PRICE_USD)} each`,
      terms: [
        'Pay as you go, no subscription',
        'Your chain head timestamped by a public RFC 3161 authority',
        'A self-contained archive an auditor verifies offline',
        'Human-readable report for the people who will not read JSON',
        'You cannot anchor retroactively, which is the whole point',
      ],
    },
    {
      id: 'cloud',
      title: cloud.name,
      price: cloudPrice(cloud, billing),
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
}

/**
 * The pricing cards, built from the cloud package's pricing module.
 *
 * Every figure here is read from PLANS and the bundle prices; none is typed in.
 * A price change is an edit to pricing.ts alone, and this page follows it.
 * Card copy matches the tiers on the GitHub Pages landing page.
 */
import {
  OVERAGE_BUNDLE_PRICE_USD,
  PAYG_BUNDLE_PRICE_USD,
  PLANS,
} from '@provenant/cloud/src/pricing';
import { BRAND } from './brand';

export type Billing = 'monthly' | 'annual';

export interface PlanCard {
  /** A PLANS id, or `bundle` for the pay-as-you-go evidence bundle. */
  readonly id: 'free' | 'bundle' | 'cloud' | 'enterprise';
  readonly name: string;
  readonly price: string;
  /** The other billing interval's price, shown under the main one. */
  readonly alternative?: string;
  readonly terms: readonly string[];
}

const usd = (amount: number) => `$${amount}`;
const compact = new Intl.NumberFormat('en', { notation: 'compact' });

/** Reads the `billing` search param. Anything but `annual` is monthly. */
export function billingFrom(value: string | string[] | undefined): Billing {
  return value === 'annual' ? 'annual' : 'monthly';
}

/** The sentence annual Cloud checkout shows before payment (#50), word for word. */
export function annualOverageDisclosure(): string {
  return (
    `Evidence bundles over the ${PLANS.cloud.includedBundlesPerMonth} included each month are billed ` +
    `monthly, at ${usd(OVERAGE_BUNDLE_PRICE_USD)} per bundle, to the card saved at this checkout.`
  );
}

export function planCards(billing: Billing): PlanCard[] {
  const { free, cloud, enterprise } = PLANS;
  const monthly = `${usd(cloud.monthlyUsd!)}/mo`;
  const annual = `${usd(cloud.annualUsd!)}/yr`;

  return [
    {
      id: 'free',
      name: `${BRAND.name} Core`,
      price: free.monthlyUsd === 0 ? 'Free' : `${usd(free.monthlyUsd!)}/mo`,
      terms: free.features,
    },
    {
      id: 'bundle',
      name: 'Evidence bundle',
      price: `${usd(PAYG_BUNDLE_PRICE_USD)} each`,
      terms: [
        'Pay as you go, no subscription',
        'Your chain head timestamped by a public RFC 3161 authority',
        'A self-contained archive an auditor verifies offline',
        "Human-readable report for the people who won't read JSON",
        'We hold a copy, so the evidence exists when you need it',
        "You cannot anchor retroactively. That's the whole point.",
      ],
    },
    {
      id: 'cloud',
      name: cloud.name,
      price: billing === 'annual' ? annual : monthly,
      alternative: billing === 'annual' ? `or ${monthly} billed monthly` : `or ${annual} billed annually`,
      terms: [
        `Continuous anchoring, batched, at most ${cloud.maxAnchorIntervalMinutes} minutes apart`,
        `${cloud.includedBundlesPerMonth} bundles/month, no rollover`,
        `${usd(OVERAGE_BUNDLE_PRICE_USD)} per extra bundle`,
        `${cloud.includedAgentIdentities} agent identities included`,
        `${usd(cloud.perExtraIdentityUsd!)}/mo per extra identity`,
        `${cloud.retentionDays}-day retention`,
        `${compact.format(cloud.fairUseReceiptsPerMonth!)} receipts/month fair-use cap (not billed)`,
      ],
    },
    {
      id: 'enterprise',
      name: enterprise.name,
      // Not self-serve: no price is shown anywhere.
      price: 'Contact us',
      terms: [
        'Retention and anchoring cadence set by contract',
        'Volume beyond the Cloud fair-use cap',
        'Terms agreed with you, not listed here',
      ],
    },
  ];
}

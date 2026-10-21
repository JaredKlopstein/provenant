import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '../../src/brand';
import {
  BILLING_PARAM,
  BILLINGS,
  EARLY_ACCESS_LABEL,
  annualOverageDisclosure,
  priceCards,
  type Billing,
} from '../../src/plans';
import { WaitlistForm } from './waitlist-form';

export const metadata: Metadata = {
  title: `Pricing: ${BRAND.name}`,
  description: `${BRAND.name} pricing: Core is free, evidence bundles are priced each, Cloud is in early access, Enterprise is by contract.`,
};

// Every price below comes from src/plans.ts, which reads cloud's pricing module.
// Type no price into this file.
const BILLING_LABELS: Record<Billing, string> = { monthly: 'Monthly', annual: 'Annual' };
const BILLING_HREFS: Record<Billing, string> = {
  monthly: '/pricing',
  annual: `/pricing?${BILLING_PARAM}=annual`,
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function PricingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const billing: Billing = params[BILLING_PARAM] === 'annual' ? 'annual' : 'monthly';

  return (
    <>
      <section>
        <h1>Pricing</h1>
        <p>
          Writing receipts and verifying them stays free on every plan. You pay for evidence a third
          party can check: anchored bundles today, and later Cloud to run the collector and anchoring for
          you.
        </p>
        <nav aria-label="Billing period">
          <ul>
            {BILLINGS.map((b) => (
              <li key={b}>
                <Link href={BILLING_HREFS[b]} aria-current={b === billing ? 'page' : undefined}>
                  {BILLING_LABELS[b]}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </section>
      <section aria-label="Plans">
        {priceCards(billing).map((card) => (
          <article key={card.id} data-tier={card.id}>
            <h2>{card.title}</h2>
            <p>{card.price}</p>
            {card.offSale && (
              <>
                <p data-status="early-access">
                  <strong>{EARLY_ACCESS_LABEL}</strong>: not on sale yet. The hosted collector and continuous
                  anchoring are still being built.
                </p>
                <h3>Planned, not available yet</h3>
              </>
            )}
            <ul>
              {card.terms.map((term) => (
                <li key={term}>{term}</li>
              ))}
            </ul>
            {card.id === 'cloud' && billing === 'annual' && <p role="note">{annualOverageDisclosure()}</p>}
            {card.id === 'cloud' && <WaitlistForm />}
            {card.id === 'enterprise' && (
              <p>
                <Link href="/enterprise">Contact the team</Link>
              </p>
            )}
          </article>
        ))}
      </section>
    </>
  );
}

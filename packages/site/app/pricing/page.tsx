import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '../../src/brand';
import {
  BILLING_PARAM,
  BILLINGS,
  BUNDLE_DEFINITION,
  BUNDLE_FULFILMENT,
  BUNDLE_TODAY_ID,
  EARLY_ACCESS_LABEL,
  priceCards,
  pricingAnnualOverageDisclosure,
  pricingFaq,
  type Billing,
} from '../../src/plans';
import { WaitlistForm } from './waitlist-form';

export const metadata: Metadata = {
  title: 'Pricing',
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
  // A cancelled Stripe checkout returns here with ?checkout=cancelled.
  const cancelled = params.checkout === 'cancelled';

  return (
    <>
      <section>
        <h1>Pricing</h1>
        {cancelled && <p role="status">Checkout cancelled, nothing was charged.</p>}
        <p>
          Writing receipts and verifying them stays free on every plan. You pay for evidence a third
          party can check: anchored bundles today (<a href={`#${BUNDLE_TODAY_ID}`}>how a bundle is made today</a>),
          and later Cloud to run the collector and anchoring for you.
        </p>
        <p data-definition="evidence-bundle">{BUNDLE_DEFINITION}</p>
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
            {card.priceNote && <p data-price-note>{card.priceNote}</p>}
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
            {card.id === 'cloud' && billing === 'annual' && <p role="note">{pricingAnnualOverageDisclosure()}</p>}
            <p>
              <Link href={card.cta.href}>{card.cta.label}</Link>
            </p>
            {card.id === 'cloud' && (
              <div id="waitlist">
                <WaitlistForm />
              </div>
            )}
          </article>
        ))}
      </section>
      <section aria-labelledby={BUNDLE_TODAY_ID}>
        <h2 id={BUNDLE_TODAY_ID}>How a bundle is made today</h2>
        <p>{BUNDLE_FULFILMENT}</p>
      </section>
      <section aria-labelledby="faq">
        <h2 id="faq">Questions</h2>
        <dl>
          {pricingFaq().map((entry) => (
            <div key={entry.question}>
              <dt>{entry.question}</dt>
              <dd>{entry.answer}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}

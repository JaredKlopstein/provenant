import type { Metadata } from 'next';
import { BRAND } from '../../src/brand';
import { annualOverageDisclosure, billingFrom, planCards } from '../../src/plans';

export const metadata: Metadata = {
  title: `Pricing: ${BRAND.name}`,
  description: `${BRAND.name} pricing. Recording and verifying receipts is free; anchoring is paid.`,
};

const TOGGLE = [
  { billing: 'monthly', label: 'Monthly' },
  { billing: 'annual', label: 'Annual' },
] as const;

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const billing = billingFrom((await searchParams).billing);
  const cards = planCards(billing);

  return (
    <>
      <section>
        <h1>Pricing</h1>
        <p>
          Recording receipts and verifying them is free. You pay for anchoring: a timestamp from an
          authority you do not control, which is what turns a log into evidence.
        </p>
        <nav aria-label="Billing interval">
          <ul>
            {TOGGLE.map((option) => (
              <li key={option.billing}>
                <a
                  href={`?billing=${option.billing}`}
                  aria-current={option.billing === billing ? 'page' : undefined}
                >
                  {option.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        {billing === 'annual' ? <p>{annualOverageDisclosure()}</p> : null}
      </section>
      <section aria-label="Plans">
        {cards.map((plan) => (
          <article key={plan.id} data-plan={plan.id}>
            <h2>{plan.name}</h2>
            <p>{plan.price}</p>
            {plan.alternative ? <p>{plan.alternative}</p> : null}
            <ul>
              {plan.terms.map((term) => (
                <li key={term}>{term}</li>
              ))}
            </ul>
          </article>
        ))}
      </section>
    </>
  );
}

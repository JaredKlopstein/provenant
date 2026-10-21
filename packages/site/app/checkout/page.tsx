import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { BRAND } from '../../src/brand';
import { SIGNUP_PATH } from '../../src/auth/email';
import { CHECKOUT_API_PATH, CHECKOUT_OUTCOMES, signedInFromCookie, type CheckoutOutcome } from '../../src/checkout';
import { annualOverageDisclosure, priceCards } from '../../src/plans';

export const metadata: Metadata = {
  title: `Checkout: ${BRAND.name}`,
  description: `Buy the ${BRAND.name} Cloud plan or a single evidence bundle.`,
};

// The checkout route redirects a failed form post back here with ?checkout=<outcome>.
const OUTCOME_MESSAGES: Record<CheckoutOutcome, string> = {
  invalid: 'That choice could not be checked out. Nothing was charged. Pick one of the options below.',
  subscribed: 'This account already has a Cloud subscription. Nothing was charged. Change or cancel it from your account.',
  unavailable: 'Checkout is not open yet. Nothing was charged.',
  failed: 'Checkout could not be started. Nothing was charged. Try again shortly.',
};

type SearchParams = Record<string, string | string[] | undefined>;

// Every price below comes from src/plans.ts, which reads cloud's pricing module.
// Type no price into this file.
const card = (billing: 'monthly' | 'annual', id: 'bundle' | 'cloud') =>
  priceCards(billing).find((c) => c.id === id)!;

const OPTIONS = [
  { id: 'cloud-monthly', title: 'Cloud, monthly', price: card('monthly', 'cloud').price, fields: { plan: 'cloud', interval: 'month' } },
  { id: 'cloud-annual', title: 'Cloud, annual', price: card('annual', 'cloud').price, fields: { plan: 'cloud', interval: 'year' } },
  { id: 'bundle', title: card('monthly', 'bundle').title, price: card('monthly', 'bundle').price, fields: { kind: 'payg_bundle' } },
] as const;

export default async function CheckoutPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const account = await signedInFromCookie((await headers()).get('cookie'));
  if (!account) redirect(`${SIGNUP_PATH}?for=checkout`);

  const { checkout } = await searchParams;
  const outcome = CHECKOUT_OUTCOMES.find((o) => o === checkout);

  return (
    <>
      <section>
        <h1>Checkout</h1>
        <p>
          Choose what to buy. Payment is handled by Stripe, and your purchase is linked to the account you
          are signed in with.
        </p>
        {outcome && <p role="status">{OUTCOME_MESSAGES[outcome]}</p>}
      </section>
      <section aria-label="Options">
        {OPTIONS.map((option) => (
          <article key={option.id} data-option={option.id}>
            <h2>{option.title}</h2>
            <p>{option.price}</p>
            {option.id === 'cloud-annual' && <p role="note">{annualOverageDisclosure()}</p>}
            <form method="post" action={CHECKOUT_API_PATH}>
              {Object.entries(option.fields).map(([name, value]) => (
                <input key={name} type="hidden" name={name} value={value} />
              ))}
              <button type="submit">Continue to payment</button>
            </form>
          </article>
        ))}
        <article data-option="enterprise">
          <h2>Enterprise</h2>
          <p>
            Enterprise is billed by contract, not through checkout. <Link href="/enterprise">Contact the team</Link>.
          </p>
        </article>
      </section>
    </>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { BRAND } from '../../src/brand';
import { SIGNUP_PATH } from '../../src/auth/email';
import { signedInFromCookie } from '../../src/checkout';
import { PORTAL_API_PATH, PORTAL_OUTCOMES, type PortalOutcome } from '../../src/portal';

export const metadata: Metadata = {
  title: `Account: ${BRAND.name}`,
  description: `Manage your ${BRAND.name} plan, payment method and invoices.`,
};

// The portal route redirects a failed form post back here with ?billing=<outcome>.
const OUTCOME_MESSAGES: Record<PortalOutcome, string> = {
  none: 'This account has no billing account yet. Buy a plan or a bundle first.',
  unavailable: 'Billing management is not open yet.',
  failed: 'The billing portal could not be opened. Try again shortly.',
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function AccountPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const account = await signedInFromCookie((await headers()).get('cookie'));
  if (!account) redirect(SIGNUP_PATH);

  const { billing } = await searchParams;
  const outcome = PORTAL_OUTCOMES.find((o) => o === billing);

  return (
    <section>
      <h1>Account</h1>
      <p>
        Change or cancel your plan, update your payment method and download invoices in the billing
        portal, which Stripe runs.
      </p>
      {outcome && (
        <p role="status">
          {OUTCOME_MESSAGES[outcome]}
          {outcome === 'none' && (
            <>
              {' '}
              <Link href="/pricing">See pricing</Link>.
            </>
          )}
        </p>
      )}
      <form method="post" action={PORTAL_API_PATH}>
        <button type="submit">Manage billing</button>
      </form>
    </section>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { BRAND } from '../../src/brand';
import { SIGNUP_PATH } from '../../src/auth/email';
import { AccountBar } from '../../src/account-bar';
import { accountPlan, formatDate, type AccountPlan } from '../../src/account-plan';
import { billingDb } from '../../src/billing-db';
import { signedInFromCookie } from '../../src/checkout';
import { PORTAL_API_PATH, PORTAL_OUTCOMES, type PortalOutcome } from '../../src/portal';

export const metadata: Metadata = {
  title: 'Account',
  description: `Manage your ${BRAND.name} plan, payment method and invoices.`,
};

// The portal route redirects a failed form post back here with ?billing=<outcome>.
const OUTCOME_MESSAGES: Record<PortalOutcome, string> = {
  none: 'This account has no billing account yet. Buy a plan or a bundle first.',
  unavailable: 'Billing management is not open yet.',
  failed: 'The billing portal could not be opened. Try again shortly.',
};

const INTERVALS: Record<AccountPlan['interval'], string> = { month: 'monthly', year: 'annual' };

type SearchParams = Record<string, string | string[] | undefined>;

/** The account's current plan, null when none is recorded yet, or 'unavailable' when the database can't be read. */
async function currentPlan(accountId: string): Promise<AccountPlan | null | 'unavailable'> {
  const db = billingDb();
  if (!db) return 'unavailable';
  try {
    return await accountPlan(db, accountId);
  } catch (err) {
    console.error(`account: could not read the plan (${err instanceof Error ? err.name : 'unknown error'})`);
    return 'unavailable';
  }
}

export default async function AccountPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const account = await signedInFromCookie((await headers()).get('cookie'));
  if (!account) redirect(`${SIGNUP_PATH}?for=account`);

  const { billing } = await searchParams;
  const outcome = PORTAL_OUTCOMES.find((o) => o === billing);
  const plan = await currentPlan(account.accountId);

  return (
    <>
      <AccountBar account={account} />
      <section>
        <h1>Account</h1>
        {account.email && (
          <p>
            Email: <strong>{account.email}</strong>
          </p>
        )}
        <h2>Plan</h2>
        {plan === 'unavailable' ? (
          <p>Plan details are not available right now. Manage billing still opens the billing portal.</p>
        ) : plan === null ? (
          <p>
            No plan recorded for this account yet. A purchase shows here once Stripe confirms it.{' '}
            <Link href="/pricing">See pricing</Link>.
          </p>
        ) : (
          <>
            <p>
              <strong>
                {plan.name}, {INTERVALS[plan.interval]}
              </strong>
            </p>
            {plan.status === 'past_due' ? (
              <p role="status">The latest payment is past due. Update your card in Manage billing.</p>
            ) : (
              plan.renewsAt && (
                <p>
                  Renews on <time dateTime={plan.renewsAt.toISOString().slice(0, 10)}>{formatDate(plan.renewsAt)}</time>.
                </p>
              )
            )}
          </>
        )}
        <h2>Billing</h2>
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
    </>
  );
}

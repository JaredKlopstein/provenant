/**
 * The plan /account shows: the account's current subscription as the Stripe
 * webhook stored it in the billing database. Read-only; the webhook is the only
 * writer. Null before the webhook has recorded one, which /account says plainly.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { billingCustomers, billingSubscriptions } from '@lacre/cloud/dist/billing/schema.js';
import { PLANS, type PlanId } from '@lacre/cloud/dist/pricing.js';
import type { BillingDb } from './billing-db';

/** Stripe statuses of a subscription that is still the customer's plan. Canceled and ended ones are not. */
const CURRENT_STATUSES = ['active', 'trialing', 'past_due'];

export interface AccountPlan {
  /** The plan's display name, from pricing.ts. */
  name: string;
  interval: 'month' | 'year';
  /** Stripe's status, as Stripe names it. */
  status: string;
  /** End of the current period: when it renews. */
  renewsAt: Date | null;
}

export async function accountPlan(db: BillingDb, accountId: string): Promise<AccountPlan | null> {
  const [row] = await db
    .select({
      plan: billingSubscriptions.plan,
      interval: billingSubscriptions.interval,
      status: billingSubscriptions.status,
      renewsAt: billingSubscriptions.currentPeriodEnd,
    })
    .from(billingSubscriptions)
    .innerJoin(billingCustomers, eq(billingCustomers.stripeCustomerId, billingSubscriptions.stripeCustomerId))
    .where(and(eq(billingCustomers.accountId, accountId), inArray(billingSubscriptions.status, CURRENT_STATUSES)))
    .orderBy(desc(billingSubscriptions.currentPeriodEnd))
    .limit(1);
  if (!row || !(row.plan in PLANS) || (row.interval !== 'month' && row.interval !== 'year')) return null;
  return { name: PLANS[row.plan as PlanId].name, interval: row.interval, status: row.status, renewsAt: row.renewsAt };
}

const LONG_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** "22 October 2027", in UTC like the stored period end. */
export function formatDate(date: Date): string {
  return LONG_DATE.format(date);
}

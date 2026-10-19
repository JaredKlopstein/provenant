/**
 * Billing, derived entirely from pricing.ts.
 *
 * Two decisions encoded here, both load-bearing:
 *
 *  1. We bill on RETAINED AGENT IDENTITIES x RETENTION WINDOW, never per
 *     receipt. Receipt metering punishes exactly the chatty, high-volume fleets
 *     we most want writing to us, and makes a customer's bill spike in the month
 *     they have an incident -- the month they most need to be recording
 *     everything. Receipt volume is a fair-use ceiling that starts a
 *     conversation, not a meter that generates an invoice.
 *
 *  2. Anchored export bundles are billed separately per bundle, because each one
 *     maps to a real revenue event on the customer's side (an audit, a security
 *     questionnaire, an incident postmortem). People pay per bundle without
 *     flinching; they resent per-receipt charges.
 *
 * The Stripe client is injected rather than imported so this logic is testable
 * without live keys, and so a self-hoster is never forced to install a payments
 * SDK to run the collector.
 */
import {
  PLANS, PAYG_BUNDLE_PRICE_USD, OVERAGE_BUNDLE_PRICE_USD, monthlyCost, type Plan, type PlanId,
} from '../pricing.js';

/** The slice of Stripe's API we actually use. Injected; see above. */
export interface StripeLike {
  checkout: {
    sessions: {
      create(params: Record<string, unknown>): Promise<{ id: string; url: string | null }>;
    };
  };
  billingPortal: {
    sessions: { create(params: Record<string, unknown>): Promise<{ url: string }> };
  };
}

export interface Usage {
  /** Distinct agent identities retained inside the plan's retention window.
   *  This is THE billable unit. */
  retainedAgentIdentities: number;
  /** Informational only. Never billed; compared against the fair-use ceiling. */
  receiptsThisMonth: number;
  bundlesThisMonth: number;
}

export interface Invoice {
  planId: PlanId;
  baseUsd: number;
  includedIdentities: number | null;
  extraIdentities: number;
  extraIdentitiesUsd: number;
  billableBundles: number;
  bundlesUsd: number;
  totalUsd: number;
  /** True when receipt volume exceeded fair use. Triggers a CONVERSATION, not a
   *  charge -- see the note above. */
  fairUseExceeded: boolean;
  notes: string[];
}

export function computeInvoice(planId: PlanId, usage: Usage): Invoice {
  const plan: Plan = PLANS[planId];
  const notes: string[] = [];

  const base = monthlyCost(planId, usage.retainedAgentIdentities);
  if (base === null) {
    return {
      planId, baseUsd: 0, includedIdentities: plan.includedAgentIdentities, extraIdentities: 0,
      extraIdentitiesUsd: 0, billableBundles: 0, bundlesUsd: 0, totalUsd: 0,
      fairUseExceeded: false,
      notes: [`${plan.name} is not self-serve; billing is handled by contract.`],
    };
  }

  const included = plan.includedAgentIdentities;
  const extra = included === null ? 0 : Math.max(0, usage.retainedAgentIdentities - included);
  const extraUsd = extra * (plan.perExtraIdentityUsd ?? 0);

  // Only this month's usage counts: the allowance is per month on monthly and
  // annual billing alike, and unused bundles never roll over.
  const billableBundles = Number.isFinite(plan.includedBundlesPerMonth)
    ? Math.max(0, usage.bundlesThisMonth - plan.includedBundlesPerMonth)
    : 0;
  // Subscribers pay the overage rate; everyone else buys pay-as-you-go.
  const subscribed = (plan.monthlyUsd ?? 0) > 0;
  const bundlePriceUsd = subscribed ? OVERAGE_BUNDLE_PRICE_USD : PAYG_BUNDLE_PRICE_USD;
  const bundlesUsd = billableBundles * bundlePriceUsd;

  const fairUseExceeded =
    plan.fairUseReceiptsPerMonth !== null && usage.receiptsThisMonth > plan.fairUseReceiptsPerMonth;

  if (fairUseExceeded) {
    notes.push(
      `Receipt volume (${usage.receiptsThisMonth.toLocaleString()}) exceeds the ${plan.name} fair-use ` +
        `ceiling of ${plan.fairUseReceiptsPerMonth!.toLocaleString()}. This is NOT billed. Reach out to ` +
        `discuss the right plan -- we do not meter receipts, because a bill that spikes during an ` +
        `incident is a bill that discourages recording the incident.`,
    );
  }
  if (extra > 0) {
    notes.push(`${extra} agent identit${extra === 1 ? 'y' : 'ies'} beyond the ${included} included.`);
  }
  if (billableBundles > 0) {
    notes.push(
      subscribed
        ? `${billableBundles} evidence bundle(s) beyond the ${plan.includedBundlesPerMonth} included, ` +
            `at $${bundlePriceUsd} each.`
        : `${billableBundles} pay-as-you-go evidence bundle(s) at $${bundlePriceUsd} each.`,
    );
  }

  return {
    planId,
    baseUsd: plan.monthlyUsd ?? 0,
    includedIdentities: included,
    extraIdentities: extra,
    extraIdentitiesUsd: extraUsd,
    billableBundles,
    bundlesUsd,
    totalUsd: (plan.monthlyUsd ?? 0) + extraUsd + bundlesUsd,
    fairUseExceeded,
    notes,
  };
}

export type BillingInterval = 'month' | 'year';

interface CheckoutBase {
  customerEmail?: string;
  /** The Provenant account id, so the webhook can link the new Stripe
   *  customer to it. */
  clientReferenceId?: string;
  successUrl: string;
  cancelUrl: string;
  /** Stripe Price id for what is being bought. */
  priceId: string;
}

/** A Cloud subscription, billed monthly or yearly. */
export interface SubscriptionCheckoutOptions extends CheckoutBase {
  kind?: 'subscription';
  planId: Exclude<PlanId, 'free' | 'enterprise'>;
  interval: BillingInterval;
  /** Optional Price id for metered extra identities. */
  extraIdentityPriceId?: string;
}

/** A single pay-as-you-go evidence bundle, paid once, no subscription. */
export interface BundleCheckoutOptions extends CheckoutBase {
  kind: 'payg_bundle';
}

export type CheckoutOptions = SubscriptionCheckoutOptions | BundleCheckoutOptions;

/**
 * Self-serve checkout. Built first, deliberately: the wedge is developers
 * running agent fleets who can pay with a card, not enterprises with a
 * six-month procurement cycle. SSO, SCIM and an admin console are NOT built on
 * speculation -- they wait until a paying customer asks.
 */
export async function createCheckoutSession(
  stripe: StripeLike,
  opts: CheckoutOptions,
): Promise<{ id: string; url: string | null }> {
  const common = {
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    ...(opts.customerEmail ? { customer_email: opts.customerEmail } : {}),
    ...(opts.clientReferenceId ? { client_reference_id: opts.clientReferenceId } : {}),
  };

  if (opts.kind === 'payg_bundle') {
    const metadata = { provenant_purchase: 'payg_bundle' };
    return stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: opts.priceId, quantity: 1 }],
      // Payment mode creates no customer by default; the webhook credits the
      // bundle to one, and links it to the account.
      customer_creation: 'always',
      ...common,
      metadata,
      payment_intent_data: { metadata },
    });
  }

  const plan: Plan | undefined = PLANS[opts.planId];
  if (!plan || !plan.monthlyUsd) {
    throw new Error(
      `${plan?.name ?? String(opts.planId)} is not available through self-serve checkout. ` +
        `Self-serve checkout sells the Cloud plan only; for Enterprise, contact us.`,
    );
  }
  if (opts.interval !== 'month' && opts.interval !== 'year') {
    throw new Error(`Unknown billing interval "${String(opts.interval)}". Use "month" or "year".`);
  }
  if (opts.interval === 'year' && !plan.annualUsd) {
    throw new Error(`${plan.name} has no annual price. Use interval "month".`);
  }

  const lineItems: Array<Record<string, unknown>> = [{ price: opts.priceId, quantity: 1 }];
  if (opts.extraIdentityPriceId) lineItems.push({ price: opts.extraIdentityPriceId });

  // Annual overage is charged to the card saved here with no further consent
  // step, so the annual checkout has to say so before the customer pays.
  const overageDisclosure =
    opts.interval === 'year'
      ? {
          custom_text: {
            submit: {
              message:
                `Evidence bundles over the ${plan.includedBundlesPerMonth} included each month are billed ` +
                `monthly, at $${OVERAGE_BUNDLE_PRICE_USD} per bundle, to the card saved at this checkout.`,
            },
          },
        }
      : {};

  const metadata = { provenant_plan: opts.planId, provenant_interval: opts.interval };
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: lineItems,
    ...common,
    ...overageDisclosure,
    metadata,
    subscription_data: { metadata },
  });
}

export async function createPortalSession(
  stripe: StripeLike,
  customerId: string,
  returnUrl: string,
): Promise<{ url: string }> {
  return stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
}

/** Meter event name for overage bundles. One event per bundle beyond the
 *  monthly allowance; the meter counts them. */
export const OVERAGE_METER_EVENT = 'provenant_overage_bundle';

/** The product catalog to create in Stripe, generated from pricing.ts so the
 *  two can never disagree. */
export function stripeCatalog(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const plan of Object.values(PLANS)) {
    if (plan.monthlyUsd === null || plan.monthlyUsd === 0) continue;
    const product = { name: `Provenant ${plan.name}`, description: plan.features.join('; ') };
    const planMetadata = {
      plan_id: plan.id, retention_days: plan.retentionDays, anchor_cadence: plan.anchorCadence,
    };
    out.push({
      product,
      price: { unit_amount: plan.monthlyUsd * 100, currency: 'usd', recurring: { interval: 'month' } },
      metadata: { ...planMetadata, billing_interval: 'month' },
    });
    if (plan.annualUsd) {
      out.push({
        product,
        price: { unit_amount: plan.annualUsd * 100, currency: 'usd', recurring: { interval: 'year' } },
        metadata: { ...planMetadata, billing_interval: 'year' },
      });
    }
    if (plan.perExtraIdentityUsd) {
      out.push({
        product: { name: `Provenant ${plan.name} — additional agent identity` },
        price: {
          unit_amount: plan.perExtraIdentityUsd * 100,
          currency: 'usd',
          recurring: { interval: 'month', usage_type: 'licensed' },
        },
        metadata: { plan_id: plan.id, kind: 'extra_identity' },
      });
    }
  }
  // The pay-as-you-go bundle is a one-time payment. The overage bundle is
  // metered: each bundle beyond the allowance is one event on the meter, and
  // Stripe bills the month's count on the subscriber's next invoice.
  out.push({
    product: {
      name: 'Provenant anchored evidence bundle',
      description: 'One signed, externally anchored evidence archive, verifiable offline.',
    },
    price: { unit_amount: PAYG_BUNDLE_PRICE_USD * 100, currency: 'usd' },
    metadata: { kind: 'payg_bundle' },
  });
  out.push({
    product: {
      name: 'Provenant anchored evidence bundle — beyond plan allowance',
      description: 'One evidence bundle beyond the monthly allowance included in a subscription.',
    },
    price: {
      unit_amount: OVERAGE_BUNDLE_PRICE_USD * 100,
      currency: 'usd',
      recurring: { interval: 'month', usage_type: 'metered' },
    },
    meter: {
      event_name: OVERAGE_METER_EVENT,
      display_name: 'Provenant evidence bundles beyond plan allowance',
    },
    metadata: { kind: 'overage_bundle' },
  });
  return out;
}

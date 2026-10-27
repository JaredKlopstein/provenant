/**
 * The annual Cloud checkout must say, before the customer pays, that evidence
 * bundles beyond the monthly allowance are billed monthly to the card saved at
 * that checkout. Annual overage is charged to that card with no further consent
 * step, so this disclosure is the consent.
 *
 * Stripe is the fake below: no network, no secrets.
 */
import { describe, it, expect } from 'vitest';
import { createCheckoutSession, type StripeLike } from '../src/billing/stripe.js';
import { PLANS, OVERAGE_BUNDLE_PRICE_USD } from '../src/pricing.js';

function fakeStripe() {
  const calls: Array<Record<string, unknown>> = [];
  const stripe: StripeLike = {
    checkout: {
      sessions: {
        async create(params) {
          calls.push(params);
          return { id: 'cs_test_disclosure', url: 'https://checkout.stripe.test/cs_test_disclosure' };
        },
      },
    },
    billingPortal: { sessions: { async create() { return { url: 'https://portal.test' }; } } },
  };
  return { stripe, calls };
}

const urls = { successUrl: 'https://lacre.dev/ok', cancelUrl: 'https://lacre.dev/no' };

function submitMessage(params: Record<string, unknown>): string | undefined {
  const customText = params.custom_text as { submit?: { message?: string } } | undefined;
  return customText?.submit?.message;
}

describe('annual checkout overage disclosure', () => {
  it('tells annual Cloud buyers that overage is billed monthly to the card saved here', async () => {
    const { stripe, calls } = fakeStripe();
    await createCheckoutSession(stripe, { planId: 'cloud', interval: 'year', priceId: 'price_cloud_year', ...urls });

    expect(calls).toHaveLength(1);
    const message = submitMessage(calls[0]!);
    expect(message).toBeDefined();
    expect(message).toMatch(/billed monthly/);
    expect(message).toMatch(/card saved at this checkout/);
    expect(message).toContain(`$${OVERAGE_BUNDLE_PRICE_USD}`);
    expect(message).toContain(`${PLANS.cloud.includedBundlesPerMonth} included each month`);
  });

  it('adds no disclosure to the monthly Cloud session', async () => {
    const { stripe, calls } = fakeStripe();
    await createCheckoutSession(stripe, { planId: 'cloud', interval: 'month', priceId: 'price_cloud_month', ...urls });

    expect(calls[0]!.custom_text).toBeUndefined();
  });

  it('adds no disclosure to the pay-as-you-go session', async () => {
    const { stripe, calls } = fakeStripe();
    await createCheckoutSession(stripe, { kind: 'payg_bundle', priceId: 'price_payg_bundle', ...urls });

    expect(calls[0]!.custom_text).toBeUndefined();
  });
});

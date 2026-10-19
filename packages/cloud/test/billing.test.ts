import { describe, it, expect } from 'vitest';
import { computeInvoice, stripeCatalog, createCheckoutSession, type StripeLike } from '../src/billing/stripe.js';
import {
  PLANS, PAYG_BUNDLE_PRICE_USD, OVERAGE_BUNDLE_PRICE_USD, monthlyCost, NEVER_PAYWALLED,
} from '../src/pricing.js';

describe('pricing shape', () => {
  it('keeps the free tier genuinely unlimited', () => {
    // If the funnel is crippled, nobody ever reaches the paywall.
    const free = PLANS.free;
    expect(free.monthlyUsd).toBe(0);
    expect(free.includedAgentIdentities).toBeNull();
    expect(free.fairUseReceiptsPerMonth).toBeNull();
    expect(free.retentionDays).toBeNull();
  });

  it('never paywalls the capabilities that make Provenant worth adopting', () => {
    // Encoded as data so a change that cripples the funnel has to be deliberate.
    expect(NEVER_PAYWALLED).toContain('writing receipts');
    expect(NEVER_PAYWALLED).toContain('local hash chaining');
    expect(NEVER_PAYWALLED).toContain('offline bundle verification (provenant-verify)');
  });

  it('prices the Cloud plan on the confirmed terms', () => {
    const cloud = PLANS.cloud;
    expect(cloud.name).toBe('Cloud');
    expect(cloud.monthlyUsd).toBe(49);
    expect(cloud.annualUsd).toBe(490);
    expect(cloud.includedAgentIdentities).toBe(10);
    expect(cloud.perExtraIdentityUsd).toBe(4);
    expect(cloud.retentionDays).toBe(90);
    expect(cloud.fairUseReceiptsPerMonth).toBe(1_000_000);
    expect(cloud.includedBundlesPerMonth).toBe(5);
    expect(cloud.anchorCadence).toBe('continuous');
    expect(cloud.maxAnchorIntervalMinutes).toBe(15);
  });

  it('lists continuous anchoring on Cloud only, now that the scheduler ships', () => {
    // Backed by packages/cloud/test/anchor-scheduler.test.ts.
    expect(PLANS.cloud.features).toContain('Continuous anchoring (batched, at most 15 minutes)');
    expect(PLANS.free.features.join(' ')).not.toMatch(/continuous|15.minute/i);
    expect(PLANS.enterprise.features.join(' ')).not.toMatch(/continuous|15.minute/i);
  });

  it('shows no Enterprise price', () => {
    expect(PLANS.enterprise.monthlyUsd).toBeNull();
    expect(PLANS.enterprise.annualUsd).toBeNull();
  });

  it('has exactly the free, cloud and enterprise plans', () => {
    expect(Object.keys(PLANS).sort()).toEqual(['cloud', 'enterprise', 'free']);
  });

  it('prices bundles at $15 pay-as-you-go and $10 overage', () => {
    expect(PAYG_BUNDLE_PRICE_USD).toBe(15);
    expect(OVERAGE_BUNDLE_PRICE_USD).toBe(10);
  });

  it('anchors more often as the plan gets more serious', () => {
    expect(PLANS.free.anchorCadence).toBe('none');
    expect(PLANS.cloud.anchorCadence).toBe('continuous');
  });
});

describe('invoicing bills identities, never receipts', () => {
  it('charges nothing extra for a chatty fleet inside its identity count', () => {
    const quiet = computeInvoice('cloud', {
      retainedAgentIdentities: 5, receiptsThisMonth: 1_000, bundlesThisMonth: 0,
    });
    const chatty = computeInvoice('cloud', {
      retainedAgentIdentities: 5, receiptsThisMonth: 900_000, bundlesThisMonth: 0,
    });
    // 900x the receipts, identical bill. This is the whole pricing thesis.
    expect(chatty.totalUsd).toBe(quiet.totalUsd);
    expect(chatty.totalUsd).toBe(PLANS.cloud.monthlyUsd);
  });

  it('flags fair-use overage as a conversation, not a charge', () => {
    const inv = computeInvoice('cloud', {
      retainedAgentIdentities: 5,
      receiptsThisMonth: 1_000_001,
      bundlesThisMonth: 0,
    });
    expect(inv.fairUseExceeded).toBe(true);
    expect(inv.totalUsd).toBe(49); // NOT billed
    expect(inv.notes.join(' ')).toMatch(/NOT billed/);
    expect(inv.notes.join(' ')).toMatch(/discourages recording the incident/);
  });

  it('charges per additional retained identity beyond the included count', () => {
    const inv = computeInvoice('cloud', {
      retainedAgentIdentities: 13, receiptsThisMonth: 0, bundlesThisMonth: 0,
    });
    expect(inv.extraIdentities).toBe(3);
    expect(inv.extraIdentitiesUsd).toBe(12);
    expect(inv.totalUsd).toBe(61);
  });

  it('treats enterprise as contract-billed rather than guessing a number', () => {
    const inv = computeInvoice('enterprise', {
      retainedAgentIdentities: 900, receiptsThisMonth: 1e9, bundlesThisMonth: 40,
    });
    expect(inv.totalUsd).toBe(0);
    expect(inv.notes.join(' ')).toMatch(/not self-serve/);
  });

  it('costs nothing on the free tier no matter the usage', () => {
    expect(monthlyCost('free', 10_000)).toBe(0);
  });
});

describe('bundle billing', () => {
  const cloudMonth = (bundlesThisMonth: number) =>
    computeInvoice('cloud', { retainedAgentIdentities: 2, receiptsThisMonth: 0, bundlesThisMonth });

  it('bills nothing for Cloud bundles inside the 5 included', () => {
    const inv = cloudMonth(5);
    expect(inv.billableBundles).toBe(0);
    expect(inv.bundlesUsd).toBe(0);
  });

  it('bills Cloud bundles beyond the allowance at $10 each', () => {
    const inv = cloudMonth(8);
    expect(inv.billableBundles).toBe(3);
    expect(inv.bundlesUsd).toBe(30);
    expect(inv.totalUsd).toBe(49 + 30);
  });

  it('bills free-tier bundles pay-as-you-go at $15 each', () => {
    const inv = computeInvoice('free', {
      retainedAgentIdentities: 1, receiptsThisMonth: 0, bundlesThisMonth: 2,
    });
    expect(inv.billableBundles).toBe(2);
    expect(inv.bundlesUsd).toBe(30);
    expect(inv.totalUsd).toBe(30);
    expect(inv.notes.join(' ')).toMatch(/pay-as-you-go/);
  });

  it('does not roll unused bundles over to the next month', () => {
    const lastMonth = cloudMonth(2);
    const thisMonth = cloudMonth(8);
    expect(lastMonth.bundlesUsd).toBe(0);
    // Three unused last month do not cover this month's overage.
    expect(thisMonth.bundlesUsd).toBe(30);
  });

  it('applies the monthly allowance on annual billing without pooling', () => {
    // Annual billing still includes 5 per calendar month, not 60 per year.
    expect(cloudMonth(8).bundlesUsd).toBe(30);
    const year = Array.from({ length: 12 }, () => cloudMonth(5));
    expect(year.reduce((sum, inv) => sum + inv.bundlesUsd, 0)).toBe(0);
  });
});

describe('stripe catalog', () => {
  type Entry = Record<string, unknown>;
  const price = (e: Entry) => e.price as { unit_amount: number; recurring?: { interval: string } };
  const meta = (e: Entry) => e.metadata as { plan_id?: string; kind?: string; billing_interval?: string };

  it('has exactly the five purchasable prices, generated from pricing.ts', () => {
    const catalog = stripeCatalog();
    expect(catalog).toHaveLength(5);

    const monthly = catalog.find((c) => meta(c).plan_id === 'cloud' && meta(c).billing_interval === 'month')!;
    expect(price(monthly).unit_amount).toBe(4900);
    expect(price(monthly).recurring?.interval).toBe('month');

    const annual = catalog.find((c) => meta(c).plan_id === 'cloud' && meta(c).billing_interval === 'year')!;
    expect(price(annual).unit_amount).toBe(49000);
    expect(price(annual).recurring?.interval).toBe('year');

    const identity = catalog.find((c) => meta(c).kind === 'extra_identity')!;
    expect(price(identity).unit_amount).toBe(400);
    expect(price(identity).recurring?.interval).toBe('month');

    const payg = catalog.find((c) => meta(c).kind === 'payg_bundle')!;
    expect(price(payg).unit_amount).toBe(1500);
    expect(price(payg).recurring).toBeUndefined();

    const overage = catalog.find((c) => meta(c).kind === 'overage_bundle')!;
    expect(price(overage).unit_amount).toBe(1000);
    // Metered monthly: each bundle beyond the allowance is one meter event.
    expect(price(overage).recurring).toEqual({ interval: 'month', usage_type: 'metered' });
  });

  it('does not list the free or enterprise plans as purchasable products', () => {
    const planIds = stripeCatalog().map((c) => meta(c).plan_id);
    expect(planIds).not.toContain('free');
    expect(planIds).not.toContain('enterprise');
  });
});

describe('self-serve checkout', () => {
  function fakeStripe() {
    const calls: Array<Record<string, unknown>> = [];
    const stripe: StripeLike = {
      checkout: {
        sessions: {
          async create(params) {
            calls.push(params);
            return { id: 'cs_test_1', url: 'https://checkout.stripe.test/cs_test_1' };
          },
        },
      },
      billingPortal: { sessions: { async create() { return { url: 'https://portal.test' }; } } },
    };
    return { stripe, calls };
  }
  const urls = { successUrl: 'https://provenant.dev/ok', cancelUrl: 'https://provenant.dev/no' };

  it.each(['month', 'year'] as const)('creates a Cloud subscription session billed per %s', async (interval) => {
    const { stripe, calls } = fakeStripe();
    const session = await createCheckoutSession(stripe, {
      planId: 'cloud', interval, priceId: `price_cloud_${interval}`, ...urls,
    });

    expect(session.id).toBe('cs_test_1');
    expect(calls[0]!.mode).toBe('subscription');
    expect(calls[0]!.line_items).toEqual([{ price: `price_cloud_${interval}`, quantity: 1 }]);
    expect(calls[0]!.metadata).toEqual({ provenant_plan: 'cloud', provenant_interval: interval });
  });

  it('sells a single pay-as-you-go bundle as a one-time payment', async () => {
    const { stripe, calls } = fakeStripe();
    await createCheckoutSession(stripe, { kind: 'payg_bundle', priceId: 'price_payg_bundle', ...urls });

    expect(calls[0]!.mode).toBe('payment');
    expect(calls[0]!.line_items).toEqual([{ price: 'price_payg_bundle', quantity: 1 }]);
    expect(calls[0]!.subscription_data).toBeUndefined();
    // So the webhook has a customer to credit the bundle to and link.
    expect(calls[0]!.customer_creation).toBe('always');
  });

  it('rejects enterprise and free, which are not self-serve purchases', async () => {
    const { stripe, calls } = fakeStripe();
    for (const planId of ['enterprise', 'free']) {
      await expect(
        createCheckoutSession(stripe, { planId: planId as 'cloud', interval: 'month', priceId: 'price_x', ...urls }),
      ).rejects.toThrow(/not available through self-serve checkout/);
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects an unknown billing interval', async () => {
    const { stripe } = fakeStripe();
    await expect(
      createCheckoutSession(stripe, { planId: 'cloud', interval: 'week' as 'month', priceId: 'price_x', ...urls }),
    ).rejects.toThrow(/Use "month" or "year"/);
  });
});

// (html report tests live in report.test.ts)

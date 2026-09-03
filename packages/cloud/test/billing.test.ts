import { describe, it, expect } from 'vitest';
import { computeInvoice, stripeCatalog, createCheckoutSession, type StripeLike } from '../src/billing/stripe.js';
import { PLANS, BUNDLE_PRICE_USD, monthlyCost, NEVER_PAYWALLED } from '../src/pricing.js';

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

  it("gives Team retention clearing the six-month statutory floor with margin", () => {
    expect(PLANS.team.retentionDays).toBeGreaterThan(365);
    expect(PLANS.starter.retentionDays).toBe(90);
  });

  it('anchors more often as the plan gets more serious', () => {
    expect(PLANS.free.anchorCadence).toBe('none');
    expect(PLANS.starter.anchorCadence).toBe('monthly');
    expect(PLANS.team.anchorCadence).toBe('daily');
  });
});

describe('invoicing bills identities, never receipts', () => {
  it('charges nothing extra for a chatty fleet inside its identity count', () => {
    const quiet = computeInvoice('starter', {
      retainedAgentIdentities: 5, receiptsThisMonth: 1_000, bundlesThisMonth: 0,
    });
    const chatty = computeInvoice('starter', {
      retainedAgentIdentities: 5, receiptsThisMonth: 900_000, bundlesThisMonth: 0,
    });
    // 900x the receipts, identical bill. This is the whole pricing thesis.
    expect(chatty.totalUsd).toBe(quiet.totalUsd);
    expect(chatty.totalUsd).toBe(PLANS.starter.monthlyUsd);
  });

  it('flags fair-use overage as a conversation, not a charge', () => {
    const inv = computeInvoice('starter', {
      retainedAgentIdentities: 5,
      receiptsThisMonth: PLANS.starter.fairUseReceiptsPerMonth! + 1,
      bundlesThisMonth: 0,
    });
    expect(inv.fairUseExceeded).toBe(true);
    expect(inv.totalUsd).toBe(PLANS.starter.monthlyUsd); // NOT billed
    expect(inv.notes.join(' ')).toMatch(/NOT billed/);
    expect(inv.notes.join(' ')).toMatch(/discourages recording the incident/);
  });

  it('charges per additional retained identity beyond the included count', () => {
    const inv = computeInvoice('starter', {
      retainedAgentIdentities: 13, receiptsThisMonth: 0, bundlesThisMonth: 0,
    });
    expect(inv.extraIdentities).toBe(3);
    expect(inv.extraIdentitiesUsd).toBe(3 * PLANS.starter.perExtraIdentityUsd!);
    expect(inv.totalUsd).toBe(PLANS.starter.monthlyUsd! + inv.extraIdentitiesUsd);
  });

  it('bills bundles beyond the included allowance', () => {
    const inv = computeInvoice('starter', {
      retainedAgentIdentities: 2, receiptsThisMonth: 0, bundlesThisMonth: 4,
    });
    expect(inv.billableBundles).toBe(4 - PLANS.starter.includedBundlesPerMonth);
    expect(inv.bundlesUsd).toBe(inv.billableBundles * BUNDLE_PRICE_USD);
  });

  it('never bills bundles on Team, which includes unlimited exports', () => {
    const inv = computeInvoice('team', {
      retainedAgentIdentities: 10, receiptsThisMonth: 0, bundlesThisMonth: 500,
    });
    expect(inv.billableBundles).toBe(0);
    expect(inv.bundlesUsd).toBe(0);
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

describe('stripe catalog', () => {
  it('is generated from pricing.ts so the two cannot disagree', () => {
    const catalog = stripeCatalog();
    const starter = catalog.find(
      (c) => (c.product as { name: string }).name === 'Provenant Starter',
    );
    expect((starter!.price as { unit_amount: number }).unit_amount).toBe(PLANS.starter.monthlyUsd! * 100);

    const bundle = catalog.find((c) => (c.metadata as { kind?: string }).kind === 'bundle');
    expect((bundle!.price as { unit_amount: number }).unit_amount).toBe(BUNDLE_PRICE_USD * 100);
  });

  it('does not list the free plan as a purchasable product', () => {
    expect(stripeCatalog().some((c) => (c.metadata as { plan_id?: string }).plan_id === 'free')).toBe(false);
  });
});

describe('self-serve checkout', () => {
  it('creates a subscription session tagged with the plan', async () => {
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

    const session = await createCheckoutSession(stripe, {
      planId: 'team',
      priceId: 'price_team',
      successUrl: 'https://provenant.dev/ok',
      cancelUrl: 'https://provenant.dev/no',
    });

    expect(session.id).toBe('cs_test_1');
    expect(calls[0]!.mode).toBe('subscription');
    expect((calls[0]!.metadata as { provenant_plan: string }).provenant_plan).toBe('team');
  });
});

// (html report tests live in report.test.ts)

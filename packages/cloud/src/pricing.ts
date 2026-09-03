/**
 * Every pricing number lives here, and only here.
 *
 * These are a HYPOTHESIS TO TEST, not gospel. They are in one file precisely so
 * they can change without a refactor -- if you find yourself editing a price
 * anywhere else, that is a bug.
 *
 * The two load-bearing pricing decisions, and why:
 *
 * 1. We price on RETAINED AGENT IDENTITIES x RETENTION WINDOW, not per receipt.
 *    Receipt-metered pricing punishes exactly the chatty, high-volume fleets we
 *    most want writing to us, and makes a customer's bill unpredictable in the
 *    month they have an incident -- the month they most need to be recording
 *    everything. Receipt volume is a fair-use ceiling, not a meter.
 *
 * 2. Anchored export bundles are charged SEPARATELY, per bundle. Each one maps
 *    to a real revenue event on the customer's side (an audit, a security
 *    questionnaire, an incident postmortem), which is why people pay for them
 *    without flinching.
 */

export type PlanId = 'free' | 'starter' | 'team' | 'enterprise';

export interface Plan {
  id: PlanId;
  name: string;
  /** USD per month. null = not self-serve (Enterprise) or free. */
  monthlyUsd: number | null;
  /** Billable unit: agent identities retained in the window. */
  includedAgentIdentities: number | null;
  /** Additional identity, USD/month, beyond the included count. */
  perExtraIdentityUsd: number | null;
  /** How long receipts are retained. Team's 13 months clears the >=6-month
   *  statutory floor with margin, and covers an annual audit cycle plus lag. */
  retentionDays: number | null;
  anchorCadence: 'none' | 'monthly' | 'daily' | 'custom';
  /** Fair-use ceiling, NOT a meter. Exceeding it starts a conversation, not an
   *  invoice. */
  fairUseReceiptsPerMonth: number | null;
  includedBundlesPerMonth: number;
  features: string[];
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Provenant Core',
    monthlyUsd: 0,
    includedAgentIdentities: null, // unlimited
    perExtraIdentityUsd: null,
    retentionDays: null, // your disk, your rules
    anchorCadence: 'none',
    fairUseReceiptsPerMonth: null, // unlimited
    includedBundlesPerMonth: 0,
    features: [
      'Unlimited receipts and agents, self-hosted',
      'Local hash chain, contracts, leases',
      'CLI + MCP, single-node SQLite',
      'Local verification',
      'MIT licensed, no time limit, no agent cap',
    ],
  },

  starter: {
    id: 'starter',
    name: 'Starter',
    monthlyUsd: 49,
    includedAgentIdentities: 10,
    perExtraIdentityUsd: 4,
    retentionDays: 90,
    anchorCadence: 'monthly',
    fairUseReceiptsPerMonth: 1_000_000,
    includedBundlesPerMonth: 1,
    features: [
      'Managed collector',
      '90-day retention',
      'Monthly RFC 3161 anchoring',
      'Hosted verifier page',
    ],
  },

  team: {
    id: 'team',
    name: 'Team',
    monthlyUsd: 249,
    includedAgentIdentities: 50,
    perExtraIdentityUsd: 3,
    // 13 months: clears the >=6-month statutory floor with margin, and survives
    // an audit that asks for "the last full year".
    retentionDays: 396,
    anchorCadence: 'daily',
    fairUseReceiptsPerMonth: 20_000_000,
    includedBundlesPerMonth: Number.POSITIVE_INFINITY,
    features: [
      'Everything in Starter',
      '13-month retention',
      'Daily anchoring',
      'Unlimited export bundles',
      'Hosted verifier page',
    ],
  },

  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    monthlyUsd: null, // contact sales
    includedAgentIdentities: null,
    perExtraIdentityUsd: null,
    retentionDays: null, // custom
    anchorCadence: 'custom',
    fairUseReceiptsPerMonth: null,
    includedBundlesPerMonth: Number.POSITIVE_INFINITY,
    features: [
      'Custom retention',
      'SSO',
      'On-prem anchor relay',
      'Support SLA',
    ],
  },
};

/**
 * Anchored export bundles, charged per bundle outside the subscription.
 * Priced against the customer's revenue event, not against our compute cost --
 * generating one costs us cents; it unblocks an audit worth far more.
 */
export const BUNDLE_PRICE_USD = 99;

/** What the free tier deliberately does NOT gate. Encoded so a future change
 *  that cripples the funnel has to be explicit rather than incidental. */
export const NEVER_PAYWALLED = [
  'writing receipts',
  'local hash chaining',
  'contract evaluation',
  'leases and fencing tokens',
  'local chain verification',
  'offline bundle verification (provenant-verify)',
] as const;

export function planFor(id: PlanId): Plan {
  return PLANS[id];
}

export function monthlyCost(id: PlanId, agentIdentities: number): number | null {
  const plan = PLANS[id];
  if (plan.monthlyUsd === null) return null;
  if (plan.includedAgentIdentities === null || plan.perExtraIdentityUsd === null) {
    return plan.monthlyUsd;
  }
  const extra = Math.max(0, agentIdentities - plan.includedAgentIdentities);
  return plan.monthlyUsd + extra * plan.perExtraIdentityUsd;
}

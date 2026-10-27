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

export type PlanId = 'free' | 'cloud' | 'enterprise';

export interface Plan {
  id: PlanId;
  name: string;
  /** USD per month. null = not self-serve (Enterprise). */
  monthlyUsd: number | null;
  /** USD per year when billed annually. null = no self-serve annual price. */
  annualUsd: number | null;
  /** Billable unit: agent identities retained in the window. */
  includedAgentIdentities: number | null;
  /** Additional identity, USD/month, beyond the included count. */
  perExtraIdentityUsd: number | null;
  /** How long receipts are retained. */
  retentionDays: number | null;
  anchorCadence: 'none' | 'monthly' | 'daily' | 'continuous' | 'custom';
  /** Longest gap between anchors the plan promises, in minutes. null = no
   *  anchoring (free) or set by contract (Enterprise). */
  maxAnchorIntervalMinutes: number | null;
  /** Fair-use ceiling, NOT a meter. Exceeding it starts a conversation, not an
   *  invoice. */
  fairUseReceiptsPerMonth: number | null;
  /** Bundles included each calendar month. Applies on monthly and annual
   *  billing alike, and unused bundles do NOT roll over. */
  includedBundlesPerMonth: number;
  features: string[];
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Provenant Core',
    monthlyUsd: 0,
    annualUsd: 0,
    includedAgentIdentities: null, // unlimited
    perExtraIdentityUsd: null,
    retentionDays: null, // your disk, your rules
    anchorCadence: 'none',
    maxAnchorIntervalMinutes: null,
    fairUseReceiptsPerMonth: null, // unlimited
    includedBundlesPerMonth: 0,
    // Only list what actually ships today. A pricing sheet advertising features
    // that do not exist is the same defect as a README overclaim, with worse
    // consequences: someone chooses a plan because of it.
    features: [
      'Unlimited receipts and agents, self-hosted',
      'Local hash chain, single-node SQLite',
      'CLI with --json on every command',
      'Local chain verification',
      'Offline evidence-bundle verification (lacre-verify)',
      'MIT licensed, no time limit, no agent cap',
    ],
  },

  cloud: {
    id: 'cloud',
    name: 'Cloud',
    monthlyUsd: 49,
    annualUsd: 490,
    includedAgentIdentities: 10,
    perExtraIdentityUsd: 4,
    retentionDays: 90,
    // A promise of at most 15 minutes between anchors, kept by the batch
    // scheduler in anchor/scheduler.ts, which reads this value as its default.
    anchorCadence: 'continuous',
    maxAnchorIntervalMinutes: 15,
    fairUseReceiptsPerMonth: 1_000_000,
    includedBundlesPerMonth: 5,
    features: [
      'Managed collector',
      '90-day retention',
      'RFC 3161 anchoring',
      'Continuous anchoring (batched, at most 15 minutes)',
      '5 anchored evidence bundles per month',
      'Hosted verifier page',
    ],
  },

  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    monthlyUsd: null, // contact us; no price is shown anywhere
    annualUsd: null,
    includedAgentIdentities: null,
    perExtraIdentityUsd: null,
    retentionDays: null, // custom
    anchorCadence: 'custom',
    maxAnchorIntervalMinutes: null,
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

/*
 * Anchored export bundles, charged per bundle outside the subscription.
 * Priced against the customer's revenue event, not against our compute cost --
 * generating one costs us cents; it unblocks an audit worth far more.
 */

/** One bundle bought on its own, with no subscription (free tier). */
export const PAYG_BUNDLE_PRICE_USD = 15;
/** Each bundle a subscriber exports beyond the month's included allowance. */
export const OVERAGE_BUNDLE_PRICE_USD = 10;

/** What the free tier deliberately does NOT gate. Encoded so a future change
 *  that cripples the funnel has to be explicit rather than incidental. */
export const NEVER_PAYWALLED = [
  'writing receipts',
  'local hash chaining',
  'local chain verification',
  'offline bundle verification (lacre-verify)',
  // Commitments for features not yet built. Listed here so that when contracts
  // (Phase 3) and leases (Phase 4) ship, they ship free -- but they are NOT
  // advertised in `features` until they exist.
  'contract evaluation (when built, Phase 3)',
  'leases and fencing tokens (when built, Phase 4)',
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

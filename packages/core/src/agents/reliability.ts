/**
 * Derived agent reliability.
 *
 * The specified metric is contract-violation rate, lease-expiry rate and
 * approval-escalation rate. Contracts are Phase 3 and leases are Phase 4, so two
 * of those three signals cannot be measured yet.
 *
 * THE DESIGN DECISION THAT MATTERS HERE: an unmeasurable rate is reported as
 * `null` with a stated reason, never as `0`.
 *
 * Reporting 0.0 for contract violations in a system that has no contracts would
 * render a flawless compliance record for an agent nobody has ever checked. That
 * is precisely the kind of flattering, false signal this product exists to
 * prevent -- and it would appear in the incident view a human consults to decide
 * whether to trust a fleet. A null that says "not measurable: no contracts are
 * defined" is less satisfying and far more honest.
 *
 * THE SECOND LIMITATION, stated in the output itself: these rates are derived
 * from receipts the agent chose to write. An agent that silently declines to
 * record its failures will look perfect. Receipts make recorded behaviour
 * tamper-evident; they cannot make unrecorded behaviour visible. Reliability is
 * therefore a signal about self-reported conduct, not a guarantee of conduct --
 * useful for spotting a degrading agent, useless against a deliberately
 * deceptive one.
 */
import { eq, sql, and } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { receipts } from '../db/schema.js';

/** A rate that may be genuinely unmeasurable, distinguished from zero. */
export interface DerivedRate {
  /** 0..1, or null when the signal cannot be measured yet. */
  rate: number | null;
  /** Numerator: events observed. */
  count: number;
  /** Denominator: receipts the rate is computed over. */
  of: number;
  /** Present only when rate is null. Explains why, in plain language. */
  unavailable_reason?: string;
}

export interface AgentReliability {
  agent_id: string;
  /** Total receipts this agent has written. The sample size behind every rate. */
  receipts: number;
  contract_violation_rate: DerivedRate;
  lease_expiry_rate: DerivedRate;
  approval_escalation_rate: DerivedRate;
  /** Outcome mix, which IS measurable today and is the most useful signal now. */
  failure_rate: DerivedRate;
  outcomes: Record<string, number>;
  irreversible_actions: number;
  first_seen: string | null;
  last_seen: string | null;
  /** Stated on every reading, because the caveat travels with the number. */
  caveat: string;
}

const SELF_REPORTED_CAVEAT =
  'Derived from receipts this agent chose to write. An agent that does not record its failures ' +
  'will appear flawless here. Useful for spotting a degrading agent; not evidence against a ' +
  'deliberately deceptive one.';

export function agentReliability(db: Db, agentId: string): AgentReliability {
  const rows = db
    .select({
      outcome: receipts.outcome,
      sideEffect: receipts.sideEffectClass,
      timestamp: receipts.timestamp,
      canonicalJson: receipts.canonicalJson,
    })
    .from(receipts)
    .where(eq(receipts.agentId, agentId))
    .all();

  const total = rows.length;
  const outcomes: Record<string, number> = {};
  let irreversible = 0;
  let denied = 0;
  let escalated = 0;
  let failed = 0;
  let contractGoverned = 0;
  let contractRejected = 0;
  let leaseHeld = 0;
  let leaseExpired = 0;

  for (const r of rows) {
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    if (r.sideEffect === 'irreversible') irreversible++;
    if (r.outcome === 'denied') denied++;
    if (r.outcome === 'escalated') escalated++;
    if (r.outcome === 'failure' || r.outcome === 'timeout') failed++;

    // Read the governance fields from the signed record rather than trusting a
    // column: these are Phase 3/4 fields with no writer yet, so this loop is
    // what will start producing real numbers the moment contracts ship.
    try {
      const parsed = JSON.parse(r.canonicalJson) as {
        provenant?: { contract_id?: string | null; contract_result?: string | null; lease_id?: string | null };
      };
      const p = parsed.provenant;
      if (p?.contract_id) {
        contractGoverned++;
        if (p.contract_result === 'rejected') contractRejected++;
      }
      if (p?.lease_id) {
        leaseHeld++;
        if (p.contract_result === 'expired') leaseExpired++;
      }
    } catch {
      // A receipt that will not parse is a chain-integrity problem, surfaced by
      // chain.verify. It must not take down the reliability view.
    }
  }

  const sorted = [...rows].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const rate = (count: number, of: number, reason: string): DerivedRate =>
    of === 0
      ? { rate: null, count, of, unavailable_reason: reason }
      : { rate: count / of, count, of };

  return {
    agent_id: agentId,
    receipts: total,
    // Measured over receipts a contract actually governed -- not over all
    // receipts, which would dilute the rate toward zero as unrelated traffic grew.
    contract_violation_rate: rate(
      contractRejected,
      contractGoverned,
      'No receipt from this agent was governed by a contract. Contracts are not implemented yet (Phase 3), so this rate is not measurable and is NOT zero.',
    ),
    lease_expiry_rate: rate(
      leaseExpired,
      leaseHeld,
      'This agent has held no leases. Leases and fencing tokens are not implemented yet (Phase 4), so this rate is not measurable and is NOT zero.',
    ),
    approval_escalation_rate: rate(
      escalated,
      total,
      'This agent has written no receipts, so there is nothing to compute a rate over.',
    ),
    failure_rate: rate(
      failed,
      total,
      'This agent has written no receipts, so there is nothing to compute a rate over.',
    ),
    outcomes,
    irreversible_actions: irreversible,
    first_seen: sorted[0]?.timestamp ?? null,
    last_seen: sorted[sorted.length - 1]?.timestamp ?? null,
    caveat: SELF_REPORTED_CAVEAT,
  };
}

/** Cheap per-agent receipt counts, for listing a fleet without N queries. */
export function receiptCounts(db: Db): Map<string, number> {
  const rows = db
    .select({ agentId: receipts.agentId, c: sql<number>`count(*)` })
    .from(receipts)
    .groupBy(receipts.agentId)
    .all();
  return new Map(rows.map((r) => [r.agentId, r.c]));
}

export { and };

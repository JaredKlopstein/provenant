/**
 * Evidence bundle export. A paid capability, and a real revenue event: bundles
 * get generated for audits, security questionnaires and incident postmortems.
 *
 * A bundle is SELF-CONTAINED. Everything needed to check it travels inside it --
 * receipts as their authoritative canonical bytes, the agent key directory, and
 * the anchor proofs -- with exactly one deliberate exception: the trust anchor
 * for the timestamp authority. That has to come from outside, because a bundle
 * that carried its own trust anchor would be vouching for itself.
 *
 * The receipts are exported as their stored canonical_json strings rather than
 * re-serialized objects. Re-serializing would risk a different field order or a
 * different absent-vs-null choice, and the hash would move. Never re-serialize
 * a receipt.
 */
import { asc, gte, lte, and, type SQL } from 'drizzle-orm';
import {
  dbSchema, keyDirectory, chainId, listAnchors, toAnchorRecord, type Db,
} from '@provenant/core';
import { BUNDLE_FORMAT, type Bundle } from '@provenant/verifier';

export interface ExportOptions {
  fromSeq?: number;
  toSeq?: number;
  /** Include a human-readable summary block. Costs nothing and helps a reviewer
   *  who opens the JSON directly. */
  summary?: boolean;
}

export function exportBundle(db: Db, opts: ExportOptions = {}): Bundle {
  const { receipts } = dbSchema;
  const filters: SQL[] = [];
  if (opts.fromSeq !== undefined) filters.push(gte(receipts.seq, opts.fromSeq));
  if (opts.toSeq !== undefined) filters.push(lte(receipts.seq, opts.toSeq));

  const rows = db
    .select({
      seq: receipts.seq,
      canonicalJson: receipts.canonicalJson,
      selfHash: receipts.selfHash,
      agentId: receipts.agentId,
      action: receipts.action,
      outcome: receipts.outcome,
      sideEffectClass: receipts.sideEffectClass,
      timestamp: receipts.timestamp,
    })
    .from(receipts)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(receipts.seq))
    .all();

  const from = rows[0]?.seq ?? 0;
  const to = rows[rows.length - 1]?.seq ?? 0;

  // Include every anchor that commits to a position inside this range. An anchor
  // past the end is useless here (its head cannot be recomputed from these
  // receipts) and including it would only produce a confusing warning.
  const anchorRows = listAnchors(db).filter((a) => a.seq >= from && a.seq <= to);

  const bundle: Bundle = {
    format: BUNDLE_FORMAT,
    chain_id: chainId(db),
    generated_at: new Date().toISOString(),
    range: { from_seq: from, to_seq: to },
    receipts: rows.map((r) => ({
      seq: r.seq,
      canonical_json: r.canonicalJson,
      self_hash: r.selfHash,
    })),
    agents: keyDirectory(db) as unknown as Record<string, unknown>,
    anchors: anchorRows.map(toAnchorRecord) as unknown as Bundle['anchors'],
  };

  if (opts.summary !== false) {
    const byAction = new Map<string, number>();
    const byOutcome = new Map<string, number>();
    let irreversible = 0;
    for (const r of rows) {
      byAction.set(r.action, (byAction.get(r.action) ?? 0) + 1);
      byOutcome.set(r.outcome, (byOutcome.get(r.outcome) ?? 0) + 1);
      if (r.sideEffectClass === 'irreversible') irreversible++;
    }

    const external = anchorRows.filter((a) => a.proofType === 'rfc3161');
    bundle.summary = {
      receipt_count: rows.length,
      agent_count: Object.keys(bundle.agents).length,
      time_range: rows.length
        ? { first: rows[0]!.timestamp, last: rows[rows.length - 1]!.timestamp }
        : null,
      irreversible_actions: irreversible,
      by_action: Object.fromEntries([...byAction].sort((a, b) => b[1] - a[1])),
      by_outcome: Object.fromEntries(byOutcome),
      external_anchors: external.length,
      anchored_through_seq: external.length ? external[external.length - 1]!.seq : null,
      // A convenience note for a human skimming the raw JSON. It is NOT evidence
      // and must not be read as any kind of assertion: `summary` sits outside
      // everything that is hashed, so an operator can rewrite this text freely
      // and the verifier will neither notice nor contradict it. The verifier
      // ignores this field entirely and recomputes its own conclusion.
      unverified_note: external.length
        ? `Claims (UNVERIFIED, recompute with provenant-verify): receipts 0 through ${external[external.length - 1]!.seq} were externally timestamped. Receipts after that position are covered only by this operator's own hash chain.`
        : 'Claims (UNVERIFIED): NOTHING IS EXTERNALLY ANCHORED. Every receipt here would be self-attested. Do not treat this bundle as independent evidence.',
    };
  }

  return bundle;
}

export function bundleToJson(bundle: Bundle): string {
  return JSON.stringify(bundle, null, 2);
}

import { z } from 'zod';
import { defineAction } from '../registry/registry.js';
import type { NextAction } from '../registry/types.js';
import { createAnchor, listAnchors, buildStatement, imprintHex, chainId } from '../anchor/store.js';
import { anchorBackendNames, getAnchorBackend } from '../anchor/types.js';
import '../anchor/noop.js';

export const anchorNowAction = defineAction({
  name: 'anchor.now',
  summary: 'Commit the current chain head to an external timestamp authority',
  sideEffect: 'write',
  description: {
    what: 'Takes the current chain head and asks an external authority to attest that this exact history existed at this moment. Afterwards, altering any receipt at or before that position produces a head that no longer matches the attestation, and the operator cannot forge a replacement.',
    when: 'On a schedule (daily is the common choice), and immediately before exporting an evidence bundle or closing out an incident. Anchor cadence sets the size of the window in which history could still be quietly rewritten.',
    whenNot: 'Not after every receipt -- authorities rate-limit, and an anchor per receipt buys nothing over an anchor per batch, since one anchor covers the entire history before it. Do not rely on the "noop" backend for anything you intend to show a third party; it produces no proof.',
    cost: 'One network round trip to the authority, typically under a second, and one row of local storage. Commercial authorities may bill per request. The "noop" backend costs nothing and is worth nothing.',
    returns: 'The anchor id, the chain position and head hash committed, the backend used, whether the proof is externally verifiable, and the attested time.',
  },
  input: z.object({
    backend: z.string().default('noop')
      .describe('Anchor backend name. The open-source build ships only "noop", which produces no external proof. Real authorities are configured in Provenant Cloud.'),
  }),
  output: z.object({
    anchor_id: z.string(),
    seq: z.number(),
    head_hash: z.string(),
    backend: z.string(),
    is_external: z.boolean(),
    proven_time: z.string().nullable(),
    authority: z.string().nullable(),
    note: z.string(),
  }),
  async handler(input, ctx) {
    const record = await createAnchor(ctx.db, input.backend);
    const backend = getAnchorBackend(input.backend)!;
    return {
      anchor_id: record.id,
      seq: record.statement.seq,
      head_hash: record.statement.head_hash,
      backend: record.backend,
      is_external: backend.isExternal,
      proven_time: record.proof.proven_time ?? null,
      authority: record.proof.authority ?? null,
      note: backend.isExternal
        ? `Anchored to '${record.proof.authority ?? backend.name}' at ${record.proof.proven_time}. Receipts 0-${record.statement.seq} can no longer be altered without breaking this attestation.`
        : `Recorded a '${backend.name}' anchor with NO external proof. This is self-attested and establishes nothing to a third party. Configure a real timestamp authority to make it evidence.`,
    };
  },
  dryRun(input, ctx) {
    const statement = buildStatement(ctx.db);
    const backend = getAnchorBackend(input.backend);
    return {
      anchor_id: '(dry-run)',
      seq: statement?.seq ?? -1,
      head_hash: statement?.head_hash ?? '',
      backend: input.backend,
      is_external: backend?.isExternal ?? false,
      proven_time: null,
      authority: null,
      note: statement
        ? `Would ask '${input.backend}' to timestamp ${imprintHex(statement)} committing to seq ${statement.seq}. Nothing was sent.`
        : 'The chain is empty; there is nothing to anchor.',
    };
  },
  nextActions() {
    return [
      { action: 'chain.verify', arguments: {}, why: 'Confirm the chain verifies against the new anchor.' },
      { action: 'anchor.list', arguments: {}, why: 'See every anchor point and which are real evidence.' },
    ] satisfies NextAction[];
  },
});

export const anchorListAction = defineAction({
  name: 'anchor.list',
  summary: 'List anchor points and say which are real evidence',
  sideEffect: 'read',
  description: {
    what: 'Lists every anchor recorded for this chain, with the position it commits to, the authority that attested it, the attested time, and whether it constitutes external evidence or is merely self-attested.',
    when: 'Before an audit or a security review, to see how far the externally-provable history actually extends and where the unanchored gap begins.',
    whenNot: 'Not for checking chain integrity -- that is chain.verify. An anchor listed here is not proof the chain still matches it; only verification establishes that.',
    cost: 'One indexed local read. No network. Output is small: one row per anchor, not per receipt.',
    returns: 'An array of anchors with seq, head_hash, backend, authority, proven_time and is_external, plus the count of receipts recorded since the most recent anchor.',
  },
  input: z.object({}),
  output: z.object({
    anchors: z.array(z.record(z.string(), z.unknown())),
    count: z.number(),
    chain_id: z.string(),
    unanchored_note: z.string(),
  }),
  handler(_input, ctx) {
    const rows = listAnchors(ctx.db);
    const statement = buildStatement(ctx.db);
    const external = rows.filter((r) => r.proofType === 'rfc3161');
    const lastExternal = external[external.length - 1];
    const headSeq = statement?.seq ?? -1;

    const gap = lastExternal ? headSeq - lastExternal.seq : headSeq + 1;
    return {
      anchors: rows.map((r) => ({
        id: r.id, seq: r.seq, head_hash: r.headHash, backend: r.backend,
        proof_type: r.proofType, authority: r.authority, proven_time: r.provenTime,
        is_external: r.proofType === 'rfc3161', created_at: r.createdAt,
      })),
      count: rows.length,
      chain_id: chainId(ctx.db),
      unanchored_note: lastExternal
        ? `${gap} receipt(s) recorded since the last external anchor at seq ${lastExternal.seq}. Those are not yet externally provable.`
        : `No external anchor exists. The entire chain of ${headSeq + 1} receipt(s) is self-attested and proves nothing to a third party.`,
    };
  },
});

import { z } from 'zod';
import { and, eq, gt, gte, lte, desc, asc, type SQL } from 'drizzle-orm';
import { defineAction } from '../registry/registry.js';
import { receipts } from '../db/schema.js';
import { readHead } from '../chain/append.js';
import { verifyChain, type VerifiableRecord } from '../chain/verify.js';
import { keyDirectory } from '../agents/store.js';
import { DEFAULT_LIMIT, MAX_LIMIT, encodeCursor, decodeCursor, project } from '../pagination.js';

export const chainVerifyAction = defineAction({
  name: 'chain.verify',
  summary: 'Verify local chain integrity and report exactly what broke',
  sideEffect: 'read',
  description: {
    what: 'Recomputes every receipt hash, re-checks every link, and re-verifies every signature against the registered agent keys. Reports the precise receipts that failed and the contiguous ranges that are still provably intact.',
    when: 'After an incident, before exporting evidence, on a schedule, or any time you need to state whether the local record has been altered. Also the fastest way to confirm a restored backup is sound.',
    whenNot: 'This proves the chain is internally consistent. It does NOT prove the operator did not rewrite the whole chain, because a self-hosted chain is self-attested. For evidence a third party should believe, you need external anchoring (Provenant Cloud) plus the standalone verifier.',
    cost: 'Reads and re-hashes every receipt in range: linear in chain length, roughly a second per 100k receipts, no network. Use --from/--to to bound it on a large chain.',
    returns: 'ok, receipts_checked, the current head, a failures array naming each broken receipt with its seq and reason, intact_ranges proving what is still sound, and warnings (such as agent clock skew) that are not integrity failures.',
  },
  input: z.object({
    from_seq: z.number().int().nonnegative().optional().describe('Verify from this chain position onward.'),
    to_seq: z.number().int().nonnegative().optional().describe('Verify up to and including this position.'),
  }),
  // The description tells callers to use --from/--to; those must therefore work.
  aliases: { from: 'from_seq', to: 'to_seq' },
  output: z.object({
    ok: z.boolean(),
    receipts_checked: z.number(),
    head: z.object({ seq: z.number(), self_hash: z.string() }).nullable(),
    failures: z.array(z.record(z.string(), z.unknown())),
    intact_ranges: z.array(z.object({ from_seq: z.number(), to_seq: z.number() })),
    warnings: z.array(z.record(z.string(), z.unknown())),
    anchored: z.boolean(),
    anchor_note: z.string(),
  }),
  handler(input, ctx) {
    const filters: SQL[] = [];
    if (input.from_seq !== undefined) filters.push(gte(receipts.seq, input.from_seq));
    if (input.to_seq !== undefined) filters.push(lte(receipts.seq, input.to_seq));

    const rows = ctx.db
      .select({
        seq: receipts.seq,
        canonical_json: receipts.canonicalJson,
        self_hash: receipts.selfHash,
      })
      .from(receipts)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(receipts.seq))
      .all() as VerifiableRecord[];

    const result = verifyChain(rows, keyDirectory(ctx.db), {
      expectGenesis: input.from_seq === undefined || input.from_seq === 0,
    });

    return {
      ...result,
      failures: result.failures as unknown as Array<Record<string, unknown>>,
      warnings: result.warnings as unknown as Array<Record<string, unknown>>,
      anchored: false,
      // Stated on every single verification, deliberately. An operator who
      // forgets this distinction will overstate what they can prove.
      anchor_note:
        'This chain is self-attested: it proves internal consistency only. An operator with database access could have rewritten the entire history, including this result. External anchoring (Provenant Cloud) is what makes the chain evidence to someone who does not trust the operator.',
    };
  },
  nextActions(_input, output) {
    if (output.ok) {
      return [
        {
          action: 'receipts.query',
          arguments: { limit: 10 },
          why: 'Chain is intact; inspect recent activity.',
        },
      ];
    }
    const first = output.failures[0] as { seq?: number } | undefined;
    return [
      {
        action: 'receipts.query',
        arguments: { from_seq: Math.max(0, (first?.seq ?? 1) - 2), limit: 5 },
        why: `Inspect the receipts around the first failure at seq ${first?.seq}.`,
      },
    ];
  },
});

export const chainHeadAction = defineAction({
  name: 'chain.head',
  summary: 'Return the current chain head',
  sideEffect: 'read',
  description: {
    what: 'Returns the sequence number and hash of the most recent receipt -- the single value that commits to the entire history before it.',
    when: 'To check whether the chain advanced, to compare two replicas cheaply, or to capture the value you intend to anchor.',
    whenNot: 'Not a substitute for chain.verify. A head can be read from a chain that is internally broken; the head alone proves nothing about what precedes it.',
    cost: 'A single indexed row read. Constant time regardless of chain length. Negligible output.',
    returns: 'seq and self_hash of the head receipt, and total receipt count. Null head on an empty chain.',
  },
  input: z.object({}),
  output: z.object({
    head: z.object({ seq: z.number(), self_hash: z.string() }).nullable(),
    count: z.number(),
  }),
  handler(_input, ctx) {
    const head = readHead(ctx.db);
    const count = ctx.db.$client.prepare('SELECT COUNT(*) as c FROM receipts').get() as { c: number };
    return {
      head: head ? { seq: head.seq, self_hash: head.selfHash } : null,
      count: count.c,
    };
  },
});

export const receiptsQueryAction = defineAction({
  name: 'receipts.query',
  summary: 'Query receipts with cursor pagination and field projection',
  sideEffect: 'read',
  description: {
    what: 'Returns receipts filtered by agent, action, session, outcome, time range or chain position, newest first by default, in cursor-paginated pages.',
    when: 'During incident review to reconstruct what an agent did, to confirm a specific action was recorded, or to page through a range you are about to export.',
    whenNot: 'Do not use it to poll for your own just-written receipt -- `record` already returned it. Do not fetch full receipts when you only need a count or a field; pass --fields to cut the response.',
    cost: 'One indexed read per page. The response is the expensive part: a full receipt is roughly 600 bytes of your context window, so a 500-row page can cost 300KB. Default limit is 25 and depth is summary for that reason.',
    returns: 'items (projected receipts), truncated, and next_cursor when more rows exist. Pass next_cursor back verbatim to continue.',
  },
  input: z.object({
    agent_id: z.string().optional(),
    action: z.string().optional().describe('Exact action name match, e.g. "refund.issue".'),
    session_id: z.string().optional(),
    outcome: z.string().optional(),
    record_id: z.string().optional(),
    since: z.string().optional().describe('RFC 3339 lower bound on the agent-reported timestamp.'),
    until: z.string().optional().describe('RFC 3339 upper bound.'),
    from_seq: z.number().int().nonnegative().optional(),
    to_seq: z.number().int().nonnegative().optional().describe('Upper bound on chain position.'),
    limit: z.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
    cursor: z.string().optional().describe('Opaque; pass back verbatim from next_cursor.'),
    fields: z.array(z.string()).optional()
      .describe('Projection allowlist, e.g. ["seq","action","outcome"]. Strongly recommended: it is the cheapest way to cut response size.'),
    depth: z.enum(['summary', 'full']).default('summary')
      .describe('summary returns indexed columns only; full also returns the complete signed receipt (much larger).'),
    order: z.enum(['asc', 'desc']).default('desc'),
  }),
  // The brief's spelling (`--agent`, `--since`, `--from`) must work, not error.
  // Unknown flags are rejected now, so the shorthands have to be real.
  aliases: {
    agent: 'agent_id',
    from: 'from_seq',
    to: 'to_seq',
    until: 'until',
    limit: 'limit',
  },
  output: z.object({
    items: z.array(z.record(z.string(), z.unknown())),
    truncated: z.boolean(),
    next_cursor: z.string().optional(),
  }),
  handler(input, ctx) {
    const filters: SQL[] = [];
    if (input.agent_id) filters.push(eq(receipts.agentId, input.agent_id));
    if (input.action) filters.push(eq(receipts.action, input.action));
    if (input.session_id) filters.push(eq(receipts.sessionId, input.session_id));
    if (input.outcome) filters.push(eq(receipts.outcome, input.outcome));
    if (input.record_id) filters.push(eq(receipts.recordId, input.record_id));
    if (input.since) filters.push(gte(receipts.timestamp, input.since));
    if (input.until) filters.push(lte(receipts.timestamp, input.until));
    if (input.from_seq !== undefined) filters.push(gte(receipts.seq, input.from_seq));
    if (input.to_seq !== undefined) filters.push(lte(receipts.seq, input.to_seq));
    if (input.cursor) {
      const seq = decodeCursor(input.cursor);
      filters.push(input.order === 'desc' ? lte(receipts.seq, seq) : gte(receipts.seq, seq));
    }

    // Fetch one extra row to determine truncation without a second COUNT query.
    const rows = ctx.db
      .select()
      .from(receipts)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(input.order === 'desc' ? desc(receipts.seq) : asc(receipts.seq))
      .limit(input.limit + 1)
      .all();

    const truncated = rows.length > input.limit;
    const page = truncated ? rows.slice(0, input.limit) : rows;

    const items = page.map((r) => {
      const base: Record<string, unknown> = {
        seq: r.seq,
        record_id: r.recordId,
        agent_id: r.agentId,
        session_id: r.sessionId,
        timestamp: r.timestamp,
        action: r.action,
        action_type: r.actionType,
        outcome: r.outcome,
        side_effect_class: r.sideEffectClass,
        self_hash: r.selfHash,
        prev_hash: r.prevHash,
      };
      if (input.depth === 'full') base.receipt = JSON.parse(r.canonicalJson);
      return project(base, input.fields);
    });

    const last = page[page.length - 1];
    return {
      items,
      truncated,
      ...(truncated && last
        ? { next_cursor: encodeCursor(input.order === 'desc' ? last.seq - 1 : last.seq + 1) }
        : {}),
    };
  },
  nextActions(input, output) {
    const next = [];
    if (output.next_cursor) {
      next.push({
        action: 'receipts.query',
        arguments: { ...input, cursor: output.next_cursor },
        why: 'More receipts match. This call is ready to execute as-is.',
      });
    }
    next.push({ action: 'chain.verify', arguments: {}, why: 'Confirm these receipts are unaltered.' });
    return next;
  },
});

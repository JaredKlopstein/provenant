import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { defineAction } from '../registry/registry.js';
import type { NextAction } from '../registry/types.js';
import { appendReceipt, readHead, nowRfc3339 } from '../chain/append.js';
import { requireAgent } from '../agents/store.js';
import { deriveAgentId } from '../crypto/keys.js';
import { signReceipt, receiptHash, payloadHash } from '../receipt/hash.js';
import {
  ActionType,
  Outcome,
  SideEffectClass,
  UnsignedReceipt,
  PROVENANT_RECEIPT_VERSION,
  type Receipt,
  type TrustLevel,
} from '../receipt/schema.js';

const RecordInput = z.object({
  action: z.string().min(1).max(200)
    .describe('Fully-qualified name of the action taken, e.g. "refund.issue". Use a stable dotted name so receipts group across runs.'),
  action_detail: z.record(z.string(), z.unknown()).default({})
    .describe('Structured facts about this specific action. Keep it small: it is hashed and stored forever.'),
  side_effect_class: SideEffectClass.default('write')
    .describe('read = no external effect; write = reversible effect; irreversible = money moved, email sent, data deleted.'),
  outcome: Outcome.default('success')
    .describe('success | failure | timeout | denied | escalated.'),
  action_type: ActionType.default('tool_call')
    .describe('AAT record class. tool_call for an action you took, decision for a choice you made, delegation for work handed to another agent.'),
  input: z.unknown().optional()
    .describe('The action inputs. Hashed to input_hash; the raw value is NOT stored.'),
  output: z.unknown().optional()
    .describe('The action outputs. Hashed to output_hash; the raw value is NOT stored.'),
  idempotency_key: z.string().min(1).max(255).optional()
    .describe('Replay guard. Recording twice with the same key returns the ORIGINAL receipt instead of writing a second one.'),
  parent_record_id: z.string().optional()
    .describe('record_id of the receipt this action descends from, for causal chains.'),
  model_id: z.string().optional().describe('Model that decided on this action.'),
  risk_score: z.number().min(0).max(1).optional().describe('Caller-assessed risk, 0 to 1.'),
  latency_ms: z.number().int().nonnegative().optional().describe('How long the action took.'),
  session_id: z.string().optional().describe('Overrides the process session id.'),
  agent_id: z.string().optional().describe('Defaults to this machine keypair identity.'),
});

const RecordOutput = z.object({
  receipt: z.record(z.string(), z.unknown()),
  seq: z.number(),
  self_hash: z.string(),
  prev_hash: z.string().nullable(),
  replayed: z.boolean(),
  dry_run: z.boolean().optional(),
});

export const recordAction = defineAction({
  name: 'record',
  summary: 'Write a tamper-evident receipt for a consequential action',
  sideEffect: 'write',
  description: {
    what: 'Appends a signed, hash-chained receipt describing one action you took. The receipt links to the previous receipt, so any later edit to it or to anything after it becomes detectable.',
    when: 'Immediately after any action with a consequence someone could later question: money moved, a message sent, a record changed, a decision made on a user\'s behalf. Record it whether it succeeded or failed -- a receipt for a failure is worth as much as one for a success.',
    whenNot: 'Do not record pure reads, retries of an already-recorded action (pass idempotency_key instead), or internal reasoning steps with no external effect. Recording noise makes the incident view useless and burns retention.',
    cost: 'One local disk write, roughly a millisecond, no network. Receipts are permanent and never deleted, so a chatty agent inflates the store and the audit surface. Raw input and output are hashed, not stored, so recording large payloads is cheap.',
    returns: 'The full receipt, its chain position (seq), self_hash, prev_hash, and whether an idempotency key caused a replay of an earlier receipt rather than a new write.',
  },
  input: RecordInput,
  output: RecordOutput,
  handler(input, ctx) {
    const kp = ctx.identity();
    const agentId = input.agent_id ?? deriveAgentId(kp.publicKey);
    const agent = requireAgent(ctx.db, agentId);

    const res = appendReceipt(ctx.db, {
      agentId,
      agentVersion: agent.agentVersion,
      trustLevel: agent.trustLevel as TrustLevel,
      keyId: kp.keyId,
      secretKey: kp.secretKey,
      action: input.action,
      actionType: input.action_type,
      actionDetail: input.action_detail,
      sideEffectClass: input.side_effect_class,
      outcome: input.outcome,
      sessionId: input.session_id ?? ctx.sessionId,
      parentRecordId: input.parent_record_id ?? null,
      ...(input.input !== undefined ? { input: input.input } : {}),
      ...(input.output !== undefined ? { output: input.output } : {}),
      ...(input.model_id !== undefined ? { modelId: input.model_id } : {}),
      ...(input.risk_score !== undefined ? { riskScore: input.risk_score } : {}),
      ...(input.latency_ms !== undefined ? { latencyMs: input.latency_ms } : {}),
      ...(input.idempotency_key !== undefined ? { idempotencyKey: input.idempotency_key } : {}),
    });

    return {
      receipt: res.receipt as unknown as Record<string, unknown>,
      seq: res.seq,
      self_hash: res.selfHash,
      prev_hash: res.receipt.prev_hash,
      replayed: res.replayed,
    };
  },

  /**
   * Design law 7: the dry run returns the EXACT receipt that would be written,
   * signed and hashed, while applying nothing. An agent can inspect precisely
   * what it is about to commit to -- which matters most for `irreversible`.
   */
  dryRun(input, ctx) {
    const kp = ctx.identity();
    const agentId = input.agent_id ?? deriveAgentId(kp.publicKey);
    const agent = requireAgent(ctx.db, agentId);
    const head = readHead(ctx.db);
    const seq = head ? head.seq + 1 : 0;

    const unsigned = UnsignedReceipt.parse({
      record_id: randomUUID(),
      timestamp: nowRfc3339(),
      agent_id: agentId,
      agent_version: agent.agentVersion,
      session_id: input.session_id ?? ctx.sessionId,
      action_type: input.action_type,
      action_detail: input.action_detail,
      outcome: input.outcome,
      trust_level: agent.trustLevel,
      parent_record_id: input.parent_record_id ?? null,
      prev_hash: head ? head.selfHash : null,
      ...(input.input !== undefined ? { input_hash: payloadHash(input.input) } : {}),
      ...(input.output !== undefined ? { output_hash: payloadHash(input.output) } : {}),
      ...(input.model_id !== undefined ? { model_id: input.model_id } : {}),
      ...(input.risk_score !== undefined ? { risk_score: input.risk_score } : {}),
      ...(input.latency_ms !== undefined ? { latency_ms: input.latency_ms } : {}),
      provenant: {
        v: PROVENANT_RECEIPT_VERSION,
        action: input.action,
        side_effect_class: input.side_effect_class,
        seq,
        signature_alg: 'ed25519',
        key_id: kp.keyId,
        ...(input.idempotency_key !== undefined ? { idempotency_key: input.idempotency_key } : {}),
      },
    });

    const receipt: Receipt = signReceipt(unsigned, kp.secretKey);
    return {
      receipt: receipt as unknown as Record<string, unknown>,
      seq,
      self_hash: receiptHash(receipt),
      prev_hash: receipt.prev_hash,
      replayed: false,
      dry_run: true,
    };
  },

  nextActions(input, output) {
    const next: NextAction[] = [
      {
        action: 'chain.verify',
        arguments: {},
        why: 'Confirm the chain still verifies after this write.',
      },
      {
        action: 'receipts.query',
        arguments: { action: input.action, limit: 10 },
        why: `See recent receipts for '${input.action}'.`,
      },
    ];
    if (output.replayed) {
      next.unshift({
        action: 'receipts.query',
        arguments: { record_id: (output.receipt as { record_id: string }).record_id },
        why: 'This call replayed an existing receipt; nothing new was written.',
      });
    }
    return next;
  },

  examples: [
    {
      description: 'An irreversible action worth a receipt',
      arguments: {
        action: 'refund.issue',
        action_detail: { customer_id: 'c_8812', amount_usd: 42.5, reason: 'damaged item' },
        side_effect_class: 'irreversible',
        outcome: 'success',
        idempotency_key: 'refund-c_8812-order-5521',
      },
    },
    {
      description: 'Recording a failure, which matters as much as a success',
      arguments: {
        action: 'email.send',
        action_detail: { to: 'user@example.com', template: 'password_reset' },
        side_effect_class: 'write',
        outcome: 'failure',
      },
    },
  ],
});

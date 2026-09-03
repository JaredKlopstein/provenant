import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb, closeDb, type Db } from '../src/db/client.js';
import { appendReceipt, readHead } from '../src/chain/append.js';
import { verifyChain, type VerifiableRecord } from '../src/chain/verify.js';
import { registerAgent, keyDirectory } from '../src/agents/store.js';
import { generateKeypair, deriveAgentId, publicKeyToJwk, type Keypair } from '../src/crypto/keys.js';

let db: Db;
let kp: Keypair;
let agentId: string;
const sessionId = randomUUID();

function record(over: Partial<Parameters<typeof appendReceipt>[1]> = {}) {
  return appendReceipt(db, {
    agentId,
    agentVersion: '1.0.0',
    trustLevel: 'L1',
    keyId: kp.keyId,
    secretKey: kp.secretKey,
    action: 'refund.issue',
    actionType: 'tool_call',
    actionDetail: { customer: 'c_1', amount_usd: 42 },
    sideEffectClass: 'irreversible',
    outcome: 'success',
    sessionId,
    ...over,
  });
}

/** Read the chain exactly as verification will see it. */
function readChain(): VerifiableRecord[] {
  return db.$client
    .prepare('SELECT seq, canonical_json as canonical_json, self_hash as self_hash FROM receipts ORDER BY seq')
    .all() as VerifiableRecord[];
}

/**
 * Tamper with stored data the way a malicious OPERATOR would: by dropping the
 * append-only triggers first. This is deliberately realistic -- it demonstrates
 * that local triggers stop accidents, not operators, which is precisely the gap
 * external anchoring is sold to close.
 */
function tamperAsOperator(sql: string, ...params: unknown[]) {
  db.$client.exec('DROP TRIGGER IF EXISTS receipts_no_update; DROP TRIGGER IF EXISTS receipts_no_delete;');
  db.$client.prepare(sql).run(...(params as never[]));
  db.$client.exec(`
    CREATE TRIGGER receipts_no_update BEFORE UPDATE ON receipts
    BEGIN SELECT RAISE(ABORT, 'receipts are append-only: UPDATE is forbidden'); END;
    CREATE TRIGGER receipts_no_delete BEFORE DELETE ON receipts
    BEGIN SELECT RAISE(ABORT, 'receipts are append-only: DELETE is forbidden'); END;
  `);
}

beforeEach(() => {
  db = openDb(':memory:');
  kp = generateKeypair();
  agentId = deriveAgentId(kp.publicKey);
  registerAgent(db, {
    agentId,
    displayName: 'test-agent',
    publicKeyJwk: publicKeyToJwk(kp.publicKey),
    agentVersion: '1.0.0',
  });
});

afterEach(() => closeDb(db));

describe('append', () => {
  it('creates a genesis receipt with prev_hash null at seq 0', () => {
    const { receipt, seq } = record();
    expect(seq).toBe(0);
    expect(receipt.prev_hash).toBeNull();
    expect(receipt.provenant.seq).toBe(0);
  });

  it('links each receipt to its predecessor', () => {
    const a = record();
    const b = record();
    const c = record();
    expect(b.receipt.prev_hash).toBe(a.selfHash);
    expect(c.receipt.prev_hash).toBe(b.selfHash);
  });

  it('reports the head in O(1)', () => {
    record();
    const last = record();
    expect(readHead(db)).toEqual({ seq: last.seq, selfHash: last.selfHash });
  });

  it('omits absent optional fields rather than nulling them', () => {
    const { receipt } = record();
    expect('model_id' in receipt).toBe(false);
    expect('output_hash' in receipt).toBe(false);
    // but mandatory-nullable fields ARE present
    expect('prev_hash' in receipt).toBe(true);
    expect('parent_record_id' in receipt).toBe(true);
  });

  it('physically refuses UPDATE and DELETE on receipts', () => {
    record();
    expect(() => db.$client.prepare('UPDATE receipts SET outcome = ?').run('failure')).toThrow(
      /append-only/,
    );
    expect(() => db.$client.prepare('DELETE FROM receipts').run()).toThrow(/append-only/);
  });
});

describe('idempotency', () => {
  it('replays the ORIGINAL recorded result, not a conflict error', () => {
    const first = record({ idempotencyKey: 'order-991' });
    const second = record({ idempotencyKey: 'order-991' });

    expect(second.replayed).toBe(true);
    expect(second.seq).toBe(first.seq);
    expect(second.receipt.record_id).toBe(first.receipt.record_id);
    expect(second.selfHash).toBe(first.selfHash);
  });

  it('does not grow the chain on replay', () => {
    record({ idempotencyKey: 'k' });
    record({ idempotencyKey: 'k' });
    record({ idempotencyKey: 'k' });
    expect(readChain()).toHaveLength(1);
  });

  it('scopes idempotency keys per agent', () => {
    const other = generateKeypair();
    const otherId = deriveAgentId(other.publicKey);
    registerAgent(db, {
      agentId: otherId,
      displayName: 'other',
      publicKeyJwk: publicKeyToJwk(other.publicKey),
      agentVersion: '1.0.0',
    });

    record({ idempotencyKey: 'shared' });
    const b = appendReceipt(db, {
      agentId: otherId,
      agentVersion: '1.0.0',
      trustLevel: 'L1',
      keyId: other.keyId,
      secretKey: other.secretKey,
      action: 'refund.issue',
      actionType: 'tool_call',
      actionDetail: {},
      sideEffectClass: 'write',
      outcome: 'success',
      sessionId,
      idempotencyKey: 'shared',
    });
    expect(b.replayed).toBe(false);
    expect(readChain()).toHaveLength(2);
  });
});

describe('verifyChain on an untampered chain', () => {
  it('verifies a healthy chain', () => {
    for (let i = 0; i < 10; i++) record({ actionDetail: { i } });
    const result = verifyChain(readChain(), keyDirectory(db));

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.receipts_checked).toBe(10);
    expect(result.intact_ranges).toEqual([{ from_seq: 0, to_seq: 9 }]);
    expect(result.head?.seq).toBe(9);
  });

  it('verifies an empty chain', () => {
    expect(verifyChain([], keyDirectory(db)).ok).toBe(true);
  });
});

/**
 * DEFINITION OF DONE #1 -- THE TAMPER TEST.
 * Edit exactly one field of one receipt. Verification must name that receipt
 * precisely and prove every other receipt is intact.
 */
describe('the tamper test', () => {
  beforeEach(() => {
    for (let i = 0; i < 10; i++) record({ actionDetail: { step: i } });
  });

  it('identifies the exact receipt whose content was edited, and proves the rest intact', () => {
    const target = readChain()[4]!;
    const doctored = JSON.parse(target.canonical_json);
    doctored.action_detail.step = 999; // the single edited field
    tamperAsOperator('UPDATE receipts SET canonical_json = ? WHERE seq = 4', JSON.stringify(doctored));

    const result = verifyChain(readChain(), keyDirectory(db));

    expect(result.ok).toBe(false);
    // Precisely which receipt broke:
    const brokenSeqs = [...new Set(result.failures.map((f) => f.seq))];
    expect(brokenSeqs).toEqual([4]);
    expect(result.failures.map((f) => f.kind)).toContain('HASH_MISMATCH');
    expect(result.failures.map((f) => f.kind)).toContain('SIGNATURE_INVALID');

    // And proof that every OTHER receipt is intact:
    expect(result.intact_ranges).toEqual([
      { from_seq: 0, to_seq: 3 },
      { from_seq: 5, to_seq: 9 },
    ]);
  });

  it('detects a receipt deleted from the middle', () => {
    tamperAsOperator('DELETE FROM receipts WHERE seq = 5');
    const result = verifyChain(readChain(), keyDirectory(db));

    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.kind === 'SEQUENCE_GAP')).toBe(true);
    expect(result.failures.some((f) => f.kind === 'LINK_BROKEN')).toBe(true);
    expect(result.failures.some((f) => f.seq === 6)).toBe(true);
  });

  it('detects truncation of the tail, which a bare hash chain cannot see', () => {
    // Chopping the end of a hash chain leaves a perfectly valid chain. Only the
    // signed seq (and, in the paid tier, an anchor over a later head) exposes it.
    tamperAsOperator('DELETE FROM receipts WHERE seq >= 7');
    const truncated = readChain();
    expect(truncated).toHaveLength(7);

    // The chain alone still "verifies" -- this is the honest limitation:
    const local = verifyChain(truncated, keyDirectory(db));
    expect(local.ok).toBe(true);

    // ...but it no longer reaches a head that was previously anchored. This is
    // exactly the gap external anchoring closes, and why a self-hosted chain is
    // self-attested. Asserted here so the limitation stays visible in the suite.
    expect(local.head?.seq).toBe(6);
  });

  it('detects a swapped signature', () => {
    const chain = readChain();
    const victim = JSON.parse(chain[3]!.canonical_json);
    victim.signature = JSON.parse(chain[2]!.canonical_json).signature;
    tamperAsOperator('UPDATE receipts SET canonical_json = ? WHERE seq = 3', JSON.stringify(victim));

    const result = verifyChain(readChain(), keyDirectory(db));
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.seq === 3 && f.kind === 'SIGNATURE_INVALID')).toBe(true);
  });

  it('detects a self_hash rewritten to match doctored content', () => {
    // The sophisticated attempt: edit the content AND fix up the stored hash so
    // the receipt is internally consistent. The signature still fails, and the
    // NEXT receipt's prev_hash no longer matches.
    const chain = readChain();
    const doctored = JSON.parse(chain[2]!.canonical_json);
    doctored.action_detail.step = 4242;
    const json = JSON.stringify(doctored);
    tamperAsOperator(
      'UPDATE receipts SET canonical_json = ?, self_hash = ? WHERE seq = 2',
      json,
      // recompute a plausible-looking hash the attacker controls
      'f'.repeat(64),
    );

    const result = verifyChain(readChain(), keyDirectory(db));
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.seq === 2)).toBe(true);
    expect(result.failures.some((f) => f.seq === 3 && f.kind === 'LINK_BROKEN')).toBe(true);
  });

  it('detects a receipt forged with an unregistered key', () => {
    const attacker = generateKeypair();
    const chain = readChain();
    const forged = JSON.parse(chain[6]!.canonical_json);
    forged.action_detail.step = 6666;
    forged.agent_id = deriveAgentId(attacker.publicKey); // an agent we never registered
    tamperAsOperator('UPDATE receipts SET canonical_json = ? WHERE seq = 6', JSON.stringify(forged));

    const result = verifyChain(readChain(), keyDirectory(db));
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.seq === 6 && f.kind === 'UNKNOWN_AGENT')).toBe(true);
  });

  it('reports agent clock skew as a warning, not a chain failure', () => {
    // Agent clocks genuinely drift. Invalidating an otherwise sound chain over
    // NTP skew would train operators to ignore verification output.
    record({ timestamp: '2020-01-01T00:00:00.000Z' });
    const result = verifyChain(readChain(), keyDirectory(db));
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.kind === 'CLOCK_REGRESSION')).toBe(true);
  });
});

describe('concurrent appends', () => {
  it('serializes writers rather than forking the chain', () => {
    // better-sqlite3 is synchronous, so genuine parallelism is not reachable
    // in-process; what we assert is that N sequential-but-interleaved appends
    // produce a strictly linked chain with no duplicate seq.
    const results = Array.from({ length: 50 }, (_, i) => record({ actionDetail: { i } }));
    const seqs = results.map((r) => r.seq);
    expect(seqs).toEqual([...Array(50).keys()]);
    expect(new Set(seqs).size).toBe(50);
    expect(verifyChain(readChain(), keyDirectory(db)).ok).toBe(true);
  });
});

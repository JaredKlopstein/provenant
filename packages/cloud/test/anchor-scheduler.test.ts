import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  openDb, closeDb, appendReceipt, generateKeypair, deriveAgentId, listAnchors, dbSchema,
  type AnchorBackend, type Db, type Keypair,
} from '@lacre/core';
import { createTestAuthority } from '../src/anchor/test-authority.js';
import { createAnchorScheduler, runAnchorTick, type AnchorTickResult } from '../src/anchor/scheduler.js';
import { createCollector } from '../src/collector/server.js';

const MIN = 60_000;
const T0 = new Date('2026-10-17T00:00:00.000Z');

let db: Db;
let kp: Keypair;
let agentId: string;
const sessionId = randomUUID();

/** The injected clock. Under vi.useFakeTimers it is the simulated time, which
 *  is also what the store stamps as each receipt's received_at. */
const clock = () => new Date(Date.now());

function record() {
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
  });
}

/** Wraps the real test authority so every timestamp-authority call is counted,
 *  and lets a test make the next calls fail. */
function countingAuthority() {
  const inner = createTestAuthority({ now: clock });
  const state = { calls: 0, failNext: 0 };
  const backend: AnchorBackend = {
    name: inner.name,
    description: inner.description,
    isExternal: inner.isExternal,
    async anchor(statement, imprint) {
      state.calls++;
      if (state.failNext > 0) {
        state.failNext--;
        throw new Error('timestamp authority test-tsa returned HTTP 503. No anchor was recorded; the chain is unchanged.');
      }
      return inner.anchor(statement, imprint);
    },
  };
  return { backend, state };
}

function receiptsWithReceivedAt() {
  return db
    .select({ seq: dbSchema.receipts.seq, receivedAt: dbSchema.receipts.receivedAt })
    .from(dbSchema.receipts)
    .all();
}

const quietError = () => undefined;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  db = openDb(':memory:');
  kp = generateKeypair();
  agentId = deriveAgentId(kp.publicKey);
});

afterEach(() => {
  vi.useRealTimers();
  closeDb(db);
});

describe('batching to the 15-minute promise', () => {
  it('anchors a receipt recorded at t0 by t0 + 15 minutes, in exactly one anchor', async () => {
    const { backend, state } = countingAuthority();
    const s = createAnchorScheduler({ db, backend, now: clock, onError: quietError });
    record();
    s.start();

    // Batching: well inside the window, nothing has been sent yet.
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(state.calls).toBe(0);
    record(); // joins the same batch
    record();

    await vi.advanceTimersByTimeAsync(5 * MIN); // now exactly t0 + 15 minutes
    await s.stop();

    const anchors = listAnchors(db);
    expect(anchors).toHaveLength(1);
    expect(state.calls).toBe(1);
    expect(anchors[0]!.seq).toBe(2); // one anchor commits the whole batch
    expect(Date.parse(anchors[0]!.provenTime!) - T0.getTime()).toBeLessThanOrEqual(15 * MIN);
  });

  it('keeps every gap between anchors, and every receipt wait, within 15 minutes over 24 hours', async () => {
    const { backend, state } = countingAuthority();
    const s = createAnchorScheduler({ db, backend, now: clock, onError: quietError });
    s.start();

    // A receipt every 2 minutes, offset from the tick so they never coincide.
    await vi.advanceTimersByTimeAsync(17_000);
    for (let i = 0; i < 24 * 30; i++) {
      record();
      await vi.advanceTimersByTimeAsync(2 * MIN);
    }
    await s.stop();
    const end = Date.now();

    const anchors = listAnchors(db);
    expect(anchors.length).toBeGreaterThan(24 * 4); // at least one per 15 minutes
    expect(state.calls).toBe(anchors.length); // no batch sent twice
    expect(s.metrics().failedTicks).toBe(0);

    for (let i = 1; i < anchors.length; i++) {
      const gap = Date.parse(anchors[i]!.provenTime!) - Date.parse(anchors[i - 1]!.provenTime!);
      expect(gap).toBeLessThanOrEqual(15 * MIN);
      expect(anchors[i]!.seq).toBeGreaterThan(anchors[i - 1]!.seq);
    }

    // The stronger property: no individual receipt waited more than 15 minutes.
    for (const r of receiptsWithReceivedAt()) {
      const covering = anchors.find((a) => a.seq >= r.seq);
      const anchoredAt = covering ? Date.parse(covering.provenTime!) : end;
      if (!covering) expect(end - Date.parse(r.receivedAt)).toBeLessThan(15 * MIN);
      expect(anchoredAt - Date.parse(r.receivedAt)).toBeLessThanOrEqual(15 * MIN);
    }
  }, 60_000);

  it('makes no timestamp-authority call while nothing is pending', async () => {
    const { backend, state } = countingAuthority();
    const s = createAnchorScheduler({ db, backend, now: clock, onError: quietError });
    s.start();

    await vi.advanceTimersByTimeAsync(60 * MIN); // empty chain
    expect(state.calls).toBe(0);
    expect(s.metrics().ticks).toBeGreaterThan(50);

    record();
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(state.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(60 * MIN); // everything anchored
    await s.stop();
    expect(state.calls).toBe(1);
    expect(listAnchors(db)).toHaveLength(1);
  });
});

describe('authority failures', () => {
  it('retries a failed call with exponential backoff and reports the failures', async () => {
    const { backend, state } = countingAuthority();
    state.failNext = 2;
    const delays: number[] = [];
    record();
    vi.setSystemTime(T0.getTime() + 15 * MIN);

    const result = await runAnchorTick({
      db, backend, now: clock,
      sleep: async (ms) => { delays.push(ms); },
    });

    expect(result.status).toBe('anchored');
    expect(result.attempts).toBe(3);
    expect((result as Extract<AnchorTickResult, { status: 'anchored' }>).errors).toHaveLength(2);
    expect(delays).toEqual([1_000, 2_000]);
    expect(listAnchors(db)).toHaveLength(1);
  });

  it('surfaces a tick that exhausts its retries, records nothing, and tries again next tick', async () => {
    const { backend, state } = countingAuthority();
    state.failNext = 4; // every attempt in the first due tick
    const errors: Error[] = [];
    const s = createAnchorScheduler({ db, backend, now: clock, onError: (e) => errors.push(e) });
    record();
    s.start();

    // First due tick lands at 12 minutes and burns 1 + 2 + 4 seconds of backoff.
    await vi.advanceTimersByTimeAsync(12 * MIN + 10_000);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/HTTP 503/);
    expect(listAnchors(db)).toHaveLength(0);
    expect(s.metrics()).toMatchObject({
      failedTicks: 1, consecutiveFailedTicks: 1, failedAttempts: 4, anchors: 0,
    });
    expect(s.metrics().lastError).toMatch(/HTTP 503/);

    // The batch was not skipped: the next tick anchors it, still inside 15 minutes.
    await vi.advanceTimersByTimeAsync(MIN);
    await s.stop();
    const anchors = listAnchors(db);
    expect(anchors).toHaveLength(1);
    expect(Date.parse(anchors[0]!.provenTime!) - T0.getTime()).toBeLessThanOrEqual(15 * MIN);
    expect(s.metrics()).toMatchObject({ anchors: 1, consecutiveFailedTicks: 0 });
  });

  it('never sends the same batch to the authority twice', async () => {
    const { backend, state } = countingAuthority();
    const s = createAnchorScheduler({ db, backend, now: clock, onError: quietError });
    record();
    vi.setSystemTime(T0.getTime() + 15 * MIN);

    // Overlapping ticks share one in-flight attempt.
    const [a, b] = await Promise.all([s.tick(), s.tick()]);
    expect(a).toBe(b);
    expect(state.calls).toBe(1);

    // Later ticks, and a stateless tick (as a cron job would run) against the
    // same store, see the batch as already anchored.
    expect((await s.tick()).status).toBe('idle');
    expect((await runAnchorTick({ db, backend, now: clock })).status).toBe('idle');
    expect(state.calls).toBe(1);
    expect(listAnchors(db)).toHaveLength(1);
  });
});

describe('enablement and configuration', () => {
  it('does nothing until started', async () => {
    const { backend, state } = countingAuthority();
    const s = createAnchorScheduler({ db, backend, now: clock, onError: quietError });
    record();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(s.running).toBe(false);
    expect(state.calls).toBe(0);
  });

  it('a cron-driven tick reports when the batch is due, without calling the authority', async () => {
    const { backend, state } = countingAuthority();
    record();
    const result = await runAnchorTick({ db, backend, now: clock, tickIntervalMs: 5 * MIN });
    expect(result).toMatchObject({ status: 'waiting', pending: 1, dueAt: '2026-10-17T00:08:00.000Z' });
    expect(state.calls).toBe(0);
  });

  it('refuses a tick period that cannot keep the promise', () => {
    const { backend } = countingAuthority();
    expect(() => createAnchorScheduler({ db, backend, tickIntervalMs: 15 * MIN })).toThrow(/cannot keep/);
  });
});

describe('collector integration', () => {
  it('is off by default', async () => {
    vi.useRealTimers();
    const server = createCollector({ db });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    record();
    await new Promise((r) => setTimeout(r, 150));
    await new Promise<void>((r) => server.close(() => r()));
    expect(listAnchors(db)).toHaveLength(0);
  });

  it('starts the scheduler on listen and stops it on close when enabled', async () => {
    vi.useRealTimers();
    const { backend, state } = countingAuthority();
    const server = createCollector({
      db,
      anchoring: { backend, maxDelayMs: 100, tickIntervalMs: 20, safetyMarginMs: 0, onError: quietError },
    });
    record();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    expect((server.address() as AddressInfo).port).toBeGreaterThan(0);

    const deadline = Date.now() + 5_000;
    while (listAnchors(db).length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(listAnchors(db)).toHaveLength(1);

    await new Promise<void>((r) => server.close(() => r()));
    record();
    await new Promise((r) => setTimeout(r, 300));
    expect(listAnchors(db)).toHaveLength(1);
    expect(state.calls).toBe(1);
  });
});

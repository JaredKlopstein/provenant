import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  openDb, closeDb, appendReceipt, generateKeypair, deriveAgentId, listAnchors, dbSchema,
  type AnchorBackend, type Db, type Keypair,
} from '@lacre/core';
import { createTestAuthority } from '../src/anchor/test-authority.js';
import { requireCronAuth } from '../src/cron/auth.js';
import {
  createAnchorTickHandler, ANCHOR_TICK_INTERVAL_MS, type AnchorTickHandlerOptions,
} from '../src/anchor/tick-endpoint.js';
import { POST } from '../api/anchor-tick.js';

const MIN = 60_000;
const T0 = new Date('2026-10-17T00:00:00.000Z');
const TICK_SECRET = 'test-anchor-tick-secret';
const CRON_SECRET = 'test-cron-secret';
const ENV = { ANCHOR_TICK_SECRET: TICK_SECRET, CRON_SECRET };

let db: Db;
let kp: Keypair;
let agentId: string;
const sessionId = randomUUID();

/** Under vi.useFakeTimers this is the simulated time, which is also what the
 *  store stamps as each receipt's received_at. */
const clock = () => new Date(Date.now());
const noWait = async () => undefined;

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

/** The real test authority, with every timestamp-authority call counted. */
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

/** A handler over the in-memory store, counting how often it opens it. */
function handler(backend: AnchorBackend, overrides: AnchorTickHandlerOptions = {}) {
  const opened = { count: 0 };
  const handle = createAnchorTickHandler({
    env: ENV,
    store: () => {
      opened.count++;
      return { db, backend };
    },
    now: clock,
    sleep: noWait,
    ...overrides,
  });
  return { handle, opened };
}

function post(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  return new Request('https://cloud.example/api/anchor-tick', { method: 'POST', headers });
}

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

describe('requireCronAuth with a secret name', () => {
  const request = (token: string) => post(`Bearer ${token}`);

  it('accepts only the named secret', () => {
    expect(requireCronAuth(request(TICK_SECRET), ENV, 'ANCHOR_TICK_SECRET')).toBeNull();
    expect(requireCronAuth(request(CRON_SECRET), ENV, 'ANCHOR_TICK_SECRET')?.status).toBe(401);
    expect(requireCronAuth(request(TICK_SECRET), { CRON_SECRET }, 'ANCHOR_TICK_SECRET')?.status).toBe(401);
  });

  it('still checks CRON_SECRET when no name is given', () => {
    expect(requireCronAuth(request(CRON_SECRET), ENV)).toBeNull();
    expect(requireCronAuth(request(TICK_SECRET), ENV)?.status).toBe(401);
  });

  it('names the expected secret in the fix, and neither value', async () => {
    const text = await requireCronAuth(request(CRON_SECRET), ENV, 'ANCHOR_TICK_SECRET')!.text();
    const body = JSON.parse(text) as { error: { code: string; fix: { note: string } } };
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.fix.note).toContain('Bearer <ANCHOR_TICK_SECRET>');
    for (const value of [TICK_SECRET, CRON_SECRET]) expect(text).not.toContain(value);
  });
});

describe('auth on the tick endpoint', () => {
  const rejected: [string, string | undefined, Record<string, string | undefined>][] = [
    ['a missing header', undefined, ENV],
    ['a wrong secret', 'Bearer test-anchor-tick-secreX', ENV],
    ['an unset ANCHOR_TICK_SECRET', `Bearer ${TICK_SECRET}`, { CRON_SECRET }],
    ['an empty ANCHOR_TICK_SECRET', `Bearer ${TICK_SECRET}`, { ANCHOR_TICK_SECRET: '', CRON_SECRET }],
    ['a request bearing CRON_SECRET', `Bearer ${CRON_SECRET}`, ENV],
  ];

  for (const [name, header, env] of rejected) {
    it(`returns 401 for ${name} and runs no tick`, async () => {
      const { backend, state } = countingAuthority();
      const { handle, opened } = handler(backend, { env });
      record();
      vi.setSystemTime(T0.getTime() + 15 * MIN); // a tick now would anchor

      const res = await handle(post(header));
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      const text = await res.text();
      for (const value of [TICK_SECRET, CRON_SECRET]) expect(text).not.toContain(value);

      expect(opened.count).toBe(0);
      expect(state.calls).toBe(0);
      expect(listAnchors(db)).toHaveLength(0);
    });
  }

  it('the deployed route rejects an unauthenticated call', async () => {
    const res = await POST(post());
    expect(res.status).toBe(401);
  });
});

describe('an authorized tick', () => {
  it('runs one tick and returns its result as JSON with no secrets', async () => {
    const { backend, state } = countingAuthority();
    const { handle } = handler(backend);
    record();
    record();
    vi.setSystemTime(T0.getTime() + 15 * MIN);

    const res = await handle(post(`Bearer ${TICK_SECRET}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const text = await res.text();
    const body = JSON.parse(text);

    const [anchor] = listAnchors(db);
    expect(state.calls).toBe(1);
    expect(body).toEqual({
      status: 'anchored',
      pending: 2,
      attempts: 1,
      errors: [],
      anchor: {
        id: anchor!.id,
        backend: 'test-tsa',
        seq: 1, // seq is zero-based: one anchor commits both receipts
        headHash: anchor!.headHash,
        provenTime: anchor!.provenTime,
        authority: anchor!.authority,
      },
    });
    for (const value of [TICK_SECRET, CRON_SECRET, anchor!.proofToken!]) expect(text).not.toContain(value);
  });

  it('reports a batch that is not yet due without calling the authority', async () => {
    const { backend, state } = countingAuthority();
    const { handle } = handler(backend);
    record();

    const res = await handle(post(`Bearer ${TICK_SECRET}`));
    expect(res.status).toBe(200);
    // Due on the last 5-minute tick that still meets 15 minutes with the margin.
    expect(await res.json()).toMatchObject({ status: 'waiting', pending: 1, dueAt: '2026-10-17T00:08:00.000Z' });
    expect(state.calls).toBe(0);
  });

  it('returns 502 with the error message when the authority keeps failing', async () => {
    const { backend, state } = countingAuthority();
    state.failNext = 4;
    const { handle } = handler(backend);
    record();
    vi.setSystemTime(T0.getTime() + 15 * MIN);

    const res = await handle(post(`Bearer ${TICK_SECRET}`));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'failed', pending: 1, attempts: 4 });
    expect(body.error).toMatch(/HTTP 503/);
    expect(listAnchors(db)).toHaveLength(0);
  });

  it('returns 503 and runs no tick when the deployed store is not configured', async () => {
    const lines: string[] = [];
    const handle = createAnchorTickHandler({ env: ENV, now: clock, sleep: noWait, log: (l) => lines.push(l) });
    const res = await handle(post(`Bearer ${TICK_SECRET}`));
    expect(res.status).toBe(503);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.error.code).toBe('ANCHOR_STORE_NOT_CONFIGURED');
    expect(body.error.retryable).toBe(false);
    for (const leak of ['LACRE_HOME', 'LACRE_TSA_URL', 'is not set', TICK_SECRET]) {
      expect(text).not.toContain(leak);
    }
    // Apart from the error code, nothing shaped like an environment variable.
    expect(text.replace(body.error.code, '')).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/);

    // The cause, with the variable names, is logged under the id the client sees.
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get('x-request-id')).toBe(body.requestId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(body.requestId);
    expect(lines[0]).toContain('LACRE_HOME is not set');
    expect(lines[0]).toContain('LACRE_TSA_URL');
  });

  it('returns 500 with no raw store error when reading the store fails', async () => {
    const raw = 'test-raw-store-failure: SQLITE_CORRUPT at /srv/lacre/receipts.db';
    const broken = new Proxy({}, {
      get() {
        throw new Error(raw);
      },
    }) as Db;
    const { backend, state } = countingAuthority();
    const lines: string[] = [];
    const handle = createAnchorTickHandler({
      env: ENV,
      store: () => ({ db: broken, backend }),
      now: clock,
      sleep: noWait,
      log: (l) => lines.push(l),
    });

    const res = await handle(post(`Bearer ${TICK_SECRET}`));
    expect(res.status).toBe(500);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.error.code).toBe('ANCHOR_TICK_FAILED');
    expect(body.error.retryable).toBe(true);
    for (const leak of ['test-raw-store-failure', 'SQLITE_CORRUPT', '/srv/lacre', 'LACRE_']) {
      expect(text).not.toContain(leak);
    }
    expect(state.calls).toBe(0);

    expect(res.headers.get('x-request-id')).toBe(body.requestId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(body.requestId);
    expect(lines[0]).toContain(raw);
  });
});

describe('duplicate ticks', () => {
  it('two concurrent calls and a repeated call produce exactly one anchor for the batch', async () => {
    const { backend, state } = countingAuthority();
    // Two handlers, as two function instances would be: nothing shared but the database.
    const a = handler(backend).handle;
    const b = handler(backend).handle;
    record();
    record();
    vi.setSystemTime(T0.getTime() + 15 * MIN);

    const [ra, rb] = await Promise.all([a(post(`Bearer ${TICK_SECRET}`)), b(post(`Bearer ${TICK_SECRET}`))]);
    const [ba, bb] = [await ra.json(), await rb.json()];
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(ba.status).toBe('anchored');
    expect(bb.status).toBe('anchored');
    expect(ba.anchor.id).toBe(bb.anchor.id);

    const repeated = await (await a(post(`Bearer ${TICK_SECRET}`))).json();
    expect(repeated.status).toBe('idle');

    const anchors = listAnchors(db);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.seq).toBe(1);
    expect(anchors[0]!.id).toBe(ba.anchor.id);
    expect(state.calls).toBeLessThanOrEqual(2);
  });
});

describe('the 15-minute promise on 5-minute ticks', () => {
  it('anchors every receipt within 15 minutes of its arrival', async () => {
    const { backend } = countingAuthority();
    const { handle } = handler(backend);
    const auth = `Bearer ${TICK_SECRET}`;
    expect(ANCHOR_TICK_INTERVAL_MS).toBe(5 * MIN);

    // Two hours of ticks every 5 minutes. Receipts arrive every 2 minutes,
    // offset so some land just after a tick, the worst case for waiting.
    const end = T0.getTime() + 2 * 60 * MIN;
    let nextTick = T0.getTime() + 5 * MIN;
    let nextReceipt = T0.getTime() + 1_000;
    while (nextTick <= end) {
      if (nextReceipt < nextTick) {
        vi.setSystemTime(nextReceipt);
        record();
        nextReceipt += 2 * MIN;
      } else {
        vi.setSystemTime(nextTick);
        const res = await handle(post(auth));
        expect(res.status).toBe(200);
        nextTick += ANCHOR_TICK_INTERVAL_MS;
      }
    }

    const anchors = listAnchors(db);
    expect(anchors.length).toBeGreaterThan(1);
    const receipts = db
      .select({ seq: dbSchema.receipts.seq, receivedAt: dbSchema.receipts.receivedAt })
      .from(dbSchema.receipts)
      .all();
    for (const r of receipts) {
      const covering = anchors.find((x) => x.seq >= r.seq);
      const anchoredAt = covering ? Date.parse(covering.provenTime!) : end;
      expect(anchoredAt - Date.parse(r.receivedAt), `seq ${r.seq}`).toBeLessThanOrEqual(15 * MIN);
    }
  });
});

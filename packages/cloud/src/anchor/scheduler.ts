/**
 * Continuous anchoring: batch pending receipts and anchor the chain head at most
 * `maxDelayMs` (15 minutes on Cloud) after the oldest receipt not yet anchored.
 *
 * Why batch rather than anchor every receipt: one anchor commits the whole
 * chain up to the head (see core/src/db/schema.ts), and every anchor is a paid,
 * rate-limited call to an authority we do not control. Waiting until the oldest
 * pending receipt approaches the deadline turns a chatty fleet into one
 * authority call per window, while still bounding the un-anchored tail -- the
 * window in which truncation goes undetected (ADR 0003) -- to the promise.
 *
 * The database is the only state. "Pending" means receipts above the highest seq
 * this backend has anchored, and the deadline is measured from the oldest
 * pending receipt's server receive time. So a restart, a second scheduler, or a
 * stateless Vercel Cron call to `runAnchorTick` all agree on what is due, and a
 * batch already in the append-only anchor store is never sent to the authority
 * again (createAnchor is idempotent on seq + backend).
 *
 * Two ways to drive it:
 *   - `createAnchorScheduler(...).start()` -- a timer, for self-hosted and local
 *     use. The collector starts and stops it via its `anchoring` option.
 *   - `runAnchorTick(...)` -- one stateless check, for platforms with no
 *     long-running process. Call it at least every 15 minutes (every 5 is
 *     better) and pass that period as `tickIntervalMs`.
 */
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import {
  createAnchor, dbSchema, getAnchorBackend, registerAnchorBackend, ProvenantError,
  type AnchorBackend, type AnchorRecord, type Db,
} from '@provenant/core';
import { PLANS } from '../pricing.js';

export interface AnchorRetryPolicy {
  /** Total authority calls per tick, including the first. */
  attempts: number;
  /** Delay before the first retry; doubles on each subsequent retry. */
  baseDelayMs: number;
  /** Cap on any single backoff delay. */
  maxDelayMs: number;
}

export interface AnchorTickOptions {
  db: Db;
  /** The authority to anchor with, e.g. createTsaBackend(...). Registered in
   *  core's anchor registry under its own name so createAnchor can use it. */
  backend: AnchorBackend;
  /** Injected clock. Defaults to the system clock. */
  now?: () => Date;
  /** The promise: longest a receipt may wait to be anchored. Defaults to the
   *  Cloud plan's maxAnchorIntervalMinutes (15 minutes). */
  maxDelayMs?: number;
  /** How often ticks run. A batch is anchored on the last tick that can still
   *  meet the promise, so this must be the real period between calls. */
  tickIntervalMs?: number;
  /** Time reserved for authority latency and retry backoff inside one tick. */
  safetyMarginMs?: number;
  retry?: Partial<AnchorRetryPolicy>;
  /** Injected for backoff, so tests can run without real waiting. */
  sleep?: (ms: number) => Promise<void>;
}

export type AnchorTickResult =
  | { status: 'idle'; pending: 0; attempts: 0 }
  | { status: 'waiting'; pending: number; oldestPendingAt: string; dueAt: string; attempts: 0 }
  | { status: 'anchored'; pending: number; anchor: AnchorRecord; attempts: number; errors: string[] }
  | { status: 'failed'; pending: number; attempts: number; error: Error; errors: string[] };

export const DEFAULT_MAX_ANCHOR_DELAY_MS = (PLANS.cloud.maxAnchorIntervalMinutes ?? 15) * 60_000;
export const DEFAULT_TICK_INTERVAL_MS = 60_000;
export const DEFAULT_SAFETY_MARGIN_MS = 2 * 60_000;
export const DEFAULT_ANCHOR_RETRY: AnchorRetryPolicy = { attempts: 4, baseDelayMs: 1_000, maxDelayMs: 30_000 };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One stateless scheduling decision. Anchors the head if the oldest pending
 * receipt would otherwise miss the deadline before the next tick; does nothing
 * (and makes no authority call) when nothing is pending or nothing is due yet.
 *
 * A failed authority call is retried with exponential backoff. If every attempt
 * fails, the result is `failed` with the last error -- nothing is recorded, the
 * receipts stay pending, and the next tick tries again. It is never skipped.
 */
export async function runAnchorTick(opts: AnchorTickOptions): Promise<AnchorTickResult> {
  const now = opts.now ?? (() => new Date());
  const { maxDelayMs, tickIntervalMs, safetyMarginMs } = resolveTiming(opts);
  const retry = { ...DEFAULT_ANCHOR_RETRY, ...opts.retry };
  const sleep = opts.sleep ?? realSleep;
  const { anchors, receipts } = dbSchema;

  const last = opts.db
    .select({ seq: anchors.seq })
    .from(anchors)
    .where(eq(anchors.backend, opts.backend.name))
    .orderBy(desc(anchors.seq))
    .limit(1)
    .get();
  const pendingWhere = last ? gt(receipts.seq, last.seq) : undefined;

  const oldest = opts.db
    .select({ seq: receipts.seq, receivedAt: receipts.receivedAt })
    .from(receipts)
    .where(pendingWhere)
    .orderBy(asc(receipts.seq))
    .limit(1)
    .get();
  if (!oldest) return { status: 'idle', pending: 0, attempts: 0 };

  const head = opts.db
    .select({ seq: receipts.seq })
    .from(receipts)
    .orderBy(desc(receipts.seq))
    .limit(1)
    .get()!;
  const pending = head.seq - oldest.seq + 1;

  // Anchor on the last tick that still lands inside the promise: if we waited
  // for the next one, it plus the time an anchor can take would overshoot.
  const oldestMs = Date.parse(oldest.receivedAt);
  const dueAtMs = oldestMs + Math.max(0, maxDelayMs - tickIntervalMs - safetyMarginMs);
  if (now().getTime() < dueAtMs) {
    return {
      status: 'waiting',
      pending,
      oldestPendingAt: oldest.receivedAt,
      dueAt: new Date(dueAtMs).toISOString(),
      attempts: 0,
    };
  }

  // createAnchor resolves backends by name. Make sure the name resolves to the
  // backend we were given, not whatever was registered under it before.
  if (getAnchorBackend(opts.backend.name) !== opts.backend) registerAnchorBackend(opts.backend);

  const errors: string[] = [];
  let lastError: Error = new Error('no anchor attempt was made');
  for (let attempt = 1; attempt <= retry.attempts; attempt++) {
    try {
      const anchor = await createAnchor(opts.db, opts.backend.name);
      return { status: 'anchored', pending, anchor, attempts: attempt, errors };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      errors.push(lastError.message);
      // A non-retryable refusal (ANCHOR_CONTRADICTION: history was rewritten
      // under an existing anchor) will not improve with another call.
      if (err instanceof ProvenantError && !err.retryable) break;
      if (attempt < retry.attempts) {
        await sleep(Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1)));
      }
    }
  }
  return { status: 'failed', pending, attempts: errors.length, error: lastError, errors };
}

export interface AnchorSchedulerOptions extends AnchorTickOptions {
  /** Called when a tick exhausts its retries. Defaults to console.error, so a
   *  failing authority is never silent. */
  onError?: (error: Error, result: AnchorTickResult) => void;
}

export interface AnchorSchedulerMetrics {
  ticks: number;
  anchors: number;
  /** Authority calls made, successful or not. */
  attempts: number;
  /** Authority calls that failed. */
  failedAttempts: number;
  /** Ticks that exhausted every retry without anchoring. */
  failedTicks: number;
  /** Failed ticks since the last successful anchor. Non-zero means the
   *  15-minute promise is at risk right now. */
  consecutiveFailedTicks: number;
  lastAnchorAt: string | null;
  lastError: string | null;
}

export interface AnchorScheduler {
  /** Start ticking every tickIntervalMs. Idempotent. */
  start(): void;
  /** Stop ticking and wait for an in-flight tick to finish. */
  stop(): Promise<void>;
  /** Run one tick now. Overlapping calls share the in-flight tick, so the same
   *  batch is never sent to the authority twice concurrently. */
  tick(): Promise<AnchorTickResult>;
  readonly running: boolean;
  metrics(): AnchorSchedulerMetrics;
}

/** A timer around runAnchorTick, for self-hosted and local use. Off until
 *  start() is called. */
export function createAnchorScheduler(opts: AnchorSchedulerOptions): AnchorScheduler {
  const { tickIntervalMs } = resolveTiming(opts);
  const now = opts.now ?? (() => new Date());
  const onError = opts.onError ?? ((err: Error) => console.error('anchor scheduler:', err.message));
  const m: AnchorSchedulerMetrics = {
    ticks: 0, anchors: 0, attempts: 0, failedAttempts: 0, failedTicks: 0,
    consecutiveFailedTicks: 0, lastAnchorAt: null, lastError: null,
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let inFlight: Promise<AnchorTickResult> | null = null;

  async function runOnce(): Promise<AnchorTickResult> {
    let result: AnchorTickResult;
    try {
      result = await runAnchorTick({ ...opts, now });
    } catch (err) {
      // Reading the store failed before any authority call. Still a failure to
      // surface, not to swallow.
      const error = err instanceof Error ? err : new Error(String(err));
      result = { status: 'failed', pending: 0, attempts: 0, error, errors: [error.message] };
    }
    m.ticks++;
    m.attempts += result.attempts;
    if (result.status === 'anchored') {
      m.anchors++;
      m.failedAttempts += result.errors.length;
      m.consecutiveFailedTicks = 0;
      m.lastAnchorAt = now().toISOString();
    } else if (result.status === 'failed') {
      m.failedAttempts += result.errors.length;
      m.failedTicks++;
      m.consecutiveFailedTicks++;
      m.lastError = result.error.message;
      onError(result.error, result);
    }
    return result;
  }

  function tick(): Promise<AnchorTickResult> {
    inFlight ??= runOnce().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function schedule(): void {
    timer = setTimeout(() => {
      timer = null;
      void tick().finally(() => {
        if (running) schedule();
      });
    }, tickIntervalMs);
    // The scheduler must not by itself keep a process alive.
    timer.unref?.();
  }

  return {
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      if (inFlight) await inFlight.catch(() => undefined);
    },
    tick,
    get running() {
      return running;
    },
    metrics() {
      return { ...m };
    },
  };
}

function resolveTiming(opts: AnchorTickOptions) {
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_ANCHOR_DELAY_MS;
  const tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const safetyMarginMs = opts.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS;
  if (!(maxDelayMs > 0) || !(tickIntervalMs > 0) || !(safetyMarginMs >= 0)) {
    throw new ProvenantError({
      code: 'INVALID_INPUT',
      message:
        `Invalid anchor scheduler timing: maxDelayMs=${maxDelayMs}, tickIntervalMs=${tickIntervalMs}, ` +
        `safetyMarginMs=${safetyMarginMs}. Nothing was scheduled.`,
      retryable: false,
      fix: { note: 'maxDelayMs and tickIntervalMs must be positive; safetyMarginMs must be zero or more.' },
    });
  }
  if (tickIntervalMs + safetyMarginMs > maxDelayMs) {
    throw new ProvenantError({
      code: 'INVALID_INPUT',
      message:
        `Ticking every ${tickIntervalMs} ms with a ${safetyMarginMs} ms margin cannot keep a ` +
        `${maxDelayMs} ms anchoring promise. Nothing was scheduled.`,
      retryable: false,
      fix: { note: 'Tick more often (e.g. every 5 minutes for a 15-minute promise) or lower safetyMarginMs.' },
    });
  }
  return { maxDelayMs, tickIntervalMs, safetyMarginMs };
}

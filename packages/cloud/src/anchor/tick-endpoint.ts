/**
 * The anchor tick as an HTTP endpoint, for an external scheduler.
 *
 * Vercel Hobby crons run at most daily, and the Cloud promise is that a receipt
 * is anchored within 15 minutes. So an external scheduler (cron-job.org) POSTs
 * here every 5 minutes, and each request runs one stateless `runAnchorTick`
 * with `tickIntervalMs` of 5 minutes. No vercel.json entry is involved.
 *
 * Auth is a secret of its own, ANCHOR_TICK_SECRET, checked with the shared
 * cron helper before anything else. The scheduler outside Vercel holds that
 * value and never CRON_SECRET; a request bearing CRON_SECRET is refused. A
 * missing, wrong or unset secret gets the same 401, and no store is opened and
 * no tick runs.
 *
 * Duplicate or overlapping calls are safe without any state here: the database
 * is the only state, and createAnchor is idempotent on seq + backend, so a
 * batch already anchored is never anchored again (see scheduler.ts).
 *
 * The response is the tick's result as JSON. It names the anchor it made, if
 * any, but never the proof token, a secret or the environment. When the store
 * cannot be opened or read, the client gets a generic error and a request id;
 * the cause, which can name environment variables, goes to the server log.
 */
import { resolve } from 'node:path';
import { openDb, dbPath, type AnchorBackend, type Db } from '@provenant/core';
import { requireCronAuth } from '../cron/auth.js';
import { genericError } from '../errors.js';
import { runAnchorTick, type AnchorTickResult } from './scheduler.js';
import { createTsaBackend, PUBLIC_TSAS } from './tsa.js';

export const ANCHOR_TICK_SECRET = 'ANCHOR_TICK_SECRET';
/** How often the external scheduler calls. Must be the real period. */
export const ANCHOR_TICK_INTERVAL_MS = 5 * 60_000;

export interface AnchorTickStore {
  db: Db;
  backend: AnchorBackend;
}

export interface AnchorTickHandlerOptions {
  /** Defaults to process.env, read on each request. */
  env?: Record<string, string | undefined>;
  /** Opens the receipt store and the authority. Called only after auth
   *  passes, and kept once it succeeds. Defaults to anchorTickStoreFromEnv. */
  store?: (env: Record<string, string | undefined>) => AnchorTickStore;
  /** Injected clock. Defaults to the system clock. */
  now?: () => Date;
  /** Injected for retry backoff, so tests run without real waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Receives the server-side cause of an error response. Defaults to console.error. */
  log?: (line: string) => void;
}

/**
 * The deployed store: the receipt database under PROVENANT_HOME and the
 * timestamp authority named by PROVENANT_TSA_URL (a URL, or freetsa, digicert
 * or sectigo; digicert by default), the same variables the CLI reads.
 * PROVENANT_HOME has no fallback here: a serverless function has no home
 * directory worth anchoring, so an unset variable is an error, not an empty
 * store that reports "idle" forever.
 */
export function anchorTickStoreFromEnv(env: Record<string, string | undefined>): AnchorTickStore {
  const home = env.PROVENANT_HOME;
  if (!home) {
    throw new Error('PROVENANT_HOME is not set, so there is no receipt store to anchor.');
  }
  const configured = env.PROVENANT_TSA_URL ?? 'digicert';
  const url = (PUBLIC_TSAS as Record<string, string>)[configured] ?? configured;
  return { db: openDb(dbPath(resolve(home))), backend: createTsaBackend({ url }) };
}

/** Builds the `(Request) => Promise<Response>` the Vercel route exports. */
export function createAnchorTickHandler(opts: AnchorTickHandlerOptions = {}): (request: Request) => Promise<Response> {
  const open = opts.store ?? anchorTickStoreFromEnv;
  let store: AnchorTickStore | null = null;

  return async (request) => {
    const env = opts.env ?? process.env;
    const denied = requireCronAuth(request, env, ANCHOR_TICK_SECRET);
    if (denied) return denied;

    try {
      store ??= open(env);
    } catch (err) {
      // The cause and the fix name environment variables: server log only.
      return genericError({
        status: 503,
        code: 'ANCHOR_STORE_NOT_CONFIGURED',
        message: 'The anchor tick is not configured on the server. Nothing was anchored.',
        retryable: false,
        cause:
          `anchor tick: could not open the store: ${messageOf(err)} Set PROVENANT_HOME to the receipt store ` +
          'and, optionally, PROVENANT_TSA_URL in the Vercel project, then redeploy.',
        log: opts.log,
      });
    }

    let result: AnchorTickResult;
    try {
      result = await runAnchorTick({
        db: store.db,
        backend: store.backend,
        tickIntervalMs: ANCHOR_TICK_INTERVAL_MS,
        now: opts.now,
        sleep: opts.sleep,
      });
    } catch (err) {
      // Reading the store failed before any authority call.
      return genericError({
        status: 500,
        code: 'ANCHOR_TICK_FAILED',
        message: 'The anchor tick could not read the store. Nothing was anchored; the next scheduled call tries again.',
        retryable: true,
        cause: `anchor tick: could not read the store: ${messageOf(err)}`,
        log: opts.log,
      });
    }

    return json(result.status === 'failed' ? 502 : 200, view(result));
  };
}

/** The tick result as plain JSON: no Error objects and no proof token. */
function view(result: AnchorTickResult): Record<string, unknown> {
  switch (result.status) {
    case 'idle':
    case 'waiting':
      return { ...result };
    case 'anchored': {
      const { anchor, ...rest } = result;
      return {
        ...rest,
        anchor: {
          id: anchor.id,
          backend: anchor.backend,
          seq: anchor.statement.seq,
          headHash: anchor.statement.head_hash,
          provenTime: anchor.proof.proven_time ?? null,
          authority: anchor.proof.authority ?? null,
        },
      };
    }
    case 'failed': {
      const { error, ...rest } = result;
      return { ...rest, error: error.message };
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

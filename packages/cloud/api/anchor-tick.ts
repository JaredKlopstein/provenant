/**
 * POST /api/anchor-tick: the Vercel function an external scheduler
 * (cron-job.org, every 5 minutes) calls to keep the 15-minute anchoring
 * promise. It has no vercel.json entry; Vercel Hobby crons run at most daily.
 *
 * Needs `Authorization: Bearer <ANCHOR_TICK_SECRET>`, which is not CRON_SECRET.
 * Everything else, including the store and authority it opens from
 * LACRE_HOME and LACRE_TSA_URL, is in src/anchor/tick-endpoint.ts.
 */
import { createAnchorTickHandler } from '../src/anchor/tick-endpoint.js';

export const POST = createAnchorTickHandler();

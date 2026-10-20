/**
 * GET /api/cron/overage-retry: the Vercel function vercel.json's daily cron
 * entry calls. It resends every unreported overage row and abandons the ones
 * past Stripe's 35-day meter event window (billing/overage.ts).
 *
 * Daily is enough on Vercel Hobby: a failed row gets about 33 attempts before
 * the 34-day cutoff. Anything more frequent needs Vercel Pro and the owner's
 * approval.
 *
 * The cron secret is checked before anything else, so a missing, wrong or
 * unset CRON_SECRET gets a 401 and nothing is read, sent or logged. The route
 * builds its own reporter from the environment (STRIPE_SECRET_KEY, the
 * STRIPE_PRICE_* ids, STRIPE_METER_EVENT_NAME, DATABASE_URL) and never uses the
 * one an export installs.
 */
import { requireCronAuth } from '../../src/cron/auth.js';
import {
  createOverageReporter, retryPendingOverage, type OverageReporter, type OverageReporterOptions,
} from '../../src/billing/overage.js';

/**
 * Builds the route. Tests pass a fake Stripe client, an in-process database
 * and a fake clock; the deployed route passes nothing and reads process.env on
 * each request. A reporter that loaded is kept for later requests on the same
 * instance, so its database pool is reused.
 */
export function createOverageRetryRoute(opts: OverageReporterOptions = {}): (request: Request) => Promise<Response> {
  let reporter: OverageReporter | null = null;
  return async (request) => {
    const env = opts.env ?? process.env;
    const denied = requireCronAuth(request, env);
    if (denied) return denied;

    try {
      reporter ??= createOverageReporter({ ...opts, env });
    } catch (err) {
      // The config error names the missing variables and never their values.
      const message = err instanceof Error ? err.message : String(err);
      (opts.log ?? ((line: string) => console.error(line)))(`billing overage cron: ${message}`);
      return json(500, {
        error: {
          code: 'BILLING_NOT_CONFIGURED',
          message: `Overage retry could not start: ${message}`,
          retryable: false,
          fix: { note: 'Set the named variables in the Vercel project, redeploy, and the next daily run retries.' },
        },
      });
    }

    const result = (await retryPendingOverage(reporter))!;
    const { status, reported, failed, abandoned } = result;
    return json(status === 'failed' ? 500 : 200, { status, reported, failed, abandoned });
  };
}

export const GET = createOverageRetryRoute();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

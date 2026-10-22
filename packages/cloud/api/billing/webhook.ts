/**
 * POST /api/billing/webhook: the Vercel function Stripe sends billing events to.
 * vercel.json rewrites the documented path, /billing/webhook (BILLING_WEBHOOK_PATH,
 * the same path the collector serves), to this file, so either URL works.
 *
 * Everything that matters is in src/billing/webhook.ts: the Stripe-Signature
 * header is checked with Stripe's own `webhooks.constructEvent` against
 * STRIPE_WEBHOOK_SECRET, on the raw bytes exactly as received, before anything
 * else. This file passes the Web-standard Request straight through and never
 * reads or parses the body itself; Vercel does not parse the body of a function
 * that takes a Request. A missing, bad or stale signature gets 400 and the
 * database is never opened.
 *
 * The handler is built on the first request and kept for later requests on the
 * same instance, so its database pool is reused. Building it reads
 * STRIPE_WEBHOOK_SECRET, DATABASE_URL, STRIPE_SECRET_KEY and
 * STRIPE_PRICE_BUNDLE_OVERAGE; when any is missing or malformed, or a live key is
 * set without PROVENANT_BILLING_MODE=live, the request gets a generic 500 with a
 * request id. The config error, which names the variables (never their values),
 * goes only to the server log under the same id. Stripe retries a 500, so fixing
 * the variables and redeploying lets the next retry through.
 */
import { createBillingWebhook, type BillingWebhook, type BillingWebhookOptions } from '../../src/billing/webhook.js';
import { genericError } from '../../src/errors.js';

export function createBillingWebhookRoute(opts: BillingWebhookOptions = {}): (request: Request) => Promise<Response> {
  let hook: BillingWebhook | null = null;
  return async (request) => {
    try {
      hook ??= createBillingWebhook(opts);
    } catch (err) {
      // The config error names the missing variables: server log only. Still a
      // 500, so Stripe retries the event once the variables are fixed.
      const message = err instanceof Error ? err.message : String(err);
      return genericError({
        status: 500,
        code: 'BILLING_NOT_CONFIGURED',
        message: 'Billing is not available right now.',
        retryable: true,
        cause:
          `billing webhook: ${message} Set the named variables in the Vercel project and redeploy; ` +
          'Stripe retries the event.',
        log: opts.log?.error,
      });
    }
    return hook.webhook(request);
  };
}

export const POST = createBillingWebhookRoute();

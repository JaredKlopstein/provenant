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
 * set without PROVENANT_BILLING_MODE=live, the request gets a 500 naming the
 * variables, never their values. Stripe retries a 500, so fixing the variables
 * and redeploying lets the next retry through.
 */
import { createBillingWebhook, type BillingWebhook, type BillingWebhookOptions } from '../../src/billing/webhook.js';

export function createBillingWebhookRoute(opts: BillingWebhookOptions = {}): (request: Request) => Promise<Response> {
  let hook: BillingWebhook | null = null;
  return async (request) => {
    try {
      hook ??= createBillingWebhook(opts);
    } catch (err) {
      // The config error names the missing variables and never their values.
      const message = err instanceof Error ? err.message : String(err);
      (opts.log?.error ?? ((line: string) => console.error(line)))(`billing webhook: ${message}`);
      return json(500, {
        error: {
          code: 'BILLING_NOT_CONFIGURED',
          message: `The billing webhook could not start: ${message}`,
          retryable: true,
          fix: { note: 'Set the named variables in the Vercel project and redeploy; Stripe retries the event.' },
        },
      });
    }
    return hook.webhook(request);
  };
}

export const POST = createBillingWebhookRoute();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

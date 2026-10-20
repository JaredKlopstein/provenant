/**
 * Checkout for signed-in customers. There is no anonymous checkout: the account
 * comes only from the session cookie, never from the request.
 *
 * The route hands a fresh request to cloud's own checkout handler
 * (`createBillingRoutes(...).checkout`), so pricing, the one-Cloud-subscription
 * guard, test/live mode and the annual overage disclosure all stay in cloud. Only
 * `plan`, `interval` and `kind` are copied from the caller; `client_reference_id`
 * is always the signed-in account id, so the webhook links the Stripe customer to
 * that account and to no other.
 *
 * Success and cancel URLs come from the link base (BRAND.domain, SITE_BASE_URL,
 * then VERCEL_URL). The request's Host header is never consulted.
 *
 * Like the auth routes, it accepts the page's native form post, answered with a
 * 303 (to Stripe, or back to the page with ?checkout=<outcome>), and JSON,
 * answered with cloud's JSON, every error carrying its fix.
 */
import { createBillingRoutes, type AuthResult } from '@provenant/cloud/dist/billing/routes.js';
import { createCustomerLookup } from '@provenant/cloud/dist/billing/store.js';
import type { StripeLike, SubscriptionLister } from '@provenant/cloud/dist/billing/stripe.js';
import { SIGNUP_PATH, linkBase } from './auth/email';
import { getSignedInAccount } from './auth/session';
import { BILLING_DATABASE_ENV, billingDb, type ConnectBillingDb } from './billing-db';

export const CHECKOUT_PAGE_PATH = '/checkout';
export const CHECKOUT_API_PATH = '/api/checkout';
export const WELCOME_PATH = '/welcome';
export const ACCOUNT_PATH = '/account';
const PRICING_PATH = '/pricing';

/** After a form post the route redirects to `/checkout?checkout=<outcome>`. */
export const CHECKOUT_OUTCOMES = ['invalid', 'subscribed', 'unavailable', 'failed'] as const;
export type CheckoutOutcome = (typeof CHECKOUT_OUTCOMES)[number];

/** Stripe replaces this with the session id when it sends the customer back. */
const SESSION_ID_TEMPLATE = '{CHECKOUT_SESSION_ID}';
const FORWARDED_FIELDS = ['plan', 'interval', 'kind'] as const;
const MAX_BODY_BYTES = 4 * 1024;
const NOTHING_CREATED = 'No checkout session was created.';

export interface CheckoutRouteOptions {
  /** Defaults to a real Stripe client built by cloud. Tests inject a fake. */
  stripe?: StripeLike & SubscriptionLister;
  /** Defaults to the Neon driver. Tests pass PGlite. */
  connect?: ConnectBillingDb;
  /** Receives each failure line, already redacted by cloud. Defaults to console.error. */
  log?: (line: string) => void;
}

interface ErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  fix: { note: string };
}

/** The deployed route passes nothing and reads process.env on each request. */
export function createCheckoutRoute(opts: CheckoutRouteOptions = {}): (request: Request) => Promise<Response> {
  const log = opts.log ?? ((line: string) => console.error(line));
  return async (request) => {
    const form = isForm(request);
    const fail = (status: number, outcome: CheckoutOutcome, error: ErrorBody) =>
      form ? redirect(`${CHECKOUT_PAGE_PATH}?checkout=${outcome}`) : json(status, { error });

    const account = await getSignedInAccount(request);
    if (!account) {
      if (form) return redirect(SIGNUP_PATH);
      return json(401, {
        error: {
          code: 'NOT_SIGNED_IN',
          message: `Checkout is for signed-in customers only. ${NOTHING_CREATED}`,
          retryable: false,
          fix: { note: `Sign in with an email link at ${SIGNUP_PATH}, then retry with the session cookie.` },
        },
      });
    }

    const base = linkBase();
    if (!base) {
      log('checkout: no link base; set BRAND.domain, SITE_BASE_URL or VERCEL_URL');
      return fail(500, 'unavailable', {
        code: 'CHECKOUT_UNAVAILABLE',
        message: `Checkout has no base URL to send the customer back to. ${NOTHING_CREATED}`,
        retryable: false,
        fix: { note: 'The site operator must set a base URL: BRAND.domain, SITE_BASE_URL or VERCEL_URL.' },
      });
    }
    const db = billingDb(opts.connect);
    if (!db) {
      return fail(503, 'unavailable', {
        code: 'CHECKOUT_UNAVAILABLE',
        message: `Checkout is not configured on this server yet. ${NOTHING_CREATED}`,
        retryable: false,
        fix: { note: `The site operator must set ${BILLING_DATABASE_ENV} to the billing database.` },
      });
    }

    const fields = await readFields(request, form);
    if (!fields) {
      return fail(400, 'invalid', {
        code: 'INVALID_INPUT',
        message: `The request body is not a JSON object or form of at most ${MAX_BODY_BYTES} bytes. ${NOTHING_CREATED}`,
        retryable: false,
        fix: { note: 'Send {"plan":"cloud","interval":"month"}, {"plan":"cloud","interval":"year"} or {"kind":"payg_bundle"}.' },
      });
    }

    let checkout: (request: Request) => Promise<Response>;
    try {
      checkout = createBillingRoutes({
        env: process.env,
        ...(opts.stripe ? { stripe: opts.stripe } : {}),
        customers: createCustomerLookup(db),
        authenticate: checkoutTakesNoSignature,
        successUrl: `${base}${WELCOME_PATH}?session_id=${SESSION_ID_TEMPLATE}`,
        cancelUrl: `${base}${PRICING_PATH}?checkout=cancelled`,
        returnUrl: `${base}${ACCOUNT_PATH}`,
        log,
      }).checkout;
    } catch (err) {
      // Cloud's config error names the missing variables and never their values.
      const message = err instanceof Error ? err.message : String(err);
      log(`checkout: ${message}`);
      return fail(503, 'unavailable', {
        code: 'BILLING_NOT_CONFIGURED',
        message: `Checkout is not configured on this server yet. ${NOTHING_CREATED}`,
        retryable: false,
        fix: { note: `The site operator must fix the billing configuration: ${message}` },
      });
    }

    const forwarded: Record<string, unknown> = { ...fields, client_reference_id: account.accountId };
    const res = await checkout(
      new Request(new URL(CHECKOUT_API_PATH, base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(forwarded),
      }),
    );
    if (!form) return withNoStore(res);
    if (!res.ok) return redirect(`${CHECKOUT_PAGE_PATH}?checkout=${outcomeFor(res.status)}`);
    const { result } = (await res.json()) as { result: { url: string } };
    return redirect(result.url);
  };
}

/** The account the request's session cookie proves, from a page's request headers. */
export function signedInFromCookie(cookie: string | null) {
  return getSignedInAccount(new Request(`https://site.invalid${CHECKOUT_PAGE_PATH}`, { headers: { cookie: cookie ?? '' } }));
}

/** Checkout is authorised by the session; only cloud's portal uses agent signatures. */
function checkoutTakesNoSignature(): AuthResult {
  return { ok: false, reason: 'the site checkout is authorised by the session cookie' };
}

/** Only plan, interval and kind, and only as strings. Null when the body is not an object or form. */
async function readFields(request: Request, form: boolean): Promise<Record<string, string> | null> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return null;
  let source: Record<string, unknown>;
  if (form) {
    source = Object.fromEntries(new URLSearchParams(raw));
  } else {
    try {
      const body: unknown = raw.trim() === '' ? {} : JSON.parse(raw);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
      source = body as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const fields: Record<string, string> = {};
  for (const name of FORWARDED_FIELDS) {
    const value = source[name];
    if (typeof value === 'string') fields[name] = value;
  }
  return fields;
}

function outcomeFor(status: number): CheckoutOutcome {
  if (status === 400) return 'invalid';
  if (status === 409) return 'subscribed';
  if (status === 500 || status === 503) return 'unavailable';
  return 'failed';
}

function isForm(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded');
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

function withNoStore(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('cache-control', 'no-store');
  return new Response(res.body, { status: res.status, headers });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

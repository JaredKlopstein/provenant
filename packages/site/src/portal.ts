/**
 * The Stripe billing portal for signed-in customers.
 *
 * The route hands the request to cloud's own portal handler
 * (`createBillingRoutes(...).portal`) with two site pieces: an `authenticate`
 * that accepts only the session cookie, and cloud's `createCustomerLookup` over
 * the billing database. The account comes only from the session; nothing in the
 * body or query is read as an account. The lookup finds the Stripe customer whose
 * account_id is that account, the id checkout sends as client_reference_id.
 *
 * The return URL comes from the link base (BRAND.domain, SITE_BASE_URL, then
 * VERCEL_URL). The request's Host header is never consulted.
 *
 * It accepts the account page's native form post, answered with a 303 (to Stripe,
 * or back to the page with ?billing=<outcome>), and JSON, every error carrying
 * its fix.
 */
import { createBillingRoutes, type AuthResult } from '@lacre/cloud/dist/billing/routes.js';
import { createCustomerLookup } from '@lacre/cloud/dist/billing/store.js';
import type { StripeLike, SubscriptionLister } from '@lacre/cloud/dist/billing/stripe.js';
import { SIGNUP_PATH, linkBase } from './auth/email';
import { getSignedInAccount } from './auth/session';
import { BILLING_DATABASE_ENV, billingDb, type ConnectBillingDb } from './billing-db';
import { ACCOUNT_PATH, WELCOME_PATH } from './checkout';

export const PORTAL_API_PATH = '/api/account/portal';
const PRICING_PATH = '/pricing';

/** After a form post the route redirects to `/account?billing=<outcome>`. */
export const PORTAL_OUTCOMES = ['none', 'unavailable', 'failed'] as const;
export type PortalOutcome = (typeof PORTAL_OUTCOMES)[number];

const NOTHING_CREATED = 'No billing portal session was created.';

export interface PortalRouteOptions {
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
export function createPortalRoute(opts: PortalRouteOptions = {}): (request: Request) => Promise<Response> {
  const log = opts.log ?? ((line: string) => console.error(line));
  return async (request) => {
    const form = isForm(request);
    const fail = (status: number, outcome: PortalOutcome, error: ErrorBody) =>
      form ? redirect(`${ACCOUNT_PATH}?billing=${outcome}`) : json(status, { error });

    if (!(await getSignedInAccount(request))) {
      if (form) return redirect(SIGNUP_PATH);
      return json(401, {
        error: {
          code: 'NOT_SIGNED_IN',
          message: `The billing portal is for signed-in customers only. ${NOTHING_CREATED}`,
          retryable: false,
          fix: { note: `Sign in with an email link at ${SIGNUP_PATH}, then retry with the session cookie.` },
        },
      });
    }

    // A missing-config answer is generic: the cause, which names variables, goes
    // only to the log, under the request id the response carries.
    const unavailable = (status: number, code: string, cause: string) => {
      const requestId = crypto.randomUUID();
      log(`billing portal: request ${requestId}: ${cause}`);
      const headers = { 'x-request-id': requestId };
      if (form) return redirect(`${ACCOUNT_PATH}?billing=unavailable`, headers);
      const error: ErrorBody = {
        code,
        message: `The billing portal is not available on this server right now. ${NOTHING_CREATED}`,
        retryable: false,
        fix: { note: `The site operator must finish the server configuration. Quote request id ${requestId}.` },
      };
      return json(status, { error, requestId }, headers);
    };

    const base = linkBase();
    if (!base) {
      return unavailable(500, 'PORTAL_UNAVAILABLE', 'no link base; set BRAND.domain, SITE_BASE_URL or VERCEL_URL');
    }
    const db = billingDb(opts.connect);
    if (!db) {
      return unavailable(503, 'PORTAL_UNAVAILABLE', `${BILLING_DATABASE_ENV} is not set`);
    }

    let portal: (request: Request) => Promise<Response>;
    try {
      portal = createBillingRoutes({
        env: process.env,
        ...(opts.stripe ? { stripe: opts.stripe } : {}),
        customers: createCustomerLookup(db),
        authenticate: sessionOnly,
        successUrl: `${base}${WELCOME_PATH}`,
        cancelUrl: `${base}${PRICING_PATH}`,
        returnUrl: `${base}${ACCOUNT_PATH}`,
        log,
      }).portal;
    } catch (err) {
      // Cloud's config error names the missing variables, so it is logged, never returned.
      return unavailable(503, 'BILLING_NOT_CONFIGURED', err instanceof Error ? err.message : String(err));
    }

    const res = await portal(request);
    // Cloud's portal answers 404 only when no Stripe customer is linked to the account.
    if (res.status === 404) {
      return fail(404, 'none', {
        code: 'NO_BILLING_ACCOUNT',
        message: `This account has no billing account yet. ${NOTHING_CREATED}`,
        retryable: false,
        fix: { note: `Buy a plan or a bundle first: see ${PRICING_PATH}. The billing account appears once Stripe confirms the purchase.` },
      });
    }
    if (!form) return withNoStore(res);
    if (!res.ok) return redirect(`${ACCOUNT_PATH}?billing=${res.status === 401 ? 'unavailable' : 'failed'}`);
    const { result } = (await res.json()) as { result: { url: string } };
    return redirect(result.url);
  };
}

/** The signed-in account is the caller; agent signatures are cloud's, not the site's. */
async function sessionOnly(request: Request): Promise<AuthResult> {
  const account = await getSignedInAccount(request);
  return account
    ? { ok: true, caller: { keyId: 'site-session', agentId: account.accountId } }
    : { ok: false, reason: 'no signed-in session' };
}

function isForm(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded');
}

function redirect(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { ...extra, location, 'cache-control': 'no-store' } });
}

function withNoStore(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('cache-control', 'no-store');
  return new Response(res.body, { status: res.status, headers });
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...extra, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

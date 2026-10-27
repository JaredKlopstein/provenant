/**
 * Billing HTTP routes: self-serve Checkout and the Stripe billing portal.
 *
 * Each handler is a Web-standard `(Request) => Promise<Response>`, which is the
 * shape a Vercel function exports, e.g.
 * `export const POST = createBillingRoutes({...}).checkout`. The collector
 * mounts the same handlers for local and test use.
 *
 *  - Checkout is public. A person buying a plan cannot send agent-signed
 *    requests, so it takes no RFC 9421 signature. It takes an optional
 *    `client_reference_id` (the Provenant account id) and forwards it to
 *    Stripe, so the webhook can link the new Stripe customer to the account.
 *
 *  - A Cloud subscription is sold once per customer. Meter events are scoped
 *    to the Stripe customer, so a second subscription carrying the metered
 *    overage price would bill the same bundles twice. Before a Cloud session
 *    is created, the customer linked to `client_reference_id` is looked up
 *    and its active subscriptions listed; one that is a Cloud subscription or
 *    carries the overage price gets a 409 pointing to the billing portal.
 *    Monthly checkout needs `client_reference_id` for that reason. The webhook
 *    catches two checkouts that race past this check (webhook.ts).
 *
 *  - The billing portal is for an authenticated caller only. Authentication is
 *    injected: the collector passes its own RFC 9421 check. The customer lookup
 *    is injected too; the webhook-and-persistence work backs it with a store.
 *
 * Nothing a handler returns or logs carries a Stripe key, a price id or a
 * Stripe error body. Stripe's own messages are redacted before they are
 * logged and never returned.
 */
import { z } from 'zod';
import { ProvenantError } from '@lacre/core';
import { PLANS, type PlanId } from '../pricing.js';
import { genericError } from '../errors.js';
import {
  createCheckoutSession, createPortalSession, carriesPrice, activeSubscriptions,
  type BillingInterval, type StripeLike, type SubscriptionLister, type SubscriptionSummary,
} from './stripe.js';
import {
  loadBillingConfig, createStripeClient, redact, PRICE_ENV,
  type BillingConfig, type BillingMode, type CatalogKey,
} from './config.js';

export type BillingHandler = (request: Request) => Promise<Response>;

/** Where the routes are mounted in the collector. */
export const BILLING_PATHS = {
  checkout: '/billing/checkout',
  portal: '/billing/portal',
} as const;

/** Who an authenticated request came from. */
export interface BillingCaller {
  /** RFC 9421 keyid the request was signed with. */
  keyId: string;
  /** The agent that key is registered to. */
  agentId: string;
}

export type AuthResult = { ok: true; caller: BillingCaller } | { ok: false; reason: string };

/** Verifies a request. `body` is the bytes already read from it. */
export type Authenticate = (request: Request, body: Uint8Array) => AuthResult | Promise<AuthResult>;

export interface CustomerLookup {
  /** The Stripe customer id linked to this caller, or null if there is none. */
  stripeCustomerId(caller: BillingCaller): string | null | Promise<string | null>;
}

export interface BillingRoutesOptions {
  /** Defaults to process.env. Read once, when the routes are created. */
  env?: Record<string, string | undefined>;
  /** Defaults to a real Stripe client for the loaded config. Tests inject a fake. */
  stripe?: StripeLike & SubscriptionLister;
  customers: CustomerLookup;
  authenticate: Authenticate;
  successUrl: string;
  cancelUrl: string;
  /** Where the billing portal sends the customer back to. */
  returnUrl: string;
  /** Receives one line per failure, already redacted. Defaults to console.error. */
  log?: (line: string) => void;
}

export interface BillingRoutes {
  mode: BillingMode;
  checkout: BillingHandler;
  portal: BillingHandler;
}

const MAX_BODY_BYTES = 16 * 1024;
const REDACTED = '[redacted]';
const PRICE_ID = /\bprice_[A-Za-z0-9]+/g;

/**
 * Loads billing config from the environment and builds both handlers. Throws,
 * naming the variables and no values, when config is missing or malformed, or
 * when a live key is set without PROVENANT_BILLING_MODE=live. A server that
 * calls this at startup therefore refuses to start rather than charge by
 * accident.
 */
export function createBillingRoutes(opts: BillingRoutesOptions): BillingRoutes {
  // Without the overage price only monthly checkout is refused, per request:
  // annual and bundle checkout do not sell it.
  const config = loadBillingConfig(opts.env ?? process.env, ['stripe', 'prices'], { optionalPrices: ['overage_bundle'] });
  const stripe = opts.stripe ?? (createStripeClient(config) as unknown as StripeLike & SubscriptionLister);
  const log = opts.log ?? ((line: string) => console.error(line));
  const ctx: Context = { config, stripe, log: (line) => log(scrub(config, line)) };
  return {
    mode: config.mode,
    checkout: (request) => checkout(ctx, opts, request),
    portal: (request) => portal(ctx, opts, request),
  };
}

interface Context {
  config: BillingConfig;
  stripe: StripeLike & SubscriptionLister;
  log: (line: string) => void;
}

const CheckoutRequest = z.strictObject({
  kind: z.enum(['subscription', 'payg_bundle']).optional(),
  plan: z.string().optional(),
  interval: z.string().optional(),
  client_reference_id: z.string().optional(),
});

const CHECKOUT_EXAMPLES =
  'POST {"plan":"cloud","interval":"month","client_reference_id":"<your Provenant account id>"} or ' +
  '{"plan":"cloud","interval":"year"} for the Cloud subscription, or {"kind":"payg_bundle"} for one ' +
  'evidence bundle. "client_reference_id" links the purchase to your account; monthly checkout requires it.';

async function checkout(ctx: Context, opts: BillingRoutesOptions, request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(request.method);
  try {
    const body = await readBody(request);
    if (body === null) return tooLarge();
    const input = parseCheckout(body);

    const key: CatalogKey = input.kind === 'payg_bundle' ? 'payg_bundle' : `cloud_${input.interval}`;
    const priceId = ctx.config.prices[key];
    if (!priceId) return notConfigured(ctx, key);
    // A monthly plan whose overage cannot bill is not sold.
    const overagePriceId = ctx.config.prices.overage_bundle;
    if (input.kind === 'subscription' && input.interval === 'month' && !overagePriceId) {
      return notConfigured(ctx, 'overage_bundle');
    }

    if (input.kind === 'subscription' && input.clientReferenceId) {
      let existing: SubscriptionSummary[];
      try {
        existing = await existingSubscriptions(ctx, opts, input.clientReferenceId);
      } catch (err) {
        ctx.log(`billing checkout: Stripe refused to list the customer's subscriptions: ${describe(err)}`);
        return upstream('checkout session');
      }
      if (existing.some((sub) => conflicts(ctx.config, sub))) return alreadySubscribed();
    }

    const common = {
      priceId,
      successUrl: opts.successUrl,
      cancelUrl: opts.cancelUrl,
      ...(input.clientReferenceId ? { clientReferenceId: input.clientReferenceId } : {}),
    };
    let session: { url: string | null };
    try {
      session = await createCheckoutSession(
        ctx.stripe,
        input.kind === 'payg_bundle'
          ? { kind: 'payg_bundle', ...common }
          : {
              kind: 'subscription', planId: 'cloud', interval: input.interval, ...common,
              ...(input.interval === 'month' ? { overagePriceId } : {}),
            },
      );
    } catch (err) {
      ctx.log(`billing checkout: Stripe refused to create a session: ${describe(err)}`);
      return upstream('checkout session');
    }
    if (!session.url) {
      ctx.log('billing checkout: Stripe returned a session with no url');
      return upstream('checkout session');
    }
    return json(200, {
      ok: true,
      result: { url: session.url, mode: input.kind === 'payg_bundle' ? 'payment' : 'subscription' },
    });
  } catch (err) {
    if (err instanceof ProvenantError) return json(400, err.toJSON());
    ctx.log(`billing checkout: ${describe(err)}`);
    return internal();
  }
}

/** The active subscriptions of the Stripe customer linked to the account, or
 *  none when no customer is linked yet. */
async function existingSubscriptions(ctx: Context, opts: BillingRoutesOptions, accountId: string): Promise<SubscriptionSummary[]> {
  // The lookup keys on the account id, which is the account's agent id. A
  // public checkout is not signed, so there is no key id.
  const customer = await opts.customers.stripeCustomerId({ keyId: '', agentId: accountId });
  return customer ? activeSubscriptions(ctx.stripe, customer) : [];
}

/** A Cloud subscription, monthly or annual, or anything carrying the metered
 *  overage price (an annual customer's separate overage subscription). A new
 *  Cloud subscription beside either would bill the same overage twice. */
function conflicts(config: BillingConfig, sub: SubscriptionSummary): boolean {
  const { cloud_month: month, cloud_year: year, overage_bundle: overage } = config.prices;
  return (
    sub.metadata?.provenant_plan === 'cloud' ||
    [month, year, overage].some((price) => !!price && carriesPrice(sub, price))
  );
}

type ParsedCheckout =
  | { kind: 'payg_bundle'; clientReferenceId?: string }
  | { kind: 'subscription'; interval: BillingInterval; clientReferenceId?: string };

function parseCheckout(body: Uint8Array): ParsedCheckout {
  let raw: unknown;
  try {
    raw = body.length ? JSON.parse(new TextDecoder().decode(body)) : {};
  } catch {
    throw invalid('The request body is not valid JSON.');
  }
  const r = CheckoutRequest.safeParse(raw);
  if (!r.success) {
    throw invalid(r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ') + '.');
  }
  const { kind = 'subscription', plan, interval, client_reference_id: ref } = r.data;

  // Stripe caps client_reference_id at 200 characters.
  if (ref !== undefined && !/^[\x21-\x7E]{1,200}$/.test(ref)) {
    throw invalid('client_reference_id must be 1 to 200 printable characters with no spaces.');
  }
  const clientReferenceId = ref ? { clientReferenceId: ref } : {};

  if (kind === 'payg_bundle') {
    if (plan !== undefined || interval !== undefined) {
      throw invalid('A pay-as-you-go bundle is a one-time purchase and takes no plan or interval.');
    }
    return { kind, ...clientReferenceId };
  }

  if (plan === 'enterprise') {
    throw new ProvenantError({
      code: 'INVALID_INPUT',
      message: 'Enterprise is not sold through self-serve checkout. Nothing was charged.',
      retryable: false,
      fix: { note: 'Enterprise is billed by contract: contact us. Self-serve checkout sells the Cloud plan and pay-as-you-go bundles.' },
    });
  }
  if (plan === 'free') {
    throw invalid('The free tier needs no checkout.');
  }
  if (plan === undefined || !(plan in PLANS) || !PLANS[plan as PlanId].monthlyUsd) {
    throw invalid(plan === undefined ? 'plan is required for a subscription.' : 'Unknown plan.');
  }
  if (interval !== 'month' && interval !== 'year') {
    throw invalid('interval must be "month" or "year".');
  }
  if (interval === 'month' && !ref) {
    throw invalid(
      'Monthly Cloud checkout needs client_reference_id, your Provenant account id, so an existing ' +
        'subscription can be checked first and no overage is billed twice.',
    );
  }
  return { kind, interval, ...clientReferenceId };
}

async function portal(ctx: Context, opts: BillingRoutesOptions, request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(request.method);
  try {
    const body = await readBody(request);
    if (body === null) return tooLarge();

    const auth = await opts.authenticate(request, body);
    if (!auth.ok) {
      return json(401, {
        error: {
          code: 'SIGNATURE_INVALID',
          message: `Request signature rejected: ${auth.reason}. No portal session was created.`,
          retryable: false,
          fix: {
            note:
              'The billing portal is for registered agents. Sign with RFC 9421 Ed25519 covering @method, ' +
              '@authority and @path, created within 60 seconds. See GET /discover for a worked example.',
          },
        },
      });
    }

    const customerId = await opts.customers.stripeCustomerId(auth.caller);
    if (!customerId) {
      return json(404, {
        error: {
          code: 'CUSTOMER_NOT_FOUND',
          message: 'No billing account is linked to this agent. No portal session was created.',
          retryable: false,
          fix: {
            note:
              `Buy a plan with POST ${BILLING_PATHS.checkout}, passing your Provenant account id as ` +
              'client_reference_id. The link appears once Stripe confirms the purchase.',
          },
        },
      });
    }

    let session: { url: string };
    try {
      session = await createPortalSession(ctx.stripe, customerId, opts.returnUrl);
    } catch (err) {
      ctx.log(`billing portal: Stripe refused to create a session: ${describe(err)}`);
      return upstream('billing portal session');
    }
    return json(200, { ok: true, result: { url: session.url } });
  } catch (err) {
    ctx.log(`billing portal: ${describe(err)}`);
    return internal();
  }
}

/** Removes secrets, price ids and anything shaped like either. */
function scrub(config: BillingConfig, text: string): string {
  const priceIds = Object.values(config.prices).filter((p): p is string => !!p);
  return config.redact(redact(text, priceIds)).replace(PRICE_ID, REDACTED);
}

/** Type, code and message only: never the raw Stripe response body. */
function describe(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { type?: unknown; code?: unknown; statusCode?: unknown; message?: unknown };
    const parts = [e.type, e.code, e.statusCode, e.message].filter((v) => v !== undefined && v !== null);
    if (parts.length) return parts.map(String).join(' ');
  }
  return String(err);
}

async function readBody(request: Request): Promise<Uint8Array | null> {
  const body = new Uint8Array(await request.arrayBuffer());
  return body.length > MAX_BODY_BYTES ? null : body;
}

function invalid(message: string): ProvenantError {
  return new ProvenantError({
    code: 'INVALID_INPUT',
    message: `${message} Nothing was charged.`,
    retryable: false,
    fix: { note: CHECKOUT_EXAMPLES },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function methodNotAllowed(method: string): Response {
  return json(405, {
    error: {
      code: 'METHOD_NOT_ALLOWED',
      message: `${method} is not supported here. Nothing was charged.`,
      retryable: false,
      fix: { note: 'Use POST.' },
    },
  });
}

function tooLarge(): Response {
  return json(413, {
    error: {
      code: 'BODY_TOO_LARGE',
      message: `Request body exceeds ${MAX_BODY_BYTES} bytes. Nothing was charged.`,
      retryable: false,
      fix: { note: CHECKOUT_EXAMPLES },
    },
  });
}

/** The variable name and the fix go to the server log, never to the client. */
function notConfigured(ctx: Context, key: CatalogKey): Response {
  return genericError({
    status: 503,
    code: 'BILLING_UNAVAILABLE',
    message: 'This purchase is not configured on the server. Nothing was charged.',
    retryable: false,
    cause: `billing checkout: the operator must set ${PRICE_ENV[key]}; provenant-cloud billing sync prints its value.`,
    log: ctx.log,
  });
}

function alreadySubscribed(): Response {
  return json(409, {
    error: {
      code: 'ALREADY_SUBSCRIBED',
      message:
        'This account already has an active Cloud subscription or overage billing, and a second one would ' +
        'bill the same evidence bundles twice. No checkout session was created. Nothing was charged.',
      retryable: false,
      fix: {
        note:
          `Change, switch or cancel the existing plan in the billing portal: POST ${BILLING_PATHS.portal}, ` +
          "signed by the account's agent.",
      },
    },
  });
}

function upstream(what: string): Response {
  return json(502, {
    error: {
      code: 'BILLING_UNAVAILABLE',
      message: `Stripe did not create the ${what}. Nothing was charged.`,
      retryable: true,
      fix: { note: 'Retry shortly. If it keeps failing, the operator can find the reason in the server log.' },
    },
  });
}

function internal(): Response {
  return json(500, { error: { code: 'INTERNAL', message: 'internal error. Nothing was charged.', retryable: true } });
}

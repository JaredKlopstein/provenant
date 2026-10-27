/**
 * The Stripe webhook: the only way plan state changes.
 *
 * The handler is a Web-standard `(Request) => Promise<Response>`, the shape a
 * Vercel function exports:
 *
 *   export const POST = createBillingWebhook().webhook;
 *
 * The collector mounts the same handler at /billing/webhook for local and test
 * use.
 *
 *  - Every request is verified first, with Stripe's own check
 *    (`webhooks.constructEvent`) on the exact bytes received, against
 *    STRIPE_WEBHOOK_SECRET. A missing, bad or stale signature gets 400 and the
 *    database is never opened.
 *
 *  - Each event is applied once. Its id is recorded in the same transaction as
 *    its effects, so a replay is a no-op and a failure leaves nothing behind
 *    for Stripe's retry to trip over (see store.ts).
 *
 *  - The account link is checkout's client_reference_id. Checkout is public and
 *    the id is whatever the buyer sent, so it is only ever written into an empty
 *    link. A conflicting one changes nothing and logs one warning, without
 *    either id.
 *
 *  - A customer never keeps two active subscriptions carrying the metered
 *    overage price: meter events are scoped to the customer, so Stripe would
 *    bill every bundle on both. Checkout refuses a second one (routes.ts), but
 *    two checkouts opened at once can both pass that check. So on
 *    checkout.session.completed and customer.subscription.created / .updated
 *    the customer's active subscriptions are listed again, and each newer one
 *    carrying the metered price has its paid latest-invoice charge refunded in
 *    full and is cancelled with no proration, and one alert is logged. Only an
 *    active subscription is acted on, a refund is made only when the charge
 *    has none (idempotency key: the charge id), and the claim is keyed on the
 *    cancelled subscription id, so a replay does all three at most once.
 *
 *  - DATABASE_URL comes from the environment through the billing config, and
 *    the Neon connection opens on the first verified event. Nothing here runs
 *    a migration.
 *
 * Logs never carry the payload, the signature header, the webhook secret,
 * DATABASE_URL or a Stripe or account id: every line is redacted against the
 * config and against the ids in the event being handled. The one exception is
 * the duplicate-subscription alert, which names the customer and the
 * subscriptions so the owner can act on it, and nothing else: no price id,
 * key or card data.
 */
import Stripe from 'stripe';
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { PLANS, type PlanId } from '../pricing.js';
import { loadBillingConfig, createStripeClient, redact, type BillingConfig, type BillingMode } from './config.js';
import { billingSchema } from './schema.js';
import {
  applyEventOnce, linkCustomer, saveSubscription, updateSubscription, creditBundle, claimDuplicateCancel,
  type BillingDb, type BillingTx, type LinkResult,
} from './store.js';
import { activeSubscriptions, carriesPrice, type SubscriptionLister, type SubscriptionSummary } from './stripe.js';
import type { BillingHandler } from './routes.js';

/** Where the collector mounts the webhook. */
export const BILLING_WEBHOOK_PATH = '/billing/webhook';

/** The events this webhook applies. Anything else is acknowledged and ignored. */
export const BILLING_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
] as const;

export interface BillingWebhookLog {
  warn(line: string): void;
  error(line: string): void;
}

type Ref = string | { id: string } | null | undefined;

/** The slice of Stripe the duplicate-metered guard uses. Injected; tests pass a fake. */
export interface DuplicateGuardStripe {
  subscriptions: SubscriptionLister['subscriptions'] & {
    cancel(id: string, params: Record<string, unknown>): Promise<{ id: string; status: string }>;
  };
  invoices: {
    retrieve(id: string, params: Record<string, unknown>): Promise<{
      id: string;
      payments?: {
        data: Array<{
          status: string;
          payment: { charge?: Ref; payment_intent?: string | { id: string; latest_charge?: Ref } | null };
        }>;
      } | null;
    }>;
  };
  refunds: {
    list(params: Record<string, unknown>): Promise<{ data: Array<{ id: string }> }>;
    create(params: Record<string, unknown>, options: { idempotencyKey: string }): Promise<{ id: string }>;
  };
}

export interface BillingWebhookOptions {
  /** Defaults to process.env. Read once, when the webhook is created. Needs
   *  STRIPE_WEBHOOK_SECRET, DATABASE_URL, and, for the duplicate-metered
   *  guard, STRIPE_SECRET_KEY and STRIPE_PRICE_BUNDLE_OVERAGE. */
  env?: Record<string, string | undefined>;
  /** Defaults to a real Stripe client for the loaded config. Tests inject a fake. */
  stripe?: DuplicateGuardStripe;
  /** Opens the database for DATABASE_URL. Called once, on the first verified
   *  event. Defaults to the Neon serverless driver; tests pass PGlite. */
  connect?: (databaseUrl: string) => BillingDb | Promise<BillingDb>;
  /** Receives each line already redacted. Defaults to console.warn and console.error. */
  log?: BillingWebhookLog;
}

export interface BillingWebhook {
  mode: BillingMode;
  webhook: BillingHandler;
}

/** A Stripe event carries the whole object; anything near this is not Stripe. */
const MAX_BODY_BYTES = 1024 * 1024;
const REDACTED = '[redacted]';
/** Stripe object ids, by prefix. Logged lines never carry one. */
const STRIPE_ID = /\b(cus|sub|si|cs|pi|in|il|ii|ch|evt|price|prod|pm|seti|src|card)_[A-Za-z0-9]+/g;
/** The same, less the customer and subscription ids the alert names. */
const ALERT_REDACTED_ID = /\b(si|cs|pi|in|il|ii|ch|evt|price|prod|pm|seti|src|card)_[A-Za-z0-9]+/g;

/** What the duplicate-metered guard needs. */
interface Guard {
  stripe: DuplicateGuardStripe;
  overagePriceId: string;
  alert(line: string): void;
}

/**
 * Loads the webhook secret, DATABASE_URL, the Stripe key and the overage price
 * id from the environment and builds the handler. Throws, naming the variables
 * and no values, when any is missing or malformed, so a server that calls this
 * at startup refuses to start rather than run without the guard.
 */
export function createBillingWebhook(opts: BillingWebhookOptions = {}): BillingWebhook {
  const config = loadBillingConfig(
    opts.env ?? process.env,
    ['webhook', 'database', 'stripe', 'prices'],
    { prices: ['overage_bundle'] },
  );
  const sink = opts.log ?? { warn: (l: string) => console.warn(l), error: (l: string) => console.error(l) };
  const guard: Guard = {
    stripe: opts.stripe ?? (createStripeClient(config) as unknown as DuplicateGuardStripe),
    overagePriceId: config.prices.overage_bundle!,
    alert: (line) => sink.error(config.redact(redact(line, [config.prices.overage_bundle!])).replace(ALERT_REDACTED_ID, REDACTED)),
  };
  const connect = opts.connect ?? ((url: string) => connectNeon(url, (l) => sink.error(scrub(config, l, []))));

  let db: Promise<BillingDb> | null = null;
  const database = (): Promise<BillingDb> => {
    db ??= Promise.resolve()
      .then(() => connect(config.databaseUrl!))
      .catch((err: unknown) => {
        db = null; // try again on the next event
        throw err;
      });
    return db;
  };

  return {
    mode: config.mode,
    webhook: (request) => handle(config, sink, database, guard, request),
  };
}

/** The Neon serverless driver over a WebSocket pool, which supports the
 *  transactions the store needs. Opening it makes no connection. */
function connectNeon(databaseUrl: string, onError: (line: string) => void): BillingDb {
  const pool = new Pool({ connectionString: databaseUrl });
  // An idle client's error would otherwise be thrown as an unhandled event.
  pool.on('error', (err: unknown) => onError(`billing webhook: database pool error: ${describe(err)}`));
  return drizzle({ client: pool, schema: billingSchema });
}

async function handle(
  config: BillingConfig,
  sink: BillingWebhookLog,
  database: () => Promise<BillingDb>,
  guard: Guard,
  request: Request,
): Promise<Response> {
  if (request.method !== 'POST') {
    return reply(405, 'METHOD_NOT_ALLOWED', `${request.method} is not supported here. Nothing was written.`, 'Stripe sends POST.');
  }

  let event: Stripe.Event;
  try {
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.length > MAX_BODY_BYTES) {
      return reply(413, 'BODY_TOO_LARGE', `Request body exceeds ${MAX_BODY_BYTES} bytes.`, SIGNATURE_FIX);
    }
    const signature = request.headers.get('stripe-signature');
    if (!signature) {
      return reply(400, 'SIGNATURE_INVALID', 'The Stripe-Signature header is missing.', SIGNATURE_FIX);
    }
    // The raw bytes, exactly as received: re-serialized JSON would not verify.
    event = Stripe.webhooks.constructEvent(body, signature, config.webhookSecret!);
  } catch (err) {
    // The error type only: Stripe's message can quote the header.
    const type = err && typeof err === 'object' && 'type' in err ? String(err.type) : 'Error';
    sink.warn(scrub(config, `billing webhook: signature verification failed (${type}). Nothing was written.`, []));
    return reply(400, 'SIGNATURE_INVALID', 'The Stripe signature did not verify.', SIGNATURE_FIX);
  }

  const ids = idsIn(event);
  const log: BillingWebhookLog = {
    warn: (line) => sink.warn(scrub(config, line, ids)),
    error: (line) => sink.error(scrub(config, line, ids)),
  };

  if (!(BILLING_WEBHOOK_EVENTS as readonly string[]).includes(event.type)) {
    return ok({ type: event.type, handled: false, duplicate: false });
  }

  try {
    const outcome = await applyEventOnce(await database(), event, (tx) => apply(tx, event, log, guard));
    return ok({ type: event.type, handled: true, duplicate: outcome.duplicate });
  } catch (err) {
    if (err instanceof NotYetKnown) {
      log.warn(`billing webhook: ${event.type} ${err.message}. Nothing was written; Stripe will retry.`);
      return reply(409, 'NOT_YET_KNOWN', `${err.message}. Nothing was written.`, 'Retry later; the order of Stripe events is not guaranteed.', true);
    }
    log.error(`billing webhook: ${event.type} failed: ${describe(err)}`);
    return reply(500, 'INTERNAL', 'internal error. Nothing was written.', 'Retry; the event has not been applied.', true);
  }
}

const SIGNATURE_FIX =
  'Send the raw request body unchanged, with the Stripe-Signature header Stripe set, signed with ' +
  'the endpoint secret in STRIPE_WEBHOOK_SECRET, within five minutes of signing. Nothing was written.';

/** A subscription event arrived before the event that records the subscription. */
class NotYetKnown extends Error {}

async function apply(tx: BillingTx, event: Stripe.Event, log: BillingWebhookLog, guard: Guard): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      await checkoutCompleted(tx, session, log);
      // The session does not list its items; the guard reads them from Stripe.
      const customer = idOf(session.customer);
      if (session.mode === 'subscription' && customer) await cancelDuplicateMetered(tx, guard, customer);
      return;
    }
    case 'customer.subscription.created':
      return guardSubscription(tx, guard, event.data.object);
    case 'customer.subscription.updated':
      await saveSubscription(tx, subscriptionState(event.data.object), 'upsert');
      return guardSubscription(tx, guard, event.data.object);
    case 'customer.subscription.deleted':
      return saveSubscription(tx, { ...subscriptionState(event.data.object), status: 'canceled' }, 'upsert');
    case 'invoice.paid': {
      const sub = invoiceSubscription(event.data.object);
      if (!sub) return; // not a subscription invoice
      const period = invoicePeriod(event.data.object);
      if (!(await updateSubscription(tx, sub, period ?? {}))) {
        throw new NotYetKnown('is for a subscription that is not recorded yet');
      }
      return;
    }
    case 'invoice.payment_failed': {
      const sub = invoiceSubscription(event.data.object);
      if (!sub) return;
      if (!(await updateSubscription(tx, sub, { status: 'past_due' }))) {
        throw new NotYetKnown('is for a subscription that is not recorded yet');
      }
      return;
    }
  }
}

async function checkoutCompleted(tx: BillingTx, session: Stripe.Checkout.Session, log: BillingWebhookLog): Promise<void> {
  const customer = idOf(session.customer);
  const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';

  if (customer) {
    const link = await linkCustomer(tx, customer, session.client_reference_id);
    if (link === 'customer_linked_elsewhere' || link === 'account_linked_elsewhere') {
      log.warn(mismatchWarning(link));
    }
  }

  if (session.mode === 'subscription') {
    const subscription = idOf(session.subscription);
    if (!customer || !subscription) throw new Error('subscription checkout completed with no customer or subscription');
    const interval = session.metadata?.provenant_interval;
    if (interval !== 'month' && interval !== 'year') {
      throw new Error('subscription checkout carries no provenant_interval; it was not created by the checkout route');
    }
    await saveSubscription(tx, {
      stripeSubscriptionId: subscription,
      stripeCustomerId: customer,
      plan: planOf(session.metadata?.provenant_plan) ?? 'cloud',
      interval,
      status: paid ? 'active' : 'incomplete',
    }, 'insert-only');
    return;
  }

  if (session.mode === 'payment' && session.metadata?.provenant_purchase === 'payg_bundle' && session.payment_status === 'paid') {
    await creditBundle(tx, {
      stripeCheckoutSessionId: session.id,
      stripeCustomerId: customer,
      stripePaymentIntentId: idOf(session.payment_intent),
    });
  }
}

function mismatchWarning(link: 'customer_linked_elsewhere' | 'account_linked_elsewhere'): string {
  const what = link === 'customer_linked_elsewhere'
    ? 'the Stripe customer is already linked to a different Lacre account'
    : 'the Lacre account is already linked to a different Stripe customer';
  return (
    `billing webhook: warning: checkout.session.completed carried a client_reference_id, but ${what}. ` +
    'No link was changed and no customer moved account. Look the checkout session up in the Stripe ' +
    'dashboard if this was not expected.'
  );
}

/** Runs the guard when an active subscription carrying the metered price appears. */
async function guardSubscription(tx: BillingTx, guard: Guard, sub: Stripe.Subscription): Promise<void> {
  const customer = idOf(sub.customer);
  if (sub.status !== 'active' || !customer || !sub.items.data.some((i) => i.price.id === guard.overagePriceId)) return;
  await cancelDuplicateMetered(tx, guard, customer);
}

/**
 * Keeps the customer's oldest active subscription carrying the metered price.
 * Each newer one is refunded, then cancelled, then alerted on, once: refund
 * first, so a failure part way leaves the subscription active and the retry
 * finishes the job.
 */
async function cancelDuplicateMetered(tx: BillingTx, guard: Guard, customer: string): Promise<void> {
  const metered = (await activeSubscriptions(guard.stripe, customer))
    .filter((s) => carriesPrice(s, guard.overagePriceId))
    .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  const [kept, ...newer] = metered;
  for (const sub of newer) {
    if (!(await claimDuplicateCancel(tx, sub.id))) continue;
    const refunded = await refundLatestCharge(guard.stripe, sub);
    await guard.stripe.subscriptions.cancel(sub.id, { prorate: false, invoice_now: false });
    guard.alert(
      `billing webhook: alert: customer ${customer} had two active subscriptions carrying the metered ` +
        `overage price, so every overage bundle would bill twice. Cancelled the newer, ${sub.id}, at once ` +
        `with no proration${refunded ? ', and refunded its paid charge in full' : '; it had no paid charge to refund'}. ` +
        `Kept ${kept!.id}. Tell the customer; nothing else needs doing.`,
    );
  }
}

/** Refunds, in full, each paid charge on the subscription's latest invoice
 *  that has no refund yet. True when there was a paid charge. */
async function refundLatestCharge(stripe: DuplicateGuardStripe, sub: SubscriptionSummary): Promise<boolean> {
  const invoiceId = idOf(sub.latest_invoice);
  if (!invoiceId) return false;
  // Stripe returns an invoice's payments only when asked for them.
  const invoice = await stripe.invoices.retrieve(invoiceId, { expand: ['payments', 'payments.data.payment.payment_intent'] });
  let paid = false;
  for (const { status, payment } of invoice.payments?.data ?? []) {
    if (status !== 'paid') continue;
    const intent = payment.payment_intent;
    const charge = idOf(payment.charge) ?? (intent && typeof intent === 'object' ? idOf(intent.latest_charge) : null);
    if (!charge) throw new Error('a paid invoice payment carries no charge to refund');
    paid = true;
    const existing = await stripe.refunds.list({ charge, limit: 1 });
    if (existing.data.length) continue;
    await stripe.refunds.create({ charge, reason: 'duplicate' }, { idempotencyKey: charge });
  }
  return paid;
}

function subscriptionState(sub: Stripe.Subscription) {
  const item = sub.items.data[0];
  const interval = item?.price.recurring?.interval ?? sub.metadata.provenant_interval;
  if (!interval) throw new Error('subscription has no recurring interval');
  return {
    stripeSubscriptionId: sub.id,
    stripeCustomerId: idOf(sub.customer)!,
    stripePriceId: item?.price.id ?? null,
    plan: planOf(sub.metadata.provenant_plan) ?? planOf(item?.price.metadata.plan_id) ?? 'cloud',
    interval,
    status: sub.status,
    currentPeriodStart: item ? fromUnix(item.current_period_start) : null,
    currentPeriodEnd: item ? fromUnix(item.current_period_end) : null,
  };
}

function invoiceSubscription(invoice: Stripe.Invoice): string | null {
  return idOf(invoice.parent?.subscription_details?.subscription ?? null);
}

/** The service period the invoice paid for, from its subscription lines. */
function invoicePeriod(invoice: Stripe.Invoice): { currentPeriodStart: Date; currentPeriodEnd: Date } | null {
  const lines = invoice.lines?.data ?? [];
  const subLines = lines.filter((l) => l.parent?.type === 'subscription_item_details');
  const latest = (subLines.length ? subLines : lines).reduce<Stripe.InvoiceLineItem | null>(
    (best, l) => (!best || l.period.end > best.period.end ? l : best),
    null,
  );
  return latest ? { currentPeriodStart: fromUnix(latest.period.start), currentPeriodEnd: fromUnix(latest.period.end) } : null;
}

function planOf(value: unknown): PlanId | null {
  return typeof value === 'string' && Object.hasOwn(PLANS, value) ? (value as PlanId) : null;
}

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

function fromUnix(seconds: number): Date {
  return new Date(seconds * 1000);
}

/** Every id in the event a log line could pick up, for redaction. */
function idsIn(event: Stripe.Event): string[] {
  const obj = event.data.object as unknown as Record<string, unknown>;
  const ids = [event.id, String(obj.id ?? '')];
  for (const key of ['customer', 'subscription', 'payment_intent', 'client_reference_id', 'invoice']) {
    const v = obj[key];
    const id = typeof v === 'string' ? v : v && typeof v === 'object' && 'id' in v ? String(v.id) : null;
    if (id) ids.push(id);
  }
  return ids.filter(Boolean);
}

/** Secrets, DATABASE_URL and its parts, the event's ids, and anything shaped like a Stripe id. */
function scrub(config: BillingConfig, text: string, ids: readonly string[]): string {
  return config.redact(redact(text, ids)).replace(STRIPE_ID, REDACTED);
}

/**
 * Name, SQLSTATE and message of the underlying error. drizzle wraps a failed
 * query in an error whose message lists the query's parameters, so the cause
 * is described instead of the wrapper.
 */
function describe(err: unknown): string {
  let e = err;
  while (e && typeof e === 'object' && 'cause' in e && e.cause && /Failed query/.test(String((e as Error).message))) {
    e = e.cause;
  }
  if (e && typeof e === 'object') {
    const x = e as { name?: unknown; code?: unknown; message?: unknown };
    const parts = [x.name, x.code, x.message].filter((v) => v !== undefined && v !== null && v !== '');
    if (parts.length) return parts.map(String).join(' ');
  }
  return String(e);
}

function ok(result: { type: string; handled: boolean; duplicate: boolean }): Response {
  return json(200, { ok: true, result });
}

function reply(status: number, code: string, message: string, note: string, retryable = false): Response {
  return json(status, { error: { code, message, retryable, fix: { note } } });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

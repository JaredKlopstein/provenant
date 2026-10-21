/**
 * Magic-link send: takes an email from the signup page and mails it a sign-in link.
 *
 * Off by default. It answers 503 and sends nothing unless MAGIC_LINK_ENABLED=1,
 * and the flag is honored only with the send rate limiter wired in: without
 * DATABASE_URL, or without its table, the route answers 503 rather than send
 * unlimited. It also answers 503 when SESSION_SECRET or any EMAIL_* variable is
 * unset, or when no link base can be worked out. The link base never comes from
 * the request.
 *
 * The answer is the same for every valid address, and the same again when a send
 * is over a rate limit: nothing is sent, and nothing in the response says so.
 * There is no account lookup: an account is the hash of its email and comes into
 * being when the link is used.
 *
 * An optional `for` field (a DESTINATIONS key: checkout, account or welcome) is
 * signed into the link as its `dest` claim and picks where the callback lands.
 * Any other value is ignored and the link lands on checkout, as one without it.
 *
 * Like the contact route, it accepts the page's native form post (answered with a
 * 303 back to the page) and JSON (answered with JSON, every error carrying its fix).
 * A 503 is generic and names no variable or migration: the cause goes only to the
 * log, under the request id the response carries (x-request-id, and requestId in
 * JSON).
 */
import {
  AUTH_ENV,
  MAGIC_LINK_FLAG_ENV,
  MAX_EMAIL_LENGTH,
  SIGNUP_PATH,
  authConfig,
  isEmailAddress,
  linkBase,
  magicLink,
  magicLinkEnabled,
  sendMagicLinkEmail,
  type SignupOutcome,
} from '../../../../src/auth/email';
import { allowSend, clientIp } from '../../../../src/auth/rate-limit';
import { createLinkToken, normalizeEmail, parseDestination } from '../../../../src/auth/session';
// The site's auth database (DATABASE_URL), shared with the used-link table.
import { DATABASE_URL_ENV, usedTokenDb } from '../../../../src/auth/used-tokens';

const MAX_BODY_BYTES = 4 * 1024;
const RATE_MIGRATION = 'packages/site/migrations/0001_magic_link_rate.sql';
const NOTHING_SENT = 'Nothing was sent.';
const SENT = 'If that address can receive email, a sign-in link is on its way. It expires in 15 minutes.';

interface ErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  fix?: { note: string };
}

export async function POST(request: Request): Promise<Response> {
  const form = isForm(request);
  const reply = (status: number, outcome: SignupOutcome, body: object, headers: Record<string, string> = {}) =>
    form
      ? new Response(null, { status: 303, headers: { ...headers, location: `${SIGNUP_PATH}?signup=${outcome}` } })
      : json(status, body, headers);
  const fail = (status: number, outcome: SignupOutcome, error: ErrorBody) => reply(status, outcome, { error });
  const unavailable = (cause: string) => {
    const requestId = crypto.randomUUID();
    console.error(`auth: request ${requestId}: ${cause}`);
    const error: ErrorBody = {
      code: 'SIGNUP_UNAVAILABLE',
      message: `Sign-in is unavailable right now. ${NOTHING_SENT}`,
      retryable: false,
      fix: { note: `The site operator must finish the server configuration. Quote request id ${requestId}.` },
    };
    return reply(503, 'unavailable', { error, requestId }, { 'x-request-id': requestId });
  };

  if (!magicLinkEnabled()) return unavailable(`sending is off; ${MAGIC_LINK_FLAG_ENV} is not 1`);
  const config = authConfig();
  if (!config) return unavailable(`not configured; ${authCause()}`);
  const base = linkBase();
  if (!base) return unavailable('no link base; set BRAND.domain, SITE_BASE_URL or VERCEL_URL');
  const db = usedTokenDb();
  if (!db) return unavailable(`${DATABASE_URL_ENV} is not set; the send rate limit is kept there`);

  const raw = await request.text();
  const tooLarge = new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES;
  const fields = tooLarge ? { email: '', for: null } : readFields(request, raw);
  const email = normalizeEmail(fields.email);
  if (!isEmailAddress(email)) {
    return fail(400, 'invalid', {
      code: 'INVALID_INPUT',
      message: `Body must carry "email", a valid email address of at most ${MAX_EMAIL_LENGTH} characters. ${NOTHING_SENT}`,
      retryable: false,
      fix: { note: 'Send {"email": "you@example.com"} as JSON, or the signup form field "email".' },
    });
  }

  let allowed: boolean;
  try {
    allowed = await allowSend(db, email, clientIp(request.headers));
  } catch (err) {
    const code = errorCode(err);
    const fix = code === '42P01' ? `; apply ${RATE_MIGRATION}` : '';
    return unavailable(`could not count the send against its rate limit (${code ?? 'no error code'})${fix}`);
  }
  // Over a limit: the same answer as a send, and nothing sent.
  if (!allowed) return reply(200, 'sent', { ok: true, message: SENT });

  const token = await createLinkToken(email, config.secret, parseDestination(fields.for) ?? undefined);
  if (!(await sendMagicLinkEmail(config, email, magicLink(base, token)))) {
    return fail(502, 'failed', {
      code: 'EMAIL_SEND_FAILED',
      message: `The sign-in email could not be sent. ${NOTHING_SENT}`,
      retryable: true,
      fix: { note: 'Retry shortly. If it keeps failing, the operator can find the reason in the server log.' },
    });
  }
  return reply(200, 'sent', { ok: true, message: SENT });
}

/** For the log only: which auth variables are unset, or that one is set but invalid. */
function authCause(): string {
  const unset = AUTH_ENV.filter((name) => !process.env[name]?.trim());
  return unset.length ? `missing ${unset.join(', ')}` : `an invalid value in one of ${AUTH_ENV.join(', ')}`;
}

function isForm(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded');
}

/** The submitted email field ('' when the body has none) and the raw `for` field, if any. */
function readFields(request: Request, raw: string): { email: string; for: unknown } {
  if (isForm(request)) {
    const params = new URLSearchParams(raw);
    return { email: params.get('email') ?? '', for: params.get('for') };
  }
  try {
    const body: unknown = JSON.parse(raw);
    if (typeof body === 'object' && body !== null && 'email' in body && typeof body.email === 'string') {
      return { email: body.email, for: 'for' in body ? body.for : null };
    }
  } catch {
    // Falls through to '', which the caller rejects with its fix.
  }
  return { email: '', for: null };
}

/** The Postgres SQLSTATE of a failed query, if any. drizzle wraps the driver's error in `cause`. */
function errorCode(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...extra, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

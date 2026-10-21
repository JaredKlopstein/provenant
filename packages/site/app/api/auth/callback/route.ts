/**
 * Magic-link callback.
 *
 * GET never signs anyone in and never uses up a link: mail scanners and link
 * previewers fetch every URL they see. An old-style link that lands here with GET
 * is sent on to the confirm page, which shows a "Sign in" button.
 *
 * POST is that button. It must come from this site (the CSRF check in
 * src/auth/confirm.ts). A genuine, unexpired token that has not been used before
 * creates the identity (the account id is the hash of the email it was signed
 * for), sets a 7-day session cookie and redirects to the checkout page. The
 * destination is fixed: no `next`, `redirect` or other parameter can change it. A
 * bad, expired or already-used token goes back to the signup page with the same
 * generic message, so the response never says which.
 *
 * The token is never logged. Responses are no-store so no cache keeps the link.
 * When sign-in cannot run (missing configuration or the used-link table) the
 * answer is generic: the cause goes only to the log, under the request id the
 * response carries.
 */
import { AUTH_ENV, SIGNUP_PATH, authConfig } from '../../../../src/auth/email';
import { fromThisSite } from '../../../../src/auth/confirm';
import { CHECKOUT_PATH, CONFIRM_PATH, accountIdFor, sessionCookie, verifyLinkToken } from '../../../../src/auth/session';
import { DATABASE_URL_ENV, markTokenUsed, usedTokenDb } from '../../../../src/auth/used-tokens';

const NO_STORE = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } as const;
const MIGRATION = 'packages/site/migrations/0000_magic_link_used.sql';
const MAX_BODY_BYTES = 4 * 1024;
const LINK_NOT_VALID = `${SIGNUP_PATH}?signup=expired`;

const text = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(`${body}\n`, {
    status,
    headers: { ...headers, ...NO_STORE, 'content-type': 'text/plain; charset=utf-8' },
  });

/** A 503 that names nothing; `cause` is logged under the request id the response carries. */
function unavailable(cause: string): Response {
  const requestId = crypto.randomUUID();
  console.error(`auth: request ${requestId}: ${cause}`);
  return text(503, `Sign-in is unavailable right now. No session was created. Request id: ${requestId}.`, {
    'x-request-id': requestId,
  });
}

const seeOther = (location: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { ...NO_STORE, location, ...headers } });

/** Forwards to the confirm page. Reads nothing and writes nothing. */
export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get('token');
  if (!token) return seeOther(LINK_NOT_VALID);
  return seeOther(`${CONFIRM_PATH}?${new URLSearchParams({ token })}`);
}

export async function POST(request: Request): Promise<Response> {
  const config = authConfig();
  const db = usedTokenDb();
  if (!config || !db) {
    return unavailable(`not configured; ${[...(config ? [] : [authCause()]), ...(db ? [] : [`missing ${DATABASE_URL_ENV}`])].join('; ')}`);
  }
  if (!fromThisSite(request)) {
    return text(403, 'This sign-in did not come from the sign-in page, so no one was signed in. Open the link from your email again.');
  }

  const token = await readToken(request);
  const claims = token ? await verifyLinkToken(token, config.secret) : null;
  if (!claims) return seeOther(LINK_NOT_VALID);

  let firstUse: boolean;
  try {
    firstUse = await markTokenUsed(db, claims.jti, new Date(claims.exp * 1000));
  } catch (err) {
    const code = errorCode(err);
    const fix = code === '42P01' ? `; apply ${MIGRATION}` : '';
    return unavailable(`could not record the used sign-in link (${code ?? 'no error code'})${fix}`);
  }
  if (!firstUse) return seeOther(LINK_NOT_VALID);

  const cookie = await sessionCookie(await accountIdFor(claims.email), config.secret);
  return seeOther(CHECKOUT_PATH, { 'set-cookie': cookie });
}

/** For the log only: which auth variables are unset, or that one is set but invalid. */
function authCause(): string {
  const unset = AUTH_ENV.filter((name) => !process.env[name]?.trim());
  return unset.length ? `missing ${unset.join(', ')}` : `an invalid value in one of ${AUTH_ENV.join(', ')}`;
}

/** The form's `token` field, or null when the body is not a small form post. */
async function readToken(request: Request): Promise<string | null> {
  if (!(request.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) return null;
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return null;
  return new URLSearchParams(raw).get('token');
}

/** The Postgres SQLSTATE of a failed query, if any. drizzle wraps the driver's error in `cause`. */
function errorCode(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

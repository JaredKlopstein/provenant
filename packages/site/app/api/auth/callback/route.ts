/**
 * Magic-link callback: the link in the sign-in email lands here.
 *
 * A genuine, unexpired token that has not been used before creates the identity
 * (the account id is the hash of the email it was signed for), sets a 7-day
 * session cookie and redirects to the checkout page. The destination is fixed: no
 * `next`, `redirect` or other parameter can change it. A bad or expired token goes
 * back to the signup page to ask again, before the database is touched. A link
 * that was already used is refused, so each link signs in once.
 *
 * The token is never logged. Responses are no-store so no cache keeps the link.
 */
import { AUTH_ENV, SIGNUP_PATH, authConfig } from '../../../../src/auth/email';
import { CHECKOUT_PATH, accountIdFor, sessionCookie, verifyLinkToken } from '../../../../src/auth/session';
import { DATABASE_URL_ENV, markTokenUsed, usedTokenDb } from '../../../../src/auth/used-tokens';

const NO_STORE = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } as const;
const MIGRATION = 'packages/site/migrations/0000_magic_link_used.sql';

const text = (status: number, body: string) =>
  new Response(`${body}\n`, { status, headers: { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8' } });

export async function GET(request: Request): Promise<Response> {
  const config = authConfig();
  const db = usedTokenDb();
  if (!config || !db) {
    const missing = [...(config ? [] : AUTH_ENV), ...(db ? [] : [DATABASE_URL_ENV])];
    return text(503, `Sign-in is not configured on this server yet. The site operator must set ${missing.join(', ')}.`);
  }

  const token = new URL(request.url).searchParams.get('token');
  const claims = token ? await verifyLinkToken(token, config.secret) : null;
  if (!claims) {
    return new Response(null, { status: 303, headers: { ...NO_STORE, location: `${SIGNUP_PATH}?signup=expired` } });
  }

  let firstUse: boolean;
  try {
    firstUse = await markTokenUsed(db, claims.jti, new Date(claims.exp * 1000));
  } catch (err) {
    const code = errorCode(err);
    console.error(`auth: could not record the used sign-in link (${code ?? 'no error code'})`);
    const fix = code === '42P01' ? ` The site operator must apply ${MIGRATION}.` : '';
    return text(503, `Sign-in is unavailable right now. No session was created.${fix}`);
  }
  if (!firstUse) {
    return text(409, `This sign-in link was already used. Each link works once. Ask for a new one at ${SIGNUP_PATH}.`);
  }

  const cookie = await sessionCookie(await accountIdFor(claims.email), config.secret);
  return new Response(null, { status: 303, headers: { ...NO_STORE, location: CHECKOUT_PATH, 'set-cookie': cookie } });
}

/** The Postgres SQLSTATE of a failed query, if any. drizzle wraps the driver's error in `cause`. */
function errorCode(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

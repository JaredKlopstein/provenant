/**
 * Magic-link callback: the link in the sign-in email lands here.
 *
 * A genuine, unexpired token creates the identity (the account id is the hash of
 * the email it was signed for), sets a 7-day session cookie and redirects to the
 * checkout page. The destination is fixed: no `next`, `redirect` or other parameter
 * can change it. A bad or expired token goes back to the signup page to ask again.
 *
 * The token is never logged. Responses are no-store so no cache keeps the link.
 */
import { AUTH_ENV, SIGNUP_PATH, authConfig } from '../../../../src/auth/email';
import { CHECKOUT_PATH, accountIdFor, sessionCookie, verifyLinkToken } from '../../../../src/auth/session';

const NO_STORE = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } as const;

export async function GET(request: Request): Promise<Response> {
  const config = authConfig();
  if (!config) {
    return new Response(
      `Sign-in is not configured on this server yet. The site operator must set ${AUTH_ENV.join(', ')}.\n`,
      { status: 503, headers: { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  const token = new URL(request.url).searchParams.get('token');
  const claims = token ? await verifyLinkToken(token, config.secret) : null;
  if (!claims) {
    return new Response(null, { status: 303, headers: { ...NO_STORE, location: `${SIGNUP_PATH}?signup=expired` } });
  }

  const cookie = await sessionCookie(await accountIdFor(claims.email), config.secret);
  return new Response(null, { status: 303, headers: { ...NO_STORE, location: CHECKOUT_PATH, 'set-cookie': cookie } });
}

/**
 * GET /api/auth/callback: where a magic link lands.
 *
 * Verifies the token, derives the account id from the email it is bound to,
 * sets the 7-day session cookie and redirects to the checkout page. The
 * redirect target is fixed: no `next`, `redirect` or other parameter is read,
 * so a link cannot send anyone off-site.
 *
 * Every bad link gets the same 400, whether it is expired, tampered with or
 * signed with another secret. Returns 503 when sign-in is not configured.
 */
import {
  CHECKOUT_PATH,
  accountIdFor,
  authUnavailable,
  jsonError,
  readAuthEnv,
  sessionCookie,
  verifyMagicLinkToken,
} from '../../../../src/auth/session';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const auth = readAuthEnv(process.env);
  if (!auth) return authUnavailable();

  const token = new URL(request.url).searchParams.get('token');
  const claims = token ? await verifyMagicLinkToken(token, auth.secret) : null;
  if (!claims) {
    return jsonError(
      400,
      'LINK_INVALID',
      'This sign-in link is invalid or has expired. No session was created.',
      'Links last 15 minutes. Request a new one at /signup and open the newest email.',
    );
  }

  return new Response(null, {
    status: 303,
    headers: {
      location: CHECKOUT_PATH,
      'set-cookie': await sessionCookie(await accountIdFor(claims.email), auth.secret),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

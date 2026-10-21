/**
 * The two halves of using a magic link, split so that only a deliberate click
 * signs anyone in.
 *
 *  - GET of the emailed link shows a confirm page. `checkLinkToken` validates the
 *    token (signature, expiry, not yet used) without writing anything, so mail
 *    scanners and link previewers that fetch every URL leave the link usable and
 *    sign no one in.
 *  - The page's "Sign in" button POSTs the token to the callback, which uses it up
 *    and sets the session cookie. `fromThisSite` is that POST's CSRF check: the
 *    browser's Origin must be the site's own origin (the link base), or, when a
 *    browser sends no Origin, Sec-Fetch-Site must say same-origin. Anything else is
 *    refused, so another site cannot sign a visitor in with a link of its own.
 *
 * Expired, tampered and used links all get the same generic outcome, so the
 * response never says which.
 */
import { authConfig, linkBase } from './email';
import { verifyLinkToken } from './session';
import { isTokenUsed, usedTokenDb } from './used-tokens';

export type LinkCheck =
  | { status: 'ok'; email: string }
  | { status: 'invalid' }
  | { status: 'unavailable' };

/** Validates a link token for the confirm page. Never writes. */
export async function checkLinkToken(token: string | null): Promise<LinkCheck> {
  const config = authConfig();
  const db = usedTokenDb();
  if (!config || !db) return { status: 'unavailable' };
  const claims = token ? await verifyLinkToken(token, config.secret) : null;
  if (!claims) return { status: 'invalid' };
  try {
    if (await isTokenUsed(db, claims.jti)) return { status: 'invalid' };
  } catch (err) {
    console.error(`auth: could not check the sign-in link (${err instanceof Error ? err.name : 'unknown error'})`);
    return { status: 'unavailable' };
  }
  return { status: 'ok', email: claims.email };
}

/** True when a POST came from this site's own pages. Fails closed without a link base. */
export function fromThisSite(request: Request): boolean {
  const base = linkBase();
  if (!base) return false;
  const origin = request.headers.get('origin');
  if (origin !== null) return origin === base;
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

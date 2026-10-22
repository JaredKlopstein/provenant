/**
 * Sign out: the "Sign out" button on signed-in pages POSTs here.
 *
 * POST ends the session by sending back the session cookie empty and already
 * expired, then redirects home. It answers the same with or without a session,
 * so a second click is harmless. Like the sign-in POST, it must come from this
 * site (the check in src/auth/confirm.ts), so another site cannot sign a visitor
 * out. GET signs no one out: prefetchers and link scanners make GETs.
 */
import { fromThisSite } from '../../../../src/auth/confirm';
import { clearedSessionCookie } from '../../../../src/auth/session';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function POST(request: Request): Promise<Response> {
  if (!fromThisSite(request)) {
    return new Response('This sign-out did not come from this site, so nothing changed.\n', {
      status: 403,
      headers: { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(null, { status: 303, headers: { ...NO_STORE, location: '/', 'set-cookie': clearedSessionCookie() } });
}

export async function GET(): Promise<Response> {
  return new Response('Sign out with the Sign out button; a link cannot sign you out.\n', {
    status: 405,
    headers: { ...NO_STORE, allow: 'POST', 'content-type': 'text/plain; charset=utf-8' },
  });
}

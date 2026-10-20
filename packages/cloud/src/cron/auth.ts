/**
 * Shared authentication for cron routes.
 *
 * A cron route is a Web-standard `(Request) => Promise<Response>` that starts
 * with this check:
 *
 *   const denied = requireCronAuth(request, process.env);
 *   if (denied) return denied;
 *
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is
 * set on the project; an external scheduler (cron-job.org) is configured to
 * send the same header.
 *
 *  - The presented token and CRON_SECRET are each hashed with SHA-256 and the
 *    two equal-length digests compared with crypto.timingSafeEqual, so the
 *    time taken says nothing about the secret, its length included.
 *
 *  - An unset or empty CRON_SECRET rejects every request. A deploy that forgot
 *    the variable is closed, not open.
 *
 *  - Every rejection is the same 401, so a caller cannot tell a wrong secret
 *    from a missing one or from an unconfigured server. Nothing is logged, and
 *    neither value is ever put in the response.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

const BEARER = /^Bearer +(\S+) *$/i;

/**
 * Returns null when the request carries the right cron secret, and a 401
 * response to return as is otherwise.
 */
export function requireCronAuth(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): Response | null {
  const secret = env.CRON_SECRET;
  const presented = BEARER.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!secret || !presented) return unauthorized();
  return timingSafeEqual(digest(presented), digest(secret)) ? null : unauthorized();
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify(
      {
        error: {
          code: 'UNAUTHORIZED',
          message: 'This cron route needs the cron secret. Nothing was run.',
          retryable: false,
          fix: {
            note:
              'Send "Authorization: Bearer <CRON_SECRET>". Vercel Cron sends it automatically once ' +
              'CRON_SECRET is set in the Vercel project; an external scheduler must be given the same header.',
          },
        },
      },
      null,
      2,
    ),
    {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8', 'www-authenticate': 'Bearer' },
    },
  );
}

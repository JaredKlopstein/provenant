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
 * set on the project.
 *
 * A route an external scheduler (cron-job.org) calls names its own secret, so
 * the value that scheduler holds is not the Vercel cron secret:
 *
 *   const denied = requireCronAuth(request, process.env, 'ANCHOR_TICK_SECRET');
 *
 * Only the named variable is accepted; with no name it is CRON_SECRET.
 *
 *  - The presented token and the secret are each hashed with SHA-256 and the
 *    two equal-length digests compared with crypto.timingSafeEqual, so the
 *    time taken says nothing about the secret, its length included.
 *
 *  - An unset or empty secret rejects every request. A deploy that forgot the
 *    variable is closed, not open.
 *
 *  - Every rejection is the same 401, so a caller cannot tell a wrong secret
 *    from a missing one or from an unconfigured server. Nothing is logged, and
 *    neither value is ever put in the response.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

const BEARER = /^Bearer +(\S+) *$/i;

/**
 * Returns null when the request carries the secret held in `env[secretName]`,
 * and a 401 response to return as is otherwise.
 */
export function requireCronAuth(
  request: Request,
  env: Record<string, string | undefined> = process.env,
  secretName: string = 'CRON_SECRET',
): Response | null {
  const secret = env[secretName];
  const presented = BEARER.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!secret || !presented) return unauthorized(secretName);
  return timingSafeEqual(digest(presented), digest(secret)) ? null : unauthorized(secretName);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Wording for secrets with more to say than the generic rejection. */
const KNOWN = new Map<string, { message: string; note: string }>([
  ['CRON_SECRET', {
    message: 'This cron route needs the cron secret. Nothing was run.',
    note:
      'Send "Authorization: Bearer <CRON_SECRET>". Vercel Cron sends it automatically once ' +
      'CRON_SECRET is set in the Vercel project; an external scheduler must be given the same header.',
  }],
]);

function unauthorized(secretName: string): Response {
  const { message, note } = KNOWN.get(secretName) ?? {
    message: `This route needs ${secretName}. Nothing was run.`,
    note:
      `Send "Authorization: Bearer <${secretName}>". Set ${secretName} in the Vercel project and give ` +
      'the scheduler that calls this route the same header. No other secret is accepted here.',
  };
  return new Response(
    JSON.stringify(
      {
        error: { code: 'UNAUTHORIZED', message, retryable: false, fix: { note } },
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

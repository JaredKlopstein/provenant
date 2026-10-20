/**
 * POST /api/auth/magic-link: email a sign-in link.
 *
 * Takes { "email": "..." } as JSON (the signup page) or a form post. The reply
 * is the same 202 for every valid address, whether or not it has signed in
 * before, and never carries the token or the link.
 *
 * Launch guard: this returns 503 and sends nothing unless MAGIC_LINK_ENABLED=1.
 * The flag stays off until send rate limiting (#63) lands. It also returns 503
 * when SESSION_SECRET, the email settings or a base URL are missing.
 *
 * Nothing is logged: not the address, the token, the link or the provider reply.
 */
import { magicLinkEmail, sendMagicLinkEmail } from '../../../../src/auth/email';
import {
  LINK_TTL_SECONDS,
  authUnavailable,
  createMagicLinkToken,
  jsonError,
  magicLinkUrl,
  normalizeEmail,
  readAuthEnv,
  resolveLinkBase,
} from '../../../../src/auth/session';

export const dynamic = 'force-dynamic';

const MAX_BODY_LENGTH = 2048;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request): Promise<Response> {
  const env = process.env;
  if (env.MAGIC_LINK_ENABLED !== '1') return authUnavailable();
  const auth = readAuthEnv(env);
  const base = resolveLinkBase(env);
  if (!auth || !base) return authUnavailable();

  const email = await readEmail(request);
  if (!email) {
    return jsonError(
      400,
      'INVALID_EMAIL',
      'That is not an email address we can send a link to. No email was sent.',
      'Send {"email": "you@example.com"} as JSON, or a form field named email.',
    );
  }

  const token = await createMagicLinkToken(email, auth.secret);
  const message = magicLinkEmail(magicLinkUrl(base, token), LINK_TTL_SECONDS / 60);
  if (!(await sendMagicLinkEmail(auth.email, email, message))) {
    return jsonError(
      502,
      'EMAIL_NOT_SENT',
      'The sign-in email could not be sent.',
      'Try again in a minute. If it keeps failing, the email provider is down or misconfigured.',
    );
  }

  return new Response(
    JSON.stringify({
      sent: true,
      message: `If that address can receive email, a sign-in link is on its way. It expires in ${LINK_TTL_SECONDS / 60} minutes.`,
    }),
    { status: 202, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
  );
}

/** The normalized address from a JSON or form body, or null when there is no usable one. */
async function readEmail(request: Request): Promise<string | null> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return null;
  }
  if (raw.length > MAX_BODY_LENGTH) return null;

  let value: unknown;
  if ((request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    try {
      value = (JSON.parse(raw) as { email?: unknown } | null)?.email;
    } catch {
      return null;
    }
  } else {
    value = new URLSearchParams(raw).get('email');
  }
  if (typeof value !== 'string') return null;
  const email = normalizeEmail(value);
  return email.length <= 254 && EMAIL_SHAPE.test(email) ? email : null;
}

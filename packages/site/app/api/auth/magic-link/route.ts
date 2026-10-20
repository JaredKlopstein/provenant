/**
 * Magic-link send: takes an email from the signup page and mails it a sign-in link.
 *
 * Off by default. It answers 503 and sends nothing unless MAGIC_LINK_ENABLED=1,
 * which only the send rate limiting change turns on. It also answers 503 when
 * SESSION_SECRET or any EMAIL_* variable is unset, or when no link base can be
 * worked out. The link base never comes from the request.
 *
 * The answer is the same for every valid address. There is no account lookup: an
 * account is the hash of its email and comes into being when the link is used.
 *
 * Like the contact route, it accepts the page's native form post (answered with a
 * 303 back to the page) and JSON (answered with JSON, every error carrying its fix).
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
import { createLinkToken, normalizeEmail } from '../../../../src/auth/session';

const MAX_BODY_BYTES = 4 * 1024;
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
  const reply = (status: number, outcome: SignupOutcome, body: object) =>
    form
      ? new Response(null, { status: 303, headers: { location: `${SIGNUP_PATH}?signup=${outcome}` } })
      : json(status, body);
  const fail = (status: number, outcome: SignupOutcome, error: ErrorBody) => reply(status, outcome, { error });
  const unavailable = (note: string) =>
    fail(503, 'unavailable', {
      code: 'SIGNUP_UNAVAILABLE',
      message: `Email sign-up is not available on this server yet. ${NOTHING_SENT}`,
      retryable: false,
      fix: { note },
    });

  if (!magicLinkEnabled()) {
    return unavailable(`The site operator turns sending on with ${MAGIC_LINK_FLAG_ENV}=1 once send rate limiting is in place.`);
  }
  const config = authConfig();
  if (!config) return unavailable(`The site operator must set ${AUTH_ENV.join(', ')}.`);
  const base = linkBase();
  if (!base) {
    console.error('auth: no link base; set BRAND.domain, SITE_BASE_URL or VERCEL_URL');
    return unavailable('The site operator must set a link base: BRAND.domain, SITE_BASE_URL or VERCEL_URL.');
  }

  const raw = await request.text();
  const tooLarge = new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES;
  const email = tooLarge ? '' : normalizeEmail(readEmail(request, raw));
  if (!isEmailAddress(email)) {
    return fail(400, 'invalid', {
      code: 'INVALID_INPUT',
      message: `Body must carry "email", a valid email address of at most ${MAX_EMAIL_LENGTH} characters. ${NOTHING_SENT}`,
      retryable: false,
      fix: { note: 'Send {"email": "you@example.com"} as JSON, or the signup form field "email".' },
    });
  }

  const token = await createLinkToken(email, config.secret);
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

function isForm(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded');
}

/** The submitted email field, or '' when the body has none. */
function readEmail(request: Request, raw: string): string {
  if (isForm(request)) return new URLSearchParams(raw).get('email') ?? '';
  try {
    const body: unknown = JSON.parse(raw);
    if (typeof body === 'object' && body !== null && 'email' in body && typeof body.email === 'string') {
      return body.email;
    }
  } catch {
    // Falls through to '', which the caller rejects with its fix.
  }
  return '';
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Enterprise contact: a Vercel function that forwards one submission to the URL
 * the owner sets in CONTACT_FORWARD_URL. No third-party SDK; one fetch.
 *
 * Enterprise has no price and is never sold through checkout, so this is the only
 * way in. It accepts the enterprise page's native form post
 * (application/x-www-form-urlencoded, answered with a 303 back to the page) and
 * JSON (answered with JSON, every error carrying its own fix).
 *
 * The forward URL is a secret of the owner's: it is never logged, never returned,
 * and never interpolated into an error. fetch's own error messages can contain the
 * URL, so failures are logged by error name only.
 */
import { BRAND } from '../../../src/brand';
import { FLEET_SIZES, HONEYPOT_FIELD, type ContactOutcome, type FleetSize } from '../../../src/contact';

const FORWARD_ENV = 'CONTACT_FORWARD_URL';
const MAX_BODY_BYTES = 16 * 1024;
const FORWARD_TIMEOUT_MS = 10_000;
const LIMITS = { name: 200, email: 254, company: 200, need: 5000 } as const;
// Format only: one @, no spaces, a dotted domain ending in a 2+ letter TLD.
const EMAIL = /^[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[A-Za-z]{2,}$/;
const NOTHING_SENT = 'Nothing was sent.';
const FIX_FIELDS =
  `Send name, email (a work address), company, fleetSize (one of ${FLEET_SIZES.join(', ')}) and need.`;

interface ContactSubmission {
  name: string;
  email: string;
  company: string;
  fleetSize: FleetSize;
  need: string;
}

interface ErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  fix?: { note: string };
}

export async function POST(request: Request): Promise<Response> {
  const form = isForm(request);
  const reply = (status: number, outcome: ContactOutcome, body: object) =>
    form
      ? new Response(null, { status: 303, headers: { location: `/enterprise?contact=${outcome}` } })
      : json(status, body);
  const fail = (status: number, outcome: ContactOutcome, error: ErrorBody) => reply(status, outcome, { error });

  const target = forwardUrl();
  if (!target) {
    return fail(503, 'unavailable', {
      code: 'CONTACT_UNAVAILABLE',
      message: `Enterprise contact is not configured on this server yet. ${NOTHING_SENT}`,
      retryable: false,
      fix: {
        note: `The site operator must set ${FORWARD_ENV}. Until then, reach the ${BRAND.name} team through ${BRAND.repository}.`,
      },
    });
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return fail(413, 'invalid', {
      code: 'BODY_TOO_LARGE',
      message: `Request body exceeds ${MAX_BODY_BYTES} bytes. ${NOTHING_SENT}`,
      retryable: false,
      fix: { note: `Keep "need" under ${LIMITS.need} characters.` },
    });
  }
  const fields = parse(request, raw);
  if (!fields) {
    return fail(400, 'invalid', {
      code: 'INVALID_INPUT',
      message: `Body must be a JSON object or a URL-encoded form. ${NOTHING_SENT}`,
      retryable: false,
      fix: { note: FIX_FIELDS },
    });
  }

  // Answer a filled honeypot exactly as a success, so a bot learns nothing.
  if (fields[HONEYPOT_FIELD]) return reply(200, 'sent', { ok: true, message: SENT });

  const checked = validate(fields);
  if (typeof checked === 'string') {
    return fail(400, 'invalid', {
      code: 'INVALID_INPUT',
      message: `${checked} ${NOTHING_SENT}`,
      retryable: false,
      fix: { note: FIX_FIELDS },
    });
  }

  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...checked, submittedAt: new Date().toISOString() }),
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`contact: forward rejected with HTTP ${res.status}`);
      return forwardFailed(fail);
    }
  } catch (err) {
    console.error(`contact: forward failed (${err instanceof Error ? err.name : 'unknown error'})`);
    return forwardFailed(fail);
  }
  return reply(200, 'sent', { ok: true, message: SENT });
}

const SENT = `Thanks. The ${BRAND.name} team has your message and will reply to the email you gave.`;

function forwardFailed(fail: (status: number, outcome: ContactOutcome, error: ErrorBody) => Response) {
  return fail(502, 'failed', {
    code: 'CONTACT_FORWARD_FAILED',
    message: `Your message could not be delivered. ${NOTHING_SENT}`,
    retryable: true,
    fix: { note: 'Retry shortly. If it keeps failing, the operator can find the reason in the server log.' },
  });
}

/** The configured http(s) forward URL, or null. A malformed value counts as unset. */
function forwardUrl(): string | null {
  const value = process.env[FORWARD_ENV]?.trim();
  if (!value) return null;
  if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) {
    console.error(`contact: ${FORWARD_ENV} is set but is not an http(s) URL`);
    return null;
  }
  return value;
}

function isForm(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded');
}

function parse(request: Request, raw: string): Record<string, string> | null {
  if (isForm(request)) return Object.fromEntries(new URLSearchParams(raw));
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** The cleaned submission, or a sentence naming what is wrong. */
function validate(fields: Record<string, string>): ContactSubmission | string {
  const value = (key: string) => (fields[key] ?? '').trim();
  const missing = ['name', 'email', 'company', 'fleetSize', 'need'].filter((k) => !value(k));
  if (missing.length > 0) return `Missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`;

  for (const [key, max] of Object.entries(LIMITS)) {
    if (value(key).length > max) return `${key} is longer than ${max} characters.`;
  }
  const email = value('email');
  if (!EMAIL.test(email)) return 'email is not a valid email address.';
  const fleetSize = value('fleetSize');
  if (!(FLEET_SIZES as readonly string[]).includes(fleetSize)) {
    return `fleetSize must be one of: ${FLEET_SIZES.join(', ')}.`;
  }
  return {
    name: value('name'),
    email,
    company: value('company'),
    fleetSize: fleetSize as FleetSize,
    need: value('need'),
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

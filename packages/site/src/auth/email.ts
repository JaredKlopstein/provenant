/**
 * The magic-link email: the configuration it needs, the base its link points at,
 * the message itself and the one fetch that sends it. No provider SDK; the owner
 * points EMAIL_API_URL at their provider's HTTP send endpoint.
 *
 * Nothing here logs a secret, a token, an address or a message body. Failures are
 * logged by HTTP status or error name only, because fetch's own error messages can
 * carry the URL.
 */
import { BRAND } from '../brand';
import { CONFIRM_PATH, LINK_TTL_SECONDS, SESSION_SECRET_ENV, sessionSecret } from './session';

export const MAGIC_LINK_PATH = '/api/auth/magic-link';
export const SIGNUP_PATH = '/signup';
/** Launch guard. Sending stays off until send rate limiting turns it on with `=1`. */
export const MAGIC_LINK_FLAG_ENV = 'MAGIC_LINK_ENABLED';
export const EMAIL_ENV = { url: 'EMAIL_API_URL', key: 'EMAIL_API_KEY', from: 'EMAIL_FROM' } as const;
/** Every variable both auth routes need, by name. */
export const AUTH_ENV = [SESSION_SECRET_ENV, EMAIL_ENV.url, EMAIL_ENV.key, EMAIL_ENV.from] as const;

/** After a form post or a link click the routes redirect to `/signup?signup=<outcome>`. */
export const SIGNUP_OUTCOMES = ['sent', 'invalid', 'unavailable', 'failed', 'expired'] as const;
export type SignupOutcome = (typeof SIGNUP_OUTCOMES)[number];

export const MAX_EMAIL_LENGTH = 254;
// Format only: one @, no spaces, a dotted domain ending in a 2+ letter TLD.
const EMAIL = /^[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[A-Za-z]{2,}$/;
const HOST = /^[A-Za-z0-9.-]+(:\d+)?$/;
const SEND_TIMEOUT_MS = 10_000;

export interface AuthConfig {
  secret: string;
  email: { url: string; key: string; from: string };
}

export interface MagicLinkEmail {
  subject: string;
  text: string;
}

export function magicLinkEnabled(): boolean {
  return process.env[MAGIC_LINK_FLAG_ENV] === '1';
}

/** Everything the auth routes need, or null when any of it is unset. Logs names only. */
export function authConfig(): AuthConfig | null {
  const secret = sessionSecret();
  const url = emailApiUrl();
  const key = process.env[EMAIL_ENV.key]?.trim();
  const from = process.env[EMAIL_ENV.from]?.trim();
  const missing = [
    secret ? null : SESSION_SECRET_ENV,
    url ? null : EMAIL_ENV.url,
    key ? null : EMAIL_ENV.key,
    from ? null : EMAIL_ENV.from,
  ].filter((name) => name !== null);
  if (!secret || !url || !key || !from) {
    console.error(`auth: not configured; missing ${missing.join(', ')}`);
    return null;
  }
  return { secret, email: { url, key, from } };
}

export function isEmailAddress(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && EMAIL.test(email);
}

/**
 * The origin every link points at: BRAND.domain, then SITE_BASE_URL, then https plus
 * VERCEL_URL. Null when none is usable. The request's Host header is never consulted.
 */
export function linkBase(): string | null {
  if (BRAND.domain) return hostOrigin(BRAND.domain);
  const site = process.env.SITE_BASE_URL?.trim();
  if (site) {
    if (!URL.canParse(site)) return null;
    const url = new URL(site);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return url.protocol === 'https:' || (url.protocol === 'http:' && local) ? url.origin : null;
  }
  const vercel = process.env.VERCEL_URL?.trim();
  return vercel ? hostOrigin(vercel) : null;
}

/**
 * The base, the fixed confirm-page path and the token. Nothing else goes in the
 * link. Opening it only shows a "Sign in" button, so a mail scanner that fetches
 * every link cannot use it up.
 */
export function magicLink(base: string, token: string): string {
  const url = new URL(CONFIRM_PATH, base);
  url.searchParams.set('token', token);
  return url.toString();
}

/** Plain text only: the link, its expiry and the ignore line. No HTML, so no images. */
export function magicLinkEmail(link: string): MagicLinkEmail {
  return {
    subject: `Your ${BRAND.name} sign-in link`,
    text: [
      link,
      '',
      `This link expires in ${LINK_TTL_SECONDS / 60} minutes.`,
      '',
      "If you didn't ask for this, ignore this email.",
      '',
    ].join('\n'),
  };
}

/** Sends one message through the configured provider. True when it accepted it. */
export async function sendMagicLinkEmail(config: AuthConfig, to: string, link: string): Promise<boolean> {
  const { subject, text } = magicLinkEmail(link);
  try {
    const res = await fetch(config.email.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.email.key}` },
      body: JSON.stringify({ from: config.email.from, to, subject, text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`auth: email provider rejected the send with HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`auth: email send failed (${err instanceof Error ? err.name : 'unknown error'})`);
    return false;
  }
}

/** EMAIL_API_URL when it is an https URL. Anything else counts as unset. */
function emailApiUrl(): string | null {
  const value = process.env[EMAIL_ENV.url]?.trim();
  if (!value) return null;
  if (!URL.canParse(value) || new URL(value).protocol !== 'https:') {
    console.error(`auth: ${EMAIL_ENV.url} is set but is not an https URL`);
    return null;
  }
  return value;
}

function hostOrigin(host: string): string | null {
  return HOST.test(host) && URL.canParse(`https://${host}`) ? new URL(`https://${host}`).origin : null;
}

/**
 * Human identity for the site: the account id, the magic-link token and the
 * session cookie.
 *
 *  - The account id is `acct_` + the full hex SHA-256 of "site-account:v1:" and
 *    the normalized email. It is unkeyed, so rotating SESSION_SECRET never
 *    changes an id. Normalizing is trim() and toLowerCase() only: dots and
 *    +tags are kept, so a.b+x@b.com and ab@b.com are different accounts.
 *
 *  - The magic-link token and the session cookie are both `<payload>.<sig>`:
 *    base64url JSON claims and a base64url HMAC-SHA256 over the payload, keyed
 *    by SESSION_SECRET through Web Crypto. A `typ` claim keeps one from being
 *    accepted as the other. Signatures are checked only with
 *    crypto.subtle.verify, never by comparing strings.
 *
 *  - A link token is bound to the normalized email, expires after 15 minutes
 *    and carries a random 128-bit `jti` (for single-use links, #61).
 *
 *  - The session cookie holds the account id and an `exp` the server checks on
 *    every read, so a cookie the browser keeps past its Max-Age is still refused.
 *
 *  - The link base comes from BRAND.domain, then SITE_BASE_URL, then https plus
 *    VERCEL_URL. The Host header is never used, so a spoofed one cannot point a
 *    link elsewhere.
 */
import { BRAND } from '../brand';
import { readEmailConfig, type EmailConfig } from './email';

type Env = Record<string, string | undefined>;

export const LINK_TTL_SECONDS = 15 * 60;
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
/** `__Host-` makes the browser insist on Secure, Path=/ and no Domain. */
export const SESSION_COOKIE = '__Host-session';
export const CALLBACK_PATH = '/api/auth/callback';
export const CHECKOUT_PATH = '/checkout';
/** SESSION_SECRET must be at least this long; the owner sets 32 or more random bytes. */
export const MIN_SECRET_LENGTH = 32;

const ACCOUNT_PREFIX = 'site-account:v1:';
const ACCOUNT_ID = /^acct_[0-9a-f]{64}$/;
const MAX_TOKEN_LENGTH = 2048;

export interface SignedInAccount {
  readonly accountId: string;
}

export interface LinkClaims {
  readonly email: string;
  readonly exp: number;
  readonly jti: string;
}

export interface AuthEnv {
  readonly secret: string;
  readonly email: EmailConfig;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function accountIdFor(email: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8(ACCOUNT_PREFIX + normalizeEmail(email)));
  return `acct_${hex(new Uint8Array(digest))}`;
}

/**
 * Everything both auth routes need, or null when SESSION_SECRET (or one long
 * enough), EMAIL_API_URL, EMAIL_API_KEY or EMAIL_FROM is missing.
 */
export function readAuthEnv(env: Env): AuthEnv | null {
  const secret = env.SESSION_SECRET;
  const email = readEmailConfig(env);
  if (!secret || secret.length < MIN_SECRET_LENGTH || !email) return null;
  return { secret, email };
}

/**
 * The origin magic links point at: BRAND.domain, then SITE_BASE_URL, then
 * https plus VERCEL_URL. The first one set is used; if it is not a usable https
 * origin the answer is null and the caller refuses, rather than falling through
 * to a lower-priority source.
 */
export function resolveLinkBase(env: Env, domain: string | null = BRAND.domain): string | null {
  const candidate = domain
    ? `https://${domain}`
    : env.SITE_BASE_URL?.trim() || (env.VERCEL_URL?.trim() ? `https://${env.VERCEL_URL.trim()}` : null);
  if (!candidate) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  if (url.username || url.password) return null;
  return url.origin;
}

export function magicLinkUrl(base: string, token: string): string {
  const url = new URL(CALLBACK_PATH, base);
  url.searchParams.set('token', token);
  return url.href;
}

export async function createMagicLinkToken(email: string, secret: string, now = Date.now()): Promise<string> {
  const jti = hex(crypto.getRandomValues(new Uint8Array(16)));
  return seal({ typ: 'link', email: normalizeEmail(email), exp: seconds(now) + LINK_TTL_SECONDS, jti }, secret);
}

/** The token's claims, or null when it is malformed, tampered with, for another secret or expired. */
export async function verifyMagicLinkToken(token: string, secret: string, now = Date.now()): Promise<LinkClaims | null> {
  const claims = await open(token, secret);
  if (!claims || claims.typ !== 'link') return null;
  const { email, exp, jti } = claims;
  if (typeof email !== 'string' || email === '' || email !== normalizeEmail(email)) return null;
  if (typeof jti !== 'string' || !/^[0-9a-f]{32}$/.test(jti)) return null;
  if (typeof exp !== 'number' || seconds(now) >= exp) return null;
  return { email, exp, jti };
}

/** The full Set-Cookie value for a new 7-day session. */
export async function sessionCookie(accountId: string, secret: string, now = Date.now()): Promise<string> {
  const value = await seal({ typ: 'session', acct: accountId, exp: seconds(now) + SESSION_MAX_AGE_SECONDS }, secret);
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * The account behind the request's session cookie, or null when there is no
 * cookie, auth is not configured, or the cookie is tampered with or past its
 * signed `exp`. Used by checkout (#59) and the account page (#62).
 */
export async function getSignedInAccount(
  request: Request,
  env: Env = process.env,
  now = Date.now(),
): Promise<SignedInAccount | null> {
  const auth = readAuthEnv(env);
  const value = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  if (!auth || !value) return null;
  const claims = await open(value, auth.secret);
  if (!claims || claims.typ !== 'session') return null;
  const { acct, exp } = claims;
  if (typeof acct !== 'string' || !ACCOUNT_ID.test(acct)) return null;
  if (typeof exp !== 'number' || seconds(now) >= exp) return null;
  return { accountId: acct };
}

/** The 503 both auth routes return when sign-in is switched off or not configured. Nothing was sent. */
export function authUnavailable(): Response {
  return jsonError(
    503,
    'SIGNUP_UNAVAILABLE',
    'Email sign-in is not available yet. No email was sent and no session was created.',
    'The operator must set MAGIC_LINK_ENABLED=1, SESSION_SECRET (32 or more random bytes), ' +
      'EMAIL_API_URL (https), EMAIL_API_KEY and EMAIL_FROM, and give the site a base URL ' +
      '(BRAND.domain, SITE_BASE_URL or VERCEL_URL).',
  );
}

export function jsonError(status: number, code: string, message: string, note: string): Response {
  return new Response(JSON.stringify({ error: { code, message, retryable: status >= 500, fix: { note } } }, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

type Claims = Record<string, unknown>;

async function seal(claims: Claims, secret: string): Promise<string> {
  const payload = base64url(utf8(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), utf8(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

/** Verifies the signature with crypto.subtle.verify, then parses the claims. */
async function open(token: string, secret: string): Promise<Claims | null> {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];
  const sigBytes = fromBase64url(sig);
  const payloadBytes = fromBase64url(payload);
  if (!sigBytes || !payloadBytes) return null;
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), sigBytes, utf8(payload));
  if (!valid) return null;
  try {
    const claims: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? (claims as Claims) : null;
  } catch {
    return null;
  }
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (text === '' || !/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

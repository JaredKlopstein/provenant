/**
 * Human identity for the site: the magic-link token, the session cookie and the
 * account id. Agents keep their own RFC 9421 keys; this is only for the people who
 * sign up and pay.
 *
 * Both the link token and the cookie are `<base64url claims>.<base64url HMAC>`,
 * signed with SESSION_SECRET (HMAC-SHA256 through Web Crypto). A signature is only
 * ever checked with `crypto.subtle.verify`, never by signing again and comparing
 * strings. Each claims object carries a `typ`, so a link token is never accepted as
 * a cookie or the other way round, and an `exp` checked on every read.
 *
 * The account id is an unkeyed hash of the normalized email, so rotating
 * SESSION_SECRET signs everyone out but never changes an id.
 */

export const SESSION_SECRET_ENV = 'SESSION_SECRET';
export const LINK_TTL_SECONDS = 15 * 60;
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
/** `__Host-` makes the browser insist on Secure, Path=/ and no Domain attribute. */
export const SESSION_COOKIE = '__Host-session';
/** Where the emailed link lands: a confirm page. A GET there never uses up the link. */
export const CONFIRM_PATH = '/signin';
/** The confirm page's "Sign in" button POSTs here; only that POST uses up the link. */
export const CALLBACK_PATH = '/api/auth/callback';
/** Where the callback sends a signed-in browser whose link carries no known `dest`. */
export const CHECKOUT_PATH = '/checkout';

/**
 * The only places the callback can send a signed-in browser. A link token carries a
 * key from this table in its signed `dest` claim, never a path or URL, and the
 * callback looks the path up here. A missing or unknown key means CHECKOUT_PATH.
 */
export const DESTINATIONS = {
  checkout: CHECKOUT_PATH,
  account: '/account',
  welcome: '/welcome',
} as const satisfies Record<string, `/${string}`>;
export type Destination = keyof typeof DESTINATIONS;

/** The key itself when `value` is one of DESTINATIONS' own keys, otherwise null. */
export function parseDestination(value: unknown): Destination | null {
  return typeof value === 'string' && Object.hasOwn(DESTINATIONS, value) ? (value as Destination) : null;
}

/** The fixed path for a `dest` claim: CHECKOUT_PATH for anything missing or unknown. */
export function destinationPath(dest: unknown): string {
  const key = parseDestination(dest);
  return key ? DESTINATIONS[key] : CHECKOUT_PATH;
}

const ACCOUNT_ID_PREFIX = 'site-account:v1:';
const MIN_SECRET_LENGTH = 32;
const MAX_TOKEN_LENGTH = 2048;
const ACCOUNT_ID = /^acct_[0-9a-f]{64}$/;
const JTI = /^[0-9a-f]{32}$/;

export interface LinkClaims {
  typ: 'link';
  /** The normalized email the link was sent to. */
  email: string;
  /** Expiry, in Unix seconds. */
  exp: number;
  /** Random 128-bit id, so a later change can make each link single-use. */
  jti: string;
  /** Where to land after sign-in, as a DESTINATIONS key. Links issued before it existed have none. */
  dest?: Destination;
}

interface SessionClaims {
  typ: 'session';
  acct: string;
  exp: number;
}

export interface SignedInAccount {
  accountId: string;
}

/** Trim and lowercase, nothing more: dots and +tags are part of the address. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** `acct_` + the full hex SHA-256 of `site-account:v1:<normalized email>`. */
export async function accountIdFor(email: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8(ACCOUNT_ID_PREFIX + normalizeEmail(email)));
  return `acct_${hex(new Uint8Array(digest))}`;
}

/** SESSION_SECRET, or null when it is unset or too short to be 32 random bytes. */
export function sessionSecret(): string | null {
  const value = process.env[SESSION_SECRET_ENV];
  if (!value) return null;
  if (value.length < MIN_SECRET_LENGTH) {
    console.error(`auth: ${SESSION_SECRET_ENV} is shorter than ${MIN_SECRET_LENGTH} characters; treating it as unset`);
    return null;
  }
  return value;
}

/** A token bound to the normalized email, valid for 15 minutes, with an optional destination key. */
export async function createLinkToken(email: string, secret: string, dest?: Destination): Promise<string> {
  const jti = hex(crypto.getRandomValues(new Uint8Array(16)));
  const claims: LinkClaims = { typ: 'link', email: normalizeEmail(email), exp: nowSeconds() + LINK_TTL_SECONDS, jti };
  const key = parseDestination(dest);
  if (key) claims.dest = key;
  return sign(claims, secret);
}

/** The claims of a genuine, unexpired link token, or null. */
export async function verifyLinkToken(token: string, secret: string): Promise<LinkClaims | null> {
  const claims = await verify(token, secret);
  if (
    !claims ||
    claims.typ !== 'link' ||
    typeof claims.email !== 'string' ||
    claims.email === '' ||
    claims.email !== normalizeEmail(claims.email) ||
    typeof claims.jti !== 'string' ||
    !JTI.test(claims.jti) ||
    !unexpired(claims.exp)
  ) {
    return null;
  }
  const verified: LinkClaims = { typ: 'link', email: claims.email, exp: claims.exp as number, jti: claims.jti };
  // An unknown dest is dropped, not refused: the link still works and lands on checkout.
  const dest = parseDestination(claims.dest);
  if (dest) verified.dest = dest;
  return verified;
}

/** The Set-Cookie value for a 7-day session holding the account id and its expiry. */
export async function sessionCookie(accountId: string, secret: string): Promise<string> {
  const claims: SessionClaims = { typ: 'session', acct: accountId, exp: nowSeconds() + SESSION_MAX_AGE_SECONDS };
  const value = await sign(claims, secret);
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * The account a request's session cookie proves, or null. The signed `exp` is
 * checked on every read, so a cookie the browser kept past its expiry is refused.
 */
export async function getSignedInAccount(request: Request): Promise<SignedInAccount | null> {
  const secret = sessionSecret();
  if (!secret) return null;
  const value = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  if (!value) return null;
  const claims = await verify(value, secret);
  if (!claims || claims.typ !== 'session' || typeof claims.acct !== 'string' || !ACCOUNT_ID.test(claims.acct)) {
    return null;
  }
  if (!unexpired(claims.exp)) return null;
  return { accountId: claims.acct };
}

async function sign(claims: LinkClaims | SessionClaims, secret: string): Promise<string> {
  const body = base64url(utf8(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), utf8(body));
  return `${body}.${base64url(new Uint8Array(signature))}`;
}

/** The claims object of a well-formed token whose signature verifies, or null. */
async function verify(token: string, secret: string): Promise<Record<string, unknown> | null> {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const signature = fromBase64url(sig);
  if (!body || !signature) return null;
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), signature, utf8(body));
  if (!valid) return null;
  const decoded = fromBase64url(body);
  if (!decoded) return null;
  try {
    const claims: unknown = JSON.parse(new TextDecoder().decode(decoded));
    return typeof claims === 'object' && claims !== null && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function unexpired(exp: unknown): boolean {
  return typeof exp === 'number' && Number.isInteger(exp) && exp > nowSeconds();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(';')) {
    const at = pair.indexOf('=');
    if (at !== -1 && pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim();
  }
  return null;
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
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * RFC 9421 HTTP Message Signatures, Ed25519, for agent-to-collector auth.
 *
 * No sessions, no cookies, no bearer tokens, no refresh tokens. An agent proves
 * identity by signing the request with the same key its receipts are signed
 * with. Anything else would be human-shaped auth wearing a machine costume.
 *
 * THE TRAPS, handled explicitly because each one is a real vulnerability:
 *
 *  1. The signature base is constructed per RFC 9421 section 2.5 exactly --
 *     one `"component": value` line per covered component, then the
 *     `"@signature-params"` line. No shortcuts. A hand-rolled "just concatenate
 *     the headers" base is not interoperable AND usually not injective, meaning
 *     two different requests can produce the same base.
 *
 *  2. We REQUIRE @method, @authority, @path and created, plus content-digest
 *     on any request with a body. Covering @authority alone is the classic
 *     mistake: a captured signature then replays against ANY path on that
 *     origin until it expires. Covering the method but not the path is just as
 *     bad in the other direction.
 *
 *  3. Replay window is <= 60 seconds AND a nonce cache is required. The window
 *     alone leaves a 60-second replay hole; the nonce alone leaves an unbounded
 *     one if the cache is ever cleared.
 *
 *  4. Expiry is capped at 24 hours regardless of what the signature claims, so
 *     a client cannot mint a credential that outlives its own key rotation.
 *
 * NOTE: the Web Bot Auth drafts that motivate the key-directory format are
 * individual IETF submissions with no working group adoption as of this
 * writing. The wire format may shift; RFC 9421 itself is a published standard.
 */
import { randomUUID } from 'node:crypto';
import { sign, verify, type AgentJwk, jwkToPublicKey } from '../crypto/keys.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { toBase64Url } from '../crypto/hash.js';

export const MAX_REPLAY_WINDOW_SECONDS = 60;
export const MAX_EXPIRY_SECONDS = 24 * 60 * 60;

/**
 * Components every Provenant request must cover. Anything less is rejected.
 *
 * `@query` is here for a reason found in audit: `@path` strips the query string,
 * and the collector passes `pathname + search` through to handlers. Covering
 * @path alone left `?limit=100000&agent_id=someone_else` unauthenticated and
 * mutable in flight -- the same class of hole as covering @authority without
 * @path, one level down.
 */
export const REQUIRED_COMPONENTS = ['@method', '@authority', '@path', '@query'] as const;

export interface SignatureParams {
  keyid: string;
  created: number;
  expires?: number;
  nonce?: string;
  alg?: string;
  tag?: string;
}

export interface RequestLike {
  method: string;
  /** Host[:port] as the client addressed it. */
  authority: string;
  /** Path plus query, e.g. /receipts?limit=10 */
  path: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

/** RFC 9421 section 2.1: derived components begin with '@'. */
function componentValue(name: string, req: RequestLike): string {
  switch (name) {
    case '@method':
      return req.method.toUpperCase();
    case '@authority':
      return req.authority.toLowerCase();
    case '@path':
      return req.path.split('?')[0] ?? '/';
    case '@query': {
      const q = req.path.indexOf('?');
      return q === -1 ? '?' : req.path.slice(q);
    }
    case '@target-uri':
      return `https://${req.authority.toLowerCase()}${req.path}`;
    default: {
      const v = req.headers[name.toLowerCase()];
      if (v === undefined) throw new Error(`covered component '${name}' is not present in the request`);
      // RFC 9421 section 2.1: field values are trimmed and obs-folds removed.
      return v.trim().replace(/\s*\r?\n\s+/g, ' ');
    }
  }
}

/** RFC 9421 section 2.3: the serialized signature parameters. */
export function serializeParams(components: string[], p: SignatureParams): string {
  const list = components.map((c) => `"${c}"`).join(' ');
  let out = `(${list});created=${p.created}`;
  if (p.expires !== undefined) out += `;expires=${p.expires}`;
  if (p.nonce !== undefined) out += `;nonce="${p.nonce}"`;
  out += `;keyid="${p.keyid}"`;
  if (p.alg !== undefined) out += `;alg="${p.alg}"`;
  if (p.tag !== undefined) out += `;tag="${p.tag}"`;
  return out;
}

/**
 * RFC 9421 section 2.5. One line per component, then @signature-params.
 * Lines are joined with \n and there is NO trailing newline after the last one.
 */
export function signatureBase(
  components: string[],
  params: SignatureParams,
  req: RequestLike,
): string {
  const lines = components.map((c) => `"${c.toLowerCase()}": ${componentValue(c, req)}`);
  lines.push(`"@signature-params": ${serializeParams(components, params)}`);
  return lines.join('\n');
}

/** RFC 9530 Content-Digest, the sha-256 variant. */
export function contentDigest(body: Uint8Array): string {
  return `sha-256=:${Buffer.from(sha256(body)).toString('base64')}:`;
}

export interface SignedHeaders {
  'signature-input': string;
  signature: string;
  'content-digest'?: string;
}

export function signRequest(
  req: RequestLike,
  secretKey: Uint8Array,
  keyId: string,
  opts: { created?: number; expires?: number; nonce?: string; label?: string } = {},
): SignedHeaders {
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const expires = opts.expires ?? created + 300;
  const label = opts.label ?? 'sig1';

  const headers = { ...req.headers };
  const components = [...REQUIRED_COMPONENTS] as string[];

  // A nonce is minted by default. The doc comment used to claim a nonce cache
  // was required while nothing ever produced one, which made verbatim replay
  // inside the freshness window possible.
  const nonce = opts.nonce ?? randomUUID();

  // A body that is not covered by the signature is a body an attacker can swap.
  if (req.body && req.body.length > 0) {
    headers['content-digest'] = contentDigest(req.body);
    components.push('content-digest');
  }

  const params: SignatureParams = {
    keyid: keyId,
    created,
    expires,
    alg: 'ed25519',
    nonce,
  };

  const base = signatureBase(components, params, { ...req, headers });
  const sig = sign(new TextEncoder().encode(base), secretKey);

  const out: SignedHeaders = {
    'signature-input': `${label}=${serializeParams(components, params)}`,
    signature: `${label}=:${Buffer.from(sig).toString('base64')}:`,
  };
  if (headers['content-digest']) out['content-digest'] = headers['content-digest'];
  return out;
}

export interface VerifyResult {
  ok: boolean;
  keyId: string | null;
  reason: string;
  /** Nonce to record, when verification succeeded and one was supplied. */
  nonce: string | null;
}

export interface VerifyRequestOptions {
  /** Resolve a keyid to its JWK. Returns null for an unknown key. */
  resolveKey(keyId: string): AgentJwk | null;
  /** Returns true if this nonce has been seen before. */
  seenNonce?(nonce: string): boolean;
  nowSeconds?: number;
  requireNonce?: boolean;
}

export function verifyRequest(req: RequestLike, opts: VerifyRequestOptions): VerifyResult {
  const fail = (reason: string, keyId: string | null = null): VerifyResult => ({
    ok: false, keyId, reason, nonce: null,
  });

  const sigInput = req.headers['signature-input'];
  const sigHeader = req.headers['signature'];
  if (!sigInput || !sigHeader) return fail('missing Signature-Input or Signature header');

  // label=("a" "b");created=...;keyid="..."
  const m = /^([A-Za-z0-9_-]+)=\(([^)]*)\)(.*)$/.exec(sigInput.trim());
  if (!m) return fail('Signature-Input is malformed');
  const [, label, componentList, paramString] = m;

  const components = (componentList ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((c) => c.replace(/^"|"$/g, ''));

  const getParam = (name: string): string | null => {
    const re = new RegExp(`;${name}=("?)([^;"]*)\\1`);
    const mm = re.exec(paramString ?? '');
    return mm ? (mm[2] ?? null) : null;
  };

  const keyId = getParam('keyid');
  const created = Number(getParam('created'));
  const expiresRaw = getParam('expires');
  const nonce = getParam('nonce');
  const alg = getParam('alg');

  if (!keyId) return fail('Signature-Input has no keyid');
  if (!Number.isFinite(created)) return fail('Signature-Input has no valid created', keyId);
  if (alg && alg !== 'ed25519') return fail(`unsupported signature algorithm '${alg}'`, keyId);

  // --- trap 2: the signature must actually cover what matters ---
  for (const required of REQUIRED_COMPONENTS) {
    if (!components.includes(required)) {
      return fail(
        `signature does not cover ${required}. All of ${REQUIRED_COMPONENTS.join(', ')} are required: ` +
          `a signature covering @authority but not @path can be replayed against any endpoint on this origin.`,
        keyId,
      );
    }
  }
  if (req.body && req.body.length > 0 && !components.includes('content-digest')) {
    return fail('request has a body but the signature does not cover content-digest', keyId);
  }

  // --- the body must match the digest that was signed ---
  if (req.body && req.body.length > 0) {
    const expected = contentDigest(req.body);
    const actual = req.headers['content-digest'];
    if (!actual) return fail('request has a body but no Content-Digest header', keyId);
    if (actual.trim() !== expected) return fail('Content-Digest does not match the request body', keyId);
  }

  // --- trap 3 and 4: freshness ---
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const age = now - created;
  if (age > MAX_REPLAY_WINDOW_SECONDS) {
    return fail(`signature is ${age}s old; the replay window is ${MAX_REPLAY_WINDOW_SECONDS}s`, keyId);
  }
  if (age < -MAX_REPLAY_WINDOW_SECONDS) {
    return fail(`signature created ${-age}s in the future; check your clock`, keyId);
  }
  if (expiresRaw !== null) {
    const expires = Number(expiresRaw);
    if (!Number.isFinite(expires)) return fail('expires is not a number', keyId);
    if (expires < now) return fail('signature has expired', keyId);
    if (expires - created > MAX_EXPIRY_SECONDS) {
      return fail(`signature lifetime exceeds the ${MAX_EXPIRY_SECONDS}s maximum`, keyId);
    }
  }
  // Default to REQUIRING a nonce. The freshness window alone leaves a ~120s
  // replay hole (60s each side for clock skew); the nonce is what closes it.
  // Callers may opt out explicitly, but not by omission.
  if (opts.requireNonce !== false && !nonce) {
    return fail(
      'a nonce is required; add nonce="<unique value>" to Signature-Input. Without it, this exact ' +
        'request could be replayed inside the freshness window.',
      keyId,
    );
  }
  if (nonce && opts.seenNonce?.(nonce)) {
    return fail('nonce has already been used; this request is a replay', keyId);
  }

  // --- the signature itself ---
  const jwk = opts.resolveKey(keyId);
  if (!jwk) return fail(`unknown keyid '${keyId}'`, keyId);

  let publicKey: Uint8Array;
  try {
    publicKey = jwkToPublicKey(jwk);
  } catch {
    return fail(`key '${keyId}' is not a valid Ed25519 OKP JWK`, keyId);
  }

  const sigMatch = new RegExp(`${label}=:([^:]*):`).exec(sigHeader);
  if (!sigMatch?.[1]) return fail(`Signature header has no entry for label '${label}'`, keyId);

  let sigBytes: Uint8Array;
  try {
    sigBytes = new Uint8Array(Buffer.from(sigMatch[1], 'base64'));
  } catch {
    return fail('signature is not valid base64', keyId);
  }

  const params: SignatureParams = {
    keyid: keyId,
    created,
    ...(expiresRaw !== null ? { expires: Number(expiresRaw) } : {}),
    ...(nonce ? { nonce } : {}),
    ...(alg ? { alg } : {}),
  };

  let base: string;
  try {
    base = signatureBase(components, params, req);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), keyId);
  }

  if (!verify(sigBytes, new TextEncoder().encode(base), publicKey)) {
    return fail('signature does not verify', keyId);
  }

  return { ok: true, keyId, reason: '', nonce };
}

/**
 * Bounded nonce cache. Entries older than the replay window are useless, since
 * the window check rejects them anyway -- so this stays small regardless of
 * traffic, and cannot be used to exhaust memory.
 */
export class NonceCache {
  private seen = new Map<string, number>();

  /** The clock is injectable so retention is testable without sleeping. */
  constructor(
    private windowSeconds = MAX_REPLAY_WINDOW_SECONDS * 2,
    private now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  has(nonce: string): boolean {
    this.sweep();
    return this.seen.has(nonce);
  }

  add(nonce: string): void {
    this.seen.set(nonce, this.now());
  }

  private sweep(): void {
    const cutoff = this.now() - this.windowSeconds;
    for (const [n, t] of this.seen) if (t < cutoff) this.seen.delete(n);
  }

  get size(): number {
    return this.seen.size;
  }
}

/**
 * The Web Bot Auth key directory document.
 * Served at /.well-known/http-message-signatures-directory with content type
 * application/http-message-signatures-directory+json.
 */
export function keyDirectoryDocument(keys: Array<{ keyId: string; jwk: AgentJwk }>): {
  keys: Array<AgentJwk & { kid: string }>;
} {
  return { keys: keys.map(({ keyId, jwk }) => ({ ...jwk, kid: keyId })) };
}

export { toBase64Url };

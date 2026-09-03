import { describe, it, expect } from 'vitest';
import {
  signRequest, verifyRequest, signatureBase, serializeParams, contentDigest,
  NonceCache, keyDirectoryDocument, MAX_REPLAY_WINDOW_SECONDS,
  type RequestLike,
} from '../src/http/signatures.js';
import { generateKeypair, publicKeyToJwk, sign as edSign } from '../src/crypto/keys.js';

const kp = generateKeypair();
const resolveKey = (keyId: string) => (keyId === kp.keyId ? publicKeyToJwk(kp.publicKey) : null);

function req(over: Partial<RequestLike> = {}): RequestLike {
  return {
    method: 'POST',
    authority: 'collector.provenant.dev',
    path: '/receipts',
    headers: {},
    ...over,
  };
}

function signed(r: RequestLike, opts = {}): RequestLike {
  const headers = signRequest(r, kp.secretKey, kp.keyId, opts);
  return { ...r, headers: { ...r.headers, ...headers } };
}

describe('RFC 9421 signature base construction', () => {
  it('builds the base exactly per section 2.5', () => {
    const base = signatureBase(
      ['@method', '@authority', '@path'],
      { keyid: 'k1', created: 1_700_000_000, alg: 'ed25519' },
      req(),
    );
    expect(base).toBe(
      '"@method": POST\n' +
        '"@authority": collector.provenant.dev\n' +
        '"@path": /receipts\n' +
        '"@signature-params": ("@method" "@authority" "@path");created=1700000000;keyid="k1";alg="ed25519"',
    );
    // No trailing newline -- an extra byte here breaks interop silently.
    expect(base.endsWith('\n')).toBe(false);
  });

  it('covers the query string via @query, not @path', () => {
    // @path deliberately excludes the query, so @query must be covered
    // separately -- otherwise `?limit=100000&agent_id=someone_else` travels
    // unauthenticated and can be rewritten in flight.
    const r = signed(req({ path: '/receipts?limit=10' }));
    expect(r.headers['signature-input']).toContain('"@query"');
    expect(verifyRequest(r, { resolveKey }).ok).toBe(true);

    const rewritten = { ...r, path: '/receipts?limit=100000&agent_id=someone_else' };
    const v = verifyRequest(rewritten, { resolveKey });
    expect(v.ok, 'query string rewrite went undetected').toBe(false);
  });

  it('excludes the query string from @path itself', () => {
    const base = signatureBase(['@path'], { keyid: 'k', created: 1 }, req({ path: '/receipts?limit=10' }));
    expect(base).toContain('"@path": /receipts');
    expect(base).not.toContain('limit=10');
  });

  it('lowercases authority and uppercases method', () => {
    const base = signatureBase(
      ['@method', '@authority'],
      { keyid: 'k', created: 1 },
      req({ method: 'post', authority: 'Collector.Provenant.DEV' }),
    );
    expect(base).toContain('"@method": POST');
    expect(base).toContain('"@authority": collector.provenant.dev');
  });

  it('serializes parameters in the documented order', () => {
    expect(
      serializeParams(['@method'], { keyid: 'k', created: 1, expires: 2, nonce: 'n', alg: 'ed25519' }),
    ).toBe('("@method");created=1;expires=2;nonce="n";keyid="k";alg="ed25519"');
  });
});

describe('sign and verify round trip', () => {
  it('verifies a well-formed signed request', () => {
    const r = signed(req());
    const v = verifyRequest(r, { resolveKey });
    expect(v.reason).toBe('');
    expect(v.ok).toBe(true);
    expect(v.keyId).toBe(kp.keyId);
  });

  it('covers a request body via content-digest', () => {
    const body = new TextEncoder().encode(JSON.stringify({ action: 'refund.issue' }));
    const r = signed(req({ body }));
    expect(r.headers['content-digest']).toBe(contentDigest(body));
    expect(verifyRequest(r, { resolveKey }).ok).toBe(true);
  });

  it('rejects a swapped body even though the signature is otherwise valid', () => {
    const body = new TextEncoder().encode('{"amount_usd":10}');
    const r = signed(req({ body }));
    const tampered = { ...r, body: new TextEncoder().encode('{"amount_usd":999999}') };
    const v = verifyRequest(tampered, { resolveKey });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/Content-Digest does not match/);
  });

  it('rejects an unknown key', () => {
    const other = generateKeypair();
    const r = signed(req());
    const v = verifyRequest(r, { resolveKey: (id) => (id === other.keyId ? publicKeyToJwk(other.publicKey) : null) });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/unknown keyid/);
  });

  it('rejects a signature made by a different key', () => {
    const attacker = generateKeypair();
    const r = req();
    const headers = signRequest(r, attacker.secretKey, kp.keyId); // claims our keyid
    const v = verifyRequest({ ...r, headers }, { resolveKey });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/does not verify/);
  });
});

/**
 * THE TRAP THE BRIEF CALLED OUT: signing @authority without @path means a
 * captured signature replays against ANY endpoint on that origin until expiry.
 * A signature for GET /health would authorise POST /receipts.
 */
describe('required coverage prevents cross-endpoint replay', () => {
  it('rejects a signature that covers @authority but not @path', () => {
    const r = req();
    const created = Math.floor(Date.now() / 1000);
    const params = { keyid: kp.keyId, created, alg: 'ed25519' };
    const base = signatureBase(['@method', '@authority'], params, r);

    // A genuinely valid signature -- over an insufficient set of components.
    const sig = edSign(new TextEncoder().encode(base), kp.secretKey);

    const v = verifyRequest(
      {
        ...r,
        headers: {
          'signature-input': `sig1=${serializeParams(['@method', '@authority'], params)}`,
          signature: `sig1=:${Buffer.from(sig).toString('base64')}:`,
        },
      },
      { resolveKey },
    );

    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/does not cover @path/);
    expect(v.reason).toMatch(/replayed against any endpoint/);
  });

  it('a signature for one path does not verify on another', () => {
    const r = signed(req({ path: '/health' }));
    const replayed = { ...r, path: '/receipts' };
    expect(verifyRequest(replayed, { resolveKey }).ok).toBe(false);
  });

  it('a signature for one method does not verify on another', () => {
    const r = signed(req({ method: 'GET' }));
    expect(verifyRequest({ ...r, method: 'POST' }, { resolveKey }).ok).toBe(false);
  });

  it('a signature for one host does not verify on another', () => {
    const r = signed(req({ authority: 'a.example' }));
    expect(verifyRequest({ ...r, authority: 'b.example' }, { resolveKey }).ok).toBe(false);
  });

  it('rejects a body-bearing request whose signature omits content-digest', () => {
    const r = req();
    const headers = signRequest(r, kp.secretKey, kp.keyId); // signed with no body
    const withBody = { ...r, headers, body: new TextEncoder().encode('injected') };
    const v = verifyRequest(withBody, { resolveKey });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/does not cover content-digest/);
  });
});

describe('freshness and replay', () => {
  const now = 1_800_000_000;

  it('accepts a signature inside the replay window', () => {
    const r = signed(req(), { created: now - 30, expires: now + 270 });
    expect(verifyRequest(r, { resolveKey, nowSeconds: now }).ok).toBe(true);
  });

  it(`rejects one older than ${MAX_REPLAY_WINDOW_SECONDS}s`, () => {
    const r = signed(req(), { created: now - 61, expires: now + 300 });
    const v = verifyRequest(r, { resolveKey, nowSeconds: now });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/replay window/);
  });

  it('rejects one created in the future', () => {
    const r = signed(req(), { created: now + 120, expires: now + 400 });
    expect(verifyRequest(r, { resolveKey, nowSeconds: now }).reason).toMatch(/future/);
  });

  it('rejects an expired signature', () => {
    const r = signed(req(), { created: now - 10, expires: now - 1 });
    expect(verifyRequest(r, { resolveKey, nowSeconds: now }).reason).toMatch(/expired/);
  });

  it('caps signature lifetime at 24 hours regardless of what is claimed', () => {
    const r = signed(req(), { created: now - 5, expires: now + 48 * 3600 });
    const v = verifyRequest(r, { resolveKey, nowSeconds: now });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/lifetime exceeds/);
  });

  it('rejects a reused nonce', () => {
    const r = signed(req(), { created: now, expires: now + 60, nonce: 'abc123' });
    const cache = new NonceCache();
    expect(verifyRequest(r, { resolveKey, nowSeconds: now, seenNonce: (n) => cache.has(n) }).ok).toBe(true);
    cache.add('abc123');
    const second = verifyRequest(r, { resolveKey, nowSeconds: now, seenNonce: (n) => cache.has(n) });
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/replay/);
  });

  it('mints a nonce by default, so verbatim replay is blocked', () => {
    // The freshness window alone leaves a ~120s replay hole (60s each side for
    // clock skew). Previously signRequest never produced a nonce and
    // requireNonce defaulted off, so the nonce cache was dead code and an
    // identical signed request could simply be resent.
    const r = signed(req(), { created: now, expires: now + 60 });
    expect(r.headers['signature-input']).toMatch(/nonce="/);

    const cache = new NonceCache();
    const seen = (n: string) => cache.has(n);
    const first = verifyRequest(r, { resolveKey, nowSeconds: now, seenNonce: seen });
    expect(first.ok).toBe(true);
    cache.add(first.nonce!);

    const replay = verifyRequest(r, { resolveKey, nowSeconds: now, seenNonce: seen });
    expect(replay.ok).toBe(false);
    expect(replay.reason).toMatch(/replay/);
  });

  it('rejects a nonce-less signature unless the caller opts out explicitly', () => {
    const r = signed(req(), { created: now, expires: now + 60 });
    // Strip the nonce the signer added.
    const stripped = {
      ...r,
      headers: { ...r.headers, 'signature-input': r.headers['signature-input']!.replace(/;nonce="[^"]*"/, '') },
    };
    expect(verifyRequest(stripped, { resolveKey, nowSeconds: now }).reason).toMatch(/nonce is required/);
    // Opting out is possible, but only by saying so.
    expect(
      verifyRequest(stripped, { resolveKey, nowSeconds: now, requireNonce: false }).reason,
    ).not.toMatch(/nonce is required/);
  });
});

describe('NonceCache', () => {
  it('remembers a nonce inside the retention window', () => {
    let t = 1000;
    const cache = new NonceCache(120, () => t);
    cache.add('a');
    t += 60;
    expect(cache.has('a')).toBe(true);
  });

  it('forgets nonces past the window, so it cannot be grown without bound', () => {
    // Entries older than the window are useless anyway -- the freshness check
    // already rejects those requests -- so dropping them is safe and keeps the
    // cache bounded regardless of traffic.
    let t = 1000;
    const cache = new NonceCache(120, () => t);
    for (let i = 0; i < 1000; i++) cache.add(`n${i}`);
    expect(cache.size).toBe(1000);
    t += 121;
    expect(cache.has('n0')).toBe(false);
    expect(cache.size).toBe(0);
  });
});

describe('key directory document', () => {
  it('emits a JWKS-shaped directory with kid set to the thumbprint', () => {
    const doc = keyDirectoryDocument([{ keyId: kp.keyId, jwk: publicKeyToJwk(kp.publicKey) }]);
    expect(doc.keys).toHaveLength(1);
    expect(doc.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', kid: kp.keyId });
    expect(doc.keys[0]!.x).toBeTruthy();
  });
});

describe('malformed input never throws', () => {
  it('returns a failure verdict rather than crashing', () => {
    const cases: Array<Record<string, string>> = [
      {},
      { 'signature-input': 'garbage', signature: 'garbage' },
      { 'signature-input': 'sig1=()', signature: 'sig1=::' },
      { 'signature-input': 'sig1=("@method");created=abc;keyid="k"', signature: 'sig1=:AAAA:' },
    ];
    for (const headers of cases) {
      expect(() => verifyRequest(req({ headers }), { resolveKey })).not.toThrow();
      expect(verifyRequest(req({ headers }), { resolveKey }).ok).toBe(false);
    }
  });
});

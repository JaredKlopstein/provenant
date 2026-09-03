import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  openDb, closeDb, generateKeypair, deriveAgentId, publicKeyToJwk, signRequest,
  type Db, type Keypair,
} from '@provenant/core';
import { createCollector } from '../src/collector/server.js';

let db: Db;
let server: Server;
let base: string;
let authority: string;
let kp: Keypair;
let agentId: string;

beforeAll(async () => {
  db = openDb(':memory:');
  kp = generateKeypair();
  agentId = deriveAgentId(kp.publicKey);
  server = createCollector({ db });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  authority = `127.0.0.1:${port}`;
  base = `http://${authority}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  closeDb(db);
});

/** Sign a request the way an agent would, then send it. */
async function signedFetch(method: string, path: string, body?: unknown) {
  const bodyBytes = body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body));
  const headers = signRequest(
    { method, authority, path, headers: {}, ...(bodyBytes ? { body: bodyBytes } : {}) },
    kp.secretKey,
    kp.keyId,
  );
  return fetch(base + path, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    ...(bodyBytes ? { body: bodyBytes } : {}),
  });
}

/**
 * The discovery surface is deliberately unauthenticated. An agent must be able
 * to learn how to use the service before it holds any credential -- requiring
 * auth to read the manual is how you get agents that cannot onboard.
 */
describe('unauthenticated discovery', () => {
  it('serves the full manifest at /discover', async () => {
    const res = await fetch(`${base}/discover`);
    expect(res.status).toBe(200);
    const m = (await res.json()) as Record<string, unknown>;
    expect(m.service).toBe('provenant');
    expect(Array.isArray(m.actions)).toBe(true);
    expect(Array.isArray(m.quickstart)).toBe(true);
    expect((m.standards as Record<string, string>).canonicalization).toContain('8785');
  });

  it('serves /llms.txt pointing agents at /discover', async () => {
    const res = await fetch(`${base}/llms.txt`);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    const text = await res.text();
    expect(text).toContain('/discover');
    expect(text).toContain('RFC 9421');
    // The honesty line must survive into the agent-facing doc.
    expect(text).toContain('does not make anyone compliant');
  });

  it('serves the key directory with the Web Bot Auth content type', async () => {
    const res = await fetch(`${base}/.well-known/http-message-signatures-directory`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/http-message-signatures-directory+json');
    expect((await res.json()) as unknown).toHaveProperty('keys');
  });
});

describe('self-registration', () => {
  it('registers an agent with no approval, email or captcha', async () => {
    const res = await fetch(`${base}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        display_name: 'billing-agent',
        public_key_jwk: publicKeyToJwk(kp.publicKey),
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; result: { agent_id: string }; next_actions: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.result.agent_id).toBe(agentId);
    expect(body.next_actions.length).toBeGreaterThan(0);
  });

  it('is idempotent for the same key', async () => {
    const res = await fetch(`${base}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        display_name: 'billing-agent',
        public_key_jwk: publicKeyToJwk(kp.publicKey),
      }),
    });
    expect(res.status).toBe(200); // 200, not 201: nothing new was created
  });

  it('refuses a different key for an existing agent id (TOFU)', async () => {
    const attacker = generateKeypair();
    const res = await fetch(`${base}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        display_name: 'not-really',
        public_key_jwk: publicKeyToJwk(attacker.publicKey),
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('AGENT_KEY_MISMATCH');
    expect(body.error.message).toMatch(/Nothing was written/);
  });

  it('rejects a malformed registration with an actionable fix', async () => {
    const res = await fetch(`${base}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'no key' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { fix: { note: string } } };
    expect(body.error.fix.note).toContain('public_key_jwk');
  });
});

describe('signed requests', () => {
  it('rejects an unsigned request to a protected endpoint', async () => {
    const res = await fetch(`${base}/receipts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; fix: { note: string } } };
    expect(body.error.code).toBe('SIGNATURE_INVALID');
    // The error teaches the fix, including which components must be covered.
    expect(body.error.fix.note).toContain('@method');
    expect(body.error.fix.note).toContain('@path');
  });

  it('accepts a correctly signed request past the auth layer', async () => {
    const res = await signedFetch('POST', '/receipts', { agent_id: agentId, action: 'refund.issue' });
    // Auth succeeded: we reach the handler, which returns a documented
    // not-implemented for remote submission rather than an auth failure.
    expect(res.status).not.toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/never holds agent secret keys/);
  });

  it('rejects a signature captured for one path and replayed on another', async () => {
    // The trap the design guards against: sign /health, replay against /receipts.
    const headers = signRequest(
      { method: 'POST', authority, path: '/health', headers: {} },
      kp.secretKey,
      kp.keyId,
    );
    const res = await fetch(`${base}/receipts`, { method: 'POST', headers });
    expect(res.status).toBe(401);
  });

  it('rejects a request whose body was swapped after signing', async () => {
    const original = new TextEncoder().encode(JSON.stringify({ agent_id: agentId, amount: 10 }));
    const headers = signRequest(
      { method: 'POST', authority, path: '/receipts', headers: {}, body: original },
      kp.secretKey,
      kp.keyId,
    );
    const res = await fetch(`${base}/receipts`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId, amount: 999999 }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a signature from a key that is not registered', async () => {
    const stranger = generateKeypair();
    const headers = signRequest(
      { method: 'POST', authority, path: '/receipts', headers: {} },
      stranger.secretKey,
      stranger.keyId,
    );
    const res = await fetch(`${base}/receipts`, { method: 'POST', headers });
    expect(res.status).toBe(401);
  });
});

describe('abuse resistance', () => {
  it('refuses an oversized body rather than buffering it', async () => {
    const huge = 'x'.repeat(300 * 1024);
    const res = await fetch(`${base}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blob: huge }),
    }).catch(() => null);
    // The server destroys the request; either a 413 or a transport error is a
    // correct outcome. What must NOT happen is a 200.
    if (res) expect(res.status).not.toBe(200);
  });

  it('returns a structured 404 that points at discovery', async () => {
    const res = await signedFetch('POST', '/nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { fix: { action: string } } };
    expect(body.error.fix.action).toBe('discover');
  });
});

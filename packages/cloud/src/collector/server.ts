/**
 * The hosted collector: an HTTP endpoint agents write receipts to.
 *
 * Auth is RFC 9421 Ed25519 HTTP Message Signatures with trust-on-first-use.
 * No sessions, no cookies, no bearer tokens, no refresh tokens, no OAuth
 * redirect. An agent signs with the same key its receipts are signed with, and
 * a first-seen key binds that agent id permanently.
 *
 * Built on node:http rather than a framework on purpose: this process accepts
 * unauthenticated bytes from the public internet, and every dependency in that
 * path is attack surface a customer's security reviewer will ask about.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import {
  verifyRequest, NonceCache, keyDirectoryDocument, buildManifest,
  registerAgent, keyDirectory, requireAgent,
  ProvenantError, toProvenantError, jwkToPublicKey, jwkThumbprint,
  type Db, type AgentJwk,
} from '@provenant/core';

export interface CollectorOptions {
  db: Db;
  /** The host agents address this collector as; used for @authority checking. */
  authority?: string;
  /** Max request body, bytes. A receipt is small; anything large is abuse. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY = 256 * 1024;

export function createCollector(opts: CollectorOptions): Server {
  const nonces = new NonceCache();
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;

  return createServer((req, res) => {
    handle(req, res, opts, nonces, maxBody).catch((err) => {
      // Never leak a stack trace to an unauthenticated caller.
      send(res, 500, { error: { code: 'INTERNAL', message: 'internal error', retryable: true } });
      console.error('collector error:', err);
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: CollectorOptions,
  nonces: NonceCache,
  maxBody: number,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  // ---- unauthenticated discovery surface ----
  // Deliberately open: an agent must be able to learn how to use this service
  // before it has any credential. Requiring auth to read the manual is how you
  // get agents that cannot onboard.
  if (req.method === 'GET' && path === '/discover') {
    return send(res, 200, buildManifest());
  }
  if (req.method === 'GET' && path === '/llms.txt') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return void res.end(llmsTxt(opts.authority ?? url.host));
  }
  if (req.method === 'GET' && path === '/.well-known/http-message-signatures-directory') {
    const dir = keyDirectory(opts.db);
    const doc = keyDirectoryDocument(
      Object.entries(dir).map(([, jwk]) => ({ keyId: (jwk as AgentJwk & { kid?: string }).kid ?? '', jwk: jwk as AgentJwk })),
    );
    res.writeHead(200, { 'content-type': 'application/http-message-signatures-directory+json' });
    return void res.end(JSON.stringify(doc));
  }
  if (req.method === 'GET' && path === '/health') {
    return send(res, 200, { ok: true });
  }

  const body = await readBody(req, maxBody);
  if (body === null) {
    return send(res, 413, {
      error: {
        code: 'BODY_TOO_LARGE',
        message: `Request body exceeds ${maxBody} bytes. Nothing was written.`,
        retryable: false,
        fix: { note: 'Receipts hash their inputs rather than storing them; send hashes, not payloads.' },
      },
    });
  }

  // ---- registration: the one endpoint that establishes a key ----
  if (req.method === 'POST' && path === '/agents') {
    return registerEndpoint(res, opts, body);
  }

  // ---- everything else requires a valid signature ----
  const authority = opts.authority ?? String(req.headers.host ?? '');
  const verdict = verifyRequest(
    {
      method: req.method ?? 'GET',
      authority,
      path: url.pathname + url.search,
      headers: normalizeHeaders(req.headers),
      body,
    },
    {
      resolveKey: (keyId: string) => resolveKeyId(opts.db, keyId),
      seenNonce: (n: string) => nonces.has(n),
    },
  );

  if (!verdict.ok) {
    return send(res, 401, {
      error: {
        code: 'SIGNATURE_INVALID',
        message: `Request signature rejected: ${verdict.reason}. Nothing was written.`,
        retryable: false,
        fix: {
          note:
            'Sign with RFC 9421 Ed25519 covering @method, @authority and @path (plus content-digest ' +
            'when there is a body), created within 60 seconds. See GET /discover for a worked example.',
        },
      },
    });
  }
  if (verdict.nonce) nonces.add(verdict.nonce);

  if (req.method === 'POST' && path === '/receipts') {
    return recordEndpoint(res, opts, body, verdict.keyId!);
  }

  return send(res, 404, {
    error: {
      code: 'NOT_FOUND',
      message: `No endpoint ${req.method} ${path}. Nothing was written.`,
      retryable: false,
      fix: { action: 'discover', arguments: {}, note: 'GET /discover lists every endpoint and its schema.' },
    },
  });
}

function registerEndpoint(res: ServerResponse, opts: CollectorOptions, body: Uint8Array): void {
  try {
    const input = JSON.parse(new TextDecoder().decode(body)) as {
      agent_id?: string; display_name?: string; public_key_jwk?: AgentJwk;
      agent_version?: string; capabilities?: string[];
    };
    if (!input.public_key_jwk || !input.agent_id) {
      throw new ProvenantError({
        code: 'INVALID_INPUT',
        message: 'agent_id and public_key_jwk are required. Nothing was written.',
        retryable: false,
        fix: { note: 'POST {"agent_id","display_name","public_key_jwk":{"kty":"OKP","crv":"Ed25519","x":"..."}}' },
      });
    }
    jwkToPublicKey(input.public_key_jwk); // validates shape before we store it

    const agent = registerAgent(opts.db, {
      agentId: input.agent_id,
      displayName: input.display_name ?? input.agent_id,
      publicKeyJwk: input.public_key_jwk,
      ...(input.agent_version ? { agentVersion: input.agent_version } : {}),
      ...(input.capabilities ? { declaredCapabilities: input.capabilities } : {}),
    });

    send(res, agent.created ? 201 : 200, {
      ok: true,
      result: agent,
      next_actions: [
        {
          action: 'record',
          arguments: { action: 'example.action', side_effect_class: 'write' },
          why: 'You are registered. Sign requests to POST /receipts with this key.',
        },
      ],
    });
  } catch (err) {
    const pe = toProvenantError(err);
    send(res, pe.code === 'AGENT_KEY_MISMATCH' ? 409 : 400, pe.toJSON());
  }
}

function recordEndpoint(res: ServerResponse, opts: CollectorOptions, body: Uint8Array, keyId: string): void {
  try {
    const input = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    const agentId = String(input.agent_id ?? '');
    const agent = requireAgent(opts.db, agentId);

    // The signing key must be the key bound to the agent it claims to be. Without
    // this, any registered agent could write receipts attributed to another.
    if (agent.keyId !== keyId) {
      throw new ProvenantError({
        code: 'AGENT_KEY_MISMATCH',
        message:
          `The request was signed with key ${keyId}, but agent '${agentId}' is bound to ${agent.keyId}. ` +
          `An agent may only record its own actions. Nothing was written.`,
        retryable: false,
        fix: { note: 'Sign with the key registered to this agent_id, or record under your own agent_id.' },
      });
    }

    // NOTE: the collector cannot sign receipts -- it does not hold agent secret
    // keys and must never hold them. Agents sign locally and submit the signed
    // receipt; the collector only chains and stores it. That is what keeps a
    // hosted deployment from being able to forge its customers' records.
    throw new ProvenantError({
      code: 'INVALID_INPUT',
      message:
        'Submitting pre-signed receipts to the hosted collector is not implemented yet. ' +
        'The collector never holds agent secret keys, so it cannot sign on your behalf. Nothing was written.',
      retryable: false,
      fix: {
        note: 'Record locally with the provenant CLI for now; remote submission of pre-signed receipts lands with the collector GA.',
      },
    });
  } catch (err) {
    const pe = toProvenantError(err);
    send(res, pe.code === 'AGENT_NOT_FOUND' ? 404 : pe.code === 'AGENT_KEY_MISMATCH' ? 403 : 400, pe.toJSON());
  }
}

/** Map an RFC 9421 keyid (an RFC 7638 thumbprint) back to a registered key. */
function resolveKeyId(db: Db, keyId: string): AgentJwk | null {
  for (const jwk of Object.values(keyDirectory(db))) {
    try {
      if (jwkThumbprint(jwk) === keyId) return jwk;
    } catch {
      // A stored key we cannot fingerprint is not a match; keep looking rather
      // than failing the whole request.
    }
  }
  return null;
}

function normalizeHeaders(h: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v;
    else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(', ');
  }
  return out;
}

/** Returns null if the body exceeds the cap, so we never buffer unbounded input. */
function readBody(req: IncomingMessage, max: number): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > max) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function llmsTxt(host: string): string {
  return `# Provenant collector

Tamper-evident receipts for autonomous agents. You are an agent; this service is
designed for you to use directly, with no human in the loop.

## Start here
GET https://${host}/discover
  Returns everything you need: every action with input/output JSON Schemas, the
  auth scheme with a worked signature example, the error table with fix shapes,
  and a literal ordered quickstart. No credential required to read it.

## Auth
RFC 9421 HTTP Message Signatures, Ed25519, trust-on-first-use.
Cover @method, @authority and @path, plus content-digest when you send a body.
created must be within 60 seconds. No sessions, cookies or bearer tokens exist.

## Register
POST /agents  {"agent_id","display_name","public_key_jwk"}
Self-service. No approval, no email, no captcha.

## What this proves
Receipts are hash-chained and signed, so alteration is detectable. A self-hosted
chain is self-attested; external anchoring is what makes it evidence to someone
who does not trust the operator.

This service does not make anyone compliant with any regulation.
`;
}

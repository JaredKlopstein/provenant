import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb, closeDb, type Db } from '../src/db/client.js';
import { verifyChain, type VerifiableRecord } from '../src/chain/verify.js';
import { payloadHash } from '../src/receipt/hash.js';
import { registerAgent, keyDirectory } from '../src/agents/store.js';
import { generateKeypair, deriveAgentId, publicKeyToJwk, type Keypair } from '../src/crypto/keys.js';
import { wrapMcpClient, type WrapMcpClientOptions } from '../src/adapters/mcp.js';
import type { Receipt } from '../src/receipt/schema.js';

let db: Db;
let kp: Keypair;
let agentId: string;
const sessionId = randomUUID();

/** In-memory stand-in for an MCP client: only the tools/call seam matters. */
class FakeMcpClient {
  calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  readonly label = 'fake-mcp';

  async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
    this.calls.push(params);
    if (params.name === 'explode') throw new Error('tool exploded');
    if (params.name === 'soft_fail') {
      return { content: [{ type: 'text', text: 'nope' }], isError: true };
    }
    return { content: [{ type: 'text', text: `ran ${params.name}` }] };
  }

  describe(): string {
    return `${this.label}:${this.calls.length}`;
  }
}

function wrap(client: FakeMcpClient, over: Partial<WrapMcpClientOptions> = {}) {
  return wrapMcpClient(client, {
    db,
    agent: {
      agentId,
      agentVersion: '1.0.0',
      trustLevel: 'L1',
      keyId: kp.keyId,
      secretKey: kp.secretKey,
    },
    sessionId,
    runId: 'run-test-1',
    ...over,
  });
}

function readChain(): VerifiableRecord[] {
  return db.$client
    .prepare('SELECT seq, canonical_json as canonical_json, self_hash as self_hash FROM receipts ORDER BY seq')
    .all() as VerifiableRecord[];
}

function storedReceipts(): Receipt[] {
  return readChain().map((r) => JSON.parse(r.canonical_json) as Receipt);
}

/** Every byte the store holds for receipts, for plain-text leak checks. */
function storedText(): string {
  return JSON.stringify(db.$client.prepare('SELECT * FROM receipts').all());
}

beforeEach(() => {
  db = openDb(':memory:');
  kp = generateKeypair();
  agentId = deriveAgentId(kp.publicKey);
  registerAgent(db, {
    agentId,
    displayName: 'test-agent',
    publicKeyJwk: publicKeyToJwk(kp.publicKey),
    agentVersion: '1.0.0',
  });
});

afterEach(() => closeDb(db));

describe('wrapMcpClient', () => {
  it('writes one chained receipt per tools/call, and the chain verifies', async () => {
    const client = new FakeMcpClient();
    const wrapped = wrap(client, { turnId: 'turn-test-1', attemptId: 'attempt-test-1' });

    const args = { path: '/tmp/a.txt' };
    const r1 = await wrapped.callTool({ name: 'read_file', arguments: args });
    const r2 = await wrapped.callTool({ name: 'write_file', arguments: { path: '/tmp/b.txt' } });

    // The original client was called and its results passed through untouched.
    expect(client.calls.map((c) => c.name)).toEqual(['read_file', 'write_file']);
    expect(r1).toEqual({ content: [{ type: 'text', text: 'ran read_file' }] });
    expect(r2).toEqual({ content: [{ type: 'text', text: 'ran write_file' }] });

    const receipts = storedReceipts();
    expect(receipts).toHaveLength(2);
    expect(receipts.map((r) => r.lacre.action)).toEqual(['mcp.read_file', 'mcp.write_file']);
    expect(receipts[1]!.prev_hash).not.toBeNull();

    const [first] = receipts;
    expect(first).toMatchObject({
      action_type: 'tool_call',
      action_detail: { tool: 'read_file' },
      outcome: 'success',
      session_id: sessionId,
      input_hash: payloadHash(args),
      output_hash: payloadHash(r1),
    });
    expect(first!.lacre).toMatchObject({
      issuer_kind: 'sdk',
      provenance_class: 'observed',
      run_id: 'run-test-1',
      turn_id: 'turn-test-1',
      attempt_id: 'attempt-test-1',
    });

    const result = verifyChain(readChain(), keyDirectory(db));
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.intact_ranges).toEqual([{ from_seq: 0, to_seq: 1 }]);
  });

  it('omits turn_id and attempt_id when not supplied', async () => {
    await wrap(new FakeMcpClient()).callTool({ name: 'read_file', arguments: {} });
    const [r] = storedReceipts();
    expect('turn_id' in r!.lacre).toBe(false);
    expect('attempt_id' in r!.lacre).toBe(false);
  });

  it('defaults the side-effect class to write, and a per-tool map overrides it', async () => {
    const wrapped = wrap(new FakeMcpClient(), { sideEffectClass: { read_file: 'read', rm: 'irreversible' } });
    await wrapped.callTool({ name: 'read_file', arguments: {} });
    await wrapped.callTool({ name: 'rm', arguments: {} });
    await wrapped.callTool({ name: 'unknown_tool', arguments: {} });
    // A tool named after an Object.prototype key is still unknown, not a function.
    await wrapped.callTool({ name: 'constructor', arguments: {} });

    expect(storedReceipts().map((r) => r.lacre.side_effect_class)).toEqual([
      'read',
      'irreversible',
      'write',
      'write',
    ]);
  });

  it('defaults to write with no option, and a single class applies to every tool', async () => {
    await wrap(new FakeMcpClient()).callTool({ name: 'a', arguments: {} });
    await wrap(new FakeMcpClient(), { sideEffectClass: 'read' }).callTool({ name: 'b', arguments: {} });
    expect(storedReceipts().map((r) => r.lacre.side_effect_class)).toEqual(['write', 'read']);
  });

  it('stores no plain-text argument by default, only its hash', async () => {
    const marker = 'plain-text-argument-marker';
    const args = { query: marker, nested: { note: marker } };
    await wrap(new FakeMcpClient()).callTool({ name: 'search', arguments: args });

    const [r] = storedReceipts();
    expect(r!.action_detail).toEqual({ tool: 'search' });
    expect(r!.input_hash).toBe(payloadHash(args));
    expect(storedText()).not.toContain(marker);
  });

  it('stores the arguments in action_detail when storeArgs is true', async () => {
    const args = { query: 'visible' };
    await wrap(new FakeMcpClient(), { storeArgs: true }).callTool({ name: 'search', arguments: args });
    const [r] = storedReceipts();
    expect(r!.action_detail).toEqual({ tool: 'search', arguments: args });
    expect(r!.input_hash).toBe(payloadHash(args));
  });

  it('a throwing tool writes a failure receipt and re-throws the same error', async () => {
    const wrapped = wrap(new FakeMcpClient());
    const args = { secret_ish: 'should-not-be-stored' };

    let caught: unknown;
    try {
      await wrapped.callTool({ name: 'explode', arguments: args });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('tool exploded');

    const [r] = storedReceipts();
    expect(r).toMatchObject({
      outcome: 'failure',
      action_type: 'tool_call',
      action_detail: { tool: 'explode' },
      input_hash: payloadHash(args),
    });
    expect(r!.lacre.action).toBe('mcp.explode');
    expect('output_hash' in r!).toBe(false);
    expect(storedText()).not.toContain('should-not-be-stored');

    expect(verifyChain(readChain(), keyDirectory(db)).ok).toBe(true);
  });

  it('the re-thrown error is the identical object', async () => {
    const boom = new Error('identity check');
    const client = { callTool: async () => { throw boom; } };
    await expect(wrap(client as unknown as FakeMcpClient).callTool({ name: 'x' })).rejects.toBe(boom);
    expect(storedReceipts()[0]!.outcome).toBe('failure');
  });

  it('an MCP isError result is recorded as failure and returned unchanged', async () => {
    const result = await wrap(new FakeMcpClient()).callTool({ name: 'soft_fail', arguments: {} });
    expect(result).toEqual({ content: [{ type: 'text', text: 'nope' }], isError: true });
    const [r] = storedReceipts();
    expect(r!.outcome).toBe('failure');
    expect(r!.output_hash).toBe(payloadHash(result));
  });

  it('passes extra callTool arguments through and leaves other members working', async () => {
    const seen: unknown[][] = [];
    const client = new FakeMcpClient();
    const original = client.callTool.bind(client);
    client.callTool = async (...a: Parameters<FakeMcpClient['callTool']>) => {
      seen.push(a);
      return original(a[0]);
    };
    const wrapped = wrap(client);

    const extra = { timeout: 5 };
    await (wrapped.callTool as (...a: unknown[]) => Promise<unknown>)({ name: 'a', arguments: {} }, undefined, extra);
    expect(seen[0]).toEqual([{ name: 'a', arguments: {} }, undefined, extra]);

    expect(wrapped.label).toBe('fake-mcp');
    expect(wrapped.describe()).toBe('fake-mcp:1');
  });
});

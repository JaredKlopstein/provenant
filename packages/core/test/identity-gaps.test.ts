import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIO } from '../src/adapters/cli.js';
import { openDb, closeDb, type Db } from '../src/db/client.js';
import { appendReceipt } from '../src/chain/append.js';
import { registerAgent } from '../src/agents/store.js';
import { agentReliability } from '../src/agents/reliability.js';
import { generateKeypair, deriveAgentId, publicKeyToJwk } from '../src/crypto/keys.js';
import { randomUUID } from 'node:crypto';

let store: string;

async function json(args: string): Promise<{ code: number; body: Record<string, unknown> }> {
  let out = '';
  let err = '';
  const io: CliIO = { out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n') };
  const argv = (args.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? []).map((a) => a.replace(/^['"]|['"]$/g, ''));
  const code = await runCli([...argv, '--json', '--store', store], io);
  return { code, body: JSON.parse(code === 0 ? out : err) as Record<string, unknown> };
}

beforeEach(() => { store = mkdtempSync(join(tmpdir(), 'provenant-gaps-')); });
afterEach(() => rmSync(store, { recursive: true, force: true }));

describe('keygen', () => {
  it('creates a key without registering anything', async () => {
    const r = await json('keygen');
    expect(r.code).toBe(0);
    const res = r.body.result as { agent_id: string; registered: boolean; note: string };
    expect(res.agent_id).toMatch(/^urn:provenant:agent:/);
    expect(res.registered).toBe(false);
    expect(res.note).toMatch(/NOT registered/);
    // The key exists but no agent row does.
    expect(((await json('agent list')).body.result as { count: number }).count).toBe(0);
  });

  it('refuses to replace an existing key without --force', async () => {
    await json('keygen');
    const r = await json('keygen');
    expect(r.code).toBe(1);
    const e = r.body.error as { code: string; message: string; fix: { note: string } };
    expect(e.code).toBe('KEY_EXISTS');
    // Because agent ids derive from keys, replacing one abandons an identity.
    expect(e.message).toMatch(/abandon that identity/);
    expect(e.fix.note).toMatch(/archived, not deleted/);
  });

  it('archives rather than deletes when forced', async () => {
    const first = (await json('keygen')).body.result as { agent_id: string };
    const second = await json('keygen --force');
    const res = second.body.result as { agent_id: string; replaced: boolean; archived_previous_key: string };

    expect(res.replaced).toBe(true);
    expect(res.agent_id).not.toBe(first.agent_id); // a new key IS a new identity
    expect(existsSync(res.archived_previous_key)).toBe(true);
    expect(readdirSync(store).some((f) => f.includes('replaced-'))).toBe(true);
  });

  it('is classified irreversible and previews without writing', async () => {
    const dry = await json('keygen --dry-run');
    expect((dry.body.result as { note: string }).note).toMatch(/DRY RUN: nothing was written/);
    // No key file was created by the dry run.
    expect(readdirSync(store).some((f) => f.startsWith('agent.key'))).toBe(false);
  });
});

describe('agent.register', () => {
  it('binds a chosen id to this machine key', async () => {
    await json('keygen');
    const r = await json("agent register --agent-id billing-eu --display-name 'EU billing' --capabilities refund,email");
    expect(r.code).toBe(0);
    const res = r.body.result as { agent_id: string; created: boolean; declared_capabilities: string[]; note: string };
    expect(res.agent_id).toBe('billing-eu');
    expect(res.created).toBe(true);
    expect(res.declared_capabilities).toEqual(['refund', 'email']);
    expect(res.note).toMatch(/cannot be changed/);
  });

  it('is a no-op when re-registering the identical key', async () => {
    await json('keygen');
    await json('agent register --agent-id billing-eu');
    const again = await json('agent register --agent-id billing-eu');
    expect(again.code).toBe(0);
    expect((again.body.result as { created: boolean }).created).toBe(false);
  });

  it('refuses to rebind an id to a different key (TOFU)', async () => {
    await json('keygen');
    await json('agent register --agent-id billing-eu');
    const other = generateKeypair();
    const pk = Buffer.from(other.publicKey).toString('base64url');
    const r = await json(`agent register --agent-id billing-eu --public-key ${pk}`);
    expect(r.code).toBe(1);
    expect((r.body.error as { code: string }).code).toBe('AGENT_KEY_MISMATCH');
  });

  it('can enrol a remote agent from its public key alone', async () => {
    await json('keygen');
    const remote = generateKeypair();
    const pk = Buffer.from(remote.publicKey).toString('base64url');
    const r = await json(`agent register --agent-id worker-7 --public-key ${pk}`);
    expect(r.code).toBe(0);
    expect((r.body.result as { key_id: string }).key_id).toBe(remote.keyId);
  });

  it('warns in a dry run that a rebind would fail', async () => {
    await json('keygen');
    await json('agent register --agent-id billing-eu');
    const other = generateKeypair();
    const pk = Buffer.from(other.publicKey).toString('base64url');
    const dry = await json(`agent register --agent-id billing-eu --public-key ${pk} --dry-run`);
    expect((dry.body.result as { note: string }).note).toMatch(/would FAIL/);
  });
});

describe('flag aliases from the brief', () => {
  beforeEach(async () => {
    await json('init');
    await json("record --action refund.issue --action-detail '{\"n\":1}'");
    await json("record --action email.send --action-detail '{\"n\":2}'");
  });

  it('accepts --agent as well as --agent-id', async () => {
    const agents = (await json('agent list')).body.result as { agents: Array<{ agent_id: string }> };
    const id = agents.agents[0]!.agent_id;
    const byAlias = await json(`receipts query --agent ${id} --fields seq`);
    const byCanonical = await json(`receipts query --agent-id ${id} --fields seq`);
    expect(byAlias.code).toBe(0);
    expect(byAlias.body.result).toEqual(byCanonical.body.result);
  });

  it('accepts --from/--to on chain verify, as its own description promises', async () => {
    const r = await json('chain verify --from 0 --to 0');
    expect(r.code).toBe(0);
    expect((r.body.result as { receipts_checked: number }).receipts_checked).toBe(1);
  });

  it('still rejects a genuine typo rather than ignoring it', async () => {
    const r = await json('receipts query --agnt whoops');
    expect(r.code).toBe(1);
    expect((r.body.error as { code: string }).code).toBe('UNKNOWN_ARGUMENT');
  });

  it('advertises every alias in the manifest, so agents need not guess', async () => {
    const manifest = (await json('discover')).body as unknown as {
      actions: Array<{ name: string; aliases: Record<string, string> }>;
    };
    const q = manifest.actions.find((a) => a.name === 'receipts.query')!;
    expect(q.aliases.agent).toBe('agent_id');
  });
});

/**
 * The design decision under test: an unmeasurable rate is null with a reason,
 * never 0. Reporting a 0.0 contract-violation rate for a system with no
 * contracts would render a flawless record for an agent nobody has checked --
 * exactly the flattering false signal this product exists to prevent.
 */
describe('derived reliability reports nulls, not flattering zeros', () => {
  let db: Db;
  let agentId: string;

  beforeEach(() => {
    db = openDb(':memory:');
    const kp = generateKeypair();
    agentId = deriveAgentId(kp.publicKey);
    registerAgent(db, { agentId, displayName: 'a', publicKeyJwk: publicKeyToJwk(kp.publicKey), agentVersion: '1.0.0' });
    const sessionId = randomUUID();
    for (const outcome of ['success', 'success', 'failure', 'escalated'] as const) {
      appendReceipt(db, {
        agentId, agentVersion: '1.0.0', trustLevel: 'L1', keyId: kp.keyId, secretKey: kp.secretKey,
        action: 'refund.issue', actionType: 'tool_call', actionDetail: {},
        sideEffectClass: 'irreversible', outcome, sessionId,
      });
    }
  });
  afterEach(() => closeDb(db));

  it('reports null for contract violations when no contracts exist', () => {
    const r = agentReliability(db, agentId);
    expect(r.contract_violation_rate.rate).toBeNull();
    expect(r.contract_violation_rate.rate).not.toBe(0);
    expect(r.contract_violation_rate.unavailable_reason).toMatch(/not measurable and is NOT zero/);
  });

  it('reports null for lease expiry when no leases exist', () => {
    const r = agentReliability(db, agentId);
    expect(r.lease_expiry_rate.rate).toBeNull();
    expect(r.lease_expiry_rate.unavailable_reason).toMatch(/Phase 4/);
  });

  it('computes the rates that ARE measurable today', () => {
    const r = agentReliability(db, agentId);
    expect(r.receipts).toBe(4);
    expect(r.approval_escalation_rate.rate).toBeCloseTo(0.25);
    expect(r.failure_rate.rate).toBeCloseTo(0.25);
    expect(r.outcomes).toEqual({ success: 2, failure: 1, escalated: 1 });
    expect(r.irreversible_actions).toBe(4);
  });

  it('carries the self-reporting caveat with the numbers', () => {
    // The caveat has to travel with the value, not live in a README nobody
    // reads while looking at a dashboard.
    expect(agentReliability(db, agentId).caveat).toMatch(/chose to write/);
    expect(agentReliability(db, agentId).caveat).toMatch(/not evidence against a deliberately deceptive one/);
  });

  it('returns nulls rather than 0/0 NaN for an agent with no receipts', () => {
    const r = agentReliability(db, 'nobody');
    expect(r.receipts).toBe(0);
    expect(r.failure_rate.rate).toBeNull();
    expect(Number.isNaN(r.failure_rate.rate as number)).toBe(false);
  });
});

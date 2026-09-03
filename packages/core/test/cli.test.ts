import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIO } from '../src/adapters/cli.js';

let store: string;

function cli(args: string): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const io: CliIO = { out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n') };
  const argv = args.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g)?.map((a) => a.replace(/^['"]|['"]$/g, '')) ?? [];
  const code = runCli([...argv, '--store', store], io);
  return { code, out, err };
}

function json(args: string): { code: number; body: Record<string, unknown> } {
  const r = cli(args + ' --json');
  return { code: r.code, body: JSON.parse(r.code === 0 ? r.out : r.err) as Record<string, unknown> };
}

beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), 'provenant-cli-'));
});
afterEach(() => rmSync(store, { recursive: true, force: true }));

/**
 * DEFINITION OF DONE #4 -- THE COLD-AGENT TEST (local form).
 * An agent with no docs, working only from `discover` and error messages, must
 * get from nothing to a verified receipt. This walks exactly that path.
 */
describe('the cold-agent path', () => {
  it('gets from nothing to a verified receipt using only the quickstart', () => {
    const manifest = JSON.parse(cli('discover').out) as {
      quickstart: Array<{ action: string; arguments: Record<string, unknown> }>;
    };

    // Step 1: init
    const init = json('init --display-name cold-agent');
    expect(init.code).toBe(0);
    const agentId = (init.body.result as { agent_id: string }).agent_id;
    expect(agentId).toMatch(/^urn:provenant:agent:/);

    // Step 2: dry run reveals the exact receipt without writing it
    const dry = json(
      `record --action refund.issue --action-detail '{"amount_usd":42}' --side-effect-class irreversible --dry-run`,
    );
    expect(dry.code).toBe(0);
    expect((dry.body.result as { dry_run: boolean }).dry_run).toBe(true);
    expect(json('chain head').body.result).toMatchObject({ count: 0 });

    // Step 3: record for real
    const rec = json(
      `record --action refund.issue --action-detail '{"amount_usd":42}' --side-effect-class irreversible --idempotency-key r1`,
    );
    expect(rec.code).toBe(0);
    expect((rec.body.result as { seq: number }).seq).toBe(0);

    // Step 4: verify
    const verify = json('chain verify');
    expect(verify.code).toBe(0);
    expect((verify.body.result as { ok: boolean }).ok).toBe(true);

    // The quickstart it followed names only real actions.
    expect(manifest.quickstart.map((q) => q.action)).toEqual([
      'init',
      'record',
      'record',
      'chain.verify',
    ]);
  });

  it('every successful response carries ready-to-execute next_actions', () => {
    json('init');
    const rec = json(`record --action email.send`);
    const next = rec.body.next_actions as Array<{ action: string; arguments: unknown; why: string }>;
    expect(next.length).toBeGreaterThan(0);
    for (const n of next) {
      expect(n.action).toBeTruthy();
      expect(n.arguments).toBeTypeOf('object'); // filled in, not a template
      expect(n.why).toBeTruthy();
    }
  });
});

describe('CLI conventions', () => {
  beforeEach(() => json('init'));

  it('supports both dotted and spaced command forms', () => {
    expect(json('chain.verify').code).toBe(0);
    expect(json('chain verify').code).toBe(0);
  });

  it('emits JSON on stdout for success and stderr for errors', () => {
    const ok = cli('chain head --json');
    expect(ok.out.trim().startsWith('{')).toBe(true);
    expect(ok.err).toBe('');

    const bad = cli('record --json');
    expect(bad.err.trim().startsWith('{')).toBe(true);
    expect(bad.code).toBe(1);
  });

  it('parses JSON object flags and comma-separated array flags', () => {
    const r = json(`record --action t --action-detail '{"a":{"b":[1,2]}}'`);
    const receipt = (r.body.result as { receipt: { action_detail: unknown } }).receipt;
    expect(receipt.action_detail).toEqual({ a: { b: [1, 2] } });

    const q = json('receipts query --fields seq,action --limit 5');
    const items = (q.body.result as { items: Array<Record<string, unknown>> }).items;
    expect(Object.keys(items[0]!)).toEqual(['seq', 'action']);
  });

  it('refuses --dry-run on read actions with an explanatory error', () => {
    const r = json('chain verify --dry-run');
    expect(r.code).toBe(1);
    expect((r.body.error as { message: string }).message).toMatch(/read action/);
  });

  it('paginates with opaque cursors and an explicit truncated flag', () => {
    for (let i = 0; i < 7; i++) json(`record --action bulk.op --action-detail '{"i":${i}}'`);

    const first = json('receipts query --limit 3 --fields seq');
    const p1 = first.body.result as { items: Array<{ seq: number }>; truncated: boolean; next_cursor: string };
    expect(p1.items).toHaveLength(3);
    expect(p1.truncated).toBe(true);
    expect(p1.next_cursor).toBeTruthy();

    const second = json(`receipts query --limit 3 --fields seq --cursor ${p1.next_cursor}`);
    const p2 = second.body.result as { items: Array<{ seq: number }> };
    // No overlap with the first page.
    expect(p2.items.map((i) => i.seq)).not.toContain(p1.items[2]!.seq);
  });

  it('rejects a malformed cursor with a recovery path', () => {
    const r = json('receipts query --cursor not-a-cursor');
    expect(r.code).toBe(1);
    expect((r.body.error as { code: string }).code).toBe('INVALID_CURSOR');
    expect((r.body.error as { fix: { note: string } }).fix.note).toMatch(/without a cursor/i);
  });

  it('never emits an untyped error', () => {
    for (const cmd of ['nope', 'record', 'receipts query --cursor x', 'chain verify --dry-run']) {
      const r = cli(cmd + ' --json');
      if (r.code !== 0) {
        const body = JSON.parse(r.err) as { error: { code: string; retryable: boolean; message: string } };
        expect(body.error.code).toBeTruthy();
        expect(body.error.retryable).toBeTypeOf('boolean');
        // Every error must say whether the action executed.
        expect(body.error.message.toLowerCase()).toMatch(/nothing was (executed|written|returned)|did not/);
      }
    }
  });
});

/**
 * Guards against cloud using a second drizzle-orm instance (#47).
 *
 * pnpm resolves one drizzle-orm instance per distinct set of resolved peers, so
 * cloud can end up with an instance of its own. Its operators then no longer
 * match core's table types and the bundle export and anchor scheduler stop
 * typechecking. Those modules therefore take their operators from core, the
 * same instance as dbSchema. This test pins it two ways: the operators they
 * call at run time are the objects core re-exports, and no cloud module imports
 * an operator from drizzle-orm directly. The run-time check does not depend on
 * how node_modules happens to be laid out; the source check catches a revert
 * even when pnpm has deduped the two instances into one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as core from '@lacre/core';
import { createTestAuthority } from '../src/anchor/test-authority.js';
import { runAnchorTick } from '../src/anchor/scheduler.js';
import { exportBundle } from '../src/bundle/export.js';

const OPERATORS = ['and', 'asc', 'desc', 'eq', 'gt', 'gte', 'lte'] as const;
type Operator = (typeof OPERATORS)[number];

// Replace core's re-exported operators with pass-through spies. A cloud module
// that took its operator from anywhere else would never reach these.
vi.mock('@lacre/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@lacre/core')>();
  const spies = Object.fromEntries(
    (['and', 'asc', 'desc', 'eq', 'gt', 'gte', 'lte'] as const).map((op) => [op, vi.fn(real[op])]),
  );
  return { ...real, ...spies };
});

const spy = (op: Operator) => vi.mocked(core[op]);

const SRC = new URL('../src', import.meta.url).pathname;

/** Value names a source file imports, by specifier. Type-only imports are ignored. */
function importedNames(file: string): Map<string, string[]> {
  const src = readFileSync(file, 'utf8');
  const out = new Map<string, string[]>();
  for (const m of src.matchAll(/import\s*(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (m[1]) continue;
    const names = m[2]!
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('type '))
      .map((s) => s.split(/\s+as\s+/)[0]!.trim());
    out.set(m[3]!, [...(out.get(m[3]!) ?? []), ...names]);
  }
  return out;
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (full.endsWith('.ts')) files.push(full);
  }
  return files;
}

describe('cloud uses the drizzle-orm operators core re-exports', () => {
  let db: core.Db;
  let kp: core.Keypair;
  let agentId: string;
  const sessionId = randomUUID();

  function record() {
    core.appendReceipt(db, {
      agentId,
      agentVersion: '1.0.0',
      trustLevel: 'L1',
      keyId: kp.keyId,
      secretKey: kp.secretKey,
      action: 'refund.issue',
      actionType: 'tool_call',
      actionDetail: { customer: 'c_1', amount_usd: 42 },
      sideEffectClass: 'irreversible',
      outcome: 'success',
      sessionId,
    });
  }

  beforeEach(() => {
    db = core.openDb(':memory:');
    kp = core.generateKeypair();
    agentId = core.deriveAgentId(kp.publicKey);
    vi.clearAllMocks();
  });

  afterEach(() => core.closeDb(db));

  it('exportBundle builds its range query from core operators', () => {
    record();
    record();
    record();
    const bundle = exportBundle(db, { fromSeq: 1, toSeq: 2 });
    expect(bundle.receipts.map((r) => r.seq)).toEqual([1, 2]);
    for (const op of ['and', 'asc', 'gte', 'lte'] as const) expect(spy(op), op).toHaveBeenCalled();
  });

  it('runAnchorTick builds its pending query from core operators', async () => {
    // Far enough ahead that every pending receipt is due.
    const now = () => new Date(Date.now() + 24 * 60 * 60_000);
    const backend = createTestAuthority({ now });
    record();
    expect((await runAnchorTick({ db, backend, now })).status).toBe('anchored');
    record();
    expect((await runAnchorTick({ db, backend, now })).status).toBe('anchored');
    for (const op of ['asc', 'desc', 'eq', 'gt'] as const) expect(spy(op), op).toHaveBeenCalled();
  });

  it.each([
    ['bundle/export.ts', ['and', 'asc', 'gte', 'lte']],
    ['anchor/scheduler.ts', ['and', 'asc', 'desc', 'eq', 'gt']],
  ])('%s imports its operators from @lacre/core', (file, ops) => {
    const imports = importedNames(join(SRC, file));
    expect(imports.get('@lacre/core')).toEqual(expect.arrayContaining(ops));
    expect(imports.get('drizzle-orm') ?? []).toEqual([]);
  });

  it('nothing in cloud/src imports an operator from drizzle-orm directly', () => {
    const offenders = walk(SRC).flatMap((file) =>
      (importedNames(file).get('drizzle-orm') ?? [])
        .filter((n) => (OPERATORS as readonly string[]).includes(n))
        .map((n) => `${relative(SRC, file)}: ${n}`),
    );
    expect(offenders).toEqual([]);
  });
});

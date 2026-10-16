import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkRun, type RunKeys } from '../src/run.js';
import { runVerify, type VerifyIO } from '../src/cli.js';
import * as index from '../src/index.js';

/**
 * Fixtures were produced once with core (signReceipt / receiptHash /
 * payloadHash) and committed; this suite never imports core, so it checks the
 * verifier's re-implemented chain walk against records core actually wrote.
 * See fixtures/run/README.md for why long hashes and signatures are stored as
 * {"$chunks": [...]}.
 */
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'run');

function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === '$chunks' && Array.isArray(o.$chunks)) {
      return (o.$chunks as string[]).join('');
    }
    return Object.fromEntries(keys.map((k) => [k, decode(o[k])]));
  }
  return v;
}

const load = <T>(name: string): T => decode(JSON.parse(readFileSync(join(FIX, name), 'utf8'))) as T;
const receipts = (name: string) => load<Record<string, unknown>[]>(`${name}.json`);
const keys = load<RunKeys>('keys.json');

describe('checkRun', () => {
  it('accepts a valid run', () => {
    const r = checkRun(receipts('valid'), keys);
    expect(r.brokenLinks).toEqual([]);
    expect(r.gaps).toEqual([]);
    expect(r.duplicateAttempts).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.receiptsChecked).toBe(4);
  });

  it('flags a tampered record and the link after it', () => {
    const r = checkRun(receipts('tampered'), keys);
    expect(r.ok).toBe(false);
    expect(r.gaps).toEqual([]);
    expect(r.brokenLinks.map((b) => [b.seq, b.kind])).toEqual([
      [1, 'SIGNATURE_INVALID'],
      [2, 'LINK_BROKEN'],
    ]);
  });

  it('reports a missing record as a gap', () => {
    const r = checkRun(receipts('missing-record'), keys);
    expect(r.ok).toBe(false);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]).toMatchObject({ seq: 3, expectedSeq: 2 });
    // The survivor after the hole no longer links to its predecessor either.
    expect(r.brokenLinks.map((b) => [b.seq, b.kind])).toEqual([[3, 'LINK_BROKEN']]);
  });

  it('reports a truncated head and a non-null genesis prev_hash as gaps', () => {
    const r = checkRun(receipts('valid').slice(1), keys);
    expect(r.ok).toBe(false);
    expect(r.gaps.map((g) => g.seq)).toEqual([1, 1]);
    expect(r.gaps.map((g) => g.message).join(' ')).toMatch(/expected genesis at seq 0/);
    expect(r.gaps.map((g) => g.message).join(' ')).toMatch(/prev_hash must be null/);
  });

  it('flags a record signed under a key_id that is not in keys', () => {
    const r = checkRun(receipts('unknown-key'), keys);
    expect(r.ok).toBe(false);
    expect(r.gaps).toEqual([]);
    expect(r.brokenLinks.map((b) => [b.seq, b.kind])).toEqual([[2, 'UNKNOWN_KEY']]);
    expect(r.brokenLinks[0]!.message).toMatch(/test-key-unregistered/);
  });

  it('accepts a rotated key when both key_ids are known', () => {
    const r = checkRun(receipts('rotated-key'), keys);
    expect(r.brokenLinks).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('fails a rotated run when the new key is withheld', () => {
    const { 'test-key-b': _drop, ...onlyA } = keys;
    const r = checkRun(receipts('rotated-key'), onlyA);
    expect(r.ok).toBe(false);
    expect(r.brokenLinks.map((b) => [b.seq, b.kind])).toEqual([
      [2, 'UNKNOWN_KEY'],
      [3, 'UNKNOWN_KEY'],
    ]);
  });

  it('rejects a signature made by a different known key', () => {
    // Relabel seq 0 as signed by key b: the signature is now checked under the
    // wrong key, and the edit also breaks the link into seq 1.
    const rs = receipts('valid');
    (rs[0]!.provenant as Record<string, unknown>).key_id = 'test-key-b';
    const r = checkRun(rs, keys);
    expect(r.brokenLinks.map((b) => [b.seq, b.kind])).toEqual([
      [0, 'SIGNATURE_INVALID'],
      [1, 'LINK_BROKEN'],
    ]);
  });

  it('reports a duplicate attempt without invalidating the run', () => {
    const r = checkRun(receipts('duplicate-attempt'), keys);
    expect(r.ok).toBe(true);
    expect(r.brokenLinks).toEqual([]);
    expect(r.gaps).toEqual([]);
    expect(r.duplicateAttempts).toHaveLength(1);
    const d = r.duplicateAttempts[0]!;
    expect(d.action).toBe('refund.issue');
    expect(d.turnId).toBe('turn-2');
    expect(d.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.attempts).toEqual([
      { attemptId: 'attempt-2', seqs: [1] },
      { attemptId: 'attempt-3', seqs: [2] },
    ]);
  });

  it('accepts keys as raw 32-byte public keys', () => {
    const raw: RunKeys = {
      'test-key-a': new Uint8Array(Buffer.from((keys['test-key-a'] as { x: string }).x, 'base64url')),
    };
    expect(checkRun(receipts('valid'), raw).ok).toBe(true);
  });

  it('never throws on adversarial input', () => {
    const bad: unknown[] = [
      [null], [1, 'x'], [{}], [{ provenant: null }], [{ provenant: { seq: 'zero' } }],
      [{ prev_hash: null, provenant: { seq: 0, key_id: 'test-key-a' }, signature: 7 }],
    ];
    for (const b of bad) {
      expect(() => checkRun(b as Record<string, unknown>[], keys)).not.toThrow();
      expect(checkRun(b as Record<string, unknown>[], keys).ok).toBe(false);
    }
    expect(() => checkRun(receipts('valid'), { 'test-key-a': { kty: 'nope' } })).not.toThrow();
    expect(checkRun(receipts('valid'), { 'test-key-a': { kty: 'nope' } }).ok).toBe(false);
  });

  it('treats an empty run as trivially intact', () => {
    expect(checkRun([], keys)).toMatchObject({ ok: true, receiptsChecked: 0 });
  });

  it('is exported from the package entry point', () => {
    expect(index.checkRun).toBe(checkRun);
  });
});

describe('provenant-verify run', () => {
  let dir: string;
  const path = (name: string) => join(dir, name);

  beforeAll(() => {
    // The committed fixtures are chunk-encoded; materialize real stored-form
    // files for the CLI, which reads exactly what an operator would hand it.
    dir = mkdtempSync(join(tmpdir(), 'provenant-run-'));
    for (const n of ['valid', 'tampered', 'missing-record', 'duplicate-attempt']) {
      writeFileSync(path(`${n}.json`), JSON.stringify(receipts(n)));
    }
    writeFileSync(path('keys.json'), JSON.stringify(keys));
    writeFileSync(path('not-an-array.json'), '{"receipts": []}');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function cli(argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const io: VerifyIO = { out: (s) => out.push(s), err: (s) => err.push(s) };
    const code = runVerify(argv, io);
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('exits 0 on a valid run and says so', () => {
    const r = cli(['run', path('valid.json'), '--keys', path('keys.json')]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RUN INTACT/);
  });

  it('exits non-zero on the tampered fixture', () => {
    const r = cli(['run', path('tampered.json'), '--keys', path('keys.json')]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/RUN BROKEN/);
    expect(r.out).toMatch(/seq 1 +SIGNATURE_INVALID/);
  });

  it('exits non-zero on a gap', () => {
    expect(cli(['run', path('missing-record.json'), '--keys', path('keys.json')]).code).toBe(1);
  });

  it('exits 0 on a duplicate attempt but reports it', () => {
    const r = cli(['run', path('duplicate-attempt.json'), '--keys', path('keys.json')]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/DUPLICATE ATTEMPTS \(1\)/);
    expect(r.out).toMatch(/refund\.issue/);
  });

  it('prints the report as JSON with --json', () => {
    const r = cli(['run', path('tampered.json'), '--keys', path('keys.json'), '--json']);
    expect(r.code).toBe(1);
    const report = JSON.parse(r.out);
    expect(report.ok).toBe(false);
    expect(report.brokenLinks).toHaveLength(2);
  });

  it('exits 2 and teaches the fix when an input is missing or unreadable', () => {
    expect(cli(['run', path('valid.json')])).toMatchObject({ code: 2 });
    expect(cli(['run', path('valid.json')]).err).toMatch(/--keys/);
    expect(cli(['run', '--keys', path('keys.json')]).code).toBe(2);
    expect(cli(['run', path('nope.json'), '--keys', path('keys.json')]).code).toBe(2);
    expect(cli(['run', path('not-an-array.json'), '--keys', path('keys.json')]).code).toBe(2);
    expect(cli(['run', path('valid.json'), '--keys', path('valid.json')]).code).toBe(2);
  });

  it('rejects unknown options rather than ignoring them', () => {
    const r = cli(['run', path('valid.json'), '--keys', path('keys.json'), '--kyes']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--kyes/);
  });

  it('prints its own help', () => {
    const r = cli(['run', '--help']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/provenant-verify run RECEIPTS --keys KEYS/);
  });
});

describe('provenant-verify bundle invocation is unchanged', () => {
  function cli(argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = runVerify(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('still shows the bundle help and exit codes', () => {
    expect(cli([]).code).toBe(2);
    expect(cli([]).out).toMatch(/provenant-verify <bundle\.json> \[options\]/);
    expect(cli(['--help']).code).toBe(0);
  });

  it('still verifies a bundle file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provenant-bundle-'));
    try {
      const file = join(dir, 'bundle.json');
      writeFileSync(file, JSON.stringify({
        format: 'provenant-bundle-v1', chain_id: 'c1', generated_at: '2026-10-16T00:00:00.000Z',
        range: { from_seq: 0, to_seq: 0 }, receipts: [], agents: {}, anchors: [],
      }));
      const r = cli([file, '--json']);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toMatchObject({ ok: true, anchored: false });
      expect(cli([join(dir, 'missing.json')]).code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

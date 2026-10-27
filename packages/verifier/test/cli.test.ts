import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runVerify, type VerifyIO } from '../src/cli.js';

/**
 * The exit code is the CI contract, so bundle mode is driven end to end
 * through runVerify against the committed sample bundle -- a real anchored
 * bundle -- with no network and nothing from core or cloud.
 */
const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '../../../examples/sample-evidence/evidence.json');

function cli(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: VerifyIO = { out: (s) => out.push(s), err: (s) => err.push(s) };
  const code = runVerify(argv, io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const dir = mkdtempSync(join(tmpdir(), 'provenant-cli-'));
const path = (n: string) => join(dir, n);

beforeAll(() => {
  const bundle = JSON.parse(readFileSync(SAMPLE, 'utf8')) as { receipts: { canonical_json: string }[] };
  const before = bundle.receipts[1]!.canonical_json;
  bundle.receipts[1]!.canonical_json = before.replace('"amount_usd":50', '"amount_usd":5000');
  expect(bundle.receipts[1]!.canonical_json).not.toBe(before);
  writeFileSync(path('tampered.json'), JSON.stringify(bundle));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('lacre-verify bundle mode: existing behavior', () => {
  it('exits 0 on the valid sample bundle', () => {
    const r = cli([SAMPLE]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/VERIFIED \/ ANCHORED/);
    expect(r.err).toBe('');
  });

  it('exits 0 with a JSON verdict under --json', () => {
    const r = cli([SAMPLE, '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, anchored: true });
  });

  it('applies a well-formed --trust-fingerprint and --backdate-tolerance-ms', () => {
    const untrusted = JSON.parse(cli([SAMPLE, '--json']).out) as {
      anchors: { timestamp: { trusted: boolean; chain: { top: { fingerprint_sha256: string } } } }[];
    };
    expect(untrusted.anchors[0]!.timestamp.trusted).toBe(false);
    const fp = untrusted.anchors[0]!.timestamp.chain.top.fingerprint_sha256;

    const r = cli(['--trust-fingerprint', fp, '--backdate-tolerance-ms', '0', SAMPLE, '--json']);
    expect(r.code).toBe(0);
    const v = JSON.parse(r.out) as typeof untrusted;
    expect(v.anchors[0]!.timestamp.trusted).toBe(true);
  });

  it('exits 1 on a copy with one canonical_json value edited', () => {
    const r = cli([path('tampered.json')]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/VERIFICATION FAILED/);
    expect(r.out).toMatch(/HASH_MISMATCH/);
    expect(JSON.parse(cli([path('tampered.json'), '--json']).out)).toMatchObject({ ok: false });
  });

  it('exits 2 on an unreadable path', () => {
    const r = cli([path('missing.json')]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/could not read/);
    expect(r.out).toBe('');
  });

  it('exits 0 on --help and 2 with no arguments, describing every exit code', () => {
    const help = cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/0 verified\s+1 verification failed\s+2 bundle unreadable or bad arguments/);
    const none = cli([]);
    expect(none.code).toBe(2);
    expect(none.out).toMatch(/lacre-verify <bundle\.json> \[options\]/);
  });
});

describe('lacre-verify bundle mode: usage errors exit 2 without a verdict', () => {
  const cases: { name: string; argv: string[]; names: RegExp }[] = [
    { name: 'an unknown option', argv: [SAMPLE, '--trusted', 'x.pem'], names: /unknown option '--trusted'.*--trust,/ },
    { name: '--trust with no value', argv: [SAMPLE, '--trust'], names: /--trust needs a value/ },
    { name: '--trust followed by another option', argv: ['--trust', '--trust-fingerprint', 'x', SAMPLE], names: /--trust needs a value/ },
    { name: '--trust-fingerprint with no value', argv: [SAMPLE, '--trust-fingerprint'], names: /--trust-fingerprint needs a value/ },
    { name: '--backdate-tolerance-ms with no value', argv: [SAMPLE, '--backdate-tolerance-ms'], names: /--backdate-tolerance-ms needs a value/ },
    { name: 'a non-numeric tolerance', argv: [SAMPLE, '--backdate-tolerance-ms', 'abc'], names: /--backdate-tolerance-ms must be a non-negative integer.*'abc'/ },
    { name: 'a negative tolerance', argv: [SAMPLE, '--backdate-tolerance-ms', '-5'], names: /--backdate-tolerance-ms must be a non-negative integer.*'-5'/ },
    { name: 'a fractional tolerance', argv: [SAMPLE, '--backdate-tolerance-ms', '1.5'], names: /--backdate-tolerance-ms must be a non-negative integer/ },
    { name: 'two bundle paths', argv: [SAMPLE, path('tampered.json')], names: /unexpected argument .*tampered\.json.*exactly one bundle file/ },
  ];

  for (const c of cases) {
    it(`rejects ${c.name}`, () => {
      const r = cli(c.argv);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(c.names);
      expect(r.err.split('\n')).toHaveLength(1);
      expect(r.out).toBe('');
    });

    it(`rejects ${c.name} with a USAGE object under --json`, () => {
      const argv = c.argv.includes('--json') ? c.argv : [...c.argv, '--json'];
      const r = cli(argv);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(c.names);
      const body = JSON.parse(r.out) as { ok: boolean; error: { code: string; message: string } };
      expect(body).toEqual({ ok: false, error: { code: 'USAGE', message: expect.stringMatching(c.names) } });
      expect(body).not.toHaveProperty('anchors');
    });
  }

  it('reports a missing bundle file as a USAGE error under --json', () => {
    const r = cli(['--json']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/no bundle file given/);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: 'USAGE' } });
  });
});

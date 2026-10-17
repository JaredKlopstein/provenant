import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runVerify } from '../packages/verifier/src/cli.js';

/**
 * The copy-paste commands in the docs are a new reader's first contact with
 * Provenant. Neither package is on npm yet, so an `npx @provenant/...` line that
 * does not say so fails on the first command, and a `node packages/.../bin/*.mjs`
 * path that has moved fails just as hard. These tests pin both.
 */

const ROOT = new URL('../', import.meta.url).pathname;

const DOCS = [
  'README.md',
  'packages/core/README.md',
  'packages/verifier/README.md',
  'examples/sample-evidence/README.md',
  'docs/getting-started.md',
];

const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** How many lines either side of an npx line the "needs publishing" note may sit. */
const NOTE_WINDOW = 8;
const NPX_LINE = /^\s*npx @provenant\//;
const PUBLISHED_NOTE = /once the packages? (is|are) published/i;
const BIN_PATH = /\bnode\s+(packages\/[\w.-]+\/bin\/[\w.-]+\.mjs)/g;

/** 1-based line numbers of npx lines with no publishing note nearby. */
function unnotedNpxLines(text: string): number[] {
  const lines = text.split('\n');
  const bad: number[] = [];
  lines.forEach((line, i) => {
    if (!NPX_LINE.test(line)) return;
    const near = lines.slice(Math.max(0, i - NOTE_WINDOW), i + NOTE_WINDOW + 1).join('\n');
    if (!PUBLISHED_NOTE.test(near)) bad.push(i + 1);
  });
  return bad;
}

function binPaths(text: string): string[] {
  return [...text.matchAll(BIN_PATH)].map((m) => m[1]!);
}

describe('the checks themselves', () => {
  it('flag an npx line with no publishing note', () => {
    expect(unnotedNpxLines('```bash\nnpx @provenant/verifier evidence.json\n```')).toEqual([2]);
  });

  it('accept an npx line with the note nearby', () => {
    const text = '```bash\nnpx @provenant/verifier evidence.json\n```\n\nThis works once the package is published to npm.';
    expect(unnotedNpxLines(text)).toEqual([]);
  });

  it('find node bin paths, including a nonexistent one', () => {
    const paths = binPaths('node packages/verifier/bin/provenant-verify.mjs x.json\nnode packages/nope/bin/missing.mjs');
    expect(paths).toEqual(['packages/verifier/bin/provenant-verify.mjs', 'packages/nope/bin/missing.mjs']);
    expect(existsSync(join(ROOT, paths[1]!))).toBe(false);
  });
});

describe.each(DOCS)('%s', (path) => {
  const text = read(path);

  it('never tells the reader to npx an unpublished package without saying so', () => {
    expect(unnotedNpxLines(text)).toEqual([]);
  });

  it('only names bin scripts that exist in the repo', () => {
    const paths = binPaths(text);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(existsSync(join(ROOT, p)), p).toBe(true);
  });
});

describe('README.md', () => {
  it('stays byte-identical to packages/core/README.md', () => {
    expect(read('packages/core/README.md')).toBe(read('README.md'));
  });

  it('links to the getting-started guide', () => {
    expect(read('README.md')).toContain('docs/getting-started.md');
  });
});

describe('docs/getting-started.md', () => {
  const guide = read('docs/getting-started.md');

  it('builds before it runs the bin scripts, which load from dist/', () => {
    const build = guide.indexOf('pnpm run build');
    expect(build).toBeGreaterThan(-1);
    expect(build).toBeLessThan(guide.indexOf('node packages/'));
  });

  it('walks init, record and chain verify, then both verifier steps', () => {
    for (const cmd of [
      'node packages/core/bin/provenant.mjs init --json',
      'node packages/core/bin/provenant.mjs record',
      'node packages/core/bin/provenant.mjs chain verify --json',
      'node packages/verifier/bin/provenant-verify.mjs examples/sample-evidence/evidence.json',
      '--trust-fingerprint 33846b545a49c9be4903c60e01713c1bd4e4ef31ea65cd95d69e62794f30b941',
    ]) {
      expect(guide).toContain(cmd);
    }
  });
});

describe('what the guide promises about the sample bundle', () => {
  const BUNDLE = join(ROOT, 'examples/sample-evidence/evidence.json');
  const DIGICERT_ROOT_G4 = '33846b545a49c9be4903c60e01713c1bd4e4ef31ea65cd95d69e62794f30b941';

  const verify = (argv: string[]) => {
    let out = '';
    const code = runVerify(argv, { out: (s) => (out += s + '\n'), err: (s) => (out += s + '\n') });
    return { code, out };
  };

  it('exits 0 with VERIFIED / ANCHORED, untrusted until you pin the root', () => {
    const { code, out } = verify([BUNDLE]);
    expect(code).toBe(0);
    expect(out).toContain('VERIFIED / ANCHORED');
    expect(out).toContain('trusted by you: NO -- pass --trust or --trust-fingerprint');
  });

  it('reports the authority as trusted with --trust-fingerprint', () => {
    const { code, out } = verify([BUNDLE, '--trust-fingerprint', DIGICERT_ROOT_G4]);
    expect(code).toBe(0);
    expect(out).toContain('VERIFIED / ANCHORED');
    expect(out).toContain('trusted by you: yes');
  });
});

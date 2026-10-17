import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The copy-paste commands in the docs are a reader's first contact with the
 * product. Neither package is on npm yet, so an `npx @provenant/...` line that
 * does not say so fails on the first command, and a `node packages/.../bin/...`
 * path that does not exist fails just as fast. These tests keep both out.
 */

const ROOT = new URL('../', import.meta.url).pathname;

const DOCS = [
  'README.md',
  'packages/core/README.md',
  'packages/verifier/README.md',
  'examples/sample-evidence/README.md',
  'docs/getting-started.md',
];

/** The note that has to sit near any npx line: it only works once published. */
const PUBLISHED_NOTE = /\bonce\b[^\n]*\bpublished\b/i;
/** How many lines either side of an npx line the note may sit. */
const NOTE_WINDOW = 6;

/** 1-based numbers of lines that start with `npx @provenant/` and have no note nearby. */
function unnotedNpxLines(markdown: string): number[] {
  const lines = markdown.split('\n');
  const found: number[] = [];
  lines.forEach((line, i) => {
    if (!line.trimStart().startsWith('npx @provenant/')) return;
    const nearby = lines.slice(Math.max(0, i - NOTE_WINDOW), i + NOTE_WINDOW + 1);
    if (!nearby.some((l) => PUBLISHED_NOTE.test(l))) found.push(i + 1);
  });
  return found;
}

/** Every `node packages/<pkg>/bin/<name>.mjs` path the markdown tells the reader to run. */
function binPaths(markdown: string): string[] {
  return [...markdown.matchAll(/\bnode\s+(packages\/[^\s`'"]+\/bin\/[^\s`'"]+\.mjs)/g)].map((m) => m[1]!);
}

const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('docs commands', () => {
  for (const doc of DOCS) {
    describe(doc, () => {
      const markdown = read(doc);

      it('never tells the reader to npx an unpublished package without saying so', () => {
        expect(unnotedNpxLines(markdown)).toEqual([]);
      });

      it('only names bin paths that exist in the repo', () => {
        const missing = binPaths(markdown).filter((p) => !existsSync(join(ROOT, p)));
        expect(missing).toEqual([]);
      });
    });
  }

  it('the getting-started guide runs both CLIs from source', () => {
    const paths = binPaths(read('docs/getting-started.md'));
    expect(paths).toContain('packages/core/bin/provenant.mjs');
    expect(paths).toContain('packages/verifier/bin/provenant-verify.mjs');
  });

  it('README.md and packages/core/README.md stay byte-identical', () => {
    expect(readFileSync(join(ROOT, 'packages/core/README.md'))).toEqual(readFileSync(join(ROOT, 'README.md')));
  });
});

describe('the checks themselves', () => {
  it('flag an npx line with no published note nearby', () => {
    const md = ['```bash', 'npx @provenant/verifier evidence.json', '```'].join('\n');
    expect(unnotedNpxLines(md)).toEqual([2]);
  });

  it('flag an indented npx line too', () => {
    expect(unnotedNpxLines('    npx @provenant/verifier evidence.json')).toEqual([1]);
  });

  it('accept an npx line with the note nearby', () => {
    const md = [
      '```bash',
      'npx @provenant/verifier evidence.json',
      '```',
      '',
      'This works once the package is published to npm.',
    ].join('\n');
    expect(unnotedNpxLines(md)).toEqual([]);
  });

  it('do not accept a note that is too far away', () => {
    const md = [
      'npx @provenant/verifier evidence.json',
      ...Array.from({ length: NOTE_WINDOW }, () => ''),
      'This works once the package is published to npm.',
    ].join('\n');
    expect(unnotedNpxLines(md)).toEqual([1]);
  });

  it('find bin paths, including one split across a line break', () => {
    const md = 'Run `node packages/verifier/bin/provenant-verify.mjs x.json` or `node\npackages/core/bin/provenant.mjs init`.';
    expect(binPaths(md)).toEqual(['packages/verifier/bin/provenant-verify.mjs', 'packages/core/bin/provenant.mjs']);
  });

  it('report a bin path that does not exist', () => {
    const missing = binPaths('node packages/verifier/bin/no-such-cli.mjs evidence.json').filter(
      (p) => !existsSync(join(ROOT, p)),
    );
    expect(missing).toEqual(['packages/verifier/bin/no-such-cli.mjs']);
  });
});

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The copy-paste commands in the docs are a reader's first contact with the
 * product. Neither package is on npm yet, so an `npx @lacre/...` line that
 * does not say so fails on the first command, and a `node packages/.../bin/...`
 * path that does not exist fails just as fast. These tests keep both out.
 *
 * The Pages landing page is HTML, not markdown. Tags are stripped before the
 * scan so a command inside `<pre>` or `<code>` is judged the same way as one
 * inside a markdown fence.
 */

const ROOT = new URL('../', import.meta.url).pathname;

const DOCS = [
  'README.md',
  'packages/core/README.md',
  'packages/verifier/README.md',
  'examples/sample-evidence/README.md',
  'docs/getting-started.md',
  'docs/index.html',
];

/** The note that has to sit near any npx line: it only works once published. */
const PUBLISHED_NOTE = /\bonce\b[^\n]*\bpublished\b/i;
/** How many lines either side of an npx line the note may sit. */
const NOTE_WINDOW = 6;

/**
 * Drop HTML tags without joining lines. A tag that spans lines is left alone
 * rather than eating the newline and shifting the line numbers the test reports.
 */
function stripTags(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/<[^>\n]*>/g, ''))
    .join('\n');
}

/** 1-based numbers of lines that start with `npx @lacre/` and have no note nearby. */
function unnotedNpxLines(markdown: string): number[] {
  const lines = stripTags(markdown).split('\n');
  const found: number[] = [];
  lines.forEach((line, i) => {
    if (!line.trimStart().startsWith('npx @lacre/')) return;
    const nearby = lines.slice(Math.max(0, i - NOTE_WINDOW), i + NOTE_WINDOW + 1);
    if (!nearby.some((l) => PUBLISHED_NOTE.test(l))) found.push(i + 1);
  });
  return found;
}

/** Every `node packages/<pkg>/bin/<name>.mjs` path the doc tells the reader to run. */
function binPaths(markdown: string): string[] {
  return [...stripTags(markdown).matchAll(/\bnode\s+(packages\/[^\s`'"]+\/bin\/[^\s`'"]+\.mjs)/g)].map((m) => m[1]!);
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
    expect(paths).toContain('packages/core/bin/lacre.mjs');
    expect(paths).toContain('packages/verifier/bin/lacre-verify.mjs');
  });

  it('README.md and packages/core/README.md stay byte-identical', () => {
    expect(readFileSync(join(ROOT, 'packages/core/README.md'))).toEqual(readFileSync(join(ROOT, 'README.md')));
  });
});

describe('the checks themselves', () => {
  it('flag an npx line with no published note nearby', () => {
    const md = ['```bash', 'npx @lacre/verifier evidence.json', '```'].join('\n');
    expect(unnotedNpxLines(md)).toEqual([2]);
  });

  it('flag an indented npx line too', () => {
    expect(unnotedNpxLines('    npx @lacre/verifier evidence.json')).toEqual([1]);
  });

  it('flag an npx line hidden inside a pre tag', () => {
    const html = '<pre class="cmd"><span class="c"># verify</span>\nnpx @lacre/verifier evidence.json</pre>';
    expect(unnotedNpxLines(html)).toEqual([2]);
  });

  it('flag an npx line that shares its line with the pre tag', () => {
    const html = '<pre class="cmd">npx @lacre/core init</pre>';
    expect(unnotedNpxLines(html)).toEqual([1]);
  });

  it('accept an npx line in a pre block when the note is nearby', () => {
    const html = [
      '<pre class="cmd">npx @lacre/verifier evidence.json</pre>',
      '<p>This works once the package is published to npm.</p>',
    ].join('\n');
    expect(unnotedNpxLines(html)).toEqual([]);
  });

  it('find a bin path inside a pre tag', () => {
    const html = '<pre class="cmd">node packages/core/bin/lacre.mjs init</pre>';
    expect(binPaths(html)).toEqual(['packages/core/bin/lacre.mjs']);
  });

  it('accept an npx line with the note nearby', () => {
    const md = [
      '```bash',
      'npx @lacre/verifier evidence.json',
      '```',
      '',
      'This works once the package is published to npm.',
    ].join('\n');
    expect(unnotedNpxLines(md)).toEqual([]);
  });

  it('do not accept a note that is too far away', () => {
    const md = [
      'npx @lacre/verifier evidence.json',
      ...Array.from({ length: NOTE_WINDOW }, () => ''),
      'This works once the package is published to npm.',
    ].join('\n');
    expect(unnotedNpxLines(md)).toEqual([1]);
  });

  it('find bin paths, including one split across a line break', () => {
    const md = 'Run `node packages/verifier/bin/lacre-verify.mjs x.json` or `node\npackages/core/bin/lacre.mjs init`.';
    expect(binPaths(md)).toEqual(['packages/verifier/bin/lacre-verify.mjs', 'packages/core/bin/lacre.mjs']);
  });

  it('report a bin path that does not exist', () => {
    const missing = binPaths('node packages/verifier/bin/no-such-cli.mjs evidence.json').filter(
      (p) => !existsSync(join(ROOT, p)),
    );
    expect(missing).toEqual(['packages/verifier/bin/no-such-cli.mjs']);
  });
});

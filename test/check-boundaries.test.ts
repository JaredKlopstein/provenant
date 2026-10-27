import { spawnSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The open-core scan is the product's credibility check. These cases plant a
 * violating file, run the same script CI runs, and remove the file. They lock
 * the scope the workspace packages publish under.
 */

const ROOT = new URL('..', import.meta.url).pathname;
const SCRIPT = join(ROOT, 'scripts/check-boundaries.mjs');

const planted: string[] = [];

function runChecker(): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
}

function plant(rel: string, source: string): void {
  const full = join(ROOT, rel);
  writeFileSync(full, source, { flag: 'wx' });
  planted.push(full);
}

afterEach(() => {
  for (const full of planted) unlinkSync(full);
  planted.length = 0;
});

describe('open-core boundary under @lacre/*', () => {
  it('accepts the tree as checked in', () => {
    const result = runChecker();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('core !-> cloud');
    expect(result.stdout).toContain('verifier/src !-> core|cloud');
  });

  it('rejects a core import of @lacre/cloud', () => {
    plant('packages/core/src/boundary-scope-probe.ts', "import '@lacre/cloud';\n");
    const result = runChecker();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("packages/core/src/boundary-scope-probe.ts");
    expect(result.stderr).toContain("'core' must not reference '@lacre/cloud'");
  });

  it('rejects a verifier import of @lacre/core', () => {
    plant('packages/verifier/src/boundary-scope-probe.ts', "import { canonicalize } from '@lacre/core';\n");
    const result = runChecker();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("packages/verifier/src/boundary-scope-probe.ts");
    expect(result.stderr).toContain("'verifier' must not reference '@lacre/core'");
  });

  it('rejects a core reference that splits @lacre/ across string literals', () => {
    plant('packages/core/src/boundary-scope-probe.ts', "const name = '@lacre/' + 'cloud';\n");
    const result = runChecker();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must not reference the '@lacre/' scope");
  });
});

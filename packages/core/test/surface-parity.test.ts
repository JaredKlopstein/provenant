import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionNames } from '../src/registry/registry.js';
import '../src/index.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../bin/provenant.mjs');

/**
 * Design law 2 says a test must fail the build if the surfaces expose different
 * action sets. The original test compared `allActions()` to `buildManifest()` --
 * both built from the SAME in-process registry map, which is near-tautological.
 * It could not see adapter drift, and real drift existed: the shipped binary
 * exposed 6 actions while this suite asserted 8 and passed, because
 * adapters/cli.ts imported three action modules and index.ts imported four.
 *
 * This test SPAWNS THE ACTUAL BINARY, so it compares the library's registry to
 * what a user really gets. That is the only comparison that means anything.
 */
describe('the shipped binary exposes the same actions as the library', () => {
  const store = mkdtempSync(join(tmpdir(), 'provenant-parity-'));

  function runBin(args: string[]): unknown {
    const out = execFileSync('node', [BIN, ...args, '--store', store], { encoding: 'utf8' });
    return JSON.parse(out);
  }

  it('discover from the binary lists exactly the library action set', () => {
    const manifest = runBin(['discover']) as { actions: Array<{ name: string }> };
    const fromBinary = manifest.actions.map((a) => a.name).sort();
    expect(fromBinary).toEqual([...actionNames()].sort());
  });

  it('every action the binary advertises is actually invokable', () => {
    const manifest = runBin(['discover']) as { actions: Array<{ name: string }> };
    for (const { name } of manifest.actions) {
      // --help exercises command resolution without side effects.
      // Help renders the space form ("agent list"), so match on that.
      const out = execFileSync('node', [BIN, ...name.split('.'), '--help'], { encoding: 'utf8' });
      expect(out, `${name} advertised but not reachable from the CLI`).toContain(
        `provenant ${name.replace('.', ' ')}`,
      );
    }
  });

  it('includes the anchor commands, which the OSS build must ship', () => {
    // The noop anchor backend is MIT core. If these are missing from the free
    // binary, the "same code path in both builds" claim is false.
    const manifest = runBin(['discover']) as { actions: Array<{ name: string }> };
    const names = manifest.actions.map((a) => a.name);
    expect(names).toContain('anchor.now');
    expect(names).toContain('anchor.list');
  });

  afterAll(() => rmSync(store, { recursive: true, force: true }));
});

import { afterAll } from 'vitest';

/**
 * Design law 4 promises every `fix` block is ready to execute. A fix naming an
 * action that does not exist costs an agent a wasted turn discovering a dead
 * end -- which is exactly what design law 4 exists to prevent.
 */
describe('every error fix points at a real action', () => {
  it('has no fix.action outside the registry', async () => {
    const { ProvenantError } = await import('../src/errors.js');
    const { readdirSync, readFileSync, statSync } = await import('node:fs');

    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../src');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(srcDir);

    const valid = new Set([...actionNames(), 'discover']);
    const offenders: string[] = [];

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      // Scope strictly to `fix: { ... action: '...' }`. A bare `action:` match
      // would also hit domain action names inside `arguments` (refund.issue,
      // email.send), which are receipt subjects, not registry actions.
      for (const block of src.matchAll(/fix:\s*\{([\s\S]{0,600}?)\n\s*\},/g)) {
        const m = /(?:^|\n)\s*action:\s*'([^']+)'/.exec(block[1]!);
        if (!m) continue;
        const name = m[1]!;
        if (!valid.has(name)) offenders.push(`${file}: fix.action='${name}'`);
      }
    }

    expect(offenders, `fix.action referencing nonexistent actions:\n${offenders.join('\n')}`).toEqual([]);
    expect(ProvenantError).toBeTruthy();
  });
});

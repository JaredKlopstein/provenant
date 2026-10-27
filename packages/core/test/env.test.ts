import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/adapters/cli.js';
import { dbPath, resolveStoreDir } from '../src/config.js';
import { readLacreEnv, type LacreEnvName } from '../src/env.js';

/**
 * Tests for the one-release PROVENANT_* fallback. These files, and
 * packages/core/src/env.ts, are the only places that name those variables.
 */

const PAIRS: Array<[LacreEnvName, string]> = [
  ['LACRE_HOME', 'PROVENANT_HOME'],
  ['LACRE_BILLING_MODE', 'PROVENANT_BILLING_MODE'],
  ['LACRE_TSA_URL', 'PROVENANT_TSA_URL'],
  ['LACRE_SESSION_ID', 'PROVENANT_SESSION_ID'],
];

function layout(): { root: string; cwd: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'lacre-store-'));
  const cwd = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(cwd);
  mkdirSync(home);
  return { root, cwd, home };
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function cli(args: string[], store?: string): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runCli(store ? [...args, '--store', store] : args, {
    out: (t) => { out += t + '\n'; },
    err: (t) => { err += t + '\n'; },
  });
  return { code, out, err };
}

function parsed(out: string): { result: Record<string, unknown> } {
  return JSON.parse(out) as { result: Record<string, unknown> };
}

async function withProcessHome(home: string, cwd: string, fn: () => Promise<void>): Promise<void> {
  const saved = {
    home: process.env.HOME,
    lacre: process.env.LACRE_HOME,
    provenant: process.env.PROVENANT_HOME,
    cwd: process.cwd(),
  };
  process.env.HOME = home;
  delete process.env.LACRE_HOME;
  delete process.env.PROVENANT_HOME;
  process.chdir(cwd);
  try {
    await fn();
  } finally {
    process.chdir(saved.cwd);
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
    if (saved.lacre === undefined) delete process.env.LACRE_HOME;
    else process.env.LACRE_HOME = saved.lacre;
    if (saved.provenant === undefined) delete process.env.PROVENANT_HOME;
    else process.env.PROVENANT_HOME = saved.provenant;
  }
}

describe('readLacreEnv', () => {
  it('reads each LACRE_* name first and falls back to the PROVENANT_* name', () => {
    for (const [name, legacy] of PAIRS) {
      const lines: string[] = [];
      const warn = (line: string) => lines.push(line);
      expect(readLacreEnv(name, { [name]: 'new', [legacy]: 'old' }, warn)).toBe('new');
      expect(readLacreEnv(name, { [legacy]: 'old' }, warn)).toBe('old');
      expect(readLacreEnv(name, { [name]: 'same', [legacy]: 'same' }, warn)).toBe('same');
      expect(readLacreEnv(name, { [name]: '', [legacy]: 'legacy' }, warn)).toBe('legacy');
      expect(readLacreEnv(name, {}, warn)).toBeUndefined();
      expect(lines).toEqual([`warning: ${name} and ${legacy} are both set and differ; using ${name}`]);
      expect(lines[0]).not.toContain('\n');
    }
  });

  it('does not consult process.env when an env object is passed', () => {
    vi.stubEnv('LACRE_SESSION_ID', 'from-process');
    vi.stubEnv('PROVENANT_SESSION_ID', 'legacy-process');
    try {
      expect(readLacreEnv('LACRE_SESSION_ID', {})).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('store resolution', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('follows --store, LACRE_HOME, PROVENANT_HOME, ./.lacre, ./.provenant, ~/.lacre, then ~/.provenant', () => {
    const { root, cwd, home } = layout();
    roots.push(root);
    const lines: string[] = [];
    const warn = (line: string) => lines.push(line);

    expect(resolveStoreDir(join(root, 'explicit'), {
      env: { LACRE_HOME: join(root, 'from-lacre'), PROVENANT_HOME: join(root, 'from-legacy') },
      cwd, home, warn,
    })).toBe(resolve(join(root, 'explicit')));
    expect(lines).toEqual([]);

    lines.length = 0;
    expect(resolveStoreDir(undefined, {
      env: { LACRE_HOME: join(root, 'from-lacre'), PROVENANT_HOME: join(root, 'from-legacy') },
      cwd, home, warn,
    })).toBe(resolve(join(root, 'from-lacre')));
    expect(lines).toEqual([
      'warning: LACRE_HOME and PROVENANT_HOME are both set and differ; using LACRE_HOME',
    ]);

    lines.length = 0;
    expect(resolveStoreDir(undefined, {
      env: { LACRE_HOME: '', PROVENANT_HOME: join(root, 'from-legacy') },
      cwd, home, warn,
    })).toBe(resolve(join(root, 'from-legacy')));
    expect(lines).toEqual([]);

    mkdirSync(join(cwd, '.lacre'));
    mkdirSync(join(cwd, '.provenant'));
    mkdirSync(join(home, '.lacre'));
    mkdirSync(join(home, '.provenant'));
    expect(resolveStoreDir(undefined, { env: {}, cwd, home })).toBe(join(cwd, '.lacre'));

    rmSync(join(cwd, '.lacre'), { recursive: true });
    expect(resolveStoreDir(undefined, { env: {}, cwd, home })).toBe(join(cwd, '.provenant'));

    rmSync(join(cwd, '.provenant'), { recursive: true });
    expect(resolveStoreDir(undefined, { env: {}, cwd, home })).toBe(join(home, '.lacre'));

    rmSync(join(home, '.lacre'), { recursive: true });
    expect(resolveStoreDir(undefined, { env: {}, cwd, home })).toBe(join(home, '.provenant'));
    expect(existsSync(join(home, '.lacre'))).toBe(false);

    rmSync(join(home, '.provenant'), { recursive: true });
    const created = resolveStoreDir(undefined, { env: {}, cwd, home });
    expect(created).toBe(join(home, '.lacre'));
    expect(existsSync(created)).toBe(false);
  });

  it('keeps provenant.db for a legacy directory and uses lacre.db for a new one', () => {
    const { root } = layout();
    roots.push(root);
    const fresh = join(root, 'fresh');
    mkdirSync(fresh);
    expect(dbPath(fresh)).toBe(join(resolve(fresh), 'lacre.db'));

    const named = join(root, '.provenant');
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      expect(dbPath(named)).toBe(join(resolve(named), 'provenant.db'));
      expect(dbPath(named)).toBe(join(resolve(named), 'provenant.db'));
      expect(existsSync(join(named, 'lacre.db'))).toBe(false);
      expect(existsSync(named)).toBe(false);

      const kept = join(root, 'kept');
      mkdirSync(kept);
      writeFileSync(join(kept, 'provenant.db'), '');
      expect(dbPath(kept)).toBe(join(resolve(kept), 'provenant.db'));
      expect(existsSync(join(kept, 'provenant.db'))).toBe(true);
      expect(existsSync(join(kept, 'lacre.db'))).toBe(false);

      const notes = stderr.filter((line) => line.startsWith('note: using legacy store '));
      expect(notes).toEqual([
        `note: using legacy store ${resolve(named)}; this fallback is for one release\n`,
        `note: using legacy store ${resolve(kept)}; this fallback is for one release\n`,
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('legacy store on the CLI', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('finds a legacy ~/.provenant store with a key and chain and verifies it with no flags', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lacre-legacy-'));
    roots.push(root);
    const home = join(root, 'home');
    const project = join(root, 'project');
    mkdirSync(home);
    mkdirSync(project);
    const legacy = join(home, '.provenant');
    mkdirSync(legacy);
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      await withProcessHome(home, project, async () => {
        expect((await cli(['init', '--json'], legacy)).code).toBe(0);
        expect((await cli(['record', '--json', '--action', 'legacy.keep'], legacy)).code).toBe(0);
        const key = sha(join(legacy, 'agent.key.json'));
        const before = new Set(readdirSync(legacy));
        expect(before.has('provenant.db')).toBe(true);
        expect(before.has('lacre.db')).toBe(false);

        const verify = await cli(['chain', 'verify', '--json']);
        expect(verify.code).toBe(0);
        expect(verify.err).toBe('');
        const result = parsed(verify.out).result as { ok: boolean; receipts_checked: number };
        expect(result.ok).toBe(true);
        expect(result.receipts_checked).toBe(1);

        const queried = await cli(['receipts', 'query', '--json', '--fields', 'action']);
        const actions = (parsed(queried.out).result as { items: Array<{ action: string }> }).items.map((i) => i.action);
        expect(actions).toEqual(['legacy.keep']);

        expect((await cli(['record', '--json', '--action', 'legacy.append'])).code).toBe(0);
        const again = await cli(['chain', 'verify', '--json']);
        expect((parsed(again.out).result as { ok: boolean; receipts_checked: number })).toMatchObject({
          ok: true,
          receipts_checked: 2,
        });

        expect(existsSync(join(home, '.lacre'))).toBe(false);
        expect(existsSync(join(project, '.lacre'))).toBe(false);
        expect(existsSync(join(legacy, 'lacre.db'))).toBe(false);
        expect(sha(join(legacy, 'agent.key.json'))).toBe(key);
        const extra = readdirSync(legacy).filter((name) => !before.has(name) && !name.startsWith('provenant.db'));
        expect(extra).toEqual([]);
        expect(readdirSync(home)).toEqual(['.provenant']);
        const notes = stderr.filter((line) => line.includes(`note: using legacy store ${legacy}`));
        expect(notes).toEqual([`note: using legacy store ${legacy}; this fallback is for one release\n`]);
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('uses LACRE_HOME when both home variables are set, and does not write the other store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lacre-both-home-'));
    roots.push(root);
    const home = join(root, 'home');
    const project = join(root, 'project');
    const lacreHome = join(root, 'from-lacre');
    const oldHome = join(root, 'from-provenant');
    mkdirSync(home);
    mkdirSync(project);
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      await withProcessHome(home, project, async () => {
        expect((await cli(['init', '--json'], lacreHome)).code).toBe(0);
        expect((await cli(['record', '--json', '--action', 'from.lacre'], lacreHome)).code).toBe(0);
        expect((await cli(['init', '--json'], oldHome)).code).toBe(0);
        expect((await cli(['record', '--json', '--action', 'from.provenant'], oldHome)).code).toBe(0);
        const untouched = readFileSync(join(oldHome, 'lacre.db'));

        process.env.LACRE_HOME = lacreHome;
        process.env.PROVENANT_HOME = oldHome;
        const verify = await cli(['chain', 'verify', '--json']);
        expect(verify.code).toBe(0);
        expect((parsed(verify.out).result as { ok: boolean; receipts_checked: number })).toMatchObject({
          ok: true,
          receipts_checked: 1,
        });
        const actions = (parsed((await cli(['receipts', 'query', '--json', '--fields', 'action'])).out).result as {
          items: Array<{ action: string }>;
        }).items.map((i) => i.action);
        expect(actions).toEqual(['from.lacre']);
        expect(readFileSync(join(oldHome, 'lacre.db')).equals(untouched)).toBe(true);
        const warnings = stderr.filter((line) => line.startsWith('warning:'));
        expect(warnings.length).toBeGreaterThan(0);
        expect(new Set(warnings)).toEqual(new Set([
          'warning: LACRE_HOME and PROVENANT_HOME are both set and differ; using LACRE_HOME\n',
        ]));
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('still opens the store named only by PROVENANT_HOME', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lacre-old-home-'));
    roots.push(root);
    const home = join(root, 'home');
    const project = join(root, 'project');
    const oldHome = join(root, 'from-provenant');
    mkdirSync(home);
    mkdirSync(project);
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      await withProcessHome(home, project, async () => {
        expect((await cli(['init', '--json'], oldHome)).code).toBe(0);
        expect((await cli(['record', '--json', '--action', 'from.provenant'], oldHome)).code).toBe(0);
        process.env.PROVENANT_HOME = oldHome;
        const verify = await cli(['chain', 'verify', '--json']);
        expect((parsed(verify.out).result as { ok: boolean; receipts_checked: number })).toMatchObject({
          ok: true,
          receipts_checked: 1,
        });
        expect(stderr.filter((line) => line.startsWith('warning:'))).toEqual([]);
        expect(existsSync(join(home, '.lacre'))).toBe(false);
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('creates ~/.lacre and lacre.db when nothing legacy exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lacre-new-home-'));
    roots.push(root);
    const home = join(root, 'home');
    const project = join(root, 'project');
    mkdirSync(home);
    mkdirSync(project);
    await withProcessHome(home, project, async () => {
      const init = await cli(['init', '--json']);
      expect(init.code).toBe(0);
      expect(parsed(init.out).result.store).toBe(join(home, '.lacre'));
      expect(existsSync(join(home, '.lacre', 'lacre.db'))).toBe(true);
      expect(existsSync(join(home, '.lacre', 'provenant.db'))).toBe(false);
      expect(existsSync(join(home, '.provenant'))).toBe(false);
      expect((await cli(['record', '--json', '--action', 'new.store'])).code).toBe(0);
      const verify = await cli(['chain', 'verify', '--json']);
      expect((parsed(verify.out).result as { ok: boolean }).ok).toBe(true);
    });
  });

  it('takes LACRE_SESSION_ID over PROVENANT_SESSION_ID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lacre-session-'));
    roots.push(root);
    const store = join(root, 'store');
    const saved = {
      lacre: process.env.LACRE_SESSION_ID,
      provenant: process.env.PROVENANT_SESSION_ID,
    };
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    process.env.LACRE_SESSION_ID = '11111111-1111-4111-8111-111111111111';
    process.env.PROVENANT_SESSION_ID = '22222222-2222-4222-8222-222222222222';
    try {
      expect((await cli(['init', '--json'], store)).code).toBe(0);
      expect((await cli(['record', '--json', '--action', 'session.keep'], store)).code).toBe(0);
      const items = (parsed((await cli(['receipts', 'query', '--json', '--fields', 'session_id'], store)).out).result as {
        items: Array<{ session_id: string }>;
      }).items;
      expect(items[0]?.session_id).toBe('11111111-1111-4111-8111-111111111111');
      expect(stderr).toContain(
        'warning: LACRE_SESSION_ID and PROVENANT_SESSION_ID are both set and differ; using LACRE_SESSION_ID\n',
      );
    } finally {
      spy.mockRestore();
      if (saved.lacre === undefined) delete process.env.LACRE_SESSION_ID;
      else process.env.LACRE_SESSION_ID = saved.lacre;
      if (saved.provenant === undefined) delete process.env.PROVENANT_SESSION_ID;
      else process.env.PROVENANT_SESSION_ID = saved.provenant;
    }
  });

  it('documents the store default in --store help', async () => {
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('--store <dir>   Store location (default: $LACRE_HOME, ./.lacre, or ~/.lacre)');
    expect(help.out).not.toContain('PROVENANT_');
  });
});

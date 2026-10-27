import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { readLacreEnv } from './env.js';

/**
 * Where Lacre keeps its state.
 *
 * Resolution order, most specific first:
 *   1. explicit --store / storeDir argument
 *   2. LACRE_HOME (then the legacy home variable; the fallback is for one release)
 *   3. ./.lacre if that directory exists
 *   4. ./.provenant if that directory exists
 *   5. ~/.lacre if that directory exists
 *   6. ~/.provenant if that directory exists
 *   7. otherwise ~/.lacre, created on first use
 *
 * A legacy directory keeps its database. This module never moves, copies, or
 * deletes one. Project-local-if-present matters for agents: a coding agent
 * working in a repo should write to that repo's store without being told, the
 * way git does.
 */
export interface ResolveStoreOptions {
  /** Defaults to process.env. Passed through as the only env object. */
  env?: Record<string, string | undefined>;
  /** Defaults to process.cwd(). */
  cwd?: string;
  /** Defaults to the user's home directory. */
  home?: string;
  /** Receives the one-line env conflict warning. Defaults to stderr. */
  warn?: (line: string) => void;
}

export function resolveStoreDir(explicit?: string, opts: ResolveStoreOptions = {}): string {
  if (explicit) return resolve(explicit);

  const fromEnv = readLacreEnv('LACRE_HOME', opts.env ?? process.env, opts.warn);
  if (fromEnv) return resolve(fromEnv);

  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  for (const dir of [join(cwd, '.lacre'), join(cwd, '.provenant'), join(home, '.lacre'), join(home, '.provenant')]) {
    if (isDirectory(dir)) return dir;
  }
  return join(home, '.lacre');
}

const LEGACY_DB = 'provenant.db';
const DB = 'lacre.db';
const notedLegacyStores = new Set<string>();

/**
 * Database file for a store. New stores use lacre.db. A legacy directory
 * (named .provenant, or already containing provenant.db) keeps that file.
 * The first use of a legacy store in this process prints one stderr line.
 * Nothing is moved, copied, or deleted.
 */
export function dbPath(storeDir: string): string {
  const dir = resolve(storeDir);
  const legacyFile = join(dir, LEGACY_DB);
  if (basename(dir) === '.provenant' || existsSync(legacyFile)) {
    noteLegacyStore(dir);
    return legacyFile;
  }
  return join(dir, DB);
}

function noteLegacyStore(dir: string): void {
  if (notedLegacyStores.has(dir)) return;
  notedLegacyStores.add(dir);
  process.stderr.write(`note: using legacy store ${dir}; this fallback is for one release\n`);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function keyPath(storeDir: string): string {
  return join(storeDir, 'agent.key.json');
}

export function configPath(storeDir: string): string {
  return join(storeDir, 'config.json');
}

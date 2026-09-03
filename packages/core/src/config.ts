import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Where Provenant keeps its state.
 *
 * Resolution order, most specific first:
 *   1. explicit --store / storeDir argument
 *   2. PROVENANT_HOME environment variable
 *   3. ./.provenant if it exists (project-local, like .git)
 *   4. ~/.provenant
 *
 * Project-local-if-present matters for agents: a coding agent working in a repo
 * should write to that repo's store without being told, the way git does.
 */
export function resolveStoreDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.PROVENANT_HOME) return resolve(process.env.PROVENANT_HOME);
  return join(homedir(), '.provenant');
}

export function dbPath(storeDir: string): string {
  return join(storeDir, 'provenant.db');
}

export function keyPath(storeDir: string): string {
  return join(storeDir, 'agent.key.json');
}

export function configPath(storeDir: string): string {
  return join(storeDir, 'config.json');
}

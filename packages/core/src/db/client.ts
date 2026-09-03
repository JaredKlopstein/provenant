import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

/** drizzle exposes the underlying better-sqlite3 handle as `$client`; the hot
 *  path and the integrity tests use it for prepared statements and IMMEDIATE
 *  transactions that the query builder does not expose. */
export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

  const sqlite = new Database(file);

  // WAL: concurrent readers (the human read path, verification sweeps) never
  // block the agent write path. The write path is what we optimize for.
  if (file !== ':memory:') sqlite.pragma('journal_mode = WAL');
  // A receipt that is acknowledged but not durable is a lie. FULL, not NORMAL.
  sqlite.pragma('synchronous = FULL');
  sqlite.pragma('foreign_keys = ON');
  // Fail fast rather than hanging an agent's write.
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}

export function closeDb(db: Db): void {
  db.$client.close();
}

export { schema };

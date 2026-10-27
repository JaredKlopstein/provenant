/**
 * Renamed environment variables.
 *
 * Read the LACRE_* name first, then the PROVENANT_* name. The PROVENANT_*
 * fallback is for one release. Remove it in a later change; do not add new
 * call sites that read PROVENANT_* themselves.
 *
 * An empty value is unset, matching the shells and hosts that export a name
 * with no value. If both names are set and differ, the LACRE_* value wins and
 * one line is written to stderr naming both.
 */
const LEGACY_ENV = {
  LACRE_HOME: 'PROVENANT_HOME',
  LACRE_BILLING_MODE: 'PROVENANT_BILLING_MODE',
  LACRE_TSA_URL: 'PROVENANT_TSA_URL',
  LACRE_SESSION_ID: 'PROVENANT_SESSION_ID',
} as const;

export type LacreEnvName = keyof typeof LEGACY_ENV;

function present(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function defaultWarn(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * The value of a Lacre environment variable, with the one-release fallback
 * described above. `env` is the only object consulted; callers that pass a
 * map do not inherit process.env.
 */
export function readLacreEnv(
  name: LacreEnvName,
  env: Record<string, string | undefined> = process.env,
  warn: (line: string) => void = defaultWarn,
): string | undefined {
  const legacy = LEGACY_ENV[name];
  const next = present(env[name]);
  const prev = present(env[legacy]);
  if (next !== undefined && prev !== undefined && next !== prev) {
    warn(`warning: ${name} and ${legacy} are both set and differ; using ${name}`);
  }
  return next ?? prev;
}

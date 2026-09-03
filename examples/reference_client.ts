/**
 * Provenant reference client -- TypeScript. ~40 lines of actual logic.
 *
 * Wraps the CLI rather than reimplementing the protocol, deliberately: the CLI
 * is the reference surface, it already emits structured JSON and structured
 * errors, and shelling out means this client can never drift from the format.
 *
 * Run:  npx tsx examples/reference_client.ts
 */
import { execFileSync } from 'node:child_process';

const BIN = new URL('../packages/core/bin/provenant.mjs', import.meta.url).pathname;

export interface ProvenantError {
  code: string;
  message: string;
  retryable: boolean;
  fix?: { action?: string; arguments?: Record<string, unknown>; note: string };
}

function call(command: string, args: Record<string, unknown> = {}): any {
  const argv = [BIN, ...command.split(' '), '--json'];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === false) continue;
    argv.push(`--${key.replace(/_/g, '-')}`);
    if (value !== true) argv.push(typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  try {
    return JSON.parse(execFileSync('node', argv, { encoding: 'utf8' })).result;
  } catch (err: any) {
    // Every Provenant error carries a `fix` telling you exactly what to do next.
    const parsed = JSON.parse(err.stdout || err.stderr || '{}')?.error as ProvenantError | undefined;
    if (parsed) throw Object.assign(new Error(parsed.message), parsed);
    throw err;
  }
}

export const provenant = {
  init: (displayName: string) => call('init', { display_name: displayName }),
  record: (action: string, detail: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
    call('record', { action, action_detail: detail, ...opts }),
  verify: () => call('chain verify'),
  head: () => call('chain head'),
};

// --- demo ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const me = provenant.init('reference-client-ts');
  console.log('agent:', me.agent_id);

  const receipt = provenant.record(
    'refund.issue',
    { customer_id: 'c_8812', amount_usd: 42.5 },
    { side_effect_class: 'irreversible', idempotency_key: 'refund-c_8812-0001' },
  );
  console.log('receipt seq:', receipt.seq, 'hash:', receipt.self_hash.slice(0, 16));

  console.log('chain ok:', provenant.verify().ok);
}

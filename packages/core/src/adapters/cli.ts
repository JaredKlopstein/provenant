/**
 * Design law 1: the CLI is the reference surface, not a wrapper over one.
 * Benchmarks consistently show CLI beating MCP on reliability and token cost for
 * developer-shaped workflows -- sometimes by an order of magnitude on tokens.
 * MCP and HTTP will be generated from the same registry as adapters.
 *
 * Every command here is generated from the action registry, so a new action gets
 * a CLI command, --help, --json and --dry-run for free, and the surfaces cannot
 * drift apart.
 */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { allActions, getAction } from '../registry/registry.js';
import type { ActionContext, ActionDef, NextAction } from '../registry/types.js';
import { buildManifest } from '../registry/discover.js';
import { openDb, closeDb } from '../db/client.js';
import { resolveStoreDir, dbPath } from '../config.js';
import { loadKeypair } from '../actions/identity.js';
import { ProvenantError, toProvenantError } from '../errors.js';
import type { Keypair } from '../crypto/keys.js';

import '../actions/identity.js';
import '../actions/record.js';
import '../actions/chain.js';

/** `chain.verify` is reachable as both `chain verify` and `chain.verify`. */
function commandAliases(name: string): string[] {
  return name.includes('.') ? [name, name.replace('.', ' ')] : [name];
}

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

function parseArgv(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    let key: string;
    let value: string | boolean;

    if (eq !== -1) {
      key = body.slice(0, eq);
      value = body.slice(eq + 1);
    } else {
      key = body;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i++;
      } else {
        value = true;
      }
    }

    key = key.replace(/-/g, '_');
    const existing = flags[key];
    if (existing === undefined) flags[key] = value;
    else if (Array.isArray(existing)) existing.push(String(value));
    else flags[key] = [String(existing), String(value)];
  }

  return { positional, flags };
}

/**
 * Coerce CLI strings into the shapes the Zod schema expects. The CLI is the
 * reference surface, so it has to accept what a shell can actually produce:
 * JSON for objects, comma lists for arrays, bare strings for numbers.
 */
function coerceToSchema(
  flags: Record<string, string | boolean | string[]>,
  schema: z.ZodType,
): Record<string, unknown> {
  const shape = getObjectShape(schema);
  const out: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(flags)) {
    if (RESERVED_FLAGS.has(key)) continue;
    const field = shape?.[key];
    out[key] = field ? coerceValue(raw, field) : raw;
  }
  return out;
}

const RESERVED_FLAGS = new Set(['json', 'dry_run', 'store', 'help', 'quiet']);

function getObjectShape(schema: z.ZodType): Record<string, z.ZodType> | null {
  const def = (schema as unknown as { def?: { type?: string; shape?: Record<string, z.ZodType> } }).def;
  if (def?.type === 'object' && def.shape) return def.shape;
  return null;
}

function unwrap(schema: z.ZodType): z.ZodType {
  let cur = schema;
  for (let i = 0; i < 10; i++) {
    const def = (cur as unknown as { def?: { type?: string; innerType?: z.ZodType } }).def;
    if (def && (def.type === 'optional' || def.type === 'default' || def.type === 'nullable') && def.innerType) {
      cur = def.innerType;
    } else break;
  }
  return cur;
}

function coerceValue(raw: string | boolean | string[], field: z.ZodType): unknown {
  const inner = unwrap(field);
  const type = (inner as unknown as { def?: { type?: string } }).def?.type;

  if (type === 'boolean') return raw === true || raw === 'true';
  if (typeof raw === 'boolean') return raw;

  if (type === 'number') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (type === 'array') {
    if (Array.isArray(raw)) return raw;
    const s = String(raw).trim();
    if (s.startsWith('[')) return JSON.parse(s);
    return s.split(',').map((p) => p.trim()).filter(Boolean);
  }
  if (type === 'record' || type === 'object') {
    return JSON.parse(String(raw));
  }
  // z.unknown() for --input/--output: accept JSON, fall back to the raw string.
  if (type === 'unknown' || type === 'any') {
    const s = String(raw);
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  return raw;
}

// ---------------------------------------------------------------- help

function renderActionHelp(action: ActionDef<never, never>): string {
  const d = action.description;
  const shape = getObjectShape(action.input as z.ZodType) ?? {};
  const lines: string[] = [];

  lines.push(`provenant ${action.name.replace('.', ' ')} -- ${action.summary}`);
  lines.push('');
  lines.push(`WHAT      ${wrap(d.what)}`);
  lines.push(`WHEN      ${wrap(d.when)}`);
  lines.push(`WHEN NOT  ${wrap(d.whenNot)}`);
  lines.push(`COST      ${wrap(d.cost)}`);
  lines.push(`RETURNS   ${wrap(d.returns)}`);
  lines.push('');
  lines.push(`SIDE EFFECT CLASS: ${action.sideEffect}${action.dryRun ? '  (supports --dry-run)' : ''}`);
  lines.push('');
  lines.push('OPTIONS');
  for (const [name, field] of Object.entries(shape)) {
    const desc = (field as unknown as { description?: string }).description ?? '';
    const optional = isOptional(field);
    lines.push(`  --${name.replace(/_/g, '-')}${optional ? '' : '  (required)'}`);
    if (desc) lines.push(`      ${wrap(desc, 6)}`);
  }
  lines.push('  --json          Emit machine-readable JSON (recommended for agents)');
  if (action.dryRun) lines.push('  --dry-run       Show the exact effect, apply nothing');
  lines.push('  --store <dir>   Override the store location');

  if (action.examples?.length) {
    lines.push('');
    lines.push('EXAMPLES');
    for (const ex of action.examples) {
      lines.push(`  # ${ex.description}`);
      lines.push(`  ${renderExample(action.name, ex.arguments)}`);
    }
  }
  return lines.join('\n');
}

function renderExample(name: string, args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([k, v]) => {
    const flag = `--${k.replace(/_/g, '-')}`;
    if (typeof v === 'boolean') return v ? flag : '';
    if (typeof v === 'object') return `${flag} '${JSON.stringify(v)}'`;
    return `${flag} ${JSON.stringify(String(v))}`;
  });
  return `provenant ${name.replace('.', ' ')} ${parts.filter(Boolean).join(' ')}`;
}

function isOptional(field: z.ZodType): boolean {
  const type = (field as unknown as { def?: { type?: string } }).def?.type;
  return type === 'optional' || type === 'default' || type === 'nullable';
}

function wrap(text: string, indent = 10): string {
  const width = 78 - indent;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else line += ' ' + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n' + ' '.repeat(indent));
}

function renderRootHelp(): string {
  const lines: string[] = [];
  lines.push('provenant -- tamper-evident receipts for autonomous agents');
  lines.push('');
  lines.push('USAGE');
  lines.push('  provenant <command> [options] [--json]');
  lines.push('');
  lines.push('COMMANDS');
  const width = Math.max(...allActions().map((a) => a.name.length)) + 2;
  for (const a of allActions()) {
    lines.push(`  ${a.name.replace('.', ' ').padEnd(width)} ${a.summary}`);
  }
  lines.push(`  ${'discover'.padEnd(width)} Full machine-readable manifest of this service`);
  lines.push('');
  lines.push('GLOBAL OPTIONS');
  lines.push('  --json          Machine-readable output. Every command supports it.');
  lines.push('  --dry-run       On mutations: show the exact effect, apply nothing.');
  lines.push('  --store <dir>   Store location (default: $PROVENANT_HOME or ~/.provenant)');
  lines.push('  --help          This help, or per-command help.');
  lines.push('');
  lines.push('START HERE');
  lines.push('  provenant init --json');
  lines.push('  provenant discover --json     # full schemas, errors, quickstart');
  lines.push('');
  lines.push('Agents: `provenant discover --json` returns everything needed to operate');
  lines.push('this service, including input/output JSON Schemas and a literal quickstart.');
  return lines.join('\n');
}

// ---------------------------------------------------------------- run

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

const defaultIO: CliIO = {
  out: (t) => process.stdout.write(t + '\n'),
  err: (t) => process.stderr.write(t + '\n'),
};

export function runCli(argv: string[], io: CliIO = defaultIO): number {
  const { positional, flags } = parseArgv(argv);
  const json = flags.json === true || flags.json === 'true';

  const emitError = (err: unknown): number => {
    const pe = toProvenantError(err);
    if (json) io.err(JSON.stringify(pe.toJSON(), null, 2));
    else {
      io.err(`error [${pe.code}]: ${pe.message}`);
      if (pe.fix) {
        io.err(`  fix: ${pe.fix.note}`);
        if (pe.fix.action) {
          io.err(`  next: provenant ${pe.fix.action.replace('.', ' ')} ${
            pe.fix.arguments ? JSON.stringify(pe.fix.arguments) : ''
          }`);
        }
      }
      io.err(`  retryable: ${pe.retryable}`);
    }
    return 1;
  };

  // Resolve the command by longest alias first, so `chain verify` wins over `chain`.
  let matched: ActionDef<never, never> | undefined;
  let consumed = 0;
  const two = positional.slice(0, 2).join(' ');
  const one = positional[0];

  for (const action of allActions()) {
    for (const alias of commandAliases(action.name)) {
      if (alias === two && alias.includes(' ')) {
        matched = action;
        consumed = 2;
      } else if (!matched && alias === one) {
        matched = action;
        consumed = 1;
      }
    }
  }

  const rest = positional.slice(consumed);

  if (!matched) {
    if (one === 'discover') {
      io.out(JSON.stringify(buildManifest(), null, 2));
      return 0;
    }
    if (!one || one === 'help' || flags.help) {
      io.out(json ? JSON.stringify(buildManifest(), null, 2) : renderRootHelp());
      return 0;
    }
    return emitError(
      new ProvenantError({
        code: 'INVALID_INPUT',
        message: `Unknown command '${positional.join(' ')}'. Nothing was executed.`,
        retryable: false,
        fix: {
          action: 'discover',
          arguments: {},
          note: `Run 'provenant discover --json' for the full action list with schemas. Available: ${allActions()
            .map((a) => a.name)
            .join(', ')}.`,
        },
      }),
    );
  }

  if (flags.help === true) {
    io.out(json ? JSON.stringify(describeAction(matched), null, 2) : renderActionHelp(matched));
    return 0;
  }

  const storeDir = resolveStoreDir(typeof flags.store === 'string' ? flags.store : undefined);
  const db = openDb(dbPath(storeDir));

  try {
    let cached: Keypair | null = null;
    const ctx: ActionContext = {
      db,
      storeDir,
      sessionId: process.env.PROVENANT_SESSION_ID ?? randomUUID(),
      identity: () => (cached ??= loadKeypair(storeDir)),
    };

    const rawInput = coerceToSchema(flags, matched.input as z.ZodType);
    // Allow `provenant record refund.issue` as shorthand for --action.
    if (rest[0] && matched.name === 'record' && rawInput.action === undefined) {
      rawInput.action = rest[0];
    }

    const parsed = (matched.input as z.ZodType).safeParse(rawInput);
    if (!parsed.success) {
      return emitError(
        new ProvenantError({
          code: 'INVALID_INPUT',
          message: `Arguments for '${matched.name}' failed validation: ${parsed.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; ')}. Nothing was executed.`,
          retryable: false,
          details: { issues: parsed.error.issues as unknown as Record<string, unknown>[] },
          fix: {
            action: matched.name,
            note: `Run 'provenant ${matched.name.replace('.', ' ')} --help' for every option, or 'provenant discover --json' for the full input schema.`,
          },
        }),
      );
    }

    const wantDryRun = flags.dry_run === true || flags.dry_run === 'true';
    if (wantDryRun && !matched.dryRun) {
      return emitError(
        new ProvenantError({
          code: 'INVALID_INPUT',
          message: `'${matched.name}' is a ${matched.sideEffect} action and has no dry-run. Nothing was executed.`,
          retryable: false,
          fix: { action: matched.name, note: 'Read actions have no effect to preview; call it directly.' },
        }),
      );
    }

    const input = parsed.data as never;
    const result = wantDryRun ? matched.dryRun!(input, ctx) : matched.handler(input, ctx);

    const nextActions: NextAction[] = matched.nextActions
      ? matched.nextActions(input, result, ctx)
      : [];

    if (json) {
      io.out(
        JSON.stringify(
          { ok: true, action: matched.name, result, next_actions: nextActions },
          null,
          2,
        ),
      );
    } else {
      io.out(renderHuman(matched.name, result, nextActions, wantDryRun));
    }
    return 0;
  } catch (err) {
    return emitError(err);
  } finally {
    closeDb(db);
  }
}

function describeAction(a: ActionDef<never, never>): Record<string, unknown> {
  const m = buildManifest().actions as Array<Record<string, unknown>>;
  return m.find((x) => x.name === a.name) ?? {};
}

function renderHuman(
  name: string,
  result: unknown,
  next: NextAction[],
  dryRun: boolean,
): string {
  const lines: string[] = [];
  if (dryRun) lines.push('DRY RUN -- nothing was written.');
  lines.push(JSON.stringify(result, null, 2));
  if (next.length) {
    lines.push('');
    lines.push('next:');
    for (const n of next) lines.push(`  ${n.action} -- ${n.why}`);
  }
  return lines.join('\n');
}

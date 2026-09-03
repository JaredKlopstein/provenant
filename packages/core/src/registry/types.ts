import type { z } from 'zod';
import type { Db } from '../db/client.js';
import type { Keypair } from '../crypto/keys.js';
import type { SideEffectClass } from '../receipt/schema.js';

/**
 * Design law 3: tool and command descriptions are load-bearing, not
 * documentation. Research across 856 MCP tools found 97.1% had at least one
 * description quality defect and 56% failed to state their purpose clearly --
 * and fixing descriptions alone measurably raised agent task success.
 *
 * So a description is not a string here. It is a STRUCTURED type with five
 * required fields, which makes an incomplete description a compile error rather
 * than something a reviewer has to notice. registry.test.ts additionally
 * enforces that none of them are stubs.
 */
export interface ActionDescription {
  /** What it does. One or two plain sentences. */
  what: string;
  /** When an agent SHOULD reach for this. Name the situation concretely. */
  when: string;
  /** When it should NOT -- the wrong-tool case, and what to use instead. */
  whenNot: string;
  /** What it costs: latency, money, irreversibility, context window. */
  cost: string;
  /** What comes back, including the shape of the useful fields. */
  returns: string;
}

export interface ActionContext {
  db: Db;
  storeDir: string;
  /** Loads the local keypair on demand; throws NO_KEYPAIR with a fix if absent. */
  identity(): Keypair;
  /** The session this process's receipts belong to. */
  sessionId: string;
}

/**
 * Design law 5: every success states what is legal next -- as fully-formed,
 * ready-to-execute calls with ids already filled in, not endpoint names.
 */
export interface NextAction {
  action: string;
  arguments: Record<string, unknown>;
  why: string;
}

export interface ActionDef<I = unknown, O = unknown> {
  /** Dotted, stable, and identical across CLI, HTTP and MCP. */
  name: string;
  /** One line, imperative. Used as the CLI subcommand summary. */
  summary: string;
  description: ActionDescription;
  /**
   * Side-effect class. `read` actions are safe to retry and safe to call
   * speculatively; `irreversible` ones must never be replayed blindly.
   */
  sideEffect: SideEffectClass;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  handler(input: I, ctx: ActionContext): O;
  /**
   * Design law 7: dry-run on every mutation. Returns the exact effect --
   * including the receipt that WOULD be written -- while applying nothing.
   * Required for every non-read action; the registry test enforces it.
   */
  dryRun?(input: I, ctx: ActionContext): O;
  /** Ready-to-execute follow-ups, computed from the actual result. */
  nextActions?(input: I, output: O, ctx: ActionContext): NextAction[];
  /** Literal examples used in --help and the discovery manifest. */
  examples?: Array<{ description: string; arguments: Record<string, unknown> }>;
}

/** Envelope returned by every successful action, on every surface. */
export interface ActionResult<O = unknown> {
  ok: true;
  action: string;
  result: O;
  next_actions: NextAction[];
}

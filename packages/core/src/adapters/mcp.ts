/**
 * MCP client wrapper: one chained receipt per tools/call.
 *
 * MCP has no built-in tool-call receipt, so this sits at the client's
 * `callTool` seam and records each call with `appendReceipt`. The client is
 * typed structurally -- anything with `callTool({ name, arguments })` -- so
 * core takes no runtime dependency on the MCP SDK.
 *
 * Arguments are redacted by default: the receipt carries `input_hash` over
 * them, and the plain values only when `storeArgs` is true. What the resulting
 * receipt does and does not prove is set out in docs/adr/0004-tool-call-receipts.md.
 */
import type { Db } from '../db/client.js';
import { appendReceipt } from '../chain/append.js';
import type { Outcome, SideEffectClass, TrustLevel } from '../receipt/schema.js';

export interface McpCallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

/** The only part of an MCP client this wrapper touches. */
export interface McpToolClient {
  callTool(params: McpCallToolParams): Promise<unknown>;
}

export interface WrapMcpClientOptions {
  db: Db;
  agent: {
    agentId: string;
    agentVersion: string;
    trustLevel: TrustLevel;
    keyId: string;
    secretKey: Uint8Array;
  };
  sessionId: string;
  runId: string;
  turnId?: string;
  attemptId?: string;
  /**
   * One class for every tool, or a map of tool name to class. Any tool without
   * one is `write`: an MCP tool's effect is unknown, so it is not assumed safe.
   */
  sideEffectClass?: SideEffectClass | Record<string, SideEffectClass>;
  /** Store plain arguments in `action_detail`. Off by default; only the hash is kept. */
  storeArgs?: boolean;
}

const DEFAULT_SIDE_EFFECT_CLASS: SideEffectClass = 'write';

function sideEffectFor(opt: WrapMcpClientOptions['sideEffectClass'], tool: string): SideEffectClass {
  if (opt === undefined) return DEFAULT_SIDE_EFFECT_CLASS;
  if (typeof opt === 'string') return opt;
  // Own keys only, so a tool named e.g. "constructor" cannot pick up a prototype member.
  return Object.hasOwn(opt, tool) ? opt[tool]! : DEFAULT_SIDE_EFFECT_CLASS;
}

/** MCP reports tool-level errors in-band as `{ isError: true }`, not by throwing. */
function isErrorResult(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { isError?: unknown }).isError === true;
}

/**
 * Wrap an MCP client so every `callTool` appends a signed, chained receipt.
 *
 * The returned object is the same client with `callTool` replaced; every other
 * member is forwarded to the original. A call that throws still writes a
 * `failure` receipt, then re-throws the original error unchanged.
 */
export function wrapMcpClient<T extends McpToolClient>(client: T, opts: WrapMcpClientOptions): T {
  const record = (params: McpCallToolParams, outcome: Outcome, output: unknown): void => {
    appendReceipt(opts.db, {
      ...opts.agent,
      action: `mcp.${params.name}`,
      actionType: 'tool_call',
      actionDetail: {
        tool: params.name,
        ...(opts.storeArgs === true && params.arguments !== undefined ? { arguments: params.arguments } : {}),
      },
      sideEffectClass: sideEffectFor(opts.sideEffectClass, params.name),
      outcome,
      sessionId: opts.sessionId,
      input: params.arguments,
      output,
      issuerKind: 'sdk',
      provenanceClass: 'observed',
      runId: opts.runId,
      turnId: opts.turnId,
      attemptId: opts.attemptId,
    });
  };

  const callTool = async (params: McpCallToolParams, ...rest: unknown[]): Promise<unknown> => {
    let result: unknown;
    try {
      result = await (client.callTool as (...a: unknown[]) => Promise<unknown>).call(client, params, ...rest);
    } catch (err) {
      // No output_hash: there was no result, and the error text is not ours to store.
      record(params, 'failure', undefined);
      throw err;
    }
    record(params, isErrorResult(result) ? 'failure' : 'success', result);
    return result;
  };

  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'callTool') return callTool;
      const value: unknown = Reflect.get(target, prop, target);
      // Bind to the real client so methods relying on private state keep working.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

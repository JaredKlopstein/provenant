/**
 * Design law 4: every error teaches its own fix.
 *
 * The audience for these messages is an agent with a limited context window that
 * cannot read documentation mid-task. An error must therefore carry, in the
 * payload itself: what went wrong, whether retrying could possibly help, whether
 * the action executed, and the exact next call to make. "Invalid input" costs an
 * agent an entire exploratory loop; a `fix` block costs it one call.
 */

export const ERROR_CODES = {
  /** Input failed schema validation. Never executed. */
  INVALID_INPUT: 'INVALID_INPUT',
  /** An option was supplied that the action does not define. Never executed --
   *  ignoring it could silently change what is recorded or returned. */
  UNKNOWN_ARGUMENT: 'UNKNOWN_ARGUMENT',
  /** No agent registered under that id. Never executed. */
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  /** Agent id is registered to a DIFFERENT key than the one presented. */
  AGENT_KEY_MISMATCH: 'AGENT_KEY_MISMATCH',
  /** That agent id is already registered. */
  AGENT_EXISTS: 'AGENT_EXISTS',
  /** A keypair already exists and would be replaced. Nothing was written. */
  KEY_EXISTS: 'KEY_EXISTS',
  /** No keypair in the store. Never executed. */
  NO_KEYPAIR: 'NO_KEYPAIR',
  /** Store is not initialized. Never executed. */
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  /** Concurrent append took our sequence number. Nothing was written. */
  CHAIN_CONFLICT: 'CHAIN_CONFLICT',
  /** The chain failed integrity verification. */
  CHAIN_BROKEN: 'CHAIN_BROKEN',
  /** An existing anchor commits this position to a DIFFERENT head. The history
   *  changed underneath an attestation. Nothing was written. */
  ANCHOR_CONTRADICTION: 'ANCHOR_CONTRADICTION',
  /** Same idempotency key, different arguments. Nothing was written. */
  IDEMPOTENCY_MISMATCH: 'IDEMPOTENCY_MISMATCH',
  /** Requested a paid capability from the open-source build. */
  REQUIRES_CLOUD: 'REQUIRES_CLOUD',
  /** A cursor could not be decoded. */
  INVALID_CURSOR: 'INVALID_CURSOR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ErrorFix {
  /** The action to call next, by registry name. */
  action?: string;
  /** Fully-formed arguments -- ready to execute, not a template. */
  arguments?: Record<string, unknown>;
  /** Plain-language guidance, including whether the action executed. */
  note: string;
}

export interface ProvenantErrorPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  fix?: ErrorFix;
  details?: Record<string, unknown>;
}

export class ProvenantError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly fix?: ErrorFix;
  readonly details?: Record<string, unknown>;

  constructor(payload: ProvenantErrorPayload) {
    super(payload.message);
    this.name = 'ProvenantError';
    this.code = payload.code;
    this.retryable = payload.retryable;
    this.fix = payload.fix;
    this.details = payload.details;
  }

  /** The wire shape. Identical across CLI --json, HTTP and MCP. */
  toJSON(): { error: ProvenantErrorPayload } {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.fix ? { fix: this.fix } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

/** Wrap an unknown throw so no surface ever emits an untyped error. */
export function toProvenantError(err: unknown): ProvenantError {
  if (err instanceof ProvenantError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ProvenantError({
    code: 'INVALID_INPUT',
    message,
    retryable: false,
    fix: {
      note:
        'This was not a recognised Provenant error. The action did NOT complete. ' +
        'Re-check the argument schema with: provenant discover --json',
    },
  });
}

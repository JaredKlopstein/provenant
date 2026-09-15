/**
 * Design law 6: token-budgeted by default. Assume every byte returned costs the
 * caller context window.
 *
 * The cursor is an opaque base64url of {seq}. Opaque because callers must not
 * build cursors themselves -- that would freeze the pagination strategy into
 * every client. Seq-based rather than offset-based because the chain is
 * append-only, so a seq cursor is stable under concurrent writes; an OFFSET
 * would silently skip or repeat rows.
 */
import { ProvenantError } from './errors.js';

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 500;

export function encodeCursor(seq: number): string {
  return Buffer.from(JSON.stringify({ seq }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { seq: number };
    // A chain seq is a non-negative safe integer; anything else is a malformed cursor.
    if (typeof parsed.seq !== 'number' || !Number.isSafeInteger(parsed.seq) || parsed.seq < 0) {
      throw new Error('bad seq');
    }
    return parsed.seq;
  } catch {
    throw new ProvenantError({
      code: 'INVALID_CURSOR',
      message: `Cursor '${cursor.slice(0, 24)}' could not be decoded. Cursors are opaque and must be passed back verbatim from a previous response. Nothing was returned.`,
      retryable: false,
      fix: {
        action: 'receipts.query',
        arguments: { limit: DEFAULT_LIMIT },
        note: 'Restart the listing without a cursor, then page using the exact next_cursor value returned.',
      },
    });
  }
}

/** Project an object down to a field allowlist. Unknown fields are ignored
 *  rather than erroring: a caller asking for a field we do not have should get
 *  a smaller result, not a failed call. */
export function project<T extends Record<string, unknown>>(row: T, fields?: string[]): Partial<T> {
  if (!fields || fields.length === 0) return row;
  const out: Record<string, unknown> = {};
  // Own properties only: `in` would also match inherited names such as
  // `constructor` or `toString` and copy Object.prototype into the result.
  for (const f of fields) if (Object.hasOwn(row, f)) out[f] = row[f];
  return out as Partial<T>;
}

export interface Page<T> {
  items: T[];
  /** Present only when more rows exist. */
  next_cursor?: string;
  /** Explicit, so a caller never has to infer completeness from item count. */
  truncated: boolean;
}

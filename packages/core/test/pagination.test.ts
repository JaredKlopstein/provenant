import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor, project, DEFAULT_LIMIT } from '../src/pagination.js';
import { ProvenantError } from '../src/errors.js';

function expectInvalidCursor(cursor: string): void {
  let caught: unknown;
  try {
    decodeCursor(cursor);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ProvenantError);
  const err = caught as ProvenantError;
  expect(err.code).toBe('INVALID_CURSOR');
  expect(err.retryable).toBe(false);
  // The error must teach its own fix: restart the listing without a cursor.
  expect(err.fix).toEqual({
    action: 'receipts.query',
    arguments: { limit: DEFAULT_LIMIT },
    note: 'Restart the listing without a cursor, then page using the exact next_cursor value returned.',
  });
}

function rawCursor(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64url');
}

describe('pagination cursors', () => {
  it('round-trips a seq through encode/decode', () => {
    expect(decodeCursor(encodeCursor(0))).toBe(0);
    expect(decodeCursor(encodeCursor(42))).toBe(42);
    expect(decodeCursor(encodeCursor(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('produces a base64url cursor with no padding or URL-unsafe characters', () => {
    const cursor = encodeCursor(12345);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects a cursor that has been tampered with', () => {
    const cursor = encodeCursor(42);
    // Flip a character in the middle so the payload is no longer valid JSON.
    const tampered = cursor.slice(0, 3) + (cursor[3] === 'A' ? 'B' : 'A') + cursor.slice(4);
    expectInvalidCursor(tampered);
    expectInvalidCursor(cursor + 'x');
  });

  it('rejects a negative seq', () => {
    expectInvalidCursor(encodeCursor(-1));
    expectInvalidCursor(rawCursor('{"seq":-0.5}'));
  });

  it('rejects a seq above Number.MAX_SAFE_INTEGER', () => {
    expectInvalidCursor(encodeCursor(Number.MAX_SAFE_INTEGER + 2));
    expectInvalidCursor(rawCursor('{"seq":9007199254740993}'));
    // JSON.parse turns 1e400 into Infinity.
    expectInvalidCursor(rawCursor('{"seq":1e400}'));
  });

  it('rejects a non-integer seq', () => {
    expectInvalidCursor(rawCursor('{"seq":1.5}'));
    expectInvalidCursor(rawCursor('{"seq":"1"}'));
    expectInvalidCursor(rawCursor('{"seq":null}'));
    expectInvalidCursor(rawCursor('{}'));
  });

  it('rejects payloads that are not JSON', () => {
    expectInvalidCursor('');
    expectInvalidCursor('not-a-cursor');
    expectInvalidCursor(rawCursor('{seq:1}'));
  });

  it('rejects JSON payloads that are not objects', () => {
    expectInvalidCursor(rawCursor('1'));
    expectInvalidCursor(rawCursor('"seq"'));
    expectInvalidCursor(rawCursor('null'));
    expectInvalidCursor(rawCursor('[1]'));
  });

  it('truncates the offending cursor in the error message', () => {
    const long = 'a'.repeat(100);
    let message = '';
    try {
      decodeCursor(long);
    } catch (e) {
      message = (e as ProvenantError).message;
    }
    expect(message).toContain(`'${'a'.repeat(24)}'`);
    expect(message).not.toContain('a'.repeat(25));
  });
});

describe('project', () => {
  const row = { a: 1, b: 'two', c: null };

  it('returns the row unchanged when no fields are requested', () => {
    expect(project(row)).toBe(row);
    expect(project(row, [])).toBe(row);
  });

  it('keeps only the requested subset', () => {
    expect(project(row, ['a', 'c'])).toEqual({ a: 1, c: null });
  });

  it('ignores unknown fields instead of erroring', () => {
    expect(project(row, ['a', 'nope'])).toEqual({ a: 1 });
    expect(project(row, ['nope'])).toEqual({});
  });

  it('does not leak inherited prototype properties', () => {
    expect(project({ a: 1 }, ['constructor'])).toEqual({});
    expect(project({ a: 1 }, ['toString'])).toEqual({});
    expect(project({ a: 1 }, ['hasOwnProperty'])).toEqual({});
    const out = project({ a: 1 }, ['__proto__']);
    expect(Object.keys(out)).toEqual([]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it('still copies an own property that shadows a prototype name', () => {
    const shadowed = { constructor: 'mine', a: 1 };
    expect(project(shadowed, ['constructor'])).toEqual({ constructor: 'mine' });
  });
});

/**
 * RFC 8785 JSON Canonicalization Scheme -- INDEPENDENT REIMPLEMENTATION.
 *
 * This deliberately duplicates packages/core/src/canonical/jcs.ts rather than
 * importing it. A verifier that shares its canonicalizer with the system it
 * audits is not independent: a bug or a deliberate backdoor in the shared code
 * would be invisible to both sides, and "verified" would mean only "consistent
 * with itself".
 *
 * The duplication is the point. test/cross-impl.test.ts asserts that this
 * implementation and core's agree byte-for-byte across a large corpus,
 * including the RFC's own vectors -- so drift is caught mechanically while
 * independence is preserved.
 *
 * Written from RFC 8785 directly:
 *   - object keys sorted by UTF-16 code unit (JS default string comparison)
 *   - numbers per ECMAScript Number::toString (what JSON.stringify implements)
 *   - strings with JSON minimal escaping
 *   - arrays never reordered
 */

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

function ser(value: unknown, depth: number): string {
  if (depth > 100) throw new CanonicalizationError('JSON nested deeper than 100 levels');
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new CanonicalizationError('NaN and Infinity have no JSON representation');
    }
    return JSON.stringify(value);
  }

  if (t === 'string') return JSON.stringify(value);

  if (t === 'undefined') {
    throw new CanonicalizationError('undefined is not JSON');
  }

  if (t === 'object') {
    if (Array.isArray(value)) {
      return '[' + value.map((v) => ser(v, depth + 1)).join(',') + ']';
    }
    const rec = value as Record<string, unknown>;
    // RFC 8785 section 3.2.3: sort by UTF-16 code unit. JavaScript's `<` on
    // strings is exactly UTF-16 code unit comparison.
    const keys = Object.keys(rec).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts: string[] = [];
    for (const k of keys) {
      parts.push(JSON.stringify(k) + ':' + ser(rec[k], depth + 1));
    }
    return '{' + parts.join(',') + '}';
  }

  throw new CanonicalizationError(`cannot canonicalize ${t}`);
}

export function canonicalize(value: unknown): string {
  return ser(value, 0);
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

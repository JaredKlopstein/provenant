/**
 * RFC 8785 -- JSON Canonicalization Scheme (JCS).
 *
 * This is the most load-bearing file in the repository. Every receipt hash is
 * taken over the output of this function. If two implementations disagree by a
 * single byte, chains produced by one will not verify under the other, and the
 * product's entire claim -- "a third party can independently verify this" --
 * evaporates. Treat changes here as protocol changes, not refactors.
 *
 * Why this is short: ECMAScript's own serialization rules already match JCS for
 * the two hard parts.
 *
 *   Numbers -- RFC 8785 section 3.2.2.3 defers to ECMAScript's Number::toString.
 *              JSON.stringify implements exactly that. Verified against the RFC
 *              section 3.2.3 vectors in test/jcs.test.ts:
 *              333333333.33333329 -> 333333333.3333333, 1e30 -> 1e+30,
 *              4.50 -> 4.5, 2e-3 -> 0.002, 1e-27 -> 1e-27, -0 -> 0.
 *
 *   Strings  -- RFC 8785 section 3.2.2.2 specifies minimal escaping identical to
 *              ECMAScript JSON.stringify (which has been well-formed since
 *              ES2019, so lone surrogates escape deterministically).
 *
 * What ECMAScript does NOT give us is key ordering: JSON.stringify emits
 * insertion order. RFC 8785 section 3.2.3 requires sorting by UTF-16 code unit.
 * JavaScript's default string comparison is UTF-16 code unit comparison, so a
 * plain `<` comparator is correct -- including the non-obvious case where an
 * astral character (U+1F600, surrogate pair D83D DE00) sorts BEFORE U+E000.
 * Under UTF-8 byte ordering that pair would be inverted. There is a test for it.
 *
 * KNOWN LIMIT (documented, not papered over): RFC 8785 scopes numbers to
 * IEEE-754 doubles, and so do we. Canonicalization itself is deterministic for
 * every finite double. The limit is on the PARSE side and is inherent to JSON in
 * JavaScript: the text `9007199254740993` parses to 9007199254740992 before any
 * code here can observe it, so the precision is already gone and no guard in
 * this file could detect it. Callers who need exact integers above 2^53 (large
 * database ids, for instance) must carry them as strings. A receipt built from
 * such a value would hash consistently but would not mean what its author
 * intended -- which is a data-modelling bug, not a canonicalization bug.
 */

export class CanonicalizationError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(path ? `${message} (at ${path || '<root>'})` : message);
    this.name = 'CanonicalizationError';
    this.path = path;
  }
}

/** RFC 8785 section 3.2.3: sort object keys by UTF-16 code unit. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number': {
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(
          `NaN and Infinity have no JSON representation; got ${String(value)}`,
          path,
        );
      }
      // JSON.stringify implements ECMAScript Number::toString, which is what
      // RFC 8785 section 3.2.2.3 mandates. Every finite double -- including
      // 1e30 and 5e-324 -- serializes deterministically. -0 becomes "0", per spec.
      return JSON.stringify(value);
    }

    case 'string':
      return JSON.stringify(value);

    case 'bigint':
      throw new CanonicalizationError(
        'bigint has no JSON representation; encode it as a string',
        path,
      );

    case 'undefined':
      // Silently dropping this would change the hash without changing the data
      // the caller believes they signed. Always an error.
      throw new CanonicalizationError('undefined is not JSON; omit the key or use null', path);

    case 'function':
    case 'symbol':
      throw new CanonicalizationError(`${typeof value} is not JSON-serializable`, path);

    case 'object': {
      if (Array.isArray(value)) {
        // Array order is data, never sorted (RFC 8785 section 3.2.3).
        const parts = value.map((el, i) => serialize(el, `${path}[${i}]`));
        return '[' + parts.join(',') + ']';
      }

      // Reject exotic objects whose JSON form is implementation-flavoured.
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalizationError(
          `only plain objects can be canonicalized; got ${value.constructor?.name ?? 'exotic object'}. ` +
            `Convert it to a plain object first (e.g. a Date to an RFC 3339 string)`,
          path,
        );
      }

      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort(byCodeUnit);
      const parts: string[] = [];
      for (const key of keys) {
        parts.push(JSON.stringify(key) + ':' + serialize(record[key], path ? `${path}.${key}` : key));
      }
      return '{' + parts.join(',') + '}';
    }

    default:
      throw new CanonicalizationError(`unsupported type ${typeof value}`, path);
  }
}

/**
 * Canonicalize a JSON value to its RFC 8785 string form.
 *
 * Deterministic across runs, machines, and key insertion orders. Throws rather
 * than guessing on any input whose canonical form would be ambiguous.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, '');
}

/** Canonical form as UTF-8 bytes -- what actually goes into SHA-256. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

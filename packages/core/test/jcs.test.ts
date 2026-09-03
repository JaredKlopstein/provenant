import { describe, it, expect } from 'vitest';
import { canonicalize, canonicalBytes, CanonicalizationError } from '../src/canonical/jcs.js';

/**
 * These are protocol conformance tests, not unit tests. A failure here means
 * chains we produce will not verify under another RFC 8785 implementation.
 */
describe('RFC 8785 JCS', () => {
  describe('the specification example (section 3.2.3)', () => {
    // Built from code points so this file stays pure ASCII and cannot be
    // corrupted by an editor normalising invisible characters.
    const HARD_STRING =
      '€$' + String.fromCharCode(0x0f) + String.fromCharCode(0x0a) + "A'B\"\\\\\"/";

    const input = {
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: HARD_STRING,
      literals: [null, true, false],
    };

    it('produces the exact canonical form from the RFC', () => {
      expect(canonicalize(input)).toBe(
        '{"literals":[null,true,false],' +
          '"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
          '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
      );
    });

    it('is stable when keys arrive in a different insertion order', () => {
      const reordered = {
        string: input.string,
        literals: input.literals,
        numbers: input.numbers,
      };
      expect(canonicalize(reordered)).toBe(canonicalize(input));
    });
  });

  describe('number serialization (section 3.2.2.3, ECMAScript Number::toString)', () => {
    const cases: Array<[number, string]> = [
      [333333333.33333329, '333333333.3333333'],
      [1e30, '1e+30'],
      [4.5, '4.5'],
      [2e-3, '0.002'],
      [1e-27, '1e-27'],
      [1e21, '1e+21'],
      [1e-7, '1e-7'],
      [0.1 + 0.2, '0.30000000000000004'],
      [5e-324, '5e-324'],
      [1.7976931348623157e308, '1.7976931348623157e+308'],
      [0, '0'],
      [-0, '0'], // JCS: negative zero canonicalizes to "0"
      [-1.5, '-1.5'],
    ];

    for (const [value, expected] of cases) {
      it(`${String(value)} -> ${expected}`, () => {
        expect(canonicalize(value)).toBe(expected);
      });
    }
  });

  describe('key ordering is UTF-16 code unit order, not UTF-8 byte order', () => {
    it('sorts an astral character before U+E000', () => {
      // The discriminating case. Under UTF-16 code units, U+1F600 is the
      // surrogate pair D83D DE00, so it sorts BEFORE U+E000. Under UTF-8 byte
      // ordering it would sort after. Getting this backwards is the classic
      // JCS interop bug.
      const out = canonicalize({ '': 1, '\u{1f600}': 2 });
      expect(out).toBe('{"\u{1f600}":2,"":1}');
      expect(out.indexOf('\u{1f600}')).toBeLessThan(out.indexOf(''));
    });

    it('orders mixed scripts and controls deterministically', () => {
      const keys = ['€', 'ڳ', String.fromCharCode(0x0a), '1', '\u{1f600}', ''];
      const obj: Record<string, number> = {};
      keys.forEach((k, i) => (obj[k] = i));

      const shuffled: Record<string, number> = {};
      [...keys].reverse().forEach((k) => (shuffled[k] = obj[k]!));

      expect(canonicalize(obj)).toBe(canonicalize(shuffled));
      // Verify the actual order: LF, '1', U+06B3, U+20AC, U+1F600, U+E000
      const order = [...canonicalize(obj).matchAll(/"((?:[^"\\]|\\.)*)":/g)].map((m) => m[1]);
      expect(order).toEqual(['\\n', '1', 'ڳ', '€', '\u{1f600}', '']);
    });

    it('sorts nested objects too', () => {
      expect(canonicalize({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
    });
  });

  describe('arrays', () => {
    it('never reorders array elements', () => {
      expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    });

    it('handles empty containers', () => {
      expect(canonicalize({ a: [], b: {} })).toBe('{"a":[],"b":{}}');
    });
  });

  describe('rejects input whose canonical form would be ambiguous', () => {
    it('throws on NaN and Infinity', () => {
      expect(() => canonicalize(NaN)).toThrow(CanonicalizationError);
      expect(() => canonicalize(Infinity)).toThrow(CanonicalizationError);
    });

    it('throws on undefined rather than dropping the key', () => {
      // Dropping would change the hash without changing what the caller thinks
      // they signed. This is the single most dangerous silent failure mode.
      expect(() => canonicalize({ a: 1, b: undefined })).toThrow(/undefined is not JSON/);
    });

    it('throws on bigint with an actionable message', () => {
      expect(() => canonicalize({ n: 1n })).toThrow(/encode it as a string/);
    });

    it('throws on Date rather than guessing a format', () => {
      expect(() => canonicalize({ at: new Date(0) })).toThrow(/only plain objects/);
    });

    it('names the path of the offending value', () => {
      expect(() => canonicalize({ a: { b: [1, undefined] } })).toThrow(/a\.b\[1\]/);
    });
  });

  describe('the 2^53 limit is on the parse side, and is documented not guarded', () => {
    it('canonicalizes every finite double deterministically', () => {
      // Large-magnitude doubles are legal and reproducible; only *exact integer*
      // fidelity above 2^53 is lost, and it is lost during JSON.parse, before
      // canonicalize() can ever see the value.
      expect(canonicalize(1e30)).toBe('1e+30');
      expect(JSON.parse('9007199254740993')).toBe(9007199254740992);
      expect(canonicalize(JSON.parse('9007199254740993'))).toBe('9007199254740992');
    });
  });

  describe('canonicalBytes', () => {
    it('is the UTF-8 encoding of the canonical string', () => {
      const v = { s: '€' };
      expect(canonicalBytes(v)).toEqual(new TextEncoder().encode(canonicalize(v)));
    });
  });
});

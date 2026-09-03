/**
 * Minimal DER (X.690 distinguished encoding rules) reader.
 *
 * Written from the specification rather than pulled from a library on purpose:
 * this package's whole value is that a skeptical reader can audit it end to end
 * with no third-party code in the trust path. A few hundred lines of explicit
 * parsing is a smaller thing to audit than a general-purpose ASN.1 library.
 *
 * It is a READER only. Nothing here constructs DER, because the verifier never
 * needs to -- and a parser that cannot emit is a parser that cannot be tricked
 * into emitting something.
 *
 * Hardening notes, because this parses adversarial input by definition:
 *   - every read is bounds-checked against the buffer end
 *   - lengths are rejected above the remaining buffer, so a lying length header
 *     cannot cause an over-read
 *   - indefinite-length encodings are rejected outright (they are not valid DER)
 *   - nesting depth is capped, so a deeply nested token cannot blow the stack
 */

export class DerError extends Error {
  constructor(message: string) {
    super(`DER parse error: ${message}`);
    this.name = 'DerError';
  }
}

export interface DerNode {
  /** Raw tag byte. */
  tag: number;
  /** Tag class: 0 universal, 1 application, 2 context, 3 private. */
  cls: number;
  constructed: boolean;
  /** Tag number with class/constructed bits stripped. */
  tagNumber: number;
  /** Content bytes, excluding tag and length. */
  content: Uint8Array;
  /** The complete TLV including tag and length -- needed when a signature is
   *  computed over an element's full encoding. */
  full: Uint8Array;
  children?: DerNode[];
}

const MAX_DEPTH = 32;

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  SEQUENCE: 0x10,
  SET: 0x11,
  PRINTABLE_STRING: 0x13,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
} as const;

export function parseDer(buf: Uint8Array, depth = 0): DerNode {
  const { node, consumed } = parseOne(buf, 0, depth);
  if (consumed !== buf.length) {
    throw new DerError(`trailing bytes: parsed ${consumed} of ${buf.length}`);
  }
  return node;
}

function parseOne(buf: Uint8Array, offset: number, depth: number): { node: DerNode; consumed: number } {
  if (depth > MAX_DEPTH) throw new DerError(`nesting deeper than ${MAX_DEPTH}`);
  if (offset >= buf.length) throw new DerError('truncated: expected tag');

  const start = offset;
  const tag = buf[offset]!;
  offset += 1;

  if ((tag & 0x1f) === 0x1f) throw new DerError('multi-byte tags are not supported');

  if (offset >= buf.length) throw new DerError('truncated: expected length');
  let length = buf[offset]!;
  offset += 1;

  if (length === 0x80) {
    // Valid BER, invalid DER. Accepting it would let two different encodings of
    // the same value both verify, which is exactly what DER exists to prevent.
    throw new DerError('indefinite length is not valid DER');
  }

  if (length & 0x80) {
    const numBytes = length & 0x7f;
    if (numBytes > 4) throw new DerError(`length field of ${numBytes} bytes is unreasonable`);
    if (offset + numBytes > buf.length) throw new DerError('truncated: length bytes');
    length = 0;
    for (let i = 0; i < numBytes; i++) length = length * 256 + buf[offset + i]!;
    offset += numBytes;
  }

  if (offset + length > buf.length) {
    throw new DerError(`length ${length} exceeds remaining ${buf.length - offset} bytes`);
  }

  const content = buf.subarray(offset, offset + length);
  const end = offset + length;
  const constructed = (tag & 0x20) !== 0;

  const node: DerNode = {
    tag,
    cls: (tag & 0xc0) >> 6,
    constructed,
    tagNumber: tag & 0x1f,
    content,
    full: buf.subarray(start, end),
  };

  if (constructed) {
    node.children = [];
    let inner = 0;
    while (inner < content.length) {
      const child = parseOne(content, inner, depth + 1);
      node.children.push(child.node);
      inner += child.consumed;
    }
  }

  return { node, consumed: end - start };
}

// ------------------------------------------------------------------ accessors

export function expectTag(node: DerNode, tagNumber: number, what: string): DerNode {
  if (node.tagNumber !== tagNumber) {
    throw new DerError(`${what}: expected tag 0x${tagNumber.toString(16)}, got 0x${node.tagNumber.toString(16)}`);
  }
  return node;
}

export function child(node: DerNode, index: number, what: string): DerNode {
  const c = node.children?.[index];
  if (!c) throw new DerError(`${what}: missing element at index ${index}`);
  return c;
}

/** Decode an OBJECT IDENTIFIER to dotted-decimal. */
export function readOid(node: DerNode): string {
  if (node.tagNumber !== TAG.OID) throw new DerError('not an OBJECT IDENTIFIER');
  const b = node.content;
  if (b.length === 0) throw new DerError('empty OID');

  const first = b[0]!;
  const parts: number[] = [Math.floor(first / 40), first % 40];
  let value = 0;
  let started = false;

  for (let i = 1; i < b.length; i++) {
    const byte = b[i]!;
    value = value * 128 + (byte & 0x7f);
    started = true;
    if ((byte & 0x80) === 0) {
      parts.push(value);
      value = 0;
      started = false;
    }
  }
  if (started) throw new DerError('OID ends mid-value');
  return parts.join('.');
}

/** Non-negative INTEGER as a JS number. Throws above 2^53 rather than losing
 *  precision silently -- serial numbers can legitimately exceed it, so callers
 *  that need those must use readIntegerBytes instead. */
export function readInteger(node: DerNode): number {
  if (node.tagNumber !== TAG.INTEGER) throw new DerError('not an INTEGER');
  const b = node.content;
  if (b.length === 0) throw new DerError('empty INTEGER');
  if (b[0]! & 0x80) throw new DerError('negative INTEGER not supported here');
  let n = 0;
  for (const byte of b) {
    n = n * 256 + byte;
    if (!Number.isSafeInteger(n)) throw new DerError('INTEGER exceeds 2^53');
  }
  return n;
}

export function readIntegerBytes(node: DerNode): Uint8Array {
  if (node.tagNumber !== TAG.INTEGER) throw new DerError('not an INTEGER');
  // Strip the leading zero DER adds to keep a value positive.
  return node.content[0] === 0 ? node.content.subarray(1) : node.content;
}

/**
 * GeneralizedTime -> RFC 3339. RFC 3161 requires the Z (UTC) form, and we
 * reject anything else rather than guessing an offset: a timestamp whose
 * timezone we had to infer is not evidence.
 */
export function readGeneralizedTime(node: DerNode): string {
  if (node.tagNumber !== TAG.GENERALIZED_TIME) throw new DerError('not a GeneralizedTime');
  const s = new TextDecoder().decode(node.content);
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z$/.exec(s);
  if (!m) throw new DerError(`GeneralizedTime '${s}' is not in the required YYYYMMDDHHMMSS[.f]Z form`);
  const [, y, mo, d, h, mi, sec, frac] = m;
  const fraction = frac ? `.${frac.slice(0, 3).padEnd(3, '0')}` : '.000';
  return `${y}-${mo}-${d}T${h}:${mi}:${sec}${fraction}Z`;
}

/** Find the first descendant carrying a given OID, used to locate attributes. */
export function findOid(node: DerNode, oid: string): DerNode | null {
  if (node.tagNumber === TAG.OID && !node.constructed) {
    try {
      if (readOid(node) === oid) return node;
    } catch {
      return null;
    }
  }
  for (const c of node.children ?? []) {
    const found = findOid(c, oid);
    if (found) return found;
  }
  return null;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // Not constant-time on purpose: these are public values (hashes in a public
  // token), and pretending otherwise would imply a secret is being compared.
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Minimal DER writer. Lives in the commercial package because only the anchor
 * CLIENT needs to construct DER (a TimeStampReq); the MIT verifier only ever
 * reads it, and a reader that cannot write is a reader that cannot be tricked
 * into writing.
 */

export function len(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, content: Uint8Array): Uint8Array {
  const l = len(content.length);
  const out = new Uint8Array(1 + l.length + content.length);
  out[0] = tag;
  out.set(l, 1);
  out.set(content, 1 + l.length);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export const seq = (...parts: Uint8Array[]) => tlv(0x30, concat(...parts));
export const set = (...parts: Uint8Array[]) => tlv(0x31, concat(...parts));
export const octetString = (b: Uint8Array) => tlv(0x04, b);
export const nullValue = () => tlv(0x05, new Uint8Array(0));
export const boolean = (v: boolean) => tlv(0x01, Uint8Array.from([v ? 0xff : 0x00]));
export const explicit = (n: number, inner: Uint8Array) => tlv(0xa0 | n, inner);

export function integer(n: number | Uint8Array): Uint8Array {
  if (n instanceof Uint8Array) {
    // Prepend a zero byte if the high bit is set, so the value stays positive.
    return tlv(0x02, n[0]! & 0x80 ? concat(Uint8Array.from([0]), n) : n);
  }
  if (n === 0) return tlv(0x02, Uint8Array.from([0]));
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return tlv(0x02, Uint8Array.from(bytes));
}

export function oid(dotted: string): Uint8Array {
  const parts = dotted.split('.').map(Number);
  if (parts.length < 2) throw new Error(`invalid OID: ${dotted}`);
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    if (part === 0) {
      bytes.push(0);
      continue;
    }
    const chunk: number[] = [];
    let v = part;
    while (v > 0) {
      chunk.unshift(v & 0x7f);
      v >>= 7;
    }
    for (let i = 0; i < chunk.length - 1; i++) chunk[i]! |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(bytes));
}

export const algorithmIdentifier = (algOid: string) => seq(oid(algOid), nullValue());

export const OID = {
  sha256: '2.16.840.1.101.3.4.2.1',
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  kpTimeStamping: '1.3.6.1.5.5.7.3.8',
  /** A policy OID under an IANA private-enterprise arc placeholder. Replace
   *  with a registered arc before this is used for anything real. */
  testPolicy: '1.3.6.1.4.1.99999.1.1',
} as const;

/**
 * RFC 3161 TimeStampReq.
 *
 * We always set certReq TRUE: without the signing certificate in the response,
 * the token cannot be verified offline, and offline verification is the entire
 * point of the bundle.
 */
export function buildTimeStampReq(sha256Digest: Uint8Array, nonce?: Uint8Array): Uint8Array {
  if (sha256Digest.length !== 32) {
    throw new Error(`expected a 32-byte SHA-256 digest, got ${sha256Digest.length}`);
  }
  return seq(
    integer(1), // version
    seq(algorithmIdentifier(OID.sha256), octetString(sha256Digest)), // messageImprint
    ...(nonce ? [integer(nonce)] : []),
    boolean(true), // certReq -- non-negotiable, see above
  );
}

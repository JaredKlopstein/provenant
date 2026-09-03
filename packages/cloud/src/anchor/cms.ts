/**
 * Construct an RFC 3161 TimeStampToken (a CMS SignedData carrying a TSTInfo).
 *
 * Used by the in-process test authority so the forgery and tamper tests can run
 * fully offline and deterministically. The production path does NOT mint tokens
 * -- it asks a real authority for one -- but the two share this file's
 * understanding of the format, so a misreading here would show up as a live
 * token failing to verify.
 *
 * The parser is tested independently against genuine tokens from freetsa,
 * DigiCert and Sectigo (packages/verifier/test/fixtures), which is what stops
 * the encoder and parser from agreeing on a shared misreading of the spec.
 */
import { createSign, createHash, X509Certificate, type KeyObject } from 'node:crypto';
import {
  seq, set, tlv, oid, integer, octetString, nullValue, explicit, concat,
  algorithmIdentifier, OID,
} from './der.js';

function generalizedTime(date: Date): Uint8Array {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const s =
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return tlv(0x18, new TextEncoder().encode(s));
}

export interface MintOptions {
  /** SHA-256 digest being timestamped. */
  imprint: Uint8Array;
  signerCertPem: string;
  signerKey: KeyObject;
  /** Certificates to embed. Include the root so the chain completes offline. */
  chainPem: string[];
  /** The time to attest. Overridable so tests can mint tokens at chosen times. */
  time?: Date;
  serial?: number;
}

/** TSTInfo ::= SEQUENCE { version, policy, messageImprint, serialNumber, genTime, ... } */
function buildTstInfo(opts: MintOptions): Uint8Array {
  return seq(
    integer(1),
    oid(OID.testPolicy),
    seq(algorithmIdentifier(OID.sha256), octetString(opts.imprint)),
    integer(opts.serial ?? 1),
    generalizedTime(opts.time ?? new Date()),
  );
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export function mintTimeStampToken(opts: MintOptions): Uint8Array {
  const tstInfo = buildTstInfo(opts);
  const contentDigest = new Uint8Array(createHash('sha256').update(Buffer.from(tstInfo)).digest());

  // signedAttrs must bind the content type and the content digest, or the
  // signature would not actually cover the TSTInfo.
  const attrs = [
    seq(oid(OID.contentType), set(oid(OID.tstInfo))),
    seq(oid(OID.messageDigest), set(octetString(contentDigest))),
  ];

  // CMS signs the attributes encoded as SET OF (0x31); they travel as [0]
  // implicit (0xA0). Sign the SET form, emit the [0] form.
  const attrsForSigning = set(...attrs);
  const attrsForMessage = tlv(0xa0, concat(...attrs));

  const signature = new Uint8Array(
    createSign('sha256').update(Buffer.from(attrsForSigning)).sign(opts.signerKey),
  );

  const cert = new X509Certificate(opts.signerCertPem);
  const issuerDer = extractIssuerDer(new Uint8Array(cert.raw));
  const serialDer = extractSerialDer(new Uint8Array(cert.raw));

  const signerInfo = seq(
    integer(1),
    seq(issuerDer, serialDer), // IssuerAndSerialNumber
    algorithmIdentifier(OID.sha256),
    attrsForMessage,
    algorithmIdentifier(OID.sha256WithRsa),
    octetString(signature),
  );

  const certsDer = opts.chainPem.map(pemToDer);
  const signedData = seq(
    integer(3),
    set(algorithmIdentifier(OID.sha256)),
    seq(oid(OID.tstInfo), explicit(0, octetString(tstInfo))),
    tlv(0xa0, concat(...certsDer)), // certificates [0] IMPLICIT
    set(signerInfo),
  );

  return seq(oid(OID.signedData), explicit(0, signedData));
}

/**
 * Pull the raw DER of issuer and serialNumber out of a certificate.
 * TBSCertificate ::= SEQUENCE { [0] version, serialNumber, signature, issuer, ... }
 * so with an explicit version tag present: index 1 is serial, index 3 is issuer.
 */
function tbsFields(certDer: Uint8Array): { serial: Uint8Array; issuer: Uint8Array } {
  const walk = (buf: Uint8Array, off: number): { start: number; end: number } => {
    let o = off + 1;
    let l = buf[o]!;
    o += 1;
    if (l & 0x80) {
      const n = l & 0x7f;
      l = 0;
      for (let i = 0; i < n; i++) l = l * 256 + buf[o + i]!;
      o += n;
    }
    return { start: off, end: o + l };
  };

  const cert = walk(certDer, 0);
  let o = cert.start + 1;
  let l = certDer[o]!;
  o++;
  if (l & 0x80) {
    const n = l & 0x7f;
    l = 0;
    for (let i = 0; i < n; i++) l = l * 256 + certDer[o + i]!;
    o += n;
  }
  // now at TBSCertificate
  const tbs = walk(certDer, o);
  let inner = tbs.start + 1;
  let il = certDer[inner]!;
  inner++;
  if (il & 0x80) {
    const n = il & 0x7f;
    il = 0;
    for (let i = 0; i < n; i++) il = il * 256 + certDer[inner + i]!;
    inner += n;
  }

  const fields: Array<{ start: number; end: number }> = [];
  let p = inner;
  while (p < tbs.end && fields.length < 6) {
    const f = walk(certDer, p);
    fields.push(f);
    p = f.end;
  }

  // [0] version is optional; when present it is field 0 with tag 0xA0.
  const hasVersion = certDer[fields[0]!.start] === 0xa0;
  const serialIdx = hasVersion ? 1 : 0;
  const issuerIdx = hasVersion ? 3 : 2;
  const s = fields[serialIdx]!;
  const i = fields[issuerIdx]!;
  return {
    serial: certDer.subarray(s.start, s.end),
    issuer: certDer.subarray(i.start, i.end),
  };
}

function extractSerialDer(certDer: Uint8Array): Uint8Array {
  return tbsFields(certDer).serial;
}
function extractIssuerDer(certDer: Uint8Array): Uint8Array {
  return tbsFields(certDer).issuer;
}

export { nullValue, seq as _seq };

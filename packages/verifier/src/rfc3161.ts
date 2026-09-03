/**
 * RFC 3161 TimeStampToken verification. Fully offline.
 *
 * This is the function the entire paid tier rests on. If it can be fooled, an
 * anchored bundle is not evidence and the business model fails. So it verifies
 * every link rather than the convenient ones:
 *
 *   1. The token really is a CMS SignedData carrying a TSTInfo.
 *   2. The TSTInfo's messageImprint equals the digest we expected -- i.e. the
 *      authority timestamped OUR chain statement and not something else.
 *   3. The signed attributes contain a message-digest attribute equal to
 *      SHA-256 of the TSTInfo, so the signature actually covers the content.
 *   4. The signature over the signed attributes verifies under the signer
 *      certificate's public key.
 *   5. The signer certificate carries the timeStamping extended key usage --
 *      without this check, ANY certificate from a trusted CA could mint
 *      timestamps, which is the classic RFC 3161 implementation hole.
 *   6. The certificate chain validates up to a self-signed root.
 *
 * Step 4 has a subtlety that is easy to get wrong and fatal when you do: CMS
 * signs the DER of the signedAttrs SET, but signedAttrs appears in the message
 * as an implicitly-tagged [0]. The signature is computed over the encoding with
 * tag 0x31 (SET OF), not 0xA0. We re-tag before verifying.
 *
 * We use node:crypto for RSA/ECDSA and X.509 rather than shipping our own
 * bignum: it is a platform builtin, not a third-party dependency, and it is not
 * a network module. Rolling our own RSA would be strictly worse for an auditor.
 */
import { createVerify, createHash, X509Certificate, type KeyObject } from 'node:crypto';
import {
  parseDer, readOid, readInteger, readGeneralizedTime, child, expectTag,
  bytesEqual, toHex, DerError, TAG, type DerNode,
} from './der.js';

const OID = {
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  extKeyUsage: '2.5.29.37',
  kpTimeStamping: '1.3.6.1.5.5.7.3.8',
} as const;

const DIGEST_BY_OID: Record<string, string> = {
  [OID.sha256]: 'sha256',
  [OID.sha384]: 'sha384',
  [OID.sha512]: 'sha512',
};

export interface CertRef {
  subject: string;
  fingerprint_sha256: string;
}

export interface ChainStatus {
  /**
   * The certificates this walk actually verified, leaf first. Trust is computed
   * from THIS list and nothing else.
   *
   * Why it exists: a token's CertificateSet is entirely attacker-controlled and
   * may carry certificates that are not in the chain at all. Deriving trust from
   * the bag rather than from the verified path let an attacker append a real
   * root as an inert decoy and be marked trusted -- see the regression test
   * "a decoy certificate in the token cannot confer trust".
   */
  verified: CertRef[];
  /** Reached a self-signed certificate. NOTE: this implies NOTHING about
   *  trust -- an attacker can embed their own self-signed root in a token.
   *  Trust is decided solely by `trusted` below. */
  complete: boolean;
  /** The highest certificate reached while walking up from the signer. For a
   *  commercial TSA this is usually an intermediate, because real tokens
   *  deliberately omit the root and expect the verifier to hold it. */
  top: CertRef | null;
  /** The self-signed root, when one was reached (in the token or the caller's
   *  trust store). */
  root: CertRef | null;
  reason: string;
}

export interface TimestampVerdict {
  /**
   * Cryptographic soundness ONLY: the signature verifies under the signer
   * certificate, the signed attributes bind the TSTInfo, the signer may issue
   * timestamps, and the timestamped digest is the one we expected.
   *
   * Deliberately does NOT include trust. "This signature is mathematically
   * valid" and "I trust the authority that made it" are different claims, and
   * a verifier that merges them is a verifier that will happily trust a root
   * the attacker put in the bundle.
   */
  ok: boolean;
  /** Every check that failed, named. Empty when ok. */
  failures: string[];
  /** The time the authority attests to, RFC 3339. Present whenever the token
   *  parsed, even if a later check failed. */
  proven_time: string | null;
  /** The digest the authority actually timestamped. */
  imprint_hex: string | null;
  /** Signer certificate subject, for display. */
  signer: string | null;
  chain: ChainStatus;
  /**
   * True only when a certificate in the chain was matched against the caller's
   * trust list. Without a trust list this is always false, and a bundle whose
   * timestamp is `ok: true, trusted: false` proves the token is internally
   * sound but not who vouches for it.
   */
  trusted: boolean;
}

export interface VerifyTimestampOptions {
  /** SHA-256 digest we expect the authority to have timestamped. */
  expectedImprint: Uint8Array;
  /** SHA-256 fingerprints (hex) of certificates the caller trusts. Matched
   *  against every certificate in the chain, so supplying either the root or a
   *  pinned intermediate works. */
  trustedFingerprints?: string[];
  /** Trust anchors as PEM/DER certificates. Used both to complete a chain the
   *  token left open (the normal case for a commercial TSA) and to establish
   *  trust. */
  trustAnchors?: X509Certificate[];
}

export function verifyTimestampToken(
  tokenDer: Uint8Array,
  opts: VerifyTimestampOptions,
): TimestampVerdict {
  const verdict: TimestampVerdict = {
    ok: false, failures: [], proven_time: null, imprint_hex: null, signer: null,
    chain: { complete: false, verified: [], top: null, root: null, reason: '' },
    trusted: false,
  };

  try {
    // --- ContentInfo { contentType, [0] EXPLICIT content } ---
    const contentInfo = expectTag(parseDer(tokenDer), TAG.SEQUENCE, 'ContentInfo');
    if (readOid(child(contentInfo, 0, 'ContentInfo.contentType')) !== OID.signedData) {
      verdict.failures.push('token is not a CMS SignedData');
      return verdict;
    }
    const signedData = expectTag(
      child(child(contentInfo, 1, 'ContentInfo.content'), 0, 'SignedData'),
      TAG.SEQUENCE, 'SignedData',
    );

    // --- encapContentInfo { eContentType, [0] EXPLICIT OCTET STRING } ---
    const encap = expectTag(child(signedData, 2, 'encapContentInfo'), TAG.SEQUENCE, 'encapContentInfo');
    if (readOid(child(encap, 0, 'eContentType')) !== OID.tstInfo) {
      verdict.failures.push('encapsulated content is not a TSTInfo');
      return verdict;
    }
    const eContent = child(child(encap, 1, 'eContent [0]'), 0, 'eContent OCTET STRING').content;

    // --- TSTInfo { version, policy, messageImprint, serial, genTime, ... } ---
    const tstInfo = expectTag(parseDer(eContent), TAG.SEQUENCE, 'TSTInfo');
    const messageImprint = expectTag(child(tstInfo, 2, 'messageImprint'), TAG.SEQUENCE, 'messageImprint');
    const imprintAlg = readOid(child(expectTag(child(messageImprint, 0, 'hashAlgorithm'), TAG.SEQUENCE, 'hashAlgorithm'), 0, 'alg oid'));
    const hashedMessage = expectTag(child(messageImprint, 1, 'hashedMessage'), TAG.OCTET_STRING, 'hashedMessage').content;

    verdict.imprint_hex = toHex(hashedMessage);
    verdict.proven_time = readGeneralizedTime(child(tstInfo, 4, 'genTime'));

    if (imprintAlg !== OID.sha256) {
      verdict.failures.push(`messageImprint uses ${imprintAlg}; only SHA-256 is accepted`);
    }
    // THE check that ties this token to our chain. Everything else could be a
    // perfectly valid timestamp -- of somebody else's data.
    if (!bytesEqual(hashedMessage, opts.expectedImprint)) {
      verdict.failures.push(
        `timestamped digest ${toHex(hashedMessage)} does not match the expected chain statement digest ${toHex(opts.expectedImprint)}`,
      );
    }

    // --- certificates [0] IMPLICIT ---
    const certs: X509Certificate[] = [];
    for (const node of signedData.children ?? []) {
      if (node.cls === 2 && node.tagNumber === 0 && node.constructed) {
        for (const certNode of node.children ?? []) {
          try {
            certs.push(new X509Certificate(Buffer.from(certNode.full)));
          } catch {
            /* not a certificate; CertificateSet may hold other choices */
          }
        }
      }
    }
    if (certs.length === 0) {
      verdict.failures.push('token carries no certificates, so the signature cannot be checked offline');
      return verdict;
    }

    // --- signerInfos SET OF SignerInfo (last element of SignedData) ---
    const signerInfos = signedData.children![signedData.children!.length - 1]!;
    const signerInfo = expectTag(child(signerInfos, 0, 'SignerInfo'), TAG.SEQUENCE, 'SignerInfo');

    let signedAttrs: DerNode | null = null;
    let digestAlgOid: string | null = null;
    let signature: Uint8Array | null = null;

    for (let i = 1; i < (signerInfo.children?.length ?? 0); i++) {
      const node = signerInfo.children![i]!;
      if (node.cls === 2 && node.tagNumber === 0 && node.constructed) signedAttrs = node;
      else if (node.tagNumber === TAG.SEQUENCE && node.cls === 0 && digestAlgOid === null) {
        try { digestAlgOid = readOid(child(node, 0, 'digestAlgorithm')); } catch { /* signatureAlgorithm */ }
      } else if (node.tagNumber === TAG.OCTET_STRING && node.cls === 0) {
        signature = node.content;
      }
    }

    if (!signedAttrs) {
      // Without signedAttrs the signature covers the content directly. RFC 3161
      // tokens in the wild always use signedAttrs; refusing the other form keeps
      // this code (and its audit surface) small and predictable.
      verdict.failures.push('SignerInfo has no signedAttrs; unsupported token form');
      return verdict;
    }
    if (!signature) {
      verdict.failures.push('SignerInfo carries no signature');
      return verdict;
    }

    const digestName = DIGEST_BY_OID[digestAlgOid ?? OID.sha256] ?? 'sha256';

    // --- signed attributes must bind the content we just read ---
    const attrs = readAttributes(signedAttrs);
    const contentTypeAttr = attrs.get(OID.contentType);
    const messageDigestAttr = attrs.get(OID.messageDigest);

    if (!contentTypeAttr || readOid(contentTypeAttr) !== OID.tstInfo) {
      verdict.failures.push('signed content-type attribute is missing or is not TSTInfo');
    }
    if (!messageDigestAttr) {
      verdict.failures.push('signed message-digest attribute is missing');
    } else {
      const expected = new Uint8Array(createHash(digestName).update(Buffer.from(eContent)).digest());
      if (!bytesEqual(messageDigestAttr.content, expected)) {
        // Without this, an attacker could keep a genuine signature and swap the
        // TSTInfo underneath it.
        verdict.failures.push('signed message-digest does not match the TSTInfo content');
      }
    }

    // --- the signature itself ---
    // CMS signs signedAttrs encoded as SET OF (0x31), not as the [0] implicit
    // tag (0xA0) it appears under. Re-tag before verifying.
    const toVerify = Buffer.from(signedAttrs.full);
    toVerify[0] = 0x31;

    const signerCert = findSignerCert(certs, signerInfo);
    if (!signerCert) {
      verdict.failures.push('the certificate matching this SignerInfo is not in the token');
      return verdict;
    }
    verdict.signer = signerCert.subject.replace(/\n/g, ', ');

    const sigOk = createVerify(digestName)
      .update(toVerify)
      .verify(signerCert.publicKey as KeyObject, Buffer.from(signature));
    if (!sigOk) verdict.failures.push('the timestamp signature does not verify under the signer certificate');

    // --- the signer must be allowed to issue timestamps ---
    if (!hasTimeStampingEku(signerCert)) {
      verdict.failures.push(
        'signer certificate lacks the timeStamping extended key usage (1.3.6.1.5.5.7.3.8)',
      );
    }

    // --- certificate validity at the attested time ---
    // A timestamp signed by a certificate that was not yet valid, or had already
    // expired, at the moment it claims to attest is not evidence of anything.
    if (verdict.proven_time) {
      const t = Date.parse(verdict.proven_time);
      if (t < Date.parse(signerCert.validFrom) || t > Date.parse(signerCert.validTo)) {
        verdict.failures.push(
          `attested time ${verdict.proven_time} falls outside the signer certificate's validity window (${signerCert.validFrom} to ${signerCert.validTo})`,
        );
      }
    }

    // --- chain, reported separately from cryptographic soundness ---
    verdict.chain = buildChain(signerCert, certs, opts.trustAnchors ?? []);

    // Trust is decided ONLY by the caller's list, and ONLY against certificates
    // this verification actually walked and checked.
    //
    // The subtle part, and a bug that shipped once: a token's CertificateSet is
    // attacker-controlled and may contain certificates that are not in the chain
    // at all. Matching the caller's pins against that bag let an attacker append
    // a genuine well-known root as an inert decoy -- never used to verify
    // anything -- and be reported as trusted. Only chain.verified is eligible.
    const wanted = (opts.trustedFingerprints ?? []).map((f) => f.replace(/:/g, '').toLowerCase());
    const eligible = verdict.chain.verified.map((c) => c.fingerprint_sha256);

    // Both inputs are honoured; supplying one must never disable the other.
    const anchorFps = (opts.trustAnchors ?? []).map((a) => fp(a));
    verdict.trusted =
      (wanted.length > 0 && eligible.some((f) => wanted.includes(f))) ||
      (anchorFps.length > 0 && eligible.some((f) => anchorFps.includes(f)));

    verdict.ok = verdict.failures.length === 0;
    return verdict;
  } catch (err) {
    verdict.failures.push(
      err instanceof DerError ? err.message : `token could not be parsed: ${String(err)}`,
    );
    return verdict;
  }
}

/** Attribute ::= SEQUENCE { attrType OID, attrValues SET OF ANY } */
function readAttributes(signedAttrs: DerNode): Map<string, DerNode> {
  const out = new Map<string, DerNode>();
  for (const attr of signedAttrs.children ?? []) {
    try {
      const type = readOid(child(attr, 0, 'attrType'));
      const values = child(attr, 1, 'attrValues');
      const first = values.children?.[0];
      if (first) out.set(type, first);
    } catch {
      /* skip unparseable attribute rather than failing the whole token */
    }
  }
  return out;
}

/** Match SignerInfo.sid (IssuerAndSerialNumber) against the bundled certs. */
function findSignerCert(certs: X509Certificate[], signerInfo: DerNode): X509Certificate | null {
  try {
    const sid = child(signerInfo, 1, 'sid');
    if (sid.tagNumber === TAG.SEQUENCE) {
      const serial = readSerialHex(child(sid, 1, 'serialNumber'));
      const match = certs.find((c) => c.serialNumber.toLowerCase().replace(/^0+/, '') === serial);
      if (match) return match;
    }
  } catch {
    /* fall through to the single-cert case */
  }
  // Common real-world case: exactly one leaf plus its issuers. Prefer the one
  // that can actually issue timestamps.
  return certs.find(hasTimeStampingEku) ?? certs[0] ?? null;
}

function readSerialHex(node: DerNode): string {
  const bytes = node.content[0] === 0 ? node.content.subarray(1) : node.content;
  return toHex(bytes).replace(/^0+/, '');
}

function hasTimeStampingEku(cert: X509Certificate): boolean {
  // node:crypto does not expose EKU directly, so read it off the DER.
  try {
    const parsed = parseDer(new Uint8Array(cert.raw));
    const ekuOid = findExtension(parsed, OID.extKeyUsage);
    if (!ekuOid) return false;
    return derContainsOid(ekuOid, OID.kpTimeStamping);
  } catch {
    return false;
  }
}

/** Locate an X.509 extension's extnValue by its OID. */
function findExtension(certNode: DerNode, oid: string): DerNode | null {
  const stack: DerNode[] = [certNode];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.tagNumber === TAG.SEQUENCE && node.children?.length && node.children.length >= 2) {
      const first = node.children[0]!;
      if (first.tagNumber === TAG.OID) {
        try {
          if (readOid(first) === oid) {
            const last = node.children[node.children.length - 1]!;
            if (last.tagNumber === TAG.OCTET_STRING) return last;
          }
        } catch { /* not an OID after all */ }
      }
    }
    for (const c of node.children ?? []) stack.push(c);
  }
  return null;
}

function derContainsOid(octetString: DerNode, oid: string): boolean {
  try {
    const inner = parseDer(octetString.content);
    const stack: DerNode[] = [inner];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.tagNumber === TAG.OID && !node.constructed && readOid(node) === oid) return true;
      for (const c of node.children ?? []) stack.push(c);
    }
  } catch { /* malformed extension */ }
  return false;
}

function fp(cert: X509Certificate): string {
  return cert.fingerprint256.replace(/:/g, '').toLowerCase();
}

function ref(cert: X509Certificate): CertRef {
  return { subject: cert.subject.replace(/\n/g, ', '), fingerprint_sha256: fp(cert) };
}

/**
 * Walk from the signer certificate upward, verifying each issuer signature.
 *
 * Real-world note that cost a design revision: commercial timestamp authorities
 * (DigiCert, Sectigo) deliberately do NOT embed their self-signed root in the
 * token -- they ship the chain up to an intermediate and expect the verifier to
 * already hold the root. Treating that as a verification failure would reject
 * genuine tokens from the most credible authorities, so an incomplete chain is
 * reported as a chain STATUS rather than a cryptographic failure. Trust anchors
 * supplied by the caller are consulted to close the gap.
 */
function buildChain(
  leaf: X509Certificate,
  pool: X509Certificate[],
  anchors: X509Certificate[],
): ChainStatus {
  let current = leaf;
  const seen = new Set<string>([fp(current)]);
  // Every certificate below has been cryptographically verified as part of this
  // path. Nothing else from the token is eligible to confer trust.
  const verified: CertRef[] = [ref(leaf)];

  for (let depth = 0; depth < 10; depth++) {
    if (current.checkIssued(current) && current.verify(current.publicKey)) {
      return { complete: true, verified, top: ref(current), root: ref(current), reason: '' };
    }

    const candidates = [...pool, ...anchors];
    const issuer = candidates.find((c) => fp(c) !== fp(current) && current.checkIssued(c));

    if (!issuer) {
      return {
        complete: false,
        verified,
        top: ref(current),
        root: null,
        reason:
          `chain stops at '${current.subject.replace(/\n/g, ', ')}', whose issuer is not in the token. ` +
          `This is normal for a commercial timestamp authority: supply its root with --trust to complete the chain.`,
      };
    }
    if (!current.verify(issuer.publicKey)) {
      return {
        complete: false, verified, top: ref(current), root: null,
        reason: `certificate '${current.subject.replace(/\n/g, ', ')}' does not verify under its stated issuer`,
      };
    }
    if (seen.has(fp(issuer))) {
      return { complete: false, verified, top: ref(current), root: null, reason: 'certificate chain contains a cycle' };
    }
    seen.add(fp(issuer));
    // The issuer's signature over `current` just verified, so it is part of the
    // path and eligible for trust matching.
    verified.push(ref(issuer));
    current = issuer;
  }
  return { complete: false, verified, top: ref(current), root: null, reason: 'certificate chain is longer than 10; refusing to continue' };
}

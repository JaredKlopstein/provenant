/**
 * RFC 3161 timestamp-authority backend. THE paid capability.
 *
 * Asks an authority the operator does not control to attest that a chain
 * statement existed at a point in time. After that, the operator cannot alter
 * anything at or before the anchored position without producing a head that no
 * longer matches the attestation -- and they cannot forge a replacement,
 * because they do not hold the authority's key.
 *
 * We verify the token we get back BEFORE storing it, using the same MIT
 * verifier customers use. Storing a token that does not verify would mean
 * selling evidence that fails at audit time, which is worse than selling
 * nothing. If it does not verify we throw and record no anchor.
 */
import { verifyTimestampToken } from '@provenant/verifier';
import type { AnchorBackend, AnchorProof, AnchorStatement } from '@provenant/core';
import { buildTimeStampReq } from './der.js';
import { parseDer } from '@provenant/verifier';
import { randomBytes } from 'node:crypto';

export interface TsaConfig {
  url: string;
  name?: string;
  timeoutMs?: number;
  /** Optional HTTP basic credentials some commercial authorities require. */
  auth?: { username: string; password: string };
}

/** PKIStatus values from RFC 3161 section 2.4.2. */
const STATUS: Record<number, string> = {
  0: 'granted',
  1: 'grantedWithMods',
  2: 'rejection',
  3: 'waiting',
  4: 'revocationWarning',
  5: 'revocationNotification',
};

export function createTsaBackend(config: TsaConfig): AnchorBackend {
  const name = config.name ?? new URL(config.url).hostname;

  return {
    name: 'tsa',
    description:
      `RFC 3161 trusted timestamp from ${name}. Produces a signed attestation a third party can ` +
      `verify offline, without trusting this operator. This is what makes the chain evidence ` +
      `rather than a self-attested log.`,
    isExternal: true,

    async anchor(statement: AnchorStatement, imprint: Uint8Array): Promise<AnchorProof> {
      // A nonce ties this response to this request, so a captured old response
      // cannot be replayed at us by a hostile network.
      const nonce = randomBytes(16);
      const req = buildTimeStampReq(imprint, new Uint8Array(nonce));

      const headers: Record<string, string> = {
        'Content-Type': 'application/timestamp-query',
        Accept: 'application/timestamp-reply',
      };
      if (config.auth) {
        const b = Buffer.from(`${config.auth.username}:${config.auth.password}`).toString('base64');
        headers.Authorization = `Basic ${b}`;
      }

      const res = await fetch(config.url, {
        method: 'POST',
        headers,
        body: req,
        signal: AbortSignal.timeout(config.timeoutMs ?? 20_000),
      });

      if (!res.ok) {
        throw new Error(
          `timestamp authority ${name} returned HTTP ${res.status}. No anchor was recorded; the chain is unchanged.`,
        );
      }

      const body = new Uint8Array(await res.arrayBuffer());

      // TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken ContentInfo OPTIONAL }
      const resp = parseDer(body);
      const statusInfo = resp.children?.[0];
      const statusNode = statusInfo?.children?.[0];
      const status = statusNode ? readSmallInt(statusNode.content) : -1;

      if (status !== 0 && status !== 1) {
        throw new Error(
          `timestamp authority ${name} refused the request: status ${status} (${STATUS[status] ?? 'unknown'}). ` +
            `No anchor was recorded.`,
        );
      }

      const tokenNode = resp.children?.[1];
      if (!tokenNode) {
        throw new Error(`timestamp authority ${name} returned no token. No anchor was recorded.`);
      }
      const token = tokenNode.full;

      // Verify before storing. Selling a token that fails at audit time is worse
      // than selling nothing.
      const verdict = verifyTimestampToken(token, { expectedImprint: imprint });
      if (!verdict.ok) {
        throw new Error(
          `timestamp authority ${name} returned a token that does not verify: ${verdict.failures.join('; ')}. ` +
            `No anchor was recorded.`,
        );
      }

      return {
        type: 'rfc3161',
        token: Buffer.from(token).toString('base64'),
        ...(verdict.proven_time ? { proven_time: verdict.proven_time } : {}),
        authority: verdict.signer ?? name,
      };
    },
  };
}

function readSmallInt(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) n = n * 256 + b;
  return n;
}

/** Public authorities that work without credentials, for getting started. */
export const PUBLIC_TSAS = {
  freetsa: 'https://freetsa.org/tsr',
  digicert: 'http://timestamp.digicert.com',
  sectigo: 'http://timestamp.sectigo.com',
} as const;

import type { Metadata } from 'next';
import Link from 'next/link';
import { PLANS } from '@provenant/cloud/src/pricing';
import { BRAND } from '../../src/brand';

export const metadata: Metadata = {
  title: `Security: ${BRAND.name}`,
  description: `The standards ${BRAND.name} is built on, the open-core boundary, and what a self-hosted chain does and does not prove.`,
};

const STANDARDS = [
  {
    name: 'RFC 8785',
    body: 'JSON Canonicalization Scheme. Every receipt is canonicalized before it is hashed or signed, so the same receipt always produces the same bytes. The verifier implements it separately from the code that writes receipts.',
  },
  {
    name: 'SHA-256',
    body: 'Each receipt carries the SHA-256 hash of the complete receipt before it. Changing any receipt changes its hash, every link after it, and the chain head.',
  },
  {
    name: 'Ed25519',
    body: 'Each receipt is signed with the recording agent’s own key, created locally. The verifier checks every signature against the public keys carried in the bundle.',
  },
  {
    name: 'RFC 9421',
    body: 'HTTP Message Signatures authenticate an agent to the collector with the same key that signs its receipts: method, authority, path and creation time are always covered, a body is covered by its digest, and replays are rejected by a 60-second window and a nonce cache. Receipt submission over HTTP is not built yet; only this authentication layer is.',
  },
  {
    name: 'RFC 3161',
    body: 'Trusted timestamps from an authority the operator does not control anchor the chain head on Cloud. The verifier checks the full token offline and reports whether the authority is in your trust list separately from whether the token is sound, because a bundle can embed a self-signed root.',
  },
] as const;

const PROOF_TABLE = [
  { property: 'Detects casual tampering', local: 'yes', anchored: 'yes' },
  { property: 'Detects a full rebuild by the operator', local: 'no', anchored: 'yes' },
  { property: 'Detects backdating after the anchor', local: 'no', anchored: 'yes' },
  { property: 'Detects truncation of the un-anchored tail', local: 'no', anchored: 'no' },
] as const;

export default function SecurityPage() {
  return (
    <>
      <section>
        <h1>Security</h1>
        <p>
          The standards the receipts are built on, the boundary that keeps verification independent,
          and the honest limits of what a chain proves.
        </p>
      </section>
      <section aria-label="Standards">
        <h2>Standards</h2>
        <ul>
          {STANDARDS.map((s) => (
            <li key={s.name}>
              <h3>{s.name}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ul>
        <p>
          The receipt shape aligns with draft-sharif-agent-audit-trail, an individual draft with no
          IETF standing, and departs from it where documented: notably Ed25519 where the draft
          specifies ECDSA P-256. We claim alignment with that draft, nothing more.
        </p>
      </section>
      <section aria-label="Open-core boundary">
        <h2>The open-core boundary</h2>
        <p>
          The code is split into three packages. Core (MIT) records, chains and verifies receipts
          locally. The verifier (MIT) checks evidence bundles offline. Cloud (commercial) anchors and
          exports bundles. Core never imports Cloud. The verifier imports neither Core nor Cloud, and
          no network module, so checking the paid tier’s output never requires the paid tier, and it
          runs on an air-gapped machine. These rules are a source scan that runs as the first CI
          step, not a convention.
        </p>
      </section>
      <section aria-label="What a self-hosted chain proves">
        <h2>What a self-hosted chain does and does not prove</h2>
        <p>
          A self-hosted chain is self-attested. It proves internal consistency: every receipt is
          intact, correctly signed and linked to the one before it. It does not prove the operator
          left history alone. An operator with database access and the agents’ signing keys can
          rebuild the whole chain, and local verification will pass. A test in the codebase does
          exactly that, then confirms the anchored bundle still fails, because the one thing the
          operator cannot forge is the timestamp authority’s signature. The local append-only
          database triggers stop application bugs and accidents, not a determined operator.
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Property</th>
              <th scope="col">Local chain</th>
              <th scope="col">Anchored chain</th>
            </tr>
          </thead>
          <tbody>
            {PROOF_TABLE.map((row) => (
              <tr key={row.property}>
                <th scope="row">{row.property}</th>
                <td>{row.local}</td>
                <td>{row.anchored}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          The last row is why Cloud anchors continuously: new receipts are batched and the chain head
          is anchored at most every {PLANS.cloud.maxAnchorIntervalMinutes} minutes, which bounds the
          window in which a truncation goes undetected. Receipts also describe only what an agent
          chose to record; they make recorded behaviour tamper-evident, not unrecorded behaviour
          visible.
        </p>
        <p>
          <Link href="/verify">Verify a bundle yourself</Link>
        </p>
      </section>
    </>
  );
}

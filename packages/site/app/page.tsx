import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '../src/brand';
import { GETTING_STARTED_URL } from '../src/plans';
import { PROOF_TABLE } from '../src/proof-table';

export const metadata: Metadata = {
  description: `${BRAND.name}: tamper-evident receipts for AI agents.`,
};

const PROOF_POINTS = [
  {
    title: 'Signed, hash-chained receipts',
    body: 'Each receipt is canonicalized with RFC 8785, chained with SHA-256 and signed with Ed25519, so altering or removing one breaks the chain at that receipt.',
  },
  {
    title: 'RFC 3161 anchoring',
    body: 'The chain head is timestamped by an RFC 3161 timestamp authority the operator does not control, so the record cannot be quietly rewritten or backdated.',
  },
  {
    title: 'Free offline verifier',
    body: 'The verifier is MIT-licensed, needs no network and no account, and lets anyone check an evidence bundle on their own machine.',
  },
] as const;

/**
 * Hard-coded, illustrative text only. It is not generated, signed or fetched, and
 * it is not a verifiable receipt: the hashes and signature are shortened placeholders.
 */
const EXAMPLE_RECEIPT = `{
  "record_id": "00000000-0000-4000-8000-000000000042",
  "timestamp": "2026-10-20T14:03:12Z",
  "agent_id": "support-agent",
  "agent_version": "1.4.0",
  "session_id": "00000000-0000-4000-8000-000000000007",
  "action_type": "tool_call",
  "action_detail": { "tool": "refund.issue", "order": "example-1001", "amount": "25.00" },
  "outcome": "success",
  "trust_level": "L2",
  "parent_record_id": null,
  "prev_hash": "9f2c…e41a",
  "${BRAND.name.toLowerCase()}": {
    "v": "1",
    "action": "refund.issue",
    "side_effect_class": "irreversible",
    "seq": 42,
    "signature_alg": "ed25519",
    "key_id": "example-key"
  },
  "signature": "example-signature…"
}`;

export default function HomePage() {
  return (
    <>
      <section>
        <h1>Prove what your AI agents did.</h1>
        <p>
          Every consequential action gets a signed, hash-chained receipt, timestamped by an authority
          you don’t control. Anyone can verify the record offline, without trusting you.
        </p>
        <ul aria-label="Get started">
          <li>
            <a href={GETTING_STARTED_URL}>Start free</a>
          </li>
          <li>
            <Link href="/pricing">See pricing</Link>
          </li>
        </ul>
      </section>
      <section aria-label="Proof points">
        <ul>
          {PROOF_POINTS.map((point) => (
            <li key={point.title}>
              <h2>{point.title}</h2>
              <p>{point.body}</p>
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="Example receipt">
        <h2>Example receipt</h2>
        <p>
          An illustrative example, not a real receipt: the hashes and signature are shortened
          placeholders, so it will not verify.
        </p>
        <figure>
          <pre>
            <code>{EXAMPLE_RECEIPT}</code>
          </pre>
          <figcaption>Example only. One receipt for one agent action.</figcaption>
        </figure>
      </section>
      <section aria-label="What a self-hosted chain proves">
        <h2>An audit trail your agents can’t rewrite, and neither can you.</h2>
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
          <Link href="/security">What each row means</Link>
        </p>
      </section>
      <section aria-label="Links">
        <ul>
          <li>
            <a href={BRAND.repository}>Source on GitHub</a>
          </li>
          <li>
            <a href={GETTING_STARTED_URL}>Getting started (GitHub)</a>
          </li>
        </ul>
      </section>
    </>
  );
}

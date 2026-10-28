import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '../src/brand';
import { GETTING_STARTED_URL } from '../src/plans';
import { PROOF_TABLE } from '../src/proof-table';
import { ExhibitChain } from '../src/exhibit-chain';
import { StandardsStrip } from '../src/standards-strip';
import styles from '../src/hero.module.css';

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
    body: 'When you anchor (with an evidence bundle), the chain head is timestamped by an RFC 3161 timestamp authority the operator does not control, so the record up to that point cannot be quietly rewritten or backdated.',
  },
  {
    title: 'Free offline verifier',
    body: 'The verifier is MIT-licensed, needs no network and no account, and lets anyone check an evidence bundle on their own machine.',
  },
] as const;

export default function HomePage() {
  return (
    <>
      <section aria-label="Hero" className={styles.hero}>
        <div className={styles.copy}>
          <span className="eyebrow">For teams running AI agents that touch money, mail or customer data</span>
          <h1>Your agent says it refunded $42.50. Prove it.</h1>
          <p className={styles.lede}>
            Every consequential action gets a signed, hash-chained receipt. Anchor the chain with a timestamp from
            an authority you don’t control, and anyone can verify the record offline, without trusting you.
          </p>
          {/* Links styled as buttons through this wrapper, so the anchors themselves stay plain. */}
          <p className={styles.ctas}>
            <a href={GETTING_STARTED_URL}>Start free</a> <Link href="/pricing">See pricing</Link>
          </p>
          <p className={styles.note}>Open source (MIT). Packages are not on npm yet: run from source.</p>
        </div>
        {/* Exhibit A: three real receipts, hashed in the browser (src/exhibit-chain.tsx). */}
        <div data-slot="exhibit" className={styles.slot}>
          <ExhibitChain />
        </div>
      </section>
      <StandardsStrip />
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

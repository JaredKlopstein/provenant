import type { Metadata } from 'next';
import Link from 'next/link';
import { PLANS } from '@provenant/cloud/src/pricing';
import { BRAND } from '../../src/brand';

export const metadata: Metadata = {
  title: `How it works: ${BRAND.name}`,
  description: `How ${BRAND.name} turns agent actions into evidence anyone can verify offline.`,
};

const ANCHOR_INTERVAL_MINUTES = PLANS.cloud.maxAnchorIntervalMinutes;

// Titles are numbered from the list position. Two of those numbers are also
// prices in the cloud pricing module, and the pricing test rejects any of those
// figures written into site source.
const STEPS = [
  {
    title: 'Record',
    body: 'An agent records each consequential action as a receipt: what it did, the action detail, its side-effect class and an idempotency key. The receipt is canonicalized with RFC 8785 and signed with the agent’s own Ed25519 key. Recording the same idempotency key again returns the original receipt and writes nothing new, and a dry run returns the exact receipt that would be written.',
  },
  {
    title: 'Hash chain',
    body: 'Every receipt carries the SHA-256 hash of the complete receipt before it, so the receipts form one chain. Altering, removing or reordering any receipt breaks the chain at that receipt, and local verification names the exact receipt that broke and the ranges that are still intact.',
  },
  {
    title: 'Anchor',
    body: `On Cloud, new receipts are batched and the chain head is anchored at most every ${ANCHOR_INTERVAL_MINUTES} minutes, with an RFC 3161 timestamp from an authority the operator does not control. The timestamp covers a statement that binds the chain id, position, head hash and receipt count, so a genuine token cannot be replayed against another chain or another position. Re-anchoring a position whose head has changed is refused rather than silently allowed.`,
  },
  {
    title: 'Evidence bundle',
    body: 'Cloud exports a range of the chain as an evidence bundle, in JSON with PDF and HTML renderings. The bundle is self-contained: the receipts as their exact canonical bytes, the agents’ public keys and the timestamp tokens. The one thing it does not carry is the timestamp authority’s trust anchor, because a bundle that vouched for itself would prove nothing.',
  },
  {
    title: 'Verify offline',
    body: 'Anyone checks the bundle with the free MIT verifier, on their own machine, with no network and no account. It recomputes every hash, checks every signature and the full RFC 3161 token, and reports whether the authority is one you trust separately from whether the mathematics holds. It names any receipt that fails and warns about receipts after the last anchor.',
  },
].map((step, index) => ({ title: `${index + 1}. ${step.title}`, body: step.body }));

export default function HowItWorksPage() {
  return (
    <>
      <section>
        <h1>How it works</h1>
        <p>
          From one agent action to evidence a third party can check without trusting the operator,
          in five steps.
        </p>
      </section>
      <section aria-label="Steps">
        <ol>
          {STEPS.map((step) => (
            <li key={step.title}>
              <h2>{step.title}</h2>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>
      <section aria-label="Limits">
        <h2>What the steps do not give you</h2>
        <p>
          Steps 1 and 2 are free and prove internal consistency only: an operator with database
          access could rebuild the whole chain and it would still verify. Step 3 is what the operator
          cannot forge. Even then, an anchor does not prove completeness: receipts after the last
          anchor can be truncated without breaking the chain, which is why Cloud anchors continuously
          and the verifier reports how far the chain is anchored.
        </p>
        <ul>
          <li>
            <Link href="/verify">Verify a bundle yourself</Link>
          </li>
          <li>
            <Link href="/security">Security: the standards and what they prove</Link>
          </li>
        </ul>
      </section>
    </>
  );
}

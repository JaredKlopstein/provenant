import { BRAND } from '../src/brand';

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

export default function HomePage() {
  return (
    <>
      <section>
        <h1>{BRAND.tagline}</h1>
        <p>
          Signed, hash-chained receipts for every consequential agent action, anchored to a public
          timestamp authority, verifiable offline by anyone.
        </p>
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
      <section aria-label="Links">
        <ul>
          <li>
            <a href={BRAND.repository}>Source on GitHub</a>
          </li>
          <li>
            <a href={`${BRAND.repository}/blob/main/docs/getting-started.md`}>Getting started (GitHub)</a>
          </li>
        </ul>
      </section>
    </>
  );
}

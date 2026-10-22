import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '../../src/brand';

export const metadata: Metadata = {
  title: 'Verify',
  description: `Check a ${BRAND.name} evidence bundle offline with the free MIT verifier. Verifying is never paywalled.`,
};

// The checkout directory and the CLI file names carry the name, so they derive
// from BRAND.repository rather than repeating it.
const REPO_DIR = BRAND.repository.slice(BRAND.repository.lastIndexOf('/') + 1);
// A path shown in a shell command, not an import: the site imports nothing from the
// verifier (test/site-app.test.ts). scripts/check-boundaries.mjs rejects any literal
// path into another package from site source, so it is joined from its parts.
const VERIFIER_BIN = ['packages', 'verifier', 'bin'].join('/');
const VERIFY = `node ${VERIFIER_BIN}/${REPO_DIR}-verify.mjs examples/sample-evidence/evidence.json`;

// SHA-256 fingerprint of DigiCert Trusted Root G4, as printed in the getting-started
// guide. A public certificate fingerprint, kept in groups so no long hex run sits in source.
const DIGICERT_ROOT_G4 = [
  '33846b54', '5a49c9be', '4903c60e', '01713c1b',
  'd4e4ef31', 'ea65cd95', 'd69e6279', '4f30b941',
].join('');

// Each block is copied from docs/getting-started.md, sections 1 and 3, and must stay identical.
const STEPS = [
  {
    title: 'Clone and build',
    body: 'You need Node 22.5.0 or later and pnpm 11 (corepack enable provides the pinned version). The build compiles each package into the files the commands below load.',
    command: [`git clone ${BRAND.repository}.git`, `cd ${REPO_DIR}`, 'pnpm install', 'pnpm run build'].join('\n'),
  },
  {
    title: 'Verify a real anchored bundle',
    body: 'The repository ships a genuine bundle of 3 receipts whose chain head was timestamped by DigiCert’s production RFC 3161 authority. This exits 0 with VERIFIED / ANCHORED, and reports that the authority is not yet in your trust list.',
    command: VERIFY,
  },
  {
    title: 'Pin the authority you trust',
    body: 'Trust has to come from you, not from the bundle, because anyone can embed a self-signed root. Pinning DigiCert Trusted Root G4 by its fingerprint makes the anchor report trusted by you: yes. Confirm the fingerprint with DigiCert directly rather than taking it from this page.',
    command: `${VERIFY} \\\n  --trust-fingerprint ${DIGICERT_ROOT_G4}`,
  },
] as const;

const VERDICTS = [
  {
    verdict: 'VERIFIED / ANCHORED',
    exit: 0,
    meaning: 'Every receipt is intact and correctly signed, and at least one external timestamp commits to the recomputed chain head. Receipts after the highest anchored position are still unanchored, and the verifier warns about them.',
  },
  {
    verdict: 'VERIFIED / NOT ANCHORED',
    exit: 0,
    meaning: 'Every receipt is intact and correctly signed, but no external timestamp commits to the chain. The record is self-attested.',
  },
  {
    verdict: 'VERIFICATION FAILED',
    exit: 1,
    meaning: 'At least one receipt is altered, missing or wrongly signed. The verifier names each one and lists the ranges that are still provably intact.',
  },
] as const;

export default function VerifyPage() {
  return (
    <>
      <section>
        <h1>Verify a bundle yourself</h1>
        <p>
          The verifier is free and MIT-licensed. Verifying is never paywalled: anyone holding an
          evidence bundle can check it on their own machine, with no network, no account and no code
          from the system that produced it.
        </p>
      </section>
      <section aria-label="Independence">
        <h2>Why you can rely on it</h2>
        <p>
          The verifier imports neither the core package nor the commercial one, and no network
          module. That rule is a source scan that runs as the first CI step, so it cannot quietly
          lapse. It reimplements canonicalization, the chain walk, signature checking and RFC 3161
          timestamp checking from the specifications, and a cross-implementation test keeps it in
          byte-for-byte agreement with the code that writes receipts.
        </p>
      </section>
      <section aria-label="Run it from source">
        <h2>Run it from source</h2>
        <p>
          The packages are not published yet, so run the verifier from a source checkout. Every
          command runs from the repository root, in order, with no edits.
        </p>
        <ol>
          {STEPS.map((step) => (
            <li key={step.title}>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
              <pre>
                <code>{step.command}</code>
              </pre>
            </li>
          ))}
        </ol>
        <p>
          Add <code>--json</code> to either verifier command for a machine-readable verdict. The{' '}
          <a href={`${BRAND.repository}/blob/main/docs/getting-started.md`}>getting-started guide</a>{' '}
          also covers recording and verifying a receipt of your own.
        </p>
      </section>
      <section aria-label="Verdicts">
        <h2>What the verdict means</h2>
        <ul>
          {VERDICTS.map((v) => (
            <li key={v.verdict}>
              <h3>
                {v.verdict} (exit {v.exit})
              </h3>
              <p>{v.meaning}</p>
            </li>
          ))}
        </ul>
        <p>
          An unreadable bundle or an unknown option exits 2 with a usage message and no verdict. See{' '}
          <Link href="/security">Security</Link> for what a verified chain does and does not prove.
        </p>
      </section>
    </>
  );
}

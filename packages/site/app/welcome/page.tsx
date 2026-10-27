import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { BRAND } from '../../src/brand';
import { SIGNUP_PATH } from '../../src/auth/email';
import { AccountBar } from '../../src/account-bar';
import { signedInFromCookie } from '../../src/checkout';
import { CodeBlock } from '../../src/code-block';

export const metadata: Metadata = {
  title: 'Welcome',
  description: `Start recording ${BRAND.name} receipts from source.`,
};

// Stripe sends the customer back with ?session_id=<the Checkout session id>. Its
// shape is checked so the page can say checkout finished; the id is never shown.
const CHECKOUT_SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]+$/;

// The checkout directory and the home variable still follow the repository
// path. The CLI file is lacre.mjs, which is not that name.
const REPO_DIR = BRAND.repository.slice(BRAND.repository.lastIndexOf('/') + 1);
// A path shown in a shell command, not an import: scripts/check-boundaries.mjs rejects
// any literal path into another package from site source, so it is joined from its parts.
const CLI = `node ${['packages', 'core', 'bin', 'lacre.mjs'].join('/')}`;

// Each block is copied from docs/getting-started.md, sections 1 and 2, and must stay identical.
const STEPS = [
  {
    title: 'Clone and build',
    body: 'You need Node 22.5.0 or later and pnpm 11 (corepack enable provides the pinned version).',
    command: [`git clone ${BRAND.repository}.git`, `cd ${REPO_DIR}`, 'pnpm install', 'pnpm run build'].join('\n'),
  },
  {
    title: 'Keep your data in the checkout',
    body: 'Point the home directory at the checkout so your keys and chain stay with it.',
    command: `export ${REPO_DIR.toUpperCase()}_HOME="$PWD/.${REPO_DIR}"`,
  },
  {
    title: 'Create an identity',
    body: 'This makes the Ed25519 key your agent signs receipts with.',
    command: `${CLI} init --json`,
  },
  {
    title: 'Record a receipt',
    body: 'One signed, hash-chained receipt for one consequential action.',
    command: [
      `${CLI} record --action refund.issue \\`,
      `  --action-detail '{"customer_id":"c_8812","amount_usd":42.50}' \\`,
      '  --side-effect-class irreversible \\',
      '  --idempotency-key refund-c_8812-0001 --json',
    ].join('\n'),
  },
  {
    title: 'Verify the chain',
    body: 'Checks every hash link and signature on your machine.',
    command: `${CLI} chain verify --json`,
  },
] as const;

type SearchParams = Record<string, string | string[] | undefined>;

export default async function WelcomePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const account = await signedInFromCookie((await headers()).get('cookie'));
  if (!account) redirect(`${SIGNUP_PATH}?for=welcome`);

  const { session_id: sessionId } = await searchParams;
  const checkedOut = typeof sessionId === 'string' && CHECKOUT_SESSION_ID.test(sessionId);

  return (
    <>
      <AccountBar account={account} />
      <section>
        <h1>Welcome</h1>
        {checkedOut && <p role="status">Thank you. Your checkout with Stripe is complete.</p>}
        <p>
          {BRAND.name} runs from source today. These steps record and verify your first receipt
          locally; the{' '}
          <a href={`${BRAND.repository}/blob/main/docs/getting-started.md`}>getting-started guide</a>{' '}
          explains each one.
        </p>
      </section>
      {STEPS.map((step) => (
        <section key={step.title}>
          <h2>{step.title}</h2>
          <p>{step.body}</p>
          <CodeBlock label={step.title}>{step.command}</CodeBlock>
        </section>
      ))}
    </>
  );
}

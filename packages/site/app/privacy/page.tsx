import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '../../src/brand';
import { LEGAL, TERMS_PATH, fact } from '../../src/legal';
import { LegalNotice } from '../../src/legal-notice';

export const metadata: Metadata = {
  title: 'Privacy',
  description: `What personal data ${BRAND.name} collects, why, who processes it and how long it is kept.`,
};

// Every statement below describes what the site's code does (src/auth, src/contact,
// the billing database). Facts only the owner can supply come from src/legal.ts and
// render as bracketed placeholders until set.
export default function PrivacyPage() {
  return (
    <article>
      <h1>Privacy</h1>
      <LegalNotice />

      <h2>Who is responsible</h2>
      <p>
        {fact('entityName')}, {fact('entityJurisdiction')}, is responsible for personal data handled through this
        website. Contact {fact('contactEmail')}
        {LEGAL.postalAddress ? ` or write to ${LEGAL.postalAddress}` : ''}.
      </p>

      <h2>What we collect, and why</h2>
      <ul>
        <li>
          <strong>Your email address, to sign you in.</strong> We send a one-time sign-in link to it. Your account
          is identified by a one-way hash of the address. The address itself is kept only in your signed session
          cookie, so we can show who is signed in; we do not keep a list of addresses.
        </li>
        <li>
          <strong>Purchases.</strong> Payment is handled by Stripe, which receives the details you enter at
          checkout. We keep the Stripe customer and subscription identifiers linked to your account, and your plan,
          its status and renewal date, so we can show them to you and provide what you bought. We never see or
          store your card number.
        </li>
        <li>
          <strong>Messages you send us.</strong> The Enterprise contact form and the early-access waitlist send
          your name, work email, company, fleet size and message to our team inbox, so we can reply. We keep them
          for {fact('contactRetention')}.
        </li>
        <li>
          <strong>Your chain file, if you buy an evidence bundle.</strong> To make the bundle we ask you to email us
          your chain file. It holds your receipts, including the action details your agents recorded, and your
          agents’ public keys. It never holds a signing key, and we never ask for one. We use it only to timestamp
          the chain and build your bundle, and we keep the chain file and the bundle for{' '}
          {fact('bundleRetention')}, so a copy exists if you need it again.
        </li>
        <li>
          <strong>Abuse protection.</strong> To limit how often sign-in links and messages can be sent, we count
          requests per email address and per IP address. Only one-way hashes are stored, never the address
          itself, and the counts are deleted after 15 minutes.
        </li>
        <li>
          <strong>Server logs.</strong> Our own logs record request identifiers and error types, not your email or
          message. Our hosting provider also keeps standard request logs, such as IP address and time.
        </li>
      </ul>

      <h2>What we do not collect</h2>
      <p>
        No analytics or advertising cookies, and no tracking across sites. Receipts you record with{' '}
        {BRAND.name} Core stay on your own systems. We receive them only if you send us your chain file for an
        evidence bundle, as described above. The offline verifier makes no network
        requests.
      </p>

      <h2>Cookies and browser storage</h2>
      <p>
        One essential cookie keeps you signed in for up to seven days; it is cleared when you sign out. On the
        sign-up page, the address you typed is held in your browser tab for one page load, so it is not lost if
        sending fails.
      </p>

      <h2>Who processes data for us</h2>
      <ul>
        <li>Vercel, which hosts the website.</li>
        <li>Neon, which hosts our database.</li>
        <li>Stripe, which takes payments.</li>
        <li>{fact('emailProvider')}, which delivers sign-in emails.</li>
        <li>{fact('mailboxProvider')}, which hosts the inbox that receives chain files for evidence bundles.</li>
      </ul>

      <h2>Your choices and rights</h2>
      <p>
        You can ask what personal data we hold about you, or ask us to correct or delete it, by writing to{' '}
        {fact('contactEmail')}. We delete what we are not required to keep; payment records may have to be kept
        for tax and accounting purposes.
      </p>

      <h2>Changes</h2>
      <p>
        When this policy changes, the effective date above changes, and material changes are announced on this
        site before they apply. The <Link href={TERMS_PATH}>Terms</Link> cover using the service.
      </p>
    </article>
  );
}

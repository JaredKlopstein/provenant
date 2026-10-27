import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '../../src/brand';
import { LEGAL, PRIVACY_PATH, fact } from '../../src/legal';
import { LegalNotice } from '../../src/legal-notice';

export const metadata: Metadata = {
  title: 'Terms',
  description: `The terms for using ${BRAND.name}, its paid evidence bundles and the website.`,
};

// Facts only the owner can supply come from src/legal.ts and render as bracketed
// placeholders until set. Prices live on the pricing page, never here.
export default function TermsPage() {
  const refundDays = LEGAL.refundWindowDays;
  return (
    <article>
      <h1>Terms</h1>
      <LegalNotice />

      <h2>Who we are</h2>
      <p>
        {BRAND.name} is run by {fact('entityName')}, {fact('entityJurisdiction')} (&ldquo;we&rdquo;). Reach us at{' '}
        {fact('contactEmail')}
        {LEGAL.postalAddress ? `, or by post at ${LEGAL.postalAddress}` : ''}.
      </p>

      <h2>What these terms cover</h2>
      <p>
        These terms cover this website, accounts created on it, and anything bought through it. The open-source{' '}
        {BRAND.name} Core and the offline verifier are licensed separately under the MIT licence in their source
        repository; these terms do not limit what that licence allows.
      </p>

      <h2>Accounts</h2>
      <p>
        You sign in with a link sent to your email address. Keep access to that address secure: anyone who can
        read it can sign in as you. You can sign out at any time from a signed-in page.
      </p>

      <h2>Purchases and payment</h2>
      <p>
        Prices are on the <Link href="/pricing">pricing page</Link>. Payments are taken by Stripe; we do not see or
        store your card number. Plans marked early access are not on sale and cannot be bought. An evidence bundle
        is a one-time purchase.
      </p>

      <h2>Refunds and cancellation</h2>
      <p>
        {refundDays === null
          ? `You can request a refund within ${fact('refundWindowDays')} of purchase by writing to ${fact('contactEmail')}.`
          : refundDays === 0
            ? 'Purchases are not refundable, except where the law requires otherwise.'
            : `You can request a refund within ${refundDays} days of purchase by writing to ${fact('contactEmail')}.`}{' '}
        A subscription can be cancelled at any time in the billing portal on your account page; it stays active
        until the end of the period already paid for.
      </p>

      <h2>What the service does and does not prove</h2>
      <p>
        {BRAND.name} records signed, hash-chained receipts and can anchor a chain to a timestamp authority. A
        receipt shows what was recorded and that the record was not altered afterwards; it does not show that an
        action happened as described, or that every action was recorded. Using {BRAND.name} does not by itself
        meet the requirements of any law, regulation or standard. See <Link href="/security">Security</Link> for
        the limits in detail.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Do not use the service to break the law, to attack or overload it or other systems, or to get around its
        limits or access controls.
      </p>

      <h2>Warranty and liability</h2>
      <p>
        The service is provided &ldquo;as is&rdquo;, without warranties of any kind, to the extent the law allows.
        To the extent the law allows, our total liability for any claim relating to the service is limited to
        what you paid us in the twelve months before the claim.
      </p>

      <h2>Changes and governing law</h2>
      <p>
        We may update these terms; the effective date above changes when we do, and material changes are
        announced on this site before they apply. These terms are governed by {fact('governingLaw')}.
      </p>

      <p>
        How we handle personal data is set out in the <Link href={PRIVACY_PATH}>Privacy Policy</Link>.
      </p>
    </article>
  );
}

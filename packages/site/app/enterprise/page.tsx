import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '../../src/brand';
import { CONTACT_OUTCOMES, CONTACT_PATH, FLEET_SIZES, HONEYPOT_FIELD, type ContactOutcome } from '../../src/contact';

export const metadata: Metadata = {
  title: `Enterprise: ${BRAND.name}`,
  description: `Talk to the ${BRAND.name} team about Enterprise: retention, anchoring cadence and volume set by contract.`,
};

// Enterprise has no listed price and is never sold through self-serve checkout,
// matching the billing routes' "contact us" answer. Keep dollar figures off this page.
const TERMS = [
  'Retention and anchoring cadence set by contract',
  'Volume beyond the Cloud fair-use cap',
  'Terms agreed with you, not listed here',
] as const;

// The contact route redirects a form post back here with ?contact=<outcome>.
const OUTCOME_MESSAGES: Record<ContactOutcome, string> = {
  sent: `Thanks. The ${BRAND.name} team has your message and will reply to the email you gave.`,
  invalid: 'Some details were missing or not valid, so nothing was sent. Check each field and send it again.',
  unavailable: `The contact form is not configured yet, so nothing was sent. Reach the team through ${BRAND.repository} for now.`,
  failed: 'Your message could not be delivered, so nothing was sent. Try again shortly.',
};

// Kept off screen rather than display:none, which some bots skip. People never reach it.
const HONEYPOT_STYLE = { position: 'absolute', left: '-10000px', width: '1px', height: '1px', overflow: 'hidden' } as const;

type SearchParams = Record<string, string | string[] | undefined>;

export default async function EnterprisePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { contact } = await searchParams;
  const outcome = CONTACT_OUTCOMES.find((o) => o === contact);

  return (
    <>
      <section>
        <h1>Enterprise</h1>
        <p>
          For teams running agent fleets whose terms do not fit the Cloud plan. Enterprise is agreed
          by contract, not bought through checkout, and it has no listed price. Tell us what you
          need below. We reply within two business days.
        </p>
        <ul>
          {TERMS.map((term) => (
            <li key={term}>{term}</li>
          ))}
        </ul>
        <p>
          Verifying a bundle stays free for everyone, on every plan. See{' '}
          <Link href="/verify">Verify</Link>.
        </p>
      </section>
      <section aria-label="Contact">
        <h2>Contact the team</h2>
        {outcome && <p role="status">{OUTCOME_MESSAGES[outcome]}</p>}
        <form method="post" action={CONTACT_PATH}>
          <p>
            <label htmlFor="contact-name">Name</label>
            <input id="contact-name" name="name" type="text" required maxLength={200} autoComplete="name" />
          </p>
          <p>
            <label htmlFor="contact-email">Work email</label>
            <input id="contact-email" name="email" type="email" required maxLength={254} autoComplete="email" />
          </p>
          <p>
            <label htmlFor="contact-company">Company</label>
            <input
              id="contact-company"
              name="company"
              type="text"
              required
              maxLength={200}
              autoComplete="organization"
            />
          </p>
          <p>
            <label htmlFor="contact-fleet">Agent fleet size</label>
            <select id="contact-fleet" name="fleetSize" required defaultValue="">
              <option value="" disabled>
                Choose one
              </option>
              {FLEET_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} agents
                </option>
              ))}
            </select>
          </p>
          <p>
            <label htmlFor="contact-need">What you need</label>
            <textarea id="contact-need" name="need" required maxLength={5000} rows={6} />
          </p>
          <div aria-hidden="true" style={HONEYPOT_STYLE}>
            <label htmlFor="contact-website">Leave this field empty</label>
            <input id="contact-website" name={HONEYPOT_FIELD} type="text" tabIndex={-1} autoComplete="off" />
          </div>
          <p>
            <button type="submit">Send</button>
          </p>
        </form>
      </section>
    </>
  );
}

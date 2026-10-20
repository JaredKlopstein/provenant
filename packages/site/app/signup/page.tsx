import type { Metadata } from 'next';
import { BRAND } from '../../src/brand';
import { MAGIC_LINK_PATH, MAX_EMAIL_LENGTH, SIGNUP_OUTCOMES, type SignupOutcome } from '../../src/auth/email';

export const metadata: Metadata = {
  title: `Sign up: ${BRAND.name}`,
  description: `Create your ${BRAND.name} account with a sign-in link sent to your email.`,
};

// The magic-link route redirects a form post back here with ?signup=<outcome>, and
// the callback does the same with ?signup=expired for a link that no longer works.
// "sent" reads the same whether or not the address already has an account.
const OUTCOME_MESSAGES: Record<SignupOutcome, string> = {
  sent: 'If that address can receive email, a sign-in link is on its way. It expires in 15 minutes.',
  invalid: 'That does not look like an email address, so nothing was sent. Check it and send it again.',
  unavailable: 'Email sign-up is not open yet, so nothing was sent.',
  failed: 'The sign-in email could not be sent. Try again shortly.',
  expired: 'That sign-in link is not valid or has expired. Enter your email to get a new one.',
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function SignupPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { signup } = await searchParams;
  const outcome = SIGNUP_OUTCOMES.find((o) => o === signup);

  return (
    <section>
      <h1>Sign up</h1>
      <p>
        Enter your email and we will send you a sign-in link. Your {BRAND.name} account is created the
        first time you use it. No password.
      </p>
      {outcome && <p role="status">{OUTCOME_MESSAGES[outcome]}</p>}
      <form method="post" action={MAGIC_LINK_PATH}>
        <p>
          <label htmlFor="signup-email">Email</label>
          <input
            id="signup-email"
            name="email"
            type="email"
            required
            maxLength={MAX_EMAIL_LENGTH}
            autoComplete="email"
          />
        </p>
        <p>
          <button type="submit">Send sign-in link</button>
        </p>
      </form>
    </section>
  );
}

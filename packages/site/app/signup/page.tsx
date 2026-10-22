import type { Metadata } from 'next';
import { BRAND } from '../../src/brand';
import { MAGIC_LINK_PATH, MAX_EMAIL_LENGTH, SIGNUP_OUTCOMES, type SignupOutcome } from '../../src/auth/email';
import { parseDestination, type Destination } from '../../src/auth/session';

const TITLE ='Sign in or create an account';

export const metadata: Metadata = {
  title: TITLE,
  description: `Sign in to ${BRAND.name}, or create your account, with a sign-in link sent to your email.`,
};

// The magic-link route redirects a form post back here with ?signup=<outcome>, and
// the callback does the same with ?signup=expired for a link that no longer works.
// "sent" reads the same whether or not the address already has an account.
const OUTCOME_MESSAGES: Record<SignupOutcome, string> = {
  sent: 'If that address can receive email, a sign-in link is on its way. It expires in 15 minutes.',
  invalid: 'That does not look like an email address, so nothing was sent. Check it and send it again.',
  unavailable: 'Email sign-up is not open yet, so nothing was sent.',
  failed: 'The sign-in email could not be sent. Try again shortly.',
  expired: 'This sign-in link is no longer valid. Request a new one.',
};

// A signed-out redirect says where it came from with ?for=<destination key>.
const CONTEXT_LINES: Record<Destination, string> = {
  checkout: 'Sign in to continue to checkout.',
  account: 'Sign in to continue to your account.',
  welcome: 'Sign in to continue to getting started.',
};

// Outcomes where nothing was sent, so the address the visitor typed is put back.
const KEEP_EMAIL: readonly SignupOutcome[] = ['invalid', 'unavailable', 'failed'];

const FORM_ID = 'signup-form';
const EMAIL_ID = 'signup-email';
const EMAIL_STORAGE_KEY = 'signup-email';

/**
 * The form posts natively and the route answers with a redirect, so the typed
 * address would be lost. It is held in this tab's sessionStorage for one page
 * load instead of riding in the URL, and put back only after a refused or failed
 * send. Nothing from the request is written into the script.
 */
function keepEmailScript(restore: boolean): string {
  return `(function(){var f=document.getElementById(${JSON.stringify(FORM_ID)}),e=document.getElementById(${JSON.stringify(EMAIL_ID)}),k=${JSON.stringify(EMAIL_STORAGE_KEY)};if(!f||!e)return;try{var v=sessionStorage.getItem(k);sessionStorage.removeItem(k);if(${restore}&&v&&!e.value)e.value=v;}catch(_){}f.addEventListener('submit',function(){try{sessionStorage.setItem(k,e.value);}catch(_){}});})();`;
}

type SearchParams = Record<string, string | string[] | undefined>;

export default async function SignupPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { signup, for: destination } = await searchParams;
  const outcome = SIGNUP_OUTCOMES.find((o) => o === signup);
  // ?for=account and the like ride along as a destination key; anything else is dropped.
  const dest = parseDestination(destination);

  return (
    <section aria-label="Sign in">
      <h1>{TITLE}</h1>
      {dest && <p>{CONTEXT_LINES[dest]}</p>}
      <p>
        Enter your email and we will send you a sign-in link. Your {BRAND.name} account is created the
        first time you use it. No password.
      </p>
      {outcome && <p role="status">{OUTCOME_MESSAGES[outcome]}</p>}
      <form id={FORM_ID} method="post" action={MAGIC_LINK_PATH}>
        {dest && <input type="hidden" name="for" value={dest} />}
        <p>
          <label htmlFor={EMAIL_ID}>Email</label>
          <input
            id={EMAIL_ID}
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
      <script dangerouslySetInnerHTML={{ __html: keepEmailScript(!!outcome && KEEP_EMAIL.includes(outcome)) }} />
    </section>
  );
}

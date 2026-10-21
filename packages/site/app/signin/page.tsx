import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { BRAND } from '../../src/brand';
import { SIGNUP_PATH } from '../../src/auth/email';
import { checkLinkToken } from '../../src/auth/confirm';
import { CALLBACK_PATH } from '../../src/auth/session';

// The page URL carries the sign-in token: send no Referer anywhere, and keep it out of search.
export const metadata: Metadata = {
  title: `Sign in: ${BRAND.name}`,
  description: `Confirm your ${BRAND.name} sign-in.`,
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

// The emailed link lands here. Opening it only checks the link; nothing is used up
// and no one is signed in until the button below is pressed.
export default async function SigninPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { token } = await searchParams;
  const link = typeof token === 'string' ? token : null;
  const check = await checkLinkToken(link);

  if (check.status === 'unavailable') {
    return (
      <section>
        <h1>Sign in</h1>
        <p role="status">Sign-in is not available right now, so no one was signed in. Try the link again shortly.</p>
      </section>
    );
  }
  if (check.status === 'invalid') redirect(`${SIGNUP_PATH}?signup=expired`);

  return (
    <section>
      <h1>Sign in</h1>
      <p>
        Sign in to {BRAND.name} as <strong>{check.email}</strong>.
      </p>
      <form method="post" action={CALLBACK_PATH}>
        <input type="hidden" name="token" value={link!} />
        <button type="submit">Sign in</button>
      </form>
      <p>This link works once. If you did not ask to sign in, close this page; nothing happens until you press the button.</p>
    </section>
  );
}

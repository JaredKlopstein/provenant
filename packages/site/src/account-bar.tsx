import { SIGN_OUT_PATH, type SignedInAccount } from './auth/session';

/**
 * "Signed in as <email>" and a Sign out button, at the top of the signed-in pages
 * (checkout, account, welcome). Those pages read the session already; the layout
 * never does, so the marketing pages stay statically rendered. A session issued
 * before the email was stored shows "Signed in" without an address.
 */
export function AccountBar({ account }: { account: SignedInAccount }) {
  return (
    <div className="account-bar">
      <p>
        {account.email ? (
          <>
            Signed in as <strong>{account.email}</strong>
          </>
        ) : (
          'Signed in'
        )}
      </p>
      <form method="post" action={SIGN_OUT_PATH}>
        <button type="submit">Sign out</button>
      </form>
    </div>
  );
}

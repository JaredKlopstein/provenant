'use client';

import { useState, type FormEvent } from 'react';
import { BRAND } from '../../src/brand';

// Same reply for every address, so the page never says whether one already has an account.
type Status = { state: 'idle' } | { state: 'sending' } | { state: 'done'; message: string };

export default function SignupPage() {
  const [status, setStatus] = useState<Status>({ state: 'idle' });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = new FormData(event.currentTarget).get('email');
    setStatus({ state: 'sending' });
    try {
      const res = await fetch('/api/auth/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = (await res.json().catch(() => null)) as
        | { message?: string; error?: { message?: string; fix?: { note?: string } } }
        | null;
      const message = body?.message ?? [body?.error?.message, body?.error?.fix?.note].filter(Boolean).join(' ');
      setStatus({ state: 'done', message: message || 'Something went wrong. Try again in a minute.' });
    } catch {
      setStatus({ state: 'done', message: 'Could not reach the server. Check your connection and try again.' });
    }
  }

  return (
    <section>
      <h1>Sign up</h1>
      <p>
        Enter your email and we will send you a sign-in link. Opening it creates your {BRAND.name}{' '}
        account and takes you to checkout. The link expires in 15 minutes.
      </p>
      <form method="post" action="/api/auth/magic-link" onSubmit={onSubmit}>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
        <button type="submit" disabled={status.state === 'sending'}>
          {status.state === 'sending' ? 'Sending…' : 'Email me a link'}
        </button>
      </form>
      {status.state === 'done' ? <p role="status">{status.message}</p> : null}
    </section>
  );
}

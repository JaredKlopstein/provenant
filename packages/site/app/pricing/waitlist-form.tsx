'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { CONTACT_PATH, FLEET_SIZES } from '../../src/contact';

/**
 * The Cloud early-access waitlist. It posts JSON to the existing contact route
 * with that route's own keys, so a waitlist entry arrives as a contact message
 * whose need says what it is. No payment details are asked for, and no
 * honeypot is rendered: the route's honeypot is for its native form post.
 */

export const WAITLIST_NEED = 'Cloud early access waitlist';

/** The keys the contact route reads. The form sends exactly these. */
export const WAITLIST_FIELDS = ['name', 'email', 'company', 'fleetSize', 'need'] as const;
export type WaitlistField = (typeof WAITLIST_FIELDS)[number];

/** The contact route's own length limits; a longer value is refused there. */
export const WAITLIST_MAX_LENGTH = { name: 200, email: 254, company: 200, need: 5000 } as const;

export type WaitlistResult = 'sent' | 'invalid' | 'too_large' | 'rate_limited' | 'failed' | 'unavailable' | 'error';

const RESULT_MESSAGES: Record<WaitlistResult, string> = {
  sent: "Thanks. You're on the Cloud early access list, and we'll email you when it opens.",
  invalid: 'Some details were missing or not valid, so nothing was sent. Check each field and send it again.',
  too_large: 'That message is too long, so nothing was sent. Shorten it and send it again.',
  rate_limited: 'Several messages were sent from here in a short time, so this one was not sent. Please try again in a few minutes.',
  failed: 'Your request could not be delivered, so nothing was sent. Try again shortly.',
  unavailable: 'The waitlist is unavailable right now, so nothing was sent. Try again in a few minutes.',
  error: 'Something went wrong, so nothing may have been sent. Try again shortly.',
};

/** The JSON body for the contact route: exactly WAITLIST_FIELDS, each a string. */
export function waitlistBody(values: { get(key: string): unknown }): Record<WaitlistField, string> {
  const body = {} as Record<WaitlistField, string>;
  for (const key of WAITLIST_FIELDS) {
    const value = values.get(key);
    body[key] = typeof value === 'string' ? value : '';
  }
  return body;
}

/** What the contact route's answer means, from its status and error code only. */
export function waitlistResult(status: number, code: unknown): WaitlistResult {
  if (status === 200) return 'sent';
  if (status === 400 && code === 'INVALID_INPUT') return 'invalid';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  if (status === 502) return 'failed';
  if (status === 503) return 'unavailable';
  return 'error';
}

export function WaitlistForm() {
  // Submitting is only possible once hydrated, so the form never falls back to
  // a native submission that would put the fields in the page URL.
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<WaitlistResult | null>(null);
  useEffect(() => setReady(true), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setSending(true);
    setResult(null);
    let outcome: WaitlistResult;
    try {
      const res = await fetch(CONTACT_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(waitlistBody(new FormData(form))),
      });
      const answer: unknown = await res.json().catch(() => null);
      const code = (answer as { error?: { code?: unknown } } | null)?.error?.code;
      outcome = waitlistResult(res.status, code);
    } catch {
      outcome = 'error';
    }
    setResult(outcome);
    setSending(false);
    if (outcome === 'sent') form.reset();
  }

  return (
    <form aria-label="Cloud early access waitlist" onSubmit={submit}>
      <h3>Join the early access list</h3>
      {result && (
        <p role={result === 'sent' ? 'status' : 'alert'} data-result={result}>
          {RESULT_MESSAGES[result]}
        </p>
      )}
      <p>
        <label htmlFor="waitlist-name">Name</label>
        <input id="waitlist-name" name="name" type="text" required maxLength={WAITLIST_MAX_LENGTH.name} autoComplete="name" />
      </p>
      <p>
        <label htmlFor="waitlist-email">Work email</label>
        <input id="waitlist-email" name="email" type="email" required maxLength={WAITLIST_MAX_LENGTH.email} autoComplete="email" />
      </p>
      <p>
        <label htmlFor="waitlist-company">Company</label>
        <input
          id="waitlist-company"
          name="company"
          type="text"
          required
          maxLength={WAITLIST_MAX_LENGTH.company}
          autoComplete="organization"
        />
      </p>
      <p>
        <label htmlFor="waitlist-fleet">Agent fleet size</label>
        <select id="waitlist-fleet" name="fleetSize" required defaultValue="">
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
        <label htmlFor="waitlist-need">What you need</label>
        <textarea id="waitlist-need" name="need" required maxLength={WAITLIST_MAX_LENGTH.need} rows={3} defaultValue={WAITLIST_NEED} />
      </p>
      <p>
        <button type="submit" disabled={!ready || sending}>
          {sending ? 'Sending…' : 'Join the list'}
        </button>
      </p>
    </form>
  );
}

/**
 * The magic-link email and the provider call that sends it.
 *
 * The provider is any HTTP email API reached with `fetch`, configured by
 * EMAIL_API_URL, EMAIL_API_KEY and EMAIL_FROM. There is no SDK dependency. The
 * request is a JSON POST of { from, to, subject, text } with
 * "Authorization: Bearer <EMAIL_API_KEY>".
 *
 * The email is plain text and holds exactly three things: the link, its expiry
 * and a line saying to ignore it if you did not ask. No HTML, no images, no
 * tracking pixel and no other URL.
 *
 * Nothing here logs. The key, the link and the body never leave this module
 * except in the request to the provider.
 */
import { BRAND } from '../brand';

type Env = Record<string, string | undefined>;

export interface EmailConfig {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly from: string;
}

export interface MagicLinkEmail {
  readonly subject: string;
  readonly text: string;
}

/** The email settings, or null when any is unset or EMAIL_API_URL is not an https URL. */
export function readEmailConfig(env: Env): EmailConfig | null {
  const apiUrl = env.EMAIL_API_URL?.trim();
  const apiKey = env.EMAIL_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  if (!apiUrl || !apiKey || !from) return null;
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  return { apiUrl: url.href, apiKey, from };
}

export function magicLinkEmail(link: string, expiresInMinutes: number): MagicLinkEmail {
  return {
    subject: `Your ${BRAND.name} sign-in link`,
    text: [
      link,
      `This link expires in ${expiresInMinutes} minutes.`,
      "If you didn't ask for this email, ignore it.",
    ].join('\n\n'),
  };
}

/**
 * Sends the email. Returns true when the provider accepted it and false for any
 * failure, without saying why: the caller tells the user to try again, and the
 * provider's reply is not passed on or logged.
 */
export async function sendMagicLinkEmail(
  config: EmailConfig,
  to: string,
  email: MagicLinkEmail,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(config.apiUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: config.from, to, subject: email.subject, text: email.text }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

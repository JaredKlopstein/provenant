import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import RootLayout from '../app/layout.js';
import SignupPage, { metadata } from '../app/signup/page.js';
import SigninPage from '../app/signin/page.js';
import { BRAND } from '../src/brand.js';

/**
 * #123: the signup page reads "Sign in or create an account", says where a
 * signed-out redirect was headed, keeps the typed email after a refused or failed
 * send, and shows ?signup=expired as a styled message inside the site layout.
 */

type Params = Record<string, string>;

const render = async (params: Params = {}) =>
  renderToStaticMarkup(await SignupPage({ searchParams: Promise.resolve(params) }));
const main = (html: string) => /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? '';
const script = (html: string) => /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';

const rules = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ');

describe('signup page title', () => {
  it('reads "Sign in or create an account" in the title and the heading', async () => {
    expect(metadata.title).toBe(`Sign in or create an account: ${BRAND.name}`);
    expect(await render()).toContain('<h1>Sign in or create an account</h1>');
  });
});

describe('signup context line', () => {
  it('shows a line matching a known ?for= destination', async () => {
    const lines = {
      checkout: 'Sign in to continue to checkout.',
      account: 'Sign in to continue to your account.',
      welcome: 'Sign in to continue to getting started.',
    };
    for (const [key, line] of Object.entries(lines)) {
      expect(await render({ for: key }), key).toContain(`</h1><p>${line}</p>`);
    }
  });

  it('shows none for an unknown or missing value', async () => {
    for (const value of ['', 'pricing', '/account', 'https://evil.example', '__proto__', '<script>']) {
      expect(await render({ for: value }), value).not.toContain('Sign in to continue');
    }
    expect(await render()).not.toContain('Sign in to continue');
  });
});

describe('signup expired link', () => {
  it('shows a styled message inside the site layout, above the form', async () => {
    const page = await SignupPage({ searchParams: Promise.resolve({ signup: 'expired' }) });
    const body = main(renderToStaticMarkup(RootLayout({ children: page })));
    const status = '<p role="status">This sign-in link is no longer valid. Request a new one.</p>';
    expect(body).toMatch(/^<section aria-label="Sign in">/);
    expect(body).toContain(status);
    expect(body.indexOf(status)).toBeLessThan(body.indexOf('<form'));
    expect(rules).toMatch(/section\[aria-label='Sign in'\] p\[role='status'\] \{[^}]*border:[^}]*background:/);
  });
});

describe('signin confirm page', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('SESSION_SECRET', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('uses the same sign-in layout as the signup page', async () => {
    const html = renderToStaticMarkup(await SigninPage({ searchParams: Promise.resolve({}) }));
    expect(html).toMatch(/^<section aria-label="Sign in"><h1>Sign in<\/h1>/);
  });
});

/** A browser-ish stand-in for the one form, email field and sessionStorage the script touches. */
function browser(storage: Map<string, string>) {
  const listeners: Array<() => void> = [];
  const email = { value: '' };
  const form = { addEventListener: (_: string, fn: () => void) => listeners.push(fn) };
  const document = { getElementById: (id: string) => ({ 'signup-form': form, 'signup-email': email })[id] ?? null };
  const sessionStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  };
  return {
    email,
    load: (html: string) => new Function('document', 'sessionStorage', script(html))(document, sessionStorage),
    submit: () => listeners.forEach((fn) => fn()),
  };
}

/** Types an address on a fresh page, submits, then loads the page the route redirects to. */
async function sendAndLandOn(outcome: string) {
  const storage = new Map<string, string>();
  const first = browser(storage);
  first.load(await render());
  first.email.value = 'ada@example.com';
  first.submit();
  const next = browser(storage);
  next.load(await render({ signup: outcome }));
  return { email: next.email.value, storage };
}

describe('signup email field', () => {
  it('keeps the typed email after a refused or failed send', async () => {
    for (const outcome of ['invalid', 'unavailable', 'failed']) {
      const { email, storage } = await sendAndLandOn(outcome);
      expect(email, outcome).toBe('ada@example.com');
      expect(storage.size, outcome).toBe(0);
    }
  });

  it('starts empty after a send, and after an expired link or an unknown outcome', async () => {
    for (const outcome of ['sent', 'expired', '<script>']) {
      const { email, storage } = await sendAndLandOn(outcome);
      expect(email, outcome).toBe('');
      expect(storage.size, outcome).toBe(0);
    }
  });

  it('writes nothing from the request into the script', async () => {
    const plain = script(await render({ signup: 'invalid' }));
    expect(script(await render({ signup: 'invalid', for: 'checkout' }))).toBe(plain);
    expect(script(await render({ for: '</script><script>alert(1)' }))).not.toContain('alert');
  });
});

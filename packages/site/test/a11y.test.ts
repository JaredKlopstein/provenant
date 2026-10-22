import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import RootLayout from '../app/layout.js';
import HomePage from '../app/page.js';
import SignupPage from '../app/signup/page.js';
import EnterprisePage from '../app/enterprise/page.js';
import { CONTACT_OUTCOMES } from '../src/contact.js';
import { SIGNUP_OUTCOMES } from '../src/auth/email.js';

/**
 * #103: accessibility basics. A skip link is the first focusable element on every
 * page and jumps to <main>; an outcome about what was typed marks the field(s)
 * aria-invalid and describes them with the message; the :focus-visible rules from
 * #93 are kept. The automated axe run is separate (test-a11y/, #121).
 */

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');

/** Opening tags of the elements a keyboard reaches, in document order. */
const focusable = (html: string) =>
  [...html.matchAll(/<(a|button|input|select|textarea)\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => !/tabindex="-1"|type="hidden"/.test(tag));

const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

const signup = async (signup?: string) =>
  renderToStaticMarkup(await SignupPage({ searchParams: Promise.resolve(signup ? { signup } : {}) }));
const enterprise = async (contact?: string) =>
  renderToStaticMarkup(await EnterprisePage({ searchParams: Promise.resolve(contact ? { contact } : {}) }));

/** The form fields people fill in, by id. The honeypot is not one. */
const fieldTags = (html: string, ids: readonly string[]) =>
  ids.map((id) => new RegExp(`<(input|select|textarea)\\b[^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0] ?? '');

describe('skip link', () => {
  const html = renderToStaticMarkup(RootLayout({ children: HomePage() }));

  it('is the first focusable element on the page and points at #main', () => {
    const first = focusable(html)[0] ?? '';
    expect(first).toMatch(/^<a\b/);
    expect(attr(first, 'href')).toBe('#main');
    expect(attr(first, 'class')).toBe('skip-link');
    expect(html).toContain('>Skip to content</a>');
  });

  it('lands on <main>, which carries the id it points at, exactly once', () => {
    expect(html).toMatch(/<main id="main">/);
    expect(html.match(/\bid="main"/g)).toHaveLength(1);
  });

  it('comes before the header, so it is first on every page that uses the layout', () => {
    expect(html.indexOf('class="skip-link"')).toBeLessThan(html.indexOf('<header'));
  });

  it('is off screen until focused, then shown', () => {
    expect(rules).toMatch(/\.skip-link \{[^}]*position: absolute;[^}]*transform: translateY\(-200%\);/);
    expect(rules).toMatch(/\.skip-link:focus \{ transform: none; \}/);
    expect(rules).not.toMatch(/\.skip-link[^{]*\{[^}]*display: none/);
  });
});

describe('focus styles from #93', () => {
  it('keeps the :focus-visible rules unchanged', () => {
    expect(rules).toContain(':focus-visible { outline: 3px solid var(--color-focus); outline-offset: 2px; border-radius: 2px; }');
    expect(rules).toContain(
      'input:focus-visible, select:focus-visible, textarea:focus-visible { outline-offset: 0; border-color: var(--color-focus); }',
    );
  });
});

describe('signup: the email field and its outcome', () => {
  it('an invalid address marks the email field invalid and describes it with the message', async () => {
    const html = await signup('invalid');
    const [email] = fieldTags(html, ['signup-email']);
    expect(attr(email!, 'aria-invalid')).toBe('true');
    const describedBy = attr(email!, 'aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(html).toMatch(new RegExp(`<p id="${describedBy}" role="status">That does not look like an email address`));
  });

  it.each(SIGNUP_OUTCOMES.filter((o) => o !== 'invalid'))('"%s" marks no field invalid', async (outcome) => {
    const [email] = fieldTags(await signup(outcome), ['signup-email']);
    expect(email).not.toMatch(/aria-invalid|aria-describedby/);
  });

  it('with no outcome, the field carries no error attributes', async () => {
    const [email] = fieldTags(await signup(), ['signup-email']);
    expect(email).not.toMatch(/aria-invalid|aria-describedby/);
  });
});

describe('enterprise: the contact fields and their outcome', () => {
  const FIELDS = ['contact-name', 'contact-email', 'contact-company', 'contact-fleet', 'contact-need'] as const;

  it('invalid details mark every visible field invalid and describe each with the message', async () => {
    const html = await enterprise('invalid');
    const tags = fieldTags(html, FIELDS);
    const ids = new Set(tags.map((t) => attr(t, 'aria-describedby')));
    for (const tag of tags) expect(attr(tag, 'aria-invalid'), tag).toBe('true');
    expect(ids.size).toBe(1);
    const [id] = [...ids];
    expect(html).toMatch(new RegExp(`<p id="${id}" role="status">Some details were missing or not valid`));
  });

  it('never marks the honeypot', async () => {
    const [honeypot] = fieldTags(await enterprise('invalid'), ['contact-website']);
    expect(honeypot).not.toMatch(/aria-invalid|aria-describedby/);
  });

  it.each(CONTACT_OUTCOMES.filter((o) => o !== 'invalid'))('"%s" marks no field invalid', async (outcome) => {
    for (const tag of fieldTags(await enterprise(outcome), FIELDS)) {
      expect(tag).not.toMatch(/aria-invalid|aria-describedby/);
    }
  });
});

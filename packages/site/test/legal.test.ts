import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import TermsPage, { metadata as termsMetadata } from '../app/terms/page.js';
import PrivacyPage, { metadata as privacyMetadata } from '../app/privacy/page.js';
import { GET as securityTxt } from '../app/.well-known/security.txt/route.js';
import RootLayout from '../app/layout.js';
import HomePage from '../app/page.js';
import { LegalNotice } from '../src/legal-notice.js';
import { LEGAL, REQUIRED_FACTS, fact, missingFacts, type LegalFacts } from '../src/legal.js';
import { buildSecurityTxt } from '../src/security-txt.js';

/**
 * #96 (draft): Terms, Privacy, the footer's legal links and security.txt. The
 * owner supplies the entity and contact facts in src/legal.ts; until then the
 * pages say they are a draft and show bracketed placeholders, and security.txt
 * is not published. Nothing here may invent a name, address or email.
 */

const FILLED: LegalFacts = {
  entityName: 'Example Labs LLC',
  entityJurisdiction: 'a Delaware limited liability company',
  contactEmail: 'hello@example.test',
  securityEmail: 'security@example.test',
  postalAddress: null,
  effectiveDate: '2026-11-01',
  refundWindowDays: 14,
  governingLaw: 'the laws of the State of Delaware',
  emailProvider: 'Example Mail',
  contactRetention: '12 months',
  bundleRetention: '12 months',
  mailboxProvider: 'Example Mailbox',
};

const terms = () => renderToStaticMarkup(TermsPage());
const privacy = () => renderToStaticMarkup(PrivacyPage());

describe('owner-supplied facts', () => {
  it('ship empty: no entity, address or email is invented', () => {
    for (const value of Object.values(LEGAL)) expect(value).toBeNull();
    expect(missingFacts()).toEqual([...REQUIRED_FACTS]);
  });

  it('render as a bracketed placeholder until set, then as the value', () => {
    expect(fact('entityName')).toBe('[legal entity name: owner to supply]');
    expect(fact('entityName', FILLED)).toBe('Example Labs LLC');
    expect(missingFacts(FILLED)).toEqual([]);
  });

  it('the postal address is optional', () => {
    expect(REQUIRED_FACTS).not.toContain('postalAddress');
  });
});

describe('Terms and Privacy pages', () => {
  it.each([
    ['Terms', terms, termsMetadata],
    ['Privacy', privacy, privacyMetadata],
  ] as const)('%s says it is a draft not in effect while facts are missing, with placeholders', (title, render, meta) => {
    const html = render();
    expect(meta.title).toBe(title);
    expect(html).toMatch(/Draft, not yet in effect\./);
    expect(html).toContain('[legal entity name: owner to supply]');
    expect(html).toContain('[contact email: owner to supply]');
    expect(html).not.toMatch(/Effective \d{4}-\d{2}-\d{2}/);
  });

  it('the notice switches to the effective date once every required fact is supplied', () => {
    const filled = renderToStaticMarkup(LegalNotice({ facts: FILLED }));
    expect(filled).toBe('<p>Effective 2026-11-01.</p>');
    expect(renderToStaticMarkup(LegalNotice({ facts: { ...FILLED, contactEmail: null } }))).toContain('Draft, not yet in effect');
  });

  it('Terms cover refunds and cancellation, and state what a receipt does not prove', () => {
    const html = terms();
    expect(html).toContain('<h2>Refunds and cancellation</h2>');
    expect(html).toContain('[refund window in days: owner to supply]');
    expect(html).toMatch(/cancelled at any time in the billing portal/);
    expect(html).toMatch(/does not show that an\s+action happened as described/);
  });

  it('Privacy says a bundle buyer\'s chain file is received, never a key, kept for an owner-set period (D5)', () => {
    const html = privacy();
    expect(html).toContain('Your chain file, if you buy an evidence bundle.');
    expect(html).toContain('It never holds a signing key, and we never ask for one.');
    expect(html).toContain('[chain file and bundle retention: owner to supply]');
    expect(html).toContain('[mailbox provider for chain files: owner to supply]');
    expect(html).toContain('We receive them only if you send us your chain file');
    expect(html).not.toContain('we never receive them');
    expect(REQUIRED_FACTS).toContain('bundleRetention');
    expect(REQUIRED_FACTS).toContain('mailboxProvider');
  });

  it('Privacy names what is collected, the processors, and the one essential cookie', () => {
    const html = privacy();
    for (const processor of ['Vercel', 'Neon', 'Stripe']) expect(html).toContain(processor);
    expect(html).toContain('[sign-in email provider: owner to supply]');
    expect(html).toMatch(/No analytics or advertising cookies/);
    expect(html).toMatch(/One essential cookie keeps you signed in for up to seven days/);
  });

  it('carry no price, so pricing stays in one place', () => {
    for (const file of ['../app/terms/page.tsx', '../app/privacy/page.tsx']) {
      expect(readFileSync(new URL(file, import.meta.url), 'utf8'), file).not.toMatch(/\$\d/);
    }
  });
});

describe('footer and checkout links', () => {
  const html = renderToStaticMarkup(RootLayout({ children: HomePage() }));
  const legalNav = /<nav aria-label="Legal">([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';

  it('every page footer links Terms, Privacy and Contact', () => {
    expect(legalNav).toContain('href="/terms">Terms</a>');
    expect(legalNav).toContain('href="/privacy">Privacy</a>');
    expect(legalNav).toMatch(/>Contact<\/a>/);
  });

  it('Contact goes to the enterprise contact form until a contact email is set', () => {
    expect(legalNav).toContain('href="/enterprise">Contact</a>');
  });

  it('checkout links the Terms and the Privacy Policy', () => {
    const src = readFileSync(new URL('../app/checkout/page.tsx', import.meta.url), 'utf8');
    expect(src).toContain('<Link href={TERMS_PATH}>Terms</Link>');
    expect(src).toContain('<Link href={PRIVACY_PATH}>Privacy Policy</Link>');
  });
});

describe('/.well-known/security.txt', () => {
  it('is not published while no security contact is set', async () => {
    const res = securityTxt();
    expect(res.status).toBe(404);
    expect(await res.text()).not.toMatch(/Contact:/);
  });

  it('once set, has the RFC 9116 Contact and an Expires under a year ahead', () => {
    const now = new Date('2026-11-01T00:00:00Z');
    const body = buildSecurityTxt(FILLED, now)!;
    expect(body).toContain('Contact: mailto:security@example.test\n');
    const expires = /^Expires: (\S+)$/m.exec(body)?.[1] ?? '';
    expect(expires).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const days = (Date.parse(expires) - now.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(0);
    expect(days).toBeLessThan(365);
  });
});

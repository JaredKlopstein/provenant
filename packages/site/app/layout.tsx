import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BRAND } from '../src/brand';
import { FONT_VARIABLES } from '../src/fonts';
import { NavMenu } from '../src/nav-menu';
import { GETTING_STARTED_URL } from '../src/plans';
import { SiteFooter } from '../src/site-footer';
import './globals.css';

export const metadata: Metadata = {
  // Pages set a short title; the template appends the brand. The home page sets none
  // and gets the default.
  title: {
    default: `${BRAND.name}: ${BRAND.tagline}`,
    template: `%s · ${BRAND.name}`,
  },
  description: `${BRAND.name}: ${BRAND.tagline}.`,
};

// The layout never reads the session (or imports auth code), so every page stays
// statically rendered. Sign in goes to the signup page (SIGNUP_PATH, pinned by
// test/styles.test.ts), which signs in or creates an account; /signin is only the
// emailed-link confirmation and is useless without its token.
const NAV = [
  { href: '/how-it-works', label: 'How it works' },
  { href: '/verify', label: 'Verify' },
  { href: '/security', label: 'Security' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/enterprise', label: 'Enterprise' },
  { href: '/signup', label: 'Sign in', kind: 'action' },
  { href: GETTING_STARTED_URL, label: 'Start free', kind: 'cta' },
] as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={FONT_VARIABLES}>
      <body>
        {/* The first focusable element on every page: keyboard users can skip the header and nav. */}
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="site-header">
          <div className="site-header-inner">
            <Link href="/" className="site-brand">
              {/* The favicon's mark: a receipt with a check. The name beside it is the label. */}
              <svg aria-hidden="true" focusable="false" width="28" height="28" viewBox="0 0 32 32">
                <rect className="mark-seal" width="32" height="32" rx="7" />
                <path className="mark-paper" d="M9 6.5h14v19l-2.33-1.5-2.34 1.5-2.33-1.5-2.33 1.5-2.34-1.5L9 25.5z" />
                <path className="mark-check" d="M12.25 15.75l2.5 2.5 5-5" />
              </svg>
              {BRAND.name}
            </Link>
            <NavMenu items={NAV} />
          </div>
        </header>
        <main id="main">{children}</main>
        <footer>
          <SiteFooter />
        </footer>
      </body>
    </html>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BRAND } from '../src/brand';
import { NavMenu } from '../src/nav-menu';
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

const NAV = [
  { href: '/', label: 'Home' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/how-it-works', label: 'How it works' },
  { href: '/verify', label: 'Verify' },
  { href: '/security', label: 'Security' },
  { href: '/enterprise', label: 'Enterprise' },
  // A static link: /account itself redirects a signed-out visitor to sign up, so
  // the layout never reads the session and every page stays statically rendered.
  { href: '/account', label: 'Account' },
] as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* The first focusable element on every page: keyboard users can skip the header and nav. */}
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="site-header">
          <div className="site-header-inner">
            <Link href="/" className="site-brand">
              {BRAND.name}
            </Link>
            <NavMenu items={NAV} />
          </div>
        </header>
        <main id="main">{children}</main>
        <footer>
          <p>
            {BRAND.name}: {BRAND.tagline}. <a href={BRAND.repository}>Source on GitHub</a>.
          </p>
        </footer>
      </body>
    </html>
  );
}

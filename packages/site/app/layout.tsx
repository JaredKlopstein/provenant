import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BRAND } from '../src/brand';

export const metadata: Metadata = {
  title: `${BRAND.name}: ${BRAND.tagline}`,
  description: `${BRAND.name}: ${BRAND.tagline}.`,
};

const NAV = [
  { href: '/', label: 'Home' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/how-it-works', label: 'How it works' },
  { href: '/verify', label: 'Verify' },
  { href: '/security', label: 'Security' },
  { href: '/enterprise', label: 'Enterprise' },
] as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <nav aria-label="Main">
            <ul>
              {NAV.map((item) => (
                <li key={item.href}>
                  <Link href={item.href}>{item.label}</Link>
                </li>
              ))}
            </ul>
          </nav>
        </header>
        <main>{children}</main>
        <footer>
          <p>
            {BRAND.name}: {BRAND.tagline}. <a href={BRAND.repository}>Source on GitHub</a>.
          </p>
        </footer>
      </body>
    </html>
  );
}

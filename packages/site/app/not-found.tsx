import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '../src/brand';

export const metadata: Metadata = {
  title: `Page not found: ${BRAND.name}`,
};

// The root not-found handles every unmatched URL. Next renders it inside the root
// layout and answers with HTTP 404, so the nav and footer stay and readers have a way back.
const WAYS_BACK = [
  { href: '/', label: 'Home' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/verify', label: 'Verify' },
] as const;

export default function NotFound() {
  return (
    <section>
      <h1>Page not found</h1>
      <p>There is no page at this address. It may have moved, or the link may be mistyped.</p>
      <ul>
        {WAYS_BACK.map((item) => (
          <li key={item.href}>
            <Link href={item.href}>{item.label}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

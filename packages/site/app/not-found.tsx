import type { Metadata } from 'next';
import Link from 'next/link';

// The root layout's title template appends the brand.
export const metadata: Metadata = {
  title: 'Page not found',
};

// Next renders this inside the root layout, with HTTP 404, for every URL no page or
// route matches. It sets no status itself.
const WAYS_BACK = [
  { href: '/', label: 'Home' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/verify', label: 'Verify a bundle' },
] as const;

export default function NotFound() {
  return (
    <section aria-label="Page not found">
      <h1>Page not found</h1>
      <p>There is no page at this address. It may have moved, or the link may be mistyped.</p>
      <ul>
        {WAYS_BACK.map((link) => (
          <li key={link.href}>
            <Link href={link.href}>{link.label}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

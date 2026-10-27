import Link from 'next/link';
import { BRAND } from './brand';
import { LEGAL, PRIVACY_PATH, TERMS_PATH } from './legal';
import { EARLY_ACCESS_LABEL, GETTING_STARTED_URL, OFF_SALE_PLANS } from './plans';
import styles from './site-footer.module.css';

type FooterLink = { readonly href: string; readonly label: string };

const PRODUCT: readonly FooterLink[] = [
  { href: '/how-it-works', label: 'How it works' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/security', label: 'Security' },
  { href: '/enterprise', label: 'Enterprise' },
];

const DEVELOPERS: readonly FooterLink[] = [
  { href: GETTING_STARTED_URL, label: 'Getting started (GitHub)' },
  { href: '/verify', label: 'Verify a bundle' },
  { href: BRAND.repository, label: 'Source on GitHub' },
];

// Cloud is described as early access for as long as it is off sale.
const CLOUD_STATUS = OFF_SALE_PLANS.has('cloud') ? EARLY_ACCESS_LABEL.toLowerCase() : 'available';

function Links({ items }: { items: readonly FooterLink[] }) {
  return (
    <ul>
      {items.map((item) => (
        <li key={item.href}>
          <Link href={item.href}>{item.label}</Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * The site footer, rendered inside the root layout's <footer>: four columns
 * (Product, Developers, Project, Status), then the legal links exactly as #96
 * ships them, then the name, tagline and disclaimer.
 */
export function SiteFooter() {
  return (
    <div className={styles.footer}>
      <div className={styles.columns}>
        <div>
          <h2 className={styles.heading}>Product</h2>
          <Links items={PRODUCT} />
        </div>
        <div>
          <h2 className={styles.heading}>Developers</h2>
          <Links items={DEVELOPERS} />
        </div>
        <div>
          <h2 className={styles.heading}>Project</h2>
          <p>
            {BRAND.name} Core and the verifier are MIT-licensed. Cloud is commercial.
          </p>
        </div>
        <div>
          <h2 className={styles.heading}>Status</h2>
          <p>
            Core and verifier: run from source. Cloud: {CLOUD_STATUS}.
          </p>
        </div>
      </div>
      <div className={styles.base}>
        <nav aria-label="Legal">
          <Link href={TERMS_PATH}>Terms</Link> · <Link href={PRIVACY_PATH}>Privacy</Link> ·{' '}
          {LEGAL.contactEmail ? (
            <a href={`mailto:${LEGAL.contactEmail}`}>Contact</a>
          ) : (
            <Link href="/enterprise">Contact</Link>
          )}
        </nav>
        {/* #113: the legal entity and contact line goes here once the owner supplies it. */}
        <p>
          {BRAND.name} · {BRAND.tagline} · Not legal advice.
        </p>
      </div>
    </div>
  );
}

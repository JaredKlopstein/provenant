import { BRAND } from './brand';
import styles from './hero.module.css';

/** The open standards the receipts and anchors are built on. Names only: no logos, customers or counts. */
export const STANDARDS = ['RFC 8785', 'SHA-256', 'Ed25519', 'RFC 9421', 'RFC 3161'] as const;

/** The strip under the home hero: the standards, the licence, and the source. */
export function StandardsStrip() {
  return (
    <section aria-label="Built on open standards" className={styles.strip}>
      <h2 className="eyebrow">Built on open standards</h2>
      <ul className={styles.standards}>
        {STANDARDS.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
      <p className={styles.stripNote}>
        MIT-licensed core and verifier · <a href={BRAND.repository}>Source on GitHub</a>
      </p>
    </section>
  );
}

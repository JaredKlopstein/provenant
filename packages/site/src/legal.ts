/**
 * The facts the Terms, the Privacy Policy, the footer and security.txt need,
 * which only the owner can supply. Every value starts null; nothing here is
 * invented. While any required value is null, /terms and /privacy say they are a
 * draft not yet in effect and show a bracketed placeholder in each gap, and
 * /.well-known/security.txt answers 404 rather than publish a placeholder contact.
 *
 * The page text describes only what the site actually does with data (see the
 * Privacy Policy). Owner and counsel review it before it takes effect.
 */
export interface LegalFacts {
  /** The legal entity that runs the service, e.g. "Example Labs LLC". */
  readonly entityName: string | null;
  /** Its form and jurisdiction, e.g. "a Texas limited liability company". */
  readonly entityJurisdiction: string | null;
  /** Public contact address for customers. */
  readonly contactEmail: string | null;
  /** Address for security reports, used by security.txt. */
  readonly securityEmail: string | null;
  /** Optional postal address, shown in the Terms and Privacy Policy when set. */
  readonly postalAddress: string | null;
  /** When the Terms and Privacy Policy take effect, as YYYY-MM-DD. */
  readonly effectiveDate: string | null;
  /** Days after purchase in which a refund can be requested, or 0 for none. */
  readonly refundWindowDays: number | null;
  /** Governing law and venue, e.g. "the laws of the State of Texas". */
  readonly governingLaw: string | null;
  /** The email provider that delivers sign-in links, named in the Privacy Policy. */
  readonly emailProvider: string | null;
  /** How long contact-form messages are kept, e.g. "12 months". */
  readonly contactRetention: string | null;
  /** How long a bundle buyer's chain file and the bundle made from it are kept, e.g. "12 months". */
  readonly bundleRetention: string | null;
  /** The mailbox provider whose inbox receives chain files by email, named in the Privacy Policy. */
  readonly mailboxProvider: string | null;
}

export const LEGAL: LegalFacts = {
  entityName: null,
  entityJurisdiction: null,
  contactEmail: null,
  securityEmail: null,
  postalAddress: null,
  effectiveDate: null,
  refundWindowDays: null,
  governingLaw: null,
  emailProvider: null,
  contactRetention: null,
  bundleRetention: null,
  mailboxProvider: null,
};

/** Facts the documents cannot take effect without. The postal address is optional. */
export const REQUIRED_FACTS = [
  'entityName',
  'entityJurisdiction',
  'contactEmail',
  'securityEmail',
  'effectiveDate',
  'refundWindowDays',
  'governingLaw',
  'emailProvider',
  'contactRetention',
  'bundleRetention',
  'mailboxProvider',
] as const satisfies readonly (keyof LegalFacts)[];

export const TERMS_PATH = '/terms';
export const PRIVACY_PATH = '/privacy';

/** The required facts still missing, by name. Empty once the owner has filled them all. */
export function missingFacts(facts: LegalFacts = LEGAL): (keyof LegalFacts)[] {
  return REQUIRED_FACTS.filter((key) => facts[key] === null);
}

/** A fact's value, or a bracketed placeholder naming what the owner must supply. */
export function fact(key: keyof LegalFacts, facts: LegalFacts = LEGAL): string {
  const value = facts[key];
  return value === null ? `[${PLACEHOLDERS[key]}]` : String(value);
}

const PLACEHOLDERS: Record<keyof LegalFacts, string> = {
  entityName: 'legal entity name: owner to supply',
  entityJurisdiction: 'entity form and jurisdiction: owner to supply',
  contactEmail: 'contact email: owner to supply',
  securityEmail: 'security contact email: owner to supply',
  postalAddress: 'postal address: optional, owner to supply',
  effectiveDate: 'effective date: owner to supply',
  refundWindowDays: 'refund window in days: owner to supply',
  governingLaw: 'governing law and venue: owner to supply',
  emailProvider: 'sign-in email provider: owner to supply',
  contactRetention: 'contact message retention: owner to supply',
  bundleRetention: 'chain file and bundle retention: owner to supply',
  mailboxProvider: 'mailbox provider for chain files: owner to supply',
};

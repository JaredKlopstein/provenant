import { LEGAL, type LegalFacts } from './legal';

/** How long a published security.txt stays valid. RFC 9116 advises under a year. */
const VALID_DAYS = 180;

/**
 * The security.txt body (RFC 9116), or null while the owner has not supplied a
 * security contact. Contact and Expires are the two required fields.
 */
export function buildSecurityTxt(facts: LegalFacts = LEGAL, now: Date = new Date()): string | null {
  if (!facts.securityEmail) return null;
  const expires = new Date(now.getTime() + VALID_DAYS * 24 * 60 * 60 * 1000);
  return [
    `Contact: mailto:${facts.securityEmail}`,
    `Expires: ${expires.toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
    'Preferred-Languages: en',
    '',
  ].join('\n');
}

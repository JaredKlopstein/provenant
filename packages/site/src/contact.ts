/**
 * What the enterprise page's form and the contact route agree on. It lives here
 * because Next.js allows a page or route file to export only its own fields.
 */

export const CONTACT_PATH = '/api/contact';

/** The fleet-size choices the form offers. The route rejects anything else. */
export const FLEET_SIZES = ['1-10', '11-100', '101-1000', 'More than 1000'] as const;
export type FleetSize = (typeof FLEET_SIZES)[number];

/** The hidden field a person never sees and a form-filling bot often fills. */
export const HONEYPOT_FIELD = 'website';

/** After a form post the route redirects to `/enterprise?contact=<outcome>`. */
export const CONTACT_OUTCOMES = ['sent', 'invalid', 'unavailable', 'failed', 'rate_limited'] as const;
export type ContactOutcome = (typeof CONTACT_OUTCOMES)[number];

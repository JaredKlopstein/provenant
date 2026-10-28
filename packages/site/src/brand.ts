/**
 * The site's brand, in one place.
 *
 * Page copy and metadata read the name, tagline and repository from here and
 * never hard-code them. `domain` stays null until the owner attaches one; until
 * then links build from SITE_BASE_URL/VERCEL_URL.
 */
export interface Brand {
  readonly name: string;
  readonly domain: string | null;
  readonly tagline: string;
  /** Source repository. Its path carries the name, so it lives here too. */
  readonly repository: string;
}

export const BRAND: Brand = {
  name: 'Lacre',
  domain: null,
  tagline: 'tamper-evident receipts for autonomous agents',
  repository: 'https://github.com/JaredKlopstein/lacre',
};

/**
 * The site's brand, in one place.
 *
 * Name, domain and tagline are placeholders until the rename lands. Page copy and
 * metadata read them from here and never hard-code them, so the rename is a
 * one-line change. `domain` stays null until the owner attaches one.
 */
export interface Brand {
  readonly name: string;
  readonly domain: string | null;
  readonly tagline: string;
  /** Source repository. Its path carries the name, so it lives here too. */
  readonly repository: string;
}

export const BRAND: Brand = {
  name: 'Provenant',
  domain: null,
  tagline: 'tamper-evident receipts for autonomous agents',
  repository: 'https://github.com/JaredKlopstein/provenant',
};

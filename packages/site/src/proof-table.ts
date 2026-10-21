/**
 * What a self-hosted (local) chain does and does not prove, next to an anchored one.
 *
 * Shown on both the home page and the security page. Both import it from here, so
 * the two can't drift.
 */
export const PROOF_TABLE = [
  { property: 'Detects casual tampering', local: 'yes', anchored: 'yes' },
  { property: 'Detects a full rebuild by the operator', local: 'no', anchored: 'yes' },
  { property: 'Detects backdating after the anchor', local: 'no', anchored: 'yes' },
  { property: 'Detects truncation of the un-anchored tail', local: 'no', anchored: 'no' },
] as const;

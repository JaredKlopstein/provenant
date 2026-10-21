import { ImageResponse } from 'next/og';
import { BRAND } from '../src/brand';

// The share image for every page (Next's opengraph-image convention). Next also
// fills og:title/description from each page's own metadata and copies the image,
// title and description into the Twitter card, so layout.tsx needs no fields for it.
// Every word comes from BRAND; no prices, no customer data.
export const alt = `${BRAND.name}: ${BRAND.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// The same colours as app/globals.css (--color-accent, --color-text, --color-muted, --color-bg).
const ACCENT = '#0b57d0';
const TEXT = '#1b1f24';
const MUTED = '#57606a';
const BG = '#ffffff';

const PROOF = 'Signed · hash-chained · RFC 3161 anchored · verifiable offline';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          background: BG,
          color: TEXT,
          borderTop: `16px solid ${ACCENT}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', fontSize: 44 }}>
          <svg width="64" height="64" viewBox="0 0 32 32" style={{ marginRight: 24 }}>
            <rect width="32" height="32" rx="7" fill={ACCENT} />
            <path d="M9 6.5h14v19l-2.33-1.5-2.34 1.5-2.33-1.5-2.33 1.5-2.34-1.5L9 25.5z" fill={BG} />
            <path d="M12.25 15.75l2.5 2.5 5-5" fill="none" stroke={ACCENT} strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {BRAND.name}
        </div>
        <div style={{ display: 'flex', fontSize: 72, lineHeight: 1.1, maxWidth: 1000 }}>{BRAND.tagline}</div>
        <div style={{ display: 'flex', fontSize: 30, color: MUTED }}>{PROOF}</div>
      </div>
    ),
    size,
  );
}

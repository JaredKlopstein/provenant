import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Serif } from 'next/font/google';

/*
 * IBM Plex, loaded with Next's built-in Google font loader. The files are
 * downloaded at build time and served from this site, so no request goes to
 * Google (CSP font-src stays 'self'). Each font sets a CSS variable that
 * app/globals.css reads in --font-serif, --font-sans and --font-mono.
 *
 * This lives in its own module because the tests render app/layout.tsx directly,
 * where the loader (a build-time transform) cannot run; they stub this file.
 */

const serif = IBM_Plex_Serif({
  subsets: ['latin'],
  weight: ['500', '600'],
  display: 'swap',
  variable: '--font-plex-serif',
});

const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-plex-sans',
});

// Mono sets short labels (eyebrows, hashes) whose line breaks change when the
// font swaps in late, which moved the home hero by ~19px on a slow phone (CLS).
// 'optional' keeps the fallback for that page view instead; Plex Mono is then
// cached for the next one.
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'optional',
  variable: '--font-plex-mono',
});

/** Class names for <html>: each one defines its font's CSS variable. */
export const FONT_VARIABLES = [serif.variable, sans.variable, mono.variable].join(' ');

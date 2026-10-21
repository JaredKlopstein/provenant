import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import OpengraphImage, { alt, contentType, size } from '../app/opengraph-image.js';
import { BRAND } from '../src/brand.js';

/**
 * #102: the favicon and the share image behind every page's Open Graph and Twitter
 * tags. Next's file conventions do the wiring: app/icon.svg becomes the favicon
 * link, and app/opengraph-image.tsx becomes og:image. Next then fills og:title and
 * og:description from each page's own metadata, and copies title, description and
 * image into a summary_large_image Twitter card. These tests pin the two files and
 * guard that inheritance.
 */

const APP = new URL('../app/', import.meta.url).pathname;
const source = (file: string) => readFileSync(join(APP, file), 'utf8');

describe('share image (app/opengraph-image.tsx)', () => {
  it('is a 1200x630 PNG described by alt text from BRAND', () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe('image/png');
    expect(alt).toBe(`${BRAND.name}: ${BRAND.tagline}`);
  });

  it('renders a PNG of exactly that size', async () => {
    const res = OpengraphImage();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    // The IHDR chunk follows the signature: width and height, big-endian, at bytes 16 and 20.
    expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }).toEqual(size);
  }, 30_000);

  it('takes its words from BRAND and shows no price or customer data', () => {
    const src = source('opengraph-image.tsx');
    expect(src).toContain('BRAND.name');
    expect(src).toContain('BRAND.tagline');
    expect(src).not.toMatch(/\$\d|@[a-z0-9-]+\.[a-z]{2,}|cus_|acct_/i);
  });

  it('uses the colours of app/globals.css', () => {
    const css = source('globals.css');
    const token = (name: string) => css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
    const src = source('opengraph-image.tsx');
    for (const [name, constant] of [['accent', 'ACCENT'], ['text', 'TEXT'], ['muted', 'MUTED'], ['bg', 'BG']] as const) {
      expect(src, name).toContain(`const ${constant} = '${token(name)}'`);
    }
  });
});

describe('favicon (app/icon.svg)', () => {
  const svg = source('icon.svg');

  it('is a small, self-contained SVG with a viewBox', () => {
    expect(svg.trim()).toMatch(/^<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*viewBox="0 0 32 32"/);
    expect(svg.trim().endsWith('</svg>')).toBe(true);
    expect(Buffer.byteLength(svg)).toBeLessThan(4 * 1024);
  });

  it('loads nothing external and runs nothing', () => {
    expect(svg).not.toMatch(/<script|<image|<foreignObject|href=|url\(|on[a-z]+=/i);
  });

  it('carries no brand text, so a rename leaves it valid', () => {
    expect(svg).not.toMatch(new RegExp(BRAND.name, 'i'));
    expect(svg).not.toMatch(/<text\b/);
  });
});

describe('every page inherits the share image', () => {
  it('no layout or page sets its own Open Graph or Twitter images, which would replace it', () => {
    const files = readdirSync(APP, { recursive: true, encoding: 'utf8' }).filter(
      (f) => /\.(tsx?|jsx?)$/.test(f) && f !== 'opengraph-image.tsx',
    );
    const overriding = files.filter((f) => /\b(openGraph|twitter)\s*:\s*\{[^}]*\bimages\b/s.test(source(f)));
    expect(overriding).toEqual([]);
    // A per-route image file would replace it for that route only; there should be one, at the root.
    expect(readdirSync(APP, { recursive: true, encoding: 'utf8' }).filter((f) => /(^|\/)(opengraph|twitter)-image\./.test(f))).toEqual([
      'opengraph-image.tsx',
    ]);
  });
});

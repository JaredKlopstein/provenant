import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config.js';

/**
 * Security headers from next.config.ts. The policy is the one #173 specifies.
 * HSTS is absent on purpose: Vercel sets it, and this config must not.
 */

const DIRECTIVES: Record<string, string> = {
  'default-src': "'self'",
  'script-src': "'self' 'unsafe-inline'",
  'style-src': "'self' 'unsafe-inline'",
  'img-src': "'self' data:",
  'font-src': "'self'",
  'connect-src': "'self'",
  'frame-ancestors': "'none'",
  'base-uri': "'none'",
  'object-src': "'none'",
  'form-action': "'self' https://checkout.stripe.com https://billing.stripe.com",
};

const HEADERS: Record<string, string> = {
  'Content-Security-Policy': Object.entries(DIRECTIVES)
    .map(([name, value]) => `${name} ${value}`)
    .join('; '),
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

/** Directive name to its value. A trailing semicolon, if one appears, yields an empty part and is ignored. */
function directives(policy: string): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const part of policy.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(' ');
    const name = space === -1 ? trimmed : trimmed.slice(0, space);
    parsed.set(name, space === -1 ? '' : trimmed.slice(space + 1));
  }
  return parsed;
}

describe('security headers', () => {
  it('sets CSP, frame denial, nosniff, Referrer-Policy and Permissions-Policy on every route', async () => {
    expect(nextConfig.headers).toEqual(expect.any(Function));
    const rules = await nextConfig.headers!();
    expect(rules.map((rule) => rule.source)).toEqual(['/:path*']);

    const rule = rules[0];
    expect(rule).toBeDefined();
    const headers = new Map(rule!.headers.map((header) => [header.key, header.value]));

    expect([...headers.keys()]).toEqual(Object.keys(HEADERS));
    expect(Object.fromEntries(headers)).toEqual(HEADERS);
    expect(headers.has('Strict-Transport-Security')).toBe(false);

    const parsed = directives(headers.get('Content-Security-Policy')!);
    expect([...parsed.keys()]).toEqual(Object.keys(DIRECTIVES));
    for (const [name, value] of Object.entries(DIRECTIVES)) {
      expect(parsed.get(name), name).toBe(value);
    }
    expect(parsed.get('frame-ancestors')).toBe("'none'");
    expect(parsed.get('form-action')).toContain('https://checkout.stripe.com');
    expect(parsed.get('form-action')).toContain('https://billing.stripe.com');
  });
});

import type { NextConfig } from 'next';

/**
 * Security headers on every route. Vercel sets HSTS; this file does not.
 *
 * What the browser loads today, and why the policy is shaped this way:
 * - Scripts are Next's own bundles under `/_next` plus its inline bootstrap,
 *   and one inline script on `/signup` that restores the typed email from
 *   sessionStorage. There is no Stripe.js, analytics, or other third-party
 *   script. `'unsafe-inline'` covers those inline scripts without a nonce.
 *   A nonce policy needs per-request middleware and is a follow-up.
 * - Styles are `app/globals.css` from this origin, plus one inline `style`
 *   on the enterprise honeypot.
 * - Images are `app/icon.svg` and the generated `/opengraph-image`. Nothing
 *   is loaded from another host. `data:` is allowed and unused.
 * - Fonts are the system stack in `globals.css` (`--font-sans`, `--font-mono`).
 *   No `@font-face`, no `next/font`, no font file. A later issue self-hosts
 *   fonts, so `font-src` stays `'self'` and does not name Google hosts.
 * - Connections are same-origin (the waitlist `fetch`, Next's own requests).
 *   Stripe and the email API are called from the server.
 * - Forms post to this origin. `POST /api/checkout` and `POST /api/account/portal`
 *   answer with a 303 to `https://checkout.stripe.com` or
 *   `https://billing.stripe.com`. Chrome checks that redirect against
 *   `form-action`, so those two hosts are listed. No Stripe custom domain
 *   is configured in this repo.
 *
 * `/signin` also sets `referrer: 'no-referrer'` in its page metadata, which
 * is stricter than the site-wide Referrer-Policy for that document.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
].join('; ');

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // `/:path*` is optional, so this matches `/` and every nested route.
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;

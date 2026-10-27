/**
 * /.well-known/security.txt (RFC 9116): where to report a security issue.
 *
 * It answers 404 until the owner sets LEGAL.securityEmail in src/legal.ts, so
 * the site never publishes a placeholder contact. Expires is required by the RFC
 * and is set 180 days after the build, so each deploy renews it.
 */
import { buildSecurityTxt } from '../../../src/security-txt';

export function GET(): Response {
  const body = buildSecurityTxt();
  if (!body) return new Response('No security contact is published yet.\n', { status: 404 });
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

import { cpSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import next from 'next';
import NotFound from '../app/not-found.js';

/**
 * #98: unknown URLs get the branded not-found page inside the site layout, with a
 * way back, and still answer HTTP 404. The status comes from Next itself, so a real
 * Next dev server serves the app. It runs on a copy in a temp directory, because Next
 * rewrites tsconfig.json and writes .next/ and next-env.d.ts into the directory it
 * serves. Requests go to 127.0.0.1 only.
 */

const SITE = new URL('..', import.meta.url).pathname;
let COPY: string;

function commonAncestor(a: string, b: string): string {
  const [x, y] = [a.split(sep), b.split(sep)];
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  return x.slice(0, i).join(sep) || sep;
}
const WAYS_BACK = [
  ['/', 'Home'],
  ['/pricing', 'Pricing'],
  ['/verify', 'Verify'],
] as const;

describe('not-found page', () => {
  it('links to Home, Pricing and Verify', () => {
    const html = renderToStaticMarkup(NotFound());
    expect(html).toContain('<h1>Page not found</h1>');
    for (const [href, label] of WAYS_BACK) expect(html).toContain(`<a href="${href}">${label}</a>`);
  });
});

describe('unknown routes', () => {
  let app: ReturnType<typeof next>;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    process.env.NEXT_TELEMETRY_DISABLED = '1';
    COPY = realpathSync(mkdtempSync(join(tmpdir(), 'site-not-found-')));
    for (const entry of ['app', 'src', 'package.json', 'tsconfig.json']) {
      cpSync(join(SITE, entry), join(COPY, entry), { recursive: true });
    }
    symlinkSync(join(SITE, 'node_modules'), join(COPY, 'node_modules'), 'dir');
    // The site's own next.config.ts is empty. Turbopack compiles nothing outside its
    // root, so the root has to hold both the copy and the workspace's node_modules.
    writeFileSync(
      join(COPY, 'next.config.ts'),
      `export default { turbopack: { root: ${JSON.stringify(commonAncestor(COPY, realpathSync(SITE)))} } };\n`,
    );
    app = next({ dev: true, dir: COPY, quiet: true });
    await app.prepare();
    const handle = app.getRequestHandler();
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await app?.close();
    if (COPY) rmSync(COPY, { recursive: true, force: true });
  });

  it.each(['/docs', '/no/such/page'])('%s answers 404 with the branded page inside the layout', async (path) => {
    const res = await fetch(base + path);
    const html = await res.text();
    expect(res.status).toBe(404);
    expect(html).toContain('<h1>Page not found</h1>');
    expect(html).toContain('<nav aria-label="Main">');
    expect(html).toContain('<footer>');
    const page = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));
    for (const [href, label] of WAYS_BACK) expect(page).toContain(`<a href="${href}">${label}</a>`);
  }, 60_000);
});

import { defineConfig, devices } from '@playwright/test';

// Automated axe check of the marketing site. Run with `pnpm --filter
// @lacre/site test:a11y`, which builds first; the web server below serves
// that prerendered build with `next start`. Specs live in test-a11y/, outside
// the root vitest include, so `pnpm run ci` never runs them.
const port = Number(process.env.A11Y_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'test-a11y',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `next start --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

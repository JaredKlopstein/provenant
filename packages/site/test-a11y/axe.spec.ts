import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// Runs axe against the built marketing pages (see playwright.config.ts) and
// fails on any serious or critical WCAG 2 A/AA violation, colour contrast
// included. Minor and moderate findings are reported but do not fail the run.
const pages = ['/', '/pricing', '/signup', '/enterprise', '/verify', '/security', '/how-it-works'] as const;

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const blockingImpacts = new Set(['serious', 'critical']);

for (const path of pages) {
  test(`${path} has no serious or critical axe violations`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response?.ok(), `GET ${path} should succeed`).toBe(true);

    const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze();

    const blocking = results.violations.filter((v) => blockingImpacts.has(v.impact ?? ''));
    const summary = blocking.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      targets: v.nodes.map((n) => n.target.join(' ')),
    }));

    expect(summary, `axe violations on ${path}`).toEqual([]);
  });
}

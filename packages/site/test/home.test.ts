import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import HomePage from '../app/page.js';
import { BRAND } from '../src/brand.js';

const html = renderToStaticMarkup(HomePage());

describe('home page', () => {
  it('labels the getting-started link as leaving the site for GitHub', () => {
    expect(html).toContain(
      `<a href="${BRAND.repository}/blob/main/docs/getting-started.md">Getting started (GitHub)</a>`,
    );
  });
});

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDb, LacreError } from '@lacre/core';
import { anchorTickStoreFromEnv } from '../src/anchor/tick-endpoint.js';
import { loadBillingConfig } from '../src/billing/config.js';

/**
 * Tests for the one-release PROVENANT_* fallback on the cloud side of the
 * helper. A live key with only the legacy billing mode still passes the guard;
 * a live key with neither name set is still refused.
 */

const u = (...parts: string[]) => parts.join('_');
const TEST_KEY = u('sk', 'test', 'x'.repeat(24));
const LIVE_KEY = u('sk', 'live', 'y'.repeat(24));

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stderrOf(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

describe('billing mode fallback', () => {
  it('accepts a live key when only PROVENANT_BILLING_MODE=live', () => {
    const lines = stderrOf(() => {
      const live = loadBillingConfig(
        { STRIPE_SECRET_KEY: LIVE_KEY, PROVENANT_BILLING_MODE: 'live' },
        ['stripe'],
      );
      expect(live.mode).toBe('live');
    });
    expect(lines.filter((line) => line.startsWith('warning:'))).toEqual([]);
  });

  it('still refuses a live key when neither billing-mode variable is set', () => {
    vi.stubEnv('LACRE_BILLING_MODE', 'live');
    vi.stubEnv('PROVENANT_BILLING_MODE', 'live');
    let err: unknown;
    try {
      loadBillingConfig({ STRIPE_SECRET_KEY: LIVE_KEY }, ['stripe']);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LacreError);
    const message = (err as LacreError).message;
    expect(message).toMatch(/LACRE_BILLING_MODE/);
    expect(message).toMatch(/not live/);
    expect(message).not.toContain(LIVE_KEY);
    expect(message).not.toContain('PROVENANT_');

    const empty = (() => {
      try {
        loadBillingConfig({ STRIPE_SECRET_KEY: LIVE_KEY, LACRE_BILLING_MODE: '', PROVENANT_BILLING_MODE: '' }, ['stripe']);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(empty).toBeInstanceOf(LacreError);

    const testKey = loadBillingConfig({ STRIPE_SECRET_KEY: TEST_KEY }, ['stripe']);
    expect(testKey.mode).toBe('test');
  });

  it('lets LACRE_BILLING_MODE win when it differs from PROVENANT_BILLING_MODE', () => {
    const lines = stderrOf(() => {
      expect(() => loadBillingConfig({
        STRIPE_SECRET_KEY: LIVE_KEY,
        LACRE_BILLING_MODE: 'test',
        PROVENANT_BILLING_MODE: 'live',
      }, ['stripe'])).toThrow(/LACRE_BILLING_MODE is not live/);
    });
    expect(lines).toContain(
      'warning: LACRE_BILLING_MODE and PROVENANT_BILLING_MODE are both set and differ; using LACRE_BILLING_MODE\n',
    );

    const agreed = stderrOf(() => {
      const live = loadBillingConfig({
        STRIPE_SECRET_KEY: LIVE_KEY,
        LACRE_BILLING_MODE: 'live',
        PROVENANT_BILLING_MODE: 'live',
      }, ['stripe']);
      expect(live.mode).toBe('live');
    });
    expect(agreed.filter((line) => line.startsWith('warning:'))).toEqual([]);
  });
});

describe('anchor tick env fallback', () => {
  it('opens the store from PROVENANT_HOME and the authority from PROVENANT_TSA_URL', () => {
    const home = mkdtempSync(join(tmpdir(), 'lacre-tick-legacy-'));
    roots.push(home);
    const lines = stderrOf(() => {
      const store = anchorTickStoreFromEnv({ PROVENANT_HOME: home, PROVENANT_TSA_URL: 'freetsa' });
      try {
        expect(existsSync(join(home, 'lacre.db'))).toBe(true);
        expect(store.backend.description).toContain('freetsa.org');
      } finally {
        closeDb(store.db);
      }
    });
    expect(lines.filter((line) => line.startsWith('warning:'))).toEqual([]);
  });

  it('lets LACRE_HOME and LACRE_TSA_URL beat the legacy names', () => {
    const root = mkdtempSync(join(tmpdir(), 'lacre-tick-both-'));
    roots.push(root);
    const next = join(root, 'next');
    const prev = join(root, 'prev');
    mkdirSync(next);
    mkdirSync(prev);
    const lines = stderrOf(() => {
      const store = anchorTickStoreFromEnv({
        LACRE_HOME: next,
        PROVENANT_HOME: prev,
        LACRE_TSA_URL: 'sectigo',
        PROVENANT_TSA_URL: 'freetsa',
      });
      try {
        expect(existsSync(join(next, 'lacre.db'))).toBe(true);
        expect(existsSync(join(prev, 'lacre.db'))).toBe(false);
        expect(store.backend.description).toContain('timestamp.sectigo.com');
        expect(store.backend.description).not.toContain('freetsa.org');
      } finally {
        closeDb(store.db);
      }
    });
    expect(lines).toContain('warning: LACRE_HOME and PROVENANT_HOME are both set and differ; using LACRE_HOME\n');
    expect(lines).toContain('warning: LACRE_TSA_URL and PROVENANT_TSA_URL are both set and differ; using LACRE_TSA_URL\n');
  });

  it('refuses to open a store when neither home variable is set', () => {
    expect(() => anchorTickStoreFromEnv({})).toThrow(/LACRE_HOME is not set/);
    expect(() => anchorTickStoreFromEnv({ LACRE_HOME: '', PROVENANT_HOME: '' })).toThrow(/LACRE_HOME is not set/);
  });
});

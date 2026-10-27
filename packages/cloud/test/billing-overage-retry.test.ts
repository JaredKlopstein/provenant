import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { eq } from '@lacre/core';
import {
  billingSchema, billingCustomers, billingSubscriptions, billingUsageReports, billingOverageSubscriptions,
} from '../src/billing/schema.js';
import {
  createOverageReporter, type OverageStripe, type MeterEventParams, type OverageReporterOptions,
} from '../src/billing/overage.js';
import { PRICE_ENV, METER_EVENT_ENV } from '../src/billing/config.js';
import type { BillingDb } from '../src/billing/store.js';
import { createOverageRetryRoute, GET } from '../api/cron/overage-retry.js';

/*
 * The daily overage retry (#66). Stripe is the fake below, Postgres is PGlite
 * in process, the clock is injected and stepped a day per cron run; nothing
 * touches the network. Secret-shaped values are assembled at run time.
 */
const u = (...parts: string[]) => parts.join('_');
const TEST_KEY = u('sk', 'test', 'x'.repeat(24));
const PRICE_YEAR = u('price', 'testcloudyear');
const METER_NAME = 'test-retry-overage-meter';
const CRON_SECRET = 'test-cron-secret';

const ENV: Record<string, string> = { STRIPE_SECRET_KEY: TEST_KEY, [METER_EVENT_ENV]: METER_NAME, CRON_SECRET };
for (const [key, name] of Object.entries(PRICE_ENV)) ENV[name] = u('price', 'test' + key.replace(/_/g, ''));

const MONTHLY = { account: 'urn:provenant:agent:test-monthly', customer: 'cus_test_monthly', subscription: 'sub_test_monthly', interval: 'month' as const };
const ANNUAL = { account: 'urn:provenant:agent:test-annual', customer: 'cus_test_annual', subscription: 'sub_test_annual', interval: 'year' as const };
const OVERAGE_SUB = 'sub_test_overage_existing';

const MIGRATIONS = ['0000_billing.sql', '0001_overage.sql', '0002_overage_retry.sql']
  .map((f) => fileURLToPath(new URL(`../migrations/${f}`, import.meta.url)));

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** 06:00 UTC, when vercel.json's cron entry fires. */
const SEP_10 = Date.UTC(2026, 8, 10, 6);
const secs = (ms: number) => Math.floor(ms / 1000);

// --------------------------------------------------------------- fake Stripe --

/**
 *  - 'reject': Stripe answers with an error. Nothing is billed.
 *  - 'timeout': Stripe counts the event, but the answer never arrives.
 */
type Failure = 'reject' | 'timeout';

const stripeError = () => Object.assign(new Error('Stripe is unavailable'), { type: 'StripeAPIError', statusCode: 503 });
const connectionError = () => Object.assign(new Error('Request timed out'), { type: 'StripeConnectionError' });

/** Meter events dedupe on their identifier for 24 hours of the fake's clock, as
 *  Stripe's do, and only that long. Each call yields first, so two runs at once
 *  interleave the way two function instances would. */
function fakeStripe(clock: () => number) {
  const meterCalls: Array<{ params: MeterEventParams; idempotencyKey?: string }> = [];
  const billed: MeterEventParams[] = [];
  const seen = new Map<string, number>();
  const failures: Failure[] = [];
  let down = false;
  const other: string[] = [];

  const client: OverageStripe = {
    billing: {
      meterEvents: {
        async create(params, options) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          meterCalls.push({ params, ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) });
          const failure = down ? 'reject' : failures.shift();
          if (failure === 'reject') throw stripeError();
          const first = seen.get(params.identifier);
          if (first === undefined || clock() - first >= DAY) {
            seen.set(params.identifier, clock());
            billed.push(params);
          }
          if (failure === 'timeout') throw connectionError();
          return { object: 'billing.meter_event', identifier: params.identifier };
        },
      },
    },
    subscriptions: {
      async create() {
        other.push('subscriptions.create');
        throw new Error('not expected: the overage subscription already exists');
      },
      async retrieve() {
        other.push('subscriptions.retrieve');
        throw new Error('not expected');
      },
    },
    customers: {
      async retrieve() {
        other.push('customers.retrieve');
        return { invoice_settings: null };
      },
    },
  };
  return {
    client, meterCalls, billed, failures, other,
    setDown: (v: boolean) => { down = v; },
  };
}

// ------------------------------------------------------------------ database --

let pg: PGlite;
let db: BillingDb;

beforeAll(async () => {
  pg = await PGlite.create();
  for (const m of MIGRATIONS) await pg.exec(readFileSync(m, 'utf8'));
  db = drizzle({ client: pg, schema: billingSchema });
});
afterAll(async () => {
  await pg.close();
});

let now: number;
let fake: ReturnType<typeof fakeStripe>;
let logs: string[];

beforeEach(async () => {
  await pg.exec(
    'TRUNCATE billing_usage_reports, billing_bundle_exports, billing_overage_subscriptions, billing_bundle_credits, ' +
      'billing_subscriptions, billing_customers, billing_webhook_events RESTART IDENTITY CASCADE',
  );
  now = SEP_10;
  fake = fakeStripe(() => now);
  logs = [];
});

function options(o: Partial<OverageReporterOptions> = {}): OverageReporterOptions {
  return { env: ENV, stripe: fake.client, db, now: () => new Date(now), log: (l) => logs.push(l), ...o };
}

function cronRequest(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  return new Request('https://cloud.example/api/cron/overage-retry', { headers });
}

/** One cron invocation, authorized, through the deployed route's code. */
async function runCron(route = createOverageRetryRoute(options())) {
  const res = await route(cronRequest(`Bearer ${CRON_SECRET}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function subscriber(s: { account: string; customer: string; subscription: string; interval: 'month' | 'year' }) {
  await db.insert(billingCustomers).values({ stripeCustomerId: s.customer, accountId: s.account });
  await db.insert(billingSubscriptions).values({
    stripeSubscriptionId: s.subscription, stripeCustomerId: s.customer, plan: 'cloud', interval: s.interval,
    status: 'active', stripePriceId: s.interval === 'year' ? PRICE_YEAR : null,
  });
}

/** An unreported overage row, as an export that failed to report leaves it. */
async function pendingRow(s: { subscription: string }, exportedAt: number) {
  const [row] = await db
    .insert(billingUsageReports)
    .values({ stripeSubscriptionId: s.subscription, bundleId: `test-bundle-${randomUUID()}`, exportedAt: new Date(exportedAt) })
    .returning();
  return row!;
}

async function rowById(id: number) {
  const [row] = await db.select().from(billingUsageReports).where(eq(billingUsageReports.id, id));
  return row!;
}

const sendsOf = (bundleId: string) => fake.meterCalls.filter((c) => c.params.identifier === bundleId);
const alerts = () => logs.filter((l) => /ALERT/.test(l));
const possibleDuplicates = () => logs.filter((l) => /possible duplicate/.test(l));

// ---------------------------------------------------------------------- auth --

describe('the cron route: CRON_SECRET', () => {
  const cases: [string, string | undefined, Record<string, string | undefined>][] = [
    ['a missing Authorization header', undefined, ENV],
    ['a wrong secret', 'Bearer test-cron-wrong', ENV],
    ['an unset CRON_SECRET', `Bearer ${CRON_SECRET}`, { ...ENV, CRON_SECRET: undefined }],
    ['an empty CRON_SECRET', `Bearer ${CRON_SECRET}`, { ...ENV, CRON_SECRET: '' }],
  ];

  for (const [name, header, env] of cases) {
    it(`returns 401 for ${name} and sends nothing`, async () => {
      await subscriber(MONTHLY);
      const row = await pendingRow(MONTHLY, SEP_10);
      now = SEP_10 + DAY;

      const res = await createOverageRetryRoute(options({ env }))(cronRequest(header));
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
      expect(fake.meterCalls).toEqual([]);
      expect(fake.other).toEqual([]);
      expect(await rowById(row.id)).toMatchObject({ reported: false, attemptCount: 0, lastAttemptAt: null, abandonedAt: null });
      expect(logs).toEqual([]);
    });
  }

  it('the deployed GET handler is the same route: no secret, 401', async () => {
    const res = await GET(cronRequest());
    expect(res.status).toBe(401);
  });

  it("vercel.json's daily cron entry points at this file", () => {
    const config = JSON.parse(readFileSync(fileURLToPath(new URL('../vercel.json', import.meta.url)), 'utf8')) as {
      crons: { path: string; schedule: string }[];
    };
    const entry = config.crons.find((c) => c.path === '/api/cron/overage-retry');
    expect(entry?.schedule).toBe('0 6 * * *');
    expect(existsSync(fileURLToPath(new URL(`..${entry!.path}.ts`, import.meta.url)))).toBe(true);
  });

  it('with the secret but no billing config: generic 500 with a request id, the variables only in the log, nothing sent', async () => {
    const res = await createOverageRetryRoute(options({ env: { CRON_SECRET } }))(cronRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(500);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.error.code).toBe('BILLING_NOT_CONFIGURED');
    expect(body.error.message).toBe('Overage retry is not configured.');
    expect(text).not.toMatch(/Set the named variables/);
    const headers = JSON.stringify([...res.headers]);
    for (const exposed of [text, headers]) expect(exposed).not.toMatch(/STRIPE_|LACRE_|DATABASE_URL|CRON_SECRET/);
    expect(text).not.toContain(CRON_SECRET);
    const requestId = res.headers.get('x-request-id');
    expect(requestId).toBeTruthy();
    expect(body.requestId).toBe(requestId);
    const line = logs.find((l) => l.includes(requestId!));
    expect(line).toMatch(/STRIPE_SECRET_KEY/);
    expect(line).not.toContain(TEST_KEY);
    expect(fake.meterCalls).toEqual([]);
  });
});

// ----------------------------------------------------------------- the retry --

describe('a failed row is resent by the next daily run', () => {
  it('same identifier and idempotency key, then reported; never resent after, even past 24 hours', async () => {
    await subscriber(MONTHLY);
    const r = createOverageReporter(options());
    for (let i = 0; i < 5; i++) await r.recordExport({ accountId: MONTHLY.account, bundleId: `test-bundle-${randomUUID()}` });
    fake.failures.push('reject');
    const bundleId = 'test-bundle-sixth';
    expect(await r.recordExport({ accountId: MONTHLY.account, bundleId })).toMatchObject({ status: 'unreported' });

    const [failed] = await db.select().from(billingUsageReports);
    expect(failed).toMatchObject({ reported: false, attemptCount: 1, lastErrorKind: 'stripe_error' });
    expect(failed!.lastAttemptAt!.getTime()).toBe(SEP_10);

    now = SEP_10 + DAY;
    expect(await runCron()).toEqual({ status: 200, body: { status: 'done', reported: 1, failed: 0, abandoned: 0 } });
    const [first, retry] = sendsOf(bundleId);
    expect(retry!.params).toEqual(first!.params);
    expect(retry!.idempotencyKey).toBe(first!.idempotencyKey);
    expect(retry!.idempotencyKey).toContain(bundleId);
    expect(await rowById(failed!.id)).toMatchObject({
      reported: true, reportedSubscriptionId: MONTHLY.subscription, attemptCount: 2, lastErrorKind: null,
    });

    // Past Stripe's 24-hour dedupe a resend would bill again; only the row stops it.
    for (let day = 2; day <= 40; day++) {
      now = SEP_10 + day * DAY;
      expect((await runCron()).body).toMatchObject({ status: 'idle', reported: 0 });
    }
    expect(sendsOf(bundleId)).toHaveLength(2);
    expect(fake.billed).toHaveLength(1);
  });

  it('a row reported by an export is never touched by the cron, at any age', async () => {
    await subscriber(MONTHLY);
    const r = createOverageReporter(options());
    for (let i = 0; i < 6; i++) await r.recordExport({ accountId: MONTHLY.account, bundleId: `test-bundle-${randomUUID()}` });
    expect(fake.meterCalls).toHaveLength(1);
    for (const later of [HOUR, 25 * HOUR, 10 * DAY, 36 * DAY]) {
      now = SEP_10 + later;
      expect((await runCron()).body).toMatchObject({ status: 'idle' });
    }
    expect(fake.meterCalls).toHaveLength(1);
    expect(alerts()).toEqual([]);
  });
});

// -------------------------------------------------------------------- cutoff --

describe('the 34-day cutoff, measured from the computed event timestamp', () => {
  it('a day per run: retried while 33 and 34 days old, abandoned at 35 with one alert and no Stripe call', async () => {
    await subscriber(MONTHLY);
    const row = await pendingRow(MONTHLY, SEP_10);
    fake.setDown(true);
    const route = createOverageRetryRoute(options());

    for (let day = 1; day <= 34; day++) {
      now = SEP_10 + day * DAY;
      const before = fake.meterCalls.length;
      expect((await runCron(route)).body, `day ${day}`).toMatchObject({ status: 'done', reported: 0, failed: 1, abandoned: 0 });
      expect(fake.meterCalls.length, `day ${day}`).toBe(before + 1);
    }
    expect(await rowById(row.id)).toMatchObject({ reported: false, attemptCount: 34, lastErrorKind: 'stripe_error', abandonedAt: null });
    expect(alerts()).toEqual([]);

    const sent = fake.meterCalls.length;
    now = SEP_10 + 35 * DAY;
    expect((await runCron(route)).body).toMatchObject({ status: 'done', reported: 0, failed: 0, abandoned: 1 });
    expect(fake.meterCalls).toHaveLength(sent);
    const abandoned = await rowById(row.id);
    expect(abandoned).toMatchObject({ reported: false, attemptCount: 34 });
    expect(abandoned.abandonedAt!.getTime()).toBe(now);

    // Abandoned for good: Stripe recovers, and the row is still never sent.
    fake.setDown(false);
    for (let day = 36; day <= 40; day++) {
      now = SEP_10 + day * DAY;
      expect((await runCron(route)).body).toMatchObject({ status: 'idle' });
    }
    expect(fake.meterCalls).toHaveLength(sent);
    expect(fake.billed).toHaveLength(0);

    // One alert line, naming only the internal row id and the month.
    expect(alerts()).toHaveLength(1);
    const [line] = alerts();
    expect(line).toContain(`usage report ${row.id} for 2026-09`);
    for (const value of [row.bundleId, MONTHLY.subscription, MONTHLY.customer, MONTHLY.account, METER_NAME, TEST_KEY]) {
      expect(line).not.toContain(value);
    }
  });

  it('an annual row exported 40 days ago, on an overage subscription started 33 days ago, is sent at that start', async () => {
    await subscriber(ANNUAL);
    now = SEP_10 + 40 * DAY;
    const start = now - 33 * DAY;
    await db.insert(billingOverageSubscriptions).values({
      stripeSubscriptionId: ANNUAL.subscription, overageSubscriptionId: OVERAGE_SUB, createdAt: new Date(start),
    });
    const row = await pendingRow(ANNUAL, SEP_10);

    expect((await runCron()).body).toMatchObject({ status: 'done', reported: 1, abandoned: 0 });
    expect(sendsOf(row.bundleId)).toHaveLength(1);
    expect(sendsOf(row.bundleId)[0]!.params.timestamp).toBe(secs(start));
    expect(await rowById(row.id)).toMatchObject({ reported: true, reportedSubscriptionId: OVERAGE_SUB });
    expect(alerts()).toEqual([]);
  });

  it('an annual row whose overage subscription started 35 days ago is abandoned, with no Stripe call', async () => {
    await subscriber(ANNUAL);
    now = SEP_10 + 40 * DAY;
    await db.insert(billingOverageSubscriptions).values({
      stripeSubscriptionId: ANNUAL.subscription, overageSubscriptionId: OVERAGE_SUB, createdAt: new Date(now - 35 * DAY),
    });
    const row = await pendingRow(ANNUAL, SEP_10);

    expect((await runCron()).body).toMatchObject({ status: 'done', reported: 0, abandoned: 1 });
    expect(fake.meterCalls).toEqual([]);
    expect(fake.other).toEqual([]);
    expect((await rowById(row.id)).abandonedAt).not.toBeNull();
    expect(alerts()).toHaveLength(1);
  });
});

// ------------------------------------------------------- possible duplicates --

describe('possible duplicate: the last send got no response and was more than 24 hours ago', () => {
  async function failedRow(failure: Failure) {
    await subscriber(MONTHLY);
    const row = await pendingRow(MONTHLY, SEP_10);
    fake.failures.push(failure);
    expect((await runCron()).body).toMatchObject({ failed: 1 });
    return row;
  }

  it('a timeout: recorded as no_response, sent once more 25 hours later, logged naming only the row id', async () => {
    const row = await failedRow('timeout');
    expect(await rowById(row.id)).toMatchObject({ reported: false, attemptCount: 1, lastErrorKind: 'no_response' });

    now = SEP_10 + 25 * HOUR;
    expect((await runCron()).body).toMatchObject({ reported: 1, failed: 0 });
    expect(sendsOf(row.bundleId)).toHaveLength(2);
    expect(await rowById(row.id)).toMatchObject({ reported: true, attemptCount: 2 });

    expect(possibleDuplicates()).toHaveLength(1);
    const [line] = possibleDuplicates();
    expect(line).toContain(`usage report ${row.id} `);
    for (const value of [row.bundleId, MONTHLY.subscription, MONTHLY.customer, MONTHLY.account, METER_NAME]) {
      expect(line).not.toContain(value);
    }
    // Why the line exists: Stripe's dedupe had lapsed, and it counted both.
    expect(fake.billed).toHaveLength(2);

    now += DAY;
    await runCron();
    expect(sendsOf(row.bundleId)).toHaveLength(2);
    expect(possibleDuplicates()).toHaveLength(1);
  });

  it('an explicit Stripe error is not flagged, however long ago', async () => {
    const row = await failedRow('reject');
    expect((await rowById(row.id)).lastErrorKind).toBe('stripe_error');
    now = SEP_10 + 25 * HOUR;
    expect((await runCron()).body).toMatchObject({ reported: 1 });
    expect(possibleDuplicates()).toEqual([]);
    expect(fake.billed).toHaveLength(1);
  });

  it('a timeout resent inside 24 hours is not flagged: Stripe dedupes it', async () => {
    const row = await failedRow('timeout');
    now = SEP_10 + 23 * HOUR;
    expect((await runCron()).body).toMatchObject({ reported: 1 });
    expect(sendsOf(row.bundleId)).toHaveLength(2);
    expect(possibleDuplicates()).toEqual([]);
    expect(fake.billed).toHaveLength(1);
  });

  it('a send whose run died before any answer counts as no_response', async () => {
    await subscriber(MONTHLY);
    const row = await pendingRow(MONTHLY, SEP_10);
    await db.update(billingUsageReports)
      .set({ attemptCount: 1, lastErrorKind: 'sending', lastAttemptAt: new Date(SEP_10) })
      .where(eq(billingUsageReports.id, row.id));

    now = SEP_10 + 25 * HOUR;
    expect((await runCron()).body).toMatchObject({ reported: 1 });
    expect(possibleDuplicates()).toHaveLength(1);
  });
});

// --------------------------------------------------------------- concurrency --

describe('two runs at once', () => {
  it('never send a row twice', async () => {
    await subscriber(MONTHLY);
    const rows = [];
    for (let i = 0; i < 6; i++) rows.push(await pendingRow(MONTHLY, SEP_10));
    now = SEP_10 + DAY;

    const [a, b] = await Promise.all([
      runCron(createOverageRetryRoute(options())),
      runCron(createOverageRetryRoute(options())),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(Number(a.body.reported) + Number(b.body.reported)).toBe(rows.length);
    for (const row of rows) expect(sendsOf(row.bundleId), row.bundleId).toHaveLength(1);
    expect((await db.select().from(billingUsageReports)).every((r) => r.reported && r.attemptCount === 1)).toBe(true);
  });

  it('a row another run is sending right now is skipped', async () => {
    await subscriber(MONTHLY);
    const row = await pendingRow(MONTHLY, SEP_10);
    now = SEP_10 + DAY;
    await db.update(billingUsageReports)
      .set({ attemptCount: 1, lastErrorKind: 'sending', lastAttemptAt: new Date(now - 60_000) })
      .where(eq(billingUsageReports.id, row.id));

    expect((await runCron()).body).toMatchObject({ status: 'done', reported: 0, failed: 0 });
    expect(fake.meterCalls).toEqual([]);
    expect(await rowById(row.id)).toMatchObject({ attemptCount: 1, lastErrorKind: 'sending' });
  });
});

// ---------------------------------------------------------------- migration --

describe('0002_overage_retry.sql', () => {
  const SQL_0002 = readFileSync(MIGRATIONS[2]!, 'utf8');

  it('is additive only: new columns on billing_usage_reports, no drop, rename or new table', () => {
    const code = SQL_0002.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/\bDROP\b|\bRENAME\b|CREATE\s+TABLE|ALTER\s+COLUMN/i);
    expect([...code.matchAll(/ALTER TABLE (\w+)/g)].map((m) => m[1])).toEqual(['billing_usage_reports']);
    expect([...code.matchAll(/ADD COLUMN (\w+)/g)].map((m) => m[1])).toEqual([
      'attempt_count', 'last_error_kind', 'last_attempt_at', 'abandoned_at',
    ]);
  });

  it('applies after 0000 and 0001, keeps existing rows, and matches the drizzle schema', async () => {
    const fresh = await PGlite.create();
    try {
      await fresh.exec(readFileSync(MIGRATIONS[0]!, 'utf8'));
      await fresh.exec(readFileSync(MIGRATIONS[1]!, 'utf8'));
      await fresh.exec(
        "INSERT INTO billing_customers (stripe_customer_id) VALUES ('cus_test_old');" +
          "INSERT INTO billing_subscriptions (stripe_subscription_id, stripe_customer_id, plan, interval, status) " +
          "VALUES ('sub_test_old', 'cus_test_old', 'cloud', 'month', 'active');" +
          'INSERT INTO billing_usage_reports (stripe_subscription_id, bundle_id, exported_at) ' +
          "VALUES ('sub_test_old', 'test-bundle-old', now());",
      );
      await fresh.exec(SQL_0002);

      const { rows: [old] } = await fresh.query<Record<string, unknown>>('SELECT * FROM billing_usage_reports');
      expect(old).toMatchObject({
        bundle_id: 'test-bundle-old', reported: false,
        attempt_count: 0, last_error_kind: null, last_attempt_at: null, abandoned_at: null,
      });

      const config = getTableConfig(billingUsageReports);
      const { rows: columns } = await fresh.query<{ column_name: string; data_type: string; is_nullable: string }>(
        'SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name',
        [config.name],
      );
      expect(columns).toEqual(
        config.columns
          .map((c) => ({ column_name: c.name, data_type: c.getSQLType(), is_nullable: c.notNull ? 'NO' : 'YES' }))
          .sort((a, b) => a.column_name.localeCompare(b.column_name)),
      );
    } finally {
      await fresh.close();
    }
  });
});

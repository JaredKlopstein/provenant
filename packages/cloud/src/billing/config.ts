/**
 * Billing configuration, read from the environment and nowhere else.
 *
 * Three rules, all load-bearing:
 *
 *  1. Secrets come from the environment only. Deployed, that means the Vercel
 *     project's environment variables (Neon injects DATABASE_URL there); run
 *     locally, the owner's shell. Nothing is read from a file in the repo.
 *
 *  2. Test mode comes first. A live key is refused unless the operator has
 *     also set PROVENANT_BILLING_MODE=live, so a live key pasted into the
 *     wrong place cannot charge anyone by accident. The reverse mismatch is
 *     refused too: "live" with a test key would report a live sync that never
 *     touched live data.
 *
 *  3. No value is ever echoed. Errors name the variable, never its contents,
 *     and the config object prints as redacted however it is logged.
 */
import { inspect } from 'node:util';
import Stripe from 'stripe';
import { z } from 'zod';
import { ProvenantError } from '@provenant/core';
import type { StripeLike } from './stripe.js';
import type { CatalogClient } from './sync.js';

export type BillingMode = 'test' | 'live';

/** Price-id variables, by catalog key. The sync command prints which price
 *  belongs in each. */
export const PRICE_ENV = {
  cloud_month: 'STRIPE_PRICE_CLOUD_MONTHLY',
  cloud_year: 'STRIPE_PRICE_CLOUD_ANNUAL',
  extra_identity: 'STRIPE_PRICE_CLOUD_EXTRA_IDENTITY',
  payg_bundle: 'STRIPE_PRICE_BUNDLE_PAYG',
  overage_bundle: 'STRIPE_PRICE_BUNDLE_OVERAGE',
} as const;
export type CatalogKey = keyof typeof PRICE_ENV;

/** The event name overage bundles are reported under: the event name of the
 *  Meter that backs the metered overage price. Never written in code. */
export const METER_EVENT_ENV = 'STRIPE_METER_EVENT_NAME';

/** What a caller needs. The sync needs only the Stripe key; the webhook needs
 *  its secret and the database; checkout needs the price ids; overage
 *  reporting needs the meter event name as well. */
export type BillingNeed = 'stripe' | 'webhook' | 'database' | 'prices' | 'meter';

/** Narrows the 'prices' need. */
export interface BillingConfigOptions {
  /** The prices to read. Defaults to every one in PRICE_ENV. */
  prices?: readonly CatalogKey[];
  /** Of those, the ones that may be left unset. One that is set but
   *  malformed is still refused. */
  optionalPrices?: readonly CatalogKey[];
}

export interface BillingConfig {
  mode: BillingMode;
  stripeSecretKey?: string;
  webhookSecret?: string;
  databaseUrl?: string;
  meterEventName?: string;
  prices: Partial<Record<CatalogKey, string>>;
  /** Removes every secret this config holds, and anything secret-shaped,
   *  from text before it is logged or returned. */
  redact(text: string): string;
}

type Env = Record<string, string | undefined>;

const REDACTED = '[redacted]';
const KEY_SHAPE = /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/;
const LIVE_KEY = /^(sk|rk)_live_/;

/** Secret-shaped strings, redacted even when no config is in hand. */
const SECRET_PATTERNS = [
  /\b(sk|rk)_(test|live)_[A-Za-z0-9*]+/g,
  /\bwhsec_[A-Za-z0-9]+/g,
  /\bpostgres(ql)?:\/\/[^\s'"`]+/g,
];

export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  // Longest first, so a URL is replaced whole before its parts are.
  for (const s of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join(REDACTED);
  }
  for (const p of SECRET_PATTERNS) out = out.replace(p, REDACTED);
  return out;
}

/** The URL itself plus every part of it that could identify or unlock the
 *  database, raw and percent-decoded. */
function databaseUrlParts(url: string): string[] {
  const parts = [url];
  try {
    const u = new URL(url);
    for (const p of [u.password, u.username, u.hostname]) {
      if (!p) continue;
      parts.push(p);
      try {
        parts.push(decodeURIComponent(p));
      } catch {
        // Not valid percent-encoding; the raw form is already covered.
      }
    }
  } catch {
    // Unparseable; the whole string is already covered.
  }
  return parts;
}

const present = (name: string) =>
  z.string({ error: `${name} is not set` }).min(1, `${name} is not set`);

const schemas = {
  STRIPE_SECRET_KEY: present('STRIPE_SECRET_KEY').regex(
    KEY_SHAPE,
    'STRIPE_SECRET_KEY is not a Stripe secret or restricted key',
  ),
  STRIPE_WEBHOOK_SECRET: present('STRIPE_WEBHOOK_SECRET').regex(
    /^whsec_[A-Za-z0-9]+$/,
    'STRIPE_WEBHOOK_SECRET is not a Stripe webhook signing secret',
  ),
  DATABASE_URL: present('DATABASE_URL').refine((v) => {
    try {
      return ['postgres:', 'postgresql:'].includes(new URL(v).protocol);
    } catch {
      return false;
    }
  }, 'DATABASE_URL is not a postgres:// connection string'),
  PROVENANT_BILLING_MODE: z.enum(['test', 'live'], {
    error: "PROVENANT_BILLING_MODE must be 'test' or 'live'",
  }),
  STRIPE_METER_EVENT_NAME: present(METER_EVENT_ENV).regex(
    /^[A-Za-z0-9_.:-]{1,100}$/,
    `${METER_EVENT_ENV} is not a Stripe meter event name`,
  ),
  price: (name: string) =>
    present(name).regex(/^price_[A-Za-z0-9]+$/, `${name} is not a Stripe price id`),
};

function configError(problems: string[], variables: string[]): ProvenantError {
  return new ProvenantError({
    code: 'INVALID_INPUT',
    message: `Billing configuration is incomplete: ${problems.join('; ')}. Nothing was executed.`,
    retryable: false,
    details: { variables },
    fix: {
      note:
        `Set ${variables.join(', ')} in the environment: the Vercel project's environment variables ` +
        `for deployed code, or your own shell for a local run. Never put the values in the repo, an ` +
        `issue or a log. Test mode comes first; PROVENANT_BILLING_MODE=live is for the owner, after ` +
        `the manual test-mode check.`,
    },
  });
}

/**
 * Reads and validates billing config for the given needs. Throws a
 * ProvenantError naming every missing or malformed variable, and no value.
 */
export function loadBillingConfig(
  env: Env = process.env,
  needs: readonly BillingNeed[] = ['stripe'],
  opts: BillingConfigOptions = {},
): BillingConfig {
  const problems: string[] = [];
  const variables: string[] = [];
  const read = <T>(name: string, schema: z.ZodType<T>, value: unknown): T | undefined => {
    // An empty variable is a missing one: Vercel and shells both produce them.
    const r = schema.safeParse(value === '' ? undefined : value);
    if (r.success) return r.data;
    // Our own messages only. They name the variable and never carry the input.
    problems.push(...new Set(r.error.issues.map((i) => i.message)));
    variables.push(name);
    return undefined;
  };

  const rawMode = env.PROVENANT_BILLING_MODE;
  const mode = read('PROVENANT_BILLING_MODE', schemas.PROVENANT_BILLING_MODE, rawMode || 'test') ?? 'test';

  const stripeSecretKey = needs.includes('stripe')
    ? read('STRIPE_SECRET_KEY', schemas.STRIPE_SECRET_KEY, env.STRIPE_SECRET_KEY)
    : undefined;
  const webhookSecret = needs.includes('webhook')
    ? read('STRIPE_WEBHOOK_SECRET', schemas.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SECRET)
    : undefined;
  const databaseUrl = needs.includes('database')
    ? read('DATABASE_URL', schemas.DATABASE_URL, env.DATABASE_URL)
    : undefined;
  const meterEventName = needs.includes('meter')
    ? read(METER_EVENT_ENV, schemas.STRIPE_METER_EVENT_NAME, env[METER_EVENT_ENV])
    : undefined;

  const prices: Partial<Record<CatalogKey, string>> = {};
  if (needs.includes('prices')) {
    for (const [key, name] of Object.entries(PRICE_ENV) as Array<[CatalogKey, string]>) {
      if (opts.prices && !opts.prices.includes(key)) continue;
      if (opts.optionalPrices?.includes(key) && !env[name]) continue;
      const v = read(name, schemas.price(name), env[name]);
      if (v) prices[key] = v;
    }
  }

  if (stripeSecretKey && variables.length === 0) {
    const keyIsLive = LIVE_KEY.test(stripeSecretKey);
    if (keyIsLive && mode !== 'live') {
      problems.push(
        'STRIPE_SECRET_KEY is a live-mode key but PROVENANT_BILLING_MODE is not live. Test mode ' +
          'comes first: use a test key, or, as the owner after the manual check, set PROVENANT_BILLING_MODE=live',
      );
      variables.push('PROVENANT_BILLING_MODE');
    } else if (!keyIsLive && mode === 'live') {
      problems.push(
        'PROVENANT_BILLING_MODE is live but STRIPE_SECRET_KEY is a test-mode key. Use the live key, ' +
          'or unset PROVENANT_BILLING_MODE to stay in test mode',
      );
      variables.push('PROVENANT_BILLING_MODE');
    }
  }

  if (problems.length) throw configError(problems, variables);

  const secrets = [
    stripeSecretKey, webhookSecret, meterEventName, ...(databaseUrl ? databaseUrlParts(databaseUrl) : []),
  ].filter((s): s is string => !!s);
  const view = () => ({
    mode,
    stripeSecretKey: stripeSecretKey ? REDACTED : undefined,
    webhookSecret: webhookSecret ? REDACTED : undefined,
    databaseUrl: databaseUrl ? REDACTED : undefined,
    meterEventName: meterEventName ? REDACTED : undefined,
    prices: Object.fromEntries(Object.keys(prices).map((k) => [k, REDACTED])),
  });

  const config: BillingConfig = {
    mode,
    prices,
    redact: (text: string) => redact(text, secrets),
  };
  // Non-enumerable, so spreading or iterating the config never copies them out.
  for (const [k, v] of [['stripeSecretKey', stripeSecretKey], ['webhookSecret', webhookSecret], ['databaseUrl', databaseUrl], ['meterEventName', meterEventName]] as const) {
    if (v !== undefined) Object.defineProperty(config, k, { value: v, enumerable: false });
  }
  Object.defineProperties(config, {
    toJSON: { value: view, enumerable: false },
    toString: { value: () => `BillingConfig ${JSON.stringify(view())}`, enumerable: false },
    [inspect.custom]: { value: () => view(), enumerable: false },
  });
  return config;
}

/**
 * A real Stripe client for this config. It satisfies both the injected
 * StripeLike interface (checkout, portal) and the CatalogClient the sync uses,
 * so nothing downstream imports the SDK directly.
 */
export function createStripeClient(config: BillingConfig): StripeLike & CatalogClient {
  if (!config.stripeSecretKey) {
    throw configError(['STRIPE_SECRET_KEY is not set'], ['STRIPE_SECRET_KEY']);
  }
  return new Stripe(config.stripeSecretKey, {
    maxNetworkRetries: 2,
    appInfo: { name: 'provenant-cloud' },
  });
}

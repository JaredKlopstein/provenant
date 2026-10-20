import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requireCronAuth } from '../src/cron/auth.js';

const VERCEL_JSON = fileURLToPath(new URL('../vercel.json', import.meta.url));
const AUTH_SRC = fileURLToPath(new URL('../src/cron/auth.ts', import.meta.url));

const SECRET = 'test-cron-secret';
const SAME_LENGTH_WRONG = 'test-cron-secreX';
const WRONG_LENGTH = 'test-cron';

/**
 * True when a five-field cron schedule can fire at most once a day: the minute
 * and the hour must each be one fixed number. The day, month and weekday
 * fields only narrow which days it runs on.
 */
function atMostDaily(schedule: string): boolean {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour] = fields as [string, string];
  return /^\d+$/.test(minute) && Number(minute) <= 59 && /^\d+$/.test(hour) && Number(hour) <= 23;
}

function request(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  return new Request('https://cloud.example/api/cron/overage-retry', { headers });
}

describe('vercel.json', () => {
  const config = JSON.parse(readFileSync(VERCEL_JSON, 'utf8')) as {
    crons?: { path: string; schedule: string }[];
  };

  it('parses and holds the daily 06:00 UTC overage retry entry', () => {
    expect(config.crons).toContainEqual({ path: '/api/cron/overage-retry', schedule: '0 6 * * *' });
  });

  it('has no cron entry that runs more often than daily (Vercel Hobby limit)', () => {
    expect(config.crons?.length).toBeGreaterThan(0);
    for (const cron of config.crons ?? []) {
      expect(cron.path, 'a cron path must be absolute').toMatch(/^\//);
      expect(atMostDaily(cron.schedule), `${cron.path} runs more than daily: "${cron.schedule}"`).toBe(true);
    }
  });

  it('the schedule check rejects sub-daily schedules', () => {
    for (const s of ['* * * * *', '*/5 * * * *', '0 * * * *', '0 */6 * * *', '0 6,18 * * *', '0 6-8 * * *', '0,30 6 * * *', '0 6 * *', '@hourly']) {
      expect(atMostDaily(s), s).toBe(false);
    }
    for (const s of ['0 6 * * *', '30 23 * * 1', '0 0 1 * *']) {
      expect(atMostDaily(s), s).toBe(true);
    }
  });
});

describe('requireCronAuth', () => {
  const env = { CRON_SECRET: SECRET };

  afterEach(() => vi.restoreAllMocks());

  it('passes the correct secret', () => {
    expect(requireCronAuth(request(`Bearer ${SECRET}`), env)).toBeNull();
  });

  it('accepts the scheme in any case', () => {
    expect(requireCronAuth(request(`bearer ${SECRET}`), env)).toBeNull();
  });

  const rejected: [string, string | undefined, Record<string, string | undefined>][] = [
    ['a missing header', undefined, env],
    ['an empty header', '', env],
    ['a wrong secret of the same length', `Bearer ${SAME_LENGTH_WRONG}`, env],
    ['a wrong-length secret', `Bearer ${WRONG_LENGTH}`, env],
    ['the secret with a suffix', `Bearer ${SECRET}x`, env],
    ['a Bearer scheme with no token', 'Bearer ', env],
    ['a non-Bearer scheme', `Basic ${SECRET}`, env],
    ['the bare secret with no scheme', SECRET, env],
    ['an unset CRON_SECRET', `Bearer ${SECRET}`, {}],
    ['an empty CRON_SECRET', 'Bearer ', { CRON_SECRET: '' }],
    ['an empty CRON_SECRET and a token', `Bearer ${SECRET}`, { CRON_SECRET: '' }],
  ];

  for (const [name, header, e] of rejected) {
    it(`returns 401 for ${name}, leaking neither value`, async () => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => {}),
      );
      const res = requireCronAuth(request(header), e);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(401);
      expect(res!.headers.get('www-authenticate')).toBe('Bearer');

      const text = await res!.text();
      const body = JSON.parse(text) as { error: { code: string; fix: { note: string } } };
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(body.error.fix.note).toContain('CRON_SECRET');
      for (const value of [SECRET, SAME_LENGTH_WRONG, WRONG_LENGTH]) expect(text).not.toContain(value);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });
  }

  it('gives the same response whatever the reason, so a caller learns nothing', async () => {
    const bodies = await Promise.all(
      rejected.map(([, header, e]) => requireCronAuth(request(header), e)!.text()),
    );
    expect(new Set(bodies).size).toBe(1);
  });

  it('compares SHA-256 digests with timingSafeEqual and never with ==', () => {
    const code = readFileSync(AUTH_SRC, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).toContain("createHash('sha256')");
    expect(code).toMatch(/timingSafeEqual\(digest\(presented\), digest\(secret\)\)/);
    expect(code).not.toMatch(/[!=]==?/);
    expect(code).not.toMatch(/console\./);
  });
});

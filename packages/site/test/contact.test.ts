import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { POST } from '../app/api/contact/route.js';
import EnterprisePage, { metadata } from '../app/enterprise/page.js';
import { BRAND } from '../src/brand.js';
import { FLEET_SIZES, HONEYPOT_FIELD } from '../src/contact.js';

/**
 * The enterprise contact route forwards one submission to CONTACT_FORWARD_URL.
 * fetch is mocked throughout: nothing here touches the network.
 */

const FORWARD_URL = 'https://forward.example.test/enterprise-leads';
const VALID = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  company: 'Analytical Engines Ltd',
  fleetSize: '11-100',
  need: 'Contracted retention for receipts from our support agents.',
};

let fetchMock: Mock;
let logged: string[];

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  logged = [];
  for (const level of ['error', 'warn', 'log', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  }
  vi.stubEnv('CONTACT_FORWARD_URL', FORWARD_URL);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const postJson = (body: unknown) =>
  POST(
    new Request('http://site.test/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

const postForm = (fields: Record<string, string>) =>
  POST(
    new Request('http://site.test/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    }),
  );

/** The response body and every log line, for checking the forward URL leaks nowhere. */
async function exposed(res: Response): Promise<string> {
  return [await res.clone().text(), JSON.stringify([...res.headers]), ...logged].join('\n');
}

describe('valid submission', () => {
  it('forwards the fields as JSON to CONTACT_FORWARD_URL and answers 200', async () => {
    const res = await postJson(VALID);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(FORWARD_URL);
    expect(init.method).toBe('POST');
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject(VALID);
    expect(sent).not.toHaveProperty(HONEYPOT_FIELD);
    expect(typeof sent.submittedAt).toBe('string');
  });

  it('accepts every fleet size the form offers', async () => {
    for (const fleetSize of FLEET_SIZES) {
      expect((await postJson({ ...VALID, fleetSize })).status, fleetSize).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(FLEET_SIZES.length);
  });

  it('redirects a native form post back to the page with the outcome', async () => {
    const res = await postForm({ ...VALID, [HONEYPOT_FIELD]: '' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/enterprise?contact=sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never echoes or logs the forward URL', async () => {
    expect(await exposed(await postJson(VALID))).not.toContain('forward.example.test');
  });
});

describe('invalid submission', () => {
  it('names every missing required field and forwards nothing', async () => {
    const res = await postJson({ email: VALID.email });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('name, company, fleetSize, need');
    expect(error.fix.note).toContain('fleetSize');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats whitespace-only fields as missing', async () => {
    const res = await postJson({ ...VALID, company: '   ' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('company');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['ada', 'ada@', '@example.com', 'ada@example', 'ada lovelace@example.com', 'ada@@example.com'])(
    'rejects the email %j',
    async (email) => {
      const res = await postJson({ ...VALID, email });
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toContain('email');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('rejects a fleet size the form does not offer', async () => {
    const res = await postJson({ ...VALID, fleetSize: 'lots' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('fleetSize must be one of');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an over-long field', async () => {
    const res = await postJson({ ...VALID, name: 'a'.repeat(201) });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a body that is not a JSON object', async () => {
    for (const body of ['not json', '[1,2]', 'null']) {
      const res = await postJson(body);
      expect(res.status, body).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized body', async () => {
    const res = await postJson({ ...VALID, need: 'x'.repeat(20 * 1024) });
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redirects an invalid form post back with contact=invalid', async () => {
    const res = await postForm({ ...VALID, email: 'not-an-email' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/enterprise?contact=invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('honeypot', () => {
  it('answers a filled honeypot like a success and forwards nothing', async () => {
    const res = await postJson({ ...VALID, [HONEYPOT_FIELD]: 'https://spam.example' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does the same for a form post, even when the other fields are junk', async () => {
    const res = await postForm({ name: 'x', [HONEYPOT_FIELD]: 'filled' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/enterprise?contact=sent');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('CONTACT_FORWARD_URL unset', () => {
  /** The response body and headers only, without the log. */
  const answered = async (res: Response) => [await res.clone().text(), JSON.stringify([...res.headers])].join('\n');

  /** The request id the response carries, after checking the log names the variable under it. */
  const requestIdLogged = (res: Response) => {
    const requestId = res.headers.get('x-request-id');
    expect(requestId).toBeTruthy();
    expect(logged.some((line) => line.includes(String(requestId)) && line.includes('CONTACT_FORWARD_URL'))).toBe(true);
    return requestId;
  };

  it('returns a generic 503 with a request id and forwards nothing', async () => {
    vi.stubEnv('CONTACT_FORWARD_URL', '');
    const res = await postJson(VALID);
    expect(res.status).toBe(503);
    const requestId = requestIdLogged(res);
    const body = await res.clone().json();
    expect(body.requestId).toBe(requestId);
    expect(body.error.code).toBe('CONTACT_UNAVAILABLE');
    expect(body.error.message).toBe('Enterprise contact is not configured on this server yet. Nothing was sent.');
    expect(body.error.fix.note).toContain(BRAND.repository);
    expect(body.error.fix.note).toContain(String(requestId));
    expect(await answered(res)).not.toContain('CONTACT_FORWARD_URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a missing variable the same as an empty one', async () => {
    delete process.env.CONTACT_FORWARD_URL;
    const res = await postJson(VALID);
    expect(res.status).toBe(503);
    requestIdLogged(res);
    expect(await answered(res)).not.toContain('CONTACT_FORWARD_URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redirects a form post back with contact=unavailable and a request id', async () => {
    delete process.env.CONTACT_FORWARD_URL;
    const res = await postForm(VALID);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/enterprise?contact=unavailable');
    requestIdLogged(res);
    expect(await answered(res)).not.toContain('CONTACT_FORWARD_URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a value that is not an http(s) URL as unset, without logging it', async () => {
    vi.stubEnv('CONTACT_FORWARD_URL', 'ftp://forward.example.test/leads');
    const res = await postJson(VALID);
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    const requestId = requestIdLogged(res);
    expect(logged.join('\n')).toContain('not an http(s) URL');
    expect((await res.clone().json()).requestId).toBe(requestId);
    expect(await answered(res)).not.toContain('CONTACT_FORWARD_URL');
    expect(await exposed(res)).not.toContain('forward.example.test');
  });

  it('answers a form post the same way when the value is not an http(s) URL', async () => {
    vi.stubEnv('CONTACT_FORWARD_URL', 'javascript:alert(1)');
    const res = await postForm(VALID);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/enterprise?contact=unavailable');
    requestIdLogged(res);
    expect(await answered(res)).not.toContain('CONTACT_FORWARD_URL');
    expect(await exposed(res)).not.toContain('alert');
  });
});

describe('forward failure', () => {
  it('returns 502 when the target rejects, without echoing or logging the URL', async () => {
    fetchMock.mockResolvedValueOnce(new Response(`bad request to ${FORWARD_URL}`, { status: 400 }));
    const res = await postJson(VALID);
    expect(res.status).toBe(502);
    const body = await res.clone().json();
    expect(body.error).toMatchObject({ code: 'CONTACT_FORWARD_FAILED', retryable: true });
    expect(logged.join('\n')).toContain('HTTP 400');
    expect(await exposed(res)).not.toContain('forward.example.test');
  });

  it('returns 502 when fetch throws, even if the error message carries the URL', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed: ${FORWARD_URL}`));
    const res = await postJson(VALID);
    expect(res.status).toBe(502);
    expect(logged.join('\n')).toContain('TypeError');
    expect(await exposed(res)).not.toContain('forward.example.test');
  });

  it('redirects a form post back with contact=failed', async () => {
    fetchMock.mockRejectedValueOnce(new Error('down'));
    const res = await postForm(VALID);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/enterprise?contact=failed');
  });
});

describe('enterprise page', () => {
  const render = async (contact?: string) =>
    renderToStaticMarkup(await EnterprisePage({ searchParams: Promise.resolve(contact ? { contact } : {}) }));

  it('posts a form with every required field to the contact route', async () => {
    const html = await render();
    expect(html).toContain('action="/api/contact"');
    expect(html).toContain('method="post"');
    // React does not keep attribute order, so find each element and then check it.
    const field = (name: string) =>
      new RegExp(`<(input|select|textarea)\\b[^>]*\\bname="${name}"[^>]*>`).exec(html)?.[0] ?? '';
    for (const name of ['name', 'email', 'company', 'fleetSize', 'need']) {
      expect(field(name), name).toContain('required=""');
    }
    expect(field('email')).toContain('type="email"');
    for (const size of FLEET_SIZES) expect(html).toContain(`value="${size}"`);
  });

  it('carries an off-screen honeypot that is not marked required', async () => {
    const html = await render();
    const honeypot = new RegExp(`<input[^>]*name="${HONEYPOT_FIELD}"[^>]*>`).exec(html)?.[0];
    expect(honeypot).toBeDefined();
    expect(honeypot).toContain('tabindex="-1"');
    expect(honeypot).not.toContain('required');
    expect(html).toMatch(/aria-hidden="true" style="position:absolute;left:-10000px/);
  });

  it('says when the team will reply', async () => {
    expect(await render()).toContain('We reply within two business days.');
  });

  it('shows no dollar figure', async () => {
    expect(await render()).not.toMatch(/\$\s*\d|USD|per month|\/mo\b/i);
  });

  it('takes brand text from BRAND', async () => {
    expect(metadata.title).toBe(`Enterprise: ${BRAND.name}`);
    expect(metadata.description).toContain(BRAND.name);
  });

  it('shows the outcome a form post redirected back with, and nothing for an unknown one', async () => {
    expect(await render('sent')).toContain(`<p role="status">Thanks. The ${BRAND.name} team has your message`);
    expect(await render('unavailable')).toContain('not configured yet, so nothing was sent');
    expect(await render('<script>')).not.toContain('role="status"');
    expect(await render()).not.toContain('role="status"');
  });
});

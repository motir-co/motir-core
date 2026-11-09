import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { WEBHOOK_ANSWER_LOG_PREFIX } from '@/lib/github/webhookAnswerLog';

// Story 7.10 · MOTIR-892 — the webhook ROUTE: signature verification is the gate,
// and it runs BEFORE the body is parsed or the service is touched. Real Postgres
// harness (the service is invoked on the happy path); no session mock — a webhook
// authenticates by HMAC signature, not a cookie.

const SECRET = 'test-webhook-secret';

function sign(rawBody: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
}

function post(rawBody: string, headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost:3000/api/github/webhook', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

async function importRoute() {
  const mod = await import('@/app/api/github/webhook/route');
  return mod.POST;
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('POST /api/github/webhook — signature gate', () => {
  it('rejects a MISSING signature 401 (before processing)', async () => {
    const POST = await importRoute();
    const body = JSON.stringify({ zen: 'x' });
    const res = await POST(post(body, { 'x-github-event': 'ping' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'GITHUB_WEBHOOK_INVALID_SIGNATURE' });
  });

  it('rejects a BAD signature 401', async () => {
    const POST = await importRoute();
    const body = JSON.stringify({ zen: 'x' });
    const res = await POST(
      post(body, { 'x-github-event': 'ping', 'x-hub-signature-256': 'sha256=deadbeef' }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a signature computed over a DIFFERENT body 401 (tamper)', async () => {
    const POST = await importRoute();
    const signed = sign(JSON.stringify({ a: 1 }));
    const tampered = JSON.stringify({ a: 2 });
    const res = await POST(
      post(tampered, { 'x-github-event': 'ping', 'x-hub-signature-256': signed }),
    );
    expect(res.status).toBe(401);
  });

  it('accepts a VALID signature and processes the event (200)', async () => {
    const POST = await importRoute();
    const body = JSON.stringify({ zen: 'Keep it simple' });
    const res = await POST(
      post(body, { 'x-github-event': 'ping', 'x-hub-signature-256': sign(body) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, result: { event: 'ignored' } });
  });

  it('returns 500 when the webhook secret is not configured', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', '');
    const POST = await importRoute();
    const body = JSON.stringify({ zen: 'x' });
    const res = await POST(
      post(body, { 'x-github-event': 'ping', 'x-hub-signature-256': 'sha256=abc' }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'GITHUB_WEBHOOK_NOT_CONFIGURED' });
  });

  it('returns 400 on a malformed JSON body (signature valid)', async () => {
    const POST = await importRoute();
    const body = 'not json{';
    const res = await POST(
      post(body, { 'x-github-event': 'ping', 'x-hub-signature-256': sign(body) }),
    );
    expect(res.status).toBe(400);
  });
});

// Bug MOTIR-10804 — every non-2xx answer writes ONE log line naming its status, code,
// delivery id and event, and never the payload or the signature. Without it a refused
// delivery cannot be told from one GitHub never sent.
describe('POST /api/github/webhook — every non-2xx answer is logged', () => {
  const DELIVERY = '10804-delivery-guid';
  const SECRET_FIELD = 'do-not-log-this-payload-value';

  /** Spies on both log levels and answers the parsed answer-log lines written. */
  function captureLogs() {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lines = (spy: typeof warn) =>
      spy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith(WEBHOOK_ANSWER_LOG_PREFIX));
    const parse = (line: string) =>
      JSON.parse(line.slice(WEBHOOK_ANSWER_LOG_PREFIX.length + 1)) as Record<string, unknown>;
    return {
      warnLines: () => lines(warn),
      errorLines: () => lines(error),
      parse,
    };
  }

  it('logs a 401 (bad signature) with status, code, delivery id and event — never the payload or signature', async () => {
    const logs = captureLogs();
    const POST = await importRoute();
    const body = JSON.stringify({ secret: SECRET_FIELD });
    const res = await POST(
      post(body, {
        'x-github-event': 'pull_request',
        'x-github-delivery': DELIVERY,
        'x-hub-signature-256': 'sha256=deadbeef',
      }),
    );
    expect(res.status).toBe(401);
    expect(logs.errorLines()).toEqual([]);
    const lines = logs.warnLines();
    expect(lines).toHaveLength(1);
    expect(logs.parse(lines[0]!)).toEqual({
      status: 401,
      code: 'GITHUB_WEBHOOK_INVALID_SIGNATURE',
      deliveryId: DELIVERY,
      event: 'pull_request',
      bodyBytes: Buffer.byteLength(body),
    });
    expect(lines[0]).not.toContain(SECRET_FIELD);
    expect(lines[0]).not.toContain('deadbeef');
  });

  it('logs a 401 for a MISSING signature too, with a null delivery id when none was sent', async () => {
    const logs = captureLogs();
    const POST = await importRoute();
    const res = await POST(post(JSON.stringify({ zen: 'x' }), { 'x-github-event': 'ping' }));
    expect(res.status).toBe(401);
    expect(logs.warnLines().map(logs.parse)).toEqual([
      expect.objectContaining({ status: 401, deliveryId: null, event: 'ping' }),
    ]);
  });

  it('logs a 500 (secret not configured) at error level', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', '');
    const logs = captureLogs();
    const POST = await importRoute();
    const body = JSON.stringify({ secret: SECRET_FIELD });
    const res = await POST(
      post(body, {
        'x-github-event': 'check_run',
        'x-github-delivery': DELIVERY,
        'x-hub-signature-256': 'sha256=abc',
      }),
    );
    expect(res.status).toBe(500);
    expect(logs.warnLines()).toEqual([]);
    const lines = logs.errorLines();
    expect(lines).toHaveLength(1);
    expect(logs.parse(lines[0]!)).toEqual({
      status: 500,
      code: 'GITHUB_WEBHOOK_NOT_CONFIGURED',
      deliveryId: DELIVERY,
      event: 'check_run',
      bodyBytes: Buffer.byteLength(body),
    });
    expect(lines[0]).not.toContain(SECRET_FIELD);
  });

  it('logs a 400 (malformed body) without the body', async () => {
    const logs = captureLogs();
    const POST = await importRoute();
    const body = `{"secret":"${SECRET_FIELD}"`;
    const res = await POST(
      post(body, {
        'x-github-event': 'pull_request',
        'x-github-delivery': DELIVERY,
        'x-hub-signature-256': sign(body),
      }),
    );
    expect(res.status).toBe(400);
    const lines = logs.warnLines();
    expect(lines).toHaveLength(1);
    expect(logs.parse(lines[0]!)).toEqual({
      status: 400,
      code: 'GITHUB_WEBHOOK_MALFORMED_BODY',
      deliveryId: DELIVERY,
      event: 'pull_request',
      bodyBytes: Buffer.byteLength(body),
    });
    expect(lines[0]).not.toContain(SECRET_FIELD);
    expect(lines[0]).not.toContain(sign(body));
  });

  it('logs a 400 (handled event with no delivery id)', async () => {
    const logs = captureLogs();
    const POST = await importRoute();
    const body = JSON.stringify({ action: 'closed', secret: SECRET_FIELD });
    const res = await POST(
      post(body, { 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(body) }),
    );
    expect(res.status).toBe(400);
    const lines = logs.warnLines();
    expect(lines).toHaveLength(1);
    expect(logs.parse(lines[0]!)).toEqual({
      status: 400,
      code: 'GITHUB_WEBHOOK_MISSING_DELIVERY_ID',
      deliveryId: null,
      event: 'pull_request',
      bodyBytes: Buffer.byteLength(body),
    });
    expect(lines[0]).not.toContain(SECRET_FIELD);
  });

  it('logs an UNHANDLED_ERROR 500 for a throw that escapes the handler, and re-throws it', async () => {
    const logs = captureLogs();
    // The SAME module registry the route's dynamic import resolves into (modules are
    // reset after every test), so the spy is on the instance the route calls.
    const { githubWebhookInboxService } = await import('@/lib/services/githubWebhookInboxService');
    vi.spyOn(githubWebhookInboxService, 'receive').mockRejectedValue(new Error('inbox down'));
    const POST = await importRoute();
    const body = JSON.stringify({ action: 'closed' });
    await expect(
      POST(
        post(body, {
          'x-github-event': 'pull_request',
          'x-github-delivery': DELIVERY,
          'x-hub-signature-256': sign(body),
        }),
      ),
    ).rejects.toThrow('inbox down');
    expect(logs.errorLines().map(logs.parse)).toEqual([
      {
        status: 500,
        code: 'UNHANDLED_ERROR',
        deliveryId: DELIVERY,
        event: 'pull_request',
        bodyBytes: null,
      },
    ]);
  });

  it('writes NO answer line for a 2xx answer', async () => {
    const logs = captureLogs();
    const POST = await importRoute();
    const body = JSON.stringify({ zen: 'Keep it simple' });
    const res = await POST(
      post(body, {
        'x-github-event': 'ping',
        'x-github-delivery': DELIVERY,
        'x-hub-signature-256': sign(body),
      }),
    );
    expect(res.status).toBe(200);
    expect(logs.warnLines()).toEqual([]);
    expect(logs.errorLines()).toEqual([]);
  });
});

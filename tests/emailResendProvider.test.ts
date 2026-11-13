import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMAIL_PERMANENT_FAILURE_CODE,
  EMAIL_QUOTA_EXHAUSTED_CODE,
  EMAIL_TRANSIENT_FAILURE_CODE,
  EmailDeliveryError,
  getEmailProvider,
  resendIdempotencyKey,
} from '@/lib/email';

// The production email provider (MOTIR-1127): the `resend` arm of
// getEmailProvider(). Every test here stubs global fetch — nothing in this file
// touches the network, and no test needs the live RESEND_API_KEY (the real one
// is a Fly secret on motir-core, provisioned by MOTIR-1123).
//
// What's under test is the three things the card's acceptance criteria name:
// the request we build, the Idempotency-Key derived from the job's own
// idempotencyKey, and the transient/permanent split that decides whether a
// failure is retried or dead-lettered.

const API_KEY = 'test-resend-key';
const FROM = 'Motir <no-reply@motir.co>';

/** A 200 the way Resend actually answers a send: the message id, nothing else. */
function acceptedResponse(): Response {
  return new Response(JSON.stringify({ id: 'a3f1c2d4-0000-4000-8000-000000000001' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A Resend error envelope: `{ statusCode, name, message }` at the documented status. */
function errorResponse(status: number, name: string, message: string): Response {
  return new Response(JSON.stringify({ statusCode: status, name, message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('resendProvider', () => {
  const original: Record<string, string | undefined> = {};
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const key of ['EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM']) {
      original[key] = process.env[key];
    }
    process.env['EMAIL_PROVIDER'] = 'resend';
    process.env['RESEND_API_KEY'] = API_KEY;
    process.env['EMAIL_FROM'] = FROM;
    fetchMock = vi.fn().mockResolvedValue(acceptedResponse());
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** The single fetch call's (url, init) pair, with the body parsed. */
  function lastRequest() {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return {
      url,
      init,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
    };
  }

  describe('the request it builds', () => {
    it('POSTs the message to the Resend emails endpoint with the bearer key', async () => {
      const provider = getEmailProvider();
      await provider({
        to: 'alice@example.com',
        subject: 'Reset your password',
        html: '<p>Body</p>',
        text: 'Body',
      });

      const { url, init, headers, body } = lastRequest();
      expect(url).toBe('https://api.resend.com/emails');
      expect(init.method).toBe('POST');
      expect(headers['Authorization']).toBe(`Bearer ${API_KEY}`);
      expect(headers['Content-Type']).toBe('application/json');
      expect(body).toMatchObject({
        from: FROM,
        to: 'alice@example.com',
        subject: 'Reset your password',
        html: '<p>Body</p>',
        text: 'Body',
      });
    });

    it('sends a text part derived from the html when the caller omitted one', async () => {
      const provider = getEmailProvider();
      await provider({
        to: 'bob@example.com',
        subject: 'Reset your password',
        html: '<a href="https://motir.co/reset?token=abc123">Reset</a>',
      });

      // The stripped fallback keeps the link intact — an html-only message is
      // both spam-scored and unreadable in a plain-text client.
      expect(lastRequest().body['text']).toContain('https://motir.co/reset?token=abc123');
    });

    it('resolves EMAIL_FROM once, at provider resolution, not per send', async () => {
      const provider = getEmailProvider();
      process.env['EMAIL_FROM'] = 'Someone Else <else@example.com>';
      await provider({ to: 'carol@example.com', subject: 's', html: '<p>h</p>' });

      // The sender identity a deploy booted with is the one it sends as — a
      // mid-flight env mutation cannot re-point the From header.
      expect(lastRequest().body['from']).toBe(FROM);
    });
  });

  describe('provider idempotency (the retry cannot double-deliver)', () => {
    it("passes the job's idempotencyKey through as the Idempotency-Key header", async () => {
      const provider = getEmailProvider();
      await provider({
        to: 'alice@example.com',
        subject: 'Reset your password',
        html: '<p>Body</p>',
        idempotencyKey: 'reset-token-9f8e7d6c',
      });

      expect(lastRequest().headers['Idempotency-Key']).toBe('reset-token-9f8e7d6c');
    });

    it('sends the SAME header on a repeat of the same send, so the provider dedups it', async () => {
      const provider = getEmailProvider();
      const msg = {
        to: 'alice@example.com',
        subject: 'Reset your password',
        html: '<p>Body</p>',
        idempotencyKey: 'reset-token-9f8e7d6c',
      };
      await provider(msg);
      await provider(msg);

      const keys = fetchMock.mock.calls.map(
        (call) => (call[1] as RequestInit).headers as Record<string, string>,
      );
      expect(keys).toHaveLength(2);
      expect(keys[0]!['Idempotency-Key']).toBe(keys[1]!['Idempotency-Key']);
    });

    it('omits the header entirely when no key is supplied', async () => {
      const provider = getEmailProvider();
      await provider({ to: 'alice@example.com', subject: 's', html: '<p>h</p>' });

      // An empty Idempotency-Key is a 400 `invalid_idempotency_key`, so "no
      // key" must mean "no header", never an empty one.
      expect(lastRequest().headers).not.toHaveProperty('Idempotency-Key');
    });

    it('omits the header when the key is blank', async () => {
      const provider = getEmailProvider();
      await provider({
        to: 'alice@example.com',
        subject: 's',
        html: '<p>h</p>',
        idempotencyKey: '   ',
      });

      expect(lastRequest().headers).not.toHaveProperty('Idempotency-Key');
    });

    it('folds an over-long key to its SHA-256 rather than truncating it', async () => {
      const longKey = 'k'.repeat(300);
      const provider = getEmailProvider();
      await provider({
        to: 'alice@example.com',
        subject: 's',
        html: '<p>h</p>',
        idempotencyKey: longKey,
      });

      const sent = lastRequest().headers['Idempotency-Key']!;
      expect(sent).toBe(createHash('sha256').update(longKey).digest('hex'));
      expect(sent).toHaveLength(64);
      // Truncation would map two different long keys to one header and drop a
      // real email as a "duplicate"; hashing keeps them distinct.
      expect(resendIdempotencyKey(longKey)).not.toBe(resendIdempotencyKey(`${longKey}x`));
    });
  });

  describe('failure classification', () => {
    /** Run one send that is expected to reject, and hand back the typed error. */
    async function sendExpectingFailure(response: Response | Error): Promise<EmailDeliveryError> {
      fetchMock.mockReset();
      if (response instanceof Error) fetchMock.mockRejectedValue(response);
      else fetchMock.mockResolvedValue(response);
      const provider = getEmailProvider();
      const err = await provider({
        to: 'alice@example.com',
        subject: 's',
        html: '<p>h</p>',
        idempotencyKey: 'k',
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(EmailDeliveryError);
      return err as EmailDeliveryError;
    }

    it('treats a 500 as transient, so Inngest retries it', async () => {
      const err = await sendExpectingFailure(
        errorResponse(500, 'internal_server_error', 'Something went wrong'),
      );
      expect(err.kind).toBe('transient');
      expect(err.code).toBe(EMAIL_TRANSIENT_FAILURE_CODE);
      expect(err.status).toBe(500);
    });

    it('treats a 429 rate limit as transient', async () => {
      const err = await sendExpectingFailure(
        errorResponse(429, 'rate_limit_exceeded', 'Too many requests'),
      );
      expect(err.kind).toBe('transient');
      expect(err.code).toBe(EMAIL_TRANSIENT_FAILURE_CODE);
      expect(err.retryable).toBe(true);
    });

    // MOTIR-5873. The same status as a rate limit, and the opposite meaning:
    // the account's quota is spent and nothing clears it for hours. Production
    // dead-lettered 277 of these as EMAIL_TRANSIENT_FAILURE after burning the
    // retry budget minutes apart against the exhausted quota.
    it('treats a 429 DAILY QUOTA as its own non-retryable kind, not a rate limit', async () => {
      const err = await sendExpectingFailure(
        errorResponse(
          429,
          'daily_quota_exceeded',
          'You have reached your daily email sending quota.',
        ),
      );
      expect(err.kind).toBe('quota_exhausted');
      expect(err.code).toBe(EMAIL_QUOTA_EXHAUSTED_CODE);
      // The property the job worker reads to dead-letter on this attempt.
      expect(err.retryable).toBe(false);
      expect(err.status).toBe(429);
      expect(err.providerErrorName).toBe('daily_quota_exceeded');
      // What an operator reads on the dead-letter row names the real cause.
      expect(err.message).toContain('quota is exhausted');
      expect(err.message).toContain('daily_quota_exceeded');
      expect(err.message).not.toContain('transiently');
    });

    it('treats a 429 MONTHLY quota the same way', async () => {
      const err = await sendExpectingFailure(
        errorResponse(429, 'monthly_quota_exceeded', 'You have reached your monthly quota.'),
      );
      expect(err.kind).toBe('quota_exhausted');
      expect(err.code).toBe(EMAIL_QUOTA_EXHAUSTED_CODE);
      expect(err.retryable).toBe(false);
    });

    it('keeps a 429 with NO error name transient — only the name moves it to quota', async () => {
      const err = await sendExpectingFailure(new Response('', { status: 429 }));
      expect(err.kind).toBe('transient');
      expect(err.retryable).toBe(true);
    });

    it('keeps a quota NAME on any status other than 429 out of the quota class', async () => {
      // The classification keys on the pair, so a name alone reclassifies nothing.
      const err = await sendExpectingFailure(
        errorResponse(403, 'daily_quota_exceeded', 'unexpected pairing'),
      );
      expect(err.kind).toBe('permanent');
    });

    it('treats a 408 request timeout as transient and retryable', async () => {
      const err = await sendExpectingFailure(errorResponse(408, 'request_timeout', 'Timed out'));
      expect(err.kind).toBe('transient');
      expect(err.code).toBe(EMAIL_TRANSIENT_FAILURE_CODE);
      expect(err.retryable).toBe(true);
    });

    it('treats a 503 as transient and retryable', async () => {
      const err = await sendExpectingFailure(
        errorResponse(503, 'service_unavailable', 'Try again later'),
      );
      expect(err.kind).toBe('transient');
      expect(err.retryable).toBe(true);
    });

    it('treats a network failure with no response as transient', async () => {
      const err = await sendExpectingFailure(new TypeError('fetch failed'));
      expect(err.kind).toBe('transient');
      expect(err.status).toBeUndefined();
      expect(err.message).toContain('before a response was received');
      expect(err.message).toContain('fetch failed');
    });

    it('treats a concurrent same-key 409 as transient — the key is still in flight', async () => {
      const err = await sendExpectingFailure(
        errorResponse(409, 'concurrent_idempotent_requests', 'Same key in flight'),
      );
      expect(err.kind).toBe('transient');
    });

    it('treats a 422 validation failure as permanent, and says why', async () => {
      const err = await sendExpectingFailure(
        errorResponse(422, 'invalid_from_address', 'The from address is not verified'),
      );
      expect(err.kind).toBe('permanent');
      expect(err.code).toBe(EMAIL_PERMANENT_FAILURE_CODE);
      expect(err.status).toBe(422);
      expect(err.providerErrorName).toBe('invalid_from_address');
      // The message is what an operator reads off the dead-letter row, so it
      // must name the status, the provider's error and its explanation.
      expect(err.message).toContain('422');
      expect(err.message).toContain('invalid_from_address');
      expect(err.message).toContain('The from address is not verified');
      expect(err.message).toContain('alice@example.com');
    });

    it('treats a restricted (send-only misuse) 401 as permanent', async () => {
      const err = await sendExpectingFailure(
        errorResponse(401, 'restricted_api_key', 'This API key is restricted to only send emails'),
      );
      expect(err.kind).toBe('permanent');
    });

    it('treats a mismatched-payload 409 as permanent — a retry cannot fix the key reuse', async () => {
      const err = await sendExpectingFailure(
        errorResponse(409, 'invalid_idempotent_request', 'Key reused with a different payload'),
      );
      expect(err.kind).toBe('permanent');
    });

    it('still classifies when the error body is not JSON', async () => {
      const err = await sendExpectingFailure(
        new Response('<html>502 Bad Gateway</html>', { status: 502 }),
      );
      expect(err.kind).toBe('transient');
      expect(err.status).toBe(502);
      expect(err.providerErrorName).toBeUndefined();
    });

    it('still classifies when the error body is empty', async () => {
      const err = await sendExpectingFailure(new Response('', { status: 400 }));
      expect(err.kind).toBe('permanent');
      expect(err.status).toBe(400);
    });

    it('carries a string `code` that the dead-letter row can record', async () => {
      const err = await sendExpectingFailure(errorResponse(422, 'invalid_parameter', 'nope'));
      // defineJob's serializeFailure copies message/stack plus a STRING `code`
      // onto job_run_dlq — this is the field that makes the classification
      // visible to the operator dashboard rather than only in prose.
      expect(typeof err.code).toBe('string');
      expect(err.stack).toBeDefined();
    });
  });

  describe('the accepted message id (MOTIR-3513)', () => {
    // Resend answers an accepted send with `{ id }`, and until MOTIR-3513 that
    // body was read by nothing — the success arm was a bare `if (res.ok)
    // return;`. The id is the only key a later delivery event can be joined
    // back to the send that produced it, so keeping it is the whole point.
    it('returns the id Resend answered with', async () => {
      const provider = getEmailProvider();
      const result = await provider({
        to: 'alice@example.com',
        subject: 'Reset your password',
        html: '<p>Body</p>',
      });

      expect(result.providerMessageId).toBe('a3f1c2d4-0000-4000-8000-000000000001');
    });

    // The three arms below all describe a message Resend HAS ALREADY TAKEN.
    // Throwing on any of them would fail a job whose email is on its way, and
    // the retry would deliver it a second time — so each is a successful send
    // with no handle, never an error.
    it('is a successful send with a null id when the accepted body does not parse', async () => {
      fetchMock.mockResolvedValue(new Response('not json at all', { status: 200 }));
      const provider = getEmailProvider();

      const result = await provider({ to: 'a@example.com', subject: 's', html: '<p>b</p>' });

      expect(result.providerMessageId).toBeNull();
    });

    it('is a successful send with a null id when the accepted body carries no id', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const provider = getEmailProvider();

      const result = await provider({ to: 'a@example.com', subject: 's', html: '<p>b</p>' });

      expect(result.providerMessageId).toBeNull();
    });

    it('is a successful send with a null id when the accepted body is empty', async () => {
      fetchMock.mockResolvedValue(new Response('', { status: 202 }));
      const provider = getEmailProvider();

      const result = await provider({ to: 'a@example.com', subject: 's', html: '<p>b</p>' });

      expect(result.providerMessageId).toBeNull();
    });

    it('ignores a non-string id rather than recording a number as a handle', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ id: 12345 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const provider = getEmailProvider();

      const result = await provider({ to: 'a@example.com', subject: 's', html: '<p>b</p>' });

      expect(result.providerMessageId).toBeNull();
    });

    it('leaves the FAILURE path exactly as it was — a rejected send still throws', async () => {
      fetchMock.mockResolvedValue(errorResponse(422, 'validation_error', 'bad address'));
      const provider = getEmailProvider();

      await expect(provider({ to: 'nope', subject: 's', html: '<p>b</p>' })).rejects.toBeInstanceOf(
        EmailDeliveryError,
      );
    });
  });

  describe('boot-time credential checks', () => {
    it('throws at resolution when RESEND_API_KEY is unset', () => {
      delete process.env['RESEND_API_KEY'];
      expect(() => getEmailProvider()).toThrowError(/requires RESEND_API_KEY/);
    });

    it('throws at resolution when RESEND_API_KEY is empty', () => {
      process.env['RESEND_API_KEY'] = '   ';
      expect(() => getEmailProvider()).toThrowError(/requires RESEND_API_KEY/);
    });

    it('throws at resolution when EMAIL_FROM is unset', () => {
      delete process.env['EMAIL_FROM'];
      expect(() => getEmailProvider()).toThrowError(/requires EMAIL_FROM/);
    });

    it('names how to set the missing value on the deployment', () => {
      delete process.env['RESEND_API_KEY'];
      expect(() => getEmailProvider()).toThrowError(
        /on ECS: RESEND_API_KEY in the task definition's secrets/,
      );
    });

    it('does not reach the network when credentials are missing', () => {
      delete process.env['RESEND_API_KEY'];
      expect(() => getEmailProvider()).toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe('resendIdempotencyKey', () => {
  it('passes a key of exactly the 256-char limit through unchanged', () => {
    const key = 'k'.repeat(256);
    expect(resendIdempotencyKey(key)).toBe(key);
  });

  it('hashes one character past the limit', () => {
    expect(resendIdempotencyKey('k'.repeat(257))).toHaveLength(64);
  });

  it('returns undefined for an absent or blank key', () => {
    expect(resendIdempotencyKey(undefined)).toBeUndefined();
    expect(resendIdempotencyKey('')).toBeUndefined();
    expect(resendIdempotencyKey('\t \n')).toBeUndefined();
  });

  it('trims surrounding whitespace so a padded key still matches its twin', () => {
    expect(resendIdempotencyKey('  token-1  ')).toBe('token-1');
  });
});

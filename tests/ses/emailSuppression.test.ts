import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emailSuppressionService,
  normalizeEmailAddress,
} from '@/lib/services/emailSuppressionService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The suppression list and the send path that reads it (MOTIR-10565), against
// a real Postgres. Two properties matter beyond the round trip:
//
//   1. The table is FORCE row-level security with a system-only policy, so a
//      read that forgot the system context would see NO row and let every
//      suppressed address through. The service reads it under that context.
//   2. Every send checks it FIRST — before the notification budget, before the
//      template renders, before any provider is called — and for every
//      template, password reset included.

describe('emailSuppressionService', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('normalises addresses by trimming and lower-casing', () => {
    expect(normalizeEmailAddress('  Ada@Example.COM\n')).toBe('ada@example.com');
  });

  it('suppresses and then reports an address, whatever its case', async () => {
    expect(await emailSuppressionService.isSuppressed('ada@example.com')).toBe(false);

    const written = await emailSuppressionService.suppress([
      { address: 'Ada@Example.com', reason: 'bounce', provider: 'ses' },
      { address: '   ', reason: 'bounce', provider: 'ses' },
    ]);

    expect(written).toEqual(['ada@example.com']);
    expect(await emailSuppressionService.isSuppressed(' ADA@example.com ')).toBe(true);
    expect(await emailSuppressionService.isSuppressed('other@example.com')).toBe(false);
    expect(await emailSuppressionService.isSuppressed('  ')).toBe(false);
    const [row] = await adminDb.emailSuppression.findMany();
    expect(row).toMatchObject({ detail: null, providerMessageId: null });
  });

  it('writes nothing for a list of blank addresses', async () => {
    expect(
      await emailSuppressionService.suppress([
        { address: '', reason: 'complaint', provider: 'ses' },
      ]),
    ).toEqual([]);
    expect(await adminDb.emailSuppression.count()).toBe(0);
  });
});

describe('emailService.send and the suppression list', () => {
  const original: Record<string, string | undefined> = {};
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await truncateAuthTables();
    for (const key of ['EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM'])
      original[key] = process.env[key];
    process.env['EMAIL_PROVIDER'] = 'resend';
    process.env['RESEND_API_KEY'] = 'test-resend-key';
    process.env['EMAIL_FROM'] = 'Motir <no-reply@motir.co>';
    fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ id: 'a3f1c2d4-0000-4000-8000-000000000003' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  });

  const reset = (to: string) => ({
    to,
    template: 'password-reset' as const,
    data: { recipientName: 'Ada', resetUrl: 'https://app.motir.co/reset-password/tok_1' },
  });

  it('skips a suppressed recipient with a log line, and never calls the provider', async () => {
    const { emailService } = await import('@/lib/services/emailService');
    const suppression = await import('@/lib/services/emailSuppressionService');
    await suppression.emailSuppressionService.suppress([
      { address: 'ada@example.com', reason: 'bounce', provider: 'ses' },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await emailService.send(
      reset('ADA@example.com') as Parameters<typeof emailService.send>[0],
    );

    expect(result).toEqual({ providerMessageId: null, skipped: 'recipient_suppressed' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /password-reset to 'ADA@example\.com' skipped: the address is on the suppression list/,
      ),
    );
  });

  it('sends to an address that is not suppressed', async () => {
    const { emailService } = await import('@/lib/services/emailService');

    const result = await emailService.send(
      reset('bob@example.com') as Parameters<typeof emailService.send>[0],
    );

    expect(result.skipped).toBeUndefined();
    expect(result.providerMessageId).toBe('a3f1c2d4-0000-4000-8000-000000000003');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

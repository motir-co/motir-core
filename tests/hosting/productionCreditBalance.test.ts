// MOTIR-12168 — the organisation's credit balance as the hosting paths read it
// (`productionCreditBalanceService`), and the promise that made it its own
// module: the production usage meter, which the job registry reaches through the
// release path, loads with no auth env. The docs-guard lane imports that
// registry with only a placeholder `DATABASE_URL`, and `@/lib/auth` throws at
// module scope without `BETTER_AUTH_SECRET`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OUT_OF_CREDITS_EXEMPT_APPLICATION_STATES } from '@/lib/hosting/vocabulary';
import {
  EXHAUSTED_SUSPEND_AFTER_MS,
  productionCreditBalanceService as credits,
} from '@/lib/services/productionCreditBalanceService';

let answer: { status: number; body: unknown } | 'throws' | 'throws-a-string';

beforeEach(() => {
  answer = { status: 200, body: { balance: 40 } };
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: string) => {
      if (!String(u).includes('/v1/usage')) throw new Error(`unexpected fetch: ${u}`);
      if (answer === 'throws') throw new TypeError('fetch failed');
      if (answer === 'throws-a-string') {
        // A body reader that rejects with something that is not an Error.
        return { ok: true, status: 200, json: () => Promise.reject('not json') } as never;
      }
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the balance read', () => {
  it('answers the balance motir-ai reports', async () => {
    answer = { status: 200, body: { balance: -12.5 } };
    expect(await credits.readOrganizationBalance('org-1')).toBe(-12.5);
  });

  it('answers null, never 0 or a throw, when motir-ai is down or unreachable', async () => {
    answer = { status: 503, body: {} };
    expect(await credits.readOrganizationBalance('org-1')).toBeNull();
    answer = 'throws';
    expect(await credits.readOrganizationBalance('org-1')).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not read an organisation’s balance'),
      expect.objectContaining({ organizationId: 'org-1' }),
    );
  });

  it('answers null when the failure is not even an Error', async () => {
    answer = 'throws-a-string';
    expect(await credits.readOrganizationBalance('org-1')).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: 'UNKNOWN' }),
    );
  });

  it('answers null when the answer carries no numeric balance', async () => {
    answer = { status: 200, body: { balance: 'n/a' } };
    expect(await credits.readOrganizationBalance('org-1')).toBeNull();
  });
});

describe('below zero', () => {
  const since = new Date('2026-11-20T00:00:00Z');

  it('decides by the live balance when it can be read', async () => {
    answer = { status: 200, body: { balance: -1 } };
    expect(await credits.isBelowZero('org-1', null)).toEqual({ below: true, balance: -1 });
    answer = { status: 200, body: { balance: 0 } };
    expect(await credits.isBelowZero('org-1', since)).toEqual({ below: false, balance: 0 });
  });

  it('falls back to the meter’s stored transition when the balance cannot be read', async () => {
    answer = { status: 503, body: {} };
    expect(await credits.isBelowZero('org-1', since)).toEqual({ below: true, balance: null });
    expect(await credits.isBelowZero('org-1', null)).toEqual({ below: false, balance: null });
  });
});

describe('suspend when idle', () => {
  it('follows the port’s idle-policy rule for the target and shape', () => {
    expect(credits.canSuspend({ target: 'fly', hostingShape: 'container' })).toBe(true);
    expect(credits.canSuspend({ target: 'aws', hostingShape: 'container' })).toBe(false);
  });

  it('switches an always-on application after 7 days below zero', () => {
    expect(EXHAUSTED_SUSPEND_AFTER_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

// MOTIR-12143 — the one selection the out-of-credits actions read through.
describe('which applications the out-of-credits actions act on', () => {
  const fly = { target: 'fly', hostingShape: 'container' } as const;

  it('leaves an application in its takeover grace window out (Decision MOTIR-9802)', () => {
    expect(OUT_OF_CREDITS_EXEMPT_APPLICATION_STATES).toEqual(['grace']);
    expect(credits.takesOutOfCreditsAction({ ...fly, state: 'grace' })).toBe(false);
  });

  it('acts on a live or handing-over application whose target can suspend', () => {
    for (const state of ['live', 'handing_over'] as const) {
      expect(credits.takesOutOfCreditsAction({ ...fly, state })).toBe(true);
    }
  });

  it('acts on no application whose target cannot suspend', () => {
    expect(
      credits.takesOutOfCreditsAction({ target: 'aws', hostingShape: 'container', state: 'live' }),
    ).toBe(false);
  });
});

describe('the job registry’s import graph', () => {
  it('loads the production usage meter with no auth env', async () => {
    vi.resetModules();
    vi.stubEnv('BETTER_AUTH_SECRET', '');
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');

    const meter = await import('@/lib/services/productionUsageMeterService');
    expect(meter).toBeDefined();
    await expect(import('@/lib/auth')).rejects.toThrow(/BETTER_AUTH_SECRET is not set/);
  });
});

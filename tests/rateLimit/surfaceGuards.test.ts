import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { truncateRateLimitCounters } from '@/tests/helpers/db';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import { RATE_LIMIT_DISABLE_ENV } from '@/lib/rateLimit/limiter';
import {
  classifyAuthRequest,
  authIdentifier,
  enforceAuthRateLimit,
} from '@/lib/rateLimit/authGuard';
import { enforcePublicWriteRateLimit } from '@/lib/rateLimit/publicWriteGuard';
import { enforcePublicReadRateLimit } from '@/lib/rateLimit/publicReadGuard';
import {
  enforceAiRateLimit,
  enforceInternalServiceRateLimit,
  enforceJobReadRateLimit,
} from '@/lib/rateLimit/aiGuard';
import {
  enforceMcpRateLimit,
  MCP_RATE_LIMITED_JSONRPC_CODE,
  mcpRateLimitedResponse,
} from '@/lib/rateLimit/mcpGuard';
import { billableToolDenial, isBillableTool, MCP_BILLABLE_TOOLS } from '@/lib/mcp/rateLimitGate';
import { MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import {
  DEFAULT_AI_RATE_LIMIT,
  DEFAULT_AI_GENERATE_RATE_LIMIT,
  DEFAULT_MCP_RATE_LIMIT,
  agentWorkspaceBudget,
  mcpBudget,
} from '@/lib/rateLimit/budgets';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { JobAuthError, JobRateLimitedError } from '@/lib/ai/jobAuth';
import { RATE_LIMITED_CODE, rateLimitedResponse } from '@/lib/rateLimit/guard';
import {
  ALIGNED_HEADROOM_MS,
  ALIGNED_WINDOW_MS,
  waitForWindowHeadroom,
} from '@/tests/helpers/rateLimitWindow';
import { pinSharedRateLimitStoreDeadline } from '@/tests/helpers/rateLimitStore';

// The three SURFACE guards (Subtask 8.5.9 / MOTIR-1165): which requests each one
// limits, what it keys on, and the axis it must NOT key on.
//
// Budgets come from the environment, so each case pins the ones it needs to a
// tiny number — that is the same mechanism a deployment uses, exercised.
//
// ── WINDOWS ARE PINNED, AND THE ACCUMULATING CASES ALIGN (MOTIR-2648) ────────
// Every budget here shares the epoch-aligned fixed window described in
// `tests/helpers/rateLimitWindow.ts`. Until MOTIR-2648 this file pinned the
// BUDGETS and left every window at the shipped 60 s default — while listing all
// six `*_WINDOW_MS` names in the cleanup array below, i.e. naming a knob it
// never set. That is the same shape MOTIR-2101 / -2224 / -2598 / -2647 each
// fixed one file at a time, at six times the scale.
//
// Two separate things now hold, and they are not interchangeable:
//
//  1. `beforeEach` PINS every window to `ALIGNED_WINDOW_MS`, derived from
//     `BUDGET_ENVS` so the two lists cannot drift. This is free, and it makes
//     the window an explicit property of every case rather than an inherited
//     default nobody chose.
//  2. A case that asserts a REFUSAL which depends on the calls BEFORE it must
//     additionally `await waitForWindowHeadroom(...)`, so its counted calls
//     cannot straddle a grid boundary and reset the counter mid-test. A case
//     that only asserts requests are ALLOWED does NOT need it: a straddle can
//     only ever allow MORE, so it cannot turn such a case red. That asymmetry is
//     why 25 of the cases here wait and the other 12 do not.
//
// ⚠️ The wait is `waitForWindowHeadroom`, not `waitForWindowBoundary`, and the
// difference was measured at 36 s. Aligning outright makes each case land ~20 ms
// into a fresh cell, so the NEXT case waits nearly a whole window rather than
// the half an isolated call would average — the phases are not independent. With
// `waitForWindowBoundary` this file and its two neighbours went 15.9 s → 52.4 s;
// with 500 ms of headroom they share a cell and sleep only when one is nearly
// spent, for 14.8 s, and this file alone 4.30 s → 4.39 s. Same guarantee, stated
// as a floor. The sizing argument lives with the constants in
// `tests/helpers/rateLimitWindow.ts`.
const BUDGET_ENVS = [
  'MOTIR_AUTH_RATE_LIMIT',
  'MOTIR_PASSWORD_RESET_RATE_LIMIT',
  'MOTIR_PUBLIC_WRITE_RATE_LIMIT',
  'MOTIR_PUBLIC_READ_RATE_LIMIT',
  'MOTIR_AI_RATE_LIMIT',
  'MOTIR_AI_GENERATE_RATE_LIMIT',
  'MOTIR_MCP_RATE_LIMIT',
  'MOTIR_AGENT_WORKSPACE_RATE_LIMIT',
] as const;

const WINDOW_ENVS = BUDGET_ENVS.map((name) => `${name}_WINDOW_MS`);

//
// ── AND THE STORE DEADLINE IS PINNED TOO (MOTIR-3067) ────────────────────────
// The window is one of two unstated preconditions a refusal assertion carries.
// The other is that the counter was REACHABLE inside the store's deadline —
// `createPostgresRateLimitStore()`'s production 250 ms — because
// `consumeSharedRateLimit` fails OPEN when it is not, and every `enforce*` guard
// below reads that decision. The 25 accumulating cases here therefore each
// assert, silently, that a shared CI Postgres answered one INSERT in under a
// quarter of a second. `beforeEach` now states that precondition instead:
// `tests/helpers/rateLimitStore.ts` for the sizing,
// `tests/rateLimit/storeDeadline.test.ts` for the guard.
const ENVS = [...BUDGET_ENVS, ...WINDOW_ENVS, RATE_LIMIT_DISABLE_ENV];

beforeEach(async () => {
  await truncateRateLimitCounters();
  __resetSharedRateLimitStoreForTest();
  // AFTER the reset — the reset drops exactly the override this installs.
  pinSharedRateLimitStoreDeadline();
  for (const key of ENVS) delete process.env[key];
  // Pin EVERY window, so no case silently inherits the shipped 60 s default.
  for (const key of WINDOW_ENVS) process.env[key] = String(ALIGNED_WINDOW_MS);
});
afterEach(() => {
  __resetSharedRateLimitStoreForTest();
  for (const key of ENVS) delete process.env[key];
});
afterAll(async () => {
  await db.$disconnect();
});

function authReq(path: string, body?: unknown, ip = '203.0.113.10'): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// ── AUTH ─────────────────────────────────────────────────────────────────────

describe('the auth surface', () => {
  it('classifies the credential-bearing paths and NOTHING else', () => {
    expect(classifyAuthRequest('/api/auth/sign-in/email')).toBe('auth:sign-in');
    expect(classifyAuthRequest('/api/auth/sign-up/email')).toBe('auth:sign-up');
    expect(classifyAuthRequest('/api/auth/request-password-reset')).toBe('auth:password-reset');
    expect(classifyAuthRequest('/api/auth/forget-password')).toBe('auth:password-reset');
    expect(classifyAuthRequest('/api/auth/reset-password')).toBe('auth:password-reset');
    // The OAuth server's registration and token POSTs (MOTIR-6982).
    expect(classifyAuthRequest('/api/auth/oauth2/register')).toBe('auth:oauth-register');
    expect(classifyAuthRequest('/api/auth/oauth2/token')).toBe('auth:oauth-token');
  });

  it('leaves the OAuth authorize, consent and revoke endpoints ALONE', () => {
    for (const path of [
      '/api/auth/oauth2/authorize',
      '/api/auth/oauth2/consent',
      '/api/auth/oauth2/revoke',
    ]) {
      expect(classifyAuthRequest(path)).toBeNull();
    }
  });

  it('leaves sign-out, session reads, OAuth callbacks and the device poll ALONE', () => {
    // The device grant polls every 5s BY DESIGN and has its own `slow_down`
    // throttle — a limiter there would break the normal flow, not an attack.
    for (const path of [
      '/api/auth/sign-out',
      '/api/auth/get-session',
      '/api/auth/callback/google',
      '/api/auth/device/token',
      '/api/auth/device/code',
    ]) {
      expect(classifyAuthRequest(path)).toBeNull();
    }
  });

  it('an unlimited path is never refused, however many times it is called', async () => {
    process.env['MOTIR_AUTH_RATE_LIMIT'] = '1';
    for (let i = 0; i < 5; i += 1) {
      expect(await enforceAuthRateLimit(authReq('/api/auth/sign-out'))).toBeNull();
    }
  });

  it('refuses the (N+1)-th sign-in from one IP with a 429 + Retry-After', async () => {
    process.env['MOTIR_AUTH_RATE_LIMIT'] = '3';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    for (let i = 0; i < 3; i += 1) {
      expect(
        await enforceAuthRateLimit(authReq('/api/auth/sign-in/email', { email: `u${i}@x.com` })),
      ).toBeNull();
    }
    const refused = await enforceAuthRateLimit(
      authReq('/api/auth/sign-in/email', { email: 'u4@x.com' }),
    );
    expect(refused).not.toBeNull();
    expect(refused!.status).toBe(429);
    expect(Number(refused!.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
  });

  it('keys per IDENTIFIER too, so one account cannot be attacked from many IPs', async () => {
    // The per-IP limb is generous; the identifier limb is what bites.
    process.env['MOTIR_AUTH_RATE_LIMIT'] = '2';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    const victim = { email: 'victim@example.com' };
    // Two attempts from two DIFFERENT IPs — each IP limb is at 1 of 2, but the
    // identifier limb is now at 2 of 2.
    expect(
      await enforceAuthRateLimit(authReq('/api/auth/sign-in/email', victim, '1.1.1.1')),
    ).toBeNull();
    expect(
      await enforceAuthRateLimit(authReq('/api/auth/sign-in/email', victim, '2.2.2.2')),
    ).toBeNull();
    const refused = await enforceAuthRateLimit(
      authReq('/api/auth/sign-in/email', victim, '3.3.3.3'),
    );
    expect(refused).not.toBeNull();
    expect(refused!.status).toBe(429);
  });

  it('sign-in and sign-up are SEPARATE buckets', async () => {
    process.env['MOTIR_AUTH_RATE_LIMIT'] = '1';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect(await enforceAuthRateLimit(authReq('/api/auth/sign-in/email'))).toBeNull();
    // Same IP, different scope — untouched budget.
    expect(await enforceAuthRateLimit(authReq('/api/auth/sign-up/email'))).toBeNull();
    expect(await enforceAuthRateLimit(authReq('/api/auth/sign-in/email'))).not.toBeNull();
  });

  it('password reset takes the TIGHTER budget, not the sign-in one', async () => {
    process.env['MOTIR_AUTH_RATE_LIMIT'] = '100';
    process.env['MOTIR_PASSWORD_RESET_RATE_LIMIT'] = '1';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect(await enforceAuthRateLimit(authReq('/api/auth/request-password-reset'))).toBeNull();
    const refused = await enforceAuthRateLimit(authReq('/api/auth/request-password-reset'));
    expect(refused).not.toBeNull();
    expect(refused!.headers.get('x-ratelimit-limit')).toBe('1');
  });

  it('reads the identifier from a CLONE, leaving the body readable for Better-Auth', async () => {
    // If the guard consumed the stream, every limited endpoint would 500 — the one
    // way this guard could break the surface it protects.
    const req = authReq('/api/auth/sign-in/email', { email: 'Reader@Example.com  ' });
    expect(await authIdentifier(req)).toBe('reader@example.com');
    await expect(req.json()).resolves.toEqual({ email: 'Reader@Example.com  ' });
  });

  it('survives a body that is absent, not JSON, or carries no email', async () => {
    expect(await authIdentifier(authReq('/api/auth/sign-in/email'))).toBeNull();
    expect(await authIdentifier(authReq('/api/auth/sign-in/email', { email: 42 }))).toBeNull();
    expect(await authIdentifier(authReq('/api/auth/sign-in/email', { email: '  ' }))).toBeNull();
    const notJson = new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      body: 'not json at all',
    });
    expect(await authIdentifier(notJson)).toBeNull();
  });

  it('an unparseable body still gets the per-IP limb (no free pass)', async () => {
    process.env['MOTIR_AUTH_RATE_LIMIT'] = '1';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    const make = () =>
      new Request('http://localhost/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'x-forwarded-for': '9.9.9.9' },
        body: 'not json',
      });
    expect(await enforceAuthRateLimit(make())).toBeNull();
    expect(await enforceAuthRateLimit(make())).not.toBeNull();
  });

  it('never limits an excluded path, even one shaped like a limited one', async () => {
    process.env['MOTIR_AUTH_RATE_LIMIT'] = '1';
    const health = new Request('http://localhost/api/health/sign-in/email', { method: 'POST' });
    for (let i = 0; i < 4; i += 1) expect(await enforceAuthRateLimit(health)).toBeNull();
  });
});

// ── PUBLIC WRITE ─────────────────────────────────────────────────────────────

// MOTIR-6642 / MOTIR-6666 — a Visitor's reads, per signed-in person, in their own bucket.
describe('the public-read surface', () => {
  const read = (ip = '198.51.100.21') =>
    new Request('http://localhost/p/ACME/board', { headers: { 'x-forwarded-for': ip } });

  it('answers 429 with RATE_LIMITED once one person has spent their budget, and a second person is unaffected', async () => {
    process.env['MOTIR_PUBLIC_READ_RATE_LIMIT'] = '2';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect(await enforcePublicReadRateLimit(read(), 'user-a')).toBeNull();
    expect(await enforcePublicReadRateLimit(read(), 'user-a')).toBeNull();
    const refused = await enforcePublicReadRateLimit(read(), 'user-a');
    expect(refused!.status).toBe(429);
    await expect(refused!.json()).resolves.toMatchObject({ code: RATE_LIMITED_CODE });
    expect(await enforcePublicReadRateLimit(read(), 'user-b')).toBeNull();
  });

  it('is keyed on the person, not the IP — one person from two addresses shares one budget', async () => {
    process.env['MOTIR_PUBLIC_READ_RATE_LIMIT'] = '1';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect(await enforcePublicReadRateLimit(read('203.0.113.1'), 'user-c')).toBeNull();
    expect(await enforcePublicReadRateLimit(read('203.0.113.2'), 'user-c')).not.toBeNull();
  });

  it('does not share a bucket with public-write — reading never spends the write allowance', async () => {
    process.env['MOTIR_PUBLIC_READ_RATE_LIMIT'] = '1';
    process.env['MOTIR_PUBLIC_WRITE_RATE_LIMIT'] = '1';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect(await enforcePublicReadRateLimit(read('203.0.113.77'), 'user-d')).toBeNull();
    expect(await enforcePublicReadRateLimit(read('203.0.113.77'), 'user-d')).not.toBeNull();
    expect(
      await enforcePublicWriteRateLimit(
        new Request('http://localhost/api/public-requests/abc/upvote', {
          method: 'POST',
          headers: { 'x-forwarded-for': '203.0.113.77' },
        }),
      ),
    ).toBeNull();
  });
});

describe('the public-write surface', () => {
  it('refuses the (N+1)-th write from one IP', async () => {
    process.env['MOTIR_PUBLIC_WRITE_RATE_LIMIT'] = '2';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    const req = () =>
      new Request('http://localhost/api/public-requests/abc/upvote', {
        method: 'POST',
        headers: { 'x-forwarded-for': '198.51.100.4' },
      });
    expect(await enforcePublicWriteRateLimit(req())).toBeNull();
    expect(await enforcePublicWriteRateLimit(req())).toBeNull();
    const refused = await enforcePublicWriteRateLimit(req());
    expect(refused!.status).toBe(429);
    await expect(refused!.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('is keyed on IP — a different origin has its own budget', async () => {
    process.env['MOTIR_PUBLIC_WRITE_RATE_LIMIT'] = '1';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    const at = (ip: string) =>
      new Request('http://localhost/api/public/projects/p1/requests', {
        method: 'POST',
        headers: { 'x-forwarded-for': ip },
      });
    expect(await enforcePublicWriteRateLimit(at('1.2.3.4'))).toBeNull();
    expect(await enforcePublicWriteRateLimit(at('5.6.7.8'))).toBeNull();
    expect(await enforcePublicWriteRateLimit(at('1.2.3.4'))).not.toBeNull();
  });

  it('shares ONE bucket across the public-write endpoints (a scope, not a route)', async () => {
    process.env['MOTIR_PUBLIC_WRITE_RATE_LIMIT'] = '1';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    const ip = { 'x-forwarded-for': '203.0.113.55' };
    expect(
      await enforcePublicWriteRateLimit(
        new Request('http://localhost/api/public/projects/p1/requests', {
          method: 'POST',
          headers: ip,
        }),
      ),
    ).toBeNull();
    // A different endpoint, same abuse budget — an attacker must not get a fresh
    // allowance per URL.
    expect(
      await enforcePublicWriteRateLimit(
        new Request('http://localhost/api/public-requests/r1/comments', {
          method: 'POST',
          headers: ip,
        }),
      ),
    ).not.toBeNull();
  });

  it('never limits an excluded path', async () => {
    process.env['MOTIR_PUBLIC_WRITE_RATE_LIMIT'] = '1';
    const health = new Request('http://localhost/api/health', { method: 'POST' });
    for (let i = 0; i < 4; i += 1) {
      expect(await enforcePublicWriteRateLimit(health)).toBeNull();
    }
  });
});

// ── AI ───────────────────────────────────────────────────────────────────────

describe('the AI surface', () => {
  const ctx = { userId: 'user_1', workspaceId: 'ws_1' };

  it('refuses the (N+1)-th call for one user+workspace', async () => {
    process.env['MOTIR_AI_RATE_LIMIT'] = '2';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect(await enforceAiRateLimit(ctx)).toBeNull();
    expect(await enforceAiRateLimit(ctx)).toBeNull();
    const refused = await enforceAiRateLimit(ctx);
    expect(refused!.status).toBe(429);
  });

  it('keys on USER + WORKSPACE, never on IP', async () => {
    // The AC's axis check. The guard is not even given the request, so an IP
    // cannot leak into the key — and two users behind one NAT keep separate
    // budgets while one user keeps ONE budget across networks.
    process.env['MOTIR_AI_RATE_LIMIT'] = '1';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect(await enforceAiRateLimit({ userId: 'u1', workspaceId: 'w1' })).toBeNull();
    expect(await enforceAiRateLimit({ userId: 'u2', workspaceId: 'w1' })).toBeNull();
    expect(await enforceAiRateLimit({ userId: 'u1', workspaceId: 'w2' })).toBeNull();
    expect(await enforceAiRateLimit({ userId: 'u1', workspaceId: 'w1' })).not.toBeNull();
  });

  it('the browser and service-to-service surfaces are SEPARATE budgets', async () => {
    process.env['MOTIR_AI_RATE_LIMIT'] = '1';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect(await enforceAiRateLimit(ctx, 'ai:chat')).toBeNull();
    // The job-token read-back door (per job since MOTIR-8604; a keyless token
    // keeps the user bucket) is not the chat bucket.
    expect(await enforceJobReadRateLimit({ ctx, jobKey: null })).toBeNull();
    expect(await enforceJobReadRateLimit({ ctx, jobKey: 'job-a' })).toBeNull();
    expect(await enforceAiRateLimit(ctx, 'ai:chat')).not.toBeNull();
  });

  // ── GENERATION (MOTIR-2597) ────────────────────────────────────────────────
  // The job-SUBMITTING routes draw `ai:generate`, which is both a separate bucket
  // and a separate CEILING — a plan generation costs many chat turns, so metering
  // it by the chat allowance would set the expensive door's limit from the cheap
  // one.

  it('generation takes its OWN budget, not the chat one', async () => {
    process.env['MOTIR_AI_RATE_LIMIT'] = '100';
    process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] = '1';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect(await enforceAiRateLimit(ctx, 'ai:generate')).toBeNull();
    const refused = await enforceAiRateLimit(ctx, 'ai:generate');
    expect(refused!.status).toBe(429);
    expect(refused!.headers.get('x-ratelimit-limit')).toBe('1');
    expect(Number(refused!.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
  });

  it('spending the generation budget leaves the chat budget alone', async () => {
    // The reason the two are separate scopes at all: a user who has run out of
    // plan generations can still ask a question, and a chat-box loop cannot
    // consume the generation allowance.
    process.env['MOTIR_AI_RATE_LIMIT'] = '2';
    process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] = '1';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect(await enforceAiRateLimit(ctx, 'ai:generate')).toBeNull();
    expect(await enforceAiRateLimit(ctx, 'ai:generate')).not.toBeNull();
    expect(await enforceAiRateLimit(ctx, 'ai:chat')).toBeNull();
  });

  it('generation is keyed per user + workspace like every other AI scope', async () => {
    process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] = '1';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect(await enforceAiRateLimit({ userId: 'u1', workspaceId: 'w1' }, 'ai:generate')).toBeNull();
    expect(await enforceAiRateLimit({ userId: 'u2', workspaceId: 'w1' }, 'ai:generate')).toBeNull();
    expect(
      await enforceAiRateLimit({ userId: 'u1', workspaceId: 'w1' }, 'ai:generate'),
    ).not.toBeNull();
  });

  it('defaults to a TIGHTER ceiling than chat when neither env is set', async () => {
    // The relationship is the point, not either number: if a future edit raises
    // the generation default past the chat one, the expensive door is again
    // metered more loosely than the cheap one.
    expect(DEFAULT_AI_GENERATE_RATE_LIMIT).toBeLessThan(DEFAULT_AI_RATE_LIMIT);
    process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] = 'not a number';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    const refusedAt = DEFAULT_AI_GENERATE_RATE_LIMIT;
    for (let i = 0; i < refusedAt; i += 1) {
      expect(await enforceAiRateLimit(ctx, 'ai:generate')).toBeNull();
    }
    // A malformed value falls back to the documented default rather than
    // disabling the limiter.
    expect(await enforceAiRateLimit(ctx, 'ai:generate')).not.toBeNull();
  });
});

describe('the tenant-LESS internal routes (service-bearer gated)', () => {
  // `live-projects` and `work-items` carry no tenant at all, so they key on the
  // CREDENTIAL — the axis /api/v1 uses for the same reason.
  const withBearer = (secret: string) =>
    new Request('http://localhost/api/internal/ai/live-projects', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'x-forwarded-for': '10.0.0.1' },
    });

  it('refuses the (N+1)-th call for one credential', async () => {
    process.env['MOTIR_AI_RATE_LIMIT'] = '2';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect(await enforceInternalServiceRateLimit(withBearer('secret-a'))).toBeNull();
    expect(await enforceInternalServiceRateLimit(withBearer('secret-a'))).toBeNull();
    const refused = await enforceInternalServiceRateLimit(withBearer('secret-a'));
    expect(refused!.status).toBe(429);
    expect(Number(refused!.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
  });

  it('keys on the CREDENTIAL, not the IP — a second secret has its own budget', async () => {
    process.env['MOTIR_AI_RATE_LIMIT'] = '1';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    // Same IP on both calls; only the bearer differs.
    expect(await enforceInternalServiceRateLimit(withBearer('secret-a'))).toBeNull();
    expect(await enforceInternalServiceRateLimit(withBearer('secret-b'))).toBeNull();
    expect(await enforceInternalServiceRateLimit(withBearer('secret-a'))).not.toBeNull();
  });

  it('a request with NO bearer still counts, rather than reading as unlimited', async () => {
    // Unreachable from a route (the bearer check runs first and fails closed), but
    // keyed rather than skipped so a future reordering cannot open a hole.
    process.env['MOTIR_AI_RATE_LIMIT'] = '1';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    const bare = () =>
      new Request('http://localhost/api/internal/ai/live-projects', { method: 'POST' });
    expect(await enforceInternalServiceRateLimit(bare())).toBeNull();
    expect(await enforceInternalServiceRateLimit(bare())).not.toBeNull();
  });

  it('does not share a bucket with the job-token internal calls', async () => {
    process.env['MOTIR_AI_RATE_LIMIT'] = '1';
    expect(await enforceInternalServiceRateLimit(withBearer('secret-a'))).toBeNull();
    // A job-token caller keys on its job (or, keyless, on workspace+user), so its
    // bucket is untouched by the credential one.
    const c = { userId: 'u', workspaceId: 'w' };
    expect(await enforceJobReadRateLimit({ ctx: c, jobKey: null })).toBeNull();
    expect(await enforceJobReadRateLimit({ ctx: c, jobKey: 'job-a' })).toBeNull();
  });
});

describe('the internal-AI error mapper', () => {
  it('passes the limiter response through UNTOUCHED, headers included', async () => {
    const built = rateLimitedResponse({
      allowed: false,
      limit: 3,
      remaining: 0,
      resetAt: Math.floor(Date.now() / 1000) + 30,
      degraded: false,
    });
    const mapped = mapJobRequestError(new JobRateLimitedError(built));
    expect(mapped).toBe(built);
    expect(mapped!.status).toBe(429);
    expect(mapped!.headers.get('Retry-After')).toBeTruthy();
    expect(mapped!.headers.get('x-ratelimit-limit')).toBe('3');
  });

  it('still maps the 401 auth failure it replaced', async () => {
    const mapped = mapJobRequestError(new JobAuthError('token_invalid', 'nope'));
    expect(mapped!.status).toBe(401);
    await expect(mapped!.json()).resolves.toEqual({ code: 'token_invalid', error: 'nope' });
  });

  it('returns null for anything else, so the route rethrows a genuine 500', () => {
    expect(mapJobRequestError(new Error('boom'))).toBeNull();
    expect(mapJobRequestError('not an error')).toBeNull();
  });
});

// ── MCP (MOTIR-2610) ─────────────────────────────────────────────────────────
// `/api/mcp` is ONE route multiplexing every tool, so it is metered TWICE: the
// transport spends a generous `mcp:call` volume budget on every request, and the
// two tools that submit a model job additionally spend `ai:generate` at the
// dispatch seam. These cases pin that split — including the thing the split
// exists for, that neither budget can be spent through the other.

describe('the MCP transport surface', () => {
  const ctx = { userId: 'mcp_user', workspaceId: 'mcp_ws' };
  /** A presented credential's fingerprint — the per-agent key (MOTIR-8601). */
  const FP = 'fp-mcp-agent';

  it('refuses the (N+1)-th request with a 429 + Retry-After + X-RateLimit-*', async () => {
    process.env['MOTIR_MCP_RATE_LIMIT'] = '2';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect((await enforceMcpRateLimit(ctx, FP)).refusal).toBeNull();
    expect((await enforceMcpRateLimit(ctx, FP)).refusal).toBeNull();

    const { refusal } = await enforceMcpRateLimit(ctx, FP);
    expect(refusal).not.toBeNull();
    expect(refusal!.status).toBe(429);
    expect(Number(refusal!.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(refusal!.headers.get('x-ratelimit-limit')).toBe('2');
    expect(refusal!.headers.get('x-ratelimit-remaining')).toBe('0');
  });

  it('shapes the refusal as a JSON-RPC error envelope a client can parse', async () => {
    // The AC's "not a bare HTTP body a client cannot parse". `mcp-handler` pairs a
    // non-2xx status with a JSON-RPC envelope for its own transport refusal (the
    // GET/DELETE 405), and the SDK client surfaces a non-2xx body as TEXT
    // (`StreamableHTTPError(status, text)`), so a parseable envelope serves both.
    process.env['MOTIR_MCP_RATE_LIMIT'] = '1';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    await enforceMcpRateLimit(ctx, FP);
    const { refusal } = await enforceMcpRateLimit(ctx, FP);

    expect(refusal!.headers.get('content-type')).toContain('application/json');
    const body = await refusal!.json();
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: MCP_RATE_LIMITED_JSONRPC_CODE,
        data: { code: 'RATE_LIMITED', limit: 1, remaining: 0 },
      },
    });
    expect(body.error.message).toMatch(/Retry in \d+ seconds?\./);
    expect(body.error.data.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('uses a JSON-RPC code inside the implementation-defined range, clear of the SDK', () => {
    // -32000..-32099 is JSON-RPC 2.0's server-error range; the SDK reserves
    // -32000 / -32001 / -32042 inside it, and mcp-handler emits -32000 for its
    // own 405. Colliding would make a rate-limit refusal indistinguishable from a
    // dropped connection.
    expect(MCP_RATE_LIMITED_JSONRPC_CODE).toBeLessThanOrEqual(-32000);
    expect(MCP_RATE_LIMITED_JSONRPC_CODE).toBeGreaterThanOrEqual(-32099);
    expect([-32000, -32001, -32042]).not.toContain(MCP_RATE_LIMITED_JSONRPC_CODE);
  });

  it('stamps the budget headers on an ALLOWED request too, so a client can pace itself', async () => {
    process.env['MOTIR_MCP_RATE_LIMIT'] = '5';
    const { refusal, headers } = await enforceMcpRateLimit(ctx, FP);
    expect(refusal).toBeNull();
    expect(headers['x-ratelimit-limit']).toBe('5');
    expect(headers['x-ratelimit-remaining']).toBe('4');
    // Not refused, so nothing to retry after.
    expect(headers['Retry-After']).toBeUndefined();
  });

  it('keys VOLUME on the presented CREDENTIAL, not on the person (MOTIR-8601)', async () => {
    // The inverse of the case this replaced ("keys on USER + WORKSPACE, not on
    // the PAT fingerprint"). That argument is about the MONEY half and still
    // holds there (`ai:generate`, below); on the volume half it starved one
    // person's concurrent agents of a single bucket. What minting a credential
    // must not widen is now held by the workspace ceiling (next case).
    process.env['MOTIR_MCP_RATE_LIMIT'] = '1';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    const u1w1 = { userId: 'u1', workspaceId: 'w1' };
    // Two credentials of ONE person in ONE workspace: two budgets.
    expect((await enforceMcpRateLimit(u1w1, 'fp-a')).refusal).toBeNull();
    expect((await enforceMcpRateLimit(u1w1, 'fp-b')).refusal).toBeNull();
    // One credential in two workspaces: two budgets.
    expect(
      (await enforceMcpRateLimit({ userId: 'u1', workspaceId: 'w2' }, 'fp-a')).refusal,
    ).toBeNull();
    // And each credential is still limited on its own.
    expect((await enforceMcpRateLimit(u1w1, 'fp-a')).refusal).not.toBeNull();
    expect((await enforceMcpRateLimit(u1w1, 'fp-b')).refusal).not.toBeNull();
  });

  it('holds every credential of a workspace under ONE shared ceiling', async () => {
    process.env['MOTIR_MCP_RATE_LIMIT'] = '100';
    process.env['MOTIR_AGENT_WORKSPACE_RATE_LIMIT'] = '3';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    const w1 = { userId: 'u1', workspaceId: 'w1' };
    for (const fp of ['fp-1', 'fp-2', 'fp-3']) {
      expect((await enforceMcpRateLimit(w1, fp)).refusal).toBeNull();
    }
    // A fourth credential is a fresh per-agent bucket and NO fresh ceiling.
    const { refusal } = await enforceMcpRateLimit(w1, 'fp-4');
    expect(refusal).not.toBeNull();
    expect(refusal!.status).toBe(429);
    expect(Number(refusal!.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    const body = await refusal!.json();
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      error: { code: MCP_RATE_LIMITED_JSONRPC_CODE, data: { code: 'RATE_LIMITED' } },
    });
    expect(body.error.data.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    // Another workspace has its own ceiling.
    expect(
      (await enforceMcpRateLimit({ userId: 'u1', workspaceId: 'w2' }, 'fp-1')).refusal,
    ).toBeNull();
  });

  it('never leaves a call with no credential unlimited — it shares the person bucket', async () => {
    process.env['MOTIR_MCP_RATE_LIMIT'] = '2';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect((await enforceMcpRateLimit(ctx, null)).refusal).toBeNull();
    expect((await enforceMcpRateLimit(ctx, null)).refusal).toBeNull();
    expect((await enforceMcpRateLimit(ctx, null)).refusal).not.toBeNull();
  });

  it('reports the TIGHTER of its two limbs on an allowed request', async () => {
    process.env['MOTIR_MCP_RATE_LIMIT'] = '50';
    process.env['MOTIR_AGENT_WORKSPACE_RATE_LIMIT'] = '5';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    const { refusal, headers } = await enforceMcpRateLimit(ctx, FP);
    expect(refusal).toBeNull();
    expect(headers['x-ratelimit-limit']).toBe('5');
    expect(headers['x-ratelimit-remaining']).toBe('4');
  });

  it('is its OWN bucket — an exhausted MCP budget leaves chat and generation alone', async () => {
    process.env['MOTIR_MCP_RATE_LIMIT'] = '1';
    process.env['MOTIR_AI_RATE_LIMIT'] = '5';
    process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] = '5';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect((await enforceMcpRateLimit(ctx, FP)).refusal).toBeNull();
    expect((await enforceMcpRateLimit(ctx, FP)).refusal).not.toBeNull();
    expect(await enforceAiRateLimit(ctx, 'ai:chat')).toBeNull();
    expect(await enforceAiRateLimit(ctx, 'ai:generate')).toBeNull();
  });

  it('defaults to 600 per agent and 12 000 per workspace, and a typo falls back', () => {
    delete process.env['MOTIR_MCP_RATE_LIMIT'];
    delete process.env['MOTIR_AGENT_WORKSPACE_RATE_LIMIT'];
    expect(mcpBudget().limit).toBe(600);
    expect(agentWorkspaceBudget().limit).toBe(12_000);
    process.env['MOTIR_MCP_RATE_LIMIT'] = 'lots';
    process.env['MOTIR_AGENT_WORKSPACE_RATE_LIMIT'] = '-1';
    expect(mcpBudget().limit).toBe(600);
    expect(agentWorkspaceBudget().limit).toBe(12_000);
  });

  it('defaults FAR looser than the browser budgets — the caller here is a script', async () => {
    // The relationship is the assertion, not the number: an agent legitimately
    // loops (an initialize + a notification + the call, per CLI operation), so a
    // ceiling tuned for a human clicking buttons would be an outage of the
    // product rather than a defence of it. Generation stays scarce regardless —
    // that ceiling is enforced per TOOL, below.
    expect(DEFAULT_MCP_RATE_LIMIT).toBeGreaterThan(DEFAULT_AI_RATE_LIMIT);
    expect(DEFAULT_MCP_RATE_LIMIT).toBeGreaterThan(DEFAULT_AI_GENERATE_RATE_LIMIT);
  });

  it('honours the shared E2E disable flag rather than a second switch of its own', async () => {
    process.env[RATE_LIMIT_DISABLE_ENV] = '1';
    process.env['MOTIR_MCP_RATE_LIMIT'] = '1';
    for (let i = 0; i < 4; i += 1) {
      expect((await enforceMcpRateLimit(ctx, FP)).refusal).toBeNull();
    }
  });

  it('builds a refusal from any decision, degraded flag included', async () => {
    // `mcpRateLimitedResponse` is the only place the envelope is shaped, so it is
    // exercised directly too — a fail-open (degraded) decision never reaches it,
    // but a hand-built one proves the shape does not depend on the store.
    const built = mcpRateLimitedResponse({
      allowed: false,
      limit: 7,
      remaining: 0,
      resetAt: Math.floor(Date.now() / 1000) + 1,
      degraded: false,
    });
    expect(built.status).toBe(429);
    expect(built.headers.get('Retry-After')).toBe('1');
    await expect(built.json()).resolves.toMatchObject({
      error: { message: 'Too many requests. Retry in 1 second.' },
    });
  });
});

describe('the MCP BILLABLE tools', () => {
  const ctx = { userId: 'agent_1', workspaceId: 'ws_1' };

  it('a job-submitting tool draws the ai:generate bucket', async () => {
    process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] = '1';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect(await billableToolDenial('expand_item', ctx)).toBeNull();

    const refused = await billableToolDenial('expand_item', ctx);
    expect(refused).toMatchObject({ isError: true });
    expect(JSON.stringify(refused)).toContain('RATE_LIMITED');
  });

  it('shares ONE counter with the browser door — the whole point of the card', async () => {
    // MOTIR-2597 capped `POST /api/ai/expand`; this tool reaches the same
    // `aiPlanEditsService.submitExpand`. If the two kept separate counters, the
    // agent door would simply be a second allowance for the same spend.
    process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] = '1';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect(await enforceAiRateLimit(ctx, 'ai:generate')).toBeNull();
    expect(await billableToolDenial('expand_item', ctx)).not.toBeNull();
  });

  it('and in the other direction — a tool call spends the browser route’s budget', async () => {
    process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] = '1';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect(await billableToolDenial('submit_plan_session', ctx)).toBeNull();
    expect(await enforceAiRateLimit(ctx, 'ai:generate')).not.toBeNull();
  });

  it('never meters a NON-billable tool on the generation budget', async () => {
    // "An agent polling next_ready must not be metered as if it were generating a
    // plan." Its ceiling is the transport's `mcp:call`, spent one layer out.
    process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] = '1';
    for (const tool of ['next_ready', 'get_work_item', 'transition_status', 'get_plan_status']) {
      for (let i = 0; i < 4; i += 1) {
        expect(await billableToolDenial(tool, ctx)).toBeNull();
      }
    }
    // And nothing above touched the generation budget.
    expect(await enforceAiRateLimit(ctx, 'ai:generate')).toBeNull();
  });

  it('classifies only names the registry actually exposes', () => {
    for (const tool of MCP_BILLABLE_TOOLS) expect(MCP_TOOL_NAMES).toContain(tool);
    expect(isBillableTool('expand_item')).toBe(true);
    expect(isBillableTool('get_work_item')).toBe(false);
  });
});

// ── WIRING ───────────────────────────────────────────────────────────────────

describe('the routes are actually WIRED to the guards', () => {
  // A guard nobody calls protects nothing, and every case above tests the guard
  // rather than the route. These read the route sources so a future edit that
  // drops an enforcement call fails here instead of silently un-limiting a
  // surface.
  const wiring: ReadonlyArray<[string, string]> = [
    ['app/api/auth/[...all]/route.ts', 'enforceAuthRateLimit'],
    ['app/api/public/projects/[projectId]/requests/route.ts', 'enforcePublicWriteRateLimit'],
    ['app/api/public-requests/[id]/comments/route.ts', 'enforcePublicWriteRateLimit'],
    ['app/api/public-requests/[id]/upvote/route.ts', 'enforcePublicWriteRateLimit'],
    ['app/api/ai/chat/route.ts', 'enforceAiRateLimit'],
    // The MCP transport's own guard (MOTIR-2610). Deleting the call from the
    // route is exactly how this surface came to be unlimited in the first place,
    // so it fails HERE now rather than in production.
    ['app/api/mcp/route.ts', 'enforceMcpRateLimit'],
    // …keyed on the presented credential, fingerprinted (MOTIR-8601).
    ['app/api/mcp/route.ts', 'tokenFingerprint'],
    // …and the dispatch-seam half: the route asks for it, the registry applies it.
    ['app/api/mcp/route.ts', 'registerMcpTools(server, contextFromExtra, grantFromExtra, true)'],
    ['lib/mcp/registry.ts', 'rateLimitedServer'],
  ];

  it.each(wiring)('%s calls %s', (file, symbol) => {
    const source = readFileSync(file, 'utf8');
    expect(source).toContain(symbol);
  });

  // ⚠️ The BROWSER AI surface, enumerated from the filesystem (MOTIR-2597).
  //
  // 8.5.9 limited `/api/ai/chat` and `/api/internal/ai/*` because those were the
  // two surfaces its acceptance criteria named — which left the routes that cost
  // the most (plan generation, expansion, re-plan, audit) uncapped. A hand list
  // would have the same shape as that gap, so this reads the directory instead:
  // every `app/api/ai/**/route.ts` must land in EXACTLY ONE of the two sets
  // below, and both are asserted TIGHT IN BOTH DIRECTIONS. A new AI route is a
  // failing test until somebody classifies it — and a route that leaves its set
  // (a guard deleted, an unlimited read that starts submitting) fails too, which
  // a one-directional allowlist would not catch.
  //
  // The line between the sets is the MONEY, not the HTTP verb: a route belongs in
  // `LIMITED` when it causes motir-ai to run a model job (`submitJob`, or the
  // upstream re-audit `refreshCodeAudit` queues). Everything else — reading a job
  // back, streaming one already paid for, appending a conversation turn to our own
  // database, materializing a plan that was already generated — spends nothing at
  // the provider, and a ceiling there would only refuse a caller the answer they
  // have already been charged for.
  const LIMITED: ReadonlyArray<string> = [
    // The composer's ONE DOOR (Story MOTIR-1343 · MOTIR-1819). It submits an
    // `ask_project` model job on every turn — including the one that turns out to
    // be a plan change — so it spends real provider money and belongs here, on the
    // same `ai:generate` bucket the plan-change submit uses.
    'app/api/ai/ask/route.ts',
    'app/api/ai/augment/route.ts',
    'app/api/ai/chat/route.ts',
    'app/api/ai/coding-convention/refresh/route.ts',
    'app/api/ai/expand/route.ts',
    'app/api/ai/explanation/route.ts',
    // The GUIDE door (Story MOTIR-7459 · MOTIR-7464): every turn submits a
    // `guide_work_item` model job, so it draws the same `ai:generate` bucket.
    'app/api/ai/guide/route.ts',
    'app/api/ai/plan-change/session/submit/route.ts',
    // RESUME of a failed planning session (MOTIR-7916) submits a `plan` job — it spends credits.
    'app/api/ai/plan-change/session/resume/route.ts',
    'app/api/ai/plan/generate/route.ts',
    // THE ROUTING RUN (Story MOTIR-4753 · MOTIR-4769). It opens no plan, which
    // is what makes it look free and is not: it submits a `plan_routing` model
    // job on the planner, so it draws the same `ai:generate` bucket generation
    // does — and it is the door a never-onboarded project hits on every open of
    // the plan window, which is exactly the shape a ceiling is for.
    'app/api/ai/plan/route-onboarding/route.ts',
    'app/api/ai/plan/sprint/route.ts',
    // `revise_plan` (Story MOTIR-3595 · MOTIR-3599) — the fourth plan-edit
    // submit, spending the same `ai:generate` bucket as the three above. Its
    // target is a PLAN id rather than a work-item key, which changes nothing
    // about what it costs: it dispatches a model job.
    'app/api/ai/revise/route.ts',
    // The SHARPEN door (Task MOTIR-1101 · MOTIR-8181): open, answer, skip,
    // you-decide and stop each submit a `sharpen_turn` model job.
    'app/api/ai/sharpen/route.ts',
    // A change forwarded after the walk finished becomes ONE revision job, so it
    // spends provider money like the revise door it reuses (MOTIR-7997).
    'app/api/ai/plan-change/session/late-changes/route.ts',
    // A plan offer's CONFIRM starts its planning run — one `plan` job per offer
    // (Story MOTIR-9219 · MOTIR-9291).
    'app/api/ai/plan-change/session/offer/confirm/route.ts',
  ];

  // Each of these submits NO model job. The reason is in the route's own header
  // comment (asserted below), so the classification cannot drift out of the code
  // it describes.
  const UNLIMITED_BY_DESIGN: ReadonlyArray<string> = [
    'app/api/ai/access/route.ts',
    // The ask stream RELAYS a job already paid for at the submit door, and the
    // settle READS one back and files it — the `…/planner-turn` precedent exactly.
    'app/api/ai/ask/[jobId]/stream/route.ts',
    'app/api/ai/ask/settle/route.ts',
    'app/api/ai/augment/[jobId]/stream/route.ts',
    'app/api/ai/chat/[jobId]/stream/route.ts',
    'app/api/ai/coding-convention/audit-coverage/route.ts',
    // The project's CODE CONTEXT — a pure database read of `project_repository`
    // and the columns MOTIR-4724 put the index state in. No boundary call, no
    // model job, no provider money (MOTIR-1767).
    'app/api/ai/code-context/route.ts',
    'app/api/ai/coding-convention/audit/route.ts',
    'app/api/ai/coding-convention/convention/route.ts',
    'app/api/ai/explanation/[jobId]/stream/route.ts',
    // The guide settle READS a finished job back and lands it — the ask settle
    // precedent exactly (MOTIR-7470).
    // The decline of a re-plan offer writes one marker row on the thread and
    // plans nothing (MOTIR-8689).
    'app/api/ai/guide/offer/decline/route.ts',
    // The seed of a re-plan offer is a pure read: it composes the first turn and
    // reports the session, and submits no model job (MOTIR-8692).
    'app/api/ai/guide/offer/[turnId]/planning-seed/route.ts',
    'app/api/ai/guide/settle/route.ts',
    'app/api/ai/jobs/[jobId]/route.ts',
    // The boundary MAILBOX (Story MOTIR-4054 · MOTIR-4067 / MOTIR-4068): a turn
    // or a stop attached to a job that is ALREADY running and already paid for —
    // one row each, no model job submitted, the `turns` precedent exactly.
    'app/api/ai/plan-change/session/mailbox/route.ts',
    'app/api/ai/plan-change/session/mailbox/stop/route.ts',
    // A plan offer's DECLINE stamps the decision on the offer and plans nothing
    // (MOTIR-9294).
    'app/api/ai/plan-change/session/offer/decline/route.ts',
    'app/api/ai/plan-change/session/planner-turn/route.ts',
    // PLAN SOMETHING NEW (Story MOTIR-7631 · MOTIR-7649): the restart ends a
    // session and opens an empty one, or answers a confirm turn a thread already
    // holds — database writes only, no model job (AMENDMENT 3, A3.3).
    'app/api/ai/plan-change/session/restart/route.ts',
    'app/api/ai/plan-change/session/route.ts',
    // The planner's mid-run PAUSE: reads and answers one row, and the answer
    // is a mailbox turn on a job already running — no model job (MOTIR-8007).
    'app/api/ai/plan-change/session/run-pause/route.ts',
    'app/api/ai/plan-change/session/turns/route.ts',
    // The overlay's History (MOTIR-9306): a page of the caller's own sessions —
    // a database read, no model job.
    'app/api/ai/plan-change/sessions/history/route.ts',
    'app/api/ai/plan/generate/[jobId]/stream/route.ts',
    'app/api/ai/plan/sprint/[jobId]/review/route.ts',
    'app/api/ai/plan/sprint/[jobId]/stream/route.ts',
    'app/api/ai/plan/sprint/approve/route.ts',
    'app/api/ai/pre-plan/route.ts',
    // The revision stream RELAYS a job already paid for at its submit door —
    // the same reason every other `[jobId]/stream` in this list is here.
    'app/api/ai/revise/[jobId]/stream/route.ts',
    // Sharpen's session READ and its settle (MOTIR-8181): a database read, and a
    // job read back and stored — the guide settle precedent exactly.
    'app/api/ai/sharpen/[sessionId]/route.ts',
    'app/api/ai/sharpen/settle/route.ts',
  ];

  async function aiRoutes(): Promise<string[]> {
    const { globSync } = await import('node:fs');
    return globSync('app/api/ai/**/route.ts').sort();
  }

  it('EVERY /api/ai route is classified — the directory holds these files and no others', async () => {
    // The membership check that makes the two lists below binding: a route added
    // to `app/api/ai/**` and to NEITHER list fails here, before anyone has to
    // notice it is unlimited in production.
    expect(await aiRoutes()).toEqual([...LIMITED, ...UNLIMITED_BY_DESIGN].sort());
  });

  it('every job-SUBMITTING /api/ai route calls the limiter', async () => {
    const routes = await aiRoutes();
    const limited = routes.filter((file) =>
      /\benforceAiRateLimit\(/.test(readFileSync(file, 'utf8')),
    );
    // Tight in both directions: a missing guard AND a guard that appeared on a
    // route nobody classified as submitting are both failures.
    expect(limited).toEqual([...LIMITED].sort());
  });

  it('every submitting route spends the GENERATION budget (chat aside)', async () => {
    for (const file of LIMITED) {
      if (file === 'app/api/ai/chat/route.ts') continue;
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} must draw the ai:generate bucket`).toContain(
        "enforceAiRateLimit(ctx, 'ai:generate')",
      );
    }
  });

  it('every unlimited AI route SAYS why, in its own source', async () => {
    // The acceptance criterion the streams and polls owe: the next reader must be
    // able to tell "deliberately unlimited" from "nobody got to it" without
    // finding this test.
    for (const file of UNLIMITED_BY_DESIGN) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} must explain why it carries no limit`).toContain(
        'NOT rate-limited, deliberately',
      );
      expect(source, `${file} must not call the limiter`).not.toMatch(/\benforceAiRateLimit\(/);
    }
  });

  it('EVERY authenticated /api/internal/ai route is limited, by one of the two gates', async () => {
    // The class has TWO auth families and both had to be covered — the job-token
    // gate (a tenant is in the request, so the key is workspace + user) and the
    // service-bearer gate (`live-projects`, `work-items`: no tenant at all, so the
    // key is the credential). Enumerating from the filesystem rather than a hand
    // list is the point: a NEW internal-AI route shipped without a limit fails
    // here, which is the only way this stays true after today.
    const { globSync } = await import('node:fs');
    const routes = globSync('app/api/internal/ai/**/route.ts');
    expect(routes.length).toBeGreaterThan(14);

    const unlimited: string[] = [];
    for (const file of routes) {
      const source = readFileSync(file, 'utf8');
      const jobGated = /\bauthenticate(AndLimit)?JobRequest\b/.test(source);
      const serviceGated = /\bauthenticateServiceRequest\(/.test(source);

      if (jobGated) {
        expect(source, `${file} must use the LIMITED job gate`).toContain(
          'authenticateAndLimitJobRequest',
        );
        // The unlimited gate must no longer be CALLED from any route (the
        // remaining mentions are prose in the header comments).
        expect(source, `${file} must not call the unlimited job gate`).not.toMatch(
          /[^dt]\bauthenticateJobRequest\(/,
        );
      } else if (serviceGated) {
        expect(source, `${file} must use the service-credential limiter`).toContain(
          'enforceInternalServiceRateLimit',
        );
      } else {
        unlimited.push(file);
      }
    }

    // Exactly one route carries no auth and therefore no limit: the dev-only
    // no-op seam. Named explicitly so a second unauthenticated route cannot slip
    // in behind a passing test.
    expect(unlimited).toEqual(['app/api/internal/ai/dev/noop/route.ts']);
  });

  // ⚠️ The MCP tool surface, enumerated from the FILESYSTEM (MOTIR-2610).
  //
  // The defect this card fixes was a hand-drawn boundary: MOTIR-2597 capped the
  // doors its acceptance criteria named and the MCP door to the identical job
  // stayed open. `MCP_BILLABLE_TOOLS` is a hand list too, so it is re-derived
  // here from the tool modules' own source rather than trusted — the same move
  // the `/api/ai/**` block above makes, one surface over.
  //
  // The line is the MONEY: a tool is billable when calling it causes motir-ai to
  // run a model job. Both such calls today are one hop from `submitJob`, and the
  // hop is asserted rather than described, so a comment cannot go stale against
  // the code it claims to summarise.
  const JOB_SUBMITTING_CALLS: ReadonlyArray<{ call: string; service: string; reaches: string }> = [
    {
      call: 'aiPlanEditsService.submitExpand(',
      service: 'lib/services/aiPlanEditsService.ts',
      reaches: 'submitJob',
    },
    {
      call: 'planChangeSessionsService.submit(',
      service: 'lib/services/planChangeSessionsService.ts',
      reaches: 'aiPlanEditsService.submit',
    },
    // The PUBLIC doors' submit (MOTIR-6028) — `submit_plan_session` and the v1
    // submissions route resolve the addressed session through it, and it
    // delegates to `this.submit`, the entry above.
    {
      call: 'planChangeSessionsService.submitPublic(',
      service: 'lib/services/planChangeSessionsService.ts',
      reaches: 'return this.submit(',
    },
  ];

  it('each named job-submitting call really does reach a model job', () => {
    for (const { service, reaches } of JOB_SUBMITTING_CALLS) {
      expect(readFileSync(service, 'utf8'), `${service} must reach ${reaches}`).toContain(reaches);
    }
  });

  it('EVERY tool module that submits a model job declares a billable tool — and vice versa', async () => {
    const { globSync } = await import('node:fs');
    const modules = globSync('lib/mcp/tools/*.ts').sort();
    // The registry has ~39 tools across these modules; a glob that matched a
    // handful would make every assertion below vacuously true.
    expect(modules.length).toBeGreaterThan(20);

    for (const file of modules) {
      const source = readFileSync(file, 'utf8');
      const submits = JOB_SUBMITTING_CALLS.filter(({ call }) => source.includes(call)).length;
      // Every tool module names its tools as `export const X_TOOL_NAME = '…'`.
      const declared = [...source.matchAll(/_TOOL_NAME = '([a-z_]+)'/g)].map((m) => m[1] as string);
      const billable = declared.filter((name) => isBillableTool(name));

      // Tight in BOTH directions, per module: a new tool that submits a job and
      // was never classified fails on the left; a tool classified billable whose
      // module stopped submitting (or never did) fails on the right.
      expect(
        billable.length,
        `${file} has ${submits} job-submitting call(s) but ${billable.length} billable tool(s): ` +
          `${JSON.stringify(declared)}`,
      ).toBe(submits);
    }
  });

  it('no tool module reaches a job-submitting SERVICE without declaring a billable tool', async () => {
    // The check above is only as complete as `JOB_SUBMITTING_CALLS`, which is a
    // hand list of call expressions — so this one derives the danger set from the
    // services themselves: every `lib/services/*.ts` whose own source calls
    // `submitJob`. A tool module that imports one of those and classifies nothing
    // is the exact shape of the next occurrence of this bug, and it fails here.
    //
    // (It reaches the FIRST hop. `submit_plan_session` is a second hop —
    // `planChangeSessionsService` wraps `aiPlanEditsService` — which is why the
    // enumerated call list above exists alongside this.)
    const { globSync } = await import('node:fs');
    const submitters = globSync('lib/services/*.ts')
      .filter((file) => readFileSync(file, 'utf8').includes('submitJob'))
      .map((file) => (file.split('/').pop() as string).replace(/\.ts$/, ''));
    expect(submitters.length).toBeGreaterThan(5);

    // A positive control for the comment-stripping below: if it ever over-matched
    // and emptied every module, the `continue` inside the loop would make this
    // whole check pass while asserting nothing. At least the modules that reach
    // `aiPlanEditsService` / `planChangeSessionsService` must still be seen.
    let modulesReachingASubmitter = 0;

    for (const file of globSync('lib/mcp/tools/*.ts')) {
      const source = readFileSync(file, 'utf8');
      // ⚠️ Match against CODE, not comments (MOTIR-2988). The regex below is a
      // text search, and these modules carry long headers that EXPLAIN which
      // service they mirror — `lib/mcp/tools/authorPlan.ts` names
      // `aiGenerationService.appendProposals` in prose while calling only
      // `plansService`, and that prose is exactly the documentation this codebase
      // wants. Firing on it would fail a module that submits no job, and the fix
      // a future author would reach for is rewording the comment — i.e. routing
      // around the guard, which is a worse outcome than the drift it prevents.
      // Stripping comments loses nothing: a real call is never inside one.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      const reaches = submitters.filter((service) => new RegExp(`\\b${service}\\s*\\.`).test(code));
      if (reaches.length === 0) continue;
      modulesReachingASubmitter += 1;
      const billable = [...code.matchAll(/_TOOL_NAME = '([a-z_]+)'/g)].filter((m) =>
        isBillableTool(m[1] as string),
      );
      expect(
        billable.length,
        `${file} calls ${reaches.join(', ')} — which submit model jobs — but declares no billable tool`,
      ).toBeGreaterThan(0);
    }

    expect(
      modulesReachingASubmitter,
      'the code-only match saw NO tool module reaching a job-submitting service — ' +
        'the stripping over-matched and this check is now vacuous',
    ).toBeGreaterThan(0);
  });

  it('every billable tool is registered by a module the glob above actually reached', async () => {
    // The per-module check cannot see a billable name that belongs to NO module —
    // a typo in `MCP_BILLABLE_TOOLS` would pass it silently while metering
    // nothing at all.
    const { globSync } = await import('node:fs');
    const declaredEverywhere = globSync('lib/mcp/tools/*.ts').flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/_TOOL_NAME = '([a-z_]+)'/g)].map((m) => m[1]),
    );
    for (const tool of MCP_BILLABLE_TOOLS) expect(declaredEverywhere).toContain(tool);
  });
});

describe('a planning job’s job-token reads draw their own, larger budget (MOTIR-8423)', () => {
  // Since MOTIR-8604 the door is `enforceJobReadRateLimit`; a keyless token is
  // the pre-change `ai:internal` user bucket these cases pinned.
  it('ai:internal is NOT metered by the interactive MOTIR_AI_RATE_LIMIT', async () => {
    process.env['MOTIR_AI_RATE_LIMIT'] = '1';
    const c = { userId: 'u-8423', workspaceId: 'w-8423' };
    for (let i = 0; i < 5; i++) {
      expect(await enforceJobReadRateLimit({ ctx: c, jobKey: null })).toBeNull();
    }
  });

  it('and is still bounded by MOTIR_AI_INTERNAL_RATE_LIMIT', async () => {
    process.env['MOTIR_AI_INTERNAL_RATE_LIMIT'] = '1';
    try {
      await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
      const c = { userId: 'u-8423b', workspaceId: 'w-8423b' };
      expect(await enforceJobReadRateLimit({ ctx: c, jobKey: null })).toBeNull();
      expect(await enforceJobReadRateLimit({ ctx: c, jobKey: null })).not.toBeNull();
    } finally {
      delete process.env['MOTIR_AI_INTERNAL_RATE_LIMIT'];
    }
  });
});

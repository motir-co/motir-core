import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@/generated/prisma/client';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER } from '@/lib/tokens/grant';

// Better-Auth's rate limiter buckets /sign-in|/sign-up per IP (window 10s, max 3),
// and every test here signs in to obtain the real session cookie the plugin's
// approve/deny endpoints read. Under vitest there is no client IP, so all of them
// land in ONE bucket and the fourth sign-in of a run would 429 — a flake that has
// nothing to do with the code under test. The opt-in flag `lib/auth` already honours
// is set in `vi.hoisted` so it lands BEFORE the auth module is imported and its
// config is frozen. Production never sets it (default: limiter on).
vi.hoisted(() => {
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

const { db } = await import('@/lib/db');
const { auth } = await import('@/lib/auth');
const { APIError } = await import('better-auth/api');
const { cliDeviceService } = await import('@/lib/services/cliDeviceService');
const { apiTokensService } = await import('@/lib/services/apiTokensService');
const { CLI_TOKEN_SCOPES } = await import('@/lib/mcp/scopes');
const { CLI_CLIENT_ID, CLI_TOKEN_EXPIRY_DAYS } = await import('@/lib/cliDevice/constants');
const {
  DeviceGrantDeniedError,
  DeviceGrantExpiredError,
  DeviceGrantForbiddenError,
  DeviceGrantNotClaimedError,
  DeviceGrantNotPendingError,
  DeviceGrantPendingError,
  DeviceGrantSlowDownError,
  DeviceGrantUnboundError,
  InvalidDeviceGrantError,
} = await import('@/lib/cliDevice/errors');
const { NotAMemberError } = await import('@/lib/workspaces/errors');
const { deviceCodeRepository } = await import('@/lib/repositories/deviceCodeRepository');
const { toDeviceGrantTokenDTO } = await import('@/lib/mappers/cliDeviceMappers');
const { createTestWorkspace } = await import('../fixtures/workspaceFixtures');
const { TEST_PASSWORD } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { adminDb } = await import('../helpers/adminDb');
const { asMinted } = await import('../helpers/devicePoll');

// Service-layer tests for the `motir login` device-authorization flow (Story
// MOTIR-1863 · Subtask MOTIR-1865, implementing docs/decisions/cli-login.md).
// Real Postgres and the REAL Better-Auth plugin — nothing is mocked, including the
// session: each test signs in for real and forwards the resulting cookie, because
// the plugin's claim/approve/deny endpoints read the session from the request
// themselves and a stubbed `getSession()` would not reach them.
//
// ONE declared exception (Bug MOTIR-1955): three tests in "approve — the flip refuses
// after the pre-checks passed" reject `auth.api.deviceApprove` at the boundary. What
// they assert is Motir's own translation of the plugin's documented RFC 8628 codes,
// and the states those codes describe are reachable only through a race — so leaving
// them to the race meant the coverage gate flipped by luck. Everything else, that
// block's first two tests included, still drives the real plugin.
//
// The three acts under test: `start` (the terminal opens a grant), the plugin's
// claim + approve/deny (the browser), and `poll` (the terminal exchanges the grant
// for a PAT). The `device_code` rows are reached by `truncateAuthTables`'s
// user/workspace CASCADE.
//
// ── WHICH CLIENT EACH DIRECT-DB LINE TAKES, AND WHY (MOTIR-2911) ─────────────
// Under `motir_app` this file ran every direct-DB line through ONE client where
// it needs two — `api_token` and the two membership deletes were on the wrong one.
// `api_token`'s only policy is `api_token_owner_or_system` — `user_id =
// current_setting('app.user_id')` OR `app.system_admin` — and `organization_
// membership` / `workspace_membership` are workspace-keyed, so a statement on
// the `@/lib/db` singleton (which binds neither GUC here) is admitted no rows.
// A read returns `[]` / `0`; a delete removes nothing and raises nothing.
//
//   line(s)                   | class                        | client
//   --------------------------|------------------------------|-------------------
//   every `apiToken` count /  | MOTIR-2881's class 2 — an    | `adminDb`, the
//   findMany assertion        | ASSERTION doing direct DB    | database OWNER: an
//                             | work, not the subject of the | assertion needs to
//                             | test                         | see the row the
//                             |                              | service just wrote,
//                             |                              | under no tenant
//   the two `deleteMany`      | MOTIR-2882's class 3 — a     | `adminDb`: the
//   membership fixture writes | FIXTURE write staging the    | fixture must DELETE
//   in "the approver lost the | precondition                 | a row whose policy
//   workspace"                |                              | exists to protect it
//
// `deviceCode` stays on `db`: `device_code` carries no RLS policy at all, so
// those statements are already admitted and moving them would say something
// false about why. The SUBJECT of every test here is `cliDeviceService`, which
// keeps running on the singleton exactly as production does — none of this
// touches the code under test.

const BASE_URL = 'http://localhost:3000';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Allowance for the app clock vs. the DB's `CURRENT_TIMESTAMP`, and for however long an
 * insert takes on a loaded runner. Any timestamp assertion here is a WINDOW, never an
 * equality — see `describe`'s lifetime assertion for what an exact one costs. */
const CLOCK_SKEW_MS = 5_000;

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Sign in for real and return the headers a browser would send next — the only way
 * to exercise the plugin's session-gated endpoints. */
async function signIn(user: User): Promise<Headers> {
  const res = await auth.api.signInEmail({
    body: { email: user.email, password: TEST_PASSWORD },
    headers: new Headers({ origin: BASE_URL }),
    asResponse: true,
  });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  expect(cookie).toContain('session_token');
  return new Headers({ cookie, origin: BASE_URL });
}

/** The plugin's `GET /device?user_code=…` — stamps `userId` onto the grant. Approve
 * and deny both refuse an unclaimed code, so every browser path starts here. */
async function claim(userCode: string, headers: Headers): Promise<void> {
  await auth.api.deviceVerify({ query: { user_code: userCode }, headers });
}

async function poll(deviceCode: string) {
  return asMinted(await cliDeviceService.poll({ deviceCode, clientId: CLI_CLIENT_ID }));
}

/** Clear the per-grant throttle so a test can poll twice in a row on purpose. The
 * alternative — a real 5-second wait per assertion — would add ~30s to the file. */
async function clearPollThrottle(deviceCode: string): Promise<void> {
  await db.deviceCode.update({ where: { deviceCode }, data: { lastPolledAt: null } });
}

/** Force the plugin's connection pool to open ≥ n physical connections so racing
 * transactions each get their own and run truly concurrently — the FOR UPDATE lock,
 * not a single shared connection, is then what serializes them. A cold pool would
 * serialize the writes and mask the double-mint race entirely. */
async function warmPool(n = 6): Promise<void> {
  await Promise.all(Array.from({ length: n }, () => db.$queryRaw`SELECT 1`));
}

describe('start', () => {
  it('issues an RFC 8628 grant, records the hostname, and persists a pending row', async () => {
    const grant = await cliDeviceService.start({ hostname: 'workbox' });

    expect(grant.device_code).toHaveLength(40);
    expect(grant.user_code).toHaveLength(8);
    // The default charset excludes 0/O/1/I/L — no override needed, and this asserts
    // the plugin has not changed it under us.
    expect(grant.user_code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    // Relative verificationUri resolved against Better-Auth's baseURL chain, with the
    // code pre-filled on the "complete" variant (what the CLI opens in a browser).
    expect(grant.verification_uri).toBe(`${BASE_URL}/device`);
    expect(grant.verification_uri_complete).toBe(`${BASE_URL}/device?user_code=${grant.user_code}`);
    expect(grant.expires_in).toBe(15 * 60); // the ADR's 15m, not the plugin's 30m
    expect(grant.interval).toBe(5);

    const row = await db.deviceCode.findUniqueOrThrow({
      where: { deviceCode: grant.device_code },
    });
    expect(row.status).toBe('pending');
    expect(row.userId).toBeNull();
    expect(row.workspaceId).toBeNull();
    expect(row.hostname).toBe('workbox');
    expect(row.clientId).toBe(CLI_CLIENT_ID);
    // The requested scope is recorded for RFC fidelity; the MINT reads the constant.
    expect(row.scope).toBe(CLI_TOKEN_SCOPES.join(' '));
    expect(row.pollingInterval).toBe(5000); // milliseconds, the plugin's unit
    expect(row.lastPolledAt).toBeNull();
  });

  it('falls back to a placeholder hostname so the token label is always valid', async () => {
    const grant = await cliDeviceService.start({ hostname: null });
    const row = await db.deviceCode.findUniqueOrThrow({
      where: { deviceCode: grant.device_code },
    });
    expect(row.hostname).toBe('unknown host');
  });

  it('caps an absurd hostname so `CLI · <host>` cannot exceed the 100-char label limit', async () => {
    const grant = await cliDeviceService.start({ hostname: 'h'.repeat(500) });
    const row = await db.deviceCode.findUniqueOrThrow({
      where: { deviceCode: grant.device_code },
    });
    expect(`CLI · ${row.hostname}`.length).toBeLessThanOrEqual(100);
  });
});

describe('poll — the five states', () => {
  it('answers authorization_pending before approval, and COMMITS the poll clock', async () => {
    const grant = await cliDeviceService.start({ hostname: 'workbox' });

    await expect(poll(grant.device_code)).rejects.toBeInstanceOf(DeviceGrantPendingError);

    // The regression guard for the trap this service is shaped around: the poll's
    // writes live inside a transaction, so THROWING from inside it would roll the
    // `lastPolledAt` stamp back and leave slow_down permanently unreachable. The
    // outcome is returned out of the transaction and thrown after it commits.
    const row = await db.deviceCode.findUniqueOrThrow({
      where: { deviceCode: grant.device_code },
    });
    expect(row.lastPolledAt).not.toBeNull();
    expect(row.status).toBe('pending');
  });

  it('answers slow_down when polled inside the interval, WITHOUT pushing the window forward', async () => {
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await expect(poll(grant.device_code)).rejects.toBeInstanceOf(DeviceGrantPendingError);
    const firstStamp = (
      await db.deviceCode.findUniqueOrThrow({ where: { deviceCode: grant.device_code } })
    ).lastPolledAt;

    await expect(poll(grant.device_code)).rejects.toBeInstanceOf(DeviceGrantSlowDownError);

    // A throttled poll must NOT re-stamp the clock — otherwise a hot-looping client
    // would never escape slow_down.
    const afterStamp = (
      await db.deviceCode.findUniqueOrThrow({ where: { deviceCode: grant.device_code } })
    ).lastPolledAt;
    expect(afterStamp?.getTime()).toBe(firstStamp?.getTime());
  });

  it('answers access_denied after a deny, and reaps the row', async () => {
    const { owner } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);
    await auth.api.deviceDeny({ body: { userCode: grant.user_code }, headers });

    await expect(poll(grant.device_code)).rejects.toBeInstanceOf(DeviceGrantDeniedError);

    // Denied grants are deleted on discovery: not re-pollable, and nothing minted.
    expect(await db.deviceCode.count({ where: { deviceCode: grant.device_code } })).toBe(0);
    expect(await adminDb.apiToken.count()).toBe(0);
  });

  it('answers expired_token past the expiry, and reaps the row', async () => {
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await db.deviceCode.update({
      where: { deviceCode: grant.device_code },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(poll(grant.device_code)).rejects.toBeInstanceOf(DeviceGrantExpiredError);
    expect(await db.deviceCode.count({ where: { deviceCode: grant.device_code } })).toBe(0);
  });

  it('answers invalid_grant for an unknown device code', async () => {
    await expect(poll('no-such-device-code')).rejects.toBeInstanceOf(InvalidDeviceGrantError);
  });

  it('answers invalid_grant for a client_id that is not the CLI', async () => {
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await expect(
      cliDeviceService.poll({ deviceCode: grant.device_code, clientId: 'someone-else' }),
    ).rejects.toBeInstanceOf(InvalidDeviceGrantError);
  });
});

describe('approve → poll — the mint', () => {
  it('mints exactly ONE CLI-scoped PAT the bearer gate accepts, and consumes the grant', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);

    await cliDeviceService.approve({
      userCode: grant.user_code,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      headers,
    });

    // Approval records a DECISION and mints nothing — the invariant that makes
    // "approve then kill the CLI" leave no credential behind.
    expect(await adminDb.apiToken.count()).toBe(0);
    const approved = await db.deviceCode.findUniqueOrThrow({
      where: { deviceCode: grant.device_code },
    });
    expect(approved.status).toBe('approved');
    expect(approved.workspaceId).toBe(workspace.id);
    expect(approved.userId).toBe(owner.id);

    const granted = await poll(grant.device_code);

    expect(granted.access_token.startsWith('motir_pat_')).toBe(true);
    expect(granted.token_type).toBe('Bearer');
    expect(granted.scope).toBe([...CLI_TOKEN_GRANT].join(' '));
    // 90 days, derived from the token's own expiresAt (never from the constant).
    expect(granted.expires_in).toBeGreaterThan(CLI_TOKEN_EXPIRY_DAYS * 86400 - 60);
    expect(granted.expires_in).toBeLessThanOrEqual(CLI_TOKEN_EXPIRY_DAYS * 86400);
    expect(granted.user).toEqual({ id: owner.id, name: owner.name, email: owner.email });
    expect(granted.workspace).toEqual({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
    });

    // Exactly one token row, with the ADR's label / grant / expiry / binding.
    const tokens = await adminDb.apiToken.findMany();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.label).toBe('CLI · workbox');
    // The stored grant is CLI_TOKEN_GRANT beside the mint path's marker (MOTIR-6329).
    expect([...tokens[0]!.scopes].sort()).toEqual(
      [...CLI_TOKEN_GRANT, GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER].sort(),
    );
    expect(tokens[0]!.workspaceId).toBe(workspace.id);
    expect(tokens[0]!.userId).toBe(owner.id);
    const daysOut = (tokens[0]!.expiresAt!.getTime() - Date.now()) / DAY_MS;
    expect(daysOut).toBeGreaterThan(CLI_TOKEN_EXPIRY_DAYS - 1);
    expect(daysOut).toBeLessThanOrEqual(CLI_TOKEN_EXPIRY_DAYS);

    // The whole point: this plaintext is a credential the bearer gates accept, bound
    // to the chosen workspace (never the owner's default).
    const verified = await apiTokensService.verify(granted.access_token);
    expect(verified.user.id).toBe(owner.id);
    expect(verified.workspaceId).toBe(workspace.id);
    expect([...verified.grant].sort()).toEqual([...CLI_TOKEN_GRANT].sort());

    // Single-use: the grant is gone, so a second poll cannot re-issue.
    expect(await db.deviceCode.count()).toBe(0);
  });

  it('does NOT re-issue on a second poll of the same device code', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);
    await cliDeviceService.approve({
      userCode: grant.user_code,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      headers,
    });
    await poll(grant.device_code);

    await expect(poll(grant.device_code)).rejects.toBeInstanceOf(InvalidDeviceGrantError);
    expect(await adminDb.apiToken.count()).toBe(1);
  });

  it('mints a NARROWER grant than a settings-minted token (never the default set)', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);
    await cliDeviceService.approve({
      userCode: grant.user_code,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      headers,
    });
    const granted = await poll(grant.device_code);

    const scopes = (await apiTokensService.verify(granted.access_token)).scopes;
    // The three every tool the CLI calls needs — and none of the destructive ones the
    // default set would have handed to a credential living unattended on a box.
    expect(scopes).not.toContain('work_items:delete');
    expect(scopes).not.toContain('work_items:archive');
    expect(scopes).not.toContain('sprints:write');
  });

  it('accepts a dash-grouped, lowercase user code (both sides normalise identically)', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);

    const typed = `${grant.user_code.slice(0, 4)}-${grant.user_code.slice(4)}`.toLowerCase();
    await cliDeviceService.approve({
      userCode: typed,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      headers,
    });

    const granted = await poll(grant.device_code);
    expect(granted.access_token.startsWith('motir_pat_')).toBe(true);
  });
});

describe('approve — the gates', () => {
  it('refuses a workspace the approver is not a member of, and writes NO binding', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const { workspace: foreign } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);

    await expect(
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: foreign.id,
        actorUserId: owner.id,
        headers,
      }),
    ).rejects.toBeInstanceOf(NotAMemberError);

    // The membership gate runs BEFORE the binding write, so nothing was recorded and
    // the grant is still approvable against a legitimate workspace.
    const row = await db.deviceCode.findUniqueOrThrow({
      where: { deviceCode: grant.device_code },
    });
    expect(row.workspaceId).toBeNull();
    expect(row.status).toBe('pending');

    await cliDeviceService.approve({
      userCode: grant.user_code,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      headers,
    });
    expect(
      (await db.deviceCode.findUniqueOrThrow({ where: { deviceCode: grant.device_code } }))
        .workspaceId,
    ).toBe(workspace.id);
  });

  it('refuses a code no verifying session has claimed yet', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    // No claim() — the /device page skipped GET /api/auth/device?user_code=…

    await expect(
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: workspace.id,
        actorUserId: owner.id,
        headers,
      }),
    ).rejects.toBeInstanceOf(DeviceGrantNotClaimedError);
    expect(
      (await db.deviceCode.findUniqueOrThrow({ where: { deviceCode: grant.device_code } }))
        .workspaceId,
    ).toBeNull();
  });

  it('refuses an approver who is not the session that claimed the code', async () => {
    const { owner: alice } = await createTestWorkspace();
    const { owner: bob, workspace: bobWs } = await createTestWorkspace();
    const aliceHeaders = await signIn(alice);
    const bobHeaders = await signIn(bob);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, aliceHeaders); // Alice claimed it

    await expect(
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: bobWs.id,
        actorUserId: bob.id,
        headers: bobHeaders,
      }),
    ).rejects.toBeInstanceOf(DeviceGrantForbiddenError);
    expect(await adminDb.apiToken.count()).toBe(0);
  });

  it('refuses an already-approved grant rather than replaying it', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);
    await cliDeviceService.approve({
      userCode: grant.user_code,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      headers,
    });

    await expect(
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: workspace.id,
        actorUserId: owner.id,
        headers,
      }),
    ).rejects.toBeInstanceOf(DeviceGrantNotPendingError);
  });

  it('refuses an expired code', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);
    await db.deviceCode.update({
      where: { deviceCode: grant.device_code },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: workspace.id,
        actorUserId: owner.id,
        headers,
      }),
    ).rejects.toBeInstanceOf(DeviceGrantExpiredError);
  });
});

// ── the pre-check ↔ flip window (Bug MOTIR-1955) ─────────────────────────────
// `approve` validates the row inside a transaction and the plugin re-validates it at
// the flip, so `translateApproveError` is reached only when the two disagree: the row
// changed in that window, or the forwarded SESSION is not the one the pre-checks
// approved for. Every refusal the pre-checks CAN see (expired, not pending, unclaimed,
// wrong approver) is thrown before the plugin is ever called, which is why nothing
// above this block reaches the translator.
//
// Until MOTIR-1955 the only test that reached it was the two-simultaneous-approvals
// race at the bottom of this file, whose assertions hold whichever side the loser
// lands on — including the side where both flips slip through and the translator is
// never entered. On 2026-08-01 a CI run landed there: all 35 tests passed, the file's
// line coverage fell 96.34% → 87.8%, and the per-file gate failed a PR whose diff was
// one unrelated test file. Coverage supplied by a race is coverage that is not there,
// so each branch is pinned deterministically here instead.
describe('approve — the flip refuses after the pre-checks passed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A pending, claimed grant — the state every test below starts the flip from. */
  async function claimedGrant() {
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);
    return { owner, workspace, headers, grant };
  }

  // The two REAL refusals: no stub, the plugin's own session read does the rejecting.
  it('refuses a flip carrying no session, and leaves the row pending for a retry', async () => {
    const { owner, workspace, grant } = await claimedGrant();

    await expect(
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: workspace.id,
        actorUserId: owner.id,
        headers: new Headers({ origin: BASE_URL }),
      }),
    ).rejects.toBeInstanceOf(DeviceGrantForbiddenError);

    // The binding is written BEFORE the flip, so a refused flip leaves it on a row
    // that is still `pending` — which is the documented recovery: press Approve again.
    const row = await db.deviceCode.findUniqueOrThrow({
      where: { deviceCode: grant.device_code },
    });
    expect(row.status).toBe('pending');
    expect(row.workspaceId).toBe(workspace.id);
    expect(await adminDb.apiToken.count()).toBe(0);
  });

  it('refuses a flip carrying a DIFFERENT signed-in session than the one that claimed', async () => {
    const { owner, workspace, grant } = await claimedGrant();
    const stranger = await createTestWorkspace();
    const strangerHeaders = await signIn(stranger.owner);

    // `actorUserId` matches the row's claim, so every pre-check passes; only the
    // plugin sees that the session behind the flip belongs to somebody else.
    await expect(
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: workspace.id,
        actorUserId: owner.id,
        headers: strangerHeaders,
      }),
    ).rejects.toBeInstanceOf(DeviceGrantForbiddenError);
  });

  // The remaining codes describe a row that changed BETWEEN the pre-checks and the
  // flip. That window is a genuine race — the concurrency test below hits it only
  // sometimes — so it is driven at the plugin boundary here. What is asserted is
  // Motir's own translation table, not Better-Auth's behaviour: the CLI must receive
  // the typed domain error for each documented RFC 8628 code, never a raw 500.
  it('translates a row that stopped being pending in the window into not-pending', async () => {
    const { owner, workspace, headers, grant } = await claimedGrant();
    vi.spyOn(auth.api, 'deviceApprove').mockRejectedValue(
      new APIError('BAD_REQUEST', { error: 'invalid_request' }),
    );

    await expect(
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: workspace.id,
        actorUserId: owner.id,
        headers,
      }),
    ).rejects.toBeInstanceOf(DeviceGrantNotPendingError);
  });

  it('translates a code that expired in the window into expired', async () => {
    const { owner, workspace, headers, grant } = await claimedGrant();
    vi.spyOn(auth.api, 'deviceApprove').mockRejectedValue(
      new APIError('BAD_REQUEST', { error: 'expired_token' }),
    );

    await expect(
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: workspace.id,
        actorUserId: owner.id,
        headers,
      }),
    ).rejects.toBeInstanceOf(DeviceGrantExpiredError);
  });

  it('rethrows an APIError whose code it does not recognise rather than mistranslating it', async () => {
    const { owner, workspace, headers, grant } = await claimedGrant();
    const unrecognised = new APIError('BAD_REQUEST', { error: 'something_new' });
    vi.spyOn(auth.api, 'deviceApprove').mockRejectedValue(unrecognised);

    // A code this table has never seen must surface AS ITSELF. Folding it into one of
    // the four would tell the CLI a specific, wrong story about a grant.
    await expect(
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: workspace.id,
        actorUserId: owner.id,
        headers,
      }),
    ).rejects.toBe(unrecognised);
  });
});

// The `/device` page's read (Subtask MOTIR-1888). What these cover that the route suite
// cannot: that the call CLAIMS as a side effect, that the granted scopes come from the
// constant rather than the row, and that the DTO withholds the CLI's own credential.
describe('describe — claim + what is connecting', () => {
  it('claims the row and returns what is connecting', async () => {
    const { owner } = await createTestWorkspace();
    const headers = await signIn(owner);
    const before = Date.now();
    const grant = await cliDeviceService.start({ hostname: 'workbox' });

    const described = await cliDeviceService.describe({
      userCode: grant.user_code,
      actorUserId: owner.id,
      headers,
    });

    expect(described.status).toBe('pending');
    expect(described.hostname).toBe('workbox');
    expect(described.userCode).toBe(grant.user_code);
    expect(described.clientId).toBe(CLI_CLIENT_ID);
    // "asked for N seconds ago" is computed by the page from `askedAt`, so it has to be
    // the grant's real creation instant, and `expiresAt` the 15m the ADR decided.
    //
    // The span is asserted with a TOLERANCE, not exactly: `expiresAt` is stamped by the
    // plugin in JS (`Date.now() + ms('15m')`) while `askedAt` is the row's
    // `@default(now())` — two INDEPENDENT clock readings, so they differ by however long
    // the insert took plus any app↔DB skew. An exact `toBe(900_000)` passes locally and
    // then loses by a millisecond on a loaded runner (it read 899_999 in CI); what the
    // ADR actually decided is the 15-minute lifetime, which is what this checks.
    // Same reason `before` gets a skew allowance rather than a bare `>=`: `created_at` is
    // `DEFAULT CURRENT_TIMESTAMP`, so `askedAt` is the DATABASE's clock while `before` is
    // this process's. Bounded on BOTH sides — what matters is that `askedAt` is the real
    // creation instant (not epoch, not null, not stale), which a window proves and an
    // exact comparison only pretends to.
    const askedAtMs = new Date(described.askedAt).getTime();
    expect(askedAtMs).toBeGreaterThan(before - CLOCK_SKEW_MS);
    expect(askedAtMs).toBeLessThan(Date.now() + CLOCK_SKEW_MS);

    const lifetimeMs = new Date(described.expiresAt).getTime() - askedAtMs;
    expect(lifetimeMs).toBeGreaterThan(14 * 60 * 1000);
    expect(lifetimeMs).toBeLessThanOrEqual(15 * 60 * 1000 + CLOCK_SKEW_MS);

    // THE SIDE EFFECT that makes this one call instead of two: approve refuses an
    // unclaimed grant, so a page that rendered these facts can now actually approve.
    const row = await db.deviceCode.findUniqueOrThrow({
      where: { deviceCode: grant.device_code },
    });
    expect(row.userId).toBe(owner.id);
  });

  it('reports the scopes approval WILL GRANT, never the scope string the request asked for', async () => {
    const { owner } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    // A tampered/widened request record must not change what the screen promises: the
    // grant is unconfigurable (ADR Q2) and the mint reads the constant.
    await db.deviceCode.update({
      where: { deviceCode: grant.device_code },
      data: { scope: 'read work_items:delete sprints:write' },
    });

    const described = await cliDeviceService.describe({
      userCode: grant.user_code,
      actorUserId: owner.id,
      headers,
    });

    expect(described.permissions).toEqual([...CLI_TOKEN_GRANT]);
    expect(described.permissions).not.toContain('work_item:delete');
  });

  it('never returns the device code, the user, the workspace, or a token', async () => {
    const { owner } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });

    const described = await cliDeviceService.describe({
      userCode: grant.user_code,
      actorUserId: owner.id,
      headers,
    });

    // An EXACT key set, not a spot-check: a `...row` spread added later would leak the
    // CLI's polling credential onto a browser surface, and only this assertion catches it.
    expect(Object.keys(described).sort()).toEqual([
      'askedAt',
      'clientId',
      'expiresAt',
      'hostname',
      'permissions',
      'status',
      'update',
      'userCode',
    ]);
    expect(JSON.stringify(described)).not.toContain(grant.device_code);
    // `update` (MOTIR-10189) names a token only for a refresh, and never its secret.
    expect(described.update).toBeNull();
  });

  it('accepts a dash-grouped, lowercase code as the same grant', async () => {
    const { owner } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });

    const typed = `${grant.user_code.slice(0, 4)}-${grant.user_code.slice(4)}`.toLowerCase();
    const described = await cliDeviceService.describe({
      userCode: typed,
      actorUserId: owner.id,
      headers,
    });

    // The CANONICAL form comes back, so the screen echoes what the server matched.
    expect(described.userCode).toBe(grant.user_code);
    expect(
      (await db.deviceCode.findUniqueOrThrow({ where: { deviceCode: grant.device_code } })).userId,
    ).toBe(owner.id);
  });

  it('returns approved and denied as a STATUS, not an error — they are terminal screens', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);

    const approvedGrant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(approvedGrant.user_code, headers);
    await cliDeviceService.approve({
      userCode: approvedGrant.user_code,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      headers,
    });
    const deniedGrant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(deniedGrant.user_code, headers);
    await auth.api.deviceDeny({ body: { userCode: deniedGrant.user_code }, headers });

    expect(
      (
        await cliDeviceService.describe({
          userCode: approvedGrant.user_code,
          actorUserId: owner.id,
          headers,
        })
      ).status,
    ).toBe('approved');
    expect(
      (
        await cliDeviceService.describe({
          userCode: deniedGrant.user_code,
          actorUserId: owner.id,
          headers,
        })
      ).status,
    ).toBe('denied');
  });

  it('rejects an unknown code', async () => {
    const { owner } = await createTestWorkspace();
    const headers = await signIn(owner);

    await expect(
      cliDeviceService.describe({ userCode: 'ZZZZZZZZ', actorUserId: owner.id, headers }),
    ).rejects.toBeInstanceOf(InvalidDeviceGrantError);
  });

  it('rejects an expired code WITHOUT claiming it', async () => {
    const { owner } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await db.deviceCode.update({
      where: { deviceCode: grant.device_code },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      cliDeviceService.describe({ userCode: grant.user_code, actorUserId: owner.id, headers }),
    ).rejects.toBeInstanceOf(DeviceGrantExpiredError);
    // The plugin checks expiry before it looks at the session, so a dead code is never
    // attributed to whoever happened to open the link.
    expect(
      (await db.deviceCode.findUniqueOrThrow({ where: { deviceCode: grant.device_code } })).userId,
    ).toBeNull();
  });

  it('refuses a grant another session already claimed', async () => {
    const { owner: alice } = await createTestWorkspace();
    const { owner: bob } = await createTestWorkspace();
    const aliceHeaders = await signIn(alice);
    const bobHeaders = await signIn(bob);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, aliceHeaders); // Alice claimed it

    await expect(
      cliDeviceService.describe({
        userCode: grant.user_code,
        actorUserId: bob.id,
        headers: bobHeaders,
      }),
    ).rejects.toBeInstanceOf(DeviceGrantForbiddenError);
    // Bob's read left Alice's claim intact — the plugin only stamps an UNclaimed row.
    expect(
      (await db.deviceCode.findUniqueOrThrow({ where: { deviceCode: grant.device_code } })).userId,
    ).toBe(alice.id);
  });

  it('refuses when the claim could not land (no session forwarded to the plugin)', async () => {
    const { owner } = await createTestWorkspace();
    const grant = await cliDeviceService.start({ hostname: 'workbox' });

    // The route gates on `getSession()`, but the plugin performs its own session read off
    // the forwarded headers. Cookie-less headers mean the claim silently does not happen —
    // a client-sequencing bug, and returning the facts anyway would show a screen whose
    // Approve button is guaranteed to 409.
    await expect(
      cliDeviceService.describe({
        userCode: grant.user_code,
        actorUserId: owner.id,
        headers: new Headers({ origin: BASE_URL }),
      }),
    ).rejects.toBeInstanceOf(DeviceGrantNotClaimedError);
  });

  it('rejects a status outside the plugin machine as an unusable grant, not a 500', async () => {
    const { owner } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);
    // `status` is a plain String column owned by the plugin's adapter, so the type system
    // cannot rule this out; a corrupted row must not become a fourth state the page has
    // no screen for.
    await db.deviceCode.update({
      where: { deviceCode: grant.device_code },
      data: { status: 'nonsense' },
    });

    await expect(
      cliDeviceService.describe({ userCode: grant.user_code, actorUserId: owner.id, headers }),
    ).rejects.toBeInstanceOf(InvalidDeviceGrantError);
  });

  it('answers a grant reaped between the claim and the read as gone', async () => {
    const { owner } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });

    // The benign race the read is documented to tolerate: a concurrent poll reaps the row
    // (denied/expired grants are deleted on discovery) in the window between the plugin's
    // lookup and Motir's. That window cannot be hit by deleting the row up front — the
    // plugin's own lookup would miss first and answer for a different reason — so the
    // repository read is stubbed for exactly one call. This is the ONE mock in this file,
    // and it stands in for a concurrent transaction, not for a collaborator.
    const spy = vi
      .spyOn(deviceCodeRepository, 'findByUserCodeForRead')
      .mockResolvedValueOnce(null as never);
    try {
      await expect(
        cliDeviceService.describe({ userCode: grant.user_code, actorUserId: owner.id, headers }),
      ).rejects.toBeInstanceOf(InvalidDeviceGrantError);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('concurrency (real Postgres, warm pool)', () => {
  it('two SIMULTANEOUS polls of one approved grant mint exactly ONE token', async () => {
    // The race this guards: the CLI polls on an interval, so two requests can observe
    // the same `approved` row and both mint — two credentials for one approval. The
    // guard is that the single-use DELETE is the claim, taken under a FOR UPDATE lock
    // (notes.html #35), so the loser re-reads nothing. Without the lock + re-read this
    // test yields two api_token rows under a warm pool.
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);
    await cliDeviceService.approve({
      userCode: grant.user_code,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      headers,
    });
    // Both racers must clear the throttle check, or the loser would answer slow_down
    // for the wrong reason and the double-mint window would never be probed.
    await clearPollThrottle(grant.device_code);

    await warmPool();
    const results = await Promise.allSettled([poll(grant.device_code), poll(grant.device_code)]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof poll>>
    >[];
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // Either legitimate outcome for the loser: the row was already consumed
    // (invalid_grant) or it lost the throttle check (slow_down) — never a second token.
    expect(
      rejected[0]!.reason instanceof InvalidDeviceGrantError ||
        rejected[0]!.reason instanceof DeviceGrantSlowDownError,
    ).toBe(true);

    const tokens = await adminDb.apiToken.findMany();
    expect(tokens).toHaveLength(1);
    // The winner's plaintext is the one that works; there is no second credential.
    const verified = await apiTokensService.verify(fulfilled[0]!.value.access_token);
    expect(verified.workspaceId).toBe(workspace.id);
    expect(await db.deviceCode.count()).toBe(0);
  });

  it('two SIMULTANEOUS approvals of one grant approve it once and mint NOTHING', async () => {
    // Approval is the other read-derived write on this row (read status, write the
    // workspace binding + the flip). It mints nothing by design, so the invariant here
    // is weaker than the poll's: at most one approval succeeds, the row ends up
    // approved exactly once with a workspace the approver chose, and no credential
    // exists until someone polls.
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);

    await warmPool();
    const results = await Promise.allSettled([
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: workspace.id,
        actorUserId: owner.id,
        headers,
      }),
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: workspace.id,
        actorUserId: owner.id,
        headers,
      }),
    ]);

    // At least one must succeed; a loser (if any) is refused as already-processed —
    // never with a second credential and never leaving the row unapproved.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(DeviceGrantNotPendingError);
      }
    }
    const row = await db.deviceCode.findUniqueOrThrow({
      where: { deviceCode: grant.device_code },
    });
    expect(row.status).toBe('approved');
    expect(row.workspaceId).toBe(workspace.id);
    expect(await adminDb.apiToken.count()).toBe(0);

    // And the grant still mints exactly once afterwards.
    await clearPollThrottle(grant.device_code);
    await poll(grant.device_code);
    expect(await adminDb.apiToken.count()).toBe(1);
  });
});

// ── the story gate's residue (Subtask MOTIR-1870) ────────────────────────────
// Branches the per-subtask suite above left unproven, found by measuring this
// story's surface as a whole rather than card by card. Each is a REACHABLE state
// with a real consequence, so each is exercised rather than waived: a grant
// opened for another client, an approved row that cannot be honoured, an approver
// who lost the workspace between approving and polling, and a token with no
// expiry crossing the mapper.

describe('poll — the states only a corrupted or shifted grant reaches', () => {
  it('answers invalid_grant when the ROW was opened for a different client', async () => {
    // The `client_id` pin has two halves: the value the poller presents (covered
    // above) and the value recorded on the grant. This is the second — a grant
    // opened by some other client cannot be collected by the CLI even though the
    // CLI presents the right id.
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);
    await cliDeviceService.approve({
      userCode: grant.user_code,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      headers,
    });
    await db.deviceCode.update({
      where: { deviceCode: grant.device_code },
      data: { clientId: 'some-other-client' },
    });

    await expect(poll(grant.device_code)).rejects.toBeInstanceOf(InvalidDeviceGrantError);
    expect(await adminDb.apiToken.count()).toBe(0);
  });

  it('refuses to mint from an APPROVED grant that carries no workspace binding', async () => {
    // Structurally unreachable through `approve` (which writes the binding BEFORE
    // the flip, under the row lock) — which is exactly why it is worth a test: it
    // pins the poll's refusal to mint from a row it cannot honour, so a future
    // reordering of those two writes fails here instead of minting a token into
    // an unknown workspace.
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);
    await cliDeviceService.approve({
      userCode: grant.user_code,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      headers,
    });
    await db.deviceCode.update({
      where: { deviceCode: grant.device_code },
      data: { workspaceId: null },
    });

    await expect(poll(grant.device_code)).rejects.toBeInstanceOf(DeviceGrantUnboundError);
    expect(await adminDb.apiToken.count()).toBe(0);
  });

  it('answers invalid_grant when the approver lost the workspace before the poll', async () => {
    // The window the mint's `NotAMemberError` catch exists for: approval passed the
    // membership check, then the user was removed from the workspace before the
    // terminal collected. The grant is already consumed, so there is nothing to
    // retry against — `invalid_grant` and re-running `motir login` is the fix.
    const { owner, workspace } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'workbox' });
    await claim(grant.user_code, headers);
    await cliDeviceService.approve({
      userCode: grant.user_code,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      headers,
    });

    // Org membership is what gates workspace access (`resolveWorkspaceAccess`
    // returns null without it, even with a stale workspace-membership row), so
    // removing the user from the ORG is what "lost the workspace" means here.
    // Class 3 (a fixture WRITE) → `adminDb`: on the singleton both deletes match
    // nothing and the precondition this test is named for never happens.
    await adminDb.organizationMembership.deleteMany({ where: { userId: owner.id } });
    await adminDb.workspaceMembership.deleteMany({
      where: { workspaceId: workspace.id, userId: owner.id },
    });

    await expect(poll(grant.device_code)).rejects.toBeInstanceOf(InvalidDeviceGrantError);
    expect(await adminDb.apiToken.count()).toBe(0);
    // Consumed either way: the claim committed before the mint was attempted, so a
    // failed mint does NOT resurrect the grant.
    expect(await db.deviceCode.count()).toBe(0);
  });
});

describe('toDeviceGrantTokenDTO — the never-expiring token', () => {
  it('reports expires_in 0 for a token with no expiry, rather than a NaN countdown', async () => {
    // The device grant always sets 90 days, so this arm is only reachable if the
    // mapper is ever reused for a settings-minted `never` token — the moment it is,
    // an unguarded `new Date(null)` would send `NaN` to the CLI, which prints it.
    const { owner, workspace } = await createTestWorkspace();
    const { dto, token } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'never expires',
      fixedGrant: [...CLI_TOKEN_GRANT],
    });
    expect(dto.expiresAt).toBeNull();

    const mapped = toDeviceGrantTokenDTO({ token, dto, user: owner, workspace });

    expect(mapped.expires_in).toBe(0);
    expect(mapped.access_token).toBe(token);
    expect(mapped.scope).toBe(dto.permissions.join(' '));
  });
});

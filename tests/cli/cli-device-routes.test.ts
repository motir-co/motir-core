import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@/generated/prisma/client';
import { grantForLegacyScopes } from '@/tests/helpers/tokenGrant';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';

// Same reason as the service suite: every approve test signs in for real, and
// Better-Auth's IP-keyed sign-in bucket (10s / 3) would 429 the fourth one under
// vitest, where there is no client IP to spread them across. Set in `vi.hoisted` so
// it lands before `lib/auth` freezes its config. Production never sets it.
vi.hoisted(() => {
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

const session = { current: null as { user: { id: string; email: string } } | null };
// Stub ONLY `getSession` — `importOriginal` keeps the real `auth` instance, which
// cliDeviceService needs (it drives the plugin's endpoints through `auth.api.*`) and
// which the approve path reads the session from a second time, off the request's own
// cookies. A wholesale module mock would replace the plugin with nothing.
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => session.current,
}));

const { db } = await import('@/lib/db');
const { auth } = await import('@/lib/auth');
const { cliDeviceService } = await import('@/lib/services/cliDeviceService');
const { apiTokensService } = await import('@/lib/services/apiTokensService');
const { CLI_CLIENT_ID } = await import('@/lib/cliDevice/constants');
const { createTestWorkspace } = await import('../fixtures/workspaceFixtures');
const { TEST_PASSWORD } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { adminDb } = await import('../helpers/adminDb');

// Import the handlers AFTER the mock is registered.
const { POST: START } = await import('@/app/api/cli/device/start/route');
const { POST: APPROVE } = await import('@/app/api/cli/device/approve/route');
const { POST: TOKEN } = await import('@/app/api/cli/device/token/route');
const { GET: GRANT } = await import('@/app/api/cli/device/grant/route');

// Transport tests for `/api/cli/device/*` (Story MOTIR-1863 · Subtask MOTIR-1865) —
// the three routes `motir login` and the /device page drive. Real Postgres, real
// Better-Auth plugin; only `getSession` is stubbed (the cookie the test env cannot
// supply — the sanctioned exception).
//
// What these assert that the service suite cannot: the WIRE CONTRACT. The poll speaks
// RFC 8628 (`{ error, error_description }` at HTTP 400, `no-store`), not Motir's
// `{ code }` convention, because its consumer is an OAuth client; start is
// deliberately unauthenticated; approve is deliberately session-only.
//
// ── WHICH CLIENT EACH DIRECT-DB LINE TAKES (MOTIR-2952) ─────────────────────
// The SAME split MOTIR-2911 wrote into the sibling service suite
// (`tests/cli/cliDeviceService.test.ts`), which this file was left out of:
//
//   * every `apiToken` assertion → **MOTIR-2881's class 2**, an ASSERTION doing
//     direct DB work rather than the subject of the test, so it takes `adminDb`,
//     the database OWNER. What it needs OWNERSHIP for: `api_token`'s only policy
//     is `api_token_owner_or_system` (`user_id = current_setting('app.user_id')`
//     OR `app.system_admin`), and a route test binds neither GUC on the
//     singleton — so the count is admitted no rows and answers `0` whether or
//     not the route minted anything. That is not merely why line 253's `toBe(1)`
//     went red under `motir_app`; it is why the three `toBe(0)` counts in this
//     file were passing for no reason at all, and they move too.
//   * `deviceCode` stays on `db`: `device_code` carries no RLS policy, so those
//     statements are already admitted and moving them would say something false
//     about why. The SUBJECT here is the route handlers, which keep running on
//     the singleton exactly as production does.

const BASE = 'http://localhost:3000/api/cli/device';
const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function jsonReq(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${BASE}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** The page's read — a GET, so the code rides in the query string exactly as the CLI
 * printed it in `verification_uri_complete`. */
function grantReq(userCode: string, headers: Record<string, string> = {}) {
  return new Request(`${BASE}/grant?user_code=${encodeURIComponent(userCode)}`, { headers });
}

function pollReq(deviceCode: string, clientId: string = CLI_CLIENT_ID) {
  return jsonReq('token', {
    grant_type: DEVICE_CODE_GRANT_TYPE,
    device_code: deviceCode,
    client_id: clientId,
  });
}

/** Sign in for real; returns the cookie header string the plugin's session read needs. */
async function signInCookie(user: User): Promise<string> {
  const res = await auth.api.signInEmail({
    body: { email: user.email, password: TEST_PASSWORD },
    headers: new Headers({ origin: 'http://localhost:3000' }),
    asResponse: true,
  });
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

function signInAs(user: { id: string; email: string }) {
  session.current = { user: { id: user.id, email: user.email } };
}

async function startedGrant(hostname = 'workbox') {
  return cliDeviceService.start({ hostname });
}

async function claim(userCode: string, cookie: string) {
  await auth.api.deviceVerify({
    query: { user_code: userCode },
    headers: new Headers({ cookie }),
  });
}

/** Clear the per-grant throttle so a test can poll twice without a real 5s wait. */
async function clearPollThrottle(deviceCode: string) {
  await db.deviceCode.update({ where: { deviceCode }, data: { lastPolledAt: null } });
}

describe('POST /api/cli/device/start', () => {
  it('issues a grant with NO credential of any kind (the terminal has none yet)', async () => {
    const res = await START(jsonReq('start', { hostname: 'workbox' }));
    expect(res.status).toBe(200);
    // Single-use codes must never be cached by a proxy (RFC 8628 §3.2).
    expect(res.headers.get('cache-control')).toBe('no-store');

    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'device_code',
      'expires_in',
      'interval',
      'user_code',
      'verification_uri',
      'verification_uri_complete',
    ]);
    expect(body['expires_in']).toBe(900);
    expect(body['interval']).toBe(5);
    expect(await db.deviceCode.count()).toBe(1);
  });

  it('accepts a bodyless start — hostname is optional', async () => {
    const res = await START(new Request(`${BASE}/start`, { method: 'POST' }));
    expect(res.status).toBe(200);
    expect((await db.deviceCode.findFirstOrThrow()).hostname).toBe('unknown host');
  });
});

describe('POST /api/cli/device/token — the five states on the wire', () => {
  it('400 invalid_request for a wrong grant_type, a missing device_code, or a missing client_id', async () => {
    const cases = [
      { grant_type: 'authorization_code', device_code: 'x', client_id: CLI_CLIENT_ID },
      { grant_type: DEVICE_CODE_GRANT_TYPE, client_id: CLI_CLIENT_ID },
      { grant_type: DEVICE_CODE_GRANT_TYPE, device_code: 'x' },
    ];
    for (const body of cases) {
      const res = await TOKEN(jsonReq('token', body));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_request');
    }
  });

  it('400 authorization_pending while the human has not approved yet', async () => {
    const grant = await startedGrant();
    const res = await TOKEN(pollReq(grant.device_code));
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe('authorization_pending');
    expect(body.error_description).toBeTruthy();
  });

  it('400 slow_down when polled inside the interval', async () => {
    const grant = await startedGrant();
    await TOKEN(pollReq(grant.device_code));
    const res = await TOKEN(pollReq(grant.device_code));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('slow_down');
  });

  it('400 invalid_grant for an unknown device_code or a foreign client_id', async () => {
    const unknown = await TOKEN(pollReq('nope'));
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toBe('invalid_grant');

    const grant = await startedGrant();
    const foreign = await TOKEN(pollReq(grant.device_code, 'not-the-cli'));
    expect(foreign.status).toBe(400);
    expect(((await foreign.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('400 expired_token once the code has aged out', async () => {
    const grant = await startedGrant();
    await db.deviceCode.update({
      where: { deviceCode: grant.device_code },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await TOKEN(pollReq(grant.device_code));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('expired_token');
  });

  it('400 access_denied after the human denies, writing nothing', async () => {
    const { owner } = await createTestWorkspace();
    const cookie = await signInCookie(owner);
    const grant = await startedGrant();
    await claim(grant.user_code, cookie);
    await auth.api.deviceDeny({
      body: { userCode: grant.user_code },
      headers: new Headers({ cookie }),
    });

    const res = await TOKEN(pollReq(grant.device_code));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('access_denied');
    expect(await adminDb.apiToken.count()).toBe(0);
  });

  it('200 with the PAT once approved — then 400 invalid_grant on the next poll', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const cookie = await signInCookie(owner);
    signInAs(owner);
    const grant = await startedGrant('workbox');
    await claim(grant.user_code, cookie);

    const approved = await APPROVE(
      jsonReq('approve', { userCode: grant.user_code, workspaceId: workspace.id }, { cookie }),
    );
    expect(approved.status).toBe(200);

    await clearPollThrottle(grant.device_code);
    const res = await TOKEN(pollReq(grant.device_code));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as {
      access_token: string;
      token_type: string;
      scope: string;
      expires_in: number;
      user: { id: string };
      workspace: { id: string; name: string; slug: string };
    };
    expect(body.access_token.startsWith('motir_pat_')).toBe(true);
    expect(body.token_type).toBe('Bearer');
    expect(body.scope).toBe([...CLI_TOKEN_GRANT].join(' '));
    expect(body.user.id).toBe(owner.id);
    expect(body.workspace).toEqual({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
    });

    // The plaintext appears exactly once on the wire: the grant is consumed, so the
    // next poll never even reaches the throttle check — there is no row to throttle.
    const again = await TOKEN(pollReq(grant.device_code));
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toBe('invalid_grant');
    expect(await adminDb.apiToken.count()).toBe(1);
  });
});

describe('POST /api/cli/device/approve', () => {
  it('401 when signed out — the mint is authorized by a browser session, nothing else', async () => {
    const grant = await startedGrant();
    const res = await APPROVE(jsonReq('approve', { userCode: grant.user_code, workspaceId: 'w' }));
    expect(res.status).toBe(401);
  });

  it('400 on a missing userCode; a missing workspaceId is the service’s call', async () => {
    const { owner, workspace } = await createTestWorkspace();
    signInAs(owner);
    expect((await APPROVE(jsonReq('approve', { workspaceId: workspace.id }))).status).toBe(400);
    // Optional on the wire since MOTIR-10189 (a refresh names none): an unknown code
    // without one is the unknown code's 404, and a LOGIN grant without one is a 400
    // (`cliDeviceRefresh.test.ts`).
    expect((await APPROVE(jsonReq('approve', { userCode: 'ABCDEFGH' }))).status).toBe(404);
  });

  it('403 for a workspace the approver is not a member of', async () => {
    const { owner } = await createTestWorkspace();
    const { workspace: foreign } = await createTestWorkspace();
    const cookie = await signInCookie(owner);
    signInAs(owner);
    const grant = await startedGrant();
    await claim(grant.user_code, cookie);

    const res = await APPROVE(
      jsonReq('approve', { userCode: grant.user_code, workspaceId: foreign.id }, { cookie }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('WORKSPACE_FORBIDDEN');
  });

  it('409 when the page never claimed the code first', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const cookie = await signInCookie(owner);
    signInAs(owner);
    const grant = await startedGrant();
    // No claim — GET /api/auth/device?user_code=… was skipped.

    const res = await APPROVE(
      jsonReq('approve', { userCode: grant.user_code, workspaceId: workspace.id }, { cookie }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('DEVICE_GRANT_NOT_CLAIMED');
  });

  it('404 for a user code that does not exist', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const cookie = await signInCookie(owner);
    signInAs(owner);
    const res = await APPROVE(
      jsonReq('approve', { userCode: 'ZZZZZZZZ', workspaceId: workspace.id }, { cookie }),
    );
    expect(res.status).toBe(404);
  });

  it('409 on re-approving an already-approved grant', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const cookie = await signInCookie(owner);
    signInAs(owner);
    const grant = await startedGrant();
    await claim(grant.user_code, cookie);
    const body = { userCode: grant.user_code, workspaceId: workspace.id };
    expect((await APPROVE(jsonReq('approve', body, { cookie }))).status).toBe(200);

    const res = await APPROVE(jsonReq('approve', body, { cookie }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('DEVICE_GRANT_NOT_PENDING');
  });
});

describe('GET /api/cli/device/grant — the approval screen’s read', () => {
  it('200 with what is connecting, no-store, and the row now CLAIMED', async () => {
    const { owner } = await createTestWorkspace();
    const cookie = await signInCookie(owner);
    signInAs(owner);
    const grant = await startedGrant('workbox');

    const res = await GRANT(grantReq(grant.user_code, { cookie }));
    expect(res.status).toBe(200);
    // A single-use credential-in-waiting whose status changes underneath the page.
    expect(res.headers.get('cache-control')).toBe('no-store');

    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'askedAt',
      'clientId',
      'expiresAt',
      'hostname',
      'permissions',
      'status',
      'update',
      'userCode',
    ]);
    expect(body['status']).toBe('pending');
    expect(body['hostname']).toBe('workbox');
    expect(body['permissions']).toEqual([...CLI_TOKEN_GRANT]);
    // The GET's side effect: the page can now approve (approve refuses an unclaimed code).
    expect(
      (await db.deviceCode.findUniqueOrThrow({ where: { deviceCode: grant.device_code } })).userId,
    ).toBe(owner.id);
  });

  it('resolves a dash-grouped lowercase code to the same grant, echoing the canonical form', async () => {
    const { owner } = await createTestWorkspace();
    const cookie = await signInCookie(owner);
    signInAs(owner);
    const grant = await startedGrant();

    const typed = `${grant.user_code.slice(0, 4)}-${grant.user_code.slice(4)}`.toLowerCase();
    const res = await GRANT(grantReq(typed, { cookie }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { userCode: string }).userCode).toBe(grant.user_code);
  });

  it('401 signed out — and a bearer PAT is NOT a credential here', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const grant = await startedGrant();

    const signedOut = await GRANT(grantReq(grant.user_code));
    expect(signedOut.status).toBe(401);

    // A real, valid PAT. This route reads `getSession()` and never the bearer gate, so a
    // token that authenticates the MCP transport authenticates nothing here — a PAT must
    // not be able to enumerate in-flight grants or claim one.
    const { token } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'probe',
      expiresAt: null,
      fixedGrant: grantForLegacyScopes(['read']),
    });
    const withPat = await GRANT(grantReq(grant.user_code, { authorization: `Bearer ${token}` }));
    expect(withPat.status).toBe(401);

    // Neither attempt claimed the row.
    expect(
      (await db.deviceCode.findUniqueOrThrow({ where: { deviceCode: grant.device_code } })).userId,
    ).toBeNull();
  });

  it('400 when user_code is missing or blank', async () => {
    const { owner } = await createTestWorkspace();
    signInAs(owner);
    expect((await GRANT(new Request(`${BASE}/grant`))).status).toBe(400);
    expect((await GRANT(grantReq('   '))).status).toBe(400);
  });

  it('404 unknown · 410 expired · 403 claimed by someone else', async () => {
    const { owner: alice } = await createTestWorkspace();
    const { owner: bob } = await createTestWorkspace();
    const aliceCookie = await signInCookie(alice);
    const bobCookie = await signInCookie(bob);

    signInAs(alice);
    const unknown = await GRANT(grantReq('ZZZZZZZZ', { cookie: aliceCookie }));
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { code: string }).code).toBe('DEVICE_GRANT_INVALID');

    const stale = await startedGrant();
    await db.deviceCode.update({
      where: { deviceCode: stale.device_code },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await GRANT(grantReq(stale.user_code, { cookie: aliceCookie }));
    expect(expired.status).toBe(410);
    expect(((await expired.json()) as { code: string }).code).toBe('DEVICE_GRANT_EXPIRED');

    const grant = await startedGrant();
    await claim(grant.user_code, aliceCookie); // Alice claimed it
    signInAs(bob);
    const forbidden = await GRANT(grantReq(grant.user_code, { cookie: bobCookie }));
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { code: string }).code).toBe('DEVICE_GRANT_FORBIDDEN');
  });

  it('409 when the session was gated but no cookie reached the plugin', async () => {
    const { owner } = await createTestWorkspace();
    signInAs(owner);
    const grant = await startedGrant();

    // `getSession()` is stubbed, so the route lets this through — but the plugin performs
    // its OWN session read off the forwarded headers, and without a cookie the claim never
    // lands. The page gets the same 409 `approve` answers for the same sequencing bug.
    const res = await GRANT(grantReq(grant.user_code));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('DEVICE_GRANT_NOT_CLAIMED');
  });

  it('200 for approved and for denied — terminal screens, not failures', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const cookie = await signInCookie(owner);
    signInAs(owner);

    const approvedGrant = await startedGrant();
    await claim(approvedGrant.user_code, cookie);
    expect(
      (
        await APPROVE(
          jsonReq(
            'approve',
            { userCode: approvedGrant.user_code, workspaceId: workspace.id },
            { cookie },
          ),
        )
      ).status,
    ).toBe(200);

    const deniedGrant = await startedGrant();
    await claim(deniedGrant.user_code, cookie);
    await auth.api.deviceDeny({
      body: { userCode: deniedGrant.user_code },
      headers: new Headers({ cookie }),
    });

    const approved = await GRANT(grantReq(approvedGrant.user_code, { cookie }));
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as { status: string }).status).toBe('approved');

    const denied = await GRANT(grantReq(deniedGrant.user_code, { cookie }));
    expect(denied.status).toBe(200);
    expect(((await denied.json()) as { status: string }).status).toBe('denied');
  });
});

// ── the story gate's residue (Subtask MOTIR-1870) ────────────────────────────
// Wire branches the transport suite above left unproven, found by measuring the
// story's surface as a whole. Every one of them is a real request some client
// will eventually send — a proxy that mangles a body, a grant that ages out
// mid-approval, a second browser that races the first — and each has a DIFFERENT
// status the page or the CLI branches on.

describe('the malformed-body branches — a request the client did not mean to send', () => {
  it('start still issues a grant when the body is unparseable or the hostname is not a string', async () => {
    // `hostname` is optional and display-only, so neither case is worth a 400 —
    // the login must not fail because a proxy mangled a body it did not need.
    const garbled = new Request(`${BASE}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    });
    const res = await START(garbled);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user_code: string }).user_code).toHaveLength(8);

    const wrongType = await START(jsonReq('start', { hostname: { not: 'a string' } }));
    expect(wrongType.status).toBe(200);
    // Falls back to the placeholder, so the token label stays valid.
    const row = await db.deviceCode.findFirstOrThrow({
      where: { deviceCode: ((await wrongType.json()) as { device_code: string }).device_code },
    });
    expect(row.hostname).toBe('unknown host');
  });

  it('start skips the body read entirely when the client declares content-length: 0', async () => {
    // A client that sends an explicit empty body (some HTTP stacks always do) must
    // not have its login fail on a body the endpoint does not need.
    const res = await START(
      new Request(`${BASE}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '0' },
      }),
    );
    expect(res.status).toBe(200);
    const grant = (await res.json()) as { device_code: string };
    const row = await db.deviceCode.findFirstOrThrow({
      where: { deviceCode: grant.device_code },
    });
    expect(row.hostname).toBe('unknown host');
  });

  it('the poll answers RFC 8628 invalid_request — not a crash — for a non-JSON body', async () => {
    const res = await TOKEN(
      new Request(`${BASE}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_request' });
  });

  it('approve answers 400 BAD_REQUEST for a non-JSON body', async () => {
    const { owner } = await createTestWorkspace();
    signInAs(owner);
    const res = await APPROVE(
      new Request(`${BASE}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'nope',
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('POST /api/cli/device/approve — the two states the page renders differently', () => {
  it('403 when the grant was claimed by a DIFFERENT signed-in user', async () => {
    // The phishing-relevant case on the approval surface: a second browser cannot
    // approve a grant the first one claimed. 403, not 409 — the page tells this
    // user the request is not theirs rather than "already handled".
    const { owner } = await createTestWorkspace();
    const { owner: other, workspace: otherWorkspace } = await createTestWorkspace();
    const grant = await startedGrant();
    await claim(grant.user_code, await signInCookie(owner));

    signInAs(other);
    const res = await APPROVE(
      jsonReq(
        'approve',
        { userCode: grant.user_code, workspaceId: otherWorkspace.id },
        { cookie: await signInCookie(other) },
      ),
    );

    expect(res.status).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'DEVICE_GRANT_FORBIDDEN',
    });
    // Nothing was bound, so the rightful owner's grant is still approvable.
    const row = await db.deviceCode.findUniqueOrThrow({ where: { userCode: grant.user_code } });
    expect(row.status).toBe('pending');
    expect(row.workspaceId).toBeNull();
  });

  it('410 when the code aged out while the human was still on the page', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const cookie = await signInCookie(owner);
    const grant = await startedGrant();
    await claim(grant.user_code, cookie);
    await db.deviceCode.update({
      where: { userCode: grant.user_code },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    signInAs(owner);
    const res = await APPROVE(
      jsonReq('approve', { userCode: grant.user_code, workspaceId: workspace.id }, { cookie }),
    );

    // 410 Gone — the page shows "this code expired, start again", which is a
    // different screen from 404 (never existed) and from 409 (already handled).
    expect(res.status).toBe(410);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'DEVICE_GRANT_EXPIRED' });
    expect(await adminDb.apiToken.count()).toBe(0);
  });
});

describe('POST /api/cli/device/token — the unbound grant', () => {
  it('500 server_error, the ONE retryable state, for an approved grant with no binding', async () => {
    // Unreachable through `approve` (the binding is written before the flip, under
    // the row lock), so this pins the CONTRACT: if a row ever reaches the poll in
    // that state, the CLI is told to retry rather than handed a token minted into
    // nowhere. `deviceAuth.ts` maps `server_error` to `{ state: 'retry' }`.
    const { owner, workspace } = await createTestWorkspace();
    const cookie = await signInCookie(owner);
    const grant = await startedGrant();
    await claim(grant.user_code, cookie);
    signInAs(owner);
    await APPROVE(
      jsonReq('approve', { userCode: grant.user_code, workspaceId: workspace.id }, { cookie }),
    );
    await db.deviceCode.update({
      where: { deviceCode: grant.device_code },
      data: { workspaceId: null },
    });
    await clearPollThrottle(grant.device_code);

    const res = await TOKEN(pollReq(grant.device_code));

    expect(res.status).toBe(500);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'server_error' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await adminDb.apiToken.count()).toBe(0);
  });
});

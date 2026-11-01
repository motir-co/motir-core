import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { User } from '@/generated/prisma/client';
import type { PermissionKey } from '@/lib/permissions/catalog';

// `motir auth refresh` on the server (MOTIR-10189): a device grant opened WITH a
// CLI sign-in's own secret, whose approval updates THAT token's grant to today's
// `CLI_TOKEN_GRANT` and mints nothing.
//
// Real Postgres and the REAL Better-Auth device plugin, as in
// `cliDeviceService.test.ts` (each test signs in for real and forwards the
// cookie). The one seam is the staff "View as" probe, driven by a flag, because
// a staff session cookie is not something a test can sign in to.
//
// The stale sign-in every test starts from is a REAL `motir login` token with
// `page:edit` taken out of its stored grant — what a sign-in minted before the
// CLI needed that key looks like.

vi.hoisted(() => {
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

const staff = vi.hoisted(() => ({ cookie: false }));
// The approve ROUTE gates on `getSession()`; stub only that (as
// `cli-device-routes.test.ts` does) and keep the real plugin behind it.
const session = vi.hoisted(() => ({
  current: null as { user: { id: string; email: string } } | null,
}));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => session.current,
}));
vi.mock('@/lib/platform/staffSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/staffSession')>();
  const { ImpersonationCredentialRefusedError } = await import('@/lib/platform/errors');
  return {
    ...actual,
    assertNoStaffSessionCookie: async () => {
      if (staff.cookie) throw new ImpersonationCredentialRefusedError();
    },
  };
});

const { db } = await import('@/lib/db');
const { auth } = await import('@/lib/auth');
const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } =
  await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { cliDeviceService } = await import('@/lib/services/cliDeviceService');
const { apiTokensService } = await import('@/lib/services/apiTokensService');
const { CLI_CLIENT_ID } = await import('@/lib/cliDevice/constants');
const { CLI_TOKEN_GRANT } = await import('@/lib/mcp/toolPermissions');
const { GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER } = await import('@/lib/tokens/grant');
const { PERMISSION_NOT_GRANTED_CODE } = await import('@/lib/mcp/permissionGate');
const {
  DeviceGrantDeniedError,
  DeviceGrantForbiddenError,
  DeviceGrantPendingError,
  DeviceGrantWorkspaceRequiredError,
  DeviceUpdateNotCliTokenError,
  DeviceUpdateRefusedError,
  InvalidDeviceGrantError,
} = await import('@/lib/cliDevice/errors');
const { InvalidApiTokenError, ApiTokenRevokedError } = await import('@/lib/apiTokens/errors');
const { createTestWorkspace } = await import('../fixtures/workspaceFixtures');
const { createTestProject } = await import('../fixtures/projectFixtures');
const { createTestUser, TEST_PASSWORD } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { adminDb } = await import('../helpers/adminDb');
const { mcpRouteFetch } = await import('../helpers/mcpRouteFetch');
const startRoute = await import('@/app/api/cli/device/start/route');
const approveRoute = await import('@/app/api/cli/device/approve/route');
const tokenRoute = await import('@/app/api/cli/device/token/route');
const statusRoute = await import('@/app/api/cli/token/route');

const BASE_URL = 'http://localhost:3000';
const STALE_KEY: PermissionKey = 'page:edit';
const STALE_GRANT = CLI_TOKEN_GRANT.filter((k) => k !== STALE_KEY);

beforeEach(async () => {
  await truncateAuthTables();
  staff.cookie = false;
  session.current = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

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
  return new Headers({ cookie, origin: BASE_URL });
}

/** Clear the per-grant throttle so the test can poll right after approving. */
async function clearPollThrottle(deviceCode: string): Promise<void> {
  await db.deviceCode.update({ where: { deviceCode }, data: { lastPolledAt: null } });
}

function poll(deviceCode: string) {
  return cliDeviceService.poll({ deviceCode, clientId: CLI_CLIENT_ID });
}

/** A real `motir login` token, then aged: `page:edit` taken out of its grant. */
async function staleSignIn() {
  const ws = await createTestWorkspace();
  const headers = await signIn(ws.owner);
  const login = await cliDeviceService.start({ hostname: 'yue-mbp' });
  await auth.api.deviceVerify({ query: { user_code: login.user_code }, headers });
  await cliDeviceService.approve({
    userCode: login.user_code,
    workspaceId: ws.workspace.id,
    actorUserId: ws.owner.id,
    headers,
  });
  const minted = await poll(login.device_code);
  if (!('access_token' in minted)) throw new Error('expected a minted token');
  const row = await adminDb.apiToken.findFirstOrThrow({ where: { userId: ws.owner.id } });
  await adminDb.apiToken.update({
    where: { id: row.id },
    data: { scopes: [...STALE_GRANT, GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER] },
  });
  return { ...ws, headers, secret: minted.access_token, tokenId: row.id };
}

/** Open a refresh with the held secret and claim it in the owner's browser. */
async function openRefresh(secret: string, headers: Headers) {
  const grant = await cliDeviceService.start({ hostname: 'yue-mbp', updateToken: secret });
  await auth.api.deviceVerify({ query: { user_code: grant.user_code }, headers });
  return grant;
}

async function storedScopes(tokenId: string): Promise<string[]> {
  const row = await adminDb.apiToken.findUniqueOrThrow({ where: { id: tokenId } });
  return [...row.scopes].sort();
}

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'), {
    fetch: mcpRouteFetch(token),
  });
  const client = new McpClient({ name: 'cli-refresh', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

function textOf(res: unknown): string {
  const content = (res as CallToolResult).content ?? [];
  return content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

describe('start — opening an update grant', () => {
  it('records the token the secret names on the grant row', async () => {
    const { secret, tokenId } = await staleSignIn();
    const grant = await cliDeviceService.start({ hostname: 'yue-mbp', updateToken: secret });
    const row = await db.deviceCode.findUniqueOrThrow({
      where: { deviceCode: grant.device_code },
    });
    expect(row.updateTokenId).toBe(tokenId);
    expect(row.status).toBe('pending');
  });

  it('refuses a token that is not a CLI sign-in, before any grant exists', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    const { token } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'claude-code',
      expiresAt: new Date(Date.now() + 86_400_000),
      projectId: project.id,
      permissions: ['project:browse'],
    });
    await expect(
      cliDeviceService.start({ hostname: 'h', updateToken: token }),
    ).rejects.toBeInstanceOf(DeviceUpdateNotCliTokenError);
    expect(await db.deviceCode.count()).toBe(0);
  });

  it('refuses an unknown or revoked secret as the api-token error', async () => {
    await expect(
      cliDeviceService.start({ hostname: 'h', updateToken: 'motir_pat_nope' }),
    ).rejects.toBeInstanceOf(InvalidApiTokenError);
    const { secret, tokenId } = await staleSignIn();
    await adminDb.apiToken.update({ where: { id: tokenId }, data: { revokedAt: new Date() } });
    await expect(
      cliDeviceService.start({ hostname: 'h', updateToken: secret }),
    ).rejects.toBeInstanceOf(ApiTokenRevokedError);
  });
});

describe('describe — what the approval screen shows', () => {
  it('names the token: label, prefix, workspace, expiry and its CURRENT grant', async () => {
    const { owner, workspace, headers, secret, tokenId } = await staleSignIn();
    const grant = await cliDeviceService.start({ hostname: 'yue-mbp', updateToken: secret });

    const described = await cliDeviceService.describe({
      userCode: grant.user_code,
      actorUserId: owner.id,
      headers,
    });

    const row = await adminDb.apiToken.findUniqueOrThrow({ where: { id: tokenId } });
    expect(described.update).toMatchObject({
      label: 'CLI · yue-mbp',
      tokenPrefix: row.tokenPrefix,
      workspaceName: workspace.name,
    });
    expect([...(described.update?.permissions ?? [])].sort()).toEqual([...STALE_GRANT].sort());
    expect(described.update?.permissions).not.toContain(STALE_KEY);
  });

  it('a login grant describes no update', async () => {
    const { owner } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'h' });
    const described = await cliDeviceService.describe({
      userCode: grant.user_code,
      actorUserId: owner.id,
      headers,
    });
    expect(described.update).toBeNull();
  });

  it('never describes another person’s token to the session that claimed the code', async () => {
    const { secret } = await staleSignIn();
    const stranger = await createTestUser();
    const strangerHeaders = await signIn(stranger);
    const grant = await cliDeviceService.start({ hostname: 'h', updateToken: secret });

    await expect(
      cliDeviceService.describe({
        userCode: grant.user_code,
        actorUserId: stranger.id,
        headers: strangerHeaders,
      }),
    ).rejects.toBeInstanceOf(DeviceGrantForbiddenError);
  });
});

describe('approve → poll — the update', () => {
  it('updates the SAME token to CLI_TOKEN_GRANT and answers the poll with no secret', async () => {
    const { owner, workspace, headers, secret, tokenId } = await staleSignIn();
    const before = await adminDb.apiToken.findUniqueOrThrow({ where: { id: tokenId } });
    const grant = await openRefresh(secret, headers);

    await cliDeviceService.approve({
      userCode: grant.user_code,
      workspaceId: null,
      actorUserId: owner.id,
      headers,
    });
    await clearPollThrottle(grant.device_code);
    const answered = await poll(grant.device_code);

    expect(answered).toEqual({
      updated: true,
      label: 'CLI · yue-mbp',
      scope: [...CLI_TOKEN_GRANT].join(' '),
      user: { id: owner.id, name: owner.name, email: owner.email },
      workspace: { id: workspace.id, name: workspace.name },
    });
    expect(answered).not.toHaveProperty('access_token');

    // One token, the same row: secret, prefix, label, binding and expiry unchanged.
    const tokens = await adminDb.apiToken.findMany();
    expect(tokens).toHaveLength(1);
    const after = tokens[0]!;
    expect(after.id).toBe(tokenId);
    expect(after.tokenHash).toBe(before.tokenHash);
    expect(after.tokenPrefix).toBe(before.tokenPrefix);
    expect(after.label).toBe(before.label);
    expect(after.workspaceId).toBe(before.workspaceId);
    expect(after.expiresAt?.getTime()).toBe(before.expiresAt?.getTime());
    expect(await storedScopes(tokenId)).toEqual(
      [...CLI_TOKEN_GRANT, GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER].sort(),
    );

    // The old secret now verifies with the key it lacked.
    const verified = await apiTokensService.verify(secret);
    expect(verified.grant).toContain(STALE_KEY);
    // Single use: the grant row is gone.
    expect(await db.deviceCode.count()).toBe(0);
  });

  it('a holder of the old secret is allowed a tool it was refused before', async () => {
    const { owner, workspace, headers, secret } = await staleSignIn();
    await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    const client = await connect(secret);
    const call = () =>
      client.callTool({
        name: 'create_page',
        arguments: { projectKey: 'PROD', title: 'Agent notes', markdown: 'First.' },
      });

    const denied = await call();
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain(PERMISSION_NOT_GRANTED_CODE);

    const grant = await openRefresh(secret, headers);
    await cliDeviceService.approve({
      userCode: grant.user_code,
      workspaceId: null,
      actorUserId: owner.id,
      headers,
    });

    const allowed = await call();
    expect(allowed.isError, textOf(allowed)).toBeFalsy();
    await client.close();
  });

  it('an update that is never approved changes nothing', async () => {
    const { headers, secret, tokenId } = await staleSignIn();
    const grant = await openRefresh(secret, headers);
    await expect(poll(grant.device_code)).rejects.toBeInstanceOf(DeviceGrantPendingError);
    expect(await storedScopes(tokenId)).toEqual(
      [...STALE_GRANT, GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER].sort(),
    );
  });

  it('a denied update changes nothing and answers access_denied', async () => {
    const { headers, secret, tokenId } = await staleSignIn();
    const grant = await openRefresh(secret, headers);
    await auth.api.deviceDeny({ body: { userCode: grant.user_code }, headers });

    await expect(poll(grant.device_code)).rejects.toBeInstanceOf(DeviceGrantDeniedError);
    expect(await storedScopes(tokenId)).toEqual(
      [...STALE_GRANT, GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER].sort(),
    );
  });

  it('a staff session is refused, the grant is DENIED, and the token is unchanged', async () => {
    const { owner, headers, secret, tokenId } = await staleSignIn();
    const grant = await openRefresh(secret, headers);
    staff.cookie = true;

    await expect(
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: null,
        actorUserId: owner.id,
        headers,
      }),
    ).rejects.toBeInstanceOf(DeviceUpdateRefusedError);

    expect(await storedScopes(tokenId)).toEqual(
      [...STALE_GRANT, GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER].sort(),
    );
    // The terminal learns of it on its next poll rather than waiting out the code.
    await expect(poll(grant.device_code)).rejects.toBeInstanceOf(DeviceGrantDeniedError);
  });

  it('a token revoked after the code was opened takes its grant with it', async () => {
    const { owner, headers, secret, tokenId } = await staleSignIn();
    const grant = await openRefresh(secret, headers);
    // Revoke DELETES nothing, so mirror a hard delete — the cascade the FK carries.
    await adminDb.apiToken.delete({ where: { id: tokenId } });

    expect(await db.deviceCode.count()).toBe(0);
    await expect(
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: null,
        actorUserId: owner.id,
        headers,
      }),
    ).rejects.toBeInstanceOf(InvalidDeviceGrantError);
    await expect(poll(grant.device_code)).rejects.toBeInstanceOf(InvalidDeviceGrantError);
  });

  it('a token revoked (soft) before approval is refused, and the grant is denied', async () => {
    const { owner, headers, secret, tokenId } = await staleSignIn();
    const grant = await openRefresh(secret, headers);
    await adminDb.apiToken.update({ where: { id: tokenId }, data: { revokedAt: new Date() } });

    await expect(
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: null,
        actorUserId: owner.id,
        headers,
      }),
    ).rejects.toBeInstanceOf(DeviceUpdateRefusedError);
    await expect(poll(grant.device_code)).rejects.toBeInstanceOf(DeviceGrantDeniedError);
  });

  it('a login grant still requires a workspace', async () => {
    const { owner } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'h' });
    await auth.api.deviceVerify({ query: { user_code: grant.user_code }, headers });
    await expect(
      cliDeviceService.approve({
        userCode: grant.user_code,
        workspaceId: null,
        actorUserId: owner.id,
        headers,
      }),
    ).rejects.toBeInstanceOf(DeviceGrantWorkspaceRequiredError);
  });
});

describe('tokenStatus — the input to `motir auth status`', () => {
  it('names what a stale CLI sign-in lacks, and nothing once refreshed', async () => {
    const { owner, headers, secret } = await staleSignIn();
    expect(await cliDeviceService.tokenStatus(secret)).toEqual({
      cliSignIn: true,
      missing: [STALE_KEY],
    });

    const grant = await openRefresh(secret, headers);
    await cliDeviceService.approve({
      userCode: grant.user_code,
      workspaceId: null,
      actorUserId: owner.id,
      headers,
    });
    expect(await cliDeviceService.tokenStatus(secret)).toEqual({ cliSignIn: true, missing: [] });
  });

  it('reports a project token as not a CLI sign-in, with nothing missing', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    const { token } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'claude-code',
      expiresAt: new Date(Date.now() + 86_400_000),
      projectId: project.id,
      permissions: ['project:browse'],
    });
    expect(await cliDeviceService.tokenStatus(token)).toEqual({ cliSignIn: false, missing: [] });
  });
});

describe('the routes', () => {
  function startReq(bearer?: string): Request {
    return new Request(`${BASE_URL}/api/cli/device/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ hostname: 'yue-mbp' }),
    });
  }

  it('POST start with a bearer opens an update grant; a bad bearer is 401', async () => {
    const { secret, tokenId } = await staleSignIn();
    const ok = await startRoute.POST(startReq(secret));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { device_code: string };
    const row = await db.deviceCode.findUniqueOrThrow({ where: { deviceCode: body.device_code } });
    expect(row.updateTokenId).toBe(tokenId);

    const bad = await startRoute.POST(startReq('motir_pat_nope'));
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ code: 'API_TOKEN_INVALID' });
  });

  it('POST start with a project token is 422 DEVICE_UPDATE_NOT_CLI_TOKEN', async () => {
    const { owner, workspace } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    const { token } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'claude-code',
      expiresAt: new Date(Date.now() + 86_400_000),
      projectId: project.id,
      permissions: ['project:browse'],
    });
    const res = await startRoute.POST(startReq(token));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('DEVICE_UPDATE_NOT_CLI_TOKEN');
  });

  it('the poll route answers an approved update with `{ updated: true }`', async () => {
    const { owner, headers, secret } = await staleSignIn();
    const grant = await openRefresh(secret, headers);
    await cliDeviceService.approve({
      userCode: grant.user_code,
      workspaceId: null,
      actorUserId: owner.id,
      headers,
    });
    const res = await tokenRoute.POST(
      new Request(`${BASE_URL}/api/cli/device/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: grant.device_code,
          client_id: CLI_CLIENT_ID,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['updated']).toBe(true);
    expect(body).not.toHaveProperty('access_token');
  });

  it('GET /api/cli/token: 200 with the status, 401 without a valid bearer', async () => {
    const { secret } = await staleSignIn();
    const get = (auth?: string) =>
      statusRoute.GET(
        new Request(`${BASE_URL}/api/cli/token`, {
          headers: auth ? { authorization: auth } : {},
        }),
      );

    const ok = await get(`Bearer ${secret}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ cliSignIn: true, missing: [STALE_KEY] });
    expect((await get()).status).toBe(401);
    expect((await get('Bearer motir_pat_nope')).status).toBe(401);
  });

  it('GET /api/cli/token rethrows what it does not map (a 500, never a wrong 401)', async () => {
    const spy = vi
      .spyOn(cliDeviceService, 'tokenStatus')
      .mockRejectedValueOnce(new Error('database down'));
    await expect(
      statusRoute.GET(
        new Request(`${BASE_URL}/api/cli/token`, { headers: { authorization: 'Bearer x' } }),
      ),
    ).rejects.toThrow('database down');
    spy.mockRestore();
  });

  it('an expired token is 401 on both bearer routes; a suspended organization is 403', async () => {
    const { workspace, secret, tokenId } = await staleSignIn();
    const status = () =>
      statusRoute.GET(
        new Request(`${BASE_URL}/api/cli/token`, {
          headers: { authorization: `Bearer ${secret}` },
        }),
      );

    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { suspendedAt: new Date(), suspendedReason: 'Abuse report' },
    });
    expect((await startRoute.POST(startReq(secret))).status).toBe(403);
    expect((await status()).status).toBe(403);

    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { suspendedAt: null, suspendedReason: null },
    });
    await adminDb.apiToken.update({
      where: { id: tokenId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await startRoute.POST(startReq(secret))).status).toBe(401);
    expect((await status()).status).toBe(401);

    // A row stamped revoked (the pre-delete revoke) answers the same 401.
    await adminDb.apiToken.update({
      where: { id: tokenId },
      data: { expiresAt: null, revokedAt: new Date() },
    });
    expect((await startRoute.POST(startReq(secret))).status).toBe(401);
    expect((await status()).status).toBe(401);
  });

  function approveReq(body: unknown, headers: Headers): Request {
    const h = new Headers(headers);
    h.set('content-type', 'application/json');
    return new Request(`${BASE_URL}/api/cli/device/approve`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify(body),
    });
  }

  it('POST approve: an update needs no workspace (200)', async () => {
    const { owner, headers, secret, tokenId } = await staleSignIn();
    const grant = await openRefresh(secret, headers);
    session.current = { user: { id: owner.id, email: owner.email } };

    const res = await approveRoute.POST(approveReq({ userCode: grant.user_code }, headers));

    expect(res.status).toBe(200);
    expect(await storedScopes(tokenId)).toContain(STALE_KEY);
  });

  it('POST approve: a refused update is 422 DEVICE_UPDATE_REFUSED', async () => {
    const { owner, headers, secret } = await staleSignIn();
    const grant = await openRefresh(secret, headers);
    session.current = { user: { id: owner.id, email: owner.email } };
    staff.cookie = true;

    const res = await approveRoute.POST(approveReq({ userCode: grant.user_code }, headers));

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('DEVICE_UPDATE_REFUSED');
  });

  it('POST approve: a login with no workspace is 400 DEVICE_GRANT_WORKSPACE_REQUIRED', async () => {
    const { owner } = await createTestWorkspace();
    const headers = await signIn(owner);
    const grant = await cliDeviceService.start({ hostname: 'h' });
    await auth.api.deviceVerify({ query: { user_code: grant.user_code }, headers });
    session.current = { user: { id: owner.id, email: owner.email } };

    const res = await approveRoute.POST(approveReq({ userCode: grant.user_code }, headers));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('DEVICE_GRANT_WORKSPACE_REQUIRED');
    // A non-string workspace id is a malformed request, not a missing one.
    const bad = await approveRoute.POST(
      approveReq({ userCode: grant.user_code, workspaceId: 7 }, headers),
    );
    expect(bad.status).toBe(400);
  });
});

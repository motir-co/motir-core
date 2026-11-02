import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PermissionKey } from '@/lib/permissions/catalog';

// Updating an existing token's permissions (MOTIR-10188): the service method,
// the PATCH route, and the proof that a client holding the token is answered
// under the new grant on its very next call — added AND removed — over the real
// `/api/mcp` route. Real Postgres (the repo testing contract); the two seams
// faked are the ones the test env cannot supply: the session cookie
// (`getSession`) and the staff-session cookie (`hasStaffSessionCookie`).

const session = { current: null as { user: { id: string; email: string } } | null };
const staff = { cookie: false };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => session.current,
}));
vi.mock('@/lib/platform/staffSession', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/platform/staffSession')>();
  const { ImpersonationCredentialRefusedError } = await import('@/lib/platform/errors');
  return {
    ...real,
    hasStaffSessionCookie: async () => staff.cookie,
    assertNoStaffSessionCookie: async () => {
      if (staff.cookie) throw new ImpersonationCredentialRefusedError();
    },
  };
});

const { db } = await import('@/lib/db');
const { apiTokensService } = await import('@/lib/services/apiTokensService');
const { runCredentialService } = await import('@/lib/services/runCredentialService');
const { dispatchRunService } = await import('@/lib/services/dispatchRunService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectAccessService } = await import('@/lib/services/projectAccessService');
const { ProjectNotFoundError } = await import('@/lib/projects/errors');
const { NotAMemberError } = await import('@/lib/workspaces/errors');
const { ApiTokenNotFoundError, InvalidTokenBindingError, InvalidTokenGrantError } =
  await import('@/lib/apiTokens/errors');
const { ImpersonationCredentialRefusedError } = await import('@/lib/platform/errors');
const { DEFAULT_TOKEN_GRANT, GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER, GRANTABLE_PERMISSIONS } =
  await import('@/lib/tokens/grant');
const { CLI_TOKEN_GRANT } = await import('@/lib/mcp/toolPermissions');
const { PERMISSION_NOT_GRANTED_CODE } = await import('@/lib/mcp/permissionGate');
const { PERMISSIONS } = await import('@/lib/permissions/catalog');
const { createTestWorkspace } = await import('../fixtures/workspaceFixtures');
const { createTestProject } = await import('../fixtures/projectFixtures');
const { makeWorkItemFixture } = await import('../fixtures/workItemFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { mcpRouteFetch } = await import('../helpers/mcpRouteFetch');
const { PATCH } = await import('@/app/api/me/api-tokens/[tokenId]/route');

const ENDPOINT = 'http://localhost/api/mcp';
const BASE = 'http://localhost:3000/api/me/api-tokens';
const PAGE_KEYS: PermissionKey[] = ['page:view', 'page:edit'];

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  staff.cookie = false;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** An owner, their workspace and one project (key PROD). */
async function ownerWithProject() {
  const ws = await createTestWorkspace();
  const project = await createTestProject({
    workspaceId: ws.workspace.id,
    actorUserId: ws.owner.id,
  });
  return { ...ws, project };
}

/** A bound token, minted through the real create path. */
async function mintBound(
  owner: { id: string },
  workspaceId: string,
  projectId: string,
  permissions: PermissionKey[],
) {
  return apiTokensService.create(owner.id, workspaceId, {
    label: 'claude-code',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    projectId,
    permissions,
  });
}

function patchReq(tokenId: string, body: unknown, raw?: string) {
  return {
    req: new Request(`${BASE}/${tokenId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: raw ?? JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ tokenId }) },
  };
}

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: mcpRouteFetch(token),
  });
  const client = new Client({ name: 'token-update', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

function textOf(res: unknown): string {
  const content = (res as CallToolResult).content ?? [];
  return content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

const withoutPages = DEFAULT_TOKEN_GRANT.filter((k) => !PAGE_KEYS.includes(k));

describe('apiTokensService.updatePermissions', () => {
  it('replaces the grant, writes the marker, and leaves every other column as minted', async () => {
    const { owner, workspace, project } = await ownerWithProject();
    const { token, dto } = await mintBound(owner, workspace.id, project.id, withoutPages);
    const before = await adminDb.apiToken.findUniqueOrThrow({ where: { id: dto.id } });

    const next: PermissionKey[] = [...withoutPages, ...PAGE_KEYS];
    const updated = await apiTokensService.updatePermissions(owner.id, dto.id, {
      permissions: [...next, 'page:view'],
    });

    expect([...updated.permissions].sort()).toEqual([...next].sort());
    const after = await adminDb.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    // The marker `create` writes, exactly once; the keys deduplicated.
    expect(after.scopes.filter((v) => v === GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER)).toHaveLength(1);
    expect(after.scopes.filter((v) => v !== GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER).sort()).toEqual(
      [...next].sort(),
    );
    // The credential itself is untouched.
    expect(after.tokenHash).toBe(before.tokenHash);
    expect(after.tokenPrefix).toBe(before.tokenPrefix);
    expect(after.label).toBe(before.label);
    expect(after.workspaceId).toBe(before.workspaceId);
    expect(after.projectId).toBe(before.projectId);
    expect(after.expiresAt?.toISOString()).toBe(before.expiresAt?.toISOString());
    expect(after.createdAt.toISOString()).toBe(before.createdAt.toISOString());
    // And the same secret still verifies — nothing to copy again.
    const verified = await apiTokensService.verify(token);
    expect(verified.tokenId).toBe(dto.id);
    for (const key of PAGE_KEYS) expect(verified.grant).toContain(key);
  });

  it("refuses another user's token as not-found and leaves it unchanged", async () => {
    const alice = await ownerWithProject();
    const bob = await ownerWithProject();
    const { dto } = await mintBound(bob.owner, bob.workspace.id, bob.project.id, withoutPages);

    await expect(
      apiTokensService.updatePermissions(alice.owner.id, dto.id, { permissions: PAGE_KEYS }),
    ).rejects.toBeInstanceOf(ApiTokenNotFoundError);
    await expect(
      apiTokensService.updatePermissions(alice.owner.id, 'no-such-token', {
        permissions: PAGE_KEYS,
      }),
    ).rejects.toBeInstanceOf(ApiTokenNotFoundError);
    const row = await adminDb.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    for (const key of PAGE_KEYS) expect(row.scopes).not.toContain(key);
  });

  it('refuses a dispatch-run token as not-found — it is the run’s, not the person’s', async () => {
    const fixture = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fixture.projectId, kind: 'task', title: 'a hosted card' },
      fixture.ctx,
    );
    const opened = await dispatchRunService.open(
      {
        projectKey: fixture.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        origin: 'hosted',
        cards: [{ key: item.identifier, disposition: 'queued' }],
      },
      fixture.ctx,
    );
    const minted = await runCredentialService.mintRunCredential({
      dispatchRunId: opened.run.id,
      dispatcherUserId: fixture.owner.id,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });

    await expect(
      apiTokensService.updatePermissions(fixture.owner.id, minted.tokenId, {
        permissions: ['project:browse'],
      }),
    ).rejects.toBeInstanceOf(ApiTokenNotFoundError);
  });

  it('refuses inside a staff "View as" session and writes nothing', async () => {
    const { owner, workspace, project } = await ownerWithProject();
    const { dto } = await mintBound(owner, workspace.id, project.id, withoutPages);
    staff.cookie = true;

    await expect(
      apiTokensService.updatePermissions(owner.id, dto.id, { permissions: PAGE_KEYS }),
    ).rejects.toBeInstanceOf(ImpersonationCredentialRefusedError);
    const row = await adminDb.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    for (const key of PAGE_KEYS) expect(row.scopes).not.toContain(key);
  });

  it('refuses a permission the owner cannot grant, naming it, and writes nothing', async () => {
    const { owner, workspace, project } = await ownerWithProject();
    const { dto } = await mintBound(owner, workspace.id, project.id, withoutPages);
    const notGrantable = PERMISSIONS.find((key) => !GRANTABLE_PERMISSIONS.includes(key))!;
    const before = await adminDb.apiToken.findUniqueOrThrow({ where: { id: dto.id } });

    const err = await apiTokensService
      .updatePermissions(owner.id, dto.id, { permissions: ['page:view', notGrantable] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidTokenGrantError);
    expect((err as InstanceType<typeof InvalidTokenGrantError>).invalidPermissions).toEqual([
      notGrantable,
    ]);
    const after = await adminDb.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    expect(after.scopes).toEqual(before.scopes);
  });

  it('validates against what the owner can grant TODAY, not at mint', async () => {
    const { owner, workspace, project } = await ownerWithProject();
    const { dto } = await mintBound(owner, workspace.id, project.id, withoutPages);
    // The owner's offer in the project shrinks after the token was minted.
    const spy = vi
      .spyOn(projectAccessService, 'getPermissions')
      .mockResolvedValueOnce(new Set<PermissionKey>(['project:browse', 'comment:add']) as never);

    await expect(
      apiTokensService.updatePermissions(owner.id, dto.id, {
        permissions: ['project:browse', 'page:view'],
      }),
    ).rejects.toBeInstanceOf(InvalidTokenGrantError);
    spy.mockRestore();
  });

  it('propagates a project the owner can no longer browse, and a workspace they left', async () => {
    const { owner, workspace, project } = await ownerWithProject();
    const { dto } = await mintBound(owner, workspace.id, project.id, withoutPages);

    const spy = vi
      .spyOn(projectAccessService, 'getPermissions')
      .mockRejectedValueOnce(new ProjectNotFoundError(project.id));
    await expect(
      apiTokensService.updatePermissions(owner.id, dto.id, { permissions: ['page:view'] }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    spy.mockRestore();

    const member = vi
      .spyOn(workspacesService, 'assertMembership')
      .mockRejectedValueOnce(new NotAMemberError(owner.id, workspace.id));
    await expect(
      apiTokensService.updatePermissions(owner.id, dto.id, { permissions: ['page:view'] }),
    ).rejects.toBeInstanceOf(NotAMemberError);
    member.mockRestore();
  });

  it('refuses a chosen grant on a device credential, and a fixed grant on a bound token', async () => {
    const { owner, workspace, project } = await ownerWithProject();
    const device = await apiTokensService.create(owner.id, workspace.id, {
      label: 'CLI · box',
      fixedGrant: CLI_TOKEN_GRANT,
    });
    const bound = await mintBound(owner, workspace.id, project.id, withoutPages);

    await expect(
      apiTokensService.updatePermissions(owner.id, device.dto.id, { permissions: ['page:view'] }),
    ).rejects.toBeInstanceOf(InvalidTokenBindingError);
    await expect(
      apiTokensService.updatePermissions(owner.id, bound.dto.id, { fixedGrant: CLI_TOKEN_GRANT }),
    ).rejects.toBeInstanceOf(InvalidTokenBindingError);
  });

  it('sets a device credential to a fixed grant without consulting any offer', async () => {
    const { owner, workspace } = await ownerWithProject();
    const previous = CLI_TOKEN_GRANT.filter((k) => !PAGE_KEYS.includes(k));
    const device = await apiTokensService.create(owner.id, workspace.id, {
      label: 'CLI · box',
      fixedGrant: previous,
    });

    const updated = await apiTokensService.updatePermissions(owner.id, device.dto.id, {
      fixedGrant: CLI_TOKEN_GRANT,
    });
    expect([...updated.permissions].sort()).toEqual([...CLI_TOKEN_GRANT].sort());
    expect(updated.project).toBeNull();
  });

  it('answers not-found when the token is revoked between the check and the write', async () => {
    const { owner, workspace, project } = await ownerWithProject();
    const { dto } = await mintBound(owner, workspace.id, project.id, withoutPages);
    // The revoke lands while the offer is being read.
    const spy = vi
      .spyOn(apiTokensService, 'listGrantablePermissions')
      .mockImplementationOnce(async () => {
        await apiTokensService.deleteToken(owner.id, dto.id);
        return [...GRANTABLE_PERMISSIONS];
      });
    await expect(
      apiTokensService.updatePermissions(owner.id, dto.id, { permissions: ['page:view'] }),
    ).rejects.toBeInstanceOf(ApiTokenNotFoundError);
    spy.mockRestore();
  });
});

describe('a client holding the token, over the real /api/mcp route', () => {
  it('is allowed a tool on its next call once the permission is ADDED', async () => {
    const { owner, workspace, project } = await ownerWithProject();
    const { token, dto } = await mintBound(owner, workspace.id, project.id, withoutPages);
    const client = await connect(token);

    const denied = await client.callTool({
      name: 'create_page',
      arguments: { projectKey: 'PROD', title: 'Agent notes', markdown: 'First.' },
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain(PERMISSION_NOT_GRANTED_CODE);

    await apiTokensService.updatePermissions(owner.id, dto.id, {
      permissions: [...withoutPages, ...PAGE_KEYS],
    });

    const allowed = await client.callTool({
      name: 'create_page',
      arguments: { projectKey: 'PROD', title: 'Agent notes', markdown: 'First.' },
    });
    expect(allowed.isError, textOf(allowed)).toBeFalsy();
    await client.close();
  });

  it('is refused a tool on its next call once the permission is REMOVED', async () => {
    const { owner, workspace, project } = await ownerWithProject();
    const { token, dto } = await mintBound(owner, workspace.id, project.id, [
      ...withoutPages,
      ...PAGE_KEYS,
    ]);
    const client = await connect(token);

    const allowed = await client.callTool({
      name: 'create_page',
      arguments: { projectKey: 'PROD', title: 'Agent notes', markdown: 'First.' },
    });
    expect(allowed.isError, textOf(allowed)).toBeFalsy();

    await apiTokensService.updatePermissions(owner.id, dto.id, {
      permissions: [...withoutPages, 'page:view'],
    });

    const denied = await client.callTool({
      name: 'create_page',
      arguments: { projectKey: 'PROD', title: 'More notes', markdown: 'Second.' },
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(textOf(denied)).toContain('page:edit');
    await client.close();
  });
});

describe('PATCH /api/me/api-tokens/[tokenId]', () => {
  it('401 when signed out', async () => {
    const { req, ctx } = patchReq('whatever', { permissions: [] });
    expect((await PATCH(req, ctx)).status).toBe(401);
  });

  it('200 with the updated token', async () => {
    const { owner, workspace, project } = await ownerWithProject();
    const { dto } = await mintBound(owner, workspace.id, project.id, withoutPages);
    session.current = { user: { id: owner.id, email: owner.email } };

    const { req, ctx } = patchReq(dto.id, { permissions: [...withoutPages, 'page:view'] });
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: { id: string; permissions: string[] } };
    expect(body.token.id).toBe(dto.id);
    expect(body.token.permissions).toContain('page:view');
    expect(JSON.stringify(body)).not.toMatch(/tokenHash|motir_pat_[A-Za-z0-9_-]{20,}/);
  });

  it('400 on a non-JSON body or a permissions list that is not strings', async () => {
    const { owner } = await ownerWithProject();
    session.current = { user: { id: owner.id, email: owner.email } };

    const raw = patchReq('t', null, '{not json');
    expect((await PATCH(raw.req, raw.ctx)).status).toBe(400);
    const missing = patchReq('t', {});
    expect((await PATCH(missing.req, missing.ctx)).status).toBe(400);
    const wrong = patchReq('t', { permissions: [1, 2] });
    expect((await PATCH(wrong.req, wrong.ctx)).status).toBe(400);
  });

  it("404 for another user's token, and for one bound where the owner can no longer reach", async () => {
    const alice = await ownerWithProject();
    const bob = await ownerWithProject();
    const { dto } = await mintBound(bob.owner, bob.workspace.id, bob.project.id, withoutPages);
    session.current = { user: { id: alice.owner.id, email: alice.owner.email } };

    const foreign = patchReq(dto.id, { permissions: ['page:view'] });
    const res = await PATCH(foreign.req, foreign.ctx);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('API_TOKEN_NOT_FOUND');

    session.current = { user: { id: bob.owner.id, email: bob.owner.email } };
    const spy = vi
      .spyOn(projectAccessService, 'getPermissions')
      .mockRejectedValueOnce(new ProjectNotFoundError(bob.project.id));
    const lost = patchReq(dto.id, { permissions: ['page:view'] });
    expect((await PATCH(lost.req, lost.ctx)).status).toBe(404);
    spy.mockRestore();
  });

  it('403 naming a permission the owner cannot grant', async () => {
    const { owner, workspace, project } = await ownerWithProject();
    const { dto } = await mintBound(owner, workspace.id, project.id, withoutPages);
    session.current = { user: { id: owner.id, email: owner.email } };
    const notGrantable = PERMISSIONS.find((key) => !GRANTABLE_PERMISSIONS.includes(key))!;

    const { req, ctx } = patchReq(dto.id, { permissions: ['page:view', notGrantable] });
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      code: 'API_TOKEN_INVALID_PERMISSION',
      permissions: [notGrantable],
    });
  });

  it('403 inside a staff session', async () => {
    const { owner, workspace, project } = await ownerWithProject();
    const { dto } = await mintBound(owner, workspace.id, project.id, withoutPages);
    session.current = { user: { id: owner.id, email: owner.email } };
    staff.cookie = true;

    const { req, ctx } = patchReq(dto.id, { permissions: ['page:view'] });
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('IMPERSONATION_CREDENTIAL_REFUSED');
  });

  it('422 for a CLI sign-in, whose grant only `motir auth refresh` updates', async () => {
    const { owner, workspace } = await ownerWithProject();
    const device = await apiTokensService.create(owner.id, workspace.id, {
      label: 'CLI · box',
      fixedGrant: CLI_TOKEN_GRANT,
    });
    session.current = { user: { id: owner.id, email: owner.email } };

    const { req, ctx } = patchReq(device.dto.id, { permissions: ['page:view'] });
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('API_TOKEN_INVALID_BINDING');
  });

  it('rethrows an unexpected failure rather than mapping it', async () => {
    const { owner } = await ownerWithProject();
    session.current = { user: { id: owner.id, email: owner.email } };
    const spy = vi
      .spyOn(apiTokensService, 'updatePermissions')
      .mockRejectedValueOnce(new Error('boom'));
    const { req, ctx } = patchReq('t', { permissions: ['page:view'] });
    await expect(PATCH(req, ctx)).rejects.toThrow('boom');
    spy.mockRestore();
  });
});

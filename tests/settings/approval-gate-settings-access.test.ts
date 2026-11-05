import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { approvalGateSettingsService } from '@/lib/services/approvalGateSettingsService';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// Task MOTIR-5394 — the Approvals room is MANAGE-ONLY: its READ and its WRITE both
// take `workflow:manage`, proven over the REAL stack.
//
// ⚠️ KEPT AND INVERTED, NOT DELETED. MOTIR-5278 added this file to prove that a
// member could READ the room its browse view had opened. That view is reverted
// (`design/projects/design-notes.md` § ⭐ Approvals §6, amended 2026-09-13 ·
// MOTIR-4880 re-plan). A mechanical revert would have deleted the file, and with it
// the only real-stack proof of who may read the gates and who may change them. So
// the same fixture now proves the opposite read.
//
// Three facts, each with its control:
//   1. a project MEMBER's READ is refused, as `PermissionDeniedError` naming
//      `workflow:manage` at the service and a `403` on GET. Their WRITE is refused
//      the same way at the service and on PATCH, and the stored value does not move;
//   2. CONTROL: a holder of `workflow:manage` (a project ADMIN) reads the STORED
//      value and writes it, so each refusal is about the key and not the fixture;
//   3. a NON-browser's read is still `ProjectNotFoundError` at the service, so the
//      404-vs-403 posture is unchanged. (The ROUTE's 404 for that actor is
//      MOTIR-5320's; see the note at the bottom of this file.)
//
// The session is the one thing stubbed: a route test has no cookie jar, so the
// compliance gate hands back the actor. Everything after it — `getByKey`, the
// service, the permission resolution, Postgres — is the shipped path.

const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));

const { GET, PATCH } = await import('@/app/api/projects/[key]/approval-gates/route');

const PASSWORD = 'approval-gate-access-pass-123';

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctxFor = (userId: string, workspaceId: string): WorkspaceContext => ({ userId, workspaceId });

interface Seeded {
  projectId: string;
  projectKey: string;
  admin: WorkspaceContext;
  member: WorkspaceContext;
  /** A workspace member with no role on a PRIVATE project — cannot browse it. */
  outsider: WorkspaceContext;
}

/**
 * A PRIVATE project, so the non-browser arm is a real one: the access level is
 * set before anyone else joins (going private seeds only the then-current
 * members), then a project admin, a project member and a workspace member with no
 * project role are added — the same order `settings-area-access-matrix` uses.
 */
async function seed(slug: string): Promise<Seeded> {
  const user = (email: string, name: string) =>
    usersService.createUser({ email, password: PASSWORD, name });

  const owner = await user(`owner-${slug}@ex.com`, 'Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${slug}`,
  });
  const ownerCtx = ctxFor(owner.id, workspace.id);
  await projectMembersService.setAccessMode({
    key: project.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    mode: 'members',
  });

  async function projectActor(role: 'admin' | 'member') {
    const u = await user(`${role}-${slug}@ex.com`, role);
    await workspacesService.addMember({ userId: u.id, workspaceId: workspace.id });
    await addToProjectAs({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: u.id,
      role,
    });
    return ctxFor(u.id, workspace.id);
  }

  const outsider = await user(`outsider-${slug}@ex.com`, 'Outsider');
  await workspacesService.addMember({ userId: outsider.id, workspaceId: workspace.id });

  return {
    projectId: project.id,
    projectKey: project.identifier,
    admin: await projectActor('admin'),
    member: await projectActor('member'),
    outsider: ctxFor(outsider.id, workspace.id),
  };
}

/** Put the stored switch in a known, NON-default state. */
async function storeAcceptanceVideo(projectId: string, value: boolean) {
  await adminDb.project.update({
    where: { id: projectId },
    data: { acceptanceVideoEnabled: value },
  });
}

async function storedAcceptanceVideo(projectId: string): Promise<boolean> {
  const row = await adminDb.project.findUniqueOrThrow({ where: { id: projectId } });
  return row.acceptanceVideoEnabled;
}

function actAs(ctx: WorkspaceContext) {
  requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx });
}

const params = (key: string) => ({ params: Promise.resolve({ key }) });
const patchBody = (body: unknown) =>
  new Request('https://app.motir.co/api/projects/X/approval-gates', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

describe('the READ takes `workflow:manage` — a member is refused it (MOTIR-5394)', () => {
  // ⚠️ RESTORED 2026-09-13 — the Approvals room is manage-only (MOTIR-4880 re-plan ·
  // MOTIR-5394); MOTIR-5278's browse view is reverted. MOTIR-5278 asserted here that
  // this member READ the stored value, at the service and with a 200 on GET.
  it('a project MEMBER’s read is REFUSED at the service, naming the key', async () => {
    const s = await seed('member-read-service');

    const attempt = approvalGateSettingsService.getSettings(s.projectId, s.member);
    await expect(attempt).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(attempt).rejects.toMatchObject({ permission: 'workflow:manage' });
  });

  it('…and is a 403 on `GET /api/projects/[key]/approval-gates`, carrying no value', async () => {
    const s = await seed('member-read-route');
    await storeAcceptanceVideo(s.projectId, false);

    actAs(s.member);
    const res = await GET(new Request('https://app.motir.co/x'), params(s.projectKey));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ permission: 'workflow:manage' });
    expect(body).not.toHaveProperty('acceptanceVideoEnabled');
  });

  it('CONTROL: an ADMIN reads the STORED value — at the service and through GET', async () => {
    const s = await seed('admin-read');
    // Off, because the column defaults on: a read that ignored the row would pass
    // a default-valued fixture.
    await storeAcceptanceVideo(s.projectId, false);

    await expect(approvalGateSettingsService.getSettings(s.projectId, s.admin)).resolves.toEqual({
      acceptanceVideoEnabled: false,
      reviewAgentEnabled: false,
      designApprovalGate: true,
      reviewAgentSource: 'hosted',
      reviewBotPostsEnabled: true,
    });

    actAs(s.admin);
    const res = await GET(new Request('https://app.motir.co/x'), params(s.projectKey));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      acceptanceVideoEnabled: false,
      reviewAgentEnabled: false,
      designApprovalGate: true,
      reviewAgentSource: 'hosted',
      reviewBotPostsEnabled: true,
    });
  });
});

describe('the WRITE keeps `workflow:manage` (MOTIR-5278, unchanged by MOTIR-5394)', () => {
  it('the same MEMBER’s write is REFUSED at the service, and the stored value does not move', async () => {
    const s = await seed('member-write-service');
    await storeAcceptanceVideo(s.projectId, false);

    const attempt = approvalGateSettingsService.updateSettings(
      s.projectId,
      { acceptanceVideoEnabled: true },
      s.member,
    );
    await expect(attempt).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(attempt).rejects.toMatchObject({ permission: 'workflow:manage' });
    expect(await storedAcceptanceVideo(s.projectId)).toBe(false);
  });

  it('…and is a 403 on `PATCH /api/projects/[key]/approval-gates`, naming the key', async () => {
    const s = await seed('member-write-route');
    await storeAcceptanceVideo(s.projectId, false);

    actAs(s.member);
    const res = await PATCH(patchBody({ acceptanceVideoEnabled: true }), params(s.projectKey));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ permission: 'workflow:manage' });
    expect(await storedAcceptanceVideo(s.projectId)).toBe(false);
  });

  it('CONTROL: an ADMIN’s identical PATCH goes through — the refusal is the key, not the fixture', async () => {
    const s = await seed('admin-write-route');
    await storeAcceptanceVideo(s.projectId, false);

    actAs(s.admin);
    const res = await PATCH(patchBody({ acceptanceVideoEnabled: true }), params(s.projectKey));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      acceptanceVideoEnabled: true,
      reviewAgentEnabled: false,
      designApprovalGate: true,
      reviewAgentSource: 'hosted',
      reviewBotPostsEnabled: true,
    });
    expect(await storedAcceptanceVideo(s.projectId)).toBe(true);
  });
});

describe('the DESIGN-APPROVAL switch takes the same key (MOTIR-697)', () => {
  async function storedDesignApproval(projectId: string): Promise<boolean> {
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: projectId } });
    return row.designApprovalGate;
  }

  it('a project MEMBER’s PATCH is a 403 naming `workflow:manage`, and the switch does not move', async () => {
    const s = await seed('member-design-switch');

    actAs(s.member);
    const res = await PATCH(patchBody({ designApprovalGate: false }), params(s.projectKey));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ permission: 'workflow:manage' });
    expect(await storedDesignApproval(s.projectId)).toBe(true);
  });

  it('CONTROL: an ADMIN turns it off, and ONLY that key is written', async () => {
    const s = await seed('admin-design-switch');
    await storeAcceptanceVideo(s.projectId, false);

    actAs(s.admin);
    const res = await PATCH(patchBody({ designApprovalGate: false }), params(s.projectKey));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      acceptanceVideoEnabled: false,
      reviewAgentEnabled: false,
      designApprovalGate: false,
      reviewAgentSource: 'hosted',
      reviewBotPostsEnabled: true,
    });
    expect(await storedDesignApproval(s.projectId)).toBe(false);
    expect(await storedAcceptanceVideo(s.projectId)).toBe(false);
  });

  it('a non-boolean value is a 400 and writes nothing', async () => {
    const s = await seed('bad-design-switch');

    actAs(s.admin);
    const res = await PATCH(patchBody({ designApprovalGate: 'off' }), params(s.projectKey));
    expect(res.status).toBe(400);
    expect(await storedDesignApproval(s.projectId)).toBe(true);
  });
});

describe('a NON-browser still cannot learn the room exists — the 404-vs-403 posture (MOTIR-5278)', () => {
  it('reads as ProjectNotFoundError at the service, not PermissionDeniedError', async () => {
    const s = await seed('outsider-service');
    await expect(
      approvalGateSettingsService.getSettings(s.projectId, s.outsider),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  // MOTIR-5320 — the route-level case this file could not carry when it was
  // written: `projectsService.getByKey` used to refuse this actor with
  // `ProjectAccessDeniedError`, which this route does not map, so the GET was a
  // 500. The lookup now refuses with the not-found error its own doc promised.
  // Every other key-addressed route is covered the same way in
  // `tests/projects/key-lookup-browse-denial.test.ts`.
  it('…and is a 404 on `GET /api/projects/[key]/approval-gates`, not a 500 (MOTIR-5320)', async () => {
    const s = await seed('outsider-route');
    actAs(s.outsider);
    const res = await GET(new Request('https://app.motir.co/x'), params(s.projectKey));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('PROJECT_NOT_FOUND');
  });
});

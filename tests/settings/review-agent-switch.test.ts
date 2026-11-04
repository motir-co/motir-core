import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { approvalGateSettingsService } from '@/lib/services/approvalGateSettingsService';
import { projectPrMergeModeService } from '@/lib/services/projectPrMergeModeService';
import {
  MergeModeReviewAgentOnError,
  PermissionDeniedError,
  ReviewAgentNeedsManualMergeError,
} from '@/lib/projects/errors';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// THE REVIEW AGENT'S SWITCH (Story MOTIR-1626 · MOTIR-6818; ADR
// `docs/decisions/approval-gates.md` §12 and §12.2a), over the REAL stack: the
// service, both routes and Postgres. The session is the one thing stubbed — a route
// test has no cookie jar, so the compliance gate hands back the actor.
//
// What it proves:
//   1. every project reads `reviewAgentEnabled: false` until someone turns it on;
//   2. a PATCH naming only the review agent writes only the review agent — the
//      acceptance-video switch beside it does not move;
//   3. a member without `workflow:manage` is refused exactly as the acceptance-video
//      switch refuses them (a 403 naming the key), and nothing moves;
//   4. the review agent and AUTO merging EXCLUDE each other (§12.2a, the requester's
//      2026-09-29 decision), refused from BOTH writes with a typed 409, and neither
//      write changes the other setting on the person's behalf.

const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));

const gatesRoute = await import('@/app/api/projects/[key]/approval-gates/route');
const mergeModeRoute = await import('@/app/api/projects/[key]/pr-merge-mode/route');

const PASSWORD = 'review-agent-switch-pass-123';

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctxFor = (userId: string, workspaceId: string): WorkspaceContext => ({ userId, workspaceId });

async function seed(slug: string) {
  const user = (email: string, name: string) =>
    usersService.createUser({ email, password: PASSWORD, name });

  const owner = await user(`owner-${slug}@ex.com`, 'Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const ownerCtx = ctxFor(owner.id, workspace.id);
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${slug}`,
  });

  const memberUser = await user(`member-${slug}@ex.com`, 'Member');
  await workspacesService.addMember({ userId: memberUser.id, workspaceId: workspace.id });
  await addToProjectAs({
    key: project.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    targetUserId: memberUser.id,
    role: 'member',
  });

  return { owner: ownerCtx, member: ctxFor(memberUser.id, workspace.id), project };
}

async function stored(projectId: string) {
  const row = await adminDb.project.findUniqueOrThrow({ where: { id: projectId } });
  return {
    reviewAgentEnabled: row.reviewAgentEnabled,
    acceptanceVideoEnabled: row.acceptanceVideoEnabled,
    prMergeMode: row.prMergeMode,
  };
}

async function store(
  projectId: string,
  data: {
    reviewAgentEnabled?: boolean;
    acceptanceVideoEnabled?: boolean;
    prMergeMode?: 'auto' | 'manual';
  },
) {
  await adminDb.project.update({ where: { id: projectId }, data });
}

function actAs(ctx: WorkspaceContext) {
  requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx });
}

const params = (key: string) => ({ params: Promise.resolve({ key }) });
const patch = (path: string, body: unknown) =>
  new Request(`https://app.motir.co/api/projects/X/${path}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

describe('the review agent switch — read and write (MOTIR-6818)', () => {
  it('an existing project reads `reviewAgentEnabled: false`, at the service and through GET', async () => {
    const s = await seed('read-default');

    await expect(
      approvalGateSettingsService.getSettings(s.project.id, s.owner),
    ).resolves.toMatchObject({ reviewAgentEnabled: false });

    actAs(s.owner);
    const res = await gatesRoute.GET(
      new Request('https://app.motir.co/x'),
      params(s.project.identifier),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reviewAgentEnabled: false });
  });

  it('a PATCH carrying ONLY `reviewAgentEnabled: true` persists it and leaves acceptance video alone', async () => {
    const s = await seed('subset-write');
    // Off, because the acceptance-video column defaults ON: a write that rewrote it
    // from a default would pass a default-valued fixture.
    await store(s.project.id, { acceptanceVideoEnabled: false });

    actAs(s.owner);
    const res = await gatesRoute.PATCH(
      patch('approval-gates', { reviewAgentEnabled: true }),
      params(s.project.identifier),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      acceptanceVideoEnabled: false,
      reviewAgentEnabled: true,
      designApprovalGate: true,
      reviewAgentSource: 'hosted',
      reviewBotPostsEnabled: true,
    });
    expect(await stored(s.project.id)).toMatchObject({
      reviewAgentEnabled: true,
      acceptanceVideoEnabled: false,
    });
  });

  it('…and the reverse subset: an acceptance-video PATCH leaves the review agent alone', async () => {
    const s = await seed('subset-reverse');
    await store(s.project.id, { reviewAgentEnabled: true });

    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { acceptanceVideoEnabled: false },
      s.owner,
    );

    expect(await stored(s.project.id)).toMatchObject({
      reviewAgentEnabled: true,
      acceptanceVideoEnabled: false,
    });
  });

  it('both switches in ONE PATCH are both written', async () => {
    const s = await seed('both');

    actAs(s.owner);
    const res = await gatesRoute.PATCH(
      patch('approval-gates', { reviewAgentEnabled: true, acceptanceVideoEnabled: false }),
      params(s.project.identifier),
    );

    expect(res.status).toBe(200);
    expect(await stored(s.project.id)).toMatchObject({
      reviewAgentEnabled: true,
      acceptanceVideoEnabled: false,
    });
  });

  it('a non-boolean `reviewAgentEnabled` is a 400 naming the field, and nothing moves', async () => {
    const s = await seed('bad-shape');

    actAs(s.owner);
    const res = await gatesRoute.PATCH(
      patch('approval-gates', { reviewAgentEnabled: 'yes' }),
      params(s.project.identifier),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('reviewAgentEnabled');
    expect((await stored(s.project.id)).reviewAgentEnabled).toBe(false);
  });

  it('a MEMBER without `workflow:manage` is refused as the acceptance-video switch refuses them', async () => {
    const s = await seed('member');

    const attempt = approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentEnabled: true },
      s.member,
    );
    await expect(attempt).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(attempt).rejects.toMatchObject({ permission: 'workflow:manage' });

    actAs(s.member);
    const res = await gatesRoute.PATCH(
      patch('approval-gates', { reviewAgentEnabled: true }),
      params(s.project.identifier),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'PERMISSION_DENIED',
      permission: 'workflow:manage',
    });
    expect((await stored(s.project.id)).reviewAgentEnabled).toBe(false);
  });
});

describe('the review agent and AUTO merging exclude each other (ADR §12.2a)', () => {
  it('turning the review agent ON in an `auto` project is a 409, and neither setting moves', async () => {
    const s = await seed('on-in-auto');
    await store(s.project.id, { prMergeMode: 'auto' });

    await expect(
      approvalGateSettingsService.updateSettings(
        s.project.id,
        { reviewAgentEnabled: true },
        s.owner,
      ),
    ).rejects.toBeInstanceOf(ReviewAgentNeedsManualMergeError);

    actAs(s.owner);
    const res = await gatesRoute.PATCH(
      patch('approval-gates', { reviewAgentEnabled: true }),
      params(s.project.identifier),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('REVIEW_AGENT_NEEDS_MANUAL_MERGE');
    expect(await stored(s.project.id)).toMatchObject({
      reviewAgentEnabled: false,
      prMergeMode: 'auto',
    });
  });

  it('CONTROL: turning it OFF in an `auto` project is allowed — only ON is excluded', async () => {
    const s = await seed('off-in-auto');
    // A pair a person can no longer write, but one written before §12.2a could exist;
    // turning the review agent off is how anyone leaves it.
    await store(s.project.id, { prMergeMode: 'auto', reviewAgentEnabled: true });

    await expect(
      approvalGateSettingsService.updateSettings(
        s.project.id,
        { reviewAgentEnabled: false },
        s.owner,
      ),
    ).resolves.toMatchObject({ reviewAgentEnabled: false });
  });

  it('choosing `auto` while the review agent is ON is a 409, and neither setting moves', async () => {
    const s = await seed('auto-while-on');
    await store(s.project.id, { reviewAgentEnabled: true });

    await expect(
      projectPrMergeModeService.setPrMergeMode(s.project.id, 'auto', s.owner),
    ).rejects.toBeInstanceOf(MergeModeReviewAgentOnError);

    actAs(s.owner);
    const res = await mergeModeRoute.PATCH(
      patch('pr-merge-mode', { prMergeMode: 'auto' }),
      params(s.project.identifier),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('MERGE_MODE_REVIEW_AGENT_ON');
    expect(await stored(s.project.id)).toMatchObject({
      reviewAgentEnabled: true,
      prMergeMode: 'manual',
    });
  });

  it('CONTROL: `manual` is always allowed with the review agent on, and `auto` once it is off', async () => {
    const s = await seed('manual-control');
    await store(s.project.id, { reviewAgentEnabled: true });

    await expect(
      projectPrMergeModeService.setPrMergeMode(s.project.id, 'manual', s.owner),
    ).resolves.toEqual({ prMergeMode: 'manual' });

    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentEnabled: false },
      s.owner,
    );
    await expect(
      projectPrMergeModeService.setPrMergeMode(s.project.id, 'auto', s.owner),
    ).resolves.toEqual({ prMergeMode: 'auto' });
  });
});

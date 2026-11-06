import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { CreatePlannerFindingRequest, RawPlannerFinding } from '@/lib/ai/motirAiClient';
import {
  MotirAiBadRequestError,
  MotirAiConfigError,
  MotirAiUnauthorizedError,
  MotirAiUnavailableError,
} from '@/lib/ai/errors';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestProject } from '../../fixtures/projectFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

// `plannerFindingsService.recordFinding` over REAL Postgres (Story MOTIR-10354 ·
// Subtask MOTIR-10390). The project lookup (`projectsService.getByKey`), the
// gate (`projectAccessService.assertPermission`) and the tenant-org read
// (`resolveTenantOrg`, two RLS-scoped reads) all run for real. ONE thing is
// mocked: `createPlannerFinding`, the wire seam, whose own test is
// `tests/ai/plannerFindingSeam.test.ts`.
//
// What a collaborator-mocked unit test cannot show, and this file is for:
//
// ⚠️ THE ACTOR'S VIEW DIFFERS FROM THE POPULATION. A project owner holds every
// role-gated key, so an owner-only test passes whether the gate asks `ai:plan`
// or a lesson key. The Member is the actor that tells them apart: it holds
// `ai:plan` and neither lesson key, asserted from `getPermissions` first.
//
// ⚠️ THE IDENTITY IS THE DATABASE'S, NOT THE CODE'S. The organisation id the
// relay must carry is read from the workspace row through the owner client, never
// through `resolveTenantOrg`, so the assertion is not the code agreeing with
// itself. Two workspaces hold the same project identifier, so a lookup that
// resolved globally would hand back the other tenant's project id.
//
// ⚠️ REFUSALS ARE ASSERTED AS CALL COUNTS. A gate that fetched first and refused
// afterwards would reject identically; only a count of 0 shows nothing reached
// motir-ai.

const createPlannerFinding =
  vi.fn<(req: CreatePlannerFindingRequest) => Promise<RawPlannerFinding>>();

vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/motirAiClient')>();
  return {
    ...actual,
    createPlannerFinding: (req: CreatePlannerFindingRequest) => createPlannerFinding(req),
  };
});

const { plannerFindingsService, PLANNER_FINDING_NO_PLAN_ID } =
  await import('@/lib/services/plannerFindingsService');
type RecordInput = Parameters<typeof plannerFindingsService.recordFinding>[2];

const PASSWORD = 'hunter2hunter2';

const VALID: RecordInput = {
  planner: 'plan_py',
  site: 'MOTIR-12 acceptance criterion 3',
  prediction: 'STOPS',
  whatHappened: 'The runner would stop: the criterion reads the deployment.',
  evidence: 'lib/runner/rules.ts:42 at 4af7d93',
  outcome: 'reported',
};

const STORED: RawPlannerFinding = {
  id: 'pf_1',
  source: 'check_plan',
  planner: 'plan_py',
  site: VALID.site,
  fingerprint: 'f'.repeat(64),
  status: 'new',
};

const FORBIDDEN_REQUEST_KEYS = [
  'status',
  'fingerprint',
  'jobId',
  'lessonId',
  'bugKey',
  'aiProjectId',
] as const;

let seq = 0;

async function actorWithRole(
  fx: WorkItemFixture,
  role: 'member' | 'viewer',
  projectKeys: string[] = [fx.projectIdentifier],
): Promise<ServiceContext> {
  seq += 1;
  const u = await usersService.createUser({
    email: `pf-${role}-${seq}-${Math.round(Math.random() * 1e6)}@example.com`,
    password: PASSWORD,
    name: role,
  });
  await workspacesService.addMember({ userId: u.id, workspaceId: fx.workspaceId });
  for (const key of projectKeys) {
    await addToProjectAs({
      key,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: u.id,
      role,
    });
  }
  return { userId: u.id, workspaceId: fx.workspaceId };
}

async function orgIdOf(workspaceId: string): Promise<string> {
  const ws = await adminDb.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  return ws.organizationId;
}

async function projectIdOf(workspaceId: string, identifier: string): Promise<string> {
  const p = await adminDb.project.findFirstOrThrow({
    where: { workspaceId, identifier },
    select: { id: true },
  });
  return p.id;
}

/** The request handed to the mocked seam on its `n`th call (0-based). */
function sent(n = 0): CreatePlannerFindingRequest {
  const call = createPlannerFinding.mock.calls[n];
  if (!call) throw new Error(`createPlannerFinding has no call #${n}`);
  return call[0];
}

beforeEach(async () => {
  await truncateAuthTables();
  createPlannerFinding.mockReset();
  createPlannerFinding.mockResolvedValue(STORED);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('recordFinding — the gate is ai:plan, over real roles', () => {
  it('admits a plain Member, who holds ai:plan and neither lesson key', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ALPHA' });
    const member = await actorWithRole(fx, 'member');

    const held = await projectAccessService.getPermissions(fx.projectId, member);
    expect(held.has('ai:plan')).toBe(true);
    expect(held.has('lesson:manage')).toBe(false);
    expect(held.has('lesson:reinforce')).toBe(false);

    const result = await plannerFindingsService.recordFinding('ALPHA', member, VALID);

    expect(result).toEqual({
      id: STORED.id,
      source: STORED.source,
      fingerprint: STORED.fingerprint,
      status: STORED.status,
    });
    expect(createPlannerFinding).toHaveBeenCalledTimes(1);
  });

  it('admits the Manager (the project owner)', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ALPHA' });

    await expect(
      plannerFindingsService.recordFinding('ALPHA', fx.ctx, VALID),
    ).resolves.toMatchObject({ id: STORED.id });
    expect(createPlannerFinding).toHaveBeenCalledTimes(1);
  });

  it('refuses a Viewer who can browse the project, and sends nothing', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ALPHA' });
    const viewer = await actorWithRole(fx, 'viewer');

    const held = await projectAccessService.getPermissions(fx.projectId, viewer);
    expect(held.has('project:browse')).toBe(true);
    expect(held.has('ai:plan')).toBe(false);

    await expect(
      plannerFindingsService.recordFinding('ALPHA', viewer, VALID),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(createPlannerFinding).toHaveBeenCalledTimes(0);
  });
});

describe('recordFinding — project resolution is the caller’s own workspace', () => {
  it('reads a cross-tenant key and a never-created key as the same not-found, sending nothing', async () => {
    const home = await makeWorkItemFixture({ name: 'Home', identifier: 'ALPHA' });
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHER' });

    const crossTenant = await plannerFindingsService
      .recordFinding('alpha', other.ctx, VALID)
      .catch((e: unknown) => e);
    const neverCreated = await plannerFindingsService
      .recordFinding('nope', home.ctx, VALID)
      .catch((e: unknown) => e);

    expect(crossTenant).toBeInstanceOf(ProjectNotFoundError);
    expect(neverCreated).toBeInstanceOf(ProjectNotFoundError);
    expect((crossTenant as Error).constructor).toBe((neverCreated as Error).constructor);
    expect((crossTenant as Error).message.toLowerCase()).toContain('alpha');
    expect((neverCreated as Error).message.toLowerCase()).toContain('nope');
    expect(createPlannerFinding).toHaveBeenCalledTimes(0);
  });

  it('with one identifier in two workspaces, each owner relays its OWN project and workspace', async () => {
    const a = await makeWorkItemFixture({ name: 'Tenant A' });
    const b = await makeWorkItemFixture({ name: 'Tenant B' });
    expect(a.projectIdentifier).toBe(b.projectIdentifier);
    const key = a.projectIdentifier;
    const aProjectId = await projectIdOf(a.workspaceId, key);
    const bProjectId = await projectIdOf(b.workspaceId, key);
    expect(aProjectId).not.toBe(bProjectId);

    await plannerFindingsService.recordFinding(key, a.ctx, VALID);
    await plannerFindingsService.recordFinding(key, b.ctx, VALID);

    expect(createPlannerFinding).toHaveBeenCalledTimes(2);
    expect(sent(0)).toMatchObject({ coreProjectId: aProjectId, coreWorkspaceId: a.workspaceId });
    expect(sent(1)).toMatchObject({ coreProjectId: bProjectId, coreWorkspaceId: b.workspaceId });
    expect(sent(0).coreOrganizationId).toBe(await orgIdOf(a.workspaceId));
    expect(sent(1).coreOrganizationId).toBe(await orgIdOf(b.workspaceId));
  });

  it('with two projects in one workspace, relays the project the key names, with the db’s ids', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ALPHA' });
    await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Bravo',
      identifier: 'BRAVO',
    });
    const member = await actorWithRole(fx, 'member', ['ALPHA', 'BRAVO']);
    const alphaId = await projectIdOf(fx.workspaceId, 'ALPHA');
    const bravoId = await projectIdOf(fx.workspaceId, 'BRAVO');
    const orgId = await orgIdOf(fx.workspaceId);

    await plannerFindingsService.recordFinding('BRAVO', member, VALID);
    await plannerFindingsService.recordFinding('ALPHA', member, VALID);

    expect(sent(0)).toMatchObject({
      coreProjectId: bravoId,
      coreWorkspaceId: fx.workspaceId,
      coreOrganizationId: orgId,
    });
    expect(sent(1)).toMatchObject({
      coreProjectId: alphaId,
      coreWorkspaceId: fx.workspaceId,
      coreOrganizationId: orgId,
    });
  });

  it('resolves a lower-case, whitespace-padded key to the canonical project', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ALPHA' });

    await plannerFindingsService.recordFinding('  alpha  ', fx.ctx, VALID);

    expect(createPlannerFinding).toHaveBeenCalledTimes(1);
    expect(sent().coreProjectId).toBe(await projectIdOf(fx.workspaceId, 'ALPHA'));
  });
});

describe('recordFinding — the request shape', () => {
  it('forwards no identity, source or status a hostile caller casts onto the input', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ALPHA' });
    const hostile = {
      ...VALID,
      coreProjectId: 'pj_forged',
      coreWorkspaceId: 'ws_forged',
      coreOrganizationId: 'org_forged',
      source: 'in_loop',
      status: 'triaged',
      fingerprint: 'forged',
      jobId: 'forged',
      lessonId: 'forged',
      bugKey: 'MOTIR-1',
      aiProjectId: 'forged',
    } as unknown as RecordInput;

    await plannerFindingsService.recordFinding('ALPHA', fx.ctx, hostile);

    const req = sent();
    expect(req.coreProjectId).toBe(fx.projectId);
    expect(req.coreWorkspaceId).toBe(fx.workspaceId);
    expect(req.coreOrganizationId).toBe(await orgIdOf(fx.workspaceId));
    expect(req.source).toBe('check_plan');
    for (const key of FORBIDDEN_REQUEST_KEYS) {
      expect(req).not.toHaveProperty(key);
    }
  });

  it('sends the no-plan marker for an omitted or blank planId, and a foreign id verbatim', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ALPHA' });

    await plannerFindingsService.recordFinding('ALPHA', fx.ctx, VALID);
    await plannerFindingsService.recordFinding('ALPHA', fx.ctx, { ...VALID, planId: '   ' });
    await plannerFindingsService.recordFinding('ALPHA', fx.ctx, {
      ...VALID,
      planId: 'plan_never_existed_in_core',
    });

    expect(createPlannerFinding).toHaveBeenCalledTimes(3);
    expect(sent(0).planId).toBe(PLANNER_FINDING_NO_PLAN_ID);
    expect(sent(1).planId).toBe(PLANNER_FINDING_NO_PLAN_ID);
    expect(sent(2).planId).toBe('plan_never_existed_in_core');
  });

  it('splits the baseline into its two wire fields, and drops blank optionals as absent keys', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ALPHA' });
    const blank = '   ';

    await plannerFindingsService.recordFinding('ALPHA', fx.ctx, {
      ...VALID,
      baseline: { branch: 'main', commit: '4af7d93' },
    });
    await plannerFindingsService.recordFinding('ALPHA', fx.ctx, {
      ...VALID,
      baseline: { commit: '4af7d93' },
    });
    await plannerFindingsService.recordFinding('ALPHA', fx.ctx, VALID);
    await plannerFindingsService.recordFinding('ALPHA', fx.ctx, {
      ...VALID,
      planTitle: blank,
      cardRef: blank,
      authorModel: blank,
      authorSessionKey: blank,
      correction: blank,
      why: blank,
      hostedCell: blank,
      planpyCell: blank,
      fixDirection: blank,
      rule: blank,
      baseline: { branch: blank, commit: blank },
    });

    expect(sent(0)).toMatchObject({ baselineBranch: 'main', baselineCommit: '4af7d93' });
    expect(sent(1).baselineCommit).toBe('4af7d93');
    expect(sent(1)).not.toHaveProperty('baselineBranch');
    expect(sent(2)).not.toHaveProperty('baselineBranch');
    expect(sent(2)).not.toHaveProperty('baselineCommit');
    for (let n = 0; n < 4; n += 1) expect(sent(n)).not.toHaveProperty('baseline');

    const blanks = sent(3);
    for (const key of [
      'planTitle',
      'cardRef',
      'authorModel',
      'authorSessionKey',
      'correction',
      'why',
      'hostedCell',
      'planpyCell',
      'fixDirection',
      'rule',
      'baselineBranch',
      'baselineCommit',
    ]) {
      expect(blanks).not.toHaveProperty(key);
    }
    expect(Object.values(blanks)).not.toContain('');
    expect(Object.values(blanks)).not.toContain(null);
  });
});

describe('recordFinding — upstream failures propagate once, never retried', () => {
  it.each([
    ['MotirAiBadRequestError', () => new MotirAiBadRequestError("'site' must not be blank", 400)],
    ['MotirAiUnavailableError', () => new MotirAiUnavailableError('store is restarting')],
    ['MotirAiUnauthorizedError', () => new MotirAiUnauthorizedError('service token rejected')],
    ['MotirAiConfigError', () => new MotirAiConfigError('MOTIR_AI_URL is not set')],
  ])('rejects with the same %s instance after ONE call', async (_name, make) => {
    const fx = await makeWorkItemFixture({ identifier: 'ALPHA' });
    const member = await actorWithRole(fx, 'member');
    const err = make();
    createPlannerFinding.mockRejectedValue(err);

    const outcome = await plannerFindingsService.recordFinding('ALPHA', member, VALID).then(
      (value) => ({ value }),
      (e: unknown) => ({ error: e }),
    );

    expect(outcome).toEqual({ error: err });
    expect((outcome as { error: unknown }).error).toBe(err);
    expect(createPlannerFinding).toHaveBeenCalledTimes(1);
  });
});

describe('recordFinding — nothing reaches motir-ai on a refusal', () => {
  it('makes no call across the Viewer, cross-tenant and unknown-key refusals together', async () => {
    const home = await makeWorkItemFixture({ name: 'Home', identifier: 'ALPHA' });
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHER' });
    const viewer = await actorWithRole(home, 'viewer');

    const refusals = await Promise.allSettled([
      plannerFindingsService.recordFinding('ALPHA', viewer, VALID),
      plannerFindingsService.recordFinding('ALPHA', other.ctx, VALID),
      plannerFindingsService.recordFinding('NEVER', home.ctx, VALID),
    ]);

    expect(refusals.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(createPlannerFinding.mock.calls).toEqual([]);
  });
});

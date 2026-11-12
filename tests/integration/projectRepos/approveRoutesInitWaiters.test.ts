import { type GithubRepo } from '@/generated/prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectRepoInitRoutingService } from '@/lib/services/projectRepoInitRoutingService';
import { projectRepoInitApproveRoutingService } from '@/lib/services/projectRepoInitApproveRoutingService';
import { projectRepoProposalService } from '@/lib/services/projectRepoProposalService';
import type { ProposalInput } from '@/lib/dto/plans';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { createTestLink, createTestWorkItem } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { randomToken } from '../../helpers/random';
import { organizationIdOf } from '../../helpers/organizationOf';

// Story MOTIR-10162 · Subtask MOTIR-11058 — approving a plan routes the cards waiting
// on its init cards to a repository that was settled BEFORE they existed: a person
// read the plan, created the declared repository, added it to the project, and only
// then approved.
//
// Real Postgres, driven through the shipped approve door. The only substitution is a
// spy on the in-process routing service object, restored per test, in the cases that
// assert the call set and the failure disposition. The pass's own rules are its
// suite's, not this one's.

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** One connected repository mirror in the fixture's organisation. */
async function connectRepo(fx: WorkItemFixture, name: string): Promise<GithubRepo> {
  const installationId = `inst-${fx.workspaceId}-github`;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId: fx.workspaceId,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  return adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: await organizationIdOf(fx.workspaceId),
      repoId: `${name}-${randomToken(8)}`,
      owner: 'acme',
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
}

/** A SETTLED row for `name` — added, then established against a real mirror. */
async function settledRow(fx: WorkItemFixture, name: string): Promise<string> {
  const row = await projectRepoSetService.addRow(fx.projectId, { role: 'infra', name }, fx.ctx);
  const repo = await connectRepo(fx, name);
  await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);
  return row.id;
}

/** A row that is still `proposed` — in the set, carrying no repository yet. */
async function proposedRow(fx: WorkItemFixture, name: string): Promise<string> {
  return (await projectRepoSetService.addRow(fx.projectId, { role: 'other', name }, fx.ctx)).id;
}

/**
 * A planned plan laying, for each declared name, an init card and one waiter blocked
 * by it; `plain` adds one ordinary card. Two append calls, because a temp-ref must
 * name a proposal appended in an earlier call.
 */
async function plannedPlan(
  fx: WorkItemFixture,
  declares: string[],
  plain: string[] = [],
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Build it' }, fx.ctx);
  const inits: ProposalInput[] = declares.map((name) => ({
    op: 'add',
    proposedFields: {
      title: `Create ${name}`,
      kind: 'task',
      subject: 'init',
      initRepositoryName: name,
    },
  }));
  const first = await plansService.addProposals(
    plan.id,
    [
      ...inits,
      ...plain.map(
        (title): ProposalInput => ({ op: 'add', proposedFields: { title, kind: 'task' } }),
      ),
    ],
    fx.ctx,
  );
  if (declares.length > 0) {
    await plansService.addProposals(
      plan.id,
      declares.map((name, i) => ({
        op: 'add',
        proposedFields: { title: `Use ${name}`, kind: 'task' },
        blockedByRefs: [`${TEMP_REF_PREFIX}${first.items[i]!.id}`],
      })),
      fx.ctx,
    );
  }
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

/** The materialized work item a plan's `add` titled `title` became. */
async function itemTitled(planId: string, title: string) {
  const items = await adminDb.planItem.findMany({ where: { planId, op: 'add' } });
  const hit = items.find((i) => (i.proposedFields as { title?: string } | null)?.title === title);
  return adminDb.workItem.findUniqueOrThrow({ where: { id: hit!.workItemId! } });
}

async function snapshot(id: string) {
  const item = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  const refs = await adminDb.workItemRepo.findMany({
    where: { workItemId: id },
    orderBy: { position: 'asc' },
  });
  const edges = await adminDb.workItemLink.findMany({ where: { fromId: id } });
  return {
    targetRepo: item.targetRepo,
    targetRepos: item.targetRepos,
    refs: refs.map((r) => ({ id: r.id, projectRepoId: r.projectRepoId, position: r.position })),
    edges: edges.map((e) => ({ id: e.id, toId: e.toId, kind: e.kind })),
  };
}

/** An init card and its waiter laid OUTSIDE any plan, after `name` settled. */
async function strayWaiter(fx: WorkItemFixture, name: string) {
  const init = await createTestWorkItem(fx, { kind: 'task', title: `Create ${name}` });
  await adminDb.workItem.update({
    where: { id: init.id },
    data: { subject: 'init', initRepositoryName: name },
  });
  const waiter = await createTestWorkItem(fx, { kind: 'task', title: `Use ${name}` });
  await createTestLink({
    workspaceId: fx.workspaceId,
    fromId: waiter.id,
    toId: init.id,
    kind: 'is_blocked_by',
    createdById: fx.ownerId,
  });
  return { init, waiter };
}

describe('an approve that created an init card', () => {
  it('routes the waiter to the row that already existed, keeping its edge to the init card', async () => {
    const fx = await makeWorkItemFixture();
    const rowId = await settledRow(fx, 'acme-infra');
    const planId = await plannedPlan(fx, ['acme-infra']);

    await plansService.approvePlan(planId, fx.ctx);

    const init = await itemTitled(planId, 'Create acme-infra');
    const waiter = await snapshot((await itemTitled(planId, 'Use acme-infra')).id);
    expect(waiter.refs.map((r) => [r.projectRepoId, r.position])).toEqual([[rowId, 0]]);
    expect(waiter.targetRepo).toBe('acme-infra');
    expect(waiter.targetRepos).toEqual(['acme-infra']);
    expect(waiter.edges).toEqual([
      expect.objectContaining({ toId: init.id, kind: 'is_blocked_by' }),
    ]);
    expect((await snapshot(init.id)).refs).toEqual([]);
  });

  it('hands EVERY row to the pass, which routes the settled one and declines the proposed one', async () => {
    const fx = await makeWorkItemFixture();
    const settled = await settledRow(fx, 'acme-infra');
    const proposed = await proposedRow(fx, 'acme-data');
    const planId = await plannedPlan(fx, ['acme-infra', 'acme-data']);
    const route = vi.spyOn(projectRepoInitRoutingService, 'routeInitCardDependents');

    await plansService.approvePlan(planId, fx.ctx);

    expect(route.mock.calls.map((c) => c[0]).sort()).toEqual([settled, proposed].sort());
    const infra = await snapshot((await itemTitled(planId, 'Use acme-infra')).id);
    expect(infra.refs.map((r) => r.projectRepoId)).toEqual([settled]);
    const data = await snapshot((await itemTitled(planId, 'Use acme-data')).id);
    expect(data.refs).toEqual([]);
  });

  it('runs after the propose, which still runs in prepareApprove and leaves an existing set alone', async () => {
    const fx = await makeWorkItemFixture();
    const settled = await settledRow(fx, 'acme-infra');
    const planId = await plannedPlan(fx, ['acme-infra']);
    // Pass-through spies: they record the order and change nothing.
    const propose = vi.spyOn(projectRepoProposalService, 'proposeRepositorySet');
    const route = vi.spyOn(projectRepoInitApproveRoutingService, 'routeAfterApprove');

    const answer = await plansService.approvePlan(planId, fx.ctx);

    expect(propose).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledTimes(1);
    expect(propose.mock.invocationCallOrder[0]!).toBeLessThan(route.mock.invocationCallOrder[0]!);
    expect(answer.status).toBe('approved');
    // The propose left the established set alone, exactly as before.
    expect(
      (await adminDb.projectRepo.findMany({ where: { projectId: fx.projectId } })).map((r) => r.id),
    ).toEqual([settled]);
  });

  it('is idempotent from the card: handing the same row to the pass again appends nothing', async () => {
    const fx = await makeWorkItemFixture();
    const rowId = await settledRow(fx, 'acme-infra');
    const planId = await plannedPlan(fx, ['acme-infra']);
    await plansService.approvePlan(planId, fx.ctx);
    const waiterId = (await itemTitled(planId, 'Use acme-infra')).id;
    const routed = await snapshot(waiterId);

    const again = await projectRepoInitRoutingService.routeInitCardDependents(rowId, fx.ctx);

    expect(again.routedWorkItemIds).toEqual([]);
    expect(await snapshot(waiterId)).toEqual(routed);
  });
});

describe('an approve that created no init card', () => {
  it("routes nothing, leaving another plan's waiter unpinned, and approves as it always did", async () => {
    const fx = await makeWorkItemFixture();
    await settledRow(fx, 'acme-infra');
    const { waiter } = await strayWaiter(fx, 'acme-infra');
    const planId = await plannedPlan(fx, [], ['Polish the docs']);
    const route = vi.spyOn(projectRepoInitRoutingService, 'routeInitCardDependents');

    const answer = await plansService.approvePlan(planId, fx.ctx);

    expect(route).not.toHaveBeenCalled();
    expect((await snapshot(waiter.id)).refs).toEqual([]);
    expect(answer.status).toBe('approved');
    expect((await itemTitled(planId, 'Polish the docs')).projectId).toBe(fx.projectId);
  });
});

describe('the read is workspace-bound', () => {
  it("routes only the approving project's waiter when another workspace declares the same name", async () => {
    const a = await makeWorkItemFixture();
    const b = await makeWorkItemFixture();
    expect(b.workspaceId).not.toBe(a.workspaceId);
    await settledRow(b, 'acme-infra');
    const { waiter: other } = await strayWaiter(b, 'acme-infra');
    const rowA = await settledRow(a, 'acme-infra');
    const planId = await plannedPlan(a, ['acme-infra']);

    await plansService.approvePlan(planId, a.ctx);

    const mine = await snapshot((await itemTitled(planId, 'Use acme-infra')).id);
    expect(mine.refs.map((r) => r.projectRepoId)).toEqual([rowA]);
    expect((await snapshot(other.id)).refs).toEqual([]);
  });

  it('answers empty rather than raising on a project with no rows', async () => {
    const fx = await makeWorkItemFixture();

    const result = await projectRepoInitApproveRoutingService.routeAfterApprove({
      projectId: fx.projectId,
      ctx: fx.ctx,
      approvedProposals: [{ op: 'add', proposedFields: { initRepositoryName: 'acme-infra' } }],
    });

    expect(result).toEqual({ routedWorkItemIds: [], failedRepositoryIds: [] });
  });
});

describe('a rejection is contained, twice over', () => {
  it('one row rejecting does not skip the rest, and is recorded and named', async () => {
    const fx = await makeWorkItemFixture();
    const first = await settledRow(fx, 'acme-infra');
    const second = await settledRow(fx, 'acme-data');
    const { waiter: infraWaiter } = await strayWaiter(fx, 'acme-infra');
    const { waiter: dataWaiter } = await strayWaiter(fx, 'acme-data');
    const rows = await adminDb.projectRepo.findMany({
      where: { projectId: fx.projectId },
      orderBy: { position: 'asc' },
    });
    expect(rows.map((r) => r.id)).toEqual([first, second]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const route = vi
      .spyOn(projectRepoInitRoutingService, 'routeInitCardDependents')
      .mockRejectedValueOnce(new Error('pass down'));

    const result = await projectRepoInitApproveRoutingService.routeAfterApprove({
      projectId: fx.projectId,
      ctx: fx.ctx,
      approvedProposals: [{ op: 'add', proposedFields: { initRepositoryName: 'acme-infra' } }],
    });

    expect(route.mock.calls.map((c) => c[0])).toEqual([first, second]);
    expect(result).toEqual({ routedWorkItemIds: [dataWaiter.id], failedRepositoryIds: [first] });
    expect((await snapshot(infraWaiter.id)).refs).toEqual([]);
    const named = warn.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes(first) && msg.includes(fx.projectId),
    );
    expect(named).toHaveLength(1);
  });

  it('a step that rejects altogether still answers the plan, approved, with its tree', async () => {
    const fx = await makeWorkItemFixture();
    await settledRow(fx, 'acme-infra');
    const planId = await plannedPlan(fx, ['acme-infra']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(projectRepoInitApproveRoutingService, 'routeAfterApprove').mockRejectedValueOnce(
      new Error('read down'),
    );

    const answer = await plansService.approvePlan(planId, fx.ctx);

    expect(answer.status).toBe('approved');
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'approved',
    );
    const waiter = await itemTitled(planId, 'Use acme-infra');
    expect((await snapshot(waiter.id)).refs).toEqual([]);
    const named = warn.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes(planId) && msg.includes(fx.projectId),
    );
    expect(named).toHaveLength(1);
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  projectRepoInitRoutingService,
  routeInitCardDependents,
} from '@/lib/services/projectRepoInitRoutingService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { organizationRepoService } from '@/lib/services/organizationRepoService';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import { workItemRepoRepository } from '@/lib/repositories/workItemRepoRepository';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';
import {
  createTestLink,
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures/workItemFixtures';
import { createTestProject } from '../../fixtures/projectFixtures';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Story MOTIR-10162 · Subtask MOTIR-11042 — a card waiting on an init card is
// routed to the repository that init card created.
//
// Real Postgres, the real set service and the real organisation-repository door.
// The rule cases settle a row FIRST and lay the cards after it, then drive the
// pass directly — so the hooks have nothing to route and the pass is what is
// measured. The hook cases lay the cards first and then settle through the seam.

let fx: WorkItemFixture;
let installationId: string;
let mirrorCount = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  fx = await makeWorkItemFixture();
  installationId = (
    await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-${fx.workspaceId}`,
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        accountLogin: 'acme',
        accountType: 'Organization',
      },
    })
  ).id;
  // `linkExistingRepo` enqueues a first index; that job is not this card's.
  vi.spyOn(codeGraphIndexService, 'enqueueFirstIndexForRepos').mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A connected-repository mirror row in the fixture's organisation. */
async function mirror(name: string) {
  mirrorCount += 1;
  return adminDb.githubRepo.create({
    data: {
      installationId,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: `host-${name}-${mirrorCount}`,
      owner: 'acme',
      name,
      defaultBranch: 'main',
      archived: false,
    },
  });
}

/** A row moved through the real `proposed → creating → created` hops. */
async function createdRow(name: string, realizedAs = name): Promise<string> {
  const repo = await mirror(realizedAs);
  const row = await projectRepoSetService.addRow(fx.projectId, { role: 'infra', name }, fx.ctx);
  await projectRepoSetService.markCreating(row.id, fx.ctx);
  await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);
  return row.id;
}

async function card(
  title: string,
  opts: { parentId?: string; projectFx?: WorkItemFixture } = {},
): Promise<WorkItem> {
  return createTestWorkItem(opts.projectFx ?? fx, {
    kind: opts.parentId ? 'subtask' : 'task',
    title,
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
  });
}

async function initCard(name: string, projectFx: WorkItemFixture = fx): Promise<WorkItem> {
  const item = await card(`Create ${name}`, { projectFx });
  return adminDb.workItem.update({
    where: { id: item.id },
    data: { subject: 'init', initRepositoryName: name },
  });
}

async function waitsOn(dependent: WorkItem, init: WorkItem): Promise<void> {
  await createTestLink({
    workspaceId: fx.workspaceId,
    fromId: dependent.id,
    toId: init.id,
    kind: 'is_blocked_by',
    createdById: fx.ownerId,
  });
}

/** Everything the pass could touch on one card, for byte-identity checks. */
async function snapshot(id: string) {
  const item = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  const refs = await adminDb.workItemRepo.findMany({
    where: { workItemId: id },
    orderBy: { position: 'asc' },
  });
  const edges = await adminDb.workItemLink.findMany({
    where: { fromId: id },
    orderBy: { id: 'asc' },
  });
  return {
    targetRepo: item.targetRepo,
    targetRepos: item.targetRepos,
    status: item.status,
    refs: refs.map((r) => ({ id: r.id, projectRepoId: r.projectRepoId, position: r.position })),
    edges: edges.map((e) => ({ id: e.id, toId: e.toId, kind: e.kind })),
  };
}

async function expectRoutedTo(id: string, rowId: string, name: string): Promise<void> {
  const s = await snapshot(id);
  expect(s.refs.map((r) => [r.projectRepoId, r.position])).toEqual([[rowId, 0]]);
  expect(s.targetRepo).toBe(name);
  expect(s.targetRepos).toEqual([name]);
}

async function doneStatusKey(projectId: string): Promise<string> {
  const status = await adminDb.workflowStatus.findFirstOrThrow({
    where: { projectId, category: 'done' },
  });
  return status.key;
}

describe('routeInitCardDependents — the rule, driven directly', () => {
  it('routes a childless open waiter: one reference at position 0, both name halves, its id returned', async () => {
    const rowId = await createdRow('acme-infra');
    const init = await initCard('acme-infra');
    const waiter = await card('Deploy the stack');
    await waitsOn(waiter, init);

    const result = await routeInitCardDependents(rowId, fx.ctx);

    expect(result.routedWorkItemIds).toEqual([waiter.id]);
    await expectRoutedTo(waiter.id, rowId, 'acme-infra');
    // The blocked-by edge is untouched: the init card still decides WHEN.
    expect((await snapshot(waiter.id)).edges).toEqual([
      expect.objectContaining({ toId: init.id, kind: 'is_blocked_by' }),
    ]);
    // The init card itself is never given a pin.
    expect((await snapshot(init.id)).refs).toEqual([]);
  });

  it.each([['proposed'], ['creating'], ['failed'], ['skipped']] as const)(
    'a row in `%s` routes nothing and leaves every candidate byte-identical',
    async (state) => {
      const row = await projectRepoSetService.addRow(
        fx.projectId,
        { role: 'infra', name: 'acme-infra' },
        fx.ctx,
      );
      if (state === 'creating' || state === 'failed') {
        await projectRepoSetService.markCreating(row.id, fx.ctx);
      }
      if (state === 'failed') await projectRepoSetService.markFailed(row.id, 'name taken', fx.ctx);
      if (state === 'skipped') await projectRepoSetService.skipRow(row.id, fx.ctx);
      expect((await adminDb.projectRepo.findUniqueOrThrow({ where: { id: row.id } })).state).toBe(
        state,
      );
      const init = await initCard('acme-infra');
      const waiter = await card('Waits');
      await waitsOn(waiter, init);
      const before = await snapshot(waiter.id);

      await expect(routeInitCardDependents(row.id, fx.ctx)).resolves.toEqual({
        routedWorkItemIds: [],
      });
      expect(await snapshot(waiter.id)).toEqual(before);
    },
  );

  it('never re-points a candidate that already holds a reference to another repository', async () => {
    const rowId = await createdRow('acme-infra');
    const other = await createdRow('acme-web');
    const init = await initCard('acme-infra');
    const pinned = await card('Already pinned');
    await adminDb.workItemRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: pinned.id,
        projectRepoId: other,
        position: 0,
      },
    });
    await adminDb.workItem.update({
      where: { id: pinned.id },
      data: { targetRepo: 'acme-web', targetRepos: ['acme-web'] },
    });
    await waitsOn(pinned, init);
    const before = await snapshot(pinned.id);

    expect((await routeInitCardDependents(rowId, fx.ctx)).routedWorkItemIds).toEqual([]);
    expect(await snapshot(pinned.id)).toEqual(before);
  });

  it('writes the LEAF under a waiting container, and the rollup gives the container its set', async () => {
    const rowId = await createdRow('acme-infra');
    const init = await initCard('acme-infra');
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'A waiting story' });
    const leaf = await card('The leaf', { parentId: story.id });
    await waitsOn(story, init);
    await waitsOn(leaf, init);

    const result = await routeInitCardDependents(rowId, fx.ctx);

    expect(result.routedWorkItemIds).toEqual([leaf.id]);
    await expectRoutedTo(leaf.id, rowId, 'acme-infra');
    // The container authored nothing, but its DERIVED set now carries the leaf's.
    const container = await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } });
    expect(container.targetRepos).toEqual(['acme-infra']);
    const containerRefs = await adminDb.workItemRepo.findMany({ where: { workItemId: story.id } });
    expect(containerRefs.map((r) => r.projectRepoId)).toEqual([rowId]);
  });

  it('skips a done-category sibling and routes the open one on the same edge, in one call', async () => {
    const rowId = await createdRow('acme-infra');
    const init = await initCard('acme-infra');
    const open = await card('Still open');
    const finished = await card('Already done');
    await adminDb.workItem.update({
      where: { id: finished.id },
      data: { status: await doneStatusKey(fx.projectId) },
    });
    await waitsOn(open, init);
    await waitsOn(finished, init);
    const finishedBefore = await snapshot(finished.id);

    expect((await routeInitCardDependents(rowId, fx.ctx)).routedWorkItemIds).toEqual([open.id]);
    expect(await snapshot(finished.id)).toEqual(finishedBefore);
  });

  it('a status with no category at all counts as OPEN and routes', async () => {
    const rowId = await createdRow('acme-infra');
    const init = await initCard('acme-infra');
    const odd = await card('Unclassified');
    await adminDb.workItem.update({ where: { id: odd.id }, data: { status: 'no_such_status' } });
    await waitsOn(odd, init);

    expect((await routeInitCardDependents(rowId, fx.ctx)).routedWorkItemIds).toEqual([odd.id]);
  });

  it('leaves a card blocked by another init card, a card in another project and a dependent init card untouched', async () => {
    const rowId = await createdRow('acme-infra');
    const init = await initCard('acme-infra');
    const otherInit = await initCard('acme-mobile');
    const elsewhereWaiter = await card('Waits on the mobile repo');
    await waitsOn(elsewhereWaiter, otherInit);

    const project2 = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: `OTH${Math.floor(Math.random() * 10_000)}`,
    });
    const fx2 = {
      ...fx,
      projectId: project2.id,
      projectIdentifier: project2.identifier,
    } as WorkItemFixture;
    const foreign = await card('In another project', { projectFx: fx2 });
    await waitsOn(foreign, init);

    const dependentInit = await initCard('acme-web');
    await waitsOn(dependentInit, init);

    const routed = await card('The one that routes');
    await waitsOn(routed, init);
    const befores = await Promise.all(
      [elsewhereWaiter, foreign, dependentInit].map((c) => snapshot(c.id)),
    );

    expect((await routeInitCardDependents(rowId, fx.ctx)).routedWorkItemIds).toEqual([routed.id]);
    expect(
      await Promise.all([elsewhereWaiter, foreign, dependentInit].map((c) => snapshot(c.id))),
    ).toEqual(befores);
  });

  it('matches case-insensitively on the AUTHORED name', async () => {
    const rowId = await createdRow('Acme-Infra');
    const init = await initCard('acme-infra');
    const waiter = await card('Case differs');
    await waitsOn(waiter, init);

    expect((await routeInitCardDependents(rowId, fx.ctx)).routedWorkItemIds).toEqual([waiter.id]);
    await expectRoutedTo(waiter.id, rowId, 'Acme-Infra');
  });

  it('matches on the REALIZED name when it differs from the authored one', async () => {
    const rowId = await createdRow('infra-draft', 'acme-infra');
    const init = await initCard('ACME-INFRA');
    const waiter = await card('Realized under another name');
    await waitsOn(waiter, init);

    expect((await routeInitCardDependents(rowId, fx.ctx)).routedWorkItemIds).toEqual([waiter.id]);
    // The resolved name is the realized repository's own.
    await expectRoutedTo(waiter.id, rowId, 'acme-infra');
  });

  it('is idempotent: a second call writes nothing and keeps the one reference', async () => {
    const rowId = await createdRow('acme-infra');
    const init = await initCard('acme-infra');
    const waiter = await card('Once');
    await waitsOn(waiter, init);

    await routeInitCardDependents(rowId, fx.ctx);
    const first = await snapshot(waiter.id);
    expect(first.refs).toHaveLength(1);

    expect((await routeInitCardDependents(rowId, fx.ctx)).routedWorkItemIds).toEqual([]);
    expect(await snapshot(waiter.id)).toEqual(first);
  });

  it('re-reads UNDER the card lock: a reference that landed after the batched read is not overwritten', async () => {
    const rowId = await createdRow('acme-infra');
    const other = await createdRow('acme-web');
    const init = await initCard('acme-infra');
    const raced = await card('Pinned by a concurrent writer');
    await waitsOn(raced, init);
    await adminDb.workItemRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: raced.id,
        projectRepoId: other,
        position: 0,
      },
    });
    const before = await snapshot(raced.id);
    // The batched pre-filter saw the card BEFORE that reference landed.
    vi.spyOn(workItemRepoRepository, 'listByWorkItems').mockResolvedValueOnce([]);

    expect((await routeInitCardDependents(rowId, fx.ctx)).routedWorkItemIds).toEqual([]);
    expect(await snapshot(raced.id)).toEqual(before);
  });

  it('an id naming no row in the caller`s workspace answers empty and writes nothing', async () => {
    const rowId = await createdRow('acme-infra');
    const init = await initCard('acme-infra');
    const waiter = await card('Waits');
    await waitsOn(waiter, init);
    const before = await snapshot(waiter.id);

    await expect(routeInitCardDependents('no-such-row', fx.ctx)).resolves.toEqual({
      routedWorkItemIds: [],
    });
    // The real row, read from a context bound to ANOTHER workspace, is no row.
    const other = await makeWorkItemFixture();
    await expect(routeInitCardDependents(rowId, other.ctx)).resolves.toEqual({
      routedWorkItemIds: [],
    });
    expect(await snapshot(waiter.id)).toEqual(before);
  });

  it('answers empty when no init card declares the row`s name', async () => {
    const rowId = await createdRow('acme-infra');
    const init = await initCard('acme-elsewhere');
    const waiter = await card('Waits on a different repo');
    await waitsOn(waiter, init);

    expect((await routeInitCardDependents(rowId, fx.ctx)).routedWorkItemIds).toEqual([]);
  });

  it('answers empty when the declaring init card has no routable dependent', async () => {
    const rowId = await createdRow('acme-infra');
    await initCard('acme-infra');
    expect((await routeInitCardDependents(rowId, fx.ctx)).routedWorkItemIds).toEqual([]);
  });
});

describe('the settle seams route without any caller remembering it', () => {
  it('`attachRealizedRepo` routes the waiters on its `created` hop, and a replay routes nothing', async () => {
    const init = await initCard('acme-infra');
    const waiter = await card('Waits for the infra repo');
    await waitsOn(waiter, init);
    const repo = await mirror('acme-infra');
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'infra', name: 'acme-infra' },
      fx.ctx,
    );
    await projectRepoSetService.markCreating(row.id, fx.ctx);

    await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);

    await expectRoutedTo(waiter.id, row.id, 'acme-infra');
    expect((await routeInitCardDependents(row.id, fx.ctx)).routedWorkItemIds).toEqual([]);
  });

  it('a settle that ends FAILED strands nobody: still blocked, still unpinned, the reason kept', async () => {
    const init = await initCard('acme-infra');
    const waiter = await card('Waits');
    await waitsOn(waiter, init);
    const before = await snapshot(waiter.id);
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'infra', name: 'acme-infra' },
      fx.ctx,
    );
    await projectRepoSetService.markCreating(row.id, fx.ctx);
    await projectRepoSetService.markFailed(row.id, 'the name is taken on the host', fx.ctx);

    expect((await routeInitCardDependents(row.id, fx.ctx)).routedWorkItemIds).toEqual([]);
    expect(await snapshot(waiter.id)).toEqual(before);
    expect(before.refs).toEqual([]);
    const stored = await adminDb.projectRepo.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.state).toBe('failed');
    expect(stored.failureReason).toBe('the name is taken on the host');
  });

  it('`linkExistingRepo` routes the waiters and returns its row unchanged', async () => {
    const init = await initCard('acme-infra');
    const waiter = await card('Waits for a person-added repo');
    await waitsOn(waiter, init);
    const repo = await mirror('acme-infra');

    const linked = await organizationRepoService.linkExistingRepo(
      fx.projectId,
      { githubRepoId: repo.id, role: 'infra' },
      fx.ctx,
    );

    expect(linked.name).toBe('acme-infra');
    expect(linked.state).toBe('connected');
    await expectRoutedTo(waiter.id, linked.id, 'acme-infra');
  });
});

describe('neither hook can fail a settle', () => {
  function failRouting() {
    vi.spyOn(projectRepoInitRoutingService, 'routeInitCardDependents').mockRejectedValue(
      new Error('routing exploded'),
    );
    return vi.spyOn(console, 'error').mockImplementation(() => {});
  }

  it('`attachRealizedRepo` still returns its row, and logs the row id', async () => {
    const errors = failRouting();
    const repo = await mirror('acme-infra');
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'infra', name: 'acme-infra' },
      fx.ctx,
    );
    await projectRepoSetService.markCreating(row.id, fx.ctx);

    const attached = await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);

    expect(attached.state).toBe('created');
    expect(
      errors.mock.calls.some(
        ([msg]) =>
          String(msg).includes('route init-card dependents') && String(msg).includes(row.id),
      ),
    ).toBe(true);
  });

  it('`linkExistingRepo` still returns its row, and logs the row id', async () => {
    const errors = failRouting();
    const repo = await mirror('acme-infra');
    const ctx: ServiceContext = fx.ctx;

    const linked = await organizationRepoService.linkExistingRepo(
      fx.projectId,
      { githubRepoId: repo.id, role: 'infra' },
      ctx,
    );

    expect(linked.state).toBe('connected');
    expect(
      errors.mock.calls.some(
        ([msg]) =>
          String(msg).includes('route init-card dependents') && String(msg).includes(linked.id),
      ),
    ).toBe(true);
  });
});

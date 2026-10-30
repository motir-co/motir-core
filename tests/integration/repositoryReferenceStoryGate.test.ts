import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { workItemRepoRepository } from '@/lib/repositories/workItemRepoRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { toWorkItemDto } from '@/lib/mappers/workItemMappers';
import { presentWorkItemDetail, workItemDetailSchema } from '@/lib/api/v1/workItems/schema';
import { presentMcpWorkItem } from '@/lib/mcp/payloads/workItems';
import { resolveItemDispatchPin } from '@/lib/workItems/dispatchRepo';
import { resolveExpectedRepos } from '@/lib/workItems/expectedRepos';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// STORY GATE for MOTIR-2732 — a card's repository is a THING, not a word
// (Subtask MOTIR-3031). It runs over the story's ASSEMBLED state and measures
// the seams between its cards, not their individual rules.
//
// The one question the feature cards cannot answer about themselves: is the
// reference model actually REACHABLE? Each of them is verifiable in isolation
// and none proves the outcome — the rollup can be correct and produce empty sets
// forever if the path that creates most work items never writes a reference, and
// the completion gate can be correct while staying inert because it was written
// months earlier against a column nothing populated.
//
// Six seams, each one a place where two cards' real code meets:
//
//   1. REFERENCE ⟷ RENAME — the story's central claim. A row is renamed and
//      every card pointing at it survives, on every seam.
//   2. ROLLUP ⟷ the COMPLETION GATE — the assertion that proves the capability
//      is reachable at all.
//   3. ROLLUP ⟷ CONCURRENCY — two children written at once, against real
//      Postgres. A lost update here is silent and permanent.
//   4. TENANCY — the ancestor walk and the join table, both across a workspace
//      boundary, with the RLS policies doing the work.
//   5. CONTRACT TOTALITY — the DTO, `/api/v1` and the MCP payload agree about
//      one card, in ONE test rather than three that could drift.
//   6. REFERENTIAL INTEGRITY — at the DATABASE, not only at the validator.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-repo-ref-gate';
const CORE = { name: 'motir-core', providerRepoId: '9001', defaultBranch: 'main' };
const AI = { name: 'motir-ai', providerRepoId: '9002', defaultBranch: 'trunk' };

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

async function scenario(email: string, opts: { identifier?: string; name?: string } = {}) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: opts.name ?? 'Acme',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: opts.name ?? 'Acme',
    identifier: opts.identifier ?? 'ACME',
  });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  // The project's OWN repository rows — the objects a card now points at. Both
  // start `proposed`, which is the state the reference model exists to make
  // expressible: a card can pin a repository that does not exist yet.
  const web = await projectRepoSetService.addRow(project.id, { role: 'web', name: CORE.name }, ctx);
  const api = await projectRepoSetService.addRow(project.id, { role: 'api', name: AI.name }, ctx);
  return { user, workspace, project, ctx, web, api };
}

async function refs(itemId: string, workspaceId: string) {
  return withWorkspaceServiceContext(workspaceId, (tx) =>
    workItemRepoRepository.listByWorkItem(itemId, tx),
  );
}

// ───────────────────────────────────────────────────────────────────────────
describe('1 — REFERENCE ⟷ RENAME: the story’s central claim', () => {
  it('a renamed row changes what every card DISPLAYS and nothing about what it points AT', async () => {
    const fx = await scenario('rename@example.com');
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.project.id,
        kind: 'task',
        title: 'Ships in the web repository',
        targetRepositories: [fx.web.id],
      },
      fx.ctx,
    );
    const child = await workItemsService.createWorkItem(
      {
        projectId: fx.project.id,
        kind: 'task',
        title: 'Also the web repository',
        targetRepositories: [fx.web.id],
      },
      fx.ctx,
    );

    const before = await refs(item.id, fx.workspace.id);
    expect(before.map((r) => r.projectRepoId)).toEqual([fx.web.id]);

    await projectRepoSetService.patchRow(fx.web.id, { name: 'motir-core-renamed' }, fx.ctx);

    // The IDENTITY is unchanged — the join row was never touched by the rename,
    // which is the whole point of pointing at a row instead of copying its name.
    const after = await refs(item.id, fx.workspace.id);
    expect(after.map((r) => r.projectRepoId)).toEqual([fx.web.id]);
    expect(after[0]!.id).toBe(before[0]!.id);

    // …and every card that points at it now reads the NEW name, with no write
    // to any work item. A name-copying model would need a sweep here, and the
    // cards it missed would be silently wrong.
    for (const id of [item.id, child.id]) {
      const rows = await refs(id, fx.workspace.id);
      expect(
        toWorkItemDto(
          await adminDb.workItem.findUniqueOrThrow({ where: { id } }),
          rows,
        ).targetRepositories?.map((r) => r.name),
      ).toEqual(['motir-core-renamed']);
    }
  });

  it('a rename moves the COMPLETION GATE with it — not only the panel', async () => {
    // ⚠️ The defect the acceptance flow found (MOTIR-3043), pinned here so it
    // cannot come back below the browser. `work_item.targetRepos` is a STORED
    // projection written when the item is written; a rename on the host rewrites
    // nothing. The panel resolved through the references and showed the new
    // name, while the gate compared the OLD one against a pull request reporting
    // the new one, matched nothing, and held the card open forever.
    //
    // A card that survives a rename everywhere except the gate has not survived
    // it — so both sides are read here, from the same row, after the rename.
    const fx = await scenario('rename-gate@example.com');
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.project.id,
        kind: 'task',
        title: 'Renamed out from under the gate',
        targetRepositories: [fx.web.id],
      },
      fx.ctx,
    );
    await projectRepoSetService.patchRow(fx.web.id, { name: 'motir-core-after' }, fx.ctx);

    // The item's own stored projection is deliberately NOT re-read here: it is
    // stale by construction, and that is exactly the point.
    const stale = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stale.targetRepos).toEqual([CORE.name]);

    const expected = await withWorkspaceServiceContext(fx.workspace.id, (tx) =>
      resolveExpectedRepos(item.id, stale.targetRepos, tx),
    );
    // What the GATE will compare — the resolved name, not the stored one.
    expect(expected.map((e) => e.repo)).toEqual(['motir-core-after']);
    // …and what the PANEL shows, from the same resolution.
    const delivery = await workItemsService.listRepoDelivery(item.id, stale.targetRepos, fx.ctx);
    expect(delivery.map((d) => d.repo)).toEqual(['motir-core-after']);
  });

  it('a rename moves the DISPATCH with it — the pin resolves to the row, not to the old word', async () => {
    const fx = await scenario('dispatch@example.com');
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.project.id,
        kind: 'task',
        title: 'Dispatches somewhere',
        targetRepositories: [fx.api.id],
      },
      fx.ctx,
    );
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(
      await withWorkspaceServiceContext(fx.workspace.id, (tx) => resolveItemDispatchPin(row, tx)),
    ).toBe(AI.name);

    await projectRepoSetService.patchRow(fx.api.id, { name: 'motir-ai-2' }, fx.ctx);
    expect(
      await withWorkspaceServiceContext(fx.workspace.id, (tx) => resolveItemDispatchPin(row, tx)),
    ).toBe('motir-ai-2');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('2 — ROLLUP ⟷ the COMPLETION GATE: is the capability reachable?', () => {
  it('a story whose set came from its CHILDREN holds on one merge and completes on the second', async () => {
    // ⚠️ Since MOTIR-10135 the hold on the first merge is the DELIVERY set's —
    // the story's second linked pull request is still open — and no longer the
    // repository set's: completion counts the linked pull requests, so a
    // repository with none would not hold the story at all.
    const fx = await scenario('reach@example.com');
    // The repositories have to EXIST on the host for a pull request to name
    // them, so the two rows are realized against a real installation mirror.
    await githubInstallationService.persistInstallation({
      workspaceId: fx.workspace.id,
      installation: {
        installationId: INSTALLATION_ID,
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [CORE, AI].map((r) => ({
        providerRepoId: r.providerRepoId,
        owner: 'moooon',
        name: r.name,
        defaultBranch: r.defaultBranch,
        archived: false,
      })),
    });

    // ⚠️ REALIZE both rows. A row that is still `proposed` names no repository on
    // any host, so §A5 classifies it `unestablished` and the gate holds the card
    // — correctly, and regardless of any pull request. A fixture that mirrors two
    // real repositories while leaving the project's own rows proposed is not a
    // two-repository project; it is an inconsistent one, and the gate would be
    // right to refuse it.
    for (const [row, repo] of [
      [fx.web, CORE],
      [fx.api, AI],
    ] as const) {
      const mirrored = await withWorkspaceServiceContext(fx.workspace.id, (tx) =>
        githubRepoRepository.findConnectedByWorkspaceAndName(
          fx.workspace.id,
          'moooon',
          repo.name,
          tx,
        ),
      );
      expect(mirrored, `the mirror carries ${repo.name}`).not.toBeNull();
      await projectRepoSetService.attachRealizedRepoRow(row.id, mirrored!.id, fx.ctx);
    }

    const story = await workItemsService.createWorkItem(
      { projectId: fx.project.id, kind: 'story', title: 'Spans two repositories' },
      fx.ctx,
    );
    const webHalf = await workItemsService.createWorkItem(
      {
        projectId: fx.project.id,
        kind: 'subtask',
        title: 'The web half',
        parentId: story.id,
        targetRepositories: [fx.web.id],
      },
      fx.ctx,
    );
    const apiHalf = await workItemsService.createWorkItem(
      {
        projectId: fx.project.id,
        kind: 'subtask',
        title: 'The api half',
        parentId: story.id,
        targetRepositories: [fx.api.id],
      },
      fx.ctx,
    );

    // NOBODY wrote the story's set. It is the UNION of its leaves', derived —
    // and until this story there was no path that could put a second repository
    // in front of the gate at all.
    const storyRow = await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } });
    expect(storyRow.targetRepos.slice().sort()).toEqual([AI.name, CORE.name]);

    await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
    // ⚠️ BUILD THE HALVES BEFORE DELIVERING THE STORY (Bug MOTIR-3229). A
    // container's `implemented` is now a CLAIM about its children — the gate in
    // `applyStatusTransition` refuses it while any live child sits below
    // `implemented` — so a fixture that delivers a story over two untouched
    // subtasks is refused, and correctly: that is precisely the shape MOTIR-1343
    // shipped (a story `implemented`, then In Review, then Done, with `todo`
    // children the merge then cascaded closed). Nothing about the SEAM under test
    // changes: the story's repository set is derived from these two rows either
    // way, and their statuses are not an input to it.
    for (const half of [webHalf, apiHalf]) {
      await workItemsService.updateStatus(half.id, 'in_progress', fx.ctx);
      await workItemsService.updateStatus(half.id, 'implemented', fx.ctx);
    }
    const event = (action: string, repo: typeof CORE, number: number, merged: boolean) =>
      githubWebhookService.handleEvent('pull_request', {
        action,
        installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
        repository: { id: Number(repo.providerRepoId) },
        pull_request: {
          number,
          state: merged ? 'closed' : 'open',
          merged,
          title: `Change (${storyRow.identifier})`,
          head: { ref: `story/${storyRow.identifier}` },
          base: { ref: repo.defaultBranch },
          user: { id: 4242 },
        },
      });
    const open = async (repo: typeof CORE, number: number) => {
      // LINKED first — since MOTIR-3674 the `Change (KEY)` title above names the
      // story to a reader and to nothing else, so an unlinked delivery would
      // resolve `no_work_item` and the completion gates below would never be
      // reached. The link is setup; the gate assertions follow.
      await linkPrByIdentifier({
        identifier: storyRow.identifier,
        owner: 'moooon',
        name: repo.name,
        number,
        headRef: `story/${storyRow.identifier}`,
        baseRef: repo.defaultBranch,
      });
      await event('opened', repo, number, false);
    };
    const merge = (repo: typeof CORE, number: number) => event('closed', repo, number, true);

    await open(CORE, 1);
    await open(AI, 2);
    expect(await merge(CORE, 1)).toMatchObject({ outcome: 'deferred_incomplete_delivery_set' });
    // Held, not done. `implemented` since MOTIR-2999 — the delivery says the code
    // is pushed, and no build has reported for this card.
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } })).status).toBe(
      'implemented',
    );
    expect(await merge(AI, 2)).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } })).status).toBe(
      'done',
    );
  });

  it('a PROPOSED row holds the card, and says something a merge cannot answer', async () => {
    // §A5's new state, end to end: the leaf points at a row that names no
    // repository on any host, so the gate must hold — and must hold for a
    // reason that is not "no pull request yet", because no pull request could
    // exist.
    const fx = await scenario('proposed@example.com');
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.project.id,
        kind: 'task',
        title: 'Pins a repository that does not exist yet',
        targetRepositories: [fx.web.id],
      },
      fx.ctx,
    );
    const delivery = await workItemsService.listRepoDelivery(item.id, [CORE.name], fx.ctx);
    expect(delivery).toEqual([
      { repo: CORE.name, state: 'unestablished', primary: true, role: 'web' },
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('3 — ROLLUP ⟷ CONCURRENCY: no lost update on a parent’s set', () => {
  it('two children written AT THE SAME TIME both survive in the parent', async () => {
    const fx = await scenario('race@example.com');
    const story = await workItemsService.createWorkItem(
      { projectId: fx.project.id, kind: 'story', title: 'Two children, at once' },
      fx.ctx,
    );

    // Concurrent, against real Postgres. A read-modify-write without the
    // container row lock loses one of these silently and permanently — the
    // parent looks complete and closes its first pull request early, weeks
    // before anyone notices.
    await Promise.all([
      workItemsService.createWorkItem(
        {
          projectId: fx.project.id,
          kind: 'subtask',
          title: 'child web',
          parentId: story.id,
          targetRepositories: [fx.web.id],
        },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        {
          projectId: fx.project.id,
          kind: 'subtask',
          title: 'child api',
          parentId: story.id,
          targetRepositories: [fx.api.id],
        },
        fx.ctx,
      ),
    ]);

    const rows = await refs(story.id, fx.workspace.id);
    expect(rows.map((r) => r.projectRepoId).sort()).toEqual([fx.api.id, fx.web.id].sort());
    const storyRow = await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } });
    expect(storyRow.targetRepos.slice().sort()).toEqual([AI.name, CORE.name]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('4 — TENANCY: the ancestor walk and the join table, across a boundary', () => {
  it('the JOIN TABLE is invisible from another workspace, under the policy', async () => {
    const a = await scenario('tenant-a@example.com', { identifier: 'AAA', name: 'A' });
    const b = await scenario('tenant-b@example.com', { identifier: 'BBB', name: 'B' });
    const item = await workItemsService.createWorkItem(
      {
        projectId: a.project.id,
        kind: 'task',
        title: 'A’s card',
        targetRepositories: [a.web.id],
      },
      a.ctx,
    );

    expect(await refs(item.id, a.workspace.id)).toHaveLength(1);
    // Same id, other tenant's GUC. The policy is what returns nothing here — an
    // assertion that passed without it would be measuring the WHERE clause.
    expect(await refs(item.id, b.workspace.id)).toHaveLength(0);
  });

  it('the ROLLUP’s ancestor walk stops at the workspace, not merely at the tree', async () => {
    const a = await scenario('walk-a@example.com', { identifier: 'WA', name: 'WA' });
    const b = await scenario('walk-b@example.com', { identifier: 'WB', name: 'WB' });
    const story = await workItemsService.createWorkItem(
      { projectId: a.project.id, kind: 'story', title: 'A’s story' },
      a.ctx,
    );
    await workItemsService.createWorkItem(
      {
        projectId: a.project.id,
        kind: 'subtask',
        title: 'A’s leaf',
        parentId: story.id,
        targetRepositories: [a.web.id],
      },
      a.ctx,
    );
    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } })).targetRepos,
    ).toEqual([CORE.name]);

    // B derives the SAME container id under B's context. The walk must find
    // nothing — a walk written as "keep going up" rather than "keep going up
    // within this workspace" returns A's leaves here.
    const seenByB = await withWorkspaceServiceContext(b.workspace.id, (tx) =>
      workItemRepoRepository.listDerivedRefsForContainer(story.id, b.workspace.id, tx),
    );
    expect(seenByB).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('5 — CONTRACT TOTALITY: three consumers, one card, one test', () => {
  it('the DTO, /api/v1 and the MCP payload report the SAME repositories', async () => {
    const fx = await scenario('totality@example.com');
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.project.id,
        kind: 'task',
        title: 'Two references, in order',
        targetRepositories: [fx.api.id, fx.web.id],
      },
      fx.ctx,
    );

    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    const rows = await refs(item.id, fx.workspace.id);
    const dto = toWorkItemDto(row, rows);
    const detail = await workItemsService.getIssueDetail(fx.project.id, item.identifier, fx.ctx);
    const publicBody = workItemDetailSchema.parse(presentWorkItemDetail(detail, 0, {}, []));
    const mcp = presentMcpWorkItem(dto);

    // The ORDER is the set's, not the rows' creation order — `api` was pinned
    // first here, so it is element 0 and the dispatch target.
    for (const shape of [dto, publicBody, mcp]) {
      expect(shape.targetRepositories?.map((r) => r.name)).toEqual([AI.name, CORE.name]);
      expect(shape.targetRepositories?.map((r) => r.role)).toEqual(['api', 'web']);
      expect(shape.targetRepositories?.map((r) => r.ref)).toEqual([fx.api.id, fx.web.id]);
      expect(shape.targetRepositories?.[0]!.primary).toBe(true);
      // The name projection and the references are ONE fact, not two.
      expect(shape.targetRepos).toEqual([AI.name, CORE.name]);
      expect(shape.targetRepo).toBe(AI.name);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('6 — REFERENTIAL INTEGRITY, at the database', () => {
  it('a reference to ANOTHER project’s repository row is rejected by the service', async () => {
    const fx = await scenario('cross-project@example.com');
    const other = await projectsService.createProject({
      workspaceId: fx.workspace.id,
      actorUserId: fx.user.id,
      name: 'Other',
      identifier: 'OTHR',
    });
    const otherRow = await projectRepoSetService.addRow(
      other.id,
      { role: 'web', name: 'other-web' },
      fx.ctx,
    );

    await expect(
      workItemsService.createWorkItem(
        {
          projectId: fx.project.id,
          kind: 'task',
          title: 'Points across projects',
          targetRepositories: [otherRow.id],
        },
        fx.ctx,
      ),
    ).rejects.toThrow();
  });

  it('deleting the ROW takes its references with it — no dangling pin survives', async () => {
    const fx = await scenario('cascade@example.com');
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.project.id,
        kind: 'task',
        title: 'Pins a row about to be removed',
        targetRepositories: [fx.web.id],
      },
      fx.ctx,
    );
    expect(await refs(item.id, fx.workspace.id)).toHaveLength(1);

    await projectRepoSetService.removeRow(fx.web.id, fx.ctx);
    // Cascade at the DATABASE (ADR §A2), so a pin cannot outlive what it points
    // at — the failure a nullable FK would leave is a card claiming a
    // repository that no longer exists in the project.
    expect(await refs(item.id, fx.workspace.id)).toHaveLength(0);
  });
});

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { parentStatusRollupService } from '@/lib/services/parentStatusRollupService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { IllegalTransitionError, UnknownStatusError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures/workItemFixtures';
import { truncateAuthTables } from '../../helpers/db';

// `parentStatusRollupService.rollUpForChild` — the UPWARD half of bidirectional
// status derivation (Story MOTIR-1615 · Subtask MOTIR-1620, AMENDED by Story
// MOTIR-2888 · Subtask MOTIR-2891). Real Postgres.
//
// It is a RECOMPUTE, not a ratchet: the parent's status is a function of its
// children's current statuses over a FIVE-rung ladder (MOTIR-3229 added
// `implemented` between in-progress and in-review), applied forward OR
// backward. The `forward-only` describe block these tests used to carry asserted
// the opposite of the third block below, and was replaced rather than extended —
// two suites disagreeing about which way a parent may move is worse than either.
//
// The one mocked external is the event emitter: this service's post-commit
// `work-item/transitioned` is what carries derivation to the NEXT level, and the
// job that consumes it is MOTIR-1621's. Here we assert the service emits exactly
// when it really moved the parent, and never otherwise — the property that makes
// the recursion terminate.

const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

beforeEach(async () => {
  await truncateAuthTables();
  sent.length = 0;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function setStatus(id: string, status: string): Promise<void> {
  await adminDb.workItem.update({ where: { id }, data: { status } });
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

/** Remove ONE edge from the project's own graph — a workflow that does not declare it. */
async function cutEdge(fx: WorkItemFixture, from: string, to: string): Promise<void> {
  await adminDb.workflowTransition.deleteMany({
    where: { projectId: fx.projectId, fromStatus: { key: from }, toStatus: { key: to } },
  });
}

/** A story with N subtasks, every status pinned explicitly (the fixture writes
 *  through the repository, which skips the service's initial-status lookup). */
async function storyWithChildren(fx: WorkItemFixture, statuses: string[]) {
  const story = await createTestWorkItem(fx, { kind: 'story', title: 'Parent' });
  await setStatus(story.id, 'todo');
  const children = [];
  for (const [i, s] of statuses.entries()) {
    const c = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: `child ${i}`,
      parentId: story.id,
    });
    await setStatus(c.id, s);
    children.push(c);
  }
  return { story, children };
}

describe('the ladder — each rung moves the parent to the right status', () => {
  it('in-progress rung: one child starts ⇒ a todo parent goes in_progress', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_progress', 'todo']);

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toEqual({ outcome: 'rolled_up', parentId: story.id, toStatus: 'in_progress' });
    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('in-review rung: the LAST open child reaches review ⇒ parent in_review', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_review', 'done']);
    await setStatus(story.id, 'in_progress'); // where the previous rung left it

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'rolled_up', toStatus: 'in_review' });
    expect(await statusOf(story.id)).toBe('in_review');
  });

  it('in-review rung does NOT fire while a child is still open', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_review', 'todo']);
    await setStatus(story.id, 'in_progress');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    // The in-progress rung is the only match, and the parent is already there.
    expect(res).toMatchObject({ outcome: 'already_there' });
    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('done rung: every child done ⇒ parent done, straight from in_progress', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done']);
    await setStatus(story.id, 'in_progress');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    // This is the move MOTIR-1625's in_progress → done edge exists for.
    expect(res).toMatchObject({ outcome: 'rolled_up', toStatus: 'done' });
    expect(await statusOf(story.id)).toBe('done');
  });

  it('a CANCELLED child counts as done (category, not key)', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'cancelled']);
    await setStatus(story.id, 'in_progress');

    await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);
    expect(await statusOf(story.id)).toBe('done');
  });

  it('the done rung beats the in-review rung when both could match', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done']);
    await setStatus(story.id, 'in_review');

    await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);
    expect(await statusOf(story.id)).toBe('done');
  });

  // ── The `implemented` rung (Bug MOTIR-3229) ─────────────────────────────
  //
  // `implemented` is an `in_progress`-CATEGORY status, so before this rung the
  // ladder collapsed it into rung `in_progress` and a parent whose children were
  // ALL built derived to "something has started" — the ladder could not say
  // "everything below me is BUILT", which is exactly the state a story run ends
  // in. MOTIR-1343 claimed `implemented` with two `todo` children and nothing
  // contradicted it.
  it('implemented rung: every child implemented ⇒ parent implemented', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['implemented', 'implemented']);
    await setStatus(story.id, 'in_progress');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'rolled_up', toStatus: 'implemented' });
    expect(await statusOf(story.id)).toBe('implemented');
  });

  it('implemented rung: implemented-or-better mixes count — done and in_review too', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['implemented', 'done']);
    await setStatus(story.id, 'in_progress');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'rolled_up', toStatus: 'implemented' });
    expect(await statusOf(story.id)).toBe('implemented');
  });

  it('the in-review rung beats the implemented rung when both could match', async () => {
    // Every child is implemented-or-better AND at least one is in review, so both
    // rungs match. First match wins, and in-review is the higher one.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_review', 'done']);
    await setStatus(story.id, 'implemented');

    await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);
    expect(await statusOf(story.id)).toBe('in_review');
  });

  it('implemented rung does NOT fire while ANY child is below it', async () => {
    // ⭐ THE DEFECT, at the derivation altitude. MOTIR-1343's exact child set: the
    // scope children built, two bugs the run filed still at `todo`. The parent
    // must read "something has started", never "everything is built".
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, [
      'implemented',
      'implemented',
      'todo',
      'todo',
    ]);
    await setStatus(story.id, 'in_progress');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'already_there', toStatus: 'in_progress' });
    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('a parent whose children are ALL implemented no longer reads as merely in_progress', async () => {
    // The regression guard for the collapse itself: `inProgress` in the aggregate
    // now EXCLUDES implemented children, so a reader asking "has anything
    // started?" must ask all three buckets. If that were missed, this set would
    // match NO rung above `todo` and the parent would come BACK to todo — a worse
    // failure than the one being fixed.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['implemented']);
    await setStatus(story.id, 'todo');

    await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);
    expect(await statusOf(story.id)).toBe('implemented');
  });

  it('rolls up an EPIC from its stories, not just a story from its subtasks', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Epic' });
    await setStatus(epic.id, 'todo');
    const story = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'Story',
      parentId: epic.id,
    });
    await setStatus(story.id, 'in_progress');

    const res = await parentStatusRollupService.rollUpForChild(story.id, fx.workspaceId);
    expect(res).toMatchObject({ outcome: 'rolled_up', parentId: epic.id });
    expect(await statusOf(epic.id)).toBe('in_progress');
  });
});

describe('the APPROVED rung (MOTIR-5140) — a person\u2019s yes moves the parent FORWARD', () => {
  it('every live child approved ⇒ the parent derives to approved, NOT to in_progress', async () => {
    // THE REGRESSION THIS CARD EXISTS FOR. `approved` is an in_progress-CATEGORY
    // status, so before the sixth rung it ranked as plain in-progress and this
    // parent derived BACKWARDS — the same children at `in_review` derived to In
    // Review, and moving them forward to Approved moved the parent back.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['approved', 'approved']);
    await setStatus(story.id, 'in_review'); // where the previous rung left it

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'rolled_up', toStatus: 'approved' });
    expect(await statusOf(story.id)).toBe('approved');
  });

  it('and the parent is NOT completed — the story\u2019s own acceptance criterion', async () => {
    // Proven rather than inherited from the category: `approved` sits in
    // `in_progress`, so nothing here should reach a done-category status.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['approved', 'approved']);

    await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    const parent = await statusOf(story.id);
    expect(parent).toBe('approved');
    const statuses = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    expect(statuses.statuses.find((st) => st.key === parent)?.category).toBe('in_progress');
    expect(parent).not.toBe('done');
  });

  it('approved + done ⇒ approved; one child still in review holds it at in_review', async () => {
    // The cumulative-sum shape: each rung counts every bucket at-or-ABOVE it, so
    // a done sibling does not block the approved rung and an in-review one does.
    const fx = await makeWorkItemFixture();
    const a = await storyWithChildren(fx, ['approved', 'done']);
    await parentStatusRollupService.rollUpForChild(a.children[0]!.id, fx.workspaceId);
    expect(await statusOf(a.story.id)).toBe('approved');

    const b = await storyWithChildren(fx, ['approved', 'in_review']);
    await parentStatusRollupService.rollUpForChild(b.children[0]!.id, fx.workspaceId);
    expect(await statusOf(b.story.id)).toBe('in_review');
  });

  it('a project WITHOUT an approved status derives exactly as it did before', async () => {
    // The inertness guarantee, at the service level: strip the status the way a
    // project the backfill never reached would have it, and the ladder falls back
    // to the category for everything — which is the five-rung reading.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_review', 'in_review']);
    await setStatus(story.id, 'in_progress'); // the rung the recompute walks from
    await adminDb.$executeRawUnsafe(
      `DELETE FROM workflow_status WHERE project_id = $1 AND key = 'approved'`,
      fx.projectId,
    );

    await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(await statusOf(story.id)).toBe('in_review');
  });
});

describe('the fourth (todo) rung — the ladder can say "open work, none started"', () => {
  it('a DONE parent given a fresh todo child comes back to todo', async () => {
    // The story's own case (MOTIR-2888), and the one the ratchet could not
    // express: `done → todo` is not an edge in the default workflow, so this
    // lands only via the backward arm's system set.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done', 'todo']);
    await setStatus(story.id, 'done');

    const res = await parentStatusRollupService.rollUpForChild(children[2]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'rolled_back', parentId: story.id, toStatus: 'todo' });
    expect(await statusOf(story.id)).toBe('todo');
  });

  it('an all-todo parent already in todo is the OTHER fixed point — no move, no emit', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['todo', 'blocked']);

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toEqual({ outcome: 'already_there', parentId: story.id, toStatus: 'todo' });
    expect(await statusOf(story.id)).toBe('todo');
    expect(sent).toHaveLength(0);
  });

  it('does NOT fire on an empty aggregate — a childless parent is untouched', async () => {
    // The mirror of "every child is done must not be vacuously true": creating a
    // story must not knock its epic back to todo.
    const fx = await makeWorkItemFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Epic' });
    await setStatus(epic.id, 'done');
    const story = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'Story',
      parentId: epic.id,
    });
    await setStatus(story.id, 'done');
    // Every live child of the STORY is archived, so its own aggregate is empty.
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'archived child',
      parentId: story.id,
    });
    await setStatus(child.id, 'todo');
    await adminDb.workItem.update({ where: { id: child.id }, data: { archivedAt: new Date() } });

    const res = await parentStatusRollupService.rollUpForChild(child.id, fx.workspaceId);

    expect(res).toEqual({ outcome: 'no_rung', parentId: story.id });
    expect(await statusOf(story.id)).toBe('done');
    expect(sent).toHaveLength(0);
  });

  it('leaves a BLOCKED parent alone — same rung, and blocked is a human marker', async () => {
    // `blocked` and `todo` share the todo category, so the todo rung ranks level
    // with where the parent stands. `blocked → todo` IS a legal edge, so treating
    // the tie as a forward move would silently clear the marker on every child
    // event. It is neither forward nor backward: nothing moves.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['todo', 'todo']);
    await setStatus(story.id, 'blocked');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toEqual({ outcome: 'same_rung', parentId: story.id, toStatus: 'todo' });
    expect(await statusOf(story.id)).toBe('blocked');
    expect(sent).toHaveLength(0);
  });
});

describe('the recompute comes BACK — every rung, from a done parent', () => {
  it('a child reopening done → in_progress DOES bring the parent back', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_progress', 'done']);
    await setStatus(story.id, 'done'); // the parent had already completed

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'rolled_back', toStatus: 'in_progress' });
    expect(await statusOf(story.id)).toBe('in_progress');
    expect(sent).toHaveLength(1);
  });

  it('a done parent whose last child moves to review comes back to in_review', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'in_review']);
    await setStatus(story.id, 'done');

    const res = await parentStatusRollupService.rollUpForChild(children[1]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'rolled_back', toStatus: 'in_review' });
    expect(await statusOf(story.id)).toBe('in_review');
  });

  it('an in_review parent IS dragged back to in_progress when a child restarts', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_progress', 'in_review']);
    await setStatus(story.id, 'in_review');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);
    expect(res).toMatchObject({ outcome: 'rolled_back', toStatus: 'in_progress' });
    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('an all-done parent already done stays put — no move, no emit', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done']);
    await setStatus(story.id, 'done');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toEqual({ outcome: 'already_there', parentId: story.id, toStatus: 'done' });
    expect(sent).toHaveLength(0);
  });

  it('a backward move lands WITHOUT a workflow edge, and still writes a revision + emits', async () => {
    // The whole reason the backward arm is a `{ system: true }` set: the default
    // workflow (restricted mode) has no `done → todo` row, and adding one would
    // make it a user-draggable board edge. The emit is what carries the recompute
    // to the grandparent, so a system set that emitted nothing would strand it.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['todo']);
    await setStatus(story.id, 'done');

    expect(await workflowsService.canTransition(fx.projectId, 'done', 'todo', fx.workspaceId)).toBe(
      false,
    );

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'rolled_back', toStatus: 'todo' });
    expect(await statusOf(story.id)).toBe('todo');

    const revs = await adminDb.workItemRevision.findMany({
      where: { workItemId: story.id },
      orderBy: { changedAt: 'desc' },
    });
    expect((revs[0]!.diff as Record<string, unknown>)['status']).toEqual({
      from: 'done',
      to: 'todo',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data).toMatchObject({
      workItemId: story.id,
      fromStatusKey: 'done',
      toStatusKey: 'todo',
    });
  });

  it('already in the target status is a no-op that emits nothing (recursion terminates)', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_progress']);
    await setStatus(story.id, 'in_progress');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);
    expect(res).toMatchObject({ outcome: 'already_there', parentId: story.id });
    expect(sent).toHaveLength(0);
  });
});

describe('gates and no-ops', () => {
  it('a top-level item with no parent is a clean no-op', async () => {
    const fx = await makeWorkItemFixture();
    const orphan = await createTestWorkItem(fx, { kind: 'story', title: 'Top level' });
    await setStatus(orphan.id, 'in_progress');

    expect(await parentStatusRollupService.rollUpForChild(orphan.id, fx.workspaceId)).toEqual({
      outcome: 'no_parent',
    });
    expect(sent).toHaveLength(0);
  });

  it('the toggle OFF suppresses the rollup entirely', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done']);
    await setStatus(story.id, 'in_progress');
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { autoRollupParentStatus: false },
    });

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);
    expect(res).toEqual({ outcome: 'toggle_off', parentId: story.id });
    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('the DOWNWARD toggle does not suppress the upward rollup', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done']);
    await setStatus(story.id, 'in_progress');
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { autoCompleteChildrenOnParentDone: false },
    });

    expect(
      await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId),
    ).toMatchObject({
      outcome: 'rolled_up',
    });
  });

  it('an ILLEGAL move is a logged no-op, never a throw', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done']);
    await setStatus(story.id, 'in_progress');
    // Remove the very edge MOTIR-1625 added, leaving the done rung unreachable
    // from in_progress — the shape a team with a custom graph can produce. ⚠️ The
    // review edge goes with it (MOTIR-2901): the forward arm now WALKS the ladder,
    // so leaving `in_progress → in_review` in place would give it the path
    // `in_progress → in_review → done` and this would no longer be an illegal
    // move at all. ⚠️ And the `implemented` edge goes with THEM (MOTIR-3229): the
    // ladder gained a fifth rung, so `in_progress → implemented → done` is a
    // fourth path this fixture has to cut. What the test asserts is unchanged —
    // a graph with no PATH to the wanted rung is a logged no-op — only the
    // fixture has to cut every path rather than one edge, and there is now one
    // more of them.
    const statuses = await adminDb.workflowStatus.findMany({ where: { projectId: fx.projectId } });
    const idOf = (k: string) => statuses.find((s) => s.key === k)!.id;
    await adminDb.workflowTransition.deleteMany({
      where: {
        projectId: fx.projectId,
        fromStatusId: idOf('in_progress'),
        toStatusId: { in: [idOf('done'), idOf('in_review'), idOf('implemented')] },
      },
    });

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'illegal_transition', toStatus: 'done' });
    expect(await statusOf(story.id)).toBe('in_progress'); // untouched
    expect(sent).toHaveLength(0);
  });

  it('a container with an OPEN linked pull request is NOT rolled to Done — the approval-gate guard holds it, logged as `approval_pending` (MOTIR-5526)', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done']);
    await setStatus(story.id, 'in_review');
    // A parent run's pull request, linked to the STORY and still open: with it
    // open, Done is the merge's to write (ADR §6d AMENDMENT, rule 2b), so the
    // derivation must stand down rather than take it — or fail its job.
    const installation = await adminDb.githubInstallation.create({
      data: {
        workspaceId: fx.workspaceId,
        installationId: 'inst-rollup-5526',
        accountLogin: 'acme',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const repo = await adminDb.githubRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        installationId: installation.id,
        repoId: 'repo-rollup-5526',
        owner: 'acme',
        name: 'web',
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    const pr = await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number: 11,
        title: 'parent run',
        state: 'open',
        headRef: 'parent/story',
        baseRef: 'main',
        provider: 'github',
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: story.id,
        githubPullRequestId: pr.id,
        repoId: repo.id,
      },
    });

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'approval_pending', toStatus: 'done' });
    expect(await statusOf(story.id)).toBe('in_review');
    expect(sent).toHaveLength(0);
  });

  it('WALKS to the highest rung when the direct edge is missing', async () => {
    const fx = await makeWorkItemFixture();
    // A todo parent whose only child jumps straight to review. The in-review rung
    // matches, but `todo → in_review` is not an edge. Without a forward walk the
    // parent would sit in todo FOREVER — no later event changes this aggregate,
    // so it never gets another chance. (MOTIR-1623 surfaced this; it used to land
    // one rung short, at `in_progress`, and wait for a later event that in this
    // shape never comes.) The default workflow declares `todo → in_review` since
    // MOTIR-12202 (a pull request delivering a To Do card), so the graph here is
    // one without it — the shape this test is about — nor its sibling
    // `todo → implemented`, the other stone that edge story added.
    const { story, children } = await storyWithChildren(fx, ['in_review']);
    await cutEdge(fx, 'todo', 'in_review');
    await cutEdge(fx, 'todo', 'implemented');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    // `todo → in_progress → in_review`: both hops are real edges of the project's
    // own graph, and `in_progress` is a rung the ladder could have chosen outright.
    expect(res).toMatchObject({
      outcome: 'rolled_up',
      toStatus: 'in_review',
      via: ['in_progress'],
    });
    expect(await statusOf(story.id)).toBe('in_review');
  });

  it('a todo parent whose children are ALL DONE reaches done — the MOTIR-2901 stranding', async () => {
    // The defect this card exists for. The aggregate is all-done, so `done` is
    // the ONLY matching rung and there is no lower one to fall to; `todo → done`
    // is not an edge and must not become one. The walk crosses the two edges the
    // project already has.
    //
    // And it takes the SHORTEST path, because each hop tries the highest stone
    // first: `todo → in_review` (MOTIR-12202's edge; `todo → done` is illegal),
    // then `in_review → done`. Before MOTIR-12202 the same rule took
    // `todo → in_progress → done` — a rung is a stepping stone only when the graph
    // makes it one, and the graph now offers the higher one.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done', 'done']);

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toMatchObject({
      outcome: 'rolled_up',
      toStatus: 'done',
      via: ['in_review'],
    });
    expect(await statusOf(story.id)).toBe('done');
    // ONE event for the NET move — a watcher is told once about one derivation.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data).toMatchObject({ fromStatusKey: 'todo', toStatusKey: 'done' });
  });

  it('a BLOCKED parent reaches done the same way — blocked is a todo-category start', async () => {
    // The mirror shape: `blocked` ranks with `todo`, so the same all-done
    // aggregate is a forward move from there too, and `blocked → done` is no more
    // an edge than `todo → done` is.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done']);
    await setStatus(story.id, 'blocked');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'rolled_up', toStatus: 'done' });
    expect(await statusOf(story.id)).toBe('done');
  });

  it('the walk stands ONLY on ladder rungs — a custom status is never a stepping stone', async () => {
    // The containment property that makes the walk safe: every status it stands
    // on is one the derivation could have set outright for some child set. A
    // project's own extra status is not, so it is never used as a bridge — even
    // when it is the only way through.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done']);
    const statuses = await adminDb.workflowStatus.findMany({ where: { projectId: fx.projectId } });
    const idOf = (k: string) => statuses.find((s) => s.key === k)!.id;
    // Cut every ladder path out of `todo`, and offer a custom one instead.
    await adminDb.workflowTransition.deleteMany({
      where: { projectId: fx.projectId, fromStatusId: idOf('todo') },
    });
    const bridge = await adminDb.workflowStatus.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'bridge',
        label: 'Bridge',
        category: 'in_progress',
        position: 'z3',
      },
    });
    await adminDb.workflowTransition.createMany({
      data: [
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          fromStatusId: idOf('todo'),
          toStatusId: bridge.id,
        },
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          fromStatusId: bridge.id,
          toStatusId: idOf('done'),
        },
      ],
    });

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'illegal_transition', toStatus: 'done' });
    expect(await statusOf(story.id)).toBe('todo');
    expect(sent).toHaveLength(0);
  });

  it('the walk stops where the graph does — a partial advance, not a refusal', async () => {
    // `todo → in_progress` is legal and nothing above it is. The parent advances
    // as far as the graph allows rather than not at all, which is the same
    // conservative reading the single-hop fallback had.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done']);
    const statuses = await adminDb.workflowStatus.findMany({ where: { projectId: fx.projectId } });
    const idOf = (k: string) => statuses.find((s) => s.key === k)!.id;
    await adminDb.workflowTransition.deleteMany({
      where: { projectId: fx.projectId, fromStatusId: idOf('in_progress') },
    });
    // …and MOTIR-12202's two edges out of `todo`, which are paths above it too.
    await cutEdge(fx, 'todo', 'in_review');
    await cutEdge(fx, 'todo', 'implemented');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toEqual({ outcome: 'rolled_up', parentId: story.id, toStatus: 'in_progress' });
    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('the forward FALLBACK stops at the parent itself — already_there, not illegal', async () => {
    // The top rung is illegal and the next matching one is where the parent
    // already stands. That is a no-op, not a refusal, and reporting it as
    // `illegal_transition` would put a false negative in the run log.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_review', 'done']);
    await setStatus(story.id, 'in_progress');
    // ⚠️ `in_progress → implemented` goes too (MOTIR-3229). The fifth rung is a
    // legal stepping stone at or below the in-review target, so leaving it in
    // place hands the walk `in_progress → implemented → in_review` and this stops
    // being a fallback case at all. Same fixture obligation as the illegal-move
    // test above: cut every PATH, not one edge.
    const statuses = await adminDb.workflowStatus.findMany({ where: { projectId: fx.projectId } });
    const idOf = (k: string) => statuses.find((s) => s.key === k)!.id;
    await adminDb.workflowTransition.deleteMany({
      where: {
        projectId: fx.projectId,
        fromStatusId: idOf('in_progress'),
        toStatusId: { in: [idOf('in_review'), idOf('implemented')] },
      },
    });

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toEqual({ outcome: 'already_there', parentId: story.id, toStatus: 'in_progress' });
    expect(await statusOf(story.id)).toBe('in_progress');
    expect(sent).toHaveLength(0);
  });

  it('the forward FALLBACK never turns into a backward move', async () => {
    // A parent parked in a CUSTOM in-progress status: the in-review rung is
    // illegal from there, and the next matching rung (`in_progress`) ranks LEVEL
    // with where it stands. The fallback must end, not quietly become a system
    // set — the recompute already decided the direction from the highest rung.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_review', 'done']);
    const parked = await adminDb.workflowStatus.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'parked',
        label: 'Parked',
        category: 'in_progress',
        position: 'z2',
      },
    });
    await setStatus(story.id, parked.key);

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(res).toMatchObject({ outcome: 'illegal_transition', toStatus: 'in_review' });
    expect(await statusOf(story.id)).toBe('parked');
    expect(sent).toHaveLength(0);
  });

  it('reports the rung it WANTED when no rung is legal from here', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done']);
    // A custom status with no outgoing edges — every rung is unreachable.
    const frozen = await adminDb.workflowStatus.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'frozen',
        label: 'Frozen',
        category: 'todo',
        position: 'z1',
      },
    });
    await setStatus(story.id, frozen.key);

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    // Named, so the log says which move the workflow refused.
    expect(res).toMatchObject({ outcome: 'illegal_transition', toStatus: 'done' });
    expect(await statusOf(story.id)).toBe('frozen');
    expect(sent).toHaveLength(0);
  });

  it('a parent whose only child is TRIAGED matches no rung either', async () => {
    // `no_rung` used to also cover "every child is still todo". The fourth rung
    // claims that case now (see its own block above), so the EMPTY aggregate is
    // the only shape left here — and a triaged child leaves the aggregate for the
    // same reason an archived one does (`findChildren` excludes both).
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['todo']);
    await setStatus(story.id, 'done');
    await adminDb.workItem.update({
      where: { id: children[0]!.id },
      data: { triagedAt: new Date() },
    });

    expect(await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId)).toEqual(
      {
        outcome: 'no_rung',
        parentId: story.id,
      },
    );
    expect(await statusOf(story.id)).toBe('done');
    expect(sent).toHaveLength(0);
  });
});

describe('the emitted event — what carries derivation to the next level', () => {
  it('emits work-item/transitioned for the PARENT, attributed to the workspace owner', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_progress']);

    await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.name).toBe('work-item/transitioned');
    expect(sent[0]!.data).toMatchObject({
      workspaceId: fx.workspaceId,
      workItemId: story.id,
      actorId: fx.ownerId,
      fromStatusKey: 'todo',
      toStatusKey: 'in_progress',
    });
    expect(sent[0]!.data['revisionId']).toEqual(expect.any(String));
  });

  it('records the move as an ordinary status revision on the parent', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['in_progress']);

    await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    const revs = await adminDb.workItemRevision.findMany({
      where: { workItemId: story.id },
      orderBy: { changedAt: 'desc' },
    });
    expect(revs[0]!.changeKind).toBe('updated');
    expect((revs[0]!.diff as Record<string, unknown>)['status']).toEqual({
      from: 'todo',
      to: 'in_progress',
    });
    // Attributed to the owner, so the activity feed reads as a real actor.
    expect(revs[0]!.changedById).toBe(fx.ownerId);
  });
});

describe('a RENAMED workflow still derives', () => {
  it('resolves each rung by CATEGORY when the canonical key is absent', async () => {
    const fx = await makeWorkItemFixture();
    // Rename `in_progress` → `doing`: the canonical key no longer exists, so the
    // resolver must fall back to the first status of the in_progress category.
    await adminDb.workflowStatus.updateMany({
      where: { projectId: fx.projectId, key: 'in_progress' },
      data: { key: 'doing' },
    });
    const { story, children } = await storyWithChildren(fx, ['doing']);

    // Sanity: the shared resolver reports the renamed key.
    expect(
      await workflowsService.resolveStatusKey(fx.projectId, fx.workspaceId, {
        key: 'in_progress',
        category: 'in_progress',
      }),
    ).toBe('doing');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);
    expect(res).toMatchObject({ outcome: 'rolled_up', toStatus: 'doing' });
    expect(await statusOf(story.id)).toBe('doing');
  });
});

describe('defensive error routing — the job must never fail behind a user transition', () => {
  // These arms guard a RACE: the target status is resolved (and its legality
  // checked) before `applyStatusTransition` runs, so a status deleted or a
  // permission revoked in that window surfaces from the write. They are
  // exercised by forcing the throw, because the point under test is the ROUTING
  // — a typed no-op instead of a propagated error — not the race itself.

  async function forceWriteError(err: Error) {
    const fx = await makeWorkItemFixture();
    const { children } = await storyWithChildren(fx, ['in_progress']);
    vi.spyOn(workItemsService, 'applyStatusTransition').mockRejectedValue(err);
    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);
    vi.restoreAllMocks();
    return res;
  }

  it('an UnknownStatusError from the write reads as no_matching_status', async () => {
    expect(await forceWriteError(new UnknownStatusError('ghost'))).toMatchObject({
      outcome: 'no_matching_status',
    });
  });

  it('a ProjectAccessDeniedError reads as access_denied', async () => {
    expect(await forceWriteError(new ProjectAccessDeniedError('p1', 'edit'))).toMatchObject({
      outcome: 'access_denied',
    });
  });

  it('a ProjectNotFoundError reads as access_denied too (no existence leak)', async () => {
    expect(await forceWriteError(new ProjectNotFoundError('p1'))).toMatchObject({
      outcome: 'access_denied',
    });
  });

  it('an IllegalTransitionError from the write is still absorbed', async () => {
    // Unreachable in practice — legality is pre-checked in the SAME transaction
    // — but absorbed rather than thrown, so a future refactor that drops the
    // pre-check degrades to a no-op instead of a red job.
    expect(await forceWriteError(new IllegalTransitionError('todo', 'done'))).toMatchObject({
      outcome: 'illegal_transition',
    });
  });

  it('an UNEXPECTED error still propagates — a real fault is not swallowed', async () => {
    await expect(forceWriteError(new Error('disk on fire'))).rejects.toThrow('disk on fire');
  });
});

describe('phase 1 binds the WORKSPACE, not the system flag (MOTIR-2880)', () => {
  // ⚠️ REPRODUCE-BEFORE-FIX, and the reproduction needs the non-bypass role.
  //
  // Phase 1 used to run under `withSystemContext`, which binds `app.system_admin`
  // and nothing else. `work_item` carries ONE permissive policy,
  // `work_item_active_workspace`, keyed purely on `app.workspace_id` — no arm reads
  // the system flag — so under `motir_app` the very first statement
  // (`findById(childId)`) returned NULL, `resolved` was null, and EVERY rollup
  // answered `{ outcome: 'no_parent' }`. RLS does not refuse a SELECT, it empties
  // it, so nothing raised and nothing was logged: a parent whose children all
  // finished simply never moved.
  //
  // Since MOTIR-2734 retired `TEST_DB_APP_ROLE`, `@/lib/db` is always `motir_app`,
  // so both cases bite on every run. Under the old bypass-role default they passed
  // trivially (RLS is inert); the first was red on `main` before MOTIR-2880, and the
  // second is the one that PINS the binding — a system context would have returned
  // the parent whatever workspace was named.

  // The preceding block's last case leaves a `vi.spyOn` throwing `disk on fire`
  // in place; these cases exercise the REAL write path.
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rolls the parent up under the non-bypass role — the read is workspace-bound', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done']);
    await setStatus(story.id, 'in_progress'); // the done rung's legal starting point

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    // On `main` before MOTIR-2880 this was `{ outcome: 'no_parent' }`.
    expect(res).toMatchObject({ outcome: 'rolled_up', parentId: story.id, toStatus: 'done' });
    expect(await statusOf(story.id)).toBe('done');
  });

  it('a FOREIGN workspaceId resolves nothing — the binding is real, not decorative', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ identifier: 'OTHR' });
    const { story, children } = await storyWithChildren(fx, ['done']);
    await setStatus(story.id, 'in_progress');

    const res = await parentStatusRollupService.rollUpForChild(children[0]!.id, other.workspaceId);

    // This is the difference between a bound read and a system context that would
    // have crossed the tenant boundary silently.
    expect(res).toEqual({ outcome: 'no_parent' });
    expect(await statusOf(story.id)).not.toBe('done');
  });
});

// ── The backward arm stands down for a NEWER user write (Bug MOTIR-2965) ──
//
// A backward set needs no legal edge, which is what lets it overwrite a status a
// person just set — and the cost lands on their NEXT click as a bare 422. The arm
// therefore dates its claim: a parent status written AFTER the newest edit to the
// child set was written by somebody who already knew about these children.
//
// The comparison reads the parent's last STATUS REVISION, so these tests move the
// parent through `workItemsService.updateStatus` (which records one) rather than
// the `setStatus` helper (a direct row write that records nothing) wherever the
// ordering is the point.
describe('a backward set vs a newer user write', () => {
  it('DECLINES the backward set, and says so — `stale_backward`', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['todo']);

    // The user starts the story AFTER its only child was created. Rung 4 still
    // reads `todo` correctly — the decline is about the claim's date, not its
    // accuracy.
    await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
    // The user's own move emitted; the assertion below is about what the ROLLUP
    // announces.
    sent.length = 0;

    const out = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(out).toEqual({ outcome: 'stale_backward', parentId: story.id, toStatus: 'todo' });
    expect(await statusOf(story.id)).toBe('in_progress');
    // Nothing moved, so nothing is announced — the same rule every other no-op
    // outcome follows, and what keeps the recursion's fixed point intact.
    expect(sent).toHaveLength(0);
  });

  it('and the user can then reach Done — the 422 the bug is named for is gone', async () => {
    // `todo → done` is not an edge, so a parent knocked back to `todo` makes the
    // NEXT click impossible. This is that click, taken.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['todo']);
    await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
    await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    await expect(workItemsService.updateStatus(story.id, 'done', fx.ctx)).resolves.toBeDefined();
    expect(await statusOf(story.id)).toBe('done');
    // AC 3: it was reached over an edge the project already had, not a new one.
    expect(await workflowsService.canTransition(fx.projectId, 'todo', 'done', fx.workspaceId)).toBe(
      false,
    );
  });

  it('STILL comes back when the child-set edit is the NEWER of the two', async () => {
    // The other direction, and the one that must not regress: the ADR's decided
    // semantics are untouched whenever the derivation has something to tell.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['done']);
    await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(story.id, 'in_review', fx.ctx);
    await workItemsService.updateStatus(story.id, 'done', fx.ctx);
    sent.length = 0;

    // NOW the child reopens — after the parent's last status write.
    await workItemsService.updateStatus(children[0]!.id, 'in_progress', fx.ctx);
    const out = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(out).toEqual({
      outcome: 'rolled_back',
      parentId: story.id,
      toStatus: 'in_progress',
    });
    expect(await statusOf(story.id)).toBe('in_progress');
  });

  it('a parent that has never moved has no date to beat — the shipped behaviour stands', async () => {
    // No status revision at all (the row was written directly, as an import or a
    // fixture does). With no evidence on one side the comparison must not
    // suppress: `laterOf`/the null guard leave the backward set exactly as it
    // shipped.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['todo']);
    await setStatus(story.id, 'done');

    const out = await parentStatusRollupService.rollUpForChild(children[0]!.id, fx.workspaceId);

    expect(out).toEqual({ outcome: 'rolled_back', parentId: story.id, toStatus: 'todo' });
    expect(await statusOf(story.id)).toBe('todo');
  });

  it('a REMOVED row still dates its own edit — the trigger carries `occurredAt`', async () => {
    // The case the aggregate structurally cannot see. The started child LEAVES
    // the set, so every row left in it is older than the parent's status; only
    // the trigger's own instant separates this from a stale claim.
    const fx = await makeWorkItemFixture();
    const { story, children } = await storyWithChildren(fx, ['todo', 'todo']);
    await workItemsService.updateStatus(children[0]!.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);

    // The only started child is archived out of the aggregate.
    await adminDb.workItem.update({
      where: { id: children[0]!.id },
      data: { archivedAt: new Date() },
    });

    // Without the trigger the surviving `todo` child is older than the parent's
    // status, so the claim reads as stale and the parent is stranded.
    const stranded = await parentStatusRollupService.recomputeParent(story.id, fx.workspaceId);
    expect(stranded).toEqual({
      outcome: 'stale_backward',
      parentId: story.id,
      toStatus: 'todo',
    });

    const out = await parentStatusRollupService.recomputeParent(story.id, fx.workspaceId, {
      occurredAt: new Date(),
    });

    expect(out).toEqual({ outcome: 'rolled_back', parentId: story.id, toStatus: 'todo' });
    expect(await statusOf(story.id)).toBe('todo');
  });
});

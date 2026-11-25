import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workflowsService } from '@/lib/services/workflowsService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { DEFAULT_STATUSES, DEFAULT_TRANSITIONS } from '@/lib/workflows/defaultWorkflow';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Default-workflow seed (Story 2.2 · Subtask 2.2.2). Real Postgres — runs in
// CI. Proves the typed default constant, the seed wired into createProject
// (same transaction → atomic), the display ordering, the finding-#21 terminal
// set, and the one-off backfill.

// ⚠️ `planning` sits between `in_progress` and `in_review` (MOTIR-2425) — an
// in-progress-category state on the PLANNING axis rather than the
// implementation one. The counts below moved with it; each is stated as a
// number on purpose, so adding a status is a deliberate edit here rather than a
// surprise in CI.
const DISPLAY_ORDER = [
  'todo',
  'blocked',
  'in_progress',
  // MOTIR-3003 — built, pull request open, CI not yet green. Before `planning`:
  // slot 4 is the last board column a laptop shows in full (design/boards).
  'implemented',
  'planning',
  // MOTIR-12174 — planned, stale, not started: a corrected decision it rests on
  // made its description out of date. In the in_progress category so neither
  // claim door takes it; slot 6, beside Planning (design/boards/
  // board--to-plan-status.mock.html, panel 1).
  'to_plan',
  'in_review',
  // MOTIR-5139 — a person's YES, between CI's verdict and the merge. In the
  // in_progress category, because only `done` and `cancelled` are terminal: an
  // approved card is still OPEN in every count, does not complete its parent,
  // and does not unblock its dependents. AFTER `implemented`, so the slot-4
  // invariant above survives (design/boards/approved-column.mock.html, panel 1).
  'approved',
  'done',
  'cancelled',
];

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeWorkspaceAndUser(): Promise<{ userId: string; workspaceId: string }> {
  const user = await usersService.createUser({
    email: 'wf-default@example.com',
    password: 'hunter2hunter2',
    name: 'WF Default',
  });
  const ws = await workspacesService.createWorkspace({
    name: 'WF Default WS',
    ownerUserId: user.id,
  });
  return { userId: user.id, workspaceId: ws.workspace.id };
}

describe('defaultWorkflow constant', () => {
  it('defines ten statuses in display order, exactly one initial (todo)', () => {
    expect(DEFAULT_STATUSES.map((s) => s.key)).toEqual(DISPLAY_ORDER);
    expect(DEFAULT_STATUSES.filter((s) => s.isInitial).map((s) => s.key)).toEqual(['todo']);
  });

  it('assigns strictly-ascending fractional-index positions (declared order === sorted order)', () => {
    const positions = DEFAULT_STATUSES.map((s) => s.position);
    expect(positions).toEqual([...positions].sort());
    expect(new Set(positions).size).toBe(positions.length); // all distinct
  });

  it('defines forty-eight transitions, each referencing a known status key (finding #45 + 7.8.11 + MOTIR-1625 + MOTIR-2425 + MOTIR-3003 + MOTIR-5139 + MOTIR-5630 + MOTIR-5804 + MOTIR-5643 + MOTIR-12174 + MOTIR-12202)', () => {
    // 5804 is net ZERO (one edge out, one in) and 5643 adds five, so the sum was
    // 41 whichever merged first — the arithmetic MOTIR-5643's card asked for.
    // MOTIR-12174's `to_plan` adds five more (two in, three out): 46.
    // MOTIR-12202's two edges out of `todo` for a delivering pull request: 48.
    expect(DEFAULT_TRANSITIONS).toHaveLength(48);
    const keys = new Set(DEFAULT_STATUSES.map((s) => s.key));
    for (const [from, to] of DEFAULT_TRANSITIONS) {
      expect(keys.has(from)).toBe(true);
      expect(keys.has(to)).toBe(true);
    }
    const pairs = DEFAULT_TRANSITIONS.map(([f, t]) => `${f}->${t}`);
    expect(new Set(pairs).size).toBe(pairs.length); // no duplicate edges
    // The merge-queue ejection's edges, by key (`approval-gates.md` §4 THIRD
    // AMENDMENT, decision 7, as the FOURTH AMENDMENT's point 6 amends it —
    // MOTIR-5804): `approved → in_review` is declared, `implemented → approved` is
    // ABSENT, and the other two stay.
    expect(pairs).toEqual(
      expect.arrayContaining([
        'approved->in_review',
        'approved->implemented',
        'in_review->implemented',
      ]),
    );
    expect(pairs).not.toContain('implemented->approved');
    // MOTIR-5643 — the planning PARKING edges, by key
    // (`agent-authored-plans.md` AMENDMENT 16, D10). Four in, one out.
    expect(pairs).toEqual(
      expect.arrayContaining([
        'blocked->planning',
        'implemented->planning',
        'in_review->planning',
        'approved->planning',
        'planning->blocked',
      ]),
    );
    // …and NOTHING from a terminal status (D2). We plan forward.
    expect(pairs).not.toContain('done->planning');
    expect(pairs).not.toContain('cancelled->planning');
  });
});

describe('createProject seeds the default workflow (same transaction)', () => {
  it('a fresh project ends with 10 statuses + 48 transitions; todo is the initial status', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Seeded',
    });

    const [statusCount, transitionCount] = await Promise.all([
      adminDb.workflowStatus.count({ where: { projectId: project.id } }),
      adminDb.workflowTransition.count({ where: { projectId: project.id } }),
    ]);
    expect(statusCount).toBe(10);
    expect(transitionCount).toBe(48);

    const initials = await adminDb.workflowStatus.findMany({
      where: { projectId: project.id, isInitial: true },
    });
    expect(initials.map((s) => s.key)).toEqual(['todo']);

    // Every status + transition carries the project's workspaceId (tenant tag).
    const statuses = await adminDb.workflowStatus.findMany({ where: { projectId: project.id } });
    expect(statuses.every((s) => s.workspaceId === workspaceId)).toBe(true);
  });

  it('lists the ten statuses in display order through getWorkflow (workspace-scoped read)', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Ordered',
    });

    const wf = await workflowsService.getWorkflow(project.id, workspaceId);
    expect(wf.statuses.map((s) => s.key)).toEqual(DISPLAY_ORDER);
    expect(wf.transitions).toHaveLength(48);
    expect(wf.policyMode).toBe('restricted');
  });

  it('review is OPTIONAL: in_progress reaches done directly AND via in_review (MOTIR-1625)', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Optional Review',
    });
    const can = (from: string, to: string) =>
      workflowsService.canTransition(project.id, from, to, workspaceId);

    // The new direct edge — under the default `restricted` policy, so this is a
    // real transition row, not a policy escape.
    expect(await can('in_progress', 'done')).toBe(true);
    // The review path still works — the edge is additive, not a replacement.
    expect(await can('in_progress', 'in_review')).toBe(true);
    expect(await can('in_review', 'done')).toBe(true);
    // And it does NOT open the whole graph: skipping ahead from todo is still
    // illegal, which is what keeps the workflow meaningful.
    expect(await can('todo', 'done')).toBe(false);
    expect(await can('blocked', 'done')).toBe(false);
  });

  it('getTerminalStatusKeys returns {done, cancelled} out of the box (finding #21)', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Terminal',
    });

    const terminal = await workflowsService.getTerminalStatusKeys(project.id, workspaceId);
    expect(terminal).toEqual(new Set(['done', 'cancelled']));
  });
});

describe('seed atomicity + the one-initial-per-project constraint', () => {
  it('re-seeding the same project rejects and rolls back (no partial rows persist)', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Reseed',
    });

    // A second seed collides on @@unique([projectId, key]) for the first status
    // ('todo'); the withWorkspaceContext transaction rolls back wholesale.
    await expect(
      withWorkspaceContext({ userId, workspaceId }, (tx) =>
        workflowsService.seedDefaultWorkflow(project.id, workspaceId, tx),
      ),
    ).rejects.toThrow();

    const workflowStatusCount = await adminDb.workflowStatus.count({
      where: { projectId: project.id },
    });
    expect(workflowStatusCount).toBe(10);
    const workflowTransitionCount = await adminDb.workflowTransition.count({
      where: { projectId: project.id },
    });
    expect(workflowTransitionCount).toBe(48);
  });

  it('a second initial status in the same project violates the partial-unique index (2.2.1)', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'SecondInitial',
    });

    await expect(
      adminDb.workflowStatus.create({
        data: {
          workspaceId,
          projectId: project.id,
          key: 'todo_again',
          label: 'Todo Again',
          category: 'todo',
          position: 'z9',
          isInitial: true,
        },
      }),
    ).rejects.toThrow();
  });
});

describe('backfillDefaultWorkflow (one-off, idempotent)', () => {
  it('seeds a project that has no workflow, then no-ops on a second call', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    // A project row WITHOUT a workflow (bypasses createProject's seed) — mimics
    // a row predating this Story.
    const bare = await adminDb.project.create({
      data: { workspaceId, name: 'Bare', slug: 'bare-proj', identifier: 'BARE' },
    });

    const workflowStatusCount = await adminDb.workflowStatus.count({
      where: { projectId: bare.id },
    });
    expect(workflowStatusCount).toBe(0);

    const seeded = await workflowsService.backfillDefaultWorkflow(bare.id, userId);
    expect(seeded).toBe(true);
    const workflowStatusCount2 = await adminDb.workflowStatus.count({
      where: { projectId: bare.id },
    });
    expect(workflowStatusCount2).toBe(10);
    const workflowTransitionCount = await adminDb.workflowTransition.count({
      where: { projectId: bare.id },
    });
    expect(workflowTransitionCount).toBe(48);

    // Idempotent — already has a workflow, so the second call is a no-op.
    const again = await workflowsService.backfillDefaultWorkflow(bare.id, userId);
    expect(again).toBe(false);
    const workflowStatusCount3 = await adminDb.workflowStatus.count({
      where: { projectId: bare.id },
    });
    expect(workflowStatusCount3).toBe(10);
  });

  it('throws ProjectNotFoundError for a project that does not exist (2.6.4)', async () => {
    const { userId } = await makeWorkspaceAndUser();
    await expect(
      workflowsService.backfillDefaultWorkflow('does-not-exist', userId),
    ).rejects.toThrow(ProjectNotFoundError);
  });
});

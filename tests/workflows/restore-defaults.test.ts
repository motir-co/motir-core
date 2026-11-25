import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workflowsService } from '@/lib/services/workflowsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Restore default TRANSITIONS — additive merge (Story 2.2 · Subtask 2.2.10).
// Real Postgres. Default statuses are now protected (finding #49) so they can't
// go missing; restore only re-adds missing default transition EDGES. It never
// deletes, never touches statuses, and is idempotent. createTestProject
// auto-seeds the default workflow (6 statuses, 17 transitions, todo initial).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  ownerId: string;
  workspaceId: string;
  projectId: string;
}

async function makeFixture(): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: 'wf-restore@example.com',
    password: 'hunter2hunter2',
    name: 'WF Restore',
  });
  const ws = await workspacesService.createWorkspace({ name: 'WF Restore', ownerUserId: owner.id });
  const project = await createTestProject({ workspaceId: ws.workspace.id, actorUserId: owner.id });
  return { ownerId: owner.id, workspaceId: ws.workspace.id, projectId: project.id };
}

describe('restoreDefaultTransitions — additive merge', () => {
  it('re-adds missing default edges, keeps custom edges, is idempotent', async () => {
    const fx = await makeFixture();

    const statuses = await adminDb.workflowStatus.findMany({ where: { projectId: fx.projectId } });
    const idOf = (k: string) => statuses.find((s) => s.key === k)!.id;

    // Remove three default edges (their endpoints all survive — statuses are
    // protected and never deleted).
    await adminDb.workflowTransition.deleteMany({
      where: {
        projectId: fx.projectId,
        OR: [
          { fromStatusId: idOf('todo'), toStatusId: idOf('in_progress') },
          { fromStatusId: idOf('in_progress'), toStatusId: idOf('in_review') },
          { fromStatusId: idOf('in_review'), toStatusId: idOf('done') },
        ],
      },
    });

    // Add a custom status + a custom edge into it (neither is a default edge,
    // so restore must leave both untouched). createStatus gives it a valid
    // fractional-index position.
    const onHold = await workflowsService.createStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      key: 'on_hold',
      label: 'On Hold',
      category: 'todo',
    });
    await workflowsService.addTransition({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      fromStatusId: idOf('todo'),
      toStatusId: onHold.id,
    });

    const result = await workflowsService.restoreDefaultTransitions({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    expect(result.transitionsAdded).toBe(3);

    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    // Full default graph restored (46, incl. 7.8.11's in_review→blocked,
    // MOTIR-1625's in_progress→done, MOTIR-2425's five planning edges,
    // MOTIR-3003's seven implemented edges, MOTIR-5139's four approved edges,
    // MOTIR-5630's three ejection edges, of which MOTIR-5804 swapped
    // `implemented → approved` for `approved → in_review`, and MOTIR-5643's five
    // parking edges, MOTIR-12174's five to_plan edges and MOTIR-12202's two
    // edges out of todo = 48) + the one custom edge kept = 49.
    expect(wf.transitions).toHaveLength(49);
    // Statuses untouched: 10 defaults + on_hold.
    expect(wf.statuses).toHaveLength(11);
    const has = (from: string, to: string) =>
      wf.transitions.some((t) => t.fromStatusId === idOf(from) && t.toStatusId === idOf(to));
    expect(has('todo', 'in_progress')).toBe(true);
    expect(has('in_progress', 'in_review')).toBe(true);
    expect(has('in_review', 'done')).toBe(true);
    // The custom edge survives.
    expect(wf.transitions.some((t) => t.toStatusId === onHold.id)).toBe(true);

    // Idempotent: a second restore changes nothing.
    const again = await workflowsService.restoreDefaultTransitions({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    expect(again).toEqual({ transitionsAdded: 0 });
    const wf2 = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    expect(wf2.transitions).toHaveLength(49);
  });

  it('is a no-op on a pristine default-seeded project', async () => {
    const fx = await makeFixture();
    const result = await workflowsService.restoreDefaultTransitions({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    expect(result).toEqual({ transitionsAdded: 0 });
  });

  it('is admin-gated: a non-owner member is rejected', async () => {
    const fx = await makeFixture();
    const member = await usersService.createUser({
      email: 'wf-restore-member@example.com',
      password: 'hunter2hunter2',
      name: 'Member',
    });
    await adminDb.workspaceMembership.create({
      data: {
        userId: member.id,
        workspaceId: fx.workspaceId,
        workspaceRole: 'member',
      },
    });
    await expect(
      workflowsService.restoreDefaultTransitions({
        userId: member.id,
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
      }),
    ).rejects.toThrow(PermissionDeniedError);
  });
});

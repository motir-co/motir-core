import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The ONE mock, as in the other internal-route suites: the motir-ai HTTP client
// a job submit would reach. Postgres, the plan lock and the routes are real.
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));

import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { submitJob } from '@/lib/ai/motirAiClient';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PlanRefGraphError } from '@/lib/plans/errors';
import { POST as proposalsPOST } from '@/app/api/internal/ai/plan-proposals/route';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import type { ProjectContext } from '@/lib/projects';

// MOTIR-6051 — a second `modify` of one committed card MERGES into the plan's
// one `modify` (`agent-authored-plans.md` AMENDMENT 18 §2), against real
// Postgres. The pure rule is `tests/plans/mergeModifyPatch.test.ts`; this file
// pins what only the append can show: the gate judging the MERGED patch, the
// revision door, the timeline, the internal route's ids, and the lock under a
// real concurrent pair.

const SERVICE_SECRET = 'core-callback-secret-merge-modify';
const JOB_ID = 'job_merge_modify';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  vi.clearAllMocks();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The target's newest revision id — the anchor a `modify` carries. */
async function latestRevisionId(workItemId: string): Promise<string> {
  const row = await adminDb.workItemRevision.findFirst({
    where: { workItemId },
    orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  if (!row) throw new Error(`no revision for ${workItemId}`);
  return row.id;
}

async function seedItem(
  fx: WorkItemFixture,
  title: string,
  kind: 'epic' | 'story' | 'task' | 'bug' | 'subtask' = 'task',
  parentId?: string,
): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
  return dto.id;
}

async function openPlan(fx: WorkItemFixture): Promise<string> {
  return (await plansService.createPlan(fx.projectId, { title: 'Merging' }, fx.ctx)).id;
}

describe('the gates judge the MERGED patch — the one row approve will apply', () => {
  // A `blocked_by` cycle is judged against the committed edges too. On a
  // `generating` plan it is refused at the append since MOTIR-9267, and a
  // `revision: true` append runs the close's whole gate because no close is
  // coming. Both see the merged row.
  async function cycleThroughMerge(fx: WorkItemFixture, planId: string, revision: boolean) {
    const epic = await seedItem(fx, 'The epic', 'epic');
    const x = await seedItem(fx, 'X', 'story', epic);
    // A proposed task T blocked BY X, and a first modify of X that says nothing
    // about edges — each legal.
    const t = await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'T', kind: 'task' },
          parentRef: epic,
          blockedByRefs: [x],
        },
        { op: 'modify', workItemId: x, patch: { title: 'X renamed' } },
      ],
      fx.ctx,
    );
    if (revision) await plansService.markPlanned(planId, fx.ctx);
    // The second modify of X MERGES an edge X → T into that row: T waits on X
    // and X on T.
    const tRef = `planItem:${t.appendedItemIds[0]}`;
    return () =>
      plansService.addProposals(
        planId,
        [{ op: 'modify', workItemId: x, patch: { blockedByAdd: [tRef] } }],
        fx.ctx,
        { revision },
      );
  }

  it('a generating plan: the merged cycle is refused AT THE APPEND (MOTIR-9267), and the row is left as it was', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);
    const merge = await cycleThroughMerge(fx, planId, false);

    const refusal = await merge().catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(PlanRefGraphError);
    expect((refusal as PlanRefGraphError).reason).toBe('cycle');
    const rows = await adminDb.planItem.findMany({ where: { planId, op: 'modify' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.patch).toEqual({ title: 'X renamed' });
  });

  it('a revision append: the merged cycle is refused AT THE APPEND, and the row is left as it was', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);
    const merge = await cycleThroughMerge(fx, planId, true);

    const refusal = await merge().catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(PlanRefGraphError);
    expect((refusal as PlanRefGraphError).reason).toBe('cycle');
    const row = await adminDb.planItem.findFirstOrThrow({ where: { planId, op: 'modify' } });
    expect(row.patch).toEqual({ title: 'X renamed' });
  });
});

describe('the merge on the plan timeline and on a revision append', () => {
  it('records the merge as an EDIT of the surviving proposal, not as an append', async () => {
    const fx = await makeWorkItemFixture();
    const x = await seedItem(fx, 'X');
    const planId = await openPlan(fx);
    const first = await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: x, patch: { title: 'A' } }],
      fx.ctx,
    );
    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: x, patch: { priority: 'high' } }],
      fx.ctx,
    );

    const trail = await adminDb.planRevision.findMany({
      where: { planId },
      orderBy: { changedAt: 'asc' },
    });
    const kinds = trail.map((r) => r.changeKind);
    expect(kinds.filter((k) => k === 'appended')).toHaveLength(1);
    const edit = trail.find((r) => r.changeKind === 'edited')!;
    expect(edit.planItemId).toBe(first.appendedItemIds[0]);
    expect(edit.diff).toMatchObject({ fields: ['patch'], merged: true });
  });

  it('merges on a `revision: true` append to a planned plan, keeping the earlier baseRevision', async () => {
    const fx = await makeWorkItemFixture();
    const x = await seedItem(fx, 'X');
    // Real revision ids — an anchor that names no revision of its target is
    // refused at the append (MOTIR-9603).
    const revEarly = await latestRevisionId(x);
    const planId = await openPlan(fx);
    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: x, patch: { title: 'A' }, baseRevision: revEarly }],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);
    await workItemsService.updateWorkItem(x, { descriptionMd: 'Edited since' }, fx.ctx);
    const revLate = await latestRevisionId(x);
    expect(revLate).not.toBe(revEarly);

    const revised = await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: x, patch: { priority: 'high' }, baseRevision: revLate }],
      fx.ctx,
      { revision: true },
    );
    const rows = await adminDb.planItem.findMany({ where: { planId } });
    expect(rows).toHaveLength(1);
    expect(revised.appendedItemIds).toEqual([rows[0]!.id]);
    expect(rows[0]!.patch).toEqual({ title: 'A', priority: 'high' });
    expect(rows[0]!.baseRevision).toBe(revEarly);
  });
});

describe('POST /api/internal/ai/plan-proposals — the merged id comes back', () => {
  function projectCtx(fx: WorkItemFixture): ProjectContext {
    return {
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      project: fx.project,
    };
  }

  function append(fx: WorkItemFixture, body: unknown): Promise<Response> {
    const req = new Request('http://core/api/internal/ai/plan-proposals', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    req.headers.set('authorization', `Bearer ${SERVICE_SECRET}`);
    req.headers.set('content-type', 'application/json');
    req.headers.set(
      'x-motir-job-token',
      mintJobToken({
        userId: fx.ctx.userId,
        workspaceId: fx.ctx.workspaceId,
        projectId: fx.projectId,
      }),
    );
    return proposalsPOST(req);
  }

  it('returns the SURVIVING row’s id at the merged position', async () => {
    const fx = await makeWorkItemFixture();
    const x = await seedItem(fx, 'X');
    vi.mocked(submitJob).mockResolvedValue({ jobId: JOB_ID });
    await aiPlanEditsService.submitAugment('re-plan X', projectCtx(fx));

    const first = await append(fx, {
      jobId: JOB_ID,
      proposals: [{ op: 'modify', workItemId: x, patch: { title: 'A' } }],
    });
    expect(first.status).toBe(200);
    const firstIds = ((await first.json()) as { planItemIds: string[] }).planItemIds;

    const second = await append(fx, {
      jobId: JOB_ID,
      proposals: [
        { op: 'add', proposedFields: { title: 'New card', kind: 'task' } },
        { op: 'modify', workItemId: x, patch: { priority: 'high' } },
      ],
    });
    expect(second.status).toBe(200);
    const ids = ((await second.json()) as { planItemIds: string[] }).planItemIds;
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(firstIds[0]);
    expect(ids[0]).not.toBe(firstIds[0]);
  });
});

describe('REAL concurrency — two appends modifying one card at once', () => {
  it('serialises on the plan lock: ONE row carrying BOTH patches, never a lost update', async () => {
    const fx = await makeWorkItemFixture();
    const x = await seedItem(fx, 'X');
    const b1 = await seedItem(fx, 'Blocker one');
    const b2 = await seedItem(fx, 'Blocker two');
    const planId = await openPlan(fx);

    const results = await Promise.allSettled([
      plansService.addProposals(
        planId,
        [{ op: 'modify', workItemId: x, patch: { title: 'From A', blockedByAdd: [b1] } }],
        fx.ctx,
      ),
      plansService.addProposals(
        planId,
        [{ op: 'modify', workItemId: x, patch: { priority: 'high', blockedByAdd: [b2] } }],
        fx.ctx,
      ),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);

    const rows = await adminDb.planItem.findMany({ where: { planId } });
    expect(rows).toHaveLength(1);
    const patch = rows[0]!.patch as { title: string; priority: string; blockedByAdd: string[] };
    // Either serialisation order is legitimate; both patches must be present.
    expect(patch.title).toBe('From A');
    expect(patch.priority).toBe('high');
    expect([...patch.blockedByAdd].sort()).toEqual([b1, b2].sort());
  });
});

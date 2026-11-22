import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { runDiscrepancyReadService } from '@/lib/services/runDiscrepancyReadService';
import { runDiscrepancyService } from '@/lib/services/runDiscrepancyService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import { linkLegacyDiscrepancyComment } from './helpers/legacyDiscrepancyComment';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from './helpers/workspaceRoleFixtures';

// THE READ behind the work item page's Run discrepancy section (Task MOTIR-11996), on a real
// Postgres: a card's records newest first, each with its points and decisions in order, who
// recorded it and the run it was part of — read from the record ONLY, so a record whose
// comment (from before MOTIR-11996) was deleted still reads in full. Gated on `project:browse`.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const POINT = { planAsked: 'ASKED', built: 'BUILT', why: 'WHY' };
const DECISION = { planSaid: 'nothing', chose: 'CHOSE', why: 'DWHY', alternatives: 'ALT' };

async function card(fx: WorkItemFixture, title = 'A card') {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return { id: item.id, key: item.identifier };
}

async function openLeg(fx: WorkItemFixture, key: string): Promise<string> {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      cards: [{ key, disposition: 'queued' as const }],
    },
    fx.ctx,
  );
  await dispatchRunService.appendEvents(
    run.id,
    [{ kind: 'card_claimed' as const, workItemKey: key, disposition: 'running' as const }],
    fx.ctx,
  );
  return run.id;
}

async function memberWithRole(
  fx: WorkItemFixture,
  name: string,
  permissions: readonly string[],
): Promise<ServiceContext> {
  const user = await createTestUser({ name });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  const role = await createCustomRoleAs({
    projectId: fx.projectId,
    ctx: fx.ctx,
    name,
    permissions: [...permissions],
  });
  const key = fx.projectIdentifier;
  await addToProjectAs({
    key,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: 'member',
  });
  await setProjectRoleAs({
    key,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: role.id,
  });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

describe('runDiscrepancyReadService.listForWorkItem', () => {
  it('a card with no record reads []', async () => {
    const fx = await makeWorkItemFixture();
    const c = await card(fx);
    expect(await runDiscrepancyReadService.listForWorkItem(c.id, fx.ctx)).toEqual([]);
  });

  it('reads every record newest first, its entries in order, the recorder and the run', async () => {
    const fx = await makeWorkItemFixture();
    const c = await card(fx);
    // An earlier record with no run, then one on a run's open leg.
    const loose = await runDiscrepancyService.recordDiscrepancy(
      { key: c.key, decisions: [DECISION] },
      fx.ctx,
    );
    await adminDb.runDiscrepancyRecord.update({
      where: { id: loose.recordId },
      data: { recordedAt: new Date('2026-11-01T08:00:00.000Z') },
    });
    const runId = await openLeg(fx, c.key);
    const onRun = await runDiscrepancyService.recordDiscrepancy(
      {
        key: c.key,
        points: [POINT, { planAsked: 'A2', built: 'B2', why: 'W2' }],
        decisions: [{ planSaid: 's', chose: 'c', why: 'w' }],
      },
      fx.ctx,
    );
    const run = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runId } });
    const owner = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ctx.userId } });

    const records = await runDiscrepancyReadService.listForWorkItem(c.id, fx.ctx);

    expect(records.map((r) => r.id)).toEqual([onRun.recordId, loose.recordId]);
    expect(records[0]).toEqual({
      id: onRun.recordId,
      source: 'recorded',
      recordedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      recordedByName: owner.name,
      run: { id: runId, startedAt: run.startedAt.toISOString() },
      pointCount: 2,
      decisionCount: 1,
      points: [
        { position: 1, planText: 'ASKED', outcomeText: 'BUILT', why: 'WHY', alternatives: null },
        { position: 2, planText: 'A2', outcomeText: 'B2', why: 'W2', alternatives: null },
      ],
      decisions: [{ position: 1, planText: 's', outcomeText: 'c', why: 'w', alternatives: null }],
      workItemRefs: {},
    });
    expect(records[1]).toMatchObject({
      recordedAt: '2026-11-01T08:00:00.000Z',
      run: null,
      points: [],
      decisions: [
        {
          position: 1,
          planText: 'nothing',
          outcomeText: 'CHOSE',
          why: 'DWHY',
          alternatives: 'ALT',
        },
      ],
    });
  });

  it('a record whose comment (from before MOTIR-11996) was deleted still reads in full', async () => {
    const fx = await makeWorkItemFixture();
    const c = await card(fx);
    await openLeg(fx, c.key);
    const { recordId } = await runDiscrepancyService.recordDiscrepancy(
      { key: c.key, points: [POINT], decisions: [DECISION] },
      fx.ctx,
    );
    const commentId = await linkLegacyDiscrepancyComment(recordId);
    await adminDb.comment.delete({ where: { id: commentId } });

    const [read] = await runDiscrepancyReadService.listForWorkItem(c.id, fx.ctx);
    expect(read!.points.map((p) => p.planText)).toEqual(['ASKED']);
    expect(read!.decisions.map((d) => d.alternatives)).toEqual(['ALT']);
    // …and the comment a run wrote was never the read: none remains on the card.
    expect(await adminDb.comment.count({ where: { workItemId: c.id } })).toBe(0);
  });

  it('a recorder whose account is gone reads as a null name; a backfilled source is carried', async () => {
    const fx = await makeWorkItemFixture();
    const c = await card(fx);
    const { recordId } = await runDiscrepancyService.recordDiscrepancy(
      { key: c.key, points: [POINT] },
      fx.ctx,
    );
    await adminDb.runDiscrepancyRecord.update({
      where: { id: recordId },
      data: { recordedById: null, source: 'backfilled' },
    });

    const [read] = await runDiscrepancyReadService.listForWorkItem(c.id, fx.ctx);
    expect(read).toMatchObject({ recordedByName: null, source: 'backfilled' });
  });

  it('resolves the cards its entries link, for the reader, so they draw as live chips', async () => {
    const fx = await makeWorkItemFixture();
    const c = await card(fx);
    const linked = await card(fx, 'The linked card');
    await runDiscrepancyService.recordDiscrepancy(
      {
        key: c.key,
        points: [{ ...POINT, why: `see [${linked.key}](motir:${linked.id})` }],
        decisions: [{ ...DECISION, alternatives: `[${linked.key}](motir:${linked.id})` }],
      },
      fx.ctx,
    );

    const [read] = await runDiscrepancyReadService.listForWorkItem(c.id, fx.ctx);
    expect(Object.keys(read!.workItemRefs)).toContain(linked.id);
    expect(read!.workItemRefs[linked.id]).toMatchObject({ title: 'The linked card' });
  });

  it('only this card’s records', async () => {
    const fx = await makeWorkItemFixture();
    const a = await card(fx, 'A');
    const b = await card(fx, 'B');
    await runDiscrepancyService.recordDiscrepancy({ key: b.key, points: [POINT] }, fx.ctx);
    expect(await runDiscrepancyReadService.listForWorkItem(a.id, fx.ctx)).toEqual([]);
  });

  it('a member who may browse reads it; one who may not gets the 404-shaped refusal', async () => {
    const fx = await makeWorkItemFixture();
    const c = await card(fx);
    await runDiscrepancyService.recordDiscrepancy({ key: c.key, points: [POINT] }, fx.ctx);

    const viewer = await memberWithRole(fx, 'Viewer', ['project:browse']);
    expect(await runDiscrepancyReadService.listForWorkItem(c.id, viewer)).toHaveLength(1);

    const outsider = await memberWithRole(fx, 'No browse', ['comment:add']);
    await expect(runDiscrepancyReadService.listForWorkItem(c.id, outsider)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it('an unknown card, or one in another workspace, is WorkItemNotFoundError', async () => {
    const fx = await makeWorkItemFixture();
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const c = await card(fx);
    await expect(
      runDiscrepancyReadService.listForWorkItem('no-such-item', fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    await expect(runDiscrepancyReadService.listForWorkItem(c.id, rival.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });
});

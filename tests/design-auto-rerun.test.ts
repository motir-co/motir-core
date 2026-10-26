import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// THE AUTOMATIC HOSTED RE-RUN AFTER A DESIGN REVISE (Story MOTIR-693 · MOTIR-700;
// `docs/decisions/hosted-design-rerun-and-design-approval-switch.md` §1), against a
// REAL Postgres.
//
// 9.1's dispatch service is STUBBED AT ITS BOUNDARY — `hostedRunService.start`, the one
// call that boots a container — as the card asks. Everything that decides whether to
// call it (the gate, the lane, the cap) and what is recorded afterwards runs for real.
// Each branch of §1 is its own case, because a single happy-path case passes against a
// service that re-runs everything.

const { hostedRunService } = await import('@/lib/services/hostedRunService');
const { designAutoRerunService, DESIGN_AUTO_RERUN_CAP } =
  await import('@/lib/services/designAutoRerunService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { HostedRunOutOfCreditsError, HostedModelNotOfferedError, HostedRunNoCapacityError } =
  await import('@/lib/hostedRuns/errors');

let fx: WorkItemFixture;
let card: WorkItem;
let startSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Design review without a babysitter' },
    fx.ctx,
  );
  const subtask = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Draw the frame' },
    fx.ctx,
  );
  card = await adminDb.workItem.findUniqueOrThrow({ where: { id: subtask.id } });
  startSpy?.mockRestore();
  startSpy = vi
    .spyOn(hostedRunService, 'start')
    .mockImplementation(async () => ({ dispatchRunId: await aRun('hosted'), created: true }));
});

afterAll(async () => {
  startSpy?.mockRestore();
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A dispatch run that carried the card. Returns its id. */
async function aRun(
  origin: 'hosted' | 'local',
  opts: { createdById?: string | null; model?: string | null; startedAt?: Date } = {},
): Promise<string> {
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      command: 'run',
      origin,
      model: opts.model === undefined ? 'claude-opus-5-5' : opts.model,
      createdById: opts.createdById === undefined ? fx.ctx.userId : opts.createdById,
      startedAt: opts.startedAt ?? new Date(),
      cards: {
        create: {
          workspaceId: fx.workspaceId,
          workItemId: card.id,
          workItemKey: card.identifier,
          position: 0,
        },
      },
    },
  });
  return run.id;
}

let gateSeq = 0;
/** A decided design refusal on the card — as the decide door would have written it. */
async function aRefusal(
  opts: {
    verdict?: 'revise' | 're_plan' | null;
    source?: 'ui' | 'api' | 'mcp' | 'github';
    decidedAt?: Date;
  } = {},
): Promise<string> {
  gateSeq += 1;
  const evidence = await adminDb.designEvidence.create({
    data: { workspaceId: fx.workspaceId, workItemId: card.id, isCurrent: false },
  });
  const gate = await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: card.id,
      kind: 'design_result',
      subjectId: evidence.id,
      state: 'changes_requested',
      decidedById: fx.ctx.userId,
      decidedAt: opts.decidedAt ?? new Date(Date.now() + gateSeq),
      noteMd: 'tighter spacing, the header is too loud',
      decisionSource: opts.source ?? 'ui',
      refusalVerdict: opts.verdict === undefined ? 'revise' : opts.verdict,
    },
  });
  return gate.id;
}

const attempt = (gateId: string) =>
  designAutoRerunService.attempt({ workspaceId: fx.workspaceId, gateId, idempotencyKey: gateId });

describe('a Revise on a HOSTED design starts ONE hosted run, as the last dispatcher (§1a–§1b)', () => {
  it('starts through Run hosted’s own path with the last run’s model, and records it', async () => {
    await aRun('hosted', { model: 'claude-sonnet-5-5' });
    const gateId = await aRefusal();

    const result = await attempt(gateId);

    expect(startSpy).toHaveBeenCalledTimes(1);
    const [input, ctx] = startSpy.mock.calls[0]!;
    expect(input).toMatchObject({
      workItemKey: card.identifier,
      model: 'claude-sonnet-5-5',
      idempotencyKey: `design-auto-rerun:${gateId}`,
    });
    expect(ctx).toEqual({ userId: fx.ctx.userId, workspaceId: fx.workspaceId });
    expect(result.outcome).toBe('recorded');
    const row = await adminDb.designAutoRerun.findUniqueOrThrow({ where: { gateId } });
    expect(row.outcome).toBe('started');
    expect(row.skipReason).toBeNull();
    expect(row.dispatchRunId).not.toBeNull();
    expect(row.ordinal).toBe(1);
  });

  it('delivering the same refusal twice starts ONE run and keeps one record', async () => {
    await aRun('hosted');
    const gateId = await aRefusal();

    await attempt(gateId);
    await attempt(gateId);

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(await adminDb.designAutoRerun.count({ where: { gateId } })).toBe(1);
  });
});

describe('what is NEVER re-run (§1a)', () => {
  it('a card last run BYOK: nothing starts and nothing is recorded', async () => {
    await aRun('hosted', { startedAt: new Date(Date.now() - 60_000) });
    await aRun('local');
    const gateId = await aRefusal();

    expect((await attempt(gateId)).outcome).toBe('not_a_candidate');
    expect(startSpy).not.toHaveBeenCalled();
    expect(await adminDb.designAutoRerun.count()).toBe(0);
  });

  it('a card never run at all (by hand)', async () => {
    const gateId = await aRefusal();
    expect((await attempt(gateId)).outcome).toBe('not_a_candidate');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('a Re-plan verdict', async () => {
    await aRun('hosted');
    const gateId = await aRefusal({ verdict: 're_plan' });
    expect((await attempt(gateId)).outcome).toBe('not_a_candidate');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('a GitHub-synced refusal', async () => {
    await aRun('hosted');
    const gateId = await aRefusal({ verdict: null, source: 'github' });
    expect((await attempt(gateId)).outcome).toBe('not_a_candidate');
    expect(startSpy).not.toHaveBeenCalled();
  });
});

describe('the cap (§1e)', () => {
  it(`the ${DESIGN_AUTO_RERUN_CAP + 1}th Revise starts nothing and says cap reached`, async () => {
    await aRun('hosted');
    const base = Date.now();
    for (let i = 0; i < DESIGN_AUTO_RERUN_CAP; i += 1) {
      await aRefusal({ decidedAt: new Date(base + i * 1000) });
    }
    const gateId = await aRefusal({ decidedAt: new Date(base + DESIGN_AUTO_RERUN_CAP * 1000) });

    await attempt(gateId);

    expect(startSpy).not.toHaveBeenCalled();
    const row = await adminDb.designAutoRerun.findUniqueOrThrow({ where: { gateId } });
    expect(row.outcome).toBe('skipped');
    expect(row.skipReason).toBe('cap_reached');
    expect(row.ordinal).toBe(DESIGN_AUTO_RERUN_CAP + 1);
  });

  it('a Re-plan does not count towards the cap', async () => {
    await aRun('hosted');
    const base = Date.now();
    for (let i = 0; i < DESIGN_AUTO_RERUN_CAP; i += 1) {
      await aRefusal({ verdict: 're_plan', decidedAt: new Date(base + i * 1000) });
    }
    const gateId = await aRefusal({ decidedAt: new Date(base + 10_000) });

    await attempt(gateId);

    expect(startSpy).toHaveBeenCalledTimes(1);
  });
});

describe('when the dispatcher can no longer run hosted, nothing starts and the card says why (§1d)', () => {
  it('the dispatcher is gone', async () => {
    await aRun('hosted', { createdById: null });
    const gateId = await aRefusal();

    await attempt(gateId);

    expect(startSpy).not.toHaveBeenCalled();
    const row = await adminDb.designAutoRerun.findUniqueOrThrow({ where: { gateId } });
    expect(row.skipReason).toBe('dispatcher_gone');
  });

  it('the organization is out of credits', async () => {
    await aRun('hosted');
    startSpy.mockRejectedValueOnce(new HostedRunOutOfCreditsError(0));
    const gateId = await aRefusal();

    await attempt(gateId);

    const row = await adminDb.designAutoRerun.findUniqueOrThrow({ where: { gateId } });
    expect(row.outcome).toBe('skipped');
    expect(row.skipReason).toBe('out_of_credits');
    expect(row.dispatchRunId).toBeNull();
  });

  it('the model has no agent-run capacity — recorded with the model, never retried (MOTIR-9633)', async () => {
    await aRun('hosted', { model: 'busy-model' });
    startSpy.mockRejectedValueOnce(
      new HostedRunNoCapacityError('busy-model', 'agent_share_exhausted'),
    );
    const gateId = await aRefusal();

    // It does not throw, so the job does not retry it.
    await expect(attempt(gateId)).resolves.toMatchObject({ outcome: 'recorded' });

    const row = await adminDb.designAutoRerun.findUniqueOrThrow({ where: { gateId } });
    expect(row.outcome).toBe('skipped');
    expect(row.skipReason).toBe('no_capacity');
    expect(row.detail).toBe('busy-model');
    expect(row.dispatchRunId).toBeNull();
  });

  it('the model is no longer offered — never substituted', async () => {
    await aRun('hosted', { model: 'retired-model' });
    startSpy.mockRejectedValueOnce(new HostedModelNotOfferedError('retired-model'));
    const gateId = await aRefusal();

    await attempt(gateId);

    expect(startSpy).toHaveBeenCalledTimes(1);
    const row = await adminDb.designAutoRerun.findUniqueOrThrow({ where: { gateId } });
    expect(row.skipReason).toBe('model_not_offered');
    // What the card's line names, captured when written (MOTIR-702).
    expect(row.detail).toBe('retired-model');
  });

  it('the dispatcher can no longer edit the project — the line names them', async () => {
    await aRun('hosted');
    const { PermissionDeniedError } = await import('@/lib/projects/errors');
    startSpy.mockRejectedValueOnce(new PermissionDeniedError(fx.projectId, 'work_item:edit'));
    const gateId = await aRefusal();

    await attempt(gateId);

    const row = await adminDb.designAutoRerun.findUniqueOrThrow({ where: { gateId } });
    expect(row.skipReason).toBe('no_project_access');
    const me = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ctx.userId } });
    expect(row.detail).toBe(me.name);
  });

  it('an error the card cannot explain is thrown, so the job retries, and nothing is recorded', async () => {
    await aRun('hosted');
    startSpy.mockRejectedValueOnce(new Error('connection reset'));
    const gateId = await aRefusal();

    await expect(attempt(gateId)).rejects.toThrow('connection reset');
    expect(await adminDb.designAutoRerun.count({ where: { gateId } })).toBe(0);
  });
});

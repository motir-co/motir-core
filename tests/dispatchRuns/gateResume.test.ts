import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalGateKind, WorkItem } from '@/generated/prisma/client';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { db } from '@/lib/db';
import * as jobDispatcher from '@/lib/jobs/engine/dispatcher';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { shaFor } from '../helpers/commitShaFixtures';
import { truncateAuthTables } from '../helpers/db';
import { captureJobEvents, JobTestEngine, type CapturedJobEvent } from '../helpers/jobs';
import { ensureWorkWaitsOn } from '@/tests/helpers/designWaits';

// A HOSTED RUN THAT STOPPED AT A GATE RESUMES ITSELF WHEN THE GATE IS APPROVED
// (Story MOTIR-7701 · MOTIR-7710), against a REAL Postgres.
//
// ONE boundary is stubbed: `hostedRunService.start`, the call that boots a container
// — `design-auto-rerun.test.ts`'s seam. The job dispatcher is CAPTURED, so each test
// hands the captured event to the job's own handler, the call a worker would make.
// Everything that decides whether to start, as whom, and what is recorded runs for real.

const store = new Map<string, { contentType: string; size: number }>();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { hostedRunService } = await import('@/lib/services/hostedRunService');
const { gateResumeService } = await import('@/lib/services/gateResumeService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { manualWorkGateService } = await import('@/lib/services/manualWorkGateService');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { homeService } = await import('@/lib/services/homeService');
const { recomputeWorkItemResumeState } = await import('@/lib/services/resumeStateService');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { gateResume } = await import('@/lib/jobs/definitions/gateResume');
const { requestGateResumeAfterDecision } = await import('@/lib/services/gateResumeRequest');
const { dispatchRunHeldGateRepository } =
  await import('@/lib/repositories/dispatchRunHeldGateRepository');
const {
  HostedContinueRefusedError,
  HostedModelNotOfferedError,
  HostedModelsUnavailableError,
  HostedRunBootFailedError,
  HostedRunCardNotReadyError,
  HostedRunCreditsUnavailableError,
  HostedRunNoCapacityError,
  HostedRunOutOfCreditsError,
} = await import('@/lib/hostedRuns/errors');
const { CiCreditsExhaustedError } = await import('@/lib/ciMetering/errors');

const MODEL = 'claude-sonnet-5-5';

let fx: WorkItemFixture;
let events: CapturedJobEvent[];
let restoreEvents: () => void;
let startSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  store.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  restoreEvents?.();
  ({ events, restore: restoreEvents } = captureJobEvents());
  startSpy?.mockRestore();
  // The container boot, stubbed: it opens the hosted continue the real start would.
  startSpy = vi.spyOn(hostedRunService, 'start').mockImplementation(async (input) => {
    const target = await adminDb.workItem.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId, identifier: input.workItemKey },
    });
    const run = await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'continue',
        origin: 'hosted',
        model: input.model,
        createdById: fx.ownerId,
        scopeWorkItemId: target.id,
      },
    });
    return { dispatchRunId: run.id, created: true };
  });
});

afterAll(async () => {
  startSpy?.mockRestore();
  restoreEvents?.();
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function card(
  title: string,
  extra: { parentId?: string; kind?: 'story' | 'subtask'; manual?: boolean } = {},
): Promise<WorkItem> {
  const created = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: extra.kind ?? 'subtask',
      title,
      ...(extra.parentId ? { parentId: extra.parentId } : {}),
      ...(extra.manual ? { type: 'manual' as const, executor: 'human' as const } : {}),
    },
    fx.ctx,
  );
  return adminDb.workItem.update({
    where: { id: created.id },
    data: { status: 'in_progress', assigneeId: fx.ownerId },
  });
}

/** A story whose SCOPE run closed `gated` — written as its close leaves it. */
async function gatedRun(
  parent: WorkItem,
  legs: WorkItem[],
  opts: {
    origin?: 'hosted' | 'local' | 'instance';
    createdById?: string | null;
    model?: string | null;
  } = {},
): Promise<string> {
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      command: 'run_scope',
      origin: opts.origin ?? 'hosted',
      model: opts.model === undefined ? MODEL : opts.model,
      createdById: opts.createdById === undefined ? fx.ownerId : opts.createdById,
      scopeWorkItemId: parent.id,
      status: 'succeeded',
      stopReason: 'gated',
      endedAt: new Date(),
      cards: {
        create: legs.map((leg, position) => ({
          workspaceId: fx.workspaceId,
          workItemId: leg.id,
          workItemKey: leg.identifier,
          position,
        })),
      },
    },
  });
  return run.id;
}

/** An awaiting gate on `item`, held by `runId`. */
async function heldGate(runId: string, item: WorkItem, kind: ApprovalGateKind): Promise<string> {
  const gate = await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      kind,
      subjectId: `subject-${item.id}-${kind}`,
      state: 'awaiting',
    },
  });
  await adminDb.dispatchRunHeldGate.create({
    data: {
      workspaceId: fx.workspaceId,
      dispatchRunId: runId,
      gateId: gate.id,
      workItemId: item.id,
      kind,
    },
  });
  return gate.id;
}

const approve = (gateId: string) =>
  adminDb.approvalGate.update({
    where: { id: gateId },
    data: { state: 'approved', decidedById: fx.ownerId, decidedAt: new Date() },
  });

const attempt = (gateId: string) =>
  gateResumeService.attempt({ workspaceId: fx.workspaceId, gateId, idempotencyKey: gateId });

/** Hand every captured resume event to the JOB'S OWN handler, as a worker would. */
async function drainResumeJobs(): Promise<number> {
  const pending = events.filter((e) => e.name === 'run/gate-resume.requested');
  events.length = 0;
  for (const event of pending) {
    const outcome = await new JobTestEngine({ function: gateResume, events: [event] }).execute();
    if (outcome.error) throw outcome.error;
  }
  return pending.length;
}

async function publish(design: WorkItem, label: string): Promise<void> {
  const pathname = `${designPrefix(fx.workspaceId, design.id)}${label}.mock.html`;
  store.set(pathname, { contentType: 'text/html', size: 2048 });
  const notePathname = `${designPrefix(fx.workspaceId, design.id)}${label}.design-notes.md`;
  store.set(notePathname, { contentType: 'text/markdown', size: 512 });
  await ensureWorkWaitsOn(design.id, fx);
  await designEvidenceService.recordFromPathnames(
    {
      workItemId: design.id,
      assets: [
        { kind: 'mock', sourcePath: `design/work-items/${label}.mock.html`, pathname },
        {
          kind: 'note_file',
          sourcePath: 'design/work-items/design-notes.md',
          pathname: notePathname,
        },
      ],
      commitSha: shaFor(label),
    },
    fx.ctx,
  );
}

describe('the trigger — every approving decision, through both doors', () => {
  it('Mark done on a held manual-work gate enqueues ONE resume, which starts ONE hosted continue as the dispatcher', async () => {
    const parent = await card('a story', { kind: 'story' });
    const manual = await card('rotate the key', { parentId: parent.id, manual: true });
    const code = await card('the code', { parentId: parent.id });
    const runId = await gatedRun(parent, [code, manual]);
    await withWorkspaceContext(fx.ctx, (tx) =>
      manualWorkGateService.raise(manual.id, { createdById: fx.ownerId }, fx.workspaceId, tx),
    );
    const gate = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: manual.id, kind: 'manual_work', state: 'awaiting' },
    });
    await adminDb.dispatchRunHeldGate.create({
      data: {
        workspaceId: fx.workspaceId,
        dispatchRunId: runId,
        gateId: gate.id,
        workItemId: manual.id,
        kind: 'manual_work',
      },
    });

    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );

    expect(events.filter((e) => e.name === 'run/gate-resume.requested').map((e) => e.data)).toEqual(
      [{ workspaceId: fx.workspaceId, gateId: gate.id, idempotencyKey: gate.id }],
    );
    expect(await drainResumeJobs()).toBe(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
    const [input, ctx] = startSpy.mock.calls[0]!;
    expect(input).toEqual({
      workItemKey: parent.identifier,
      model: MODEL,
      idempotencyKey: `gate-resume:${gate.id}`,
      mode: 'continue',
    });
    expect(ctx).toEqual({ userId: fx.ownerId, workspaceId: fx.workspaceId });
    const record = await adminDb.gateResume.findUniqueOrThrow({ where: { gateId: gate.id } });
    expect(record).toMatchObject({ runId, outcome: 'started', skipReason: null });
    expect(record.resumedRunId).not.toBeNull();
  });

  it('the design-approval-off system approval does too, after the publish commits', async () => {
    const parent = await card('a story', { kind: 'story' });
    const design = await card('the design', { parentId: parent.id });
    const runId = await gatedRun(parent, [design]);
    await heldGate(runId, design, 'design_result');
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { designApprovalGate: false },
    });

    await publish(design, 'v1');

    const approved = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: design.id, kind: 'design_result', state: 'approved' },
    });
    const asked = events.filter((e) => e.name === 'run/gate-resume.requested');
    expect(asked.map((e) => e.data)).toEqual([
      { workspaceId: fx.workspaceId, gateId: approved.id, idempotencyKey: approved.id },
    ]);
    expect(await drainResumeJobs()).toBe(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(
      await adminDb.gateResume.findUniqueOrThrow({ where: { gateId: approved.id } }),
    ).toMatchObject({ runId, outcome: 'started' });
  });

  it('a publish that only ASKS the question enqueues nothing', async () => {
    const parent = await card('a story', { kind: 'story' });
    const design = await card('the design', { parentId: parent.id });
    const runId = await gatedRun(parent, [design]);
    await heldGate(runId, design, 'design_result');

    await publish(design, 'v1');

    expect(events.filter((e) => e.name === 'run/gate-resume.requested')).toEqual([]);
  });

  it('an approval on a card no run stopped at enqueues nothing', async () => {
    const story = await card('a story nobody ran', { kind: 'story' });
    const loose = await card('a manual card', { parentId: story.id, manual: true });
    await withWorkspaceContext(fx.ctx, (tx) =>
      manualWorkGateService.raise(loose.id, { createdById: fx.ownerId }, fx.workspaceId, tx),
    );
    const gate = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: loose.id, kind: 'manual_work' },
    });
    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );
    expect(events.filter((e) => e.name === 'run/gate-resume.requested')).toEqual([]);
  });

  it('the decision never fails because the enqueue did', async () => {
    const parent = await card('a story', { kind: 'story' });
    const manual = await card('rotate the key', { parentId: parent.id, manual: true });
    const runId = await gatedRun(parent, [manual]);
    await withWorkspaceContext(fx.ctx, (tx) =>
      manualWorkGateService.raise(manual.id, { createdById: fx.ownerId }, fx.workspaceId, tx),
    );
    const gate = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: manual.id, kind: 'manual_work' },
    });
    await adminDb.dispatchRunHeldGate.create({
      data: {
        workspaceId: fx.workspaceId,
        dispatchRunId: runId,
        gateId: gate.id,
        workItemId: manual.id,
        kind: 'manual_work',
      },
    });
    restoreEvents();
    const failing = vi
      .spyOn(jobDispatcher, 'dispatchEventToEngine')
      .mockRejectedValue(new Error('engine down'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        approvalGatesService.decide(
          { gateId: gate.id, decision: 'approve', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
          fx.ctx,
        ),
      ).resolves.toBeDefined();
    } finally {
      failing.mockRestore();
      quiet.mockRestore();
    }
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } })).state).toBe(
      'approved',
    );
  });
});

describe('the ask itself', () => {
  it('asks nothing for a card-less gate or a kind that never holds a run', async () => {
    const story = await card('a story', { kind: 'story' });
    await requestGateResumeAfterDecision(
      { workItemId: null, kind: 'design_result' },
      fx.workspaceId,
    );
    await requestGateResumeAfterDecision(
      { workItemId: story.id, kind: 'pull_request_approval' },
      fx.workspaceId,
    );
    expect(events.filter((e) => e.name === 'run/gate-resume.requested')).toEqual([]);
  });

  it('a read that throws is logged and swallowed — the committed decision stands', async () => {
    const story = await card('a story', { kind: 'story' });
    const failing = vi
      .spyOn(dispatchRunHeldGateRepository, 'listRunIdsByWorkItemAndKind')
      .mockRejectedValueOnce(new Error('db is gone'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        requestGateResumeAfterDecision(
          { workItemId: story.id, kind: 'design_result' },
          fx.workspaceId,
        ),
      ).resolves.toBeUndefined();
      expect(quiet).toHaveBeenCalledWith(
        '[gate-resume] enqueue failed after a committed decision',
        expect.any(Error),
      );
    } finally {
      failing.mockRestore();
      quiet.mockRestore();
    }
  });
});

describe('the handler — at most one resume per decision and per run', () => {
  async function hostedStory(opts: Parameters<typeof gatedRun>[2] = {}) {
    const parent = await card('a story', { kind: 'story' });
    const design = await card('the design', { parentId: parent.id });
    const choice = await card('the choice', { parentId: parent.id });
    const runId = await gatedRun(parent, [design, choice], opts);
    const designGate = await heldGate(runId, design, 'design_result');
    const choiceGate = await heldGate(runId, choice, 'decision_choice');
    return { parent, design, choice, runId, designGate, choiceGate };
  }

  it('a re-delivered event is a no-op', async () => {
    const { designGate } = await hostedStory();
    await approve(designGate);

    await attempt(designGate);
    await attempt(designGate);

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(await adminDb.gateResume.count({ where: { gateId: designGate } })).toBe(1);
  });

  it('two held gates approved back to back start ONE continue; the second records already_resumed', async () => {
    const { runId, designGate, choiceGate } = await hostedStory();
    await approve(designGate);
    await approve(choiceGate);

    await attempt(designGate);
    await attempt(choiceGate);

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(
      await adminDb.gateResume.findUniqueOrThrow({ where: { gateId: choiceGate } }),
    ).toMatchObject({
      runId,
      outcome: 'skipped',
      skipReason: 'already_resumed',
      resumedRunId: null,
    });
  });

  it.each(['local', 'instance'] as const)(
    'a %s gated run: nothing written, nothing started',
    async (origin) => {
      const { designGate } = await hostedStory({ origin });
      await approve(designGate);

      expect(await attempt(designGate)).toEqual({ outcome: 'not_a_candidate' });
      expect(startSpy).not.toHaveBeenCalled();
      expect(await adminDb.gateResume.count()).toBe(0);
    },
  );

  it('a target on To fix is not a candidate — To fix wins over To resume (MOTIR-8011)', async () => {
    const { parent, designGate } = await hostedStory();
    await adminDb.workItem.update({ where: { id: parent.id }, data: { fixReason: 'ci_failed' } });
    await approve(designGate);

    expect(await attempt(designGate)).toEqual({ outcome: 'not_a_candidate' });
    expect(startSpy).not.toHaveBeenCalled();
    expect(await adminDb.gateResume.count()).toBe(0);
  });

  it('a gate not approved (yet, or any more) is not a candidate', async () => {
    const { designGate } = await hostedStory();
    expect(await attempt(designGate)).toEqual({ outcome: 'not_a_candidate' });
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('a run something newer moved past is not a candidate', async () => {
    const { parent, design, designGate } = await hostedStory();
    await approve(designGate);
    await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'run_scope',
        origin: 'hosted',
        scopeWorkItemId: parent.id,
        cards: {
          create: {
            workspaceId: fx.workspaceId,
            workItemId: design.id,
            workItemKey: design.identifier,
            position: 0,
          },
        },
      },
    });

    expect(await attempt(designGate)).toEqual({ outcome: 'not_a_candidate' });
    expect(startSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['out_of_credits', () => new HostedRunOutOfCreditsError(0)],
    ['model_not_offered', () => new HostedModelNotOfferedError(MODEL)],
    ['already_resumed', () => new HostedContinueRefusedError('MOTIR-1', 'taken')],
    ['not_resumable', () => new HostedContinueRefusedError('MOTIR-1', 'no_branch')],
    ['models_unavailable', () => new HostedModelsUnavailableError('motir-ai is down')],
    ['credits_unavailable', () => new HostedRunCreditsUnavailableError()],
    ['card_not_ready', () => new HostedRunCardNotReadyError('MOTIR-1', 'archived')],
    [
      'ci_credits_exhausted',
      () =>
        new CiCreditsExhaustedError({
          organizationId: 'org',
          state: 'ci_credits_exhausted',
          consumedMinutes: 600,
          poolMinutes: 500,
          balance: 0,
        } as ConstructorParameters<typeof CiCreditsExhaustedError>[0]),
    ],
  ] as const)('a start refused %s records the skip and starts nothing', async (reason, make) => {
    const { runId, designGate } = await hostedStory();
    await approve(designGate);
    startSpy.mockRejectedValueOnce(make());

    await attempt(designGate);

    expect(
      await adminDb.gateResume.findUniqueOrThrow({ where: { gateId: designGate } }),
    ).toMatchObject({ runId, outcome: 'skipped', skipReason: reason, resumedRunId: null });
    expect(await adminDb.dispatchRun.count({ where: { command: 'continue' } })).toBe(0);
  });

  it('a model with no agent-run capacity records no_capacity naming it, and never retries (MOTIR-9633)', async () => {
    const { runId, designGate } = await hostedStory();
    await approve(designGate);
    startSpy.mockRejectedValueOnce(new HostedRunNoCapacityError(MODEL, 'provider_rate_limited'));

    // It does not throw, so the job does not retry it.
    await expect(attempt(designGate)).resolves.toMatchObject({ outcome: 'recorded' });

    expect(
      await adminDb.gateResume.findUniqueOrThrow({ where: { gateId: designGate } }),
    ).toMatchObject({
      runId,
      outcome: 'skipped',
      skipReason: 'no_capacity',
      detail: MODEL,
      resumedRunId: null,
    });
    expect(await adminDb.dispatchRun.count({ where: { command: 'continue' } })).toBe(0);
  });

  it('a run that recorded no model records model_not_offered, without asking to start', async () => {
    const { designGate } = await hostedStory({ model: null });
    await approve(designGate);

    await attempt(designGate);

    expect(startSpy).not.toHaveBeenCalled();
    expect(
      await adminDb.gateResume.findUniqueOrThrow({ where: { gateId: designGate } }),
    ).toMatchObject({ outcome: 'skipped', skipReason: 'model_not_offered', detail: null });
  });

  it('a container that never booted still STARTED a run: the record links to it', async () => {
    const { runId, designGate } = await hostedStory();
    await approve(designGate);
    const failed = await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'continue',
        origin: 'hosted',
        status: 'failed',
        endedAt: new Date(),
      },
    });
    startSpy.mockRejectedValueOnce(new HostedRunBootFailedError(failed.id, 'fleet at ceiling'));

    await attempt(designGate);

    expect(
      await adminDb.gateResume.findUniqueOrThrow({ where: { gateId: designGate } }),
    ).toMatchObject({ runId, outcome: 'started', skipReason: null, resumedRunId: failed.id });
  });

  it('a LEAF run (no scope) resumes through its one leg', async () => {
    const leaf = await card('a leaf with a design gate', { kind: 'story' });
    const run = await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'run',
        origin: 'hosted',
        model: MODEL,
        createdById: fx.ownerId,
        status: 'succeeded',
        stopReason: 'gated',
        endedAt: new Date(),
        cards: {
          create: {
            workspaceId: fx.workspaceId,
            workItemId: leaf.id,
            workItemKey: leaf.identifier,
            position: 0,
          },
        },
      },
    });
    const gateId = await heldGate(run.id, leaf, 'design_result');
    await approve(gateId);

    await attempt(gateId);

    expect(startSpy.mock.calls[0]![0]).toMatchObject({ workItemKey: leaf.identifier });
  });

  it('a held gate whose run did not close `gated` (it was cancelled) is not a candidate', async () => {
    const { runId, designGate } = await hostedStory();
    await adminDb.dispatchRun.update({ where: { id: runId }, data: { status: 'cancelled' } });
    await approve(designGate);

    expect(await attempt(designGate)).toEqual({ outcome: 'not_a_candidate' });
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('a dispatcher whose account is gone records dispatcher_gone, without asking to start', async () => {
    const { designGate } = await hostedStory({ createdById: null });
    await approve(designGate);

    await attempt(designGate);

    expect(startSpy).not.toHaveBeenCalled();
    expect(
      (await adminDb.gateResume.findUniqueOrThrow({ where: { gateId: designGate } })).skipReason,
    ).toBe('dispatcher_gone');
  });

  it('an unexplained error is rethrown, so the job retries, and nothing is recorded', async () => {
    const { designGate } = await hostedStory();
    await approve(designGate);
    startSpy.mockRejectedValueOnce(new Error('network is down'));

    await expect(attempt(designGate)).rejects.toThrow('network is down');
    expect(await adminDb.gateResume.count()).toBe(0);
  });

  it('the To resume entry carries the newest attempt', async () => {
    const { parent, design, choice, designGate } = await hostedStory();
    for (const id of [parent.id, design.id, choice.id]) {
      await withWorkspaceContext(fx.ctx, (tx) => recomputeWorkItemResumeState(id, tx));
    }
    await approve(designGate);
    startSpy.mockRejectedValueOnce(new HostedRunOutOfCreditsError(0));
    await attempt(designGate);

    const toResume = await homeService.listToResume({ ...fx.ctx, projectId: fx.projectId });

    expect(toResume.items).toHaveLength(1);
    expect(toResume.items[0]).toMatchObject({
      id: parent.id,
      resumeAttempt: { outcome: 'skipped', skipReason: 'out_of_credits', resumedRunId: null },
    });
  });
});

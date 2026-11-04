import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalGateState, WorkItem } from '@/generated/prisma/client';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { db } from '@/lib/db';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { setWorkspaceRoleFor } from '../helpers/workspaceRoleFixtures';
import { adminDb } from '../helpers/adminDb';
import { shaFor } from '../helpers/commitShaFixtures';
import { truncateAuthTables } from '../helpers/db';
import { ensureWorkWaitsOn } from '@/tests/helpers/designWaits';
import { homePageItems } from '../helpers/homePage';
import { connectRepairRepo, deliveredPr } from '../helpers/repairFixtures';

// TO RESUME (Story MOTIR-7701 · MOTIR-7707) — `WorkItem.resumeState`, against a real
// Postgres: the derivation's every case, each trigger that moves it, and the Workbench
// partition it carves out of In progress.

const store = new Map<string, { contentType: string; size: number }>();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));
vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { workItemsService } = await import('@/lib/services/workItemsService');
const { dispatchRunService } = await import('@/lib/services/dispatchRunService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { manualWorkGateService } = await import('@/lib/services/manualWorkGateService');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { homeService } = await import('@/lib/services/homeService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { readHeldGateVerdict, recomputeWorkItemResumeState, resumeStateService } =
  await import('@/lib/services/resumeStateService');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');

let fx: WorkItemFixture;

beforeEach(async () => {
  store.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const hctx = () => ({ ...fx.ctx, projectId: fx.projectId });

async function card(
  title: string,
  extra: { parentId?: string; kind?: 'story' | 'subtask' | 'task'; manual?: boolean } = {},
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

/** A story with a design child and a code child blocked by it, all In Progress. */
async function story() {
  const parent = await card('a story', { kind: 'story' });
  const design = await card('the design', { parentId: parent.id });
  const code = await card('the code', { parentId: parent.id });
  await workItemsService.linkWorkItems(
    { fromId: code.id, toId: design.id, kind: 'is_blocked_by' },
    fx.ctx,
  );
  return { parent, design, code };
}

async function openScopeRun(parent: WorkItem, legs: WorkItem[]): Promise<string> {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run_scope',
      reportedBy: 'cli',
      scopeKey: parent.identifier,
      cards: legs.map((leg) => ({ key: leg.identifier, disposition: 'queued' as const })),
    },
    fx.ctx,
  );
  return run.id;
}

async function gate(item: WorkItem, state: ApprovalGateState = 'awaiting') {
  const decided = state === 'awaiting' ? {} : { decidedById: fx.ownerId, decidedAt: new Date() };
  return adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      kind: 'design_result',
      subjectId: `ev-${item.id}-${Math.random()}`,
      state,
      ...decided,
    },
  });
}

/** A story whose scope run stopped `gated` at its design's awaiting gate. */
async function gatedStory() {
  const s = await story();
  const runId = await openScopeRun(s.parent, [s.design, s.code]);
  const held = await gate(s.design);
  await dispatchRunService.close(runId, { stopReason: 'gated' }, fx.ctx);
  return { ...s, runId, held };
}

const stateOf = async (id: string) => {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  return { resumeState: row.resumeState, resumeRunId: row.resumeRunId };
};
const recompute = (id: string) =>
  withWorkspaceContext(fx.ctx, (tx) => recomputeWorkItemResumeState(id, tx));

describe('the derivation — one answer per case', () => {
  it('every held gate awaiting → waiting_on_gate, naming the gated run', async () => {
    const { parent, code, runId } = await gatedStory();
    for (const id of [parent.id, code.id]) {
      expect(await stateOf(id)).toEqual({ resumeState: 'waiting_on_gate', resumeRunId: runId });
    }
  });

  it('one held gate approved → ready_to_resume', async () => {
    const { parent, held, runId } = await gatedStory();
    await adminDb.approvalGate.update({
      where: { id: held.id },
      data: { state: 'approved', decidedById: fx.ownerId, decidedAt: new Date() },
    });
    expect(await recompute(parent.id)).toEqual({
      resumeState: 'ready_to_resume',
      resumeRunId: runId,
    });
  });

  it('a gate answered changes_requested is decided: the run is ready to resume (MOTIR-9185)', async () => {
    const { parent, held } = await gatedStory();
    await adminDb.approvalGate.update({
      where: { id: held.id },
      data: {
        state: 'changes_requested',
        decidedById: fx.ownerId,
        decidedAt: new Date(),
        noteMd: 'no',
      },
    });
    expect((await recompute(parent.id)).resumeState).toBe('ready_to_resume');
  });

  it.each(['declined', 'overturned'] as const)(
    'a gate sent back (%s) stays waiting — a refusal releases nothing',
    async (state) => {
      const { parent, held } = await gatedStory();
      await adminDb.approvalGate.update({
        where: { id: held.id },
        data: { state, decidedById: fx.ownerId, decidedAt: new Date(), noteMd: 'no' },
      });
      expect((await recompute(parent.id)).resumeState).toBe('waiting_on_gate');
    },
  );

  it('a gated run that recorded no gate is ready at once', async () => {
    const { parent, design, code } = await story();
    const runId = await openScopeRun(parent, [design, code]);
    await dispatchRunService.close(runId, { stopReason: 'gated' }, fx.ctx);
    expect(await stateOf(parent.id)).toEqual({
      resumeState: 'ready_to_resume',
      resumeRunId: runId,
    });
  });

  it('a newer run on the card takes it off', async () => {
    const { parent, design, code } = await gatedStory();
    await openScopeRun(parent, [design, code]);
    expect(await stateOf(parent.id)).toEqual({ resumeState: null, resumeRunId: null });
  });

  it('a latest run that DIED is To fix’s, never To resume’s', async () => {
    const { parent, design, code } = await story();
    const runId = await openScopeRun(parent, [design, code]);
    await gate(design);
    await dispatchRunService.close(runId, { stopReason: 'halted' }, fx.ctx);
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: parent.id } });
    expect(row.resumeState).toBeNull();
  });

  it('a card out of the in-progress category is not waiting', async () => {
    const { code } = await gatedStory();
    await adminDb.workItem.update({ where: { id: code.id }, data: { status: 'todo' } });
    expect(await recompute(code.id)).toEqual({ resumeState: null, resumeRunId: null });
  });

  it('a card at Implemented / In Review / Approved with an open pull request is delivered, not waiting (MOTIR-8611)', async () => {
    const repo = await connectRepairRepo(fx, 'motir-core');
    for (const status of ['implemented', 'in_review', 'approved']) {
      const { code } = await gatedStory();
      await deliveredPr(fx, code.id, repo, { headRef: `subtask/${code.identifier}` });
      await adminDb.workItem.update({ where: { id: code.id }, data: { status } });
      expect(await recompute(code.id)).toEqual({ resumeState: null, resumeRunId: null });
    }
  });

  it('a card at In Review with NO open pull request still waits — a design publish walks there by itself (MOTIR-8611)', async () => {
    const { code, runId } = await gatedStory();
    await adminDb.workItem.update({ where: { id: code.id }, data: { status: 'in_review' } });
    expect(await recompute(code.id)).toEqual({
      resumeState: 'waiting_on_gate',
      resumeRunId: runId,
    });
  });

  it('an archived card is not waiting', async () => {
    const { code } = await gatedStory();
    await adminDb.workItem.update({ where: { id: code.id }, data: { archivedAt: new Date() } });
    expect((await recompute(code.id)).resumeState).toBeNull();
  });
});

describe('the triggers — each moves the column in the writer’s own flow', () => {
  it('a gated close puts the run’s cards on it, and a halted one never does', async () => {
    const { parent } = await gatedStory();
    expect((await stateOf(parent.id)).resumeState).toBe('waiting_on_gate');
  });

  it('a decide-door approval (Mark done on a manual child) makes the run ready', async () => {
    const parent = await card('a story', { kind: 'story' });
    const manual = await card('rotate the key', { parentId: parent.id, manual: true });
    const code = await card('the code', { parentId: parent.id });
    const runId = await openScopeRun(parent, [code, manual]);
    await withWorkspaceContext(fx.ctx, (tx) =>
      manualWorkGateService.raise(manual.id, { createdById: fx.ownerId }, fx.workspaceId, tx),
    );
    await dispatchRunService.close(runId, { stopReason: 'gated' }, fx.ctx);
    expect((await stateOf(code.id)).resumeState).toBe('waiting_on_gate');

    const awaiting = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: manual.id, kind: 'manual_work', state: 'awaiting' },
    });
    await approvalGatesService.decide(
      { gateId: awaiting.id, decision: 'approve', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );

    expect(await stateOf(code.id)).toEqual({ resumeState: 'ready_to_resume', resumeRunId: runId });
    expect((await stateOf(parent.id)).resumeState).toBe('ready_to_resume');
    // The manual card itself went to Done, so it is off every in-progress slice.
    expect((await stateOf(manual.id)).resumeState).toBeNull();
  });

  it('a republish supersedes the held gate and still waits; a system approval makes it ready', async () => {
    const { parent, design, code } = await story();
    const runId = await openScopeRun(parent, [design, code]);
    await publish(design, 'v1');
    await dispatchRunService.close(runId, { stopReason: 'gated' }, fx.ctx);
    expect((await stateOf(code.id)).resumeState).toBe('waiting_on_gate');

    // v2 with the switch ON: v1's gate is superseded and v2 asks again.
    await publish(design, 'v2');
    expect((await stateOf(code.id)).resumeState).toBe('waiting_on_gate');

    // v3 with design approval OFF: the system approves it, in the publish.
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { designApprovalGate: false },
    });
    await publish(design, 'v3');
    expect(await stateOf(code.id)).toEqual({ resumeState: 'ready_to_resume', resumeRunId: runId });
  });

  it('a status move out of the category takes the card off', async () => {
    const { code } = await gatedStory();
    await workItemsService.updateStatus(code.id, 'todo', fx.ctx);
    expect((await stateOf(code.id)).resumeState).toBeNull();
  });

  it('delivering the card (In Progress → Implemented) takes it off To resume (MOTIR-8611)', async () => {
    const { code } = await gatedStory();
    await deliveredPr(fx, code.id, await connectRepairRepo(fx, 'motir-core'), {
      headRef: `subtask/${code.identifier}`,
    });
    expect((await stateOf(code.id)).resumeState).toBe('waiting_on_gate');
    await workItemsService.updateStatus(code.id, 'implemented', fx.ctx);
    expect((await stateOf(code.id)).resumeState).toBeNull();
  });

  it('archiving takes the card off, and unarchiving puts it back', async () => {
    const { code } = await gatedStory();
    await workItemsService.archiveWorkItem(code.id, fx.ctx);
    expect((await stateOf(code.id)).resumeState).toBeNull();
    await workItemsService.unarchiveWorkItem(code.id, fx.ctx);
    expect((await stateOf(code.id)).resumeState).toBe('waiting_on_gate');
  });
});

describe('the Workbench partition', () => {
  it('lists ONE entry per gated run, counts it, and removes its cards from In progress', async () => {
    const { parent, design, code, runId } = await gatedStory();
    const loose = await card('a card no run touched', { kind: 'task' });

    const toResume = await homeService.listToResume(hctx());
    expect(toResume.total).toBe(1);
    const [entry] = toResume.items;
    expect(entry).toMatchObject({
      id: parent.id,
      resumeState: 'waiting_on_gate',
      resumeRunId: runId,
    });
    expect(entry!.resumeMembers.map((m) => m.id).sort()).toEqual([design.id, code.id].sort());

    const inProgress = await homeService.listInProgress(hctx());
    expect(homePageItems(inProgress).map((r) => r.id)).toEqual([loose.id]);
    const toFix = await homeService.listToFix(hctx());
    expect(toFix.total).toBe(0);

    const counts = await homeService.tabCounts(hctx());
    expect(counts).toMatchObject({ toResume: 1, inProgress: 1, toFix: 0 });
    expect(counts.myWork).toBe(counts.toDo + 1 + 3);
  });

  it('the entry carries its run: where it ran, and each held gate as it stands now (MOTIR-7712)', async () => {
    const { design, held } = await gatedStory();
    const [waiting] = (await homeService.listToResume(hctx())).items;
    expect(waiting!.resumeRun).toMatchObject({
      ranWhere: 'terminal',
      ranById: fx.ownerId,
      gates: [
        {
          gateId: held.id,
          kind: held.kind,
          state: 'awaiting',
          subjectKey: design.identifier,
          subjectTitle: design.title,
          deciderId: design.assigneeId ?? design.reporterId,
          decidedById: null,
          decidedAt: null,
          notePreview: null,
        },
      ],
    });
    // Waiting: the claim would refuse, so no door is offered.
    expect(waiting!.canContinueHosted).toBe(false);

    await adminDb.approvalGate.update({
      where: { id: held.id },
      data: { state: 'approved', decidedById: fx.ownerId, decidedAt: new Date() },
    });
    await withWorkspaceContext(fx.ctx, async (tx) => {
      for (const row of await adminDb.workItem.findMany({
        where: { resumeRunId: { not: null } },
      })) {
        await recomputeWorkItemResumeState(row.id, tx);
      }
    });
    const [ready] = (await homeService.listToResume(hctx())).items;
    expect(ready!.resumeState).toBe('ready_to_resume');
    // Ready, and the reader may edit: the Continue door is offered.
    expect(ready!.canContinueHosted).toBe(true);
  });

  it('a gate sent back is drawn with its decider and the first line of its note', async () => {
    const { held } = await gatedStory();
    await adminDb.approvalGate.update({
      where: { id: held.id },
      data: {
        state: 'changes_requested',
        decidedById: fx.ownerId,
        decidedAt: new Date(),
        noteMd: 'Tighten the spacing\nsecond line',
      },
    });
    const [sentBack] = (await homeService.listToResume(hctx())).items;
    expect(sentBack!.resumeRun!.gates[0]).toMatchObject({
      state: 'changes_requested',
      decidedById: fx.ownerId,
      notePreview: 'Tighten the spacing',
    });
  });

  it('the item page reads the same gated run: the scope card, and a leg pointing up (MOTIR-7713)', async () => {
    const { resumeRunDetailService } = await import('@/lib/services/resumeRunDetailService');
    const { parent, code, design, runId } = await gatedStory();
    const onParent = await resumeRunDetailService.readForWorkItem(parent.id, fx.ctx);
    expect(onParent).toMatchObject({
      state: 'waiting_on_gate',
      runId,
      parent: null,
      resumedRunId: null,
    });
    expect(onParent!.run.gates.map((g) => g.subjectKey)).toEqual([design.identifier]);
    const decider = design.assigneeId ?? design.reporterId;
    expect(onParent!.names[decider]).toEqual(expect.any(String));

    const onLeg = await resumeRunDetailService.readForWorkItem(code.id, fx.ctx);
    expect(onLeg).toMatchObject({ runId, parent: { key: parent.identifier } });

    const loose = await card('never ran', { kind: 'task' });
    expect(await resumeRunDetailService.readForWorkItem(loose.id, fx.ctx)).toBeNull();
  });

  it('a page mixes states: the door is offered only on a released entry the reader may edit, read off its newest attempt', async () => {
    const waiting = await gatedStory();
    const ready = await gatedStory();
    await adminDb.approvalGate.update({
      where: { id: ready.held.id },
      data: { state: 'approved', decidedById: fx.ownerId, decidedAt: new Date() },
    });
    await recompute(ready.parent.id);
    // Two attempts on the ready run — the NEWER one is what the entry reads.
    const older = await gate(ready.design, 'approved');
    await adminDb.gateResume.create({
      data: {
        workspaceId: fx.workspaceId,
        gateId: older.id,
        runId: ready.runId,
        outcome: 'skipped',
        skipReason: 'models_unavailable',
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    await adminDb.gateResume.create({
      data: {
        workspaceId: fx.workspaceId,
        gateId: ready.held.id,
        runId: ready.runId,
        outcome: 'skipped',
        skipReason: 'out_of_credits',
      },
    });

    const items = (await homeService.listToResume(hctx())).items;
    const byId = new Map(items.map((row) => [row.id, row]));
    expect(byId.get(ready.parent.id)).toMatchObject({
      resumeState: 'ready_to_resume',
      resumeAttempt: { outcome: 'skipped', skipReason: 'out_of_credits' },
      canContinueHosted: true,
    });
    expect(byId.get(waiting.parent.id)!.canContinueHosted).toBe(false);

    // A reader who may NOT edit the project sees the entries and no door.
    const viewer = await createTestUser({ email: `viewer-${Date.now()}@example.com` });
    await workspacesService.addMember({ userId: viewer.id, workspaceId: fx.workspaceId });
    await setWorkspaceRoleFor(viewer.id, fx.workspaceId, 'viewer');
    await adminDb.workItem.updateMany({
      where: { id: { in: [waiting.parent.id, ready.parent.id] } },
      data: { assigneeId: viewer.id },
    });
    const asViewer = await homeService.listToResume({
      userId: viewer.id,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    expect(asViewer.items.map((row) => row.id).sort()).toEqual(
      [waiting.parent.id, ready.parent.id].sort(),
    );
    expect(asViewer.items.every((row) => !row.canContinueHosted)).toBe(true);
  });

  it('To fix wins when a card somehow holds both', async () => {
    const { parent } = await gatedStory();
    await adminDb.workItem.update({
      where: { id: parent.id },
      data: { fixReason: 'ci_failed' },
    });
    const toResume = await homeService.listToResume(hctx());
    expect(toResume.items.map((r) => r.id)).not.toContain(parent.id);
    // …and its run is no entry at all — no leg heads it (MOTIR-8011).
    expect(toResume.total).toBe(0);
  });
});

// MOTIR-8011 — TO FIX WINS OVER TO RESUME, AT THE RUN TARGET. A scoped run whose scope
// card is not itself waiting on it is no entry at all: no leg promoted to head it, no
// count in the badge, and no resume on a leg's page.
describe('a run whose target is not waiting to resume (MOTIR-8011)', () => {
  async function openRunOn(cards: WorkItem[], command: 'run' | 'batch'): Promise<string> {
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command,
        reportedBy: 'cli',
        cards: cards.map((c) => ({ key: c.identifier, disposition: 'queued' as const })),
      },
      fx.ctx,
    );
    return run.id;
  }

  async function expectNoEntry() {
    const toResume = await homeService.listToResume(hctx());
    expect(toResume.items).toEqual([]);
    expect(toResume.total).toBe(0);
    expect((await homeService.tabCounts(hctx())).toResume).toBe(0);
  }

  it('the scope card on To fix takes the whole entry with it — no leg heads it', async () => {
    const { parent, design, code, runId } = await gatedStory();
    // The legs still wait on the run; only the target moved to To fix.
    await adminDb.workItem.update({ where: { id: parent.id }, data: { fixReason: 'ci_failed' } });
    for (const id of [design.id, code.id]) {
      expect((await stateOf(id)).resumeRunId).toBe(runId);
    }

    await expectNoEntry();
    const toFix = await homeService.listToFix(hctx());
    expect(toFix.items.map((r) => r.id)).toEqual([parent.id]);
  });

  it('a newer run on the scope card (a repair) takes the entry too, while the legs still read the gated run', async () => {
    const { parent, design, code, runId } = await gatedStory();
    await openRunOn([parent], 'run');
    expect(await stateOf(parent.id)).toEqual({ resumeState: null, resumeRunId: null });
    for (const id of [design.id, code.id]) {
      expect(await stateOf(id)).toEqual({ resumeState: 'waiting_on_gate', resumeRunId: runId });
    }

    await expectNoEntry();
  });

  it('only the run whose target left is dropped — the page, the total and the badge agree', async () => {
    const gone = await gatedStory();
    const kept = await gatedStory();
    await adminDb.workItem.update({
      where: { id: gone.parent.id },
      data: { fixReason: 'ci_failed' },
    });
    const toResume = await homeService.listToResume(hctx());
    expect(toResume.items.map((r) => r.id)).toEqual([kept.parent.id]);
    expect(toResume.total).toBe(1);
    expect((await homeService.tabCounts(hctx())).toResume).toBe(1);
  });

  it('the scope card heads its entry even when the reader holds only a leg', async () => {
    const { parent, code } = await gatedStory();
    const other = await createTestUser({ email: `other-${Date.now()}@example.com` });
    await workspacesService.addMember({ userId: other.id, workspaceId: fx.workspaceId });
    await adminDb.workItem.update({
      where: { id: parent.id },
      data: { assigneeId: other.id, reporterId: other.id },
    });
    const [entry] = (await homeService.listToResume(hctx())).items;
    expect(entry!.id).toBe(parent.id);
    expect(entry!.resumeMembers.map((m) => m.id)).toContain(code.id);
  });

  it('a scope-less batch run has no single target: its first card still heads it', async () => {
    const a = await card('batch card a', { kind: 'task' });
    const b = await card('batch card b', { kind: 'task' });
    const runId = await openRunOn([a, b], 'batch');
    await gate(a);
    await dispatchRunService.close(runId, { stopReason: 'gated' }, fx.ctx);
    await adminDb.workItem.update({ where: { id: a.id }, data: { fixReason: 'ci_failed' } });

    const toResume = await homeService.listToResume(hctx());
    expect(toResume.total).toBe(1);
    expect(toResume.items.map((r) => r.id)).toEqual([b.id]);
    expect(toResume.items[0]!.resumeMembers).toEqual([]);
    expect((await homeService.tabCounts(hctx())).toResume).toBe(1);
  });

  it('a leg’s item page offers no resume once its target is on To fix', async () => {
    const { resumeRunDetailService } = await import('@/lib/services/resumeRunDetailService');
    const { parent, code } = await gatedStory();
    await adminDb.workItem.update({ where: { id: parent.id }, data: { fixReason: 'ci_failed' } });
    expect(await resumeRunDetailService.readForWorkItem(code.id, fx.ctx)).toBeNull();
    expect(await resumeRunDetailService.readForWorkItem(parent.id, fx.ctx)).toBeNull();
  });

  it('a leg’s item page offers no resume once a newer run holds its target', async () => {
    const { resumeRunDetailService } = await import('@/lib/services/resumeRunDetailService');
    const { parent, code } = await gatedStory();
    await openRunOn([parent], 'run');
    expect(await resumeRunDetailService.readForWorkItem(code.id, fx.ctx)).toBeNull();
  });
});

async function publish(design: WorkItem, label: string): Promise<string> {
  const pathname = `${designPrefix(fx.workspaceId, design.id)}${label}.mock.html`;
  store.set(pathname, { contentType: 'text/html', size: 2048 });
  const notePathname = `${designPrefix(fx.workspaceId, design.id)}${label}.design-notes.md`;
  store.set(notePathname, { contentType: 'text/markdown', size: 512 });
  await ensureWorkWaitsOn(design.id, fx);
  const evidence = await designEvidenceService.recordFromPathnames(
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
  return evidence.id;
}

describe('the run detail’s edges (MOTIR-7712 · MOTIR-7713)', () => {
  it('names where a run ran in four words', async () => {
    const { ranWhereOf } = await import('@/lib/services/resumeRunDetailService');
    expect(ranWhereOf({ origin: 'hosted', reportedBy: 'cli' })).toBe('hosted');
    expect(ranWhereOf({ origin: 'instance', reportedBy: 'cli' })).toBe('instance');
    expect(ranWhereOf({ origin: 'local', reportedBy: 'agent' })).toBe('runbook');
    expect(ranWhereOf({ origin: 'local', reportedBy: 'cli' })).toBe('terminal');
  });

  it('an unknown run, a head off the run, and a dispatcher gone read as nothing to name', async () => {
    const { describeResumeRun } = await import('@/lib/services/resumeRunDetailService');
    const { design, runId } = await gatedStory();
    const loose = await card('not on the run', { kind: 'task' });
    await adminDb.workItem.update({ where: { id: design.id }, data: { assigneeId: null } });
    await adminDb.dispatchRun.update({ where: { id: runId }, data: { createdById: null } });
    await withWorkspaceContext(fx.ctx, async (tx) => {
      expect(await describeResumeRun('no-such-run', loose.id, tx)).toBeNull();
      const off = await describeResumeRun(runId, loose.id, tx);
      expect(off).toMatchObject({ branch: null, ranById: null, ranByName: null });
      // Unassigned: the reporter decides.
      expect(off!.gates[0]!.deciderId).toBe(design.reporterId);
    });
  });

  it('a LEAF gated run is read on its own card, and an unknown card reads null', async () => {
    const { resumeRunDetailService } = await import('@/lib/services/resumeRunDetailService');
    const leaf = await card('a leaf', { kind: 'task' });
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: leaf.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await gate(leaf);
    await dispatchRunService.close(run.id, { stopReason: 'gated' }, fx.ctx);
    expect(await resumeRunDetailService.readForWorkItem(leaf.id, fx.ctx)).toMatchObject({
      state: 'waiting_on_gate',
      runId: run.id,
      parent: null,
    });
    expect(await resumeRunDetailService.readForWorkItem('no-such-card', fx.ctx)).toBeNull();
  });

  it('Resuming is read only from a live continue that says it resumes a gated run', async () => {
    const { resumeRunDetailService } = await import('@/lib/services/resumeRunDetailService');
    const { parent, design, code, runId } = await gatedStory();
    // The continue claim clears the column; the live continue is what remains.
    await adminDb.workItem.updateMany({
      where: { id: { in: [parent.id, design.id, code.id] } },
      data: { resumeState: null, resumeRunId: null },
    });
    const continueRun = (opened: { [key: string]: string | boolean } | null) =>
      adminDb.dispatchRun.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          command: 'continue',
          origin: 'local',
          status: 'running',
          createdById: fx.ownerId,
          scopeWorkItemId: parent.id,
          cards: {
            create: {
              workspaceId: fx.workspaceId,
              workItemId: parent.id,
              workItemKey: parent.identifier,
              position: 0,
            },
          },
          ...(opened
            ? {
                events: {
                  create: { workspaceId: fx.workspaceId, seq: 1, kind: 'run_opened', data: opened },
                },
              }
            : {}),
        },
      });
    const read = () => resumeRunDetailService.readForWorkItem(parent.id, fx.ctx);

    await continueRun(null);
    expect(await read()).toBeNull();
    await continueRun({ continuesRunId: runId, resumesGated: false });
    expect(await read()).toBeNull();
    const live = await continueRun({ continuesRunId: runId, resumesGated: true });
    expect(await read()).toMatchObject({
      state: 'resuming',
      runId,
      resumedRunId: live.id,
      attempt: null,
    });
  });
});

describe('the backfill', () => {
  it('the dry run reports the cards it would set, writes nothing, and the apply is idempotent', async () => {
    const { workItemResumeStateBackfillService } =
      await import('@/lib/services/workItemResumeStateBackfillService');
    const { parent, code, runId } = await gatedStory();
    // As a card that predates the column reads: nothing stored.
    await adminDb.workItem.updateMany({
      where: { id: { in: [parent.id, code.id] } },
      data: { resumeState: null, resumeRunId: null },
    });

    const dry = await workItemResumeStateBackfillService.backfillResumeState({
      dryRun: true,
      workspaceId: fx.workspaceId,
    });
    expect(dry.changed.map((c) => c.workItemId)).toEqual(
      expect.arrayContaining([parent.id, code.id]),
    );
    expect(dry.changed.every((c) => c.from === null && c.to === 'waiting_on_gate')).toBe(true);
    expect((await stateOf(parent.id)).resumeState).toBeNull();

    const applied = await workItemResumeStateBackfillService.backfillResumeState({
      dryRun: false,
      workspaceId: fx.workspaceId,
    });
    expect(applied.changed.map((c) => c.workItemId).sort()).toEqual(
      dry.changed.map((c) => c.workItemId).sort(),
    );
    expect(await stateOf(parent.id)).toEqual({
      resumeState: 'waiting_on_gate',
      resumeRunId: runId,
    });

    const again = await workItemResumeStateBackfillService.backfillResumeState({
      dryRun: false,
      workspaceId: fx.workspaceId,
    });
    expect(again.changed).toEqual([]);
    expect(again.failed).toEqual([]);
  });

  it('with no workspace named it scans every workspace, and a card that throws is reported', async () => {
    const { workItemResumeStateBackfillService } =
      await import('@/lib/services/workItemResumeStateBackfillService');
    const { workItemRepository } = await import('@/lib/repositories/workItemRepository');
    const { parent } = await gatedStory();
    await adminDb.workItem.update({
      where: { id: parent.id },
      data: { resumeState: null, resumeRunId: null },
    });
    const real = workItemRepository.findById.bind(workItemRepository);
    const spy = vi
      .spyOn(workItemRepository, 'findById')
      .mockImplementation(async (id: string, tx?: Parameters<typeof real>[1]) => {
        if (id === parent.id) throw new Error('row is unreadable');
        return real(id, tx);
      });
    try {
      const report = await workItemResumeStateBackfillService.backfillResumeState({ dryRun: true });
      expect(report.failed).toEqual([{ workItemId: parent.id, error: 'row is unreadable' }]);
      expect(report.scanned).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the derivation’s edges', () => {
  it('a card that does not exist recomputes to nothing', async () => {
    expect(await recompute('no-such-card')).toEqual({ resumeState: null, resumeRunId: null });
  });

  it('two held rows for one card and kind are one gate — the latest', async () => {
    const { design, runId, held } = await gatedStory();
    const second = await gate(design, 'approved');
    await adminDb.approvalGate.update({ where: { id: held.id }, data: { state: 'superseded' } });
    await adminDb.dispatchRunHeldGate.create({
      data: {
        workspaceId: fx.workspaceId,
        dispatchRunId: runId,
        gateId: second.id,
        workItemId: design.id,
        kind: 'design_result',
      },
    });
    const verdict = await withWorkspaceContext(fx.ctx, (tx) => readHeldGateVerdict(runId, tx));
    expect(verdict.verdict).toBe('released');
    expect(verdict.released.map((r) => r.gateId)).toEqual([second.id]);
    expect([...verdict.waiting, ...verdict.sentBack]).toEqual([]);
  });

  it('a decision on a LEAF run’s gate recomputes the leaf (no scope)', async () => {
    const leaf = await card('a leaf', { kind: 'task' });
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: leaf.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    const held = await gate(leaf);
    await dispatchRunService.close(run.id, { stopReason: 'gated' }, fx.ctx);
    expect((await stateOf(leaf.id)).resumeState).toBe('waiting_on_gate');
    await adminDb.approvalGate.update({
      where: { id: held.id },
      data: { state: 'approved', decidedById: fx.ownerId, decidedAt: new Date() },
    });

    await resumeStateService.afterGateDecided(leaf.id, fx.ctx);

    expect(await stateOf(leaf.id)).toEqual({ resumeState: 'ready_to_resume', resumeRunId: run.id });
  });
});

// ── MOVING AGAIN (Story MOTIR-10305 · MOTIR-10308) ───────────────────────────────────
// CI that STARTED on a card's delivery set after its gated run ended takes the card off
// To resume: somebody pushed, so it is moving again and is listed under In progress.

/** A leaf card whose own `run` stopped `gated` at an awaiting gate. */
async function gatedLeaf() {
  const leaf = await card(`a leaf ${Math.random()}`, { kind: 'task' });
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      cards: [{ key: leaf.identifier, disposition: 'queued' }],
    },
    fx.ctx,
  );
  await gate(leaf);
  await dispatchRunService.close(run.id, { stopReason: 'gated' }, fx.ctx);
  expect(await stateOf(leaf.id)).toEqual({ resumeState: 'waiting_on_gate', resumeRunId: run.id });
  return { leaf, runId: run.id };
}

describe('moving again — CI started after the gated run ended (MOTIR-10308)', () => {
  it('a check row created after the stop clears it: listed under In progress, To resume one lower', async () => {
    const { leaf } = await gatedLeaf();
    const before = await homeService.tabCounts(hctx());
    await deliveredPr(fx, leaf.id, await connectRepairRepo(fx, 'motir-core'), {
      headRef: `subtask/${leaf.identifier}`,
      checks: { Vitest: 'pending' },
    });

    expect(await recompute(leaf.id)).toEqual({ resumeState: null, resumeRunId: null });
    expect(await stateOf(leaf.id)).toEqual({ resumeState: null, resumeRunId: null });
    const after = await homeService.tabCounts(hctx());
    expect(after.toResume).toBe(before.toResume - 1);
    expect(after.inProgress).toBe(before.inProgress + 1);
    expect(homePageItems(await homeService.listInProgress(hctx())).map((r) => r.id)).toContain(
      leaf.id,
    );
    expect((await homeService.listToResume(hctx())).items.map((r) => r.id)).not.toContain(leaf.id);
  });

  it('a pull request already open at the stop, with every row before it, still waits — and a status move does not count', async () => {
    const leaf = await card('open at the stop', { kind: 'task' });
    const pr = await deliveredPr(fx, leaf.id, await connectRepairRepo(fx, 'motir-core'), {
      headRef: `subtask/${leaf.identifier}`,
      checks: { Vitest: 'success' },
    });
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: leaf.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await gate(leaf);
    await dispatchRunService.close(run.id, { stopReason: 'gated' }, fx.ctx);
    const waiting = { resumeState: 'waiting_on_gate', resumeRunId: run.id };
    expect(await recompute(leaf.id)).toEqual(waiting);

    // A status move within the category writes no check row.
    await workItemsService.updateStatus(leaf.id, 'todo', fx.ctx);
    await workItemsService.updateStatus(leaf.id, 'in_progress', fx.ctx);
    expect(await stateOf(leaf.id)).toEqual(waiting);

    // …and a re-run of jobs in the SAME suite, after the stop, is a start: the row goes
    // back to pending with its `createdAt` unchanged.
    const [row] = await adminDb.githubCheckRun.findMany({ where: { pullRequestId: pr.id } });
    await adminDb.githubCheckRun.update({
      where: { id: row!.id },
      data: { conclusion: 'pending' },
    });
    expect(await recompute(leaf.id)).toEqual({ resumeState: null, resumeRunId: null });
  });

  it("the run's OWN last push, still being checked at the stop, does not clear it — a later re-run does", async () => {
    // The run pushed, then stopped at its gate while that push's CI was still running.
    const leaf = await card('own push still checking', { kind: 'task' });
    const pr = await deliveredPr(fx, leaf.id, await connectRepairRepo(fx, 'motir-core'), {
      headRef: `subtask/${leaf.identifier}`,
      checks: { Build: 'pending' },
    });
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: leaf.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await gate(leaf);
    await dispatchRunService.close(run.id, { stopReason: 'gated' }, fx.ctx);
    const waiting = { resumeState: 'waiting_on_gate', resumeRunId: run.id };
    expect(await stateOf(leaf.id)).toEqual(waiting);

    // That CI goes on after the stop: its pending row is written again (in progress), and
    // a job that waited on the build gets its first row — both AFTER `endedAt`.
    const [build] = await adminDb.githubCheckRun.findMany({ where: { pullRequestId: pr.id } });
    await adminDb.githubCheckRun.update({
      where: { id: build!.id },
      data: { conclusion: 'pending' },
    });
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: pr.id,
        commitSha: build!.commitSha,
        checkName: 'Vitest',
        conclusion: 'pending',
      },
    });
    expect(await recompute(leaf.id)).toEqual(waiting);

    // It finishes: still the run's own CI, still waiting.
    await adminDb.githubCheckRun.updateMany({
      where: { pullRequestId: pr.id },
      data: { conclusion: 'success' },
    });
    expect(await recompute(leaf.id)).toEqual(waiting);

    // A re-run of that settled CI is a start: the card is moving again.
    await adminDb.githubCheckRun.update({
      where: { id: build!.id },
      data: { conclusion: 'pending' },
    });
    expect(await recompute(leaf.id)).toEqual({ resumeState: null, resumeRunId: null });

    // …and it stays off through a status move and back: the snapshot latched.
    await workItemsService.updateStatus(leaf.id, 'todo', fx.ctx);
    await workItemsService.updateStatus(leaf.id, 'in_progress', fx.ctx);
    expect(await stateOf(leaf.id)).toEqual({ resumeState: null, resumeRunId: null });
  });

  it('a push after the stop, with CI reported at the new head, clears it', async () => {
    const leaf = await card('pushed after the stop', { kind: 'task' });
    const pr = await deliveredPr(fx, leaf.id, await connectRepairRepo(fx, 'motir-core'), {
      headRef: `subtask/${leaf.identifier}`,
      checks: { Build: 'success' },
    });
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: leaf.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await gate(leaf);
    await dispatchRunService.close(run.id, { stopReason: 'gated' }, fx.ctx);
    const waiting = { resumeState: 'waiting_on_gate', resumeRunId: run.id };

    // The host announces the push; no check has reported at the new head yet.
    const pushed = 'd'.repeat(40);
    await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { headSha: pushed } });
    expect(await recompute(leaf.id)).toEqual(waiting);

    await adminDb.githubCheckRun.create({
      data: { pullRequestId: pr.id, commitSha: pushed, checkName: 'Build', conclusion: 'pending' },
    });
    expect(await recompute(leaf.id)).toEqual({ resumeState: null, resumeRunId: null });
  });

  it('a card with no pull requests, or whose latest run was not gated, reads as before', async () => {
    const { leaf, runId } = await gatedLeaf();
    expect(await recompute(leaf.id)).toEqual({
      resumeState: 'waiting_on_gate',
      resumeRunId: runId,
    });
    const loose = await card('no run', { kind: 'task' });
    await deliveredPr(fx, loose.id, await connectRepairRepo(fx, 'motir-ai'), {
      headRef: `subtask/${loose.identifier}`,
      checks: { Vitest: 'pending' },
    });
    expect(await recompute(loose.id)).toEqual({ resumeState: null, resumeRunId: null });
  });

  it('the backfill converges a stored card to the live answer, and its dry run reports the clear', async () => {
    const { workItemResumeStateBackfillService } =
      await import('@/lib/services/workItemResumeStateBackfillService');
    const { leaf } = await gatedLeaf();
    // A row written by CI with no recompute after it — a card stored before this change.
    const pr = await deliveredPr(fx, leaf.id, await connectRepairRepo(fx, 'motir-core'), {
      headRef: `subtask/${leaf.identifier}`,
    });
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: pr.id,
        commitSha: 'f'.repeat(40),
        checkName: 'Vitest',
        conclusion: 'pending',
      },
    });
    expect((await stateOf(leaf.id)).resumeState).toBe('waiting_on_gate');

    const dry = await workItemResumeStateBackfillService.backfillResumeState({
      dryRun: true,
      workspaceId: fx.workspaceId,
    });
    expect(dry.changed).toEqual([
      { workItemId: leaf.id, identifier: leaf.identifier, from: 'waiting_on_gate', to: null },
    ]);
    expect((await stateOf(leaf.id)).resumeState).toBe('waiting_on_gate');

    const applied = await workItemResumeStateBackfillService.backfillResumeState({
      dryRun: false,
      workspaceId: fx.workspaceId,
    });
    expect(applied.changed).toEqual(dry.changed);
    expect(await stateOf(leaf.id)).toEqual(await recompute(leaf.id));
    expect(await stateOf(leaf.id)).toEqual({ resumeState: null, resumeRunId: null });
  });
});

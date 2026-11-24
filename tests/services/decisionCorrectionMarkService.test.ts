import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionDocOutcome } from '@/generated/prisma/client';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';

// THE DECISION-CORRECTION MARK (Subtask MOTIR-12175, story MOTIR-10139).
//
// When a decision card is approved or confirmed AFTER it was corrected at its gate,
// the work planned against the old version is marked: a not-started dependent moves
// to To plan with one comment, a started one keeps its status and gets the comment.
// Driven through the real decide door, against the real database, with the fixture
// the story's integration gate and E2E build on: decision D published, republished
// (its first gate superseded `republished`), then approved; S1 `blocked_by` D with a
// child; S2 `blocked_by` S1 at In Progress.
//
// `sendEvent` is wrapped, not stubbed: every event still reaches `job_event`, and
// each one is checked, AT THE MOMENT IT IS SENT, against a separate connection — a
// comment or a move it announces must already be committed and visible.

const afterCommitViolations: string[] = [];

vi.mock('@/lib/jobs/sendEvent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/jobs/sendEvent')>();
  const { adminDb: probe } = await import('../helpers/adminDb');
  return {
    ...original,
    sendEvent: async (name: string, data: Record<string, unknown>) => {
      if (name === 'work-item/comment.created') {
        const row = await probe.comment.findUnique({ where: { id: data.commentId as string } });
        if (!row) afterCommitViolations.push(`comment ${String(data.commentId)} not committed`);
      }
      if (name === 'work-item/transitioned') {
        // The hop's revision is written with the move: visible only once it committed.
        const row = await probe.workItemRevision.findUnique({
          where: { id: data.revisionId as string },
        });
        if (!row) afterCommitViolations.push(`move of ${String(data.workItemId)} not committed`);
      }
      return (original.sendEvent as (n: string, d: unknown) => Promise<unknown>)(name, data);
    },
  };
});

const { db } = await import('@/lib/db');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { decisionPageService } = await import('@/lib/services/decisionPageService');
const { pagesService } = await import('@/lib/services/pagesService');
const { parentStatusRollupService } = await import('@/lib/services/parentStatusRollupService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { IllegalTransitionError } = await import('@/lib/workItems/errors');
const {
  composeMarkComment,
  describeDecidedVersion,
  decisionCorrectionMarkService,
  runDecisionCorrectionMark,
  wasCorrectedBefore,
} = await import('@/lib/services/decisionCorrectionMarkService');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { makeWorkItemFixture } = await import('../fixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

type Fixture = Awaited<ReturnType<typeof makeWorkItemFixture>>;
let fx: Fixture;
let seq = 0;

const DB_TEST_TIMEOUT_MS = 60_000;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  afterCommitViolations.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(afterCommitViolations).toEqual([]);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── helpers ──────────────────────────────────────────────────────────────────

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

async function card(
  title: string,
  extra: {
    kind?: 'task' | 'story' | 'epic';
    parentId?: string;
    type?: 'decision' | 'code';
    executor?: 'coding_agent' | 'human';
    descriptionMd?: string;
    projectId?: string;
  } = {},
) {
  seq += 1;
  return workItemsService.createWorkItem(
    {
      projectId: extra.projectId ?? fx.projectId,
      kind: extra.kind ?? 'task',
      title: `${title} ${seq}`,
      ...(extra.parentId ? { parentId: extra.parentId } : {}),
      ...(extra.type ? { type: extra.type } : {}),
      ...(extra.executor ? { executor: extra.executor } : {}),
      ...(extra.descriptionMd ? { descriptionMd: extra.descriptionMd } : {}),
    },
    fx.ctx,
  );
}

const blockedBy = (fromId: string, toId: string) =>
  workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, fx.ctx);

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

const commentsOn = (workItemId: string) =>
  adminDb.comment.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });

const gatesOf = (workItemId: string, kind: 'decision_approval' | 'decision_confirmation') =>
  adminDb.approvalGate.findMany({ where: { workItemId, kind }, orderBy: { createdAt: 'asc' } });

const decideGate = (gateId: string, decision: 'approve' | 'request_changes') =>
  approvalGatesService.decide(
    {
      stamp: DECIDED_WITHOUT_A_READER,
      gateId,
      decision,
      source: 'ui',
      noteMd: decision === 'request_changes' ? 'Not this option.' : null,
    },
    fx.ctx,
  );

async function awaitingGateOf(workItemId: string, kind: 'decision_approval') {
  return adminDb.approvalGate.findFirstOrThrow({
    where: { workItemId, kind, state: 'awaiting' },
  });
}

/** An agent's PAGE decision, published once. */
async function pageDecision() {
  const decision = await card('Decide', { type: 'decision', executor: 'coding_agent' });
  const page = await pagesService.createPageFromMarkdown(fx.ctx, {
    projectId: fx.projectId,
    title: 'Storage model',
    markdown: '# Storage model\n\nWe pick option A.',
  });
  await decisionPageService.publish({ workItemId: decision.id, pageId: page.id }, fx.ctx);
  return { decision, page };
}

/** Edit the page and publish it again — a CORRECTION when an earlier gate awaits. */
async function republish(decisionId: string, pageId: string) {
  const current = await pagesService.getPageMarkdown(fx.ctx, { projectId: fx.projectId, pageId });
  await pagesService.savePageMarkdown(fx.ctx, {
    projectId: fx.projectId,
    pageId,
    markdown: '# Storage model\n\nWe pick option B.',
    expectedRevision: current.revision,
  });
  await decisionPageService.publish({ workItemId: decisionId, pageId }, fx.ctx);
}

/**
 * THE HANDED-ON FIXTURE: S1 `blocked_by` D with a child C1; S2 `blocked_by` S1 at In
 * Progress — all written BEFORE D is republished — then D republished.
 */
async function handoffFixture() {
  const { decision, page } = await pageDecision();
  const s1 = await card('S1', { kind: 'story', descriptionMd: 'Store it per option A.' });
  const c1 = await card('C1', { parentId: s1.id, descriptionMd: 'Build option A.' });
  const s2 = await card('S2', { kind: 'story', descriptionMd: 'Read it per option A.' });
  await blockedBy(s1.id, decision.id);
  await blockedBy(s2.id, s1.id);
  await adminDb.workItem.update({ where: { id: s2.id }, data: { status: 'in_progress' } });
  await tick();
  await republish(decision.id, page.id);
  return { decision, page, s1, c1, s2 };
}

/** Run `act` with the mark spied on, returning what each mark call answered. */
async function withMarkSpy<T>(act: () => Promise<T>) {
  const spy = vi.spyOn(decisionCorrectionMarkService, 'markForDecidedGate');
  const result = await act();
  const answers = await Promise.all(spy.mock.results.map((r) => r.value));
  return { result, spy, answers };
}

// ── the pure reads ───────────────────────────────────────────────────────────

describe('wasCorrectedBefore — a correction is read off the gate history', () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 10, 24, 0, 0, 0, ms));
  const deciding = {
    id: 'g2',
    state: 'approved' as const,
    supersededCause: null,
    subjectVersion: 'v2',
    createdAt: at(10),
  };
  const earlier = (over: Record<string, unknown>) => ({
    id: 'g1',
    state: 'superseded' as const,
    supersededCause: null,
    subjectVersion: 'v1',
    createdAt: at(1),
    ...over,
  });

  it.each(['republished', 'head_moved'])('a supersede caused by %s IS a correction', (cause) => {
    expect(wasCorrectedBefore(deciding, [earlier({ supersededCause: cause }), deciding])).toBe(
      true,
    );
  });

  it('a send-back IS a correction', () => {
    expect(wasCorrectedBefore(deciding, [earlier({ state: 'changes_requested' }), deciding])).toBe(
      true,
    );
  });

  it.each([
    'pulled_back',
    'ci_failed',
    'ci_rerunning',
    'conflict',
    'member_closed',
    'member_drafted',
    'set_changed',
    'withdrawn',
    'unknown',
  ])('a supersede caused by %s is NOT a correction', (cause) => {
    expect(wasCorrectedBefore(deciding, [earlier({ supersededCause: cause }), deciding])).toBe(
      false,
    );
  });

  it('a re-ask on the SAME version is not a correction', () => {
    expect(
      wasCorrectedBefore(deciding, [
        earlier({ supersededCause: 'republished', subjectVersion: 'v2' }),
        deciding,
      ]),
    ).toBe(false);
  });

  it('a corrective row with no version counts', () => {
    expect(
      wasCorrectedBefore(deciding, [
        earlier({ supersededCause: 'republished', subjectVersion: null }),
        deciding,
      ]),
    ).toBe(true);
  });

  it('only an EARLIER gate counts — never the deciding one, nor a later one', () => {
    expect(wasCorrectedBefore(deciding, [deciding])).toBe(false);
    expect(
      wasCorrectedBefore(deciding, [
        deciding,
        earlier({ id: 'g3', state: 'changes_requested', createdAt: at(20) }),
      ]),
    ).toBe(false);
  });
});

describe('composeMarkComment — the wording handed on to the test gates', () => {
  const base = {
    decisionIdentifier: 'PROD-7',
    decisionId: 'abc',
    versionLabel: 'version 2 of Storage model',
    descriptionWrittenAt: new Date('2026-11-20T10:00:00Z'),
  };

  it('a not-started item is asked to re-plan', () => {
    expect(composeMarkComment({ ...base, started: false })).toBe(
      "**Planned against an earlier version of [PROD-7](motir:abc).** That decision was corrected and then approved on version 2 of Storage model, after this work item's description was last written (2026-11-20). Re-plan it so it matches the decision before it is built.",
    );
  });

  it('a started item is told its status was kept', () => {
    expect(composeMarkComment({ ...base, started: true })).toContain(
      'This work item has already started, so its status was kept — check its work against the decision.',
    );
  });
});

describe('describeDecidedVersion — the version named in the comment', () => {
  const gate = (over: Record<string, unknown>) => ({
    kind: 'decision_approval' as const,
    subjectVersion: null as string | null,
    decidedAt: null as Date | null,
    createdAt: new Date('2026-11-23T08:00:00Z'),
    ...over,
  });
  const describeIt = (over: Record<string, unknown>) =>
    withWorkspaceContext(fx.ctx, (tx) => describeDecidedVersion(gate(over) as never, tx));

  it('a confirmation with no decision time falls back to when it was raised', async () => {
    expect(await describeIt({ kind: 'decision_confirmation' })).toBe(
      'the confirmed text of 2026-11-23',
    );
  });

  it('a gate with no version, or one it cannot read, says "its approved version"', async () => {
    expect(await describeIt({})).toBe('its approved version');
    expect(await describeIt({ subjectVersion: 'no-separators' })).toBe('its approved version');
  });

  it('a page version that is gone names the page, or says "its page" when that is gone too', async () => {
    expect(await describeIt({ subjectVersion: 'page:missing-page@missing-version' })).toBe(
      'the approved version of its page',
    );
  });
});

// ── the trigger ──────────────────────────────────────────────────────────────

describe('decision_approval, PAGE arm — the handed-on fixture', () => {
  it(
    'moves S1 and its child to To plan, comments S2, and runs once after the commit',
    async () => {
      const { decision, s1, c1, s2 } = await handoffFixture();
      // Publishing and republishing marked nothing.
      for (const id of [s1.id, c1.id, s2.id]) expect(await commentsOn(id)).toEqual([]);
      const [first, second] = await gatesOf(decision.id, 'decision_approval');
      expect(first).toMatchObject({ state: 'superseded', supersededCause: 'republished' });

      const { result, spy, answers } = await withMarkSpy(() => decideGate(second!.id, 'approve'));

      expect(result.gate.state).toBe('approved');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(second!.id, fx.ctx);
      expect(answers[0]).toMatchObject({ gateId: second!.id, corrected: true });
      expect(
        Object.fromEntries(
          answers[0]!.items.map((i: { workItemId: string; outcome: string }) => [
            i.workItemId,
            i.outcome,
          ]),
        ),
      ).toEqual({ [s1.id]: 'moved', [s2.id]: 'commented', [c1.id]: 'moved' });

      expect(await statusOf(s1.id)).toBe('to_plan');
      expect(await statusOf(c1.id)).toBe('to_plan');
      expect(await statusOf(s2.id)).toBe('in_progress');

      const identifier = (await adminDb.workItem.findUniqueOrThrow({ where: { id: decision.id } }))
        .identifier;
      for (const id of [s1.id, c1.id]) {
        const comments = await commentsOn(id);
        expect(comments).toHaveLength(1);
        expect(comments[0]!.authorId).toBe(fx.ownerId);
        expect(comments[0]!.bodyMd).toContain(`[${identifier}](motir:${decision.id})`);
        expect(comments[0]!.bodyMd).toContain('version 2 of Storage model');
        expect(comments[0]!.bodyMd).toContain('Re-plan it so it matches the decision');
      }
      const started = await commentsOn(s2.id);
      expect(started).toHaveLength(1);
      expect(started[0]!.bodyMd).toContain('its status was kept');

      // Each move and each comment announced — after its commit (the wrapper checks).
      const events = await adminDb.jobEvent.findMany({
        where: { name: { in: ['work-item/transitioned', 'work-item/comment.created'] } },
      });
      const about = (name: string, id: string) =>
        events.filter(
          (e) => e.name === name && (e.data as { workItemId: string }).workItemId === id,
        );
      expect(about('work-item/comment.created', s1.id)).toHaveLength(1);
      expect(about('work-item/comment.created', s2.id)).toHaveLength(1);
      expect(
        about('work-item/transitioned', s1.id).map(
          (e) => (e.data as { toStatusKey: string }).toStatusKey,
        ),
      ).toEqual(['to_plan']);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a send-back followed by a corrected republish and an approval also marks',
    async () => {
      const { decision, page } = await pageDecision();
      const s = await card('S');
      await blockedBy(s.id, decision.id);
      await tick();
      const first = await awaitingGateOf(decision.id, 'decision_approval');
      const sentBack = await withMarkSpy(() => decideGate(first.id, 'request_changes'));
      expect(sentBack.spy).not.toHaveBeenCalled();
      await republish(decision.id, page.id);

      await decideGate((await awaitingGateOf(decision.id, 'decision_approval')).id, 'approve');

      expect(await statusOf(s.id)).toBe('to_plan');
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a decision approved on its FIRST gate marks nothing',
    async () => {
      const { decision } = await pageDecision();
      const s = await card('S');
      await blockedBy(s.id, decision.id);

      const { answers } = await withMarkSpy(async () =>
        decideGate((await awaitingGateOf(decision.id, 'decision_approval')).id, 'approve'),
      );

      expect(answers[0]).toMatchObject({ corrected: false, items: [] });
      expect(await statusOf(s.id)).toBe('todo');
      expect(await commentsOn(s.id)).toEqual([]);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it.each(['pulled_back', 'ci_failed', 'conflict', 'member_closed'] as const)(
    'an earlier gate withdrawn %s is not a correction — nothing is marked',
    async (cause) => {
      const { decision, page } = await pageDecision();
      const s = await card('S');
      await blockedBy(s.id, decision.id);
      const first = await awaitingGateOf(decision.id, 'decision_approval');
      await adminDb.approvalGate.update({
        where: { id: first.id },
        data: { state: 'superseded', supersededCause: cause },
      });
      await republish(decision.id, page.id);

      await decideGate((await awaitingGateOf(decision.id, 'decision_approval')).id, 'approve');

      expect(await statusOf(s.id)).toBe('todo');
      expect(await commentsOn(s.id)).toEqual([]);
    },
    DB_TEST_TIMEOUT_MS,
  );
});

describe('decision_approval, FILE arm', () => {
  interface Capture {
    outcome: DecisionDocOutcome;
    path: string;
    blobSha: string;
    headSha: string;
  }

  async function fileDecision(capture: Capture) {
    const item = await card('Decide', { type: 'decision', executor: 'coding_agent' });
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: fx.ownerId } });
    const installation = await adminDb.githubInstallation.create({
      data: {
        workspaceId: fx.workspaceId,
        installationId: `inst-mark-${seq}`,
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
        repoId: `repo-mark-${seq}`,
        owner: 'acme',
        name: 'web',
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    const pr = await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number: seq,
        title: 'Decide',
        state: 'open',
        headRef: `docs/decide-${seq}`,
        baseRef: 'main',
        provider: 'github',
        decisionDocOutcome: capture.outcome,
        decisionDocPath: capture.path,
        decisionDocBlobSha: capture.blobSha,
        decisionDocHeadSha: capture.headSha,
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: item.id,
        githubPullRequestId: pr.id,
        repoId: repo.id,
      },
    });
    return item;
  }

  const gate = (workItemId: string, data: Record<string, unknown>) =>
    adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId,
        kind: 'decision_approval',
        subjectId: workItemId,
        routedToId: fx.ownerId,
        ...data,
      },
    });

  it(
    'a head_moved correction on a different blob marks, naming the file and blob',
    async () => {
      const decision = await fileDecision({
        outcome: 'one',
        path: 'docs/decisions/storage.md',
        blobSha: 'b2c3d4e5f6a7',
        headSha: 'head-2',
      });
      const s = await card('S');
      await blockedBy(s.id, decision.id);
      await tick();
      await gate(decision.id, {
        state: 'superseded',
        supersededCause: 'head_moved',
        subjectVersion: 'acme/web:docs/decisions/storage.md@a1a1a1a1',
      });
      await tick();
      const deciding = await gate(decision.id, {
        subjectVersion: 'acme/web:docs/decisions/storage.md@b2c3d4e5f6a7',
      });

      const result = await decideGate(deciding.id, 'approve');

      expect(result.effect).toMatchObject({ statusDeferredReason: 'merge_writes_done' });
      expect(result.effect).not.toHaveProperty('afterCommit');
      expect(await statusOf(s.id)).toBe('to_plan');
      const [comment] = await commentsOn(s.id);
      expect(comment!.bodyMd).toContain('`docs/decisions/storage.md` at `b2c3d4e`');
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a head_moved supersede on the SAME blob is not a correction',
    async () => {
      const decision = await fileDecision({
        outcome: 'one',
        path: 'docs/decisions/storage.md',
        blobSha: 'same-blob',
        headSha: 'head-2',
      });
      const s = await card('S');
      await blockedBy(s.id, decision.id);
      await gate(decision.id, {
        state: 'superseded',
        supersededCause: 'head_moved',
        subjectVersion: 'acme/web:docs/decisions/storage.md@same-blob',
      });
      await tick();
      const deciding = await gate(decision.id, {
        subjectVersion: 'acme/web:docs/decisions/storage.md@same-blob',
      });

      await decideGate(deciding.id, 'approve');

      expect(await statusOf(s.id)).toBe('todo');
      expect(await commentsOn(s.id)).toEqual([]);
    },
    DB_TEST_TIMEOUT_MS,
  );
});

describe('decision_confirmation', () => {
  const RECORD = [
    '## Decision',
    'Exports move to managed object storage.',
    '## What changed',
    '**Change:** workflow · less requirement',
    'The approved plan kept exports in Postgres.',
    '## Supersedes',
    'MOTIR-6 and MOTIR-7',
    '## Resulting direction',
    'Every export is written to the bucket.',
  ].join('\n');

  async function confirmDecision(itemId: string, verb: 'approve' | 'overturn') {
    const read = await approvalGatesService.getForWorkItem(
      { workItemId: itemId, kind: 'decision_confirmation' },
      fx.ctx,
    );
    return approvalGatesService.decide(
      {
        gateId: read.gate!.id,
        decision: verb,
        source: 'ui',
        stamp: read.stamp!,
        ...(verb === 'overturn' ? { noteMd: 'Not what we agreed.' } : {}),
      },
      fx.ctx,
    );
  }

  async function correctedConfirmation() {
    const decision = await card('Decide', {
      type: 'decision',
      executor: 'human',
      descriptionMd: RECORD,
    });
    const s = await card('S', { descriptionMd: 'Write exports to Postgres.' });
    await blockedBy(s.id, decision.id);
    await tick();
    await workItemsService.updateWorkItem(
      decision.id,
      { descriptionMd: RECORD.replace('the bucket.', 'the bucket, with a link.') },
      fx.ctx,
    );
    const gates = await gatesOf(decision.id, 'decision_confirmation');
    expect(gates.map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'republished'],
      ['awaiting', null],
    ]);
    return { decision, s };
  }

  it(
    'confirming a corrected decision marks its dependents, naming the confirmed text',
    async () => {
      const { decision, s } = await correctedConfirmation();

      const { spy } = await withMarkSpy(() => confirmDecision(decision.id, 'approve'));

      expect(spy).toHaveBeenCalledTimes(1);
      expect(await statusOf(s.id)).toBe('to_plan');
      const [comment] = await commentsOn(s.id);
      expect(comment!.bodyMd).toMatch(/the confirmed text of \d{4}-\d{2}-\d{2}/);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'OVERTURNING runs no mark',
    async () => {
      const { decision, s } = await correctedConfirmation();

      const { spy } = await withMarkSpy(() => confirmDecision(decision.id, 'overturn'));

      expect(spy).not.toHaveBeenCalled();
      expect(await statusOf(s.id)).toBe('todo');
      expect(await commentsOn(s.id)).toEqual([]);
    },
    DB_TEST_TIMEOUT_MS,
  );
});

// ── the walk and the disposition ─────────────────────────────────────────────

describe('what the walk reaches, and what it does to each', () => {
  /** A corrected page decision whose DEPENDENTS `setup` builds before the correction. */
  async function corrected(setup: (decisionId: string) => Promise<void>) {
    const { decision, page } = await pageDecision();
    await setup(decision.id);
    await tick();
    await republish(decision.id, page.id);
    const deciding = await awaitingGateOf(decision.id, 'decision_approval');
    return { decision, deciding };
  }

  it(
    'a relates_to link is never followed; a decision with no blocked_by dependents marks nothing',
    async () => {
      let related = '';
      const { deciding } = await corrected(async (decisionId) => {
        related = (await card('Related')).id;
        await workItemsService.linkWorkItems(
          { fromId: related, toId: decisionId, kind: 'relates_to' },
          fx.ctx,
        );
      });

      const { answers } = await withMarkSpy(() => decideGate(deciding.id, 'approve'));

      expect(answers[0]).toMatchObject({ corrected: true, items: [] });
      expect(await statusOf(related)).toBe('todo');
      expect(await commentsOn(related)).toEqual([]);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'Blocked moves; planning and to_plan are left without a comment; done and cancelled are untouched',
    async () => {
      const ids: Record<string, string> = {};
      const { deciding } = await corrected(async (decisionId) => {
        for (const status of ['blocked', 'planning', 'to_plan', 'done', 'cancelled']) {
          const item = await card(status);
          await blockedBy(item.id, decisionId);
          await adminDb.workItem.update({ where: { id: item.id }, data: { status } });
          ids[status] = item.id;
        }
      });

      const { answers } = await withMarkSpy(() => decideGate(deciding.id, 'approve'));

      const outcome = Object.fromEntries(
        answers[0]!.items.map((i: { workItemId: string; outcome: string }) => [
          i.workItemId,
          i.outcome,
        ]),
      );
      expect(outcome).toEqual({
        [ids.blocked!]: 'moved',
        [ids.planning!]: 'skipped_already_planning',
        [ids.to_plan!]: 'skipped_already_planning',
        [ids.done!]: 'skipped_done',
        [ids.cancelled!]: 'skipped_done',
      });
      expect(await statusOf(ids.blocked!)).toBe('to_plan');
      for (const key of ['planning', 'to_plan', 'done', 'cancelled']) {
        expect(await statusOf(ids[key]!)).toBe(key);
        expect(await commentsOn(ids[key]!)).toEqual([]);
      }
    },
    DB_TEST_TIMEOUT_MS,
  );

  it.each(['implemented', 'in_review', 'approved'])(
    'a stale item at %s keeps its status and gets the started comment',
    async (status) => {
      let id = '';
      const { deciding } = await corrected(async (decisionId) => {
        id = (await card('Started')).id;
        await blockedBy(id, decisionId);
        await adminDb.workItem.update({ where: { id }, data: { status } });
      });

      await decideGate(deciding.id, 'approve');

      expect(await statusOf(id)).toBe(status);
      const comments = await commentsOn(id);
      expect(comments).toHaveLength(1);
      expect(comments[0]!.bodyMd).toContain('its status was kept');
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'an item whose description was rewritten after the deciding gate was raised is left alone',
    async () => {
      let id = '';
      const { deciding } = await corrected(async (decisionId) => {
        id = (await card('Fresh', { descriptionMd: 'Old plan.' })).id;
        await blockedBy(id, decisionId);
      });
      await tick();
      await workItemsService.updateWorkItem(id, { descriptionMd: 'Re-planned on B.' }, fx.ctx);

      const { answers } = await withMarkSpy(() => decideGate(deciding.id, 'approve'));

      expect(answers[0]!.items).toEqual([{ workItemId: id, outcome: 'skipped_fresh' }]);
      expect(await statusOf(id)).toBe('todo');
      expect(await commentsOn(id)).toEqual([]);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'only blocked_by links are walked onward — a descendant’s own dependents are not reached; archived descendants are skipped',
    async () => {
      const ids: Record<string, string> = {};
      const { deciding } = await corrected(async (decisionId) => {
        const story = await card('Story', { kind: 'story' });
        await blockedBy(story.id, decisionId);
        const child = await card('Child', { parentId: story.id });
        const archived = await card('Gone', { parentId: story.id });
        await adminDb.workItem.update({
          where: { id: archived.id },
          data: { archivedAt: new Date() },
        });
        const behindChild = await card('Behind child');
        await blockedBy(behindChild.id, child.id);
        Object.assign(ids, {
          story: story.id,
          child: child.id,
          archived: archived.id,
          behindChild: behindChild.id,
        });
      });

      await decideGate(deciding.id, 'approve');

      expect(await statusOf(ids.story!)).toBe('to_plan');
      expect(await statusOf(ids.child!)).toBe('to_plan');
      expect(await statusOf(ids.archived!)).toBe('todo');
      expect(await statusOf(ids.behindChild!)).toBe('todo');
      expect(await commentsOn(ids.behindChild!)).toEqual([]);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a project with no declared edge into to_plan gets the comment and keeps the status',
    async () => {
      let id = '';
      const { deciding } = await corrected(async (decisionId) => {
        id = (await card('No edge')).id;
        await blockedBy(id, decisionId);
      });
      const toPlan = await adminDb.workflowStatus.findFirstOrThrow({
        where: { projectId: fx.projectId, key: 'to_plan' },
      });
      await adminDb.workflowTransition.deleteMany({
        where: { projectId: fx.projectId, toStatusId: toPlan.id },
      });

      const { answers } = await withMarkSpy(() => decideGate(deciding.id, 'approve'));

      expect(answers[0]!.items).toEqual([{ workItemId: id, outcome: 'comment_only_no_status' }]);
      expect(await statusOf(id)).toBe('todo');
      expect((await commentsOn(id))[0]!.bodyMd).toContain('Re-plan it');
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a project with no to_plan status gets the comment and keeps the status',
    async () => {
      let id = '';
      const { deciding } = await corrected(async (decisionId) => {
        id = (await card('No status')).id;
        await blockedBy(id, decisionId);
      });
      const toPlan = await adminDb.workflowStatus.findFirstOrThrow({
        where: { projectId: fx.projectId, key: 'to_plan' },
      });
      await adminDb.boardColumnStatus.deleteMany({ where: { statusId: toPlan.id } });
      await adminDb.workflowTransition.deleteMany({
        where: { OR: [{ toStatusId: toPlan.id }, { fromStatusId: toPlan.id }] },
      });
      await adminDb.workflowStatus.delete({ where: { id: toPlan.id } });

      const { answers } = await withMarkSpy(() => decideGate(deciding.id, 'approve'));

      expect(answers[0]!.items).toEqual([{ workItemId: id, outcome: 'comment_only_no_status' }]);
      expect(await statusOf(id)).toBe('todo');
      expect(await commentsOn(id)).toHaveLength(1);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a hop the workflow refuses becomes comment-only, and the decision stays approved',
    async () => {
      let id = '';
      const { deciding } = await corrected(async (decisionId) => {
        id = (await card('Refused')).id;
        await blockedBy(id, decisionId);
      });
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(workItemsService, 'updateStatus').mockRejectedValueOnce(
        new IllegalTransitionError('todo', 'to_plan'),
      );

      const result = await decideGate(deciding.id, 'approve');

      expect(result.gate.state).toBe('approved');
      expect(await statusOf(id)).toBe('todo');
      expect(await commentsOn(id)).toHaveLength(1);
      expect(quiet).toHaveBeenCalledWith(
        expect.stringContaining('refused'),
        expect.objectContaining({ gateId: deciding.id, workItemId: id }),
      );
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a mark that fails is logged with the gate id, and the decision stays approved',
    async () => {
      const { deciding } = await corrected(async () => {});
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(decisionCorrectionMarkService, 'markForDecidedGate').mockRejectedValueOnce(
        new Error('boom'),
      );

      const result = await decideGate(deciding.id, 'approve');

      expect(result.gate.state).toBe('approved');
      expect(
        (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: deciding.id } })).state,
      ).toBe('approved');
      expect(quiet).toHaveBeenCalledWith(
        expect.stringContaining('the decision stands'),
        expect.objectContaining({ gateId: deciding.id }),
      );
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'one item that cannot be marked does not stop the others',
    async () => {
      const ids: string[] = [];
      const { deciding } = await corrected(async (decisionId) => {
        for (const name of ['A', 'B']) {
          const item = await card(name);
          await blockedBy(item.id, decisionId);
          ids.push(item.id);
        }
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const original = workItemsService.updateStatus.bind(workItemsService);
      let calls = 0;
      vi.spyOn(workItemsService, 'updateStatus').mockImplementation(async (...args) => {
        calls += 1;
        if (calls === 1) throw new IllegalTransitionError('todo', 'to_plan');
        return original(...args);
      });
      // The fallback comment fails too for the first item — a hard failure.
      const { commentRepository } = await import('@/lib/repositories/commentRepository');
      const create = commentRepository.create.bind(commentRepository);
      let comments = 0;
      vi.spyOn(commentRepository, 'create').mockImplementation(async (...args) => {
        comments += 1;
        if (comments === 1) throw new Error('comment store down');
        return create(...args);
      });

      const { answers } = await withMarkSpy(() => decideGate(deciding.id, 'approve'));

      expect(answers[0]!.items).toHaveLength(1);
      expect(answers[0]!.items[0]).toMatchObject({ outcome: 'moved' });
    },
    DB_TEST_TIMEOUT_MS,
  );

  it('a gate that is not an approved decision gate marks nothing', async () => {
    const { decision } = await pageDecision();
    const awaiting = await awaitingGateOf(decision.id, 'decision_approval');
    expect(await decisionCorrectionMarkService.markForDecidedGate(awaiting.id, fx.ctx)).toEqual({
      gateId: awaiting.id,
      corrected: false,
      items: [],
    });
    expect(
      await decisionCorrectionMarkService.markForDecidedGate('no-such-gate', fx.ctx),
    ).toMatchObject({ corrected: false });
    // And the swallowing wrapper answers nothing either way.
    await expect(runDecisionCorrectionMark(awaiting.id, fx.ctx)).resolves.toBeUndefined();
  });
});

// ── the rollup reading ───────────────────────────────────────────────────────

describe('the parent rollup reads To plan at the not-started rung', () => {
  it(
    'an UNREACHED parent whose child was marked stays at To Do',
    async () => {
      const { decision, page } = await pageDecision();
      const parent = await card('Parent', { kind: 'story' });
      const child = await card('Child', { parentId: parent.id });
      const sibling = await card('Sibling', { parentId: parent.id });
      await blockedBy(child.id, decision.id);
      await tick();
      await republish(decision.id, page.id);
      await decideGate((await awaitingGateOf(decision.id, 'decision_approval')).id, 'approve');
      expect(await statusOf(child.id)).toBe('to_plan');
      expect(await statusOf(sibling.id)).toBe('todo');

      await parentStatusRollupService.recomputeParent(parent.id, fx.workspaceId);

      expect(await statusOf(parent.id)).toBe('todo');
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a REACHED container at To plan over children at To plan and To Do stays at To plan',
    async () => {
      const { decision, s1, c1 } = await handoffFixture();
      const late = await card('Late child', { parentId: s1.id });
      await decideGate((await awaitingGateOf(decision.id, 'decision_approval')).id, 'approve');
      expect(await statusOf(c1.id)).toBe('to_plan');
      // A child written after the correction is fresh, and stays at To Do.
      expect(await statusOf(late.id)).toBe('todo');

      await parentStatusRollupService.recomputeParent(s1.id, fx.workspaceId);

      expect(await statusOf(s1.id)).toBe('to_plan');
    },
    DB_TEST_TIMEOUT_MS,
  );
});

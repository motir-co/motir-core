import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { expectEachHopAnnounced } from '../helpers/transitionedEvents';

// THE `decision_confirmation` KIND (Story MOTIR-5871 · Subtask MOTIR-5954; ADR
// `approval-gates.md` §1's MOTIR-5952 amendment, points 1, 3, 4, 6, 7, 8). Real
// Postgres, through the real service funnels and the real decide door: a `human`
// decision is RAISED from its own body when it has no open blocker; flipping its
// EXECUTOR withdraws or raises it; an edit that moves the stamp re-asks it; the
// held `done` move waits on it; Confirm writes `done` and STAMPS the record — the
// newest markdown attachment, or none — in the deciding write.

const { workItemsService } = await import('@/lib/services/workItemsService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { decisionConfirmationGateService } =
  await import('@/lib/services/decisionConfirmationGateService');
const { decisionConfirmationGateHandler } =
  await import('@/lib/approvalGates/decisionConfirmationHandler');
const { ApprovalGateVerbNotOfferedError, ApprovalGateStaleSubjectError } =
  await import('@/lib/approvalGates/errors');
const { ApprovalGatePendingError } = await import('@/lib/workItems/errors');
const { summarizeGateSubjects } = await import('@/lib/approvalGates/subjectSummary');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { projectAccessService } = await import('@/lib/services/projectAccessService');
const { workflowsService } = await import('@/lib/services/workflowsService');

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const COMPLETE = [
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

async function createDecision(
  descriptionMd: string,
  extra: {
    executor?: 'human' | 'coding_agent';
    type?: 'decision' | 'choice';
    blockedBy?: string;
  } = {},
) {
  seq += 1;
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: `Decide ${seq}`,
      type: extra.type ?? 'decision',
      executor: extra.executor ?? 'human',
      descriptionMd,
      ...(extra.blockedBy
        ? { links: [{ relationship: 'blocked_by', targetId: extra.blockedBy }] }
        : {}),
    },
    fx.ctx,
  );
}

function confirmGates(workItemId: string) {
  return adminDb.approvalGate.findMany({
    where: { workItemId, kind: 'decision_confirmation' },
    orderBy: { createdAt: 'asc' },
  });
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

async function attachMarkdown(
  workItemId: string,
  name: string,
  opts: { mimeType?: string; createdAt?: Date; source?: 'panel' | 'design_asset' } = {},
) {
  return adminDb.attachment.create({
    data: {
      workspaceId: fx.workspaceId,
      uploaderUserId: fx.ownerId,
      workItemId,
      source: opts.source ?? 'panel',
      blobPathname: `attachments/${name}-${seq}`,
      mimeType: opts.mimeType ?? 'text/markdown',
      sizeBytes: 1234,
      originalFilename: name,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
}

async function waiting(workItemId: string) {
  const read = await approvalGatesService.getForWorkItem(
    { workItemId, kind: 'decision_confirmation' },
    fx.ctx,
  );
  expect(read.gate?.state).toBe('awaiting');
  return { gateId: read.gate!.id, stamp: read.stamp! };
}

describe('the raise — a complete, unblocked `human` decision is asked', () => {
  it('raises one awaiting gate at the body’s stamp, routed, and walks the item to review', async () => {
    const item = await createDecision(COMPLETE);
    const gates = await confirmGates(item.id);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      state: 'awaiting',
      subjectId: item.id,
      routedToId: fx.ownerId,
    });
    expect(gates[0]!.subjectVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('the same body on a `coding_agent` decision raises none of this kind', async () => {
    const item = await createDecision(COMPLETE, { executor: 'coding_agent' });
    expect(await confirmGates(item.id)).toHaveLength(0);
  });

  it('a `choice` with this body raises none of this kind', async () => {
    const item = await createDecision(COMPLETE, { type: 'choice' });
    expect(await confirmGates(item.id)).toHaveLength(0);
  });

  it('a defective body raises nothing, and the body read carries the defect', async () => {
    const item = await createDecision(COMPLETE.replace('MOTIR-6 and MOTIR-7', 'none'));
    expect(await confirmGates(item.id)).toHaveLength(0);
    expect(await statusOf(item.id)).toBe('todo');
    expect(await decisionConfirmationGateService.readBody(item.id, fx.ctx)).toMatchObject({
      ok: false,
      defect: { reason: 'empty_supersedes' },
      record: { kind: 'none' },
    });
    expect(await decisionConfirmationGateService.readPort(item.id, fx.ctx)).toBeNull();
  });

  it('the body read carries the parsed sections and the record the port links', async () => {
    const item = await createDecision(COMPLETE);
    const file = await attachMarkdown(item.id, 'decision.md');
    const port = await decisionConfirmationGateService.readPort(item.id, fx.ctx);
    expect(port).toMatchObject({
      changes: ['workflow', 'less_requirement'],
      supersedes: ['MOTIR-6', 'MOTIR-7'],
      record: { kind: 'attachment', attachmentId: file.id, originalFilename: 'decision.md' },
    });
  });

  it('the body read resolves superseded TITLES and the record count, and reads no EPIC', async () => {
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Exports', descriptionMd: 'The capability.' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Export page', parentId: epic.id },
      fx.ctx,
    );
    seq += 1;
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        parentId: epic.id,
        title: `Decide ${seq}`,
        type: 'decision',
        executor: 'human',
        descriptionMd: COMPLETE.replace('MOTIR-6 and MOTIR-7', `${story.identifier} and NOPE-404`),
      },
      fx.ctx,
    );
    await attachMarkdown(item.id, 'one.md', { createdAt: new Date('2026-09-01T00:00:00Z') });
    const newest = await attachMarkdown(item.id, 'two.md', {
      createdAt: new Date('2026-09-02T00:00:00Z'),
    });

    // MOTIR-6350: nothing renders the governing epic since MOTIR-6211 replaced the
    // overturned band's plain epic entrance with the seeded Re-plan door, so the read
    // neither walks up to it nor pays for the viewer's permissions and the statuses.
    const permissions = vi.spyOn(projectAccessService, 'getPermissions');
    const statuses = vi.spyOn(workflowsService, 'listStatusesByProject');
    try {
      const port = await decisionConfirmationGateService.readPort(item.id, fx.ctx);
      expect(port?.supersedesItems).toEqual([
        { key: story.identifier, title: 'Export page' },
        { key: 'NOPE-404', title: null },
      ]);
      expect(port?.recordCount).toBe(2);
      expect(port?.presentRecordIds[0]).toBe(newest.id);
      expect(port).not.toHaveProperty('epic');
      expect(permissions).not.toHaveBeenCalled();
      expect(statuses).not.toHaveBeenCalled();

      // A DEFECTIVE body carries no epic either. (The edit itself may read both.)
      await workItemsService.updateWorkItem(
        item.id,
        { descriptionMd: '## Decision\nOnly.' },
        fx.ctx,
      );
      permissions.mockClear();
      statuses.mockClear();
      const defective = await decisionConfirmationGateService.readBody(item.id, fx.ctx);
      expect(defective).toMatchObject({ ok: false });
      expect(defective).not.toHaveProperty('epic');

      expect(permissions).not.toHaveBeenCalled();
      expect(statuses).not.toHaveBeenCalled();
    } finally {
      permissions.mockRestore();
      statuses.mockRestore();
    }
  });

  it('the body read is null for a work item that is not a `human` decision', async () => {
    const item = await createDecision(COMPLETE, { executor: 'coding_agent' });
    expect(await decisionConfirmationGateService.readBody(item.id, fx.ctx)).toBeNull();
    expect(await decisionConfirmationGateService.readBody('no-such-item', fx.ctx)).toBeNull();
  });
});

describe('the executor and the type — a change onto or off a `human` decision', () => {
  it('coding_agent → human raises it; human → coding_agent withdraws it', async () => {
    const item = await createDecision(COMPLETE, { executor: 'coding_agent' });
    await workItemsService.updateWorkItem(item.id, { executor: 'human' }, fx.ctx);
    expect((await confirmGates(item.id)).map((g) => g.state)).toEqual(['awaiting']);

    await workItemsService.updateWorkItem(item.id, { executor: 'coding_agent' }, fx.ctx);
    const gates = await confirmGates(item.id);
    expect(gates.map((g) => g.state)).toEqual(['superseded']);
    expect(gates[0]!.supersededCause).toBe('withdrawn');
  });
});

describe('an edit — the stamp decides whether the question is asked again', () => {
  it('a body edit that moves the stamp supersedes the gate `republished` and raises a fresh one', async () => {
    const item = await createDecision(COMPLETE);
    const [first] = await confirmGates(item.id);
    await workItemsService.updateWorkItem(
      item.id,
      { descriptionMd: COMPLETE.replace('the bucket.', 'the bucket, with a link.') },
      fx.ctx,
    );
    const gates = await confirmGates(item.id);
    expect(gates.map((g) => g.state)).toEqual(['superseded', 'awaiting']);
    expect(gates[0]!.supersededCause).toBe('republished');
    expect(gates[1]!.subjectVersion).not.toBe(first!.subjectVersion);
  });

  it('an edit outside the four sections keeps the same gate', async () => {
    const item = await createDecision(COMPLETE);
    await workItemsService.updateWorkItem(
      item.id,
      { descriptionMd: `A closing thought.\n\n${COMPLETE}` },
      fx.ctx,
    );
    expect((await confirmGates(item.id)).map((g) => g.state)).toEqual(['awaiting']);
  });

  it('an edit that breaks the parse supersedes the gate and raises none', async () => {
    const item = await createDecision(COMPLETE);
    await workItemsService.updateWorkItem(
      item.id,
      { descriptionMd: COMPLETE.replace(/## Resulting direction[\s\S]*$/, '') },
      fx.ctx,
    );
    const gates = await confirmGates(item.id);
    expect(gates.map((g) => g.state)).toEqual(['superseded']);
    expect(gates[0]!.supersededCause).toBe('republished');
  });

  it('a redelivered reconcile raises nothing new — idempotent on the stamp', async () => {
    const item = await createDecision(COMPLETE);
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    const again = await withWorkspaceContext(fx.ctx, (tx) =>
      decisionConfirmationGateService.reconcile(row, tx),
    );
    expect(again).toEqual({ raised: false, superseded: 0, hopsToReview: [] });
  });

  it('a reconcile on an item that never asked anything does nothing', async () => {
    const plain = await createDecision(COMPLETE, { executor: 'coding_agent' });
    const broken = await createDecision('no sections');
    for (const id of [plain.id, broken.id]) {
      const row = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
      expect(
        await withWorkspaceContext(fx.ctx, (tx) =>
          decisionConfirmationGateService.reconcile(row, tx),
        ),
      ).toEqual({ raised: false, superseded: 0, hopsToReview: [] });
    }
  });
});

describe('blockers — a decision waiting on something is asked when it lands', () => {
  it('raises nothing while blocked, then raises when the last open blocker reaches done', async () => {
    seq += 1;
    const blocker = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: `Research ${seq}`, type: 'research' },
      fx.ctx,
    );
    const item = await createDecision(COMPLETE, { blockedBy: blocker.id });
    expect(await confirmGates(item.id)).toHaveLength(0);

    await workItemsService.updateStatus(blocker.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(blocker.id, 'done', fx.ctx);
    expect((await confirmGates(item.id)).map((g) => g.state)).toEqual(['awaiting']);
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('an edit to a blocked decision at an old stamp withdraws it and raises none', async () => {
    const item = await createDecision(COMPLETE);
    seq += 1;
    const blocker = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: `Research ${seq}`, type: 'research' },
      fx.ctx,
    );
    await adminDb.workItemLink.create({
      data: {
        workspaceId: fx.workspaceId,
        fromId: item.id,
        toId: blocker.id,
        kind: 'is_blocked_by',
        createdById: fx.ownerId,
      },
    });
    await workItemsService.updateWorkItem(
      item.id,
      { descriptionMd: COMPLETE.replace('the bucket.', 'the new bucket.') },
      fx.ctx,
    );
    expect((await confirmGates(item.id)).map((g) => g.state)).toEqual(['superseded']);
  });
});

describe('the held move — a hand move to done waits on the gate', () => {
  it('is refused while the gate awaits', async () => {
    const item = await createDecision(COMPLETE);
    await expect(workItemsService.updateStatus(item.id, 'done', fx.ctx)).rejects.toBeInstanceOf(
      ApprovalGatePendingError,
    );
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('succeeds on a defective decision, which has no gate to wait on', async () => {
    const item = await createDecision('## Decision\nOnly this.');
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'done', fx.ctx);
    expect(await statusOf(item.id)).toBe('done');
  });

  it('a hand move to cancelled WITHDRAWS the question (pulled_back) — it is not an overturn', async () => {
    const item = await createDecision(COMPLETE);
    await workItemsService.updateStatus(item.id, 'cancelled', fx.ctx);
    const gates = await confirmGates(item.id);
    expect(gates.map((g) => g.state)).toEqual(['superseded']);
    expect(gates[0]!.supersededCause).toBe('pulled_back');
    expect(gates[0]!.decidedById).toBeNull();
  });
});

describe('Confirm — through the decide door', () => {
  async function confirm(itemId: string) {
    const { gateId, stamp } = await waiting(itemId);
    return approvalGatesService.decide(
      { gateId, decision: 'approve', source: 'ui', stamp },
      fx.ctx,
    );
  }

  it('writes done and stamps the gate approved with the audit set — and `none` with no record', async () => {
    const item = await createDecision(COMPLETE);
    // The `done` it writes is announced after the commit (Bug MOTIR-9415).
    const { result, hops } = await expectEachHopAnnounced(
      item.id,
      { workspaceId: fx.workspaceId, actorId: fx.ownerId },
      () => confirm(item.id),
    );
    expect(hops).toEqual([{ fromStatusKey: 'in_review', toStatusKey: 'done' }]);
    expect(result.effect).toEqual({ statusWritten: 'done', confirmedRecord: { kind: 'none' } });
    expect(await statusOf(item.id)).toBe('done');
    const [gate] = await confirmGates(item.id);
    expect(gate).toMatchObject({
      state: 'approved',
      decidedById: fx.ownerId,
      decisionSource: 'ui',
      outcomeRef: 'done',
    });
    expect(gate!.decidedAt).toBeInstanceOf(Date);
    expect(gate!.decidedUnderAuthority).not.toBeNull();
    expect(gate!.confirmedRecord).toEqual({ kind: 'none' });
    expect(result.gate.confirmedRecord).toEqual({ kind: 'none' });
  });

  it('stamps the NEWEST counting markdown attachment — and a later delete leaves the stamp', async () => {
    const item = await createDecision(COMPLETE);
    await attachMarkdown(item.id, 'older.md', { createdAt: new Date('2026-09-01T00:00:00Z') });
    const newest = await attachMarkdown(item.id, 'notes.MD', {
      mimeType: 'application/octet-stream',
      createdAt: new Date('2026-09-02T00:00:00Z'),
    });
    // Newer, but not a record: a design result's lifecycle-owned markdown, and a PNG.
    await attachMarkdown(item.id, 'design-notes.md', {
      source: 'design_asset',
      createdAt: new Date('2026-09-03T00:00:00Z'),
    });
    await attachMarkdown(item.id, 'shot.png', {
      mimeType: 'image/png',
      createdAt: new Date('2026-09-04T00:00:00Z'),
    });

    await confirm(item.id);
    const expected = {
      kind: 'attachment',
      attachmentId: newest.id,
      originalFilename: 'notes.MD',
      mimeType: 'application/octet-stream',
      sizeBytes: 1234,
      createdAt: '2026-09-02T00:00:00.000Z',
    };
    expect((await confirmGates(item.id))[0]!.confirmedRecord).toEqual(expected);

    await adminDb.attachment.delete({ where: { id: newest.id } });
    expect((await confirmGates(item.id))[0]!.confirmedRecord).toEqual(expected);
  });

  it('request_changes is not offered on this kind — refused, and nothing changes', async () => {
    const item = await createDecision(COMPLETE);
    const { gateId, stamp } = await waiting(item.id);
    await expect(
      approvalGatesService.decide(
        { gateId, decision: 'request_changes', source: 'ui', stamp, noteMd: 'no' },
        fx.ctx,
      ),
    ).rejects.toMatchObject({
      constructor: ApprovalGateVerbNotOfferedError,
      reason: 'request_changes_on_confirmation',
    });
    expect((await confirmGates(item.id))[0]!.state).toBe('awaiting');
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('a decided decision is not asked again at the same stamp when it is reopened', async () => {
    const item = await createDecision(COMPLETE);
    await confirm(item.id);
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    await withWorkspaceContext(fx.ctx, (tx) => decisionConfirmationGateService.reconcile(row, tx));
    expect((await confirmGates(item.id)).map((g) => g.state)).toEqual(['approved']);
  });
});

describe('the handler directly', () => {
  async function args(itemId: string, resolvedStatusKey: string | null) {
    const [gate] = await confirmGates(itemId);
    const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: itemId } });
    return { gate: gate!, item, ctx: fx.ctx, resolvedStatusKey, refusalVerdict: null };
  }

  it('a project with no done status writes none and says why — the record is still stamped', async () => {
    const item = await createDecision(COMPLETE);
    const a = await args(item.id, null);
    const effect = await withWorkspaceContext(fx.ctx, (tx) =>
      decisionConfirmationGateHandler.approve({ ...a, tx }),
    );
    expect(effect).toEqual({
      statusWritten: null,
      statusDeferredReason: 'no_status_in_target_category',
      confirmedRecord: { kind: 'none' },
    });
  });

  it('a subject that stopped parsing under the lock is the stale refusal', async () => {
    const item = await createDecision(COMPLETE);
    const a = await args(item.id, 'done');
    await adminDb.workItem.update({ where: { id: item.id }, data: { descriptionMd: 'gone' } });
    await expect(
      withWorkspaceContext(fx.ctx, (tx) => decisionConfirmationGateHandler.approve({ ...a, tx })),
    ).rejects.toBeInstanceOf(ApprovalGateStaleSubjectError);
  });

  it('resolves no subject — and no version — once the item stops being a `human` decision', async () => {
    const item = await createDecision(COMPLETE);
    const a = await args(item.id, 'done');
    await withWorkspaceContext(fx.ctx, async (tx) => {
      expect(await decisionConfirmationGateHandler.subjectVersion({ ...a, tx })).toMatch(
        /^[0-9a-f]{64}$/,
      );
    });
    await adminDb.workItem.update({ where: { id: item.id }, data: { executor: 'coding_agent' } });
    await withWorkspaceContext(fx.ctx, async (tx) => {
      expect(await decisionConfirmationGateHandler.resolveSubject({ ...a, tx })).toBeNull();
      expect(await decisionConfirmationGateHandler.subjectVersion({ ...a, tx })).toBeNull();
      expect(
        await decisionConfirmationGateHandler.resolveSubject({
          ...a,
          gate: { ...a.gate, subjectId: 'no-such-item' },
          tx,
        }),
      ).toBeNull();
    });
  });

  it('currentSubject answers only for a parsing `human` decision; requestChanges moves nothing', async () => {
    const item = await createDecision(COMPLETE);
    const a = await args(item.id, 'done');
    await withWorkspaceContext(fx.ctx, async (tx) => {
      expect(await decisionConfirmationGateHandler.currentSubject({ ...a, tx })).toBe(item.id);
      expect(
        await decisionConfirmationGateHandler.currentSubject({
          ...a,
          item: { ...a.item, descriptionMd: 'nothing' },
          tx,
        }),
      ).toBeNull();
      expect(
        await decisionConfirmationGateHandler.currentSubject({
          ...a,
          item: { ...a.item, executor: 'coding_agent' },
          tx,
        }),
      ).toBeNull();
      expect(decisionConfirmationGateHandler.routeTo({ ...a, tx })).toBe(fx.ownerId);
    });
    expect(await decisionConfirmationGateHandler.requestChanges({} as never)).toEqual({
      statusWritten: null,
      statusDeferredReason: 'request_changes_moves_nothing',
    });
  });
});

describe('the row summary — the decision, its changes and how much it supersedes', () => {
  it('summarises a waiting decision from its body, and omits one that stopped parsing', async () => {
    const item = await createDecision(COMPLETE);
    const [gate] = await confirmGates(item.id);
    const rows = [{ id: gate!.id, kind: gate!.kind, subjectId: gate!.subjectId }];
    const summaries = await withWorkspaceContext(fx.ctx, (tx) => summarizeGateSubjects(rows, tx));
    expect(summaries.get(gate!.id)).toEqual({
      kind: 'decision_confirmation',
      decision: 'Exports move to managed object storage.',
      changes: ['workflow', 'less_requirement'],
      supersedesCount: 2,
    });

    await adminDb.workItem.update({ where: { id: item.id }, data: { descriptionMd: 'gone' } });
    const after = await withWorkspaceContext(fx.ctx, (tx) => summarizeGateSubjects(rows, tx));
    expect(after.get(gate!.id) ?? null).toBeNull();
  });
});

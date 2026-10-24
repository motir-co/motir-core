import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { expectEachHopAnnounced } from '../helpers/transitionedEvents';

// OVERTURN — THE REFUSAL ARM, BUILT (Story MOTIR-5871 · Subtask MOTIR-5956; ADR
// `approval-gates.md` §1's MOTIR-5952 amendment, points 6–7). Real Postgres, the real
// route and the real server action: `overturn` + a note on an awaiting
// `decision_confirmation` gate stamps it `overturned`, writes `cancelled`, and
// changes NO other work item; the re-plan it owes is derived onto the gate DTO. An
// empty note, the verb on another kind, and `request_changes` on this kind are
// NAMED 400s that write nothing, and the decided row is immutable.

const signedIn = { current: null as { userId: string; workspaceId: string } | null };
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => signedIn.current,
}));
const session = { current: null as { user: { id: string; email: string; name: string } } | null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => session.current,
}));
const activeProject = { current: null as unknown };
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: async () => activeProject.current,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { workItemsService } = await import('@/lib/services/workItemsService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { decisionConfirmationGateHandler } =
  await import('@/lib/approvalGates/decisionConfirmationHandler');
const { ApprovalGateStaleSubjectError } = await import('@/lib/approvalGates/errors');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { POST: decideRoute } = await import('@/app/api/approval-gates/[id]/decide/route');
const { decideApprovalGateAction } = await import('@/app/(authed)/items/[key]/approvalGateActions');

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  signedIn.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
  session.current = { user: { id: fx.ownerId, email: fx.owner.email, name: fx.owner.name } };
  activeProject.current = { ...fx.ctx, projectId: fx.projectId, project: fx.project };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function body(supersedes: string) {
  return [
    '## Decision',
    'Exports move to managed object storage.',
    '## What changed',
    '**Change:** less requirement',
    'The approved plan kept exports in Postgres.',
    '## Supersedes',
    supersedes,
    '## Resulting direction',
    'Every export is written to the bucket.',
  ].join('\n');
}

async function createItem(extra: Record<string, unknown> = {}) {
  seq += 1;
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: `Item ${seq}`, ...extra },
    fx.ctx,
  );
}

async function waitingDecision(supersedes = 'MOTIR-6 and MOTIR-7') {
  const item = await createItem({
    type: 'decision',
    executor: 'human',
    descriptionMd: body(supersedes),
  });
  const read = await approvalGatesService.getForWorkItem(
    { workItemId: item.id, kind: 'decision_confirmation' },
    fx.ctx,
  );
  expect(read.gate?.state).toBe('awaiting');
  expect(read.gate?.replanOwed).toBeNull();
  return { item, gateId: read.gate!.id, stamp: read.stamp! };
}

function post(gateId: string, payload: Record<string, unknown>) {
  return decideRoute(
    new Request(`http://localhost/api/approval-gates/${gateId}/decide`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ id: gateId }) },
  );
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });

describe('overturn — the route', () => {
  it('stamps overturned with the note and the audit set, writes cancelled, and derives the owed re-plan', async () => {
    const { item, gateId, stamp } = await waitingDecision();
    // The `cancelled` it writes is announced after the commit (Bug MOTIR-9415).
    const { result: res, hops } = await expectEachHopAnnounced(
      item.id,
      { workspaceId: fx.workspaceId, actorId: fx.ownerId },
      () =>
        post(gateId, {
          decision: 'overturn',
          noteMd: 'We agreed to keep Postgres and add a cache in front of it.',
          stamp,
        }),
    );
    expect(hops).toEqual([{ fromStatusKey: 'in_review', toStatusKey: 'cancelled' }]);

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      gate: { state: string; replanOwed: { keys: string[] } | null };
      effect: { statusWritten: string };
    };
    expect(json.gate.state).toBe('overturned');
    expect(json.gate.replanOwed).toEqual({ keys: ['MOTIR-6', 'MOTIR-7'] });
    expect(json.effect.statusWritten).toBe('cancelled');

    expect(await statusOf(item.id)).toBe('cancelled');
    const row = await gateRow(gateId);
    expect(row).toMatchObject({
      state: 'overturned',
      noteMd: 'We agreed to keep Postgres and add a cache in front of it.',
      decidedById: fx.ownerId,
      decisionSource: 'api',
      outcomeRef: 'cancelled',
    });
    expect(row.decidedAt).toBeInstanceOf(Date);
    expect(row.decidedUnderAuthority).not.toBeNull();
    expect(row.confirmedRecord).toBeNull();

    // The item page's read carries the same derived debt.
    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'decision_confirmation' },
      fx.ctx,
    );
    expect(read.gate?.replanOwed).toEqual({ keys: ['MOTIR-6', 'MOTIR-7'] });
  });

  it('an empty — or blank — note is a NAMED 400, and nothing changes', async () => {
    const { item, gateId, stamp } = await waitingDecision();
    for (const noteMd of [undefined, '', '   ']) {
      const res = await post(gateId, {
        decision: 'overturn',
        stamp,
        ...(noteMd === undefined ? {} : { noteMd }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: 'APPROVAL_GATE_VERB_NOT_OFFERED',
        reason: 'overturn_needs_a_note',
      });
    }
    expect((await gateRow(gateId)).state).toBe('awaiting');
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('request_changes on this kind is a NAMED 400 — its refusal is Overturn', async () => {
    const { gateId, stamp } = await waitingDecision();
    const res = await post(gateId, { decision: 'request_changes', noteMd: 'revise', stamp });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'APPROVAL_GATE_VERB_NOT_OFFERED',
      reason: 'request_changes_on_confirmation',
    });
    expect((await gateRow(gateId)).state).toBe('awaiting');
  });

  it('overturn on ANOTHER kind is a NAMED 400, and nothing changes', async () => {
    const choice = await createItem({
      type: 'choice',
      executor: 'human',
      descriptionMd: [
        '## Question',
        'Which store?',
        '## Why this is a choice',
        '**Situation:** two workflows',
        'Two workflows.',
        '## Options',
        '### A',
        '**Best if you want:** less to operate',
        'a',
        '### B',
        '**Best if you want:** more cost-effective',
        'b',
        '## What this choice gates',
        'The export story.',
      ].join('\n'),
    });
    const read = await approvalGatesService.getForWorkItem(
      { workItemId: choice.id, kind: 'decision_choice' },
      fx.ctx,
    );
    const res = await post(read.gate!.id, {
      decision: 'overturn',
      noteMd: 'no',
      stamp: read.stamp,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'APPROVAL_GATE_VERB_NOT_OFFERED',
      reason: 'overturn_on_other_kind',
    });
    expect((await gateRow(read.gate!.id)).state).toBe('awaiting');
  });

  it('an unknown decision verb is still a plain 400', async () => {
    const { gateId, stamp } = await waitingDecision();
    const res = await post(gateId, { decision: 'veto', stamp });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('overturn changes NO other work item', () => {
  it('the work items named under ## Supersedes keep their status, parent and body', async () => {
    const story = await createItem({ kind: 'story', title: 'Exports' });
    const a = await createItem({
      kind: 'subtask',
      parentId: story.id,
      descriptionMd: 'Postgres table',
    });
    const b = await createItem({
      kind: 'subtask',
      parentId: story.id,
      descriptionMd: 'Postgres job',
    });
    await workItemsService.updateStatus(b.id, 'in_progress', fx.ctx);
    const snapshot = async () =>
      adminDb.workItem.findMany({
        where: { id: { in: [story.id, a.id, b.id] } },
        select: { id: true, status: true, parentId: true, descriptionMd: true, updatedAt: true },
        orderBy: { id: 'asc' },
      });
    const before = await snapshot();

    const { gateId, stamp } = await waitingDecision(`${a.identifier} and ${b.identifier}`);
    const res = await post(gateId, { decision: 'overturn', noteMd: 'Not what we agreed.', stamp });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { gate: { replanOwed: { keys: string[] } } };
    expect(json.gate.replanOwed.keys).toEqual([a.identifier, b.identifier]);

    expect(await snapshot()).toEqual(before);
  });
});

describe('the overturned record', () => {
  it('cannot be updated afterwards — the decided-row trigger holds it', async () => {
    const { gateId, stamp } = await waitingDecision();
    await post(gateId, { decision: 'overturn', noteMd: 'No.', stamp });
    await expect(
      adminDb.approvalGate.update({ where: { id: gateId }, data: { noteMd: 'rewritten' } }),
    ).rejects.toThrow(/AG_DECIDED_IMMUTABLE/);
  });

  it('keeps the owed keys when the body is edited after the overturn — read from the draft', async () => {
    const { item, gateId, stamp } = await waitingDecision();
    await post(gateId, { decision: 'overturn', noteMd: 'No.', stamp });
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { descriptionMd: '## Supersedes\nMOTIR-6 and MOTIR-7' },
    });
    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'decision_confirmation' },
      fx.ctx,
    );
    expect(read.gate?.state).toBe('overturned');
    expect(read.gate?.replanOwed).toEqual({ keys: ['MOTIR-6', 'MOTIR-7'] });
  });

  it('a confirmed decision owes nothing', async () => {
    const { item, gateId, stamp } = await waitingDecision();
    await post(gateId, { decision: 'approve', stamp });
    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'decision_confirmation' },
      fx.ctx,
    );
    expect(read.gate?.state).toBe('approved');
    expect(read.gate?.replanOwed).toBeNull();
  });
});

describe('overturn — the server action mirrors the route', () => {
  it('a press through the action writes the same record', async () => {
    const { item, gateId, stamp } = await waitingDecision();
    const result = await decideApprovalGateAction({
      gateId,
      decision: 'overturn',
      identifier: item.identifier,
      noteMd: 'Not what we discussed.',
      stamp,
    });
    expect(result).toMatchObject({ ok: true });
    expect((await gateRow(gateId)).state).toBe('overturned');
    expect(await statusOf(item.id)).toBe('cancelled');
  });
});

describe('the handler directly', () => {
  async function args(itemId: string, resolvedStatusKey: string | null) {
    const [gate] = await adminDb.approvalGate.findMany({
      where: { workItemId: itemId, kind: 'decision_confirmation' },
    });
    const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: itemId } });
    return { gate: gate!, item, ctx: fx.ctx, resolvedStatusKey, refusalVerdict: null };
  }

  it('a project with no cancelled status records nothing on the status — and says why', async () => {
    const { item } = await waitingDecision();
    const a = await args(item.id, null);
    const effect = await withWorkspaceContext(fx.ctx, (tx) =>
      decisionConfirmationGateHandler.overturn!({ ...a, tx }),
    );
    expect(effect).toEqual({
      statusWritten: null,
      statusDeferredReason: 'no_status_in_target_category',
    });
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('a subject that stopped parsing under the lock is the stale refusal', async () => {
    const { item } = await waitingDecision();
    const a = await args(item.id, 'cancelled');
    await adminDb.workItem.update({ where: { id: item.id }, data: { descriptionMd: 'gone' } });
    await expect(
      withWorkspaceContext(fx.ctx, (tx) => decisionConfirmationGateHandler.overturn!({ ...a, tx })),
    ).rejects.toBeInstanceOf(ApprovalGateStaleSubjectError);
  });
});

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { expectEachHopAnnounced } from '../helpers/transitionedEvents';

// THE `manual_work` GATE (Story MOTIR-7460 · Subtask MOTIR-7474;
// `docs/decisions/manual-work-gate.md`). Real Postgres, the real services: a manual card
// a run reached is raised ONCE per card and routed to its assignee (the run's starter on
// an unassigned card); Mark done is the decide door's `approve` and writes Done; Request
// changes is refused by name; a hand move to Done is held while it waits; and it is
// withdrawn when the card stops being manual, is cancelled or archived, or is closed by
// a write nobody decided.

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { workItemsService } = await import('@/lib/services/workItemsService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { manualWorkGateService, hopsToStatus } =
  await import('@/lib/services/manualWorkGateService');
const { manualWorkGateHandler, isManualWork } =
  await import('@/lib/approvalGates/manualWorkHandler');
const { approvalGateRepository } = await import('@/lib/repositories/approvalGateRepository');
const { workItemTodoRepository } = await import('@/lib/repositories/workItemTodoRepository');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { ApprovalGateVerbNotOfferedError } = await import('@/lib/approvalGates/errors');
const { ApprovalGatePendingError } = await import('@/lib/workItems/errors');
const { handlerFor, UNREGISTERED_GATE_KINDS } = await import('@/lib/approvalGates/registry');

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

async function manualCard(overrides: { assigneeId?: string | null } = {}) {
  seq += 1;
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: `Rotate the signing key ${seq}`,
      type: 'manual',
      executor: 'human',
      ...overrides,
    },
    fx.ctx,
  );
}

async function starter() {
  const user = await createTestUser();
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
  });
  return user;
}

function raise(workItemId: string, createdById: string | null) {
  return withWorkspaceContext(fx.ctx, (tx) =>
    manualWorkGateService.raise(workItemId, { createdById }, fx.workspaceId, tx),
  );
}

const gatesOf = (workItemId: string) =>
  adminDb.approvalGate.findMany({ where: { workItemId, kind: 'manual_work' } });
const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

async function raisedGate(workItemId: string) {
  const result = await raise(workItemId, fx.ownerId);
  expect(result.raised).toBe(true);
  const [gate] = await gatesOf(workItemId);
  return gate!;
}

describe('the kind', () => {
  it('is registered — the registry has no hole for it', () => {
    expect(UNREGISTERED_GATE_KINDS).not.toContain('manual_work');
    const handler = handlerFor('manual_work');
    expect(handler.statusIntent).toEqual({ key: 'done', category: 'done' });
    expect(handler.permission).toBe('work_item:edit');
  });
});

describe('raise', () => {
  it('raises ONE awaiting gate per card, however often it is called', async () => {
    const card = await manualCard();
    expect((await raise(card.id, fx.ownerId)).raised).toBe(true);
    const again = await raise(card.id, fx.ownerId);
    expect(again).toMatchObject({ raised: false, skipped: 'already_awaiting' });

    const gates = await gatesOf(card.id);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ state: 'awaiting', subjectId: card.id, subjectVersion: null });
  });

  it('assigns an UNASSIGNED card to the run’s starter, with a revision, and routes to them', async () => {
    const card = await manualCard();
    const person = await starter();

    const result = await raise(card.id, person.id);

    expect(result).toMatchObject({ raised: true, assignedToStarter: true, routedToId: person.id });
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(row.assigneeId).toBe(person.id);
    const revision = await adminDb.workItemRevision.findFirst({
      where: { workItemId: card.id, changedById: person.id },
    });
    expect(revision?.diff).toEqual({ assigneeId: { from: null, to: person.id } });
    expect((await gatesOf(card.id))[0]!.routedToId).toBe(person.id);
  });

  it('keeps an assigned card’s assignee and routes to them', async () => {
    const person = await starter();
    const card = await manualCard({ assigneeId: fx.ownerId });

    const result = await raise(card.id, person.id);

    expect(result).toMatchObject({
      raised: true,
      assignedToStarter: false,
      routedToId: fx.ownerId,
    });
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).assigneeId).toBe(
      fx.ownerId,
    );
  });

  it('raises nothing on a card that is not manual, is archived, or is done', async () => {
    const coded = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Agent work', type: 'code' },
      fx.ctx,
    );
    expect((await raise(coded.id, fx.ownerId)).skipped).toBe('not_manual');

    const archived = await manualCard();
    await workItemsService.archiveWorkItem(archived.id, fx.ctx);
    expect((await raise(archived.id, fx.ownerId)).skipped).toBe('archived');

    const finished = await manualCard();
    await workItemsService.updateStatus(finished.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(finished.id, 'done', fx.ctx);
    expect((await raise(finished.id, fx.ownerId)).skipped).toBe('done');

    expect(await adminDb.approvalGate.count({ where: { kind: 'manual_work' } })).toBe(0);
  });

  it('raises again on a card reopened after its gate was decided', async () => {
    const card = await manualCard();
    const gate = await raisedGate(card.id);
    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );
    await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);

    expect((await raise(card.id, fx.ownerId)).raised).toBe(true);
    expect((await gatesOf(card.id)).map((g) => g.state).sort()).toEqual(['approved', 'awaiting']);
  });
});

describe('Mark done', () => {
  it('approve walks the card to Done from To do and decides the gate', async () => {
    const card = await manualCard();
    const gate = await raisedGate(card.id);
    expect(await statusOf(card.id)).toBe('todo');

    // Every hop the walk took announces itself after the commit (Bug MOTIR-9415).
    const { result, hops } = await expectEachHopAnnounced(
      card.id,
      { workspaceId: fx.workspaceId, actorId: fx.ownerId },
      () =>
        approvalGatesService.decide(
          { gateId: gate.id, decision: 'approve', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
          fx.ctx,
        ),
    );

    expect(result.gate.state).toBe('approved');
    expect(await statusOf(card.id)).toBe('done');
    expect(hops.map((hop) => hop.toStatusKey)).toContain('done');
    expect((await gatesOf(card.id))[0]).toMatchObject({
      state: 'approved',
      decidedById: fx.ownerId,
    });
  });

  it('a decision that rolls back after its hops announces none of them', async () => {
    const card = await manualCard();
    const gate = await raisedGate(card.id);
    // The decision's own write is the door's LAST statement, so failing it rolls back
    // every hop the walk had already applied in the transaction.
    const spy = vi
      .spyOn(approvalGateRepository, 'decide')
      .mockRejectedValueOnce(new Error('the deciding write failed'));

    const { hops } = await expectEachHopAnnounced(
      card.id,
      { workspaceId: fx.workspaceId, actorId: fx.ownerId },
      () =>
        expect(
          approvalGatesService.decide(
            { gateId: gate.id, decision: 'approve', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
            fx.ctx,
          ),
        ).rejects.toThrow('the deciding write failed'),
    );
    spy.mockRestore();

    expect(hops).toEqual([]);
    expect(await statusOf(card.id)).toBe('todo');
    expect((await gatesOf(card.id))[0]!.state).toBe('awaiting');
  });

  it('Request changes is refused by name, and nothing moves', async () => {
    const card = await manualCard();
    const gate = await raisedGate(card.id);

    const err = await approvalGatesService
      .decide(
        {
          gateId: gate.id,
          decision: 'request_changes',
          noteMd: 'cannot do this',
          source: 'ui',
          stamp: DECIDED_WITHOUT_A_READER,
        },
        fx.ctx,
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApprovalGateVerbNotOfferedError);
    expect((err as InstanceType<typeof ApprovalGateVerbNotOfferedError>).reason).toBe(
      'request_changes_on_manual_work',
    );
    expect((await gatesOf(card.id))[0]!.state).toBe('awaiting');
    expect(await statusOf(card.id)).toBe('todo');
  });

  it('while it waits, a hand move to Done is held and routed to the decide door', async () => {
    const card = await manualCard();
    const gate = await raisedGate(card.id);
    await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);

    const err = await workItemsService
      .updateStatus(card.id, 'done', fx.ctx)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApprovalGatePendingError);
    expect(err).toMatchObject({ gateId: gate.id, gateKind: 'manual_work' });
    expect(await statusOf(card.id)).toBe('in_progress');
    expect((await gatesOf(card.id))[0]!.state).toBe('awaiting');
  });

  // §6 kept the question through Blocked until MOTIR-8670 amended it: a Blocked card is
  // one nobody can start, so it is withdrawn there (`manualWorkGateReconcile.test.ts`).
  it('a move that is not Done and leaves the card workable — In progress — keeps the question', async () => {
    const card = await manualCard();
    await raisedGate(card.id);
    await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);
    expect((await gatesOf(card.id))[0]!.state).toBe('awaiting');
  });
});

describe('withdrawn', () => {
  it('when an executor edit leaves the card no longer manual — `no_longer_manual`', async () => {
    const card = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Human step',
        type: 'code',
        executor: 'human',
      },
      fx.ctx,
    );
    await raisedGate(card.id);

    await workItemsService.updateWorkItem(card.id, { title: 'Human step, renamed' }, fx.ctx);
    expect((await gatesOf(card.id))[0]!.state).toBe('awaiting');

    await workItemsService.updateWorkItem(card.id, { executor: 'coding_agent' }, fx.ctx);
    expect((await gatesOf(card.id))[0]).toMatchObject({
      state: 'superseded',
      supersededCause: 'no_longer_manual',
    });
  });

  it('an executor edit on a `manual`-TYPE card keeps it manual, and keeps the question', async () => {
    const card = await manualCard();
    await raisedGate(card.id);
    await workItemsService.updateWorkItem(card.id, { executor: 'coding_agent' }, fx.ctx);
    expect((await gatesOf(card.id))[0]!.state).toBe('awaiting');
  });

  it('when the card is cancelled — `pulled_back`', async () => {
    const card = await manualCard();
    await raisedGate(card.id);
    await workItemsService.updateStatus(card.id, 'cancelled', fx.ctx);
    expect((await gatesOf(card.id))[0]).toMatchObject({
      state: 'superseded',
      supersededCause: 'pulled_back',
    });
  });

  it('when the card is archived — `pulled_back`', async () => {
    const card = await manualCard();
    await raisedGate(card.id);
    await workItemsService.archiveWorkItem(card.id, fx.ctx);
    expect((await gatesOf(card.id))[0]).toMatchObject({
      state: 'superseded',
      supersededCause: 'pulled_back',
    });
  });

  it('when a SYSTEM write closes the card — `closed_without_decision`, never approved', async () => {
    const card = await manualCard();
    await raisedGate(card.id);
    await withWorkspaceContext(fx.ctx, async (tx) => {
      await workItemsService.applyStatusTransition(card.id, 'done', fx.ctx, tx, { system: true });
    });

    expect(await statusOf(card.id)).toBe('done');
    expect((await gatesOf(card.id))[0]).toMatchObject({
      state: 'superseded',
      supersededCause: 'closed_without_decision',
      decidedById: null,
    });
  });
});

// THE RESIDUE THE STORY'S COVERAGE FLOOR FOUND (MOTIR-7479) — arms no door reaches in an
// ordinary fixture, each driven here by a real row rather than skipped.
describe('the handler, called directly', () => {
  const argsFor =
    (gateRow: { id: string; workItemId: string | null; subjectId: string }) =>
    (tx: Parameters<typeof manualWorkGateHandler.approve>[0]['tx']) => ({
      gate: {
        id: gateRow.id,
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: gateRow.workItemId,
        subjectId: gateRow.subjectId,
      },
      item: null,
      ctx: fx.ctx,
      tx,
      resolvedStatusKey: 'done',
      refusalVerdict: null,
    });

  it('resolves the card while it is manual, and nothing once it is not or is gone', async () => {
    const card = await manualCard();
    const gate = await raisedGate(card.id);
    const resolve = (subjectId: string) =>
      withWorkspaceContext(fx.ctx, (tx) =>
        manualWorkGateHandler.resolveSubject({ ...argsFor({ ...gate, subjectId })(tx) }),
      );

    expect((await resolve(card.id))?.id).toBe(card.id);
    expect(await resolve('no-such-card')).toBeNull();
    await adminDb.workItem.update({
      where: { id: card.id },
      data: { type: 'code', executor: 'coding_agent' },
    });
    expect(await resolve(card.id)).toBeNull();
    expect(isManualWork({ type: 'code', executor: 'human' })).toBe(true);
  });

  it('has no version and asks nothing on review entry', async () => {
    const card = await manualCard();
    const gate = await raisedGate(card.id);
    await withWorkspaceContext(fx.ctx, async (tx) => {
      const args = argsFor(gate)(tx);
      expect(await manualWorkGateHandler.subjectVersion(args)).toBeNull();
      expect(await manualWorkGateHandler.currentSubject(args)).toBeNull();
    });
  });

  it('approve with no status in the target category writes none, and moves nothing', async () => {
    const card = await manualCard();
    const gate = await raisedGate(card.id);
    const effect = await withWorkspaceContext(fx.ctx, (tx) =>
      manualWorkGateHandler.approve({ ...argsFor(gate)(tx), resolvedStatusKey: null }),
    );
    expect(effect).toEqual({
      statusWritten: null,
      statusDeferredReason: 'no_status_in_target_category',
    });
    expect(await statusOf(card.id)).toBe('todo');
  });

  it('requestChanges refuses by name even when a caller reaches past the door', async () => {
    const card = await manualCard();
    const gate = await raisedGate(card.id);
    const err = await withWorkspaceContext(fx.ctx, (tx) =>
      manualWorkGateHandler.requestChanges(argsFor(gate)(tx)),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalGateVerbNotOfferedError);
  });
});

describe('the raise’s remaining guards', () => {
  it('a card in another workspace, or no card at all, is `not_found`', async () => {
    const other = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTH' });
    const theirs = await workItemsService.createWorkItem(
      {
        projectId: other.projectId,
        kind: 'task',
        title: 'Theirs',
        type: 'manual',
        executor: 'human',
      },
      other.ctx,
    );
    expect((await raise(theirs.id, fx.ownerId)).skipped).toBe('not_found');
    expect((await raise('no-such-card', fx.ownerId)).skipped).toBe('not_found');
    expect(await adminDb.approvalGate.count({ where: { kind: 'manual_work' } })).toBe(0);
  });

  it('a choice card is asked by its own kind — no second question', async () => {
    const choice = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Pick one',
        type: 'choice',
        executor: 'human',
      },
      fx.ctx,
    );
    expect((await raise(choice.id, fx.ownerId)).skipped).toBe('asked_by_own_kind');
    expect(await gatesOf(choice.id)).toHaveLength(0);
  });

  it('an unassigned card a run with NO starter reaches routes to its reporter, unassigned', async () => {
    const card = await manualCard();
    const result = await raise(card.id, null);
    expect(result).toMatchObject({
      raised: true,
      assignedToStarter: false,
      routedToId: fx.ownerId,
    });
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).assigneeId).toBe(
      null,
    );
  });
});

describe('hopsToStatus', () => {
  const hops = (status: string, target: string) =>
    withWorkspaceContext(fx.ctx, (tx) =>
      hopsToStatus({ projectId: fx.projectId, workspaceId: fx.workspaceId, status }, target, tx),
    );

  it('walks the declared edges, and is empty when the card is already there', async () => {
    expect(await hops('todo', 'done')).toEqual(['in_progress', 'done']);
    expect(await hops('done', 'done')).toEqual([]);
  });

  it('is null for a status the workflow does not have, or a target no edge reaches', async () => {
    expect(await hops('todo', 'no-such-status')).toBeNull();
    expect(await hops('no-such-status', 'done')).toBeNull();
    await adminDb.workflowTransition.deleteMany({ where: { projectId: fx.projectId } });
    expect(await hops('todo', 'done')).toBeNull();
  });

  it('is the one direct hop under an OPEN workflow policy', async () => {
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { workflowPolicyMode: 'open' },
    });
    expect(await hops('todo', 'done')).toEqual(['done']);
  });
});

describe('the reads the rows and the run surfaces make', () => {
  it('an empty set reads nothing', async () => {
    await withWorkspaceContext(fx.ctx, async (tx) => {
      expect(
        await approvalGateRepository.findLatestWithPeopleByWorkItems([], 'manual_work', tx),
      ).toEqual(new Map());
      expect(await workItemTodoRepository.countByWorkItems([], tx)).toEqual(new Map());
    });
  });

  it('the head per card is the live question, else the latest decided one', async () => {
    const card = await manualCard();
    const first = await raisedGate(card.id);
    await approvalGatesService.decide(
      { gateId: first.id, decision: 'approve', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );
    const read = () =>
      withWorkspaceContext(fx.ctx, (tx) =>
        approvalGateRepository.findLatestWithPeopleByWorkItems([card.id], 'manual_work', tx),
      );
    expect((await read()).get(card.id)).toMatchObject({ id: first.id, state: 'approved' });

    // Reopened and reached again: the awaiting row is the head, though an older one was decided.
    await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);
    expect((await raise(card.id, fx.ownerId)).raised).toBe(true);
    const [, second] = await adminDb.approvalGate.findMany({
      where: { workItemId: card.id, kind: 'manual_work' },
      orderBy: { createdAt: 'asc' },
    });
    expect((await read()).get(card.id)).toMatchObject({ id: second!.id, state: 'awaiting' });
  });
});

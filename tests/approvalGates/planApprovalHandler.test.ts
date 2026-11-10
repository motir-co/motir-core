import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { APPROVAL_GATE_HANDLERS, handlerFor, type GateHandler } from '@/lib/approvalGates/registry';
import {
  ApprovalGateStaleSubjectError,
  ApprovalGateVerbNotOfferedError,
} from '@/lib/approvalGates/errors';
import {
  PLAN_DIGEST_PREFIX,
  canonicalJson,
  planGateStampInputs,
  planProposalDigest,
  planSubjectVersion,
  type PlanDigestRow,
} from '@/lib/approvalGates/planApprovalDigest';
import {
  currentPlanSubject,
  planApprovalGateHandler,
  planGateHeldOf,
  resolvePlanGateRoute,
} from '@/lib/approvalGates/planApprovalHandler';
import { computeGateStamp, DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { PlanRevisionInFlightError, PlanTargetImmutableError } from '@/lib/plans/errors';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { APPROVE_TX_BUDGET, plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// THE `plan_approval` HANDLER AND ITS REGISTRATION (Story MOTIR-6012 · Subtask
// MOTIR-6035; ADR `approval-gates.md` §11.3–§11.6) — against a REAL Postgres.
//
// Every gate here is the one `markPlanned` RAISES (MOTIR-6036): card-less, the plan in
// `subjectId`, routed to the requester. Everything else — the plan, its proposals, the
// revision lease, the corrections — goes through the real `plansService` doors, and
// every decision through the ONE decide door.

const HARNESS = { source: 'mcp' as const, harness: 'Claude Code', model: null };

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A `planned` plan holding `titles.length` adds, appended one per call. */
async function plannedPlan(titles: string[] = ['First proposal', 'Second proposal']) {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'A plan', authorSource: 'mcp', authorHarness: 'Claude Code' },
    fx.ctx,
  );
  const itemIds: string[] = [];
  for (const title of titles) {
    const after = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title, kind: 'task' } }],
      fx.ctx,
    );
    itemIds.push(after.items[after.items.length - 1]!.id);
  }
  await plansService.markPlanned(plan.id, fx.ctx);
  return { planId: plan.id, itemIds };
}

/** The awaiting gate `markPlanned` raised for `planId` (MOTIR-6036). */
function raiseGate(planId: string) {
  return adminDb.approvalGate.findFirstOrThrow({
    where: { workItemId: null, kind: 'plan_approval', subjectId: planId, state: 'awaiting' },
  });
}

/** A planned plan, its gate, and the stamp the render read hands a reader. */
async function gatedPlan(titles?: string[]) {
  const plan = await plannedPlan(titles);
  const gate = await raiseGate(plan.planId);
  const read = await approvalGatesService.getForPlan({ planId: plan.planId }, fx.ctx);
  return { ...plan, gate, stamp: read.stamp! };
}

const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });
const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });
const digestOf = (planId: string) =>
  withWorkspaceContext(fx.ctx, (tx) => planSubjectVersion(planId, tx));

async function secondMember(role: 'viewer' | 'member') {
  const other = await createTestUser({ email: `${role}@ex.com`, name: `A ${role}` });
  await workspacesService.addMember({ userId: other.id, workspaceId: fx.workspaceId });
  await addToProjectAs({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: other.id,
    role,
  });
  return { userId: other.id, workspaceId: fx.workspaceId };
}

// ─── the digest (§11.3) — pure ───────────────────────────────────────────────

describe('the DIGEST — exactly §11.3’s inputs, one function', () => {
  const rows: PlanDigestRow[] = [
    {
      id: 'b-item',
      op: 'modify',
      workItemId: 'wi-1',
      parentRef: null,
      blockedByRefs: ['planItem:a-item', 'wi-9'],
      proposedFields: null,
      patch: { title: 'Rewritten', b: 2, a: { z: 1, y: [3, { k: null }] } },
      baseRevision: 'rev-7',
    },
    {
      id: 'a-item',
      op: 'add',
      workItemId: null,
      parentRef: 'wi-root',
      blockedByRefs: [],
      proposedFields: { title: 'New', kind: 'task' },
      patch: null,
      baseRevision: null,
    },
  ];

  it('GOLDEN — the exact digest string for a fixed proposal set', () => {
    // Computed OUTSIDE this codebase from §11.3's text alone (Python's
    // `json.dumps(sort_keys=True, separators=(',', ':'))` + sha256), so it pins the
    // contract rather than echoing the implementation.
    expect(planProposalDigest(rows)).toBe(
      'plan.v1.64e927875c8c1e76deade66edb445ea0867d365e55c8aa91d5131f081ad0c5ae',
    );
  });

  it('is ORDER-free over the rows (sorted by id bytes) and prefixed `plan.v1.` with 64 hex', () => {
    const digest = planProposalDigest(rows);
    expect(planProposalDigest([...rows].reverse())).toBe(digest);
    expect(digest.startsWith(PLAN_DIGEST_PREFIX)).toBe(true);
    expect(digest.slice(PLAN_DIGEST_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('canonical JSON sorts every object’s keys recursively, keeps nulls and array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,1]},"b":1}',
    );
    // A re-ordered `blockedByRefs` is a different proposal.
    const swapped = rows.map((row) =>
      row.id === 'b-item' ? { ...row, blockedByRefs: ['wi-9', 'planItem:a-item'] } : row,
    );
    expect(planProposalDigest(swapped)).not.toBe(planProposalDigest(rows));
  });

  it('reads NOTHING outside the eight columns — extra fields on a row do not move it', () => {
    const withNoise = rows.map((row) => ({
      ...row,
      createdAt: new Date(),
      planId: 'p',
      workspaceId: 'w',
    }));
    expect(planProposalDigest(withNoise)).toBe(planProposalDigest(rows));
  });

  it('an `add`’s supersedesRefs (MOTIR-6630) moves it when non-empty and is invisible when empty', () => {
    // Empty: the golden digest above — computed before the column existed — holds.
    const empty = rows.map((row) => ({ ...row, supersedesRefs: [] }));
    expect(planProposalDigest(empty)).toBe(planProposalDigest(rows));
    // Non-empty: a correction replacing the set moves the version.
    const withEdge = rows.map((row) =>
      row.id === 'a-item' ? { ...row, supersedesRefs: ['wi-old'] } : row,
    );
    expect(planProposalDigest(withEdge)).not.toBe(planProposalDigest(rows));
  });

  it('an add’s `authorFinished` (MOTIR-10491) never moves it — absent, true or null', () => {
    const withState = (value: true | null) =>
      rows.map((row) =>
        row.id === 'a-item'
          ? { ...row, proposedFields: { ...(row.proposedFields as object), authorFinished: value } }
          : row,
      );
    // Absent is the golden digest above, computed before the key existed.
    expect(planProposalDigest(withState(true))).toBe(planProposalDigest(rows));
    expect(planProposalDigest(withState(null))).toBe(planProposalDigest(rows));
    // A row whose only key is the state hashes as an empty object, never as null.
    const onlyState = rows.map((row) =>
      row.id === 'a-item' ? { ...row, proposedFields: { authorFinished: true } } : row,
    );
    const empty = rows.map((row) => (row.id === 'a-item' ? { ...row, proposedFields: {} } : row));
    expect(planProposalDigest(onlyState)).toBe(planProposalDigest(empty));
    // Every OTHER key of the fields still moves it.
    const retitled = rows.map((row) =>
      row.id === 'a-item' ? { ...row, proposedFields: { title: 'Renamed', kind: 'task' } } : row,
    );
    expect(planProposalDigest(retitled)).not.toBe(planProposalDigest(rows));
    // The input row is never mutated by the exclusion.
    const stated = withState(true);
    planProposalDigest(stated);
    expect(stated.find((r) => r.id === 'a-item')!.proposedFields).toHaveProperty(
      'authorFinished',
      true,
    );
  });

  it('the stamp inputs carry only the digest — no companion, no card body', () => {
    expect(planGateStampInputs('plan.v1.x')).toEqual({
      subjectVersion: 'plan.v1.x',
      companionSubjectVersion: null,
      descriptionMd: null,
    });
  });
});

describe('the DIGEST moves with the proposal set and nothing else (real rows)', () => {
  it('moves on an append, a correction of each hashed field, and a withdrawal', async () => {
    const { planId, itemIds } = await plannedPlan(['One', 'Two', 'Three']);
    const seen = new Set([await digestOf(planId)]);
    const moved = async () => {
      const next = await digestOf(planId);
      expect(seen.has(next)).toBe(false);
      seen.add(next);
    };

    await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'Four', kind: 'task' } }],
      fx.ctx,
      { revision: true },
    );
    await moved();
    await plansService.correctProposal(planId, itemIds[0]!, { title: 'One, corrected' }, fx.ctx);
    await moved();
    await plansService.correctProposal(
      planId,
      itemIds[1]!,
      { blockedByRefs: [`planItem:${itemIds[0]}`] },
      fx.ctx,
    );
    await moved();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'A parent' },
      fx.ctx,
    );
    await plansService.correctProposal(planId, itemIds[2]!, { parentRef: story.id }, fx.ctx);
    await moved();
    await plansService.withdrawProposal(planId, itemIds[2]!, fx.ctx);
    await moved();
  });

  it('does NOT move when the plan’s title, summary or status changes', async () => {
    const { planId } = await plannedPlan();
    const before = await digestOf(planId);
    await adminDb.plan.update({
      where: { id: planId },
      data: { title: 'Renamed', summary: 'Now with a summary', status: 'stale' },
    });
    expect(await digestOf(planId)).toBe(before);
  });
});

// ─── registration (§11.4–§11.6) ──────────────────────────────────────────────

describe('REGISTRATION — `handlerFor(plan_approval)` is the handler', () => {
  it('returns it, with the kind’s permission, no status intent and no card routing', () => {
    const handler = handlerFor('plan_approval');
    expect(handler).toBe(planApprovalGateHandler);
    expect(handler.permission).toBe('ai:decide_plan');
    expect(handler.statusIntent).toBeNull();
    expect(handler.stampsLiveVersion).toBe(true);
    expect(typeof handler.decline).toBe('function');
    expect(handler.overturn).toBeUndefined();
    expect(handler.settingsDoor).toBeUndefined();
    expect(handler.transactionBudget).toEqual(APPROVE_TX_BUDGET);
  });

  it('`routeTo` answers null (card-less, synchronous); `currentSubject` needs the gate', async () => {
    const { planId } = await plannedPlan();
    await withWorkspaceContext(fx.ctx, async (tx) => {
      expect(planApprovalGateHandler.routeTo({ item: null, ctx: fx.ctx, tx })).toBeNull();
      expect(await planApprovalGateHandler.currentSubject({ item: null, ctx: fx.ctx, tx })).toBe(
        null,
      );
      const withGate = {
        item: null,
        ctx: fx.ctx,
        tx,
        gate: {
          id: 'g',
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: null,
          subjectId: planId,
        },
        resolvedStatusKey: null,
        refusalVerdict: null,
      };
      expect(await planApprovalGateHandler.currentSubject(withGate)).toBe(planId);
      expect((await planApprovalGateHandler.resolveSubject(withGate))?.id).toBe(planId);
    });
    await plansService.declinePlan(planId, fx.ctx);
    await withWorkspaceContext(fx.ctx, async (tx) => {
      expect(await currentPlanSubject(planId, fx.workspaceId, tx)).toBeNull();
      expect(await currentPlanSubject('no-such-plan', fx.workspaceId, tx)).toBeNull();
    });
  });

  it('`requestChanges` refuses by name even when reached directly', async () => {
    const err = await planApprovalGateHandler
      .requestChanges({ gate: { id: 'g1' } } as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalGateVerbNotOfferedError);
    expect((err as ApprovalGateVerbNotOfferedError).reason).toBe('request_changes_on_plan');
  });
});

describe('ROUTING (§11.6) — the requester, else the workspace owner, else nobody', () => {
  it('routes to `createdById`, to the OWNER on a cadence plan, and to nobody with no owner', async () => {
    const other = await createTestUser({ email: 'asker@ex.com', name: 'Asker' });
    await withWorkspaceContext(fx.ctx, async (tx) => {
      expect(
        await resolvePlanGateRoute({ createdById: other.id, workspaceId: fx.workspaceId }, tx),
      ).toBe(other.id);
      expect(
        await resolvePlanGateRoute({ createdById: null, workspaceId: fx.workspaceId }, tx),
      ).toBe(fx.ownerId);
    });
    // A workspace with no Manager — an invariant violation — routes to nobody.
    // (The stand-in is the oldest MANAGER since MOTIR-6462, so a legacy `admin`
    // would stand in; the row is made a plain Member instead.)
    await adminDb.workspaceMembership.updateMany({
      where: { workspaceId: fx.workspaceId, workspaceRole: 'manager' },
      data: { workspaceRole: 'member' },
    });
    await withWorkspaceContext(fx.ctx, async (tx) => {
      expect(
        await resolvePlanGateRoute({ createdById: null, workspaceId: fx.workspaceId }, tx),
      ).toBeNull();
    });
  });
});

// ─── the verbs through the ONE door (§11.4–§11.5) ────────────────────────────

describe('APPROVE through the door — materializes exactly as `approvePlan` does', () => {
  it('records plan_permission, the digest, no status and the deferred reason; the plan materializes', async () => {
    const { planId, gate, stamp } = await gatedPlan(['Alpha', 'Beta']);
    const digest = await digestOf(planId);

    const result = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui', stamp },
      fx.ctx,
    );

    expect(result.effect).toEqual({
      statusWritten: null,
      statusDeferredReason: 'plan_decision_writes_no_work_item',
    });
    expect(result.filesKept).toBeNull();
    expect(result.gate).toMatchObject({
      state: 'approved',
      workItemId: null,
      decidedById: fx.ownerId,
      decidedUnderAuthority: 'plan_permission',
      decisionSource: 'ui',
      subjectVersion: digest,
      outcomeRef: null,
    });
    expect(await planRow(planId)).toMatchObject({ status: 'approved', decidedById: fx.ownerId });
    const made = await adminDb.workItem.findMany({
      where: { projectId: fx.projectId },
      orderBy: { title: 'asc' },
    });
    expect(made.map((item) => [item.title, item.kind])).toEqual([
      ['Alpha', 'task'],
      ['Beta', 'task'],
    ]);
    const trail = await adminDb.planRevision.findMany({
      where: { planId, changeKind: 'approved' },
    });
    expect(trail).toHaveLength(1);
  });

  it('produces the same tree and trail as the plan’s own approve door', async () => {
    const viaDoor = await gatedPlan(['Same one', 'Same two']);
    const viaPlan = await plannedPlan(['Same one', 'Same two']);
    await approvalGatesService.decide(
      { gateId: viaDoor.gate.id, decision: 'approve', source: 'ui', stamp: viaDoor.stamp },
      fx.ctx,
    );
    await plansService.approvePlan(viaPlan.planId, fx.ctx);

    const shape = async (planId: string) => {
      const items = await adminDb.planItem.findMany({ where: { planId } });
      const cards = await adminDb.workItem.findMany({
        where: { id: { in: items.map((i) => i.workItemId!) } },
      });
      const trail = await adminDb.planRevision.findMany({
        where: { planId },
        orderBy: { changedAt: 'asc' },
      });
      return {
        cards: cards.map((c) => [c.title, c.kind, c.status]).sort(),
        trail: trail.map((r) => [r.changeKind, r.diff]),
        status: (await planRow(planId)).status,
      };
    };
    expect(await shape(viaDoor.planId)).toEqual(await shape(viaPlan.planId));
  });
});

describe('REQUEST CHANGES is not offered (§11.4)', () => {
  it('the door refuses it with `request_changes_on_plan`, a note or not; nothing moves', async () => {
    const { planId, gate, stamp } = await gatedPlan();
    for (const noteMd of [null, 'Please split this.']) {
      const err = await approvalGatesService
        .decide(
          { gateId: gate.id, decision: 'request_changes', noteMd, source: 'ui', stamp },
          fx.ctx,
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApprovalGateVerbNotOfferedError);
      expect((err as ApprovalGateVerbNotOfferedError).reason).toBe('request_changes_on_plan');
    }
    expect((await gateRow(gate.id)).state).toBe('awaiting');
    expect((await planRow(planId)).status).toBe('planned');
  });
});

describe('DECLINE (§11.4) — the new terminal state, and an OPTIONAL note', () => {
  it('with no note: the gate is `declined` with a NULL note, the plan `declined` / `reviewed`', async () => {
    const { planId, gate, stamp } = await gatedPlan();
    const result = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'decline', noteMd: '   ', source: 'ui', stamp },
      fx.ctx,
    );
    expect(result.gate).toMatchObject({
      state: 'declined',
      noteMd: null,
      decidedUnderAuthority: 'plan_permission',
    });
    expect(result.effect.statusDeferredReason).toBe('plan_decision_writes_no_work_item');
    expect(await planRow(planId)).toMatchObject({
      status: 'declined',
      decisionReason: 'reviewed',
      decidedById: fx.ownerId,
    });
    // Nothing was materialized.
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
    // Decided is frozen, for `declined` too (MOTIR-6032's trigger).
    await expect(
      adminDb.approvalGate.update({ where: { id: gate.id }, data: { noteMd: 'rewritten' } }),
    ).rejects.toThrow();
  });

  it('with a note: the note is stored', async () => {
    const { gate, stamp } = await gatedPlan();
    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'decline', noteMd: 'Not this quarter.', source: 'ui', stamp },
      fx.ctx,
    );
    expect(await gateRow(gate.id)).toMatchObject({
      state: 'declined',
      noteMd: 'Not this quarter.',
    });
  });

  it('on any other kind it is refused with `decline_on_other_kind`', async () => {
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'A design card' },
      fx.ctx,
    );
    const gate = await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: card.id,
        kind: 'design_result',
        subjectId: 'design-evidence-1',
        routedToId: fx.ownerId,
      },
    });
    const err = await approvalGatesService
      .decide(
        { gateId: gate.id, decision: 'decline', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalGateVerbNotOfferedError);
    expect((err as ApprovalGateVerbNotOfferedError).reason).toBe('decline_on_other_kind');
    expect((await gateRow(gate.id)).state).toBe('awaiting');
  });

  it('refuses a plan that is no longer `planned`, whatever the digest says', async () => {
    const { planId, gate, stamp } = await gatedPlan();
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'stale' } });
    await expect(
      approvalGatesService.decide(
        { gateId: gate.id, decision: 'decline', source: 'ui', stamp },
        fx.ctx,
      ),
    ).rejects.toMatchObject({ code: 'PLAN_NOT_IN_EXPECTED_STATUS' });
    await expect(
      approvalGatesService.decide(
        { gateId: gate.id, decision: 'approve', source: 'ui', stamp },
        fx.ctx,
      ),
    ).rejects.toMatchObject({ code: 'PLAN_NOT_IN_EXPECTED_STATUS' });
    expect((await gateRow(gate.id)).state).toBe('awaiting');
  });
});

// ─── held (§11.5c) and stale (§11.3) ─────────────────────────────────────────

describe('HELD while a revision is in flight — derived, never stored (§11.5c)', () => {
  it('refuses BOTH verbs, keeps the gate awaiting, says so on the DTO — then the SAME gate decides', async () => {
    const { planId, gate, stamp } = await gatedPlan();
    await plansService.acquireRevisionLease(planId, fx.ctx, HARNESS);

    for (const decision of ['approve', 'decline'] as const) {
      const err = await approvalGatesService
        .decide({ gateId: gate.id, decision, source: 'ui', stamp }, fx.ctx)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlanRevisionInFlightError);
      expect((err as PlanRevisionInFlightError).heldBy).toBe('Claude Code');
    }
    expect((await gateRow(gate.id)).state).toBe('awaiting');
    // The revision RE-OPENED the plan (MOTIR-8208); its gate is held, not withdrawn.
    expect((await planRow(planId)).status).toBe('generating');

    const read = await approvalGatesService.getForPlan({ planId }, fx.ctx);
    expect(read.gate?.held).toMatchObject({ reason: 'revision_in_flight', heldBy: 'Claude Code' });
    expect(Date.parse(read.gate!.held!.expiresAt)).toBeGreaterThan(Date.now());
    // MOTIR-7988 amends §11.5c: a held plan is being PLANNED again, so it leaves
    // Waiting on you (it is listed under Planning) and comes back on release.
    const queue = await approvalGatesService.listAwaitingMe({ ...fx.ctx, projectId: fx.projectId });
    expect(queue.items.map((r) => r.gateId)).not.toContain(gate.id);

    await plansService.releaseRevisionLease(planId, fx.ctx, HARNESS);
    const back = await approvalGatesService.listAwaitingMe({ ...fx.ctx, projectId: fx.projectId });
    expect(back.items.map((r) => r.gateId)).toContain(gate.id);
    const after = await approvalGatesService.getForPlan({ planId }, fx.ctx);
    expect(after.gate?.held).toBeNull();
    const decided = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'decline', source: 'ui', stamp: after.stamp! },
      fx.ctx,
    );
    expect(decided.gate).toMatchObject({ id: gate.id, state: 'declined' });
  });

  it('`planGateHeldOf` is null for an ended or lapsed lease', () => {
    const t0 = new Date('2026-09-23T10:00:00Z');
    const started = { changeKind: 'revision_started', changedAt: t0, actorHarness: 'X' };
    expect(planGateHeldOf([started, { changeKind: 'revision_ended', changedAt: t0 }], t0)).toBe(
      null,
    );
    expect(planGateHeldOf([started], new Date(t0.getTime() + 11 * 60_000))).toBeNull();
    expect(planGateHeldOf([started], t0)).toEqual({
      reason: 'revision_in_flight',
      heldBy: 'X',
      expiresAt: new Date(t0.getTime() + 10 * 60_000).toISOString(),
    });
  });
});

describe('a STALE stamp is refused as `subject` (§11.3; MOTIR-5232)', () => {
  it('after a correction outside a lease, and after a revision — a fresh read then decides', async () => {
    const { planId, itemIds, gate, stamp } = await gatedPlan();

    await plansService.correctProposal(planId, itemIds[0]!, { title: 'Corrected' }, fx.ctx);
    const err = await approvalGatesService
      .decide({ gateId: gate.id, decision: 'approve', source: 'ui', stamp }, fx.ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalGateStaleSubjectError);
    expect((err as ApprovalGateStaleSubjectError).moved).toEqual(['subject']);
    const since = await approvalGatesService.getForPlan({ planId, since: stamp }, fx.ctx);
    expect(since.movedSince).toEqual(['subject']);

    // A REVISION rewrites the same plan: the stamp read between is stale again.
    await plansService.acquireRevisionLease(planId, fx.ctx, HARNESS);
    await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'Added in the revision', kind: 'task' } }],
      fx.ctx,
      { revision: true },
    );
    await plansService.releaseRevisionLease(planId, fx.ctx, HARNESS);
    await expect(
      approvalGatesService.decide(
        { gateId: gate.id, decision: 'approve', source: 'ui', stamp: since.stamp! },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateStaleSubjectError);
    expect((await gateRow(gate.id)).state).toBe('awaiting');

    const fresh = await approvalGatesService.getForPlan({ planId }, fx.ctx);
    expect(fresh.stamp).toBe(computeGateStamp(planGateStampInputs(await digestOf(planId))));
    const decided = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui', stamp: fresh.stamp! },
      fx.ctx,
    );
    expect(decided.gate.state).toBe('approved');
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(3);
  });
});

// ─── the actor gate (§11.6) ──────────────────────────────────────────────────

describe('the PERMISSION FLOOR — `ai:decide_plan`, and nothing else', () => {
  it('a viewer is refused both verbs; a member decides a gate routed to somebody else', async () => {
    const { planId, gate, stamp } = await gatedPlan();
    const viewer = await secondMember('viewer');
    for (const decision of ['approve', 'decline'] as const) {
      await expect(
        approvalGatesService.decide({ gateId: gate.id, decision, source: 'ui', stamp }, viewer),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    expect((await gateRow(gate.id)).state).toBe('awaiting');
    expect((await planRow(planId)).status).toBe('planned');
    expect((await approvalGatesService.getForPlan({ planId }, viewer)).canDecide).toBe(false);

    const member = await secondMember('member');
    expect((await approvalGatesService.getForPlan({ planId }, member)).canDecide).toBe(true);
    const decided = await approvalGatesService.decide(
      { gateId: gate.id, decision: 'decline', source: 'ui', stamp },
      member,
    );
    expect(decided.gate).toMatchObject({
      decidedById: member.userId,
      decidedUnderAuthority: 'plan_permission',
      routedToId: fx.ownerId,
    });
  });
});

// ─── the lock order (§11.5) ──────────────────────────────────────────────────

describe('THE LOCK ORDER — the plan row before the gate row (§11.5)', () => {
  const handlers = APPROVAL_GATE_HANDLERS as Record<string, GateHandler>;
  const real = handlers.plan_approval!;
  afterEach(() => {
    handlers.plan_approval = real;
  });

  /**
   * A PLAN-SIDE writer (the shape of MOTIR-6036's supersede): lock the plan, hold it,
   * then lock the gate and write. The door is started once the plan is locked.
   */
  async function raceAPlanSideWriter(gateId: string, planId: string) {
    let planLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      planLocked = resolve;
    });
    const writer = withWorkspaceContext(
      fx.ctx,
      async (tx) => {
        await planRepository.lockById(planId, tx);
        planLocked();
        await new Promise((resolve) => setTimeout(resolve, 800));
        await approvalGateRepository.lockById(gateId, tx);
        await planRepository.update(planId, { summary: 'Touched by a plan-side writer' }, tx);
      },
      { timeoutMs: 20_000, maxWaitMs: 20_000 },
    ).then(
      () => 'ok' as const,
      (e: unknown) => e,
    );
    await locked;
    const door = approvalGatesService
      .decide(
        { gateId, decision: 'decline', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
        fx.ctx,
      )
      .then(
        (r) => r,
        (e: unknown) => e,
      );
    return { writer: await writer, door: await door };
  }

  it('the door WAITS for the plan-side writer and both commit — no deadlock', async () => {
    const { planId, gate } = await gatedPlan();
    const { writer, door } = await raceAPlanSideWriter(gate.id, planId);
    expect(writer).toBe('ok');
    expect(door).toMatchObject({ gate: { id: gate.id, state: 'declined' } });
    expect(await planRow(planId)).toMatchObject({
      status: 'declined',
      summary: 'Touched by a plan-side writer',
    });
  });

  it('CONTROL — the generic gate-then-plan order deadlocks against the same writer', async () => {
    handlers.plan_approval = { ...real, lockSubjectBeforeGate: undefined };
    const { planId, gate } = await gatedPlan();
    const { writer, door } = await raceAPlanSideWriter(gate.id, planId);
    // Postgres breaks the cycle by aborting ONE side; which one is its choice.
    expect(String(writer === 'ok' ? door : writer)).toMatch(/deadlock/i);
  });
});

// ─── the rollback repair (the lazy `stale` backstop) ─────────────────────────

describe('A FAILED APPROVE keeps `approvePlan`’s repair — the lazy `stale` backstop', () => {
  it('a target finished under the door’s lock refuses the approve and leaves the plan `stale`', async () => {
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Racing target' },
      fx.ctx,
    );
    const plan = await plansService.createPlan(fx.projectId, { title: 'Modify it' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { title: 'Should never land' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    const gate = await raiseGate(plan.id);

    let lockTaken!: () => void;
    const locked = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    // The same bound, uncommitted transition `approvePersistGate.test.ts` races with:
    // the door's pre-transaction pass sees the old status, its locked pass the new.
    const transition = db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${fx.ownerId}, true)`;
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${fx.workspaceId}, true)`;
        await tx.$executeRaw`SELECT set_config('app.project_id', ${''}, true)`;
        await tx.$executeRaw`UPDATE "work_item" SET "status" = 'done' WHERE "id" = ${target.id}`;
        lockTaken();
        await new Promise((resolve) => setTimeout(resolve, 750));
      },
      { timeout: 20_000, maxWait: 20_000 },
    );
    await locked;
    const approving = approvalGatesService
      .decide(
        { gateId: gate.id, decision: 'approve', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
        fx.ctx,
      )
      .catch((e: unknown) => e);
    await transition;

    expect(await approving).toBeInstanceOf(PlanTargetImmutableError);
    expect((await planRow(plan.id)).status).toBe('stale');
    // The backstop's `stale` write withdraws the question with it (MOTIR-6036).
    expect(await gateRow(gate.id)).toMatchObject({
      state: 'superseded',
      supersededCause: 'plan_stale',
    });
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: target.id } })).title).toBe(
      'Racing target',
    );
  });
});

// ─── the row's summary (design Part XXII §22.3) ────────────────────────────────

describe('the To-approve ROW’s subject summary for a plan gate', () => {
  it('carries the plan, its conversation, its targets, the count, the author and `held`', async () => {
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'The story it re-plans' },
      fx.ctx,
    );
    const { planId } = await gatedPlan(['One', 'Two', 'Three']);
    const plan = await planRow(planId);
    await adminDb.planChangeSession.update({
      where: { id: plan.sessionId! },
      data: { targetKeys: [target.identifier, 'PROD-999'], turnCount: 2 },
    });

    const queue = await approvalGatesService.listAwaitingMe({ ...fx.ctx, projectId: fx.projectId });
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({ workItem: null, canDecide: true });
    expect(queue.items[0]!.subject).toEqual({
      kind: 'plan_approval',
      planId,
      sessionId: plan.sessionId,
      sessionHasTurns: true,
      title: 'A plan',
      projectName: fx.project.name,
      targets: [
        { key: target.identifier, title: 'The story it re-plans' },
        { key: 'PROD-999', title: null },
      ],
      proposalCount: 3,
      author: { source: 'mcp', harness: 'Claude Code', origin: 'user' },
      held: null,
      approving: false,
    });
  });

  it('`getForPlan` answers nothing for a plan with no gate, or no plan at all', async () => {
    // A `generating` plan asks nothing — only the close raises a gate (MOTIR-6036).
    const { id: planId } = await plansService.createPlan(
      fx.projectId,
      { title: 'Not closed' },
      fx.ctx,
    );
    for (const id of [planId, 'no-such-plan']) {
      const read = await approvalGatesService.getForPlan({ planId: id }, fx.ctx);
      expect(read).toMatchObject({ gate: null, stamp: null, canDecide: false });
    }
  });

  it('a DECIDED plan gate reads back with no stamp and no hold', async () => {
    const { planId, gate, stamp } = await gatedPlan();
    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'decline', source: 'ui', stamp },
      fx.ctx,
    );
    const read = await approvalGatesService.getForPlan({ planId, since: stamp }, fx.ctx);
    expect(read.gate).toMatchObject({ id: gate.id, state: 'declined', held: null });
    expect(read.stamp).toBeNull();
    expect(read.movedSince).toEqual([]);
    expect(read.routedToLabel).toBeTruthy();
  });
});

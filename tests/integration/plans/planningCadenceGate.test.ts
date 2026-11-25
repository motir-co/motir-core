import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { PlanWalkIncompleteError } from '@/lib/plans/errors';
import { resolvePlanningCadenceForJob } from '@/lib/ai/planningCadence';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { planDecisionService } from '@/lib/services/planDecisionService';
import { plansService } from '@/lib/services/plansService';
import { projectAiSettingsService } from '@/lib/services/projectAiSettingsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { runAddPlanItems } from '@/lib/mcp/tools/authorPlan';
import { runGetProjectState } from '@/lib/mcp/tools/getProjectState';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// ════════════════════════════════════════════════════════════════════════════
// Story MOTIR-12203 · MOTIR-12213 — THE PLANNING CADENCE, END TO END IN motir-core
// ════════════════════════════════════════════════════════════════════════════
//
// The story's motir-core cards each test their own unit: the stored setting
// (MOTIR-12204), the Settings control (MOTIR-12206) and the deliberate close
// (MOTIR-12207). This gate proves the pieces meet, through their real doors:
//
//   1. THE SETTING REACHES THE JOB. A value saved through
//      `projectAiSettingsService` is the value on the SERIALIZED `context` of a
//      plan job submitted afterwards, through BOTH submit paths
//      (`aiGenerationService.startGeneration`, which bypasses the shared planning
//      context, and `aiPlanEditsService`), resolved once per submit.
//   2. A DELIBERATE CLOSE LANDS END TO END. A close with `walkEndedBy` through the
//      MCP door (`add_plan_items final`) or the hosted door
//      (`aiGenerationService.appendProposals final`) closes `planned`, the real
//      approve door creates each laid-only card at `to_plan` with its edges, and
//      neither claim door hands such a card out.
//
// Real Postgres; no motir-core service or repository is mocked. The ONLY stub is
// the outbound HTTP call to motir-ai (`vi.stubGlobal('fetch', …)`), and every
// job-context assertion reads the request BODY, the only form motir-ai sees.

// The WIRE STRING, written out rather than imported from the code under test:
// motir-ai and plan.py read this same literal, and a test that read the name out
// of the module would agree with itself and prove nothing about the contract.
const WIRE_KEY = 'planningCadence';

const T = { timeout: 120_000 };

/** Every motir-ai request body that carried a job `context`, in order. */
let contexts: Record<string, unknown>[] = [];
let jobSeq = 0;
let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  contexts = [];
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.cadence-gate.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        const body = JSON.parse(init.body) as { context?: Record<string, unknown> };
        if (body.context) contexts.push(body.context);
      }
      return new Response(JSON.stringify({ jobId: `job-cadence-${++jobSeq}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const me = (): ProjectContext => ({
  userId: fx.ownerId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
  project: fx.project,
});
const owner = () => ({ userId: fx.ownerId, workspaceId: fx.workspaceId });

const saveCadence = (value: 'story' | 'subtask') =>
  projectAiSettingsService.updateAiSettings(
    fx.projectIdentifier,
    { aiPlanningCadence: value },
    owner(),
  );

/** The `context` the LAST motir-ai submit put on the wire. */
function lastContext(): Record<string, unknown> {
  expect(contexts.length).toBeGreaterThan(0);
  return contexts[contexts.length - 1]!;
}

const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });
const leftLaidOf = async (id: string) =>
  (
    (await adminDb.planItem.findUniqueOrThrow({ where: { id } })).proposedFields as {
      leftLaid?: unknown;
    }
  ).leftLaid;
const awaitingGate = async (planId: string) =>
  (
    await adminDb.approvalGate.findMany({ where: { kind: 'plan_approval', subjectId: planId } })
  ).find((g) => g.state === 'awaiting') ?? null;

async function createdFor(planItemId: string) {
  const item = await adminDb.planItem.findUniqueOrThrow({ where: { id: planItemId } });
  return adminDb.workItem.findUniqueOrThrow({ where: { id: item.workItemId! } });
}

async function approve(planId: string) {
  const read = await approvalGatesService.getForPlan({ planId }, fx.ctx);
  return planDecisionService.approve({ planId, stamp: read.stamp, source: 'ui' }, fx.ctx);
}

/**
 * The fixture where the old behaviour and the new differ: one AUTHORED add, a
 * laid-only add waiting on it (today: derived `blocked`), and a laid-only add
 * waiting on a committed DONE card (today: `todo`, and claimable).
 */
async function layTheWalk(planId: string) {
  const doneBlocker = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Already shipped' },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: doneBlocker.id }, data: { status: 'done' } });

  await plansService.recordPlanStep(
    planId,
    { sessionKey: 'lay', kind: 'lay', targetRef: null },
    fx.ctx,
  );
  const append = async (title: string, blockedByRefs?: string[]) =>
    (
      await plansService.addProposals(
        planId,
        [
          {
            op: 'add' as const,
            proposedFields: { title, kind: 'task' },
            ...(blockedByRefs ? { blockedByRefs } : {}),
          },
        ],
        fx.ctx,
      )
    ).appendedItemIds![0]!;
  const authored = await append('Authored');
  const waitsOnAuthored = await append('Laid, waits on the authored card', [
    `planItem:${authored}`,
  ]);
  const waitsOnDone = await append('Laid, waits on a done card', [doneBlocker.id]);
  await plansService.deepenProposal(planId, authored, { authorFinished: true }, fx.ctx);
  await plansService.endPlanStep(planId, 'lay', fx.ctx);
  return { authored, waitsOnAuthored, waitsOnDone, doneBlocker };
}

type Laid = Awaited<ReturnType<typeof layTheWalk>>;

/** The close's outcome, the same whichever door closed it. */
async function expectClosedPlanned(planId: string, laid: Laid, endedBy: string) {
  const row = await planRow(planId);
  expect(row.status).toBe('planned');
  expect(row.walkEndedBy).toBe(endedBy);
  expect(await leftLaidOf(laid.authored)).toBeUndefined();
  expect(await leftLaidOf(laid.waitsOnAuthored)).toBe(true);
  expect(await leftLaidOf(laid.waitsOnDone)).toBe(true);
  const read = await plansService.getPlan(planId, fx.ctx);
  expect(
    read.items
      .filter((i) => (i.proposedFields as { leftLaid?: unknown }).leftLaid === true)
      .map((i) => i.id)
      .sort(),
  ).toEqual([laid.waitsOnAuthored, laid.waitsOnDone].sort());
  expect(await awaitingGate(planId)).not.toBeNull();
}

/** Approve through the real door, then read back statuses, edges and both claim doors. */
async function expectApprovedToPlan(planId: string, laid: Laid) {
  await approve(planId);
  expect((await planRow(planId)).status).toBe('approved');

  const authored = await createdFor(laid.authored);
  const waitsOnAuthored = await createdFor(laid.waitsOnAuthored);
  const waitsOnDone = await createdFor(laid.waitsOnDone);
  expect(authored.status).toBe('todo');
  // Neither the derived `blocked` (a not-done blocker) nor `todo` (a done one).
  expect(waitsOnAuthored.status).toBe('to_plan');
  expect(waitsOnDone.status).toBe('to_plan');

  const edge = (fromId: string, toId: string) =>
    adminDb.workItemLink.findFirst({ where: { fromId, toId, kind: 'is_blocked_by' } });
  expect(await edge(waitsOnAuthored.id, authored.id)).not.toBeNull();
  expect(await edge(waitsOnDone.id, laid.doneBlocker.id)).not.toBeNull();

  for (const card of [waitsOnAuthored, waitsOnDone]) {
    const claim = await workItemsService.claimWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(claim.outcome).toBe('not_claimable');
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.status).toBe('to_plan');
  }
  // Take the authored card out of the ready set: what remains ready-shaped is only
  // the two `to_plan` cards, and the claim door must not hand either out.
  await adminDb.workItem.update({ where: { id: authored.id }, data: { status: 'done' } });
  const next = await workItemsService.claimNextReady(fx.projectId, null, fx.ctx);
  expect(next).toBeNull();
}

describe('the cadence setting reaches every plan job (MOTIR-12213)', () => {
  it('a never-written project submits `planningCadence: story`, the key PRESENT', T, async () => {
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(row.aiPlanningCadence).toBeNull();

    await aiGenerationService.startGeneration(me(), {});

    const context = lastContext();
    expect(Object.prototype.hasOwnProperty.call(context, WIRE_KEY)).toBe(true);
    expect(context[WIRE_KEY]).toBe('story');
  });

  it('a saved `subtask` rides a generation submit', T, async () => {
    await saveCadence('subtask');

    await aiGenerationService.startGeneration(me(), {});

    expect(lastContext()[WIRE_KEY]).toBe('subtask');
  });

  it('a saved `subtask` rides the plan-edits submit path too (an expand)', T, async () => {
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Expand me' },
      fx.ctx,
    );
    await saveCadence('subtask');

    await aiPlanEditsService.submitExpand(story.identifier, me());

    expect(lastContext()[WIRE_KEY]).toBe('subtask');
  });

  it(
    'the value is resolved once, at submit: a later save does not touch a submitted job',
    T,
    async () => {
      await saveCadence('subtask');
      await aiGenerationService.startGeneration(me(), {});
      const first = lastContext();

      await saveCadence('story');
      await aiGenerationService.startGeneration(me(), {});

      expect(contexts).toHaveLength(2);
      expect(first[WIRE_KEY]).toBe('subtask');
      expect(contexts[0]![WIRE_KEY]).toBe('subtask');
      expect(contexts[1]![WIRE_KEY]).toBe('story');
    },
  );

  it('a member without ai:configure is refused the write; the column is unchanged', T, async () => {
    const member = await createTestUser({ email: 'cadence-member@example.com' });
    await adminDb.workspaceMembership.create({
      data: { userId: member.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
    });

    await expect(
      projectAiSettingsService.updateAiSettings(
        fx.projectIdentifier,
        { aiPlanningCadence: 'subtask' },
        { userId: member.id, workspaceId: fx.workspaceId },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const row = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(row.aiPlanningCadence).toBeNull();
  });

  it('a project that does not exist resolves to story rather than throwing', T, async () => {
    await expect(resolvePlanningCadenceForJob('pj_does_not_exist', owner())).resolves.toBe('story');
  });

  it('get_project_state (the read plan.py takes) reports story, then subtask', T, async () => {
    const read = async () =>
      (
        (await runGetProjectState({ projectKey: fx.projectIdentifier }, fx.ctx))
          .structuredContent as Record<string, unknown>
      )[WIRE_KEY];

    expect(await read()).toBe('story');
    await saveCadence('subtask');
    expect(await read()).toBe('subtask');
  });
});

describe('a deliberate close lands planned, approvable and To plan (MOTIR-12213)', () => {
  it(
    '⚠️ the MCP close (`add_plan_items final`, `walkEndedBy: cadence`) → planned → to_plan, unclaimable',
    T,
    async () => {
      const planId = (await plansService.createPlan(fx.projectId, { title: 'Cadence' }, fx.ctx)).id;
      const laid = await layTheWalk(planId);

      const result = await runAddPlanItems(
        { planId, proposals: [], final: true, walkEndedBy: 'cadence' },
        fx.ctx,
      );

      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result)).not.toContain('PLAN_WALK_INCOMPLETE');
      await expectClosedPlanned(planId, laid, 'cadence');
      await expectApprovedToPlan(planId, laid);
    },
  );

  it(
    '⚠️ the hosted close (`appendProposals final`, `walkEndedBy: person_stop`) on a generated plan → the same',
    T,
    async () => {
      const { jobId, planId } = await aiGenerationService.startGeneration(me(), {});
      const laid = await layTheWalk(planId);

      const closed = await aiGenerationService.appendProposals(jobId, [], fx.ctx, {
        final: true,
        walkEndedBy: 'person_stop',
      });

      expect(closed.planned).toBe(true);
      expect(closed.stopped).toBeFalsy();
      await expectClosedPlanned(planId, laid, 'person_stop');
      await expectApprovedToPlan(planId, laid);
    },
  );

  it('a person_stop close of a plan holding nothing is discarded, no gate', T, async () => {
    const planId = (await plansService.createPlan(fx.projectId, { title: 'Empty' }, fx.ctx)).id;

    await runAddPlanItems(
      { planId, proposals: [], final: true, walkEndedBy: 'person_stop' },
      fx.ctx,
    );

    const row = await planRow(planId);
    expect(row.status).toBe('declined');
    expect(row.decisionReason).toBe('discarded');
    expect(await awaitingGate(planId)).toBeNull();
  });

  it(
    'a FAILED walk (`walkIncomplete`, no `walkEndedBy`) still closes stopped and cannot be approved',
    T,
    async () => {
      const { jobId, planId } = await aiGenerationService.startGeneration(me(), {});
      const laid = await layTheWalk(planId);

      const closed = await aiGenerationService.appendProposals(jobId, [], fx.ctx, {
        final: true,
        walkIncomplete: true,
      });

      expect(closed.stopped).toBe(true);
      const row = await planRow(planId);
      expect(row.status).toBe('stopped');
      expect(row.walkEndedBy).toBeNull();
      expect(await awaitingGate(planId)).toBeNull();
      expect(await leftLaidOf(laid.waitsOnAuthored)).toBeUndefined();
      expect(await leftLaidOf(laid.waitsOnDone)).toBeUndefined();
      await expect(approve(planId)).rejects.toBeInstanceOf(PlanWalkIncompleteError);
    },
  );
});

describe('the auto-plan cadence and the Planning cadence do not write each other', () => {
  it('saving either leaves the other exactly as written', T, async () => {
    const autoPlan = {
      aiAutoPlanEnabled: true,
      aiAutoPlanThreshold: 7,
      aiSprintPlanningEnabled: true,
      aiSprintLengthDays: 14,
    };
    const read = () => projectAiSettingsService.getAiSettings(fx.projectIdentifier, owner());

    await projectAiSettingsService.updateAiSettings(fx.projectIdentifier, autoPlan, owner());
    expect(await read()).toMatchObject({ ...autoPlan, aiPlanningCadence: 'story' });

    await saveCadence('subtask');
    expect(await read()).toMatchObject({ ...autoPlan, aiPlanningCadence: 'subtask' });

    const changed = {
      aiAutoPlanEnabled: false,
      aiAutoPlanThreshold: 3,
      aiSprintPlanningEnabled: false,
      aiSprintLengthDays: 7,
    };
    await projectAiSettingsService.updateAiSettings(fx.projectIdentifier, changed, owner());
    expect(await read()).toMatchObject({ ...changed, aiPlanningCadence: 'subtask' });
  });
});

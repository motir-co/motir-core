import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import {
  ApprovalGateAlreadyDecidedError,
  ApprovalGateStaleSubjectError,
  ApprovalGateSupersededError,
} from '@/lib/approvalGates/errors';
import {
  PlanDecisionStampRequiredError,
  PlanGateAwaitingError,
  PlanNotDecidableYetError,
  PlanNotInExpectedStatusError,
  PlanRevisionInFlightError,
} from '@/lib/plans/errors';
import { planDecisionService } from '@/lib/services/planDecisionService';
import { planDriftService } from '@/lib/services/planDriftService';
import { planReviewService } from '@/lib/services/planReviewService';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// EVERY DECISION OF A `planned` PLAN GOES THROUGH THE DECIDE DOOR (Story MOTIR-6012 ·
// Subtask MOTIR-6038; ADR `docs/decisions/approval-gates.md` §11.4, §11.5, §11.8).
//
// Two halves. THE INVENTORY reads the product's source and fails the build when a new
// writer of a decided plan status, or a new direct caller of the public approve /
// decline, appears — the guard §11.8's converse needs, because an entrance that
// decides around the door compiles and passes every other test. THE ENTRANCES run the
// one service every entrance calls against a real Postgres: the record each decision
// writes, the plain decline §11.8 item 5 keeps, and the refusals (held, stale,
// already decided, not decidable yet) every surface hears.

const ROOT = process.cwd();
const PRODUCT_DIRS = ['app', 'components', 'lib', 'packages/cli/src'];

function collect(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(rel));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** Source with its comments stripped — every guard here asserts an ABSENCE that the
 *  files discuss at length in prose. */
function codeOf(rel: string): string {
  return fs
    .readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '');
}

const SOURCE_FILES = PRODUCT_DIRS.flatMap(collect).sort();
const callersOf = (pattern: RegExp) => SOURCE_FILES.filter((f) => pattern.test(codeOf(f)));

/** The argument text of every call `name(` in `code`, up to its matching paren. */
function callArgs(code: string, name: RegExp): string[] {
  const out: string[] = [];
  const re = new RegExp(name.source, 'g');
  for (let m = re.exec(code); m; m = re.exec(code)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < code.length && depth > 0) {
      if (code[i] === '(') depth += 1;
      else if (code[i] === ')') depth -= 1;
      i += 1;
    }
    out.push(code.slice(start, i - 1));
  }
  return out;
}

/** A top-level `function name(` body, up to the next top-level function. */
function functionBody(code: string, name: string): string {
  const start = code.indexOf(`async function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = code.slice(start + 1).search(/\n(async )?function /);
  return next === -1 ? code.slice(start) : code.slice(start, start + 1 + next);
}

describe('THE INVENTORY — while a plan gate is awaiting, only the door writes `approved` / `declined` (§11.8)', () => {
  it('the public approve / decline have NO product caller — every entrance decides through `planDecisionService`', () => {
    // `approvePlan` / `declinePlan` remain as server-side composers that route an asked
    // plan through the door without a reader. A product caller would be a press that
    // never hands back what its reader saw.
    expect(callersOf(/\.approvePlan\(/)).toEqual([]);
    expect(callersOf(/\.declinePlan\(/)).toEqual([]);
  });

  it('the handler is the ONE caller of the in-transaction decision bodies', () => {
    expect(callersOf(/\.(approvePlanWithin|declinePlanWithin)\(/)).toEqual([
      'lib/approvalGates/planApprovalHandler.ts',
    ]);
  });

  it('the plain bodies are reached only through their composers and the §11.8 item-5 decline', () => {
    expect(callersOf(/\.approveUnaskedPlan\(/)).toEqual(['lib/services/plansService.ts']);
    expect(callersOf(/\.declineUnaskedPlan\(/)).toEqual([
      'lib/services/planDecisionService.ts',
      'lib/services/plansService.ts',
    ]);
  });

  it('the ENTRANCES — the plan routes and the v1 plan-approval route — call the decision service', () => {
    expect(callersOf(/planDecisionService\.(approve|decline|approveForWorkItem)\(/)).toEqual([
      'app/api/plans/[id]/approve/route.ts',
      'app/api/plans/[id]/decline/route.ts',
      'app/api/v1/work-items/[key]/plan-approval/route.ts',
      'lib/services/planDecisionService.ts',
    ]);
  });

  it('every CLIENT press hands back the stamp it rendered — the plan page and the rail (and its close guard)', () => {
    const pressers = callersOf(/\b(approvePlanRequest|declinePlanRequest)\(/).filter(
      (f) => f !== 'lib/planning/planReviewClient.ts',
    );
    // The `/ready` nudge pressed here until story MOTIR-5266 made it open the
    // overlay instead, whose rail is the press.
    expect(pressers).toEqual([
      'components/planning/PlanDetail.tsx',
      'lib/hooks/usePlanChangeConversation.ts',
    ]);
    for (const file of pressers) {
      const code = codeOf(file);
      const calls = [
        ...callArgs(code, /\bapprovePlanRequest\(/),
        ...callArgs(code, /\bdeclinePlanRequest\(/),
      ];
      expect(calls.length, file).toBeGreaterThan(0);
      for (const args of calls) {
        // Two arguments, the second one a stamp read off the review the reader saw.
        expect(args, `${file}: ${args}`).toMatch(/,\s*[\s\S]*stamp/);
      }
    }
  });

  it('names §11.8’s writers of a decided plan status, and no other appears', () => {
    // Every `planRepository.update(…)` whose data writes `approved` / `declined`.
    const writers: Record<string, number> = {};
    for (const file of SOURCE_FILES) {
      const n = callArgs(codeOf(file), /planRepository\.update\(/).filter((args) =>
        /status:\s*'(approved|declined)'/.test(args),
      ).length;
      if (n > 0) writers[file] = n;
    }
    expect(writers).toEqual({
      // §11.8 item 4 — `abandonedPlanService.reconcileAbandoned`, `generating` only.
      'lib/services/abandonedPlanService.ts': 1,
      // The session END's discard (AMENDMENT 23 §2, MOTIR-7637) — of the session's
      // LATEST plan, and only while it is `generating`: a plan is asked about once it
      // is `planned`, so there is never a question for this write to go around.
      //   Three: that discard, the keep-the-session arm's decline of the failed attempt's
      //   own `generating` plan beside a waiting one (MOTIR-7936), and the release of an
      //   attempt motir-ai cannot resume (MOTIR-9121), which declines it only while it is
      //   `generating` and still bound to the failed job — the same `generating`-only rule.
      'lib/services/planSessionEndService.ts': 3,
      // Four in plansService, each named:
      //   · markPlanned's EMPTY close (`declined` / `discarded`, §11.8 item 1 — no gate);
      //   · the LAST-withdrawal discard (item 3 — it supersedes `plan_discarded` in the
      //     same transaction);
      //   · `approveWithin` and `declineWithin` — the decision bodies, which refuse while
      //     a question is asked unless the door is running them (below).
      'lib/services/plansService.ts': 4,
    });

    const plans = codeOf('lib/services/plansService.ts');
    for (const body of ['approveWithin', 'declineWithin']) {
      expect(functionBody(plans, body), body).toContain('assertNoAwaitingGateUnlessDeciding(');
    }
    expect(codeOf('lib/services/planSessionEndService.ts')).toMatch(
      /if \(plan\?\.status === 'generating'\)/,
    );
    // Only the handler's seams waive it.
    expect(plans.match(/viaGate:\s*true/g)).toHaveLength(2);
  });
});

// ─── THE ENTRANCES, against a real Postgres ─────────────────────────────────

const HARNESS = { source: 'mcp' as const, harness: 'Claude Code', model: null };
const DONE = { fromStatusKey: 'in_progress', toStatusKey: 'done' };

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

const gatesOf = (planId: string) =>
  adminDb.approvalGate.findMany({
    where: { kind: 'plan_approval', subjectId: planId },
    orderBy: { createdAt: 'asc' },
  });
const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });
const workItemCount = () => adminDb.workItem.count({ where: { projectId: fx.projectId } });

/** A `generating` plan proposing one `add` per title. */
async function draftPlan(titles: string[]) {
  const plan = await plansService.createPlan(fx.projectId, { title: 'A plan' }, fx.ctx);
  const itemIds: string[] = [];
  for (const title of titles) {
    const after = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title, kind: 'task' } }],
      fx.ctx,
    );
    itemIds.push(after.items[after.items.length - 1]!.id);
  }
  return { planId: plan.id, itemIds };
}

/** A plan closed to `planned` — which raises its gate (MOTIR-6036). */
async function askedPlan(titles: string[] = ['First', 'Second']) {
  const plan = await draftPlan(titles);
  await plansService.markPlanned(plan.planId, fx.ctx);
  return plan;
}

/** What the planning surface renders — the review read every entrance presses from. */
const shownStamp = async (planId: string) =>
  (await planReviewService.getPlanReview(planId, fx.ctx)).gate?.stamp ?? null;

describe('APPROVE — one gate decision record, one materialize', () => {
  it('decides the gate with the decider, the authority and the stamp, and materializes the plan exactly once', async () => {
    const { planId } = await askedPlan(['First', 'Second']);
    const review = await planReviewService.getPlanReview(planId, fx.ctx);
    expect(review.gate).toMatchObject({ state: 'awaiting', held: null, canDecide: true });
    const before = await workItemCount();

    const plan = await planDecisionService.approve(
      { planId, stamp: review.gate!.stamp, source: 'api' },
      fx.ctx,
    );

    expect(plan.status).toBe('approved');
    expect(await workItemCount()).toBe(before + 2);
    const [gate] = await gatesOf(planId);
    expect(gate).toMatchObject({
      state: 'approved',
      decidedById: fx.ownerId,
      decidedUnderAuthority: 'plan_permission',
      decisionSource: 'api',
    });
    expect(gate!.subjectVersion).toMatch(/^plan\.v1\./);

    // A SECOND approve — from any entrance — is refused as already decided, and
    // nothing is materialized twice.
    const again = await planDecisionService
      .approve({ planId, stamp: review.gate!.stamp, source: 'api' }, fx.ctx)
      .catch((e: unknown) => e);
    expect(again).toBeInstanceOf(ApprovalGateAlreadyDecidedError);
    const unstamped = await planDecisionService
      .approve({ planId, stamp: null, source: 'api' }, fx.ctx)
      .catch((e: unknown) => e);
    expect(unstamped).toBeInstanceOf(ApprovalGateAlreadyDecidedError);
    expect(await workItemCount()).toBe(before + 2);
    // The decided review carries no stamp to press with.
    expect((await planReviewService.getPlanReview(planId, fx.ctx)).gate).toMatchObject({
      state: 'approved',
      stamp: null,
    });
  });

  it('carries the onboarding placeholder THROUGH the door — the draft is still renamed', async () => {
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { name: 'Untitled project' },
    });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Build it' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Tree', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx, { productName: 'Recipe Keeper' });

    await planDecisionService.approve(
      { planId: plan.id, stamp: await shownStamp(plan.id), source: 'api' },
      fx.ctx,
      { provisionalProjectName: 'Untitled project' },
    );

    const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(project.name).toBe('Recipe Keeper');
    expect((await gatesOf(plan.id))[0]?.state).toBe('approved');
  });

  it('an asked plan pressed WITHOUT its stamp is refused — the door never guesses what was seen', async () => {
    const { planId } = await askedPlan();
    await expect(
      planDecisionService.approve({ planId, stamp: null, source: 'api' }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanDecisionStampRequiredError);
    expect((await planRow(planId)).status).toBe('planned');
  });
});

describe('DECLINE — a gate verb for an asked plan, a plain write for an unasked one (§11.4, §11.8 item 5)', () => {
  it('declines a `planned` plan THROUGH its gate: the gate reads `declined`, the plan `declined` / `reviewed`', async () => {
    const { planId } = await askedPlan();
    const plan = await planDecisionService.decline(
      { planId, stamp: await shownStamp(planId), source: 'api', noteMd: null },
      fx.ctx,
    );
    expect(plan.status).toBe('declined');
    expect(await planRow(planId)).toMatchObject({
      status: 'declined',
      decisionReason: 'reviewed',
    });
    expect(await gatesOf(planId)).toEqual([
      expect.objectContaining({ state: 'declined', decidedById: fx.ownerId }),
    ]);
    // …and a later approve hears the same already-decided refusal.
    await expect(
      planDecisionService.approve({ planId, stamp: null, source: 'api' }, fx.ctx),
    ).rejects.toBeInstanceOf(ApprovalGateAlreadyDecidedError);
  });

  it('a `generating` plan’s discard is a PLAIN write and records no gate decision', async () => {
    const { planId } = await draftPlan(['Half written']);
    const plan = await planDecisionService.decline({ planId, stamp: null, source: 'api' }, fx.ctx);
    expect(plan.status).toBe('declined');
    expect((await planRow(planId)).decisionReason).toBe('discarded');
    expect(await gatesOf(planId)).toEqual([]);
  });

  it('a `stale` plan’s decline is a PLAIN write — its superseded gate stays superseded', async () => {
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'A target' },
      fx.ctx,
    );
    const created = await plansService.createPlan(fx.projectId, { title: 'Rework' }, fx.ctx);
    await plansService.addProposals(
      created.id,
      [{ op: 'modify', workItemId: target.id, patch: { title: 'New' } }],
      fx.ctx,
    );
    await plansService.markPlanned(created.id, fx.ctx);
    await planDriftService.markStaleForTerminalTarget(target.id, fx.workspaceId, DONE);
    expect((await planRow(created.id)).status).toBe('stale');

    // Approving a withdrawn question is the door's own refusal.
    await expect(
      planDecisionService.approve({ planId: created.id, stamp: null, source: 'api' }, fx.ctx),
    ).rejects.toBeInstanceOf(ApprovalGateSupersededError);

    const plan = await planDecisionService.decline(
      { planId: created.id, stamp: null, source: 'api' },
      fx.ctx,
    );
    expect(plan.status).toBe('declined');
    expect((await gatesOf(created.id)).map((g) => [g.state, g.decidedById])).toEqual([
      ['superseded', null],
    ]);
  });
});

describe('A STALE WINDOW’S PRESS — the plan was decided elsewhere first (Bug MOTIR-11464)', () => {
  // An overlay left open on a plan somebody then decided in another tab presses with the
  // stamp it was SHOWN. The door must refuse that press before anything materializes, so
  // the overlay can settle to the real decision instead of adding the items a second time.
  it('approved elsewhere: the stale approve is refused as decided and creates no work item', async () => {
    const { planId } = await askedPlan(['First', 'Second']);
    const shown = await shownStamp(planId);
    await planDecisionService.approve({ planId, stamp: shown, source: 'api' }, fx.ctx);
    const after = await workItemCount();

    for (const stamp of [shown, null]) {
      const err = await planDecisionService
        .approve({ planId, stamp, source: 'api' }, fx.ctx)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApprovalGateAlreadyDecidedError);
    }
    expect(await workItemCount()).toBe(after);
    // The read the overlay settles from answers the decision.
    expect((await planReviewService.getPlanReview(planId, fx.ctx)).status).toBe('approved');
  });

  it('declined elsewhere: the stale approve is refused as decided and creates no work item', async () => {
    const { planId } = await askedPlan(['First', 'Second']);
    const shown = await shownStamp(planId);
    const before = await workItemCount();
    await planDecisionService.decline(
      { planId, stamp: shown, source: 'api', noteMd: null },
      fx.ctx,
    );

    for (const stamp of [shown, null]) {
      const err = await planDecisionService
        .approve({ planId, stamp, source: 'api' }, fx.ctx)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApprovalGateAlreadyDecidedError);
    }
    expect(await workItemCount()).toBe(before);
    expect((await planReviewService.getPlanReview(planId, fx.ctx)).status).toBe('declined');
  });
});

describe('REFUSALS every entrance hears', () => {
  it('HELD while a revision is in flight — both verbs refused, the gate still awaiting', async () => {
    const { planId } = await askedPlan();
    const stamp = await shownStamp(planId);
    await plansService.acquireRevisionLease(planId, fx.ctx, HARNESS);

    await expect(
      planDecisionService.approve({ planId, stamp, source: 'api' }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanRevisionInFlightError);
    await expect(
      planDecisionService.decline({ planId, stamp, source: 'api' }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanRevisionInFlightError);
    // Re-opened by the revision (MOTIR-8208), its question held rather than withdrawn.
    expect((await planRow(planId)).status).toBe('generating');
    expect((await gatesOf(planId)).map((g) => g.state)).toEqual(['awaiting']);
    // The surface can say so before anyone presses.
    expect((await planReviewService.getPlanReview(planId, fx.ctx)).gate?.held).toMatchObject({
      reason: 'revision_in_flight',
    });
  });

  it('STALE — a stamp taken before the proposals moved is refused, and the fresh one decides', async () => {
    const { planId, itemIds } = await askedPlan(['One', 'Two']);
    const before = await shownStamp(planId);
    await plansService.correctProposal(planId, itemIds[0]!, { title: 'Corrected' }, fx.ctx);

    await expect(
      planDecisionService.approve({ planId, stamp: before, source: 'api' }, fx.ctx),
    ).rejects.toBeInstanceOf(ApprovalGateStaleSubjectError);
    await expect(
      planDecisionService.decline({ planId, stamp: before, source: 'api' }, fx.ctx),
    ).rejects.toBeInstanceOf(ApprovalGateStaleSubjectError);
    expect((await planRow(planId)).status).toBe('planned');

    const after = await shownStamp(planId);
    expect(after).not.toBe(before);
    await planDecisionService.approve({ planId, stamp: after, source: 'api' }, fx.ctx);
    expect((await planRow(planId)).status).toBe('approved');
  });

  it('NOT DECIDABLE YET — a `planned` plan with no gate (the pre-backfill state) is refused, never decided around the door', async () => {
    const { planId } = await askedPlan();
    await adminDb.approvalGate.deleteMany({ where: { subjectId: planId } });
    expect((await planReviewService.getPlanReview(planId, fx.ctx)).gate).toBeNull();

    await expect(
      planDecisionService.approve({ planId, stamp: null, source: 'api' }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotDecidableYetError);
    await expect(
      planDecisionService.decline({ planId, stamp: null, source: 'api' }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotDecidableYetError);
    expect((await planRow(planId)).status).toBe('planned');
  });

  it('a `generating` plan cannot be approved — the v1 loop’s *not yet*, carried as data', async () => {
    const { planId } = await draftPlan(['Half written']);
    const err = await planDecisionService
      .approve({ planId, stamp: null, source: 'api' }, fx.ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanNotInExpectedStatusError);
    expect((err as PlanNotInExpectedStatusError).actual).toBe('generating');
  });
});

describe('THE PLAIN BODIES refuse an asked plan under the plan lock (§11.8’s converse)', () => {
  it('`approveUnaskedPlan` / `declineUnaskedPlan` meet the awaiting gate and write nothing', async () => {
    const { planId } = await askedPlan();
    const [gate] = await gatesOf(planId);
    const before = await workItemCount();

    const approved = await plansService.approveUnaskedPlan(planId, fx.ctx).catch((e: unknown) => e);
    expect(approved).toBeInstanceOf(PlanGateAwaitingError);
    expect((approved as PlanGateAwaitingError).gateId).toBe(gate!.id);
    await expect(plansService.declineUnaskedPlan(planId, fx.ctx)).rejects.toBeInstanceOf(
      PlanGateAwaitingError,
    );

    expect((await planRow(planId)).status).toBe('planned');
    expect(await workItemCount()).toBe(before);
    expect((await gatesOf(planId)).map((g) => g.state)).toEqual(['awaiting']);
  });

  it('the server-side composer `approvePlan` decides an asked plan THROUGH the door, with no reader', async () => {
    const { planId } = await askedPlan();
    await plansService.approvePlan(planId, fx.ctx);
    expect(await gatesOf(planId)).toEqual([
      expect.objectContaining({ state: 'approved', decisionSource: 'api' }),
    ]);
    // Its documented contract holds: a decided plan is not in the expected status.
    await expect(plansService.approvePlan(planId, fx.ctx)).rejects.toBeInstanceOf(
      PlanNotInExpectedStatusError,
    );
    // …and the reader-less bypass is a server symbol no request can carry.
    expect(typeof DECIDED_WITHOUT_A_READER).toBe('symbol');
  });

  it('`declinePlan` decides an asked plan through the door and discards an unasked one plainly', async () => {
    const asked = await askedPlan();
    await plansService.declinePlan(asked.planId, fx.ctx);
    expect((await gatesOf(asked.planId)).map((g) => g.state)).toEqual(['declined']);
    await expect(plansService.declinePlan(asked.planId, fx.ctx)).rejects.toBeInstanceOf(
      PlanNotInExpectedStatusError,
    );

    const unasked = await draftPlan(['Half written']);
    await plansService.declinePlan(unasked.planId, fx.ctx);
    expect(await gatesOf(unasked.planId)).toEqual([]);
    expect((await planRow(unasked.planId)).status).toBe('declined');
  });
});

describe('the render read carries the decision surfaces’ facts (Story MOTIR-6012 · MOTIR-6037)', () => {
  it('names who the question waits on, for the see-but-not-decide line', async () => {
    const { planId } = await askedPlan(['Only']);
    const owner = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ownerId } });
    const review = await planReviewService.getPlanReview(planId, fx.ctx);
    expect(review.gate?.routedToName).toBe(owner.name?.trim() || owner.email);
  });

  it('says whether the plan has a conversation to return to, and what it targeted', async () => {
    const { planId } = await askedPlan(['Only']);
    // No session at all — the plan opens on its own page.
    await adminDb.plan.update({ where: { id: planId }, data: { sessionId: null } });
    expect((await planReviewService.getPlanReview(planId, fx.ctx)).conversation).toBeNull();

    const thread = await adminDb.planChangeSession.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        createdById: fx.ownerId,
        targetKeys: ['ACME-12', 'ACME-31'],
        scopeKey: 'ACME-12,ACME-31',
      },
    });
    await adminDb.plan.update({ where: { id: planId }, data: { sessionId: thread.id } });
    // A session with no turns is still no conversation to return to…
    expect((await planReviewService.getPlanReview(planId, fx.ctx)).conversation).toEqual({
      sessionId: thread.id,
      hasTurns: false,
      targetKeys: ['ACME-12', 'ACME-31'],
    });
    // …and one with a turn is.
    await adminDb.planChangeSession.update({ where: { id: thread.id }, data: { turnCount: 2 } });
    expect((await planReviewService.getPlanReview(planId, fx.ctx)).conversation?.hasTurns).toBe(
      true,
    );
  });
});

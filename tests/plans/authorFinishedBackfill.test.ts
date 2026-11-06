import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { planSubjectVersion } from '@/lib/approvalGates/planApprovalDigest';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { planStepRepository } from '@/lib/repositories/planStepRepository';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { planAuthorFinishedBackfillService } from '@/lib/services/planAuthorFinishedBackfillService';
import { plansService } from '@/lib/services/plansService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { main, parseArgs, run } from '../../scripts/backfill-plan-author-finished';

// THE authorFinished CARRY-OVER (Task MOTIR-10491) — `pnpm db:backfill:author-finished`,
// against a REAL Postgres. `@/lib/db` is the application role (`motir_app`, no RLS
// bypass), so every stamp the sweep writes passed the plan_item policy under the
// workspace it bound; the fixtures and the read-backs go through `adminDb`.
//
// THE FIXTURE WRITES A PROPOSAL'S FIELDS DIRECTLY. The population is cards written
// BEFORE the state shipped (MOTIR-10490), and today's doors stamp a hand-written body
// as it lands, so a legacy row can only be produced by writing it raw: each proposal is
// appended title-only through the product, then given the fields it would have held.

const BOUNDARY = '## Scope BOUNDARY\n\nStarts at the door and ends at the store.';
const CONTEXT = '## Context refs\n\n- `lib/x.ts` — the file.';
const LEAF_BODY = `Why the card exists.\n\n## Deliverables\n\n- the file\n\n${BOUNDARY}\n\n## Acceptance criteria\n\n- It stores the key.\n\n${CONTEXT}`;
const STORY_BODY = `Why the story exists.\n\n${BOUNDARY}\n\n## Verification recipe\n\n1. Open it.\n\n## Acceptance criteria\n\n- It works.\n\n${CONTEXT}`;
const CHOICE_BODY = `## Question\n\nWhich store?\n\n## What this choice gates\n\n- the build\n\n${BOUNDARY}\n\n${CONTEXT}`;
const NEW_BODY = `${LEAF_BODY}\n\n## Approach\n\nThe door's rewrite.`;

const SIZING = {
  type: 'code',
  executor: 'coding_agent',
  storyPoints: 2,
  estimateMinutes: 30,
  difficulty: 'low',
};
const finishedLeaf = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  kind: 'task',
  descriptionMd: LEAF_BODY,
  explanationMd: 'Why it matters.',
  ...SIZING,
  ...extra,
});

type PlanStatus = 'generating' | 'planned' | 'stale' | 'approved' | 'declined';
type Fields = Record<string, unknown>;

let fx: WorkItemFixture;
let other: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  other = await makeWorkItemFixture({ name: 'Beta', identifier: 'BETA' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A generating plan in `f`'s project, written by `authorSource`. */
async function newPlan(f: WorkItemFixture, authorSource: 'mcp' | 'native' = 'mcp') {
  return plansService.createPlan(
    f.projectId,
    { title: 'A plan', summary: 'Its summary', authorSource, authorHarness: 'Claude Code' },
    f.ctx,
  );
}

/** Append an `add` through the product, then give it `fields` raw — a pre-10490 row. */
async function legacyAdd(f: WorkItemFixture, planId: string, fields: Fields, parentRef?: string) {
  const { appendedItemIds } = await plansService.addProposals(
    planId,
    [{ op: 'add', proposedFields: { title: String(fields.title), kind: 'task' } }],
    f.ctx,
  );
  const id = appendedItemIds[0]!;
  await adminDb.planItem.update({
    where: { id },
    data: {
      proposedFields: fields as never,
      ...(parentRef ? { parentRef } : {}),
    },
  });
  return id;
}

const forceStatus = (planId: string, status: PlanStatus) =>
  adminDb.plan.update({ where: { id: planId }, data: { status } });

const fieldsOf = async (id: string) =>
  (await adminDb.planItem.findUniqueOrThrow({ where: { id } })).proposedFields as Fields;

const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });
const itemsOf = (planId: string) =>
  adminDb.planItem.findMany({ where: { planId }, orderBy: { id: 'asc' } });
const revisionCount = (planId: string) => adminDb.planRevision.count({ where: { planId } });

/** A plan holding one finished card, at `status`. */
async function finishedPlan(f: WorkItemFixture, status: PlanStatus, title = 'Finished') {
  const plan = await newPlan(f);
  const id = await legacyAdd(f, plan.id, finishedLeaf(title));
  if (status !== 'generating') await forceStatus(plan.id, status);
  return { planId: plan.id, id };
}

// ─── the judgement, over the three open statuses ─────────────────────────────

describe('what a real run stamps — finished adds on generating, planned and stale plans', () => {
  it('stamps each finished card, under either explanation rule, and nothing that is not finished', async () => {
    // A plan that requires an explanation (an MCP-written plan).
    const mcp = await newPlan(fx);
    const mcpDone = await legacyAdd(fx, mcp.id, finishedLeaf('MCP finished'));
    const mcpNoWhy = await legacyAdd(fx, mcp.id, finishedLeaf('No why', { explanationMd: null }));
    const titleOnly = await legacyAdd(fx, mcp.id, { title: 'Title only', kind: 'task' });
    const boundaryLeaf = await legacyAdd(
      fx,
      mcp.id,
      finishedLeaf('Boundary leaf', { descriptionMd: BOUNDARY }),
    );
    const choice = await legacyAdd(fx, mcp.id, {
      title: 'A choice',
      kind: 'task',
      type: 'choice',
      executor: 'human',
      descriptionMd: CHOICE_BODY,
      explanationMd: 'Why it is a choice.',
    });

    // A HOSTED plan on a project with explanations off: its cards never carry one.
    const hosted = await newPlan(other, 'native');
    expect(
      (await adminDb.project.findUniqueOrThrow({ where: { id: other.projectId } }))
        .aiGenerateExplanations,
    ).toBe(false);
    const hostedDone = await legacyAdd(
      other,
      hosted.id,
      finishedLeaf('Hosted finished', { explanationMd: undefined }),
    );
    const container = await legacyAdd(other, hosted.id, {
      title: 'Boundary container',
      kind: 'story',
      descriptionMd: BOUNDARY,
    });
    await legacyAdd(
      other,
      hosted.id,
      finishedLeaf('Its child', { explanationMd: undefined }),
      `planItem:${container}`,
    );
    const story = await legacyAdd(other, hosted.id, {
      title: 'Finished story',
      kind: 'story',
      descriptionMd: STORY_BODY,
    });
    await legacyAdd(other, hosted.id, finishedLeaf('Story child'), `planItem:${story}`);
    await forceStatus(hosted.id, 'planned');

    const stale = await finishedPlan(fx, 'stale', 'Stale finished');

    const report = await planAuthorFinishedBackfillService.backfill({ dryRun: false });

    for (const id of [mcpDone, hostedDone, story, stale.id]) {
      expect((await fieldsOf(id))['authorFinished']).toBe(true);
    }
    for (const id of [mcpNoWhy, titleOnly, boundaryLeaf, choice, container]) {
      expect(await fieldsOf(id)).not.toHaveProperty('authorFinished');
    }
    expect(report.failed).toEqual([]);
    expect(report.total).toBe(3);
    const byPlan = Object.fromEntries(report.plans.map((p) => [p.planId, p]));
    expect(byPlan[mcp.id]).toMatchObject({ status: 'generating', stamped: [mcpDone] });
    expect(byPlan[hosted.id]!.status).toBe('planned');
    expect(byPlan[stale.planId]).toMatchObject({ status: 'stale', stamped: [stale.id] });
    // The two children are finished leaves too, so the hosted plan stamps four.
    expect(byPlan[hosted.id]!.stamped).toHaveLength(4);
    expect(byPlan[hosted.id]!.stamped).toEqual(expect.arrayContaining([hostedDone, story]));
    expect(report).toMatchObject({ stamp: 6, notComplete: 5, alreadyHasState: 0, inFlight: 0 });
  });

  it('touches no approved or declined plan, no modify or remove, and no add already stating', async () => {
    const approved = await finishedPlan(fx, 'approved');
    const declined = await finishedPlan(fx, 'declined');
    const plan = await newPlan(fx);
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Committed' });
    const removed = await createTestWorkItem(fx, { kind: 'task', title: 'Removed' });
    const { appendedItemIds } = await plansService.addProposals(
      plan.id,
      [
        { op: 'modify', workItemId: target.id, patch: { descriptionMd: LEAF_BODY } },
        { op: 'remove', workItemId: removed.id, reason: 'superseded' },
      ],
      fx.ctx,
    );
    const statedTrue = await legacyAdd(fx, plan.id, finishedLeaf('True', { authorFinished: true }));
    const statedNull = await legacyAdd(fx, plan.id, finishedLeaf('Null', { authorFinished: null }));
    const before = await adminDb.planItem.findMany({ orderBy: { id: 'asc' } });

    const report = await planAuthorFinishedBackfillService.backfill({ dryRun: false });

    expect(await adminDb.planItem.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect(report).toMatchObject({ total: 1, stamp: 0, notAdd: 2, alreadyHasState: 2 });
    expect(report.plans).toEqual([]);
    expect(appendedItemIds).toHaveLength(2);
    for (const id of [statedTrue, statedNull])
      expect(await fieldsOf(id)).toHaveProperty('authorFinished');
    expect((await planRow(approved.planId)).status).toBe('approved');
    expect((await planRow(declined.planId)).status).toBe('declined');
  });

  it('a stale plan stays stale, keeps its stamps back at planned, and a further run stamps nothing', async () => {
    const stale = await finishedPlan(fx, 'stale');

    await planAuthorFinishedBackfillService.backfill({ dryRun: false });
    expect((await planRow(stale.planId)).status).toBe('stale');
    expect((await fieldsOf(stale.id))['authorFinished']).toBe(true);

    // Its drift reverses: the plan returns to `planned` on its own.
    await forceStatus(stale.planId, 'planned');
    expect((await fieldsOf(stale.id))['authorFinished']).toBe(true);
    const again = await planAuthorFinishedBackfillService.backfill({ dryRun: false });
    expect(again).toMatchObject({ stamp: 0, alreadyHasState: 1, plans: [] });
  });
});

// ─── it stamps one key and nothing else ──────────────────────────────────────

describe('a stamp changes the card by one key and leaves the plan alone', () => {
  it('the fields gain authorFinished only; status, summary, proposals, activity and the trail are unchanged', async () => {
    const plan = await newPlan(fx);
    const id = await legacyAdd(fx, plan.id, finishedLeaf('Finished'));
    const sibling = await legacyAdd(fx, plan.id, { title: 'Unfinished', kind: 'task' });
    await forceStatus(plan.id, 'planned');
    await adminDb.plan.update({
      where: { id: plan.id },
      data: { lastActivityAt: new Date('2026-10-01T00:00:00.000Z') },
    });
    const planBefore = await planRow(plan.id);
    const itemsBefore = await itemsOf(plan.id);
    const revisionsBefore = await revisionCount(plan.id);

    await planAuthorFinishedBackfillService.backfill({ dryRun: false });

    expect(await planRow(plan.id)).toEqual(planBefore);
    expect(await revisionCount(plan.id)).toBe(revisionsBefore);
    const itemsAfter = await itemsOf(plan.id);
    expect(itemsAfter.map((i) => i.id)).toEqual(itemsBefore.map((i) => i.id));
    for (const [index, after] of itemsAfter.entries()) {
      const was = itemsBefore[index]!;
      const expected =
        after.id === id
          ? { ...(was.proposedFields as Fields), authorFinished: true }
          : was.proposedFields;
      expect(after).toEqual({ ...was, proposedFields: expected });
    }
    expect(itemsAfter.find((i) => i.id === sibling)).toEqual(
      itemsBefore.find((i) => i.id === sibling),
    );
  });

  it('a planned plan with an awaiting gate keeps its subject version, its read stamp and its gate', async () => {
    const plan = await newPlan(fx);
    const id = await legacyAdd(fx, plan.id, finishedLeaf('Finished'));
    await plansService.markPlanned(plan.id, fx.ctx);
    const version = () => withWorkspaceContext(fx.ctx, (tx) => planSubjectVersion(plan.id, tx));
    const versionBefore = await version();
    const readBefore = await approvalGatesService.getForPlan({ planId: plan.id }, fx.ctx);
    expect(readBefore.gate?.state).toBe('awaiting');

    const report = await planAuthorFinishedBackfillService.backfill({ dryRun: false });

    expect(report.plans.map((p) => p.planId)).toEqual([plan.id]);
    expect((await fieldsOf(id))['authorFinished']).toBe(true);
    expect(await version()).toBe(versionBefore);
    const readAfter = await approvalGatesService.getForPlan({ planId: plan.id }, fx.ctx);
    expect(readAfter.stamp).toBe(readBefore.stamp);
    expect(readAfter.gate).toMatchObject({ id: readBefore.gate!.id, state: 'awaiting' });
  });
});

// ─── live author steps ───────────────────────────────────────────────────────

describe('a card a live author step targets is in flight', () => {
  it('is reported in_flight and not stamped; a run after the step ends stamps it', async () => {
    const plan = await newPlan(fx);
    const id = await legacyAdd(fx, plan.id, finishedLeaf('Being written'));
    const untargeted = await legacyAdd(fx, plan.id, finishedLeaf('Written'));
    const step = await adminDb.planStep.create({
      data: {
        planId: plan.id,
        sessionKey: 'live',
        kind: 'author',
        targetRef: `planItem:${id}`,
        startedAt: new Date(),
      },
    });
    // A lay step names no card and holds nothing back.
    await adminDb.planStep.create({
      data: { planId: plan.id, sessionKey: 'lay', kind: 'lay', startedAt: new Date() },
    });

    const during = await planAuthorFinishedBackfillService.backfill({ dryRun: false });
    expect(during).toMatchObject({ inFlight: 1, stamp: 1 });
    expect(await fieldsOf(id)).not.toHaveProperty('authorFinished');
    expect((await fieldsOf(untargeted))['authorFinished']).toBe(true);

    await adminDb.planStep.delete({ where: { id: step.id } });
    const after = await planAuthorFinishedBackfillService.backfill({ dryRun: false });
    expect(after).toMatchObject({ inFlight: 0, stamp: 1 });
    expect((await fieldsOf(id))['authorFinished']).toBe(true);
  });

  it('an old step row left on a planned or stale plan holds nothing back', async () => {
    const planned = await finishedPlan(fx, 'planned');
    const stale = await finishedPlan(fx, 'stale');
    for (const { planId, id } of [planned, stale]) {
      await adminDb.planStep.create({
        data: {
          planId,
          sessionKey: 'dead',
          kind: 'author',
          targetRef: `planItem:${id}`,
          startedAt: new Date(),
        },
      });
    }

    const report = await planAuthorFinishedBackfillService.backfill({ dryRun: false });

    expect(report).toMatchObject({ inFlight: 0, stamp: 2 });
    expect((await fieldsOf(planned.id))['authorFinished']).toBe(true);
    expect((await fieldsOf(stale.id))['authorFinished']).toBe(true);
  });
});

// ─── the dry run, idempotence, failures ──────────────────────────────────────

describe('`--dry-run` predicts the real run exactly, and a second run stamps nothing', () => {
  it('writes nothing and reports the same stamps per plan and per workspace', async () => {
    await finishedPlan(fx, 'generating', 'A');
    await finishedPlan(fx, 'planned', 'B');
    await finishedPlan(other, 'stale', 'C');
    const before = await adminDb.planItem.findMany({ orderBy: { id: 'asc' } });

    const dry = await planAuthorFinishedBackfillService.backfill({ dryRun: true });
    expect(await adminDb.planItem.findMany({ orderBy: { id: 'asc' } })).toEqual(before);

    const real = await planAuthorFinishedBackfillService.backfill({ dryRun: false });
    expect(dry.dryRun).toBe(true);
    expect(dry.plans).toEqual(real.plans);
    expect(dry.byWorkspace).toEqual(real.byWorkspace);
    expect(dry.stamp).toBe(3);

    const again = await planAuthorFinishedBackfillService.backfill({ dryRun: false });
    expect(again).toMatchObject({ stamp: 0, alreadyHasState: 3, plans: [] });
    expect((await planAuthorFinishedBackfillService.backfill({ dryRun: true })).stamp).toBe(0);
  });

  it('a failing plan is reported and rolled back ALONE; the others are still stamped', async () => {
    const failing = await newPlan(fx);
    const first = await legacyAdd(fx, failing.id, finishedLeaf('First'));
    const second = await legacyAdd(fx, failing.id, finishedLeaf('Second'));
    const kept = await finishedPlan(other, 'planned');
    const realUpdate = planItemRepository.update.bind(planItemRepository);
    vi.spyOn(planItemRepository, 'update').mockImplementation(async (id, data, tx) => {
      const row = await realUpdate(id, data, tx);
      // Fail AFTER the second stamp, so the read-back proves the first was rolled back.
      if (id === second) throw new Error('boom');
      return row;
    });

    const report = await planAuthorFinishedBackfillService.backfill({ dryRun: false });

    expect(report.failed).toEqual([
      { planId: failing.id, workspaceId: fx.workspaceId, error: 'boom' },
    ]);
    expect(await fieldsOf(first)).not.toHaveProperty('authorFinished');
    expect(await fieldsOf(second)).not.toHaveProperty('authorFinished');
    expect((await fieldsOf(kept.id))['authorFinished']).toBe(true);
    expect(report.plans.map((p) => p.planId)).toEqual([kept.planId]);
    const byWs = Object.fromEntries(report.byWorkspace.map((w) => [w.workspaceId, w]));
    expect(byWs[fx.workspaceId]).toMatchObject({ failed: 1, stamp: 0 });
  });

  it('a plan that leaves the open statuses between the scan and its transaction is counted, not stamped', async () => {
    const decided = await finishedPlan(fx, 'planned', 'Decided');
    const open = await finishedPlan(fx, 'planned', 'Open');
    const realLock = planRepository.lockById.bind(planRepository);
    vi.spyOn(planRepository, 'lockById').mockImplementation(async (id, tx) => {
      // Somebody approves the plan after the scan read it as open — committed on its
      // own connection before this plan's transaction takes the lock.
      if (id === decided.planId) await forceStatus(decided.planId, 'approved');
      return realLock(id, tx);
    });

    const report = await planAuthorFinishedBackfillService.backfill({ dryRun: false });

    expect(report).toMatchObject({ total: 2, noLongerOpen: 1, failed: [] });
    expect(report.plans.map((p) => p.planId)).toEqual([open.planId]);
    expect(await fieldsOf(decided.id)).not.toHaveProperty('authorFinished');
    expect(report.byWorkspace[0]).toMatchObject({ noLongerOpen: 1, stamp: 1 });
  });

  it('an INTERRUPTED run keeps what it stamped, and a re-run finishes the rest', async () => {
    await finishedPlan(fx, 'planned', 'A');
    await finishedPlan(fx, 'planned', 'B');
    await finishedPlan(fx, 'planned', 'C');
    const controller = new AbortController();
    const progress: number[] = [];
    const report = await planAuthorFinishedBackfillService.backfill({
      dryRun: false,
      progressEvery: 1,
      signal: controller.signal,
      onProgress: (p) => {
        progress.push(p.examined);
        if (p.examined === 2) controller.abort();
      },
    });
    expect(report).toMatchObject({ interrupted: true, examined: 2, stamp: 2 });
    expect(progress).toEqual([1, 2]);

    const resumed = await planAuthorFinishedBackfillService.backfill({ dryRun: false });
    expect(resumed).toMatchObject({ stamp: 1, alreadyHasState: 2 });
  });
});

// ─── the plan lock, against a real door ──────────────────────────────────────

describe('a sweep and a door writing the same card concurrently lose no write', () => {
  async function racePlan() {
    const plan = await newPlan(fx);
    const id = await legacyAdd(fx, plan.id, finishedLeaf('Raced'));
    return { planId: plan.id, id };
  }
  const sweep = () => planAuthorFinishedBackfillService.backfill({ dryRun: false });

  it('the door lands inside the sweep’s read-then-write window and still keeps its body', async () => {
    // Deterministic: the door is started once the sweep has read the card and
    // before it writes, and has to wait for the sweep's plan lock to clear.
    for (const authorFinished of [undefined, null] as const) {
      const { planId, id } = await racePlan();
      const door = { current: null as Promise<unknown> | null };
      const realList = planStepRepository.listByPlan.bind(planStepRepository);
      const spy = vi.spyOn(planStepRepository, 'listByPlan');
      spy.mockImplementationOnce(async (pid, tx) => {
        door.current = plansService.deepenProposal(
          planId,
          id,
          {
            descriptionMd: NEW_BODY,
            ...(authorFinished === null ? { authorFinished: null } : {}),
          },
          fx.ctx,
        );
        await new Promise((resolve) => setTimeout(resolve, 400));
        return realList(pid, tx);
      });

      await sweep();
      await door.current;
      spy.mockRestore();

      const fields = await fieldsOf(id);
      expect(fields['descriptionMd']).toBe(NEW_BODY);
      expect(fields['authorFinished']).toBe(authorFinished === null ? null : true);
    }
  });

  it('repeated free races, each side on its own connection, keep the door’s body every time', async () => {
    for (let round = 0; round < 6; round += 1) {
      const namesNull = round % 2 === 1;
      const { id, planId } = await racePlan();
      await Promise.all([
        sweep(),
        plansService.deepenProposal(
          planId,
          id,
          { descriptionMd: NEW_BODY, ...(namesNull ? { authorFinished: null } : {}) },
          fx.ctx,
        ),
      ]);
      const fields = await fieldsOf(id);
      expect(fields['descriptionMd']).toBe(NEW_BODY);
      // Whichever side committed first: a door naming null leaves it null.
      expect(fields['authorFinished']).toBe(namesNull ? null : true);
    }
  });
});

// ─── cross-tenant, under the application role ────────────────────────────────

describe('the sweep reaches every workspace, and --workspace narrows it', () => {
  it('stamps for real in both workspaces with no scope, and reports per workspace', async () => {
    const mine = await finishedPlan(fx, 'planned');
    const theirs = await finishedPlan(other, 'planned');

    const report = await planAuthorFinishedBackfillService.backfill({ dryRun: false });

    expect((await fieldsOf(mine.id))['authorFinished']).toBe(true);
    expect((await fieldsOf(theirs.id))['authorFinished']).toBe(true);
    const byWs = Object.fromEntries(report.byWorkspace.map((w) => [w.workspaceId, w]));
    expect(byWs[fx.workspaceId]).toMatchObject({ examined: 1, stamp: 1 });
    expect(byWs[other.workspaceId]).toMatchObject({ examined: 1, stamp: 1 });
  });

  it('--workspace=<id> examines and stamps only that tenant', async () => {
    const mine = await finishedPlan(fx, 'planned');
    const theirs = await finishedPlan(other, 'planned');

    const report = await planAuthorFinishedBackfillService.backfill({
      dryRun: false,
      workspaceId: other.workspaceId,
    });

    expect(report).toMatchObject({ total: 1, stamp: 1 });
    expect((await fieldsOf(theirs.id))['authorFinished']).toBe(true);
    expect(await fieldsOf(mine.id)).not.toHaveProperty('authorFinished');
  });
});

// ─── the script ──────────────────────────────────────────────────────────────

describe('the script', () => {
  const capture = () => {
    const lines: string[] = [];
    const errors: string[] = [];
    return {
      lines,
      errors,
      out: { log: (l: string) => lines.push(l), error: (l: string) => errors.push(l) },
    };
  };

  it('parses --dry-run and --workspace=<id>, and refuses anything else', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, workspaceId: undefined });
    expect(parseArgs(['--dry-run', '--workspace=ws1'])).toEqual({
      dryRun: true,
      workspaceId: 'ws1',
    });
    expect(() => parseArgs(['--workspace='])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--apply'])).toThrow(/unknown argument/);
  });

  it('--dry-run reports per-workspace counts and changes nothing', async () => {
    const { id } = await finishedPlan(fx, 'planned');
    const c = capture();

    expect(await run(['--dry-run'], { out: c.out })).toBe(0);

    expect(await fieldsOf(id)).not.toHaveProperty('authorFinished');
    const text = c.lines.join('\n');
    expect(text).toContain('DRY RUN');
    expect(text).toContain(`workspace ${fx.workspaceId}: 1 would stamp, 0 already stated`);
    expect(text).toContain('Re-run without --dry-run to apply.');
    expect(text).not.toContain('APPLIED');
  });

  it('a real run prints the BEFORE dry read, applies, and prints the AFTER dry read at zero', async () => {
    const { planId } = await finishedPlan(fx, 'planned');
    await finishedPlan(other, 'planned');
    const c = capture();

    expect(await run([`--workspace=${fx.workspaceId}`], { out: c.out })).toBe(0);

    const text = c.lines.join('\n');
    expect(text).toContain(`scope: workspace ${fx.workspaceId}.`);
    expect(text).toMatch(
      /BEFORE[\s\S]*1 would stamp[\s\S]*APPLIED[\s\S]*1 stamped[\s\S]*AFTER[\s\S]*0 would stamp/,
    );
    expect(text).toContain(`stamped 1 card(s) on planned plan ${planId}`);
    expect(text).toContain('progress 1/1');
  });

  it('says so when nothing is in scope', async () => {
    const c = capture();
    expect(await run(['--dry-run'], { out: c.out })).toBe(0);
    expect(c.lines.join('\n')).toContain('no open plans in scope.');
  });

  it('exits non-zero, naming the plan, when one fails', async () => {
    const { planId } = await finishedPlan(fx, 'planned');
    vi.spyOn(planItemRepository, 'update').mockRejectedValue(new Error('boom'));
    const c = capture();
    expect(await run([], { out: c.out })).toBe(1);
    expect(c.errors.join('\n')).toContain(`plan ${planId} FAILED — boom`);
  });

  it('exits non-zero and says INTERRUPTED when the signal fires', async () => {
    const { id } = await finishedPlan(fx, 'planned');
    const controller = new AbortController();
    controller.abort();
    const c = capture();
    expect(await run([], { out: c.out, signal: controller.signal })).toBe(1);
    expect(c.errors.join('\n')).toContain('INTERRUPTED after 0 of 1 plan(s)');
    expect(await fieldsOf(id)).not.toHaveProperty('authorFinished');
  });
  it('`main` turns SIGINT into a stop between plans, prints it once, and lets the signal go', async () => {
    const { id } = await finishedPlan(fx, 'planned');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = process.listenerCount('SIGINT');
    const running = main([]);
    // Both signals arrive, as a GitHub Actions cancel sends them; the second is a no-op.
    process.emit('SIGINT', 'SIGINT');
    process.emit('SIGTERM', 'SIGTERM');
    expect(await running).toBe(1);
    const said = err.mock.calls.map((c) => String(c[0]));
    expect(said.filter((l) => l.includes('received — stopping'))).toEqual([
      '[backfill-author-finished] SIGINT received — stopping after the plan in flight.',
    ]);
    expect(said.join('\n')).toContain('INTERRUPTED');
    expect(process.listenerCount('SIGINT')).toBe(before);
    expect(await fieldsOf(id)).not.toHaveProperty('authorFinished');
  });
});

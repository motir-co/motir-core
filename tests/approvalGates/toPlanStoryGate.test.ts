import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { backlogService } from '@/lib/services/backlogService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { decisionPageService } from '@/lib/services/decisionPageService';
import { pagesService } from '@/lib/services/pagesService';
import { parentStatusRollupService } from '@/lib/services/parentStatusRollupService';
import { plansService } from '@/lib/services/plansService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE STORY INTEGRATION GATE (Subtask MOTIR-12178, story MOTIR-10139).
//
// The two motir-core halves of the story — the `to_plan` status (MOTIR-12174) and
// the decision-correction mark (MOTIR-12175) — each have their own tests. This
// suite runs them TOGETHER against the real database, through the doors the
// product uses: a real decision card, a real republish that supersedes its first
// gate `republished`, a real approve or confirm, the real mark, the real workflow
// transition into `to_plan`, and then the real doors a To-plan card meets after:
// both claim doors, the plan-target park and the plan-approve rest, a person's
// hand moves, readiness and the parent rollup.
//
// Every status is reached through `workItemsService.updateStatus` — the workflow's
// own transition funnel — never written as a row, so an assertion about a status
// is an assertion about a transition the workflow allowed. Nothing is mocked: the
// services take their context as an argument, so there is no session read to fake.

const DB_TEST_TIMEOUT_MS = 60_000;

const MIGRATION = join(
  process.cwd(),
  'prisma/migrations/20261124010000_add_to_plan_default_status/migration.sql',
);

/** The status ladder, as the moves the default workflow allows from To Do. */
const PATH_FROM_TODO: Record<string, readonly string[]> = {
  todo: [],
  blocked: ['blocked'],
  in_progress: ['in_progress'],
  implemented: ['in_progress', 'implemented'],
  in_review: ['in_progress', 'in_review'],
  approved: ['in_progress', 'in_review', 'approved'],
  planning: ['planning'],
  to_plan: ['to_plan'],
  done: ['in_progress', 'done'],
  cancelled: ['cancelled'],
};

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

// ── helpers ──────────────────────────────────────────────────────────────────

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

async function card(
  title: string,
  extra: {
    kind?: 'task' | 'story';
    parentId?: string;
    type?: 'decision';
    executor?: 'coding_agent' | 'human';
    descriptionMd?: string;
  } = {},
) {
  seq += 1;
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: extra.kind ?? 'task',
      title: `${title} ${seq}`,
      descriptionMd: extra.descriptionMd ?? `Planned against option A (${title}).`,
      ...(extra.parentId ? { parentId: extra.parentId } : {}),
      ...(extra.type ? { type: extra.type } : {}),
      ...(extra.executor ? { executor: extra.executor } : {}),
    },
    fx.ctx,
  );
}

/** Walk a card from To Do to `status` through the workflow's own transitions. */
async function moveTo(id: string, status: string) {
  for (const hop of PATH_FROM_TODO[status]!) await workItemsService.updateStatus(id, hop, fx.ctx);
  expect(await statusOf(id)).toBe(status);
}

const blockedBy = (fromId: string, toId: string) =>
  workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, fx.ctx);

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

const commentsOn = (workItemId: string) =>
  adminDb.comment.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });

/** The status-change history rows that moved `id` INTO `to`. */
async function movesInto(id: string, to: string) {
  const rows = await adminDb.workItemRevision.findMany({ where: { workItemId: id } });
  // A MOVE is an `updated` row; the `created` row records only where the item started.
  return rows.filter(
    (r) => r.changeKind === 'updated' && (r.diff as { status?: { to?: string } }).status?.to === to,
  );
}

const identifierOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).identifier;

// ── the two decision kinds, corrected ────────────────────────────────────────

/** An agent's PAGE decision, published once. Approving its gate now is a FIRST-gate approve. */
async function publishedPageDecision() {
  const decision = await card('Decide', { type: 'decision', executor: 'coding_agent' });
  const page = await pagesService.createPageFromMarkdown(fx.ctx, {
    projectId: fx.projectId,
    title: 'Storage model',
    markdown: '# Storage model\n\nWe pick option A.',
  });
  await decisionPageService.publish({ workItemId: decision.id, pageId: page.id }, fx.ctx);
  return { decision, page };
}

/** Edit the page and publish it again: the awaiting gate is superseded `republished`. */
async function republishPage(decisionId: string, pageId: string) {
  const current = await pagesService.getPageMarkdown(fx.ctx, { projectId: fx.projectId, pageId });
  await pagesService.savePageMarkdown(fx.ctx, {
    projectId: fx.projectId,
    pageId,
    markdown: '# Storage model\n\nWe pick option B.',
    expectedRevision: current.revision,
  });
  await decisionPageService.publish({ workItemId: decisionId, pageId }, fx.ctx);
}

async function awaitingGate(
  workItemId: string,
  kind: 'decision_approval' | 'decision_confirmation',
) {
  return adminDb.approvalGate.findFirstOrThrow({ where: { workItemId, kind, state: 'awaiting' } });
}

const approveGate = (gateId: string) =>
  approvalGatesService.decide(
    { stamp: DECIDED_WITHOUT_A_READER, gateId, decision: 'approve', source: 'ui', noteMd: null },
    fx.ctx,
  );

interface DecisionKind {
  label: string;
  /** Create the decision card and raise its FIRST gate. */
  create(): Promise<{ id: string; correct(): Promise<void> }>;
  /** Approve / confirm the gate that is awaiting now. */
  decide(decisionId: string): Promise<void>;
  /** The version the mark's comment names. */
  version: RegExp;
  gateKind: 'decision_approval' | 'decision_confirmation';
}

const AGENT_PAGE: DecisionKind = {
  label: "an agent's decision card, republished then approved",
  gateKind: 'decision_approval',
  version: /version 2 of Storage model/,
  async create() {
    const { decision, page } = await publishedPageDecision();
    return { id: decision.id, correct: () => republishPage(decision.id, page.id) };
  },
  async decide(decisionId) {
    const result = await approveGate((await awaitingGate(decisionId, 'decision_approval')).id);
    expect(result.gate.state).toBe('approved');
  },
};

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

const PERSON_CONFIRMATION: DecisionKind = {
  label: "a person's decision card, republished then confirmed",
  gateKind: 'decision_confirmation',
  version: /the confirmed text of \d{4}-\d{2}-\d{2}/,
  async create() {
    const decision = await card('Decide', {
      type: 'decision',
      executor: 'human',
      descriptionMd: RECORD,
    });
    return {
      id: decision.id,
      correct: async () => {
        await workItemsService.updateWorkItem(
          decision.id,
          { descriptionMd: RECORD.replace('the bucket.', 'the bucket, with a link.') },
          fx.ctx,
        );
      },
    };
  },
  async decide(decisionId) {
    const read = await approvalGatesService.getForWorkItem(
      { workItemId: decisionId, kind: 'decision_confirmation' },
      fx.ctx,
    );
    const result = await approvalGatesService.decide(
      { gateId: read.gate!.id, decision: 'approve', source: 'ui', stamp: read.stamp! },
      fx.ctx,
    );
    expect(result.gate.state).toBe('approved');
  },
};

/**
 * Build a decision with dependents (`setup`, written BEFORE the correction),
 * correct it, assert the first gate was superseded `republished`, then decide.
 */
async function correctedThenDecided<T>(
  kind: DecisionKind,
  setup: (decisionId: string) => Promise<T>,
): Promise<{ decisionId: string; built: T }> {
  const decision = await kind.create();
  const built = await setup(decision.id);
  await tick();
  await decision.correct();
  const gates = await adminDb.approvalGate.findMany({
    where: { workItemId: decision.id, kind: kind.gateKind },
    orderBy: { createdAt: 'asc' },
  });
  expect(gates.map((g) => [g.state, g.supersededCause])).toEqual([
    ['superseded', 'republished'],
    ['awaiting', null],
  ]);
  await kind.decide(decision.id);
  return { decisionId: decision.id, built };
}

/** THE CHAIN: S1 (To Do) blocked_by D with a child C1 (To Do); S3 (Blocked) blocked_by S1. */
async function chain(decisionId: string) {
  const s1 = await card('S1', { kind: 'story' });
  const c1 = await card('C1', { parentId: s1.id });
  const s3 = await card('S3');
  await blockedBy(s1.id, decisionId);
  await blockedBy(s3.id, s1.id);
  if ((await statusOf(s3.id)) !== 'blocked') await moveTo(s3.id, 'blocked');
  expect([await statusOf(s1.id), await statusOf(c1.id), await statusOf(s3.id)]).toEqual([
    'todo',
    'todo',
    'blocked',
  ]);
  return { s1, c1, s3 };
}

/** The first criterion's outcome, as a shape two projects can be compared on. */
async function assertChainMarked(kind: DecisionKind, decisionId: string, ids: string[]) {
  const identifier = await identifierOf(decisionId);
  for (const id of ids) {
    expect(await statusOf(id)).toBe('to_plan');
    // Reached through the workflow transition: a status-change history row exists.
    expect(await movesInto(id, 'to_plan')).toHaveLength(1);
    const comments = await commentsOn(id);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.bodyMd).toContain('**Planned against an earlier version of ');
    expect(comments[0]!.bodyMd).toContain(`[${identifier}](motir:${decisionId})`);
    expect(comments[0]!.bodyMd).toMatch(kind.version);
    expect(comments[0]!.bodyMd).toContain(
      'Re-plan it so it matches the decision before it is built.',
    );
  }
}

async function runBackfill(): Promise<void> {
  await adminDb.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));
}

/** Bring the fixture's project to the shape a project created before the story had. */
async function predateTheStory(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    `DELETE FROM board_column WHERE project_id = $1 AND name = 'To plan'`,
    fx.projectId,
  );
  await adminDb.$executeRawUnsafe(
    `DELETE FROM workflow_status WHERE project_id = $1 AND key = 'to_plan'`,
    fx.projectId,
  );
  expect(
    await adminDb.workflowStatus.count({ where: { projectId: fx.projectId, key: 'to_plan' } }),
  ).toBe(0);
}

// ── 1. the mark, end to end, on both gate kinds ──────────────────────────────

describe.each([AGENT_PAGE, PERSON_CONFIRMATION])('$label', (kind) => {
  it(
    'moves the direct dependent, the transitive Blocked one and the reached story’s child to To plan, with one comment each',
    async () => {
      const { decisionId, built } = await correctedThenDecided(kind, chain);
      const { s1, c1, s3 } = built;
      await assertChainMarked(kind, decisionId, [s1.id, c1.id, s3.id]);
    },
    DB_TEST_TIMEOUT_MS,
  );
});

describe('a project created BEFORE the story, brought to To plan by the backfill', () => {
  it(
    'gives the same outcome for the chain as a project created after it',
    async () => {
      await predateTheStory();
      await runBackfill();

      const { decisionId, built } = await correctedThenDecided(AGENT_PAGE, chain);
      const { s1, c1, s3 } = built;
      await assertChainMarked(AGENT_PAGE, decisionId, [s1.id, c1.id, s3.id]);
    },
    DB_TEST_TIMEOUT_MS,
  );
});

// ── 2. what the mark leaves alone ────────────────────────────────────────────

describe('the dependents the mark does not move', () => {
  it.each(['in_progress', 'implemented', 'in_review', 'approved'])(
    'S2 at %s keeps its status and gets the comment only',
    async (status) => {
      const { built } = await correctedThenDecided(AGENT_PAGE, async (decisionId) => {
        const { s1 } = await chain(decisionId);
        const s2 = await card('S2');
        await blockedBy(s2.id, s1.id);
        await moveTo(s2.id, status);
        return { s2 };
      });

      expect(await statusOf(built.s2.id)).toBe(status);
      expect(await movesInto(built.s2.id, 'to_plan')).toEqual([]);
      const comments = await commentsOn(built.s2.id);
      expect(comments).toHaveLength(1);
      expect(comments[0]!.bodyMd).toContain(
        'This work item has already started, so its status was kept',
      );
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'Planning and To plan are unchanged with no second comment; Done and Cancelled get neither',
    async () => {
      const ids: Record<string, string> = {};
      for (const status of ['planning', 'done', 'cancelled']) {
        const item = await card(status);
        await moveTo(item.id, status);
        ids[status] = item.id;
      }
      // An item already at To plan from an EARLIER mark: the first decision's run.
      ids.to_plan = (
        await correctedThenDecided(AGENT_PAGE, async (earlier) => {
          const item = await card('marked earlier');
          await blockedBy(item.id, earlier);
          return item;
        })
      ).built.id;
      expect(await statusOf(ids.to_plan)).toBe('to_plan');
      expect(await commentsOn(ids.to_plan)).toHaveLength(1);
      // …which ALSO waits on the second decision, decided below.

      const second = await AGENT_PAGE.create();
      await blockedBy(ids.to_plan, second.id);
      for (const key of ['planning', 'done', 'cancelled']) await blockedBy(ids[key]!, second.id);
      await tick();
      await second.correct();
      const before = Object.fromEntries(
        await Promise.all(
          Object.entries(ids).map(async ([k, id]) => [k, (await commentsOn(id)).length] as const),
        ),
      );
      await AGENT_PAGE.decide(second.id);

      for (const [key, id] of Object.entries(ids)) {
        expect(await statusOf(id)).toBe(key);
        expect((await commentsOn(id)).length).toBe(before[key]);
      }
      // Planning was never commented; Done and Cancelled never anything.
      for (const key of ['planning', 'done', 'cancelled']) {
        expect(await commentsOn(ids[key]!)).toEqual([]);
      }
      expect(await commentsOn(ids.to_plan)).toHaveLength(1);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a decision approved on the FIRST gate it raised marks nothing',
    async () => {
      const { decision } = await publishedPageDecision();
      const a = await card('A');
      const b = await card('B');
      await blockedBy(a.id, decision.id);
      await blockedBy(b.id, a.id);

      await AGENT_PAGE.decide(decision.id);

      for (const id of [a.id, b.id]) {
        expect(await statusOf(id)).toBe('todo');
        expect(await commentsOn(id)).toEqual([]);
      }
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a dependent whose description was rewritten after the corrected gate was raised is left alone',
    async () => {
      const decision = await AGENT_PAGE.create();
      const fresh = await card('Fresh');
      const stale = await card('Stale');
      await blockedBy(fresh.id, decision.id);
      await blockedBy(stale.id, decision.id);
      await tick();
      await decision.correct();
      await tick();
      await workItemsService.updateWorkItem(
        fresh.id,
        { descriptionMd: 'Re-planned on B.' },
        fx.ctx,
      );

      await AGENT_PAGE.decide(decision.id);

      expect(await statusOf(fresh.id)).toBe('todo');
      expect(await commentsOn(fresh.id)).toEqual([]);
      // The control in the same run: the one written before the correction moves.
      expect(await statusOf(stale.id)).toBe('to_plan');
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a corrected decision with no dependents is approved and nothing else in the project changes',
    async () => {
      const bystander = await card('Bystander');
      const snapshot = async () =>
        (
          await adminDb.workItem.findMany({
            where: { projectId: fx.projectId, NOT: { type: 'decision' } },
            orderBy: { id: 'asc' },
          })
        ).map((w) => [w.id, w.status, w.updatedAt.toISOString()]);
      const commentCount = () =>
        adminDb.comment.count({ where: { workItem: { projectId: fx.projectId } } });

      const decision = await AGENT_PAGE.create();
      await tick();
      await decision.correct();
      const before = { items: await snapshot(), comments: await commentCount() };

      await AGENT_PAGE.decide(decision.id);

      expect(await snapshot()).toEqual(before.items);
      expect(await commentCount()).toBe(before.comments);
      expect(await statusOf(bystander.id)).toBe('todo');
    },
    DB_TEST_TIMEOUT_MS,
  );
});

// ── 3. the doors a To-plan card meets afterwards ─────────────────────────────

describe('a To-plan card is never handed out', () => {
  it(
    'claim_next_ready claims nothing when it is the only otherwise-ready row',
    async () => {
      const item = await card('Stale, unblocked');
      await moveTo(item.id, 'to_plan');
      const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Active' }, fx.ctx);
      await backlogService.bulkAssignToSprint([item.id], sprint.id, fx.ctx);
      await sprintsService.startSprint(sprint.id, {}, fx.ctx);

      expect(await workItemsService.claimNextReady(fx.projectId, sprint.id, fx.ctx)).toBeNull();
      const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(row.status).toBe('to_plan');
      expect(row.assigneeId).toBeNull();
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'claim_work_item answers not_claimable, leaving it at to_plan and unassigned',
    async () => {
      // The card the MARK moved, not one moved by hand.
      const { built } = await correctedThenDecided(AGENT_PAGE, async (decisionId) => {
        const item = await card('Marked');
        await blockedBy(item.id, decisionId);
        return item;
      });

      const claim = await workItemsService.claimWorkItem(fx.projectId, built.identifier, fx.ctx);

      expect(claim).toMatchObject({ outcome: 'not_claimable', claimed: false });
      const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: built.id } });
      expect(row.status).toBe('to_plan');
      expect(row.assigneeId).toBeNull();
    },
    DB_TEST_TIMEOUT_MS,
  );
});

describe('a plan that names a To-plan card', () => {
  async function plannedModify(workItemId: string): Promise<string> {
    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId, patch: { descriptionMd: 'Re-planned on option B.' } }],
      fx.ctx,
    );
    return plan.id;
  }

  it(
    'parks it at planning while open, and approve rests it at To Do when its blockers are all done',
    async () => {
      const item = await card('Stale');
      const blocker = await card('Finished blocker');
      await blockedBy(item.id, blocker.id);
      await moveTo(blocker.id, 'done');
      await moveTo(item.id, 'to_plan');

      const planId = await plannedModify(item.id);
      expect(await statusOf(item.id)).toBe(PLANNING_STATUS_KEY);
      expect(await movesInto(item.id, PLANNING_STATUS_KEY)).toHaveLength(1);

      await plansService.markPlanned(planId, fx.ctx);
      await plansService.approvePlan(planId, fx.ctx);
      expect(await statusOf(item.id)).toBe('todo');
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'approve rests it at Blocked when a blocker is still open',
    async () => {
      const item = await card('Stale, gated');
      const blocker = await card('Open blocker');
      await blockedBy(item.id, blocker.id);
      await moveTo(item.id, 'to_plan');

      const planId = await plannedModify(item.id);
      expect(await statusOf(item.id)).toBe(PLANNING_STATUS_KEY);
      await plansService.markPlanned(planId, fx.ctx);
      await plansService.approvePlan(planId, fx.ctx);
      expect(await statusOf(item.id)).toBe('blocked');
    },
    DB_TEST_TIMEOUT_MS,
  );
});

describe("a person's hand moves out of To plan", () => {
  it.each(['todo', 'planning', 'cancelled'])(
    'to_plan → %s is accepted by the workflow',
    async (to) => {
      const item = await card(`out to ${to}`);
      await moveTo(item.id, 'to_plan');
      await expect(workItemsService.updateStatus(item.id, to, fx.ctx)).resolves.toMatchObject({
        status: to,
      });
      expect(await movesInto(item.id, to)).toHaveLength(1);
    },
    DB_TEST_TIMEOUT_MS,
  );
});

// ── 4. the guards ────────────────────────────────────────────────────────────

describe('a To-plan card is unfinished work', () => {
  it(
    'an item blocked_by a to_plan card is not ready',
    async () => {
      const stale = await card('Stale blocker');
      await moveTo(stale.id, 'to_plan');
      const x = await card('X');
      await blockedBy(x.id, stale.id);

      const readiness = await workItemsService.getReadiness(x.id, fx.ctx);
      expect(readiness.ready).toBe(false);
      expect([...readiness.openBlockerIds]).toEqual([stale.id]);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a story whose only child is at to_plan is not rolled up to done',
    async () => {
      const story = await card('Story', { kind: 'story' });
      const child = await card('Only child', { parentId: story.id });
      await moveTo(child.id, 'to_plan');

      await parentStatusRollupService.recomputeParent(story.id, fx.workspaceId);

      expect(await statusOf(story.id)).not.toBe('done');
      expect(await movesInto(story.id, 'done')).toEqual([]);
    },
    DB_TEST_TIMEOUT_MS,
  );
});

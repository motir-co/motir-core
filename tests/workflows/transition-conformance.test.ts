import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { IllegalTransitionError, UnknownStatusError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { DEFAULT_STATUSES, DEFAULT_TRANSITIONS } from '@/lib/workflows/defaultWorkflow';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { spyOnJobDispatch } from '../helpers/jobs';

// Graph-COMPLETE conformance guard over the default workflow (Subtask 2.6.2),
// consolidating what `transition-validation.test.ts` only SAMPLES. Everything
// is driven through the shipped path — `workItemsService.updateStatus`, which
// `workflowsService.canTransition` gates — against a `createTestProject`
// project (auto-seeds the six default statuses + sixteen transitions). Real
// Postgres; runs in CI.
//
// The legal-edge and illegal-non-edge sets are DERIVED FROM the
// `defaultWorkflow.ts` constant (NOT a hardcoded copy), so adding a status or
// transition to the constant automatically extends the sweep. Because the SEED
// also reads the same constant (`seedDefaultWorkflow` iterates
// DEFAULT_TRANSITIONS at project-create time), the behavioral sweep alone moves
// in lockstep with the seed — so it is paired with an explicit **literal pin**
// (the "graph shape is locked" describe) that fails the instant the constant's
// status set or edge set changes. That pin is what makes "locally delete one
// edge from defaultWorkflow.ts → this suite fails" true (manually verified for
// the PR), forcing any workflow-graph edit to consciously update this guard.

const STATUS_KEYS: string[] = DEFAULT_STATUSES.map((s) => s.key);
const EDGES: Array<[string, string]> = DEFAULT_TRANSITIONS.map(([from, to]) => [from, to]);
const edgeKey = (from: string, to: string): string => `${from}>${to}`;
const EDGE_SET = new Set(EDGES.map(([from, to]) => edgeKey(from, to)));

// The full 9×9 grid, partitioned by membership in the default edge set.
const ALL_PAIRS: Array<[string, string]> = STATUS_KEYS.flatMap((from) =>
  STATUS_KEYS.map((to): [string, string] => [from, to]),
);
const NON_EDGES: Array<[string, string]> = ALL_PAIRS.filter(
  ([from, to]) => from !== to && !EDGE_SET.has(edgeKey(from, to)),
);

let ctx: ServiceContext;
let workspaceId: string;
let restrictedProjectId: string;
let restrictedItemId: string;
let openItemId: string;

// One shared fixture for the whole file (the sweep repositions a single item's
// status via a direct DB write between cases — see setStatus — so we don't pay
// per-pair project/seed setup). A SEPARATE open-mode project keeps the two
// policy modes isolated regardless of test order.
beforeAll(async () => {
  // Stub the Inngest publish: updateStatus now emits `work-item/transitioned`
  // post-commit (Subtask 5.4.5), and the test env has no Inngest key.
  spyOnJobDispatch();
  await truncateAuthTables();
  const user = await usersService.createUser({
    email: 'tc@example.com',
    password: 'hunter2hunter2',
    name: 'TC User',
  });
  const ws = await workspacesService.createWorkspace({ name: 'TC WS', ownerUserId: user.id });
  ctx = { userId: user.id, workspaceId: ws.workspace.id };
  workspaceId = ws.workspace.id;

  const restricted = await createTestProject({ workspaceId, actorUserId: user.id });
  restrictedProjectId = restricted.id;
  restrictedItemId = (
    await workItemsService.createWorkItem(
      { projectId: restricted.id, kind: 'task', title: 'Restricted' },
      ctx,
    )
  ).id;

  const open = await createTestProject({
    workspaceId,
    actorUserId: user.id,
    name: 'Open',
    identifier: 'OPN',
  });
  await adminDb.project.update({ where: { id: open.id }, data: { workflowPolicyMode: 'open' } });
  openItemId = (
    await workItemsService.createWorkItem({ projectId: open.id, kind: 'task', title: 'Open' }, ctx)
  ).id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Position an item in `status` directly (test setup) — bypasses the service so
 *  reaching a `from` state never depends on the transition graph under test. A
 *  direct DB write records NO revision, so the ledger only grows from the
 *  `updateStatus` calls we assert on. */
function setStatus(itemId: string, status: string): Promise<unknown> {
  return adminDb.workItem.update({ where: { id: itemId }, data: { status } });
}
async function revisionCount(itemId: string): Promise<number> {
  return (
    await withWorkspaceServiceContext(workspaceId, (tx) =>
      workItemRevisionRepository.listByWorkItem(itemId, {}, tx),
    )
  ).length;
}

describe('default workflow — graph shape is locked (literal pin, constant-derived guard)', () => {
  // This is the guard the card's "delete one edge → suite fails" step exercises:
  // the seed and the behavioral sweep both read DEFAULT_TRANSITIONS, so only a
  // pin against literals catches an edit to the constant itself.
  it('declares exactly the ten default statuses', () => {
    expect(STATUS_KEYS).toEqual([
      'todo',
      'blocked',
      'in_progress',
      // MOTIR-3003 — the in_progress-category state a card sits in between "the
      // agent stopped" and "a human should look at this": built, pull request
      // open, CI not yet green. It sits BEFORE `planning` because slot 4 is the
      // last board column a laptop shows in full (design/boards, panel 1).
      'implemented',
      // MOTIR-2425 — the in_progress-category state a card sits in while its
      // plan is reconsidered. It is in this literal pin for the same reason
      // every other key is: adding a status has to be a deliberate edit here.
      'planning',
      // MOTIR-12174 — planned and stale: a decision it rests on was corrected.
      // In the in_progress category so neither claim door takes it.
      'to_plan',
      'in_review',
      // MOTIR-5139 — a person's YES: approved, and not yet shipped. Same reason
      // as every other key here, and one more: its CATEGORY (`in_progress`) is
      // the whole claim of the story, so a status added without a deliberate
      // edit to this pin is exactly the change that must not slip through.
      'approved',
      'done',
      'cancelled',
    ]);
  });

  it('declares exactly the forty-eight default transition edges (finding #45 + 7.8.11 + MOTIR-1625 + MOTIR-2425 + MOTIR-3003 + MOTIR-5139 + MOTIR-5630 + MOTIR-5643 + MOTIR-12174 + MOTIR-12202)', () => {
    expect(new Set(EDGES.map(([from, to]) => edgeKey(from, to)))).toEqual(
      new Set([
        'todo>in_progress',
        'in_progress>in_review',
        'in_review>done',
        // MOTIR-1625: review is optional — an item can finish straight from
        // in_progress (and the MOTIR-1615 rollup's done rung needs this edge).
        'in_progress>done',
        'todo>blocked',
        'in_progress>blocked',
        // Subtask 7.8.11: an integrated-awaiting-review item can stall on a blocker.
        'in_review>blocked',
        'blocked>todo',
        'blocked>in_progress',
        'in_review>in_progress',
        'in_progress>todo',
        'done>in_progress',
        'cancelled>todo',
        'todo>cancelled',
        'in_progress>cancelled',
        'in_review>cancelled',
        'blocked>cancelled',
        // MOTIR-2425: a card whose plan is being reconsidered. IN from the two
        // states it can be in when that is discovered; OUT to the three a human
        // can send it to once the plan is approved. Deliberately NOT from
        // `in_review` — that path goes back through `in_progress`, which
        // already exists.
        'todo>planning',
        'in_progress>planning',
        'planning>todo',
        'planning>in_progress',
        'planning>cancelled',
        // MOTIR-5643 — the PARKING edges. Every non-terminal status may be
        // parked while a plan rewrites the card, and a parked card may rest at
        // `blocked` when the approved plan leaves it gated
        // (`agent-authored-plans.md` AMENDMENT 16 D10). NOTHING from `done` or
        // `cancelled`: we plan forward, and the partition below pins that.
        'blocked>planning',
        'implemented>planning',
        'in_review>planning',
        'approved>planning',
        'planning>blocked',
        // MOTIR-3003: built, waiting on checks. IN from the two states a card
        // can be in when its pull request opens; OUT to the five it can reach —
        // `in_review` is the one CI green performs, and the other four are
        // rework, block, cancel and the no-review-gate close. Not from
        // `in_review` (the promotion runs one way). (`todo` was deliberately
        // left out here too, until MOTIR-12202 — below.)
        'in_progress>implemented',
        'blocked>implemented',
        'implemented>in_review',
        'implemented>in_progress',
        'implemented>blocked',
        'implemented>cancelled',
        'implemented>done',
        // MOTIR-5139: a person's YES. ONE in and THREE out.
        'in_review>approved',
        'approved>done',
        'approved>in_progress',
        'approved>cancelled',
        // MOTIR-5630 · MOTIR-5804: the merge-queue EJECTION (`approval-gates.md`
        // §4 THIRD AMENDMENT, decision 7, as the FOURTH AMENDMENT's point 6
        // amends it). A manual FAILURE sends an approved card back to REVIEW,
        // where the merge question is asked again; an auto one sends an in-review
        // card to `implemented`. `implemented>approved` is ABSENT again — an
        // approval is only ever given from `in_review`.
        'approved>in_review',
        'approved>implemented',
        'in_review>implemented',
        // MOTIR-12174: To plan. IN from the two not-started states the mark
        // moves; OUT to the park, the queue and cancellation. Deliberately NOT
        // to `blocked`, `in_progress` or `done` — a stale card is not started or
        // closed without a re-plan — and no `planning>to_plan`: a declined plan
        // restores it by a system write.
        'todo>to_plan',
        'blocked>to_plan',
        'to_plan>planning',
        'to_plan>todo',
        'to_plan>cancelled',
        // MOTIR-12202: a pull request delivering a card that still reads To Do.
        // Linking or opening a ready one records it built; a green set takes it
        // straight to review. Still NOT `todo>done` (the merge completes it from
        // where those two left it) and NOT `blocked>in_review` (a person's block
        // is never lifted by a pull request).
        'todo>implemented',
        'todo>in_review',
      ]),
    );
    expect(EDGES).toHaveLength(48);
  });

  it('partitions the 10×10 grid into 48 edges + 10 self-loops + 42 non-edges', () => {
    expect(NON_EDGES).toHaveLength(
      STATUS_KEYS.length * STATUS_KEYS.length - EDGES.length - STATUS_KEYS.length,
    );
    expect(NON_EDGES).toHaveLength(42);
  });
});

describe('restricted mode — every default edge is accepted (the full 36-edge sweep)', () => {
  it.each(EDGES)(
    '%s → %s transitions and records exactly one "updated" revision',
    async (from, to) => {
      await setStatus(restrictedItemId, from);
      const before = await revisionCount(restrictedItemId);

      const updated = await workItemsService.updateStatus(restrictedItemId, to, ctx);
      expect(updated.status).toBe(to);

      const revs = await withWorkspaceServiceContext(workspaceId, (tx) =>
        workItemRevisionRepository.listByWorkItem(restrictedItemId, {}, tx),
      );
      expect(revs.length).toBe(before + 1);
      expect(revs[0]!.changeKind).toBe('updated');
      expect((revs[0]!.diff as Record<string, unknown>).status).toEqual({ from, to });
    },
  );
});

describe('restricted mode — every non-edge, non-self pair is rejected (IllegalTransitionError)', () => {
  it.each(NON_EDGES)('%s → %s is rejected and leaves the status unchanged', async (from, to) => {
    await setStatus(restrictedItemId, from);
    await expect(workItemsService.updateStatus(restrictedItemId, to, ctx)).rejects.toThrow(
      IllegalTransitionError,
    );
    expect((await workItemsService.getWorkItem(restrictedItemId, ctx)).status).toBe(from);
  });
});

describe('restricted mode — a no-op self-transition writes no revision (all six statuses)', () => {
  it.each(STATUS_KEYS)('%s → %s is a no-op (status held, no revision)', async (status) => {
    await setStatus(restrictedItemId, status);
    const before = await revisionCount(restrictedItemId);
    const updated = await workItemsService.updateStatus(restrictedItemId, status, ctx);
    expect(updated.status).toBe(status);
    expect(await revisionCount(restrictedItemId)).toBe(before);
  });
});

describe('open mode — the full real×real product is accepted (edge set bypassed)', () => {
  it.each(ALL_PAIRS)('open: %s → %s is accepted regardless of the edge set', async (from, to) => {
    await setStatus(openItemId, from);
    const updated = await workItemsService.updateStatus(openItemId, to, ctx);
    expect(updated.status).toBe(to);
  });

  it('still rejects an unknown target status key (UnknownStatusError)', async () => {
    await setStatus(openItemId, 'todo');
    await expect(workItemsService.updateStatus(openItemId, 'ghost', ctx)).rejects.toThrow(
      UnknownStatusError,
    );
  });
});

describe('terminal-set conformance — category=done is exactly { done, cancelled } (finding #21)', () => {
  it('the seeded terminal set matches the readiness predicate set, derived not hardcoded', async () => {
    const terminal = await workflowsService.getTerminalStatusKeys(restrictedProjectId, workspaceId);
    expect(terminal).toEqual(new Set(['done', 'cancelled']));
    // …and it equals what the constant declares (the seed faithfully wrote it).
    const fromConstant = new Set(
      DEFAULT_STATUSES.filter((s) => s.category === 'done').map((s) => s.key),
    );
    expect(terminal).toEqual(fromConstant);
  });
});

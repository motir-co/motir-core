// Plan-SHAPE E2E seed (Story MOTIR-3232 · Subtask MOTIR-3263).
//
// Three plan TOPOLOGIES, because the three canvas cards this spec verifies are
// each about a shape rather than a feature: where the canvas ARRIVES depends on
// which container a plan fills, which cards Show-changes marks depends on which
// nodes the plan touches, and which BODY the detail opens depends on how many
// distinct containers the proposals sit under. A fixture that got the shapes
// wrong would exercise all three surfaces and prove none of them.
//
// ⚠️ THE BOUNDARY WITH THE SIBLING SPEC (MOTIR-3243). That one seeds by STATUS —
// twenty-two approved plans, a known requester and a known decider, an empty tab
// — because the list surface is about lifecycle. Nothing here needs a second
// status and nothing there needs a topology. Agreed rather than merged, so
// neither spec pays for the other's fixture.
//
// ⚠️ THE PREMISE, AND IT IS VERIFIED RATHER THAN ASSUMED. Shape one hangs three
// subtasks off a proposal that does not exist yet, through an INTRA-PLAN ref
// (`parentRef: 'planItem:<id>'`) on the ordinary `addProposals` call. That ref
// survives, and `getPlanReview` returns those items with a **non-null
// `parentNodeId` and a NULL `parentIdentifier`** — the pair the arrival fix is
// about, and the pair a hand-built fixture would get wrong in a way that made
// the assertion vacuous. It is asserted directly, against the real services, in
// `tests/integration/plans/plansSurfaceStorySeams.test.ts` (MOTIR-3242), which is
// the right altitude for it; this helper builds the same topologies through the
// same calls so the two cannot drift apart silently.
//
// Everything rides the SHIPPED services — the one sanctioned cross-layer reach
// for E2E setup. No raw plan or plan-item inserts.

import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestPerson } from './testPerson';

export const PLANS_SHAPES_PASSWORD = 'plans-shapes-e2e-pass-7';

/** One committed work item, as the spec addresses it: `id` IS the canvas node id
 *  (`planReviewService` keys a node by the work item a proposal is ABOUT, falling
 *  back to the plan-item id only when there is no work item yet), and the crumb
 *  label the breadcrumb renders is `identifier · title`. */
export interface CommittedRef {
  id: string;
  identifier: string;
  title: string;
  /** Exactly what a breadcrumb crumb reads for this item. */
  crumb: string;
}

/**
 * SHAPE ONE — a proposed story under a committed epic, with its subtasks hung
 * off the story by intra-plan ref. The shape the arrival fix is about.
 *
 * ⚠️ IT IS ALSO A STRADDLING PLAN, and that is not an accident of the fixture —
 * it is what the shape IS. Its proposals sit under two distinct containers (the
 * epic holds the story; the story holds the subtasks), so under MOTIR-3262's
 * derived default this plan opens on the LIST, and the canvas is reached through
 * the switcher. The card was written before that rule landed; the spec asserts
 * both, which is stronger than either alone.
 */
export interface ShapeOne {
  planId: string;
  epic: CommittedRef;
  /** The PROPOSED story — `id` is its canvas node id, `crumb` what the last
   *  breadcrumb crumb reads (the proposed word where a key would go). */
  proposedStory: { id: string; title: string; crumb: string };
  subtaskTitles: string[];
  /** The epic's OTHER children — committed, untouched by the plan, and the half
   *  of leg 1 that must NOT be on screen when the canvas arrives. */
  committedSiblings: CommittedRef[];
}

/**
 * SHAPE TWO — two proposed stories and one MODIFIED committed story, all under
 * one committed epic. One container, so the canvas is this plan's default.
 *
 * The emphasis set deliberately spans TWO OPS: an implementation that marked
 * "the new cards" would satisfy a one-op leg and miss the point, which is that
 * Show changes is about the PLAN, not about newness.
 */
export interface ShapeTwo {
  planId: string;
  epic: CommittedRef;
  /** The two proposed stories' canvas node ids. */
  addedNodeIds: string[];
  /** The committed story the plan MODIFIES — its node id is the work item's. */
  modified: CommittedRef;
  /** Committed children the plan does not touch: no emphasis, and dimmed. */
  untouched: CommittedRef[];
}

/**
 * SHAPE THREE — proposals under TWO distinct committed containers. No single
 * canvas level can show it, so the detail opens on the list.
 */
export interface ShapeThree {
  planId: string;
  addedSubtaskTitles: string[];
  addedStoryTitle: string;
  /** The committed story the subtasks hang under — the list names it as parent. */
  story: CommittedRef;
}

/**
 * SHAPE FOUR — a plan proposing into a CROWDED container (MOTIR-4026).
 *
 * Thirty-four committed siblings under one epic, plus two proposals: ONE
 * container, so Part IX §3's arm says canvas — and thirty-six nodes, so Part XIII §6's
 * legibility arm says LIST. It is the shape the widened default exists for, and
 * it is deliberately indistinguishable from shape TWO to the reader who only
 * counts containers.
 *
 * Its plan also carries a LONG generated title and a long summary, because the
 * rail's fold is the other thing this shape is here to drive: a decision held at
 * the bottom of a scrolling column is only invisible once the column is long.
 */
export interface ShapeFour {
  planId: string;
  epic: CommittedRef;
  committedCount: number;
  addedTitles: string[];
  longTitle: string;
}

/**
 * SHAPE FIVE — one plan carrying ALL THREE ops, each with real bodies
 * (MOTIR-4187, story MOTIR-4181).
 *
 * Every other shape here is about the CANVAS's arrival behaviour, so none of
 * them has ever needed a `remove`: `grep -c "op: 'remove'"` over this file
 * returned 0 before this shape. The peek's acceptance walk reads all three, so
 * the shape is added to the shipped seed rather than seeded bespoke in the spec
 * — which is the criterion, and the reason this comment exists rather than a
 * second seeding mechanism next door.
 */
export interface ShapeFive {
  planId: string;
  epic: CommittedRef;
  /** The `modify`'s target — it carries both bodies and rail values, so the peek
   *  has something to render and something to mark. */
  modified: CommittedRef;
  /** The `remove`'s target: what approving will archive. */
  removed: CommittedRef;
  /** The proposed titles, in append order. */
  addedTitle: string;
  modifiedTitle: string;
}

/**
 * SHAPE SIX — a plan whose `manual` proposal carries its STEPS (Story
 * MOTIR-3810 · MOTIR-4625), beside a stepless `add` so the ABSENT state has a
 * subject in the same plan.
 */
export interface ShapeSix {
  planId: string;
  epic: CommittedRef;
  /** The `manual` add — the one that carries four steps. */
  withStepsTitle: string;
  /** The `add` that carries none, for the no-section negative. */
  steplessTitle: string;
}

export interface PlansShapesSeed {
  email: string;
  password: string;
  workspaceId: string;
  projectId: string;
  one: ShapeOne;
  two: ShapeTwo;
  three: ShapeThree;
  four: ShapeFour;
  five: ShapeFive;
  six: ShapeSix;
}

/**
 * SHAPE SIX's four steps, exported so the spec asserts against the SEED's own
 * strings rather than against a second copy of them. One plain, one with
 * instructions, one with a command, one for the agent — the four shapes a row
 * can take (`design/ai-planning/design-notes.md` Part XV).
 */
export const SIX_STEPS = [
  { text: 'Create a restricted Stripe API key' },
  {
    text: 'Scope it to charges:write',
    notesMd: 'Dashboard → Developers → API keys → **Edit permissions**.',
  },
  {
    text: 'Set the deployment secret',
    commandText: 'fly secrets set STRIPE_RESTRICTED_KEY=rk_test_placeholder --app motir-core',
    executor: 'coding_agent' as const,
  },
  { text: 'Confirm a test charge succeeds' },
];

async function makeTenant(email: string): Promise<{ ctx: ServiceContext; projectId: string }> {
  const owner = await createTestPerson({
    email,
    password: PLANS_SHAPES_PASSWORD,
    name: 'Shapes Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Plan Shapes E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Plan Shapes',
    identifier: 'PSH',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // `/plans` and `/plans/[id]` are ACTIVE-PROJECT scoped, so pin it for the owner
  // exactly as the other plans seeds do.
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return { ctx: { userId: owner.id, workspaceId: workspace.id }, projectId: project.id };
}

export async function seedPlanShapes(email: string): Promise<PlansShapesSeed> {
  const { ctx, projectId } = await makeTenant(email);

  const commit = async (
    kind: 'epic' | 'story' | 'subtask',
    title: string,
    parentId?: string,
  ): Promise<CommittedRef> => {
    const item = await workItemsService.createWorkItem(
      { projectId, kind, title, ...(parentId ? { parentId } : {}) },
      ctx,
    );
    return {
      id: item.id,
      identifier: item.identifier,
      title: item.title,
      // `workItemCrumbLabel` — the one format the breadcrumb renders.
      crumb: `${item.identifier} · ${item.title}`,
    };
  };

  // ── SHAPE ONE ─────────────────────────────────────────────────────────────
  const oneEpic = await commit('epic', 'Marketplace payouts');
  const committedSiblings = [
    await commit('story', 'Payout ledger', oneEpic.id),
    await commit('story', 'Merchant onboarding', oneEpic.id),
    await commit('story', 'Dispute handling', oneEpic.id),
  ];

  const oneStoryTitle = 'Payout reconciliation';
  const onePlan = await plansService.createPlan(projectId, { title: 'Reconciliation plan' }, ctx);
  // TWO CALLS, and the order is the mechanism: the subtasks' `parentRef` names
  // the story's PLAN-ITEM id, which does not exist until the first call returns.
  const afterStory = await plansService.addProposals(
    onePlan.id,
    [
      {
        op: 'add',
        proposedFields: { title: oneStoryTitle, kind: 'story' },
        parentRef: oneEpic.id,
      },
    ],
    ctx,
  );
  const oneStoryItemId = afterStory.items[0]!.id;
  const oneSubtaskTitles = ['Reconcile ledger rows', 'Backfill missing payouts', 'Alert on drift'];
  await plansService.addProposals(
    onePlan.id,
    oneSubtaskTitles.map((title) => ({
      op: 'add' as const,
      proposedFields: { title, kind: 'subtask' as const },
      parentRef: `planItem:${oneStoryItemId}`,
    })),
    ctx,
  );
  await plansService.markPlanned(onePlan.id, ctx);

  // ── SHAPE TWO ─────────────────────────────────────────────────────────────
  const twoEpic = await commit('epic', 'Billing overhaul');
  const twoModified = await commit('story', 'Invoice templates', twoEpic.id);
  const twoUntouched = [
    await commit('story', 'Tax rates', twoEpic.id),
    await commit('story', 'Dunning emails', twoEpic.id),
    await commit('story', 'Proration rules', twoEpic.id),
  ];

  const twoPlan = await plansService.createPlan(projectId, { title: 'Billing plan' }, ctx);
  const afterTwo = await plansService.addProposals(
    twoPlan.id,
    [
      {
        op: 'add',
        proposedFields: { title: 'Usage metering', kind: 'story' },
        parentRef: twoEpic.id,
      },
      {
        op: 'add',
        proposedFields: { title: 'Credit notes', kind: 'story' },
        parentRef: twoEpic.id,
      },
      {
        op: 'modify',
        workItemId: twoModified.id,
        patch: { title: 'Invoice templates + branding' },
      },
    ],
    ctx,
  );
  await plansService.markPlanned(twoPlan.id, ctx);
  // The two `add`s key by their own plan-item ids (they are not about a work item
  // yet); the `modify` keys by its TARGET. Both come from the same returned list,
  // in send order — never from a query written in the spec.
  const twoAddedNodeIds = afterTwo.items.filter((item) => item.op === 'add').map((item) => item.id);

  // ── SHAPE THREE ───────────────────────────────────────────────────────────
  const threeEpic = await commit('epic', 'Notifications');
  const threeStory = await commit('story', 'Digest emails', threeEpic.id);

  const threeSubtaskTitles = ['Render the digest', 'Schedule the send'];
  const threeStoryTitle = 'Push notifications';
  const threePlan = await plansService.createPlan(projectId, { title: 'Notifications plan' }, ctx);
  await plansService.addProposals(
    threePlan.id,
    [
      ...threeSubtaskTitles.map((title) => ({
        op: 'add' as const,
        proposedFields: { title, kind: 'subtask' as const },
        parentRef: threeStory.id,
      })),
      {
        op: 'add' as const,
        proposedFields: { title: threeStoryTitle, kind: 'story' as const },
        parentRef: threeEpic.id,
      },
    ],
    ctx,
  );
  await plansService.markPlanned(threePlan.id, ctx);

  // ── SHAPE FOUR ────────────────────────────────────────────────────────────
  // Thirty-four committed siblings and two proposals under ONE epic: the
  // container count says canvas, the level's SIZE says list (Part XIII §6).
  // Thirty-four is chosen against the threshold rather than for roundness — 36
  // nodes is the first level past `ARRIVAL_LEVEL_MAX_NODES` (35 on the 5-column
  // band, MOTIR-10537), so the level crosses it by exactly one card.
  const fourEpic = await commit('epic', 'Notifications platform');
  const FOUR_COMMITTED = 34;
  for (let i = 0; i < FOUR_COMMITTED; i += 1) {
    await commit('story', `Notification channel ${i + 1}`, fourEpic.id);
  }
  const fourLongTitle =
    'Re-plan MOTIR-3232 after the PLAN_REVIEW_STREAM_BATCH_SIZE change: the tabbed list, the detail pane, and the canvas arrival level, with every referrer swept';
  const fourPlan = await plansService.createPlan(
    projectId,
    {
      title: fourLongTitle,
      summary:
        'A long summary, so the rail has a transcript worth scrolling: the decision is only invisible once the column above it is long, which is the condition the pinned footer exists for.',
    },
    ctx,
  );
  const fourTitles = ['Digest scheduling', 'Delivery receipts'];
  await plansService.addProposals(
    fourPlan.id,
    fourTitles.map((title) => ({
      op: 'add' as const,
      proposedFields: { title, kind: 'story' as const },
      parentRef: fourEpic.id,
    })),
    ctx,
  );
  await plansService.markPlanned(fourPlan.id, ctx);

  // ── SHAPE FIVE ────────────────────────────────────────────────────────────
  // One plan, three ops, real bodies. The `modify` moves two RAIL rows
  // (`priority`, `storyPoints`) so the peek's changed markers have something to
  // mark and its count line has a non-zero numerator.
  const fiveEpic = await commit('epic', 'Plan review surfaces');
  const fiveModified = await workItemsService.createWorkItem(
    {
      projectId,
      kind: 'story',
      title: 'One peek for a proposal',
      parentId: fiveEpic.id,
      descriptionMd: 'The body this work item carries today, before the plan is approved.',
      explanationMd: 'The rationale it carries today.',
      priority: 'high',
      storyPoints: 3,
    },
    ctx,
  );
  const fiveRemoved = await commit('story', 'The retired proposal surface', fiveEpic.id);
  const fiveAddedTitle = 'The review model emits a peek-shaped proposal';
  const fiveModifiedTitle = 'One peek for a PROPOSAL — both doors, one surface';
  const fivePlan = await plansService.createPlan(projectId, { title: 'Peek collapse plan' }, ctx);
  await plansService.addProposals(
    fivePlan.id,
    [
      {
        op: 'add',
        proposedFields: {
          title: fiveAddedTitle,
          kind: 'story',
          descriptionMd: 'What approval will create.',
          explanationMd: 'Why this one matters.',
          priority: 'high',
          storyPoints: 5,
        },
        parentRef: fiveEpic.id,
      },
      {
        op: 'modify',
        workItemId: fiveModified.id,
        patch: {
          title: fiveModifiedTitle,
          descriptionMd: 'The body approval will write in its place.',
          explanationMd: 'The rationale approval will write in its place.',
          priority: 'highest',
          storyPoints: 8,
        },
      },
      { op: 'remove', workItemId: fiveRemoved.id },
    ],
    ctx,
  );
  await plansService.markPlanned(fivePlan.id, ctx);

  // ── SHAPE SIX ─────────────────────────────────────────────────────────────
  // A `manual` proposal that carries its STEPS, and a stepless one beside it.
  // Both in ONE plan so the spec can show the section and its absence without
  // navigating between plans — the contrast is the point of the negative.
  const sixEpic = await commit('epic', 'Billing, provisioned');
  const sixWithStepsTitle = 'Provision the Stripe restricted key';
  const sixSteplessTitle = 'Wire the charge path';
  const sixPlan = await plansService.createPlan(projectId, { title: 'Billing plan' }, ctx);
  await plansService.addProposals(
    sixPlan.id,
    [
      {
        op: 'add',
        proposedFields: {
          title: sixWithStepsTitle,
          kind: 'task',
          type: 'manual',
          // The CARD's executor — the seed every unnamed row inherits at
          // approve, which is what makes three of the four rows read `You`.
          executor: 'human',
          descriptionMd:
            'The billing epic needs a live Stripe key before the charge path can be built.',
          explanationMd: 'An account holder does this; there is no pull request.',
          storyPoints: 2,
          estimateMinutes: 30,
          todos: SIX_STEPS,
        },
        parentRef: sixEpic.id,
      },
      {
        op: 'add',
        proposedFields: {
          title: sixSteplessTitle,
          kind: 'task',
          type: 'code',
          executor: 'coding_agent',
          descriptionMd: 'The code half, which has no out-of-band steps.',
          storyPoints: 3,
          estimateMinutes: 45,
        },
        parentRef: sixEpic.id,
      },
    ],
    ctx,
  );
  await plansService.markPlanned(sixPlan.id, ctx);

  return {
    email,
    password: PLANS_SHAPES_PASSWORD,
    workspaceId: ctx.workspaceId,
    projectId,
    one: {
      planId: onePlan.id,
      epic: oneEpic,
      proposedStory: {
        id: oneStoryItemId,
        title: oneStoryTitle,
        // The proposed word goes where a key would — `planReview.proposedCrumb`.
        crumb: `New · ${oneStoryTitle}`,
      },
      subtaskTitles: oneSubtaskTitles,
      committedSiblings,
    },
    two: {
      planId: twoPlan.id,
      epic: twoEpic,
      addedNodeIds: twoAddedNodeIds,
      modified: twoModified,
      untouched: twoUntouched,
    },
    four: {
      planId: fourPlan.id,
      epic: fourEpic,
      committedCount: FOUR_COMMITTED,
      addedTitles: fourTitles,
      longTitle: fourLongTitle,
    },
    three: {
      planId: threePlan.id,
      addedSubtaskTitles: threeSubtaskTitles,
      addedStoryTitle: threeStoryTitle,
      story: threeStory,
    },
    five: {
      planId: fivePlan.id,
      epic: fiveEpic,
      modified: {
        id: fiveModified.id,
        identifier: fiveModified.identifier,
        title: fiveModified.title,
        crumb: `${fiveModified.identifier} · ${fiveModified.title}`,
      },
      removed: fiveRemoved,
      addedTitle: fiveAddedTitle,
      modifiedTitle: fiveModifiedTitle,
    },
    six: {
      planId: sixPlan.id,
      epic: sixEpic,
      withStepsTitle: sixWithStepsTitle,
      steplessTitle: sixSteplessTitle,
    },
  };
}

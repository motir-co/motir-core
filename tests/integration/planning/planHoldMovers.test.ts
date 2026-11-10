import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════
// THE STORY GATE — while a plan is open, its work items cannot leave Planning by
// hand (Story MOTIR-6017 · Subtask MOTIR-6269; `docs/decisions/agent-authored-plans.md`
// AMENDMENT 21). THE RULE, THE EXITS, THE MOVERS AND THE GUARDS.
// ═══════════════════════════════════════════════════════════════════════════
//
// The doors and the writer → consumer seam are `planHoldStoryGate.test.tsx` beside
// this file. This one pins, against a REAL Postgres:
//
//   1. THE UP-FRONT READ AGREES WITH THE GUARD — for every held and not-held shape,
//      `readPlanHold` is non-null exactly when the funnel refuses.
//   2. EVERY `PlanStatus`, as a checklist (§1, §4), plus the expired-`generating` case.
//   3. EVERY EXIT (§3): the hand move FAILS while the plan is undecided, the exit
//      moves the card, and the hand move afterwards is ORDINARY.
//   4. THE BACKGROUND MOVERS (§5(b)/(d)) — one per disposition class: a rolled-up
//      parent records `plan_held` and its JOB completes; the merge sync, the
//      repository-set re-evaluation, the queue-exit settle and an automation rule
//      each RECORD their outcome and throw nothing; an exempt `system` writer (the
//      downward cascade) still moves the card.
//   5. AMENDMENT 16 D3 / D8 and §6 — parking a card from In Review supersedes its
//      `awaiting` gate as `pulled_back`, a decline restores it to In Review and
//      re-asks what its evidence still owes, a reconcile can raise a gate on a held
//      card, and that gate's decide door is refused and the gate is left `awaiting`.
//   6. THE ARCHITECTURE GUARDS — no door reads `plan_target_lock` itself,
//      `STATUS_TRANSITION_REFUSALS` holds the error, and no plan-hold path borrows
//      the approval overlay's address.
//
// Only the session / active-project resolvers are stubbed (the project rule).
const { session, activeCtx } = vi.hoisted(() => ({
  session: { current: null as unknown },
  activeCtx: { current: null as unknown },
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

import { $Enums } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { automationEngineService } from '@/lib/services/automationEngineService';
import { automationRulesService } from '@/lib/services/automationRulesService';
import { childStatusCascadeService } from '@/lib/services/childStatusCascadeService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { settleUnlandedOutcome } from '@/lib/services/mergeQueueExitService';
import { reconcileGatesFor } from '@/lib/services/gateSetFor';
import { plansService } from '@/lib/services/plansService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { projectsService } from '@/lib/services/projectsService';
import { repoSetCompletionService } from '@/lib/services/repoSetCompletionService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { statusDerivationOnRequested } from '@/lib/jobs/definitions/statusDerivation';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import { PlanTargetHeldError } from '@/lib/workItems/errors';
import { STATUS_TRANSITION_REFUSALS } from '@/lib/workItems/statusTransitionRefusals';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';
import { JobTestEngine, dispatchedEvents, spyOnJobDispatch } from '../../helpers/jobs';
import { linkWorkspaceReposToProject } from '../../helpers/projectRepoLink';

const T = { timeout: 60_000 };

let fx: WorkItemFixture;

beforeEach(async () => {
  spyOnJobDispatch();
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: fx.owner.email, name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Seeding ──────────────────────────────────────────────────────────────────

type Card = { id: string; identifier: string };
type Ctx = WorkItemFixture['ctx'];

async function seedCard(
  title = 'The card',
  over: { kind?: 'task' | 'story' | 'subtask'; parentId?: string } = {},
): Promise<Card> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: over.kind ?? 'task', title, parentId: over.parentId },
    fx.ctx,
  );
  return { id: dto.id, identifier: dto.identifier };
}

/** A `modify` naming the card, in a plan still `generating` — the append PARKS it. */
async function generatingModify(workItemId: string, projectId = fx.projectId, ctx: Ctx = fx.ctx) {
  const plan = await plansService.createPlan(projectId, { title: 'Re-plan' }, ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'modify', workItemId, patch: { descriptionMd: 'Re-scoped.' } }],
    ctx,
  );
  return plan.id;
}

async function plannedModify(workItemId: string, projectId = fx.projectId, ctx: Ctx = fx.ctx) {
  const planId = await generatingModify(workItemId, projectId, ctx);
  await plansService.markPlanned(planId, ctx);
  return planId;
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

async function lockFor(workItemId: string) {
  return adminDb.planTargetLock.findUnique({ where: { workItemId } });
}

const expireLease = (workItemId: string) =>
  adminDb.planTargetLock.update({
    where: { workItemId },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });

/** `workflowPolicyMode = open`: every edge is legal, so the ONLY thing between a
 *  mover and `done` is the hold (the restricted graph has no `planning → done`). */
const openWorkflow = (projectId = fx.projectId) =>
  adminDb.project.update({ where: { id: projectId }, data: { workflowPolicyMode: 'open' } });

/** Does the funnel refuse a hand move of `card` → `to` with the plan hold? Rolled
 *  back either way: the probe runs in a transaction it then abandons, so the card
 *  is left where it was for the next assertion. */
async function funnelRefuses(card: Card, to = 'in_progress'): Promise<boolean> {
  const ROLLBACK = new Error('probe rollback');
  try {
    await withWorkspaceContext(fx.ctx, async (tx) => {
      await workItemsService.applyStatusTransition(card.id, to, fx.ctx, tx);
      throw ROLLBACK;
    });
  } catch (err) {
    if (err === ROLLBACK) return false;
    if (err instanceof PlanTargetHeldError) return true;
    throw err;
  }
  return false;
}

// ── 1 + 2 · The up-front read agrees with the guard, over every PlanStatus ───

describe('the up-front read agrees with the guard — and the PlanStatus checklist', () => {
  /** Each shape seeds one card and names whether it HOLDS. */
  const SHAPES: Array<[string, boolean, () => Promise<Card>]> = [
    // ── the PlanStatus checklist, one member each ──
    [
      'generating — holds',
      true,
      async () => {
        const c = await seedCard();
        await generatingModify(c.id);
        return c;
      },
    ],
    [
      'planned — holds',
      true,
      async () => {
        const c = await seedCard();
        await plannedModify(c.id);
        return c;
      },
    ],
    [
      // Bug MOTIR-9006 — being approved holds until the approval commits.
      'approving — holds',
      true,
      async () => {
        const c = await seedCard();
        const planId = await plannedModify(c.id);
        await adminDb.plan.update({
          where: { id: planId },
          data: { status: 'approving', approvingAt: new Date() },
        });
        return c;
      },
    ],
    [
      'stale — holds',
      true,
      async () => {
        const c = await seedCard();
        const planId = await plannedModify(c.id);
        await adminDb.plan.update({ where: { id: planId }, data: { status: 'stale' } });
        return c;
      },
    ],
    [
      'stale PAST its lease — still holds (§4: it never expires)',
      true,
      async () => {
        const c = await seedCard();
        const planId = await plannedModify(c.id);
        await adminDb.plan.update({ where: { id: planId }, data: { status: 'stale' } });
        await expireLease(c.id);
        return c;
      },
    ],
    [
      'planned PAST its lease — still holds',
      true,
      async () => {
        const c = await seedCard();
        await plannedModify(c.id);
        await expireLease(c.id);
        return c;
      },
    ],
    [
      'approved — holds nothing (its lock row is gone)',
      false,
      async () => {
        const c = await seedCard();
        const planId = await plannedModify(c.id);
        await plansService.approvePlan(planId, fx.ctx);
        expect(await lockFor(c.id)).toBeNull();
        // Put it back at Planning by hand: an approved plan must not hold it.
        await workItemsService.updateStatus(c.id, PLANNING_STATUS_KEY, fx.ctx);
        return c;
      },
    ],
    [
      'declined — holds nothing (its lock row is gone)',
      false,
      async () => {
        const c = await seedCard();
        const planId = await plannedModify(c.id);
        await plansService.declinePlan(planId, fx.ctx);
        expect(await lockFor(c.id)).toBeNull();
        await workItemsService.updateStatus(c.id, PLANNING_STATUS_KEY, fx.ctx);
        return c;
      },
    ],
    [
      'approved, with a lock row that SURVIVED — the predicate still says no',
      false,
      async () => {
        const c = await seedCard();
        const planId = await plannedModify(c.id);
        await adminDb.plan.update({ where: { id: planId }, data: { status: 'approved' } });
        return c;
      },
    ],
    [
      'declined, with a lock row that SURVIVED — the predicate still says no',
      false,
      async () => {
        const c = await seedCard();
        const planId = await plannedModify(c.id);
        await adminDb.plan.update({ where: { id: planId }, data: { status: 'declined' } });
        return c;
      },
    ],
    [
      'an EXPIRED `generating` lease — does not hold',
      false,
      async () => {
        const c = await seedCard();
        await generatingModify(c.id);
        await expireLease(c.id);
        return c;
      },
    ],
    // ── the other exclusions ──
    [
      'a SESSION-only lock (planId null) on an OPEN session — holds (AMENDMENT 23 §5)',
      true,
      async () => {
        const c = await seedCard();
        const planId = await plannedModify(c.id);
        const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
        await adminDb.planTargetLock.update({
          where: { workItemId: c.id },
          data: { planId: null, sessionId: plan.sessionId },
        });
        return c;
      },
    ],
    [
      'a SESSION-only lock whose session has ENDED — does not hold',
      false,
      async () => {
        const c = await seedCard();
        const planId = await plannedModify(c.id);
        const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
        await adminDb.planTargetLock.update({
          where: { workItemId: c.id },
          data: { planId: null, sessionId: plan.sessionId },
        });
        await adminDb.planChangeSession.update({
          where: { id: plan.sessionId! },
          data: { endedAt: new Date(), endReason: 'idle' },
        });
        return c;
      },
    ],
    [
      'hand-parked at Planning with no lock — does not hold',
      false,
      async () => {
        const c = await seedCard();
        await workItemsService.updateStatus(c.id, PLANNING_STATUS_KEY, fx.ctx);
        return c;
      },
    ],
    [
      'a live plan lock on a card NOT at Planning — does not hold',
      false,
      async () => {
        const c = await seedCard();
        await plannedModify(c.id);
        await adminDb.workItem.update({ where: { id: c.id }, data: { status: 'in_progress' } });
        return c;
      },
    ],
  ];

  it.each(SHAPES)('%s', T, async (_label, holds, seed) => {
    const card = await seed();
    const read = await planTargetLockService.readPlanHold(card.id, fx.ctx);
    // `blocked` is an edge out of both `planning` and `in_progress`, so the probe
    // is a legal move for every shape and only the hold can refuse it.
    const refused = await funnelRefuses(card, 'blocked');

    expect(read !== null, 'readPlanHold').toBe(holds);
    expect(refused, 'the funnel').toBe(holds);
    if (read) expect(read.itemKey).toBe(card.identifier);
  });

  it('the checklist is TOTAL — the shapes above name every PlanStatus member', () => {
    const named = new Set(
      SHAPES.map(([label]) => label.split(/[ ,]/)[0]).filter((w) =>
        ['generating', 'planned', 'approving', 'stale', 'approved', 'declined'].includes(w!),
      ),
    );
    // Read from the Prisma enum, not listed, so a sixth member fails here.
    const members = Object.keys($Enums.PlanStatus);
    expect([...named].sort()).toEqual([...members].sort());
  });

  it(
    '`releaseExpired` skips an expired `stale` lock — and it still holds after the sweep',
    T,
    async () => {
      const card = await seedCard();
      const planId = await plannedModify(card.id);
      await adminDb.plan.update({ where: { id: planId }, data: { status: 'stale' } });
      await expireLease(card.id);

      const out = await planTargetLockService.releaseExpired();

      expect(out.entries).toContainEqual({ workItemId: card.id, outcome: 'plan_awaiting_review' });
      expect(await planTargetLockService.readPlanHold(card.id, fx.ctx)).toMatchObject({
        planStatus: 'stale',
      });
      await expect(workItemsService.updateStatus(card.id, 'todo', fx.ctx)).rejects.toBeInstanceOf(
        PlanTargetHeldError,
      );
    },
  );
});

// ── 3 · Every exit moves the card; the hand move afterwards is ordinary ─────

describe('every exit still moves the card, and the hand move afterwards is ordinary (§3)', () => {
  async function expectHeldNow(card: Card) {
    await expect(
      workItemsService.updateStatus(card.id, 'in_progress', fx.ctx),
    ).rejects.toBeInstanceOf(PlanTargetHeldError);
    expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
  }

  async function expectOrdinaryAfter(card: Card, restsAt: string) {
    expect(await statusOf(card.id)).toBe(restsAt);
    expect(await lockFor(card.id)).toBeNull();
    expect(await planTargetLockService.readPlanHold(card.id, fx.ctx)).toBeNull();
    await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);
    expect(await statusOf(card.id)).toBe('in_progress');
  }

  it('approve — rests at To Do', T, async () => {
    const card = await seedCard();
    const planId = await plannedModify(card.id);
    await expectHeldNow(card);
    await plansService.approvePlan(planId, fx.ctx);
    await expectOrdinaryAfter(card, 'todo');
  });

  it('approve — rests at Blocked when a blocker is open', T, async () => {
    const card = await seedCard();
    const blocker = await seedCard('An open blocker');
    await workItemsService.linkWorkItems(
      { fromId: card.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    const planId = await plannedModify(card.id);
    await expectHeldNow(card);
    await plansService.approvePlan(planId, fx.ctx);
    await expectOrdinaryAfter(card, 'blocked');
  });

  it('decline — restores the prior status', T, async () => {
    const card = await seedCard();
    const planId = await plannedModify(card.id);
    await expectHeldNow(card);
    await plansService.declinePlan(planId, fx.ctx);
    await expectOrdinaryAfter(card, 'todo');
  });

  it('a withdraw that EMPTIES the plan', T, async () => {
    const card = await seedCard();
    const planId = await plannedModify(card.id);
    await expectHeldNow(card);
    const item = await adminDb.planItem.findFirstOrThrow({ where: { planId } });
    await plansService.withdrawProposal(planId, item.id, fx.ctx);
    await expectOrdinaryAfter(card, 'todo');
  });

  it('a discarded close (a `generating` plan declined)', T, async () => {
    const card = await seedCard();
    const planId = await generatingModify(card.id);
    await expectHeldNow(card);
    await plansService.declinePlan(planId, fx.ctx);
    await expectOrdinaryAfter(card, 'todo');
  });

  it('the abandoned-plan sweep', T, async () => {
    const card = await seedCard();
    await generatingModify(card.id);
    await expectHeldNow(card);
    // The author died: its lease runs out. (An expired lease already stops
    // holding — §1 — and the sweep is what gives the card back.)
    await expireLease(card.id);
    const out = await planTargetLockService.releaseExpired();
    expect(out.entries).toContainEqual({ workItemId: card.id, outcome: 'restored' });
    await expectOrdinaryAfter(card, 'todo');
  });
});

// ── 4 · The background movers ───────────────────────────────────────────────

describe('the background movers — one per disposition class (§5)', () => {
  async function heldStoryWithChild(childStatus: string) {
    const story = await seedCard('Story', { kind: 'story' });
    const child = await seedCard('Child', { kind: 'subtask', parentId: story.id });
    await plannedModify(story.id);
    await adminDb.workItem.update({ where: { id: child.id }, data: { status: childStatus } });
    return { story, child };
  }

  it('(b) the parent rollup records `plan_held` and its JOB completes', T, async () => {
    await truncateJobRuns();
    const { story, child } = await heldStoryWithChild('implemented');

    const { result, error } = await new JobTestEngine({
      function: statusDerivationOnRequested,
      events: [
        {
          name: 'work-item/derivation.requested',
          data: {
            workspaceId: fx.workspaceId,
            parentId: story.id,
            workItemId: child.id,
            reason: 'imported-status-pinned',
          },
        },
      ],
    }).execute();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ outcome: 'plan_held', parentId: story.id });
    const runs = await adminDb.jobRun.findMany({
      where: { functionId: statusDerivationOnRequested.id },
    });
    expect(runs.map((r) => r.status)).toEqual(['succeeded']);
    expect(await statusOf(story.id)).toBe(PLANNING_STATUS_KEY);
    expect(await lockFor(story.id)).not.toBeNull();
  });

  it(
    '(b) an automation rule’s transition is RECORDED on its execution row, never thrown',
    T,
    async () => {
      const card = await seedCard();
      await plannedModify(card.id);
      const dispatch = spyOnJobDispatch();
      const rule = await automationRulesService.create(
        fx.project.identifier,
        {
          name: 'start it',
          triggerType: 'created',
          triggerConfig: {},
          conditionFilterParam: null,
          actions: [{ type: 'transition', toStatusId: 'in_progress' }],
        },
        fx.ctx,
      );

      const summary = await automationEngineService.runForEvent({
        trigger: 'created',
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: card.id,
        eventId: 'evt-plan-held',
      });

      // A held card is not the rule's to move, so the run is neither a success nor a
      // failure: it records `plan_held` naming the refusal, leaves the failure streak
      // alone and emails nobody (MOTIR-6340; AMENDMENT 21 §5(b)).
      expect(summary).toMatchObject({ matched: 1, failed: 0, succeeded: 0, planHeld: 1 });
      const rows = await adminDb.automationRuleExecution.findMany({ where: { ruleId: rule.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('plan_held');
      expect(rows[0]!.error).toMatch(/^PLAN_TARGET_HELD: /);
      const after = await adminDb.automationRule.findUniqueOrThrow({ where: { id: rule.id } });
      expect(after).toMatchObject({ consecutiveFailureCount: 0, enabled: true });
      expect(
        dispatchedEvents(dispatch).filter(
          (e) =>
            e.name === 'email.send' &&
            (e.data as { template?: string }).template === 'automation-rule-failed',
        ),
      ).toEqual([]);
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
    },
  );

  it('(b) the queue-exit settle declines a held card — no move, nothing re-asked', T, async () => {
    const card = await seedCard();
    await plannedModify(card.id);

    for (const landingClass of ['retryable', 'setting', 'cant_land'] as const) {
      const out = await withWorkspaceContext(fx.ctx, async (tx) => {
        const item = await tx.workItem.findUniqueOrThrow({ where: { id: card.id } });
        return settleUnlandedOutcome(item, landingClass, fx.ctx, tx);
      });
      expect(out, landingClass).toEqual({ transition: null, raised: false });
    }
    expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
    expect(await adminDb.approvalGate.count({ where: { workItemId: card.id } })).toBe(0);
  });

  it(
    '(d) an EXEMPT system writer — the downward cascade — still moves a held card',
    T,
    async () => {
      const story = await seedCard('Story', { kind: 'story' });
      const child = await seedCard('Child', { kind: 'subtask', parentId: story.id });
      await plannedModify(child.id);
      expect(await planTargetLockService.readPlanHold(child.id, fx.ctx)).not.toBeNull();
      await adminDb.workItem.update({ where: { id: story.id }, data: { status: 'done' } });

      const out = await childStatusCascadeService.cascadeToChildren(story.id, fx.workspaceId, {
        fromStatusKey: 'in_progress',
        toStatusKey: 'done',
      });

      expect(out).toMatchObject({ outcome: 'cascaded', toStatus: 'done' });
      expect(await statusOf(child.id)).toBe('done');
    },
  );
});

describe('the merge-driven movers — the sync and the repository-set re-evaluation', () => {
  const INSTALLATION_ID = 'inst-plan-hold-gate';
  const REPO_PROVIDER_ID = '9611';
  const BRANCH = 'subtask/plan-hold';

  async function scenario() {
    _resetInstallationTokenCache();
    const user = await usersService.createUser({
      email: 'plan-hold-merge@example.com',
      password: 'hunter2hunter2',
      name: 'Owner',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: user.id,
    });
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: 'Acme',
      identifier: 'ACME',
    });
    const ctx = { userId: user.id, workspaceId: workspace.id };
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: INSTALLATION_ID,
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: REPO_PROVIDER_ID,
          owner: 'moooon',
          name: 'motir-core',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
    await linkWorkspaceReposToProject({
      workspaceId: workspace.id,
      projectId: project.id,
      names: ['motir-core'],
    });
    const card = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'Ship it', targetRepos: ['motir-core'] },
      ctx,
    );
    await workItemsService.updateStatus(card.id, 'in_progress', ctx);
    return { project, ctx, card };
  }

  const pr = (action: string, merged = false) =>
    githubWebhookService.handleEvent('pull_request', {
      action,
      installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
      repository: { id: Number(REPO_PROVIDER_ID) },
      pull_request: {
        number: 811,
        state: merged ? 'closed' : 'open',
        merged,
        merged_at: merged ? '2026-09-25T10:00:00.000Z' : null,
        title: 'Ship it',
        head: { ref: BRANCH },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });

  /** Open + link the pull request, park the card under an undecided plan, merge. */
  async function mergeOnAHeldCard(opts: { open: boolean }) {
    const s = await scenario();
    await pr('opened');
    await githubPullRequestService.linkPullRequestByCoordinates(
      {
        workItemId: s.card.id,
        projectId: s.project.id,
        owner: 'moooon',
        name: 'motir-core',
        number: 811,
        headRef: BRANCH,
        baseRef: 'main',
        title: null,
      },
      s.ctx,
    );
    await workItemsService.updateStatus(s.card.id, 'implemented', s.ctx);
    await plannedModify(s.card.id, s.project.id, s.ctx);
    expect(await statusOf(s.card.id)).toBe(PLANNING_STATUS_KEY);
    if (opts.open) await openWorkflow(s.project.id);
    const merged = await pr('closed', true);
    return { s, merged };
  }

  const holdNotes = (workItemId: string) =>
    adminDb.comment.count({
      where: { workItemId, bodyMd: { contains: 'a plan is open on this item' } },
    });

  it(
    'the merge sync answers `plan_held`, posts its hold note once, and does NOT fail the delivery',
    T,
    async () => {
      // `open` so the edge `planning → done` is legal and ONLY the hold can refuse.
      const { s, merged } = await mergeOnAHeldCard({ open: true });

      expect(merged).toMatchObject({
        event: 'pull_request',
        outcome: 'plan_held',
        workItemId: s.card.id,
      });
      expect(await statusOf(s.card.id)).toBe(PLANNING_STATUS_KEY);
      expect(await holdNotes(s.card.id)).toBe(1);

      // A redelivery of the same merge adds no second note.
      await pr('closed', true);
      expect(await holdNotes(s.card.id)).toBe(1);
    },
  );

  it(
    'under the RESTRICTED workflow the merge is still a recorded outcome, never a throw',
    T,
    async () => {
      const { s, merged } = await mergeOnAHeldCard({ open: false });
      // `planning → done` is not an edge of the default graph, and the funnel checks
      // legality BEFORE the hold — so the default workflow records
      // `illegal_transition` here, and the plan-held note is not posted. Pinned as
      // measured: `plan_held` is reached only where `planning → done` is legal.
      expect(merged).toMatchObject({
        event: 'pull_request',
        outcome: 'illegal_transition',
        workItemId: s.card.id,
      });
      expect(await holdNotes(s.card.id)).toBe(0);
      expect(await statusOf(s.card.id)).toBe(PLANNING_STATUS_KEY);
    },
  );

  it('the repository-set re-evaluation answers `plan_held` and moves nothing', T, async () => {
    const { s } = await mergeOnAHeldCard({ open: true });

    const out = await repoSetCompletionService.reevaluateItem(s.card.id, { dryRun: false });

    expect(out).toMatchObject({ workItemId: s.card.id, outcome: 'plan_held', toStatus: 'done' });
    expect(await statusOf(s.card.id)).toBe(PLANNING_STATUS_KEY);
  });
});

// ── 5 · D3 · D8 · §6 — the park, the decline and a gate on a held card ─────

describe('D3 · D8 · §6 — the park closes an awaiting gate, a decline re-asks it, and deciding one raised on a held card is refused', () => {
  async function reviewedItem() {
    const story = await seedCard('Story', { kind: 'story' });
    const item = await seedCard('Design', { kind: 'subtask', parentId: story.id });
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
    return item;
  }

  const raiseGate = (itemId: string, subjectId = `subject-${itemId}`) =>
    withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: itemId,
          kind: 'design_result',
          subjectId,
        },
        tx,
      ),
    );

  /** A design result the gate predicate reads as CURRENT, so `reconcileGatesFor`
   *  owes the card a `design_result` question about it. */
  async function currentDesign(itemId: string): Promise<string> {
    const id = `design-${itemId}`;
    await adminDb.designEvidence.create({
      data: { id, workspaceId: fx.workspaceId, workItemId: itemId },
    });
    return id;
  }

  const awaitingOn = (itemId: string) =>
    adminDb.approvalGate.findMany({ where: { workItemId: itemId, state: 'awaiting' } });

  /** A card parked from In Review under an undecided plan, with an `awaiting`
   *  design gate standing on it. The gate is raised AFTER the park, because that is
   *  the only order in which one can stand on a held card: the park itself closes
   *  every gate raised before it (AMENDMENT 16 D3, pinned below), and a gate on a
   *  held card is one a reconcile raised afterwards (AMENDMENT 21 §6, also below). */
  async function gatedThenHeld() {
    const item = await reviewedItem();
    const planId = await plannedModify(item.id);
    expect(await statusOf(item.id)).toBe(PLANNING_STATUS_KEY);
    const gate = await raiseGate(item.id);
    return { item, gateId: gate.id, planId };
  }

  // AMENDMENT 16 D3, as corrected by MOTIR-6339: the park is a status write with NO
  // `system` flag (`planTargetLockService`'s acquire), so leaving In Review for
  // `planning` is a move out of the review band, and `approval-gates.md` §6d rule 6
  // supersedes the gate in the park's own transaction.
  it(
    'AMENDMENT 16 D3: parking a card from In Review supersedes its awaiting gate as `pulled_back`',
    T,
    async () => {
      const item = await reviewedItem();
      const gate = await raiseGate(item.id);
      await plannedModify(item.id);
      expect(await statusOf(item.id)).toBe(PLANNING_STATUS_KEY);

      const closed = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
      expect(closed.state).toBe('superseded');
      expect(closed.supersededCause).toBe('pulled_back');
      expect(await awaitingOn(item.id)).toHaveLength(0);
    },
  );

  it(
    'AMENDMENT 16 D8: a decline restores In Review with a NEW gate for the question its evidence still owes',
    T,
    async () => {
      const item = await reviewedItem();
      const evidenceId = await currentDesign(item.id);
      const first = await raiseGate(item.id, evidenceId);
      const planId = await plannedModify(item.id);
      expect(await awaitingOn(item.id)).toHaveLength(0);

      await plansService.declinePlan(planId, fx.ctx);

      expect(await statusOf(item.id)).toBe('in_review');
      // The superseded row is never re-opened; the restore's re-ask raised a fresh one.
      expect(
        (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: first.id } })).state,
      ).toBe('superseded');
      const reasked = await awaitingOn(item.id);
      expect(reasked).toHaveLength(1);
      expect(reasked[0]).toMatchObject({ kind: 'design_result', subjectId: evidenceId });
      expect(reasked[0]!.id).not.toBe(first.id);
    },
  );

  it(
    'AMENDMENT 21 §6 is reachable: a reconcile raises the owed question on a card the plan holds',
    T,
    async () => {
      const item = await reviewedItem();
      const evidenceId = await currentDesign(item.id);
      await raiseGate(item.id, evidenceId);
      await plannedModify(item.id);
      expect(await awaitingOn(item.id)).toHaveLength(0);

      // What the pull-request reconcile does for every non-terminal card it delivers.
      const raised = await withWorkspaceContext(fx.ctx, async (tx) =>
        reconcileGatesFor(await tx.workItem.findUniqueOrThrow({ where: { id: item.id } }), tx),
      );

      expect(raised).toEqual(['design_result']);
      expect(await statusOf(item.id)).toBe(PLANNING_STATUS_KEY);
      expect(await awaitingOn(item.id)).toMatchObject([
        { kind: 'design_result', subjectId: evidenceId },
      ]);
    },
  );

  const approve = (gateId: string) =>
    approvalGatesService.decide(
      { stamp: DECIDED_WITHOUT_A_READER, gateId, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

  it('with every edge legal, the HOLD is what refuses it — `PLAN_TARGET_HELD`', T, async () => {
    const { item, gateId } = await gatedThenHeld();
    await openWorkflow();

    await expect(approve(gateId)).rejects.toBeInstanceOf(PlanTargetHeldError);

    // Not half-applied: the question is still asked, and the card did not move.
    const gate = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gateId } });
    expect(gate.state).toBe('awaiting');
    expect(gate.decidedById).toBeNull();
    expect(await statusOf(item.id)).toBe(PLANNING_STATUS_KEY);
  });

  it('once the plan is declined the same gate decides normally', T, async () => {
    const { item, gateId, planId } = await gatedThenHeld();
    await openWorkflow();
    await plansService.declinePlan(planId, fx.ctx);
    expect(await statusOf(item.id)).toBe('in_review');

    const result = await approve(gateId);
    expect(result.gate.state).toBe('approved');
    expect(await statusOf(item.id)).toBe('done');
  });
});

// ── 6 · The architecture guards ─────────────────────────────────────────────

const ROOT = join(__dirname, '..', '..', '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

/** Every `planTargetLock…` identifier in a file — the `git grep` the card names,
 *  done over the tree so it runs where there is no `.git`. */
function lockMentions(rel: string): string[] {
  return readFileSync(join(ROOT, rel), 'utf8').match(/\bplanTargetLock\w*/g) ?? [];
}

describe('the architecture guards', () => {
  it('no door reads `plan_target_lock` itself — the doors name only the SERVICE', () => {
    // `git grep -n "planTargetLock" -- app lib/mcp lib/api`: a door may ASK the
    // service (`planTargetLockService.readPlanHold`), never reach the table
    // (`tx.planTargetLock…`) or the repository — which is how a second copy of the
    // rule would start.
    const offenders: string[] = [];
    for (const rel of ['app', 'lib/mcp', 'lib/api'].flatMap(sourceFiles)) {
      for (const hit of lockMentions(rel)) {
        if (hit !== 'planTargetLockService')
          offenders.push(`${relative(ROOT, join(ROOT, rel))}: ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the rule has ONE statement — `planHoldFor` is called only by the service that gathers its inputs', () => {
    const callers = ['app', 'lib', 'components']
      .flatMap(sourceFiles)
      .filter((rel) => /\bplanHoldFor\(/.test(readFileSync(join(ROOT, rel), 'utf8')));
    expect(callers.sort()).toEqual([
      'lib/plans/planHold.ts',
      'lib/services/planTargetLockService.ts',
    ]);
  });

  it('`STATUS_TRANSITION_REFUSALS` contains `PlanTargetHeldError`', () => {
    expect(STATUS_TRANSITION_REFUSALS as readonly unknown[]).toContain(PlanTargetHeldError);
  });

  it('no plan-hold path borrows the approval overlay’s address (`withApprovalOverlay`)', () => {
    // Whole files that are plan-hold paths and nothing else…
    for (const rel of [
      'lib/plans/planHold.ts',
      'lib/planning/planDestination.ts',
      'components/issues/heldRefusal.ts',
      'components/issues/useStatusHeld.ts',
      'app/(authed)/boards/_components/BoardHeldRefusal.tsx',
      'app/(authed)/boards/_components/BoardCard.tsx',
    ]) {
      expect(readFileSync(join(ROOT, rel), 'utf8'), rel).not.toMatch(/withApprovalOverlay/);
    }
    // …and the plan door inside the notice, which ALSO draws the gate's door.
    const notice = readFileSync(join(ROOT, 'components/issues/StatusHeldNotice.tsx'), 'utf8');
    const planDoor = notice.slice(
      notice.indexOf('function ReviewPlanLink'),
      notice.indexOf('export function StatusHeldNotice'),
    );
    expect(planDoor).toContain('planRowDestination(');
    expect(planDoor).not.toMatch(/withApprovalOverlay/);
  });
});

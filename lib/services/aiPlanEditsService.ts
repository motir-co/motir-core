import { submitJob, streamJob, getJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { resolveTenantLanguages } from '@/lib/ai/tenantLanguages';
import { resolvePlanningCodeContext } from '@/lib/ai/codeContext';
import {
  RECORD_PLANNING_MISTAKES_CONTEXT_FIELD,
  resolveRecordPlanningMistakesForJob,
} from '@/lib/ai/lessonCapture';
import { ONBOARDING_CONTEXT_FIELD, onboardingContextFor } from '@/lib/ai/onboardingContext';
import { resolveProjectRepoContext } from '@/lib/ai/projectRepoContext';
import { MotirAiError } from '@/lib/ai/errors';
import type {
  CarriedAnswers,
  JobContextBag,
  JobStreamEvent,
  SubmittedRequirement,
} from '@/lib/ai/types';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  NoPlanForJobError,
  PlanNotEditableError,
  PlanNotFoundError,
  PlanRevisionInFlightError,
} from '@/lib/plans/errors';

import { narrowSharpenedRequirement } from '@/lib/sharpening/requirement';
import { plansService } from '@/lib/services/plansService';
import type { PlanRevisionAgentActor } from '@/lib/services/planRevisionsService';
import { planRepository } from '@/lib/repositories/planRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import type { PlanJobStateDto, PlanOriginDto, PlanOutcomeDto } from '@/lib/dto/plans';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// ⚠️ There is NO approve here, by design (MOTIR-1747). A plan edit's proposals
// land in the run's `Plan` (`addProposals` → `markPlanned`), and the ONE path
// that turns proposals into work items is `plansService.approvePlan` →
// `materialize`, behind the 7.12.5 persist gate. This service used to carry a
// second one — `approveDelta`, reading the job result's `planDelta` — which every
// planner returned empty, so it could only ever write nothing; it is retired
// along with its route, its client helper and the delta shape gate.

export class InvalidTargetError extends Error {
  readonly code = 'INVALID_TARGET' as const;
  constructor(detail: string) {
    super(detail);
    this.name = 'InvalidTargetError';
  }
}

function buildTenant(
  ctx: ProjectContext,
  organizationId: string,
  isMeta: boolean,
  internalBilling: boolean,
  languages: TenantLanguages,
) {
  return {
    organizationId,
    isMeta,
    internalBilling,
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    projectKey: ctx.project.identifier,
    // The two languages motir-ai writes in (MOTIR-8741): the org's content language,
    // and the language of the person who STARTED the plan (`''` when nobody did).
    contentLanguage: languages.contentLanguage,
    personLanguage: languages.personLanguage,
  };
}

type TenantLanguages = Awaited<ReturnType<typeof resolveTenantLanguages>>;

/** WHOSE language a plan-edit submit speaks (MOTIR-8741): the clicker's on a user
 *  submit, nobody's on the cadence watcher's — the SAME rule `createdById` follows,
 *  computed once so the two cannot drift. */
function personUserIdFor(origin: 'user' | 'cadence', ctx: ProjectContext): string | null {
  return origin === 'user' ? ctx.userId : null;
}

/**
 * ⚠️ `PlanEditJobKind` IS GONE (MOTIR-4304). It named the 7.11/7.12 subset a plan
 * EDIT could submit — `augment` / `expand_item` / `replan` — and after ADR
 * `session-model.md` §6 step 2 there is one planning kind, `plan`, for all six
 * submit sites. `submitPlanEditJob` lost its `kind` parameter with it: a
 * parameter with one legal value is a parameter that will drift.
 *
 * What each site names is now the CONTEXT, which is what motir-ai resolves the
 * target arm from — `context.planId` a plan, `context.rootItemKey` /
 * `context.targetKeys` a work item, neither the project. Nothing about the
 * context changes here; only the kind does.
 */

/**
 * The ids a plan-edit submit hands back.
 *
 * The shape GREW a `planId` alongside `jobId` (MOTIR-1743) — the decision the
 * bug asked to record: it mirrors `aiGenerationService.startGeneration`'s
 * `{ jobId, planId }` exactly, so both producers into the 7.21 Plan substrate
 * return the same pair, and a caller that wants to link the user straight to
 * `/plans/<id>` no longer has to re-resolve the plan by `sourceJobId`. It is
 * ADDITIVE: the REST routes echo it, and every existing consumer
 * (`planEditsClient`, `planChangeSessionsService`)
 * destructures `{ jobId }` and reads the new field defensively (optional in the
 * browser-facing client types, since a stubbed/older response carries only
 * `jobId`).
 */
export interface PlanEditSubmitResult {
  jobId: string;
  planId: string;
}

/**
 * Per-submit knobs that describe the SUBMIT, not the planning request itself
 * (nothing here reaches motir-ai — the job envelope is unchanged).
 *
 * `origin` (MOTIR-916) stamps the opened Plan's provenance. Every request-path
 * caller omits it and gets `user`; the auto-plan cadence watcher passes
 * `cadence` so the review surface can label an expansion nobody clicked.
 */
export interface PlanEditSubmitOptions {
  origin?: PlanOriginDto;
  /**
   * The planning CONVERSATION this submit comes from (AMENDMENT 17 §5;
   * MOTIR-6022) — `planChangeSessionsService.submit` passes its session's id, so
   * the plan joins that session. Absent ⇒ no conversation: the plan gets a new
   * session of the door's origin — `cadence` for the watcher, `expand` for an
   * expand, else `generation` (a one-shot augment has no conversation either).
   */
  sessionId?: string;
  /**
   * The submit's idempotency key (MOTIR-9258) — a conversation passes one per
   * attempt (`turnSubmitKey`), so the submit is re-sent within
   * `MOTIR_AI_SUBMIT_BUDGET_MS` and a repeat answers the job the first created.
   * Absent ⇒ one attempt, as every other planning door still sends.
   */
  idempotencyKey?: string;
  /**
   * The conversation's CARRIED ANSWERS (Story MOTIR-9221 · MOTIR-9315) — what its
   * grilling settled before this run. `submitAugment` / `submitContextual` put it on
   * `context.carriedAnswers`, beside `requirement` and never merged into it, and
   * only when present.
   */
  carriedAnswers?: CarriedAnswers;
}

/**
 * Submit a plan-edit job AND open the `generating` `Plan` its proposals append
 * into — the ONE shared step every plan-edit submit needs (MOTIR-1743).
 *
 * Before this, the four submits stopped at `submitJob`, so no `Plan` existed for
 * the job. But motir-ai's `augment` / `expand_item` / `replan` handlers write
 * their output through the Plan/PlanItem proposal store (`addProposals` →
 * `markPlanned`), and the core seam those callbacks land on
 * (`aiGenerationService.appendProposals`) resolves the plan by `sourceJobId` —
 * so EVERY plan-edit job died on its first callback with
 * `NoPlanForJobError` → 404. Opening the plan here is the missing half.
 *
 * Order is deliberate and copied from `startGeneration`: the job is submitted
 * FIRST so the Plan can bind to it via `sourceJobId`, and so a failed submit
 * (motir-ai unreachable / out-of-credits) leaves NO orphan Plan behind — the
 * typed `MotirAiError` propagates before any row is written.
 *
 * The Plan is opened untitled (`title`/`summary` null), exactly as
 * `startGeneration` does by default; the review surfaces already render the
 * `untitledPlan` fallback.
 */
/**
 * Assert the actor may run a planning job on this project — `ai:plan`
 * (Story MOTIR-2291 · Subtask MOTIR-2357).
 *
 * ⚠️ CALLED AT THE TOP OF EACH PUBLIC METHOD, not inside `submitPlanEditJob`.
 * The one-seam version is tidier and is WRONG: `submitExpand` resolves its
 * target work item first, so a gate behind them answers "no such
 * item" to an actor who is not allowed to ask the question — a target oracle for
 * anyone who can reach the route. The gate goes before the lookup.
 *
 * This service carried no assertion of its own. The guard read four of its five
 * operations as governed only because of something else the ROUTE happened to
 * call, which is exactly the indirection a named key replaces; a planning job
 * spends the workspace's AI credits, so the key is deliberately narrower than
 * `work_item:edit`.
 */
async function assertCanPlan(ctx: ProjectContext): Promise<void> {
  await projectAccessService.assertPermission(
    ctx.projectId,
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    'ai:plan',
  );
}

/**
 * THE CONTEXT EVERY PLANNING SUBMIT SENDS (MOTIR-7916) — the tenant and the always-present
 * fields, written ONCE. `submitPlanEditJob`, `submitRevise` and `submitResume` each used to
 * (or would have had to) rebuild this, and a field one of them forgot was dropped silently:
 * the MOTIR-4343 shape, where the two submits that bypassed the shared one never sent the
 * consent flag. Now a third submit cannot bypass it.
 *
 *   * `generateExplanations`, the planning-mistake flag and the onboarding marker are ALWAYS
 *     present — `false` when off — because absence reads on the far side as "the producer
 *     predates the field", i.e. as ON;
 *   * `code` and `repositories` are spread conditionally, because for them absence means
 *     "this workspace has none".
 *
 * The caller adds what is SPECIFIC to its submit (an anchor set, a `planId`, a prompt).
 */
async function buildPlanningJobContext(
  ctx: ProjectContext,
  planId: string | null,
  // WHOSE language the planner replies in (MOTIR-8741) — the person who STARTED the
  // plan, not whoever pressed Send: required, so no planning submit can forget it.
  personUserId: string | null,
) {
  const { organizationId, isMeta, internalBilling } = await resolveTenantOrg({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const languages = await resolveTenantLanguages({
    workspaceId: ctx.workspaceId,
    userId: personUserId,
  });
  // The PLANNING PRODUCER, not the bare grant list (MOTIR-4604): freshness verdict, reason and
  // in-flight flag, enqueuing a refresh where one can run. `undefined` ⇒ no connected repo.
  const code = await resolvePlanningCodeContext({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
  });
  // The project's repository SET (MOTIR-3044), on every planning submit.
  const repositories = await resolveProjectRepoContext(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  // May this project's planner record what it got wrong (MOTIR-3350)?
  const recordPlanningMistakes = await resolveRecordPlanningMistakesForJob(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  // The plan's SHARPENED requirement as the run's own (Task MOTIR-1101 · MOTIR-8450):
  // a submit that writes an existing plan carries what a Grill me session settled on
  // it as `requirement`, which satisfies PART 1 on the far side, so the run does not
  // re-ask it. Read HERE so no plan-writing submit can forget it; absent when the
  // plan carries none.
  const requirement = planId ? await sharpenedRequirementOf(planId, ctx) : undefined;
  return {
    tenant: buildTenant(ctx, organizationId, isMeta, internalBilling, languages),
    planningFields: {
      ...(requirement ? { requirement } : {}),
      generateExplanations: ctx.project.aiGenerateExplanations,
      [RECORD_PLANNING_MISTAKES_CONTEXT_FIELD]: recordPlanningMistakes,
      // Is this the project's FIRST plan (MOTIR-4736)?
      [ONBOARDING_CONTEXT_FIELD]: onboardingContextFor(ctx.project),
      ...(code ? { code } : {}),
      ...(repositories ? { repositories } : {}),
    },
  };
}

/** The plan's stored sharpened requirement, narrowed to its six fields. */
async function sharpenedRequirementOf(
  planId: string,
  ctx: ProjectContext,
): Promise<SubmittedRequirement | undefined> {
  // One column, not `getPlan`: the caller already admitted the actor to this plan,
  // and the read must not add a second load of the plan row ahead of the bind.
  const stored = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    planRepository.findSharpenedRequirementById(planId, ctx.workspaceId, tx),
  );
  return narrowSharpenedRequirement(stored ?? null);
}

/** The trailing `submitJob` options of a keyed submit, or none at all. */
function keyedSubmit(idempotencyKey: string | undefined): [] | [{ idempotencyKey: string }] {
  return idempotencyKey ? [{ idempotencyKey }] : [];
}

async function submitPlanEditJob(
  context: JobContextBag,
  ctx: ProjectContext,
  opts: PlanEditSubmitOptions = {},
): Promise<PlanEditSubmitResult> {
  const origin = opts.origin ?? 'user';
  const personUserId = personUserIdFor(origin, ctx);
  // A caller that supplies its own requirement keeps it; otherwise the plan it
  // writes (when it names one) supplies the stored one.
  const { tenant, planningFields } = await buildPlanningJobContext(
    ctx,
    context.requirement ? null : (context.planId ?? null),
    personUserId,
  );
  const { jobId } = await submitJob(
    // ONE planning kind (ADR `session-model.md` §6 step 2). Every planning submit
    // in the product sends this; motir-ai reads WHAT the run is about off the
    // context bag, not off a name.
    'plan',
    tenant,
    { ...context, ...planningFields },
    { userId: ctx.userId },
    // Keyed only when the caller keyed it (MOTIR-9258): a keyless door's call is
    // exactly what it was, one attempt.
    ...keyedSubmit(opts.idempotencyKey),
  );
  // WHO ASKED (MOTIR-2986) — and this is the ONE seam where the acting user is
  // not always the answer. `submitPlanJob` serves BOTH the request paths (expand
  // / augment / replan / contextual, `origin: 'user'`) and the auto-plan cadence
  // watcher, which calls it with `origin: 'cadence'` under the PROJECT OWNER's
  // credential (`autoPlanCadenceService` builds `{ userId: owner.userId }` so the
  // job has one). Nobody clicked on that path, so recording the owner would
  // attribute to them a request they never made. The requester is therefore
  // written ⟺ a person actually asked, and `origin` is what identifies the rest.
  const rootItemKey = context.rootItemKey ?? null;
  const plan = await plansService.createPlan(
    ctx.projectId,
    {
      title: null,
      summary: null,
      sourceJobId: jobId,
      origin,
      session: opts.sessionId
        ? { sessionId: opts.sessionId }
        : {
            origin: origin === 'cadence' ? 'cadence' : rootItemKey ? 'expand' : 'generation',
            // An expand is ABOUT its root item, so its session is anchored there
            // and the Plans page can say what it was for.
            ...(rootItemKey ? { targetKeys: [rootItemKey] } : {}),
          },
      createdById: personUserId,
      // WHO WROTE it (MOTIR-2996) — and unlike `createdById` above, this one
      // does NOT vary by path. Every submit this seam serves (expand / augment /
      // replan / contextual, and the cadence watcher) hands the tree to motir-ai
      // to write, so Motir is the author of all of them; only the REQUESTER
      // differs. Recording it retires the `sourceJobId != null` inference the
      // Plans surface stood on.
      //
      // SERVER-SET here, exactly as `create_plan` fixes `mcp`
      // (`agent-authored-plans.md` Q3: the source is never a caller field).
      // `authorModel` is not known yet — motir-ai resolves the planning model
      // per job (`PlanningRun.model`) after this plan exists, and sends it on
      // the job's `final: true` append, where `markPlanned` records it (Bug
      // MOTIR-8420). Decision 6 keeps it off every tenant read.
      authorSource: 'native',
      authorHarness: 'Motir',
    },
    ctx,
  );
  return { jobId, planId: plan.id };
}

/**
 * How the caller addresses the plan whose outcome it wants — by the `planId` a
 * submit returned, or by the `jobId` it returned alongside. Both come out of the
 * SAME `{ jobId, planId }` pair, so a client that persisted either one can ask.
 */
export type PlanOutcomeRef = { planId: string } | { jobId: string };

/**
 * Resolve the motir-ai job behind a still-`generating` plan.
 *
 * This is the ONLY way to tell a run that is still working from one that DIED —
 * the plan row cannot answer it. A job that fails writes NO terminal plan state
 * of its own (motir-ai's inbound seams are the success path: `appendProposals` /
 * `patchProposal`), so nothing about the plan changes when its producer stops.
 * A caller polling the plan alone would therefore wait on it indefinitely.
 *
 * ⚠️ IT IS NO LONGER *FOREVER*, AND THIS FUNCTION IS WHY (MOTIR-3064). Such a
 * plan is now reconciled OUT of `generating` by
 * `abandonedPlanService.reconcileAbandoned`, a cron sweep that calls THIS
 * resolver for every empty, producer-bearing plan past its grace and writes
 * `declined` on the ones whose job is terminal or gone. So the state is
 * eventually terminal — but only eventually, on the sweep's cadence, and this
 * remains the only way to know NOW. That is exactly why the `job` block stays on
 * `getOutcome`: a client polling a live submit must not have to wait for a cron
 * tick to learn its run died.
 *
 * A motir-ai outage is reported as `reachable: false` rather than thrown,
 * because the PLAN read already succeeded — degrading the job block beats
 * failing an answer we largely have. The sweep leans on the same distinction in
 * the other direction: unreachable is NOT evidence of death, so it terminates
 * nothing on that arm.
 *
 * Exported (MOTIR-3064) so the sweep asks the job through the ONE resolver the
 * product already uses, rather than deriving a second opinion from `getJob`.
 */
export async function resolveJobState(
  jobId: string,
  coreProjectId: string,
): Promise<PlanJobStateDto> {
  try {
    const job = await getJob(jobId, coreProjectId);
    return {
      status: job.status,
      reachable: true,
      failure: job.error ? { code: job.error.code, message: job.error.message } : null,
    };
  } catch (err) {
    if (err instanceof MotirAiError) {
      return { status: null, reachable: false, failure: { code: err.code, message: err.message } };
    }
    throw err;
  }
}

export const aiPlanEditsService = {
  /**
   * What became of a submitted plan job (MOTIR-1825) — the companion READ to
   * every `{ jobId, planId }` submit, for a client with no stream to hold open.
   *
   * Reports the PLAN's own status plus its proposal COUNT, and — only while the
   * plan is still `generating` — the job's state, so "still running" and "died"
   * are distinguishable (see {@link resolveJobState}).
   *
   * Reads nothing into the tree and writes nothing: the count is of PROPOSALS.
   * `plansService.approvePlan` remains the only path from a proposal to a work
   * item, so a caller that polls this to completion still has an unchanged tree
   * until a human approves.
   */
  async getOutcome(ref: PlanOutcomeRef, ctx: ServiceContext): Promise<PlanOutcomeDto> {
    let planId: string;
    if ('planId' in ref) {
      planId = ref.planId;
    } else {
      const resolved = await plansService.findPlanIdForJob(ref.jobId, ctx);
      if (!resolved) throw new NoPlanForJobError(ref.jobId);
      planId = resolved;
    }
    // A READ for an actor — `get_plan_status` and `GET /api/v1/plans/{id}/status`
    // — so it admits by the Plans room's scope (MOTIR-6330).
    const plan = await plansService.getPlanForReader(planId, ctx);
    const job =
      plan.status === 'generating' && plan.sourceJobId
        ? await resolveJobState(plan.sourceJobId, plan.projectId)
        : null;
    return {
      planId: plan.id,
      projectId: plan.projectId,
      status: plan.status,
      origin: plan.origin,
      jobId: plan.sourceJobId,
      itemCount: plan.itemCount,
      createdAt: plan.createdAt,
      plannedAt: plan.plannedAt,
      decidedAt: plan.decidedAt,
      job,
    };
  },

  /**
   * Submit a project-wide planning turn — the `augment` floor, additions-only.
   *
   * `requirement` (Story MOTIR-3942 · MOTIR-4172) is the optional six-field WHAT
   * the caller settled before submitting. It rides the context bag to
   * `context.requirement`, where motir-ai's `readSuppliedPart1` reads it.
   *
   * ⚠️ SPREAD CONDITIONALLY, exactly like `code` and `repositories` and for
   * exactly their meaning of absence: a missing key says NOBODY SUPPLIED ONE,
   * which is the answer the consumer already handles by opening the
   * conversation. Sending `null` or `{}` would be a supplied-but-empty
   * requirement, a third state nothing on either side has a reading for. It is
   * deliberately NOT the `generateExplanations` / `recordPlanningMistakes`
   * discipline — those are settings whose absence must not be mistaken for a
   * default, so they are always sent.
   */
  async submitAugment(
    prompt: string,
    ctx: ProjectContext,
    requirement?: SubmittedRequirement,
    opts: PlanEditSubmitOptions = {},
  ): Promise<PlanEditSubmitResult> {
    await assertCanPlan(ctx);
    const { carriedAnswers, ...rest } = opts;
    return submitPlanEditJob(
      {
        prompt,
        ...(requirement ? { requirement } : {}),
        ...(carriedAnswers ? { carriedAnswers } : {}),
      },
      ctx,
      rest,
    );
  },

  /**
   * Submit a CONTEXTUAL planning turn — a chat turn anchored at one or more work
   * items (7.12.3 · MOTIR-909), riding the SHIPPED 7.11 job contract.
   *
   * Two things make this different from {@link submitAugment}, and only two —
   * `requirement` is carried identically by both (see {@link submitAugment}), and
   * saying so is the point: a dispatched agent's re-plan is always ANCHORED, so
   * the augment arm is the one that would drop the value unnoticed.
   *
   *  1. `context.targetKeys` carries the anchor SET. That flag is what turns the
   *     submit into a contextual turn on the motir-ai side (7.12.2 · MOTIR-908):
   *     the scoping module CLASSIFIES the intent from the turn text, RESOLVES which
   *     of `expand_item` / `augment` / `replan` it really is (structure overrides
   *     text — a leaf cannot be expanded; a subtask re-plan climbs to its story),
   *     and pushes the UNION of every anchor's item + parent + siblings + children
   *     as grounding.
   *  2. The submitted kind is therefore only the FALLBACK when the turn text
   *     carries no signal, and `augment` — additions-only — is deliberately that
   *     floor: the safest thing to do with an ambiguous instruction is propose
   *     ADDITIONS, never a re-shape. Core does NOT pre-classify; that would put two
   *     classifiers in the loop and let core's guess override the engine's.
   *
   * The re-plan "reason" is the turn text itself — there is no separate `reason`
   * param, by contract. NO new job kind is introduced. Nothing is written to the
   * TREE here: this SUBMITS and opens the job's empty `generating` Plan (the
   * proposal sink — MOTIR-1743); no work item is touched, and persisting a
   * returned delta stays behind the confirmation gate (7.13.5) on the approve
   * route.
   */
  async submitContextual(
    prompt: string,
    targetKeys: readonly string[],
    ctx: ProjectContext,
    requirement?: SubmittedRequirement,
    opts: PlanEditSubmitOptions = {},
  ): Promise<PlanEditSubmitResult> {
    await assertCanPlan(ctx);
    const { carriedAnswers, ...rest } = opts;
    return submitPlanEditJob(
      {
        prompt,
        targetKeys: [...targetKeys],
        ...(requirement ? { requirement } : {}),
        ...(carriedAnswers ? { carriedAnswers } : {}),
      },
      ctx,
      rest,
    );
  },

  /** The live channel for a contextual planning turn's job — the same 7.1.4 job
   *  stream every plan-edit surface relays, named for its caller so the panel's
   *  route reads as one seam. Browsers stream from CORE, never from motir-ai. */
  streamContextual(jobId: string, coreProjectId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId, coreProjectId);
  },

  async submitExpand(
    itemKey: string,
    ctx: ProjectContext,
    opts: PlanEditSubmitOptions = {},
  ): Promise<PlanEditSubmitResult> {
    await assertCanPlan(ctx);
    const wi = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByIdentifier(ctx.projectId, itemKey, tx),
    );
    if (!wi || wi.projectId !== ctx.projectId) {
      throw new InvalidTargetError(`Work item ${itemKey} not found in this project`);
    }
    const containerKinds = new Set(['epic', 'story', 'task', 'bug']);
    if (!containerKinds.has(wi.kind)) {
      throw new InvalidTargetError(
        `Work item ${itemKey} is a ${wi.kind} — expand requires a container (epic/story/task/bug)`,
      );
    }

    return submitPlanEditJob({ rootItemKey: itemKey }, ctx, opts);
  },

  /**
   * REVISE the plan the reviewer is holding (Story MOTIR-3595 · Subtask
   * MOTIR-3599) — the first submit whose target is a PLAN.
   *
   * ⚠️ IT DOES NOT OPEN A PLAN, and that is the whole story in one line. Every
   * sibling submit goes through `submitPlanEditJob`, whose last act is
   * `plansService.createPlan` — correct for a pass that produces a new proposal
   * set, and exactly wrong here: the reviewer asked for THIS plan to change, and
   * a second plan in the review queue is the outcome they were trying to avoid by
   * not declining. So the returned `planId` is the one that was passed in, and a
   * test asserts the identity rather than the shape.
   *
   * The order is deliberate and is not the sibling's:
   *
   *  1. **ACQUIRE THE LEASE FIRST.** It is what serializes two reviewers pressing
   *     Send at once, and what refuses a decision racing the revision
   *     (`agent-authored-plans.md` AMENDMENT 10 D2). Acquiring after the submit
   *     would let two jobs exist for one plan, the loser of the acquire having
   *     already been dispatched.
   *  2. **SUBMIT**, and RELEASE the lease if it throws — an unreachable motir-ai
   *     or an out-of-credits refusal must not hold a plan for the whole lease
   *     window over a job that never started.
   *  3. **RE-POINT `sourceJobId`** at the revision job, which is how the internal
   *     seams resolve *the job's plan* (`findBySourceJobId`) with no second
   *     resolution path and no new column. The field's own meaning is unchanged —
   *     WHICH JOB — it simply becomes the job that most recently WROTE this plan,
   *     which is what every reader of it actually wants; and the lease is what
   *     makes a single scalar safe, because one plan is revised by one job.
   */
  async submitRevise(
    planId: string,
    prompt: string,
    ctx: ProjectContext,
  ): Promise<PlanEditSubmitResult> {
    return dispatchRevision(planId, prompt, ctx);
  },

  /**
   * REVISE the plan a CONVERSATION is waiting on (MOTIR-7945) — the session's
   * submit routes a turn here when the session's most recent undecided plan is
   * `planned`, so a further turn changes that plan instead of opening a second
   * one beside it. `intent` is the session's accumulated intent.
   *
   * ⚠️ NOT A FORK of {@link submitRevise}: both run `dispatchRevision`, so the
   * consent flag, the onboarding marker, the code and repository context, the
   * cheap refusals and the acquire-after-submit order stay in ONE place. The
   * caller binds the turn to the session afterwards.
   */
  async submitSessionRevision(
    planId: string,
    intent: string,
    ctx: ProjectContext,
  ): Promise<PlanEditSubmitResult> {
    return dispatchRevision(planId, intent, ctx);
  },

  /**
   * Submit a RESUME of a failed walk (Story MOTIR-7905 · MOTIR-7916): a `plan` job carrying
   * `resume: { planId, fromJobId }`, which motir-ai continues from the plan's own persisted
   * state (MOTIR-7910). It opens NO plan — the caller re-binds the SAME plan to the returned
   * job (`planSessionResumeService`), submit FIRST and bind SECOND exactly as `submitRevise`
   * does, because the job id does not exist until motir-ai answers. Metered, so typed errors
   * (out of credits, unreachable, a motir-ai refusal of the resume) propagate with nothing
   * written.
   */
  async submitResume(
    planId: string,
    fromJobId: string,
    ctx: ProjectContext,
    // The plan's `createdById` (MOTIR-8741): a resume speaks the plan STARTER's language,
    // not the resumer's. The caller already read the plan to pre-check the resume.
    starterUserId: string | null,
  ): Promise<{ jobId: string }> {
    await assertCanPlan(ctx);
    const { tenant, planningFields } = await buildPlanningJobContext(ctx, planId, starterUserId);
    return submitJob(
      'plan',
      tenant,
      // NO `planId` in the context: that key is what makes a job a REVISION on the far side,
      // and a resume continues a WALK — the plan it continues rides `resume`, not the bag.
      planningFields,
      { userId: ctx.userId },
      { resume: { planId, fromJobId } },
    );
  },

  streamAugment(jobId: string, coreProjectId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId, coreProjectId);
  },

  streamRevise(jobId: string, coreProjectId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId, coreProjectId);
  },
};

/** The body {@link aiPlanEditsService.submitRevise} documents — shared with
 *  `submitSessionRevision` so the two can never drift (MOTIR-7945). */
async function dispatchRevision(
  planId: string,
  prompt: string,
  ctx: ProjectContext,
): Promise<PlanEditSubmitResult> {
  await assertCanPlan(ctx);

  // Resolved through the service, so a plan in ANOTHER project is refused as
  // NOT-FOUND rather than as forbidden: `getPlan` asserts browse access on the
  // plan's own project, and a caller who cannot browse it must not learn it
  // exists (the no-existence-leak posture the whole tree keeps).
  const plan = await plansService.getPlan(planId, ctx);
  if (plan.projectId !== ctx.projectId) throw new PlanNotFoundError(planId);

  const actor: PlanRevisionAgentActor = {
    source: 'native',
    harness: 'Motir',
    model: null,
  };

  // ── TWO CHEAP REFUSALS BEFORE A JOB IS SPENT ─────────────────────────────
  // The ACQUIRE below is the authority and re-checks both under the plan row
  // lock. These are here so the two refusals a reviewer actually hits — a
  // decided plan, and a plan somebody is already revising — cost nothing: a
  // job dispatched and then refused is an AI call the org paid for and nobody
  // can read.
  if (plan.status !== 'generating' && plan.status !== 'planned') {
    throw new PlanNotEditableError(planId, plan.status);
  }
  const held = await plansService.readRevisionLease(planId, ctx);
  if (held) throw new PlanRevisionInFlightError(planId, held.heldBy, held.expiresAt);

  // The tenant and every planning-context field come from the ONE builder every planning
  // submit shares (consent flag, onboarding marker, code and repository context). A
  // revision is the OTHER submit that bypasses `submitPlanEditJob` — deliberately, because it
  // holds a lease and must not open a second plan — so it has to call the builder itself or
  // never gets the fields at all (MOTIR-4343, MOTIR-4736). Nothing to unwind on a failed
  // submit: the lease is taken BELOW, so a submit that never returned a job id has left the
  // plan exactly as it found it.
  // The plan STARTER's language (MOTIR-8741): a reviewer revising someone else's plan
  // must not flip its replies and explanations into their own.
  const { tenant, planningFields } = await buildPlanningJobContext(ctx, planId, plan.createdById);
  const { jobId } = await submitJob(
    // ONE planning kind (ADR §6 step 2). `context.planId` below is what makes this a REVISION
    // on the far side — `readerForPlan`'s first arm — so its silent loss would route every
    // revision to the project arm. The PLAN is the target: `planId` is the only address a
    // revision has, its proposals having no `MOTIR-<n>` until somebody approves them.
    'plan',
    tenant,
    { planId, prompt, ...planningFields },
    { userId: ctx.userId },
  );

  // ⚠️ ACQUIRE AFTER THE SUBMIT, because the acquire is what BINDS the plan to
  // this job (`sourceJobId`) and the id does not exist until motir-ai answers.
  // Folding the bind into the acquire is what keeps them atomic — a plan leased
  // to a job the internal seams cannot resolve would be worse than either
  // failure alone — and it is why there is no separate bind door.
  //
  // The residual race, stated rather than hidden: two reviewers pressing Send
  // in the same instant both dispatch, and the loser's acquire is REFUSED. Its
  // job is then orphaned — it resolves no plan by `sourceJobId` and fails its
  // first callback, writing nothing. That costs one wasted AI call on a genuine
  // simultaneous race, which the pre-check above already removes for every
  // non-simultaneous one, and it is the cheaper end of the trade: the
  // alternative holds a lease over a job that may never exist.
  await plansService.acquireRevisionLease(planId, ctx, actor, { jobId });
  return { jobId, planId };
}

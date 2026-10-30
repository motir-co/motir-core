import { submitJob, streamJob } from '@/lib/ai/motirAiClient';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import {
  resolveProjectCodeContext,
  resolvePlanningCodeContext,
  withCodeFreshness,
} from '@/lib/ai/codeContext';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import {
  RECORD_PLANNING_MISTAKES_CONTEXT_FIELD,
  resolveRecordPlanningMistakesForJob,
} from '@/lib/ai/lessonCapture';
import { ONBOARDING_CONTEXT_FIELD, onboardingContextFor } from '@/lib/ai/onboardingContext';
import { routeOnboardingContextFor } from '@/lib/ai/routeOnboardingContext';
import { resolveProjectRepoContext } from '@/lib/ai/projectRepoContext';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { resolveTenantLanguages } from '@/lib/ai/tenantLanguages';
import type { JobStreamEvent } from '@/lib/ai/types';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

import { planRepository } from '@/lib/repositories/planRepository';
import { plansService, type PlanProviderRetryInput } from '@/lib/services/plansService';
import { NoPlanForJobError } from '@/lib/plans/errors';
import { resolveCorrectionKeyRefs, resolveKeyRefs } from '@/lib/plans/keyRefs';
import { NATIVE_PLANNER_HARNESS } from '@/lib/ai/plannerTenantBug';
import type { RevisionReasonBranch } from '@/lib/plans/revisionReason';
import type {
  CorrectProposalInput,
  PlanItemDto,
  ProposalLinkWarningDto,
  ProposalRescopeWarningDto,
  PlanNarrationDto,
  PlanCodeReadDto,
  PlanStepDto,
  PlanStepProviderWaitDto,
  PlanStepKindDto,
  PlanWithItemsDto,
  ProposalInput,
  UpdateProposalInput,
} from '@/lib/dto/plans';
import type { PlanRevisionAgentActor } from '@/lib/services/planRevisionsService';
import { projectAccessService } from '@/lib/services/projectAccessService';

// Issue-tree generation, motir-core side (Subtask 7.4.4 · MOTIR-846). The thin
// seam between the planning workspace and the motir-ai `generate_tree` handler
// (7.4.2 · MOTIR-844), built ON the 7.21 Plan substrate (MOTIR-1336): generation
// EMITS `add` PlanItem PROPOSALS into a `Plan`; nothing materializes here — a real
// work-item tree appears only when the user APPROVES the plan (7.21 approve/
// materialize). motir-core owns NO planning logic: it opens the Plan, submits the
// job (the 7.1.5 client mints the §4b job-scoped read-back token internally),
// relays the job's SSE stream to the browser, and exposes the internal append seam
// the handler calls back into. The browser reaches motir-ai ONLY through this
// service + its routes (the open-core invariant — the client is `server-only`).
//
// Plan ↔ job binding: the Plan's `sourceJobId` is set to the submitted jobId at
// `createPlan`, so the internal seam resolves "the job's Plan" from the jobId the
// handler already holds — no planId threading through motir-ai, no JobContextBag
// change. The lookup is workspace-scoped, so a job token for one tenant can never
// append to another's plan (NoPlanForJobError → 404, the no-leak posture).
//
// 4-layer (CLAUDE.md): this service orchestrates `plansService` (the 7.21 owner of
// the Plan transactions + grammar/ref validation) + `planRepository` for the
// job→plan read; it re-uses `addProposals`' invariants rather than re-implementing
// them. The routes are thin transports over these methods.

export interface StartGenerationInput {
  /** Optional seed prompt for the generation job (the planning workspace's
   *  framing of what to generate); rides in the job context bag. */
  prompt?: string | null;
  /** Optional human label / summary stamped on the opened Plan. */
  title?: string | null;
  summary?: string | null;
}

export const aiGenerationService = {
  /**
   * THE ROUTING RUN (MOTIR-4769) — dispatched when the universal plan window
   * OPENS on a project whose first plan has never been approved.
   *
   * It asks `motir-ai` ONE question (MOTIR-4767): can this project be planned
   * from what it has, and if not, which onboarding does the user go to? The run
   * HALTS on every outcome — `continue` included — so it proposes nothing,
   * closes no plan and needs no `Plan` row. That absence is the point rather
   * than an omission: `startGeneration` opens a `generating` Plan bound to its
   * job, and a routing run would leave one of those sitting `generating` for a
   * job that was never going to write to it.
   *
   * ⚠️ THIS IS THE ONLY DISPATCH THAT ASKS. `startGeneration` — the door every
   * later ask goes through, and the one the migrate wizard's own generate step
   * reaches — must never set the flag:
   *
   *   · the WIZARD's run is also a first plan over an empty tree, so a verdict
   *     there would send a user who is already in onboarding back to its start;
   *   · and `onboardingRanAt` is stamped on the first plan APPROVED, so it is
   *     still null while a `continue` project does its actual planning. A
   *     marker-derived flag on `startGeneration` would route every ask that user
   *     made, forever, and plan nothing.
   *
   * The helper still refuses to set it for an established project: there is
   * nothing to route such a project to.
   */
  async startRoutingRun(ctx: ProjectContext): Promise<{ jobId: string }> {
    // The same gate generation runs behind: deciding a user's route is a
    // planning act on their project, not a free read.
    await projectAccessService.assertPermission(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      'ai:plan',
    );
    const { organizationId, isMeta, internalBilling } = await resolveTenantOrg({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    // The same two context reads generation makes, and for the same reason: the
    // verdict is a judgement about the code and the backlog, so a run that could
    // not SEE them would answer a different question from the one being asked.
    // ⚠️ AND IT CARRIES THE DRIFT, NOT ONLY `indexed` (MOTIR-4857). The verdict
    // is asked whether this project can be planned from what is here, and a
    // graph three commits behind and one three hundred behind are the same fact
    // to a boolean. `withCodeFreshness` joins the project's freshness onto the set.
    //
    // ⚠️ BOTH HALVES ARE NOW THE SAME SET (MOTIR-4653). This used to join a
    // PROJECT-scoped freshness onto a WORKSPACE-scoped grant list, so the
    // freshness side was a strict SUBSET and a repository the project had not
    // been given carried no drift rather than a fabricated one.
    // `resolveProjectCodeContext` reads the project's configured set now, so the two
    // agree by construction: the join is a join rather than a reconciliation, and
    // there is no longer a member of the outer set it can fail to cover.
    const code = await withCodeFreshness(
      await resolveProjectCodeContext({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
      }),
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    // ⚠️ AND THE MISSING GRAPH IS REPAIRED, NOT ONLY REPORTED (Story MOTIR-4753 ·
    // MOTIR-4826). A repository can be CONNECTED and unindexed — an index that
    // failed, one still running, or somebody who connected their repository and
    // opened the plan window a minute later — and in that state the verdict is
    // about to be told there is nothing to read. Telling it, and doing nothing,
    // would leave the person waiting for a graph nobody asked for.
    //
    // The shipped, idempotent workspace sweep is the whole mechanism: it reads
    // the succeeded-index ledger and enqueues ONLY the repositories missing one,
    // so an index already running or already succeeded enqueues nothing and no
    // second guard is needed here.
    //
    // ⚠️ BEST-EFFORT, DELIBERATELY. This repairs a cause; it is not what the
    // caller asked for. A sweep that fails must not fail the routing run — the
    // verdict is still worth having, and the person still needs an answer.
    //
    // ⚠️ AND IT DECIDES NOTHING. `motir-core` does not read `indexed` back to
    // choose a destination; the fact goes on the wire above and the route is the
    // planner's (MOTIR-4828). A branch here would put the routing decision back
    // where five of this story's cards took it out of.
    if (code?.repos.some((repo) => !repo.indexed)) {
      try {
        await codeGraphIndexService.sweepReposMissingFirstIndex({
          workspaceId: ctx.workspaceId,
        });
      } catch (err) {
        console.error(
          'startRoutingRun could not enqueue a first index for workspace; the verdict still runs:',
          ctx.workspaceId,
          err,
        );
      }
    }
    const repositories = await resolveProjectRepoContext(ctx.projectId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    // ⚠️ SENT UNCONDITIONALLY, like every other planning submit (MOTIR-4343).
    // The routing run plans nothing, which is exactly why it would be easy to
    // think it owes no consent flag — but it is a planning job on the planner
    // and an ABSENT field reads on the far side as ON, so omitting it would
    // capture mistakes for a project that switched capture off.
    const recordPlanningMistakes = await resolveRecordPlanningMistakesForJob(ctx.projectId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    // The two languages (MOTIR-8741): reached only from a click, so the clicker is
    // the person who started it.
    const languages = await resolveTenantLanguages({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
    });
    return submitJob(
      'plan',
      {
        organizationId,
        isMeta,
        internalBilling,
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        projectKey: ctx.project.identifier,
        ...languages,
      },
      {
        // No prompt: nothing has been asked for yet. That is what makes this a
        // routing question rather than a planning one.
        prompt: null,
        [ONBOARDING_CONTEXT_FIELD]: onboardingContextFor(ctx.project),
        [RECORD_PLANNING_MISTAKES_CONTEXT_FIELD]: recordPlanningMistakes,
        ...routeOnboardingContextFor(ctx.project),
        ...(code ? { code } : {}),
        ...(repositories ? { repositories } : {}),
      },
      { userId: ctx.userId },
    );
  },

  // Open a `generating` Plan + submit the `generate_tree` job for the actor's
  // active project; return the ids the surface needs ({ jobId, planId }). The job
  // is submitted FIRST so the Plan can bind to it via `sourceJobId` — and so a
  // submit failure (unreachable / out-of-credits) leaves NO orphan Plan behind.
  // The out-of-credits refusal propagates as a typed MotirAiOutOfCreditsError the
  // route maps to a distinct 402 (7.2 metering), consumable by the 7.4.9 UI.
  async startGeneration(
    ctx: ProjectContext,
    input: StartGenerationInput = {},
  ): Promise<{ jobId: string; planId: string }> {
    // `ai:plan` (Story MOTIR-2291 · Subtask MOTIR-2358). Generation is the
    // heaviest planning job the product runs — it builds a whole tree from
    // nothing — and it reached no project gate at all.
    await projectAccessService.assertPermission(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      'ai:plan',
    );
    const { organizationId, isMeta, internalBilling } = await resolveTenantOrg({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    // The workspace's connected repo SET (7.10.15 · MOTIR-1598) — the code half
    // of the context bag, resolved from the persisted 891 grant mirror (a DB
    // read; no GitHub round-trip on the submit path). `undefined` (no
    // installation / no grants) OMITS `context.code` entirely, so a start-fresh
    // project's envelope is byte-identical to a code-less one.
    // ⚠️ THE PLANNING PRODUCER, not the bare grant list (MOTIR-4604). It carries
    // each repo's freshness VERDICT, the REASON it is behind and an explicit
    // IN-FLIGHT flag, and it ENQUEUES a refresh where one can actually run —
    // through the shipped debounced path, never awaited. `undefined` still means
    // "no connected repo", so `context.code` is omitted exactly as before.
    const code = await resolvePlanningCodeContext({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
    });
    // The PROJECT's repository SET (MOTIR-3044) — beside the workspace grant list
    // above, never merged into it. Resolved on the same pre-submit slot and for
    // the same reason: the set read opens its own workspace context, so it cannot
    // run inside a transaction. `undefined` (a project with no rows) OMITS
    // `context.repositories` entirely, so such a project's envelope is
    // byte-identical to one built before this field existed.
    const repositories = await resolveProjectRepoContext(ctx.projectId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    // May this project's planner record what it got wrong (MOTIR-3350 producer ·
    // MOTIR-4343 the gap)? Resolved HERE rather than inherited, because THIS
    // submit is one of the two that call `submitJob` directly instead of going
    // through `aiPlanEditsService`'s `submitPlanEditJob` — which is where the
    // other four resolve it. That bypass IS the defect: from the setting's own
    // first commit (2026-08-25, MOTIR-3331) a project that switched capture off
    // still had its first generation captured, because an absent field reads on
    // the far side as "the producer predates this contract", i.e. as ON.
    const recordPlanningMistakes = await resolveRecordPlanningMistakesForJob(ctx.projectId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    // The two languages (MOTIR-8741): a generation starts from a click, so the
    // clicker is the person who started the plan.
    const languages = await resolveTenantLanguages({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
    });
    const tenant = {
      organizationId,
      isMeta,
      internalBilling,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      projectKey: ctx.project.identifier,
      ...languages,
    };
    const { jobId } = await submitJob(
      // ONE planning kind (ADR `session-model.md` §6 step 2). This submit names no
      // target at all, which is exactly how motir-ai reads it as *plan the
      // project* — the arm `readProjectTarget` serves.
      'plan',
      tenant,
      {
        prompt: input.prompt ?? null,
        // The AI-drafted-explanations opt-in (Story 7.4 · MOTIR-850) crosses the
        // 7.1 boundary in the job envelope — motir-ai's `generate_tree` handler
        // reads it from `context.generateExplanations` and, when true, drafts an
        // `ai_draft` `explanationMd` per proposal (MOTIR-1468). motir-ai never
        // reads motir-core config directly; the flag rides the envelope.
        generateExplanations: ctx.project.aiGenerateExplanations,
        // ALWAYS present, `false` when off — never spread-conditionally like
        // `code` and `repositories` below. Those two use ABSENCE to mean "this
        // workspace/project has none"; here absence means "the producer predates
        // the field" and `mayRecordPlanningMistakes` reads it as ON, so omitting
        // it when the setting is off would silently keep capturing. The key is
        // the exported constant, not a literal: there is no shared type across
        // the boundary and a typo is not a type error.
        [RECORD_PLANNING_MISTAKES_CONTEXT_FIELD]: recordPlanningMistakes,
        // Is this the project's FIRST plan (MOTIR-4736)? Read off the marker the
        // service already holds — `ProjectContext.project` is a `ProjectDTO` and
        // `onboardingRanAt` rides the base DTO, so this costs no round-trip and
        // no caller passes it by hand. THIS is the submit the migrate wizard's
        // GENERATE step reaches (`migrateOnboardingService`), which is the path
        // motir-ai's empty-tree inference got wrong: the wizard's optional import
        // has already written a backlog by the time generation runs.
        //
        // ALWAYS present, `false` once the marker is stamped — never spread
        // conditionally: absence means "the producer predates this field" and
        // sends motir-ai back to inferring it from the tree.
        [ONBOARDING_CONTEXT_FIELD]: onboardingContextFor(ctx.project),
        ...(code ? { code } : {}),
        ...(repositories ? { repositories } : {}),
      },
      { userId: ctx.userId },
    );
    const plan = await plansService.createPlan(
      ctx.projectId,
      {
        title: input.title ?? null,
        summary: input.summary ?? null,
        sourceJobId: jobId,
        // Its own session, of origin `generation` (AMENDMENT 17 §4–§5; MOTIR-6022):
        // a generation has no conversation, and every plan belongs to one.
        session: { origin: 'generation' },
        // WHO ASKED (MOTIR-2986). This seam is reached ONLY from a request path
        // — somebody clicked Generate — so the acting user IS the requester and
        // recording them is honest. Passed explicitly rather than defaulted in
        // the service, because the cadence path shares that service and its
        // acting user is a substituted credential, not a requester.
        createdById: ctx.userId,
        // WHO WROTE it (MOTIR-2996). Motir's own generator authored this plan,
        // so the plan RECORDS `native · Motir` instead of leaving the surface to
        // infer it from `sourceJobId != null` — an inference that answers WHICH
        // JOB, and is a proxy for WHO only while a motir-ai job is the sole
        // non-MCP writer of a `Plan`.
        //
        // SERVER-SET at the write seam, exactly as `create_plan` fixes `mcp`
        // (`agent-authored-plans.md` Q3: the source is never a caller field) —
        // note there is nothing in `input` this could be read from, and nothing
        // should be added.
        //
        // `authorModel` is not passed HERE because core does not know it yet:
        // motir-ai resolves the planning model per job (`PlanningRun.model`)
        // after this plan exists. It arrives on the job's `final: true` append
        // and `markPlanned` records it then (Bug MOTIR-8420). Recorded is not
        // exposed: `work-item-provenance.md` Decision 6 strips a native model
        // at the read boundary (`redactNativeActor`), so the value is for
        // internal analysis only.
        authorSource: 'native',
        authorHarness: 'Motir',
      },
      ctx,
    );
    return { jobId, planId: plan.id };
  },

  // The live channel the 7.4.9 generation UI subscribes to: relay the motir-ai
  // `generate_tree` job stream so `add` PlanItems show up LIVE as the handler
  // appends them. A transport failure throws a typed MotirAiError before the
  // first yield (the route maps it to an HTTP status); the stream ends when
  // motir-ai closes it on a terminal state. The terminal-failure REASON (e.g.
  // out-of-credits) is appended by the stream ROUTE via `failureReasonFrame`.
  streamGeneration(jobId: string, coreProjectId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId, coreProjectId);
  },

  // The INTERNAL append seam motir-ai's handler calls (replaces the whole-delta
  // `commitPlanDelta`): append a batch of proposals to the job's `Plan` via the
  // 7.21 `addProposals`, and — when the frontier is complete (`final`) — mark the
  // plan `planned`. Creates NO WorkItem and sets no status on the tree. Returns the
  // created PlanItem ids IN APPEND ORDER — the stable temp-ref keys the handler
  // reuses for intra-plan parent/blocker refs. The plan is resolved by `sourceJobId`
  // (workspace-scoped → NoPlanForJobError/404 cross-tenant); `addProposals` then
  // re-asserts edit access + the `generating` status under its own row lock.
  /**
   * RECORD WHY the shipped planner's REVISE_PLAN pass had to change a plan
   * (Story MOTIR-5543 · Subtask MOTIR-6087) — the internal door onto
   * `plansService.recordRevisionClassification`.
   *
   * ⚠️ THE PLAN IS THE JOB'S, and the `planId` the caller may send is a
   * CROSS-CHECK rather than the address. This service's own header states the
   * binding — *"the internal seam resolves 'the job's Plan' from the jobId the
   * handler already holds — no planId threading through motir-ai"* — and the
   * posture that comes with it is the one `log-bug` spells out: a foreign plan
   * should be UNEXPRESSIBLE rather than refused. Resolving from the job keeps
   * that true, and a mismatched `planId` is answered with the same
   * {@link NoPlanForJobError} a foreign job gets, so the route leaks nothing
   * about whether the plan exists.
   *
   * Pinned to the TOKEN's project as well as its workspace, exactly as
   * `aiWorkItemsService.filePlannerBug` is: a token minted for project A may not
   * record on a job whose plan belongs to B.
   *
   * The actor is the NATIVE planner triple — the same one the planner's own bug
   * filing stamps — so the internal record says Motir classified this, and the
   * model is the run's own self-reported string.
   */
  async recordRevisionReason(
    input: {
      jobId: string;
      planId?: string | null;
      branch: RevisionReasonBranch;
      evidenceMd: string;
      planningBugId?: string | null;
      model?: string | null;
    },
    auth: { ctx: ServiceContext; projectId: string },
  ): Promise<{ revisionId: string; planId: string; branch: RevisionReasonBranch }> {
    const { ctx, projectId } = auth;
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findBySourceJobId(input.jobId, ctx.workspaceId, tx),
    );
    if (!plan || plan.projectId !== projectId) throw new NoPlanForJobError(input.jobId);
    // The cross-check. Same error as a foreign job: a caller that guessed a plan
    // id learns nothing from the difference.
    if (input.planId && input.planId !== plan.id) throw new NoPlanForJobError(input.jobId);

    const model = input.model?.trim() ?? '';
    const recorded = await plansService.recordRevisionClassification(
      {
        planId: plan.id,
        branch: input.branch,
        evidenceMd: input.evidenceMd,
        planningBugId: input.planningBugId ?? null,
        actor: {
          source: 'native',
          harness: NATIVE_PLANNER_HARNESS,
          model: model === '' ? null : model,
        },
      },
      ctx,
    );
    return { revisionId: recorded.revisionId, planId: plan.id, branch: recorded.branch };
  },

  /**
   * RENEW THE JOB'S REVISION LEASE (Bug MOTIR-8523) — the hosted revision's heartbeat.
   *
   * Core takes the lease when it submits a revision job (`acquireRevisionLease` with
   * the job's id), and the lease lapses `PLAN_REVISION_LEASE_MS` (ten minutes) after the
   * trail's latest row. A hosted revision's conversation and its author sessions can
   * run longer than that without writing the trail, so motir-ai's worker calls this on
   * a timer for as long as the job runs, and stops when the job ends. A job that dies
   * stops calling, and the lease lapses as before.
   *
   * Resolved like every seam in this family: the plan is the JOB's (`sourceJobId`),
   * and `planId` is a cross-check only. The renew itself is
   * {@link plansService.renewRevisionLease} scoped to this job, so it never re-takes a
   * lapsed lease and never renews a hold somebody else took: both answer
   * `renewed: false` and write nothing.
   */
  async renewRevisionLeaseForJob(
    input: { jobId: string; planId?: string | null; model?: string | null },
    auth: { ctx: ServiceContext; projectId: string },
  ): Promise<{ planId: string; renewed: boolean; expiresAt: string | null }> {
    const { ctx, projectId } = auth;
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findBySourceJobId(input.jobId, ctx.workspaceId, tx),
    );
    if (!plan || plan.projectId !== projectId) throw new NoPlanForJobError(input.jobId);
    if (input.planId && input.planId !== plan.id) throw new NoPlanForJobError(input.jobId);

    const model = input.model?.trim() ?? '';
    const renewed = await plansService.renewRevisionLease(
      plan.id,
      ctx,
      { source: 'native', harness: NATIVE_PLANNER_HARNESS, model: model === '' ? null : model },
      { jobId: input.jobId },
    );
    return {
      planId: plan.id,
      renewed: renewed.renewed,
      expiresAt: renewed.expiresAt ? renewed.expiresAt.toISOString() : null,
    };
  },

  /**
   * The hosted planner's in-flight STEP (Story MOTIR-7820 · Subtask MOTIR-7824):
   * resolve the JOB's plan — never a caller-supplied one — and make the one step
   * write `report_plan_step` makes. `planId` is a cross-check only, and a
   * mismatch is the same `NoPlanForJobError` as a foreign job, exactly as
   * {@link recordRevisionReason}. Everything about what may be recorded (the
   * grant, the `generating` guard, the target rules, the clock) is the step
   * store's, in `plansService`.
   */
  async recordPlanStepForJob(
    input: {
      jobId: string;
      planId?: string | null;
      sessionKey: string;
      step?: PlanStepKindDto | 'end';
      targetRef: string | null;
      /** The session's own sentences (MOTIR-8062) — sent INSTEAD of `step`. */
      narration?: string[];
      /** The session's provider-retry wait (MOTIR-9619) — sent INSTEAD of `step`. */
      providerRetry?: PlanProviderRetryInput;
      /** The session's code reads (MOTIR-10122) — sent INSTEAD of `step`. */
      codeReads?: unknown[];
    },
    auth: { ctx: ServiceContext; projectId: string },
  ): Promise<
    | { planId: string; step: PlanStepKindDto | 'end'; inFlight: PlanStepDto | null }
    | { planId: string; narration: PlanNarrationDto[] }
    | { planId: string; codeReads: PlanCodeReadDto[] }
    | { planId: string; providerWait: PlanStepProviderWaitDto | null }
  > {
    const { ctx, projectId } = auth;
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findBySourceJobId(input.jobId, ctx.workspaceId, tx),
    );
    if (!plan || plan.projectId !== projectId) throw new NoPlanForJobError(input.jobId);
    if (input.planId && input.planId !== plan.id) throw new NoPlanForJobError(input.jobId);

    const result = await plansService.reportPlanStep(
      plan.id,
      {
        sessionKey: input.sessionKey,
        targetRef: input.targetRef,
        ...(input.step !== undefined ? { step: input.step } : {}),
        ...(input.narration !== undefined ? { narration: input.narration } : {}),
        ...(input.providerRetry !== undefined ? { providerRetry: input.providerRetry } : {}),
        ...(input.codeReads !== undefined ? { codeReads: input.codeReads } : {}),
      },
      ctx,
    );
    if (result.kind === 'narration') return { planId: plan.id, narration: result.narration };
    if (result.kind === 'codeReads') return { planId: plan.id, codeReads: result.codeReads };
    if (result.kind === 'providerRetry') {
      return { planId: plan.id, providerWait: result.providerWait };
    }
    return {
      planId: plan.id,
      step: input.step!,
      inFlight: result.kind === 'step' ? result.step : null,
    };
  },

  async appendProposals(
    jobId: string,
    proposals: ProposalInput[],
    ctx: ServiceContext,
    opts: {
      final?: boolean;
      productName?: string | null;
      /** The planner's briefing (MOTIR-8157) — written on a final append's close, a generation's or a revision's (MOTIR-8230). */
      summary?: string | null;
      /**
       * The plan's title (MOTIR-8164) — on ANY append of a generation, written
       * while the plan is `generating`; ignored on a revision or a later status.
       */
      title?: string | null;
      revision?: boolean;
      actor?: PlanRevisionAgentActor;
      /**
       * The job's resolved planning model (Bug MOTIR-8420) — recorded on the
       * plan by the close of a final append, a generation's or a revision's.
       */
      authorModel?: string | null;
    } = {},
  ): Promise<{
    planId: string;
    planItemIds: string[];
    planned: boolean;
    released?: boolean;
    warnings?: ProposalLinkWarningDto[];
    rescopeWarnings?: ProposalRescopeWarningDto[];
  }> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findBySourceJobId(jobId, ctx.workspaceId, tx),
    );
    if (!plan) throw new NoPlanForJobError(jobId);

    // THE PLAN'S TITLE (Story MOTIR-8161 · Subtask MOTIR-8164), written FIRST so
    // it is settled before this append's proposals and — on the final append —
    // before the briefing is written by the close below. Through
    // `correctPlanBrief`, the door behind the MCP `update_plan` (MOTIR-4637), so
    // a rename lands on the plan's trail as the same `brief_edited` row a
    // person's correction does, rather than as an untraced column write.
    //
    // ⚠️ ONLY WHILE THE PLAN IS `generating`. A revision of a `planned` plan
    // RE-OPENS it (Bug MOTIR-8208), so its appends see `generating` and its title
    // is re-checked exactly as the first generation's was; a plan that has left
    // `generating` is a reviewer's (or a record's) — a title on that append is
    // IGNORED rather than refused, so the proposals it carries still land. A title
    // equal to the stored one writes nothing: a no-op is not worth a trail row.
    const title = opts.title?.trim();
    if (title && plan.status === 'generating' && title !== plan.title) {
      await plansService.correctPlanBrief(plan.id, { title }, ctx);
    }

    let createdIds: string[] = [];
    // The item links this append KEPT that would ship dead (MOTIR-10104), handed
    // back to the planner on every return below — present only when there is one.
    // …and the `modify`s approve will send back from built work (MOTIR-10106).
    let linkWarnings: {
      warnings?: ProposalLinkWarningDto[];
      rescopeWarnings?: ProposalRescopeWarningDto[];
    } = {};
    if (proposals.length > 0) {
      // A ref written as a `<PREFIX>-<n>` KEY becomes the work item's id HERE, at
      // the append, or the append is refused `dangling` naming the key
      // (MOTIR-7983 — MOTIR-3576's decision, which only the MCP door applied).
      // Stored verbatim, a key reached the close as a string no id matches and
      // threw away the whole planning run that wrote it.
      const resolved = await resolveKeyRefs(proposals, ctx);
      const result = await plansService.addProposals(plan.id, resolved, ctx, {
        revision: opts.revision,
      });
      // One id per proposal, in input order, as the service reports it — a
      // second `modify` of one card MERGES into the row the plan already holds
      // (AMENDMENT 18 §2), so the batch's ids are no longer the last N rows.
      createdIds = result.appendedItemIds;
      linkWarnings = {
        ...(result.warnings ? { warnings: result.warnings } : {}),
        ...(result.rescopeWarnings ? { rescopeWarnings: result.rescopeWarnings } : {}),
      };
    }

    // ⚠️ `final` MEANS *THIS PASS IS OVER*, and what that costs depends on which
    // pass it was (Story MOTIR-3595 · Subtask MOTIR-3598). A GENERATION's last
    // append closes its plan into the review queue. A REVISION's closes the plan
    // it RE-OPENED the same way — through `markPlanned`, with the briefing — and
    // ends the lease (`plansService.closeRevision`, Bug MOTIR-8208). One flag, one
    // meaning, dispatched on which pass is running rather than on a second field,
    // so a revision that touches nothing sends the same
    // `{ proposals: [], final: true }` shape MOTIR-3193's CLOSE already sends.
    if (opts.revision) {
      if (!opts.final) {
        return {
          planId: plan.id,
          planItemIds: createdIds,
          planned: false,
          released: false,
          ...linkWarnings,
        };
      }
      const closed = await plansService.closeRevision(plan.id, ctx, opts.actor ?? EMPTY_ACTOR, {
        summary: opts.summary ?? null,
        authorModel: opts.authorModel ?? null,
        trailDiff: { proposalCount: createdIds.length },
      });
      return {
        planId: plan.id,
        planItemIds: createdIds,
        planned: closed.planned,
        released: closed.released,
        ...linkWarnings,
      };
    }

    let planned = false;
    if (opts.final) {
      // `productName` (MOTIR-1554/1551) is persisted onto the Plan here, on the
      // final append — it is later consumed at approve to name the draft project.
      //
      // ⚠️ `planned` IS READ OFF THE CLOSE, NOT ASSERTED (MOTIR-4124). A close
      // over a plan that received no proposals DISCARDS it, so a hardcoded
      // `true` here would tell the producer its output reached a reviewer when
      // it never will.
      //
      // The briefing (`summary`, MOTIR-8157) rides the same close: written in the
      // write that moves the plan out of `generating`, so it is on the plan the
      // moment a reviewer can see it, and a refused write leaves it `generating`.
      const closed = await plansService.markPlanned(plan.id, ctx, {
        productName: opts.productName ?? null,
        summary: opts.summary ?? null,
        authorModel: opts.authorModel ?? null,
      });
      planned = closed.status === 'planned';
    }

    return { planId: plan.id, planItemIds: createdIds, planned, ...linkWarnings };
  },

  // The INTERNAL generation-time DEEPEN seam (7.4.4a · MOTIR-1441): PATCH one
  // already-appended `add` proposal on the job's `generating` Plan — Phase 2 of
  // the titles-first strategy (MOTIR-844/845), where each title-only `add`'s
  // `descriptionMd` (+ type/priority/sizing) is filled in one at a time, BEFORE
  // the frontier is marked `planned`. Resolves the plan by `sourceJobId`
  // (workspace-scoped → NoPlanForJobError/404 cross-tenant), then calls the 7.21
  // `deepenProposal`, which re-asserts edit access + the `generating` status +
  // the add-only / non-empty-title / sizing invariants under its own row lock.
  // Creates NO WorkItem and leaves the plan `generating`. Returns the patched
  // PlanItem (the handler only needs the confirmation, not the whole plan).
  async patchProposal(
    jobId: string,
    planItemId: string,
    input: UpdateProposalInput,
    ctx: ServiceContext,
  ): Promise<{
    planId: string;
    item: PlanItemDto;
    warnings?: ProposalLinkWarningDto[];
    rescopeWarnings?: ProposalRescopeWarningDto[];
  }> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findBySourceJobId(jobId, ctx.workspaceId, tx),
    );
    if (!plan) throw new NoPlanForJobError(jobId);
    const result = await plansService.deepenProposal(plan.id, planItemId, input, ctx);
    // `deepenProposal` throws `PlanItemNotFoundError` if the item isn't in the
    // plan, so by here the patched item is guaranteed present in the returned set.
    const item = result.items.find((i) => i.id === planItemId)!;
    // The links the deepen KEPT that would ship dead (MOTIR-10104).
    return {
      planId: plan.id,
      item,
      ...(result.warnings ? { warnings: result.warnings } : {}),
      ...(result.rescopeWarnings ? { rescopeWarnings: result.rescopeWarnings } : {}),
    };
  },

  // The INTERNAL PROPOSAL READ (Story MOTIR-3595 · Subtask MOTIR-3598) — what
  // the plan the job is revising currently PROPOSES.
  //
  // ⚠️ IT IS WHAT MAKES A REVISION A REVISION. A revising pass starts from
  // proposals that already exist and must present them to the model as the
  // SUBJECT; motir-ai's in-flight registry is populated by the pass's own output
  // and is EMPTY at the start of a job, so a handler with no read here reasons
  // about an empty tree and proposes a plan from scratch — which is re-planning,
  // the thing this story replaces. Every existing internal read answers about the
  // COMMITTED tree, and a proposal is not in it.
  //
  // Resolved by `sourceJobId` like every seam beside it, so a job token cannot
  // read another job's plan. Read-only: it creates nothing and changes nothing.
  async readPlanProposals(jobId: string, ctx: ServiceContext): Promise<PlanWithItemsDto> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findBySourceJobId(jobId, ctx.workspaceId, tx),
    );
    if (!plan) throw new NoPlanForJobError(jobId);
    return plansService.getPlan(plan.id, ctx);
  },

  // The INTERNAL CORRECTION seam (Story MOTIR-3595 · Subtask MOTIR-3598) — the
  // SECOND caller of two service methods that have had exactly one
  // (`lib/mcp/tools/authorPlan.ts`). It adds no logic of its own: the structural
  // fields, the ref re-check, the frozen-status refusal and the trail write are
  // all `plansService.correctProposal`'s, unchanged.
  //
  // The plan is resolved from the JOB — `sourceJobId`, workspace-scoped, exactly
  // as the append and deepen seams beside it resolve theirs — never from a
  // caller-supplied plan id. A job token for one tenant therefore cannot correct
  // another's plan (NoPlanForJobError → 404, the no-leak posture), and the route
  // has no plan id to validate because it never receives one.
  async correctProposalForJob(
    jobId: string,
    planItemId: string,
    input: CorrectProposalInput,
    ctx: ServiceContext,
  ): Promise<{
    planId: string;
    item: PlanItemDto;
    warnings?: ProposalLinkWarningDto[];
    rescopeWarnings?: ProposalRescopeWarningDto[];
  }> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findBySourceJobId(jobId, ctx.workspaceId, tx),
    );
    if (!plan) throw new NoPlanForJobError(jobId);
    // The same key resolution the append applies (MOTIR-7983), on every ref a
    // correction can carry — sparse, so an absent list stays absent.
    const resolved = await resolveCorrectionKeyRefs(input, ctx);
    const result = await plansService.correctProposal(plan.id, planItemId, resolved, ctx);
    // `correctProposal` throws `PlanItemNotFoundError` when the item is not on
    // the plan, so by here it is guaranteed present in the returned set.
    const item = result.items.find((i) => i.id === planItemId)!;
    return {
      planId: plan.id,
      item,
      ...(result.warnings ? { warnings: result.warnings } : {}),
      ...(result.rescopeWarnings ? { rescopeWarnings: result.rescopeWarnings } : {}),
    };
  },

  // The INTERNAL WITHDRAW seam (Subtask MOTIR-3598) — the same shape, onto
  // `plansService.withdrawProposal`. A withdraw whose target a sibling still
  // references is REFUSED naming the referrers, exactly as the service already
  // does; this seam does not soften it, and it must not, because cascading would
  // take proposals off the plan nobody asked to withdraw.
  //
  // Returns the plan's REMAINING item count, which is the one thing the caller
  // cannot recompute for itself and the number the rail's header renders.
  async withdrawProposalForJob(
    jobId: string,
    planItemId: string,
    ctx: ServiceContext,
  ): Promise<{ planId: string; itemCount: number }> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findBySourceJobId(jobId, ctx.workspaceId, tx),
    );
    if (!plan) throw new NoPlanForJobError(jobId);
    const result = await plansService.withdrawProposal(plan.id, planItemId, ctx);
    return { planId: plan.id, itemCount: result.items.length };
  },
};

/** A job that names no harness records none, rather than borrowing the plan's
 *  original author — a revision's rows must say who performed THIS act. */
const EMPTY_ACTOR: PlanRevisionAgentActor = { source: null, harness: null, model: null };

import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import {
  aiPlanGateService,
  AI_PLAN_REQUIRED_ESTABLISH_MESSAGE,
  PLAN_UNKNOWN_ESTABLISH_MESSAGE,
} from '@/lib/services/aiPlanGateService';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { productionEnablementService } from '@/lib/services/productionEnablementService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { seedRegistryService } from '@/lib/services/seedRegistryService';
import { SeedResolutionError } from '@/lib/seedRegistry/errors';
import { projectRunnerGroupService } from '@/lib/services/projectRunnerGroupService';
import { fleetRunnerVariableService } from '@/lib/services/fleetRunnerVariableService';
import { fleetGithubOrgAssignmentService } from '@/lib/services/fleetGithubOrgAssignmentService';
import { previewEnablementService } from '@/lib/services/previewEnablementService';
import type { GithubOrgTarget } from '@/lib/github/orgTarget';
import { enqueueCodeGraphIndex } from '@/lib/github/indexEnqueue';
import { getPreplanState } from '@/lib/ai/motirAiClient';
import type { StoredDesignChoice } from '@/lib/projectRepos/designChoiceSeed';
import {
  RepoHostOrgUnavailableError,
  RepoNameTakenOnHostError,
  RepoProvisioningError,
  repoProvisioningClient,
  type ProvisionedRepo,
  type ProvisionRepoInput,
} from '@/lib/github/repoProvisioning';
import {
  AiPlanRequiredError,
  AiPlanUnknownError,
  ProjectRepoNotFoundError,
  ProjectRepoStateTransitionError,
  RealizedRepoAlreadyClaimedError,
} from '@/lib/projectRepos/errors';
import type { ProjectRepoDto, ProjectRepoStateDto } from '@/lib/dto/projectRepos';

// The repo-CREATION primitive (Story MOTIR-1775 · MOTIR-1781) — the service that
// makes a project's planned repositories actually exist.
//
// It is orchestration and nothing else. The three things it composes are all
// shipped, and it adds code to none of them:
//
//   * `projectRepoSetService` owns the rows and the ADR §4.1 state machine
//     (`markCreating` → `attachRealizedRepo` / `markFailed`), each its own short,
//     row-locked transaction.
//   * `repoProvisioningClient` owns every GitHub mechanic (which endpoint, which
//     credential, the 422 collision signal, readiness). It is the boundary the
//     tests fake.
//   * `githubInstallationService.persistProvisionedRepo` + `enqueueCodeGraphIndex`
//     are the shipped mirror-and-index chain. Nothing here re-implements them,
//     and nothing subscribes to a new webhook.
//
// ⚠️ NO TRANSACTION SPANS THE HOST CALLS (ADR §4.2 + the side-effects-outside-tx
// rule). Creating a repository is a network side effect that cannot be rolled
// back — you cannot un-create a repository, and a compensating delete would mean
// destroying something the user can already see to make a report look tidy. So
// each row's outcome is PERSISTED AS IT RESOLVES, and a crash mid-set leaves a
// readable partial state that the next run resumes from.
//
// ⚠️ ROWS ARE INDEPENDENT AND CREATION IS SEQUENTIAL. A failed row lands in
// `failed` WITH ITS REASON and its siblings keep their own outcomes — row 2 of 3
// failing neither rolls back row 1 nor stops row 3. Sequential rather than
// parallel because the governing limit is GitHub's 80 content-generating requests
// per minute plus an undisclosed abuse limit on repository creation specifically
// (spike §4.1): a set is 2–5 rows, so serialising costs seconds and removes the
// only way this path could ever trip a secondary limit.
//
// SCOPE. This is the primitive as a SERVICE, callable from the approval flow.
// No UI (MOTIR-1782), no schema (MOTIR-1780), no proposal (MOTIR-1881), no
// starter registry (MOTIR-709), no transfer flow (MOTIR-711).
//
// CONNECT-EXISTING is deliberately absent: it creates nothing, so it is a row
// state change plus an association — `projectRepoSetService.attachRealizedRepo`
// on an already-connected `GithubRepo`, which is shipped and which MOTIR-1782
// calls directly. Wrapping it here would add a layer that does nothing.

/** What happened to ONE row in an establish run. */
export type EstablishRowOutcome =
  /** A repository was created for this row and the row is now `created`. */
  | 'created'
  /** The repository already existed in Motir's org under this row's name and was
   *  ADOPTED — the resume path after a crash between create and attach. The row
   *  is `created`; no second repository was made. */
  | 'adopted'
  /** The attempt failed; the row is `failed` and carries its reason. */
  | 'failed'
  /** The row was already settled (`created` / `connected` / `skipped`) — a re-run
   *  never touches it. */
  | 'already_settled'
  /** The row was not attempted: another run holds it `creating`, or it lost the
   *  claim race between this run's read and its `markCreating`. */
  | 'not_attempted';

export interface EstablishRowResult {
  rowId: string;
  /** The row's authored name — the one the attempt targeted. */
  name: string;
  outcome: EstablishRowOutcome;
  /** The row as it stands AFTER the attempt. Null only when the row could not be
   *  re-read (it was removed mid-run). */
  row: ProjectRepoDto | null;
  /** The renderable failure sentence, for `outcome: 'failed'` only. */
  failureReason?: string;
  /** The typed failure code, for `outcome: 'failed'` only — stable for a UI that
   *  wants to branch (e.g. offer "connect it instead" on a name collision). */
  failureCode?: string;
}

/** Narrowing options for {@link projectRepoProvisioningService.establishSet}. */
export interface EstablishSetOptions {
  /**
   * Attempt ONLY this row, leaving every sibling untouched (`not_attempted`).
   *
   * This is the establish step's **Retry** on a single failed row (MOTIR-1782):
   * rows are independent (ADR §4.2), so retrying one must not silently re-attempt
   * a sibling the user has not asked about again. Absent = the whole set, which is
   * the first run and the "Try again" on the default path.
   *
   * A row id that is not in this project's set simply matches nothing, so the run
   * attempts nothing — the same honest answer as a set whose rows are all settled.
   */
  rowId?: string;
}

export interface EstablishSetResult {
  projectId: string;
  /** One entry per row of the set, in set order — including the ones this run
   *  deliberately did not touch, so a caller can render the whole set from one
   *  result rather than re-reading to find out what was skipped. */
  rows: EstablishRowResult[];
}

/** The states an establish run may act on. `proposed` is the first attempt;
 *  `failed` is the retry, which ADR §4.1 makes explicitly resumable. Everything
 *  else is either settled or claimed by a concurrent run. */
const UNRESOLVED_STATES: readonly ProjectRepoStateDto[] = ['proposed', 'failed'];

/** Where this run creates repositories (MOTIR-8966). No `target` = the fallback
 *  org, as before. `unavailableOrg` = the organisation is assigned an org no
 *  account row names any more: every row fails rather than land elsewhere. */
interface HostingPlan {
  target?: GithubOrgTarget;
  unavailableOrg?: string;
}

export const projectRepoProvisioningService = {
  /**
   * Establish every unresolved row of a project's repository set: create the
   * repository, seed it per its role, mirror it, and settle the row.
   *
   * RESUMABLE AND IDEMPOTENT PER ROW. Only `proposed` and `failed` rows are
   * attempted, so a re-run completes exactly what is left and never re-creates a
   * repository that already exists — the `422 already exists` path adopts, it
   * does not rename and it does not create a second one.
   *
   * NEVER THROWS FOR A ROW-LEVEL FAILURE. A row that cannot be created is
   * recorded as `failed` with its reason and the run continues; the caller reads
   * the per-row outcomes. It DOES throw for a caller-level failure — the project
   * not existing, or the actor not being allowed to edit it — which is the access
   * gate `projectRepoSetService` already owns.
   */
  async establishSet(
    projectId: string,
    ctx: ServiceContext,
    options: EstablishSetOptions = {},
  ): Promise<EstablishSetResult> {
    // Browse-gated read of the whole set (a missing / other-tenant project 404s
    // here, before anything touches GitHub); every write below is edit-gated by
    // the set service itself.
    const rows = await projectRepoSetService.listByProject(projectId, ctx);
    const projectName = await readProjectName(projectId, ctx);

    // THE PAID-AI-PLAN GATE, BEFORE ANYTHING TOUCHES GITHUB (MOTIR-6909 ·
    // `docs/decisions/fleet-per-org-pool.md`). A Motir-hosted repository's CI runs
    // on Motir's fleet, and the fleet is paid-AI-plan only — so an org without a
    // plan gets no repository to run it for. An unreadable plan refuses too: a
    // guessed yes would hand a free fleet to whoever motir-ai cannot see.
    const organizationId = await assertPaidAiPlan(ctx);

    // THE TENANT'S GITHUB ORG, BEFORE THE GROUP AND THE VARIABLE (MOTIR-8966 ·
    // `docs/decisions/fleet-per-org-pool.md` AMENDMENT 1). An organisation's first
    // hosted repository is where it is assigned a Motir-owned GitHub org; the
    // group and the variable below are then made THERE, before the repository
    // exists, for the reason each of them gives. Assigned only when this run will
    // try to create something; otherwise the existing assignment is read.
    const willAttempt = rows.some(
      (row) =>
        (options.rowId === undefined || row.id === options.rowId) &&
        UNRESOLVED_STATES.includes(row.state),
    );
    const hosting = await planHosting(organizationId, willAttempt);

    // THE RUNNER GROUP FIRST, BEFORE ANY REPOSITORY EXISTS (MOTIR-1972 ·
    // `docs/decisions/ci-runner-fleet.md` §7.3).
    //
    // Creating a repository makes a surface CI can fire on immediately — an
    // initialised row gets a CI stub commit, which is a push, which queues a job.
    // If the group landed after that, the first job's provisioning would have no
    // `runner_group_id` and would have to REFUSE, which is a visible failure on a
    // brand-new project. Ordering it here closes that race in the safe direction:
    // the group exists with an EMPTY access list (it grants nothing to anyone,
    // which is the correct posture for a group whose repositories do not exist
    // yet), and each row's own sync adds it as it settles.
    //
    // Quiet by contract — a group Motir could not create must not stop the project
    // from getting its repositories; the next sync retries.
    await projectRunnerGroupService.syncQuietly(
      { projectId, workspaceId: ctx.workspaceId },
      { hostedOrg: hosting.target },
    );

    // AND THE RUNNER VARIABLE, FOR THE SAME REASON AND IN THE SAME WINDOW
    // (MOTIR-2015 · `docs/decisions/ci-runner-fleet.md` §N.1).
    //
    // The group decides WHICH runners may serve a repository; `vars.MOTIR_RUNNER`
    // is what makes the repository ASK for one at all — the starter's
    // `runs-on: ${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}` and the CI stub below
    // both read it. Ordering it here, before any repository exists, closes the same
    // race the group's ordering closes: an initialised row's CI-stub commit is a
    // push, which queues a job within seconds of the repository appearing, and a
    // variable written after that would leave the project's very first job on
    // GitHub-hosted for no reason anyone could later explain.
    //
    // ORG-WIDE, so this is one conditional GET per establish run and not per row —
    // and re-running it is the self-healing path for a variable deleted out of
    // band. Quiet by the same contract as the group: a repository whose variable
    // could not be written is a working repository whose CI runs GitHub-hosted,
    // which is exactly what the `|| 'ubuntu-latest'` fallback is for.
    await fleetRunnerVariableService.ensureQuietly(hosting.target);

    // THE PROJECT'S DESIGN CHOICE, READ ONCE FOR THE RUN (MOTIR-1529). A row
    // seeded from a design-system starter wears it from its first commit; every
    // other row ignores it. Read only when something will be created.
    const design = willAttempt ? { choice: await readDesignChoice(projectId, ctx) } : undefined;

    const results: EstablishRowResult[] = [];
    // SEQUENTIAL on purpose — see the module header.
    for (const row of rows) {
      // A single-row run reports every OTHER row as `not_attempted` rather than
      // omitting it: the result still describes the whole set, so a caller renders
      // from one result (the contract `EstablishSetResult.rows` states) whether it
      // asked for one row or all of them.
      if (options.rowId !== undefined && row.id !== options.rowId) {
        results.push({ rowId: row.id, name: row.name, outcome: 'not_attempted', row });
        continue;
      }
      if (!UNRESOLVED_STATES.includes(row.state)) {
        results.push({
          rowId: row.id,
          name: row.name,
          // `creating` is not settled: it is another run's live claim, and the
          // honest report is "not attempted", not "already done".
          outcome: row.state === 'creating' ? 'not_attempted' : 'already_settled',
          row,
        });
        continue;
      }
      results.push(await establishRow(row, projectName, hosting, design, ctx));
    }

    return { projectId, rows: results };
  },
};

/** The workspace's organisation id, once its paid AI plan is confirmed. */
async function assertPaidAiPlan(ctx: ServiceContext): Promise<string> {
  const workspace = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx) => workspaceRepository.findByIdInTx(ctx.workspaceId, tx),
  );
  const answer = workspace
    ? await aiPlanGateService.hasPaidAiPlan(workspace.organizationId)
    : ('unknown' as const);
  if (answer === 'unknown') throw new AiPlanUnknownError(PLAN_UNKNOWN_ESTABLISH_MESSAGE);
  if (!answer) throw new AiPlanRequiredError(AI_PLAN_REQUIRED_ESTABLISH_MESSAGE);
  // `answer` is true only for a workspace that was read.
  return workspace!.organizationId;
}

/** Where this run's repositories go — see {@link HostingPlan}. */
async function planHosting(organizationId: string, willAttempt: boolean): Promise<HostingPlan> {
  if (!willAttempt) {
    const current = await fleetGithubOrgAssignmentService.readHostedGithubOrg(organizationId);
    if (!current) return {};
    return current.target ? { target: current.target } : { unavailableOrg: current.githubOrg };
  }
  const assignment = await fleetGithubOrgAssignmentService.ensureHostedGithubOrg(organizationId);
  if (assignment.outcome === 'assigned') return { target: assignment.target };
  if (assignment.outcome === 'already_assigned') {
    return assignment.target
      ? { target: assignment.target }
      : { unavailableOrg: assignment.githubOrg };
  }
  return {};
}

/**
 * The project's stored design choice, from the pre-plan session motir-ai keeps
 * (`GET /v1/preplan`, the read the onboarding wizard resumes from), or null.
 *
 * Never fails the run: a project that never reached the design step, an
 * unreachable motir-ai and a deployment without one all read as "no choice", and
 * the repository wears the registry defaults — the outcome the card asks for
 * when no choice is stored. The ids are NOT validated here; the apply resolves
 * each through the package's own registries and logs any fallback.
 */
async function readDesignChoice(
  projectId: string,
  ctx: ServiceContext,
): Promise<StoredDesignChoice | null> {
  try {
    const state = await getPreplanState({
      coreWorkspaceId: ctx.workspaceId,
      coreProjectId: projectId,
    });
    return state.session?.designChoice ?? null;
  } catch (err) {
    console.warn(
      '[projectRepoProvisioningService] design choice not read; the registry defaults apply:',
      err instanceof Error ? err.message : 'unknown',
    );
    return null;
  }
}

/** The project's display name — it goes into the repository description, which
 *  GitHub also renders into an initialised repo's README (ADR §2's "a README
 *  naming the project and the row's role"). */
async function readProjectName(projectId: string, ctx: ServiceContext): Promise<string> {
  const project = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
    (tx) => projectRepository.findById(projectId, tx),
  );
  return project?.name ?? 'this project';
}

/**
 * Establish ONE row. The whole per-row contract lives here: claim, create,
 * mirror, attach, index — and on any failure, record the reason on the row and
 * return rather than throw, so the caller's loop reaches the siblings.
 */
async function establishRow(
  row: ProjectRepoDto,
  projectName: string,
  hosting: HostingPlan,
  design: ProvisionRepoInput['design'],
  ctx: ServiceContext,
): Promise<EstablishRowResult> {
  // CLAIM the row first (`proposed | failed → creating`). This is the concurrency
  // guard, not bookkeeping: the hop is legality-checked under the row's lock, so
  // a second run racing this one loses the transition and backs off here — before
  // it has asked GitHub for a repository.
  //
  // A claim that fails for ANY reason yields `not_attempted` and the loop moves
  // on to the siblings. That is not leniency, it is the only correct answer: an
  // unclaimed row is still `proposed`, and ADR §4.1 gives `proposed` no edge to
  // `failed` — so there is literally nowhere to record a failure, and throwing
  // would abandon the rows after it, which is the one thing per-row independence
  // forbids. A cause other than the transition race is logged, since that would
  // be a real defect rather than an expected loss.
  try {
    await projectRepoSetService.markCreating(row.id, ctx);
  } catch (err) {
    if (!(err instanceof ProjectRepoStateTransitionError)) {
      console.error(
        `[projectRepoProvisioningService] could not claim row ${row.id}; skipping it:`,
        err,
      );
    }
    return { rowId: row.id, name: row.name, outcome: 'not_attempted', row };
  }

  let provisioned: ProvisionedRepo;
  try {
    // Never the fallback org for an organisation assigned another (MOTIR-8966).
    if (hosting.unavailableOrg) throw new RepoHostOrgUnavailableError(hosting.unavailableOrg, null);
    // The row's seed, through the registry (MOTIR-708). An unknown key or a
    // retired entry fails THIS row here, before GitHub is asked for anything.
    const seed = await seedRegistryService.resolveForEstablish(row.seedSource);
    provisioned = await repoProvisioningClient.provisionRepository(
      {
        name: row.name,
        role: row.role,
        seed,
        projectName,
        design,
      },
      hosting.target,
    );
  } catch (err) {
    return failRow(row, err, ctx);
  }

  try {
    // An ADOPTED repository is one this call did not create, so it is the only
    // case where the coordinate might already be mirrored — possibly for ANOTHER
    // tenant. Check BEFORE the upsert: `githubRepoRepository.upsert` re-stamps
    // `workspace_id`, so mirroring another workspace's repo would not merely
    // mis-record it, it would MOVE it. This read is global and context-free on
    // purpose (the shipped `findConnectedByName` semantics): the question "who
    // already holds this coordinate?" cannot be asked from inside one tenant.
    if (provisioned.adopted) {
      // CROSS-WORKSPACE by design — the question is "who already holds this
      // coordinate?", which cannot be asked from inside one tenant. Same system
      // binding as `oidcAuth`'s resolve, and for the same reason.
      const existing = await withSystemContext((tx) =>
        githubRepoRepository.findConnectedByName(provisioned.owner, provisioned.name, tx),
      );
      const foreign = existing.find((repo) => repo.workspaceId !== ctx.workspaceId);
      if (foreign) return failRow(row, new RepoNameTakenOnHostError(row.name), ctx);
    }

    // MIRROR the one repository (never a reconcile — the shared provisioning
    // installation holds every tenant's repos, so pruning is unreachable by
    // construction; see `persistProvisionedRepo`). This is what replaces the
    // `installation_repositories` delivery GitHub does NOT send for a repo the
    // App itself created (spike Mechanic 2).
    const mirrored = await githubInstallationService.persistProvisionedRepo({
      workspaceId: ctx.workspaceId,
      installation: {
        installationId: provisioned.installationId,
        accountLogin: provisioned.owner,
        accountType: 'Organization',
      },
      repo: {
        providerRepoId: provisioned.providerRepoId,
        owner: provisioned.owner,
        name: provisioned.name,
        defaultBranch: provisioned.defaultBranch,
        // A repository Motir created seconds ago is live by construction — the
        // creation call cannot return an archived repo (MOTIR-1959). Stated
        // rather than left to a column default so the mirror write has one rule
        // for where liveness comes from, and this site says WHY it knows.
        archived: false,
      },
    });

    // SETTLE the row: `creating → created`, with the mirror row attached. The
    // unique index is the tenant-blind backstop for the adoption check above — a
    // repository already in THIS PROJECT's set fails here as a typed error, which
    // `failRow` turns into a `failed` row.
    //
    // ⚠️ The index it names changed with the model (MOTIR-4648). It used to be
    // `github_repo_id` alone, and the sentence here read *"a repo already claimed
    // by ANOTHER project's row"* — which is no longer a failure at all: a
    // repository belongs to the ORGANISATION, so two projects using one is the
    // ordinary case. The backstop is now `(project_id, github_repo_id)`, and it
    // catches the mistake that is still a mistake.
    const settled = await projectRepoSetService.attachRealizedRepo(row.id, mirrored.id, ctx, {
      seedHeadSha: provisioned.seedHeadSha,
    });

    // ⚠️ A REPOSITORY MOTIR JUST SEEDED IS NOT INDEXED YET (MOTIR-4589). It holds
    // exactly its seed, so its graph would be the template's graph — a whole-tree
    // build attributed to the organisation for nothing the planner cannot be told
    // for free. Its first index comes from its first push past the seed
    // (`githubWebhookService.handlePush`), and the reconcile's has-no-graph gate
    // still offers it every time, so a push that was missed is not a repository
    // that stays code-blind. Only when the seed head is UNKNOWN (an adopted
    // repository, an unreadable head) does it index now, as it always did —
    // POST-COMMIT, best-effort, through the existing chokepoint (MOTIR-1500).
    if (provisioned.seedHeadSha !== null) {
      console.warn(
        '[projectRepoProvisioningService] code graph not indexed yet: no commit beyond the ' +
          'template. The first push past the seed indexes it. repo / seed head:',
        `${mirrored.owner}/${mirrored.name}`,
        provisioned.seedHeadSha,
      );
    } else {
      await enqueueCodeGraphIndex({
        installationId: provisioned.installationId,
        workspaceId: ctx.workspaceId,
        repoOwner: mirrored.owner,
        repoName: mirrored.name,
        defaultBranch: mirrored.defaultBranch,
      });
    }

    // PREVIEWS ON, POST-COMMIT AND QUIET (MOTIR-5775). A Motir-hosted web
    // repository's pull requests get a push credential and the variables the
    // starter's `preview-image` workflow reads; `enable` itself decides
    // eligibility (a non-web seed, a row with no hosting target yet answer
    // `ineligible` with no call). A failure leaves a working repository whose
    // previews the daily sweep switches on, so it never fails the row.
    await previewEnablementService.enableQuietly(row.id);

    // PRODUCTION, ONCE THE REPOSITORY IS ESTABLISHED (MOTIR-10027): a Fly-targeted
    // Motir repository with a web manifest gets its production app, credential
    // and workflow variables. Quiet by contract — a repository whose enablement
    // failed is a working repository, and the backfill switches it on later.
    await productionEnablementService.enableQuietly(row.id);

    return {
      rowId: row.id,
      name: row.name,
      outcome: provisioned.adopted ? 'adopted' : 'created',
      row: settled,
    };
  } catch (err) {
    // The repository EXISTS at this point — it is not deleted to tidy the record
    // (ADR §4.2). The row records why it could not be settled and stays
    // resumable; the retry then takes the adopt path rather than creating a
    // second repository.
    return failRow(row, err, ctx);
  }
}

/**
 * Record a row's failure and return its result. `markFailed` is itself a write
 * that can lose a race (a concurrent run may have moved the row), so its own
 * failure is logged and swallowed — losing the reason is bad, losing the rest of
 * the set because we could not write the reason is worse.
 */
async function failRow(
  row: ProjectRepoDto,
  err: unknown,
  ctx: ServiceContext,
): Promise<EstablishRowResult> {
  const { reason, code } = describeFailure(err, row.name);
  let settled: ProjectRepoDto | null = null;
  try {
    settled = await projectRepoSetService.markFailed(row.id, reason, ctx);
  } catch (markErr) {
    console.error(
      `[projectRepoProvisioningService] could not record the failure of row ${row.id}:`,
      markErr,
    );
  }
  return {
    rowId: row.id,
    name: row.name,
    outcome: 'failed',
    row: settled,
    failureReason: reason,
    failureCode: code,
  };
}

/**
 * Turn a thrown error into the RENDERABLE reason persisted on the row.
 *
 * Three tiers, and the middle one earns its place: a repository DOES exist by the
 * time these fire, so "the row was removed / already claims another repo / moved
 * underneath us" is a real, explainable concurrent-edit outcome that deserves its
 * own sentence rather than a shrug. Only a genuinely unknown failure gets the
 * generic sentence, and its detail goes to the LOG — never to the row, because a
 * raw GitHub or database payload must not reach a rendered surface.
 */
function describeFailure(err: unknown, repoName: string): { reason: string; code: string } {
  if (err instanceof RepoProvisioningError || err instanceof SeedResolutionError) {
    return { reason: err.reason, code: err.code };
  }
  if (err instanceof RealizedRepoAlreadyClaimedError) {
    return {
      reason:
        `The repository for "${repoName}" already belongs to another project in this workspace, ` +
        'so it was not claimed for this one. Choose a different name, or remove the other claim.',
      code: err.code,
    };
  }
  if (err instanceof ProjectRepoNotFoundError) {
    return {
      reason:
        `The repository for "${repoName}" was created, but the row could not be updated because ` +
        'it was removed while the repository was being created. Re-run the step to reconcile it.',
      code: err.code,
    };
  }
  console.error(`[projectRepoProvisioningService] unexpected failure for "${repoName}":`, err);
  return {
    reason: `Something went wrong while creating the repository "${repoName}". Retry this row.`,
    code: 'UNEXPECTED',
  };
}

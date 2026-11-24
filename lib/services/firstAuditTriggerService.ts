import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { aiConventionService } from '@/lib/services/aiConventionService';
import { readRepoAuditState } from '@/lib/services/auditCoverageService';

// THE FIRST-AUDIT TRIGGER (MOTIR-2266) — a repo whose code-graph index has just
// SUCCEEDED and that has no derived audit gets its `code_audit` +
// `propose_convention` pair, once. The implementation of
// `docs/decisions/audit-on-first-index.md` (option B, accepted 2026-08-05).
//
// The asymmetry it closes: connecting a repo gives it a code graph automatically
// (`enqueueReposMissingFirstIndex`) and never gives it an assessment, so a repo
// with a graph and no audit is one the planner reasons about without knowing how
// its code is written — invisible at exactly the moment it costs something.
//
// FOUR PROPERTIES, and each is load-bearing:
//
//  1. THE GATE IS "HAS NO AUDIT YET", NEVER "IS THIS INDEX ROW NEW". That is the
//     same shape `enqueueReposMissingFirstIndex` uses against the succeeded-index
//     ledger, and it is what makes this safe to hang off EVERY index completion
//     rather than off a once-in-the-product's-life event. MOTIR-1961 paid for the
//     other reading on the indexing half: gating on row novelty left every repo
//     connected before the feature shipped permanently un-indexable, because such
//     a repo is never "new" again at any moment when the code exists.
//
//  2. IT IS REPO-SCOPED, via MOTIR-2247's `reaudit({ repoKeys })`. The unscoped
//     call fans out over the whole connected set, so learning about a sixth repo
//     would cost six derivations — the precise defect MOTIR-2244 exists to remove.
//     This fires exactly one pair, for the repo that just finished indexing.
//
//  3. IT IS PER PROJECT, because an audit is. The index fans out over EVERY
//     project of the repo's workspace (`codeGraphIndexService`'s TENANCY note) and
//     motir-ai keys a code audit on (project, repo), so a graph landing in three
//     projects' stores is three separate "does this repo have an audit" questions.
//     Deriving only the first would leave the others in exactly the state this
//     card exists to end.
//
//  4. IT NEVER FAILS, RETRIES OR SLOWS THE INDEX. A derivation blip must not turn
//     an index that SUCCEEDED into a failed run — the ledger's `succeeded` row is
//     what tells the enqueue gate and the onboarding wizard the repo has a graph.
//     So every path is best-effort + logged, mirroring `migrateOnboardingService`'s
//     `audit_convention` kick (`:205`), and a repo left un-audited is precisely the
//     state MOTIR-2244's planning-workspace nudge already exists to report. The exception
//     path is built; this only makes it the exception.
//
// THE ACTOR IS THE WORKSPACE OWNER — the `autoPlanCadenceService.runForProject`
// precedent, for its reasons. `refreshCodeAudit` mints a job-scoped read-back
// token for a specific `userId` so motir-ai reads only what that user could, and
// an index job carries no session. The owner is the only durable owner identity
// in the schema (`Project` has no `ownerId`) and holds access to every project in
// the workspace. NOT the system principal: `lib/ai/systemPrincipal.ts` is a member
// of the META workspace only and is not a member of a customer workspace at all.
//
// OUT OF SCOPE, deliberately (decision record §4): re-firing when a repo is
// RE-indexed after new commits is a genuinely recurring-spend question the record
// does not answer, which is why this hangs off `system.code-graph-index` and not
// off the shared `runIndexHandoffSteps` that `system.code-graph-refresh` also drives.
// And there is no project setting: §6 records what would reopen that.

/** Why a whole run derived nothing, before any project was considered. */
export type FirstAuditSkipReason = 'no_owner' | 'no_projects' | 'lookup_failed';

/** Why ONE project derived nothing. */
export type FirstAuditProjectSkipReason =
  | 'already_audited'
  | 'coverage_unavailable'
  | 'submit_failed';

/** What the trigger did for one of the repo's projects. */
export interface FirstAuditProjectOutcome {
  projectId: string;
  status: 'submitted' | 'skipped';
  reason?: FirstAuditProjectSkipReason;
}

/**
 * What one index success's trigger did. JSON-SERIALIZABLE by construction — it is
 * a `step.run` result, so it crosses an Inngest checkpoint and is replayed from
 * the memo on every later invocation.
 */
export interface FirstAuditTriggerReport {
  repoRef: string;
  /** How many `code_audit` + `propose_convention` pairs were submitted. */
  submitted: number;
  outcomes: FirstAuditProjectOutcome[];
  /** Set when the run stopped before reaching any project. */
  skipped?: FirstAuditSkipReason;
}

export const firstAuditTriggerService = {
  /**
   * Derive the FIRST audit + convention for a repo whose index just succeeded,
   * in every project of its workspace that has no audit for it yet.
   *
   * ⚠️ NEVER THROWS. The caller is a job step that runs AFTER the index has
   * already succeeded, so a throw here would fail — and Inngest would then RETRY —
   * a run whose real work is done. Every failure resolves to a report instead.
   */
  async deriveFirstAudit(input: {
    workspaceId: string;
    /** The `owner/name` ref the index just claimed — the ledger's `output.repoRef`. */
    repoRef: string;
  }): Promise<FirstAuditTriggerReport> {
    const { workspaceId, repoRef } = input;
    let owner: { userId: string } | null;
    let projects: { id: string; identifier: string }[];
    try {
      // The WORKSPACE tier, not the system flag: the index job has no acting USER,
      // but the workspace is an argument, and both reads are admitted by
      // `app.workspace_id` (`membership_visible_active_or_own` /
      // `project_workspace_or_system_read`).
      //
      // ⚠️ THIS USED TO BE `withSystemContext` (MOTIR-2880). `workspace_membership`
      // carries no arm reading `app.system_admin`, so under `motir_app` the owner
      // read returned null and EVERY repo was reported `no_owner` — un-audited,
      // silently, with the planning workspace's nudge as the only trace.
      owner = await withWorkspaceServiceContext(workspaceId, (tx) =>
        workspaceMembershipRepository.findStandInManagerByWorkspace(workspaceId, tx),
      );
      if (!owner) return { repoRef, submitted: 0, outcomes: [], skipped: 'no_owner' };
      projects = await withWorkspaceServiceContext(workspaceId, (tx) =>
        projectRepository.findByWorkspace(workspaceId, tx),
      );
    } catch (err) {
      // Arguments, never interpolated: `repoRef` is webhook-derived on the
      // connect path, and building a format string out of it is
      // `js/tainted-format-string` (CodeQL, high).
      console.error(
        '[first-audit-trigger] could not resolve the workspace owner or its projects; ' +
          'the repo stays un-audited and the /planning nudge will report it. workspace / repo:',
        workspaceId,
        repoRef,
        err,
      );
      return { repoRef, submitted: 0, outcomes: [], skipped: 'lookup_failed' };
    }

    // A workspace with no project has nowhere to put an audit. An AUDIT is
    // project-scoped and stays so — MOTIR-4642 moved the code GRAPH to the
    // organisation, not the audit — so this verdict is about this service's own
    // question and is unchanged by that story.
    //
    // ⚠️ IT SHARES A SPELLING WITH `IndexSkipReason.no_projects` AND IS A
    // DIFFERENT UNION (MOTIR-4652). That one narrowed to "no project to resolve a
    // run credential through"; this one still means "nowhere to put an audit". A
    // sweep that treated the two as one value would delete a live verdict.
    if (projects.length === 0)
      return { repoRef, submitted: 0, outcomes: [], skipped: 'no_projects' };

    const outcomes: FirstAuditProjectOutcome[] = [];
    for (const project of projects) {
      outcomes.push(
        await deriveForProject(project, { userId: owner.userId, workspaceId }, repoRef),
      );
    }
    return {
      repoRef,
      submitted: outcomes.filter((outcome) => outcome.status === 'submitted').length,
      outcomes,
    };
  },
};

/**
 * One project's gate + submit, contained: one project's motir-ai outage must not
 * cost the workspace's other projects their first audit.
 */
async function deriveForProject(
  project: { id: string; identifier: string },
  ctx: { userId: string; workspaceId: string },
  repoRef: string,
): Promise<FirstAuditProjectOutcome> {
  try {
    const coverage = await readRepoAuditState(
      { coreWorkspaceId: ctx.workspaceId, coreProjectId: project.id },
      repoRef,
    );
    // ⚠️ `unavailable` SKIPS, and it is not the same skip as `audited`. Unknown
    // is not "missing" — the same distinction MOTIR-2248 made for the nudge, which
    // declines to count an unreadable repo. Spending a derivation on a guess is
    // the more expensive way to be wrong, and the next index or the nudge's
    // one-click trigger both still reach the repo.
    if (coverage.state !== 'not_audited') {
      return {
        projectId: project.id,
        status: 'skipped',
        reason: coverage.state === 'audited' ? 'already_audited' : 'coverage_unavailable',
      };
    }

    // MOTIR-2247's explicit target set — exactly the one repo that just indexed.
    await aiConventionService.reaudit(project.id, ctx, project.identifier, {
      repoKeys: [repoRef],
    });
    return { projectId: project.id, status: 'submitted' };
  } catch (err) {
    console.error(
      '[first-audit-trigger] the first-audit derivation failed (non-blocking; the index ' +
        'itself succeeded). project / repo:',
      project.id,
      repoRef,
      err,
    );
    return { projectId: project.id, status: 'skipped', reason: 'submit_failed' };
  }
}

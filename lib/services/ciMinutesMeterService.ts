import { Prisma } from '@/generated/prisma/client';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { bindOrganizationContext, withOrgServiceWriteContext } from '@/lib/organizations/context';
import { getGitProvider } from '@/lib/git';
import type { GitProviderId, NormalizedWorkflowRunEvent } from '@/lib/git/types';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import {
  ciWorkflowRunUsageRepository,
  type RepoPeriodTotal,
} from '@/lib/repositories/ciWorkflowRunUsageRepository';
import {
  ciPeriodUsageRepository,
  type OrgPeriodConsumption as CiPeriodRollup,
} from '@/lib/repositories/ciPeriodUsageRepository';
import { previewUsageRepository } from '@/lib/repositories/previewUsageRepository';
import { ciLiveAccrualRepository } from '@/lib/repositories/ciLiveAccrualRepository';
import {
  isCiMeteringEnabled,
  isMotirOwnedRepo,
  provisioningOrgLogin,
} from '@/lib/ciMetering/config';
import { normalizeRunUsage, type MeteredJob } from '@/lib/ciMetering/normalize';
import { periodEndFor, periodStartFor } from '@/lib/ciMetering/period';

// The CI-minutes METER (Story MOTIR-1775 · MOTIR-1896) — the MEASUREMENT half of
// the charging contract in `docs/decisions/ci-minutes-allowance.md`.
//
// Motir hosts every repository it creates for a new project in its own GitHub
// org, and private-repo Actions minutes bill to the REPOSITORY OWNER — so Motir
// pays for those users' CI from the first `motir run` onward, because every
// dispatch ends in a PR and every PR runs CI. This service measures that: it
// takes a COMPLETED `workflow_run` delivery, decides whether Motir paid for it,
// resolves whom it belongs to, converts it to Linux-equivalent minutes, and
// persists it idempotently, per calendar month.
//
// ⚠️ IT DEBITS NOTHING AND REFUSES NOTHING. No credit is spent, no balance is
// read, no dispatch is blocked here — that is MOTIR-1901's job, and the seam
// between the two is exactly ONE read: `getOrgPeriodConsumption`.
//
// The pipeline, and where each step is decided:
//
//   1. Enabled?          §8.5  — off-cloud, or no provisioning org: inert.
//   2. Does MOTIR pay?   §5.1  — the run's OWN repository owner == Motir's org.
//   3. Whom for?         §5.2  — repo → project-repo row → project → workspace → org.
//   4. Meta org?         §4.4  — read, and CARRIED OUT on the outcome, never a bypass here.
//   5. Already metered?  §5.8  — a cheap pre-check; the unique index is the guard.
//   6. How much?         §3+§5.8 — Σ ceil(per-JOB minutes) × the runner's price ratio.
//   7. Record it.        §4.5  — one transaction: the audit row + the month's rollup.

const PROVIDER: GitProviderId = 'github';

export type MeterWorkflowRunOutcome =
  /** Off-cloud or no provisioning org configured — the meter is inert (§8.5). */
  | { outcome: 'disabled' }
  /** GitHub does not bill Motir for this repo: a connect-existing repo, or one
   *  already transferred to the user. Not an error — simply not metered (§5.1). */
  | { outcome: 'not_metered'; reason: 'foreign_owner' }
  /** The delivery names an installation or repo Motir has no mirror row for. */
  | { outcome: 'unknown_installation' }
  | { outcome: 'unknown_repo' }
  /** Motir IS billed, but the chain resolves no tenant — a repo in Motir's org
   *  whose project was deleted, or one belonging to no project. Real spend
   *  charged to nobody, and LOGGED, because silence here would hide it (§5.4). */
  | { outcome: 'unattributed'; repoOwner: string; repoName: string }
  /** This run attempt was already metered — counted once (§5.8). */
  | { outcome: 'duplicate'; runId: string; runAttempt: number }
  /** The run completed with no job that produced billable time. */
  | { outcome: 'no_billable_jobs'; runId: string }
  | {
      outcome: 'metered';
      runId: string;
      runAttempt: number;
      organizationId: string;
      workspaceId: string;
      projectId: string | null;
      periodStart: Date;
      billableMinutes: number;
      linearEquivalentMinutes: number;
      /**
       * What the live charge had already added for this run (MOTIR-6910), in
       * whole minutes. The rollup received only the difference between GitHub's
       * figure and this, never both.
       */
      liveChargedMinutes: number;
      /** The META org (moooon B.V.). Its minutes are RECORDED like anyone's; this
       *  flag is what the caller hands the CHARGE so the charge can bypass it
       *  (§4.4 · `code-graph-index-fleet.md` §20). */
      isMeta: boolean;
    };

/** Whom a metered run belongs to — the §5.2 chain's output. */
interface Attribution {
  workspaceId: string;
  organizationId: string;
  projectId: string | null;
  githubRepoId: string;
  isMeta: boolean;
}

/** An org's period consumption: the CI rollup's figures, with preview minutes
 *  added to `linearEquivalentMinutes` and broken out in `bySource`. */
export type OrgPeriodConsumption = CiPeriodRollup & {
  bySource: { ci: number; preview: number };
};

export const ciMinutesMeterService = {
  /**
   * Meter ONE completed workflow run. `installationId` is the host installation
   * id the delivery carried — used to resolve the repo mirror and to mint the
   * token the jobs read needs.
   *
   * Never throws for a run it simply does not meter: every "no" is a typed
   * outcome the webhook logs, because a webhook that 500s makes GitHub retry a
   * delivery there was never anything to do for.
   */
  async meterWorkflowRun(
    event: NormalizedWorkflowRunEvent,
    installationId: string,
  ): Promise<MeterWorkflowRunOutcome> {
    // 1 · §8.5 — self-host has no meter; an unprovisioned org has nothing that
    // could pass the gate.
    if (!isCiMeteringEnabled()) return { outcome: 'disabled' };

    // 2 · §5.1 — the gate, keyed on the run's OWN repository owner. This is the
    // billing fact itself ("who does GitHub charge?"), not a Motir column that
    // could drift from it, and reading it from the RUN rather than the mirror is
    // what makes the transfer edge (§5.5, MOTIR-711) need no special handling:
    // the owner changes at the transfer, so the next run simply falls outside.
    if (!(await isMotirOwnedRepo(event.repoOwner))) {
      return { outcome: 'not_metered', reason: 'foreign_owner' };
    }

    // 3 · §5.2 — resolve the tenant. THREE contexts, one per hop, because the
    // shipped RLS policies gate differently and only two of these tables carry
    // the `app.system_admin` escape:
    //
    //   * `github_installation` / `github_repo` — policy is
    //     `system_admin OR workspace_id = …`, so the webhook (no session, no
    //     active workspace) reads them under `withSystemContext`. This is the
    //     path the shipped PR/push/CI handlers already use.
    //   * `project_repository` / `workspace` — neither has a system escape, so
    //     `withSystemContext` would read NOTHING here in production (where the
    //     app connects as the non-BYPASSRLS `motir_app` role) and the whole
    //     chain would silently resolve to "unattributed". They are read under
    //     `withWorkspaceServiceContext` bound to the REPO's workspace, PLUS
    //     `bindOrganizationContext` — see the attribution block below for which
    //     arm each one needs and why the workspace GUC alone is not enough.
    //   * `organization` — `organization_active` gates purely on
    //     `app.organization_id`, likewise with no system escape, so `isMeta` is
    //     read under `withOrgServiceWriteContext`.
    //
    // ⚠️ THE BOUNDARY RLS ENFORCES HERE IS THE ORGANISATION, NOT THE WORKSPACE —
    // CORRECTED BY MOTIR-4839 (bug MOTIR-4835), because the sentence that stood
    // here asserted the opposite and was load-bearing for the next reader:
    //
    //   ~~"A pleasant consequence: because the project-repo row is read under the
    //   REPO's workspace GUC, RLS itself enforces that a repo can only be
    //   attributed inside the tenant that owns it. A row belonging to another
    //   workspace is invisible rather than merely unexpected, so cross-tenant
    //   mis-attribution is structurally impossible."~~
    //
    // That was TRUE while a repository could only be used by a project in its own
    // workspace. MOTIR-4669 made "a row belonging to another workspace" the
    // SUPPORTED shape — connect once, use from any workspace of the organisation
    // — so the mechanism that used to enforce a boundary had started SILENCING a
    // legitimate row instead, and every such run fell into §5.4's unattributed
    // bucket. The boundary is real and still structural; it is drawn one tier up.
    //
    // (HISTORY, and it is the same failure mode this comment used to describe as
    // safely in the past: the pre-MOTIR-1931 bug degraded to under-billing rather
    // than cross-tenant over-billing because, bound to the WRONG tenant's GUC,
    // the `project_repository` read resolved nothing and the run fell into that
    // same bucket. It read as reassurance; it was a description of the defect
    // MOTIR-4835 then found in the present tense.)
    const connection = await withSystemContext(async (tx) => {
      const installation = await githubInstallationRepository.findByInstallationId(
        installationId,
        tx,
      );
      if (!installation) return { kind: 'unknown_installation' as const };
      const repo = await githubRepoRepository.findByInstallationAndRepoId(
        installation.id,
        event.providerRepoId,
        tx,
      );
      if (!repo) return { kind: 'unknown_repo' as const };
      return {
        kind: 'connected' as const,
        // The REPO row is the payer (MOTIR-1931). The §5.1 owner-login gate above
        // still QUALIFIES the run — "does Motir pay GitHub for this?" — but it can
        // no longer IDENTIFY anyone: once every tenant's repos live in Motir's org
        // the owner login is true for all of them. The installation cannot answer
        // either; it is shared, and its `workspaceId` is NULL.
        workspaceId: repo.workspaceId,
        // The ORGANISATION, carried out of this block so the attribution
        // transaction can bind it (MOTIR-4839). `github_repo.organization_id` is
        // NOT NULL as of 20260907090000, so there is nothing to resolve and no
        // second read to make — which matters because the read that would have
        // resolved it is itself inside the transaction the binding is FOR.
        organizationId: repo.organizationId,
        githubRepoId: repo.id,
      };
    });

    if (connection.kind === 'unknown_installation') return { outcome: 'unknown_installation' };
    if (connection.kind === 'unknown_repo') return { outcome: 'unknown_repo' };

    const tenant = await withWorkspaceServiceContext(connection.workspaceId, async (tx) => {
      // ⚠️ BIND THE ORGANISATION TOO (MOTIR-4839 · bug MOTIR-4835). The workspace
      // GUC alone is not enough any more, and the reason is a tenancy change
      // rather than an oversight: MOTIR-4669 made a repository ORG-owned, so
      // `project_repository.workspace_id` — the LINKING project's — is routinely
      // a DIFFERENT workspace from `github_repo.workspace_id`, which is the one
      // bound above. Two reads in this block need the organisation:
      //
      //   * `project_repository` — `project_repository_active_workspace` matches
      //     only the row's own workspace; `project_repository_org_read`
      //     (20260906000000, re-cut by 20260906180000) is the arm that admits a
      //     sibling's, and it reads `app.organization_id`.
      //   * `workspace` — the anchor's row is likewise another workspace's.
      //     `workspace_org_service_read` (20260818010000) admits it, and it is
      //     specifically the USERLESS arm: `app.user_id` empty AND the org bound,
      //     which is exactly what a service context is.
      //
      // Both are FOR SELECT and additive, so this widens READS to the
      // organisation and nothing further — a link in another ORG stays invisible,
      // which `tests/github/siblingWorkspaceAttribution.test.ts` asserts with a
      // second organisation present in the fixture.
      await bindOrganizationContext(tx, connection.organizationId);

      // ⚠️ ATTRIBUTION, AND IT IS NO LONGER A LOOKUP (MOTIR-4648). This read used
      // to be `findByGithubRepoId`, justified by: *"`ProjectRepo.githubRepoId` is
      // @unique, so a realized repo belongs to AT MOST one project row — the join
      // can never be ambiguous."* The index is dropped and a repository in two
      // projects is the ordinary case, so the join CAN be ambiguous now.
      //
      // The disposition, and it refuses to guess:
      //   0 rows  → unattributed, exactly as before (§5.4's deleted-project /
      //             no-project case — the set row cascades away with its project).
      //   1 row   → that project. Unchanged, and still the overwhelmingly common
      //             shape.
      //   N rows  → the ORGANISATION still owns the spend and is still charged;
      //             the PROJECT is genuinely unknown, so it is recorded as null
      //             rather than as whichever row came back first. `projectId` is
      //             nullable on `ci_workflow_run_usage` precisely because "we
      //             know who pays but not which project" is a real state.
      //
      // Picking `rows[0]` would have been a one-word change and a plausible row
      // in the meter attributed to a project that may not have run anything.
      const projectRepos = await projectRepoRepository.listByGithubRepoId(
        connection.githubRepoId,
        tx,
      );
      if (projectRepos.length === 0) return null;
      // Every row realizing one repository is reachable from the same
      // installation, so the workspace is read off the first — what is ambiguous
      // is the PROJECT, not the tenant.
      const anchor = projectRepos[0]!;
      const workspace = await workspaceRepository.findByIdInTx(anchor.workspaceId, tx);
      if (!workspace) return null;
      if (projectRepos.length > 1) {
        console.warn(
          '[ciMinutesMeterService] repository is used by several projects — metering the org, project left null',
          { githubRepoId: connection.githubRepoId, projectCount: projectRepos.length },
        );
      }
      return {
        workspaceId: anchor.workspaceId,
        organizationId: workspace.organizationId,
        projectId: projectRepos.length === 1 ? anchor.projectId : null,
      };
    });

    const resolved = tenant
      ? {
          kind: 'resolved' as const,
          attribution: {
            workspaceId: tenant.workspaceId,
            organizationId: tenant.organizationId,
            projectId: tenant.projectId,
            githubRepoId: connection.githubRepoId,
            isMeta: await withOrgServiceWriteContext(tenant.organizationId, async (tx) => {
              const organization = await organizationRepository.findByIdInTx(
                tenant.organizationId,
                tx,
              );
              // A missing org row defaults to non-meta — the safe direction (it
              // meters rather than silently bypassing), as `resolveTenantOrg` does.
              return organization?.isMeta ?? false;
            }),
          } satisfies Attribution,
        }
      : { kind: 'unattributed' as const };

    if (resolved.kind === 'unattributed') {
      // §5.4: "metered as a cost, charged to nobody, and LOGGED". Motir is still
      // billed by GitHub for this run; the log is the only signal that real spend
      // has no owner, and silence would hide it.
      console.warn(
        '[ciMinutesMeterService] Motir-owned repo has no attributable project — real CI spend charged to nobody',
        {
          repoOwner: event.repoOwner,
          repoName: event.repoName,
          runId: event.runId,
          runAttempt: event.attempt,
        },
      );
      return { outcome: 'unattributed', repoOwner: event.repoOwner, repoName: event.repoName };
    }

    const attribution = resolved.attribution;

    // 4 · §4.4 — what `isMeta` suppresses is the CHARGE, never the MEASUREMENT
    // (`code-graph-index-fleet.md` §20, MOTIR-5283). moooon B.V. pays its own
    // GitHub bill, so billing it would bill the house to itself — but those
    // minutes are still real Motir spend, and a meta run that returns before the
    // write leaves the margin readout's denominator empty for exactly that org.
    // So the row is written below exactly as for any tenant, and `isMeta` rides
    // out on the `metered` outcome for the caller to hand to
    // `ciAllowanceService.chargeForMeteredRun`, whose own `meta` bypass is keyed
    // on that argument. (`getEntitlementState` reads `isMeta` itself and reports
    // `bypassed` before it reads consumption, so no pool accounting follows.)

    // 5 · A cheap redelivery pre-check, purely to skip the GitHub round-trip.
    // NOT the correctness guard — two concurrent deliveries would both miss it;
    // the `(run_id, run_attempt)` unique index at step 7 is what guarantees once.
    const already = await withSystemContext((tx) =>
      ciWorkflowRunUsageRepository.findByRunAndAttempt(event.runId, event.attempt, tx),
    );
    if (already) {
      return { outcome: 'duplicate', runId: event.runId, runAttempt: event.attempt };
    }

    // 6 · §5.8 — read the run's JOBS and normalize. Per-job `ceil` is not
    // optional: GitHub bills per job rounded up, and a workflow's jobs run in
    // parallel, so the run's own wall clock would badly undercount a 4-job suite.
    const provider = getGitProvider(PROVIDER);
    // The capability is OPTIONAL on the seam (§5.6 — GitLab has no Motir-paid
    // compute to report), but `PROVIDER` is the literal `'github'`, which always
    // implements it. Asserted rather than guarded: a defensive branch here could
    // never be reached or tested honestly, and if a future edit did break the
    // invariant the resulting TypeError is caught by the webhook's own handler,
    // which logs it and acks — the same treatment any other metering failure gets.
    const jobs = await provider.fetchWorkflowRunJobs!(
      installationId,
      event.repoOwner,
      event.repoName,
      event.runId,
      event.attempt,
    );

    const usage = normalizeRunUsage(jobs as MeteredJob[], event.completedAt);
    if (usage.billableMinutes === 0) {
      return { outcome: 'no_billable_jobs', runId: event.runId };
    }
    if (usage.unpricedFamilies.length > 0) {
      // §3.4 — an unpriced runner meters at ×1.00 (under-counting is the safe
      // direction: it never over-bills for a rate nobody decided) and LOGS. This
      // entry is the signal to add an effective-dated rate.
      console.warn('[ciMinutesMeterService] unpriced runner family metered at x1.00', {
        families: usage.unpricedFamilies,
        runId: event.runId,
        repoOwner: event.repoOwner,
        repoName: event.repoName,
      });
    }

    // 7 · §4.5 — the period is a PURE function of the run's completion instant,
    // so the write reads no billing state at all.
    const periodStart = periodStartFor(event.completedAt);

    let liveChargedMinutes = 0;
    try {
      await withSystemContext(async (tx) => {
        await ciWorkflowRunUsageRepository.create(
          {
            workspaceId: attribution.workspaceId,
            organizationId: attribution.organizationId,
            projectId: attribution.projectId,
            githubRepoId: attribution.githubRepoId,
            runId: event.runId,
            runAttempt: event.attempt,
            repoOwner: event.repoOwner,
            repoName: event.repoName,
            workflowName: event.workflowName,
            periodStart,
            runCompletedAt: event.completedAt,
            billableMinutes: usage.billableMinutes,
            rawWallClockSeconds: usage.rawWallClockSeconds,
            linearEquivalentMinutes: usage.linearEquivalentMinutes,
            jobCount: usage.jobCount,
            runnerBreakdown: usage.breakdown as unknown as Prisma.InputJsonValue,
          },
          tx,
        );
        // ⚠️ RECONCILIATION, NOT A SECOND CHARGE (MOTIR-6910 ·
        // `fleet-per-org-pool.md` §3). A run on Motir's fleet was already added to
        // the rollup while it ran, a whole minute at a time, by the live charge.
        // The audit row above keeps GitHub's full figure; the rollup takes only
        // what GitHub bills beyond what was charged live — the partial last
        // minute and the per-job rounding. When the live figure is the larger
        // (container time GitHub does not bill), the excess is NOTED, never
        // refunded and never charged again. A GitHub-hosted run has no live rows,
        // so it is metered exactly as before.
        const liveSeconds = await ciLiveAccrualRepository.sumSecondsForRun(
          event.runId,
          event.attempt,
          tx,
        );
        liveChargedMinutes = liveSeconds / 60;
        if (liveChargedMinutes > usage.linearEquivalentMinutes) {
          console.warn(
            '[ciMinutesMeterService] live-charged minutes exceed GitHub’s figure for this run — noted, nothing more charged',
            {
              runId: event.runId,
              runAttempt: event.attempt,
              liveChargedMinutes,
              linearEquivalentMinutes: usage.linearEquivalentMinutes,
            },
          );
        }
        await ciPeriodUsageRepository.incrementForPeriod(
          {
            workspaceId: attribution.workspaceId,
            organizationId: attribution.organizationId,
            periodStart,
            billableMinutes: Math.max(0, usage.billableMinutes - liveChargedMinutes),
            rawWallClockSeconds: Math.max(0, usage.rawWallClockSeconds - liveSeconds),
            linearEquivalentMinutes: Math.max(
              0,
              usage.linearEquivalentMinutes - liveChargedMinutes,
            ),
          },
          tx,
        );
      });
    } catch (err) {
      // The idempotency guarantee. A concurrent or retried delivery loses the
      // race on `(run_id, run_attempt)`; because the rollup increment shares this
      // transaction, it rolls back WITH the failed insert — so a duplicate can
      // never inflate the period total. Caught OUTSIDE the transaction on
      // purpose: a failed statement aborts the Postgres transaction, so catching
      // it inside and continuing would only produce a second, more confusing
      // error (25P02).
      if (isUniqueViolation(err)) {
        return { outcome: 'duplicate', runId: event.runId, runAttempt: event.attempt };
      }
      throw err;
    }

    return {
      outcome: 'metered',
      runId: event.runId,
      runAttempt: event.attempt,
      organizationId: attribution.organizationId,
      workspaceId: attribution.workspaceId,
      projectId: attribution.projectId,
      periodStart,
      billableMinutes: usage.billableMinutes,
      linearEquivalentMinutes: usage.linearEquivalentMinutes,
      liveChargedMinutes,
      isMeta: attribution.isMeta,
    };
  },

  /**
   * THE SEAM (§Consequences: "the seam between them is one read"). How many
   * Linux-equivalent minutes has this org consumed in the period containing
   * `at`? MOTIR-1901 measures its `max(members × 300, 1000)` pool against
   * exactly this and nothing else.
   *
   * It counts PREVIEW usage too (MOTIR-5777, `ci-minutes-allowance.md`
   * amendment 2026-10-29): a Motir-hosted repository's pull-request previews,
   * converted to Linux-equivalent minutes at MOTIR-5769 §9's factors, are in the
   * same pool, so the existing thresholds and `ci_overage` debit apply to them
   * with no second path. `bySource` says where the minutes went;
   * `billableMinutes` and `runCount` stay the Actions figures.
   *
   * Deliberately returns consumption ONLY — no pool, no balance, no verdict.
   * Those are the entitlement's, and keeping them out of the meter is what lets
   * this half stay a pure measurement with no billing coupling.
   */
  async getOrgPeriodConsumption(organizationId: string, at: Date): Promise<OrgPeriodConsumption> {
    const periodStart = periodStartFor(at);
    return withSystemContext(async (tx) => {
      const ci = await ciPeriodUsageRepository.sumForOrgPeriod(organizationId, periodStart, tx);
      const preview = await previewUsageRepository.sumLinuxMinutesForOrgPeriod(
        organizationId,
        periodStart,
        tx,
      );
      return {
        ...ci,
        linearEquivalentMinutes: ci.linearEquivalentMinutes + preview,
        bySource: { ci: ci.linearEquivalentMinutes, preview },
      };
    });
  },

  /**
   * Per-repository metered totals for an org's period — what the monthly
   * reconciliation (§5.8) compares against GitHub's own billing report.
   */
  async getOrgPeriodTotalsByRepo(organizationId: string, at: Date): Promise<RepoPeriodTotal[]> {
    const periodStart = periodStartFor(at);
    return withSystemContext((tx) =>
      ciWorkflowRunUsageRepository.sumByRepoForOrgPeriod(
        organizationId,
        periodStart,
        periodEndFor(periodStart),
        tx,
      ),
    );
  },

  /** Motir's provisioning org login, re-exported so the reconciliation job and
   *  tests read the same configured value the §5.1 gate does. */
  provisioningOrg(): string | null {
    return provisioningOrgLogin();
  },
};

/** A Postgres unique-constraint violation, surfaced by Prisma as P2002. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

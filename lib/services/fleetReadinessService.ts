import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { fleetKillSwitchEngaged } from '@/lib/ciFleet/limits';
import { requestsFleetRunner } from '@/lib/ciFleet/jobCoverage';
import { RUNNER_IMAGE_TOOLS_LABEL } from '@/lib/ciFleet/runnerImageTools';
import {
  getOrgInstallation,
  listInstallationRepositoryIds,
  OrgInstallationReadError,
  type OrgInstallation,
} from '@/lib/github/orgInstallation';
import { OrgTargetAuthError, type GithubOrgTarget } from '@/lib/github/orgTarget';
import { repoVisibilityClient, RepoVisibilityApiError } from '@/lib/github/repoVisibility';
import { runnerImageToolsService } from '@/lib/services/runnerImageToolsService';
import { workflowCoverageService } from '@/lib/services/workflowCoverageService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { projectRunnerGroupService } from '@/lib/services/projectRunnerGroupService';

// CAN THE FLEET SERVE THIS CONNECTED ORG'S CI RIGHT NOW? (Story MOTIR-8699 ·
// MOTIR-8713)
//
// One READ-ONLY verdict over nine conditions, each predicting whether a line of
// production code will refuse a job, in the order a job meets them:
//
//   1 kill_switch               boot allowed       `lib/ciFleet/limits.ts` fleetKillSwitchEngaged
//   2 app_installed             GitHub delivers    the App is on the org at all
//   3 app_runner_permission     a runner registers runnerJitConfigClient / runnerGroupClient
//   4 app_variables_permission  the flip writes MOTIR_RUNNER (actionsVariablesClient)
//   5 workflow_job_subscription GitHub delivers    the App receives `workflow_job`
//   6 app_repositories          GitHub delivers    the installation reaches each repo
//   7 delivery_attributable     Motir attributes   ciRunnerProvisioningService.recordQueuedJob
//   8 runner_group              a runner registers ciRunnerBootService → requireRunnerGroupIdFor
//   9 image_coverage            the job can run    the jobs at each repo's head vs the pinned image
//
// ⚠️ FAILS CLOSED. A read that failed is `unknown`, never `met`, and `ready` is
// true only when all nine are `met`. `unknown` is its own state so a page can
// tell "GitHub did not answer" apart from "the App lacks the permission"; both
// block ON.
//
// ⚠️ NAMES NO ORG. The org arrives as data; there is no `isMeta`, no login
// constant and no org id here. Credits are deliberately NOT a condition: an
// internally-billed org bypasses admission, so reading admission here would put
// an org-identity branch into a service that must have none.
//
// Only PRIVATE repositories count anywhere: the runner group access-lists private
// repositories only, so a public one never requests the fleet.

export type FleetReadinessState = 'met' | 'unmet' | 'unknown';

export type FleetReadinessKey =
  | 'kill_switch'
  | 'app_installed'
  | 'app_runner_permission'
  | 'app_variables_permission'
  | 'workflow_job_subscription'
  | 'app_repositories'
  | 'delivery_attributable'
  | 'runner_group'
  | 'image_coverage';

export interface FleetReadinessCondition {
  key: FleetReadinessKey;
  state: FleetReadinessState;
  reasonCode: string;
  params: Record<string, unknown>;
  /** English, for logs, audit reasons and refusals. The UI renders `reasonCode`. */
  message: string;
}

export interface FleetReadiness {
  ready: boolean;
  org: string;
  /** ISO-8601. */
  checkedAt: string;
  conditions: FleetReadinessCondition[];
}

export interface FleetReadinessTarget {
  projectId: string;
  workspaceId: string;
  org: string;
}

/** The project the verdict was asked about does not exist in that workspace — a
 *  programmer error, the one thing `readinessFor` throws. */
export class FleetReadinessTargetNotFoundError extends Error {
  readonly code = 'FLEET_READINESS_TARGET_NOT_FOUND' as const;
  constructor(readonly projectId: string) {
    super(`Project ${projectId} was not found; the readiness verdict has nothing to check.`);
    this.name = 'FleetReadinessTargetNotFoundError';
  }
}

export interface FleetReadinessOptions {
  now?: () => Date;
}

const SYNC_SCRIPT = 'scripts/ci-fleet/sync-project-runner-groups.ts';
const RUNNER_PERMISSION = 'organization_self_hosted_runners';
const VARIABLES_PERMISSION = 'organization_actions_variables';

interface OrgRepo {
  owner: string;
  name: string;
  providerRepoId: string;
}

function condition(
  key: FleetReadinessKey,
  state: FleetReadinessState,
  reasonCode: string,
  message: string,
  params: Record<string, unknown> = {},
): FleetReadinessCondition {
  return { key, state, reasonCode, params, message };
}

/** A failure's status, without its message — a thrown GitHub error's text is
 *  never copied into a verdict. */
function statusOf(err: unknown): number | null {
  if (
    err instanceof OrgInstallationReadError ||
    err instanceof OrgTargetAuthError ||
    err instanceof RepoVisibilityApiError
  ) {
    return err.status;
  }
  return null;
}

function failedRead(key: FleetReadinessKey, what: string, err: unknown): FleetReadinessCondition {
  const status = statusOf(err);
  console.warn('[fleetReadinessService] a readiness read failed', { key, status });
  return condition(
    key,
    'unknown',
    'read_failed',
    status === null
      ? `Could not check ${what}: GitHub could not be reached.`
      : `Could not check ${what}: GitHub answered HTTP ${status}.`,
    { status },
  );
}

const fullName = (r: { owner: string; name: string }) => `${r.owner}/${r.name}`;

/** Can a job's `runs-on` resolve to the fleet? (MOTIR-8813) — the rule lives with
 *  the job judge (`lib/ciFleet/jobCoverage.ts`); re-exported for its callers. */
export { requestsFleetRunner };

export const fleetReadinessService = {
  async readinessFor(
    target: FleetReadinessTarget,
    options: FleetReadinessOptions = {},
  ): Promise<FleetReadiness> {
    const now = options.now ?? (() => new Date());
    const org = target.org.trim();
    const orgKey = org.toLowerCase();

    const loaded = await withWorkspaceServiceContext(target.workspaceId, async (tx) => {
      const project = await projectRepository.findById(target.projectId, tx);
      if (!project || project.workspaceId !== target.workspaceId) return null;
      const realized = await projectRepoRepository.listEstablishedRealizedRepos(
        target.projectId,
        target.workspaceId,
        tx,
      );
      return { identifier: project.identifier, realized };
    });
    if (!loaded) throw new FleetReadinessTargetNotFoundError(target.projectId);
    const orgRepos: OrgRepo[] = loaded.realized.filter(
      (r) => r.owner.trim().toLowerCase() === orgKey,
    );

    const conditions: FleetReadinessCondition[] = [];

    // ── 1 · kill_switch ──────────────────────────────────────────────────────
    conditions.push(
      fleetKillSwitchEngaged()
        ? condition(
            'kill_switch',
            'unmet',
            'kill_switch_engaged',
            'The fleet kill switch is engaged (MOTIR_FLEET_MAX_IN_FLIGHT=0); no fleet machine will boot. An operator must unset or raise it.',
          )
        : condition('kill_switch', 'met', 'kill_switch_off', 'The fleet kill switch is off.'),
    );

    // ── 2 · app_installed — ONE read answers conditions 2–5 ──────────────────
    let installation: OrgInstallation | null = null;
    let installRead: FleetReadinessCondition;
    try {
      installation = await getOrgInstallation(org, 'provisioning');
      if (!installation) {
        installRead = condition(
          'app_installed',
          'unmet',
          'app_not_installed',
          `The motir-studio App is not installed on ${org}. An owner of ${org} must install it.`,
          { org },
        );
      } else if (installation.suspendedAt) {
        installRead = condition(
          'app_installed',
          'unmet',
          'app_suspended',
          `The motir-studio App is installed on ${org} but suspended since ${installation.suspendedAt}. An owner of ${org} must unsuspend it.`,
          { org, suspendedAt: installation.suspendedAt },
        );
      } else {
        installRead = condition(
          'app_installed',
          'met',
          'app_installed',
          `The motir-studio App is installed on ${org}.`,
          { org, installationId: installation.id },
        );
      }
    } catch (err) {
      installRead = failedRead(
        'app_installed',
        `whether the motir-studio App is installed on ${org}`,
        err,
      );
    }
    conditions.push(installRead);

    const usable = installRead.state === 'met' && installation !== null ? installation : null;
    if (!usable) {
      // Everything that depends on the installation is unknown, never met.
      for (const key of [
        'app_runner_permission',
        'app_variables_permission',
        'workflow_job_subscription',
        'app_repositories',
        'delivery_attributable',
      ] as const) {
        conditions.push(
          condition(
            key,
            'unknown',
            'app_not_readable',
            `Cannot be checked until the motir-studio App is installed and readable on ${org}.`,
            { org },
          ),
        );
      }
      conditions.push(await runnerGroupCondition(target, org, loaded.identifier));
      conditions.push(
        condition(
          'image_coverage',
          'unknown',
          'app_not_readable',
          `Cannot be checked until the motir-studio App is installed and readable on ${org}: which repositories are private is read through it.`,
          { org },
        ),
      );
      return finish(org, now, conditions);
    }
    const orgTarget: GithubOrgTarget = { org, installationId: usable.id, role: 'provisioning' };

    // ── 3 · app_runner_permission ────────────────────────────────────────────
    conditions.push(
      permissionCondition(
        'app_runner_permission',
        usable,
        RUNNER_PERMISSION,
        org,
        'Self-hosted runners',
      ),
    );
    // ── 4 · app_variables_permission ─────────────────────────────────────────
    conditions.push(
      permissionCondition(
        'app_variables_permission',
        usable,
        VARIABLES_PERMISSION,
        org,
        'Variables',
      ),
    );
    // ── 5 · workflow_job_subscription ────────────────────────────────────────
    // The delivering installation needs NO mirror row: the intake attributes an
    // unmirrored provisioning-App installation through the repository's own row.
    // Condition 7 checks that path.
    conditions.push(
      usable.events.includes('workflow_job')
        ? condition(
            'workflow_job_subscription',
            'met',
            'subscribed',
            'The motir-studio App receives workflow_job events.',
          )
        : condition(
            'workflow_job_subscription',
            'unmet',
            'not_subscribed',
            `The motir-studio App installation on ${org} is not subscribed to workflow_job events, so GitHub never tells Motir a job is queued. Subscribe it in motir-studio's App settings.`,
            { org },
          ),
    );

    // The private set, which conditions 6, 7 and 9 consider.
    let privateRepos: OrgRepo[] | null = null;
    let visibilityFailure: unknown = null;
    try {
      privateRepos = [];
      for (const repo of orgRepos) {
        if (await repoVisibilityClient.isPrivate(repo.owner, repo.name, orgTarget)) {
          privateRepos.push(repo);
        }
      }
    } catch (err) {
      privateRepos = null;
      visibilityFailure = err;
    }

    if (privateRepos === null) {
      conditions.push(
        failedRead(
          'app_repositories',
          `which of the project's repositories are private`,
          visibilityFailure,
        ),
      );
      conditions.push(
        failedRead(
          'delivery_attributable',
          `which of the project's repositories are private`,
          visibilityFailure,
        ),
      );
      conditions.push(await runnerGroupCondition(target, org, loaded.identifier));
      conditions.push(
        failedRead(
          'image_coverage',
          `which of the project's repositories are private`,
          visibilityFailure,
        ),
      );
      return finish(org, now, conditions);
    }

    if (privateRepos.length === 0) {
      const message = `The project has no private repository in ${org}, so there is nothing for the fleet to run.`;
      conditions.push(
        condition('app_repositories', 'unmet', 'no_private_repositories', message, { org }),
      );
      conditions.push(
        condition('delivery_attributable', 'unmet', 'no_private_repositories', message, { org }),
      );
      conditions.push(await runnerGroupCondition(target, org, loaded.identifier));
      conditions.push(
        condition('image_coverage', 'unmet', 'no_private_repositories', message, { org }),
      );
      return finish(org, now, conditions);
    }

    // ── 6 · app_repositories ─────────────────────────────────────────────────
    conditions.push(await repositoriesCondition(orgTarget, privateRepos, org));
    // ── 7 · delivery_attributable ────────────────────────────────────────────
    conditions.push(await attributableCondition(target, usable.id, privateRepos, org));
    // ── 8 · runner_group ─────────────────────────────────────────────────────
    conditions.push(await runnerGroupCondition(target, org, loaded.identifier));
    // ── 9 · image_coverage ───────────────────────────────────────────────────
    conditions.push(await imageCoverageCondition(orgTarget, privateRepos));

    return finish(org, now, conditions);
  },

  /**
   * Condition 9 alone — image coverage — for the daily probe (MOTIR-10290). The
   * same reads, in the same order, as `readinessFor` makes for it: the
   * installation, which of the project's repositories in `org` are private, and
   * the coverage judgement. Every answer `readinessFor` gives condition 9 on the
   * way (`app_not_readable`, `read_failed`, `no_private_repositories`) is given
   * here too, so the probe and the page cannot disagree.
   *
   * @throws FleetReadinessTargetNotFoundError when the project does not exist.
   */
  async imageCoverageFor(target: FleetReadinessTarget): Promise<FleetReadinessCondition> {
    const org = target.org.trim();
    const orgKey = org.toLowerCase();
    const realized = await withWorkspaceServiceContext(target.workspaceId, async (tx) => {
      const project = await projectRepository.findById(target.projectId, tx);
      if (!project || project.workspaceId !== target.workspaceId) return null;
      return projectRepoRepository.listEstablishedRealizedRepos(
        target.projectId,
        target.workspaceId,
        tx,
      );
    });
    if (!realized) throw new FleetReadinessTargetNotFoundError(target.projectId);
    const orgRepos: OrgRepo[] = realized.filter((r) => r.owner.trim().toLowerCase() === orgKey);

    let installation: OrgInstallation | null;
    try {
      installation = await getOrgInstallation(org, 'provisioning');
    } catch (err) {
      return failedRead(
        'image_coverage',
        `whether the motir-studio App is installed on ${org}`,
        err,
      );
    }
    if (!installation || installation.suspendedAt) {
      return condition(
        'image_coverage',
        'unknown',
        'app_not_readable',
        `Cannot be checked until the motir-studio App is installed and readable on ${org}: which repositories are private is read through it.`,
        { org },
      );
    }
    const orgTarget: GithubOrgTarget = {
      org,
      installationId: installation.id,
      role: 'provisioning',
    };
    const privateRepos: OrgRepo[] = [];
    try {
      for (const repo of orgRepos) {
        if (await repoVisibilityClient.isPrivate(repo.owner, repo.name, orgTarget)) {
          privateRepos.push(repo);
        }
      }
    } catch (err) {
      return failedRead('image_coverage', `which of the project's repositories are private`, err);
    }
    if (privateRepos.length === 0) {
      return condition(
        'image_coverage',
        'unmet',
        'no_private_repositories',
        `The project has no private repository in ${org}, so there is nothing for the fleet to run.`,
        { org },
      );
    }
    return imageCoverageCondition(orgTarget, privateRepos);
  },
};

function finish(
  org: string,
  now: () => Date,
  conditions: FleetReadinessCondition[],
): FleetReadiness {
  return {
    ready: conditions.every((c) => c.state === 'met'),
    org,
    checkedAt: now().toISOString(),
    conditions,
  };
}

function permissionCondition(
  key: 'app_runner_permission' | 'app_variables_permission',
  installation: OrgInstallation,
  permission: string,
  org: string,
  label: string,
): FleetReadinessCondition {
  const granted = installation.permissions[permission] ?? null;
  if (granted === 'write') {
    return condition(
      key,
      'met',
      'granted',
      `The motir-studio App holds ${label}: write on ${org}.`,
      {
        permission,
        granted,
      },
    );
  }
  return condition(
    key,
    'unmet',
    granted === null ? 'permission_missing' : 'permission_insufficient',
    `The motir-studio App installation on ${org} holds ${label}: ${granted ?? 'none'}, and needs write. An owner of ${org} must accept the permission request.`,
    { permission, granted, org },
  );
}

async function repositoriesCondition(
  orgTarget: GithubOrgTarget,
  privateRepos: OrgRepo[],
  org: string,
): Promise<FleetReadinessCondition> {
  let reachable: Set<number>;
  try {
    reachable = new Set(await listInstallationRepositoryIds(orgTarget));
  } catch (err) {
    return failedRead(
      'app_repositories',
      `which repositories the installation on ${org} reaches`,
      err,
    );
  }
  const missing = privateRepos
    .filter((r) => !reachable.has(Number(r.providerRepoId)))
    .map(fullName);
  if (missing.length === 0) {
    return condition(
      'app_repositories',
      'met',
      'all_reachable',
      `The installation on ${org} reaches every private repository of the project.`,
      { repositories: privateRepos.map(fullName) },
    );
  }
  return condition(
    'app_repositories',
    'unmet',
    'repositories_not_granted',
    `The motir-studio App installation on ${org} does not reach ${missing.join(', ')}. An owner of ${org} must add them to the installation's repository access.`,
    { missing, org },
  );
}

/**
 * The lookup `recordQueuedJob` will make for a delivery on this installation —
 * the SAME repository functions, under the same system context, so the verdict
 * cannot drift from the code it predicts.
 */
async function attributableCondition(
  target: FleetReadinessTarget,
  installationId: string,
  privateRepos: OrgRepo[],
  org: string,
): Promise<FleetReadinessCondition> {
  const orgKey = org.toLowerCase();
  let failures: Array<{
    repository: string;
    reason: 'no_row' | 'several_rows' | 'owner_mismatch' | 'other_workspace';
  }>;
  let path: 'mirrored' | 'unmirrored';
  try {
    ({ failures, path } = await withSystemContext(async (tx) => {
      const mirror = await githubInstallationRepository.findByInstallationId(installationId, tx);
      const out: typeof failures = [];
      for (const repo of privateRepos) {
        const repository = fullName(repo);
        if (mirror) {
          const row = await githubRepoRepository.findByInstallationAndRepoId(
            mirror.id,
            repo.providerRepoId,
            tx,
          );
          if (!row) out.push({ repository, reason: 'no_row' });
          else if (row.workspaceId !== target.workspaceId) {
            out.push({ repository, reason: 'other_workspace' });
          }
          continue;
        }
        const rows = await githubRepoRepository.listByRepoId(repo.providerRepoId, tx);
        if (rows.length === 0) out.push({ repository, reason: 'no_row' });
        else if (rows.length > 1) out.push({ repository, reason: 'several_rows' });
        else if (rows[0]!.owner.trim().toLowerCase() !== orgKey) {
          out.push({ repository, reason: 'owner_mismatch' });
        } else if (rows[0]!.workspaceId !== target.workspaceId) {
          out.push({ repository, reason: 'other_workspace' });
        }
      }
      return { failures: out, path: mirror ? ('mirrored' as const) : ('unmirrored' as const) };
    }));
  } catch (err) {
    console.warn('[fleetReadinessService] the attribution read failed', {
      key: 'delivery_attributable',
    });
    return condition(
      'delivery_attributable',
      'unknown',
      'read_failed',
      `Could not check how Motir would attribute a job from ${org}: ${err instanceof Error ? err.name : 'read failed'}.`,
    );
  }
  if (failures.length === 0) {
    return condition(
      'delivery_attributable',
      'met',
      'attributable',
      `A queued job from each private repository in ${org} resolves to this project.`,
      { path },
    );
  }
  const words: Record<string, string> = {
    no_row: 'no mirror row',
    several_rows: 'several mirror rows',
    owner_mismatch: `a mirror row whose owner is not ${org}`,
    other_workspace: 'a mirror row in another workspace',
  };
  return condition(
    'delivery_attributable',
    'unmet',
    'not_attributable',
    `A queued job from ${failures
      .map((f) => `${f.repository} (${words[f.reason]})`)
      .join(
        ', ',
      )} would not be attributed to this project, so it would stay queued until GitHub expires it. Reconnect the repository to the project so its mirror row is current.`,
    { failures, path, org },
  );
}

async function runnerGroupCondition(
  target: FleetReadinessTarget,
  org: string,
  projectKey: string,
): Promise<FleetReadinessCondition> {
  const fix = `Run ${SYNC_SCRIPT} --project ${projectKey}.`;
  let row: Awaited<ReturnType<typeof projectRunnerGroupService.readForOrg>>;
  try {
    row = await projectRunnerGroupService.readForOrg(
      { projectId: target.projectId, workspaceId: target.workspaceId },
      org,
    );
  } catch (err) {
    console.warn('[fleetReadinessService] the runner-group read failed', { key: 'runner_group' });
    return condition(
      'runner_group',
      'unknown',
      'read_failed',
      `Could not read the project's runner group in ${org} (${err instanceof Error ? err.name : 'read failed'}).`,
    );
  }
  if (!row) {
    return condition(
      'runner_group',
      'unmet',
      'no_runner_group',
      `The project has no runner group in ${org}. ${fix}`,
      { org, script: SYNC_SCRIPT, projectKey },
    );
  }
  if (row.syncPending) {
    return condition(
      'runner_group',
      'unmet',
      'sync_pending',
      `The project's runner group in ${org} is out of sync with its repositories. ${fix}`,
      { org, script: SYNC_SCRIPT, projectKey, runnerGroupId: row.runnerGroupId },
    );
  }
  return condition(
    'runner_group',
    'met',
    'group_synced',
    `The project's runner group in ${org} exists and is in sync.`,
    { org, runnerGroupId: row.runnerGroupId, runnerGroupName: row.runnerGroupName },
  );
}

/** One job the image cannot run, or cannot be judged — `params.jobs` on the page. */
interface CoverageGapJob {
  repoRef: string;
  workflow: string;
  jobId: string;
  verdict: 'needs-image' | 'cannot-host' | 'unverified';
  /** Tools the image lacks; `unverified` is listed when something could not be
   *  judged, as the hand inventory listed it (MOTIR-8870). */
  missing: string[];
  reason: string | null;
}

function gapWords(job: CoverageGapJob): string {
  const tools = job.missing.filter((t) => t !== 'unverified');
  const parts: string[] = [];
  if (job.verdict === 'cannot-host') parts.push(`can't be hosted: ${job.reason ?? ''}`);
  if (tools.length > 0) parts.push(`needs ${tools.join(', ')}, which the image lacks`);
  if (job.verdict === 'unverified') parts.push(`can't be judged: ${job.reason ?? ''}`);
  return `${job.repoRef} ${job.workflow.split('/').pop()} ${job.jobId} (${parts.join('; ')})`;
}

async function imageCoverageCondition(
  orgTarget: GithubOrgTarget,
  privateRepos: OrgRepo[],
): Promise<FleetReadinessCondition> {
  // ⚠️ COMPUTED, NOT RECORDED (MOTIR-10290). Each private repository's jobs are
  // read from its workflows at its newest `.github` commit and judged against the
  // tool list the PINNED runner image records about itself. There is no snapshot
  // of a private repository to go stale, so a workflow change is judged the next
  // time this runs, and an unmet verdict names the job and the tool.
  const image = await runnerImageToolsService.read();
  if (image.state === 'unset') {
    return condition(
      'image_coverage',
      'unmet',
      'runner_image_unset',
      'This deployment pins no runner image (MOTIR_RUNNER_IMAGE is unset), so no job can be judged against one.',
      { variable: 'MOTIR_RUNNER_IMAGE' },
    );
  }
  if (image.state === 'unreadable') {
    console.warn('[fleetReadinessService] the runner image read failed', {
      key: 'image_coverage',
      reason: image.reason,
    });
    return condition(
      'image_coverage',
      'unknown',
      'image_unreadable',
      `Could not read the tool list of the pinned runner image ${image.image}: ${image.detail}.`,
      { image: image.image, reason: image.reason },
    );
  }
  if (image.state === 'unrecorded') {
    return condition(
      'image_coverage',
      'unmet',
      'image_tools_unrecorded',
      `The pinned runner image ${image.image} records no tool list (the ${RUNNER_IMAGE_TOOLS_LABEL} label), so its jobs cannot be judged. Release a runner image built from this version of motir-core and pin its digest.`,
      { image: image.image, label: RUNNER_IMAGE_TOOLS_LABEL },
    );
  }

  const jobs: CoverageGapJob[] = [];
  const githubHostedJobs: Array<{ repoRef: string; workflow: string; jobId: string }> = [];
  const heads: Array<{ repository: string; headSha: string | null }> = [];
  for (const repo of privateRepos) {
    const coverage = await workflowCoverageService.repositoryCoverage(
      orgTarget,
      repo.owner,
      repo.name,
      image.tools,
    );
    if (coverage.state === 'unreadable') {
      // ⚠️ FAILS CLOSED: workflows that cannot be read are never "runnable".
      return failedRead('image_coverage', `the workflows of ${fullName(repo)}`, coverage.error);
    }
    heads.push({ repository: fullName(repo), headSha: coverage.headSha });
    for (const job of coverage.jobs) {
      const at = { repoRef: fullName(repo), workflow: job.workflow, jobId: job.jobId };
      if (job.verdict === 'github-hosted') githubHostedJobs.push(at);
      if (job.verdict === 'github-hosted' || job.verdict === 'runnable') continue;
      jobs.push({
        ...at,
        verdict: job.verdict,
        missing: job.verdict === 'unverified' ? [...job.missing, 'unverified'] : job.missing,
        reason: job.unjudged.length > 0 ? job.unjudged.join('; ') : null,
      });
    }
  }

  const scope = `Judged against each repository's workflows at its newest commit and the tool list of the pinned runner image ${image.image}.`;
  if (jobs.length > 0) {
    return condition(
      'image_coverage',
      'unmet',
      'jobs_not_runnable',
      `${jobs.length} job${jobs.length === 1 ? '' : 's'} cannot run on the fleet runner image yet: ${jobs
        .map(gapWords)
        .join('; ')}. ${scope}`,
      { jobs, githubHostedJobs, heads, image: image.image },
    );
  }
  return condition(
    'image_coverage',
    'met',
    'all_runnable',
    `Every job the project's private repositories send to the fleet can run on the fleet runner image. ${scope}`,
    { repositories: privateRepos.map(fullName), githubHostedJobs, heads, image: image.image },
  );
}

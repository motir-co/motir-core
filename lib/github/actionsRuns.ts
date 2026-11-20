import { githubFetch } from '@/lib/github/githubFetch';
import { mintInstallationToken } from '@/lib/github/appAuth';
import { resolveOrgAuth, type GithubOrgTarget } from '@/lib/github/orgTarget';

// The Actions-RUNS boundary (Story MOTIR-6906 · MOTIR-6908) — the one module that
// lists a repository's live workflow runs and cancels them.
//
// It is the sibling of `lib/github/actionsPermissions.ts` and follows its shape:
// all of the host mechanics live here, none of the row bookkeeping does, and the
// line between them is where the tests fake. Services import it directly; routes
// never do (a LEAF PRIMITIVE, in the `appAuth.ts` sense).
//
// It authenticates as the PROVISIONING App's installation (`appAuth.ts`), which
// already holds "Actions" write on the repositories it created — cancelling a run
// adds no App permission. Like the permissions client, it only ever touches
// repositories Motir created, in Motir's own GitHub org, so it is not on the
// `GitProvider` seam.

const GITHUB_API = 'https://api.github.com';

/** Every call here runs inside a background job, and `fetch` has no timeout of
 *  its own (`docs/jobs.md` rule 3). */
const REQUEST_TIMEOUT_MS = 15_000;

/** The run statuses a stop cancels: everything GitHub has not finished. */
export const ACTIVE_RUN_STATUSES = ['in_progress', 'queued'] as const;

/** One page is GitHub's maximum; an org's repo with more live runs than this is
 *  stopped again on the next pass, which finds the rest. */
const RUNS_PER_PAGE = 100;

/** Every failure this module raises. No raw GitHub body ever escapes. */
export class ActionsRunsError extends Error {
  readonly code = 'ACTIONS_RUNS_FAILED' as const;
  constructor(
    readonly status: number | null,
    readonly detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached for workflow runs (${detail}).`
        : `GitHub refused a workflow-runs call (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'ActionsRunsError';
  }
}

export interface ActionsRepoRef {
  /** GitHub's NUMERIC id of the installation the repository lives in — for a
   *  Motir-created repo, the PROVISIONING installation. It is
   *  `GithubInstallation.installationId`, NOT the mirror row's `installationId`,
   *  which is the foreign key to Motir's own cuid (MOTIR-10071). */
  installationId: string;
  owner: string;
  repo: string;
}

/** A repository a job RE-RUN is asked on (MOTIR-11728), and the installation
 *  the job's runner was registered through: `target` as
 *  `fleetRunnerTargetFor(intent)` answers it — `undefined` for the provisioning
 *  org, which `resolveOrgAuth` resolves to `provisioningAuth()`. */
export interface ActionsRerunRef {
  owner: string;
  repo: string;
  target: GithubOrgTarget | undefined;
}

/** The statuses `rerunJob` answers as a refusal rather than an error. */
export const RERUN_REFUSAL_STATUSES = [403, 404, 409, 422] as const;
export type RerunRefusalStatus = (typeof RERUN_REFUSAL_STATUSES)[number];

/**
 * GitHub declined to re-run a job (MOTIR-11728). `mayClear` says whether asking
 * again later can succeed:
 *   - `409` — a conflict with the run's current state: may clear.
 *   - `403` — GitHub answers it both for a run still in progress and for an
 *     installation without Actions write; the run's own status tells the two
 *     apart, so it may clear only while the run is unfinished.
 *   - `404` — the job, run or repository is gone: never clears.
 *   - `422` — the request cannot be processed (GitHub's re-run limits): never clears.
 * Carries GitHub's status only — never its body.
 */
export interface JobRerunRefusal {
  readonly refused: true;
  readonly status: RerunRefusalStatus;
  readonly mayClear: boolean;
}

export interface ActiveWorkflowRun {
  id: number;
  status: string;
}

export const actionsRunsClient = {
  /**
   * Every run on one repository that is `in_progress` or `queued`.
   *
   * A `404` answers an empty list: the repository is gone (deleted, or handed off
   * out of Motir's org), so nothing on it is Motir's to cancel.
   */
  async listActiveRuns(ref: ActionsRepoRef): Promise<ActiveWorkflowRun[]> {
    const token = await mintToken(ref.installationId);
    const runs: ActiveWorkflowRun[] = [];
    for (const status of ACTIVE_RUN_STATUSES) {
      const res = await call(
        `${repoUrl(ref)}/actions/runs?status=${status}&per_page=${RUNS_PER_PAGE}`,
        'GET',
        token,
      );
      if (res.status === 404) return [];
      if (res.status !== 200) throw new ActionsRunsError(res.status, await errorDetail(res));
      const body = (await res.json()) as { workflow_runs?: { id: number; status: string }[] };
      for (const run of body.workflow_runs ?? []) runs.push({ id: run.id, status: run.status });
    }
    return runs;
  },

  /**
   * Cancel one run. Answers `true` when GitHub accepted the cancel (`202`), and
   * `false` when there was nothing left to cancel: `409` (the run finished in the
   * meantime) or `404` (the run or its repository is gone). Both of those are the
   * outcome a stop wants, so neither is an error.
   */
  async cancelRun(ref: ActionsRepoRef, runId: number): Promise<boolean> {
    const token = await mintToken(ref.installationId);
    const res = await call(`${repoUrl(ref)}/actions/runs/${runId}/cancel`, 'POST', token);
    if (res.status === 202) return true;
    if (res.status === 409 || res.status === 404) return false;
    throw new ActionsRunsError(res.status, await errorDetail(res));
  },

  /**
   * Re-run ONE job of a workflow run (MOTIR-11728) — the job a Spot-reclaimed
   * runner was working — through the installation its runner was registered
   * through. `POST /repos/{owner}/{repo}/actions/jobs/{job_id}/rerun`; GitHub
   * documents `201` and `403` (REST docs, Workflow runs › Re-run a job from a
   * workflow run). Answers `true` on `201`, a {@link JobRerunRefusal} on
   * 403/404/409/422, and throws {@link ActionsRunsError} on anything else or when
   * GitHub cannot be reached. A `403` also reads the run's status (`runId`), so
   * a run that has not finished yet reads as a refusal that may clear.
   */
  async rerunJob(
    ref: ActionsRerunRef,
    jobId: string,
    runId: string,
  ): Promise<true | JobRerunRefusal> {
    const token = await rerunToken(ref.target);
    const res = await call(
      `${repoUrl(ref)}/actions/jobs/${encodeURIComponent(jobId)}/rerun`,
      'POST',
      token,
    );
    if (res.status === 201) return true;
    if (res.status === 409) return { refused: true, status: 409, mayClear: true };
    if (res.status === 404 || res.status === 422) {
      return { refused: true, status: res.status, mayClear: false };
    }
    if (res.status === 403) {
      return { refused: true, status: 403, mayClear: await runUnfinished(ref, runId, token) };
    }
    throw new ActionsRunsError(res.status, await errorDetail(res));
  },
};

/** Whether a run has NOT finished (any status but `completed`). A run that
 *  cannot be read answers `false`: a 403 is then taken at its word. */
async function runUnfinished(
  ref: Pick<ActionsRerunRef, 'owner' | 'repo'>,
  runId: string,
  token: string,
): Promise<boolean> {
  let res: Response;
  try {
    res = await call(`${repoUrl(ref)}/actions/runs/${encodeURIComponent(runId)}`, 'GET', token);
  } catch {
    return false;
  }
  if (res.status !== 200) return false;
  try {
    const body = (await res.json()) as { status?: unknown };
    return typeof body.status === 'string' && body.status !== 'completed';
  } catch {
    return false;
  }
}

/** A token for the runner's installation. A failed mint is an `ActionsRunsError`
 *  with no status: it may clear, and never carries a token. */
async function rerunToken(target: GithubOrgTarget | undefined): Promise<string> {
  try {
    return (await resolveOrgAuth(target)).token;
  } catch (err) {
    throw new ActionsRunsError(null, err instanceof Error ? err.message : 'unknown');
  }
}

function repoUrl(ref: Pick<ActionsRepoRef, 'owner' | 'repo'>): string {
  return `${GITHUB_API}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
}

async function call(url: string, method: 'GET' | 'POST', token: string): Promise<Response> {
  try {
    return await githubFetch('actionsRuns', url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'motir',
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ActionsRunsError(null, err instanceof Error ? err.message : 'unknown');
  }
}

async function mintToken(installationId: string): Promise<string> {
  try {
    const { token } = await mintInstallationToken(installationId, 'provisioning');
    return token;
  } catch (err) {
    throw new ActionsRunsError(null, err instanceof Error ? err.message : 'unknown');
  }
}

/** GitHub's `message`, trimmed to a short developer detail — never the payload. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    const message =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['message']
        : null;
    return typeof message === 'string' ? message.slice(0, 200) : '';
  } catch {
    return '';
  }
}

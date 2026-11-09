import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { resolveOrgAuth, type GithubOrgTarget } from '@/lib/github/orgTarget';

// WHAT GITHUB HOLDS QUEUED FOR THE FLEET (Bug MOTIR-8976) — the read side of the
// reconcile sweep. The fleet's own intents are a record of what it was TOLD, and a
// fleet runner is not tied to a job (GitHub gives a new runner to the OLDEST queued
// job carrying the label), so the only record that survives a lost runner is
// GitHub's own queue. This module reads that queue and the org's live runners,
// authenticated through the same `resolveOrgAuth(target)` the boot and settle
// paths use: no target is the provisioning org, a target is a connected org.

const GITHUB_API = 'https://api.github.com';

/** Every call runs inside a background job, and `fetch` has no timeout of its own. */
const REQUEST_TIMEOUT_MS = 15_000;

/** GitHub's page maximum. A repo with more live runs than this is finished by the
 *  next tick, which sees what is left. */
const PER_PAGE = 100;

/** Pages of the org runner list read per org — the fleet's pool is bounded well
 *  below this. */
const MAX_RUNNER_PAGES = 5;

export class FleetQueueApiError extends Error {
  readonly code = 'FLEET_QUEUE_API_FAILED' as const;
  constructor(
    readonly status: number | null,
    detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached for the fleet queue (${detail}).`
        : `GitHub refused a fleet-queue call (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'FleetQueueApiError';
  }
}

/** One job GitHub holds queued for the fleet label. */
export interface QueuedFleetJob {
  runId: string;
  runAttempt: number;
  jobId: string;
  jobName: string | null;
  workflowName: string | null;
  repoOwner: string;
  repoName: string;
  labels: string[];
  /** When GitHub created the job — the age the reconcile grace is measured from. */
  createdAt: Date;
}

/** A runner registered in the org, as far as coverage needs to know. */
export interface OrgRunner {
  id: number;
  name: string;
  online: boolean;
  busy: boolean;
  labels: string[];
}

export interface FleetQueueRepoRef {
  owner: string;
  repo: string;
}

/** A run whose jobs GitHub would not list — left out of this read (MOTIR-10790). */
export interface SkippedFleetRun {
  repoOwner: string;
  repoName: string;
  runId: string;
  /** GitHub's HTTP status, or `null` when GitHub could not be reached at all. */
  status: number | null;
  detail: string;
}

/** One repository's queued fleet jobs, and the runs that could not be read. */
export interface QueuedFleetJobsRead {
  jobs: QueuedFleetJob[];
  skippedRuns: SkippedFleetRun[];
}

export const fleetQueueClient = {
  /**
   * Every job of one repository that is `queued` AND asks for the fleet label.
   * A run that is `in_progress` can still hold queued jobs (PR #785's `CI complete`
   * sat behind finished siblings), so both active run statuses are read. A `404`
   * answers an empty list: the repository is gone or no longer visible.
   *
   * ⚠️ ONE UNREADABLE RUN IS SKIPPED, NOT FATAL (Bug MOTIR-10790). GitHub can
   * answer one run's jobs read with a 5xx for hours while every other run reads
   * fine (motir-meta run 42516284826 answered 502 on every read). Throwing there
   * aborted the whole org's reconcile, so every stranded job in the org waited
   * with it. A failed jobs read now skips that run and names it in `skippedRuns`;
   * the runs-list reads stay fatal, because without them nothing about the
   * repository is known and the caller must report it as a failure.
   */
  async listQueuedFleetJobs(
    ref: FleetQueueRepoRef,
    target?: GithubOrgTarget,
  ): Promise<QueuedFleetJobsRead> {
    const { token } = await resolveOrgAuth(target);
    const repoUrl = `${GITHUB_API}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
    const runIds = new Set<number>();
    for (const status of ['queued', 'in_progress'] as const) {
      const res = await call(
        `${repoUrl}/actions/runs?status=${status}&per_page=${PER_PAGE}`,
        token,
      );
      if (res.status === 404) return { jobs: [], skippedRuns: [] };
      if (!res.ok) throw new FleetQueueApiError(res.status, await errorDetail(res));
      const body = asRecord(await res.json());
      for (const run of asArray(body?.['workflow_runs'])) {
        const id = asRecord(run)?.['id'];
        if (typeof id === 'number') runIds.add(id);
      }
    }

    const jobs: QueuedFleetJob[] = [];
    const skippedRuns: SkippedFleetRun[] = [];
    const skip = (runId: number, status: number | null, detail: string) =>
      skippedRuns.push({
        repoOwner: ref.owner,
        repoName: ref.repo,
        runId: String(runId),
        status,
        detail,
      });
    for (const runId of runIds) {
      let res: Response;
      try {
        res = await call(
          `${repoUrl}/actions/runs/${runId}/jobs?filter=latest&per_page=${PER_PAGE}`,
          token,
        );
      } catch (err) {
        // `call` throws only a typed unreachable error (a timeout on this run).
        const failure = err as FleetQueueApiError;
        skip(runId, failure.status, failure.message);
        continue;
      }
      if (res.status === 404) continue;
      if (!res.ok) {
        skip(runId, res.status, await errorDetail(res));
        continue;
      }
      const body = asRecord(await res.json());
      for (const entry of asArray(body?.['jobs'])) {
        const job = asRecord(entry);
        if (!job || job['status'] !== 'queued') continue;
        const labels = asArray(job['labels']).filter((l): l is string => typeof l === 'string');
        if (!labels.some((l) => l.trim().toLowerCase() === MOTIR_RUNNER_LABEL)) continue;
        const id = job['id'];
        const createdAt = new Date(String(job['created_at'] ?? ''));
        if (typeof id !== 'number' || Number.isNaN(createdAt.getTime())) continue;
        jobs.push({
          runId: String(runId),
          runAttempt: typeof job['run_attempt'] === 'number' ? job['run_attempt'] : 1,
          jobId: String(id),
          jobName: typeof job['name'] === 'string' ? job['name'] : null,
          workflowName: typeof job['workflow_name'] === 'string' ? job['workflow_name'] : null,
          repoOwner: ref.owner,
          repoName: ref.repo,
          labels,
          createdAt,
        });
      }
    }
    return { jobs, skippedRuns };
  },

  /** Every runner registered in the target's org that carries the fleet label. */
  async listFleetRunners(target?: GithubOrgTarget): Promise<OrgRunner[]> {
    const { org, token } = await resolveOrgAuth(target);
    const runners: OrgRunner[] = [];
    for (let page = 1; page <= MAX_RUNNER_PAGES; page++) {
      const res = await call(
        `${GITHUB_API}/orgs/${encodeURIComponent(org)}/actions/runners?per_page=${PER_PAGE}&page=${page}`,
        token,
      );
      if (!res.ok) throw new FleetQueueApiError(res.status, await errorDetail(res));
      const body = asRecord(await res.json());
      const listed = asArray(body?.['runners']);
      for (const entry of listed) {
        const runner = asRecord(entry);
        if (!runner || typeof runner['id'] !== 'number') continue;
        const labels = asArray(runner['labels'])
          .map((l) => asRecord(l)?.['name'])
          .filter((n): n is string => typeof n === 'string');
        if (!labels.some((l) => l.trim().toLowerCase() === MOTIR_RUNNER_LABEL)) continue;
        runners.push({
          id: runner['id'],
          name: String(runner['name'] ?? ''),
          online: runner['status'] === 'online',
          busy: runner['busy'] === true,
          labels,
        });
      }
      if (listed.length < PER_PAGE) break;
    }
    return runners;
  },
};

async function call(url: string, token: string): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'motir',
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new FleetQueueApiError(null, err instanceof Error ? err.message : 'unknown');
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** GitHub's `message`, trimmed — never the payload. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const message = asRecord(await res.json())?.['message'];
    return typeof message === 'string' ? message.slice(0, 200) : '';
  } catch {
    return '';
  }
}

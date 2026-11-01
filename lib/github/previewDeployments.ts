import { mintInstallationToken } from '@/lib/github/appAuth';
import type { RepositoryCoordinates } from '@/lib/github/repositoryActionsConfig';

// The GitHub DEPLOYMENTS boundary of a pull request's preview (Story MOTIR-5766 ·
// MOTIR-5776, decision MOTIR-5769 §9 "GitHub deployment statuses"). The one
// module that CREATES a deployment and POSTS its statuses — the stated exception
// to MOTIR-5329's "Motir creates nothing", and only for a repository Motir hosts
// and whose previews are switched on (`previewLifecycleService` decides that).
//
// What Motir posts comes back as a `deployment_status` delivery and lands in
// `repo_deployment` through the SHIPPED handler, with no second store, which is
// how the approval gate's How-to-test read finds a preview by commit.
//
//   · one deployment per pull-request head, created on that head's SHA, in the
//     transient environment `preview/pr-<n>`;
//   · `in_progress` while it builds and starts, `success` with `environment_url`
//     when it is ready, `failure` when it is not, `inactive` when it is closed.
//
// Authenticated as the PROVISIONING App (Motir Studio, `deployments: write` per
// MOTIR-5770) through the repository's own installation — GitHub's numeric
// installation id. No error here carries a response body.

const GITHUB_API = 'https://api.github.com';

/** The deployment statuses a preview posts. */
export type PreviewDeploymentStatusState = 'in_progress' | 'success' | 'failure' | 'inactive';

/** Any GitHub refusal or transport failure on the deployments API. */
export class PreviewDeploymentsError extends Error {
  readonly code = 'PREVIEW_DEPLOYMENTS_FAILED' as const;
  constructor(
    readonly status: number | null,
    detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached for a preview deployment (${detail}).`
        : `GitHub refused a preview deployment call (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'PreviewDeploymentsError';
  }
}

/** The environment a pull request's preview deploys to (§9). */
export function previewEnvironmentName(pullRequestNumber: number): string {
  return `preview/pr-${pullRequestNumber}`;
}

function base(coordinates: RepositoryCoordinates): string {
  return (
    `${GITHUB_API}/repos/${encodeURIComponent(coordinates.owner)}/` +
    `${encodeURIComponent(coordinates.repo)}/deployments`
  );
}

async function post(
  coordinates: RepositoryCoordinates,
  url: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  let res: Response;
  try {
    const { token } = await mintInstallationToken(coordinates.installationId, 'provisioning');
    res = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'motir',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new PreviewDeploymentsError(null, err instanceof Error ? err.message : 'unknown');
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    const json: unknown = await res.json();
    if (typeof json === 'object' && json !== null && !Array.isArray(json)) {
      parsed = json as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const message = parsed?.['message'];
    throw new PreviewDeploymentsError(
      res.status,
      typeof message === 'string' ? message.slice(0, 200) : '',
    );
  }
  return parsed;
}

export const previewDeploymentsClient = {
  /**
   * Create the deployment for a pull request's head. `auto_merge: false` and no
   * required contexts, because a preview deploys a branch head as it is — GitHub
   * would otherwise refuse while the head's checks are pending, or try to merge
   * the default branch into it. Returns GitHub's deployment id.
   */
  async createDeployment(
    coordinates: RepositoryCoordinates,
    input: { sha: string; pullRequestNumber: number },
  ): Promise<string> {
    const body = await post(coordinates, base(coordinates), {
      ref: input.sha,
      environment: previewEnvironmentName(input.pullRequestNumber),
      transient_environment: true,
      production_environment: false,
      auto_merge: false,
      required_contexts: [],
      description: `Preview of pull request #${input.pullRequestNumber}`,
    });
    const id = body?.['id'];
    if (typeof id !== 'number' && typeof id !== 'string') {
      throw new PreviewDeploymentsError(201, 'the deployment answer had no id');
    }
    return String(id);
  },

  /** Post one status on a deployment. `environmentUrl` only with `success`. */
  async postStatus(
    coordinates: RepositoryCoordinates,
    deploymentId: string,
    input: { state: PreviewDeploymentStatusState; environmentUrl?: string; description: string },
  ): Promise<void> {
    await post(coordinates, `${base(coordinates)}/${encodeURIComponent(deploymentId)}/statuses`, {
      state: input.state,
      description: input.description.slice(0, 140),
      ...(input.environmentUrl ? { environment_url: input.environmentUrl } : {}),
      // A later deployment in the same environment supersedes this one; GitHub
      // marks the older ones inactive on a `success` only when asked.
      auto_inactive: input.state === 'success',
    });
  },

  /**
   * Whether the pull request is still open — the reaper's read for a row whose
   * `closed` delivery may have been lost. A pull request GitHub no longer knows
   * (404) is not open.
   */
  async isPullRequestOpen(
    coordinates: RepositoryCoordinates,
    pullRequestNumber: number,
  ): Promise<boolean> {
    let res: Response;
    try {
      const { token } = await mintInstallationToken(coordinates.installationId, 'provisioning');
      res = await fetch(
        `${GITHUB_API}/repos/${encodeURIComponent(coordinates.owner)}/` +
          `${encodeURIComponent(coordinates.repo)}/pulls/${pullRequestNumber}`,
        {
          method: 'GET',
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'motir',
            authorization: `Bearer ${token}`,
          },
        },
      );
    } catch (err) {
      throw new PreviewDeploymentsError(null, err instanceof Error ? err.message : 'unknown');
    }
    if (res.status === 404) return false;
    if (!res.ok) throw new PreviewDeploymentsError(res.status, '');
    const body = (await res.json().catch(() => null)) as { state?: unknown } | null;
    return body?.state === 'open';
  },
};

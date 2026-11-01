import 'server-only';

import { RepoProvisioningApiError, provisioningTransport } from '@/lib/github/repoProvisioning';
import type { GithubRepoAccess } from '@/lib/github/seedPromotion';

// GitHub DEPLOYMENTS on a Motir repository (Story MOTIR-9797 · MOTIR-10033):
// the deployment a production release is announced as, and the statuses posted
// to it. The one place Motir CREATES deployments on a repository host; every
// other deployment path only listens (`repoDeploymentService`).
//
// Every request goes through `provisioningTransport`, so tests stub it at the
// same `fetch` boundary as establish and enablement. A LEAF PRIMITIVE: services
// import it, routes never do. Nothing here logs, and an error carries the HTTP
// status and GitHub's short message only.

const GITHUB_API = 'https://api.github.com';

const { request, readJson, errorDetail } = provisioningTransport;

function repoPath(access: Pick<GithubRepoAccess, 'owner' | 'repo'>): string {
  return `${GITHUB_API}/repos/${encodeURIComponent(access.owner)}/${encodeURIComponent(access.repo)}`;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function refuse(res: Response): Promise<never> {
  throw new RepoProvisioningApiError(res.status, errorDetail(await readJson(res)));
}

export interface CreateDeploymentInput {
  /** The commit deployed — GitHub's `ref` may be a sha, and a sha never moves. */
  ref: string;
  environment: string;
  description?: string;
}

export interface CreateDeploymentStatusInput {
  deploymentId: string;
  state: 'pending' | 'in_progress' | 'success' | 'failure' | 'inactive';
  /** The app the deployment serves; sent only when known. Never a log link. */
  environmentUrl?: string | null;
}

export const repoDeployments = {
  /**
   * Create one deployment of `ref` in `environment` and return its id. No
   * required contexts (the release is already built, and its own checks are not
   * this deployment's gate) and no auto-merge (a sha has nothing to merge), so
   * GitHub answers 201 with the deployment, never the 202 "merged first" body.
   */
  async createDeployment(access: GithubRepoAccess, input: CreateDeploymentInput): Promise<string> {
    const res = await request(`${repoPath(access)}/deployments`, {
      method: 'POST',
      headers: authHeaders(access.token),
      body: JSON.stringify({
        ref: input.ref,
        environment: input.environment,
        description: input.description ?? '',
        auto_merge: false,
        required_contexts: [],
        production_environment: true,
        transient_environment: false,
      }),
    });
    if (res.status !== 201) await refuse(res);
    const id = (await readJson(res))?.['id'];
    if (typeof id !== 'number' && typeof id !== 'string') {
      throw new RepoProvisioningApiError(res.status, 'deployment created without an id');
    }
    return String(id);
  },

  /**
   * Post one status to a deployment. `auto_inactive` is off: Motir posts
   * `inactive` itself when a release is replaced or rolled back, so the
   * release's own state stays the one source of what GitHub shows.
   */
  async createDeploymentStatus(
    access: GithubRepoAccess,
    input: CreateDeploymentStatusInput,
  ): Promise<void> {
    const res = await request(
      `${repoPath(access)}/deployments/${encodeURIComponent(input.deploymentId)}/statuses`,
      {
        method: 'POST',
        headers: authHeaders(access.token),
        body: JSON.stringify({
          state: input.state,
          ...(input.environmentUrl ? { environment_url: input.environmentUrl } : {}),
          auto_inactive: false,
        }),
      },
    );
    if (!res.ok) await refuse(res);
  },
};

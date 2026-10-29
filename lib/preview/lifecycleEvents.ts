// What the preview lifecycle reads of a GitHub delivery (Story MOTIR-5766 ·
// MOTIR-5776). Pure: the raw payload in, the few fields a transition needs out,
// or null for a delivery the lifecycle does not act on. Read from the RAW body
// rather than the provider seam's normalized events, because those keep what
// THEIR consumers need (the status sync, the CI-minutes meter) and drop the head
// SHA, the workflow file and the pull request a run belongs to.

/** The workflow whose success means a preview image was pushed: the starters'
 *  `preview-image.yml` (MOTIR-5771). Matched by PATH, which a repository cannot
 *  rename by editing the workflow's display `name:`. */
export const PREVIEW_IMAGE_WORKFLOW_PATH = '.github/workflows/preview-image.yml';

/** The repository a delivery is about, as GitHub names it. */
export interface PreviewDeliveryRepository {
  /** GitHub's numeric installation id. */
  readonly installationId: string;
  /** GitHub's numeric repository id. */
  readonly providerRepoId: string;
}

export type PreviewPullRequestEvent = PreviewDeliveryRepository & {
  readonly kind: 'head' | 'closed';
  readonly pullRequestNumber: number;
  readonly headSha: string;
};

export type PreviewImageRunConclusion = 'success' | 'failure';

export type PreviewImageRunEvent = PreviewDeliveryRepository & {
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly conclusion: PreviewImageRunConclusion;
  /** GitHub's own conclusion word, for the failure reason. */
  readonly rawConclusion: string;
};

const HEAD_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function idOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  return null;
}

function repositoryOf(body: Record<string, unknown>): PreviewDeliveryRepository | null {
  const installationId = idOf(record(body['installation'])?.['id']);
  const providerRepoId = idOf(record(body['repository'])?.['id']);
  if (!installationId || !providerRepoId) return null;
  return { installationId, providerRepoId };
}

/** A `pull_request` delivery: a new head (opened, pushed to, reopened) or a close
 *  (merged or not). Every other action is null. */
export function parsePreviewPullRequestEvent(
  body: Record<string, unknown>,
): PreviewPullRequestEvent | null {
  const action = body['action'];
  const kind = action === 'closed' ? 'closed' : HEAD_ACTIONS.has(String(action)) ? 'head' : null;
  if (!kind) return null;
  const repository = repositoryOf(body);
  const pr = record(body['pull_request']);
  const number = pr?.['number'] ?? body['number'];
  const headSha = record(pr?.['head'])?.['sha'];
  if (!repository || typeof number !== 'number' || typeof headSha !== 'string' || !headSha) {
    return null;
  }
  return { ...repository, kind, pullRequestNumber: number, headSha };
}

/**
 * A COMPLETED run of the preview-image workflow for a pull request. A run of any
 * other workflow, one not triggered by `pull_request`, one still running, or a
 * run GitHub attached to no pull request (a fork's) is null. `success` pushed an
 * image; every other conclusion (failure, cancelled, timed out…) did not.
 */
export function parsePreviewImageRunEvent(
  body: Record<string, unknown>,
): PreviewImageRunEvent | null {
  if (body['action'] !== 'completed') return null;
  const run = record(body['workflow_run']);
  if (!run || run['path'] !== PREVIEW_IMAGE_WORKFLOW_PATH || run['event'] !== 'pull_request') {
    return null;
  }
  const repository = repositoryOf(body);
  const headSha = run['head_sha'];
  const pullRequests = Array.isArray(run['pull_requests']) ? run['pull_requests'] : [];
  const number = record(pullRequests[0])?.['number'];
  const rawConclusion = typeof run['conclusion'] === 'string' ? run['conclusion'] : 'unknown';
  if (!repository || typeof headSha !== 'string' || !headSha || typeof number !== 'number') {
    return null;
  }
  return {
    ...repository,
    pullRequestNumber: number,
    headSha,
    conclusion: rawConclusion === 'success' ? 'success' : 'failure',
    rawConclusion,
  };
}

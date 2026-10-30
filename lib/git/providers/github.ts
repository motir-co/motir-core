import { registerGitProvider } from '../registry';
import {
  createAppJwt,
  GithubAppNotConfiguredError,
  GithubAppTokenError,
  mintInstallationToken,
} from '@/lib/github/appAuth';
import { githubAppRoleForRepo } from '@/lib/github/appRoleForRepo';
import { motirOwnedOrgLogins } from '@/lib/ciMetering/ownedOrgs';
import { mergeCommitFacts } from '@/lib/hosting/mergeCommit';
import {
  CHANGED_FILES_MAX,
  CHANGED_FILES_TIMEOUT_MS,
  REPO_FILE_MAX_BYTES,
  COMMIT_COMPARE_TIMEOUT_MS,
  MERGE_CHANGE_REQUEST_TIMEOUT_MS,
  REPO_FILE_READ_TIMEOUT_MS,
  REPO_TARBALL_TIMEOUT_MS,
  type GitProvider,
} from '../provider';
import {
  classifyRepoBlob,
  describeBody,
  normalizeRepoFilePath,
  parseGithubDirectoryListing,
  REPO_DIRECTORY_MAX_ENTRIES,
} from '../fileRead';
import {
  MergeChangeRequestError,
  RepoFileReadError,
  RepoTarballUrlMissingLocationError,
  RepoTarballUrlNotRedirectedError,
  RepoTarballUrlTimeoutError,
  RepoTarballUrlUnreachableError,
  ProviderPermissionReadError,
} from '../errors';
import type {
  ChangeRequestLifecycle,
  CiConclusion,
  InstallationToken,
  NormalizedChangeRequest,
  NormalizedComputeUsageLine,
  NormalizedInstallation,
  NormalizedPushEvent,
  NormalizedRepo,
  NormalizedStatusEvent,
  NormalizedWorkflowJob,
  NormalizedWorkflowJobEvent,
  NormalizedProductionImageRun,
  NormalizedWorkflowRunEvent,
  RepoFileReadResult,
  CommitComparison,
  ChangedFile,
  ChangedFileStatus,
  ChangedFilesResult,
  DeploymentState,
  ChangeRequestMergeability,
  ChangeRequestMergeabilityInput,
  MergeChangeRequestInput,
  MergeChangeRequestResult,
  MergeRefusal,
  NormalizedDeploymentStatus,
  NormalizedMergeGroupAttempt,
  NormalizedMergeQueueEntry,
  NormalizedMergeQueueExit,
  NormalizedUnlinkedCheckFailure,
  NormalizedReviewEvent,
  NormalizedReviewState,
  ReleaseContainment,
  ReleaseContainsMergeInput,
  RepositoryPermission,
  RepositoryPermissionInput,
} from '../types';
import { DEPLOYMENT_STATES } from '../types';

// The GitHub implementation of the GitProvider seam (Story 7.10 · MOTIR-891) —
// the FIRST registered provider. It normalizes GitHub's `pull_request` and
// `check_run` / commit-`status` webhook payloads into the provider-agnostic
// shapes, mints installation tokens via the `appAuth` leaf, and fetches repos
// via the REST API with a freshly-minted token. Consumers (MOTIR-892/893/894) go
// through the `GitProvider` interface and hold no GitHub types; GitLab (7.23)
// implements this SAME interface, which is what makes it additive.

const GITHUB_API = 'https://api.github.com';

/** Narrow an `unknown` to a plain object without asserting `any`. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** The GitHub numeric id (repo / installation) as our string form, or null. */
const REVIEW_ACTIONS = ['submitted', 'dismissed', 'edited'] as const;

const REVIEW_STATES: readonly NormalizedReviewState[] = [
  'approved',
  'changes_requested',
  'commented',
  'dismissed',
];

/** A review's state, lower-cased before matching. The WEBHOOK sends `approved` and
 *  the REST API sends `APPROVED` for the same fact, so a case-sensitive read would
 *  give a consumer two vocabularies. An unrecognised state is `null`, which makes
 *  the whole event fail to normalize rather than default to something. */
function normalizeReviewState(value: unknown): NormalizedReviewState | null {
  if (typeof value !== 'string') return null;
  const lowered = value.toLowerCase();
  return REVIEW_STATES.find((s) => s === lowered) ?? null;
}

const PERMISSIONS: readonly RepositoryPermission[] = [
  'admin',
  'maintain',
  'write',
  'triage',
  'read',
  'none',
];

/** One of GitHub's permission words, or `null` when the field is absent or is a
 *  custom role name Motir does not know. `null` means "this field did not answer",
 *  which lets the caller fall through to the next field rather than committing. */
function normalizePermission(value: unknown): RepositoryPermission | null {
  if (typeof value !== 'string') return null;
  const lowered = value.toLowerCase();
  return PERMISSIONS.find((p) => p === lowered) ?? null;
}

function idToString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

/** Normalize one repository object from the `/installation/repositories` list. */
function normalizeRepo(value: unknown): NormalizedRepo | null {
  const repo = asRecord(value);
  if (!repo) return null;
  const providerRepoId = idToString(repo['id']);
  const fullName = typeof repo['full_name'] === 'string' ? repo['full_name'] : null;
  const name = typeof repo['name'] === 'string' ? repo['name'] : null;
  const ownerLogin = idToString(asRecord(repo['owner'])?.['login']);
  // `owner` comes from either the nested owner.login or the `full_name` prefix.
  const owner = ownerLogin ?? (fullName ? (fullName.split('/')[0] ?? null) : null);
  const defaultBranch =
    typeof repo['default_branch'] === 'string' ? repo['default_branch'] : 'main';
  if (!providerRepoId || !name || !owner) return null;
  // `archived` is a plain boolean on every repository object GitHub returns (the
  // installation listing included). Only an explicit `true` archives the mirror —
  // a payload that omits the field leaves the row live, which is the same reading
  // every row written before MOTIR-1959 already carries.
  return { providerRepoId, owner, name, defaultBranch, archived: repo['archived'] === true };
}

/** Map a GitHub `check_run.conclusion` (or commit-status state) to ours. */
/**
 * GitHub's own conclusion vocabulary → the normalized one.
 *
 * ⚠️ EXPORTED (MOTIR-4199) so the REST read of a commit's check runs maps its
 * answer exactly as the webhook parser maps a delivery's. The two describe the
 * same checks arriving by two transports, and a second mapping here would be a
 * second opinion about a commit — the thing `liveCheckRows`' own header says was
 * removed.
 */
export function mapGithubCiConclusion(raw: string): CiConclusion {
  return mapConclusion(raw);
}

/** Every `pr-<n>` in a merge-queue ref's LAST segment
 *  (`gh-readonly-queue/<base>/pr-<n>-<base sha>`), in order and without repeats. A
 *  ref that is not a queue ref names none. */

/** The pull request a merge-queue `pull_request` delivery (`enqueued` / `dequeued`)
 *  names: its repository, number and head — or `null` for another action or a body
 *  missing any of the three. */
function readQueueMember(
  payload: Record<string, unknown> | null,
  action: 'enqueued' | 'dequeued',
): NormalizedMergeQueueEntry | null {
  if (!payload || payload['action'] !== action) return null;
  const providerRepoId = idToString(asRecord(payload['repository'])?.['id']);
  const pr = asRecord(payload['pull_request']);
  const number = pr?.['number'];
  const headSha = asRecord(pr?.['head'])?.['sha'];
  if (
    !providerRepoId ||
    typeof number !== 'number' ||
    !Number.isInteger(number) ||
    typeof headSha !== 'string' ||
    headSha.length === 0
  ) {
    return null;
  }
  return { providerRepoId, number, headSha };
}
function readQueuePrNumbers(headRef: string): number[] {
  const ref = headRef.replace(/^refs\/heads\//, '');
  if (!ref.startsWith('gh-readonly-queue/')) return [];
  const last = ref.slice(ref.lastIndexOf('/') + 1);
  const numbers: number[] = [];
  for (const match of last.matchAll(/(?:^|-)pr-(\d+)(?=-|$)/g)) {
    const n = Number(match[1]);
    if (Number.isSafeInteger(n) && n > 0 && !numbers.includes(n)) numbers.push(n);
  }
  return numbers;
}

function mapConclusion(raw: string): CiConclusion {
  switch (raw) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'cancelled':
    case 'action_required':
    case 'startup_failure':
    case 'error':
      return 'failure';
    case 'pending':
      return 'pending';
    default:
      return 'neutral'; // neutral / skipped / stale / anything unrecognised
  }
}

// ── MERGE (MOTIR-5514) ────────────────────────────────────────────────────────

/** One host call of a merge, bounded — a hang or a dead host is a typed error. */
async function githubMergeFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MERGE_CHANGE_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw controller.signal.aborted
      ? new MergeChangeRequestError('github', 'timeout')
      : new MergeChangeRequestError('github', 'unreachable', {
          message: err instanceof Error ? err.message : undefined,
        });
  } finally {
    clearTimeout(timer);
  }
}

/** The repository URL and the installation-token headers every merge-side call uses.
 *  The App is chosen by PROVENANCE (decision 7): a hosted repository mints through the
 *  provisioning App, an imported one through the user-facing App.
 *
 *  ⚠️ A FAILED MINT IS THE MERGE'S NON-ANSWER (MOTIR-7508). The seam promises that
 *  only `MergeChangeRequestError` throws out of a merge, and every caller maps exactly
 *  that one — the press to its UNEXPECTED arm with the approval standing, the
 *  auto-merge to its unreachable comment. A token endpoint answering 503 used to escape
 *  as `GithubAppTokenError`, which none of them maps, so an Approve-and-merge press
 *  crashed with a 500 AFTER its approval had committed. */
async function githubMergeContext(input: {
  installationId: string;
  owner: string;
  name: string;
}): Promise<{ repoUrl: string; headers: Record<string, string> }> {
  const role = githubAppRoleForRepo({ owner: input.owner }, await motirOwnedOrgLogins());
  let token: string;
  try {
    ({ token } = await mintInstallationToken(input.installationId, role));
  } catch (err) {
    if (!(err instanceof GithubAppTokenError)) throw err;
    throw err.status === undefined
      ? new MergeChangeRequestError('github', 'unreachable', { message: err.message })
      : new MergeChangeRequestError('github', 'unexpected_status', {
          status: err.status,
          message: err.message,
        });
  }
  return {
    repoUrl: `${GITHUB_API}/repos/${input.owner}/${input.name}`,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'motir',
    },
  };
}

/** A JSON body as a plain object, or null — never an `any`. */
async function mergeBodyOf(res: Response): Promise<Record<string, unknown> | null> {
  const body: unknown = await res.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function mergeRefused(code: MergeRefusal['code'], extra: Omit<MergeRefusal, 'code'> = {}) {
  return { outcome: 'refused' as const, refusal: { code, ...extra } };
}

/**
 * A 403 names the permission GitHub wanted in `X-Accepted-GitHub-Permissions`
 * (`contents=write; pull_requests=write`). Its FIRST entry is reported in the form a
 * person reads on the App's settings page. The header is not guaranteed, and a merge
 * needs `contents: write`, so that is the fallback.
 */
function refusedForPermission(res: Response): MergeChangeRequestResult {
  const accepted = res.headers.get('x-accepted-github-permissions');
  const first = accepted?.split(/[;,]/)[0]?.trim();
  const permission = first && first.includes('=') ? first.replace('=', ': ') : 'contents: write';
  return mergeRefused('app_permission_missing', { permission });
}

/**
 * The repository's allowed merge methods, first allowed wins: squash, merge commit,
 * rebase (decision 5). `undefined` when the repository row names none — the request
 * then omits `merge_method` and the HOST applies its own default, rather than this
 * code guessing one the repository may forbid.
 */
function allowedMergeMethod(repo: Record<string, unknown> | null): string | undefined {
  if (repo?.['allow_squash_merge'] === true) return 'squash';
  if (repo?.['allow_merge_commit'] === true) return 'merge';
  if (repo?.['allow_rebase_merge'] === true) return 'rebase';
  return undefined;
}

// GitHub's wording for a refusal made by a REQUIRED CHECK. Read from the 405's own
// message because `mergeable_state` answers `blocked` for a missing review and a
// failing required check alike.
//
// ⚠️ IT IS ASKED ONLY AFTER `behind` (Bug MOTIR-10054). A base branch whose required
// checks are STRICT refuses a pull request that is behind it, and GitHub's 405 then
// talks about the required status checks (*"2 of 2 required status checks are
// expected."*) although every check on the head is green. The state word is the
// reliable answer there, so it is read first.
const CHECKS_NOT_GREEN_MESSAGE =
  /status check|checks? (?:is|are) (?:expected|failing|pending|in progress)/i;
const MERGE_QUEUE_MESSAGE = /merge queue/i;

// ── THE MERGE QUEUE (MOTIR-5516) ────────────────────────────────────────────────
// The enqueue's own error wording, matched the way the merge path matches the 405's.
const ALREADY_QUEUED_MESSAGE = /already (?:in|been added to|queued|enqueued)/i;
const HEAD_MOVED_MESSAGE = /expected head|head (?:oid|sha|commit)|does not match the head/i;
const ENQUEUE_CHECKS_MESSAGE = /status check|checks? (?:is|are|have|has)\b/i;
const PERMISSION_MESSAGE = /resource not accessible by integration/i;

const ENQUEUE_MUTATION = `mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID) {
  enqueuePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid }) {
    mergeQueueEntry { id }
  }
}`;

const QUEUE_ENTRY_QUERY = `query($pullRequestId: ID!) {
  node(id: $pullRequestId) { ... on PullRequest { mergeQueueEntry { id } } }
}`;

/** A plain object, or null — for walking a JSON body without an `any`. */
function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The permission a refusal NAMES, when the host named one — never guessed. The queue's
 * permission is undocumented (`approval-gates.md` §4 second amendment, decision 6), so
 * reading what GitHub says it wanted is the only answer that cannot be wrong.
 */
function permissionNamedBy(res: Response): Omit<MergeRefusal, 'code'> {
  const first = res.headers.get('x-accepted-github-permissions')?.split(/[;,]/)[0]?.trim();
  return first && first.includes('=') ? { permission: first.replace('=', ': ') } : {};
}

/**
 * GitHub's `mergeable_state` for a head that is behind a base branch requiring pull
 * requests to be up to date (Bug MOTIR-10054). GitHub answers it ONLY when the base
 * requires it — a base that does not reads `clean` — so the word alone says both that
 * the branch is behind and that being behind blocks the merge.
 */
const OUT_OF_DATE_STATE = 'behind';

/** Does the base branch's active ruleset require a merge queue? */
function rulesRequireMergeQueue(rules: unknown): boolean {
  return Array.isArray(rules) && rules.some((rule) => objectOf(rule)?.['type'] === 'merge_queue');
}

/** One GraphQL call of a merge, bounded like every other host call it makes. */
function githubMergeGraphql(
  headers: Record<string, string>,
  query: string,
  variables: Record<string, unknown>,
): Promise<Response> {
  return githubMergeFetch(`${GITHUB_API}/graphql`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
}

/**
 * ENQUEUE a pull request onto its base branch's merge queue (MOTIR-5516) with
 * `enqueuePullRequest`, pinned to the head the decision saw (`expectedHeadOid`), and
 * map every answer onto the seam's own vocabulary:
 *
 *   - an entry → `enqueued`;
 *   - ALREADY QUEUED → `enqueued` with the EXISTING entry, read back — idempotent,
 *     because a second press on a queued pull request asked for exactly what exists;
 *   - a head that moved → `subject_changed`; unsatisfied checks → `checks_not_green`;
 *   - FORBIDDEN → `app_permission_missing`, naming what GitHub asked for;
 *   - anything else the queue refused → classified as the merge path classifies a 405.
 */
async function githubEnqueue(
  headers: Record<string, string>,
  pull: Record<string, unknown> | null,
  expectedHeadSha: string,
): Promise<MergeChangeRequestResult> {
  const nodeId = typeof pull?.['node_id'] === 'string' ? pull['node_id'] : null;
  if (!nodeId) {
    throw new MergeChangeRequestError('github', 'unexpected_status', {
      message: 'the pull request carried no node_id to enqueue it by',
    });
  }

  const res = await githubMergeGraphql(headers, ENQUEUE_MUTATION, {
    pullRequestId: nodeId,
    expectedHeadOid: expectedHeadSha,
  });
  if (res.status === 403) return mergeRefused('app_permission_missing', permissionNamedBy(res));
  if (!res.ok) {
    throw new MergeChangeRequestError('github', 'unexpected_status', { status: res.status });
  }
  const body = await mergeBodyOf(res);
  const entryId = objectOf(
    objectOf(objectOf(body?.['data'])?.['enqueuePullRequest'])?.['mergeQueueEntry'],
  )?.['id'];
  if (typeof entryId === 'string') return { outcome: 'enqueued', entryId };

  const errors = body?.['errors'];
  const first = Array.isArray(errors) ? objectOf(errors[0]) : null;
  const type = typeof first?.['type'] === 'string' ? first['type'] : '';
  const message = typeof first?.['message'] === 'string' ? first['message'] : '';

  if (type === 'FORBIDDEN' || PERMISSION_MESSAGE.test(message)) {
    return mergeRefused('app_permission_missing', permissionNamedBy(res));
  }
  if (ALREADY_QUEUED_MESSAGE.test(message)) {
    const existing = await githubMergeGraphql(headers, QUEUE_ENTRY_QUERY, {
      pullRequestId: nodeId,
    });
    const existingBody = existing.ok ? await mergeBodyOf(existing) : null;
    const existingId = objectOf(
      objectOf(objectOf(existingBody?.['data'])?.['node'])?.['mergeQueueEntry'],
    )?.['id'];
    if (typeof existingId === 'string') return { outcome: 'enqueued', entryId: existingId };
    throw new MergeChangeRequestError('github', 'unexpected_status', {
      message: 'the queue said the pull request is already queued, but no entry was found',
    });
  }
  if (HEAD_MOVED_MESSAGE.test(message)) return mergeRefused('subject_changed');
  // Behind a strict base, the queue's message names the checks too (MOTIR-10054).
  if (pull?.['mergeable_state'] === OUT_OF_DATE_STATE) {
    return mergeRefused('out_of_date', message ? { reason: message } : {});
  }
  if (ENQUEUE_CHECKS_MESSAGE.test(message)) {
    return mergeRefused('checks_not_green', { reason: message });
  }
  if (pull?.['mergeable_state'] === 'dirty') return mergeRefused('conflict');
  if (first) return mergeRefused('branch_protected', message ? { reason: message } : {});
  throw new MergeChangeRequestError('github', 'unexpected_status', {
    status: res.status,
    message: 'the enqueue answered with neither an entry nor an error',
  });
}

// ─── listChangedFiles (MOTIR-6619) ───────────────────────────────────────────

/** GitHub's `files[].status` → the seam's four words. `copied` is a NEW path on
 *  head (its source still exists), so it reads as `added`; `changed` (a mode /
 *  type change) and `unchanged` both read as `modified`. */
function githubChangedFileStatus(raw: unknown): ChangedFileStatus {
  switch (raw) {
    case 'added':
    case 'copied':
      return 'added';
    case 'removed':
      return 'removed';
    case 'renamed':
      return 'renamed';
    default:
      return 'modified';
  }
}

/** One `files[]` entry → a {@link ChangedFile}, or null when it carries no path.
 *  NAMES ONLY: `patch`, `blob_url`, `raw_url` and `contents_url` are never read. */
function githubChangedFile(value: unknown): ChangedFile | null {
  const file = asRecord(value);
  const path = file?.['filename'];
  if (typeof path !== 'string' || path.length === 0) return null;
  const status = githubChangedFileStatus(file?.['status']);
  const previous = file?.['previous_filename'];
  return status === 'renamed' && typeof previous === 'string' && previous.length > 0
    ? { path, status, previousPath: previous }
    : { path, status };
}

/**
 * A failed MINT, as a named absence. An App not configured on this deployment is
 * `not_connected`; a token endpoint that answered 401/403/404 means the
 * installation was removed or suspended, which is `revoked`; anything else — the
 * endpoint unreachable, a body it could not parse — is `host_error`. The detail is
 * the error's own message, which `GithubAppTokenError` guarantees never carries
 * GitHub's raw body.
 */
function githubMintFailure(err: unknown, refs: { base: string; head: string }): ChangedFilesResult {
  if (err instanceof GithubAppNotConfiguredError) return { outcome: 'not_connected', ...refs };
  if (
    err instanceof GithubAppTokenError &&
    (err.status === 401 || err.status === 403 || err.status === 404)
  ) {
    return { outcome: 'revoked', ...refs };
  }
  return {
    outcome: 'host_error',
    ...refs,
    detail: err instanceof Error ? err.message : 'the installation token could not be minted',
  };
}

/** The hex sha at `value.sha`, or null. */
function shaOf(value: unknown): string | null {
  const sha = asRecord(value)?.['sha'];
  return typeof sha === 'string' && /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null;
}

export const githubProvider: GitProvider = {
  id: 'github',

  async mintInstallationToken(
    installationId: string,
    forRepo?: { owner: string },
  ): Promise<InstallationToken> {
    return forRepo
      ? mintInstallationToken(
          installationId,
          githubAppRoleForRepo(forRepo, await motirOwnedOrgLogins()),
        )
      : mintInstallationToken(installationId);
  },

  async fetchInstallationRepos(installationId: string): Promise<NormalizedRepo[]> {
    const { token } = await mintInstallationToken(installationId);
    let res: Response;
    try {
      res = await fetch(`${GITHUB_API}/installation/repositories?per_page=100`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'motir',
        },
      });
    } catch (err) {
      throw new Error(
        `GitHub repositories endpoint unreachable (${err instanceof Error ? err.message : 'unknown'})`,
      );
    }
    if (!res.ok) throw new Error(`GitHub repositories endpoint returned ${res.status}`);
    const body = asRecord(await res.json());
    const list = Array.isArray(body?.['repositories']) ? (body!['repositories'] as unknown[]) : [];
    return list.map(normalizeRepo).filter((repo): repo is NormalizedRepo => repo !== null);
  },

  async resolveRepoTarballUrl(
    installationId: string,
    owner: string,
    name: string,
    ref: string,
  ): Promise<string> {
    // The App is chosen by the repository's PROVENANCE (MOTIR-5861): a hosted
    // repository is installed on the provisioning App ONLY, so a mint through the
    // user-facing default cannot reach it and the indexer never gets a tarball.
    const role = githubAppRoleForRepo({ owner }, await motirOwnedOrgLogins());
    const { token } = await mintInstallationToken(installationId, role);
    // ⚠️ `redirect: 'manual'` IS THE WHOLE METHOD. The sibling above lets `fetch`
    // follow the 302 and then buffers what comes back; this one stops at the
    // redirect and takes the URL. Same endpoint, same credential, and the body —
    // the several hundred megabytes that OOM'd the function — is never read.
    //
    // What comes back in `Location` is a `codeload.github.com` URL authorized by
    // its OWN signed query string. That is not an assumption: it is the mechanism
    // the removed byte-fetching sibling depended on too — `fetch` follows the 302
    // and (per the fetch spec) STRIPS `Authorization` on the cross-origin hop,
    // yet the download still works — so the installation token does not reach
    // `codeload` on either path. Handing the URL to a container therefore leaks
    // nothing and is strictly less privilege than handing over the token
    // (`docs/decisions/code-graph-index-fleet.md` §10).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REPO_TARBALL_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${GITHUB_API}/repos/${owner}/${name}/tarball/${ref}`, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'motir',
        },
        signal: controller.signal,
      });
    } catch (err) {
      throw controller.signal.aborted
        ? new RepoTarballUrlTimeoutError(REPO_TARBALL_TIMEOUT_MS)
        : new RepoTarballUrlUnreachableError(err instanceof Error ? err.message : 'unknown');
    } finally {
      clearTimeout(timer);
    }

    // A 200 here would mean the host served the BYTES rather than a redirect —
    // the one outcome this method exists to avoid — so it is a failure, not a
    // success to be silently discarded. Every non-3xx lands in the same arm and
    // carries its status, which is what tells an operator whether to look at the
    // installation (404 / 403) or at GitHub (5xx).
    if (res.status < 300 || res.status >= 400) {
      throw new RepoTarballUrlNotRedirectedError(res.status);
    }
    const location = res.headers.get('location');
    if (!location) throw new RepoTarballUrlMissingLocationError(res.status);
    return location;
  },

  /**
   * MERGE one pull request — or ENQUEUE it where its base branch requires a merge
   * queue (Story MOTIR-4882 · MOTIR-5514, MOTIR-5516; `approval-gates.md` §4 second
   * amendment, decisions 5–8). Every host call is bounded by
   * `MERGE_CHANGE_REQUEST_TIMEOUT_MS`, and all of them share ONE installation token.
   *
   *   1. `GET /repos/{owner}/{name}` — which merge methods the repository ALLOWS.
   *   2. `GET /pulls/{n}` — the pull request's `node_id` (the queue addresses it by
   *      one) and its base branch; an already-merged, closed or moved pull request is
   *      answered here, without a merge call.
   *   3. `GET /rules/branches/{base}` — a `merge_queue` rule means ENQUEUE, never
   *      merge (`metadata: read`, which every App holds).
   *   4. `PUT /pulls/{n}/merge` with `sha: expectedHeadSha`. A 405 saying the branch
   *      must be merged through the queue ENQUEUES too; any other 405 re-reads the
   *      pull request, because GitHub answers the same 405 for a conflict, a missing
   *      review, failing checks and an already-merged pull request.
   *
   * ⚠️ THE APP IS CHOSEN BY PROVENANCE (decision 7): a hosted repository mints
   * through the provisioning App, an imported one through the user-facing App.
   */
  async mergeChangeRequest(input: MergeChangeRequestInput): Promise<MergeChangeRequestResult> {
    const { repoUrl, headers } = await githubMergeContext(input);

    // 1. The allowed merge methods. A repository the App cannot see is a
    //    permission answer; one that is gone is a subject that changed.
    const repoRes = await githubMergeFetch(repoUrl, { method: 'GET', headers });
    if (repoRes.status === 403) return refusedForPermission(repoRes);
    if (repoRes.status === 404) return mergeRefused('subject_changed');
    if (!repoRes.ok) {
      throw new MergeChangeRequestError('github', 'unexpected_status', { status: repoRes.status });
    }
    const mergeMethod = allowedMergeMethod(await mergeBodyOf(repoRes));

    // 2. The pull request as it stands now — and the three answers it gives alone.
    const pullRes = await githubMergeFetch(`${repoUrl}/pulls/${input.number}`, {
      method: 'GET',
      headers,
    });
    if (pullRes.status === 404) return mergeRefused('subject_changed');
    if (pullRes.status === 403) {
      return mergeRefused('app_permission_missing', permissionNamedBy(pullRes));
    }
    if (!pullRes.ok) {
      throw new MergeChangeRequestError('github', 'unexpected_status', { status: pullRes.status });
    }
    const pull = await mergeBodyOf(pullRes);
    if (pull?.['merged'] === true) return mergeRefused('already_merged');
    if (pull?.['state'] === 'closed') return mergeRefused('subject_changed');
    const pullHead = objectOf(pull?.['head'])?.['sha'];
    if (typeof pullHead === 'string' && pullHead !== input.expectedHeadSha) {
      return mergeRefused('subject_changed');
    }

    // 3. Does the base branch REQUIRE a merge queue? A rules read that fails is not an
    //    answer about the queue — the merge's own 405 still routes a queued branch to
    //    the enqueue below — so it falls through rather than refusing.
    const baseRef = objectOf(pull?.['base'])?.['ref'];
    if (typeof baseRef === 'string') {
      const rulesRes = await githubMergeFetch(
        `${repoUrl}/rules/branches/${encodeURIComponent(baseRef)}`,
        { method: 'GET', headers },
      );
      if (rulesRes.ok && rulesRequireMergeQueue(await rulesRes.json().catch(() => null))) {
        return githubEnqueue(headers, pull, input.expectedHeadSha);
      }
    }

    // 4. The merge, pinned to the head the decision saw.
    const mergeRes = await githubMergeFetch(`${repoUrl}/pulls/${input.number}/merge`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(
        mergeMethod
          ? { sha: input.expectedHeadSha, merge_method: mergeMethod }
          : { sha: input.expectedHeadSha },
      ),
    });
    if (mergeRes.status === 200) {
      const body = await mergeBodyOf(mergeRes);
      if (body?.['merged'] === true && typeof body['sha'] === 'string') {
        return { outcome: 'merged', commitSha: body['sha'] };
      }
      throw new MergeChangeRequestError('github', 'unexpected_status', {
        status: 200,
        message: 'the merge answered 200 without merged: true',
      });
    }
    if (mergeRes.status === 409 || mergeRes.status === 404) return mergeRefused('subject_changed');
    if (mergeRes.status === 403) return refusedForPermission(mergeRes);
    if (mergeRes.status !== 405) {
      throw new MergeChangeRequestError('github', 'unexpected_status', { status: mergeRes.status });
    }

    // A 405 — WHICH one.
    const refusalBody = await mergeBodyOf(mergeRes);
    const message = typeof refusalBody?.['message'] === 'string' ? refusalBody['message'] : '';

    // The branch must be merged through its queue: ENQUEUE it (MOTIR-5516).
    if (MERGE_QUEUE_MESSAGE.test(message))
      return githubEnqueue(headers, pull, input.expectedHeadSha);

    const prRes = await githubMergeFetch(`${repoUrl}/pulls/${input.number}`, {
      method: 'GET',
      headers,
    });
    if (prRes.status === 404) return mergeRefused('subject_changed');
    if (prRes.status === 403) return refusedForPermission(prRes);
    if (!prRes.ok) {
      throw new MergeChangeRequestError('github', 'unexpected_status', { status: prRes.status });
    }
    const pr = await mergeBodyOf(prRes);
    const head = objectOf(pr?.['head']);

    // Ordered by what the person can do about it: nothing is left to do; the
    // question itself changed; then the three things somebody has to go and fix.
    if (pr?.['merged'] === true) return mergeRefused('already_merged');
    if (pr?.['state'] === 'closed') return mergeRefused('subject_changed');
    if (typeof head?.['sha'] === 'string' && head['sha'] !== input.expectedHeadSha) {
      return mergeRefused('subject_changed');
    }
    if (pr?.['mergeable_state'] === 'dirty') return mergeRefused('conflict');
    // Behind a strict base: GitHub's message names the required checks, but they are
    // green — the branch has to be brought up to date (MOTIR-10054).
    if (pr?.['mergeable_state'] === OUT_OF_DATE_STATE) {
      return mergeRefused('out_of_date', message ? { reason: message } : {});
    }
    if (CHECKS_NOT_GREEN_MESSAGE.test(message) || pr?.['mergeable_state'] === 'unstable') {
      return mergeRefused('checks_not_green', message ? { reason: message } : {});
    }
    // `blocked`, a draft, or a state GitHub adds later: the host said no
    // and named a rule. It is a refusal with the host's own reason — never a throw,
    // because the host DID answer.
    return mergeRefused('branch_protected', message ? { reason: message } : {});
  },

  /**
   * `GET /repos/{owner}/{name}/pulls/{number}` — the pull request's `mergeable` /
   * `mergeable_state` and the head they are about (MOTIR-5913). Same App, same
   * bounded fetch as {@link mergeChangeRequest}, whose step 2 reads the same URL.
   */
  async readChangeRequestMergeability(
    input: ChangeRequestMergeabilityInput,
  ): Promise<ChangeRequestMergeability> {
    const { repoUrl, headers } = await githubMergeContext(input);
    const res = await githubMergeFetch(`${repoUrl}/pulls/${input.number}`, {
      method: 'GET',
      headers,
    });
    if (!res.ok) {
      throw new MergeChangeRequestError('github', 'unexpected_status', { status: res.status });
    }
    const pull = await mergeBodyOf(res);
    const mergeable = pull?.['mergeable'];
    const mergeableState = pull?.['mergeable_state'];
    const headSha = objectOf(pull?.['head'])?.['sha'];
    return {
      mergeable: typeof mergeable === 'boolean' ? mergeable : null,
      mergeableState: typeof mergeableState === 'string' ? mergeableState : null,
      headSha: typeof headSha === 'string' ? headSha : null,
    };
  },

  /**
   * Two reads with the merge path's App and bound (Bug MOTIR-8330):
   * `GET /repos/{owner}/{name}/pulls/{number}` for the pull request's
   * `merge_commit_sha`, then `GET /repos/{owner}/{name}/compare/{merge}...{release}`,
   * whose `status` says where the release sits relative to the merge — `ahead` or
   * `identical` means the release's history carries it, `behind` or `diverged` that
   * it does not.
   *
   * ⚠️ IT READS `status`, NOT A COUNT. GitHub's `behind_by` is the number of commits
   * on the BASE that the head lacks (measured on this repository: `compare/73d4758
   * ...ef898ed` answers `ahead_by: 1, behind_by: 0`), so containment could be read
   * off it too — but `status` is the host's own word for exactly this question and
   * carries no direction to get backwards.
   *
   * A squash or rebase merge records its merge commit here too, which is the commit
   * that actually reached the base branch — never the pull request's head.
   */
  async readReleaseContainsMerge(input: ReleaseContainsMergeInput): Promise<ReleaseContainment> {
    try {
      const { repoUrl, headers } = await githubMergeContext(input);
      const prRes = await githubMergeFetch(`${repoUrl}/pulls/${input.number}`, {
        method: 'GET',
        headers,
      });
      if (!prRes.ok) return 'unknown';
      const pull = await mergeBodyOf(prRes);
      const mergeSha = pull?.['merge_commit_sha'];
      if (pull?.['merged'] !== true || typeof mergeSha !== 'string' || mergeSha === '') {
        return 'unknown';
      }
      const compareRes = await githubMergeFetch(
        `${repoUrl}/compare/${encodeURIComponent(mergeSha)}...${encodeURIComponent(input.release)}`,
        { method: 'GET', headers },
      );
      // A release the host does not know (404), or any other refusal: no answer.
      if (!compareRes.ok) return 'unknown';
      const status = (await mergeBodyOf(compareRes))?.['status'];
      if (status === 'ahead' || status === 'identical') return 'contains';
      if (status === 'behind' || status === 'diverged') return 'missing';
      return 'unknown';
    } catch {
      // A failed mint, a timeout, an unreachable host — the merge path's typed
      // non-answers — and anything else: this read never fails its caller.
      return 'unknown';
    }
  },

  /**
   * `GET /repos/{owner}/{name}/compare/{base}...{head}` — GitHub answers with
   * `ahead_by`, the count of commits on `head` that are not on `base`, which is
   * exactly the drift this surface renders.
   *
   * ⚠️ `ahead_by`, NOT `behind_by` (MOTIR-8335). GitHub states both counts from
   * HEAD's side: `ahead_by` is what `head` has that `base` lacks, `behind_by` is
   * what `base` has that `head` lacks. The drift sweep passes the indexed commit
   * as `base` and the default branch's head as `head`, so a branch that moved on
   * answers `status: "ahead", ahead_by: N, behind_by: 0` — measured on this
   * repository: `compare/73d4758...ef898ed` (a parent and its child) answers
   * `ahead_by: 1, behind_by: 0`. Reading `behind_by` reported every GitHub repo's
   * drift as 0, which is CURRENT to every consumer.
   *
   * ⚠️ 404 IS `no_common_ancestor`, NOT AN ERROR. A force-push or a rewritten
   * history leaves the indexed sha unreachable from the current head, and GitHub
   * says so with a 404 — the count is UNDEFINED for that pair rather than zero.
   */
  async compareCommits(
    installationId: string,
    owner: string,
    name: string,
    base: string,
    head: string,
  ): Promise<CommitComparison> {
    // Provenance, as above (MOTIR-5861). A hosted repository's comparison would
    // throw GithubAppNotConfiguredError, which the drift count reads as no answer.
    const role = githubAppRoleForRepo({ owner }, await motirOwnedOrgLogins());
    const { token } = await mintInstallationToken(installationId, role);
    const url =
      `${GITHUB_API}/repos/${owner}/${name}/compare/` +
      `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COMMIT_COMPARE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'motir',
        },
        signal: controller.signal,
      });
    } catch {
      return { behindBy: null, reason: 'unreachable' };
    } finally {
      clearTimeout(timer);
    }

    // The pair has no common ancestor — the indexed commit is not reachable from
    // the current head. Undefined, not zero.
    if (res.status === 404) return { behindBy: null, reason: 'no_common_ancestor' };
    if (!res.ok) return { behindBy: null, reason: 'unreachable' };

    const body: unknown = await res.json().catch(() => null);
    const ahead =
      body && typeof body === 'object' ? (body as Record<string, unknown>)['ahead_by'] : undefined;
    // ⚠️ A NON-NUMBER IS `null`, NOT A COERCION. `Number(undefined)` is `NaN` and
    // `Number(null)` is 0 — and 0 is the one answer this must never invent.
    if (typeof ahead !== 'number' || !Number.isFinite(ahead) || ahead < 0) {
      return { behindBy: null, reason: 'inexact' };
    }
    return { behindBy: ahead };
  },

  /**
   * `GET /repos/{owner}/{name}/compare/{base}...{head}` — the endpoint
   * {@link compareCommits} reads `ahead_by` from, read here for `files[]`
   * (MOTIR-6619). THREE-DOT, so the list is what `head` changed since it left
   * `base`, not everything `base` moved on since.
   *
   * ⚠️ NO PAGING PARAMETER, ON PURPOSE. Unpaged, GitHub returns up to 300
   * `files` and makes the LAST entry of `commits[]` the head of the whole
   * comparison — which is where `headSha` comes from. Asking for a page would
   * trade that guarantee for a longer list this capability caps anyway.
   *
   * Status → outcome: 404 is `no_such_ref` (a missing ref and a pair with no
   * common ancestor answer alike, and both mean "no such comparison"); 401, and
   * a 403 that is not a rate limit, are `revoked`; a refusal whose body says
   * the diff is too big or too slow to build is `too_large`; everything else,
   * and no answer within {@link CHANGED_FILES_TIMEOUT_MS}, is `host_error`.
   */
  async listChangedFiles(
    installationId: string,
    owner: string,
    name: string,
    base: string,
    head: string,
  ): Promise<ChangedFilesResult> {
    const refs = { base, head };
    // Provenance, as every other read on this seam (MOTIR-5681 / MOTIR-5861).
    let token: string;
    try {
      const role = githubAppRoleForRepo({ owner }, await motirOwnedOrgLogins());
      ({ token } = await mintInstallationToken(installationId, role));
    } catch (err) {
      return githubMintFailure(err, refs);
    }
    const url =
      `${GITHUB_API}/repos/${owner}/${name}/compare/` +
      `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHANGED_FILES_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'motir',
        },
        signal: controller.signal,
      });
    } catch (err) {
      return {
        outcome: 'host_error',
        ...refs,
        detail: controller.signal.aborted
          ? `no response within ${CHANGED_FILES_TIMEOUT_MS}ms`
          : err instanceof Error
            ? err.message
            : 'unknown',
      };
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 404) return { outcome: 'no_such_ref', ...refs };
    if (res.status === 401) return { outcome: 'revoked', ...refs };
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 403) {
        // A PRIMARY or SECONDARY rate limit is 403 on GitHub too, and it is the
        // host being busy — not the connection being gone.
        const limited =
          res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(body);
        if (!limited) return { outcome: 'revoked', ...refs };
      } else if (/too (large|big|many)|taking too long|timed? ?out/i.test(body)) {
        return { outcome: 'too_large', ...refs };
      }
      return { outcome: 'host_error', ...refs, detail: `GitHub compare returned ${res.status}` };
    }

    const body = asRecord(await res.json().catch(() => null));
    const rawFiles = body?.['files'];
    // A comparison with no changes still carries `files: []`; a body with no
    // array at all is not an answer, and must never read as "changed nothing".
    if (!body || !Array.isArray(rawFiles)) {
      return { outcome: 'host_error', ...refs, detail: 'GitHub compare returned no files list' };
    }
    const files = rawFiles
      .map(githubChangedFile)
      .filter((f): f is ChangedFile => f !== null)
      .slice(0, CHANGED_FILES_MAX);
    const commits = Array.isArray(body['commits']) ? (body['commits'] as unknown[]) : [];
    return {
      outcome: 'ok',
      ...refs,
      files,
      // AT the cap is truncated: a list sitting exactly on the host's limit is
      // indistinguishable from one that was cut.
      truncated: rawFiles.length >= CHANGED_FILES_MAX,
      baseSha: shaOf(body['base_commit']),
      // Head is the last commit of an unpaged comparison; with none (head is
      // already contained in base), the merge base IS head.
      headSha:
        commits.length > 0 ? shaOf(commits[commits.length - 1]) : shaOf(body['merge_base_commit']),
    };
  },

  async readFileAtRef(
    installationId: string,
    owner: string,
    name: string,
    path: string,
    ref: string,
  ): Promise<RepoFileReadResult> {
    // THE PATH GUARD RUNS FIRST — before the token is minted, before a URL is
    // built, before anything is sent. A traversal that reaches GitHub gets a
    // 404 and looks exactly like an honest miss in every log we keep, so
    // "a path outside the repository cannot be reached" has to be a fact about
    // this function rather than an inference from GitHub's behaviour.
    const guarded = normalizeRepoFilePath(path);
    if (!guarded.ok) return { outcome: 'invalid_path', path, reason: guarded.reason };

    // ⚠️ THE APP IS CHOSEN BY PROVENANCE, as the merge's is (MOTIR-5681 found this read
    // minting through the user-facing App for a HOSTED repository, which that App is not
    // installed on — so a decision document there could never be shown).
    const role = githubAppRoleForRepo({ owner }, await motirOwnedOrgLogins());
    const { token } = await mintInstallationToken(installationId, role);
    const url =
      `${GITHUB_API}/repos/${owner}/${name}/contents/` +
      `${guarded.path.split('/').map(encodeURIComponent).join('/')}` +
      `?ref=${encodeURIComponent(ref)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REPO_FILE_READ_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          // The RAW media type: the endpoint answers with the file's bytes
          // rather than a JSON envelope carrying a base64 `content` field. One
          // decode fewer, and no chance of returning the envelope's
          // `download_url` — which is a token-bearing URL on a private repo.
          accept: 'application/vnd.github.raw',
          'user-agent': 'motir',
        },
        signal: controller.signal,
      });
    } catch (err) {
      return {
        outcome: 'unreachable',
        path: guarded.path,
        ref,
        failure: controller.signal.aborted ? 'timeout' : 'unreachable',
        detail: controller.signal.aborted
          ? `no response within ${REPO_FILE_READ_TIMEOUT_MS}ms`
          : err instanceof Error
            ? err.message
            : 'unknown',
      };
    } finally {
      clearTimeout(timer);
    }

    // ⚠️ 404 IS THE ONE ANSWER GITHUB GIVES FOR TWO DIFFERENT QUESTIONS, and
    // both of them are ordinary. A missing PATH and a missing REF are the same
    // status, and the endpoint's own message is what separates them ("No commit
    // found for the ref …"). Reading it is not string-sniffing for a happy path
    // — it is refusing to tell a planning session that a file is absent when
    // what is actually absent is the branch it asked about.
    if (res.status === 404) {
      const body = await res.text().catch(() => '');
      return /No commit found for the ref/i.test(body)
        ? { outcome: 'ref_not_found', path: guarded.path, ref }
        : { outcome: 'not_found', path: guarded.path, ref };
    }
    // 403 covers BOTH a refused credential and a blob over the inline limit;
    // 401 is only the credential. GitHub says which in the body, and the two
    // have opposite meanings for a caller: one is "ask a smaller question",
    // the other is "this connection is broken".
    if (res.status === 403 || res.status === 401) {
      const body = await res.text().catch(() => '');
      return /too_large|larger than 1 ?MB|over the (file )?size limit/i.test(body)
        ? { outcome: 'too_large', path: guarded.path, ref, limitBytes: REPO_FILE_MAX_BYTES }
        : { outcome: 'unauthorized', path: guarded.path, ref };
    }
    if (!res.ok) {
      throw new RepoFileReadError('github', res.status, await describeBody(res));
    }

    // The BYTES, never `res.text()` — a lenient decode turns a binary blob into
    // `found` and inflates its size (`classifyRepoBlob`, MOTIR-7873).
    const blob = new Uint8Array(await res.arrayBuffer());
    // A DIRECTORY is answered with GitHub's JSON listing whatever media type was
    // asked for (MOTIR-9868): named and listed, never handed over as text.
    const listing = parseGithubDirectoryListing(blob, guarded.path);
    if (listing) {
      return {
        outcome: 'directory',
        path: guarded.path,
        ref,
        entries: listing,
        truncated: listing.length >= REPO_DIRECTORY_MAX_ENTRIES,
      };
    }
    // The size arm the host did not take. A repo whose blob
    // limit differs, a future endpoint change: whatever the reason, a caller
    // must never receive more than the named bound WITHOUT being told, so the
    // check is ours as well as GitHub's — on the blob's REAL length.
    if (blob.byteLength > REPO_FILE_MAX_BYTES) {
      return { outcome: 'too_large', path: guarded.path, ref, limitBytes: REPO_FILE_MAX_BYTES };
    }
    const classified = classifyRepoBlob(blob);
    if (classified.kind === 'binary') {
      return { outcome: 'binary', path: guarded.path, ref, bytes: blob.byteLength };
    }
    return {
      outcome: 'found',
      path: guarded.path,
      ref,
      text: classified.text,
      bytes: blob.byteLength,
    };
  },

  async fetchInstallation(installationId: string): Promise<NormalizedInstallation> {
    // GET /app/installations/{id} is an APP-level read (the App JWT), not an
    // installation token — it returns the account the App is installed on.
    const jwt = createAppJwt();
    let res: Response;
    try {
      res = await fetch(`${GITHUB_API}/app/installations/${installationId}`, {
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'motir',
        },
      });
    } catch (err) {
      throw new Error(
        `GitHub installation endpoint unreachable (${err instanceof Error ? err.message : 'unknown'})`,
      );
    }
    if (!res.ok) throw new Error(`GitHub installation endpoint returned ${res.status}`);
    const body = asRecord(await res.json());
    const account = asRecord(body?.['account']);
    const accountLogin = typeof account?.['login'] === 'string' ? account['login'] : '';
    const accountType = typeof account?.['type'] === 'string' ? account['type'] : 'Organization';
    if (!accountLogin) throw new Error('GitHub installation endpoint returned no account login');
    return { installationId, accountLogin, accountType };
  },

  parseChangeRequestEvent(rawPayload: unknown): NormalizedChangeRequest | null {
    const payload = asRecord(rawPayload);
    if (!payload) return null;
    const pr = asRecord(payload['pull_request']);
    const repo = asRecord(payload['repository']);
    if (!pr || !repo) return null;

    const providerRepoId = idToString(repo['id']);
    const number = typeof pr['number'] === 'number' ? pr['number'] : null;
    const head = asRecord(pr['head']);
    const headRef = typeof head?.['ref'] === 'string' ? head['ref'] : null;
    // The head COMMIT (MOTIR-7005) — the host's word for where the pull request is,
    // which the check rows are not: a push that produced no CI leaves them behind.
    const headSha = typeof head?.['sha'] === 'string' ? head['sha'] : null;
    // The DESTINATION, read as strictly as the source (MOTIR-1873): a merge that
    // does not name a base cannot be judged against the trunk, so it does not
    // normalize at all rather than normalizing into an assumed `main`.
    const base = asRecord(pr['base']);
    const baseRef = typeof base?.['ref'] === 'string' ? base['ref'] : null;
    if (!providerRepoId || number === null || !headRef || !baseRef) return null;

    return {
      providerRepoId,
      number,
      state: pr['state'] === 'closed' ? 'closed' : 'open',
      merged: pr['merged'] === true,
      headRef,
      baseRef,
      headSha,
      title: typeof pr['title'] === 'string' ? pr['title'] : null,
      // The DRAFT flag (MOTIR-4968), read in the same idiom as `merged` beside
      // it: GitHub reports a draft as `state: 'open'`, so this boolean is the
      // only thing that separates "open, awaiting review" from "open, explicitly
      // not offered". `=== true` rather than a truthiness coercion for the same
      // reason `merged` uses it — an absent field is not a draft.
      draft: pr['draft'] === true,
    };
  },

  // ── REVIEWS (Story MOTIR-4910 · MOTIR-5595) ────────────────────────────────
  //
  // `docs/decisions/approval-gates.md` §8 FOURTH AMENDMENT (MOTIR-5590), decision 2.

  parseReviewEvent(rawPayload: unknown): NormalizedReviewEvent | null {
    const payload = asRecord(rawPayload);
    if (!payload) return null;

    const action = REVIEW_ACTIONS.find((a) => a === payload['action']);
    if (!action) return null;

    const review = asRecord(payload['review']);
    const pr = asRecord(payload['pull_request']);
    const repo = asRecord(payload['repository']);
    if (!review || !pr || !repo) return null;

    const providerRepoId = idToString(repo['id']);
    const owner = idToString(asRecord(repo['owner'])?.['login']);
    const name = typeof repo['name'] === 'string' ? repo['name'] : null;
    const number = typeof pr['number'] === 'number' ? pr['number'] : null;

    // The INSTALLATION is what mints the token the permission read needs, so a
    // delivery that does not name one cannot be acted on at all.
    const installationId = idToString(asRecord(payload['installation'])?.['id']);

    const id = idToString(review['id']);
    const commitSha = typeof review['commit_id'] === 'string' ? review['commit_id'] : null;
    const state = normalizeReviewState(review['state']);

    const reviewerRaw = asRecord(review['user']);
    const providerUserId = idToString(reviewerRaw?.['id']);
    const login = typeof reviewerRaw?.['login'] === 'string' ? reviewerRaw['login'] : null;

    // ⚠️ EVERY ONE OF THESE IS LOAD-BEARING, so a missing one returns null rather
    // than a partial event: without the id the row cannot be idempotent, without
    // the commit it cannot be matched to a head, without the author it cannot be
    // attributed or permission-checked, and without the number it belongs to no
    // pull request.
    if (
      !providerRepoId ||
      !owner ||
      !name ||
      number === null ||
      !installationId ||
      !id ||
      !commitSha ||
      !state ||
      !providerUserId ||
      !login
    ) {
      return null;
    }

    // `submitted_at` is absent on an `edited` delivery; the review still exists, so
    // the event normalizes and the consumer keeps the stored timestamp.
    const submittedAtRaw = review['submitted_at'];
    const submittedAt =
      typeof submittedAtRaw === 'string' && !Number.isNaN(Date.parse(submittedAtRaw))
        ? new Date(submittedAtRaw)
        : new Date(0);

    const head = asRecord(pr['head']);

    return {
      action,
      installationId,
      repo: { owner, name, providerRepoId },
      pullRequest: {
        number,
        headSha: typeof head?.['sha'] === 'string' ? head['sha'] : null,
      },
      review: {
        id,
        state,
        commitSha,
        submittedAt,
        htmlUrl: typeof review['html_url'] === 'string' ? review['html_url'] : null,
        body:
          typeof review['body'] === 'string' && review['body'].trim()
            ? review['body'].trim()
            : null,
        reviewer: {
          providerUserId,
          login,
          type: typeof reviewerRaw?.['type'] === 'string' ? reviewerRaw['type'] : 'User',
        },
      },
    };
  },

  async getRepositoryPermission(input: RepositoryPermissionInput): Promise<RepositoryPermission> {
    // `metadata: read` is what this endpoint requires, and `motir-integration`
    // holds it (`docs/decisions/unlinked-pull-request-check.md`, the App table).
    // https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
    // lists `GET /repos/{owner}/{repo}/collaborators/{username}/permission` under
    // *Repository permissions for "Metadata"* → read, available to an installation
    // access token.
    const role = githubAppRoleForRepo({ owner: input.owner }, await motirOwnedOrgLogins());
    const { token } = await mintInstallationToken(input.installationId, role);

    const url =
      `${GITHUB_API}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}` +
      `/collaborators/${encodeURIComponent(input.username)}/permission`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'motir',
        },
      });
    } catch (err) {
      throw new ProviderPermissionReadError('github', 'unreachable', {
        message: err instanceof Error ? err.message : 'unknown',
      });
    }

    // ⚠️ 404 IS AN ANSWER, NOT A FAILURE. GitHub answers 404 when the user has no
    // access to the repository at all, which is exactly `none` — a fact about the
    // person. Throwing here would record `unknown` for the commonest legitimate
    // case and make a drive-by reviewer indistinguishable from a host outage.
    if (res.status === 404) return 'none';

    if (!res.ok) {
      throw new ProviderPermissionReadError('github', 'unexpected_status', {
        status: res.status,
      });
    }

    const body = asRecord(await res.json());
    // `role_name` carries custom roles too and is the field GitHub documents as
    // authoritative; `permission` is the legacy base role and is the fallback.
    return (
      normalizePermission(body?.['role_name']) ??
      normalizePermission(body?.['permission']) ??
      'none'
    );
  },

  // PURE, and deliberately payload-only: `merged → done` is the CANONICAL
  // lifecycle signal, not the completion decision. Whether that merge reached the
  // repository's default branch is settled by the consumer
  // (`changeRequestStatusSync`), which is the only layer holding the mirrored
  // `GithubRepo.defaultBranch` this seam cannot read (MOTIR-1873).
  changeRequestLifecycle(cr: NormalizedChangeRequest): ChangeRequestLifecycle | null {
    if (cr.merged) return 'done';
    if (cr.state === 'closed') return 'todo'; // closed WITHOUT merging — not done
    // ⚠️ OPEN AND A DRAFT — NO LIFECYCLE AT ALL (MOTIR-4968). The code exists and
    // is explicitly NOT offered for review, so calling it `implemented` asserts
    // something false about a pull request whose author has said the opposite.
    // The card becomes `implemented` on `ready_for_review` instead, which is the
    // moment that actually means it.
    //
    // ⚠️ THE POSITION OF THIS LINE IS THE RULE. It sits AFTER the two arms above
    // and not at the top of the function, because a blanket early return would
    // also swallow the two draft cases that MUST still act: a draft CLOSED
    // without merging (GitHub permits it; `draft: true, state: 'closed'`) has to
    // resolve to `todo` or an abandoned draft strands its card wherever it was,
    // and a `merged` draft has to resolve to `done` — GitHub blocks that today,
    // and this seam must not depend on it continuing to.
    if (cr.draft) return null;
    // OPEN — the code exists and CI has not spoken for it (MOTIR-3005). NOT
    // `in_review`: that state is written by the CI-feedback consumer alone.
    return 'implemented';
  },

  parseCiStatusEvent(rawPayload: unknown): NormalizedStatusEvent | null {
    const payload = asRecord(rawPayload);
    if (!payload) return null;
    const providerRepoId = idToString(asRecord(payload['repository'])?.['id']);
    if (!providerRepoId) return null;

    // Modern `check_run` event: a not-yet-completed run is `pending`. The
    // associated PRs sit on `check_run.pull_requests`; the branch on the nested
    // `check_run.check_suite.head_branch`.
    const checkRun = asRecord(payload['check_run']);
    if (checkRun) {
      const commitSha = typeof checkRun['head_sha'] === 'string' ? checkRun['head_sha'] : null;
      if (!commitSha) return null;
      const status = typeof checkRun['status'] === 'string' ? checkRun['status'] : null;
      const conclusion = typeof checkRun['conclusion'] === 'string' ? checkRun['conclusion'] : null;
      return {
        providerRepoId,
        commitSha,
        conclusion: status !== 'completed' ? 'pending' : mapConclusion(conclusion ?? 'neutral'),
        context: typeof checkRun['name'] === 'string' ? checkRun['name'] : 'check',
        ...readPrLink(checkRun['pull_requests'], asRecord(checkRun['check_suite'])),
        suiteId: readSuiteId(asRecord(checkRun['check_suite'])),
      };
    }

    // `check_suite` event: the AGGREGATE conclusion GitHub rolls all a commit's
    // check_runs into. A not-yet-completed suite is `pending`. The branch + the
    // associated PRs sit directly on `check_suite`; `context` is the App slug so
    // two Apps' suites keep distinct feedback.
    //
    // ⚠️ THE SLUG NAMES THE APP, NOT THE WORKFLOW (MOTIR-6274): every GitHub
    // Actions workflow reports as `github-actions`, so CI's, CodeQL's and the
    // acceptance lane's roll-ups share this name. `suiteAggregate` marks the row
    // so `liveCheckRows` never reads that shared name as "a re-run of the same
    // workflow" — which retired every older Actions suite at the commit.
    const checkSuite = asRecord(payload['check_suite']);
    if (checkSuite) {
      const commitSha = typeof checkSuite['head_sha'] === 'string' ? checkSuite['head_sha'] : null;
      if (!commitSha) return null;
      const status = typeof checkSuite['status'] === 'string' ? checkSuite['status'] : null;
      const conclusion =
        typeof checkSuite['conclusion'] === 'string' ? checkSuite['conclusion'] : null;
      const appSlug = asRecord(checkSuite['app'])?.['slug'];
      return {
        providerRepoId,
        commitSha,
        conclusion: status !== 'completed' ? 'pending' : mapConclusion(conclusion ?? 'neutral'),
        context: typeof appSlug === 'string' && appSlug.length > 0 ? appSlug : 'check_suite',
        ...readPrLink(checkSuite['pull_requests'], checkSuite),
        suiteId: readSuiteId(checkSuite),
        suiteAggregate: true,
      };
    }

    // Legacy commit-`status` event: { sha, state, context } — no PR list / branch.
    const sha = typeof payload['sha'] === 'string' ? payload['sha'] : null;
    const state = typeof payload['state'] === 'string' ? payload['state'] : null;
    if (sha && state) {
      return {
        providerRepoId,
        commitSha: sha,
        conclusion: mapConclusion(state),
        context: typeof payload['context'] === 'string' ? payload['context'] : 'status',
        prNumbers: [],
        headBranch: null,
        // A commit-`status` event predates check suites entirely — there is no
        // run to name, and the rows it writes degrade to the one no-identity
        // group `liveCheckRows` leaves alone.
        suiteId: null,
      };
    }

    return null;
  },

  /**
   * `pull_request` action `dequeued` → a merge-queue exit (MOTIR-5632). Read from a
   * real delivery (MOTIR-5627): `number`, `pull_request.head.sha`, and a top-level
   * `reason` in the webhook enum's UPPER_SNAKE spelling. A missing `reason` is
   * carried as `null` rather than refusing the delivery — the exit still happened,
   * and the classifier reads an absent reason as unrecognised.
   */
  parseMergeQueueExitEvent(rawPayload: unknown): NormalizedMergeQueueExit | null {
    const payload = asRecord(rawPayload);
    const member = readQueueMember(payload, 'dequeued');
    if (!payload || !member) return null;
    const reason = payload['reason'];
    return {
      ...member,
      rawReason: typeof reason === 'string' && reason.length > 0 ? reason : null,
    };
  },

  /**
   * `pull_request` action `enqueued` → a pull request put into the merge queue
   * (MOTIR-6903). The same three fields the `dequeued` delivery carries, read the same
   * way; the delivery's other fields (the queue entry, the sender) are not read.
   */
  parseMergeQueueEntryEvent(rawPayload: unknown): NormalizedMergeQueueEntry | null {
    return readQueueMember(asRecord(rawPayload), 'enqueued');
  },

  /**
   * A `merge_group` `checks_requested` delivery → the attempt it starts (MOTIR-5633).
   * The pull requests are read off `head_ref`, whose last segment is
   * `pr-<n>-<base sha>` (MOTIR-5627's capture); every `pr-<n>` in that segment is
   * taken, so a group that names several pull requests yields each of them.
   */
  parseMergeGroupAttemptEvent(rawPayload: unknown): NormalizedMergeGroupAttempt | null {
    const payload = asRecord(rawPayload);
    if (!payload || payload['action'] !== 'checks_requested') return null;
    const providerRepoId = idToString(asRecord(payload['repository'])?.['id']);
    const group = asRecord(payload['merge_group']);
    const headSha = group?.['head_sha'];
    const headRef = group?.['head_ref'];
    if (
      !providerRepoId ||
      typeof headSha !== 'string' ||
      headSha.length === 0 ||
      typeof headRef !== 'string'
    ) {
      return null;
    }
    const prNumbers = readQueuePrNumbers(headRef);
    if (prNumbers.length === 0) return null;
    return { providerRepoId, headSha, headRef, prNumbers };
  },

  /**
   * A `check_run` delivery that COMPLETED as a failure on a commit no pull request
   * names → the check a merge queue failed on (MOTIR-5633). "Failure" is
   * `mapConclusion`'s, the same verdict the CI feedback reads. A `check_suite`
   * delivery is not one: it names no check and links to none.
   */
  parseUnlinkedCheckFailure(rawPayload: unknown): NormalizedUnlinkedCheckFailure | null {
    const payload = asRecord(rawPayload);
    const checkRun = asRecord(payload?.['check_run']);
    if (!payload || !checkRun) return null;
    const providerRepoId = idToString(asRecord(payload['repository'])?.['id']);
    const headSha = checkRun['head_sha'];
    const name = checkRun['name'];
    const url = checkRun['html_url'];
    const conclusion = checkRun['conclusion'];
    if (
      !providerRepoId ||
      typeof headSha !== 'string' ||
      headSha.length === 0 ||
      typeof name !== 'string' ||
      typeof url !== 'string' ||
      checkRun['status'] !== 'completed' ||
      typeof conclusion !== 'string' ||
      mapConclusion(conclusion) !== 'failure' ||
      readPrNumbers(checkRun['pull_requests']).length > 0
    ) {
      return null;
    }
    const completedAt = new Date(String(checkRun['completed_at'] ?? ''));
    return {
      providerRepoId,
      headSha,
      name,
      url,
      completedAt: Number.isNaN(completedAt.getTime()) ? new Date() : completedAt,
      conclusion,
    };
  },

  /**
   * A `deployment_status` delivery → the normalized preview record (Story
   * MOTIR-4906 · MOTIR-5329). The mapping is exact and deliberately narrow:
   *
   * - `deployment.sha` → `commitSha`, `deployment.ref` → `ref`,
   *   `deployment.environment` → `environment`, `deployment.id` →
   *   `providerDeploymentId`;
   * - `deployment_status.state` → `state` (an unknown state normalizes to null
   *   rather than to a plausible member);
   * - `deployment_status.environment_url` → `environmentUrl`, and **never
   *   `target_url`**, which is the deployment's LOG link, not the app;
   * - `deployment_status.updated_at` (else `created_at`) → `occurredAt`.
   */
  parseDeploymentStatusEvent(rawPayload: unknown): NormalizedDeploymentStatus | null {
    const payload = asRecord(rawPayload);
    if (!payload) return null;
    const providerRepoId = idToString(asRecord(payload['repository'])?.['id']);
    const deployment = asRecord(payload['deployment']);
    const status = asRecord(payload['deployment_status']);
    if (!providerRepoId || !deployment || !status) return null;

    const providerDeploymentId = idToString(deployment['id']);
    const commitSha = typeof deployment['sha'] === 'string' ? deployment['sha'] : '';
    const ref = typeof deployment['ref'] === 'string' ? deployment['ref'] : '';
    const environment =
      typeof deployment['environment'] === 'string' ? deployment['environment'] : '';
    const rawState = status['state'];
    const state = (DEPLOYMENT_STATES as readonly string[]).includes(rawState as string)
      ? (rawState as DeploymentState)
      : null;
    const occurredAt = parseDate(status['updated_at']) ?? parseDate(status['created_at']);
    if (!providerDeploymentId || !commitSha || !ref || !environment || !state || !occurredAt) {
      return null;
    }

    const url = status['environment_url'];
    return {
      providerRepoId,
      providerDeploymentId,
      commitSha,
      ref,
      environment,
      state,
      environmentUrl: typeof url === 'string' && url.length > 0 ? url : null,
      occurredAt,
    };
  },

  parsePushEvent(rawPayload: unknown): NormalizedPushEvent | null {
    const payload = asRecord(rawPayload);
    if (!payload) return null;
    const providerRepoId = idToString(asRecord(payload['repository'])?.['id']);
    if (!providerRepoId) return null;

    // Only a BRANCH push refreshes the graph: `ref` is `refs/heads/<branch>` for
    // a branch, `refs/tags/<tag>` for a tag; a branch DELETION carries
    // `deleted: true` (nothing to index at a removed ref).
    const ref = typeof payload['ref'] === 'string' ? payload['ref'] : null;
    if (!ref || !ref.startsWith('refs/heads/') || payload['deleted'] === true) return null;
    const branch = ref.slice('refs/heads/'.length);
    if (branch.length === 0) return null;

    const after = payload['after'];
    return {
      providerRepoId,
      branch,
      headSha: typeof after === 'string' && after.length > 0 ? after : null,
    };
  },

  // --- CI-minutes metering (Story MOTIR-1775 · MOTIR-1896) -------------------
  // GitHub is the only provider that implements these; see the capability note
  // on the `GitProvider` interface and `ci-minutes-allowance.md` §5.6.

  parseWorkflowRunEvent(rawPayload: unknown): NormalizedWorkflowRunEvent | null {
    const payload = asRecord(rawPayload);
    if (!payload) return null;
    // Only a COMPLETED run is metered (§5.7 — the predicate is evaluated at run
    // completion, which is what makes the transfer edge need no special case).
    // `requested` / `in_progress` deliveries carry no billable duration.
    if (payload['action'] !== 'completed') return null;

    const run = asRecord(payload['workflow_run']);
    const repo = asRecord(payload['repository']);
    if (!run || !repo) return null;

    const providerRepoId = idToString(repo['id']);
    const runId = idToString(run['id']);
    // The repo OWNER comes from the run delivery's own `repository.owner.login`
    // — §5.5: never the stored mirror, which can hold a pre-transfer owner.
    const repoOwner =
      typeof asRecord(repo['owner'])?.['login'] === 'string'
        ? (asRecord(repo['owner'])!['login'] as string)
        : null;
    const repoName = typeof repo['name'] === 'string' ? repo['name'] : null;
    if (!providerRepoId || !runId || !repoOwner || !repoName) return null;

    // `run_attempt` is part of the idempotency key: a re-run is a NEW attempt
    // that GitHub bills again, so it must meter again (§5.8). A payload without
    // one is attempt 1.
    const rawAttempt = run['run_attempt'];
    const attempt =
      typeof rawAttempt === 'number' && Number.isInteger(rawAttempt) && rawAttempt > 0
        ? rawAttempt
        : 1;

    // `updated_at` is the completion instant on a `completed` delivery; fall
    // back to `run_started_at` only if it is missing, and refuse the delivery
    // when neither parses — a run with no usable instant cannot be assigned a
    // period (§4.5) or a rate effective-date (§3.3), and guessing one would
    // silently misfile real spend.
    const completedAt = parseDate(run['updated_at']) ?? parseDate(run['run_started_at']);
    if (!completedAt) return null;

    return {
      providerRepoId,
      runId,
      attempt,
      repoOwner,
      repoName,
      workflowName: typeof run['name'] === 'string' ? run['name'] : null,
      completedAt,
    };
  },

  // --- Production releases (Story MOTIR-9797 · MOTIR-10031) -----------------

  parseProductionImageRunEvent(rawPayload: unknown): NormalizedProductionImageRun | null {
    const payload = asRecord(rawPayload);
    if (!payload || payload['action'] !== 'completed') return null;
    const run = asRecord(payload['workflow_run']);
    const repo = asRecord(payload['repository']);
    if (!run || !repo) return null;

    const text = (value: unknown): string | null =>
      typeof value === 'string' && value.length > 0 ? value : null;
    const providerRepoId = idToString(repo['id']);
    const runId = idToString(run['id']);
    // The owner from the delivery's own `repository.owner.login`, as the meter
    // and the fleet read it — never the stored mirror.
    const repoOwner = text(asRecord(repo['owner'])?.['login']);
    const repoName = text(repo['name']);
    const workflowName = text(run['name']);
    const event = text(run['event']);
    const headBranch = text(run['head_branch']);
    const headSha = text(run['head_sha']);
    const conclusion = text(run['conclusion']);
    if (
      !providerRepoId ||
      !runId ||
      !repoOwner ||
      !repoName ||
      !workflowName ||
      !event ||
      !headBranch ||
      !headSha ||
      !conclusion
    ) {
      return null;
    }
    const rawAttempt = run['run_attempt'];
    const runAttempt =
      typeof rawAttempt === 'number' && Number.isInteger(rawAttempt) && rawAttempt > 0
        ? rawAttempt
        : 1;
    // What the merge was, for the Production panel (MOTIR-10103) — the head
    // commit's message only; a delivery without one still releases.
    const headCommit = mergeCommitFacts(asRecord(run['head_commit'])?.['message']);
    return {
      providerRepoId,
      repoOwner,
      repoName,
      workflowName,
      event,
      headBranch,
      headSha,
      conclusion,
      runId,
      runAttempt,
      headCommitSubject: headCommit.subject,
      pullRequestNumber: headCommit.pullRequestNumber,
    };
  },

  // --- The runner FLEET (Story MOTIR-1916 · MOTIR-1920) ----------------------

  parseWorkflowJobEvent(rawPayload: unknown): NormalizedWorkflowJobEvent | null {
    const payload = asRecord(rawPayload);
    if (!payload) return null;
    // Only a QUEUED job asks for a machine. `in_progress` means one was already
    // assigned and `completed` means it is finished — provisioning for either
    // boots a runner nothing will ever claim, which then idles until its
    // timeout, costing real money for no work.
    if (payload['action'] !== 'queued') return null;

    const job = asRecord(payload['workflow_job']);
    const repo = asRecord(payload['repository']);
    if (!job || !repo) return null;

    const providerRepoId = idToString(repo['id']);
    const runId = idToString(job['run_id']);
    const jobId = idToString(job['id']);
    // The OWNER comes from the delivery's own `repository.owner.login`, exactly
    // as the meter reads it (§5.5) — the mirror can hold a pre-transfer owner,
    // and this is the identity the fleet's org-level runner group belongs to.
    const repoOwner =
      typeof asRecord(repo['owner'])?.['login'] === 'string'
        ? (asRecord(repo['owner'])!['login'] as string)
        : null;
    const repoName = typeof repo['name'] === 'string' ? repo['name'] : null;
    if (!providerRepoId || !runId || !jobId || !repoOwner || !repoName) return null;

    // `run_attempt` completes the idempotency key: a RE-RUN is a new attempt
    // whose jobs are genuinely new work needing their own ephemeral runners
    // (§5.8's discipline, one level down). A payload without one is attempt 1.
    const rawAttempt = job['run_attempt'];
    const runAttempt =
      typeof rawAttempt === 'number' && Number.isInteger(rawAttempt) && rawAttempt > 0
        ? rawAttempt
        : 1;

    // ⚠️ `labels` on a QUEUED delivery is necessarily the set `runs-on`
    // REQUESTED, not a runner's own labels — at `queued` GitHub has assigned no
    // runner, so there is no runner whose labels could be reported. This settles
    // the "honest unknown" §M names (GitHub's REST reference lists `labels`
    // without saying which it is) for the provisioning path, and it is the
    // reading the fleet needs: the decision to boot must be made from what the
    // workflow ASKED for. §M's rules were written to hold either way, so
    // MOTIR-1923's classifier is unaffected; live confirmation on a real fleet
    // job belongs to MOTIR-1928.
    const requestedLabels = Array.isArray(job['labels'])
      ? job['labels'].filter((label): label is string => typeof label === 'string')
      : [];

    // A queued job with no usable instant is refused rather than stamped with
    // "now": the age of an intent is what a stuck-queue alarm reads, and a
    // guessed timestamp would make a job that queued an hour ago look fresh.
    const queuedAt = parseDate(job['started_at']) ?? parseDate(job['created_at']);
    if (!queuedAt) return null;

    return {
      providerRepoId,
      runId,
      runAttempt,
      jobId,
      jobName: typeof job['name'] === 'string' ? job['name'] : null,
      workflowName: typeof job['workflow_name'] === 'string' ? job['workflow_name'] : null,
      repoOwner,
      repoName,
      requestedLabels,
      queuedAt,
    };
  },

  async fetchWorkflowRunJobs(
    installationId: string,
    owner: string,
    name: string,
    runId: string,
    attempt: number,
  ): Promise<NormalizedWorkflowJob[]> {
    // Provenance, as above (MOTIR-5861). A hosted repository is exactly the one
    // whose Actions minutes Motir is billed for, so metering it is the case that
    // matters most and the case the user-facing default cannot reach.
    const role = githubAppRoleForRepo({ owner }, await motirOwnedOrgLogins());
    const { token } = await mintInstallationToken(installationId, role);
    // The ATTEMPT-scoped jobs endpoint, so a re-run reads only its OWN jobs —
    // `/runs/{id}/jobs` would return every attempt's jobs and double-count.
    //
    // Deliberately NOT `/runs/{id}/timing`: that endpoint returns `billable` per
    // OS directly and would be the obvious read, but GitHub has it "in the
    // process of closing down" (§5.8), as it does the product-specific billing
    // API. `/jobs` is not deprecated and carries `started_at`, `completed_at`
    // and `labels` — everything the normalization needs.
    const url =
      `${GITHUB_API}/repos/${owner}/${name}/actions/runs/${runId}` +
      `/attempts/${attempt}/jobs?per_page=100`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'motir',
        },
      });
    } catch (err) {
      throw new Error(
        `GitHub workflow-jobs endpoint unreachable (${err instanceof Error ? err.message : 'unknown'})`,
      );
    }
    if (!res.ok) throw new Error(`GitHub workflow-jobs endpoint returned ${res.status}`);
    const body = asRecord(await res.json());
    const list = Array.isArray(body?.['jobs']) ? (body!['jobs'] as unknown[]) : [];
    return list
      .map(normalizeWorkflowJob)
      .filter((job): job is NormalizedWorkflowJob => job !== null);
  },

  async fetchOrgComputeUsage(
    org: string,
    year: number,
    month: number,
    token: string,
  ): Promise<NormalizedComputeUsageLine[]> {
    // The ENHANCED-BILLING usage endpoint — the replacement for the closing-down
    // product-specific billing API (§5.8). Summarised by SKU/repo/day, which is
    // enough to RECONCILE and never enough to meter.
    const url = `${GITHUB_API}/organizations/${org}/settings/billing/usage?year=${year}&month=${month}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'motir',
        },
      });
    } catch (err) {
      throw new Error(
        `GitHub billing-usage endpoint unreachable (${err instanceof Error ? err.message : 'unknown'})`,
      );
    }
    if (!res.ok) throw new Error(`GitHub billing-usage endpoint returned ${res.status}`);
    const body = asRecord(await res.json());
    const items = Array.isArray(body?.['usageItems']) ? (body!['usageItems'] as unknown[]) : [];
    return items
      .map(normalizeUsageLine)
      .filter((line): line is NormalizedComputeUsageLine => line !== null);
  },
};

/** Parse a GitHub ISO-8601 timestamp, or null when absent / unparseable. */
function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Normalize one entry of the workflow-jobs listing. A job with no id/name is
 *  unusable; one with no timestamps still normalizes (the meter skips it, which
 *  keeps "why did this run meter nothing?" answerable from the job list). */
function normalizeWorkflowJob(value: unknown): NormalizedWorkflowJob | null {
  const job = asRecord(value);
  if (!job) return null;
  const id = idToString(job['id']);
  if (!id) return null;
  const labels = Array.isArray(job['labels'])
    ? (job['labels'] as unknown[]).filter((l): l is string => typeof l === 'string')
    : [];
  return {
    id,
    name: typeof job['name'] === 'string' ? job['name'] : 'job',
    startedAt: parseDate(job['started_at']),
    completedAt: parseDate(job['completed_at']),
    labels,
  };
}

/** Normalize one `usageItems[]` entry of the enhanced-billing report. */
function normalizeUsageLine(value: unknown): NormalizedComputeUsageLine | null {
  const item = asRecord(value);
  if (!item) return null;
  const repositoryName = typeof item['repositoryName'] === 'string' ? item['repositoryName'] : null;
  const sku = typeof item['sku'] === 'string' ? item['sku'] : null;
  const quantity = typeof item['quantity'] === 'number' ? item['quantity'] : null;
  if (repositoryName === null || sku === null || quantity === null) return null;
  return {
    repositoryName,
    sku,
    quantity,
    unitType: typeof item['unitType'] === 'string' ? item['unitType'] : 'unknown',
    date: typeof item['date'] === 'string' ? item['date'] : '',
  };
}

/** Extract the associated PR/MR numbers from a check payload's `pull_requests`
 *  array (each entry is `{ number, ... }`), deduped. Empty when absent. */
function readPrNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<number>();
  for (const entry of value) {
    const number = asRecord(entry)?.['number'];
    if (typeof number === 'number' && Number.isInteger(number)) out.add(number);
  }
  return [...out];
}

/** The `head_branch` off a `check_suite` object (present on both the `check_suite`
 *  event and nested in a `check_run`), or null. */
function readHeadBranch(checkSuite: Record<string, unknown> | null): string | null {
  const branch = checkSuite?.['head_branch'];
  return typeof branch === 'string' && branch.length > 0 ? branch : null;
}

/** GitHub's own ref for a pull request, `refs/pull/<n>/head` or `refs/pull/<n>/merge`. */
const PULL_REF = /^refs\/pull\/(\d+)\/(?:head|merge)$/;

/** The event's link back to its pull request: the payload's `pull_requests`
 *  numbers, and the suite's `head_branch` as the fallback.
 *
 *  ⚠️ `head_branch` IS NOT ALWAYS A BRANCH (MOTIR-5918). A workflow triggered on
 *  the pull request's own ref — CodeQL DEFAULT SETUP is the one observed — reports
 *  `refs/pull/<n>/head` there, with an empty `pull_requests`. That literal matches
 *  no stored `head_ref`, so every delivery from such a suite used to be dropped.
 *  The ref names the pull request by NUMBER, so it is read as one, after any the
 *  payload listed, and is never offered to a consumer as a branch name. */
function readPrLink(
  pullRequests: unknown,
  checkSuite: Record<string, unknown> | null,
): { prNumbers: number[]; headBranch: string | null } {
  const prNumbers = readPrNumbers(pullRequests);
  const headBranch = readHeadBranch(checkSuite);
  const pullRef = headBranch ? PULL_REF.exec(headBranch) : null;
  if (!pullRef) return { prNumbers, headBranch };
  const number = Number(pullRef[1]);
  return {
    prNumbers: prNumbers.includes(number) ? prNumbers : [...prNumbers, number],
    headBranch: null,
  };
}

/** The `id` off a `check_suite` object — the CI RUN's identity (MOTIR-3209), on
 *  both the `check_suite` event and the object nested in a `check_run`. Null
 *  when the payload carries none, which a delivery from before this was read
 *  (or a hand-built fixture) legitimately does. */
function readSuiteId(checkSuite: Record<string, unknown> | null): string | null {
  return checkSuite ? idToString(checkSuite['id']) : null;
}

// Register the GitHub provider on import. `lib/git/index.ts` imports this module
// for exactly this side-effect, so any consumer that imports `@/lib/git` gets
// GitHub registered before it resolves a provider.
registerGitProvider(githubProvider);

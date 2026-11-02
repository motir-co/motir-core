import { registerGitProvider } from '../registry';
import { FULL_COMMIT_SHA } from '../commitSha';
import { gitlabConnectionService } from '@/lib/services/gitlabConnectionService';
import { gitlabBaseUrl } from '@/lib/gitlab/gitlabOAuth';
import {
  CHANGED_FILES_MAX,
  CHANGED_FILES_TIMEOUT_MS,
  COMMIT_COMPARE_TIMEOUT_MS,
  REPO_FILE_FETCH_MAX_BYTES,
  REPO_FILE_READ_TIMEOUT_MS,
  type GitProvider,
} from '../provider';
import {
  classifyRepoBlob,
  describeBody,
  gitlabTreeEntry,
  normalizeRepoFilePath,
  REPO_DIRECTORY_MAX_ENTRIES,
  sortEntries,
} from '../fileRead';
import { RepoFileReadError } from '../errors';
import {
  GitlabConnectionNotFoundError,
  GitlabOAuthNotConfiguredError,
  GitlabTokenRefreshError,
} from '@/lib/gitlab/errors';
import type {
  ChangeRequestLifecycle,
  CiConclusion,
  InstallationToken,
  NormalizedChangeRequest,
  NormalizedInstallation,
  NormalizedPushEvent,
  NormalizedRepo,
  NormalizedStatusEvent,
  RepoDirectoryEntry,
  RepoFileReadResult,
  RefResolution,
  CommitComparison,
  ChangedFile,
  ChangedFilesResult,
  DeploymentState,
  NormalizedDeploymentStatus,
} from '../types';

// The GitLab implementation of the GitProvider seam (Story 7.23 · MOTIR-1474) —
// the SECOND registered provider, proving the 7.10.10/MOTIR-891 seam is additive.
// It normalizes GitLab's merge-request / pipeline / push webhook payloads into the
// provider-agnostic shapes, and reaches GitLab's REST API with the connection's
// stored access token (refreshed as needed by `gitlabConnectionService`). Every
// consumer (MOTIR-1475 status sync, MOTIR-1476 code-graph feed) dispatches through
// the `GitProvider` interface by the stored `provider` discriminator and holds NO
// GitLab-specific types — exactly as it does for GitHub.

/**
 * GitLab `deployment` hook `status` → the shared deployment-state union (Story
 * MOTIR-4906 · MOTIR-5332). TOTAL over the five statuses GitLab documents; any
 * other value normalizes to null — the hook is refused rather than stored under a
 * plausible member nobody reported.
 */
const GITLAB_DEPLOYMENT_STATUS: Readonly<Record<string, DeploymentState>> = {
  created: 'pending',
  running: 'in_progress',
  success: 'success',
  failed: 'failure',
  canceled: 'canceled',
};

/**
 * Parse GitLab's hook timestamp. GitLab sends `status_changed_at` as
 * `2021-04-28 21:50:00 +0200` — not ISO 8601 — so it is rewritten to
 * `2021-04-28T21:50:00+02:00` before parsing; an ISO value passes through.
 */
function parseGitlabTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const m =
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ?(?:([+-])(\d{2}):?(\d{2})|UTC)?$/.exec(
      value.trim(),
    );
  const iso = m ? `${m[1]}T${m[2]}${m[3] ? `${m[3]}${m[4]}:${m[5]}` : 'Z'}` : value;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Narrow an `unknown` to a plain object without asserting `any`. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** The GitLab numeric id (project) as our string form, or null. */
function idToString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

/** Normalize one project object from `GET /projects`. GitLab's
 *  `path_with_namespace` is `<owner>/<name>`; `path` is the project slug. */
function normalizeProject(value: unknown): NormalizedRepo | null {
  const project = asRecord(value);
  if (!project) return null;
  const providerRepoId = idToString(project['id']);
  const pathWithNamespace =
    typeof project['path_with_namespace'] === 'string' ? project['path_with_namespace'] : null;
  const name = typeof project['path'] === 'string' ? project['path'] : null;
  // `owner` is everything before the last `/` of the full path (a group can be
  // nested, so keep the whole namespace, not just the top level).
  const owner = pathWithNamespace
    ? pathWithNamespace.slice(0, pathWithNamespace.lastIndexOf('/'))
    : null;
  const defaultBranch =
    typeof project['default_branch'] === 'string' && project['default_branch'].length > 0
      ? project['default_branch']
      : 'main';
  if (!providerRepoId || !name || !owner) return null;
  // GitLab reports the same liveness fact under the same key (`archived: true` on
  // `GET /projects`), and an archived GitLab project is read-only exactly as an
  // archived GitHub repo is — so the normalization is identical, not a per-provider
  // special case (MOTIR-1959).
  return { providerRepoId, owner, name, defaultBranch, archived: project['archived'] === true };
}

/** Map a GitLab pipeline `status` to our normalized CI conclusion. */
function mapPipelineStatus(raw: string): CiConclusion {
  switch (raw) {
    case 'success':
      return 'success';
    case 'failed':
    case 'canceled':
    case 'cancelled':
      return 'failure';
    case 'running':
    case 'pending':
    case 'created':
    case 'preparing':
    case 'waiting_for_resource':
    case 'scheduled':
      return 'pending';
    default:
      return 'neutral'; // skipped / manual / anything unrecognised
  }
}

const ZERO_SHA = '0'.repeat(40);

/**
 * GitLab's compare endpoint caps the commits it returns; a response sitting on
 * the cap may have been cut, and a cut list's LENGTH is a wrong drift count that
 * renders exactly like a right one. 1000 is GitLab's documented ceiling for the
 * compare response — treated as "at or above ⇒ inexact", so the boundary case
 * lands on `null` rather than on a number nobody can vouch for.
 */
const GITLAB_COMPARE_MAX_COMMITS = 1000;

// ─── listChangedFiles (MOTIR-6619) ───────────────────────────────────────────

/** One `diffs[]` entry → a {@link ChangedFile}, or null when it carries no path.
 *  GitLab states the change as three booleans rather than one word; a deletion
 *  is named by its OLD path (its new path is the same string, but the old one is
 *  the one that existed). NAMES ONLY: the entry's `diff` hunk is never read. */
function gitlabChangedFile(value: unknown): ChangedFile | null {
  const diff = asRecord(value);
  if (!diff) return null;
  const newPath = typeof diff['new_path'] === 'string' ? diff['new_path'] : '';
  const oldPath = typeof diff['old_path'] === 'string' ? diff['old_path'] : '';
  if (diff['deleted_file'] === true) {
    const path = oldPath || newPath;
    return path ? { path, status: 'removed' } : null;
  }
  if (!newPath) return null;
  if (diff['new_file'] === true) return { path: newPath, status: 'added' };
  if (diff['renamed_file'] === true && oldPath && oldPath !== newPath) {
    return { path: newPath, status: 'renamed', previousPath: oldPath };
  }
  return { path: newPath, status: 'modified' };
}

/**
 * A failed token read, as a named absence — the GitLab twin of the GitHub
 * provider's mint mapping. An OAuth app not wired on this deployment, or a
 * connection row that is gone, is `not_connected`; a refresh the host rejected is
 * `revoked`; anything else is `host_error`.
 */
function gitlabTokenFailure(
  err: unknown,
  refs: { base: string; head: string },
): ChangedFilesResult {
  if (
    err instanceof GitlabOAuthNotConfiguredError ||
    err instanceof GitlabConnectionNotFoundError
  ) {
    return { outcome: 'not_connected', ...refs };
  }
  if (err instanceof GitlabTokenRefreshError) return { outcome: 'revoked', ...refs };
  return {
    outcome: 'host_error',
    ...refs,
    detail: err instanceof Error ? err.message : 'the connection token could not be read',
  };
}

/** `…/-/compare/<from-sha>...<to-sha>` — the SHAs GitLab resolved the two refs to,
 *  read off the response's `web_url`. Only the hex groups are kept. */
function gitlabCompareShas(webUrl: unknown): { baseSha: string | null; headSha: string | null } {
  const m =
    typeof webUrl === 'string'
      ? /\/compare\/([0-9a-f]{7,64})\.\.\.([0-9a-f]{7,64})(?:$|[?#])/i.exec(webUrl)
      : null;
  return { baseSha: m?.[1] ?? null, headSha: m?.[2] ?? null };
}

/** GitLab's head commit for an MR payload's `object_attributes` — `last_commit.id`. */
function readLastCommitId(attrs: Record<string, unknown>): string | null {
  const lastCommit = asRecord(attrs['last_commit']);
  return typeof lastCommit?.['id'] === 'string' ? lastCommit['id'] : null;
}

export const gitlabProvider: GitProvider = {
  id: 'gitlab',

  mintInstallationToken(installationId: string): Promise<InstallationToken> {
    return gitlabConnectionService.getAccessToken(installationId);
  },

  async fetchInstallationRepos(installationId: string): Promise<NormalizedRepo[]> {
    const { token } = await gitlabConnectionService.getAccessToken(installationId);
    let res: Response;
    try {
      res = await fetch(
        `${gitlabBaseUrl()}/api/v4/projects?membership=true&simple=true&per_page=100`,
        { headers: { authorization: `Bearer ${token}`, 'user-agent': 'motir' } },
      );
    } catch (err) {
      throw new Error(
        `GitLab projects endpoint unreachable (${err instanceof Error ? err.message : 'unknown'})`,
      );
    }
    if (!res.ok) throw new Error(`GitLab projects endpoint returned ${res.status}`);
    const body = await res.json();
    const list = Array.isArray(body) ? (body as unknown[]) : [];
    return list.map(normalizeProject).filter((repo): repo is NormalizedRepo => repo !== null);
  },

  // ⚠️ NO `resolveRepoTarballUrl`, AND NO BYTE-FETCHING SIBLING EITHER — THIS IS
  // THE HONEST SHAPE, NOT AN OMISSION (MOTIR-2124). GitLab's
  // `/projects/:id/repository/archive` answers **200 with the tarball bytes**; it
  // does not redirect to a pre-signed URL the way GitHub's `/tarball` does
  // (measured against both live hosts, 2026-08-04). A token in the query string
  // would make a fetchable URL, but the only token Motir holds here is the
  // connection's `api`-scoped OAuth token, which reaches every project that user
  // can see — more privilege than `docs/decisions/code-graph-index-fleet.md` §4/§10
  // permit a container to hold, not less.
  //
  // This provider USED to implement `fetchRepoTarball`, and that method is what
  // made the gap invisible: it satisfied a required interface method, so GitLab
  // looked like a complete provider while the capability the shipped fleet path
  // actually needs was absent — and every GitLab index dead-lettered five times
  // saying nothing. The gap is now DECLARED (this comment + the absent method) and
  // ENFORCED (`codeGraphIndexService.resolveIndexTarget` refuses before dispatch,
  // and the connect surface tells the user). Do not "fix" it by adding bytes back:
  // that is the 180 s-bounded in-process shape MOTIR-2057 deleted.

  // ⚠️ AND YET IT DOES IMPLEMENT `readFileAtRef` — the two are not in tension,
  // and the difference is the whole reason one is optional and the other is
  // required. The block above refuses to build a URL-shaped credential to hand
  // a container. This method hands nobody anything: the request is made HERE,
  // with the connection's token, in the process that already holds it, and what
  // comes back is text. Nothing credential-shaped crosses a boundary, so the
  // §4/§10 objection has nothing to bite on.
  /**
   * `GET /api/v4/projects/:id/repository/compare?from=<base>&to=<head>` — GitLab
   * answers with a `commits[]` array rather than a count, so the count is that
   * array's LENGTH.
   *
   * ⚠️ AND THAT IS WHY THIS IMPLEMENTATION IS MORE CAUTIOUS THAN GITHUB'S. A
   * length is only the drift if the host returned EVERY commit; GitLab caps the
   * compare response, and a capped array yields a number that is
   * arithmetically real and wrong — the worst kind, because it renders exactly
   * like a correct one. So when the array arrives at the cap this returns
   * `inexact` (`null`), never the capped length.
   *
   * ⚠️ AN EMPTY `commits[]` IS AMBIGUOUS ON THIS HOST, and it is resolved by
   * `compare_same_ref`: GitLab answers `[]` both for "identical refs" (a genuine
   * ZERO) and for "no common ancestor" (UNDEFINED). Reading the flag is what
   * keeps a force-pushed repository from rendering as current.
   */
  async compareCommits(
    installationId: string,
    owner: string,
    name: string,
    base: string,
    head: string,
  ): Promise<CommitComparison> {
    const { token } = await gitlabConnectionService.getAccessToken(installationId);
    const project = encodeURIComponent(`${owner}/${name}`);
    const url =
      `${gitlabBaseUrl()}/api/v4/projects/${project}/repository/compare` +
      `?from=${encodeURIComponent(base)}&to=${encodeURIComponent(head)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COMMIT_COMPARE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, 'user-agent': 'motir' },
        signal: controller.signal,
      });
    } catch {
      return { behindBy: null, reason: 'unreachable' };
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 404) return { behindBy: null, reason: 'no_common_ancestor' };
    if (!res.ok) return { behindBy: null, reason: 'unreachable' };

    const body: unknown = await res.json().catch(() => null);
    if (!body || typeof body !== 'object') return { behindBy: null, reason: 'inexact' };
    const bag = body as Record<string, unknown>;
    const commits = bag['commits'];
    if (!Array.isArray(commits)) return { behindBy: null, reason: 'inexact' };

    // An empty list means IDENTICAL only when the host says the refs are the
    // same; otherwise the pair has no path between them and the count is
    // undefined.
    if (commits.length === 0) {
      return bag['compare_same_ref'] === true
        ? { behindBy: 0 }
        : { behindBy: null, reason: 'no_common_ancestor' };
    }
    // A TRUNCATED comparison is not a smaller one. `compare_timeout` is GitLab's
    // own signal that it stopped early, and a response sitting exactly on the
    // cap is indistinguishable from one that was cut — both are `inexact`.
    if (bag['compare_timeout'] === true || commits.length >= GITLAB_COMPARE_MAX_COMMITS) {
      return { behindBy: null, reason: 'inexact' };
    }
    return { behindBy: commits.length };
  },

  /**
   * `GET /api/v4/projects/:id/repository/compare?from=<base>&to=<head>` — the
   * endpoint {@link compareCommits} counts `commits[]` from, read here for
   * `diffs[]` (MOTIR-6619). GitLab's default (`straight=false`) compares from
   * the MERGE BASE, which is GitHub's three-dot — so the two hosts list the same
   * paths for the same branch.
   *
   * ⚠️ THE CAP IS OURS HERE. GitLab applies no 300-file limit of its own, so
   * without {@link CHANGED_FILES_MAX} the same branch would list 300 paths on
   * one host and 900 on the other — a session learning a different fact about a
   * branch because of where it is hosted.
   *
   * Status → outcome: 404 `Ref Not Found` is `no_such_ref`; a 404 naming the
   * PROJECT, and 401 / 403, are `revoked` (the token can no longer see it); a
   * 200 with `compare_timeout: true` is `too_large` — GitLab gave up building
   * the diff, so its partial list is not an answer; everything else, and no
   * answer within {@link CHANGED_FILES_TIMEOUT_MS}, is `host_error`.
   */
  async listChangedFiles(
    installationId: string,
    owner: string,
    name: string,
    base: string,
    head: string,
  ): Promise<ChangedFilesResult> {
    const refs = { base, head };
    let token: string;
    try {
      ({ token } = await gitlabConnectionService.getAccessToken(installationId));
    } catch (err) {
      return gitlabTokenFailure(err, refs);
    }
    const project = encodeURIComponent(`${owner}/${name}`);
    const url =
      `${gitlabBaseUrl()}/api/v4/projects/${project}/repository/compare` +
      `?from=${encodeURIComponent(base)}&to=${encodeURIComponent(head)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHANGED_FILES_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, 'user-agent': 'motir' },
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

    if (res.status === 404) {
      const body = await res.text().catch(() => '');
      return /project/i.test(body)
        ? { outcome: 'revoked', ...refs }
        : { outcome: 'no_such_ref', ...refs };
    }
    if (res.status === 401 || res.status === 403) return { outcome: 'revoked', ...refs };
    if (!res.ok) {
      return { outcome: 'host_error', ...refs, detail: `GitLab compare returned ${res.status}` };
    }

    const body = asRecord(await res.json().catch(() => null));
    if (body?.['compare_timeout'] === true) return { outcome: 'too_large', ...refs };
    const rawDiffs = body?.['diffs'];
    if (!body || !Array.isArray(rawDiffs)) {
      return { outcome: 'host_error', ...refs, detail: 'GitLab compare returned no diffs list' };
    }
    const files = rawDiffs
      .map(gitlabChangedFile)
      .filter((f): f is ChangedFile => f !== null)
      .slice(0, CHANGED_FILES_MAX);
    const shas = gitlabCompareShas(body['web_url']);
    const headCommit = asRecord(body['commit'])?.['id'];
    return {
      outcome: 'ok',
      ...refs,
      files,
      truncated: rawDiffs.length >= CHANGED_FILES_MAX,
      baseSha: shas.baseSha,
      headSha:
        shas.headSha ??
        (typeof headCommit === 'string' && /^[0-9a-f]{7,64}$/i.test(headCommit)
          ? headCommit
          : null),
    };
  },

  async resolveRef(
    installationId: string,
    owner: string,
    name: string,
    ref: string,
  ): Promise<RefResolution> {
    const { token } = await gitlabConnectionService.getAccessToken(installationId);
    const project = encodeURIComponent(`${owner}/${name}`);
    const url =
      `${gitlabBaseUrl()}/api/v4/projects/${project}/repository/commits/` + encodeURIComponent(ref);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REPO_FILE_READ_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, 'user-agent': 'motir' },
        signal: controller.signal,
      });
    } catch (err) {
      return {
        outcome: 'unreachable',
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
    if (res.status === 404) return { outcome: 'ref_not_found', ref };
    if (res.status === 401 || res.status === 403) return { outcome: 'unauthorized', ref };
    if (!res.ok) throw new RepoFileReadError('gitlab', res.status, await describeBody(res));
    const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
    const sha = typeof body?.id === 'string' ? body.id.trim().toLowerCase() : '';
    if (!FULL_COMMIT_SHA.test(sha)) {
      throw new RepoFileReadError('gitlab', res.status, 'the commit lookup returned no id');
    }
    return { outcome: 'resolved', ref, sha };
  },

  async readFileAtRef(
    installationId: string,
    owner: string,
    name: string,
    path: string,
    ref: string,
  ): Promise<RepoFileReadResult> {
    // The guard runs BEFORE the token is fetched and before a URL exists — the
    // same ordering the GitHub implementation uses, and for the same reason.
    const guarded = normalizeRepoFilePath(path);
    if (!guarded.ok) return { outcome: 'invalid_path', path, reason: guarded.reason };

    const { token } = await gitlabConnectionService.getAccessToken(installationId);
    // GitLab addresses a project by numeric id OR by URL-encoded
    // `path_with_namespace`, and the second is what we have: `owner` is the
    // whole namespace (a group can be nested, which `normalizeProject` above
    // already preserves), so `owner/name` is that path. Both slashes must be
    // encoded — the one inside the project path AND every one inside the FILE
    // path, which is why `encodeURIComponent` is applied to the joined string
    // rather than per segment.
    const project = encodeURIComponent(`${owner}/${name}`);
    const filePath = encodeURIComponent(guarded.path);
    const url =
      `${gitlabBaseUrl()}/api/v4/projects/${project}/repository/files/${filePath}/raw` +
      `?ref=${encodeURIComponent(ref)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REPO_FILE_READ_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, 'user-agent': 'motir' },
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

    // GitLab, like GitHub, answers 404 for both a missing path and a missing
    // ref — and, like GitHub, it says which in its `message`. The two hosts
    // therefore differ in their wording and NOT in what a session learns, which
    // is the property this whole capability is for: a planner must not conclude
    // a different fact about the same repository because of where it is hosted.
    if (res.status === 404) {
      const body = await res.text().catch(() => '');
      if (/reference|revision|branch|commit/i.test(body) && !/file/i.test(body)) {
        return { outcome: 'ref_not_found', path: guarded.path, ref };
      }
      // The files endpoint answers 404 for a DIRECTORY, so a miss is asked of
      // the tree before it is called one (MOTIR-9868) — GitHub lists a directory
      // in the same read, and a session must learn the same fact on either host.
      const listing = await listGitlabDirectory(token, project, guarded.path, ref);
      return listing
        ? { outcome: 'directory', path: guarded.path, ref, ...listing }
        : { outcome: 'not_found', path: guarded.path, ref };
    }
    if (res.status === 401 || res.status === 403) {
      return { outcome: 'unauthorized', path: guarded.path, ref };
    }
    if (!res.ok) {
      throw new RepoFileReadError('gitlab', res.status, await describeBody(res));
    }

    // ⚠️ GITLAB HAS NO SIZE REFUSAL, SO THE CAP HAS TO BE OURS. GitHub's raw
    // read answers 403 above 100 MB; GitLab streams whatever is there. Without
    // this arm the SAME file would be a named `too_large` on one host and a
    // string of any size on the other — the exact per-host divergence the
    // shared limit in `provider.ts` exists to prevent. Checking
    // `content-length` first is what keeps a large body from being buffered at
    // all; the check on the read blob catches a chunked response that declared none.
    // The 1 MB WHOLE-file limit is the service's, not this (MOTIR-10143).
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > REPO_FILE_FETCH_MAX_BYTES) {
      return {
        outcome: 'too_large',
        path: guarded.path,
        ref,
        limitBytes: REPO_FILE_FETCH_MAX_BYTES,
      };
    }
    // The BYTES, never `res.text()` — a lenient decode turns a binary blob into
    // `found` and inflates its size (`classifyRepoBlob`, MOTIR-7873).
    const blob = new Uint8Array(await res.arrayBuffer());
    if (blob.byteLength > REPO_FILE_FETCH_MAX_BYTES) {
      return {
        outcome: 'too_large',
        path: guarded.path,
        ref,
        limitBytes: REPO_FILE_FETCH_MAX_BYTES,
      };
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
    // GitLab has no App-installation read; the connection's account is the
    // authorized user. Fetch it with the connection's own token.
    const { token } = await gitlabConnectionService.getAccessToken(installationId);
    let res: Response;
    try {
      res = await fetch(`${gitlabBaseUrl()}/api/v4/user`, {
        headers: { authorization: `Bearer ${token}`, 'user-agent': 'motir' },
      });
    } catch (err) {
      throw new Error(
        `GitLab user endpoint unreachable (${err instanceof Error ? err.message : 'unknown'})`,
      );
    }
    if (!res.ok) throw new Error(`GitLab user endpoint returned ${res.status}`);
    const body = asRecord(await res.json());
    const accountLogin = typeof body?.['username'] === 'string' ? body['username'] : '';
    if (!accountLogin) throw new Error('GitLab user endpoint returned no username');
    return { installationId, accountLogin, accountType: 'User' };
  },

  parseChangeRequestEvent(rawPayload: unknown): NormalizedChangeRequest | null {
    const payload = asRecord(rawPayload);
    if (!payload || payload['object_kind'] !== 'merge_request') return null;
    const attrs = asRecord(payload['object_attributes']);
    const project = asRecord(payload['project']);
    if (!attrs || !project) return null;

    const providerRepoId = idToString(project['id']);
    const number = typeof attrs['iid'] === 'number' ? attrs['iid'] : null;
    const headRef = typeof attrs['source_branch'] === 'string' ? attrs['source_branch'] : null;
    // GitLab's name for the base (MOTIR-1873) — read as strictly as the source,
    // for the same reason: a merge with no known destination cannot be judged
    // against the trunk.
    const baseRef = typeof attrs['target_branch'] === 'string' ? attrs['target_branch'] : null;
    const state = typeof attrs['state'] === 'string' ? attrs['state'] : null;
    if (!providerRepoId || number === null || !headRef || !baseRef || !state) return null;

    // GitLab MR states: opened | closed | merged | locked. `merged` is its own
    // state (not a boolean), so collapse it into our orthogonal state/merged pair.
    return {
      providerRepoId,
      number,
      state: state === 'opened' || state === 'locked' ? 'open' : 'closed',
      merged: state === 'merged',
      headRef,
      baseRef,
      // The head COMMIT (MOTIR-7005): the MR's `last_commit`.
      headSha: readLastCommitId(attrs),
      title: typeof attrs['title'] === 'string' ? attrs['title'] : null,
      // The DRAFT flag (MOTIR-4968). GitLab carries BOTH names on
      // `object_attributes` — `draft` is the current one and `work_in_progress`
      // the legacy alias it kept for compatibility — so read either rather than
      // picking one and hoping every deployment agrees. Self-hosted GitLab
      // instances lag the SaaS release by arbitrary amounts, which is exactly
      // the case a single-name read would fail silently on.
      draft: attrs['draft'] === true || attrs['work_in_progress'] === true,
    };
  },

  // PURE and payload-only, exactly as GitHub's is: the trunk check that turns
  // `done` into an actual completion lives in the shared consumer, which holds the
  // mirrored default branch (MOTIR-1873).
  changeRequestLifecycle(cr: NormalizedChangeRequest): ChangeRequestLifecycle | null {
    if (cr.merged) return 'done';
    if (cr.state === 'closed') return 'todo'; // closed WITHOUT merging — not done
    // ⚠️ OPEN AND A DRAFT — NO LIFECYCLE AT ALL (MOTIR-4968), identical to
    // GitHub's arm and in the same position for the same reason: after the
    // merged and closed arms, so a CLOSED draft still resolves to `todo`.
    // "A draft is not implemented" is provider-agnostic by construction, which
    // is what this shared contract exists for.
    if (cr.draft) return null;
    // OPEN — the code exists and CI has not spoken for it (MOTIR-3005). NOT
    // `in_review`: that state is written by the CI-feedback consumer alone.
    return 'implemented';
  },

  parseCiStatusEvent(rawPayload: unknown): NormalizedStatusEvent | null {
    const payload = asRecord(rawPayload);
    if (!payload || payload['object_kind'] !== 'pipeline') return null;
    const attrs = asRecord(payload['object_attributes']);
    const project = asRecord(payload['project']);
    if (!attrs || !project) return null;

    const providerRepoId = idToString(project['id']);
    const commitSha = typeof attrs['sha'] === 'string' ? attrs['sha'] : null;
    const status = typeof attrs['status'] === 'string' ? attrs['status'] : null;
    if (!providerRepoId || !commitSha || !status) return null;

    // A pipeline hook carries the associated MR iid on `merge_request.iid` when it
    // ran for one; `object_attributes.ref` is the branch it ran on.
    const mrIid = asRecord(payload['merge_request'])?.['iid'];
    return {
      providerRepoId,
      commitSha,
      conclusion: mapPipelineStatus(status),
      context: 'pipeline',
      prNumbers: typeof mrIid === 'number' && Number.isInteger(mrIid) ? [mrIid] : [],
      headBranch: typeof attrs['ref'] === 'string' && attrs['ref'].length > 0 ? attrs['ref'] : null,
      // GitLab's answer to GitHub's check suite: the PIPELINE is the run, and a
      // retry at one sha is a new pipeline id (MOTIR-3209). Every job of one
      // pipeline reports under `context: 'pipeline'`, so a later pipeline at the
      // same commit shares that name and retires the one it replaced.
      suiteId: idToString(attrs['id']),
    };
  },

  /**
   * A `deployment` hook → the normalized preview record (Story MOTIR-4906 ·
   * MOTIR-5332), the same shape GitHub's `deployment_status` produces:
   * `sha` → `commitSha`, `ref` → `ref`, `environment` → `environment`,
   * `environment_external_url` → `environmentUrl`, `deployment_id` →
   * `providerDeploymentId`, `status_changed_at` → `occurredAt`, `project.id` → the
   * provider repo id, and `status` through {@link GITLAB_DEPLOYMENT_STATUS}.
   */
  parseDeploymentStatusEvent(rawPayload: unknown): NormalizedDeploymentStatus | null {
    const payload = asRecord(rawPayload);
    if (!payload || payload['object_kind'] !== 'deployment') return null;
    const providerRepoId = idToString(asRecord(payload['project'])?.['id']);
    const providerDeploymentId = idToString(payload['deployment_id']);
    const commitSha = typeof payload['sha'] === 'string' ? payload['sha'] : '';
    const ref = typeof payload['ref'] === 'string' ? payload['ref'] : '';
    const environment = typeof payload['environment'] === 'string' ? payload['environment'] : '';
    const rawStatus = typeof payload['status'] === 'string' ? payload['status'] : '';
    const state = Object.hasOwn(GITLAB_DEPLOYMENT_STATUS, rawStatus)
      ? GITLAB_DEPLOYMENT_STATUS[rawStatus]!
      : null;
    const occurredAt = parseGitlabTimestamp(payload['status_changed_at']);
    if (
      !providerRepoId ||
      !providerDeploymentId ||
      !commitSha ||
      !ref ||
      !environment ||
      !state ||
      !occurredAt
    ) {
      return null;
    }
    const url = payload['environment_external_url'];
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
    if (!payload || payload['object_kind'] !== 'push') return null;
    const providerRepoId = idToString(asRecord(payload['project'])?.['id']);
    if (!providerRepoId) return null;

    // Only a BRANCH push refreshes the graph. GitLab's `ref` is `refs/heads/<b>`
    // for a branch (a tag push is `object_kind: 'tag_push'`, already filtered);
    // a branch DELETION carries an all-zero `after` sha.
    const ref = typeof payload['ref'] === 'string' ? payload['ref'] : null;
    if (!ref || !ref.startsWith('refs/heads/')) return null;
    const branch = ref.slice('refs/heads/'.length);
    if (branch.length === 0) return null;

    const after = payload['after'];
    if (after === ZERO_SHA) return null; // branch deletion — nothing to index
    return {
      providerRepoId,
      branch,
      headSha: typeof after === 'string' && after.length > 0 ? after : null,
    };
  },
};

// Register the GitLab provider on import. `lib/git/index.ts` imports this module
// for exactly this side-effect, so any consumer that imports `@/lib/git` gets
// GitLab registered before it resolves a provider.

/**
 * A GitLab directory's immediate children (MOTIR-9868), paged up to
 * {@link REPO_DIRECTORY_MAX_ENTRIES}, or `null` when the path is not a
 * directory there. Every failure is `null` too: the caller then keeps the
 * files endpoint's own `not_found`, which is what it answered before this read
 * existed.
 */
async function listGitlabDirectory(
  token: string,
  project: string,
  dirPath: string,
  ref: string,
): Promise<{ entries: RepoDirectoryEntry[]; truncated: boolean } | null> {
  const entries: RepoDirectoryEntry[] = [];
  let hasNext = false;
  for (let page = 1; entries.length < REPO_DIRECTORY_MAX_ENTRIES; page += 1) {
    const url =
      `${gitlabBaseUrl()}/api/v4/projects/${project}/repository/tree` +
      `?path=${encodeURIComponent(dirPath)}&ref=${encodeURIComponent(ref)}` +
      `&per_page=100&page=${page}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REPO_FILE_READ_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, 'user-agent': 'motir' },
        signal: controller.signal,
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const body: unknown = await res.json().catch(() => null);
    if (!Array.isArray(body)) return null;
    for (const item of body) {
      const entry = gitlabTreeEntry(item);
      if (entry) entries.push(entry);
    }
    hasNext = Boolean(res.headers.get('x-next-page'));
    if (!hasNext) break;
  }
  if (entries.length === 0) return null;
  return {
    entries: sortEntries(entries.slice(0, REPO_DIRECTORY_MAX_ENTRIES)),
    truncated: hasNext || entries.length > REPO_DIRECTORY_MAX_ENTRIES,
  };
}

registerGitProvider(gitlabProvider);

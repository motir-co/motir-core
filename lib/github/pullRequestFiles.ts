// The response-throttling rule only — this leaf keeps its OWN tighter attempt /
// backoff budget below (it runs inside a post-commit side effect, not an operator
// sweep). `retryDelayMs` moved to the shared leaf when a third reader needed it
// (MOTIR-3034); the import target changed, the behaviour did not.
import {
  noteGithubRequest,
  observeGithubThrottle,
  retryDelayMs,
  type GithubCallSite,
  type GithubCallerContext,
} from '@/lib/github/restRetry';

// Pull-request FILES read leaf (MOTIR-2922) — walk one pull request's changed
// paths off `GET /repos/{owner}/{name}/pulls/{number}/files` with an installation
// token, bounded and truncation-REPORTING.
//
// Why this exists: the `github_pull_request` mirror records that a request
// existed, which branch it came from, which card it named and whether it merged
// — the set the status sync needs, and for the status sync exactly right. It has
// never recorded what the merge CHANGED, so every question about the WORK rather
// than the REQUEST (is this card's deliverable already on the trunk?) has had to
// be answered from the plan alone, which records intentions where a diff records
// outcomes. This leaf reads the outcome back from the host.
//
// Why a `lib/github/` leaf and NOT a new `GitProvider` method: the same reasoning
// `historicalPullRequests.ts` records at length, and it is worth repeating only in
// summary — the seam's contract is that a method every host genuinely backs is
// REQUIRED there, and GitLab backs merge-request diffs perfectly well, so an
// optional method would model a limitation GitLab does not have while a required
// one would mandate a GitLab implementation for a capture that has no GitLab
// caller. So this joins `codeScanning.ts`, `repoCollaborators.ts`,
// `historicalPullRequests.ts` — an authenticated REST read that a service composes.
//
// ⚠️ EVERY BOUND HERE REPORTS ITSELF. A file list is unbounded input from a remote
// host — a migration touching two thousand files must not put two thousand strings
// on a row — so the walk is capped twice (paths, pages). A capped result sets
// `truncated`, and the caller persists that flag, because a truncated set that
// reads as a complete one gives the consumer a confident WRONG answer, which is
// the exact failure the whole subsumption idea exists to prevent.

const GITHUB_API = 'https://api.github.com';

/** Per-request deadline. Short relative to `historicalPullRequests`' 30 s because
 *  this one runs inside a WEBHOOK delivery, where GitHub is holding a connection
 *  open and re-delivers on a timeout — a slow capture must give up long before it
 *  can turn into a redelivery storm. */
const GITHUB_TIMEOUT_MS = 10_000;

/** GitHub's maximum page size for this endpoint. */
const PER_PAGE = 100;

/** How many repo-relative paths one pull-request row stores. 300 covers every
 *  hand-written change and the great majority of generated ones; past it, the
 *  interesting fact about the merge is no longer "which files" but "a lot of
 *  them", and a consumer told the set is TRUNCATED behaves correctly either way.
 *  Exported because the truncation contract is only testable against the number. */
export const MAX_CAPTURED_PR_PATHS = 300;

/** Pages walked before the leaf reports truncation. Deliberately just past the
 *  path cap (3 × 100 = 300): walking further could only produce paths this
 *  capture is going to discard, and each page is a request against a rate limit
 *  the status sync's own retries share. */
export const MAX_PULL_REQUEST_FILE_PAGES = 3;

/** Attempts per page before the error propagates — the initial try plus retries
 *  for a rate-limited or transiently-failed response. */
const MAX_ATTEMPTS = 3;

/** Ceiling on ONE rate-limit sleep. Far below the sibling leaf's 60 s for the
 *  same reason the timeout is: this runs inside a delivery, not an operator CLI. */
const MAX_BACKOFF_MS = 5_000;

/** The floor between retries, doubled per attempt. */
const BASE_BACKOFF_MS = 500;

/** What one pull request's file list came to. `truncated` is true when EITHER cap
 *  cut the walk short — the two are one fact to the consumer ("this list is a
 *  prefix"), and splitting them would invite a caller to honour one and not the
 *  other. */
export interface PullRequestFiles {
  /** Repo-relative paths, host order, at most {@link MAX_CAPTURED_PR_PATHS}. */
  paths: string[];
  /** Whether `paths` is a PREFIX of the real file list rather than the whole. */
  truncated: boolean;
  /**
   * The same rows as `paths`, in the same order, with what the host says about
   * each at the pull request's HEAD (MOTIR-5674). `paths` is kept as it was
   * because the merge capture persists it verbatim; this is the richer view the
   * decision-document capture needs.
   */
  files: PullRequestFile[];
  /**
   * The head commit this list was read at, recovered from the `ref` the host puts
   * on each row's `contents_url`; null when no row carried one. Read off the
   * RESPONSE rather than a delivery, so it names the head the list actually
   * describes — a redelivered `synchronize` can carry an older head than the one
   * the endpoint answers for.
   */
  headSha: string | null;
}

/** One changed file as the files endpoint reports it. */
export interface PullRequestFile {
  path: string;
  /** The git BLOB sha of the file at the head; null when the host omitted it (a
   *  removed file has none worth naming). */
  sha: string | null;
  /** `added` · `modified` · `removed` · `renamed` · `copied` · `changed` ·
   *  `unchanged` — the host's own word, passed through; null when absent. */
  status: string | null;
}

/** Raised when a pull request's file list cannot be read — a revoked token, a
 *  deleted repo, a rate limit that outlasted the (short) retry budget. Carries the
 *  repo + number so the best-effort caller can log which capture it dropped. */
export class PullRequestFilesReadError extends Error {
  readonly code = 'PR_FILES_READ_FAILED' as const;
  constructor(
    readonly repoRef: string,
    readonly number: number,
    readonly status: number | null,
    detail: string,
  ) {
    super(`Could not read ${repoRef}#${number} files${status ? ` (${status})` : ''}: ${detail}`);
    this.name = 'PullRequestFilesReadError';
  }
}

/** Sleep, bounded by {@link MAX_BACKOFF_MS}. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(ms, MAX_BACKOFF_MS)));
}

/** The `filename` of one row off the files endpoint, or null when the row is not
 *  the shape the endpoint documents. A row that does not normalize is SKIPPED,
 *  never defaulted to a guess — the same rule the webhook parsers follow. */
function readFilename(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const name = (raw as Record<string, unknown>)['filename'];
  return typeof name === 'string' && name.length > 0 ? name : null;
}

/** A non-empty string field of a row, or null. */
function readString(raw: unknown, key: string): string | null {
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The `ref` query parameter of a row's `contents_url` — the head commit the row
 *  was reported at. Null when the URL is absent or carries no ref. */
function readContentsRef(raw: unknown): string | null {
  const url = readString(raw, 'contents_url');
  if (!url) return null;
  try {
    return new URL(url).searchParams.get('ref');
  } catch {
    return null;
  }
}

async function fetchPage(
  token: string,
  owner: string,
  name: string,
  number: number,
  page: number,
  site: GithubCallSite,
): Promise<unknown[]> {
  const repoRef = `${owner}/${name}`;
  const url =
    `${GITHUB_API}/repos/${owner}/${name}/pulls/${number}/files` +
    `?per_page=${PER_PAGE}&page=${page}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let res: Response;
    noteGithubRequest(site);
    try {
      res = await fetch(url, {
        headers: {
          // The INSTALLATION token, never the App JWT: the JWT authenticates the
          // App and cannot read a repository's contents at all, so a capture that
          // reached for it would 403 on every private repo and look like a
          // permissions problem in the installation.
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'motir',
        },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch (err) {
      // Network / timeout: retryable on the same budget as a 5xx.
      if (attempt === MAX_ATTEMPTS)
        throw new PullRequestFilesReadError(
          repoRef,
          number,
          null,
          err instanceof Error ? err.message : 'unreachable',
        );
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      continue;
    }

    if (res.ok) {
      const body: unknown = await res.json().catch(() => null);
      if (!Array.isArray(body))
        throw new PullRequestFilesReadError(repoRef, number, res.status, 'expected a JSON array');
      return body;
    }

    // The throttling rules are IDENTICAL to the sibling leaf's — same host, same
    // three signals — so this imports that decision rather than restating it; two
    // copies would drift on the next GitHub change and only one of them would be
    // fixed.
    observeGithubThrottle(site, res.status, res.headers, attempt);
    const delay = retryDelayMs(res.status, res.headers, attempt, Date.now());
    if (delay === null || attempt === MAX_ATTEMPTS)
      throw new PullRequestFilesReadError(
        repoRef,
        number,
        res.status,
        delay === null ? 'not retryable' : 'still throttled after the retry budget',
      );
    await sleep(delay);
  }

  // Unreachable: the loop either returns or throws on its last attempt.
  throw new PullRequestFilesReadError(repoRef, number, null, 'retry loop exhausted');
}

/**
 * Read one pull request's changed paths, capped at {@link MAX_CAPTURED_PR_PATHS}
 * and {@link MAX_PULL_REQUEST_FILE_PAGES} pages.
 *
 * Throws {@link PullRequestFilesReadError} when the host cannot be read at all.
 * The caller is best-effort and swallows that — the throw exists so a caller that
 * ever DOES depend on the paths can tell "no files" from "could not look".
 *
 * `truncated` errs on the side of TRUE at the exact boundary: a pull request with
 * precisely {@link MAX_CAPTURED_PR_PATHS} files whose last page came back full
 * exits by the page cap and is reported truncated, though nothing was in fact
 * dropped. That direction is the safe one — the flag's whole job is to stop a
 * consumer reading absence of a path as evidence, and a needless "there may be
 * more" costs one abstention where a wrong "that is all of them" costs a wrong
 * answer.
 */
export async function listPullRequestFiles(
  token: string,
  owner: string,
  name: string,
  number: number,
  context: GithubCallerContext,
): Promise<PullRequestFiles> {
  const site = { ...context, repository: `${owner}/${name}` };
  const paths: string[] = [];
  const files: PullRequestFile[] = [];
  let headSha: string | null = null;
  const result = (truncated: boolean): PullRequestFiles => ({ paths, truncated, files, headSha });

  for (let page = 1; page <= MAX_PULL_REQUEST_FILE_PAGES; page += 1) {
    const rows = await fetchPage(token, owner, name, number, page, site);
    for (const row of rows) {
      const filename = readFilename(row);
      if (!filename) continue;
      if (paths.length >= MAX_CAPTURED_PR_PATHS) return result(true);
      paths.push(filename);
      files.push({
        path: filename,
        sha: readString(row, 'sha'),
        status: readString(row, 'status'),
      });
      // A removed file is reported against the BASE, so only a surviving file's
      // ref names the head.
      if (headSha === null && readString(row, 'status') !== 'removed') {
        headSha = readContentsRef(row);
      }
    }
    // A short page is the last page — the walk saw the whole list.
    if (rows.length < PER_PAGE) return result(false);
  }

  // Every page was full and the page cap stopped the walk: there is more to read.
  return result(true);
}

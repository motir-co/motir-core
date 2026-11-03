import { CODE_HISTORY_MAX_COMMITS, CODE_HISTORY_MAX_RANGES } from '../provider';
import {
  capRanges,
  codeHistoryHostError,
  fetchWithinDeadline,
  hostCallFailure,
  hexShaOrNull,
  saysTooLarge,
  stringOrNull,
  subjectLine,
  type CodeHistoryAsked,
} from '../codeHistory';
import type { CodeBlameRange, CodeHistoryCommit, CodeHistoryResult } from '../types';

// GitHub's half of `GitProvider.readCodeHistory` (MOTIR-10237), kept beside
// `github.ts` rather than inside it: the provider mints the token (the one step
// that needs its private App wiring) and hands it here, so this module is two
// pure host reads over a bearer it never stores.
//
//   log   — REST `GET /repos/{owner}/{name}/commits?sha=<ref>&path=<path>`.
//   blame — GraphQL `Repository.object(expression: <ref>) { … on Commit { blame(path) } }`:
//           the REST API has no blame endpoint at all.
//
// ⚠️ METADATA ONLY: a commit's sha / author / date / subject and a blame range's
// line numbers. `files`, `patch`, `html_url`, `url` and every other URL the host
// sends are never read, so neither a hunk nor a URL can reach a result.

const GITHUB_API = 'https://api.github.com';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'motir',
  };
}

/** Whether a 403 is a PRIMARY or SECONDARY rate limit — the host busy, not the connection gone. */
function isRateLimited(res: Response, body: string): boolean {
  return res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(body);
}

/** One `commits[]` entry → a {@link CodeHistoryCommit}, or null when it has no sha. */
function githubCommit(value: unknown): CodeHistoryCommit | null {
  const entry = asRecord(value);
  const sha = hexShaOrNull(entry?.['sha']);
  if (!sha) return null;
  const commit = asRecord(entry?.['commit']);
  const author = asRecord(commit?.['author']);
  const committer = asRecord(commit?.['committer']);
  return {
    sha,
    author: stringOrNull(author?.['name']) ?? stringOrNull(asRecord(entry?.['author'])?.['login']),
    date: stringOrNull(author?.['date']) ?? stringOrNull(committer?.['date']),
    subject: subjectLine(commit?.['message']),
  };
}

/** The `Link` header carries a `rel="next"` — there is a further page of commits. */
function hasNextPage(res: Response): boolean {
  return /rel="next"/.test(res.headers.get('link') ?? '');
}

/**
 * What a commits-list 404 means. GitHub answers an unknown ref and a repository the
 * token cannot see with the same "Not Found" body, so the repository itself is asked:
 * a repository that is gone is `revoked`, as on the blame path, and one that answers
 * has no such ref.
 */
async function github404(
  token: string,
  owner: string,
  name: string,
  asked: CodeHistoryAsked,
): Promise<CodeHistoryResult> {
  const call = await fetchWithinDeadline(`${GITHUB_API}/repos/${owner}/${name}`, {
    method: 'GET',
    headers: githubHeaders(token),
  });
  if (!call.ok) return hostCallFailure(asked, call);
  if (call.res.status === 404) return { outcome: 'revoked', ...asked };
  if (call.res.ok) return { outcome: 'no_such_ref', ...asked };
  return codeHistoryHostError(asked, `GitHub repository returned ${call.res.status}`);
}

/**
 * The LOG of `path` reachable from `ref`, newest first — GitHub's own order. One
 * page of {@link CODE_HISTORY_MAX_COMMITS}; a further page is `truncated`.
 *
 * Status → outcome: 422 ("No commit found for SHA") and 409 (an empty repository) are
 * `no_such_ref`; a 404 is read by {@link github404}; 401, and a 403 that is not a rate limit, are
 * `revoked`; a refusal that says the walk was too big is `too_large`; everything
 * else is `host_error`. A 200 with NO commits is `path_not_found`: every path that
 * exists at a ref was put there by a commit reachable from it.
 */
export async function githubReadCodeLog(
  token: string,
  owner: string,
  name: string,
  asked: CodeHistoryAsked,
): Promise<CodeHistoryResult> {
  const url =
    `${GITHUB_API}/repos/${owner}/${name}/commits` +
    `?sha=${encodeURIComponent(asked.ref)}&path=${encodeURIComponent(asked.path)}` +
    `&per_page=${CODE_HISTORY_MAX_COMMITS}`;
  const call = await fetchWithinDeadline(url, { method: 'GET', headers: githubHeaders(token) });
  if (!call.ok) return hostCallFailure(asked, call);
  const { res } = call;

  if (res.status === 404) return github404(token, owner, name, asked);
  if (res.status === 409 || res.status === 422) return { outcome: 'no_such_ref', ...asked };
  if (res.status === 401) return { outcome: 'revoked', ...asked };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 403 && !isRateLimited(res, body)) return { outcome: 'revoked', ...asked };
    if (res.status !== 403 && saysTooLarge(body)) return { outcome: 'too_large', ...asked };
    return codeHistoryHostError(asked, `GitHub commits returned ${res.status}`);
  }

  const body: unknown = await res.json().catch(() => null);
  if (!Array.isArray(body)) {
    return codeHistoryHostError(asked, 'GitHub commits returned no commit list');
  }
  if (body.length === 0) return { outcome: 'path_not_found', ...asked };
  const commits = body
    .map(githubCommit)
    .filter((c): c is CodeHistoryCommit => c !== null)
    .slice(0, CODE_HISTORY_MAX_COMMITS);
  return {
    outcome: 'ok',
    ...asked,
    kind: 'log',
    commits,
    truncated: hasNextPage(res) || body.length > CODE_HISTORY_MAX_COMMITS,
  };
}

const BLAME_QUERY = `query CodeHistoryBlame($owner: String!, $name: String!, $expression: String!, $path: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $expression) {
      __typename
      ... on Commit { blame(path: $path) { ranges { ...BlameRange } } }
      ... on Tag { target { ... on Commit { blame(path: $path) { ranges { ...BlameRange } } } } }
    }
  }
}
fragment BlameRange on BlameRange {
  startingLine
  endingLine
  commit { oid authoredDate committedDate messageHeadline author { name } }
}`;

/** One GraphQL `BlameRange` → a {@link CodeBlameRange}, or null when it is incomplete. */
function githubBlameRange(value: unknown): CodeBlameRange | null {
  const range = asRecord(value);
  const start = range?.['startingLine'];
  const end = range?.['endingLine'];
  const commit = asRecord(range?.['commit']);
  const sha = hexShaOrNull(commit?.['oid']);
  if (typeof start !== 'number' || typeof end !== 'number' || !sha) return null;
  return {
    startLine: start,
    endLine: end,
    sha,
    author: stringOrNull(asRecord(commit?.['author'])?.['name']),
    date: stringOrNull(commit?.['authoredDate']) ?? stringOrNull(commit?.['committedDate']),
    subject: stringOrNull(commit?.['messageHeadline']),
  };
}

/** The GraphQL `errors[]` array, as records. */
function graphqlErrors(body: Record<string, unknown> | null): Record<string, unknown>[] {
  const errors = body?.['errors'];
  return Array.isArray(errors)
    ? errors.map(asRecord).filter((e): e is Record<string, unknown> => e !== null)
    : [];
}

/** Whether a GraphQL error is about the given field of the query's path. */
function errorAt(error: Record<string, unknown>, field: string): boolean {
  const path = error['path'];
  return Array.isArray(path) && path.includes(field);
}

/** The `blame` object under the resolved object — a commit's own, or a tag's target's. */
function blameOf(object: Record<string, unknown>): Record<string, unknown> | null {
  if (object['__typename'] === 'Tag') return asRecord(asRecord(object['target'])?.['blame']);
  return asRecord(object['blame']);
}

/** Whether the resolved object is a commit, or a tag pointing at one. */
function hasCommit(object: Record<string, unknown> | null): boolean {
  if (!object) return false;
  if (object['__typename'] === 'Commit') return true;
  // A tag's target answers `blame` only when it is a commit: the query asks no other type.
  const target = asRecord(object['target']);
  return object['__typename'] === 'Tag' && target !== null && 'blame' in target;
}

/**
 * The classification of a GraphQL answer that carries errors and no blame —
 * which of the named absences it is, or null when it is none of them. GitHub's
 * message quotes the path, so a size word is looked for only in what is left without
 * it: `lib/utils/timeout.ts` says nothing about a timeout.
 */
function blameErrorOutcome(
  errors: Record<string, unknown>[],
  path: string,
): 'path_not_found' | 'revoked' | 'too_large' | null {
  for (const error of errors) {
    const message = typeof error['message'] === 'string' ? error['message'] : '';
    if (error['type'] === 'NOT_FOUND' && errorAt(error, 'blame')) return 'path_not_found';
    if (/could not resolve file/i.test(message)) return 'path_not_found';
    if (saysTooLarge(message.split(path).join(''))) return 'too_large';
    if (error['type'] === 'NOT_FOUND' || error['type'] === 'FORBIDDEN') return 'revoked';
  }
  return null;
}

/**
 * The BLAME of `path` at `ref`, through GraphQL. The ranges come in line order;
 * past {@link CODE_HISTORY_MAX_RANGES} the answer is cut and `truncated`.
 *
 * Answer → outcome: a `repository` that does not resolve (NOT_FOUND) is `revoked` —
 * the repository is connected and in the project, so the token no longer sees it;
 * an `object` that does not resolve, or resolves to something with no commit
 * behind it, is `no_such_ref`; a blame the host could not resolve the path for is
 * `path_not_found`; a timeout is `too_large`; 401 and a non-rate-limit 403 are
 * `revoked`; anything else, an error none of these names included, is `host_error`.
 */
export async function githubReadCodeBlame(
  token: string,
  owner: string,
  name: string,
  asked: CodeHistoryAsked,
): Promise<CodeHistoryResult> {
  const call = await fetchWithinDeadline(`${GITHUB_API}/graphql`, {
    method: 'POST',
    headers: { ...githubHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({
      query: BLAME_QUERY,
      variables: { owner, name, expression: asked.ref, path: asked.path },
    }),
  });
  if (!call.ok) return hostCallFailure(asked, call);
  const { res } = call;

  if (res.status === 401) return { outcome: 'revoked', ...asked };
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 403 && !isRateLimited(res, text)) return { outcome: 'revoked', ...asked };
    if (res.status !== 403 && saysTooLarge(text)) return { outcome: 'too_large', ...asked };
    return codeHistoryHostError(asked, `GitHub GraphQL returned ${res.status}`);
  }

  const body = asRecord(await res.json().catch(() => null));
  if (!body) return codeHistoryHostError(asked, 'GitHub GraphQL returned no body');
  const repository = asRecord(asRecord(body['data'])?.['repository']);
  const object = repository ? asRecord(repository['object']) : null;
  const blame = object ? blameOf(object) : null;
  const ranges = blame?.['ranges'];

  if (!Array.isArray(ranges)) {
    const errors = graphqlErrors(body);
    const named = blameErrorOutcome(errors, asked.path);
    if (named === 'too_large' || named === 'path_not_found') return { outcome: named, ...asked };
    if (!repository) {
      return named === 'revoked'
        ? { outcome: 'revoked', ...asked }
        : codeHistoryHostError(asked, 'GitHub GraphQL returned no repository');
    }
    // An error nothing above names says the host failed, not that the ref or path is absent.
    if (errors.length > 0 && named === null) {
      return codeHistoryHostError(asked, 'GitHub GraphQL returned an unrecognised error');
    }
    // The repository resolved. A COMMIT that answered no blame has no such path;
    // no object, or an object with no commit behind it, is a ref that names
    // nothing blameable.
    return { outcome: hasCommit(object) ? 'path_not_found' : 'no_such_ref', ...asked };
  }

  const parsed = ranges.map(githubBlameRange).filter((r): r is CodeBlameRange => r !== null);
  return { outcome: 'ok', ...asked, kind: 'blame', ...capRanges(parsed, CODE_HISTORY_MAX_RANGES) };
}

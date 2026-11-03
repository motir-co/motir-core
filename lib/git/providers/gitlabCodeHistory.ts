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

// GitLab's half of `GitProvider.readCodeHistory` (MOTIR-10237) — `github
// CodeHistory.ts`'s twin. The provider reads the connection's token and hands it
// here; this module makes two REST reads:
//
//   log   — `GET /api/v4/projects/:id/repository/commits?ref_name=<ref>&path=<path>`.
//   blame — `GET /api/v4/projects/:id/repository/files/:file_path/blame?ref=<ref>`.
//
// ⚠️ METADATA ONLY. GitLab's blame groups carry each group's `lines[]` — the file's
// TEXT — and only their COUNT is read here, to number the range. `web_url` and every
// other URL are never read.

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** One commit record (a log entry, or a blame group's `commit`) → a {@link CodeHistoryCommit}. */
function gitlabCommit(value: unknown): CodeHistoryCommit | null {
  const commit = asRecord(value);
  const sha = hexShaOrNull(commit?.['id']);
  if (!sha) return null;
  return {
    sha,
    author: stringOrNull(commit?.['author_name']),
    date: stringOrNull(commit?.['authored_date']) ?? stringOrNull(commit?.['committed_date']),
    subject: subjectLine(commit?.['title'] ?? commit?.['message']),
  };
}

/** The 404 body's own word for what is missing: the project, the file, or the ref. */
function gitlab404(body: string): 'revoked' | 'path_not_found' | 'no_such_ref' {
  if (/project/i.test(body)) return 'revoked';
  if (/file/i.test(body)) return 'path_not_found';
  return 'no_such_ref';
}

/**
 * Map a non-2xx GitLab answer to its outcome. 404 reads its body ({@link gitlab404});
 * 401 / 403 are `revoked`; a refusal that says the work was too big is `too_large`;
 * everything else is `host_error`.
 */
async function gitlabRefusal(
  res: Response,
  asked: CodeHistoryAsked,
  what: string,
): Promise<CodeHistoryResult> {
  const body = await res.text().catch(() => '');
  if (res.status === 404) return { outcome: gitlab404(body), ...asked };
  if (res.status === 401 || res.status === 403) return { outcome: 'revoked', ...asked };
  if (saysTooLarge(body)) return { outcome: 'too_large', ...asked };
  return codeHistoryHostError(asked, `GitLab ${what} returned ${res.status}`);
}

function gitlabProjectUrl(baseUrl: string, owner: string, name: string): string {
  return `${baseUrl}/api/v4/projects/${encodeURIComponent(`${owner}/${name}`)}`;
}

/**
 * The LOG of `path` reachable from `ref`, newest first. One page of
 * {@link CODE_HISTORY_MAX_COMMITS}; a further page (`x-next-page`) is `truncated`.
 * A 200 with no commits is `path_not_found`, for the GitHub twin's reason.
 */
export async function gitlabReadCodeLog(
  baseUrl: string,
  token: string,
  owner: string,
  name: string,
  asked: CodeHistoryAsked,
): Promise<CodeHistoryResult> {
  const url =
    `${gitlabProjectUrl(baseUrl, owner, name)}/repository/commits` +
    `?ref_name=${encodeURIComponent(asked.ref)}&path=${encodeURIComponent(asked.path)}` +
    `&per_page=${CODE_HISTORY_MAX_COMMITS}`;
  const call = await fetchWithinDeadline(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'motir' },
  });
  if (!call.ok) return hostCallFailure(asked, call);
  const { res } = call;
  if (!res.ok) return gitlabRefusal(res, asked, 'commits');

  const body: unknown = await res.json().catch(() => null);
  if (!Array.isArray(body)) {
    return codeHistoryHostError(asked, 'GitLab commits returned no commit list');
  }
  if (body.length === 0) return { outcome: 'path_not_found', ...asked };
  const commits = body
    .map(gitlabCommit)
    .filter((c): c is CodeHistoryCommit => c !== null)
    .slice(0, CODE_HISTORY_MAX_COMMITS);
  const nextPage = (res.headers.get('x-next-page') ?? '').trim();
  return {
    outcome: 'ok',
    ...asked,
    kind: 'log',
    commits,
    truncated: nextPage.length > 0 || body.length > CODE_HISTORY_MAX_COMMITS,
  };
}

/**
 * Fold GitLab's blame groups — one per run of lines a commit last changed, in
 * file order, each carrying its `lines[]` — into numbered ranges. Only the
 * LENGTH of `lines` is read; a group with no lines advances nothing and is dropped.
 */
function foldBlameGroups(groups: unknown[]): CodeBlameRange[] {
  const ranges: CodeBlameRange[] = [];
  let next = 1;
  for (const group of groups) {
    const record = asRecord(group);
    const lines = record?.['lines'];
    const count = Array.isArray(lines) ? lines.length : 0;
    const commit = gitlabCommit(record?.['commit']);
    if (count > 0 && commit) {
      ranges.push({
        startLine: next,
        endLine: next + count - 1,
        sha: commit.sha,
        author: commit.author,
        date: commit.date,
        subject: commit.subject || null,
      });
    }
    next += count;
  }
  return ranges;
}

/**
 * The BLAME of `path` at `ref`. GitLab answers the whole file; past
 * {@link CODE_HISTORY_MAX_RANGES} ranges the answer is cut and `truncated`.
 */
export async function gitlabReadCodeBlame(
  baseUrl: string,
  token: string,
  owner: string,
  name: string,
  asked: CodeHistoryAsked,
): Promise<CodeHistoryResult> {
  const url =
    `${gitlabProjectUrl(baseUrl, owner, name)}/repository/files/` +
    `${encodeURIComponent(asked.path)}/blame?ref=${encodeURIComponent(asked.ref)}`;
  const call = await fetchWithinDeadline(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'motir' },
  });
  if (!call.ok) return hostCallFailure(asked, call);
  const { res } = call;
  if (!res.ok) return gitlabRefusal(res, asked, 'blame');

  const body: unknown = await res.json().catch(() => null);
  if (!Array.isArray(body)) {
    return codeHistoryHostError(asked, 'GitLab blame returned no blame list');
  }
  return {
    outcome: 'ok',
    ...asked,
    kind: 'blame',
    ...capRanges(foldBlameGroups(body), CODE_HISTORY_MAX_RANGES),
  };
}

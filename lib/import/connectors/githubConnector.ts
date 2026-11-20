// The GitHub Issues connector (Story 7.16 · MOTIR-1501). REST, token-auth,
// page-paginated — and the connector that ESTABLISHES the shared paginate +
// rate-limit/retry pattern (via `./http`) that the Jira / Linear (MOTIR-940) and
// Plane (MOTIR-1639) connectors reuse.
//
// Critical correctness point from the ADR (§1): GitHub's list-issues API
// defaults to `state=open`, which would SILENTLY DROP every closed issue — so
// this connector always passes `state=all` (the whole-history scope). Pull
// requests share the issues endpoint and are EXCLUDED (an item carrying a
// `pull_request` key is a PR, not an issue).
//
// GitHub does not expose user emails on the issues API, so `assignee/reporter`
// are carried by login NAME (email null) — the per-source-availability reality
// (ADR §2, assignee "by login"); the resolver's unmatched-user policy handles
// the rest. No DB, no Prisma — an external API read only.

import { githubRequestHooks } from '@/lib/github/githubFetch';
import { ConnectorConfigError } from './errors';
import {
  fetchWithRetry,
  parseLinkHeader,
  queryParam,
  trimTrailingSlashes,
  type RetryOptions,
} from './http';
import type {
  ConnectResult,
  IssueSourceConnector,
  SourceComment,
  SourceFieldVocabulary,
  SourceIssue,
  SourceIssueError,
  SourceIssuePage,
} from './types';

export interface GithubConnectorConfig {
  /** A token with `issues:read` — a per-user OAuth token (reuse
   *  `GithubIdentity.accessTokenEncrypted`) or a PAT (MOTIR-943). */
  token: string;
  owner: string;
  repo: string;
  /** API base — `https://api.github.com` (Cloud, default) or a GHES host. */
  baseUrl?: string;
  /** Fetch each issue's comments (default true). One extra request per issue
   *  that HAS comments — bounded, resilient (a comment-fetch failure is a
   *  per-issue error, not a page abort). */
  includeComments?: boolean;
  /** Issues per page (GitHub max 100, default 100). */
  perPage?: number;
  retry?: RetryOptions;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

interface GithubUser {
  login?: string;
}
interface GithubLabel {
  name?: string;
}
interface GithubIssue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  user?: GithubUser | null;
  assignee?: GithubUser | null;
  labels?: Array<GithubLabel | string>;
  comments?: number;
  comments_url?: string;
  created_at?: string | null;
  closed_at?: string | null;
  pull_request?: unknown;
}
interface GithubComment {
  body?: string | null;
  user?: GithubUser | null;
  created_at?: string | null;
}

const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_PER_PAGE = 100;

export class GithubConnector implements IssueSourceConnector {
  readonly source = 'github' as const;
  private readonly config: GithubConnectorConfig;
  private readonly baseUrl: string;
  private readonly perPage: number;
  private readonly includeComments: boolean;

  constructor(config: GithubConnectorConfig) {
    if (!config.token) throw new ConnectorConfigError('a GitHub token is required', 'github');
    if (!config.owner || !config.repo)
      throw new ConnectorConfigError('owner and repo are required', 'github');
    this.config = config;
    this.baseUrl = trimTrailingSlashes(config.baseUrl ?? DEFAULT_BASE_URL);
    this.perPage = Math.min(100, config.perPage ?? DEFAULT_PER_PAGE);
    this.includeComments = config.includeComments ?? true;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'motir-issue-import',
    };
  }

  private retryOpts(): RetryOptions {
    return {
      ...this.config.retry,
      source: 'github',
      fetchImpl: this.config.fetchImpl ?? this.config.retry?.fetchImpl,
      // Counted and throttle-reported like every GitHub call (MOTIR-11844).
      ...githubRequestHooks({
        caller: 'import.github',
        installationId: null,
        repository: this.repoRef(),
      }),
    };
  }

  private async get(url: string): Promise<Response> {
    return fetchWithRetry(url, { method: 'GET', headers: this.headers() }, this.retryOpts());
  }

  private repoRef(): string {
    return `${this.config.owner}/${this.config.repo}`;
  }

  async connect(): Promise<ConnectResult> {
    // Validate reachability + credentials against the repo endpoint. A 404/401/
    // 403 surfaces as a typed ConnectorError from fetchWithRetry.
    await this.get(`${this.baseUrl}/repos/${this.config.owner}/${this.config.repo}`);
    // A cheap all-states issue count is not available (the repo's
    // open_issues_count includes PRs and excludes closed), so report null.
    return { source: 'github', sourceRef: this.repoRef(), issueCount: null };
  }

  async discoverFields(): Promise<SourceFieldVocabulary> {
    const labels: string[] = [];
    let page = 1;
    for (;;) {
      const url = `${this.baseUrl}/repos/${this.config.owner}/${this.config.repo}/labels?per_page=100&page=${page}`;
      const res = await this.get(url);
      const batch = (await res.json()) as GithubLabel[];
      for (const l of batch) if (l.name) labels.push(l.name);
      const next = parseLinkHeader(res.headers.get('link')).next;
      if (!next || batch.length === 0) break;
      page += 1;
    }
    return {
      types: [], // GitHub has no native issue type — kind is label-derived (resolver)
      statuses: ['open', 'closed'],
      priorities: [], // label-derived
      labels: labels.sort(),
    };
  }

  async listIssues(cursor?: string | null): Promise<SourceIssuePage> {
    const page = cursor ? Math.max(1, Number.parseInt(cursor, 10) || 1) : 1;
    const url =
      `${this.baseUrl}/repos/${this.config.owner}/${this.config.repo}/issues` +
      `?state=all&per_page=${this.perPage}&page=${page}&sort=created&direction=asc`;
    const res = await this.get(url);
    const batch = (await res.json()) as GithubIssue[];
    const errors: SourceIssueError[] = [];
    const issues: SourceIssue[] = [];

    for (const raw of batch) {
      // Exclude PRs — they ride the same endpoint but carry `pull_request`.
      if (raw.pull_request) continue;
      const externalId = `${this.repoRef()}#${raw.number}`;
      let comments: SourceComment[] = [];
      if (this.includeComments && (raw.comments ?? 0) > 0) {
        try {
          comments = await this.fetchComments(raw);
        } catch (err) {
          errors.push({ externalId, message: `comments unavailable: ${String(err)}` });
        }
      }
      issues.push(this.mapIssue(raw, externalId, comments));
    }

    // Page forward via the Link header's rel="next" (its `page` param); absent →
    // last page.
    const next = parseLinkHeader(res.headers.get('link')).next;
    const nextCursor = next ? queryParam(next, 'page') : null;
    return { issues, errors, nextCursor };
  }

  private async fetchComments(issue: GithubIssue): Promise<SourceComment[]> {
    const out: SourceComment[] = [];
    let page = 1;
    const base =
      issue.comments_url ??
      `${this.baseUrl}/repos/${this.config.owner}/${this.config.repo}/issues/${issue.number}/comments`;
    for (;;) {
      const sep = base.includes('?') ? '&' : '?';
      const res = await this.get(`${base}${sep}per_page=100&page=${page}`);
      const batch = (await res.json()) as GithubComment[];
      for (const c of batch) {
        out.push({
          authorEmail: null,
          authorName: c.user?.login ?? null,
          body: c.body ?? '',
          createdAt: c.created_at ?? null,
        });
      }
      const next = parseLinkHeader(res.headers.get('link')).next;
      if (!next || batch.length === 0) break;
      page += 1;
    }
    return out;
  }

  private mapIssue(raw: GithubIssue, externalId: string, comments: SourceComment[]): SourceIssue {
    const labels = (raw.labels ?? [])
      .map((l) => (typeof l === 'string' ? l : l.name))
      .filter((n): n is string => Boolean(n));
    return {
      externalId,
      title: raw.title,
      descriptionMd: raw.body ?? null,
      type: null, // label-derived — the resolver decides the Motir kind
      status: raw.state, // 'open' | 'closed' → resolver maps to a workflow_status
      priority: null, // label-derived
      assigneeEmail: null,
      assigneeName: raw.assignee?.login ?? null,
      reporterEmail: null,
      reporterName: raw.user?.login ?? null,
      labels,
      comments,
      attachments: [], // GitHub inlines attachments in the body — none listed
      parentExternalId: null, // no native parent (task-lists ⚠️ — not in this slice)
      links: [],
      createdAt: raw.created_at ?? null,
      closedAt: raw.closed_at ?? null,
    };
  }
}

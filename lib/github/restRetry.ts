import { countGithubRequest } from '@/lib/monitoring/githubRequestMetrics';

// Shared GitHub REST throttling policy for the read leaves (MOTIR-3034).
//
// Extracted from `historicalPullRequests.ts`, which owned it alone until a
// second leaf needed it (`pullRequestBase.ts`). Kept as ONE module rather than
// copied, for the same reason `lib/workItems/repoDelivery.ts` is one module: two
// throttling rules against the same host, on the same installation token and the
// same rate limit, would drift into two different ideas of when GitHub is asking
// us to wait — and the one that drifts LOW is the one that gets the installation
// secondary-limited for every other caller.

/** Attempts per request before the error propagates — the initial try plus
 *  retries for a rate-limited or transiently-failed response. */
export const MAX_ATTEMPTS = 5;

/** Ceiling on ONE rate-limit sleep. GitHub's primary-limit reset can be up to an
 *  hour away; waiting that long inside a single request would look like a hang.
 *  Capped, then retried — with the attempt budget above, a genuinely exhausted
 *  primary limit ends the run with a clear error and the operator re-runs later
 *  (every caller of this policy is idempotent, so a re-run resumes). */
export const MAX_BACKOFF_MS = 60_000;

/** The floor between retries, doubled per attempt. */
export const BASE_BACKOFF_MS = 1_000;

/** Sleep, bounded by {@link MAX_BACKOFF_MS}. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(ms, MAX_BACKOFF_MS)));
}

/** The plain exponential backoff for attempt `n` (1-based). */
export function backoffMs(attempt: number): number {
  return BASE_BACKOFF_MS * 2 ** (attempt - 1);
}

/** Any response's headers — a `Headers`, or a stub with the one method read. */
export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * The throttling signal a 403/429 carries, or null when it carries none.
 *
 * GitHub signals throttling three ways and this checks all three, because they
 * do not co-occur: a SECONDARY limit sends `retry-after` (seconds) on a 403; a
 * PRIMARY limit sends `x-ratelimit-remaining: 0` plus `x-ratelimit-reset` (unix
 * seconds) on a 403 or 429; and a bare 429 may carry neither. A 403 with no
 * signal is an ACCESS failure (the installation lost the repo), not a rate limit.
 *
 * ⚠️ ONE READING FOR BOTH CONSUMERS (MOTIR-11842). {@link retryDelayMs} decides
 * the wait from it and {@link classifyGithubThrottle} names the limit from it, so
 * "what the retry loop treated as a throttle" and "what the log line reports as
 * one" cannot drift apart.
 */
type ThrottleSignal =
  | { readonly kind: 'retry_after'; readonly ms: number }
  | { readonly kind: 'reset'; readonly resetMs: number }
  | { readonly kind: 'bare_429' };

function readThrottleSignal(status: number, headers: HeaderReader): ThrottleSignal | null {
  if (status !== 403 && status !== 429) return null;

  const retryAfter = Number(headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0)
    return { kind: 'retry_after', ms: retryAfter * 1_000 };

  const remaining = Number(headers.get('x-ratelimit-remaining'));
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (remaining === 0 && Number.isFinite(reset) && reset > 0)
    return { kind: 'reset', resetMs: reset * 1_000 };

  return status === 429 ? { kind: 'bare_429' } : null;
}

/**
 * WHICH throttle a response is, when it is one (Bug MOTIR-11841), with the wait
 * the host NAMED — or null for a response GitHub did not throttle. Read from the
 * same {@link readThrottleSignal} the retry loop uses, so the merge path and the
 * retry loop cannot disagree on what a throttle is.
 *
 * `waitMs` is the retry-after, or the time left until the reset (never negative),
 * and null for a bare 429, which names none.
 *
 * ⚠️ A 403 WITH NO THROTTLING SIGNAL IS NOT HERE. It is an ACCESS failure, and the
 * merge path reports it as one; reading it as a throttle would tell a person to
 * wait for a setting nobody changes.
 */
export type GithubThrottle =
  | { signal: 'retry_after' | 'rate_limit_reset'; waitMs: number }
  | { signal: 'too_many_requests'; waitMs: null };

export function githubThrottle(
  status: number,
  headers: HeaderReader,
  nowMs: number,
): GithubThrottle | null {
  const signal = readThrottleSignal(status, headers);
  if (!signal) return null;
  if (signal.kind === 'retry_after') return { signal: 'retry_after', waitMs: signal.ms };
  if (signal.kind === 'reset') {
    return { signal: 'rate_limit_reset', waitMs: Math.max(signal.resetMs - nowMs, 0) };
  }
  return { signal: 'too_many_requests', waitMs: null };
}

/**
 * How long to wait before retrying a response, or null when the response is not
 * retryable.
 *
 * A throttled 403/429 waits as its signal says ({@link readThrottleSignal}); a 5xx
 * is retried on plain exponential backoff. Anything else — 401, 404, 422, a 403
 * with no throttling signal — is a real failure the caller must see, so it
 * returns null.
 */
export function retryDelayMs(
  status: number,
  headers: HeaderReader,
  attempt: number,
  nowMs: number,
): number | null {
  const backoff = backoffMs(attempt);
  const signal = readThrottleSignal(status, headers);
  if (signal?.kind === 'retry_after') return signal.ms;
  // `reset` is unix SECONDS. A reset already in the past still gets the backoff
  // floor rather than 0, so a clock skew cannot spin the retry loop.
  if (signal?.kind === 'reset') return Math.max(signal.resetMs - nowMs, backoff);
  if (signal?.kind === 'bare_429') return backoff;

  if (status >= 500) return backoff;
  return null;
}

// ── WHO TRIPPED IT (MOTIR-11842) ─────────────────────────────────────────────
//
// On 2026-11-19 GitHub secondary-limited the motir-co installation for ~40
// minutes, and nothing Motir kept could say which limit it was or which part of
// Motir made the burst: the retry loop read `retry-after` / `x-ratelimit-*` to
// pick its wait and threw them away, and the merge path read none of them. So
// every GitHub call site this module serves names ITSELF (a {@link GithubCallSite})
// and:
//   - counts each request it sends (`countGithubRequest`, one EMF series per
//     caller per minute — `lib/monitoring/githubRequestMetrics.ts`), which answers
//     who spent the minutes BEFORE a throttle; and
//   - reports each throttled answer as ONE structured log line
//     ({@link observeGithubThrottle}), which answers which limit it was.

/**
 * Every caller that names itself on a GitHub request. A CLOSED set, because each
 * is a CloudWatch dimension value: an open string would let a typo or an
 * interpolated id mint a new metric series per call.
 */
export const GITHUB_CALLERS = [
  /** The pull-request reconcile sweep's `readPullRequest`. */
  'pullRequestReconcile',
  /** The base-branch backfill's `readPullRequestBaseRef`. */
  'pullRequestBaseRefBackfill',
  /** The historical merged-pull-request backfill's page walk. */
  'historicalPullRequestBackfill',
  /** The one-time open-pull-request report's page walk (MOTIR-12057). */
  'openPullRequestReport',
  /** The pull-request head index's live read of the pull request (MOTIR-12257). */
  'codeGraphPrHeadIndex',
  /** A held open code-graph forward's live read of its pull request (MOTIR-12321). */
  'codeGraphForward',
  /** The `pull_request` webhook's changed-path capture. */
  'webhook.changedPaths',
  /** The decision-document capture's changed-path read. */
  'decisionDocumentCapture',
  /** `GitProvider.mergeChangeRequest` — the reads and the merge itself. */
  'mergeChangeRequest',
  /** The merge-queue enqueue (and its already-queued read-back). */
  'mergeQueueEnqueue',
  /** `GitProvider.readChangeRequestMergeability`. */
  'readChangeRequestMergeability',
  /** `GitProvider.readReleaseContainsMerge`. */
  'readReleaseContainsMerge',

  // ── Every other GitHub call site (MOTIR-11844), one per module or operation.
  //    Each sends through `githubFetch` (`lib/github/githubFetch.ts`).

  /** The rest of `GitProvider` (`lib/git/providers/github.ts`), by method. */
  'provider.reviewWrite',
  'provider.fetchInstallationRepos',
  'provider.resolveRepoTarballUrl',
  'provider.compareCommits',
  'provider.listChangedFiles',
  'provider.readFileAtRef',
  'provider.resolveRef',
  'provider.fetchInstallation',
  'provider.getRepositoryPermission',
  'provider.fetchWorkflowRunJobs',
  'provider.fetchOrgComputeUsage',
  /** The code-history reads (`githubCodeHistory.ts`): the commit log, blame. */
  'codeHistory.log',
  'codeHistory.blame',
  /** The App itself (its JWT): installation tokens, its bot logins, uninstall. */
  'app.installationToken',
  'app.botLogins',
  'app.uninstall',
  /** As the signed-in user: their installations and organisations. */
  'user.installations',
  'user.orgs',
  /** The GitHub sign-in (`githubIdentityService`): token grant and the user read. */
  'identity.oauthToken',
  'identity.user',
  /** Check runs: writing Motir's own, the head-SHA read, reading a commit's. */
  'checkRuns.write',
  'checkRuns.pullRequestHead',
  'checkRuns.read',
  /** One module each, named for it. */
  'actionsPermissions',
  'actionsRuns',
  'actionsVariables',
  'codeScanning',
  'codeScanningDefaultSetup',
  'enterpriseOrganizations',
  'fleetQueue',
  'orgInstallation',
  'previewDeployments',
  'publishWorkflows',
  'rateLimit',
  'repoActionsConfig',
  'repoCollaborators',
  'repoCommitHistory',
  'repoDeletion',
  'repoDeployments',
  'repoProvisioning',
  'repoTransfer',
  'repoVisibility',
  'repositoryActionsConfig',
  'repositoryOwnerId',
  'runGitCredential',
  'runGitCredential.revoke',
  'runnerGroups',
  'runnerJitConfig',
  'runnerVersionSources',
  'seedPromotion',
  /** The GitHub Issues import connector (a user-supplied token, Cloud or GHES). */
  'import.github',
] as const;

export type GithubCaller = (typeof GITHUB_CALLERS)[number];

/** Which GitHub limit a throttled answer was. */
export type GithubThrottleClass = 'primary' | 'secondary';

/** Who is calling GitHub, for which installation and repository. */
export interface GithubCallSite {
  readonly caller: GithubCaller;
  /** The HOST's numeric installation id, as Motir stores it — `null` for a call
   *  made as the App itself (its JWT), as a user (OAuth), or with a token whose
   *  installation the call site does not know (MOTIR-11844). */
  readonly installationId: string | null;
  /** `owner/name` — `null` for a call that is not about one repository (an org,
   *  an installation, the App, the user). */
  readonly repository: string | null;
}

/** What a read leaf's CALLER supplies; the leaf adds the repository it reads. */
export type GithubCallerContext = Omit<GithubCallSite, 'repository'>;

/** Count one request `site` is about to send (`githubRequestMetrics`). */
export function noteGithubRequest(site: GithubCallSite): void {
  countGithubRequest(site.caller);
}

/**
 * The rate-limit headers a throttle line carries — an ALLOWLIST, never a copy of
 * the response's headers, so no credential can ride along (`authorization` is a
 * REQUEST header, but an allowlist does not depend on knowing that).
 * `x-github-request-id` is what GitHub Support asks for about one answer.
 */
export const GITHUB_THROTTLE_HEADERS = [
  'retry-after',
  'x-ratelimit-resource',
  'x-ratelimit-limit',
  'x-ratelimit-used',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-github-request-id',
] as const;

/** The one structured line a throttled answer writes. */
export interface GithubThrottleObservation {
  readonly event: 'github.throttle';
  readonly caller: GithubCaller;
  readonly installationId: string | null;
  readonly repository: string | null;
  readonly status: number;
  readonly classification: GithubThrottleClass;
  /** Which try of the request this answer was (1-based), when the call retries. */
  readonly attempt: number | null;
  /** Only the {@link GITHUB_THROTTLE_HEADERS} the answer carried. */
  readonly headers: Readonly<Partial<Record<(typeof GITHUB_THROTTLE_HEADERS)[number], string>>>;
}

/**
 * Which limit a 403/429 hit, or null when it is not a throttle — exactly when
 * {@link retryDelayMs} would not retry it as one.
 *
 * `x-ratelimit-remaining: 0` is the PRIMARY budget spent, whatever else came
 * with it. Otherwise it is a SECONDARY limit: GitHub's documentation sends
 * `retry-after` for those, and says an answer with no header at all is to be
 * treated as one too (wait at least a minute), which is the bare 429.
 */
export function classifyGithubThrottle(
  status: number,
  headers: HeaderReader,
): GithubThrottleClass | null {
  if (readThrottleSignal(status, headers) === null) return null;
  return headers.get('x-ratelimit-remaining')?.trim() === '0' ? 'primary' : 'secondary';
}

/**
 * Report a GitHub answer that throttled `site`, as ONE structured log line (JSON,
 * so CloudWatch Logs Insights reads its fields), and return what it wrote. An
 * answer that is not a throttle writes nothing and returns null, so a caller may
 * pass every non-2xx answer through it.
 */
export function observeGithubThrottle(
  site: GithubCallSite,
  status: number,
  headers: HeaderReader,
  attempt: number | null = null,
): GithubThrottleObservation | null {
  const classification = classifyGithubThrottle(status, headers);
  if (classification === null) return null;

  const present: Partial<Record<(typeof GITHUB_THROTTLE_HEADERS)[number], string>> = {};
  for (const name of GITHUB_THROTTLE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) present[name] = value;
  }
  const observation: GithubThrottleObservation = {
    event: 'github.throttle',
    caller: site.caller,
    installationId: site.installationId,
    repository: site.repository,
    status,
    classification,
    attempt,
    headers: present,
  };
  console.warn(JSON.stringify(observation));
  return observation;
}

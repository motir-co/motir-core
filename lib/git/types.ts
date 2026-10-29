// Provider-agnostic normalized shapes for the Git integration seam (Story 7.10 ·
// MOTIR-891). Every downstream reader — the status sync (MOTIR-892), the
// code-graph feed (MOTIR-893), the CI feedback loop (MOTIR-894) — consumes THESE
// shapes through the `GitProvider` interface, never a GitHub-specific type, so
// adding GitLab/Bitbucket (7.23) is purely additive: implement the interface and
// normalize the host's payloads into these.

/** The registered provider ids — the `provider` discriminator carried by the
 *  stored `Github*` rows. A GitLab impl (7.23) registers under `'gitlab'`. */
export type GitProviderId = 'github' | 'gitlab';

/** A repository, normalized across providers. `providerRepoId` is the host's own
 *  stable numeric id (as a string — never do math on it). */
export interface NormalizedRepo {
  providerRepoId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  /**
   * Whether the repository is ARCHIVED on the host — read-only, rejecting a push
   * or a pull request from anyone, admin included (MOTIR-1959).
   *
   * A LIVENESS fact, deliberately distinct from every permission the seam already
   * carries: a collaborator's `push` right says whether a PERSON may write, and
   * this says whether the REPOSITORY still accepts writes at all. Both providers
   * report it (GitHub's `archived` boolean, GitLab's `archived` boolean), so it
   * normalizes with no per-provider special case. Absent from a payload reads as
   * `false` — "not known to be archived", the state every mirror row was in
   * before this field existed.
   */
  archived: boolean;
}

/** An App installation's account, normalized across providers — the identity the
 *  installation belongs to (a GitHub org/user, a GitLab group). Fetched by
 *  `GitProvider.fetchInstallation` when binding a fresh install to a workspace
 *  (MOTIR-1588), where only the host installation id is known. */
export interface NormalizedInstallation {
  installationId: string;
  accountLogin: string;
  accountType: string;
}

/** A branch, normalized across providers. */
export interface NormalizedBranch {
  name: string;
  commitSha: string;
}

/** A change request's lifecycle state — a PR (GitHub) or MR (GitLab). `merged`
 *  is ORTHOGONAL: a closed-merged and a closed-unmerged change request are both
 *  `state: 'closed'`, distinguished by the `merged` flag. */
export type ChangeRequestState = 'open' | 'closed';

/** A change request (pull / merge request), normalized across providers. Carries
 *  no Motir-side link, and the consumer does not derive one from this payload:
 *  `resolveChangeRequestWorkItemSet` reads either the SESSION BRANCH `headRef`
 *  names (`work_item.session_branch`, written by `mark_integrated`) or the STORED
 *  deliveries the pull request carries (`work_item_delivery`, written by
 *  `link_pull_request`). Both are declared. The head-ref / title PARSE that used
 *  to sit behind this sentence was deleted by MOTIR-3674. */
export interface NormalizedChangeRequest {
  providerRepoId: string;
  number: number;
  state: ChangeRequestState;
  merged: boolean;
  headRef: string;
  /**
   * The branch the change request merges INTO — GitHub's `base.ref`, GitLab's
   * `target_branch` (MOTIR-1873).
   *
   * ⚠️ LOAD-BEARING for completion, and the reason `merged` alone never is:
   * `merged: true` answers "did a merge event occur?", not "did this work reach
   * the trunk?". They diverge whenever the base is not the repository's default
   * branch — a STACKED change request whose base gets merged first is the
   * ordinary way that happens, and the merge then lands on a dead branch with no
   * path to the trunk while the host still reports MERGED. So the completion
   * decision reads this field against the mirrored default branch; only the
   * trunk witnesses a shipped deliverable.
   *
   * Required, exactly like `headRef`: a change request has a destination as
   * surely as it has a source, and a payload carrying neither does not
   * normalize (the parser returns null) rather than defaulting to a guess.
   */
  baseRef: string;
  title: string | null;
  /**
   * Whether the change request is a DRAFT — explicitly not offered for review
   * (MOTIR-4968). GitHub's `pull_request.draft`, GitLab's `draft` /
   * `work_in_progress` on the MR's `object_attributes`.
   *
   * ⚠️ ORTHOGONAL to `state`, exactly as `merged` is, and that is the whole
   * reason this field has to exist: the host reports a draft as `state: 'open'`,
   * so before this field the seam could not tell "open and awaiting review" from
   * "open and explicitly NOT". `changeRequestLifecycle` reads it to answer
   * neither — see its own note.
   *
   * REQUIRED rather than optional-with-a-default, decided on MOTIR-4968: an
   * optional field lets one provider's normalizer omit it, the type checker
   * stays quiet, and every draft on THAT host silently resolves to
   * `implemented` while nothing anywhere goes red. Required turns the omission
   * into a compile error at the one moment somebody is looking — the same
   * argument this repository already makes for a required `tx` on a repository
   * write.
   *
   * ⚠️ NOT PERSISTED, and deliberately so. `github_pull_request` models
   * draft-ness nowhere, so a draft is an OPEN linked pull request to every
   * reader — the `deferred_open_pr` defer included, which is what holds a
   * multi-repository parent open while one repository's chain is still stopped.
   * This field decides ONE thing (the lifecycle a delivery carries) and is not
   * a fact the rest of the product reasons over.
   */
  draft: boolean;
  /**
   * The commit the change request's source branch is AT — GitHub's `head.sha`,
   * GitLab's `last_commit.id` (MOTIR-7005). Persisted as `GithubPullRequest.headSha`
   * and read by `lib/github/pullRequestHead.ts`, so "the current head" is the host's
   * word and never the newest check run's commit: a push that produces no CI (every
   * push to a conflicting pull request) leaves the check rows at the OLD commit.
   *
   * REQUIRED, for `draft`'s reason; `null` when the payload names none.
   */
  headSha: string | null;
}

/** The canonical, provider-agnostic lifecycle signal a change request maps to —
 *  consumed by the status sync (MOTIR-892) to drive the linked work item's
 *  `workflow_status`. Opened → IMPLEMENTED; merged → done; closed-unmerged →
 *  back to todo (the work did NOT complete). The concrete project workflow
 *  status is the consumer's concern; the provider only emits this canonical
 *  signal.
 *
 *  ⚠️ `opened` emitted `in_review` until MOTIR-3005, and the change is about who
 *  is allowed to claim a build is reviewable. An open pull request means the code
 *  exists and CI has not spoken for it — which is exactly `implemented`. In
 *  Review is now written by ONE writer, the CI-feedback consumer, when the checks
 *  go green (MOTIR-3006); a webhook that set it on `opened` would assert a green
 *  run that has not happened, and would also drag back the card the agent just
 *  reported as implemented (the two writers must name the same state).
 *
 *  ⚠️ THIS UNION IS EXACTLY THE SET OF SIGNALS THAT HAVE A TARGET STATUS, and it
 *  is kept that way on purpose (MOTIR-4968). A delivery that carries NO lifecycle
 *  change — an OPEN DRAFT — is expressed as `null` in the SEAM'S RETURN TYPE
 *  (`GitProvider.changeRequestLifecycle` returns `ChangeRequestLifecycle | null`),
 *  never as a fourth member here, so `LIFECYCLE_TARGET` in the consumer stays a
 *  TOTAL `Record` over this union and cannot acquire an arm with no status to
 *  resolve. */
export type ChangeRequestLifecycle = 'implemented' | 'done' | 'todo';

/** A CI / pipeline conclusion, normalized across providers. */
export type CiConclusion = 'success' | 'failure' | 'pending' | 'neutral';

/** A CI / pipeline status event, normalized across providers — consumed by the
 *  CI feedback loop (MOTIR-894). `prNumbers` are the host PR/MR numbers the event
 *  is associated with (the check payload's `pull_requests[].number`) — the
 *  STRONGEST link back to the stored change request; `headBranch` is the branch
 *  the checks ran on, the fallback resolver when the payload carries no PR list
 *  (both are stable across a re-push, unlike a head SHA). A provider that reports
 *  the change request's own ref where the branch belongs (GitHub's
 *  `refs/pull/<n>/head`) puts `<n>` in `prNumbers` and leaves `headBranch` null,
 *  so `headBranch` is always a real branch name (MOTIR-5918). `commitSha` is the head
 *  commit the checks ran on, part of the idempotency key. `context` names the
 *  check (a `check_run.name`, a `check_suite` app slug, a commit-status context). */
export interface NormalizedStatusEvent {
  providerRepoId: string;
  commitSha: string;
  conclusion: CiConclusion;
  context: string;
  prNumbers: number[];
  headBranch: string | null;
  /** The CI RUN this check belongs to — GitHub's `check_suite.id` (GitHub
   *  creates ONE check suite per workflow run, which is why `ci.yml` and
   *  `codeql.yml` sit in different suites at one commit), GitLab's pipeline id.
   *  Part of the ingestion key since MOTIR-3209: two runs at one commit is
   *  ordinary under `cancel-in-progress`, and a key that cannot tell them apart
   *  merges them by check NAME — which is how a cancelled run's phantom rows
   *  outlived the run that replaced it. `null` where the provider reports no
   *  run identity at all (a legacy commit-`status` event). */
  suiteId: string | null;
  /** TRUE when the event is a suite's OWN roll-up rather than a check — a GitHub
   *  `check_suite` event, whose `context` is the App slug and therefore identical
   *  for every workflow of that App (MOTIR-6274). Stored on the row so the
   *  supersession rule can leave it out of its shared-name test. Absent = a check. */
  suiteAggregate?: boolean;
}

/** A push to a repository branch, normalized across providers — consumed by the
 *  code-graph feed (MOTIR-893) to refresh a connected repo's graph when its
 *  default branch moves. `branch` is the SHORT branch name (a tag / non-branch
 *  push does not normalize — the parser returns null for it); `headSha` is the
 *  post-push head commit when the payload carries one. */
export interface NormalizedPushEvent {
  providerRepoId: string;
  branch: string;
  headSha: string | null;
}

// ── A REVIEW on a change request (Story MOTIR-4910 · MOTIR-5595) ─────────────
//
// `docs/decisions/approval-gates.md` §8 FOURTH AMENDMENT (MOTIR-5590), decision 2.
// Every other webhook event reaches `githubWebhookService` through the provider
// seam rather than by reading the host's payload directly, and a review does too,
// so the GitLab story supplies the same shape rather than a second vocabulary.

/** A review's state, normalized. The four GitHub reports, and the same four a
 *  merge-request approval maps onto. `commented` is carried even though it never
 *  decides anything: the Development block draws reviews that do not count. */
export type NormalizedReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed';

/** What happened to the review itself — NOT what it says. `edited` is a body edit
 *  and changes no verdict; it is normalized so a consumer can decide to ignore it
 *  explicitly rather than by failing to parse it. */
export type NormalizedReviewAction = 'submitted' | 'dismissed' | 'edited';

/** WHO reviewed, in the host's own terms. `providerUserId` is the stable identity
 *  the actor resolution joins on; `login` is what a surface shows. */
export interface NormalizedReviewer {
  providerUserId: string;
  login: string;
  /** `User` or `Bot` on GitHub, as given. Not an enum: it is the host's vocabulary
   *  and it grows. */
  type: string;
}

/** ONE review, normalized off a `pull_request_review` delivery. */
export interface NormalizedReviewEvent {
  action: NormalizedReviewAction;
  installationId: string;
  repo: { owner: string; name: string; providerRepoId: string };
  /** The pull request as the DELIVERY reports it. `headSha` is the pull request's
   *  CURRENT head, which is not necessarily the commit the review was given at —
   *  `review.commitSha` is that, and the two differing is exactly the stale-review
   *  case (decision 2). */
  pullRequest: { number: number; headSha: string | null };
  review: {
    /** The host's own review id — the idempotency key a consumer stores. */
    id: string;
    state: NormalizedReviewState;
    /** `review.commit_id` — the head the review was given AT. */
    commitSha: string;
    submittedAt: Date;
    htmlUrl: string | null;
    /** `review.body` — what the reviewer wrote, trimmed; null when there is none. A
     *  `changes_requested` review that decides a gate hands it over as the gate's
     *  reason (ADR `approval-gates.md` §10b, MOTIR-6074). */
    body: string | null;
    reviewer: NormalizedReviewer;
  };
}

/** A reviewer's permission ON a repository, normalized (decision 2). GitHub's own
 *  vocabulary, which GitLab's access levels map onto.
 *
 *  ⚠️ `unknown` MEANS IT COULD NOT BE READ and is NOT a synonym for `none`. A
 *  review whose permission is unknown counts for nothing — the decision is safe in
 *  that direction — but it must stay distinguishable from a reviewer positively
 *  known to have no access, which is a fact rather than a gap. */
export type RepositoryPermission =
  | 'admin'
  | 'maintain'
  | 'write'
  | 'triage'
  | 'read'
  | 'none'
  | 'unknown';

/** What a repository-permission read needs. `username` is the host's login. */
export interface RepositoryPermissionInput {
  installationId: string;
  owner: string;
  repo: string;
  username: string;
}

/** The lifecycle of ONE deployment status a repository's host reported, normalized
 *  across providers (Story MOTIR-4906 · MOTIR-5329). A CLOSED union so every
 *  consumer's `switch` is total and a compiler proves a new member is handled.
 *
 *  `canceled` is GitLab's (MOTIR-5332): GitHub reports no such state, GitLab's
 *  `deployment` hook does, and it is not a failure — so it is its own member
 *  rather than folded into one. */
export const DEPLOYMENT_STATES = [
  'queued',
  'pending',
  'in_progress',
  'success',
  'failure',
  'error',
  'inactive',
  'canceled',
] as const;
export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

/** A deployment-status webhook, normalized across providers — the PREVIEW a
 *  repository's own CI reported for a commit (Story MOTIR-4906 · MOTIR-5329).
 *  Motir only LISTENS: it creates no deployment and posts no status.
 *
 *  `environmentUrl` is the APP the deployment serves (GitHub's
 *  `environment_url`), never the log link (`target_url`), and is not yet
 *  sanitised here — the store keeps it only when it is `http:` / `https:`.
 *  `ref` is the branch or tag the deployment was made from. */
export interface NormalizedDeploymentStatus {
  providerRepoId: string;
  /** The host's own deployment id (as a string — never do math on it). */
  providerDeploymentId: string;
  commitSha: string;
  ref: string;
  environment: string;
  state: DeploymentState;
  environmentUrl: string | null;
  /** When the host recorded THIS status — the out-of-order guard's clock. */
  occurredAt: Date;
}

/** A pull request a MERGE QUEUE removed, normalized (Story MOTIR-5461 · MOTIR-5632;
 *  `docs/decisions/approval-gates.md` §4 THIRD AMENDMENT, decision 1). GitHub's
 *  `pull_request` action `dequeued`.
 *
 *  `rawReason` is the host's own string, VERBATIM — classifying it is
 *  `classifyQueueExit`'s job (`lib/mergeQueue/queueExit.ts`), not the seam's, so a
 *  reason nobody has mapped yet still arrives and is recorded. `headSha` is the
 *  pull request's head as the delivery states it. The payload names no merge group
 *  and no failing check. */
export interface NormalizedMergeQueueExit {
  providerRepoId: string;
  number: number;
  headSha: string;
  rawReason: string | null;
}

/** A pull request put INTO a merge queue, normalized (MOTIR-6903). GitHub's
 *  `pull_request` action `enqueued` — from Motir's own enqueue or from anywhere else
 *  (GitHub's *Merge when ready*, `gh pr merge --auto`, another integration). `headSha`
 *  is the head the delivery states, the commit the queue will test. The payload names
 *  no queue entry and no actor Motir reads. */
export interface NormalizedMergeQueueEntry {
  providerRepoId: string;
  number: number;
  headSha: string;
}

/** One MERGE GROUP the queue started testing, normalized (Story MOTIR-5461 ·
 *  MOTIR-5633; `approval-gates.md` §4 THIRD AMENDMENT, decision 8). GitHub's
 *  `merge_group` action `checks_requested`: every check the queue runs for the group
 *  is reported against `headSha`, and nothing else ties those checks to a pull
 *  request. `prNumbers` are parsed from `headRef`
 *  (`refs/heads/gh-readonly-queue/<base>/pr-<n>-<base sha>`) — every `pr-<n>` the
 *  ref names, in order. */
export interface NormalizedMergeGroupAttempt {
  providerRepoId: string;
  headSha: string;
  headRef: string;
  prNumbers: number[];
}

/** A COMPLETED check that FAILED on a commit no pull request names — the only shape
 *  a merge-queue check can have (MOTIR-5633). `url` is the check's own page, the
 *  link the exit row carries. */
export interface NormalizedUnlinkedCheckFailure {
  providerRepoId: string;
  headSha: string;
  name: string;
  url: string;
  completedAt: Date;
  /** The host's RAW conclusion, verbatim (`failure`, `cancelled`, `timed_out`, …).
   *  `mapConclusion` folds all of them into `failure`; this keeps which one it was
   *  (`approval-gates.md` §4 SIXTH AMENDMENT, MOTIR-6846). */
  conclusion: string;
}

/** A completed CI workflow run, normalized across providers — consumed by the
 *  CI-minutes meter (Story MOTIR-1775 · MOTIR-1896). DISTINCT from
 *  `NormalizedStatusEvent`, which is the *verification* signal (did CI pass?)
 *  and deliberately carries no timing: this one is the *billing* signal (how
 *  much compute did it consume, and who owns the repo that pays for it?).
 *
 *  `repoOwner` is read from the RUN's own payload rather than the stored mirror
 *  — `docs/decisions/ci-minutes-allowance.md` §5.5: the owner login is what
 *  GitHub bills on and what flips at a repo transfer, while the mirror row can
 *  be briefly stale. `attempt` is part of the idempotency key because a RE-RUN
 *  is a new attempt that bills again (§5.8). */
export interface NormalizedWorkflowRunEvent {
  providerRepoId: string;
  /** The host's own workflow-run id (as a string — never do math on it). */
  runId: string;
  /** The run attempt; a re-run increments it and bills again. */
  attempt: number;
  repoOwner: string;
  repoName: string;
  /** The workflow's display name, for the audit trail. */
  workflowName: string | null;
  /** When the run completed — the period key (§4.5) AND the effective-date the
   *  runner rates resolve at (§3.3). */
  completedAt: Date;
}

/** A COMPLETED run of a repository's `production-image` workflow, normalized —
 *  the signal a merge has been built (Story MOTIR-9797 · MOTIR-10031). DISTINCT
 *  from {@link NormalizedWorkflowRunEvent}, the CI-minutes meter's, which keeps
 *  its own tolerance: this one carries the facts a release decides on (the
 *  triggering event, the branch, the commit built and how the run concluded),
 *  and is trusted for the commit and the outcome only. */
export interface NormalizedProductionImageRun {
  providerRepoId: string;
  repoOwner: string;
  repoName: string;
  /** The workflow's name (`production-image` for the run that releases). */
  workflowName: string;
  /** The event that triggered the run — `push`, `pull_request`, … */
  event: string;
  headBranch: string;
  /** The commit the run built — the full sha. */
  headSha: string;
  /** `success`, `failure`, `timed_out`, `cancelled`, `skipped`, … */
  conclusion: string;
  /** The host's own workflow-run id (as a string — never do math on it). */
  runId: string;
  /** The run attempt; a re-run of the workflow increments it. */
  runAttempt: number;
}

/** A QUEUED CI job, normalized across providers — consumed by the runner-fleet
 *  provisioning path (Story MOTIR-1916 · MOTIR-1920). DISTINCT from
 *  `NormalizedWorkflowRunEvent`, which is the *billing* signal read at run
 *  COMPLETION: this one is the *provisioning* signal read at job QUEUE time,
 *  i.e. the moment a machine is needed and none exists yet.
 *
 *  `requestedLabels` is the load-bearing field and the ONLY thing the fleet
 *  scopes on (`ci-minutes-allowance.md` §O): the `workflow_job` `queued` event
 *  fires for GitHub-hosted jobs too, so a listener that reacts to event RECEIPT
 *  would pull Motir's own CI onto the fleet. `jobId` joins `(runId, runAttempt)`
 *  in the idempotency key because one run attempt queues MANY jobs, each needing
 *  its own ephemeral runner — the run-level key the meter uses would collapse a
 *  31-job matrix into a single intent. */
export interface NormalizedWorkflowJobEvent {
  providerRepoId: string;
  /** The host's own workflow-run id (as a string — never do math on it). */
  runId: string;
  /** The run attempt; a re-run increments it and legitimately needs new runners. */
  runAttempt: number;
  /** The host's own job id — unique within the run attempt. */
  jobId: string;
  jobName: string | null;
  workflowName: string | null;
  repoOwner: string;
  repoName: string;
  /** The labels the job's `runs-on` REQUESTED. At `queued` no runner has been
   *  assigned yet, so this can only be the requested set — see the note on
   *  GitHub's `parseWorkflowJobEvent`. */
  requestedLabels: string[];
  /** When the job entered the queue — the age a stuck intent is measured from. */
  queuedAt: Date;
}

/** One job of a completed workflow run, normalized across providers. The meter
 *  bills PER JOB, rounded up (§5.8), so this is the unit it reads — not the run
 *  as a whole, whose wall clock would undercount parallel jobs. */
export interface NormalizedWorkflowJob {
  id: string;
  name: string;
  startedAt: Date | null;
  completedAt: Date | null;
  /** The runner labels the host reports (`["ubuntu-latest"]`) — what the
   *  cost-normalization multiplier is resolved from. */
  labels: string[];
}

/** One line of a host's billing usage report, normalized — the MONTHLY
 *  RECONCILIATION source (§5.8). GitHub's per-run `/timing` endpoint and its
 *  product-specific billing API are both closing down, so the audit path is the
 *  enhanced-billing usage endpoint, which is summarised by SKU/repo/day and
 *  carries no per-run detail. That is enough to reconcile, never enough to
 *  meter — which is why the webhook path is the operational meter. */
export interface NormalizedComputeUsageLine {
  /** The repository the minutes were consumed by, as the host reports it. */
  repositoryName: string;
  /** The host's SKU label (e.g. "Actions Linux") — the runner family hint. */
  sku: string;
  /** Quantity in the host's own unit (minutes for Actions SKUs). */
  quantity: number;
  unitType: string;
  /** The usage day, as reported. */
  date: string;
}

/** A short-lived installation access token, minted on demand and cached
 *  in-memory only — NEVER persisted (the card's hard requirement). */
export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

// ─── File READ at a ref (Story MOTIR-4585 · MOTIR-4586) ──────────────────────
//
// ⚠️ WHY THIS IS A RESULT UNION AND NOT A `string | null`. The consumer is a
// PLANNING SESSION: a model that has to decide what it now knows. "This project
// has no repository connected", "that path is not in this repo", "that ref does
// not exist" and "we could not reach the host" are four different facts, and a
// reader handed one polite failure string for all of them will conclude the
// first from the last — the collapse `describeProjectRepositories` and
// `describePendingPlans` already keep three states apart to avoid. A nullable
// return is exactly that collapse with the words removed.

/** The named answers a file read can produce. `found` is the only one carrying
 *  text; every other member is a FACT about why there is none. */
export type RepoFileReadOutcome =
  | 'found'
  | 'binary'
  | 'not_found'
  | 'ref_not_found'
  | 'too_large'
  | 'unauthorized'
  | 'invalid_path'
  | 'unreachable';

/** Why a read could not reach the host at all. Carried on the `unreachable`
 *  result rather than thrown, so a caller switching on `outcome` stays total —
 *  the class that carries the same discriminator is `RepoFileReadError`
 *  (`lib/git/errors.ts`), thrown only for a status no arm below names. */
export type RepoFileReadTransportFailure = 'timeout' | 'unreachable';

/** One child of a directory `readFileAtRef` was pointed at (MOTIR-9868). */
export interface RepoDirectoryEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
}

/**
 * The result of {@link GitProvider.readFileAtRef}.
 *
 * `bytes` is the BLOB's length as the host served it — never a measurement of
 * decoded text (MOTIR-7873: it used to be, and a binary's replacement
 * characters inflated it). On `found` it is also the UTF-8 length of `text`,
 * so a caller that caps output can say by how much it cut.
 *
 * `binary` is a file that EXISTS and is not text — a NUL in its first bytes, or
 * not valid UTF-8 (`classifyRepoBlob`). It carries no content at all: a binary
 * file is named, never decoded into something a model would read as source.
 */
export type RepoFileReadResult =
  | { outcome: 'found'; path: string; ref: string; text: string; bytes: number }
  /** The path names a DIRECTORY (MOTIR-9868): its immediate children, sorted by
   *  name, and `truncated` when the host's listing stopped at
   *  `REPO_DIRECTORY_MAX_ENTRIES`. Never text — a directory is listed, not read. */
  | {
      outcome: 'directory';
      path: string;
      ref: string;
      entries: RepoDirectoryEntry[];
      truncated: boolean;
    }
  | { outcome: 'binary'; path: string; ref: string; bytes: number }
  | { outcome: 'not_found'; path: string; ref: string }
  | { outcome: 'ref_not_found'; path: string; ref: string }
  | { outcome: 'too_large'; path: string; ref: string; limitBytes: number }
  | { outcome: 'unauthorized'; path: string; ref: string }
  | { outcome: 'invalid_path'; path: string; reason: string }
  | {
      outcome: 'unreachable';
      path: string;
      ref: string;
      failure: RepoFileReadTransportFailure;
      detail: string;
    };

/**
 * The answer to "how far is HEAD ahead of the indexed commit?" (MOTIR-4644).
 *
 * ⚠️ `null` IS A FIRST-CLASS ANSWER AND ALWAYS WILL BE — it is not an error
 * channel and it is not a zero. Four different situations produce it, and every
 * consumer already renders it: a host that cannot back the comparison, a pair
 * with no common ancestor (a force-push or a rewritten history), a host that
 * failed or did not answer, and a count the host could not give exactly.
 *
 * ⚠️ AND `null` IS NEVER `0`. Zero means CURRENT to every consumer — the graph
 * matches the head — so returning it for "we could not tell" would put the most
 * reassuring possible answer on the case with the least evidence behind it. That
 * is the same failure `indexState`'s null handling exists to prevent, one field
 * over.
 */
export interface CommitComparison {
  /** Commits on `head` that are not on `base`, or `null` when not determinable. */
  behindBy: number | null;
  /**
   * WHY it is null, when it is — for the log line, never for a surface. A
   * consumer branches on `behindBy === null` and nothing else; this exists so a
   * `null` in production can be explained without a second round-trip.
   */
  reason?: 'no_common_ancestor' | 'unsupported' | 'unreachable' | 'inexact';
}

// ─── WHICH PATHS a branch changed (Story MOTIR-6617 · MOTIR-6619) ────────────
//
// `compareCommits` answers HOW FAR; this answers WHAT. A planning session that
// was told a neighbour card's code lives on a branch (the item read's
// `inFlightCode`, MOTIR-6618) lists the paths that branch touched, then reads
// them at that ref through `readFileAtRef`. NAMES ONLY — no patch hunks, no
// commit list, no blame: the file read is the one channel for content.

/** How one path changed between the merge base and `head`, in the seam's own
 *  words. A host's copy / type-change / mode-change words fold into these four. */
export type ChangedFileStatus = 'added' | 'modified' | 'removed' | 'renamed';

export interface ChangedFile {
  /** The path on `head` (for `removed`, the path that was removed). */
  path: string;
  status: ChangedFileStatus;
  /** Only on `renamed`: the path the file had on the base side. */
  previousPath?: string;
}

/**
 * The result of {@link GitProvider.listChangedFiles}.
 *
 * ⚠️ A RESULT UNION, for `RepoFileReadResult`'s reason: the consumer is a model,
 * and "that branch does not exist", "the connection is gone", "the host would
 * not compute a diff that large" and "the host did not answer" are four
 * different facts it must not collapse into "the branch changed nothing".
 *
 * `truncated: true` means the host's list stopped at its cap
 * (`CHANGED_FILES_MAX`, `lib/git/provider.ts`) — the branch changed AT LEAST those paths. The
 * SHAs are the ones the host resolved `base` and `head` to, or `null` when the
 * host's answer did not say.
 */
export type ChangedFilesResult =
  | {
      outcome: 'ok';
      base: string;
      head: string;
      files: ChangedFile[];
      truncated: boolean;
      baseSha: string | null;
      headSha: string | null;
    }
  /** `base` or `head` names nothing the host can resolve (or the two share no history). */
  | { outcome: 'no_such_ref'; base: string; head: string }
  /** No usable connection on this deployment — the App / OAuth app is unwired, or the
   *  connection row is gone. */
  | { outcome: 'not_connected'; base: string; head: string }
  /** The host refused the credential — an uninstalled / suspended App, a revoked
   *  OAuth grant, a project the token can no longer see. */
  | { outcome: 'revoked'; base: string; head: string }
  /** The host declined to compute the comparison at all because it is too big. */
  | { outcome: 'too_large'; base: string; head: string }
  /** The host did not answer, or answered a status no arm above names. */
  | { outcome: 'host_error'; base: string; head: string; detail: string };

/**
 * MERGING one change request through its host (Story MOTIR-4882 · MOTIR-5514;
 * `approval-gates.md` §4 and its second amendment, decisions 5, 7 and 8).
 */
export interface MergeChangeRequestInput {
  installationId: string;
  owner: string;
  name: string;
  number: number;
  /**
   * The head commit the decision was taken against. The host refuses a merge whose
   * head has moved, so a merge can only ever land the commits somebody approved —
   * and a moved head comes back as `subject_changed`, never as a merge.
   */
  expectedHeadSha: string;
}

/**
 * Which change request to ask the host about — the same address a merge takes, minus
 * the head the decision saw (a READ has no head to pin; it reports the one it found).
 */
export type ChangeRequestMergeabilityInput = Omit<MergeChangeRequestInput, 'expectedHeadSha'>;

/**
 * Does a deployed RELEASE carry what one MERGED change request landed? (Bug
 * MOTIR-8330.) The address is the change request's — the host resolves its own
 * merge commit — and `release` is the commit the release was built from, as the
 * monitor reported it (a full or abbreviated sha).
 */
export interface ReleaseContainsMergeInput {
  installationId: string;
  owner: string;
  name: string;
  number: number;
  release: string;
}

/**
 * The host's answer, in three words and no fourth.
 *
 * - `contains` — the release's commit has the change request's merge commit in its
 *   history (or IS it).
 * - `missing` — both commits exist on the host and the release's does NOT have the
 *   merge in its history: the release was built before the merge, or off a line
 *   that never took it.
 * - `unknown` — anything else: not merged, no merge commit recorded, a release the
 *   host does not know, a refusal, a timeout. ⚠️ NEVER folded into `missing`: the
 *   one caller suppresses a re-file on `missing` alone, so a host that said nothing
 *   must leave today's behaviour standing.
 */
export type ReleaseContainment = 'contains' | 'missing' | 'unknown';

/**
 * The host's answer to *can this change request merge into its base right now?*
 * (MOTIR-5913, for bug MOTIR-5907).
 *
 * ⚠️ `mergeable: null` IS "NOT COMPUTED YET", NEVER "CONFLICTED". GitHub computes it
 * lazily — asynchronously after the base moves, and on first ask — so a caller that
 * needs an answer retries, and one that gets none proceeds as if nothing were known.
 * `mergeableState` is the host's raw word (`clean`, `dirty`, `blocked`, …), read
 * against `'dirty'` alone.
 */
export interface ChangeRequestMergeability {
  mergeable: boolean | null;
  mergeableState: string | null;
  /** The head the answer is about — a reading is only meaningful at this commit. */
  headSha: string | null;
}

/**
 * Why a host refused a merge, in the SEAM's own words — never a host type and never
 * an HTTP status. The merge entry point maps these onto the gate's refusal union;
 * `subject_changed` becomes the shipped `APPROVAL_GATE_SUPERSEDED` there rather than
 * a refusal of its own.
 */
export type MergeRefusalCode =
  | 'checks_not_green'
  | 'conflict'
  | 'branch_protected'
  | 'already_merged'
  | 'app_permission_missing'
  | 'subject_changed';

export interface MergeRefusal {
  code: MergeRefusalCode;
  /** `app_permission_missing` only — the permission the host said it needed. */
  permission?: string;
  /** The host's own account, where it gave one. For the record, never drawn as copy. */
  reason?: string;
}

/**
 * A merge's answer: it merged; it was handed to the base branch's merge QUEUE
 * (MOTIR-5516 — `entryId` is the queue entry, and `done` still arrives only through the
 * merge webhook when the queue lands it); or the host refused with a named reason.
 */
export type MergeChangeRequestResult =
  | { outcome: 'merged'; commitSha: string }
  | { outcome: 'enqueued'; entryId: string }
  | { outcome: 'refused'; refusal: MergeRefusal };

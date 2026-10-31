import { RepoTarballUrlUnsupportedError } from './errors';
import type {
  ChangeRequestLifecycle,
  GitProviderId,
  InstallationToken,
  NormalizedChangeRequest,
  NormalizedComputeUsageLine,
  NormalizedInstallation,
  NormalizedPushEvent,
  NormalizedRepo,
  NormalizedReviewEvent,
  RepositoryPermission,
  RepositoryPermissionInput,
  NormalizedStatusEvent,
  NormalizedWorkflowJob,
  NormalizedWorkflowJobEvent,
  NormalizedProductionImageRun,
  NormalizedWorkflowRunEvent,
  RepoFileReadResult,
  CommitComparison,
  ChangedFilesResult,
  ChangeRequestMergeability,
  ChangeRequestMergeabilityInput,
  ReleaseContainment,
  ReleaseContainsMergeInput,
  MergeChangeRequestInput,
  MergeChangeRequestResult,
  NormalizedDeploymentStatus,
  NormalizedMergeGroupAttempt,
  NormalizedMergeQueueEntry,
  NormalizedMergeQueueExit,
  NormalizedUnlinkedCheckFailure,
} from './types';

// The GitProvider seam (Story 7.10 · MOTIR-891). ONE interface every Git host
// implements; consumers dispatch by the stored `provider` discriminator through
// the registry (`lib/git/registry.ts`) and hold NO host-specific types. GitHub
// is the FIRST registered implementation (`lib/git/providers/github.ts`); GitLab
// (7.23) proves additivity by implementing this SAME interface — a new provider
// is exactly "implement this + register it", nothing in the consumers changes.
//
// The interface is defined ALONGSIDE its first implementation (not in a vacuum —
// the MOTIR-1566 planning lesson), so every method here is one GitHub actually
// backs.

/**
 * Deadline for a repo-tarball URL resolve, in ms (MOTIR-1974). Since both
 * code-graph jobs dispatch containers (MOTIR-2027 / MOTIR-2057) what it bounds
 * is the `redirect: 'manual'` RESOLVE, and since MOTIR-2124 that is the ONLY
 * thing it bounds — the byte-returning sibling it also covered is gone (see
 * {@link resolveRepoTarballUrl}). It must stay under the serve route's
 * `maxDuration`, so a stalled host surfaces as a typed error inside the
 * invocation budget instead of as a `FUNCTION_INVOCATION_TIMEOUT` with no step
 * output. Bounds time-to-response-headers, which is where a dead host hangs.
 */
export const REPO_TARBALL_TIMEOUT_MS = 60_000;

/**
 * Deadline for a single FILE read, in ms (MOTIR-4586). Same job as
 * {@link REPO_TARBALL_TIMEOUT_MS} and deliberately a twelfth of it: that one
 * bounds a resolve on the index path, where a slow answer still beats a failed
 * dispatch; this one bounds a lookup a PLANNING SESSION is waiting on inside a
 * turn, where a minute of silence is worse than a named refusal.
 *
 * It must stay under the reading route's `maxDuration`
 * (`app/api/internal/ai/repo-file/route.ts`), so a dead host surfaces as the
 * `unreachable` result inside the invocation budget rather than as a
 * `FUNCTION_INVOCATION_TIMEOUT` with no body at all — and
 * `tests/git/repoFileRead.test.ts` asserts that ordering rather than leaving it
 * to a comment.
 */
export const REPO_FILE_READ_TIMEOUT_MS = 5_000;

/**
 * Deadline for a commit comparison, in ms (MOTIR-4644).
 *
 * Longer than a file read because a compare walks history rather than fetching
 * one blob, and SHORTER than any page budget because nothing on a render path is
 * allowed to wait for it — the call happens off that path, and this bound exists
 * so a host that hangs cannot hold a job open indefinitely.
 */
export const COMMIT_COMPARE_TIMEOUT_MS = 10_000;

/**
 * Deadline for a changed-files listing, in ms (MOTIR-6619) — its own constant
 * beside {@link COMMIT_COMPARE_TIMEOUT_MS} because it is the same host endpoint
 * asked a different question, on a different path: a compare for the drift count
 * runs from a JOB, this one runs inside a planning session's turn, where a named
 * `host_error` beats a long silence. The same length as the compare, because the
 * host does the same walk either way.
 *
 * It must stay under the listing route's `maxDuration`
 * (`app/api/internal/ai/repo-changes/route.ts`) so a dead host surfaces as the
 * `host_error` result inside the invocation budget — `tests/git/
 * listChangedFiles.test.ts` asserts that ordering.
 */
export const CHANGED_FILES_TIMEOUT_MS = 10_000;

/**
 * The most paths one {@link GitProvider.listChangedFiles} answer carries — GitHub's
 * compare endpoint's own cap on `files[]` (it returns at most 300 and says nothing
 * about the rest). GitLab has no such cap on the same question, and is held to this
 * one anyway, so a session learns the same bound about a branch wherever it lives.
 * A listing AT the cap reports `truncated: true`: a response sitting exactly on a
 * host cap is indistinguishable from one that was cut.
 */
export const CHANGED_FILES_MAX = 300;

/**
 * Deadline for EACH host call a merge makes, in ms (MOTIR-5514). A merge is a write
 * a person is waiting on after pressing Approve, so it is bounded like a compare
 * rather than like a tarball: long enough for a host that is merely slow, short
 * enough that a host which never answers becomes a typed error instead of a button
 * that spins.
 */
export const MERGE_CHANGE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * The largest file a WHOLE-file read hands back, in bytes — the limit
 * `repoFileReadService.readFile` applies to a read that names no line range.
 *
 * ⚠️ IT IS A LIMIT ON WHAT A CALLER IS HANDED, NOT ON WHAT CAN BE READ
 * (MOTIR-10143). It used to sit in the providers, on the belief that GitHub's
 * contents endpoint refuses a blob over 1 MB — which is true of its JSON
 * envelope and not of the RAW media type the read asks for (served up to
 * {@link REPO_FILE_FETCH_MAX_BYTES}). So a ten-line range of a 1.1 MB file was
 * refused for a reason the host never gave, and a planner could not read the
 * file at all. A RANGED read is served past it; an unranged one is still
 * refused `too_large`, now carrying the file's line count so the caller can ask
 * for a range.
 */
export const REPO_FILE_MAX_BYTES = 1024 * 1024;

/**
 * The largest blob a provider fetches at all, in bytes — GitHub's own limit for
 * the raw media type of the contents endpoint (100 MB; the JSON envelope stops at
 * 1 MB). Over it GitHub answers 403 `too_large`, and GitLab, which has no such
 * refusal, is held to the same number so a session learns the same fact about
 * the same file wherever it is hosted.
 */
export const REPO_FILE_FETCH_MAX_BYTES = 100 * 1024 * 1024;

export interface GitProvider {
  /** The provider discriminator — matches the stored rows' `provider` column. */
  readonly id: GitProviderId;

  /**
   * Mint a short-lived installation access token, scoped by the host to the
   * installation's repos, from the App/OAuth-app credentials. Cached in-memory
   * until near expiry and re-minted; NEVER persisted. `installationId` is the
   * host's own installation id (GitHub's numeric id as a string).
   */
  mintInstallationToken(
    installationId: string,
    /** The repository the token is FOR, when the caller knows it (MOTIR-5681). A host
     *  that runs more than one App chooses by the repository's provenance — GitHub mints
     *  a hosted repository's token through the provisioning App — and one that does not
     *  ignores it. Omitted, the host's default credential. */
    forRepo?: { owner: string },
  ): Promise<InstallationToken>;

  /**
   * Fetch the repositories reachable on an installation, normalized. Uses a
   * freshly-minted (or cached) installation token.
   */
  fetchInstallationRepos(installationId: string): Promise<NormalizedRepo[]>;

  // ⚠️ `fetchRepoTarball` IS GONE (MOTIR-2124), AND MUST NOT COME BACK. It
  // returned a repo's gzipped-tarball BYTES for the MOTIR-1500 in-process index.
  // MOTIR-2027 / MOTIR-2057 moved BOTH code-graph jobs onto containers that fetch
  // for themselves, which left it with zero production callers — and a required
  // interface method nothing calls is not neutral: it is what made
  // `gitlabProvider` LOOK like a complete provider while the capability the
  // shipped path actually requires ({@link resolveRepoTarballUrl}) was missing,
  // so every GitLab index dead-lettered five times and nothing said why. Removing
  // it makes a provider declare exactly what it can do. Re-adding it would
  // re-create both the disguise and the buffering OOM
  // (`docs/decisions/code-graph-index-fleet.md` §2) in one edit.

  /**
   * Resolve the host's PRE-SIGNED archive URL for a repo at `ref` — **without
   * downloading the body** (MOTIR-1989).
   *
   * ⚠️ OPTIONAL, and for the same structural reason the metering reads below are:
   * a method every host genuinely backs is required here; one only some hosts can
   * back is DECLARED, never mandated. GitHub 302-redirects
   * `/repos/{owner}/{name}/tarball/{ref}` to a `codeload.github.com` URL whose
   * SIGNED QUERY STRING is the whole authorization, so the resolved URL is
   * self-authorizing and single-repo.
   *
   * ⚠️ GITLAB CANNOT BACK THIS, AND THAT WAS MEASURED, NOT ASSUMED (MOTIR-2124).
   * `GET /api/v4/projects/:id/repository/archive` answers **200 with the bytes**
   * (`content-type: application/octet-stream`, `content-disposition: attachment`,
   * NO `location` header) where GitHub answers **302 →
   * `codeload.github.com/…`** — both observed against the live hosts on
   * 2026-08-04. GitLab does accept a token in the QUERY STRING
   * (`?private_token=` / `?access_token=`), so a URL-shaped credential is
   * technically constructible — and it is exactly what this contract forbids
   * below: the token Motir holds is the connection's OAuth token with the **full
   * `api` scope** (`lib/gitlab/gitlabOAuth.ts`, ~2 h), which reaches EVERY project
   * that user can see. Handing that to a container would be strictly MORE
   * privilege than the installation token §10 already refuses to hand over, not
   * less. So GitLab does not implement this, and a stub would model a capability
   * its host does not have. What DOES happen for a GitLab repo is the honest
   * refusal in `codeGraphIndexService.resolveIndexTarget`, which never dispatches
   * a container it knows cannot boot.
   *
   * ⚠️ WHAT THIS IS FOR, so the contract is not weakened by accident. The resolved
   * URL is handed to a fleet CONTAINER that holds no GitHub credential at all
   * (`docs/decisions/code-graph-index-fleet.md` §10). Handing over the URL leaks
   * nothing and is strictly LESS privilege than an installation token, which would
   * grant repo-wide API access for its lifetime — but that is true only because the
   * URL is short-lived and scoped to one repo. An implementation that returned a
   * long-lived or org-wide URL, or that appended a token to it, would break the
   * decision this capability exists to satisfy.
   *
   * Implementations MUST bound the request with {@link REPO_TARBALL_TIMEOUT_MS},
   * MUST NOT read the response body, and MUST throw a typed `RepoTarballUrlError`
   * (`lib/git/errors.ts`) rather than returning an empty or partial URL: a falsy
   * URL would reach a container spec and fail there, blaming the repo for a defect
   * in the dispatcher.
   *
   * Resolve it through {@link requireRepoTarballUrlResolver}, never by reading this
   * property directly — that helper is what turns "this host cannot" into a loud
   * refusal. To ASK whether a host can, without committing to dispatch, use
   * {@link providerSupportsRepoTarballUrl}: it is the same predicate, so a caller
   * that gates on it can never disagree with the boot that throws.
   */
  resolveRepoTarballUrl?(
    installationId: string,
    owner: string,
    name: string,
    ref: string,
  ): Promise<string>;

  /**
   * Read ONE file's TEXT at a ref (MOTIR-4586) — the capability a planning
   * session's `read_file` tool is built on.
   *
   * ⚠️ REQUIRED, AND THAT IS THE OPPOSITE OF {@link resolveRepoTarballUrl} ON
   * PURPOSE. That one is optional because GitLab genuinely CANNOT back it: the
   * fleet container holds no credential, so it needs a SELF-AUTHORIZING URL,
   * and GitLab's only URL-shaped credential is the connection's full-`api`
   * OAuth token — strictly more privilege than §10 permits a container to hold.
   * Reading a file has no such constraint, because nothing credential-shaped
   * crosses a boundary at all: the call happens HERE, in the process that
   * already holds the token, and what leaves is text. Both hosts can back it,
   * so both must — declaring it optional would re-create exactly the disguise
   * MOTIR-2124 removed, where a provider looks complete while the capability a
   * consumer requires is missing, and every attempt dead-letters saying nothing.
   *
   * ⚠️ IT RETURNS ITS FAILURES. Every ordinary answer — no such path, no such
   * ref, a file over {@link REPO_FILE_FETCH_MAX_BYTES}, a credential the host
   * refused, a path the guard rejected, a host that did not answer — is a
   * NAMED member of {@link RepoFileReadResult}, because the consumer is a model
   * deciding what it now knows and "this project has no code" must never be
   * concluded from "that file is not at that path". A `RepoFileReadError`
   * (`lib/git/errors.ts`) is thrown ONLY for a status no arm names.
   *
   * Implementations MUST call `normalizeRepoFilePath` (`lib/git/repoPath.ts`)
   * BEFORE issuing any request, MUST bound the request with
   * {@link REPO_FILE_READ_TIMEOUT_MS}, and MUST NOT put the token — or any URL
   * carrying one — into the result they return.
   *
   * `ref` is required: the caller knows the repository's default branch (it is
   * a stored column) and the provider does not, so defaulting here would mean a
   * second host round-trip to learn something the caller already had.
   */
  readFileAtRef(
    installationId: string,
    owner: string,
    name: string,
    path: string,
    ref: string,
  ): Promise<RepoFileReadResult>;

  /**
   * HOW FAR `head` IS AHEAD OF `base`, IN COMMITS (MOTIR-4644) — the drift count
   * three surfaces render and nothing computed.
   *
   * ⚠️ REQUIRED, for {@link readFileAtRef}'s reason and not
   * {@link resolveRepoTarballUrl}'s. That one is optional because GitLab
   * genuinely CANNOT back it — a credential-free container needs a
   * self-authorizing URL, which GitLab has no way to mint at the privilege §10
   * permits. Comparing two commits has no such constraint: the call happens
   * HERE, in the process holding the token, and what leaves is a number. GitHub
   * backs it with `GET /repos/{owner}/{name}/compare/{base}...{head}`
   * (`ahead_by`), GitLab with
   * `GET /api/v4/projects/:id/repository/compare` — so both hosts can, and
   * therefore both must. Declaring it optional would re-create the exact
   * disguise MOTIR-2124 removed: a provider that looks complete while the
   * capability a consumer needs is missing, failing silently at every call site.
   *
   * ⚠️ IT RETURNS ITS FAILURES AS `behindBy: null`, NEVER BY THROWING, and never
   * as `0`. Zero means CURRENT to every consumer, so a "could not tell" rendered
   * as zero would put the most reassuring answer on the least evidence. The
   * named `reason` arms exist for the log, not for a surface.
   *
   * ⚠️ NO CALLER MAY INVOKE THIS ON A RENDER PATH. MOTIR-1766 chose a push
   * webhook over a HEAD fetch precisely to keep provider latency and rate limits
   * off the two surfaces that read staleness, and that reasoning binds this
   * method: it is called from a JOB, and the read path serves a cached count or
   * `null`. `tests/git/commitCompare.test.ts` asserts the read makes no provider
   * call, with a double that fails the test if it is invoked.
   *
   * Implementations MUST bound the request with
   * {@link COMMIT_COMPARE_TIMEOUT_MS}.
   */
  compareCommits(
    installationId: string,
    owner: string,
    name: string,
    base: string,
    head: string,
  ): Promise<CommitComparison>;

  /**
   * WHICH PATHS `head` CHANGED against `base` (Story MOTIR-6617 · MOTIR-6619) —
   * the listing a planning session reads a neighbour's in-flight branch through,
   * before reading the files themselves with {@link readFileAtRef}.
   *
   * ⚠️ REQUIRED, for {@link compareCommits}' reason. Both hosts back it with the
   * very endpoint that method already calls — GitHub's
   * `GET /repos/{owner}/{name}/compare/{base}...{head}` (`files[]`), GitLab's
   * `GET /api/v4/projects/:id/repository/compare` (`diffs[]`) — and the call
   * happens HERE, in the process holding the token, so nothing
   * credential-shaped crosses a boundary. Both can, therefore both must;
   * declaring it optional would re-create the disguise MOTIR-2124 removed.
   *
   * ⚠️ NAMES ONLY. The hosts return patch hunks alongside the paths; an
   * implementation drops them. Content is read through {@link readFileAtRef}.
   *
   * ⚠️ IT RETURNS ITS FAILURES as named members of {@link ChangedFilesResult} —
   * a missing ref, a connection that is not there, a revoked credential, a diff
   * the host would not compute, a host that did not answer — and never throws
   * for any of them. An empty `files` is a real answer ("changed nothing"), so
   * no failure may ever be rendered as one.
   *
   * ⚠️ NO CALLER MAY INVOKE THIS ON A RENDER PATH — {@link compareCommits}' rule.
   * Its one caller is `GET /api/internal/ai/repo-changes`, on demand.
   *
   * Implementations MUST bound the request with {@link CHANGED_FILES_TIMEOUT_MS},
   * MUST cap the list at {@link CHANGED_FILES_MAX}, and MUST NOT put the token —
   * or any URL carrying one — into the result.
   *
   * The argument shape is {@link compareCommits}' and {@link readFileAtRef}'s:
   * positional `(installationId, owner, name, …)`, and `base` is REQUIRED for
   * `readFileAtRef`'s stated reason — the caller holds the mirrored default
   * branch and the provider does not.
   */
  listChangedFiles(
    installationId: string,
    owner: string,
    name: string,
    base: string,
    head: string,
  ): Promise<ChangedFilesResult>;

  /**
   * MERGE one change request on the host (Story MOTIR-4882 · MOTIR-5514;
   * `approval-gates.md` §4 second amendment, decisions 5, 7 and 8).
   *
   * ⚠️ OPTIONAL, AND THAT IS THE CAPABILITY DECLARATION. A host that cannot merge
   * does not implement it, and a caller asks {@link providerSupportsMerge} — the
   * shape {@link resolveRepoTarballUrl} and its helper already use. MOTIR-4610
   * replaces capability-by-optional-method with a declared set and converts this
   * site.
   *
   * ⚠️ EVERY ANSWER THE HOST GIVES IS A RESULT, NEVER A THROW: merged, enqueued onto
   * the base branch's merge queue (MOTIR-5516), or refused with the seam's own code. What throws is only what is not an answer — no
   * response within {@link MERGE_CHANGE_REQUEST_TIMEOUT_MS}, an unreachable host, or
   * a status no refusal names (`MergeChangeRequestError`). Turning those into a
   * refusal would tell a person the host said no when the host said nothing.
   *
   * ⚠️ NOTHING ABOVE THE PROVIDER SEES A HOST TYPE OR AN HTTP STATUS. The merge
   * entry point maps the refusal codes onto the gate's refusal union.
   */
  mergeChangeRequest?(input: MergeChangeRequestInput): Promise<MergeChangeRequestResult>;

  /**
   * READ whether one change request can merge into its base right now (MOTIR-5913,
   * for bug MOTIR-5907) — asked BEFORE anybody is asked to approve-and-merge, so a
   * conflict withdraws the question instead of being discovered by a refused merge.
   *
   * ⚠️ OPTIONAL, and implemented exactly where {@link mergeChangeRequest} is: a host
   * that cannot merge has nothing to be un-mergeable INTO. GitLab implements neither —
   * it ships no merge path, so a GitLab merge request is never a merge candidate and
   * there is no gate for a conflict to withdraw.
   *
   * ⚠️ A NON-ANSWER THROWS (`MergeChangeRequestError`, the same bounded host call a
   * merge makes); every caller treats a throw as "not known", never as a conflict.
   */
  readChangeRequestMergeability?(
    input: ChangeRequestMergeabilityInput,
  ): Promise<ChangeRequestMergeability>;

  /**
   * Does the deployed RELEASE `input.release` (a commit) carry what change request
   * `input.number` MERGED? (Bug MOTIR-8330.) The monitor asks it before re-filing a
   * completed bug: an error from a build that predates the fix is the old build still
   * serving, not a recurrence.
   *
   * ⚠️ OPTIONAL. A host that does not implement it answers nothing, which the caller
   * reads exactly as `unknown` — the re-file goes ahead as it always did.
   *
   * ⚠️ IT NEVER THROWS. Every non-answer — an unmerged change request, a release the
   * host does not know, a failed token mint, a timeout — is `unknown`, because the
   * caller runs inside a poll that must not fail an issue over a courtesy read.
   */
  readReleaseContainsMerge?(input: ReleaseContainsMergeInput): Promise<ReleaseContainment>;

  /**
   * Fetch an installation's account (login + type) from the host, given only the
   * installation id — used to bind a fresh install to a workspace (MOTIR-1588),
   * where the post-install redirect carries only the id (no webhook payload).
   * Uses the App-level credential (GitHub: the App JWT), not an installation
   * token.
   */
  fetchInstallation(installationId: string): Promise<NormalizedInstallation>;

  /**
   * Normalize a raw change-request webhook payload into the provider-agnostic
   * shape, or `null` when the payload is not a change-request event we handle
   * (a different event, or a malformed body).
   */
  parseChangeRequestEvent(rawPayload: unknown): NormalizedChangeRequest | null;

  /**
   * Map a normalized change request to the canonical workflow-lifecycle signal
   * the status sync (MOTIR-892) applies to the linked work item. PURE.
   *
   * ⚠️ `done` here means "the host reports this merged", NOT "the deliverable
   * shipped". The two diverge whenever `baseRef` is not the repository's default
   * branch (MOTIR-1873), and only the consumer can tell — the mirrored default
   * branch is a DB read this pure seam deliberately cannot make. So a provider
   * must never try to gate completion here.
   *
   * ⚠️ `null` means NO LIFECYCLE CHANGE, and it is a real answer rather than a
   * failure (MOTIR-4968): an OPEN DRAFT is code that exists and is explicitly
   * NOT offered for review, so it is neither `implemented` nor anything else.
   * The consumer RECORDS the delivery and skips the transition — it must not
   * treat this as malformed, and it must not fall back to a default.
   *
   * ⚠️ AND THE ORDER OF THE ARMS IS THE WHOLE OF THE DRAFT RULE. The guard
   * belongs where `implemented` is DECIDED — AFTER the merged and closed arms —
   * never as a blanket early return, which would also swallow a draft that is
   * CLOSED without merging (`draft: true, state: 'closed'`, which every host
   * permits and which must still resolve to `todo`) and a `merged` draft (which
   * GitHub blocks today and which this seam must not depend on it blocking).
   */
  changeRequestLifecycle(cr: NormalizedChangeRequest): ChangeRequestLifecycle | null;

  /**
   * Normalize a raw CI / pipeline webhook payload into the provider-agnostic
   * status-event shape, or `null` when it is not one we handle.
   */
  parseCiStatusEvent(rawPayload: unknown): NormalizedStatusEvent | null;

  /**
   * Normalize a raw push webhook payload into the provider-agnostic push shape,
   * or `null` when it is not a BRANCH push we handle (a tag push, a branch
   * deletion, or a malformed body) — consumed by the code-graph feed
   * (MOTIR-893). PURE.
   */
  parsePushEvent(rawPayload: unknown): NormalizedPushEvent | null;

  // --- REVIEWS (Story MOTIR-4910 · MOTIR-5595) -------------------------------
  //
  // `docs/decisions/approval-gates.md` §8 FOURTH AMENDMENT (MOTIR-5590), decision
  // 2. A GitHub approval decides the card's one approve-to-merge gate, and both
  // halves of that — WHAT the review says, and whether its author was entitled to
  // say it — are host facts. They reach `githubWebhookService` through this seam
  // for the same reason every other event does: so the consumer holds no
  // host-specific type, and the GitLab story supplies the same shape rather than a
  // second vocabulary.
  //
  // ⚠️ BOTH OPTIONAL, in the idiom `mergeChangeRequest?` established. GitLab's
  // approval model is genuinely different — it has approval RULES with counts —
  // and nothing here is written to generalise to it, so GitLab must compile
  // WITHOUT these rather than ship stubs modelling a capability it does not have
  // (the "define the interface alongside a real implementation" rule this seam was
  // built on). A consumer checks for the capability and no-ops without it.

  /**
   * Normalize a raw REVIEW webhook payload into the provider-agnostic shape, or
   * `null` when it is not one we handle (a different event, an unrecognised state,
   * or a malformed body). PURE.
   *
   * ⚠️ NULL, NEVER A PARTIAL EVENT. A review missing its id, its commit, its
   * author or its pull-request number cannot be stored idempotently or matched to
   * a head, and a consumer that received a half-filled one would decide a gate on
   * a guess. Missing is missing.
   *
   * ⚠️ THE STATE IS NORMALIZED CASE-INSENSITIVELY, and that is a real host
   * difference rather than defensiveness: the WEBHOOK sends `approved` and the
   * REST API sends `APPROVED`, so a consumer reading both would otherwise see two
   * vocabularies for one fact.
   */
  parseReviewEvent?(rawPayload: unknown): NormalizedReviewEvent | null;

  /**
   * Read whether `username` can WRITE to a repository — the entitlement half of
   * decision 2, and the reason an approval from a drive-by reader decides nothing.
   *
   * ⚠️ A 404 IS AN ANSWER (`none`), not a failure: GitHub answers 404 for a user
   * with no access at all. Anything else the host could not answer — a 403, a 500,
   * a timeout — throws `ProviderPermissionReadError`, and the consumer records
   * `unknown`. The two must stay distinguishable: `none` is a fact about the
   * person, `unknown` is a gap in what Motir knows, and only the second one is
   * ever worth retrying.
   *
   * It reads the permission AT THE MOMENT the review arrived, because that is the
   * question an audit asks — a reviewer whose access is revoked next week was
   * still entitled when they approved.
   */
  getRepositoryPermission?(input: RepositoryPermissionInput): Promise<RepositoryPermission>;

  // --- CI-minutes metering (Story MOTIR-1775 · MOTIR-1896) -------------------
  //
  // ⚠️ OPTIONAL, and deliberately so. Every method above is one EVERY host
  // backs, because every host has PRs, CI checks and pushes. Billable compute
  // Motir pays for is different: `docs/decisions/ci-minutes-allowance.md` §5.6
  // records that the meter's scope is GitHub-only STRUCTURALLY, not by omission
  // — Motir creates repositories only in its own GitHub org (MOTIR-1779,
  // `POST /orgs/{org}/repos`), while the shipped GitLab provider exists for
  // CONNECT-EXISTING only, i.e. a namespace the user owns and GitLab already
  // bills them for. There is therefore no GitLab compute Motir pays for, and no
  // GitLab read to implement.
  //
  // So these are a CAPABILITY a provider may declare, not a contract every
  // provider must satisfy. Making them required would force `gitlab.ts` to ship
  // stubs modelling a capability its host will never have for Motir — the
  // "define the interface alongside a real implementation" rule this seam was
  // built on, applied to a method that only ONE host genuinely backs. The meter
  // checks for the capability and no-ops without it. If Motir ever decides to
  // create repos on GitLab, §5.6 says that is a new card and an ADR amendment —
  // at which point GitLab implements these and nothing else changes.

  /**
   * Normalize a raw COMPLETED-workflow-run webhook payload into the
   * provider-agnostic shape, or `null` when it is not one we meter (a run that
   * has not completed, a different event, or a malformed body). PURE.
   */
  parseWorkflowRunEvent?(rawPayload: unknown): NormalizedWorkflowRunEvent | null;

  /**
   * Normalize a raw QUEUED-workflow-job webhook payload into the
   * provider-agnostic shape, or `null` when it is not one the fleet provisions
   * for (a non-`queued` action — `in_progress` / `completed` — a different
   * event, or a malformed body). PURE.
   *
   * OPTIONAL for the same structural reason the metering reads above are
   * (§5.6): Motir creates repositories only in its own GitHub org, so there is
   * no GitLab job the fleet would ever boot a runner for.
   */
  parseWorkflowJobEvent?(rawPayload: unknown): NormalizedWorkflowJobEvent | null;

  /**
   * Normalize a raw COMPLETED-workflow-run webhook payload into the facts a
   * production release decides on (Story MOTIR-9797 · MOTIR-10031), or `null`
   * when it is not a completed run or a field is missing. PURE. Beside
   * {@link parseWorkflowRunEvent}, which is the meter's and is left as it is.
   * OPTIONAL: production is built only in Motir's own GitHub organisations.
   */
  parseProductionImageRunEvent?(rawPayload: unknown): NormalizedProductionImageRun | null;

  // --- Preview deployments (Story MOTIR-4906 · MOTIR-5329) -------------------

  /**
   * Normalize a raw DEPLOYMENT-STATUS webhook payload — the preview URL a
   * repository's own CI reported for a commit — or `null` when it is not one
   * (a different event, an unknown state, or a malformed body). PURE.
   *
   * OPTIONAL in the same style as the reads above: a host that reports no
   * deployments simply does not declare it, and the webhook service no-ops.
   * GitHub implements it here; GitLab's `deployment` hook is MOTIR-5332's.
   */
  parseDeploymentStatusEvent?(rawPayload: unknown): NormalizedDeploymentStatus | null;

  // --- Merge queues (Story MOTIR-5461 · MOTIR-5632) --------------------------

  /**
   * Normalize a raw webhook payload announcing that a MERGE QUEUE removed a change
   * request, or `null` when it is not one (a different action, or a malformed
   * body). PURE.
   *
   * OPTIONAL in the style of the reads above: GitHub implements it; GitLab's merge
   * trains are MOTIR-4608's, and a host that does not declare it is simply never
   * asked.
   */
  parseMergeQueueExitEvent?(rawPayload: unknown): NormalizedMergeQueueExit | null;

  /**
   * Normalize a raw webhook payload announcing that a change request was put INTO a
   * merge queue, or `null` when it is not one (MOTIR-6903). PURE. Optional for the
   * reason the exit's parse is.
   */
  parseMergeQueueEntryEvent?(rawPayload: unknown): NormalizedMergeQueueEntry | null;

  /**
   * Normalize a raw payload announcing that a merge queue started testing a group,
   * or `null` when it is not one (MOTIR-5633). PURE. A ref that names no pull request
   * is `null` too: there is nothing to attach a check to.
   */
  parseMergeGroupAttemptEvent?(rawPayload: unknown): NormalizedMergeGroupAttempt | null;

  /**
   * Normalize a raw CI payload into a FAILED, COMPLETED check that names no pull
   * request — the shape of a merge-queue check — or `null` for anything else: a
   * pending or passing check, one a pull request claims, or a suite-level event
   * (which carries no check name or link). PURE (MOTIR-5633).
   */
  parseUnlinkedCheckFailure?(rawPayload: unknown): NormalizedUnlinkedCheckFailure | null;

  /**
   * Fetch the JOBS of one completed workflow run, normalized. The meter bills
   * per job rounded up (§5.8), so this — not the run's own wall clock — is the
   * unit it reads. Uses a freshly-minted (or cached) installation token.
   */
  fetchWorkflowRunJobs?(
    installationId: string,
    owner: string,
    name: string,
    runId: string,
    attempt: number,
  ): Promise<NormalizedWorkflowJob[]>;

  /**
   * Fetch an ORG's compute-usage report lines for a period — the monthly
   * RECONCILIATION source (§5.8), never the operational meter. Uses the
   * org-level billing credential, NOT an installation token (an installation
   * token cannot read org billing).
   */
  fetchOrgComputeUsage?(
    org: string,
    year: number,
    month: number,
    token: string,
  ): Promise<NormalizedComputeUsageLine[]>;
}

/** What {@link requireRepoTarballUrlResolver} hands back — the capability, bound
 *  to its provider, with the optionality already discharged. */
export type RepoTarballUrlResolver = (
  installationId: string,
  owner: string,
  name: string,
  ref: string,
) => Promise<string>;

/**
 * The provider's tarball-URL resolver, or a LOUD refusal (MOTIR-1989).
 *
 * ⚠️ THIS FUNCTION IS THE POINT OF MAKING THE CAPABILITY OPTIONAL. An optional
 * method invites `provider.resolveRepoTarballUrl?.(…) ?? somethingElse`, and the
 * `somethingElse` a caller reaches for is `fetchRepoTarball` — which buffers a
 * whole repo into the function's heap, i.e. exactly the OOM
 * (`docs/decisions/code-graph-index-fleet.md` §2: `motir-core`, 5/5 attempts) that
 * moving indexing onto containers exists to remove. So there is one way to reach
 * the capability and it either returns it or throws.
 *
 * It mirrors `projectRunnerGroupService.requireRunnerGroupId` and
 * `getOrchestrator()`: a nullable return invites a lenient fallback at the call
 * site, and the lenient fallback here is silently doing the expensive, failing
 * thing while reporting success.
 */
export function requireRepoTarballUrlResolver(provider: GitProvider): RepoTarballUrlResolver {
  const resolve = provider.resolveRepoTarballUrl;
  if (!providerSupportsRepoTarballUrl(provider) || !resolve)
    throw new RepoTarballUrlUnsupportedError(provider.id);
  return resolve.bind(provider);
}

/**
 * Can this host hand a token-less container a self-authorizing archive URL — i.e.
 * can a repo on it be indexed on the fleet at all? (MOTIR-2124)
 *
 * ⚠️ THIS IS THE ASKING FORM OF {@link requireRepoTarballUrlResolver}, AND THEY
 * READ THE SAME PROPERTY ON PURPOSE. The refusal that matters is the one at
 * `bootIndexContainer`, which throws; but a throw there is a JOB FAILURE, and a
 * job failure for a host that structurally cannot succeed is five retries, five
 * dead-letters and no explanation — the MOTIR-2124 defect. A caller that wants to
 * decide BEFORE dispatching needs to ask the question without committing to the
 * answer, and the one thing that must never happen is a gate that says "yes"
 * where the boot says "no" (or vice versa). Deriving both from this single
 * predicate makes that disagreement unrepresentable rather than merely unlikely.
 *
 * It is deliberately NOT a `providerId` allow-list: an allow-list is a second
 * copy of the capability that drifts the moment a provider gains or loses the
 * method — which is precisely how the shipped code came to have a fleet path
 * requiring a capability one registered provider never implemented.
 */
export function providerSupportsRepoTarballUrl(provider: GitProvider): boolean {
  return typeof provider.resolveRepoTarballUrl === 'function';
}

/**
 * Can this host MERGE a change request (MOTIR-5514)? The one predicate a caller asks
 * before offering a merge — deliberately not a `providerId` allow-list, for the
 * reason {@link providerSupportsRepoTarballUrl} gives: an allow-list is a second copy
 * of the capability that drifts the moment a provider gains or loses the method.
 */
export function providerSupportsMerge(
  provider: GitProvider,
): provider is GitProvider & Required<Pick<GitProvider, 'mergeChangeRequest'>> {
  return typeof provider.mergeChangeRequest === 'function';
}

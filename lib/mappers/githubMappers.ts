import type {
  GithubIdentity,
  GithubInstallation,
  GithubPullRequest,
  GithubRepo,
} from '@/generated/prisma/client';
import type {
  GithubIdentityDTO,
  GithubInstallationDTO,
  GithubRepoDTO,
  LinkedPullRequestDto,
  PullRequestLinkCandidateDto,
  PullRequestMergeRecordDto,
  WorkItemDeliveryDto,
} from '@/lib/dto/github';
import type {
  GithubPullRequestCandidate,
  GithubPullRequestWithContext,
} from '@/lib/repositories/githubPullRequestRepository';
import type { WorkItemDeliveryWithChecks } from '@/lib/repositories/workItemDeliveryRepository';
import { derivePrCiState } from '@/lib/github/prCiState';
import { pullRequestHead } from '@/lib/github/pullRequestHead';
import { isConflictedAtCurrentHead } from '@/lib/github/mergeability';

// Prisma → DTO conversion for the GitHub integration (Story 7.10 · MOTIR-1498 /
// MOTIR-891). The mapper is the enforcement point for "no secret crosses the API
// boundary": for the identity it structurally cannot leak `accessTokenEncrypted`
// (never referenced), and the installation DTO carries NO access token at all
// (the installation token is minted on demand, never stored).

export function toGithubIdentityDTO(row: GithubIdentity): GithubIdentityDTO {
  return {
    id: row.id,
    githubUserId: row.githubUserId,
    githubLogin: row.githubLogin,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt.toISOString(),
    needsReauth: row.refreshRefusedAt !== null,
  };
}

export function toGithubRepoDTO(row: GithubRepo): GithubRepoDTO {
  return {
    id: row.id,
    repoId: row.repoId,
    owner: row.owner,
    name: row.name,
    defaultBranch: row.defaultBranch,
  };
}

export function toGithubInstallationDTO(
  installation: GithubInstallation,
  repos: GithubRepo[],
): GithubInstallationDTO {
  return {
    id: installation.id,
    provider: installation.provider,
    installationId: installation.installationId,
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    repos: repos.map(toGithubRepoDTO),
    createdAt: installation.createdAt.toISOString(),
  };
}

/**
 * A linked PR row → the Development surface's display-ready shape (Story 7.10
 * · MOTIR-1579): title falls back to the head branch (pre-capture rows carry
 * no title), `merged` collapses the raw open/closed pair, the per-PR CI state
 * derives from the check rows at the latest recorded commit, and the link-out
 * URL is composed here so the client never string-builds it.
 */
export function toLinkedPullRequestDto(
  row: GithubPullRequestWithContext,
  /** What this pull request's GitHub review says, already computed by the caller
   *  (MOTIR-5602). The mapper stays pure: the review needs two batched reads and a rule,
   *  and a mapper that did them would make one row a query. */
  githubReview: LinkedPullRequestDto['githubReview'] = null,
): LinkedPullRequestDto {
  return {
    githubReview,
    id: row.id,
    title: row.title ?? row.headRef,
    repo: `${row.repo.owner}/${row.repo.name}`,
    number: row.number,
    state: row.merged ? 'merged' : row.state === 'open' ? 'open' : 'closed',
    ci: derivePrCiState(row.checkRuns),
    headSha: pullRequestHead(row),
    url: `https://github.com/${row.repo.owner}/${row.repo.name}/pull/${row.number}`,
    baseRef: row.baseRef,
    // Only an OPEN member can conflict: a merged or closed one merges into nothing more.
    conflicted: !row.merged && row.state === 'open' && isConflictedAtCurrentHead(row),
  };
}

/**
 * A pull-request row → its MERGE RECORD (MOTIR-5520). Takes only the two columns, so
 * every read of the row — a bare row, one with its repository, one with its
 * installation — maps the same way.
 */
export function toPullRequestMergeRecordDto(
  row: Pick<GithubPullRequest, 'mergeAuthority' | 'mergeOutcomeRef'>,
): PullRequestMergeRecordDto {
  return { mergeAuthority: row.mergeAuthority, mergeOutcomeRef: row.mergeOutcomeRef };
}

/**
 * A delivery row → one member of the work item's DELIVERY SET (Story MOTIR-3655 ·
 * MOTIR-3697).
 *
 * The pull-request half goes through {@link toLinkedPullRequestDto} UNCHANGED, so
 * a member's title fallback, merged/closed collapse, link-out URL and — the one
 * that matters — its CI verdict are literally the values the Development surface
 * renders, produced by the same call. Not a parallel mapping that agrees today.
 *
 * The delivery row's own `repo` is what the pull request's context needs: `repoId`
 * is written from the pull request's repository when the link is recorded, so the
 * two are the same row and joining twice would only give the reader a way to see
 * them disagree.
 */
export function toWorkItemDeliveryDto(
  row: WorkItemDeliveryWithChecks,
  /** The pull request's STANDING queue failure, when the caller read one
   *  (`standingQueueFailures`, MOTIR-5720) — the exit row itself, mapped here. */
  standingExit: {
    rawReason: string;
    disposition: 'failure' | 'neutral' | 'landed';
    headSha: string;
    failingCheckName: string | null;
    failingCheckUrl: string | null;
    failingCheckConclusion: string | null;
  } | null,
  /** The pull request's STANDING host merge refusal, when the caller read one
   *  (`standingMergeRefusals`, MOTIR-6735) — the refusal row itself, mapped here. */
  standingRefusal: {
    code: string;
    reason: string | null;
    headSha: string;
    refusedAt: Date;
  } | null,
): WorkItemDeliveryDto {
  return {
    pullRequest: toLinkedPullRequestDto({
      ...row.pullRequest,
      repo: row.repo,
      checkRuns: row.pullRequest.checkRuns,
    }),
    defaultBranch: row.repo.defaultBranch,
    baseRef: row.pullRequest.baseRef,
    queueExit:
      standingExit === null
        ? null
        : {
            rawReason: standingExit.rawReason,
            disposition: standingExit.disposition,
            headSha: standingExit.headSha,
            failingCheckName: standingExit.failingCheckName,
            failingCheckUrl: standingExit.failingCheckUrl,
            failingCheckConclusion: standingExit.failingCheckConclusion,
          },
    mergeRefusal:
      standingRefusal === null
        ? null
        : {
            code: standingRefusal.code,
            reason: standingRefusal.reason,
            headSha: standingRefusal.headSha,
            refusedAt: standingRefusal.refusedAt.toISOString(),
          },
  };
}

/**
 * A candidate PR row → the explicit-link picker's display shape (Story 7.10 ·
 * MOTIR-1596, design/github Panel 5b). Same title fallback + merged collapse as
 * the linked-row DTO.
 *
 * `linkedTo` arrives as a SEPARATE ARGUMENT rather than off the row (MOTIR-3756):
 * the identifiers are the pull request's DELIVERY SET, which is a second table and
 * a batched read the service owns, not an `include` this mapper can reach. Callers
 * exclude candidates already delivering the current item, so no member is ever the
 * item being edited.
 *
 * The argument is required rather than defaulted to `[]`, because the empty array
 * is a real answer ("this pull request delivers nothing") and a caller that forgot
 * to pass the set would render exactly that answer, silently.
 */
export function toPullRequestLinkCandidateDto(
  row: GithubPullRequestCandidate,
  linkedTo: readonly string[],
): PullRequestLinkCandidateDto {
  return {
    id: row.id,
    title: row.title ?? row.headRef,
    repo: `${row.repo.owner}/${row.repo.name}`,
    number: row.number,
    state: row.merged ? 'merged' : row.state === 'open' ? 'open' : 'closed',
    linkedTo: [...linkedTo],
  };
}

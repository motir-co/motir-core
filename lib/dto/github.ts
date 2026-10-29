import type { UsingProjectDto } from '@/lib/dto/organizationRepos';

// DTOs for the GitHub integration (Story 7.10 · MOTIR-1498). What crosses the
// API boundary for a member's GitHub identity — deliberately WITHOUT the access
// token (encrypted or not): the token never leaves the service layer.

export interface GithubIdentityDTO {
  id: string;
  /** The GitHub numeric user id, as a string (GitHub ids exceed 2^53 headroom
   *  concerns are avoided by never doing math on it). */
  githubUserId: string;
  githubLogin: string;
  avatarUrl: string | null;
  createdAt: string;
  /** GitHub refused to renew this sign-in (`refresh_refused_at` is set — Bug
   *  MOTIR-10021): it is dead until the member reconnects, and the account Git
   *  pane renders its *Needs re-auth* state (Bug MOTIR-10047). A boolean, never
   *  the timestamp or anything about the token behind it. */
  needsReauth: boolean;
}

// The installation grant (MOTIR-891) — "Grant 2". What crosses the API boundary
// for a workspace's GitHub App installation + its selected repos. Like the
// identity DTO, it deliberately carries NO token: the installation access token
// is minted on demand and never leaves the service layer.

export interface GithubRepoDTO {
  id: string;
  /** GitHub's numeric repository id, as a string. */
  repoId: string;
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface GithubInstallationDTO {
  id: string;
  /** Provider discriminator — `'github'` for these rows. */
  provider: string;
  /** GitHub's numeric installation id, as a string. */
  installationId: string;
  accountLogin: string;
  accountType: string;
  repos: GithubRepoDTO[];
  createdAt: string;
}

/** One GitHub account the Motir App is installed on, as an organisation admin
 *  can connect it (Story MOTIR-8216 · MOTIR-8220). Built from what GitHub says
 *  the ACTOR can access, never from stored rows. */
export interface GithubAccountForOrganizationDTO {
  installationId: string;
  accountLogin: string;
  accountType: string;
  avatarUrl: string | null;
  /** How many repositories the App can see on the account; null when GitHub
   *  could not say. */
  visibleRepoCount: number | null;
  linkState: 'not_linked' | 'linked_here';
}

export type GithubAccountsForOrganizationDTO =
  | { state: 'ok'; accounts: GithubAccountForOrganizationDTO[] }
  | {
      state: 'identity_required';
      /** `refused` — a linked identity exists, but GitHub no longer accepts its
       *  token (Bug MOTIR-8984); absent — no linked identity at all. */
      reason?: 'refused';
    };

/** One account's repositories as this organisation may claim them. A repository
 *  `connected_elsewhere` carries no identifier of who owns it. */
export interface GithubAccountRepositoriesDTO {
  repos: {
    repoId: string;
    fullName: string;
    availability: 'available' | 'connected_here' | 'connected_elsewhere';
  }[];
  counts: { available: number; connectedHere: number; connectedElsewhere: number };
}

/**
 * One linked pull request on a work item's "Development" surface (Story 7.10
 * · MOTIR-1579, design/github Panels 3 + 4a + 5a) — rendered on BOTH the
 * quick-view peek and the detail page. Display-ready: the title fallback,
 * merged/closed collapse, per-PR CI derivation, and link-out URL are all
 * resolved server-side so the client stays purely presentational.
 */
export interface LinkedPullRequestDto {
  /**
   * Motir's own id for the pull-request row (MOTIR-5005) — what the REMOVE
   * control addresses the delivery by.
   *
   * `githubPullRequestService.unlinkPullRequest` takes the internal cuid rather
   * than GitHub coordinates, and its own header says why: *"the item page
   * addresses a pull request by Motir's internal cuid because it is rendering a
   * row it already read"*. That row is this DTO, and until this card it was the
   * one thing the row did not carry — so the surface the service was written for
   * could not call it.
   */
  id: string;
  /** The PR title, falling back to its head branch for rows ingested before
   *  title capture (MOTIR-1579). */
  title: string;
  /** `owner/name` — the pr-meta line's repo half. */
  repo: string;
  number: number;
  /** Display state: `merged` wins over the raw open/closed pair. */
  state: 'open' | 'merged' | 'closed';
  /** Per-PR CI at its latest recorded commit (lib/github/prCiState) — null
   *  renders NO CI pill (absence of CI is not a state). */
  ci: 'passing' | 'failing' | 'running' | null;
  /**
   * The pull request's HEAD sha by the same rule `ci` is formed over — the latest
   * recorded check-row sha (lib/github/prCiState) — or null before any check has
   * reported. Carried for the approve-to-merge frame, which names the member a push
   * moved when its question is withdrawn. It used to borrow that head from HOW TO
   * TEST's per-repository read, which only knew the pull requests the record had a
   * section for; a pull request's head is the pull request's fact, so it lives on
   * its row (`design/github/design-notes.md` § 25; MOTIR-5691).
   */
  headSha: string | null;
  /** The GitHub link-out (`https://github.com/<owner>/<name>/pull/<n>`). */
  url: string;
  /**
   * WHAT THIS PULL REQUEST'S REVIEW ON GITHUB SAYS (Story MOTIR-4910 · MOTIR-5602;
   * `docs/decisions/approval-gates.md` §8 FOURTH AMENDMENT, decision 2; design
   * `design/github/design-notes.md` § 23, Panels G1–G3).
   *
   * Null when nothing countable has been said: no reviews, only `commented` ones, only
   * dismissed ones, or only reviews from somebody who cannot write. Absence of a review is
   * not a state, exactly as `ci: null` renders no CI pill.
   *
   * ⚠️ `atCurrentHead: false` IS DRAWN, NOT DROPPED. A review given at an earlier commit
   * counts for nothing (decision 2), but a reader who can see that an approval exists and
   * cannot see that it is stale would conclude Motir had lost it. The surface says which.
   *
   * ⚠️ IT NAMES NO REVIEWER, and that is a DECISION rather than an omission (Yue, design
   * review 2026-09-17; design § 23). This carried `reviewerLogin` and `memberName` until the
   * row's chip was drawn — and a pull request can have SEVERAL reviewers, so ONE identity per
   * row is the wrong cardinality whatever renders it: it would carry whichever countable
   * review happened to be latest and read as though that person were *the* reviewer. The row
   * says what the pull request's review STATE is. The DECISION has exactly one decider, and
   * the gate's own `decidedById` / `decidedByLabel` carry them. A surface that later wants
   * reviewers on a row asks for a LIST, not for this field back.
   */
  githubReview: {
    state: 'approved' | 'changes_requested';
    atCurrentHead: boolean;
  } | null;
  /**
   * The branch the pull request TARGETS (MOTIR-5916; design/github § 30). Null on a row
   * mirrored before base branches were recorded — the copy then says *its base branch*,
   * never a guessed `main`.
   */
  baseRef: string | null;
  /**
   * The host reports this pull request CONFLICTED with its base at its current head
   * (MOTIR-5913's stored reading, read by `lib/github/mergeability.ts`'s one rule). What
   * the row's *Conflicts with {base}* pill and the withdrawn band's `conflict` arm draw.
   * `false` for an unknown reading — "not computed" is never a conflict (§ 30 Panel 6).
   */
  conflicted: boolean;
  /* ⚠️ `linkedManually` WAS HERE and is removed by MOTIR-4894, along with the
   * "linked manually" suffix it fed. It said the link was DECLARED rather than
   * inferred by the MOTIR-892 auto-resolver, and MOTIR-3674 deleted that
   * resolver: every association a pull request has is declared now, so the flag
   * was true of every row and told a reader nothing. The column survives one
   * more release (MOTIR-4894 is phase 1 of
   * `docs/decisions/delivery-reader-migration.md` §6a) but nothing in
   * application code reads or writes it, and this DTO is the surface it reached
   * the client through. */
}

/**
 * One candidate PR for the explicit item→PR link picker (Story 7.10 ·
 * MOTIR-1596, design/github Panel 5b) — a workspace-ingested PR the "+ Link pull
 * request" Combobox offers. `id` is the internal `GithubPullRequest.id` (the
 * link target the Server Action takes).
 */
export interface PullRequestLinkCandidateDto {
  /** Internal `GithubPullRequest.id` — the value the link action receives. */
  id: string;
  /** The PR title, falling back to its head branch (pre-title-capture rows). */
  title: string;
  /** `owner/name` — the option meta line's repo half. */
  repo: string;
  number: number;
  /** Display state: `merged` wins over the raw open/closed pair. */
  state: 'open' | 'merged' | 'closed';
  /** The identifiers (`MOTIR-<n>`) of every work item this pull request already
   *  DELIVERS, oldest link first — the neutral chip in the option's trailing slot
   *  (MOTIR-3756, ADR `docs/decisions/delivery-reader-migration.md` §3).
   *
   *  A SET rather than the one item a singular FK named, because one pull request
   *  delivering several cards is the ordinary shape of a `motir auto` run. The
   *  renderer reads its LENGTH: empty → the PR-state pill; exactly one → the
   *  unchanged "Linked to {key}" copy; two or more → "Delivers {count} work
   *  items". Candidates already delivering the CURRENT item are dropped by the
   *  service, so no member is ever the item being edited.
   *
   *  ⚠️ The chip is INFORMATION, not a takeover warning: picking a candidate ADDS
   *  a delivery row (`work_item_delivery`), it does not move an existing one. */
  linkedTo: string[];
}

/**
 * ONE MEMBER of a work item's DELIVERY SET (Story MOTIR-3655 · MOTIR-3697, ADR
 * `docs/decisions/work-item-delivery-links.md`) — one pull request that delivers
 * this card, with everything a reader needs to say whether it has ARRIVED.
 *
 * ── Why the pull request is NESTED rather than flattened ───────────────────
 * `pullRequest` is the SAME {@link LinkedPullRequestDto} the Development surface
 * already renders, carried whole. Flattening it would mean a second spelling of
 * `ci` and of the merged/closed collapse on the same pull request, and two
 * spellings of one answer is the defect this whole story is about — one level
 * up, at the schema. So `merged` is `pullRequest.state === 'merged'` and the CI
 * verdict is `pullRequest.ci`; there is no copy of either here.
 *
 * ⚠️ `ci` therefore comes from `derivePrCiState` and from nothing else. It is
 * the one verdict `ciPromotion` reads and the one the Development pill shows, so
 * a lane that watches CI through this DTO cannot drift from what a person sees
 * (MOTIR-3685's own acceptance criterion forbids a second one).
 *
 * ── What the two extra fields are FOR ─────────────────────────────────────
 * `baseRef` and `defaultBranch` exist so a consumer can tell the three shortfall
 * kinds `lib/workItems/deliverySet.ts` computes apart without a second round
 * trip: OUTSTANDING (not merged), STRANDED (merged onto a base that is not its
 * repository's default branch — a merge that delivered nothing to the trunk) and
 * UNKNOWN (merged with no base recorded). The comparison is PER REPOSITORY and
 * never against a hard-coded `'main'`: a self-hoster's trunk is `master` or
 * `trunk`, and a card spanning two repositories may face two different names.
 */
export interface WorkItemDeliveryDto {
  /** The delivering pull request, in the shape every other surface renders it. */
  pullRequest: LinkedPullRequestDto;
  /** That pull request's OWN repository's default branch — the branch a merge
   *  has to reach for the delivery to count. */
  defaultBranch: string;
  /** The branch the pull request TARGETS. Null on a row mirrored before Motir
   *  recorded base branches, which is the UNKNOWN kind: whether the work reached
   *  the trunk cannot be told, and the remedy is an operator backfill rather
   *  than a merge. */
  baseRef: string | null;
  /** The STANDING merge-queue failure on this pull request — its latest exit is a
   *  failure, not re-queued, at its current head (`queueExitHoldsAtHead`) — or null
   *  (Story MOTIR-5628 · MOTIR-5720). The SERVER decides "standing", so a reader
   *  holds no head logic: `ci` stays the pull request's own checks, and a member
   *  with `ci: 'passing'` and a set `queueExit` is failing in the queue. */
  queueExit: DeliveryQueueExitDto | null;
  /** The STANDING refusal the HOST gave when Motir pressed merge on this pull request
   *  — not superseded, at its current head, while it is open — or null (Bug
   *  MOTIR-6735). `reason` is the host's own message, which for a `branch_protected`
   *  refusal is the only thing naming the setting that refused it. */
  mergeRefusal: DeliveryMergeRefusalDto | null;
}

/** Why the host refused a merge Motir pressed on a delivering pull request. */
export interface DeliveryMergeRefusalDto {
  /** The seam's refusal code, verbatim — `branch_protected`, `conflict`, … */
  code: string;
  /** The host's own message, verbatim; null when it gave none. */
  reason: string | null;
  /** The head the press was made against, which is still the pull request's head. */
  headSha: string;
  refusedAt: string;
}

/** Why the merge queue threw a delivering pull request out. */
export interface DeliveryQueueExitDto {
  /** GitHub's own reason — `CI_FAILURE`, `MERGE_CONFLICT`, … */
  rawReason: string;
  /** The STORED disposition, which a `CI_FAILURE` / `CI_TIMEOUT` exit's class follows
   *  (§4 SIXTH AMENDMENT, MOTIR-6847). */
  disposition: 'failure' | 'neutral' | 'landed';
  /** The head the queue tested, which is still the pull request's head. */
  headSha: string;
  /** The queue's failing check; both null when none is known (a conflict). */
  failingCheckName: string | null;
  failingCheckUrl: string | null;
  /** That check's RAW GitHub conclusion, null when none is known (MOTIR-6846). */
  failingCheckConclusion: string | null;
}

/**
 * A pull request's MERGE RECORD (Story MOTIR-4882 · MOTIR-5520) — what authorised a
 * merge Motir performed, and what it produced. Both `null` means Motir did not merge
 * it: a person merged it on the host, or nobody has.
 *
 * Deliberately NOT a field on {@link LinkedPullRequestDto}: the Development surface
 * renders nothing from it, and the reader it exists for — matching a merge-queue
 * ejection to the entry Motir created (MOTIR-5461) — is server-side.
 */
export interface PullRequestMergeRecordDto {
  /** `gate` — a person approved the merge gate; `auto_mode` — the project's merge
   *  mode authorised it, with no person in the loop. */
  mergeAuthority: 'gate' | 'auto_mode' | null;
  /** The merge commit SHA, or `queue:<entryId>` for an enqueue. */
  mergeOutcomeRef: string | null;
}

// Disconnecting a GitHub account from ONE organisation (MOTIR-8222). The
// preview is read by the Git room's client-side dialog, so it lives here rather
// than in the service module a client component may not import.

export interface AccountDisconnectRepoDto {
  /** The internal `GithubRepo.id`. */
  githubRepoId: string;
  /** `owner/name`. */
  repoRef: string;
}

export interface AccountDisconnectPreviewDto {
  accountLogin: string;
  accountType: string;
  repos: AccountDisconnectRepoDto[];
  /** The LIVE projects the viewer may browse that use one of these repos. */
  projects: UsingProjectDto[];
  /** How long the code graph is kept after the disconnect, in days. */
  retentionWindowDays: number;
}

export interface AccountDisconnectResultDto {
  releasedRepos: string[];
  clearedLinks: number;
  /** True when this was the last organisation linked, so the row went too. */
  installationRemoved: boolean;
}

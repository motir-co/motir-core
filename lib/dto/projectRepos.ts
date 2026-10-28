// DTO types for the project REPOSITORY SET (Story MOTIR-1775 · MOTIR-1780) — the
// shape that crosses the API boundary. No Prisma row leaks: the Prisma
// `ProjectRepoRole` / `ProjectRepoState` / `ProjectRepoOwnership` enums become
// string unions and every `Date` becomes an ISO string. The establish-step UI
// (MOTIR-1782), the derivation (MOTIR-1881) and the dispatch resolver
// (MOTIR-1783) bind to these.

import type { HostingSize, HostingTarget, HostingUseCase } from '@/lib/hosting/vocabulary';

/** Wire form of the Prisma `ProjectRepoRole` enum (ADR §1.1). */
export type ProjectRepoRoleDto = 'web' | 'api' | 'mobile' | 'shared' | 'infra' | 'other';

/** Wire form of the Prisma `ProjectRepoState` enum (ADR §4.1). */
export type ProjectRepoStateDto =
  | 'proposed'
  | 'creating'
  | 'created'
  | 'connected'
  | 'skipped'
  | 'failed';

/** Wire form of the Prisma `ProjectRepoOwnership` enum (ADR §3). */
export type ProjectRepoOwnershipDto = 'user' | 'motir';

/** Wire form of the Prisma `ProjectRepoTakeoverState` enum (MOTIR-711) — where a
 *  row sits in the handoff to the user's own GitHub. */
export type ProjectRepoTakeoverStateDto =
  | 'requested'
  | 'transfer_pending'
  | 'awaiting_reinstall'
  | 'done'
  | 'failed';

/**
 * The TAKE-IT-OVER saga's state on one row (MOTIR-711), or `null` on the
 * `ProjectRepoDto` when no handoff has ever been requested.
 *
 * The two middle states are WAITS ON A HUMAN acting on github.com — accepting the
 * transfer, installing the App — so a consumer must render them as durable,
 * re-promptable steps with something to go do, never as a spinner.
 */
export interface ProjectRepoTakeoverDto {
  state: ProjectRepoTakeoverStateDto;
  /** The GitHub login the repository is being handed to. */
  targetOwner: string | null;
  requestedAt: string | null;
  /** When the repository actually moved (the `transferred` webhook), not when it
   *  was asked for. Null while awaiting the new owner's accept. */
  transferredAt: string | null;
  /** When the App was observed installed under the new owner — the proof the loop
   *  survived. A completed transfer alone never sets this. */
  completedAt: string | null;
  failureReason: string | null;
}

/**
 * WHY a proposed row is in the set — the ADR §0.1 signal that produced it, in
 * ladder order (MOTIR-1892). Persisted on the row so the establish-step UI
 * (MOTIR-1782) can show what Motir inferred on a LATER page load, not only in
 * the proposal run's own result.
 *
 * MACHINE-READABLE on purpose, and the persisted value is this signal ALONE.
 * `ProposedRepoRow.reason` — the derivation's one-line English gloss — is a log
 * / PR-output fallback and is NOT a localized string; persisting it would put
 * untranslated prose on a rendered surface, which the i18n-catalog parity gate
 * exists to prevent. The UI maps this key to its own copy.
 *
 *   * `plan-item-role`   §0.1.1 — a repo ROLE pinned on the generated tree.
 *   * `preplan-platform` §0.1.2 — the pre-plan session's `platform`.
 *   * `default-web`      §0.1.4 — the thin-signal default: exactly one web row.
 *
 * The runtime list is `PROJECT_REPO_PROPOSAL_SIGNALS` in
 * `lib/projectRepos/vocabulary.ts`, which is what the service validates against;
 * `RepoProposalSignal` in `lib/projectRepos/proposal.ts` is this same type under
 * the derivation's own name.
 */
export type ProjectRepoProposalSignalDto = 'plan-item-role' | 'preplan-platform' | 'default-web';

/**
 * Whether the user can REACH the repository behind a row (MOTIR-1900).
 *
 * A repository Motir creates lives in Motir's own org and is private, so the
 * person who approved the plan cannot clone it until Motir invites their GitHub
 * account as an admin collaborator. This is that invitation's state — DERIVED
 * from the row's two `collaborator_*` stamps by `lib/projectRepos/access.ts`,
 * never stored as its own column.
 *
 * ⚠️ ORTHOGONAL to `state`, by construction: `state` says whether the repository
 * EXISTS, this says whether the user can get INTO it, and neither can fail the
 * other. An invitation failure leaves a `created` row `created` (the repository
 * is real and nothing is rolled back); a `skipped` row has nothing to be invited
 * to and simply stays `not_invited`.
 *
 *   * `accepted`    — the account is a collaborator and can clone and push.
 *   * `invited`     — an invitation is pending on GitHub, waiting to be accepted.
 *   * `not_invited` — none has been sent. On a `created` row that is the state
 *     the connect prompt exists to resolve; on any other row it is simply the
 *     absence of a question.
 */
export type ProjectRepoAccessStateDto = 'not_invited' | 'invited' | 'accepted';

/**
 * What a collaborator may DO with the repository (MOTIR-1910; ADR §3 Q2).
 *
 * PER INVITEE. A teammate gets `push` — clone, branch, push; the approving user
 * keeps `admin`, which additionally carries the repository settings the TAKEOVER
 * path (MOTIR-711) needs and that only they walk.
 */
export type ProjectRepoCollaboratorPermissionDto = 'push' | 'admin';

/**
 * Why a member cannot be invited, or null when they can (MOTIR-1910).
 *
 * The two reasons are distinct because they have different OWNERS, and a consumer
 * must render them differently:
 *
 *   * `role_cannot_edit`   — the product's own access policy does not let this
 *     person change the project (`canEdit`), so it does not hand them its code.
 *     SETTLED: nothing on this surface moves it, only a role change elsewhere.
 *   * `no_github_identity` — they have no connected GitHub account, so there is
 *     no account to invite. ACTIONABLE, but by THAT MEMBER ALONE: Motir cannot
 *     OAuth on anyone's behalf, so a teammate viewing this row gets an
 *     explanation and never a button (ADR §3 Q3).
 */
export type ProjectRepoMemberAccessReasonDto = 'role_cannot_edit' | 'no_github_identity' | null;

/**
 * ONE member's access to ONE repository of the project's set (MOTIR-1910) — the
 * row the team code-access surface (MOTIR-1945) renders.
 *
 * Every candidate member appears, INCLUDING the ones who cannot be invited: a
 * surface that silently omitted them would answer "who has access?" with a list
 * that quietly excludes the people the reader is most likely looking for. The
 * `reason` is what makes each absence legible.
 */
export interface ProjectRepoMemberAccessDto {
  /** The Motir user — the invitation is aimed at a person, never a typed handle. */
  userId: string;
  name: string;
  email: string;
  /**
   * Whether this member is in the invitable set — exactly the members the shipped
   * project-access policy's `canEdit` admits (ADR §3 Q1), which is the same rule
   * the product enforces for changing anything else in the project.
   */
  eligible: boolean;
  /**
   * The GitHub login that HOLDS (or was offered) the access, when a record
   * exists; otherwise the member's currently connected login; null when they have
   * neither.
   *
   * The record's snapshot WINS over the live identity on purpose: if a member
   * reconnects a different GitHub account, the invitation live on GitHub still
   * belongs to the old one, and the row must say which account actually has
   * access rather than which one they happen to have connected today.
   */
  login: string | null;
  /** What was granted, or null when no invitation record exists yet. */
  permission: ProjectRepoCollaboratorPermissionDto | null;
  /** Where this member stands. `not_invited` covers both "no record at all" and
   *  "a record whose invitation never went out" — indistinguishable to a reader,
   *  and identically resolved by inviting. */
  state: ProjectRepoAccessStateDto;
  /** Why they cannot be invited, or null when nothing is in the way. Independent
   *  of `state`: an INELIGIBLE member who was invited before their role changed
   *  keeps their real `accepted` state and gains a reason. */
  reason: ProjectRepoMemberAccessReasonDto;
  /** Where **Open the invitation** points, for a PENDING invitation only. */
  invitationUrl: string | null;
  invitedAt: string | null;
  acceptedAt: string | null;
}

/**
 * The team's access to ONE repository of the set (MOTIR-1910).
 *
 * Carried per repository rather than per member because access is GRANTED per
 * repository — a partially-established set has real repositories some members can
 * reach and rows that do not exist yet, and flattening that would report a
 * half-truth for both.
 */
export interface ProjectRepoTeamAccessRowDto {
  /** The `ProjectRepo.id` this access belongs to. */
  rowId: string;
  /** `owner/name` of the realized repository, for a surface that names it. Null
   *  on a row with no repository yet. */
  repoRef: string | null;
  /**
   * Whether this row can hold invitations at all — a `created` row with a live
   * realized repository. False for `connected` (the user's own repository, not
   * Motir's to share), `skipped`, `failed`, and anything unestablished.
   */
  invitable: boolean;
  members: ProjectRepoMemberAccessDto[];
}

/** The whole team-access read for a project (MOTIR-1910) — every repository of
 *  the set crossed with every candidate member, in one call, so a surface renders
 *  the matrix without an N+1 per row. */
export interface ProjectRepoTeamAccessDto {
  projectId: string;
  rows: ProjectRepoTeamAccessRowDto[];
}

/** What one team-access invite pass DID — the counts a surface reports and the
 *  rows it re-renders from. */
export interface GrantTeamAccessResultDto {
  access: ProjectRepoTeamAccessDto;
  /** How many `(repository × member)` invitations this pass sent or re-sent. */
  invited: number;
  /** How many GitHub refused. Their records are unchanged and stay retryable —
   *  nothing is rolled back, and no sibling is affected. */
  failed: number;
  /** How many eligible members were skipped for want of a connected GitHub
   *  account. Not a failure: it is the state their own connect prompt resolves. */
  skippedNoIdentity: number;
}

/** The access half of a row — its state plus the two facts the UI renders. */
export interface ProjectRepoAccessDto {
  state: ProjectRepoAccessStateDto;
  /**
   * The GitHub login that was invited, or null when none has been. Recorded at
   * invite time rather than re-derived from the reader's own identity: a LATER
   * visitor must see which account actually got access, not be told about theirs.
   */
  login: string | null;
  /** Where **Open the invitation** points, for a PENDING invitation only. Null
   *  once accepted (the invitation no longer exists) and null when the account
   *  already had access, which produces no invitation at all. */
  invitationUrl: string | null;
}

/**
 * The REALIZED repository behind a set row — the connected `GithubRepo` mirror
 * row, present only once creation or connect-existing has completed.
 *
 * `name` here is AUTHORITATIVE for a checkout: it is the host's own casing, which
 * is what `work_item.targetRepo` stores and the CLI keys `<root>/<name>` on. It
 * can legitimately differ from the row's authored `name` (someone renamed the
 * repo on the host), which is precisely why the two are carried separately rather
 * than the row's `name` being overwritten.
 */
export interface RealizedProjectRepoDto {
  /** Internal `GithubRepo.id` (a cuid) — the FK the creation primitive attached. */
  id: string;
  /** The git-provider discriminator (`"github"` / `"gitlab"` — the GitProvider seam). */
  provider: string;
  owner: string;
  name: string;
  /** `owner/name` — the display form the GitHub surfaces + `resolveCodeContext` use. */
  repoRef: string;
  defaultBranch: string;
  /**
   * Whether the repository is ARCHIVED on the host (MOTIR-1959) — read-only, so
   * no branch or pull request can be opened against it and every item resolving
   * to it is undispatchable until someone un-archives it.
   *
   * It belongs on `realizedRepo` and not beside `state` for the reason this
   * object exists at all (see {@link ProjectRepoDto}): `state` records what
   * HAPPENED to the row, `realizedRepo` records what is true of the repository
   * NOW — and archiving is something the repository's owner does long after the
   * row settled. A `created` row whose repo is archived is not a failed
   * establishment; it is a settled row whose repository stopped accepting writes.
   */
  archived: boolean;
}

/**
 * One row of a project's repository set as it crosses the API boundary.
 *
 * `realizedRepo` is the honest signal of whether the repository EXISTS right now,
 * and it is separate from `state` on purpose. `state` records what HAPPENED (this
 * row was created / connected / skipped / failed); `realizedRepo` records what is
 * true NOW. They can legitimately disagree in exactly one direction: a row that
 * was `created` or `connected` whose `GithubRepo` mirror row has since been
 * deleted (the installation was reconfigured, the repo disconnected) carries a
 * settled state with `realizedRepo: null` — a disconnected repo is not a lost
 * plan, and `established` is what a consumer should branch on.
 */
export interface ProjectRepoDto {
  id: string;
  projectId: string;
  role: ProjectRepoRoleDto;
  /** The free-form label distinguishing repeated roles (`api` + "billing"). */
  label: string | null;
  /** The authored/intended repo name — editable until the row is established. */
  name: string;
  seedSource: string;
  state: ProjectRepoStateDto;
  failureReason: string | null;
  /**
   * WHY Motir proposed this row (ADR §0.1), or NULL when nothing inferred it —
   * a row the USER added has no Motir inference to explain, and so does every
   * row that predates MOTIR-1892. NULL is therefore the honest answer, not a
   * gap: a consumer renders the derivation only where one exists.
   *
   * Survives a user's edit of the row: the signal records what Motir inferred
   * at proposal time, and renaming a row (or changing its role) does not
   * rewrite that history.
   */
  proposalSignal: ProjectRepoProposalSignalDto | null;
  /** The connected repository this row realizes, or null when it has none yet
   *  (or no longer has one — see the type doc). */
  realizedRepo: RealizedProjectRepoDto | null;
  /**
   * Whether this row names a repository that EXISTS — `state` is `created` or
   * `connected` AND the realized repo is still present. Derived here so no
   * consumer re-implements the two-part rule and none of them can drift from
   * `resolveProjectRepoNames`, which filters on exactly this.
   */
  established: boolean;
  /** Where this row sits in the TAKE-IT-OVER handoff (MOTIR-711), or null when
   *  none has ever been requested — which is the common case, and is why this is
   *  nullable rather than an "idle" state the surface would have to hide. */
  takeover: ProjectRepoTakeoverDto | null;
  /** Whether the user can REACH this row's repository, and via which account
   *  (MOTIR-1900). Always present — `not_invited` is the honest answer for a row
   *  nobody has been invited to, including every row that predates this card. */
  access: ProjectRepoAccessDto;
  /**
   * Where this Motir repo's app runs, what it is for and how big it is
   * (MOTIR-9808) — the one home the deploy port and seed matching read. Each is
   * NULL until the plan's hosting decision or build directly sets it, and stays
   * NULL forever on a customer (`organization`) row, which Motir never hosts.
   */
  hostingTarget: HostingTarget | null;
  hostingUseCase: HostingUseCase | null;
  hostingSize: HostingSize | null;
  /** Fractional order key. The FIRST row of the ordered set is the project's
   *  PRIMARY repo (ADR §1.3); order carries no dispatch meaning. */
  position: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A project's repository set plus the SET-level ownership decision (ADR §3.2 /
 * §3.4) — one read, because a consumer that has the rows without knowing whose
 * account they live in cannot render or transfer them. `ownership` /
 * `targetAccount` are null until the establish step decides.
 */
export interface ProjectRepoSetDto {
  projectId: string;
  rows: ProjectRepoDto[];
  ownership: ProjectRepoOwnershipDto | null;
  targetAccount: string | null;
}

/**
 * A repository the user ALREADY has that a row may be pointed at — one option of
 * the establish step's "Use one of mine" picker (MOTIR-1782).
 *
 * Sourced from the workspace's GitHub INSTALLATION (grant 2), which is the only
 * honest source: the picker must offer exactly the repositories the user granted
 * Motir and nothing else, so "Motir never sees the rest" stays true on screen as
 * well as in the copy. `id` is the internal `GithubRepo.id` the connect action
 * takes — never a host id, so a caller cannot point a row at a repository this
 * workspace has not connected.
 */
export interface ProjectRepoConnectCandidateDto {
  /** Internal `GithubRepo.id` — the value the connect action receives. */
  id: string;
  owner: string;
  name: string;
  /** `owner/name` — the display form the picker shows. */
  repoRef: string;
  defaultBranch: string;
  /** Already claimed by a row of THIS project's set — offered but not selectable
   *  (a repository backs at most one row; the `github_repo_id` unique index is the
   *  real guard, and showing why beats a 409 the user cannot predict). */
  claimed: boolean;
}

/**
 * Everything the establish step renders in ONE read (MOTIR-1782): the set itself
 * plus the two GitHub facts the technical path needs.
 *
 * The GitHub halves are the DEFAULT path's business exactly zero times — nothing
 * on it asks for a permission — so they are carried as plain nullable facts rather
 * than a "grant state": `githubLogin` is grant 1 (identity, present once the actor
 * has connected) and `connectCandidates` is grant 2 (the installation's repos,
 * empty without one). Their absence is what the "I already have code" door hands
 * off to the shipped 7.10 pane FOR; it is never a warning on the main line.
 */
export interface ProjectRepoEstablishViewDto {
  set: ProjectRepoSetDto;
  /**
   * The account a CREATED repository lands in — Motir's own provisioning org
   * (ADR §3 amendment), or null on a deployment that cannot provision at all (a
   * self-hosted instance with no `GITHUB_FALLBACK_ORG`).
   *
   * Rendered as the row's FIXED `owner /` prefix on the technical path, which is
   * the honest form: the owner is not the user's to choose, so it is shown, not
   * offered. Null simply drops the prefix — the row still names the repository,
   * and a create attempt on such a deployment fails with the not-configured
   * reason rather than being pre-empted by a state this design never drew.
   */
  hostOwner: string | null;
  /** The actor's connected GitHub login (grant 1), or null when not connected. */
  githubLogin: string | null;
  /** The actor's GitHub avatar (grant 1), for the shipped `IdentityHeader` the
   *  access step reuses so the user can SEE which account Motir invited
   *  (MOTIR-1900). Null when not connected, or when GitHub had no avatar. */
  githubAvatarUrl: string | null;
  /** Whether the ORGANISATION has a GitHub App connection (grant 2).
   *  ⚠️ THE ORGANISATION, NOT THE WORKSPACE (MOTIR-4838): a repository is
   *  connected once, to the organisation (MOTIR-4669), and the App is installed
   *  from one of its workspaces — so a workspace-keyed read answered `false`
   *  from every sibling workspace of an organisation that IS connected, and the
   *  step offered the technical path to nobody there. */
  hasInstallation: boolean;
  /** The repositories the organisation's connections grant, for the "Use one of
   *  mine" picker — the ones this project already claims MARKED rather than
   *  removed, so the picker never offers a choice that can only 409.
   *  Empty without a connection — the picker then hands off to 7.10. */
  connectCandidates: ProjectRepoConnectCandidateDto[];
}

/**
 * A WORKSPACE-CONNECTED repository that belongs to this project's domain but has
 * no `project_repository` row (MOTIR-3126).
 *
 * ⚠️ NOTHING PRODUCES ONE ANY MORE, AND THE TYPE IS KEPT ON PURPOSE (MOTIR-4998).
 * This was the wire form of the OTHER registry — the repositories the scope ladder
 * LAYERED under the set for a project with no repositories of its own. MOTIR-4955
 * retired that rung (`lib/projectRepos/effectiveDomain.ts` returns `connected: []`,
 * a literal) and MOTIR-4954 stopped the room drawing it, so every list of this
 * shape the product builds today is empty.
 *
 * **Its remaining purpose is to keep that emptiness ASSERTABLE.** It is the element
 * type of `ProjectRepoRoomViewDto.connected`, the compatibility field the room view
 * still carries, and the reason that field is worth carrying is that a test can put
 * a NON-empty list on it and assert the room draws nothing — which is the only way
 * to state *"the retired section stays retired"* as a property rather than as an
 * absence nobody checks. Delete the type and that detector goes with it
 * (`tests/projectRepos/repositoriesRoomOrgSection.test.ts` — *`hostOwner` and
 * `connectedInDomain` change NOTHING now*; `tests/components/repositories-room.test.tsx`
 * — *`connectedInDomain` does not add a section*).
 *
 * So this is a fixture-facing type with one live reader, not an orphan: retiring it
 * is a decision about whether that regression is still worth detecting, and belongs
 * with the card that removes the compatibility field itself.
 *
 * ⚠️ IT IS NOT A `ProjectRepoDto`, and the difference is the point. A set row has a
 * role, a position, a state, a takeover and an access record because Motir created
 * or adopted it; a connected repository has none of those — nobody planned it into
 * this project, and there is nothing to take over because the user already owns it.
 * Giving it a half-filled `ProjectRepoDto` would invite exactly the merged list the
 * room deliberately does not render (design §16.2).
 *
 * Deliberately CARRIES NO ID. Both sources this shape ever had — the room's server
 * read (`ConnectedRepoName`, which has no `GithubRepo.id`) and the establish view's
 * `connectCandidates` (which does) — agreed on `repoRef`, and `owner/name` is unique
 * per host, so it is the identity a consumer keys on. Carrying an id that only one
 * source can supply would make the two disagree about what a row IS.
 */
export interface ProjectRepoConnectedDto {
  /** The bare repository NAME — the same spelling a `targetRepo` pin stores. */
  name: string;
  /** `owner/name` — the display form, and this shape's identity. */
  repoRef: string;
  /** The branch an agent would work from, or null when Motir does not know it. */
  defaultBranch: string | null;
}

/**
 * Another project in the same workspace whose code Motir also hosts — one entry
 * of the takeover room's paused banner (MOTIR-1939).
 *
 * ⚠️ IT EXISTS TO CLOSE A SCOPE GAP, not to decorate. The billing panel's
 * `Move repositories` door is ORG-scoped, but a takeover is per ROW and rows
 * belong to a PROJECT — so a user who arrives from billing must be told, in
 * words, that moving this project's repositories does not move the others'.
 * Carrying the other projects as LINKS is what keeps the ADR's "ONE decision
 * surface, N pointers" shape intact (design §14.4).
 */
export interface OtherHostedProjectDto {
  id: string;
  /** The project's workspace-unique key ("MOTIR") — the settings deep link. */
  identifier: string;
  name: string;
}

/**
 * Everything the TAKE-IT-OVER room renders in ONE server read (MOTIR-1939) —
 * `/settings/project/repositories`, the surface the ownership promise's door and
 * the billing panel's `Move repositories` button both land on.
 *
 * It is a READ MODEL, deliberately: the saga itself is MOTIR-711's and nothing
 * here performs a step of it. The room composes the set, the actor's GitHub
 * identity, and the org-wide CI truth so the page can be server-rendered and its
 * header updated by `router.refresh()` (the page-state contract, §14.10).
 */
/**
 * Whether MOTIR'S APP can write one connected repository for a hosted run
 * (MOTIR-1895 · `design/repository-set/design-notes.md` §18.1) — the same answer
 * MOTIR-6449's `hostedRunWriteAccess` gives the start path, so the room and a
 * refused run cannot disagree.
 *
 * - `ready`             — the installation covers it and has accepted write.
 * - `needs_permissions` — it has not accepted `contents` + `pull_requests`
 *                         write; an owner of `account` accepts on GitHub.
 * - `unreachable`       — the installation is gone or suspended, or no longer
 *                         includes the repository; it is reconnected on GitHub.
 *
 * Each href is null when this deployment has nowhere to send the reader, and a
 * null href drops the control rather than drawing one that goes nowhere.
 */
export type HostedRunRepoAccessDto =
  | { state: 'ready' }
  | { state: 'needs_permissions'; account: string; reviewHref: string | null }
  | { state: 'unreachable'; repository: string; reconnectHref: string | null };

/** The room's hosted-run lines, keyed by `ProjectRepoDto.id`. A repository with
 *  no entry draws no line — Motir-hosted rows, and a row whose read failed. */
export type HostedRunRepoAccessMapDto = Record<string, HostedRunRepoAccessDto>;

export interface ProjectRepoRoomViewDto {
  projectId: string;
  rows: ProjectRepoDto[];
  /** The account a Motir-CREATED repository sits under, or null on a deployment
   *  that cannot provision. */
  hostOwner: string | null;
  /** The actor's connected GitHub login (grant 1), or null when not connected —
   *  the fact that decides between the picker and MOTIR-1900's connect prompt. */
  githubLogin: string | null;
  githubAvatarUrl: string | null;
  /**
   * Where the `awaiting_reinstall` row's **Install on GitHub** hands off — the
   * SHIPPED App-install screen (`githubAppInstallUrl()`), never a faked in-app
   * repository picker. Null when no App slug is configured (a self-hosted
   * deployment that registered none), which drops the button rather than
   * offering a link to nowhere.
   */
  installHref: string | null;
  /**
   * Whether the organization's CI is PAUSED for want of credits — the banner's
   * whole condition, read from the one service that owns the entitlement state
   * so this surface and the billing panel can never disagree about it.
   */
  ciPaused: boolean;
  /** The OTHER projects in this workspace whose code Motir also hosts. */
  otherHostedProjects: OtherHostedProjectDto[];
  /** Compatibility field for the retired workspace-inheritance section. */
  connected: ProjectRepoConnectedDto[];
  /** Whether the retired workspace-inheritance section is present. Always false. */
  connectedInDomain: boolean;
}

/** Input to `projectRepoSetService.addRow` — appends a row to the end of the set.
 *  `seedSource` defaults from the role via ADR §2's table; `state` is always
 *  `proposed` (nothing is created until the set is confirmed). */
export interface AddProjectRepoInput {
  role: ProjectRepoRoleDto;
  name: string;
  label?: string | null;
  /** Override ADR §2's default for the role — the seam MOTIR-709's starter
   *  registry will use. Omit for the default. */
  seedSource?: string;
  /** The ADR §0.1 signal that produced this row, when Motir's derivation is what
   *  proposed it (MOTIR-1892). OMITTED by every hand-added row — a row the user
   *  added has no inference to record — which is what makes the persisted column
   *  read as "this one was Motir's idea, and here is why". */
  proposalSignal?: ProjectRepoProposalSignalDto;
}

/** Input to `projectRepoSetService.patchRow` — a PARTIAL edit of an unestablished
 *  row (the UI edits the set before executing it). Only the keys present are
 *  written; `label: null` clears the label. */
export interface PatchProjectRepoInput {
  role?: ProjectRepoRoleDto;
  name?: string;
  label?: string | null;
  seedSource?: string;
}

/** Input to `projectRepoSetService.setOwnership` — the SET-level target decision
 *  (ADR §3.2: one choice for the whole set, never per row). */
export interface SetProjectRepoOwnershipInput {
  ownership: ProjectRepoOwnershipDto;
  /** The account login the repositories live under. */
  targetAccount: string;
}

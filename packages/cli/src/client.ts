import { normalizeServerUrl } from './config/userConfig.js';
import type { DesignsResponse } from './designFiles.js';
import { V1Transport } from './transport.js';
import { DispatchRunClosedError } from './errors.js';
import { encodeFilterParam } from './adapters/filterParam.js';
import {
  toActivityAllPage,
  toDispatchItem,
  toPlanOutcome,
  toPlanSession,
  toPlanWithItems,
  toSearchPage,
  toWorkItemCount,
  toCompleteSessionResult,
  toDispatchPrompt,
  toDispatchRunAppended,
  toDispatchRunOpened,
  toDispatchRunView,
  toRunGitCredentials,
  toExpandSubmitResult,
  toScopeClaim,
  toWorkItemClaim,
  toWorkItemRepairClaim,
  toWorkItemContinueClaim,
  toActivityHistoryPage,
  toCommentsPage,
  toProjectList,
  toReadyContainerPage,
  toReadyPage,
  toProjectRepositoryList,
  toSprintList,
  toWhoami,
  toWorkItemDetail,
  UNASSIGNED,
} from './adapters/reads.js';

// The client core — the ONE place the CLI talks to a Motir server. Every command
// speaks to the tenant over the documented public API at `/api/v1` with a PAT
// bearer: a URL and a token are the whole client, there is no session to open,
// and auth failures all funnel into a single `AuthError`.
//
// It used to be an MCP client (story 7.9) and is not one any more — story 11.5
// moved every method onto `/api/v1` and 11.5.6 removed the tool protocol,
// `@modelcontextprotocol/sdk` and the handshake with it. The MCP surface at
// `/api/mcp` is untouched and still serves AGENTS; the CLI is simply no longer
// one of its clients. A test in `test/noSdk.test.ts` keeps it that way.
//
// Each method below names an OPERATION on the generated `/api/v1` document and
// hands the validated body to an adapter in `src/adapters/` — the only place a
// wire type is allowed to be read (ADR Q4).

/** Who a token resolves to: the caller and the workspace it is bound to. */
export interface WhoamiResult {
  user: { id: string; name: string; email: string };
  workspace: { id: string; name: string; slug: string } | null;
}

/** The far end of ONE per-row dependency edge (`WorkItemEdgeSummaryDto`), as the
 * MCP reads project it: `key` is the `<KEY>-<n>` identifier, `status` the raw
 * workflow status key. */
export interface WorkItemEdgeSummary {
  key: string;
  title: string;
  status: string;
}

/** Both directions of the `is_blocked_by` graph around one row
 * (`WorkItemDependencyEdgesDto`). The server promises both arrays are always
 * present — empty, never missing — so nothing branches on ARRAY presence; only
 * the BLOCK itself can be missing, from a server that predates it (below). */
export interface WorkItemDependencyEdges {
  blockedBy: WorkItemEdgeSummary[];
  blocks: WorkItemEdgeSummary[];
}

/**
 * Why every `dependencies` field in this mirror is OPTIONAL — the one place a
 * missing field is a shape the server really can produce.
 *
 * The CLI is versioned and PUBLISHED TO NPM independently of the server it talks
 * to, so a newer CLI routinely meets an OLDER Motir whose reads predate the edge
 * projection. Absent therefore means "this server cannot tell me the graph", and
 * every renderer degrades to the columns it can substantiate rather than drawing
 * a dependency claim it never got or crashing on a field it cannot read.
 */

/** A ready-set row (the `list_ready` `ReadyItemDto`, terminal-relevant fields).
 * Kept loose — the CLI renders, it does not re-validate the server. `key` is the
 * `<KEY>-<n>` identifier; the ready row carries no `type`/`estimate` column (the
 * /ready row is kind · key · title · priority · assignee).
 *
 * `dependencies` is the per-row edge block 7.9.0f / MOTIR-1842 attaches, which
 * `motir ready` renders as its `BLOCKS` column (MOTIR-1845). Optional per the
 * note above. */
export interface ReadyItemSummary {
  key: string;
  kind: string;
  title: string;
  priority: string;
  assignee?: { id: string; name: string } | null;
  dependencies?: WorkItemDependencyEdges;
  /** The runnable container this row groups under in its lane, or `null` when it
   *  stands alone (Story MOTIR-6829). Absent only from a pre-lane server. */
  container?: ReadyContainerSummary | null;
}

export interface ReadyPage {
  items: ReadyItemSummary[];
  nextCursor: string | null;
}

/**
 * A RUNNABLE CONTAINER (Story MOTIR-6829) — a `story`, `task` or `bug` whose
 * every child is childless: the unit `motir run <KEY>` runs as a parent run.
 * `readyLeafCount` of `childCount` is how much of it is ready now.
 */
export interface ReadyContainerSummary {
  key: string;
  kind: string;
  title: string;
  priority: string;
  assignee: { id: string; name: string } | null;
  readyLeafCount: number;
  childCount: number;
}

export interface ReadyContainerPage {
  items: ReadyContainerSummary[];
  nextCursor: string | null;
}

/** The two ready ROW lanes the server serves — the leaves (never bug work) and the
 *  bugs. The third lane, containers, is a different row and has its own reads. */
export type ReadyRowLane = 'leaf' | 'bug';

/** A sprint row (the `list_sprints` `SprintDto`, the fields `motir status` and
 * `motir sprints` render). `sequence` is the sprint's authored order — the
 * table's sort key. `committedPoints` / `committedIssueCount` are the
 * scope-lock baseline stamped at activation (Story 4.4.2), so both are `null`
 * on a sprint that was never started, and `committedPoints` is `null` on a
 * started-but-wholly-unestimated one. */
export interface SprintSummary {
  id: string;
  name: string;
  state: 'planned' | 'active' | 'complete';
  goal: string | null;
  startDate: string | null;
  endDate: string | null;
  sequence: number;
  issueCount: number;
  committedPoints: number | null;
  committedIssueCount: number | null;
}

export interface SprintList {
  sprints: SprintSummary[];
}

/**
 * One repository of a project's set, as `/api/v1/…/repositories` reports it
 * (Story MOTIR-3584 · MOTIR-3586) — everything a client needs to FIND and CLONE
 * one, and nothing about the establish step that produced it.
 *
 * ⚠️ EVERY COORDINATE IS NULLABLE, for TWO different reasons, and a consumer
 * must not collapse them:
 *
 *   * the row names no repository yet (a `proposed` row) — `established: false`;
 *   * it names one whose PROVIDER this build cannot address — `established:
 *     true`, and `cloneUrl` alone is null.
 *
 * `established` is the discriminator to branch on: it is the server's own
 * two-part rule (`state` is `created` or `connected` AND the repository is still
 * connected), published so a client never re-derives it and drifts from what
 * dispatch resolves a checkout with.
 *
 * `name` is the CHECKOUT key — the host's own casing, which is what a
 * `targetRepo` pin stores and what `resolveRepo` keys `<root>/<name>` on. It is
 * NOT the row's authored name.
 */
export interface ProjectRepository {
  /** The `project_repository` row's id — the value a work item's
   *  `targetRepositories` names, so the two can be matched up. */
  id: string;
  role: string;
  /** What distinguishes two rows of a repeated role, or null. */
  label: string | null;
  name: string | null;
  repoRef: string | null;
  cloneUrl: string | null;
  defaultBranch: string | null;
  /** Read-only on the host. Cloned anyway — refusing to BRANCH on one is
   *  dispatch's job, not this read's. */
  archived: boolean;
  state: string;
  established: boolean;
}

/** The whole set, IN ORDER — the first row is the project's PRIMARY repository. */
export interface ProjectRepositoryList {
  repositories: ProjectRepository[];
}

/** One project as `list_projects` reports it (lib/mcp/tools/listProjects.ts,
 * `McpProjectRow`). `key` is exactly what every other tool's `projectKey`
 * argument takes, so a resolved project passes straight on with no field-name
 * translation. */
export interface ProjectSummary {
  key: string;
  name: string;
  accessLevel: string;
}

export interface ProjectList {
  projects: ProjectSummary[];
}

/** A `search_work_items` result row (the `WorkItemListItemDto` subset the CLI
 * renders); `status` is the raw workflow status key.
 *
 * `dependencies` is the SAME block `list_ready` attaches — one seam, two tools
 * (lib/mcp/dependencyEdges.ts) — which `motir sprint` renders as its `BLOCKED BY`
 * / `BLOCKS` columns (MOTIR-1845). Note the key names do NOT follow this row's
 * own vocabulary: an edge's far end is `key` (the `<KEY>-<n>` identifier) even
 * though the row identifies ITSELF as `identifier`. That is the producer's shape
 * (`WorkItemEdgeSummaryDto`), pinned deliberately — a renderer shared with
 * `list_ready`'s rows can only work if both carry the edge block identically. */
export interface SearchItemSummary {
  identifier: string;
  kind: string;
  title: string;
  status: string;
  priority: string;
  dependencies?: WorkItemDependencyEdges;
}

/**
 * One page of search results.
 *
 * ⚠️ NO `total`, and its absence is a DECISION (ADR Amendment 11 Q3 · Amendment
 * 12). A collection either promises a total or it does not; this one does not,
 * because computing one means a `COUNT` under an arbitrary filter on every page
 * of every list. A caller that wants the number asks {@link
 * MotirClient.countWorkItems} for it, which is one request and says what it is.
 */
export interface SearchPage {
  items: SearchItemSummary[];
  nextCursor: string | null;
}

/**
 * IS THIS ROW MINE TO TAKE? — the pickable rule, as a pure function (MOTIR-2427).
 *
 * Two conditions, and both exist because Motir is used by TEAMS. On a
 * single-operator project neither ever fires, which is exactly why the loop
 * shipped without them.
 *
 * 1. **The TO-DO CATEGORY, never a status key.** A project defines its own
 *    statuses, so the rule has to be expressed on the category or it would need
 *    extending every time somebody adds a vocabulary word. Anything in the
 *    in-progress category belongs to whoever moved it there — and that is how a
 *    card at `Planning` leaves circulation for free (MOTIR-2425): nothing here
 *    knows what re-planning is, the card simply left the category.
 * 2. **Unassigned, or assigned to ME.** Someone else's claim is someone else's
 *    work. My own is the interrupted run I am resuming.
 *
 * ⚠️ THE `in_progress`-ASSIGNED-TO-ME CASE IS DELIBERATE, and it is the answer to
 * the resumption question the category rule would otherwise close. Today a
 * killed run leaves its card in progress and the next run picks it up again;
 * under the category rule alone that card is stranded until a human moves it.
 * Someone else's in-progress card is theirs; my own is mine, and an unattended
 * loop that cannot resume its own interrupted work needs a human to continue,
 * which is the opposite of what it is for.
 *
 * ⚠️ THIS IS AN ADVISORY, AND IT NO LONGER STANDS ALONE (MOTIR-2961/MOTIR-3048).
 * It used to be the whole story — the claim that followed was a plain assignment,
 * so two runs starting together both read the same page, saw the row unassigned
 * and took it. That race was documented here as ACCEPTED, for want of a
 * conditional write the server did not offer. The server offers one now:
 * {@link MotirClient.claimWorkItem} is a single locked transaction that
 * re-asserts the to-do category, assigns and transitions, and answers with an
 * OUTCOME. The loser is told it lost, by name.
 *
 * So this function keeps the job it is actually good at and loses the one it
 * never could do. It is a FILTER over a page the server ranked — it keeps a
 * teammate's live card out of a pick, so an unattended loop does not spend a
 * request finding out. It is not, and never was, the thing that makes a claim
 * safe. Do NOT add a re-read before the claim: the claim itself is the check.
 */
export function isPickable(
  item: Pick<DispatchItem, 'status' | 'assigneeId'>,
  ownerId: string,
): boolean {
  const mine = item.assigneeId === null || item.assigneeId === ownerId;
  if (!mine) return false;
  if (item.status.category === 'todo') return true;
  // The resumption carve-out, and it is deliberately narrow: the ONE status a
  // dispatch itself sets, on a card that is already mine. That is what makes it
  // honest — I can only resume what I started, and what I started is in the
  // status this CLI moved it to. Widening it to the in-progress CATEGORY would
  // pick up `in_review` (waiting on a human) and `Planning` (waiting on a
  // re-plan), which is precisely the circulation MOTIR-2425 removed them from.
  return item.status.key === RESUMABLE_STATUS && item.assigneeId === ownerId;
}

/** The status a dispatch moves a card into — and therefore the only one a run
 *  may resume. Kept beside the rule that reads it; `commands/dispatch.ts` sets
 *  it, and a project on a custom workflow surfaces the server's own error. */
const RESUMABLE_STATUS = 'in_progress';

/**
 * The one item a dispatch picks, projected from a ready-collection row.
 *
 * `key` is the `<KEY>-<n>` identifier — the only way the CLI addresses an item
 * (ADR §7), and what the exclusion list holds. `status.key` lets dispatch skip a
 * redundant `todo → in_progress` flip when the item is already in progress.
 */
export interface DispatchItem {
  key: string;
  kind: string;
  title: string;
  priority: string;
  status: { key: string; category: string };
  type: string | null;
  executor: string | null;
  /**
   * WHO HAS IT — null when nobody has claimed it (MOTIR-2427).
   *
   * A run claims what it takes, so on a TEAM this is the difference between
   * "available" and "someone else's live work". It rides the ready row already;
   * carrying it here is what lets the pick decide without a second read.
   */
  assigneeId: string | null;
  /**
   * The assignee's display name, when the row names one (MOTIR-7477) — what a run
   * report says a manual card it skipped is waiting on (`manualWaitingOn`).
   * Optional: an item not read off a ready row carries none.
   */
  assigneeName?: string | null;
  /**
   * READY RELATIVE TO WHAT — the branch this item's dependencies are integrated
   * on, or `null` when it is ready from the trunk (ADR Amendment 17).
   *
   * `motir batch` refuses a non-null row: it opens ONE pull request per item off
   * `main`, and a lineage item's base has not merged.
   */
  inheritedSessionBranch: string | null;
  /**
   * The RUNNABLE CONTAINER this row groups under in its lane, or `null`
   * (MOTIR-6837) — how `motir next --bug` knows a bug's subtask belongs to a
   * bug it should run whole, as a parent run. Absent on an item not read off a
   * lane (a hosted run's adopted legs, a continue's resumed card).
   */
  containerKey?: string | null;
}

/** WHICH `GIT WORKFLOW` variant the server-assembled prompt carries — chosen
 * server-side from the item's inherited lineage, never selectable by the CLI
 * (`DispatchWorkflowMode`, lib/dto/dispatch.ts). */
export type DispatchWorkflowMode = 'per_item_pr' | 'session_lineage';

/**
 * One PROSE-vs-GRAPH advisory (`WorkItemProseAdvisoryDto`) — a work item the
 * dispatched card's ACCEPTANCE CRITERIA name while carrying no `blocked_by` edge
 * to it. The server sends only the `likely-missing-edge` tier here.
 *
 * ⚠️ NEVER a reason to refuse a dispatch. It is printed, and the human decides —
 * the same disposition `notReadyError` documents for a real blocker, one notch
 * softer because this one is a hint rather than a fact.
 */
export interface DispatchReferenceAdvisory {
  /**
   * The union discriminant, mirroring the server's — absent on the wire for this
   * variant, so a payload from ANY server version narrows the same way.
   */
  kind?: 'reference';
  /** The dispatched card's key — the item whose body names the reference. */
  item: string;
  /** The referenced item's key. */
  referenced: string;
  /** The referenced item's raw workflow status key (e.g. `in_review`). */
  referencedStatus: string;
  severity: string;
}

/**
 * What EVERY SHAPE advisory carries (`WorkItemProseShapeAdvisoryDto`,
 * MOTIR-2175) — a defect in the dispatched card's OWN acceptance criteria, with
 * no referenced work item at all, which is why it is a separate variant rather
 * than a severity.
 *
 * ⚠️ Also never a reason to refuse. Same disposition as above: printed, and the
 * human decides.
 *
 * ⚠️ The members below are matched by `severity`, and an UNMATCHED severity
 * prints nothing. The CLI ships separately and is routinely pointed at a NEWER
 * Motir, so a severity this build has never heard of must be silent rather than
 * print some other member's fields as `undefined` —
 * `renderDispatchAdvisories` selects known severities and lets anything else
 * fall through. Adding a member to this union is therefore not enough: it has to
 * be rendered too, or it is invisible.
 */
interface DispatchShapeAdvisoryBase {
  kind: 'shape';
  /** The dispatched card's key. */
  item: string;
  /** 1-based index of the offending criterion — where the card should be cut. */
  criterionIndex: number;
}

/** The card's criteria ask for state that exists only after its own PR merged. */
export interface DispatchOrderingAdvisory extends DispatchShapeAdvisoryBase {
  severity: 'likely-ordering-violation';
  /** The matched post-merge phrase (e.g. `once it lands`). */
  phrase: string;
}

/**
 * A criterion names a path in a repo that is not the card's `targetRepo`
 * (MOTIR-2177) — one subtask, one repo, one pull request.
 */
export interface DispatchRepoStraddleAdvisory extends DispatchShapeAdvisoryBase {
  severity: 'likely-repo-straddle';
  /** The repo-qualified path the criterion names. */
  path: string;
  /** The repo that path belongs to — never the card's own. */
  repo: string;
  /** `contradiction`: the card pins a different repo. `unpinnable`: it pins none. */
  reason: 'contradiction' | 'unpinnable';
}

/** One SHAPE advisory — narrow by `severity` once `kind === 'shape'` has. */
export type DispatchShapeAdvisory = DispatchOrderingAdvisory | DispatchRepoStraddleAdvisory;

/**
 * The card's body names a file a LATER merge already changed, so its deliverable
 * may already be in the repository (MOTIR-2903).
 */
export interface DispatchSubsumptionAdvisory {
  kind: 'subsumption';
  /** The dispatched card's key. */
  item: string;
  severity: 'likely-already-shipped';
  /** The first path the body names that a qualifying merge touched. */
  path: string;
  /** The covering merge, as `owner/name#number`. */
  pullRequest: string;
  /** Its title, or `null` when the server has none. */
  pullRequestTitle: string | null;
  /** When it merged, ISO-8601. */
  mergedAt: string;
}

/**
 * One advisory, any family. Narrow POSITIVELY on the TAGGED members
 * (`isOrderingAdvisory` / `isRepoStraddleAdvisory` / `isSubsumptionAdvisory`);
 * an UNTAGGED object — including a payload from a server that predates the
 * union — is a reference, which is what `isReferenceAdvisory` tests.
 *
 * ⚠️ The old `a.kind !== 'shape'` catch-all is the shape to avoid here: it read
 * a NEWER family as a reference and printed `a.referenced` as `undefined`. A
 * build older than MOTIR-2903 does exactly that with a subsumption advisory —
 * which is why the reference filter is a positive predicate from here on, and
 * why the server bumps `V1_CONTRACT_VERSION` when the union grows.
 */
export type DispatchAdvisory =
  | DispatchReferenceAdvisory
  | DispatchShapeAdvisory
  | DispatchSubsumptionAdvisory;

/**
 * Narrow to the ORDERING member. A predicate rather than an inline `filter`
 * comparison, because a boolean predicate does not narrow the resulting array
 * and the renderer would then read `phrase` off the whole union.
 */
export function isOrderingAdvisory(a: DispatchAdvisory): a is DispatchOrderingAdvisory {
  return a.kind === 'shape' && a.severity === 'likely-ordering-violation';
}

/** Narrow to the REPO-STRADDLE member (MOTIR-2177). */
export function isRepoStraddleAdvisory(a: DispatchAdvisory): a is DispatchRepoStraddleAdvisory {
  return a.kind === 'shape' && a.severity === 'likely-repo-straddle';
}

/** Narrow to the SUBSUMPTION member (MOTIR-2903). */
export function isSubsumptionAdvisory(a: DispatchAdvisory): a is DispatchSubsumptionAdvisory {
  return a.kind === 'subsumption' && a.severity === 'likely-already-shipped';
}

/**
 * Narrow to the REFERENCE member — the positive form of the `kind !== 'shape'`
 * catch-all, so a family this build does not know is not mis-read as one.
 */
export function isReferenceAdvisory(a: DispatchAdvisory): a is DispatchReferenceAdvisory {
  return a.kind === undefined || a.kind === 'reference';
}

/**
 * A run target's current HOW TO TEST record (MOTIR-5358) — one per run: its
 * rich-text body, and a section per repository (`repo` is `owner/name`).
 */
export interface HowToTestRecord {
  dispatchRunId: string | null;
  /**
   * WHO wrote it (MOTIR-5454) — a dispatch RUN, or a PERSON who wrote it from
   * the item page (`approval-gates.md` § 9's 2026-09-17 amendment: two author
   * kinds, one record, one writer).
   *
   * REQUIRED, because the response always carries it — `dispatchRunId` alone
   * cannot tell a person's record from a run's whose run row was pruned.
   * `userId` is null when that account has since been deleted, and `label` is
   * never blank.
   */
  author: HowToTestAuthor;
  createdAt: string;
  /** The record's How to test as rich text (Markdown), exactly as its author wrote it. */
  bodyMd: string;
  previewPath: string | null;
  repos: { repo: string | null; commitSha: string }[];
}

/** The author of a {@link HowToTestRecord} — a run, or a person. */
export type HowToTestAuthor =
  | { kind: 'run'; runId: string; label: string }
  | { kind: 'person'; userId: string | null; label: string };

/** The `dispatch_prompt` payload (`DispatchPromptDto`) — the canonical prompt
 * text plus the facts the CLI routes on before it runs the agent. */
export interface DispatchPrompt {
  key: string;
  prompt: string;
  /**
   * The item's PARENT key, or `null` for a top-level item (MOTIR-2445).
   *
   * The prompt already names it in its CONTEXT prose; this is that fact as a
   * field, so `motir auto` can title its pull request after the shared parent of
   * the cards it carried (MOTIR-2422) without parsing text or paying a request
   * per card.
   */
  parentKey: string | null;
  targetRepo: string | null;
  /**
   * WHERE `targetRepo` is cloned from, and the branch a fresh clone lands on
   * (MOTIR-3588) — the single-repository counterpart of `targetRepos[].cloneUrl`.
   *
   * ⚠️ CARRIED AGAIN, having been DROPPED under the field-with-no-reader rule
   * (MOTIR-2212). The reader now exists: a dispatch whose target checkout is
   * missing MATERIALIZES it from this URL rather than launching the agent at the
   * workspace root against a git workflow that cannot run there.
   *
   * `null` is a real answer with TWO meanings the resolution deliberately
   * collapses into one: the card pins no repository, or Motir cannot derive a
   * clone URL for its provider. Either way there is nothing to clone from, and
   * the preserved bootstrap path is what answers.
   */
  targetRepoCloneUrl?: string | null;
  targetRepoDefaultBranch?: string | null;
  /**
   * EVERY repository the item ships in (MOTIR-3131), ordered, primary first —
   * `targetRepos[0]?.name ?? null === targetRepo`, always.
   *
   * OPTIONAL on the wire for the same reason `advisories` is: the CLI is
   * published separately from the server and is routinely pointed at a
   * self-hosted Motir older than itself. A server predating MOTIR-3131 sends no
   * such key, and absent must read as "this card ships in one place" — the
   * single-repository path — rather than as a crash.
   */
  targetRepos?: {
    name: string;
    cloneUrl: string | null;
    defaultBranch: string | null;
    /**
     * What this repository has to show for itself (MOTIR-3136) — `delivered`
     * (a pull request merged onto its own default branch), `awaiting`,
     * `unknown`, `unestablished` (the repository does not exist yet, so there is
     * nothing to open a pull request against) or `excluded` (the project is
     * deliberately code-less there, and it does not hold the card).
     *
     * `null` for a repository the card does not carry — the unpinned card whose
     * project has exactly one. The wire type is an open string for the same
     * reason `advisories`' severity is: a state a newer server adds must read as
     * "something this build has no words for", not as a crash.
     */
    delivery: string | null;
  }[];
  workflowMode: DispatchWorkflowMode;
  sessionBranch: string | null;
  /**
   * The branch the prompt tells the agent to create for its work — the same name
   * in every repository — or `null` for a manual item (MOTIR-6539). The CLI names
   * it on `checkout_ready` and checkpoints it while the agent works.
   *
   * OPTIONAL on the wire for the same reason `targetRepos` is: a server older
   * than MOTIR-6539 sends no such key, and absent reads as "nothing to
   * checkpoint", never as a crash.
   */
  workBranch?: string | null;
  /**
   * The branch the prompt tells the agent to work on (MOTIR-6530) — the session
   * branch, else the card's per-item branch; `null` for a manual item. OPTIONAL
   * for the same reason `advisories` is: a server older than this CLI sends none,
   * and absent reads as "not known", never as a crash.
   */
  branch?: string | null;
  /**
   * OPTIONAL on the wire, deliberately: the CLI is published separately from the
   * server and is routinely pointed at a self-hosted Motir older than itself. A
   * server predating MOTIR-2079 sends no such key, which must read as "nothing to
   * warn about" rather than a crash — so every consumer treats absent as `[]`.
   */
  advisories?: DispatchAdvisory[];
}

/**
 * What an `expand_item` SUBMIT returns (MOTIR-1825's `structuredContent`).
 *
 * Both ids address the same expansion: `planId` is the review surface
 * (`/plans/<id>`), `jobId` is what `get_plan_status` also accepts. The tool
 * returns them the instant motir-ai accepts the job — it never waits for the
 * planner — which is the whole reason an unattended loop can fire one.
 *
 * NOTE the contract this type does NOT carry: a submitted expansion produces a
 * Plan of PROPOSALS, never work items. Approval is the only path from a proposal
 * to a `work_item` row, and it happens in Motir, not here.
 */
export interface ExpandSubmitResult {
  jobId: string;
  planId: string;
}

// ── the keyed CLAIM (MOTIR-2961) ────────────────────────────────────────────

/** An actor named on a claim result — who holds a card, or who moved it. */
export interface ClaimActor {
  id: string;
  name: string;
}

/**
 * What one claim attempt resolved to (`lib/dto/claim.ts`).
 *
 * Four values because a dispatcher's next move differs for each, and a client
 * that collapsed them into "did it throw" would have to make a second read to
 * work out which of them it was looking at.
 */
export type WorkItemClaimOutcome = 'claimed' | 'mine' | 'taken' | 'not_claimable';

/**
 * The result of claiming one card by key.
 *
 * ⚠️ A refusal is a 200, not an error. Three of the four outcomes are ordinary
 * states a dispatcher meets on the happy path — resuming its own interrupted
 * run, losing a race, or being pointed at finished work — so the server reports
 * them as values and the CLI branches on them.
 */
export interface WorkItemClaim {
  key: string;
  title: string;
  outcome: WorkItemClaimOutcome;
  /** `outcome === 'claimed'`, carried by the server so the happy path can be
   *  read without knowing the vocabulary. */
  claimed: boolean;
  /** Where the item is AFTER the call: the new status on a claim, the untouched
   *  one on every refusal. `category` is null for a status the project's
   *  workflow does not define. */
  status: { key: string; category: string | null };
  /** Who holds it now — the caller on a claim, the winner on a refusal, and
   *  null when a sibling moved the status without ever assigning. */
  assignee: ClaimActor | null;
  /** WHO made the transition that put it where it is — the field that names a
   *  winner even when nothing was assigned. */
  transitionedBy: ClaimActor | null;
  /** WHEN that transition happened, ISO-8601; null for a row whose status was
   *  never moved. */
  transitionedAt: string | null;
}

/**
 * What a REPAIR claim resolved to (Story MOTIR-5460 · MOTIR-5464) — `motir fix`.
 *
 * `claimed` / `mine` hand over the failing pull requests and an open `fix` run;
 * `taken` names who holds that run; `not_repairable` says why in `reason`.
 */
export type WorkItemRepairOutcome = 'claimed' | 'mine' | 'taken' | 'not_repairable';

/** Why a card cannot be repaired — set exactly on `not_repairable`. */
export type WorkItemRepairRefusal =
  | 'not_implemented'
  | 'repair_on_run_target'
  | 'no_pull_requests'
  | 'ci_running'
  | 'not_failing'
  | 'repair_not_code';

/** One failing pull request a repair is handed. */
export interface RepairPullRequest {
  /** `owner/name`. */
  repo: string;
  number: number;
  url: string;
  /** The pull request's own branch — checked out, and pushed to. */
  headRef: string;
  baseRef: string | null;
  /** The pull request's OWN verdict — may be `passing` when `queueExit` is set. */
  ci: 'passing' | 'failing' | 'running' | null;
  /** The checks failing at the verdict's commit, by name. */
  failingChecks: string[];
  /** The standing merge-queue failure that makes this pull request failing, or
   *  null (MOTIR-5719): the queue's reason and its failing check, both check fields
   *  null for a conflict. */
  queueExit: RepairQueueExit | null;
}

/** Why the merge queue threw a pull request out, as a repair is told it. */
export interface RepairQueueExit {
  /** GitHub's own reason — `CI_FAILURE`, `MERGE_CONFLICT`, … */
  rawReason: string;
  exitedAt: string;
  headSha: string;
  failingCheckName: string | null;
  failingCheckUrl: string | null;
}

/**
 * Which repair a claim hands over (MOTIR-6502). `ci` — make the build pass.
 * `acceptance_rerun` — the story's acceptance video was sent back with Re-run: fix what
 * the reviewer saw, on the same pull requests, then re-record the video. `review` — a
 * review sent the card back (MOTIR-6822): the review agent's findings, or a person's
 * Request changes on the approve-and-merge gate — address each one on the same pull
 * requests and push.
 */
export type WorkItemRepairClass = 'ci' | 'acceptance_rerun' | 'review';

/** What the review said, on a `review` (MOTIR-6822). */
export interface ReviewRefusal {
  /** Which review sent it back — the review agent, or the approve-and-merge gate. */
  gate: 'agent_review' | 'pull_request_approval';
  /** The findings, verbatim and in full. */
  findingsMd: string | null;
  /** `Review agent` for the review agent; the person's name otherwise. */
  reviewerName: string | null;
  decidedAt: string;
}

/** What the reviewer said, on an `acceptance_rerun`. */
export interface AcceptanceRefusal {
  reasonMd: string | null;
  decidedByLabel: string | null;
  decidedAt: string;
}

/** The result of a repair claim. A refusal is a 200, as on the keyed claim. */
/**
 * What `POST /api/v1/work-items/{key}/continue` answered (MOTIR-6532) — the
 * CONTINUE claim on a work item whose last run died. A refusal is a result, not an
 * error: `not_continuable` carries its `reason`, `taken` its `holder`.
 */
/** One repository's share of a dead run's work (MOTIR-6791). */
export interface ContinueClaimBranch {
  /** The repository's NAME, or null when the dead run did not record it. */
  repository: string | null;
  branch: string;
  pullRequest: { repo: string; number: number; url: string; headRef: string } | null;
  /**
   * Where to clone it from — carried by a hosted continue's run read
   * (MOTIR-6795), so a repository no remaining leg touches can still be closed
   * out. Absent on the claim itself, whose caller has its own checkouts.
   */
  cloneUrl?: string | null;
}

/**
 * The branches a continue claim handed over — every repository's, primary first —
 * or the single `branch` from a server that sends no `branches`.
 */
export function continueBranchesOf(
  claim: Pick<WorkItemContinueClaim, 'branch' | 'branches' | 'pullRequest'>,
): ContinueClaimBranch[] {
  if (claim.branches && claim.branches.length > 0) return claim.branches;
  return claim.branch === null
    ? []
    : [{ repository: null, branch: claim.branch, pullRequest: claim.pullRequest }];
}

export interface WorkItemContinueClaim {
  key: string;
  title: string;
  outcome: 'claimed' | 'mine' | 'taken' | 'not_continuable';
  reason:
    | 'run_alive'
    | 'use_fix'
    | 'not_in_progress'
    | 'continue_the_parent'
    | 'no_dead_run'
    | 'no_branch'
    | 'gate_awaiting'
    | 'gate_sent_back'
    | null;
  parentKey: string | null;
  runId: string | null;
  holder: { id: string; name: string } | null;
  startedAt: string | null;
  deadRun: {
    id: string;
    command: string;
    origin: 'local' | 'hosted' | 'instance';
    status: string;
    stopReason: string | null;
    lastHeardAt: string;
    dispatcher: { id: string; name: string } | null;
  } | null;
  /** The PRIMARY repository's branch — `branches[0].branch`. */
  branch: string | null;
  /**
   * EVERY repository's branch of the dead run, primary first (MOTIR-6791).
   * Optional because a server older than contract 1.52.0 does not send it — read
   * it through `continueBranchesOf`, which falls back to `branch`.
   */
  branches?: ContinueClaimBranch[];
  pullRequest: { repo: string; number: number; url: string; headRef: string } | null;
  previousAssignee: { id: string; name: string } | null;
  /** `parent` when the dead run was a scoped run over this container (MOTIR-6535). */
  mode: 'card' | 'parent';
  /** The dead scope run's legs that already landed — never re-dispatched. */
  landedKeys: string[];
  /** The dead scope run's legs still in flight, now the caller's — run again. */
  resumedKeys: string[];
  /**
   * The gates of a run that STOPPED AT A GATE (MOTIR-7708): the approved ones a
   * resume picks up after, or the ones still holding it on a refusal. Optional
   * because a server older than contract 1.64.0 does not send it.
   */
  gates?: { key: string; kind: string; state: string }[];
  /** True when the claim RESUMES a gated run rather than continuing a dead one. */
  resumesGated?: boolean;
}

export interface WorkItemRepairClaim {
  key: string;
  title: string;
  outcome: WorkItemRepairOutcome;
  reason: WorkItemRepairRefusal | null;
  /** The card to repair instead, on `repair_on_run_target`. */
  runTargetKey: string | null;
  /** The open `fix` run — set on `claimed`, `mine` and `taken`. */
  runId: string | null;
  holder: ClaimActor | null;
  startedAt: string | null;
  repairClass: WorkItemRepairClass;
  /** Set on an `acceptance_rerun` the caller holds; null otherwise. */
  acceptanceRefusal: AcceptanceRefusal | null;
  /** Set on a `review` the caller holds; null otherwise (MOTIR-6822). */
  reviewRefusal: ReviewRefusal | null;
  /** Non-empty on `claimed` and `mine` only. */
  pullRequests: RepairPullRequest[];
}

/** Which of the two claimable scopes a result is about. */
export type ScopeClaimKind = 'work_item' | 'sprint';

/**
 * What a whole-scope claim resolved to (MOTIR-3049).
 *
 * The first four are {@link WorkItemClaimOutcome}'s vocabulary, unchanged and
 * computed by the same classifier — a refusal means one MEMBER refused, and
 * being inside a scope does not give a member a new reason. The last two are
 * the ways a SCOPE can fail that a single card cannot:
 *
 * - `wrong_shape`    — a work-item scope whose child is itself a container. A
 *                      RESULT, not an error: the answer is to re-plan, never to
 *                      retry.
 * - `not_finishable` — work OUTSIDE the scope gates work inside it, so a run
 *                      that took it could not finish it.
 */
export type ScopeClaimOutcome =
  | 'claimed'
  | 'mine'
  | 'taken'
  | 'not_claimable'
  | 'wrong_shape'
  | 'not_finishable';

/** One work item inside a claimed scope. */
export interface ScopeMember {
  key: string;
  title: string;
  status: { key: string; category: string | null };
}

/**
 * The result of one scope claim — ALL OR NOTHING.
 *
 * ⚠️ `members` is populated only on a claim; every refusal carries `[]`,
 * because a refusal claimed nothing. There is deliberately no shape here for
 * "some of it": a partially-claimed scope is the one outcome with no good
 * handling, since you are already holding cards somebody else is now blocked on.
 */
export interface ScopeClaim {
  scope: { kind: ScopeClaimKind; key: string | null; sprintId: string | null; name: string };
  outcome: ScopeClaimOutcome;
  /** `outcome === 'claimed'` — the happy path, without knowing the vocabulary. */
  claimed: boolean;
  members: ScopeMember[];
  /** The member that decided a `mine` / `taken` / `not_claimable` verdict. */
  offender: {
    key: string;
    title: string;
    status: { key: string; category: string | null };
    assignee: ClaimActor | null;
    transitionedBy: ClaimActor | null;
    transitionedAt: string | null;
  } | null;
  /** The container child of a `wrong_shape` verdict, and how deep the work sits. */
  shape: { child: string; childTitle: string; depth: number } | null;
  /** Why a `not_finishable` scope cannot be finished, in the validators' shape. */
  blockers: {
    item: string;
    blockedBy: string;
    blockerStatus: string;
    blockerSprintId: string | null;
  }[];
}

// ── the plan-change CONVERSATION (MOTIR-1832) + the plan read (MOTIR-1837) ──
// The wire shapes `motir plan` renders. Mirrors of the server DTOs
// (`lib/dto/planChange.ts`, `lib/dto/plans.ts`), kept loose in the same spirit as
// the read rows above: the CLI renders what the tenant returns, it does not
// re-validate the server.

/** One turn on the thread, in `seq` order. `jobId` is set only on a `system`
 *  submission marker; `body` is what was typed on a `user` turn. */
export interface PlanTurn {
  id: string;
  seq: number;
  /**
   * THREE roles, not two. `assistant` is a real turn the PLANNER writes — the
   * findings report it owes on every turn, and the one Gate-2 clarifying
   * question (MOTIR-2222) — persisted on the same thread the web panel renders.
   * The view model claimed two until MOTIR-2341 read the union off the wire, and
   * `renderTurn` labelled everything that was not `system` as "you" until
   * MOTIR-2397 gave the planner its own marker.
   */
  role: 'user' | 'system' | 'assistant';
  body: string;
  jobId: string | null;
  /**
   * The ONE clarifying question an `assistant` turn asked, or null when it only
   * reported. Null on every other role. This is what makes the awaiting state
   * DERIVED from the thread rather than held in the terminal — see
   * {@link ../plan.js#pendingQuestion}, the CLI's port of the shipped
   * `lib/planning/planChangeThread.ts`.
   */
  question: string | null;
  /**
   * A `user` turn that REPLIED to the pending question, as opposed to one that
   * changed the subject and superseded it. The two render different markers —
   * design states C and E (`design/ai-chat/design-notes.md`).
   */
  isAnswer: boolean;
  authorId: string | null;
  createdAt: string;
}

/**
 * A planning CONVERSATION — one per project per anchor set, addressed by SCOPE
 * and never by a client-held id, which is what makes the terminal and the web
 * panel the same thread rather than two. `turns` is the FULL ordered thread (the
 * resume payload). `targetKeys` is empty on the project-wide conversation.
 */
export interface PlanSession {
  id: string;
  targetKeys: string[];
  turnCount: number;
  lastJobId: string | null;
  lastSubmittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  turns: PlanTurn[];
}

/**
 * What a submit returns — the job it opened and the `generating` plan bound to
 * it. The SAME handle an expansion submit answers with, and for the same
 * reason: the job has been accepted, not run.
 *
 * It used to carry the thread as it then stood. Nothing read it — the command
 * prints the two ids and either detaches or watches the plan — and the v1
 * submit does not publish one, so it is gone rather than re-fetched.
 */
export interface PlanSubmitResult {
  jobId: string;
  planId: string;
}

/** The motir-ai job behind a still-`generating` plan. `reachable: false` means
 *  motir-ai could not be ASKED (and `failure` describes that outage); `true`
 *  with a failed status means the job itself died. */
export interface PlanJobState {
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | null;
  reachable: boolean;
  failure: { code: string; message: string } | null;
}

/**
 * What became of a submitted planning job. `status` is the PLAN's own status
 * verbatim — there is no synthetic "failed" plan state, because a failed job
 * leaves its plan at `generating` forever. That distinction lives in `job`,
 * which is populated ONLY while generating; a bounded watch must read it.
 */
export interface PlanOutcome {
  planId: string;
  /** ⚠️ FIVE MEMBERS since MOTIR-3578. `stale` means the plan reached a reviewer
   *  and can no longer be approved, because a `modify`/`remove` target it holds
   *  reached a terminal status after the plan closed. It is NOT decided and NOT
   *  declined — the plan is live, and if the drift reverses it returns to
   *  `planned` on its own. A caller asking *is this over?* must not read it as
   *  an ending; a caller asking *can I approve this?* must read it as a no. */
  status: 'generating' | 'planned' | 'stale' | 'approved' | 'declined';
  origin: string;
  jobId: string | null;
  itemCount: number;
  job: PlanJobState | null;
}

/** The proposed fields of an `add` — the new node's values, which live on the
 *  proposal because no work item exists yet. */
export interface PlanProposalFields {
  title?: string;
  kind?: string;
  type?: string | null;
  priority?: string | null;
  executor?: string | null;
  storyPoints?: number | null;
  estimateMinutes?: number | null;
  descriptionMd?: string | null;
  /**
   * The card's ORDERED STEPS (MOTIR-4620) — a `manual` card's to-do list,
   * proposed with the card. `null` on a proposal that carries none.
   *
   * The CLI renders only the COUNT (`· N steps`): the terminal is where the
   * SHAPE of a plan is confirmed, and the rows themselves are read in Motir,
   * where the reviewer can act on them.
   */
  todos?: PlanProposalTodo[] | null;
}

/** ONE proposed step of a card's to-do list, as `/api/v1` presents it. */
export interface PlanProposalTodo {
  text: string;
  notesMd: string | null;
  commandText: string | null;
  executor: 'coding_agent' | 'human' | null;
}

/**
 * ONE PROPOSAL — not a work item. `workItemKey` stays null on an `add` until
 * the plan is approved in Motir, which is the only path from a proposal to a
 * row. `parentRef` / `blockedByRefs` carry either a real work-item ref or an
 * intra-plan `planItem:<id>` temp-ref.
 */
export interface PlanProposal {
  id: string;
  op: 'add' | 'modify' | 'remove';
  workItemKey: string | null;
  proposedFields: PlanProposalFields | null;
  patch: Record<string, unknown> | null;
  parentRef: string | null;
  blockedByRefs: string[];
}

/** A plan WITH the proposals it bundles — what a planning pass proposed, not
 *  just how many items it produced. */
export interface PlanWithItems {
  id: string;
  /** ⚠️ FIVE MEMBERS since MOTIR-3578. `stale` means the plan reached a reviewer
   *  and can no longer be approved, because a `modify`/`remove` target it holds
   *  reached a terminal status after the plan closed. It is NOT decided and NOT
   *  declined — the plan is live, and if the drift reverses it returns to
   *  `planned` on its own. A caller asking *is this over?* must not read it as
   *  an ending; a caller asking *can I approve this?* must read it as a no. */
  status: 'generating' | 'planned' | 'stale' | 'approved' | 'declined';
  title: string | null;
  summary: string | null;
  sourceJobId: string | null;
  origin: string;
  itemCount: number;
  items: PlanProposal[];
}

/** One item's outcome in a `complete_session` bulk close-out. */
export interface CompleteSessionOutcome {
  key: string;
  outcome: 'completed' | 'already_done' | 'failed';
  reason?: string | null;
}

// ── The DISPATCH RUN report (Story MOTIR-1789 · MOTIR-1794) ────────────────
//
// The three shapes `dispatchRunReporter` reads back off the ingest. Narrow on
// purpose: the reporter is an OBSERVER, and a wide type here would make the run
// loop's behaviour depend on fields the ingest is free to change.

/** One card in the SET a run is opened with. */
export interface DispatchRunCardInput {
  key: string;
  disposition: 'queued' | 'skipped';
  /** Required when `disposition` is `skipped`, forbidden otherwise. */
  skipReason?: DispatchSkipReason;
}

/** Why a card was left out — the ADR's closed vocabulary. */
export type DispatchSkipReason =
  | 'needs_planning'
  | 'needs_human'
  | 'claim_refused'
  | 'blocked_in_scope'
  | 'integrated_dep'
  | 'replan_submitted'
  | 'checkout_unavailable';

/** A LEG's state — the ADR's closed vocabulary. */
export type DispatchCardDisposition =
  | 'queued'
  | 'running'
  | 'integrated'
  | 'implemented'
  | 'failed'
  | 'replanned'
  | 'skipped'
  | 'not_reached';

/** Why the run ended — the ADR's closed vocabulary. */
export type DispatchStopReason =
  | 'drained'
  | 'completed'
  | 'max'
  | 'halted'
  | 'interrupted'
  | 'replanned'
  | 'gated'
  | 'abandoned';

/** The ordered stream's vocabulary — the ADR's closed enum. */
export type DispatchEventKind =
  | 'run_opened'
  | 'scope_claimed'
  | 'snapshot_frozen'
  | 'session_pr'
  | 'plan_approved'
  | 'run_closed'
  | 'card_claimed'
  | 'card_skipped'
  | 'checkout_ready'
  | 'prompt_issued'
  | 'agent_started'
  | 'agent_exited'
  | 'leg_verdict'
  | 'delivery_linked'
  | 'ci_verdict'
  | 'ci_fix_attempt'
  | 'ci_gave_up'
  | 'card_settled'
  | 'log'
  // ⚠️ SERVER-WRITTEN, NEVER REPORTED BY THIS CLIENT (MOTIR-3981,
  // `run-findings-protocol.md` Q5). They are here so a reader of a run can be
  // TYPED over the whole enum; the v1 ingest deliberately refuses them, because
  // the ids exist only server-side and accepting them would let a client forge a
  // finding. Nothing in this package may emit one.
  | 'bug_filed'
  | 'plan_submitted'
  // The run-found report's conclusion (MOTIR-6282) — appended by the report
  // SERVICE on the leg, refused by the ingest like the two above.
  | 'unbuildable_reported'
  // A review run's verdict (MOTIR-6821) — appended by the verdict route's SERVICE,
  // refused by the ingest like the three above.
  | 'review_verdict'
  // A run's discrepancy record (MOTIR-8655) — appended by the discrepancy SERVICE in the
  // same transaction as the card comment, refused by the ingest like the four above.
  | 'discrepancy_recorded';

export interface DispatchRunOpened {
  runId: string;
  /** `false` when the same `idempotencyKey` had already opened this run. */
  created: boolean;
  status: string;
  seq: number;
  cards: Array<{ key: string | null; disposition: string }>;
}

/**
 * A run READ back — what a CLI that did not open the run needs to adopt it
 * (MOTIR-6558): its lifecycle and its SET, in the run's own order.
 *
 * A card's `key` survives the work item's deletion and is null only when the row
 * lost it, which no adopting caller can dispatch.
 */
export interface DispatchRunView {
  runId: string;
  status: string;
  command: string;
  origin: string;
  model: string | null;
  endedAt: string | null;
  cards: Array<{ key: string | null; position: number; disposition: string }>;
  /**
   * What a `continue` run resumes (MOTIR-6795) — what the server's continue claim
   * decided when it opened the run. Null for any other command; absent from a
   * server older than contract 1.53.0.
   */
  continues?: DispatchRunContinues | null;
  /**
   * What a HOSTED `fix` run repairs (MOTIR-6929) — what the server's repair claim
   * decided when it opened the run. Null for any other command and for a local repair;
   * absent from a server older than contract 1.59.0.
   */
  repair?: DispatchRunRepair | null;
}

/** A hosted repair's decision, read back from its run (MOTIR-6929). */
export interface DispatchRunRepair {
  repairClass: WorkItemRepairClass;
  title: string | null;
  /** Every pull request, each on its OWN branch — the only refs the repair may push. */
  pullRequests: Array<{
    /** `owner/name`. */
    repo: string;
    number: number;
    url: string;
    branch: string;
    baseRef: string | null;
    headSha: string | null;
  }>;
  /**
   * The last agent run's profile and recorded session, for an agent-door repair to resume
   * (MOTIR-9052); null when there is none, and always null from a server older than 1.74.0.
   */
  resume: { profile: string; sessionId: string | null; canResume: boolean } | null;
  /** The review's refusal the repair answers, the findings verbatim; null off `review`. */
  findings:
    | (ReviewRefusal & {
        gateId: string | null;
        subjectVersion: string | null;
        decidedByLabel: string | null;
        decidedUnderAuthority: string | null;
      })
    | null;
}

/** One pull request under review, at the head the review is about (MOTIR-6824). */
export interface ReviewPullRequest {
  /** `owner/name`. */
  repository: string;
  number: number;
  /** The REVIEWED head — the gate's version, never a later commit. */
  headSha: string;
  baseBranch: string | null;
  headBranch: string | null;
  url: string;
}

/** `GET /api/v1/work-items/{key}/review-prompt` (MOTIR-6821). */
export interface ReviewPrompt {
  key: string;
  gateId: string;
  /** The version under review — the verdict names it back. */
  subjectVersion: string;
  pullRequests: ReviewPullRequest[];
  /** The server-assembled brief. */
  prompt: string;
}

/** The ONE verdict a review run submits (`POST …/agent-review`, MOTIR-6821). */
export interface AgentReviewVerdict {
  subjectVersion: string;
  verdict: 'pass' | 'changes_requested';
  summaryMd: string | null;
  findingsMd: string | null;
}

/** What an ACCEPTED verdict did. */
export interface AgentReviewResult {
  key: string;
  gateId: string;
  verdict: 'pass' | 'changes_requested';
  state: 'approved' | 'changes_requested';
  subjectVersion: string;
  decidedAt: string;
}

export interface DispatchRunContinues {
  fromRunId: string | null;
  branch: string | null;
  /** Each with its repository's clone URL, where the project knows one. */
  branches: Array<{ repository: string | null; branch: string; cloneUrl: string | null }>;
  mode: 'card' | 'parent';
  landedKeys: string[];
  resumedKeys: string[];
}

/**
 * A hosted run's GIT CREDENTIALS (MOTIR-6538 · MOTIR-6559) — one entry per
 * repository of the run, each an App installation token and the App's bot as
 * its author, and the dispatcher's Motir name for the pull request body.
 *
 * ⚠️ `token` is a live GitHub credential. It is handed to git and `gh` through
 * `hostedGit.ts`'s helper and cache; nothing prints it.
 */
export interface RunGitCredentials {
  credentials: Array<{
    repository: string;
    token: string;
    expiresAt: string;
    authorName: string;
    authorEmail: string;
  }>;
  dispatchedBy: string | null;
}

export interface DispatchRunAppended {
  runId: string;
  appended: number;
  /** The run's new highest `seq`. */
  seq: number;
}

/**
 * The kinds this CLI may REPORT — every member of {@link DispatchEventKind}
 * except the five the server writes (`review_verdict`, MOTIR-6821, the fourth; `discrepancy_recorded`, MOTIR-8655, the fifth).
 *
 * ⚠️ THE EXCLUSION IS THE POINT (MOTIR-3981, `run-findings-protocol.md` Q5).
 * `bug_filed`, `plan_submitted` and `unbuildable_reported` (MOTIR-6282) carry
 * ids or verdicts that exist only server-side, and the v1 ingest refuses them so
 * a client cannot assert a finding a run never produced. Deriving this by
 * EXCLUSION rather than re-listing nineteen strings means a member added to the
 * enum is reportable by default and the three that are not stay named in one
 * place.
 */
export type ReportableEventKind = Exclude<
  DispatchEventKind,
  | 'bug_filed'
  | 'plan_submitted'
  | 'unbuildable_reported'
  | 'review_verdict'
  | 'discrepancy_recorded'
>;

/** One event on the wire. `body` is the OPT-IN log payload — default OFF. */
export interface DispatchRunEventInput {
  kind: ReportableEventKind;
  workItemKey?: string;
  data?: unknown;
  body?: string;
  disposition?: DispatchCardDisposition;
  skipReason?: DispatchSkipReason;
  sessionBranch?: string;
  exitCode?: number;
  /**
   * The agent's SELF-REPORTED model, on `agent_exited` only (MOTIR-7504) — the
   * value `runAgent` returned, null when the agent reported none, never a guess.
   * The server writes it onto the leg (`dispatch-run-record.md` AMENDMENT 4) and
   * refuses it on any other kind.
   */
  model?: string | null;
}

export interface CompleteSessionResult {
  sessionBranch: string;
  results: CompleteSessionOutcome[];
}

/** A related work item as the detail aggregate carries it (the server's
 * `WorkItemSummaryDto` — the fields a terminal row renders). Used for the parent
 * chain, the children, and every dependency edge. */
export interface WorkItemSummary {
  identifier: string;
  kind: string;
  title: string;
  status: string;
}

/** ONE dependency / relationship EDGE (`RelationshipLinkDto`): the linked item
 * plus the `work_item_link.id` of the edge itself. */
export interface WorkItemLink {
  item: WorkItemSummary;
}

/**
 * A CHILD row of the detail aggregate: a summary PLUS the sibling dependency
 * block `get_work_item` attaches (MOTIR-1848), which `motir show` folds into
 * build-order waves.
 *
 * `dependencies` is OPTIONAL for the reason given above {@link ReadyItemSummary}:
 * absent means "this server cannot tell me the graph", and `show` falls back to
 * the plain children table rather than drawing a wave order it cannot
 * substantiate.
 */
export interface WorkItemChild extends WorkItemSummary {
  dependencies?: WorkItemDependencyEdges;
}

/**
 * The `get_work_item` aggregate (`IssueDetailDto`) — the item, its lineage, its
 * dependency edges, and the server's own readiness verdict (dependency-only —
 * see the readiness rule).
 *
 * This mirrors only the fields the terminal renders. It began as the two-field
 * slice `motir run` gates on (status + readiness) and was widened for `motir
 * show` (7.9.13), which needed the rest of what the tool already returned — no
 * server change, just a wider mirror. The groups below are NOT optional: the
 * tool returns the whole aggregate on every call, so a renderer that defended
 * against a missing `children` would be defending against a shape the server
 * cannot produce. Heavier fields the CLI does not render (`workflow`, `labels`,
 * `components`, `customFields`, `duplicates`, `clones`) are deliberately left
 * out — `--json` prints the tool payload itself, so nothing is lost by omitting
 * them here.
 */
/** An ancestor, as the LINEAGE renders it. v1 sends the parent chain as KEYS,
 *  and `renderLineage` reads `.identifier` and nothing else — so this is the
 *  whole shape, rather than a summary with three invented fields. */
export interface AncestorRef {
  identifier: string;
}

export interface WorkItemDetail {
  item: {
    identifier: string;
    kind: string;
    title: string;
    status: string;
    priority: string;
    assigneeId: string | null;
    type: string | null;
    executor: string | null;
    storyPoints: number | null;
    estimateMinutes: number | null;
    targetRepo: string | null;
    sprintId: string | null;
    descriptionMd: string | null;
  };
  /** The folder the item is FILED in, as its name path root-first
   *  (`["Parked", "2025"]`), or `null` when it is not filed (MOTIR-5412). Only a
   *  root can be filed; a child's placement travels as its ancestors' keys.
   *  OPTIONAL on the view model, like `deliveries`, so a detail built by hand
   *  (a test, an older adapter) reads as unfiled rather than failing to type. */
  folderPath?: string[] | null;
  /** The full parent chain, ordered root→self and EXCLUDING the item itself. */
  ancestors: AncestorRef[];
  children: WorkItemChild[];
  blockedBy: WorkItemLink[];
  blocks: WorkItemLink[];
  relatesTo: WorkItemLink[];
  readiness: {
    ready: boolean;
    openBlockers: WorkItemSummary[];
    /** The nearest ancestor whose own blockers are still open — the CASCADE
     * cause. A cascade-blocked item must never read as a bare "blocked".
     * `renderReadinessLine` prints its key and its title, which is all v1
     * publishes and all this needs to be. */
    blockedByAncestor: { identifier: string; title: string } | null;
  };
  /**
   * The card's DELIVERY SET (MOTIR-3697's `deliveries`) — every pull request
   * delivering it, with the ONE CI verdict.
   *
   * This is the only route the CLI has to `derivePrCiState`. Shelling to
   * `gh pr checks` would be a SECOND verdict, computed from different inputs by
   * different rules, drifting from the pill a person reads on the same card —
   * which is what MOTIR-3685's watch loop exists not to do.
   *
   * OPTIONAL on the view model, `ci` typed as an open `string | null`, for the
   * reason the activity types above are loose: the CLI is published on its own
   * release train and routinely meets a Motir OLDER than itself (no field at
   * all) or NEWER (a `ci` value this build has never heard of). Absent reads as
   * "this server cannot tell me", which the watch loop treats as nothing to
   * watch rather than as a failure.
   */
  deliveries?: WorkItemDelivery[];
}

/** One member of a card's delivery set, narrowed to what the CLI renders and
 *  what the watch loop decides on. */
export interface WorkItemDelivery {
  /** `owner/name`. */
  repo: string;
  number: number;
  title: string;
  url: string;
  /** `open` | `merged` | `closed` — open-typed, per the note above. */
  state: string;
  /** `passing` | `failing` | `running`, or null for a pull request with no CI
   *  recorded. Absence of CI is not a state and is certainly not a pass. */
  ci: string | null;
  baseRef: string | null;
  defaultBranch: string;
  /**
   * The STANDING merge-queue failure on this pull request, or null (MOTIR-5720).
   * The server decides "standing" — a failure, not re-queued, at the current head
   * — so this build holds no head logic. `ci` stays the pull request's OWN checks:
   * a delivery reading `ci: 'passing'` with a set `queueExit` is RED in the queue.
   * Optional because an older Motir does not send it; absent reads as none.
   */
  queueExit?: DeliveryQueueExit | null;
}

/** Why the merge queue threw a delivering pull request out. */
export interface DeliveryQueueExit {
  /** GitHub's own reason — `CI_FAILURE`, `MERGE_CONFLICT`, … — open-typed. */
  rawReason: string;
  /** The head the queue tested. Unchanged after a fixing attempt ⇒ nothing was
   *  pushed. */
  headSha: string;
  failingCheckName: string | null;
  failingCheckUrl: string | null;
}

// ── the ACTIVITY stream (MOTIR-1999's tool · MOTIR-2000's consumer) ──────────
//
// The mirror of `get_work_item_activity`'s three page shapes (`lib/dto/activity.ts`
// + `lib/dto/comments.ts`), narrowed to the fields the terminal renders.
//
// LOOSER than the server's discriminated unions ON PURPOSE, and for the reason
// the optional `dependencies` block above exists: the CLI is published to npm on
// its own release train, so it routinely meets a Motir NEWER than itself. The
// server's `ActivityEntryPartDto` is a closed union THERE and an open one HERE —
// a part kind (or a value type) this build has never heard of must render as its
// generic form, never crash the read. Typing `kind` as `string` with optional
// members is what makes the renderer's fallback branch reachable instead of
// unreachable-by-type.

/** One side of a change in its display form (`ActivityValueDto`) — the resolved
 *  label, with the stored id kept for the deleted-referent case. */
export interface ActivityValue {
  type: string;
  text?: string;
  key?: string;
  label?: string | null;
  userId?: string;
  name?: string | null;
  date?: string;
  sprintId?: string;
  workItemId?: string;
  identifier?: string | null;
}

/** One renderable piece of a history entry (`ActivityEntryPartDto`). `from` /
 *  `to` are `ActivityValue` on a `field` part and plain strings on a `generic`
 *  one — the producer's own shape, mirrored rather than harmonized. */
export interface ActivityPart {
  kind: string;
  field?: string;
  from?: ActivityValue | string | null;
  to?: ActivityValue | string | null;
  op?: string;
  linkKind?: string;
  target?: ActivityValue;
  items?: string[];
  author?: ActivityValue;
  replyCount?: number;
  key?: string;
}

/** One history entry — a displayable revision, its actor resolved. */
export interface ActivityEntry {
  id: string;
  changeKind: string;
  /** ISO-8601. */
  changedAt: string;
  actor: { userId: string; name: string | null };
  parts: ActivityPart[];
}

/** One comment (`CommentDTO`). `bodyMd` is the FULL Markdown — the tool never
 *  truncates it and neither does the renderer. */
export interface ActivityComment {
  id: string;
  author: { id: string; name: string };
  bodyMd: string;
  /** Set on a body edit; null when never edited. */
  editedAt: string | null;
  createdAt: string;
}

/** A root comment with its single-level replies riding along. */
export interface ActivityCommentThread extends ActivityComment {
  replies: ActivityComment[];
}

/** One entry of the merged stream: the two sources keep their native shapes
 *  under a discriminated `type` (`ActivityAllEntryDto`). */
export type ActivityStreamEntry =
  | { type: 'comment'; thread: ActivityCommentThread }
  | { type: 'history'; entry: ActivityEntry };

/** One page of the merged stream (`ActivityAllPageDto`). A page may come back
 *  SHORT with a non-null `nextCursor` — documented normal for this view. */
export interface ActivityAllPage {
  entries: ActivityStreamEntry[];
  nextCursor: string | null;
  totalComments: number;
  totalChanges: number;
}

/** One page of the comments view (`CommentsPageDTO`). `totalCount` counts every
 *  comment, replies included; `order` is the direction this window was read in. */
export interface CommentsPage {
  threads: ActivityCommentThread[];
  nextCursor: string | null;
  totalCount: number;
  order: 'asc' | 'desc';
}

/** One page of the history view (`ActivityHistoryPageDto`). No CLI flag selects
 *  it today (`show` exposes `--activity` / `--comments`), but the client mirrors
 *  the tool's whole argument surface rather than a subset of it. */
export interface ActivityHistoryPage {
  entries: ActivityEntry[];
  nextCursor: string | null;
  totalCount: number;
}

/** The three streams the tool serves, mirroring the Activity section's tabs. */
export type ActivityView = 'all' | 'comments' | 'history';

/** One page of whichever view was asked for. */
export type ActivityPage = ActivityAllPage | CommentsPage | ActivityHistoryPage;

/** One FilterAST condition in the tool's self-documenting expanded form. */
export interface SearchFilterCondition {
  field: string;
  operator: string;
  value: unknown;
}

/** The versioned FilterAST envelope `search_work_items` accepts — the SAME
 * grammar the /issues `?filter=` URL + saved filters carry (`version` is the
 * server's `FILTER_PARAM_VERSION`). */
export interface SearchFilterEnvelope {
  version: string;
  combinator: 'and' | 'or';
  conditions: SearchFilterCondition[];
}

export interface MotirClientOptions {
  serverUrl: string;
  token: string;
}

export class MotirClient {
  private readonly serverUrl: string;
  /**
   * The `/api/v1` transport EVERY method goes through.
   *
   * Built in the constructor and immediately usable: it holds no connection,
   * only a base URL and a bearer. There is nothing to open and nothing to
   * close — the client that had a `connect()` / `close()` bracket, an SDK
   * session and a tool protocol was retired with the MCP transport (11.5.6).
   */
  private readonly v1: V1Transport;

  constructor(opts: MotirClientOptions) {
    this.serverUrl = normalizeServerUrl(opts.serverUrl);
    this.v1 = new V1Transport({ serverUrl: this.serverUrl, token: opts.token });
  }

  /**
   * Walk a cursor-paged collection to exhaustion, returning every page.
   *
   * For the two reads whose VIEW MODEL is a whole list rather than a page —
   * `listProjects` and `listSprints`, both of which the MCP tool answered in one
   * shot. The cursor is echoed exactly as received and never inspected.
   */
  private async walkPages<P extends { nextCursor: string | null }>(
    fetchPage: (cursor: string | undefined) => Promise<P>,
  ): Promise<P[]> {
    const pages: P[] = [];
    let cursor: string | undefined;
    do {
      const page = await fetchPage(cursor);
      pages.push(page);
      // ⚠️ Echoed, never inspected — the cursor is opaque and scoped to its own
      // collection (ADR §5).
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return pages;
  }

  // ── The typed methods ────────────────────────────────────────────────────
  // Each names one `/api/v1` operation (or a small fixed set of them) and hands
  // the validated body to an adapter. Listing/auth/link commands use `whoami`;
  // the read and dispatch commands use the rest.

  /**
   * Who this token is, and the workspace it is bound to.
   *
   * TWO reads: v1 splits identity from workspace description, and the adapter
   * matches them on `workspaceId` rather than assuming a position.
   *
   * ⚠️ SETTLED, not `Promise.all` (MOTIR-6278). A token without `project:browse`
   * is refused on both reads; `Promise.all` rejected on the first refusal and
   * handed control back while the other request was still being served. The
   * error the caller sees is the same either way — the FIRST read's, `/me`'s
   * when both fail — but the call no longer ends with its own work in flight.
   */
  /**
   * WHO the credential is — `getMe` ALONE (MOTIR-6558). A hosted run's own
   * credential may read itself and nothing wider, so the hosted mode resolves
   * the dispatcher here rather than through {@link whoami}, whose workspace list
   * spans every workspace the person belongs to (`runTokenRoutes.ts`).
   */
  async me(): Promise<WhoamiResult['user']> {
    const me = await this.v1.request('getMe');
    return { id: me.user.id, name: me.user.name, email: me.user.email };
  }

  async whoami(): Promise<WhoamiResult> {
    const [me, workspaces] = await Promise.allSettled([
      this.v1.request('getMe'),
      this.v1.request('listWorkspaces'),
    ]);
    if (me.status === 'rejected') throw me.reason;
    if (workspaces.status === 'rejected') throw workspaces.reason;
    return toWhoami(me.value, workspaces.value);
  }

  /** The token workspace's browsable projects (MOTIR-1879). Takes no arguments:
   * the workspace is the one the PAT is bound to. An empty workspace is an
   * EMPTY LIST, not an error. */
  async listProjects(): Promise<ProjectList> {
    // The view model has no cursor, so this walks the collection to exhaustion —
    // the same whole-list answer the MCP tool gave. Projects are bounded by the
    // workspace, and the alternative would be changing every caller's shape.
    return toProjectList(
      await this.walkPages((cursor) =>
        this.v1.request('listProjects', { query: { ...(cursor ? { cursor } : {}) } }),
      ),
    );
  }

  listReady(args: {
    projectKey: string;
    /** Which ready row lane — the leaves (default) or the bugs (MOTIR-6835). */
    lane?: ReadyRowLane;
    kinds?: string[];
    priority?: string[];
    assigneeId?: string | null;
    cursor?: string;
    limit?: number;
  }): Promise<ReadyPage> {
    // `assigneeId` is TRI-STATE on the wire: absent means any assignee, and the
    // literal `none` means the unassigned bucket. `null` here IS that bucket, so
    // it must become the literal rather than being dropped as "no value" — which
    // would silently widen the filter to every assignee.
    return this.requestReadyLane(args.lane ?? 'leaf', args.projectKey, {
      ...(args.kinds ? { kind: args.kinds } : {}),
      ...(args.priority ? { priority: args.priority } : {}),
      ...(args.assigneeId === undefined
        ? {}
        : { assigneeId: args.assigneeId === null ? UNASSIGNED : args.assigneeId }),
      ...(args.cursor ? { cursor: args.cursor } : {}),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    }).then(toReadyPage);
  }

  /**
   * ONE page of a ready ROW lane. Both operations are named as LITERALS, one per
   * lane, rather than looked up: the typed transport infers each call's query and
   * body from its operation id, and the run-token table's scan
   * (`tests/hostedRuns/runTokenRouteTable.test.ts`) finds a call by its literal.
   */
  private requestReadyLane(
    lane: ReadyRowLane,
    projectKey: string,
    query: {
      kind?: string[];
      priority?: string[];
      assigneeId?: string;
      ancestor?: string[];
      sprintId?: string;
      allowSoftBlock?: 'true';
      cursor?: string;
      limit?: number;
    },
  ) {
    return lane === 'bug'
      ? this.v1.request('getProjectReadyBugs', { path: { projectKey }, query })
      : this.v1.request('getProjectReadyLeaves', { path: { projectKey }, query });
  }

  /** One page of the CONTAINERS lane (MOTIR-6835) — the runnable containers, in
   *  the server's group order. Its facets apply to the container. */
  listReadyContainers(args: {
    projectKey: string;
    priority?: string[];
    assigneeId?: string | null;
    cursor?: string;
    limit?: number;
  }): Promise<ReadyContainerPage> {
    return this.v1
      .request('getProjectReadyContainers', {
        path: { projectKey: args.projectKey },
        query: {
          ...(args.priority ? { priority: args.priority } : {}),
          ...(args.assigneeId === undefined
            ? {}
            : { assigneeId: args.assigneeId === null ? UNASSIGNED : args.assigneeId }),
          ...(args.cursor ? { cursor: args.cursor } : {}),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        },
      })
      .then(toReadyContainerPage);
  }

  /** The next runnable container not held out by KEY — what `motir next
   *  --parent` runs. FOLLOWS the cursor, as {@link nextReady} does. */
  async nextReadyContainer(args: {
    projectKey: string;
    excludeKeys?: readonly string[];
  }): Promise<{ container: ReadyContainerSummary | null }> {
    const excluded = new Set((args.excludeKeys ?? []).map((key) => key.toUpperCase()));
    let cursor: string | undefined;
    do {
      const page = await this.listReadyContainers({
        projectKey: args.projectKey,
        ...(cursor ? { cursor } : {}),
      });
      const found = page.items.find((c) => !excluded.has(c.key.toUpperCase()));
      if (found) return { container: found };
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return { container: null };
  }

  /**
   * The next item to dispatch — the highest-ranked ready row not held out.
   *
   * ⚠️ There is no `next_ready` OPERATION on `/api/v1`, and that is the right
   * shape rather than a gap. `lib/api/v1/ready/schema.ts` states the dispatch
   * rank as contract — `(type asc, priority desc, key asc)` — and says
   * `items[0]` is what an agent should take next. "Next" is therefore a pick
   * from a ranked page: the server ranks, the client skips what it has already
   * tried, and nothing here re-sorts.
   *
   * Held out by KEY. The row id the MCP tool addressed by is gone from this
   * client entirely — it was that tool's addressing scheme, and the persisted
   * exclusion list has been key-based since MOTIR-2338, which had to translate
   * keys back into ids on every ask. That round trip goes with it.
   *
   * FOLLOWS the cursor. A whole page of held-out rows is ordinary on a resumed
   * run, and stopping at page one would report "drained" to a loop that still
   * had work.
   */
  async nextReady(args: {
    projectKey: string;
    kinds?: string[];
    excludeKeys?: readonly string[];
    ownerId?: string;
    /**
     * Which ready LANES to take from, in order (MOTIR-6835) — default the leaves
     * alone, so `motir next` never hands out a bug. `motir auto` passes
     * `['leaf', 'bug']`: every leaf, then the bugs.
     */
    lanes?: readonly ReadyRowLane[];
  }): Promise<{ item: DispatchItem | null }> {
    const excluded = new Set((args.excludeKeys ?? []).map((key) => key.toUpperCase()));
    for (const lane of args.lanes ?? ['leaf']) {
      for await (const item of this.walkReady({ ...args, lane })) {
        if (excluded.has(item.key.toUpperCase())) continue;
        if (args.ownerId !== undefined && !isPickable(item, args.ownerId)) continue;
        return { item };
      }
    }
    return { item: null };
  }

  /**
   * EVERY ready row a run may take, in rank order — `motir batch`'s snapshot.
   *
   * The whole set rather than one item, because a snapshot is a frozen
   * BOUNDARY: what was ready when the run started. It used to be built by
   * asking `next_ready` once per item with a growing exclusion list — N
   * requests for N items — and is one page walk now.
   */
  async listReadyForDispatch(args: {
    projectKey: string;
    kinds?: string[];
    ownerId?: string;
    /** SCOPE to the ready leaves beneath these containers, at any depth
     *  (MOTIR-3196). The container itself is never in the result. */
    ancestor?: string[];
    /** SCOPE to one sprint — an id, or the literal `active` (MOTIR-3196). */
    sprintId?: string;
    /** WIDEN past a SOFT block (MOTIR-6355): list a leaf held only by an
     *  ancestor's block. A leaf with its OWN open blocker (HARD) is never
     *  listed. Sent as the string `"true"`; omitted when not set. */
    allowSoftBlock?: boolean;
  }): Promise<DispatchItem[]> {
    // BOTH row lanes, the leaves first (MOTIR-6835): a scoped run and a batch
    // snapshot must hold every row they held when they read the unlaned set —
    // a story's edged bug included — so this is `leaves ∪ bugs`, de-duplicated
    // by key (the lanes are disjoint; the check is a seatbelt), never re-sorted.
    const items: DispatchItem[] = [];
    const seen = new Set<string>();
    for (const lane of ['leaf', 'bug'] as const) {
      for await (const item of this.walkReady({ ...args, lane })) {
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        if (args.ownerId !== undefined && !isPickable(item, args.ownerId)) continue;
        items.push(item);
      }
    }
    return items;
  }

  /**
   * The ready collection, page by page, in the server's rank — ADAPTED.
   *
   * ⚠️ It yields the VIEW MODEL, not the wire row, and that is the Q4 boundary
   * rather than a preference. Yielding `SuccessBody<'getProjectReadyLeaves'>
   * ['items'][number]` would put a generated type on a signature in this file,
   * where the ADR allows one only inside `src/transport.ts` and `src/adapters/`
   * — and a derived type reads as innocuous precisely because it does not look
   * like an import. `test/architecture.test.ts` fails on either form.
   */
  private async *walkReady(args: {
    projectKey: string;
    lane: ReadyRowLane;
    kinds?: string[];
    ancestor?: string[];
    sprintId?: string;
    allowSoftBlock?: boolean;
  }): AsyncGenerator<DispatchItem> {
    let cursor: string | undefined;
    do {
      const body = await this.requestReadyLane(args.lane, args.projectKey, {
        ...(args.kinds ? { kind: args.kinds } : {}),
        // The two SCOPE facets (MOTIR-3196). Sent through the SAME page walk
        // as `kind`, so a scoped read follows the cursor to exhaustion exactly
        // as an unscoped one does — a scoped run that silently took only the
        // first page would claim a set it never enumerated.
        ...(args.ancestor ? { ancestor: args.ancestor } : {}),
        ...(args.sprintId !== undefined ? { sprintId: args.sprintId } : {}),
        ...(args.allowSoftBlock ? { allowSoftBlock: 'true' as const } : {}),
        ...(cursor ? { cursor } : {}),
      });
      for (const row of body.items ?? []) yield toDispatchItem(row);
      cursor = body.nextCursor ?? undefined;
    } while (cursor);
  }

  async getWorkItem(key: string): Promise<WorkItemDetail> {
    return (await this.readWorkItem(key)).detail;
  }

  /**
   * The detail read, returning BOTH the view model and the payload it was
   * mapped from.
   *
   * `--json` emits the server's own resource rather than the CLI's narrowed
   * view of it (ADR Amendment 16): the view model deliberately omits fields
   * nothing renders, and `--json` is the escape hatch that makes that omission
   * safe. The payload is typed `unknown` on purpose — a command needs BYTES
   * here, not a shape, and typing it would put a generated wire type outside
   * the adapter boundary that Q4 draws.
   */
  async readWorkItem(key: string): Promise<{ detail: WorkItemDetail; payload: unknown }> {
    const body = await this.v1.request('getWorkItem', { path: { key } });
    return { detail: toWorkItemDetail(body), payload: body };
  }

  /**
   * The APPROVED DESIGNS this work item waits on (Story MOTIR-5553 · Subtask
   * MOTIR-5562) — one verdict per design card it is `blocked_by`.
   *
   * Returned as the server's own body rather than a narrowed view model: the one
   * consumer is the design MATERIALIZER, which needs the asset paths, their
   * states and their short-lived urls, and a view model shaped for a renderer
   * would drop exactly those. The generated validator is what makes the type
   * true, so there is no `as` on the path the payload takes.
   */
  async listWorkItemDesigns(key: string): Promise<DesignsResponse> {
    return this.v1.request('listWorkItemDesigns', { path: { key } });
  }

  /**
   * ONE page of a work item's discussion + change trail (MOTIR-1999).
   *
   * A SECOND call, made only when `motir show` is asked for it: the default read
   * stays one round-trip, so a card with two hundred comments never slows down
   * `show` or the dispatch path that leans on it.
   *
   * `cursor` and `order` are pass-through in both directions — the `all` cursor
   * is an OPAQUE composite carrying both sources' positions, so the CLI must
   * never construct, parse or merge one. Omitting `order` leaves each view on
   * its own shipped default rather than the client inventing one.
   */
  async getWorkItemActivity(args: {
    key: string;
    view?: ActivityView;
    cursor?: string;
    order?: 'asc' | 'desc';
  }): Promise<ActivityPage> {
    return (await this.readWorkItemActivity(args)).page;
  }

  /** The activity read, returning both the page and its payload — see
   *  {@link readWorkItem} for why `--json` needs the second. */
  async readWorkItemActivity(args: {
    key: string;
    view?: ActivityView;
    cursor?: string;
    order?: 'asc' | 'desc';
  }): Promise<{ page: ActivityPage; payload: unknown }> {
    const view = args.view ?? 'all';
    // ONE operation serves all three views, so a cursor stays scoped to the view
    // that issued it and the two per-source totals arrive from the same place.
    const body = await this.v1.request('getWorkItemActivity', {
      path: { key: args.key },
      query: {
        view,
        ...(args.cursor ? { cursor: args.cursor } : {}),
        ...(args.order ? { order: args.order } : {}),
      },
    });
    const page =
      view === 'comments'
        ? toCommentsPage(body, args.order ?? 'asc')
        : view === 'history'
          ? toActivityHistoryPage(body)
          : toActivityAllPage(body);
    return { page, payload: body };
  }

  /**
   * Move one item to a status.
   *
   * Returns nothing, where the MCP wrapper returned `unknown`. The v1 operation
   * answers with the item at its new status, and no caller reads it — all four
   * call sites `await` the promise for its EFFECT. Handing back a body nothing
   * consumes would put a wire shape in reach of a renderer without a mapper
   * between them, which is the boundary this port exists to establish.
   *
   * An ILLEGAL transition is still fully diagnosable: it comes back as a 422
   * whose envelope carries the allowed targets, and the transport raises it
   * before this method returns.
   */
  async transitionStatus(args: { key: string; status: string }): Promise<void> {
    await this.v1.request('transitionWorkItem', {
      path: { key: args.key },
      body: { status: args.status },
    });
  }

  /**
   * The CANONICAL, server-generated prompt for one item (MOTIR-1802). A pure
   * READ — it never claims the item or moves its status, so re-printing an
   * in-progress item's prompt is safe. The CLI prints this text verbatim; it
   * never assembles a prompt grammar of its own.
   *
   * `sessionBranch` is the unattended-run SEED (`motir auto`, MOTIR-882): the
   * branch to use when the item carries no lineage of its own. The server treats
   * it as a fallback only — an item already on a lineage keeps that one — so the
   * CLI can start a run's first item on the run's branch without ever being able
   * to redirect an existing chain.
   */
  async dispatchPrompt(
    key: string,
    opts: {
      sessionBranch?: string | null;
      findingsPolicy?: string | undefined;
      /**
       * `--auto-approve-replan` (MOTIR-4085) — whether THIS run's loop may
       * approve a submitted re-plan itself and carry on. It changes the prompt
       * TEXT only, adding the section that tells the agent which lane its
       * correction will go down and that BOTH are legitimate. Omitted, and the
       * request is byte-identical to the one this method sent before the
       * parameter existed.
       */
      autoApproveReplan?: boolean;
      /**
       * A DEAD run's id (MOTIR-6533) — `motir continue` asks for the CONTINUE
       * prompt: the dead run's story and a git workflow that checks its branch
       * out instead of cutting one. Omitted, the request is unchanged.
       */
      continueFrom?: string;
    } = {},
  ): Promise<DispatchPrompt> {
    // A GET, which is what a pure read should have looked like all along: the
    // MCP tool took a POST-shaped call because that is the only shape MCP has.
    const body = await this.v1.request('getWorkItemDispatchPrompt', {
      path: { key },
      query: {
        ...(opts.sessionBranch ? { sessionBranch: opts.sessionBranch } : {}),
        // OMITTED when nothing is disabled (MOTIR-3022): an absent parameter is
        // how the server is told to render the COMPLETE protocol, so a run with
        // no flags sends the request it sent before the flag existed.
        ...(opts.findingsPolicy ? { findingsPolicy: opts.findingsPolicy } : {}),
        // Same rule, same reason (MOTIR-4085): absent means no, so only the one
        // lane that HAS an auto-approving loop ever sends it.
        ...(opts.autoApproveReplan ? { autoApproveReplan: '1' } : {}),
        // ALWAYS sent (MOTIR-8810): every run this CLI launches reads
        // `$MOTIR_AGENT_REPORT` and posts its `unbuildable`, `discrepancy` and `stop`
        // (`dispatchLeg.ts`), so the server may name that file as the route. A CLI
        // that predates those posts sends nothing and is told to use the tool.
        agentReport: '1',
        // ALWAYS sent (MOTIR-10000): this CLI also posts the agent's `decisions`.
        agentReportDecisions: '1',
        ...(opts.continueFrom ? { continueFrom: opts.continueFrom } : {}),
      },
    });
    return toDispatchPrompt(body);
  }

  /** Record an item's work as integrated on a session branch (7.8.11): moves it
   * to `in_review` AND stamps `session_branch` in one transaction. */
  /**
   * APPROVE the plan a refused card produced, and report what was approved
   * (MOTIR-3023). The entrance `motir auto --auto-approve-replan` drives.
   *
   * ⚠️ ADDRESSED BY THE CARD, which is what makes this callable at all. The plan
   * was submitted by the AGENT, in a sandbox, with the `submit_plan_session`
   * tool anchored at `targetKeys: [<KEY>]` (MOTIR-4083; the retired door was
   * `motir plan --detach <KEY>`), and the id came back in its tool result — which
   * this process never sees. There is no plan id to send, and the
   * server does not want one: it derives the plan from the conversation anchored
   * at this key, so a caller cannot name a plan the card did not produce.
   *
   * Returns the plan's id and how many proposals it carried, which is everything
   * the run's summary needs to say WHAT it changed about the operator's tree.
   */
  async approveWorkItemPlan(key: string): Promise<{ planId: string; proposalCount: number }> {
    const body = await this.v1.request('approveWorkItemPlan', { path: { key } });
    return { planId: body.id, proposalCount: body.proposals.length };
  }

  /**
   * READ the plan a refused card produced, WITHOUT deciding it (MOTIR-4085).
   *
   * ⚠️ THE SAME ADDRESS AS THE APPROVE, and that is the point rather than a
   * convenience: both halves of `…/work-items/{key}/plan-approval` resolve
   * through the planning conversation anchored at this key, so what this returns
   * is the plan {@link approveWorkItemPlan} would approve. A read resolved a
   * second way would let a loop check the lane of one plan and approve another.
   *
   * ⚠️ IT EXISTS BECAUSE THE BOUND IS THE LOOP'S. `--auto-approve-replan` decides
   * a plan while nobody is watching, and what keeps that safe is that the loop
   * checks the proposals against the card's own lane FIRST. There is no other way
   * to reach them: the plan's id came back in a sandboxed agent's tool result,
   * which this process never sees.
   *
   * Returns the proposals in the shape `inLane` reads, plus the plan's id so a
   * decline can name what it declined.
   */
  async readWorkItemPlan(key: string): Promise<{
    planId: string;
    status: string;
    proposals: {
      op: 'add' | 'modify' | 'remove';
      workItemKey: string | null;
      parentKey: string | null;
      parentRef: string | null;
    }[];
  } | null> {
    const body = await this.v1.request('getWorkItemPlan', { path: { key } });
    // ⚠️ `null` IS AN ANSWER, and it is the one the loop acts on. Nothing is
    // anchored at this card, which for a refused card means the agent anchored
    // its re-plan somewhere else — at a container, or at nothing — the lane the
    // prompt offers and calls legitimate. A FIELD rather than a status code, so
    // this branches on data (`public-api-conventions.md` §8).
    if (body.plan === null) return null;
    return {
      planId: body.plan.id,
      status: body.plan.status,
      proposals: body.plan.proposals.map((p) => ({
        op: p.op,
        workItemKey: p.workItemKey,
        parentKey: p.parentKey,
        parentRef: p.parentRef,
      })),
    };
  }

  async markIntegrated(args: {
    key: string;
    sessionBranch: string;
    implementationHarness?: string;
    /** The model the agent SELF-REPORTED (MOTIR-2419). Omitted when it reported
     *  none — the field is left null rather than filled with a guess. */
    implementationModel?: string | null;
  }): Promise<void> {
    await this.v1.request('recordWorkItemIntegration', {
      path: { key: args.key },
      body: {
        sessionBranch: args.sessionBranch,
        ...(args.implementationHarness === undefined
          ? {}
          : { implementationHarness: args.implementationHarness }),
        ...(args.implementationModel === undefined || args.implementationModel === null
          ? {}
          : { implementationModel: args.implementationModel }),
      },
    });
  }

  /**
   * Record WHAT BUILT an item, with no branch beside it (MOTIR-2421).
   *
   * The per-item-PR path's counterpart to {@link markIntegrated}: `motir batch`
   * opens one pull request per item off `main`, so it has no session branch to
   * report — and the integration endpoint requires one, which is why every card
   * it ever ran carries a null provenance triple.
   *
   * ⚠️ It records provenance and NOTHING else. No status moves, and the item's
   * session branch is untouched — a branch stamped here would make the item stop
   * blocking its dependents with nothing merged. There is deliberately no
   * parameter for one, and the server refuses the field outright.
   */
  async reportImplementation(args: {
    key: string;
    implementationSource?: 'byok' | 'manual';
    implementationHarness?: string;
    implementationModel?: string | null;
  }): Promise<void> {
    await this.v1.request('reportWorkItemImplementation', {
      path: { key: args.key },
      body: {
        ...(args.implementationSource === undefined
          ? {}
          : { implementationSource: args.implementationSource }),
        ...(args.implementationHarness === undefined
          ? {}
          : { implementationHarness: args.implementationHarness }),
        ...(args.implementationModel === undefined || args.implementationModel === null
          ? {}
          : { implementationModel: args.implementationModel }),
      },
    });
  }

  /**
   * DECLARE which pull request delivers a work item (MOTIR-5048).
   *
   * ⚠️ THE ONLY THING THAT ASSOCIATES THE TWO. There is no title parse and no
   * branch fallback — MOTIR-3674 retired both — so an unlinked pull request
   * moves no work item when it merges and carries a failing
   * `Motir / work item link` check saying so.
   *
   * ⚠️ IT ADDS, IT DOES NOT MOVE. The link is a `work_item_delivery` ROW, and
   * calling this again naming a DIFFERENT work item leaves the first delivery
   * where it was and writes a second. Both directions are expressible — many
   * pull requests to one work item, one pull request to many — so nothing here
   * reports a moved-from, because nothing moves. A mistaken link is retracted
   * deliberately; re-linking the right work item does not undo it.
   *
   * It works BEFORE any webhook delivery has arrived, which is the case it
   * exists for: `headRef` / `baseRef` / `title` seed the row when this call is
   * what creates it, and a later delivery overwrites them and leaves the links
   * alone.
   *
   * Returns nothing, for the reason {@link transitionStatus} states: the
   * operation answers with the link it resolved, no caller reads it, and handing
   * back a wire shape nothing consumes would put it in reach of a renderer with
   * no mapper between them.
   */
  async linkPullRequest(
    args: { key: string; headRef: string; baseRef: string; title?: string } & (
      | { repository: string; number: number; url?: undefined }
      | { url: string; repository?: undefined; number?: undefined }
    ),
  ): Promise<void> {
    await this.v1.request('linkWorkItemPullRequest', {
      path: { key: args.key },
      body: {
        headRef: args.headRef,
        baseRef: args.baseRef,
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.url === undefined
          ? { repository: args.repository, number: args.number }
          : { url: args.url }),
      },
    });
  }

  /**
   * CLAIM a work item for the token owner — ONE locked call (MOTIR-3048).
   *
   * This used to be a plain `PATCH { assigneeId }` that the caller followed with
   * a separate `transition_status` (MOTIR-2427): two unlocked writes, and a race
   * between them that the comment on {@link isPickable} recorded as accepted.
   * `POST /work-items/{key}/claim` (MOTIR-2961) does both inside one
   * transaction, under a row lock, having re-asserted the TO-DO category — so
   * there is nothing left to follow it with. **Do not also transition after
   * this: the claim IS the dispatch status flip.**
   *
   * ⚠️ THE OWNER IS GONE FROM THE ARGUMENTS, deliberately. It comes from the
   * TOKEN now: the server assigns to whoever is calling, which is the only
   * assignment a claim could honestly make, and an owner a client could name is
   * an owner a client could get wrong. Callers still resolve `whoami` — the
   * PICK needs it, and so does `pickWarning` — but they no longer send it here.
   *
   * ⚠️ It can say NO, and that is the point. A refusal comes back as a 200 with
   * an `outcome` — `taken` names the holder, `not_claimable` names the status —
   * so a loser learns which of the two it is without a second read.
   */
  async claimWorkItem(args: { key: string }): Promise<WorkItemClaim> {
    return toWorkItemClaim(await this.v1.request('claimWorkItem', { path: { key: args.key } }));
  }

  /**
   * CLAIM THE REPAIR of an `implemented` card's red pull requests (MOTIR-5464) —
   * the first thing `motir fix` does. The server opens the `fix` run the command
   * then reports into and closes; the card's status is never written.
   */
  async claimWorkItemRepair(key: string): Promise<WorkItemRepairClaim> {
    return toWorkItemRepairClaim(await this.v1.request('claimWorkItemRepair', { path: { key } }));
  }

  /**
   * CLAIM the continue of a work item whose last run died (MOTIR-6532) — the typed
   * door `motir continue` goes through. The server locks the card, closes a lapsed
   * run, re-assigns the card to the caller and opens the `continue` run; the card's
   * status is never written.
   */
  async claimWorkItemContinue(key: string): Promise<WorkItemContinueClaim> {
    return toWorkItemContinueClaim(
      await this.v1.request('claimWorkItemContinue', { path: { key } }),
    );
  }

  /**
   * CLAIM a whole SCOPE — a container and its children, or the project's active
   * sprint — in ONE all-or-nothing transaction (MOTIR-3049).
   *
   * ⚠️ THE CLAIM IS UP FRONT, AND THAT IS THE WHOLE DESIGN. A scoped run
   * promises to take a story and finish it, which is only keepable if it owns
   * the story when it starts. Claiming as the loop reaches each card leaves a
   * window in which a second run takes card five while this one is on card two,
   * and the two integrate onto different branches — a half-delivered story split
   * across two pull requests, worse than either run refusing.
   *
   * ⚠️ THE ACCEPTED COST: every card in the scope reads In Progress for the
   * whole run while only one is being worked. "In Progress" stops meaning *an
   * agent is on this right now* and starts meaning *this run owns it*. Decided,
   * weighed, and stated in the operation's own documentation.
   *
   * Like {@link claimWorkItem} it can say NO, and every refusal is a 200 with an
   * `outcome` — including two a single card has no analogue for (`wrong_shape`,
   * `not_finishable`), which are FINDINGS whose answer is a re-plan rather than
   * a retry. **The claim IS the dispatch status flip; do not transition after
   * it.**
   */
  async claimScope(
    args:
      | { kind: 'work_item'; key: string; exceptLanded?: boolean }
      | { kind: 'sprint'; projectKey: string },
  ): Promise<ScopeClaim> {
    return toScopeClaim(
      await this.v1.request('claimScope', {
        body:
          args.kind === 'work_item'
            ? {
                kind: 'work_item',
                key: args.key,
                // Only when set — a fresh run's body is unchanged (MOTIR-6535).
                ...(args.exceptLanded ? { exceptLanded: true } : {}),
              }
            : { kind: 'sprint', projectKey: args.projectKey },
      }),
    );
  }

  /**
   * OPEN a dispatch run WITH ITS SET (Story MOTIR-1789 · MOTIR-1794).
   *
   * ⚠️ THE SET RIDES HERE BECAUSE THIS IS THE ONE MOMENT IT EXISTS: a scope
   * claim has just returned its members, or a batch snapshot has just been
   * frozen. Rebuilt afterwards from per-card events it degrades into a list of
   * what the run got round to, and the SKIPPED cards vanish entirely.
   *
   * IDEMPOTENT on `idempotencyKey`, which is the run id `runIdFromDate` already
   * produced — so the session branch, the session pull-request body and the run
   * row in Motir all name the same run, and a retry cannot fork it.
   */
  async openDispatchRun(args: {
    projectKey: string;
    command: 'next' | 'run' | 'run_scope' | 'batch' | 'auto' | 'fix' | 'continue' | 'review';
    idempotencyKey: string;
    cards: DispatchRunCardInput[];
    scopeKey?: string;
    scopeLabel?: string;
    agent?: string;
    model?: string;
  }): Promise<DispatchRunOpened> {
    return toDispatchRunOpened(
      await this.v1.request('openDispatchRun', {
        body: {
          projectKey: args.projectKey,
          command: args.command,
          origin: 'local',
          idempotencyKey: args.idempotencyKey,
          cards: args.cards,
          ...(args.scopeKey === undefined ? {} : { scopeKey: args.scopeKey }),
          ...(args.scopeLabel === undefined ? {} : { scopeLabel: args.scopeLabel }),
          ...(args.agent === undefined ? {} : { agent: args.agent }),
          ...(args.model === undefined ? {} : { model: args.model }),
        },
      }),
    );
  }

  /**
   * READ one run with its set (MOTIR-6558). The hosted mode reads the run the
   * server opened so it can ADOPT it — its cards and their order — instead of
   * opening, or claiming, a second.
   */
  async getDispatchRun(runId: string): Promise<DispatchRunView> {
    return toDispatchRunView(await this.v1.request('getDispatchRun', { path: { id: runId } }));
  }

  /**
   * Trade the RUN credential for fresh git credentials (MOTIR-6538) — one per
   * repository of the run. Only a hosted run's own credential is answered.
   */
  async issueRunGitCredentials(runId: string): Promise<RunGitCredentials> {
    return toRunGitCredentials(
      await this.v1.request('issueDispatchRunGitCredentials', { path: { id: runId } }),
    );
  }

  /** APPEND a batch of run events. The server assigns each its `seq`. */
  async appendDispatchRunEvents(args: {
    runId: string;
    events: DispatchRunEventInput[];
  }): Promise<DispatchRunAppended> {
    return toDispatchRunAppended(
      await this.v1.request('appendDispatchRunEvents', {
        path: { id: args.runId },
        body: { events: args.events },
      }),
    );
  }

  /**
   * The run's CLOSE-OUT prompt (MOTIR-5357) — the text a scoped run hands ONE
   * agent before marking its pull requests ready, so HOW TO TEST is written onto
   * the run target. The server resolves the target and the landed cards from the
   * run's own record; this names only the run.
   */
  async dispatchRunCloseOutPrompt(
    runId: string,
  ): Promise<{ targetKey: string; prompt: string; landedKeys: string[] }> {
    const body = await this.v1.request('getDispatchRunCloseOutPrompt', { path: { id: runId } });
    return { targetKey: body.targetKey, prompt: body.prompt, landedKeys: [...body.landedKeys] };
  }

  /**
   * A run target's CURRENT How-to-test record (MOTIR-5358), or `null` when no
   * run has written one — rendered into each session pull request body.
   */
  async workItemHowToTest(key: string): Promise<HowToTestRecord | null> {
    const body = await this.v1.request('getWorkItemHowToTest', { path: { key } });
    return body.record;
  }

  /**
   * The REVIEW PROMPT a hosted review run is handed (MOTIR-6821 · MOTIR-6824;
   * `hosted-agent-run.md` §8.2): the card, and every pull request of its delivery set
   * at the REVIEWED head the card's `agent_review` gate names. Answers only a `review`
   * run's own credential, for its own card. A read.
   */
  async reviewPrompt(key: string): Promise<ReviewPrompt> {
    const body = await this.v1.request('getWorkItemReviewPrompt', { path: { key } });
    return {
      key: body.key,
      gateId: body.gateId,
      subjectVersion: body.subjectVersion,
      pullRequests: body.pullRequests.map((pr) => ({
        repository: pr.repository,
        number: pr.number,
        headSha: pr.headSha,
        baseBranch: pr.baseBranch,
        headBranch: pr.headBranch,
        url: pr.url,
      })),
      prompt: body.prompt,
    };
  }

  /**
   * SUBMIT a hosted review run's ONE verdict (MOTIR-6821 · MOTIR-6824; §8.4). A late
   * verdict — the code moved, the review was withdrawn or decided — throws
   * `ReviewStaleError` (409 `REVIEW_STALE`): recorded on the run, deciding nothing.
   */
  async submitAgentReview(key: string, verdict: AgentReviewVerdict): Promise<AgentReviewResult> {
    const body = await this.v1.request('submitWorkItemAgentReview', {
      path: { key },
      body: {
        subjectVersion: verdict.subjectVersion,
        verdict: verdict.verdict,
        summaryMd: verdict.summaryMd,
        findingsMd: verdict.findingsMd,
      },
    });
    return {
      key: body.key,
      gateId: body.gateId,
      verdict: body.verdict,
      state: body.state,
      subjectVersion: body.subjectVersion,
      decidedAt: body.decidedAt,
    };
  }

  /**
   * HEARTBEAT — the run is still alive (MOTIR-6530). `closed` when the server has
   * already closed the run (`DISPATCH_RUN_TERMINAL`), so the reporter can stop;
   * every other failure throws, for the reporter to swallow.
   */
  async heartbeatDispatchRun(runId: string): Promise<'ok' | 'closed'> {
    try {
      await this.v1.request('heartbeatDispatchRun', { path: { id: runId } });
      return 'ok';
    } catch (err) {
      if (err instanceof DispatchRunClosedError) return 'closed';
      throw err;
    }
  }

  /**
   * The RUN-FOUND REPORT (MOTIR-8698) — the agent stopped because `targetKey`, a card
   * this run holds, cannot be built as written. The server records it on the card's
   * leg of this run and, when an approved plan shaped the card unchanged, files ONE
   * planning bug into Motir's own planner-bug home. The answer is only whether the
   * card had an open leg on the run.
   */
  async reportDispatchRunUnbuildable(args: {
    runId: string;
    targetKey: string;
    reason: string;
  }): Promise<{ recordedOnRun: boolean }> {
    const body = await this.v1.request('reportDispatchRunUnbuildable', {
      path: { id: args.runId },
      body: { targetKey: args.targetKey, reason: args.reason },
    });
    return { recordedOnRun: body.recordedOnRun };
  }

  /**
   * The run's DISCREPANCY record (MOTIR-8722) — the agent BUILT THROUGH `key`, a card this
   * run holds, and wrote what it built differently into its self-report. One comment on the
   * card and one finding on its leg of this run. The DECISIONS it made where the plan was
   * silent (MOTIR-10000) ride the same record; `decisions` is omitted when there are none, so
   * a points-only record sends the body it always sent.
   */
  async recordDispatchRunDiscrepancy(args: {
    runId: string;
    key: string;
    points: { planAsked: string; built: string; why: string }[];
    decisions?: { planSaid: string; chose: string; why: string; alternatives?: string }[];
  }): Promise<{ commentId: string; recorded: boolean }> {
    const body = await this.v1.request('recordDispatchRunDiscrepancy', {
      path: { id: args.runId },
      body: {
        key: args.key,
        ...(args.points.length > 0 ? { points: args.points } : {}),
        ...(args.decisions && args.decisions.length > 0 ? { decisions: args.decisions } : {}),
      },
    });
    return { commentId: body.commentId, recorded: body.recorded };
  }

  /**
   * The run's STOP report (MOTIR-8722) — the agent stopped on `key`. One comment with its
   * finding and, with `toPlanning`, the card to Planning with the re-plan brief kept on it.
   * The re-plan is NOT submitted: the run's credential cannot plan.
   */
  async reportDispatchRunStop(args: {
    runId: string;
    key: string;
    comment: string;
    toPlanning: boolean;
    requirement?: Partial<
      Record<
        'outcome' | 'behaviour' | 'scopeEdge' | 'constraints' | 'acceptance' | 'assumptions',
        string
      >
    >;
  }): Promise<{ commentId: string; movedToPlanning: boolean }> {
    const body = await this.v1.request('reportDispatchRunStop', {
      path: { id: args.runId },
      body: {
        key: args.key,
        comment: args.comment,
        toPlanning: args.toPlanning,
        ...(args.requirement ? { requirement: args.requirement } : {}),
      },
    });
    return { commentId: body.commentId, movedToPlanning: body.movedToPlanning };
  }

  /** CLOSE the run with its stop reason. The status is DERIVED server-side. */
  async closeDispatchRun(args: { runId: string; stopReason: DispatchStopReason }): Promise<void> {
    await this.v1.request('closeDispatchRun', {
      path: { id: args.runId },
      body: { stopReason: args.stopReason },
    });
  }

  /** Bulk close-out for a merged session PR (7.8.11): every item recorded on
   * the branch → done, `session_branch` cleared, with per-item outcomes. */
  async completeSession(args: {
    sessionBranch: string;
    implementationHarness?: string;
    /** The one axis the close-out actually knows (MOTIR-2447). Sent alone, it
     *  stamps a lane that never reported provenance without disturbing the
     *  harness and model an integration already recorded. */
    implementationSource?: 'byok' | 'manual';
  }): Promise<CompleteSessionResult> {
    const body = await this.v1.request('completeSession', {
      body: {
        sessionBranch: args.sessionBranch,
        ...(args.implementationHarness === undefined
          ? {}
          : { implementationHarness: args.implementationHarness }),
        ...(args.implementationSource === undefined
          ? {}
          : { implementationSource: args.implementationSource }),
      },
    });
    return toCompleteSessionResult(body);
  }

  /**
   * Submit an AI expansion of one CONTAINER item (MOTIR-1825) and return the
   * moment the job is accepted — `{ jobId, planId }`, no streaming, no poll.
   *
   * The one operation on this client that answers 202 rather than 200, and the
   * distinction is load-bearing: the body describes a job that has been QUEUED,
   * not work that has been done. Nothing here waits for the planner.
   *
   * Firing this does NOT grow the tree. `motir auto --include-planning` calls it
   * for an unexpanded epic/story and moves on; what comes back is a plan awaiting
   * a human's approval in Motir. And because a submit SPENDS the token owner's
   * AI credits, it is never retried blindly — a timeout here is not a licence to
   * send it twice.
   */
  async expandItem(key: string): Promise<ExpandSubmitResult> {
    const body = await this.v1.request('submitWorkItemExpansion', { path: { key } });
    return toExpandSubmitResult(body);
  }

  /**
   * Open — or RESUME — the planning conversation for a scope, and read its
   * thread (MOTIR-1832).
   *
   * Addressed by SCOPE (`projectKey` + optional `targetKeys`) and, once the
   * caller holds one, by the session's ID (MOTIR-6028): a scope holds many
   * conversations over time, so the returned `id` is what later calls pass to
   * stay on THIS one. Without an id the server resumes the caller's recent
   * conversation for the scope, or starts one. Opening submits nothing and
   * costs nothing.
   */
  async openPlanSession(args: {
    projectKey: string;
    targetKeys?: string[];
    sessionId?: string;
  }): Promise<PlanSession> {
    return toPlanSession(
      await this.v1.request('openPlanSession', {
        path: { projectKey: args.projectKey },
        body: {
          ...(args.targetKeys ? { targetKeys: args.targetKeys } : {}),
          ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        },
      }),
    );
  }

  /**
   * Add ONE turn to the conversation. APPENDING IS NOT SUBMITTING — the turn is
   * server-side the moment this returns (so quitting can never lose it) and no
   * job starts, no credits are spent, and no work item changes.
   */
  async appendPlanTurn(args: {
    projectKey: string;
    targetKeys?: string[];
    body: string;
    sessionId?: string;
  }): Promise<PlanSession> {
    return toPlanSession(
      await this.v1.request('appendPlanTurn', {
        path: { projectKey: args.projectKey },
        body: {
          body: args.body,
          ...(args.targetKeys ? { targetKeys: args.targetKeys } : {}),
          ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        },
      }),
    );
  }

  /**
   * Send the thread's ACCUMULATED intent — every turn, in order — as ONE change,
   * returning `{ jobId, planId }` the moment the job is accepted.
   *
   * This does NOT create work items: the job produces a plan of PROPOSALS, and
   * approving that plan in Motir is the only thing that turns one into a work
   * item. A thread with no turns is refused by the server; a failed submit
   * leaves the thread intact.
   */
  async submitPlanSession(args: {
    projectKey: string;
    targetKeys?: string[];
    sessionId?: string;
  }): Promise<PlanSubmitResult> {
    // A 202. The handle comes back the moment the job is ACCEPTED; nothing here
    // waits for the planner, which is what keeps `--detach` honest and the
    // watched path a poll the command owns rather than a hang inside the client.
    const handle = await this.v1.request('submitPlanSession', {
      path: { projectKey: args.projectKey },
      body: {
        ...(args.targetKeys ? { targetKeys: args.targetKeys } : {}),
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      },
    });
    return { jobId: handle.jobId, planId: handle.planId };
  }

  /** What became of a submitted planning job (MOTIR-1825) — the plan's status
   *  AND, while it is still generating, whether the job is alive or already
   *  dead (a failed job leaves the plan generating forever). */
  async getPlanStatus(args: { planId: string }): Promise<PlanOutcome> {
    return toPlanOutcome(await this.v1.request('getPlanStatus', { path: { planId: args.planId } }));
  }

  /** Read a plan WITH its proposals (MOTIR-1837) — what was proposed, not just
   *  how many. Still PROPOSALS: nothing here exists in the tree. */
  async getPlan(args: { planId: string }): Promise<PlanWithItems> {
    return toPlanWithItems(await this.v1.request('getPlan', { path: { planId: args.planId } }));
  }

  /**
   * The project's repository SET (MOTIR-3586) — which repositories it has, and
   * where each one is cloned from.
   *
   * Walked to exhaustion for the reason `listProjects` gives: the view model is
   * a whole set, bounded by the project's architecture, and every consumer wants
   * all of it. The ORDER the pages arrive in is preserved — the first row is the
   * project's primary repository.
   */
  async listRepositories(args: { projectKey: string }): Promise<ProjectRepositoryList> {
    return toProjectRepositoryList(
      await this.walkPages((cursor) =>
        this.v1.request('listProjectRepositories', {
          path: { projectKey: args.projectKey },
          query: { ...(cursor ? { cursor } : {}) },
        }),
      ),
    );
  }

  async listSprints(args: { projectKey: string }): Promise<SprintList> {
    // Walked to exhaustion for the reason `listProjects` gives: the view model
    // is a whole list, and a sprint set is bounded by its project.
    return toSprintList(
      await this.walkPages((cursor) =>
        this.v1.request('listProjectSprints', {
          path: { projectKey: args.projectKey },
          query: { ...(cursor ? { cursor } : {}) },
        }),
      ),
    );
  }

  /**
   * One page of a project's work items, narrowed by a filter.
   *
   * The filter rides as `?filter=`, the SAME carrier the product's own list
   * views and saved filters use, so `motir sprint` and the web app cannot
   * disagree about what is in a sprint — they run the same expression through
   * the same registry.
   */
  async searchWorkItems(args: {
    projectKey: string;
    filter?: SearchFilterEnvelope;
    cursor?: string;
    limit?: number;
  }): Promise<SearchPage> {
    return toSearchPage(
      await this.v1.request('listProjectWorkItems', {
        path: { projectKey: args.projectKey },
        query: {
          ...(args.filter ? { filter: encodeFilterParam(args.filter) } : {}),
          ...(args.cursor ? { cursor: args.cursor } : {}),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        },
      }),
    );
  }

  /**
   * How many work items match — the ONLY way this client learns a count.
   *
   * It replaces a pattern that had accumulated rather than been designed: three
   * call sites ran a `limit: 1` SEARCH, threw the row away, and read the total,
   * because the MCP tool's offset paging made a count free. None of them was a
   * search. Each is one request now, and a project with ten thousand items
   * costs the same as one with ten.
   */
  async countWorkItems(args: {
    projectKey: string;
    filter?: SearchFilterEnvelope;
  }): Promise<number> {
    return toWorkItemCount(
      await this.v1.request('countProjectWorkItems', {
        path: { projectKey: args.projectKey },
        query: { ...(args.filter ? { filter: encodeFilterParam(args.filter) } : {}) },
      }),
    );
  }
}

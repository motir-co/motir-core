import type { ReaderTranslationDTO } from '@/lib/dto/workItemTranslation';
import type { HeldTransitionDTO, PullRequestApprovalMemberDTO } from '@/lib/dto/approvalGate';
import type { FixDetailDto, WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import type { DesignEvidenceDTO } from '@/lib/dto/designEvidence';
import type { PlanHoldDTO } from '@/lib/dto/plans';
import type { PageRefMap } from '@/lib/dto/pages';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type {
  ExecutorDto,
  WorkItemDifficultyDto,
  WorkItemObsolescenceDto,
  WorkItemKindDto,
  WorkItemPriorityDto,
  WorkItemTypeDto,
  WorkItemRefMap,
} from '@/lib/dto/workItems';
import type { CustomFieldWithValueDto } from '@/lib/dto/customFieldValues';
import type { LinkedPullRequestDto, WorkItemDeliveryDto } from '@/lib/dto/github';
import type { RepoDelivery } from '@/lib/workItems/repoDelivery';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';
import type { ComponentDto } from '@/lib/dto/components';
import type { EstimationConfigDto } from '@/lib/dto/estimation';

// The quick-view (peek) payload (Subtask 2.5.19; bug 8.8.2). A serializable,
// already-shaped slice of the detail read that the /api/work-items/peek route
// returns and the client IssueQuickViewController fetches — so the peek modal
// opens its frame + skeleton INSTANTLY (client-driven by `?peek`) and streams
// the fields in over the wire, instead of being server-rendered behind the host
// page's blocking data reads (8.8.2). Names + labels are resolved server-side so
// the panel stays purely presentational.
//
// 8.8.8 (Story 8.8) widened the rail to the FULL core-field set the detail page
// carries — Type · Executor · Labels · Components · Sprint · Story points · the
// valued Custom fields · the Created/Updated audit — per the 8.8.4 design
// (design/work-items/quick-view.mock.html), reversing 2.5's curated subset.
// Still read-only (one write path: Open full page); the heavier sections
// (Explanation, children, the full relationships panel, attachments, comments)
// stay detail-only.
//
// MOTIR-2562 (Story MOTIR-2560) makes the rail a WRITE surface, so the payload
// gained the EDITOR INPUTS block at the foot of this interface — the item's
// internal `id` (both Server Actions are keyed by it), the raw current values
// each control needs as its selection, and the option sources (workflow /
// members / sprints / project components). They are ADDED ALONGSIDE the display
// strings above, never in place of them: resolving names server-side is what
// keeps the panel presentational, and the raw values are what make it editable.
//
// They ride the payload rather than a React context ON PURPOSE. The peek panel
// is mounted from SIX places — /items, /ready, /boards, the item detail page and
// its edit page (all via IssueQuickViewController) plus the planning canvas
// (components/planning/WorkItemQuickView) — and only /items mounts
// IssueInlineEditProvider. One self-sufficient read keeps the modal identical
// everywhere; a provider would have to be threaded through five more hosts and
// would make the route-agnostic canvas learn which project it is standing in.

/**
 * A sprint as the peek's Sprint picker needs it (MOTIR-2562) — the four fields
 * `SprintPicker` actually reads (`sequence` orders the planned ones), and no
 * more. See the `sprints` field below for why the full `SprintDto` is the wrong
 * shape on this payload.
 *
 * `SprintPicker`'s prop was `SprintDto[]`; MOTIR-2564 narrowed it to its own
 * `SprintOption` — the same four fields — which is a strictly safe
 * generalisation, since every existing caller passes a superset.
 */
export type QuickViewSprintOption = Pick<SprintDto, 'id' | 'name' | 'state' | 'sequence'>;

/** The serializable payload the peek renders (a condensed slice of the detail read). */
export interface QuickViewData {
  /**
   * The reader's TRANSLATION offer (Story MOTIR-7735 · MOTIR-8122) — whether the
   * quick view offers Translate, per field, and whether its no-credit message may
   * link to adding credit. `null` when the read failed; absent on a Visitor's peek
   * and on a proposal, which offer nothing.
   */
  translation?: ReaderTranslationDTO | null;
  /**
   * The status moves an approval HOLDS (Story MOTIR-4887 · MOTIR-5528), read by
   * `approvalGatesService.listHeldTransitions` — the peek's status field draws
   * them as the detail page does. Absent on a PROPOSAL, which has no status to
   * move.
   */
  heldTransitions?: HeldTransitionDTO[];
  /**
   * The undecided PLAN holding the card at Planning (Story MOTIR-6017 · MOTIR-6267),
   * read by `planTargetLockService.readPlanHold` — every move locked, said on the
   * status field with a Review plan door. `null` when none holds it; absent on a
   * PROPOSAL, which has no status to move.
   */
  planHold?: PlanHoldDTO | null;
  /**
   * The work item's INTERNAL id (cuid) — not the `identifier`. Both write paths
   * the editable rail uses are keyed by it: `updateIssueAction` and
   * `changeStatusAction` (app/(authed)/items/[key]/edit/actions.ts) take `id` as
   * their first input. Without this the peek can render every field and write
   * none of them.
   */
  id: string;
  /** A Visitor's PRIVATE epic (MOTIR-10534): the header wears "Not public", as the
   *  canvas card, the board card and the item page do. Absent on every member read. */
  childrenHidden?: true;
  identifier: string;
  title: string;
  /**
   * This project's identifier prefix (e.g. `MOTIR`) — the bare-key match scope
   * for the peek header's title-linkify (Subtask 5.8.6).
   */
  projectIdentifier: string;
  kind: WorkItemKindDto;
  statusLabel: string;
  statusCategory: StatusCategoryDto | null;
  /** Why the card is stuck until something is repaired (MOTIR-6600), or `null`.
   *  The header draws the To fix tag off it, off the `done` category only
   *  (`toFixTagState`, MOTIR-6610). */
  fixReason: WorkItemFixReasonDto | null;
  /** Which gate a `changes_requested` was on (`fixDetail.gate`) — names the review agent in
   *  the tag's accessible name (MOTIR-6825). Null for every other reason. */
  fixGate?: FixDetailDto['gate'];
  /**
   * The HEAD of the To fix entry this card is carried by (MOTIR-7589), when it is not
   * the head itself — the tag's name gains *· with {head}*. Absent otherwise.
   */
  fixHeadKey?: string;
  /**
   * FIXING (MOTIR-10309 · MOTIR-10506): a repair is live on the card, or a fix was pushed
   * and its checks are running, so the tag reads *Fixing* instead of the reason. `true`
   * only — absent otherwise.
   */
  fixing?: true;
  descriptionMd: string | null;
  /**
   * The WHY (MOTIR-4183, story MOTIR-4181, design Part XIV §6).
   *
   * ⚠️ The shipped peek DEFERS this to the full page — *"Explanation,
   * relationships, attachments, and the activity feed live on the full page"* —
   * and that is right for a work item and impossible for a PROPOSAL, which has
   * no page. Deferring to a thing that does not exist is precisely how
   * `explanationMd` came to be carried, diffed and materialized while nothing in
   * the review surface ever read it (MOTIR-4134). It rides the payload so
   * proposal mode can render it INLINE; the committed peek's own body is
   * unchanged by its presence, and `/items` keeps deferring.
   */
  explanationMd: string | null;
  /**
   * Resolved `motir:` references in `descriptionMd` (Subtask 5.8.6) — keyed by
   * id, so the peek's description renders the live internal-link chip.
   */
  workItemRefs: WorkItemRefMap;
  /**
   * Resolved `motir-page:` tags in `descriptionMd` / `explanationMd`
   * (MOTIR-7697) — keyed by page id, each the live title or the unavailable
   * state. Absent on a payload built before the tag existed (a proposal).
   */
  pageRefs?: PageRefMap;
  /** The NATURE of the work (Story 2.7) — null on a container kind / untyped leaf. */
  type: WorkItemTypeDto | null;
  /** WHO executes the work (Story 2.7) — null when no type is set. */
  executor: ExecutorDto | null;
  /** How hard the work is to reason about (Story MOTIR-6016) — null when unset. */
  difficulty: WorkItemDifficultyDto | null;
  /** The OBSOLESCENCE mark (Story MOTIR-6575 · MOTIR-6674) — null while the card is
   *  still current. Any kind may carry it; only a finished card may be marked. */
  obsolescence: WorkItemObsolescenceDto | null;
  /** Why it is marked — independent of the mark (clearing the mark keeps it). */
  obsolescenceNoteMd: string | null;
  assigneeName: string | null;
  reporterName: string;
  priority: WorkItemPriorityDto;
  /** The issue's labels (id + name; the chip tint is name-hash-derived client-side). */
  labels: { id: string; name: string }[];
  /** The issue's components (id + name; neutral chips). */
  components: { id: string; name: string }[];
  dueLabel: string | null;
  /**
   * The committed sprint's display name, or `null` when the item sits in the
   * backlog (or is excluded from it). Resolved server-side from `sprintId` (not
   * part of the detail aggregate). The panel renders the status-aware empty
   * label (Backlog vs None, keyed off `statusCategory`) when this is null.
   */
  sprintName: string | null;
  /** The agile STORY-POINT estimate (Story 4.3), or null when unestimated. */
  storyPoints: number | null;
  estimateLabel: string | null;
  /**
   * The project's custom-field definitions + this issue's resolved values
   * (Story 5.3), in position order. Passed through from the detail aggregate
   * read unchanged (already display-ready + serializable). The panel renders
   * the VALUED ones read-only and hides the empty ones behind a "Show more
   * fields (N)" disclosure, mirroring the detail rail (5.3.7).
   */
  customFields: CustomFieldWithValueDto[];
  /** Read-only audit instants (ISO-8601) — the quiet line at the foot of the rail. */
  createdAt: string;
  updatedAt: string;
  /**
   * The ARCHIVED state (bug MOTIR-2050) — `null` for a live item, which is also
   * the predicate the panel gates on (`archived != null`). An archived item is
   * reachable in the peek (an archived `motir:` reference chip opens one, and the
   * detail read doesn't filter `archivedAt`), but the payload carried no archived
   * field at all: the peek showed an archived item as an ordinary — even "Ready to
   * start" — one. Both facts ride the SAME detail aggregate the mapper already
   * receives (`item.archivedAt` + `detail.archivedBy`, the pair the detail page's
   * banner reads), so this costs no extra read. `atLabel` is formatted server-side
   * (locale-aware, like `dueLabel`); `byName` is `null` when no `'archived'`
   * revision resolved an actor, and the notice then names a former member.
   */
  archived: { atLabel: string; byName: string | null } | null;
  parent: { identifier: string; title: string; kind: WorkItemKindDto } | null;
  /** The folder the item is filed in, or `null` (Story MOTIR-5308 · MOTIR-5352). */
  folderId: string | null;
  /** That folder's name and every ancestor's, ROOT FIRST; `[]` when unfiled. */
  folderPath: string[];
  /**
   * The ready/blocked readiness signal (Subtask 2.5.21), shaped for the shipped
   * ReadinessBadge. `ready` is the service verdict (true when the item has no
   * blockers OR every blocker is terminal — bug-ready-banner-no-deps) and
   * `blockers` names the OPEN (non-terminal) blockers; the panel maps each to a
   * `?peek=` swap-peek href (so a blocker link swaps the peeked item in-list,
   * never leaving the surface — the 2.5.20 design's justified deviation from the
   * detail-page badge, which links to `/items/[key]`). The panel suppresses the
   * banner once the item leaves the `todo` category (see `statusCategory`):
   * "can I start this?" is moot for an item already in progress or done. `null`
   * only when the read carried no readiness verdict at all.
   *
   * `blockedByAncestor` (Subtask 7.0.13) is the nearest blocked ANCESTOR when the
   * item's OWN blockers are clear but a blocked parent / grandparent holds it out
   * of the ready set (the readiness cascade). The banner falls back to naming it
   * so a cascade-blocked item isn't a bare "Blocked"; `null` otherwise.
   */
  readiness: {
    ready: boolean;
    blockers: string[];
    blockedByAncestor: { id: string; identifier: string; title: string } | null;
  } | null;
  /**
   * The Development section's linked PRs (Story 7.10 · MOTIR-1579),
   * newest-updated first. Empty → the section renders its EmptyState
   * (design/github Panel 4a).
   */
  pullRequests: LinkedPullRequestDto[];
  /**
   * Every repository the item ships in, with each one's DELIVERY state (Story
   * MOTIR-2725 · MOTIR-2416) — the SAME value the detail page renders, resolved
   * by the same `workItemsService.listRepoDelivery`.
   *
   * The peek COMPRESSES how it is drawn (a row cap, a shorter caption — design
   * MOTIR-2414), never what it says: the two surfaces read one field so they
   * cannot disagree about whether a repository has landed.
   */
  repoDelivery: RepoDelivery[];
  /** The card's DELIVERY SET (Story MOTIR-3655 · MOTIR-3660) — every pull request
   *  recorded as delivering it. The peek draws the same Development rows and the
   *  same rail caption the detail page does, from the same list. Empty on nearly
   *  every card, which is the shipped behaviour unchanged. */
  deliveries: WorkItemDeliveryDto[];
  /**
   * The card's CURRENT design result, read only when a linked pull request is
   * open (`design-result.md` AMENDMENT 4 Q8) — the peek's Development block then
   * shows it as its slot, as the detail page does. Absent or null otherwise.
   */
  designEvidence?: DesignEvidenceDTO | null;
  /**
   * What a reload knows about each member of the card's APPROVED approve-and-merge gate
   * (Bug MOTIR-5650) — read by `pullRequestApprovalMembersService.listForLatestGate`, the
   * same facts the detail page's Development frame reads, so a row says *Queued to merge* /
   * *Not merged yet* in both places. Absent or empty for any other gate state, a card with
   * no linked pull request, and a PROPOSAL.
   */
  mergeMembers?: PullRequestApprovalMemberDTO[];
  /**
   * Does the item already have children (MOTIR-910)? The peek header's
   * Plan / Re-plan entrance picks its face from this — an item with children is
   * RE-planned, one without is planned. Derived from the same detail aggregate
   * (`detail.children`), so it costs no extra read; the peek's own body still
   * renders no child list (that stays detail-only).
   */
  hasChildren: boolean;
  /**
   * May this actor open the planning workspace on the item (MOTIR-910)? The
   * planning conversation PROPOSES changes to the plan, so it rides the
   * project's `canEdit` capability — a browse-only viewer sees no door rather
   * than one that errors on the first turn.
   */
  canPlan: boolean;

  // ── EDITOR INPUTS (MOTIR-2562) ─────────────────────────────────────────────
  // The raw current values + option sources the editable rail's controls need.
  // Everything here rides the SAME detail aggregate the display strings above
  // are derived from, EXCEPT `sprints` and `projectComponents`, which are two
  // additional project-scoped reads the service performs (see getQuickView).

  /**
   * The current status KEY (e.g. `in_progress`) — `StatusPicker`'s `value`.
   * `statusLabel` / `statusCategory` above stay the DISPLAY pair; a picker
   * cannot select against a label.
   */
  status: string;
  /** `AssigneePicker`'s current selection; `assigneeName` above is its display. */
  assigneeId: string | null;
  /** `ParentPicker`'s current selection; `parent` above is its display. */
  parentId: string | null;
  /** `SprintPicker`'s current selection; `sprintName` above is its display. */
  sprintId: string | null;
  /** The raw ISO due date — `DatePicker`'s value; `dueLabel` is its display. */
  dueDate: string | null;
  /** The raw minutes — the numeric input's value; `estimateLabel` is its display. */
  estimateMinutes: number | null;
  /**
   * The project's workflow — statuses, transitions and `policyMode`, the exact
   * three props `StatusPicker` takes so it can offer only the LEGAL targets from
   * the current status. Rides `detail.workflow`, which the mapper already
   * receives and today reads only to resolve one label.
   */
  workflow: WorkflowDto;
  /**
   * The assignable workspace members — `AssigneePicker`'s options. Already
   * resolved by the service (it uses them to build the name lookup); this
   * exposes the list the picker needs rather than re-reading it.
   */
  members: WorkspaceMemberDTO[];
  /**
   * The project's sprints — `SprintPicker`'s options. One of the two NEW reads
   * this payload costs; the service already resolved the committed sprint's
   * NAME, and this widens that to the list.
   *
   * ⚠️ Deliberately a `QuickViewSprintOption[]`, NOT `SprintDto[]`. The full DTO
   * carries `issueCount`, and the only way to produce it —
   * `sprintsService.listByProject` — runs ONE count query PER SPRINT (MOTIR has
   * 45). That is a 1+N fan-out on a `no-store` payload fetched on every row
   * click, to fill a field `SprintPicker` never reads: it uses `id`, `name`,
   * `state` and `sequence` (which orders the planned ones) and nothing else. So
   * the peek reads the sprint rows off the leaf and projects exactly those four.
   */
  sprints: QuickViewSprintOption[];
  /**
   * The project's component taxonomy — the `MultiSelectPicker`'s option source
   * for the Components row. The second NEW read. (Labels need no list: the
   * label control autocompletes per keystroke against the project route, which
   * `projectIdentifier` above already scopes.)
   */
  projectComponents: ComponentDto[];
  /**
   * The project's estimation config + this actor's edit capability (MOTIR-2593),
   * so the peek can provide it to the `EstimateBadge` its Story-points row
   * composes.
   *
   * ⚠️ It has to ride the payload. `EstimationConfigProvider` is mounted in three
   * places on `origin/main` — the backlog page, the item detail page and
   * `IssueTreeSection` — and the peek is mounted from six, none of them inside
   * that tree section. Outside a provider `useEstimationConfig()` falls back to
   * `{ story_points, fibonacci, [], canEdit: false }`, which is the right default
   * for a drag preview and WRONG here: the badge would render, look correct, show
   * the project's real number, and be permanently inert — with no error, no failed
   * test, and the project's actual statistic and deck ignored. A silent read-only
   * is the failure mode this field exists to prevent.
   */
  estimation: EstimationConfigDto & { canEdit: boolean };
}

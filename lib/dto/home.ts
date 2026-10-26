import type { FixDetailDto, WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import type { OpenRepairRunDto } from '@/lib/dto/workItemRepair';
import type { PlanAuthorSourceDto, PlanOriginDto } from '@/lib/dto/plans';
import type { PlanProgressSnapshot } from '@/lib/plans/planProgress';
import type { ToResumeForm } from '@/lib/planChange/toResumeForm';
import type { ApprovalGateKindDTO, ApprovalGateStateDTO } from '@/lib/dto/approvalGate';
import type {
  ExecutorDto,
  WorkItemKindDto,
  WorkItemPriorityDto,
  WorkItemTypeDto,
} from '@/lib/dto/workItems';

// Wire DTOs for the Home domain (Story MOTIR-2649 · Subtask MOTIR-2651) — the
// signed-in landing surface's two personal reads. `homeService` maps Prisma rows
// to these via `lib/mappers/homeMappers.ts` just before returning (CLAUDE.md —
// services never return raw Prisma models). Dates are ISO strings, matching the
// work-items / notifications DTO convention.
//
// ⚠️ This is a SEPARATE row shape from `WorkItemListItemDto`, deliberately, and
// the reason is worth stating once. Home's row is not the `/items` row: it ADDS
// the owning project (a project-scoped list never needs to say which project it
// is in) and the reader's own relation to the item, and it DROPS `hasDescription`
// and `dueDate` — the first because it exists to drive the `/items` row ⋯ menu,
// which `design/home/` does not draw, and the second because Home's column set
// has no Due cell. Widening the shared DTO instead would have put two fields on
// every tree/list/archived row in the product to serve one surface.

/** The owning project, as Home's row identifies it (the design's Project cell). */
export interface HomeProjectRefDto {
  id: string;
  /** The `MOTIR` / `ATLAS` project key — the prefix the item's identifier carries. */
  identifier: string;
  name: string;
}

/**
 * One row of My work or Watching.
 *
 * **`viewerIsAssignee` / `viewerIsReporter` are BOTH carried, and both can be
 * true.** That is the whole point of the merged read: an item where the reader
 * is assignee AND reporter comes back exactly ONCE, and these two booleans are
 * how the row still says both things about it. A renderer derives the design's
 * "Your role" cell from the pair (`Assigned` · `Reported` · `Both`); the service
 * does not pre-compute a label, so the copy stays a UI decision.
 *
 * On the WATCHING read both flags are still resolved against the same reader —
 * an item the reader watches but does not own carries `false`/`false`, and one
 * they watch AND own carries the same pair My work would give it. Watching is a
 * different audience, not a partition of My work.
 */
export interface HomeWorkItemRowDto {
  id: string;
  kind: WorkItemKindDto;
  /** The leaf's work TYPE (`code` / `design` / …); `null` on containers. */
  type: WorkItemTypeDto | null;
  key: number;
  identifier: string;
  title: string;
  /** The raw workflow status KEY (not the label) — the caller resolves display. */
  status: string;
  /** The item's CI verdict over its whole delivery set (`WorkItem.ciState`,
   *  MOTIR-5470) — the Workbench row's CI badge (MOTIR-5475). The row draws the
   *  GLYPH form only, and only `failing` / `running` off the `done` category
   *  (`ciBadgeState`), which is why *Recently finished* needs no special case. */
  ciState: string | null;
  /** Why the card is stuck until something is repaired (`WorkItem.fixReason`,
   *  MOTIR-6600), or `null` when nothing is. The To fix tab lists by it; the other
   *  tabs carry it because every tab shares this row. */
  fixReason: WorkItemFixReasonDto | null;
  /** What the To fix row names for that reason — `null` exactly when `fixReason` is. */
  fixDetail: FixDetailDto | null;
  /**
   * Whether this row may OFFER Continue hosted (MOTIR-6882): a dead run with a branch
   * to continue (`fixReason === 'run_died'`, `fixDetail.repair === 'continue'`) on a
   * project where the reader holds `work_item:edit` — the item page's own door rule.
   * Decided only by the To fix read (once per distinct project on the page); `false`
   * on every other tab's rows.
   */
  canContinueHosted: boolean;
  /**
   * Whether this row may OFFER *Fix on the hosted agent* (Story MOTIR-1626 · MOTIR-6930;
   * `design/workbench` § 32): a card a REVIEW sent back — `changes_requested` on the
   * review agent's or the approve-and-merge gate, repaired by `motir fix` — on a project
   * where the reader holds `work_item:edit` (the Run hosted rule). Decided only by the To
   * fix read; `false` on every other tab's rows.
   */
  canFixHosted: boolean;
  /**
   * TO FIX ONLY (MOTIR-7589; `design/workbench/design-notes.md` § 34): the kind of entry
   * this row heads — `run` (one dead run), `prs` (one pull-request set) or `card` (a card
   * alone). `null` on every other tab.
   */
  fixGroupKind: 'run' | 'prs' | 'card' | null;
  /**
   * TO FIX ONLY: the OTHER cards stuck in this entry, in the entry's order (the reader's
   * own first) — the member list under the fix line. Each is a full row: the line draws
   * its kind, key, title, the reader's role, its assignee and its status. Empty for a card
   * alone, and on every other tab.
   */
  fixMembers: HomeWorkItemRowDto[];
  /**
   * Whether the card waits To resume (Story MOTIR-7701 · MOTIR-7707): its latest run
   * stopped at an approval gate, `waiting_on_gate` until one of the gates that held it
   * is approved and `ready_to_resume` after. `null` when it does not wait.
   */
  resumeState: 'waiting_on_gate' | 'ready_to_resume' | null;
  /** The gated run that state is about — the To resume entry's key. `null` exactly when
   *  `resumeState` is. */
  resumeRunId: string | null;
  /**
   * TO RESUME ONLY: the OTHER cards waiting on the same gated run, in the entry's order —
   * the member list under the entry, as `fixMembers` is on To fix. Empty elsewhere.
   */
  resumeMembers: HomeWorkItemRowDto[];
  /**
   * TO RESUME ONLY, on a MEMBER of a gated SCOPE run's entry (MOTIR-8458;
   * `design/workbench/design-notes.md` § 39.4): `added` — the run never touched it (a
   * plan added it, or the run never reached it); `rescoped` — the run touched it and a
   * plan approved after the run stopped changed it. Absent or `null` otherwise.
   */
  resumeChange?: 'added' | 'rescoped' | null;
  /**
   * TO RESUME ONLY, on the entry's head (MOTIR-8458; § 39.3): every plan approved AFTER
   * the gated run stopped that added, changed or removed work in its scope, oldest
   * approval first. Empty when none did — the entry then draws no banner.
   */
  resumeReshapedBy?: ResumeReshapePlanDto[];
  /**
   * TO RESUME ONLY, on the entry's head: the newest AUTOMATIC resume an approval
   * attempted for its gated run (MOTIR-7710) — `started` reads *Resuming*, `skipped`
   * *Could not resume* with its reason. Absent when none was attempted (a run that
   * was not hosted, or a gate not yet approved) and on every other tab.
   */
  resumeAttempt?: GateResumeAttemptDto | null;
  /**
   * TO RESUME ONLY, on the entry's head (MOTIR-7712; `design/workbench/design-notes.md`
   * § 35.4): who ran the gated run and where, its branch, and the gates that hold it, as
   * they stand now. Absent on every other tab.
   */
  resumeRun?: ResumeRunDto | null;
  /**
   * THE GROUPED WORK TABS ONLY — To do, In progress, Recently finished (Story MOTIR-8012 ·
   * MOTIR-8015; `design/workbench/design-notes.md` § 36): whether this row HEADS a group of
   * the tab's items. `'member'` — the row is on the tab AND heads tab items, drawn once;
   * `'context'` — the row is NOT on the tab, and is here only so its members have their
   * runnable container. `null` on a standalone row, and on every other tab.
   */
  groupHead: 'member' | 'context' | null;
  /**
   * THE GROUPED WORK TABS ONLY: the tab's items under this head, in group order, the head
   * excluded. The group row's count IS `groupMembers.length` — there is no separate count
   * field, so the count cannot disagree with the list. Empty on a standalone row and on
   * every other tab.
   */
  groupMembers: HomeWorkItemRowDto[];
  /** The OPEN repair on a sent-back row — the lock that replaces both repairs while it
   *  runs (`hosted-agent-run.md` §8.6). Read only by the To fix read; `null` elsewhere. */
  repairRun: OpenRepairRunDto | null;
  priority: WorkItemPriorityDto;
  assigneeId: string | null;
  reporterId: string;
  /**
   * WHO executes it — `coding_agent` | `human` | null. Carried so the row can
   * render the agent treatment `design/home/` specifies (a badge on the
   * assignee avatar). An agent-executed item is returned by these reads like
   * any other; it is never filtered out and never sectioned off.
   */
  executor: ExecutorDto | null;
  storyPoints: number | null;
  estimateMinutes: number | null;
  /** ISO-8601 last-modified stamp — the page cursor's axis on three of the four reads. */
  updatedAt: string;
  /**
   * ISO-8601 moment this item ENTERED a done-category status (MOTIR-4780), or
   * `null` on everything that has not finished.
   *
   * Carried on EVERY row rather than only on Recently finished ones, because
   * the four tabs share one row shape and one projection — a second DTO for the
   * one tab that renders a finish date would be the drift `HOME_WORK_ITEM_SELECT`
   * exists to prevent. It is also the axis the Recently-finished page cursor
   * keys on, so a caller that needs to reason about the boundary has the value
   * the boundary is made of.
   */
  completedAt: string | null;
  project: HomeProjectRefDto;
  viewerIsAssignee: boolean;
  viewerIsReporter: boolean;
}

/**
 * One OFFSET-paged window of a personal read (finding #57 — never a load-all).
 *
 * ⚠️ THIS WAS A KEYSET, AND THE TRADE IS DELIBERATE (MOTIR-4852). It carried an
 * opaque `nextCursor` encoding `(updatedAt, id)` — the exact pair the reads
 * order by — because a keyset keeps a page boundary stable while items are
 * updated underneath the reader. It can only ever offer NEXT, though: a keyset
 * has no notion of "page 7", so a reader could not see how far a tab went, jump,
 * or step back. The Workbench is not a feed — it is a bounded personal list
 * whose totals the tab strip already computes — so page numbers, a total and a
 * back button are worth a small amount of drift risk. On something unbounded the
 * trade would run the other way.
 *
 * The shape is `/items`' own (`PagedIssueListDto`), deliberately: one paging
 * vocabulary across the product, and `IssueListPager` consumes it unchanged.
 *
 * `page` is 1-based and CLAMPED — see `homeService`'s note on why an
 * out-of-range page lands on the last page rather than on an empty one.
 */
export interface HomePageDto {
  items: HomeWorkItemRowDto[];
  /**
   * The reader's FAILED planning sessions that fall in this window (Story MOTIR-7905 ·
   * MOTIR-7914). Only `listToResume` fills it, and only when the reader has any; every
   * other tab's page leaves the key absent. A session is not a work item, so it does not
   * ride `items` — it is windowed WITH the gated runs, ahead of them, so the one `total`
   * and the shipped pager are unchanged.
   */
  planningSessions?: ToResumePlanningSessionDto[];
  /**
   * The size of the whole SET this page is a window on — the pager's denominator. On
   * To do, In progress and Recently finished it counts GROUPS (a standalone row is a
   * group of one; MOTIR-8015), as it counts entries on To fix and To resume. The strip
   * counts (`HomeTabCountsDto`) stay item counts, so the two may differ by design.
   */
  total: number;
  /** The 1-based page actually served, after clamping. */
  page: number;
  /** The window size — `HOME_PAGE_SIZE` unless the caller narrowed it. */
  pageSize: number;
}

/**
 * ONE failed hosted planning session waiting for its owner to Resume it — an entry of the
 * Workbench's To resume tab (Story MOTIR-7905 · MOTIR-7914). The naming fields are the
 * shape {@link WorkbenchPlanningRowDto} carries, so the entry composes § 29's plan-naming
 * forms from the same fields; `failure` is exactly what the session stored, untranslated.
 */
export interface ToResumePlanningSessionDto {
  sessionId: string;
  /** WHICH of the three forms this entry is (MOTIR-7939; decision MOTIR-7906): a failed walk
   *  to Resume, a failure beside a plan that waits for approval, or a session that ended
   *  `failed` before MOTIR-7905 and still holds one. Derived, never stored. */
  form: ToResumeForm;
  /** The plan the entry OPENS ON — a `failed_walk`'s `generating` plan, otherwise the waiting
   *  plan — or null when the session wrote none. */
  planId: string | null;
  /** The opened plan's `Plan.title`, as written, or null. */
  title: string | null;
  /** The session's most recent `planned` / `stale` plan, or null — the second line of a
   *  `failed_walk` entry that also holds one, and the entry's own plan on the other two forms. */
  waitingPlan: { planId: string; title: string | null; status: 'planned' | 'stale' } | null;
  /** The project's name — the leading line's last fallback. */
  projectName: string;
  /** The session's `targetKeys` in stored order, each with the target's title
   *  (null when the key no longer resolves in the project). */
  targets: { key: string; title: string | null }[];
  /** What the session stored, untranslated; null only on `ended_with_waiting_plan`, whose
   *  failure record was cleared when the session ended. */
  failure: {
    /** ISO-8601. */
    failedAt: string;
    /** The stable reason code as stored (`rate_limited`, `out_of_credits`, …). */
    reason: string;
    stopPhase: 'lay' | 'author' | null;
    stopRef: string | null;
    stopTitle: string | null;
  } | null;
  /** ISO-8601 — when the session ended; set only on `ended_with_waiting_plan`. */
  endedAt: string | null;
  /** The ONE progress derivation's snapshot (design: *N of M written*) — asked only for a
   *  `failed_walk`; null when the plan has none to give or the form carries none. The entry is
   *  NOT dropped: the plan is still the person's work. */
  progress: PlanProgressSnapshot | null;
}

/**
 * ONE plan the reader asked for that is still being written — a row of the
 * Workbench's Planning tab (Story MOTIR-7820 · MOTIR-7828).
 *
 * The naming fields (`title`, `projectName`, `targets`) are the shape
 * `PlanApprovalSubjectSummaryDTO` already carries, so the tab composes § 29's
 * plan-naming forms from the same fields the To-approve plan row reads.
 */
export interface WorkbenchPlanningRowDto {
  planId: string;
  /** The plan's conversation (the `planSession` address), or null when it has none. */
  sessionId: string | null;
  /** `Plan.title`, as written, or null. */
  title: string | null;
  /** The project's name — the leading line's last fallback. */
  projectName: string;
  /** The session's `targetKeys` in stored order, each with the target's title
   *  (null when the key no longer resolves in the project). */
  targets: { key: string; title: string | null }[];
  /** Who is WRITING the plan. `model` is carried (unlike the To-approve row) because
   *  the story names an MCP planner by its harness AND its model. */
  author: {
    source: PlanAuthorSourceDto | null;
    harness: string | null;
    model: string | null;
    origin: PlanOriginDto;
  };
  /** ISO-8601 — when the plan was asked for. */
  createdAt: string;
  /** The ONE progress derivation's snapshot, carried unmodified from
   *  `planProgressService.snapshotsForPlans`. Never null: a row without one is dropped. */
  progress: PlanProgressSnapshot;
}

/** One offset window of the reader's plans being written — {@link HomePageDto}'s
 *  shape, so the shipped pager consumes it unchanged. */
export interface WorkbenchPlanningPageDto {
  items: WorkbenchPlanningRowDto[];
  /** The size of the whole set — the same number `HomeTabCountsDto.planning` is. */
  total: number;
  /** The 1-based page actually served, after clamping. */
  page: number;
  /** The window size — `HOME_PAGE_SIZE` unless the caller narrowed it. */
  pageSize: number;
}

/**
 * The size of each tab's SET (Subtask MOTIR-2653) — not of the current page.
 *
 * Both numbers ride together because the tab strip shows the size of the tab
 * the reader is NOT on as well as the one they are: that is what makes
 * switching an informed choice rather than a guess. `design/home/` suppresses
 * both when they are zero — a "0" beside a tab is noise a new user has to parse.
 */
export interface HomeTabCountsDto {
  /**
   * ⚠️ TRANSITIONAL, and owned by MOTIR-4782. The shipped `/home` page still
   * renders two tabs, and this card is backend-only — so the old number
   * survives beside the new ones until the page it feeds is replaced. It is
   * exactly `toDo + inProgress + toFix`, computed from the same round trip rather than
   * from a fifth query, so the two can never disagree.
   *
   * @deprecated Remove with `/home` when MOTIR-4782 lands `/workbench`.
   */
  myWork: number;
  /** Nothing has been started. */
  toDo: number;
  /** In flight — including the cards an agent has finished and a person has not looked at.
   *  Excludes {@link HomeTabCountsDto.toFix}, which is carved out of it. */
  inProgress: number;
  /** Stuck until something is repaired — the in-progress cards whose `fixReason` is set
   *  (MOTIR-6604). Counted with the list's own slice, so it equals `listToFix().total`. */
  toFix: number;
  /** Waiting on an approval gate — one per gated RUN whose cards wait To resume
   *  (MOTIR-7707), PLUS one per failed planning session of the reader's (MOTIR-7914): the same
   *  number `listToResume().total` returns. Carved out of In progress. */
  toResume: number;
  /** Finished inside the rolling window (`HOME_FINISHED_WINDOW_DAYS`). */
  recentlyFinished: number;
  /**
   * What is waiting on YOU to approve — the count of `awaiting` approval gates
   * ROUTED to this reader in the active project (MOTIR-4794).
   *
   * ⚠️ IT WAS HARDWIRED TO `0` UNTIL THIS CARD, as a declared scope boundary:
   * MOTIR-4777 drew the tab's SLOT and shipped nothing behind it. It is now
   * `approvalGateRepository.countAwaitingRoutedTo`, the SAME predicate and the
   * same builder `approvalGatesService.listAwaitingMe` pages — one question, so
   * the badge and the list cannot disagree.
   *
   * ⚠️ AND IT IS NOT COUNTED LIKE THE FOUR AROUND IT. They are
   * assignee-OR-reporter over work items; this is `assigneeId ?? reporterId`
   * over GATES (ADR §2). The divergence is deliberate and recorded there: a work
   * list may show you your own item twice, and a decision queue may not show one
   * gate to two people.
   */
  approvals: number;
  watching: number;
  /**
   * The plans this reader ASKED FOR that are still being written in the active
   * project (Story MOTIR-7820 · MOTIR-7828) — `planRepository.countGeneratingRequestedBy`,
   * the same builder `workbenchPlanningService.listMyPlansBeingWritten` pages, so it
   * equals that read's `total`.
   *
   * ⚠️ NOT A LANDING RUNG. It rides here because the strip renders every tab's count
   * from this one DTO; `LandingCounts` (`lib/workbench/landing.ts`) is a `Pick` that
   * leaves it out, because a plan being written needs nothing from the reader.
   */
  planning: number;
}

/** A gated run, as its To resume entry draws it (MOTIR-7712; § 35.4). */
export interface ResumeRunDto {
  /** Where it ran — the aside's *ran it on the hosted agent / from a terminal / with the
   *  runbook / in {agent}*, read from the run's `origin` and who reported it. */
  ranWhere: 'hosted' | 'terminal' | 'runbook' | 'instance';
  ranById: string | null;
  ranByName: string | null;
  /** The agent instance's name, for `instance`; null otherwise. */
  agentName: string | null;
  /** The primary repository's branch the run left, or null when none is known. */
  branch: string | null;
  /** The gates holding it, decided first (approved, then sent back, then waiting). */
  gates: ResumeGateDto[];
}

/**
 * One plan that re-shaped a gated scope run's story after the run stopped (MOTIR-8458;
 * § 39.3) — the banner's line. The counts are the plan's proposals in that scope: `add`,
 * `modify` and `remove`; a plan with all three at zero is never listed.
 */
export interface ResumeReshapePlanDto {
  planId: string;
  title: string | null;
  /** ISO-8601 — when the plan was approved. */
  approvedAt: string;
  added: number;
  changed: number;
  removed: number;
}

/** One gate a gated run stopped at, as it stands NOW (MOTIR-7703 · MOTIR-7712). */
export interface ResumeGateDto {
  /** The LATEST gate of its kind on its card — a republish's, not the superseded one. */
  gateId: string;
  kind: ApprovalGateKindDTO;
  state: ApprovalGateStateDTO;
  /** The card the gate is on. */
  subjectKey: string;
  subjectTitle: string;
  /** Who decides it — the card's assignee, else its reporter (`docs/approval-gates.md`). */
  deciderId: string | null;
  decidedById: string | null;
  /** The decider as recorded when no person decided (an agent, the system). */
  decidedByLabel: string | null;
  decidedAt: string | null;
  /** The decision's note, first line, cut short — the sent-back quote. */
  notePreview: string | null;
}

/**
 * A card's gated run, as its item page's run section draws it (MOTIR-7713; `design/runs`
 * § _Stopped at a gate_). The same run the card's To resume entry is about.
 */
export interface ItemGatedRunDto {
  /** `resuming` — the card's current run is the continue an approval started (G3). */
  state: 'waiting_on_gate' | 'ready_to_resume' | 'resuming';
  /** The GATED run. */
  runId: string;
  /** The continue that carries it on, while `resuming`; null otherwise. */
  resumedRunId: string | null;
  /** The run's SCOPE when it is another card — this card was one of its legs (G6). */
  parent: { key: string } | null;
  run: ResumeRunDto;
  attempt: GateResumeAttemptDto | null;
  /** The display name of every person the gates name (deciders and decided-bys), by id. */
  names: Record<string, string>;
}

/** One automatic resume attempt, as the To resume entry reads it (MOTIR-7710). */
export interface GateResumeAttemptDto {
  outcome: 'started' | 'skipped';
  /** Why nothing started — null exactly when `outcome` is `started`. */
  skipReason:
    | 'dispatcher_gone'
    | 'no_project_access'
    | 'ci_credits_exhausted'
    | 'out_of_credits'
    | 'credits_unavailable'
    | 'model_not_offered'
    | 'models_unavailable'
    | 'repository_not_writable'
    | 'card_not_ready'
    | 'already_resumed'
    | 'not_resumable'
    | 'no_capacity'
    | null;
  /** What the line names (the dispatcher, the model, the repository, the refusal). */
  detail: string | null;
  /** The hosted continue it started. */
  resumedRunId: string | null;
  createdAt: string;
}

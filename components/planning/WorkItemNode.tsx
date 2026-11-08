'use client';

import { SurfaceTitle } from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';
import { EpicNotPublicPill } from '@/components/issues/EpicNotPublicPill';
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleDashed,
  Copy,
  Flag,
  Folder,
  FolderOpen,
  FolderPen,
  Layers,
  MapPin,
  Sparkles,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { useToast } from '@/components/ui/Toast';
import { isPlainPrimaryClick } from '@/lib/hooks/useOpenPlanningWorkspace';
import { usePlanCheck } from '@/lib/hooks/usePlanCheck';
import { CantPlanAlert } from '@/components/planning/CantPlanAlert';
import type { WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { RunTonePill } from '@/components/runs/RunTonePill';
import type { RunTone } from '@/lib/runs/timeline';
import { isManualReadyItem } from '@/lib/dto/ready';
import type { ExecutorDto, WorkItemTypeDto } from '@/lib/dto/workItems';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { IssueType } from '@/lib/issues/parentRules';
import { NODE_H, NODE_W } from '@/lib/planning/projectCanvasModel';
import { FolderPathLabel } from '@/components/planning/FolderPlacement';
import { BlockedTag, WorkItemStateTags } from '@/components/workItems/WorkItemStateTags';
import { isToPlanStory, statusSlotOf } from '@/lib/workItems/statusSlot';

// The CONTENT of a WORK-ITEM node on the project roadmap (Subtask 7.20.2 /
// MOTIR-1194) — the card the reusable `ProjectRoadmapCanvas` renders for an epic /
// story / subtask (the tier/design/plan stations render as `StationCard` instead).
// It owns the card's look in the shipped StationCard language: the kind-coloured
// tile (the kind's `--el-type-*` hue via `IssueTypeIcon`), the identifier + title,
// the status pill, and the drill affordance when the node has children. The canvas
// owns the box, position, drag, and the search-match ring. Tokens only.
//
// Subtask 7.20.6 / MOTIR-1013 adds two roadmap markers: a per-container PROGRESS
// meter (the subtree done/total bar on an epic/story) and the "YOU ARE HERE"
// current-position marker (the active node — the card gets an accent border and
// `aria-current="step"`, and since MOTIR-10630 it wears the "You are here" TAB on its
// top edge, so its status pill stays in the slot).
//
// MOTIR-1379 (follow-up) adds the "NOT IN SPRINT" marker for the sprint-scoped
// roadmap: drilling into a committed root reveals its WHOLE subtree, so a
// drilled-in node the sprint did not commit to is shown with a DOTTED border + a
// receded `--el-muted` fill + a "not in sprint" tag and NO shadow (flat) — an
// informational signal, kept deliberately distinct from the red cross-blocked
// (broken-dependency) chrome. The shadow is dropped so a hard offset-shadow style
// (neo-brutalism) can't add a solid frame that reads as a second border.

/** A container's subtree done/total roll-up — the data behind the progress meter
 *  (Subtask 7.20.6 / MOTIR-1013). Mirrors `RoadmapProgress` in `roadmapClient`;
 *  kept local so the presentational node has no upward data dependency. */
export interface WorkItemProgress {
  done: number;
  total: number;
  /** The CI-verified subset of `total` (Subtask 7.10.6 / MOTIR-894) — the
   *  Story-level "N of M verified" count. Optional + `0` until CI feeds signals
   *  back; a positive value renders a small verified badge beside the meter. */
  verified?: number;
}

export interface WorkItemNodeData {
  id: string;
  identifier: string;
  title: string;
  kind: IssueType;
  /** The workflow status KEY, verbatim (bug MOTIR-3170). This used to be a CLOSED
   *  six-member union — `todo · in_progress · in_review · blocked · done ·
   *  cancelled` — which every producer had to satisfy, so each of them coerced
   *  anything else to `todo` and the canvas confidently drew a card whose pull
   *  request was open as **To Do**. Statuses are DATABASE-defined (a project
   *  configures its own workflow), so no union here can ever be total; the chip
   *  resolves a treatment at render time instead. */
  status: string;
  /** The status's own display LABEL, as the level read carried it from the
   *  project's workflow. Optional: a node built without it (onboarding / a plan
   *  preview) falls back to the translated catalog label for a default key. */
  statusLabel?: string | null;
  /** The status's lifecycle CATEGORY — the chip's fallback tone for a key the
   *  canvas has no per-key treatment for (see `statusLabel`). */
  statusCategory?: StatusCategoryDto | null;
  /** The work TYPE (Story 2.7) — drives the MANUAL / human chip (MOTIR-1642 /
   *  8.8.36), paired with `executor` via the shipped `isManualReadyItem`
   *  predicate. Optional: a node built without it (onboarding / plan preview)
   *  simply shows no chip. */
  type?: WorkItemTypeDto | null;
  /** WHO executes the work — `human` (or `type: 'manual'`) makes the node
   *  human-gated, so it carries the Manual chip. Optional (see `type`). */
  executor?: ExecutorDto | null;
  assigneeName?: string | null;
  /** Has children (the level read's `hasChildren`). Together with the kind and the
   *  status category it decides TO PLAN (MOTIR-10508): a story KNOWN to have no
   *  children. Optional: a node built without it never claims To plan. */
  hasChildren?: boolean;
  /** Why the card is stuck until something is repaired (MOTIR-6600) — a
   *  `ci_failed` / `changes_requested` card offers `motir fix` (MOTIR-10509). */
  fixReason?: WorkItemFixReasonDto | null;
}

// The per-status treatment map that used to live here now lives in
// `lib/workflows/canvasStatusMeta.ts` (bug MOTIR-3170), for the reason the note
// on `WorkItemNodeData.status` gives: it was a `Record<ClosedUnion, …>`, which
// the compiler certifies as TOTAL against a union that is itself the
// hand-authored subset — so the one check that could have caught a missing
// status was structurally unable to. The resolver is shared with `PlanItemNode`
// so the canvas has ONE status vocabulary rather than three.

/**
 * The kind TILE's fill, by kind — declared ONCE, here (MOTIR-6296, absorbing bug
 * MOTIR-6196). `PlanItemNode` used to declare an identical copy, which is how a
 * proposal and a committed card became two drawings; both now draw their tile
 * through {@link WorkItemCardShell}, and `plan-item-node-shell.test.tsx` fails a
 * second declaration of this map anywhere under `components/`.
 */
export const KIND_TINT: Record<IssueType, string> = {
  epic: 'bg-(--el-tint-rose)',
  story: 'bg-(--el-tint-mint)',
  task: 'bg-(--el-tint-sky)',
  bug: 'bg-(--el-tint-peach)',
  subtask: 'bg-(--el-tint-lavender)',
};

// The status chip, the slot pills (Done / To plan / Ready) and the Manual chip
// moved to `components/workItems/WorkItemStateTags.tsx` (MOTIR-10534), so the
// /boards card, the quick view and the item page draw an item's state the way this
// card does. They are re-exported here for the callers that already import them.
export { WorkItemStatusPill } from '@/components/workItems/WorkItemStateTags';
export { isToPlanStory } from '@/lib/workItems/statusSlot';

/** One work item's disposition in a dispatch RUN, already resolved to a tone and
 *  a localized label by the consumer (MOTIR-3895). */
export interface RunLegBadge {
  tone: RunTone;
  label: string;
}

/**
 * The card's NEXT-ACTION button, opted into by a consumer (MOTIR-10509; design
 * MOTIR-10508 § "The next-action button"). Only the roadmap page passes it, and
 * never for a Visitor: the button copies an agent command or opens planning, and
 * a reader with no commands to run must not be offered either.
 */
export interface CardNextActionsOption {
  /** May the reader open the planning overlay (the project's AI is configured and
   *  the reader is a member)? `false` draws no Plan button on a To plan card. */
  plan: boolean;
}

/** WHAT the next-action button does on one card (design table, checked top to
 *  bottom). `null` draws no button. */
export type CardNextAction =
  | { kind: 'plan' }
  | { kind: 'copy'; verb: CopyActionVerb; reason: CopyActionReason | null };

/** The agent commands a copy button can carry: `motir run|review|fix <KEY>` for the
 *  coding agent, and `motir guide <KEY>` — the walk through a human card's steps —
 *  for a ready card a person must do (MOTIR-10559). */
export type CopyActionVerb = 'run' | 'review' | 'fix' | 'guide';

/** The fix reasons the card offers `motir fix` for, and whose tooltip names them. */
export type CopyActionReason = 'ci_failed' | 'changes_requested';

/**
 * The state → action mapping (design MOTIR-10508 § "The next-action button", with
 * MOTIR-10559's guide row), the rows checked top to bottom so a fix reason wins
 * over In Review, and both win over a ready card's run or guide:
 *
 * | card                                          | button               |
 * | --------------------------------------------- | -------------------- |
 * | To plan                                       | Plan (the overlay)   |
 * | fix reason `ci_failed` / `changes_requested`  | copy `motir fix`     |
 * | In Review                                     | copy `motir review`  |
 * | Ready, and not manual                         | copy `motir run`     |
 * | Ready, and manual                             | copy `motir guide`   |
 * | anything else                                 | none                 |
 *
 * "Manual" is the shipped `executor === 'human' || type === 'manual'` predicate;
 * `motir guide <KEY>` walks a person through such a card, as `motir run` hands a
 * coding card to an agent.
 */
export function cardNextAction(input: {
  toPlan: boolean;
  fixReason: WorkItemFixReasonDto | null | undefined;
  status: string;
  ready: boolean;
  manual: boolean;
  options: CardNextActionsOption | null | undefined;
}): CardNextAction | null {
  const { options } = input;
  if (!options) return null;
  if (input.toPlan) return options.plan ? { kind: 'plan' } : null;
  if (input.fixReason === 'ci_failed' || input.fixReason === 'changes_requested') {
    return { kind: 'copy', verb: 'fix', reason: input.fixReason };
  }
  if (input.status === 'in_review') return { kind: 'copy', verb: 'review', reason: null };
  if (input.ready) {
    return { kind: 'copy', verb: input.manual ? 'guide' : 'run', reason: null };
  }
  return null;
}

export function WorkItemNode({
  item,
  drillable = false,
  crossBlocked = false,
  crossBlockedSprint = false,
  notInSprint = false,
  progress = null,
  here = false,
  ready = false,
  runLeg = null,
  notPublic = false,
  nextActions = null,
}: {
  item: WorkItemNodeData;
  /** Has children — clicking DRILLS in; show the affordance. */
  drillable?: boolean;
  /** Blocked by an off-level dependency — flag it (MOTIR-1331). In project scope a
   *  bad-plan tangle; in sprint scope an out-of-sprint, not-done dependency. */
  crossBlocked?: boolean;
  /** Sprint scope (MOTIR-1379): the cross-blocked flag reads "blocker not in
   *  sprint" instead of the project-scope "blocked elsewhere" (MOTIR-1568). The
   *  copy names the out-of-sprint BLOCKER, not the card itself (which IS an
   *  in-sprint member) — distinct from the neutral `notInSprint` membership tag
   *  which reads "not in sprint" about the node (MOTIR-1582). The copy itself is
   *  resolved from the `roadmap.canvas.node` i18n catalog, not passed in. */
  crossBlockedSprint?: boolean;
  /** NOT a member of the active sprint (MOTIR-1379 follow-up) — sprint scope only.
   *  A drilled-in node under a committed root that the sprint did not itself
   *  commit to. An INFORMATIONAL, non-error signal (unlike `crossBlocked`, which is
   *  a real dependency problem): the card takes a DOTTED border + a receded
   *  `--el-muted` fill + a small "not in sprint" tag and NO shadow (flat), so the
   *  committed unit stays visually distinct from the rest of its subtree. Dropping
   *  the shadow keeps a hard offset-shadow style (neo-brutalism) from adding a solid
   *  frame that would double the dotted edge. The louder `crossBlocked` / `here`
   *  chromes win; the tag still shows alongside `here`. */
  notInSprint?: boolean;
  /** Subtree done/total roll-up → a thin progress meter on a container node
   *  (Subtask 7.20.6 / MOTIR-1013). `null` (a leaf) or a `0`-total → no meter. */
  progress?: WorkItemProgress | null;
  /** The current-position node ("you are here", the active epic at the road's
   *  start) — the card gets an accent border, carries `aria-current="step"`
   *  (Subtask 7.20.6 / MOTIR-1013) and wears the "You are here" TAB on its top
   *  edge (MOTIR-10630, design MOTIR-10629). Its status slot is the item's own,
   *  exactly as on any other card in the same state. */
  here?: boolean;
  /** READY to start (MOTIR-1417) — a startable, fully-unblocked node. Its status
   *  pill becomes the success "Ready" pill and the card gets a whole-card
   *  `--el-tint-mint` wash (MOTIR-1422). Suppressed on the "you are here" node (its
   *  accent treatment wins). */
  ready?: boolean;
  /**
   * THIS WORK ITEM'S DISPOSITION IN A RUN (MOTIR-3895) — the run modal's canvas
   * pane, and nothing else, supplies it.
   *
   * ⚠️ RESOLVED BY THE CONSUMER, not here, for the same reason `originCrumbLabel`
   * is: the tone comes from `lib/runs/timeline.ts`'s `DISPOSITION_TONE` (total
   * over the enum, so nothing invents one) and the label is localized copy, and
   * this node has neither map nor translator. Absent on every other surface, so
   * the roadmap and onboarding canvases render exactly as before.
   */
  runLeg?: RunLegBadge | null;
  /** A Visitor's PRIVATE epic (MOTIR-6170 · MOTIR-6648; design MOTIR-6641): the
   *  node wears the "Not public" pill. Its level is withheld, so it never drills. */
  notPublic?: boolean;
  /** The hover next-action button (MOTIR-10509). Absent / `null` draws none. */
  nextActions?: CardNextActionsOption | null;
}) {
  const t = useTranslations('roadmap.canvas');
  // MANUAL / HUMAN work-type chip (MOTIR-1642 / 8.8.36): a human-gated node — the
  // SHIPPED `executor === 'human' || type === 'manual'` predicate the ready-list
  // *Show instruction* keys on (8.8.10) — carries a "Manual" chip so a person
  // scanning the roadmap spots what needs THEM. Reuses the shipped `WorkItemTypeChip`
  // (no new visual). It rides the TAG ROW after the status slot (MOTIR-10508 —
  // it used to ride the body's identifier line, which the title-only body removed).
  // Nodes built without type/executor (onboarding / plan preview) show no chip.
  const isManual = isManualReadyItem({ type: item.type ?? null, executor: item.executor ?? null });
  const showMeter = progress !== null && progress.total > 0;
  const pct = showMeter ? Math.round((progress.done / progress.total) * 100) : 0;
  // DONE + READY card styles (MOTIR-1422) — both carried IN THE CARD body so they
  // survive zoom-out (the old 3px ready bar vanished) and read as opposites:
  // READY = a whole-card mint wash; DONE = a distinct `--el-tint-sky` card + struck title.
  // The accent "you are here" and the red cross-blocked flag are louder than both.
  // The slot's precedence is the shared rule (`statusSlotOf`, MOTIR-10534), so the
  // frame below and the tag row's pill can never disagree. You are here is no part
  // of it any more (MOTIR-10630): the here card's slot answers status / Done / To
  // plan / Ready like every other card's, and "here" rides its own tab.
  const slot = statusSlotOf(item, { ready, blocked: crossBlocked });
  const showDone = slot === 'done';
  // TO PLAN (MOTIR-10508): a childless `todo` story. Precedence — blocked elsewhere
  // > You are here > Done > To plan > Ready > not in sprint > normal. Blocked and
  // Here win the FRAME; the status slot keeps its own pill under both (under
  // blocked as its glyph, by the give-way rule below). A `todo` story is never
  // Done, so the Done arm cannot meet it; it is listed for the order's sake.
  const toPlan = isToPlanStory(item);
  const showToPlanPill = slot === 'to-plan';
  const showToPlanWash = showToPlanPill && !crossBlocked;
  const showReadyPill = slot === 'ready';
  const showReadyWash = showReadyPill && !crossBlocked;
  // NOT-IN-SPRINT chrome (MOTIR-1379 follow-up) — an informational, NON-error
  // signal, deliberately never the red cross-blocked chrome. The louder
  // `crossBlocked` (a real dependency problem) and `here` (the frontier) own the
  // fill, so the receded `--el-muted` fill applies only OUTSIDE them; the "not in
  // sprint" tag itself still shows alongside `here` (only the red cross-blocked
  // flag suppresses it, to avoid a double tag).
  const notInSprintChrome = notInSprint && !crossBlocked && !here;
  const showNotInSprintTag = notInSprint && !crossBlocked;
  // THE GIVE-WAY RULE (MOTIR-10508 § "When the tag row overflows"): a right-hand
  // TEXT tag (Not public, not in sprint, the blocked flag) drops the status slot and
  // the Manual chip to their glyphs. A fixed rule, not a measurement: with a
  // five-digit key, any status label plus any right-hand tag does not fit 254px.
  const glyphOnly = notPublic || showNotInSprintTag || crossBlocked;
  const nodeState = crossBlocked
    ? 'cross-blocked'
    : here
      ? 'here'
      : showDone
        ? 'done'
        : showToPlanWash
          ? 'to-plan'
          : showReadyWash
            ? 'ready'
            : notInSprintChrome
              ? 'not-in-sprint'
              : 'normal';
  const action = cardNextAction({
    toPlan,
    fixReason: item.fixReason,
    status: item.status,
    ready,
    manual: isManual,
    options: nextActions,
  });
  return (
    <WorkItemCardShell
      // The current-position node carries `aria-current="step"` (the design's
      // "You are here" semantics — a step in the journey), so AT it reads as the
      // active waypoint, not just a visual ring.
      aria-current={here ? 'step' : undefined}
      // A stable state hook for the canvas + E2E (MOTIR-1422): cross-blocked / here /
      // done / to-plan / ready / not-in-sprint / normal — the card's authoritative
      // visual state.
      data-node-state={nodeState}
      // A raised `--el-surface` tile on the recessed `--el-canvas` board (the canvas
      // background, MOTIR-1362): the fill is clearly lighter than the board, and the
      // crisp border + `--shadow-card` lift defines the edge. The active "you are
      // here" node takes an accent border; a cross-story tangle wins the border (the
      // louder signal). MOTIR-1422 adds the card-level DONE (`--el-tint-sky`) + READY
      // (mint wash) fills — distinct palette tints, legible zoomed out, unlike the old
      // 3px ready edge. MOTIR-10508 adds TO PLAN's `--el-tint-yellow` — the tint the
      // `planning` status chip already wears, so "needs planning" reads the same on
      // the chip and on the card.
      // NOT-IN-SPRINT (MOTIR-1379 follow-up): a DOTTED border (the "provisional, not
      // committed" edge) + a receded `--el-muted` fill + the "not in sprint" tag, and
      // crucially NO shadow. The shadow is dropped because the active `data-style`
      // owns elevation: under neo-brutalism `--shadow-*` is a HARD offset block that
      // reads as a solid frame — a dotted border ON TOP of that offset frame was the
      // "dotted + solid" double border. With no shadow the card is FLAT (reinforcing
      // "not committed") and the dotted edge is the only border, in every style. The
      // louder `crossBlocked` / `here` chromes still win (they keep their solid
      // borders + shadows).
      frameClassName={
        crossBlocked
          ? 'border-(--el-danger) bg-(--el-surface) shadow-[0_0_0_1px_var(--el-danger)_inset] shadow-(--shadow-card)'
          : here
            ? 'border-(--el-accent) bg-(--el-surface) shadow-(--shadow-card)'
            : showDone
              ? notInSprintChrome
                ? 'border-dotted border-(--el-border-strong) bg-(--el-tint-sky)'
                : 'border-(--el-border) bg-(--el-tint-sky) shadow-(--shadow-subtle)'
              : showToPlanWash
                ? notInSprintChrome
                  ? 'border-dotted border-(--el-border-strong) bg-(--el-tint-yellow)'
                  : 'border-(--el-border) bg-(--el-tint-yellow) shadow-(--shadow-card)'
                : showReadyWash
                  ? notInSprintChrome
                    ? 'border-dotted border-(--el-border-strong) bg-(--el-tint-mint)'
                    : 'border-(--el-border) bg-(--el-tint-mint) shadow-(--shadow-card)'
                  : notInSprintChrome
                    ? 'border-dotted border-(--el-border-strong) bg-(--el-muted)'
                    : 'border-(--el-border) bg-(--el-surface) shadow-(--shadow-card)'
      }
      // THE TAG ROW's contents after the kind tile and the identifier (MOTIR-10508):
      // the STATUS SLOT — the status pill, or the Done / To plan / Ready pill that
      // replaces it — then the Manual chip and the run disposition; then, pushed
      // right, Not public, not in sprint, the blocked flag or the drill chevron.
      statusRow={
        <>
          {/* The status slot and the Manual chip, through the shared tag row
              (MOTIR-10534): the board, the quick view and the item page draw the
              same two. The Manual chip rides a hairline `--el-border` lifting it off
              every node fill. You are here never takes the slot: it is the card's
              tab (MOTIR-10630), so the here card shows its own status. */}
          <WorkItemStateTags
            item={item}
            ready={ready}
            blocked={crossBlocked}
            glyphOnly={glyphOnly}
          />
          {/* The run DISPOSITION (MOTIR-3895), beside the work item's own status and
              never instead of it: they are different facts. The status is what the
              work item IS; the disposition is what THIS RUN did with it, and a run
              that skipped a work item has not changed its status at all. */}
          {runLeg ? (
            <RunTonePill tone={runLeg.tone} compact>
              {runLeg.label}
            </RunTonePill>
          ) : null}
          {notPublic || showNotInSprintTag || crossBlocked || drillable ? (
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {notPublic ? <EpicNotPublicPill /> : null}
              {/* The "not in sprint" tag (MOTIR-1379 follow-up) — a QUIET neutral chip,
                  NOT the red cross-blocked flag: this node is simply outside the
                  committed sprint, not a broken dependency. Suppressed when the card is
                  cross-blocked (its own flag already reads "not in sprint" in sprint
                  scope), so the card never carries two tags. */}
              {showNotInSprintTag ? (
                <span
                  data-testid="not-in-sprint-tag"
                  // A plain neutral chip (no border) — a bordered tag would read as an
                  // extra border on the card, and a border style would fight the active
                  // `data-style`. The card's muted fill + this tag carry the signal.
                  // The tag row's one chip size (MOTIR-10508): 11px, chip-x-6.
                  className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x-6) py-(--spacing-chip-y) text-[11px] font-medium text-(--el-text-secondary)"
                >
                  <CircleDashed className="size-3" aria-hidden="true" />
                  {t('node.notInSprint')}
                </span>
              ) : null}
              {crossBlocked ? (
                <CrossBlockedFlag sprint={crossBlockedSprint} short />
              ) : drillable ? (
                <ChevronRight
                  className="size-4 shrink-0 text-(--el-text-muted)"
                  aria-hidden="true"
                  data-testid="drill-affordance"
                />
              ) : null}
            </div>
          ) : null}
        </>
      }
      kind={item.kind}
      identifier={item.identifier}
      title={item.title}
      titleItemId={item.id}
      // The struck title is half of the Done CARD style (with the sky fill), so it
      // follows the frame's precedence: the here card keeps its accent frame and an
      // unstruck title, and says Done in its status slot.
      titleStruck={showDone && !here}
      // PROGRESS METER (Subtask 7.20.6 / MOTIR-1013) — a thin done/total bar on a
      // container node: `--el-success` fill over the `--el-muted` track, with the
      // count beside it. Leaves (no `progress`) and `0`-total containers omit it.
      footer={
        showMeter ? (
          <div className="mt-2 flex shrink-0 items-center gap-2" data-testid="progress-meter">
            <div
              role="progressbar"
              aria-label={t('subtreeProgress')}
              aria-valuenow={progress.done}
              aria-valuemin={0}
              aria-valuemax={progress.total}
              className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-(--radius-badge) bg-(--el-muted)"
            >
              <div
                className="h-full rounded-(--radius-badge) bg-(--el-success)"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="shrink-0 text-xs font-medium text-(--el-text-secondary) tabular-nums">
              {progress.done} / {progress.total}
            </span>
            {/* CI-verified count (Subtask 7.10.6 / MOTIR-894) — the "N of M verified"
                roll-up beside the done/total meter; shown only once CI has verified
                at least one descendant. */}
            {progress.verified && progress.verified > 0 ? (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-(--el-success) tabular-nums"
                title={t('verifiedCount', { count: progress.verified })}
              >
                <Check className="size-3" aria-hidden="true" />
                {progress.verified}
              </span>
            ) : null}
          </div>
        ) : item.assigneeName ? (
          <span className="shrink-0 truncate pt-1.5 text-right text-xs text-(--el-text-secondary)">
            {item.assigneeName}
          </span>
        ) : null
      }
      tab={here ? <HereTab /> : null}
      action={
        action === null ? null : action.kind === 'plan' ? (
          <PlanNextAction itemKey={item.identifier} />
        ) : (
          <CopyNextAction itemKey={item.identifier} verb={action.verb} reason={action.reason} />
        )
      }
    />
  );
}

/**
 * THE CARD SHELL (MOTIR-6296 · design Part XXIII §23.4; re-laid by MOTIR-10508) —
 * the ONE drawing of a canvas card, shared by a committed work item
 * (`WorkItemNode`) and a proposal (`PlanItemNode`). It owns everything the two must
 * agree on: the fixed `NODE_W × NODE_H` footprint (the deterministic layout spaces
 * rows by NODE_H, so a long title can never grow the card into the row below), the
 * `--radius-card` radius, the 1px border weight, the `--spacing-card-padding-12`
 * padding, the TAG ROW (the kind tile through the one {@link KIND_TINT}, the
 * identifier, then the caller's tags) and the title-only body.
 *
 * A caller contributes only what its STATE means: `frameClassName` (border
 * style + colour, fill, shadow, any ring), the tag row's contents after the
 * identifier, a footer (the progress meter, the assignee, a proposal's bottom slot),
 * an `overlay` — absolutely-positioned decoration drawn over the card (a proposal's
 * outcome spine, the `locked` hatch) — and an `action`: the next-action button,
 * drawn OUTSIDE the overflow-hidden frame so it can hang on the card's top edge
 * without clipping. That is the compose-don't-redraw seam `PlanningTargetNode`
 * already uses, one level down: a proposal is a LAYER over this shell, never a
 * second card.
 *
 * Everything else (`data-*`, `aria-*`) is spread onto the FRAME, so each caller
 * keeps its own state hooks.
 */
export function WorkItemCardShell({
  frameClassName,
  statusRow,
  kind,
  identifier,
  title,
  titleItemId,
  titleStruck = false,
  titleSingleLine = false,
  footer = null,
  overlay = null,
  tab = null,
  action = null,
  ...rootProps
}: {
  /** The state's border style + colour, fill, shadow (and any ring). The shell
   *  adds the shared `border` weight, radius and padding itself. */
  frameClassName: string;
  /** The tag row's contents AFTER the kind tile and the identifier — the shell
   *  draws the row, the tile and the key. */
  statusRow: ReactNode;
  kind: IssueType;
  identifier: ReactNode;
  title: string;
  /** The work item behind the title, when it is a REAL one: a surface that has
   *  mounted a title-translation provider then shows the reader's language (Story
   *  MOTIR-7738 · MOTIR-8833). Absent for a draft or a preview. */
  titleItemId?: string;
  /** The struck, secondary-ink title — a done card, a proposed removal. */
  titleStruck?: boolean;
  /** One clean ellipsis instead of the clamp, for a card whose footer spends the
   *  bottom slot (Part XVII §17.2); the full title then rides `title`. */
  titleSingleLine?: boolean;
  footer?: ReactNode;
  /** Absolutely-positioned decoration over the card (spine, hatch). */
  overlay?: ReactNode;
  /** A TAB hung on the card's top edge (MOTIR-10630 — the "You are here" tab),
   *  a sibling of the frame rendered BEFORE it, so it sits outside the
   *  overflow-hidden frame and the `NODE_W × NODE_H` footprint and is read first. */
  tab?: ReactNode;
  /** The next-action button (MOTIR-10509), a sibling of the frame. */
  action?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'style' | 'title' | 'children'>) {
  // Tagged so a decorator that WRAPS this node (the plan-change diff frame's
  // `remove` state) can strike the title without redrawing the card — the same
  // struck-title language `titleStruck` uses below.
  const titleElementProps = {
    'data-node-title': '',
    title: titleSingleLine ? title : undefined,
  };
  // The title clamps at THREE lines with no footer and TWO with one, so it always
  // ends inside the 124px box (MOTIR-10508: measured, the title's last line ends at
  // 103px at most, the footer at 111px).
  // MOTIR-5459 — `block` rides WITH `truncate`, never beside `line-clamp-*`:
  // `truncate` needs a block box for its ellipsis, while `.block` is emitted
  // after `.line-clamp-*` and would take `display` back from its
  // `-webkit-box`, leaving the clamp inert.
  const clamp = titleSingleLine ? 'block truncate' : footer ? 'line-clamp-2' : 'line-clamp-3';
  const titleClassName = `${clamp} text-sm leading-snug font-semibold ${
    // `--el-text-secondary`, never `--el-text-muted`, for the struck title
    // (MOTIR-4260): a proposed removal paints `bg-(--el-muted)`, where the muted
    // ink is 4.12:1 and secondary 6.18:1.
    titleStruck ? 'text-(--el-text-secondary) line-through' : 'text-(--el-text)'
  }`;
  return (
    // The wrapper is the frame's own size, `relative`, and NOT overflow-hidden, so
    // the next-action button can hang half outside the card (MOTIR-10508). It is
    // the `group/node` the button's hover / focus-within reveal reads.
    <div className="group/node relative" style={{ width: NODE_W, height: NODE_H }}>
      {tab}
      <div
        {...rootProps}
        // Fixed height (= the layout's NODE_H) so a long title can never grow the
        // card into the row below it — the deterministic layout spaces rows by
        // NODE_H, so the card must honour it exactly.
        style={{ width: NODE_W, height: NODE_H }}
        className={`relative flex flex-col overflow-hidden rounded-(--radius-card) border p-(--spacing-card-padding-12) ${frameClassName}`}
      >
        {/* THE TAG ROW (MOTIR-10508) — the kind tile, the identifier (which never
            shrinks), then the caller's tags. */}
        <div className="flex min-w-0 shrink-0 items-center gap-1.5">
          <span
            className={`flex size-6 shrink-0 items-center justify-center rounded-(--radius-control) ${KIND_TINT[kind]}`}
            aria-hidden="true"
          >
            <IssueTypeIcon type={kind} className="size-3.5" />
          </span>
          <span className="shrink-0 font-mono text-xs text-(--el-text-secondary)">
            {identifier}
          </span>
          {statusRow}
        </div>

        {/* BODY — the title alone, full width under the tag row. */}
        <div className="mt-2 min-h-0 flex-1 overflow-hidden">
          {titleItemId ? (
            // The same span, drawn by the title-translation kit so a surface that
            // mounted its provider shows the reader's language (MOTIR-8833); the
            // class string and the tag are the ones below.
            <SurfaceTitle
              id={titleItemId}
              title={title}
              layout="clamp"
              className={titleClassName}
              elementProps={titleElementProps}
            />
          ) : (
            <span {...titleElementProps} className={titleClassName}>
              {title}
            </span>
          )}
        </div>

        {footer}
        {overlay}
      </div>
      {action}
    </div>
  );
}

/**
 * The "You are here" TAB (MOTIR-10630; design MOTIR-10629 § "The tab") — the
 * current-position cue, hung on the card's top edge, LEFT, in the 72px row gap, so
 * it frees the status slot and changes neither `NODE_H` nor the layout.
 *
 * - `bottom-[calc(100%-1px)]` overlaps the frame's 1px top border, so on the accent
 *   frame the tab and the border read as one shape, a folder tab.
 * - `left-3` mirrors the next-action button's `right-3` and clears the card's
 *   corner radius in every style.
 * - The tag row's one chip size (`h-5`, 11px, a 12px glyph), and the chip's own
 *   shape tokens (`--radius-badge` on the top corners, `chip-x-6`), so a style
 *   swap reshapes it; the bottom corners stay square because they join the frame.
 *   No shadow: under neo-brutalism the hard offset shadow belongs to the frame.
 * - The accent fill / ink pair the primary button uses, AA in every palette.
 * - Its words are always shown (never truncated, never cut to the glyph) and not
 *   `aria-hidden`, so they are read out before the frame's content.
 */
function HereTab() {
  const t = useTranslations('roadmap.canvas.node');
  return (
    <span
      data-testid="here-tab"
      className="absolute bottom-[calc(100%-1px)] left-3 z-10 inline-flex h-5 items-center gap-1 rounded-t-(--radius-badge) bg-(--el-accent) px-(--spacing-chip-x-6) text-[11px] leading-none font-semibold whitespace-nowrap text-(--el-accent-text)"
    >
      <MapPin className="size-3 shrink-0" aria-hidden="true" />
      {t('here')}
    </span>
  );
}

/**
 * The "blocked elsewhere" CHIP (MOTIR-1331) — the dependent's half of the
 * off-level treatment, beside the `cross` arrow and the ghost anchor. In sprint
 * scope it names the out-of-sprint BLOCKER instead (MOTIR-1568).
 *
 * EXPORTED (bug MOTIR-5387) because a PROPOSED card carries the same signal on
 * the plan-review canvas (`PlanItemNode`). The chip is a reserved canvas
 * language, and two copies of it would be two things a reader has to recognise
 * as one.
 *
 * `short` (MOTIR-10508, the committed card's tag row): the visible label is
 * `blocked`, and the full sentence rides `title` and `aria-label`. The danger
 * frame already says the card is blocked; the flag names it, the tooltip explains.
 */
export function CrossBlockedFlag({
  sprint = false,
  short = false,
}: {
  sprint?: boolean;
  short?: boolean;
}) {
  const t = useTranslations('roadmap.canvas.node');
  const sentence = t(sprint ? 'blockerNotInSprint' : 'blockedElsewhere');
  // The short form is the shared tag (MOTIR-10534) — the board, the quick view and
  // the item page draw the same flag, with the readiness sentence instead.
  if (short) return <BlockedTag sentence={sentence} />;
  return (
    <span
      data-testid="cross-blocked-flag"
      className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-danger-surface) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-danger-on-surface)"
    >
      <Flag className="size-3" aria-hidden="true" />
      {sentence}
    </span>
  );
}

/**
 * The next-action button's shared face (MOTIR-10508 § "The next-action button"):
 * the shipped `Button` `secondary` `sm`, on `--el-page-bg` with `--shadow-elevated`
 * so it lifts off any wash, hung on the card's TOP edge, right-aligned. Shown on
 * the card's hover and on focus-within — the button's own focus, or keyboard focus
 * on the canvas node that holds the card — and always on a device with no hover.
 *
 * The TOP edge, not the bottom the design first drew (MOTIR-10536): a SELECTED
 * roadmap card hangs its action slot (View · planning target · Open) centred on the
 * bottom edge (`ProjectRoadmapCanvas`), and on a 280px card that slot reaches into
 * the right corner and paints over the button — on exactly the card the reader just
 * picked. Nothing else hangs on the top edge, and the 72px row gap leaves the
 * button's 16px overhang well clear of the row above.
 */
const NEXT_ACTION_CLASS =
  'absolute top-0 right-3 -translate-y-1/2 gap-1.5 bg-(--el-page-bg) shadow-(--shadow-elevated) opacity-0 group-hover/node:opacity-100 group-focus-within/node:opacity-100 [[data-node-id]:focus-visible_&]:opacity-100 [@media(hover:none)]:opacity-100';

/**
 * The canvas node wrapper (`[data-node-id]`, `PlanningCanvas`) owns pointerdown (a
 * node gesture: drag or select), click and Enter / Space (drill). The button stops
 * each of them, so pressing it neither drags, selects, drills nor opens the quick
 * view (MOTIR-10509 AC 3).
 */
const stopCanvasGesture = {
  onPointerDown: (e: PointerEvent<HTMLElement>) => e.stopPropagation(),
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => e.stopPropagation(),
  onKeyUp: (e: KeyboardEvent<HTMLElement>) => e.stopPropagation(),
};

/** {@link stopCanvasGesture} plus the click, for a subtree that is not a button. */
const stopPortalledEvents = {
  ...stopCanvasGesture,
  onClick: (e: MouseEvent<HTMLElement>) => e.stopPropagation(),
};

const COPIED_MS = 2000;

/** Copy `motir run|review|fix|guide <KEY>` — the ready list's copy action, as a
 *  button with its verb on the face (the key rides the tooltip and the copied text). */
function CopyNextAction({
  itemKey,
  verb,
  reason,
}: {
  itemKey: string;
  verb: CopyActionVerb;
  reason: CopyActionReason | null;
}) {
  const t = useTranslations('roadmap.canvas.node.action');
  const tToast = useTranslations('ready.toast');
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const command = `motir ${verb} ${itemKey}`;
  const copy = useCallback(
    async (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(command);
      } catch {
        // A refused clipboard (insecure context, denied permission) says so
        // rather than failing silently; nothing was copied, so no Check glyph.
        toast({ variant: 'error', title: t('copyFailed') });
        return;
      }
      toast({
        variant: 'success',
        title: tToast('title'),
        description: tToast('body', { command }),
      });
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    },
    [command, t, tToast, toast],
  );
  const rich = {
    command,
    cmd: (chunks: ReactNode) => <code className="font-mono">{chunks}</code>,
  };
  const tooltip =
    reason === 'ci_failed'
      ? t.rich('copyTooltipCiFailed', rich)
      : reason === 'changes_requested'
        ? t.rich('copyTooltipChangesRequested', rich)
        : verb === 'guide'
          ? t.rich('copyTooltipGuide', rich)
          : t.rich('copyTooltip', rich);
  const Glyph = copied ? Check : Copy;
  return (
    <Tooltip content={tooltip}>
      <Button
        variant="secondary"
        size="sm"
        aria-label={t('copyAria', { command })}
        data-testid="node-next-action"
        data-action={verb}
        data-copied={copied ? 'true' : undefined}
        className={`${NEXT_ACTION_CLASS} font-mono`}
        leftIcon={<Glyph className="size-3.5 shrink-0 text-(--el-text-secondary)" />}
        onClick={copy}
        {...stopCanvasGesture}
      >
        {`motir ${verb}`}
      </Button>
    </Tooltip>
  );
}

/** Open the planning overlay with this card as the target — the work-item context
 *  of the shipped launcher (`lib/planning/launcher.ts`), the same door
 *  `WorkItemPlanEntrance` opens, wearing its Plan face. A To plan story has no
 *  children, so there is no plan to re-plan (`hasPlan: false`).
 *
 *  CHECKED FIRST (MOTIR-10544; design MOTIR-10543): the click asks the server
 *  whether the card can be planned (`usePlanCheck`) and only then opens the
 *  overlay — or the can't-plan alert, or the check-failed toast. While it asks,
 *  the button wears the shipped `Button`'s `loading` face (the Checking state:
 *  Spinner for Sparkles, label unchanged, disabled, `aria-busy`), and stays shown
 *  even when the pointer leaves the card, so the state never vanishes mid-check.
 *  A modified click (⌘ / ctrl / shift / alt) still does nothing, as before. */
function PlanNextAction({ itemKey }: { itemKey: string }) {
  const t = useTranslations('roadmap.canvas.node.action');
  const tEntrance = useTranslations('aiPlanning.entrance');
  const { checking, alert, check, closeAlert } = usePlanCheck();
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Tooltip content={t('planTooltip', { key: itemKey })}>
        <Button
          ref={buttonRef}
          variant="secondary"
          size="sm"
          aria-label={tEntrance('planAria', { item: itemKey })}
          data-testid="node-next-action"
          data-action="plan"
          data-checking={checking ? 'true' : undefined}
          loading={checking}
          className={`${NEXT_ACTION_CLASS} border-(--el-accent) font-sans font-semibold text-(--el-accent-on-surface)${checking || alert ? ' opacity-100' : ''}`}
          leftIcon={<Sparkles className="size-3.5 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            if (!isPlainPrimaryClick(e)) return;
            e.preventDefault();
            void check(itemKey);
          }}
          {...stopCanvasGesture}
        >
          {tEntrance('plan')}
        </Button>
      </Tooltip>
      {/* The alert PORTALS to the body, but React still bubbles its events up
          THIS tree — into the canvas node, whose click / Enter drills and whose
          pointerdown drags. The wrapper stops them here (`contents`: no box). */}
      <div className="contents" {...stopPortalledEvents}>
        <CantPlanAlert
          itemKey={alert?.key ?? null}
          reasons={alert?.reasons ?? []}
          onClose={closeAlert}
          onPlanBlocker={(blockerKey) => {
            closeAlert();
            void check(blockerKey);
          }}
          returnFocusRef={buttonRef}
        />
      </div>
    </>
  );
}

/**
 * The GHOST ANCHOR for an off-level blocker (MOTIR-1331) — a dashed-red, hatched
 * chip that names the blocker the canvas can't show a node for ("PROD-42 ↗ in
 * Story X"), so the red cross-story edge has a target.
 */
export function GhostAnchor({
  identifier,
  title,
  parentTitle,
  folderPath = null,
  outOfSprint = false,
  tone = 'danger',
}: {
  identifier: string;
  /** The blocker's title; falls back to the localized default when absent. */
  title?: string | null;
  parentTitle?: string | null;
  /** The blocker's effective FOLDER path, root first (Bug MOTIR-5710 · MOTIR-5739,
   *  design sheet 7). When set it REPLACES the parent line: a filed blocker lives
   *  behind a folder door, and that door is what the reader has to find. */
  folderPath?: readonly string[] | null;
  /** Sprint scope (MOTIR-1379): the anchor reads "not in this sprint" — the
   *  blocker is an out-of-sprint, not-done dependency, not a cross-story tangle. */
  outOfSprint?: boolean;
  /** `danger` (default) names an INVALID edge's blocker — the "blocked elsewhere"
   *  treatment. `neutral` names the blocker of a VALID edge no level above draws —
   *  an end with no work-item parent (MOTIR-6359; design
   *  `design/roadmap/design-notes.md` § "Covered cross-parent edges", sheet 7): the
   *  same box and lines, with the danger tokens swapped for neutral ones. */
  tone?: 'danger' | 'neutral';
}) {
  const t = useTranslations('roadmap.canvas.anchor');
  const tFolders = useTranslations('folders');
  const neutral = tone === 'neutral';
  // The location line's ink: danger on an invalid edge's anchor, secondary on a
  // valid one's — the neutral anchor must not say "wrong" in its smallest line.
  const lineInk = neutral ? 'text-(--el-text-secondary)' : 'text-(--el-danger)';
  return (
    <div
      // Fixed height (= the layout's NODE_H) + `overflow-hidden`, the SAME fixed-box
      // contract WorkItemNode honours: the deterministic layout spaces every row by
      // NODE_H, and the anchor is the only variable-height node — so a long parent
      // (a Motir story title of 80–120 chars) must not be able to grow the box past
      // its row and overlap the card beneath it in the same column (MOTIR-1581).
      style={{
        width: 200,
        height: NODE_H,
        backgroundImage: neutral
          ? 'repeating-linear-gradient(135deg, var(--el-surface), var(--el-surface) 7px, var(--el-border-soft) 7px, var(--el-border-soft) 9px)'
          : 'repeating-linear-gradient(135deg, var(--el-surface), var(--el-surface) 7px, var(--el-danger-surface) 7px, var(--el-danger-surface) 9px)',
      }}
      data-anchor-tone={tone}
      className={`overflow-hidden rounded-(--radius-card) border border-dashed p-(--spacing-card-padding) ${
        neutral ? 'border-(--el-border-strong)' : 'border-(--el-danger)'
      }`}
    >
      <span
        className={`flex items-center gap-1.5 font-mono text-xs font-semibold ${
          neutral ? 'text-(--el-text-secondary)' : 'text-(--el-danger-on-surface)'
        }`}
      >
        <ArrowUpRight className="size-3.5" aria-hidden="true" />
        {identifier}
      </span>
      <span className="mt-1 line-clamp-1 text-xs text-(--el-text-secondary)">
        {title ?? t('defaultTitle')}
      </span>
      {outOfSprint ? (
        <span className="mt-0.5 line-clamp-1 text-xs text-(--el-danger)">
          {t('notInThisSprint')}
        </span>
      ) : folderPath && folderPath.length > 0 ? (
        <span className="mt-0.5 flex min-w-0 text-xs" data-testid="anchor-folder">
          <FolderPathLabel
            path={folderPath}
            max={2}
            lastClassName=""
            srPrefix={tFolders('breadcrumbFolderLabel')}
          />
        </span>
      ) : parentTitle ? (
        <span className={`mt-0.5 line-clamp-1 text-xs ${lineInk}`}>
          {t('inParent', { parent: parentTitle })}
        </span>
      ) : (
        <span className={`mt-0.5 line-clamp-1 text-xs ${lineInk}`}>{t('elsewhere')}</span>
      )}
    </div>
  );
}

/**
 * The GROUPED node for a root level's NON-EPIC rows (MOTIR-3490; design
 * `design/roadmap/root-non-epic-rows.*`, decisions 2 and 3).
 *
 * The roadmap's root level has never had a notion of KIND — `findProjectTreeLevel`
 * selects on `parentId IS NULL` and nothing else — so a parentless bug, task or
 * story drew on the road beside the epics. This node is where they go instead: one
 * door, and the road stays the epics.
 *
 * It reuses {@link WorkItemNode}'s BOX exactly — same `NODE_W`/`NODE_H`, same
 * `--radius-card` / `--el-border` / `--el-surface` / `--shadow-card` — because it
 * sits on the same grid and must line up with its neighbours. Three slots differ,
 * and each difference is a decision rather than an omission:
 *
 *  - the KIND TILE is neutral `--el-muted` behind a `layers` glyph, NOT an
 *    `--el-type-*` hue: no kind backs this node, and borrowing one would say the
 *    group IS that kind;
 *  - the IDENTIFIER slot carries the COUNT, in the same mono type — it is what
 *    identifies the node, and there is no `MOTIR-<n>` to put there;
 *  - the STATUS PILL and the PROGRESS METER are ABSENT. Those are the two places
 *    a synthetic node is most tempted to say something ("Mixed", "7 open", a
 *    done/total bar) and each would be a claim about work this node does not own.
 *    The meter in particular means "this container's own work is N% done", and the
 *    group is a drawer, not a unit of work — its members are unrelated.
 *
 * Presentational: the consumer owns the partition and the drilled level.
 */
export function LevelGroupNode({ count }: { count: number }) {
  const t = useTranslations('roadmap.canvas.group');
  return (
    <div
      style={{ width: NODE_W, height: NODE_H }}
      data-node-state="group"
      data-testid="level-group-node"
      aria-label={t('aria', { count })}
      className="relative flex flex-col overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) p-(--spacing-card-padding-12) shadow-(--shadow-card)"
    >
      {/* TOP ROW — no status pill (the group has none); the drill chevron alone,
          in the slot every other node puts it in. */}
      <div className="flex shrink-0 items-center gap-2">
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <ChevronRight
            className="size-4 shrink-0 text-(--el-text-muted)"
            aria-hidden="true"
            data-testid="drill-affordance"
          />
        </div>
      </div>
      <div className="mt-1.5 flex min-h-0 flex-1 items-start gap-2 overflow-hidden">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-muted)"
          aria-hidden="true"
        >
          <Layers className="size-4 text-(--el-text-secondary)" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-(--el-text-secondary)">
              {count === 1 ? t('countOne') : t('count', { count })}
            </span>
          </div>
          <span
            data-node-title
            className="mt-0.5 line-clamp-2 text-sm leading-snug font-semibold text-(--el-text)"
          >
            {t('title')}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The direct-contents line a FOLDER card carries in its identifier slot (Bug
 * MOTIR-5710 · MOTIR-5741, design decision 3): `794 items` · `1 item` ·
 * `2 folders · 5 items` · `3 folders` · `Empty`. DIRECT, never recursive, and
 * never a status tally — a folder is a place, not a unit of work. Exported so the
 * aria label and the tests read the same sentence the card shows.
 */
export function useFolderContentsLabel(): (childFolderCount: number, itemCount: number) => string {
  const t = useTranslations('roadmap.canvas.folder');
  return (childFolderCount, itemCount) => {
    const items = itemCount === 1 ? t('itemsOne') : t('items', { count: itemCount });
    const folders =
      childFolderCount === 1 ? t('foldersOne') : t('folders', { count: childFolderCount });
    if (childFolderCount > 0 && itemCount > 0) return t('both', { folders, items });
    if (childFolderCount > 0) return folders;
    if (itemCount > 0) return items;
    return t('empty');
  };
}

/**
 * A FOLDER on the roadmap canvas (Bug MOTIR-5710 · MOTIR-5741; design
 * `design/roadmap/roadmap--folder-node.mock.html` sheet 2).
 *
 * It is {@link LevelGroupNode}'s BOX, slot for slot — the same `NODE_W`/`NODE_H`,
 * `--radius-card`, `--el-border`, `--el-surface`, `--shadow-card` — because it sits
 * on the same grid. The tile is the neutral `--el-muted` one behind the lucide
 * `folder` glyph (the `/items` folder vocabulary, MOTIR-5311); the identifier slot
 * carries the DIRECT contents; the title slot carries the name. There is NO status
 * pill, meter or readiness chrome: a folder carries no workflow, and each of those
 * would be a claim about work it does not own. It is always a DOOR (the drill
 * chevron is always drawn), even when empty — an empty folder is a real record a
 * person made, and its card says `Empty` so nobody drills in expecting work.
 *
 * Presentational: the consumer owns the level behind it.
 *
 * `changes` is the PLANNING canvases' one addition (Bug MOTIR-5782; design
 * `design/ai-planning/design-notes.md` Part XVIII decision 3): how many of a
 * pending plan's proposals will sit anywhere beneath this folder. A proposal is
 * drawn on the level where it will SIT, so a closed folder can hold changes the
 * reviewer has not seen; the badge says so, in the top-row slot a folder leaves
 * empty. `/roadmap` has no plan and never passes it.
 */
export function FolderNode({
  name,
  childFolderCount,
  itemCount,
  changes = 0,
}: {
  name: string;
  childFolderCount: number;
  itemCount: number;
  changes?: number;
}) {
  const t = useTranslations('roadmap.canvas.folder');
  const contentsLabel = useFolderContentsLabel();
  const contents = contentsLabel(childFolderCount, itemCount);
  const changesAria =
    changes > 0
      ? changes === 1
        ? t('changesAriaOne')
        : t('changesAria', { count: changes })
      : null;
  return (
    <div
      style={{ width: NODE_W, height: NODE_H }}
      data-node-state="folder"
      data-testid="folder-node"
      aria-label={`${t('aria', { name, contents })}${changesAria ? ` ${changesAria}` : ''}`}
      className="relative flex flex-col overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) p-(--spacing-card-padding-12) shadow-(--shadow-card)"
    >
      {/* TOP ROW — no status pill (a folder has none); the drill chevron, and on a
          planning canvas the changes badge (the shipped `add` badge's pair). */}
      <div className="flex shrink-0 items-center gap-2">
        {changes > 0 ? (
          <span
            data-testid="folder-changes"
            className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-surface) px-(--spacing-chip-x-6) py-(--spacing-chip-y) text-[11px] font-semibold text-(--el-accent-on-surface)"
          >
            <FolderPen className="size-3" aria-hidden="true" />
            {changes === 1 ? t('changesOne') : t('changes', { count: changes })}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <ChevronRight
            className="size-4 shrink-0 text-(--el-text-muted)"
            aria-hidden="true"
            data-testid="drill-affordance"
          />
        </div>
      </div>
      <div className="mt-1.5 flex min-h-0 flex-1 items-start gap-2 overflow-hidden">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-muted)"
          aria-hidden="true"
        >
          <Folder className="size-4 text-(--el-text-secondary)" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-(--el-text-secondary)">{contents}</span>
          </div>
          <span
            data-node-title
            className="mt-0.5 line-clamp-2 text-sm leading-snug font-semibold text-(--el-text)"
          >
            {name}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * An EMPTY folder's drilled level (Bug MOTIR-5710 · MOTIR-5741; design sheet 6) —
 * the canvas's drilled-empty slot with folder copy. The generic `emptyDrilled`
 * ("This node has no children to show") is wrong for a folder, which is a place a
 * person files work into rather than a node with children.
 */
export function FolderEmptyLevel({ name }: { name: string }) {
  const t = useTranslations('roadmap.canvas.folder');
  return (
    <div className="max-w-[24rem] text-center" data-testid="folder-empty-level">
      <FolderOpen className="mx-auto size-8 text-(--el-text-secondary)" aria-hidden="true" />
      <p className="mt-2 text-sm font-semibold text-(--el-text-strong)">{t('emptyTitle')}</p>
      <p className="mt-1 text-sm text-(--el-text-secondary)">{t('emptyDescription', { name })}</p>
    </div>
  );
}

/**
 * The TRUNCATION tile for a level the read could not return whole (MOTIR-3490;
 * design decision 7).
 *
 * `TREE_LEVEL_MAX_TAKE` caps every level read at 200 rows under a key-ASCENDING
 * sort, so overflow discarded the HIGHEST keys — the most recently created epics —
 * with no cursor, no affordance and no error. The level simply stopped, and
 * nothing on the canvas said so. This tile is the saying-so.
 *
 * It is deliberately NOT a door: a drill chevron would promise a level behind it,
 * and what is behind it is more of THIS level. Activating it re-reads the level
 * with the raised ceiling (`?all=1`), which is the "Show all" the design draws.
 * The dashed `--el-border-strong` edge is the canvas's existing vocabulary for
 * "there is more of this than is drawn" — the onboarding init screen's
 * plan-preview cluster ends its epic strip the same way.
 */
export function LevelTruncationTile({ shown, total }: { shown: number; total: number }) {
  const t = useTranslations('roadmap.canvas.more');
  const remaining = Math.max(0, total - shown);
  return (
    <div
      style={{ width: NODE_W, height: NODE_H }}
      data-node-state="truncated"
      data-testid="level-truncation-tile"
      aria-label={t('aria', { shown, total })}
      className="relative flex flex-col items-center justify-center gap-1.5 rounded-(--radius-card) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) p-(--spacing-card-padding-12)"
    >
      <span className="text-sm font-semibold text-(--el-text-strong)">
        {t('label', { count: remaining })}
      </span>
      <span className="text-xs text-(--el-text-secondary) tabular-nums">
        {t('showing', { shown, total })}
      </span>
      {/* A LABEL, not a nested button. A control drawn inside a canvas card has to
          fight the wrapper's keydown/drag handlers (notes.html #139); the canvas's
          own activation is the affordance, exactly as it is for every other node. */}
      <span className="mt-0.5 rounded-(--radius-badge) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-strong)">
        {t('showAll')}
      </span>
    </div>
  );
}

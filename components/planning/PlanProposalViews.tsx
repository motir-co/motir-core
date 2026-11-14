'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Info, List, Workflow } from 'lucide-react';
import { PlanProposalList } from '@/components/planning/PlanProposalList';
import { PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';
import type { ProjectRoadmapCanvasProps } from '@/components/planning/ProjectRoadmapCanvas';
import { Segmented } from '@/components/ui/Segmented';
import type { PlanViewDto } from '@/lib/planning/planView';
import type { PlanItemOutcome } from '@/components/planning/PlanItemNode';
import type { PlanEdgeCoverageDto, PlanReviewItemDto } from '@/lib/dto/planReview';
import type { PlanItemDraftDto } from '@/lib/dto/plans';
import { authoringTargets, type LiveDrafts } from '@/lib/planning/liveDraft';
import {
  EMPTY_HOLD,
  cuesByProposal,
  deriveCardCues,
  holdCardCues,
  type CardCueHold,
} from '@/lib/planning/cueState';
import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';
import { addedProposalIds, newlyAddedCount } from '@/lib/planning/livePane';
import { PlanProgressLineView } from '@/components/planning/PlanProgressLine';
import {
  usePlanProgressReading,
  type PlanProgressClockReading,
} from '@/lib/hooks/usePlanProgressReading';
import {
  readPlanAtWork,
  type PlanProgressSnapshot,
  type PlanProgressStep,
} from '@/lib/plans/planProgress';

// The plan page's List | Canvas pane, as ONE component two hosts mount
// (Subtask MOTIR-6185 · Story MOTIR-6155).
//
// ── What this is, and what it deliberately is NOT ───────────────────────────
// This is a LIFT, not a rewrite. The pane header, the `Segmented` switch, the
// `min-h-0 flex-1` body box and both bodies moved here verbatim from
// `PlanDetail`, which is the only thing that rendered them. Nothing a plan-page
// user can see or do changes, which is why that page's suites pass unmodified —
// they are the regression net for this move.
//
// It exists because the planning SURFACE is about to show the same thing
// (MOTIR-6186). Two copies of "the list, the canvas and the switch between them"
// is two places that can disagree about what a plan contains, and the surface
// must not grow a second list, a second review canvas or a second edge
// computation: `PlanReviewCanvas` keeps its one edge engine, `mergePlanLevel`.
//
// ── It is PRESENTATIONAL and fully CONTROLLED ───────────────────────────────
// It owns no fetching, no URL and no view state. The HOST decides which view is
// showing and what a press means, and the two hosts want different answers:
// the plan page keeps the view in the URL (MOTIR-3239 / MOTIR-3434), and the
// surface keeps it local because an overlay must not write into the address bar
// of the page underneath it (`design/ai-planning/design-notes.md` Part XXI,
// decision 3). A component that owned the URL could not serve the overlay at
// all — which is the whole reason the view is a prop rather than state here.
//
// ── The `band` slot ─────────────────────────────────────────────────────────
// The one structural addition, and it is not a new element: the plan page's
// establish band sits BETWEEN the header and the body, so the lift needs
// somewhere to put it. Part VIII §2 is what decides that position — the header
// governs the BODY, and the band is not part of the body — so the slot is that
// decision expressed as a prop rather than re-argued in each host.

export interface PlanProposalViewsProps {
  /** The proposals to draw — the review's own item set. */
  items: PlanReviewItemDto[];
  /** The committed edges this plan re-judges (MOTIR-6362) — the review's own
   *  `edgeCoverage`, handed through to the canvas. */
  edgeCoverage?: readonly PlanEdgeCoverageDto[];
  /**
   * The plan's decision, drawn on every node and row the plan contributes
   * (MOTIR-3161). Three-valued: `accepted` / `declined` / null. Read from the
   * host's own decided state, never inferred from a status — a declined plan's
   * review keeps its pre-decision status (MOTIR-3162).
   */
  outcome: PlanItemOutcome | null;
  projectKey: string;
  /** Bumped by the host when the committed tree changes, so the canvas refetches. */
  version: number;
  /** The canvas's accessible name. */
  ariaLabel: string;
  /** Which body shows. CONTROLLED — this component never changes it itself. */
  view: PlanViewDto;
  onViewChange: (next: PlanViewDto) => void;
  /** Rendered between the header and the body (the plan page's establish band). */
  band?: ReactNode;
  /**
   * Keep `PlanReviewCanvas` MOUNTED while List shows, hidden and `inert`, so the
   * level a reader drilled to survives Canvas → List → Canvas (Subtask
   * MOTIR-6186; `design-notes.md` Part XXI 21.7).
   *
   * ⚠️ OFF BY DEFAULT, and the default is the point. The plan page's own suite
   * asserts `plan-review-canvas` is ABSENT under List
   * (`tests/components/plan-detail-view-switch.test.tsx`), so a default-on
   * version would change that page — which the lift exists not to do. The
   * planning surface opts in; the plan page does not.
   *
   * `inert` is what makes the hidden copy safe rather than merely invisible: it
   * takes the subtree out of the tab order and out of the accessibility tree, so
   * a keyboard user on List cannot land inside a canvas they cannot see.
   */
  preserveCanvasLevel?: boolean;
  /**
   * THE ARRIVAL HAND-OFF, when a HOST swapped this component in underneath a
   * reader (MOTIR-6155). Forwarded verbatim to `PlanReviewCanvas`; the plan page
   * passes none of it and is unchanged by its existence.
   *
   * Together they are MOTIR-6161's rule surviving a change of pane: the canvas
   * opens on `canvasHeldTrail` rather than the plan's level, starts already
   * `readerHasNavigated`, and so DECLINES `followTo` into the bar's offer instead
   * of moving somebody who chose where to stand.
   */
  canvasHeldTrail?: readonly CanvasCrumb[] | null;
  followTo?: ProjectRoadmapCanvasProps['followTo'];
  onFollowDeclined?: (key: string) => void;
  readerHasNavigated?: boolean;
  /** MOTIR-8593 — forwarded verbatim; see `ProjectRoadmapCanvas`'s `followMode`. */
  followMode?: ProjectRoadmapCanvasProps['followMode'];
  /** MOTIR-8593 — forwarded verbatim; see `ProjectRoadmapCanvas`'s `onReaderNavigated`. */
  onReaderNavigated?: ProjectRoadmapCanvasProps['onReaderNavigated'];
  /** MOTIR-8594 — forwarded verbatim; see `ProjectRoadmapCanvas`'s `followControl`. */
  followControl?: ProjectRoadmapCanvasProps['followControl'];
  /** MOTIR-8594 — forwarded verbatim; see `ProjectRoadmapCanvas`'s `followLevelId`. */
  followLevelId?: ProjectRoadmapCanvasProps['followLevelId'];
  onCanvasLevelChange?: (trail: readonly CanvasCrumb[]) => void;
  /**
   * The plan is being WRITTEN, and this pane is drawing it as it is (MOTIR-6300;
   * design Part XXIII §23.1). The pane is the same one a proposed plan gets — that
   * is the whole design, so the hand-over into the proposed plan swaps nothing —
   * and `live` adds only what a plan being written owes:
   *   · the LIVE MARKER at the header's right end (*Being written*), a polite
   *     status, so a reader looking for Approve is told why it is not there;
   *   · MOTION on the canvas, a changeKey per proposal, and the arrivals count;
   *   · the present-tense empty List, and the rows' entrance;
   *   · ONE announcement per batch of added cards (§23.15).
   * OFF by default. The plan page never passes it, and is unchanged by it.
   */
  live?: boolean;
  /** Three reads in a row have failed (§23.10): the marker says so. The last
   *  snapshot stays drawn — nothing else changes. Read only while `live`. */
  liveFailing?: boolean;
  /**
   * The plan was DISCARDED before it finished (§23.12): the plan page's own
   * sentence (`planReview.discardedOutcome`) in the band slot, and the List's
   * empty statement without its *"Declining ends it"* body. `band`, if given,
   * wins the slot.
   */
  discarded?: boolean;
  /** Forwarded verbatim to `PlanReviewCanvas` (bug MOTIR-6223): the planning
   *  surface opts in to the *"Plan is in … · Go there"* offer when the plan sits
   *  beside the reader's level. The plan page passes nothing and is unchanged. */
  offerPlanElsewhere?: boolean;
  /**
   * The plan's PROGRESS while it is being written (Story MOTIR-7820 · MOTIR-7829;
   * design Part XXVI §26.2) — the review's own `progress`, NON-NULL EXACTLY while
   * the plan is `generating`. It mounts the progress line in this header, and it
   * renders on `progress`, NOT on `live`: the plan page passes no `live` and
   * must still show the line. It leaves at the hand-over because `progress`
   * turns `null` once the plan is not `generating`.
   *
   * While it is present the line OWNS the header's marker (§26.1: the marker's
   * WORD carries the state — Starting… · Being written · Stalled ·
   * Reconnecting), so the shipped `live` marker is not drawn twice.
   */
  progress?: PlanProgressSnapshot | null;
  /** The poll's `failing` (§26.10): the line holds the last snapshot and the
   *  marker says *Reconnecting*. */
  progressFailing?: boolean;
  /**
   * THE HOST'S READING of `progress` (MOTIR-8594) — when a host already reads the
   * one clock (the overlay drives its canvas from the same live steps), it hands
   * the reading in so the line, the cues and the driven step read ONE instant and
   * ONE interval. Absent (the plan page), this component reads its own.
   */
  progressReading?: PlanProgressClockReading | null;
  /**
   * The cards being WRITTEN (Story MOTIR-11190 · MOTIR-11201; design Part XXIX) —
   * the live read's `inFlightDrafts`. While `live`, the open proposal's quick view
   * shows its partial fields. On EVERY host — the plan page too (MOTIR-11254,
   * §31.5) — they decide each authored card's cue: Thinking until a draft exists
   * for it, Drafting once one does. The array's identity is also the hold's READ
   * counter (§31.4): a host hands a NEW array exactly when a read arrives.
   */
  inFlightDrafts?: readonly PlanItemDraftDto[] | null;
}

export function PlanProposalViews({
  items,
  edgeCoverage,
  outcome,
  projectKey,
  version,
  ariaLabel,
  view,
  onViewChange,
  band,
  preserveCanvasLevel = false,
  canvasHeldTrail = null,
  followTo = null,
  onFollowDeclined,
  readerHasNavigated = false,
  followMode,
  onReaderNavigated,
  followControl,
  followLevelId,
  onCanvasLevelChange,
  live = false,
  liveFailing = false,
  discarded = false,
  offerPlanElsewhere = false,
  progress = null,
  progressFailing = false,
  progressReading: hostReading,
  inFlightDrafts = null,
}: PlanProposalViewsProps) {
  const t = useTranslations('planReview');
  // THE ONE CLOCK (MOTIR-7829): read once here, so the line and anything else
  // this pane draws from the steps read the same instant.
  // A host that reads the clock itself hands the reading in; the hook is still
  // called (on `null`, so it starts no interval) to keep the hook order fixed.
  const ownReading = usePlanProgressReading(hostReading === undefined ? progress : null, {
    failing: progressFailing,
  });
  const progressReading = hostReading === undefined ? ownReading : hostReading;
  // AT WORK (MOTIR-8416): the one at-work answer over that same reading — which
  // cards may MOVE. Presence still rides the held `liveSteps`, so a dropped read
  // keeps the cue drawn while its motion stops.
  const atWork = readPlanAtWork(progressReading, { failing: progressFailing });
  // THE STALLED HOLD (design § _Motir at work_, the States table): a stall empties
  // `liveSteps`, but the card the planner was last writing keeps its cue, still.
  // Held from the last reading that named a step; released when the plan settles.
  const [heldSteps, setHeldSteps] = useState<readonly PlanProgressStep[] | null>(null);
  const nextHeld = !progressReading
    ? null
    : progressReading.state === 'stalled'
      ? heldSteps
      : progressReading.liveSteps.length > 0
        ? progressReading.liveSteps
        : null;
  if (nextHeld !== heldSteps && stepsKey(nextHeld) !== stepsKey(heldSteps)) setHeldSteps(nextHeld);
  const presenceSteps =
    progressReading?.state === 'stalled' ? heldSteps : (progressReading?.liveSteps ?? null);
  const showingList = view === 'list';
  // A CARD BEING WRITTEN (MOTIR-11201, Part XXIX §29.2): its drafts, and the
  // proposals an `author` step targets — read off the SAME presence steps the
  // canvas's drafting cue reads (§26.6), so the peek's cue and the card's agree.
  // Keyed by the ids, because a reading recomputes its arrays on every tick.
  const authoringIds = [...authoringTargets(presenceSteps)].join('\n');
  const liveDrafts = useMemo<LiveDrafts | null>(
    () =>
      live
        ? {
            drafts: inFlightDrafts ?? [],
            authoring: new Set(authoringIds ? authoringIds.split('\n') : []),
          }
        : null,
    [live, inFlightDrafts, authoringIds],
  );
  // WHAT THE PLANNER IS DOING TO EACH CARD (MOTIR-11254, Part XXXI §31.1 / §31.4):
  // Thinking · Drafting · Checking, from the same presence steps and the read's
  // drafts, folded through the two-read hold so a card does not blink between
  // reads. ONE derivation feeds the canvas, the list and the quick view. Folded in
  // render — the shipped pattern for a state that follows a read.
  const [cueHold, setCueHold] = useState<CardCueHold>(EMPTY_HOLD);
  const nextCueHold = holdCardCues(
    cueHold,
    deriveCardCues(items, presenceSteps, inFlightDrafts),
    inFlightDrafts,
  );
  if (nextCueHold !== cueHold) setCueHold(nextCueHold);
  const cardCues = nextCueHold.cues;
  const proposalCues = useMemo(() => cuesByProposal(items, cardCues), [items, cardCues]);
  const liveDraftsWithCues = useMemo<LiveDrafts | null>(
    () => (liveDrafts ? { ...liveDrafts, cues: proposalCues.peek } : null),
    [liveDrafts, proposalCues],
  );
  const announcement = useBatchAnnouncement(items, live);
  const canvas = (
    <PlanReviewCanvas
      items={items}
      edgeCoverage={edgeCoverage}
      projectKey={projectKey}
      version={version}
      outcome={outcome}
      ariaLabel={ariaLabel}
      heldTrail={canvasHeldTrail}
      followTo={followTo}
      onFollowDeclined={onFollowDeclined}
      readerHasNavigated={readerHasNavigated}
      followMode={followMode}
      onReaderNavigated={onReaderNavigated}
      followControl={followControl}
      followLevelId={followLevelId}
      onLevelChange={onCanvasLevelChange}
      live={live}
      liveDrafts={liveDraftsWithCues}
      offerPlanElsewhere={offerPlanElsewhere}
      // THE CUES (MOTIR-7830) — the line's own clock's live steps, so the words
      // and the canvas stop naming a step at the same instant. A dropped read
      // holds them because the hook does. The List carries its own row chip
      // since §31.6 amended §26.18.
      liveSteps={presenceSteps}
      movingSteps={atWork.steps}
      // Thinking · Drafting · Checking per card (MOTIR-11254, §31.1).
      cardCues={cardCues}
    />
  );
  // THE DISCARDED BAND (§23.12) — the band idiom (`--el-surface-soft` +
  // `--el-border` + `--el-text-strong`), in the plan page's own words.
  const discardedBand = discarded ? (
    <p
      data-testid="plan-live-discarded"
      className="flex shrink-0 items-start gap-2 border-b border-(--el-border) bg-(--el-surface-soft) px-4 py-2.5 text-xs leading-relaxed text-(--el-text-strong)"
    >
      <Info className="mt-px size-3.5 flex-none text-(--el-text-secondary)" aria-hidden="true" />
      <span>{t('discardedOutcome')}</span>
    </p>
  ) : null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="plan-proposal-views">
      {/* The PANE HEADER (Part VIII §2). The plan page's canvas pane had none —
          `PlanningWorkspace`'s `canvas` slot is filled edge to edge — so one was
          decided there rather than found. It sits at the TOP of the pane, ABOVE
          the band, because the bar governs the BODY and the band is not part of
          the body: Part VI decided the step STACKS above the canvas, and a
          switcher under the band would make the band read as chrome belonging to
          one of the two views.
          (Part VIII reserved this bar's right end for Part IX's Show-changes
          control; Part IX RELEASED it and put that control in the canvas's own
          cluster, so the bar holds the switcher alone.) */}
      {/* `@container`: the progress line drops its parts on the HEADER's width
          (§26.2), never the viewport's. */}
      <div className="@container flex h-11 shrink-0 items-center border-b border-(--el-border) bg-(--el-surface) px-(--spacing-control-x)">
        <Segmented<PlanViewDto>
          label={t('viewSwitchAria')}
          value={view}
          onChange={onViewChange}
          options={[
            { value: 'list', label: t('viewList'), icon: <List className="size-3.5" /> },
            {
              value: 'canvas',
              label: t('viewCanvas'),
              icon: <Workflow className="size-3.5" />,
            },
          ]}
        />
        {/* THE LIVE MARKER (§23.1) — the slot Part IX released. A 6px dot and a
            word, STATIC (a permanent loop here is the attention sink the running
            edge warns about). `role="status"`, so *Being written → Reconnecting*
            is heard once. It leaves at the hand-over. */}
        {/* THE PROGRESS LINE (§26.2) — marker · progress · pointer, while the
            plan is being written. It carries the marker itself. */}
        {progressReading ? (
          <PlanProgressLineView
            reading={progressReading}
            failing={progressFailing}
            density="pane"
          />
        ) : live ? (
          <span
            data-testid="plan-live-state"
            role="status"
            aria-live="polite"
            className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs text-(--el-text-secondary)"
          >
            <span
              aria-hidden="true"
              className={`size-1.5 shrink-0 rounded-(--radius-badge) ${
                liveFailing ? 'bg-(--el-warning)' : 'bg-(--el-status-in-progress)'
              }`}
            />
            {t(liveFailing ? 'liveReconnecting' : 'liveWriting')}
          </span>
        ) : null}
        {/* ONE announcement per batch of added cards (§23.15) — never per card,
            never for a read that added nothing, never for an exit or a deepen. */}
        {live ? (
          <span
            className="sr-only"
            role="status"
            aria-live="polite"
            data-testid="plan-live-announce"
          >
            {announcement ? (
              <span key={announcement.seq}>{t('liveAnnounce', { count: announcement.count })}</span>
            ) : null}
          </span>
        ) : null}
      </div>
      {band ?? discardedBand}
      <div className="relative min-h-0 flex-1">
        {/* A SECOND BODY in the same pane, never a re-drawing of the first. The
            canvas answers where a proposal LANDS; the list answers what exactly
            is being approved, which is a question about a SET. */}
        {showingList ? (
          <PlanProposalList
            items={items}
            outcome={outcome}
            live={live}
            liveDrafts={liveDraftsWithCues}
            // The row cue chip (MOTIR-11254, §31.6) — the same derivation and hold.
            rowCues={proposalCues.rows}
            discarded={discarded}
          />
        ) : null}
        {preserveCanvasLevel ? (
          // KEPT MOUNTED under List (21.7). The drilled level lives in the
          // canvas's own state, so the only way it can survive a round trip is
          // for the canvas never to unmount. `hidden` would not do: the engine
          // measures its box, and a `display: none` subtree measures zero — so it
          // is taken out of FLOW with `invisible` + `pointer-events-none` while
          // keeping its size, and out of the tab and accessibility trees with
          // `inert`.
          <div
            className={showingList ? 'pointer-events-none invisible absolute inset-0' : 'h-full'}
            // React 19 renders `inert` as a real boolean attribute from a boolean
            // prop; `false` removes it. It is what takes the hidden copy out of the
            // tab order and the accessibility tree, so `aria-hidden` is not doing
            // that job alone.
            inert={showingList}
            aria-hidden={showingList || undefined}
            data-testid="plan-review-canvas-keepalive"
          >
            {canvas}
          </div>
        ) : (
          !showingList && canvas
        )}
      </div>
    </div>
  );
}

/**
 * The announcement of a BATCH (§23.15): how many `add`s the last snapshot brought,
 * with a sequence number so two batches of the same size are both heard. The
 * first snapshot the pane draws is the baseline and announces nothing — nothing
 * ARRIVED while the reader was here. Inert unless `live`.
 */
function useBatchAnnouncement(
  items: readonly PlanReviewItemDto[],
  live: boolean,
): { count: number; seq: number } | null {
  const [state, setState] = useState<{
    items: readonly PlanReviewItemDto[];
    ids: ReadonlySet<string>;
    said: { count: number; seq: number } | null;
  }>(() => ({ items, ids: addedProposalIds(items), said: null }));
  if (items !== state.items) {
    const ids = addedProposalIds(items);
    const count = live ? newlyAddedCount(state.ids, ids) : 0;
    setState({
      items,
      ids,
      said: count > 0 ? { count, seq: (state.said?.seq ?? 0) + 1 } : state.said,
    });
  }
  return live ? state.said : null;
}

/** A step list's identity — a reading recomputes its arrays on every tick. */
function stepsKey(steps: readonly PlanProgressStep[] | null): string {
  return steps
    ? steps.map((x) => `${x.sessionKey}|${x.kind}|${x.targetNodeId}|${x.startedAt}`).join(',')
    : '';
}

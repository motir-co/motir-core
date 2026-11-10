'use client';

import {
  SurfaceTitle,
  useSurfaceTitleResolver,
} from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';
import { EpicNotPublicPill } from '@/components/issues/EpicNotPublicPill';
import type { MouseEvent } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Hash, Sparkles } from 'lucide-react';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { WorkItemBlockedTag, WorkItemStateTags } from '@/components/workItems/WorkItemStateTags';
import { CiStateBadge } from '@/components/github/CiStateBadge';
import { ObsolescenceBadge } from '@/components/issues/ObsolescenceBadge';
import { DecisionWaitingMarker } from '@/components/approvals/DecisionWaitingMarker';
import { ReviewMarker } from '@/components/approvals/ReviewMarker';
import { ReviewedBadge } from '@/components/approvals/ReviewedBadge';
import { ToFixTag, toFixTagId, toFixTagState } from '@/components/workItems/ToFixTag';
import { formatDurationMinutes } from '@/lib/utils/duration';
import { formatStoryPoints } from '@/lib/estimation/scales';
import type { BoardCardDto } from '@/lib/dto/boards';
import { decisionBesideReview } from '@/lib/dto/reviewState';
import { planHoldKey, type PlanHoldDTO } from '@/lib/dto/plans';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { planRowDestination, sessionHoldDestination } from '@/lib/planning/planDestination';
import { sessionHolderSentence } from '@/components/issues/StatusHeldNotice';
import { WorkItemActionsMenu } from '@/components/issues/actions/WorkItemActionsMenu';
import { Avatar, PriorityValue } from '../../items/_components/issueCellPrimitives';
import { useProjectAccess } from '../../_components/ProjectAccessProvider';
import { useNotifyIssuesChanged } from '../../_components/CreateIssueProvider';
import {
  BoardCardHeldRefusal,
  PLAN_FOOTER_CLASS,
  PlanHoldMarker,
  useBoardHeldRefusal,
} from './BoardHeldRefusal';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

// BoardCard (Subtask 3.2.3 · drag wired in 3.2.4) — the compact issue card per
// `design/boards/board.mock.html` (`.bcard`). It REUSES the shipped issue
// primitives so a card renders IDENTICALLY to the same issue in the list (the
// reuse rule, notes.html #31 — no forked card vocabulary):
//   - `IssueTypeIcon` — the kind glyph in its `--el-type-*` hue (finding #54)
//   - `PriorityValue` / `PRIORITY_META` — the exact priority chip the issue list
//     renders (Pill tone + direction icon); the mock's 3-bucket colouring is
//     illustrative, PRIORITY_META is the single source of truth (decision ladder
//     rung 2 + the design-notes' "PRIORITY_META tone" instruction)
//   - `Avatar` — the initial-letter assignee avatar (unassigned → a dashed
//     placeholder, the one treatment the shipped Avatar doesn't cover)
//
// Clicking the card opens the EXISTING `IssueQuickView` peek (Story 2.5) via the
// `onOpenQuickView` handler the board page wired in 3.2.2 — never a new detail
// surface, never a full-page navigation.
//
// DRAG (3.2.4): the WHOLE card is the dnd-kit drag handle (the grip is the
// affordance cue, design panel 1). The card is a `useSortable` draggable:
//   - Pointer: a click (no movement) opens the quick view; a drag (the pointer
//     sensor's 8px activation distance) lifts the card instead — the two never
//     fire together.
//   - Keyboard: per 3.2.2, ENTER opens the quick view (native button activation)
//     while SPACE picks the card up for a keyboard drag (the keyboard sensor's
//     only start key — see BoardContainer). Escape cancels mid-drag.
// While lifted the in-place card becomes a dashed 40%-opacity GHOST marking the
// insertion slot (design panel 1, "source card leaves a dashed ghost"); the
// lifted clone is rendered by the board's `DragOverlay` (see BoardCardView).
//
// A board card carries only `assigneeId` on the `BoardCardDto` (Story 3.1.4), so
// the parent column resolves the id → display name from the workspace members
// the board page passes down, and hands the resolved `assigneeName` (or null) in.
// The decision-waiting marker's `routedToName` is resolved the same way, from
// `pendingDecision.routedToId` (MOTIR-5877).

/** The DOM id the card `<button>` points `aria-describedby` at (MOTIR-5877). */
export function decisionMarkerId(cardId: string): string {
  return `decision-marker-${cardId}`;
}

/** The DOM id of the card's Reviewed badge, which the card's `aria-describedby` names. */
export function reviewedBadgeId(cardId: string): string {
  return `reviewed-badge-${cardId}`;
}

/**
 * Which marker the EXCLUSIVE SLOT draws, in the design's precedence (MOTIR-5875; § 32.1 of
 * the review path, MOTIR-10341): a decision waiting on YOU › `Blocked` › a review marker or
 * a decision waiting on someone else › the priority chip. The awaiting `agent_review` gate
 * is the one decision a review marker tells, so {@link decisionBesideReview} drops its
 * decision marker first; no other gate awaits beside it (no approve-and-merge gate exists
 * while the review awaits), so the review marker is checked before `decision` only to keep
 * the order total.
 */
function slotOf(
  card: BoardCardDto,
): 'decisionYours' | 'blocked' | 'review' | 'decision' | 'priority' {
  const pending = decisionBesideReview(card.pendingDecision, card.review);
  if (pending?.state === 'yours') return 'decisionYours';
  if (!card.ready) return 'blocked';
  if (card.review?.marker) return 'review';
  if (pending) return 'decision';
  return 'priority';
}

/** Does the card wear a Reviewed badge? */
function wearsReviewedBadge(card: BoardCardDto): boolean {
  return Boolean(card.review?.reviewed);
}

/**
 * dnd-kit's instructions id joined with the marker's, when the slot draws the
 * marker, the To fix tag's, when the card draws the tag (MOTIR-6610), and the
 * Reviewed badge's (MOTIR-10341) — the card is one `<button>`, so its own label
 * would otherwise hide them.
 */
function describedBy(dndId: string | undefined, card: BoardCardDto): string | undefined {
  const slot = slotOf(card);
  const marker =
    slot === 'decisionYours' || slot === 'decision' || slot === 'review'
      ? decisionMarkerId(card.id)
      : null;
  const toFix = toFixTagState(card.fixReason, card.statusCategory) ? toFixTagId(card.id) : null;
  const reviewed = wearsReviewedBadge(card) ? reviewedBadgeId(card.id) : null;
  const ids = [dndId, marker, toFix, reviewed].filter((id): id is string => Boolean(id));
  return ids.length > 0 ? ids.join(' ') : undefined;
}

// The presentational card body — shared by the in-list sortable card AND the
// `DragOverlay` clone, so the lifted card looks identical to its resting form.
export function BoardCardView({
  card,
  assigneeName,
  routedToName = null,
  markerId,
}: {
  card: BoardCardDto;
  assigneeName: string | null;
  /** The decision-waiting marker's routed person, resolved by the caller. */
  routedToName?: string | null;
  /** Set on the in-list card only — the drag clone must not duplicate the id. */
  markerId?: string;
}) {
  const t = useTranslations('boards');
  const estimate =
    card.estimateMinutes != null ? formatDurationMinutes(card.estimateMinutes) : null;
  // The STORY-POINT value (MOTIR-2618). Formatted with the same
  // `formatStoryPoints` the backlog / list / detail chips use, so `2` and `0.5`
  // read identically on every surface. A STATIC span, not `EstimateBadge`: the
  // whole card is the drag-handle `<button>` (see below), so the badge's
  // click-to-edit button cannot nest inside it.
  // The `agent_review` gate's decision marker steps aside for the review marker (MOTIR-10345).
  const pending = decisionBesideReview(card.pendingDecision, card.review);
  const points = card.storyPoints != null ? formatStoryPoints(card.storyPoints) : null;

  return (
    <>
      <span className="flex items-center gap-1.5">
        <IssueTypeIcon type={card.kind} className="h-4 w-4 shrink-0" />
        <span className="font-mono text-xs text-(--el-text-muted)">{card.identifier}</span>
        {/* A Visitor's PRIVATE epic (MOTIR-6648; design MOTIR-6641). */}
        {card.childrenHidden ? <EpicNotPublicPill /> : null}
        <span className="flex-1" />
        {/* Drag affordance cue — the whole card is the drag handle (3.2.4); the
            grip is the hover-revealed hint. */}
        <GripVertical
          className="h-4 w-4 shrink-0 text-(--el-text-faint) opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden
        />
      </span>

      <SurfaceTitle
        id={card.id}
        title={card.title}
        layout="clamp"
        reserveTwoLines
        className="line-clamp-2 text-[13.5px] leading-snug text-(--el-text) group-hover:underline"
      />

      {/* ⚠️ `flex-wrap` is REQUIRED by the CI badge (MOTIR-5474, design
          `board-card--ci-badge.mock.html` panel 4). This row had none, so a SECOND
          pill did not wrap — it OVERFLOWED, pushing the story-point chip and the
          avatar past the card's right edge. With it, the longest pairing (a
          decision-waiting marker + `Checks running`) takes a second line and the
          card grows by one 22px line plus the 6px gap, only in that case. */}
      <span className="flex flex-wrap items-center gap-1.5">
        {/* THE STATUS SLOT AND THE MANUAL CHIP (MOTIR-10534) — the canvas card's tag
            row, shared: Done › To plan › Ready › the status chip, then Manual. They
            come FIRST, so the row reads *what state it is in* before *what waits on
            it*. A blocked card never wears the Done stamp; its flag is louder. */}
        <WorkItemStateTags item={card} ready={card.readyToStart} blocked={!card.ready} />
        {/* THE EXCLUSIVE SLOT, in the design's precedence (MOTIR-5875 § *The board
            card's exclusive slot*): a decision waiting on YOU › `Blocked` › a
            decision waiting on someone else › the priority chip. Yours beats
            Blocked because it is the one thing here that asks the reader to act;
            Blocked beats the quiet marker because the card's own readiness is the
            more useful fact. The marker RETIRED the `Awaiting acceptance` pill
            (MOTIR-1636): every pending receipt raises an `acceptance_result` gate,
            so the two said one fact twice. State is text + glyph, never colour
            alone (finding #35). */}
        {pending?.state === 'yours' ? (
          <DecisionWaitingMarker
            id={markerId}
            state="yours"
            kind={pending.kind}
            routedToName={routedToName}
          />
        ) : !card.ready ? (
          // The canvas card's blocked flag (MOTIR-10534), in the slot the warning
          // `Blocked` pill held: one flag for one fact on every surface.
          <WorkItemBlockedTag />
        ) : card.review?.marker ? (
          // THE REVIEW MARKER (MOTIR-10341; § 32.1, M2–M4) — in the decision marker's
          // slot, at its size and precedence. No copy button here: the card is one button.
          <ReviewMarker id={markerId} marker={card.review.marker} identifier={card.identifier} />
        ) : pending ? (
          <DecisionWaitingMarker
            id={markerId}
            state="others"
            kind={pending.kind}
            routedToName={routedToName}
          />
        ) : (
          <PriorityValue priority={card.priority} />
        )}
        {/* THE TO FIX TAG (MOTIR-6610; design MOTIR-6608 panel 3): an ADDITIONAL
            pill right after the exclusive slot and before the CI badge — never IN
            the slot, so it never hides `Blocked` and is never hidden by it. The id
            rides the in-list card only (`markerId`), so the drag clone does not
            duplicate the one `aria-describedby` points at. */}
        <ToFixTag
          fixReason={card.fixReason}
          statusCategory={card.statusCategory}
          id={markerId ? toFixTagId(card.id) : undefined}
          headKey={card.fixHeadKey ?? null}
          fixing={card.fixing === true}
        />
        {/* THE OBSOLESCENCE BADGE (MOTIR-6677, `board-card--obsolescence.mock.html`):
            an ADDITIONAL pill after the exclusive slot and before the CI badge —
            it takes no slot and hides nothing. The same Pill the item header
            wears, so the mark reads one way everywhere. */}
        {card.obsolescence ? <ObsolescenceBadge mark={card.obsolescence} /> : null}
        {/* THE REVIEWED BADGE (MOTIR-10341; § 32.3, M5, M6): after the slot, before the CI
            badge. Not interactive — the card is the button — so its title names it and
            the card's `aria-describedby` reads it. */}
        {card.review ? (
          <ReviewedBadge
            review={card.review}
            interactive={false}
            id={markerId ? reviewedBadgeId(card.id) : undefined}
          />
        ) : null}
        {/* THE CI BADGE (MOTIR-5474), in the slot the design gives it: an
            ADDITIONAL pill immediately after the exclusive one, never replacing
            it — so `Blocked` and the decision-waiting marker both survive beside it.
            It draws only `failing` / `running`, and only off the `done`
            category; `ciBadgeState` is the shared rule. */}
        <CiStateBadge ciState={card.ciState} statusCategory={card.statusCategory} />
        {/* The story-point chip — `design/boards/board.mock.html`'s `.pts`
            (mono, semibold, `--el-text-secondary`), in the slot the design
            gives it: directly after the priority chip, before the spacer. The
            design-notes call this the "story-point / estimate chip" and the
            time estimate has been occupying it alone since 4.3.4; both render
            here now, points first, and each is absent when its value is null. */}
        {points ? (
          <span
            className="inline-flex items-center gap-1 font-mono text-xs font-semibold text-(--el-text-secondary)"
            title={t('storyPointsLabel', { points })}
            aria-label={t('storyPointsLabel', { points })}
          >
            {/* The `hash` glyph EstimateBadge puts on the story-point value
                everywhere else, and what the mock's `.pts { display: inline-flex;
                gap: 4px }` leaves room for. It is load-bearing, not decoration:
                rendered, a bare `5` beside the time estimate reads as one figure
                ("5 1h 30m"). Decorative + aria-hidden, so `--el-text-faint` is one
                of that token's two legitimate jobs; the label carries the meaning. */}
            <Hash className="h-3 w-3 shrink-0 text-(--el-text-faint)" aria-hidden />
            {points}
          </span>
        ) : null}
        {estimate ? (
          <span
            className="font-mono text-xs font-semibold text-(--el-text-secondary)"
            title={t('estimateLabel', { value: estimate })}
          >
            {estimate}
          </span>
        ) : null}
        <span className="flex-1" />
        {assigneeName ? (
          <span title={t('assignedTo', { name: assigneeName })}>
            <Avatar name={assigneeName} />
          </span>
        ) : (
          <span
            className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-dashed border-(--el-border-strong) bg-(--el-muted) text-[10px] font-semibold text-(--el-text-faint)"
            title={t('unassigned')}
            // A GLYPH avatar stand-in: the dash carries no meaning the label
            // does not already state, so the faint ink is one of the token's
            // two legitimate jobs (MOTIR-2475).
            role="img"
            aria-label={t('unassigned')}
          >
            –
          </span>
        )}
      </span>
    </>
  );
}

// The card body's own look — its layout, padding, type and focus ring. A card no
// plan holds adds its own border, radius and shadow ({@link CARD_CLASS}); a HELD
// card's body sits inside the plan shell, which carries them instead.
const CARD_BODY_CLASS =
  'group flex flex-col gap-2 bg-(--el-page-bg) p-(--spacing-card-padding) text-left transition-colors focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

const CARD_CLASS = `${CARD_BODY_CLASS} rounded-(--radius-card) border border-(--el-border) shadow-(--shadow-subtle) hover:border-(--el-border-strong)`;

// THE HELD SHELL (MOTIR-6268; `board--plan-hold.mock.html` `.hcard`): ONE border,
// radius and shadow around the card body AND its plan footer, so the footer reads
// as part of the item — never as one more card in the lane.
const SHELL_CLASS =
  'flex flex-col overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) transition-colors hover:border-(--el-border-strong)';

/** The shell's elevation, its sibling outline and its drag ghost, by state. */
function shellStateClass(args: { refused: boolean; outlined: boolean; dragging: boolean }): string {
  const classes = [
    args.dragging
      ? 'border-dashed opacity-40'
      : args.refused
        ? 'shadow-(--shadow-elevated)'
        : 'shadow-(--shadow-subtle)',
  ];
  // Every item of the highlighted plan: 2px `--el-status-planning`, offset 2px.
  if (args.outlined) classes.push('outline-2 outline-offset-2 outline-(--el-status-planning)');
  return classes.join(' ');
}

/**
 * THE PLAN FOOTER AT REST — the door (MOTIR-6268). A LINK where
 * `planRowDestination` sends the plan: the planning surface over THIS page with a
 * session (written with `shallowPush`, so Close returns here), `/plans/<id>`
 * without one. Its `title` is the `planState` sentence. Hover or focus outlines
 * every item of the plan; the card body's own hover does not.
 */
function PlanFooterDoor({ plan }: { plan: PlanHoldDTO }) {
  const routes = useReaderRoutes();
  const tHeld = useTranslations('approvalGate.statusHeld');
  const { onPlanFooterHover } = useBoardHeldRefusal();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const qs = searchParams?.toString() ?? '';
  const host = `${pathname}${qs ? `?${qs}` : ''}`;
  // A PLAN's door goes where `planRowDestination` sends it; an open SESSION's
  // (MOTIR-7640) to the planning surface on that session — or nowhere, for a
  // Visitor, whose footer is then a plain box.
  const destination =
    plan.kind === 'session'
      ? sessionHoldDestination({
          sessionId: plan.sessionId,
          host,
          anchorKey: plan.anchorKey,
          routes,
        })
      : planRowDestination({
          planStatus: plan.planStatus,
          planId: plan.planId,
          sessionId: plan.sessionId,
          host,
          anchorKey: plan.anchorKey,
          routes,
        });
  const key = planHoldKey(plan);
  const highlight = () => onPlanFooterHover?.(key);
  const clear = () => onPlanFooterHover?.(null);
  const title =
    plan.kind === 'session'
      ? sessionHolderSentence(plan, tHeld)
      : tHeld(`planState.${plan.planStatus}`);
  const props = {
    title,
    'data-plan-footer': key,
    'data-plan-door': destination?.kind ?? 'none',
    onMouseEnter: highlight,
    onMouseLeave: clear,
    onFocus: highlight,
    onBlur: clear,
    className: `${PLAN_FOOTER_CLASS} group/foot focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--focus-ring-color) focus-visible:outline-none`,
  };
  const content = (
    <span className="flex min-w-0 items-center gap-1.5">
      <PlanHoldMarker plan={plan} />
      <span className="flex-1" />
      {destination ? (
        <span className="inline-flex shrink-0 items-center gap-1 font-medium group-hover/foot:underline">
          <Sparkles aria-hidden className="h-3.5 w-3.5" />
          {tHeld(plan.kind === 'session' ? 'openSession' : 'reviewPlan')}
        </span>
      ) : null}
    </span>
  );
  if (!destination) {
    return (
      <div title={title} data-plan-footer={key} data-plan-door="none" className={PLAN_FOOTER_CLASS}>
        {content}
      </div>
    );
  }
  if (destination.kind === 'plan-page') {
    return (
      <Link href={destination.href} {...props}>
        {content}
      </Link>
    );
  }
  const href = destination.href;
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    // A modified or non-primary click keeps the real href (a new tab).
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    event.preventDefault();
    shallowPush(href);
  }
  return (
    <a href={href} onClick={onClick} {...props}>
      {content}
    </a>
  );
}

export function BoardCard({
  card,
  assigneeName,
  routedToName = null,
  onOpenQuickView,
}: {
  card: BoardCardDto;
  assigneeName: string | null;
  routedToName?: string | null;
  onOpenQuickView: (identifier: string) => void;
}) {
  const t = useTranslations('boards');
  const shownTitle = useSurfaceTitleResolver()(card.id, card.title);
  // MOTIR-2473 — each key read off the write it guards: a board MOVE goes
  // through `boardsService`'s `assertCanEdit` (`work_item:edit`), and the ⋯
  // menu's Delete row through `workItemsService.deleteWorkItem`
  // (`work_item:delete`). They were one boolean apart and are two permissions.
  // MOTIR-3629 makes it THREE: the menu's Archive row goes through
  // `archiveWorkItem`, which asserts `work_item:archive` — a member holds it and
  // does not hold delete, which is precisely the pair the old two booleans could
  // not tell apart.
  const { can } = useProjectAccess();
  const canEdit = can('work_item:edit');
  const canArchive = can('work_item:archive');
  const canDelete = can('work_item:delete');
  const notifyIssuesChanged = useNotifyIssuesChanged();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: card.id,
  });
  // THE PLAN HOLD (MOTIR-6268): drawn up front from the projection, and — when a
  // move was refused with `PLAN_TARGET_HELD` — from the refusal's own payload,
  // which is the fresher of the two.
  const { held, highlightedPlanId } = useBoardHeldRefusal();
  const refusedByPlan = held?.kind === 'plan' && held.workItemId === card.id;
  const planHold = refusedByPlan ? held.plan : card.planHold;
  const style = { transform: CSS.Translate.toString(transform), transition };

  const button = (
    <button
      // A held item's SHELL is the sortable node (it moves and measures as one,
      // footer included); its body stays the drag activator.
      ref={planHold ? setActivatorNodeRef : setNodeRef}
      type="button"
      onClick={() => onOpenQuickView(card.identifier)}
      aria-label={t('openIssueAria', { key: card.identifier, title: shownTitle.name })}
      data-testid={`board-card-${card.identifier}`}
      // `data-tilt` opts the kanban card into the 3D / Immersive pointer-tilt
      // (7.3.39). Inert for every other style + under reduced motion. While
      // dragging, dnd-kit's inline `transform` (a translate) overrides the
      // tilt transform, so the two never fight; at rest the tilt applies.
      data-tilt={planHold ? undefined : ''}
      // `data-surface` opts the board card into the surface-MATERIAL layer so a
      // surface-material style (glassmorphism frost, aurora glow) reaches the
      // board — not only Card-built settings surfaces. Inert under non-material
      // styles (no `[data-style] [data-surface]` rule targets them). 7.3.38.
      // A held card's SHELL carries it instead (the surface is the whole item).
      data-surface={planHold ? undefined : 'card'}
      // The held body moves with the shell (below), so it takes no transform.
      style={planHold ? undefined : style}
      // While lifted, the resting card is the dashed ghost marking the insertion
      // slot (the DragOverlay carries the visible clone); `touch-none` keeps a
      // touch-drag from scrolling the column. `cursor-grab` is the affordance.
      // Inside a plan shell the body drops its own border and shadow, and its
      // focus ring is inset so the shell's clip cannot cut it.
      className={
        planHold
          ? `${CARD_BODY_CLASS} w-full cursor-grab touch-none focus-visible:ring-inset`
          : `${CARD_CLASS} w-full cursor-grab touch-none ${
              isDragging ? 'border-dashed opacity-40' : ''
            }`
      }
      {...attributes}
      // The card's own label would hide the decision-waiting marker from a screen
      // reader (MOTIR-5875 § *The three forms*), so the button points at it —
      // only when a marker is rendered, since the slot may hold `Blocked`.
      // ⚠️ AFTER the dnd-kit spread and JOINED with it: `attributes` carries its
      // own `aria-describedby` (the keyboard-drag instructions), which a prop
      // set before the spread is silently overwritten by.
      aria-describedby={describedBy(attributes['aria-describedby'], card)}
      {...listeners}
    >
      <BoardCardView
        card={card}
        assigneeName={assigneeName}
        routedToName={routedToName}
        markerId={decisionMarkerId(card.id)}
      />
    </button>
  );

  return (
    // `relative group/card` hosts the card button + the hover-revealed ⋯ menu
    // OVERLAY (2.8.4). The menu is a SIBLING of the draggable button, never a
    // child — nesting an interactive control inside the card button would be a
    // nested-interactive a11y violation and would steal the drag pointer. The
    // plan footer's door is a sibling for the same reason, and comes right after
    // the button so it is the next tab stop after the card.
    <div className="group/card relative">
      {planHold ? (
        <div
          ref={setNodeRef}
          data-plan-id={planHoldKey(planHold)}
          data-plan-shell=""
          data-plan-outlined={highlightedPlanId === planHoldKey(planHold) ? '' : undefined}
          data-surface="card"
          data-tilt=""
          style={style}
          className={`${SHELL_CLASS} ${shellStateClass({
            refused: refusedByPlan,
            outlined: highlightedPlanId === planHoldKey(planHold),
            dragging: isDragging,
          })}`}
        >
          {button}
          {refusedByPlan ? (
            <BoardCardHeldRefusal workItemId={card.id} slot="footer" />
          ) : (
            <PlanFooterDoor plan={planHold} />
          )}
        </div>
      ) : (
        button
      )}
      {/* Hidden until the card is hovered / the menu is focused — and
        `pointer-events-none` while hidden so it never intercepts a click/drag
        meant for the card corner. */}
      <div className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover/card:pointer-events-auto group-hover/card:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 pointer-events-none">
        <WorkItemActionsMenu
          itemId={card.id}
          identifier={card.identifier}
          title={shownTitle.text}
          canEdit={canEdit}
          canArchive={canArchive}
          canDelete={canDelete}
          onDeleted={notifyIssuesChanged}
          onArchived={notifyIssuesChanged}
          triggerClassName="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) border border-(--el-border) bg-(--el-page-bg) text-(--el-text-muted) shadow-(--shadow-subtle) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        />
      </div>
      {/* A move an approval or a merge HOLDS, refused on THIS card (MOTIR-5529,
          design panel 2b) — the line sits directly under the returned card. A
          PLAN refusal opens in the plan footer above instead. */}
      <BoardCardHeldRefusal workItemId={card.id} />
    </div>
  );
}

// The lifted clone the board's `DragOverlay` renders following the cursor (design
// panel 1): tilted ~2.5°, raised to `--shadow-elevated`, accent border, grabbing
// cursor — visually distinct from both the resting card and its dashed ghost.
// Fixed-width (the column's content width) since it lives outside any column.
export function BoardCardOverlay({
  card,
  assigneeName,
  routedToName = null,
}: {
  card: BoardCardDto;
  assigneeName: string | null;
  routedToName?: string | null;
}) {
  if (card.planHold) {
    // A held item keeps its group while it moves (design panel 7): the clone
    // carries its plan footer, INERT — spans, no link, no door.
    return (
      <div
        data-surface="card"
        className={`${SHELL_CLASS} w-[17rem] rotate-2 cursor-grabbing border-(--el-accent) shadow-(--shadow-elevated)`}
      >
        <div className={CARD_BODY_CLASS}>
          <BoardCardView card={card} assigneeName={assigneeName} routedToName={routedToName} />
        </div>
        <div className={PLAN_FOOTER_CLASS} data-plan-footer-inert="">
          <PlanHoldMarker plan={card.planHold} />
        </div>
      </div>
    );
  }
  return (
    <div
      data-surface="card"
      className={`${CARD_CLASS} w-[17rem] rotate-2 cursor-grabbing border-(--el-accent) shadow-(--shadow-elevated)`}
    >
      <BoardCardView card={card} assigneeName={assigneeName} routedToName={routedToName} />
    </div>
  );
}

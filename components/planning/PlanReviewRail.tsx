'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Bot,
  Check,
  LoaderCircle,
  OctagonAlert,
  RotateCw,
  Sparkles,
  X,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { PlanChangeComposer } from '@/components/planning/PlanChangeComposer';
import { PlanDeclineConfirm } from '@/components/planning/PlanDeclineConfirm';
import { PlanStaleBand } from '@/components/planning/PlanChangeConfirmBar';
import { PlanReviewNarration } from '@/components/planning/PlanReviewNarration';
import type { PlanHistoryEventDto, PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanDecisionReasonDto } from '@/lib/dto/plans';
import type { PlanStatusDto, StaleReason } from '@/lib/dto/plans';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

// The REVIEW RAIL of the plan detail (Subtask 7.4.5 / MOTIR-847) — the chat-side
// pane of the composed canvas+chat shell. It carries the Plans-substrate chrome
// the ai-planning design §3 Panel B adds: the plan status, a history timeline,
// the per-plan staleness summary, and the Approve(materialize) / Decline gate. A
// DECIDED plan (approved/declined) is read-only — its outcome + history stay
// shown. Presentational: the parent island owns the polling + the approve/decline
// actions + the stale-warning confirm; this renders state and fires handlers.

const STATUS_TINT: Record<PlanStatusDto, string> = {
  generating: 'bg-(--el-tint-sky) text-(--el-text-strong)',
  planned: 'bg-(--el-tint-lavender) text-(--el-text-strong)',
  // The same rose the LIST row's square takes (`PlanRow`'s `STATUS_TINT`), so
  // the two surfaces agree — Part XI §2.
  stale: 'bg-(--el-tint-rose) text-(--el-text-strong)',
  approved: 'bg-(--el-tint-mint) text-(--el-text-strong)',
  declined: 'bg-(--el-muted) text-(--el-text-secondary)',
};

export function formatAt(iso: string | null, locale: string): string {
  if (!iso) return '—';
  // Fixed UTC formatting so the server + client renders match (finding #89), in
  // the reader's language (MOTIR-7771).
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

function staleReasonLabel(r: StaleReason, t: ReturnType<typeof useTranslations>): string {
  switch (r.code) {
    case 'parent_removed':
      return t('staleParentRemoved');
    case 'blocker_removed':
      return t('staleBlockerRemoved');
    case 'base_revision_drift':
      return t(`staleDrift_${r.change}`);
  }
}

/**
 * The one PLAIN LINE the approved outcome gains about the project's code (Story
 * MOTIR-1775 · MOTIR-1782) — `ready` when every row of the repository set has
 * settled, `unfinished` while any is still unresolved, null when the project has
 * no set at all.
 *
 * ⚠️ A LINE, never a count and never a repository name. The rail is the surface a
 * non-technical user reads to confirm their plan is safe; putting "2 of 3
 * repositories created" here would smuggle the whole technical vocabulary onto
 * the default path through the back door.
 */
/**
 * What the approved outcome says about the project's CODE.
 *
 *   * `ready`        — every row of the set settled AND the user can reach the
 *     repositories Motir made them.
 *   * `needs_access` — the repositories exist but nobody has been invited to
 *     them yet (MOTIR-1900). Distinct from `unfinished` because the user's next
 *     step is different: nothing is left to SET UP, only to get INTO.
 *   * `unfinished`   — a row is still proposed, creating or failed.
 */
export type PlanCodeOutcome = 'ready' | 'needs_access' | 'unfinished';

export interface PlanReviewRailProps {
  review: PlanReviewDto;
  onApprove: () => void;
  /** Decline — with the OPTIONAL reason an asked plan's confirm band collects (MOTIR-6037). */
  onDecline: (noteMd?: string | null) => void;
  busy: boolean;
  errorCode: string | null;
  /** The proposal the refusal names, when it names one (MOTIR-5418). */
  errorPlanItemId?: string | null;
  codeOutcome?: PlanCodeOutcome | null;
  /**
   * ASK MOTIR TO CHANGE THIS PLAN (Story MOTIR-3595 · Subtask MOTIR-3601;
   * `design/ai-planning/design-notes.md` Part XII).
   *
   * Optional, so every surface that renders this rail without a revision
   * affordance keeps working — and so the composer is absent rather than inert
   * where nothing can submit it.
   */
  onRevise?: (prompt: string) => void;
  /** The instruction currently in the field. Owned by the island, like the
   *  approve/decline handlers, because the island is what submits it. */
  reviseDraft?: string;
  onReviseDraftChange?: (value: string) => void;
  /** The submit is in flight LOCALLY — between the click and the route's answer,
   *  before the lease is readable. Distinct from `review.revision`, which is the
   *  server's fact. */
  revising?: boolean;
}

export function PlanReviewRail({
  review,
  onApprove,
  onDecline,
  busy,
  errorCode,
  errorPlanItemId = null,
  codeOutcome,
  onRevise,
  reviseDraft = '',
  onReviseDraftChange,
  revising = false,
}: PlanReviewRailProps) {
  const t = useTranslations('planReview');
  // ⚠️ `stale` IS NOT DECIDED, and keeping it out of this predicate is the whole
  // point (MOTIR-3578, AMENDMENT 9 D6). The plan is LIVE and awaiting action;
  // read as decided it would render the read-only outcome block and lose the
  // reviewer their controls entirely. Written as an explicit two-way test rather
  // than `!== 'planned'` so a sixth status is a question somebody has to answer
  // here rather than an answer they inherit.
  const decided = review.status === 'approved' || review.status === 'declined';
  const planned = review.status === 'planned';
  const stalePlan = review.status === 'stale';
  // ⚠️ A `generating` PLAN CAN BE ENDED, and this rail was the only thing saying
  // otherwise (MOTIR-3240, `design/ai-planning/design-notes.md` Part VIII §4).
  // `plansService.declinePlan` has accepted `generating` since MOTIR-3189 and
  // records `decisionReason: 'discarded'` for it; the route adds no guard of its
  // own. The `disabled={!planned}` that stood on the decline button was written
  // when the service DID refuse, and stayed correct-looking after it stopped —
  // so the valve had no handle, and a plan nobody was producing any more sat at
  // the top of the list with a spinner and no action.
  //
  // DISCARD, not Decline: declining is what you do to a finished proposal you
  // have read; a plan that never finished is being ENDED. `decisionReason`
  // already tells the two apart on the row, and this button is where a reader
  // learns which one they are doing.
  const generating = review.status === 'generating';
  // ⚠️ THE PLAN PROPOSES NOTHING, SO THERE IS NOTHING TO APPROVE (MOTIR-4146).
  //
  // The gate below branches on DECIDED and has never branched on EMPTY, so an
  // undecided plan holding zero proposals was handed the whole decide gate —
  // primary control included, reading *"Approve — add 0 items to your backlog"*
  // two inches under the pane's own *"Nothing will change if you approve it."*
  // One surface offering an action and describing it as a no-op.
  //
  // MOTIR-4124 mounted this rail on the empty plan deliberately, and that was
  // right: an empty plan was the ONE plan a reviewer could neither approve nor
  // decline, and it went on pausing its project's cadence. What it did not ask
  // is what the rail should OFFER once it arrived — removing a special case
  // hands every downstream branch a state it has not seen, and this branch had
  // only ever been written for a plan with something in it. The ENDING is the
  // decision the rail was mounted for, and at zero it is the only one there is.
  //
  // ⚠️ NOT-RENDERED RATHER THAN `disabled`: a disabled primary is a control a
  // reader hunts for the key to, and there is no key — no edit, no wait and no
  // permission turns an empty plan into an approvable one.
  //
  // ⚠️ AND IT IS ONE RULE ACROSS ALL THREE UNDECIDED STATUSES, `generating`
  // included. MOTIR-3240's disabled Approve beside the discard is a real
  // treatment — while items are arriving, *Approve unlocks when generation
  // completes* is true and the disabled control is what that sentence is about
  // — but its LABEL spends the count, and at zero that label is the sentence
  // this card exists to delete. So the count decides, not the status: a
  // `generating` plan that HAS proposals keeps the shipped shape untouched.
  const empty = review.itemCount === 0;
  const staleItems = review.items.filter((i) => i.stale || i.folderMissing);
  // ⚠️ A PROPOSAL FILED INTO A DELETED FOLDER MAKES APPROVE A DEAD CONTROL (Part
  // XVII §17.5). The server refuses the WHOLE approve for it (MOTIR-5423) and no
  // retry clears it — the name went with the folder — so the control is disabled
  // and the hint names the two real exits. Decline stays live.
  const folderMissingCount = review.items.filter((i) => i.folderMissing).length;
  const refusedTitle =
    errorPlanItemId !== null
      ? (review.items.find((i) => i.planItemId === errorPlanItemId)?.title ?? null)
      : null;

  // ── THE REVISION (Part XII §A/§C) ────────────────────────────────────────
  // HELD is the server's fact, read off the plan's own trail; `revising` is the
  // local window between the click and the route answering. Both hold the gate,
  // for different durations, and neither is a substitute for the other.
  const revisionInFlight = review.revision !== null;

  // ⚠️ THE TRANSCRIPT OPENS AT ITS LATEST TURN (MOTIR-4023, design Part XIII §8).
  //
  // On MOUNT, and again when a revision LANDS — the one event that appends a turn
  // while the reader is on the page. Deliberately NOT a general stick-to-bottom:
  // nothing else on this rail appends under a reader's eyes, and a region that
  // yanks itself downward on every re-render is worse than one that does not
  // move. `scrollTop` is set directly rather than through `scrollIntoView`, which
  // would move the PAGE as well as the region.
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const revisionKey = review.revision?.heldBy ?? (revisionInFlight ? 'held' : 'none');
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [revisionKey]);
  const held = revisionInFlight || Boolean(revising);
  // The affordance is present only where a revision is POSSIBLE — which falls
  // out of the placement rather than needing a second predicate: a decided plan
  // renders `DecidedOutcome` instead of the gate, so the composer is structurally
  // absent there. The explicit check is for `generating`, where the plan is not
  // yet something to revise.
  const canRevise = Boolean(onRevise) && planned;

  // ── THE PLAN GATE, on its own page (Story MOTIR-6012 · MOTIR-6037; design Part XXII
  // §22.4, §22.5, Panel 8). The existing CTA IS the gate's Approve and the ghost
  // Decline IS the gate's Decline — nothing is moved. What an ASKED plan adds: Decline
  // confirms once, in the approve language's band with an OPTIONAL reason.
  //
  // ⚠️ RETIRED 2026-10-08 by Story MOTIR-7883 (MOTIR-7885): a plan with no conversation
  // used to say why it opened here. Every plan has a session now (`createPlan` attaches
  // one; MOTIR-6020 backfilled the rest), so a null session is an invariant breach that
  // degrades to this page SILENTLY — nothing here renders a reason for it.
  const asked = !decided && review.gate?.state === 'awaiting';
  const [declineConfirming, setDeclineConfirming] = useState(false);

  return (
    <aside
      aria-label={t('reviewRailAria')}
      className="flex h-full min-h-0 min-w-0 flex-col border-l border-(--el-border) bg-(--el-surface)"
    >
      {/* THE TRANSCRIPT (MOTIR-4023, design Part XIII §8).

          The rail used to be ONE scrolling column with the decision held at its
          bottom by `mt-auto`, which reads right on a short plan and disappears on
          a long one: measured with a long generated title and a nine-turn
          timeline, the rail's scroll height is 1011px and Approve's bottom sits
          at 1037 — 361px below the fold at 1366x768, and 57px below it even at
          1920x1080. The page a reviewer arrived at to make a decision showed no
          decision, and nothing scrolled to it.

          So the scrolling stops here and the decision leaves it. The composer
          stays at the END of this region rather than moving into the footer: a
          pinned footer must have a bounded height and a composer grows with its
          draft. Part XII §A's *inside the decision block, above the two verbs* was
          an ORDER and an adjacency, and both survive — composer last in the
          transcript, verbs directly beneath it. */}
      {/* BOTH AXES ARE STATED — the third site of the rule `AppLayout`'s `<main>`
          and the nav rail's scroller already follow (MOTIR-4232), and the one
          that did not (MOTIR-4578). Left implicit, `overflow-x` does not stay
          `visible`: CSS Overflow 3 computes it to `auto` whenever the other axis
          is non-visible, so ONE unbreakable token anywhere in this pane — a
          `snake_case` identifier in a generated plan summary, measured at ~43
          characters against the 311px content column — drew a scrollbar across
          the whole rail.

          `hidden`, not `<main>`'s `auto`, and the two are not in tension: that
          scroller resolves to `auto` because content wider than the column (a
          table, a code block, a board) must stay REACHABLE. This pane holds
          PROSE, and prose that has to be scrolled sideways is prose nobody
          reads. It has nothing to reveal — provided every generated string
          WRAPS, which is the other half of this fix and what
          `tests/components/plan-review-rail-overflow.test.tsx` keeps true. The
          axis alone would hide the symptom and lose the text; the guards alone
          would leave the next unguarded field free to draw the bar again. */}
      <div
        ref={transcriptRef}
        data-testid="plan-review-transcript"
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto p-5"
      >
        <header className="flex min-w-0 flex-col gap-2">
          {/* The status is an OVERLINE on its own line ABOVE the title (MOTIR-3074),
            not a `shrink-0` pill beside it. Plan titles are GENERATED — long by
            default, and routinely carrying an unbreakable token (a SCREAMING_CASE
            constant, a repo name, a cuid) — so on a shared flex row the title wrapped
            to five lines while `items-center` held the one-line pill against the
            middle of the block, and the tag read as an annotation on line 3 of the
            sentence rather than as the plan's state. On its own line the title owns
            the full rail width, a five-line title reads exactly like a one-line one,
            and the state stays the FIRST thing read on the rail — which is what this
            pill is for ("did my plan go through?"). `self-start` keeps it at its own
            width: a flex COLUMN child would otherwise stretch to the full rail. */}
          <span
            data-testid="plan-status-pill"
            className={`inline-flex max-w-full items-center self-start rounded-(--radius-badge) px-(--spacing-chip-x-8) py-(--spacing-chip-y) text-xs font-semibold ${STATUS_TINT[review.status]}`}
          >
            {t(`status_${review.status}`)}
          </span>
          {/* The overflow guard, owed WHEREVER the pill sits. A flex/grid item's automatic
            minimum size is its longest unbreakable word, and the rail is a fixed `22rem`
            track, so a title carrying a cuid or a SCREAMING_CASE constant pushed the
            `<aside>` past it. Measured in chromium at the shipped 352px rail width, on the
            reported title: shipped shape overflowed the rail by 7px; `wrap-anywhere` alone
            cleared it, `break-words` alone did NOT (still 7px) — only `overflow-wrap:
            anywhere` feeds its break opportunities into the MIN-CONTENT size the track is
            measured from, which is the whole reason this class of bug keeps recurring here.
            `min-w-0` floors the item independently. The overline placement makes neither
            redundant: a token wider than the FULL column still overflows without them
            (324px on a 60-character token, 0px with them). */}
          <h2 className="min-w-0 font-serif text-lg font-semibold wrap-anywhere text-(--el-text)">
            {review.title ?? t('untitledPlan')}
          </h2>
          {/* The SAME guard the `<h2>` above carries, and it was owed here first
              (MOTIR-4578). The title is one generated line; this paragraph is a
              whole agent-written planning turn, so it is the likelier carrier of
              an unbreakable token by a wide margin — and it shipped with
              neither class. `wrap-anywhere` rather than `break-words` for the
              reason measured on the title: only `overflow-wrap: anywhere` feeds
              its break opportunities into the MIN-CONTENT size the fixed 22rem
              track is measured from. */}
          {review.summary ? (
            <div className="min-w-0 text-sm wrap-anywhere text-(--el-text-secondary)">
              <MarkdownView value={review.summary} workItemRefs={review.summaryRefs ?? {}} />
            </div>
          ) : null}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-(--el-text-secondary)">
            <span>{t('itemCount', { n: review.itemCount })}</span>
            <ReviewAttribution review={review} t={t} />
          </p>
        </header>

        {/* HISTORY timeline */}
        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] font-bold tracking-[0.05em] text-(--el-text-secondary) uppercase">
            {t('history')}
          </h3>
          <ol className="flex flex-col gap-2">
            {review.history.map((ev) => (
              <HistoryRow key={ev.id} ev={ev} t={t} />
            ))}
            {!decided ? (
              <li className="flex items-center gap-2 text-sm text-(--el-text-secondary)">
                <span
                  className="size-1.5 shrink-0 rounded-full bg-(--el-border-strong)"
                  aria-hidden
                />
                {t('awaitingReview')}
              </li>
            ) : null}
          </ol>
        </section>

        {/* THE PLANNER'S NARRATION (Story MOTIR-8060 · MOTIR-8064) — the same
            groups the overlay's chat panel draws, from the review this page
            polls, for a member and a Visitor alike. */}
        <PlanReviewNarration review={review} />

        {/* STALENESS summary */}
        {review.stale || folderMissingCount > 0 ? (
          <section
            data-testid="stale-summary"
            className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-tint-yellow)/40 p-(--spacing-card-padding-12)"
          >
            <p className="flex items-center gap-1.5 text-sm font-semibold text-(--el-text-strong)">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              {t('staleSummary', {
                n:
                  review.staleCount +
                  review.items.filter((i) => i.folderMissing && !i.stale).length,
              })}
            </p>
            <ul className="flex flex-col gap-1">
              {/* Each row is guarded for the same reason as the summary
                  (MOTIR-4578): it renders a card TITLE, which is generated text
                  and routinely carries a cuid or a SCREAMING_CASE constant. This
                  branch cannot draw the reported bar (that plan was `approved`,
                  and only a stale one renders here) — it is the same defect one
                  branch over, and shipping the fix for one generated field while
                  leaving its neighbour is precisely how this card came to
                  exist. `overflow-wrap` inherits, so the `<li>` covers the
                  `<span>` inside it. */}
              {staleItems.map((item) => (
                <li
                  key={item.planItemId}
                  className="min-w-0 text-xs wrap-anywhere text-(--el-text-secondary)"
                >
                  <span className="font-medium text-(--el-text)">{item.title}</span>
                  {' — '}
                  {[
                    ...item.staleReasons.map((r) => staleReasonLabel(r, t)),
                    ...(item.folderMissing ? [t('staleFolderRemoved')] : []),
                  ].join(', ')}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* IN FLIGHT — not an alert: nothing failed, the planner is working.
              `--el-tint-sky` is the one tint no plan STATUS spends, so the band
              cannot be read as one. */}
        {!decided && revisionInFlight ? (
          <div
            data-testid="plan-revision-running"
            className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-strong)"
          >
            <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden="true" />
            <span className="min-w-0 wrap-anywhere">
              {review.revision?.heldBy
                ? t('reviseRunningBy', { harness: review.revision.heldBy })
                : t('reviseRunning')}
            </span>
          </div>
        ) : null}
        {canRevise ? (
          <div className="flex flex-col gap-2 border-t border-(--el-border) pt-3">
            {/* The shipped composer, with the `@` picker suppressed — it
                  searches COMMITTED work items and a revision can only name
                  PROPOSALS (Part XII §B). */}
            <PlanChangeComposer
              draft={reviseDraft}
              onDraftChange={onReviseDraftChange ?? (() => {})}
              targets={[]}
              onAddTarget={() => {}}
              onRemoveTarget={() => {}}
              onSubmit={(text) => onRevise?.(text)}
              placeholder={t('revisePlaceholder')}
              disabled={held || busy}
              mentions={false}
            />
            {/* Only while the field carries text: at rest the placeholder is
                  the whole ask, and the one thing a reviewer needs to know the
                  moment an instruction exists is that Send does not approve. */}
            {reviseDraft.trim().length > 0 ? (
              <p className="text-xs text-(--el-text-secondary)">{t('reviseNote')}</p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* THE PINNED FOOTER — the decision, and the room the orb needs.

          `--el-surface` on `--el-surface`, so a top HAIRLINE is the whole
          separation needed and there is no shadow: a shadow would imply the
          footer floats over a different surface, which it does not.

          ⚠️ THE BOTTOM PADDING IS THE ORB'S (Part XIII §2 and §8). With
          MOTIR-4019 the pane spends the shell's clearance band, so the rail's
          bottom becomes the window's bottom — and the floating Plan-with-AI orb
          is `fixed right-5 bottom-5`, 56px square, which puts it over the rail's
          last 76px. Measured at 1440x900: the orb's top is 824 and the rail's
          bottom becomes 900, so without this the orb covers Decline. It reads the
          SHELL's own property directly rather than `--canvas-fold-inset`, which
          is the canvas's indirection for a SHARED component; this rail is not
          one. */}
      <div className="flex shrink-0 flex-col gap-2 border-t border-(--el-border) bg-(--el-surface) px-5 pt-4 pb-[calc(var(--spacing-control-y)+var(--shell-bottom-clearance,1.5rem))]">
        {errorCode === 'APPROVAL_GATE_STALE_SUBJECT' ? (
          // REFUSED AS STALE (MOTIR-6037; design Part XXII §22.5): the plan moved under the
          // reader, nothing was decided, and the re-read plan is what the verbs below
          // now decide. The design's words, on the *changed under you* yellow.
          <PlanStaleBand place="rail" />
        ) : errorCode ? (
          <p role="alert" className="text-xs font-medium text-(--el-danger-on-surface)">
            {/* The REFUSAL that beats the optimistic hold gets its own sentence
                (Part XII §C). A lease can be taken between the render and the
                click, so the disabled state is a courtesy and the server's answer
                is the guarantee — two mechanisms, because the client cannot know
                and the server can. */}
            {errorCode === 'PLAN_REVISION_IN_FLIGHT'
              ? t('reviseRefused')
              : errorCode === 'PLAN_FOLDER_MISSING'
                ? t('approveFolderMissingRefused', { title: refusedTitle ?? '' })
                : t('actionError')}
          </p>
        ) : null}
        {decided ? (
          <DecidedOutcome review={review} t={t} codeOutcome={codeOutcome ?? null} />
        ) : (
          <>
            {empty ? null : (
              <Button
                variant="primary"
                onClick={onApprove}
                disabled={!planned || busy || held || folderMissingCount > 0}
                loading={busy}
                leftIcon={<Check className="size-4" aria-hidden="true" />}
                // The rail is a fixed 352px, so this full-width button cannot
                // widen: its sentence-long label ("Genehmigen – 1 Element zum
                // Backlog hinzufügen") wraps at a word onto a second line and the
                // button grows from its token MINIMUM height (MOTIR-7759).
                // `break-keep` (word-break: keep-all) makes that wrap land at a
                // SPACE in Chinese, Japanese and Korean too: by default a CJK
                // line may break between any two characters, which split ja 追加
                // across the lines. Every CJK value of this label carries spaces
                // around its count, and keep-all changes nothing for Latin text
                // (MOTIR-7761).
                className="h-auto min-h-(--height-btn-md) py-(--spacing-btn-y) text-center leading-snug break-keep whitespace-normal"
              >
                {t('approveCta', { n: review.itemCount })}
              </Button>
            )}
            {/* One control per state. While `generating` the discard is the only
                LIVE control on the rail, so it takes the `secondary` variant — a
                real affordance rather than a ghost that reads as disabled beside
                a genuinely disabled Approve. */}
            {generating ? (
              <Button
                variant="secondary"
                data-testid="plan-discard"
                onClick={() => onDecline()}
                // A plan is `generating` while a revision rewrites it too (it
                // re-opens the plan, MOTIR-8208), and the discard is refused under
                // the lease exactly as Decline is — so it is held with it.
                disabled={busy || held}
                leftIcon={<X className="size-4" aria-hidden="true" />}
              >
                {t('discardCta')}
              </Button>
            ) : asked && declineConfirming ? (
              // DECLINE ASKS ONCE (Panel 8) — the band takes the ghost Decline's place,
              // bled to the footer's edges like the rail's other full-width bands.
              <PlanDeclineConfirm
                className="-mx-5"
                deciding={busy}
                onCancel={() => setDeclineConfirming(false)}
                onConfirm={(noteMd) => {
                  setDeclineConfirming(false);
                  onDecline(noteMd);
                }}
              />
            ) : (
              <Button
                variant="ghost"
                // An ASKED plan's Decline confirms first (MOTIR-6037); every other
                // decline — a `stale` plan's, an unasked one's — is the shipped press.
                onClick={() => (asked ? setDeclineConfirming(true) : onDecline())}
                // ⚠️ A `stale` PLAN CAN BE DECLINED, and the button must say so
                // (MOTIR-3579, AMENDMENT 9 D4). Declining is one of a stale
                // plan's only two exits — the other is waiting for the drift to
                // reverse — so a disabled control here would make the status a
                // dead end wearing a live face, which is the shape MOTIR-3240
                // found on `generating`: the service accepted the act and the
                // rail was the only thing saying otherwise.
                //
                // It is enabled TOGETHER WITH `declinePlan`'s guard widening, in
                // one commit, so the rail never offers a button the service
                // rejects.
                // …AND a revision holds it too (MOTIR-3598, AMENDMENT 10 D2).
                // `declinePlan` refuses under the lease whatever the status, so
                // a `stale` plan being declinable does not make it declinable
                // WHILE something is rewriting it: a revision that finishes into
                // a closed decision leaves proposals on a plan nobody will read.
                disabled={(!planned && !stalePlan) || busy || held}
                leftIcon={<X className="size-4" aria-hidden="true" />}
              >
                {t('declineCta')}
              </Button>
            )}
            {/* The hint is REPLACED for `generating`, not removed. `reviewLocked`
                — "Review unlocks when generation completes" — was true of both
                buttons and is now true of one, and a hint under two buttons that
                describes only one is how the live control reads as disabled too. */}
            {/* ⚠️ THE `stale` LINE IS AN OUTCOME, NOT A HINT, which is why it is
                its own paragraph above the shared one rather than a fourth
                branch inside it (Part XI §5). `declined`'s line is an ENDING —
                *your tree was left untouched* — and this one is not: it has to
                say what happened AND what is left to do, and it must not offer
                a repair that does not exist. AMENDMENT 9 D4 established there is
                no `stale → generating` edge, so the copy names the two real
                exits and nothing else. */}
            {stalePlan ? (
              <p
                data-testid="plan-stale-outcome"
                className="flex items-start gap-1.5 text-sm font-medium text-(--el-text)"
              >
                <OctagonAlert
                  className="mt-0.5 size-4 shrink-0 text-(--el-danger)"
                  aria-hidden="true"
                />
                {t('staleStatusOutcome')}
              </p>
            ) : null}
            {/* ⚠️ `held` IS THE OUTERMOST BRANCH, above every status. A plan
                being `stale`, or `generating`, says what a reviewer may do with
                it in general; a revision holding it says what they may do RIGHT
                NOW, and that answer outranks the others for as long as it lasts
                (MOTIR-3598, AMENDMENT 10 D2). */}
            {/* While Decline's band is up it IS the explanation (Panel 8 draws no hint). */}
            {asked && declineConfirming ? null : (
              <p className="text-center text-xs text-(--el-text-secondary)">
                {held
                  ? t('approveHintRevising')
                  : // ⚠️ THE EMPTY ARM SITS DIRECTLY UNDER `held` AND ABOVE THE
                    // STATUS CHAIN (MOTIR-4146). Every line below it describes
                    // Approve — *Approve materializes the proposals*, *Approve is
                    // unavailable*, *Review unlocks when generation completes* —
                    // and on an empty plan there is no Approve for them to be
                    // about. `generating` is the exception and keeps its own
                    // hint: there, items are still arriving, so *Approve unlocks
                    // when generation completes* is a true sentence about a
                    // control that is coming.
                    empty && !generating
                    ? t('emptyHint')
                    : planned
                      ? folderMissingCount > 0
                        ? t('approveHintFolderMissing', { n: folderMissingCount })
                        : review.stale
                          ? t('approveHintStale', { n: review.staleCount })
                          : t('approveHint')
                      : generating
                        ? t('discardHint')
                        : stalePlan
                          ? t('staleReviewHint')
                          : t('reviewLocked')}
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * WHO ASKED for this plan and WHO WROTE it (MOTIR-2991,
 * `design/ai-planning/design-notes.md` Part III §6).
 *
 * Two differences from the LIST row, both deliberate:
 *
 *  1. The ROLES ARE NAMED IN WORDS — `Requested by X · written by Y`. The row is
 *     scanned, and an avatar in front of a name already reads as *this person's*;
 *     this header is read ONCE, by the person about to press Approve, and there
 *     the words are what stop two names being taken for one party.
 *  2. It KEEPS the requester on a DECIDED plan, which the row drops. The row's
 *     reason does not apply here: the decider is not in this line at all — it is
 *     in the history timeline below — so no two bare names compete.
 *
 * It also carries the MODEL, which the row omits: it is the difference between
 * two agent-written plans, and nobody scans a list on it.
 *
 * The glyphs are DECORATIVE (`aria-hidden`, `--el-text-faint`) — the words carry
 * the meaning, so neither party is conveyed by icon or colour alone.
 */
function ReviewAttribution({
  review,
  t,
}: {
  review: PlanReviewDto;
  t: ReturnType<typeof useTranslations>;
}) {
  // WHO WROTE it, read off `authorSource` ALONE (MOTIR-2996) — `mcp` + a harness
  // is an agent, `native` is Motir. The header used to infer the Motir case from
  // `sourceJobId != null`, which answered WHICH JOB and stood in for WHO only
  // while a motir-ai job was the sole non-MCP writer of a `Plan`.
  const agent =
    review.authorSource === 'mcp' && review.authorHarness
      ? { Icon: Bot, label: t('writtenByHarness', { harness: review.authorHarness }) }
      : review.authorSource === 'native'
        ? { Icon: Sparkles, label: t('writtenByMotir') }
        : null;
  const cadence = review.origin === 'cadence';
  const requester = review.createdByName;
  if (!agent && !requester && !cadence) return null;

  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      {requester ? (
        <>
          <span
            className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-(--el-text) text-[9px] font-semibold text-(--el-text-inverted)"
            aria-hidden
          >
            {requester.charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0 truncate" title={requester}>
            {t('requestedBy', { name: requester })}
          </span>
        </>
      ) : cadence ? (
        <>
          <RotateCw className="h-3 w-3 shrink-0 text-(--el-text-faint)" aria-hidden />
          {t('autoPlannedNobodyAsked')}
        </>
      ) : null}
      {(requester || cadence) && agent ? (
        <span className="text-(--el-text-faint)" aria-hidden>
          ·
        </span>
      ) : null}
      {agent ? (
        <>
          <agent.Icon className="h-3 w-3 shrink-0 text-(--el-text-faint)" aria-hidden />
          <span className="min-w-0 truncate" title={review.authorHarness ?? undefined}>
            {agent.label}
          </span>
          {review.authorModel ? (
            <>
              <span className="text-(--el-text-faint)" aria-hidden>
                ·
              </span>
              <span className="min-w-0 truncate text-(--el-text-secondary)">
                {review.authorModel}
              </span>
            </>
          ) : null}
        </>
      ) : null}
    </span>
  );
}

/**
 * WHO a timeline row names (`design/ai-planning/design-notes.md` Part X §4).
 *
 * Three actors, one clause, and NO second treatment for any of them:
 *
 *  * **a person** — their display name, which is exactly what the shipped
 *    decision row already renders.
 *  * **an agent** (`actorSource === 'mcp'`) — the bare HARNESS name. A harness
 *    name is not a person's name and must not be dressed as one, so it takes no
 *    avatar, no initial disc and no colour of its own. The 18px disc is the
 *    human's mark and lives in the header, where one line names one person; on
 *    this list an unadorned name is a person and a name that is a harness is not.
 *  * **Motir** (`actorSource === 'native'`) — the product name.
 *
 * ⚠️ THE MODEL IS NOT IN THE CLAUSE. Measured while drawing the asset, at the
 * rail's real 298px text column: `5 proposals appended · Claude Code` is a 36px
 * row and `… · claude-opus-5` is 56px, so the model costs a second line on every
 * row — and the header's attribution line carries it once already. It rides the
 * row's `title` instead, where it costs nothing.
 *
 * Null when NOBODY acted as a person and no agent is named: a cadence-originated
 * mutation has no requester, and the row says so by omitting the clause rather
 * than by attributing it to the project owner.
 */
function actorLabel(ev: PlanHistoryEventDto, t: ReturnType<typeof useTranslations>): string | null {
  // ⚠️ THE AGENT WINS, and the order is the decision rather than an accident.
  // An agent authors under a PERSON's credential, so an agent-written row carries
  // BOTH an acting user and an agent triple — and the four rows of Part X §4's
  // table are mutually exclusive on `actorSource`, not on whether a name happens
  // to be present. Reading `byName` first names the TOKEN'S OWNER on every row an
  // agent wrote, which is precisely the *who wrote it* / *who asked for it*
  // conflation the header spells out in words to avoid. The requester is on the
  // header, once; a row says who performed THIS act.
  if (ev.actorSource === 'mcp' && ev.actorHarness) return ev.actorHarness;
  if (ev.actorSource === 'native') return t('actorMotir');
  if (ev.byName) return ev.byName;
  return null;
}

function HistoryRow({ ev, t }: { ev: PlanHistoryEventDto; t: ReturnType<typeof useTranslations> }) {
  const locale = useLocale();
  // A CONTENT event carries a count; a lifecycle event does not. The label is
  // the only thing that tells the two apart, and that is the decision — Part X
  // §2: one sequence, one grammar, and the wording is the discriminator.
  const label =
    ev.count === undefined ? t(`event_${ev.kind}`) : t(`event_${ev.kind}`, { n: ev.count });
  const actor = actorLabel(ev, t);
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-(--el-accent)" aria-hidden="true" />
      <div className="flex min-w-0 flex-col">
        {/* `--el-text-secondary` (6.24:1 on the rail's `--el-surface`), NOT
            `--el-text-muted` (4.17:1, below AA). The muted token was safe by
            accident while only the decision row carried a name; it is now on most
            rows, and `CLAUDE.md`'s measured table is explicit that muted clears AA
            on the white page only. */}
        <span className="text-(--el-text)" title={ev.actorModel ?? undefined}>
          {label}
          {actor ? <span className="text-(--el-text-secondary)"> · {actor}</span> : null}
        </span>
        {/* A collapsed RUN reads as a SPAN in the same slot a single event's
            timestamp uses — no badge, no chip, no second line (Part X §5). */}
        <span className="text-xs text-(--el-text-secondary)">
          {ev.until
            ? t('eventSpan', { from: formatAt(ev.at, locale), to: formatAt(ev.until, locale) })
            : formatAt(ev.at, locale)}
        </span>
      </div>
    </li>
  );
}

/**
 * WHICH sentence a non-approved outcome gets (MOTIR-3189).
 *
 * `declined` covers three histories and used to render one line for all of them,
 * so a plan that died halfway through generating was reported to its owner as a
 * plan somebody had read and rejected. The reason is what separates them; a
 * `reviewed` reason and a NULL one both take the original wording, because a
 * null means *not recorded* (every row written before the column existed) and
 * the original wording is the one that was true for those rows.
 *
 * Total over the union rather than a lookup with a fallback, so adding a reason
 * to `PlanDecisionReasonDto` is a type error here rather than a plan silently
 * rendering as reviewed-and-rejected.
 */
function declinedOutcomeKey(reason: PlanDecisionReasonDto | null): string {
  switch (reason) {
    case 'discarded':
      return 'discardedOutcome';
    case 'abandoned':
      return 'abandonedOutcome';
    case 'reviewed':
    case null:
      return 'declinedOutcome';
  }
}

function DecidedOutcome({
  review,
  t,
  codeOutcome,
}: {
  review: PlanReviewDto;
  t: ReturnType<typeof useTranslations>;
  codeOutcome: PlanCodeOutcome | null;
}) {
  const routes = useReaderRoutes();
  const tRepo = useTranslations('repositorySet');
  const approved = review.status === 'approved';
  return (
    <div className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-(--spacing-card-padding-12)">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-(--el-text)">
        {approved ? (
          <Sparkles className="size-4 shrink-0 text-(--el-success)" aria-hidden="true" />
        ) : (
          <X className="size-4 shrink-0 text-(--el-text-muted)" aria-hidden="true" />
        )}
        {approved
          ? t('approvedOutcome', { n: review.itemCount })
          : t(declinedOutcomeKey(review.decisionReason))}
      </p>
      {approved && codeOutcome ? (
        <p
          data-testid="plan-code-outcome"
          className="flex items-center gap-1.5 text-sm text-(--el-text-secondary)"
        >
          {codeOutcome === 'ready' ? (
            <Check className="size-4 shrink-0 text-(--el-success)" aria-hidden="true" />
          ) : (
            <AlertTriangle className="size-4 shrink-0 text-(--el-warning)" aria-hidden="true" />
          )}
          {codeOutcome === 'ready'
            ? tRepo('outcomeReady')
            : codeOutcome === 'needs_access'
              ? tRepo('outcomeNeedsAccess')
              : tRepo('finishSetupLink')}
        </p>
      ) : null}
      {approved ? (
        <Link
          href={routes.view('/items')}
          className="text-xs font-medium text-(--el-link) hover:text-(--el-link-pressed)"
        >
          {t('viewInBacklog')}
        </Link>
      ) : null}
    </div>
  );
}

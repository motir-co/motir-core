'use client';

import { useTranslations } from 'next-intl';
import { Check, CirclePause, LoaderCircle, Lock, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { PlanDeclineConfirm } from '@/components/planning/PlanDeclineConfirm';
import {
  PlanApproveProgress,
  type PlanApproveProgressView,
} from '@/components/planning/PlanApproveProgress';
import type { PlanChangeDiffIndex } from '@/lib/planning/planChangeDiff';
import type { PlanGateView } from '@/lib/planning/planGateView';

// The CONFIRM-TO-PERSIST bar under the plan-change canvas (Subtask MOTIR-1730;
// design panel 4's `persistbar`, composed unchanged from
// `planning-workspace.mock.html` sheets 2 + 6 — only the copy names the
// add / change counts).
//
// It is the GATE: nothing the conversation proposed has reached the database, and
// this is where that becomes true (Approve) or is dropped (Discard, which writes
// nothing). After EITHER, the conversation stays open — the bar simply goes away
// with the proposal, and the rail keeps the thread.
//
// ⚠️ FOR AN ASKED PLAN IT IS THE PLAN GATE'S DECISION (Story MOTIR-6012 · MOTIR-6037;
// `design/ai-planning/design-notes.md` Part XXII §22.4–§22.5, `plan-review--decide.mock.html`
// Panels 2–5, 7). A plan waiting in To approve is decided HERE, through the one decide
// door (MOTIR-6038), and the bar's two controls become the gate's two verbs:
// **Decline** (ghost, left) and **Approve** (primary, check, right), with the
// consequence line in place of *Nothing is saved until you approve*. Nothing is added
// beside them, and there is NO *Request changes*: a plan is changed by talking to the
// planner, which is the composer beside this bar (ADR §11.4). Decline confirms once, in
// the approve language's own inline band, stacked ABOVE the bar while its verbs step
// aside; a press refused as STALE says so in a yellow band directly above the verbs it
// refused. The shipped words stay for a proposal nobody has been asked about.

/**
 * The bar's own height, as ONE definition (Subtask MOTIR-6186;
 * `design/ai-planning/design-notes.md` Part XXI 21.8).
 *
 * The planning surface no longer puts this bar in a footer slot below the canvas
 * box — it floats it OVER the box's bottom edge, so that hiding it when there is
 * nothing to decide resizes nothing. For that to work the canvas has to keep its
 * three bottom-anchored control clusters clear of the strip the bar will occupy,
 * whether or not the bar is up, and it does that with a `--canvas-foot` inset.
 *
 * ⚠️ THE POINT IS THAT THERE IS ONE NUMBER, NOT THAT THE NUMBER IS CLEVER. The
 * hazard Part XXI names is two numbers drifting apart — a magic `min-h` on one
 * side and a magic inset on the other — so the bar and the inset read this, and
 * `tests/components/plan-confirm-bar-height.test.tsx` asserts the bar the browser
 * actually lays out is this tall. A pinned number that is CHECKED cannot drift
 * silently; an unchecked one is exactly what the rule is about.
 *
 * The residual, stated rather than hidden: the bar is `min-height`, so content
 * taller than this grows it and the inset would then be a little short. The test
 * is what makes that a visible failure instead of a quiet one.
 */
export const PLAN_CONFIRM_BAR_HEIGHT = '3.5rem';

export interface PlanChangeConfirmBarProps {
  index: PlanChangeDiffIndex;
  /** A decision is in flight. BOTH decisions write now (approve materializes,
   *  discard declines the plan), so both must lock the bar — not just approve. */
  deciding: boolean;
  onApprove: () => void;
  onDiscard: () => void;
  /** Which of the gate's states the plan is in (MOTIR-6037). Absent → `ungated`. */
  view?: PlanGateView;
  /** Decline was pressed HERE — the confirm band is up above the bar. */
  declining?: boolean;
  /** Put the decline's confirm band up (the gated Decline's press). */
  onRequestDecline?: () => void;
  onCancelDecline?: () => void;
  /** Decline, with the optional reason. */
  onConfirmDecline?: (noteMd: string | null) => void;
  /** A press HERE was refused as stale — the band says so above the verbs. */
  staleRefused?: boolean;
  /** The approve's progress (MOTIR-5249; Part XXV). `running`: the bar's contents
   *  become the progress, inside this same element at its own height. `timedOut`: the
   *  band stacks above the bar, as the stale band does, with the verbs back. */
  approveProgress?: PlanApproveProgressView | null;
  /** The plan is OUT OF DATE (MOTIR-7932; design state 10): the bar keeps its
   *  place, loses its verbs, and says why on the warning role. */
  stale?: boolean;
  /** The plan STOPPED before every card was written (Bug MOTIR-11701): the bar keeps
   *  Discard, drops Approve, and says a Resume is what finishes it. */
  stopped?: boolean;
}

export function PlanChangeConfirmBar({
  index,
  deciding,
  onApprove,
  onDiscard,
  view = { kind: 'ungated' },
  declining = false,
  onRequestDecline,
  onCancelDecline,
  onConfirmDecline,
  staleRefused = false,
  approveProgress = null,
  stale = false,
  stopped = false,
}: PlanChangeConfirmBarProps) {
  const t = useTranslations('planningWorkspace.conversation');
  const tp = useTranslations('approvalGate.planApproval.surface');
  const tReview = useTranslations('planReview');
  const tHeld = useTranslations('approvalGate.statusHeld');
  if (stopped) {
    return (
      <div
        data-testid="plan-change-confirm-bar"
        data-plan-state="stopped"
        className="flex shrink-0 items-center gap-3 border-t border-(--el-border) bg-(--el-tint-peach) px-4 py-2.5 text-xs leading-relaxed text-(--el-text-strong)"
        style={{ minHeight: PLAN_CONFIRM_BAR_HEIGHT }}
      >
        <CirclePause className="size-3.5 flex-none" aria-hidden="true" />
        <span className="min-w-0 flex-1">{tHeld('planState.stopped')}</span>
        <Button variant="ghost" size="sm" onClick={onDiscard} disabled={deciding}>
          {t('discard')}
        </Button>
      </div>
    );
  }
  if (stale) {
    return (
      <div
        data-testid="plan-change-confirm-bar"
        data-plan-state="stale"
        className="flex shrink-0 items-start gap-2 border-t border-(--el-border) bg-(--el-tint-yellow) px-4 py-2.5 text-xs leading-relaxed text-(--el-text-strong)"
        style={{ minHeight: PLAN_CONFIRM_BAR_HEIGHT }}
      >
        <RefreshCw className="mt-px size-3.5 flex-none" aria-hidden="true" />
        <span>{tReview('staleStatusOutcome')}</span>
      </div>
    );
  }
  const gated = view.kind !== 'ungated';
  const running = approveProgress?.state === 'running';
  const timedOutBand =
    approveProgress?.state === 'timedOut' ? (
      <PlanApproveProgress {...approveProgress} place="bar" />
    ) : null;
  // While the approve runs the bar's CONTENTS are the progress — no verb remains to
  // press twice — inside the element that was already there (§25.4, §25.7).
  const progressInBar = running ? <PlanApproveProgress {...approveProgress} place="bar" /> : null;

  const counts = (
    <span className="truncate text-sm font-semibold text-(--el-text)">
      {t('barCounts', {
        added: index.counts.added,
        changed: index.counts.changed,
        removed: index.counts.removed,
      })}
    </span>
  );

  if (!gated) {
    const bar = (
      <div
        data-testid="plan-change-confirm-bar"
        className="flex shrink-0 items-center gap-3 border-t border-(--el-border) bg-(--el-surface) px-4 py-2.5"
        style={{ minHeight: PLAN_CONFIRM_BAR_HEIGHT }}
      >
        {progressInBar ?? (
          <>
            <span className="flex min-w-0 flex-col">
              {counts}
              <span className="truncate text-xs text-(--el-text-secondary)">
                {t('barNothingSaved')}
              </span>
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {deciding ? <Spinner size="sm" aria-hidden="true" /> : null}
              <Button variant="ghost" size="sm" onClick={onDiscard} disabled={deciding}>
                {t('discard')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Check className="size-4" aria-hidden="true" />}
                onClick={onApprove}
                disabled={deciding}
              >
                {t('approveChanges')}
              </Button>
            </div>
          </>
        )}
      </div>
    );
    return timedOutBand ? (
      <div className="flex shrink-0 flex-col">
        {timedOutBand}
        {bar}
      </div>
    ) : (
      bar
    );
  }

  const held = view.kind === 'held';
  const heldLine =
    view.kind === 'held' && view.heldBy ? tp('heldBy', { harness: view.heldBy }) : tp('held');

  return (
    <div className="flex shrink-0 flex-col">
      {declining && onCancelDecline && onConfirmDecline ? (
        <PlanDeclineConfirm
          deciding={deciding}
          onCancel={onCancelDecline}
          onConfirm={onConfirmDecline}
        />
      ) : null}
      {staleRefused && !declining ? <PlanStaleBand place="bar" /> : null}
      {!declining ? timedOutBand : null}
      <div
        data-testid="plan-change-confirm-bar"
        className="flex shrink-0 items-center gap-3 border-t border-(--el-border) bg-(--el-surface) px-4 py-2.5"
        style={{ minHeight: PLAN_CONFIRM_BAR_HEIGHT }}
      >
        {progressInBar ?? (
          <>
            <span className="flex min-w-0 flex-col">
              {counts}
              {/* The consequence line — or, while a revision holds the plan, WHY the verbs
              are unavailable, which replaces it and is allowed to wrap. */}
              <span
                id="plan-change-bar-line"
                className={
                  held
                    ? 'text-xs text-(--el-text-secondary)'
                    : 'truncate text-xs text-(--el-text-secondary)'
                }
              >
                {held ? heldLine : tp('consequence')}
              </span>
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {view.kind === 'seeOnly' ? (
                // SEE BUT NOT DECIDE — no verbs at all, not disabled ones (Panel 7).
                <span
                  data-testid="plan-decide-see-only"
                  className="flex max-w-[20rem] items-start gap-1.5 text-xs text-(--el-text-secondary)"
                >
                  <Lock className="mt-px size-3.5 flex-none" aria-hidden="true" />
                  <SeeOnlyLine waitingOn={view.waitingOn} />
                </span>
              ) : declining ? null : (
                <>
                  {held ? (
                    <LoaderCircle
                      className="size-4 shrink-0 animate-spin text-(--el-text-secondary)"
                      aria-hidden="true"
                    />
                  ) : deciding ? (
                    <Spinner size="sm" aria-hidden="true" />
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onRequestDecline}
                    disabled={deciding || held}
                    aria-describedby={held ? 'plan-change-bar-line' : undefined}
                  >
                    {tp('decline')}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    leftIcon={<Check className="size-4" aria-hidden="true" />}
                    onClick={onApprove}
                    disabled={deciding || held}
                    aria-describedby={held ? 'plan-change-bar-line' : undefined}
                  >
                    {tp('approve')}
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** *Waiting on {name} to approve or decline this plan. Deciding a plan needs permission
 *  to decide plans.* — one line, shared by the bar and the rail's review block. */
export function SeeOnlyLine({ waitingOn }: { waitingOn: string | null }) {
  const tp = useTranslations('approvalGate.planApproval.surface');
  const ts = useTranslations('planningWorkspace.session');
  return (
    <span>
      {tp('seeOnly', { name: waitingOn ?? ts('someone') })} {tp('seeOnlyWhy')}
    </span>
  );
}

/**
 * REFUSED AS STALE (`APPROVAL_GATE_STALE_SUBJECT`; Panel 5) — a `role="alert"` band
 * directly above the verbs it refused, on the plan rail's own *changed under you* yellow
 * rather than danger: nothing failed, the plan moved. The canvas has already been re-read,
 * so the verbs beside it are live against the new version.
 */
export function PlanStaleBand({ place }: { place: 'bar' | 'rail' }) {
  const tp = useTranslations('approvalGate.planApproval.surface.stale');
  const body = (
    <>
      <RefreshCw className="mt-px size-3.5 flex-none" aria-hidden="true" />
      <span>
        <span className="font-semibold">{tp('title')}</span> {tp('next')}
      </span>
    </>
  );
  return place === 'bar' ? (
    <div
      role="alert"
      data-testid="plan-decide-stale"
      className="flex items-start gap-2 border-t border-(--el-border) bg-(--el-tint-yellow) px-4 py-2.5 text-xs leading-relaxed text-(--el-text-strong)"
    >
      {body}
    </div>
  ) : (
    <p
      role="alert"
      data-testid="plan-decide-stale"
      className="flex items-start gap-1.5 rounded-(--radius-control) bg-(--el-tint-yellow) px-(--spacing-control-x) py-(--spacing-control-y) text-xs leading-relaxed text-(--el-text-strong)"
    >
      {body}
    </p>
  );
}

'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Clock, History, Undo2 } from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import { Bubble } from '@/components/planning/PlanChangeRail';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import type { PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { QueuedTurn } from '@/lib/hooks/usePlanChangeConversation';

// Re-exported: the chip moved to its own module (bug MOTIR-9355).
export { ProposalRef } from '@/components/planning/ProposalRef';

// THE MID-RUN CONVERSATION, drawn (Story MOTIR-7990 · MOTIR-7998; design
// `design/ai-chat/plan-change-run-live--answer-or-forward.mock.html`, states 1–5
// and 10–12 — the pause, states 6–9, is the next work item's). These are the
// small pieces `PlanChangeRail` mounts, kept here so its functions stay short and
// so the pause rendering can reuse `ForwardedMarks` for a reply's queued / read
// marks.
//
// Every string is the CATALOGUE's (`planningWorkspace.conversation.midRun.*`):
// the acknowledgement, the offer and the refusal are never model words, so they
// speak the viewer's locale and a reloaded thread draws the same line.

const NS = 'planningWorkspace.conversation';

/** The queued / read word inside a forwarded user bubble — the shipped label. */
export function QueuedLabel({ read }: { read: boolean }) {
  const tc = useTranslations(NS);
  if (read) return <>{tc('queuedRead')}</>;
  return (
    <>
      <Clock className="size-3" aria-hidden="true" />
      {tc('queuedLabel')}
    </>
  );
}

/** An ordinary assistant bubble carrying a fixed catalogue sentence. */
function Ack({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <Bubble role="assistant" testId={testId}>
      <span>{children}</span>
    </Bubble>
  );
}

/** State 10's note: the take-back idiom, a `history` glyph, and a link to the plan. */
function RevisionNote({ planId }: { planId: string | null }) {
  const tm = useTranslations(`${NS}.midRun`);
  const routes = useReaderRoutes();
  return (
    <p
      data-testid="plan-change-revision"
      className="flex items-start gap-2 rounded-(--radius-control) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) py-(--spacing-control-y) text-xs leading-relaxed text-(--el-text-strong)"
    >
      <History className="mt-px size-3.5 flex-none" aria-hidden="true" />
      <span>
        {tm('revisedNote')}{' '}
        {planId ? (
          <Link
            href={routes.plan(planId)}
            data-testid="plan-change-revision-link"
            className="font-medium text-(--el-link) underline underline-offset-2 hover:text-(--el-link-pressed) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            {tm('revisedLink')}
          </Link>
        ) : null}
      </span>
    </p>
  );
}

/**
 * What sits UNDER a forwarded change (design states 4 and 10).
 *
 * `entry` is the mailbox entry the forward went down as — `queued` until the run
 * reads it, then `read`; null when this render has no entry for it (a reloaded
 * thread), which claims neither state. `acknowledge` is false for a reply the
 * pause renders (state 9b draws none). A late change (`revisedLate`) is a REVISION
 * of the plan instead, and its note links to the plan.
 */
export function ForwardedMarks({
  entry,
  acknowledge,
  revisedLate,
  lateRevision,
}: {
  entry: QueuedTurn | null;
  acknowledge: boolean;
  revisedLate?: PlanChangeTurnDto['revisedLate'];
  lateRevision?: { planId: string } | null;
}) {
  const tm = useTranslations(`${NS}.midRun`);
  if (revisedLate) {
    return (
      <>
        {acknowledge ? <Ack testId="plan-change-forwarded">{tm('revisedAck')}</Ack> : null}
        <RevisionNote planId={lateRevision?.planId ?? null} />
      </>
    );
  }
  return (
    <>
      {entry ? (
        <p
          className="text-center text-xs text-(--el-text-secondary)"
          data-testid={entry.read ? 'plan-change-forwarded-read' : 'plan-change-forwarded-queued'}
        >
          {entry.read ? tm('readMarker') : tm('queuedMarker')}
        </p>
      ) : null}
      {acknowledge ? <Ack testId="plan-change-forwarded">{tm('forwardedAck')}</Ack> : null}
    </>
  );
}

/**
 * State 5 — the ambiguous-turn offer, in the decision's chosen form: the person's
 * NEXT TURN confirms it, with no button. It goes stale once a later user turn was
 * not forwarded. Rendered INSIDE the answer's bubble, under its body.
 */
export function ForwardOffer({ stale }: { turn: PlanChangeTurnDto; stale: boolean }) {
  const tm = useTranslations(`${NS}.midRun`);
  return (
    <>
      <p className="mt-1.5 text-xs text-(--el-text)" data-testid="plan-change-forward-offer">
        {tm('forwardOffer')}
      </p>
      {stale ? (
        <p
          className="mt-1 text-xs text-(--el-text-secondary)"
          data-testid="plan-change-forward-stale"
        >
          {tm('forwardStale')}
        </p>
      ) : null}
    </>
  );
}

/** The refusal codes the late-change door and the mailbox name, each with a line. */
export type RefusalCode =
  | 'PLAN_CHANGE_JOB_NOT_RUNNING'
  | 'PLAN_CHANGE_PLAN_DECIDED'
  | 'PLAN_CHANGE_RUN_STOPPED'
  | 'PLAN_CHANGE_RUN_FAILED'
  | 'PLAN_REVISION_IN_FLIGHT'
  | 'PLAN_CHANGE_NO_PLAN';

const REFUSAL_KEY: Record<RefusalCode, string> = {
  PLAN_CHANGE_JOB_NOT_RUNNING: 'finished',
  PLAN_CHANGE_PLAN_DECIDED: 'decided',
  PLAN_CHANGE_RUN_STOPPED: 'stopped',
  PLAN_CHANGE_RUN_FAILED: 'failed',
  PLAN_REVISION_IN_FLIGHT: 'held',
  PLAN_CHANGE_NO_PLAN: 'noPlan',
};

/** The catalogue key for a refusal code; any other code gets the generic line. */
export function refusalKey(code: string): string {
  return Object.hasOwn(REFUSAL_KEY, code) ? REFUSAL_KEY[code as RefusalCode] : 'generic';
}

/**
 * State 11 — the run has ended, so the change was not forwarded. A yellow-tint
 * BAND in the pinned footer, directly above the composer, in `CarryDecidedNotice`'s
 * idiom: not an alert, not rose, no failure glyph — the person did nothing wrong.
 * `restored` says their words are back in the box; otherwise the band quotes them.
 */
export function ForwardRefusal({
  refusal,
  restored,
}: {
  refusal: { text: string; code: string };
  restored: boolean;
}) {
  const tm = useTranslations(`${NS}.midRun.refusal`);
  return (
    <p
      data-testid="plan-change-forward-refusal"
      data-code={refusal.code}
      className="mx-3 mt-3 flex items-start gap-1.5 rounded-(--radius-control) bg-(--el-tint-yellow) px-(--spacing-control-x) py-(--spacing-control-y) text-xs leading-relaxed text-(--el-text-strong)"
    >
      <Undo2 className="mt-px size-3.5 flex-none" aria-hidden="true" />
      <span>
        {tm(refusalKey(refusal.code))}{' '}
        {restored ? tm('tail') : tm('quoted', { text: refusal.text })}
      </span>
    </p>
  );
}

/** The passive line under an answer given on the side (design, all answers). */
export function AnsweredAside() {
  const tm = useTranslations(`${NS}.midRun`);
  return (
    <p
      className="text-center text-xs text-(--el-text-secondary)"
      data-testid="plan-change-answered-aside"
    >
      {tm('answeredAside')}
    </p>
  );
}

/**
 * State 1 — a mid-run question whose answer is still being written. The question
 * is an UNLABELLED user bubble (drawn here only when the thread does not already
 * hold it); the answer is a bubble with its own spinner and a passive line. The
 * act rail and the running bar are the planner's, and stay untouched.
 */
export function PendingAsk({
  text,
  inThread,
  ack = null,
}: {
  text: string;
  inThread: boolean;
  /** The question's quick reply (MOTIR-11797), once it arrives: model output, plain text,
   *  drawn in the answering bubble in place of its spinner. */
  ack?: string | null;
}) {
  const tm = useTranslations(`${NS}.midRun`);
  return (
    <>
      {inThread ? null : (
        <Bubble role="user" testId="plan-change-pending-ask">
          {text}
        </Bubble>
      )}
      <Bubble role="assistant" testId="plan-change-answering">
        {ack ?? <Spinner size="sm" aria-hidden="true" />}
      </Bubble>
      <p
        className="text-center text-xs text-(--el-text-secondary)"
        data-testid="plan-change-answering-marker"
      >
        {tm('answeringMarker')}
      </p>
    </>
  );
}

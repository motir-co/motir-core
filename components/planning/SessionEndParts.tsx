'use client';

import { useFormatter, useTranslations } from 'next-intl';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUp,
  Inbox,
  Lock,
  RefreshCw,
  Sparkles,
  Undo2,
  Users,
} from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { useOpenPlanningWorkspace } from '@/lib/hooks/useOpenPlanningWorkspace';
import { useOpenPlanOverlay } from '@/lib/hooks/useOpenPlanOverlay';
import type { PlanChangeSessionDto, PlanTargetHeldByDto } from '@/lib/dto/planChange';
import { carriesWaitingPlan } from '@/lib/planning/sessionCarry';
import { useRelativeTime } from '@/lib/hooks/useRelativeTime';

export { carriesWaitingPlan };

// THE SESSION'S END IN THE OVERLAY (Story MOTIR-7630 · MOTIR-7643), built to
// MOTIR-7633's `planning-workspace--session-end.mock.html`
// (`design/ai-planning/design-notes.md` § _The session END in the planning
// overlay_; AMENDMENT 23 §1–§6). Product-local parts the rail composes: the end
// marker, the copied divider, the take-back notice, the refusal block, and the two
// composer-slot faces an ended session gets. Each reads the SERVER's row — never a
// stream error — so a reload draws exactly the same thing.

type EndReason = NonNullable<PlanChangeSessionDto['endReason']>;

/** The end time, as the rail words a moment: relative, the full date-time in `title`. */
function useWhen() {
  const format = useFormatter();
  const relativeTime = useRelativeTime();
  return (iso: string) => ({
    label: relativeTime(new Date(iso)),
    title: format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }),
  });
}

/** The chip an end reads as: Closed for Motir's ending, Declined / Approved for a
 *  person's decision. "Declined" is never Motir's word (AMENDMENT 23 §1). */
function EndChip({ reason }: { reason: EndReason }) {
  const ts = useTranslations('planningWorkspace.session');
  switch (reason) {
    case 'failed':
    case 'idle':
    case 'restarted':
      return <Pill tone="neutral">{ts('end.closed')}</Pill>;
    case 'declined':
      return <Pill severity="danger">{ts('end.declined')}</Pill>;
    case 'approved':
      return <Pill severity="success">{ts('end.approved')}</Pill>;
  }
}

/** THE END MARKER — the thread's last row on every ended session: the chip and
 *  its reason between two hairlines, one shape whatever the reason. */
export function SessionEndMarker({ session }: { session: PlanChangeSessionDto }) {
  const ts = useTranslations('planningWorkspace.session');
  const when = useWhen();
  if (!session.endedAt || !session.endReason) return null;
  const at = when(session.endedAt);
  const reason = session.endReason;
  const text =
    reason === 'failed' || reason === 'idle' || reason === 'restarted'
      ? ts(`end.reason.${reason}`, { when: at.label })
      : session.endedBy
        ? ts('end.by', { name: session.endedBy.name, when: at.label })
        : at.label;
  return (
    <div
      role="note"
      data-testid="planning-session-end"
      data-end-reason={reason}
      className="flex items-center gap-2"
    >
      <span className="h-px flex-1 bg-(--el-border)" aria-hidden />
      <span className="flex flex-wrap items-center justify-center gap-1.5">
        <EndChip reason={reason} />
        <span className="text-xs text-(--el-text-secondary)" title={at.title}>
          {text}
        </span>
      </span>
      <span className="h-px flex-1 bg-(--el-border)" aria-hidden />
    </div>
  );
}

/** How many of a copied session's turns came from the session it copied: they
 *  keep their own `createdAt`, so they are the turns written before the session
 *  itself was (AMENDMENT 23 §6). Zero on a session that is no copy. */
export function copiedTurnCount(session: PlanChangeSessionDto | null): number {
  if (!session?.copiedFromSessionId) return 0;
  const born = new Date(session.createdAt).getTime();
  return session.turns.filter((turn) => new Date(turn.createdAt).getTime() < born).length;
}

/** THE COPIED DIVIDER — under the copied turns: where they came from, and a link
 *  that reopens that ended session by id, read-only, in the same overlay. */
export function CopiedDivider({
  fromSessionId,
  anchorKey,
}: {
  fromSessionId: string;
  anchorKey: string | null;
}) {
  const ts = useTranslations('planningWorkspace.session');
  const { href, open } = useOpenPlanningWorkspace(
    anchorKey
      ? { kind: 'work-item', itemKey: anchorKey, sessionId: fromSessionId }
      : { kind: 'project', sessionId: fromSessionId },
  );
  return (
    <div role="note" data-testid="planning-copied-divider" className="flex items-center gap-2">
      <span className="h-px flex-1 bg-(--el-border)" aria-hidden />
      <span className="flex items-center gap-1.5 text-xs text-(--el-text-secondary)">
        <ArrowUp aria-hidden className="size-3.5" />
        <span>{ts('copiedFrom')}</span>
        <span aria-hidden>·</span>
        <a
          href={href}
          onClick={open}
          className="rounded-(--radius-control) font-semibold text-(--el-link) underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          {ts('copiedFromOpen')}
        </a>
      </span>
      <span className="h-px flex-1 bg-(--el-border)" aria-hidden />
    </div>
  );
}

/** THE EARLIER-SESSION LINE — the overlay just swapped to a new session after
 *  Plan something new (MOTIR-7650; `planning-workspace--plan-something-new.mock.html`
 *  panel 4). The copied divider's idiom, pointing BACK: **Open it** reopens the
 *  ended session read-only by id, in the same overlay. */
export function RestartedDivider({
  fromSessionId,
  anchorKey,
}: {
  fromSessionId: string;
  anchorKey: string | null;
}) {
  const tr = useTranslations('planningWorkspace.restart');
  const { href, open } = useOpenPlanningWorkspace(
    anchorKey
      ? { kind: 'work-item', itemKey: anchorKey, sessionId: fromSessionId }
      : { kind: 'project', sessionId: fromSessionId },
  );
  return (
    <div role="note" data-testid="planning-restart-earlier" className="flex items-center gap-2">
      <span className="h-px flex-1 bg-(--el-border)" aria-hidden />
      <span className="flex items-center gap-1.5 text-xs text-(--el-text-secondary)">
        <ArrowLeft aria-hidden className="size-3.5" />
        <span>{tr('earlier')}</span>
        <span aria-hidden>·</span>
        <a
          href={href}
          onClick={open}
          className="rounded-(--radius-control) font-semibold text-(--el-link) underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          {tr('earlierOpen')}
        </a>
      </span>
      <span className="h-px flex-1 bg-(--el-border)" aria-hidden />
    </div>
  );
}

/** THE TAKE-BACK NOTICE — the resume returned the person's own OPEN session that
 *  holds this card (AMENDMENT 23 §3). The reopened line's idiom. */
export function TakenBackNotice({
  label,
  projectName,
}: {
  label: string | null;
  projectName: string;
}) {
  const ts = useTranslations('planningWorkspace.session');
  return (
    <p
      data-testid="planning-taken-back"
      className="flex items-start gap-2 rounded-(--radius-control) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) py-(--spacing-control-y) text-xs leading-relaxed text-(--el-text-strong)"
    >
      <Undo2 className="mt-px size-3.5 flex-none" aria-hidden />
      <span>
        {label ? ts('takenBack', { label }) : ts('takenBackProject', { project: projectName })}
      </span>
    </p>
  );
}

/** THE REFUSAL — another person's session or plan holds the card (AMENDMENT 23
 *  §4). A STATUS, not an alert: nothing failed, so it names a person and a time
 *  instead of apologising. The link is drawn only with a session to open. */
export function TargetRefusal({ held }: { held: PlanTargetHeldByDto }) {
  const ts = useTranslations('planningWorkspace.session');
  const format = useFormatter();
  const key = held.target;
  const byPlan = held.freesBy === null;
  const title = byPlan
    ? held.holder
      ? ts('refused.planTitle', { name: held.holder, key })
      : ts('refused.someonePlanTitle', { key })
    : held.holder
      ? ts('refused.sessionTitle', { name: held.holder, key })
      : ts('refused.someoneTitle', { key });
  // A session that WAITS (on its person, or to be resumed) holds the card until its owner comes
  // back, so a free-by time would promise something untrue: the body names who it waits on
  // instead (Story MOTIR-7905 · MOTIR-7918; design panel 7). The title is unchanged.
  const waiting = held.sessionWaiting === true && !byPlan;
  const tr = useTranslations('planningWorkspace.session.refusal');
  const body = waiting
    ? null
    : byPlan
      ? ts('refused.planBody')
      : ts('refused.sessionBody', {
          time: format.dateTime(new Date(held.freesBy!), { hour: '2-digit', minute: '2-digit' }),
        });
  return (
    <div
      role="status"
      data-testid="planning-target-refused"
      className="flex items-start gap-2.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8)"
    >
      <Users className="mt-0.5 size-4 flex-none text-(--el-text-secondary)" aria-hidden />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-semibold text-(--el-text-strong)">{title}</p>
        {waiting ? (
          <>
            <p className="text-xs font-medium text-(--el-text)" data-testid="planning-waiting-on">
              {held.holder ? tr('waitingOn', { name: held.holder }) : tr('waitingOnSomeone')}
            </p>
            {held.waitingCause ? (
              <p className="text-xs leading-relaxed text-(--el-text-secondary)">
                {tr(`why.${held.waitingCause}`)}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-xs leading-relaxed text-(--el-text-secondary)">{body}</p>
        )}
        {held.holderSessionId && held.holder ? (
          <RefusalLink
            sessionId={held.holderSessionId}
            name={held.holder}
            anchorKey={key}
            waiting={waiting}
          />
        ) : null}
      </div>
    </div>
  );
}

function RefusalLink({
  sessionId,
  name,
  anchorKey,
  waiting,
}: {
  sessionId: string;
  name: string;
  anchorKey: string;
  waiting: boolean;
}) {
  const ts = useTranslations('planningWorkspace.session');
  const tr = useTranslations('planningWorkspace.session.refusal');
  const { href, open } = useOpenPlanningWorkspace({
    kind: 'work-item',
    itemKey: anchorKey,
    sessionId,
  });
  return (
    <a
      href={href}
      onClick={open}
      className="self-start rounded-(--radius-control) text-xs font-semibold text-(--el-link) underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    >
      {waiting ? tr('openSession') : ts('refused.link', { name })}
    </a>
  );
}

/** Whether an ended session OFFERS the copy: a `failed` or `idle` end, to its
 *  starter only, who may plan (AMENDMENT 23 §6). A decided session never does, and
 *  nor does one whose plan still waits — its composer CARRIES the plan instead
 *  (MOTIR-7932; design state 2), so no face shows both. */
export function offersCopy(session: PlanChangeSessionDto, readOnly: boolean): boolean {
  return (
    !readOnly &&
    session.startedByViewer !== false &&
    (session.endReason === 'failed' || session.endReason === 'idle') &&
    !carriesWaitingPlan(session, readOnly)
  );
}

// ── THE CARRY (Story MOTIR-7928 · MOTIR-7932), built to MOTIR-7929's
// `planning-workspace--waiting-plan-carry.mock.html`. Each line is the reopened
// line's idiom (`planning-reopened-session`) with its own glyph.

const NOTICE_LINE =
  'flex items-start gap-2 rounded-(--radius-control) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) py-(--spacing-control-y) text-xs leading-relaxed text-(--el-text-strong)';
const NOTICE_LINK =
  'rounded-(--radius-control) font-semibold text-(--el-link) underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

/** The one line above the live composer of an ended session whose plan waits
 *  (design states 1 and 2): the next message carries this plan and conversation. */
export function WaitingPlanComposerGloss() {
  const ts = useTranslations('planningWorkspace.session');
  return (
    <p
      data-testid="planning-carry-gloss"
      className="px-3 pt-3 text-xs leading-relaxed text-(--el-text-secondary)"
    >
      {ts('carry.gloss')}
    </p>
  );
}

/** Under the copied divider of the session a carry made (design state 4): the
 *  plan on the canvas is the same plan, moved here with the conversation. */
export function PlanMovedLine() {
  const ts = useTranslations('planningWorkspace.session');
  return (
    <p data-testid="planning-plan-moved" className={NOTICE_LINE}>
      <ArrowDownToLine className="mt-px size-3.5 flex-none" aria-hidden />
      <span>{ts('carry.moved')}</span>
    </p>
  );
}

/** Under the end marker of the session a carry LEFT (design state 4, right): its
 *  plan moved to a newer session, which the link reopens in the same overlay. */
export function PlanMovedAwayLine({
  toSessionId,
  anchorKey,
}: {
  toSessionId: string;
  anchorKey: string | null;
}) {
  const ts = useTranslations('planningWorkspace.session');
  const { href, open } = useOpenPlanningWorkspace(
    anchorKey
      ? { kind: 'work-item', itemKey: anchorKey, sessionId: toSessionId }
      : { kind: 'project', sessionId: toSessionId },
  );
  return (
    <p data-testid="planning-plan-moved-away" className={NOTICE_LINE}>
      <ArrowDownToLine className="mt-px size-3.5 flex-none" aria-hidden />
      <span>
        {ts('carry.movedAway')}{' '}
        <a href={href} onClick={open} className={NOTICE_LINK}>
          {ts('carry.movedAwayOpen')}
        </a>
      </span>
    </p>
  );
}

/** Beside the take-back notice when a CARRY was taken back (design state 5): the
 *  plan the person opened still waits, and the link leads back to it through the
 *  plan-overlay door (MOTIR-7884), which owns the address. */
export function WaitingPlanStillWaits({
  planId,
  label,
  projectName,
}: {
  planId: string;
  label: string | null;
  projectName: string;
}) {
  const ts = useTranslations('planningWorkspace.session');
  const { href, open } = useOpenPlanOverlay(planId);
  return (
    <p data-testid="planning-taken-back-waiting" className={NOTICE_LINE}>
      <Inbox className="mt-px size-3.5 flex-none" aria-hidden />
      <span>
        {ts('carry.takenBackWaiting', { label: label ?? projectName })}{' '}
        <a href={href} onClick={open} className={NOTICE_LINK}>
          {ts('carry.takenBackWaitingOpen')}
        </a>
      </span>
    </p>
  );
}

/** The carry REFUSED because the plan was decided while the person wrote (design
 *  state 6): the stale-read band's idiom, then the words that were not sent, kept
 *  read-only so they can be copied. */
export function CarryDecidedNotice({ text }: { text: string }) {
  const ts = useTranslations('planningWorkspace.session');
  return (
    <>
      <p
        role="alert"
        data-testid="planning-carry-decided"
        className="flex items-start gap-1.5 rounded-(--radius-control) bg-(--el-tint-yellow) px-(--spacing-control-x) py-(--spacing-control-y) text-xs leading-relaxed text-(--el-text-strong)"
      >
        <RefreshCw className="mt-px size-3.5 flex-none" aria-hidden />
        <span>
          <span className="font-semibold">{ts('carry.decided.title')}</span>{' '}
          {ts('carry.decided.next')}
        </span>
      </p>
      <div
        data-testid="planning-carry-unsent"
        className="flex flex-col gap-1 rounded-(--radius-card) bg-(--el-surface-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8)"
      >
        <span className="font-mono text-[10px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
          {ts('carry.decided.unsent')}
        </span>
        <p className="text-sm whitespace-pre-wrap text-(--el-text)">{text}</p>
      </div>
    </>
  );
}

/** The composer slot of an ENDED session: **Start a new session** where the copy
 *  is offered, otherwise the read-only line that says it has ended. */
export function EndedComposerSlot({
  session,
  readOnly,
  label,
  projectName,
  onStartNew,
  pending = false,
  carryDecided = false,
}: {
  session: PlanChangeSessionDto;
  readOnly: boolean;
  /** The scope's label (its first key), or null for the project. */
  label: string | null;
  projectName: string;
  onStartNew?: () => void;
  pending?: boolean;
  /** The carry was refused because the plan was decided first (design state 6). */
  carryDecided?: boolean;
}) {
  const ts = useTranslations('planningWorkspace.session');
  // ANOTHER MEMBER on an ended session whose plan still waits (design state 7): it
  // is the starter's to continue, and the line says whose.
  const notYours =
    !readOnly &&
    session.startedByViewer === false &&
    session.origin === 'conversation' &&
    Boolean(session.pendingPlanId);
  if (offersCopy(session, readOnly) && onStartNew && !carryDecided) {
    return (
      <div
        className="flex flex-col items-start gap-2 border-t border-(--el-border) px-3 py-3"
        data-testid="planning-session-ended"
      >
        <p className="text-xs leading-relaxed text-(--el-text-secondary)">
          {ts('newSession.gloss')}
        </p>
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Sparkles className="size-4" aria-hidden="true" />}
          onClick={onStartNew}
          disabled={pending}
        >
          {ts('newSession.start')}
        </Button>
      </div>
    );
  }
  return (
    <div className="border-t border-(--el-border) px-3 py-3" data-testid="planning-read-only">
      <p className="flex items-start gap-2 text-xs leading-relaxed text-(--el-text-secondary)">
        <Lock className="mt-px size-3.5 flex-none" aria-hidden />
        <span>
          {readOnly
            ? ts('readOnly')
            : carryDecided
              ? ts('carry.decided.slot')
              : notYours
                ? ts('carry.notYours', { name: session.startedBy?.name ?? ts('someone') })
                : label
                  ? ts('ended', { label })
                  : ts('endedProject', { project: projectName })}
        </span>
      </p>
    </div>
  );
}

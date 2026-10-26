'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { Hourglass, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { Spinner } from '@/components/ui/Spinner';
import { providerLimitView } from '@/lib/planChange/providerLimitView';
import { PlanOverlayDoor } from '@/components/planning/PlanOverlayDoor';
import type { PlanChangeSessionDto, PlanSessionFailureDto } from '@/lib/dto/planChange';
import {
  refusalEndsWaiting,
  resumeReasonKeyOf,
  resumeRefusalKeyOf,
  stopPhraseKeyOf,
} from '@/app/(authed)/workbench/_components/planningSessionWords';

// A SESSION THAT WAITS, IN THE OVERLAY (Story MOTIR-7905 · MOTIR-7918; design
// `design/ai-chat/design-notes.md` § _The overlay waits with you_, mock
// `planning-workspace--waiting-on-you.mock.html` panels 3–5). Product-local parts the rail
// composes, beside `SessionEndParts.tsx`, which draws the sessions that ENDED.
//
// ⚠️ A FAILED HOSTED ATTEMPT NO LONGER ENDS ITS SESSION. It keeps its plans and cards and waits to
// be resumed, so this is not the *Closed* state: no end marker, no *Start a new session*, no
// Try again. The words are the To resume entry's (`workbench.planningSession.*`) — the stop in
// the progress line's step words, the stable reason code translated, never motir-ai's English.
//
// Every part reads the SERVER's row (`session.failure`), never a stream error, so a reload or a
// second tab draws exactly the same thing.

/**
 * THE FAILURE BLOCK of a session waiting to resume: where the walk stopped, why, when — and
 * **Resume** in place of Try again. The plan so far stays on the canvas through the live poll;
 * the sentence says so. Failed *again* carries a quiet *Second attempt* note.
 *
 * `canResume` false is the read-only face for a member who neither started the session nor
 * manages the project (panel 3c): no Resume, and the sentence names who can.
 *
 * A `rate_limited` failure is worded as the provider limit (MOTIR-9622; design
 * `planning-workspace--provider-limit.mock.html` panels 6 / 8b): the *because* segment and the
 * kept sentence change, nothing else. Once Resume is pressed (panel 7) the shipped resuming face
 * is drawn as it is for every reason.
 */
export function FailedWaitingNotice({
  failure,
  failedAgain,
  resuming,
  resumeError,
  canResume,
  starterName,
  onResume,
}: {
  failure: PlanSessionFailureDto;
  failedAgain: boolean;
  resuming: boolean;
  resumeError: string | null;
  canResume: boolean;
  starterName: string | null;
  onResume: () => void;
}) {
  const t = useTranslations('workbench.planningSession');
  const tw = useTranslations('planningWorkspace.waiting');
  const tl = useTranslations('planningWorkspace.providerLimit');
  const format = useFormatter();
  const stop = stopPhraseKeyOf(failure);
  const providerLimit = providerLimitView(failure, null) === 'stopped' && !resuming;
  const refusal = resumeError === null ? null : resumeRefusalKeyOf(resumeError);
  const showRefusal = refusal !== null && refusal !== 'alreadyStarted';
  const sessionGone = refusal !== null && refusalEndsWaiting(refusal);
  return (
    <section
      aria-label={tw('failedHead')}
      data-testid="planning-failed-waiting"
      data-state={resuming ? 'resuming' : failedAgain ? 'failed-again' : 'waiting'}
      className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8)"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Hourglass className="size-4 flex-none text-(--el-icon-muted)" aria-hidden />
        <p className="text-sm font-semibold text-(--el-text-strong)">{tw('failedHead')}</p>
        {failedAgain && !resuming ? <Pill tone="neutral">{t('second')}</Pill> : null}
        <Pill tone="awaiting">{resuming ? t('resuming') : t('waitingToResume')}</Pill>
      </div>
      <p className="text-xs leading-relaxed text-(--el-text-secondary)">
        <span>{t('stoppedAt')} </span>
        <span className="font-medium text-(--el-text)">
          {t(`stop.${stop}`, { title: failure.stopTitle ?? '' })}
        </span>
        <span aria-hidden> · </span>
        <span data-testid={providerLimit ? 'provider-limit-because' : undefined}>
          {providerLimit
            ? tl('walkBecause')
            : t('because', { reason: t(`reason.${resumeReasonKeyOf(failure.reason)}`) })}
        </span>
        <span aria-hidden> · </span>
        <span
          title={format.dateTime(new Date(failure.failedAt), {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        >
          {t('failedAt', { when: format.relativeTime(new Date(failure.failedAt)) })}
        </span>
      </p>
      <p
        data-testid={providerLimit ? 'provider-limit-kept' : undefined}
        className="text-xs leading-relaxed text-(--el-text-secondary)"
      >
        {providerLimit ? tl('walkKept') : tw('kept')}
      </p>
      {showRefusal ? (
        <p role="alert" className="text-xs text-(--el-text)">
          <span className="font-medium">{t('couldNot')}</span> {t(`refusal.${refusal}`)}
        </p>
      ) : null}
      {canResume ? (
        !sessionGone ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={resuming}
              onClick={onResume}
              data-testid="planning-resume"
            >
              {resuming ? t('resuming') : t('resume')}
            </Button>
            <span className="text-xs text-(--el-text-secondary)">{tw('holdReason')}</span>
          </div>
        ) : null
      ) : (
        <p data-testid="planning-resume-not-yours" className="text-xs text-(--el-text-secondary)">
          {starterName ? tw('onlyStarter', { name: starterName }) : tw('onlyStarterAnon')}
        </p>
      )}
    </section>
  );
}

/**
 * THE ONE CURRENT FAILURE LINE of an OPEN session whose plan WAITS (situation 2; Story
 * MOTIR-7905 · MOTIR-7941; design `planning-workspace--failed-with-waiting-plan.mock.html`
 * panels 5a / 5e / 8a): *Your last change to this plan could not be made · {when}*, in the
 * warning role MOTIR-7633 kept (no danger ink). No Resume, no Try again, no Closed marker — the
 * session is OPEN and the next turn continues it.
 *
 * Only the CURRENT failure is drawn: the session stores one failure record, a later turn clears
 * it and a newer failure overwrites it, so an earlier one is never redrawn after a reload.
 *
 * A `rate_limited` failure says the provider was at its limit, in each of the four forms
 * (MOTIR-9622; design `planning-workspace--provider-limit.mock.html` panels 9 / 10).
 */
export function WaitingPlanFailureLine({
  failure,
  again,
  planAgain = false,
}: {
  failure: PlanSessionFailureDto;
  again: boolean;
  /**
   * The attempt cannot be resumed and no plan waits beside it (MOTIR-9121): its cards were
   * given back, and the person's next message plans again — the same line, saying THAT
   * instead of naming a plan that is not there.
   */
  planAgain?: boolean;
}) {
  const tw = useTranslations('planningWorkspace.waiting');
  const tl = useTranslations('planningWorkspace.providerLimit');
  const format = useFormatter();
  const when = format.relativeTime(new Date(failure.failedAt));
  const providerLimit = providerLimitView(failure, null) === 'stopped';
  const key = planAgain
    ? again
      ? 'failureLinePlanAgainAgain'
      : 'failureLinePlanAgain'
    : again
      ? 'failureLineAgain'
      : 'failureLine';
  const text = providerLimit ? tl(key, { when }) : tw(key, { when });
  return (
    <p
      role="status"
      data-testid="planning-failure-line"
      data-again={again ? 'true' : undefined}
      data-provider-limit={providerLimit ? 'true' : undefined}
      className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-rose) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) text-sm text-(--el-text-strong)"
    >
      <TriangleAlert className="mt-0.5 size-4 flex-none text-(--el-icon-muted)" aria-hidden />
      <span>{text}</span>
    </p>
  );
}

/**
 * A plan that WAITS beside a failed walk (design panel 6): the walk is what Resume continues, and
 * the plan that was already waiting for approval stays reachable — a door to it through the one
 * plan-overlay door, never an address built here.
 */
export function AlsoWaitingPlan({ session }: { session: PlanChangeSessionDto }) {
  const t = useTranslations('workbench.planningSession.form.walk');
  const plan = session.waitingPlan;
  if (!plan) return null;
  return (
    <p className="text-xs text-(--el-text-secondary)" data-testid="planning-also-waiting">
      {t('alsoWaiting')}{' '}
      <PlanOverlayDoor
        planId={plan.planId}
        known={{
          planStatus: plan.status,
          sessionId: session.id,
          anchorKey: session.targetKeys[0] ?? null,
        }}
        className="font-medium text-(--el-link) hover:underline focus-visible:underline focus-visible:outline-none"
      >
        {plan.title ?? '…'}
      </PlanOverlayDoor>
    </p>
  );
}

/**
 * THE PROVIDER-LIMIT RETRYING BANNER (Story MOTIR-9540 · MOTIR-9622; design
 * `planning-workspace--provider-limit.mock.html` panels 2–5): the planner is waiting to retry a
 * provider 429 by itself. Info tone — nothing failed and the person has nothing to do — so no
 * action, no dismiss, no countdown and no attempt number. A polite `role="status"`, labelled by
 * its title, never an alert. The rail draws it between its head and the log, outside the scroll.
 */
export function ProviderLimitRetryingBanner() {
  const tl = useTranslations('planningWorkspace.providerLimit');
  return (
    <div
      role="status"
      aria-labelledby="provider-limit-retrying-title"
      data-testid="provider-limit-retrying"
      className="mx-4 mt-3 flex flex-none items-start gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-notice-info-bg) px-(--spacing-control-x) py-(--spacing-control-y) text-(--el-text-strong)"
    >
      <Spinner size="sm" aria-hidden="true" className="mt-0.5 flex-none text-(--el-text-strong)" />
      <div className="min-w-0">
        <p id="provider-limit-retrying-title" className="text-sm font-semibold">
          {tl('retryingTitle')}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed">{tl('retryingBody')}</p>
      </div>
    </div>
  );
}

'use client';

import { useTranslations } from 'next-intl';
import { Pause, RefreshCw, Square } from 'lucide-react';

import { AiPaywall } from '@/components/ai/AiPaywall';
import { Button } from '@/components/ui/Button';
import { SharpenThread } from '@/components/planning/SharpenThread';
import type { SharpenAction } from '@/lib/ai/types';
import type { SharpenSessionDto } from '@/lib/dto/sharpen';
import type { GrillError, OfferHold } from '@/components/planning/useGrillSession';

// GRILL ME BEFORE PLANNING, under the answer whose plan offer it holds (Story
// MOTIR-9221 · Subtask MOTIR-9316; design `design/ai-chat/grill-before-planning.mock.html`).
//
// The answer turn is drawn whole without its offer panel; this draws what follows
// it: the grilling thread (or, before its session exists, the opening marker and
// the reading line), then either the Held offer notice — no Confirm, no Decline
// anywhere while the grilling is open — or, once it ended, the offer itself, which
// the rail builds with the settled list. The offer is revealed where the person is
// reading, under the thread's closing marker.

export interface ConversationGrillProps {
  /** The session grilling this offer, or null before it has opened. */
  session: SharpenSessionDto | null;
  hold: Exclude<OfferHold, null>;
  pending: boolean;
  error: GrillError;
  endedBySwitch: boolean;
  /** The pending-question anchor, when the conversation is not waiting on one. */
  anchorId?: string;
  /** The plan offer to show once the grilling ended. */
  offer: React.ReactNode;
  onAct: (action: Exclude<SharpenAction, 'start' | 'stop'>, opts?: { readingId?: string }) => void;
  onStop: () => void;
  onSomethingElse: () => void;
  onRetry: () => void;
}

/** The Held offer notice — one quiet status line under the thread. */
function HeldOfferNotice() {
  const t = useTranslations('planningWorkspace.planOffer');
  return (
    <p
      role="status"
      data-testid="plan-offer-held"
      className="flex items-start gap-1.5 pl-9 text-xs text-(--el-text-secondary)"
    >
      <Pause className="mt-0.5 size-3.5 flex-none" aria-hidden />
      <span>{t('held')}</span>
    </p>
  );
}

/** Before the session exists: the opening, and the open's own wait or failure. */
function Opening({
  pending,
  error,
  onStop,
  onRetry,
}: Pick<ConversationGrillProps, 'pending' | 'error' | 'onStop' | 'onRetry'>) {
  const t = useTranslations('sharpen');
  const tc = useTranslations('planningWorkspace.conversation');
  const stop = (
    <Button
      variant="ghost"
      size="sm"
      data-testid="sharpen-stop"
      leftIcon={<Square className="size-4" aria-hidden />}
      onClick={onStop}
    >
      {t('question.stop')}
    </Button>
  );
  return (
    <div className="flex flex-col gap-3" data-testid="sharpen-thread">
      <p
        className="flex items-center gap-1.5 pl-9 text-xs text-(--el-text-secondary)"
        data-testid="sharpen-opening"
      >
        {t('markers.opening')}
      </p>
      {error === 'outOfCredits' ? (
        <div className="flex flex-col items-start gap-2 pl-9" data-testid="sharpen-out-of-credits">
          <AiPaywall triggeredOutOfCredits />
          {stop}
        </div>
      ) : error ? (
        <div className="flex flex-col items-start gap-2 pl-9" data-testid="sharpen-error">
          <p
            role="alert"
            className="rounded-(--radius-card) bg-(--el-tint-rose) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) text-sm text-(--el-text-strong)"
          >
            {t('error')}
          </p>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<RefreshCw className="size-4" aria-hidden />}
            onClick={onRetry}
            disabled={pending}
          >
            {t('retry')}
          </Button>
          {stop}
        </div>
      ) : (
        <p
          aria-live="polite"
          className="pl-9 text-xs text-(--el-text-secondary)"
          data-testid="sharpen-reading"
        >
          {tc('progress.reading')}
        </p>
      )}
    </div>
  );
}

export function ConversationGrill({
  session,
  hold,
  pending,
  error,
  endedBySwitch,
  anchorId,
  offer,
  onAct,
  onStop,
  onSomethingElse,
  onRetry,
}: ConversationGrillProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="conversation-grill" data-hold={hold}>
      {session ? (
        <SharpenThread
          session={session}
          pending={pending}
          error={error}
          endedBySwitch={endedBySwitch}
          {...(anchorId ? { anchorId } : {})}
          onAct={onAct}
          onStop={onStop}
          onSomethingElse={onSomethingElse}
          onRetry={onRetry}
        />
      ) : hold === 'held' ? (
        <Opening pending={pending} error={error} onStop={onStop} onRetry={onRetry} />
      ) : null}
      {hold === 'held' ? <HeldOfferNotice /> : <div className="pl-9">{offer}</div>}
    </div>
  );
}

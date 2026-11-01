'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { usePathname, useSearchParams } from 'next/navigation';
import { OverlayExitButton } from '@/components/ui/OverlayExitButton';
import { PlanningWorkspace } from '@/components/planning/PlanningWorkspace';
import { GuideTodoCanvas } from '@/components/planning/GuideTodoCanvas';
import { GuideRail } from '@/components/planning/GuideRail';
import { useGuideConversation, type GuideTodoAccess } from '@/lib/hooks/useGuideConversation';
import { deriveGuideView } from '@/lib/planning/guideView';
import { withPlanningOverlay } from '@/lib/planning/launcher';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { useAiAccess } from '@/lib/hooks/useAiAccess';
import { useProjectAccess } from '@/app/(authed)/_components/ProjectAccessProvider';
import type { PlanningTarget } from '@/lib/planning/planningTargets';
import { useRequestWorkbenchReread } from '@/lib/workbench/workbenchReread';
import { listTodosAction, setTodoDoneAction } from '@/app/(authed)/items/[key]/todoActions';

// THE GUIDE MODE's host (Story MOTIR-7459 · MOTIR-7466) — the room the Guide me
// through door opens, on the overlay's shipped frame (`PlanningWorkspace`, the
// resizable split; design MOTIR-7462 § What it composes, unchanged). The canvas
// pane is the guided card's to-do list (`GuideTodoCanvas`), the chat pane is the
// guide conversation (`GuideRail`), and both draw ONE derived view
// (`deriveGuideView`), so they cannot disagree about the list or the step.
//
// PAGE STATE AFTER A MUTATION (`motir-core/CLAUDE.md`): a landed turn writes the
// card through its services. The canvas is a client island and re-reads its rows
// itself (the hook does, after every settle). The page underneath is re-read when
// the guide CLOSES, and not from here (Story MOTIR-8539 · MOTIR-8576): closing is
// the reader's own act, so `PlanningWorkspaceOverlay` — which owns every close
// vector — re-reads the card's page once. This host only asks the Workbench,
// should it be what is underneath, to re-read its own window.

const TODOS: GuideTodoAccess = { list: listTodosAction, setDone: setTodoDoneAction };

export interface GuideWorkspaceHostProps {
  projectName: string;
  /** The guided card, as the overlay's anchor read resolved it. */
  card: PlanningTarget;
  onClose: () => void;
}

export function GuideWorkspaceHost({ projectName, card, onClose }: GuideWorkspaceHostProps) {
  const t = useTranslations('planningWorkspace');
  const tg = useTranslations('planningWorkspace.guide');
  const requestWorkbenchReread = useRequestWorkbenchReread();
  const { can } = useProjectAccess();
  const { blocked: outOfCreditsNow } = useAiAccess();
  const [offerBlocked, setOfferBlocked] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { state, send, retry, reloadRows, setRowDone, declineOffer } = useGuideConversation({
    itemKey: card.identifier,
    workItemId: card.id,
    todos: TODOS,
  });

  const canvasRefs = useMemo(
    () => ({ ...(state.session?.workItemRefs ?? {}), ...state.rowRefs }),
    [state.session?.workItemRefs, state.rowRefs],
  );
  const view = useMemo(
    () => deriveGuideView(state.session?.turns ?? [], state.rows, { idle: state.phase === 'idle' }),
    [state.session, state.rows, state.phase],
  );
  const title = view.editedTitle ?? card.title;

  // CONFIRM, and a confirmed offer's link, open the planner FROM THE OFFER (MOTIR-8694):
  // the overlay's address is rewritten to `plan=contextual&planFrom=guide-offer&planOffer=
  // <turnId>` and the overlay's seed read does the rest (MOTIR-8693). A push, so Back
  // returns to the stopped guide; nothing is sent from here and no text is in the URL.
  const openOffer = (turnId: string): boolean => {
    // OUT OF CREDITS: Confirm spends credits, so the shipped paywall answers in the
    // rail's own slot and nothing opens (the offer stays undecided).
    if (outOfCreditsNow) {
      setOfferBlocked(true);
      return false;
    }
    const qs = searchParams.toString();
    shallowPush(
      withPlanningOverlay(`${pathname}${qs ? `?${qs}` : ''}`, {
        kind: 'guide-offer',
        guideTurnId: turnId,
      }),
    );
    return true;
  };

  // When the guide goes away — by Close, Esc, the scrim or Back alike — a
  // Workbench underneath re-reads its window in place. The card's own page is the
  // overlay's to re-read (see the header).
  useEffect(() => () => requestWorkbenchReread(), [requestWorkbenchReread]);

  return (
    <PlanningWorkspace
      className="h-full w-full"
      resizable
      proposalPresent={false}
      canvas={
        // ⚠️ `min-w-0` IS LOAD-BEARING (MOTIR-8232). This div is the frame's grid item, and a
        // grid item's automatic minimum width is its min-content — which includes the crumb's
        // non-wrapping title. A long card title stretched the `1fr` track past its share and
        // pushed the chat column off the right edge (and the divider with it).
        <div className="flex h-full min-h-0 min-w-0 flex-col bg-(--el-canvas)">
          <div className="flex items-center gap-3 border-b border-(--el-border-soft) bg-(--el-surface) px-4 py-2">
            <OverlayExitButton onClose={onClose} label={t('close')} escLabel={t('escKey')} />
            {/* THE CRUMB NAMES THE CARD (design § What guide mode changes, 2):
                project / KEY title, the key in the identifier ink, the title
                truncating — and the title the walk last set, marked until the
                next turn when it changed this turn (panel 7). */}
            <span className="flex min-w-0 items-baseline gap-1.5 text-sm" data-testid="guide-crumb">
              <span className="shrink-0 font-semibold text-(--el-text)">{projectName}</span>
              <span className="shrink-0 text-(--el-text-secondary)" aria-hidden>
                /
              </span>
              <span className="shrink-0 font-mono text-xs text-(--el-text-identifier)">
                {card.identifier}
              </span>
              <span
                data-testid="guide-crumb-title"
                className={`truncate font-semibold text-(--el-text) ${
                  view.titleEditedNow
                    ? 'guide-title--edited rounded-(--radius-kbd) bg-(--el-diff-added) px-(--spacing-control-x-4)'
                    : ''
                }`}
              >
                {title}
              </span>
            </span>
          </div>
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <GuideTodoCanvas
              view={view}
              // The saved rows' links from their read; a step the conversation proposed
              // and has not saved draws from the thread's own resolve.
              workItemRefs={canvasRefs}
              // The door asserted `work_item:edit` before the guide opened, and the
              // to-do action asserts it again on every tick.
              canTick
              onSetDone={(id, done) => void setRowDone(id, done)}
              onSave={() => void send(tg('saveTurn'))}
              busy={state.phase !== 'idle'}
              tickError={state.tickError}
            />
          </div>
        </div>
      }
      chat={
        <GuideRail
          card={{ ...card, title }}
          session={state.session}
          view={view}
          phase={state.phase}
          errorCode={state.errorCode}
          startingUp={state.startingUp}
          outOfCredits={state.outOfCredits || offerBlocked}
          markers={state.markers}
          onSend={(text, attachmentIds) => void send(text, attachmentIds)}
          onRetry={() => void retry()}
          onReload={() => void reloadRows()}
          canPlan={state.planning.canPlan && can('ai:plan')}
          cannotPlanReason={
            state.planning.reason ?? (can('ai:plan') ? null : ('no_permission' as const))
          }
          decliningTurnId={state.decliningTurnId}
          onOpenOffer={openOffer}
          onDeclineOffer={(id) => void declineOffer(id)}
        />
      }
    />
  );
}

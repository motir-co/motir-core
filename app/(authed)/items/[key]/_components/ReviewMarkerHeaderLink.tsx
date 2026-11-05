'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, LoaderCircle } from 'lucide-react';
import { ReviewMarker, useReviewMarkerCopy } from '@/components/approvals/ReviewMarker';
import { ReviewCommand } from '@/components/approvals/ReviewCommand';
import type { ReviewMarkerDTO } from '@/lib/dto/reviewState';
import { useLandOnLateSection } from './useLandOnLateSection';

// THE ITEM HEADER'S REVIEW MARKER (Story MOTIR-10327 · MOTIR-10341;
// `design/github/design-notes.md` § 32.1–32.2, `decision-waiting--review-path.mock.html` M9).
//
// The decision-waiting header link's twin (`DecisionWaitingHeaderLink`): the same slot in
// the eyebrow, the same POINTER — the state's words and an `ArrowDown`, never a verb — and
// the same landing on the Development section, which carries `agent_review` among its
// `data-decision-anchor` kinds. That section streams in the late tier, so a press before it
// mounts waits for it exactly as the decision marker's does.
//
// For *Waiting for your review agent* the copyable `motir review <KEY>` follows the button
// as its own control, never inside it (one control may not nest another).

function agentReviewAnchor(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-decision-anchor~="agent_review"]');
}

export function ReviewMarkerHeaderLink({
  marker,
  identifier,
}: {
  marker: ReviewMarkerDTO;
  identifier: string;
}) {
  const t = useTranslations('approvalGate');
  const find = useCallback(() => agentReviewAnchor(), []);
  const { press: onPress, pending } = useLandOnLateSection(find);
  const { sentence } = useReviewMarkerCopy(marker, identifier);
  const noun = t('statusHeld.decisionNoun.agent_review');
  const jump = t('waiting.jump', { decision: noun });

  return (
    <>
      <button
        type="button"
        onClick={onPress}
        aria-label={`${sentence}. ${jump}`}
        title={jump}
        aria-busy={pending || undefined}
        className="group inline-flex min-w-0 max-w-full shrink-0 cursor-pointer rounded-(--radius-badge) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        data-review-header-marker=""
      >
        <ReviewMarker
          marker={marker}
          identifier={identifier}
          className="group-hover:border-(--el-border-strong)"
          trailing={
            pending ? (
              <LoaderCircle className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
            ) : (
              <ArrowDown className="h-3 w-3 shrink-0" aria-hidden />
            )
          }
        />
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {pending ? t('waiting.opening', { decision: noun }) : ''}
      </span>
      {marker.kind === 'waiting_for_own_agent' && marker.forViewer && marker.command ? (
        <ReviewCommand command={marker.command} identifier={identifier} />
      ) : null}
    </>
  );
}

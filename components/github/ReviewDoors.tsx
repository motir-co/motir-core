'use client';

import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { ReviewCommand } from '@/components/approvals/ReviewCommand';
import { ReviewInMyAgentControl } from '@/components/agentRuns/ReviewInMyAgentControl';
import { useHostedModels } from '@/components/hosted/HostedModelsProvider';
import {
  ReviewHostedRefusalNotice,
  ReviewHostedRow,
  useReviewWithMotirAgent,
} from '@/components/github/ReviewHostedDoor';
import { ModelsEmpty, ModelsUnavailable } from '@/components/hosted/ContinueHostedControl';

// THE REVIEW DOORS (Story MOTIR-11941 · MOTIR-11948), built to `design/github/design-notes.md`
// § 33.4 (`review-path--person-starts.mock.html` Panels 4–4j). Three ways to START a review of
// an item, in this order, in one `flex-wrap` row so at a narrow width they drop line by line:
//
//   1. *Review with Motir agent* — the *Fix on the hosted agent* row exactly: the shipped
//      `HostedModelPicker`, then the primary `Button` with the `Bot` glyph, and the AI-credits
//      note under the row. It POSTs `…/review-with-motir-agent` with the picked model and a
//      per-press idempotency key; a second press while the first is pending sends nothing.
//   2. *Review in my agent* — `ReviewInMyAgentControl`, primary when door 1 is hidden.
//   3. *or run* `motir review <KEY>` — the shipped `ReviewCommand` chip.
//
// ⚠️ IT DOES NOT DECIDE WHETHER A REVIEW MAY START. The frame draws the doors only in the
// states § 33.4 offers them, for a reader who may start one; the page passes door 1 only to a
// reader who may run the card hosted, and door 2 only to one who may use agents on the
// project. Every refusal is drawn from the route's own answer: the hosted kill-switch
// (`ORG_FEATURE_DISABLED`) HIDES door 1, and a stale page (`REVIEW_START_NOT_OFFERED` /
// `REVIEW_START_FORBIDDEN`) re-reads it.

export {
  reviewHostedRefusalOf,
  useReviewWithMotirAgent,
  type ReviewHostedRefusal,
} from '@/components/github/ReviewHostedDoor';

/** The three doors for ONE item, under a lead the frame draws. */
export function ReviewDoors({
  itemKey,
  command,
  hosted,
  myAgent,
  onStarted,
  onStateMoved,
}: {
  itemKey: string;
  /** `motir review <KEY>`. */
  command: string;
  /** Door 1 is offered: the reader may run the card hosted. Mount under a
   *  `HostedModelsProvider`. */
  hosted: boolean;
  /** Door 2 is offered: the reader may use agents on the project, which it names. */
  myAgent: { projectName: string } | null;
  onStarted?: () => void;
  onStateMoved?: () => void;
}) {
  const t = useTranslations('approvalGate.agentReview.doors');
  const press = useReviewWithMotirAgent(itemKey, { onStarted, onStateMoved });
  const models = useHostedModels();
  const hostedShown = hosted && models !== null && press.refusal?.kind !== 'laneOff';
  const doorsBefore = hostedShown || myAgent !== null;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="review-doors">
      <div className="flex flex-wrap items-center gap-2">
        {hostedShown ? (
          <ReviewHostedRow
            starting={press.starting}
            onPress={() => void press.start()}
            refused={press.refusal?.kind === 'noCapacity'}
          />
        ) : null}
        {myAgent ? (
          <ReviewInMyAgentControl
            itemKey={itemKey}
            projectName={myAgent.projectName}
            variant={hostedShown ? 'secondary' : 'primary'}
            onStarted={onStarted}
            onStateMoved={onStateMoved}
          />
        ) : null}
        <span className="inline-flex items-center gap-1.5 text-[13px] text-(--el-text-secondary)">
          {doorsBefore ? <span>{t('orRun')}</span> : null}
          <ReviewCommand command={command} identifier={itemKey} />
        </span>
      </div>
      {hostedShown ? (
        <p
          className="m-0 inline-flex items-start gap-1.5 text-xs leading-normal text-(--el-text-secondary)"
          data-testid="review-credits-note"
        >
          <Sparkles className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{t('creditsNote')}</span>
        </p>
      ) : null}
      {hostedShown && press.refusal ? <ReviewHostedRefusalNotice refusal={press.refusal} /> : null}
      {hostedShown && models?.models.state === 'unavailable' ? (
        <ModelsUnavailable onRetry={models.reloadModels} testIdPrefix="review-hosted" />
      ) : null}
      {hostedShown && models?.models.state === 'ok' && models.models.models.length === 0 ? (
        <ModelsEmpty testIdPrefix="review-hosted" />
      ) : null}
    </div>
  );
}

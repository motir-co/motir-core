'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ReviewCommand } from '@/components/approvals/ReviewCommand';
import { ReviewInMyAgentControl } from '@/components/agentRuns/ReviewInMyAgentControl';
import { HostedHeldLine, HostedModelPicker } from '@/components/hosted/HostedModelPicker';
import { reReadAfter, useHostedModels } from '@/components/hosted/HostedModelsProvider';
import {
  ModelsEmpty,
  ModelsUnavailable,
  Notice,
  NotWritableNotice,
} from '@/components/hosted/ContinueHostedControl';
import {
  isHeld,
  pressKey,
  refusalOf,
  standingRefusal,
  type HostedRunRefusal,
} from '@/components/hosted/hostedModels';

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

export type ReviewHostedRefusal = HostedRunRefusal | { kind: 'laneOff' } | { kind: 'stale' };

/** The hosted door's refusal body → its refusal. Exported for its test. */
export function reviewHostedRefusalOf(
  status: number,
  body: Record<string, unknown>,
  model: string,
): ReviewHostedRefusal {
  const code = typeof body.code === 'string' ? body.code : '';
  if (code === 'ORG_FEATURE_DISABLED') return { kind: 'laneOff' };
  if (code === 'REVIEW_START_NOT_OFFERED' || code === 'REVIEW_START_FORBIDDEN' || status === 404) {
    return { kind: 'stale' };
  }
  return refusalOf(status, body, model);
}

/** ONE item's *Review with Motir agent* press. */
export function useReviewWithMotirAgent(
  itemKey: string,
  opts: { onStarted?: () => void; onStateMoved?: () => void } = {},
) {
  const hostedModels = useHostedModels();
  const selectedModel = hostedModels?.selectedModel ?? null;
  const { onStarted, onStateMoved } = opts;
  const [refusal, setRefusal] = useState<ReviewHostedRefusal | null>(null);
  const [starting, setStarting] = useState(false);
  // A double press while the request is pending sends ONE request.
  const inFlight = useRef(false);

  const start = useCallback(async (): Promise<void> => {
    if (!selectedModel || inFlight.current) return;
    inFlight.current = true;
    setStarting(true);
    setRefusal(null);
    try {
      const res = await fetch(
        `/api/work-items/${encodeURIComponent(itemKey)}/review-with-motir-agent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ model: selectedModel, idempotencyKey: pressKey() }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) {
        onStarted?.();
        return;
      }
      const refused = reviewHostedRefusalOf(res.status, body, selectedModel);
      setRefusal(refused);
      reReadAfter(refused, hostedModels);
      if (refused.kind === 'stale' || refused.kind === 'bootFailed') onStateMoved?.();
    } catch {
      setRefusal({ kind: 'failed' });
    } finally {
      inFlight.current = false;
      setStarting(false);
    }
  }, [hostedModels, itemKey, onStarted, onStateMoved, selectedModel]);

  return { start, starting, refusal: standingRefusal(refusal, selectedModel) };
}

/** Door 1's row — the picker and *Review with Motir agent*. Also drawn on Waiting on you's
 *  review-to-run row (MOTIR-12032). Mount under a `HostedModelsProvider`. */
export function ReviewHostedRow({
  starting,
  onPress,
  refused,
}: {
  starting: boolean;
  onPress: () => void;
  refused: boolean;
}) {
  const t = useTranslations('approvalGate.agentReview.doors');
  const tDoor = useTranslations('runs.hosted.door');
  const hosted = useHostedModels();
  const heldId = useId();
  if (!hosted) return null;
  const modelsReady = hosted.models.state === 'ok' && hosted.models.models.length > 0;
  const held = isHeld(hosted.models, hosted.selectedModel);
  const heldLine = held && !refused ? hosted.selectedModel : null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="review-hosted-door">
      <HostedModelPicker
        models={hosted.models}
        value={hosted.selectedModel}
        onChange={hosted.setChosen}
        disabled={starting}
      />
      <Button
        type="button"
        variant="primary"
        size="sm"
        disabled={!modelsReady || starting || !hosted.selectedModel || held}
        loading={starting}
        onClick={onPress}
        leftIcon={<Bot className="size-3.5" aria-hidden="true" />}
        aria-describedby={heldLine ? heldId : undefined}
        data-testid="review-with-motir-agent"
      >
        {starting ? tDoor('starting') : t('motirAgent')}
      </Button>
      <HostedHeldLine model={heldLine} id={heldId} />
    </div>
  );
}

/** Door 1's refusal, drawn from the route's own answer; `laneOff` draws nothing. */
export function ReviewHostedRefusalNotice({ refusal }: { refusal: ReviewHostedRefusal }) {
  const tRun = useTranslations('runs.hosted.refused');
  const testId = `review-hosted-refused-${refusal.kind}`;
  if (refusal.kind === 'laneOff') return null;
  if (refusal.kind === 'notWritable')
    return <NotWritableNotice refusal={refusal} testId={testId} />;
  // A stale page re-reads; the nearest true sentence until it lands is Run hosted's *not
  // started*, as *Fix on the hosted agent* says it.
  const kind = refusal.kind === 'stale' || refusal.kind === 'notReady' ? 'failed' : refusal.kind;
  const args: Record<string, string> =
    refusal.kind === 'modelNotOffered' || refusal.kind === 'noCapacity'
      ? { model: refusal.model }
      : {};
  return (
    <Notice testId={testId}>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-semibold">{tRun(`${kind}.title`, args)}</p>
        <p>{tRun(`${kind}.body`)}</p>
      </div>
    </Notice>
  );
}

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

'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bot } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { HostedHeldLine, HostedModelPicker } from '@/components/hosted/HostedModelPicker';
import { reReadAfter, useHostedModels } from '@/components/hosted/HostedModelsProvider';
import { Notice, NotWritableNotice } from '@/components/hosted/ContinueHostedControl';
import {
  isHeld,
  pressKey,
  refusalOf,
  standingRefusal,
  type HostedRunRefusal,
} from '@/components/hosted/hostedModels';

// DOOR 1 OF THE REVIEW DOORS — *Review with Motir agent* (Story MOTIR-11941 · MOTIR-11948;
// `design/github/design-notes.md` § 33.4): the press, its row (the shipped
// `HostedModelPicker` + the primary `Button`) and its refusal notice. Its own module since
// MOTIR-12032 so Waiting on you's review-to-run row (`design/workbench/design-notes.md` § 45.2)
// draws the same door WITHOUT importing the item page's door 2 (`ReviewInMyAgentControl`),
// whose run provider refreshes the route — a refresh no live Workbench path may reach
// (`tests/architecture/no-refresh-on-live-paths.test.ts`). `ReviewDoors` composes it.

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

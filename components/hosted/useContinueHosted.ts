'use client';

import { useCallback, useState } from 'react';
import { reReadAfter, useHostedModels } from './HostedModelsProvider';
import {
  continueRefusalOf,
  continueStateMoved,
  pressKey,
  standingRefusal,
  type ContinueHostedRefusal,
} from './hostedModels';

// ONE CARD'S CONTINUE HOSTED PRESS (Story MOTIR-6527 · MOTIR-6796; lifted into a
// hook by MOTIR-6879 so many doors can share one page).
//
// ⚠️ THE DEAD RUN'S ID IS NEVER SENT. The start route re-evaluates the card in
// continue mode (`app/api/work-items/[id]/hosted-runs/route.ts`), which is what keeps
// a door on a list row as honest as the item page's: whatever the page last read,
// the server answers from the card as it is now, and a stale page is a refusal.

export interface UseContinueHostedOptions {
  /** The continue started: the caller re-reads whatever shows the card's state. */
  onStarted?: () => void;
  /** A refusal that means the caller's view of the card is STALE (C5a). */
  onStateMoved?: () => void;
}

export interface UseContinueHostedValue {
  start: () => Promise<void>;
  starting: boolean;
  refusal: ContinueHostedRefusal | null;
}

/** The press on the card whose key is `continueTarget` — the card's own, or its
 *  dead parent run's. Null where no continue is offered: `start` then does nothing. */
export function useContinueHosted(
  continueTarget: string | null,
  opts: UseContinueHostedOptions = {},
): UseContinueHostedValue {
  const hostedModels = useHostedModels();
  // The preselect Continue hosted always had — not the card's resolution (MOTIR-6996).
  const selectedModel = hostedModels?.continueModel ?? null;
  const { onStarted, onStateMoved } = opts;
  const [refusal, setRefusal] = useState<ContinueHostedRefusal | null>(null);
  const [starting, setStarting] = useState(false);

  const start = useCallback(async (): Promise<void> => {
    if (!selectedModel || starting || !continueTarget) return;
    setStarting(true);
    setRefusal(null);
    try {
      const res = await fetch(`/api/work-items/${encodeURIComponent(continueTarget)}/hosted-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          mode: 'continue',
          idempotencyKey: pressKey(),
        }),
      });
      if (res.ok) {
        onStarted?.();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const refused = continueRefusalOf(res.status, body, selectedModel);
      setRefusal(refused);
      // A no-capacity refusal is not stale: the door stays (MOTIR-9630).
      reReadAfter(refused, hostedModels);
      if (continueStateMoved(refused)) onStateMoved?.();
    } catch {
      setRefusal({ kind: 'failed' });
    } finally {
      setStarting(false);
    }
  }, [continueTarget, hostedModels, onStarted, onStateMoved, selectedModel, starting]);

  // A no-capacity refusal clears when the person picks another model.
  return { start, starting, refusal: standingRefusal(refusal, selectedModel) };
}

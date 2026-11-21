'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/hosted/ContinueHostedControl';
import { pressKey } from '@/components/hosted/hostedModels';
import { AgentPicker } from '@/app/(authed)/items/[key]/_components/SendToAgentDoor';
import type { AgentForCardDto, ReviewInMyAgentDoorDto } from '@/lib/dto/agentInstanceRuns';

// REVIEW IN MY AGENT (Story MOTIR-11941 · MOTIR-11948), built to `design/github/design-notes.md`
// § 33.4–§ 33.5 (`review-path--person-starts.mock.html` Panels 4, 4i, 4j, 5, 5b). It mirrors
// `FixInMyAgentControl`:
//
// ⚠️ IT DOES NOT DECIDE WHETHER IT IS OFFERED. The door reads ONE server evaluation
// (`GET /api/work-items/{key}/review-in-my-agent`) and renders nothing until that read has
// answered, so the review part does not shift under a person's cursor. `offered` draws the
// button that opens the picker, the agent the read chose preselected; `no_agent` draws it too
// and the picker opens on the shipped *Create one in My agents* face; `agent_unusable` draws
// it and the picker lists the agent with its refusal in words. Every other answer
// (`review_in_flight`, `cannot_decide`, and the item reasons) draws nothing.
//
// The press POSTs that route's start; pressing a free row IS the start, as in *Send to my
// agent*. Every refusal is drawn from the route's own answer.

export type ReviewInMyAgentRefusal =
  | { kind: 'stale' }
  | { kind: 'outOfCredits' }
  | { kind: 'failed' };

/** The start's refusal → the notice the door draws. Exported for its test. */
export function reviewInMyAgentRefusalOf(
  status: number,
  body: Record<string, unknown>,
): ReviewInMyAgentRefusal {
  // The read the page drew no longer holds — a review started, or the item moved on.
  if (body.code === 'review_in_my_agent_not_offered' || status === 404) return { kind: 'stale' };
  if (status === 402) return { kind: 'outOfCredits' };
  return { kind: 'failed' };
}

type DoorRead =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; door: ReviewInMyAgentDoorDto };

/** The reasons the door is still drawn for, though not offered. */
const DRAWN_REASONS = new Set(['no_agent', 'agent_unusable']);

export function ReviewInMyAgentControl({
  itemKey,
  projectName,
  variant,
  onStarted,
  onStateMoved,
}: {
  itemKey: string;
  /** The project's name — the picker's foot and its empty face name it. */
  projectName: string;
  /** Primary when *Review with Motir agent* is hidden (§ 33.4, door 2). */
  variant: 'primary' | 'secondary';
  /** The review started: the caller re-reads whatever shows the item's state. */
  onStarted?: () => void;
  /** A refusal that means the caller's view of the item is STALE. */
  onStateMoved?: () => void;
}) {
  const t = useTranslations('approvalGate.agentReview');
  const tRun = useTranslations('runs.hosted.refused');
  const tDoor = useTranslations('runs.hosted.door');
  const tc = useTranslations('common');
  const [read, setRead] = useState<DoorRead>({ state: 'loading' });
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<ReviewInMyAgentRefusal | null>(null);
  const inFlight = useRef(false);
  const url = `/api/work-items/${encodeURIComponent(itemKey)}/review-in-my-agent`;

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        setRead({ state: 'error' });
        return;
      }
      setRead({ state: 'ready', door: (await res.json()) as ReviewInMyAgentDoorDto });
    } catch {
      setRead({ state: 'error' });
    }
  }, [url]);

  useEffect(() => {
    // The async wrapper keeps the state update out of the effect BODY
    // (`react-hooks/set-state-in-effect`).
    void (async () => {
      await load();
    })();
  }, [load]);

  const start = useCallback(
    async (agent: AgentForCardDto): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      setSendingId(agent.id);
      setRefusal(null);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ agentInstanceId: agent.id, idempotencyKey: pressKey() }),
        });
        // The body is read on EVERY answer (FixInMyAgentControl's note).
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (res.ok) {
          onStarted?.();
          return;
        }
        const refused = reviewInMyAgentRefusalOf(res.status, body);
        setRefusal(refused);
        if (refused.kind === 'stale') {
          onStateMoved?.();
          void load();
        }
      } catch {
        setRefusal({ kind: 'failed' });
      } finally {
        inFlight.current = false;
        setSendingId(null);
      }
    },
    [load, onStarted, onStateMoved, url],
  );

  if (read.state === 'loading') return null;
  if (read.state === 'error') {
    return (
      <Notice testId="review-my-agent-read-failed">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-semibold">{tRun('failed.title')}</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => void load()}>
            {tc('retry')}
          </Button>
        </div>
      </Notice>
    );
  }
  const door = read.door;
  if (!door.offered && !DRAWN_REASONS.has(door.reason)) return null;

  const preselect =
    door.offered && door.lastUsedOnItem ? { id: door.agent.id, note: t('picker.lastUsed') } : null;
  return (
    <>
      <AgentPicker
        itemKey={itemKey}
        projectName={projectName}
        label={sendingId ? tDoor('starting') : t('doors.myAgent')}
        ariaLabel={t('doors.myAgent')}
        variant={variant}
        disabled={sendingId !== null}
        title={t('picker.title', { key: itemKey })}
        lead={t('picker.lead', { key: itemKey })}
        sendingId={sendingId}
        onChoose={start}
        preselect={preselect}
        testId="review-in-my-agent"
      />
      {refusal ? (
        <div className="basis-full">
          <Notice testId={`review-my-agent-refused-${refusal.kind}`}>
            <div className="flex min-w-0 flex-col gap-1">
              <p className="font-semibold">
                {tRun(`${refusal.kind === 'stale' ? 'failed' : refusal.kind}.title`)}
              </p>
              <p>{tRun(`${refusal.kind === 'stale' ? 'failed' : refusal.kind}.body`)}</p>
            </div>
          </Notice>
        </div>
      ) : null}
    </>
  );
}

'use client';

import { useCallback, useId, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Cloud } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { HostedHeldLine, HostedModelPicker } from './HostedModelPicker';
import { reReadAfter, useHostedModels } from './HostedModelsProvider';
import {
  ModelsEmpty,
  ModelsUnavailable,
  Notice,
  NotWritableNotice,
  When,
} from './ContinueHostedControl';
import {
  fixRefusalOf,
  fixStateMoved,
  isHeld,
  pressKey,
  standingRefusal,
  type FixHostedRefusal,
} from './hostedModels';

// FIX ON THE HOSTED AGENT (Story MOTIR-1626 · MOTIR-6930), built to
// `design/github/design-notes.md` § 30 Panels 3–3e
// (`design/github/approve-and-merge--agent-review.mock.html`) and
// `design/workbench/design-notes.md` § 32 Panels 2 and 4
// (`design/workbench/workbench--to-fix--review-agent.mock.html`), approved on MOTIR-6817.
// Rules of record: `docs/decisions/approval-gates.md` §12.4b, `hosted-agent-run.md` §8.6.
//
// ⚠️ THE CONTINUE HOSTED DOOR'S EXACT ROW, NOT A SECOND ONE: the shipped
// `HostedModelPicker` then the primary `Button` with the `Cloud` glyph, reading the page's
// ONE model list (`HostedModelsProvider`), `flex-wrap` so at ~400px the button drops under
// the picker. Its answers are the Continue hosted door's (`ContinueHostedControl`'s shared
// notices), with only out-of-credits re-worded to name this door, and `taken` naming who
// holds the repair.
//
// ⚠️ IT DOES NOT DECIDE WHETHER IT IS OFFERED. A card a review sent back, a viewer who may
// press Run hosted, no repair already open: the surface that places the control decides
// those, and the press never guesses whether the server will accept it — every refusal is
// drawn from the route's own answer (`POST /api/work-items/{key}/hosted-runs`,
// `mode: 'fix'`).

export interface UseFixHostedOptions {
  /** The repair started: the caller re-reads whatever shows the card's state. */
  onStarted?: () => void;
  /** A refusal that means the caller's view of the card is STALE. */
  onStateMoved?: () => void;
}

export interface UseFixHostedValue {
  start: () => Promise<void>;
  starting: boolean;
  refusal: FixHostedRefusal | null;
}

/** ONE card's *Fix on the hosted agent* press. Null where no repair is offered: `start`
 *  then does nothing. The pressing person's picked model is sent, with a fresh
 *  idempotency key per press. */
export function useFixHosted(
  itemKey: string | null,
  opts: UseFixHostedOptions = {},
): UseFixHostedValue {
  const hostedModels = useHostedModels();
  const selectedModel = hostedModels?.selectedModel ?? null;
  const { onStarted, onStateMoved } = opts;
  const [refusal, setRefusal] = useState<FixHostedRefusal | null>(null);
  const [starting, setStarting] = useState(false);

  const start = useCallback(async (): Promise<void> => {
    if (!selectedModel || starting || !itemKey) return;
    setStarting(true);
    setRefusal(null);
    try {
      const res = await fetch(`/api/work-items/${encodeURIComponent(itemKey)}/hosted-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ model: selectedModel, mode: 'fix', idempotencyKey: pressKey() }),
      });
      if (res.ok) {
        onStarted?.();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const refused = fixRefusalOf(res.status, body, selectedModel);
      setRefusal(refused);
      // A no-capacity refusal is not stale: the door stays (MOTIR-9630).
      reReadAfter(refused, hostedModels);
      if (fixStateMoved(refused)) onStateMoved?.();
    } catch {
      setRefusal({ kind: 'failed' });
    } finally {
      setStarting(false);
    }
  }, [itemKey, hostedModels, onStarted, onStateMoved, selectedModel, starting]);

  // A no-capacity refusal clears when the person picks another model.
  return { start, starting, refusal: standingRefusal(refusal, selectedModel) };
}

/** The picker and the button — Panel 3's door (3a while the press is in flight). A held
 *  selected model holds the button with the *Held Run line* (MOTIR-9630, design N8),
 *  which gives way to a standing no-capacity refusal (`refused`). */
export function FixHostedButtonRow({
  starting,
  onPress,
  testId = 'fix-hosted-door',
  refused = false,
}: {
  starting: boolean;
  onPress: () => void;
  testId?: string;
  /** A no-capacity refusal stands under the door — it names the model instead. */
  refused?: boolean;
}) {
  const t = useTranslations('github.development.fix.hosted');
  const tDoor = useTranslations('runs.hosted.door');
  const hosted = useHostedModels();
  const heldId = useId();
  if (!hosted) return null;
  const modelsReady = hosted.models.state === 'ok' && hosted.models.models.length > 0;
  const held = isHeld(hosted.models, hosted.selectedModel);
  const heldLine = held && !refused ? hosted.selectedModel : null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={testId}>
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
        leftIcon={<Cloud className="size-3.5" aria-hidden="true" />}
        aria-describedby={heldLine ? heldId : undefined}
        data-testid="fix-hosted"
      >
        {starting ? tDoor('starting') : t('button')}
      </Button>
      <HostedHeldLine model={heldLine} id={heldId} />
    </div>
  );
}

const bold = (chunks: ReactNode) => <b className="font-semibold">{chunks}</b>;

/** What the door answered (Panels 3c and 3d), and the picker's two notices while the door
 *  is live — in the door's own warning notice, directly under the door. */
export function FixHostedAnswer({
  live,
  refusal,
  viewerId,
}: {
  /** The door is drawn — the model notices belong to a live door only. */
  live: boolean;
  refusal: FixHostedRefusal | null;
  /** The session's user — a `taken` answer naming them reads *you*. */
  viewerId: string | null;
}) {
  const hosted = useHostedModels();
  if (!hosted) return null;
  const models = hosted.models;
  return (
    <>
      {refusal ? <Refusal refusal={refusal} viewerId={viewerId} /> : null}
      {live && models.state === 'unavailable' ? (
        <ModelsUnavailable onRetry={hosted.reloadModels} testIdPrefix="fix-hosted" />
      ) : null}
      {live && models.state === 'ok' && models.models.length === 0 ? (
        <ModelsEmpty testIdPrefix="fix-hosted" />
      ) : null}
    </>
  );
}

function Refusal({ refusal, viewerId }: { refusal: FixHostedRefusal; viewerId: string | null }) {
  const t = useTranslations('github.development.fix.hosted.refused');
  const tRun = useTranslations('runs.hosted.refused');
  const testId = `fix-hosted-refused-${refusal.kind}`;
  if (refusal.kind === 'notWritable') {
    return <NotWritableNotice refusal={refusal} testId={testId} />;
  }

  let title: ReactNode;
  let body: ReactNode = tRun('notReady.body');
  switch (refusal.kind) {
    case 'taken': {
      const mine = refusal.holder !== null && refusal.holder.id === viewerId;
      const when = () => (refusal.startedAt ? <When iso={refusal.startedAt} /> : null);
      title = mine
        ? t.rich('takenByYou', { when })
        : t.rich('taken', { name: refusal.holder?.name ?? '—', b: bold, when });
      break;
    }
    case 'outOfCredits':
      title = tRun('outOfCredits.title');
      body = t('outOfCredits.body');
      break;
    case 'modelNotOffered':
    case 'noCapacity':
      title = tRun(`${refusal.kind}.title`, { model: refusal.model });
      body = tRun(`${refusal.kind}.body`);
      break;
    case 'stale':
      // The card is no longer a review's to repair — the page re-reads, and the door goes.
      // The nearest true sentence is Run hosted's own *not started*.
      title = tRun('failed.title');
      body = tRun('failed.body');
      break;
    default:
      title = tRun(`${refusal.kind}.title`);
      body = tRun(`${refusal.kind}.body`);
  }
  return (
    <Notice testId={testId}>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-semibold">{title}</p>
        <p>{body}</p>
      </div>
    </Notice>
  );
}

/** The whole door for ONE card: the press, the row and its answers. Mount it under a
 *  `HostedModelsProvider`, which every hosted door on the page shares. */
export function FixHostedControl({
  itemKey,
  viewerId = null,
  onStarted,
  onStateMoved,
}: {
  itemKey: string;
  viewerId?: string | null;
  onStarted?: () => void;
  onStateMoved?: () => void;
}) {
  const press = useFixHosted(itemKey, { onStarted, onStateMoved });
  return (
    <div className="flex flex-col gap-2" data-testid="fix-hosted-control">
      <FixHostedButtonRow
        starting={press.starting}
        onPress={() => void press.start()}
        refused={press.refusal?.kind === 'noCapacity'}
      />
      <FixHostedAnswer live refusal={press.refusal} viewerId={viewerId} />
    </div>
  );
}

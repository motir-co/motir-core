'use client';

import { useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Cloud, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { repositoryRowHref } from '@/lib/projectRepos/repositoryAnchor';
import { formatRunInstant } from '@/lib/runs/runClock';
import { relativeLabel } from '@/components/github/RepairFixPart';
import { HostedHeldLine, HostedModelPicker } from './HostedModelPicker';
import { useHostedModels } from './HostedModelsProvider';
import { useContinueHosted } from './useContinueHosted';
import { isHeld, type ContinueHostedRefusal } from './hostedModels';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

// CONTINUE HOSTED, AS A CONTROL ANY SURFACE CAN PLACE (MOTIR-6879), built to
// `design/runs/design-notes.md` § Continue hosted, Panels C1–C5
// (`design/runs/development--continue-hosted.mock.html`, approved on MOTIR-6789).
// Lifted out of the item page's `ContinueHostedDoor` with its markup unchanged: the
// item page now composes these same parts, so the two can never drift.
//
// ⚠️ RUN HOSTED'S ROW, NOT A SECOND ONE: the shipped `HostedModelPicker` then a
// primary `Button` with the `Cloud` glyph, reading the page's ONE model list
// (`HostedModelsProvider`). `flex-wrap` is the one addition, so at ~400px the button
// drops under the picker.
//
// ⚠️ ITS ANSWERS ARE ITS OWN. A refusal is drawn directly under this door — never
// in the Run section's body, whose notices answer Run hosted's door.
//
// ⚠️ IT DOES NOT DECIDE WHETHER IT IS OFFERED. Alive, succeeded, never run, nothing
// pushed, Implemented, a viewer who may not edit: the surface that places the
// control decides those, and passes a null target where it is not offered.

/** The picker and the button — the primary action (C1–C3, C4a). A held selected model
 *  holds the button with the *Held Run line* (MOTIR-9630, design N7), which gives way
 *  to a standing no-capacity refusal (`refused`). */
export function ContinueHostedButtonRow({
  continueTarget,
  itemKey,
  starting,
  onPress,
  refused = false,
}: {
  /** The key the press continues — the card's own, or its dead parent run's. */
  continueTarget: string | null;
  /** The card the control sits on: a target that differs from it names the parent. */
  itemKey: string;
  starting: boolean;
  onPress: () => void;
  /** A no-capacity refusal stands under the door — it names the model instead. */
  refused?: boolean;
}) {
  const t = useTranslations('github.development.continue.hosted');
  const tDoor = useTranslations('runs.hosted.door');
  const hosted = useHostedModels();
  const heldId = useId();
  if (!hosted || !continueTarget) return null;

  const modelsReady = hosted.models.state === 'ok' && hosted.models.models.length > 0;
  const parent = continueTarget !== itemKey ? continueTarget : null;
  const held = isHeld(hosted.models, hosted.continueModel);
  const heldLine = held && !refused ? hosted.continueModel : null;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="continue-hosted-door">
      <HostedModelPicker
        models={hosted.models}
        value={hosted.continueModel}
        onChange={hosted.setChosen}
        disabled={starting}
      />
      <Button
        type="button"
        variant="primary"
        size="sm"
        disabled={!modelsReady || starting || !hosted.continueModel || held}
        loading={starting}
        onClick={onPress}
        leftIcon={<Cloud className="size-3.5" aria-hidden="true" />}
        aria-describedby={heldLine ? heldId : undefined}
        data-testid="continue-hosted"
      >
        {starting ? tDoor('starting') : parent ? t('buttonParent', { key: parent }) : t('button')}
      </Button>
      <HostedHeldLine model={heldLine} id={heldId} />
    </div>
  );
}

/** What the door answered — kept after the surface re-reads its view (C5a). */
export function ContinueHostedAnswer({
  continueTarget,
  refusal,
  viewerId,
}: {
  continueTarget: string | null;
  refusal: ContinueHostedRefusal | null;
  /** The session's user — a `taken` answer naming them reads *you*. */
  viewerId: string | null;
}) {
  const hosted = useHostedModels();
  if (!hosted) return null;
  const models = hosted.models;
  return (
    <>
      {refusal ? <Refusal refusal={refusal} viewerId={viewerId} /> : null}
      {continueTarget && models.state === 'unavailable' ? (
        <ModelsUnavailable onRetry={hosted.reloadModels} testIdPrefix="continue-hosted" />
      ) : null}
      {continueTarget && models.state === 'ok' && models.models.length === 0 ? (
        <ModelsEmpty testIdPrefix="continue-hosted" />
      ) : null}
    </>
  );
}

/** The whole control for ONE card: the press, the door and its answers. Mount it
 *  under a `HostedModelsProvider`, which every control on the page shares. */
export function ContinueHostedControl({
  continueTarget,
  itemKey,
  viewerId = null,
  onStarted,
  onStateMoved,
  compact = false,
}: {
  continueTarget: string;
  /** The card the control sits on; defaults to the target (a card's own run). */
  itemKey?: string;
  viewerId?: string | null;
  onStarted?: () => void;
  onStateMoved?: () => void;
  /** Row density — for a list row rather than the Development block. */
  compact?: boolean;
}) {
  const press = useContinueHosted(continueTarget, { onStarted, onStateMoved });
  return (
    <div
      className={compact ? 'flex flex-col gap-1' : 'flex flex-col gap-2'}
      data-testid="continue-hosted-control"
    >
      <ContinueHostedButtonRow
        continueTarget={continueTarget}
        itemKey={itemKey ?? continueTarget}
        starting={press.starting}
        onPress={() => void press.start()}
        refused={press.refusal?.kind === 'noCapacity'}
      />
      <ContinueHostedAnswer
        continueTarget={continueTarget}
        refusal={press.refusal}
        viewerId={viewerId}
      />
    </div>
  );
}

/** The picker's *could not load the models* notice — shared by every hosted door
 *  (`HostedDoorNotices`' copy), its test id prefixed by the door's own. */
export function ModelsUnavailable({
  onRetry,
  testIdPrefix,
}: {
  onRetry: () => void;
  testIdPrefix: string;
}) {
  const t = useTranslations('runs.hosted.picker');
  return (
    <Notice testId={`${testIdPrefix}-models-unavailable`}>
      <span>{t('unavailableBody')}</span>
      <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
        {t('retry')}
      </Button>
    </Notice>
  );
}

/** The picker's *no model can run hosted* notice — shared by every hosted door. */
export function ModelsEmpty({ testIdPrefix }: { testIdPrefix: string }) {
  const t = useTranslations('runs.hosted.picker');
  return (
    <Notice testId={`${testIdPrefix}-models-empty`}>
      <span>{t('emptyBody')}</span>
    </Notice>
  );
}

const bold = (chunks: ReactNode) => <b className="font-semibold">{chunks}</b>;

/** A relative time, read once per mount — every hosted door's `<when>`. */
export function When({ iso }: { iso: string }) {
  const locale = useLocale();
  // Read ONCE per mount, as the continue part's own clock is (ContinuePart.tsx).
  const [now] = useState(() => Date.now());
  return (
    <time className="whitespace-nowrap" dateTime={iso} title={formatRunInstant(iso, locale)}>
      {relativeLabel(iso, locale, now)}
    </time>
  );
}

function Refusal({
  refusal,
  viewerId,
}: {
  refusal: ContinueHostedRefusal;
  viewerId: string | null;
}) {
  const routes = useReaderRoutes();
  const t = useTranslations('github.development.continue.hosted.refused');
  const tRun = useTranslations('runs.hosted.refused');
  const nothing = tRun('notReady.body');
  const testId = `continue-hosted-refused-${refusal.kind}`;

  if (refusal.kind === 'notWritable') {
    return <NotWritableNotice refusal={refusal} testId={testId} />;
  }

  let title: ReactNode;
  let body: ReactNode = nothing;
  switch (refusal.kind) {
    case 'taken': {
      const mine = refusal.holder !== null && refusal.holder.id === viewerId;
      const when = () => (refusal.startedAt ? <When iso={refusal.startedAt} /> : null);
      title = mine
        ? t.rich('takenByYou', { when })
        : t.rich('taken', { name: refusal.holder?.name ?? '—', b: bold, when });
      break;
    }
    case 'runAlive':
      title = t.rich('runAlive', { name: refusal.holder?.name ?? '—', b: bold });
      break;
    case 'nothingPushed':
      title = t('nothingPushed');
      break;
    case 'useFix':
      title = t('useFix');
      break;
    case 'notInProgress':
      title = t('notInProgress');
      break;
    case 'noDeadRun':
      title = t('noDeadRun');
      break;
    case 'gateAwaiting':
      title = t('gateAwaiting');
      break;
    case 'gateSentBack':
      title = t('gateSentBack');
      break;
    case 'theParent': {
      const key = refusal.parentKey ?? '';
      title = t.rich('theParent', {
        key,
        link: (chunks) => (
          <Link
            href={routes.item(key)}
            className="font-medium text-(--el-link) underline-offset-2 hover:underline"
          >
            {chunks}
          </Link>
        ),
      });
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

/** A repository the app cannot write to — Run hosted's per-repository list, shared by
 *  every hosted door (a continue and a repair both push). */
export function NotWritableNotice({
  refusal,
  testId,
}: {
  refusal: Extract<ContinueHostedRefusal, { kind: 'notWritable' }>;
  testId: string;
}) {
  const tRun = useTranslations('runs.hosted.refused');
  const count = refusal.repositories.length;
  return (
    <Notice testId={testId}>
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="font-semibold">
          {refusal.total !== null
            ? tRun('notWritable.lead', { count, total: refusal.total })
            : tRun('notWritable.leadNoTotal', { count })}
        </p>
        <p>{tRun('notWritable.detail')}</p>
        <ul className="flex flex-col">
          {refusal.repositories.map((r) => (
            <li
              key={r.repository}
              className="flex flex-col gap-0.5 border-t border-(--el-border-soft) py-1.5 first:border-t-0"
            >
              <span className="font-mono text-xs font-semibold">{r.repository}</span>
              <span>{r.reason}</span>
              <Link
                className="self-start text-(--el-link) underline"
                href={repositoryRowHref(r.repository)}
              >
                {tRun('notWritable.open')}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </Notice>
  );
}

/** HostedDoorNotices' `notice warn` — nothing failed that the reader did, nothing was spent. */
export function Notice({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div
      role="status"
      data-testid={testId}
      className="flex items-start gap-2 rounded-(--radius-control) bg-(--el-warning-surface) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-sm text-(--el-text-strong)"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-(--el-warning)" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

'use client';

import type { ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Ban, Info, Moon, RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import type { OrgFleetAgentInstanceDTO, OrgFleetHostedRunDTO } from '@/lib/dto/orgFleet';
import type { OrgFleetStopPreviewDTO } from '@/lib/dto/orgFleetStop';
import { useFleetTime } from './fleetTime';

// The page's three confirmations (design panels 6–8): each a `Modal` with
// `role="alertdialog"`, focus on the SAFE button when it opens, and ×, Escape and
// the safe button inert while the stop is in flight — closing would not undo it.

const strong = (chunks: ReactNode) => <strong className="font-semibold">{chunks}</strong>;

function SkyCallout({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) p-(--spacing-card-padding) font-sans text-sm text-(--el-text-strong)">
      <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-info)" />
      <span>{children}</span>
    </div>
  );
}

export function CancelRunDialog({
  run,
  pending,
  onClose,
  onConfirm,
}: {
  run: OrgFleetHostedRunDTO | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations('settings.organization.fleet.cancelRun');
  const time = useFleetTime();
  const at = run ? time.clock(run.startedAt) : '';
  return (
    <Modal
      open={run !== null}
      onOpenChange={(next) => (next || pending ? undefined : onClose())}
      role="alertdialog"
      title={t('title')}
      description={
        run?.card
          ? t('description', { key: run.card.key, title: run.card.title ?? '' })
          : t('descriptionNoCard', { project: run?.projectName ?? '' })
      }
      hideClose={pending}
      size="md"
    >
      <Modal.Body>
        <p className="font-sans text-sm text-(--el-text)">
          {run?.dispatcherName
            ? t.rich('body', { name: run.dispatcherName, time: at, strong })
            : t.rich('bodyNoName', { time: at, strong })}
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onClick={onClose} disabled={pending} autoFocus>
          {t('keep')}
        </Button>
        <Button
          variant="danger"
          leftIcon={pending ? undefined : <Ban aria-hidden className="h-4 w-4" />}
          loading={pending}
          onClick={onConfirm}
        >
          {pending ? t('confirming') : t('confirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

export function HibernateAgentDialog({
  agent,
  owner,
  isSelf,
  pending,
  onClose,
  onConfirm,
}: {
  agent: OrgFleetAgentInstanceDTO | null;
  owner: string;
  /** The agent is the confirming person's own: nobody else is told. */
  isSelf: boolean;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations('settings.organization.fleet.hibernate');
  const tAgents = useTranslations('settings.organization.fleet');
  const time = useFleetTime();
  return (
    <Modal
      open={agent !== null}
      onOpenChange={(next) => (next || pending ? undefined : onClose())}
      role="alertdialog"
      title={t('title', { owner })}
      description={
        agent
          ? t('description', {
              profile: agent.profileId,
              project: agent.projectName ?? tAgents('hosted.noProject'),
              time: time.at(agent.since),
            })
          : undefined
      }
      hideClose={pending}
      size="md"
    >
      <Modal.Body className="gap-4">
        <p className="font-sans text-sm text-(--el-text)">{t('body')}</p>
        <SkyCallout>{isSelf ? t('toldSelf') : t.rich('told', { owner, strong })}</SkyCallout>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onClick={onClose} disabled={pending} autoFocus>
          {t('keep')}
        </Button>
        <Button
          variant="danger"
          leftIcon={pending ? undefined : <Moon aria-hidden className="h-4 w-4" />}
          loading={pending}
          onClick={onConfirm}
        >
          {pending ? t('confirming') : t('confirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

export type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; preview: OrgFleetStopPreviewDTO; countedAt: string };

/**
 * A preview Stop everything may be confirmed against: every count of a path it
 * STOPS was read. `ciRuns` alone may be unknown (GitHub was not reachable): the
 * containers it stops were still counted, as on the platform's dialog.
 */
export function isConfirmable(preview: OrgFleetStopPreviewDTO): boolean {
  return (
    preview.ciContainers !== null && preview.hostedRuns !== null && preview.runningAgents !== null
  );
}

export function StopEverythingDialog({
  open,
  orgName,
  preview,
  pending,
  onClose,
  onRetry,
  onConfirm,
}: {
  open: boolean;
  orgName: string;
  preview: PreviewState;
  pending: boolean;
  onClose: () => void;
  onRetry: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations('settings.organization.fleet.stopAll');
  const time = useFleetTime();
  const unreadable =
    preview.status === 'failed' || (preview.status === 'ready' && !isConfirmable(preview.preview));
  return (
    <Modal
      open={open}
      onOpenChange={(next) => (next || pending ? undefined : onClose())}
      role="alertdialog"
      title={t('title', { org: orgName })}
      description={unreadable ? undefined : t('lead')}
      hideClose={pending}
      size="md"
    >
      <Modal.Body className="gap-4">
        {preview.status === 'loading' || preview.status === 'idle' ? (
          <div className="flex flex-col gap-2" aria-busy="true" data-testid="stop-all-counting">
            <span className="h-3.5 w-3/4 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
            <span className="h-3.5 w-1/2 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
            <span className="h-3.5 w-3/5 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
            <span aria-live="polite" className="font-sans text-xs text-(--el-text-secondary)">
              {t('counting')}
            </span>
          </div>
        ) : null}

        {unreadable ? (
          <div
            role="alert"
            data-testid="stop-all-unreadable"
            className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-rose) p-(--spacing-card-padding) font-sans text-sm text-(--el-text-strong)"
          >
            <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger)" />
            <span>
              <strong className="block font-semibold">{t('unreadableTitle')}</strong>
              {t('unreadableBody')}
            </span>
          </div>
        ) : null}

        {preview.status === 'ready' && !unreadable ? (
          <>
            <EffectList preview={preview.preview} />
            <SkyCallout>{t('afterwards')}</SkyCallout>
            <p className="font-sans text-xs text-(--el-text-secondary)">
              {t('countedAt', { time: time.clock(preview.countedAt) })}
            </p>
          </>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onClick={onClose} disabled={pending} autoFocus>
          {t('cancel')}
        </Button>
        {unreadable ? (
          <Button
            variant="secondary"
            leftIcon={<RotateCw aria-hidden className="h-4 w-4" />}
            onClick={onRetry}
          >
            {t('retry')}
          </Button>
        ) : (
          <Button
            variant="danger"
            leftIcon={pending ? undefined : <Ban aria-hidden className="h-4 w-4" />}
            loading={pending}
            disabled={preview.status !== 'ready'}
            onClick={onConfirm}
          >
            {pending ? t('confirming') : t('confirm')}
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
}

/** The effect lines, count first; a zero line stays, in secondary ink. */
function EffectList({ preview }: { preview: OrgFleetStopPreviewDTO }) {
  const t = useTranslations('settings.organization.fleet.stopAll');
  const format = useFormatter();
  const containers = preview.ciContainers ?? 0;
  const lines: { key: string; count: number | null; text: ReactNode; kept?: boolean }[] = [
    {
      key: 'ci',
      count: preview.ciRuns,
      text:
        preview.ciRuns === null
          ? t('ciUnknownRuns')
          : t.rich('ci', { runs: preview.ciRuns, containers, strong }),
    },
    {
      key: 'hosted',
      count: preview.hostedRuns,
      text: t('hosted', { count: preview.hostedRuns ?? 0 }),
    },
    {
      key: 'agents',
      count: preview.runningAgents,
      text: t('agents', { count: preview.runningAgents ?? 0 }),
    },
    {
      key: 'index',
      count: preview.indexContainers,
      text: t('index', { count: preview.indexContainers ?? 0 }),
      kept: true,
    },
  ];
  return (
    <ul className="flex flex-col gap-1" data-testid="stop-all-effects">
      {lines.map((line) => {
        const quiet =
          line.kept ||
          (line.key === 'ci' ? (line.count ?? 0) === 0 && containers === 0 : line.count === 0);
        return (
          <li
            key={line.key}
            data-testid={`stop-all-effect-${line.key}`}
            className={
              line.kept
                ? 'flex items-baseline gap-2 rounded-(--radius-control) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-sm text-(--el-text-secondary)'
                : quiet
                  ? 'flex items-baseline gap-2 font-sans text-sm text-(--el-text-secondary)'
                  : 'flex items-baseline gap-2 font-sans text-sm text-(--el-text)'
            }
          >
            <span className="min-w-6 text-right font-semibold tabular-nums">
              {line.count === null ? '—' : format.number(line.count)}
            </span>
            <span>{line.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

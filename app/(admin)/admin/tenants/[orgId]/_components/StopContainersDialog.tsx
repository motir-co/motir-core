'use client';

import { useId, useRef, useState, useTransition, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Ban, CircleCheck, Info, RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import type { FleetStopPreviewDTO, FleetStopResultDTO } from '@/lib/dto/platformFleetStop';
import { previewStopAction, stopContainersAction } from '../actions';

/**
 * STOP CONTAINERS — the Fleet card's foot, its confirmation and its result
 * (MOTIR-7320 · design `tenant--stop-containers.mock.html` S2–S4).
 *
 * ⚠️ THIS ISLAND DECIDES NOTHING ABOUT WHO MAY STOP. `canStop` comes from the
 * server-rendered card; the action re-asserts `superadmin` and the service once
 * more. The island collects a reason, shows the preview it was handed, and holds
 * the RESULT — which is written on the card, never in a toast, because a partial
 * failure has to stay readable until the operator has read it (design S4 k/l).
 *
 * ⚠️ THE PAGE STATE CONTRACT. The tiles, the verdict chip, the last-stop row and
 * the action log are SERVER-rendered; the action's `revalidatePath` re-reads them.
 * The result is this island's own state and the refresh does not remount it, so
 * it survives the re-read and sits above the after-state tiles.
 *
 * ⚠️ NO STOP WITHOUT A PREVIEW. If the counts could not be read the primary is
 * REPLACED by Try again (S3 g) — nobody confirms against counts nobody read.
 */
export interface StopContainersDialogProps {
  orgId: string;
  orgName: string;
  /** Server-decided: `superadmin` and something chargeable is running. */
  canStop: boolean;
  /** The foot's one-line slot — explainer, role reason, nothing-to-stop or last stop. */
  footNote: ReactNode;
  /** The slot's id, which the disabled button is described by. */
  footNoteId: string;
}

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; preview: FleetStopPreviewDTO; countedAt: string };

export function StopContainersDialog({
  orgId,
  orgName,
  canStop,
  footNote,
  footNoteId,
}: StopContainersDialogProps) {
  const t = useTranslations('platformAdmin.tenant.fleet');
  const format = useFormatter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<FleetStopResultDTO | null>(null);
  const [isPending, startTransition] = useTransition();
  // A Try again while an older preview is in flight must not be clobbered by it.
  const previewSeq = useRef(0);
  const reasonFieldId = useId();

  async function loadPreview() {
    const seq = ++previewSeq.current;
    setPreview({ status: 'loading' });
    const answer = await previewStopAction(orgId);
    if (seq !== previewSeq.current) return;
    setPreview(
      answer.ok
        ? { status: 'ready', preview: answer.preview, countedAt: answer.countedAt }
        : { status: 'failed' },
    );
  }

  function openDialog() {
    setOpen(true);
    setReason('');
    setReasonError(undefined);
    void loadPreview();
  }

  function close() {
    // Escape, the corner ×, Cancel — all refused while a stop is under way:
    // closing would not undo it, so the dialog does not pretend it can (S3 j).
    if (isPending) return;
    previewSeq.current += 1;
    setOpen(false);
    setPreview({ status: 'idle' });
    setReason('');
    setReasonError(undefined);
  }

  function submit() {
    const trimmed = reason.trim();
    // The client gate is courtesy; the service's reason policy is the rule.
    if (!trimmed || preview.status !== 'ready') return;
    startTransition(async () => {
      const answer = await stopContainersAction(orgId, trimmed);
      if (answer.ok) {
        setResult(answer.result);
        setOpen(false);
        setPreview({ status: 'idle' });
        setReason('');
        return;
      }
      if (answer.code === 'REASON_REQUIRED') {
        setReasonError(t('confirm.reasonRequired'));
        return;
      }
      setOpen(false);
      setPreview({ status: 'idle' });
      if (answer.code === 'NOT_PERMITTED') {
        toast({
          variant: 'error',
          title: t('error.notPermittedTitle'),
          description: t('error.notPermittedBody'),
        });
      } else if (answer.code === 'NOT_FOUND') {
        toast({
          variant: 'error',
          title: t('error.notFoundTitle'),
          description: t('error.notFoundBody'),
        });
      } else {
        // NOT "nothing happened": three stop paths, not one transaction.
        toast({
          variant: 'error',
          title: t('error.failedTitle'),
          description: t('error.failedBody'),
        });
      }
    });
  }

  return (
    <>
      {result ? <StopResult result={result} /> : null}
      <div className="mt-4 flex flex-wrap items-start justify-between gap-3 border-t border-(--el-border) pt-4">
        <div className="min-w-0 flex-1">{footNote}</div>
        <Button
          variant="secondary"
          leftIcon={<Ban aria-hidden className="h-4 w-4" />}
          disabled={!canStop}
          aria-describedby={canStop ? undefined : footNoteId}
          onClick={openDialog}
        >
          {t('stop.button')}
        </Button>
      </div>

      <Modal
        open={open}
        onOpenChange={(next) => (next ? undefined : close())}
        role="alertdialog"
        title={t('confirm.title', { org: orgName })}
        description={preview.status === 'failed' ? undefined : t('confirm.lead', { org: orgName })}
        hideClose={isPending}
        size="md"
      >
        <Modal.Body className="gap-4">
          {preview.status === 'loading' || preview.status === 'idle' ? (
            <div className="flex flex-col gap-2" aria-busy="true">
              <span className="h-3.5 w-3/4 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
              <span className="h-3.5 w-1/2 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
              <span className="h-3.5 w-3/5 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
              <span aria-live="polite" className="font-sans text-xs text-(--el-text-secondary)">
                {t('confirm.loading')}
              </span>
            </div>
          ) : null}

          {preview.status === 'failed' ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-rose) p-(--spacing-card-padding) font-sans text-sm text-(--el-text-strong)"
            >
              <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger)" />
              <span>
                <strong className="block font-semibold">{t('confirm.previewFailedTitle')}</strong>
                {t('confirm.previewFailedBody')}
              </span>
            </div>
          ) : null}

          {preview.status === 'ready' ? (
            <>
              <EffectList preview={preview.preview} />
              <div className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) p-(--spacing-card-padding) font-sans text-sm text-(--el-text-strong)">
                <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-info)" />
                <span>
                  {t.rich('confirm.notSuspension', {
                    org: orgName,
                    strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
                  })}
                </span>
              </div>
              <p className="font-sans text-xs text-(--el-text-secondary)">
                {t('confirm.asOf', {
                  time: format.dateTime(new Date(preview.countedAt), { timeStyle: 'short' }),
                })}
              </p>
              <Input
                id={reasonFieldId}
                label={t('confirm.reasonLabel')}
                placeholder={t('confirm.reasonPlaceholder')}
                helperText={reasonError ? undefined : t('confirm.reasonHint')}
                error={reasonError}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  setReasonError(undefined);
                }}
                readOnly={isPending}
                autoFocus
                maxLength={280}
              />
            </>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onClick={close} disabled={isPending}>
            {t('confirm.cancel')}
          </Button>
          {preview.status === 'failed' ? (
            <Button
              variant="secondary"
              leftIcon={<RotateCw aria-hidden className="h-4 w-4" />}
              onClick={() => void loadPreview()}
            >
              {t('confirm.retry')}
            </Button>
          ) : (
            <Button
              variant="danger"
              leftIcon={<Ban aria-hidden className="h-4 w-4" />}
              onClick={submit}
              loading={isPending}
              disabled={preview.status !== 'ready' || reason.trim().length === 0}
            >
              {isPending ? t('confirm.submitting') : t('confirm.submit')}
            </Button>
          )}
        </Modal.Footer>
      </Modal>
    </>
  );
}

/** The three effect lines — count first, zeros kept in secondary ink (S3 e). */
function EffectList({ preview }: { preview: FleetStopPreviewDTO }) {
  const t = useTranslations('platformAdmin.tenant.fleet.confirm');
  const format = useFormatter();
  const strong = (chunks: ReactNode) => <strong className="font-semibold">{chunks}</strong>;
  const lines: { key: string; count: number | null; text: ReactNode }[] = [
    {
      key: 'ci',
      count: preview.ciRuns,
      text:
        preview.ciRuns === null
          ? t.rich('ciUnknown', { containers: preview.ciContainers, strong })
          : t.rich('ci', { runs: preview.ciRuns, containers: preview.ciContainers, strong }),
    },
    { key: 'hosted', count: preview.hostedRuns, text: t('hosted', { count: preview.hostedRuns }) },
    {
      key: 'instances',
      count: preview.agentInstances,
      text: t('instances', { count: preview.agentInstances }),
    },
  ];
  return (
    <ul className="flex flex-col gap-1" data-testid="stop-effects">
      {lines.map((line) => {
        // A zero line is present but not an effect — CI counts BOTH numbers.
        const quiet =
          line.key === 'ci'
            ? (line.count ?? 0) === 0 && preview.ciContainers === 0
            : line.count === 0;
        return (
          <li
            key={line.key}
            data-testid={`stop-effect-${line.key}`}
            className={
              quiet
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

/** The result, on the card (S4 k done · l partial, one line per workload). */
function StopResult({ result }: { result: FleetStopResultDTO }) {
  const t = useTranslations('platformAdmin.tenant.fleet.result');
  const { failures } = result;
  const partial = failures.ci > 0 || failures.hosted > 0 || failures.instances > 0;
  const failLine = (count: number) =>
    count > 0 ? <span className="block text-xs">{t('failed', { count })}</span> : null;
  return (
    <div
      role="status"
      data-testid="stop-result"
      data-partial={partial ? 'true' : 'false'}
      className={
        partial
          ? 'mt-4 rounded-(--radius-card) bg-(--el-tint-yellow) p-(--spacing-card-padding) font-sans text-sm text-(--el-text-strong)'
          : 'mt-4 rounded-(--radius-card) bg-(--el-tint-mint) p-(--spacing-card-padding) font-sans text-sm text-(--el-text-strong)'
      }
    >
      <p className="flex items-center gap-1.5 font-semibold">
        {partial ? (
          <TriangleAlert aria-hidden className="h-4 w-4 text-(--el-warning)" />
        ) : (
          <CircleCheck aria-hidden className="h-4 w-4 text-(--el-success)" />
        )}
        {partial ? t('partialTitle') : t('doneTitle')}
      </p>
      <ul className="mt-2 flex flex-col gap-1">
        {partial ? (
          <>
            <li data-testid="stop-result-ci">
              {t('ciPartial', {
                runs: result.runsCancelled,
                stopped: result.ciContainersStopped,
                total: result.ciContainersStopped + failures.ci,
              })}
              {failLine(failures.ci)}
            </li>
            <li data-testid="stop-result-hosted">
              {t('hostedPartial', { ended: result.hostedRunsEnded })}
              {failLine(failures.hosted)}
            </li>
            <li data-testid="stop-result-instances">
              {t('instancesPartial', {
                hibernated: result.agentInstancesHibernated,
                total: result.agentInstancesHibernated + failures.instances,
              })}
              {failLine(failures.instances)}
            </li>
          </>
        ) : (
          <>
            <li data-testid="stop-result-ci">
              {t('ci', { runs: result.runsCancelled, stopped: result.ciContainersStopped })}
            </li>
            <li data-testid="stop-result-hosted">
              {t('hosted', { ended: result.hostedRunsEnded })}
            </li>
            <li data-testid="stop-result-instances">
              {t('instances', { hibernated: result.agentInstancesHibernated })}
            </li>
          </>
        )}
      </ul>
    </div>
  );
}

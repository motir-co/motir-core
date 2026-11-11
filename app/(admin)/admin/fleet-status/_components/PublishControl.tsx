'use client';

import { useEffect, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CircleAlert, RotateCw, Upload } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import type { FleetImageKey } from '@/lib/dto/fleetStatusImages';
import {
  fleetImagePublishEndedAction,
  publishFleetImageAction,
  type FleetImagePublishActionResult,
} from '../actions';

/**
 * The Publish row of one Fleet status image card, its Confirm dialog and the
 * follow-up of the run it starts (MOTIR-10886; design MOTIR-10885 Panels 4–6).
 *
 * ⚠️ THIS ISLAND OWNS A DIALOG AND A POLL, NEVER A STATE. Whether the row is
 * behind, what it would publish and where the last press stands are the
 * server-rendered props. A dispatch re-reads the page; while a run is going the
 * island asks the server every {@link POLL_MS} whether it has ended, and re-reads
 * the page once it has.
 */

export const POLL_MS = 15_000;

export interface PublishConfirm {
  title: string;
  from: string;
  to: string;
  body: ReactNode;
  confirmLabel: string;
  audited: string;
}

export interface PublishControlProps {
  image: FleetImageKey;
  /** `enabled` / `disabled`: the note and Publish latest. `running`: the band and
   *  a loading button. `failed`: the band and Retry. `done`: the band, then the
   *  disabled row. */
  mode: 'enabled' | 'disabled' | 'running' | 'failed' | 'done';
  note: string;
  band: ReactNode;
  confirm: PublishConfirm | null;
  /** The run to follow while `running`. */
  poll: { runId: number; target: string } | null;
}

export function PublishControl({ image, mode, note, band, confirm, poll }: PublishControlProps) {
  const t = useTranslations('platformAdmin.fleetStatus');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<FleetImagePublishActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (mode !== 'running' || !poll) return;
    let stopped = false;
    const timer = setInterval(() => {
      void fleetImagePublishEndedAction(image, poll.runId, poll.target).then((result) => {
        if (!stopped && result.ended) {
          stopped = true;
          clearInterval(timer);
          router.refresh();
        }
      });
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [image, mode, poll, router]);

  function close() {
    setOpen(false);
    setAnswer(null);
  }

  function submit() {
    setAnswer(null);
    startTransition(async () => {
      const result = await publishFleetImageAction(image);
      if (result.outcome === 'dispatched') {
        close();
        router.refresh();
        return;
      }
      setAnswer(result);
    });
  }

  const publishButton = (
    <Button
      variant="primary"
      leftIcon={<Upload className="h-4 w-4" />}
      disabled={mode !== 'enabled' || !confirm}
      onClick={() => setOpen(true)}
      className="w-full sm:w-auto"
    >
      {t('publish.button')}
    </Button>
  );

  return (
    <div className="flex flex-col gap-3" data-publish={mode}>
      {band}
      {mode === 'running' ? (
        <div className="flex justify-end">
          <Button variant="primary" loading disabled aria-busy="true" className="w-full sm:w-auto">
            {t('progress.button')}
          </Button>
        </div>
      ) : mode === 'failed' ? (
        <div className="flex justify-end">
          <Button
            variant="secondary"
            leftIcon={<RotateCw className="h-4 w-4" />}
            disabled={!confirm}
            onClick={() => setOpen(true)}
            className="w-full sm:w-auto"
          >
            {t('failed.retry')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">{note}</p>
          {publishButton}
        </div>
      )}

      {confirm ? (
        <Modal
          open={open}
          onOpenChange={(next) => (next ? setOpen(true) : close())}
          title={confirm.title}
          size="md"
        >
          <Modal.Body className="gap-4">
            <dl className="grid grid-cols-[4rem_1fr] gap-x-3 gap-y-2 font-sans text-sm">
              <dt className="text-(--el-text-secondary)">{t('confirm.from')}</dt>
              <dd className="break-all font-mono text-(--el-text)">{confirm.from}</dd>
              <dt className="text-(--el-text-secondary)">{t('confirm.to')}</dt>
              <dd className="break-all font-mono text-(--el-text)">{confirm.to}</dd>
            </dl>
            <div
              data-tone="info"
              className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-sm text-(--el-text-strong)"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span>{confirm.body}</span>
              </div>
            </div>
            {answer ? <PublishAnswer answer={answer} /> : null}
            <p className="font-sans text-xs text-(--el-text-secondary)">{confirm.audited}</p>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" onClick={close} disabled={pending}>
              {t('confirm.cancel')}
            </Button>
            <Button
              variant="primary"
              leftIcon={<Upload className="h-4 w-4" />}
              onClick={submit}
              loading={pending}
            >
              {confirm.confirmLabel}
            </Button>
          </Modal.Footer>
        </Modal>
      ) : null}
    </div>
  );
}

/** Why a press started nothing — inside the dialog, which stays open. */
function PublishAnswer({ answer }: { answer: FleetImagePublishActionResult }) {
  const t = useTranslations('platformAdmin.fleetStatus.publishError');
  const message =
    answer.outcome === 'refused'
      ? t(answer.reason)
      : answer.outcome === 'not_permitted'
        ? t('notPermitted')
        : answer.outcome === 'failed'
          ? t('failed')
          : null;
  return (
    <div
      role="alert"
      data-tone="danger"
      data-testid="fleet-publish-answer"
      className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-rose) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-sm text-(--el-text-strong)"
    >
      <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger)" />
      <div className="flex min-w-0 flex-col gap-1">
        <span>
          <strong className="font-semibold">{t('title')}</strong> {message}
        </span>
        {answer.outcome === 'failed' ? (
          <code className="block whitespace-pre-wrap break-all rounded-(--radius-control) bg-(--el-page-bg) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-mono text-xs text-(--el-text)">
            {answer.detail}
          </code>
        ) : null}
      </div>
    </div>
  );
}

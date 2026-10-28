'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { replayDeadLetterAction } from '../actions';

/**
 * Row Replay button — operator only. While the action runs the button is busy;
 * on `replayed` / `already-replayed` the list re-reads and the row moves to
 * replayed; on a failure the row stays unreplayed with an inline line, and a
 * toast says which answer came back.
 */
export function RowReplayButton({ dlqId, functionId }: { dlqId: string; functionId: string }) {
  const t = useTranslations('platformAdmin');
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);
  const errorId = `replay-error-${dlqId}`;

  const replay = () => {
    setFailed(false);
    startTransition(async () => {
      const result = await replayDeadLetterAction(dlqId);
      if (result.ok) {
        if (result.outcome === 'replayed') {
          toast({
            variant: 'success',
            title: t('jobs.toast.replayedTitle'),
            description: t('jobs.toast.replayedBody', { function: functionId }),
          });
        } else {
          toast({
            variant: 'info',
            title: t('jobs.toast.alreadyTitle'),
            description: t('jobs.toast.alreadyBody'),
          });
        }
        router.refresh();
        return;
      }
      if (result.code === 'NOT_FOUND') {
        toast({
          variant: 'info',
          title: t('jobs.toast.alreadyTitle'),
          description: t('jobs.toast.notFoundBody'),
        });
        router.refresh();
        return;
      }
      setFailed(true);
      toast({
        variant: 'error',
        title: t('jobs.toast.failedTitle'),
        description:
          result.code === 'NOT_PERMITTED'
            ? t('jobs.toast.notPermittedBody')
            : t('jobs.toast.failedBody'),
      });
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="secondary"
        size="sm"
        leftIcon={<RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />}
        loading={pending}
        aria-label={t('jobs.replayAria', { function: functionId })}
        aria-describedby={failed ? errorId : undefined}
        onClick={replay}
      >
        {t('jobs.replay')}
      </Button>
      {failed ? (
        <span id={errorId} className="font-sans text-xs text-(--el-danger-on-surface)">
          {t('jobs.toast.failedTitle')}
        </span>
      ) : null}
    </div>
  );
}

'use client';

import { useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Info, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import type { ReplayAllResultDTO } from '@/lib/dto/jobs';
import { replayAllDeadLettersAction } from '../actions';

type Phase =
  | { step: 'closed' }
  | { step: 'confirm' }
  | { step: 'running' }
  | { step: 'result'; result: ReplayAllResultDTO }
  | { step: 'error' };

/**
 * Replay all button + Replay all confirm + Replay result — operator only, and
 * only rendered for ONE chosen function with waiting dead letters.
 *
 * Replay all is ONE server call that works through the function's dead letters
 * 50 at a time, so the running dialog cannot be dismissed (Esc, outside click
 * and Cancel are all held) and shows no per-row progress. `count` comes from
 * the page's read and is advisory: the action enumerates again.
 *
 * Done closes the dialog and re-reads the page, so the list and the filter
 * counts follow the replay.
 */
export function ReplayAllControl({ functionId, count }: { functionId: string; count: number }) {
  const t = useTranslations('platformAdmin');
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ step: 'closed' });
  const running = useRef(false);

  const open = phase.step !== 'closed';
  const close = () => {
    if (running.current) return;
    const settled = phase.step === 'result' || phase.step === 'error';
    setPhase({ step: 'closed' });
    if (settled) router.refresh();
  };

  const run = async () => {
    running.current = true;
    setPhase({ step: 'running' });
    try {
      const answer = await replayAllDeadLettersAction(functionId);
      setPhase(answer.ok ? { step: 'result', result: answer.result } : { step: 'error' });
    } catch {
      setPhase({ step: 'error' });
    } finally {
      running.current = false;
    }
  };

  const title =
    phase.step === 'result'
      ? phase.result.failed.length > 0
        ? t('jobs.replayAll.doneWithFailuresTitle')
        : t('jobs.replayAll.doneTitle')
      : t('jobs.replayAll.title', { count, function: functionId });

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setPhase({ step: 'confirm' })}>
        {t('jobs.replayAll.button', { count })}
      </Button>
      <Modal
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        role="alertdialog"
        title={title}
        hideClose={phase.step === 'running'}
      >
        {phase.step === 'confirm' || phase.step === 'running' ? (
          <>
            <p className="font-sans text-sm text-(--el-text-secondary)">
              {t('jobs.replayAll.body')}
            </p>
            {phase.step === 'running' ? (
              <p role="status" className="mt-3 font-sans text-sm text-(--el-text)">
                {t('jobs.replayAll.runningLine', { count })}
              </p>
            ) : null}
            <Modal.Footer>
              <Button variant="ghost" disabled={phase.step === 'running'} onClick={close}>
                {t('jobs.replayAll.cancel')}
              </Button>
              <Button variant="primary" loading={phase.step === 'running'} onClick={run}>
                {phase.step === 'running'
                  ? t('jobs.replayAll.running')
                  : t('jobs.replayAll.confirm', { count })}
              </Button>
            </Modal.Footer>
          </>
        ) : null}
        {phase.step === 'result' ? (
          <>
            <Modal.Body>
              <ResultLines result={phase.result} />
            </Modal.Body>
            <Modal.Footer>
              <Button variant="primary" autoFocus onClick={close}>
                {t('jobs.replayAll.close')}
              </Button>
            </Modal.Footer>
          </>
        ) : null}
        {phase.step === 'error' ? (
          <>
            <p role="status" className="flex items-start gap-2 font-sans text-sm text-(--el-text)">
              <XCircle
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger-on-surface)"
              />
              {t('jobs.replayAll.error')}
            </p>
            <Modal.Footer>
              <Button variant="primary" autoFocus onClick={close}>
                {t('jobs.replayAll.close')}
              </Button>
            </Modal.Footer>
          </>
        ) : null}
      </Modal>
    </>
  );
}

function ResultLines({ result }: { result: ReplayAllResultDTO }) {
  const t = useTranslations('platformAdmin');
  const lines: { key: string; icon: ReactNode; text: string }[] = [];
  if (result.replayed === 0 && result.alreadyReplayed > 0 && result.failed.length === 0) {
    lines.push({
      key: 'nothing',
      icon: <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-(--el-info)" />,
      text: t('jobs.replayAll.nothingLeft', { count: result.alreadyReplayed }),
    });
  } else {
    lines.push({
      key: 'replayed',
      icon: (
        <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-(--el-success)" />
      ),
      text: t('jobs.replayAll.replayed', { count: result.replayed }),
    });
    if (result.alreadyReplayed > 0) {
      lines.push({
        key: 'already',
        icon: <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-(--el-info)" />,
        text: t('jobs.replayAll.already', { count: result.alreadyReplayed }),
      });
    }
  }
  if (result.failed.length > 0) {
    lines.push({
      key: 'failed',
      icon: (
        <XCircle
          aria-hidden="true"
          className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger-on-surface)"
        />
      ),
      text: t('jobs.replayAll.failed', { count: result.failed.length }),
    });
  }
  return (
    <ul role="status" className="flex flex-col gap-2">
      {lines.map((line) => (
        <li key={line.key} className="flex items-start gap-2 font-sans text-sm text-(--el-text)">
          {line.icon}
          <span>{line.text}</span>
        </li>
      ))}
    </ul>
  );
}

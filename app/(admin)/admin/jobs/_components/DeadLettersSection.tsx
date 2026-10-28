import { useTranslations } from 'next-intl';
import { EmptyState } from '@/components/ui/EmptyState';
import type { PlatformDlqListDTO } from '@/lib/dto/jobs';
import { DeadLettersTable } from './DeadLettersTable';
import { FunctionFilter } from './FunctionFilter';
import { ReadOnlyNotice } from './ReadOnlyNotice';
import { ReplayAllControl } from './ReplayAllControl';

/**
 * The Dead letters tab's body: the Read-only notice (support), the Function
 * filter with its waiting line, Replay all (operator, one function chosen, with
 * dead letters waiting), and the table or its empty state.
 *
 * `fn` is the function the page resolved: `null` for All functions, including a
 * `?fn=` the read no longer lists (the page falls back before it reads).
 * `replayAllCount` is the operator's count for that function, `null` otherwise.
 */
export function DeadLettersSection({
  list,
  fn,
  canReplay,
  replayAllCount,
  now,
}: {
  list: PlatformDlqListDTO;
  fn: string | null;
  canReplay: boolean;
  replayAllCount: number | null;
  now: Date;
}) {
  const t = useTranslations('platformAdmin');
  const waiting = fn
    ? (list.functions.find((f) => f.functionId === fn)?.unreplayed ?? 0)
    : list.unreplayedTotal;
  // The read caps the waiting rows at the newest 200; more waiting than drawn
  // can only mean the cap held.
  const shown = list.rows.filter((row) => row.replayedAt === null).length;
  return (
    <div className="flex flex-col gap-3">
      {canReplay ? null : <ReadOnlyNotice />}
      <div className="flex flex-wrap items-center gap-3">
        <FunctionFilter functions={list.functions} total={list.unreplayedTotal} value={fn} />
        <p className="font-sans text-xs text-(--el-text-secondary)">
          {t('jobs.waitingLine', { waiting, replayed: list.replayedRecently })}
        </p>
        {canReplay && fn !== null && replayAllCount !== null && replayAllCount > 0 ? (
          <div className="ml-auto">
            <ReplayAllControl functionId={fn} count={replayAllCount} />
          </div>
        ) : null}
      </div>
      {list.rows.length === 0 ? (
        <EmptyState title={t('jobs.dlqEmpty.title')} description={t('jobs.dlqEmpty.body')} />
      ) : (
        <>
          <DeadLettersTable rows={list.rows} canReplay={canReplay} now={now} />
          {waiting > shown ? (
            <p className="font-sans text-xs text-(--el-text-secondary)">
              {t('jobs.capped', { shown, count: waiting })}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

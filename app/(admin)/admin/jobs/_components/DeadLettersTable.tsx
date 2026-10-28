import { useFormatter, useTranslations } from 'next-intl';
import { Pill } from '@/components/ui/Pill';
import type { JobRunDlqDTO } from '@/lib/dto/jobs';
import { cn } from '@/lib/utils/cn';
import { TableShell, Td, Th, Tr } from './LedgerTable';
import { RowReplayButton } from './RowReplayButton';
import { WorkspaceCell } from './WorkspaceCell';

export function useDlqColumns(): string[] {
  const t = useTranslations('platformAdmin');
  return [
    t('jobs.columns.functionEvent'),
    t('jobs.columns.workspace'),
    t('jobs.columns.failure'),
    t('jobs.columns.attempts'),
    t('jobs.columns.lastFailed'),
    t('jobs.columns.replay'),
  ];
}

/**
 * Dead letters table — the waiting dead letters, workspace and workspace-less
 * together, newest failure first, then the ones replayed in the last 7 days,
 * which turn secondary and show _Replayed {time}_ in place of the button. The
 * order is the read service's; this table only draws it.
 *
 * `canReplay` is presentation: support gets no button, and the action and the
 * service refuse below operator whatever this draws.
 */
export function DeadLettersTable({
  rows,
  canReplay,
  now,
}: {
  rows: JobRunDlqDTO[];
  canReplay: boolean;
  now: Date;
}) {
  const t = useTranslations('platformAdmin');
  const format = useFormatter();
  const columns = useDlqColumns();
  return (
    <TableShell
      caption={t('jobs.dlqCaption')}
      head={columns.map((column, i) => (
        <Th
          key={column}
          srOnly={i === columns.length - 1}
          className={i === 3 || i === columns.length - 1 ? 'text-right' : undefined}
        >
          {column}
        </Th>
      ))}
    >
      {rows.map((row) => {
        const replayed = row.replayedAt !== null;
        return (
          <Tr key={row.id} className={cn(replayed && '[&_td]:text-(--el-text-secondary)')}>
            <Td title={row.functionId}>
              <span className="block max-w-[16rem] truncate font-mono text-xs">
                {row.functionId}
              </span>
              <span
                title={row.eventName}
                className="block max-w-[16rem] truncate text-xs text-(--el-text-secondary)"
              >
                {row.eventName}
              </span>
            </Td>
            <Td>
              <WorkspaceCell workspaceId={row.workspaceId} />
            </Td>
            <Td title={row.failure.message}>
              <span className="block max-w-[18rem] truncate">{row.failure.message}</span>
            </Td>
            <Td className="text-right tabular-nums">{row.attempts}</Td>
            <Td className="whitespace-nowrap text-(--el-text-secondary)">
              <time dateTime={row.lastFailedAt}>
                {format.relativeTime(new Date(row.lastFailedAt), now)}
              </time>
            </Td>
            <Td className="text-right whitespace-nowrap">
              {row.replayedAt !== null ? (
                <Pill tone="neutral">
                  {t('jobs.replayedAt', {
                    time: format.relativeTime(new Date(row.replayedAt), now),
                  })}
                </Pill>
              ) : canReplay ? (
                <RowReplayButton dlqId={row.id} functionId={row.functionId} />
              ) : null}
            </Td>
          </Tr>
        );
      })}
    </TableShell>
  );
}

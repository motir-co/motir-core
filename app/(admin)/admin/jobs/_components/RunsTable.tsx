import { useFormatter, useTranslations } from 'next-intl';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import type { JobRunDTO, JobRunStatus } from '@/lib/dto/jobs';
import { TableShell, Td, Th, Tr } from './LedgerTable';
import { WorkspaceCell } from './WorkspaceCell';

/**
 * `abandoned` is `warning`, not `danger` and not `info`: nothing came back from
 * the run, so there is no error to show and nobody is working on it (the
 * workspace ledger's rule, MOTIR-3683).
 */
const STATUS_SEVERITY = {
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
  abandoned: 'warning',
} as const satisfies Record<JobRunStatus, 'info' | 'success' | 'danger' | 'warning'>;

export function useRunColumns(): string[] {
  const t = useTranslations('platformAdmin');
  return [
    t('jobs.columns.function'),
    t('jobs.columns.event'),
    t('jobs.columns.workspace'),
    t('jobs.columns.status'),
    t('jobs.columns.attempt'),
    t('jobs.columns.started'),
    t('jobs.columns.duration'),
  ];
}

/**
 * Runs table — every run the platform recorded, in every workspace and in none,
 * newest first. An empty page renders the drawn empty state for All or for the
 * chosen status.
 */
export function RunsTable({
  rows,
  status,
  now,
}: {
  rows: JobRunDTO[];
  status?: JobRunStatus;
  now: Date;
}) {
  const t = useTranslations('platformAdmin');
  const format = useFormatter();
  const columns = useRunColumns();

  if (rows.length === 0) {
    return status ? (
      <EmptyState
        title={t('jobs.runsEmpty.titleStatus')}
        description={t('jobs.runsEmpty.bodyStatus')}
      />
    ) : (
      <EmptyState title={t('jobs.runsEmpty.titleAll')} description={t('jobs.runsEmpty.bodyAll')} />
    );
  }

  const duration = (ms: number | null) => {
    if (ms === null) return '—';
    if (ms < 1000)
      return format.number(ms, { style: 'unit', unit: 'millisecond', unitDisplay: 'narrow' });
    if (ms < 60_000) {
      return format.number(ms / 1000, {
        style: 'unit',
        unit: 'second',
        unitDisplay: 'narrow',
        maximumFractionDigits: 1,
      });
    }
    return format.number(ms / 60_000, {
      style: 'unit',
      unit: 'minute',
      unitDisplay: 'narrow',
      maximumFractionDigits: 1,
    });
  };

  return (
    <TableShell
      caption={t('jobs.runsCaption')}
      head={columns.map((column, i) => (
        <Th key={column} className={i >= 4 && i !== 5 ? 'text-right' : undefined}>
          {column}
        </Th>
      ))}
    >
      {rows.map((run) => (
        <Tr key={run.id}>
          <Td title={run.functionId}>
            <span className="block max-w-[16rem] truncate font-mono text-xs">{run.functionId}</span>
          </Td>
          <Td title={run.eventName} className="text-(--el-text-secondary)">
            <span className="block max-w-[14rem] truncate">{run.eventName}</span>
          </Td>
          <Td>
            <WorkspaceCell workspaceId={run.workspaceId} />
          </Td>
          <Td>
            <Pill severity={STATUS_SEVERITY[run.status]}>{t(`jobs.status.${run.status}`)}</Pill>
          </Td>
          <Td className="text-right tabular-nums">{run.attempt}</Td>
          <Td className="whitespace-nowrap text-(--el-text-secondary)">
            <time dateTime={run.startedAt}>
              {format.relativeTime(new Date(run.startedAt), now)}
            </time>
          </Td>
          <Td className="text-right whitespace-nowrap tabular-nums">{duration(run.durationMs)}</Td>
        </Tr>
      ))}
    </TableShell>
  );
}

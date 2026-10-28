import { useTranslations } from 'next-intl';
import { JobsFrame } from './_components/JobsFrame';
import { TableSkeleton } from './_components/LedgerTable';
import { useRunColumns } from './_components/RunsTable';

/**
 * Loading — the table header over four skeleton rows, `aria-busy`, inside the
 * page's own header and tabs so the shell stays put while the server reads.
 */
export default function AdminJobsLoading() {
  const t = useTranslations('platformAdmin');
  const columns = useRunColumns();
  return (
    <JobsFrame tab="runs" waiting={null}>
      <TableSkeleton
        caption={t('jobs.runsCaption')}
        label={t('jobs.loadingRuns')}
        columns={columns}
      />
    </JobsFrame>
  );
}

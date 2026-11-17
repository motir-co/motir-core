import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ChevronLeft } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { MotirAiError, PlannerFindingRecordNotFoundError } from '@/lib/ai/errors';
import type { PlannerFindingRecordDTO } from '@/lib/dto/plannerFindings';
import { platformRoleAtLeast } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import {
  plannerFindingRecordsConsoleService,
  type PlannerFindingRecordView,
} from '@/lib/services/plannerFindingRecordsConsoleService';
import {
  PLANNER_FINDING_NO_PLAN_ID,
  PLANNER_FINDING_RECORDS_LEVEL,
  PLANNER_FINDING_RECORDS_READ_LEVEL,
} from '@/lib/services/plannerFindingsService';
import { VerdictChip } from '../../_components/FindingChips';
import { FindingsUnavailable } from '../../_components/FindingsUnavailable';
import { RecordCommand } from '../../_components/RecordCommand';
import { RecordFindingsTable } from '../../_components/RecordFindingsTable';
import { RunThroughBlock } from '../../_components/RunThroughBlock';

/**
 * One planner finding RECORD — the record page, design MOTIR-11470 Panels 9–11
 * with the run-through block (MOTIR-11509) and each finding's planning-bug key
 * (MOTIR-11591); Story MOTIR-11455, card MOTIR-11463.
 *
 * In order: the back link; the plan-context header; the run-through block; the
 * record's findings with each row's key; and — on an OPEN record only — the
 * copyable `motir check planner finding <id>` command.
 *
 * ⚠️ ONE READ. Plan context, answer, verdict state, findings and their keys all
 * come from the single record read; nothing here reads them again. A key write's
 * revalidation is a fresh render, so it reads once too.
 * ⚠️ THE READ DECIDES EXISTENCE, so it runs in the page body before anything
 * streams and there is no skeleton: an id the store does not hold, and a
 * principal below the read's level, are the app's 404 through `notFound()`; an
 * unreadable store is the unavailable state with Retry — never the 404.
 * ⚠️ DISPLAY ONLY, but for one write: a finding's own key, from its row, at
 * operator or above on an attributed record. Nothing sets the verdict or the
 * answer, and no check is re-run from here.
 */

export const metadata: Metadata = { title: 'Planner finding record' };

export const dynamic = 'force-dynamic';

export default async function AdminPlannerFindingRecordPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const principal = await requirePlatformStaffPage(PLANNER_FINDING_RECORDS_READ_LEVEL);
  const { id } = await params;
  const t = await getTranslations('platformAdmin.plannerFindings');

  let view: PlannerFindingRecordView;
  try {
    view = await plannerFindingRecordsConsoleService.get(principal, id);
  } catch (err) {
    if (err instanceof PlannerFindingRecordNotFoundError) notFound();
    if (err instanceof NotPlatformStaffError) notFound();
    if (!(err instanceof MotirAiError)) throw err;
    console.error('[admin] planner finding record could not be read', { id }, err);
    return (
      <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
        <BackLink label={t('record.back')} />
        <FindingsUnavailable copy="records" />
      </div>
    );
  }

  const { record, findings } = view.detail;
  const attributed = record.verdictState === 'attributed';
  const canWrite = attributed && platformRoleAtLeast(principal.role, PLANNER_FINDING_RECORDS_LEVEL);

  return (
    <section
      aria-label={t('record.title')}
      data-testid="planner-finding-record"
      className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6"
    >
      <p className="font-sans text-xs uppercase tracking-wide text-(--el-text-secondary)">
        {t('record.crumb')}
      </p>
      <BackLink label={t('record.back')} />
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="font-serif text-2xl text-(--el-text)">{t('record.title')}</h1>
        <span className="font-mono text-sm break-all text-(--el-text-identifier)">{record.id}</span>
      </header>
      <PlanContext record={record} verdictByName={view.verdictByName} />
      <RunThroughBlock
        runThroughAnswer={record.runThroughAnswer}
        runThroughStopCards={record.runThroughStopCards}
      />
      <RecordFindingsTable findings={findings} attributed={attributed} canWrite={canWrite} />
      {record.verdictState === 'open' ? (
        <Card>
          <RecordCommand recordId={record.id} />
        </Card>
      ) : null}
    </section>
  );
}

function BackLink({ label }: { label: string }) {
  return (
    <Link
      href="/admin/planner-findings?view=records"
      className="inline-flex min-h-11 w-fit items-center gap-1 font-sans text-xs text-(--el-link) hover:underline md:min-h-0"
    >
      <ChevronLeft aria-hidden className="h-3.5 w-3.5" />
      {label}
    </Link>
  );
}

function present(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value : null;
}

/**
 * The PLAN-CONTEXT header — design MOTIR-11470 § Elements: one labelled group of
 * label/value pairs in a fixed order. A null field is a quiet em dash with a
 * hidden "None", so the field set never changes shape. The verdict chip carries
 * its by and at only when attributed.
 */
async function PlanContext({
  record,
  verdictByName,
}: {
  record: PlannerFindingRecordDTO;
  verdictByName: string | null;
}) {
  const t = await getTranslations('platformAdmin.plannerFindings');
  const format = await getFormatter();
  const none = (
    <>
      <span aria-hidden className="text-(--el-text-secondary)">
        —
      </span>
      <span className="sr-only">{t('record.field.none')}</span>
    </>
  );
  const mono = (value: string | null) =>
    present(value) ? (
      <code className="font-mono text-xs break-all text-(--el-text-identifier)">{value}</code>
    ) : (
      none
    );
  const noPlan = !record.planId || record.planId === PLANNER_FINDING_NO_PLAN_ID;
  const verdictLabel = t.has(`records.verdict.${record.verdictState}` as 'records.verdict.open')
    ? t(`records.verdict.${record.verdictState}` as 'records.verdict.open')
    : record.verdictState;
  const baseline = [present(record.baselineBranch), present(record.baselineCommit)?.slice(0, 12)]
    .filter((part): part is string => !!part)
    .map((part) => (
      <code key={part} className="font-mono text-xs break-all text-(--el-text-identifier)">
        {part}
      </code>
    ));

  const rows: [string, React.ReactNode][] = [
    [
      t('record.field.plan'),
      noPlan ? (
        <span className="text-(--el-text-secondary)">{t('row.noPlan')}</span>
      ) : (
        <span className="flex flex-col gap-0.5">
          <span className="text-(--el-text)">{record.planTitle ?? t('row.untitledPlan')}</span>
          {mono(record.planId)}
        </span>
      ),
    ],
    [t('record.field.planSession'), mono(record.planSessionId)],
    [t('record.field.job'), mono(record.jobId)],
    [t('record.field.model'), mono(record.authorModel)],
    [
      t('record.field.baseline'),
      baseline.length === 0 ? (
        none
      ) : (
        <span className="flex flex-wrap items-center gap-1">
          {baseline.flatMap((part, i) =>
            i === 0
              ? [part]
              : [
                  <span key={`sep-${i}`} aria-hidden className="text-(--el-text-secondary)">
                    ·
                  </span>,
                  part,
                ],
          )}
        </span>
      ),
    ],
    [
      t('record.field.verdict'),
      <span key="verdict" className="flex flex-col items-start gap-1">
        <VerdictChip state={record.verdictState} label={verdictLabel} />
        {record.verdictState === 'attributed' && record.verdictAt ? (
          <span data-testid="record-verdict-by" className="text-xs text-(--el-text-secondary)">
            {t('record.verdictBy', {
              who: verdictByName ?? '—',
              when: format.dateTime(new Date(record.verdictAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
            })}
          </span>
        ) : null}
      </span>,
    ],
  ];

  return (
    <Card data-testid="record-plan-context">
      <div role="group" aria-label={t('record.context')}>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 font-sans text-sm md:grid-cols-[9.5rem_1fr]">
          {rows.map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-xs text-(--el-text-secondary) md:pt-0.5">{name}</dt>
              <dd className="text-(--el-text)">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Card>
  );
}

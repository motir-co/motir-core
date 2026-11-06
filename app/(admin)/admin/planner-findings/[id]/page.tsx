import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { BookOpen, ChevronLeft } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { MotirAiError, PlannerFindingNotFoundError } from '@/lib/ai/errors';
import type { PlannerFindingDetailDTO } from '@/lib/dto/plannerFindings';
import { platformRoleAtLeast } from '@/lib/platform/auth';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import {
  PLANNER_FINDING_NO_PLAN_ID,
  plannerFindingsService,
  type PlannerFindingDetailView,
} from '@/lib/services/plannerFindingsService';
import { TriageChip } from '../_components/FindingChips';
import { FindingCostStrip } from '../_components/FindingCostStrip';
import { FindingsUnavailable } from '../_components/FindingsUnavailable';
import { FindingTriageControls } from '../_components/FindingTriageControls';
import { findingLabel, type FindingLabelGroup } from '../_components/findingLabels';

/**
 * One PLANNER FINDING — design MOTIR-10362 Panels 9 and 11 (the full-page form
 * the design draws below md), Story MOTIR-10353, card MOTIR-10524.
 *
 * ⚠️ THE READ DECIDES EXISTENCE, so it runs in the page body before anything
 * streams and there is no `<Suspense>` above it: a finding motir-ai does not
 * have is the app's 404 with a real 404 status (the boundary rule).
 * ⚠️ AN UNREADABLE motir-ai IS THE UNAVAILABLE STATE, never a partial detail.
 *
 * Nothing is looked up in motir-core: the plan is the id and title motir-ai
 * stored, so a finding whose plan was deleted still opens. The triage STATE is
 * shown here read-only; the controls that change it sit beneath the header and
 * render none of it.
 */

export const metadata: Metadata = { title: 'Planner finding' };

export const dynamic = 'force-dynamic';

type Translator = Parameters<typeof findingLabel>[0];

export default async function AdminPlannerFindingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const principal = await requirePlatformStaffPage('support');
  const { id } = await params;
  const t = await getTranslations('platformAdmin.plannerFindings');

  let view: PlannerFindingDetailView;
  try {
    view = await plannerFindingsService.get(principal, id);
  } catch (err) {
    if (err instanceof PlannerFindingNotFoundError) notFound();
    if (!(err instanceof MotirAiError)) throw err;
    console.error('[admin] planner finding could not be read', { id }, err);
    return (
      <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
        <BackLink label={t('detail.back')} />
        <FindingsUnavailable />
      </div>
    );
  }

  const { detail, triagedByName } = view;
  const label = (group: FindingLabelGroup, value: string) =>
    findingLabel(t as unknown as Translator, group, value);
  const status =
    detail.status === 'filed_as_bug' && detail.bugKey
      ? t('status.bugWithKey', { key: detail.bugKey })
      : label('status', detail.status);

  return (
    <section
      aria-label={t('a11y.detailRegion')}
      data-testid="planner-finding-detail"
      className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6"
    >
      <BackLink label={t('detail.back')} />
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-xl break-all text-(--el-text)">{detail.site}</h1>
          <TriageChip status={detail.status} label={status} />
        </div>
        <TriageState detail={detail} triagedByName={triagedByName} />
      </header>
      {/* Below operator the controls render nothing: the writes need operator (MOTIR-10525). */}
      <FindingTriageControls
        detail={detail}
        canTriage={platformRoleAtLeast(principal.role, 'operator')}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Narrative detail={detail} />
        <div className="flex flex-col gap-4">
          <Provenance detail={detail} />
          <Cells detail={detail} />
          <FindingCostStrip cost={detail.cost} source={detail.source} />
        </div>
      </div>
    </section>
  );
}

function BackLink({ label }: { label: string }) {
  return (
    <Link
      href="/admin/planner-findings"
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

/** The read-only triage state: the lesson link, the dismiss note, who triaged it last. */
async function TriageState({
  detail,
  triagedByName,
}: {
  detail: PlannerFindingDetailDTO;
  triagedByName: string | null;
}) {
  const t = await getTranslations('platformAdmin.plannerFindings');
  const format = await getFormatter();
  const note = present(detail.triageNote);
  return (
    <div className="flex flex-col gap-1 font-sans text-sm">
      {detail.lessonId ? (
        <Link
          data-testid="planner-finding-lesson-link"
          href={`/admin/planning-lessons/${encodeURIComponent(detail.lessonId)}`}
          className="inline-flex w-fit items-center gap-1 text-(--el-link) hover:underline"
        >
          <BookOpen aria-hidden className="h-3.5 w-3.5" />
          {t('detail.lessonLink')}
        </Link>
      ) : null}
      {note ? (
        <blockquote
          data-testid="planner-finding-triage-note"
          className="border-l-2 border-(--el-border) pl-3 text-(--el-text-secondary)"
        >
          {`“${note}”`}
        </blockquote>
      ) : null}
      {detail.triagedAt ? (
        <p className="text-xs text-(--el-text-secondary)">
          {t('detail.triagedBy', {
            who: triagedByName ?? '—',
            when: format.dateTime(new Date(detail.triagedAt), {
              dateStyle: 'medium',
              timeStyle: 'short',
            }),
          })}
        </p>
      ) : null}
    </div>
  );
}

async function Narrative({ detail }: { detail: PlannerFindingDetailDTO }) {
  const t = await getTranslations('platformAdmin.plannerFindings.detail');
  const blocks: [string, string | null, boolean][] = [
    [t('what'), present(detail.whatHappened), false],
    [t('evidence'), present(detail.evidence), true],
    [t('correction'), present(detail.correction), false],
    [t('fixDirection'), present(detail.fixDirection), false],
    [t('why'), present(detail.why), false],
  ];
  return (
    <Card>
      <div className="flex flex-col gap-4 font-sans text-sm">
        {blocks.map(([heading, text, mono]) => (
          <div key={heading} className="flex flex-col gap-1">
            <h2 className="text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)">
              {heading}
            </h2>
            {text === null ? (
              <p className="text-(--el-text-secondary)">{t('none')}</p>
            ) : mono ? (
              <pre className="overflow-x-auto rounded-(--radius-control) bg-(--el-surface) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-mono text-xs whitespace-pre-wrap text-(--el-text-secondary)">
                {text}
              </pre>
            ) : (
              <p className="whitespace-pre-wrap text-(--el-text)">{text}</p>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

async function Provenance({ detail }: { detail: PlannerFindingDetailDTO }) {
  const t = await getTranslations('platformAdmin.plannerFindings');
  const format = await getFormatter();
  const label = (group: FindingLabelGroup, value: string) =>
    findingLabel(t as unknown as Translator, group, value);
  const mono = (value: string) => (
    <span className="font-mono text-xs break-all text-(--el-text-identifier)">{value}</span>
  );
  const prediction = t.has(`prediction.${detail.prediction}` as 'prediction.STOPS')
    ? t(`prediction.${detail.prediction}` as 'prediction.STOPS')
    : detail.prediction;
  const noPlan = !detail.planId || detail.planId === PLANNER_FINDING_NO_PLAN_ID;

  const rows: [string, React.ReactNode][] = [
    [t('detail.site'), mono(detail.site)],
    [t('detail.prediction'), prediction],
    [t('detail.source'), label('source', detail.source)],
    [t('detail.planner'), label('planner', detail.planner)],
    [t('detail.outcome'), label('outcome', detail.outcome)],
    [t('detail.attribution'), label('attribution', detail.attribution)],
    [
      t('detail.plan'),
      noPlan ? (
        t('row.noPlan')
      ) : (
        <span className="flex flex-col gap-0.5">
          <span>{detail.planTitle ?? t('row.untitledPlan')}</span>
          <span className="text-xs text-(--el-text-secondary)">
            {t('detail.planId')} {mono(detail.planId)}
          </span>
        </span>
      ),
    ],
  ];
  if (present(detail.cardRef)) rows.push([t('detail.workItem'), mono(detail.cardRef!)]);
  if (present(detail.authorModel)) rows.push([t('detail.authorModel'), detail.authorModel!]);
  const baseline = [
    present(detail.baselineBranch),
    present(detail.baselineCommit)?.slice(0, 12) ?? null,
  ].filter((part): part is string => part !== null);
  if (baseline.length > 0) rows.push([t('detail.baseline'), mono(baseline.join(' @ '))]);
  rows.push([
    t('detail.recorded'),
    format.dateTime(new Date(detail.createdAt), { dateStyle: 'medium', timeStyle: 'short' }),
  ]);

  return (
    <Card
      data-testid="planner-finding-provenance"
      header={
        <h2 className="font-sans text-sm font-semibold text-(--el-text)">
          {t('detail.provenance')}
        </h2>
      }
    >
      <dl className="flex flex-col gap-2 font-sans text-sm">
        {rows.map(([name, value]) => (
          <div key={name} className="flex flex-col gap-0.5">
            <dt className="text-xs text-(--el-text-secondary)">{name}</dt>
            <dd className="text-(--el-text)">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

async function Cells({ detail }: { detail: PlannerFindingDetailDTO }) {
  const t = await getTranslations('platformAdmin.plannerFindings.detail');
  const cells: [string, string][] = [];
  const hosted = present(detail.hostedCell);
  const planpy = present(detail.planpyCell);
  if (hosted) cells.push([t('cellHosted'), hosted]);
  if (planpy) cells.push([t('cellPlanpy'), planpy]);
  return (
    <Card
      data-testid="planner-finding-cells"
      header={
        <h2 className="font-sans text-sm font-semibold text-(--el-text)">{t('cellsTitle')}</h2>
      }
    >
      {cells.length === 0 ? (
        <p className="font-sans text-sm text-(--el-text-secondary)">{t('noCells')}</p>
      ) : (
        <dl className="flex flex-col gap-2 font-sans text-sm">
          {cells.map(([name, cell]) => (
            <div key={name} className="flex flex-col gap-0.5">
              <dt className="text-xs text-(--el-text-secondary)">{name}</dt>
              <dd className="font-mono text-xs break-all text-(--el-text-identifier)">{cell}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

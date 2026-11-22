'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, History, Route, Scale, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { MarkdownView } from '@/components/ui/MarkdownView';
import type {
  RunDiscrepancyEntryDto,
  WorkItemRunDiscrepancyRecordDto,
} from '@/lib/dto/runDiscrepancy';
import { runsHref } from '@/lib/runs/runsAddress';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import { ContentSectionCard } from './ContentSectionCard';
import { RUN_DISCREPANCY_SECTION_ID } from './decisionAnchor';

// THE RUN DISCREPANCY SECTION (Task MOTIR-11996), built to `design/runs/design-notes.md`
// § _Run discrepancy — the record gets its own section on the work item page_ (MOTIR-11995)
// and its mock `design/runs/run-section--discrepancy-record.mock.html`, panels 0–9.
//
// A run's `record_run_discrepancy` record — what it built differently from the plan
// (points) and what it decided where the plan was silent (decisions) — read from
// `run_discrepancy_record` / `run_discrepancy_entry`. The record is the only place it is
// written now, so this is how a person reads it. Read-only: no edit, delete or reply.
//
// ⚠️ NO RECORD, NO SECTION (decision 2): the component renders `null` for an empty list.
//
// ⚠️ COLLAPSED BY DEFAULT (Revision 1): a record can be very long, so the section starts as
// one summary row on every visit, and the open state is not remembered. ARRIVING AT
// `#run-discrepancy` — the run modal's findings door (decision 4) — opens it, because that
// reader asked to read the record; the late stack streams in after the browser looked for
// the fragment, so the section lands itself on mount, as `PagesSection` does.
//
// Several records (decision 8): newest first and open, older ones folded to a row each.
// Many entries (decision 9): each group shows its first {@link VISIBLE_ENTRIES}.

/** One record as the section draws it: the DTO plus its times, formatted on the server. */
export interface RunDiscrepancyRecordView extends WorkItemRunDiscrepancyRecordDto {
  recordedAtLabel: string;
  /** The run's `startedAt`, formatted; null when the record is not part of a run. */
  runStartedAtLabel: string | null;
}

/** Entries shown per group before the rest fold behind _Show N more_ (decision 9). */
export const VISIBLE_ENTRIES = 3;

type Kind = 'point' | 'decision';
type T = ReturnType<typeof useTranslations<'issueViews.runDiscrepancy'>>;

function Chip({ kind, n }: { kind: Kind; n: number }) {
  const t = useTranslations('issueViews.runDiscrepancy');
  return (
    <span
      className={`inline-flex items-center rounded-(--radius-badge) px-(--spacing-chip-x-6) py-(--spacing-chip-y) font-sans text-xs font-medium text-(--el-text-strong) ${
        kind === 'point' ? 'bg-(--el-tint-sky)' : 'bg-(--el-tint-lavender)'
      }`}
    >
      {kind === 'point' ? t('pointLabel', { n }) : t('decisionLabel', { n })}
    </span>
  );
}

/** A label and its text. Side by side from `sm` up; the label above its text at phone width. */
function Field({
  label,
  value,
  workItemRefs,
}: {
  label: string;
  value: string;
  workItemRefs: WorkItemRefMap;
}) {
  return (
    <div className="flex flex-col gap-0.5 sm:grid sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-3">
      <dt className="font-sans text-sm font-medium text-(--el-text-secondary)">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">
        <MarkdownView
          value={value}
          workItemRefs={workItemRefs}
          className="text-sm text-(--el-text)"
        />
      </dd>
    </div>
  );
}

function EntryBlock({
  kind,
  entry,
  workItemRefs,
}: {
  kind: Kind;
  entry: RunDiscrepancyEntryDto;
  workItemRefs: WorkItemRefMap;
}) {
  const t = useTranslations('issueViews.runDiscrepancy');
  return (
    <li
      data-testid={`run-discrepancy-${kind}`}
      className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border-soft) p-(--spacing-card-padding-12)"
    >
      <div>
        <Chip kind={kind} n={entry.position} />
      </div>
      <dl className="flex flex-col gap-2">
        <Field
          label={kind === 'point' ? t('planAsked') : t('planSaid')}
          value={entry.planText}
          workItemRefs={workItemRefs}
        />
        <Field
          label={kind === 'point' ? t('built') : t('chose')}
          value={entry.outcomeText}
          workItemRefs={workItemRefs}
        />
        <Field label={t('why')} value={entry.why} workItemRefs={workItemRefs} />
        {kind === 'decision' && entry.alternatives !== null ? (
          <Field label={t('alternatives')} value={entry.alternatives} workItemRefs={workItemRefs} />
        ) : null}
      </dl>
    </li>
  );
}

function Group({
  kind,
  entries,
  workItemRefs,
}: {
  kind: Kind;
  entries: readonly RunDiscrepancyEntryDto[];
  workItemRefs: WorkItemRefMap;
}) {
  const t = useTranslations('issueViews.runDiscrepancy');
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? entries : entries.slice(0, VISIBLE_ENTRIES);
  const hidden = entries.length - shown.length;
  const Icon = kind === 'point' ? Route : Scale;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="flex flex-wrap items-center gap-2 font-sans text-sm font-semibold text-(--el-text)">
          <Icon className="size-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
          {kind === 'point' ? t('pointsHeading') : t('decisionsHeading')}
          <span className="font-normal text-(--el-text-secondary)">
            ·{' '}
            {kind === 'point'
              ? t('pointsCount', { count: entries.length })
              : t('decisionsCount', { count: entries.length })}
          </span>
        </h3>
        <p className="font-sans text-xs text-(--el-text-secondary)">
          {kind === 'point' ? t('pointsGloss') : t('decisionsGloss')}
        </p>
      </div>
      <ol className="flex flex-col gap-2">
        {shown.map((entry) => (
          <EntryBlock key={entry.position} kind={kind} entry={entry} workItemRefs={workItemRefs} />
        ))}
      </ol>
      {entries.length > VISIBLE_ENTRIES ? (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
            leftIcon={
              <ChevronDown className={`size-3.5${expanded ? ' rotate-180' : ''}`} aria-hidden />
            }
          >
            {expanded
              ? t('showFewer')
              : kind === 'point'
                ? t('showMorePoints', { count: hidden })
                : t('showMoreDecisions', { count: hidden })}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** _Recorded {time} by {name}_ — or _by a former member_ once the account is gone. */
function recordedLine(t: T, record: RunDiscrepancyRecordView): string {
  const time = record.recordedAtLabel;
  return record.recordedByName !== null
    ? t('recordedBy', { time, name: record.recordedByName })
    : t('recordedByFormer', { time });
}

function Provenance({ record }: { record: RunDiscrepancyRecordView }) {
  const t = useTranslations('issueViews.runDiscrepancy');
  // The Visitor tree renders this body too (MOTIR-6888): the run's address is the reader's.
  const routes = useReaderRoutes();
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-sans text-sm text-(--el-text-secondary)">
      <span>{recordedLine(t, record)}</span>
      <span aria-hidden>·</span>
      {record.run && record.runStartedAtLabel !== null ? (
        <a
          href={routes.view(runsHref({ run: record.run.id }))}
          aria-label={t('inRunAria', { time: record.runStartedAtLabel })}
          className="font-medium text-(--el-link) underline underline-offset-2 hover:text-(--el-link-pressed)"
        >
          {t('inRun', { time: record.runStartedAtLabel })}
        </a>
      ) : (
        <span>{t('noRun')}</span>
      )}
    </p>
  );
}

function RecordBody({ record }: { record: RunDiscrepancyRecordView }) {
  const t = useTranslations('issueViews.runDiscrepancy');
  return (
    <div className="flex flex-col gap-3">
      <Provenance record={record} />
      {record.source === 'backfilled' ? (
        <p className="flex items-start gap-1.5 font-sans text-xs text-(--el-text-secondary)">
          <History className="mt-px size-3.5 shrink-0" aria-hidden />
          {t('backfilled')}
        </p>
      ) : null}
      {record.source === 'backfill_unreadable' ? (
        <div
          data-testid="run-discrepancy-unreadable"
          className="flex items-start gap-2 rounded-(--radius-card) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) p-(--spacing-card-padding-12)"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-(--el-warning)" aria-hidden />
          <div className="flex flex-col gap-0.5">
            <p className="font-sans text-sm font-medium text-(--el-text)">{t('unreadableTitle')}</p>
            <p className="font-sans text-sm text-(--el-text-secondary)">
              {t('unreadableBody', {
                points: record.pointCount,
                decisions: record.decisionCount,
              })}
            </p>
          </div>
        </div>
      ) : null}
      {record.points.length > 0 ? (
        <Group kind="point" entries={record.points} workItemRefs={record.workItemRefs} />
      ) : null}
      {record.decisions.length > 0 ? (
        <Group kind="decision" entries={record.decisions} workItemRefs={record.workItemRefs} />
      ) : null}
    </div>
  );
}

/** _2 points · 1 decision_ — the non-zero counts, or `''` when there are none. */
function countsLine(t: T, points: number, decisions: number): string {
  return [
    points > 0 ? t('pointsCount', { count: points }) : null,
    decisions > 0 ? t('decisionsCount', { count: decisions }) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

/** An older record, folded to one row that opens in place (decision 8). */
function FoldedRecord({ record }: { record: RunDiscrepancyRecordView }) {
  const t = useTranslations('issueViews.runDiscrepancy');
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? t('hideRecord') : t('showRecord')}
        onClick={() => setOpen((was) => !was)}
        className="flex w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x-4) py-(--spacing-control-y-4) text-left hover:bg-(--el-surface-soft) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <Chevron className="size-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
        <span className="min-w-0 flex-1 font-sans text-sm text-(--el-text)">
          {recordedLine(t, record)}
        </span>
        <span className="shrink-0 font-sans text-sm text-(--el-text-secondary)">
          {countsLine(t, record.pointCount, record.decisionCount)}
        </span>
      </button>
      {open ? (
        <div className="pl-6">
          <RecordBody record={record} />
        </div>
      ) : null}
    </div>
  );
}

/** The collapsed section's summary: totals of every readable record, then the newest's who and when. */
function summaryOf(
  t: T,
  records: readonly RunDiscrepancyRecordView[],
): {
  totals: string;
  latest: string;
} {
  const newest = records[0]!;
  const points = records.reduce((n, r) => n + r.points.length, 0);
  const decisions = records.reduce((n, r) => n + r.decisions.length, 0);
  const one = records.length === 1;
  const time = newest.recordedAtLabel;
  const latest =
    newest.recordedByName !== null
      ? t(one ? 'summaryOne' : 'summaryLatest', { time, name: newest.recordedByName })
      : t(one ? 'summaryOneFormer' : 'summaryLatestFormer', { time });
  return { totals: countsLine(t, points, decisions) || t('summaryNoEntries'), latest };
}

const BODY_ID = `${RUN_DISCREPANCY_SECTION_ID}-body`;

export function RunDiscrepancySection({
  records,
}: {
  /** The card's records, newest first. */
  records: readonly RunDiscrepancyRecordView[];
}) {
  const t = useTranslations('issueViews.runDiscrepancy');
  const [open, setOpen] = useState(false);

  // Landing on `#run-discrepancy` — on arrival, or from an in-page link later — opens the
  // section, scrolls it into view and gives it focus (`ContentSectionCard`'s `id` makes it
  // focusable and draws the ring).
  useEffect(() => {
    const land = () => {
      if (window.location.hash !== `#${RUN_DISCREPANCY_SECTION_ID}`) return;
      setOpen(true);
      const el = document.getElementById(RUN_DISCREPANCY_SECTION_ID);
      el?.scrollIntoView({ block: 'start' });
      el?.focus({ preventScroll: true });
    };
    land();
    window.addEventListener('hashchange', land);
    return () => window.removeEventListener('hashchange', land);
  }, []);

  if (records.length === 0) return null;
  const [newest, ...older] = records as [RunDiscrepancyRecordView, ...RunDiscrepancyRecordView[]];
  const { totals, latest } = summaryOf(t, records);

  return (
    <ContentSectionCard
      id={RUN_DISCREPANCY_SECTION_ID}
      title={t('title')}
      subtitle={t('gloss')}
      headerExtra={
        records.length > 1 ? (
          <Pill tone="neutral">{t('recordCount', { count: records.length })}</Pill>
        ) : undefined
      }
      headerRight={
        open ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded
            aria-controls={BODY_ID}
            onClick={() => setOpen(false)}
            leftIcon={<ChevronDown className="size-3.5 rotate-180" aria-hidden />}
          >
            {t('hide')}
          </Button>
        ) : undefined
      }
    >
      {open ? (
        <div id={BODY_ID} className="flex flex-col gap-4">
          <RecordBody record={newest} />
          {older.length > 0 ? (
            <ul className="flex flex-col gap-2 border-t border-(--el-border-soft) pt-3">
              {older.map((record) => (
                <li key={record.id}>
                  <FoldedRecord record={record} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          aria-expanded={false}
          aria-controls={BODY_ID}
          onClick={() => setOpen(true)}
          className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-(--radius-control) px-(--spacing-control-x-4) py-(--spacing-control-y-4) text-left hover:bg-(--el-surface-soft) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          <ChevronRight className="size-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
          <span className="font-sans text-sm font-medium text-(--el-text)">{totals}</span>
          <span className="font-sans text-sm text-(--el-text-secondary)">· {latest}</span>
          <span className="ml-auto font-sans text-sm font-medium text-(--el-accent-on-surface)">
            {t('show')}
          </span>
        </button>
      )}
    </ContentSectionCard>
  );
}

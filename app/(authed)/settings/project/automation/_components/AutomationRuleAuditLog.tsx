'use client';

import { useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Link2,
  ListChecks,
  MinusCircle,
  TriangleAlert,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import type {
  AutomationExecutionDto,
  AutomationExecutionPageDto,
  AutomationExecutionStatusDto,
} from '@/lib/dto/automationRules';
import { useRelativeTime } from '@/lib/hooks/useRelativeTime';

// The per-rule audit log (Story 6.6 · Subtask 6.6.6), per
// design/projects/automation.mock.html panel 5: a paginated, newest-first view
// of a rule's execution history. Each row renders ONLY what the 6.6.2 engine
// persisted — status (Success/Failure/No actions), the triggering item (a link,
// or a tombstone when the item was since-deleted), the duration, and the
// relative time; a failure row expands to the typed error (the mock's richer
// per-step action detail is NOT backed by stored data, so it is intentionally
// omitted — the data-limit rule). Reads one bounded page at a time (finding
// #57, no load-all) through the 6.6.6 executions route; the 90-day retention
// note states the cron-swept window.

export interface AutomationRuleAuditLogProps {
  projectKey: string;
  ruleId: string;
  ruleName: string;
  onBack: () => void;
}

export function AutomationRuleAuditLog({
  projectKey,
  ruleId,
  ruleName,
  onBack,
}: AutomationRuleAuditLogProps) {
  const t = useTranslations('settings.automation.log');

  // `loadState` is initialised to 'loading' via useState (never set
  // synchronously in the effect body — the React-19 set-state-in-effect lint
  // rule); the async callbacks flip it to 'ready' / 'error'. A `requestId` ref
  // discards a stale page's late response (the page changed under it).
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AutomationExecutionPageDto | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const requestId = useRef(0);

  useEffect(() => {
    const id = ++requestId.current;
    const base = `/api/projects/${encodeURIComponent(projectKey)}/automation-rules/${encodeURIComponent(
      ruleId,
    )}/executions`;
    void fetch(`${base}?page=${page}`)
      .then((res) =>
        res.ok ? (res.json() as Promise<AutomationExecutionPageDto>) : Promise.reject(res.status),
      )
      .then((next) => {
        if (id !== requestId.current) return;
        setData(next);
        setLoadState('ready');
      })
      .catch(() => {
        if (id === requestId.current) setLoadState('error');
      });
  }, [projectKey, ruleId, page]);

  function goToPage(next: number) {
    setLoadState('loading');
    setPage(next);
  }

  const error = loadState === 'error';
  const loading = loadState === 'loading';
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex w-fit items-center gap-1.5 rounded-(--radius-control) text-sm font-medium text-(--el-link) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t('back')}
      </button>

      <Card
        header={
          <div className="flex items-center gap-2">
            <ListChecks className="size-4 shrink-0 text-(--el-text-muted)" aria-hidden />
            <h2 className="min-w-0 truncate font-serif text-lg font-semibold text-(--el-text)">
              {t('title', { ruleName })}
            </h2>
          </div>
        }
        footer={
          data && data.total > 0 ? (
            <LogFooter
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              totalPages={totalPages}
              onPage={goToPage}
            />
          ) : undefined
        }
      >
        {error ? (
          <p
            role="alert"
            className="flex items-center gap-2 rounded-(--radius-card) bg-(--el-tint-rose) p-(--spacing-card-padding) font-sans text-sm text-(--el-text-strong)"
          >
            <TriangleAlert className="size-4 shrink-0 text-(--el-danger)" aria-hidden />
            {t('loadError')}
          </p>
        ) : loading && !data ? (
          <LogSkeleton />
        ) : data && data.executions.length === 0 ? (
          <EmptyState
            title={t('empty.title')}
            description={t('empty.description')}
            icon={<ListChecks className="h-12 w-12" aria-hidden />}
          />
        ) : data ? (
          <ul role="list" className="flex flex-col">
            {data.executions.map((execution) => (
              <ExecutionRow key={execution.id} execution={execution} />
            ))}
          </ul>
        ) : null}

        <p className="mt-(--spacing-md) flex items-center gap-1.5 font-sans text-xs text-(--el-text-muted)">
          <Clock className="size-3.5 shrink-0" aria-hidden />
          {t('retention')}
        </p>
      </Card>
    </div>
  );
}

function StatusPill({ status }: { status: AutomationExecutionStatusDto }) {
  const t = useTranslations('settings.automation.log');
  const label = t(`status.${status}`);
  // Success → mint, Failure → rose (both via Pill `severity`); No actions and
  // Held by a plan → the neutral chip (Pill `tone`) — neither is a failure. The hue lives in the tint background with
  // `--el-text-strong` text (AA, finding #35) — Pill's contract.
  if (status === 'success') {
    return (
      <Pill severity="success">
        <CheckCircle2 className="size-3.5" aria-hidden />
        {label}
      </Pill>
    );
  }
  if (status === 'failure') {
    return (
      <Pill severity="danger">
        <TriangleAlert className="size-3.5" aria-hidden />
        {label}
      </Pill>
    );
  }
  return (
    <Pill tone="neutral">
      <MinusCircle className="size-3.5" aria-hidden />
      {label}
    </Pill>
  );
}

function ExecutionRow({ execution }: { execution: AutomationExecutionDto }) {
  const t = useTranslations('settings.automation.log');
  const format = useFormatter();
  const relativeTime = useRelativeTime();
  const [expanded, setExpanded] = useState(false);

  const createdAt = new Date(execution.createdAt);
  const isFailure = execution.status === 'failure' && execution.error != null;

  return (
    <li
      data-testid={`execution-row-${execution.id}`}
      className="flex flex-col border-b border-(--el-border-soft) py-3 last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <StatusPill status={execution.status} />

        {execution.triggerItem ? (
          <Link
            href={`/items/${execution.triggerItem.key}`}
            aria-label={t('viewItemAria', { key: execution.triggerItem.key })}
            className="inline-flex items-center gap-1 font-sans text-sm font-medium text-(--el-link) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            {execution.triggerItem.key}
            <Link2 className="size-3.5" aria-hidden />
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1 font-sans text-sm text-(--el-text-secondary) line-through">
            {t('tombstone')}
          </span>
        )}

        {execution.status === 'no_actions' ? (
          <span className="font-sans text-xs text-(--el-text-muted)">{t('conditionNotMet')}</span>
        ) : null}
        {execution.status === 'plan_held' ? (
          <span className="font-sans text-xs text-(--el-text-muted)">{t('planHeldNote')}</span>
        ) : null}
        {execution.status === 'org_closing' ? (
          <span className="font-sans text-xs text-(--el-text-muted)">{t('orgClosingNote')}</span>
        ) : null}
        {execution.status === 'held_by_mark' ? (
          <span className="font-sans text-xs text-(--el-text-muted)">{t('heldByMarkNote')}</span>
        ) : null}

        <span className="ml-auto flex items-center gap-3">
          {execution.durationMs != null ? (
            <span className="inline-flex items-center gap-1 font-sans text-xs text-(--el-text-muted)">
              <Clock className="size-3.5 shrink-0" aria-hidden />
              {t('durationMs', { ms: execution.durationMs })}
            </span>
          ) : null}
          <span
            className="font-sans text-xs text-(--el-text-muted)"
            title={format.dateTime(createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
          >
            {relativeTime(createdAt)}
          </span>
          {isFailure ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={t('expandFailureAria')}
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex size-6 items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              {expanded ? (
                <ChevronUp className="size-4" aria-hidden />
              ) : (
                <ChevronDown className="size-4" aria-hidden />
              )}
            </button>
          ) : null}
        </span>
      </div>

      {isFailure && expanded ? (
        <div className="mt-2 flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-rose) p-(--spacing-card-padding)">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-(--el-danger)" aria-hidden />
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="font-sans text-sm font-medium text-(--el-text-strong)">
              {t('errorHeading')}
            </span>
            <code className="block w-fit max-w-full overflow-x-auto rounded-(--radius-control) bg-(--el-surface) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-mono text-xs text-(--el-text-strong)">
              {execution.error}
            </code>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function LogFooter({
  page,
  pageSize,
  total,
  totalPages,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onPage: (page: number) => void;
}) {
  const t = useTranslations('settings.automation.log');
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="flex items-center justify-between gap-2 text-xs text-(--el-text-muted)">
      <span>{t('showing', { a: from, b: to, total })}</span>
      <span className="flex items-center gap-1">
        <PagerButton label={t('prevPage')} disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="size-4" aria-hidden />
        </PagerButton>
        <span className="px-1 font-sans tabular-nums">{`${page} / ${totalPages}`}</span>
        <PagerButton
          label={t('nextPage')}
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight className="size-4" aria-hidden />
        </PagerButton>
      </span>
    </div>
  );
}

function PagerButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      // The ink pairs with this button's OWN hover fill, `--el-muted`, where
      // muted-on-muted is 4.12:1 — so the control drops below AA exactly when
      // the pointer is on it. `disabled` here is an EXPRESSION, so the 1.4.3
      // exemption does not cover the enabled render (MOTIR-2489). Secondary is
      // 6.18:1 on `--el-muted`.
      className="inline-flex size-7 items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-default disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function LogSkeleton() {
  return (
    <ul role="list" className="flex flex-col" aria-hidden>
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="flex items-center gap-3 border-b border-(--el-border-soft) py-3 last:border-b-0"
        >
          <span className="h-5 w-20 animate-pulse rounded-(--radius-badge) bg-(--el-muted)" />
          <span className="h-4 w-16 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
          <span className="ml-auto h-4 w-24 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
        </li>
      ))}
    </ul>
  );
}

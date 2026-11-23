'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ChevronDown, Lock, Moon, RotateCcw, Search } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Segmented } from '@/components/ui/Segmented';
import { Spinner } from '@/components/ui/Spinner';
import type { ProductionLogLineDto } from '@/lib/dto/productionLogs';
import { LOG_SECRET_MASK } from '@/lib/hosting/logMasking';
import { productionRuntimeClient } from '@/lib/hosting/productionRuntimeClient';
import {
  DEFAULT_LOG_RANGE,
  LOG_RANGES,
  rangeSince,
  type LogRange,
} from '@/lib/hosting/productionRuntimeWords';
import type { HostingTarget } from '@/lib/hosting/vocabulary';
import { ProductionLogLines } from '@/components/hosting/ProductionLogLines';

// The LOGS VIEW (Story MOTIR-9799 · MOTIR-12109; `design/hosting/design-notes.md`
// § Width and panels 2, 8–12): the running release's recent lines, newest first,
// already masked by the route, with a time range, a text filter, Show earlier
// lines and its non-happy states. No scroll box: how far back it reaches is the
// range plus Show earlier lines.
//
// Every read is numbered; a late answer to an older range, filter or page never
// lands over a newer one. The filter is read once typing pauses.

/** How long the filter waits after the last keystroke before it reads. */
export const FILTER_DEBOUNCE_MS = 300;

type View =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'unavailable' }
  | { kind: 'noRelease' }
  | { kind: 'lines'; lines: ProductionLogLineDto[]; cursor: string | null; since: string };

export function ProductionLogsView({
  projectKey,
  repositoryId,
  target,
  hasRelease,
  asleep,
}: {
  projectKey: string;
  repositoryId: string;
  target: HostingTarget | null;
  hasRelease: boolean;
  /** The application is suspended: its lines are the last before it slept. */
  asleep: boolean;
}) {
  const t = useTranslations('settings.production.logs');
  const tTarget = useTranslations('repositorySet.seed.target');
  const [range, setRange] = useState<LogRange>(DEFAULT_LOG_RANGE);
  const [filterInput, setFilterInput] = useState('');
  const [filter, setFilter] = useState('');
  const [attempt, setAttempt] = useState(0);
  // The answer to the read for one query (range · filter · attempt). The view is
  // LOADING whenever the answer held is not for the query now shown, so a new
  // range, filter or Try again shows loading without setting it in an effect,
  // and an answer for an older query can never be drawn as the current one.
  const [answer, setAnswer] = useState<{
    key: string;
    view: Exclude<View, { kind: 'loading' }>;
    loadingMore: boolean;
    moreFailed: boolean;
  } | null>(null);
  const queryKey = `${range}\u0000${filter}\u0000${attempt}`;
  const seq = useRef(0);

  useEffect(() => {
    if (!hasRelease) return;
    const mine = ++seq.current;
    const since = rangeSince(range, new Date());
    void productionRuntimeClient
      .readLogs(projectKey, repositoryId, { since, filter })
      .then((result) => {
        if (mine !== seq.current) return;
        const view: Exclude<View, { kind: 'loading' }> = !result.ok
          ? { kind: 'failed' }
          : result.data.state === 'no_release'
            ? { kind: 'noRelease' }
            : result.data.state === 'unavailable'
              ? { kind: 'unavailable' }
              : { kind: 'lines', lines: result.data.lines, cursor: result.data.cursor, since };
        setAnswer({ key: queryKey, view, loadingMore: false, moreFailed: false });
      });
  }, [hasRelease, projectKey, repositoryId, range, filter, queryKey]);

  useEffect(() => {
    const next = filterInput.trim();
    if (next === filter) return;
    const timer = setTimeout(() => setFilter(next), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filterInput, filter]);

  const current = answer?.key === queryKey ? answer : null;
  const view: View = !hasRelease
    ? { kind: 'noRelease' }
    : current
      ? current.view
      : { kind: 'loading' };
  const loadingMore = current?.loadingMore ?? false;
  const moreFailed = current?.moreFailed ?? false;

  const retry = () => setAttempt((n) => n + 1);

  const readMore = async () => {
    if (!current || current.view.kind !== 'lines' || !current.view.cursor) return;
    const shown = current.view;
    const key = current.key;
    const mine = ++seq.current;
    setAnswer({ ...current, loadingMore: true, moreFailed: false });
    const result = await productionRuntimeClient.readLogs(projectKey, repositoryId, {
      since: shown.since,
      filter,
      cursor: shown.cursor,
    });
    if (mine !== seq.current) return;
    setAnswer((prev) => {
      if (!prev || prev.key !== key || prev.view.kind !== 'lines') return prev;
      if (!result.ok || result.data.state !== 'ok') {
        return { ...prev, loadingMore: false, moreFailed: true };
      }
      return {
        ...prev,
        loadingMore: false,
        view: {
          ...prev.view,
          lines: [...prev.view.lines, ...result.data.lines],
          cursor: result.data.cursor,
        },
      };
    });
  };

  const targetLabel = target ? tTarget(target) : '';
  const toolbarDisabled = view.kind === 'loading' || view.kind === 'unavailable';
  const masked =
    view.kind === 'lines' && view.lines.some((l) => l.message.includes(LOG_SECRET_MASK));

  return (
    <Card data-testid="production-logs">
      <section className="flex flex-col gap-3" aria-labelledby="production-logs-heading">
        <div className="flex items-baseline justify-between gap-3">
          <h2
            id="production-logs-heading"
            className="font-serif text-lg font-semibold text-(--el-text)"
          >
            {t('heading')}
          </h2>
          <span className="font-sans text-xs text-(--el-text-secondary)">{t('order')}</span>
        </div>

        {view.kind === 'noRelease' ? (
          <p className="font-sans text-sm text-(--el-text-secondary)">{t('noRelease')}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <Segmented
                label={t('range.label')}
                options={LOG_RANGES.map((r) => ({ value: r, label: t(`range.${r}`) }))}
                value={range}
                onChange={(r) => setRange(r)}
                disabled={toolbarDisabled}
              />
              <div className="min-w-[12rem] flex-1">
                <Input
                  aria-label={t('filter')}
                  placeholder={t('filter')}
                  value={filterInput}
                  onChange={(e) => setFilterInput(e.target.value)}
                  addonStart={<Search className="size-3.5" aria-hidden />}
                  data-testid="production-logs-filter"
                />
              </div>
            </div>

            {view.kind === 'loading' ? (
              <div aria-busy="true" className="flex flex-col gap-2">
                <span className="flex items-center gap-2 font-sans text-sm text-(--el-text-secondary)">
                  <Spinner size="sm" aria-hidden />
                  {t('loading')}
                </span>
                <div className="flex flex-col gap-2" aria-hidden>
                  {[0, 1, 2, 3].map((i) => (
                    <span
                      key={i}
                      className="h-4 w-full rounded-(--radius-control) bg-(--el-muted)"
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {view.kind === 'unavailable' || view.kind === 'failed' ? (
              <div
                role="alert"
                className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-12)"
                data-testid={`production-logs-${view.kind}`}
              >
                <p className="flex items-start gap-2 font-sans text-sm text-(--el-text)">
                  <AlertTriangle
                    className="mt-0.5 size-4 shrink-0 text-(--el-danger-on-surface)"
                    aria-hidden
                  />
                  <span>
                    {view.kind === 'unavailable'
                      ? t('unavailable', { target: targetLabel })
                      : t('failed')}
                  </span>
                </p>
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    leftIcon={<RotateCcw className="size-3.5" aria-hidden />}
                    onClick={retry}
                  >
                    {t('retry')}
                  </Button>
                </div>
              </div>
            ) : null}

            {view.kind === 'lines' && view.lines.length === 0 ? (
              <p
                className="rounded-(--radius-card) border border-dashed border-(--el-border) px-(--spacing-card-padding-12) py-(--spacing-card-padding-12) text-center font-sans text-sm text-(--el-text-secondary)"
                data-testid="production-logs-empty"
              >
                {filter
                  ? t('noMatch', { filter, range: t(`rangeSpan.${range}`) })
                  : t('empty', { range: t(`rangeSpan.${range}`) })}
              </p>
            ) : null}

            {view.kind === 'lines' && view.lines.length > 0 ? (
              <>
                {asleep ? (
                  <p className="flex items-center gap-1.5 font-sans text-xs text-(--el-text-secondary)">
                    <Moon className="size-3.5 shrink-0" aria-hidden />
                    {t('asleep')}
                  </p>
                ) : null}
                <ProductionLogLines lines={view.lines} />
                {masked ? (
                  <p
                    className="flex items-center gap-1.5 font-sans text-xs text-(--el-text-secondary)"
                    data-testid="production-logs-masked-note"
                  >
                    <Lock className="size-3.5 shrink-0" aria-hidden />
                    {t('masked')}
                  </p>
                ) : null}
                {moreFailed ? (
                  <p role="alert" className="font-sans text-sm text-(--el-text)">
                    {t('moreError')}
                  </p>
                ) : null}
                {view.cursor ? (
                  <div>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={loadingMore}
                      leftIcon={<ChevronDown className="size-3.5" aria-hidden />}
                      onClick={() => void readMore()}
                    >
                      {t('more')}
                    </Button>
                  </div>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </section>
    </Card>
  );
}

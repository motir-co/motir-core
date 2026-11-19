import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { CircleCheck, Info } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { JOBS_SYSTEM_REPLAY_ROLE } from '@/lib/jobs/platformStanding';
import { platformRoleAtLeast, type PlatformPrincipal } from '@/lib/platform/auth';
import { platformFailedUsageService } from '@/lib/services/platformFailedUsageService';
import { FailedUsageGroups } from './FailedUsageGroups';
import { ReconciliationUnavailable } from './ReconciliationUnavailable';

/**
 * Usage & cost's FAILED USAGE section (MOTIR-11794) — design
 * `platform-admin/console--estate-usage-drilldown--failed-usage.mock.html`
 * (MOTIR-11793; `design-notes.md` § AMENDMENT 2026-11-19 — Usage & cost ·
 * Failed usage).
 *
 * The usage motir-ai could not apply, grouped by the error it failed with, and
 * — for an operator — Replay on each group. Its read is its OWN: the page
 * renders it inside a `<Suspense>` whose fallback is {@link FailedUsageLoading},
 * so it loads and fails apart from the rollup and Provider bills above it. It is
 * not period-scoped: every failed row waiting now is listed, whatever period the
 * page shows.
 */
export async function FailedUsageSection({ principal }: { principal: PlatformPrincipal }) {
  const t = await getTranslations('platformAdmin.usage.failed');
  const groups = await platformFailedUsageService.listGroups(principal);
  const canReplay = platformRoleAtLeast(principal.role, JOBS_SYSTEM_REPLAY_ROLE);

  let count: string | null = null;
  let body: ReactNode;
  if (groups === null) {
    body = (
      <ReconciliationUnavailable title={t('error.title')} description={t('error.description')} />
    );
  } else if (groups.length === 0) {
    body = (
      <p
        className="flex items-center gap-2 font-sans text-sm text-(--el-text-secondary)"
        data-testid="usage-failed-empty"
      >
        <CircleCheck aria-hidden="true" className="h-4 w-4 shrink-0 text-(--el-success)" />
        {t('empty')}
      </p>
    );
  } else {
    count = t('count', {
      rows: groups.reduce((sum, g) => sum + g.rows, 0),
      groups: groups.length,
    });
    body = (
      <>
        {canReplay ? null : (
          <div
            role="note"
            className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) px-(--spacing-control-x-12) py-(--spacing-control-y-8) font-sans text-sm text-(--el-text-strong)"
            data-testid="usage-failed-read-only"
          >
            <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{t('readOnly')}</p>
          </div>
        )}
        <FailedUsageGroups groups={groups} canReplay={canReplay} />
      </>
    );
  }

  return (
    <FailedUsageFrame title={t('title')} intro={t('intro')} count={count}>
      {body}
    </FailedUsageFrame>
  );
}

/** The section's heading, count line and intro, shared by every state. */
function FailedUsageFrame({
  title,
  intro,
  count,
  busy,
  children,
}: {
  title: string;
  intro: string;
  count: string | null;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby="usage-failed"
      aria-busy={busy || undefined}
      className="flex flex-col gap-2"
      data-testid="usage-failed"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="usage-failed" className="font-sans text-sm font-semibold text-(--el-text)">
          {title}
        </h2>
        {count ? (
          <p
            className="font-sans text-xs text-(--el-text-secondary)"
            data-testid="usage-failed-count"
          >
            {count}
          </p>
        ) : null}
      </div>
      <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">{intro}</p>
      {children}
    </section>
  );
}

/** The section while its read is in flight — the page's `<Suspense>` fallback. */
export async function FailedUsageLoading() {
  const t = await getTranslations('platformAdmin.usage.failed');
  return (
    <FailedUsageFrame title={t('title')} intro={t('intro')} count={null} busy>
      <span role="status" className="sr-only">
        {t('loading')}
      </span>
      <Card aria-hidden="true" data-testid="usage-failed-loading">
        <div className="flex flex-col gap-3">
          <div className="h-4 w-full rounded-(--radius-control) bg-(--el-muted)" />
          <div className="h-4 w-full rounded-(--radius-control) bg-(--el-muted)" />
          <div className="h-4 w-full rounded-(--radius-control) bg-(--el-muted)" />
        </div>
      </Card>
    </FailedUsageFrame>
  );
}

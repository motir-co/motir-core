'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { cn } from '@/lib/utils/cn';

/**
 * One section card of the Fleet page (design panel 2): the platform Fleet card's
 * header grammar — a tinted icon chip, a `text-sm` title, a secondary lead, and
 * a count chip on the right — over the section's body.
 *
 * ⚠️ A SECTION THAT WAS NOT READ draws its own error and Retry (panel 5) and NO
 * count chip: a failed read is never a 0 and never an empty list.
 */
export function FleetSection({
  id,
  testId,
  icon,
  chip,
  title,
  lead,
  count,
  failed,
  onRetry,
  children,
}: {
  id: string;
  testId: string;
  icon: ReactNode;
  /** The icon chip's tint + ink classes. */
  chip: string;
  title: string;
  lead?: string;
  /** The count chip; omitted while the section is not read. */
  count?: string | null;
  /** The section's error title when its part was not read. */
  failed?: string | null;
  onRetry: () => void;
  children?: ReactNode;
}) {
  const t = useTranslations('settings.organization.fleet.section');
  const header = (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={cn(
            'inline-flex h-(--height-control-32) w-8 shrink-0 items-center justify-center rounded-(--radius-control)',
            chip,
          )}
        >
          {icon}
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={`${id}-title`} className="font-sans text-sm font-semibold text-(--el-text)">
            {title}
          </h2>
          {lead ? <p className="font-sans text-xs text-(--el-text-secondary)">{lead}</p> : null}
        </div>
      </div>
      {!failed && count ? (
        <Pill tone="neutral" className="tabular-nums">
          {count}
        </Pill>
      ) : null}
    </div>
  );
  return (
    <section aria-labelledby={`${id}-title`}>
      <Card header={header} data-testid={testId}>
        {failed ? (
          <SectionError title={failed} body={t('failedBody')} onRetry={onRetry} />
        ) : (
          children
        )}
      </Card>
    </section>
  );
}

/** The rose error callout with Retry (panel 5). */
export function SectionError({
  title,
  body,
  onRetry,
}: {
  title: string;
  body: string;
  onRetry: () => void;
}) {
  const t = useTranslations('settings.organization.fleet.section');
  return (
    <div
      role="alert"
      className="flex flex-wrap items-start justify-between gap-3 rounded-(--radius-card) bg-(--el-tint-rose) p-(--spacing-card-padding) font-sans text-sm text-(--el-text-strong)"
    >
      <span className="flex min-w-0 flex-1 items-start gap-2">
        <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger)" />
        <span>
          <strong className="block font-semibold">{title}</strong>
          {body}
        </span>
      </span>
      <Button
        variant="secondary"
        size="sm"
        leftIcon={<RotateCw aria-hidden className="h-4 w-4" />}
        onClick={onRetry}
      >
        {t('retry')}
      </Button>
    </div>
  );
}

/** A section's list of rows, the platform card's hairline grammar. */
export function FleetRows({ children }: { children: ReactNode }) {
  return <ul className="flex flex-col">{children}</ul>;
}

/** One row: the text block, then its status chip, then its action (if any). */
export function FleetRow({
  primary,
  meta,
  status,
  action,
  testId,
}: {
  primary: ReactNode;
  meta: ReactNode;
  status: ReactNode;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <li
      data-testid={testId}
      className="flex flex-wrap items-center gap-3 border-t border-(--el-border-soft) py-(--spacing-control-y-8) first:border-t-0"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-sans text-sm text-(--el-text)">{primary}</span>
        <span className="font-sans text-xs text-(--el-text-secondary)">{meta}</span>
      </div>
      <div className="shrink-0">{status}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </li>
  );
}

/** A section's empty state, in its own words (panel 3). */
export function FleetEmpty({ text }: { text: string }) {
  return <p className="font-sans text-sm text-(--el-text-secondary)">{text}</p>;
}

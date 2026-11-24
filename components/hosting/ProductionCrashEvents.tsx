'use client';

import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { AlertTriangle, ChevronDown, ChevronRight, RotateCcw, ServerCrash } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import type { ProductionHealthEventDto } from '@/lib/dto/productionHealth';
import { eventReasonMessage } from '@/lib/hosting/productionRuntimeWords';
import { useRelativeTime } from '@/lib/hooks/useRelativeTime';
import { shortCommit } from '@/lib/hosting/releaseStateLabel';
import { ProductionLogLines } from '@/components/hosting/ProductionLogLines';

// CRASH EVENTS (Story MOTIR-9799 · MOTIR-12109; `design/hosting/design-notes.md`
// § Elements, panels 1, 3, 7): the application's events, newest first — the
// reason in plain words, when, the release, the last lines before it (collapsed),
// and, for an administrator, Roll back. Roll back opens the SHIPPED confirmation
// and returns production to the release before the current one, so it is offered
// only on an event of the release serving now; an event of a release that has
// since been rolled back reads "Rolled back since" and offers nothing.

export function eventAnchorId(eventId: string): string {
  return `production-event-${eventId}`;
}

function EventRow({
  event,
  rollback,
  initiallyOpen,
}: {
  event: ProductionHealthEventDto;
  rollback: { enabled: boolean; onRollback: () => void } | null;
  initiallyOpen: boolean;
}) {
  const t = useTranslations('settings.production');
  const format = useFormatter();
  const relativeTime = useRelativeTime();
  const [open, setOpen] = useState(initiallyOpen);
  const reason = eventReasonMessage(event.reason);
  const at = new Date(event.occurredAt);
  const rolledBack = event.release?.state === 'rolled_back';
  const count = event.lastLogLines.length;
  return (
    <li
      id={eventAnchorId(event.id)}
      className="flex scroll-mt-6 flex-col gap-2 border-b border-(--el-border-soft) py-(--spacing-control-y-8) last:border-b-0"
      data-testid="production-crash-event"
      data-event-kind={event.kind}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          {event.kind === 'crashed' ? (
            <ServerCrash
              className="mt-0.5 size-4 shrink-0 text-(--el-danger-on-surface)"
              aria-hidden
            />
          ) : (
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-(--el-text-secondary)"
              aria-hidden
            />
          )}
          <div className="flex min-w-0 flex-col gap-0.5">
            <span
              className="font-sans text-sm font-medium text-(--el-text)"
              data-testid="production-crash-reason"
            >
              {t(reason.key, reason.values)}
            </span>
            <span className="flex flex-wrap items-center gap-x-3 font-sans text-xs text-(--el-text-secondary)">
              <time
                dateTime={event.occurredAt}
                title={format.dateTime(at, { dateStyle: 'medium', timeStyle: 'medium' })}
              >
                {relativeTime(at)}
              </time>
              {event.release ? (
                <span>
                  {t.rich('events.release', {
                    commit: shortCommit(event.release.commitSha),
                    code: (chunks) => (
                      <code className="font-mono text-(--el-text-identifier)">{chunks}</code>
                    ),
                  })}
                </span>
              ) : null}
              {rolledBack ? (
                <span data-testid="production-crash-rolled-back">
                  {t('events.rolledBackSince')}
                </span>
              ) : null}
            </span>
          </div>
        </div>
        {rollback && !rolledBack ? (
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<RotateCcw className="size-3.5" aria-hidden />}
            disabled={!rollback.enabled}
            onClick={rollback.onRollback}
            data-testid="production-crash-rollback"
          >
            {t('rollback.action')}
          </Button>
        ) : null}
      </div>
      {count > 0 ? (
        <div className="flex flex-col gap-2 pl-6">
          <div>
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              leftIcon={
                open ? (
                  <ChevronDown className="size-3.5" aria-hidden />
                ) : (
                  <ChevronRight className="size-3.5" aria-hidden />
                )
              }
            >
              {open ? t('events.hideLines') : t('events.showLines', { count })}
            </Button>
          </div>
          {open ? <ProductionLogLines lines={event.lastLogLines} dense /> : null}
        </div>
      ) : null}
    </li>
  );
}

export function ProductionCrashEvents({
  events,
  currentReleaseId,
  isAdministrator,
  canRollback,
  onRollback,
  focusEventId,
}: {
  events: ProductionHealthEventDto[];
  currentReleaseId: string | null;
  isAdministrator: boolean;
  canRollback: boolean;
  onRollback: () => void;
  /** The event a crash notification opened the page on: scrolled to, opened. */
  focusEventId?: string | null;
}) {
  const t = useTranslations('settings.production.events');

  useEffect(() => {
    if (!focusEventId) return;
    const el = document.getElementById(eventAnchorId(focusEventId));
    el?.scrollIntoView?.({ block: 'start' });
  }, [focusEventId]);

  return (
    <Card data-testid="production-crash-events">
      <section className="flex flex-col gap-2" aria-labelledby="production-events-heading">
        <h2
          id="production-events-heading"
          className="font-serif text-lg font-semibold text-(--el-text)"
        >
          {t('heading')}
        </h2>
        {events.length === 0 ? (
          <p className="font-sans text-sm text-(--el-text-secondary)">{t('empty')}</p>
        ) : (
          <ol className="flex flex-col">
            {events.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                initiallyOpen={event.id === focusEventId}
                rollback={
                  isAdministrator &&
                  currentReleaseId !== null &&
                  event.releaseId === currentReleaseId
                    ? { enabled: canRollback, onRollback }
                    : null
                }
              />
            ))}
          </ol>
        )}
      </section>
    </Card>
  );
}

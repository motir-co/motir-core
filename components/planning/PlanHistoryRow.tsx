'use client';

import { useFormatter, useTranslations } from 'next-intl';

import { Pill } from '@/components/ui/Pill';
import type { PlanSessionRowDto, PlanSessionStateDto } from '@/lib/dto/planSessions';
import { cn } from '@/lib/utils/cn';

// ONE row of the overlay's History (Story MOTIR-9218 · MOTIR-9307; design MOTIR-9305
// panel 3): the session's first turn, its anchor chip, when it was last active, an
// Open / Ended pill and — when the session holds a plan — that plan's state in the
// Plans page's own words and tone. The compact rail form of the Plans row
// (`app/(authed)/plans/_components/SessionRow.tsx`), not a second Plans page.

/** The plan-state chip, in the tones the Plans page gives these states (§19.3). Only
 *  states a row with a plan can show; `none` and `closed` draw no chip here. */
function PlanStateChip({ state, label }: { state: PlanSessionStateDto; label: string }) {
  switch (state) {
    case 'generating':
      return <Pill severity="info">{label}</Pill>;
    case 'waiting':
      return <Pill tone="awaiting">{label}</Pill>;
    case 'planned':
      return <Pill status="planned">{label}</Pill>;
    // Being approved (Bug MOTIR-9006): in progress, the sky word `generating` takes.
    case 'approving':
      return <Pill severity="info">{label}</Pill>;
    case 'stale':
      return <Pill severity="danger">{label}</Pill>;
    case 'approved':
      return <Pill severity="success">{label}</Pill>;
    case 'declined':
      return <Pill tone="archived">{label}</Pill>;
    case 'none':
    case 'closed':
      return null;
  }
}

export interface PlanHistoryRowProps {
  session: PlanSessionRowDto;
  /** The session the overlay shows now — the currently-open-row marker. */
  current: boolean;
  onOpen: (sessionId: string, targetKeys: readonly string[]) => void;
  /** The last row: focusing it asks for the next page, like reaching the bottom. */
  onFocusLast?: () => void;
}

export function PlanHistoryRow({ session, current, onOpen, onFocusLast }: PlanHistoryRowProps) {
  const t = useTranslations('planningWorkspace.history');
  const ts = useTranslations('aiPlanning.sessions');
  const format = useFormatter();

  const title = session.firstTurn ?? session.latestPlan?.title ?? ts('untitled');
  const ended = session.endedAt !== null;
  const status = ended ? t('status.ended') : t('status.open');
  const when = format.relativeTime(new Date(session.lastActivityAt));
  const [firstKey, ...moreKeys] = session.targetKeys;
  const showsPlan = session.planCount > 0;

  return (
    <li>
      <button
        type="button"
        data-testid="planning-history-row"
        data-session-id={session.id}
        data-ended={ended ? 'true' : undefined}
        aria-current={current ? 'true' : undefined}
        aria-label={t('rowAria', { title, status, when })}
        title={title}
        onClick={() => onOpen(session.id, session.targetKeys)}
        onFocus={onFocusLast}
        className={cn(
          'flex w-full min-w-0 flex-col gap-1 rounded-(--radius-control) px-(--spacing-control-x-8) py-(--spacing-control-y-8) text-left text-(--el-text)',
          'hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
          current && 'bg-(--el-page-bg) shadow-[inset_2px_0_0_var(--el-accent)]',
        )}
      >
        <span
          data-testid="planning-history-row-title"
          className={cn(
            'truncate text-[13px] leading-snug',
            ended ? 'text-(--el-text-secondary)' : 'text-(--el-text)',
          )}
        >
          {title}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-(--el-text-secondary)">
          {firstKey ? (
            <span
              data-testid="planning-history-row-anchor"
              title={session.targetKeys.join(', ')}
              className="inline-flex max-w-44 truncate rounded-(--radius-badge) border border-(--el-chip-border) bg-(--el-chip-bg) px-(--spacing-chip-x-6) font-mono text-[11px]"
            >
              {moreKeys.length > 0
                ? ts('anchorMore', { first: firstKey, count: moreKeys.length })
                : firstKey}
            </span>
          ) : (
            <span>{ts('anchorProject')}</span>
          )}
          <span aria-hidden="true">·</span>
          <span>{ts('lastActive', { when })}</span>
          {ended ? (
            <Pill tone="archived" data-testid="planning-history-row-status">
              {status}
            </Pill>
          ) : (
            <Pill severity="success" data-testid="planning-history-row-status">
              {status}
            </Pill>
          )}
          {showsPlan ? (
            <PlanStateChip state={session.state} label={ts(`planState.${session.state}`)} />
          ) : null}
        </span>
      </button>
    </li>
  );
}

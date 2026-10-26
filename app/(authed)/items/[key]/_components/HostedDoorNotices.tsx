'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { repositoryRowHref } from '@/lib/projectRepos/repositoryAnchor';
import { isLiveRun } from '@/lib/runs/timeline';
import { allHeld } from '@/components/hosted/hostedModels';
import { useHostedRun, type HostedRunRefusal } from './HostedRunProvider';

// WHAT THE RUN HOSTED DOOR ANSWERS, in the Run section's body (Story MOTIR-683 ·
// MOTIR-691; `design/runs/design-notes.md` § Refusals live on the DOOR, and
// `design/repository-set/design-notes.md` §18.3).
//
// ⚠️ A REFUSAL IS NOT A RUN. Everything drawn here happened BEFORE a run was
// opened, so there is no history row, nothing in `/runs`, and nothing reaches the
// modal — which is why it lives on the door and never in the timeline, and why
// every line says that nothing was booted and nothing was charged.

export function HostedDoorNotices() {
  const t = useTranslations('runs.hosted');
  const tStart = useTranslations('runs.start');
  const door = useHostedRun();
  if (!door) return null;
  // While a run is live the header holds Cancel run (or nothing): the door's own
  // lines have nothing to say about it.
  if (door.currentRun && isLiveRun(door.currentRun.status)) return null;
  // No Run hosted on a died card (C7), so nothing of its door is said either.
  if (door.runDoorHidden) return null;

  return (
    <div className="flex flex-col gap-2" data-testid="hosted-door-notices">
      {door.refusal ? <RefusalNotice refusal={door.refusal} /> : null}
      {door.models.state === 'loading' ? (
        <p className="font-sans text-xs text-(--el-text-secondary)" role="status">
          {t('picker.loadingBody')}
        </p>
      ) : door.models.state === 'unavailable' ? (
        <Notice testId="hosted-models-unavailable">
          <span>{t('picker.unavailableBody')}</span>
          <Button type="button" variant="secondary" size="sm" onClick={door.reloadModels}>
            {t('picker.retry')}
          </Button>
        </Notice>
      ) : door.models.models.length === 0 ? (
        <Notice testId="hosted-models-empty">
          <span>{t('picker.emptyBody')}</span>
        </Notice>
      ) : allHeld(door.models) ? (
        // The All-models-held line (MOTIR-9630, design N5): the empty face's slot.
        <Notice testId="hosted-models-all-held">
          <span>{t('picker.allHeldBody')}</span>
        </Notice>
      ) : null}
      {!door.ready ? (
        // ONE line for both options when Send to my agent sits beside Run
        // (MOTIR-7022 revision 2, panel 4); Run's own when it is alone.
        <p className="font-sans text-sm text-(--el-text-secondary)" data-testid="hosted-not-ready">
          {door.agentDoor
            ? tStart('notReady', { count: door.openBlockers })
            : t('notReady', { count: door.openBlockers })}
        </p>
      ) : null}
    </div>
  );
}

export function RefusalNotice({ refusal }: { refusal: HostedRunRefusal }) {
  const t = useTranslations('runs.hosted.refused');
  if (refusal.kind === 'notWritable') {
    const count = refusal.repositories.length;
    return (
      <Notice testId="hosted-refused-notWritable">
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="font-semibold">
            {refusal.total !== null
              ? t('notWritable.lead', { count, total: refusal.total })
              : t('notWritable.leadNoTotal', { count })}
          </p>
          <p>{t('notWritable.detail')}</p>
          <ul className="flex flex-col">
            {refusal.repositories.map((r) => (
              <li
                key={r.repository}
                className="flex flex-col gap-0.5 border-t border-(--el-border-soft) py-1.5 first:border-t-0"
              >
                <span className="font-mono text-xs font-semibold">{r.repository}</span>
                <span>{r.reason}</span>
                <Link
                  className="self-start text-(--el-link) underline"
                  href={repositoryRowHref(r.repository)}
                >
                  {t('notWritable.open')}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </Notice>
    );
  }
  const title =
    refusal.kind === 'modelNotOffered' || refusal.kind === 'noCapacity'
      ? t(`${refusal.kind}.title`, { model: refusal.model })
      : t(`${refusal.kind}.title`);
  return (
    <Notice testId={`hosted-refused-${refusal.kind}`}>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-semibold">{title}</p>
        <p>{t(`${refusal.kind}.body`)}</p>
      </div>
    </Notice>
  );
}

/** The area's `notice warn` — a warning, not a danger: nothing failed, nothing was spent. */
export function Notice({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div
      role="status"
      data-testid={testId}
      className="flex items-start gap-2 rounded-(--radius-control) bg-(--el-warning-surface) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-sm text-(--el-text-strong)"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-(--el-warning)" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

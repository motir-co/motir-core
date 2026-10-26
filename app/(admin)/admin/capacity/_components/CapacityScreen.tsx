'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CircleCheck, Clock, Info, RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import type {
  CapacityAlertShareActionResult,
  CapacityLimitsActionResult,
} from '@/app/(admin)/admin/capacity/actions';
import type {
  PlatformCapacityEditInput,
  PlatformCapacityEntryDTO,
  PlatformCapacityViewDTO,
} from '@/lib/dto/platformCapacity';
import { AlertShareCard } from './AlertShareCard';
import { CapacityEntryCard } from './CapacityEntryCard';
import { CapacityErrorPanel } from './CapacityErrorPanel';
import { EditCapacityLimitsDialog } from './EditCapacityLimitsDialog';
import { RaisedAlertsBanner } from './RaisedAlertsBanner';
import { utcClock } from './capacityDisplay';

/**
 * The CAPACITY SCREEN's client island (MOTIR-9614, design `platform-admin`
 * AMENDMENT 2026-10-25, Panels 1–16), seeded from the server's view model.
 *
 * ⚠️ IT RE-READS THE ROUTE, NOT THE SERVER TREE. Every `refreshMs`, on Refresh
 * and after a save it fetches `GET /api/platform/capacity` (`no-store`). The
 * actions' `revalidatePath` refreshes the server render only, which this island
 * — seeded once from props — never sees again (the page-state rule, case 3).
 *
 * ⚠️ NOTHING OLD IS SHOWN AS CURRENT. A response is applied only if it answers
 * the latest request (the sequence guard), a failed poll keeps the last view and
 * says "Could not refresh" beside its own `readAt`, and the time printed is the
 * read's, in UTC — never when the browser received it.
 */

export const CAPACITY_VIEW_ROUTE = '/api/platform/capacity';

export interface CapacityScreenProps {
  initialView: PlatformCapacityViewDTO;
  refreshMs: number;
  editLimits: (
    provider: string,
    model: string,
    edit: PlatformCapacityEditInput,
  ) => Promise<CapacityLimitsActionResult>;
  setAlertShare: (percent: number) => Promise<CapacityAlertShareActionResult>;
}

function useCapacityView(initialView: PlatformCapacityViewDTO, refreshMs: number) {
  const [view, setView] = useState(initialView);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const latest = useRef(0);

  const reread = useCallback(async () => {
    const request = ++latest.current;
    setPending(true);
    let next: PlatformCapacityViewDTO | null = null;
    try {
      const res = await fetch(CAPACITY_VIEW_ROUTE, { cache: 'no-store' });
      if (res.ok) next = (await res.json()) as PlatformCapacityViewDTO;
    } catch {
      next = null;
    }
    if (request !== latest.current) return;
    setPending(false);
    if (next) setView(next);
    setFailed(next === null);
  }, []);

  // The timer runs only while the tab is visible.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => void reread(), refreshMs);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.visibilityState === 'hidden' ? stop() : start());
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [reread, refreshMs]);

  return { view, failed, pending, reread };
}

export function CapacityScreen({
  initialView,
  refreshMs,
  editLimits,
  setAlertShare,
}: CapacityScreenProps) {
  const t = useTranslations('platformAdmin.capacity');
  const { view, failed, pending, reread } = useCapacityView(initialView, refreshMs);
  const [editing, setEditing] = useState<PlatformCapacityEntryDTO | null>(null);
  const [savedModel, setSavedModel] = useState<string | null>(null);
  const capacity = view.capacity;

  return (
    <div className="flex flex-col gap-4">
      {capacity.outcome === 'answered' && (
        <FreshnessLine
          readAt={capacity.readAt}
          refreshMs={refreshMs}
          failed={failed}
          pending={pending}
          onRefresh={() => void reread()}
        />
      )}
      <RaisedAlertsBanner raised={view.raised} />
      {capacity.outcome === 'answered' && capacity.counterStore.state === 'unavailable' && (
        <Notice tone="warn">{t('unavailable.notice')}</Notice>
      )}
      {capacity.outcome === 'answered' && capacity.counterStore.scope === 'instance' && (
        <Notice tone="info">{t('scope.instance')}</Notice>
      )}
      {savedModel && (
        <p role="status" className="flex items-start gap-1.5 text-xs text-(--el-text)">
          <CircleCheck aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-(--el-success)" />
          <span>{t('edit.saved', { model: savedModel })}</span>
        </p>
      )}
      <AlertShareCard
        alertShare={view.alertShare}
        canEdit={view.canEdit}
        setAlertShare={setAlertShare}
        onSaved={() => void reread()}
      />
      {capacity.outcome === 'unavailable' ? (
        <CapacityErrorPanel
          reason={capacity.reason}
          retrying={pending}
          onRetry={() => void reread()}
        />
      ) : capacity.entries.length === 0 ? (
        <EmptyState title={t('empty.title')} description={t('empty.body')} />
      ) : (
        <ProviderGroups
          entries={capacity.entries}
          storeLive={capacity.counterStore.state === 'live'}
          onEdit={
            view.canEdit
              ? (entry) => {
                  setSavedModel(null);
                  setEditing(entry);
                }
              : undefined
          }
        />
      )}
      {editing && (
        <EditCapacityLimitsDialog
          key={`${editing.provider}/${editing.model}`}
          entry={editing}
          editLimits={editLimits}
          onClose={() => setEditing(null)}
          onSaved={(model) => {
            setSavedModel(model);
            void reread();
          }}
        />
      )}
    </div>
  );
}

function FreshnessLine({
  readAt,
  refreshMs,
  failed,
  pending,
  onRefresh,
}: {
  readAt: string;
  refreshMs: number;
  failed: boolean;
  pending: boolean;
  onRefresh: () => void;
}) {
  const t = useTranslations('platformAdmin.capacity');
  return (
    <div
      className="flex flex-wrap items-center gap-2.5 text-xs tabular-nums text-(--el-text-secondary)"
      data-testid="capacity-freshness"
    >
      <Clock aria-hidden className="h-3.5 w-3.5 shrink-0" />
      <span>
        {t('fresh.readAt', { time: utcClock(readAt) })} ·{' '}
        {t('fresh.every', { seconds: Math.round(refreshMs / 1000) })}
      </span>
      {failed && (
        <span role="status" className="flex items-center gap-1 text-(--el-danger-on-surface)">
          <TriangleAlert aria-hidden className="h-3.5 w-3.5" />
          {t('fresh.failed')}
        </span>
      )}
      <Button variant="secondary" size="sm" loading={pending} onClick={onRefresh}>
        <RotateCw aria-hidden className="h-3.5 w-3.5" />
        {t('fresh.refresh')}
      </Button>
    </div>
  );
}

function Notice({ tone, children }: { tone: 'warn' | 'info'; children: string }) {
  const look =
    tone === 'warn' ? 'border border-(--el-border) bg-(--el-tint-yellow)' : 'bg-(--el-tint-sky)';
  const Icon = tone === 'warn' ? TriangleAlert : Info;
  return (
    <p
      role="status"
      className={`flex items-start gap-2.5 rounded-(--radius-card) px-(--spacing-control-x-12) py-(--spacing-control-y-8) text-xs text-(--el-text-strong) ${look}`}
    >
      <Icon
        aria-hidden
        className={`mt-px h-4 w-4 shrink-0 ${tone === 'warn' ? 'text-(--el-warning)' : 'text-(--el-info)'}`}
      />
      <span>{children}</span>
    </p>
  );
}

function ProviderGroups({
  entries,
  storeLive,
  onEdit,
}: {
  entries: PlatformCapacityEntryDTO[];
  storeLive: boolean;
  onEdit?: (entry: PlatformCapacityEntryDTO) => void;
}) {
  const t = useTranslations('platformAdmin.capacity');
  const providers = [...new Set(entries.map((entry) => entry.provider))];
  return (
    <>
      {providers.map((provider) => (
        <section key={provider} data-testid={`capacity-group-${provider}`}>
          <h3 className="mb-2.5 text-sm font-semibold tracking-wide text-(--el-text-secondary)">
            {t(`provider.${provider}`)}
          </h3>
          <div className="flex flex-col gap-3.5">
            {entries
              .filter((entry) => entry.provider === provider)
              .map((entry) => (
                <CapacityEntryCard
                  key={entry.model}
                  entry={entry}
                  storeLive={storeLive}
                  onEdit={onEdit}
                />
              ))}
          </div>
        </section>
      ))}
    </>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Info } from 'lucide-react';
import type { HostedReleaseDto } from '@/lib/dto/hostedApplications';
import type { ProductionHealthDto } from '@/lib/dto/productionHealth';
import type { ProductionPanelDto } from '@/lib/dto/productionPanel';
import {
  productionPanelClient,
  type ProductionRefusalKey,
} from '@/lib/hosting/productionPanelClient';
import { productionRuntimeClient } from '@/lib/hosting/productionRuntimeClient';
import { shortCommit } from '@/lib/hosting/releaseStateLabel';
import { CurrentReleaseCard } from '@/components/hosting/CurrentReleaseCard';
import { ProductionCrashEvents } from '@/components/hosting/ProductionCrashEvents';
import { ProductionHealthState, type HealthView } from '@/components/hosting/ProductionHealthState';
import { ProductionLogsView } from '@/components/hosting/ProductionLogsView';
import { ProductionEmptyState } from '@/components/hosting/ProductionEmptyState';
import { ReleaseHistoryList } from '@/components/hosting/ReleaseHistoryList';
import { RollbackDialog } from '@/components/hosting/RollbackDialog';

// The PRODUCTION PANEL (Story MOTIR-9797 · MOTIR-10037), per
// `design/hosting/production.mock.html` · `design/hosting/design-notes.md`
// (MOTIR-10024): one Motir repository's current release, its release history and,
// for an administrator, Roll back.
//
// A client ISLAND seeded from the server's read of the panel (the page calls
// `productionPanelService`; this island reaches the routes only through
// `productionPanelClient`). It computes no role: `isAdministrator` decides whether
// the Roll back control exists at all and `canRollback` whether it is enabled;
// the rollback service stays the authority, and its refusals come back as keys.
//
// PAGE STATE AFTER THE MUTATION: the rollback POST answers the panel's first page,
// so the island REPLACES its state from the response, then `router.refresh()`
// re-renders any server surface that shows what is deployed. No optimistic Live
// pill — the dialog shows busy until the answer. Show more and the rollback share
// one sequence counter, so a late answer never lands over a newer one.
//
// LIVE APP OPERATIONS (Story MOTIR-9799 · MOTIR-12109, the delta mock
// `design/hosting/production--live-app-ops.mock.html`): the panel uses the whole
// content area — Current release | Health share a row from `lg`, then Crash
// events, Logs and Release history each span it. Health is seeded by the server
// read and re-read every minute (the probe's own cadence) and after a rollback,
// through its own sequence counter. Roll back on a crash event opens the same
// confirmation as the card's.

/** How often Health is re-read while the panel is open: the probe runs per minute. */
export const HEALTH_REFRESH_MS = 60_000;

export function ProductionPanel({
  projectKey,
  repositoryId,
  repositoryName,
  initial,
  initialHealth = null,
  focusEventId = null,
}: {
  projectKey: string;
  repositoryId: string;
  repositoryName: string;
  initial: ProductionPanelDto;
  /** The server's health read; null when there is no application or it failed. */
  initialHealth?: ProductionHealthDto | null;
  /** The crash event a notification opened the page on. */
  focusEventId?: string | null;
}) {
  const t = useTranslations('settings.production');
  const router = useRouter();
  const [panel, setPanel] = useState(initial);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [refusalKey, setRefusalKey] = useState<ProductionRefusalKey | null>(null);
  const seq = useRef(0);
  const [health, setHealth] = useState<HealthView>(
    initialHealth ? { kind: 'ready', health: initialHealth } : { kind: 'loading' },
  );
  const healthSeq = useRef(0);
  const hasApplication = panel.application !== null;

  /** One health read. A `shown` read (the first, Try again) shows its error; a
   *  `quiet` refresh that fails keeps the last state read rather than replacing
   *  it with an error. A late answer that a newer read overtook is dropped. */
  const readHealth = useCallback(
    (mode: 'shown' | 'quiet') => {
      const mine = ++healthSeq.current;
      return productionRuntimeClient.readHealth(projectKey, repositoryId).then((result) => {
        if (mine !== healthSeq.current) return;
        if (result.ok) setHealth({ kind: 'ready', health: result.data });
        else if (mode !== 'quiet') setHealth({ kind: 'failed' });
      });
    },
    [projectKey, repositoryId],
  );

  useEffect(() => {
    if (!hasApplication) return;
    // With no server read the state already starts as loading.
    if (!initialHealth) void readHealth('shown');
    const timer = setInterval(() => void readHealth('quiet'), HEALTH_REFRESH_MS);
    return () => clearInterval(timer);
  }, [hasApplication, initialHealth, readHealth]);

  const { currentRelease, previousRelease, releases, application } = panel;
  const address = application?.productionAddress ?? null;

  const showMore = async () => {
    // Never while a rollback is in flight: its answer replaces the whole panel.
    if (!panel.nextCursor || pending) return;
    const mine = ++seq.current;
    setLoadingMore(true);
    setMoreFailed(false);
    const result = await productionPanelClient.read(projectKey, repositoryId, panel.nextCursor);
    if (mine !== seq.current) return;
    setLoadingMore(false);
    if (!result.ok) {
      setMoreFailed(true);
      return;
    }
    setPanel((prev) => ({
      ...prev,
      releases: appendNew(prev.releases, result.data.releases),
      nextCursor: result.data.nextCursor,
    }));
  };

  const openDialog = () => {
    setRefusalKey(null);
    setDialogOpen(true);
  };

  const confirmRollback = async () => {
    const mine = ++seq.current;
    setPending(true);
    setRefusalKey(null);
    // An in-flight Show more is superseded: its answer is dropped by the guard.
    setLoadingMore(false);
    const result = await productionPanelClient.rollback(projectKey, repositoryId);
    if (mine !== seq.current) return;
    setPending(false);
    if (!result.ok) {
      setRefusalKey(result.refusalKey);
      return;
    }
    setPanel(result.data);
    setMoreFailed(false);
    setDialogOpen(false);
    router.refresh();
    void readHealth('quiet');
  };

  const newest = releases[0];
  const deployingCommit =
    newest && (newest.state === 'building' || newest.state === 'releasing')
      ? newest.commitSha
      : null;
  const healthDto = health.kind === 'ready' ? health.health : null;
  const rollbackEnabled = panel.canRollback && previousRelease !== null;
  const failedNewer =
    currentRelease !== null && newest !== undefined && newest.state === 'failed'
      ? currentRelease
      : null;

  return (
    <div className="flex flex-col gap-6" data-testid="production-panel">
      {failedNewer ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) font-sans text-sm text-(--el-text)"
          data-testid="production-failed-newer-note"
        >
          <Info className="mt-0.5 size-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
          {t('failedNewer', { commit: shortCommit(failedNewer.commitSha) })}
        </p>
      ) : null}

      {!panel.isAdministrator && (currentRelease || releases.length > 0) ? (
        <p
          role="note"
          className="rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) font-sans text-sm text-(--el-text-secondary)"
          data-testid="production-read-only-note"
        >
          {t('readOnly.note')}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2" data-testid="production-summary-row">
        {currentRelease ? (
          <CurrentReleaseCard
            release={currentRelease}
            address={address}
            isAdministrator={panel.isAdministrator}
            canRollback={rollbackEnabled}
            onRollback={openDialog}
          />
        ) : (
          <div className="lg:col-span-2">
            <ProductionEmptyState />
          </div>
        )}
        {currentRelease ? (
          <ProductionHealthState
            view={health}
            target={application?.target ?? null}
            address={address}
            deployingCommit={deployingCommit}
            onRetry={() => {
              setHealth({ kind: 'loading' });
              void readHealth('shown');
            }}
          />
        ) : null}
      </div>

      {currentRelease && healthDto ? (
        <ProductionCrashEvents
          events={healthDto.events}
          currentReleaseId={currentRelease.id}
          isAdministrator={panel.isAdministrator}
          canRollback={rollbackEnabled}
          onRollback={openDialog}
          focusEventId={focusEventId}
        />
      ) : null}

      <ProductionLogsView
        key={currentRelease?.id ?? 'none'}
        projectKey={projectKey}
        repositoryId={repositoryId}
        target={application?.target ?? null}
        hasRelease={currentRelease !== null}
        asleep={healthDto?.state === 'suspended'}
      />

      {releases.length > 0 ? (
        <ReleaseHistoryList
          releases={releases}
          address={address}
          hasMore={panel.nextCursor !== null}
          loadingMore={loadingMore}
          moreFailed={moreFailed}
          onShowMore={showMore}
        />
      ) : null}

      {dialogOpen && currentRelease && previousRelease ? (
        <RollbackDialog
          repositoryName={repositoryName}
          leaving={currentRelease}
          returningTo={previousRelease}
          address={address}
          pending={pending}
          refusalKey={refusalKey}
          onConfirm={confirmRollback}
          onCancel={() => setDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** The next page after the rows already shown, without repeating one — a release
 *  that arrived meanwhile can shift a row across the page boundary. */
function appendNew(shown: HostedReleaseDto[], next: HostedReleaseDto[]): HostedReleaseDto[] {
  const seen = new Set(shown.map((r) => r.id));
  return [...shown, ...next.filter((r) => !seen.has(r.id))];
}

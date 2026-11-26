'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Info } from 'lucide-react';
import type { HostedReleaseDto } from '@/lib/dto/hostedApplications';
import type { IdlePolicyDto } from '@/lib/dto/idlePolicy';
import type { ProductionHealthDto } from '@/lib/dto/productionHealth';
import type { ProductionUsageDto } from '@/lib/dto/productionUsage';
import type { ProductionPanelDto } from '@/lib/dto/productionPanel';
import {
  productionHandoverClient,
  productionPanelClient,
  type HandoverRefusalKey,
  type ProductionRefusalKey,
} from '@/lib/hosting/productionPanelClient';
import { productionRuntimeClient } from '@/lib/hosting/productionRuntimeClient';
import { shortCommit } from '@/lib/hosting/releaseStateLabel';
import { CurrentReleaseCard } from '@/components/hosting/CurrentReleaseCard';
import { ProductionCrashEvents } from '@/components/hosting/ProductionCrashEvents';
import { ProductionHealthState, type HealthView } from '@/components/hosting/ProductionHealthState';
import { ProductionLogsView } from '@/components/hosting/ProductionLogsView';
import { IdlePolicyControl, type IdlePolicyView } from '@/components/hosting/IdlePolicyControl';
import { ProductionUsage, type UsageView } from '@/components/hosting/ProductionUsage';
import { ProductionEmptyState } from '@/components/hosting/ProductionEmptyState';
import {
  GraceNoticeBanner,
  GracePanel,
  HandoverMemberNote,
  StopNowDialog,
  type ExportView,
} from '@/components/hosting/GracePanel';
import { HandedOverPanel, HandingOverNotice } from '@/components/hosting/HandedOverPanel';
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
//
// THE TAKEOVER HANDOVER (Story MOTIR-9800 · MOTIR-12138, the delta mock
// `design/hosting/production--takeover-handover.mock.html`): the read's `handover`
// picks the branch. `live` is the panel above, unchanged. `handing_over` adds the
// in-progress notice; `grace` adds the Grace notice banner and the Grace panel;
// `handed_over` is the Handed-over panel and the history alone — the app no longer
// runs on Motir, so there is no health, log, idle or usage read. Outside `live`, and
// whenever the deploy guard answers `taken_over`, NO release control renders: no
// Roll back (card or crash event), no rollback dialog, no When idle switch (a
// change redeploys). Download export and Stop now follow the page-state rule: the
// 202 export is re-read through the panel read until it is listed, and a stop is
// re-read until the read no longer answers `grace` — each on a bounded interval,
// each with its own sequence counter, nothing optimistic.

/** How often Health is re-read while the panel is open: the probe runs per minute. */
export const HEALTH_REFRESH_MS = 60_000;

/** How often, and how many times, the panel re-reads while an export is taken —
 *  five minutes in all, the "few minutes" the busy line promises. */
export const EXPORT_POLL_MS = 5_000;
export const EXPORT_POLL_ATTEMPTS = 60;

/** How often, and how many times, the panel re-reads after Stop now answers while
 *  the read still says `grace`. */
export const STOP_POLL_MS = 3_000;
export const STOP_POLL_ATTEMPTS = 20;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function ProductionPanel({
  projectKey,
  repositoryId,
  repositoryName,
  initial,
  initialHealth = null,
  initialIdle = null,
  initialUsage = null,
  focusEventId = null,
}: {
  projectKey: string;
  repositoryId: string;
  repositoryName: string;
  initial: ProductionPanelDto;
  /** The server's health read; null when there is no application or it failed. */
  initialHealth?: ProductionHealthDto | null;
  /** The server's idle-policy and usage reads (MOTIR-12110); null when they
   *  failed, and the island reads them itself. */
  initialIdle?: IdlePolicyDto | null;
  initialUsage?: ProductionUsageDto | null;
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
  const handover = panel.handover;
  const appState = handover?.state ?? 'live';
  // The app still runs on Motir in every state but `handed_over`.
  const running = hasApplication && appState !== 'handed_over';
  // Release controls exist only on a live app the deploy guard still deploys.
  const releasable = appState === 'live' && handover?.deployRefusal !== 'taken_over';

  const [exportView, setExportView] = useState<ExportView>({ kind: 'idle' });
  const exportSeq = useRef(0);
  const [stopOpen, setStopOpen] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [stopRefusal, setStopRefusal] = useState<HandoverRefusalKey | null>(null);
  const stopSeq = useRef(0);
  // An unmounted panel drops every re-read loop still running.
  useEffect(
    () => () => {
      exportSeq.current += 1;
      stopSeq.current += 1;
    },
    [],
  );

  const [idle, setIdle] = useState<IdlePolicyView>(
    initialIdle ? { kind: 'ready', idle: initialIdle } : { kind: 'loading' },
  );
  const [usage, setUsage] = useState<UsageView>(
    initialUsage ? { kind: 'ready', usage: initialUsage } : { kind: 'loading' },
  );
  const readIdle = useCallback(
    () =>
      productionPanelClient.readIdlePolicy(projectKey, repositoryId).then((result) => {
        setIdle(result.ok ? { kind: 'ready', idle: result.data } : { kind: 'failed' });
      }),
    [projectKey, repositoryId],
  );
  const readUsage = useCallback(
    () =>
      productionPanelClient.readUsage(projectKey, repositoryId).then((result) => {
        setUsage(result.ok ? { kind: 'ready', usage: result.data } : { kind: 'failed' });
      }),
    [projectKey, repositoryId],
  );
  // A handed-over app has no idle policy or usage left to read.
  const handedOver = appState === 'handed_over';
  useEffect(() => {
    if (handedOver) return;
    if (!initialIdle) void readIdle();
    if (!initialUsage) void readUsage();
  }, [handedOver, initialIdle, initialUsage, readIdle, readUsage]);

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
    if (!running) return;
    // With no server read the state already starts as loading.
    if (!initialHealth) void readHealth('shown');
    const timer = setInterval(() => void readHealth('quiet'), HEALTH_REFRESH_MS);
    return () => clearInterval(timer);
  }, [running, initialHealth, readHealth]);

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

  /** Download export: ask for the dump, then re-read the panel until the export
   *  the job names is listed, replacing the island's list from each read. */
  const requestExport = async () => {
    if (!handover || !application) return;
    const mine = ++exportSeq.current;
    setExportView({ kind: 'busy' });
    const created = await productionHandoverClient.createExport(
      handover.organizationId,
      application.id,
    );
    if (mine !== exportSeq.current) return;
    if (!created.ok) {
      setExportView({ kind: 'failed', refusalKey: created.refusalKey });
      return;
    }
    for (let attempt = 0; attempt < EXPORT_POLL_ATTEMPTS; attempt++) {
      await wait(EXPORT_POLL_MS);
      if (mine !== exportSeq.current) return;
      const read = await productionPanelClient.read(projectKey, repositoryId);
      if (mine !== exportSeq.current) return;
      const fresh = read.ok ? read.data.handover : null;
      if (!fresh) continue;
      setPanel((prev) =>
        prev.handover ? { ...prev, handover: { ...prev.handover, exports: fresh.exports } } : prev,
      );
      if (fresh.exports.some((e) => e.id === created.data.jobId)) {
        setExportView({ kind: 'idle' });
        return;
      }
    }
    setExportView({ kind: 'failed', refusalKey: 'handover.exports.failed' });
  };

  const openStop = () => {
    setStopRefusal(null);
    setStopOpen(true);
  };

  /** Stop now: the confirmation stays busy until the stop answers AND a re-read
   *  of the panel no longer answers `grace`; that read then replaces the panel. */
  const confirmStop = async () => {
    if (!handover || !application) return;
    const mine = ++stopSeq.current;
    setStopPending(true);
    setStopRefusal(null);
    const result = await productionHandoverClient.stop(handover.organizationId, application.id);
    if (mine !== stopSeq.current) return;
    if (!result.ok) {
      setStopPending(false);
      setStopRefusal(result.refusalKey);
      return;
    }
    for (let attempt = 0; attempt < STOP_POLL_ATTEMPTS; attempt++) {
      if (attempt > 0) await wait(STOP_POLL_MS);
      if (mine !== stopSeq.current) return;
      const read = await productionPanelClient.read(projectKey, repositoryId);
      if (mine !== stopSeq.current) return;
      if (read.ok && read.data.handover?.state !== 'grace') {
        // Whatever else was in flight answers about an app that has stopped.
        seq.current += 1;
        exportSeq.current += 1;
        setPanel(read.data);
        setLoadingMore(false);
        setMoreFailed(false);
        setExportView({ kind: 'idle' });
        setStopPending(false);
        setStopOpen(false);
        router.refresh();
        return;
      }
    }
    setStopPending(false);
    setStopRefusal('handover.stop.failed.unknown');
  };

  const newest = releases[0];
  const deployingCommit =
    newest && (newest.state === 'building' || newest.state === 'releasing')
      ? newest.commitSha
      : null;
  const healthDto = health.kind === 'ready' ? health.health : null;
  const rollbackEnabled = releasable && panel.canRollback && previousRelease !== null;
  // A project administrator sees Roll back only where a release may happen.
  const rollbackShown = panel.isAdministrator && releasable;

  if (handover && application && appState === 'handed_over') {
    return (
      <div className="flex flex-col gap-6" data-testid="production-panel">
        <HandedOverPanel
          handover={handover}
          applicationId={application.id}
          repositoryName={repositoryName}
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
      </div>
    );
  }
  const failedNewer =
    currentRelease !== null && newest !== undefined && newest.state === 'failed'
      ? currentRelease
      : null;

  return (
    <div className="flex flex-col gap-6" data-testid="production-panel">
      {handover && appState === 'handing_over' ? <HandingOverNotice handover={handover} /> : null}
      {handover && application && appState === 'grace' ? (
        <>
          <GraceNoticeBanner handover={handover} repositoryName={repositoryName} />
          {handover.canManageHandover ? null : (
            <HandoverMemberNote>{t('handover.grace.memberNote')}</HandoverMemberNote>
          )}
          <GracePanel
            handover={handover}
            applicationId={application.id}
            repositoryName={repositoryName}
            address={address}
            exportView={exportView}
            onExport={() => void requestExport()}
            onStop={openStop}
          />
        </>
      ) : null}
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

      {appState === 'live' && !panel.isAdministrator && (currentRelease || releases.length > 0) ? (
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
            isAdministrator={rollbackShown}
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
          isAdministrator={rollbackShown}
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

      <div className="grid gap-6 lg:grid-cols-2" data-testid="production-operations-row">
        {releasable ? (
          <IdlePolicyControl
            projectKey={projectKey}
            repositoryId={repositoryId}
            view={idle}
            onView={setIdle}
            onRetry={() => {
              setIdle({ kind: 'loading' });
              void readIdle();
            }}
            hasRelease={currentRelease !== null}
            creditsExhausted={usage.kind === 'ready' && usage.usage.state === 'credits_exhausted'}
          />
        ) : null}
        <ProductionUsage
          view={usage}
          isAdministrator={panel.isAdministrator}
          onRetry={() => {
            setUsage({ kind: 'loading' });
            void readUsage();
          }}
        />
      </div>

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

      {stopOpen && handover ? (
        <StopNowDialog
          repositoryName={repositoryName}
          stopsAt={handover.stopsAt}
          address={address}
          pending={stopPending}
          refusalKey={stopRefusal}
          onConfirm={() => void confirmStop()}
          onCancel={() => setStopOpen(false)}
        />
      ) : null}

      {releasable && dialogOpen && currentRelease && previousRelease ? (
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

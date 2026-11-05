'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Ban, CircleCheck, RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import type {
  OrgFleetAgentInstanceDTO,
  OrgFleetDTO,
  OrgFleetHostedRunDTO,
} from '@/lib/dto/orgFleet';
import type { OrgFleetStopResultDTO } from '@/lib/dto/orgFleetStop';
import {
  cancelHostedRunAction,
  hibernateAgentAction,
  previewStopEverythingAction,
  stopEverythingAction,
  type FleetActionRefusal,
} from '../actions';
import {
  CancelRunDialog,
  HibernateAgentDialog,
  StopEverythingDialog,
  type PreviewState,
} from './FleetDialogs';
import {
  AgentInstancesSection,
  CiJobsSection,
  HostedRunsSection,
  IndexJobsSection,
  MotirStopsSection,
  ownerOf,
  type RowState,
} from './FleetSections';
import { FleetTiles } from './FleetTiles';
import { useFleetRead } from './useFleetRead';
import { useStoredStopResult } from './useStoredStopResult';
import { useFleetTime } from './fleetTime';

/**
 * SETTINGS › ORGANIZATION › FLEET — the island (MOTIR-10369, design
 * `org-admin--fleet.mock.html`).
 *
 * ⚠️ THIS ISLAND DECIDES NOTHING ABOUT WHO MAY STOP. The page rendered it only for
 * an owner or admin, and every action re-asserts that in the service. When the
 * read answers 403/404 (the person lost the role, or the org went), the island
 * hands the decision back to the server with `router.refresh()`.
 *
 * ⚠️ THE STOP RESULT IS THIS ISLAND'S OWN STATE. It survives the 30-second
 * re-read and a press of Refresh, and goes only on Dismiss or when the page is
 * left (design § The result stays until dismissed) — never a toast. It is
 * mirrored into sessionStorage, so a reload keeps it too (the card's criterion).
 */
export interface FleetClientProps {
  orgId: string;
  orgName: string;
  initialFleet: OrgFleetDTO;
  initialReadAt: string;
  /** Whether the viewer may stop this org's fleet work (owner or admin). The
   *  server's stop service decides it again on every action; without it the
   *  island offers no Cancel, Hibernate or Stop everything. */
  canStop: boolean;
}

export function FleetClient({
  orgId,
  orgName,
  initialFleet,
  initialReadAt,
  canStop,
}: FleetClientProps) {
  const t = useTranslations('settings.organization.fleet');
  const router = useRouter();
  const { toast } = useToast();
  const { fleet, readAt, refreshing, refreshFailed, gone, read } = useFleetRead(
    orgId,
    initialFleet,
    initialReadAt,
  );

  // Stops THIS page made, by their `at` — so the last-stop line can say "you"
  // without the read ever carrying a user id.
  const [myStops, setMyStops] = useState<ReadonlySet<string>>(() => new Set());
  const remember = (at: string) => setMyStops((s) => new Set(s).add(at));

  const [result, setResult] = useStoredStopResult(orgId);

  // Row-local state: a Cancel / Hibernate in flight, or a hibernate confirmed
  // here that the next read has not caught up with yet (panel 7c).
  const [hostedBusy, setHostedBusy] = useState<ReadonlyMap<string, RowState>>(() => new Map());
  const [agentState, setAgentState] = useState<
    ReadonlyMap<string, { state: RowState; at?: string }>
  >(() => new Map());

  const [cancelling, setCancelling] = useState<OrgFleetHostedRunDTO | null>(null);
  const [hibernating, setHibernating] = useState<OrgFleetAgentInstanceDTO | null>(null);
  const [stopAllOpen, setStopAllOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const previewSeq = useRef(0);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (gone) router.refresh();
  }, [gone, router]);

  function refused(answer: FleetActionRefusal, notFound: string, failed: string) {
    if (answer.code === 'forbidden') {
      toast({ variant: 'error', title: t('forbidden') });
      router.refresh();
      return;
    }
    toast({ variant: 'error', title: answer.code === 'notFound' ? notFound : failed });
    void read();
  }

  function confirmCancel() {
    const run = cancelling;
    if (!run) return;
    const key = run.card?.key ?? run.projectName ?? '';
    setHostedBusy((m) => new Map(m).set(run.id, 'working'));
    startTransition(async () => {
      const answer = await cancelHostedRunAction(orgId, run.id);
      setCancelling(null);
      setHostedBusy((m) => {
        const next = new Map(m);
        next.delete(run.id);
        return next;
      });
      if (answer.ok) {
        if (answer.outcome.closed) remember(answer.outcome.at);
        else toast({ variant: 'info', title: t('cancelRun.alreadyClosed', { key }) });
        void read();
        return;
      }
      refused(answer, t('cancelRun.notFound'), t('cancelRun.failed', { key }));
    });
  }

  function confirmHibernate() {
    const agent = hibernating;
    if (!agent) return;
    const owner = ownerOf(t, agent);
    setAgentState((m) => new Map(m).set(agent.id, { state: 'working' }));
    startTransition(async () => {
      const answer = await hibernateAgentAction(orgId, agent.id);
      setHibernating(null);
      const settle = (local?: { state: RowState; at?: string }) =>
        setAgentState((m) => {
          const next = new Map(m);
          if (local) next.set(agent.id, local);
          else next.delete(agent.id);
          return next;
        });
      if (answer.ok && answer.code === 'hibernated') {
        settle({ state: 'hibernated', at: answer.at });
        remember(answer.at);
        void read();
        return;
      }
      settle();
      if (answer.ok) {
        toast(
          answer.code === 'alreadyResting'
            ? { variant: 'info', title: t('hibernate.alreadyResting', { owner }) }
            : { variant: 'error', title: t('hibernate.inMotion', { owner }) },
        );
        void read();
        return;
      }
      refused(answer, t('hibernate.notFound'), t('hibernate.failed', { owner }));
    });
  }

  async function loadPreview() {
    const seq = ++previewSeq.current;
    setPreview({ status: 'loading' });
    const answer = await previewStopEverythingAction(orgId);
    if (seq !== previewSeq.current) return;
    if (answer.ok) {
      setPreview({ status: 'ready', preview: answer.preview, countedAt: answer.countedAt });
      return;
    }
    if (answer.code === 'forbidden') {
      closeStopAll();
      refused(answer, '', '');
      return;
    }
    setPreview({ status: 'failed' });
  }

  function openStopAll() {
    setStopAllOpen(true);
    void loadPreview();
  }

  function closeStopAll() {
    previewSeq.current += 1;
    setStopAllOpen(false);
    setPreview({ status: 'idle' });
  }

  function confirmStopAll() {
    if (preview.status !== 'ready') return;
    startTransition(async () => {
      const answer = await stopEverythingAction(orgId);
      closeStopAll();
      if (answer.ok) {
        setResult(answer.result);
        remember(answer.result.stoppedAt);
        void read();
        return;
      }
      refused(answer, t('stopAll.failed'), t('stopAll.failed'));
    });
  }

  const nothingRunning =
    fleet.hostedRuns.kind === 'read' &&
    fleet.hostedRuns.rows.length === 0 &&
    fleet.agentInstances.kind === 'read' &&
    fleet.agentInstances.rows.every((row) => row.state !== 'running') &&
    fleet.ciJobs.kind === 'read' &&
    fleet.ciJobs.rows.length === 0;

  const hibernatingOwner = hibernating ? ownerOf(t, hibernating) : '';
  const cancelPending = isPending && cancelling !== null;
  const hibernatePending = isPending && hibernating !== null;
  const stopAllPending = isPending && stopAllOpen;

  return (
    <div className="mx-auto flex max-w-[64rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="font-sans text-xs text-(--el-text-secondary)">
          {t('breadcrumb', { org: orgName })}
        </p>
        <h1 className="font-serif text-3xl text-(--el-text)">{t('title')}</h1>
        <p className="font-sans text-sm text-(--el-text-secondary)">
          {t.rich('lead', {
            org: orgName,
            link: (chunks) => (
              <Link
                href="/settings/organization/billing#fleet-use"
                className="text-(--el-link) underline underline-offset-2"
              >
                {chunks}
              </Link>
            ),
          })}
        </p>
      </header>

      <div className="flex flex-wrap items-start justify-between gap-3 border-y border-(--el-border) py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <RefreshCue readAt={readAt} refreshing={refreshing} failed={refreshFailed} />
          <LastStopLine orgName={orgName} lastStop={fleet.lastStop} mine={myStops} />
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            variant="secondary"
            leftIcon={refreshing ? undefined : <RotateCw aria-hidden className="h-4 w-4" />}
            loading={refreshing}
            onClick={() => void read()}
          >
            {t('refresh.button')}
          </Button>
          {canStop ? (
            <Button
              variant="secondary"
              leftIcon={<Ban aria-hidden className="h-4 w-4" />}
              disabled={nothingRunning}
              onClick={openStopAll}
              data-testid="fleet-stop-all"
            >
              {t('stopAll.button')}
            </Button>
          ) : null}
        </div>
      </div>

      {result ? <StopResultBanner result={result} onDismiss={() => setResult(null)} /> : null}

      <FleetTiles tiles={fleet.tiles} indexJobs={fleet.indexJobs} onRetry={() => void read()} />

      <HostedRunsSection
        part={fleet.hostedRuns}
        onRetry={() => void read()}
        onCancel={canStop ? setCancelling : undefined}
        busy={hostedBusy}
      />
      <AgentInstancesSection
        part={fleet.agentInstances}
        onRetry={() => void read()}
        onHibernate={canStop ? setHibernating : undefined}
        rowState={agentState}
      />
      <CiJobsSection part={fleet.ciJobs} onRetry={() => void read()} />
      <div className="grid gap-6 md:grid-cols-2">
        <IndexJobsSection part={fleet.indexJobs} onRetry={() => void read()} />
        <MotirStopsSection part={fleet.motirStops} onRetry={() => void read()} />
      </div>

      <CancelRunDialog
        run={cancelling}
        pending={cancelPending}
        onClose={() => setCancelling(null)}
        onConfirm={confirmCancel}
      />
      <HibernateAgentDialog
        agent={hibernating}
        owner={hibernatingOwner}
        isSelf={hibernating?.ownedByViewer ?? false}
        pending={hibernatePending}
        onClose={() => setHibernating(null)}
        onConfirm={confirmHibernate}
      />
      <StopEverythingDialog
        open={stopAllOpen}
        orgName={orgName}
        preview={preview}
        pending={stopAllPending}
        onClose={closeStopAll}
        onRetry={() => void loadPreview()}
        onConfirm={confirmStopAll}
      />
    </div>
  );
}

function RefreshCue({
  readAt,
  refreshing,
  failed,
}: {
  readAt: string;
  refreshing: boolean;
  failed: boolean;
}) {
  const t = useTranslations('settings.organization.fleet.refresh');
  const time = useFleetTime();
  const text = refreshing
    ? t('refreshing')
    : failed
      ? t('failed')
      : t('cue', { time: time.clock(readAt) });
  return (
    <p
      aria-live="polite"
      data-testid="fleet-refresh-cue"
      className="flex items-center gap-1.5 font-sans text-xs text-(--el-text-secondary)"
    >
      {failed && !refreshing ? (
        <TriangleAlert aria-hidden className="h-3.5 w-3.5 text-(--el-warning)" />
      ) : (
        <RotateCw aria-hidden className="h-3.5 w-3.5" />
      )}
      {text}
    </p>
  );
}

function LastStopLine({
  orgName,
  lastStop,
  mine,
}: {
  orgName: string;
  lastStop: OrgFleetDTO['lastStop'];
  mine: ReadonlySet<string>;
}) {
  const t = useTranslations('settings.organization.fleet.lastStop');
  const time = useFleetTime();
  let text: string;
  if (lastStop.kind !== 'read') text = t('failed');
  else if (!lastStop.stop) text = t('never', { org: orgName });
  else {
    const when = time.when(lastStop.stop.at);
    if (mine.has(lastStop.stop.at)) text = t('byYou', { when });
    else if (lastStop.stop.actorName) text = t('by', { name: lastStop.stop.actorName, when });
    else text = t('bySomeone', { when });
  }
  return (
    <p data-testid="fleet-last-stop" className="font-sans text-xs text-(--el-text-secondary)">
      {text}
    </p>
  );
}

/** The Stop everything result, under the refresh bar (panels 9a / 9b). */
function StopResultBanner({
  result,
  onDismiss,
}: {
  result: OrgFleetStopResultDTO;
  onDismiss: () => void;
}) {
  const t = useTranslations('settings.organization.fleet.result');
  const time = useFleetTime();
  const { failures } = result;
  const partial = failures.ci > 0 || failures.hosted > 0 || failures.agents > 0;
  const fail = (text: string) => <span className="block text-xs">{text}</span>;
  return (
    <div
      role="status"
      data-testid="fleet-stop-result"
      data-partial={partial ? 'true' : 'false'}
      className={
        partial
          ? 'flex flex-wrap items-start justify-between gap-3 rounded-(--radius-card) bg-(--el-tint-yellow) p-(--spacing-card-padding) font-sans text-sm text-(--el-text-strong)'
          : 'flex flex-wrap items-start justify-between gap-3 rounded-(--radius-card) bg-(--el-tint-mint) p-(--spacing-card-padding) font-sans text-sm text-(--el-text-strong)'
      }
    >
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 font-semibold">
          {partial ? (
            <TriangleAlert aria-hidden className="h-4 w-4 text-(--el-warning)" />
          ) : (
            <CircleCheck aria-hidden className="h-4 w-4 text-(--el-success)" />
          )}
          {partial ? t('partialTitle') : t('doneTitle')}
        </p>
        <ul className="mt-2 flex flex-col gap-1">
          <li data-testid="fleet-stop-result-ci">
            {t('ci', {
              runs: result.runsCancelled,
              stopped: result.ciContainersStopped,
              total: result.ciContainersStopped + failures.ci,
            })}
            {failures.ci > 0 ? fail(t('ciFailed', { count: failures.ci })) : null}
          </li>
          <li data-testid="fleet-stop-result-hosted">
            {failures.hosted > 0
              ? t('hostedPartial', {
                  done: result.hostedRunsEnded,
                  total: result.hostedRunsEnded + failures.hosted,
                })
              : t('hosted', { count: result.hostedRunsEnded })}
            {failures.hosted > 0 ? fail(t('hostedFailed', { count: failures.hosted })) : null}
          </li>
          <li data-testid="fleet-stop-result-agents">
            {failures.agents > 0
              ? t('agentsPartial', {
                  done: result.agentsHibernated,
                  total: result.agentsHibernated + failures.agents,
                })
              : t('agents', { count: result.agentsHibernated })}
            {failures.agents > 0 ? fail(t('agentsFailed', { count: failures.agents })) : null}
          </li>
          <li>{t('index')}</li>
        </ul>
        <p className="mt-2 text-xs">{t('byYou', { when: time.when(result.stoppedAt) })}</p>
      </div>
      <Button variant="ghost" size="sm" aria-label={t('dismissAria')} onClick={onDismiss}>
        {t('dismiss')}
      </Button>
    </div>
  );
}

import { useFormatter, useTranslations } from 'next-intl';
import { Folder, Layers, Server, Sparkles, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import type { PlatformRole } from '@/generated/prisma/client';
import type {
  FleetOrgPlanDTO,
  FleetOrgRowDTO,
  FleetWindowDTO,
} from '@/lib/dto/platformFleetMonitor';
import type { FleetLastStopDTO } from '@/lib/dto/platformFleetStop';
import { FleetVerdictChip } from '@/app/(admin)/admin/monitoring/_components/FleetVerdictChip';
import { StopContainersDialog } from './StopContainersDialog';

/**
 * FLEET · RUNNING NOW — the org page's Overview card (MOTIR-7320 · design
 * `platform-admin/design-notes.md` § _AMENDMENT 2026-10-02 — Org page · Fleet
 * card and Stop containers_, mock `tenant--stop-containers.mock.html` S1–S4).
 *
 * What one organization is running on Motir's fleet right now and whether it is
 * being charged for it, and — for a `superadmin` — the lever to stop its charged
 * work now. It is NOT a suspension (MOTIR-748): nothing is blocked afterwards.
 *
 * ⚠️ THE SERVER DECIDES WHETHER THE BUTTON IS LIVE; the island only collects the
 * reason and shows the result. `canStop` = `superadmin` AND something chargeable
 * is running (CI runners + hosted agent runs + agent instances — index containers
 * are never stopped, so they never make the control live). The role is enforced
 * again by `stopContainersAction` and by the service, so the disabled control is
 * presentation, never the gate.
 *
 * ⚠️ THE FOOT'S LEFT SLOT HOLDS ONE LINE, so the foot never grows: the role
 * reason (wins), else the last `fleet.stop` row, else _Nothing to stop._, else
 * the explainer. The disabled button is `aria-describedby` that slot.
 *
 * Not async: it reads `useTranslations` / `useFormatter`, which render in a
 * Server Component and under the test's intl provider alike.
 */
export interface OrgFleetCardProps {
  orgId: string;
  orgName: string;
  /** The viewing principal's platform role — decides the control, nothing else. */
  role: PlatformRole;
  row: FleetOrgRowDTO;
  window: FleetWindowDTO;
  lastStop: FleetLastStopDTO | null;
}

const TILES: {
  key: 'ciRunner' | 'hostedAgent' | 'agentInstance' | 'index';
  workload: keyof FleetOrgRowDTO['byWorkload'];
  icon: LucideIcon;
}[] = [
  { key: 'ciRunner', workload: 'ci_runner', icon: Layers },
  { key: 'hostedAgent', workload: 'hosted_agent', icon: Sparkles },
  { key: 'agentInstance', workload: 'agent_instance', icon: Server },
  { key: 'index', workload: 'code_graph_index', icon: Folder },
];

/**
 * The figure the plan holds a tile's workload to (MOTIR-9377): CI to the burst
 * cap (the plan's, or a staff override), hosted runs to the parallel-run figure.
 * Agent instances have none here: the tile counts RUNNING machines, and the plan's
 * org figure counts LIVE agents, running or asleep (MOTIR-9954), so pairing the two
 * would misread — the plan line names that figure instead. Indexing, an exempt org
 * and an unknown plan have none either, so the tile shows a bare count — never a
 * default.
 */
export function tileFigure(
  plan: FleetOrgPlanDTO,
  key: (typeof TILES)[number]['key'],
): { figure: number; override: boolean } | null {
  if (key === 'index' || key === 'agentInstance' || plan.kind === 'plan_unknown') return null;
  if (plan.kind === 'exempt') {
    return key === 'ciRunner' && plan.ciBurstOverride !== null
      ? { figure: plan.ciBurstOverride, override: true }
      : null;
  }
  switch (key) {
    case 'ciRunner':
      return plan.ciBurstCap === null
        ? null
        : { figure: plan.ciBurstCap, override: plan.ciBurstSource === 'override' };
    case 'hostedAgent':
      return { figure: plan.agentRunsInParallel, override: false };
  }
}

/** What a stop would act on — index containers are deliberately left out. */
export function stoppableCount(row: FleetOrgRowDTO): number {
  return row.byWorkload.ci_runner + row.byWorkload.hosted_agent + row.byWorkload.agent_instance;
}

const strong = (chunks: ReactNode) => <strong className="font-semibold">{chunks}</strong>;

export function OrgFleetCard({ orgId, orgName, role, row, window, lastStop }: OrgFleetCardProps) {
  const t = useTranslations('platformAdmin.tenant.fleet');
  const format = useFormatter();
  const running = stoppableCount(row) + row.byWorkload.code_graph_index;
  const isSuperadmin = role === 'superadmin';
  const canStop = isSuperadmin && stoppableCount(row) > 0;
  const footNoteId = `org-fleet-foot-${orgId}`;
  const figures = Object.fromEntries(
    TILES.map(({ key }) => [key, tileFigure(row.plan, key)]),
  ) as Record<(typeof TILES)[number]['key'], ReturnType<typeof tileFigure>>;

  let footNote: ReactNode;
  if (!isSuperadmin) {
    footNote = (
      <p id={footNoteId} className="font-sans text-xs text-(--el-text-secondary)">
        {t.rich('stop.notPermitted', { role, strong })}
      </p>
    );
  } else if (lastStop) {
    footNote = <LastStop id={footNoteId} lastStop={lastStop} />;
  } else if (stoppableCount(row) === 0) {
    footNote = (
      <p id={footNoteId} className="font-sans text-xs text-(--el-text-secondary)">
        {t('stop.nothing')}
      </p>
    );
  } else {
    footNote = (
      <p id={footNoteId} className="font-sans text-xs text-(--el-text-secondary)">
        {t.rich('stop.explainer', { strong })}
      </p>
    );
  }

  return (
    <Card
      data-testid="org-fleet-card"
      header={
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className="inline-flex h-(--height-control-32) w-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-sky) text-(--el-info)"
            >
              <Server className="h-4 w-4" />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="font-sans text-sm font-semibold text-(--el-text)">{t('title')}</h2>
              <p className="font-sans text-xs text-(--el-text-secondary)">
                {running === 0 ? t('subtitleEmpty') : t('subtitle', { org: orgName })}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1" data-testid="org-fleet-verdicts">
            {row.verdicts.map((verdict) => (
              <FleetVerdictChip key={verdict} verdict={verdict} />
            ))}
          </div>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {TILES.map(({ key, workload, icon: Icon }) => (
          <div
            key={key}
            data-testid={`org-fleet-tile-${key}`}
            className={
              key === 'index'
                ? 'flex flex-col gap-1 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-(--spacing-card-padding)'
                : 'flex flex-col gap-1 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-(--spacing-card-padding)'
            }
          >
            <span className="flex items-center gap-1 font-sans text-xs font-medium text-(--el-text-secondary)">
              <Icon aria-hidden className="h-3.5 w-3.5" />
              {t(`workload.${key}`)}
            </span>
            <span className="font-sans text-xl font-semibold tabular-nums text-(--el-text)">
              <span>{format.number(row.byWorkload[workload])}</span>
              {figures[key] ? (
                <span className="font-sans text-sm font-normal text-(--el-text-secondary)">
                  {t('tile.of', { figure: format.number(figures[key].figure) })}
                </span>
              ) : null}
            </span>
            <span className="font-sans text-xs text-(--el-text-secondary)">
              {t(`charge.${key}`)}
              {figures[key]?.override ? ` · ${t('tile.override')}` : null}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-sans text-xs text-(--el-text-secondary)">
        <span data-testid="org-fleet-plan">
          <PlanFacts plan={row.plan} />
        </span>
        <span>
          {t.rich('facts.accrued', {
            minutes: window.windowMinutes,
            value: format.number(row.accruedMinutesInWindow),
            strong,
          })}
        </span>
        <span>
          {t.rich('facts.debited', {
            credits: format.number(row.confirmedCreditsThisMonth),
            strong,
          })}
        </span>
        <span>
          {t.rich('facts.pending', { credits: format.number(row.pendingCredits), strong })}
        </span>
      </p>
      <StopContainersDialog
        orgId={orgId}
        orgName={orgName}
        canStop={canStop}
        footNote={footNote}
        footNoteId={footNoteId}
      />
    </Card>
  );
}

/** The plan line: its name and four figures, or the words for an org no figure
 *  holds and one whose plan could not be read — never a pool. */
function PlanFacts({ plan }: { plan: FleetOrgPlanDTO }) {
  const t = useTranslations('platformAdmin.tenant.fleet.facts');
  const format = useFormatter();
  switch (plan.kind) {
    case 'capped': {
      const figures = {
        plan: plan.planName,
        runs: format.number(plan.agentRunsInParallel),
        perUser: format.number(plan.agentsPerUser),
        agents: format.number(plan.agentsPerOrg),
        strong,
      };
      return plan.ciBurstCap === null
        ? t.rich('planCiUnreadable', figures)
        : t.rich('plan', { ...figures, ci: format.number(plan.ciBurstCap) });
    }
    case 'exempt':
      return plan.ciBurstOverride === null
        ? t.rich('planExempt', { strong })
        : t.rich('planExemptOverride', { ci: format.number(plan.ciBurstOverride), strong });
    case 'plan_unknown':
      return plan.planKey
        ? t.rich('planUnknown', { key: plan.planKey, strong })
        : t.rich('planUnknownNoKey', { strong });
  }
}

function LastStop({ id, lastStop }: { id: string; lastStop: FleetLastStopDTO }) {
  const t = useTranslations('platformAdmin.tenant.fleet.last');
  const format = useFormatter();
  return (
    <dl
      id={id}
      data-testid="org-fleet-last-stop"
      className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-sans text-xs text-(--el-text-secondary)"
    >
      <dt className="font-medium">{t('title')}</dt>
      <dd className="text-(--el-text)">
        {t('when', {
          time: format.relativeTime(new Date(lastStop.at)),
          actor: lastStop.actorEmail ?? t('unknownActor'),
        })}
      </dd>
      <dt className="font-medium">{t('reason')}</dt>
      <dd className="text-(--el-text)">{lastStop.reason ?? t('noReason')}</dd>
      <dt className="font-medium">{t('stopped')}</dt>
      <dd className="text-(--el-text)">
        {t('counts', {
          runs: format.number(lastStop.runsCancelled),
          containers: format.number(lastStop.ciContainersStopped),
          hosted: format.number(lastStop.hostedRunsEnded),
          instances: format.number(lastStop.agentInstancesHibernated),
        })}
      </dd>
    </dl>
  );
}

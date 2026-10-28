import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import {
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  Info,
  Pause,
  Server,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import {
  isFleetMismatch,
  type FleetKillDTO,
  type FleetKillsDTO,
  type FleetOrgPlanDTO,
  type FleetOrgRowDTO,
  type FleetRunningOrgsDTO,
} from '@/lib/dto/platformFleetMonitor';
import { FleetVerdictChip } from './FleetVerdictChip';

/**
 * MONITORING · FLEET (MOTIR-7319 · design MOTIR-7314, `platform-admin/design-notes.md`
 * § _AMENDMENT 2026-10-02 — Monitoring · Fleet_, `monitoring--fleet.mock.html`).
 *
 * Two cards appended after the Index-allowance section: the organisations
 * running containers (mismatched first) and the reconciler's kills over the last
 * 24 hours. Mirrors `IndexAllowanceSection` one-for-one: a server component, no
 * client island, no poll — a poll would put a cross-tenant audited read on a timer.
 *
 * ⚠️ READ AND LINK, NEVER REMEDIATE. The ONE way to act is the org name, a plain
 * link to `/admin/tenants/[orgId]`, where the Stop control lives (MOTIR-7320).
 *
 * ⚠️ EACH CARD OWNS ITS OWN FAILURE. The page hands each read in already
 * settled (`FleetRead`), so a failed fleet read renders its ErrorState in its own
 * card and every other section of the page — Panel 8, the Index allowance, the
 * other fleet card — still renders. A failed read renders NO figure: never a zero.
 *
 * ⚠️ THIS FILE COMPUTES NO VERDICT. It renders what `platformFleetMonitorService`
 * judged (MOTIR-7316); the order of the rows is the service's too.
 */

/** A read the page already settled — the card renders its failure, never throws. */
export type FleetRead<T> = { status: 'ok'; data: T } | { status: 'failed' };

/** The page's search params, carried through every pager link so paging one list
 *  never resets another (the Stopped list's `page`, `reason`, `q`). */
export type FleetQuery = Record<string, string | undefined>;

export const FLEET_PAGE_PARAM = 'fleetPage';
export const KILLS_PAGE_PARAM = 'killsPage';

type T = Awaited<ReturnType<typeof getTranslations<'platformAdmin.monitoring.fleet'>>>;

export async function FleetSection({
  orgs,
  kills,
  query,
  now,
}: {
  orgs: FleetRead<FleetRunningOrgsDTO>;
  kills: FleetRead<FleetKillsDTO>;
  query: FleetQuery;
  now: Date;
}) {
  const t = await getTranslations('platformAdmin.monitoring.fleet');

  // Off-cloud there is no orchestrator: ONE card replaces both, and no figure
  // is drawn — a disabled fleet has nothing to count, and a zero would claim a
  // measurement.
  const disabled =
    (orgs.status === 'ok' && orgs.data.meter === 'disabled') ||
    (kills.status === 'ok' && kills.data.meter === 'disabled');
  if (disabled) {
    return (
      <Card
        data-testid="fleet-disabled"
        header={
          <CardHead
            icon={<Server className="h-4 w-4" />}
            title={t('disabled.title')}
            subtitle={t('disabled.subtitle')}
            pills={
              <Pill tone="neutral">
                <CircleMinus aria-hidden className="h-3 w-3" />
                {t('disabled.pill')}
              </Pill>
            }
          />
        }
      >
        <InsetState icon={<Server className="h-5 w-5" />} title={t('disabled.empty.title')}>
          {t('disabled.empty.body')}
        </InsetState>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <OrgsCard read={orgs} query={query} now={now} />
      <KillsCard read={kills} query={query} now={now} />
    </div>
  );
}

// ── Organisations running containers ─────────────────────────────────────────

async function OrgsCard({
  read,
  query,
  now,
}: {
  read: FleetRead<FleetRunningOrgsDTO>;
  query: FleetQuery;
  now: Date;
}) {
  const t = await getTranslations('platformAdmin.monitoring.fleet');
  const format = await getFormatter();
  const data = read.status === 'ok' && read.data.meter === 'enabled' ? read.data : null;
  // The window the verdicts were judged over, in minutes — read from the DTO so
  // the copy moves with the debit period. Before a read answers, the design's
  // two-period window is still what the subtitle describes.
  const minutes = data?.window.windowMinutes ?? 10;

  const head = (pills: React.ReactNode) => (
    <CardHead
      icon={<Server className="h-4 w-4" />}
      title={t('orgs.title')}
      subtitle={t('orgs.subtitle', { minutes })}
      pills={pills}
    />
  );

  if (!data) {
    return (
      <Card data-testid="fleet-orgs" data-state="failed" header={head(null)}>
        <InsetState
          tone="error"
          icon={<TriangleAlert className="h-5 w-5" />}
          title={t('orgs.error.title')}
        >
          {t('orgs.error.body')}
        </InsetState>
      </Card>
    );
  }

  if (data.total === 0) {
    return (
      <Card
        data-testid="fleet-orgs"
        data-state="empty"
        header={head(
          <Pill severity="success">
            <CircleCheck aria-hidden className="h-3 w-3" />
            {t('orgs.noMismatch')}
          </Pill>,
        )}
      >
        <InsetState icon={<Server className="h-5 w-5" />} title={t('orgs.empty.title')}>
          {t('orgs.empty.body')}
        </InsetState>
      </Card>
    );
  }

  const from = (data.page - 1) * data.pageSize + 1;
  const to = Math.min(data.total, data.page * data.pageSize);

  return (
    <Card
      data-testid="fleet-orgs"
      data-state="populated"
      header={head(
        <>
          {data.mismatched > 0 ? (
            <Pill severity="danger">
              <TriangleAlert aria-hidden className="h-3 w-3" />
              {t('orgs.mismatchedCount', { count: data.mismatched })}
            </Pill>
          ) : (
            <Pill severity="success">
              <CircleCheck aria-hidden className="h-3 w-3" />
              {t('orgs.noMismatch')}
            </Pill>
          )}
          <Pill tone="neutral">{t('orgs.runningCount', { count: data.total })}</Pill>
        </>,
      )}
      footer={
        <Foot
          note={t('orgs.foot', { from, to, total: data.total })}
          label={t('orgs.pagerLabel')}
          page={data.page}
          pageCount={data.pageCount}
          hrefFor={(page) => hrefWith(query, FLEET_PAGE_PARAM, page)}
          t={t}
        />
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <MiniStat value={format.number(data.total)} label={t('orgs.stat.orgs')} />
          <MiniStat value={format.number(data.ciRunners)} label={t('orgs.stat.ciRunners')} />
          <MiniStat value={format.number(data.hostedAgents)} label={t('orgs.stat.hostedAgents')} />
          <MiniStat value={format.number(data.agentInstances)} label={t('orgs.stat.instances')} />
          <MiniStat value={format.number(data.mismatched)} label={t('orgs.stat.mismatched')} />
        </div>
        {/* The wide table scrolls INSIDE its own box; the page body never scrolls sideways. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[64rem] border-collapse font-sans text-sm">
            <thead>
              <tr>
                <th colSpan={2} />
                {/* Each workload against its OWN plan figure (MOTIR-9377, the
                    fleet-capacity decision MOTIR-9357) — no shared pool. */}
                <th
                  scope="colgroup"
                  colSpan={3}
                  className="border-b-2 border-(--el-border-strong) pb-1 pt-2 text-center font-sans text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)"
                >
                  {t('orgs.group.plan')}
                </th>
                <th
                  scope="colgroup"
                  className="border-b-2 border-l border-dashed border-(--el-border-strong) pb-1 pl-2 pt-2 text-center font-sans text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)"
                >
                  {t('orgs.group.uncapped')}
                </th>
                <th colSpan={3} />
              </tr>
              <tr className="border-b border-(--el-border) text-left">
                <Th>{t('orgs.col.org')}</Th>
                <Th>{t('orgs.col.plan')}</Th>
                <Th numeric>{t('orgs.col.ciRunner')}</Th>
                <Th numeric>{t('orgs.col.hostedAgent')}</Th>
                <Th numeric>{t('orgs.col.agentInstance')}</Th>
                <Th numeric own>
                  {t('orgs.col.index')}
                </Th>
                <Th numeric>{t('orgs.col.accrued', { minutes })}</Th>
                <Th numeric>{t('orgs.col.credits')}</Th>
                <Th>{t('orgs.col.verdict')}</Th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <OrgRow key={row.organizationId} row={row} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

async function OrgRow({ row, now }: { row: FleetOrgRowDTO; now: Date }) {
  const t = await getTranslations('platformAdmin.monitoring.fleet');
  const format = await getFormatter();
  const mismatch = row.verdicts.some(isFleetMismatch);
  const notCharged = row.verdicts.includes('not_charged');
  const name = row.name ?? t('orgs.unnamed', { id: row.organizationId });

  return (
    <tr
      data-org={row.organizationId}
      data-mismatch={mismatch ? 'true' : undefined}
      className="border-b border-(--el-border-soft)"
    >
      {/* A mismatched row carries a danger RAIL on its leading cell as well as its
          chip — a graphic beside the word (3:1 suffices), never the only signal. */}
      <Td rail={mismatch}>
        <span className="flex min-w-0 items-start gap-2">
          <Avatar name={name} />
          <span className="flex min-w-0 flex-col">
            <OrgLink id={row.organizationId} name={name} />
            {row.isMeta ? (
              <span className="text-xs text-(--el-text-secondary)">{t('orgs.metaTag')}</span>
            ) : null}
          </span>
        </span>
      </Td>
      <Td>
        <PlanCell plan={row.plan} />
      </Td>
      <UsedOf
        n={row.byWorkload.ci_runner}
        figure={ciFigure(row.plan)}
        override={ciOverridden(row.plan)}
      />
      <UsedOf
        n={row.byWorkload.hosted_agent}
        figure={capped(row.plan)?.agentRunsInParallel ?? null}
      />
      {/* The org's LIVE agents, running or asleep — what its figure counts (MOTIR-9954). */}
      <UsedOf n={row.agentsLive} figure={capped(row.plan)?.agentsPerOrg ?? null} />
      {/* Indexing is held to no plan figure: a bare count, always. */}
      <Count n={row.byWorkload.code_graph_index} own />
      <Td numeric>
        {row.accruedMinutesInWindow === 0 ? (
          <>
            <span className="italic text-(--el-text-secondary)">{t('orgs.accrued.none')}</span>
            {row.latestAccrualTickAt ? (
              <Sub>
                {t('orgs.accrued.lastTick', {
                  age: ago(t, secondsBetween(row.latestAccrualTickAt, now)),
                })}
              </Sub>
            ) : null}
          </>
        ) : (
          <span className="tabular-nums text-(--el-text)">
            {t('orgs.accrued.minutes', { minutes: format.number(row.accruedMinutesInWindow) })}
          </span>
        )}
      </Td>
      <Td numeric>
        {notCharged ? (
          // The meta org (or an inert meter) is never debited: a number here would
          // read as a debit of zero.
          <span className="italic text-(--el-text-secondary)">{t('orgs.credits.notCharged')}</span>
        ) : (
          <>
            <span className="tabular-nums text-(--el-text)">
              {format.number(row.confirmedCreditsThisMonth)}
            </span>
            {row.pendingCredits > 0 ? (
              <Sub>
                {row.pendingSince
                  ? t('orgs.credits.pending', {
                      credits: format.number(row.pendingCredits),
                      age: duration(t, secondsBetween(row.pendingSince, now)),
                    })
                  : t('orgs.credits.pendingNoAge', {
                      credits: format.number(row.pendingCredits),
                    })}
              </Sub>
            ) : null}
            {row.balanceCredits !== null && row.balanceCredits <= 0 ? (
              <Sub>{t('orgs.credits.balance', { credits: format.number(row.balanceCredits) })}</Sub>
            ) : null}
            {row.verdicts.includes('balance_unknown') ? (
              <Sub>{t('orgs.credits.unreadable')}</Sub>
            ) : null}
          </>
        )}
      </Td>
      <Td>
        <span className="flex flex-wrap gap-1">
          {row.verdicts.map((verdict) => (
            <FleetVerdictChip key={verdict} verdict={verdict} />
          ))}
        </span>
      </Td>
    </tr>
  );
}

// ── The plan's figures (MOTIR-9377 · design MOTIR-9382) ─────────────────────

type CappedPlan = Extract<FleetOrgPlanDTO, { kind: 'capped' }>;

function capped(plan: FleetOrgPlanDTO): CappedPlan | null {
  return plan.kind === 'capped' ? plan : null;
}

/** The figure CI admission holds the org to: the plan's or the staff override.
 *  An exempt org is held only by an override; an unknown plan by nothing shown. */
function ciFigure(plan: FleetOrgPlanDTO): number | null {
  switch (plan.kind) {
    case 'capped':
      return plan.ciBurstCap;
    case 'exempt':
      return plan.ciBurstOverride;
    case 'plan_unknown':
      return null;
  }
}

function ciOverridden(plan: FleetOrgPlanDTO): boolean {
  switch (plan.kind) {
    case 'capped':
      return plan.ciBurstSource === 'override';
    case 'exempt':
      return plan.ciBurstOverride !== null;
    case 'plan_unknown':
      return false;
  }
}

/** The Plan column: the plan's name and its per-person figure, or the words for
 *  an org no figure holds and one whose plan could not be read — never a figure. */
export async function PlanCell({ plan }: { plan: FleetOrgPlanDTO }) {
  const t = await getTranslations('platformAdmin.monitoring.fleet');
  const format = await getFormatter();
  switch (plan.kind) {
    case 'capped':
      return (
        <span className="whitespace-nowrap font-medium text-(--el-text)">
          {t.rich('orgs.plan.named', {
            plan: plan.planName,
            perUser: format.number(plan.agentsPerUser),
            pp: (chunks) => (
              <span className="font-normal text-(--el-text-secondary)">{chunks}</span>
            ),
          })}
        </span>
      );
    case 'exempt':
      return <span className="italic text-(--el-text-secondary)">{t('orgs.plan.exempt')}</span>;
    case 'plan_unknown':
      return (
        <>
          <Pill tone="awaiting" data-plan="unknown">
            <CircleHelp aria-hidden className="h-3 w-3 shrink-0" />
            {plan.planKey
              ? t('orgs.plan.unknown', { key: plan.planKey })
              : t('orgs.plan.unknownNoKey')}
          </Pill>
          <Sub>{t('orgs.plan.unknownNote')}</Sub>
        </>
      );
  }
}

/** A capped workload: `{used} of {figure}` over the usage bar, full and in the
 *  warning fill at the figure. With no figure it is a bare count. */
async function UsedOf({
  n,
  figure,
  override = false,
}: {
  n: number;
  figure: number | null;
  override?: boolean;
}) {
  if (figure === null) return <Count n={n} />;
  const t = await getTranslations('platformAdmin.monitoring.fleet');
  const format = await getFormatter();
  const atFigure = n >= figure;
  return (
    <Td numeric>
      <span className="flex min-w-[5rem] flex-col items-end gap-1">
        <span className="tabular-nums text-(--el-text-secondary)">
          {t.rich('orgs.usedOf', {
            used: format.number(n),
            figure: format.number(figure),
            b: (chunks) => <span className="font-semibold text-(--el-text)">{chunks}</span>,
          })}
        </span>
        <span
          aria-hidden
          className="block h-2 w-full overflow-hidden rounded-(--radius-badge) bg-(--el-surface)"
        >
          <span
            data-at-figure={atFigure ? 'true' : undefined}
            className={`block h-full rounded-(--radius-badge) ${atFigure ? 'bg-(--el-warning)' : 'bg-(--el-accent)'}`}
            style={{ width: `${atFigure ? 100 : usedPct(n, figure)}%` }}
          />
        </span>
        {override ? <Sub>{t('orgs.override')}</Sub> : null}
      </span>
    </Td>
  );
}

// ── Reconciler kills ─────────────────────────────────────────────────────────

const KILL_REASONS = ['no_record', 'record_ended', 'org_stopped'] as const;
type KillReason = (typeof KILL_REASONS)[number];
const isKillReason = (reason: string): reason is KillReason =>
  (KILL_REASONS as readonly string[]).includes(reason);

/** A kill the provider REFUSED: not completed, a failure recorded. */
export function isFailedKill(kill: Pick<FleetKillDTO, 'completedAt' | 'failureDetail'>): boolean {
  return kill.completedAt === null && kill.failureDetail !== null;
}

async function KillsCard({
  read,
  query,
  now,
}: {
  read: FleetRead<FleetKillsDTO>;
  query: FleetQuery;
  now: Date;
}) {
  const t = await getTranslations('platformAdmin.monitoring.fleet');
  const data = read.status === 'ok' && read.data.meter === 'enabled' ? read.data : null;

  const head = (pills: React.ReactNode) => (
    <CardHead
      icon={<Trash2 className="h-4 w-4" />}
      title={t('kills.title')}
      subtitle={t('kills.subtitle')}
      pills={pills}
    />
  );

  if (!data) {
    return (
      <Card data-testid="fleet-kills" data-state="failed" header={head(null)}>
        <InsetState
          tone="error"
          icon={<TriangleAlert className="h-5 w-5" />}
          title={t('kills.error.title')}
        >
          {t('kills.error.body')}
        </InsetState>
      </Card>
    );
  }

  if (data.total === 0) {
    return (
      <Card
        data-testid="fleet-kills"
        data-state="empty"
        header={head(
          <Pill severity="success">
            <CircleCheck aria-hidden className="h-3 w-3" />
            {t('kills.none')}
          </Pill>,
        )}
      >
        <InsetState icon={<Trash2 className="h-5 w-5" />} title={t('kills.empty.title')}>
          {t('kills.empty.body')}
        </InsetState>
      </Card>
    );
  }

  const from = (data.page - 1) * data.pageSize + 1;
  const to = Math.min(data.total, data.page * data.pageSize);

  return (
    <Card
      data-testid="fleet-kills"
      data-state="populated"
      header={head(
        <>
          {data.failed > 0 ? (
            <Pill severity="danger">
              <TriangleAlert aria-hidden className="h-3 w-3" />
              {t('kills.failedCount', { count: data.failed })}
            </Pill>
          ) : null}
          <Pill tone="neutral">{t('kills.total', { count: data.total })}</Pill>
        </>,
      )}
      footer={
        <Foot
          note={t('kills.foot', { from, to, total: data.total })}
          label={t('kills.pagerLabel')}
          page={data.page}
          pageCount={data.pageCount}
          hrefFor={(page) => hrefWith(query, KILLS_PAGE_PARAM, page)}
          t={t}
        />
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] border-collapse font-sans text-sm">
          <thead>
            <tr className="border-b border-(--el-border) text-left">
              <Th sorted>
                {t('kills.col.when')}
                <ArrowDown aria-hidden className="ml-1 inline h-3 w-3" />
              </Th>
              <Th>{t('kills.col.app')}</Th>
              <Th>{t('kills.col.machine')}</Th>
              <Th numeric>{t('kills.col.age')}</Th>
              <Th>{t('kills.col.reason')}</Th>
              <Th>{t('kills.col.action')}</Th>
              <Th>{t('kills.col.org')}</Th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((kill) => {
              const failed = isFailedKill(kill);
              return (
                <tr
                  key={kill.id}
                  data-kill={kill.id}
                  data-failed={failed ? 'true' : undefined}
                  className="border-b border-(--el-border-soft)"
                >
                  <Td rail={failed} className="whitespace-nowrap text-(--el-text-secondary)">
                    {ago(t, secondsBetween(kill.decidedAt, now))}
                  </Td>
                  <Td>
                    <Mono>{kill.app}</Mono>
                  </Td>
                  <Td>
                    <Mono>{kill.machineId}</Mono>
                    {kill.machineName ? <Sub>{kill.machineName}</Sub> : null}
                  </Td>
                  <Td numeric className="whitespace-nowrap tabular-nums text-(--el-text)">
                    {duration(t, kill.ageSeconds)}
                  </Td>
                  <Td>
                    {isKillReason(kill.reason) ? (
                      <>
                        <span className="font-medium text-(--el-text)">
                          {t(`kills.reason.${kill.reason}`)}
                        </span>
                        <Sub>{t(`kills.reason.${kill.reason}Gloss`)}</Sub>
                      </>
                    ) : (
                      <Mono>{kill.reason}</Mono>
                    )}
                  </Td>
                  <Td>
                    <KillAction kill={kill} failed={failed} />
                  </Td>
                  <Td>
                    {kill.organizationId ? (
                      <KillOrg id={kill.organizationId} name={kill.organizationName} />
                    ) : (
                      <span className="text-(--el-text-secondary)">{t('kills.noOrg')}</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

async function KillAction({ kill, failed }: { kill: FleetKillDTO; failed: boolean }) {
  const t = await getTranslations('platformAdmin.monitoring.fleet');
  const stop = kill.action === 'stopped';
  if (failed) {
    return (
      <span className="flex flex-col items-start gap-1">
        <Pill severity="danger">
          <TriangleAlert aria-hidden className="h-3 w-3" />
          {stop ? t('kills.action.stopFailed') : t('kills.action.destroyFailed')}
        </Pill>
        {/* The provider's refusal, verbatim — the operator needs the real words. */}
        <span className="flex max-w-[52ch] items-start gap-1 text-xs text-(--el-danger-on-surface)">
          <TriangleAlert aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{t('kills.failureDetail', { detail: kill.failureDetail ?? '' })}</span>
        </span>
      </span>
    );
  }
  if (kill.action !== 'destroyed' && !stop) {
    return <Pill tone="neutral">{kill.action}</Pill>;
  }
  const Icon = stop ? Pause : Trash2;
  return (
    <Pill tone="neutral">
      <Icon aria-hidden className="h-3 w-3" />
      {stop ? t('kills.action.stopped') : t('kills.action.destroyed')}
    </Pill>
  );
}

async function KillOrg({ id, name }: { id: string; name: string | null }) {
  const t = await getTranslations('platformAdmin.monitoring.fleet');
  const label = name ?? t('orgs.unnamed', { id });
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar name={label} />
      <OrgLink id={id} name={label} />
    </span>
  );
}

// ── Shared pieces ────────────────────────────────────────────────────────────

/** `?…` for `param=page`, keeping every other list's place on the page. */
export function hrefWith(query: FleetQuery, param: string, page: number): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '' && key !== param) next.set(key, value);
  }
  if (page > 1) next.set(param, String(page));
  const qs = next.toString();
  return qs ? `?${qs}` : '?';
}

function secondsBetween(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
}

/** A fine-grained duration: "48 min", "2 h 14 min", "6 d 3 h". */
export function duration(t: T, seconds: number): string {
  if (seconds < 60) return t('duration.seconds', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('duration.minutes', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const m = minutes % 60;
    return m === 0
      ? t('duration.hours', { h: hours })
      : t('duration.hoursMinutes', { h: hours, m });
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h === 0 ? t('duration.days', { d: days }) : t('duration.daysHours', { d: days, h });
}

/** A coarse relative time: "3 min ago", "2 h ago" — one unit, as the design's When. */
export function ago(t: T, seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const age =
    seconds < 60
      ? t('duration.seconds', { n: seconds })
      : minutes < 60
        ? t('duration.minutes', { n: minutes })
        : hours < 24
          ? t('duration.hours', { h: hours })
          : t('duration.days', { d: Math.floor(hours / 24) });
  return t('ago', { age });
}

function usedPct(used: number, figure: number): number {
  if (used <= 0) return 0;
  return Math.min(100, Math.max(1, Math.round((used / figure) * 100)));
}

/** The card header: icon tile, title, subtitle, pills. The Pools section's blocks
 *  (MOTIR-9563) sit one level down, so they title it with an `h3`. */
export function CardHead({
  icon,
  title,
  subtitle,
  pills,
  level = 2,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  pills: React.ReactNode;
  level?: 2 | 3;
}) {
  const Heading = level === 3 ? 'h3' : 'h2';
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className="inline-flex h-(--height-control-32) w-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-lavender) text-(--el-text-strong)"
        >
          {icon}
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <Heading className="font-sans text-sm font-semibold text-(--el-text)">{title}</Heading>
          <p className="font-sans text-xs text-(--el-text-secondary)">{subtitle}</p>
        </div>
      </div>
      {pills ? <div className="flex flex-wrap justify-end gap-1.5">{pills}</div> : null}
    </div>
  );
}

/** An EmptyState / ErrorState drawn INSIDE a card body — the card is the frame. */
export function InsetState({
  icon,
  title,
  tone = 'neutral',
  level = 3,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  tone?: 'neutral' | 'error';
  level?: 3 | 4;
  children: React.ReactNode;
}) {
  const Heading = level === 4 ? 'h4' : 'h3';
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className="flex flex-col items-center gap-2 py-6 text-center"
    >
      <span
        aria-hidden
        className={`inline-flex h-11 w-11 items-center justify-center rounded-(--radius-card) ${
          tone === 'error'
            ? 'bg-(--el-tint-rose) text-(--el-danger)'
            : 'bg-(--el-surface) text-(--el-text-secondary)'
        }`}
      >
        {icon}
      </span>
      <Heading className="font-serif text-base text-(--el-text)">{title}</Heading>
      <p className="max-w-prose font-sans text-xs text-(--el-text-secondary)">{children}</p>
    </div>
  );
}

export function Foot({
  note,
  label,
  page,
  pageCount,
  hrefFor,
  t,
}: {
  note: string;
  label: string;
  page: number;
  pageCount: number;
  hrefFor: (page: number) => string;
  t: T;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="flex items-start gap-1 font-sans text-xs text-(--el-text-secondary)">
        <Info aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
        {note}
      </p>
      <nav aria-label={label} className="flex items-center gap-2 font-sans text-sm">
        <PagerLink href={hrefFor(page - 1)} disabled={page <= 1}>
          <ChevronLeft aria-hidden className="h-4 w-4" />
          {t('prev')}
        </PagerLink>
        <span className="text-(--el-text-secondary)">
          {t('pageOf', { page, pages: pageCount })}
        </span>
        <PagerLink href={hrefFor(page + 1)} disabled={page >= pageCount}>
          {t('next')}
          <ChevronRight aria-hidden className="h-4 w-4" />
        </PagerLink>
      </nav>
    </div>
  );
}

function PagerLink({
  href,
  disabled,
  children,
}: {
  href: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  const className =
    'inline-flex h-(--height-btn-sm) items-center gap-1 rounded-(--radius-btn) border border-(--el-border) px-(--spacing-btn-x) text-(--el-text)';
  return disabled ? (
    <span
      aria-disabled="true"
      className={`${className} cursor-not-allowed text-(--el-text-secondary)`}
    >
      {children}
    </span>
  ) : (
    <Link
      href={href}
      scroll={false}
      className={`${className} hover:bg-(--el-surface) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)`}
    >
      {children}
    </Link>
  );
}

function OrgLink({ id, name }: { id: string; name: string }) {
  return (
    <Link
      href={`/admin/tenants/${id}`}
      className="font-medium text-(--el-link) underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
    >
      {name}
    </Link>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-lavender) text-[10px] font-bold text-(--el-text-strong)"
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/** A figure tile. `missing` sets the value in italic secondary — a WORD standing
 *  where no figure could be read (the Pools section's _Not available_). */
export function MiniStat({
  value,
  label,
  missing,
  sub,
}: {
  value: string;
  label: string;
  missing?: boolean;
  sub?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-page-bg) p-(--spacing-card-padding-12)">
      <span
        className={`font-serif text-xl ${missing ? 'italic text-(--el-text-secondary)' : 'text-(--el-text)'}`}
      >
        {value}
      </span>
      <span className="font-sans text-xs text-(--el-text-secondary)">{label}</span>
      {sub ? <span className="font-sans text-xs text-(--el-text-secondary)">{sub}</span> : null}
    </div>
  );
}

function Count({ n, own }: { n: number; own?: boolean }) {
  return (
    <Td numeric own={own} className="tabular-nums">
      <span className={n === 0 ? 'text-(--el-text-secondary)' : 'text-(--el-text)'}>{n}</span>
    </Td>
  );
}

export function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-xs text-(--el-text-identifier)">{children}</span>;
}

export function Sub({ children }: { children: React.ReactNode }) {
  return (
    <span className="mt-0.5 block whitespace-nowrap text-xs text-(--el-text-secondary)">
      {children}
    </span>
  );
}

export function Th({
  children,
  numeric,
  sorted,
  own,
  scope,
}: {
  children?: React.ReactNode;
  numeric?: boolean;
  sorted?: boolean;
  own?: boolean;
  scope?: 'col';
}) {
  return (
    <th
      scope={scope}
      aria-sort={sorted ? 'descending' : undefined}
      className={`py-2 pr-3 align-bottom font-sans text-xs font-medium uppercase tracking-wide first:pl-3 ${numeric ? 'text-right' : ''} ${own ? 'border-l border-dashed border-(--el-border-strong) pl-2' : ''} ${sorted ? 'text-(--el-text-strong)' : 'text-(--el-text-secondary)'}`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  numeric,
  own,
  rail,
  className = '',
}: {
  children: React.ReactNode;
  numeric?: boolean;
  own?: boolean;
  /** The 3px leading rail: danger on a mismatched or failed row (`true`), warning
   *  on a Pools account past 70% (`'warning'`). */
  rail?: boolean | 'warning';
  className?: string;
}) {
  const railTone = rail === 'warning' ? 'warning' : rail ? 'danger' : undefined;
  return (
    <td
      data-rail={railTone}
      className={`py-2 pr-3 align-top ${numeric ? 'text-right' : ''} ${own ? 'border-l border-dashed border-(--el-border-strong) pl-2' : ''} ${rail === undefined ? '' : `border-l-[3px] pl-3 ${railTone === 'warning' ? 'border-l-(--el-warning)' : railTone === 'danger' ? 'border-l-(--el-danger)' : 'border-l-transparent'}`} ${className}`}
    >
      {children}
    </td>
  );
}

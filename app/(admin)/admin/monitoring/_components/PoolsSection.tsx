import { getFormatter, getTranslations } from 'next-intl/server';
import {
  ArrowDown,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  Cloud,
  Cpu,
  Hourglass,
  Info,
  Plane,
  Server,
  Sprout,
  TriangleAlert,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { HEADROOM_ALERT_FRACTION } from '@/lib/ciFleet/shardTargets';
import type { FleetGrowthEventViewDTO, FleetQuotaRequestStatusDTO } from '@/lib/dto/fleetPools';
import type {
  PlatformPoolAccountDTO,
  PlatformPoolBlockDTO,
  PlatformPoolRequestDTO,
  PlatformPoolSpareDTO,
  PlatformPoolsDTO,
  PlatformPoolTotalDTO,
} from '@/lib/dto/platformFleetPools';
import {
  CardHead,
  Foot,
  InsetState,
  MiniStat,
  Mono,
  Sub,
  Td,
  Th,
  ago,
  hrefWith,
  type FleetQuery,
  type FleetRead,
} from './FleetSection';

/**
 * MONITORING · POOLS (MOTIR-9563 · design MOTIR-9561, `platform-admin/design-notes.md`
 * § _AMENDMENT 2026-10-25 — Monitoring · Pools_, `monitoring--pools.mock.html`).
 *
 * The last section of the page, after the Fleet section: one Pool block per fleet
 * kind, in the order `platformFleetPoolsService.listPools` returns them. A server
 * component, no client island, no poll — each load is one audited read.
 *
 * ⚠️ A NULL IS NEVER RENDERED AS A NUMBER. A granted quota AWS has not answered for
 * is the Not-read mark; every figure computed from it (that account's percent and
 * distance to 70%, the pool's capacity and percent) reads _Not available_. There
 * is no `?? 0`, no `|| 0` and no dash standing in for a count anywhere below.
 *
 * ⚠️ READ-ONLY. The only interactive elements are the pager links; asking AWS
 * for quota is the `fleet-admin request-quota` command, named in plain text.
 *
 * ⚠️ EACH BLOCK OWNS ITS OWN FAILURE. A kind the service answered `unavailable`
 * renders its error inside its own card; a whole read the page could not settle
 * renders one error for the section, and the rest of the page still renders.
 */

/** The page's settled read — the Fleet section's own shape. */
export type PoolsRead = FleetRead<PlatformPoolsDTO>;

/** Rows per page of a block's request list and event list (the design's 1–10). */
export const POOLS_PAGE_SIZE = 10;

/** The search param that pages one kind's quota raises. Per list and per kind, so
 *  paging one list never resets another. */
export function poolRequestsParam(kind: string): string {
  return `poolRequests_${kind}`;
}

/** The search param that pages one kind's growth events. */
export function poolEventsParam(kind: string): string {
  return `poolEvents_${kind}`;
}

type T = Awaited<ReturnType<typeof getTranslations<'platformAdmin.monitoring.pools'>>>;
type FleetT = Awaited<ReturnType<typeof getTranslations<'platformAdmin.monitoring.fleet'>>>;
type AwsBlock = Extract<PlatformPoolBlockDTO, { provider: 'aws' }>;

const REQUEST_COMMAND = 'fleet-admin request-quota --account <name> --vcpu <n>';
const ADD_SHARD_COMMAND = 'fleet-admin add-shard';

export async function PoolsSection({
  read,
  query,
  now,
}: {
  read: PoolsRead;
  query: FleetQuery;
  now: Date;
}) {
  const t = await getTranslations('platformAdmin.monitoring.pools');

  return (
    <section
      aria-labelledby="pools-heading"
      data-testid="pools-section"
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id="pools-heading" className="font-serif text-xl text-(--el-text)">
          {t('title')}
        </h2>
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">{t('subtitle')}</p>
      </div>
      {read.status === 'failed' ? (
        <Card data-testid="pools-failed" data-state="failed">
          <InsetState
            tone="error"
            icon={<TriangleAlert className="h-5 w-5" />}
            title={t('sectionError.title')}
          >
            {t('sectionError.body')}
          </InsetState>
        </Card>
      ) : (
        read.data.blocks.map((block) => (
          <PoolBlock key={block.fleetKind} block={block} query={query} now={now} />
        ))
      )}
    </section>
  );
}

// ── The Pool block ───────────────────────────────────────────────────────────

async function PoolBlock({
  block,
  query,
  now,
}: {
  block: PlatformPoolBlockDTO;
  query: FleetQuery;
  now: Date;
}) {
  const t = await getTranslations('platformAdmin.monitoring.pools');
  const kind = t(`kind.${block.fleetKind}`);
  const title = t('block.title', { kind });
  const testId = `pool-${block.fleetKind}`;

  if (block.provider === 'unavailable') {
    // No provider is claimed and no figure drawn: the read did not answer.
    return (
      <Card
        data-testid={testId}
        data-state="failed"
        header={
          <CardHead
            level={3}
            icon={<Cpu className="h-4 w-4" />}
            title={title}
            subtitle={t('block.subtitle.other')}
            pills={null}
          />
        }
      >
        <InsetState
          level={4}
          tone="error"
          icon={<TriangleAlert className="h-5 w-5" />}
          title={t('error.title', { kind })}
        >
          {t('error.body')}
        </InsetState>
      </Card>
    );
  }

  if (block.provider === 'fly') {
    return (
      <Card
        data-testid={testId}
        data-state="fly"
        header={
          <CardHead
            level={3}
            icon={<Cpu className="h-4 w-4" />}
            title={title}
            subtitle={t('block.subtitle.fly')}
            pills={<ProviderStatement provider="fly" t={t} />}
          />
        }
      >
        <InsetState level={4} icon={<Plane className="h-5 w-5" />} title={t('fly.title', { kind })}>
          {t('fly.body')}
        </InsetState>
      </Card>
    );
  }

  const overCount = block.accounts.filter((a) => a.overThreshold).length;

  return (
    <Card
      data-testid={testId}
      data-state="aws"
      header={
        <CardHead
          level={3}
          icon={<Cpu className="h-4 w-4" />}
          title={title}
          subtitle={t('block.subtitle.aws')}
          pills={
            <>
              <ProviderStatement provider="aws" t={t} />
              {overCount > 0 ? (
                <Pill severity="warning">
                  <TriangleAlert aria-hidden className="h-3 w-3" />
                  {t('overCount', { count: overCount })}
                </Pill>
              ) : null}
              {block.growthInFlight ? (
                <Pill severity="info">
                  <Sprout aria-hidden className="h-3 w-3" />
                  {t('growthInFlight')}
                </Pill>
              ) : null}
            </>
          }
        />
      }
      footer={
        <p className="flex items-start gap-1 font-sans text-xs text-(--el-text-secondary)">
          <Info aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{t.rich('readOnly', { command: REQUEST_COMMAND, cmd: CommandChip })}</span>
        </p>
      }
    >
      <div className="flex flex-col gap-5">
        <PoolTotal block={block} t={t} />
        {block.accounts.length > 0 ? <AccountTable block={block} now={now} /> : null}
        <SpareLine block={block} now={now} />
        <RequestList block={block} kind={kind} query={query} now={now} />
        <EventList block={block} kind={kind} query={query} now={now} />
      </div>
    </Card>
  );
}

function CommandChip(chunks: React.ReactNode) {
  return (
    <code className="rounded-(--radius-control) bg-(--el-muted) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-mono text-(--el-text)">
      {chunks}
    </code>
  );
}

/** Provider statement — in words, with a glyph; never a colour alone. */
function ProviderStatement({ provider, t }: { provider: 'aws' | 'fly'; t: T }) {
  return provider === 'aws' ? (
    <Pill severity="info" data-provider="aws">
      <Cloud aria-hidden className="h-3 w-3" />
      {t('provider.aws')}
    </Pill>
  ) : (
    <Pill tone="neutral" data-provider="fly">
      <Plane aria-hidden className="h-3 w-3" />
      {t('provider.fly')}
    </Pill>
  );
}

// ── Pool total ───────────────────────────────────────────────────────────────

async function PoolTotal({ block, t }: { block: AwsBlock; t: T }) {
  const format = await getFormatter();
  const { accounts, pool } = block;

  if (accounts.length === 0) {
    return (
      <div className="flex flex-col gap-3" data-element="pool-total" data-state="no-account">
        <div className="grid gap-3 sm:grid-cols-3">
          <MiniStat value={t('total.noAccount')} missing label={t('total.capacityShort')} />
          <MiniStat value={t('total.noAccount')} missing label={t('total.usedShort')} />
          <MiniStat value={t('total.noAccount')} missing label={t('total.percentShort')} />
        </div>
        <p className="font-sans text-sm text-(--el-text-secondary)">
          {t.rich('total.noAccountBody', {
            command: ADD_SHARD_COMMAND,
            cmd: (chunks) => <span className="font-mono text-xs text-(--el-text)">{chunks}</span>,
          })}
        </p>
      </div>
    );
  }

  const capacityLabel = t('total.capacity', { count: accounts.length });
  const notRead = accounts.filter((a) => a.grantedVcpu === null).length;
  return (
    <div
      className="grid gap-3 sm:grid-cols-3"
      data-element="pool-total"
      data-complete={pool.complete ? 'true' : 'false'}
    >
      {pool.complete ? (
        <MiniStat value={t('vcpu', { n: format.number(pool.grantedVcpu) })} label={capacityLabel} />
      ) : (
        // A partial sum is never the pool's capacity.
        <MiniStat
          value={t('notAvailable')}
          missing
          label={capacityLabel}
          sub={notRead > 0 ? t('total.incomplete', { count: notRead }) : undefined}
        />
      )}
      <UsedTotal pool={pool} accounts={accounts} t={t} />
      {pool.percent === null ? (
        <MiniStat value={t('notAvailable')} missing label={t('total.percentShort')} />
      ) : (
        <MiniStat
          value={t('percent', { n: format.number(pool.percent) })}
          label={t('total.percent')}
        />
      )}
    </div>
  );
}

/** vCPU in use is measured, not read from AWS, so it stays a figure while every
 *  account's use is known — even when a quota is not read. */
async function UsedTotal({
  pool,
  accounts,
  t,
}: {
  pool: PlatformPoolTotalDTO;
  accounts: PlatformPoolAccountDTO[];
  t: T;
}) {
  const format = await getFormatter();
  const known = accounts.every((a) => a.usedVcpu !== null);
  return known ? (
    <MiniStat value={t('vcpu', { n: format.number(pool.usedVcpu) })} label={t('total.used')} />
  ) : (
    <MiniStat value={t('notAvailable')} missing label={t('total.used')} />
  );
}

// ── Account rows ─────────────────────────────────────────────────────────────

/** vCPU past 70%: use minus the 70% mark, rounded up as the service rounds it. */
function pastThreshold(account: PlatformPoolAccountDTO): number | null {
  if (account.grantedVcpu === null || account.usedVcpu === null) return null;
  return Math.max(0, account.usedVcpu - Math.ceil(account.grantedVcpu * HEADROOM_ALERT_FRACTION));
}

async function AccountTable({ block, now }: { block: AwsBlock; now: Date }) {
  const t = await getTranslations('platformAdmin.monitoring.pools');
  const ft = await getTranslations('platformAdmin.monitoring.fleet');
  const format = await getFormatter();

  return (
    <div className="flex flex-col gap-2" data-element="account-rows">
      <ListHead
        title={t('accounts.title')}
        count={t('accounts.count', { count: block.accounts.length })}
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[52rem] border-collapse font-sans text-sm">
          <thead>
            <tr className="border-b border-(--el-border) text-left">
              <Th scope="col">{t('accounts.col.account')}</Th>
              <Th scope="col">{t('accounts.col.role')}</Th>
              <Th scope="col">{t('accounts.col.state')}</Th>
              <Th scope="col" numeric>
                {t('accounts.col.granted')}
              </Th>
              <Th scope="col" numeric>
                {t('accounts.col.used')}
              </Th>
              <Th scope="col" numeric>
                {t('accounts.col.percent')}
              </Th>
              <Th scope="col" numeric>
                {t('accounts.col.toThreshold')}
              </Th>
            </tr>
          </thead>
          <tbody>
            {block.accounts.map((a) => (
              <tr
                key={a.name}
                data-account={a.name}
                data-over={a.overThreshold ? 'true' : undefined}
                className="border-b border-(--el-border-soft)"
              >
                <Td rail={a.overThreshold ? 'warning' : false}>
                  <Mono>{a.name}</Mono>
                </Td>
                <Td className="text-(--el-text)">{t('role.shared')}</Td>
                <Td>
                  <StatePill state={a.state} t={t} />
                </Td>
                <Td numeric>
                  {a.grantedVcpu === null ? (
                    <NotReadMark readAt={a.grantedReadAt} now={now} t={t} ft={ft} />
                  ) : (
                    <>
                      <span className="font-medium tabular-nums text-(--el-text)">
                        {t('vcpu', { n: format.number(a.grantedVcpu) })}
                      </span>
                      <Sub>
                        {a.grantedReadAt
                          ? t('readAgo', { age: ago(ft, secondsBetween(a.grantedReadAt, now)) })
                          : t('neverRead')}
                      </Sub>
                    </>
                  )}
                </Td>
                <Td numeric>
                  {a.usedVcpu === null ? (
                    <NotAvailable t={t} />
                  ) : (
                    <span className="tabular-nums text-(--el-text)">
                      {t('vcpu', { n: format.number(a.usedVcpu) })}
                    </span>
                  )}
                </Td>
                <Td numeric>
                  {a.percent === null ? (
                    <NotAvailable t={t} />
                  ) : (
                    <span className="flex min-w-[6rem] flex-col items-end gap-1">
                      <span className="tabular-nums text-(--el-text)">
                        {t('percent', { n: format.number(a.percent) })}
                      </span>
                      <UseBar percent={a.percent} />
                    </span>
                  )}
                </Td>
                <Td numeric>
                  {a.toThreshold === null ? (
                    <NotAvailable t={t} />
                  ) : a.overThreshold ? (
                    <OverMark by={pastThreshold(a)} t={t} />
                  ) : (
                    <span className="tabular-nums text-(--el-text)">
                      {t('toGo', { n: format.number(a.toThreshold) })}
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatePill({ state, t }: { state: string; t: T }) {
  switch (state) {
    case 'active':
      return <Pill tone="neutral">{t('state.active')}</Pill>;
    case 'provisioning':
      return <Pill severity="info">{t('state.provisioning')}</Pill>;
    case 'disabled':
      return <Pill tone="neutral">{t('state.disabled')}</Pill>;
    default:
      return <Pill tone="neutral">{state}</Pill>;
  }
}

/** Not-read mark — the word, the last good read, and never a number. */
function NotReadMark({
  readAt,
  now,
  t,
  ft,
}: {
  readAt: string | null;
  now: Date;
  t: T;
  ft: FleetT;
}) {
  return (
    <span className="flex flex-col items-end" data-mark="not-read">
      <Pill tone="awaiting" aria-label={t('notReadLabel')}>
        <CircleHelp aria-hidden className="h-3 w-3 shrink-0" />
        {t('notRead')}
      </Pill>
      <Sub>{lastReadWords(readAt, now, t, ft)}</Sub>
    </span>
  );
}

function lastReadWords(readAt: string | null, now: Date, t: T, ft: FleetT): string {
  return readAt ? t('lastRead', { age: ago(ft, secondsBetween(readAt, now)) }) : t('neverRead');
}

/** Over-70 mark — the words, a glyph, and the vCPU past it. */
async function OverMark({ by, t }: { by: number | null; t: T }) {
  const format = await getFormatter();
  return (
    <span className="flex flex-col items-end" data-mark="over">
      <Pill severity="warning">
        <TriangleAlert aria-hidden className="h-3 w-3 shrink-0" />
        {t('over')}
      </Pill>
      {by === null ? null : (
        <Sub>{by === 0 ? t('atThreshold') : t('overBy', { n: format.number(by) })}</Sub>
      )}
    </span>
  );
}

/** The usage bar with its 70% tick. `aria-hidden`: the percent beside it carries
 *  the meaning. */
function UseBar({ percent }: { percent: number }) {
  const over = percent >= HEADROOM_ALERT_FRACTION * 100;
  return (
    <span
      aria-hidden
      className="relative block h-2 w-full overflow-hidden rounded-(--radius-badge) bg-(--el-surface)"
    >
      <span
        className={`block h-full rounded-(--radius-badge) ${over ? 'bg-(--el-warning)' : 'bg-(--el-accent)'}`}
        style={{ width: `${percent <= 0 ? 0 : Math.min(100, Math.max(1, percent))}%` }}
      />
      <span
        className="absolute inset-y-0 w-px bg-(--el-text-secondary)"
        style={{ left: `${HEADROOM_ALERT_FRACTION * 100}%` }}
      />
    </span>
  );
}

function NotAvailable({ t }: { t: T }) {
  return <span className="italic text-(--el-text-secondary)">{t('notAvailable')}</span>;
}

// ── Spare line ───────────────────────────────────────────────────────────────

async function SpareLine({ block, now }: { block: AwsBlock; now: Date }) {
  const t = await getTranslations('platformAdmin.monitoring.pools');
  const ft = await getTranslations('platformAdmin.monitoring.fleet');
  const format = await getFormatter();

  return (
    <div
      data-element="spare-line"
      className="flex flex-col gap-3 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) p-(--spacing-card-padding-12)"
    >
      <h4 className="font-sans text-xs font-semibold uppercase tracking-wide text-(--el-text-secondary)">
        {t('spare.title')}
      </h4>
      {block.spares.length === 0 ? (
        <p className="font-sans text-sm text-(--el-text-secondary)">{t('spare.none')}</p>
      ) : (
        block.spares.map((spare) => {
          const raise = openRaise(block.requests, spare);
          return (
            <div key={spare.name} data-spare={spare.name} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Mono>{spare.name}</Mono>
                {spare.ready ? (
                  <Pill severity="success" data-spare-state="ready">
                    <CircleCheck aria-hidden className="h-3 w-3" />
                    {t('spare.ready')}
                  </Pill>
                ) : (
                  <Pill tone="awaiting" data-spare-state="waiting">
                    <Hourglass aria-hidden className="h-3 w-3" />
                    {t('spare.waiting')}
                  </Pill>
                )}
                <span className="font-sans text-sm text-(--el-text)">
                  {spare.grantedVcpu !== null ? (
                    <>
                      <span className="font-medium tabular-nums">
                        {t('vcpu', { n: format.number(spare.grantedVcpu) })}
                      </span>{' '}
                      {spare.grantedReadAt ? (
                        <span className="text-(--el-text-secondary)">
                          {t('spare.granted', {
                            age: ago(ft, secondsBetween(spare.grantedReadAt, now)),
                          })}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-(--el-text-secondary)">
                      <CircleHelp aria-hidden className="h-3 w-3" />
                      <span>
                        {t('spare.notRead', {
                          when: lastReadWords(spare.grantedReadAt, now, t, ft),
                        })}
                      </span>
                    </span>
                  )}
                </span>
              </div>
              <p className="font-sans text-xs text-(--el-text-secondary)">
                {spare.ready
                  ? t('spare.readyBody')
                  : raise
                    ? t('spare.raisingBody', {
                        n: format.number(raise.desiredValue),
                        age: ago(ft, secondsBetween(raise.createdAt, now)),
                      })
                    : spare.grantedVcpu === null
                      ? t('spare.notReadBody')
                      : t('spare.belowBody')}
              </p>
            </div>
          );
        })
      )}
    </div>
  );
}

/** The spare's open raise — the service lists open requests first, newest first. */
function openRaise(
  requests: PlatformPoolRequestDTO[],
  spare: PlatformPoolSpareDTO,
): PlatformPoolRequestDTO | null {
  return requests.find((r) => r.open && r.account === spare.name) ?? null;
}

// ── Quota request list ───────────────────────────────────────────────────────

const STATUS: Record<
  FleetQuotaRequestStatusDTO,
  { pill: 'awaiting' | 'success' | 'danger' | 'neutral'; icon: typeof Hourglass }
> = {
  pending: { pill: 'awaiting', icon: Hourglass },
  case_opened: { pill: 'awaiting', icon: Hourglass },
  approved: { pill: 'success', icon: CircleCheck },
  denied: { pill: 'danger', icon: TriangleAlert },
  not_approved: { pill: 'danger', icon: TriangleAlert },
  invalid_request: { pill: 'danger', icon: TriangleAlert },
  case_closed: { pill: 'neutral', icon: CircleMinus },
};

function StatusPill({ status, t }: { status: FleetQuotaRequestStatusDTO; t: T }) {
  const { pill, icon: Icon } = STATUS[status];
  const label = t(`requests.status.${status}`);
  const glyph = <Icon aria-hidden className="h-3 w-3" />;
  if (pill === 'success' || pill === 'danger') {
    return (
      <Pill severity={pill}>
        {glyph}
        {label}
      </Pill>
    );
  }
  return (
    <Pill tone={pill}>
      {glyph}
      {label}
    </Pill>
  );
}

/** One page of a list, from the page's search param; past the end is the last page. */
function pageOf<R>(rows: R[], value: string | undefined) {
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / POOLS_PAGE_SIZE));
  const asked = Number(value);
  const page = Number.isInteger(asked) && asked > 0 ? Math.min(asked, pageCount) : 1;
  const start = (page - 1) * POOLS_PAGE_SIZE;
  return {
    rows: rows.slice(start, start + POOLS_PAGE_SIZE),
    page,
    pageCount,
    total,
    from: total === 0 ? 0 : start + 1,
    to: Math.min(total, start + POOLS_PAGE_SIZE),
  };
}

async function RequestList({
  block,
  kind,
  query,
  now,
}: {
  block: AwsBlock;
  kind: string;
  query: FleetQuery;
  now: Date;
}) {
  const t = await getTranslations('platformAdmin.monitoring.pools');
  const ft = await getTranslations('platformAdmin.monitoring.fleet');
  const format = await getFormatter();
  const param = poolRequestsParam(block.fleetKind);
  const pg = pageOf(block.requests, query[param]);
  const open = block.requests.filter((r) => r.open).length;
  // The quota an account holds now, for a closed request that granted nothing.
  const held = new Map<string, number | null>(
    [...block.accounts, ...block.spares].map((a) => [a.name, a.grantedVcpu]),
  );

  return (
    <div className="flex flex-col gap-2" data-element="quota-request-list">
      <ListHead
        title={t('requests.title')}
        count={pg.total === 0 ? t('requests.none') : t('requests.count', { count: pg.total, open })}
      />
      {pg.total === 0 ? (
        <p className="font-sans text-sm text-(--el-text-secondary)">{t('requests.empty')}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] border-collapse font-sans text-sm">
              <thead>
                <tr className="border-b border-(--el-border) text-left">
                  <Th scope="col">{t('requests.col.account')}</Th>
                  <Th scope="col" numeric>
                    {t('requests.col.asked')}
                  </Th>
                  <Th scope="col">{t('requests.col.status')}</Th>
                  <Th scope="col" numeric>
                    {t('requests.col.granted')}
                  </Th>
                  <Th scope="col" sorted>
                    {t('requests.col.when')}
                    <ArrowDown aria-hidden className="ml-1 inline h-3 w-3" />
                  </Th>
                  <Th scope="col">{t('requests.col.lastRead')}</Th>
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((r) => {
                  const stays = held.get(r.account) ?? null;
                  return (
                    <tr
                      key={`${r.account}-${r.createdAt}`}
                      data-status={r.status}
                      data-open={r.open ? 'true' : undefined}
                      className="border-b border-(--el-border-soft)"
                    >
                      <Td>
                        <Mono>{r.account}</Mono>
                      </Td>
                      <Td numeric className="tabular-nums text-(--el-text)">
                        {t('vcpu', { n: format.number(r.desiredValue) })}
                      </Td>
                      <Td>
                        <StatusPill status={r.status} t={t} />
                      </Td>
                      <Td numeric>
                        {r.grantedValue !== null ? (
                          <span className="tabular-nums text-(--el-text)">
                            {t('vcpu', { n: format.number(r.grantedValue) })}
                          </span>
                        ) : r.open ? (
                          <span className="italic text-(--el-text-secondary)">
                            {t('requests.notYet')}
                          </span>
                        ) : (
                          <>
                            <span className="italic text-(--el-text-secondary)">
                              {t('requests.notGranted')}
                            </span>
                            <Sub>
                              {stays !== null
                                ? t('requests.quotaStays', { n: format.number(stays) })
                                : t('requests.quotaUnchanged')}
                            </Sub>
                          </>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap text-(--el-text-secondary)">
                        {ago(ft, secondsBetween(r.createdAt, now))}
                      </Td>
                      <Td className="whitespace-nowrap text-(--el-text-secondary)">
                        {r.lastReadAt
                          ? ago(ft, secondsBetween(r.lastReadAt, now))
                          : t('requests.notReadYet')}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Foot
            note={t('requests.foot', { from: pg.from, to: pg.to, total: pg.total })}
            label={t('requests.pagerLabel', { kind })}
            page={pg.page}
            pageCount={pg.pageCount}
            hrefFor={(page) => hrefWith(query, param, page)}
            t={ft}
          />
        </>
      )}
    </div>
  );
}

// ── Growth event list ────────────────────────────────────────────────────────

async function EventList({
  block,
  kind,
  query,
  now,
}: {
  block: AwsBlock;
  kind: string;
  query: FleetQuery;
  now: Date;
}) {
  const t = await getTranslations('platformAdmin.monitoring.pools');
  const ft = await getTranslations('platformAdmin.monitoring.fleet');
  const format = await getFormatter();
  const param = poolEventsParam(block.fleetKind);
  const pg = pageOf(block.growthEvents, query[param]);

  return (
    <div className="flex flex-col gap-2" data-element="growth-event-list">
      <ListHead
        title={t('events.title')}
        count={pg.total === 0 ? t('requests.none') : t('events.count', { count: pg.total })}
      />
      {pg.total === 0 ? (
        <p className="font-sans text-sm text-(--el-text-secondary)">{t('events.empty')}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] border-collapse font-sans text-sm">
              <thead>
                <tr className="border-b border-(--el-border) text-left">
                  <Th scope="col" sorted>
                    {t('events.col.when')}
                    <ArrowDown aria-hidden className="ml-1 inline h-3 w-3" />
                  </Th>
                  <Th scope="col">{t('events.col.account')}</Th>
                  <Th scope="col" numeric>
                    {t('events.col.use')}
                  </Th>
                  <Th scope="col">{t('events.col.outcome')}</Th>
                </tr>
              </thead>
              <tbody>
                {pg.rows.map((e, i) => (
                  <tr
                    key={`${e.createdAt}-${i}`}
                    data-outcome={e.outcome}
                    className="border-b border-(--el-border-soft)"
                  >
                    <Td
                      rail={e.outcome === 'refused'}
                      className="whitespace-nowrap text-(--el-text-secondary)"
                    >
                      {ago(ft, secondsBetween(e.createdAt, now))}
                    </Td>
                    <Td>
                      {e.triggeringAccount ? (
                        <Mono>{e.triggeringAccount}</Mono>
                      ) : (
                        <span className="text-(--el-text-secondary)">
                          {t('events.accountRemoved')}
                        </span>
                      )}
                    </Td>
                    <Td numeric className="whitespace-nowrap tabular-nums">
                      <span className="text-(--el-text-secondary)">
                        {t.rich('events.use', {
                          used: format.number(e.vcpuInUse),
                          granted: format.number(e.grantedQuota),
                          b: (chunks) => (
                            <span className="font-semibold text-(--el-text)">{chunks}</span>
                          ),
                        })}
                      </span>
                      {e.grantedQuota > 0 ? (
                        <Sub>
                          {t('events.usePercent', {
                            p: format.number(Math.round((e.vcpuInUse * 100) / e.grantedQuota)),
                          })}
                        </Sub>
                      ) : null}
                    </Td>
                    <Td>
                      <Outcome event={e} t={t} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Foot
            note={t('events.foot', { from: pg.from, to: pg.to, total: pg.total })}
            label={t('events.pagerLabel', { kind })}
            page={pg.page}
            pageCount={pg.pageCount}
            hrefFor={(page) => hrefWith(query, param, page)}
            t={ft}
          />
        </>
      )}
    </div>
  );
}

function Detail({ children }: { children: React.ReactNode }) {
  return (
    <span className="mt-0.5 block max-w-[60ch] text-xs text-(--el-text-secondary)">{children}</span>
  );
}

function Outcome({ event: e, t }: { event: FleetGrowthEventViewDTO; t: T }) {
  const label = t(`events.outcome.${e.outcome}`);
  switch (e.outcome) {
    case 'spare_promoted':
      return (
        <>
          <Pill severity="success">
            <CircleCheck aria-hidden className="h-3 w-3" />
            {label}
          </Pill>
          {e.spareAccount ? (
            <Detail>
              {e.newAccount
                ? t('events.promotedNew', { spare: e.spareAccount, created: e.newAccount })
                : t('events.promoted', { spare: e.spareAccount })}
            </Detail>
          ) : null}
        </>
      );
    case 'account_created':
      return (
        <>
          <Pill severity="success">
            <Server aria-hidden className="h-3 w-3" />
            {label}
          </Pill>
          {e.newAccount ? <Detail>{t('events.created', { created: e.newAccount })}</Detail> : null}
        </>
      );
    case 'waiting_for_quota':
      return (
        <>
          <Pill tone="awaiting">
            <Hourglass aria-hidden className="h-3 w-3" />
            {label}
          </Pill>
          <Detail>{t('events.waiting')}</Detail>
        </>
      );
    case 'refused':
      return (
        <span className="flex flex-col items-start gap-1">
          <Pill severity="danger">
            <TriangleAlert aria-hidden className="h-3 w-3" />
            {label}
          </Pill>
          {e.reason ? (
            // AWS's own words, verbatim — the operator needs the real reason.
            <span className="flex max-w-[52ch] items-start gap-1 text-xs text-(--el-danger-on-surface)">
              <TriangleAlert aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{t('events.awsSaid', { reason: e.reason })}</span>
            </span>
          ) : null}
          <Detail>{t('events.refusedNote')}</Detail>
        </span>
      );
  }
}

// ── Shared pieces ────────────────────────────────────────────────────────────

function ListHead({ title, count }: { title: string; count: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <h4 className="font-sans text-xs font-semibold uppercase tracking-wide text-(--el-text-secondary)">
        {title}
      </h4>
      <span className="font-sans text-xs text-(--el-text-secondary)">{count}</span>
    </div>
  );
}

function secondsBetween(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
}

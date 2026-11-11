import { getFormatter, getTranslations } from 'next-intl/server';
import {
  Boxes,
  CircleHelp,
  CirclePause,
  Cloud,
  Cpu,
  Info,
  Moon,
  Plane,
  TriangleAlert,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { HEADROOM_ALERT_FRACTION } from '@/lib/ciFleet/shardTargets';
import {
  SHARD_MACHINE_VCPU,
  type InstallFleetBlockDTO,
  type InstallPoolDTO,
  type ShardAccountDTO,
  type ShardBlockDTO,
  type ShardPoolDTO,
} from '@/lib/dto/fleetStatusPools';
import {
  CardHead,
  InsetState,
  MiniStat,
  Mono,
  Sub,
  Td,
  Th,
  ago,
  duration,
} from '../../monitoring/_components/FleetSection';
import { PoolDisclosure } from './PoolDisclosure';

/**
 * THE FLEET STATUS PAGE'S POOLS CARDS (MOTIR-10887; design MOTIR-10885
 * `platform-admin/design-notes.md` § AMENDMENT 2026-11-10, Panels 1, 7–10, 14).
 *
 * Two cards, each rendered from its own settled read: **Motir's own account ·
 * install fleet** and **Add-shard accounts · tenants' jobs**. Server components;
 * the one client island is the pool disclosure, which only shows and hides the
 * account row the server already rendered.
 *
 * ⚠️ A NULL IS NEVER RENDERED AS A NUMBER. An unread quota is the Not-read mark,
 * every figure computed from it reads _Not available_, and a pool with an account
 * whose size is unknown reads _Not available_ with how many are not read.
 *
 * ⚠️ READ-ONLY. Asking AWS for quota is the `fleet-admin request-quota` command,
 * named in plain text; nothing here writes.
 *
 * The kind names, account states, _Not read_, _Not available_, _Runs on AWS /
 * Fly_ and the read-only quota note are `platformAdmin.monitoring.pools.*`, so the
 * two pages' words stay the same.
 */

type T = Awaited<ReturnType<typeof getTranslations<'platformAdmin.fleetStatus'>>>;
type MonT = Awaited<ReturnType<typeof getTranslations<'platformAdmin.monitoring.pools'>>>;
type FleetT = Awaited<ReturnType<typeof getTranslations<'platformAdmin.monitoring.fleet'>>>;
type Format = Awaited<ReturnType<typeof getFormatter>>;

const REQUEST_COMMAND = 'fleet-admin request-quota --account <name> --vcpu <n>';
const ADD_SHARD_COMMAND = 'fleet-admin add-shard';

function secondsBetween(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
}

function CommandChip(chunks: React.ReactNode) {
  return (
    <code className="rounded-(--radius-control) bg-(--el-muted) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-mono text-(--el-text)">
      {chunks}
    </code>
  );
}

function InlineCommand(chunks: React.ReactNode) {
  return <span className="font-mono text-xs text-(--el-text)">{chunks}</span>;
}

function NotAvailable({ mon }: { mon: MonT }) {
  return <span className="italic text-(--el-text-secondary)">{mon('notAvailable')}</span>;
}

/** A cell with nothing to show: the dash for the eye, the words for a reader. */
function NotApplicable({ t }: { t: T }) {
  return (
    <span className="text-(--el-text-secondary)">
      <span aria-hidden>—</span>
      <span className="sr-only">{t('pools.notApplicable')}</span>
    </span>
  );
}

/** Monitoring's usage bar with its 70% tick. `aria-hidden`: the percent beside it
 *  carries the meaning. */
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

function ListHead({ title, count }: { title: string; count: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h4 className="font-sans text-xs font-semibold uppercase tracking-wide text-(--el-text-secondary)">
        {title}
      </h4>
      <span className="font-sans text-xs text-(--el-text-secondary)">{count}</span>
    </div>
  );
}

function ReadOnlyFoot({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-1 font-sans text-xs text-(--el-text-secondary)">
      <Info aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

// ── Motir's own account · install fleet ──────────────────────────────────────

export async function InstallFleetCard({ block, now }: { block: InstallFleetBlockDTO; now: Date }) {
  const t = await getTranslations('platformAdmin.fleetStatus');
  const mon = await getTranslations('platformAdmin.monitoring.pools');
  const ft = await getTranslations('platformAdmin.monitoring.fleet');
  const format = await getFormatter();

  if (block.status === 'unavailable') {
    // No figure and no provider claimed: the read did not answer.
    return (
      <Card
        data-pool="install-fleet"
        data-state="failed"
        header={
          <CardHead
            level={3}
            icon={<Cpu className="h-4 w-4" />}
            title={t('install.title')}
            subtitle={t('install.subtitle')}
            pills={null}
          />
        }
      >
        <InsetState
          level={4}
          tone="error"
          icon={<TriangleAlert className="h-5 w-5" />}
          title={t('install.error.title')}
        >
          {t('install.error.body')}
        </InsetState>
      </Card>
    );
  }

  const { quota } = block;
  const vcpu = (n: number) => mon('vcpu', { n: format.number(n) });

  return (
    <Card
      data-pool="install-fleet"
      data-state={quota.status === 'ok' ? 'ok' : 'quota-not-read'}
      header={
        <CardHead
          level={3}
          icon={<Cpu className="h-4 w-4" />}
          title={t('install.title')}
          subtitle={t('install.subtitle')}
          pills={
            <>
              <Pill severity="info" data-provider="aws">
                <Cloud aria-hidden className="h-3 w-3" />
                {mon('provider.aws')}
              </Pill>
              {block.nearQuota ? (
                <Pill severity="warning" data-flag="near-quota">
                  <TriangleAlert aria-hidden className="h-3 w-3" />
                  {t('install.nearQuota')}
                </Pill>
              ) : null}
            </>
          }
        />
      }
      footer={<ReadOnlyFoot>{t('install.readOnly')}</ReadOnlyFoot>}
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2" data-element="quota">
          <div className="grid gap-3 sm:grid-cols-3">
            {quota.status === 'ok' ? (
              <MiniStat
                value={vcpu(quota.vcpu)}
                label={t('install.quota.label')}
                sub={t('install.quota.read', {
                  age: ago(ft, secondsBetween(quota.readAt, now)),
                })}
              />
            ) : (
              <span data-mark="not-read" aria-label={mon('notReadLabel')} className="contents">
                <MiniStat
                  value={mon('notRead')}
                  missing
                  label={t('install.quota.label')}
                  sub={t('install.quota.notRead', {
                    when: quota.lastReadAt
                      ? mon('lastRead', { age: ago(ft, secondsBetween(quota.lastReadAt, now)) })
                      : mon('neverRead'),
                  })}
                />
              </span>
            )}
            {block.usedVcpu === null ? (
              <MiniStat value={mon('notAvailable')} missing label={t('install.used')} />
            ) : (
              <MiniStat value={vcpu(block.usedVcpu)} label={t('install.used')} />
            )}
            {block.percent === null ? (
              <MiniStat value={mon('notAvailable')} missing label={t('install.percent')} />
            ) : (
              <MiniStat
                value={mon('percent', { n: format.number(block.percent) })}
                label={t('install.percent')}
              />
            )}
          </div>
          {block.percent === null ? null : <UseBar percent={block.percent} />}
          {block.nearQuota && block.leftVcpu !== null && block.percent !== null ? (
            <p
              className="flex items-start gap-2 font-sans text-sm text-(--el-text)"
              data-element="near-quota"
            >
              <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-warning)" />
              <span>
                {t('install.nearBody', {
                  percent: format.number(block.percent),
                  left: format.number(block.leftVcpu),
                })}
              </span>
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse font-sans text-sm">
              <thead>
                <tr className="border-b border-(--el-border) text-left">
                  <Th scope="col">{t('install.table.col.pool')}</Th>
                  <Th scope="col">{t('install.table.col.onFleet')}</Th>
                  <Th scope="col" numeric>
                    {t('install.table.col.running')}
                  </Th>
                  <Th scope="col" numeric>
                    {t('install.table.col.vcpu')}
                  </Th>
                  <Th scope="col" numeric>
                    {t('install.table.col.share')}
                  </Th>
                </tr>
              </thead>
              <tbody>
                {block.pools.map((pool) => (
                  <InstallPoolRow
                    key={pool.fleetKind}
                    pool={pool}
                    t={t}
                    mon={mon}
                    format={format}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Card>
  );
}

function InstallPoolRow({
  pool,
  t,
  mon,
  format,
}: {
  pool: InstallPoolDTO;
  t: T;
  mon: MonT;
  format: Format;
}) {
  const name = mon(`kind.${pool.fleetKind}`);
  if (!pool.enabled) {
    return (
      <tr
        data-install-pool={pool.fleetKind}
        data-enabled="false"
        className="border-b border-(--el-border-soft)"
      >
        <Td>
          <span className="font-medium text-(--el-text)">{name}</span>
        </Td>
        <Td>
          <Pill tone="neutral">{t('install.notOnFleet')}</Pill>
        </Td>
        <Td numeric>
          <NotApplicable t={t} />
        </Td>
        <Td numeric>
          <NotApplicable t={t} />
        </Td>
        <Td numeric>
          <NotApplicable t={t} />
        </Td>
      </tr>
    );
  }

  const running =
    pool.running === 0
      ? t('install.noneRunning')
      : pool.fleetKind === 'agent_instance'
        ? t('install.awake', { count: pool.running })
        : t('install.machines', { count: pool.running });

  return (
    <tr
      data-install-pool={pool.fleetKind}
      data-enabled="true"
      className="border-b border-(--el-border-soft)"
    >
      <Td>
        <span className="font-medium text-(--el-text)">{name}</span>
      </Td>
      <Td>
        <span className="text-(--el-text)">{t('install.yes')}</span>
      </Td>
      <Td numeric className="whitespace-nowrap">
        <span className="tabular-nums text-(--el-text)">{running}</span>
        {pool.hibernated !== null ? (
          <Sub>
            <span className="inline-flex items-center gap-1">
              <Moon aria-hidden className="h-3 w-3" />
              {t('install.hibernated', { count: pool.hibernated })}
            </span>
          </Sub>
        ) : null}
      </Td>
      <Td numeric className="whitespace-nowrap">
        {pool.vcpu === null ? (
          <NotAvailable mon={mon} />
        ) : (
          <span className="tabular-nums text-(--el-text)">
            {mon('vcpu', { n: format.number(pool.vcpu) })}
          </span>
        )}
      </Td>
      <Td numeric className="whitespace-nowrap">
        {pool.sharePercent === null ? (
          <NotAvailable mon={mon} />
        ) : (
          <span className="tabular-nums text-(--el-text)">
            {mon('percent', { n: format.number(pool.sharePercent) })}
          </span>
        )}
      </Td>
    </tr>
  );
}

// ── Add-shard accounts · tenants' jobs ───────────────────────────────────────

export async function ShardPoolsCard({ block, now }: { block: ShardBlockDTO; now: Date }) {
  const t = await getTranslations('platformAdmin.fleetStatus');
  const mon = await getTranslations('platformAdmin.monitoring.pools');
  const ft = await getTranslations('platformAdmin.monitoring.fleet');
  const format = await getFormatter();

  const head = (pills: React.ReactNode) => (
    <CardHead
      level={3}
      icon={<Boxes className="h-4 w-4" />}
      title={t('shard.title')}
      subtitle={t('shard.subtitle')}
      pills={pills}
    />
  );

  if (block.status === 'unavailable') {
    return (
      <Card data-pool="add-shard" data-state="failed" header={head(null)}>
        <InsetState
          level={4}
          tone="error"
          icon={<TriangleAlert className="h-5 w-5" />}
          title={mon('sectionError.title')}
        >
          {mon('sectionError.body')}
        </InsetState>
      </Card>
    );
  }

  return (
    <Card
      data-pool="add-shard"
      data-state="ok"
      header={head(
        block.nearCount > 0 ? (
          <Pill severity="warning" data-flag="near-size">
            <TriangleAlert aria-hidden className="h-3 w-3" />
            {t('shard.nearCount', { count: block.nearCount })}
          </Pill>
        ) : null,
      )}
      footer={
        <ReadOnlyFoot>
          {t.rich('shard.readOnly', { command: REQUEST_COMMAND, cmd: CommandChip })}
        </ReadOnlyFoot>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[52rem] border-collapse font-sans text-sm">
          <thead>
            <tr className="border-b border-(--el-border) text-left">
              <Th scope="col">{t('shard.col.pool')}</Th>
              <Th scope="col">{t('shard.col.size')}</Th>
              <Th scope="col">{t('shard.col.accounts')}</Th>
              <Th scope="col">{t('shard.col.running')}</Th>
              <Th scope="col">{t('shard.col.percent')}</Th>
            </tr>
          </thead>
          <tbody>
            {block.pools.map((pool) => (
              <ShardPoolRow
                key={pool.fleetKind}
                pool={pool}
                t={t}
                mon={mon}
                ft={ft}
                format={format}
                now={now}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const SHARD_COLUMNS = 5;

function MachinesCell({
  machines,
  t,
  mon,
  format,
}: {
  machines: number;
  t: T;
  mon: MonT;
  format: Format;
}) {
  return (
    <>
      <span className="tabular-nums text-(--el-text)">
        {t('shard.machines', { count: machines })}
      </span>
      <Sub>{mon('vcpu', { n: format.number(machines * SHARD_MACHINE_VCPU) })}</Sub>
    </>
  );
}

function ShardPoolRow({
  pool,
  t,
  mon,
  ft,
  format,
  now,
}: {
  pool: ShardPoolDTO;
  t: T;
  mon: MonT;
  ft: FleetT;
  format: Format;
  now: Date;
}) {
  const name = mon(`kind.${pool.fleetKind}`);
  const plainName = (
    <Td>
      <span className="font-medium text-(--el-text)">{name}</span>
    </Td>
  );

  if (pool.provider === 'fly') {
    return (
      <tr
        data-shard-pool={pool.fleetKind}
        data-state="fly"
        className="border-b border-(--el-border-soft)"
      >
        {plainName}
        <Td>
          <Pill tone="neutral" data-provider="fly">
            <Plane aria-hidden className="h-3 w-3" />
            {mon('provider.fly')}
          </Pill>
        </Td>
        <Td>
          <span className="text-(--el-text-secondary)">{t('shard.fly')}</span>
        </Td>
        <Td>
          <NotApplicable t={t} />
        </Td>
        <Td>
          <NotApplicable t={t} />
        </Td>
      </tr>
    );
  }

  if (pool.provider === 'unavailable') {
    return (
      <tr
        data-shard-pool={pool.fleetKind}
        data-state="failed"
        className="border-b border-(--el-border-soft)"
      >
        {plainName}
        <td colSpan={SHARD_COLUMNS - 1} className="py-2 pr-3 align-top" role="alert">
          <span className="inline-flex items-center gap-1 text-(--el-text)">
            <TriangleAlert aria-hidden className="h-4 w-4 text-(--el-danger-on-surface)" />
            {mon('error.title', { kind: name })}
          </span>
        </td>
      </tr>
    );
  }

  if (pool.sharedCount === 0 && pool.spareNames.length === 0) {
    // A kind with no account has none — never a capacity of 0.
    return (
      <tr
        data-shard-pool={pool.fleetKind}
        data-state="no-account"
        className="border-b border-(--el-border-soft)"
      >
        {plainName}
        <Td>
          <span className="italic text-(--el-text-secondary)">{t('shard.noAccount')}</span>
        </Td>
        <Td>
          <span className="text-(--el-text-secondary)">
            {t.rich('shard.noAccountBody', { command: ADD_SHARD_COMMAND, cmd: InlineCommand })}
          </span>
        </Td>
        <Td>
          <span className="text-(--el-text-secondary)">{t('install.noneRunning')}</span>
        </Td>
        <Td>
          <NotApplicable t={t} />
        </Td>
      </tr>
    );
  }

  const controlsId = `pool-${pool.fleetKind}-accounts`;
  const cells = (
    <>
      <Td>
        {pool.sizeMachines === null ? (
          <>
            <NotAvailable mon={mon} />
            {pool.notReadCount > 0 ? (
              <Sub>{t('shard.notReadCount', { count: pool.notReadCount })}</Sub>
            ) : null}
          </>
        ) : (
          <MachinesCell machines={pool.sizeMachines} t={t} mon={mon} format={format} />
        )}
      </Td>
      <Td>
        <span className="text-(--el-text)">{t('shard.shared', { count: pool.sharedCount })}</span>
        <Sub>
          {pool.spareNames.length > 0
            ? t.rich('shard.spare', {
                name: pool.spareNames.join(', '),
                mono: (chunks) => <span className="font-mono">{chunks}</span>,
              })
            : t('shard.noSpare')}
        </Sub>
      </Td>
      <Td>
        <MachinesCell machines={pool.running} t={t} mon={mon} format={format} />
      </Td>
      <Td>
        {pool.percent === null ? (
          <NotAvailable mon={mon} />
        ) : (
          <span className="flex min-w-[7rem] flex-col gap-1">
            <span className="tabular-nums text-(--el-text)">
              {mon('percent', { n: format.number(pool.percent) })}
            </span>
            <UseBar percent={pool.percent} />
            {pool.flag ? (
              <span>
                <Pill severity="warning" data-flag={pool.flag}>
                  <TriangleAlert aria-hidden className="h-3 w-3 shrink-0" />
                  {pool.flag === 'atSize' ? t('shard.atSize') : t('shard.near')}
                </Pill>
              </span>
            ) : null}
          </span>
        )}
      </Td>
    </>
  );

  return (
    <PoolDisclosure
      kind={pool.fleetKind}
      label={name}
      controlsId={controlsId}
      rail={pool.flag !== null}
      colSpan={SHARD_COLUMNS}
      cells={cells}
      accounts={
        <AccountTable pool={pool} name={name} t={t} mon={mon} ft={ft} format={format} now={now} />
      }
    />
  );
}

function AccountTable({
  pool,
  name,
  t,
  mon,
  ft,
  format,
  now,
}: {
  pool: Extract<ShardPoolDTO, { provider: 'aws' }>;
  name: string;
  t: T;
  mon: MonT;
  ft: FleetT;
  format: Format;
  now: Date;
}) {
  return (
    <div className="flex flex-col gap-2" data-element="account-rows">
      <ListHead
        title={t('shard.accounts.title', { kind: name })}
        count={mon('accounts.count', { count: pool.accounts.length })}
      />
      <div className="overflow-x-auto rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-page-bg)">
        <table className="w-full min-w-[44rem] border-collapse font-sans text-sm">
          <thead>
            <tr className="border-b border-(--el-border) text-left">
              <Th scope="col">{mon('accounts.col.account')}</Th>
              <Th scope="col">{mon('accounts.col.role')}</Th>
              <Th scope="col">{mon('accounts.col.state')}</Th>
              <Th scope="col">{t('shard.accounts.col.size')}</Th>
              <Th scope="col">{t('shard.accounts.col.running')}</Th>
              <Th scope="col">{t('shard.accounts.col.paused')}</Th>
            </tr>
          </thead>
          <tbody>
            {pool.accounts.map((account) => (
              <AccountRow
                key={account.name}
                account={account}
                t={t}
                mon={mon}
                ft={ft}
                format={format}
                now={now}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatePill({ state, mon }: { state: string; mon: MonT }) {
  switch (state) {
    case 'active':
      return <Pill tone="neutral">{mon('state.active')}</Pill>;
    case 'provisioning':
      return <Pill severity="info">{mon('state.provisioning')}</Pill>;
    case 'disabled':
      return <Pill tone="neutral">{mon('state.disabled')}</Pill>;
    default:
      return <Pill tone="neutral">{state}</Pill>;
  }
}

function pausedTime(iso: string, now: Date, format: Format): string {
  const at = new Date(iso);
  const sameDay = at.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
  return format.dateTime(
    at,
    sameDay
      ? { hour: '2-digit', minute: '2-digit' }
      : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' },
  );
}

function AccountRow({
  account,
  t,
  mon,
  ft,
  format,
  now,
}: {
  account: ShardAccountDTO;
  t: T;
  mon: MonT;
  ft: FleetT;
  format: Format;
  now: Date;
}) {
  const paused = account.pausedUntil !== null;
  return (
    <tr data-account={account.name} className="border-b border-(--el-border-soft)">
      <Td rail={paused ? 'warning' : undefined}>
        <Mono>{account.name}</Mono>
      </Td>
      <Td className="text-(--el-text)">
        {account.role === 'spare' ? t('shard.role.spare') : mon('role.shared')}
      </Td>
      <Td>
        <StatePill state={account.state} mon={mon} />
      </Td>
      <Td>
        {account.sizeMachines === null ? (
          <span className="flex flex-col" data-mark="not-read">
            <span>
              <Pill tone="awaiting" aria-label={mon('notReadLabel')}>
                <CircleHelp aria-hidden className="h-3 w-3 shrink-0" />
                {mon('notRead')}
              </Pill>
            </span>
            <Sub>
              {account.grantedReadAt
                ? mon('lastRead', { age: ago(ft, secondsBetween(account.grantedReadAt, now)) })
                : mon('neverRead')}
            </Sub>
          </span>
        ) : (
          <>
            <span className="tabular-nums text-(--el-text)">
              {t('shard.machines', { count: account.sizeMachines })}
            </span>
            <Sub>
              {account.role === 'spare'
                ? t('shard.spareNotCounted')
                : account.sizeSource === 'override'
                  ? t('shard.setByAdmin')
                  : t('shard.fromGranted', {
                      vcpu: format.number(account.grantedVcpu ?? 0),
                    })}
            </Sub>
          </>
        )}
      </Td>
      <Td>
        <span className="tabular-nums text-(--el-text)">
          {t('shard.runningCell', {
            count: format.number(account.running),
            vcpu: format.number(account.running * SHARD_MACHINE_VCPU),
          })}
        </span>
      </Td>
      <Td>
        {paused ? (
          <span className="flex flex-col">
            <span>
              <Pill tone="awaiting" data-paused={account.pausedReason ?? 'unknown'}>
                <CirclePause aria-hidden className="h-3 w-3 shrink-0" />
                {account.pausedReason === 'provider_unavailable'
                  ? t('shard.paused.unreachable')
                  : t('shard.paused.capacityRefused')}
              </Pill>
            </span>
            <Sub>
              {t('shard.pausedUntil', {
                time: pausedTime(account.pausedUntil!, now, format),
                left: duration(ft, secondsUntil(account.pausedUntil!, now)),
              })}
            </Sub>
          </span>
        ) : (
          <span className="text-(--el-text-secondary)">{t('shard.notPaused')}</span>
        )}
      </Td>
    </tr>
  );
}

function secondsUntil(iso: string, now: Date): number {
  return Math.max(0, Math.floor((new Date(iso).getTime() - now.getTime()) / 1000));
}

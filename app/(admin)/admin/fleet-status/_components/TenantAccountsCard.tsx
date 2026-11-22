import { getFormatter, getTranslations } from 'next-intl/server';
import { Ban, Building2, CircleHelp, Hourglass, Info, Search, TriangleAlert } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import type {
  TenantAccountDTO,
  TenantAccountsBlockDTO,
  TenantAccountsPageDTO,
  TenantQuotaDTO,
} from '@/lib/dto/fleetStatusTenantAccounts';
import {
  CardHead,
  Foot,
  InsetState,
  Mono,
  Sub,
  Td,
  Th,
  ago,
} from '../../monitoring/_components/FleetSection';

/**
 * THE TENANT HOSTING ACCOUNTS CARD (MOTIR-12014; design MOTIR-12013,
 * `platform-admin/design-notes.md` § AMENDMENT 2026-11-22, mock
 * `console--fleet-status--tenant-accounts.mock.html`) — the last card of the
 * Pools section. A server component: the search is a plain GET form and the
 * pager plain links, both carrying `tenantQ` / `tenantPage`.
 *
 * Per account its organisation, AWS account id, account name and state; for a
 * ready one a quota table (Applied · Target · Open raise), stacked below `sm`.
 * The header pills count over EVERY account, never only the page or the
 * matches; the list is already ordered with what needs acting on first.
 *
 * ⚠️ A NOT-READ QUOTA IS NEVER A NUMBER: the Not read mark with the last good
 * read, and _Not available_ for its raise. Monitoring's words
 * (`platformAdmin.monitoring.pools.*`) are reused for both, and for the raise
 * statuses, so the pages say the same thing.
 */

type T = Awaited<ReturnType<typeof getTranslations<'platformAdmin.fleetStatus.tenants'>>>;
type MonT = Awaited<ReturnType<typeof getTranslations<'platformAdmin.monitoring.pools'>>>;
type FleetT = Awaited<ReturnType<typeof getTranslations<'platformAdmin.monitoring.fleet'>>>;
type Format = Awaited<ReturnType<typeof getFormatter>>;

interface Ctx {
  t: T;
  mon: MonT;
  ft: FleetT;
  format: Format;
  now: Date;
}

/** Where the card lives on the page, so a search or page lands back on it. */
const CARD_HREF = '/admin/fleet-status#tenant-accounts';
const CAPS = 'font-sans text-xs font-semibold uppercase tracking-wide text-(--el-text-secondary)';

function secondsSince(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
}

/** The URL of one page of the card, keeping the search. */
export function tenantPageHref(query: string, page: number): string {
  const params = new URLSearchParams();
  if (query) params.set('tenantQ', query);
  if (page > 1) params.set('tenantPage', String(page));
  const qs = params.toString();
  return `/admin/fleet-status${qs ? `?${qs}` : ''}#tenant-accounts`;
}

function value(ctx: Ctx, quota: TenantQuotaDTO, n: number): string {
  const formatted = ctx.format.number(n);
  return quota.name === 'fargate-on-demand-vcpu'
    ? ctx.t('value.vcpu', { n: formatted })
    : ctx.t('value.count', { n: formatted });
}

function quotaState(quota: TenantQuotaDTO): string {
  if (quota.status === 'notRead') return 'not-read';
  if (quota.belowTarget) return 'below-target';
  return quota.applied >= quota.target ? 'at-target' : 'raising';
}

const isBelow = (quota: TenantQuotaDTO) => quota.status === 'ok' && quota.belowTarget;

function BelowPill({ t, flag }: { t: T; flag: string }) {
  return (
    <Pill severity="warning" data-flag={flag}>
      <TriangleAlert aria-hidden className="h-3 w-3 shrink-0" />
      {t('below')}
    </Pill>
  );
}

function NotReadMark({ ctx, lastReadAt }: { ctx: Ctx; lastReadAt: string | null }) {
  return (
    <span className="flex flex-col" data-mark="not-read">
      <span>
        <Pill tone="awaiting" aria-label={ctx.mon('notReadLabel')}>
          <CircleHelp aria-hidden className="h-3 w-3 shrink-0" />
          {ctx.mon('notRead')}
        </Pill>
      </span>
      <Sub>
        {lastReadAt
          ? ctx.mon('lastRead', { age: ago(ctx.ft, secondsSince(lastReadAt, ctx.now)) })
          : ctx.mon('neverRead')}
      </Sub>
    </span>
  );
}

function Applied({ ctx, quota }: { ctx: Ctx; quota: TenantQuotaDTO }) {
  if (quota.status === 'notRead') return <NotReadMark ctx={ctx} lastReadAt={quota.lastReadAt} />;
  return (
    <span className="flex flex-col gap-1">
      <span className="tabular-nums text-(--el-text)">{value(ctx, quota, quota.applied)}</span>
      <Sub>
        {quota.applied >= quota.target
          ? ctx.t('atTarget')
          : ctx.t('short', { n: ctx.format.number(quota.target - quota.applied) })}
      </Sub>
      {quota.belowTarget ? (
        <span>
          <BelowPill t={ctx.t} flag="below-target" />
        </span>
      ) : null}
    </span>
  );
}

function Raise({ ctx, quota }: { ctx: Ctx; quota: TenantQuotaDTO }) {
  if (quota.status === 'notRead') {
    return <span className="italic text-(--el-text-secondary)">{ctx.mon('notAvailable')}</span>;
  }
  const raise = quota.raise;
  if (!raise) return <span className="text-(--el-text-secondary)">{ctx.t('raise.none')}</span>;
  return (
    <span className="flex flex-col gap-1" data-raise={raise.status}>
      <span>
        <Pill tone="awaiting">
          <Hourglass aria-hidden className="h-3 w-3" />
          {ctx.mon(`requests.status.${raise.status}`)}
        </Pill>
      </span>
      {raise.desiredValue !== null ? (
        <span className="tabular-nums text-(--el-text)">
          {ctx.t('raise.to', { value: value(ctx, quota, raise.desiredValue) })}
        </span>
      ) : null}
      {raise.createdAt ? (
        <Sub>
          {ctx.t('raise.filed', { age: ago(ctx.ft, secondsSince(raise.createdAt, ctx.now)) })}
        </Sub>
      ) : null}
    </span>
  );
}

function QuotaName({ t, quota }: { t: T; quota: TenantQuotaDTO }) {
  return (
    <>
      <span className="font-medium text-(--el-text)">{quotaLabel(t, quota)}</span>
      <Sub>
        <span className="font-mono">{`${quota.serviceCode} · ${quota.quotaCode}`}</span>
      </Sub>
    </>
  );
}

/** The quota's name in words; a target added later without copy shows its code. */
function quotaLabel(t: T, quota: TenantQuotaDTO): string {
  if (quota.name === 'fargate-on-demand-vcpu') return t('quota.fargate-on-demand-vcpu');
  if (quota.name === 'lambda-concurrent-executions') return t('quota.lambda-concurrent-executions');
  return quota.name;
}

function QuotaTable({ ctx, quotas }: { ctx: Ctx; quotas: TenantQuotaDTO[] }) {
  const { t } = ctx;
  return (
    <div className="hidden overflow-x-auto rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-page-bg) sm:block">
      <table className="w-full min-w-[36rem] table-fixed border-collapse font-sans text-sm">
        <colgroup>
          <col className="w-[38%]" />
          <col className="w-[22%]" />
          <col className="w-[14%]" />
          <col className="w-[26%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-(--el-border) text-left">
            <Th scope="col">{t('col.quota')}</Th>
            <Th scope="col">{t('col.applied')}</Th>
            <Th scope="col">{t('col.target')}</Th>
            <Th scope="col">{t('col.raise')}</Th>
          </tr>
        </thead>
        <tbody>
          {quotas.map((quota) => (
            <tr
              key={quota.quotaCode}
              data-quota={quota.quotaCode}
              data-state={quotaState(quota)}
              className="border-b border-(--el-border-soft) last:border-b-0"
            >
              <Td rail={isBelow(quota) ? 'warning' : undefined}>
                <QuotaName t={t} quota={quota} />
              </Td>
              <Td>
                <Applied ctx={ctx} quota={quota} />
              </Td>
              <Td>
                <span className="tabular-nums text-(--el-text)">
                  {value(ctx, quota, quota.target)}
                </span>
              </Td>
              <Td>
                <Raise ctx={ctx} quota={quota} />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Below `sm` the four columns do not fit: each quota stacks, its figures in a labelled grid. */
function QuotaStack({ ctx, quotas }: { ctx: Ctx; quotas: TenantQuotaDTO[] }) {
  const { t } = ctx;
  return (
    <ul className="flex flex-col divide-y divide-(--el-border-soft) rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-page-bg) sm:hidden">
      {quotas.map((quota) => (
        <li
          key={quota.quotaCode}
          data-quota={quota.quotaCode}
          data-state={quotaState(quota)}
          className={`flex flex-col gap-2 py-2 pr-3 pl-3 ${isBelow(quota) ? 'border-l-[3px] border-l-(--el-warning)' : ''}`}
        >
          <span className="flex flex-col">
            <QuotaName t={t} quota={quota} />
          </span>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 font-sans text-sm">
            <div className="flex flex-col gap-0.5">
              <dt className={CAPS}>{t('col.applied')}</dt>
              <dd>
                <Applied ctx={ctx} quota={quota} />
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className={CAPS}>{t('col.target')}</dt>
              <dd>
                <span className="tabular-nums text-(--el-text)">
                  {value(ctx, quota, quota.target)}
                </span>
              </dd>
            </div>
            <div className="col-span-2 flex flex-col gap-0.5">
              <dt className={CAPS}>{t('col.raise')}</dt>
              <dd>
                <Raise ctx={ctx} quota={quota} />
              </dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

function StatePill({ t, state }: { t: T; state: TenantAccountDTO['state'] }) {
  const label = t(`state.${state}`);
  if (state === 'ready') {
    return (
      <Pill tone="neutral" data-account-state="ready">
        {label}
      </Pill>
    );
  }
  if (state === 'refused') {
    return (
      <Pill severity="danger" data-account-state="refused">
        <Ban aria-hidden className="h-3 w-3" />
        {label}
      </Pill>
    );
  }
  return (
    <Pill severity="info" data-account-state={state}>
      <Hourglass aria-hidden className="h-3 w-3" />
      {label}
    </Pill>
  );
}

function NotReadyLine({ ctx, account }: { ctx: Ctx; account: TenantAccountDTO }) {
  const { t } = ctx;
  const text =
    account.state === 'refused'
      ? account.lastRefusedAt
        ? t('notReady.refused', {
            count: account.refusedCount,
            age: ago(ctx.ft, secondsSince(account.lastRefusedAt, ctx.now)),
          })
        : t('notReady.refusedNever')
      : t(`notReady.${account.state as 'requested' | 'creating' | 'bootstrapping'}`);
  return <p className="max-w-prose font-sans text-xs text-(--el-text-secondary)">{text}</p>;
}

function AccountItem({ ctx, account }: { ctx: Ctx; account: TenantAccountDTO }) {
  const { t } = ctx;
  const notRead = account.quotas.some((q) => q.status === 'notRead');
  return (
    <li
      data-tenant-account={account.accountName}
      data-state={account.state}
      className="flex flex-col gap-3 py-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h5 className="font-sans text-sm font-semibold text-(--el-text)">
            {account.organizationName}
          </h5>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-sans text-xs text-(--el-text-secondary)">
            {account.awsAccountId ? (
              <span aria-label={t('account.accountLabel', { id: account.awsAccountId })}>
                <Mono>{account.awsAccountId}</Mono>
              </span>
            ) : (
              <span className="italic">{t('account.noAwsAccount')}</span>
            )}
            <span aria-hidden>·</span>
            <span className="break-all font-mono">{account.accountName}</span>
          </span>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          {account.quotas.some(isBelow) ? <BelowPill t={t} flag="account-below-target" /> : null}
          <StatePill t={t} state={account.state} />
          {notRead ? (
            <Pill tone="awaiting" data-flag="not-read">
              <CircleHelp aria-hidden className="h-3 w-3" />
              {ctx.mon('notRead')}
            </Pill>
          ) : null}
        </div>
      </div>
      {account.state !== 'ready' ? (
        <NotReadyLine ctx={ctx} account={account} />
      ) : (
        <>
          {notRead ? (
            <p role="alert" className="flex items-start gap-1.5 font-sans text-xs text-(--el-text)">
              <CircleHelp
                aria-hidden
                className="mt-0.5 h-3 w-3 shrink-0 text-(--el-text-secondary)"
              />
              <span>{t('notRead.body')}</span>
            </p>
          ) : null}
          <QuotaStack ctx={ctx} quotas={account.quotas} />
          <QuotaTable ctx={ctx} quotas={account.quotas} />
        </>
      )}
    </li>
  );
}

function ReadOnlyFoot({ t }: { t: T }) {
  return (
    <p className="flex items-start gap-1 font-sans text-xs text-(--el-text-secondary)">
      <Info aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
      <span>{t('readOnly')}</span>
    </p>
  );
}

function SearchBox({ t, query }: { t: T; query: string }) {
  return (
    <form method="GET" action={CARD_HREF} role="search" className="flex min-w-0 items-center">
      <label className="flex h-(--height-input) w-64 max-w-full items-center gap-2 rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-input-x) focus-within:ring-2 focus-within:ring-(--focus-ring-color)">
        <Search aria-hidden className="h-4 w-4 shrink-0 text-(--el-text-secondary)" />
        <span className="sr-only">{t('search.label')}</span>
        <input
          type="search"
          name="tenantQ"
          defaultValue={query}
          placeholder={t('search.placeholder')}
          className="min-w-0 flex-1 bg-transparent font-sans text-sm text-(--el-text) outline-none placeholder:text-(--el-text-secondary)"
        />
      </label>
    </form>
  );
}

function NoMatch({ t, query }: { t: T; query: string }) {
  return (
    <div data-element="no-match" className="flex flex-col gap-1">
      <p className="font-sans text-sm font-medium text-(--el-text)">
        {t('noMatch.title', { q: query })}
      </p>
      <p className="font-sans text-sm text-(--el-text-secondary)">
        {t('noMatch.body')}{' '}
        <a
          href={CARD_HREF}
          className="text-(--el-link) underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
        >
          {t('noMatch.clear')}
        </a>
      </p>
    </div>
  );
}

function HeaderPills({ t, belowTarget, notRead }: { t: T; belowTarget: number; notRead: number }) {
  return (
    <>
      {notRead > 0 ? (
        <Pill tone="awaiting" data-flag="accounts-not-read">
          <CircleHelp aria-hidden className="h-3 w-3" />
          {t('pill.notRead', { count: notRead })}
        </Pill>
      ) : null}
      {belowTarget > 0 ? (
        <Pill severity="warning" data-flag="below-target">
          <TriangleAlert aria-hidden className="h-3 w-3" />
          {t('pill.below', { count: belowTarget })}
        </Pill>
      ) : null}
    </>
  );
}

export async function TenantAccountsCard({
  block,
  page,
  now,
}: {
  block: TenantAccountsBlockDTO;
  /** The page of `block.accounts` to show, after the search; absent when the block is unavailable. */
  page: TenantAccountsPageDTO | null;
  now: Date;
}) {
  const [t, mon, ft, format] = await Promise.all([
    getTranslations('platformAdmin.fleetStatus.tenants'),
    getTranslations('platformAdmin.monitoring.pools'),
    getTranslations('platformAdmin.monitoring.fleet'),
    getFormatter(),
  ]);
  const ctx: Ctx = { t, mon, ft, format, now };
  const head = (pills: React.ReactNode) => (
    <CardHead
      level={3}
      icon={<Building2 className="h-4 w-4" />}
      title={t('title')}
      subtitle={t('subtitle')}
      pills={pills}
    />
  );

  if (block.status === 'unavailable' || page === null) {
    return (
      <Card
        id="tenant-accounts"
        data-pool="tenant-accounts"
        data-state="failed"
        header={head(null)}
      >
        <InsetState
          level={4}
          tone="error"
          icon={<TriangleAlert className="h-5 w-5" />}
          title={t('error.title')}
        >
          {t('error.body')}
        </InsetState>
      </Card>
    );
  }
  if (block.accounts.length === 0) {
    return (
      <Card
        id="tenant-accounts"
        data-pool="tenant-accounts"
        data-state="empty"
        header={head(null)}
        footer={<ReadOnlyFoot t={t} />}
      >
        <InsetState level={4} icon={<Building2 className="h-5 w-5" />} title={t('empty.title')}>
          {t('empty.body')}
        </InsetState>
      </Card>
    );
  }

  const range = { from: page.from, to: page.to, total: page.total };
  return (
    <Card
      id="tenant-accounts"
      data-pool="tenant-accounts"
      data-state="ok"
      header={head(
        <HeaderPills t={t} belowTarget={block.belowTargetCount} notRead={block.notReadCount} />,
      )}
      footer={<ReadOnlyFoot t={t} />}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className={CAPS}>{t('account.title')}</h4>
          <SearchBox t={t} query={page.query} />
        </div>
        {page.accounts.length === 0 ? (
          <NoMatch t={t} query={page.query} />
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-(--el-border-soft)">
              {page.accounts.map((account) => (
                <AccountItem key={account.accountName} ctx={ctx} account={account} />
              ))}
            </ul>
            <div data-element="tenant-pager">
              <Foot
                note={page.query ? t('footMatch', { ...range, q: page.query }) : t('foot', range)}
                label={t('pagerLabel')}
                page={page.page}
                pageCount={page.pageCount}
                hrefFor={(n) => tenantPageHref(page.query, n)}
                t={ft}
              />
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

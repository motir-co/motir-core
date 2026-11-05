import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ShieldCheck } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import type { PlatformOrgOverviewDTO } from '@/lib/dto/platform';
import { type PlatformPrincipal } from '@/lib/platform/auth';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { PlatformOrganizationNotFoundError } from '@/lib/platform/errors';
import { buildSpendSheet, parseSpendPeriod } from '@/lib/platform/spend';
import { platformOrgBillingService } from '@/lib/services/platformOrgBillingService';
import { platformFleetMonitorService } from '@/lib/services/platformFleetMonitorService';
import { platformFleetStopService } from '@/lib/services/platformFleetStopService';
import { platformOrgIndexCostService } from '@/lib/services/platformOrgIndexCostService';
import { platformOrgPageService } from '@/lib/services/platformOrgPageService';
import { formatMicroUsd } from '../../_components/spendFormat';
import { OrgFleetCard } from './_components/OrgFleetCard';
import { OrgIndexCostCard } from './_components/OrgIndexCostCard';
import { BillingTab } from './_components/BillingTab';
import { OrgPageHeader } from './_components/OrgPageHeader';
import { OperationsTabRoute } from './_components/ops/OperationsTab';
import { UsageTab } from './_components/UsageTab';
import { orgTabHref, orgUsageHref, parseOrgTab, safeTenantsHref } from './_components/orgNav';

/**
 * The operator's ORG PAGE — design `console--estate-usage-drilldown.mock.html`
 * **D5** (MOTIR-733), rebuilt from the MOTIR-4566 page it was.
 *
 * Reached from Tenants (D10). NO breadcrumb: ← Tenants returns to the list with its
 * filter, period and sort (`?from=`). Three tabs as URL state — Overview, Usage &
 * cost (MOTIR-7288), Billing & plans (MOTIR-7289), Operations (MOTIR-752). The Overview: this month by
 * category, Members, Workspaces with this month's credits, Recent jobs, and the
 * shipped Index & fleet cost card, classification control and action log.
 *
 * One page view is ONE audited `estate.read` naming the org
 * (`platformOrgPageService.getOverview`); the index-cost card reads under it.
 */

export const metadata: Metadata = {
  // No description — the console's standing rule (see the landing page).
  title: 'Organization',
};

/** Never cached: a classification applied a minute ago must show on the next load. */
export const dynamic = 'force-dynamic';

export default async function AdminOrganizationPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{
    tab?: string;
    from?: string;
    members?: string;
    jobs?: string;
    period?: string;
    scope?: string;
    months?: string;
  }>;
}) {
  const principal = await requirePlatformStaffPage('support');
  const { orgId } = await params;
  const query = await searchParams;
  const tab = parseOrgTab(query.tab);
  const backHref = safeTenantsHref(query.from);
  // TWO chips, TWO labels — the operator's one vocabulary for the two flags
  // (`internal-billing-classification.md` §1), never one collapsed "Internal".
  const tp = await getTranslations('platformAdmin');
  const chips = {
    isMeta: tp('orgs.chip.isMeta'),
    internalBilling: tp('orgs.chip.internalBilling'),
  };

  if (tab === 'usage') {
    let usage;
    try {
      usage = await platformOrgPageService.getUsageTab(principal, orgId, {
        period: parseSpendPeriod(query.period),
        scope: query.scope ?? null,
        monthsCursor: query.months ?? null,
      });
    } catch (err) {
      if (err instanceof PlatformOrganizationNotFoundError) notFound();
      throw err;
    }
    return (
      <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
        <OrgPageHeader
          org={usage.organization}
          principal={principal}
          tab="usage"
          backHref={backHref}
          chips={chips}
        />
        <UsageTab
          data={usage}
          monthsCursor={query.months ?? null}
          hrefFor={(period, months) =>
            orgUsageHref(orgId, { period, scope: query.scope, months, backHref })
          }
        />
      </div>
    );
  }
  if (tab === 'operations') {
    return (
      <OperationsTabRoute principal={principal} orgId={orgId} backHref={backHref} chips={chips} />
    );
  }
  if (tab === 'billing') {
    let billing;
    try {
      billing = await platformOrgBillingService.getOrgBilling(principal, orgId);
    } catch (err) {
      if (err instanceof PlatformOrganizationNotFoundError) notFound();
      throw err;
    }
    return (
      <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
        <OrgPageHeader
          org={billing.organization}
          principal={principal}
          tab="billing"
          backHref={backHref}
          chips={chips}
        />
        <BillingTab data={billing} />
      </div>
    );
  }

  // The Older/Newer stack of the jobs region: each cursor the operator stepped
  // through, newest page first. Older pushes, Newer pops.
  const jobsStack = (query.jobs ?? '').split(',').filter(Boolean);
  let overview: PlatformOrgOverviewDTO;
  try {
    overview = await platformOrgPageService.getOverview(principal, orgId, {
      membersCursor: query.members ?? null,
      jobsCursor: jobsStack.at(-1) ?? null,
    });
  } catch (err) {
    if (err instanceof PlatformOrganizationNotFoundError) notFound();
    throw err;
  }
  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <OrgPageHeader
        org={overview.organization}
        principal={principal}
        tab="overview"
        backHref={backHref}
        chips={chips}
      />
      <OverviewTab
        overview={overview}
        backHref={backHref}
        jobsStack={jobsStack}
        membersCursor={query.members ?? null}
      />
      <OrgIndexCostSection principal={principal} orgId={orgId} />
      <OrgFleetSection principal={principal} orgId={orgId} orgName={overview.organization.name} />
      <ActionLog overview={overview} />
    </div>
  );
}

/**
 * The index-cost card reads below the page function, after the overview has
 * proved the org exists — so the page's own serial chain stays within the
 * ratchet (MOTIR-3449) and the card's read never runs for a missing org.
 */
async function OrgIndexCostSection({
  principal,
  orgId,
}: {
  principal: PlatformPrincipal;
  orgId: string;
}) {
  const data = await platformOrgIndexCostService.read(principal, orgId, undefined, {
    audited: true,
  });
  return <OrgIndexCostCard data={data} />;
}

/**
 * FLEET · RUNNING NOW (MOTIR-7320 · design `tenant--stop-containers.mock.html`
 * S1): after the index-cost card and before the action log — cost, then what is
 * running, then the record of what was done about it. Like the index-cost card
 * it reads after the overview has proved the org exists. Its two reads run in
 * parallel. Off-cloud there is no fleet and no meter, so there is no card.
 */
async function OrgFleetSection({
  principal,
  orgId,
  orgName,
}: {
  principal: PlatformPrincipal;
  orgId: string;
  orgName: string;
}) {
  const [fleet, lastStop, lastOrgAdminStop] = await Promise.all([
    platformFleetMonitorService.orgFleet(principal, orgId),
    platformFleetStopService.lastStop(principal, orgId),
    platformFleetStopService.lastOrgAdminStop(principal, orgId),
  ]);
  if (fleet.meter === 'disabled') return null;
  return (
    <OrgFleetCard
      orgId={orgId}
      orgName={orgName}
      role={principal.role}
      row={fleet.row}
      window={fleet.window}
      lastStop={lastStop}
      lastOrgAdminStop={lastOrgAdminStop}
    />
  );
}

async function OverviewTab({
  overview,
  backHref,
  jobsStack,
  membersCursor,
}: {
  overview: PlatformOrgOverviewDTO;
  backHref: string;
  jobsStack: string[];
  membersCursor: string | null;
}) {
  const t = await getTranslations('platformAdmin.orgPage');
  const tc = await getTranslations('platformAdmin.usage.category');
  const tf = await getTranslations('platformAdmin.overview.feed');
  const format = await getFormatter();
  const org = overview.organization;
  const usageHref = orgTabHref(org.id, 'usage', backHref);
  const here = (extra: Record<string, string | null>) => {
    const p = new URLSearchParams();
    if (backHref !== '/admin/tenants') p.set('from', backHref);
    const merged = { members: membersCursor, jobs: jobsStack.join(',') || null, ...extra };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const q = p.toString();
    return `/admin/tenants/${encodeURIComponent(org.id)}${q ? `?${q}` : ''}`;
  };
  const sheet = overview.monthCategories ? buildSpendSheet(overview.monthCategories) : null;
  const monthLabel = format.dateTime(new Date(`${overview.month}-01T00:00:00Z`), {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <>
      <Card
        header={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-sans text-sm font-semibold text-(--el-text)">
              {t('month.title', { month: monthLabel })}
            </h2>
            <Link
              href={usageHref}
              className="font-sans text-xs text-(--el-accent-on-surface) hover:underline"
            >
              {t('month.open')}
            </Link>
          </div>
        }
      >
        {!sheet ? (
          <p role="status" className="font-sans text-sm text-(--el-text-secondary)">
            {t('month.unavailable')}
          </p>
        ) : (
          <table className="w-full font-sans text-sm" data-testid="org-month-categories">
            <thead>
              <tr className="text-left text-xs text-(--el-text-secondary)">
                <th className="py-1 font-medium">{t('month.category')}</th>
                <th className="py-1 text-right font-medium">{t('month.credits')}</th>
                <th className="py-1 text-right font-medium">{t('month.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row) => (
                <tr key={row.category} className="border-t border-(--el-border)">
                  <td className="py-1">
                    <Link href={usageHref} className="text-(--el-text) hover:underline">
                      {tc(row.category)}
                    </Link>
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {row.credits === null ? (
                      <span className="text-(--el-text-secondary)">{t('month.notCharged')}</span>
                    ) : (
                      format.number(row.credits)
                    )}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {formatMicroUsd(format, row.costMicroUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-(--el-border) font-semibold">
                <td className="py-1">{t('month.total')}</td>
                <td className="py-1 text-right tabular-nums">
                  {format.number(sheet.chargedCredits)}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {formatMicroUsd(format, sheet.costMicroUsdInclIndexing)}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card
          header={
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                {t('members.title')}
              </h2>
              <Pill tone="neutral">{format.number(overview.members.total)}</Pill>
            </div>
          }
        >
          {overview.members.items.length === 0 ? (
            <p className="font-sans text-sm text-(--el-text-secondary)">{t('members.empty')}</p>
          ) : (
            <ul className="flex flex-col" data-testid="org-members">
              {overview.members.items.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center justify-between gap-2 border-b border-(--el-border) py-2 last:border-b-0"
                >
                  <span className="min-w-0">
                    <Link
                      href={`/admin/users/${encodeURIComponent(m.userId)}`}
                      className="block truncate font-sans text-sm text-(--el-text) hover:underline"
                    >
                      {m.name ?? m.email}
                    </Link>
                    <span className="block truncate font-sans text-xs text-(--el-text-secondary)">
                      {m.email}
                    </span>
                  </span>
                  <Pill tone="neutral">{t(`members.role.${m.role}`)}</Pill>
                </li>
              ))}
            </ul>
          )}
          {overview.members.nextCursor || membersCursor ? (
            <div className="mt-2 flex gap-3 font-sans text-xs">
              {membersCursor ? (
                <Link
                  href={here({ members: null })}
                  className="text-(--el-accent-on-surface) hover:underline"
                >
                  {t('members.first')}
                </Link>
              ) : null}
              {overview.members.nextCursor ? (
                <Link
                  href={here({ members: overview.members.nextCursor })}
                  className="text-(--el-accent-on-surface) hover:underline"
                >
                  {t('members.next')}
                </Link>
              ) : null}
            </div>
          ) : null}
        </Card>

        <Card
          header={
            <h2 className="font-sans text-sm font-semibold text-(--el-text)">
              {t('workspaces.title')}
            </h2>
          }
        >
          {overview.workspaces.length === 0 ? (
            <p className="font-sans text-sm text-(--el-text-secondary)">{t('workspaces.empty')}</p>
          ) : (
            <table className="w-full font-sans text-sm" data-testid="org-workspaces">
              <thead>
                <tr className="text-left text-xs text-(--el-text-secondary)">
                  <th className="py-1 font-medium">{t('workspaces.name')}</th>
                  <th className="py-1 text-right font-medium">{t('workspaces.projects')}</th>
                  <th className="py-1 text-right font-medium">{t('workspaces.members')}</th>
                  <th className="py-1 text-right font-medium">{t('workspaces.credits')}</th>
                </tr>
              </thead>
              <tbody>
                {overview.workspaces.map((w) => (
                  <tr key={w.id} className="border-t border-(--el-border)">
                    <td className="py-1">
                      <Link
                        href={`/admin/tenants/${encodeURIComponent(org.id)}/workspaces/${encodeURIComponent(w.id)}`}
                        className="text-(--el-text) hover:underline"
                      >
                        {w.name}
                      </Link>
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {format.number(w.projectCount)}
                    </td>
                    <td className="py-1 text-right tabular-nums">{format.number(w.memberCount)}</td>
                    <td className="py-1 text-right tabular-nums">
                      {w.monthChargedCredits === null ? '—' : format.number(w.monthChargedCredits)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {overview.workspaceSpendUnavailable ? (
            <p role="status" className="mt-2 font-sans text-xs text-(--el-text-secondary)">
              {t('workspaces.spendUnavailable')}
            </p>
          ) : null}
          {overview.hasMoreWorkspaces ? (
            <p className="mt-2 font-sans text-xs text-(--el-text-secondary)">
              {t('workspaces.more')}
            </p>
          ) : null}
        </Card>
      </div>

      <Card
        header={
          <h2 className="font-sans text-sm font-semibold text-(--el-text)">{t('jobs.title')}</h2>
        }
      >
        {overview.jobs.unavailable ? (
          <p role="status" className="font-sans text-sm text-(--el-text-secondary)">
            {t('jobs.unavailable')}
          </p>
        ) : overview.jobs.items.length === 0 ? (
          <p className="font-sans text-sm text-(--el-text-secondary)">{t('jobs.empty')}</p>
        ) : (
          <table className="w-full font-sans text-sm" data-testid="org-jobs">
            <tbody>
              {overview.jobs.items.map((job) => (
                <tr
                  key={`${job.kind}:${job.id}`}
                  className="border-t border-(--el-border) first:border-t-0"
                >
                  <td className="whitespace-nowrap py-1 tabular-nums text-(--el-text-secondary)">
                    <time dateTime={job.at}>
                      {format.dateTime(new Date(job.at), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </time>
                  </td>
                  <td className="py-1">{tf(`kind.${job.kind}`)}</td>
                  <td className="py-1 text-(--el-text)">
                    {job.workspace ? job.workspace.name : tf('unattributed')}
                    {job.project ? ` › ${job.project.name}` : ''}
                  </td>
                  <td className="py-1 text-right text-(--el-text-secondary)">
                    {tf('runDetail', {
                      model: job.model ?? '—',
                      credits: format.number(job.credits ?? 0),
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {jobsStack.length > 0 || overview.jobs.nextCursor ? (
          <div className="mt-2 flex gap-3 font-sans text-xs">
            {jobsStack.length > 0 ? (
              <Link
                href={here({ jobs: jobsStack.slice(0, -1).join(',') || null })}
                className="text-(--el-accent-on-surface) hover:underline"
              >
                {t('jobs.newer')}
              </Link>
            ) : null}
            {overview.jobs.nextCursor ? (
              <Link
                href={here({ jobs: [...jobsStack, overview.jobs.nextCursor].join(',') })}
                className="text-(--el-accent-on-surface) hover:underline"
              >
                {t('jobs.older')}
              </Link>
            ) : null}
          </div>
        ) : null}
      </Card>
    </>
  );
}

/**
 * THE RECORD, on the same surface as the action (MOTIR-4568): an operator can never
 * perform an action and wonder whether it was recorded. Every row here is a WRITE.
 */
async function ActionLog({ overview }: { overview: PlatformOrgOverviewDTO }) {
  const t = await getTranslations('platformAdmin');
  const format = await getFormatter();
  return (
    <Card
      header={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-sans text-sm font-semibold text-(--el-text)">
            {t('orgs.log.title')}
          </h2>
          <Pill tone="neutral">{t('orgs.log.scope')}</Pill>
        </div>
      }
    >
      {overview.actions.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="h-10 w-10" aria-hidden />}
          title={t('orgs.log.emptyTitle')}
          description={t('orgs.log.emptyDescription')}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {overview.actions.map((row) => (
            <li key={row.id} className="flex flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <Pill severity="info">{t(`users.log.action.${row.action}`)}</Pill>
                <span className="font-sans text-xs text-(--el-text-secondary)">
                  {format.dateTime(new Date(row.createdAt))}
                </span>
              </span>
              <span className="font-sans text-sm text-(--el-text)">
                {row.reason ?? t('orgs.log.noReason')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

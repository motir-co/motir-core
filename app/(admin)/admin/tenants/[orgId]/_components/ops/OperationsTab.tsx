import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Lock, Power, ScrollText, ShieldCheck } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import type { PlatformCreditLedgerPageDTO } from '@/lib/dto/platformCreditOps';
import type { PlatformOrgOperationsDTO } from '@/lib/dto/platform';
import { platformRoleAtLeast, type PlatformPrincipal } from '@/lib/platform/auth';
import {
  PlatformCreditServiceUnavailableError,
  PlatformOrganizationNotFoundError,
} from '@/lib/platform/errors';
import { featureFlagService } from '@/lib/services/featureFlagService';
import { platformAuditService } from '@/lib/services/platformAuditService';
import { platformCreditOpsService } from '@/lib/services/platformCreditOpsService';
import { platformOrgPageService } from '@/lib/services/platformOrgPageService';
import { OrgPageHeader } from '../OrgPageHeader';
import { CreditsCard } from './CreditsCard';
import { KillSwitchControl } from './KillSwitchControl';
import { OrgLifecycleControl } from './OrgLifecycleControl';

/**
 * The `?tab=operations` route body (MOTIR-752). The GATE first — one audited
 * read of what motir-core holds, `notFound()` for a missing org, with no
 * Suspense boundary above it so the 404 keeps its status — then the header and
 * the tab, whose late cards stream behind in-page boundaries.
 */
export async function OperationsTabRoute({
  principal,
  orgId,
  backHref,
  chips,
}: {
  principal: PlatformPrincipal;
  orgId: string;
  backHref: string;
  chips: { isMeta: string; internalBilling: string };
}) {
  let operations: PlatformOrgOperationsDTO;
  try {
    operations = await platformOrgPageService.getOperations(principal, orgId);
  } catch (err) {
    if (err instanceof PlatformOrganizationNotFoundError) notFound();
    throw err;
  }
  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <OrgPageHeader
        org={operations.organization}
        principal={principal}
        tab="operations"
        backHref={backHref}
        chips={chips}
      />
      <OperationsTab data={operations} principal={principal} />
    </div>
  );
}

/**
 * The org page's OPERATIONS tab — design `platform-admin/design-notes.md`
 * AMENDMENT 2026-10-03, Panel 1 (MOTIR-752). Four cards: Organization status,
 * Credits & plan, Kill-switches, and the platform actions on this organization.
 *
 * ⚠️ THE GATE IS ABOVE THIS COMPONENT. The page has already read the org
 * (`platformOrgPageService.getOperations`) and called `notFound()` for a missing
 * one, so the three late cards stream behind in-page `<Suspense>` boundaries
 * placed AFTER the status is settled — never a `loading.tsx` above a route that
 * decides existence (CLAUDE.md). Each card fails alone (Panel 8b): an
 * unreachable credit service blanks the credits card only.
 *
 * ⚠️ ROLES ARE PRESENTATION (design § Roles). `operator` / `support` see every
 * card with no action rendered (Panel 8c); every write re-gates at `superadmin`
 * in its action and its service.
 */
export async function OperationsTab({
  data,
  principal,
}: {
  data: PlatformOrgOperationsDTO;
  principal: PlatformPrincipal;
}) {
  const t = await getTranslations('platformAdmin.ops');
  const canWrite = platformRoleAtLeast(principal.role, 'superadmin');
  const org = data.organization;

  return (
    <div className="flex flex-col gap-4" data-testid="ops-tab">
      {canWrite ? null : (
        <Card tint="yellow">
          <p className="flex items-start gap-2 font-sans text-sm text-(--el-text-strong)">
            <Lock aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-warning)" />
            {t('readOnlyRole', { role: t(`role.${principal.role}`) })}
          </p>
        </Card>
      )}

      <StatusCard data={data} canWrite={canWrite} />

      <Suspense fallback={<CardSkeleton title={t('credits.title')} />}>
        <CreditsSection data={data} principal={principal} canWrite={canWrite} />
      </Suspense>

      <Suspense fallback={<CardSkeleton title={t('switches.title')} />}>
        <SwitchesSection
          orgId={org.id}
          orgName={org.name}
          principal={principal}
          canWrite={canWrite}
        />
      </Suspense>

      <Suspense fallback={<CardSkeleton title={t('audit.title')} />}>
        <AuditSlice data={data} principal={principal} />
      </Suspense>
    </div>
  );
}

/** Panel 8a — one skeleton per card, its real title kept (it is content). */
async function CardSkeleton({ title }: { title: string }) {
  const tc = await getTranslations('common');
  return (
    <Card
      header={<h2 className="font-sans text-sm font-semibold text-(--el-text)">{title}</h2>}
      aria-busy="true"
    >
      <span className="sr-only">{tc('loading')}</span>
      <div className="flex animate-pulse flex-col gap-2" aria-hidden="true">
        <div className="h-6 w-40 rounded-(--radius-control) bg-(--el-muted)" />
        <div className="h-4 w-full rounded-(--radius-control) bg-(--el-muted)" />
        <div className="h-4 w-3/4 rounded-(--radius-control) bg-(--el-muted)" />
      </div>
    </Card>
  );
}

async function StatusCard({
  data,
  canWrite,
}: {
  data: PlatformOrgOperationsDTO;
  canWrite: boolean;
}) {
  const t = await getTranslations('platformAdmin.ops');
  const format = await getFormatter();
  const org = data.organization;
  const suspension = org.suspension;
  const operator = data.suspendedBy
    ? (data.suspendedBy.name ?? data.suspendedBy.email)
    : t('status.operatorUnknown');

  return (
    <Card
      data-testid="ops-status"
      header={
        <div className="flex flex-col gap-1">
          <h2 className="flex items-center gap-2 font-sans text-sm font-semibold text-(--el-text)">
            <ShieldCheck aria-hidden className="h-4 w-4 text-(--el-info)" />
            {t('status.title')}
          </h2>
          <p className="font-sans text-xs text-(--el-text-secondary)">{t('status.subtitle')}</p>
        </div>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          {suspension ? (
            <>
              <Pill severity="danger" className="self-start">
                <Lock aria-hidden className="h-3 w-3" />
                {t('status.suspendedPill')}
              </Pill>
              <p className="font-sans text-sm text-(--el-text)">
                {suspension.reason
                  ? t('status.suspendedSince', {
                      at: format.dateTime(new Date(suspension.suspendedAt), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }),
                      operator,
                      reason: suspension.reason,
                    })
                  : t('status.suspendedSinceNoReason', {
                      at: format.dateTime(new Date(suspension.suspendedAt), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }),
                      operator,
                    })}
              </p>
              <p className="font-sans text-xs text-(--el-text-secondary)">
                {t('status.suspendedEffect')}
              </p>
            </>
          ) : (
            <>
              <Pill severity="success" className="self-start">
                {t('status.activePill')}
              </Pill>
              <p className="font-sans text-sm text-(--el-text)">
                {t('status.active', { members: data.memberCount, workspaces: data.workspaceCount })}
              </p>
            </>
          )}
        </div>
        {canWrite ? (
          <OrgLifecycleControl
            orgId={org.id}
            name={org.name}
            slug={org.slug}
            suspended={suspension !== null}
            memberCount={data.memberCount}
            workspaceCount={data.workspaceCount}
          />
        ) : null}
      </div>
    </Card>
  );
}

/** The newest ledger page, or null when the credit service did not answer. */
async function readLedger(
  principal: PlatformPrincipal,
  orgId: string,
): Promise<PlatformCreditLedgerPageDTO | null> {
  try {
    return await platformCreditOpsService.getLedger(principal, orgId, null);
  } catch (err) {
    // Panel 8b: the credit service did not answer — a state of this card, never
    // a zero and never a page error. Anything else is a real fault.
    if (!(err instanceof PlatformCreditServiceUnavailableError)) throw err;
    return null;
  }
}

async function CreditsSection({
  data,
  principal,
  canWrite,
}: {
  data: PlatformOrgOperationsDTO;
  principal: PlatformPrincipal;
  canWrite: boolean;
}) {
  const org = data.organization;
  // The gate's answer is read beside the ledger, in parallel: the plan dialog
  // warns when the org does not count as paid (MOTIR-8985).
  const [initial, paidAnswer] = await Promise.all([
    readLedger(principal, org.id),
    platformCreditOpsService.paidAiPlanAnswer(org.id),
  ]);
  return (
    <CreditsCard
      orgId={org.id}
      orgName={org.name}
      slug={org.slug}
      paysThroughStripe={org.aiIncludedSeat}
      countsAsPaid={paidAnswer === true}
      canWrite={canWrite}
      initial={initial}
    />
  );
}

async function SwitchesSection({
  orgId,
  orgName,
  principal,
  canWrite,
}: {
  orgId: string;
  orgName: string;
  principal: PlatformPrincipal;
  canWrite: boolean;
}) {
  const t = await getTranslations('platformAdmin.ops');
  const format = await getFormatter();
  const switches = await featureFlagService.listForOrganization(principal, orgId);

  return (
    <Card
      data-testid="ops-switches"
      header={
        <div className="flex flex-col gap-1">
          <h2 className="flex items-center gap-2 font-sans text-sm font-semibold text-(--el-text)">
            <Power aria-hidden className="h-4 w-4 text-(--el-danger-on-surface)" />
            {t('switches.title')}
          </h2>
          <p className="font-sans text-xs text-(--el-text-secondary)">{t('switches.subtitle')}</p>
        </div>
      }
    >
      {switches.organizationSuspended ? (
        <p className="mb-3 font-sans text-xs text-(--el-text-secondary)">
          {t('switches.suspendedNote')}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full font-sans text-sm">
          <thead>
            <tr className="text-left text-xs text-(--el-text-secondary)">
              <th className="py-1 pr-3 font-medium">{t('switches.col.switch')}</th>
              <th className="py-1 pr-3 font-medium">{t('switches.col.whenOff')}</th>
              <th className="py-1 pr-3 font-medium">{t('switches.col.state')}</th>
              <th className="py-1 pr-3 font-medium">{t('switches.col.lastChanged')}</th>
              <th className="py-1 font-medium">
                <span className="sr-only">{t('switches.turnOff')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {switches.flags.map((flag) => (
              <tr
                key={flag.key}
                className="border-t border-(--el-border) align-top"
                data-testid={`ops-switch-row-${flag.key}`}
              >
                <td className="py-2 pr-3">
                  <span className="block text-(--el-text)">{t(`switch.${flag.key}.name`)}</span>
                  <code className="font-mono text-xs text-(--el-text-identifier)">{flag.key}</code>
                </td>
                <td className="max-w-[22rem] py-2 pr-3 text-(--el-text-secondary)">
                  {t(`switch.${flag.key}.whenOff`)}
                </td>
                <td className="py-2 pr-3">
                  {flag.enabled ? (
                    <Pill severity="success">{t('switches.on')}</Pill>
                  ) : (
                    <Pill severity="danger">{t('switches.off')}</Pill>
                  )}
                </td>
                <td className="max-w-[18rem] py-2 pr-3 text-xs text-(--el-text-secondary)">
                  {flag.updatedAt
                    ? t('switches.lastChange', {
                        at: format.dateTime(new Date(flag.updatedAt), { dateStyle: 'medium' }),
                        operator: flag.updatedBy?.label ?? t('status.operatorUnknown'),
                        reason: flag.reason ?? '—',
                      })
                    : t('switches.never')}
                </td>
                <td className="py-2">
                  <KillSwitchControl
                    orgId={orgId}
                    orgName={orgName}
                    flagKey={flag.key}
                    enabled={flag.enabled}
                    canWrite={canWrite}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** How many of the org's newest writes the slice shows (design: "3 newest"). */
const AUDIT_SLICE_ROWS = 3;

interface SliceRow {
  key: string;
  at: string;
  action: string;
  actor: string | null;
  reason: string | null;
}

/**
 * THE RECORD, rendered back on the surface that made it (§ safe-action pattern,
 * rule 5). A superadmin reads it through the audit log's own search
 * (`searchEntries`, scoped to this org — the same rows the full log opens on);
 * `operator` / `support`, who cannot open the audit log, see the org page's own
 * write trail, which the operations read already carried.
 */
async function AuditSlice({
  data,
  principal,
}: {
  data: PlatformOrgOperationsDTO;
  principal: PlatformPrincipal;
}) {
  const t = await getTranslations('platformAdmin');
  const format = await getFormatter();
  const org = data.organization;
  const superadmin = platformRoleAtLeast(principal.role, 'superadmin');

  let rows: SliceRow[];
  if (superadmin) {
    const page = await platformAuditService.searchEntries(principal, {
      organizationId: org.id,
      writesOnly: true,
    });
    rows = page.entries.slice(0, AUDIT_SLICE_ROWS).map((e) => ({
      key: e.id,
      at: e.createdAt,
      action: e.action,
      actor: e.actor.email,
      reason: e.reason,
    }));
  } else {
    rows = data.actions.slice(0, AUDIT_SLICE_ROWS).map((a) => ({
      key: a.id,
      at: a.createdAt,
      action: a.action,
      actor: null,
      reason: a.reason,
    }));
  }
  const logHref = `/admin/audit-log?org=${encodeURIComponent(org.id)}`;

  return (
    <Card
      data-testid="ops-audit"
      header={
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <h2 className="flex items-center gap-2 font-sans text-sm font-semibold text-(--el-text)">
              <ScrollText aria-hidden className="h-4 w-4 text-(--el-accent-on-surface)" />
              {t('ops.audit.title')}
            </h2>
            <p className="font-sans text-xs text-(--el-text-secondary)">
              {t('ops.audit.subtitle')}
            </p>
          </div>
          {superadmin ? (
            <Link
              href={logHref}
              className="font-sans text-xs text-(--el-accent-on-surface) hover:underline"
            >
              {t('ops.audit.open')}
            </Link>
          ) : null}
        </div>
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={<ScrollText className="h-10 w-10" aria-hidden />}
          title={t('ops.audit.empty')}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.key} className="flex flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-xs text-(--el-text-identifier)">{row.action}</code>
                <span className="font-sans text-xs text-(--el-text-secondary)">
                  {format.dateTime(new Date(row.at), { dateStyle: 'medium', timeStyle: 'short' })}
                  {row.actor ? ` · ${row.actor}` : ''}
                </span>
              </span>
              <span className="font-sans text-sm text-(--el-text)">
                {row.reason ?? t('ops.audit.noReason')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

import { Suspense } from 'react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { MOTIR_RUNNER_LABEL, MOTIR_RUNNER_VARIABLE } from '@/lib/ciFleet/config';
import type { FleetOrgCiStateDTO, FleetOrgCiTargetDTO } from '@/lib/dto/fleetOrgCiSetting';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { agentHostingSettingService } from '@/lib/services/agentHostingSettingService';
import { fleetOrgCiSettingService } from '@/lib/services/fleetOrgCiSettingService';
import type { FleetKindSwitchStateDTO } from '@/lib/dto/fleetKindSwitch';
import { AgentHostingSetting, AgentHostingUnavailable } from './_components/AgentHostingSetting';
import { FleetOrgCiSetting, type FleetOrgCiConstants } from './_components/FleetOrgCiSetting';
import { FleetSettingsUnavailable } from './_components/FleetSettingsUnavailable';

/**
 * The console's FLEET SETTINGS page — design `platform-admin/design-notes.md`
 * § AMENDMENT 2026-10 (Fleet settings · Motir CI on the fleet, MOTIR-8703),
 * card MOTIR-8715, story MOTIR-8699.
 *
 * ⚠️ `superadmin` ONLY, AND EVERYONE ELSE GETS THE 404 — the Audit log route's
 * gate (design § The roles). `getState` and `setEnabled` are superadmin-only
 * in the service too, so the page has no read-only face.
 *
 * ⚠️ NO STATE IS GUESSED. A failed read renders the console's error card with
 * Retry and no switch (Panel 12). The pairs are whatever `listTargets` returns,
 * in its order; nothing here names an org.
 *
 * ⚠️ NO `loading.tsx`. The gate decides existence, so the readiness reads (GitHub
 * round trips) stream behind an in-page `<Suspense>` placed AFTER it.
 */

export const metadata: Metadata = { title: 'Fleet settings' };

/** Never cached — a flip a minute ago must show on the next load. */
export const dynamic = 'force-dynamic';

const CONSTANTS: FleetOrgCiConstants = {
  variableName: MOTIR_RUNNER_VARIABLE,
  runnerLabel: MOTIR_RUNNER_LABEL,
  fleetName: 'motir-fleet',
  killSwitchVariable: 'MOTIR_FLEET_MAX_IN_FLIGHT',
};

export default async function AdminFleetSettingsPage() {
  const principal = await requirePlatformStaffPage('superadmin');
  const t = await getTranslations('platformAdmin.fleetSettings');

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <p className="font-sans text-xs uppercase tracking-wide text-(--el-text-secondary)">
        {t('breadcrumb')}
      </p>
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl text-(--el-text)">{t('title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">{t('subtitle')}</p>
      </div>
      <Suspense fallback={<SectionSkeleton />}>
        <FleetSettingsSection principal={principal} />
      </Suspense>
      {/* Agent hosting (MOTIR-9534 · MOTIR-9503) — AFTER the per-org Motir-CI
          section, and read on its own, so either one failing leaves the other. */}
      <Suspense fallback={<SectionSkeleton />}>
        <AgentHostingSection principal={principal} />
      </Suspense>
    </div>
  );
}

function SectionSkeleton() {
  return (
    <Card aria-busy="true">
      <div className="flex animate-pulse flex-col gap-2" aria-hidden="true">
        <div className="h-6 w-56 rounded-(--radius-control) bg-(--el-muted)" />
        <div className="h-4 w-full rounded-(--radius-control) bg-(--el-muted)" />
        <div className="h-4 w-2/3 rounded-(--radius-control) bg-(--el-muted)" />
      </div>
    </Card>
  );
}

/**
 * The agent hoster's Fly↔AWS switch (Panels 1–10). A failed read renders the
 * section's error card with Retry and no switch (Panel 10) — never a default.
 */
async function AgentHostingSection({ principal }: { principal: PlatformPrincipal }) {
  let state: FleetKindSwitchStateDTO;
  try {
    state = await agentHostingSettingService.getState(principal);
  } catch (err) {
    if (err instanceof NotPlatformStaffError) throw err;
    console.error('[admin] agent hosting setting could not be read');
    return <AgentHostingUnavailable />;
  }
  return <AgentHostingSetting state={state} />;
}

async function FleetSettingsSection({ principal }: { principal: PlatformPrincipal }) {
  const t = await getTranslations('platformAdmin.fleetSettings');
  let targets: FleetOrgCiTargetDTO[];
  try {
    targets = await fleetOrgCiSettingService.listTargets(principal);
  } catch (err) {
    if (err instanceof NotPlatformStaffError) throw err;
    console.error('[admin] fleet settings targets could not be read');
    return <FleetSettingsUnavailable />;
  }
  if (targets.length === 0) {
    return <EmptyState data-testid="fleet-settings-empty" title={t('empty')} />;
  }
  const states = await Promise.all(
    targets.map(async (target) => {
      try {
        return await fleetOrgCiSettingService.getState(principal, {
          projectId: target.projectId,
          org: target.org,
        });
      } catch (err) {
        if (err instanceof NotPlatformStaffError) throw err;
        console.error('[admin] fleet settings state could not be read', {
          projectId: target.projectId,
          org: target.org,
        });
        return null;
      }
    }),
  );
  return (
    <div className="flex flex-col gap-6">
      {targets.map((target, i) => {
        const state: FleetOrgCiStateDTO | null = states[i] ?? null;
        const key = `${target.projectId}:${target.org}`;
        return state ? (
          <FleetOrgCiSetting key={key} target={target} state={state} constants={CONSTANTS} />
        ) : (
          <FleetSettingsUnavailable key={key} />
        );
      })}
    </div>
  );
}

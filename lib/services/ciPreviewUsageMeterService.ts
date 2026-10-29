import type { PreviewUsageKind } from '@/generated/prisma/client';
import type {
  DatabaseBranchHandle,
  DatabaseUsage,
  HostingDeployTarget,
  ReleaseUsage,
} from '@motir/orchestrator';
import { isCiMeteringEnabled } from '@/lib/ciMetering/config';
import { periodStartFor } from '@/lib/ciMetering/period';
import { priceSlice } from '@/lib/ciMetering/previewRates';
import { getDatabasePort } from '@/lib/orchestrator/database';
import { getHostingDeployPort } from '@/lib/orchestrator/hosting';
import { NEON_PREVIEW_TARGETS } from '@/lib/preview/enablement';
import { previewBranchName, previewDatabaseApplicationRef } from '@/lib/preview/previewDatabase';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import {
  previewUsageRepository,
  type MeteredPreview,
  type PreviewUsageSliceInput,
} from '@/lib/repositories/previewUsageRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { withSystemContext } from '@/lib/workspaces/context';

// The PREVIEW USAGE METER (Story MOTIR-5766 · MOTIR-5777). A pull request's
// preview runs on Motir's Fly or serverless account and a Neon branch, and that
// usage is charged through the allowance Motir-hosted repositories already have:
// converted to Linux-equivalent minutes at MOTIR-5769 §9's factors
// (`lib/ciMetering/previewRates.ts`), counted in the same per-seat pool
// (`ciMinutesMeterService.getOrgPeriodConsumption` adds it), and charged as the
// existing `ci_overage` credits past it by the shipped charge. Motir's own cost
// is recorded on every slice beside the minutes.
//
// ⚠️ THE LIFECYCLE NEVER CALLS THIS. `previewLifecycleService` destroys apps and
// branches through the ports and knows nothing of billing. The composition root
// (`lib/orchestrator/index.ts`) observes the ports' `destroyApp` and
// `deleteBranch` and hands their usage here — the port's "destroy returns
// usage" rule (`docs/decisions/ci-runner-fleet.md` §4) reaching a ledger.
//
// Two measurements, because the providers report two ways:
//
//   · A RELEASE (Fly running seconds, Lambda GB-seconds and requests) reports
//     usage over any window (`usageSince`). The hourly accrual records the
//     window since the preview's last slice, so a preview that lives for weeks
//     is charged in the month it ran. The final slice at `destroyApp` is the
//     destroy's whole-life figure less what this app's slices already hold.
//   · A NEON BRANCH reports only its life-to-date counters (`branchUsage`,
//     `deleteBranch`), so each slice is that figure less what was recorded for
//     the same branch.
//
// Each preview's writes are serialised on its row (`FOR UPDATE`), and an accrual
// whose window another writer advanced meanwhile writes nothing: the next pass
// measures from the new end. `(preview, kind, slice end)` is unique, so a replay
// of the same window writes one slice. AWS previews run in the tenant's own
// account and are not converted (§9), so nothing here meters them.

/** What one release target's windows are measured in. */
const RELEASE_KINDS: Readonly<Partial<Record<HostingDeployTarget, readonly PreviewUsageKind[]>>> = {
  fly: ['machine_seconds'],
  serverless: ['lambda_gb_seconds', 'lambda_requests'],
};

const BRANCH_KIND: PreviewUsageKind = 'neon_compute_hours';

/** Below this a quantity is a rounding residue, not usage. */
const EPSILON = 1e-6;

export interface PreviewUsageAccrualResult {
  previews: number;
  slices: number;
  failed: number;
}

/** A release's usage in every kind's unit; the kinds its target does not bill
 *  in are simply never read. */
function releaseQuantities(usage: readonly ReleaseUsage[]): Record<PreviewUsageKind, number> {
  const sum = (of: (u: ReleaseUsage) => number) => usage.reduce((total, u) => total + of(u), 0);
  return {
    machine_seconds: sum((u) => u.runningSeconds),
    lambda_gb_seconds: sum((u) => (u.compute?.unit === 'lambda' ? u.compute.gbSeconds : 0)),
    lambda_requests: sum((u) => u.invocations ?? 0),
    neon_compute_hours: 0,
  };
}

function slice(
  preview: MeteredPreview,
  kind: PreviewUsageKind,
  sourceRef: string,
  quantity: number,
  window: { start: Date; end: Date },
): PreviewUsageSliceInput {
  return {
    previewDeploymentId: preview.id,
    organizationId: preview.repo.organizationId,
    workspaceId: preview.workspaceId,
    kind,
    sourceRef,
    quantity,
    ...priceSlice(kind, quantity),
    // The month the slice ENDS in owns it; an hourly slice crossing midnight on
    // the 1st is the only case where that differs from where it began.
    periodStart: periodStartFor(new Date(window.end.getTime() - 1)),
    sliceStart: window.start,
    sliceEnd: window.end,
  };
}

function latest(dates: readonly Date[]): Date {
  return new Date(Math.max(...dates.map((d) => d.getTime())));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Charge one organisation for what is now in its period, through the shipped
 * charge — the meta organisation is measured and never charged, as on every CI
 * path. Never throws: the next slice retries the same watermark.
 */
async function chargeOrganization(organizationId: string, periodStart: Date): Promise<void> {
  try {
    const isMeta = await withOrgServiceWriteContext(organizationId, async (tx) => {
      const org = await organizationRepository.findByIdInTx(organizationId, tx);
      // A missing row charges rather than bypasses — the safe direction.
      return org?.isMeta ?? false;
    });
    await ciAllowanceService.chargeForMeteredRun({ organizationId, periodStart, isMeta });
  } catch (error) {
    console.error('[ciPreviewUsageMeter] could not charge an organization — retried next slice', {
      organizationId,
      error: messageOf(error),
    });
  }
}

/**
 * Lock the preview, build its slices from what is recorded NOW, write them, then
 * charge each organisation-period they landed in through the shipped charge.
 * Returns how many slices were new.
 */
async function writeSlices(
  previewId: string,
  build: (
    tx: Parameters<Parameters<typeof withSystemContext>[0]>[0],
  ) => Promise<PreviewUsageSliceInput[]>,
): Promise<number> {
  const written = await withSystemContext(async (tx) => {
    await previewUsageRepository.lockPreview(previewId, tx);
    const slices = await build(tx);
    return { count: await previewUsageRepository.insertSlices(slices, tx), slices };
  });
  if (written.count > 0) {
    const periods = new Map<string, { organizationId: string; periodStart: Date }>();
    for (const s of written.slices) {
      periods.set(`${s.organizationId}:${s.periodStart.toISOString()}`, s);
    }
    // After the commit, as every CI charge is (§8.6); never throws.
    for (const { organizationId, periodStart } of periods.values()) {
      await chargeOrganization(organizationId, periodStart);
    }
  }
  return written.count;
}

/** The repository's hosting target and project row, for a preview. */
async function targetOf(
  preview: MeteredPreview,
): Promise<{ target: HostingDeployTarget; projectRepoId: string } | null> {
  const subject = await withSystemContext((tx) =>
    projectRepoRepository.findPreviewLifecycleSubjectByGithubRepoInTx(preview.repoId, tx),
  );
  return subject?.hostingTarget
    ? { target: subject.hostingTarget, projectRepoId: subject.id }
    : null;
}

/** Record one window of a live preview's release usage. */
async function accrueRelease(
  preview: MeteredPreview,
  target: HostingDeployTarget,
): Promise<number> {
  const kinds = RELEASE_KINDS[target];
  const appRef = preview.flyAppName;
  if (!kinds || !appRef) return 0;
  const recordedEnd = await withSystemContext((tx) =>
    previewUsageRepository.lastSliceEnd(preview.id, kinds, tx),
  );
  const start = recordedEnd ?? preview.createdAt;
  const port = getHostingDeployPort(target);
  const releases = (await port.listReleases({ appRef })).filter(
    (r) => r.state !== 'destroyed' && r.state !== 'waiting_for_account',
  );
  if (releases.length === 0) return 0;
  const usage = await Promise.all(releases.map((r) => port.usageSince(r.handle, start)));
  const end = latest(usage.map((u) => u.until));
  if (end.getTime() <= start.getTime()) return 0;
  const quantities = releaseQuantities(usage);

  return writeSlices(preview.id, async (tx) => {
    // Another writer advanced the window while we measured: ours overlaps it.
    const now = await previewUsageRepository.lastSliceEnd(preview.id, kinds, tx);
    if ((now?.getTime() ?? null) !== (recordedEnd?.getTime() ?? null)) return [];
    return kinds
      .filter((kind) => quantities[kind] > EPSILON)
      .map((kind) => slice(preview, kind, appRef, quantities[kind], { start, end }));
  });
}

/** Record a branch's life-to-date usage beyond what its slices already hold. */
async function recordBranchUsage(
  preview: MeteredPreview,
  branchRef: string,
  usage: DatabaseUsage,
): Promise<number> {
  const total = usage.computeSeconds / 3600;
  return writeSlices(preview.id, async (tx) => {
    const recorded = await previewUsageRepository.sumQuantity(
      { previewDeploymentId: preview.id, kind: BRANCH_KIND, sourceRef: branchRef },
      tx,
    );
    const delta = total - recorded;
    const lastEnd = await previewUsageRepository.lastSliceEnd(preview.id, [BRANCH_KIND], tx);
    const start = lastEnd && lastEnd > usage.since ? lastEnd : usage.since;
    if (delta <= EPSILON || usage.until.getTime() <= start.getTime()) return [];
    return [slice(preview, BRANCH_KIND, branchRef, delta, { start, end: usage.until })];
  });
}

/** The branch handle a live preview's row names. */
function branchOf(preview: MeteredPreview, projectRepoId: string): DatabaseBranchHandle | null {
  if (!preview.neonBranchId || !preview.neonProjectId) return null;
  return {
    database: {
      provider: 'neon',
      applicationRef: previewDatabaseApplicationRef(projectRepoId),
      databaseRef: preview.neonProjectId,
    },
    branchRef: preview.neonBranchId,
    name: previewBranchName(preview.pullRequestNumber),
  };
}

export const ciPreviewUsageMeterService = {
  /**
   * The hourly accrual: one slice per kind for every live preview holding a
   * release or a branch. One preview's failure is counted and logged, and the
   * pass moves on; its next pass measures from where its slices end.
   */
  async accrue(): Promise<PreviewUsageAccrualResult> {
    const result: PreviewUsageAccrualResult = { previews: 0, slices: 0, failed: 0 };
    if (!isCiMeteringEnabled()) return result;
    const previews = await withSystemContext((tx) => previewUsageRepository.listMetered(tx));
    for (const preview of previews) {
      result.previews += 1;
      try {
        const located = await targetOf(preview);
        if (!located) continue;
        result.slices += await accrueRelease(preview, located.target);
        const branch = NEON_PREVIEW_TARGETS.includes(located.target)
          ? branchOf(preview, located.projectRepoId)
          : null;
        if (branch) {
          const usage = await getDatabasePort(branch.database.provider).branchUsage(branch);
          result.slices += await recordBranchUsage(preview, branch.branchRef, usage);
        }
      } catch (error) {
        result.failed += 1;
        console.warn('[ciPreviewUsageMeter] accrual failed for a preview', {
          previewId: preview.id,
          error: messageOf(error),
        });
      }
    }
    return result;
  },

  /**
   * The final slice of a destroyed preview app: the destroy's whole-life usage
   * less what this app's slices hold. Bound to the hosting port's `destroyApp` by
   * the composition root. NEVER THROWS — the app is already gone, so a failure
   * here can only be logged, with the figures, for reconciliation.
   */
  async recordDestroyedApp(input: {
    target: HostingDeployTarget;
    appRef: string;
    usage: readonly ReleaseUsage[];
  }): Promise<number> {
    const kinds = RELEASE_KINDS[input.target];
    if (!kinds || input.usage.length === 0 || !isCiMeteringEnabled()) return 0;
    try {
      const preview = await withSystemContext((tx) =>
        previewUsageRepository.findMetered({ flyAppName: input.appRef }, tx),
      );
      // A push namespace, a production app: not a preview, not this meter's.
      if (!preview) return 0;
      const totals = releaseQuantities(input.usage);
      const born = new Date(Math.min(...input.usage.map((u) => u.since.getTime())));
      const end = latest(input.usage.map((u) => u.until));
      return await writeSlices(preview.id, async (tx) => {
        const lastEnd = await previewUsageRepository.lastSliceEnd(preview.id, kinds, tx);
        const start = lastEnd && lastEnd > born ? lastEnd : born;
        if (end.getTime() <= start.getTime()) return [];
        const slices: PreviewUsageSliceInput[] = [];
        for (const kind of kinds) {
          // Only this generation of the app: a reopened pull request's earlier
          // app had the same name and ended before this one was born.
          const recorded = await previewUsageRepository.sumQuantity(
            { previewDeploymentId: preview.id, kind, sourceRef: input.appRef, endingAfter: born },
            tx,
          );
          const delta = totals[kind] - recorded;
          if (delta > EPSILON)
            slices.push(slice(preview, kind, input.appRef, delta, { start, end }));
        }
        return slices;
      });
    } catch (error) {
      console.error('[ciPreviewUsageMeter] a destroyed preview app’s usage was not recorded', {
        appRef: input.appRef,
        usage: input.usage,
        error: messageOf(error),
      });
      return 0;
    }
  },

  /** The final slice of a deleted preview branch. Bound to the database port's
   *  `deleteBranch`; NEVER THROWS, for the same reason. */
  async recordDeletedBranch(input: {
    branch: DatabaseBranchHandle;
    usage: DatabaseUsage;
  }): Promise<number> {
    if (input.usage.computeSeconds <= 0 || !isCiMeteringEnabled()) return 0;
    try {
      const preview = await withSystemContext((tx) =>
        previewUsageRepository.findMetered({ neonBranchId: input.branch.branchRef }, tx),
      );
      if (!preview) return 0;
      return await recordBranchUsage(preview, input.branch.branchRef, input.usage);
    } catch (error) {
      console.error('[ciPreviewUsageMeter] a deleted preview branch’s usage was not recorded', {
        branchRef: input.branch.branchRef,
        usage: input.usage,
        error: messageOf(error),
      });
      return 0;
    }
  },
};

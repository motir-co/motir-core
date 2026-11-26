import { periodEndFor, periodStartFor } from '@/lib/ciMetering/period';
import type { ProductionUsageDto, ProductionUsageExhaustedDto } from '@/lib/dto/productionUsage';
import { dailyChargeCredits } from '@/lib/hosting/productionRates';
import { utcDayOf } from '@/lib/hosting/productionUsage';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { hostedApplicationRepository } from '@/lib/repositories/hostedApplicationRepository';
import { productionUsageSliceRepository } from '@/lib/repositories/productionUsageSliceRepository';
import {
  EXHAUSTED_SUSPEND_AFTER_MS,
  productionCreditBalanceService,
} from '@/lib/services/productionCreditBalanceService';
import { resolveRepository } from '@/lib/services/productionPanelService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// A PRODUCTION APPLICATION'S USAGE THIS PERIOD (Story MOTIR-9799 · MOTIR-12108;
// Decision MOTIR-12100) — the read the Production panel's Usage section draws,
// and the organisation's balance as the hosting paths read it.
//
// The period is the calendar month in UTC, the CI meter's (`periodStartFor`).
// Each application answers only its own slices. `credits_exhausted` is the
// application's stored transition (set by the meter when the organisation's
// balance falls below zero), confirmed by a live balance read: a top-up shows at
// once rather than at the meter's next pass. A customer repository is refused
// before anything is read (`resolveRepository`), and nothing here reads or
// writes the project's phase. The balance reads live in
// `productionCreditBalanceService`, which the meter imports instead of this
// module: this one's panel-service import reaches `@/lib/auth` (MOTIR-12168).

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The current period's usage of one application, by its id. */
async function getCurrentPeriod(
  applicationId: string,
  options: { now?: Date } = {},
): Promise<ProductionUsageDto> {
  const now = options.now ?? new Date();
  const start = periodStartFor(now);
  const end = periodEndFor(start);
  const period = { start: start.toISOString(), end: end.toISOString() };
  const app = await withSystemContext((tx) =>
    hostedApplicationRepository.findMeterTarget(applicationId, tx),
  );
  if (!app) {
    return {
      period,
      usage: [],
      credits: 0,
      motirCostRecorded: false,
      state: 'no_release',
      exhausted: null,
    };
  }
  const window = { from: start, to: end };
  // The days CHARGED so far: each closes at UTC midnight, so today's open day is
  // in the rows above but not yet in the total (design § Usage, the footnote).
  const charged = { from: start, to: new Date(Math.min(end.getTime(), utcDayOf(now).getTime())) };
  const { lines, days, costed } = await withWorkspaceServiceContext(
    app.workspaceId,
    async (tx) => ({
      lines: await productionUsageSliceRepository.sumByUnit(app.id, window, tx),
      days: await productionUsageSliceRepository.sumCreditsByDay(app.id, charged, tx),
      costed: await productionUsageSliceRepository.hasMotirCost(app.id, window, tx),
    }),
  );

  let exhausted: ProductionUsageExhaustedDto | null = null;
  if (app.creditsExhaustedSince) {
    const { below, balance } = await productionCreditBalanceService.isBelowZero(
      app.organizationId,
      app.creditsExhaustedSince,
    );
    if (below) {
      // The date is promised only where the 7-day switch will act: the same
      // selection the meter switches by, so a takeover grace window (exempt,
      // MOTIR-12143) and a target that cannot suspend are never given one
      // (MOTIR-12248).
      const switched =
        productionCreditBalanceService.takesOutOfCreditsAction(app) && app.idleMode === 'always_on';
      exhausted = {
        since: app.creditsExhaustedSince.toISOString(),
        balance,
        canSuspend: productionCreditBalanceService.canSuspend(app),
        suspendsAt: switched
          ? new Date(app.creditsExhaustedSince.getTime() + EXHAUSTED_SUSPEND_AFTER_MS).toISOString()
          : null,
        graceStopsAt: app.state === 'grace' && app.stopsAt ? app.stopsAt.toISOString() : null,
      };
    }
  }

  return {
    period,
    usage: lines.map((l) => ({ unit: l.unit, quantity: l.quantity, credits: round2(l.credits) })),
    credits: days.reduce((sum, day) => sum + dailyChargeCredits([day]), 0),
    motirCostRecorded: costed,
    state: exhausted ? 'credits_exhausted' : app.currentRelease ? 'ok' : 'no_release',
    exhausted,
  };
}

/**
 * The usage read of a repository's production application, for any member who
 * can browse the project. A customer repository, another project's and one the
 * viewer cannot browse are refused as not found; a repository with no
 * application yet answers `no_release` with no usage.
 */
async function getUsageForRepository(
  projectKey: string,
  projectRepositoryId: string,
  actor: ServiceContext,
  options: { now?: Date } = {},
): Promise<ProductionUsageDto> {
  const { projectId } = await resolveRepository(projectKey, projectRepositoryId, actor);
  const permissions = await projectAccessService.getPermissions(projectId, actor);
  if (!permissions.has('project:browse')) throw new ProjectNotFoundError(projectId);
  const appId = await withWorkspaceServiceContext(actor.workspaceId, async (tx) => {
    const row = await hostedApplicationRepository.findByProjectRepository(projectRepositoryId, tx);
    return row?.id ?? null;
  });
  // An unknown id answers the empty period.
  return getCurrentPeriod(appId ?? '', options);
}

export const productionUsageService = {
  getCurrentPeriod,
  getUsageForRepository,
};

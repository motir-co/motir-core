import { idlePolicyRefusal } from '@motir/orchestrator';
import { getOrgUsage } from '@/lib/ai/motirAiClient';
import { periodEndFor, periodStartFor } from '@/lib/ciMetering/period';
import type { ProductionUsageDto, ProductionUsageExhaustedDto } from '@/lib/dto/productionUsage';
import { HOSTED_IDLE_SECONDS_DEFAULT } from '@/lib/hosting/idlePolicy';
import { dailyChargeCredits } from '@/lib/hosting/productionRates';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  hostedApplicationRepository,
  type HostedApplicationMeterTarget,
} from '@/lib/repositories/hostedApplicationRepository';
import { productionUsageSliceRepository } from '@/lib/repositories/productionUsageSliceRepository';
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
// writes the project's phase.

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long an always-on application may run below zero before it is switched
 *  to suspend when idle (Decision MOTIR-12100 §9). */
export const EXHAUSTED_SUSPEND_AFTER_MS = 7 * DAY_MS;

/** The organisation's credit balance, or null when motir-ai could not answer —
 *  never 0 and never a throw: an outage must not read as exhaustion. */
async function readOrganizationBalance(organizationId: string): Promise<number | null> {
  try {
    const usage = await getOrgUsage({ coreOrganizationId: organizationId, scope: 'org' });
    return typeof usage.balance === 'number' ? usage.balance : null;
  } catch (error) {
    console.warn('[productionUsageService] could not read an organisation’s balance', {
      organizationId,
      error: error instanceof Error ? error.name : 'UNKNOWN',
    });
    return null;
  }
}

/**
 * Whether the organisation is below zero now: the live balance when it can be
 * read, otherwise the meter's stored transition (`storedSince`). The
 * always-on refusal and the Usage read both decide by it.
 */
async function isBelowZero(
  organizationId: string,
  storedSince: Date | null,
): Promise<{ below: boolean; balance: number | null }> {
  const balance = await readOrganizationBalance(organizationId);
  return { below: balance === null ? storedSince !== null : balance < 0, balance };
}

/** Whether the application's target and shape can run suspend-when-idle. */
function canSuspend(app: Pick<HostedApplicationMeterTarget, 'target' | 'hostingShape'>): boolean {
  return (
    idlePolicyRefusal(app.target, app.hostingShape, {
      mode: 'suspend',
      idleSeconds: HOSTED_IDLE_SECONDS_DEFAULT,
    }) === null
  );
}

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
  const { lines, days, costed } = await withWorkspaceServiceContext(
    app.workspaceId,
    async (tx) => ({
      lines: await productionUsageSliceRepository.sumByUnit(app.id, window, tx),
      days: await productionUsageSliceRepository.sumCreditsByDay(app.id, window, tx),
      costed: await productionUsageSliceRepository.hasMotirCost(app.id, window, tx),
    }),
  );

  let exhausted: ProductionUsageExhaustedDto | null = null;
  if (app.creditsExhaustedSince) {
    const { below, balance } = await isBelowZero(app.organizationId, app.creditsExhaustedSince);
    if (below) {
      const suspends = canSuspend(app);
      exhausted = {
        since: app.creditsExhaustedSince.toISOString(),
        balance,
        canSuspend: suspends,
        suspendsAt:
          suspends && app.idleMode === 'always_on'
            ? new Date(
                app.creditsExhaustedSince.getTime() + EXHAUSTED_SUSPEND_AFTER_MS,
              ).toISOString()
            : null,
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
  readOrganizationBalance,
  isBelowZero,
  canSuspend,
};

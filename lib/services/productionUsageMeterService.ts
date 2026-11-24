import type { DatabaseUsage, ReleaseUsage } from '@motir/orchestrator';
import { debitHostingProduction } from '@/lib/ai/motirAiClient';
import {
  MotirAiBadRequestError,
  MotirAiConfigError,
  MotirAiError,
  MotirAiJobNotFoundError,
  MotirAiUnavailableError,
} from '@/lib/ai/errors';
import { periodStartFor } from '@/lib/ciMetering/period';
import { HOSTED_IDLE_SECONDS_DEFAULT } from '@/lib/hosting/idlePolicy';
import { dailyChargeCredits, priceProductionSlice } from '@/lib/hosting/productionRates';
import {
  chargeDayOf,
  DATABASE_UNITS,
  databaseUnitQuantities,
  dayKey,
  RELEASE_UNITS,
  releaseUnitQuantities,
  sliceIdempotencyKey,
  utcDayOf,
  type UnitQuantity,
} from '@/lib/hosting/productionUsage';
import { releaseHandleFor } from '@/lib/hosting/releaseUsage';
import { getDatabasePort } from '@/lib/orchestrator/database';
import { getHostingDeployPort } from '@/lib/orchestrator/hosting';
import { isOrganizationSeedSource } from '@/lib/projectRepos/vocabulary';
import {
  hostedApplicationRepository,
  type HostedApplicationMeterTarget,
} from '@/lib/repositories/hostedApplicationRepository';
import { hostedReleaseRepository } from '@/lib/repositories/hostedReleaseRepository';
import {
  productionUsageSliceRepository,
  type ProductionUsageSliceInput,
} from '@/lib/repositories/productionUsageSliceRepository';
import { hostedIdlePolicyService } from '@/lib/services/hostedIdlePolicyService';
import {
  EXHAUSTED_SUSPEND_AFTER_MS,
  productionCreditBalanceService,
} from '@/lib/services/productionCreditBalanceService';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import type { ProductionUsageUnit } from '@/generated/prisma/client';

// THE PRODUCTION USAGE METER (Story MOTIR-9799 · MOTIR-12108; Decision
// MOTIR-12100). A Motir repository's production application runs on Motir's Fly,
// serverless or AWS accounts, and its database on Neon; this meter charges that
// to the organisation's credits WHILE it runs, after the preview meter's shape
// (`ciPreviewUsageMeterService`):
//
//   · HOURLY SLICES (§5). Each pass reads the live release's usage through the
//     deploy port's `usageSince`, and the production database's through the
//     database port's, from the end of the application's last slice, and writes
//     one slice per unit, priced at the decision's derived factor with Motir's
//     own list-price cost beside it. Port calls hold no transaction. The writes
//     run under the application's row lock, and a pass whose window another
//     writer advanced writes nothing; `(application, unit, slice end)` is unique.
//   · THE FINAL SLICE. Before a release is replaced, rolled back or removed, the
//     release path asks for its last window (`accrueOutgoingRelease`), so the time
//     since the last pass is charged, not lost. It never throws.
//   · ONE CHARGE PER APPLICATION PER UTC DAY (§6). Once a day has ended, its
//     slices are closed (`charging`) under the same row lock — no later slice can
//     join them — summed, rounded up once, and debited as `hosting_production`
//     through motir-ai, which keys the ledger on the application and the day. A
//     debit that times out is asked again with the same day; one motir-ai already
//     applied answers `idempotent`. Every organisation is charged — an internal
//     one included, for which motir-ai writes the paired `internal_offset` (§7).
//   · OUT OF CREDITS (§9). A debit overdrafts and reports the balance. The meter
//     records the transition below zero on the organisation's applications, and
//     clears it once the balance is zero or above; after 7 days still below zero,
//     an always-on application whose target can suspend is switched to suspend
//     when idle through the idle-policy path. Nothing here ever stops an app.
//   · STOP RULES (§8). A customer repository is never metered or charged; an
//     application with no live release is not sliced; an AWS application whose
//     organisation's tenant account is not `ready` (it has left Motir's
//     Organization) gets no new slice.
//
// `hosted_release.usage_seconds` and `settleReleaseUsage` are untouched: this
// meter keeps its own watermark, the slices.

const LOG = '[productionUsageMeter]';

export interface ProductionUsageAccrualResult {
  applications: number;
  slices: number;
  charged: number;
  skipped: number;
  failed: number;
  /** Always-on applications switched to suspend after 7 days below zero. */
  suspended: number;
}

export interface OutgoingReleaseAccrual {
  outcome: 'accrued' | 'skipped' | 'failed';
  slices: number;
}

type Meterable = HostedApplicationMeterTarget & {
  currentRelease: NonNullable<HostedApplicationMeterTarget['currentRelease']>;
};

function failureName(error: unknown): string {
  return error instanceof Error ? error.name : 'UNKNOWN';
}

/** Nothing of an error but its class and, for a motir-ai one, its own message. */
function describe(error: unknown): string {
  if (error instanceof MotirAiError) return `${error.name}: ${error.message}`.slice(0, 300);
  return failureName(error);
}

/** Why an application is not metered now, or null when it is. */
function stopReason(
  app: HostedApplicationMeterTarget,
): 'customer_repository' | 'no_live_release' | 'tenant_account_not_ready' | null {
  if (isOrganizationSeedSource(app.seedSource)) return 'customer_repository';
  if (app.target === 'aws' && app.tenantAccountState !== 'ready') {
    return 'tenant_account_not_ready';
  }
  const release = app.currentRelease;
  if (!release || release.state !== 'live' || !release.liveAt) return 'no_live_release';
  return null;
}

async function readApplication(
  applicationId: string,
): Promise<HostedApplicationMeterTarget | null> {
  return withSystemContext((tx) => hostedApplicationRepository.findMeterTarget(applicationId, tx));
}

function later(a: Date | null, b: Date): Date {
  return a && a.getTime() > b.getTime() ? a : b;
}

/**
 * Write one window's slices under the application's row lock. Nothing is
 * written when the watermark moved since it was read (another writer took the
 * window — `raced`), or when the window ends in a day already closed for its
 * charge (the next pass measures on into the open day).
 */
async function writeWindow(
  app: Meterable,
  input: {
    units: readonly ProductionUsageUnit[];
    expected: Date | null;
    window: { start: Date; end: Date };
    quantities: readonly UnitQuantity[];
  },
): Promise<{ count: number; raced: boolean }> {
  const { start, end } = input.window;
  const chargeDay = chargeDayOf(end);
  return withWorkspaceServiceContext(app.workspaceId, async (tx) => {
    await hostedApplicationRepository.lockForUpdate(app.id, tx);
    const now = await productionUsageSliceRepository.lastSliceEnd(app.id, input.units, tx);
    if ((now?.getTime() ?? null) !== (input.expected?.getTime() ?? null)) {
      return { count: 0, raced: true };
    }
    if (await productionUsageSliceRepository.isDayClosed(app.id, chargeDay, tx)) {
      return { count: 0, raced: false };
    }
    const slices: ProductionUsageSliceInput[] = input.quantities.map(({ unit, quantity }) => ({
      workspaceId: app.workspaceId,
      organizationId: app.organizationId,
      applicationId: app.id,
      releaseId: app.currentRelease.id,
      unit,
      quantity,
      ...priceProductionSlice(unit, quantity),
      periodStart: periodStartFor(new Date(end.getTime() - 1)),
      chargeDay,
      sliceStart: start,
      sliceEnd: end,
      idempotencyKey: sliceIdempotencyKey(app.id, unit, end),
    }));
    return {
      count: await productionUsageSliceRepository.insertSlices(slices, tx),
      raced: false,
    };
  });
}

/** One window of the live release's compute, from the application's last
 *  release slice (or the time the release went live). */
async function accrueRelease(app: Meterable): Promise<{ count: number; raced: boolean }> {
  const release = app.currentRelease;
  const port = getHostingDeployPort(app.target);
  const { appRef } = await port.ensureApp({
    repositoryId: app.projectRepositoryId,
    environment: { kind: 'production' },
  });
  const handle = releaseHandleFor(
    { target: app.target, appRef },
    { ...release, usageSettledUntil: null },
  );
  if (!handle) return { count: 0, raced: false };
  const recorded = await withWorkspaceServiceContext(app.workspaceId, (tx) =>
    productionUsageSliceRepository.lastSliceEnd(app.id, RELEASE_UNITS, tx),
  );
  const start = later(recorded, release.liveAt!);
  const usage: ReleaseUsage = await port.usageSince(handle, start);
  if (usage.until.getTime() <= start.getTime()) return { count: 0, raced: false };
  const quantities = releaseUnitQuantities(app.target, app.hostingSize, usage);
  if (quantities.length === 0) return { count: 0, raced: false };
  return writeWindow(app, {
    units: RELEASE_UNITS,
    expected: recorded,
    window: { start, end: usage.until },
    quantities,
  });
}

/** One window of the production database's compute and storage. Only Neon
 *  reports usage today; the AWS tenant database has no usage read yet. */
async function accrueDatabase(app: Meterable): Promise<number> {
  if (app.target === 'aws' || app.databaseProjectId === null) return 0;
  const port = getDatabasePort();
  const recorded = await withWorkspaceServiceContext(app.workspaceId, (tx) =>
    productionUsageSliceRepository.lastSliceEnd(app.id, DATABASE_UNITS, tx),
  );
  const start = later(recorded, app.currentRelease.liveAt!);
  const usage: DatabaseUsage = await port.usageSince(
    {
      provider: port.provider,
      applicationRef: app.projectRepositoryId,
      databaseRef: app.databaseProjectId,
    },
    start,
  );
  if (usage.until.getTime() <= start.getTime()) return 0;
  const window = { start, end: usage.until };
  const quantities = databaseUnitQuantities(usage, window);
  if (quantities.length === 0) return 0;
  const written = await writeWindow(app, {
    units: DATABASE_UNITS,
    expected: recorded,
    window,
    quantities,
  });
  return written.count;
}

/** Record the organisation's balance after a debit or a read on all of its
 *  applications: the transition below zero, or back to zero or above. */
async function recordBalance(organizationId: string, balance: number, at: Date): Promise<void> {
  const apps = await withSystemContext((tx) =>
    hostedApplicationRepository.listByOrganization(organizationId, tx),
  );
  const byWorkspace = new Map<string, string[]>();
  for (const a of apps)
    byWorkspace.set(a.workspaceId, [...(byWorkspace.get(a.workspaceId) ?? []), a.id]);
  for (const [workspaceId, ids] of byWorkspace) {
    await withWorkspaceServiceContext(workspaceId, (tx) =>
      hostedApplicationRepository.setCreditsExhaustedSince(ids, balance < 0 ? at : null, tx),
    );
  }
}

/** The motir-ai answers that mean "ask again later" rather than "refused":
 *  a transport failure, and a motir-ai that does not serve the route yet. */
function isRetryable(error: unknown): boolean {
  if (error instanceof MotirAiUnavailableError || !(error instanceof MotirAiError)) return true;
  if (error instanceof MotirAiJobNotFoundError) return true;
  return error instanceof MotirAiBadRequestError && error.httpStatus === 404;
}

/**
 * Charge every ended UTC day of the application that still holds slices: close
 * the day under the row lock, debit its credits rounded up once, record the
 * outcome. A transport failure leaves the day closed and owed. Returns how many
 * days were charged.
 */
async function chargeEndedDays(
  app: Pick<HostedApplicationMeterTarget, 'id' | 'workspaceId' | 'organizationId'>,
  now: Date,
  options: { includeToday?: boolean } = {},
): Promise<number> {
  const before = options.includeToday
    ? new Date(utcDayOf(now).getTime() + 24 * 3_600_000)
    : utcDayOf(now);
  const days = await withWorkspaceServiceContext(app.workspaceId, (tx) =>
    productionUsageSliceRepository.listOpenDays(app.id, before, tx),
  );
  let charged = 0;
  for (const day of days) {
    const credits = await withWorkspaceServiceContext(app.workspaceId, async (tx) => {
      await hostedApplicationRepository.lockForUpdate(app.id, tx);
      return productionUsageSliceRepository.startCharging(app.id, day, tx);
    });
    const finish = (result: Parameters<typeof productionUsageSliceRepository.finishCharging>[2]) =>
      withWorkspaceServiceContext(app.workspaceId, (tx) =>
        productionUsageSliceRepository.finishCharging(app.id, day, result, tx),
      );
    const whole = dailyChargeCredits(credits);
    if (whole === 0) {
      await finish({ state: 'charged', chargedAt: now, detail: 'nothing to charge' });
      continue;
    }
    try {
      const answer = await debitHostingProduction({
        coreOrganizationId: app.organizationId,
        applicationId: app.id,
        day: dayKey(day),
        credits: whole,
        linuxEquivalentMinutes: credits.reduce((s, c) => s + c, 0),
        reason: 'production hosting',
      });
      await finish({ state: 'charged', chargedAt: now, detail: null });
      charged += 1;
      await recordBalance(app.organizationId, answer.balanceAfter, now);
    } catch (error) {
      if (error instanceof MotirAiConfigError) {
        await finish({ state: 'not_charged', detail: 'motir-ai is not configured' });
      } else if (isRetryable(error)) {
        // Still `charging`: the day stays closed, and the next pass asks again
        // with the same application and day.
        await finish({ state: 'charging', detail: describe(error) });
        console.warn(`${LOG} a day's charge is owed — retried next pass`, {
          applicationId: app.id,
          day: dayKey(day),
          error: failureName(error),
        });
      } else {
        await finish({ state: 'refused', detail: describe(error) });
        console.error(`${LOG} motir-ai refused a day's charge`, {
          applicationId: app.id,
          day: dayKey(day),
          error: failureName(error),
        });
      }
    }
  }
  return charged;
}

/** Slice one application and charge its ended days. */
async function meterApplication(
  applicationId: string,
  now: Date,
): Promise<{ app: HostedApplicationMeterTarget | null; slices: number; charged: number }> {
  const app = await readApplication(applicationId);
  if (!app || isOrganizationSeedSource(app.seedSource)) return { app: null, slices: 0, charged: 0 };
  let slices = 0;
  if (stopReason(app) === null) {
    const meterable = app as Meterable;
    slices += (await accrueRelease(meterable)).count;
    slices += await accrueDatabase(meterable);
  }
  // Days already sliced are charged even once accrual has stopped: Motir paid
  // for that usage.
  const charged = await chargeEndedDays(app, now);
  return { app, slices, charged };
}

/** Refresh one organisation's below-zero state from a live balance read, then
 *  switch its always-on applications 7 days below zero to suspend when idle. */
async function enforceCredits(
  organizationId: string,
  apps: readonly HostedApplicationMeterTarget[],
  now: Date,
): Promise<number> {
  const balance = await productionCreditBalanceService.readOrganizationBalance(organizationId);
  if (balance === null) return 0;
  await recordBalance(organizationId, balance, now);
  if (balance >= 0) return 0;
  let switched = 0;
  for (const listed of apps) {
    const app = await readApplication(listed.id);
    if (
      !app?.creditsExhaustedSince ||
      app.idleMode !== 'always_on' ||
      !productionCreditBalanceService.canSuspend(app) ||
      now.getTime() - app.creditsExhaustedSince.getTime() < EXHAUSTED_SUSPEND_AFTER_MS
    ) {
      continue;
    }
    try {
      const outcome = await hostedIdlePolicyService.applyIdlePolicyAsSystem(
        app.projectRepositoryId,
        { mode: 'suspend', idleSeconds: HOSTED_IDLE_SECONDS_DEFAULT },
      );
      if (outcome === 'applied') switched += 1;
    } catch (error) {
      console.warn(`${LOG} could not switch an always-on app to suspend`, {
        applicationId: app.id,
        error: failureName(error),
      });
    }
  }
  return switched;
}

/**
 * The hourly pass: slice every metered application, charge its ended days, then
 * refresh each organisation's below-zero state and apply the 7-day switch. One
 * application's failure is counted and logged, and the pass moves on.
 */
async function accrue(options: { now?: () => Date } = {}): Promise<ProductionUsageAccrualResult> {
  const clock = options.now ?? (() => new Date());
  const result: ProductionUsageAccrualResult = {
    applications: 0,
    slices: 0,
    charged: 0,
    skipped: 0,
    failed: 0,
    suspended: 0,
  };
  const ids = await withSystemContext((tx) => hostedApplicationRepository.listMeteredIds(tx));
  const byOrganization = new Map<string, HostedApplicationMeterTarget[]>();
  for (const id of ids) {
    result.applications += 1;
    try {
      const metered = await meterApplication(id, clock());
      if (!metered.app) {
        result.skipped += 1;
        continue;
      }
      result.slices += metered.slices;
      result.charged += metered.charged;
      const list = byOrganization.get(metered.app.organizationId) ?? [];
      list.push(metered.app);
      byOrganization.set(metered.app.organizationId, list);
    } catch (error) {
      result.failed += 1;
      console.warn(`${LOG} accrual failed for an application`, {
        applicationId: id,
        error: failureName(error),
      });
    }
  }
  for (const [organizationId, apps] of byOrganization) {
    try {
      result.suspended += await enforceCredits(organizationId, apps, clock());
    } catch (error) {
      result.failed += 1;
      console.warn(`${LOG} could not refresh an organisation's credit state`, {
        organizationId,
        error: failureName(error),
      });
    }
  }
  return result;
}

/**
 * The final slice of a release about to be replaced, rolled back or removed:
 * its window since the application's last slice. Called by the release paths
 * next to `settleReleaseUsage`, while the release is still the one serving. A
 * window another writer took meanwhile is measured once more from where it now
 * ends. With `chargeNow` (the repository is being removed, and its slices go
 * with it), every open day is charged at once, today's included. NEVER THROWS
 * and never delays the release beyond its port calls.
 */
async function accrueOutgoingRelease(
  releaseId: string,
  options: { chargeNow?: boolean; now?: () => Date } = {},
): Promise<OutgoingReleaseAccrual> {
  const clock = options.now ?? (() => new Date());
  try {
    const applicationId = await withSystemContext((tx) =>
      hostedReleaseRepository.findApplicationId(releaseId, tx),
    );
    if (!applicationId) return { outcome: 'skipped', slices: 0 };
    let slices = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const app = await readApplication(applicationId);
      if (!app || stopReason(app) !== null || app.currentRelease?.id !== releaseId) break;
      const written = await accrueRelease(app as Meterable);
      slices += written.count;
      if (!written.raced) break;
    }
    if (options.chargeNow) {
      const app = await readApplication(applicationId);
      if (app && !isOrganizationSeedSource(app.seedSource)) {
        await chargeEndedDays(app, clock(), { includeToday: true });
      }
    }
    return { outcome: slices > 0 ? 'accrued' : 'skipped', slices };
  } catch (error) {
    console.warn(`${LOG} could not accrue an outgoing release`, {
      releaseId,
      error: failureName(error),
    });
    return { outcome: 'failed', slices: 0 };
  }
}

export const productionUsageMeterService = {
  accrue,
  accrueOutgoingRelease,
  chargeEndedDays,
  meterApplication,
};

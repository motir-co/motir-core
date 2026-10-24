import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { CI_DEBIT_PERIOD_MINUTES } from '@/lib/ciMetering/allowance';
import { periodStartFor } from '@/lib/ciMetering/period';
import { adminDb } from './db-reset';
import { E2E_PROVISIONING_ORG } from './github-const';

/**
 * The FLEET MONITOR's seeded estate (Story MOTIR-6905 · MOTIR-7322) — shared by
 * the story's acceptance walk (`regression-fleet-monitor.spec.ts`) and its
 * cloud-lane regression twin (`cloud-admin-fleet.spec.ts`).
 *
 * Everything here is a ROW, written straight to the database the lane's server
 * reads, because nothing in the fleet monitor is a write a browser could make:
 * a CI container is booted by a GitHub `workflow_job` delivery, a kill is
 * written by the attribution reconciler, an accrual by the live-charge tick.
 *
 * ⚠️ THE TWO PROVIDERS, AND THE SEAM EACH GOES THROUGH.
 *
 *  - THE ORCHESTRATOR is the acceptance lane's configured fake
 *    (`MOTIR_FLEET_ORCHESTRATOR=fake` in `playwright.acceptance.config.ts`, on the
 *    runner, the webServer and the relay). ⚠️ The CLOUD lane does NOT select it,
 *    which is why the STOP is walked only in the acceptance spec: the cloud twin
 *    reads the card and never presses Stop, and a read needs no orchestrator.
 *    A container here is an intent naming a `fake` handle; the stop's teardown goes
 *    through `getOrchestrator()` → `fakeOrchestrator.teardown`, which is idempotent
 *    and answers for a handle its store never booted. No machine is put in the
 *    fake's shared store ON PURPOSE: the lane's job worker runs the attribution
 *    reconciler every five minutes over that store, and a machine there is one it
 *    may judge — the walk must not race a reconciler pass.
 *  - GITHUB is never reached, by construction rather than by a stub: the stop and
 *    its preview cancel/count workflow runs only on the org's MOTIR-CREATED
 *    repositories (`fleetStopService.listHostedRepos`), and these orgs have none.
 *    The preview therefore reads `0` runs and makes no call; a call nobody
 *    expected would hit the lanes' shared mock agent, which refuses any
 *    `api.github.com` request no seam answers.
 *  - motir-ai's BALANCE (the zero stop's read, which the monitor makes for a
 *    container older than one debit period) is the lanes' billing mock
 *    (`E2E_TEST_BILLING`); the caller writes each org a paid state with
 *    `setOrgBillingState` so the read answers and no `balance_unknown` chip shows.
 */

const MIN = 60_000;

/** The monitor's verdict window — two debit periods, read from the meter. */
export const FLEET_WINDOW_MS = 2 * CI_DEBIT_PERIOD_MINUTES * MIN;

let seq = 0;

/**
 * Clear the fleet rows `resetDatabase()` never reaches. An in-flight slot and a
 * reconciler kill carry no foreign key to an org, so an earlier spec's hosted
 * agent leaves its slot behind, and the monitor would count it as one more org
 * running.
 */
export async function clearFleetRows(): Promise<void> {
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetMachineKill.deleteMany({});
}

export interface TenantOrg {
  organizationId: string;
  workspaceId: string;
  name: string;
}

/** A tenant organisation and its workspace — no people, nothing in it. */
export async function seedTenantOrg(name: string, slug: string): Promise<TenantOrg> {
  const org = await adminDb.organization.create({ data: { name, slug } });
  const workspace = await adminDb.workspace.create({
    data: { name, slug: `${slug}-ws`, organizationId: org.id },
  });
  return { organizationId: org.id, workspaceId: workspace.id, name };
}

/**
 * `count` CI containers RUNNING a job since `startedAt` — an in-flight intent on
 * a `fake` handle. Answers the intent ids.
 */
export async function seedRunningCi(
  org: TenantOrg,
  count: number,
  startedAt: Date,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    seq += 1;
    const intent = await adminDb.ciRunnerProvisioningIntent.create({
      data: {
        workspaceId: org.workspaceId,
        organizationId: org.organizationId,
        installationId: '556677',
        runId: `e2e-fleet-run-${seq}`,
        runAttempt: 1,
        jobId: String(91_000 + seq),
        jobName: 'build',
        workflowName: 'CI',
        repoOwner: E2E_PROVISIONING_ORG,
        repoName: 'fleet-e2e',
        requestedLabels: [MOTIR_RUNNER_LABEL],
        queuedAt: new Date(startedAt.getTime() - 30_000),
        status: 'running',
        startedAt,
        containerProvider: 'fake',
        containerId: `fake-e2e-fleet-${seq}`,
        containerRegion: 'iad',
        bootedAt: new Date(startedAt.getTime() - 10_000),
      },
    });
    ids.push(intent.id);
  }
  return ids;
}

/**
 * The debit job's LAST tick for each of an org's running containers, `tickAgoMs`
 * ago. Inside the verdict window it is a healthy org's accrual; outside it (older
 * than two periods) it is the "debit job is not reaching the org" half of
 * `running_not_debited`.
 *
 * ⚠️ `accruedSeconds` IS DELIBERATELY AHEAD OF THE CONTAINER'S AGE. The lane's job
 * worker runs the shipped live-charge tick (`system.ci-live-charge`) every five
 * minutes, with the CI meter ON (it inherits `GITHUB_FALLBACK_ORG` with the merge
 * seam). A tick landing mid-walk would accrue this org's minutes INSIDE the window
 * and turn the mismatch the walk is about to film back into `ok`. A tick adds only
 * `wholeMinutesSinceStart − alreadyAccrued` (`ciLiveChargeService.accrueContainer`),
 * so pre-accruing beyond the container's age makes every tick during the spec a
 * no-op for this org (the mismatched org's case; a healthy org may take a tick). The figure is invisible on both surfaces: the monitor shows
 * minutes INSIDE the window (none) and the age of the last tick, nothing else.
 */
export async function seedAccrual(
  org: TenantOrg,
  intentIds: string[],
  tickAgoMs: number,
  accruedSeconds: number,
): Promise<void> {
  const now = new Date();
  const tickStart = new Date(now.getTime() - tickAgoMs);
  for (const intentId of intentIds) {
    const intent = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intentId },
    });
    await adminDb.ciLiveAccrual.create({
      data: {
        provisioningIntentId: intentId,
        organizationId: org.organizationId,
        workspaceId: org.workspaceId,
        runId: intent.runId,
        runAttempt: intent.runAttempt,
        tickStart,
        periodStart: periodStartFor(now),
        accruedSeconds,
      },
    });
  }
}

/** One row of the attribution reconciler's kill record. */
export async function seedKill(input: {
  machineId: string;
  reason: 'no_record' | 'record_ended' | 'org_stopped';
  organizationId?: string | null;
  decidedAgoMs: number;
  ageSeconds: number;
}): Promise<string> {
  const decidedAt = new Date(Date.now() - input.decidedAgoMs);
  const kill = await adminDb.fleetMachineKill.create({
    data: {
      app: 'motir-fleet-e2e',
      machineId: input.machineId,
      machineName: `ci-runner-${input.machineId}`,
      reason: input.reason,
      action: 'destroyed',
      workload: 'ci_runner',
      organizationId: input.organizationId ?? null,
      ageSeconds: input.ageSeconds,
      decidedAt,
      completedAt: new Date(decidedAt.getTime() + 2_000),
    },
  });
  return kill.id;
}

/** The org's CI intents still in flight — the authoritative "is it still running". */
export function inFlightCi(organizationId: string): Promise<number> {
  return adminDb.ciRunnerProvisioningIntent.count({
    where: { organizationId, status: { in: ['provisioning', 'running'] } },
  });
}

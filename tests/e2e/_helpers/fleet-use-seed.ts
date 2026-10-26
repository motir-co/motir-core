import { renameSync, writeFileSync } from 'node:fs';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import type { FleetSwitchFixture } from '@/lib/test-fake-aws';
import { adminDb } from './db-reset';
import { E2E_PROVISIONING_ORG } from './github-const';

/**
 * THE FLEET USE SECTION's seeded fleet (Story MOTIR-9368 · MOTIR-9665), for the
 * story's acceptance walk (`acceptance-billing-fleet-use.spec.ts`).
 *
 * Everything is a ROW, in the shape the writer that owns it leaves it, because
 * the lane boots no container and runs no admission a browser could start:
 *  - a hosted run in flight is a `hosted` dispatch run holding the
 *    `hosted_agent` slot `hostedRunService` reserves (`hostedRunDispatchId`);
 *  - a hosted run waiting is one with no slot whose latest `log` event is the
 *    waiting line `{ waiting, reason }` `recordWaitingLine` writes;
 *  - a CI job is a provisioning intent, `running` in flight, `pending` with the
 *    `waiting_reason` the CI gate records;
 *  - a Host org's own account is its `org_owned` shard rows (one per kind, two
 *    for the merged account) with their state times, and the AWS quota raise on
 *    its first row, as `fleet-admin add-shard` and the raise service write them.
 * The shapes mirror `tests/integration/fleetUse/fleetUseStoryGate.test.ts` and
 * `fleet-pools-seed.ts`, which write the same tables.
 *
 * ⚠️ THE LANE'S PASSES ARE HELD OFF FOR THE WALK. The job worker runs the CI
 * provisioning sweep (every five minutes, re-judging every pending intent), the
 * Host account state pass and reconcile (every minute, over every org-owned
 * account) and the pool growth pass. Each would rewrite these rows mid-walk, so
 * {@link holdFleetPasses} takes the three passes' single-flight leases and the
 * spec holds the sweep's cron with `holdScheduledJob`.
 */

const MIN = 60_000;
const WALK_LEASE_HOLDER = 'e2e-fleet-use-walk';
/** The single-flight leases of the growth pass and the two Host account passes. */
const PASS_LEASE_IDS = ['fleet-pool-growth-pass', 'host-account-state', 'host-account-reconcile'];

let seq = 0;

/** Take the three passes' leases for `ms`, whoever held them. */
export async function holdFleetPasses(ms = 15 * MIN): Promise<void> {
  const now = new Date();
  const heldUntil = new Date(now.getTime() + ms);
  for (const id of PASS_LEASE_IDS) {
    await adminDb.fleetGrowthPassLease.upsert({
      where: { id },
      create: { id, holder: WALK_LEASE_HOLDER, heldUntil, updatedAt: now },
      update: { holder: WALK_LEASE_HOLDER, heldUntil, updatedAt: now },
    });
  }
}

/** Give the leases back, only those the walk still holds. */
export async function releaseFleetPasses(): Promise<void> {
  await adminDb.fleetGrowthPassLease.deleteMany({
    where: { id: { in: PASS_LEASE_IDS }, holder: WALK_LEASE_HOLDER },
  });
}

/**
 * Clear the fleet rows `resetDatabase()` leaves: slots and own accounts hang off
 * no workspace. Capacity requests and quota requests before the shards they
 * name; intents and runs go with their workspace.
 */
export async function clearFleetUseRows(): Promise<void> {
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetCapacityRequest.deleteMany({});
  await adminDb.fleetQuotaRequest.deleteMany({ where: { shard: { role: 'org_owned' } } });
  await adminDb.ciRunnerProvisioningIntent.deleteMany({
    where: { fleetShard: { role: 'org_owned' } },
  });
  await adminDb.fleetShard.deleteMany({ where: { role: 'org_owned' } });
}

/**
 * The lane's Fly↔AWS switch fixture, read by the server on every job
 * (`lib/test-fake-aws.ts`). Only the agent runner and the CI runner read it;
 * the agent hoster reads its stored setting and the indexer its env var.
 */
export function writeFleetSwitches(switches: FleetSwitchFixture): void {
  const path = process.env['MOTIR_FAKE_FLEET_SWITCH_PATH'];
  if (!path)
    throw new Error('MOTIR_FAKE_FLEET_SWITCH_PATH is not set — is this the acceptance lane?');
  const sibling = `${path}.${process.pid}.tmp`;
  writeFileSync(sibling, JSON.stringify(switches));
  renameSync(sibling, path);
}

export interface FleetOrg {
  organizationId: string;
  workspaceId: string;
  projectId: string;
  ownerId: string;
}

/** One `hosted` run in flight: the run and the slot admission reserved for it. */
export async function seedRunningHostedRun(org: FleetOrg): Promise<string> {
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: org.workspaceId,
      projectId: org.projectId,
      command: 'run',
      origin: 'hosted',
      status: 'running',
      createdById: org.ownerId,
    },
  });
  await adminDb.fleetInFlightSlot.create({
    data: {
      workload: 'hosted_agent',
      ref: hostedRunDispatchId(run.id),
      organizationId: org.organizationId,
      workspaceId: org.workspaceId,
      containerProvider: 'fake',
      containerId: `fake-e2e-fleet-use-${run.id}`,
      expiresAt: new Date(Date.now() + 60 * MIN),
    },
  });
  return run.id;
}

/** One `hosted` run held: no slot, and the waiting line admission wrote. */
export async function seedWaitingHostedRun(
  org: FleetOrg,
  reason: 'plan_cap' | 'shard_capacity',
): Promise<string> {
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: org.workspaceId,
      projectId: org.projectId,
      command: 'run',
      origin: 'hosted',
      status: 'running',
      createdById: org.ownerId,
    },
  });
  const detail = 'every hosted run your plan allows is already running';
  await adminDb.dispatchRunEvent.create({
    data: {
      workspaceId: org.workspaceId,
      dispatchRunId: run.id,
      seq: 1,
      kind: 'log',
      data: { waiting: detail, reason },
      body: `[motir] waiting for room: ${detail}\n`,
    },
  });
  return run.id;
}

/** `count` CI jobs of the org: `running`, or `pending` at `waitingReason`. */
export async function seedCiJobs(
  org: FleetOrg,
  count: number,
  state: { status: 'running' } | { status: 'pending'; waitingReason: string },
): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < count; i += 1) {
    seq += 1;
    const running = state.status === 'running';
    await adminDb.ciRunnerProvisioningIntent.create({
      data: {
        workspaceId: org.workspaceId,
        organizationId: org.organizationId,
        projectId: org.projectId,
        installationId: '556677',
        runId: `e2e-fleet-use-run-${seq}`,
        runAttempt: 1,
        jobId: String(96_650_000 + seq),
        jobName: 'build',
        workflowName: 'CI',
        repoOwner: E2E_PROVISIONING_ORG,
        repoName: 'fleet-use-e2e',
        requestedLabels: [MOTIR_RUNNER_LABEL],
        queuedAt: new Date(now - 2 * MIN),
        status: state.status,
        ...(running
          ? {
              startedAt: new Date(now - MIN),
              containerProvider: 'fake',
              containerId: `fake-e2e-fleet-use-${seq}`,
              containerRegion: 'iad',
              bootedAt: new Date(now - 70_000),
            }
          : { waitingReason: state.waitingReason, waitingSince: new Date(now - MIN) }),
      },
    });
  }
}

export interface OwnAccount {
  awsAccountId: string;
  shardIds: string[];
  quotaRequestId: string;
}

/**
 * One own AWS account of a Host org, right after purchase: a row per kind it
 * serves, `quotaRequestedAt` set, and the AWS raise pending for `desiredVcpu`.
 */
export async function seedOwnAccount(input: {
  organizationId: string;
  kinds: string[];
  desiredVcpu: number;
  requestedAt: Date;
}): Promise<OwnAccount> {
  seq += 1;
  const awsAccountId = String(440_000_000_000 + seq);
  const shardIds: string[] = [];
  for (const fleetKind of input.kinds) {
    const slug = `${fleetKind.replace(/_/g, '-')}-${seq}`;
    const row = await adminDb.fleetShard.create({
      data: {
        name: `host-e2e-${slug}`,
        fleetKind,
        provider: 'aws',
        role: 'org_owned',
        ownerOrganizationId: input.organizationId,
        state: 'provisioning',
        githubOrg: E2E_PROVISIONING_ORG,
        githubInstallationId: '556677',
        awsAccountId,
        awsRegion: 'us-east-1',
        credentialRef: `AWS_E2E_HOST_${seq}_${fleetKind.toUpperCase()}`,
        createdAt: new Date(input.requestedAt.getTime() - MIN),
        quotaRequestedAt: input.requestedAt,
      },
    });
    shardIds.push(row.id);
  }
  const request = await adminDb.fleetQuotaRequest.create({
    data: {
      shardId: shardIds[0]!,
      fleetKind: input.kinds[0]!,
      quotaCode: 'L-1216C47A',
      desiredValue: input.desiredVcpu,
      awsRequestId: `e2e-fleet-use-req-${seq}`,
      status: 'pending',
      grantedValue: null,
      createdAt: input.requestedAt,
      lastReadAt: input.requestedAt,
    },
  });
  return { awsAccountId, shardIds, quotaRequestId: request.id };
}

/** AWS granted the raise and the network is built: the account is live. */
export async function grantAndGoLive(
  account: OwnAccount,
  grantedVcpu: number,
  at: Date,
): Promise<void> {
  await adminDb.fleetQuotaRequest.update({
    where: { id: account.quotaRequestId },
    data: { status: 'approved', grantedValue: grantedVcpu, closedAt: at, lastReadAt: at },
  });
  await adminDb.fleetShard.updateMany({
    where: { id: { in: account.shardIds } },
    data: { state: 'active', grantedAt: at, liveAt: at, vcpuQuota: grantedVcpu },
  });
}

/** AWS refused the raise: the account stays where it was. */
export async function denyRaise(account: OwnAccount, at: Date): Promise<void> {
  await adminDb.fleetQuotaRequest.update({
    where: { id: account.quotaRequestId },
    data: { status: 'denied', closedAt: at, lastReadAt: at },
  });
}

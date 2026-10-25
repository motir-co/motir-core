import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { adminDb } from './db-reset';
import { E2E_PROVISIONING_ORG } from './github-const';
import type { TenantOrg } from './fleet-monitor-seed';

/**
 * THE POOLS SECTION's seeded estate (Story MOTIR-9367 · MOTIR-9565), for the
 * story's acceptance walk (`acceptance-admin-fleet-pools.spec.ts`).
 *
 * Everything is a ROW, as in `fleet-monitor-seed.ts`: an AWS account is added by
 * `fleet-admin add-shard`, its granted quota is written by the growth pass's
 * live read, a quota request by the raise service, a growth event by the pass,
 * and use is measured from CI intents. None of that is a browser action, and
 * none of it may call AWS here, so the walk writes the records the pass would
 * have written and the page reads them.
 *
 * ⚠️ THE GROWTH PASS IS HELD OFF FOR THE WALK. The lane's job worker runs the
 * pool growth pass every minute, and with the CI runner switched to AWS it would
 * act on these rows: re-read every quota, refresh the open requests and grow the
 * account past 70%. `holdGrowthPass` takes the pass's single-flight lease (the
 * row `withPassLease` takes) for the length of the walk, so every pass the
 * worker starts answers "another run holds it" and touches nothing;
 * `releaseGrowthPass` gives it back.
 */

/** The prefix every account this walk adds carries. */
export const POOL_ACCOUNT_PREFIX = 'ci-use1-';

/** `fleetPoolGrowthPassService`'s lease id — the one row a pass must take. */
const GROWTH_PASS_LEASE_ID = 'fleet-pool-growth-pass';
const WALK_LEASE_HOLDER = 'e2e-pools-walk';

const MIN = 60_000;
let seq = 0;

/** Take the growth pass's lease for `ms`, whoever held it. */
export async function holdGrowthPass(ms = 15 * MIN): Promise<void> {
  const now = new Date();
  const heldUntil = new Date(now.getTime() + ms);
  await adminDb.fleetGrowthPassLease.upsert({
    where: { id: GROWTH_PASS_LEASE_ID },
    create: { id: GROWTH_PASS_LEASE_ID, holder: WALK_LEASE_HOLDER, heldUntil, updatedAt: now },
    update: { holder: WALK_LEASE_HOLDER, heldUntil, updatedAt: now },
  });
}

/** Give the lease back, only if the walk still holds it. */
export async function releaseGrowthPass(): Promise<void> {
  await adminDb.fleetGrowthPassLease.deleteMany({
    where: { id: GROWTH_PASS_LEASE_ID, holder: WALK_LEASE_HOLDER },
  });
}

/**
 * Clear every CI runner AWS account, request and growth event. The lane has no
 * real CI pool, and `resetDatabase()` reaches none of these: no row here hangs
 * off a workspace. Growth events first, since their shard links only null out.
 */
export async function clearPoolRows(): Promise<void> {
  await adminDb.fleetGrowthEvent.deleteMany({ where: { fleetKind: 'ci_runner' } });
  await adminDb.fleetQuotaRequest.deleteMany({ where: { fleetKind: 'ci_runner' } });
  await adminDb.fleetShard.deleteMany({ where: { fleetKind: 'ci_runner', provider: 'aws' } });
}

/**
 * One CI runner AWS account. `granted` is its granted vCPU quota as the live
 * read last wrote it (with a read time), or null for one never read.
 */
export async function seedPoolAccount(input: {
  name: string;
  granted: number | null;
  role?: 'primary' | 'spare';
  state?: 'active' | 'provisioning';
}): Promise<FleetShardDTO> {
  seq += 1;
  return fleetShardService.createShard({
    name: `${POOL_ACCOUNT_PREFIX}${input.name}`,
    fleetKind: 'ci_runner',
    provider: 'aws',
    role: input.role ?? 'primary',
    state: input.state ?? 'active',
    githubOrg: E2E_PROVISIONING_ORG,
    githubInstallationId: '556677',
    awsAccountId: String(330_000_000_000 + seq),
    awsRegion: 'us-east-1',
    credentialRef: `AWS_E2E_POOL_${seq}`,
    limits: input.granted === null ? {} : { vcpuQuota: input.granted },
    limitsSource: input.granted === null ? {} : { vcpuQuota: 'provider_read' },
  });
}

/**
 * An account whose quota read FAILED after an earlier success: the stored value
 * is gone, the time of the last good read stays — what the live read leaves.
 */
export async function failQuotaRead(shardId: string, lastGood: Date): Promise<void> {
  await adminDb.fleetShard.update({
    where: { id: shardId },
    data: {
      vcpuQuota: null,
      limitsSource: { vcpuQuota: 'provider_read' },
      limitsVerifiedAt: lastGood,
    },
  });
}

/**
 * `count` CI jobs of `org` RUNNING on the account now — the intents the headroom
 * pass takes the account's peak use from (one container's vCPU each).
 */
export async function seedRunningJobs(
  org: TenantOrg,
  shardId: string,
  count: number,
): Promise<void> {
  const startedAt = new Date(Date.now() - 2 * MIN);
  for (let i = 0; i < count; i += 1) {
    seq += 1;
    await adminDb.ciRunnerProvisioningIntent.create({
      data: {
        workspaceId: org.workspaceId,
        organizationId: org.organizationId,
        installationId: '556677',
        runId: `e2e-pools-run-${seq}`,
        runAttempt: 1,
        jobId: String(93_000 + seq),
        jobName: 'build',
        workflowName: 'CI',
        repoOwner: E2E_PROVISIONING_ORG,
        repoName: 'pools-e2e',
        requestedLabels: [MOTIR_RUNNER_LABEL],
        queuedAt: new Date(startedAt.getTime() - 30_000),
        status: 'running',
        startedAt,
        containerProvider: 'fake',
        containerId: `fake-e2e-pools-${seq}`,
        containerRegion: 'iad',
        bootedAt: new Date(startedAt.getTime() - 10_000),
        fleetShardId: shardId,
      },
    });
  }
}

/** One quota raise asked of AWS, as the raise service records it. */
export async function seedQuotaRequest(input: {
  shardId: string;
  status: 'pending' | 'case_opened' | 'approved' | 'denied';
  desired: number;
  askedAgoMs: number;
  closedAgoMs?: number;
}): Promise<void> {
  seq += 1;
  const now = Date.now();
  await adminDb.fleetQuotaRequest.create({
    data: {
      shardId: input.shardId,
      fleetKind: 'ci_runner',
      quotaCode: 'L-1216C47A',
      desiredValue: input.desired,
      awsRequestId: `e2e-pools-req-${seq}`,
      status: input.status,
      grantedValue: null,
      createdAt: new Date(now - input.askedAgoMs),
      lastReadAt: new Date(now - MIN),
      closedAt: input.closedAgoMs === undefined ? null : new Date(now - input.closedAgoMs),
    },
  });
}

/** One growth event, as the pass records a 70% crossing. */
export async function seedGrowthEvent(input: {
  triggeringShardId: string;
  vcpuInUse: number;
  grantedQuota: number;
  outcome: 'spare_promoted' | 'account_created' | 'waiting_for_quota' | 'refused';
  spareShardId?: string;
  reason?: string;
  agoMs: number;
}): Promise<void> {
  await adminDb.fleetGrowthEvent.create({
    data: {
      fleetKind: 'ci_runner',
      triggeringShardId: input.triggeringShardId,
      vcpuInUse: input.vcpuInUse,
      grantedQuota: input.grantedQuota,
      outcome: input.outcome,
      spareShardId: input.spareShardId ?? null,
      reason: input.reason ?? null,
      createdAt: new Date(Date.now() - input.agoMs),
    },
  });
}

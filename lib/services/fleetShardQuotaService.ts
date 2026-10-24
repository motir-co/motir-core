import {
  AwsManagementApiError,
  awsManagementCredentials,
  createAwsManagementApi,
  type AwsManagementApi,
  type FleetWorkloadKind,
} from '@motir/orchestrator';
import type { FleetShard } from '@/generated/prisma/client';
import { LiveQuotaReadFailedError } from '@/lib/ciFleet/errors';
import { fleetKindOnPool } from '@/lib/ciFleet/shardTargets';
import { FLEET_WORKLOAD_KINDS } from '@/lib/ciFleet/workloads';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE LIVE GRANTED vCPU QUOTA (Story MOTIR-9362 · MOTIR-9458). Add-shard reads an
// account's `L-1216C47A` once, at creation; a raise AWS grants later never
// reached the row, so the 70% reading compared use against a stale number. This
// re-reads it on every growth pass for every SHARED (`primary`), `active` AWS
// account of the kinds switched to their pool, and writes it only when AWS's
// answer differs from the row.
//
// ⚠️ A read that fails is a typed failure, never a fallback: the stored value and
// no default stand in for what AWS says, so growth can neither trigger nor be
// suppressed on a guess. The member session lives in memory for the read only.
// No schedule of its own — the per-pass job (MOTIR-9462) calls it first.

/** How many accounts are read at once. */
const READ_CONCURRENCY = 8;

export type LiveQuotaReading =
  | { shardId: string; fleetKind: FleetWorkloadKind; granted: number; changed: boolean }
  | { shardId: string; fleetKind: FleetWorkloadKind; failure: LiveQuotaReadFailedError };

export interface FleetShardQuotaDeps {
  /** The management API, from this deployment's management credential. */
  management(): AwsManagementApi;
  /** Is the kind switched to its AWS pool? */
  onPool(kind: FleetWorkloadKind): Promise<boolean>;
  now(): Date;
}

const defaultDeps: FleetShardQuotaDeps = {
  management: () => createAwsManagementApi(awsManagementCredentials(process.env)),
  onPool: fleetKindOnPool,
  now: () => new Date(),
};

/** AWS's error code, or the error's class name — never a free-text message,
 *  which could quote what a call was given. */
function reasonOf(err: unknown): string {
  if (err instanceof AwsManagementApiError) return err.awsCode;
  if (err instanceof Error) return err.name;
  return 'UnknownError';
}

async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>) {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(run))));
  }
  return out;
}

/** Write AWS's answer only when it differs, keeping the other three limits and
 *  their sources. Re-read in the write's transaction, so a concurrent change of
 *  another limit is not overwritten. */
async function writeIfChanged(shardId: string, granted: number, at: Date): Promise<boolean> {
  return withSystemContext(async (tx) => {
    const row = await fleetShardRepository.findById(shardId, tx);
    if (!row || row.vcpuQuota === granted) return false;
    const source =
      row.limitsSource && typeof row.limitsSource === 'object' && !Array.isArray(row.limitsSource)
        ? (row.limitsSource as Record<string, unknown>)
        : {};
    await fleetShardRepository.updateLimits(
      shardId,
      {
        vcpuQuota: granted,
        machineLimit: row.machineLimit,
        githubRegistrationsPer5Min: row.githubRegistrationsPer5Min,
        githubApiPerHour: row.githubApiPerHour,
      },
      { ...source, vcpuQuota: 'provider_read' },
      at,
      tx,
    );
    return true;
  });
}

export const fleetShardQuotaService = {
  /**
   * Read the live granted `L-1216C47A` of every shared, active AWS account of
   * `kind` (or of every kind) switched to its pool, and write each to its row
   * only when it changed. One reading per account; one account's failure never
   * stops the others.
   */
  async refreshLiveGrantedQuotas(
    kind?: FleetWorkloadKind,
    deps: FleetShardQuotaDeps = defaultDeps,
  ): Promise<LiveQuotaReading[]> {
    const kinds: FleetWorkloadKind[] = [];
    for (const candidate of kind ? [kind] : FLEET_WORKLOAD_KINDS) {
      if (await deps.onPool(candidate)) kinds.push(candidate);
    }
    if (kinds.length === 0) return [];

    const shards: FleetShard[] = [];
    for (const fleetKind of kinds) {
      shards.push(
        ...(await withSystemContext((tx) =>
          fleetShardRepository.listByRole(
            'primary',
            { fleetKind, state: 'active', provider: 'aws' },
            tx,
          ),
        )),
      );
    }
    if (shards.length === 0) return [];

    let management: AwsManagementApi | null = null;
    let managementFailure: unknown = null;
    try {
      management = deps.management();
    } catch (err) {
      managementFailure = err;
    }

    return inBatches(shards, READ_CONCURRENCY, async (shard): Promise<LiveQuotaReading> => {
      const fleetKind = shard.fleetKind as FleetWorkloadKind;
      const fail = (reason: string): LiveQuotaReading => ({
        shardId: shard.id,
        fleetKind,
        failure: new LiveQuotaReadFailedError(shard.id, shard.name, reason),
      });
      if (!management) return fail(reasonOf(managementFailure));
      // The row's CHECK requires both on an aws account; kept total regardless.
      if (!shard.awsAccountId || !shard.awsRegion) return fail('MissingAwsLocation');
      let granted: number;
      try {
        const session = await management.assumeMemberRole(shard.awsAccountId);
        granted = await management.readVcpuQuota(session, shard.awsRegion);
      } catch (err) {
        return fail(reasonOf(err));
      }
      const changed = await writeIfChanged(shard.id, granted, deps.now());
      return { shardId: shard.id, fleetKind, granted, changed };
    });
  },
};

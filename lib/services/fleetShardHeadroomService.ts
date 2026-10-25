import type { FleetShard, FleetShardMoveReason, Prisma } from '@/generated/prisma/client';
import { FLEET_CONTAINER_SIZE } from '@motir/orchestrator';
import { withSystemContext } from '@/lib/workspaces/context';
import { provisioningOrgLogin } from '@/lib/ciMetering/config';
import { isMotirHostedOwner } from '@/lib/git/hostOwnership';
import {
  GITHUB_SECONDARY_LIMITS,
  HEADROOM_ALERT_FRACTION,
  SUSTAINED_DEFERRAL_FRACTION,
  SUSTAINED_DEFERRAL_MIN_JOBS,
  SUSTAINED_DEFERRAL_WINDOW_MINUTES,
} from '@/lib/ciFleet/shardTargets';
import {
  GithubOrgHeadroomExceededError,
  ShardHeadroomExceededError,
  SustainedDeferralError,
} from '@/lib/ciFleet/headroomErrors';
import type { GithubOrgTarget } from '@/lib/github/orgTarget';
import { readInstallationRateLimit } from '@/lib/github/rateLimit';
import { findProvisioningInstallationId } from '@/lib/github/repoProvisioning';
import { GITHUB_RUNNER_REGISTRATIONS_PER_5_MIN } from '@/lib/github/runnerJitConfig';
import { alertFleetShardHeadroom } from '@/lib/monitoring/fleetShardHeadroomAlert';
import { githubRunnerCallEventRepository as ledger } from '@/lib/repositories/githubRunnerCallEventRepository';
import { orgTargetForGithubOrg } from '@/lib/services/fleetGithubOrgAssignmentService';

// THE HEADROOM PASS (Story MOTIR-8953 · MOTIR-8969) — every minute, each fleet
// account, each GitHub org and each fleet kind against 70% of its limits
// (`docs/decisions/fleet-per-org-pool.md` AMENDMENT 1). It only measures and
// alerts: admission stays the one decider, and pool growth acts on
// `readAccountHeadroom`.
//
// ⚠️ SYSTEM CONTEXT. The counts span every tenant; under a workspace context they
// would come back smaller and still look plausible, and the alert would stay
// quiet.
//
// ⚠️ GITHUB COUNTS ARE KEYED ON THE RUNNER'S ORG — the ledger's `githubOrg`, the
// repo owner the JIT config was minted in — never on the machine's account, so a
// job that moved still lands on its tenant's org.
//
// ⚠️ A FAILED READ IS A FAILURE, NEVER A ZERO.

const MINUTE_MS = 60_000;
/** The compute peak is taken over the last five minutes. */
const PEAK_WINDOW_MS = 5 * MINUTE_MS;
/** A GitHub org is measured while it has a call in the last hour. */
const ORG_WINDOW_MS = 60 * MINUTE_MS;
/** Ledger events older than this are pruned each pass. */
const LEDGER_RETENTION_MS = 2 * ORG_WINDOW_MS;

/** One account's compute reading — what pool growth acts on. */
export interface AccountHeadroom {
  shardId: string;
  fleetKind: string;
  usedVcpu: number;
  vcpuQuota: number | null;
  /** `usedVcpu / vcpuQuota`; null when no quota is recorded. */
  fraction: number | null;
}

export type HeadroomSubject = { shardId: string } | { githubOrg: string } | { fleetKind: string };

export interface HeadroomReading {
  subject: HeadroomSubject;
  limit: string;
  used: number;
  capacity: number;
  fraction: number;
}

export interface HeadroomPassResult {
  accounts: number;
  orgs: number;
  kinds: number;
  readings: HeadroomReading[];
  /** The window's moves between accounts, per fleet kind and reason. */
  moves: Record<string, Partial<Record<FleetShardMoveReason, number>>>;
  alerted: number;
  failures: number;
}

/** The largest number of `[start, end]` intervals that overlap at one instant. */
export function peakOverlap(intervals: ReadonlyArray<{ start: number; end: number }>): number {
  const points: Array<[number, number]> = [];
  for (const { start, end } of intervals) {
    if (end < start) continue;
    points.push([start, 1], [end, -1]);
  }
  // At one instant a start is counted before an end: touching intervals overlap.
  points.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of points) {
    current += delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

/** Peak CI runners on one account over the window, from boot/settle intervals. */
async function ciRunnerPeak(
  shardId: string,
  now: Date,
  tx: Prisma.TransactionClient,
): Promise<number> {
  const since = new Date(now.getTime() - PEAK_WINDOW_MS);
  const rows = await tx.ciRunnerProvisioningIntent.findMany({
    where: {
      fleetShardId: shardId,
      bootedAt: { not: null, lte: now },
      OR: [{ settledAt: null }, { settledAt: { gte: since } }],
    },
    select: { bootedAt: true, settledAt: true },
  });
  return peakOverlap(
    rows.map((row) => ({
      start: Math.max(row.bootedAt!.getTime(), since.getTime()),
      end: Math.min((row.settledAt ?? now).getTime(), now.getTime()),
    })),
  );
}

/** Each kind's peak-in-flight reader on an account. CI is wired; each other
 *  kind's story adds its own when it puts the kind on its pool. */
const PEAK_ON_SHARD: Partial<
  Record<string, (shardId: string, now: Date, tx: Prisma.TransactionClient) => Promise<number>>
> = {
  ci_runner: ciRunnerPeak,
};

function fractionOf(used: number, capacity: number): number {
  return capacity > 0 ? used / capacity : used > 0 ? Infinity : 0;
}

function overThreshold(used: number, capacity: number): boolean {
  return used >= HEADROOM_ALERT_FRACTION * capacity;
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

/** The smallest recorded value of one limit across the rows, or null. */
function smallest(values: ReadonlyArray<number | null>): number | null {
  const recorded = values.filter((value): value is number => value !== null);
  return recorded.length === 0 ? null : Math.min(...recorded);
}

async function readAccounts(
  now: Date,
  tx: Prisma.TransactionClient,
): Promise<Array<AccountHeadroom & { shard: FleetShard }>> {
  // The SHARED accounts and the spares only: a Host org's own account is never
  // part of a pool's headroom, so it never counts toward growth (MOTIR-9581).
  const shards = await tx.fleetShard.findMany({
    where: { state: { in: ['active', 'disabled'] }, role: { in: ['primary', 'spare'] } },
    orderBy: { id: 'asc' },
  });
  const readings: Array<AccountHeadroom & { shard: FleetShard }> = [];
  for (const shard of shards) {
    const peak = PEAK_ON_SHARD[shard.fleetKind];
    if (!peak) continue;
    const usedVcpu = (await peak(shard.id, now, tx)) * FLEET_CONTAINER_SIZE.cpus;
    readings.push({
      shard,
      shardId: shard.id,
      fleetKind: shard.fleetKind,
      usedVcpu,
      vcpuQuota: shard.vcpuQuota,
      fraction: shard.vcpuQuota === null ? null : fractionOf(usedVcpu, shard.vcpuQuota),
    });
  }
  return readings;
}

/** The installation to read an org's REST budget with: its account rows', else
 *  the provisioning App's installation on it, if any. */
async function rateLimitTargetFor(
  org: string,
  shards: readonly FleetShard[],
): Promise<GithubOrgTarget | null> {
  const fromRows = orgTargetForGithubOrg(org, shards);
  if (fromRows) return fromRows;
  const installationId = await findProvisioningInstallationId(org);
  return installationId === null ? null : { org, installationId, role: 'provisioning' };
}

export const fleetShardHeadroomService = {
  /** One compute reading per active or disabled account — what pool growth calls. */
  async readAccountHeadroom(now: Date): Promise<AccountHeadroom[]> {
    const readings = await withSystemContext((tx) => readAccounts(now, tx));
    return readings.map(({ shard: _shard, ...reading }) => reading);
  },

  /** One pass. Never throws for one account, org or kind. */
  async run(now: Date): Promise<HeadroomPassResult> {
    const result: HeadroomPassResult = {
      accounts: 0,
      orgs: 0,
      kinds: 0,
      readings: [],
      moves: {},
      alerted: 0,
      failures: 0,
    };
    const raise = (error: Parameters<typeof alertFleetShardHeadroom>[0]) => {
      alertFleetShardHeadroom(error);
      result.alerted += 1;
    };

    // ── Compute, per account ─────────────────────────────────────────────────
    let accounts: Array<AccountHeadroom & { shard: FleetShard }> = [];
    try {
      accounts = await withSystemContext((tx) => readAccounts(now, tx));
    } catch (err) {
      result.failures += 1;
      console.error('[fleetShardHeadroomService] could not read the fleet accounts', {
        detail: detailOf(err),
      });
    }
    result.accounts = accounts.length;
    for (const account of accounts) {
      if (account.vcpuQuota === null) continue;
      result.readings.push({
        subject: { shardId: account.shardId },
        limit: 'vcpu',
        used: account.usedVcpu,
        capacity: account.vcpuQuota,
        fraction: account.fraction!,
      });
      if (overThreshold(account.usedVcpu, account.vcpuQuota)) {
        raise(
          new ShardHeadroomExceededError(
            account.shard.name,
            account.fleetKind,
            'vcpu',
            account.usedVcpu,
            account.vcpuQuota,
            account.fraction!,
          ),
        );
      }
    }

    // ── GitHub, per org ──────────────────────────────────────────────────────
    const { shards, orgs } = await withSystemContext(async (tx) => {
      const allShards = await tx.fleetShard.findMany({
        where: { state: { in: ['active', 'disabled'] } },
      });
      const named = allShards.map((shard) => shard.githubOrg.trim().toLowerCase());
      const called = await ledger.listOrgsSince(new Date(now.getTime() - ORG_WINDOW_MS), tx);
      return {
        shards: allShards,
        orgs: [...new Set([...named, ...called])].filter(Boolean).sort(),
      };
    });
    result.orgs = orgs.length;
    const shardName = new Map(shards.map((shard) => [shard.id, shard.name]));
    for (const org of orgs) {
      try {
        await this.measureOrg(org, shards, shardName, now, result, raise);
      } catch (err) {
        result.failures += 1;
        console.error('[fleetShardHeadroomService] could not measure a GitHub org', {
          githubOrg: org,
          detail: detailOf(err),
        });
      }
    }

    // ── Sustained deferral and moves, per kind ───────────────────────────────
    try {
      const since = new Date(now.getTime() - SUSTAINED_DEFERRAL_WINDOW_MINUTES * MINUTE_MS);
      const { total, deferred, moves } = await withSystemContext(async (tx) => {
        const window = { createdAt: { gt: since, lte: now } };
        const [total, deferred, moved] = await Promise.all([
          tx.ciRunnerProvisioningIntent.count({ where: window }),
          tx.ciRunnerProvisioningIntent.count({
            where: { ...window, NOT: { shardCapacityDeferredAt: null } },
          }),
          tx.ciRunnerProvisioningIntent.groupBy({
            by: ['fleetShardMoveReason'],
            where: { ...window, NOT: { fleetShardMoveReason: null } },
            _count: { _all: true },
          }),
        ]);
        return { total, deferred, moves: moved };
      });
      result.kinds = 1;
      const ciMoves: Partial<Record<FleetShardMoveReason, number>> = {};
      for (const row of moves) {
        if (row.fleetShardMoveReason) ciMoves[row.fleetShardMoveReason] = row._count._all;
      }
      result.moves['ci_runner'] = ciMoves;
      result.readings.push({
        subject: { fleetKind: 'ci_runner' },
        limit: 'sustained_deferral',
        used: deferred,
        capacity: total,
        fraction: fractionOf(deferred, total),
      });
      if (
        deferred >= SUSTAINED_DEFERRAL_MIN_JOBS &&
        deferred >= SUSTAINED_DEFERRAL_FRACTION * total
      ) {
        raise(
          new SustainedDeferralError(
            'ci_runner',
            deferred,
            total,
            SUSTAINED_DEFERRAL_WINDOW_MINUTES,
          ),
        );
      }
    } catch (err) {
      result.failures += 1;
      console.error('[fleetShardHeadroomService] could not read the deferrals', {
        detail: detailOf(err),
      });
    }

    // ── Pruning ──────────────────────────────────────────────────────────────
    try {
      await withSystemContext((tx) =>
        ledger.deleteOlderThan(new Date(now.getTime() - LEDGER_RETENTION_MS), tx),
      );
    } catch (err) {
      console.error('[fleetShardHeadroomService] could not prune the runner-call ledger', {
        detail: detailOf(err),
      });
    }
    return result;
  },

  /** Every GitHub limit of one org. A failed rate-limit read is a failure. */
  async measureOrg(
    org: string,
    shards: readonly FleetShard[],
    shardName: ReadonlyMap<string, string>,
    now: Date,
    result: HeadroomPassResult,
    raise: (error: GithubOrgHeadroomExceededError) => void,
  ): Promise<void> {
    const naming = shards.filter((shard) => shard.githubOrg.trim().toLowerCase() === org);
    const noAccountRow = naming.length === 0;
    const registrations =
      smallest(naming.map((shard) => shard.githubRegistrationsPer5Min)) ??
      GITHUB_RUNNER_REGISTRATIONS_PER_5_MIN;

    const { minted, secondary, contributors } = await withSystemContext(async (tx) => {
      const minted = await ledger.countSince(
        org,
        ['mint'],
        new Date(now.getTime() - PEAK_WINDOW_MS),
        now,
        tx,
      );
      const secondary: Array<{ name: string; used: number; capacity: number }> = [];
      for (const limit of Object.values(GITHUB_SECONDARY_LIMITS)) {
        secondary.push({
          name: limit.name,
          used: await ledger.countSince(
            org,
            limit.countsCalls,
            new Date(now.getTime() - limit.periodSeconds * 1000),
            now,
            tx,
          ),
          capacity: limit.perPeriod,
        });
      }
      const contributors = await ledger.listShardIdsSince(
        org,
        new Date(now.getTime() - ORG_WINDOW_MS),
        tx,
      );
      return { minted, secondary, contributors };
    });
    const names = contributors.map((id) => shardName.get(id) ?? id);

    const measured = [
      { name: 'registrations_per_5_min', used: minted, capacity: registrations },
      ...secondary,
    ];
    for (const { name, used, capacity } of measured) {
      const fraction = fractionOf(used, capacity);
      result.readings.push({ subject: { githubOrg: org }, limit: name, used, capacity, fraction });
      if (overThreshold(used, capacity)) {
        raise(
          new GithubOrgHeadroomExceededError(
            org,
            name,
            used,
            capacity,
            fraction,
            names,
            noAccountRow,
          ),
        );
      }
    }

    // The installation's own REST budget — read, not counted.
    const target = await rateLimitTargetFor(org, naming);
    if (!target) {
      // A tenant's own org with no Motir App on it: nothing to read with. The
      // fallback org always has one, so its absence is a failure.
      if (isMotirHostedOwner(org, provisioningOrgLogin()))
        throw new Error('no installation to read the REST budget with');
      return;
    }
    const budget = await readInstallationRateLimit(target);
    const fraction = fractionOf(budget.used, budget.limit);
    result.readings.push({
      subject: { githubOrg: org },
      limit: 'api_per_hour',
      used: budget.used,
      capacity: budget.limit,
      fraction,
    });
    if (overThreshold(budget.used, budget.limit)) {
      raise(
        new GithubOrgHeadroomExceededError(
          org,
          'api_per_hour',
          budget.used,
          budget.limit,
          fraction,
          names,
          noAccountRow,
        ),
      );
    }
  },
};

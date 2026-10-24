import type { FleetQuotaRequest, FleetShard, Prisma } from '@/generated/prisma/client';
import { FleetShardAccountRefusedError, GrowthKindNotAwsError } from '@/lib/ciFleet/errors';
import {
  crossesGrowthThreshold,
  GROWTH_CLAIM_STALE_MS,
  type GrowthResult,
  type GrowthSkip,
  type GrowthTrigger,
  type SettleSparesResult,
} from '@/lib/ciFleet/poolGrowthPolicy';
import { fleetKindOnPool, poolAccountRaiseTargetVcpu } from '@/lib/ciFleet/shardTargets';
import { FLEET_WORKLOAD_KINDS, type FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import { fleetAutomationPrincipal } from '@/lib/fleetShards/fleetAutomationPrincipal';
import { scrubSecrets } from '@/lib/fleetShards/scrubSecrets';
import { fleetGrowthEventRepository } from '@/lib/repositories/fleetGrowthEventRepository';
import { fleetGrowthLockRepository } from '@/lib/repositories/fleetGrowthLockRepository';
import { fleetQuotaRequestRepository } from '@/lib/repositories/fleetQuotaRequestRepository';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import type { LiveQuotaReading } from '@/lib/services/fleetShardQuotaService';
import {
  fleetShardProvisioningService,
  type AddSpareShardDeps,
  type ShardProvisioningResult,
} from '@/lib/services/fleetShardProvisioningService';
import { platformAuditService } from '@/lib/services/platformAuditService';
import { withSystemContext } from '@/lib/workspaces/context';

// ONE POOL GROWTH (Story MOTIR-9362 · MOTIR-9461). An account of a kind's shared
// pool reached 70% of its LIVE granted vCPU quota: promote the kind's ready
// spare into the pool and create the next account, with no person acting.
//
// The order is the whole design:
//   1. a kind still on Fly is never grown;
//   2. the trigger reads this pass's live quotas only — an unreadable account is
//      skipped and reported, never compared against a stored or default value;
//   3. under a per-kind try-advisory-lock, a kind with an unfinished growth is
//      left alone, else a CLAIM row is written (it is what keeps a second pass
//      out once the lock is released) and a ready spare is promoted — all in one
//      short transaction;
//   4. the account is created OUTSIDE any transaction, through the unattended
//      add-shard, which resumes by its derived name — so a crash between the
//      claim and the create leaves a claim that goes stale, and the pass after
//      it finishes the same account rather than making a second;
//   5. the claim is settled into the growth's one event, and its one audit row
//      is written beside it.
// AWS is reached only through `addSpareShard`; no credential is read here, and
// nothing this returns, writes or logs carries one.

/** This pass's figures for one kind: each shared account's live granted quota
 *  (`refreshLiveGrantedQuotas`) and its vCPU in use (`readAccountHeadroom`). */
export interface GrowthReading {
  liveQuotas: readonly LiveQuotaReading[];
  usage: ReadonlyArray<{ shardId: string; usedVcpu: number }>;
}

export interface FleetPoolGrowthDeps {
  /** Is the kind switched to its AWS pool? */
  onPool?: (kind: FleetWorkloadKind) => Promise<boolean>;
  now?: () => Date;
  /** The unattended add-shard's own seams (AWS, env). */
  addSpare?: AddSpareShardDeps;
}

interface Candidate extends GrowthTrigger {
  shardName: string;
}

/**
 * The shared account with the highest in-use / live-granted ratio, and every
 * account that could not be compared. Ratios are compared cross-multiplied, on
 * the same rounded-up integers the trigger uses.
 */
export function pickTrigger(
  shared: ReadonlyArray<Pick<FleetShard, 'id' | 'name'>>,
  reading: GrowthReading,
): { trigger: Candidate | null; skipped: GrowthSkip[] } {
  const skipped: GrowthSkip[] = [];
  let best: Candidate | null = null;
  for (const shard of shared) {
    const live = reading.liveQuotas.find((r) => r.shardId === shard.id);
    if (!live) {
      skipped.push({ shardId: shard.id, reason: 'no live quota read this pass' });
      continue;
    }
    if ('failure' in live) {
      skipped.push({ shardId: shard.id, reason: live.failure.reason });
      continue;
    }
    const usage = reading.usage.find((u) => u.shardId === shard.id);
    if (!usage) {
      skipped.push({ shardId: shard.id, reason: 'no vCPU-in-use reading this pass' });
      continue;
    }
    const candidate: Candidate = {
      triggeringShardId: shard.id,
      shardName: shard.name,
      vcpuInUse: Math.ceil(usage.usedVcpu),
      grantedQuota: live.granted,
    };
    if (
      !best ||
      candidate.vcpuInUse * best.grantedQuota > best.vcpuInUse * candidate.grantedQuota
    ) {
      best = candidate;
    }
  }
  if (best && !crossesGrowthThreshold(best.vcpuInUse, best.grantedQuota)) best = null;
  return { trigger: best, skipped };
}

/**
 * Is this spare READY to join the shared pool? Its newest quota raise is
 * `approved` and the row already carries the granted value. A spare with a
 * pending or refused raise is never ready. A spare that never filed a raise —
 * the Motir spare a person made — is ready when it is active and already holds
 * the kind's target.
 */
export function spareReady(
  spare: Pick<FleetShard, 'state' | 'vcpuQuota' | 'fleetKind'>,
  latestRequest: Pick<FleetQuotaRequest, 'status' | 'desiredValue'> | null,
): boolean {
  if (spare.state === 'disabled' || spare.vcpuQuota === null) return false;
  if (!latestRequest) {
    return (
      spare.state === 'active' &&
      spare.vcpuQuota >= poolAccountRaiseTargetVcpu(spare.fleetKind as FleetWorkloadKind)
    );
  }
  return latestRequest.status === 'approved' && spare.vcpuQuota >= latestRequest.desiredValue;
}

/** The kind's spares, each with its newest quota raise. */
async function sparesWithRequests(
  kind: string,
  tx: Prisma.TransactionClient,
): Promise<Array<{ spare: FleetShard; request: FleetQuotaRequest | null }>> {
  const spares = await fleetShardRepository.listSparesForKind(kind, tx);
  const out = [];
  for (const spare of spares) {
    const [request] = await fleetQuotaRequestRepository.listByShard(spare.id, tx);
    out.push({ spare, request: request ?? null });
  }
  return out;
}

/** Move a spare into the shared pool: `primary` and `active`. It is in the
 *  selection set from the next admission, which reads the rows uncached. */
async function promoteInTx(spare: FleetShard, tx: Prisma.TransactionClient): Promise<void> {
  await fleetShardRepository.setRoleInTx(spare.id, 'primary', tx);
  if (spare.state !== 'active') await fleetShardRepository.updateState(spare.id, 'active', tx);
}

/** Why a create did not happen, as text that cannot carry a credential. AWS's
 *  own reason is free text, so it is scrubbed before the event, the audit row and
 *  the alert see it (MOTIR-9464's seam test seeds one carrying a key id). */
function refusalReason(err: unknown): string {
  return scrubSecrets(rawRefusalReason(err));
}

function rawRefusalReason(err: unknown): string {
  if (err instanceof FleetShardAccountRefusedError) return err.reason;
  if (err && typeof err === 'object' && 'problems' in err && Array.isArray(err.problems)) {
    return (err.problems as unknown[]).map(String).join('; ');
  }
  if (err && typeof err === 'object' && 'reason' in err && typeof err.reason === 'string') {
    return err.reason;
  }
  return err instanceof Error ? err.name : 'UnknownError';
}

type Claimed =
  | { kind: 'in_flight'; eventId: string | null }
  | { kind: 'claimed'; eventId: string; promoted: FleetShard | null };

/** Step 3 and 4: the lock, the one-in-flight rule, the claim and the promotion,
 *  in one short transaction. */
async function claimGrowth(
  kind: FleetWorkloadKind,
  trigger: GrowthTrigger,
  now: Date,
): Promise<Claimed> {
  return withSystemContext(async (tx) => {
    if (!(await fleetGrowthLockRepository.tryLockKindInTx(kind, tx))) {
      return { kind: 'in_flight', eventId: null };
    }
    const unfinished = await fleetGrowthEventRepository.findLatestUnfinishedByKind(
      kind,
      tx,
      new Date(now.getTime() - GROWTH_CLAIM_STALE_MS),
    );
    const spares = await sparesWithRequests(kind, tx);
    // A spare still waiting on its raise is a growth in flight too, event or not
    // — so a pass that died after the create, and whose claim went stale, cannot
    // be followed by a second account.
    const raising = spares.some(({ request }) => request !== null && request.closedAt === null);
    if (unfinished || raising) return { kind: 'in_flight', eventId: unfinished?.id ?? null };

    const ready = spares.find(({ spare, request }) => spareReady(spare, request));
    if (ready) await promoteInTx(ready.spare, tx);
    const claim = await fleetGrowthEventRepository.create(
      {
        fleetKind: kind,
        triggeringShardId: trigger.triggeringShardId,
        vcpuInUse: trigger.vcpuInUse,
        grantedQuota: trigger.grantedQuota,
        outcome: 'waiting_for_quota',
        spareShardId: ready?.spare.id ?? null,
        createdAt: now,
      },
      tx,
    );
    return { kind: 'claimed', eventId: claim.id, promoted: ready?.spare ?? null };
  });
}

export const fleetPoolGrowthService = {
  /**
   * Decide and run ONE growth of `kind` from this pass's `reading`. Never grows
   * a kind on Fly, never starts a second growth while one is unfinished, and
   * writes exactly one event and one audit row per growth.
   */
  async growKind(
    kind: string,
    reading: GrowthReading,
    deps: FleetPoolGrowthDeps = {},
  ): Promise<GrowthResult> {
    if (!(FLEET_WORKLOAD_KINDS as string[]).includes(kind)) {
      throw new GrowthKindNotAwsError(kind);
    }
    const fleetKind = kind as FleetWorkloadKind;
    const onPool = deps.onPool ?? fleetKindOnPool;
    const now = (deps.now ?? (() => new Date()))();

    // 1. Fly guard.
    if (!(await onPool(fleetKind))) {
      return { result: 'not_aws', fleetKind, error: new GrowthKindNotAwsError(fleetKind) };
    }

    // 2. Trigger, on this pass's live values.
    const shared = await withSystemContext((tx) =>
      fleetShardRepository.listByRole(
        'primary',
        { fleetKind, state: 'active', provider: 'aws' },
        tx,
      ),
    );
    const { trigger, skipped } = pickTrigger(shared, reading);
    if (!trigger) return { result: 'below_threshold', fleetKind, skipped };
    const figures: GrowthTrigger = {
      triggeringShardId: trigger.triggeringShardId,
      vcpuInUse: trigger.vcpuInUse,
      grantedQuota: trigger.grantedQuota,
    };

    // 3–4. One in flight; claim; promote a ready spare.
    const claimed = await claimGrowth(fleetKind, figures, now);
    if (claimed.kind === 'in_flight') {
      return { result: 'in_flight', fleetKind, eventId: claimed.eventId, skipped };
    }
    const promotedSpareId = claimed.promoted?.id ?? null;

    // 5. Create — outside any transaction.
    let created: ShardProvisioningResult;
    try {
      created = await fleetShardProvisioningService.addSpareShard({ fleetKind }, deps.addSpare);
    } catch (err) {
      await withSystemContext((tx) =>
        fleetGrowthEventRepository.deleteClaimInTx(claimed.eventId, tx),
      );
      return {
        result: 'refused',
        fleetKind,
        ...figures,
        reason: refusalReason(err),
        promotedSpareId,
        skipped,
      };
    }

    // 6. Settle the claim into this growth's one event, then its audit row.
    const newShardId = created.shard.id;
    const request = await withSystemContext(async (tx) => {
      const [latest] = await fleetQuotaRequestRepository.listByShard(newShardId, tx);
      return latest ?? null;
    });
    const raiseOpen = request !== null && request.closedAt === null;
    const outcome = promotedSpareId
      ? 'spare_promoted'
      : raiseOpen
        ? 'waiting_for_quota'
        : 'account_created';
    const raiseStep = created.steps.find((s) => s.step === 'quota_raise');
    const reason =
      raiseStep?.outcome === 'failed' ? `quota raise not filed: ${raiseStep.detail}` : null;
    // The audit row is appended while the settling transaction is still open, so
    // a refused append rolls the settlement back (the claim then goes stale);
    // the two contexts bind different policy arms and cannot share one
    // transaction.
    const event = await withSystemContext(async (tx) => {
      const settled = await fleetGrowthEventRepository.settleInTx(
        claimed.eventId,
        { outcome, newShardId, quotaRequestId: request?.id ?? null, reason },
        tx,
      );
      await auditGrowth(settled.id, trigger.shardName, fleetKind, figures, {
        outcome,
        spareShardId: promotedSpareId,
        newShardId,
        quotaRequestId: request?.id ?? null,
      });
      return settled;
    });

    return {
      result: 'grown',
      fleetKind,
      ...figures,
      outcome,
      eventId: event.id,
      promotedSpareId,
      newShardId,
      quotaRequestId: request?.id ?? null,
      skipped,
    };
  },

  /**
   * Finish what earlier growths started, on every pass whether or not 70% still
   * holds: a spare a `waiting_for_quota` growth created joins the shared pool
   * once its raise is granted (and that growth's event says so), and a
   * replacement spare whose raise is granted becomes the kind's ready spare —
   * while the kind has no other.
   */
  async settleGrantedSpares(
    kind: string,
    deps: Pick<FleetPoolGrowthDeps, 'onPool'> = {},
  ): Promise<SettleSparesResult> {
    if (!(FLEET_WORKLOAD_KINDS as string[]).includes(kind)) {
      throw new GrowthKindNotAwsError(kind);
    }
    const result: SettleSparesResult = { fleetKind: kind, locked: false, joined: [], readied: [] };
    if (!(await (deps.onPool ?? fleetKindOnPool)(kind as FleetWorkloadKind))) return result;

    return withSystemContext(async (tx) => {
      if (!(await fleetGrowthLockRepository.tryLockKindInTx(kind, tx))) {
        return { ...result, locked: true };
      }
      const spares = await sparesWithRequests(kind, tx);
      let hasReadySpare = spares.some(({ spare }) => spare.state === 'active');
      for (const { spare, request } of spares) {
        if (spare.state !== 'provisioning' || !request || !spareReady(spare, request)) continue;
        const waiting = await fleetGrowthEventRepository.findWaitingForShardInTx(
          kind,
          spare.id,
          tx,
        );
        if (waiting) {
          await promoteInTx(spare, tx);
          await fleetGrowthEventRepository.settleInTx(
            waiting.id,
            { outcome: 'account_created', reason: 'joined the shared pool: quota raise granted' },
            tx,
          );
          result.joined.push({ shardId: spare.id, eventId: waiting.id });
        } else if (!hasReadySpare) {
          await fleetShardRepository.updateState(spare.id, 'active', tx);
          hasReadySpare = true;
          result.readied.push(spare.id);
        }
      }
      return result;
    });
  },
};

/** The growth's one platform audit row, as Motir's system account. */
async function auditGrowth(
  eventId: string,
  triggeringShardName: string,
  fleetKind: FleetWorkloadKind,
  figures: GrowthTrigger,
  what: {
    outcome: string;
    spareShardId: string | null;
    newShardId: string;
    quotaRequestId: string | null;
  },
): Promise<void> {
  await platformAuditService.record(await fleetAutomationPrincipal(), {
    action: 'fleet.pool.grow',
    targetKind: 'platform',
    targetId: figures.triggeringShardId,
    targetLabel: triggeringShardName,
    reason:
      `pool growth: ${fleetKind} account at ${figures.vcpuInUse} of ` +
      `${figures.grantedQuota} granted vCPU`,
    metadata: { fleetKind, growthEventId: eventId, ...figures, ...what },
  });
}

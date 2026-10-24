import {
  OrchestratorApiError,
  type ContainerOrchestrator,
  type FleetInventory,
  type InventoryMachine,
  type InventoryVolume,
} from '@motir/orchestrator';
import {
  getFleetInventory,
  getOrchestrator,
  inventoryForShard,
  isOrchestratorConfigured,
  legacyFleetLocationKey,
  shardLocationKey,
} from '@/lib/orchestrator';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { withSystemContext } from '@/lib/workspaces/context';
import {
  ciRunnerProvisioningIntentRepository as intents,
  CI_RUNNER_INTENT_IN_FLIGHT,
} from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { ciContainerUsageRepository } from '@/lib/repositories/ciContainerUsageRepository';
import { fleetInFlightSlotRepository } from '@/lib/repositories/fleetInFlightSlotRepository';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { fleetMachineKillRepository } from '@/lib/repositories/fleetMachineKillRepository';
import { ciRunnerBootService, FLEET_TIME_BUDGETS } from '@/lib/services/ciRunnerBootService';
import { indexSlotRef } from '@/lib/services/codeGraphIndexAdmissionService';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import type { FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import {
  FleetInventoryUnavailableError,
  UnattributedMachineDestroyedError,
  UnattributedVolumeDestroyedError,
  type AttributionKillReason,
} from '@/lib/ciFleet/attributionErrors';
import { alertFleetAttribution } from '@/lib/monitoring/fleetAttributionAlert';

// EVERY MACHINE BELONGS TO A PAYING ORG, OR IT DIES (Story MOTIR-6906 ·
// MOTIR-6925) — `docs/decisions/fleet-per-org-pool.md` §5 is the record.
//
// Credits bound what an ATTRIBUTED machine costs. The one way Motir can pay for a
// machine nobody is charged for is a machine that belongs to nobody — a crashed
// boot, a failed teardown, a record that was never written, a machine started by
// hand — and neither credits nor anything that reads Motir's own tables can see
// one. So this pass starts from the PROVIDER:
//
//   1. every app in the fleet organisation, then every machine in each, tagged or
//      not (`FleetInventory`);
//   2. each machine matched to a live record of its workload — a CI intent in
//      flight, a hosted-agent or index checkpoint still holding an unexpired
//      slot, a non-deleted agent instance. Metadata is never attribution: anyone
//      holding the token can write it;
//   3. a machine nothing attributes, or whose record says it should have
//      stopped, is killed once it is past the GRACE — recorded first, then
//      destroyed (an agent instance's persistent machine is STOPPED instead), and
//      one Sentry issue raised per machine.
//
// ⚠️ A LISTING ERROR IS NEVER "NOTHING IS RUNNING". A failed app list ends the
// pass and destroys nothing anywhere; a failed machine list skips that one app.
// Both alert — but only once the listing has failed TWICE when the first answer
// was a transient one (a gateway 502/503/504, a 429, a dropped connection): the
// provider's edge drops single requests, and an error-level issue for a refusal
// the very next request does not repeat is noise the platform admin learns to
// ignore (MOTIR-8302). The retry is a second READ, never a guess. A TIMEOUT is
// not retried: it has already spent the 30 s call deadline, and a pass that
// doubled it for every app would outlive its own five-minute cadence. A
// machine the provider lists without a creation instant cannot be
// aged, so it is alerted and left alone rather than destroyed on a guess.
//
// ⚠️ IT DOES NOT RE-CHECK PLAN OR BALANCE (§5). Refusing work for money is
// admission's job and the zero-stop's; two killers for one reason would race.
// `org_stopped` is read off the record the stop already wrote — a CI intent
// settled `credits_exhausted` or `admin_stop` — never re-derived here.

/** How long a machine may exist before its record names it — or run on after its
 *  record ended — before it is killed (§5: three times the longest legitimate
 *  create-then-record window, the hosted run's 210 s). */
export const FLEET_ATTRIBUTION_GRACE_MS = 10 * 60_000;

/** A CI intent's own end: boot + the job timeout + 10 minutes. What the old
 *  reaper's age cutoff became (§6) — a property of the RECORD, not of the machine. */
export const CI_INTENT_END_AFTER_BOOT_MS = FLEET_TIME_BUDGETS.reapAfterMs;

/** The teardown reasons the org stop writes (`fleetStopService`, MOTIR-6908). */
const ORG_STOP_REASONS: ReadonlySet<string> = new Set(['credits_exhausted', 'admin_stop']);

/** How long the pass waits before asking a listing a second time (MOTIR-8302). */
export const FLEET_LISTING_RETRY_DELAY_MS = 2_000;

/** Provider answers that say "ask again", not "this listing is refused". */
const TRANSIENT_LISTING_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/** A refusal at the provider's edge, or no answer at all (`status: null`, a
 *  dropped connection). A timeout is its own error class and is not one of these. */
function isTransientListingFailure(err: unknown): boolean {
  return (
    err instanceof OrchestratorApiError &&
    (err.status === null || TRANSIENT_LISTING_STATUSES.has(err.status))
  );
}

/** One listing, asked once more after a transient failure. A second failure —
 *  or a first one that is not transient — is thrown to the caller, which alerts. */
async function listWithOneRetry<T>(read: () => Promise<T>, delayMs: number): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (!isTransientListingFailure(err)) throw err;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return read();
  }
}

const CI_RUNNER: FleetWorkloadKind = 'ci_runner';
const HOSTED_AGENT: FleetWorkloadKind = 'hosted_agent';
const CODE_GRAPH_INDEX: FleetWorkloadKind = 'code_graph_index';
const AGENT_INSTANCE: FleetWorkloadKind = 'agent_instance';

/** The kill row's `machineName` for a deleted hoster DISK — the row is the
 *  machine audit's, and the name says which kind of thing it was (MOTIR-9476). */
export const HOSTER_VOLUME_KILL_NAME = 'ebs-volume';

/** What the matcher concluded about one machine. */
type Verdict =
  | { kind: 'attributed'; workload: FleetWorkloadKind }
  | {
      kind: 'kill';
      reason: AttributionKillReason;
      /** When the record ended; null for a machine no record ever named, which is
       *  aged from its own creation instead. */
      endedAt: Date | null;
      workload: FleetWorkloadKind | null;
      recordRef: string | null;
      organizationId: string | null;
      action: 'destroyed' | 'stopped';
      /** The record still has a container to settle — tear it down through the
       *  port so the usage row is written and the run or intent ends. */
      settle: boolean;
    };

/** One machine the pass killed. */
export interface FleetKill {
  app: string;
  machineId: string;
  reason: AttributionKillReason;
  action: 'destroyed' | 'stopped';
  workload: FleetWorkloadKind | null;
}

export type FleetAttributionResult =
  /** No fleet on this deployment — nothing to inventory. */
  | { outcome: 'disabled' }
  /** The app list failed: NOTHING was destroyed anywhere. */
  | { outcome: 'inventory_unavailable'; detail: string }
  | {
      outcome: 'reconciled';
      apps: number;
      /** Machines the provider listed that still exist. */
      listed: number;
      /** Attributed to a live record — left running. */
      matched: number;
      /** Unattributed or ended, but still inside the grace. */
      spared: number;
      /** Listed with no creation instant — alerted, not destroyed. */
      undated: number;
      killed: FleetKill[];
      /** Apps whose machine list failed — skipped, alerted. */
      unavailableApps: string[];
      /** Kills the provider refused, and machines the matcher could not judge —
       *  each alerted or logged, retried next pass. */
      failures: number;
      /** CI Docker volumes attached to nothing and past the grace, destroyed
       *  (MOTIR-8839) — each one a teardown that could not delete its own — and,
       *  from MOTIR-9476, the agent-hoster disks no live instance names. */
      orphanedVolumesDestroyed: number;
      /** Fleet accounts whose own listing was walked (MOTIR-9476). */
      accounts: number;
    };

/**
 * The volume backstop (MOTIR-8839): CI Docker volumes their teardown could not
 * delete, or that a dead process created for a machine it never booted. Past
 * the same grace a machine gets, so a volume whose machine is still being
 * created is never taken from under it. Never throws — the adapter's sweep
 * logs and counts, and an orchestrator without one has nothing to sweep.
 */
async function sweepOrphanedVolumes(
  now: () => Date,
  accounts: readonly FleetShardDTO[],
): Promise<number> {
  const olderThan = new Date(now().getTime() - FLEET_ATTRIBUTION_GRACE_MS);
  // ONCE PER PLACE, not once per route (MOTIR-8964): an account naming the
  // process-wide app is the same volumes, swept once.
  const places = new Map<string, () => ContainerOrchestrator>();
  if (isOrchestratorConfigured()) places.set(legacyFleetLocationKey(), getOrchestrator);
  for (const account of accounts) {
    // A hoster account's disks are judged against the instance records by the
    // hoster volume pass (MOTIR-9476); it has no CI runner volumes to sweep.
    if (account.fleetKind === AGENT_INSTANCE) continue;
    const key = shardLocationKey(account);
    if (!places.has(key)) {
      places.set(key, () => fleetShardOrchestratorService.forShardRow(account));
    }
  }
  let destroyed = 0;
  for (const [place, resolve] of places) {
    try {
      const orchestrator = resolve();
      if (orchestrator.sweepOrphanedVolumes) {
        destroyed += await orchestrator.sweepOrphanedVolumes(olderThan);
      }
    } catch (err) {
      console.error('[fleetAttribution] could not sweep volumes in a fleet account', {
        place,
        detail: detailOf(err),
      });
    }
  }
  return destroyed;
}

/** One fleet account's own machine listing — for a provider the Fly organisation
 *  walk does not cover (MOTIR-8964). */
export interface AccountInventory {
  shardId: string;
  name: string;
  inventory: FleetInventory;
  /** An agent-hoster account (MOTIR-9476): its machines are judged against the
   *  instance records BY ACCOUNT, and its disks are swept after them. */
  fleetKind?: FleetWorkloadKind;
}

/** Every account that can still have machines billing — all but `provisioning`,
 *  except a hoster account, which can hold disks in any state (MOTIR-9476). The
 *  agent-hoster switch is not read here: a pass covers every account it lists. */
async function liveAccounts(): Promise<FleetShardDTO[]> {
  const accounts = await fleetShardService.listShards();
  return accounts.filter(
    (account) => account.state !== 'provisioning' || account.fleetKind === AGENT_INSTANCE,
  );
}

/** The listings of the accounts whose provider the Fly walk does not cover. An
 *  account whose adapter cannot be built is alerted and skipped. */
function accountInventories(accounts: readonly FleetShardDTO[]): AccountInventory[] {
  const out: AccountInventory[] = [];
  for (const account of accounts) {
    try {
      const inventory = inventoryForShard(account);
      if (inventory) {
        out.push({
          shardId: account.id,
          name: account.name,
          inventory,
          fleetKind: account.fleetKind,
        });
      }
    } catch (err) {
      alertFleetAttribution(new FleetInventoryUnavailableError(account.name, detailOf(err)));
    }
  }
  return out;
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

function kill(
  reason: AttributionKillReason,
  endedAt: Date | null,
  rest: Partial<Omit<Extract<Verdict, { kind: 'kill' }>, 'kind' | 'reason' | 'endedAt'>> = {},
): Verdict {
  return {
    kind: 'kill',
    reason,
    endedAt,
    workload: rest.workload ?? null,
    recordRef: rest.recordRef ?? null,
    organizationId: rest.organizationId ?? null,
    action: rest.action ?? 'destroyed',
    settle: rest.settle ?? false,
  };
}

export const fleetAttributionService = {
  /**
   * One pass over the whole fleet organisation. Never throws: every failure is a
   * counted, alerted finding, and the pass reaches every other app and machine.
   */
  async reconcile(
    options: {
      now?: () => Date;
      inventory?: FleetInventory | null;
      /** The pause before a transient listing failure is asked again. */
      listingRetryDelayMs?: number;
      /** The fleet accounts to walk after the organisation — read from the
       *  account rows when absent (MOTIR-8964). */
      accounts?: readonly FleetShardDTO[];
      /** Their listings — derived from `accounts` when absent. */
      accountInventories?: readonly AccountInventory[];
    } = {},
  ): Promise<FleetAttributionResult> {
    const inventory = options.inventory === undefined ? getFleetInventory() : options.inventory;
    const now = options.now ?? (() => new Date());
    const retryDelayMs = options.listingRetryDelayMs ?? FLEET_LISTING_RETRY_DELAY_MS;
    const accounts = options.accounts ?? (await liveAccounts());
    const perAccount = options.accountInventories ?? accountInventories(accounts);
    if (!inventory && perAccount.length === 0) return { outcome: 'disabled' };

    let apps: string[] = [];
    if (inventory) {
      try {
        apps = await listWithOneRetry(() => inventory.listApps(), retryDelayMs);
      } catch (err) {
        alertFleetAttribution(
          new FleetInventoryUnavailableError('the fleet organization', detailOf(err)),
        );
        return { outcome: 'inventory_unavailable', detail: detailOf(err) };
      }
    }

    const result = {
      outcome: 'reconciled' as const,
      apps: apps.length,
      listed: 0,
      matched: 0,
      spared: 0,
      undated: 0,
      killed: [] as FleetKill[],
      unavailableApps: [] as string[],
      failures: 0,
      orphanedVolumesDestroyed: 0,
      accounts: 0,
    };

    // One walk per listing: the organisation's (machines settle through the
    // account their intent recorded), then each account's own (settling
    // through that account).
    const walk = async (
      source: FleetInventory,
      sourceApps: readonly string[],
      shardId: string | null | undefined,
      hosterShardId?: string,
    ): Promise<void> => {
      for (const app of sourceApps) {
        let machines: InventoryMachine[];
        try {
          machines = await listWithOneRetry(() => source.listMachines(app), retryDelayMs);
        } catch (err) {
          result.unavailableApps.push(app);
          alertFleetAttribution(new FleetInventoryUnavailableError(app, detailOf(err)));
          continue;
        }

        for (const machine of machines) {
          if (machine.state === 'gone') continue;
          result.listed += 1;
          if (!machine.createdAt) {
            result.undated += 1;
            alertFleetAttribution(
              new FleetInventoryUnavailableError(
                app,
                `machine ${machine.machineId} has no creation instant, so it cannot be aged`,
              ),
            );
            continue;
          }

          let verdict: Verdict;
          try {
            verdict = await this.judge(source.provider, machine, now(), hosterShardId);
          } catch (err) {
            // Could not read the records: never a reason to destroy.
            result.failures += 1;
            console.error('[fleetAttribution] could not judge a machine — left running', {
              app,
              machineId: machine.machineId,
              detail: detailOf(err),
            });
            continue;
          }
          if (verdict.kind === 'attributed') {
            result.matched += 1;
            continue;
          }

          // The grace runs from the later of the machine's creation and its
          // record's end, so the pass never races a boot or an ordinary teardown.
          const since = Math.max(machine.createdAt.getTime(), verdict.endedAt?.getTime() ?? 0);
          if (now().getTime() - since < FLEET_ATTRIBUTION_GRACE_MS) {
            result.spared += 1;
            continue;
          }

          const dated = { ...machine, createdAt: machine.createdAt };
          const done = await this.killMachine(source, dated, verdict, now, shardId);
          if (done) {
            result.killed.push({
              app,
              machineId: machine.machineId,
              reason: verdict.reason,
              action: verdict.action,
              workload: verdict.workload,
            });
          } else {
            result.failures += 1;
          }
        }
      }
    };

    if (inventory) await walk(inventory, apps, undefined);
    for (const account of perAccount) {
      let accountApps: string[];
      try {
        accountApps = await listWithOneRetry(() => account.inventory.listApps(), retryDelayMs);
      } catch (err) {
        result.unavailableApps.push(account.name);
        alertFleetAttribution(new FleetInventoryUnavailableError(account.name, detailOf(err)));
        continue;
      }
      result.apps += accountApps.length;
      result.accounts += 1;
      const hoster = account.fleetKind === AGENT_INSTANCE ? account.shardId : undefined;
      // The disks are LISTED before the machines are judged and JUDGED after: a
      // disk attached when the pass began is never taken in that pass, so the
      // home disk this pass's own machine kill detaches waits for the next one,
      // under the grace, rather than being raced (MOTIR-9476).
      const disks = hoster
        ? await this.listHosterVolumes(account, accountApps, retryDelayMs, result)
        : [];
      await walk(account.inventory, accountApps, account.shardId, hoster);
      if (hoster) await this.sweepHosterVolumes(account, disks, hoster, now, result);
    }
    result.orphanedVolumesDestroyed += await sweepOrphanedVolumes(now, accounts);
    return result;
  },

  /**
   * THE HOSTER DISK PASS (MOTIR-9476) — one agent-hoster account's EBS volumes.
   * A disk is deleted only when it is unattached (`available`), past the grace,
   * and no NON-deleted instance of this account names it as its home: that is
   * the disk a machine destroy detached (`DeleteOnTermination: false`) or a
   * failed teardown left. A disk with no creation instant is alerted and left; a
   * failed listing or record read deletes nothing. Recorded first, then deleted,
   * then alerted — the machine kill's order.
   */
  async listHosterVolumes(
    account: AccountInventory,
    apps: readonly string[],
    retryDelayMs: number,
    result: { failures: number },
  ): Promise<Array<{ app: string; volume: InventoryVolume }>> {
    const source = account.inventory;
    if (!source.listVolumes || !source.destroyVolume) return [];
    const out: Array<{ app: string; volume: InventoryVolume }> = [];
    for (const app of apps) {
      try {
        const volumes = await listWithOneRetry(() => source.listVolumes!(app), retryDelayMs);
        out.push(...volumes.map((volume) => ({ app, volume })));
      } catch (err) {
        result.failures += 1;
        alertFleetAttribution(
          new FleetInventoryUnavailableError(`${account.name} volumes`, detailOf(err)),
        );
      }
    }
    return out;
  },

  /** Judge the disks {@link listHosterVolumes} listed, after the machines. */
  async sweepHosterVolumes(
    account: AccountInventory,
    disks: ReadonlyArray<{ app: string; volume: InventoryVolume }>,
    fleetShardId: string,
    now: () => Date,
    result: { orphanedVolumesDestroyed: number; undated: number; failures: number },
  ): Promise<void> {
    const source = account.inventory;
    if (!source.destroyVolume) return;
    for (const { app, volume } of disks) {
      if (volume.state !== 'available' || volume.attachedMachineId) continue;
      if (!volume.createdAt) {
        result.undated += 1;
        alertFleetAttribution(
          new FleetInventoryUnavailableError(
            account.name,
            `volume ${volume.volumeId} has no creation instant, so it cannot be aged`,
          ),
        );
        continue;
      }
      const ageMs = now().getTime() - volume.createdAt.getTime();
      if (ageMs < FLEET_ATTRIBUTION_GRACE_MS) continue;
      let owner;
      try {
        owner = await withSystemContext((tx) =>
          agentInstanceRepository.findByVolumeInShard(fleetShardId, volume.volumeId, tx),
        );
      } catch (err) {
        result.failures += 1;
        console.error('[fleetAttribution] could not judge a volume — left in place', {
          account: account.name,
          volumeId: volume.volumeId,
          detail: detailOf(err),
        });
        continue;
      }
      if (owner) continue;

      const decidedAt = now();
      const row = await withSystemContext((tx) =>
        fleetMachineKillRepository.create(
          {
            app,
            machineId: volume.volumeId,
            machineName: HOSTER_VOLUME_KILL_NAME,
            reason: 'no_record',
            action: 'destroyed',
            workload: AGENT_INSTANCE,
            recordRef: null,
            organizationId: null,
            machineCreatedAt: volume.createdAt,
            ageSeconds: Math.floor(ageMs / 1000),
            decidedAt,
          },
          tx,
        ),
      );
      try {
        await source.destroyVolume(app, volume.volumeId);
      } catch (err) {
        const detail = detailOf(err);
        await withSystemContext((tx) => fleetMachineKillRepository.markFailed(row.id, detail, tx));
        result.failures += 1;
        alertFleetAttribution(
          new FleetInventoryUnavailableError(
            account.name,
            `could not destroy volume ${volume.volumeId}: ${detail}`,
          ),
        );
        continue;
      }
      await withSystemContext((tx) => fleetMachineKillRepository.markCompleted(row.id, now(), tx));
      result.orphanedVolumesDestroyed += 1;
      console.warn('[fleetAttribution] destroyed a hoster volume', {
        account: account.name,
        volumeId: volume.volumeId,
      });
      alertFleetAttribution(
        new UnattributedVolumeDestroyedError(app, volume.volumeId, ageMs, 'no_record'),
      );
    }
  },

  /** Match ONE machine against the records (§5's table). Reads only. */
  async judge(
    provider: string,
    machine: InventoryMachine,
    now: Date,
    /** The agent-hoster account the machine was listed in (MOTIR-9476): its
     *  instance is found by machine id AND account, never by the Fly app. */
    hosterShardId?: string,
  ): Promise<Verdict> {
    // ── CI runner: an intent names it as its container ──────────────────────
    const intent = await withSystemContext((tx) =>
      intents.findByContainerId(provider, machine.machineId, tx),
    );
    if (intent) {
      const inFlight = CI_RUNNER_INTENT_IN_FLIGHT.includes(intent.status);
      const end = intent.bootedAt
        ? new Date(intent.bootedAt.getTime() + CI_INTENT_END_AFTER_BOOT_MS)
        : null;
      if (inFlight && (!end || now.getTime() < end.getTime())) {
        return { kind: 'attributed', workload: CI_RUNNER };
      }
      const stopped = intent.teardownReason !== null && ORG_STOP_REASONS.has(intent.teardownReason);
      return kill(
        stopped ? 'org_stopped' : 'record_ended',
        inFlight ? end : (intent.settledAt ?? intent.updatedAt),
        {
          workload: CI_RUNNER,
          recordRef: intent.id,
          organizationId: intent.organizationId,
          // An intent still in flight past its end has a container to settle.
          settle: inFlight,
        },
      );
    }

    // ── Hosted-agent run or index container: a checkpoint + an unexpired slot ──
    const usage = await withSystemContext((tx) =>
      ciContainerUsageRepository.findLatestByHandle(provider, machine.machineId, tx),
    );
    if (usage && (usage.workload === 'agent' || usage.workload === 'index')) {
      const workload = usage.workload === 'agent' ? HOSTED_AGENT : CODE_GRAPH_INDEX;
      const recordRef = usage.dispatchRunId ?? usage.id;
      if (usage.containerStoppedAt) {
        return kill('record_ended', usage.containerStoppedAt, {
          workload,
          recordRef,
          organizationId: usage.organizationId,
        });
      }
      const ref =
        workload === HOSTED_AGENT
          ? usage.dispatchRunId
            ? hostedRunDispatchId(usage.dispatchRunId)
            : null
          : usage.projectId && usage.repoFullName
            ? indexSlotRef(usage.projectId, usage.repoFullName)
            : null;
      const slot = ref
        ? await withSystemContext((tx) => fleetInFlightSlotRepository.findByRef(workload, ref, tx))
        : null;
      if (slot && slot.expiresAt.getTime() > now.getTime()) {
        return { kind: 'attributed', workload };
      }
      // The slot expired (its backstop) or is gone: the record has ended. With no
      // slot left to date it by, the checkpoint's own creation is the floor.
      return kill('record_ended', slot?.expiresAt ?? usage.containerCreatedAt, {
        workload,
        recordRef,
        organizationId: usage.organizationId,
        // A hosted run is settled, charged and ended through the port (MOTIR-6524).
        settle: workload === HOSTED_AGENT,
      });
    }

    // ── Agent instance: a record in THIS app names it as its machine ────────
    const instance = await withSystemContext((tx) =>
      hosterShardId
        ? agentInstanceRepository.findByMachineInShard(hosterShardId, machine.machineId, tx)
        : agentInstanceRepository.findByMachine(machine.app, machine.machineId, tx),
    );
    if (instance) {
      const common = {
        workload: AGENT_INSTANCE,
        recordRef: instance.id,
        organizationId: instance.organizationId,
      };
      if (instance.deletedAt) return kill('record_ended', instance.deletedAt, common);
      // A resting record whose machine runs: STOPPED, never destroyed — the
      // record owns a persistent machine and its home volume (§5).
      const resting = instance.state === 'hibernated' || instance.state === 'failed';
      const running = machine.state === 'running' || machine.state === 'starting';
      if (resting && running) {
        return kill('record_ended', instance.stateChangedAt, { ...common, action: 'stopped' });
      }
      return { kind: 'attributed', workload: AGENT_INSTANCE };
    }

    return kill('no_record', null);
  },

  /**
   * Kill ONE machine: record the decision, act on it, alert. Answers whether the
   * provider carried it out; a refusal is recorded on the row, alerted, and left
   * for the next pass to decide again.
   */
  async killMachine(
    inventory: FleetInventory,
    machine: InventoryMachine & { createdAt: Date },
    verdict: Extract<Verdict, { kind: 'kill' }>,
    now: () => Date,
    /** The account the machine was LISTED in; absent = the organisation walk,
     *  where the intent's own recorded account decides (MOTIR-8964). */
    shardId?: string | null,
  ): Promise<boolean> {
    const decidedAt = now();
    const ageMs = decidedAt.getTime() - machine.createdAt.getTime();
    const row = await withSystemContext((tx) =>
      fleetMachineKillRepository.create(
        {
          app: machine.app,
          machineId: machine.machineId,
          machineName: machine.name,
          reason: verdict.reason,
          action: verdict.action,
          workload: verdict.workload,
          recordRef: verdict.recordRef,
          organizationId: verdict.organizationId,
          machineCreatedAt: machine.createdAt,
          ageSeconds: Math.floor(ageMs / 1000),
          decidedAt,
        },
        tx,
      ),
    );

    try {
      if (verdict.action === 'stopped') {
        await inventory.stopMachine(machine.app, machine.machineId);
      } else {
        // A record with a container to settle is torn down THROUGH the port, so
        // its usage row is written and its intent or run ends. The inventory's
        // own destroy follows either way: it is idempotent, and it is the one
        // call addressed to the app the machine was actually listed in.
        if (verdict.settle) {
          await ciRunnerBootService.reapContainer(
            {
              provider: inventory.provider,
              id: machine.machineId,
              region: machine.region,
              createdAt: machine.createdAt,
            },
            shardId === undefined ? { now } : { now, shardId },
          );
        }
        await inventory.destroyMachine(machine.app, machine.machineId);
      }
    } catch (err) {
      const detail = detailOf(err);
      await withSystemContext((tx) => fleetMachineKillRepository.markFailed(row.id, detail, tx));
      alertFleetAttribution(
        new FleetInventoryUnavailableError(
          machine.app,
          `could not ${verdict.action === 'stopped' ? 'stop' : 'destroy'} machine ` +
            `${machine.machineId}: ${detail}`,
        ),
      );
      return false;
    }

    await withSystemContext((tx) => fleetMachineKillRepository.markCompleted(row.id, now(), tx));
    console.warn('[fleetAttribution] killed a machine', {
      app: machine.app,
      machineId: machine.machineId,
      reason: verdict.reason,
      action: verdict.action,
      workload: verdict.workload,
      recordRef: verdict.recordRef,
    });
    alertFleetAttribution(
      new UnattributedMachineDestroyedError(
        machine.app,
        machine.machineId,
        machine.name,
        ageMs,
        verdict.reason,
        verdict.action,
        inventory.provider,
      ),
    );
    return true;
  },
};

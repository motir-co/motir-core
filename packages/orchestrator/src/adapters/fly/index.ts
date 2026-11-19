import {
  exitCodeOf,
  flyFleetConfig,
  flyMachinesClient,
  flyMachinesClientFor,
  isTerminalState,
  startedAtOf,
  stoppedAtOf,
  type FlyMachine,
  type FlyMachinesClient,
} from './flyMachines';
import { OrchestratorApiError, OrchestratorNotConfiguredError } from '../../errors';
import { buildContainerUsage } from '../../usage';
import { sparedByCaller } from '../../reap';
import type { FleetWorkloadKind } from '../../types';
import type {
  ContainerHandle,
  ContainerOrchestrator,
  ContainerSpec,
  ContainerStatus,
  ContainerUsage,
  TeardownReason,
  UsageAttribution,
  ReapSparePredicate,
  UsageAttributionResolver,
} from '../../types';

// The FLY adapter (Story MOTIR-1916 · MOTIR-1921) — `ContainerOrchestrator`
// implemented on Fly Machines, per `docs/decisions/ci-runner-fleet.md` §1.
//
// It is thin ON PURPOSE. Every decision that is not "how do you say this to Fly"
// lives above it: the rate table, the usage arithmetic, the supervision loop, the
// JIT credential. What remains here is translation, and that is the measure of
// whether the port is real — an adapter thick with policy is a port in name only,
// and §3's migration target (B1 · RunsOn) would have to re-implement the policy
// rather than just the translation.

/** The tag every fleet machine carries, and the reaper's recognition key.
 *  Metadata rather than a name convention: a name can be typed by hand in the
 *  Fly console, metadata is what Motir's own code writes. */
export const FLEET_METADATA_KEY = 'motir_fleet';

/**
 * The tag's VALUE, per workload (MOTIR-2025) — it used to be the constant
 * `'ci-runner'`, which was accurate while the fleet had one consumer and became
 * a lie the moment it had two.
 *
 * ⚠️ TOTAL BY CONSTRUCTION, deliberately mirroring `FLEET_WORKLOADS`: adding a
 * member to `FleetWorkloadKind` without giving it a tag is a COMPILE error, not
 * a container that boots tagged as something it is not. An index machine
 * mis-tagged `ci-runner` is unattributable in the Fly console AND indistinguish-
 * able to `reap()`, which is the failure this record exists to make impossible.
 *
 * ⚠️ THE `ci_runner` VALUE IS FROZEN. Machines already running in the fleet app
 * carry `ci-runner`, and `reap()` recognises its own containers by exactly this
 * string — changing it would strand every live machine outside the sweep that
 * exists to stop them billing.
 */
export const FLEET_METADATA_VALUES: Record<FleetWorkloadKind, string> = {
  ci_runner: 'ci-runner',
  code_graph_index: 'code-graph-index',
  hosted_agent: 'hosted-agent',
  agent_instance: 'agent-instance',
};

/** Every tag value the fleet answers to — what makes a machine one of OURS,
 *  whatever it is running. `reap()` sweeps the set, never a single value. */
const FLEET_METADATA_VALUE_SET: ReadonlySet<string> = new Set(Object.values(FLEET_METADATA_VALUES));

/**
 * The name of every Docker volume the adapter creates (MOTIR-8839), and the
 * orphan sweep's recognition key. Fly volume names need not be unique within an
 * app; this one is shared on purpose, so the sweep can find a volume whose id
 * nothing recorded. Fly limits a volume name to 30 lowercase alphanumerics and
 * underscores.
 */
export const CI_DOCKER_VOLUME_NAME = 'motir_ci_docker';

/** Where the volume is mounted: the Docker daemon's data root. */
export const CI_DOCKER_VOLUME_PATH = '/var/lib/docker';

/** How many times teardown asks Fly to delete a volume while the destroyed
 *  machine is still releasing it, and the pause between asks. A volume left after
 *  the last ask is the orphan sweep's. */
export const VOLUME_DESTROY_ATTEMPTS = 10;
export const VOLUME_DESTROY_INTERVAL_MS = 1000;

/** How many times `provision` asks Fly to create the machine when Fly answers
 *  `volume not found` for the volume it created a moment earlier, and the pause
 *  (multiplied by the attempt number) between asks (MOTIR-8941). */
export const MACHINE_CREATE_VOLUME_ATTEMPTS = 4;
export const MACHINE_CREATE_VOLUME_RETRY_MS = 500;

/** Machine metadata naming the intent a container serves, so the reaper can
 *  resolve attribution from the PROVIDER's own record rather than from a Motir
 *  table it may disagree with. */
export const FLEET_METADATA_INTENT_KEY = 'motir_intent_id';

/**
 * The machine-NAME prefix per workload — how a human tells the containers apart
 * in the Fly console, where the metadata is one click further away.
 *
 * `ci_runner`'s is frozen for the same reason its tag is: `motir-runner-<jobId>`
 * is the name the operator runbook, the console and MOTIR-1921's own tests read.
 */
const FLEET_MACHINE_NAME_PREFIXES: Record<FleetWorkloadKind, string> = {
  ci_runner: 'motir-runner',
  code_graph_index: 'motir-index',
  hosted_agent: 'motir-agent',
  agent_instance: 'motir-instance',
};

/** Fly machine names are lower-case alphanumerics and hyphens. */
function slug(value: string, maxLength: number): string {
  // The hyphens are trimmed by scanning, not by `/-+$/`, which backtracks
  // polynomially on a long run of them (CodeQL js/polynomial-redos, MOTIR-7816).
  const hyphenated = trimHyphens(value.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  return trimHyphens(hyphenated.slice(0, maxLength)) || 'x';
}

function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start++;
  while (end > start && value[end - 1] === '-') end--;
  return value.slice(start, end);
}

/** FNV-1a, 32-bit, as 8 hex digits — a stable discriminator for a name whose
 *  readable part has to be truncated. Chosen because the plan loader already
 *  uses FNV-1a for deterministic derivation, not for any cryptographic property. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * A deterministic, attributable machine name — derived from the WORKLOAD, not
 * hardcoded to the runner shape.
 *
 * The property that matters is the one the original comment named: an orphan in
 * the Fly console is traceable to the work it served with no reverse lookup.
 *
 * ⚠️ THE CI NAME IS BYTE-FOR-BYTE WHAT IT WAS. GitHub's job id is the strongest
 * discriminator a container can carry — one job, one container — so it stays the
 * name whenever it exists.
 *
 * A workload with no job id is discriminated by the pair that DOES identify it:
 * the repository and the project. Both go in, the repo readably and the pair as
 * a hash, because a Motir project spans several repositories and a project
 * spans several containers — a name built from either alone would collide, and a
 * Fly machine name has to be unique within the app.
 */
function machineNameFor(spec: ContainerSpec): string {
  const prefix = FLEET_MACHINE_NAME_PREFIXES[spec.workload];
  if (spec.workflowJobId !== null) return `${prefix}-${spec.workflowJobId}`;
  const repo = slug(spec.repoFullName.split('/').pop() ?? spec.repoFullName, 24);
  return `${prefix}-${repo}-${shortHash(`${spec.repoFullName}:${spec.projectId}`)}`;
}

/**
 * Turn a Fly Machine into the port's opaque handle.
 *
 * `createdAt` falls back to now when Fly omits it, because a handle with no
 * creation instant is un-reapable — `reap(olderThan)` compares against exactly
 * this field, and a null would make the container invisible to the one mechanism
 * that exists to catch it.
 */
function toHandle(machine: FlyMachine, fallbackRegion: string): ContainerHandle {
  return {
    provider: 'fly',
    id: machine.id,
    region: machine.region || fallbackRegion,
    createdAt: machine.createdAt ?? new Date(),
  };
}

/** The Docker volumes teardown owns for this container: the handle's, else —
 *  for a CI runner whose handle was rebuilt from a listing — the machine's own
 *  mounts. Another workload's mounts are never touched here. */
function dockerVolumesOf(handle: ContainerHandle, machine: FlyMachine | null): string[] {
  if (handle.volumeId) return [handle.volumeId];
  if (machine?.metadata[FLEET_METADATA_KEY] !== FLEET_METADATA_VALUES.ci_runner) return [];
  return [...(machine.mountedVolumeIds ?? [])];
}

/**
 * Delete a volume, asking up to `attempts` times: Fly refuses while a destroyed
 * machine is still releasing it. Answers whether it is gone. Never throws — a
 * volume left behind is the orphan sweep's, and must not fail the teardown that
 * already stopped the machine billing.
 */
async function destroyVolumeEventually(
  client: FlyMachinesClient,
  volumeId: string,
  attempts: number,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await client.destroyVolume(volumeId);
      return true;
    } catch (err) {
      if (attempt === attempts) {
        console.warn('[flyOrchestrator] could not destroy a CI Docker volume — left to the sweep', {
          volumeId,
          detail: err instanceof Error ? err.message : 'unknown',
        });
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, VOLUME_DESTROY_INTERVAL_MS));
    }
  }
  return false;
}

/** Read the machine, tolerating a provider failure — used only on paths where
 *  the machine is about to be destroyed anyway and a read failure must not stop
 *  that. Returns null both for "gone" and for "could not ask". */
async function readQuietly(client: FlyMachinesClient, id: string): Promise<FlyMachine | null> {
  try {
    return await client.getMachine(id);
  } catch (err) {
    console.warn('[flyOrchestrator] could not read a machine before teardown', {
      machineId: id,
      detail: err instanceof Error ? err.message : 'unknown',
    });
    return null;
  }
}

/** Create the fleet machine for `spec`, mounting the Docker volume when there is
 *  one. Every create goes through here, so the metadata the reaper and the
 *  reconciler recognise is written in exactly one place. */
function createFleetMachine(
  client: FlyMachinesClient,
  spec: ContainerSpec,
  region: string,
  volumeId: string | null,
): Promise<FlyMachine> {
  return client.createMachine({
    // A deterministic, attributable name: an orphan in the Fly console is
    // traceable to the work it served with no reverse lookup, the same property
    // `runnerGroupNameFor` gives a runner group.
    name: machineNameFor(spec),
    region,
    image: spec.image,
    cpuKind: spec.size.cpuKind,
    cpus: spec.size.cpus,
    memoryMb: spec.size.memoryMb,
    env: spec.env,
    metadata: {
      [FLEET_METADATA_KEY]: FLEET_METADATA_VALUES[spec.workload],
      // Only a CI container has an Actions job to name. The key is OMITTED
      // rather than set to a placeholder for a workload that has none: an
      // empty `motir_intent_id` reads, in the console and to anything that
      // greps metadata, as an intent that could not be resolved.
      ...(spec.workflowJobId !== null
        ? { [FLEET_METADATA_INTENT_KEY]: String(spec.workflowJobId) }
        : {}),
      motir_org_id: spec.orgId,
      motir_project_id: spec.projectId,
    },
    ...(volumeId ? { mounts: [{ volume: volumeId, path: CI_DOCKER_VOLUME_PATH }] } : {}),
  });
}

/** Fly answers a machine create with 400 `volume not found` for a volume it
 *  created a moment earlier: the volume is not visible yet. Retried a few times
 *  with a growing pause before the failure is given up on (MOTIR-8941); any other
 *  failure is thrown at once. */
async function createFleetMachineAwaitingVolume(
  client: FlyMachinesClient,
  spec: ContainerSpec,
  region: string,
  volumeId: string | null,
): Promise<FlyMachine> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await createFleetMachine(client, spec, region, volumeId);
    } catch (err) {
      const volumeNotVisibleYet =
        volumeId !== null &&
        err instanceof OrchestratorApiError &&
        err.status === 400 &&
        /volume/i.test(err.message) &&
        /not found/i.test(err.message);
      if (!volumeNotVisibleYet || attempt >= MACHINE_CREATE_VOLUME_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, MACHINE_CREATE_VOLUME_RETRY_MS * attempt));
    }
  }
}

/**
 * The Fly adapter over ONE client (MOTIR-8964): the process-wide one, or an
 * account's. `defaultRegion` is where a spec with no region boots.
 */
function orchestratorOver(
  client: FlyMachinesClient,
  defaultRegion: () => string,
): ContainerOrchestrator {
  return {
    provider: 'fly',

    /**
     * Boot one Machine and return its handle. Does NOT wait for it to start.
     *
     * ⚠️ THE WAIT DELIBERATELY BELONGS TO THE CALLER, and this is the design
     * decision that makes §5's invariant hold. If `provision` waited and threw on a
     * machine that never started, the handle would never reach the caller — and a
     * container that exists but whose handle nobody holds is precisely the untracked
     * container the port forbids, plus a usage row that can never be written.
     * Returning the handle the instant Fly acknowledges the machine means EVERY
     * created machine is tracked from its first moment, and the never-started case
     * is a normal `provision_failed` teardown rather than a leak.
     */
    async provision(spec: ContainerSpec): Promise<ContainerHandle> {
      // Fly boots one machine class, x86 (MOTIR-11782): an arm64 spec is refused
      // before any API call rather than booted as x86.
      if (spec.architecture === 'arm64') {
        throw new OrchestratorNotConfiguredError('the fly orchestrator boots no arm64 machine');
      }
      const region = spec.region || defaultRegion();
      // The Docker volume FIRST, in the machine's region: Fly places a machine on
      // the host that holds the volume it mounts (MOTIR-8839).
      const volume =
        spec.dockerVolumeGb && spec.dockerVolumeGb > 0
          ? await client.createVolume({
              name: CI_DOCKER_VOLUME_NAME,
              region,
              sizeGb: spec.dockerVolumeGb,
            })
          : null;
      let machine: FlyMachine;
      try {
        machine = await createFleetMachineAwaitingVolume(client, spec, region, volume?.id ?? null);
      } catch (err) {
        // No machine, so no handle and no teardown: the volume is deleted here or
        // it is an orphan from its first moment.
        if (volume) await destroyVolumeEventually(client, volume.id, 1);
        throw err;
      }
      const handle = toHandle(machine, region);
      return volume ? { ...handle, volumeId: volume.id } : handle;
    },

    async describe(handle: ContainerHandle): Promise<ContainerStatus> {
      const machine = await client.getMachine(handle.id);
      if (!machine) {
        // GONE is a real answer, and on the happy path it is THE answer:
        // `auto_destroy` means a completed run deletes its own machine.
        return {
          handleId: handle.id,
          exists: false,
          state: 'destroyed',
          terminal: true,
          createdAt: handle.createdAt,
          startedAt: null,
          stoppedAt: null,
          // GONE takes the exit code with it. The consumer has to treat "stopped,
          // code unknown" as its own case, which is why the port documents `null`
          // as an answer rather than as a missing success.
          exitCode: null,
        };
      }
      return {
        handleId: handle.id,
        exists: true,
        state: machine.state,
        terminal: isTerminalState(machine.state),
        createdAt: machine.createdAt ?? handle.createdAt,
        startedAt: startedAtOf(machine),
        stoppedAt: stoppedAtOf(machine),
        exitCode: exitCodeOf(machine),
      };
    },

    /**
     * Destroy the machine and return what it cost. IDEMPOTENT — a second call on a
     * destroyed machine returns a usage row rather than throwing, because the
     * `finally` path and the reaper can both reach the same container.
     *
     * The read happens BEFORE the destroy so the row carries Fly's own event
     * timestamps (§5's provider-attested instants). When the machine is already
     * gone the caller's `observedStartedAt` carries the row instead — see
     * `UsageAttribution`.
     */
    async teardown(
      handle: ContainerHandle,
      reason: TeardownReason,
      context: UsageAttribution,
    ): Promise<ContainerUsage> {
      const machine = await readQuietly(client, handle.id);
      await client.destroyMachine(handle.id);
      // The Docker volume outlives its machine — `auto_destroy` deletes the machine
      // and leaves what it mounted (MOTIR-8839). The handle names it when this
      // adapter booted the container; a handle rebuilt from a listing does not, and
      // then the machine's own mounts do, for a CI runner only.
      for (const volumeId of dockerVolumesOf(handle, machine)) {
        await destroyVolumeEventually(client, volumeId, VOLUME_DESTROY_ATTEMPTS);
      }
      return usageFor(handle, machine, reason, context);
    },

    async sweepOrphanedVolumes(olderThan: Date): Promise<number> {
      let volumes;
      try {
        volumes = await client.listVolumes();
      } catch (err) {
        console.error('[flyOrchestrator] could not list volumes for the orphan sweep', {
          detail: err instanceof Error ? err.message : 'unknown',
        });
        return 0;
      }
      let destroyed = 0;
      for (const volume of volumes) {
        if (volume.name !== CI_DOCKER_VOLUME_NAME || volume.attachedMachineId !== null) continue;
        // An undated volume cannot be aged, and one created a second ago may be
        // about to be mounted by a machine still being created.
        if (!volume.createdAt || volume.createdAt.getTime() >= olderThan.getTime()) continue;
        if (await destroyVolumeEventually(client, volume.id, 1)) {
          destroyed += 1;
          console.warn('[flyOrchestrator] destroyed an orphaned CI Docker volume', {
            volumeId: volume.id,
            createdAt: volume.createdAt.toISOString(),
          });
        }
      }
      return destroyed;
    },

    /**
     * THE CRASH BACKSTOP (§7.1's third guarantee). Destroy every fleet machine
     * older than `olderThan`, whatever Motir's own tables think.
     *
     * It reads the PROVIDER, never in-process state, because the case it exists for
     * — the orchestrator dying between provision and teardown — is exactly the case
     * in which in-process state is the thing that is missing. The intent table is
     * consulted only to ATTRIBUTE what the provider reports, never to decide what
     * exists.
     *
     * A machine with no attribution is still DESTROYED, and loudly logged, but
     * yields no usage row: a cost row attributed to nobody would pollute the meter
     * with spend it cannot assign, which is worse for the reconciliation than a
     * gap it can see in the log. Stopping the fleet from billing is the property
     * that costs money; recording it is the property that costs an entry.
     */
    async reap(
      olderThan: Date,
      resolve: UsageAttributionResolver,
      spare?: ReapSparePredicate,
    ): Promise<ContainerUsage[]> {
      const machines = await client.listMachines();
      const usages: ContainerUsage[] = [];

      for (const machine of machines) {
        // ⚠️ THE WHOLE FLEET, NOT JUST THE RUNNERS. The sweep recognises any tag
        // value the registry declares — an index or agent container leaked by a
        // dead dispatcher bills exactly like a runner does, and a reaper that
        // matched one hardcoded string would walk straight past it.
        if (!FLEET_METADATA_VALUE_SET.has(machine.metadata[FLEET_METADATA_KEY] ?? '')) continue;
        const createdAt = machine.createdAt;
        // A machine with no creation instant cannot be aged, and destroying it on a
        // guess could kill a container that booted a second ago. Report it instead
        // — a fleet machine Fly describes without a `created_at` is a provider
        // anomaly worth seeing, not something to act on blind.
        if (!createdAt) {
          console.warn('[flyOrchestrator] fleet machine has no creation instant — not reaped', {
            machineId: machine.id,
          });
          continue;
        }
        if (createdAt.getTime() >= olderThan.getTime()) continue;

        const handle = toHandle(machine, machine.region);
        if (await sparedByCaller(spare, handle)) continue;
        const attribution = await resolve(handle);
        try {
          await client.destroyMachine(handle.id);
        } catch (err) {
          // One machine's refusal must not abandon the rest of the sweep — the
          // sweep is the last line, and a fleet-wide leak because one destroy
          // 500'd is the failure mode it exists to prevent.
          console.error('[flyOrchestrator] could not reap a fleet machine', {
            machineId: handle.id,
            detail: err instanceof Error ? err.message : 'unknown',
          });
          continue;
        }

        if (!attribution) {
          console.warn('[flyOrchestrator] reaped a fleet machine with no attributable intent', {
            machineId: handle.id,
            createdAt: createdAt.toISOString(),
          });
          continue;
        }
        usages.push(usageFor(handle, machine, 'reaped', attribution));
      }

      return usages;
    },
  };
}

/** The process-wide Fly fleet — `FLY_FLEET_*`, read per call, as always. */
export const flyOrchestrator: ContainerOrchestrator = orchestratorOver(
  flyMachinesClient,
  () => flyFleetConfig().region,
);

/** Where one Fly account's fleet lives: its app, the token that reaches it, and
 *  the region a spec with none boots in. */
export interface FlyAccountConfig {
  readonly token: string;
  readonly app: string;
  readonly region: string;
}

/**
 * A Fly adapter for ONE account (MOTIR-8964), whatever `FLY_FLEET_*` holds —
 * every Machines and Volumes request goes to `/apps/<app>/…` with that token.
 * The package stays account-blind: the composition root turns a row into this.
 */
export function createFlyOrchestrator(config: FlyAccountConfig): ContainerOrchestrator {
  return orchestratorOver(flyMachinesClientFor(config), () => config.region);
}

/**
 * Build the §5 record from whatever the provider was still able to tell us.
 * Call it only once the machine has been destroyed: the row says so.
 *
 * The precedence is deliberate and stated once here rather than at three call
 * sites: Fly's own event timestamps WIN (they are provider-attested and measure
 * Fly's boot, not our polling), the caller's observation is the FALLBACK for the
 * self-destroyed happy path, and `stoppedAt` falls back to now — the instant we
 * destroyed it, which is the truthful answer when the provider no longer has one.
 */
function usageFor(
  handle: ContainerHandle,
  machine: FlyMachine | null,
  reason: TeardownReason,
  context: UsageAttribution,
): ContainerUsage {
  const providerStartedAt = machine ? startedAtOf(machine) : null;
  const providerStoppedAt = machine ? stoppedAtOf(machine) : null;
  return buildContainerUsage({
    handle,
    attribution: context,
    reason,
    lifecycle: {
      createdAt: machine?.createdAt ?? handle.createdAt,
      startedAt: providerStartedAt ?? context.observedStartedAt,
      stoppedAt: providerStoppedAt ?? new Date(),
      // Every caller reaches here only AFTER `destroyMachine` returned, so the
      // settled row is `destroyed` whatever Fly reported at the pre-destroy read
      // (`stopped`, `destroying`) — that read exists for the timestamps, not for
      // the terminal state (MOTIR-8912).
      terminalState: 'destroyed',
    },
  });
}

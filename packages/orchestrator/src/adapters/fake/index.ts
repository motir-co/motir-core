import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildContainerUsage } from '../../usage';
import { sparedByCaller } from '../../reap';
import {
  OrchestratorApiError,
  OrchestratorCapacityError,
  type OrchestratorCapacityReason,
} from '../../errors';
import type {
  ContainerHandle,
  ContainerOrchestrator,
  ContainerArchitecture,
  ContainerSpec,
  ContainerStatus,
  ContainerUsage,
  TeardownReason,
  UsageAttribution,
  ReapSparePredicate,
  UsageAttributionResolver,
} from '../../types';

// The FAKE adapter (Story MOTIR-1916 · MOTIR-1921) — `docs/decisions/
// ci-runner-fleet.md` §4, rule 2:
//
//   > A `fake` adapter ships alongside the Fly one, IN THE SAME PR as
//   > MOTIR-1921. It is what MOTIR-1927's Vitest gate drives — the boot /
//   > teardown / no-reuse / label-scoping guards are assertions about the PORT's
//   > contract, not about Fly.
//
// ⚠️ IT IS NOT A TEST FIXTURE, and shipping it here rather than in `tests/` is
// the point the card makes twice. A port with one implementation has never been
// shown to be a port: the second implementation is the evidence, and the moment
// it lives under `tests/` it stops constraining production code and starts
// tracking it. It is also what lets MOTIR-1927 assert the guarantees that are
// invisible to coverage — "a handle that reached `job_completed` is never
// provisioned again" is a statement about the PORT, and there is no way to make
// it against Fly without booting real machines.
//
// It is a MODULE SINGLETON with a control surface, mirroring how this repo
// already fakes GitHub (`tests/helpers/runnerGroupFake.ts` is stateful for the
// same reason): the interesting assertions are about END STATE after a sequence
// of operations — "exactly one usage row per handle", "the container is gone on
// every failure path" — and a per-call spy cannot see those. `reset()` between
// tests is the price.

/** One container as the fake holds it. */
interface FakeMachine {
  handle: ContainerHandle;
  spec: ContainerSpec;
  state: string;
  createdAt: Date;
  startedAt: Date | null;
  stoppedAt: Date | null;
  /** What the container's own process exited with, once it has. Null while it is
   *  still running, and null for a container that stopped without one being
   *  observable — the port's "stopped, code unknown". */
  exitCode: number | null;
  /** True once the container self-destroyed (the `auto_destroy` happy path). */
  gone: boolean;
}

/** What a newly provisioned container does next, so a test can drive the failure
 *  paths the card requires one test each for. */
export type FakeBootBehaviour =
  /** Boots and reaches `started` immediately — the happy path. */
  | 'start'
  /** Created, but never starts: the "boot succeeded, the runner never
   *  registered" path. */
  | 'never_start'
  /** Starts and then runs forever: the "hung past the timeout" path. */
  | 'hang';

export interface FakeOrchestratorControls {
  /** Forget every container and every arranged failure. Call in `beforeEach`. */
  reset(): void;
  /** What the NEXT provisioned container does. Persists until changed. */
  setBootBehaviour(behaviour: FakeBootBehaviour): void;
  /** Make the next `provision` throw — the "the provider refused" path. */
  failNextProvision(detail?: string): void;
  /** Make the next `provision` throw `OrchestratorCapacityError` — the "the
   *  provider is full" path (MOTIR-8973). Leaves no container, like any refusal. */
  failNextProvisionForCapacity(reason: OrchestratorCapacityReason, zone?: string | null): void;
  /** Make the next `teardown` throw — used to prove the caller still records the
   *  failure rather than losing the container silently. */
  failNextTeardown(detail?: string): void;
  /**
   * Simulate the job finishing: the runner exits and `auto_destroy` deletes the
   * machine, so a later `describe` reports it GONE — the happy path, and the one
   * that proves teardown works without a machine to read.
   *
   * `exitCode` is what the container's own process returned (MOTIR-2025). It
   * defaults to `null` — "stopped, code unknown" — because that is the honest
   * default for a machine that deleted itself, and because defaulting to `0`
   * would let a consumer that forgot to handle the unknown case pass its tests
   * by reading a success Motir never observed. Pass a number to drive the
   * indexer's taxonomy (`30` BUILD, `50` CREDENTIAL_REFUSED, `137` OOM).
   */
  completeJob(handleId: string, options?: { exitCode?: number | null }): void;
  /** Pretend this container was created earlier, so `reap(olderThan)` sees it. */
  backdate(handleId: string, createdAt: Date): void;
  /** Every container the fake has ever been asked to boot, in order. */
  readonly provisioned: ContainerHandle[];
  /** Every `provision` call's spec — how a test asserts what was ASKED for (the
   *  image, the size, the single label in the JIT env, the region). */
  readonly specs: ContainerSpec[];
  /** The architecture each `provision` call ASKED for, in order (MOTIR-11782) —
   *  an absent `architecture` read as the port's default, `x86_64`. */
  architectures(): ContainerArchitecture[];
  /** Containers that still exist on the "provider" — the leak assertion. A test
   *  that ends with this non-empty has found a container the code did not
   *  destroy, which is the failure this whole card is about. */
  liveContainerIds(): string[];
  /** Every container still on the "provider", as the inventory lists it
   *  (MOTIR-6925) — the fake fleet app's machines. */
  inventoryMachines(): Array<{
    id: string;
    name: string;
    region: string;
    state: string;
    createdAt: Date;
  }>;
  /** Destroy a container WITHOUT a teardown — what the reconciler's destroy does
   *  to a machine no record owns. Idempotent. */
  destroyOutsideTeardown(handleId: string): void;
  /** Every teardown, with the reason — how a test asserts the failure PATH taken,
   *  not merely that something was destroyed. */
  readonly teardowns: Array<{ handleId: string; reason: TeardownReason }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ THE CROSS-PROCESS *CONTAINER* SEAM (Story MOTIR-3778 · MOTIR-3828)
// ═══════════════════════════════════════════════════════════════════════════
// `MOTIR_FAKE_CONTAINER_AUTO_EXIT_CODE` below is a way to drive the fake from
// OUTSIDE its own process. This is the other half: a way for a container to
// OUTLIVE its own process.
//
// ⚠️ IT IS NOT A CONVENIENCE — WITHOUT IT THE FAKE CANNOT EXPRESS THE PROPERTY
// THE FLEET IS BUILT ON. `docs/decisions/job-queue-foundation.md` §13 keeps the
// BOOT inside a memoized step for one reason: *"a supervisor that forgets it
// BOOTED provisions a SECOND billed container"* — so a container must survive
// the supervisor that provisioned it, and a resumed pass must re-attach to it.
// While a supervision was a `while` loop inside ONE run, boot and first poll
// were always the same pass in the same process, and a module-level `Map` was
// indistinguishable from a real provider. §16 makes a supervision a state
// machine over RUNS: the pass that boots and the pass that polls are DIFFERENT
// worker processes by design, and an in-memory map then reports a perfectly
// healthy container as `exists: false` — which `pollIndexContainer` correctly
// classifies `never_started`.
//
// So a fake that cannot outlive its process cannot verify re-attachment at all,
// and would instead assert the opposite of the port's contract. The fix belongs
// HERE rather than in the spec, for the reason this file's own header gives one
// level up: the fake is the second implementation that shows the port is a
// port, and a port that cannot express "the container is still there" is not
// modelling the thing Fly does.
//
// OPT-IN and file-backed: absent the variable this is byte-for-byte the
// in-memory singleton every vitest suite drives, `reset()` and all. It is set
// only in the E2E lane's worker env, which is the one process pair that needs
// it.
const STATE_PATH_ENV = 'MOTIR_FAKE_CONTAINER_STATE_PATH';

interface PersistedMachine extends Omit<FakeMachine, 'createdAt' | 'startedAt' | 'stoppedAt'> {
  createdAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
}

function statePath(): string | null {
  const raw = process.env[STATE_PATH_ENV];
  return raw !== undefined && raw !== '' ? raw : null;
}

export interface FakeOrchestratorOptions {
  /** The id prefix — `fake-machine` unless a test wants each account's fake to
   *  name its containers apart. */
  readonly idPrefix?: string;
  /** Whether the cross-process store seam applies. Only the module singleton
   *  takes it: a fake built per account (MOTIR-8964) is in-memory only. */
  readonly shareAcrossProcesses?: boolean;
}

/**
 * A fake with its OWN state (MOTIR-8964) — one per fleet account, so a test can
 * show WHICH account received a provision. The module singleton below is one of
 * these, and every existing suite keeps driving that one.
 */
export function createFakeOrchestrator(
  options: FakeOrchestratorOptions = {},
): ContainerOrchestrator & FakeOrchestratorControls {
  const idPrefix = options.idPrefix ?? 'fake-machine';
  const sharedPath = (): string | null => (options.shareAcrossProcesses ? statePath() : null);

  const machines = new Map<string, FakeMachine>();
  /** Usage rows already produced, so a second teardown returns the SAME row rather
   *  than a second one — the port's idempotency clause, honoured literally. */
  const usageByHandle = new Map<string, ContainerUsage>();
  const provisioned: ContainerHandle[] = [];
  const specs: ContainerSpec[] = [];
  const teardowns: Array<{ handleId: string; reason: TeardownReason }> = [];

  let behaviour: FakeBootBehaviour = 'start';
  let nextProvisionFailure: string | null = null;
  let nextCapacityRefusal: { reason: OrchestratorCapacityReason; zone: string | null } | null =
    null;
  let nextTeardownFailure: string | null = null;
  let sequence = 0;

  /** Read the shared file over this process's map. A no-op when the seam is off. */
  function loadShared(): void {
    const path = sharedPath();
    if (!path || !existsSync(path)) return;
    let parsed: Record<string, PersistedMachine>;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, PersistedMachine>;
    } catch {
      // A half-written file is a torn read, not a corrupt fake: the next write
      // replaces it. Keeping what this process already has is strictly better
      // than throwing inside a provider call.
      return;
    }
    machines.clear();
    for (const [id, m] of Object.entries(parsed)) {
      machines.set(id, {
        ...m,
        handle: { ...m.handle, createdAt: new Date(m.handle.createdAt) },
        createdAt: new Date(m.createdAt),
        startedAt: m.startedAt ? new Date(m.startedAt) : null,
        stoppedAt: m.stoppedAt ? new Date(m.stoppedAt) : null,
      });
    }
  }

  /** Write this process's map to the shared file. A no-op when the seam is off. */
  function saveShared(): void {
    const path = sharedPath();
    if (!path) return;
    const out: Record<string, PersistedMachine> = {};
    for (const [id, m] of machines) {
      out[id] = {
        ...m,
        handle: { ...m.handle, createdAt: m.handle.createdAt.toISOString() },
        createdAt: m.createdAt.toISOString(),
        startedAt: m.startedAt ? m.startedAt.toISOString() : null,
        stoppedAt: m.stoppedAt ? m.stoppedAt.toISOString() : null,
      } as unknown as PersistedMachine;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(out), 'utf8');
  }

  function nextId(): string {
    sequence += 1;
    // ⚠️ THE ID MUST BE UNIQUE ACROSS PROCESSES when the shared store is on, or a
    // restarted worker's first provision would collide with the previous one's —
    // `sequence` restarts at 0 in a fresh process. The suffix is added ONLY under
    // the seam so every existing suite keeps the stable `fake-machine-1` ids its
    // assertions read.
    return sharedPath() ? `${idPrefix}-${process.pid}-${sequence}` : `${idPrefix}-${sequence}`;
  }

  const fake: ContainerOrchestrator & FakeOrchestratorControls = {
    provider: 'fake',

    // ── controls ──────────────────────────────────────────────────────────────

    provisioned,
    specs,
    teardowns,

    architectures() {
      return specs.map((spec) => spec.architecture ?? 'x86_64');
    },

    reset() {
      machines.clear();
      // The shared file goes with the map, so a lane that resets between specs
      // does not inherit a previous spec's containers through the seam.
      saveShared();
      usageByHandle.clear();
      provisioned.length = 0;
      specs.length = 0;
      teardowns.length = 0;
      behaviour = 'start';
      nextProvisionFailure = null;
      nextCapacityRefusal = null;
      nextTeardownFailure = null;
      sequence = 0;
    },

    setBootBehaviour(next) {
      behaviour = next;
    },

    failNextProvision(detail = 'the fake refused to provision') {
      nextProvisionFailure = detail;
    },

    failNextProvisionForCapacity(reason, zone = null) {
      nextCapacityRefusal = { reason, zone };
    },

    failNextTeardown(detail = 'the fake refused to tear down') {
      nextTeardownFailure = detail;
    },

    completeJob(handleId, options = {}) {
      loadShared();
      const machine = machines.get(handleId);
      if (!machine) throw new Error(`fake orchestrator has no container ${handleId}`);
      machine.state = 'destroyed';
      machine.stoppedAt = new Date();
      machine.exitCode = options.exitCode ?? null;
      // `auto_destroy: true` — the machine deletes ITSELF, so the provider no
      // longer has it. This is what makes the happy path the hardest case for
      // metering, and the reason `UsageAttribution.observedStartedAt` exists.
      machine.gone = true;
      saveShared();
    },

    backdate(handleId, createdAt) {
      loadShared();
      const machine = machines.get(handleId);
      if (!machine) throw new Error(`fake orchestrator has no container ${handleId}`);
      machine.createdAt = createdAt;
      machine.handle = { ...machine.handle, createdAt };
      saveShared();
    },

    liveContainerIds() {
      loadShared();
      return [...machines.values()].filter((m) => !m.gone).map((m) => m.handle.id);
    },

    inventoryMachines() {
      loadShared();
      return [...machines.values()]
        .filter((m) => !m.gone)
        .map((m) => ({
          id: m.handle.id,
          name: `fake-${m.spec.workload}-${m.handle.id}`,
          region: m.handle.region,
          state: m.state,
          createdAt: m.createdAt,
        }));
    },

    destroyOutsideTeardown(handleId) {
      loadShared();
      const machine = machines.get(handleId);
      if (!machine || machine.gone) return;
      machine.gone = true;
      machine.state = 'destroyed';
      machine.stoppedAt = new Date();
      saveShared();
    },

    // ── the port ──────────────────────────────────────────────────────────────

    async provision(spec: ContainerSpec): Promise<ContainerHandle> {
      specs.push(spec);
      if (nextProvisionFailure !== null) {
        const detail = nextProvisionFailure;
        nextProvisionFailure = null;
        // Nothing is recorded: a provision that throws must leave NO container, so
        // there is nothing for `liveContainerIds()` to report and nothing to reap.
        throw new OrchestratorApiError('fake', 500, detail);
      }
      if (nextCapacityRefusal !== null) {
        const { reason, zone } = nextCapacityRefusal;
        nextCapacityRefusal = null;
        throw new OrchestratorCapacityError('fake', null, reason, zone, `fake_${reason}`);
      }

      const createdAt = new Date();
      const id = nextId();
      const handle: ContainerHandle = {
        provider: 'fake',
        id,
        region: spec.region,
        createdAt,
        // The Fly adapter's Docker volume (MOTIR-8839), named so a test can see a
        // spec that asked for one got one. The fake keeps no volume of its own.
        ...(spec.dockerVolumeGb && spec.dockerVolumeGb > 0 ? { volumeId: `${id}-docker` } : {}),
      };
      machines.set(handle.id, {
        handle,
        spec,
        state: behaviour === 'never_start' ? 'created' : 'started',
        createdAt,
        startedAt: behaviour === 'never_start' ? null : createdAt,
        stoppedAt: null,
        exitCode: null,
        gone: false,
      });
      provisioned.push(handle);
      saveShared();
      return handle;
    },

    async describe(handle: ContainerHandle): Promise<ContainerStatus> {
      // ⚠️ THE READ THAT MAKES RE-ATTACHMENT EXPRESSIBLE. Under the shared-store
      // seam this is how a pass running in a DIFFERENT worker process than the one
      // that provisioned still sees the container — see the seam's block above.
      loadShared();
      const machine = machines.get(handle.id);
      // ⚠️ THE CROSS-PROCESS EXIT SEAM (Story MOTIR-3417 · MOTIR-3564).
      //
      // `completeJob()` is how a test says "the runner exited and `auto_destroy`
      // took the machine", and it is an in-process call. That is enough for every
      // vitest suite and reaches nothing in the E2E lane: there the supervisor runs
      // in the WORKER, a separate Node process, so the Playwright runner has no
      // handle to complete. Without a second door the lane's container never exits,
      // supervision polls until `indexTimeoutMs` (30 minutes), and no spec can
      // assert the ledger contract the whole index path exists to produce.
      //
      // So a container ALSO exits when the process is told what its containers
      // should do: `MOTIR_FAKE_CONTAINER_AUTO_EXIT_CODE` makes the first `describe`
      // that sees a STARTED machine report it gone with that code. It is read here
      // rather than at boot so a lane can set it per process, and it is absent
      // everywhere except that worker — every existing consumer keeps the
      // `completeJob`-driven behaviour unchanged.
      //
      // It does NOT replace the orchestrator (MOTIR-3564's scope forbids that, and
      // rightly): this IS the fake, selected by the shipped `MOTIR_FLEET_ORCHESTRATOR`
      // config seam. What it adds is a way to drive the fake from outside its own
      // process, which is the one thing `completeJob` structurally cannot do.
      if (machine && !machine.gone && machine.state === 'started') {
        const auto = process.env['MOTIR_FAKE_CONTAINER_AUTO_EXIT_CODE'];
        if (auto !== undefined && auto !== '') {
          const parsed = Number(auto);
          fake.completeJob(handle.id, {
            exitCode: Number.isFinite(parsed) ? parsed : null,
          });
        }
      }
      if (!machine || machine.gone) {
        return {
          handleId: handle.id,
          exists: false,
          state: 'destroyed',
          terminal: true,
          createdAt: machine?.createdAt ?? handle.createdAt,
          startedAt: machine?.startedAt ?? null,
          stoppedAt: machine?.stoppedAt ?? null,
          // ⚠️ THE FAKE STILL REPORTS THE CODE OF A CONTAINER THAT IS GONE, and it
          // has to: `exists: false` is the happy path for `auto_destroy`, so a
          // fake that dropped the code there could not exercise the ONE case the
          // index dispatcher is built around — a machine that ran, exited 30, and
          // deleted itself. A container the fake never held reports null, which is
          // the genuinely-unobservable case.
          exitCode: machine?.exitCode ?? null,
        };
      }
      return {
        handleId: handle.id,
        exists: true,
        state: machine.state,
        // A `hang` never becomes terminal — that is the whole point of the
        // behaviour: only the caller's timeout ends it.
        terminal: false,
        createdAt: machine.createdAt,
        startedAt: machine.startedAt,
        stoppedAt: machine.stoppedAt,
        exitCode: machine.exitCode,
      };
    },

    async teardown(
      handle: ContainerHandle,
      reason: TeardownReason,
      context: UsageAttribution,
    ): Promise<ContainerUsage> {
      if (nextTeardownFailure !== null) {
        const detail = nextTeardownFailure;
        nextTeardownFailure = null;
        throw new OrchestratorApiError('fake', 500, detail);
      }

      teardowns.push({ handleId: handle.id, reason });
      // ⚠️ AND THE TEARDOWN READS THE SHARED STORE TOO, so the pass that settles a
      // container the previous worker booted still sees its lifecycle — which is
      // what `buildContainerUsage` meters from. Without it the usage row would be
      // built from the handle alone and lose the observed start.
      loadShared();

      // IDEMPOTENT, literally: the second call returns the row the first produced.
      // Both the `finally` path and the reaper can reach the same container, and a
      // second row would break §5's "exactly one usage row per provisioned handle"
      // just as surely as none would.
      const existing = usageByHandle.get(handle.id);
      if (existing) return existing;

      const machine = machines.get(handle.id);
      const stoppedAt = machine?.stoppedAt ?? new Date();
      const usage = buildContainerUsage({
        handle,
        attribution: context,
        reason,
        lifecycle: {
          createdAt: machine?.createdAt ?? handle.createdAt,
          startedAt: machine?.startedAt ?? context.observedStartedAt,
          stoppedAt,
          terminalState: machine ? 'destroyed' : 'destroyed',
        },
      });
      if (machine) {
        machine.gone = true;
        machine.state = 'destroyed';
        machine.stoppedAt = stoppedAt;
      }
      usageByHandle.set(handle.id, usage);
      saveShared();
      return usage;
    },

    async reap(
      olderThan: Date,
      resolve: UsageAttributionResolver,
      spare?: ReapSparePredicate,
    ): Promise<ContainerUsage[]> {
      loadShared();
      const usages: ContainerUsage[] = [];
      for (const machine of [...machines.values()]) {
        if (machine.gone) continue;
        if (machine.createdAt.getTime() >= olderThan.getTime()) continue;
        if (await sparedByCaller(spare, machine.handle)) continue;
        const attribution = await resolve(machine.handle);
        if (!attribution) {
          // Destroyed anyway — an orphan Motir cannot attribute is still an orphan
          // that bills. It yields no usage row; see the Fly adapter for why that is
          // the honest answer rather than a row attributed to nobody.
          machine.gone = true;
          machine.state = 'destroyed';
          continue;
        }
        usages.push(await this.teardown(machine.handle, 'reaped', attribution));
      }
      return usages;
    },
  };

  return fake;
}

export const fakeOrchestrator = createFakeOrchestrator({ shareAcrossProcesses: true });

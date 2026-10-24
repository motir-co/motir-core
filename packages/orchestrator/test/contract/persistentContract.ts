import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  OrchestratorApiError,
  type PersistentContainerHandle,
  type PersistentContainerOrchestrator,
  type PersistentContainerSpec,
} from '../../src/index';

// THE PERSISTENT PORT'S CONTRACT, written once and run against every adapter
// (MOTIR-9467) — the persistent half's twin of `./orchestratorContract.ts`.
//
// ⚠️ THIS FILE NAMES NO ADAPTER. Every statement below is a guarantee of the
// `PersistentContainerOrchestrator` port, reached only through
// `PersistentContractHarness`. An adapter joins by writing a harness and one
// `describePersistentContract(...)` call; it never gets its own copy of these
// assertions. The last case reads this file to keep it that way.
//
// THE GUARANTEES (the port's own comments in `src/types.ts`):
//   1. `provisionPersistent` answers a handle carrying the adapter's provider,
//      with an app, a machine, a volume and a region, and boots ONE machine on
//      ONE volume.
//   2. It NEVER leaves an untracked volume: a machine create that fails after
//      the volume exists destroys the volume before it throws.
//   3. Every operation is IDEMPOTENT on its end state: stopping a stopped
//      machine, starting a running one, destroying a destroyed one and reading a
//      gone one are answers, never throws.
//   4. A stopped machine is a RESTING state (`stopped`, never `gone` or
//      `failed`), and its volume stays.
//   5. `describePersistent` reports the CURRENT run's start — the latest, never
//      the first — and no stop while it runs; its events are oldest first.
//   6. A machine that is gone (destroyed, or never provisioned) describes as
//      `gone`.
//   7. `exec` returns a RESULT for a non-zero exit, and delivers `stdin` to the
//      command's standard input.
//   8. `checkLiveness` never throws: a non-zero exit, a timeout and an
//      unreachable machine are answers.
//   9. `destroyPersistent` destroys the machine, THEN the volume; a machine
//      already gone still has its volume taken.
//  10. `listPersistent` names every machine (with its instance id from its own
//      metadata, null for a machine made by hand) and every volume of one app,
//      and an app that does not exist is empty.
//  11. `destroyMachine` / `destroyVolume` take exactly the id they are given,
//      idempotently.
//
// DIVERGENCES FOUND between the two adapters, after reading both, and why the
// suite asserts only the common part:
//   - `exec` on a machine that is not running: the fake refuses it itself (412);
//     Fly forwards the call and answers whatever the Machines API says. The
//     suite only execs a running machine.
//   - `checkLiveness` with no arranged command answer: the fake answers alive
//     for a running machine without running anything (it never reaches a binary);
//     Fly runs the command. The suite always arranges the command's answer.
//   - `destroyPersistent` against a machine that will not release its volume:
//     Fly polls and then throws; the fake has no such state. Not a contract case.
//   - The events a stop writes: the fake records a stop and an exit; Fly records
//     what the Machines API reports. The suite asserts only the order and the
//     current run's instants.
//
// NOT CONTRACT CASES, on purpose: `ensureMachineConfig`, `moveImage` and
// `terminalEndpoint`. Their guarantees are provider-shaped — a machine-config
// stamp in Fly metadata, a `fly-force-instance-id` routing header, an update
// that must re-send Fly's whole config — so they stay in each adapter's own test
// file, and an AWS adapter states its own equivalents in its own tests.
//
// A capacity refusal on `provisionPersistent` is not here either: the card that
// consumes `OrchestratorCapacityError` for agent instances adds it.

/** What the next `exec` on the machine does. */
export interface PersistentExecBehaviour {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  /** The command outlives its timeout: the provider answers that it timed out. */
  readonly hangs?: boolean;
  /** The machine cannot be reached at all. */
  readonly unreachable?: boolean;
}

/** One command as it reached the machine — after any transport wrapping is undone. */
export interface PersistentExecRecord {
  readonly machineId: string;
  readonly command: readonly string[];
  readonly stdin?: string;
}

export interface PersistentContractHarness {
  /** The adapter under test. */
  readonly orchestrator: PersistentContainerOrchestrator;
  /** Forget every app, machine, volume and arrangement. Runs before every case. */
  reset(): void;
  /** A valid spec for this adapter, with `overrides` applied. */
  spec(overrides?: Partial<PersistentContainerSpec>): PersistentContainerSpec;
  /** Move the provider's clock forward — every instant it stamps is read from it. */
  advance(ms: number): void;
  /** The next machine create fails AFTER its volume was created. */
  failNextMachineCreate(): void;
  /** Every later `exec` behaves as `behaviour` says, until it is set again. */
  setExecBehaviour(behaviour: PersistentExecBehaviour): void;
  /** The commands that reached a machine, in order. */
  execs(): PersistentExecRecord[];
  /** The machine vanished outside Motir (a console, a lost host); its volume stays. */
  destroyOutOfBand(handle: PersistentContainerHandle, options?: { machine?: boolean }): void;
  /** A machine made by hand in `app`, with no instance metadata. Answers its id. */
  addUntrackedMachine(app: string): string;
  /** Machines still on the provider in `app`. */
  liveMachineIds(app: string): string[];
  /** Volumes still on the provider in `app`. */
  liveVolumeIds(app: string): string[];
  /** Provider-side destroys, in order: `machine:<id>` and `volume:<id>`. */
  operationLog(): string[];
}

const MINUTE_MS = 60_000;
const LIVENESS = ['agent', '--version'];

export function describePersistentContract(
  name: string,
  makeHarness: () => PersistentContractHarness,
): void {
  describe(`the PersistentContainerOrchestrator contract — ${name}`, () => {
    const harness = makeHarness();
    const { orchestrator } = harness;

    beforeEach(() => {
      harness.reset();
    });

    async function provisioned(overrides: Partial<PersistentContainerSpec> = {}) {
      return orchestrator.provisionPersistent(harness.spec(overrides));
    }

    it('1 · provisions one machine on one volume, behind a handle carrying the provider', async () => {
      const handle = await provisioned();
      expect(handle.provider).toBe(orchestrator.provider);
      expect(handle.app).toEqual(expect.any(String));
      expect(handle.machineId).toEqual(expect.any(String));
      expect(handle.volumeId).toEqual(expect.any(String));
      expect(handle.region).toBe(harness.spec().region);
      expect((await orchestrator.describePersistent(handle)).state).toBe('running');
      expect(harness.liveMachineIds(handle.app)).toEqual([handle.machineId]);
      expect(harness.liveVolumeIds(handle.app)).toEqual([handle.volumeId]);
    });

    it('2 · a machine create that fails after the volume exists throws and leaves no volume', async () => {
      harness.failNextMachineCreate();
      const spec = harness.spec();
      await expect(orchestrator.provisionPersistent(spec)).rejects.toBeInstanceOf(
        OrchestratorApiError,
      );
      const app = orchestrator.appNameFor(spec.orgId);
      expect(harness.liveVolumeIds(app)).toEqual([]);
      expect(harness.liveMachineIds(app)).toEqual([]);
    });

    it('3 · stop keeps the volume, and a second stop changes nothing', async () => {
      const handle = await provisioned();
      await orchestrator.stop(handle);
      const first = await orchestrator.describePersistent(handle);
      expect(first.state).toBe('stopped');
      expect(harness.liveVolumeIds(handle.app)).toEqual([handle.volumeId]);
      await expect(orchestrator.stop(handle)).resolves.toBeUndefined();
      const second = await orchestrator.describePersistent(handle);
      expect(second.state).toBe('stopped');
      expect(second.startedAt).toEqual(first.startedAt);
    });

    it('4 · start wakes a stopped machine and is an answer on a running one, the volume unchanged', async () => {
      const handle = await provisioned();
      await orchestrator.stop(handle);
      await orchestrator.start(handle);
      expect((await orchestrator.describePersistent(handle)).state).toBe('running');
      await expect(orchestrator.start(handle)).resolves.toBeUndefined();
      expect((await orchestrator.describePersistent(handle)).state).toBe('running');
      expect(harness.liveVolumeIds(handle.app)).toEqual([handle.volumeId]);
    });

    it('5 · describes the CURRENT run: after stop, start, stop, start the start is the second one', async () => {
      const handle = await provisioned();
      harness.advance(MINUTE_MS);
      await orchestrator.stop(handle);
      harness.advance(MINUTE_MS);
      await orchestrator.start(handle);
      const firstRun = (await orchestrator.describePersistent(handle)).startedAt;
      harness.advance(MINUTE_MS);
      await orchestrator.stop(handle);
      harness.advance(MINUTE_MS);
      await orchestrator.start(handle);
      const status = await orchestrator.describePersistent(handle);
      expect(status.state).toBe('running');
      expect(status.startedAt).not.toBeNull();
      expect(firstRun).not.toBeNull();
      expect(status.startedAt!.getTime()).toBeGreaterThan(firstRun!.getTime());
      expect(status.stoppedAt).toBeNull();
      const instants = status.events.map((e) => e.at.getTime());
      expect(instants).toEqual([...instants].sort((a, b) => a - b));
      expect(status.events.at(-1)?.at.getTime()).toBe(status.startedAt!.getTime());
    });

    it('6 · a stopped machine is stopped — not gone, not failed — with its stop at or after its start', async () => {
      const handle = await provisioned();
      harness.advance(MINUTE_MS);
      await orchestrator.stop(handle);
      const status = await orchestrator.describePersistent(handle);
      expect(status.state).toBe('stopped');
      expect(status.startedAt).not.toBeNull();
      expect(status.stoppedAt).not.toBeNull();
      expect(status.stoppedAt!.getTime()).toBeGreaterThanOrEqual(status.startedAt!.getTime());
    });

    it('7 · a destroyed machine, and a handle never provisioned, describe as gone without a throw', async () => {
      const handle = await provisioned();
      await orchestrator.destroyPersistent(handle);
      expect((await orchestrator.describePersistent(handle)).state).toBe('gone');
      const stranger: PersistentContainerHandle = {
        ...handle,
        machineId: 'never-provisioned',
        volumeId: 'never-provisioned-volume',
      };
      const status = await orchestrator.describePersistent(stranger);
      expect(status.state).toBe('gone');
      expect(status.events).toEqual([]);
    });

    it('8 · exec returns a non-zero exit as a result, and delivers stdin to the command', async () => {
      const handle = await provisioned();
      harness.setExecBehaviour({ exitCode: 3, stdout: 'partial', stderr: 'boom' });
      const result = await orchestrator.exec(handle, ['git', 'clone', 'x']);
      expect(result).toEqual({ exitCode: 3, stdout: 'partial', stderr: 'boom' });

      harness.setExecBehaviour({ exitCode: 0, stdout: 'ok' });
      await orchestrator.exec(handle, ['motir', 'launch'], { stdin: 'secret-token' });
      const last = harness.execs().at(-1);
      expect(last).toMatchObject({ machineId: handle.machineId, stdin: 'secret-token' });
      expect(last?.command).toEqual(['motir', 'launch']);
    });

    it('9 · checkLiveness answers exit, timeout and unreachable, and alive for exit 0 — never a throw', async () => {
      const handle = await provisioned();
      harness.setExecBehaviour({ exitCode: 127, stderr: 'agent: not found' });
      expect(await orchestrator.checkLiveness(handle, LIVENESS)).toMatchObject({
        alive: false,
        reason: 'exit',
        exitCode: 127,
      });
      harness.setExecBehaviour({ hangs: true });
      expect(
        await orchestrator.checkLiveness(handle, LIVENESS, { timeoutSeconds: 5 }),
      ).toMatchObject({ alive: false, reason: 'timeout' });
      harness.setExecBehaviour({ unreachable: true });
      expect(await orchestrator.checkLiveness(handle, LIVENESS)).toMatchObject({
        alive: false,
        reason: 'unreachable',
      });
      harness.setExecBehaviour({ exitCode: 0 });
      expect(await orchestrator.checkLiveness(handle, LIVENESS)).toEqual({ alive: true });
    });

    it('10 · destroyPersistent takes the machine, THEN the volume', async () => {
      const handle = await provisioned();
      await orchestrator.destroyPersistent(handle);
      expect(harness.operationLog()).toEqual([
        `machine:${handle.machineId}`,
        `volume:${handle.volumeId}`,
      ]);
      expect(harness.liveMachineIds(handle.app)).toEqual([]);
      expect(harness.liveVolumeIds(handle.app)).toEqual([]);
    });

    it('11 · a second destroy resolves, and a machine already gone still has its volume taken', async () => {
      const a = await provisioned();
      await orchestrator.destroyPersistent(a);
      await expect(orchestrator.destroyPersistent(a)).resolves.toBeUndefined();

      const b = await provisioned({ instanceId: 'inst-contract-b' });
      harness.destroyOutOfBand(b);
      expect(harness.liveVolumeIds(b.app)).toEqual([b.volumeId]);
      await expect(orchestrator.destroyPersistent(b)).resolves.toBeUndefined();
      expect(harness.liveMachineIds(b.app)).toEqual([]);
      expect(harness.liveVolumeIds(b.app)).toEqual([]);
    });

    it('12 · lists every machine and volume of one app, and an app that does not exist as empty', async () => {
      const a = await provisioned();
      const b = await provisioned({ instanceId: 'inst-contract-b' });
      const inventory = await orchestrator.listPersistent(a.app);
      expect(inventory.app).toBe(a.app);
      expect(inventory.machines.map((m) => m.machineId).sort()).toEqual(
        [a.machineId, b.machineId].sort(),
      );
      const byMachine = new Map(inventory.machines.map((m) => [m.machineId, m]));
      expect(byMachine.get(a.machineId)).toMatchObject({
        state: 'running',
        instanceId: harness.spec().instanceId,
      });
      expect(byMachine.get(b.machineId)?.instanceId).toBe('inst-contract-b');
      expect(byMachine.get(a.machineId)?.createdAt).toBeInstanceOf(Date);
      const byVolume = new Map(inventory.volumes.map((v) => [v.volumeId, v]));
      expect([...byVolume.keys()].sort()).toEqual([a.volumeId, b.volumeId].sort());
      expect(byVolume.get(a.volumeId)?.attachedMachineId).toBe(a.machineId);
      expect(byVolume.get(b.volumeId)?.attachedMachineId).toBe(b.machineId);
      expect(byVolume.get(a.volumeId)?.name).toEqual(expect.any(String));

      const missing = await orchestrator.listPersistent('an-app-nobody-created');
      expect(missing).toEqual({ app: 'an-app-nobody-created', machines: [], volumes: [] });
    });

    it('13 · destroyMachine and destroyVolume take exactly their orphan, twice without a throw', async () => {
      const kept = await provisioned();
      const orphaned = await provisioned({ instanceId: 'inst-contract-orphan' });
      harness.destroyOutOfBand(orphaned);
      const stray = harness.addUntrackedMachine(kept.app);

      await orchestrator.destroyVolume(kept.app, orphaned.volumeId);
      await orchestrator.destroyMachine(kept.app, stray);
      await expect(
        orchestrator.destroyVolume(kept.app, orphaned.volumeId),
      ).resolves.toBeUndefined();
      await expect(orchestrator.destroyMachine(kept.app, stray)).resolves.toBeUndefined();

      expect(harness.liveMachineIds(kept.app)).toEqual([kept.machineId]);
      expect(harness.liveVolumeIds(kept.app)).toEqual([kept.volumeId]);
    });

    it('14 · a machine made by hand lists with no instance id, and destroyMachine removes it', async () => {
      const kept = await provisioned();
      const stray = harness.addUntrackedMachine(kept.app);
      const inventory = await orchestrator.listPersistent(kept.app);
      expect(inventory.machines.find((m) => m.machineId === stray)?.instanceId).toBeNull();
      await orchestrator.destroyMachine(kept.app, stray);
      expect(harness.liveMachineIds(kept.app)).toEqual([kept.machineId]);
    });

    it('15 · this suite names no adapter — the only adapter code is in the harness files', () => {
      const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
      for (const adapter of ['fake', 'fly']) {
        expect(source).not.toContain(`${adapter}PersistentOrchestrator`);
      }
    });
  });
}

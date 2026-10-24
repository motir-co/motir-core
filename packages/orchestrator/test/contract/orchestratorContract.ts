import { beforeEach, describe, expect, it } from 'vitest';
import {
  OrchestratorApiError,
  OrchestratorCapacityError,
  type ContainerHandle,
  type ContainerOrchestrator,
  type ContainerSpec,
  type OrchestratorCapacityReason,
  type UsageAttribution,
} from '../../src/index';

// THE PORT'S CONTRACT, written once and run against every adapter (MOTIR-8960).
//
// ⚠️ THIS FILE NAMES NO ADAPTER. Every statement below is a guarantee of the
// `ContainerOrchestrator` port, and it reaches the adapter under test only
// through `OrchestratorContractHarness` — the controls a test needs to drive a
// lifecycle (fail the next call, never start, complete the job, age a
// container). A second adapter joins the fleet by writing a harness and one
// `describeOrchestratorContract(...)` call; it does not get its own copy of
// these assertions, because a copy is where two adapters quietly start keeping
// two different contracts.
//
// THE GUARANTEES:
//   1. `provider` is declared, and every handle carries it.
//   2. One container per provision, a distinct id each, in the spec's region.
//   3. A provision that fails throws a typed error and leaves NO container —
//      and, when the spec asked for a Docker volume, no volume either.
//   4. Teardown RETURNS the usage row: destroying and metering are one call.
//   5. A second teardown resolves, names the same handle, and leaves nothing
//      live.
//   6. A container that finished and self-destroyed describes as gone.
//   7. A container that never started reports no start instant.
//   8. A teardown that fails throws, and the container is still there.
//   9. No reuse: a provision after a teardown is a new container.
//  10. A handle the adapter has never seen (a restart, a persisted handle) is
//      describable and tear-downable, metered from the caller's observation.
//  11. Reap destroys only what is past the cutoff and not spared, emits a row
//      only for what it can attribute, and skips what is already gone.
//  12. A spec with no job id (the index workload) provisions and meters as itself.
//  13. `sweepOrphanedVolumes`, where an adapter has it, takes only old
//      unattached volumes.
//  14. A provider that is FULL refuses with `OrchestratorCapacityError`, carrying
//      the provider and the reason, and leaves no container and no volume — run
//      once per reason the adapter's harness declares (MOTIR-8973).
//
// TWO PLACES THE ADAPTERS DIVERGE, and why the suite does not pin them:
//   - A SECOND TEARDOWN. The fake memoises and returns the identical first row;
//     Fly reads a machine that is gone and builds a fresh one. The port promises
//     only what both keep (guarantee 5). "Exactly one usage row per provisioned
//     handle" is enforced where rows are WRITTEN, not here:
//     `ciFleetCostMeterService.recordContainerUsage` (lib/services/
//     ciFleetCostMeterService.ts) settles a second figure for the same
//     (containerProvider, handleId) as `'duplicate'`, through
//     `ciContainerUsageRepository.createIfAbsent`'s unique pair.
//   - THE EXIT CODE OF A SELF-DESTROYED CONTAINER. The fake keeps it (the index
//     dispatcher's tests need a container that exited 30 and took itself away);
//     Fly has no machine left to read and answers null. Guarantee 6 accepts both.
//
// Adapter-only behaviour (the fake's cross-process store, Fly's request shaping
// and volume retries) stays in that adapter's own test file.

export interface OrchestratorContractHarness {
  /** The adapter under test. */
  readonly orchestrator: ContainerOrchestrator;
  /** Forget every container and arranged failure. Runs before every case. */
  reset(): void;
  /** A valid spec for this adapter, with `overrides` applied. */
  spec(overrides?: Partial<ContainerSpec>): ContainerSpec;
  /** The attribution matching `spec()`, with `overrides` applied. */
  attribution(overrides?: Partial<UsageAttribution>): UsageAttribution;
  /** The workload case 12 provisions with no job id, and the spec fields it
   *  needs. Omitted means the index workload; an adapter that does not boot the
   *  indexer (AWS, MOTIR-9422) names a jobless workload it does boot. */
  readonly joblessSpec?: Partial<ContainerSpec> & { workload: ContainerSpec['workload'] };
  /** The next provision fails at the provider. */
  failNextProvision(): void;
  /** The capacity reasons this provider can actually give. A reason left out is
   *  not run for this adapter — absent by declaration, never by failure. */
  readonly capacityReasons: readonly OrchestratorCapacityReason[];
  /** The next provision is refused because the provider is full, for `reason`. */
  refuseNextProvisionForCapacity(reason: OrchestratorCapacityReason): void;
  /** The next teardown fails at the provider. */
  failNextTeardown(): void;
  /** The next provisioned container is created but never starts. */
  neverStart(): void;
  /** The job ends and the container destroys itself (`auto_destroy`). */
  completeJob(handle: ContainerHandle, options?: { exitCode?: number | null }): void;
  /** The container was created at `createdAt`, so a reap cutoff can see it. */
  backdate(handle: ContainerHandle, createdAt: Date): void;
  /** Containers still on the provider — the leak assertion. */
  liveContainerIds(): string[];
  /** Docker volumes still on the provider, for an adapter that creates them. */
  liveVolumeIds?(): string[];
  /** Leave an unattached Docker volume created at `createdAt`, as a teardown
   *  that could not delete it would. Answers its id. */
  orphanVolume?(createdAt: Date): string;
}

const HOUR_MS = 3_600_000;

export function describeOrchestratorContract(
  name: string,
  makeHarness: () => OrchestratorContractHarness,
): void {
  describe(`the ContainerOrchestrator contract — ${name}`, () => {
    const harness = makeHarness();
    const { orchestrator } = harness;

    beforeEach(() => {
      harness.reset();
    });

    it('1 · declares its provider, and every handle carries it', async () => {
      expect(orchestrator.provider).toEqual(expect.any(String));
      const handle = await orchestrator.provision(harness.spec());
      expect(handle.provider).toBe(orchestrator.provider);
    });

    it('2 · boots one container per provision, a distinct id each, in the spec region', async () => {
      const spec = harness.spec();
      const a = await orchestrator.provision(spec);
      const b = await orchestrator.provision(spec);
      expect(a.id).not.toBe(b.id);
      expect(a.region).toBe(spec.region);
      expect(harness.liveContainerIds()).toEqual([a.id, b.id]);
    });

    it('3 · a provision that fails throws a typed error and leaves NO container, nor its volume', async () => {
      harness.failNextProvision();
      await expect(
        orchestrator.provision(harness.spec({ dockerVolumeGb: 20 })),
      ).rejects.toMatchObject({
        code: 'ORCHESTRATOR_API_FAILED',
        provider: orchestrator.provider,
      });
      expect(harness.liveContainerIds()).toEqual([]);
      if (harness.liveVolumeIds) expect(harness.liveVolumeIds()).toEqual([]);
    });

    it('4 · teardown RETURNS the usage row, and the container and its volume are gone', async () => {
      const handle = await orchestrator.provision(harness.spec({ dockerVolumeGb: 20 }));
      if (harness.liveVolumeIds) expect(harness.liveVolumeIds()).toHaveLength(1);

      const usage = await orchestrator.teardown(handle, 'job_completed', harness.attribution());

      expect(usage).toMatchObject({
        handleId: handle.id,
        provider: orchestrator.provider,
        teardownReason: 'job_completed',
        orgId: harness.attribution().orgId,
        workload: harness.attribution().workload,
      });
      expect(harness.liveContainerIds()).toEqual([]);
      if (harness.liveVolumeIds) expect(harness.liveVolumeIds()).toEqual([]);
    });

    it('5 · a second teardown resolves, names the same handle, and leaves nothing live', async () => {
      const handle = await orchestrator.provision(harness.spec());
      await orchestrator.teardown(handle, 'job_completed', harness.attribution());

      const second = await orchestrator.teardown(handle, 'reaped', harness.attribution());

      expect(second.handleId).toBe(handle.id);
      expect(harness.liveContainerIds()).toEqual([]);
    });

    it('6 · a container that finished and self-destroyed describes as gone', async () => {
      const handle = await orchestrator.provision(harness.spec());
      harness.completeJob(handle, { exitCode: 30 });

      const status = await orchestrator.describe(handle);

      expect(status).toMatchObject({
        handleId: handle.id,
        exists: false,
        terminal: true,
        state: 'destroyed',
      });
      // The fake keeps the code; Fly has no machine left to read — see the header.
      expect(status.exitCode === null || typeof status.exitCode === 'number').toBe(true);
    });

    it('7 · a container that never started reports no start instant', async () => {
      harness.neverStart();
      const handle = await orchestrator.provision(harness.spec());

      const status = await orchestrator.describe(handle);

      expect(status.exists).toBe(true);
      expect(status.startedAt).toBeNull();
    });

    it('8 · a teardown that fails throws a typed error, and the container is still there', async () => {
      const handle = await orchestrator.provision(harness.spec());
      harness.failNextTeardown();

      await expect(
        orchestrator.teardown(handle, 'job_completed', harness.attribution()),
      ).rejects.toMatchObject({ code: 'ORCHESTRATOR_API_FAILED' });
      expect(harness.liveContainerIds()).toEqual([handle.id]);
    });

    it('9 · NO REUSE — a provision after a teardown is a new container', async () => {
      const handle = await orchestrator.provision(harness.spec());
      await orchestrator.teardown(handle, 'job_completed', harness.attribution());

      const next = await orchestrator.provision(harness.spec());

      expect(next.id).not.toBe(handle.id);
      expect(harness.liveContainerIds()).toEqual([next.id]);
    });

    describe('10 · a handle the adapter has never seen', () => {
      const stranger = (): ContainerHandle => ({
        provider: orchestrator.provider,
        id: 'machine-from-a-previous-life',
        region: harness.spec().region,
        createdAt: new Date('2026-08-01T09:00:00.000Z'),
      });

      it('describes as gone, dated from the handle', async () => {
        const handle = stranger();
        const status = await orchestrator.describe(handle);
        expect(status).toMatchObject({ exists: false, terminal: true, state: 'destroyed' });
        expect(status.createdAt).toEqual(handle.createdAt);
      });

      it('tears down into a row metered from the caller’s observed start', async () => {
        const handle = stranger();
        const observedStartedAt = new Date(handle.createdAt.getTime() + 4_000);

        const usage = await orchestrator.teardown(
          handle,
          'reaped',
          harness.attribution({ observedStartedAt }),
        );

        expect(usage.handleId).toBe(handle.id);
        expect(usage.startedAt).toEqual(observedStartedAt);
        expect(usage.billableSeconds).toBeGreaterThan(0);
      });

      it('tears down with no observed start into a row that costs nothing', async () => {
        const usage = await orchestrator.teardown(
          stranger(),
          'provision_failed',
          harness.attribution(),
        );

        expect(usage.startedAt).toBeNull();
        expect(usage.billableSeconds).toBe(0);
        expect(Number(usage.costUsd)).toBe(0);
      });
    });

    describe('11 · reap', () => {
      const cutoff = () => new Date(Date.now() - HOUR_MS);
      const twoHoursAgo = () => new Date(Date.now() - 2 * HOUR_MS);

      it('destroys only containers past the cutoff, each with a `reaped` row', async () => {
        const old = await orchestrator.provision(harness.spec());
        const fresh = await orchestrator.provision(harness.spec());
        harness.backdate(old, twoHoursAgo());

        const usages = await orchestrator.reap(cutoff(), async () => harness.attribution());

        expect(usages.map((u) => u.handleId)).toEqual([old.id]);
        expect(usages[0]!.teardownReason).toBe('reaped');
        expect(harness.liveContainerIds()).toEqual([fresh.id]);
      });

      it('destroys an unattributable orphan but emits no row for it', async () => {
        const orphan = await orchestrator.provision(harness.spec());
        harness.backdate(orphan, twoHoursAgo());

        const usages = await orchestrator.reap(cutoff(), async () => null);

        expect(usages).toEqual([]);
        expect(harness.liveContainerIds()).toEqual([]);
      });

      it('leaves a spared container running, with no row', async () => {
        const kept = await orchestrator.provision(harness.spec());
        harness.backdate(kept, twoHoursAgo());

        const usages = await orchestrator.reap(
          cutoff(),
          async () => harness.attribution(),
          async (handle) => handle.id === kept.id,
        );

        expect(usages).toEqual([]);
        expect(harness.liveContainerIds()).toEqual([kept.id]);
      });

      it('skips containers that are already gone', async () => {
        const handle = await orchestrator.provision(harness.spec());
        harness.backdate(handle, twoHoursAgo());
        harness.completeJob(handle);

        expect(await orchestrator.reap(new Date(), async () => harness.attribution())).toEqual([]);
      });
    });

    it('12 · a spec with no job id provisions and meters as itself', async () => {
      const jobless = harness.joblessSpec ?? { workload: 'code_graph_index' as const };
      const handle = await orchestrator.provision(
        harness.spec({ ...jobless, workflowJobId: null }),
      );
      expect(harness.liveContainerIds()).toEqual([handle.id]);

      const usage = await orchestrator.teardown(
        handle,
        'job_completed',
        harness.attribution({ workload: jobless.workload, workflowJobId: null }),
      );

      expect(usage.workload).toBe(jobless.workload);
      expect(usage.workflowJobId).toBeNull();
    });

    describe('14 · a capacity refusal', () => {
      for (const reason of harness.capacityReasons) {
        it(`${reason} throws OrchestratorCapacityError and leaves no container, nor its volume`, async () => {
          harness.refuseNextProvisionForCapacity(reason);

          const thrown = await orchestrator.provision(harness.spec({ dockerVolumeGb: 20 })).then(
            () => null,
            (err: unknown) => err,
          );

          expect(thrown).toBeInstanceOf(OrchestratorCapacityError);
          // Still a provider refusal to every caller that does not care why.
          expect(thrown).toBeInstanceOf(OrchestratorApiError);
          expect(thrown).toMatchObject({
            provider: orchestrator.provider,
            reason,
            retryable: true,
          });
          expect(harness.liveContainerIds()).toEqual([]);
          if (harness.liveVolumeIds) expect(harness.liveVolumeIds()).toEqual([]);
        });
      }
    });

    it('13 · sweepOrphanedVolumes, where present, takes an old unattached volume and keeps a young one', async () => {
      const sweep = orchestrator.sweepOrphanedVolumes?.bind(orchestrator);
      if (!sweep || !harness.orphanVolume || !harness.liveVolumeIds) {
        // An adapter that never creates volumes has nothing to sweep.
        expect(orchestrator.sweepOrphanedVolumes).toBeUndefined();
        return;
      }
      const old = harness.orphanVolume(new Date(Date.now() - 2 * HOUR_MS));
      const young = harness.orphanVolume(new Date());

      const destroyed = await sweep(new Date(Date.now() - HOUR_MS));

      expect(destroyed).toBe(1);
      expect(harness.liveVolumeIds()).toEqual([young]);
      expect(harness.liveVolumeIds()).not.toContain(old);
    });
  });
}

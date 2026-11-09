import {
  isCiFleetConfigured,
  isHostedAgentConfigured,
  isIndexFleetConfigured,
  selectedOrchestratorProvider,
  verifyFleetBootable,
  verifyHostedAgentImagePullable,
  verifyIndexFleetBootable,
  type FleetBootableVerdict,
} from '@/lib/orchestrator';
import {
  verifyIndexContainerAiAddress,
  type ContainerAiAddressVerdict,
} from '@/lib/ai/containerAiAddress';
import { verifyFleetOrigins, type FleetOriginsVerdict } from '@/lib/ai/fleetOrigins';

// THE FLEET BOOT PREFLIGHT (Story MOTIR-1916 · MOTIR-2006) — §6.1 of
// `docs/decisions/fleet-image-pull.md`, given a service seam so a background job
// can consume it.
//
// Thin by design: the whole decision lives in `verifyFleetBootable()`, at the
// orchestrator's composition root, because that is the only place permitted to
// marry the Fly-configured image to a provider-neutral registry probe
// (`tests/ciFleet/orchestratorPortBoundary.test.ts` enforces exactly that). What
// is added HERE is the 4-layer seam every job handler consumes its domain
// through — `jobServices` hands it to `system.daily-health-check`, and the
// handler's test stubs this rather than the network.
//
// ⚠️ WHY A DEPLOYMENT-WIDE PROBE IS A HEALTH CHECK AND NOT A GATE. The fault it
// catches — the fleet is wired, reports "configured", and cannot pull a single
// container image (MOTIR-1980) — is invisible per job: every queued job fails
// identically, minting and de-registering a GitHub runner each time, and the
// operator sees a stream of provider errors with no statement of the cause.
// Asserting it ONCE, on a schedule, is what turns that stream into one sentence
// in the one place a human already looks.

export const fleetPreflightService = {
  /**
   * Can this deployment's fleet pull its configured runner image?
   *
   * Never throws — every arm of {@link FleetBootableVerdict} is an answer,
   * including "could not tell". The CALLER decides which arms are loud; this
   * only establishes which one is true.
   */
  async check(): Promise<FleetBootableVerdict> {
    return verifyFleetBootable();
  },

  /**
   * Can this deployment's fleet pull its configured INDEXER image? (MOTIR-2030)
   *
   * A SECOND method rather than a widened `check()`, mirroring the split at the
   * composition root: the two pull paths have two registries, two release lanes
   * and two failure modes, and `docs/decisions/fleet-image-pull.md` §5's third
   * constraint requires each to be preflighted independently. The indexer's is
   * the path §5's second constraint makes more likely to go missing —
   * `registry.fly.io` garbage-collects unreferenced images, and a fleet whose
   * machines are ephemeral by design references nothing between jobs.
   *
   * Never throws, for the same reason {@link check} does not.
   */
  async checkIndexFleet(): Promise<FleetBootableVerdict> {
    return verifyIndexFleetBootable();
  },

  /**
   * Can an agent-runner VM pull the configured HOSTED-AGENT image? (MOTIR-9420)
   *
   * The third pull path, given its own method for the reason the indexer's has
   * one: a separate image, a separate variable and a separate failure mode. The
   * probe is ANONYMOUS, the way the VM pulls it.
   *
   * Never throws, for the same reason {@link check} does not.
   */
  async checkHostedAgentImage(): Promise<FleetBootableVerdict> {
    return verifyHostedAgentImagePullable();
  },

  /**
   * Can the address this deployment would HAND an index container actually work
   * for it? (MOTIR-4518)
   *
   * ⚠️ A THIRD METHOD, AND IT IS A DIFFERENT QUESTION FROM THE OTHER TWO rather
   * than a third image. Both siblings ask whether a container can BOOT; neither
   * has ever asked whether the booted container can REACH anything, and that gap
   * is not academic — it is where the fleet spent two weeks. Every index run
   * since 2026-08-21 booted from a perfectly pullable image, downloaded the repo,
   * built the graph, and then failed to resolve the motir-ai address it had been
   * given, because that address was motir-core's own private one and the
   * container is in another organization. Both preflights were green throughout,
   * correctly: they were answering the question they were asked.
   *
   * The verdict is deliberately NOT a {@link FleetBootableVerdict} — that type is
   * about an image reference and its registry, and widening it to mean "or an
   * address, or a name resolution" is how a verdict stops being a message an
   * operator can act on. Same reasoning that gave the indexer image its own
   * function rather than a second `reference` field.
   *
   * Never throws, for the reason neither sibling does.
   */
  async checkIndexContainerAiAddress(): Promise<ContainerAiAddressVerdict> {
    // ⚠️ THE FAKE ADAPTER IS `not_applicable`, and it is EXCLUDED HERE rather
    // than inside `isIndexFleetConfigured()`, which answers `true` for it. That
    // predicate is asking "may this deployment enter the index path?", and the
    // fake must, because it is what every suite selects. THIS probe is asking
    // whether a real machine in another organization could reach an address, and
    // the fake boots no machine — so the honest answer is that there is nothing
    // to check. It is the same carve-out both image preflights make, for the
    // reason `isIndexFleetConfigured()` states in its own comment: requiring a
    // production-only variable here would put it in front of every test that
    // drives this job, and the usual answer to that is a placeholder in the test
    // environment — which is the same placeholder that would then work in
    // production.
    const bootsRealContainers =
      isIndexFleetConfigured() && selectedOrchestratorProvider() !== 'fake';
    return verifyIndexContainerAiAddress({ isConfigured: bootsRealContainers });
  },

  /**
   * Can the THREE addresses this deployment hands its fleet machines work for
   * them? (Story MOTIR-9714 · MOTIR-10750) — core's public origin, motir-ai's
   * container-facing origin and the gateway's run-lane origin, each checked
   * against what a machine on a pool account can use.
   *
   * A FOURTH method rather than a widened {@link checkIndexContainerAiAddress}:
   * that one is about the index container alone, applies only where this
   * deployment indexes, and its verdict and error are pinned by their own tests.
   * This one covers every fleet kind — CI runner, indexer, agent runner and
   * hoster — so it applies wherever real machines boot at all.
   *
   * Never throws, for the reason none of its siblings do.
   */
  async checkFleetOrigins(): Promise<FleetOriginsVerdict> {
    // ⚠️ THE FAKE ADAPTER IS `not_applicable`, the same carve-out the sibling
    // probes make and for the same reason: the fake boots no machine, so there is
    // no address a machine could fail to use, and requiring production values
    // here would put a placeholder in front of every suite that drives this job.
    // So is a deployment wired for no fleet kind at all — a self-hosted core, or
    // a cloud deploy not yet wired — which the image preflights also answer
    // `not_applicable` for. Each origin is then asked only of a deployment that
    // hands it to a machine: core's to every fleet kind, motir-ai's to the index
    // container, and the gateway's run lane to a hosted-run container.
    if (selectedOrchestratorProvider() === 'fake') {
      return verifyFleetOrigins({ isConfigured: false });
    }
    const indexes = isIndexFleetConfigured();
    const hosts = isHostedAgentConfigured();
    const bootsMachines = indexes || hosts || (await isCiFleetConfigured());
    return verifyFleetOrigins({
      isConfigured: bootsMachines,
      applies: { aiContainer: indexes, gatewayRun: hosts },
    });
  },
};

import {
  isHostedAgentConfigured,
  isPersistentOrchestratorConfigured,
  selectedOrchestratorProvider,
  verifyFleetBootable,
  verifyHostedAgentImagePullable,
  type FleetBootableVerdict,
} from '@/lib/orchestrator';
import { installFleetTakesKind } from '@/lib/ciFleet/installFleet';
import { fleetKindOnPool } from '@/lib/ciFleet/shardTargets';
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
   * Can an agent-runner VM pull the configured HOSTED-AGENT image? (MOTIR-9420)
   *
   * A second pull path, given its own method rather than a widened {@link check}:
   * a separate image, a separate variable and a separate failure mode. The probe
   * is ANONYMOUS, the way the VM pulls it.
   *
   * Never throws, for the same reason {@link check} does not.
   */
  async checkHostedAgentImage(): Promise<FleetBootableVerdict> {
    return verifyHostedAgentImagePullable();
  },

  /**
   * Can the addresses this deployment hands its fleet machines work for them?
   * (Story MOTIR-9714 · MOTIR-10750) — core's public origin and the gateway's
   * run-lane origin, each checked against what a machine on a pool account can
   * use. motir-ai's container-facing origin left with the index container, its
   * only reader (MOTIR-12037).
   *
   * Every fleet kind that is handed a Motir address is covered — the agent
   * runner (hosted runs) and the agent hoster (agent instances); the CI runner is
   * handed none.
   *
   * Never throws, for the reason none of its siblings do.
   */
  async checkFleetOrigins(): Promise<FleetOriginsVerdict> {
    // ⚠️ THE FAKE ADAPTER IS `not_applicable`, the same carve-out the image
    // probes make and for the same reason: the fake boots no machine, so there is
    // no address a machine could fail to use, and requiring production values
    // here would put a placeholder in front of every suite that drives this job.
    // So is a deployment that runs no kind handed a Motir address — a
    // self-hosted core, a cloud deploy not yet wired, or a CI-only fleet (a CI
    // runner is handed none; `fleetMachineAddresses.test.ts` shows it). Each
    // origin is then asked only of a deployment that hands it to a machine, as
    // that test lists them: core's to a hosted-run container (`MOTIR_API_URL`)
    // and an agent instance (`apiUrl` at launch), and the gateway's run lane to
    // a hosted-run container.
    if (selectedOrchestratorProvider() === 'fake') {
      return verifyFleetOrigins({ isConfigured: false });
    }
    const hostedRuns = isHostedAgentConfigured();
    // Agent instances run on the Fly lane, the install fleet (MOTIR-10801) or
    // their AWS pool: any one of the three means a launch hands core's origin.
    const agentInstances =
      isPersistentOrchestratorConfigured() ||
      installFleetTakesKind('agent_instance') ||
      (await fleetKindOnPool('agent_instance'));
    return verifyFleetOrigins({
      isConfigured: hostedRuns || agentInstances,
      applies: {
        core: hostedRuns || agentInstances,
        gatewayRun: hostedRuns,
      },
    });
  },
};

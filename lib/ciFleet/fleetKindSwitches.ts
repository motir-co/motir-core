import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { platformFleetKindSwitchRepository } from '@/lib/repositories/platformFleetKindSwitchRepository';

// THE FLEET KINDS' Fly↔AWS SWITCHES that this app wires (MOTIR-9421 · MOTIR-9503).
//
// `shardTargets.ts` holds the registry and reads Fly for an unwired kind; each
// kind's own story wires its reader. The agent runner's and the agent hoster's
// are here, and importing this module is what wires them — `fleetCeilingService`
// imports it, so the agent runner's switch is in place before any hosted run is
// admitted, and `agentInstanceLifecycleService` imports it, so the agent hoster's
// is in place before any agent instance is created.

/** The agent runner's switch: `aws` puts hosted runs on their own pool. */
export const AGENT_RUNNER_PROVIDER_ENV_VAR = 'MOTIR_FLEET_AGENT_RUNNER_PROVIDER';

/**
 * IS THE AGENT RUNNER ON ITS POOL? `aws` ⇒ yes; unset, `fly` or any other value ⇒
 * Fly, today's path. Read on every admission and never cached, like
 * `MOTIR_FLEET_ORCHESTRATOR`, so a flip takes effect on the next run with no
 * restart and touches no other kind.
 */
export function agentRunnerOnPool(): boolean {
  const lane = (globalThis as LaneSwitchHolder)[LANE_SWITCH_KEY]?.();
  if (lane === true || lane === false) return lane;
  return process.env[AGENT_RUNNER_PROVIDER_ENV_VAR]?.trim().toLowerCase() === 'aws';
}

/**
 * THE ACCEPTANCE LANE'S SWITCH (MOTIR-9429). A spec cannot change the server's
 * environment between tests, so under the lane's fake AWS this reader — a
 * fixture file, re-read on every call — answers first; `null` from it means the
 * fixture says nothing and the env var decides. Read INSIDE `agentRunnerOnPool`,
 * so it wins whichever of this module and the seam is imported first, and on
 * `globalThis` because the hook that installs it and the routes that read it are
 * separate bundles. Unset in every real deployment.
 */
export type LaneSwitchReader = () => boolean | null;

const LANE_SWITCH_KEY = Symbol.for('motir.ciFleet.e2eAgentRunnerSwitch');
type LaneSwitchHolder = { [LANE_SWITCH_KEY]?: LaneSwitchReader };

/** Install (or with `null`, remove) the lane's switch reader — tests and the lane only. */
export function setAgentRunnerSwitchForTests(reader: LaneSwitchReader | null): void {
  if (reader) (globalThis as LaneSwitchHolder)[LANE_SWITCH_KEY] = reader;
  else delete (globalThis as LaneSwitchHolder)[LANE_SWITCH_KEY];
}

/**
 * THE CI RUNNER'S LANE-ONLY SWITCH (Story MOTIR-9367 · MOTIR-9565). The CI
 * runner's real switch is not wired yet (MOTIR-9270), so outside the lane it
 * reads Fly exactly as an unwired kind does. Under the lane's fake AWS a spec
 * puts it on AWS through the same fixture file as the agent runner's, so the
 * Pools section can be walked over a seeded CI pool. On `globalThis` for the
 * reason above; unset in every real deployment, where this answers false.
 */
const CI_RUNNER_LANE_SWITCH_KEY = Symbol.for('motir.ciFleet.e2eCiRunnerSwitch');
type CiRunnerLaneSwitchHolder = { [CI_RUNNER_LANE_SWITCH_KEY]?: LaneSwitchReader };

/** Install (or with `null`, remove) the lane's CI runner switch — tests and the lane only. */
export function setCiRunnerSwitchForTests(reader: LaneSwitchReader | null): void {
  if (reader) (globalThis as CiRunnerLaneSwitchHolder)[CI_RUNNER_LANE_SWITCH_KEY] = reader;
  else delete (globalThis as CiRunnerLaneSwitchHolder)[CI_RUNNER_LANE_SWITCH_KEY];
}

/** Is the CI runner on its pool? Only the lane's fixture can say yes. */
export function ciRunnerOnPoolInLane(): boolean {
  return (globalThis as CiRunnerLaneSwitchHolder)[CI_RUNNER_LANE_SWITCH_KEY]?.() === true;
}

/**
 * IS THE AGENT HOSTER ON ITS POOL? The persisted `agent_instance` switch a
 * superadmin flips at /admin/fleet-settings › Agent hosting
 * (`agentHostingSettingService`): ON ⇒ yes; OFF or never written ⇒ Fly, today's
 * path. Read from the database on every placement and never cached, so a flip
 * applies to the next agent created with no restart and touches no other kind.
 */
export async function agentHosterOnPool(): Promise<boolean> {
  return (await platformFleetKindSwitchRepository.find('agent_instance'))?.onPool === true;
}

wireFleetKindSwitch('hosted_agent', agentRunnerOnPool);
wireFleetKindSwitch('agent_instance', agentHosterOnPool);
wireFleetKindSwitch('ci_runner', ciRunnerOnPoolInLane);

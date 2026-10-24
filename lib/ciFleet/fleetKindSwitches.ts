import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';

// THE FLEET KINDS' Fly↔AWS SWITCHES that this app wires (MOTIR-9421).
//
// `shardTargets.ts` holds the registry and reads Fly for an unwired kind; each
// kind's own story wires its reader. The agent runner's is here, and importing
// this module is what wires it — `fleetCeilingService` imports it, so the switch
// is in place before any hosted run is admitted.

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

wireFleetKindSwitch('hosted_agent', agentRunnerOnPool);

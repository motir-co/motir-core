import { indexFleetOnPool } from '@/lib/ciFleet/limits';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { platformFleetKindSwitchRepository } from '@/lib/repositories/platformFleetKindSwitchRepository';

// THE FLEET KINDS' Fly↔AWS SWITCHES that this app wires (MOTIR-9421 · MOTIR-9503 ·
// MOTIR-10064).
//
// `shardTargets.ts` holds the registry and reads Fly for an unwired kind; each
// kind's own story wires its reader. The agent runner's, the CI runner's and the
// agent hoster's are here, and importing this module is what wires them —
// `fleetCeilingService` imports it, and both `ciRunnerAdmissionService` and
// `ciRunnerBootService` import that, so the agent runner's and the CI runner's
// switches are in place before any hosted run or CI job is admitted; and
// `agentInstanceLifecycleService` imports it, so the agent hoster's is in place
// before any agent instance is created.

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

/** The CI runner's switch: `aws` puts CI jobs on the CI runner's pool (MOTIR-10064). */
export const CI_RUNNER_PROVIDER_ENV_VAR = 'MOTIR_FLEET_CI_RUNNER_PROVIDER';

/**
 * THE ACCEPTANCE LANE'S CI RUNNER SWITCH (Story MOTIR-9367 · MOTIR-9565). Under
 * the lane's fake AWS a spec puts the CI runner on AWS through the same fixture
 * file as the agent runner's, so the Pools section can be walked over a seeded
 * CI pool. It answers first inside `ciRunnerOnPool`, exactly as the agent
 * runner's does in `agentRunnerOnPool`; `null` from it falls through to the env
 * var. On `globalThis` for the reason above; unset in every real deployment.
 */
const CI_RUNNER_LANE_SWITCH_KEY = Symbol.for('motir.ciFleet.e2eCiRunnerSwitch');
type CiRunnerLaneSwitchHolder = { [CI_RUNNER_LANE_SWITCH_KEY]?: LaneSwitchReader };

/** Install (or with `null`, remove) the lane's CI runner switch — tests and the lane only. */
export function setCiRunnerSwitchForTests(reader: LaneSwitchReader | null): void {
  if (reader) (globalThis as CiRunnerLaneSwitchHolder)[CI_RUNNER_LANE_SWITCH_KEY] = reader;
  else delete (globalThis as CiRunnerLaneSwitchHolder)[CI_RUNNER_LANE_SWITCH_KEY];
}

/**
 * IS THE CI RUNNER ON ITS POOL? The lane's fixture answers first; then
 * `MOTIR_FLEET_CI_RUNNER_PROVIDER`: `aws` ⇒ yes; unset, empty or `fly` ⇒ Fly,
 * today's path; any other value ⇒ Fly WITH A WARNING, as the indexer's switch
 * does — a typo must leave CI where it is, never move it. Read on every
 * admission and never cached, so a flip moves the next CI job with no restart
 * and touches no other kind. Unsetting it, or setting `fly`, is the rollback.
 */
export function ciRunnerOnPool(): boolean {
  const lane = (globalThis as CiRunnerLaneSwitchHolder)[CI_RUNNER_LANE_SWITCH_KEY]?.();
  if (lane === true || lane === false) return lane;
  const raw = process.env[CI_RUNNER_PROVIDER_ENV_VAR]?.trim().toLowerCase();
  if (!raw || raw === 'fly') return false;
  if (raw === 'aws') return true;
  console.warn('[ciFleet/fleetKindSwitches] ignoring a malformed CI runner provider; using Fly', {
    env: CI_RUNNER_PROVIDER_ENV_VAR,
    raw: process.env[CI_RUNNER_PROVIDER_ENV_VAR],
  });
  return false;
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
wireFleetKindSwitch('ci_runner', ciRunnerOnPool);
// The indexer's reader is wired where its admission lives
// (`codeGraphIndexAdmissionService`), and wired again here with the SAME reader,
// so a process that reads every kind's switch without placing an index (the
// Pools read on /admin/monitoring) answers the indexer's switch too (MOTIR-9562).
wireFleetKindSwitch('code_graph_index', indexFleetOnPool);

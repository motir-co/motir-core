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
  return process.env[AGENT_RUNNER_PROVIDER_ENV_VAR]?.trim().toLowerCase() === 'aws';
}

wireFleetKindSwitch('hosted_agent', agentRunnerOnPool);

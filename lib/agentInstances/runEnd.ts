import { HOSTED_RUN_STALL_WINDOW_MS, HOSTED_RUN_TIMEOUT_MS } from '@/lib/hostedRuns/limits';

// THE WORDS A RUN IN AN AGENT CLOSES WITH (Story MOTIR-6864 · MOTIR-7027;
// `docs/decisions/agent-instance-run.md` §6) — pure, so the end path that writes
// them (`agentInstanceRunService.end`) and the run surfaces that quote them
// (MOTIR-7028: the item page's Run section and the run modal) share one table.

/**
 * The closing words of each end (`agent-instance-run.md` §6). The stall and the
 * backstop are the HOSTED run's words, so the item page's *run died* sentence
 * splits a timed-out run in an agent the way it splits a hosted one (the
 * `/12[- ]hour|backstop/` test in `workItemContinueService`). The design
 * (MOTIR-7022 rev 2) left the backstop's words open; these are the hosted
 * end path's own (`hostedRunService`'s `timed out at the 12-hour backstop`).
 */
export const AGENT_RUN_END_DETAIL = {
  stall: `stalled: no agent output for ${HOSTED_RUN_STALL_WINDOW_MS / 60_000} minutes`,
  backstop: `timed out at the ${HOSTED_RUN_TIMEOUT_MS / 3_600_000}-hour backstop`,
  agentStopped: 'the agent stopped',
  machineLost: 'the agent’s machine was lost',
  outOfCredits: 'out of credits',
  cancelled: 'cancelled by the agent’s owner',
  /** A platform admin stopped the organisation's containers (Story MOTIR-6905, MOTIR-7323). */
  adminStop: 'stopped by a platform admin',
  /** An owner or admin of the organisation stopped it (`agent-instances.md` §8 AMENDMENT 8). */
  orgAdminStop: 'stopped by an organization admin',
} as const;

/**
 * The failures that stopped a run's MACHINE under it after it started (the
 * design's *The run's machine stopped before the run closed.*). Every other
 * failure the end path records is one the run met BEFORE it started in the agent
 * (*The run couldn't start in the agent.*).
 */
export const AGENT_RUN_MACHINE_STOPPED: ReadonlySet<string> = new Set([
  AGENT_RUN_END_DETAIL.agentStopped,
  AGENT_RUN_END_DETAIL.machineLost,
  AGENT_RUN_END_DETAIL.outOfCredits,
]);

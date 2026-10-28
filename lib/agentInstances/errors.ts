// Typed errors for the agent-instance lane (Story MOTIR-6860 · MOTIR-6872).
// Every refusal a person can meet is one of these, with the words the Instances
// page shows (the MOTIR-6868 design's panel 5) — never a 500. The
// route maps each `code` to a status in `lib/agentInstances/errorResponse.ts`.

import type { WorkItemRepairClaimDto } from '@/lib/dto/workItemRepair';

/** An instance that does not exist, is deleted, or is not the caller's (§8) — one answer for all three. */
export class AgentInstanceNotFoundError extends Error {
  readonly code = 'agent_instance_not_found' as const;
  constructor(readonly instanceId: string) {
    super('That agent does not exist.');
    this.name = 'AgentInstanceNotFoundError';
  }
}

/** The name is malformed. */
export class AgentInstanceNameInvalidError extends Error {
  readonly code = 'agent_instance_name_invalid' as const;
  constructor() {
    super('Use lower-case letters, numbers and dashes, up to 40 characters.');
    this.name = 'AgentInstanceNameInvalidError';
  }
}

/** A live instance of the caller's on this project already has the name. */
export class AgentInstanceNameTakenError extends Error {
  readonly code = 'agent_instance_name_taken' as const;
  constructor(readonly instanceName: string) {
    super(`You already have an agent called ${instanceName} on this project.`);
    this.name = 'AgentInstanceNameTakenError';
  }
}

/** §9: the profile is not offered. */
export class AgentProfileNotOfferedError extends Error {
  readonly code = 'agent_profile_not_offered' as const;
  constructor(
    readonly profileId: string,
    displayName: string,
  ) {
    super(
      `${displayName} isn't offered: its terms don't yet allow a platform to host it. Choose another coding agent.`,
    );
    this.name = 'AgentProfileNotOfferedError';
  }
}

/**
 * Which rule refused a start (§5, §6). `ai_plan_required` / `ai_plan_unknown` are
 * `agent-instance-storage.md` §1 and §4's: no paid AI plan, or one that could not
 * be read — asked before every other rule (MOTIR-6918). `user_cap` and
 * `org_cap` are the organisation's PLAN figures — `agentsPerUser` at create,
 * `agentsPerOrg` (the org's live agents, running or asleep) at create only — a
 * wake is never refused by it (the fleet-capacity decision record MOTIR-9357,
 * MOTIR-9374, MOTIR-9954) — each carrying the `limit` and `planName` the words
 * name. `plan_unknown` is a plan whose figures could not be read (or whose key
 * has no row): refused, never given a default figure. `fleet_busy` is left for
 * the operator's kill switch alone.
 */
export type AgentInstanceRefusalReason =
  | 'ai_plan_required'
  | 'ai_plan_unknown'
  | 'plan_unknown'
  | 'credits'
  | 'credits_unknown'
  | 'user_cap'
  | 'org_cap'
  | 'fleet_busy';

/** A create or wake refused BEFORE anything was booted (§5, §6). */
export class AgentInstanceStartRefusedError extends Error {
  readonly code = 'agent_instance_start_refused' as const;
  constructor(
    readonly reason: AgentInstanceRefusalReason,
    message: string,
    /** The number a cap refusal names (`user_cap`, `org_cap`), so the page renders it. */
    readonly limit?: number,
    /** The plan a cap refusal names, as motir-ai sends it (MOTIR-9374). */
    readonly planName?: string,
  ) {
    super(message);
    this.name = 'AgentInstanceStartRefusedError';
  }
}

/** The move is not legal from the instance's current state (§4). */
export class AgentInstanceStateConflictError extends Error {
  readonly code = 'agent_instance_state_conflict' as const;
  constructor(
    readonly instanceId: string,
    readonly state: string,
    action: string,
  ) {
    super(`This agent is ${state}, so it can't be ${action} right now.`);
    this.name = 'AgentInstanceStateConflictError';
  }
}

/** The lane is not configured on this deployment. */
export class AgentInstancesUnavailableError extends Error {
  readonly code = 'agent_instances_unavailable' as const;
  constructor(detail: string) {
    super(`Personal agents are not available on this deployment: ${detail}`);
    this.name = 'AgentInstancesUnavailableError';
  }
}

/**
 * The agent's image has no terminal server (`agent-terminal.md` Q3, Q8): it was
 * made before the terminal existed. Recorded on the instance by the boot probe
 * (`terminalServer: 'absent'` on its DTO); the terminal ticket refuses with it.
 * The agent stays usable otherwise — moving it to a newer image is MOTIR-6862's.
 */
export class AgentInstanceNoTerminalServerError extends Error {
  readonly code = 'no_terminal_server' as const;
  constructor(readonly instanceId: string) {
    super('This agent was made before the terminal existed, so its image has no terminal to open.');
    this.name = 'AgentInstanceNoTerminalServerError';
  }
}

/**
 * The terminal ticket's ownership refusal (`agent-terminal.md` Q3, MOTIR-6940):
 * the caller does not own this agent — whatever their role, a manager's
 * included (`agent-instances.md` §8). ALSO the answer for an agent that does not
 * exist or is deleted, so the refusal leaks nothing about someone else's agent:
 * the same `not_owner` for all three, as the other instance routes answer
 * `agent_instance_not_found` for all three.
 */
export class AgentTerminalNotOwnerError extends Error {
  readonly code = 'not_owner' as const;
  constructor(readonly instanceId: string) {
    super('Only the person who made this agent can open its terminal.');
    this.name = 'AgentTerminalNotOwnerError';
  }
}

/**
 * The terminal ticket's state refusal (`agent-terminal.md` Q3, Q6): the agent is
 * not `running`. The panel wakes it through the existing Wake route and asks
 * again — the relay never wakes anything, so waking stays in one place.
 */
export class AgentInstanceNotRunningError extends Error {
  readonly code = 'not_running' as const;
  constructor(
    readonly instanceId: string,
    readonly state: string,
  ) {
    super(`This agent is ${state}. Wake it to open its terminal.`);
    this.name = 'AgentInstanceNotRunningError';
  }
}

// ── Starting a card's run in an agent (MOTIR-7026 · `agent-instance-run.md` §4) ──
//
// The start's own refusals, each raised BEFORE anything is opened, claimed or
// woken. The rest of the §4 refusal set is shared: `agent_instance_not_found`,
// `agent_instance_state_conflict`, the wake's `agent_instance_start_refused`
// (passed through unchanged), `agent_instance_run_active`
// (`DispatchRunAgentBusyError`) and `hosted_repository_not_writable`.

/** The agent is on another project than the card (409). */
export class AgentInstanceWrongProjectError extends Error {
  readonly code = 'agent_instance_wrong_project' as const;
  constructor(readonly instanceId: string) {
    super('This agent works on another project, so it can’t run this card.');
    this.name = 'AgentInstanceWrongProjectError';
  }
}

/** The card cannot be run now — its status, or an open blocker, named in `detail` (409). */
export class AgentRunCardNotReadyError extends Error {
  readonly code = 'agent_run_card_not_ready' as const;
  constructor(
    readonly workItemKey: string,
    readonly detail: string,
  ) {
    super(`${workItemKey} isn’t ready to run: ${detail}.`);
    this.name = 'AgentRunCardNotReadyError';
  }
}

/**
 * A `fix` start the repair claim did not open a run for (409; MOTIR-9049): the card is
 * `taken` (an open repair holds it — `holder` and `startedAt` say who and since when) or
 * `not_repairable` (`reason` is the predicate's own refusal). Carries the claim's whole
 * answer so the door can say which, rather than a bare error.
 */
export class AgentRunRepairRefusedError extends Error {
  readonly code = 'agent_run_repair_refused' as const;
  constructor(readonly claim: WorkItemRepairClaimDto) {
    super(
      claim.outcome === 'taken'
        ? `${claim.key} already has a repair running.`
        : `${claim.key} can't be repaired now: ${claim.reason ?? claim.outcome}.`,
    );
    this.name = 'AgentRunRepairRefusedError';
  }
}

/**
 * The agent's image predates the run launcher (409) — or was never probed for
 * its current digest, which §4 reads as the same thing.
 */
export class AgentInstanceImageTooOldError extends Error {
  readonly code = 'agent_instance_image_too_old' as const;
  constructor(readonly instanceId: string) {
    super('This agent was made before agents could run cards. Move it to a newer image first.');
    this.name = 'AgentInstanceImageTooOldError';
  }
}

/** The agent's coding agent has no unattended command (§3) (409). */
export class AgentProfileCannotRunError extends Error {
  readonly code = 'agent_profile_cannot_run' as const;
  constructor(
    readonly profileId: string,
    displayName: string,
  ) {
    super(`${displayName} can’t run a card on its own, so this agent can’t run cards.`);
    this.name = 'AgentProfileCannotRunError';
  }
}

/** The agent's coding agent is not signed in (409). */
export class AgentNotSignedInError extends Error {
  readonly code = 'agent_not_signed_in' as const;
  constructor(
    readonly instanceId: string,
    displayName: string,
  ) {
    super(
      `${displayName} isn’t signed in on this agent. Sign in from its terminal, then run again.`,
    );
    this.name = 'AgentNotSignedInError';
  }
}

// ── A live run and the lifecycle (MOTIR-7027 · `agent-instance-run.md` §6) ──

/**
 * Hibernate or Delete refused while the agent is running a card (409). It names
 * the run — and its card, when known — so the page can link it and the person
 * can cancel it first. Nothing was changed.
 */
export class AgentInstanceRunActiveError extends Error {
  readonly code = 'agent_instance_run_active' as const;
  constructor(
    readonly instanceId: string,
    readonly runId: string,
    readonly workItemKey: string | null,
    readonly action: 'hibernated' | 'deleted' | 'updated',
  ) {
    super(
      `This agent is running ${workItemKey ?? `run ${runId}`}, so it can’t be ${action}. Cancel the run first.`,
    );
    this.name = 'AgentInstanceRunActiveError';
  }
}

/** No run in an agent by that id that the caller can see (404) — Cancel's no-leak answer. */
export class AgentRunNotFoundError extends Error {
  readonly code = 'agent_run_not_found' as const;
  constructor(readonly dispatchRunId: string) {
    super(`No run ${dispatchRunId}.`);
    this.name = 'AgentRunNotFoundError';
  }
}

/** Only the agent's owner may cancel a run in it — `agent-instances.md` §8 (403). */
export class AgentRunCancelForbiddenError extends Error {
  readonly code = 'agent_run_cancel_forbidden' as const;
  constructor(readonly dispatchRunId: string) {
    super('Only the owner of the agent can cancel a run in it.');
    this.name = 'AgentRunCancelForbiddenError';
  }
}

/** The run in the agent has already ended — there is nothing to cancel (409). */
export class AgentRunAlreadyEndedError extends Error {
  readonly code = 'agent_run_already_ended' as const;
  constructor(
    readonly dispatchRunId: string,
    readonly status: string,
  ) {
    super(`This run has already ended (${status}).`);
    this.name = 'AgentRunAlreadyEndedError';
  }
}

/**
 * Update refused: the agent already runs the newest published image
 * (`agent-image-update.md` Q8, MOTIR-6952) — a stale page pressed it (409).
 */
export class AgentInstanceUpToDateError extends Error {
  readonly code = 'agent_instance_up_to_date' as const;
  constructor(
    readonly instanceId: string,
    readonly version: string | null,
  ) {
    super(
      version
        ? `This agent already runs the newest version (${version}).`
        : 'This agent already runs the newest version.',
    );
    this.name = 'AgentInstanceUpToDateError';
  }
}

/**
 * Update refused: the registry could not be asked which image is newest (Q8,
 * MOTIR-6952) — a wait, never "up to date" (503).
 */
export class AgentImageCatalogUnavailableError extends Error {
  readonly code = 'agent_image_catalog_unavailable' as const;
  constructor() {
    super('Motir couldn’t check for a newer version just now. Try again in a few minutes.');
    this.name = 'AgentImageCatalogUnavailableError';
  }
}

/**
 * An idempotency key reused for a different command (MOTIR-9045). Answering the
 * run it already started would hand a `run` to a caller that asked for a `fix`,
 * which would read as a fix that never starts — so it is refused, naming the run.
 */
export class AgentRunCommandMismatchError extends Error {
  readonly code = 'agent_run_command_mismatch' as const;
  constructor(
    readonly runId: string,
    readonly startedCommand: string,
    readonly requestedCommand: string,
  ) {
    super(
      `That request already started a ${startedCommand} run, so it can’t start a ${requestedCommand} run.`,
    );
    this.name = 'AgentRunCommandMismatchError';
  }
}

/** A `command` outside the three a run in an agent can be asked for (MOTIR-9045). */
export class AgentRunCommandInvalidError extends Error {
  readonly code = 'agent_run_command_invalid' as const;
  constructor(
    readonly requestedCommand: string,
    readonly allowed: readonly string[],
  ) {
    super(`command must be one of ${allowed.join(', ')}.`);
    this.name = 'AgentRunCommandInvalidError';
  }
}

/**
 * A new instance's provision failed on its AWS account for a reason that is NOT a
 * capacity refusal (MOTIR-9471) — an authorisation failure, a bad request, an
 * outage. It is never retried on the next account or on Fly: the caller fails the
 * create, and can tell it from a full pool.
 */
export class AgentInstancePlacementError extends Error {
  readonly code = 'agent_instance_placement_failed' as const;
  constructor(
    readonly fleetShardId: string,
    override readonly cause: unknown,
  ) {
    super(
      `The agent could not be created on its account: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'AgentInstancePlacementError';
  }
}

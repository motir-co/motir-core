import type {
  AgentInstanceBootKind,
  AgentInstanceBootOutcome,
  AgentInstanceBootStepKind,
  AgentInstanceBootStepState,
  AgentInstanceChargeOutcome,
  AgentInstanceIntervalEndReason,
  AgentInstanceState,
  AgentTerminalServer,
} from '@/generated/prisma/client';
import type { DispatchRunStatus } from '@/lib/dto/dispatchRuns';

// The AGENT INSTANCE DTOs (Story MOTIR-6860 · MOTIR-6870), the shape the
// lifecycle service returns and the Instances page renders
// (`docs/decisions/agent-instances.md` §4).
//
// ⚠️ THE VOCABULARIES ARE THE PRISMA ENUMS, ALIASED — never re-declared, for
// `lib/dto/dispatchRuns.ts`'s reason: a member added to the schema is then a
// type error at every non-total `switch` that renders it.
//
// ⚠️ NO FLY IDENTIFIER IS ON THE WIRE. The app, machine and volume ids are
// Motir's handle on its own infrastructure, not something the owner acts on,
// and publishing them would make them a contract this shape owes stability to.

export type {
  AgentInstanceBootKind,
  AgentInstanceBootOutcome,
  AgentInstanceBootStepKind,
  AgentInstanceBootStepState,
  AgentInstanceChargeOutcome,
  AgentInstanceIntervalEndReason,
  AgentInstanceState,
  AgentTerminalServer,
};

/** An agent's update offer (`agent-image-update.md` Q1). */
export type AgentImageUpdateDto = { version: string; digest: string } | null | 'unknown';

/** The catalog's answer for one agent, which the mapper puts on its DTO. */
export interface AgentInstanceImageFields {
  imageVersion: string | null;
  update: AgentImageUpdateDto;
}

/** One instance, as its owner sees it. */
export interface AgentInstanceDto {
  id: string;
  name: string;
  projectId: string;
  /** The sandbox profile id (`claude`, `codex`, …). */
  profileId: string;
  /** The moving tag the pinned digest was resolved from. */
  imageTag: string;
  imageDigest: string;
  /**
   * The version the agent runs (`agent-image-update.md` Q1, MOTIR-6949): the
   * `x.y.z` of the immutable tag sharing its digest, or null where none does or
   * the registry could not be asked.
   */
  imageVersion: string | null;
  /**
   * What the agent is offered (Q1): the newest published image when it is newer;
   * null when the agent is on the newest; `'unknown'` when the registry could not
   * be asked — which the page shows as "could not check", NEVER as up to date.
   */
  update: AgentImageUpdateDto;
  /**
   * The version an update is moving to (`updating`), or that a hibernated agent
   * takes at its next wake (Q5); null when no update is pinned.
   */
  pendingImageVersion: string | null;
  /** The last update's failure in words (Q4) — a rollback's reason; null otherwise. */
  updateFailureReason: string | null;
  region: string;
  state: AgentInstanceState;
  /** Set on `failed`, in words; null otherwise. */
  failureReason: string | null;
  /**
   * Does this agent's image serve a terminal (`agent-terminal.md` Q8)? `absent`
   * is the typed "this agent's image has no terminal" the panel draws and the
   * ticket route refuses with (`no_terminal_server`); `unknown` until the first
   * boot's probe answers (or while the terminal is off on this deployment).
   */
  terminalServer: AgentTerminalServer;
  stateChangedAt: string;
  lastActivityAt: string;
  createdAt: string;
}

/** One running interval (§4). */
export interface AgentInstanceIntervalDto {
  id: string;
  startedAt: string;
  endedAt: string | null;
  endReason: AgentInstanceIntervalEndReason | null;
  billableSeconds: number | null;
  credits: number | null;
  chargeOutcome: AgentInstanceChargeOutcome | null;
}

/**
 * One step of a boot attempt (`agent-instances.md` AMENDMENT 6 §1, §6). `seq` is
 * the stream's cursor; `repository` is `owner/name` on a `clone` row.
 */
export interface AgentInstanceBootStepDto {
  seq: number;
  step: AgentInstanceBootStepKind;
  repository: string | null;
  ordinal: number;
  state: AgentInstanceBootStepState;
  startedAt: string | null;
  endedAt: string | null;
  detail: string | null;
  /**
   * A `provision` step waiting for room in the pool (MOTIR-9474): why — `pool`
   * for a new instance, `account` for a woken one whose own account is full —
   * and since when (the first refusal). Null on every other step and state.
   * Derived on the server, so the browser never parses `detail`.
   */
  waiting: { reason: 'pool' | 'account'; since: string } | null;
  /**
   * A `provision` step that WAITED for room and then got it: why it waited, from
   * the first refusal (`since`) to the pass that got room (`until`) — what the
   * read-out's _Room found_ row draws. Null on every step that never waited.
   */
  waited: { reason: 'pool' | 'account'; since: string; until: string } | null;
}

/** An agent's CURRENT boot attempt and its steps in read-out order (AMENDMENT 6 §6). */
export interface AgentInstanceBootDto {
  attempt: number;
  kind: AgentInstanceBootKind;
  startedAt: string;
  endedAt: string | null;
  outcome: AgentInstanceBootOutcome | null;
  /** The attempt's highest step `seq` — the stream cursor this read is current to. */
  seq: number;
  steps: AgentInstanceBootStepDto[];
}

/** One `step` frame of the boot stream (AMENDMENT 6 §7): the step and its attempt. */
export interface AgentInstanceBootStepFrameDto extends AgentInstanceBootStepDto {
  attempt: number;
}

/** One row of the My agents page: the instance plus its machine time this month. */
export interface AgentInstanceListItemDto extends AgentInstanceDto {
  profileName: string;
  /** Seconds of the running intervals overlapping the current calendar month (UTC). */
  machineSecondsThisMonth: number;
  /** The credits those seconds come to — each interval rounded up once, like its charge (§5). */
  creditsThisMonth: number;
  /**
   * Why Motir stopped a `hibernated` instance, when Motir did — out of credits, idle,
   * or the 12-hour backstop (AMENDMENT 2; the page's line under the name). Null for
   * any other state, and for a hibernate the person asked for.
   */
  stopReason: AgentInstanceStopReason | null;
  /**
   * When the org's AI plan lapsed, the instant this agent will be deleted (ISO,
   * the start of that UTC day) — the row's "Will be deleted on {date}" line and
   * the reason its Wake is disabled (`agent-instance-storage.md` §4, MOTIR-6921).
   * Null when nothing is scheduled.
   */
  scheduledDeletionAt: string | null;
  /** The run working in this agent, or null (MOTIR-7029). */
  activeRun: AgentInstanceActiveRunDto | null;
  /** The agent's latest CLOSED run while none is active, or null (MOTIR-7029). */
  lastRun: AgentInstanceLastRunDto | null;
  /**
   * While `starting` / `waking`, the boot step in progress — the row's line
   * (MOTIR-7395 panel 10); null between two steps, with no recorded attempt, and
   * in every other state.
   */
  bootStep: AgentInstanceBootRowStepDto | null;
}

/** The step a booting row names: which one, and its repository on a `clone`. */
export interface AgentInstanceBootRowStepDto {
  step: AgentInstanceBootStepKind;
  repository: string | null;
  /** Why the boot waits for room (MOTIR-9474), or null while it is not waiting. */
  waiting: 'pool' | 'account' | null;
}

/**
 * The run working in this agent right now (MOTIR-7029 · `agent-instance-run.md`
 * §5): the panel header's run line names its card and links it and the run.
 */
export interface AgentInstanceActiveRunDto {
  id: string;
  /** The card's key; null only for a run that names no card (never one an agent opens). */
  workItemKey: string | null;
  /** The card's title; null when the work item has since been deleted. */
  title: string | null;
  startedAt: string;
}

/**
 * The agent's LATEST run once it has closed (MOTIR-7029): the panel header's
 * "Last run" line, until the agent's next run replaces it.
 */
export interface AgentInstanceLastRunDto {
  id: string;
  workItemKey: string | null;
  title: string | null;
  status: Exclude<DispatchRunStatus, 'running'>;
  endedAt: string | null;
  /**
   * The reason the run's end path RECORDED (`AGENT_RUN_END_DETAIL`, verbatim), on
   * a run that did not succeed; null when none was recorded (the CLI closed it).
   */
  reason: string | null;
}

/** The hibernations Motir makes on its own, which the page explains. */
export type AgentInstanceStopReason = 'credits' | 'idle' | 'backstop' | 'admin_stop';

export interface AgentInstanceListPageDto {
  instances: AgentInstanceListItemDto[];
  total: number;
  /**
   * The org's AI plan has ended (MOTIR-6921): the date its agents will be deleted
   * (ISO), for the page's banner. Null while the plan stands — and always for
   * Motir's own organisations, which are never scheduled.
   */
  planLapse: { deletesOn: string } | null;
}

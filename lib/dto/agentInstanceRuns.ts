import type {
  AgentInstanceState,
  DispatchCommand,
  DispatchRunStatus,
  AgentRunLauncher,
  AgentSignInState,
} from '@/generated/prisma/client';
import type { DispatchRunAgentInstanceDto } from '@/lib/dto/dispatchRuns';

// The DTOs of STARTING A CARD'S RUN IN AN AGENT (Story MOTIR-6864 · MOTIR-7026,
// `docs/decisions/agent-instance-run.md` §4) — what `POST
// /api/work-items/[id]/agent-runs` answers and what `GET …/agent-runs/agents`
// lists for the card's agent picker (MOTIR-7028).
//
// ⚠️ THE VOCABULARIES ARE THE PRISMA ENUMS, ALIASED — `lib/dto/agentInstances.ts`'s
// rule, for its reason.

export type { AgentRunLauncher, AgentSignInState };

/** A start that opened (or, on a repeated key, found) its run. */
export interface AgentRunStartedDto {
  dispatchRunId: string;
  /** False when `idempotencyKey` named a run already started: nothing new happened. */
  created: boolean;
  /**
   * True when this start woke the agent. The launch waits for it to come up; a
   * start refused after its wake leaves the machine to the idle rule.
   */
  woke: boolean;
}

/**
 * Why one agent cannot run a card right now — the §4 refusals that belong to the
 * AGENT rather than to the card. The words are the design's (MOTIR-7022); the
 * codes are the start's own, so the picker and a refused start agree.
 */
export type AgentRunAgentRefusal =
  | 'agent_instance_run_active'
  | 'agent_instance_image_too_old'
  | 'agent_profile_cannot_run'
  | 'agent_not_signed_in'
  | 'agent_instance_state_conflict';

/** The run an agent is already running, named so the words can link it. */
export interface AgentRunningRunDto {
  id: string;
  /** The card it works on — its scope target, else its first leg. */
  workItemKey: string | null;
  /**
   * That card's title (MOTIR-7028) — the picker's busy row names the work item
   * by key and title. Null when the key is unknown or its card was deleted.
   */
  workItemTitle: string | null;
}

/** One of the caller's agents on the card's project, as the picker offers it. */
export interface AgentForCardDto {
  id: string;
  name: string;
  profileId: string;
  profileName: string;
  state: AgentInstanceState;
  /** Whether the image can run a card — `unknown` when never probed for its current digest. */
  runLauncher: AgentRunLauncher;
  /** The last answered sign-in; `unknown` when it cannot be (or never was) told. */
  signInState: AgentSignInState;
  signInCheckedAt: string | null;
  runningRun: AgentRunningRunDto | null;
  /** Null when the agent can run a card now (waking it first if it sleeps). */
  refusal: AgentRunAgentRefusal | null;
  /** Its boot waits for room in the pool (MOTIR-9475): the picker offers it disabled.
   *  Always written by the read; optional so a hand-built row reads as not waiting. */
  waitingForRoom?: boolean;
}

export interface AgentsForCardDto {
  agents: AgentForCardDto[];
}

/**
 * A card's LAST run, read back for the "Fix in my agent" door and for the resume
 * (MOTIR-8981 · MOTIR-9046): which agent it ran in, the session id it recorded and
 * whether that agent's profile has a resume form. Three facts, not a decision —
 * `sessionId: null` with `canResume: true` means "no id was recorded, a fresh agent
 * on the same branch is the only route", and `canResume: false` means "this profile
 * has no resume form at all".
 */
export interface CardRunResumeTargetDto {
  id: string;
  command: DispatchCommand;
  status: DispatchRunStatus;
  startedAt: string;
  endedAt: string | null;
  /** The agent the run executed in; null for a hosted or local run, or a removed agent. */
  agent: DispatchRunAgentInstanceDto | null;
  /** True exactly when that agent is the calling user's own. */
  agentIsReaders: boolean;
  /** The session id the card's leg recorded, or null. */
  sessionId: string | null;
  canResume: boolean;
}

export interface CardResumeTargetDto {
  lastRun: CardRunResumeTargetDto | null;
}

/**
 * THE "FIX IN MY AGENT" DOOR'S STATE for one card (Story MOTIR-8981 · MOTIR-9053).
 * Read by the Development block's fix part and by an ended run's modal, so one
 * server evaluation serves both mounts.
 *
 * `offered: false` is an ANSWER, never a permission problem: "there is nothing to fix
 * here" is a state the door draws as nothing. `repair_open` carries the open fix run so
 * the door can say who is fixing and link the run; `agent_unusable` carries the agent's
 * own refusal verbatim.
 */
export type FixInMyAgentDoorDto =
  | {
      offered: true;
      /** The agent the card's last run used, else the viewer's first usable one. */
      agent: Pick<AgentForCardDto, 'id' | 'name' | 'profileId' | 'profileName' | 'state'>;
    }
  | {
      offered: false;
      reason:
        | 'no_pull_request'
        | 'green'
        | 'not_ci'
        | 'repair_open'
        | 'no_agent'
        | 'agent_unusable';
      /** Set on `repair_open`: the open fix run and who holds it. */
      run: {
        id: string;
        label: string;
        startedAt: string;
        holder: { id: string; name: string } | null;
        byViewer: boolean;
        /** The agent the fix runs in, when it is one of the viewer's own; else null. */
        agentName: string | null;
      } | null;
      /** Set on `agent_unusable`. */
      refusal: AgentRunAgentRefusal | null;
    };

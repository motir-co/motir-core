import { randomUUID } from 'node:crypto';
import type { AgentInstance } from '@/generated/prisma/client';
import { assertWorkspaceFeatureEnabled } from '@/lib/featureFlags/evaluate';
import { AGENT_LIST_LIMIT } from '@/lib/agentInstances/config';
import {
  AgentInstanceImageTooOldError,
  AgentInstanceNotFoundError,
  AgentInstanceStateConflictError,
  AgentInstancesUnavailableError,
  AgentInstanceWrongProjectError,
  AgentNotSignedInError,
  AgentProfileCannotRunError,
  AgentRunAlreadyEndedError,
  AgentRunCancelForbiddenError,
  AgentRunCardNotReadyError,
  AgentRunNotFoundError,
  AgentRunCommandInvalidError,
  AgentRunCommandMismatchError,
  AgentRunRepairRefusedError,
} from '@/lib/agentInstances/errors';
import {
  AGENT_RUN_COMMANDS,
  DEFAULT_AGENT_RUN_COMMAND,
  isAgentRunCommand,
  type AgentRunCommand,
} from '@/lib/agentInstances/runCommand';
import {
  profileCanResume,
  profileCanRunCards,
  profileDisplayName,
} from '@/lib/agentInstances/profiles';
import {
  AGENT_RUN_LAUNCH_TIMEOUT_SECONDS,
  AGENT_RUN_STOP_TIMEOUT_SECONDS,
  agentRunLaunchCommand,
  agentRunStopCommand,
  isAgentTerminalConfigured,
  parseLaunchAnswer,
} from '@/lib/agentInstances/terminal';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { DispatchRunAgentBusyError, DispatchRunTerminalError } from '@/lib/dispatchRuns/errors';
import type {
  AgentRunAgentRefusal,
  AgentRunStartedDto,
  AgentsForCardDto,
  CardResumeTargetDto,
} from '@/lib/dto/agentInstanceRuns';
import {
  hostedRunWriteAccess,
  repositoriesForItems,
  revokeRunGitCredentials,
} from '@/lib/github/runGitCredential';
import {
  HostedRunRepositoryNotWritableError,
  type RunGitWriteRefusal,
} from '@/lib/hostedRuns/errors';
import {
  HOSTED_RUN_TIMEOUT_MS,
  hostedRunStallWindowMs,
  latestRunCredentialExpiry,
} from '@/lib/hostedRuns/limits';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { AGENT_RUN_END_DETAIL } from '@/lib/agentInstances/runEnd';
import { toAgentForCardDto } from '@/lib/mappers/agentInstanceRunMappers';
import { toDispatchRunAgentInstanceDto } from '@/lib/mappers/dispatchRunMappers';
import { isPersistentOrchestratorConfigured } from '@/lib/orchestrator';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
import {
  dispatchRunRepository,
  type RunningDispatchRunInAgent,
} from '@/lib/repositories/dispatchRunRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import {
  agentInstanceClock,
  agentInstanceLifecycleService,
  agentInstanceReach,
  type InstanceReach,
} from '@/lib/services/agentInstanceLifecycleService';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { scopeClaimService } from '@/lib/services/scopeClaimService';
import { workItemsService } from '@/lib/services/workItemsService';
import { isClaimableState } from '@/lib/workItems/claimOutcome';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  withSystemContext,
  withWorkspaceContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';

// START A CARD'S RUN IN THE DEVELOPER'S OWN AGENT (Story MOTIR-6864 · MOTIR-7026,
// `docs/decisions/agent-instance-run.md` §1, §2, §4, §5) — the counterpart of
// `hostedRunService.start`, reusing its readiness rule, its leg order and its
// repository pre-flight, and NEVER its gateway half: no run key is minted, no
// model is chosen, no container is booted and no `AgentRunUsage` row is written.
// The run's machine time is the agent's own interval (§5).
//
// ⚠️ EVERY REFUSAL COMES BEFORE ANYTHING IS STARTED, in §4's order: access, the
// agent (the caller's, live, on the card's project), the card ready, no run
// already running in the agent, the image carries the launcher and the profile
// has an unattended command, the coding agent not recorded signed out, every
// repository writable. Each is a read. Then the WAKE, when the agent sleeps — its
// own refusals (credits, the fleet) pass through unchanged, and still nothing is
// opened. Only then is the run opened, its cards claimed and stamped, and the
// rest handed to the durable launch job.
//
// ⚠️ THE LAUNCH IS A JOB, AND THE RUN TOKEN IS MINTED THERE, NOT HERE. §4 has the
// route answer at once and a job wait for the agent to come up. The token must
// reach the agent on the exec's stdin (§2), and a job payload and a step memo are
// database rows that may hold no secret (`HostedRunSuperviseData`'s rule) — and
// only a token's hash is stored — so the token is minted by the launch step
// itself, in the same breath as the exec that carries it.
//
// ⚠️ THE RACE IS THE DATABASE'S. Two starts on one agent both pass the busy read;
// the partial unique index lets one open, and `dispatchRunService.open` names the
// winner to the loser (`namedAgentBusy`), whose refusal then names its card too.
//
// ── AFTER THE LAUNCH (MOTIR-7027, §6) — EVERY RUN IN AN AGENT ENDS ──────────
// Every end that is not the CLI's own close goes through ONE path, {@link end}:
// the run token and the App's git tokens revoked, a closing `log` line naming
// why, the run closed if it is still open. The paths that reach it, each hung off
// a TRANSITION rather than a polled state:
//
//   * the supervise job (`agent-instance-run/supervise`, {@link supervise}) — the
//     one case with no transition, a run gone silent: the agent stopped under it
//     (`failed`), the 15-minute stall or the 12-hour backstop (`timed_out`);
//   * Cancel by the agent's owner ({@link cancel}) — `cancelled`, then the run's
//     session stopped in the agent;
//   * the lifecycle (`agentInstanceLifecycleService`) — a lost machine, a machine
//     that stopped behind Motir's back, the sweep's backstop and credit stops;
//   * the lapse reap (`dispatchRunSweepService.reapLapsed`) — a CLI that stopped
//     heartbeating;
//   * the launch job, when the agent never came up or refused the launch.
//
// The CLI's own close (`POST /api/v1/dispatch-runs/[id]/close`) is the one close
// that is not the end path's; `dispatchRunService.close` revokes after it commits
// ({@link revokeCredentials}), and the supervise job's next pass revokes again,
// which is how a revoke that failed is retried. Whichever path closes first, the
// others find the run closed and write nothing: the close is a locked
// compare-and-set, and every revoke is idempotent.

/** What a start request asks for. */
export interface StartAgentRunInput {
  workItemKey: string;
  agentInstanceId: string;
  /** Optional: a repeated key answers the run it already started. */
  idempotencyKey?: string | undefined;
  /**
   * What the run is for (MOTIR-9045): `run` (the default — a parent card opens
   * `run_scope` instead), `fix` or `continue`. The value is the run's own
   * `DispatchCommand`, recorded on the run and on its `run_opened` event.
   */
  command?: AgentRunCommand | undefined;
}

/** How long the launch job waits for a woken agent to come up before failing the run. */
export const AGENT_RUN_BOOT_WAIT_MS = 10 * 60 * 1000;

/** How often the launch job looks again at an agent still coming up. */
export const AGENT_RUN_LAUNCH_POLL_MS = 15_000;

/** The one idempotency key a launch job is enqueued under. */
export function agentRunLaunchKey(dispatchRunId: string): string {
  return `agent-instance-run:${dispatchRunId}`;
}

/** The one idempotency key a run's supervise job is enqueued under (MOTIR-7027). */
export function agentRunSuperviseKey(dispatchRunId: string): string {
  return `agent-instance-run/supervise:${dispatchRunId}`;
}

/** How often the supervise job looks at a running run — the hosted supervisor's poll. */
export const AGENT_RUN_SUPERVISE_POLL_MS = 60_000;

/** The 12-hour backstop on a run in an agent — the hosted run's (`hosted-agent-run.md`). */
export const AGENT_RUN_BACKSTOP_MS = HOSTED_RUN_TIMEOUT_MS;

/** The closing words of each end — `lib/agentInstances/runEnd.ts`, shared with the run surfaces. */
export { AGENT_RUN_END_DETAIL };

/**
 * How a run in an agent ends when the CLI did not close it (§6). There is no
 * `succeeded`: the CLI in the agent decides success and closes the run itself.
 */
export type AgentRunEndOutcome = 'failed' | 'cancelled' | 'stall' | 'backstop' | 'lapsed';

const CLOSE_FOR: Record<
  AgentRunEndOutcome,
  {
    stopReason: 'halted' | 'interrupted' | 'abandoned';
    status: 'failed' | 'cancelled' | 'timed_out';
    label: string;
  }
> = {
  failed: { stopReason: 'halted', status: 'failed', label: 'failed' },
  cancelled: { stopReason: 'interrupted', status: 'cancelled', label: 'cancelled' },
  stall: { stopReason: 'abandoned', status: 'timed_out', label: 'stalled' },
  backstop: { stopReason: 'abandoned', status: 'timed_out', label: 'backstop' },
  lapsed: { stopReason: 'abandoned', status: 'timed_out', label: 'stopped reporting' },
};

/** What {@link agentInstanceRunService.end} did — never a throw. */
export interface AgentRunEndResult {
  /** True when THIS call closed the run; false when the CLI (or another path) had. */
  closed: boolean;
  /** Run tokens deleted by this call (0 when an earlier close already had). */
  runCredential: number;
  /** Whether the run's session in the agent was asked to stop (only when asked for and closed here). */
  sessionStop: 'stopped' | 'unreachable' | 'not_asked';
}

/** One pass of the supervise job: stop with a word, or come back at `deferUntil`. */
export type AgentRunSuperviseVerdict =
  | 'closed'
  | 'failed'
  | 'stalled'
  | 'backstop'
  | { deferUntil: Date };

/** The agent states a running run may sit in: up, or coming up for its launch. */
const AGENT_UP: readonly AgentInstance['state'][] = ['running', 'starting', 'waking', 'updating'];

function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

/** Bound on the stderr tail a failed launch keeps in the run's detail. */
const LAUNCH_STDERR_TAIL_CHARS = 300;

/**
 * A failed launch's exit code and the tail of its stderr, for the run's detail
 * (MOTIR-8872) — the launcher prints its refusal there and never the token, so
 * it is safe to keep. Empty when the exec exited 0 with nothing on stderr.
 */
function launchDiagnostic(result: { exitCode: number; stderr: string }): string {
  const stderr = result.stderr.trim();
  const tail =
    stderr.length > LAUNCH_STDERR_TAIL_CHARS
      ? `…${stderr.slice(-LAUNCH_STDERR_TAIL_CHARS)}`
      : stderr;
  if (result.exitCode === 0 && !tail) return '';
  return ` — exit ${result.exitCode}${tail ? `, stderr: ${tail}` : ''}`;
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : String(err);
}

/**
 * The legs of a parent run in DEPENDENCY order — `hostedRunService`'s order, so
 * a parent runs its children in the order every other run of it does.
 */
function orderLegs(
  children: readonly string[],
  edges: ReadonlyArray<{ fromId: string; toId: string }>,
): string[] {
  const blockers = new Map<string, string[]>();
  for (const e of edges) blockers.set(e.fromId, [...(blockers.get(e.fromId) ?? []), e.toId]);
  const placed = new Set<string>();
  const out: string[] = [];
  let remaining = [...children];
  while (remaining.length > 0) {
    const ready = remaining.filter((id) => (blockers.get(id) ?? []).every((b) => placed.has(b)));
    const batch = ready.length > 0 ? ready : remaining;
    for (const id of batch) {
      out.push(id);
      placed.add(id);
    }
    const done = new Set(batch);
    remaining = remaining.filter((id) => !done.has(id));
  }
  return out;
}

/** Does the image pinned today carry the launcher (§4: never probed for it reads as no)? */
function hasLauncher(row: AgentInstance): boolean {
  return row.runLauncher === 'present' && row.runLauncherDigest === row.imageDigest;
}

/**
 * THE AGENT'S OWN REFUSAL, if any — the §4 checks that belong to the agent rather
 * than to the card, in the start's order. One function for the start and the
 * picker, so a row the picker offers is a row the start accepts.
 */
function agentRefusal(
  row: AgentInstance,
  running: RunningDispatchRunInAgent | null,
  signIn: AgentInstance['signInState'] = row.signInState,
): AgentRunAgentRefusal | null {
  // `agent-image-update.md` Q8: an agent moving to a new image takes no run.
  if (row.state === 'hibernating' || row.state === 'deleting' || row.state === 'updating') {
    return 'agent_instance_state_conflict';
  }
  if (running) return 'agent_instance_run_active';
  if (!profileCanRunCards(row.profileId)) return 'agent_profile_cannot_run';
  if (!hasLauncher(row)) return 'agent_instance_image_too_old';
  if (signIn === 'signed_out') return 'agent_not_signed_in';
  return null;
}

/** The typed error for an agent refusal (the running run is named by the caller). */
function refusalError(
  refusal: Exclude<AgentRunAgentRefusal, 'agent_instance_run_active'>,
  row: AgentInstance,
): Error {
  const name = profileDisplayName(row.profileId);
  switch (refusal) {
    case 'agent_instance_state_conflict':
      return new AgentInstanceStateConflictError(row.id, row.state, 'given a run');
    case 'agent_profile_cannot_run':
      return new AgentProfileCannotRunError(row.profileId, name);
    case 'agent_instance_image_too_old':
      return new AgentInstanceImageTooOldError(row.id);
    case 'agent_not_signed_in':
      return new AgentNotSignedInError(row.id, name);
  }
}

/** A non-blank `sessionId` out of an event's `data`, else null (`null` and blank read as absent). */
function sessionIdOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const id = (data as Record<string, unknown>)['sessionId'];
  return typeof id === 'string' && id.trim() !== '' ? id : null;
}

/** The card a running run works on, for the refusal's words. */
async function targetKeyOf(workspaceId: string, runId: string): Promise<string | null> {
  const keys = await withWorkspaceServiceContext(workspaceId, (tx) =>
    dispatchRunRepository.findTargetKeys([runId], tx),
  );
  return keys.get(runId) ?? null;
}

/** A busy refusal, naming the running run's card when the run is known. */
async function namedBusy(
  err: DispatchRunAgentBusyError,
  workspaceId: string,
): Promise<DispatchRunAgentBusyError> {
  if (err.runId === null || err.workItemKey !== null) return err;
  return new DispatchRunAgentBusyError(
    err.agentInstanceId,
    err.runId,
    await targetKeyOf(workspaceId, err.runId),
  );
}

/** What the start reads about the card: a leaf's one leg, or a parent's legs in order. */
async function readyLegs(
  project: { id: string },
  item: { id: string; identifier: string },
  ctx: ServiceContext,
): Promise<{ legIds: string[]; isParent: boolean }> {
  const children = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.findChildren(item.id, tx),
  );
  if (children.length > 0) {
    const preview = await scopeClaimService.previewWorkItemScope(project.id, item.identifier, ctx);
    if (!preview.ok) throw new AgentRunCardNotReadyError(item.identifier, preview.detail);
    const edges = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemLinkRepository.findBlockedByAmong(
        preview.childIds,
        preview.childIds,
        ctx.workspaceId,
        tx,
      ),
    );
    return { legIds: orderLegs(preview.childIds, edges), isParent: true };
  }
  const state = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.findClaimStateById(item.id, tx),
  );
  /* v8 ignore next -- the row was resolved a moment ago; only a delete in between gets here */
  if (!state) throw new AgentRunCardNotReadyError(item.identifier, 'it no longer exists');
  if (!isClaimableState(state)) {
    throw new AgentRunCardNotReadyError(
      item.identifier,
      `it is ${state.status}, not in the to-do category`,
    );
  }
  const readiness = await workItemsService.getReadiness(item.id, ctx);
  if (!readiness.ready) {
    throw new AgentRunCardNotReadyError(item.identifier, 'it is waiting on an open blocker');
  }
  return { legIds: [item.id], isParent: false };
}

/** Every repository of the run writable by Motir's App — the hosted pre-flight (§4 check 7). */
async function assertRepositoriesWritable(
  projectId: string,
  legIds: string[],
  ctx: ServiceContext,
): Promise<void> {
  const repositories = await repositoriesForItems(projectId, ctx.workspaceId, legIds);
  const access = await hostedRunWriteAccess(repositories, 'write');
  const refusals = access.filter((a): a is Extract<typeof a, { ok: false }> => !a.ok);
  if (refusals.length > 0) {
    throw new HostedRunRepositoryNotWritableError(
      refusals.map(({ ok: _ok, app: _app, ...refusal }) => refusal as RunGitWriteRefusal),
      repositories.length,
    );
  }
}

async function readAgent(instanceId: string): Promise<AgentInstance | null> {
  return withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
}

/** One pass of the launch job's wait: go, stop, or come back at `deferUntil`. */
export type AgentRunWaitVerdict = 'ready' | 'noop' | 'failed' | { deferUntil: Date };

export const agentInstanceRunService = {
  /**
   * START a card's run in the caller's own agent (§4). Answers once the run is
   * open, its cards claimed and its launch enqueued; the launch job wakes nothing
   * and waits for the agent this start woke.
   *
   * Throws, with NOTHING opened, claimed, minted or woken: the access errors
   * (`PermissionDeniedError` for `instance:use`, `ProjectAccessDeniedError`),
   * `AgentInstanceNotFoundError`, `AgentInstanceWrongProjectError`,
   * `AgentInstanceStateConflictError`, `AgentRunCardNotReadyError`,
   * `DispatchRunAgentBusyError` (naming the running run and its card),
   * `AgentProfileCannotRunError`, `AgentInstanceImageTooOldError`,
   * `AgentNotSignedInError`, `HostedRunRepositoryNotWritableError`,
   * `AgentInstancesUnavailableError`, `CiCreditsExhaustedError`. Then the wake's
   * own refusals, UNCHANGED (`AgentInstanceStartRefusedError`, …) — still with
   * nothing opened. A failure after the open ends the run `failed` and is rethrown.
   */
  async start(input: StartAgentRunInput, ctx: ServiceContext): Promise<AgentRunStartedDto> {
    const identifier = input.workItemKey.trim().toUpperCase();
    const requested = input.command ?? DEFAULT_AGENT_RUN_COMMAND;
    if (!isAgentRunCommand(requested)) {
      throw new AgentRunCommandInvalidError(String(requested), AGENT_RUN_COMMANDS);
    }

    // ── 1 · Access: `instance:use` on the project and edit on the card ────────
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    await projectAccessService.assertPermission(project.id, ctx, 'instance:use');
    await projectAccessService.assertCanEdit(project.id, ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);

    // ── 0 · The same press again — answered with the run it already started ──
    if (input.idempotencyKey) {
      const key = input.idempotencyKey;
      const already = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        dispatchRunRepository.findByIdempotencyKey(ctx.workspaceId, key, tx),
      );
      if (already) {
        // The same key for a different command would answer a `run` to a caller
        // that asked for a `fix`, which reads as a fix that never starts.
        const startedAs = already.command === 'run_scope' ? 'run' : already.command;
        if (startedAs !== requested) {
          throw new AgentRunCommandMismatchError(already.id, already.command, requested);
        }
        return { dispatchRunId: already.id, created: false, woke: false };
      }
    }
    // The `hosted_runs` kill-switch (MOTIR-750): an agent run is a hosted run.
    await assertWorkspaceFeatureEnabled(ctx.workspaceId, 'hosted_runs');

    // ── 2 · The agent: the caller's, live, on the card's project ─────────────
    const agent = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => agentInstanceRepository.findLiveForOwner(input.agentInstanceId, ctx.userId, tx),
    );
    if (!agent) throw new AgentInstanceNotFoundError(input.agentInstanceId);
    if (agent.projectId !== project.id) throw new AgentInstanceWrongProjectError(agent.id);
    if (agent.state === 'hibernating' || agent.state === 'deleting' || agent.state === 'updating') {
      throw refusalError('agent_instance_state_conflict', agent);
    }

    // ── 3 · The card is ready ────────────────────────────────────────────────
    // A `fix` claims nothing and previews no scope (MOTIR-9049): it is decided by the
    // repair claim in step 9, so a story card or an `implemented` one is not refused here.
    const isFix = requested === 'fix';
    const { legIds, isParent } = isFix
      ? { legIds: [item.id], isParent: false }
      : await readyLegs(project, item, ctx);

    // ── 4 · No run already running in the agent (the index is the real guard) ─
    const running = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      dispatchRunRepository.findRunningByAgentInstance(agent.id, tx),
    );
    if (running) {
      throw new DispatchRunAgentBusyError(
        agent.id,
        running.id,
        await targetKeyOf(ctx.workspaceId, running.id),
      );
    }

    // ── 5, 6 · The profile, the image, the sign-in ───────────────────────────
    // The process-wide lane's check applies to an agent on it; one placed on an
    // account is reached through that account (MOTIR-9473).
    const laneMissing = agent.fleetShardId === null && !isPersistentOrchestratorConfigured();
    if (laneMissing || !isAgentTerminalConfigured()) {
      throw new AgentInstancesUnavailableError('an agent cannot be reached to start a run');
    }
    // A RUNNING agent is asked now (§4: the start's own live probe), and its answer
    // wins over the record; a sleeping one's last answer stands, and the launch
    // job asks again once it is up. A probe that gives no answer leaves the record.
    const live =
      agent.state === 'running' && agentRefusal(agent, null, 'unknown') === null
        ? await agentInstanceLifecycleService.probeSignIn(agent.id)
        : null;
    const refusal = agentRefusal(agent, null, live ?? agent.signInState);
    if (refusal !== null) {
      throw refusalError(
        refusal as Exclude<AgentRunAgentRefusal, 'agent_instance_run_active'>,
        agent,
      );
    }

    // ── 7 · Every repository writable; the CI-credit gate every dispatch runs ─
    await assertRepositoriesWritable(project.id, legIds, ctx);
    await ciAllowanceService.assertDispatchAllowed(ctx);

    // ── 8 · Wake, when the agent sleeps — its refusals pass through UNCHANGED ─
    let woke = false;
    if (agent.state === 'hibernated' || agent.state === 'failed') {
      const woken = await agentInstanceLifecycleService.wake(project.identifier, agent.id, ctx);
      if (woken.state === 'failed') {
        throw new AgentInstanceStateConflictError(agent.id, woken.state, 'given a run');
      }
      woke = true;
    }

    // ── 9 (fix) · The REPAIR CLAIM is the open (MOTIR-9049) ──────────────────
    // One claim under the card's row lock opens the `fix` run in this agent and writes
    // its ONE `run_opened`; nothing below the claim's own steps applies — no keyed
    // claim, no provenance, no second `run_opened`. No `admit`: every class is admitted.
    if (isFix) {
      // Read BEFORE the claim opens its own run, or the latest run would be this one.
      const last = (await agentInstanceRunService.resumeTargetForCard(identifier, ctx)).lastRun;
      const claim = await workItemRepairService.openAgentRepair(project.id, identifier, ctx, {
        origin: 'instance',
        resume:
          last?.agent && last.agentIsReaders
            ? { profile: last.agent.profile, sessionId: last.sessionId, canResume: last.canResume }
            : null,
        agent: agent.profileId,
        agentInstanceId: agent.id,
        idempotencyKey: input.idempotencyKey ?? randomUUID(),
      });
      if (claim.outcome !== 'claimed' || claim.runId === null) {
        throw new AgentRunRepairRefusedError(claim);
      }
      const runId = claim.runId;
      try {
        await sendEvent(
          'agent-instance-run/launch',
          {
            workspaceId: ctx.workspaceId,
            dispatchRunId: runId,
            idempotencyKey: agentRunLaunchKey(runId),
          },
          { strict: true },
        );
        await sendEvent(
          'agent-instance-run/supervise',
          {
            workspaceId: ctx.workspaceId,
            dispatchRunId: runId,
            idempotencyKey: agentRunSuperviseKey(runId),
          },
          { strict: true },
        );
        return { dispatchRunId: runId, created: true, woke };
      } catch (err) {
        await this.end(runId, 'failed', `the run could not start: ${detailOf(err)}`);
        throw err;
      }
    }

    // ── 9 · Open the run, one leg per card, `origin: instance` (§5) ──────────
    const legKeys = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const rows = await workItemRepository.findByIds(legIds, tx);
      const byId = new Map(rows.map((r) => [r.id, r.identifier]));
      return legIds.map((id) => byId.get(id) ?? '');
    });
    const command = requested === 'run' && isParent ? 'run_scope' : requested;
    let opened;
    try {
      opened = await dispatchRunService.open(
        {
          projectKey: project.identifier,
          command,
          origin: 'instance',
          reportedBy: 'cli',
          agentInstanceId: agent.id,
          agent: agent.profileId,
          idempotencyKey: input.idempotencyKey,
          cards: legKeys.map((key) => ({ key, disposition: 'queued' as const })),
          ...(isParent ? { scopeKey: identifier, scopeLabel: item.title } : {}),
        },
        ctx,
      );
    } catch (err) {
      // Lost the race to another start: the winner is named, with its card.
      if (err instanceof DispatchRunAgentBusyError) throw await namedBusy(err, ctx.workspaceId);
      throw err;
    }
    const run = opened.run;
    /* v8 ignore next -- race-only: two presses of one key both passed the read above */
    if (!opened.created) return { dispatchRunId: run.id, created: false, woke };

    try {
      await dispatchRunService.appendEvents(
        run.id,
        [
          {
            kind: 'run_opened',
            data: {
              command,
              key: identifier,
              origin: 'instance',
              agentInstanceId: agent.id,
              agent: agent.profileId,
            },
          },
        ],
        ctx,
      );

      // ── 10 · Claim and stamp every leg — `byok`, harness = the profile (§5) ─
      if (isParent) {
        const claim = await scopeClaimService.claimScope(
          { kind: 'work_item', projectId: project.id, identifier },
          ctx,
        );
        if (!claim.claimed) {
          throw new AgentRunCardNotReadyError(identifier, `its scope claim was ${claim.outcome}`);
        }
      } else {
        const claim = await workItemsService.claimWorkItem(project.id, identifier, ctx);
        if (claim.outcome !== 'claimed' && claim.outcome !== 'mine') {
          throw new AgentRunCardNotReadyError(identifier, `its claim was ${claim.outcome}`);
        }
      }
      await withWorkspaceContext(
        { userId: ctx.userId, workspaceId: ctx.workspaceId },
        async (tx) => {
          for (const id of legIds) {
            await workItemsService.recordImplementationProvenance(
              id,
              { source: 'byok', harness: agent.profileId, model: null },
              tx,
            );
          }
        },
      );

      // ── 11 · Hand the launch to its durable job — nothing secret in it ─────
      await sendEvent(
        'agent-instance-run/launch',
        {
          workspaceId: ctx.workspaceId,
          dispatchRunId: run.id,
          idempotencyKey: agentRunLaunchKey(run.id),
        },
        { strict: true },
      );
      // ── 12 · And its supervision (§6, MOTIR-7027): every run in an agent ENDS ─
      await sendEvent(
        'agent-instance-run/supervise',
        {
          workspaceId: ctx.workspaceId,
          dispatchRunId: run.id,
          idempotencyKey: agentRunSuperviseKey(run.id),
        },
        { strict: true },
      );
      return { dispatchRunId: run.id, created: true, woke };
    } catch (err) {
      await this.end(run.id, 'failed', `the run could not start: ${detailOf(err)}`);
      throw err;
    }
  },

  /**
   * THE LAUNCH JOB'S WAIT (§4) — one pass: `ready` once the run is still open and
   * its agent is `running`; `noop` for a run already closed (a cancel, a reap);
   * `failed` once the run was ended because its agent stopped or never came up.
   * An agent still `starting` / `waking` is READ, never settled (its boot driver owns it), and the answer is
   * `{ deferUntil }` — the job DEFERS to it (the engine's defer is the jobs
   * runtime's, never a service's).
   */
  async awaitAgent(dispatchRunId: string): Promise<AgentRunWaitVerdict> {
    const run = await withSystemContext((tx) => dispatchRunRepository.findById(dispatchRunId, tx));
    if (!run || run.status !== 'running' || !run.agentInstanceId) return 'noop';
    let agent = await readAgent(run.agentInstanceId);
    // AMENDMENT 6 §4: a boot is its driver's — this only READS how it stands and
    // defers while it runs, never settling it beside the driver.
    if (agent && agent.state === 'updating') {
      // The launch's wake applied a pinned update (Q5): the run starts on whichever
      // image the update settles on.
      await agentInstanceLifecycleService.settleUpdate(agent.id);
      agent = await readAgent(agent.id);
    }
    if (agent && !agent.deletedAt && agent.state === 'running') return 'ready';
    if (
      agent &&
      !agent.deletedAt &&
      (agent.state === 'starting' || agent.state === 'waking' || agent.state === 'updating')
    ) {
      const now = agentInstanceClock.now();
      if (now.getTime() - run.startedAt.getTime() < AGENT_RUN_BOOT_WAIT_MS) {
        return { deferUntil: new Date(now.getTime() + AGENT_RUN_LAUNCH_POLL_MS) };
      }
      await this.end(dispatchRunId, 'failed', 'the agent did not come up in time');
      return 'failed';
    }
    await this.end(dispatchRunId, 'failed', 'the agent stopped before the run could start');
    return 'failed';
  },

  /**
   * THE LAUNCH (§1, §2) — the launch job's memoized step, on a `running` agent:
   * the launcher and the sign-in read LIVE (a woken agent's boot probe has just
   * recorded both), then the run token minted and handed to
   * `motir agent-terminal run <KEY> --run-id <id>` on the exec's STDIN — never in
   * its argv, never in an environment. Any failure ends the run `failed` with
   * the reason in words, which revokes the token (§6 "the launch job finds …").
   * Returns JSON with no secret in it: the step memo is a database row.
   */
  async launchNow(dispatchRunId: string): Promise<'launched' | 'failed' | 'noop'> {
    const run = await withSystemContext((tx) => dispatchRunRepository.findById(dispatchRunId, tx));
    if (!run || run.status !== 'running' || !run.agentInstanceId || !run.createdById) {
      return 'noop';
    }
    const agent = await readAgent(run.agentInstanceId);
    // The account the agent lives in (MOTIR-9473): one that cannot be reached
    // refuses the run in words and is never sent to Fly.
    let reach: InstanceReach | null = null;
    if (agent && !agent.deletedAt && agent.state === 'running') {
      try {
        reach = await agentInstanceReach(agent);
      } catch (err) {
        await this.end(
          dispatchRunId,
          'failed',
          `the agent's account can't be reached: ${detailOf(err)}`,
        );
        return 'failed';
      }
    }
    if (!agent || agent.deletedAt || agent.state !== 'running' || !reach) {
      await this.end(dispatchRunId, 'failed', 'the agent stopped before the run could start');
      return 'failed';
    }
    const name = profileDisplayName(agent.profileId);
    if (!hasLauncher(agent)) {
      await this.end(dispatchRunId, 'failed', new AgentInstanceImageTooOldError(agent.id).message);
      return 'failed';
    }
    if ((await agentInstanceLifecycleService.probeSignIn(agent.id)) === 'signed_out') {
      await this.end(dispatchRunId, 'failed', new AgentNotSignedInError(agent.id, name).message);
      return 'failed';
    }

    const target = await targetKeyOf(run.workspaceId, run.id);
    /* v8 ignore next 4 -- every run this service opens has a scope or a first leg */
    if (!target) {
      await this.end(dispatchRunId, 'failed', 'the run names no card');
      return 'failed';
    }
    let detail: string;
    try {
      const credential = await runCredentialService.mintRunCredential({
        dispatchRunId,
        dispatcherUserId: run.createdById,
        expiresAt: latestRunCredentialExpiry(run.startedAt),
      });
      const result = await reach.orchestrator.exec(
        reach.handle,
        agentRunLaunchCommand(target, dispatchRunId, run.command),
        {
          timeoutSeconds: AGENT_RUN_LAUNCH_TIMEOUT_SECONDS,
          stdin: JSON.stringify({ apiUrl: resolveBaseUrlTrimmed(), token: credential.token }),
        },
      );
      const answer = parseLaunchAnswer(result);
      if (answer.ok) {
        await dispatchRunService.appendEvents(
          dispatchRunId,
          [
            {
              kind: 'log',
              body: `[motir] run started in agent ${agent.name} (${name})\n`,
              data: { agentInstanceId: agent.id, session: answer.session },
            },
          ],
          { userId: run.createdById, workspaceId: run.workspaceId },
        );
        await agentInstanceLifecycleService.touchActivity(agent.id);
        return 'launched';
      }
      detail = `the agent’s terminal server refused it (${answer.error})${launchDiagnostic(result)}`;
    } catch (err) {
      detail = detailOf(err);
    }
    await this.end(dispatchRunId, 'failed', `the run could not start in the agent: ${detail}`);
    return 'failed';
  },

  /**
   * THE END PATH of a run in an agent (§6) — the ONE function every end but the
   * CLI's own close calls. Revoke the run token and every App git token FIRST, so
   * the agent can push and report nothing more; then close the run ONLY IF it is
   * still open (the CLI in the agent closes the run it adopted), with a `log` line
   * naming why; then — when asked, and only when this call closed it — stop the
   * run's session in the agent (`motir agent-terminal stop --run-id`). A stop that
   * cannot reach the machine is not an error: the credentials are already dead,
   * and the CLI's next heartbeat is refused `409`, which it treats as closed.
   *
   * It mints and revokes no gateway key: there is none. It writes NO card status
   * on any end — no other end than the CLI's success moves a card
   * (`run-death-keeps-work.md` §3); closing settles the legs and recomputes the
   * cards' To fix reason, exactly as a failed hosted run's close does.
   * Idempotent, and never a throw.
   */
  async end(
    dispatchRunId: string,
    outcome: AgentRunEndOutcome,
    detail: string,
    options: { stopSession?: boolean } = {},
  ): Promise<AgentRunEndResult> {
    const runCredential = await this.revokeCredentials(dispatchRunId);

    const run = await withSystemContext((tx) => dispatchRunRepository.findById(dispatchRunId, tx));
    if (!run || run.status !== 'running' || !run.createdById) {
      return { closed: false, runCredential, sessionStop: 'not_asked' };
    }
    const ctx: ServiceContext = { userId: run.createdById, workspaceId: run.workspaceId };
    const close = CLOSE_FOR[outcome];
    try {
      // The closing line is written INSIDE the close's transaction, under its row
      // lock: a CLI close that commits first rolls it back with the refusal, so a
      // `succeeded` run never carries an "ended (cancelled)" line (MOTIR-7489).
      await dispatchRunService.close(
        dispatchRunId,
        { stopReason: close.stopReason, status: close.status },
        ctx,
        'wait',
        {
          // `message` is what the *run died* sentence reads to split a timeout.
          data: { end: outcome, message: detail },
          body: `[motir] run in agent ended (${close.label}): ${detail}\n`,
        },
      );
    } catch (err) {
      // The CLI (or another path) closed it between the read and the close: its
      // status stands, and this call wrote nothing.
      if (!(err instanceof DispatchRunTerminalError)) {
        /* v8 ignore next 4 -- a database fault mid end-path; the supervise job's next pass retries */
        console.error('[agentInstanceRunService] could not close the run', {
          dispatchRunId,
          detail: detailOf(err),
        });
      }
      return { closed: false, runCredential, sessionStop: 'not_asked' };
    }
    const sessionStop = options.stopSession
      ? await this.stopSession(dispatchRunId, run.agentInstanceId)
      : 'not_asked';
    return { closed: true, runCredential, sessionStop };
  },

  /**
   * Revoke a run's credentials — its run token and every App git token recorded
   * for it. Idempotent and never a throw: what it could not revoke stays recorded
   * and the next call tries again (the supervise job's closed-run pass is that
   * retry). Returns how many run tokens THIS call deleted.
   */
  async revokeCredentials(dispatchRunId: string): Promise<number> {
    let revoked = 0;
    try {
      revoked = (await runCredentialService.revokeRunCredential(dispatchRunId)).revoked;
    } catch (err) {
      /* v8 ignore next 4 -- a database fault mid end-path; the supervise job retries it */
      console.error('[agentInstanceRunService] could not revoke the run credential', {
        dispatchRunId,
        detail: detailOf(err),
      });
    }
    await revokeRunGitCredentials(dispatchRunId);
    return revoked;
  },

  /**
   * Stop a run's session in its agent (§1: `motir agent-terminal stop --run-id`).
   * `unreachable` when the agent is not running, has no handle, or the exec
   * failed — never a throw, because the run is already closed when this is asked.
   */
  async stopSession(
    dispatchRunId: string,
    agentInstanceId: string | null,
  ): Promise<'stopped' | 'unreachable'> {
    const agent = agentInstanceId ? await readAgent(agentInstanceId) : null;
    if (!agent || agent.deletedAt || agent.state !== 'running') return 'unreachable';
    try {
      const reach = await agentInstanceReach(agent);
      if (!reach) return 'unreachable';
      await reach.orchestrator.exec(reach.handle, agentRunStopCommand(dispatchRunId), {
        timeoutSeconds: AGENT_RUN_STOP_TIMEOUT_SECONDS,
      });
      return 'stopped';
    } catch (err) {
      console.warn('[agentInstanceRunService] the run session could not be stopped', {
        dispatchRunId,
        detail: detailOf(err),
      });
      return 'unreachable';
    }
  },

  /**
   * ONE PASS of a run's supervision (§6) — the `agent-instance-run/supervise`
   * job's body, in the decision's order:
   *
   *   1. the run has closed (the CLI, a cancel, the lifecycle, the reap): make
   *      sure its credentials are dead — the retry of a revoke that failed at the
   *      close — and stop (`closed`);
   *   2. the agent is no longer up (hibernated, failed, lost, deleted): close the
   *      run `failed`, *"the agent stopped"*;
   *   3. the latest event is older than the stall window (15 minutes): close
   *      `timed_out` and stop the session;
   *   4. the run has reached the 12-hour backstop: the same.
   *
   * Otherwise `{ deferUntil }`, a minute on — the job DEFERS to it. An agent still
   * `starting` / `waking` is up: the launch job owns that wait and its deadline.
   */
  async supervise(dispatchRunId: string): Promise<AgentRunSuperviseVerdict> {
    const run = await withSystemContext((tx) => dispatchRunRepository.findById(dispatchRunId, tx));
    if (!run) return 'closed';
    if (run.status !== 'running') {
      await this.revokeCredentials(dispatchRunId);
      return 'closed';
    }
    const agent = run.agentInstanceId ? await readAgent(run.agentInstanceId) : null;
    if (!agent || agent.deletedAt || !AGENT_UP.includes(agent.state)) {
      await this.end(dispatchRunId, 'failed', AGENT_RUN_END_DETAIL.agentStopped);
      return 'failed';
    }
    const now = agentInstanceClock.now().getTime();
    const latest = await withWorkspaceServiceContext(run.workspaceId, (tx) =>
      dispatchRunEventRepository.findLatestCreatedAt(dispatchRunId, tx),
    );
    const lastSign = Math.max(latest?.getTime() ?? 0, run.startedAt.getTime());
    if (now - lastSign >= hostedRunStallWindowMs()) {
      await this.end(dispatchRunId, 'stall', AGENT_RUN_END_DETAIL.stall, { stopSession: true });
      return 'stalled';
    }
    if (now - run.startedAt.getTime() >= AGENT_RUN_BACKSTOP_MS) {
      await this.end(dispatchRunId, 'backstop', AGENT_RUN_END_DETAIL.backstop, {
        stopSession: true,
      });
      return 'backstop';
    }
    return { deferUntil: new Date(now + AGENT_RUN_SUPERVISE_POLL_MS) };
  },

  /**
   * CANCEL a run in an agent (§6) — ONLY the agent's owner, because nobody else
   * can reach an agent (`agent-instances.md` §8); a project admin cannot, unlike a
   * hosted run. The run is closed `cancelled` through {@link end} — its
   * credentials revoked first — and THEN its session is stopped in the agent. A
   * machine that cannot be reached leaves the close standing.
   *
   * Refuses, each before anything is revoked: a run that does not exist, is in
   * another workspace, is not a run in an agent, or is on a project the caller
   * cannot browse (404 — no existence leak); a caller who is not the agent's
   * owner (403); a run already ended (409). A cancel racing the CLI's own close
   * resolves to whichever close landed first; the other writes nothing.
   */
  async cancel(dispatchRunId: string, ctx: ServiceContext): Promise<{ dispatchRunId: string }> {
    const run = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      dispatchRunRepository.findById(dispatchRunId, tx),
    );
    if (!run || run.workspaceId !== ctx.workspaceId || run.origin !== 'instance') {
      throw new AgentRunNotFoundError(dispatchRunId);
    }
    const agent = run.agentInstanceId ? await readAgent(run.agentInstanceId) : null;
    const owner = agent?.ownerId ?? run.createdById;
    if (owner !== ctx.userId) {
      try {
        await projectAccessService.assertCanBrowse(run.projectId, ctx);
      } catch {
        throw new AgentRunNotFoundError(dispatchRunId);
      }
      throw new AgentRunCancelForbiddenError(dispatchRunId);
    }
    if (run.status !== 'running') throw new AgentRunAlreadyEndedError(dispatchRunId, run.status);
    await this.end(dispatchRunId, 'cancelled', AGENT_RUN_END_DETAIL.cancelled, {
      stopSession: true,
    });
    return { dispatchRunId };
  },

  /**
   * Close the run RUNNING IN an agent, if there is one, through {@link end} — the
   * lifecycle's door (§6: the lost machine, the backstop and credit stops, a
   * machine that stopped behind Motir's back). The machine is going away or gone,
   * so no session is stopped. Returns whether a run was closed here.
   */
  async endRunningInAgent(
    agent: Pick<AgentInstance, 'id' | 'workspaceId'>,
    outcome: AgentRunEndOutcome,
    detail: string,
  ): Promise<boolean> {
    const running = await withWorkspaceServiceContext(agent.workspaceId, (tx) =>
      dispatchRunRepository.findRunningByAgentInstance(agent.id, tx),
    );
    if (!running) return false;
    return (await this.end(running.id, outcome, detail)).closed;
  },

  /**
   * The caller's OWN agents on the card's project, each with the run it is
   * running and why it cannot run this card, if it cannot (§4) — the card's
   * agent picker (MOTIR-7028). Another member's agent never appears (§8). A
   * bounded number of queries, whatever the count: one list, one running-run
   * read for all of them, one read of those runs' cards. A caller without
   * `instance:use` has no agents to offer.
   */
  /**
   * A card's LAST run read back for the door and the resume (MOTIR-9046): which
   * agent it ran in, the session id it recorded, whether that agent's profile has
   * a resume form. A caller without `instance:use` has no agent door, so gets
   * `{ lastRun: null }`.
   *
   * The session belongs to the card's LEG: that leg's newest `agent_exited`, else
   * its newest `agent_started`; only a run with NO leg for the card (a scope
   * target) falls back to the run-scoped read. A leg that recorded nothing answers
   * null — never another leg's id, which would resume a different card's conversation.
   */
  async resumeTargetForCard(
    workItemKey: string,
    ctx: ServiceContext,
  ): Promise<CardResumeTargetDto> {
    const identifier = workItemKey.trim().toUpperCase();
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);
    try {
      await projectAccessService.assertPermission(project.id, ctx, 'instance:use');
    } catch (err) {
      if (err instanceof PermissionDeniedError) return { lastRun: null };
      /* v8 ignore next -- the project was resolved above; browse cannot fail here */
      throw err;
    }
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id },
      async (tx) => {
        const run = await dispatchRunRepository.findLatestResumeRunForWorkItem(item.id, tx);
        if (!run) return { lastRun: null };
        const legId = run.cards[0]?.id ?? null;
        let sessionId: string | null = null;
        if (run.agentInstance) {
          for (const kind of ['agent_exited', 'agent_started'] as const) {
            const event = await dispatchRunEventRepository.findLatestOfKind(
              run.id,
              kind,
              tx,
              legId,
            );
            sessionId = sessionIdOf(event?.data);
            if (sessionId) break;
          }
        }
        return {
          lastRun: {
            id: run.id,
            command: run.command,
            status: run.status,
            startedAt: run.startedAt.toISOString(),
            endedAt: run.endedAt?.toISOString() ?? null,
            agent: toDispatchRunAgentInstanceDto(run.agentInstance),
            agentIsReaders: run.agentInstance?.ownerId === ctx.userId,
            sessionId,
            canResume: run.agentInstance ? profileCanResume(run.agentInstance.profileId) : false,
          },
        };
      },
    );
  },

  async listAgentsForCard(workItemKey: string, ctx: ServiceContext): Promise<AgentsForCardDto> {
    const identifier = workItemKey.trim().toUpperCase();
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);
    try {
      await projectAccessService.assertPermission(project.id, ctx, 'instance:use');
    } catch (err) {
      if (err instanceof PermissionDeniedError) return { agents: [] };
      /* v8 ignore next -- the project was resolved above; browse cannot fail here */
      throw err;
    }
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id },
      async (tx) => {
        const rows = await agentInstanceRepository.listLiveForOwner(
          { ownerId: ctx.userId, projectId: project.id, take: AGENT_LIST_LIMIT, skip: 0 },
          tx,
        );
        const running = await dispatchRunRepository.findRunningByAgentInstances(
          rows.map((r) => r.id),
          tx,
        );
        // The busy row names the run's work item by key AND title (MOTIR-7028).
        const targets = await dispatchRunRepository.findTargets(
          running.map((r) => r.id),
          tx,
        );
        const byAgent = new Map(running.map((r) => [r.agentInstanceId, r]));
        return {
          agents: rows.map((row) => {
            const run = byAgent.get(row.id) ?? null;
            const target = run ? targets.get(run.id) : undefined;
            return toAgentForCardDto(
              row,
              run
                ? {
                    id: run.id,
                    workItemKey: target?.key ?? null,
                    workItemTitle: target?.title ?? null,
                  }
                : null,
              // A RUNNING agent's recorded sign-in is a boot-time snapshot the
              // start re-asks live (below), so the picker must not refuse on it:
              // a row it offers is a row the start accepts (MOTIR-8869).
              agentRefusal(row, run, row.state === 'running' ? 'unknown' : row.signInState),
            );
          }),
        };
      },
    );
  },
};

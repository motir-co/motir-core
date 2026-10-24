import { randomUUID } from 'node:crypto';
import { assertOrgFeatureEnabled } from '@/lib/featureFlags/evaluate';
import type {
  AgentInstance,
  AgentInstanceInterval,
  AgentInstanceIntervalEndReason,
  AgentInstanceState,
  Prisma,
} from '@/generated/prisma/client';
import {
  FLEET_CONTAINER_SIZE,
  type PersistentContainerHandle,
  type PersistentContainerStatus,
} from '@motir/orchestrator';
import {
  CLONE_EXEC_TIMEOUT_SECONDS,
  INSTANCE_BOOT_DEADLINE_MS,
  INSTANCE_BOOT_EXIT_GRACE_MS,
  INSTANCE_HOME_PATH,
  INSTANCE_INLINE_UPDATE_WAIT_MS,
  INSTANCE_INLINE_STOP_WAIT_MS,
  INSTANCE_NAME_PATTERN,
  INSTANCE_SLOT_TTL_SECONDS,
  INSTANCE_VOLUME_SIZE_GB,
  isUnlimitedAgentOrg,
} from '@/lib/agentInstances/config';
import {
  AgentInstanceNameInvalidError,
  AgentInstanceNameTakenError,
  AgentInstanceNotFoundError,
  AgentInstanceRunActiveError,
  AgentInstanceStartRefusedError,
  AgentInstanceStateConflictError,
  AgentInstanceUpToDateError,
  AgentInstancesUnavailableError,
  AgentImageCatalogUnavailableError,
  AgentProfileNotOfferedError,
} from '@/lib/agentInstances/errors';
import { buildCloneCommand, installationBasicAuth } from '@/lib/agentInstances/cloneCommand';
import { AGENT_RUN_END_DETAIL } from '@/lib/agentInstances/runEnd';
import { planCapsService } from '@/lib/services/planCapsService';
import {
  AGENT_IDLE_COMMAND,
  AGENT_RUN_LAUNCHER_PROBE_COMMAND,
  AGENT_SIGN_IN_COMMAND,
  AGENT_SIGN_IN_TIMEOUT_SECONDS,
  AGENT_TERMINAL_PROBE_COMMAND,
  agentTerminalMachineConfig,
  isAgentTerminalConfigured,
  parseSignInAnswer,
  type AgentSignInAnswer,
} from '@/lib/agentInstances/terminal';
import { imageDigestResolver, pinnedImageReference } from '@/lib/agentInstances/imageDigest';
import { compareVersions, imageCatalog } from '@/lib/agentInstances/imageCatalog';
import {
  isOfferedProfile,
  livenessCommandFor,
  profileDisplayName,
  sandboxImageTag,
} from '@/lib/agentInstances/profiles';
import {
  intervalBillableSeconds,
  intervalChargeReference,
  statesThatMayEnter,
} from '@/lib/agentInstances/stateMachine';
import { checkAgentRunCredits } from '@/lib/ai/motirAiClient';
import { isCloudBilling } from '@/lib/billing/availability';
import type {
  AgentInstanceBootRowStepDto,
  AgentInstanceDto,
  AgentInstanceImageFields,
} from '@/lib/dto/agentInstances';
import { machineCreditsFor } from '@/lib/hostedRuns/machineRate';
import {
  endLineReason,
  isClosedRunInAgent,
  toAgentInstanceActiveRunDto,
  toAgentInstanceDto,
  toAgentInstanceLastRunDto,
} from '@/lib/mappers/agentInstanceMappers';
import type {
  AgentInstanceActiveRunDto,
  AgentInstanceLastRunDto,
  AgentInstanceListPageDto,
  AgentInstanceStopReason,
} from '@/lib/dto/agentInstances';
import {
  getPersistentOrchestrator,
  isPersistentOrchestratorConfigured,
  persistentOrchestratorForShard,
  type PersistentContainerOrchestrator,
} from '@/lib/orchestrator';
import { agentInstancePlacementService } from '@/lib/services/agentInstancePlacementService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { agentInstanceIntervalRepository } from '@/lib/repositories/agentInstanceIntervalRepository';
import {
  agentInstanceRepository,
  type AgentInstanceTransitionPatch,
} from '@/lib/repositories/agentInstanceRepository';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import type { AgentRunEndOutcome } from '@/lib/services/agentInstanceRunService';
import {
  agentInstanceActivityService,
  agentInstanceClock,
  armIdleTimer,
} from '@/lib/services/agentInstanceActivityService';
import {
  agentBootEventKey,
  agentInstanceBootService,
  type AgentBootOpened,
} from '@/lib/services/agentInstanceBootService';
import { agentInstanceBootRepository } from '@/lib/repositories/agentInstanceBootRepository';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { agentInstanceChargeService } from '@/lib/services/agentInstanceChargeService';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { aiPlanGateService } from '@/lib/services/aiPlanGateService';
import { deletionDateFor } from '@/lib/agentInstances/planLapse';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { fleetInFlightSlotRepository } from '@/lib/repositories/fleetInFlightSlotRepository';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  withSystemContext,
  withWorkspaceContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';

// THE AGENT-INSTANCE LIFECYCLE (Story MOTIR-6860 · MOTIR-6872) — create, wake,
// hibernate and delete a developer's own long-lived agent machine, under
// `docs/decisions/agent-instances.md`.
//
// ── THE SHAPE OF EVERY OPERATION ────────────────────────────────────────────
//   1. Resolve the project and assert `instance:use` on it (§8) — and, for an
//      existing instance, that the caller OWNS it: no key, a manager's included,
//      opens someone else's (`AgentInstanceNotFoundError` either way, so an id
//      that is not yours is indistinguishable from one that does not exist).
//   2. Refuse BEFORE anything is spent (§5, §6): the offered profile, the name,
//      the per-user cap, the credit pre-flight, and — under the fleet admission
//      lock, atomically with the slot take — the two running caps and the ceiling.
//   3. ONE guarded compare-and-set on the record (§4), in a transaction.
//   4. The Fly call AFTER that transaction commits (motir-core/CLAUDE.md: side
//      effects outside the transaction), and a guarded move to `failed` with the
//      reason in words if it fails — releasing whatever was held.
//
// ── THE INTERVAL OWNS THE SLOT ───────────────────────────────────────────────
// A running interval opens at the moment a create or wake takes its fleet slot,
// and the slot's `ownerRef` IS the interval id (§6, MOTIR-2160), so a stale
// release can never free a newer interval's slot. The interval's `startedAt` is
// Motir's own instant at open and is CORRECTED to Fly's start event when the
// machine is seen running (§5: Fly's event log first, Motir's instant the
// fallback) — so boot wait is never billed where Fly attests the start. Every
// close releases the slot, whatever closed it.
//
// ── SETTLING ────────────────────────────────────────────────────────────────
// Booting and stopping take Fly seconds, so each operation waits a bounded time
// in the request and then leaves the rest to the settle functions below, which
// are IDEMPOTENT and are also what the 5-minute sweep (MOTIR-6873) calls for any
// instance still in motion. Charging a closed interval is the sweep's too.

// ── A RUN IN THE AGENT (Story MOTIR-6864 · MOTIR-7027, `agent-instance-run.md` §6) ──
// A running run holds its agent: Hibernate and Delete are REFUSED, naming it
// (`AgentInstanceRunActiveError`), and the idle check skips the agent. When a
// machine stops for a reason no person chose — the 12-hour backstop, a credit
// stop, a machine lost or stopped behind Motir's back — its run is CLOSED FIRST
// through the run's one end path (`agentInstanceRunService.end`), so the record
// never shows a running run in a stopped agent. That service imports this one,
// so it is reached here by a dynamic import ({@link endRunIn}).

// The clock seam and the activity door live in `agentInstanceActivityService`
// (MOTIR-6940: the terminal relay imports them without this file's graph).
export { agentInstanceClock };

const STOP_REASONS: readonly string[] = ['credits', 'idle', 'backstop', 'admin_stop'];

/** The states an organisation-wide stop leaves alone and counts as already at rest. */
const RESTING_STATES: readonly AgentInstance['state'][] = ['hibernated', 'hibernating', 'failed'];

/** What {@link agentInstanceLifecycleService.hibernateAllForOrganization} did — never a throw. */
export interface AgentInstanceOrgHibernateResult {
  /** Running instances this call stopped, each settled to `hibernated`. */
  hibernated: number;
  /** Instances already hibernated, hibernating or failed: nothing to stop. */
  alreadyResting: number;
  /** Instances booting, waking, updating or being deleted — not running, so not stopped here. */
  inMotion: number;
  /** One entry per instance whose stop threw or did not confirm inline. */
  failures: { instanceId: string; detail: string }[];
}

interface ResolvedProject {
  id: string;
  workspaceId: string;
  organizationId: string;
}

async function resolveProject(projectKey: string, ctx: ServiceContext): Promise<ResolvedProject> {
  const project = await projectsService.getByKey(projectKey, ctx);
  await projectAccessService.assertPermission(project.id, ctx, 'instance:use');
  const organizationId = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workspaceRepository.findOrganizationId(ctx.workspaceId, tx),
  );
  /* v8 ignore next 3 -- every workspace belongs to an organisation (Story 6.10). */
  if (!organizationId) {
    throw new AgentInstancesUnavailableError('the workspace belongs to no organization');
  }
  return { id: project.id, workspaceId: ctx.workspaceId, organizationId };
}

function requireLane(): void {
  if (!isPersistentOrchestratorConfigured()) {
    throw new AgentInstancesUnavailableError('no instance fleet is configured');
  }
}

function inProject<T>(
  project: ResolvedProject,
  ctx: ServiceContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withWorkspaceContext(
    { userId: ctx.userId, workspaceId: project.workspaceId, projectId: project.id },
    fn,
  );
}

async function ownInstance(
  project: ResolvedProject,
  instanceId: string,
  ctx: ServiceContext,
  includeDeleted = false,
): Promise<AgentInstance> {
  const row = await inProject(project, ctx, (tx) =>
    includeDeleted
      ? agentInstanceRepository.findById(instanceId, tx)
      : agentInstanceRepository.findLiveForOwner(instanceId, ctx.userId, tx),
  );
  if (!row || row.projectId !== project.id || row.ownerId !== ctx.userId) {
    throw new AgentInstanceNotFoundError(instanceId);
  }
  return row;
}

/**
 * The persistent handle a row names, or null before `provisionPersistent`
 * answered. Exported for the run start (MOTIR-7026), which execs its launcher
 * through the same handle.
 */
export function agentInstanceHandle(row: AgentInstance): PersistentContainerHandle | null {
  return handleOf(row);
}

/** The handle through the PROCESS-WIDE orchestrator — for the paths the second
 *  routing card owns (run, exec, sweep, image update, liveness); create, wake,
 *  hibernate, boot and delete use {@link routeOf} (MOTIR-9472). */
function handleOf(row: AgentInstance): PersistentContainerHandle | null {
  return handleFor(row, getPersistentOrchestrator());
}

/** The handle the row names, through the orchestrator it was resolved to: its
 *  provider, and the zone the row records (none for an unplaced instance). */
function handleFor(
  row: AgentInstance,
  orchestrator: Pick<PersistentContainerOrchestrator, 'provider'>,
): PersistentContainerHandle | null {
  if (!row.flyApp || !row.machineId || !row.volumeId) return null;
  return {
    provider: orchestrator.provider,
    app: row.flyApp,
    machineId: row.machineId,
    volumeId: row.volumeId,
    region: row.region,
    createdAt: row.createdAt,
    ...(row.availabilityZone ? { availabilityZone: row.availabilityZone } : {}),
  };
}

/**
 * WHERE ONE INSTANCE IS REACHED (Story MOTIR-9361 · MOTIR-9472): the orchestrator
 * of the account recorded on the row — never the agent hoster's switch — and the
 * handle through it. Resolved per operation from the row that operation read, so
 * a retried stop or delete lands on the same account.
 */
async function routeOf(row: AgentInstance): Promise<{
  orchestrator: PersistentContainerOrchestrator;
  handle: PersistentContainerHandle | null;
}> {
  const orchestrator = await fleetShardOrchestratorService.persistentOrchestratorFor(row);
  return { orchestrator, handle: handleFor(row, orchestrator) };
}

function stopReasonOf(
  endReason: AgentInstanceIntervalEndReason | null,
): AgentInstanceStopReason | null {
  return endReason !== null && STOP_REASONS.includes(endReason)
    ? (endReason as AgentInstanceStopReason)
    : null;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown error';
}

/**
 * The paid-AI-plan gate (`agent-instance-storage.md` §1, MOTIR-6918): agents are an
 * AI-plan feature, so create and wake ask it FIRST — before the per-user cap, the
 * credits and any Fly call — and a tracker-only or Free-AI-tier organisation is
 * told it needs a plan, never that it is out of credits. The answer is the shared
 * gate's ({@link aiPlanGateService.hasPaidAiPlan}): it owns the paid statuses, the
 * self-hosted pass and Motir's own organisations (`isMeta` / `internalBilling`,
 * answered from their row without asking motir-ai), so none of that is re-derived
 * here. An answer it could not read refuses too — "could not ask" is never "yes".
 */
async function assertPaidAiPlan(organizationId: string): Promise<void> {
  const answer = await aiPlanGateService.hasPaidAiPlan(organizationId);
  if (answer === 'unknown') {
    throw new AgentInstanceStartRefusedError(
      'ai_plan_unknown',
      'Motir could not check your organization’s AI plan just now. Try again in a moment.',
    );
  }
  if (!answer) {
    throw new AgentInstanceStartRefusedError(
      'ai_plan_required',
      'Agents need a paid AI plan. Choose an AI plan to create or wake one.',
    );
  }
}

/** The two agent figures a create or wake is judged against — `null` is no cap. */
interface AgentPlanLimits {
  /** `agentsPerUser`: live agents one person may hold, judged at create. */
  perUser: number | null;
  /** `agentsRunningPerOrg`: agents the org may run at once, under the fleet lock. */
  runningPerOrg: number | null;
  /** The plan the refusals name, as motir-ai sends it; `null` when exempt. */
  planName: string | null;
}

/**
 * THE PLAN'S AGENT FIGURES (MOTIR-9374) — asked ONCE per create or wake, right
 * after {@link assertPaidAiPlan}, and passed down: never inside the fleet lock's
 * transaction, because the read may go to motir-ai. Motir's own organisations and
 * a build with no billing are `exempt` (no cap). A plan whose figures could not
 * be read — or whose key has no row — is REFUSED here, before any slot is taken:
 * there is no default figure and no "no limit" fallback (the fleet-capacity
 * decision record MOTIR-9357).
 */
async function readAgentPlanLimits(organizationId: string): Promise<AgentPlanLimits> {
  const answer = await planCapsService.capsFor(organizationId);
  if (answer.kind === 'exempt') return { perUser: null, runningPerOrg: null, planName: null };
  if (answer.kind === 'plan_unknown') {
    console.error('[agentInstanceLifecycleService] the plan has no agent figures — refusing', {
      organizationId,
      planKey: answer.planKey,
    });
    throw new AgentInstanceStartRefusedError(
      'plan_unknown',
      'Motir could not read the agent limits for your organization’s plan just now. Try again in a moment.',
    );
  }
  return {
    perUser: answer.caps.agentsPerUser,
    runningPerOrg: answer.caps.agentsRunningPerOrg,
    planName: answer.planName,
  };
}

/** "1 agent" / "5 agents". */
function agentsWord(n: number): string {
  return n === 1 ? '1 agent' : `${n} agents`;
}

/**
 * Is this one of Motir's own organisations, which have NO agent limits
 * (AMENDMENT 3, {@link isUnlimitedAgentOrg})? Read once per create, wake and sweep
 * pass from the org's own row. A row that cannot be read answers `false`: the
 * limits then apply, which is the side of the question that spends nothing.
 */
export async function readUnlimitedAgentOrg(organizationId: string): Promise<boolean> {
  try {
    const org = await withOrgServiceWriteContext(organizationId, (tx) =>
      organizationRepository.findByIdInTx(organizationId, tx),
    );
    return org ? isUnlimitedAgentOrg(org) : false;
  } catch (err) {
    console.error(
      '[agentInstanceLifecycleService] could not read the organization — limits apply',
      {
        organizationId,
        detail: describeError(err),
      },
    );
    return false;
  }
}

/**
 * The credit pre-flight (§5): may this organisation start a machine? A self-hosted
 * build charges nothing and asks nothing. An answer that could not be obtained
 * refuses too, with different words — "could not ask" is never "yes".
 */
async function assertCredits(organizationId: string): Promise<void> {
  if (!isCloudBilling()) return;
  const verdict = await checkAgentRunCredits(organizationId);
  if (verdict === null) {
    throw new AgentInstanceStartRefusedError(
      'credits_unknown',
      'Motir could not check your organization’s credits just now. Try again in a moment.',
    );
  }
  if (!verdict.mayRun) {
    throw new AgentInstanceStartRefusedError(
      'credits',
      'Your organization is out of credits. Agents use credits while they run and for their storage every day, asleep or not. Add credits to create or wake an agent.',
    );
  }
}

/**
 * Take a slot in the agents' OWN pool for one machine run, with the organisation's
 * running cap decided under the fleet admission lock (§6, AMENDMENTS 2 and 3). The
 * cap is the org's PLAN figure, `agentsRunningPerOrg` (MOTIR-9374), counted per
 * ORGANISATION, so one org at its limit never refuses another; an exempt org
 * (`runningPerOrg` null) has none.
 * The slot is keyed on the RUN (`runId`, the id of the run's first interval),
 * because the running charge splits one run into several intervals. Returns
 * whether THIS call took the slot (`reserved`) or found it held (`already_held`
 * — another create or wake for the instance is in flight, or a slot leaked);
 * throws the refusal in words otherwise.
 */
async function reserveSlot(input: {
  instanceId: string;
  runId: string;
  organizationId: string;
  workspaceId: string;
  limits: AgentPlanLimits;
}): Promise<'reserved' | 'already_held'> {
  const maxRunning = input.limits.runningPerOrg;
  const verdict = await fleetCeilingService.reserve({
    workload: 'agent_instance',
    ref: input.instanceId,
    ownerRef: input.runId,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    ttlSeconds: INSTANCE_SLOT_TTL_SECONDS,
    ...(maxRunning === null
      ? {}
      : {
          guard: async (tx: Prisma.TransactionClient, now: Date) => {
            // Running rows, plus the slots already taken for a create or wake
            // whose row has not moved yet, counted in one statement under this
            // lock, so two racers one below the figure cannot both pass (MOTIR-9374).
            const held = await fleetInFlightSlotRepository.listLiveForOrganization(
              input.organizationId,
              'agent_instance',
              now,
              tx,
            );
            const running = await agentInstanceRepository.countRunningOrAdmitting(
              input.organizationId,
              held.map((slot) => slot.ref),
              tx,
            );
            return running >= maxRunning ? ORG_RUNNING_CAP : null;
          },
        }),
  });
  if (verdict.outcome !== 'deferred') return verdict.outcome;
  if (
    verdict.reason === 'workload_cap' &&
    verdict.detail === ORG_RUNNING_CAP &&
    maxRunning !== null
  ) {
    const planName = input.limits.planName ?? '';
    throw new AgentInstanceStartRefusedError(
      'org_running_cap',
      `Your organization’s ${planName} plan runs ${agentsWord(maxRunning)} at once, and ${maxRunning} ${maxRunning === 1 ? 'is' : 'are'} running. Hibernate one to start another.`,
      maxRunning,
      planName,
    );
  }
  // The operator's kill switch, or an admission that could not be evaluated —
  // Motir's own pause, never another organisation's agents.
  throw new AgentInstanceStartRefusedError(
    'fleet_busy',
    'Motir is running as many machines as it can right now. Try again in a few minutes.',
  );
}

/** The guard's answer when the organisation's running cap refuses. */
const ORG_RUNNING_CAP = 'org_running_cap';

function releaseSlot(instanceId: string, runId: string): Promise<boolean> {
  return fleetCeilingService.release('agent_instance', instanceId, runId);
}

/**
 * Stamp the instance's slot with `runId`, the run that has just WON the move into
 * a running state after its reserve found the slot already held (MOTIR-7492).
 * The held slot names whichever attempt reserved it; if that attempt lost the
 * move, its release would otherwise delete the only slot this run is using.
 */
function adoptSlot(input: {
  instanceId: string;
  runId: string;
  organizationId: string;
  workspaceId: string;
}): Promise<boolean> {
  return fleetCeilingService.adopt({
    workload: 'agent_instance',
    ref: input.instanceId,
    ownerRef: input.runId,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    ttlSeconds: INSTANCE_SLOT_TTL_SECONDS,
  });
}

/**
 * Close the instance's open interval (if any) at `endedAt`, with `endReason`,
 * and release its run's slot — the machine run ends here. Idempotent: an instance with no open interval closes
 * nothing and releases nothing. Returns the closed interval, or null.
 */
async function closeOpenInterval(
  row: AgentInstance,
  endedAt: Date,
  endReason: AgentInstanceIntervalEndReason,
): Promise<AgentInstanceInterval | null> {
  const closed = await withWorkspaceServiceContext(row.workspaceId, async (tx) => {
    const open = await agentInstanceIntervalRepository.findOpen(row.id, tx);
    if (!open) return null;
    // A clock reading before the start (Fly's stop instant behind Motir's open
    // instant, on a machine that never really started) bills nothing.
    const end = endedAt.getTime() < open.startedAt.getTime() ? open.startedAt : endedAt;
    const moved = await agentInstanceIntervalRepository.close(
      open.id,
      { endedAt: end, endReason, billableSeconds: intervalBillableSeconds(open.startedAt, end) },
      tx,
    );
    return moved === 1 ? open : null;
  });
  if (closed) {
    await releaseSlot(row.id, closed.runId);
    // Charge it now (§5); a transport failure leaves it `pending` for the sweep.
    try {
      await agentInstanceChargeService.chargeInterval(closed.id);
    } catch (err) {
      console.error(
        '[agentInstanceLifecycle] the interval charge failed; the sweep will retry it',
        {
          instanceId: row.id,
          intervalId: closed.id,
          detail: describeError(err),
        },
      );
    }
  }
  return closed;
}

/** A guarded move made by the system (the settle paths): read, check, move. */
async function systemTransition(
  row: AgentInstance,
  from: readonly AgentInstanceState[],
  to: AgentInstanceState,
  patch: AgentInstanceTransitionPatch = {},
): Promise<boolean> {
  const moved = await withWorkspaceServiceContext(row.workspaceId, (tx) =>
    agentInstanceRepository.transition(row.id, from, to, agentInstanceClock.now(), patch, tx),
  );
  return moved === 1;
}

async function reload(row: AgentInstance): Promise<AgentInstance> {
  const fresh = await withWorkspaceServiceContext(row.workspaceId, (tx) =>
    agentInstanceRepository.findById(row.id, tx),
  );
  /* v8 ignore next -- a row is never hard-deleted. */
  if (!fresh) throw new AgentInstanceNotFoundError(row.id);
  return fresh;
}

/** The run running in this agent, with the card it works on, or null (§5's read). */
async function runningRunIn(
  row: AgentInstance,
): Promise<{ id: string; workItemKey: string | null } | null> {
  return withWorkspaceServiceContext(row.workspaceId, async (tx) => {
    const running = await dispatchRunRepository.findRunningByAgentInstance(row.id, tx);
    if (!running) return null;
    const keys = await dispatchRunRepository.findTargetKeys([running.id], tx);
    return { id: running.id, workItemKey: keys.get(running.id) ?? null };
  });
}

/** Refuse a person's Hibernate or Delete while a run is running in the agent (§6). */
async function assertNoRunningRun(
  row: AgentInstance,
  action: 'hibernated' | 'deleted' | 'updated',
): Promise<void> {
  const running = await runningRunIn(row);
  if (running)
    throw new AgentInstanceRunActiveError(row.id, running.id, running.workItemKey, action);
}

/**
 * Close the run running in this agent, if any, through the run's one end path —
 * BEFORE the machine it runs on is stopped or given up (§6). Never a throw.
 */
async function endRunIn(
  row: AgentInstance,
  outcome: AgentRunEndOutcome,
  detail: string,
): Promise<void> {
  const { agentInstanceRunService } = await import('@/lib/services/agentInstanceRunService');
  await agentInstanceRunService.endRunningInAgent(row, outcome, detail);
}

/** The words a run in an agent is closed with when its machine goes (§6). */
const RUN_MACHINE_LOST = 'the agent’s machine was lost';
const RUN_AGENT_STOPPED = 'the agent stopped';
const RUN_BOOT_FAILED = 'the agent stopped before the run could start';

/**
 * Move an instance to `failed` with its reason, closing its interval (`lost`) and
 * releasing its slot — and, first, closing the run running in it `failed` (§6).
 * A move that LOSES (a Delete got there first, AMENDMENT 4) closes nothing: the
 * winner owns the interval, and `settleDelete` closes it `deleted`.
 *
 * ⚠️ AND IT STOPS THE MACHINE (MOTIR-7343). `failed` is a resting state like
 * `hibernated`: its interval is closed and its slot released, so nobody is
 * charged for the machine from here on. Most ways in leave it RUNNING — a clone
 * or probe that failed on a booted machine, a boot past its deadline that may
 * still come up, a machine Fly reports `failed` — and the attribution reconciler
 * then stopped it, unbilled, ten minutes later. Stopped, never destroyed: the
 * home volume is kept, and Wake starts the same machine again. Best effort — a
 * refused stop is logged, the reconciler stays the backstop, and the move stands.
 */
async function failInstance(
  row: AgentInstance,
  reason: string,
  runDetail: string = RUN_MACHINE_LOST,
): Promise<void> {
  await endRunIn(row, 'failed', runDetail);
  const moved = await systemTransition(
    row,
    ['starting', 'waking', 'running', 'hibernating', 'updating'],
    'failed',
    {
      failureReason: reason,
      // An update that ends in `failed` (its rollback failed) pins nothing more.
      targetImageDigest: null,
      targetImageVersion: null,
    },
  );
  if (!moved) return;
  await closeOpenInterval(row, agentInstanceClock.now(), 'lost');
  if (!row.machineId) return;
  try {
    // Its own account's orchestrator (MOTIR-9472); an account that cannot be
    // resolved is logged like a refused stop, never sent to Fly.
    const { orchestrator, handle } = await routeOf(row);
    if (handle) await orchestrator.stop(handle);
  } catch (err) {
    console.warn(
      '[agentInstanceLifecycle] stop after failure failed; the reconciler will stop it',
      {
        instanceId: row.id,
        detail: describeError(err),
      },
    );
  }
}

/**
 * Why a boot that has not reached `running` is over, or null while it may still
 * get there (MOTIR-7336) — read by the boot driver while it waits on the machine.
 */
function bootFailureReason(
  row: AgentInstance,
  status: PersistentContainerStatus,
  now: number,
): string | null {
  const began = row.stateChangedAt.getTime();
  const exited =
    status.state === 'stopped' && status.stoppedAt !== null && status.stoppedAt.getTime() >= began;
  if (exited) {
    const code = status.exitCode ?? null;
    const stoppedFor = now - status.stoppedAt!.getTime();
    if (code === 0 || stoppedFor >= INSTANCE_BOOT_EXIT_GRACE_MS) {
      const said = code === null ? '' : ` (exit code ${code})`;
      return `The machine exited during boot${said}. Wake to try again, or delete it.`;
    }
  }
  if (now - began >= INSTANCE_BOOT_DEADLINE_MS) {
    const minutes = Math.round(INSTANCE_BOOT_DEADLINE_MS / 60_000);
    return `The machine did not finish starting within ${minutes} minutes. Wake to try again, or delete it.`;
  }
  return null;
}

/** What a clone exec said on failure: git's words, trimmed, with no credential in them. */
function cloneFailureDetail(result: { exitCode: number; stderr: string }, token: string): string {
  const words = result.stderr
    .split(token)
    .join('***')
    .split(installationBasicAuth(token))
    .join('***')
    .trim()
    .slice(0, 200);
  return words || `exit ${result.exitCode}`;
}

/**
 * Clone ONE repository (`owner/name`) into a booted instance — one exec per
 * repository (AMENDMENT 6 §1), so each repository starts, ends and fails on its
 * own. The clone SCRIPT is unchanged: a repository whose `.git` exists is skipped.
 * Returns null on success, else the failure's words with the token scrubbed.
 */
async function cloneRepository(
  handle: PersistentContainerHandle,
  repository: string,
  token: string,
): Promise<string | null> {
  const result = await getPersistentOrchestrator().exec(
    handle,
    buildCloneCommand([repository], token),
    { timeoutSeconds: CLONE_EXEC_TIMEOUT_SECONDS },
  );
  return result.exitCode === 0 ? null : cloneFailureDetail(result, token);
}

/**
 * THE TERMINAL-SERVER PROBE (`docs/decisions/agent-terminal.md` Q8 · MOTIR-6939):
 * on a booted machine whose pinned digest was not probed yet (a first boot, or a
 * digest that changed), run `motir agent-terminal --help` through the one `exec`
 * door and record whether the image serves a terminal. ONCE per digest — an
 * `absent` is an answer, never retried. It never fails the boot: the agent stays
 * usable either way, and a probe that could not run leaves `unknown` for the
 * next boot. Skipped while the terminal is off on this deployment.
 */
async function probeTerminalServer(
  row: AgentInstance,
  handle: PersistentContainerHandle,
): Promise<void> {
  if (row.terminalServerDigest === row.imageDigest) return;
  try {
    if (!isAgentTerminalConfigured()) return;
    const result = await getPersistentOrchestrator().exec(handle, AGENT_TERMINAL_PROBE_COMMAND, {
      timeoutSeconds: 30,
    });
    // A negative code is an exec whose answer carried no exit code: not an answer.
    if (result.exitCode < 0) return;
    await withWorkspaceServiceContext(row.workspaceId, (tx) =>
      agentInstanceRepository.recordTerminalServer(
        row.id,
        { terminalServer: result.exitCode === 0 ? 'present' : 'absent', digest: row.imageDigest },
        tx,
      ),
    );
  } catch (err) {
    console.warn('[agentInstanceLifecycle] the terminal-server probe did not answer', {
      instanceId: row.id,
      detail: describeError(err),
    });
  }
}

/**
 * THE SIGN-IN QUERY (`agent-instance-run.md` §4 · MOTIR-7026): ask the agent's
 * terminal server whether its coding agent is signed in, and record the answer
 * with its time. Never a throw: an exec that failed or gave no answer returns
 * null and leaves the recorded value standing — "could not ask" is not an answer.
 */
async function probeSignIn(
  row: AgentInstance,
  handle: PersistentContainerHandle,
): Promise<AgentSignInAnswer | null> {
  try {
    const state = parseSignInAnswer(
      await getPersistentOrchestrator().exec(handle, AGENT_SIGN_IN_COMMAND, {
        timeoutSeconds: AGENT_SIGN_IN_TIMEOUT_SECONDS,
      }),
    );
    if (state === null) return null;
    await withWorkspaceServiceContext(row.workspaceId, (tx) =>
      agentInstanceRepository.recordSignIn(
        row.id,
        { signInState: state, at: agentInstanceClock.now() },
        tx,
      ),
    );
    return state;
  } catch (err) {
    console.warn('[agentInstanceLifecycle] the sign-in query did not answer', {
      instanceId: row.id,
      detail: describeError(err),
    });
    return null;
  }
}

/**
 * THE RUN PROBES AT A BOOT (`agent-instance-run.md` §4 · MOTIR-7026), beside the
 * terminal-server probe: whether the image carries the run launcher — ONCE per
 * digest, `motir agent-terminal run --help` exiting 0 — and the coding agent's
 * sign-in, every boot. Never fails the boot. Skipped while the terminal is off:
 * the launcher is the terminal server's, so there is nothing to ask.
 */
async function probeRunCapabilities(
  row: AgentInstance,
  handle: PersistentContainerHandle,
): Promise<void> {
  if (!isTerminalOnQuietly()) return;
  try {
    if (row.runLauncherDigest !== row.imageDigest) {
      const result = await getPersistentOrchestrator().exec(
        handle,
        AGENT_RUN_LAUNCHER_PROBE_COMMAND,
        { timeoutSeconds: 30 },
      );
      if (result.exitCode >= 0) {
        await withWorkspaceServiceContext(row.workspaceId, (tx) =>
          agentInstanceRepository.recordRunLauncher(
            row.id,
            { runLauncher: result.exitCode === 0 ? 'present' : 'absent', digest: row.imageDigest },
            tx,
          ),
        );
      }
    }
  } catch (err) {
    console.warn('[agentInstanceLifecycle] the run-launcher probe did not answer', {
      instanceId: row.id,
      detail: describeError(err),
    });
  }
  await probeSignIn(row, handle);
}

/** {@link isAgentTerminalConfigured}, reading a misconfigured key as "off" (the probes never throw). */
function isTerminalOnQuietly(): boolean {
  try {
    return isAgentTerminalConfigured();
  } catch {
    return false;
  }
}

/**
 * Each listed agent's live run, and — for an agent with none — its latest closed
 * run (MOTIR-7029: the panel's run line and its "Last run" face). A BOUNDED number
 * of queries whatever the count of agents: the running runs, the latest runs of
 * the idle agents, those runs' cards, and the closing lines of the ones that did
 * not succeed — each one query, each skipped when it has nothing to ask.
 */
async function readAgentRuns(
  agentIds: readonly string[],
  tx: Prisma.TransactionClient,
): Promise<{
  active: Map<string, AgentInstanceActiveRunDto>;
  last: Map<string, AgentInstanceLastRunDto>;
}> {
  const running = await dispatchRunRepository.findRunningByAgentInstances(agentIds, tx);
  const busy = new Set(running.map((r) => r.agentInstanceId));
  const latest = (
    await dispatchRunRepository.findLatestByAgentInstances(
      agentIds.filter((id) => !busy.has(id)),
      tx,
    )
  ).filter(isClosedRunInAgent);
  const targets = await dispatchRunRepository.findTargetCards(
    [...running, ...latest].map((r) => r.id),
    tx,
  );
  const reasons = new Map<string, string | null>();
  for (const line of await dispatchRunEventRepository.listEndLinesForRuns(
    latest.filter((r) => r.status !== 'succeeded').map((r) => r.id),
    tx,
  )) {
    // Newest first: the first line seen for a run is its closing line.
    if (!reasons.has(line.dispatchRunId)) reasons.set(line.dispatchRunId, endLineReason(line.data));
  }
  const active = new Map<string, AgentInstanceActiveRunDto>();
  for (const run of running) {
    active.set(run.agentInstanceId, toAgentInstanceActiveRunDto(run, targets.get(run.id) ?? null));
  }
  const last = new Map<string, AgentInstanceLastRunDto>();
  for (const run of latest) {
    last.set(
      run.agentInstanceId,
      toAgentInstanceLastRunDto(run, targets.get(run.id) ?? null, reasons.get(run.id) ?? null),
    );
  }
  return { active, last };
}

async function waitFor(deadlineMs: number, done: () => Promise<boolean>): Promise<boolean> {
  const deadline = agentInstanceClock.now().getTime() + deadlineMs;
  for (;;) {
    if (await done()) return true;
    if (agentInstanceClock.now().getTime() >= deadline) return false;
    await agentInstanceClock.sleep(agentInstanceClock.pollIntervalMs);
  }
}

/**
 * Hand a boot to its driver (AMENDMENT 6 §5): `provision` recorded done, then the
 * `agent-instance/boot` event — AFTER the opening transaction committed. A lost
 * send leaves an attempt nobody leased, which the sweep resends.
 */
async function handOverBoot(row: AgentInstance, boot: AgentBootOpened | null): Promise<void> {
  /* v8 ignore next -- every create and every `waking` wake opened an attempt */
  if (!boot) return;
  await agentInstanceBootService.recordProvision(row, boot.attempt, null);
  await sendEvent('agent-instance/boot', boot.event);
}

/** The catalog could not be asked: shown as "could not check", never as up to date. */
const UNKNOWN_IMAGE: AgentInstanceImageFields = { imageVersion: null, update: 'unknown' };

/**
 * The catalog's answer for each row (`agent-image-update.md` Q1, MOTIR-6949):
 * its version and its update offer. The catalog caches per profile, so a page of
 * N agents across P profiles reads the registry at most P times per window.
 * Never throws: a catalog failure is `unknown` on the rows it touched.
 */
async function imageFieldsFor(
  rows: readonly AgentInstance[],
): Promise<Map<string, AgentInstanceImageFields>> {
  // No instance lane on this deployment: nothing could be updated, and a list
  // read must not reach a registry for it.
  if (!isPersistentOrchestratorConfigured()) return new Map();
  const answers = await Promise.all(
    rows.map(async (row): Promise<[string, AgentInstanceImageFields]> => {
      try {
        return [row.id, await imageCatalog.updateFor(row.profileId, row.imageDigest)];
      } catch (err) {
        console.warn('[agentInstanceLifecycle] the image catalog failed', {
          instanceId: row.id,
          detail: describeError(err),
        });
        return [row.id, UNKNOWN_IMAGE];
      }
    }),
  );
  return new Map(answers);
}

async function toDtoWithImage(row: AgentInstance): Promise<AgentInstanceDto> {
  const image = await imageFieldsFor([row]);
  return toAgentInstanceDto(row, image.get(row.id) ?? UNKNOWN_IMAGE);
}

// ── THE IMAGE UPDATE (`docs/decisions/agent-image-update.md` Q2–Q8, MOTIR-6952) ──

/** Q3: the new image must report started within this, or it is rolled back. */
export const UPDATE_START_DEADLINE_MS = 5 * 60_000;
/** Q4: the rollback must reach `running` within this, or the agent is `failed`. */
export const UPDATE_ROLLBACK_DEADLINE_MS = 5 * 60_000;

/** The digest-pinned reference a machine boots for one of this agent's digests. */
function imageRef(row: AgentInstance, digest: string): string {
  return pinnedImageReference(row.imageTag, digest);
}

/** A version as words: the recorded one, or "its previous build" when none was. */
function versionWords(version: string | null): string {
  return version ?? 'its previous build';
}

/**
 * Before a wake starts a STOPPED machine, put the right image on it (Q4, Q5):
 * the pinned TARGET when this wake applies an update, else the record's own
 * digest — which is how a wake after a failed rollback puts the agent back on
 * the image it last ran. A machine already on that image is left untouched. A
 * move that is refused while applying a target is not fatal: the wake boots the
 * old image and the update's settle reports the refusal as a rollback.
 */
async function alignMachineImage(
  row: AgentInstance,
  handle: PersistentContainerHandle,
  target: string | null,
  orchestrator: PersistentContainerOrchestrator,
): Promise<void> {
  const want = imageRef(row, target ?? row.imageDigest);
  const status = await orchestrator.describePersistent(handle);
  if (!status.image || status.image === want) return;
  try {
    await orchestrator.moveImage(handle, want, { launch: false });
  } catch (err) {
    if (!target) throw err;
    await withWorkspaceServiceContext(row.workspaceId, (tx) =>
      agentInstanceRepository.patchImage(
        row.id,
        ['updating'],
        {
          updateFailureReason:
            `The update to ${row.targetImageVersion ?? 'the newer version'} didn’t work: ` +
            `${describeError(err)}. Your agent is back on ${versionWords(row.imageVersion)}.`,
          updateFailedAt: agentInstanceClock.now(),
        },
        tx,
      ),
    );
  }
}

/**
 * Q4: the new image failed. Record the reason (the agent STAYS `updating`, its
 * `updateFailedAt` starting the rollback's clock), then move the machine back to
 * the record's digest — the one it ran before, because `imageDigest` changes
 * only on success. A rollback that cannot even be asked for fails the agent.
 * Never touches the volume.
 */
async function beginRollback(row: AgentInstance, detail: string): Promise<void> {
  const reason =
    `The update to ${row.targetImageVersion ?? 'the newer version'} didn’t work: ${detail}. ` +
    `Your agent is back on ${versionWords(row.imageVersion)}.`;
  const recorded = await withWorkspaceServiceContext(row.workspaceId, (tx) =>
    agentInstanceRepository.patchImage(
      row.id,
      ['updating'],
      { updateFailureReason: reason, updateFailedAt: agentInstanceClock.now() },
      tx,
    ),
  );
  if (recorded !== 1) return;
  const handle = handleOf(row);
  /* v8 ignore next -- an updating agent always has a handle. */
  if (!handle) return;
  try {
    await getPersistentOrchestrator().moveImage(handle, imageRef(row, row.imageDigest), {
      launch: true,
    });
  } catch (err) {
    await failInstance(
      row,
      `The update to ${row.targetImageVersion ?? 'the newer version'} didn’t work, and your ` +
        `agent couldn’t be brought back on ${versionWords(row.imageVersion)}: ${describeError(err)}. ` +
        'Wake to try again, or delete it.',
      RUN_MACHINE_LOST,
    );
  }
}

/**
 * The boot's step functions, for the boot driver (`agentInstanceBootService`,
 * `agent-instances.md` AMENDMENT 6 §3) — the same clone, probes and failure path
 * a boot always used, so the driver changes who calls them, never what they do.
 */
export const agentInstanceBootSteps = {
  /** The caller's own agent in the project, or `AgentInstanceNotFoundError` (§8's gate). */
  handleOf,
  routeOf,
  reload,
  failInstance,
  bootFailureReason,
  cloneRepository,
  probeTerminalServer,
  probeRunCapabilities,
  isTerminalOnQuietly,
  describeError,
  RUN_BOOT_FAILED,
};

export const agentInstanceLifecycleService = {
  /**
   * The caller's own instance on the project, behind `instance:use` — the boot
   * read's gate (MOTIR-7399). `includeDeleted` is for a boot stream already open:
   * its owner is still owed the last word on an agent deleted mid-boot.
   */
  async ownedInstance(
    projectKey: string,
    instanceId: string,
    ctx: ServiceContext,
    includeDeleted = false,
  ): Promise<AgentInstance> {
    return ownInstance(await resolveProject(projectKey, ctx), instanceId, ctx, includeDeleted);
  },

  /** The caller's own live instances on the project, newest first, one page (§4, §8). */
  async list(
    projectKey: string,
    page: { take: number; skip: number },
    ctx: ServiceContext,
  ): Promise<AgentInstanceListPageDto> {
    const project = await resolveProject(projectKey, ctx);
    const now = agentInstanceClock.now();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    // The banner's date (MOTIR-6921), from the org's own recorded lapse — the one
    // date every scheduled row of this org carries. Never for Motir's own orgs.
    const org = await withOrgServiceWriteContext(project.organizationId, (tx) =>
      organizationRepository.findByIdInTx(project.organizationId, tx),
    );
    const planLapse =
      org?.aiPlanLapsedAt && !isUnlimitedAgentOrg(org)
        ? { deletesOn: deletionDateFor(org.aiPlanLapsedAt).toISOString() }
        : null;
    const page_ = await inProject(project, ctx, async (tx) => {
      const scope = { ownerId: ctx.userId, projectId: project.id };
      const rows = await agentInstanceRepository.listLiveForOwner({ ...scope, ...page }, tx);
      const total = await agentInstanceRepository.countLiveForOwner(scope, tx);
      const intervals = await agentInstanceIntervalRepository.listForInstancesSince(
        rows.map((r) => r.id),
        monthStart,
        tx,
      );
      const latestClosed = new Map(
        (
          await agentInstanceIntervalRepository.listLatestClosedForInstances(
            rows.filter((r) => r.state === 'hibernated').map((r) => r.id),
            tx,
          )
        ).map((i) => [i.agentInstanceId, i.endReason]),
      );
      const usage = new Map<string, { seconds: number; credits: number }>();
      for (const interval of intervals) {
        // Only the part of an interval inside this month counts; an open one runs to now.
        const from = interval.startedAt < monthStart ? monthStart : interval.startedAt;
        const to = interval.endedAt ?? now;
        const seconds = intervalBillableSeconds(from, to);
        const credits = interval.credits ?? machineCreditsFor(seconds, to);
        const acc = usage.get(interval.agentInstanceId) ?? { seconds: 0, credits: 0 };
        usage.set(interval.agentInstanceId, {
          seconds: acc.seconds + seconds,
          credits: acc.credits + credits,
        });
      }
      const runs = await readAgentRuns(
        rows.map((r) => r.id),
        tx,
      );
      const booting = await agentInstanceBootRepository.listInProgressForInstances(
        rows.filter((r) => r.state === 'starting' || r.state === 'waking').map((r) => r.id),
        tx,
      );
      // The first in progress in read-out order names the row.
      const bootSteps = new Map<string, AgentInstanceBootRowStepDto>();
      for (const s of booting) {
        if (!bootSteps.has(s.agentInstanceId))
          bootSteps.set(s.agentInstanceId, { step: s.step, repository: s.repository });
      }
      return { total, rows, usage, latestClosed, runs, bootSteps };
    });
    // The registry is asked OUTSIDE the transaction, once per profile per cache
    // window (`agent-image-update.md` Q1) — never once per row.
    const image = await imageFieldsFor(page_.rows);
    const { usage, latestClosed, runs, bootSteps } = page_;
    return {
      total: page_.total,
      planLapse,
      instances: page_.rows.map((row) => ({
        ...toAgentInstanceDto(row, image.get(row.id) ?? UNKNOWN_IMAGE),
        profileName: profileDisplayName(row.profileId),
        machineSecondsThisMonth: usage.get(row.id)?.seconds ?? 0,
        creditsThisMonth: usage.get(row.id)?.credits ?? 0,
        stopReason: stopReasonOf(latestClosed.get(row.id) ?? null),
        scheduledDeletionAt: row.scheduledDeletionAt?.toISOString() ?? null,
        activeRun: runs.active.get(row.id) ?? null,
        lastRun: runs.last.get(row.id) ?? null,
        bootStep: bootSteps.get(row.id) ?? null,
      })),
    };
  },

  /**
   * Create an instance (§1, §4): refuse or boot. On success the instance answers
   * `starting` (AMENDMENT 6 §5): its boot attempt is opened in the insert's
   * transaction and handed to the `agent-instance/boot` driver once it commits,
   * which clones the project's repositories and moves it to `running` or `failed`.
   */
  async create(
    projectKey: string,
    input: { name: string; profileId: string },
    ctx: ServiceContext,
  ): Promise<AgentInstanceDto> {
    const project = await resolveProject(projectKey, ctx);
    requireLane();
    // The `hosted_runs` kill-switch (MOTIR-750) refuses NEW agent instances.
    await assertOrgFeatureEnabled(project.organizationId, 'hosted_runs');
    const name = input.name.trim();
    if (!INSTANCE_NAME_PATTERN.test(name)) throw new AgentInstanceNameInvalidError();
    if (!isOfferedProfile(input.profileId)) {
      throw new AgentProfileNotOfferedError(input.profileId, profileDisplayName(input.profileId));
    }

    await assertPaidAiPlan(project.organizationId);
    const limits = await readAgentPlanLimits(project.organizationId);
    const unlimited = await readUnlimitedAgentOrg(project.organizationId);
    if (limits.perUser !== null) {
      const perUser = limits.perUser;
      const mine = await withSystemContext((tx) =>
        agentInstanceRepository.countLiveForOwnerEverywhere(ctx.userId, tx),
      );
      if (mine >= perUser) {
        const planName = limits.planName ?? '';
        throw new AgentInstanceStartRefusedError(
          'user_cap',
          `Your organization’s ${planName} plan allows ${agentsWord(perUser)} per person, and you already have ${mine}. Each one is charged for its storage every day, even asleep. Delete one to create another.`,
          perUser,
          planName,
        );
      }
    }
    const clash = await inProject(project, ctx, (tx) =>
      agentInstanceRepository.findLiveForOwnerByName(
        { ownerId: ctx.userId, projectId: project.id, name },
        tx,
      ),
    );
    if (clash) throw new AgentInstanceNameTakenError(name);

    if (!unlimited) await assertCredits(project.organizationId);
    const imageTag = sandboxImageTag(input.profileId);
    const imageDigest = await imageDigestResolver.resolve(imageTag);
    // Q1, Q6: the version is recorded at create, best effort — a registry that
    // cannot name it leaves it null, to be named by digest at read.
    const named = await imageCatalog.versionOf(input.profileId, imageDigest).catch(() => null);
    const imageVersion = named === 'unknown' ? null : named;

    const instanceId = randomUUID();
    // Before anything is taken: a misconfigured master key refuses here, loudly.
    const terminal = agentTerminalMachineConfig(instanceId);
    const intervalId = randomUUID();
    await reserveSlot({
      instanceId,
      runId: intervalId,
      organizationId: project.organizationId,
      workspaceId: project.workspaceId,
      limits,
    });

    const orchestrator = getPersistentOrchestrator();
    const region = orchestrator.defaultRegion();
    const openedAt = agentInstanceClock.now();
    let row: AgentInstance;
    let boot = null as AgentBootOpened | null;
    try {
      row = await inProject(project, ctx, async (tx) => {
        const created = await agentInstanceRepository.create(
          {
            id: instanceId,
            workspaceId: project.workspaceId,
            organizationId: project.organizationId,
            projectId: project.id,
            ownerId: ctx.userId,
            name,
            profileId: input.profileId,
            imageTag,
            imageDigest,
            imageVersion,
            region,
            // The boot's start, on the clock its deadline is read against (MOTIR-7336).
            stateChangedAt: openedAt,
          },
          tx,
        );
        await agentInstanceIntervalRepository.open(
          {
            id: intervalId,
            workspaceId: project.workspaceId,
            organizationId: project.organizationId,
            agentInstanceId: instanceId,
            runId: intervalId,
            runStartedAt: openedAt,
            startedAt: openedAt,
            chargeReference: intervalChargeReference(intervalId),
          },
          tx,
        );
        // AMENDMENT 6 §5: attempt 1 is the opener's write, in the insert's transaction.
        boot = await agentInstanceBootService.start(created, 'create', tx);
        return created;
      });
    } catch (err) {
      await releaseSlot(instanceId, intervalId);
      // The partial unique index: a concurrent create won the same name.
      if (isUniqueViolation(err)) throw new AgentInstanceNameTakenError(name);
      throw err;
    }

    try {
      // WHERE IT LIVES (MOTIR-9472): placement reads the agent hoster's switch,
      // once, here. Fly is today's path; an AWS account records itself and the
      // handle; a full pool creates nothing anywhere and leaves the boot where it
      // is before any machine exists, for the waiting card to take up.
      const placed = await agentInstancePlacementService.placeAndProvision(
        {
          instanceId,
          organizationId: project.organizationId,
          workspaceId: project.workspaceId,
          spec: {
            orgId: project.organizationId,
            workspaceId: project.workspaceId,
            projectId: project.id,
            instanceId,
            image: pinnedImageReference(imageTag, imageDigest),
            size: FLEET_CONTAINER_SIZE,
            // No credential of the user's, and none of Motir's: the instance knows only
            // which record it is (§9's rule — Motir never pre-fills a sign-in).
            env: { MOTIR_INSTANCE_ID: instanceId },
            volumeSizeGb: INSTANCE_VOLUME_SIZE_GB,
            mountPath: INSTANCE_HOME_PATH,
            // agent-terminal.md Q2–Q4: the terminal server as the main process, its
            // public service, and the per-instance key (`MOTIR_TERMINAL_KEY`) — a key
            // that opens only this machine's shell, never a credential of the user's.
            terminal,
            // With the terminal off, a main process that stays up (MOTIR-7336).
            idleCommand: terminal ? null : AGENT_IDLE_COMMAND,
          },
        },
        { persistentOrchestratorForShard, flyOrchestrator: () => orchestrator },
      );
      if (placed.outcome === 'fly') {
        const { handle } = placed;
        await withWorkspaceServiceContext(project.workspaceId, (tx) =>
          agentInstanceRepository.setHandle(
            instanceId,
            { flyApp: handle.app, machineId: handle.machineId, volumeId: handle.volumeId },
            tx,
          ),
        );
      }
    } catch (err) {
      const detail = describeError(err);
      if (boot) await agentInstanceBootService.recordProvision(row, boot.attempt, detail);
      await failInstance(row, `The machine could not be created: ${detail}`);
      return await toDtoWithImage(await reload(row));
    }

    // AMENDMENT 6 §5: the boot is the driver's from here; the answer is `starting`.
    await handOverBoot(row, boot);
    return await toDtoWithImage(await reload(row));
  },

  /** Wake a `hibernated` or `failed` instance (§2, §4): refuse or start. Every wake is a cold boot. */
  async wake(
    projectKey: string,
    instanceId: string,
    ctx: ServiceContext,
  ): Promise<AgentInstanceDto> {
    const project = await resolveProject(projectKey, ctx);
    requireLane();
    // …and refuses WAKING one: a woken agent is a running hosted container.
    await assertOrgFeatureEnabled(project.organizationId, 'hosted_runs');
    const row = await ownInstance(project, instanceId, ctx);
    const from = statesThatMayEnter('waking');
    if (!from.includes(row.state))
      throw new AgentInstanceStateConflictError(row.id, row.state, 'woken');
    // Q5: a hibernated agent with an update pinned takes the new image at THIS
    // wake, and its liveness is checked here — so it enters `updating`, not `waking`.
    const target = row.state === 'hibernated' ? row.targetImageDigest : null;
    const to: AgentInstanceState = target ? 'updating' : 'waking';
    const enterFrom: AgentInstanceState[] = target ? ['hibernated'] : from;
    if (!row.machineId) throw new AgentInstanceStateConflictError(row.id, row.state, 'woken');
    // A wake never chooses: it goes back to the account the row records (MOTIR-9472).
    const { orchestrator, handle } = await routeOf(row);
    if (!handle) throw new AgentInstanceStateConflictError(row.id, row.state, 'woken');

    await assertPaidAiPlan(project.organizationId);
    const limits = await readAgentPlanLimits(project.organizationId);
    const unlimited = await readUnlimitedAgentOrg(project.organizationId);
    if (!unlimited) await assertCredits(project.organizationId);
    const terminal = agentTerminalMachineConfig(row.id);
    const intervalId = randomUUID();
    const slot = await reserveSlot({
      instanceId,
      runId: intervalId,
      organizationId: project.organizationId,
      workspaceId: project.workspaceId,
      limits,
    });

    const now = agentInstanceClock.now();
    let boot = null as AgentBootOpened | null;
    const moved = await inProject(project, ctx, async (tx) => {
      const n = await agentInstanceRepository.transition(
        row.id,
        enterFrom,
        to,
        now,
        { failureReason: null, lastActivityAt: now },
        tx,
      );
      if (n === 1) {
        await agentInstanceIntervalRepository.open(
          {
            id: intervalId,
            workspaceId: row.workspaceId,
            organizationId: row.organizationId,
            agentInstanceId: row.id,
            runId: intervalId,
            runStartedAt: now,
            startedAt: now,
            chargeReference: intervalChargeReference(intervalId),
          },
          tx,
        );
        // AMENDMENT 6 §2: a wake opens attempt n+1 — but one entering `updating`
        // opens none; its progress is the update flow's.
        if (to === 'waking') boot = await agentInstanceBootService.start(row, 'wake', tx);
      }
      return n;
    });
    if (moved !== 1) {
      // A concurrent wake (or the sweep) got there first. Release only what this
      // wake owns: a slot it reserved and the winner has not adopted yet. The
      // winner's adopt puts it back if this lands first (MOTIR-7492).
      await releaseSlot(instanceId, intervalId);
      const fresh = await reload(row);
      throw new AgentInstanceStateConflictError(row.id, fresh.state, 'woken');
    }
    // This wake won, but its reserve found the slot held — by a concurrent wake
    // that will lose the move and release ITS slot, or by a leak. Either way the
    // slot is this run's now, so it is stamped with this run (MOTIR-7492).
    if (slot === 'already_held') {
      await adoptSlot({
        instanceId,
        runId: intervalId,
        organizationId: project.organizationId,
        workspaceId: project.workspaceId,
      });
    }

    try {
      // agent-terminal.md Q8: an agent whose machine config predates the current
      // one is brought up to date BEFORE the start (the machine stays stopped
      // while it is rewritten, its image digest and home volume untouched).
      if (terminal) await orchestrator.ensureMachineConfig(handle, terminal);
      await alignMachineImage(row, handle, target, orchestrator);
      await orchestrator.start(handle);
    } catch (err) {
      const detail = describeError(err);
      if (boot) await agentInstanceBootService.recordProvision(row, boot.attempt, detail);
      await failInstance(
        row,
        `The machine could not start: ${detail}. Wake to try again, or delete it.`,
      );
      return await toDtoWithImage(await reload(row));
    }
    if (target) {
      await waitFor(
        INSTANCE_INLINE_UPDATE_WAIT_MS,
        async () => (await this.settleUpdate(instanceId)) !== 'pending',
      );
    } else {
      // AMENDMENT 6 §5: the boot is the driver's from here; the answer is `waking`.
      await handOverBoot(row, boot);
    }
    return await toDtoWithImage(await reload(row));
  },

  /** Hibernate a `running` instance at its owner's request (§2). */
  async hibernate(
    projectKey: string,
    instanceId: string,
    ctx: ServiceContext,
  ): Promise<AgentInstanceDto> {
    const project = await resolveProject(projectKey, ctx);
    requireLane();
    const row = await ownInstance(project, instanceId, ctx);
    if (row.state !== 'running') {
      throw new AgentInstanceStateConflictError(row.id, row.state, 'hibernated');
    }
    // §6: never under a running run — the person cancels it first.
    await assertNoRunningRun(row, 'hibernated');
    // The loser of a race (another hibernate, the sweep) read `running` too, but its
    // guarded transition moved nothing: it is refused, never told it succeeded.
    if (!(await this.beginHibernate(row.id, 'hibernated'))) {
      throw new AgentInstanceStateConflictError(row.id, (await reload(row)).state, 'hibernated');
    }
    return await toDtoWithImage(await reload(row));
  },

  /**
   * Start hibernating ONE running instance, for its owner or for the sweep
   * (MOTIR-6873: `idle`, `backstop`, `credits`). Guarded `running → hibernating`,
   * then `stop`, then a bounded settle. Returns false when the instance was not
   * running (somebody else moved it first) — never an error for the sweep.
   *
   * A RUN IN THE AGENT (§6, MOTIR-7027): the backstop, a credit stop and a
   * platform admin's stop (MOTIR-7323) still stop the machine — money, the
   * 12-hour bound and an operator's decision hold over a machine running a card —
   * and close its run FIRST (`timed_out`; `failed`, *"out of credits"*;
   * `cancelled`, *"stopped by a platform admin"*). Every other reason (a person's
   * Hibernate, the idle check) is REFUSED with `AgentInstanceRunActiveError`,
   * naming the run, and nothing moves.
   */
  async beginHibernate(
    instanceId: string,
    endReason: AgentInstanceIntervalEndReason,
  ): Promise<boolean> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row || row.deletedAt || row.state !== 'running') return false;
    if (endReason === 'backstop') {
      await endRunIn(row, 'backstop', 'the agent reached its 12-hour backstop');
    } else if (endReason === 'credits') {
      await endRunIn(row, 'failed', 'out of credits');
    } else if (endReason === 'admin_stop') {
      // A platform admin's stop holds over a running card exactly as money does
      // (MOTIR-7323): the run is closed `cancelled` FIRST, then the machine stops.
      await endRunIn(row, 'cancelled', AGENT_RUN_END_DETAIL.adminStop);
    } else {
      await assertNoRunningRun(row, 'hibernated');
    }
    // The reason rides the move (MOTIR-7406): a stop the sweep settles later,
    // because this one failed or outlived the inline wait, closes with it.
    if (
      !(await systemTransition(row, ['running'], 'hibernating', { hibernateReason: endReason }))
    ) {
      return false;
    }
    if (row.machineId) {
      try {
        const { orchestrator, handle } = await routeOf(row);
        // §4 (MOTIR-7026): the last sign-in answer before the volume goes quiet is
        // what a start reads while the agent sleeps. Best effort, never a refusal.
        if (handle && isTerminalOnQuietly()) await probeSignIn(row, handle);
        if (handle) await orchestrator.stop(handle);
      } catch (err) {
        console.warn('[agentInstanceLifecycle] stop failed; the sweep will settle it', {
          instanceId: row.id,
          detail: describeError(err),
        });
      }
    }
    await waitFor(
      INSTANCE_INLINE_STOP_WAIT_MS,
      async () => (await this.settleStop(row.id, endReason)) !== 'pending',
    );
    return true;
  },

  /**
   * Hibernate EVERY running instance of ONE organisation, for a platform admin's
   * stop (Story MOTIR-6905 · MOTIR-7323). Each goes through {@link beginHibernate}
   * with `admin_stop`, so a run in the agent is closed `cancelled` before its
   * machine stops, and the closed interval says who stopped it. Only that
   * organisation's rows are read; nobody else's agent is touched.
   *
   * Never throws for one instance: a failure is logged, counted and returned with
   * the instance's id, so the caller can say which agent did not stop. An instance
   * already resting (`hibernated`, `hibernating`, `failed`) is counted, not moved;
   * one in motion (`starting`, `waking`, `updating`, `deleting`, or moved by
   * another path first) is counted `inMotion`, because it holds no running
   * interval to close yet and its own settle decides where it lands. Who may call
   * this, the confirmation and the audit row belong to the admin stop service.
   */
  async hibernateAllForOrganization(
    organizationId: string,
    endReason: Extract<AgentInstanceIntervalEndReason, 'admin_stop'>,
  ): Promise<AgentInstanceOrgHibernateResult> {
    const rows = await withSystemContext((tx) =>
      agentInstanceRepository.listLiveForOrganization(organizationId, tx),
    );
    const result: AgentInstanceOrgHibernateResult = {
      hibernated: 0,
      alreadyResting: 0,
      inMotion: 0,
      failures: [],
    };
    for (const row of rows) {
      if (RESTING_STATES.includes(row.state)) {
        result.alreadyResting += 1;
        continue;
      }
      if (row.state !== 'running') {
        result.inMotion += 1;
        continue;
      }
      try {
        if (!(await this.beginHibernate(row.id, endReason))) {
          result.inMotion += 1;
          continue;
        }
        const after = await reload(row);
        if (after.state === 'hibernated') {
          result.hibernated += 1;
        } else {
          result.failures.push({
            instanceId: row.id,
            detail: `the stop did not confirm; the agent is ${after.state}`,
          });
        }
      } catch (err) {
        console.warn('[agentInstanceLifecycle] admin stop failed for one instance', {
          instanceId: row.id,
          detail: describeError(err),
        });
        result.failures.push({ instanceId: row.id, detail: describeError(err) });
      }
    }
    return result;
  },

  /**
   * Delete an instance for the SWEEP — the plan-lapse deletion (MOTIR-6921,
   * `agent-instance-storage.md` §4): the same guarded move and the same settle as
   * the owner's delete, so the machine, the volume and the final interval's charge
   * are handled exactly as there. Returns false when the instance could not enter
   * `deleting` (it is updating or already going) — the next pass tries again.
   */
  async beginDelete(instanceId: string): Promise<boolean> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row || row.deletedAt) return false;
    const moved = await withWorkspaceServiceContext(row.workspaceId, async (tx) => {
      const n = await agentInstanceRepository.transition(
        row.id,
        statesThatMayEnter('deleting'),
        'deleting',
        agentInstanceClock.now(),
        {},
        tx,
      );
      // AMENDMENT 6 §4: the move to `deleting` closes the boot attempt, in its transaction.
      if (n === 1) await agentInstanceBootService.closeForDeletion(row.id, tx);
      return n;
    });
    if (moved !== 1) return false;
    await this.settleDelete(row.id);
    return true;
  },

  /**
   * Delete an instance and its home (§1, §4): guarded, then machine then volume.
   * Legal mid-boot and mid-stop too (AMENDMENT 4): the destroy takes the machine in
   * whatever state it is, and a boot or stop settle that runs after the guarded
   * move loses its own compare-and-set and changes nothing.
   */
  async delete(projectKey: string, instanceId: string, ctx: ServiceContext): Promise<void> {
    const project = await resolveProject(projectKey, ctx);
    requireLane();
    const row = await ownInstance(project, instanceId, ctx);
    // §6: never under a running run — the person cancels it first.
    await assertNoRunningRun(row, 'deleted');
    const moved = await inProject(project, ctx, async (tx) => {
      const n = await agentInstanceRepository.transition(
        row.id,
        statesThatMayEnter('deleting'),
        'deleting',
        agentInstanceClock.now(),
        {},
        tx,
      );
      // AMENDMENT 6 §4: the move to `deleting` closes the boot attempt, in its transaction.
      if (n === 1) await agentInstanceBootService.closeForDeletion(row.id, tx);
      return n;
    });
    if (moved !== 1) throw new AgentInstanceStateConflictError(row.id, row.state, 'deleted');
    await this.settleDelete(row.id);
  },

  /**
   * THE SWEEP'S BOOT BACKSTOP (`agent-instances.md` AMENDMENT 6 §4) — for a
   * `starting` / `waking` agent, NEVER a step of the boot itself (the driver,
   * `agentInstanceBootService.advance`, owns every step):
   *
   * - the current attempt's lease is ALIVE → `alive`: its driver is working;
   * - the lease is absent or EXPIRED → the boot event sent again for that
   *   attempt, keyed by the expired lease so it is never deduplicated against the
   *   first → `resent`. Its new holder resumes at the step in progress;
   * - NO open attempt (a boot in flight across the deploy that brought the
   *   driver in) → one opened, its kind from the state, then the event → `opened`.
   */
  async resumeBoot(instanceId: string): Promise<'opened' | 'resent' | 'alive' | 'noop'> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row || row.deletedAt || (row.state !== 'starting' && row.state !== 'waking'))
      return 'noop';
    const now = agentInstanceClock.now();
    const current = await withWorkspaceServiceContext(row.workspaceId, (tx) =>
      agentInstanceBootRepository.findCurrentAttempt(row.id, tx),
    );
    if (!current || current.endedAt) {
      const opened = await withWorkspaceServiceContext(row.workspaceId, (tx) =>
        agentInstanceBootService.start(row, row.state === 'waking' ? 'wake' : 'create', tx),
      );
      // The machine exists, so its provision is done; the driver reads the rest.
      if (handleOf(row)) await agentInstanceBootService.recordProvision(row, opened.attempt, null);
      await sendEvent('agent-instance/boot', opened.event);
      return 'opened';
    }
    if (current.leaseExpiresAt && current.leaseExpiresAt.getTime() > now.getTime()) return 'alive';
    await sendEvent('agent-instance/boot', {
      workspaceId: row.workspaceId,
      instanceId: row.id,
      attempt: current.attempt,
      idempotencyKey: agentBootEventKey(row.id, current.attempt, current.leaseExpiresAt),
    });
    return 'resent';
  },

  /**
   * UPDATE an agent to the newest published image (`agent-image-update.md` Q2–Q8,
   * MOTIR-6952), on its owner's say-so.
   *
   * - A RUNNING agent moves `running → updating` (keeping its interval and slot,
   *   running no admission — Q7), its machine is moved to the new digest on the
   *   SAME volume, and the settle checks liveness: `running` on the new image, or
   *   rolled back to the old one with the reason in words.
   * - A HIBERNATED agent changes no machine: the target is pinned on the record
   *   and the agent stays `hibernated`; its next wake applies it (Q5).
   *
   * Refused, moving nothing: not the caller's (404), a run running in it, already
   * on the newest, any other state, and a registry that could not be asked.
   */
  async update(
    projectKey: string,
    instanceId: string,
    ctx: ServiceContext,
  ): Promise<AgentInstanceDto> {
    const project = await resolveProject(projectKey, ctx);
    requireLane();
    const row = await ownInstance(project, instanceId, ctx);
    if (row.state !== 'running' && row.state !== 'hibernated') {
      throw new AgentInstanceStateConflictError(row.id, row.state, 'updated');
    }
    // Q1: the newest AT the press, bypassing the cache — this is what is pinned.
    const newest = await imageCatalog.newestFor(row.profileId, { fresh: true });
    if (newest === 'unknown') throw new AgentImageCatalogUnavailableError();
    const named =
      row.imageVersion ?? (await imageCatalog.versionOf(row.profileId, row.imageDigest));
    const current = named === 'unknown' ? null : named;
    if (
      newest.digest === row.imageDigest ||
      (current !== null && compareVersions(newest.version, current) <= 0)
    ) {
      throw new AgentInstanceUpToDateError(row.id, current);
    }
    await assertNoRunningRun(row, 'updated');

    const pin: AgentInstanceTransitionPatch = {
      targetImageDigest: newest.digest,
      targetImageVersion: newest.version,
      updateFailureReason: null,
      updateFailedAt: null,
      // A version named only by the catalog is recorded now, so the rollback's
      // words and the success's record agree on what the agent ran.
      ...(row.imageVersion === null && current !== null ? { imageVersion: current } : {}),
    };

    if (row.state === 'hibernated') {
      const pinned = await inProject(project, ctx, (tx) =>
        agentInstanceRepository.patchImage(row.id, ['hibernated'], pin, tx),
      );
      if (pinned !== 1) {
        throw new AgentInstanceStateConflictError(row.id, (await reload(row)).state, 'updated');
      }
      return await toDtoWithImage(await reload(row));
    }

    // Running: the guarded move and the run check in ONE transaction, so a run
    // opened before the move commits is seen here and the move is undone (Q8).
    // The move is guarded on the digest read above as well as the state: an
    // earlier press can update the agent and settle it back to `running` between
    // that read and this move, and the state alone would let this press run the
    // same update a second time (MOTIR-7340).
    const moved = await inProject(project, ctx, async (tx) => {
      const n = await agentInstanceRepository.transition(
        row.id,
        ['running'],
        'updating',
        agentInstanceClock.now(),
        pin,
        tx,
        { imageDigest: row.imageDigest },
      );
      if (n !== 1) return 0;
      const running = await dispatchRunRepository.findRunningByAgentInstance(row.id, tx);
      if (running) {
        const keys = await dispatchRunRepository.findTargetKeys([running.id], tx);
        // Thrown INSIDE the transaction, so the guarded move above rolls back.
        throw new AgentInstanceRunActiveError(
          row.id,
          running.id,
          keys.get(running.id) ?? null,
          'updated',
        );
      }
      return n;
    });
    if (moved !== 1) {
      const now = await reload(row);
      if (now.state === 'running' && now.imageDigest === newest.digest) {
        throw new AgentInstanceUpToDateError(row.id, now.imageVersion ?? newest.version);
      }
      throw new AgentInstanceStateConflictError(row.id, now.state, 'updated');
    }

    const fresh = await reload(row);
    const handle = handleOf(fresh);
    if (handle) {
      try {
        await getPersistentOrchestrator().moveImage(handle, imageRef(fresh, newest.digest), {
          launch: true,
        });
      } catch (err) {
        // The machine did not take the new image: nothing to undo on it, so the
        // settle finds it on the old digest and reports the refusal (Q4).
        await withWorkspaceServiceContext(fresh.workspaceId, (tx) =>
          agentInstanceRepository.patchImage(
            fresh.id,
            ['updating'],
            {
              updateFailureReason:
                `The update to ${newest.version} didn’t work: ${describeError(err)}. ` +
                `Your agent is back on ${versionWords(fresh.imageVersion)}.`,
              updateFailedAt: agentInstanceClock.now(),
            },
            tx,
          ),
        );
      }
    }
    await waitFor(
      INSTANCE_INLINE_UPDATE_WAIT_MS,
      async () => (await this.settleUpdate(instanceId)) !== 'pending',
    );
    return await toDtoWithImage(await reload(row));
  },

  /**
   * SETTLE AN UPDATE (`updating`), idempotently — inline after Update and the
   * wake that applies one, and by the sweep for one left in motion (Q6). It
   * reads WHERE THE MACHINE IS rather than remembering what it did:
   *
   * - gone / failed → `failed`, the interval closed `lost`;
   * - on the TARGET, not rolling back → once started, the liveness check (Q3):
   *   `running` with `imageDigest` ← target, or the rollback begins; not started
   *   within {@link UPDATE_START_DEADLINE_MS} → the rollback begins;
   * - on the RECORD's digest → a rollback (or a move that never landed): once
   *   started, `running` with the reason; not started within
   *   {@link UPDATE_ROLLBACK_DEADLINE_MS} → `failed`.
   *
   * The volume is never touched on any branch.
   */
  async settleUpdate(instanceId: string): Promise<'running' | 'failed' | 'pending' | 'noop'> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row || row.deletedAt || row.state !== 'updating') return 'noop';
    const handle = handleOf(row);
    /* v8 ignore next -- an updating agent always has a handle. */
    if (!handle) return 'pending';
    const orchestrator = getPersistentOrchestrator();
    let status;
    try {
      status = await orchestrator.describePersistent(handle);
    } catch {
      return 'pending';
    }
    if (status.state === 'gone') {
      await failInstance(
        row,
        'The machine was lost during the update. Your home is kept only while its volume exists — delete the agent and create a new one.',
      );
      return 'failed';
    }
    const now = agentInstanceClock.now().getTime();
    const target = row.targetImageDigest;
    const onTarget = target !== null && status.image === imageRef(row, target);
    const rollingBack = row.updateFailureReason !== null;

    if (onTarget && !rollingBack) {
      if (status.state !== 'running') {
        if (now - row.stateChangedAt.getTime() < UPDATE_START_DEADLINE_MS) return 'pending';
        await beginRollback(row, 'the new version did not start within 5 minutes');
        return 'pending';
      }
      // Q3: the coding agent runs, and the terminal did not disappear. The boot
      // probes run for the NEW digest — which also records its run launcher
      // (`agent-instance-run.md` Owed on acceptance).
      const liveness = await orchestrator.checkLiveness(handle, livenessCommandFor(row.profileId));
      const asTarget: AgentInstance = { ...row, imageDigest: target };
      const terminalBefore = row.terminalServer;
      await probeTerminalServer(asTarget, handle);
      await probeRunCapabilities(asTarget, handle);
      const probed = await reload(row);
      const terminalLost =
        terminalBefore === 'present' &&
        probed.terminalServerDigest === target &&
        probed.terminalServer === 'absent';
      if (!liveness.alive || terminalLost) {
        await beginRollback(
          row,
          liveness.alive ? 'the new version has no terminal server' : liveness.detail,
        );
        return 'pending';
      }
      const moved = await systemTransition(row, ['updating'], 'running', {
        imageDigest: target,
        imageVersion: row.targetImageVersion,
        targetImageDigest: null,
        targetImageVersion: null,
        updateFailureReason: null,
        updateFailedAt: null,
        lastActivityAt: agentInstanceClock.now(),
      });
      if (!moved) return 'noop';
      await armIdleTimer(row);
      return 'running';
    }

    // On the record's digest: a rollback, or a move that never landed.
    if (status.state === 'running') {
      const moved = await systemTransition(row, ['updating'], 'running', {
        targetImageDigest: null,
        targetImageVersion: null,
        updateFailureReason:
          row.updateFailureReason ??
          `The update to ${row.targetImageVersion ?? 'the newer version'} was interrupted. ` +
            `Your agent is still on ${versionWords(row.imageVersion)}.`,
        updateFailedAt: row.updateFailedAt ?? agentInstanceClock.now(),
        lastActivityAt: agentInstanceClock.now(),
      });
      if (!moved) return 'noop';
      // The probes for the digest it is back on (already recorded, usually a no-op).
      await probeTerminalServer(row, handle);
      await armIdleTimer(row);
      return 'running';
    }
    const since = (row.updateFailedAt ?? row.stateChangedAt).getTime();
    if (now - since < UPDATE_ROLLBACK_DEADLINE_MS) {
      // A machine left stopped mid-rollback is started on the record's digest.
      if (status.state === 'stopped' && rollingBack) {
        try {
          if (status.image !== imageRef(row, row.imageDigest)) {
            await orchestrator.moveImage(handle, imageRef(row, row.imageDigest), { launch: false });
          }
          await orchestrator.start(handle);
        } catch {
          // Next pass, or the deadline below.
        }
      }
      return 'pending';
    }
    await failInstance(
      row,
      `The update to ${row.targetImageVersion ?? 'the newer version'} didn’t work, and your agent ` +
        `couldn’t be brought back on ${versionWords(row.imageVersion)}: it did not start. ` +
        'Wake to try again, or delete it.',
      RUN_MACHINE_LOST,
    );
    return 'failed';
  },

  /**
   * SETTLE A STOP (`hibernating`), idempotently: once Fly reports the machine
   * stopped, close the interval at Fly's stop instant and move to `hibernated`.
   * A machine found gone fails the instance (`lost`). Called inline by
   * {@link beginHibernate} with the reason it was started for, and by the sweep
   * for a stop a previous pass left in motion.
   *
   * The interval closes with `endReason` when given, else the reason the row
   * recorded when the hibernate began, else `hibernated` (a row that entered
   * `hibernating` before the reason was recorded) — MOTIR-7406.
   *
   * `reissueStop` (the sweep's, MOTIR-7406): a machine still `running` means the
   * stop never reached it — Fly refused it, or it was lost — so send it again,
   * once per call, and read the machine again. `stop` is idempotent, so a stop
   * that did land costs nothing. The inline settle never re-issues: it polls the
   * stop it just sent.
   */
  async settleStop(
    instanceId: string,
    endReason?: AgentInstanceIntervalEndReason,
    opts: { reissueStop?: boolean } = {},
  ): Promise<'hibernated' | 'failed' | 'pending' | 'noop'> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row || row.deletedAt || row.state !== 'hibernating') return 'noop';
    /* v8 ignore next -- a hibernating instance was running, so it has a handle. */
    if (!row.machineId) return 'pending';
    let orchestrator: PersistentContainerOrchestrator;
    let handle: PersistentContainerHandle | null;
    try {
      ({ orchestrator, handle } = await routeOf(row));
    } catch {
      return 'pending';
    }
    /* v8 ignore next -- a row with a machine id has its whole handle. */
    if (!handle) return 'pending';
    let status;
    try {
      status = await orchestrator.describePersistent(handle);
      if (opts.reissueStop && status.state === 'running') {
        try {
          await orchestrator.stop(handle);
        } catch (err) {
          console.warn(
            '[agentInstanceLifecycle] the re-issued stop failed; the next pass retries',
            {
              instanceId: row.id,
              detail: describeError(err),
            },
          );
          return 'pending';
        }
        status = await orchestrator.describePersistent(handle);
      }
    } catch {
      return 'pending';
    }
    if (status.state === 'gone') {
      await failInstance(
        row,
        'The machine was lost while it was stopping. Its home may be gone; delete it.',
      );
      return 'failed';
    }
    if (status.state !== 'stopped') return 'pending';
    // Move first: a Delete that took the agent out of `hibernating` meanwhile wins,
    // and its settle closes the interval `deleted` (AMENDMENT 4).
    if (!(await systemTransition(row, ['hibernating'], 'hibernated', { hibernateReason: null }))) {
      return 'noop';
    }
    await closeOpenInterval(
      row,
      status.stoppedAt ?? agentInstanceClock.now(),
      endReason ?? row.hibernateReason ?? 'hibernated',
    );
    return 'hibernated';
  },

  /**
   * SETTLE A DELETE (`deleting`), idempotently: destroy the machine then the
   * volume, close the open interval (`deleted`), release the slot, stamp
   * `deletedAt`. A destroy that fails leaves the instance `deleting` for the sweep.
   */
  async settleDelete(instanceId: string): Promise<'deleted' | 'pending' | 'noop'> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row || row.deletedAt || row.state !== 'deleting') return 'noop';
    if (row.machineId) {
      try {
        // Machine then disk, on the account the row records (MOTIR-9472).
        const { orchestrator, handle } = await routeOf(row);
        if (handle) await orchestrator.destroyPersistent(handle);
      } catch (err) {
        console.warn('[agentInstanceLifecycle] destroy failed; the sweep will retry it', {
          instanceId: row.id,
          detail: describeError(err),
        });
        return 'pending';
      }
    }
    await closeOpenInterval(row, agentInstanceClock.now(), 'deleted');
    await withWorkspaceServiceContext(row.workspaceId, (tx) =>
      agentInstanceRepository.markDeleted(row.id, agentInstanceClock.now(), tx),
    );
    return 'deleted';
  },

  /**
   * Ask a RUNNING agent's terminal server for its sign-in now and record it
   * (`agent-instance-run.md` §4 — the start's live probe). Null when the agent is
   * not running, has no handle, or the query gave no answer.
   */
  async probeSignIn(instanceId: string): Promise<AgentSignInAnswer | null> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row || row.deletedAt || row.state !== 'running') return null;
    const handle = handleOf(row);
    if (!handle) return null;
    return probeSignIn(row, handle);
  },

  /** Bump the idle signal (§2) — the later stories' relay and runs call it. */
  async touchActivity(instanceId: string): Promise<void> {
    await agentInstanceActivityService.touchActivity(instanceId);
  },

  /**
   * THE RUNNING CHARGE (AMENDMENT 2) — charge a running machine for the minutes it
   * has already used, without stopping it. The open interval closes `rolled` at its
   * last WHOLE-minute boundary and the next interval of the same run opens there,
   * in one transaction; the closed one is then charged like any other, once, under
   * its own key. So the organisation's balance falls while the machine runs, and a
   * later credit check sees it — which a charge made only when the machine stops
   * could never give. Whole minutes keep the rounding exact: ⌈seconds ÷ 60⌉ of a
   * whole-minute interval is its minutes, and only a run's final interval rounds.
   * The run — its slot and its 12-hour backstop — carries on untouched.
   */
  async rollInterval(instanceId: string): Promise<'rolled' | 'noop'> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    // `updating` rolls too: its machine runs, and is charged (Q7).
    if (!row || row.deletedAt || (row.state !== 'running' && row.state !== 'updating')) {
      return 'noop';
    }
    const now = agentInstanceClock.now();
    const rolled = await withWorkspaceServiceContext(row.workspaceId, async (tx) => {
      const open = await agentInstanceIntervalRepository.findOpen(row.id, tx);
      if (!open) return null;
      const wholeMinutes = Math.floor((now.getTime() - open.startedAt.getTime()) / 60_000);
      if (wholeMinutes < 1) return null;
      const boundary = new Date(open.startedAt.getTime() + wholeMinutes * 60_000);
      // The close is guarded: a hibernate or delete that closed it first wins, and
      // this roll then opens nothing.
      const moved = await agentInstanceIntervalRepository.close(
        open.id,
        { endedAt: boundary, endReason: 'rolled', billableSeconds: wholeMinutes * 60 },
        tx,
      );
      if (moved !== 1) return null;
      const nextId = randomUUID();
      await agentInstanceIntervalRepository.open(
        {
          id: nextId,
          workspaceId: row.workspaceId,
          organizationId: row.organizationId,
          agentInstanceId: row.id,
          runId: open.runId,
          runStartedAt: open.runStartedAt,
          startedAt: boundary,
          chargeReference: intervalChargeReference(nextId),
        },
        tx,
      );
      return open;
    });
    if (!rolled) return 'noop';
    try {
      await agentInstanceChargeService.chargeInterval(rolled.id);
    } catch (err) {
      console.error('[agentInstanceLifecycle] a running charge failed; the sweep will retry it', {
        instanceId: row.id,
        intervalId: rolled.id,
        detail: describeError(err),
      });
    }
    return 'rolled';
  },

  /**
   * RECONCILE ONE RUNNING INSTANCE against the machine (§5) — the sweep's read.
   * A machine found `stopped` (a crash with no restart, an operator) closes the
   * interval at Fly's stop instant and rests at `hibernated`; one found `gone`
   * fails the instance and closes the interval `lost` — charged either way.
   */
  async reconcileRunning(instanceId: string): Promise<'ok' | 'hibernated' | 'failed' | 'noop'> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row || row.deletedAt || row.state !== 'running') return 'noop';
    const handle = handleOf(row);
    if (!handle) return 'noop';
    let status;
    try {
      status = await getPersistentOrchestrator().describePersistent(handle);
    } catch {
      return 'noop';
    }
    if (status.state === 'gone' || status.state === 'failed') {
      await failInstance(
        row,
        'The machine was lost. Its home may be gone; wake it to try again, or delete it.',
      );
      return 'failed';
    }
    if (status.state === 'stopped') {
      // A machine that stopped behind Motir's back takes its run with it (§6).
      await endRunIn(row, 'failed', RUN_AGENT_STOPPED);
      if (!(await systemTransition(row, ['running'], 'hibernated'))) return 'noop';
      await closeOpenInterval(row, status.stoppedAt ?? agentInstanceClock.now(), 'hibernated');
      return 'hibernated';
    }
    return 'ok';
  },
};

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'P2002';
}

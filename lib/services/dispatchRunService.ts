import { Prisma } from '@/generated/prisma/client';
import type {
  DispatchCardDisposition,
  DispatchCommand,
  DispatchEventKind,
  DispatchRunCard,
  DispatchRunOrigin,
  DispatchRunReporter,
  DispatchRunStatus,
  DispatchSkipReason,
  DispatchStopReason,
} from '@/generated/prisma/client';
import {
  AGENT_ACTION_MAX_CHARS,
  AgentRunEventKindNotAllowedError,
  AgentRunNoOpenRunError,
  AgentRunNotClaimedError,
  AgentRunNotYoursError,
  AgentRunReportInvalidError,
  DispatchRunAgentBusyError,
  DispatchRunAgentInstanceMismatchError,
  DispatchRunCardsBusyError,
  DispatchRunEventBodyTooLargeError,
  DispatchRunEventModelNotAllowedError,
  DispatchRunEventLimitError,
  DispatchRunNoTargetError,
  DispatchRunNotFoundError,
  DispatchRunTerminalError,
  DispatchRunTokenOutOfScopeError,
  DuplicateDispatchRunError,
  UnknownDispatchRunCardError,
} from '@/lib/dispatchRuns/errors';
import type {
  ActiveDispatchRunDto,
  AgentActionReportedDto,
  AgentRunClosedDto,
  AgentRunLegDto,
  AgentRunOpenedDto,
  ActiveDispatchRunsDto,
  DispatchRunListPageDto,
  DispatchRunView,
  DispatchRunAppendedDto,
  DispatchRunCardDto,
  DispatchRunCloseOutPromptDto,
  DispatchRunContinuesDto,
  DispatchRunCostDto,
  DispatchRunDetailDto,
  DispatchRunHostedEndDto,
  DispatchRunLegGateDto,
  DispatchRunMachineTimeDto,
  DispatchRunDto,
  DispatchRunEventDto,
  DispatchRunOpenedDto,
  DispatchRunScopeDto,
} from '@/lib/dto/dispatchRuns';
import { listDispatchRepoNames } from '@/lib/workItems/dispatchRepo';
import {
  toDispatchRunCardDto,
  toDispatchRunContinuesDto,
  toDispatchRunRepairDto,
  toDispatchRunDto,
  toDispatchRunEventDto,
  toDispatchRunLegGateDto,
  toDispatchRunListItemDto,
  toDispatchRunScopeDto,
  toDispatchRunWaitingCounts,
  type DispatchRunReader,
} from '@/lib/mappers/dispatchRunMappers';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { dispatchRunHeldGateRepository } from '@/lib/repositories/dispatchRunHeldGateRepository';
import { RUN_HOLDING_GATE_KINDS } from '@/lib/dispatchRuns/heldGates';
import { assembleRunCloseOutPrompt } from '@/lib/dispatch/runCloseOutPrompt';
import { getAgentRunUsage } from '@/lib/ai/motirAiClient';
import { toWorkItemDeliveryDto } from '@/lib/mappers/githubMappers';
import { reportedModelOf } from '@/lib/dispatchRuns/reportedModel';
import { standingMergeRefusals, standingQueueFailures } from './deliveryVerdict';
import { dispatchRunCardRepository } from '@/lib/repositories/dispatchRunCardRepository';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { holdsRecordView, projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { ciFleetCostMeterService } from '@/lib/services/ciFleetCostMeterService';
import { agentInstanceActivityService } from '@/lib/services/agentInstanceActivityService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  VISITOR_ACTOR_ID,
  visitorServiceContext,
  type VisitorReadContext,
} from '@/lib/visitor/context';
import { isVisitorContext } from '@/lib/visitor/readScope';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { availableRoomViews, holdsAnyOf, RUN_ACT_PERMISSIONS } from '@/lib/rooms/roomView';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { uniqueViolationConstraints } from '@/lib/prisma/uniqueViolation';
import { recomputeWorkItemFixReason } from './fixReasonService';
import { recomputeWorkItemResumeState } from './resumeStateService';
import { manualWorkGateService } from './manualWorkGateService';
import { CANCELLED_STATUS_KEY } from '@/lib/workItems/provenanceBackfill';
import { ladderKeysFrom, rankOfStatus, RUNG_RANK } from '@/lib/workItems/statusLadder';

// THE DISPATCH RUN SERVICE (Story MOTIR-1789 · MOTIR-1792) — the WRITE half of
// the run seam, specified by `docs/decisions/dispatch-run-record.md`.
//
// Three operations, and they are shaped for a TRANSPORT rather than for the CLI
// that happens to be their first caller: 9.1.7's hosted orchestrator later
// becomes a second caller with `origin: 'hosted'` and nothing else changes.
//
// ── TWO THINGS THIS SERVICE MUST NEVER DO (ADR Q3) ─────────────────────────
//
//   1. It does not transition a WORK ITEM. Closing a run writes no status. The
//      CLI owns every transition and the CI-green → `in_review` promotion is
//      server-side (MOTIR-2999); a second writer here would be a duplicate write
//      path for the fact the board renders. There is no `workItemsService` and no
//      `workItemRepository.update` import below, and
//      `tests/dispatchRunService.test.ts` asserts the item is untouched across a
//      whole open → append → close cycle.
//   2. It records no pull request and no CI verdict. An EVENT may say *a pull
//      request was opened*; the FACT lives in the delivery set and the read side
//      joins it.
//
// ── ONE TRANSACTION PER METHOD, `tx` THREADED ALL THE WAY DOWN ─────────────
// The three tables are RLS-gated on `app.workspace_id`, a GUC bound by
// `withWorkspaceContext` on a TRANSACTION and by nothing else, so every
// repository call — read as well as write — takes the `tx` this service opens.
// That is `docs/decisions/bound-read-transaction-shape.md`'s convention, and
// here it is not merely a convention: an unbound read of these tables returns an
// EMPTY LIST rather than an error.

/** The opt-in log body's per-event ceiling (ADR Q4). REFUSED, never truncated. */
export const DISPATCH_RUN_EVENT_BODY_LIMIT_BYTES = 16 * 1024;

/** The per-RUN event ceiling (ADR Q4) — the bound that makes bodies safe to accept. */
export const DISPATCH_RUN_EVENT_LIMIT = 5_000;

/** How many events one append call may carry. */
export const DISPATCH_RUN_APPEND_BATCH_LIMIT = 200;

/** How long a log body is kept before the sweep clears it (ADR Q4). */
export const DISPATCH_RUN_BODY_RETENTION_DAYS = 30;

/**
 * How long a run may sit `running` before the reap closes it as `timed_out` /
 * `abandoned`.
 *
 * Twelve hours, and the number is chosen against the LONGEST legitimate run
 * rather than the typical one: a `motir auto` draining a project's ready set
 * with a CI watch on each card is measured in hours, and reaping a run that is
 * still working would replace a true `running` with a false `abandoned` — which
 * is worse than the state it fixes, because it is a terminal answer nobody
 * re-examines.
 */
export const DISPATCH_RUN_ABANDON_AFTER_HOURS = 12;

/** One page of the RUNS INDEX, and the ceiling a caller cannot ask past. */
export const DISPATCH_RUN_LIST_DEFAULT_TAKE = 25;
export const DISPATCH_RUN_LIST_MAX_TAKE = 100;

/**
 * ⚠️ THE LIVE / PAST PARTITION IS NOT DEFINED HERE — it is re-exported from
 * `lib/runs/timeline.ts`, and moving it there was MOTIR-1796's doing rather
 * than a tidy-up.
 *
 * This service answers `?status=live|past` on the server; the run SECTION reads
 * the same question in the BROWSER to decide whether to open a stream at all —
 * and a service module cannot be imported by a client island, so a copy would
 * have been the obvious move. Two copies of *is this run still going* is how one
 * surface comes to believe a run has finished while another still shows it
 * running, which is the exact class the run surfaces' totality maps exist to
 * refuse. One definition, in a module with no server imports, read by both.
 */
/**
 * Whether a recorded leg is a run reaching a manual card it could not do — the one
 * skip that raises the `manual_work` gate (Story MOTIR-7460 · MOTIR-7475). Every
 * other skip reason is the run's own business and asks nobody anything.
 */
function raisesManualWork(
  disposition: DispatchCardDisposition | undefined,
  skipReason: DispatchSkipReason | null | undefined,
): boolean {
  return disposition === 'skipped' && skipReason === 'needs_human';
}

export { DISPATCH_RUN_LIVE_STATUSES, DISPATCH_RUN_PAST_STATUSES } from '@/lib/runs/timeline';

/** One card in the SET a run is opened with. */
export interface OpenDispatchRunCardInput {
  /** The card's `MOTIR-<n>` key, in this run's project. */
  key: string;
  /** `queued` (the run intends to work it) or `skipped`. */
  disposition: 'queued' | 'skipped';
  /** Required when `disposition === 'skipped'`, forbidden otherwise. */
  skipReason?: DispatchSkipReason | undefined;
}

export interface OpenDispatchRunInput {
  projectKey: string;
  command: DispatchCommand;
  origin?: DispatchRunOrigin | undefined;
  /** The container or sprint-bearing card the run was pointed at. */
  scopeKey?: string | undefined;
  /** What the CLI printed for the scope. Stored so it survives the card. */
  scopeLabel?: string | undefined;
  agent?: string | undefined;
  model?: string | undefined;
  /**
   * The developer's own agent the run executes in (MOTIR-7023,
   * `agent-instance-run.md` §5). REQUIRED when `origin === 'instance'` and
   * forbidden otherwise. Only the server opens such a run — the ingest route
   * refuses `origin: 'instance'` — so this is never a client's value.
   */
  agentInstanceId?: string | undefined;
  idempotencyKey?: string | undefined;
  /**
   * WHO REPORTS the run (MOTIR-7450, `agent-reported-runs.md` §1) — REQUIRED, so
   * every door states it: `cli` for each runner-observed open (the v1 ingest, a
   * hosted or instance start, a repair or continue claim), `agent` only from
   * {@link dispatchRunService.openAgentRun}. Never a client's value.
   */
  reportedBy: DispatchRunReporter;
  /** The run's SET, IN THE RUN'S OWN ORDER. `position` is the array index. */
  cards: OpenDispatchRunCardInput[];
}

/** One event in an append batch. */
export interface AppendDispatchRunEventInput {
  kind: DispatchEventKind;
  /** The card this event is about, or absent for a RUN-scoped event. */
  workItemKey?: string | undefined;
  data?: Prisma.InputJsonValue | undefined;
  /** The opt-in log body. Absent unless the run was started with `--report-log`. */
  body?: string | undefined;
  /** The leg's new disposition, applied in the SAME transaction as the event. */
  disposition?: DispatchCardDisposition | undefined;
  skipReason?: DispatchSkipReason | undefined;
  sessionBranch?: string | undefined;
  exitCode?: number | undefined;
  /**
   * The agent's SELF-REPORTED model (MOTIR-7502). Accepted only on
   * `agent_exited`; written onto the leg under `normalizeReportedModel`, and
   * when absent the event's `data.model` is read instead.
   */
  model?: unknown;
}

export interface CloseDispatchRunInput {
  stopReason: DispatchStopReason;
  /**
   * The run's terminal status. Omitted, it is DERIVED from the stop reason —
   * `halted` is a failure, everything else is not — which is the mapping every
   * caller would otherwise re-implement, differently. Either way the close
   * corrects it by the run's legs: a run any of whose legs failed is not stored
   * as a success (`closingStatus`, MOTIR-10984).
   */
  status?: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | undefined;
  /**
   * When the run ENDED, when that is not now — SERVER-SIDE ONLY, never a client's
   * value. The lapse reap passes an agent-reported run's last heartbeat
   * (`agent-reported-runs.md` §5), so a dead session is not billed the hour the
   * window waited.
   */
  endedAt?: Date | undefined;
}

/** What {@link dispatchRunService.openAgentRun} takes (`agent-reported-runs.md` §2). */
export interface OpenAgentRunInput {
  /** The card the caller holds — a leaf, or a container whose children it holds. */
  key: string;
  /** The harness the agent runs in, as it names itself (`Claude Code`, `Codex`). */
  harness: string;
  /** The model id it is running as, or absent when it does not know. Never a guess. */
  model?: string | null | undefined;
}

/**
 * The four milestone kinds an agent may report (`agent-reported-runs.md` §3), and
 * only on a run it reports. Every other kind is the server's or the runner's.
 */
export const AGENT_REPORTABLE_EVENT_KINDS: readonly DispatchEventKind[] = [
  'checkout_ready',
  'delivery_linked',
  'leg_verdict',
  'card_settled',
];

/** One milestone an agent reports — always on the leg of the call's `key`. */
export interface AgentReportedEventInput {
  kind: DispatchEventKind;
  data?: Prisma.InputJsonValue | undefined;
  disposition?: DispatchCardDisposition | undefined;
  skipReason?: DispatchSkipReason | undefined;
  sessionBranch?: string | undefined;
}

/** What {@link dispatchRunService.reportAction} takes (`agent-reported-runs.md` §3). */
export interface ReportAgentActionInput {
  key?: string | undefined;
  /** The step about to be taken, in one line — at most {@link AGENT_ACTION_MAX_CHARS}. */
  action?: string | undefined;
  events?: AgentReportedEventInput[] | undefined;
}

/** What {@link dispatchRunService.closeAgentRun} takes (`agent-reported-runs.md` §4). */
export interface CloseAgentRunInput {
  key: string;
  runId: string;
  /** Any v1 stop reason but `abandoned`, which only the reap writes (Q2). */
  stopReason: Exclude<DispatchStopReason, 'abandoned'>;
}

/**
 * How fresh a run's heartbeat may be before the every-call heartbeat skips it
 * (`agent-reported-runs.md` §5) — one write a minute however many calls arrive.
 */
export const AGENT_RUN_HEARTBEAT_THROTTLE_MS = 60_000;

/**
 * Whether `userId` HOLDS a card (`agent-reported-runs.md` §2) — what a claim leaves
 * behind: not archived, in the In Progress category, assigned to the caller.
 */
function holdsClaim(
  state: {
    statusCategory: string | null;
    assigneeId: string | null;
    archivedAt: Date | null;
  } | null,
  userId: string,
): boolean {
  return (
    state !== null &&
    state.archivedAt === null &&
    state.statusCategory === 'in_progress' &&
    state.assigneeId === userId
  );
}

/** The project key a `MOTIR-<n>` identifier belongs to. */
function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

/** The dispositions a leg can still leave at close. */
const NON_TERMINAL: readonly DispatchCardDisposition[] = ['queued', 'running'];

/**
 * The terminal STATUS a stop reason implies.
 *
 * Derived rather than supplied, because it is the mapping every caller would
 * otherwise re-implement — differently — and the three interesting rows are the
 * ones a naive mapping gets wrong:
 *
 *   * `halted` is the only FAILURE. An agent failed and the loop stopped.
 *   * `interrupted` is `cancelled`, not failed: somebody pressed Ctrl-C, which
 *     is a decision rather than a fault.
 *   * `abandoned` is `timed_out`, and only the reap writes it — a process that
 *     died cannot report that it died.
 *   * `replanned` is a SUCCESS, and this is the row that matters most. The
 *     agent refused a card, submitted a plan and exited 0; a run summary that
 *     calls that a failure teaches an operator to ignore failures.
 */
function statusForStopReason(
  stopReason: DispatchStopReason,
): 'succeeded' | 'failed' | 'cancelled' | 'timed_out' {
  if (stopReason === 'halted') return 'failed';
  if (stopReason === 'interrupted') return 'cancelled';
  if (stopReason === 'abandoned') return 'timed_out';
  return 'succeeded';
}

type ClosedRunStatus = 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

/**
 * The status the close WRITES — the stated one ({@link statusForStopReason}, or
 * the caller's own), corrected by what the run's LEGS say (MOTIR-10984).
 *
 * A stop reason says WHY the loop ended; it does not say whether the work got
 * done. An adopted scope drains with `keepGoing` (MOTIR-6558), so a card that
 * fails does not halt the loop: the drain skips its dependents and closes
 * `drained` — which is still true, nothing was left to try — and a run that built
 * one card of four was recorded `succeeded`. The legs are known here, in the
 * close's own transaction, so the status is derived from them rather than
 * trusted to the client.
 *
 *   * A leg REPORTED `failed` makes the run `failed`, whatever stop reason the
 *     client sent — `interrupted` included: a card had already failed before
 *     anybody stopped the run, and a `cancelled` run reads as a decision rather
 *     than a fault.
 *   * Only a REPORTED failure counts, read before this close settles anything. A
 *     leg the close itself settles from `running` to `failed` means *nobody
 *     reported an outcome*, not *the agent failed* — under `interrupted` it is
 *     the Ctrl-C that stopped that very agent, under `abandoned` the reap that
 *     found it dead — and a run that delivered and closed without its last
 *     `card_settled` must not be sent to To fix for a missing report.
 *   * `failed` and `timed_out` stand as stated. `timed_out` is the reap's or a
 *     supervisor's word for a run that died, which says more than `failed` would,
 *     and both are doors a dead run is continued through.
 */
function closingStatus(
  stated: ClosedRunStatus,
  legs: readonly { disposition: DispatchCardDisposition }[],
): ClosedRunStatus {
  if (stated === 'failed' || stated === 'timed_out') return stated;
  return legs.some((leg) => leg.disposition === 'failed') ? 'failed' : stated;
}

/**
 * What an unsettled leg becomes when the run closes under it.
 *
 * `queued` → `not_reached`: the run took the card and never got to it, which is
 * neither a skip (nothing decided to leave it out) nor a failure (nothing ran).
 *
 * `running` → `failed`: the run ended while an agent was on this card and
 * nothing ever reported an outcome. Calling that `not_reached` would say the
 * opposite of what happened, and there is no terminal member meaning *unknown* —
 * `failed` is the only one that does not claim work landed, which is the safe
 * direction for a card somebody now has to look at.
 */
function settledDisposition(current: DispatchCardDisposition): DispatchCardDisposition {
  return current === 'running' ? 'failed' : 'not_reached';
}

/**
 * The Runs room's SERVED scope (Story MOTIR-6179 · MOTIR-6331), resolved once per
 * read inside its transaction — the plan reads' shape (`planSessionsService`) and
 * the Approvals room's (`approvalGatesService.listRecords`). An omitted `view`
 * asks for `project`, which is what every reader saw before the scope existed.
 * `createdById` is the `mine` narrowing the repository applies, or undefined.
 */
async function resolveRunScope(
  projectId: string,
  ctx: ServiceContext,
  requested: DispatchRunView | undefined,
  tx: Prisma.TransactionClient,
): Promise<{ scope: DispatchRunView; createdById: string | undefined }> {
  const held = await projectAccessService.getPermissions(projectId, ctx, tx);
  if ((requested ?? 'project') === 'project' && holdsRecordView(held, ctx, 'run:view_any')) {
    return { scope: 'project', createdById: undefined };
  }
  return { scope: 'mine', createdById: ctx.userId };
}

/**
 * The record-level admit for ONE run (MOTIR-6331): the reader browses the run's
 * project AND either holds `run:view_any` (role ∩ grant) or STARTED the run.
 * Otherwise the SAME `DispatchRunNotFoundError` an unknown id throws, so a run
 * link confirms nothing about a run the reader may not see. Called inside the
 * read's transaction.
 */
/**
 * A continue's branches with each repository's clone URL (MOTIR-6795), read
 * OUTSIDE the run read's transaction as `listDispatchRepoNames` requires. A
 * coordinate the project cannot supply reads as `null` — the read of the run
 * never fails on it; the container then works only where it has a checkout.
 */
async function withCloneUrls(
  continues: DispatchRunContinuesDto,
  projectId: string,
  ctx: ServiceContext,
): Promise<DispatchRunContinuesDto> {
  let domain: Awaited<ReturnType<typeof listDispatchRepoNames>> = [];
  try {
    domain = await listDispatchRepoNames(projectId, ctx);
  } catch {
    return continues;
  }
  return {
    ...continues,
    branches: continues.branches.map((b) => ({
      ...b,
      cloneUrl:
        (b.repository &&
          domain.find((r) => r.name.toLowerCase() === b.repository!.toLowerCase())?.cloneUrl) ||
        null,
    })),
  };
}

async function assertMayReadRun(
  run: { id: string; projectId: string; createdById: string | null },
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<void> {
  let held: ReadonlySet<PermissionKey>;
  try {
    held = await projectAccessService.getPermissions(run.projectId, ctx, tx);
  } catch (err) {
    // A project the actor may not address (another tenant, a token bound to a
    // different project) is the run's not-found too — never a second error shape.
    if (err instanceof ProjectNotFoundError) throw new DispatchRunNotFoundError(run.id);
    throw err;
  }
  if (!held.has('project:browse')) throw new DispatchRunNotFoundError(run.id);
  if (holdsRecordView(held, ctx, 'run:view_any')) return;
  if (run.createdById !== null && run.createdById === ctx.userId) return;
  throw new DispatchRunNotFoundError(run.id);
}

/**
 * A HOSTED run's token and credit cost — model calls, machine time (MOTIR-6514)
 * and their total — read from motir-ai by the run's own id (MOTIR-689; `docs/decisions/hosted-agent-run.md` §1). Zeroes when motir-ai has
 * recorded no billed call yet (its 404); `null` when it could not be asked at
 * all — a transport failure, a refusal or an unconfigured deployment — so an
 * outage never reads as a run that cost nothing, and never fails the run page.
 */
async function readHostedRunCost(runId: string): Promise<DispatchRunCostDto | null> {
  try {
    const usage = await getAgentRunUsage(runId);
    return {
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cacheReadTokens: usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
      credits: usage?.credits ?? 0,
      machineCredits: usage?.machineCredits ?? 0,
      totalCredits: usage?.totalCredits ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * The end paths' closing-line prefix: the hosted run's `[motir] hosted run ended
 * (<label>): `, or a run in an agent's `[motir] run in agent ended (<label>): `
 * (`agentInstanceRunService.end`, MOTIR-7027) — both carry `data.end`.
 */
const HOSTED_END_PREFIX = /^\[motir\] (?:hosted run|run in agent) ended \([^)]*\): /;

/**
 * How a HOSTED run ended (MOTIR-691): the end path's closing `log` line
 * (`hostedRunService.endHostedRun`, `data.end`) and its legs' agent exit codes.
 * Read, never stored. A leg's exit code is on the leg itself — the ingest writes
 * an `agent_exited` event's code onto its `dispatch_run_card`, not into the
 * event's data.
 */
async function readHostedEnd(
  runId: string,
  legExitCodes: readonly (number | null)[],
  tx: Prisma.TransactionClient,
): Promise<DispatchRunHostedEndDto> {
  const line = await dispatchRunEventRepository.findHostedEndLine(runId, tx);
  const endData = line?.data as { end?: unknown } | null | undefined;
  const detail = line?.body ? line.body.replace(HOSTED_END_PREFIX, '').trim() : '';
  // The failing leg's code when one failed; otherwise any recorded code.
  const codes = legExitCodes.filter((c): c is number => c !== null);
  const exitCode = codes.find((c) => c !== 0) ?? codes[0] ?? null;
  return {
    outcome: typeof endData?.end === 'string' ? endData.end : null,
    detail: detail === '' ? null : detail,
    exitCode,
  };
}

/**
 * A hosted run's own credential may reach ONE run (MOTIR-688,
 * `docs/decisions/hosted-agent-run.md` §3). `ctx.tokenDispatchRunId` is set only
 * when a RUN token reached an ingest route that admits one; every other caller
 * leaves it absent and passes straight through.
 *
 * ⚠️ Checked BEFORE the run is read, so a refusal says nothing about whether the
 * named run exists, is closed, or lives elsewhere. Pass `null` for an OPEN,
 * which a run token never performs: the server opens a hosted run itself.
 */
export function assertRunTokenScope(runId: string | null, ctx: ServiceContext): void {
  if (ctx.tokenDispatchRunId === undefined) return;
  if (runId === null || runId !== ctx.tokenDispatchRunId) {
    throw new DispatchRunTokenOutOfScopeError();
  }
}

/**
 * A Runs-room read's reader (Story MOTIR-6170 · MOTIR-6645): a member's own
 * context, or — for a Visitor — the narrowed service context (bound to their one
 * public project, granted the Visitor keys) plus the private-epic hidden set. A
 * run scoped to, or carrying a card for, a hidden item is withheld; reading one
 * by id answers exactly as an unknown id does.
 */
function runReader(ctx: ServiceContext | VisitorReadContext): {
  svc: ServiceContext;
  hidden?: readonly string[];
  projectId?: string;
} {
  if (!isVisitorContext(ctx)) return { svc: ctx };
  return {
    svc: visitorServiceContext(ctx),
    hidden: [...ctx.hiddenIds],
    projectId: ctx.project.id,
  };
}

/** Who reads a run surface — the *you* its manual legs are resolved against (MOTIR-7477). */
function runSurfaceReader(ctx: ServiceContext): DispatchRunReader {
  return { userId: ctx.userId, visitor: ctx.userId === VISITOR_ACTOR_ID };
}

/** A leg the run skipped because a PERSON owes the work — the only leg with a gate to name. */
const isManualLeg = (card: { disposition: string; skipReason: string | null }): boolean =>
  card.disposition === 'skipped' && card.skipReason === 'needs_human';

/**
 * Each MANUAL leg's `manual_work` gate, resolved for this reader (Story MOTIR-7460
 * · MOTIR-7477) — keyed by work-item id, over EVERY run handed in, in ONE read: a
 * page of runs costs the same one query as a single run.
 */
async function manualLegGates(
  runs: ReadonlyArray<{
    cards: ReadonlyArray<{
      workItemId: string | null;
      disposition: string;
      skipReason: string | null;
    }>;
  }>,
  reader: DispatchRunReader,
  tx: Prisma.TransactionClient,
): Promise<Map<string, DispatchRunLegGateDto | null>> {
  const ids = new Set<string>();
  for (const run of runs) {
    for (const card of run.cards) {
      if (card.workItemId !== null && isManualLeg(card)) ids.add(card.workItemId);
    }
  }
  const heads = await approvalGateRepository.findLatestWithPeopleByWorkItems(
    [...ids],
    'manual_work',
    tx,
  );
  return new Map([...ids].map((id) => [id, toDispatchRunLegGateDto(heads.get(id), reader)]));
}

/** A leg's gate out of {@link manualLegGates}' map — `null` for every leg that is not manual. */
function legGateOf(
  card: { workItemId: string | null; disposition: string; skipReason: string | null },
  gates: ReadonlyMap<string, DispatchRunLegGateDto | null>,
): DispatchRunLegGateDto | null {
  if (card.workItemId === null || !isManualLeg(card)) return null;
  return gates.get(card.workItemId) ?? null;
}

/** Whether a loaded run joins a withheld work item (its scope or any card). */
function runTouches(
  run: { scopeWorkItemId: string | null; cards: ReadonlyArray<{ workItemId: string | null }> },
  hidden: readonly string[] | undefined,
): boolean {
  if (!hidden || hidden.length === 0) return false;
  const set = new Set(hidden);
  if (run.scopeWorkItemId && set.has(run.scopeWorkItemId)) return true;
  return run.cards.some((card) => card.workItemId !== null && set.has(card.workItemId));
}

/**
 * How a close takes the covered cards' row locks (MOTIR-6881). `wait` is every
 * caller with somebody waiting on the answer. `skip_if_busy` is the run SWEEPS: a
 * background pass must never wait on a card lock another writer holds, because the
 * writer it would wait on (a continue claim) holds that card and then wants the
 * run — see `lockCoveredCards`.
 */
export type RunCardLockMode = 'wait' | 'skip_if_busy';

/**
 * Every work item a run COVERS — the scope card of a parent or scope run FIRST,
 * then each leg's card, ascending by id, without duplicates. This order is the
 * lock order, so it is the one place it is decided.
 */
function coveredCardIds(run: {
  scopeWorkItemId: string | null;
  cards: ReadonlyArray<{ workItemId: string | null }>;
}): { scope: string | null; legs: string[] } {
  const legs = [
    ...new Set(
      run.cards
        .map((card) => card.workItemId)
        .filter((id): id is string => id !== null && id !== run.scopeWorkItemId),
    ),
  ].sort();
  return { scope: run.scopeWorkItemId, legs };
}

/**
 * Take the covered cards' ROW LOCKS — BEFORE the run's own lock (MOTIR-6881).
 *
 * ⚠️ THE ORDER IS CARD, THEN RUN, BECAUSE `claimContinue` ALREADY TAKES IT THAT WAY.
 * The claim locks the card it is claiming, then closes the lapsed run (the run's
 * lock) inside the same transaction. A close that took the run first and the cards
 * second — which a recompute after the settle would do by itself — is the inverse
 * order, and `reapLapsed` racing `claimContinue` on one card would deadlock.
 *
 * Within the cards: the SCOPE card first (a parent-run claim holds the scope card
 * when it closes the run), then the legs ascending. A claim on one card of a
 * scope-LESS multi-card run can still hold a leg out of that order, which no fixed
 * order fixes; that is why the sweeps pass `skip_if_busy` — they never wait on a
 * card lock, and back off with {@link DispatchRunCardsBusyError} instead.
 */
async function lockCoveredCards(
  covered: { scope: string | null; legs: string[] },
  runId: string,
  mode: RunCardLockMode,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (mode === 'wait') {
    if (covered.scope) await workItemRepository.lockById(covered.scope, tx);
    await workItemRepository.lockByIds(covered.legs, tx);
    return;
  }
  const wanted = [...(covered.scope ? [covered.scope] : []), ...covered.legs];
  const got = await workItemRepository.tryLockByIds(wanted, tx);
  if (got.length !== wanted.length) throw new DispatchRunCardsBusyError(runId);
}

/**
 * RECOMPUTE the To fix reason of every card a run covers (MOTIR-6881) — after the
 * run was opened or closed, in the same transaction. The trigger is the TRANSITION:
 * a close takes the run out of the running set and an open puts one in, which is
 * exactly what the dead-run reason (`run_died`) reads. A heartbeat changes neither.
 */
async function recomputeCovered(
  covered: { scope: string | null; legs: string[] },
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (covered.scope) await recomputeWorkItemFixReason(covered.scope, tx);
  for (const id of covered.legs) await recomputeWorkItemFixReason(id, tx);
  // …and To resume (MOTIR-7707): a `gated` close puts the cards on it, and the next
  // open on them — a continue, a fresh run — takes them off.
  if (covered.scope) await recomputeWorkItemResumeState(covered.scope, tx);
  for (const id of covered.legs) await recomputeWorkItemResumeState(id, tx);
}

/**
 * RECORD THE GATES A `gated` RUN STOPPED AT (Story MOTIR-7701 · MOTIR-7703;
 * `dispatch-run-record.md` AMENDMENT 2026-10-07) — inside the close's own
 * transaction, after its lock, so every door (the ingest close, the agent's
 * `close_work_item_run`, the hosted end) writes the same record and no reporter
 * names a gate itself.
 *
 * The scope is the run's legs plus, for a run pointed at a container, that
 * container's children: a scoped drain that never reached a gated child still
 * stopped because of it. Only `awaiting` gates of the five stopper kinds count
 * ({@link RUN_HOLDING_GATE_KINDS}). None found — the gate was decided in the same
 * minute — writes nothing, and the run still closes `gated`.
 *
 * Reads only: the covered cards are already locked by {@link lockCoveredCards},
 * and the gate rows are read without a lock, so the close's lock set does not widen.
 */
async function recordHeldGates(
  run: { id: string; workspaceId: string; scopeWorkItemId: string | null },
  covered: { scope: string | null; legs: string[] },
  tx: Prisma.TransactionClient,
): Promise<void> {
  const ids = new Set(covered.legs);
  if (run.scopeWorkItemId) {
    for (const child of await workItemRepository.findChildren(run.scopeWorkItemId, tx)) {
      ids.add(child.id);
    }
  }
  const gates = await approvalGateRepository.findAwaitingByWorkItemsAndKinds(
    [...ids],
    RUN_HOLDING_GATE_KINDS,
    tx,
  );
  await dispatchRunHeldGateRepository.createMany(
    gates.flatMap((gate) =>
      gate.workItemId === null
        ? []
        : [
            {
              workspaceId: run.workspaceId,
              dispatchRunId: run.id,
              gateId: gate.id,
              workItemId: gate.workItemId,
              kind: gate.kind,
            },
          ],
    ),
    tx,
  );
}

/** The partial unique index holding one running run per agent (MOTIR-7023). */
const AGENT_RUNNING_INDEX = 'dispatch_run_agent_instance_running_key';

/**
 * A {@link DispatchRunAgentBusyError} raised by a LOST RACE carries no run id: the
 * unique violation aborted the transaction it was raised in. By the time it
 * reaches here the winner has committed (PostgreSQL made the loser's insert wait
 * for it), so a fresh transaction reads it and the error leaves the service naming
 * it. Every other error passes through unchanged. A caller of
 * {@link dispatchRunService.openWithin} that owns its own transaction does the
 * same with this function.
 */
export async function namedAgentBusy(
  err: unknown,
  bound: { userId: string; workspaceId: string; projectId?: string },
): Promise<unknown> {
  if (!(err instanceof DispatchRunAgentBusyError) || err.runId !== null) return err;
  const winner = await withWorkspaceContext(bound, (tx) =>
    dispatchRunRepository.findRunningByAgentInstance(err.agentInstanceId, tx),
  );
  // The winner may already have closed; the refusal still stands for this open.
  return winner ? new DispatchRunAgentBusyError(err.agentInstanceId, winner.id) : err;
}

/**
 * Bump a run's agent's idle signal (MOTIR-7027). Best effort: a failure is
 * logged, never thrown — the events are already committed.
 */
async function bumpAgentActivity(agentInstanceId: string): Promise<void> {
  try {
    await agentInstanceActivityService.touchRunActivity(agentInstanceId);
  } catch (err) {
    console.warn('[dispatchRunService] could not bump the agent’s activity', {
      agentInstanceId,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Revoke a closed run-in-an-agent's credentials (MOTIR-7027) through the run's
 * own service — reached by a dynamic import because that service composes this
 * one. `revokeCredentials` never throws.
 */
async function revokeAgentRunCredentials(runId: string): Promise<void> {
  const { agentInstanceRunService } = await import('@/lib/services/agentInstanceRunService');
  await agentInstanceRunService.revokeCredentials(runId);
}

/**
 * The APPEND's write half, inside a transaction the CALLER holds (MOTIR-7450) — the
 * ONE append path, shared by the v1 ingest ({@link dispatchRunService.appendEvents},
 * `reportedBy: 'cli'`) and the agent's own report
 * ({@link dispatchRunService.reportAction}, `reportedBy: 'agent'`), so the sequence
 * numbers, the leg resolution and the leg moves cannot differ between the two.
 *
 * It takes the run's row lock itself; `tx` must be bound to the run's workspace.
 */
async function appendEventsWithin(
  runId: string,
  events: AppendDispatchRunEventInput[],
  reportedBy: DispatchRunReporter,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<{ appended: DispatchRunAppendedDto; agentInstanceId: string | null }> {
  for (const event of events) {
    if (event.body !== undefined) {
      const bytes = Buffer.byteLength(event.body, 'utf8');
      if (bytes > DISPATCH_RUN_EVENT_BODY_LIMIT_BYTES) {
        throw new DispatchRunEventBodyTooLargeError(DISPATCH_RUN_EVENT_BODY_LIMIT_BYTES, bytes);
      }
    }
    if (event.model !== undefined && event.kind !== 'agent_exited') {
      throw new DispatchRunEventModelNotAllowedError(event.kind);
    }
  }
  const locked = await dispatchRunRepository.findTerminalStateForUpdate(runId, tx);
  if (!locked) throw new DispatchRunNotFoundError(runId);
  if (locked.status !== 'running') {
    throw new DispatchRunTerminalError(runId, locked.status);
  }

  const existingCount = await dispatchRunEventRepository.countByRun(runId, tx);
  if (existingCount + events.length > DISPATCH_RUN_EVENT_LIMIT) {
    throw new DispatchRunEventLimitError(runId, DISPATCH_RUN_EVENT_LIMIT);
  }

  const legs = await dispatchRunCardRepository.listByRun(runId, tx);
  const legByKey = new Map(
    legs.filter((l) => l.workItemKey !== null).map((l) => [l.workItemKey!, l]),
  );

  let seq = (await dispatchRunEventRepository.maxSeq(runId, tx)) ?? 0;
  const rows: Prisma.DispatchRunEventCreateManyInput[] = [];
  const touched = new Map<string, DispatchRunCard>();

  for (const event of events) {
    let leg: DispatchRunCard | null = null;
    if (event.workItemKey !== undefined) {
      const key = event.workItemKey.trim().toUpperCase();
      leg = touched.get(key) ?? legByKey.get(key) ?? null;
      if (!leg) throw new UnknownDispatchRunCardError(key);
    }

    seq += 1;
    rows.push({
      workspaceId: ctx.workspaceId,
      dispatchRunId: runId,
      ...(leg ? { dispatchRunCardId: leg.id } : {}),
      seq,
      kind: event.kind,
      reportedBy,
      ...(event.data !== undefined ? { data: event.data } : {}),
      ...(event.body !== undefined ? { body: event.body } : {}),
    });

    // The agent's self-reported model (MOTIR-7502): the top-level `model`,
    // else the `data.model` every installed CLI already sends. A null
    // answer writes NOTHING — an exit with no report never erases a model
    // the leg already carries.
    const model = event.kind === 'agent_exited' ? reportedModelOf(event) : null;

    // The leg's own move, in this same transaction. Applied event by event
    // rather than folded at the end, so a batch that moves one card twice
    // leaves it where its LAST event says — the order the reporter sent.
    if (
      leg &&
      (event.disposition !== undefined ||
        event.sessionBranch !== undefined ||
        event.exitCode !== undefined ||
        model !== null)
    ) {
      const now = new Date();
      const disposition = event.disposition;
      const updated = await dispatchRunCardRepository.update(
        leg.id,
        {
          ...(disposition !== undefined
            ? {
                disposition,
                // The CHECK constraint asserts the pairing in both
                // directions, so a move OFF `skipped` must clear the
                // reason rather than leave it behind.
                skipReason: disposition === 'skipped' ? (event.skipReason ?? null) : null,
                ...(disposition === 'running' && leg.startedAt === null ? { startedAt: now } : {}),
                ...(!NON_TERMINAL.includes(disposition) ? { endedAt: now } : {}),
              }
            : {}),
          ...(event.sessionBranch !== undefined ? { sessionBranch: event.sessionBranch } : {}),
          ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
          ...(model !== null ? { model } : {}),
        },
        tx,
      );
      touched.set(updated.workItemKey ?? updated.id, updated);
      // The same raise as the open's, for a leg the run skips as it goes.
      // Idempotent on the card, so a leg reported twice asks once.
      if (updated.workItemId !== null && raisesManualWork(disposition, event.skipReason)) {
        await manualWorkGateService.raise(
          updated.workItemId,
          { createdById: locked.createdById },
          ctx.workspaceId,
          tx,
        );
      }
    }
  }

  const created = await dispatchRunEventRepository.createMany(rows, tx);
  return {
    agentInstanceId: locked.agentInstanceId,
    appended: {
      runId,
      appended: created,
      seq,
      cards: [...touched.values()].map(toDispatchRunCardDto),
    },
  };
}

/**
 * APPEND the cards a RE-OPEN names that the run does not hold yet (MOTIR-8632).
 *
 * `motir auto` holds no plan: it opens its run with an empty set and re-issues
 * the open, on the same `idempotencyKey`, for each card it reaches. Returning the
 * run untouched on that idempotent hit wrote no leg for an `auto` run at all, and
 * every per-card event it then sent was refused as naming a card the run does not
 * own. So the hit appends the new cards here, after the legs already there, in
 * the open's own transaction.
 *
 * A retry that names only cards the run already holds appends nothing and takes
 * no lock, which keeps the plain retry of a whole-set open as cheap as before. A
 * card outside the project refuses the whole re-open, as a first open does. A
 * run that has already ENDED keeps the set it ended with: a re-open after the
 * close returns the run as it is.
 */
async function appendLegsWithin(
  runId: string,
  projectId: string,
  cards: OpenDispatchRunInput['cards'],
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (cards.length === 0) return;
  const held = new Set(
    (await dispatchRunCardRepository.listByRun(runId, tx)).map((leg) => leg.workItemKey),
  );
  const wanted = new Map<string, OpenDispatchRunInput['cards'][number]>();
  for (const card of cards) {
    const key = card.key.trim().toUpperCase();
    if (!held.has(key) && !wanted.has(key)) wanted.set(key, card);
  }
  if (wanted.size === 0) return;

  const items = await workItemRepository.findByIdentifiers(projectId, [...wanted.keys()], tx);
  const byKey = new Map(items.map((i) => [i.identifier, i]));
  for (const key of wanted.keys()) {
    if (!byKey.has(key)) throw new UnknownDispatchRunCardError(key);
  }

  // Cards, then the run — the order `lockCoveredCards` documents, so an append
  // racing a close or a continue claim cannot deadlock against it.
  const ids = [...new Set(items.map((i) => i.id))].sort();
  await workItemRepository.lockByIds(ids, tx);
  const locked = await dispatchRunRepository.findTerminalStateForUpdate(runId, tx);
  if (!locked || locked.status !== 'running') return;

  // Re-read under the run's lock: a concurrent re-open may have appended the same
  // card, or taken the next position, since the unlocked read above.
  const legs = await dispatchRunCardRepository.listByRun(runId, tx);
  const heldIds = new Set(legs.map((leg) => leg.workItemId));
  let position = legs.reduce((max, leg) => Math.max(max, leg.position), -1);
  const rows: Parameters<typeof dispatchRunCardRepository.createMany>[0] = [];
  const added: { workItemId: string; card: OpenDispatchRunInput['cards'][number] }[] = [];
  for (const [key, card] of wanted) {
    const item = byKey.get(key)!;
    if (heldIds.has(item.id)) continue;
    heldIds.add(item.id);
    position += 1;
    rows.push({
      workspaceId: ctx.workspaceId,
      dispatchRunId: runId,
      workItemId: item.id,
      workItemKey: key,
      position,
      disposition: card.disposition,
      ...(card.skipReason !== undefined ? { skipReason: card.skipReason } : {}),
    });
    added.push({ workItemId: item.id, card });
  }
  if (rows.length === 0) return;

  await dispatchRunCardRepository.createMany(rows, tx);
  for (const { workItemId, card } of added) {
    if (raisesManualWork(card.disposition, card.skipReason)) {
      await manualWorkGateService.raise(
        workItemId,
        { createdById: locked.createdById },
        ctx.workspaceId,
        tx,
      );
    }
  }
  // The appended card is now covered by a running run, as an opened one is.
  await recomputeCovered({ scope: null, legs: added.map((a) => a.workItemId).sort() }, tx);
}

export const dispatchRunService = {
  /**
   * OPEN a run WITH ITS SET.
   *
   * ⚠️ THE SET ARRIVES HERE, AND THIS IS THE OPERATION THE WHOLE RECORD IS
   * SHAPED AROUND. A scoped run has just claimed eleven cards; a batch has just
   * frozen a snapshot of nine taken and four skipped. That knowledge exists for
   * exactly one moment, in one process — reconstructing it afterwards from a
   * stream of per-card events would yield a list of what the run GOT ROUND TO,
   * and would lose the skipped cards entirely, which exist nowhere else at all.
   *
   * IDEMPOTENT on `idempotencyKey`: the read runs first and a repeat returns the
   * EXISTING run with `created: false`, after appending any card it names that
   * the run does not hold yet (`appendLegsWithin` — `motir auto`'s legs). The unique index is the arbiter of the
   * narrow race between that read and the insert, and a `P2002` is translated
   * rather than allowed to escape.
   */
  async open(input: OpenDispatchRunInput, ctx: ServiceContext): Promise<DispatchRunOpenedDto> {
    assertRunTokenScope(null, ctx);
    const project = await projectsService.getByKey(input.projectKey, ctx);
    await projectAccessService.assertCanEdit(project.id, ctx);

    const bound = { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id };
    try {
      return await withWorkspaceContext(bound, (tx) =>
        dispatchRunService.openWithin(project.id, input, ctx, tx),
      );
    } catch (err) {
      throw await namedAgentBusy(err, bound);
    }
  },

  /**
   * The OPEN's write half, inside a transaction the CALLER holds — extracted
   * (MOTIR-5464) so the repair claim can open its `fix` run under the card's row
   * lock, in the same transaction that decided nobody else holds the repair.
   * A second copy of the insert beside the claim would be a second definition of
   * what opening a run writes.
   *
   * The caller has already resolved the project and asserted it may edit it; this
   * method asserts nothing, and `tx` must be bound to the caller's workspace.
   */
  async openWithin(
    projectId: string,
    input: Omit<OpenDispatchRunInput, 'projectKey'>,
    ctx: ServiceContext,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunOpenedDto> {
    if (input.idempotencyKey) {
      const existing = await dispatchRunRepository.findByIdempotencyKey(
        ctx.workspaceId,
        input.idempotencyKey,
        tx,
      );
      if (existing) {
        await appendLegsWithin(existing.id, projectId, input.cards, ctx, tx);
        const withCards = await dispatchRunRepository.findByIdWithCards(existing.id, tx);
        /* v8 ignore next -- the row was just read inside this transaction */
        if (!withCards) throw new DispatchRunNotFoundError(existing.id);
        const seq = (await dispatchRunEventRepository.maxSeq(existing.id, tx)) ?? 0;
        return { run: toDispatchRunDto(withCards, seq), created: false };
      }
    }

    // Resolve the SET before writing anything: a run whose plan names a card
    // that is not in this project is a client bug, and half a set is worse
    // than none.
    const keys = input.cards.map((c) => c.key.trim().toUpperCase());
    const items = await workItemRepository.findByIdentifiers(projectId, keys, tx);
    const byKey = new Map(items.map((i) => [i.identifier, i]));
    const scopeItem = input.scopeKey
      ? await workItemRepository.findByIdentifier(
          projectId,
          input.scopeKey.trim().toUpperCase(),
          tx,
        )
      : null;
    if (input.scopeKey && !scopeItem) {
      throw new UnknownDispatchRunCardError(input.scopeKey.trim().toUpperCase());
    }
    for (const key of keys) {
      if (!byKey.has(key)) throw new UnknownDispatchRunCardError(key);
    }

    // A run in an agent names its agent, and only such a run does (§5). The
    // CHECK constraint holds the second half in the database too.
    const origin = input.origin ?? 'local';
    if ((origin === 'instance') !== (input.agentInstanceId !== undefined)) {
      throw new DispatchRunAgentInstanceMismatchError(origin);
    }
    // ONE RUNNING RUN PER AGENT (§5). This read answers the common case with the
    // running run's id; the partial unique index is the arbiter of the race
    // between it and the insert below.
    if (input.agentInstanceId !== undefined) {
      const running = await dispatchRunRepository.findRunningByAgentInstance(
        input.agentInstanceId,
        tx,
      );
      if (running) throw new DispatchRunAgentBusyError(input.agentInstanceId, running.id);
    }

    let run;
    try {
      run = await dispatchRunRepository.create(
        {
          workspace: { connect: { id: ctx.workspaceId } },
          project: { connect: { id: projectId } },
          command: input.command,
          origin,
          reportedBy: input.reportedBy,
          ...(input.agentInstanceId !== undefined
            ? { agentInstance: { connect: { id: input.agentInstanceId } } }
            : {}),
          ...(scopeItem ? { scope: { connect: { id: scopeItem.id } } } : {}),
          ...(input.scopeLabel !== undefined ? { scopeLabel: input.scopeLabel } : {}),
          ...(input.agent !== undefined ? { agent: input.agent } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          createdBy: { connect: { id: ctx.userId } },
        },
        tx,
      );
    } catch (err) {
      // The narrow window between the read above and this insert. Translate
      // it: a raw `P2002` escaping the service would reach a client as a
      // bare 500 for a condition that has a correct, specific answer.
      if (
        input.agentInstanceId !== undefined &&
        uniqueViolationConstraints(err)?.includes(AGENT_RUNNING_INDEX)
      ) {
        // The violation aborted this transaction, so the winner cannot be read
        // here; `open` names it from a fresh one (`namedAgentBusy`).
        throw new DispatchRunAgentBusyError(input.agentInstanceId, null);
      }
      if (
        input.idempotencyKey &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new DuplicateDispatchRunError(input.idempotencyKey);
      }
      throw err;
    }

    if (keys.length > 0) {
      await dispatchRunCardRepository.createMany(
        input.cards.map((card, position) => {
          const key = keys[position]!;
          return {
            workspaceId: ctx.workspaceId,
            dispatchRunId: run.id,
            workItemId: byKey.get(key)!.id,
            workItemKey: key,
            position,
            disposition: card.disposition,
            ...(card.skipReason !== undefined ? { skipReason: card.skipReason } : {}),
          };
        }),
        tx,
      );
      // A run that reached a manual card asks its person to do the work
      // (MOTIR-7475; `docs/decisions/manual-work-gate.md` §2) — in this
      // transaction, so the leg and its gate commit together or not at all.
      for (const [position, card] of input.cards.entries()) {
        if (raisesManualWork(card.disposition, card.skipReason)) {
          await manualWorkGateService.raise(
            byKey.get(keys[position]!)!.id,
            { createdById: run.createdById },
            ctx.workspaceId,
            tx,
          );
        }
      }
    }

    const withCards = await dispatchRunRepository.findByIdWithCards(run.id, tx);
    /* v8 ignore next -- the row was just written inside this transaction */
    if (!withCards) throw new DispatchRunNotFoundError(run.id);

    // A NEW run on a card whose last run died makes that card's run ALIVE again,
    // which clears `run_died` (MOTIR-6881) — `motir run` again, Run hosted, a
    // repair run, the continue run itself. Cards first, ascending, as a close
    // takes them, so two writers on one card set cannot lock it in two orders.
    const covered = coveredCardIds(withCards);
    await lockCoveredCards(covered, run.id, 'wait', tx);
    await recomputeCovered(covered, tx);
    return { run: toDispatchRunDto(withCards, 0), created: true };
  },

  /**
   * APPEND a batch of events, and apply any leg dispositions they carry.
   *
   * ⚠️ THE `seq` IS SERVER-ASSIGNED, UNDER THE RUN'S OWN ROW LOCK. Two things
   * need that lock and they are the same lock: the terminal check (a read-derived
   * refusal — see `close` for the full argument), and the allocation of the next
   * `seq`. Reading the max and adding one WITHOUT the lock hands two concurrent
   * appenders the same number, and the unique index would then reject one of them
   * — turning a routine retry into a lost batch. With it, the second appender
   * waits and numbers from what the first actually wrote.
   *
   * ⚠️ AND THE DISPOSITION MOVES IN THE SAME TRANSACTION AS ITS EVENT. That is
   * the difference between a viewer seeing a card go `implemented` at the moment
   * it happens and seeing every card change at close: the surface's whole reason
   * to exist is the first one.
   */
  async appendEvents(
    runId: string,
    events: AppendDispatchRunEventInput[],
    ctx: ServiceContext,
  ): Promise<DispatchRunAppendedDto> {
    assertRunTokenScope(runId, ctx);
    const { appended, agentInstanceId } = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => appendEventsWithin(runId, events, 'cli', ctx, tx),
    );
    // A run in an agent keeps its agent awake (`agent-instance-run.md` §6,
    // MOTIR-7027): an accepted event bumps the agent's idle signal, at most once a
    // minute — after the commit, and never a reason to refuse the events.
    if (agentInstanceId !== null) await bumpAgentActivity(agentInstanceId);
    return appended;
  },

  /**
   * RECORD A FINDING — what a run produced that is not code (MOTIR-3981,
   * `run-findings-protocol.md` Q5): a bug it filed, or a plan it submitted —
   * or, since MOTIR-6282, what the run-found report concluded on a leg whose
   * runner stopped on an unbuildable target (`unbuildable_reported`, keyed on
   * the leg, so at most one per leg).
   *
   * ⚠️ THE SERVER WRITES THESE, AND IT IS THE ONLY THING THAT CAN. Every other
   * `DispatchEventKind` member is emitted by the run's own reporter as it does
   * the thing; these two are appended by the SERVICE that performs the write,
   * because the ids exist only there. The CLI cannot report them — both come
   * back on the dispatched agent's stdout, which the loop streams to the
   * terminal and never captures (`plansService.approvePlanForWorkItem`'s
   * comment says so about the plan id exactly). Scraping that output, or a
   * second read whose answer the caller then supplies, are the two mechanisms
   * `run-findings-protocol.md` Q2 rejected when it chose a card-addressed
   * approve over a plan-addressed one.
   *
   * ⚠️ BEST-EFFORT, AND NEVER LOAD-BEARING. It runs in its OWN transaction, so
   * the caller's write is already committed when this is reached, and every
   * failure is swallowed: a bug that was filed stays filed even if the run it
   * belonged to closed a millisecond earlier, and a plan that reached `planned`
   * stays there even if this append throws. Reporting is an OBSERVATION of the
   * run, so it may never change what the run DID.
   *
   * ⚠️ NO OPEN LEG MEANS NO EVENT, and that is the correct record rather than a
   * miss — see {@link dispatchRunCardRepository.findOpenLegForWorkItem}. With
   * `at`, the same holds of the leg open AT THAT INSTANT
   * ({@link dispatchRunCardRepository.findLegSpanningInstantForWorkItem}), and
   * the event may then land on a leg that has settled, or a run that has closed:
   * the finding is the run's even though the model finished after it.
   *
   * The `seq` allocation is the same read-then-write `appendEvents` uses and
   * carries the same caveat: `@@unique([dispatchRunId, seq])` is what makes a
   * collision a failed insert rather than a silently reordered stream, and a
   * failed insert here is swallowed like any other.
   */
  async recordFinding(
    input:
      | {
          /**
           * The work item whose OPEN LEG this finding belongs to — the one the
           * agent was working, NOT the bug or plan itself. A bug is a brand-new
           * row that no run ever claimed; what ties it to a run is the work item
           * it points at.
           */
          anchorWorkItemId: string;
          kind: Extract<DispatchEventKind, 'bug_filed' | 'plan_submitted'>;
          /**
           * The identity of the thing found — the bug's id, or the plan's. Used
           * to make the append IDEMPOTENT: the same finding can be reached twice
           * (a `relates_to` link created after the bug, a plan whose revision is
           * re-submitted), and one finding must not become two rows.
           */
          findingId: string;
          data: Prisma.InputJsonValue;
          /**
           * WHEN the finding's act happened, when that is not now (MOTIR-6279).
           * A submitted plan is recorded when it reaches `planned`, which on a
           * real refusal is after the leg settled and often after the run
           * closed; the leg it belongs to is the one that was open when the plan
           * was CREATED. Omitted, the leg is the one open right now.
           */
          at?: Date;
        }
      | {
          /** The report's TARGET — the work item whose open leg stopped. */
          anchorWorkItemId: string;
          /**
           * The run-found report's conclusion (MOTIR-6282). Its identity is the
           * LEG itself — one report per leg, whatever it concluded — so there is
           * no `findingId` to pass: the leg this resolves is the key, and its id
           * is written into `data.dispatchRunCardId` for the dedupe to match.
           */
          kind: Extract<DispatchEventKind, 'unbuildable_reported'>;
          data: Prisma.InputJsonObject;
          /**
           * The leg the report already resolved, when it came through a RUN's own
           * door (MOTIR-8698, `reportUnbuildableTargetForRun`) — that door names the
           * run, so the finding lands on THAT run's leg rather than whichever open
           * leg the card has newest. Omitted, the card's open leg, as before.
           */
          legId?: string;
        },
    ctx: ServiceContext,
  ): Promise<{ recorded: boolean }> {
    try {
      return await withWorkspaceContext(
        { userId: ctx.userId, workspaceId: ctx.workspaceId },
        async (tx) => {
          // The run-found report is made by the runner while its leg is still
          // open (MOTIR-6282), so only a bug or plan finding carries `at`.
          const at = input.kind === 'unbuildable_reported' ? undefined : input.at;
          const leg = at
            ? await dispatchRunCardRepository.findLegSpanningInstantForWorkItem(
                input.anchorWorkItemId,
                at,
                tx,
              )
            : input.kind === 'unbuildable_reported' && input.legId !== undefined
              ? await dispatchRunCardRepository.findById(input.legId, tx)
              : await dispatchRunCardRepository.findOpenLegForWorkItem(input.anchorWorkItemId, tx);
          if (!leg) return { recorded: false };

          const findingId = input.kind === 'unbuildable_reported' ? leg.id : input.findingId;
          const data =
            input.kind === 'unbuildable_reported'
              ? { ...input.data, dispatchRunCardId: leg.id }
              : input.data;

          const already = await dispatchRunEventRepository.findFindingOnRun(
            leg.dispatchRunId,
            input.kind,
            findingId,
            tx,
          );
          if (already) return { recorded: false };

          const existing = await dispatchRunEventRepository.countByRun(leg.dispatchRunId, tx);
          if (existing >= DISPATCH_RUN_EVENT_LIMIT) return { recorded: false };

          const seq = ((await dispatchRunEventRepository.maxSeq(leg.dispatchRunId, tx)) ?? 0) + 1;
          await dispatchRunEventRepository.createMany(
            [
              {
                workspaceId: ctx.workspaceId,
                dispatchRunId: leg.dispatchRunId,
                dispatchRunCardId: leg.id,
                seq,
                kind: input.kind,
                reportedBy: 'cli',
                data,
              },
            ],
            tx,
          );
          return { recorded: true };
        },
      );
    } catch {
      // Swallowed on purpose — see the best-effort note above. There is no
      // caller that could act on this, and every caller has already committed
      // the write this describes.
      return { recorded: false };
    }
  },

  /**
   * HEARTBEAT — the run says it is still alive (Story MOTIR-6526 · MOTIR-6528,
   * `run-death-keeps-work.md` §2). Sets `lastHeartbeatAt` to now; the rule that
   * reads it is `isRunAlive` (`lib/runs/runLiveness.ts`).
   *
   * ⚠️ UNDER THE SAME ROW LOCK AS `close`, and refused the same way. The lapse
   * reap closes a silent run through `close`, and a heartbeat that arrives after
   * it must NOT land on the closed row — the CLI has to LEARN its run was closed
   * (`DispatchRunTerminalError`, 409), not keep beating into a record that says
   * the opposite.
   *
   * ⚠️ ONLY THE RUN'S OWN OPERATOR MAY BEAT FOR IT. A run someone else opened
   * answers `DispatchRunNotFoundError` — the same 404 an unknown id and another
   * tenant's run give — so a heartbeat cannot keep a dead run looking alive from
   * a machine that is not running it, and the id confirms nothing.
   *
   * Writes no card status and no event: a heartbeat every 60 s would be most of
   * a run's event budget, and the stream is for what the run DID.
   */
  async heartbeat(runId: string, ctx: ServiceContext): Promise<void> {
    // A hosted run's own credential beats only its own run (MOTIR-6558) — its
    // liveness is really its server supervision (`run-death-keeps-work.md` §2),
    // but the CLI's reporter beats whatever run it holds regardless of origin.
    assertRunTokenScope(runId, ctx);
    await withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
      const locked = await dispatchRunRepository.findTerminalStateForUpdate(runId, tx);
      if (!locked || locked.createdById !== ctx.userId) {
        throw new DispatchRunNotFoundError(runId);
      }
      if (locked.status !== 'running') {
        throw new DispatchRunTerminalError(runId, locked.status);
      }
      await dispatchRunRepository.touchHeartbeat(runId, new Date(), tx);
    });
  },

  /**
   * THE LEG A RUN'S OWN REPORT IS ABOUT (MOTIR-8698) — the open leg `workItemId` has
   * on run `runId`, for the run-found report's run door
   * (`POST /api/v1/dispatch-runs/{id}/unbuildable`).
   *
   * Refused exactly as {@link heartbeat} is, from the same locked read: a hosted
   * run's credential naming another run is `DispatchRunTokenOutOfScopeError`; an
   * unknown run, another tenant's, or one this caller did not open is
   * `DispatchRunNotFoundError`; a closed run is `DispatchRunTerminalError`. A card
   * the run does not hold, or whose leg has already ended, answers `null` — the
   * report's "not on a run" arm, which records and files nothing.
   */
  async findOpenLegOnRun(
    runId: string,
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<DispatchRunCard | null> {
    assertRunTokenScope(runId, ctx);
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const locked = await dispatchRunRepository.findTerminalStateForUpdate(runId, tx);
        if (!locked || locked.createdById !== ctx.userId) {
          throw new DispatchRunNotFoundError(runId);
        }
        if (locked.status !== 'running') {
          throw new DispatchRunTerminalError(runId, locked.status);
        }
        const leg = await dispatchRunCardRepository.findByRunAndWorkItem(runId, workItemId, tx);
        return leg && leg.endedAt === null ? leg : null;
      },
    );
  },

  /**
   * OPEN AN AGENT-REPORTED RUN (Story MOTIR-7446 · MOTIR-7450,
   * `agent-reported-runs.md` §2) — the run an agent opens about ITSELF over a card it
   * already holds, through `start_work_item_run`.
   *
   * ⚠️ OVER A CLAIM, NEVER INSTEAD OF ONE. The caller must hold the card — In
   * Progress and assigned to them, what `claim_work_item` leaves behind — and for a
   * container every child that is not done as well, or nothing is written
   * ({@link AgentRunNotClaimedError}). A leaf opens `run` with one leg; a container
   * opens ONE `run_scope` whose legs are its children in their order.
   *
   * ⚠️ IDEMPOTENT ON THE CARD AND THE CALLER, under the card's row lock: a caller who
   * already has an open run on this card — a retried call, a resumed session, or a
   * CLI run the agent is inside — gets `mine` and THAT run, never a second one. A
   * run key would not do it: a card run, closed and started again, needs a new run.
   *
   * `origin` is `local`: a Motir agent instance's credential is its run token, which
   * opens nothing ({@link assertRunTokenScope}), so an agent in an instance reports
   * into the CLI run it is already inside. `reportedBy` is `agent`, written by this
   * door and by no other. The run is born heartbeating, so the 60-minute lapse rule
   * holds it from its first second rather than the 12-hour legacy one.
   */
  async openAgentRun(input: OpenAgentRunInput, ctx: ServiceContext): Promise<AgentRunOpenedDto> {
    assertRunTokenScope(null, ctx);
    const key = input.key.trim().toUpperCase();
    const project = await projectsService.getByKey(projectKeyOf(key), ctx);
    await projectAccessService.assertCanEdit(project.id, ctx);

    const bound = { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id };
    return withWorkspaceContext(bound, async (tx): Promise<AgentRunOpenedDto> => {
      const item = await workItemRepository.findByIdentifier(project.id, key, tx);
      if (!item) throw new WorkItemNotFoundError(key);
      // The card's lock serialises two starts on one card, so the read below and
      // the open after it are one decision.
      await workItemRepository.lockById(item.id, tx);

      const state = await workItemRepository.findClaimStateById(item.id, tx);
      if (!holdsClaim(state, ctx.userId)) throw new AgentRunNotClaimedError(key, key);

      // A container's legs are its children; their titles name the legs in the answer.
      const children = await workItemRepository.findChildren(item.id, tx);
      const titles = new Map<string, string>([
        [item.id, item.title],
        ...children.map((c): [string, string] => [c.id, c.title]),
      ]);
      const legsOf = (run: DispatchRunDto): AgentRunLegDto[] =>
        run.cards.map((c) => ({
          key: c.key,
          title: (c.workItemId !== null ? titles.get(c.workItemId) : undefined) ?? null,
        }));

      const existing = await dispatchRunRepository.findOpenForCreatorOnWorkItem(
        ctx.userId,
        item.id,
        tx,
      );
      if (existing) {
        const seq = (await dispatchRunEventRepository.maxSeq(existing.id, tx)) ?? 0;
        const run = toDispatchRunDto(existing, seq);
        return { outcome: 'mine', run, legs: legsOf(run) };
      }

      // A container's legs are its children in their own order, less the ones
      // already done; every other child must be the caller's too.
      const childStates = new Map(
        (
          await workItemRepository.findClaimStatesByIds(
            children.map((c) => c.id),
            tx,
          )
        ).map((c) => [c.id, c]),
      );
      const legKeys: string[] = [];
      for (const child of children) {
        const childState = childStates.get(child.id) ?? null;
        if (childState?.statusCategory === 'done') continue;
        if (!holdsClaim(childState, ctx.userId)) {
          throw new AgentRunNotClaimedError(key, child.identifier);
        }
        legKeys.push(child.identifier);
      }
      const isContainer = children.length > 0;
      if (isContainer && legKeys.length === 0) throw new AgentRunNotClaimedError(key, key);

      const harness = input.harness.trim();
      const model = input.model?.trim() || undefined;
      const command: DispatchCommand = isContainer ? 'run_scope' : 'run';
      const opened = await dispatchRunService.openWithin(
        project.id,
        {
          command,
          origin: 'local',
          reportedBy: 'agent',
          agent: harness,
          ...(model !== undefined ? { model } : {}),
          ...(isContainer ? { scopeKey: key, scopeLabel: item.title } : {}),
          cards: (isContainer ? legKeys : [key]).map((k) => ({
            key: k,
            disposition: 'queued' as const,
          })),
        },
        ctx,
        tx,
      );
      const runId = opened.run.id;
      await dispatchRunRepository.touchHeartbeat(runId, new Date(), tx);
      // The ONE `run_opened`, written by the server: the agent may not send it (§3).
      await dispatchRunEventRepository.createMany(
        [
          {
            workspaceId: ctx.workspaceId,
            dispatchRunId: runId,
            seq: 1,
            kind: 'run_opened',
            reportedBy: 'agent',
            data: {
              command,
              key,
              origin: 'local',
              reportedBy: 'agent',
              harness,
              model: model ?? null,
            },
          },
        ],
        tx,
      );
      const withCards = await dispatchRunRepository.findByIdWithCards(runId, tx);
      /* v8 ignore next -- the row was just written inside this transaction */
      if (!withCards) throw new DispatchRunNotFoundError(runId);
      const run = toDispatchRunDto(withCards, 1);
      return { outcome: 'opened', run, legs: legsOf(run) };
    });
  },

  /**
   * REPORT A STEP, A MILESTONE, OR ONLY A HEARTBEAT (MOTIR-7450,
   * `agent-reported-runs.md` §3) — `report_action`, which an agent calls before every
   * step it takes.
   *
   * With NO arguments it is a heartbeat over every open run the caller opened
   * ({@link heartbeatCallerRuns}). Otherwise the run is the caller's open run on
   * `key`, of EITHER reporter — so the same call works in a run the agent opened and
   * in a CLI or hosted run it is inside — and there is none,
   * {@link AgentRunNoOpenRunError} tells it to start one.
   *
   * - `events` are milestones, of the four kinds an agent may send, and only on a run
   *   the agent reports; a CLI run's runner writes them itself.
   * - `action` is one line, at most {@link AGENT_ACTION_MAX_CHARS} characters, stored
   *   as an `agent_action` event's body after the milestones.
   *
   * Every event goes through the ONE append path ({@link appendEventsWithin}) with
   * `reportedBy: 'agent'`, and the run is heartbeaten in the same transaction.
   */
  async reportAction(
    input: ReportAgentActionInput,
    ctx: ServiceContext,
  ): Promise<AgentActionReportedDto> {
    const events = input.events ?? [];
    if (input.key === undefined && input.action === undefined && events.length === 0) {
      const touched = await dispatchRunService.heartbeatCallerRuns(ctx, { reportedBy: null });
      return { kind: 'heartbeat', touched };
    }
    if (input.key === undefined) throw new AgentRunReportInvalidError('key_required');
    let action: string | undefined;
    if (input.action !== undefined) {
      action = input.action.trim();
      if (action.length === 0) throw new AgentRunReportInvalidError('action_empty');
      if (action.length > AGENT_ACTION_MAX_CHARS) {
        throw new AgentRunReportInvalidError('action_too_long', action.length);
      }
    }
    for (const event of events) {
      if (!AGENT_REPORTABLE_EVENT_KINDS.includes(event.kind)) {
        throw new AgentRunEventKindNotAllowedError(event.kind, 'kind');
      }
    }

    const key = input.key.trim().toUpperCase();
    const project = await projectsService.getByKey(projectKeyOf(key), ctx);
    await projectAccessService.assertCanEdit(project.id, ctx);

    const bound = { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id };
    const { reported, agentInstanceId } = await withWorkspaceContext(bound, async (tx) => {
      const item = await workItemRepository.findByIdentifier(project.id, key, tx);
      if (!item) throw new WorkItemNotFoundError(key);
      const run = await dispatchRunRepository.findOpenForCreatorOnWorkItem(ctx.userId, item.id, tx);
      if (!run) throw new AgentRunNoOpenRunError(key);
      if (events.length > 0 && run.reportedBy !== 'agent') {
        throw new AgentRunEventKindNotAllowedError(events[0]!.kind, 'cli_run');
      }

      // On the card's leg; a parent's own key, which holds no leg in its run, is
      // reported run-scoped.
      const hasLeg = run.cards.some((c) => c.workItemId === item.id);
      const legKey = hasLeg ? { workItemKey: key } : {};
      const batch: AppendDispatchRunEventInput[] = [
        ...events.map((event) => ({
          kind: event.kind,
          ...legKey,
          ...(event.data !== undefined ? { data: event.data } : {}),
          ...(event.disposition !== undefined ? { disposition: event.disposition } : {}),
          ...(event.skipReason !== undefined ? { skipReason: event.skipReason } : {}),
          ...(event.sessionBranch !== undefined ? { sessionBranch: event.sessionBranch } : {}),
        })),
        ...(action !== undefined
          ? [{ kind: 'agent_action' as const, ...legKey, body: action }]
          : []),
      ];
      const { appended } = await appendEventsWithin(run.id, batch, 'agent', ctx, tx);
      // Under the row lock the append just took: every call is a heartbeat (§3).
      await dispatchRunRepository.touchHeartbeat(run.id, new Date(), tx);
      return {
        agentInstanceId: run.agentInstanceId,
        reported: {
          kind: 'reported' as const,
          runId: run.id,
          runReportedBy: run.reportedBy,
          appended: appended.appended,
          seq: appended.seq,
        },
      };
    });
    if (agentInstanceId !== null) await bumpAgentActivity(agentInstanceId);
    return reported;
  },

  /**
   * HEARTBEAT EVERY OPEN RUN THE CALLER OPENED (MOTIR-7450, `agent-reported-runs.md`
   * §5). The MCP layer calls it on EVERY Motir tool call, so an agent in any
   * harness keeps its run alive by doing what it does anyway: calling Motir.
   *
   * By default only the caller's AGENT-reported runs — a CLI run beats from its own
   * timer, and the rule is written for the runs that have none. `report_action`
   * with no arguments passes `null` and touches both. A run beaten under a minute
   * ago is skipped, so a burst of calls costs one write. Returns how many runs it
   * touched. Never refuses: a caller with no open run touches nothing.
   */
  async heartbeatCallerRuns(
    ctx: ServiceContext,
    options: { reportedBy?: DispatchRunReporter | null; now?: Date } = {},
  ): Promise<number> {
    if (ctx.tokenDispatchRunId !== undefined) return 0;
    const now = options.now ?? new Date();
    const reportedBy = options.reportedBy === undefined ? 'agent' : options.reportedBy;
    const staleBefore = new Date(now.getTime() - AGENT_RUN_HEARTBEAT_THROTTLE_MS);
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        // Read first: the ordinary call has nothing stale, and issues no write.
        const ids = await dispatchRunRepository.findStaleHeartbeatIdsForCreator(
          ctx.userId,
          reportedBy,
          staleBefore,
          tx,
        );
        if (ids.length === 0) return 0;
        return dispatchRunRepository.touchHeartbeatsByIds(ids, staleBefore, now, tx);
      },
    );
  },

  /**
   * CLOSE AN AGENT-REPORTED RUN (MOTIR-7450, `agent-reported-runs.md` §4) —
   * `close_work_item_run`, which the agent calls on every exit.
   *
   * Only the run's opener may close it ({@link AgentRunNotYoursError}); a run that is
   * not an agent-reported run on `key` answers {@link DispatchRunNotFoundError}, as
   * an unknown id does. ⚠️ IDEMPOTENT ON A CLOSED RUN: a second close, or a close the
   * reap beat, answers with the run as it stands and writes nothing.
   *
   * ⚠️ PROVENANCE AT A DELIVERED CLOSE, IN THE SAME TRANSACTION. At `completed` or
   * `drained`, every leg card at Implemented or later (cancelled excepted) is stamped
   * `byok` with the run's harness and model through
   * `workItemsService.recordImplementationProvenance` — the CLI's own writer, so a
   * card's provenance has one writer whatever lane built it. A model the run does not
   * know is left as it is on the card. Any other outcome stamps nothing, and no
   * outcome writes a card STATUS (Q3).
   */
  async closeAgentRun(input: CloseAgentRunInput, ctx: ServiceContext): Promise<AgentRunClosedDto> {
    if ((input.stopReason as DispatchStopReason) === 'abandoned') {
      throw new AgentRunReportInvalidError('abandoned');
    }
    assertRunTokenScope(input.runId, ctx);
    const key = input.key.trim().toUpperCase();
    const project = await projectsService.getByKey(projectKeyOf(key), ctx);
    await projectAccessService.assertCanEdit(project.id, ctx);
    const delivered = input.stopReason === 'completed' || input.stopReason === 'drained';
    // Dynamic: both services compose this one, so a static import is a cycle.
    const [{ workItemsService }, { workflowsService }] = await Promise.all([
      import('@/lib/services/workItemsService'),
      import('@/lib/services/workflowsService'),
    ]);
    const statuses = delivered
      ? await workflowsService.listStatusesByProject(project.id, ctx.workspaceId)
      : [];

    const bound = { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id };
    return withWorkspaceContext(bound, async (tx): Promise<AgentRunClosedDto> => {
      const item = await workItemRepository.findByIdentifier(project.id, key, tx);
      if (!item) throw new WorkItemNotFoundError(key);
      const run = await dispatchRunRepository.findByIdWithCards(input.runId, tx);
      const onKey =
        run !== null &&
        (run.scopeWorkItemId === item.id || run.cards.some((c) => c.workItemId === item.id));
      if (!run || !onKey || run.reportedBy !== 'agent') {
        throw new DispatchRunNotFoundError(input.runId);
      }
      if (run.createdById !== ctx.userId) throw new AgentRunNotYoursError(run.id, key);

      const asItStands = async (): Promise<AgentRunClosedDto> => {
        const current = await dispatchRunRepository.findByIdWithCards(run.id, tx);
        /* v8 ignore next -- read a statement ago in this transaction */
        if (!current) throw new DispatchRunNotFoundError(run.id);
        const seq = (await dispatchRunEventRepository.maxSeq(run.id, tx)) ?? 0;
        return { run: toDispatchRunDto(current, seq), stamped: [], alreadyClosed: true };
      };
      if (run.status !== 'running') return asItStands();

      let closed: DispatchRunDto;
      try {
        closed = await dispatchRunService.closeWithin(
          run.id,
          { stopReason: input.stopReason },
          ctx,
          tx,
        );
      } catch (err) {
        // The reap closed it between the read above and the lock: the same answer
        // as a second close. Thrown before any write, so the transaction is intact.
        if (err instanceof DispatchRunTerminalError) return asItStands();
        throw err;
      }
      // The ONE `run_closed`, written by the server as `run_opened` is (§3) — the
      // event the CLI sends before its close, here on the agent's behalf.
      const closedSeq = ((await dispatchRunEventRepository.maxSeq(run.id, tx)) ?? 0) + 1;
      await dispatchRunEventRepository.createMany(
        [
          {
            workspaceId: ctx.workspaceId,
            dispatchRunId: run.id,
            seq: closedSeq,
            kind: 'run_closed',
            reportedBy: 'agent',
            data: { stopReason: input.stopReason },
          },
        ],
        tx,
      );
      closed = { ...closed, seq: closedSeq };

      const stampedIds = new Set<string>();
      if (delivered) {
        const keys = ladderKeysFrom(statuses);
        const legIds = run.cards.map((c) => c.workItemId).filter((id): id is string => id !== null);
        const legStates = await workItemRepository.findClaimStatesByIds(legIds, tx);
        for (const leg of legStates) {
          if (leg.status === CANCELLED_STATUS_KEY) continue;
          if (rankOfStatus(leg.status, statuses, keys) < RUNG_RANK.implemented) continue;
          await workItemsService.recordImplementationProvenance(
            leg.id,
            {
              source: 'byok',
              ...(run.agent !== null ? { harness: run.agent } : {}),
              ...(run.model !== null ? { model: run.model } : {}),
            },
            tx,
          );
          stampedIds.add(leg.id);
        }
      }
      const stamped = closed.cards
        .filter((c) => c.workItemId !== null && stampedIds.has(c.workItemId))
        .flatMap((c) => (c.key !== null ? [c.key] : []));
      return { run: closed, stamped, alreadyClosed: false };
    });
  },

  /**
   * CLOSE the run: its terminal status, its stop reason, and every leg that is
   * still unsettled.
   *
   * ⚠️ READ-DERIVED, SO IT LOCKS. Two things race to close one run — the CLI's
   * own `run_closed` report, and the abandoned-run reap that decided nothing was
   * holding it. Without the lock both read `running`, both write, and the
   * LOSER's write lands: a run that finished cleanly ends up recorded as
   * `timed_out`, which is the one outcome a reader would take as evidence that
   * something went wrong. With it, the second closer re-reads a row that is
   * already terminal and gets a typed error instead of overwriting an answer.
   *
   * A serial test passes without the lock and proves nothing, which is why
   * `tests/dispatchRunService.test.ts` drives two SIMULTANEOUS closes against a
   * warm pool and asserts exactly one wins.
   */
  async close(
    runId: string,
    input: CloseDispatchRunInput,
    ctx: ServiceContext,
    cardLocks: RunCardLockMode = 'wait',
    closing?: { data: Prisma.InputJsonObject; body: string },
  ): Promise<DispatchRunDto> {
    assertRunTokenScope(runId, ctx);
    const closed = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) =>
        dispatchRunService.closeWithin(
          runId,
          input,
          ctx,
          tx,
          closing?.data,
          cardLocks,
          closing?.body,
        ),
    );
    // A run in an agent loses its credentials at EVERY close, the CLI's own
    // included (`agent-instance-run.md` §6, MOTIR-7027) — after the close commits,
    // never able to undo it. A revoke that fails is retried by the run's
    // supervise job, which finds the run closed and revokes again.
    if (closed.origin === 'instance') await revokeAgentRunCredentials(runId);
    return closed;
  },

  /**
   * The CLOSE's write half, inside a transaction the CALLER holds — extracted
   * (MOTIR-6532) so the continue claim can close a LAPSED run under the card's own
   * row lock, in the same transaction that then opens the `continue` run. Same
   * lock, same already-terminal refusal, same settle as `close`; a second copy
   * would be a second definition of what closing a run writes.
   *
   * `closingLog`, when given, is appended as a run-scoped `log` event just before
   * the close, under the same row lock — the reason a server-side close records.
   * `closingBody` is that event's human-readable line. ⚠️ A server-side end
   * writes its closing line HERE, never as an `appendEvents` before `close`:
   * those are two transactions, and a CLI close committing between them leaves
   * an "ended (cancelled)" line on a run that ended `succeeded` (MOTIR-7489).
   * Under the row lock, a run found already terminal rolls the line back with
   * the refusal.
   * `tx` must be bound to the run's workspace.
   *
   * Every card the run covers has its To fix reason RECOMPUTED once the legs are
   * settled (MOTIR-6881): a run that ended without finishing is what `run_died`
   * reads. Those cards are locked BEFORE the run — `lockCoveredCards` says why.
   */
  async closeWithin(
    runId: string,
    input: CloseDispatchRunInput,
    ctx: ServiceContext,
    tx: Prisma.TransactionClient,
    closingLog?: Prisma.InputJsonObject,
    cardLocks: RunCardLockMode = 'wait',
    closingBody?: string,
  ): Promise<DispatchRunDto> {
    // The covered set is fixed when the run opens (its legs and its scope are
    // written once, by `openWithin`), so reading it before the run lock is safe.
    const before = await dispatchRunRepository.findByIdWithCards(runId, tx);
    if (!before) throw new DispatchRunNotFoundError(runId);
    const covered = coveredCardIds(before);
    // ⚠️ CARDS FIRST, THEN THE RUN — the order `claimContinue` takes them in.
    await lockCoveredCards(covered, runId, cardLocks, tx);
    const locked = await dispatchRunRepository.findTerminalStateForUpdate(runId, tx);
    /* v8 ignore next -- the run was read a statement ago in this transaction */
    if (!locked) throw new DispatchRunNotFoundError(runId);
    if (locked.status !== 'running') {
      throw new DispatchRunTerminalError(runId, locked.status);
    }

    if (closingLog !== undefined) {
      const seq = ((await dispatchRunEventRepository.maxSeq(runId, tx)) ?? 0) + 1;
      await dispatchRunEventRepository.createMany(
        [
          {
            workspaceId: ctx.workspaceId,
            dispatchRunId: runId,
            seq,
            kind: 'log',
            reportedBy: 'cli',
            data: closingLog,
            ...(closingBody !== undefined ? { body: closingBody } : {}),
          },
        ],
        tx,
      );
    }

    const endedAt = input.endedAt ?? new Date();
    // The legs as the run REPORTED them, read under the run's lock and before the
    // settle below — the status is derived from them (MOTIR-10984).
    const legs = await dispatchRunCardRepository.listByRun(runId, tx);
    await dispatchRunRepository.update(
      runId,
      {
        status: closingStatus(input.status ?? statusForStopReason(input.stopReason), legs),
        stopReason: input.stopReason,
        endedAt,
      },
      tx,
    );

    // Settle whatever the run left in flight. One update per leg rather than
    // an `updateMany`, because the target disposition DEPENDS on where each
    // leg was — a `queued` card was never reached, a `running` one was.
    for (const leg of legs) {
      if (!NON_TERMINAL.includes(leg.disposition)) continue;
      await dispatchRunCardRepository.update(
        leg.id,
        { disposition: settledDisposition(leg.disposition), endedAt },
        tx,
      );
    }

    if (input.stopReason === 'gated') await recordHeldGates(before, covered, tx);

    await recomputeCovered(covered, tx);

    const withCards = await dispatchRunRepository.findByIdWithCards(runId, tx);
    /* v8 ignore next -- the row was just written inside this transaction */
    if (!withCards) throw new DispatchRunNotFoundError(runId);
    const seq = (await dispatchRunEventRepository.maxSeq(runId, tx)) ?? 0;
    return toDispatchRunDto(withCards, seq);
  },

  /**
   * The run WITH its set — the read the ingest operations answer with, the one
   * MOTIR-1793's browser routes compose, and the one a CLI ADOPTING a
   * server-opened hosted run reads its set from (`GET /api/v1/dispatch-runs/{id}`,
   * MOTIR-6558).
   */
  async getRun(
    runId: string,
    reader: ServiceContext | VisitorReadContext,
  ): Promise<DispatchRunDto> {
    const { svc: ctx, hidden, projectId } = runReader(reader);
    // A hosted run's own credential reads its own run and no other — checked
    // before the read, like every run-token route (MOTIR-6558).
    assertRunTokenScope(runId, ctx);
    const dto = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const run = await dispatchRunRepository.findByIdWithCards(runId, tx);
        if (!run || (projectId && run.projectId !== projectId) || runTouches(run, hidden)) {
          throw new DispatchRunNotFoundError(runId);
        }
        await assertMayReadRun(run, ctx, tx);
        const seq = (await dispatchRunEventRepository.maxSeq(runId, tx)) ?? 0;
        const opened =
          run.command === 'continue' || run.command === 'fix'
            ? await dispatchRunEventRepository.findLatestOfKind(runId, 'run_opened', tx)
            : null;
        return {
          ...toDispatchRunDto(run, seq),
          continues: run.command === 'continue' ? toDispatchRunContinuesDto(opened?.data) : null,
          // A hosted repair's decision (MOTIR-6929) — what its container adopts.
          repair: run.command === 'fix' ? toDispatchRunRepairDto(opened?.data) : null,
        };
      },
    );
    if (!dto.continues || dto.continues.branches.length === 0) return dto;
    return { ...dto, continues: await withCloneUrls(dto.continues, dto.projectId, ctx) };
  },

  /**
   * The run's CLOSE-OUT prompt (Story MOTIR-4906 · MOTIR-5357) — resolved from
   * the run's OWN record: its scope is the run target, and its legs that landed
   * (`integrated` / `implemented`) are what the prompt names. The caller passes
   * only the run id, never a card list, so a stale or partial list cannot aim a
   * How-to-test record at the wrong work.
   *
   * Refuses a run with no scope ({@link DispatchRunNoTargetError}): an unscoped
   * batch's cards were each their own target and published in their own prompts.
   * Requires `project:browse` on the run's project, like every run read; the
   * route adds `work_item:edit` at its gate because the agent it is for writes.
   */
  async getCloseOutPrompt(
    runId: string,
    ctx: ServiceContext,
  ): Promise<DispatchRunCloseOutPromptDto> {
    // A hosted run's own credential reads only ITS run's close-out (MOTIR-6557).
    assertRunTokenScope(runId, ctx);
    const binding = { userId: ctx.userId, workspaceId: ctx.workspaceId };
    const run = await withWorkspaceContext(binding, (tx) =>
      dispatchRunRepository.findByIdWithCards(runId, tx),
    );
    if (!run) throw new DispatchRunNotFoundError(runId);
    // The Runs room's record-level admit (MOTIR-6331): browse, and the room's
    // view key or the reader's own run — else the unknown-id not-found.
    await withWorkspaceContext(binding, (tx) => assertMayReadRun(run, ctx, tx));
    if (!run.scopeWorkItemId) throw new DispatchRunNoTargetError(runId);

    const landed = run.cards.filter(
      (card) =>
        card.workItemId !== null &&
        (card.disposition === 'integrated' || card.disposition === 'implemented'),
    );
    const [target, items] = await withWorkspaceContext(binding, (tx) =>
      Promise.all([
        workItemRepository.findById(run.scopeWorkItemId as string, tx),
        workItemRepository.findByIds(
          landed.map((card) => card.workItemId as string),
          tx,
        ),
      ]),
    );
    // A scope deleted after the run opened is SET NULL on the run — so a target
    // that reads back missing is the archived/invisible case, not a race.
    if (!target) throw new DispatchRunNoTargetError(runId);
    const byId = new Map(items.map((item) => [item.id, item]));

    const cards = landed.flatMap((card) => {
      const item = byId.get(card.workItemId as string);
      return item
        ? [
            {
              key: item.identifier,
              title: item.title,
              type: item.type,
              sessionBranch: card.sessionBranch,
            },
          ]
        : [];
    });

    return {
      runId: run.id,
      targetKey: target.identifier,
      prompt: assembleRunCloseOutPrompt({
        runId: run.id,
        target: {
          key: target.identifier,
          kind: target.kind,
          title: target.title,
          descriptionMd: target.descriptionMd,
        },
        cards,
      }),
      landedKeys: cards.map((card) => card.key),
    };
  },

  /**
   * THE RUN AS THE BROWSER READS IT — the header, its set, and what each leg
   * SHIPPED (MOTIR-1793).
   *
   * ⚠️ THE DELIVERIES ARE JOINED HERE, and that is the whole reason this method
   * exists beside {@link getRun}. The run record holds no pull-request and no CI
   * column (ADR Q3), so the page's *did this ship / is it green* comes from
   * `work_item_delivery` and `derivePrCiState` — the product's ONE CI derivation.
   * Recomputing it here would be a second verdict that drifts from the pill a
   * person reads on the same card.
   *
   * ONE batched read for the whole set, not one per leg: a sprint run's card set
   * is not small, and a per-leg read would be an N+1 on the run view's only query.
   */
  async getRunDetail(
    runId: string,
    reader: ServiceContext | VisitorReadContext,
  ): Promise<DispatchRunDetailDto> {
    const { svc: ctx, hidden, projectId } = runReader(reader);
    const detail = await withWorkspaceContext<DispatchRunDetailDto>(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const run = await dispatchRunRepository.findByIdWithCards(runId, tx);
        if (!run || (projectId && run.projectId !== projectId) || runTouches(run, hidden)) {
          throw new DispatchRunNotFoundError(runId);
        }
        await assertMayReadRun(run, ctx, tx);
        const seq = (await dispatchRunEventRepository.maxSeq(runId, tx)) ?? 0;

        const workItemIds = run.cards
          .map((card) => card.workItemId)
          .filter((id): id is string => id !== null);
        const deliveries = await workItemDeliveryRepository.listByWorkItemsWithChecks(
          workItemIds,
          tx,
        );
        // Each member's standing queue failure (MOTIR-5720), one read for the run.
        const byId = new Map(deliveries.map((row) => [row.githubPullRequestId, row.pullRequest]));
        const held = await standingQueueFailures(byId, tx);
        // …and its standing host merge refusal (MOTIR-6735), the same one read.
        const refused = await standingMergeRefusals(byId, tx);
        const byWorkItem = new Map<string, ReturnType<typeof toWorkItemDeliveryDto>[]>();
        for (const row of deliveries) {
          const list = byWorkItem.get(row.workItemId) ?? [];
          list.push(
            toWorkItemDeliveryDto(
              row,
              held.get(row.githubPullRequestId) ?? null,
              refused.get(row.githubPullRequestId) ?? null,
            ),
          );
          byWorkItem.set(row.workItemId, list);
        }

        const base = toDispatchRunDto(run, seq);
        // Each manual leg's gate (MOTIR-7477) — who the skip waits on, for this reader.
        const gates = await manualLegGates([run], runSurfaceReader(ctx), tx);
        // A HOSTED run's reason line (MOTIR-691) — read in the same transaction,
        // off the two events that carry it. A run in an agent has the same two
        // (MOTIR-7028): its end path (`agent-instance-run.md` §6) writes the same
        // `data.end` closing line, and the item page and the run modal quote it
        // verbatim. A local run has neither to read.
        const hostedEnd =
          base.origin === 'hosted' || base.origin === 'instance'
            ? await readHostedEnd(
                runId,
                base.cards.map((c) => c.exitCode),
                tx,
              )
            : undefined;
        return {
          ...base,
          ...(hostedEnd ? { hostedEnd } : {}),
          cards: base.cards.map((card) => ({
            ...card,
            manualGate: legGateOf(card, gates),
            // A leg whose card was deleted has no deliveries to join and never
            // will — an empty array, never a missing key.
            deliveries: card.workItemId ? (byWorkItem.get(card.workItemId) ?? []) : [],
          })),
        };
      },
    );
    // A HOSTED run's cost is read from motir-ai AFTER the transaction, never
    // inside it: an outbound call must not hold a connection and the RLS
    // binding open (MOTIR-689). A local run makes no call and carries no key, and
    // neither does an `instance` run: it has no token cost to read — it is charged
    // as its agent's machine time (`agent-instance-run.md` §5).
    if (detail.origin !== 'hosted') return detail;
    return { ...detail, cost: await readHostedRunCost(detail.id) };
  },

  /**
   * A run's MACHINE TIME (MOTIR-691), for the hosted cost block: billable seconds
   * and whether every container row has settled. Gated exactly as the run is — a
   * run the reader may not see is not found — then read from the fleet meter by
   * the run's id (MOTIR-6448). A LOCAL run meters nothing and answers zero.
   *
   * ⚠️ NEVER THE METER'S COST FIGURE — that is Motir's own fleet cost, not a
   * price; what the run was charged is the credits on its cost.
   */
  async getMachineTime(runId: string, ctx: ServiceContext): Promise<DispatchRunMachineTimeDto> {
    await withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
      const run = await dispatchRunRepository.findByIdWithCards(runId, tx);
      if (!run) throw new DispatchRunNotFoundError(runId);
      await assertMayReadRun(run, ctx, tx);
    });
    const time = await ciFleetCostMeterService.getMachineTimeForDispatchRun(runId);
    return { billableSeconds: time.billableSeconds, settled: time.settled };
  },

  /**
   * ONE CARD'S RUN HISTORY, newest first, cursor-paginated.
   *
   * ⚠️ "EVERY RUN THAT CARRIED A LEG FOR THIS CARD", not "every run that NAMED
   * it" — which is the correct question now that a run covers a set. The sprint
   * run that swept a card up is exactly the run its owner wants to find, and it
   * never named the card at all.
   *
   * Newest-first is load-bearing rather than a default: the card page's run
   * section reads the CURRENT run off the first row of the first page, which is
   * why there is no second single-run endpoint to keep in step with this one.
   */
  async listRunsForWorkItemKey(
    key: string,
    page: {
      take: number;
      cursor?: string | undefined;
      view?: DispatchRunView | undefined;
      /** Narrows the query, never the page (MOTIR-10286). Omitted: every status. */
      statuses?: DispatchRunStatus[] | undefined;
    },
    ctx: ServiceContext,
  ): Promise<DispatchRunDto[]> {
    const identifier = key.trim().toUpperCase();
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    await projectAccessService.assertCanBrowse(project.id, ctx);

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id },
      async (tx) => {
        const item = await workItemRepository.findByIdentifier(project.id, identifier, tx);
        if (!item) throw new WorkItemNotFoundError(identifier);
        // The Runs room's scope, on the card's run history too (MOTIR-6331).
        const { createdById } = await resolveRunScope(project.id, ctx, page.view, tx);
        const runs = await dispatchRunRepository.listByWorkItem(
          item.id,
          { take: page.take, cursor: page.cursor, statuses: page.statuses, createdById },
          tx,
        );
        // Each manual leg's gate (MOTIR-7477), one read for the page — the Run
        // section's leg line names who the skip waits on.
        const gates = await manualLegGates(runs, runSurfaceReader(ctx), tx);
        // The `seq` on a HISTORY row is not worth a read per run — the page
        // renders a list, and a client that opens one asks for its detail.
        return runs.map((run) => {
          const dto = toDispatchRunDto(run, 0);
          return {
            ...dto,
            cards: dto.cards.map((card) => ({ ...card, manualGate: legGateOf(card, gates) })),
          };
        });
      },
    );
  },

  /**
   * A PROJECT'S RUNS — current AND past, newest first, cursor-paginated
   * (MOTIR-3922). The read the RUNS INDEX stands on.
   *
   * ⚠️ THIS IS THE QUESTION THE STORY SHIPPED THREE READS WITHOUT ANSWERING.
   * One run by id, one card's runs, and the project's live runs each start from
   * something the caller already holds — an id, or a card already known to be in
   * the set. So a run that finished last night could not be found at all. This
   * one starts from the project, which is the only handle a person opening Motir
   * actually has.
   *
   * Two narrowings, and both are applied by the QUERY rather than to the page —
   * a filtered page would be short, and at a boundary empty with a cursor still
   * to follow, which every client reads as the end of the list:
   *
   *   · `statuses` — the live / past partition, from {@link RUN_IS_LIVE}.
   *   · `scopeWorkItemKey` — runs whose SCOPE is that container, which is a
   *     different question from `listRunsForWorkItemKey`'s: a scoped run's legs
   *     are the container's CHILDREN, so a story never appears in its own card
   *     history and this is the only way to ask for its runs.
   *
   * Rows carry the set as COUNTS, never as legs. The index renders a list that
   * grows without bound — run headers are append-only and the retention sweep
   * clears event BODIES, not rows — so a row that carried every leg would make
   * the list pay for a run view nobody opened.
   */
  async listRunsForProject(
    projectKey: string,
    page: {
      take: number;
      cursor?: string | undefined;
      statuses?: DispatchRunStatus[] | undefined;
      scopeWorkItemKey?: string | undefined;
      /** WHOSE runs — asked for; the service serves (MOTIR-6331). */
      view?: DispatchRunView | undefined;
    },
    reader: ServiceContext | VisitorReadContext,
  ): Promise<DispatchRunListPageDto> {
    const { svc: ctx, hidden } = runReader(reader);
    const project = await projectsService.getByKey(projectKey, ctx);
    await projectAccessService.assertCanBrowse(project.id, ctx);

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id },
      async (tx) => {
        // WHOSE runs (`view`) and WHICH work item's (`scopeWorkItemKey`) are two
        // axes, and both narrow the QUERY.
        const { scope: served, createdById } = await resolveRunScope(
          project.id,
          ctx,
          page.view,
          tx,
        );
        const bounded = {
          take: Math.min(Math.max(page.take, 1), DISPATCH_RUN_LIST_MAX_TAKE),
          ...(page.cursor ? { cursor: page.cursor } : {}),
          ...(page.statuses && page.statuses.length > 0 ? { statuses: page.statuses } : {}),
          ...(createdById ? { createdById } : {}),
          ...(hidden ? { withheldWorkItemIds: hidden } : {}),
        };

        // A SCOPE narrowing resolves its key inside the same transaction, so the
        // lookup is subject to the same workspace binding as the read it gates —
        // an unresolvable key is a 404 rather than an empty list, which is the
        // difference between "that story has no runs" and "that story is not
        // yours" (finding #44 keeps those indistinguishable to the CLIENT; they
        // must not be indistinguishable to this method).
        const runs = await (async () => {
          if (!page.scopeWorkItemKey) {
            return dispatchRunRepository.listByProject(project.id, bounded, tx);
          }
          const identifier = page.scopeWorkItemKey.trim().toUpperCase();
          const scope = await workItemRepository.findByIdentifier(project.id, identifier, tx);
          if (!scope || hidden?.includes(scope.id)) throw new WorkItemNotFoundError(identifier);
          return dispatchRunRepository.listByScope(scope.id, bounded, tx);
        })();

        // The waiting legs (MOTIR-7477) leave *skipped* in the summary, counted by
        // whether they wait on this reader — one gate read for the whole page.
        const gates = await manualLegGates(runs, runSurfaceReader(ctx), tx);
        return {
          runs: runs.map((run) => ({
            ...toDispatchRunListItemDto(run),
            waiting: toDispatchRunWaitingCounts(run.cards.map((card) => legGateOf(card, gates))),
          })),
          scope: served,
        };
      },
    );
  },

  /**
   * The Runs ROOM's views for this reader (Story MOTIR-6179 · MOTIR-6335):
   * `project` on `run:view_any` (role ∩ token grant), `mine` on a way to act —
   * starting a run (`RUN_ACT_PERMISSIONS`, what {@link open} asserts). Empty ⇒ the
   * room is closed to them. `canRun` also picks the Project-empty copy.
   */
  async roomAccess(
    projectKey: string,
    reader: ServiceContext | VisitorReadContext,
  ): Promise<{ views: DispatchRunView[]; canRun: boolean }> {
    // A Visitor's room is decided from the Visitor key set alone (MOTIR-6645):
    // `run:view_any` and nothing that acts ⇒ Project only, never a Run button.
    if (isVisitorContext(reader)) {
      if (projectKey.trim().toUpperCase() !== reader.project.identifier.toUpperCase()) {
        throw new ProjectNotFoundError(projectKey);
      }
      return {
        views: availableRoomViews({
          hasViewKey: reader.permissions.has('run:view_any'),
          canAct: false,
        }),
        canRun: false,
      };
    }
    const ctx = reader;
    const project = await projectsService.getByKey(projectKey, ctx);
    const held = await projectAccessService.getPermissions(project.id, ctx);
    if (!held.has('project:browse')) return { views: [], canRun: false };
    const canRun = holdsAnyOf(held, RUN_ACT_PERMISSIONS);
    return {
      views: availableRoomViews({
        hasViewKey: holdsRecordView(held, ctx, 'run:view_any'),
        canAct: canRun,
      }),
      canRun,
    };
  },

  /**
   * THE WORK ITEM A NARROWED RUNS INDEX NAMES (Story MOTIR-5363 · design
   * MOTIR-5402) — its key, title and archived flag, for `/runs?scope=<KEY>`'s
   * header. The design's ONE new read.
   *
   * ⚠️ A SEPARATE READ, NOT A WIDER RETURN FROM {@link listRunsForProject}. That
   * method also answers the index's poll and its *Show more*, and every one of
   * those calls would carry a header the browser already has. The page asks for
   * the scope once, on first paint.
   *
   * Resolved exactly as the narrowing resolves it — inside the project, under the
   * same browse gate and workspace binding — so the two cannot disagree about
   * whether a key names a scope: an unresolvable key throws
   * `WorkItemNotFoundError` here exactly as it does there. An ARCHIVED work item
   * still resolves, because `findByIdentifier` carries no archive filter and its
   * runs are still its runs.
   */
  async getRunScope(
    projectKey: string,
    scopeWorkItemKey: string,
    reader: ServiceContext | VisitorReadContext,
  ): Promise<DispatchRunScopeDto> {
    const { svc: ctx, hidden } = runReader(reader);
    const project = await projectsService.getByKey(projectKey, ctx);
    await projectAccessService.assertCanBrowse(project.id, ctx);
    const identifier = scopeWorkItemKey.trim().toUpperCase();

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id },
      async (tx) => {
        const item = await workItemRepository.findByIdentifier(project.id, identifier, tx);
        if (!item || hidden?.includes(item.id)) throw new WorkItemNotFoundError(identifier);
        return toDispatchRunScopeDto(item);
      },
    );
  },

  /**
   * A PROJECT'S LIVE RUNS, in ONE request — the `/ready` strip's read.
   *
   * ⚠️ IT LOOKS LIKE A CONVENIENCE AND IS NOT. Two surfaces need the same
   * question answered, and the alternative is each of them filtering a paginated
   * history client-side and disagreeing about what *active* means. It is also
   * the shape that keeps `/ready` to ONE request: a per-row endpoint is an N+1
   * on the busiest surface in the product.
   *
   * Narrow by construction — each leg's key and disposition, nothing else.
   */
  async listActiveRunsForProject(
    projectKey: string,
    reader: ServiceContext | VisitorReadContext,
    opts: { view?: DispatchRunView | undefined } = {},
  ): Promise<ActiveDispatchRunsDto> {
    const { svc: ctx, hidden } = runReader(reader);
    const project = await projectsService.getByKey(projectKey, ctx);
    await projectAccessService.assertCanBrowse(project.id, ctx);

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id },
      async (tx) => {
        const { scope, createdById } = await resolveRunScope(project.id, ctx, opts.view, tx);
        const runs = await dispatchRunRepository.listActiveByProject(
          project.id,
          tx,
          createdById,
          hidden,
        );
        const rows: ActiveDispatchRunDto[] = runs.map((run) => ({
          id: run.id,
          command: run.command,
          origin: run.origin,
          scopeLabel: run.scopeLabel,
          startedAt: run.startedAt.toISOString(),
          cards: run.cards.map((card) => ({
            key: card.workItemKey,
            disposition: card.disposition,
          })),
        }));
        return { runs: rows, scope };
      },
    );
  },

  /**
   * ONE PAGE of the stream, after `sinceSeq` — what the SSE route polls.
   *
   * It returns the run's STATUS beside the events on purpose: the stream's
   * termination condition is *the run reached a terminal status*, and asking for
   * that separately would open a window in which the last events arrive after
   * the status says the run is over, so a client's final frames are lost.
   */
  async readStreamPage(
    runId: string,
    sinceSeq: number,
    take: number,
    ctx: ServiceContext,
  ): Promise<{ events: DispatchRunEventDto[]; status: DispatchRunDto['status'] }> {
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const run = await dispatchRunRepository.findById(runId, tx);
        if (!run) throw new DispatchRunNotFoundError(runId);
        await assertMayReadRun(run, ctx, tx);
        const events = await dispatchRunEventRepository.listSince(runId, sinceSeq, take, tx);
        // ⚠️ THE EVENTS ARE READ AFTER THE STATUS, INSIDE ONE TRANSACTION. Read
        // the other way round, an event appended between the two reads would be
        // reported by a page whose status already said `running` — harmless — but
        // a status read AFTER the events could say `succeeded` while events the
        // same transaction had not yet seen were already committed, and the
        // stream would close on top of them.
        return { events: events.map(toDispatchRunEventDto), status: run.status };
      },
    );
  },
};

export type { DispatchRunCardDto };

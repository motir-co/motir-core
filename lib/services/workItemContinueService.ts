import type { DispatchRun, DispatchStopReason, Prisma } from '@/generated/prisma/client';
import type { ClaimActorDto } from '@/lib/dto/claim';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type {
  ContinueBranchDto,
  ContinueGateDto,
  ContinuePullRequestDto,
  DeadRunDto,
  RunDiedReason,
  WorkItemContinueClaimDto,
  WorkItemContinueRefusal,
  WorkItemContinueRunDto,
  WorkItemContinueViewDto,
} from '@/lib/dto/workItemContinue';
import { dispatchRunCardRepository } from '@/lib/repositories/dispatchRunCardRepository';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
import {
  dispatchRunRepository,
  type LatestRunForWorkItem,
} from '@/lib/repositories/dispatchRunRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { isRunAlive, lastHeardFrom } from '@/lib/runs/runLiveness';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { readHeldGateVerdict, type HeldGateRef } from '@/lib/services/resumeStateService';
import {
  ContinueRunRefusedError,
  DispatchRunTerminalError,
  DuplicateDispatchRunError,
} from '@/lib/dispatchRuns/errors';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { IN_PROGRESS_STATUS_KEY } from '@/lib/workItems/claimOutcome';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { ladderKeysFrom, RUNG_RANK, rankOfStatus } from '@/lib/workItems/statusLadder';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// THE CONTINUE CLAIM (Story MOTIR-6526 · MOTIR-6532,
// `docs/decisions/run-death-keeps-work.md` §4) — hand a work item whose last run
// DIED to ONE continuing agent, on the dead run's branch.
//
// It is the repair claim's shape (`workItemRepairService`) one lifecycle over: an
// open dispatch run is the lock (command `continue`), the outcomes are an enum,
// and no STATUS is written. The one card write is the ASSIGNEE — the takeover is
// exactly the change of who is on the card, and it is what makes the board say so.
//
// ── Why one transaction under the CARD's lock ───────────────────────────────
// The decision is read-derived — "the last run is dead, so take it over" — and two
// people can press continue in the same second. Both lock the card's row first, so
// the second waits for the first one's COMMIT and then reads the `continue` run it
// opened: `taken`, naming the holder, never a second agent on one branch. A run
// the rule reads as LAPSED is closed `abandoned` inside the same transaction, so
// the record agrees with the takeover the moment it commits.
//
// ── Why "is it alive?" is asked of `isRunAlive` and nothing else ────────────
// The marker on the card, the lapse reap and this claim must agree to the second
// about whether a run is dead; the rule lives in `lib/runs/runLiveness.ts` and is
// only READ here.

/** The run ended without success — the only runs there is anything to continue. */
const DIED_STATUSES = new Set(['failed', 'cancelled', 'timed_out']);

function actor(row: { id: string; name: string } | null): ClaimActorDto | null {
  return row ? { id: row.id, name: row.name } : null;
}

function toDeadRun(run: LatestRunForWorkItem): DeadRunDto {
  return {
    id: run.id,
    command: run.command,
    origin: run.origin,
    status: run.status,
    stopReason: run.stopReason,
    startedAt: run.startedAt.toISOString(),
    lastHeardAt: (run.lastHeartbeatAt ?? run.endedAt ?? lastHeardFrom(run)).toISOString(),
    dispatcher: actor(run.createdBy),
  };
}

const ladderKeysOf = ladderKeysFrom;

/**
 * The STATUS refusals — the pull request's rungs are `motir fix`'s business, and
 * anything that is not In Progress is not a run's to continue.
 */
function statusRefusal(
  status: string,
  archived: boolean,
  statuses: readonly WorkflowStatusDto[],
): WorkItemContinueRefusal | null {
  const rank = rankOfStatus(status, statuses, ladderKeysOf(statuses));
  if (
    !archived &&
    (rank === RUNG_RANK.implemented || rank === RUNG_RANK.in_review || rank === RUNG_RANK.approved)
  ) {
    return 'use_fix';
  }
  if (archived || status !== IN_PROGRESS_STATUS_KEY) return 'not_in_progress';
  return null;
}

/** A repository's name, whatever form it arrived in (`owner/name` or `name`). */
function repoName(repository: string): string {
  return (repository.split('/').pop() ?? repository).toLowerCase();
}

/** Where a dead run's work is — per repository, and its primary's entry. */
export interface ResolvedContinueBranches {
  /** The PRIMARY repository's branch (`branches[0]`), or null when none. */
  branch: string | null;
  /** The first open pull request the dead run left, as before MOTIR-6791. */
  pullRequest: ContinuePullRequestDto | null;
  /** Every repository's branch, primary first. */
  branches: ContinueBranchDto[];
}

/**
 * WHERE THE WORK IS, PER REPOSITORY (MOTIR-6791) — for each repository, its open
 * pull request's head, else the branch the dead run's `checkout_ready` recorded
 * for it (MOTIR-6530 / MOTIR-6539); when neither names anything, the leg's
 * session branch, the scope's session branch, and last the branch a `continue`
 * run's `run_opened` recorded. The same resolution the CONTINUE prompt uses
 * (MOTIR-6531), so the claim and the prompt name the same branches.
 *
 * `primaryRepo` is the card's first `targetRepos` entry: its branch leads the
 * list, which is what keeps `branch` meaning what it meant for one repository.
 */
export async function resolveContinueBranch(
  itemId: string,
  run: LatestRunForWorkItem,
  tx: Prisma.TransactionClient,
  primaryRepo: string | null = null,
): Promise<ResolvedContinueBranches> {
  const deliveries = await workItemDeliveryRepository.listByWorkItemWithChecks(itemId, tx);
  const openPrs: ContinueBranchDto[] = deliveries
    .filter((d) => d.pullRequest.state === 'open' && !d.pullRequest.merged)
    .map((d) => {
      const repo = `${d.repo.owner}/${d.repo.name}`;
      return {
        repository: d.repo.name,
        branch: d.pullRequest.headRef,
        pullRequest: {
          repo,
          number: d.pullRequest.number,
          url: `https://github.com/${repo}/pull/${d.pullRequest.number}`,
          headRef: d.pullRequest.headRef,
        },
      };
    });

  const leg = run.cards[0] ?? null;
  const recorded = await dispatchRunEventRepository.findLatestCheckoutBranches(
    run.id,
    leg?.id ?? null,
    tx,
  );
  let branches: ContinueBranchDto[];
  if (recorded.length > 0 && recorded.some((r) => r.repository !== null)) {
    // Per repository: a repository's open pull request's head wins for THAT
    // repository; a repository with a pull request and no checkpoint joins too.
    branches = recorded.map((r) => {
      const pr = openPrs.find(
        (p) => r.repository !== null && repoName(p.repository!) === repoName(r.repository),
      );
      return pr ?? { repository: r.repository, branch: r.branch, pullRequest: null };
    });
    for (const pr of openPrs) {
      if (!branches.some((b) => b.pullRequest?.url === pr.pullRequest!.url)) branches.push(pr);
    }
  } else if (openPrs.length > 0) {
    // A run that did not say which repository its branch was in: the open pull
    // requests are where the work is, exactly as before.
    branches = openPrs;
  } else if (recorded.length > 0) {
    branches = recorded.map((r) => ({ ...r, pullRequest: null }));
  } else {
    branches = await fallbackBranches(run, leg, tx);
  }

  if (primaryRepo !== null) {
    const at = branches.findIndex(
      (b) => b.repository !== null && repoName(b.repository) === repoName(primaryRepo),
    );
    if (at > 0) branches = [branches[at]!, ...branches.slice(0, at), ...branches.slice(at + 1)];
  }
  return {
    branch: branches[0]?.branch ?? null,
    pullRequest: openPrs[0]?.pullRequest ?? null,
    branches,
  };
}

/** The branches a run knows when no checkpoint and no pull request names one. */
async function fallbackBranches(
  run: LatestRunForWorkItem,
  leg: LatestRunForWorkItem['cards'][number] | null,
  tx: Prisma.TransactionClient,
): Promise<ContinueBranchDto[]> {
  const one = (branch: string): ContinueBranchDto[] => [
    { repository: null, branch, pullRequest: null },
  ];
  if (leg?.sessionBranch) return one(leg.sessionBranch);
  // A SCOPE run's container holds no leg of its own: its branch is the session
  // branch its legs were integrated onto (MOTIR-6535) — one name across repos.
  if (leg === null) {
    const legs = await dispatchRunCardRepository.listByRun(run.id, tx);
    const session = legs.find((l) => l.sessionBranch !== null)?.sessionBranch ?? null;
    if (session !== null) return one(session);
  }
  // A `continue` run that has not checked out yet still KNOWS its branches: the
  // claim wrote them onto the run's `run_opened` event. Without this, a continue
  // that dies before its checkout could not be continued again.
  const opened = await dispatchRunEventRepository.findLatestOfKind(run.id, 'run_opened', tx);
  const data = (opened?.data ?? null) as { branch?: unknown; branches?: unknown } | null;
  const recorded = openedBranches(data);
  if (recorded.length > 0) return recorded.map((b) => ({ ...b, pullRequest: null }));
  return typeof data?.branch === 'string' ? one(data.branch) : [];
}

/** The per-repository branches a `continue` run's `run_opened` recorded. */
function openedBranches(
  data: { branches?: unknown } | null,
): Array<{ repository: string | null; branch: string }> {
  if (!Array.isArray(data?.branches)) return [];
  return (data.branches as Array<{ repository?: unknown; branch?: unknown }>)
    .filter((b) => typeof b?.branch === 'string' && b.branch.length > 0)
    .map((b) => ({
      repository: typeof b.repository === 'string' ? b.repository : null,
      branch: b.branch as string,
    }));
}

/**
 * How a dead run ended, in the words the CONTINUE prompt hands the next agent.
 * Read off the stop reason first (it says WHY), then the status.
 *
 * ⚠️ `timeout` FIRST, BEFORE THE `abandoned` SHORTCUT (MOTIR-7085) — the same order
 * as {@link diedReason}, for the same reason: both end paths close a stall and the
 * 12-hour backstop `abandoned`, so read first, the stall and the backstop were
 * unreachable and the agent continuing a stalled run was told it lost its
 * heartbeat. `timeout` is {@link runTimeoutReason}'s answer for this run.
 */
export function endedHow(
  run: {
    status: string;
    stopReason: string | null;
    origin: string;
  },
  timeout: 'stalled' | 'backstop' | null,
): string {
  if (run.status === 'running') return 'the run stopped reporting (no heartbeat reached Motir)';
  if (run.status === 'succeeded' && run.stopReason === 'gated') {
    return 'it stopped at an approval gate, with the rest of its work waiting on a person';
  }
  // A run in the developer's own agent is closed `timed_out` by the same stall
  // window and 12-hour backstop as a hosted one (`agent-instance-run.md` §6).
  const who =
    run.origin === 'hosted'
      ? 'the Motir agent run'
      : run.origin === 'instance'
        ? 'the run in the agent'
        : null;
  if (run.status === 'timed_out' && who !== null && timeout !== null) {
    return timeout === 'backstop'
      ? `${who} reached its 12-hour time limit and was stopped`
      : `${who} stalled — it produced no output for too long — and was stopped`;
  }
  if (run.stopReason === 'abandoned') {
    return 'the run stopped reporting (no heartbeat reached Motir)';
  }
  if (run.stopReason === 'interrupted') return 'it was stopped from its terminal';
  if (run.status === 'failed') return 'the agent exited with an error';
  if (run.status === 'cancelled') return 'it was cancelled';
  if (run.status === 'timed_out' && who !== null) return `${who} stalled or reached its time limit`;
  return `it ended ${run.status}`;
}

/**
 * A hosted or agent `timed_out` run's timeout — the stall watchdog or the 12-hour
 * backstop — read off its closing `log` line; `null` for every other run, and for
 * one that LAPSED rather than timed out. What {@link diedReason} and
 * {@link endedHow} both split on, so the marker and the prompt cannot disagree.
 */
export async function runTimeoutReason(
  run: Pick<LatestRunForWorkItem, 'id' | 'status' | 'origin' | 'stopReason'>,
  tx: Prisma.TransactionClient,
): Promise<'stalled' | 'backstop' | null> {
  if (run.status !== 'timed_out' || (run.origin !== 'hosted' && run.origin !== 'instance')) {
    return null;
  }
  return timeoutReason(run, tx);
}

/**
 * The reason line's key (MOTIR-6534, design D3). A hosted `timed_out` is split by
 * its closing `log` line: the 12-hour backstop names itself, anything else is the
 * stall watchdog.
 *
 * ⚠️ THE SPLIT COMES BEFORE THE `abandoned` SHORTCUT (MOTIR-7061). Both end paths
 * close a stall and the backstop `abandoned` — the stop reason the lapse sweep
 * writes too — so read first, the stall and the backstop were unreachable and every
 * hosted timeout said *stopped reporting*.
 */
async function diedReason(
  run: LatestRunForWorkItem,
  tx: Prisma.TransactionClient,
): Promise<RunDiedReason> {
  if (run.status === 'running') return 'lapsed';
  // An `instance` run's supervise job closes it with the hosted words — a stall or
  // the 12-hour backstop (`agent-instance-run.md` §6) — so it splits the same way.
  const timeout = await runTimeoutReason(run, tx);
  if (timeout !== null) return timeout;
  if (run.stopReason === 'abandoned') return 'lapsed';
  if (run.stopReason === 'interrupted') return 'interrupted';
  if (run.status === 'failed') return 'failed';
  if (run.status === 'cancelled') return 'cancelled';
  return 'lapsed';
}

/**
 * A hosted or agent `timed_out` split by its closing `log` line — `null` when that
 * line says the run LAPSED rather than timed out.
 *
 * Both end paths name their end in `data.end` (`hostedRunService.endHostedRun`,
 * `agentInstanceRunService.end`), and that is read first: the hosted one carries no
 * `data.message`. A line with no `end` is a lapse when the run was closed
 * `abandoned` — the lapse sweep and the continue takeover write `no heartbeat
 * since …` — and otherwise is read by its words, the 12-hour backstop naming itself.
 */
async function timeoutReason(
  run: Pick<LatestRunForWorkItem, 'id' | 'stopReason'>,
  tx: Prisma.TransactionClient,
): Promise<'stalled' | 'backstop' | null> {
  const last = await dispatchRunEventRepository.findLatestOfKind(run.id, 'log', tx);
  const data = (last?.data ?? null) as { end?: unknown; message?: unknown } | null;
  if (data?.end === 'backstop') return 'backstop';
  if (data?.end === 'stall') return 'stalled';
  // `lost_supervision`, an agent's `lapsed`: nothing timed out, the run went quiet.
  if (data?.end !== undefined || run.stopReason === 'abandoned') return null;
  const message = String(data?.message ?? '');
  return /12[- ]hour|backstop/i.test(message) ? 'backstop' : 'stalled';
}

/** What the claim may still refuse a run it would otherwise take over for. */
type TakeoverRefusal = Exclude<
  WorkItemContinueRefusal,
  'run_alive' | 'no_dead_run' | 'gate_awaiting' | 'gate_sent_back'
>;

/** A run the claim would take over — one that died, or one RESUMABLE after a gate. */
interface TakeoverFacts {
  run: LatestRunForWorkItem;
  /** The rule reads it dead but its row still says `running` — the sweep has
   *  not got to it. The claim closes it; the view only reads it. */
  lapsed: boolean;
  branch: string | null;
  branches: ContinueBranchDto[];
  pullRequest: ContinuePullRequestDto | null;
  refusal: TakeoverRefusal | null;
  parentKey: string | null;
}

export type ContinueEvaluation =
  | { kind: 'none' }
  | { kind: 'alive'; run: LatestRunForWorkItem }
  | { kind: 'continuing'; run: LatestRunForWorkItem }
  | ({ kind: 'died' } & TakeoverFacts)
  /**
   * The last run STOPPED AT A GATE (closed `gated`) and a gate it stopped on has
   * since been approved (MOTIR-7708) — taken over exactly like a run that died,
   * on its own branch. `gates` are the approved ones. NOT a death: the To fix
   * reason and the *run died* marker read `died` alone.
   */
  | ({ kind: 'resumable'; gates: HeldGateRef[] } & TakeoverFacts)
  /** The last run stopped at a gate that still holds it — awaiting, or sent back. */
  | {
      kind: 'gated';
      run: LatestRunForWorkItem;
      refusal: 'gate_awaiting' | 'gate_sent_back';
      gates: HeldGateRef[];
    };

type Evaluation = ContinueEvaluation;

/**
 * THE PREDICATE — ONE function, read by the claim (under its row lock) and by the
 * item page (without one), so the page never offers a command the claim would
 * refuse (design `design/runs/design-notes.md` § Run died).
 */
async function evaluate(
  item: { id: string; status: string; archivedAt: Date | null; targetRepos: readonly string[] },
  statuses: readonly WorkflowStatusDto[],
  now: Date,
  tx: Prisma.TransactionClient,
): Promise<Evaluation> {
  const run = await dispatchRunRepository.findLatestForWorkItem(item.id, tx);
  if (!run) return { kind: 'none' };

  if (run.status === 'running') {
    const alive = isRunAlive(
      {
        status: run.status,
        origin: run.origin,
        startedAt: run.startedAt,
        lastHeartbeatAt: run.lastHeartbeatAt,
        reportedBy: run.reportedBy,
      },
      now,
    );
    if (alive)
      return run.command === 'continue' ? { kind: 'continuing', run } : { kind: 'alive', run };
  }
  // A run that STOPPED AT A GATE succeeded, but its remaining work waits on the
  // gate's answer (MOTIR-7708): it is resumed once a gate is approved.
  const held =
    run.status === 'succeeded' && run.stopReason === 'gated'
      ? await readHeldGateVerdict(run.id, tx)
      : null;
  if (run.status !== 'running' && held === null && !DIED_STATUSES.has(run.status)) {
    // It SUCCEEDED: the work moved on through the run's own delivery.
    return { kind: 'none' };
  }

  const refusalByStatus = statusRefusal(item.status, item.archivedAt !== null, statuses);
  // A leg of a PARENT run is continued with its parent — the whole run resumes on
  // its session branch and skips what already landed (MOTIR-6535).
  const parentKey =
    run.scopeWorkItemId !== null && run.scopeWorkItemId !== item.id
      ? (run.scope?.identifier ?? null)
      : null;
  const { branch, branches, pullRequest } = await resolveContinueBranch(
    item.id,
    run,
    tx,
    item.targetRepos[0] ?? null,
  );
  // ⚠️ THE STATUS FIRST, then the parent (MOTIR-6537): a child that is not In
  // Progress — never started, or finished — has nothing to continue, whoever's
  // run it was a leg of. The parent pointer is for an in-flight leg only, and
  // the marker's not-shown rule depends on this order.
  const before: TakeoverRefusal | null =
    refusalByStatus === 'use_fix' || refusalByStatus === 'not_in_progress'
      ? refusalByStatus
      : parentKey !== null
        ? 'continue_the_parent'
        : null;
  // A gate that still holds the run is asked AFTER the parent — a leg is resumed
  // with its parent, whose own claim gives the gate's answer — and before the
  // branch, which is a question only for work that may go ahead.
  if (held !== null && before === null && held.verdict !== 'released') {
    return held.verdict === 'awaiting'
      ? { kind: 'gated', run, refusal: 'gate_awaiting', gates: held.waiting }
      : { kind: 'gated', run, refusal: 'gate_sent_back', gates: held.sentBack };
  }
  const refusal: TakeoverRefusal | null = before ?? (branch === null ? 'no_branch' : null);
  if (held !== null) {
    return {
      kind: 'resumable',
      gates: [...held.released, ...held.changesRequested],
      run,
      lapsed: false,
      branch,
      branches,
      pullRequest,
      refusal,
      parentKey,
    };
  }
  return {
    kind: 'died',
    run,
    lapsed: run.status === 'running',
    branch,
    branches,
    pullRequest,
    refusal,
    parentKey,
  };
}

/**
 * THE PREDICATE, for a reader OUTSIDE this service — the stored To fix reason
 * (`fixReasonService.deriveFixReason`, MOTIR-6880), which reads it inside the
 * recompute's own row lock and transaction.
 *
 * ⚠️ A WRAPPER, NEVER A SECOND RULE. It is `evaluate` itself, so the claim, the item
 * page's marker and the To fix reason cannot disagree about whether a run died or
 * what the claim would answer. It writes nothing: a lapsed run the rule reads as
 * dead is closed by the CLAIM, never by a reader.
 */
export function evaluateContinueWithin(
  item: { id: string; status: string; archivedAt: Date | null; targetRepos: readonly string[] },
  statuses: readonly WorkflowStatusDto[],
  now: Date,
  tx: Prisma.TransactionClient,
): Promise<ContinueEvaluation> {
  return evaluate(item, statuses, now, tx);
}

/**
 * A dead run as the continue VIEW states it — the run (who, last heard from) and how
 * it ended. Shared by `getContinueView` and the To fix reason, so the row's *last heard
 * from* and the marker's are one read.
 */
export async function describeDeadRunWithin(
  run: LatestRunForWorkItem,
  tx: Prisma.TransactionClient,
): Promise<{ deadRun: DeadRunDto; reason: RunDiedReason }> {
  return { deadRun: toDeadRun(run), reason: await diedReason(run, tx) };
}

/**
 * A HOSTED continue's opening (Story MOTIR-6527 · MOTIR-6790). The hosted start
 * hands it to the claim so the lock it takes IS the hosted run: one `continue`
 * row, recorded `origin: 'hosted'` with the agent and model it runs on, and
 * idempotent on the start's key. Server-internal — the v1 continue route never
 * accepts one.
 */
export interface HostedContinueOpening {
  origin: 'hosted';
  agent: 'opencode';
  model: string;
  idempotencyKey: string;
}

export interface ClaimContinueOptions {
  opening?: HostedContinueOpening | undefined;
  /**
   * Told when the opening's key was ALREADY used, and the answer is a replay of
   * the run it opened — so a hosted start racing its own repeat does not boot
   * that run a second container.
   */
  onReplay?: ((runId: string) => void) | undefined;
}

function refused(
  item: { identifier: string; title: string },
  reason: WorkItemContinueRefusal,
  extra: Partial<WorkItemContinueClaimDto> = {},
): WorkItemContinueClaimDto {
  return {
    key: item.identifier,
    title: item.title,
    outcome: 'not_continuable',
    reason,
    parentKey: null,
    runId: null,
    holder: null,
    startedAt: null,
    deadRun: null,
    branch: null,
    branches: [],
    pullRequest: null,
    previousAssignee: null,
    mode: 'card',
    landedKeys: [],
    resumedKeys: [],
    gates: [],
    resumesGated: false,
    ...extra,
  };
}

/** A held gate as the claim names it. */
function toGateDto(gate: Pick<HeldGateRef, 'key' | 'kind' | 'state'>): ContinueGateDto {
  return { key: gate.key, kind: gate.kind, state: gate.state };
}

/**
 * The gates a `run_opened` recorded for a resume, or `[]`. This service is the
 * one writer of that array (`claimContinue`), so its elements are read as written.
 */
function gatesOf(value: unknown): ContinueGateDto[] {
  return Array.isArray(value) ? (value as ContinueGateDto[]).map(toGateDto) : [];
}

/** A JSON array of strings, or `[]` for anything else. */
function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * The answer a hosted opening already got, given again for a repeat of its key
 * (MOTIR-6790) — read back off the run it opened and that run's `run_opened`.
 */
async function replayOpening(
  item: { id: string; identifier: string; title: string },
  run: LatestRunForWorkItem,
  tx: Prisma.TransactionClient,
): Promise<WorkItemContinueClaimDto> {
  const opened = await dispatchRunEventRepository.findLatestOfKind(run.id, 'run_opened', tx);
  const data = (opened?.data ?? null) as {
    continuesRunId?: unknown;
    branch?: unknown;
    branches?: unknown;
    previousAssignee?: { id?: unknown; name?: unknown } | null;
    landedKeys?: unknown;
    resumedKeys?: unknown;
    resumesGated?: unknown;
    gates?: unknown;
  } | null;
  const deadId = typeof data?.continuesRunId === 'string' ? data.continuesRunId : null;
  const dead = deadId ? await dispatchRunRepository.findForWorkItemById(deadId, item.id, tx) : null;
  const previous = data?.previousAssignee;
  return {
    key: item.identifier,
    title: item.title,
    outcome: 'claimed',
    reason: null,
    parentKey: null,
    runId: run.id,
    holder: actor(run.createdBy),
    startedAt: run.startedAt.toISOString(),
    deadRun: dead ? toDeadRun(dead) : null,
    branch: typeof data?.branch === 'string' ? data.branch : null,
    branches: openedBranches(data).map((b) => ({ ...b, pullRequest: null })),
    pullRequest: dead ? (await resolveContinueBranch(item.id, dead, tx)).pullRequest : null,
    previousAssignee:
      previous && typeof previous.id === 'string' && typeof previous.name === 'string'
        ? { id: previous.id, name: previous.name }
        : null,
    mode: run.scopeWorkItemId === item.id ? 'parent' : 'card',
    landedKeys: stringsOf(data?.landedKeys),
    resumedKeys: stringsOf(data?.resumedKeys),
    gates: gatesOf(data?.gates),
    resumesGated: data?.resumesGated === true,
  };
}

/**
 * What a HOSTED continue would take over (MOTIR-6792) — read before any lock, so
 * the hosted start can run every pre-flight over the right repositories and
 * refuse the way the claim would, having touched nothing.
 *
 * `ok` names the continue's TARGET: the card itself, or — for an in-flight leg of
 * a dead PARENT run — that parent, which is continued whole. `legItemIds` are the
 * cards whose repositories the resumed run covers.
 */
export type HostedContinuePreview =
  | { ok: true; key: string; legItemIds: string[] }
  | {
      ok: false;
      /** The claim's refusal, or `taken` when a `continue` run already holds it. */
      reason: WorkItemContinueRefusal | 'taken';
      holder: ClaimActorDto | null;
      startedAt: string | null;
      parentKey: string | null;
    };

export const workItemContinueService = {
  /**
   * CLAIM the continue of one work item whose last run died.
   *
   * The decision order is the contract: a `continue` run already open (mine /
   * taken) → a live run (`run_alive`) → the status (`use_fix`, `not_in_progress`)
   * → a parent run's leg (`continue_the_parent`) → nothing died (`no_dead_run`) →
   * nothing to continue on (`no_branch`) → take it over.
   */
  async claimContinue(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
    now: Date = new Date(),
    options: ClaimContinueOptions = {},
  ): Promise<WorkItemContinueClaimDto> {
    const { opening } = options;
    const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);
    // A continue starts an agent, exactly like a dispatch — the same credit gate,
    // before any lock.
    await ciAllowanceService.assertDispatchAllowed(ctx);
    // The operation exists to START WORK on the card; a caller who may not edit
    // the project has no answer here worth giving.
    await projectAccessService.assertCanEdit(projectId, ctx);
    const statuses = await workflowsService.listStatusesByProject(projectId, ctx.workspaceId);

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      async (tx): Promise<WorkItemContinueClaimDto> => {
        await workItemRepository.lockById(item.id, tx);
        const state = await workItemRepository.findClaimStateById(item.id, tx);
        /* v8 ignore next -- the row was resolved above; only a delete between the two reads gets here */
        if (!state) throw new WorkItemNotFoundError(identifier);

        // The SAME hosted opening again — a retried start. Answered with the run
        // that opening already opened, whatever that run has done since: a
        // repeat must never be refused `taken` by its own run, nor take the card
        // over a second time once that run ended.
        if (opening) {
          const existing = await dispatchRunRepository.findByIdempotencyKey(
            ctx.workspaceId,
            opening.idempotencyKey,
            tx,
          );
          if (existing) {
            const replayed = await dispatchRunRepository.findForWorkItemById(
              existing.id,
              item.id,
              tx,
            );
            if (!replayed || replayed.command !== 'continue') {
              throw new DuplicateDispatchRunError(opening.idempotencyKey);
            }
            options.onReplay?.(replayed.id);
            return replayOpening(item, replayed, tx);
          }
        }

        const verdict = await evaluate(
          {
            id: item.id,
            status: state.status,
            archivedAt: state.archivedAt,
            targetRepos: item.targetRepos,
          },
          statuses,
          now,
          tx,
        );

        if (verdict.kind === 'continuing') {
          const mine = verdict.run.createdById === ctx.userId;
          const resolved = mine
            ? await resolveContinueBranch(item.id, verdict.run, tx, item.targetRepos[0] ?? null)
            : null;
          return {
            key: item.identifier,
            title: item.title,
            outcome: mine ? 'mine' : 'taken',
            reason: null,
            parentKey: null,
            runId: verdict.run.id,
            holder: actor(verdict.run.createdBy),
            startedAt: verdict.run.startedAt.toISOString(),
            // The holder is handed the branch again; a rival is handed nothing.
            deadRun: null,
            branch: resolved?.branch ?? null,
            branches: resolved?.branches ?? [],
            pullRequest: null,
            previousAssignee: null,
            mode: verdict.run.scopeWorkItemId === item.id ? 'parent' : 'card',
            landedKeys: [],
            resumedKeys: [],
            gates: [],
            resumesGated: false,
          };
        }
        if (verdict.kind === 'alive') {
          return refused(item, 'run_alive', {
            holder: actor(verdict.run.createdBy),
            startedAt: verdict.run.startedAt.toISOString(),
          });
        }
        if (verdict.kind === 'none') {
          const byStatus = statusRefusal(state.status, state.archivedAt !== null, statuses);
          return refused(item, byStatus ?? 'no_dead_run');
        }
        if (verdict.kind === 'gated') {
          return refused(item, verdict.refusal, { gates: verdict.gates.map(toGateDto) });
        }

        if (verdict.refusal !== null) {
          return refused(item, verdict.refusal, { parentKey: verdict.parentKey });
        }

        // THE TAKEOVER — of a run that died, or of one RESUMED after its gate was
        // approved (MOTIR-7708): the same lock, branch and parent split for both.
        const resumesGated = verdict.kind === 'resumable';
        const gates = verdict.kind === 'resumable' ? verdict.gates.map(toGateDto) : [];
        // A lapsed run is closed first — under this lock, with the
        // reason the lapse reap would give — so the record says it ended.
        let deadRun = toDeadRun(verdict.run);
        if (verdict.lapsed) {
          const lastHeard = lastHeardFrom(verdict.run).toISOString();
          await dispatchRunService.closeWithin(
            verdict.run.id,
            { stopReason: 'abandoned' },
            { userId: ctx.userId, workspaceId: ctx.workspaceId },
            tx,
            { message: `no heartbeat since ${lastHeard}`, lastHeartbeatAt: lastHeard },
          );
          deadRun = {
            ...deadRun,
            status: 'timed_out',
            stopReason: 'abandoned',
            lastHeardAt: lastHeard,
          };
        }

        // A PARENT run (MOTIR-6535): the dead run was SCOPED to this container, so
        // the takeover is of the whole scope — its legs that are still In Progress
        // are re-assigned too (so the scope claim that follows answers `mine`),
        // and the ones already landed are named, so they are never re-dispatched.
        const parent = verdict.run.scopeWorkItemId === item.id;
        const deadLegs = parent ? await dispatchRunCardRepository.listByRun(deadRun.id, tx) : [];
        const legKeys = deadLegs.map((l) => l.workItemKey).filter((k): k is string => k !== null);
        const legItems = await workItemRepository.findByIdentifiers(projectId, legKeys, tx);
        const landedKeys: string[] = [];
        const inFlight: string[] = [];
        const resumedKeys: string[] = [];
        for (const leg of legItems) {
          const rank = rankOfStatus(leg.status, statuses, ladderKeysOf(statuses));
          if (rank >= RUNG_RANK.implemented) landedKeys.push(leg.identifier);
          else if (leg.status === IN_PROGRESS_STATUS_KEY) {
            inFlight.push(leg.id);
            resumedKeys.push(leg.identifier);
          }
        }
        if (inFlight.length > 0) await workItemRepository.lockByIds(inFlight, tx);
        for (const id of inFlight) {
          await workItemRepository.update(id, { assigneeId: ctx.userId }, tx);
        }

        const previousAssignee =
          state.assigneeId === null
            ? null
            : actor(await userRepository.findById(state.assigneeId, tx));
        if (state.assigneeId !== ctx.userId) {
          await workItemRepository.update(item.id, { assigneeId: ctx.userId }, tx);
        }

        // The opening rides on the SAME insert, so the lock and the hosted run
        // are one row. `openWithin` answers a known key with the run it names,
        // but the replay above has already answered that case under this lock.
        const opened = await dispatchRunService.openWithin(
          projectId,
          {
            reportedBy: 'cli',
            ...(parent
              ? {
                  command: 'continue' as const,
                  scopeKey: item.identifier,
                  scopeLabel: item.identifier,
                  cards: legKeys.map((key) => ({ key, disposition: 'queued' as const })),
                }
              : {
                  command: 'continue' as const,
                  cards: [{ key: item.identifier, disposition: 'queued' as const }],
                }),
            ...(opening
              ? {
                  origin: opening.origin,
                  agent: opening.agent,
                  model: opening.model,
                  idempotencyKey: opening.idempotencyKey,
                }
              : {}),
          },
          ctx,
          tx,
        );
        await dispatchRunEventRepository.createMany(
          [
            {
              workspaceId: ctx.workspaceId,
              dispatchRunId: opened.run.id,
              seq: 1,
              kind: 'run_opened',
              reportedBy: 'cli',
              data: {
                command: 'continue',
                key: item.identifier,
                continuesRunId: deadRun.id,
                previousAssignee: previousAssignee ? { ...previousAssignee } : null,
                branch: verdict.branch,
                branches: verdict.branches.map((b) => ({
                  repository: b.repository,
                  branch: b.branch,
                })),
                // The scope shape (MOTIR-6795): a hosted container ADOPTS this run
                // rather than claiming, so what the claim decided is read back
                // from here — which legs landed, which were in flight.
                mode: parent ? 'parent' : 'card',
                landedKeys: [...landedKeys].sort(),
                resumedKeys: [...resumedKeys].sort(),
                // A RESUME after an approval says so, and after which gates — the
                // run section reads *Resuming* from here (MOTIR-7708).
                ...(resumesGated
                  ? { resumesGated: true, gates: gates.map((g) => ({ ...g })) }
                  : {}),
                // A hosted continue's ONE `run_opened` (the hosted start appends
                // none of its own) says what Run hosted's does.
                ...(opening ? { origin: opening.origin, model: opening.model } : {}),
              },
            },
          ],
          tx,
        );
        return {
          key: item.identifier,
          title: item.title,
          outcome: 'claimed',
          reason: null,
          parentKey: null,
          runId: opened.run.id,
          holder: actor(await userRepository.findById(ctx.userId, tx)),
          startedAt: opened.run.startedAt,
          deadRun,
          branch: verdict.branch,
          branches: verdict.branches,
          pullRequest: verdict.pullRequest,
          previousAssignee,
          mode: parent ? 'parent' : 'card',
          landedKeys: landedKeys.sort(),
          resumedKeys: resumedKeys.sort(),
          gates,
          resumesGated,
        };
      },
    );
  },

  /**
   * Which card a HOSTED continue of `identifier` takes over, and over which legs
   * — or the refusal the claim would give (MOTIR-6792). The claim's own
   * evaluation, WITHOUT a lock and writing nothing; the claim decides again under
   * its lock, so this is a pre-flight, never the decision.
   *
   * A leg of a dead parent run redirects ONCE to that parent: a hosted continue
   * boots `motir continue <PARENT>`, exactly what a terminal would run.
   */
  async previewHostedContinue(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
    now: Date = new Date(),
    redirected = false,
  ): Promise<HostedContinuePreview> {
    const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);
    const statuses = await workflowsService.listStatusesByProject(projectId, ctx.workspaceId);
    const refuse = (
      reason: WorkItemContinueRefusal | 'taken',
      extra: Partial<Extract<HostedContinuePreview, { ok: false }>> = {},
    ): HostedContinuePreview => ({
      ok: false,
      reason,
      holder: null,
      startedAt: null,
      parentKey: null,
      ...extra,
    });

    const verdict = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      async (tx) => {
        const state = await workItemRepository.findClaimStateById(item.id, tx);
        /* v8 ignore next -- the row was resolved above; only a delete between the two reads gets here */
        if (!state) throw new WorkItemNotFoundError(identifier);
        const evaluated = await evaluate(
          {
            id: item.id,
            status: state.status,
            archivedAt: state.archivedAt,
            targetRepos: item.targetRepos,
          },
          statuses,
          now,
          tx,
        );
        const legs =
          (evaluated.kind === 'died' || evaluated.kind === 'resumable') &&
          evaluated.run.scopeWorkItemId === item.id
            ? await dispatchRunCardRepository.listByRun(evaluated.run.id, tx)
            : [];
        return { evaluated, state, legs };
      },
    );
    const { evaluated, state, legs } = verdict;

    if (evaluated.kind === 'continuing') {
      return refuse('taken', {
        holder: actor(evaluated.run.createdBy),
        startedAt: evaluated.run.startedAt.toISOString(),
      });
    }
    if (evaluated.kind === 'alive') {
      return refuse('run_alive', {
        holder: actor(evaluated.run.createdBy),
        startedAt: evaluated.run.startedAt.toISOString(),
      });
    }
    if (evaluated.kind === 'none') {
      return refuse(
        statusRefusal(state.status, state.archivedAt !== null, statuses) ?? 'no_dead_run',
      );
    }
    if (evaluated.kind === 'gated') return refuse(evaluated.refusal);
    if (evaluated.refusal === 'continue_the_parent' && evaluated.parentKey && !redirected) {
      return this.previewHostedContinue(projectId, evaluated.parentKey, ctx, now, true);
    }
    if (evaluated.refusal !== null) {
      return refuse(evaluated.refusal, { parentKey: evaluated.parentKey });
    }
    const legItemIds = legs.map((l) => l.workItemId).filter((id): id is string => id !== null);
    return {
      ok: true,
      key: item.identifier,
      legItemIds: legItemIds.length > 0 ? legItemIds : [item.id],
    };
  },

  /**
   * The continue claim as an AGENT makes it over the MCP (Story MOTIR-7261 ·
   * MOTIR-7262): {@link claimContinue} unchanged, then — on `claimed` and `mine`
   * only — ONE heartbeat on the run it answers. `claimRepairAsAgent`, one
   * lifecycle over, and for its reason: a run with no heartbeat at all is on the
   * 12-hour AGE reap, not the five-minute lapse (`isRunAlive`,
   * `lib/runs/runLiveness.ts`), so an agent that claims and dies before its first
   * `touch_work_item_continue` would hold the card *being continued* for half a
   * day. The claim's rules, its DTO and its refusals are untouched.
   */
  async claimContinueAsAgent(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
  ): Promise<WorkItemContinueClaimDto> {
    const claim = await workItemContinueService.claimContinue(projectId, identifier, ctx);
    if ((claim.outcome === 'claimed' || claim.outcome === 'mine') && claim.runId !== null) {
      try {
        await dispatchRunService.heartbeat(claim.runId, ctx);
      } catch (err) {
        // A `mine` run the reap closed between the claim's read and this beat.
        // The claim's answer stands; the agent's first touch reads `open: false`.
        /* v8 ignore next -- only a reap landing inside that window reaches here */
        if (!(err instanceof DispatchRunTerminalError)) throw err;
      }
    }
    return claim;
  },

  /**
   * KEEP a claimed continue ALIVE (MOTIR-7262) — `touch_work_item_continue`.
   *
   * Only the caller's own `continue` run on THIS card is touched
   * ({@link ContinueRunRefusedError} otherwise, before anything is written). An
   * open run is beaten through `dispatchRunService.heartbeat` — the one heartbeat
   * there is, under the lock it shares with the reap — and a closed one is
   * ANSWERED rather than refused, `open: false` with how it ended, because the
   * agent's next move is to stop, and an error would read as something to retry.
   */
  async touchContinue(
    projectId: string,
    identifier: string,
    runId: string,
    ctx: ServiceContext,
  ): Promise<WorkItemContinueRunDto> {
    const { key, run } = await readOwnContinueRun(projectId, identifier, runId, ctx);
    if (run.status !== 'running') return toContinueRunDto(key, run);
    try {
      await dispatchRunService.heartbeat(runId, ctx);
    } catch (err) {
      // Closed between the read above and the heartbeat's lock — by the reap,
      // usually. The same answer as a run that was already closed.
      if (!(err instanceof DispatchRunTerminalError)) throw err;
    }
    return toContinueRunDto(key, (await readOwnContinueRun(projectId, identifier, runId, ctx)).run);
  },

  /**
   * CLOSE a claimed continue with how it ended (MOTIR-7262) —
   * `close_work_item_continue`. `stopReason` is the set the v1 close body accepts
   * (`dispatchRunCloseBodySchema`), which is the set `motir continue` closes with,
   * and the run's status is derived from it by `dispatchRunService.close` exactly
   * as for that route.
   *
   * IDEMPOTENT: a run that is already closed — by this caller's own earlier close,
   * or by the reap — is answered as it stands and changed by nothing, because an
   * agent that retries after a timeout must not be told it failed.
   */
  async closeContinue(
    projectId: string,
    identifier: string,
    runId: string,
    stopReason: DispatchStopReason,
    ctx: ServiceContext,
  ): Promise<WorkItemContinueRunDto> {
    const { key, run } = await readOwnContinueRun(projectId, identifier, runId, ctx);
    if (run.status !== 'running') return toContinueRunDto(key, run);
    try {
      await dispatchRunService.close(runId, { stopReason }, ctx);
    } catch (err) {
      if (!(err instanceof DispatchRunTerminalError)) throw err;
    }
    return toContinueRunDto(key, (await readOwnContinueRun(projectId, identifier, runId, ctx)).run);
  },

  /**
   * What the item page draws about a run that died (MOTIR-6534) — the claim's own
   * evaluation, WITHOUT a lock and without closing or opening anything. A read a
   * browse-only viewer may make.
   */
  async getContinueView(
    workItemId: string,
    ctx: ServiceContext,
    now: Date = new Date(),
  ): Promise<WorkItemContinueViewDto> {
    const item = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => workItemRepository.findById(workItemId, tx),
    );
    if (!item) throw new WorkItemNotFoundError(workItemId);
    await projectAccessService.assertCanBrowse(item.projectId, ctx);
    const statuses = await workflowsService.listStatusesByProject(item.projectId, ctx.workspaceId);

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: item.projectId },
      async (tx): Promise<WorkItemContinueViewDto> => {
        const verdict = await evaluate(item, statuses, now, tx);
        // A run that stopped at a gate is not a death, so the *run died* marker
        // draws nothing for it; its own marker is the run section's (MOTIR-7713).
        if (verdict.kind === 'none' || verdict.kind === 'gated' || verdict.kind === 'resumable') {
          return { state: 'none' };
        }
        if (verdict.kind === 'alive') return { state: 'alive' };
        if (verdict.kind === 'continuing') {
          const opened = await dispatchRunEventRepository.findLatestOfKind(
            verdict.run.id,
            'run_opened',
            tx,
          );
          const data = (opened?.data ?? null) as {
            continuesRunId?: unknown;
            branch?: unknown;
            branches?: unknown;
          } | null;
          const tookOverId = typeof data?.continuesRunId === 'string' ? data.continuesRunId : null;
          const tookOver = tookOverId
            ? await dispatchRunRepository.findRunStarterById(tookOverId, tx)
            : null;
          return {
            state: 'continuing',
            holder: actor(verdict.run.createdBy),
            byViewer: verdict.run.createdById === ctx.userId,
            // `instance` takes the local arm: a continue is opened by a CLI the
            // developer runs, or hosted by the server — never INTO an agent
            // (`agent-instance-run.md`, "What this does NOT decide"), so a
            // continuing run is never an `instance` run.
            origin: verdict.run.origin === 'hosted' ? 'hosted' : 'local',
            startedAt: verdict.run.startedAt.toISOString(),
            branch: typeof data?.branch === 'string' ? data.branch : null,
            branches: openedBranches(data).map((b) => ({ ...b, pullRequest: null })),
            tookOverFrom: tookOverId
              ? { runId: tookOverId, dispatcher: actor(tookOver?.createdBy ?? null) }
              : null,
          };
        }
        const { deadRun, reason } = await describeDeadRunWithin(verdict.run, tx);
        return {
          state: 'died',
          deadRun,
          reason,
          branch: verdict.branch,
          branches: verdict.branches,
          pullRequest: verdict.pullRequest,
          refusal: verdict.refusal,
          parentKey: verdict.parentKey,
        };
      },
    );
  },
};

function toContinueRunDto(key: string, run: DispatchRun): WorkItemContinueRunDto {
  return {
    key,
    runId: run.id,
    open: run.status === 'running',
    status: run.status,
    stopReason: run.stopReason,
    startedAt: run.startedAt.toISOString(),
    endedAt: run.endedAt?.toISOString() ?? null,
    lastHeartbeatAt: run.lastHeartbeatAt?.toISOString() ?? null,
  };
}

/**
 * Resolve the card and read the named run, refusing anything that is not the
 * CALLER's `continue` run on that card (MOTIR-7262) — `readOwnRepairRun`, one
 * lifecycle over. The card read carries the tenancy + browse gate (a foreign key
 * is not found), and the edit gate is the one `claimContinue` asserts.
 *
 * A continue of a CARD holds it as its one leg; a continue of a PARENT (MOTIR-6535)
 * is SCOPED to it and holds its children as legs — so a run holds the card when
 * it is the run's scope or one of its legs.
 */
async function readOwnContinueRun(
  projectId: string,
  identifier: string,
  runId: string,
  ctx: ServiceContext,
): Promise<{ key: string; run: DispatchRun }> {
  const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);
  await projectAccessService.assertCanEdit(projectId, ctx);
  const run = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
    (tx) => dispatchRunRepository.findByIdWithCards(runId, tx),
  );
  const holdsCard =
    run !== null &&
    run.projectId === projectId &&
    run.command === 'continue' &&
    (run.scopeWorkItemId === item.id || run.cards.some((leg) => leg.workItemId === item.id));
  if (!run || !holdsCard) throw new ContinueRunRefusedError(runId, item.identifier, 'not_found');
  if (run.createdById !== ctx.userId) {
    throw new ContinueRunRefusedError(runId, item.identifier, 'not_yours');
  }
  return { key: item.identifier, run };
}

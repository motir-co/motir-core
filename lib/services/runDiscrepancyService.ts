import {
  DiscrepancyAlreadyRecordedError,
  DispatchRunNotFoundError,
  DispatchRunTerminalError,
  RUN_DISCREPANCY_FIELD_MAX,
  RUN_DISCREPANCY_POINTS_MAX,
  RunDiscrepancyInvalidError,
  UnknownDispatchRunCardError,
} from '@/lib/dispatchRuns/errors';
import {
  composeDiscrepancyComment,
  type RunDecisionPoint,
  type RunDiscrepancyPoint,
} from '@/lib/dispatchRuns/discrepancyComment';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { dispatchRunCardRepository } from '@/lib/repositories/dispatchRunCardRepository';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { assertRunTokenScope, DISPATCH_RUN_EVENT_LIMIT } from '@/lib/services/dispatchRunService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// A RUN'S DISCREPANCY RECORD (Story MOTIR-8651 · Subtask MOTIR-8655). The accepted record is
// the decision page MOTIR-8654, *A run builds through a wrong HOW — the discrepancy record*;
// this header states only what the code does.
//
// A runner that finds its card wrong only about the HOW builds through it and calls
// `record_run_discrepancy` ONCE with every point (what the plan asked · what was built · why).
// This service writes ONE comment on the card listing the points, and — when the card has an
// OPEN LEG on a running dispatch run — ONE `discrepancy_recorded` finding on that leg whose
// `data` is a POINTER (`{ commentId, pointCount, dispatchRunCardId }`), never the text.
//
// ⚠️ ONE TRANSACTION, AND THE FINDING IS NOT BEST-EFFORT. `recordFinding` swallows every
// failure because it observes a write that already committed. Here the comment IS the act and
// the answer must say truthfully whether the record exists, so a failed finding write fails the
// whole call and NOTHING is written (the runner then states the record is missing).
//
// ⚠️ ONE RECORD PER LEG. The run row is locked `FOR UPDATE` first — the same lock the event
// append takes, so it also serialises the `seq` allocation — and the dedupe
// (`findFindingOnRun`, keyed on `data.dispatchRunCardId`) is read UNDER it, so two concurrent
// calls cannot both pass. A second call is refused with `DISCREPANCY_ALREADY_RECORDED` and
// writes no second comment.
//
// ⚠️ NO OPEN LEG IS NOT AN ERROR. The comment is still written and `recorded` is false: a card
// with no run record, or no approving plan, still gets its discrepancy.
//
// `reportedBy` on the event is the RUN's own reporter (`cli` or `agent`), so a reader knows
// whose account the record is in.
//
// ⚠️ DECISIONS RIDE THE SAME RECORD (MOTIR-10000). A run that DECIDED something the plan left
// open — by the repository's conventions, then industry best practice — sends it as a
// `decisions` entry (`planSaid · chose · why`, `alternatives` optional) in this same ONE call,
// beside any build-through points or alone. One comment, one finding, one record per leg, as
// before: the comment gives the decisions their own section, and the finding's `pointCount`
// counts every entry (so the run's strip never reads _0 points_ on a decisions-only record)
// while `decisionCount` says how many of them were decisions. Points-only calls are unchanged
// byte for byte, so a build-through, and the planning-bug path that reads it, behave as they did.
//
// Permission: `work_item:edit` on the card's project — the key `CLI_TOKEN_GRANT` already holds.
//
// ⚠️ THE RUN DOOR (MOTIR-8722) names its run: `POST /api/v1/dispatch-runs/{id}/discrepancy`,
// which the CLI posts with the run's own credential from the points the agent wrote into
// `$MOTIR_AGENT_REPORT` — a hosted or agent-instance agent holds no Motir token and `/api/mcp`
// refuses a run token. Given `runId`, the leg is the card's leg on THAT run, read under that
// run's lock, and a card that is not an open leg of it is refused (`UNKNOWN_DISPATCH_RUN_CARD`)
// before anything is written: a run's credential reaches only its own cards, so the
// "no open leg, comment anyway" arm is the agent door's alone.

/** What the runner sends. */
export interface RecordDiscrepancyInput {
  /** The card that was built through, `KEY-<n>` (the in-flight child, on a parent run). */
  key: string;
  /** The build-through points; empty (or absent) when the record carries only decisions. */
  points?: readonly RunDiscrepancyPoint[];
  /** The decisions the run made where the plan was silent (MOTIR-10000). */
  decisions?: readonly RunDecisionPoint[];
}

/** The whole answer — acknowledgement only. */
export interface RecordDiscrepancyResult {
  commentId: string;
  /** Whether a finding was written on an open leg of a running dispatch run. */
  recorded: boolean;
}

function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

const FIELDS = ['planAsked', 'built', 'why'] as const;
const DECISION_FIELDS = ['planSaid', 'chose', 'why'] as const;

/** One field trimmed and bounded, or the refusal naming where it is. */
function boundedField(
  raw: string | null | undefined,
  where: ConstructorParameters<typeof RunDiscrepancyInvalidError>[1],
): string {
  const value = (raw ?? '').trim();
  if (value.length === 0) throw new RunDiscrepancyInvalidError('field_empty', where);
  if (value.length > RUN_DISCREPANCY_FIELD_MAX) {
    throw new RunDiscrepancyInvalidError('field_too_long', where);
  }
  return value;
}

/** Trim and bound the decisions. `alternatives` is optional; sent, it is bounded like the rest. */
function validateDecisions(decisions: readonly RunDecisionPoint[]): RunDecisionPoint[] {
  if (decisions.length > RUN_DISCREPANCY_POINTS_MAX) {
    throw new RunDiscrepancyInvalidError('decisions_too_many');
  }
  return decisions.map((decision, index) => {
    const clean: RunDecisionPoint = { planSaid: '', chose: '', why: '' };
    for (const field of DECISION_FIELDS) {
      clean[field] = boundedField(decision[field], { decision: index + 1, field });
    }
    if (decision.alternatives != null && decision.alternatives.trim() !== '') {
      clean.alternatives = boundedField(decision.alternatives, {
        decision: index + 1,
        field: 'alternatives',
      });
    }
    return clean;
  });
}

/** Trim and bound the points. Refused, never truncated; nothing is resolved first. */
function validatePoints(
  points: readonly RunDiscrepancyPoint[],
  decisionCount: number,
): RunDiscrepancyPoint[] {
  if (points.length === 0 && decisionCount === 0) {
    throw new RunDiscrepancyInvalidError('points_empty');
  }
  if (points.length > RUN_DISCREPANCY_POINTS_MAX) {
    throw new RunDiscrepancyInvalidError('points_too_many');
  }
  return points.map((point, index) => {
    const clean = { planAsked: '', built: '', why: '' };
    for (const field of FIELDS) {
      clean[field] = boundedField(point[field], { point: index + 1, field });
    }
    return clean;
  });
}

export const runDiscrepancyService = {
  /**
   * Record that the caller's run built `key` through a wrong HOW. See the file header.
   *
   * @throws RunDiscrepancyInvalidError — no points and no decisions, too many of either, or a
   *   field is empty or
   *   over {@link RUN_DISCREPANCY_FIELD_MAX} characters.
   * @throws WorkItemNotFoundError — the card does not exist for this caller.
   * @throws PermissionDeniedError — the caller may not edit the card.
   * @throws DiscrepancyAlreadyRecordedError — the card's open leg already carries a record.
   */
  async recordDiscrepancy(
    input: RecordDiscrepancyInput,
    ctx: ServiceContext,
    opts: {
      /** The run door's run (MOTIR-8722): pin the leg to it, and refuse a card it does not hold. */
      runId?: string;
    } = {},
  ): Promise<RecordDiscrepancyResult> {
    if (opts.runId !== undefined) assertRunTokenScope(opts.runId, ctx);
    const decisions = validateDecisions(input.decisions ?? []);
    const points = validatePoints(input.points ?? [], decisions.length);
    const key = input.key.trim().toUpperCase();

    // An unknown project, another workspace's key and an unbrowsable project all answer the SAME
    // `WorkItemNotFoundError` as an unknown card — nothing about the card's existence leaks
    // (`runFoundReportService.resolveTarget` is the sibling).
    let project: Awaited<ReturnType<typeof projectsService.getByKey>>;
    try {
      project = await projectsService.getByKey(projectKeyOf(key), ctx);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw new WorkItemNotFoundError(key);
      throw err;
    }
    await projectAccessService.assertPermission(project.id, ctx, 'work_item:edit');

    const bound = { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id };
    const { result, workItemId } = await withWorkspaceContext(bound, async (tx) => {
      const item = await workItemRepository.findByIdentifier(project.id, key, tx);
      if (!item) throw new WorkItemNotFoundError(key);

      // The leg first, then the run row's lock, then the dedupe UNDER the lock. The run
      // door locks its named run FIRST and reads the card's leg on it.
      let leg: Awaited<ReturnType<typeof dispatchRunCardRepository.findOpenLegForWorkItem>>;
      if (opts.runId !== undefined) {
        const locked = await dispatchRunRepository.findTerminalStateForUpdate(opts.runId, tx);
        if (!locked || locked.createdById !== ctx.userId) {
          throw new DispatchRunNotFoundError(opts.runId);
        }
        if (locked.status !== 'running') {
          throw new DispatchRunTerminalError(opts.runId, locked.status);
        }
        const pinned = await dispatchRunCardRepository.findByRunAndWorkItem(
          opts.runId,
          item.id,
          tx,
        );
        if (!pinned || pinned.endedAt !== null) throw new UnknownDispatchRunCardError(key);
        leg = pinned;
      } else {
        leg = await dispatchRunCardRepository.findOpenLegForWorkItem(item.id, tx);
        if (leg) await dispatchRunRepository.findTerminalStateForUpdate(leg.dispatchRunId, tx);
      }
      let run: Awaited<ReturnType<typeof dispatchRunRepository.findById>> = null;
      if (leg) {
        const already = await dispatchRunEventRepository.findFindingOnRun(
          leg.dispatchRunId,
          'discrepancy_recorded',
          leg.id,
          tx,
        );
        if (already) throw new DiscrepancyAlreadyRecordedError(key);
        run = await dispatchRunRepository.findById(leg.dispatchRunId, tx);
      }

      const comment = await commentRepository.create(
        {
          workspaceId: ctx.workspaceId,
          workItemId: item.id,
          authorId: ctx.userId,
          parentCommentId: null,
          bodyMd: composeDiscrepancyComment(points, decisions),
        },
        tx,
      );

      let recorded = false;
      if (leg && run) {
        const existing = await dispatchRunEventRepository.countByRun(run.id, tx);
        if (existing < DISPATCH_RUN_EVENT_LIMIT) {
          const seq = ((await dispatchRunEventRepository.maxSeq(run.id, tx)) ?? 0) + 1;
          await dispatchRunEventRepository.createMany(
            [
              {
                workspaceId: ctx.workspaceId,
                dispatchRunId: run.id,
                dispatchRunCardId: leg.id,
                seq,
                kind: 'discrepancy_recorded',
                reportedBy: run.reportedBy,
                // A POINTER and counts — never the text, which lives in the comment.
                data: {
                  commentId: comment.id,
                  pointCount: points.length + decisions.length,
                  // Only when there are any, so a points-only record writes what it always did.
                  ...(decisions.length > 0 ? { decisionCount: decisions.length } : {}),
                  dispatchRunCardId: leg.id,
                },
              },
            ],
            tx,
          );
          recorded = true;
        }
      }
      return { result: { commentId: comment.id, recorded }, workItemId: item.id };
    });

    // Post-commit, like every comment: a rollback must not have notified watchers.
    await sendEvent('work-item/comment.created', {
      workspaceId: ctx.workspaceId,
      workItemId,
      commentId: result.commentId,
      authorId: ctx.userId,
      mentionedUserIds: [],
      ...(ctx.viaAutomationRuleId ? { viaAutomationRuleId: ctx.viaAutomationRuleId } : {}),
    });

    return result;
  },
};

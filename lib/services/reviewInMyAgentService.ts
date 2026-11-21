import { ReviewInMyAgentNotOfferedError } from '@/lib/agentInstances/errors';
import { ownDeliverySetVersion } from '@/lib/agentReview/ownVersion';
import { reviewOwnAgentRunKey, reviewRunKeyPrefix } from '@/lib/agentReview/reviewRunKey';
import type {
  AgentForCardDto,
  AgentRunStartedDto,
  ReviewInMyAgentDoorDto,
  ReviewInMyAgentNotOfferedReason,
} from '@/lib/dto/agentInstanceRuns';
import { dispatchRunLabel } from '@/lib/howToTest/author';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import {
  dispatchRunRepository,
  type RunningReviewRun,
} from '@/lib/repositories/dispatchRunRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { agentInstanceRunService } from '@/lib/services/agentInstanceRunService';
import { resolveGateAuthority } from '@/lib/services/approvalGatesService';
import { IN_REVIEW_STATUS_KEY } from '@/lib/services/gateSetFor';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// THE "REVIEW IN MY AGENT" DOOR (Story MOTIR-11941 · MOTIR-11945; `approval-gates.md`
// §12.18) — a person hands an item's review to one of their OWN agents. The read composes
// what the item is, what is under review, whether a review is already running, whether the
// viewer may decide it, and the viewer's agents into the door's state; the start re-decides
// all of it itself (never trusting the client) and opens ONE `review` run in the agent
// through `agentInstanceRunService.start`.
//
// The reasons, in the order the read decides them:
//   not_in_review     — the item is not In review;
//   no_pull_request   — the item has no delivery of its own, so no version to review;
//   gate_not_awaiting — Review on, and no `agent_review` gate awaiting at the current version;
//   review_in_flight  — a review is running: with Review on any review run under the gate's
//                       key prefix (hosted or own-agent), with Review off any running
//                       `review` run with a leg on the item;
//   cannot_decide     — no `work_item:edit`, or (Review on) outside the gate's routed set;
//   no_agent          — the viewer has no own agent on the project;
//   agent_unusable    — none of the viewer's agents can run now (the agent's own refusal).
//
// ⚠️ THE READ IS ADVISORY; THE LOCK DECIDES. Two presses can both pass the in-flight check,
// so the open re-checks under the item's review lock (`reviewInFlightUnderLock`, taken in
// `agentInstanceRunService.start`'s open), which the hosted door's open takes too.

/** The project key a `MOTIR-<n>` identifier belongs to. */
function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

/** What a start reviews: the awaiting gate (null with Review off) and the version. */
interface ReviewSubject {
  gateId: string | null;
  subjectVersion: string;
}

/** The item's subject and the gates in front of the agent choice. */
type Evaluation =
  | {
      kind: 'refused';
      reason: Exclude<ReviewInMyAgentNotOfferedReason, 'no_agent' | 'agent_unusable'>;
      inFlight: RunningReviewRun | null;
    }
  | { kind: 'reviewable'; subject: ReviewSubject };

/** Before the in-flight check: what the item is and what is under review. */
type SubjectRead =
  | { kind: 'refused'; reason: 'not_in_review' | 'no_pull_request' | 'gate_not_awaiting' }
  | {
      kind: 'subject';
      itemId: string;
      subject: ReviewSubject;
      inFlight: RunningReviewRun | null;
      mayDecide: boolean;
    };

/**
 * ONE evaluation, under the caller's own workspace context: the item (a caller who may not
 * browse it gets the item's not-found), the subject, the review in flight and the authority.
 */
async function readSubject(identifier: string, ctx: ServiceContext): Promise<SubjectRead> {
  return withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
    const project = await projectRepository.findByIdentifier(
      ctx.workspaceId,
      projectKeyOf(identifier),
      tx,
    );
    const item = project
      ? await workItemRepository.findByIdentifier(project.id, identifier, tx)
      : null;
    if (!project || !item) throw new WorkItemNotFoundError(identifier);
    let held;
    try {
      held = await projectAccessService.getPermissions(item.projectId, ctx, tx);
    } catch (err) {
      /* v8 ignore next 3 -- the project was read a moment ago; only a delete in between, or a
         database fault, gets here */
      if (err instanceof ProjectNotFoundError) throw new WorkItemNotFoundError(identifier);
      throw err;
    }
    if (!held.has('project:browse')) throw new WorkItemNotFoundError(identifier);

    if (item.status !== IN_REVIEW_STATUS_KEY) return { kind: 'refused', reason: 'not_in_review' };
    const version = await ownDeliverySetVersion(item, ctx.workspaceId, tx);
    if (version === null) return { kind: 'refused', reason: 'no_pull_request' };

    let subject: ReviewSubject;
    let inFlight: RunningReviewRun | null;
    if (project.reviewAgentEnabled) {
      const gate = await approvalGateRepository.findLatestByWorkItem(item.id, 'agent_review', tx);
      if (!gate || gate.state !== 'awaiting' || gate.subjectVersion !== version) {
        return { kind: 'refused', reason: 'gate_not_awaiting' };
      }
      subject = { gateId: gate.id, subjectVersion: version };
      const [first] = await dispatchRunRepository.listRunningByIdempotencyKeyPrefix(
        ctx.workspaceId,
        reviewRunKeyPrefix(gate.id),
        tx,
      );
      inFlight = first ? await runningReview(first.id, tx) : null;
    } else {
      subject = { gateId: null, subjectVersion: version };
      inFlight = await dispatchRunRepository.findRunningReviewByWorkItem(item.id, tx);
    }

    const mayDecide =
      held.has('work_item:edit') &&
      (!project.reviewAgentEnabled || (await resolveGateAuthority(item, ctx, tx, held)) !== null);
    return { kind: 'subject', itemId: item.id, subject, inFlight, mayDecide };
  });
}

/** A running run read back by id, in the shape the in-flight read answers. */
async function runningReview(
  runId: string,
  tx: Parameters<typeof dispatchRunRepository.findById>[1],
): Promise<RunningReviewRun | null> {
  const run = await dispatchRunRepository.findById(runId, tx);
  /* v8 ignore next -- the run was listed as running a moment ago in this transaction */
  if (!run) return null;
  return {
    id: run.id,
    agentInstanceId: run.agentInstanceId,
    projectId: run.projectId,
    command: run.command,
    startedAt: run.startedAt,
    createdById: run.createdById,
  };
}

function evaluate(read: SubjectRead): Evaluation {
  if (read.kind === 'refused') return { kind: 'refused', reason: read.reason, inFlight: null };
  if (read.inFlight)
    return { kind: 'refused', reason: 'review_in_flight', inFlight: read.inFlight };
  if (!read.mayDecide) return { kind: 'refused', reason: 'cannot_decide', inFlight: null };
  return { kind: 'reviewable', subject: read.subject };
}

const notOffered = (
  reason: ReviewInMyAgentNotOfferedReason,
  extra: Partial<Extract<ReviewInMyAgentDoorDto, { offered: false }>> = {},
): ReviewInMyAgentDoorDto => ({ offered: false, reason, run: null, refusal: null, ...extra });

/**
 * The agent the door offers: the one this viewer last used on the item while it is usable,
 * else their first usable agent; with none usable, the refusal of the agent the door would
 * have picked (the last-used one, else the first).
 */
async function chooseAgent(
  identifier: string,
  ctx: ServiceContext,
): Promise<
  | { kind: 'chosen'; agent: AgentForCardDto; lastUsed: boolean }
  | { kind: 'none' }
  | { kind: 'unusable'; agent: AgentForCardDto }
> {
  const [{ agents }, { lastRun }] = await Promise.all([
    agentInstanceRunService.listAgentsForCard(identifier, ctx),
    agentInstanceRunService.resumeTargetForCard(identifier, ctx),
  ]);
  if (agents.length === 0) return { kind: 'none' };
  const lastId = lastRun?.agentIsReaders ? (lastRun.agent?.id ?? null) : null;
  const last = lastId ? agents.find((a) => a.id === lastId) : undefined;
  const usable =
    (last && last.refusal === null ? last : undefined) ?? agents.find((a) => !a.refusal);
  if (usable) return { kind: 'chosen', agent: usable, lastUsed: usable === last };
  return { kind: 'unusable', agent: last ?? (agents[0] as AgentForCardDto) };
}

export const reviewInMyAgentService = {
  /** The door's state for one item (see the header). Opens nothing and writes nothing. */
  async readDoor(workItemKey: string, ctx: ServiceContext): Promise<ReviewInMyAgentDoorDto> {
    const identifier = workItemKey.trim().toUpperCase();
    const evaluation = evaluate(await readSubject(identifier, ctx));
    if (evaluation.kind === 'refused') {
      const run = evaluation.inFlight;
      if (!run?.agentInstanceId) return notOffered(evaluation.reason);
      // An own-agent review: its agent is named when it is one of the viewer's own.
      const { agents } = await agentInstanceRunService.listAgentsForCard(identifier, ctx);
      return notOffered(evaluation.reason, {
        run: {
          id: run.id,
          label: dispatchRunLabel(run.command, run.startedAt),
          startedAt: run.startedAt.toISOString(),
          agentName: agents.find((a) => a.id === run.agentInstanceId)?.name ?? null,
          byViewer: run.createdById === ctx.userId,
        },
      });
    }

    const choice = await chooseAgent(identifier, ctx);
    if (choice.kind === 'none') return notOffered('no_agent');
    if (choice.kind === 'unusable') {
      return notOffered('agent_unusable', { refusal: choice.agent.refusal });
    }
    const { id, name, profileId, profileName, state } = choice.agent;
    return {
      offered: true,
      agent: { id, name, profileId, profileName, state },
      lastUsedOnItem: choice.lastUsed,
      gateId: evaluation.subject.gateId,
      subjectVersion: evaluation.subject.subjectVersion,
    };
  },

  /**
   * START a review of the item in the viewer's agent `agentInstanceId`. The door's checks
   * are re-run here: a press the read would not offer throws
   * {@link ReviewInMyAgentNotOfferedError} with that reason and opens nothing. The agent's
   * own checks — its owner, project, state, sign-in, the one-run-per-agent rule — and the
   * readable repositories and the CI-credit gate are `agentInstanceRunService.start`'s, and
   * its errors pass through. A repeated `idempotencyKey` answers the run it opened first.
   */
  async start(
    workItemKey: string,
    input: { agentInstanceId: string; idempotencyKey?: string | undefined },
    ctx: ServiceContext,
  ): Promise<AgentRunStartedDto> {
    const identifier = workItemKey.trim().toUpperCase();
    const read = await readSubject(identifier, ctx);
    const startIn = (subject: ReviewSubject) =>
      agentInstanceRunService.start(
        {
          workItemKey: identifier,
          agentInstanceId: input.agentInstanceId,
          idempotencyKey: input.idempotencyKey,
          command: 'review',
          review: subject,
        },
        ctx,
      );

    // The same press again is answered with its run, even though that run is now the review
    // in flight the read would refuse a new press for.
    if (read.kind === 'subject' && input.idempotencyKey) {
      const key = reviewOwnAgentRunKey(read.itemId, read.subject, input.idempotencyKey);
      const already = await withWorkspaceContext(
        { userId: ctx.userId, workspaceId: ctx.workspaceId },
        (tx) => dispatchRunRepository.findByIdempotencyKey(ctx.workspaceId, key, tx),
      );
      if (already) return startIn(read.subject);
    }

    const evaluation = evaluate(read);
    if (evaluation.kind === 'refused') {
      throw new ReviewInMyAgentNotOfferedError(identifier, evaluation.reason);
    }
    return startIn(evaluation.subject);
  },
};

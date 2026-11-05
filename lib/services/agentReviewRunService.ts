import type { Prisma } from '@/generated/prisma/client';
import {
  ReviewGateNotFoundError,
  ReviewVerdictAnswerExistsError,
  ReviewRunTokenRequiredError,
  ReviewStaleError,
  ReviewVerdictAlreadySubmittedError,
  type ReviewStaleCause,
} from '@/lib/agentReview/errors';
import { membersOf } from '@/lib/approvalGates/memberVersion';
import {
  ApprovalGateAlreadyDecidedError,
  ApprovalGateNotFoundError,
  ApprovalGateStaleSubjectError,
  ApprovalGateSupersededError,
} from '@/lib/approvalGates/errors';
import {
  assembleReviewPrompt,
  type ReviewPullRequestForPrompt,
  type ReviewVerdict,
} from '@/lib/dispatch/reviewPromptTemplate';
import type {
  AgentReviewVerdictResultDto,
  ReviewPromptDto,
  ReviewPullRequestDto,
} from '@/lib/dto/agentReview';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { dispatchRunCardRepository } from '@/lib/repositories/dispatchRunCardRepository';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { reviewVerdictRecordRepository } from '@/lib/repositories/reviewVerdictRecordRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { DISPATCH_RUN_EVENT_LIMIT } from '@/lib/services/dispatchRunService';
import { reviewBotPostService } from '@/lib/services/reviewBotPostService';
import { reviewConventionsService } from '@/lib/services/reviewConventionsService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { readProject } from '@/lib/workspaces/tenantRead';

// THE REVIEW RUN's two doors into Motir (Story MOTIR-1626 · MOTIR-6821; ADR
// `docs/decisions/hosted-agent-run.md` §3's pointer and §8.2–§8.4, `approval-gates.md`
// §12.3–§12.5): the REVIEW PROMPT it reads, and the VERDICT it submits.
//
// ⚠️ BOTH ARE A REVIEW RUN'S OWN CREDENTIAL AND NOTHING ELSE. A run token cannot use the
// MCP (`lib/mcp/auth.ts`), so these are run-token REST routes — and they answer ONLY the
// token of a `command: review` run (`ReviewRunTokenRequiredError`, 403): not a person's PAT
// or device token, not a BUILD run's token. The card binding is the shared one — the run's
// legs and scope, `runTokenScopeService`, reached through `getWorkItemByIdentifier` — so a
// review run's token naming another card is `DISPATCH_RUN_TOKEN_OUT_OF_SCOPE` (403), the
// answer every run-token route gives.
//
// ⚠️ THE VERDICT DECIDES AS THE RUN'S ATTRIBUTED USER. The token is owned by the run's
// attributed user (§8.1: assignee → reporter → the workspace's stand-in manager), so
// `ctx.userId` IS that user and becomes `decidedById`; the authority column
// (`review_agent`) is what says a machine decided. The decide door still asserts the
// kind's FLOOR (`work_item:edit`) for that user, as it does for a synced decision's actor:
// an attributed user who has since lost edit on the project is refused
// (`PERMISSION_DENIED`, 403) and nothing is decided. The token's own grant
// (`HOSTED_RUN_TOKEN_GRANT`) already holds the key, so no grant widening was needed.

/** The data a `review_verdict` event carries — what the run concluded and what became of it. */
type VerdictOutcome = 'decided' | ReviewStaleCause;

interface ReviewRunRef {
  id: string;
  /** The model the run reviewed on — the verdict record's model. */
  model: string | null;
}

/** The token's run, when it is a REVIEW run — else the refusal. Nothing is read for a PAT. */
async function requireReviewRun(ctx: ServiceContext): Promise<ReviewRunRef> {
  const runId = ctx.tokenDispatchRunId;
  if (runId === undefined) throw new ReviewRunTokenRequiredError();
  const run = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx) => dispatchRunRepository.findById(runId, tx),
  );
  if (!run || run.command !== 'review') throw new ReviewRunTokenRequiredError();
  return { id: run.id, model: run.model };
}

function pullRequestUrl(repository: string, number: number): string {
  return `https://github.com/${repository}/pull/${number}`;
}

/**
 * Record a verdict on the RUN — the one `review_verdict` event (§12.5: *"recorded on the
 * review RUN … names the verdict and the version it was about"*). Under the run's row lock,
 * so two appends cannot allocate the same `seq`. On the card's LEG when the run holds one,
 * else run-scoped. A run already at the event ceiling records nothing: the ceiling is the
 * ingest's, and a verdict's outcome is already on the gate (decided) or moot (late).
 */
async function recordVerdict(
  run: ReviewRunRef,
  workItemId: string,
  data: {
    verdict: ReviewVerdict;
    subjectVersion: string;
    outcome: VerdictOutcome;
    gateId: string | null;
    summaryMd: string | null;
  },
  ctx: ServiceContext,
): Promise<void> {
  await withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
    await dispatchRunRepository.findTerminalStateForUpdate(run.id, tx);
    if ((await dispatchRunEventRepository.countByRun(run.id, tx)) >= DISPATCH_RUN_EVENT_LIMIT) {
      return;
    }
    const leg = await dispatchRunCardRepository.findByRunAndWorkItem(run.id, workItemId, tx);
    const seq = ((await dispatchRunEventRepository.maxSeq(run.id, tx)) ?? 0) + 1;
    await dispatchRunEventRepository.createMany(
      [
        {
          workspaceId: ctx.workspaceId,
          dispatchRunId: run.id,
          dispatchRunCardId: leg?.id ?? null,
          seq,
          kind: 'review_verdict',
          reportedBy: 'cli',
          data,
        },
      ],
      tx,
    );
  });
}

/**
 * The hosted verdict's REVIEW VERDICT RECORD (Story MOTIR-10327 · MOTIR-10333;
 * `approval-gates.md` §12.12–§12.13) — written after the decide commits, beside the run's
 * own event, so every agent verdict, hosted or from a person's own agent, has one record
 * the bot, the activity and the read model consume. A run's verdict is `decided`, or LATE
 * (a moved version, a withdrawn review) or SECOND (a review already decided). An
 * answering record already at the version (a gate-off verdict before the switch went on)
 * makes a `decided` one `second` instead, so the index's one-answer rule holds.
 */
async function recordVerdictRow(
  run: ReviewRunRef,
  item: { id: string; projectId: string },
  data: {
    verdict: ReviewVerdict;
    subjectVersion: string;
    outcome: 'decided' | 'late' | 'second';
    gateId: string | null;
    summaryMd: string | null;
    findingsMd: string | null;
  },
  ctx: ServiceContext,
): Promise<void> {
  const write = (outcome: 'decided' | 'late' | 'second') =>
    withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
      const record = await reviewVerdictRecordRepository.create(
        {
          workspaceId: ctx.workspaceId,
          projectId: item.projectId,
          workItemId: item.id,
          gateId: data.gateId,
          subjectVersion: data.subjectVersion,
          verdict: data.verdict,
          outcome,
          summaryMd: data.summaryMd,
          findingsMd: data.findingsMd,
          checklist: [],
          submittedById: ctx.userId,
          harness: HOSTED_REVIEW_HARNESS,
          model: run.model ?? 'unknown',
        },
        tx,
      );
      // A decided verdict is posted on the pull requests once this commits (MOTIR-10335);
      // a late or second one is history and is never posted.
      if (outcome === 'decided') {
        reviewBotPostService.requestPostAfterCommit(ctx.workspaceId, record.id);
      }
    });
  try {
    await write(data.outcome);
  } catch (err) {
    /* v8 ignore next 2 -- needs a gate-off record at the very version a review was then
       raised over and decided by this run. */
    if (data.outcome === 'decided' && err instanceof ReviewVerdictAnswerExistsError) {
      await write('second');
      return;
    }
    throw err;
  }
}

/** The harness a hosted review run's verdict record names — the hosted agent itself. */
const HOSTED_REVIEW_HARNESS = 'Motir hosted review';

async function hasVerdict(run: ReviewRunRef, ctx: ServiceContext): Promise<boolean> {
  const prior = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx: Prisma.TransactionClient) =>
      dispatchRunEventRepository.findLatestOfKind(run.id, 'review_verdict', tx),
  );
  return prior !== null;
}

/** A decide-door refusal that makes a verdict LATE, or null for any other error. */
function staleCauseOf(err: unknown): ReviewStaleCause | null {
  if (err instanceof ApprovalGateSupersededError) return 'superseded';
  if (err instanceof ApprovalGateAlreadyDecidedError) return 'already_decided';
  if (err instanceof ApprovalGateStaleSubjectError) return 'stale_version';
  return null;
}

export const agentReviewRunService = {
  /**
   * THE REVIEW PROMPT (§8.2) — the card's two bodies, its acceptance criteria, its
   * published How to test, and every pull request of the delivery set at the REVIEWED
   * head: the one the card's `agent_review` gate names (the awaiting one, else the latest),
   * never a head read now. A READ: nothing is written.
   */
  async getReviewPrompt(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
  ): Promise<ReviewPromptDto> {
    await requireReviewRun(ctx);
    const project = await readProject(projectId, ctx);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    // The card binding — the run's own cards only (`runTokenScopeService`).
    const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);

    const { gate, deliveries } = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const found = await approvalGateRepository.findLatestByWorkItem(
          item.id,
          'agent_review',
          tx,
        );
        return {
          gate: found,
          deliveries: found
            ? await workItemDeliveryRepository.listByWorkItemWithChecks(found.subjectId, tx)
            : [],
        };
      },
    );
    if (!gate?.subjectVersion) throw new ReviewGateNotFoundError(item.identifier);

    const howToTest = await testInstructionsService.getCurrentByIdentifier(
      projectId,
      identifier,
      ctx,
    );

    // Each member AS THE GATE NAMES IT — repository, number and the reviewed head — with
    // the branch names Motir holds for that pull request beside it.
    const pullRequests: ReviewPullRequestForPrompt[] = membersOf(gate.subjectVersion).map(
      (member) => {
        const row = deliveries.find(
          (d) =>
            `${d.repo.owner}/${d.repo.name}` === member.repo &&
            d.pullRequest.number === member.number,
        );
        return {
          repository: member.repo,
          number: member.number,
          headSha: member.headSha,
          baseBranch: row?.pullRequest.baseRef ?? null,
          headBranch: row?.pullRequest.headRef ?? null,
          title: row?.pullRequest.title ?? null,
          url: pullRequestUrl(member.repo, member.number),
        };
      },
    );

    // Each distinct repository's coding convention (MOTIR-6904, §8.5) — read over the
    // service credential, concurrently; an absent one is reviewed against the card alone
    // and never refuses the prompt.
    const conventions = await reviewConventionsService.resolveReviewConventions(
      { workspaceId: ctx.workspaceId, projectId },
      pullRequests.map((pr) => pr.repository),
    );

    const { prompt } = assembleReviewPrompt({
      key: item.identifier,
      title: item.title,
      projectName: project.name,
      descriptionMd: item.descriptionMd,
      explanationMd: item.explanationMd,
      howToTestMd: howToTest.record?.bodyMd ?? null,
      subjectVersion: gate.subjectVersion,
      pullRequests,
      conventions,
    });

    return {
      key: item.identifier,
      gateId: gate.id,
      subjectVersion: gate.subjectVersion,
      pullRequests: pullRequests.map(
        (pr): ReviewPullRequestDto => ({
          repository: pr.repository,
          number: pr.number,
          headSha: pr.headSha,
          baseBranch: pr.baseBranch,
          headBranch: pr.headBranch,
          url: pr.url,
        }),
      ),
      prompt,
    };
  },

  /**
   * THE VERDICT (§8.4; `approval-gates.md` §12.3–§12.5) — decides the card's
   * `agent_review` gate as `review_agent` through `approvalGatesService.decideAgentReview`:
   * `pass` → `approved` (the door raises the approve-and-merge gate for the SAME version),
   * `changes_requested` → the findings are the gate's note, verbatim, and nothing moves.
   *
   * - ONE verdict per run: a run that has already submitted one — accepted or late — is
   *   refused (`ReviewVerdictAlreadySubmittedError`, 409) and nothing is recorded.
   * - A LATE verdict — a version that is not the gate's, a set that moved, a gate already
   *   superseded or decided — is RECORDED on the run (a `review_verdict` event naming the
   *   verdict, the version and why it was late) and decides nothing (`ReviewStaleError`,
   *   409 `REVIEW_STALE`).
   * - An accepted verdict is recorded on the run too, AFTER the decide commits (the door
   *   owns its own transaction). If that append failed, the gate is still decided; a retry
   *   then finds the gate decided and is recorded late — the gate row is the truth.
   *
   * The summary (≤ 500 characters) has no column on the gate (the record, §8.4, names
   * findings only): it rides the run's event, and becomes the gate's note on a `pass` that
   * carries no findings, so a pass is never recorded with nothing said.
   */
  async submitVerdict(
    projectId: string,
    identifier: string,
    input: {
      subjectVersion: string;
      verdict: ReviewVerdict;
      summaryMd?: string | null;
      findingsMd?: string | null;
    },
    ctx: ServiceContext,
  ): Promise<AgentReviewVerdictResultDto> {
    const run = await requireReviewRun(ctx);
    const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);
    if (await hasVerdict(run, ctx)) throw new ReviewVerdictAlreadySubmittedError(run.id);

    const summaryMd = input.summaryMd?.trim() ? input.summaryMd.trim() : null;
    const findingsMd = input.findingsMd?.trim() ? input.findingsMd : null;
    const noteMd = findingsMd ?? summaryMd;
    const record = (outcome: VerdictOutcome, gateId: string | null) =>
      recordVerdict(
        run,
        item.id,
        {
          verdict: input.verdict,
          subjectVersion: input.subjectVersion,
          outcome,
          gateId,
          summaryMd,
        },
        ctx,
      );

    let decided;
    try {
      decided = await approvalGatesService.decideAgentReview(
        {
          workItemId: item.id,
          subjectVersion: input.subjectVersion,
          verdict: input.verdict,
          noteMd,
        },
        ctx,
      );
    } catch (err) {
      const cause = staleCauseOf(err);
      if (cause) {
        const gate = await withWorkspaceContext(
          { userId: ctx.userId, workspaceId: ctx.workspaceId },
          (tx) => approvalGateRepository.findLatestByWorkItem(item.id, 'agent_review', tx),
        );
        await record(cause, gate?.id ?? null);
        await recordVerdictRow(
          run,
          item,
          {
            verdict: input.verdict,
            subjectVersion: input.subjectVersion,
            outcome: cause === 'already_decided' ? 'second' : 'late',
            gateId: gate?.id ?? null,
            summaryMd,
            findingsMd,
          },
          ctx,
        );
        throw new ReviewStaleError(cause, input.subjectVersion);
      }
      if (err instanceof ApprovalGateNotFoundError) {
        throw new ReviewGateNotFoundError(item.identifier);
      }
      throw err;
    }

    await record('decided', decided.gate.id);
    await recordVerdictRow(
      run,
      item,
      {
        verdict: input.verdict,
        subjectVersion: input.subjectVersion,
        outcome: 'decided',
        gateId: decided.gate.id,
        summaryMd,
        findingsMd,
      },
      ctx,
    );
    return {
      key: item.identifier,
      gateId: decided.gate.id,
      verdict: input.verdict,
      state: input.verdict === 'pass' ? 'approved' : 'changes_requested',
      subjectVersion: decided.gate.subjectVersion ?? input.subjectVersion,
      decidedAt: decided.gate.decidedAt ?? new Date().toISOString(),
    };
  },
};

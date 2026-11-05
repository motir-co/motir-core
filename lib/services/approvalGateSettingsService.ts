import { withWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { reviewBotPostRepository } from '@/lib/repositories/reviewBotPostRepository';
import { reviewBotPostService } from '@/lib/services/reviewBotPostService';
import { reconcileGatesFor } from '@/lib/services/gateSetFor';
import { agentReviewStartService } from '@/lib/services/agentReviewStartService';
import { evaluateAfterRaise } from '@/lib/services/pullRequestReviewSync';
import { projectAccessService } from '@/lib/services/projectAccessService';
import {
  InvalidReviewAgentSourceError,
  ProjectNotFoundError,
  ReviewAgentNeedsManualMergeError,
} from '@/lib/projects/errors';
import {
  REVIEW_AGENT_SOURCES,
  type ApprovalGateSettingsDTO,
  type ReviewAgentSourceValue,
  type UpdateApprovalGateSettingsInput,
} from '@/lib/dto/approvalGateSettings';
import { reviewSourceKey } from '@/lib/agentReview/reviewRunKey';
import type { AgentReviewRequestedData } from '@/lib/jobs/types';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { deferUntilCommit } from '@/lib/workspaces/afterCommit';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { Prisma } from '@/generated/prisma/client';

/**
 * The project's APPROVAL-GATE switches (Story MOTIR-4925 · Subtask MOTIR-5170) —
 * which gates `Project settings ▸ Approvals` raises. Read by that room; written
 * by `PATCH /api/projects/[key]/approval-gates`.
 *
 * ⚠️ THIS SERVICE DOES NOT DECIDE ELIGIBILITY, AND MUST NOT LEARN TO.
 * `acceptanceVideoEligibilityService` is the ONE place the feature's verdict is
 * computed — `hasPaidAiPlan` (the organisation's) AND this switch (the
 * project's). This service owns the SETTING: reading it for the room and writing
 * it when an admin flips it. A second computation of the AND here is exactly the
 * divergence that service's header exists to prevent, and it would be invisible:
 * both would return a boolean and only one would be right.
 *
 * ⚠️ AND THE WRITE AUTHORITY IS THE DESTINATION'S, NOT THE ORIGIN'S
 * (`docs/decisions/organization-tier.md` §6). The switch used to be an org
 * column written behind `assertOrgAdmin`; moving the surface does not carry that
 * gate along with it. The key here is **`workflow:manage`** — the shipped key for
 * *may you configure how work moves through this project* — because a status
 * graph and an approval gate are the two things that decide when work may move.
 * A dedicated `gate:manage` is a reasonable later split and is deliberately NOT
 * made here: this card has no warrant to add a permission to the catalog.
 */
/** The room's switches, read off the project row — one mapping for every return. */
function toSettingsDTO(project: {
  acceptanceVideoEnabled: boolean;
  reviewAgentEnabled: boolean;
  designApprovalGate: boolean;
  reviewAgentSource: ReviewAgentSourceValue;
  reviewBotPostsEnabled: boolean;
}): ApprovalGateSettingsDTO {
  return {
    acceptanceVideoEnabled: project.acceptanceVideoEnabled,
    reviewAgentEnabled: project.reviewAgentEnabled,
    designApprovalGate: project.designApprovalGate,
    reviewAgentSource: project.reviewAgentSource,
    reviewBotPostsEnabled: project.reviewBotPostsEnabled,
  };
}

/**
 * SWITCHING THE REVIEW SOURCE with the agent on (Story MOTIR-10327 · MOTIR-10332;
 * `approval-gates.md` §12.10) — in the switch's own transaction, after the write, under
 * the same gate lock the switch-off takes. The gates themselves are never superseded or
 * re-raised: their question (review this version) has not changed, only who answers it.
 *
 * - `hosted` → `own`: the in-flight hosted run of every awaiting `agent_review` is
 *   cancelled once this transaction commits, and each gate's could-not-run reason is
 *   cleared (§12.6 is hosted-only). Each gate stays awaiting at its version.
 * - `own` → `hosted`: ONE start request per awaiting gate is emitted after commit, under a
 *   FRESH key, so a gate whose raise run an earlier switch cancelled starts again rather
 *   than reading as already started.
 */
async function switchAwaitingReviewSource(
  project: { id: string; workspaceId: string },
  to: ReviewAgentSourceValue,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const awaiting = await approvalGateRepository.lockAwaitingByProjectAndKind(
    project.id,
    'agent_review',
    tx,
  );
  if (awaiting.length === 0) return;
  if (to === 'own') {
    agentReviewStartService.cancelRunsAfterCommit(
      project.workspaceId,
      awaiting.map((gate) => gate.id),
    );
    for (const gate of awaiting) {
      await approvalGateRepository.setReviewUnavailableReason(gate.id, null, tx);
    }
    return;
  }
  for (const locked of awaiting) {
    const gate = await approvalGateRepository.findById(locked.id, tx);
    // An agent_review gate is raised only on a card at a named set version.
    /* v8 ignore next */
    if (!gate?.workItemId || gate.subjectVersion === null) continue;
    const request: AgentReviewRequestedData = {
      workspaceId: project.workspaceId,
      gateId: gate.id,
      workItemId: gate.workItemId,
      subjectVersion: gate.subjectVersion,
      idempotencyKey: reviewSourceKey(gate.id),
    };
    deferUntilCommit(() => sendEvent('agent-review/requested', request));
  }
}

/** The patch's keys that are present, validated — only these are written. */
function patchToWrite(patch: UpdateApprovalGateSettingsInput): UpdateApprovalGateSettingsInput {
  const data: UpdateApprovalGateSettingsInput = {};
  if (patch.acceptanceVideoEnabled !== undefined) {
    data.acceptanceVideoEnabled = patch.acceptanceVideoEnabled;
  }
  if (patch.reviewAgentEnabled !== undefined) data.reviewAgentEnabled = patch.reviewAgentEnabled;
  // The design switch is read at RAISE time (MOTIR-697), so writing it never decides
  // a gate already waiting (§2f).
  if (patch.designApprovalGate !== undefined) data.designApprovalGate = patch.designApprovalGate;
  if (patch.reviewAgentSource !== undefined) {
    if (!(REVIEW_AGENT_SOURCES as readonly unknown[]).includes(patch.reviewAgentSource)) {
      throw new InvalidReviewAgentSourceError(patch.reviewAgentSource);
    }
    data.reviewAgentSource = patch.reviewAgentSource;
  }
  if (patch.reviewBotPostsEnabled !== undefined) {
    data.reviewBotPostsEnabled = patch.reviewBotPostsEnabled;
  }
  return data;
}

/**
 * SWITCHING THE REVIEW AGENT OFF (Story MOTIR-1626 · MOTIR-6819; `approval-gates.md` §12.5)
 * — in the switch's own transaction, after the write: every AWAITING `agent_review` in the
 * project is superseded `review_agent_disabled`, and each such card is reconciled so the
 * ordinary flow is raised for its current version at once (the approve-and-merge gate,
 * when its set is green). A DECIDED review is history and stays.
 *
 * ⚠️ LOCK ORDER — the gates, then each card: the order a transition and the decide door
 * take them in. `reconcileGatesFor` relies on its caller holding the card's row lock.
 *
 * The review RUN in flight for each retired gate is CANCELLED once this transaction
 * commits (§12.5, *"reviews in progress are cancelled"*; MOTIR-6820).
 */
async function retireAwaitingReviews(
  projectId: string,
  tx: Prisma.TransactionClient,
): Promise<string[]> {
  const awaiting = await approvalGateRepository.lockAwaitingByProjectAndKind(
    projectId,
    'agent_review',
    tx,
  );
  const cards = [
    ...new Set(awaiting.flatMap((gate) => (gate.workItemId ? [gate.workItemId] : []))),
  ];
  const first = awaiting[0];
  if (first) {
    const project = await projectRepository.findById(projectId, tx);
    if (project) {
      agentReviewStartService.cancelRunsAfterCommit(
        project.workspaceId,
        awaiting.map((gate) => gate.id),
      );
    }
  }
  for (const workItemId of cards) {
    await workItemRepository.lockById(workItemId, tx);
    await approvalGateRepository.supersedeAwaitingByWorkItem(
      workItemId,
      'agent_review',
      'review_agent_disabled',
      tx,
    );
    const item = await workItemRepository.findById(workItemId, tx);
    if (item) await reconcileGatesFor(item, tx);
  }
  return cards;
}

export const approvalGateSettingsService = {
  /**
   * The room's read. Resolution runs under `withSystemContext` and the ACCESS
   * decision is the permission assert below it — the same order
   * `boardsService.ensureDefaultBoard` uses, and for the same reason: a
   * tenant-bound read would answer "may this actor SEE the project?", which is a
   * different question from "may this actor configure it?", and would make a
   * missing row and a denied row indistinguishable.
   *
   * ⚠️ MANAGE-ONLY: the READ takes the WRITE's key (2026-09-13 ·
   * `design/projects/design-notes.md` § ⭐ Approvals §6 · MOTIR-5394). MOTIR-5278
   * had opened this read on `project:browse` for a read-only member view. That
   * view is withdrawn, so nobody below `workflow:manage` has a reason to read.
   */
  async getSettings(projectId: string, ctx: ServiceContext): Promise<ApprovalGateSettingsDTO> {
    await projectAccessService.assertPermission(projectId, ctx, 'workflow:manage');

    const project = await withSystemContext((tx) => projectRepository.findById(projectId, tx));
    if (!project) throw new ProjectNotFoundError(projectId);

    return toSettingsDTO(project);
  },

  /**
   * Flip one or more of this project's gate switches. Re-gated here rather than
   * trusting the page's own guard: hiding a rail row is presentation, and the
   * route behind it is one typed URL away (`_guard.tsx`'s own header).
   */
  async updateSettings(
    projectId: string,
    patch: UpdateApprovalGateSettingsInput,
    ctx: ServiceContext,
  ): Promise<ApprovalGateSettingsDTO> {
    await projectAccessService.assertPermission(projectId, ctx, 'workflow:manage');

    // An empty patch is a no-op READ rather than an error: the route forwards only
    // the keys the body carried, and a caller sending none has asked for nothing.
    // Returning the current state keeps the client's reconcile honest either way.
    // Only the switches the patch carries are written, so a PATCH naming one switch
    // leaves every other exactly as it was.
    const data = patchToWrite(patch);
    if (Object.keys(data).length === 0) {
      const project = await withSystemContext((tx) => projectRepository.findById(projectId, tx));
      if (!project) throw new ProjectNotFoundError(projectId);
      return toSettingsDTO(project);
    }

    // ⚠️ ONLY THE KEYS THE BODY CARRIED. The design switch is read at RAISE time
    // (MOTIR-697), so writing it never decides a gate already waiting — flipping it
    // off leaves an in-progress review to its reviewer, and flipping it back on
    // affects only gates raised afterwards (§2f).
    const updated = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        // ⚠️ THE REVIEW AGENT NEEDS A PROJECT THAT ASKS BEFORE MERGING (§12.2a). The
        // merge mode is read under the project's row lock — the lock the merge-mode
        // write takes too — so the two switches cannot be turned into the forbidden
        // pair by two admins at once.
        if (data.reviewAgentEnabled === true) {
          await projectRepository.lockById(projectId, tx);
          const mode = await projectRepository.findPrMergeMode(projectId, tx);
          if (!mode) throw new ProjectNotFoundError(projectId);
          if (mode.prMergeMode === 'auto') throw new ReviewAgentNeedsManualMergeError(projectId);
        }
        // The source as it stood, read under the project's row lock so two admins
        // switching it at once cannot both see the old value and both act on it.
        let before: {
          reviewAgentEnabled: boolean;
          reviewAgentSource: ReviewAgentSourceValue;
        } | null = null;
        if (data.reviewAgentSource !== undefined) {
          await projectRepository.lockById(projectId, tx);
          before = await projectRepository.findMergeSettings(projectId, tx);
          if (!before) throw new ProjectNotFoundError(projectId);
        }
        const project = await projectRepository.updateApprovalGateSettings(projectId, data, tx);
        const retired =
          data.reviewAgentEnabled === false ? await retireAwaitingReviews(projectId, tx) : [];
        // POSTING TURNED OFF (MOTIR-10335, rule 8): the bot's standing Request changes on
        // every card would otherwise go on blocking Motir's own merge. Each card is
        // reconciled once this commits.
        if (data.reviewBotPostsEnabled === false) {
          reviewBotPostService.requestReconcileAfterCommit(
            project.workspaceId,
            await reviewBotPostRepository.listWorkItemIdsWithLiveRequestChanges(projectId, tx),
          );
        }
        // A source change acts on awaiting reviews only while the agent was on and
        // stays on: a disable just retired them, and an enable has none yet.
        if (
          before &&
          before.reviewAgentEnabled &&
          project.reviewAgentEnabled &&
          before.reviewAgentSource !== project.reviewAgentSource
        ) {
          await switchAwaitingReviewSource(project, project.reviewAgentSource, tx);
        }
        return { project, retired };
      },
    );
    // POST-COMMIT and best-effort (MOTIR-5597, decision 8), as the promotion does: a GitHub
    // approval recorded while the agent was reviewing applies to the approve-and-merge
    // gate the switch just raised in its place (§12.2).
    for (const workItemId of updated.retired) await evaluateAfterRaise(workItemId, ctx.workspaceId);

    return toSettingsDTO(updated.project);
  },
};

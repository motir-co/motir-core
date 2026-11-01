import { reviewRunKeyPrefix } from '@/lib/agentReview/reviewRunKey';
import type { AgentReviewViewDto } from '@/lib/dto/agentReview';
import { dispatchRunLabel } from '@/lib/howToTest/author';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { resolveMarkdownWorkItemRefs } from '@/lib/workItems/resolveWorkItemRefs';

// THE AGENT REVIEW, as the item page's Development block reads it (Story MOTIR-1626 ·
// MOTIR-6825; `design/github/design-notes.md` § 30, `approval-gates.md` §12).
//
// ONE read per page, made beside the other gate reads of the late stack (`lateReads.ts`):
// the card's LATEST `agent_review` gate through the gate read every frame uses — so the
// authority answer (`canDecide`) is the decide door's own `resolveGateAuthority`, and a
// verb the frame draws is one the door accepts — plus the two facts that read does not
// carry: the could-not-run reason written on the row (§12.6), and the review run the
// band links, found by the key prefix every review run of the gate is opened under
// (`lib/agentReview/reviewRunKey.ts`).
//
// ⚠️ THE FINDINGS ARE THE GATE'S NOTE. The verdict records them verbatim as `noteMd`
// (`agentReviewRunService.submitVerdict`), and a person's *Continue without the review*
// records its reason there too; `decidedUnderAuthority` is what tells the two apart.

export const agentReviewViewService = {
  /** The card's latest `agent_review`, or null when it never had one. */
  async readForWorkItem(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<AgentReviewViewDto | null> {
    const read = await approvalGatesService.getForWorkItem(
      { workItemId, kind: 'agent_review' },
      ctx,
    );
    const gate = read.gate;
    if (!gate) return null;
    const { row, run } = await withWorkspaceContext(ctx, async (tx) => ({
      row: await approvalGateRepository.findById(gate.id, tx),
      run: await dispatchRunRepository.findLatestByIdempotencyKeyPrefix(
        ctx.workspaceId,
        reviewRunKeyPrefix(gate.id),
        tx,
      ),
    }));
    const findingsRefs = gate.noteMd ? await resolveMarkdownWorkItemRefs(gate.noteMd, ctx) : {};
    return {
      gate,
      canDecide: read.canDecide,
      routedToLabel: read.routedToLabel,
      stamp: read.stamp,
      // Only an AWAITING gate's reason is live: a decided or withdrawn row's is history.
      reviewUnavailableReason:
        gate.state === 'awaiting' ? (row?.reviewUnavailableReason ?? null) : null,
      run: run
        ? {
            id: run.id,
            label: dispatchRunLabel(run.command, run.startedAt),
            startedAt: run.startedAt.toISOString(),
          }
        : null,
      settingsDoorHref: read.settingsDoor?.href ?? null,
      findingsRefs,
    };
  },
};

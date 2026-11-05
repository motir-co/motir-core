import type { ApprovalGate, ReviewVerdictRecord } from '@/generated/prisma/client';
import { reviewChecklistRowsOf } from '@/lib/agentReview/checklist';
import { ReviewFindingsNotFoundError } from '@/lib/agentReview/errors';
import { reviewerOfRecord } from '@/lib/agentReview/reviewState';
import { membersOf } from '@/lib/approvalGates/memberVersion';
import type { ReviewFindingsDto, ReviewFindingsRefDto } from '@/lib/dto/agentReview';
import type { WorkItemDto } from '@/lib/dto/workItems';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { reviewVerdictRecordRepository } from '@/lib/repositories/reviewVerdictRecordRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { resolveMarkdownWorkItemRefs } from '@/lib/workItems/resolveWorkItemRefs';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// ONE REVIEW'S FINDINGS AND CHECKLIST (MOTIR-10460; `design/workbench/design-notes.md`
// § 42.1 *What it reads*) — the read behind the in-place view *Findings and checklist*
// opens over the Workbench.
//
// The link names the review by the ref the review state handed it (`recordRef`, or
// `lastReviewedRef` for *Last reviewed at an earlier commit*):
//   · a RECORD — the verdict record whole: its findings (not the activity trail's capped
//     excerpt), its stored checklist rows, who submitted it with which harness and model;
//   · a GATE — a pass decided on the `agent_review` gate before records existed. Its note
//     is the findings, the hosted run reviewed it, and there is no checklist.
//
// ⚠️ THE CARD IS THE GATE. The card is read through `getWorkItemByIdentifier` — the
// workspace binding and the project's browse check every card read takes — and the review
// must then be ONE OF THAT CARD'S: a record or gate of another card, or one RLS hides in
// another workspace, is the same not-found an unknown id is, so the read names nothing.
// ⚠️ READ-ONLY. It decides nothing and writes nothing.

function commitsOf(subjectVersion: string | null): ReviewFindingsDto['commits'] {
  return membersOf(subjectVersion).map((m) => ({
    repo: m.repo,
    number: m.number,
    headSha: m.headSha,
  }));
}

function verdictOfGate(gate: ApprovalGate): ReviewFindingsDto['verdict'] | null {
  if (gate.state === 'approved') return 'pass';
  if (gate.state === 'changes_requested') return 'changes_requested';
  return null;
}

/** The view's answer for a verdict record, its submitter's name already resolved. */
function fromRecord(
  item: WorkItemDto,
  record: ReviewVerdictRecord,
  submittedByName: string | null,
): Omit<ReviewFindingsDto, 'findingsRefs'> {
  const reviewer = reviewerOfRecord({ ...record, submittedByName });
  return {
    identifier: item.identifier,
    title: item.title,
    ref: { kind: 'record', id: record.id },
    verdict: record.verdict === 'pass' ? 'pass' : 'changes_requested',
    reviewer:
      reviewer.kind === 'hosted'
        ? reviewer
        : {
            kind: 'own',
            name: reviewer.person?.name ?? null,
            harness: reviewer.harness,
            model: reviewer.model,
          },
    at: record.createdAt.toISOString(),
    subjectVersion: record.subjectVersion,
    commits: commitsOf(record.subjectVersion),
    findingsMd: record.findingsMd?.trim() ? record.findingsMd : null,
    checklist: reviewChecklistRowsOf(record.checklist),
  };
}

/** The view's answer for a gate-only pass, or null when the gate is no decided review. */
function fromGate(
  item: WorkItemDto,
  gate: ApprovalGate,
): Omit<ReviewFindingsDto, 'findingsRefs'> | null {
  const verdict = verdictOfGate(gate);
  if (gate.kind !== 'agent_review' || verdict === null) return null;
  return {
    identifier: item.identifier,
    title: item.title,
    ref: { kind: 'gate', id: gate.id },
    verdict,
    reviewer: { kind: 'hosted', model: null },
    at: (gate.decidedAt ?? gate.createdAt).toISOString(),
    subjectVersion: gate.subjectVersion,
    commits: commitsOf(gate.subjectVersion),
    findingsMd: gate.noteMd?.trim() ? gate.noteMd : null,
    checklist: [],
  };
}

export const reviewFindingsService = {
  /**
   * The review `ref` names on the card `identifier`. Throws `ProjectNotFoundError` /
   * `WorkItemNotFoundError` / `ProjectAccessDeniedError` for a card the reader cannot see,
   * and {@link ReviewFindingsNotFoundError} for a review that is not that card's.
   */
  async read(
    projectId: string,
    identifier: string,
    ref: ReviewFindingsRefDto,
    ctx: ServiceContext,
  ): Promise<ReviewFindingsDto> {
    const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);
    const found = await withWorkspaceContext(ctx, async (tx) => {
      if (ref.kind === 'gate') {
        const gate = await approvalGateRepository.findById(ref.id, tx);
        return gate && gate.workItemId === item.id && gate.workspaceId === ctx.workspaceId
          ? fromGate(item, gate)
          : null;
      }
      const record = await reviewVerdictRecordRepository.findById(ref.id, tx);
      if (!record || record.workItemId !== item.id || record.workspaceId !== ctx.workspaceId) {
        return null;
      }
      const [submitter] = record.submittedById
        ? await userRepository.findByIds([record.submittedById], tx)
        : [];
      return fromRecord(item, record, submitter?.name ?? null);
    });
    if (!found) throw new ReviewFindingsNotFoundError(item.identifier);
    const findingsRefs = found.findingsMd
      ? await resolveMarkdownWorkItemRefs(found.findingsMd, ctx)
      : {};
    return { ...found, findingsRefs };
  },
};

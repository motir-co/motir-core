import { z } from 'zod/v4';
import {
  REVIEW_FINDINGS_MAX_LENGTH,
  REVIEW_SUMMARY_MAX_LENGTH,
} from '@/lib/dispatch/reviewPromptTemplate';
import {
  REVIEW_CHECKLIST_MAX_ROWS,
  REVIEW_CHECKLIST_STATUSES,
  REVIEW_DOOR_VERDICTS,
  REVIEW_SUBMITTER_FIELD_MAX_LENGTH,
  type ReviewVerdictResultDto,
  type SubmitReviewVerdictInput,
} from '@/lib/dto/agentReview';

// The USER-TOKEN VERDICT DOOR's wire shapes (Story MOTIR-10327 · MOTIR-10333;
// `approval-gates.md` §12.11) — `POST /api/v1/work-items/{key}/review-verdict`. Their own
// module, in the style of `./agentReview.ts` beside it; the MCP tool
// `submit_review_verdict` declares the same fields.

/** The longest checklist criterion or evidence line kept. */
export const REVIEW_CHECKLIST_TEXT_MAX_LENGTH = 4_000;

/** One acceptance criterion's result. `evidence` is required on `met`. */
export const reviewChecklistRowSchema = z
  .object({
    /** The card the criterion belongs to — the run target or a descendant. */
    key: z.string().trim().min(1).max(64).nullable().optional(),
    criterion: z.string().trim().min(1).max(REVIEW_CHECKLIST_TEXT_MAX_LENGTH),
    status: z.enum(REVIEW_CHECKLIST_STATUSES),
    evidence: z.string().max(REVIEW_CHECKLIST_TEXT_MAX_LENGTH).nullable().optional(),
  })
  .strict();

export const reviewVerdictBodySchema = z
  .object({
    /** `approved` or `changes_requested`. */
    verdict: z.enum(REVIEW_DOOR_VERDICTS),
    /** The delivery-set version reviewed — `owner/name#number@headSha`, sorted, comma-joined. */
    subjectVersion: z.string().trim().min(1),
    /** What the reviewer concluded, in a line or two. */
    summaryMd: z.string().max(REVIEW_SUMMARY_MAX_LENGTH).nullable().optional(),
    /** The findings, Markdown — required and non-empty on `changes_requested`. */
    findingsMd: z.string().max(REVIEW_FINDINGS_MAX_LENGTH).nullable().optional(),
    checklist: z.array(reviewChecklistRowSchema).max(REVIEW_CHECKLIST_MAX_ROWS).default([]),
    /** The harness the review ran in, e.g. `Claude Code`. */
    harness: z.string().trim().min(1).max(REVIEW_SUBMITTER_FIELD_MAX_LENGTH),
    /** The model the review ran on. */
    model: z.string().trim().min(1).max(REVIEW_SUBMITTER_FIELD_MAX_LENGTH),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.verdict === 'changes_requested' && !body.findingsMd?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['findingsMd'],
        message: '`findingsMd` is required, and must not be empty, on `changes_requested`',
      });
    }
    body.checklist.forEach((row, i) => {
      if (row.status === 'met' && !row.evidence?.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['checklist', i, 'evidence'],
          message: '`evidence` is required on a `met` row',
        });
      }
    });
  });
export type V1ReviewVerdictBody = z.infer<typeof reviewVerdictBodySchema>;

/** The body, as the service takes it. */
export function toSubmitReviewVerdictInput(body: V1ReviewVerdictBody): SubmitReviewVerdictInput {
  return {
    verdict: body.verdict,
    subjectVersion: body.subjectVersion,
    summaryMd: body.summaryMd ?? null,
    findingsMd: body.findingsMd ?? null,
    checklist: body.checklist.map((row) => ({
      key: row.key ?? null,
      criterion: row.criterion,
      status: row.status,
      evidence: row.evidence ?? null,
    })),
    harness: body.harness,
    model: body.model,
  };
}

/** What an ACCEPTED verdict did. */
export const reviewVerdictResultSchema = z.object({
  key: z.string(),
  recordId: z.string(),
  /** `decided` — it decided the awaiting review gate; `recorded` — the gate was off. */
  outcome: z.enum(['decided', 'recorded']),
  verdict: z.enum(REVIEW_DOOR_VERDICTS),
  subjectVersion: z.string(),
  gateId: z.string().nullable(),
  /** The approve-and-merge gates a send-back withdrew (`agent_changes_requested`). */
  withdrewApprovalGateIds: z.array(z.string()),
  submittedAt: z.string().datetime(),
});
export type V1ReviewVerdictResult = z.infer<typeof reviewVerdictResultSchema>;

export function presentReviewVerdictResult(dto: ReviewVerdictResultDto): V1ReviewVerdictResult {
  return {
    key: dto.key,
    recordId: dto.recordId,
    outcome: dto.outcome,
    verdict: dto.verdict,
    subjectVersion: dto.subjectVersion,
    gateId: dto.gateId,
    withdrewApprovalGateIds: [...dto.withdrewApprovalGateIds],
    submittedAt: dto.submittedAt,
  };
}

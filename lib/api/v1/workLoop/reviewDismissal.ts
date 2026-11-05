import { z } from 'zod/v4';
import type { DismissReviewInput, ReviewDismissalResultDto } from '@/lib/dto/agentReview';

// DISMISS THE REVIEW's wire shapes (Story MOTIR-10327 · MOTIR-10334; `approval-gates.md`
// §12.15) — `POST /api/v1/work-items/{key}/review-dismissal`. Their own module, beside
// `./reviewVerdict.ts`.

export const reviewDismissalBodySchema = z
  .object({
    /** The delivery-set version the send-back being dismissed is about — the card's current one. */
    subjectVersion: z.string().trim().min(1),
    /** Why the review is dismissed — required, at most 2000 characters once trimmed. */
    reason: z.string(),
  })
  .strict();
export type V1ReviewDismissalBody = z.infer<typeof reviewDismissalBodySchema>;

/** The body, as the service takes it. The service owns the reason's rule (`REASON_REQUIRED`). */
export function toDismissReviewInput(body: V1ReviewDismissalBody): DismissReviewInput {
  return { subjectVersion: body.subjectVersion, reasonMd: body.reason };
}

/** What a dismissal did. */
export const reviewDismissalResultSchema = z.object({
  key: z.string(),
  dismissalId: z.string(),
  subjectVersion: z.string(),
  /** The send-back dismissed — a gate-off review record, or a decided review gate. */
  dismissed: z.object({ kind: z.enum(['record', 'gate']), id: z.string() }),
  /** The stored reason. Its 2000-character limit is the service's rule on the request; the
   *  response carries no length bound, so a client's response validator never needs a
   *  code-point counter (the CLI's precompiled validators cannot import one). */
  reason: z.string(),
  dismissedBy: z.object({ id: z.string(), name: z.string().nullable() }),
  dismissedAt: z.string().datetime(),
  /** The approve-and-merge gate asked again at the same version, or null. */
  approvalGateId: z.string().nullable(),
});
export type V1ReviewDismissalResult = z.infer<typeof reviewDismissalResultSchema>;

export function presentReviewDismissalResult(
  dto: ReviewDismissalResultDto,
): V1ReviewDismissalResult {
  return {
    key: dto.key,
    dismissalId: dto.dismissalId,
    subjectVersion: dto.subjectVersion,
    dismissed: { ...dto.dismissed },
    reason: dto.reasonMd,
    dismissedBy: { ...dto.dismissedBy },
    dismissedAt: dto.dismissedAt,
    approvalGateId: dto.approvalGateId,
  };
}

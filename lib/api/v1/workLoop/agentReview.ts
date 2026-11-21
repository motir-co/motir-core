import { z } from 'zod/v4';
import {
  REVIEW_BUG_DESCRIPTION_MAX_LENGTH,
  REVIEW_BUG_TITLE_MAX_LENGTH,
  REVIEW_BUGS_MAX,
  REVIEW_FINDINGS_MAX_LENGTH,
  REVIEW_SUMMARY_MAX_LENGTH,
  REVIEW_VERDICTS,
} from '@/lib/dispatch/reviewPromptTemplate';
import type { AgentReviewVerdictResultDto, ReviewPromptDto } from '@/lib/dto/agentReview';

// The REVIEW RUN's wire shapes (Story MOTIR-1626 · MOTIR-6821; `hosted-agent-run.md`
// §8.2 / §8.4) — `GET …/review-prompt` and `POST …/agent-review`. Their own module rather
// than more of `./schema.ts`, which a sibling card of the same story edits concurrently;
// the operations import them from here exactly as from there.

/** One pull request under review, at the head the gate names. */
export const reviewPullRequestSchema = z.object({
  /** `owner/name`. */
  repository: z.string(),
  number: z.number().int(),
  /** The REVIEWED head — the gate's `subjectVersion`, never a later commit. */
  headSha: z.string(),
  baseBranch: z.string().nullable(),
  headBranch: z.string().nullable(),
  url: z.string(),
});

const reviewPromptBase = {
  key: z.string(),
  /** The version under review — the verdict names it back as `subjectVersion`. */
  subjectVersion: z.string(),
  pullRequests: z.array(reviewPullRequestSchema),
  /** The server-assembled brief the review agent is handed. */
  prompt: z.string(),
};

/**
 * `GET /api/v1/work-items/{key}/review-prompt`.
 *
 * ⚠️ TWO VARIANTS, AND THE GATE-ON ONE IS THE SHIPPED SHAPE BYTE FOR BYTE (Story MOTIR-11941
 * · MOTIR-11952, contract 1.88.0). A review with no gate (Review off, `approval-gates.md`
 * §12.18) answers `gateId: null`. Relaxing the shipped `gateId` to nullable would RETYPE a
 * declared field, which `docs/decisions/public-api-conventions.md` §8 forbids, so the shape is
 * SPLIT the way 1.21.0 split the subsumption advisory: the shipped variant unchanged, and a
 * gate-off variant no client has received before beside it.
 */
export const reviewPromptSchema = z.union([
  z.object({
    ...reviewPromptBase,
    /** The `agent_review` gate the verdict answers. */
    gateId: z.string(),
  }),
  z.object({
    ...reviewPromptBase,
    /** A review with no gate: the verdict is stored as a review record (§12.18). */
    gateId: z.null(),
  }),
]);
export type V1ReviewPrompt = z.infer<typeof reviewPromptSchema>;

export function presentReviewPrompt(dto: ReviewPromptDto): V1ReviewPrompt {
  const shared = {
    key: dto.key,
    subjectVersion: dto.subjectVersion,
    pullRequests: dto.pullRequests.map((pr) => ({
      repository: pr.repository,
      number: pr.number,
      headSha: pr.headSha,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      url: pr.url,
    })),
    prompt: dto.prompt,
  };
  return dto.gateId === null ? { ...shared, gateId: null } : { ...shared, gateId: dto.gateId };
}

/**
 * One bug the review logs (MOTIR-10513, `hosted-agent-run.md` §8.7) — a defect the verdict
 * cannot carry. Motir files it; the review names only what it found.
 */
export const agentReviewBugSchema = z
  .object({
    /** The one-line summary alone — the key Motir allocates is the id. */
    title: z.string().trim().min(1).max(REVIEW_BUG_TITLE_MAX_LENGTH),
    /** Root cause, reproduction, evidence and fix direction, in Markdown. */
    descriptionMd: z.string().trim().min(1).max(REVIEW_BUG_DESCRIPTION_MAX_LENGTH),
  })
  .strict();

/**
 * `POST /api/v1/work-items/{key}/agent-review` — ONE verdict. `findingsMd` is REQUIRED and
 * non-empty on `changes_requested` (`approval-gates.md` §12.4); a refusal without findings
 * is refused here, naming the field, before anything is read.
 */
export const agentReviewBodySchema = z
  .object({
    /** The version the run reviewed — the review prompt's `subjectVersion`. */
    subjectVersion: z.string().trim().min(1),
    verdict: z.enum(REVIEW_VERDICTS),
    /** What the reviewer concluded, in a line or two. */
    summaryMd: z.string().max(REVIEW_SUMMARY_MAX_LENGTH).nullable().optional(),
    /** The findings, Markdown: each naming a file and line, what it breaks, what to change. */
    findingsMd: z.string().max(REVIEW_FINDINGS_MAX_LENGTH).nullable().optional(),
    /** The defects the verdict cannot carry, filed by Motir as bugs (MOTIR-10513). */
    bugs: z.array(agentReviewBugSchema).max(REVIEW_BUGS_MAX).optional(),
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
  });
export type V1AgentReviewBody = z.infer<typeof agentReviewBodySchema>;

/** One bug the verdict logged: `filed` new, or `already_filed` — a not-done bug of the same title. */
export const agentReviewLoggedBugSchema = z.object({
  key: z.string(),
  title: z.string(),
  outcome: z.enum(['filed', 'already_filed']),
});

const agentReviewResultBase = {
  key: z.string(),
  verdict: z.enum(REVIEW_VERDICTS),
  state: z.enum(['approved', 'changes_requested']),
  subjectVersion: z.string(),
  decidedAt: z.string().datetime(),
  /** Every bug the verdict carried, in its order — `[]` when it carried none. */
  bugs: z.array(agentReviewLoggedBugSchema),
};

/**
 * What an ACCEPTED verdict did — split as {@link reviewPromptSchema} is (contract 1.88.0).
 * The gate-on variant is the shipped shape plus `outcome: 'decided'` (§8's allowed new field
 * on an existing shape); the gate-off variant answers `gateId: null` and
 * `outcome: 'recorded'` — the verdict was stored as a review record and decided no gate.
 */
export const agentReviewResultSchema = z.union([
  z.object({
    ...agentReviewResultBase,
    gateId: z.string(),
    /** The verdict decided the gate. */
    outcome: z.literal('decided'),
  }),
  z.object({
    ...agentReviewResultBase,
    gateId: z.null(),
    /** The verdict was stored as a review record; no gate was decided (§12.18). */
    outcome: z.literal('recorded'),
  }),
]);
export type V1AgentReviewResult = z.infer<typeof agentReviewResultSchema>;

export function presentAgentReviewResult(dto: AgentReviewVerdictResultDto): V1AgentReviewResult {
  const shared = {
    key: dto.key,
    verdict: dto.verdict,
    state: dto.state,
    subjectVersion: dto.subjectVersion,
    decidedAt: dto.decidedAt,
    bugs: dto.bugs.map((b) => ({ key: b.key, title: b.title, outcome: b.outcome })),
  };
  return dto.gateId === null
    ? { ...shared, gateId: null, outcome: 'recorded' }
    : { ...shared, gateId: dto.gateId, outcome: 'decided' };
}

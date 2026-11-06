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

/** `GET /api/v1/work-items/{key}/review-prompt`. */
export const reviewPromptSchema = z.object({
  key: z.string(),
  /** The `agent_review` gate the verdict answers. */
  gateId: z.string(),
  /** The version under review — the verdict names it back as `subjectVersion`. */
  subjectVersion: z.string(),
  pullRequests: z.array(reviewPullRequestSchema),
  /** The server-assembled brief the review agent is handed. */
  prompt: z.string(),
});
export type V1ReviewPrompt = z.infer<typeof reviewPromptSchema>;

export function presentReviewPrompt(dto: ReviewPromptDto): V1ReviewPrompt {
  return {
    key: dto.key,
    gateId: dto.gateId,
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

/** What an ACCEPTED verdict did. */
export const agentReviewResultSchema = z.object({
  key: z.string(),
  gateId: z.string(),
  verdict: z.enum(REVIEW_VERDICTS),
  state: z.enum(['approved', 'changes_requested']),
  subjectVersion: z.string(),
  decidedAt: z.string().datetime(),
  /** Every bug the verdict carried, in its order — `[]` when it carried none. */
  bugs: z.array(agentReviewLoggedBugSchema),
});
export type V1AgentReviewResult = z.infer<typeof agentReviewResultSchema>;

export function presentAgentReviewResult(dto: AgentReviewVerdictResultDto): V1AgentReviewResult {
  return {
    key: dto.key,
    gateId: dto.gateId,
    verdict: dto.verdict,
    state: dto.state,
    subjectVersion: dto.subjectVersion,
    decidedAt: dto.decidedAt,
    bugs: dto.bugs.map((b) => ({ key: b.key, title: b.title, outcome: b.outcome })),
  };
}

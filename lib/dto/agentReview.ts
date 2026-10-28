// What the REVIEW RUN's two routes answer (Story MOTIR-1626 · MOTIR-6821;
// `docs/decisions/hosted-agent-run.md` §8.2 / §8.4).

import type { ReviewVerdict } from '@/lib/dispatch/reviewPromptTemplate';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import type { WorkItemRefMap } from '@/lib/dto/workItems';

/** One pull request the review is about, at its REVIEWED head. */
export interface ReviewPullRequestDto {
  /** `owner/name`. */
  repository: string;
  number: number;
  /** The head the gate's `subjectVersion` names — never a later one. */
  headSha: string;
  baseBranch: string | null;
  headBranch: string | null;
  url: string;
}

/** `GET …/review-prompt` — the brief, and the coordinates the launcher checks out. */
export interface ReviewPromptDto {
  key: string;
  gateId: string;
  /** The version under review — what the verdict must name back. */
  subjectVersion: string;
  pullRequests: ReviewPullRequestDto[];
  prompt: string;
}

/** What the verdict route did with an ACCEPTED verdict. */
export interface AgentReviewVerdictResultDto {
  key: string;
  gateId: string;
  verdict: ReviewVerdict;
  /** The gate's state after the decision — `approved` or `changes_requested`. */
  state: 'approved' | 'changes_requested';
  subjectVersion: string;
  decidedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE AGENT REVIEW AS THE ITEM PAGE'S DEVELOPMENT BLOCK READS IT (Story MOTIR-1626 ·
// MOTIR-6825; `design/github/design-notes.md` § 30). Read with the other gate reads of
// the late stack (`lateReads.ts`), once per page, never per row.

/** The review RUN the band links — the latest run opened for the gate (any status). */
export interface AgentReviewRunRefDto {
  id: string;
  /** The run's own label, as the runs surface and How to test print a run. */
  label: string;
  /** ISO-8601. */
  startedAt: string;
}

/**
 * The run target's LATEST `agent_review` gate and what the frame draws about it.
 *
 * - `gate` — the gate row, whatever its state. Its `noteMd` is the FINDINGS (the agent's
 *   verdict) or the person's override reason; `decidedUnderAuthority` says which
 *   (`review_agent` is the agent, anything else a person continuing without it, §12.3).
 * - `reviewUnavailableReason` — why the review COULD NOT RUN (§12.6), the code MOTIR-6820
 *   writes; null while it runs or once decided.
 * - `canDecide` / `routedToLabel` / `stamp` — the gate read's own answers, for *Review
 *   again* and *Continue without the review* (the routed person's alone).
 * - `run` — the latest review run opened for this gate, or null before one opened.
 * - `settingsDoorHref` — the Approvals room's review-agent switch, handed only to a
 *   holder of `workflow:manage`.
 */
export interface AgentReviewViewDto {
  gate: ApprovalGateDTO;
  canDecide: boolean;
  routedToLabel: string | null;
  stamp: string | null;
  reviewUnavailableReason: string | null;
  run: AgentReviewRunRefDto | null;
  settingsDoorHref: string | null;
  /** The chips of every `[KEY](motir:<id>)` in the gate's `noteMd` — the findings — resolved
   *  for the reader (bug MOTIR-10023); `{}` when they link nothing. */
  findingsRefs: WorkItemRefMap;
}

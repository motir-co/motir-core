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

/** A bug a review verdict carried, as Motir landed it (MOTIR-10513): `filed` new, or
 *  `already_filed` — a not-done bug of the project with the same title, which is named
 *  instead of filed twice. */
export interface ReviewLoggedBugDto {
  key: string;
  id: string;
  title: string;
  outcome: 'filed' | 'already_filed';
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
  /** Every bug the verdict carried, in its order; `[]` when it carried none. */
  bugs: ReviewLoggedBugDto[];
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

// ─────────────────────────────────────────────────────────────────────────────
// THE USER-TOKEN VERDICT DOOR (Story MOTIR-10327 · MOTIR-10333; `approval-gates.md`
// §12.11–§12.13) — `submit_review_verdict` and `POST …/work-items/{key}/review-verdict`.

/** The verdict words on the door's wire (§12.11) — the gate's own words are `pass` /
 *  `changes_requested`, and the service maps between them. */
export const REVIEW_DOOR_VERDICTS = ['approved', 'changes_requested'] as const;
export type ReviewDoorVerdict = (typeof REVIEW_DOOR_VERDICTS)[number];

/** One acceptance criterion's result, as the review judged it. */
export const REVIEW_CHECKLIST_STATUSES = ['met', 'not_met', 'cannot_tell'] as const;
export type ReviewChecklistStatus = (typeof REVIEW_CHECKLIST_STATUSES)[number];

/** The longest harness or model name kept, after trimming. */
export const REVIEW_SUBMITTER_FIELD_MAX_LENGTH = 200;
/** The most checklist rows one verdict carries. */
export const REVIEW_CHECKLIST_MAX_ROWS = 200;

/** One row of the criteria checklist. `evidence` is required on `met`. */
export interface ReviewChecklistRowDto {
  /** The card the criterion belongs to — the run target or one of its descendants. */
  key: string | null;
  criterion: string;
  status: ReviewChecklistStatus;
  evidence: string | null;
}

/** What the door is handed. */
export interface SubmitReviewVerdictInput {
  verdict: ReviewDoorVerdict;
  /** The delivery-set version reviewed, in `deliverySetVersion`'s form. */
  subjectVersion: string;
  summaryMd: string | null;
  /** Required and non-empty on `changes_requested`. */
  findingsMd: string | null;
  checklist: ReviewChecklistRowDto[];
  harness: string;
  model: string;
}

/**
 * What became of an ACCEPTED verdict. `decided` — it decided the awaiting `agent_review`
 * gate (`gateId`); `recorded` — the review gate was off, and the verdict is the record.
 * A late or second verdict is a typed refusal, not a result.
 */
export interface ReviewVerdictResultDto {
  key: string;
  recordId: string;
  outcome: 'decided' | 'recorded';
  verdict: ReviewDoorVerdict;
  subjectVersion: string;
  /** The gate it decided — null when `recorded`. */
  gateId: string | null;
  /** The approve-and-merge gates the send-back withdrew (`agent_changes_requested`). */
  withdrewApprovalGateIds: string[];
  submittedAt: string;
}

// ── DISMISS THE REVIEW (Story MOTIR-10327 · MOTIR-10334; `approval-gates.md` §12.15) ───────

/** The longest dismissal reason kept. */
export const REVIEW_DISMISSAL_REASON_MAX_LENGTH = 2_000;

/** What a person sends to dismiss a standing agent send-back. */
export interface DismissReviewInput {
  /** The delivery-set version the person read the send-back at. */
  subjectVersion: string;
  /** Why — required, trimmed, at most {@link REVIEW_DISMISSAL_REASON_MAX_LENGTH}. */
  reasonMd: string;
}

/** What a dismissal did. */
export interface ReviewDismissalResultDto {
  key: string;
  dismissalId: string;
  subjectVersion: string;
  /** The send-back dismissed: a gate-off review verdict record, or a decided review gate. */
  dismissed: { kind: 'record' | 'gate'; id: string };
  reasonMd: string;
  dismissedBy: { id: string; name: string | null };
  dismissedAt: string;
  /** The approve-and-merge gate asked again at the same version, or null when none was. */
  approvalGateId: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ONE REVIEW'S FINDINGS AND CHECKLIST (MOTIR-10460; `design/workbench/design-notes.md`
// § 42) — what *Findings and checklist* opens in place over the Workbench, read when the
// view opens and never with the list. `GET /api/work-items/{key}/review-findings`.

/** Which review the view reads — the `recordRef` / `lastReviewedRef` the link carries. */
export type ReviewFindingsRefDto = { kind: 'record'; id: string } | { kind: 'gate'; id: string };

/** One commit the review was at. */
export interface ReviewFindingsCommitDto {
  repo: string;
  number: number;
  headSha: string;
}

export interface ReviewFindingsDto {
  identifier: string;
  title: string;
  ref: ReviewFindingsRefDto;
  /** The gate's own verdict words. */
  verdict: 'pass' | 'changes_requested';
  /** Motir's hosted agent, or a person's own agent (with its harness and model). */
  reviewer:
    | { kind: 'hosted'; model: string | null }
    | { kind: 'own'; name: string | null; harness: string; model: string };
  /** ISO-8601 — when the record was written, or the gate decided. */
  at: string;
  /** The delivery-set version the review was at; null on a gate that names none. */
  subjectVersion: string | null;
  commits: ReviewFindingsCommitDto[];
  /** The WHOLE findings — the record's `findingsMd`, or a gate-only pass's note. */
  findingsMd: string | null;
  /** The chips of every `[KEY](motir:<id>)` in the findings, resolved for the reader. */
  findingsRefs: WorkItemRefMap;
  /** The stored checklist rows, in stored order; `[]` for a gate or a record with none. */
  checklist: ReviewChecklistRowDto[];
}

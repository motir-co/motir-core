import type { ClaimActorDto } from '@/lib/dto/claim';
import type { PrCiState } from '@/lib/github/prCiState';

// The REPAIR CLAIM result (Story MOTIR-5460 · MOTIR-5464).
//
// A card whose run has ended can be left with a red pull request, and the only
// agent that could fix it has gone. `POST /api/v1/work-items/{key}/repair` hands
// that pull request to ONE fixing agent: it opens a dispatch run with command
// `fix`, and that open run is the lock. The card's status and assignee are never
// written — a red build already means `implemented`, and `ciPromotion` moves the
// card on when the build goes green, exactly as it does for any card.
//
// Like the keyed claim (`lib/dto/claim.ts`), a refusal is a RESULT and not an
// error, and it DISCRIMINATES: the caller's next move is different for each.

/**
 * What a repair claim resolved to.
 *
 * - `claimed` — the repair is the caller's now; a `fix` run was opened for it.
 * - `mine` — the caller already holds an open `fix` run on this card: a resumed
 *   repair. The same run is returned, and no second one is opened.
 * - `taken` — somebody else holds the open `fix` run. Named, with its start.
 * - `not_repairable` — there is nothing a repair can do here; `reason` says why.
 */
export type WorkItemRepairOutcome = 'claimed' | 'mine' | 'taken' | 'not_repairable';

/**
 * Why a card cannot be repaired, checked in this order.
 *
 * - `not_implemented` — archived, or at neither the project's Implemented nor its
 *   In Review rung. A red build is only a repair's business once the run that built
 *   it has ended; In Review is admitted for a merge-queue ejection (MOTIR-5803) and
 *   for a card a review sent back (the `review` class, MOTIR-6822).
 * - `repair_on_run_target` — the pull requests belong to a run launched against
 *   another card (`runTargetKey`); the repair runs there, never on a child the
 *   same pull requests also deliver.
 * - `no_pull_requests` — the card has no delivery rows at all.
 * - `ci_running` — nothing open is failing, and at least one member is running.
 * - `not_failing` — nothing open is failing and nothing is running. Also an In
 *   Review card with no standing merge-queue outcome at a member's head and no
 *   standing review refusal at the current version: it is waiting on review, not
 *   failing (MOTIR-5803, MOTIR-6822).
 * - `repair_not_code` — the merge did not land for a reason NO CODE CHANGE fixes
 *   (MOTIR-5803; `approval-gates.md` §4 FOURTH AMENDMENT, point 6): a setting
 *   blocked it, or somebody took the pull request out of the queue by hand. The
 *   message names what would help instead — approve again, or change the setting.
 */
export type WorkItemRepairRefusal =
  | 'not_implemented'
  | 'repair_on_run_target'
  | 'no_pull_requests'
  | 'ci_running'
  | 'not_failing'
  | 'repair_not_code';

/**
 * WHICH KIND OF REPAIR a claim hands over (Story MOTIR-6071 · MOTIR-6502;
 * `acceptance-refusal-verdict.md` §4).
 *
 * - `ci` — the shipped classes: red checks, a standing merge-queue failure, a conflict.
 *   The agent makes the build pass.
 * - `acceptance_rerun` — the story's acceptance video was sent back with **Re-run**
 *   (`revise`), pressed in Motir, and the refusal still stands over the current receipt.
 *   The checks are usually GREEN: the fix is to what the reviewer SAW, so every open
 *   member is handed over, and the agent is told the reason.
 * - `review` — a REVIEW sent the card back (Story MOTIR-1626 · MOTIR-6822;
 *   `approval-gates.md` §12.4, §12.7): the review agent's `changes_requested` on
 *   `agent_review`, or a person's *Request changes* on the approve-and-merge gate, still
 *   standing over the delivery set's CURRENT version. The checks are usually GREEN: every
 *   open member is handed over with the findings ({@link ReviewRefusalDto}), and the
 *   agent answers each one on the pull requests' own branches. Its push moves a head,
 *   which is what retires the refusal.
 */
export type WorkItemRepairClass = 'ci' | 'acceptance_rerun' | 'review';

/** The refusal a `review` repair answers — the findings, and who sent the card back. */
export interface ReviewRefusalDto {
  /** Which review sent it back — the review agent's gate, or the approve-and-merge gate. */
  gate: 'agent_review' | 'pull_request_approval';
  /** The findings, VERBATIM and in full — the gate's note. */
  findingsMd: string | null;
  /** The reviewer as the To fix row names them: `Review agent` for the agent (never the
   *  run's attributed user, §12.3), the person's display name otherwise. */
  reviewerName: string | null;
  /** ISO-8601. */
  decidedAt: string;
}

/** The refusal an `acceptance_rerun` repair answers — what the reviewer said. */
export interface AcceptanceRefusalDto {
  /** The reason, verbatim. */
  reasonMd: string | null;
  /** Who sent it back, as recorded at the decision. */
  decidedByLabel: string | null;
  /** ISO-8601. */
  decidedAt: string;
}

/** One failing pull request the fixing agent is handed. */
export interface RepairPullRequestDto {
  /** `owner/name`. */
  repo: string;
  number: number;
  url: string;
  /** The branch the agent checks out and pushes to — the SAME pull request's. */
  headRef: string;
  /** Null on a row mirrored before base branches were recorded. */
  baseRef: string | null;
  /** The pull request's OWN verdict (`derivePrCiState`). `failing` when its own
   *  checks are red — and possibly `passing` when it is failing only because the
   *  merge queue threw it out: then {@link RepairPullRequestDto.queueExit} is set
   *  (MOTIR-5719). */
  ci: PrCiState;
  /** The checks failing at the verdict's commit, by name, sorted — what a
   *  give-up names (MOTIR-5465). The pull request's OWN checks; a queue's failing
   *  check rides on `queueExit`. */
  failingChecks: string[];
  /** The standing merge-queue FAILURE that makes this pull request failing — set
   *  exactly when its latest exit is a failure, not re-queued, at its current head
   *  (`queueExitHoldsAtHead`), else null. */
  queueExit: RepairQueueExitDto | null;
  /** The host reports this pull request CONFLICTED with its base at its head (MOTIR-5913's
   *  stored reading) — a member failing for that alone has green checks and no exit. NOT on
   *  the wire: the v1 presenter copies fields by name, and this one is the page's. */
  conflicted: boolean;
  /** The host reports this pull request OUT OF DATE with a base branch that requires it to
   *  be up to date (`mergeable_state: behind`, Bug MOTIR-10054) — its checks are green and
   *  only a merge of the base answers it. NOT on the wire, for `conflicted`'s reason. */
  outOfDate: boolean;
}

/** Why the merge queue threw a pull request out, as the fixing agent is told it
 *  (Story MOTIR-5628 · MOTIR-5719). */
export interface RepairQueueExitDto {
  /** GitHub's own reason string — `CI_FAILURE`, `MERGE_CONFLICT`, … */
  rawReason: string;
  /** The exit's STORED disposition — `neutral` for a check that hung (§4 SIXTH
   *  AMENDMENT), which the fix part never names as a failure. */
  disposition: 'failure' | 'neutral' | 'landed';
  /** When the queue removed it, ISO-8601. */
  exitedAt: string;
  /** The head the queue tested — the pull request's current head. */
  headSha: string;
  /** The queue's failing check, when the attempt named one; null for a conflict. */
  failingCheckName: string | null;
  failingCheckUrl: string | null;
}

/** The result of one repair claim attempt. */
export interface WorkItemRepairClaimDto {
  key: string;
  title: string;
  outcome: WorkItemRepairOutcome;
  /** Set exactly when `outcome === 'not_repairable'`. */
  reason: WorkItemRepairRefusal | null;
  /** The run target's key, set exactly when `reason === 'repair_on_run_target'`. */
  runTargetKey: string | null;
  /** The `fix` run — set on `claimed`, `mine` and `taken`. */
  runId: string | null;
  /** Who opened that run — set on `claimed`, `mine` and `taken` (null only for
   *  an operator whose account has since been deleted). */
  holder: ClaimActorDto | null;
  /** When that run started, ISO-8601 — set on `claimed`, `mine` and `taken`. */
  startedAt: string | null;
  /** Which kind of repair this is (MOTIR-6502). `ci` on every refusal. */
  repairClass: WorkItemRepairClass;
  /** The acceptance refusal an `acceptance_rerun` answers — set exactly on that class
   *  with `claimed` / `mine`, null otherwise. */
  acceptanceRefusal: AcceptanceRefusalDto | null;
  /** The review refusal a `review` repair answers — set exactly on that class with
   *  `claimed` / `mine`, null otherwise (MOTIR-6822). */
  reviewRefusal: ReviewRefusalDto | null;
  /** The failing OPEN pull requests — non-empty on `claimed` and `mine`, empty
   *  otherwise, so a refused caller is handed nothing to act on. On an
   *  `acceptance_rerun` or a `review` it is EVERY open member, green ones included. */
  pullRequests: RepairPullRequestDto[];
}

/** A failing pull request as the Development block names it: `owner/name · #n`. */
export interface RepairPullRequestRefDto {
  repo: string;
  number: number;
  /** The pull request's OWN verdict — `passing` on a member failing only because
   *  the merge queue threw it out (MOTIR-5719). */
  ci: PrCiState;
  /** Set when the pull request is failing because the merge queue threw it out.
   *  With `ci`, it is what the Development block's which-to-use line reads: *a
   *  failing member whose own `ci` is not `failing` and which carries a standing
   *  queue exit* (`design/github/design-notes.md` § 26, MOTIR-5718). */
  queueExit: {
    rawReason: string;
    /** `neutral` for a check that hung (§4 SIXTH AMENDMENT) — never named as a failure. */
    disposition: 'failure' | 'neutral' | 'landed';
    failingCheckName: string | null;
  } | null;
  /** Set when the host reports the pull request conflicted at its head (MOTIR-5916; design
   *  § 30's fix part) — the line then says it conflicts with `baseRef` and cannot be merged,
   *  never *Checks are failing*, which would be false. */
  conflict: { baseRef: string | null } | null;
  /** Set when the host reports the pull request out of date with a base that requires it to
   *  be up to date (Bug MOTIR-10054) — the line then says it is behind `baseRef`, never
   *  *Checks are failing*, which would be false. */
  outOfDate: { baseRef: string | null } | null;
}

/**
 * What the item page's Development block draws about a repair (Story MOTIR-5460
 * · MOTIR-5466; design `design/github` § 21, Panels F1–F4).
 *
 * Derived from the SAME evaluation the repair claim makes, so the page never
 * offers a command the claim would refuse (§ 21: *"the part and the claim read
 * one predicate"*).
 *
 * - `hidden` — state 5: not implemented, nothing failing, or no pull request.
 * - `offer` — F1, or F3 when the card's latest `fix` run gave up (`lastGaveUp`).
 * - `in_progress` — F2: an open `fix` run holds the card.
 * - `pointer` — F4: the card's own failing pull requests belong to a run launched
 *   against `runTargetKey`, which is where the repair runs.
 */
export type WorkItemRepairViewDto =
  | { state: 'hidden' }
  | {
      state: 'offer';
      /** `acceptance_rerun`: the pull requests are the story's open delivery, not red
       *  ones, and the part names the refusal instead of failing checks (MOTIR-6502). */
      repairClass: WorkItemRepairClass;
      acceptanceRefusal: AcceptanceRefusalDto | null;
      failing: RepairPullRequestRefDto[];
      /** The latest `fix` run ended `failed`: when, and after how many attempts
       *  (null when the run reported no count — a give-up older than the event). */
      lastGaveUp: { attempts: number | null; endedAt: string } | null;
    }
  | {
      state: 'in_progress';
      repairClass: WorkItemRepairClass;
      acceptanceRefusal: AcceptanceRefusalDto | null;
      failing: RepairPullRequestRefDto[];
      holder: ClaimActorDto | null;
      /** The viewer started it — the copy says *you*. */
      byViewer: boolean;
      startedAt: string;
      /** The open `fix` run itself — a HOSTED one is drawn with its run link (MOTIR-6930;
       *  design `design/github` § 30 Panel 3b). Absent on a view built before it existed. */
      run?: RepairRunRefDto | null;
    }
  | { state: 'pointer'; failing: RepairPullRequestRefDto[]; runTargetKey: string };

/** The open `fix` run a repair view names (Story MOTIR-1626 · MOTIR-6930). */
export interface RepairRunRefDto {
  id: string;
  /** The run's own label, as the runs surface prints it (`dispatchRunLabel`). */
  label: string;
  /** Opened by *Fix on the hosted agent* — `origin: hosted` — rather than a local `motir fix`. */
  hosted: boolean;
}

/**
 * THE OPEN REPAIR on a card, as the To fix banner and the Workbench To fix row read it
 * (Story MOTIR-1626 · MOTIR-6930; `design/workbench` § 32): the open `fix` run IS the
 * one-repair-at-a-time lock (`hosted-agent-run.md` §8.6), so while it is open neither
 * repair is offered, and a hosted one is named with its run.
 */
export interface OpenRepairRunDto extends RepairRunRefDto {
  holder: ClaimActorDto | null;
  /** The viewer started it — the copy says *you*. */
  byViewer: boolean;
  /** ISO-8601. */
  startedAt: string;
}

/**
 * How an agent says its repair ENDED (Story MOTIR-6804 · MOTIR-6807) — the
 * `outcome` of `close_work_item_repair`. A closed vocabulary mapped onto the run's
 * own stop reasons exactly as the CLI's `CI_WATCH_STOP_REASON` maps a watch
 * result (`packages/cli/src/commands/dispatch.ts`), so a repair closed over the
 * MCP reads on the item page exactly as a `motir fix` one does.
 *
 * - `green` — the checks passed; the run succeeded (`completed`).
 * - `gave_up` — the agent spent its attempts; the page reads *gave up* (`halted`).
 * - `halted` — it stopped for any other reason it could not get past (`halted`).
 * - `interrupted` — the person stopped it (`interrupted`, a cancelled run).
 */
export const REPAIR_CLOSE_OUTCOMES = ['green', 'gave_up', 'halted', 'interrupted'] as const;
export type RepairCloseOutcome = (typeof REPAIR_CLOSE_OUTCOMES)[number];

/**
 * A repair run's LIVENESS as the agent holding it reads it — what
 * `touch_work_item_repair` and `close_work_item_repair` answer (MOTIR-6807).
 *
 * `open: false` is the signal to STOP: the run was closed — by the agent itself,
 * by the lapsed-heartbeat reap, or by anyone else — and the card no longer reads
 * *being fixed*, so a second fixer may already be on it.
 */
export interface WorkItemRepairRunDto {
  key: string;
  runId: string;
  open: boolean;
  /** The run's status — `running` while open. */
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
  /** Why it ended; null while open. `abandoned` is the reap's. */
  stopReason:
    | 'drained'
    | 'completed'
    | 'max'
    | 'halted'
    | 'interrupted'
    | 'replanned'
    | 'gated'
    | 'abandoned'
    | null;
  /** ISO-8601. */
  startedAt: string;
  /** ISO-8601; null while open. */
  endedAt: string | null;
  /** ISO-8601; the last `touch_work_item_repair` (or the claim's own first beat). */
  lastHeartbeatAt: string | null;
}

import type {
  ChoiceDefect,
  ChoiceDraft,
  ChosenOption,
  ParsedChoice,
} from '@/lib/approvalGates/choiceOptions';
import type { GateRefusal } from '@/lib/approvalGates/refusals';
import type { ConfirmedRecord } from '@/lib/approvalGates/decisionConfirmationRecord';
import type {
  DecisionChange,
  DecisionDefect,
  DecisionDraft,
  ParsedDecision,
} from '@/lib/approvalGates/decisionRecord';
import type { DecisionDocumentViewDTO } from '@/lib/dto/decisionDocument';
// TYPE-ONLY, and it has to stay that way: `stamp.ts` reaches for `node:crypto`,
// and this DTO is imported by client components. An `import type` is erased.
import type { StampComponent } from '@/lib/approvalGates/stamp';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { AcceptanceEvidenceDTO } from '@/lib/dto/acceptanceEvidence';
import type { DesignEvidenceDTO } from '@/lib/dto/designEvidence';
import type { WorkItemRepairViewDto } from '@/lib/dto/workItemRepair';
import type { AgentReviewViewDto } from '@/lib/dto/agentReview';
import type { LinkedPullRequestDto, WorkItemDeliveryDto } from '@/lib/dto/github';
import type { HowToTestDto } from '@/lib/dto/howToTest';
import type { WorkItemKindDto, WorkItemRefMap, WorkItemTypeDto } from '@/lib/dto/workItems';
import type { PlanAuthorSourceDto, PlanOriginDto } from '@/lib/dto/plans';
import type { RepoDelivery } from '@/lib/workItems/repoDelivery';
import type { TodoProgressDto, WorkItemTodoDto } from '@/lib/dto/workItemTodos';

// Wire DTOs for the approval-gate record (Story MOTIR-4778 · Subtask
// MOTIR-4788; ADR docs/decisions/approval-gates.md). The service layer (the
// decide-door card MOTIR-4790, the Approvals tab MOTIR-4779) maps Prisma rows
// to these via `lib/mappers/approvalGateMappers.ts` just before returning
// (CLAUDE.md — services never return raw Prisma models). Dates are ISO strings,
// matching the work-items / acceptance-evidence DTO convention.
//
// BASE record (MOTIR-4788): the subject, the kind, the state, who decided it
// and when, and the note. ⚠️ THE AUDIT SET (MOTIR-4912) is now here — the
// immutable subject version, the surviving actor label, the routed-to, the
// permission, the source and the outcome — so this DTO carries the whole of ADR
// §6a rather than only its workflow half.
//
// Every audit field is NULLABLE on the wire because it is nullable in the
// column, and for the same reason: five are written by the DECISION and are null
// while the gate is `awaiting`; `routedToId` is written at creation and is null
// only when the gate was routed to nobody. A consumer therefore reads `state`
// first and the audit set second — a null here is *not yet decided*, never
// *decided by nobody*, which is exactly the confusion `decidedByLabel` exists to
// prevent (§6b's amendment).

/** Which vocabulary of decision verbs a gate carries (ADR §1). Mirrors the
 *  `ApprovalGateKind` Prisma enum as the wire string union a client consumes. */
export type ApprovalGateKindDTO =
  | 'design_result'
  | 'decision_approval'
  | 'pull_request_approval'
  | 'pull_request_merge'
  | 'acceptance_result'
  | 'decision_choice'
  | 'decision_confirmation'
  /** A PLAN, on a gate that belongs to NO work item (ADR §11, MOTIR-6032). */
  | 'plan_approval'
  /** The REVIEW AGENT's question over a green delivery set (ADR §12, MOTIR-6818). */
  | 'agent_review'
  /** MANUAL WORK a run reached, waiting on a person (MOTIR-7474;
   *  `docs/decisions/manual-work-gate.md`). */
  | 'manual_work'
  /** A hosted PLANNING SESSION that needs its person — a planner's question, or a
   *  conversation waiting on a reply (MOTIR-7913; ADR `approval-gates.md` §1's
   *  MOTIR-7906 amendment). Card-less like `plan_approval`; it has no verbs. */
  | 'planning_session';

/**
 * WHETHER A DECISION IS WAITING ON A WORK ITEM, AND ON WHOM — the one answer the
 * decision-waiting marker draws on the board card, the `/items` rows and the item
 * page header (Story MOTIR-4908 · MOTIR-5876). Absent (`null` / no map entry) when
 * nothing is waiting.
 *
 * - `yours` — the gate is in this reader's To-approve tab AND they hold the kind's
 *   permission floor, so they could press it. Exactly the rows the tab offers to
 *   decide.
 * - `others` — any other awaiting gate: routed elsewhere (an admin who COULD
 *   decide it is still not the one asked), or routed to this reader while they sit
 *   below the floor.
 *
 * `kind` is the gate the entry was chosen from — the first `yours` by age, else the
 * oldest `others` — and is what the item header anchors its jump on. `routedToId`
 * is an id only: every surface already holds its member list to name the person.
 * It is never null in practice — `work_item.reporter_id` is `NOT NULL` with
 * `onDelete: Restrict`, so `assigneeId ?? reporterId` always names someone, and the
 * design draws no *routed to nobody* state (MOTIR-5875, amended 2026-09-21). The
 * type stays nullable only because `routingTargetId`'s signature is.
 */
export interface PendingDecisionDTO {
  state: 'yours' | 'others';
  kind: ApprovalGateKindDTO;
  routedToId: string | null;
}

/**
 * The payload every status door carries when the approval-gate guard refuses a
 * move (`APPROVAL_GATE_PENDING` — Story MOTIR-4887 · Subtask MOTIR-5526; ADR
 * `approval-gates.md` §6d AMENDMENT, rule 4). ONE shape on the board move, the
 * status server action, `/api/v1` and MCP, so a surface renders the refusal
 * without re-deriving any of it.
 *
 * - `itemKey` + `kind` address the approval overlay (`overlayAddress.ts`).
 * - `canDecide` is the same answer the approval frame draws its verbs from — the
 *   kind's permission floor AND §2's authority — so a surface never offers a
 *   Review & approve button the door would then refuse.
 * - `routedToLabel` names whose decision it is, for the reader who may only look.
 */
export interface ApprovalGatePendingPayloadDTO {
  itemKey: string;
  kind: ApprovalGateKindDTO;
  /** `decision` — the gate awaits a person, and the surface offers Review &
   *  approve to one who may decide. `merge` — it is already approved and the
   *  item's pull request is still open, so the surface offers no approve door:
   *  the merge makes the move (ADR §6d AMENDMENT, rule 2b). */
  waitingOn: 'decision' | 'merge';
  /** False while a pull request is open and no gate has been raised yet (its
   *  checks are not green) — the status control then says the approval is
   *  asked for once they pass, rather than naming someone it is waiting on. */
  gateRaised: boolean;
  canDecide: boolean;
  routedToLabel: string | null;
}

/**
 * One status move an approval holds on a work item, as the STATUS CONTROL draws it
 * before anyone tries the move (Story MOTIR-4887 · Subtask MOTIR-5528; design
 * `design/work-items/design-notes.md` § _The status control says so_). The same
 * rule the guard refuses with — `heldMoves` — read outside any lock.
 */
export interface HeldTransitionDTO {
  statusKey: string;
  /** The held status's own label, for the sentence. */
  statusLabel: string;
  waitingOn: 'decision' | 'merge';
  /** The kind whose decision this is — addresses the overlay. */
  kind: ApprovalGateKindDTO;
  /** Null while a pull request is open and no gate has been raised yet. */
  gateId: string | null;
  /** A Review & approve door is drawn only when true: a `decision` move with a gate
   *  actually awaiting, and this reader holding the floor AND the authority. */
  canDecide: boolean;
  routedToLabel: string | null;
}

/** Where a gate's decision stands (ADR §6b). Mirrors the `ApprovalGateState`
 *  Prisma enum. */
export type ApprovalGateStateDTO =
  | 'awaiting'
  | 'approved'
  | 'changes_requested'
  | 'superseded'
  /** A person refused a `decision_confirmation` gate's direction (MOTIR-5956) — terminal. */
  | 'overturned'
  /** A person ended the plan a `plan_approval` gate asked about (ADR §11.4) — terminal. */
  | 'declined';

/**
 * WHY a `superseded` gate was withdrawn — mirrors the `ApprovalGateSupersedeCause`
 * Prisma enum (`design-result.md` AMENDMENT 6 Q5). One value per writing path, and
 * **no value meaning _unsaid_**: `unknown` says the row PREDATES the column, which
 * is a different fact from any live cause.
 */
export type ApprovalGateSupersedeCauseDTO =
  | 'republished'
  | 'withdrawn'
  | 'head_moved'
  | 'member_closed'
  | 'member_drafted'
  | 'conflict'
  | 'set_changed'
  | 'pulled_back'
  /** CI reported a terminal FAILURE at the commits the gate asked about (MOTIR-6271). */
  | 'ci_failed'
  /** A check at the asked-about commits is pending again — the set left green without
   *  going red (MOTIR-6946). */
  | 'ci_rerunning'
  | 'unknown'
  /** The plan went `stale` (ADR §11.7). */
  | 'plan_stale'
  /** The plan's last proposal was withdrawn, so it was discarded (ADR §11.7). */
  | 'plan_discarded'
  /** A gate the old rule re-asked from a merge-queue FAILURE, withdrawn by the
   *  convergence (MOTIR-6595; §4 FIFTH AMENDMENT). */
  | 'queue_failed'
  /** The project turned its review agent OFF while the review was awaiting (ADR §12.5). */
  | 'review_agent_disabled'
  /** The gate's subject no longer resolves through its kind's handler, so a read that
   *  observed it withdrew the question (MOTIR-7146). */
  | 'subject_gone'
  /** A `manual_work` card stopped being manual (MOTIR-7474). */
  | 'no_longer_manual'
  /** A `manual_work` card reached a done status by a write nobody decided (MOTIR-7474). */
  | 'closed_without_decision'
  /** A `manual_work` card stopped being ready for a person — Blocked, or an open
   *  `blocked_by` (MOTIR-8670). */
  | 'not_ready'
  /** A `manual_work` card was re-planned — Planning, or a plan rewrote it (MOTIR-8670). */
  | 'replanned'
  /** The person sent a turn on the planning session a `planning_session` gate asked
   *  about — the question is answered (MOTIR-7913). */
  | 'answered'
  /** The planning session a `planning_session` gate asked about ended (MOTIR-7913). */
  | 'session_ended';

/** Under which §2 authority rung the decision was made (ADR §6a). Mirrors the
 *  `ApprovalGateAuthority` Prisma enum. Frozen at decision time, so a reader can
 *  answer *"was this person entitled?"* without re-deriving a role that has
 *  since changed.
 *
 *  `github_review` is NOT a §2 rung (ADR §8 FOURTH AMENDMENT, MOTIR-5590,
 *  decision 4): it is authority conferred by the HOST's review permission, and it
 *  is written only by the synced decision. `resolveGateAuthority` never returns
 *  it, so no Motir surface can produce one. */
export type ApprovalGateAuthorityDTO =
  | 'assignee'
  | 'reporter'
  | 'admin'
  | 'github_review'
  /** `ai:decide_plan` alone — the `plan_approval` kind has no work item, so no §2
   *  relationship rung is true of its decider (ADR §11.6). */
  | 'plan_permission'
  /** The review agent — a hosted review run's verdict (ADR §12.3). Never resolved
   *  by `resolveGateAuthority`; no person's press can produce it. */
  | 'review_agent'
  /** A PROJECT SETTING, not a person: the design gate a project with design
   *  approval switched off approves at raise time (MOTIR-697;
   *  `hosted-design-rerun-and-design-approval-switch.md` §2c). Written only by the
   *  publish path's system decision; `resolveGateAuthority` never returns it. */
  | 'project_setting';

/** Through which surface the decision arrived (ADR §6a, with `github` added by
 *  §6b's amendment). Mirrors the `ApprovalGateDecisionSource` Prisma enum. A
 *  human click, a token's API call, an agent's MCP call and a review synced out
 *  of GitHub are four different answers to *"was a human in the loop?"*. `system`
 *  is the fifth, and its answer is NO: a project setting decided it (MOTIR-697;
 *  `hosted-design-rerun-and-design-approval-switch.md` §2c). */
export type ApprovalGateDecisionSourceDTO = 'ui' | 'api' | 'mcp' | 'github' | 'system';

/**
 * WHAT A PERSON MEANT BY "NO" on a refused `design_result` gate (Story MOTIR-6070 ·
 * MOTIR-6421; ADR `approval-gates.md` §10d, amended by `design-refusal-verdict.md`).
 * Mirrors the `ApprovalGateRefusalVerdict` Prisma enum. `revise` sends the design back
 * to be revised; `re_plan` says the plan around it is wrong. Stored in a column of its
 * own — never in `outcomeRef`, which the repainting surfaces read as a status key.
 */
export type ApprovalGateRefusalVerdictDTO = 'revise' | 're_plan';

/** The verdict vocabulary as a value, for a boundary that parses one (route, action). */
export const APPROVAL_GATE_REFUSAL_VERDICTS = [
  'revise',
  're_plan',
] as const satisfies readonly ApprovalGateRefusalVerdictDTO[];

/**
 * THE LATEST REFUSAL on a work item (Story MOTIR-6070 · MOTIR-6422; ADR
 * `approval-gates.md` §10h note 4) — the reason the next run is handed.
 *
 * Present ONLY when the item's most recently DECIDED gate — of ANY kind, ordered by
 * `decidedAt` — is `changes_requested`. A later approval (or any later decision)
 * supersedes it; an `awaiting` gate is not a decision and does not. One shape for both
 * readers: the dispatched prompt's CHANGES REQUESTED section and `get_work_item`'s
 * `latestRefusal`, so a dispatched agent and a person following the runbook are never
 * told different things about the same card.
 */
export interface LatestRefusalDTO {
  gateId: string;
  kind: ApprovalGateKindDTO;
  /** The reason, verbatim. NULL only on a GitHub review submitted with no body (§10b) —
   *  a surface then says *no reason given on GitHub*, never a blank. */
  noteMd: string | null;
  /** Who refused, as recorded at the decision (survives their departure). */
  decidedByLabel: string | null;
  /** ISO-8601 — when it was refused. */
  decidedAt: string;
  decisionSource: ApprovalGateDecisionSourceDTO | null;
  /** `revise` / `re_plan` on a design refusal pressed in Motir (MOTIR-6421); else null. */
  refusalVerdict: ApprovalGateRefusalVerdictDTO | null;
  /** The REFUSED version — the subject's version at decision time (a design result's
   *  version, a pull request's head sha). Opaque; its shape depends on `kind`. */
  subjectVersion: string | null;
}

/**
 * The two decision VERBS, as the wire carries them.
 *
 * ⚠️ IT LIVES HERE, NOT ON THE SERVICE, AND THE CLIENT/SERVER BOUNDARY IS WHY.
 * The approval frame is a `'use client'` module and this is part of its props,
 * so importing it from `@/lib/services/*` would make a client module import the
 * service layer — which `tests/planning/planChangeArchitecture.test.ts` refuses
 * repo-wide, and rightly: such an import compiles, survives SSR, and then fails
 * in the browser or bundles the DB client into the page. A type-only import is
 * erased at build time and would bundle nothing, but the guard reads the import
 * SITE rather than its erasure, and it is a better guard for doing so — the
 * remedy is to put the type where the wire vocabulary already lives, not to
 * teach the guard an exception.
 *
 * A kind may later carry a verb SET rather than this pair (ADR §1's amendment,
 * `decision_choice`), which is why the door takes a decision rather than
 * exposing `approve()` / `requestChanges()` as separate methods.
 *
 * `decline` (MOTIR-6035; ADR §11.4) is offered ONLY by `plan_approval`: it ends the
 * plan, writes the terminal state `declined`, and its note is OPTIONAL.
 */
export type GateDecision = 'approve' | 'request_changes' | 'choose' | 'overturn' | 'decline';

/** WHAT A CHOICE'S DECISION PICKED — see {@link ChosenOption} (MOTIR-5893). */
export type ChosenOptionDTO = ChosenOption;

/**
 * One approval gate, as the decide control / Approvals tab renders it. The
 * card the gate hangs off (`workItemId`) is the join every surface uses; the
 * `subjectId` is resolved per-`kind` by the registry handler (a `DesignEvidence`
 * id, a pull-request delivery id, …) and is opaque to the DTO.
 */
export interface ApprovalGateDTO {
  id: string;
  /** The card the gate hangs off — NULL on a `plan_approval` gate, and on no other
   *  kind (ADR `approval-gates.md` §11.1): a plan gate belongs to no work item, and
   *  what it is about is its `subjectId`, the plan. */
  workItemId: string | null;
  kind: ApprovalGateKindDTO;
  /** The row being decided — resolved by the registry handler for `kind`. */
  subjectId: string;
  state: ApprovalGateStateDTO;
  /** WHO decided. Null while `awaiting` / `superseded`. `SetNull` on the FK so a
   *  departing member loses attribution, never the record that a decision
   *  happened — read it beside `decidedByLabel`, which survives the deletion. */
  decidedById: string | null;
  /** ISO-8601, or null while `awaiting` / `superseded`. */
  decidedAt: string | null;
  /** Why they said yes, or what they sent back. Null while `awaiting`. */
  noteMd: string | null;
  /**
   * WHY the question was withdrawn — null on every state but `superseded`
   * (Story MOTIR-5652 · Subtask MOTIR-5659 wrote it, MOTIR-5667 renders it).
   *
   * ⚠️ IT IS NOT AN ACTOR AND MUST NEVER BE RENDERED AS ONE. §6b's supersede
   * carries no decider, no authority and no note on purpose; a cause says what
   * happened to the SUBJECT. A surface that turned it into *somebody withdrew
   * this* would put a decision nobody made into the one record an audit trusts.
   *
   * ⚠️ `unknown` MEANS THE REASON WAS NOT RECORDED — a row that predates the
   * column. A surface renders it as exactly that and NEVER as one of the real
   * causes, because inferring one from a row's shape manufactures evidence, and
   * these sentences are shown to a person as fact.
   */
  supersededCause: ApprovalGateSupersedeCauseDTO | null;

  // ── THE AUDIT SET (ADR §6a · MOTIR-4912) ─────────────────────────────────
  /** WHAT was approved, immutably: the subject's version at decision time — a
   *  design's `commitSha`, a pull request's `headSha`. The record says the
   *  decider approved *these bytes* rather than *a design*, which is the
   *  difference between evidence and a name with a date beside it. Opaque, like
   *  `subjectId`: its shape depends on the kind. */
  subjectVersion: string | null;
  /** WHO decided, surviving their departure — their name and email as at the
   *  decision, or a GitHub login for a synced review whose identity resolves to
   *  no member. When `decidedById` is null and this is not, the answer is *"a
   *  person we can name but no longer resolve"*; when BOTH are null on a decided
   *  gate, the record is incomplete rather than anonymous. */
  decidedByLabel: string | null;
  /** WHO the gate was routed to when it was created (§2). The card's assignee
   *  can change afterwards, so this is the only record of who was actually
   *  asked. Null when the gate was routed to nobody. No surviving label — the
   *  routing is context, not the attribution the audit rests on. */
  routedToId: string | null;
  /** UNDER WHICH permission the decider acted. Null while `awaiting`. */
  decidedUnderAuthority: ApprovalGateAuthorityDTO | null;
  /** THROUGH WHICH surface the decision arrived. Null while `awaiting`. */
  decisionSource: ApprovalGateDecisionSourceDTO | null;
  /** WHAT THE REFUSAL MEANT — `revise` or `re_plan` — on a `design_result` gate sent back
   *  from Motir (MOTIR-6421; ADR §10d). Null on every approval, every other kind, a
   *  GitHub-synced refusal, and every gate decided before the column existed. Written in
   *  the deciding write, so it is as immutable as the rest of the decided row. */
  refusalVerdict: ApprovalGateRefusalVerdictDTO | null;
  /**
   * WHETHER A REFUSAL OF THIS GATE ASKS FOR A VERDICT (Story MOTIR-6071 · MOTIR-6501;
   * `acceptance-refusal-verdict.md` §1) — true exactly where the decide door REQUIRES
   * `revise` / `re_plan` on a Motir press: every `design_result`, and an
   * `acceptance_result` whose story has an open delivery of its own (a STORY RUN). False
   * on a finished story's acceptance and on every other kind. Computed for an `awaiting`
   * gate by the same `refusalVerdictOfferFor` the door calls, so the band and the door
   * read ONE answer; false on every decided or withdrawn gate, which offers nothing.
   */
  offersRefusalVerdict: boolean;
  /** WHAT it caused — the merge commit sha, or the transition applied. Written
   *  in the deciding write, never backfilled: a decided gate is immutable. */
  outcomeRef: string | null;
  /** WHAT WAS CHOSEN, on an approved `decision_choice` gate (MOTIR-5893) — and there
   *  `outcomeRef` is the option's id rather than a status key. Null everywhere else. */
  chosenOption: ChosenOptionDTO | null;
  /** WHAT A CONFIRMED DECISION'S WRITTEN RECORD WAS, on an approved
   *  `decision_confirmation` gate (MOTIR-5954) — the markdown attachment's identity,
   *  or `{ kind: 'none' }`. Null everywhere else. */
  confirmedRecord: ConfirmedRecordDTO | null;
  /**
   * THE RE-PLAN AN OVERTURN OWES (MOTIR-5956; ADR §1's MOTIR-5952 amendment, point 7)
   * — the work items the overturned decision's `## Supersedes` named. DERIVED, never
   * stored: the overturned gate plus its subject's parse. Null on every gate that is
   * not an `overturned` `decision_confirmation`. The overturn itself changed none of
   * them: re-planning is a planning act a person starts.
   */
  replanOwed: { keys: string[] } | null;
  /**
   * WHY THIS GATE CANNOT BE DECIDED RIGHT NOW although it is `awaiting` (MOTIR-6035;
   * ADR §11.5c) — set by the plan gate's render read (`approvalGatesService.getForPlan`)
   * and absent from every other read. DERIVED from the plan's revision lease, never
   * stored: when the lease ends, the same gate is decidable against the new version.
   */
  held?: PlanGateHeldDTO | null;

  createdAt: string;
  updatedAt: string;
  /**
   * THE AUTOMATIC HOSTED RE-RUN this refusal caused or skipped (Story MOTIR-693 ·
   * MOTIR-702; `hosted-design-rerun-and-design-approval-switch.md` §1g). Set by the
   * item-page gate read on a refused `design_result` gate that HAS a record; absent or
   * null everywhere else — and null means the frame draws no line (a card that was not
   * hosted, a Re-plan, a GitHub refusal: nothing was attempted).
   */
  autoRerun?: DesignAutoRerunDTO | null;
  /**
   * Where a SYSTEM-approved gate's "Design approval is off for this project" links to —
   * the switch on Settings → Approvals — for a reader who holds `workflow:manage`, the
   * key that room is guarded by (MOTIR-702; the design's panel 1). Null or absent for
   * everyone else, who get the same words as plain text (panel 2).
   */
  systemApprovalSettingsHref?: string | null;
}

/** The re-run line's facts (MOTIR-702) — `design_auto_rerun`, as the frame reads it. */
export interface DesignAutoRerunDTO {
  outcome: 'started' | 'skipped';
  /** Null exactly when `outcome` is `started`. */
  skipReason: DesignAutoRerunSkipReasonDTO | null;
  /** The run it started; the line's *View run* link. */
  dispatchRunId: string | null;
  /** Which automatic re-run of the card this was, and the cap it counts against. */
  ordinal: number;
  cap: number;
  /** The dispatcher, model or repository a skipped line names; null otherwise. */
  detail: string | null;
}

/** Why an automatic re-run did not start — mirrors `DesignAutoRerunSkipReason`. */
export type DesignAutoRerunSkipReasonDTO =
  | 'cap_reached'
  | 'dispatcher_gone'
  | 'no_project_access'
  | 'ci_credits_exhausted'
  | 'model_not_offered'
  | 'models_unavailable'
  | 'out_of_credits'
  | 'credits_unavailable'
  | 'repository_not_writable'
  | 'card_not_ready'
  | 'no_capacity';

/**
 * THE APPROVAL A RE-ASKED MERGE GATE REPLACED (Bug MOTIR-5863; `design/github/design-notes.md`
 * § 28 panel 1, the record band's FIRST span) — *Approved earlier by {name} · {date} ·
 * {count} commits — not merged*.
 *
 * ⚠️ IT IS A DIFFERENT ROW FROM THE GATE ON SCREEN. A press that did not land raises a
 * FRESH `awaiting` gate, whose `decidedByLabel` / `decidedAt` are null by construction, so
 * the band cannot be drawn from the gate it sits in: it names the latest `approved` row of
 * the same kind, which `findLatestByWorkItem` never returns while a live question stands.
 *
 * ⚠️ `commits` IS THAT ROW'S OWN MEMBER COUNT, not the current set's. The set can change
 * between the two asks, and the line is a statement about what was approved THEN.
 */
export interface EarlierApprovalDTO {
  /** The audit label as at that decision — survives the decider's departure. Null when
   *  the record is unattributable, which a surface says in words, never as nobody. */
  decidedByLabel: string | null;
  /** ISO-8601 — when that approval was given. */
  decidedAt: string;
  /** How many pull requests (each at one head) that approval named. */
  commits: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE APPROVALS QUEUE (Story MOTIR-4879 · Subtask MOTIR-4791) — what the
// Workbench's *To approve* tab reads. A DIFFERENT shape from `ApprovalGateDTO`
// above, and the difference is the surface: the gate DTO answers *what is the
// record of this decision?* on a card a reader is already looking at, and these
// answer *what is waiting on me, and which one is it?* in a list of things the
// reader has not opened.
//
// ⚠️ THE AUDIT SET IS ABSENT HERE, and that is not an omission to fix later.
// Every row this read returns is `awaiting`, so all six audit fields are null on
// every one of them by construction — carrying them would be six columns of
// guaranteed nulls travelling to a surface with nothing to render them.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHICH DESIGN is waiting, at row scale — enough to recognise the work without
 * opening it.
 *
 * `noteExcerpt` is a LEAD rather than the note: a design note runs to tens of
 * kilobytes and a row has one line. The whole text is on the card, which is
 * where a reader who wants it is going anyway.
 */
export interface DesignResultSubjectSummaryDTO {
  kind: 'design_result';
  /** The `DesignEvidence` row the gate asks about — these bytes, not "the design". */
  designEvidenceId: string;
  /** The card whose pull request produced this result (e.g. `MOTIR-2669`). */
  producedByKey: string | null;
  /** The commit those bytes are, when the publish had one. */
  commitSha: string | null;
  /** How many files the result carries — the row says the number and links away. */
  assetCount: number;
  /** The first line or so of the design note, plain, or null when it has none. */
  noteExcerpt: string | null;
}

// ⚠️ `PullRequestMergeSubjectSummaryDTO` WAS HERE (MOTIR-4793) and retired with its
// kind (Bug MOTIR-5603 · MOTIR-5616). It named ONE pull request, because a merge gate
// asked about one; the gate that survives asks about the whole delivery set and names
// every member below. A superseded row of the old kind now reads through
// `UnregisteredSubjectSummaryDTO`, like every other kind this build does not render.

/**
 * WHICH PULL REQUESTS an approve-and-merge gate is asking about, at row scale (MOTIR-5481)
 * — every member of the card's delivery set, in canonical order (`owner/name#number`),
 * with the head its latest checks ran on and whether it is still open.
 */
export interface PullRequestApprovalSubjectSummaryDTO {
  kind: 'pull_request_approval';
  members: {
    /** `owner/name`. */
    repo: string;
    number: number;
    /** The head commit the latest recorded checks ran on, or null when none reported. */
    headSha: string | null;
    state: 'open' | 'closed' | 'merged';
  }[];
}

/**
 * WHICH RECORDING an acceptance gate is asking about, at row scale (MOTIR-4950) — the
 * card that recorded it, the commit the run was at, and how many chapters it walks
 * through. The video itself is on the story; a row links there.
 */
export interface AcceptanceResultSubjectSummaryDTO {
  kind: 'acceptance_result';
  /** The `AcceptanceEvidence` row the gate asks about — THIS recording. */
  acceptanceEvidenceId: string;
  /** The E2E card whose run recorded it (e.g. `MOTIR-5792`), when the publish named it. */
  producedByKey: string | null;
  /** The commit the recorded run was at, when the publish had one. */
  commitSha: string | null;
  /** How many chapters the recording is marked into. */
  chapterCount: number;
}

/**
 * WHICH DECISION is waiting, at row scale (Story MOTIR-4907 · MOTIR-5676) — read
 * from the capture on the card's pull request, never from the host, so a queue of
 * decisions costs no Git call.
 *
 * ⚠️ `title` IS THE FILE NAME, NOT THE DOCUMENT'S HEADING. Motir keeps no copy of a
 * decision document, and a summary loader runs inside a transaction that may not
 * call a host; the heading exists only in the content, which a surface reads
 * through the resolver (`decisionDocumentService`) and `headingOf` turns into a
 * line. A surface that has done that read shows the heading; this is what a row
 * can say without it.
 */
export interface DecisionApprovalSubjectSummaryDTO {
  kind: 'decision_approval';
  /** `one` — a single document; `page` — a published page version (MOTIR-7436); anything
   *  else, the gate cannot be approved. */
  outcome: 'one' | 'page' | 'none' | 'several' | 'unreadable';
  /** `owner/name#number` of the pull request the answer was read off. */
  repo: string;
  number: number;
  /** The document's path, for `one`. */
  path: string | null;
  /** A readable title from the file name, for `one`. */
  title: string | null;
  /** The document's git blob, for `one` — the row's `title` names it (MOTIR-5679). */
  blobSha: string | null;
  /** How many documents the head writes — what a `several` row counts (MOTIR-5679). */
  documentCount: number;
  /** For `page`: the published version's number (the row reads *title · page, version N*). */
  versionNumber?: number;
}

/**
 * WHICH CHOICE is waiting, at row scale (Story MOTIR-4914 · MOTIR-5891) — read from
 * the work item's own body, which IS the subject (ADR §1's MOTIR-5887 amendment,
 * point 1). A row says how many options there are and what is being asked; which
 * option was CHOSEN is the decided gate's own stamp (`chosenOption`, MOTIR-5893),
 * never re-read from a body that may since have changed.
 */
/**
 * A CHOICE'S PORT — what the frame renders for a `decision_choice` gate (Story
 * MOTIR-4914; ADR §1's MOTIR-5887 amendment, point 1): the question, why it is a
 * choice, the options with what each is best for, and what the pick gates. It is
 * the parser's answer verbatim (`lib/approvalGates/choiceOptions.ts`), so the port
 * and the gate can never read two different bodies.
 */
export type DecisionChoicePortDTO = Omit<ParsedChoice, 'ok'>;

/**
 * A choice's port AS A SURFACE DRAWS IT (bug MOTIR-10023): the parse, plus the
 * `[KEY](motir:<id>)` links in its Markdown sections resolved for the reader — so
 * an option's why or the follow-up that names a card draws it live, never deleted.
 * The parse itself stays pure (`choiceBodyOf`); the read that serves a port adds this.
 */
export type DecisionChoicePortViewDTO = DecisionChoicePortDTO & { workItemRefs: WorkItemRefMap };

/** One reason a choice's body cannot be asked yet — the closed set point 2 fixes. */
export type ChoiceDefectDTO = ChoiceDefect;

/**
 * WHAT THE ITEM PAGE KNOWS ABOUT A CHOICE'S BODY, gate or no gate (MOTIR-5891,
 * the card's point 5). A defective body raises no gate, so the page cannot learn
 * its state from one: this carries the parse itself, and the port renders the
 * defect state from it (MOTIR-5896).
 */
export type ChoiceBodyDTO =
  | { ok: true; port: DecisionChoicePortDTO }
  | { ok: false; defects: ChoiceDefectDTO[]; draft: ChoiceDraft };

/** WHAT A CONFIRMED DECISION'S RECORD WAS — see {@link ConfirmedRecord} (MOTIR-5954). */
export type ConfirmedRecordDTO = ConfirmedRecord;

/**
 * A DECISION'S PORT — what the frame renders for a `decision_confirmation` gate
 * (Story MOTIR-5871; ADR §1's MOTIR-5952 amendment, point 2): the decision, what
 * changed, what it supersedes and the resulting direction — the parser's answer
 * verbatim (`lib/approvalGates/decisionRecord.ts`) — plus the record it would stamp
 * if confirmed now, so the port can draw the link or its absence (point 8).
 */
export type DecisionConfirmationPortDTO = Omit<ParsedDecision, 'ok'> & {
  record: ConfirmedRecordDTO;
  /** Each `## Supersedes` key with the work item's TITLE, or null for a key that names
   *  nothing in this project — drawn as plain mono text, never a defect (MOTIR-5960). */
  supersedesItems: SupersededItemDTO[];
  /** How many counting markdown records the item holds; the port names the newest. */
  recordCount: number;
  /** The ids of those records — a decided band reads *record removed* when its STAMPED
   *  attachment is no longer among them, never by comparing it with the newest. */
  presentRecordIds: string[];
};

/** A decision's port as a surface draws it — the parse plus its sections' resolved
 *  work-item links (bug MOTIR-10023); see {@link DecisionChoicePortViewDTO}. */
export type DecisionConfirmationPortViewDTO = DecisionConfirmationPortDTO & {
  workItemRefs: WorkItemRefMap;
};

/** One key a decision supersedes, as the port's work-item chip draws it (MOTIR-5960). */
export interface SupersededItemDTO {
  key: string;
  title: string | null;
}

/** The ONE reason a decision's body cannot be asked yet — the closed set point 3 fixes. */
export type DecisionDefectDTO = DecisionDefect;

/**
 * WHAT THE ITEM PAGE KNOWS ABOUT A DECISION'S BODY, gate or no gate (MOTIR-5954,
 * the card's point 6). A defective body raises no gate, so the page cannot learn
 * its state from one: this carries the parse itself, and the port renders the
 * defect state from it (MOTIR-5960). Null for a work item that is not a `human`
 * decision.
 */
export type DecisionConfirmationBodyDTO =
  | { ok: true; port: DecisionConfirmationPortDTO }
  | {
      ok: false;
      defect: DecisionDefectDTO;
      draft: DecisionDraft;
      record: ConfirmedRecordDTO;
      supersedesItems: SupersededItemDTO[];
      recordCount: number;
      presentRecordIds: string[];
    };

/**
 * WHICH DECISION is waiting, at row scale (MOTIR-5954) — read from the work item's
 * own body. What a DECIDED row says about the record is the gate's own stamp
 * (`confirmedRecord`), never re-read from a body that may since have changed.
 */
export interface DecisionConfirmationSubjectSummaryDTO {
  kind: 'decision_confirmation';
  /** The `## Decision` section's first line, as written. */
  decision: string;
  /** The `**Change:**` values. */
  changes: DecisionChange[];
  /** How many work items `## Supersedes` names. */
  supersedesCount: number;
}

export interface DecisionChoiceSubjectSummaryDTO {
  kind: 'decision_choice';
  /** How many options the body offers. */
  optionCount: number;
  /** The `## Question`, as written. */
  question: string;
}

/**
 * A gate whose KIND THIS BUILD REGISTERS NO RENDERER FOR — a real row on the
 * day this ships, not a defensive branch.
 *
 * `lib/approvalGates/registry.ts` registers four kinds and names the fifth as a
 * declared hole: `pull_request_merge`, which MOTIR-5616 RETIRED — built once,
 * withdrawn, and never to be registered again. (`decision_approval` was the other
 * hole until MOTIR-5676 built it.) A gate carrying it can exist — one of the
 * superseded merge rows the backfill left — and the honest answer is a row that
 * SAYS the kind is not built here, which is exactly what `UNREGISTERED_GATE_KINDS`
 * exists at runtime to let a surface do.
 */
export interface UnregisteredSubjectSummaryDTO {
  kind: Exclude<
    ApprovalGateKindDTO,
    | 'design_result'
    | 'decision_approval'
    | 'acceptance_result'
    | 'pull_request_approval'
    | 'decision_choice'
    | 'decision_confirmation'
    | 'plan_approval'
    | 'planning_session'
    | 'manual_work'
  >;
}

/**
 * WHAT MANUAL WORK a row is waiting on (MOTIR-7474; `docs/decisions/manual-work-gate.md`
 * §7) — the card IS the subject, so the row's title is the card's; this carries the
 * progress the row prints beside it: `<done>/<total> steps` from the card's to-do list,
 * or `todos: null` when the card has no list.
 */
export interface ManualWorkSubjectSummaryDTO {
  kind: 'manual_work';
  todos: { done: number; total: number } | null;
  /**
   * THE STAMP the row's MARK DONE presents (Story MOTIR-7460 · MOTIR-7478; design
   * `design/workbench/design-notes.md` § 33.2). This kind is the one row that DECIDES
   * from the row (ADR `manual-work-gate.md` §5), so the row is a render the decide door
   * compares against — computed from the same card read this summary is, by the one
   * definition (`computeGateStamp`). A decided record carries it too, and nothing
   * presses one.
   */
  stamp: string;
}

/**
 * THE MANUAL-WORK PORT (Story MOTIR-7460 · MOTIR-7478; design § 33.3) — the card's to-do
 * list in its read face, and whether Mark done will write Done itself or record the
 * decision for the merge to finish (`merge_writes_done`, ADR §4).
 */
export interface ManualWorkPortDTO {
  /** The card's to-do rows, in list order — drawn read-only; the port ticks nothing. */
  todos: WorkItemTodoDto[];
  progress: TodoProgressDto;
  /** The rows' notes' work-item links, resolved for the reader (bug MOTIR-10023). */
  workItemRefs: WorkItemRefMap;
  /** True when the card has an OPEN delivering pull request: Mark done then records the
   *  decision and the merge writes Done (`manualWorkHandler.approve`). */
  mergeWritesDone: boolean;
}

/**
 * A PLAN GATE IS HELD while the planner rewrites the plan (MOTIR-6035; ADR §11.5c):
 * the gate stays `awaiting` and both verbs are refused with `PlanRevisionInFlightError`
 * until the revision lease ends. `heldBy` is the revising agent's harness, or null.
 */
export interface PlanGateHeldDTO {
  reason: 'revision_in_flight';
  heldBy: string | null;
  /** ISO-8601 — when the lease lapses if the revision writes nothing more. */
  expiresAt: string;
}

/**
 * WHICH PLAN is waiting, at row scale (Story MOTIR-6012 · MOTIR-6035; design
 * `design/ai-planning/design-notes.md` Part XXII §22.3's field table). A plan gate has no
 * card (`workItem` is null on its row), so everything the row draws is here.
 */
export interface PlanApprovalSubjectSummaryDTO {
  kind: 'plan_approval';
  /** The plan — the gate's `subjectId`; the row's `href` is `/plans/<planId>`. */
  planId: string;
  /** The plan's conversation (the `planSession` address), or null when it has none. */
  sessionId: string | null;
  /**
   * Whether that conversation has any turns.
   *
   * ⚠️ IT DECIDES NO DESTINATION any more (Story MOTIR-6043 · MOTIR-6045). It used to:
   * *"the row opens the planning overlay when it does, and the plan page when it does
   * not"*. `docs/decisions/mcp-authored-plan-review.md` overturned that — an empty
   * transcript is not an absent conversation — and §11.5b now keys on `sessionId`
   * alone, for both this row and the Plans page's. Kept on the wire because it is a
   * true fact about the session that another reader may want; nothing gates on it.
   */
  sessionHasTurns: boolean;
  /** `Plan.title`, as written, or null. */
  title: string | null;
  /** The project's name — the leading line's last fallback. */
  projectName: string;
  /** What the plan re-plans: the session's `targetKeys` in stored order, each with the
   *  target's title (null when the key no longer resolves in the project). */
  targets: { key: string; title: string | null }[];
  /** How many proposals the plan holds. */
  proposalCount: number;
  /** Who WROTE the plan — the details cell's author (`written by …` / `planned
   *  automatically`). Never the requester: the gate is routed to them. */
  author: {
    source: PlanAuthorSourceDto | null;
    harness: string | null;
    origin: PlanOriginDto;
  };
  /** Being rewritten — the row's `Being rewritten` pill (§11.5c), or null. */
  held: PlanGateHeldDTO | null;
}

/**
 * WHICH PLANNING SESSION is waiting on its person, at row scale (Story MOTIR-7905 ·
 * MOTIR-7913). A `planning_session` gate has no card, so everything the row draws is
 * here. The naming fields are shaped as {@link PlanApprovalSubjectSummaryDTO}'s so the
 * row reuses the plan-naming forms; the real rendering is the Workbench card's.
 */
export interface PlanningSessionSubjectSummaryDTO {
  kind: 'planning_session';
  /** The session — the gate's `subjectId`. */
  sessionId: string;
  /** The session's latest plan, or null when it has none yet. */
  planId: string | null;
  /** WHY the session waits: the planner's `question`, or the conversation's `reply`. */
  cause: 'question' | 'reply';
  /** The planner's question, verbatim — set for the `question` cause. */
  question: string | null;
  /** The planner's last line — set for the `reply` cause. */
  plannerLine: string | null;
  /** ISO-8601 — when the session began waiting. */
  since: string;
  /** `Plan.title`, as written, or null. */
  planTitle: string | null;
  /** The session's first target key, or null for a project-wide session. */
  targetKey: string | null;
  /** That target's title, or null when it has none or the key no longer resolves — what the
   *  row's `targeted` plan-naming form reads (MOTIR-7917). */
  targetTitle: string | null;
  /** The project's name — the leading line's last fallback. */
  projectName: string;
}

/**
 * What a row says about the thing being decided, per kind.
 *
 * ⚠️ TOTAL OVER `ApprovalGateKind`, not over the kinds somebody had in mind —
 * and the assertion that keeps it total lives in
 * `lib/approvalGates/subjectSummary.ts`, because THIS file is imported by client
 * modules and the registry is not (see `GateDecision`'s note above on why the
 * boundary is enforced by import SITE). Adding a fifth enum member fails the
 * build there, which is the registry's own guarantee extended to the read.
 */
export type ApprovalGateSubjectSummaryDTO =
  | DesignResultSubjectSummaryDTO
  | DecisionApprovalSubjectSummaryDTO
  | PullRequestApprovalSubjectSummaryDTO
  | AcceptanceResultSubjectSummaryDTO
  | DecisionChoiceSubjectSummaryDTO
  | DecisionConfirmationSubjectSummaryDTO
  | PlanApprovalSubjectSummaryDTO
  | PlanningSessionSubjectSummaryDTO
  | ManualWorkSubjectSummaryDTO
  | UnregisteredSubjectSummaryDTO;

/** The card a gate hangs off, as a queue row identifies it. */
export interface ApprovalQueueWorkItemRefDto {
  id: string;
  key: number;
  identifier: string;
  title: string;
  kind: WorkItemKindDto;
  /** The leaf's work TYPE (`design` / `code` / …); null on a container. */
  type: WorkItemTypeDto | null;
}

/**
 * ONE row of the Approvals tab: a live question, the card it is about, and
 * enough of its subject to answer it from the list.
 *
 * `state` is narrowed to `'awaiting'` rather than carried as the full union,
 * because this read returns nothing else — a decided gate is not something
 * anybody is waiting on. A row that could be `approved` would invite a renderer
 * to draw a state this read cannot produce.
 */
export interface ApprovalQueueRowDto {
  gateId: string;
  kind: ApprovalGateKindDTO;
  state: Extract<ApprovalGateStateDTO, 'awaiting'>;
  /**
   * Whether THIS reader may press this gate's verbs — the AUTHORITY answer, and
   * NEVER the routing one.
   *
   * ⚠️ IT IS NOT IMPLIED BY THE ROW'S PRESENCE, which is the trap. Routing is
   * `assigneeId ?? reporterId`, so every row in your own queue satisfies ADR
   * §2's RELATIONSHIP arm by construction — and it is tempting to conclude the
   * flag is always `true` and hardcode it. The PERMISSION FLOOR is the other
   * half the decide door applies (`work_item:edit` for `design_result`, *"on
   * top of it, not instead of it"*), and a project `viewer` can be an assignee.
   * Such a reader is routed a gate they may not decide, and a surface that
   * derived its own answer would draw verbs the door then refuses — the exact
   * disagreement `approvalGatesService.getForWorkItem` records.
   */
  canDecide: boolean;
  /**
   * WHOSE DECISION THIS IS — the name the row's *waiting on* line draws when the
   * reader may see the gate but not press it (Panel 5, `design/workbench/design-notes.md`
   * § 20; MOTIR-5191). Null when the routing resolves to nobody or to a user row
   * that has gone, and the frame draws its generic fallback instead.
   *
   * ⚠️ IT IS THE LIVE ROUTING ANSWER, and on this read that is very nearly
   * always the READER — the predicate selected these rows BY it. It is carried
   * per row anyway rather than being taken from the session, because a row that
   * names its own recipient keeps saying something true if §2's routing is ever
   * widened past one person, and a surface reading the session would not.
   */
  routedToName: string | null;
  /** ISO-8601 — when the question was asked. The row renders how long ago. */
  waitingSince: string;
  /**
   * The card the gate hangs off — NULL for a gate that belongs to NO work item, a
   * `plan_approval` (Story MOTIR-6012 · MOTIR-6034; ADR `approval-gates.md` §11.1).
   * What such a row is about is its `subject`; it opens the planning surface, never
   * the overlay (§11.5b), and drawing it is MOTIR-6037's.
   */
  workItem: ApprovalQueueWorkItemRefDto | null;
  /**
   * What is being decided — or NULL when the gate's subject no longer resolves.
   *
   * ⚠️ NULL IS A THIRD ANSWER, not a missing one, and it is distinct from the
   * not-built-yet arm above. *This build cannot render this kind* and *the row
   * this gate points at is gone* are different facts about a row, and a reader
   * needs to be told which: the first is a feature that has not shipped, the
   * second is a gate worth withdrawing. ADR §6a already admits the second — a
   * handler's `resolveSubject` is documented to return null — so a queue that
   * collapsed it into the unregistered arm would report a shipped kind as
   * unbuilt.
   */
  subject: ApprovalGateSubjectSummaryDTO | null;
}

/**
 * The To-approve tab's WHOLE awaiting set (Story MOTIR-5996 · MOTIR-5998).
 *
 * ⚠️ NO PAGE. It used to be `HomePageDto`'s offset window under the strip's shared
 * `IssueListPager`; the tab now lists everything routed to its reader, because a
 * pager on one person's short queue only hides its oldest questions. The read is
 * bounded by `APPROVAL_QUEUE_CEILING`, and `truncated` is how that bound is SAID
 * rather than hidden: `total` is the size of the whole set, `items` what was read.
 */
export interface ApprovalQueueDto {
  items: ApprovalQueueRowDto[];
  /** The size of the WHOLE awaiting set — the tab's count. */
  total: number;
  /** `total > items.length`: the ceiling cut the set, and the list must say so. */
  truncated: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE APPROVALS ROOM's READ (Story MOTIR-5299 · MOTIR-5301) — every approval
// record a reader may see in the active project, pending first then decided.
// The shape is `design/approvals/design-notes.md` § GIVES / TAKES's requirements
// on this read, not a choice made here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE decided record: the question, the card, and the AUDIT set that makes it a
 * record rather than a list entry — who decided, when, and on which bytes.
 *
 * `state` is narrowed to the two DECISIONS. `superseded` is neither pending nor
 * decided (ADR §6b: nobody decided it), and the room lists it nowhere, so a row
 * that could carry it would invite a renderer to draw a state this read cannot
 * produce.
 */
export interface ApprovalRecordDecidedRowDto {
  gateId: string;
  kind: ApprovalGateKindDTO;
  /** `declined` joined with MOTIR-6037: a plan a person ENDED is a decision the room
   *  lists (design `design/ai-planning/design-notes.md` Part XXII §22.3, Panel 3). */
  state: Extract<
    ApprovalGateStateDTO,
    'approved' | 'changes_requested' | 'overturned' | 'declined'
  >;
  /** ISO-8601 — when the decision was recorded. The section's sort key. */
  decidedAt: string;
  /**
   * WHO decided, as recorded AT the decision (`Name <email>`) — the column that
   * survives the user's deletion where `decidedById`'s `SetNull` FK does not.
   * Null only on a row decided before the audit columns existed.
   */
  decidedByLabel: string | null;
  /**
   * THROUGH WHICH SURFACE the decision arrived (Story MOTIR-4910 · MOTIR-5599). The room's
   * person cell reads it to add the *on GitHub* suffix, because *who* and *where* are one
   * question in a 144px cell. Null on a row decided before the audit columns existed.
   */
  decisionSource: ApprovalGateDecisionSourceDTO | null;
  /**
   * The immutable version the decision was made against — ADR §6a's field that
   * *carries the whole claim*. Null where the kind records none.
   */
  subjectVersion: string | null;
  /** ISO-8601 — when the question was asked. */
  waitingSince: string;
  /** The card — NULL on a card-less (`plan_approval`) record (ADR §11.1, MOTIR-6034). */
  workItem: ApprovalQueueWorkItemRefDto | null;
  /** What was decided, or NULL when the gate's subject no longer resolves. */
  subject: ApprovalGateSubjectSummaryDTO | null;
  /**
   * WHAT A CHOICE PICKED (MOTIR-5897) — read off the immutable row, so a decided choice
   * names its option even after the body changed. Null on every other kind, and on a
   * choice sent back with *None of these*.
   */
  chosenOption: ChosenOptionDTO | null;
  /**
   * WHAT A CONFIRMED DECISION'S RECORD WAS (MOTIR-5961) — off the immutable row, so the
   * row says *with* or *without a written record* after the body changed. Null on every
   * other kind and on an overturned decision.
   */
  confirmedRecord: ConfirmedRecordDTO | null;
  /**
   * WHAT A REFUSAL ASKED FOR (Story MOTIR-6067 · MOTIR-6075; ADR `approval-gates.md` §10a–b)
   * — the gate's `noteMd`, on a `changes_requested` row, and on a `declined` plan row
   * (MOTIR-6037; its reason is OPTIONAL, ADR §11.4). Null on every other state:
   * an approval's note (a synced approval's review list) and an overturn's note are not a
   * refusal's reason, and the row does not quote them. With `decisionSource` it says where
   * the reason came from — a GitHub review with no body is null here.
   */
  refusalReason: string | null;
  /**
   * WHAT THE REFUSAL MEANT (MOTIR-6421; ADR §10d) — `revise` / `re_plan` on a
   * `design_result` row sent back from Motir, off the immutable row. Null on every other
   * state and kind, and on a GitHub-synced refusal.
   */
  refusalVerdict: ApprovalGateRefusalVerdictDTO | null;
}

/** One SECTION of the room: its rows on this page, and its total over every page. */
export interface ApprovalRecordsSectionDto<Row> {
  items: Row[];
  /**
   * The section's total across the whole list, not this page's count — the section
   * heading carries it, so a reader on page 3 still knows how many are waiting.
   */
  total: number;
}

/**
 * The room's one page.
 *
 * ⚠️ THE SECTION BOUNDARY IS HERE, NOT INFERRED DOWNSTREAM. `awaiting` precedes
 * `decided`, and a surface renders the two sections rather than grouping rows by a
 * state field.
 *
 * ⚠️ ONE WINDOW OVER THE CONCATENATION. `page` / `pageSize` window the ordered list
 * *pending-then-decided*, and `total` is `sections.awaiting.total +
 * sections.decided.total` — the pager's denominator, which therefore cannot
 * disagree with the rows. A page can hold rows of both sections, or of only one.
 */
export interface ApprovalRecordsPageDto {
  /**
   * Whether the SERVED view is the whole project's — `scope === 'project'`. A FACT
   * ABOUT THE ANSWER, kept beside `scope` for its existing readers; the surface
   * keys its copy and the person column on it (never on holding the key: a
   * key-holder looking at Mine must not see their own name on every row).
   */
  fullView: boolean;
  /**
   * The view the service SERVED (Story MOTIR-6179 · MOTIR-6333). The caller only
   * ASKS for one; `project` is served only to a reader holding `approval:view_any`.
   */
  scope: 'mine' | 'project';
  /**
   * The views this reader HAS, in switch order — the page draws the Mine /
   * Project switch only when both are here, and the not-found face when none is.
   */
  views: ('mine' | 'project')[];
  sections: {
    awaiting: ApprovalRecordsSectionDto<ApprovalQueueRowDto>;
    decided: ApprovalRecordsSectionDto<ApprovalRecordDecidedRowDto>;
  };
  total: number;
  page: number;
  pageSize: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE APPROVAL OVERLAY's READ (Story MOTIR-5214 · Subtask MOTIR-5223) — what
// `GET /api/work-items/approval-gate` answers for ONE work item and ONE kind.
//
// The overlay is addressed by a URL that can be pasted into a cold tab, so it
// holds no queue row to hand a server action: it asks for the gate, whether
// this reader may decide it, and the subject the port renders, in one read.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the PORT has to render, per kind — FOUR answers, and none of them is an
 * absence of an answer.
 *
 * ⚠️ `no_gate`, `kind_not_built` and `gone` ARE DIFFERENT FACTS, and a surface
 * that collapsed any two would tell the reader something false
 * (`design/workbench/design-notes.md` § 20 refuses the same collapse on a row):
 * the card has no question of this kind · this build cannot render this kind
 * yet · the bytes this question was about no longer resolve.
 */
export type ApprovalGateOverlaySubjectDTO =
  | { state: 'no_gate' }
  | { state: 'kind_not_built' }
  | { state: 'gone' }
  | {
      state: 'resolved';
      kind: 'manual_work';
      /** THE MANUAL-WORK PORT (Story MOTIR-7460 · MOTIR-7478) — the card's to-do list. */
      manualWork: ManualWorkPortDTO;
    }
  | {
      state: 'resolved';
      kind: 'decision_choice';
      /**
       * THE CHOICE PORT (Story MOTIR-4914) — the parsed body the gate asks about. A
       * body that no longer parses is `gone`: there is nothing left to pick from.
       */
      choice: DecisionChoicePortViewDTO;
    }
  | {
      state: 'resolved';
      kind: 'decision_confirmation';
      /**
       * THE CONFIRM PORT (Story MOTIR-5871 · MOTIR-5954) — the parsed decision the gate
       * asks about, with the record it would stamp. A body that no longer parses is
       * `gone`: there is nothing left to confirm.
       */
      confirm: DecisionConfirmationPortViewDTO;
    }
  | {
      state: 'resolved';
      kind: 'design_result';
      /** The version the gate asks about — read by the gate's `subjectId`. */
      evidence: DesignEvidenceDTO;
      /** `DesignGateSubjectDTO.filesKept`, off the row rather than the state. */
      filesKept: boolean;
    }
  | {
      state: 'resolved';
      kind: 'acceptance_result';
      /**
       * The RECORDING the gate asks about — read by the gate's own `subjectId`, so a
       * decided gate shows the receipt that was decided on, never whichever one is
       * current now (MOTIR-4950).
       */
      evidence: AcceptanceEvidenceDTO;
    }
  | {
      state: 'resolved';
      kind: 'pull_request_approval';
      /**
       * THE DEVELOPMENT BLOCK'S DATA (Story MOTIR-5437 · Subtask MOTIR-5439) — the
       * approve-and-merge gate's port is the item page's Development block
       * (`design/github/design-notes.md` § 20), so the overlay reads exactly what
       * `LateUpperSections` hands `DevelopmentSectionBody`, from the same services.
       * Two surfaces reading one block from two different reads could disagree about
       * which pull requests exist; these cannot.
       *
       * ⚠️ `kind` NAMES THE PORT, NOT THE GATE. A DESIGN gate that carries an awaiting
       * merge gate is answered with this arm too, because one press on it merges the
       * set and the reader must see what it merges (Bug MOTIR-5712; `design-result.md`
       * AMENDMENT 6 Q1). The gate itself is the read's `gate`, which is what is pressed.
       */
      pullRequests: LinkedPullRequestDto[];
      /** `workItemsService.getDeliveryView(…).repos` — the item's repository set,
       *  amended by its delivery set, verbatim. */
      repoDelivery: RepoDelivery[];
      /** `workItemsService.getDeliveryView(…).deliveries` — the delivery set itself. */
      deliveries: WorkItemDeliveryDto[];
      /** The block's second part. `record_missing` is an ANSWER here, not an error. */
      howToTest: HowToTestDto;
      /**
       * A STORY RUN's receipt and its gate (MOTIR-5790), or null — the Development block's
       * SUBJECT when the story's acceptance leads, exactly as `designEvidence` is a design
       * card's. Read for every card and null for any card with no receipt.
       */
      acceptanceEvidence: AcceptanceEvidenceDTO | null;
      acceptanceGate: ApprovalGateDTO | null;
      /**
       * The card's CURRENT design result, or null. On a card with an open linked pull
       * request the result renders inside this block rather than as its own section
       * (`design-result.md` AMENDMENT 4 Q8), so the port needs it.
       */
      designEvidence: DesignEvidenceDTO | null;
      /** Whether the card is a `design` leaf — `DesignResultPanel`'s own input. */
      isDesignCard: boolean;
      /**
       * What a reload still knows about each member once the gate is APPROVED — the
       * item page's `mergeGate.members`, read under the same condition. Empty for any
       * other state: before the press nothing merged, and a withdrawn question merged
       * nothing.
       */
      members: PullRequestApprovalMemberDTO[];
      /**
       * The approve-to-merge gate's version — its delivery SET — when a PRIMARY leads the
       * block beside a merge question: a story's acceptance (Bug MOTIR-6079), a design or a
       * decision (Bug MOTIR-6080). The item page's `mergeSubjectVersion`, read off the same
       * gate. No primary's own version is a delivery set, so the frame names what one press
       * merges, and lands each member's outcome on its row, only through this. Absent for
       * the approve-to-merge gate's own port, and for a decision with no merge question.
       */
      mergeSubjectVersion?: string | null;
      /**
       * THE DECISION PORT (Story MOTIR-4907 · Subtask MOTIR-5678; design §27 Panel 7) —
       * present exactly when the gate is a `decision_approval`: the document read through
       * the resolver ON THE SERVER, drawn first in the block with no How to test. `document`
       * is null when nothing has been captured yet.
       */
      decision?: { document: DecisionDocumentViewDTO | null };
      /**
       * `motir fix` AS THE PAGE OFFERS IT (Story MOTIR-5799 · MOTIR-5806; § 28 panel 7).
       * The overlay composes the same Development block, and before this it composed it
       * WITHOUT the repair part — so a person deciding in the overlay was shown the
       * approve and not the repair, on exactly the failures where the repair is the
       * answer. `hidden` when the claim would refuse, which is the predicate the page
       * and the claim already share.
       */
      repair?: WorkItemRepairViewDto | null;
      /**
       * THE AGENT REVIEW THE PORT IS ABOUT (Story MOTIR-1626; ADR `approval-gates.md` §12.3) —
       * present exactly when the address names an `agent_review` gate: its state, the
       * could-not-run reason and the review run, which the frame draws as its band above
       * the delivery set. The item page reads the same DTO (`agentReviewViewService`), so the
       * card and the overlay cannot disagree about why the review is waiting.
       */
      agentReview?: AgentReviewViewDto | null;
    };

/** The overlay's one read. */
/**
 * One workflow status as the approval overlay NAMES it (Story MOTIR-6070 · Subtask
 * MOTIR-6427) — enough for a `StatusPill` and for the design band's *goes back to
 * {status}*, and nothing a picker would need.
 */
export interface ApprovalOverlayStatusDTO {
  key: string;
  label: string;
  category: StatusCategoryDto;
  isInitial: boolean;
}

export interface ApprovalGateOverlayReadDTO {
  /**
   * The card the address named — what the overlay's header identifies.
   *
   * `status` is its status KEY, drawn as a chip in the header and repainted from the
   * decision's `statusWritten` (MOTIR-6427; design panel 5b). `parentIdentifier` is where a
   * design's Re-plan opens the planner — the card's PARENT (§10h's anchor) — read only for
   * a `design_result` address, and null for every other kind and for a parentless card.
   */
  workItem: {
    id: string;
    identifier: string;
    title: string;
    status: string;
    parentIdentifier: string | null;
  };
  /**
   * The project's workflow statuses, in position order (MOTIR-6427) — what labels the
   * header's chip before and after a press, and which names the status a design sent back
   * returns to (the initial `todo`-category one, `returnCardToTodo`'s own rule).
   */
  statuses: ApprovalOverlayStatusDTO[];
  /** The gate of the asked kind, whatever its state; null when the card has none. */
  gate: ApprovalGateDTO | null;
  /** The AUTHORITY answer (`approvalGatesService.getForWorkItem`), never the routing one. */
  canDecide: boolean;
  /**
   * May this reader open the planner on the card — `WorkItemPlanEntrance`'s condition: the
   * project's `work_item:edit` and a card that is not archived (Story MOTIR-6068 ·
   * MOTIR-6211). A refused decision's record offers **Re-plan with AI** only when true.
   */
  canReplan: boolean;
  /** Whose decision it is waiting on, as a name — the frame's state `B` line. */
  routedToLabel: string | null;
  /**
   * WHAT THIS READER IS BEING SHOWN — hand it back with the press (Story MOTIR-5232 ·
   * Subtask MOTIR-5234; `WorkItemGateRead.stamp`). Opaque: compare nothing, parse
   * nothing. Null when the gate is not `awaiting`.
   */
  stamp: string | null;
  /**
   * WHAT HAS MOVED since the stamp the caller presented as `?since=` — empty when
   * nothing has, and when none was presented (Story MOTIR-5238 · Subtask
   * MOTIR-5243).
   *
   * ⚠️ THE SERVER ANSWERS THIS, and the client must not try to. The stamp is one
   * opaque token precisely so that nobody parses it; naming WHICH component moved
   * needs the composite, and the comparison is `stampMoved` — the decide door's
   * own — so a notice drawn before a press and the refusal met after it can never
   * disagree.
   */
  movedSince: StampComponent[];
  /** The approval a RE-ASKED merge gate replaced (MOTIR-5863) — `WorkItemGateRead.earlierApproval`. */
  earlierApproval: EarlierApprovalDTO | null;
  subject: ApprovalGateOverlaySubjectDTO;
}

/**
 * One member of an approve-and-merge set as the Development frame reads it BACK after a reload
 * (Story MOTIR-4909 · Subtask MOTIR-5484) — the two facts that outlive the press's response.
 *
 * ⚠️ NO REFUSAL REASON. The press does not persist one, so a reloaded page can say a pull
 * request has not merged yet and offer the retry, and must never say why.
 */
export interface PullRequestApprovalMemberDTO {
  /** `owner/name#number@headSha`, as the approval named the member. */
  subjectVersion: string;
  /** The pull request the member names, while this card still delivers it (MOTIR-5613) —
   *  what *Retry merge* presses, together with the card's own gate. */
  pullRequestId: string | null;
  /** The press handed it to its repository's merge queue, and it has not merged yet. */
  queued: boolean;
  /** Motir has neither merged nor queued it yet, so it can be tried again under the
   *  approval that already stands. No second gate is involved. False while the member
   *  carries a merge-queue exit that has not been put back — that member offers
   *  {@link requeueable} instead. */
  retryable: boolean;
  /** The pull request's latest merge-queue EXIT (MOTIR-5632), or null when the queue
   *  never removed it. The failing check's name and link are MOTIR-5633's. */
  exit: PullRequestQueueExitDTO | null;
  /** The latest exit has not been put back, and the pull request is still at the head
   *  the approval named — the exit still describes the approved code, whatever its
   *  disposition. False once a push moved the head (*New commits since approval*). */
  exitAtApprovedHead: boolean;
  /** The row's verb — *Queue again* for a queue exit, *Retry merge* for a refused merge —
   *  is offered: {@link exitAtApprovedHead}, and the pull request is open.
   *  ⚠️ NEVER ON A SPENT APPROVAL (MOTIR-5802; §4 FOURTH AMENDMENT, points 1 and 4).
   *  An un-landed outcome of ANY disposition, NEUTRAL included, spends the approval that
   *  preceded it, so the DECIDED gate offers no verb at all; the card is asked again and
   *  the verb rides on the re-asked gate, whose id is {@link retryDecidesGateId}. The
   *  frame reads `exit.disposition` to word the row, never to decide this. */
  requeueable: boolean;
  /** The HOST's latest refusal of this member, while it still STANDS — nothing
   *  superseded it and the head it names is still the pull request's (MOTIR-5833;
   *  §4 FOURTH AMENDMENT, point 5). Null when the host has refused nothing, or when a
   *  push or a later successful press has retired it. It is what lets a RELOAD say why
   *  the merge did not land: before this the refusal lived only in the press's
   *  response. `landingClass` is the shared class map's answer, so the row can say
   *  whether anything can be done about it. */
  refusal: {
    /** The host's own code, verbatim (`MergeRefusalCode`). */
    code: string;
    landingClass: 'retryable' | 'cant_land' | 'setting' | 'landed';
    refusedAt: string;
    /** `app_permission_missing` only — the permission the host said it needed. */
    permission: string | null;
    /** The host's OWN message, verbatim, or null when it gave none (Bug MOTIR-6735).
     *  For a `branch_protected` refusal it is what names the setting that refused the
     *  merge, which the refusal's code alone cannot. */
    reason: string | null;
  } | null;
  /** WHICH GATE the row's press DECIDES (MOTIR-5802; §4 FOURTH AMENDMENT, point 4) — the
   *  re-asked `awaiting` gate, so pressing *Queue again* / *Retry merge* IS the new
   *  approval. Null on a decided gate, where a press carries out a decision already made
   *  and never re-decides it. */
  retryDecidesGateId: string | null;
}

/** One merge-queue removal as a surface reads it (MOTIR-5632 · MOTIR-5634). */
export interface PullRequestQueueExitDTO {
  /** The host's own reason string, verbatim — the frame words it. */
  rawReason: string;
  disposition: 'failure' | 'neutral';
  /** The head the pull request left the queue at. */
  headSha: string;
  exitedAt: string;
  /** When *Queue again* put it back; null while the exit stands. */
  requeuedAt: string | null;
  /** The merge-queue check that failed, and its page (MOTIR-5633). Both null when no
   *  check is known — a conflict, a neutral removal, or a check nobody could tie back;
   *  the frame then states the reason alone. */
  failingCheckName: string | null;
  failingCheckUrl: string | null;
  /** That check's RAW GitHub conclusion (`failure`, `cancelled`, `timed_out`, …), null
   *  when no check is known (§4 SIXTH AMENDMENT, MOTIR-6846). */
  failingCheckConclusion: string | null;
}

/** A pull request the merge queue removed and nobody has put back, on a card with NO
 *  approval gate — an `auto` project (MOTIR-5635; design § 22, E5). */
export interface PullRequestStandingExitDTO {
  pullRequestId: string;
  /** `owner/name`, as the row names its repository. */
  repo: string;
  number: number;
  exit: PullRequestQueueExitDTO;
  /** *Queue again* is honest: the pull request is open and still at the head it left at. */
  requeueable: boolean;
}

/** One member of an approve-and-merge press, and what happened to it (MOTIR-5483). */
export type ApproveAndMergeMemberOutcomeDTO =
  | {
      /** The member as the approval named it: `owner/name#number@headSha`. */
      subjectVersion: string;
      pullRequestId: string;
      outcome: 'merged' | 'enqueued';
    }
  | {
      subjectVersion: string;
      /** Null when the member was refused before a pull request could be resolved. */
      pullRequestId: string | null;
      outcome: 'refused';
      /** The refusal in the frame's vocabulary — MOTIR-4882's union for a host refusal. */
      refusal: GateRefusal;
    }
  | {
      subjectVersion: string;
      pullRequestId: null;
      /** ⚠️ SINCE MOTIR-5613 THIS NAMES NO GATE: this card no longer delivers that pull
       *  request at the head it was approved at, so there is nothing to merge. The literal
       *  is kept until MOTIR-5615 renames it with the frame's copy. */
      outcome: 'no_merge_gate';
    };

// ── THE DECISION RECORD, FOR A PROGRAMMATIC READER (Bug MOTIR-6191) ─────────
//
// Every door onto `ApprovalGate.noteMd` used to be session-authed, so an agent
// holding a workspace PAT — or a CLI-minted token — could not read the answer to
// the question it had been asked. The gate kind that hurt most is
// `decision_approval`, raised ONLY on a `type: decision` + `executor:
// coding_agent` card (§8's FIFTH AMENDMENT): the one kind whose author is always
// an agent was the one kind whose refusal an agent could not read.
//
// ⚠️ IT IS A READ AND ONLY A READ. Nothing here widens who may DECIDE a gate:
// deciding stays session-authed behind `approval:decide_any`, and §2's
// ungrantable-by-derivation paragraph is untouched — an agent-written approval
// would put a decision nobody made into the one table an audit trusts. Reading a
// decision a PERSON already made is the opposite question and leaks no authority.
//
// ⚠️ AND IT IS A PROJECTION OF {@link ApprovalGateDTO}, NOT A SECOND SHAPE.
// The fields are §6a's audit set — what was decided (`subjectVersion`), by whom
// (`decidedByLabel`), when, under which permission, through which surface, what
// it caused, and THE NOTE — so the record an auditor reads on the item page and
// the record an agent reads over the wire cannot disagree about a column. What is
// deliberately dropped is the render machinery a surface needs and a caller
// cannot act on: `canDecide` (an agent may never decide), the stamp pair, the
// port's `subjectId`, `held`.

/**
 * ONE gate's decision record, as a token-authed caller reads it.
 *
 * @see ApprovalGateDTO — the full render shape this projects.
 */
export interface ApprovalGateDecisionDTO {
  id: string;
  kind: ApprovalGateKindDTO;
  state: ApprovalGateStateDTO;
  /** ⚠️ THE FIELD THIS DOOR EXISTS FOR — why they said yes, or WHAT THEY SENT
   *  BACK. Null while `awaiting`, and on a `superseded` row, which carries no
   *  decision at all (§6b). */
  noteMd: string | null;
  /** ISO-8601, or null while `awaiting` / `superseded`. */
  decidedAt: string | null;
  /** WHO decided, surviving their departure. */
  decidedByLabel: string | null;
  /** UNDER WHICH permission they acted. */
  decidedUnderAuthority: ApprovalGateAuthorityDTO | null;
  /** THROUGH WHICH surface the decision arrived — `ui` is a human at a browser. */
  decisionSource: ApprovalGateDecisionSourceDTO | null;
  /** WHAT was decided, immutably: the subject's version at decision time. */
  subjectVersion: string | null;
  /** WHY the question was withdrawn — `superseded` rows only, and never an actor. */
  supersededCause: ApprovalGateSupersedeCauseDTO | null;
  /**
   * WHAT it caused — a merge commit sha, the status key applied, or, on an
   * approved `decision_choice`, the id of the option that was picked.
   *
   * ⚠️ THE RICHER PER-KIND PAYLOADS ARE DELIBERATELY NOT HERE. `chosenOption`
   * and `replanOwed` are on {@link ApprovalGateDTO} and are read by the surface
   * that renders that kind's frame; this record is the audit set §6a enumerates,
   * which every kind carries. A caller that needs a choice's LABEL reads the
   * card's own body — the option list is in it, and `outcomeRef` says which one.
   */
  outcomeRef: string | null;
  /**
   * WHAT THE REFUSAL MEANT — `revise` or `re_plan` — on a `design_result` gate sent
   * back from Motir (MOTIR-6421; ADR §10d). Null everywhere else. Read it beside
   * `noteMd`: the note says what to change, the verdict whether the plan itself is wrong.
   */
  refusalVerdict: ApprovalGateRefusalVerdictDTO | null;
  /**
   * WHETHER A REFUSAL OF THIS GATE ASKS FOR A VERDICT (MOTIR-6501) — true exactly where
   * a Motir press of `request_changes` must carry `revise` / `re_plan`: a `design_result`,
   * or an `acceptance_result` on a STORY RUN. False once the gate is decided or withdrawn.
   */
  offersRefusalVerdict: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * What the token-authed gate read answers for one `(work item, kind)` pair.
 *
 * ⚠️ `gate: null` IS AN ANSWER, NOT A MISS: this card has no gate of that kind,
 * so there is nothing to decide and nothing was decided. A key that does not
 * resolve, or a project the caller may not browse, is the 404 instead — the same
 * no-existence-leak answer every other work-item read gives.
 */
export interface ApprovalGateRecordDTO {
  workItemKey: string;
  workItemTitle: string;
  kind: ApprovalGateKindDTO;
  gate: ApprovalGateDecisionDTO | null;
  /**
   * WHOSE DECISION THIS IS WAITING ON, as a name — so a caller that cannot act
   * on the gate can at least say who can.
   *
   * ⚠️ THE LIVE ROUTING ANSWER, NOT THE GATE'S FROZEN `routedToId` (§2, and
   * `WorkItemGateRead.routedToLabel`'s own note). The frozen column is the audit
   * record of who was ASKED; this sentence is present tense, so on a reassigned
   * card the two name different people and both are right.
   */
  routedToLabel: string | null;
}

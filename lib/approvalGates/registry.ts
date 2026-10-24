import type {
  ApprovalGate,
  ApprovalGateKind,
  ApprovalGateRefusalVerdict,
  ApprovalGateState,
  Prisma,
  WorkItem,
} from '@/generated/prisma/client';
import type { ChosenOption } from '@/lib/approvalGates/choiceOptions';
import type { ConfirmedRecord } from '@/lib/approvalGates/decisionConfirmationRecord';
import type { PermissionKey } from '@/lib/permissions/catalog';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { ApprovalGateKindUnregisteredError } from '@/lib/approvalGates/errors';
import { acceptanceResultGateHandler } from '@/lib/approvalGates/acceptanceResultHandler';
import { agentReviewGateHandler } from '@/lib/approvalGates/agentReviewHandler';
import { decisionApprovalGateHandler } from '@/lib/approvalGates/decisionApprovalHandler';
import { decisionChoiceGateHandler } from '@/lib/approvalGates/decisionChoiceHandler';
import { decisionConfirmationGateHandler } from '@/lib/approvalGates/decisionConfirmationHandler';
import { designResultGateHandler } from '@/lib/approvalGates/designResultHandler';
import { manualWorkGateHandler } from '@/lib/approvalGates/manualWorkHandler';
import { planApprovalGateHandler } from '@/lib/approvalGates/planApprovalHandler';
import { planningSessionGateHandler } from '@/lib/approvalGates/planningSessionHandler';
import { pullRequestApprovalGateHandler } from '@/lib/approvalGates/pullRequestApprovalHandler';
import type { GateSettingsDoor } from '@/lib/approvalGates/settingsDoor';
import type { GateDecision } from '@/lib/dto/approvalGate';
import type { TransactionBudget } from '@/lib/workspaces/context';

// THE APPROVAL-GATE REGISTRY (Story MOTIR-4778 · Subtask MOTIR-4790; ADR
// docs/decisions/approval-gates.md §1).
//
// One decide door serves every gate kind, so the thing that VARIES by kind has
// to live somewhere the door can dispatch to without knowing what a design or a
// pull request is. That is this file: a handler per kind, and a type-level
// contract that the set of handlers is TOTAL over the Prisma enum.
//
// ⚠️ WHY TOTALITY IS THE POINT, AND WHY IT IS A TYPE RATHER THAN A TEST. The
// claim the whole story rests on is that approving means ONE thing whatever is
// being approved. A registry that is merely *usually* complete cannot carry that
// claim: the failure mode is a kind that ships its schema, its surface and its
// creation path, and reaches the door with no handler — at which point the door
// either throws an `undefined is not a function` or, worse, falls through to a
// default and decides something. Consistency maintained by discipline decays;
// consistency maintained by the compiler does not, and the check then runs on
// every build forever with nobody having to remember this paragraph.
//
// THE TWO COMPILE-TIME GUARANTEES, and they are different guarantees:
//
//   1. **A NEW ENUM MEMBER FAILS THE BUILD.** `UnregisteredGateKind` is
//      `Exclude<ApprovalGateKind, RegisteredGateKind>`, and
//      `UNREGISTERED_GATE_KINDS` below is asserted to enumerate it exactly. Add
//      a fifth member to the Prisma enum and that assertion breaks until the
//      member is classified — registered, or deliberately not.
//   2. **PROMOTING A KIND FAILS THE BUILD UNTIL ITS HANDLER EXISTS.**
//      `APPROVAL_GATE_HANDLERS` is `Record<RegisteredGateKind, GateHandler>`, so
//      moving a kind into `RegisteredGateKind` is a missing-property error until
//      somebody writes it. That is the sentence the ADR asks for: *adding the
//      decision gate later is a type error until its handler exists.*
//
// ⚠️ THE HOLES ARE DECLARED, NOT LEFT. A `Record<ApprovalGateKind, Handler |
// null>` would also fail on a new member, and it was rejected: `null` is a
// value, so `decision_approval: null` compiles silently and the hole stops being
// a decision anybody made. Naming the unregistered kinds in their own union, in
// this file, with the card that fills each, is what keeps a hole reviewable.

/**
 * The kinds THIS BUILD registers a handler for.
 *
 * MOTIR-4790 registers exactly one. That is not a partial delivery — it is the
 * shape the epic was split along: this card ships the DOOR with one kind through
 * it, and each later kind is then a row in the enum, a handler, and a renderer
 * rather than a second approval feature.
 */
// MOTIR-5481 registers the SECOND: `pull_request_approval`, the approve-and-merge gate over a
// card's delivery set that Story MOTIR-4909 decides (§8's amendment, decisions 2 and 6).
//
// ⚠️ `pull_request_merge` WAS REGISTERED HERE (MOTIR-4793) AND IS RETIRED (Bug MOTIR-5603 ·
// MOTIR-5616; §8's SECOND AMENDMENT, decision 8). A card holds ONE approve-to-merge gate, so
// the per-pull-request kind has no producer (MOTIR-5611), no decider (MOTIR-5613) and no
// surface (MOTIR-5615). It moves to the holes below rather than out of the enum: the rows it
// already wrote are superseded, not deleted, and they still reference the value.
// MOTIR-5676 registers the THIRD: `decision_approval`, the DECISION gate over the ONE
// `docs/decisions/*.md` file a `decision` + `coding_agent` card's pull request carries
// (Story MOTIR-4907; `approval-gates.md` §8's FIFTH AMENDMENT). It left the holes below
// the way §1 says a kind should arrive: a handler, a summary loader and a renderer, and
// no second vocabulary.
//
// MOTIR-4950 registers the FOURTH: `acceptance_result`, a story's acceptance receipt —
// the kind the approval vocabulary was generalised FROM (§1's evidence table), joining
// the registry at last (§1's MOTIR-5787 amendment).
//
// MOTIR-5954 registers `decision_confirmation`: a person confirms — or overturns — a
// decision the planner settled WITH them, on a `decision` + `human` work item (Story
// MOTIR-5871; §1's MOTIR-5952 amendment).
//
// MOTIR-6035 registers `plan_approval`: a PLAN, on a gate that belongs to NO work item
// (Story MOTIR-6012; ADR §11). Its verbs are Approve and a NEW Decline — no Request
// changes — and it writes a plan's status, never a work item's.
//
// MOTIR-6819 registers `agent_review`: the REVIEW AGENT's question over the run target's
// green delivery set, asked instead of the merge question while the project's switch is
// on (Story MOTIR-1626; ADR §12). Decided by the review run (`review_agent`) through an
// internal entry, or by the routed person continuing without it — never refused by one.
//
// MOTIR-7474 registers `manual_work`: a manual card a run reached, waiting on a person
// (`docs/decisions/manual-work-gate.md`). Its one verb is Mark done; it is decided by the
// work being done and withdrawn when the card stops being manual.
//
// MOTIR-7913 registers `planning_session`: a hosted planning session that needs its person
// (Story MOTIR-7905; ADR §1's MOTIR-7906 amendment). The second card-less kind; it has NO
// verbs — the person answers by sending a turn.
export type RegisteredGateKind =
  | 'design_result'
  | 'decision_approval'
  | 'acceptance_result'
  | 'pull_request_approval'
  | 'decision_choice'
  | 'decision_confirmation'
  | 'plan_approval'
  | 'agent_review'
  | 'manual_work'
  | 'planning_session';

/**
 * The kinds that are deliberately NOT registered yet — the registry's
 * compile-time holes, each owned by a named card:
 *
 * | kind                    | owner                                              |
 * | ----------------------- | -------------------------------------------------- |
 * | `pull_request_merge`    | nobody — RETIRED (MOTIR-5616)                      |
 *
 * (`plan_approval` was a NOT-YET here from MOTIR-6032 until MOTIR-6035 built it, and
 * `agent_review` from MOTIR-6818 until MOTIR-6819 built it.)
 *
 * ⚠️ THE ONE HOLE LEFT IS NOT A NOT-YET. `decision_approval` was the other, a kind
 * NOT BUILT YET with a card that would build it — and MOTIR-5676 built it.
 * `pull_request_merge` is BUILT AND WITHDRAWN: nothing owns it, nothing will
 * register it again, and a surface meeting one of its superseded rows should say
 * this build does not render the kind — which is exactly what being unregistered
 * makes it say.
 */
export type UnregisteredGateKind = Exclude<ApprovalGateKind, RegisteredGateKind>;

/**
 * The unregistered kinds, at RUNTIME — so a surface can say *"this kind is not
 * built yet"* rather than discovering it by a missing key.
 *
 * Its type is what enforces guarantee (1) above: `AssertExhaustive` below fails
 * to compile unless this tuple names every member of `UnregisteredGateKind`,
 * exactly once.
 */
export const UNREGISTERED_GATE_KINDS = [
  'pull_request_merge',
] as const satisfies readonly UnregisteredGateKind[];

// TOTALITY, asserted at the type level. `Exclude` gives us the complement of the
// registered set for free; what a type system will NOT give us for free is that
// the runtime list above kept up with it. These two lines are that check, in
// both directions — a member missing from the tuple, and a member in the tuple
// that is no longer unregistered, each fail here.
type _UnregisteredIsExhaustive = AssertEqual<
  (typeof UNREGISTERED_GATE_KINDS)[number],
  UnregisteredGateKind
>;
type _KindsAreExhaustive = AssertEqual<RegisteredGateKind | UnregisteredGateKind, ApprovalGateKind>;

/** Structural equality of two types, as a compile-time assertion. Resolves to
 *  `true` when they are identical and to an error otherwise. */
type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : { ERROR: 'approval-gate kinds are not exhaustively classified'; A: A; B: B };

/**
 * What ONE decision DID to the product, returned by a handler's verb so the door
 * can report it and a test can assert it.
 *
 * `statusWritten` is `null` when the decision moved no work item — which is the
 * ordinary answer for `request_changes`, and is also the correct answer for an
 * approval whose card has a pull request coming (see the design-result handler).
 */
export interface GateEffect {
  /** The status key the decision wrote onto the work item, or null when it wrote
   *  none. */
  statusWritten: string | null;
  /** Why no status was written, when none was — for the report and the record.
   *  Absent when `statusWritten` is set. */
  statusDeferredReason?:
    | 'merge_writes_done'
    /** An acceptance approval on a story with live work under it: the parent
     *  rollup writes `done` when the last child completes (MOTIR-4950;
     *  `approval-gates.md` §1's MOTIR-5787 amendment, point 7). */
    | 'rollup_writes_done'
    | 'request_changes_moves_nothing'
    /** A STORY RUN's acceptance sent back with Re-run or Re-plan (MOTIR-6503;
     *  `acceptance-refusal-verdict.md` §3): no status is written, and the story's other
     *  waiting approvals — its merge gate — are withdrawn `pulled_back` and held. */
    | 'acceptance_refusal_withdraws_merge_only'
    | 'no_status_in_target_category'
    /** A `plan_approval` decision (ADR §11.5): what approve and decline change is the
     *  PLAN's status. Approve's materialize writes work-item statuses on each item's own
     *  history, and those are the plan's effects, never this gate's `outcomeRef`. */
    | 'plan_decision_writes_no_work_item'
    /** An `agent_review` decision (ADR §12.4): it owns no transition. A pass raises the
     *  ordinary flow, which owns its own writes; the agent's refusal writes nothing. */
    | 'agent_review_moves_nothing';
  /** WHAT A CHOICE PICKED (MOTIR-5893) — returned by the `decision_choice` handler's
   *  approve and written by the door onto the deciding row, which then records the
   *  option's id as `outcomeRef`. Absent on every other kind's effect. */
  chosenOption?: ChosenOption;
  /** WHAT A CONFIRMED DECISION'S RECORD WAS (MOTIR-5954) — returned by the
   *  `decision_confirmation` handler's approve and written by the door onto the
   *  deciding row: the counting markdown attachment's identity, or `none`. Absent on
   *  every other kind's effect. */
  confirmedRecord?: ConfirmedRecord;
  /**
   * WHAT MAY ONLY HAPPEN AFTER THE DOOR COMMITS (MOTIR-6035; ADR §11.5) — events,
   * triggers and anything that opens its own transaction. The door awaits it once its
   * transaction has committed and strips it from the result, so it never crosses the
   * wire and a rolled-back decision never announces anything. Absent on every kind but
   * `plan_approval`, whose approve and decline keep `approvePlan` / `declinePlan`'s
   * post-commit work exactly where those methods put it.
   */
  afterCommit?: () => Promise<void>;
}

/**
 * ONE status hop a decision applied, as `applyStatusTransition` reported it — what the
 * door's post-commit `work-item/transitioned` carries (Bug MOTIR-9415).
 */
export interface AppliedGateTransition {
  workItemId: string;
  fromStatusKey: string;
  toStatusKey: string;
  revisionId: string;
}

/**
 * What ROUTING needs, and it is deliberately LESS than {@link GateEffectArgs}.
 *
 * ⚠️ `routeTo` is answered at CREATION — ADR §6a: *"§2's answer computed at
 * creation; the assignee can change afterwards"* — and at creation THE GATE ROW
 * DOES NOT EXIST YET. A routing signature that demanded the gate could therefore
 * only be called after the row it is supposed to be written INTO had been
 * inserted, which is why `routeTo` had no production caller at all until
 * MOTIR-5046: the one moment it must answer is the one moment its own parameter
 * could not be constructed.
 *
 * So routing takes the ITEM (which is all §2's rule reads — `assigneeId ??
 * reporterId`) plus the caller's context and transaction. `GateEffectArgs`
 * remains assignable to this, so a kind whose routing one day needs the gate can
 * still be passed the full args by a DECISION-time caller; what it may not do is
 * make the creation-time call impossible again.
 */
export interface GateRoutingArgs {
  /**
   * The work item the gate hangs off, read in the creating transaction — or NULL for a
   * kind whose gate belongs to NO work item (Story MOTIR-6012 · MOTIR-6034; ADR
   * `approval-gates.md` §11.1). Only `plan_approval` is card-less (the CHECK
   * `approval_gate_work_item_iff_not_plan`), and what its gate is about is its
   * `subjectId`, the plan. A handler for a card-bearing kind narrows through
   * `requireArgsCard` (`lib/approvalGates/gateCard.ts`): it is never handed a null.
   */
  item: WorkItem | null;
  ctx: ServiceContext;
  /** The CREATING path's transaction — routing is resolved inside the same
   *  transaction that inserts the row, so the answer and the row commit together
   *  or not at all. */
  tx: Prisma.TransactionClient;
}

/** Everything a handler's verb needs, threaded from the door's own transaction. */
export interface GateEffectArgs extends GateRoutingArgs {
  /** The gate row as it was read UNDER THE LOCK — never a snapshot from before. */
  gate: Pick<ApprovalGate, 'id' | 'workspaceId' | 'projectId' | 'workItemId' | 'subjectId'>;
  /**
   * This project's concrete key for the handler's {@link GateHandler.statusIntent},
   * resolved by the door BEFORE its transaction opened. Null when the handler
   * owns no transition, or when a custom workflow has nothing in the target
   * category — a legitimate answer, which the handler turns into "wrote no
   * status" rather than a crash.
   *
   * ⚠️ RESOLVED OUTSIDE THE TRANSACTION, deliberately.
   * `workflowsService.resolveStatusKey` opens its own, so calling it from inside
   * the door's would take a SECOND pooled connection while this one holds the
   * gate's `FOR UPDATE` lock — the deadlock shape `workItemsService` warns about
   * at `applyStatusTransition`. It is reference data (a project's status
   * vocabulary), not a read the decision derives from, so reading it before the
   * lock is both cheaper and correct: CLAUDE.md § 4-layer — *reads of unrelated
   * reference data do NOT need `tx`*.
   */
  resolvedStatusKey: string | null;
  /**
   * WHICH OPTION a `decision_choice` press picked (Story MOTIR-4914; ADR §1's
   * MOTIR-5887 amendment, point 5 — each option IS a verb, `choose(optionId)`).
   * Absent for every other kind, whose verbs carry no argument. The decide door
   * gains the verb in MOTIR-5893; the handler refuses an id its subject does not
   * hold, so an absent or stale one can never record a pick.
   */
  choice?: { optionId: string };
  /**
   * WHAT THE REFUSAL MEANT (Story MOTIR-6070 · MOTIR-6421; ADR `approval-gates.md` §10d)
   * — `revise` or `re_plan`, on a `request_changes` a person pressed in Motir on a
   * `design_result` gate, where the door REQUIRES one. Null on every other verb, kind
   * and source: the door refuses a verdict anywhere else (`refusal_verdict_not_offered`),
   * so a handler that branches on it only ever sees one the design refusal carried.
   * The door writes it onto the row in the deciding write; a handler only reads it.
   */
  refusalVerdict: ApprovalGateRefusalVerdict | null;
  /**
   * What the kind's {@link GateHandler.beforeTransaction} read before the door's
   * transaction opened (MOTIR-6035), passed back untouched. Absent for a kind without
   * that seam, and for a gate the pre-read already found decided.
   */
  prepared?: unknown;
  /**
   * WHERE THE KIND'S STATUS HOPS ARE RECORDED (Bug MOTIR-9415) — a list the DOOR owns and
   * emits `work-item/transitioned` from once its transaction commits. A handler never
   * pushes to it by hand: it moves a status through `applyGateTransition`
   * (`lib/approvalGates/gateTransition.ts`), which applies the hop and records it. Both
   * doors (`decide`, `approveBySystem`) always pass one; absent only where a test calls a
   * handler directly and reads no event.
   */
  appliedTransitions?: AppliedGateTransition[];
  /**
   * What a composing SERVICE handed the door for the kind's effect alone, opaque to the
   * door (MOTIR-6038 — a plan's approve takes the onboarding placeholder name its rename
   * compares against, resolved by the route because i18n stays out of the service
   * layer). Never read from a request body: only `DecideGateOptions.effectOptions`
   * carries it, and no route, server action or MCP tool accepts that.
   */
  effectOptions?: Readonly<Record<string, unknown>>;
}

/** What {@link GateHandler.beforeTransaction} and {@link GateHandler.afterRollback} are
 *  told: the gate's immutable subject, the verb, and the actor. Never the row itself —
 *  neither runs under the gate's lock. */
export interface GateOutsideTransactionArgs {
  subjectId: string;
  decision: GateDecision;
  ctx: ServiceContext;
  /** `afterRollback` only: what `beforeTransaction` returned. */
  prepared?: unknown;
  /** See {@link GateEffectArgs.effectOptions}. */
  effectOptions?: Readonly<Record<string, unknown>>;
}

/**
 * What a KIND must supply to join the one approval language — the table ADR §1
 * exists to make re-usable.
 *
 * A third kind is then *a row in the enum, a handler, and a renderer*: nothing
 * here is about a design or a pull request specifically, which is the property
 * that keeps the door from growing a second vocabulary.
 */
export interface GateHandler<TSubject = unknown> {
  /**
   * Resolve the SUBJECT the gate points at, or null when it no longer resolves.
   *
   * ⚠️ The gate stores an opaque `subjectId` and NOTHING in the schema knows
   * which table it names (ADR §1's amendment — the subject is a document with a
   * resolver). That indirection is what lets a decision document move into the
   * `pages` domain later as a resolver change rather than a migration on the one
   * table an auditor trusts.
   */
  resolveSubject(args: GateEffectArgs): Promise<TSubject | null>;

  /**
   * The subject's IMMUTABLE VERSION at decision time — ADR §6a's first row, and
   * *"the one that carries the whole claim"*: a design's `commitSha`, a pull
   * request's `headSha`.
   *
   * ⚠️ IT IS A SEAM ON THE KIND, NOT A FIELD THE DOOR CAN READ. *"The version"*
   * has no kind-free meaning — the answer lives on a different table for every
   * kind, and the gate stores an opaque `subjectId` precisely so that nothing in
   * the schema knows which one. A door that reached into design evidence to
   * answer it would be the generic door growing knowledge of one kind, which is
   * the thing §1's registry exists to prevent; the same reasoning §6c's
   * amendment records for the retention pin, applied in the other direction.
   *
   * ⚠️ NULL IS A LEGITIMATE ANSWER and the door records it as one: a subject
   * that no longer resolves, or one genuinely carrying no version (a design
   * published from a working tree with no commit). What the door must never do is
   * refuse the decision over it — the decision is the audit artefact, and a
   * missing version makes the row weaker evidence, not an error.
   *
   * Read UNDER the door's lock, in its transaction, so the version recorded is
   * the one the subject had when the decision was taken.
   */
  subjectVersion(args: GateEffectArgs): Promise<string | null>;

  /**
   * WHO the gate is shown to — ADR §2: `assigneeId ?? reporterId`, exactly ONE
   * recipient.
   *
   * ⚠️ ROUTING is not AUTHORITY, though after §2's 2026-09-11 amendment the two
   * COINCIDE here. This answers *whose job is it to look?*; who may PRESS is the
   * assignee, the reporter WHEN THERE IS NO ASSIGNEE, or an admin, applied by
   * the door for every kind. The first two arms are exactly the recipient this
   * method returns — the gate is pressed by the person it is shown to — and an
   * admin is the escape hatch, deciding from the item page without the gate
   * appearing in their own tab.
   *
   * ⚠️ TAKES {@link GateRoutingArgs}, NOT `GateEffectArgs`, and that narrowing is
   * what gives this method a caller at all — see the note on that type. The
   * answer is written into `routed_to_id` by the CREATION path, in the same
   * transaction as the insert.
   */
  routeTo(args: GateRoutingArgs): string | null;

  /**
   * The subject a FRESH gate of this kind would ask about, right now — or null
   * when there is nothing to ask (Story MOTIR-4887 · Subtask MOTIR-5532; ADR
   * `approval-gates.md` §6d AMENDMENT, rule 7).
   *
   * ⚠️ REQUIRED, and deliberately so. Entering review ASKS AGAIN: a card whose
   * question was withdrawn by pulling it back must be asked again when it comes
   * back, or withdraw-then-return is a quiet way around every gate. The raise is
   * generic (`approvalGatesService.raiseOnReviewEntry`) and only the KIND knows
   * what its current subject is, so every registered kind must answer — and a
   * kind promoted into the registry without an answer fails to compile, rather
   * than silently never being asked again.
   *
   * Takes {@link GateRoutingArgs} for the same reason `routeTo` does: it is
   * answered at CREATION, before any gate row exists. Read in the transitioning
   * transaction, so the subject is the one current at the move.
   */
  currentSubject(args: GateRoutingArgs): Promise<string | null>;

  /**
   * The PERMISSION floor this kind's decision sits on, checked before the
   * relationship test rather than instead of it (ADR §2's amendment: *"The
   * design gate keeps `work_item:edit` as its floor; the relationship test is
   * applied on top of it"*).
   */
  permission: PermissionKey;

  /**
   * **Which STATUS TRANSITION the gate owns, or NONE** — ADR §1's table, verbatim.
   *
   * An INTENT rather than a key, because a project may have renamed its
   * statuses: the door resolves it through `workflowsService.resolveStatusKey`,
   * which prefers the key and falls back to the CATEGORY. Hard-coding a key here
   * is the *never hard-code a status key* rule this indirection exists for.
   *
   * `null` for a kind that moves nothing, which is a real answer rather than a
   * not-yet: it is what keeps `done` to one writer. The retired merge kind was
   * the example — the webhook moved its card (§4) — and the approve-and-merge
   * gate that replaced it DOES move one, to `approved`.
   */
  statusIntent: { key: string; category: StatusCategoryDto } | null;

  /**
   * THE SETTINGS DOOR this kind supplies to its approval frame (MOTIR-5513 ·
   * MOTIR-4793), or none. A kind whose asking is governed by a PROJECT SETTING names
   * where that setting lives; the gate read hands it only to a viewer holding the key
   * the destination is guarded by (`settingsDoorFor`). A kind with no such setting
   * leaves it out, and its frame's band 3 is byte-identical to state `A`.
   */
  settingsDoor?: GateSettingsDoor;

  /** What `approve` DOES, beyond recording the decision. */
  approve(args: GateEffectArgs): Promise<GateEffect>;

  /** What `request_changes` DOES, beyond recording the decision. */
  requestChanges(args: GateEffectArgs): Promise<GateEffect>;

  /**
   * What `overturn` DOES, beyond recording the decision (MOTIR-5956; ADR §1's
   * MOTIR-5952 amendment, points 6–7) — offered ONLY by `decision_confirmation`,
   * which is why it is optional here: the door refuses the verb on any kind that
   * does not supply it. `resolvedStatusKey` is the project's `cancelled` status BY
   * KEY, or null — never the category fallback, which would write `done`.
   */
  overturn?(args: GateEffectArgs): Promise<GateEffect>;

  /**
   * What `decline` DOES, beyond recording the decision (MOTIR-6035; ADR §11.4) —
   * offered ONLY by `plan_approval`, so optional on the pattern `overturn?` set: the
   * door refuses the verb on any kind that does not supply it
   * (`decline_on_other_kind`). The gate goes to the terminal state `declined`, and its
   * note is OPTIONAL (§11.4's stated departure from §10a).
   */
  decline?(args: GateEffectArgs): Promise<GateEffect>;

  /**
   * LOCK THE SUBJECT'S OWN ROW BEFORE THE DOOR LOCKS THE GATE (MOTIR-6035; ADR §11.5).
   * A kind whose subject's writers already hold the subject's lock when they reach the
   * gate supplies this, and the door calls it in its transaction BEFORE
   * `approvalGateRepository.lockById`: two transactions taking the same two rows in
   * opposite orders deadlock. `subjectId` is immutable, so the door reads it unlocked
   * first. Absent: the door's generic gate-then-effect order.
   */
  lockSubjectBeforeGate?(subjectId: string, tx: Prisma.TransactionClient): Promise<void>;

  /**
   * THE SUBJECT'S VERSION MOVES IN PLACE (MOTIR-6035; ADR §11.3, §11.5c). A kind whose
   * subject is revised WITHOUT its gate being superseded (a plan: same plan, same
   * question) sets this, and the door stamps the version {@link subjectVersion} answers
   * UNDER THE LOCK rather than the one the row was raised with — or a stamp taken
   * before a revision would never be refused as stale. Absent: the row's own
   * `subjectVersion`, which a supersede-and-re-raise keeps current.
   */
  stampsLiveVersion?: true;

  /**
   * WORK THE EFFECT NEEDS THAT CANNOT RUN INSIDE A TRANSACTION (MOTIR-6035) — reads
   * that open their own context, best-effort writes that must not ride the decision.
   * The door calls it BEFORE its transaction (beside `resolvedStatusKey`, and for the
   * same reason), only for a gate its pre-read found `awaiting`, and hands the result
   * to the verb as `args.prepared`. It must assert whatever permission its own side
   * effects need: it runs before the door's floor.
   */
  beforeTransaction?(args: GateOutsideTransactionArgs): Promise<unknown>;

  /**
   * WHAT A FAILED DECISION BECOMES AFTER THE DOOR'S TRANSACTION ROLLED BACK
   * (MOTIR-6035) — a best-effort repair that must not ride the rolled-back write, and
   * the error to throw in its place. Never swallows a refusal.
   */
  afterRollback?(err: unknown, args: GateOutsideTransactionArgs): Promise<unknown>;

  /**
   * WHAT THE DECISION CAUSES ONCE ITS OWN ROW SAYS SO (Story MOTIR-1626 · MOTIR-6819; ADR
   * §12.4) — run by the door in its transaction AFTER the deciding write, under the same
   * locks. For a kind whose consequence is a question about the card's gates that must
   * read this gate as DECIDED: the review agent's pass raises the approve-and-merge gate
   * through `reconcileGatesFor`, and the gate set would still see the review awaiting if
   * that ran inside `approve`, which the door calls before it writes. Absent: nothing.
   */
  afterDecisionWritten?(args: GateEffectArgs & { state: ApprovalGateState }): Promise<void>;

  /**
   * The interactive-transaction budget the door opens with for this kind, when the
   * default is too small (MOTIR-6035: a plan's approve materializes a subtree —
   * `APPROVE_TX_BUDGET`). Absent: Prisma's defaults.
   */
  transactionBudget?: TransactionBudget;
}

/**
 * THE REGISTRY. Total over {@link RegisteredGateKind}, which is the half of
 * `ApprovalGateKind` this build implements.
 */
export const APPROVAL_GATE_HANDLERS: Record<RegisteredGateKind, GateHandler> = {
  design_result: designResultGateHandler,
  decision_approval: decisionApprovalGateHandler,
  pull_request_approval: pullRequestApprovalGateHandler,
  acceptance_result: acceptanceResultGateHandler,
  decision_choice: decisionChoiceGateHandler,
  decision_confirmation: decisionConfirmationGateHandler,
  plan_approval: planApprovalGateHandler,
  agent_review: agentReviewGateHandler,
  manual_work: manualWorkGateHandler,
  planning_session: planningSessionGateHandler,
};

/** Narrow a gate's kind to one this build can dispatch. */
export function isRegisteredGateKind(kind: ApprovalGateKind): kind is RegisteredGateKind {
  return kind in APPROVAL_GATE_HANDLERS;
}

/**
 * The handler for a gate's kind, or a NAMED refusal.
 *
 * The runtime check exists even though the compile-time one is stronger, because
 * they answer different questions: the type says *this build registers a handler
 * for every kind it claims to*, and this says *the row in front of me carries a
 * kind this build claims*. A row can carry an unregistered kind without any
 * source file being wrong — a fixture, a migration, a half-landed sibling — and
 * the honest answer to that row is a refusal that names the kind, never an
 * `undefined` handler.
 */
export function handlerFor(kind: ApprovalGateKind): GateHandler {
  if (!isRegisteredGateKind(kind)) throw new ApprovalGateKindUnregisteredError(kind);
  return APPROVAL_GATE_HANDLERS[kind];
}

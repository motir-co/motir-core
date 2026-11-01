import type { StampComponent } from '@/lib/approvalGates/stamp';

// Typed errors for the approval-gate domain (Story MOTIR-4778 · Subtask
// MOTIR-4788; ADR docs/decisions/approval-gates.md). Kept in their own file so
// the service / route layers (the decide-door card MOTIR-4790, the Approvals
// tab) can import them without pulling in the Prisma client.
//
// This card ships the repository leaf and NO service: the unique-constraint
// race on the partial index `approval_gate_one_awaiting_per_subject` is
// translated HERE, at the repository's edge, so a raw Prisma `P2002` never
// escapes it — the same disposition `workItemLinkRepository` gives the
// `(fromId, toId, kind)` unique (→ `DuplicateLinkError`). The decide-door
// service catches the typed error and branches on it; it never inspects a raw
// Postgres / Prisma code (the 4-layer rule).
//
// ⚠️ MOTIR-4790 (the DECIDE door) adds the five refusals the door itself raises
// — not found, already decided, superseded, not authorised, and an unregistered
// kind. The paragraph above still describes where the AWAITING-race translation
// lives, which is unchanged: that one is the REPOSITORY's, because it is a raw
// `P2002` that must not escape its edge. The five below are the SERVICE's,
// because each is a business rule the door applies rather than a database error
// it survives.
//
// ⚠️ AND MOTIR-4912 (the AUDIT columns) adds the file's SECOND repository-tier
// refusal, which is what makes that split worth reading carefully rather than as
// a one-off: `ApprovalGateDecidedImmutableError`, translated from the
// `trg_approval_gate_decided_immutable` BEFORE UPDATE trigger. So this file now
// holds errors from BOTH tiers, and the discriminator is whether a DATABASE
// refused the write or a RULE refused the request:
//
//   * REPOSITORY tier — `ApprovalGateAlreadyAwaitingError` (a `P2002` on the
//     partial unique) and `ApprovalGateDecidedImmutableError` (the immutability
//     trigger). Both are raw Postgres failures that must not escape, and both
//     are produced in ONE place: `translateApprovalGateWriteError` in
//     `approvalGateRepository`. Nothing else constructs them.
//     `ApprovalGateDeliveryUnreadableError` (Bug MOTIR-8236) is the third, and
//     the one that is a READ: `workItemDeliveryRepository.listByWorkItemWithChecks`
//     raises it when a delivery's joins come back NULL under RLS, so the gate and
//     merge readers never dereference a member this reader cannot see.
//   * SERVICE tier — the five below. The door applies each before it writes.
//
// ⚠️ `ApprovalGateAlreadyDecidedError` and `ApprovalGateDecidedImmutableError`
// are about the same FACT and are NOT interchangeable, which is the one confusion
// this list invites. The first is the door's EXPECTED refusal — a reviewer
// pressing a button somebody else already pressed, a 409 the control draws in
// place, raised with the row lock held and before any write is attempted. The
// second means that check was absent, bypassed or wrong and the database caught
// what the business rule was supposed to: a 500 and a finding, not a state the
// UI renders. Mapping them to the same status would hide the second behind the
// first for ever.
//
// Every class carries a string `tag` discriminant so the service layer can
// `switch (err.tag)` over an `ApprovalGateError` union exhaustively without
// `instanceof` chains. `code` mirrors `tag` and is what the route layer (the
// decide-door card) maps to an HTTP status. Mirrors the shape of
// `lib/workItems/linkErrors.ts`.

export type ApprovalGateErrorTag =
  // REPOSITORY tier — a database refused the write.
  | 'APPROVAL_GATE_ALREADY_AWAITING'
  | 'APPROVAL_GATE_DELIVERY_UNREADABLE'
  | 'APPROVAL_GATE_DECIDED_IMMUTABLE'
  // SERVICE tier — the decide door refused the request.
  | 'APPROVAL_GATE_NOT_FOUND'
  | 'APPROVAL_GATE_ALREADY_DECIDED'
  | 'APPROVAL_GATE_SUPERSEDED'
  | 'APPROVAL_GATE_NOT_AUTHORISED'
  | 'APPROVAL_GATE_KIND_UNREGISTERED'
  | 'APPROVAL_GATE_SYNCED_ACTOR_MISMATCH'
  // A path that reads a gate's CARD met a gate with none — only a `plan_approval`
  // gate may be card-less (ADR §11.1, MOTIR-6032), so this is a DEFECT in the caller.
  | 'APPROVAL_GATE_HAS_NO_CARD'
  // A DECISION gate whose card's pull requests carry no single decision document —
  // none, several, or one the host could not name (Story MOTIR-4907 · MOTIR-5676;
  // `approval-gates.md` §8's FIFTH AMENDMENT, clause 3). Approve is refused;
  // Request changes is not.
  | 'APPROVAL_GATE_DECISION_UNRESOLVABLE'
  // The approve-to-merge gate of a card whose PRIMARY question — the design, or a
  // decision — is not answered, approved through a door that is not the primary's own
  // press (Bug MOTIR-5785; `design-result.md` AMENDMENT 6 Q1). The merge FOLLOWS the
  // primary. Approve is refused; Request changes is not.
  | 'APPROVAL_GATE_PRIMARY_PENDING'
  // The question is still live and what the reader was shown MOVED under them
  // (Story MOTIR-5232 · MOTIR-5234) — the stamp they pressed with no longer matches.
  | 'APPROVAL_GATE_STALE_SUBJECT'
  // The VERB does not belong to this gate (Story MOTIR-4914 · MOTIR-5893): `choose`
  // sent to a kind that asks no choice, `approve` sent to a choice, or an option the
  // choice does not hold. A request-shape refusal — nothing was written.
  | 'APPROVAL_GATE_VERB_NOT_OFFERED'
  // MERGE tier — the HOST refused a merge the card's approve-to-merge gate
  // performs (Story MOTIR-4882 · MOTIR-5512; `approval-gates.md` §4, second
  // amendment decision 8, and §8's SECOND AMENDMENT, which keeps this union whole
  // while retiring the per-pull-request kind that first raised it). The seam maps the host's answer onto these; the merge
  // entry point returns them and writes nothing, so the gate stays decidable.
  // A changed subject is NOT one of these — it supersedes the gate and answers
  // `APPROVAL_GATE_SUPERSEDED`.
  | 'MERGE_CHECKS_NOT_GREEN'
  | 'MERGE_CONFLICT'
  // The base branch requires a pull request to be up to date and this one is behind it
  // (Bug MOTIR-10054): GitHub reads it as `mergeable_state: behind`.
  | 'MERGE_OUT_OF_DATE'
  | 'MERGE_BRANCH_PROTECTED'
  | 'MERGE_ALREADY_MERGED'
  | 'MERGE_APP_PERMISSION_MISSING'
  // QUEUE AGAIN (Story MOTIR-5461 · MOTIR-5634; `approval-gates.md` §4 THIRD
  // AMENDMENT, decision 5) — somebody else already put this pull request back into
  // the merge queue after it left. Not a host answer: the second press lost the claim.
  | 'MERGE_ALREADY_REQUEUED';

/**
 * Base class for every approval-gate typed error. Concrete subclasses set a
 * literal `tag` (the discriminant) and a matching `code`.
 */
export abstract class ApprovalGateError extends Error {
  abstract readonly tag: ApprovalGateErrorTag;
  abstract readonly code: ApprovalGateErrorTag;
}

/**
 * An `awaiting` gate already exists for the same `(workItemId, kind, subjectId)`
 * — the partial unique index `approval_gate_one_awaiting_per_subject` refused a
 * second. Translated from Prisma `P2002` on that constraint, so a raw DB error
 * never escapes the repository.
 *
 * The decide-door card catches this and renders it in the control (a gate
 * somebody else decided while the row was on screen) rather than throwing —
 * the same shape the ADR §4 names for "a gate somebody else decided while the
 * row was on screen".
 *
 * ⚠️ Under `motir_app` (FORCE RLS, non-superuser) PostgreSQL declines to
 * describe the conflicting key, so the `P2002` carries no `meta.target` — the
 * repository does not inspect the target, only the code, for the same reason
 * `workItemLinkRepository` does not (the `(fromId, toId, kind)` unique is the
 * only one that can fire on that insert; the partial-unique here is the only
 * one that can fire on this one).
 */
export class ApprovalGateAlreadyAwaitingError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_ALREADY_AWAITING' as const;
  readonly code = 'APPROVAL_GATE_ALREADY_AWAITING' as const;
  constructor(
    message = 'An awaiting approval gate already exists for this subject — another decision is in flight.',
  ) {
    super(message);
    this.name = 'ApprovalGateAlreadyAwaitingError';
  }
}

/**
 * A card's delivery set holds a member this reader CANNOT SEE (Bug MOTIR-8236), so no
 * decision may be taken over it.
 *
 * A `work_item_delivery` row is admitted on the CARD's workspace; the pull request and
 * the repository it joins are admitted through `github_repo`'s policies, which key on
 * the REPOSITORY's workspace and organisation. When the repository stops belonging to
 * the card's organisation, the row stays visible and its joins come back NULL — a value
 * the generated type says cannot happen, which every gate and merge reader then
 * dereferenced (`TypeError: Cannot read properties of null (reading 'checkRuns')`).
 *
 * The DISPLAY reads drop such a member (MOTIR-8215). The approval gate and
 * approve-and-merge must not: a decision over part of the set would merge or approve
 * pull requests nobody was shown, so they refuse, naming the deliveries that cannot be
 * read. Raised at the repository's edge, like the two refusals above, because the
 * repository is the layer whose return type was the lie.
 */
export class ApprovalGateDeliveryUnreadableError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_DELIVERY_UNREADABLE' as const;
  readonly code = 'APPROVAL_GATE_DELIVERY_UNREADABLE' as const;
  constructor(
    readonly workItemId: string,
    readonly deliveryIds: readonly string[],
  ) {
    super(
      `Work item ${workItemId} is delivered by ${deliveryIds.length} pull request(s) this reader cannot see (deliveries ${deliveryIds.join(', ')}); nothing can be decided over a set that is only partly visible.`,
    );
    this.name = 'ApprovalGateDeliveryUnreadableError';
  }
}

/**
 * An UPDATE was attempted on a gate that has already been DECIDED (`approved`
 * or `changes_requested`). The `approval_gate` BEFORE UPDATE trigger
 * `trg_approval_gate_decided_immutable` refused it; this is that refusal,
 * translated at the repository's edge so a raw Postgres error never escapes it
 * (Subtask MOTIR-4912).
 *
 * ADR §6a: *"A decided gate is IMMUTABLE. There is no update path for a decided
 * row — audit evidence that can be edited is not evidence."* So this is NOT a
 * transient condition to retry and NOT a conflict to resolve — there is no
 * version of the write that succeeds.
 *
 * ⚠️ IT IS NOT {@link ApprovalGateAlreadyAwaitingError}'S COUSIN, AND IT IS NOT
 * THE DECIDE DOOR'S *already decided* REFUSAL EITHER. The door's own refusal is
 * the normal, EXPECTED path for a reviewer who pressed a button somebody else
 * had already pressed — a 409 the control draws in place, reached with the row
 * lock held and before any write is attempted. Reaching THIS error means the
 * service's check was absent, bypassed, or wrong, and the database caught what
 * the business rule was supposed to: a `500` rather than a rendered message, and
 * a finding rather than a state.
 *
 * The state and the decision moment come off `OLD` in the trigger's message, so
 * the refusal says WHICH decision it is protecting rather than only that one
 * exists — the same reason the door's refusal names the winner.
 */
export class ApprovalGateDecidedImmutableError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_DECIDED_IMMUTABLE' as const;
  readonly code = 'APPROVAL_GATE_DECIDED_IMMUTABLE' as const;
  constructor(
    message = 'This approval gate has already been decided and cannot be changed — a decided gate is immutable audit evidence.',
  ) {
    super(message);
    this.name = 'ApprovalGateDecidedImmutableError';
  }
}

/**
 * The gate id names no gate this actor can see — missing, or in another
 * workspace (RLS hides it, so the two are indistinguishable here, which is the
 * no-existence-leak posture the rest of the product keeps).
 */
export class ApprovalGateNotFoundError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_NOT_FOUND' as const;
  readonly code = 'APPROVAL_GATE_NOT_FOUND' as const;
  constructor(readonly gateId: string) {
    super(`No approval gate ${gateId}.`);
    this.name = 'ApprovalGateNotFoundError';
  }
}

/**
 * The gate is `approved` or `changes_requested` — somebody already decided it.
 * The ADR calls this `GateAlreadyDecidedError` (§ the decide door's step 3); the
 * class carries the file's `ApprovalGate*` prefix and the shorthand is the same
 * error.
 *
 * It NAMES the winner and the moment, because the surface's job is to say so in
 * place rather than to fail generically — ADR §4's *"a gate somebody else
 * decided while the row was on screen"* is one of the enumerated refusals the
 * control draws, and it cannot draw it from a bare 409.
 *
 * ⚠️ `decidedById` is NULLABLE even here. The FK is `onDelete: SetNull`, so a
 * decision whose actor has since left the workspace keeps the record that it
 * happened and loses the attribution — the audit column that survives a
 * departure is a sibling card's (MOTIR-4912). A null therefore means *we no
 * longer know who*, never *nobody decided it*.
 */
export class ApprovalGateAlreadyDecidedError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_ALREADY_DECIDED' as const;
  readonly code = 'APPROVAL_GATE_ALREADY_DECIDED' as const;
  constructor(
    readonly gateId: string,
    readonly state: 'approved' | 'changes_requested' | 'overturned' | 'declined',
    readonly decidedById: string | null,
    readonly decidedAt: Date | null,
    /**
     * WHO decided it, in words that survive their departure — the row's
     * `decidedByLabel` (the audit set, MOTIR-4912). Carried BESIDE
     * `decidedById` rather than instead of it, and for a reason the refusal
     * surface makes concrete: the id is a join key and the label is the only
     * thing a person can be shown. A control that rendered the id would print a
     * cuid where the design draws a name (Subtask MOTIR-4792, design panel `H`).
     *
     * Null is a real answer — a decider whose account was removed leaves both
     * null — so the copy has an unattributed arm rather than a placeholder.
     */
    readonly decidedByLabel: string | null = null,
  ) {
    super(
      `Approval gate ${gateId} was already decided (${state})${
        decidedAt ? ` at ${decidedAt.toISOString()}` : ''
      }.`,
    );
    this.name = 'ApprovalGateAlreadyDecidedError';
  }
}

/**
 * The gate's question was WITHDRAWN, so there is nothing left to decide — the
 * gate is `superseded`, or the press found the subject no longer describes what
 * it was raised about (ADR §6b).
 *
 * A SEPARATE error from {@link ApprovalGateAlreadyDecidedError} on purpose, and
 * the separation is the same one §6b makes in the state set: `superseded` is
 * **not a decision**. It carries no actor, no permission and no note, so
 * collapsing the two refusals would make the surface say *"somebody already
 * decided this"* about a question nobody answered — which is precisely the
 * sentence the audit must never be able to produce.
 *
 * ⚠️ AND IT NAMES NO CAUSE — deliberately (Bug MOTIR-5651), for the same reason
 * MOTIR-5586 took the cause out of state `G`'s dead port. This error reaches a
 * reader from SEVEN raise sites and only ONE of them follows a publish.
 *
 * FOUR write or read the `superseded` row, and the gate carries nothing that
 * tells them apart — §6b makes a supersede write `state` and nothing else:
 *
 *   - a republish (MOTIR-4913) — publishes something;
 *   - a WITHDRAWAL (`withdrawCurrentForWorkItem`, MOTIR-5574) — publishes nothing;
 *   - a hand pull-back out of review or to Cancelled (MOTIR-5527) — nothing;
 *   - linking an OPEN pull request (MOTIR-5534) — nothing; the decision moved
 *     to the pull request.
 *
 * THREE more raise it with no `superseded` row at all, in
 * `lib/services/pullRequestMergeService.ts`: a head that moved between the
 * check and the merge (the host's `subject_changed` 409), a stale member on a
 * re-queue, and a pull request that is not one of the card's deliveries.
 *
 * So a message naming a publish was false on six of the seven. What survives is
 * the fact every raise site leaves true, and dropping a claim needs no new
 * column. A caller whose own surface KNOWS the cause says so there — the
 * approve-to-merge gate does, via `ApprovalGateControl`'s `withdrawnPort`
 * (MOTIR-5604).
 */
export class ApprovalGateSupersededError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_SUPERSEDED' as const;
  readonly code = 'APPROVAL_GATE_SUPERSEDED' as const;
  /**
   * `supersedeCause` is WHY it was withdrawn, when the raising path read it under its lock
   * (Story MOTIR-5652 · Subtask MOTIR-5667). Null where the caller had only the
   * state — the refusal then says a true, vaguer sentence rather than guessing.
   */
  constructor(
    readonly gateId: string,
    readonly supersedeCause: string | null = null,
  ) {
    super(
      `Approval gate ${gateId} was superseded — this question has been withdrawn and nobody decided it.`,
    );
    this.name = 'ApprovalGateSupersededError';
  }
}

/**
 * The gate is still `awaiting` and still this reader's to decide — but what they
 * were SHOWN has moved since the page rendered (Story MOTIR-5232 · Subtask
 * MOTIR-5234; ADR §6b's MOTIR-5234 amendment). The stamp they pressed with no
 * longer matches the one the door recomputes under the lock.
 *
 * ⚠️ NOT `ApprovalGateSupersededError`, and the two must never be collapsed. A
 * superseded gate is a WITHDRAWN question — there is nothing to decide, and the
 * reader should leave. A stale one is a LIVE question that changed — the reader
 * should look at the current version and decide again. The door checks the state
 * refusals FIRST, so a withdrawn question is never reported as a stale one.
 *
 * `moved` names WHAT changed — any of `subject` · `pull_requests` · `criteria`, in
 * the reader's words (`movedAsReaderSees`) — so the frame can say which. Nothing
 * was written when this is raised.
 */
export class ApprovalGateStaleSubjectError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_STALE_SUBJECT' as const;
  readonly code = 'APPROVAL_GATE_STALE_SUBJECT' as const;
  constructor(
    readonly gateId: string,
    readonly moved: readonly StampComponent[],
  ) {
    super(
      `Approval gate ${gateId} changed while it was being read (${moved.join(', ')}) — nothing was recorded; read the current version and decide again.`,
    );
    this.name = 'ApprovalGateStaleSubjectError';
  }
}

/** Why {@link ApprovalGateVerbNotOfferedError} refused — the three shapes a verb can miss by. */
export type VerbNotOfferedReason =
  /** ANY decision sent to a `planning_session` gate (MOTIR-7913): the person answers by
   *  SENDING A TURN, and the gate offers no verb at all. */
  | 'no_verbs_on_planning_session'
  | 'choose_on_other_kind'
  | 'approve_on_choice'
  | 'unknown_option'
  /** `request_changes` sent to a `decision_confirmation` gate, whose refusal is
   *  OVERTURN (ADR §1's MOTIR-5952 amendment, point 6). */
  | 'request_changes_on_confirmation'
  /** `overturn` sent to a kind that confirms no decision (MOTIR-5956). */
  | 'overturn_on_other_kind'
  /** `overturn` with no note — what was actually discussed is REQUIRED (point 6b). */
  | 'overturn_needs_a_note'
  /** `request_changes` pressed with no reason — a refusal SAYS WHY (ADR §10a, MOTIR-6074).
   *  Every kind that offers the verb, *None of these* on a choice included. */
  | 'request_changes_needs_a_note'
  /** A `refusalVerdict` sent where none is offered — any kind but `design_result`, any
   *  verb but `request_changes`, or a `github` source (ADR §10d, MOTIR-6421). */
  | 'refusal_verdict_not_offered'
  /** A `request_changes` PRESSED on a `design_result` gate with no verdict — a design
   *  refusal says `revise` or `re_plan` (ADR §10d, MOTIR-6421). */
  | 'refusal_verdict_required'
  /** `request_changes` sent to a `plan_approval` gate (ADR §11.4, MOTIR-6035): a plan is
   *  changed by TALKING to the planner, never by a gate verb. */
  | 'request_changes_on_plan'
  /** `request_changes` sent to a `manual_work` gate (MOTIR-7474;
   *  `docs/decisions/manual-work-gate.md` §4): manual work is done or not done, and a
   *  person who cannot do it says so on the card or in the guide. */
  | 'request_changes_on_manual_work'
  /** `decline` sent to any kind but `plan_approval`, the one kind that offers it
   *  (ADR §11.4, MOTIR-6035). */
  | 'decline_on_other_kind'
  /** A PERSON's `request_changes` on an `agent_review` gate (ADR §12.3, MOTIR-6819): only
   *  the review agent refuses it; a person can only continue without the review. */
  | 'request_changes_on_agent_review'
  /** A person's `approve` of an `agent_review` gate — *Continue without the review* — with
   *  no reason (ADR §12.3, MOTIR-6819): waving a review past says why. */
  | 'override_needs_a_note'
  /** A review agent's verdict sent to a gate of any other kind (MOTIR-6819). */
  | 'review_agent_on_other_kind';

/**
 * A decision whose VERB this gate does not offer (Story MOTIR-4914 · Subtask
 * MOTIR-5893; ADR `approval-gates.md` §1's MOTIR-5887 amendment, point 5). A
 * `decision_choice` gate's verbs ARE its options — `choose(optionId)` — plus
 * `request_changes`; every other kind's are `approve` + `request_changes`. So:
 *
 *   · `choose_on_other_kind` — `choose` sent to a gate that asks no choice;
 *   · `approve_on_choice`    — `approve` sent to a choice, which recommends nothing;
 *   · `unknown_option`       — an `optionId` the choice does not hold;
 *   · `request_changes_on_confirmation` — `request_changes` sent to a
 *     `decision_confirmation` gate (MOTIR-5954), whose refusal is Overturn;
 *   · `overturn_on_other_kind` — `overturn` sent to any other kind (MOTIR-5956);
 *   · `overturn_needs_a_note` — `overturn` with an empty note (MOTIR-5956): a
 *     request-shape refusal like the others, and nothing is written.
 *   · `request_changes_needs_a_note` — `request_changes` PRESSED with an empty
 *     reason (MOTIR-6074, ADR §10a). Never raised for `source: github`.
 *   · `refusal_verdict_not_offered` — a `refusalVerdict` on any kind but
 *     `design_result`, any verb but `request_changes`, or a `github` source
 *     (MOTIR-6421, ADR §10d); nothing is written.
 *   · `refusal_verdict_required` — `request_changes` PRESSED on a `design_result`
 *     gate without a verdict (MOTIR-6421, ADR §10d). Never raised for `source: github`.
 *   · `request_changes_on_plan` — `request_changes` sent to a `plan_approval` gate
 *     (MOTIR-6035, ADR §11.4): a plan is changed by a conversation, not a verb;
 *   · `request_changes_on_manual_work` — `request_changes` sent to a `manual_work`
 *     gate (MOTIR-7474): the work is done or not done, so there is nothing to refuse;
 *   · `decline_on_other_kind` — `decline` sent to any kind but `plan_approval`.
 *   · `request_changes_on_agent_review` — a PERSON's `request_changes` on an
 *     `agent_review` gate (ADR §12.3): only the review agent refuses one;
 *   · `override_needs_a_note` — a person's *Continue without the review* with no reason;
 *   · `review_agent_on_other_kind` — a review agent's verdict on any other kind.
 *
 * ⚠️ NOT THE STALE REFUSAL, even for `unknown_option`. The stamp check runs first,
 * so by the time an option is looked up the options are exactly the ones the
 * reader was shown; an id missing from them was never offered, and telling the
 * reader "this changed, look again" would send them to re-read a body that did not
 * move. Raised under the lock, before anything is written.
 */
export class ApprovalGateVerbNotOfferedError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_VERB_NOT_OFFERED' as const;
  readonly code = 'APPROVAL_GATE_VERB_NOT_OFFERED' as const;
  constructor(
    readonly gateId: string,
    readonly reason: VerbNotOfferedReason,
  ) {
    super(
      `Approval gate ${gateId} does not offer that decision (${reason}); nothing was recorded.`,
    );
    this.name = 'ApprovalGateVerbNotOfferedError';
  }
}

/**
 * The actor may edit the project but holds no RELATIONSHIP to the work item that
 * authorises a press — they are not its assignee; they are not its reporter on
 * an UNASSIGNED item; and they are not a workspace owner/admin.
 *
 * ADR §2's 2026-09-11 amendment: **AUTHORITY is the assignee, or the reporter
 * WHEN THERE IS NO ASSIGNEE, or an admin**, for both verbs, applied ON TOP of
 * the kind's permission floor rather than instead of it. The relationship arms
 * are now exactly §2's routing rule (`assigneeId ?? reporterId`), so this error
 * is reachable by the REPORTER of an item that has an assignee — someone who can
 * see the gate perfectly well, and who could press it until 2026-09-11.
 */
export class ApprovalGateNotAuthorisedError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_NOT_AUTHORISED' as const;
  readonly code = 'APPROVAL_GATE_NOT_AUTHORISED' as const;
  constructor(readonly gateId: string) {
    super(
      `Only the work item's assignee — or its reporter when it has no assignee — or a workspace admin may decide approval gate ${gateId}.`,
    );
    this.name = 'ApprovalGateNotAuthorisedError';
  }
}

/**
 * `source: 'github'` and the SYNCED ACTOR must arrive together (Story MOTIR-4910 ·
 * MOTIR-5596; ADR §8 FOURTH AMENDMENT, decision 3).
 *
 * The two say the same thing from different sides — *this decision was made on
 * GitHub, by somebody with no Motir session* — so either without the other is a
 * caller claiming something it cannot back. It is refused in BOTH directions and
 * deliberately so:
 *
 *  · `source: 'github'` with no synced actor would write `decisionSource = github`
 *    against `ctx.userId`, i.e. a Motir surface claiming to be GitHub. That is the
 *    one sentence the audit must never be able to produce, and it is exactly what
 *    a route or an MCP tool would produce if it could pass the source freely.
 *  · a synced actor with any other source would record a GitHub reviewer as though
 *    a person had clicked in Motir.
 *
 * Nothing is written on either arm: the refusal is raised before the transaction.
 */
export class ApprovalGateSyncedActorMismatchError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_SYNCED_ACTOR_MISMATCH' as const;
  readonly code = 'APPROVAL_GATE_SYNCED_ACTOR_MISMATCH' as const;
  constructor(
    readonly gateId: string,
    readonly detail: 'source_without_actor' | 'actor_without_source',
  ) {
    super(
      detail === 'source_without_actor'
        ? `Approval gate ${gateId} was decided with source 'github' but no synced reviewer — only the GitHub review sync may claim that source.`
        : `Approval gate ${gateId} was decided with a synced GitHub reviewer but a source other than 'github'.`,
    );
    this.name = 'ApprovalGateSyncedActorMismatchError';
  }
}

/**
 * The gate's KIND has no handler in this build — one of the registry's
 * deliberate compile-time holes (`lib/approvalGates/registry.ts`).
 *
 * Unreachable through the product today: nothing CREATES a gate of an
 * unregistered kind, because the only writer is the design-result publish. It
 * exists so the door's dispatch is total at RUNTIME as well as at compile time —
 * a row written by a migration, a fixture, or a half-landed future card meets a
 * named refusal instead of an `undefined` handler and a `TypeError`.
 */
/** The MERGE tier's tags — the host refusing the merge an approval performs. */
export type MergeRefusalTag = Extract<ApprovalGateErrorTag, `MERGE_${string}`>;

/**
 * The HOST refused a merge the card's approve-to-merge gate performs (Story MOTIR-4882 ·
 * MOTIR-5517 · MOTIR-5613). Thrown by the merge entry point BEFORE anything is decided, so the gate
 * stays awaiting and the refusal is drawn in place with its next action.
 *
 * `permission` is the one a missing App permission names, as the host named it;
 * `reason` is the host's own account of a protection rule — carried for the record and
 * never drawn as copy (`refusals.ts`).
 */
export class ApprovalGateMergeRefusedError extends ApprovalGateError {
  readonly tag: MergeRefusalTag;
  readonly code: MergeRefusalTag;
  readonly permission: string | null;
  readonly reason: string | null;
  /** True when the refusal was found BEFORE the decision was written (MOTIR-5915; design
   *  § 30 Panel 5a) — nothing was approved, so § 28's *your approval was spent* is false. */
  readonly atPress: boolean;
  /** The members the host reports conflicted, as `owner/name#number` with the base each
   *  targets — what Panel 5a names. Empty on every other refusal. */
  readonly conflicts: MergeConflictMember[];
  constructor(
    readonly gateId: string,
    tag: MergeRefusalTag,
    extra: {
      permission?: string | null;
      reason?: string | null;
      atPress?: boolean;
      conflicts?: MergeConflictMember[];
    } = {},
  ) {
    super(
      `The host refused the merge approval gate ${gateId} asks for (${tag}); nothing was decided.`,
    );
    this.tag = tag;
    this.code = tag;
    this.permission = extra.permission ?? null;
    this.reason = extra.reason ?? null;
    this.atPress = extra.atPress ?? false;
    this.conflicts = extra.conflicts ?? [];
    this.name = 'ApprovalGateMergeRefusedError';
  }
}

/** One member a press found conflicted (MOTIR-5915). `baseRef` is null on a row mirrored
 *  before base branches were recorded — the copy then says *its base branch*. */
export interface MergeConflictMember {
  pullRequest: string;
  baseRef: string | null;
}

/**
 * *Queue again* on a merge-queue exit somebody already put back (MOTIR-5634). Two
 * presses on one exit enqueue ONCE: the first claims the exit (`requeuedAt`) under the
 * card's row lock, and the second finds it claimed and gets this — nothing is called
 * and nothing is written.
 */
export class ApprovalGateAlreadyRequeuedError extends ApprovalGateError {
  readonly tag = 'MERGE_ALREADY_REQUEUED' as const;
  readonly code = 'MERGE_ALREADY_REQUEUED' as const;
  constructor(readonly pullRequestId: string) {
    super(`Pull request ${pullRequestId} was already put back into the merge queue.`);
    this.name = 'ApprovalGateAlreadyRequeuedError';
  }
}

/**
 * APPROVE on a decision gate whose document cannot be named (Story MOTIR-4907 ·
 * MOTIR-5676; `approval-gates.md` §8's FIFTH AMENDMENT, clause 3). *"We could not find
 * it"* must never become *"nobody had to accept it"*, so the gate stays open, the merge
 * stays held, and the refusal says why: `none`, `several` or `unreadable`.
 */
export class ApprovalGateDecisionUnresolvableError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_DECISION_UNRESOLVABLE' as const;
  readonly code = 'APPROVAL_GATE_DECISION_UNRESOLVABLE' as const;
  constructor(readonly reason: 'none' | 'several' | 'unreadable') {
    super(`There is no single decision document to approve (${reason}).`);
    this.name = 'ApprovalGateDecisionUnresolvableError';
  }
}

/**
 * The PRIMARY question a card's merge follows (Bug MOTIR-5785): its DESIGN
 * (`design-result.md` AMENDMENT 6 Q1) or, once Story MOTIR-4907 lands, its DECISION
 * (`approval-gates.md` §8's FIFTH AMENDMENT). ONE refusal names either, so two primaries
 * holding one merge cannot drift into two differently-worded rules.
 */
/** Which primary holds the merge. `acceptance` is a STORY RUN's refused acceptance video
 *  (MOTIR-6503): not an open question, and still no merge until a newer video is approved. */
export type PendingPrimary = 'design' | 'decision' | 'acceptance';

/**
 * APPROVE on a card's approve-to-merge gate while its PRIMARY question is unanswered
 * (Bug MOTIR-5785). The primary's own press decides the primary FIRST and the merge
 * after, so it never meets this; any other door naming the merge gate's id — the REST
 * route, the merge row pressed alone — would merge commits nobody's primary decision
 * covers. Raised under the door's lock, before anything is written.
 */
export class ApprovalGatePrimaryPendingError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_PRIMARY_PENDING' as const;
  readonly code = 'APPROVAL_GATE_PRIMARY_PENDING' as const;
  constructor(
    readonly workItemId: string,
    readonly primary: PendingPrimary,
  ) {
    super(`The ${primary} on work item ${workItemId} has to be approved before it can merge.`);
    this.name = 'ApprovalGatePrimaryPendingError';
  }
}

export class ApprovalGateKindUnregisteredError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_KIND_UNREGISTERED' as const;
  readonly code = 'APPROVAL_GATE_KIND_UNREGISTERED' as const;
  constructor(readonly kind: string) {
    super(`No approval-gate handler is registered for kind \`${kind}\` in this build.`);
    this.name = 'ApprovalGateKindUnregisteredError';
  }
}

/**
 * A path that needs the gate's WORK ITEM met a gate that has none (Story MOTIR-6012 ·
 * MOTIR-6032; ADR `approval-gates.md` §11.1).
 *
 * Only a `plan_approval` gate may be card-less — the CHECK
 * `approval_gate_work_item_iff_not_plan` holds that at the database — so meeting one
 * on a path written for a card-bearing kind is a DEFECT in the caller, never a
 * refusal to render. The path that should have handled the card-less shape is
 * named in the message so the defect is findable.
 */
export class ApprovalGateHasNoCardError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_HAS_NO_CARD' as const;
  readonly code = 'APPROVAL_GATE_HAS_NO_CARD' as const;
  constructor(
    readonly gateId: string,
    readonly kind: string,
    readonly where: string,
  ) {
    super(
      `Approval gate ${gateId} (kind \`${kind}\`) belongs to no work item, and ${where} reads its card. Only a \`plan_approval\` gate is card-less.`,
    );
    this.name = 'ApprovalGateHasNoCardError';
  }
}

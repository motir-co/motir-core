// Typed errors for the AI-planning Plan substrate (Story 7.21 · MOTIR-1336).
// Kept in their own file so route handlers can import them without pulling in
// the Prisma client (the lib/<domain>/errors.ts convention). The service
// throws these; the route layer translates the stable `code` to an HTTP status.

/**
 * A proposal's fields are inconsistent with its `op` (an `add` with no
 * `proposedFields.title`, a `modify` with no `workItemId`/`patch`, a `remove`
 * with no `workItemId`). → 422
 */
export class InvalidProposalError extends Error {
  readonly code = 'INVALID_PROPOSAL' as const;
  /**
   * The offending proposal's id, when the refusal is raised over a PERSISTED
   * plan rather than at the write door that received the proposal — the approve
   * gate's mark-target check (MOTIR-6663), which `validate_plan` reports as a
   * rejection naming `planItem:<id>`. `null` at the write doors, where the
   * proposal has no id yet or the caller already knows which one it sent.
   */
  readonly planItemId: string | null;
  constructor(message: string, planItemId: string | null = null) {
    super(message);
    this.name = 'InvalidProposalError';
    this.planItemId = planItemId;
  }
}

/**
 * No `generating` plan resolves for a generation job (the internal proposals
 * seam, 7.4.4 · MOTIR-846): the job token's `sourceJobId` names no plan in this
 * workspace — the plan was never opened, belongs to another tenant, or the
 * generate seam's `createPlan` has not committed yet (the handler may retry).
 * → 404 (never 403 — no cross-tenant existence leak). */
export class NoPlanForJobError extends Error {
  readonly code = 'NO_PLAN_FOR_JOB' as const;
  constructor(jobId: string) {
    super(`No generation plan was found for job ${jobId}.`);
    this.name = 'NoPlanForJobError';
  }
}

/** The plan id does not resolve (in this workspace). → 404 */
/** A planner STEP signal that is not well-formed (Story MOTIR-7820 · MOTIR-7822)
 *  — `settle` naming a target, a ref this plan cannot resolve, a ref of the wrong
 *  shape, or an empty / over-long session key. Raised before anything is written.
 *  → 422 */
export class InvalidPlanStepError extends Error {
  readonly code = 'PLAN_STEP_INVALID' as const;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPlanStepError';
  }
}

export class PlanNotFoundError extends Error {
  readonly code = 'PLAN_NOT_FOUND' as const;
  constructor(planId: string) {
    super(`Plan ${planId} was not found.`);
    this.name = 'PlanNotFoundError';
  }
}

/** The plan-item id does not resolve within the given plan (the proposal-edit
 *  path, 7.21.6 · MOTIR-1370). → 404 */
export class PlanItemNotFoundError extends Error {
  readonly code = 'PLAN_ITEM_NOT_FOUND' as const;
  constructor(planItemId: string) {
    super(`Plan item ${planItemId} was not found in this plan.`);
    this.name = 'PlanItemNotFoundError';
  }
}

/**
 * A proposal append was attempted on a plan that is no longer `generating`
 * (it has been planned/decided), by a caller that did NOT declare itself a
 * REVISION. → 409
 *
 * ⚠️ THE MESSAGE NAMES THE DOOR NOW, because it stopped being a dead end
 * (MOTIR-4153). It used to end *"no more proposals can be appended"*, which was
 * true of every caller when it was written and is now true only of the
 * undeclared one: `addProposals`'s `revision` option — AMENDMENT 10 D1's
 * relaxation, reachable over the MCP as `add_plan_items { revision: true }`
 * (AMENDMENT 12) — appends to a `planned` plan and records itself on its
 * timeline. A `planned` plan reaching this error is therefore a caller one flag
 * away from what it wanted, and a refusal that does not say so costs it a whole
 * second plan plus a hand decline. `approved` / `declined` are a different
 * refusal entirely ({@link PlanNotEditableError}) and stay frozen.
 */
export class PlanNotGeneratingError extends Error {
  readonly code = 'PLAN_NOT_GENERATING' as const;
  /** `message` overrides the APPEND-shaped default, for a write that is not an
   *  append — the planner step signal (MOTIR-7822), which has no revision form. */
  constructor(planId: string, status: string, message?: string) {
    super(
      message ??
        `Plan ${planId} is ${status}, not generating — this append was not declared a revision. ` +
          (status === 'planned'
            ? 'It is in the review queue: send the same batch with `revision: true` to append to ' +
              'it where it stands. The plan stays `planned`, and the append lands on its timeline ' +
              'with the harness and model that made it.'
            : 'Only a `generating` plan takes an ordinary append, and only a `planned` one takes a ' +
              'revision.'),
    );
    this.name = 'PlanNotGeneratingError';
  }
}

/**
 * `markPlanned` / `approvePlan` / `declinePlan` was called from a status the
 * transition does not allow. The lifecycle is generating → planned →
 * approved|declined; each hop is legal only from its predecessor. Idempotency
 * + the lost-race loser both land here (the plan row is locked + re-read, so a
 * concurrent winner that already moved the status makes the loser observe the
 * new status and throw this). → 409
 */
export class PlanNotInExpectedStatusError extends Error {
  readonly code = 'PLAN_NOT_IN_EXPECTED_STATUS' as const;
  /**
   * The status the plan is ACTUALLY in, carried as DATA (MOTIR-3025).
   *
   * ⚠️ A CALLER HAS TO TELL TWO OF THESE APART and cannot do it from the
   * sentence. `generating` means *not yet — the planner is still writing*, and
   * `approved` / `declined` mean *someone already decided*. An unattended loop
   * should wait for the first and stop on the second, and parsing a message to
   * learn which is exactly what `public-api-conventions.md` §8 forbids. So it
   * rides the field, the same way `POST …/transitions` carries its allowed
   * targets rather than folding them into prose.
   */
  readonly actual: string;
  constructor(planId: string, actual: string, expected: string) {
    super(`Plan ${planId} is ${actual}; this action requires it to be ${expected}.`);
    this.name = 'PlanNotInExpectedStatusError';
    this.actual = actual;
  }
}

/**
 * APPROVE WAS ASKED TO MATERIALIZE A PLAN THAT PROPOSES NOTHING (MOTIR-4146).
 *
 * `approvePlan`'s only status gate is `planned`, and `planned` is orthogonal to
 * what the plan HOLDS — so an empty one approved: it materialized nothing and
 * wrote a decision saying a plan had been accepted into a backlog it never
 * touched, with `itemCount: 0` on the recorded revision. The vocabulary for what
 * actually happened already exists (`declined` + `decisionReason: 'discarded'`,
 * MOTIR-4124), and this refusal is what stops the record saying the other thing.
 *
 * MOTIR-4124 made the CLOSE discard an empty plan rather than queue it, so the
 * only rows that can still reach here are the LEGACY ones it deliberately left
 * unmigrated. That is why this is a refusal and not a discard of its own: the
 * decision belongs to the reviewer standing in front of the plan, and Decline is
 * the ending they already have. → 409
 */
export class PlanHasNoProposalsError extends Error {
  readonly code = 'PLAN_HAS_NO_PROPOSALS' as const;
  constructor(readonly planId: string) {
    super(
      `Plan ${planId} holds no proposals, so there is nothing to approve. ` +
        'Approving it would record a decision about a backlog it never touched — decline it instead, which is what a plan that ended without proposing anything means.',
    );
    this.name = 'PlanHasNoProposalsError';
  }
}

/**
 * A PlanItem references (parentRef / a blockedByRef) an intra-plan temp-ref
 * that does not resolve to a materialized add in the same plan, or a real
 * work-item id that does not exist.
 *
 * Raised at TWO moments now, and the second is the one that matters
 * (MOTIR-3539):
 *
 *   · at APPEND, by `assertRefsResolvable`, against the proposals the plan
 *     already holds — which is the whole resolvable set a temp-ref may name, so
 *     the answer is final the instant the ref arrives;
 *   · at MATERIALIZE (approve), by `resolveRef`, which stays exactly as it was
 *     — the backstop for every plan appended before the append check shipped.
 *
 * `proposal` is OPTIONAL and present only on the append side, where the batch is
 * still in hand and the offending proposal can be named. The approve path
 * constructs it with one argument and produces a byte-identical message to the
 * one it produced before this second call site existed. → 422
 */
export class UnresolvedPlanRefError extends Error {
  readonly code = 'UNRESOLVED_PLAN_REF' as const;
  constructor(ref: string, proposal?: string) {
    super(
      proposal
        ? `Plan reference "${ref}" on ${proposal} names no proposal in this plan. ` +
            'An intra-plan `planItem:` ref may only name an `add` returned by an ' +
            'EARLIER `add_plan_items` call on this same plan — never one appended ' +
            'in the same batch, whose id does not exist until that call returns.'
        : `Plan reference "${ref}" could not be resolved to a work item.`,
    );
    this.name = 'UnresolvedPlanRefError';
  }
}

/**
 * A modify/remove PlanItem whose target work item is missing (archived/deleted
 * out from under the plan after the proposal was appended). Surfaced at
 * materialize. → 422
 */
export class PlanItemTargetMissingError extends Error {
  readonly code = 'PLAN_ITEM_TARGET_MISSING' as const;
  constructor(workItemId: string) {
    super(`Plan item target work item ${workItemId} no longer exists.`);
    this.name = 'PlanItemTargetMissingError';
  }
}

/**
 * A proposal's `targetRepo` names a repository that is NOT in the PROJECT's
 * repository set (Story MOTIR-1775 · MOTIR-1884) — a typo, or a repo that belongs
 * to a sibling project of the same workspace.
 *
 * Why its own class rather than re-throwing `UnknownTargetRepoError`: a plan is a
 * SET of proposals, so "unknown repo X" is not actionable on its own — the
 * reviewer needs to know WHICH proposal carries it. The underlying message (which
 * names the project's known repositories, so the author can self-correct) is
 * carried through verbatim.
 *
 * → 422, the same status the identical mistake gets on the direct work-item write
 * path (`UnknownTargetRepoError` through the route layer's blanket
 * `WorkItemError` mapping) — a bad pin means the same thing however it arrived.
 * Raised BEFORE the approve transaction opens, so the tree and the plan's status
 * are untouched, exactly like the confirmation gate below.
 */
export class PlanItemUnknownTargetRepoError extends Error {
  readonly code = 'PLAN_ITEM_UNKNOWN_TARGET_REPO' as const;
  constructor(
    readonly planItemId: string,
    readonly repoName: string,
    message: string,
  ) {
    super(message);
    this.name = 'PlanItemUnknownTargetRepoError';
  }
}

/**
 * A proposal's `targetRepoRole` is not one of ADR §1.1's roles (Story MOTIR-1775 ·
 * MOTIR-1912) — `'backend'`, `''`, a number, anything the closed vocabulary does
 * not admit.
 *
 * A sibling of {@link PlanItemUnknownTargetRepoError}, and deliberately NOT the
 * same class: the two pins fail for different reasons and are fixed differently.
 * An unknown repo NAME is a fact about THIS project (its set does not hold that
 * repository); an unknown ROLE is a fact about the producer (it emitted a word
 * outside the enum the two repos share, `PROJECT_REPO_ROLES` ⟷ motir-ai's
 * proposal-schema role). Collapsing them would tell the author to check their
 * project's repositories for a mistake that is not there.
 *
 * Raised at BOTH boundaries a role can arrive through, so a bad value can never
 * reach the `targetRepoRole` column:
 *
 *   * `addProposals` — the append, where the PlanItem does not exist yet, so
 *     {@link planItemId} is `null` and {@link proposalLabel} identifies the
 *     offending proposal by its title (an `add`) or its target (a `modify`);
 *   * `approvePlan` — BEFORE the transaction opens, where the row exists and
 *     {@link planItemId} names it exactly. Cheap (the check is pure), and it is
 *     what makes "an unrecognised role materializes nothing" true even for a plan
 *     whose proposals were written before this validation shipped.
 *
 * → 422 at both, the same status a bad repo pin gets — a malformed pin means the
 * same thing however it arrived.
 */
export class PlanItemUnknownTargetRepoRoleError extends Error {
  readonly code = 'PLAN_ITEM_UNKNOWN_TARGET_REPO_ROLE' as const;
  constructor(
    /** The PlanItem's id, or `null` when it is not persisted yet (the append). */
    readonly planItemId: string | null,
    /** The offending proposal, as the author can recognise it. */
    readonly proposalLabel: string,
    /** The rejected value, stringified for a message (it may not be a string). */
    readonly role: string,
    message: string,
  ) {
    super(message);
    this.name = 'PlanItemUnknownTargetRepoRoleError';
  }
}

/**
 * A proposal's `targetRepo` MOVED between approve's pre-transaction resolution
 * and the transaction that materializes it (Bug MOTIR-3604,
 * `agent-authored-plans.md` AMENDMENT 9 D4).
 *
 * `approvePlan` resolves every pin against the project's repository domain
 * BEFORE its transaction opens — the domain read opens its own workspace context
 * and cannot nest inside the write lock. The transaction then re-reads the
 * proposal set FRESH. AMENDMENT 8's correction door (`correctProposal`) is legal
 * on a `planned` plan, so a correction landing in that window leaves the two
 * disagreeing, and the card materializes with the pin its proposal no longer
 * holds — or with none.
 *
 * → 409, not 422. Nothing is malformed: the plan and the correction are both
 * valid and the proposal set simply moved under the approve, which is the same
 * thing {@link PlanTargetImmutableError} and {@link PlanNotInExpectedStatusError}
 * say. The transaction rolls back, so the correction stands, the plan is still
 * `planned`, and re-pressing Approve resolves the NEW pin and succeeds. One
 * retry for a reviewer is the trade against a card pinned to the wrong
 * repository — a wrong answer nothing downstream can detect, because the plan's
 * own record reads correct.
 */
export class PlanProposalRepoPinMovedError extends Error {
  readonly code = 'PLAN_PROPOSAL_REPO_PIN_MOVED' as const;
  constructor(
    /** The PlanItem whose pin moved. */
    readonly planItemId: string,
    /** That proposal, as its author can recognise it. */
    readonly proposalLabel: string,
    /** The spelling the pre-transaction snapshot resolved, or `undefined` when
     *  the snapshot carried no pin for this proposal at all. */
    readonly resolvedFrom: string | null | undefined,
    /** The spelling the FRESH proposal authors now, same encoding. */
    readonly authoredNow: string | null | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'PlanProposalRepoPinMovedError';
  }
}

/**
 * The op a plan may hold at most one of per existing target. `add` is absent
 * deliberately: an `add` has no target until materialize (its `workItemId` is
 * null), which is exactly why the unique index constrains real targets only.
 */
export type PlanTargetOp = 'modify' | 'remove';

/**
 * A second proposal in ONE plan targets a work item the plan already proposes
 * against (MOTIR-3194) — a `modify` alongside a `remove` (either order), or a
 * second `remove`.
 *
 * ⚠️ NARROWED BY AMENDMENT 18 §2 (MOTIR-6051): a second `modify` of one card no
 * longer lands here — it MERGES into the plan's one `modify`
 * (`lib/plans/mergeModifyPatch.ts`). The three reasons below still hold, and a
 * merge keeps every one of them true: ONE row, so one diff with one old side;
 * ONE `baseRevision` (the earlier); and the constraint still refuses any pairing
 * with a `remove`. The text below is the record of the rule as MOTIR-3194 kept it.
 *
 * ## The rule, and why it is KEPT rather than relaxed
 *
 * `PlanItem @@unique([planId, workItemId])` is a decided rule, not an incidental
 * one — its schema comment says *"one op per target per plan"*, and NULLs being
 * distinct in Postgres is what still admits many `add`s in the same plan. This
 * card (MOTIR-3194) re-opened the question, because `materialize` walks
 * `for (const item of items)` and applies each `modify` in sequence, so nothing
 * DOWNSTREAM requires uniqueness. Three things upstream do:
 *
 *  1. **The review surface would show a wrong diff.** A PlanItem stores only the
 *     NEW values; the OLD side of every diff is read LIVE from the target. Two
 *     `modify` rows for one card therefore render as two independent diffs whose
 *     "from" is the same committed value — the second one silently omitting the
 *     first's changes. A person approves what they read, so a diff that cannot be
 *     rendered honestly is not a presentation problem.
 *  2. **`baseRevision` is per target, not per row.** It is the optimistic-concurrency
 *     anchor a `modify`/`remove` is computed against; two rows for one target carry
 *     two anchors with no defined precedence between them.
 *  3. **The constraint spans `modify` AND `remove`,** so relaxing it wholesale would
 *     admit a plan that patches a card and archives it in the same approval. A
 *     partial relaxation for `modify`+`modify` alone buys a caller nothing that
 *     merging the two patches does not already buy.
 *
 * And the caller loses nothing: two patches that would merge cleanly can simply BE
 * one patch, and a dependency edge between two work items that ALREADY exist never
 * needed a proposal at all (`link_work_items` writes it directly). The message says
 * both, because the mistake this replaces was an ORM string that said neither.
 *
 * → 409 (the plan already holds a proposal for that target), and the MCP surface's
 * `DUPLICATE_PLAN_TARGET`.
 */
export class DuplicatePlanTargetError extends Error {
  readonly code = 'DUPLICATE_PLAN_TARGET' as const;
  constructor(
    /** The target both proposals name. */
    readonly workItemId: string,
    /** The op the plan ALREADY holds for it. */
    readonly existingOp: PlanTargetOp,
    /** The op that was refused. */
    readonly op: PlanTargetOp,
  ) {
    super(
      `This plan already holds a \`${existingOp}\` proposal for work item ${workItemId}, and a ` +
        `plan holds at most ONE proposal per existing target — so this \`${op}\` is refused. ` +
        `A second \`modify\` merges into the first, but a \`modify\` and a \`remove\` of one card, ` +
        `or two \`remove\`s, cannot both stand: withdraw the first proposal ` +
        `(\`withdraw_plan_proposal\`) if you have changed your mind about ${workItemId}; or, if what ` +
        `you are recording is a dependency edge between two work items that ALREADY exist, call ` +
        `\`link_work_items\` — an edge between committed items needs no proposal at all.`,
    );
    this.name = 'DuplicatePlanTargetError';
  }
}

/**
 * An ORM failure escaping the plan-append boundary, CONTAINED (MOTIR-3194).
 *
 * ⚠️ THIS CLASS EXISTS SO THAT A PRISMA STRING CANNOT BE A PRODUCT SURFACE. The
 * defect it closes was not the duplicate-target rule above; it was that the rule
 * announced itself as
 * `Invalid \`prisma.planItem.create()\` invocation: Unique constraint failed on the
 * (not available)` — an ORM method name, no subject, and a constraint field that
 * renders as literally nothing. `toToolError` re-throws what it does not
 * recognise, so an unmapped ORM error reaches an agent as a JSON-RPC internal
 * error carrying that text verbatim.
 *
 * Naming the ONE duplicate case would have left every other Prisma failure on the
 * same path (a foreign key, a broken connection, a validation error) escaping the
 * same way. So the append wraps its whole transaction and converts ANY Prisma
 * error to this — a stable `code`, a message written for the caller, and the ORM's
 * own code carried as DATA rather than folded into prose.
 *
 * It is deliberately NOT actionable-sounding: reaching it means the write failed
 * for a reason the boundary does not model, and the honest thing to tell an agent
 * is that its proposals are not at fault and nothing was appended. The one code
 * worth a hint is `P2002`, which is the duplicate-target rule arriving through a
 * race the pre-check cannot see.
 *
 * → 500 (it IS a server-side failure — what changes is that it is typed).
 */
export class PlanPersistenceError extends Error {
  readonly code = 'PLAN_PERSISTENCE_FAILED' as const;
  constructor(
    /**
     * The boundary that failed, phrased so BOTH doors onto it can carry the same
     * string: the `add_plan_items` MCP tool and the internal generator seam
     * (`POST /api/internal/ai/plan-proposals`) both reach `addProposals`, and
     * naming either one would misdescribe the other's caller.
     */
    readonly operation: string,
    /** The ORM's own error code (`P2002`, …) when it had one, else null. */
    readonly ormCode: string | null,
  ) {
    super(
      `The database refused the ${operation}` +
        (ormCode ? ` (${ormCode})` : '') +
        `. Nothing was appended and the plan is unchanged.` +
        (ormCode === 'P2002'
          ? ' A uniqueness constraint fired: a plan holds at most one `modify`/`remove` proposal' +
            ' per target work item, so append one proposal per target.'
          : ''),
    );
    this.name = 'PlanPersistenceError';
  }
}

// ── The persist-time confirmation gate (Subtask 7.12.5 · MOTIR-911) ───────────
// The three rejections `validatePlanProposals` raises BEFORE approve writes
// anything. They are deliberately distinct from the errors above: those surface
// a proposal that went bad DURING materialize; these say the approved proposal
// set may not be persisted AT ALL, and are raised while the tree is still
// byte-identical.

/** Why a proposal set violates the kind-parent grammar. */
export type PlanGrammarViolation =
  /** The proposed (parent kind → child kind) pair the matrix forbids, or a
   *  top-level placement of a kind that requires a parent. */
  | 'illegal_parent'
  /** An `add` proposing a `kind` that is not one of the five issue types, or a
   *  `modify` whose `patch.kind` is not one a target may be re-kinded to
   *  (`MODIFY_KIND_TARGETS` — no `epic`; bug MOTIR-8192). */
  | 'unknown_kind'
  /**
   * An `add` proposing a `type` that is not one of the fourteen `WorkItemType`
   * members (MOTIR-3654). The twin of `unknown_kind`, and it is owed by the same
   * argument this module's header makes for re-checking `kind`: the approved set
   * can be edited between generation and approve (`updateProposal`), so the
   * proposal is not trusted here. Without it an out-of-enum `type` reaches
   * `prisma.workItem.create()` and raises a `PrismaClientValidationError` from
   * inside the transaction — which is exactly the raw-ORM-failure-as-500 this
   * gate exists to prevent, one column over from `kind`.
   */
  | 'unknown_type'
  /**
   * An `add` proposing, or a `modify` patching in, a `priority` that is not one
   * of the five `WorkItemPriority` members (MOTIR-10656) — the third closed-set
   * column after `kind` and `type`, re-checked for the same reason. The internal
   * AI routes forward the planner's value as sent, so without it a `"p2"` passed
   * `validate_plan` and was refused only by `prisma.workItem.create()` inside
   * approve, as `PLAN_ITEM_FIELD_REJECTED`.
   */
  | 'unknown_priority'
  /**
   * An `add` proposing a card-level `executor` that is not one of the two
   * `Executor` members (MOTIR-10678) — the fourth closed-set column, re-checked
   * for the same reason as `priority`. The internal AI routes forward the
   * planner's value as sent, so without it an `"agent"` passed `validate_plan`
   * and was refused only by `prisma.workItem.create()` inside approve, as
   * `PLAN_ITEM_FIELD_REJECTED`. A `modify` patch carries no `executor` (it is
   * the target's), so there is no `modify` half.
   */
  | 'unknown_executor'
  /**
   * A `modify` whose `patch.parentRef` would push the target past the tree's
   * depth cap of 4 (MOTIR-3859). The SAME arithmetic
   * `enforce_work_item_depth_limit` runs — the new parent's own chain length
   * plus one — taken here so the refusal names the plan item instead of
   * arriving as `WI_DEPTH_LIMIT_EXCEEDED` wrapped in a `PlanPersistenceError`
   * halfway through an approve.
   */
  | 'parent_depth_limit'
  /**
   * A `modify` whose `patch.parentRef` names a parent in a TERMINAL status
   * (MOTIR-3859). Not an aesthetic rule: status derivation recomputes a parent
   * from its CURRENT child set on `work-item/child-set.changed` and applies the
   * result backward, so materializing a re-parent under a `done` card returns
   * that card to an open status and walks the re-open up its whole ancestor
   * chain — dropping every card `blocked_by` anything that came back out of the
   * ready set. The interactive `move_to_parent` has a human watching it; an
   * approve has nobody, which is why the plan path is the one that must refuse.
   */
  | 'parent_terminal'
  /**
   * An `add` proposing a `subject` that is not a well-formed slug (Story
   * MOTIR-5062 · MOTIR-5065) — the twin of `unknown_type`, and owed by this
   * module's own argument for re-checking `kind` and `type`: the approved set can
   * be edited between generation and approve, so the proposal is not trusted.
   *
   * ⚠️ IT IS A SHAPE VIOLATION, NEVER A MEMBERSHIP ONE, and the difference is the
   * story's central decision rather than a looseness here. The subject vocabulary
   * IS the rule-pack file set in `motir-meta`, so this repository does not hold
   * the list and cannot: a well-formed but UNRECOGNISED member is accepted and
   * refused one hop later, by the planner's own resolver. What this refuses is a
   * value that could not name a `subject-<name>.md` file at all.
   */
  | 'malformed_subject'
  /**
   * A non-null DIFFICULTY on a container kind (Story MOTIR-6095 · MOTIR-6133;
   * `agent-authored-plans.md` AMENDMENT 19) — an `add` proposing an `epic` /
   * `story` with one, or a `modify` whose `patch.difficulty` targets a work item
   * that is a container NOW. The proposal doors refuse both with
   * `INVALID_PROPOSAL`; this reason exists for the one path they cannot see, a
   * committed target re-kinded to a container after the append. Without it,
   * approve writes the column directly (it bypasses `workItemsService`) and a
   * story ends up with the difficulty every other door refuses it.
   */
  | 'difficulty_on_container'
  /**
   * A `modify` re-kinding its target to a CONTAINER (`story`) while the target
   * keeps a non-null `type` (bug MOTIR-8192; `agent-authored-plans.md`
   * AMENDMENT 25) — the projected type is the patch's `type` when it carries
   * one, else the target's. `workItemsService` refuses the same end state with
   * `TypeNotAllowedOnKindError`; approve writes the row directly, so the plan
   * path refuses it here, by name, rather than clearing a field nobody asked to
   * clear. The patch fixes it with `type: null`.
   */
  | 'type_on_container'
  /**
   * A `modify` whose `patch.todos` REPLACES the step list of a target that is a
   * container in the projected tree (MOTIR-8668; `agent-authored-plans.md`
   * AMENDMENT 27). The proposal doors refuse it with `INVALID_PROPOSAL`; this
   * reason is for the one path they cannot see, a target re-kinded to a
   * container after the append. Approve writes the rows directly, so without it
   * a story would carry the to-do list every other door refuses it.
   */
  | 'todos_on_container';

/*
 * ⚠️ `subject_on_container` WAS A MEMBER AND IS RETIRED (MOTIR-5607).
 *
 * It refused an `add` proposing a `subject` on a container kind (Story
 * MOTIR-5062 · MOTIR-5065), mirroring the refusal of a `type` on an
 * `epic` / `story`. A subject is now legal on EVERY kind, so the code had no
 * throw site left — and a refusal reason that cannot fire is dead vocabulary the
 * classification test below would go on classifying for ever. It is removed from
 * the union rather than kept as a declared-but-unreachable member: the record
 * beneath is compile-enforced in BOTH directions, so nothing can reference it
 * silently.
 *
 * The two axes it conflated are now separate. `TYPEABLE_KINDS` still gates
 * `type` / `executor` — an epic still cannot carry a `type` — and is no longer
 * consulted about a subject at either write boundary.
 */

/**
 * Every {@link PlanGrammarViolation} member, ENUMERABLE AT RUNTIME (MOTIR-3936).
 *
 * The union above is the documented source; this record is what makes it
 * countable, and the compiler enforces the two agree in BOTH directions — a
 * missing key is an error and an extra one is too. That totality is the whole
 * point: `tests/plans/approveRefusalClassification.test.ts` derives the refusal
 * set from these arrays and fails until a newly added reason has been classified
 * as plan-internal or tree-caused, so a new reason cannot default into the
 * un-checked bucket.
 */
const PLAN_GRAMMAR_VIOLATION_MEMBERS: Record<PlanGrammarViolation, true> = {
  illegal_parent: true,
  unknown_kind: true,
  unknown_type: true,
  unknown_priority: true,
  unknown_executor: true,
  parent_depth_limit: true,
  parent_terminal: true,
  malformed_subject: true,
  difficulty_on_container: true,
  type_on_container: true,
  todos_on_container: true,
};

/** {@link PlanGrammarViolation}'s members as an array — see the record above. */
export const PLAN_GRAMMAR_VIOLATIONS = Object.keys(
  PLAN_GRAMMAR_VIOLATION_MEMBERS,
) as PlanGrammarViolation[];

/**
 * The proposal set does not satisfy the kind-parent grammar
 * (`lib/issues/parentRules.ts` — the SAME single-source matrix
 * `workItemsService` enforces), re-validated at persist independently of
 * whatever the planner self-checked. Raised BEFORE any write, so the tree and
 * the plan's status are untouched. → 400 (the proposal is malformed; the DB
 * trigger's raw SQLSTATE 23514 mid-transaction is exactly what this prevents).
 */
export class PlanGrammarError extends Error {
  readonly code = 'PLAN_GRAMMAR_VIOLATION' as const;
  constructor(
    readonly reason: PlanGrammarViolation,
    readonly planItemId: string,
    message: string,
  ) {
    super(message);
    this.name = 'PlanGrammarError';
  }
}

/** Why a plan's `parentRef` / `blockedByRefs` graph cannot be materialized. */
export type PlanRefGraphViolation =
  /** A ref resolving to neither a same-plan `add` nor an existing work item. */
  | 'dangling'
  /** The same blocker listed twice on one proposal (the `is_blocked_by` edge is
   *  `@@unique([fromId, toId, kind])`, so materializing it would 500). */
  | 'duplicate'
  /** A `parentRef` cycle among the plan's `add`s (no parent-before-child order
   *  exists), or a proposal blocking/parenting itself. */
  | 'cycle'
  /** A `blocked_by` joining two different LEVELS — two items at different
   *  depths below their nearest common ancestor (MOTIR-6387). A same-level
   *  edge may cross parents; a cross-level one never may (Story MOTIR-6015 ·
   *  MOTIR-6367 / 6411). */
  | 'cross_level';

/**
 * Every {@link PlanRefGraphViolation} member, ENUMERABLE AT RUNTIME — the twin of
 * {@link PLAN_GRAMMAR_VIOLATIONS} above, and total in the same compiler-enforced
 * way.
 */
const PLAN_REF_GRAPH_VIOLATION_MEMBERS: Record<PlanRefGraphViolation, true> = {
  dangling: true,
  duplicate: true,
  cycle: true,
  cross_level: true,
};

/** {@link PlanRefGraphViolation}'s members as an array — see the record above. */
export const PLAN_REF_GRAPH_VIOLATIONS = Object.keys(
  PLAN_REF_GRAPH_VIOLATION_MEMBERS,
) as PlanRefGraphViolation[];

/**
 * The plan's intra-plan ref graph is not materializable — a dangling ref, a
 * duplicate blocker, or a cycle. Raised BEFORE any write. → 400
 *
 * ⚠️ ONE CASE THE PLAN REVIEW MAPS TO COPY, SO ITS SHAPE IS STABLE (Story
 * MOTIR-5310 · MOTIR-5423): a `folder:<id>` placement whose folder was DELETED
 * after the append refuses the whole approve with `code: 'INVALID_PLAN_REF_GRAPH'`,
 * `reason: 'dangling'`, `planItemId` = the proposal, and a message naming the
 * ref (the folder's id — its name went with the row). A folder MOVED to another
 * project is {@link PlanGrammarError} `illegal_parent` instead. Nothing is
 * materialized and the plan stays `planned`.
 */
export class PlanRefGraphError extends Error {
  readonly code = 'INVALID_PLAN_REF_GRAPH' as const;
  constructor(
    readonly reason: PlanRefGraphViolation,
    readonly planItemId: string,
    message: string,
  ) {
    super(message);
    this.name = 'PlanRefGraphError';
  }
}

/**
 * DONE-WORK IMMUTABILITY: a `modify` / `remove` proposal targets a work item in
 * a TERMINAL status (any `category = done` — resolved through
 * `workflowsService.getTerminalStatusKeys`, never a hardcoded `'done'`).
 * Completed work is not rewritten by an approve. Raised before any write, and
 * re-raised from the locked in-transaction re-read (the verdict taken from a
 * pre-transaction snapshot goes stale under a concurrent transition —
 * `notes.html` #35). → 409 (the target moved under the proposal).
 */
export class PlanTargetImmutableError extends Error {
  readonly code = 'PLAN_TARGET_IMMUTABLE' as const;
  /**
   * `key` / `title` NAME the card (MOTIR-3936) — this refusal is TREE-CAUSED, so
   * it is the one a reviewer meets most often and can do nothing about from a
   * cuid. Optional because the in-transaction re-read raises the same class from
   * a locked row, and a caller that has only the id still gets the old message.
   */
  constructor(
    readonly planItemId: string,
    readonly workItemId: string,
    readonly status: string,
    readonly key: string | null = null,
    readonly title: string | null = null,
  ) {
    super(
      `Work item ${key ? `${key} "${title ?? ''}"` : workItemId} is in the terminal status "${status}" — completed work cannot be modified or removed by approving a plan.`,
    );
    this.name = 'PlanTargetImmutableError';
  }
}

/**
 * There is no plan for this work item to approve (MOTIR-3021 / MOTIR-3023,
 * `docs/decisions/run-findings-protocol.md` Q2 bound B1). → 422
 *
 * ⚠️ THIS IS THE BOUND, and it is what keeps the public approval entrance from
 * being "approve any pending plan in the workspace". An unattended loop may
 * approve the plan its own refused card CAUSED, and nothing else — every other
 * plan (a cadence plan, an onboarding generation, one submitted from the
 * project-wide panel) keeps the human gate it was written under.
 *
 * A plan belongs to a card when the plan-change conversation ANCHORED at that
 * card submitted the job the plan was produced by. No such conversation, or one
 * that has never submitted, means there is nothing here for an automated
 * approval to act on — refused, deliberately, rather than read as
 * unanchored-so-allowed.
 */
export class NoPlanForWorkItemError extends Error {
  readonly code = 'NO_PLAN_FOR_WORK_ITEM' as const;
  constructor(readonly workItemKey: string) {
    super(
      `No submitted plan is anchored to ${workItemKey}. Automatic approval acts only on the plan a run's own refused work item produced; approve any other plan in Motir.`,
    );
    this.name = 'NoPlanForWorkItemError';
  }
}

/**
 * `approvePlan`'s transaction exhausted its budget before committing — Prisma
 * P2028, either half (`maxWait`, no free connection; or `timeout`, mid-body).
 * The transaction rolled back, so the tree is byte-identical and the plan is
 * still `planned`: this is a RETRYABLE failure, and saying so is the entire
 * point of the class. → 503
 *
 * ⚠️ IT CARRIES THE ITEM COUNT, AND THAT IS THE ACTIONABLE PART (MOTIR-3396).
 * Before this existed, P2028 fell through the route's error map to a bare 500
 * with an empty body — so the only move a person had was to press Approve
 * again, which is what happened three times on the plan that produced this bug.
 * A 500 says "something broke"; a 503 naming the plan and how many proposals it
 * carries says "this plan is too large for one transaction", which is a sentence
 * someone can act on (approve a smaller plan, or file the ceiling).
 *
 * The count is the proposal count, not the edge count, because the proposal
 * count is what the person clicking Approve can see on the review surface.
 */
export class PlanApproveTimedOutError extends Error {
  readonly code = 'PLAN_APPROVE_TIMED_OUT' as const;
  constructor(
    readonly planId: string,
    readonly itemCount: number,
  ) {
    super(
      `Approving plan ${planId} (${itemCount} proposal${itemCount === 1 ? '' : 's'}) exceeded the transaction budget and was rolled back. Nothing was created and the plan is still awaiting a decision — retry, and if it keeps timing out the plan is too large to materialize in one transaction.`,
    );
    this.name = 'PlanApproveTimedOutError';
  }
}

/**
 * A proposal carried a field value the `work_item` schema will not accept, and
 * the ORM said so from inside `materialize`'s transaction (MOTIR-3654). → 422
 *
 * ⚠️ THIS IS THE LAST ARM, NOT THE FIRST. Three checks stand in front of it and
 * each is the better place to be caught: the tool schemas refuse an out-of-enum
 * value at the append (`authorPlan.ts`, `z.enum(WORK_ITEM_TYPES)`), and
 * `validatePlanProposals` re-checks `kind` and `type` before the transaction
 * opens. This class exists for what gets past all three — a column widened
 * without its writer, a value written by a path that predates the schema — and
 * for the reason `PlanApproveTimedOutError` exists one failure over: **a
 * `PrismaClientValidationError` escaping to the route's rethrow is a bare 500
 * with an EMPTY BODY**, and an empty body is why Approve gets pressed twice.
 *
 * It names the PROPOSAL and, where the ORM's message yields it, the FIELD —
 * because "your plan is malformed" is not actionable and "proposal
 * `<id>`: `type` is not a valid value" is. The transaction rolled back, so the
 * tree is byte-identical and the project's key counter has not advanced.
 *
 * The field is optional on purpose: it is parsed from Prisma's rendered message
 * rather than asserted, and a null field with a real `planItemId` is strictly
 * better than a 500. Never widen the parse into a claim the message does not
 * carry.
 */
export class PlanItemFieldRejectedError extends Error {
  readonly code = 'PLAN_ITEM_FIELD_REJECTED' as const;
  constructor(
    readonly planItemId: string,
    readonly field: string | null,
    readonly ormMessage: string,
  ) {
    super(
      `Proposal ${planItemId} carries a value the work-item schema rejects${
        field ? ` for \`${field}\`` : ''
      }. Nothing was created and the plan still awaits a decision — correct the proposal (\`update_plan_proposal\`) and approve again.`,
    );
    this.name = 'PlanItemFieldRejectedError';
  }
}

/**
 * A CORRECTION, a WITHDRAW, a REVISION APPEND or a BRIEF EDIT was attempted on a
 * plan that is FROZEN (Story MOTIR-3533 · Subtask MOTIR-3540; the third verb
 * MOTIR-4153; the fourth MOTIR-4637).
 *
 * ⚠️ THE FOURTH VERB IS ABOUT THE PLAN, NOT ITS PROPOSALS — `correctPlanBrief`
 * edits the plan's own `title` / `summary`. It shares this refusal because it
 * shares the boundary exactly: `generating` and `planned` are editable and a
 * DECIDED plan is a record. The message says both halves rather than only the
 * one it was first written for.
 *
 * `generating` and `planned` are editable; `approved` and `declined` are not,
 * for two different reasons the message states rather than implies:
 *
 *   · **approved** — the proposals have MATERIALIZED. The work item is now the
 *     source of truth and `update_work_item` is its door, so editing the
 *     proposal afterwards would leave two disagreeing records of one thing.
 *   · **declined** — a closed decision. There is nothing downstream for an edit
 *     to reach.
 *
 * The refusal NAMES the status and points at the editable surface, because the
 * caller is usually an agent that can act on being told where to go and cannot
 * act on being told no. → 409
 */
export class PlanNotEditableError extends Error {
  readonly code = 'PLAN_NOT_EDITABLE' as const;
  constructor(
    readonly planId: string,
    readonly status: string,
  ) {
    super(
      `Plan ${planId} is \`${status}\` — its own title and summary can no longer be edited, ` +
        'and its proposals can no longer be corrected, withdrawn or appended to. ' +
        (status === 'approved'
          ? 'Its proposals have materialized into work items, which are now the source of truth: edit the work item with `update_work_item` instead, and read the plan as the record of what was approved.'
          : 'A declined plan is a closed decision; author a new plan instead.') +
        ' Only a `generating` or `planned` plan is editable.',
    );
    this.name = 'PlanNotEditableError';
  }
}

/**
 * A WITHDRAW would have left a SIBLING proposal's ref pointing at nothing
 * (Story MOTIR-3533 · Subtask MOTIR-3540).
 *
 * The mirror of the append-time check: MOTIR-3539 made it impossible to CREATE a
 * dangling ref, and this is what stops one being created by DELETION instead.
 * Reported rather than cascaded — removing the siblings that referenced it would
 * take cards off the plan the caller never asked to withdraw, and silently
 * blanking their refs would change what those proposals mean.
 *
 * The message names every referrer, so one refusal is one round trip: correct
 * or withdraw them first, then retry. → 409
 */
export class PlanProposalReferencedError extends Error {
  readonly code = 'PLAN_PROPOSAL_REFERENCED' as const;
  constructor(
    readonly planItemId: string,
    readonly referrers: readonly string[],
  ) {
    super(
      `Proposal ${planItemId} cannot be withdrawn: ${referrers.length} other proposal${
        referrers.length === 1 ? '' : 's'
      } in this plan still reference it (${referrers.join(', ')}). ` +
        'Correct or withdraw those first — withdrawing it now would leave their refs pointing at nothing, which is the state the append-time ref check exists to prevent.',
    );
    this.name = 'PlanProposalReferencedError';
  }
}

/**
 * A DECISION raced a REVISION, and the decision lost (Story MOTIR-3595 ·
 * Subtask MOTIR-3598; `docs/decisions/agent-authored-plans.md` AMENDMENT 10 D2).
 *
 * `approvePlan` re-reads the proposal set FRESH under the plan row lock and
 * materializes it in ONE transaction, so every individual write is atomic and
 * the COMPOSITION is not: a revision is a SEQUENCE of transactions, and an
 * approve that takes the lock between the third and the fourth of them
 * materializes a tree that is neither the plan the reviewer read nor the plan
 * they asked for. Approve is one-shot — there is no un-approve — so the failure
 * is unrecoverable and the guard is a REFUSAL rather than a merge.
 *
 * ⚠️ THROWN INSIDE THE TRANSACTION, under the same plan row lock the lease is
 * acquired with. Checked before it, this would be a TOCTOU read; checked under
 * the lock it is an exclusion. Nothing is written when it fires: the plan stays
 * `planned`, no proposal is touched, and no work item is created.
 *
 * Neither act cancels the other — the loser retries — so the message says WHO
 * holds the plan and WHEN the lease expires, which is what makes retrying a real
 * instruction rather than advice. → 409
 */
export class PlanRevisionInFlightError extends Error {
  readonly code = 'PLAN_REVISION_IN_FLIGHT' as const;
  constructor(
    readonly planId: string,
    readonly heldBy: string | null,
    readonly expiresAt: Date,
  ) {
    super(
      `Plan ${planId} is being revised${heldBy ? ` by ${heldBy}` : ''} and cannot be decided until the revision lands. ` +
        `The revision holds this plan until ${expiresAt.toISOString()}; nothing has been changed. Try again once it lands.`,
    );
    this.name = 'PlanRevisionInFlightError';
  }
}

/**
 * A planning run tried to file MORE bugs than its job may (Story MOTIR-4053 ·
 * MOTIR-4076; the VOLUME axis of `planner-files-tenant-bug.md` §3). Counted on
 * the job's plan trail under the plan's row lock. → 409 — the request is
 * well-formed; what it conflicts with is the trail's existing content, the same
 * reason `DuplicatePlanTargetError` is a 409. Carries the cap and the count so
 * the caller can report WHICH bound it hit without parsing the sentence.
 */
export class PlannerBugCapExceededError extends Error {
  readonly code = 'PLANNER_BUG_CAP_EXCEEDED' as const;
  constructor(
    readonly planId: string,
    readonly cap: number,
    readonly filed: number,
  ) {
    super(
      `This planning job has already filed ${filed} bug(s), the most it may file (${cap}). ` +
        `Report any further defect in the plan's summary instead.`,
    );
    this.name = 'PlannerBugCapExceededError';
  }
}

/**
 * A plan-history `?cursor=` that is not one this read minted (Story MOTIR-5542 ·
 * MOTIR-5546) — undecodable, or naming no `(createdAt, id)` pair. → 400: a
 * cursor is opaque, so a malformed one is a client error, never an empty page.
 */
export class InvalidPlanHistoryCursorError extends Error {
  readonly code = 'INVALID_PLAN_HISTORY_CURSOR' as const;
  constructor() {
    super('The plan history cursor is not valid. Request the first page again.');
    this.name = 'InvalidPlanHistoryCursorError';
  }
}

/**
 * A `planned` plan that has NO question asked about it yet — no `awaiting`
 * `plan_approval` gate (Story MOTIR-6012 · MOTIR-6038; ADR `approval-gates.md`
 * §11.8, §11.9). The pre-backfill state: the plan reached `planned` before its
 * raise shipped, so there is no gate for the decide door to lock or record.
 *
 * ⚠️ A REFUSAL, NOT A FALLBACK. Deciding it around the door would write the one
 * decision the record could never show, so every entrance says *not decidable
 * yet* instead, and the backfill (MOTIR-6039) is what makes it decidable. → 409
 */
export class PlanNotDecidableYetError extends Error {
  readonly code = 'PLAN_NOT_DECIDABLE_YET' as const;
  constructor(readonly planId: string) {
    super(
      `Plan ${planId} cannot be decided yet: nobody has been asked to approve it. ` +
        `Nothing has been changed; it becomes decidable once its approval is raised.`,
    );
    this.name = 'PlanNotDecidableYetError';
  }
}

/**
 * A PLAIN plan writer met an `awaiting` plan gate under the plan's lock
 * (MOTIR-6038; ADR §11.8's converse). While a plan's question is asked, ONLY the
 * decide door writes `approved` / `declined` onto it — `approvePlan` /
 * `declinePlan`'s own bodies refuse, so a race that raised the gate between an
 * entrance's read and its write cannot decide the plan around it. → 409
 */
export class PlanGateAwaitingError extends Error {
  readonly code = 'PLAN_GATE_AWAITING' as const;
  constructor(
    readonly planId: string,
    readonly gateId: string,
  ) {
    super(
      `Plan ${planId} is waiting on its approval (${gateId}); it is decided through that approval. ` +
        `Nothing has been changed — read the plan again and decide it there.`,
    );
    this.name = 'PlanGateAwaitingError';
  }
}

/**
 * A PERSON's decision of a plan whose question is asked arrived without the
 * `stamp` its render read returned (MOTIR-6038; ADR §6b's MOTIR-5234 amendment,
 * §11.3). The door never guesses what a reader saw. → 400
 */
export class PlanDecisionStampRequiredError extends Error {
  readonly code = 'PLAN_DECISION_STAMP_REQUIRED' as const;
  constructor(readonly planId: string) {
    super(
      `Deciding plan ${planId} needs the \`stamp\` its review read returned — pass the stamp you were shown.`,
    );
    this.name = 'PlanDecisionStampRequiredError';
  }
}

/**
 * A `reason_classified` write whose BRANCH and `planningBugId` contradict each
 * other, or whose bug id does not name a `bug` (Story MOTIR-5543 · MOTIR-6083).
 *
 * The four branches split two and two, and the split IS the card: `rule_gap` and
 * `rule_not_followed` are about the planner and each file exactly one planning
 * bug; `new_ask` and `different_solution` are about the person and file none. So
 * a rule branch with no bug id, and a no-bug branch carrying one, are both a
 * classification that disagrees with itself — and a trail that can disagree with
 * itself is read as evidence anyway, which is the whole reason the write is
 * validated rather than trusted.
 *
 * ⚠️ REFUSED, NOT COERCED. Dropping a stray bug id, or filing a bug to satisfy a
 * branch, would each make the row say something its caller did not: the point of
 * recording a judgement is that it is the caller's.
 *
 * The message NAMES the branch and what it requires, because the caller is
 * normally an agent that can act on being told the rule and cannot act on being
 * told no. → 400
 */
export class PlanRevisionClassificationInvalidError extends Error {
  readonly code = 'PLAN_REVISION_CLASSIFICATION_INVALID' as const;
  constructor(
    readonly planId: string,
    readonly branch: string,
    readonly reason: string,
  ) {
    super(`The \`${branch}\` classification for plan ${planId} is not recordable: ${reason}`);
    this.name = 'PlanRevisionClassificationInvalidError';
  }
}

/**
 * The approved-shape verdict (Story MOTIR-5544 · MOTIR-6225) was asked about
 * more work items than one read answers. → 400: the caller splits the set; a
 * silently truncated answer would read as "the rest have no plan".
 */
export class ApprovedShapeVerdictTooManyIdsError extends Error {
  readonly code = 'APPROVED_SHAPE_VERDICT_TOO_MANY_IDS' as const;
  constructor(
    readonly requested: number,
    readonly max: number,
  ) {
    super(`The approved-shape verdict answers at most ${max} work items; ${requested} were asked.`);
    this.name = 'ApprovedShapeVerdictTooManyIdsError';
  }
}

/**
 * The approved-shape verdict's MCP door (Story MOTIR-5544 · MOTIR-6227) was
 * handed a `childKeys` entry that is not a child of the container it named. →
 * 422: refused BY NAME rather than answered, because an answer about a card the
 * caller wrongly believes is under the container reads exactly like a verdict on
 * the container's own child — and an agent cannot tell a silent default from
 * success.
 */
export class ApprovedShapeChildKeyNotAChildError extends Error {
  readonly code = 'APPROVED_SHAPE_NOT_A_CHILD' as const;
  constructor(
    readonly childKey: string,
    readonly parentKey: string,
  ) {
    super(
      `${childKey} is not a child of ${parentKey}. Pass only the keys of ${parentKey}'s own ` +
        'children as `childKeys`, or ask about the card on its own with `key`.',
    );
    this.name = 'ApprovedShapeChildKeyNotAChildError';
  }
}

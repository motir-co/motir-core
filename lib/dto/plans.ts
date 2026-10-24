// DTO types for the AI-planning Plan substrate (Story 7.21 · MOTIR-1336). The
// shape that crosses the API boundary — no Prisma row leaks (Date objects
// become ISO strings, the Prisma `PlanStatus` / `PlanItemOp` enums become
// string unions, the `proposed_fields` / `patch` JSON columns become typed
// objects). The 7.4.5 plan-detail + 7.4.13 plans-list UIs bind to these.

import type { JobStatus, SubmittedRequirement } from '@/lib/ai/types';
import type {
  CrossLevelEdgeDto,
  ExecutorDto,
  InvalidEdgeDto,
  WorkItemDifficultyDto,
  WorkItemObsolescenceDto,
  WorkItemPlanningSourceDto,
} from '@/lib/dto/workItems';
import type { ProjectRepoRoleDto } from '@/lib/dto/projectRepos';
import type { SprintBlockerDto } from '@/lib/dto/sprints';
import type { SectionFindingDto } from '@/lib/dto/workItems';
import type { PlanSessionOriginDto } from '@/lib/dto/planChange';
import type { Locale } from '@/lib/i18n/locales';
import type { WorkItemSections } from '@/lib/workItems/sections/registry';

/** Wire form of the Prisma `PlanStatus` enum, as a VALUE — so a surface that
 *  must be total over the lifecycle (the tab strip, the per-status counts) can
 *  iterate it instead of restating it. The type below is DERIVED from this
 *  array, so the two cannot drift: adding a member here widens `PlanStatusDto`,
 *  and there is no second place to forget. */
export const PLAN_STATUS_DTO_VALUES = [
  'generating',
  'planned',
  'stale',
  'approved',
  'declined',
] as const;

/** Wire form of the Prisma `PlanStatus` enum. */
export type PlanStatusDto = (typeof PLAN_STATUS_DTO_VALUES)[number];

/**
 * WHY a `declined` plan ended (MOTIR-3189) — the three histories that one status
 * covers, recorded rather than left to be inferred from which of `plannedAt` /
 * `decidedById` happen to be null.
 *
 * `reviewed` — a person read a `planned` plan and rejected it.
 * `discarded` — a plan ended without proposals ever being written: a person
 * ended a `generating` plan that never finished, or (MOTIR-4124) a producer
 * CLOSED one it had written nothing into, which `markPlanned` records here
 * rather than putting an empty plan in a reviewer's queue.
 * `abandoned` — `abandonedPlanService` terminated one whose producer was gone.
 *
 * Deliberately NOT a fourth `PlanStatusDto` member: that vocabulary is public
 * (v1's `planStatusSchema`, the MCP tool descriptions, four display switches and
 * the zh-parity gate) and every consumer of a plan's status is asking *is it
 * decided?*, which `declined` already answers. See
 * `docs/decisions/agent-authored-plans.md` AMENDMENT 6.
 *
 * `null` is not a fourth reason — it is *not recorded*, which is what every row
 * written before the column existed reads, and what an `approved` plan reads
 * always. A consumer falls back to the status.
 */
export type PlanDecisionReasonDto = 'reviewed' | 'discarded' | 'abandoned';

/**
 * The same vocabulary as a runtime list, for the schemas that need to enumerate
 * it (`mcpPlanSchema`). The `AssertTotal` beside it is what stops the two
 * drifting: adding a member to the union above without adding it here is a
 * compile error, not a value an agent quietly never sees.
 */
export const PLAN_DECISION_REASONS = [
  'reviewed',
  'discarded',
  'abandoned',
] as const satisfies readonly PlanDecisionReasonDto[];
type AssertTotalDecisionReason = [
  Exclude<PlanDecisionReasonDto, (typeof PLAN_DECISION_REASONS)[number]>,
] extends [never]
  ? true
  : never;
const _planDecisionReasonTotal: AssertTotalDecisionReason = true;
void _planDecisionReasonTotal;

/** Wire form of the Prisma `PlanItemOp` enum. */
export type PlanItemOpDto = 'add' | 'modify' | 'remove';

/**
 * Wire form of the Prisma `PlanOrigin` enum (MOTIR-916) — WHY the plan was
 * started, as opposed to `sourceJobId`'s WHICH job produced it. `user` is every
 * request-path submit (someone clicked generate / augment / expand / re-plan);
 * `cadence` is the auto-plan watcher firing on a drained ready set. The review
 * surface reads it to LABEL an auto-proposed expansion — it changes nothing
 * about how the plan is reviewed, approved, or declined.
 */
export type PlanOriginDto = 'user' | 'cadence';

/**
 * Wire form of the Prisma `WorkItemPlanningSource` enum as it appears on a PLAN
 * (Story MOTIR-2982 · MOTIR-2986) — WHO authored the plan.
 *
 * An ALIAS of {@link WorkItemPlanningSourceDto}, never a re-listing of its
 * members. The enum is REUSED rather than duplicated
 * (`docs/decisions/agent-authored-plans.md` Q3): a plan's author and the authors
 * stamped on the work items it materializes must be drawn from ONE closed
 * vocabulary or the Plans surface and the work-item detail can disagree about the
 * same fact. The alias exists only so a reader of `PlanDto` sees which vocabulary
 * the field speaks — spelling the members out here would recreate exactly the
 * second list Q3 refused (it already has FOUR members, not the three
 * `work-item-provenance.md` Decision 2 lists).
 */
export type PlanAuthorSourceDto = WorkItemPlanningSourceDto;

/**
 * ONE proposed STEP of a card's to-do list (Story MOTIR-3810 · MOTIR-4616) —
 * the element type of {@link PlanItemProposedFields.todos}.
 *
 * A mirror of `AddTodoInput` (`lib/services/workItemTodosService.ts`) minus the
 * things a proposal cannot have: no `id`, because the row does not exist yet,
 * and no `position`, because a fractional index is minted from its NEIGHBOURS at
 * write time — a key computed at append would be a key computed against a list
 * that does not exist. **ARRAY ORDER IS LIST ORDER**
 * (`docs/decisions/agent-authored-plans.md` AMENDMENT 14 D1); materialize mints
 * the keys.
 *
 * And no `doneAt` / `doneById`: a proposal never ticks. A plan that arrived with
 * rows already checked would be asserting that work had been done, which is the
 * one thing a proposal cannot know.
 */
export interface ProposedTodoInput {
  /** WHAT to do — ONE operation, capped at `TODO_TEXT_MAX_LENGTH`. */
  text: string;
  /** The INSTRUCTIONS — optional Markdown, the *how* of this one operation. */
  notesMd?: string | null;
  /** The command to copy, if this step has one. */
  commandText?: string | null;
  /**
   * Who this step is for. Omitted / `null` ⇒ SEEDED at materialize from the
   * proposal's own `executor`, and from `human` when it carries none
   * (AMENDMENT 14 D5, restating the store's §2 seed rule for the proposal path,
   * where the card whose executor `addTodo` reads does not exist yet).
   */
  executor?: ExecutorDto | null;
}

/**
 * The language each of a proposal's text fields was WRITTEN in (Story MOTIR-7734 ·
 * MOTIR-8743) — the planner's statement, FIXED AT GENERATION and never re-read
 * from the organisation's setting: approve records `title` on the title,
 * `description` on the description, `explanation` on the explanation and `todos`
 * on each step's text and notes, and falls back to the setting only for a field
 * with no key. Every key is optional; a key means "this field's current text was
 * written in this language". Validated at every door
 * (`lib/plans/validateProposedLanguages.ts`).
 */
export interface ProposalLanguages {
  title?: Locale;
  description?: Locale;
  explanation?: Locale;
  todos?: Locale;
}

/**
 * The proposed fields of an `add` PlanItem — the new node's values, which live
 * HERE until materialize (no WorkItem exists yet). `kind` defaults to `task`
 * (a standalone leaf) when omitted; `parentRef` (on the PlanItem) decides the
 * tree placement. All optional except a title.
 */
export interface PlanItemProposedFields {
  title: string;
  kind?: string;
  descriptionMd?: string | null;
  type?: string | null;
  priority?: string | null;
  executor?: string | null;
  /**
   * Leaf sizing (MOTIR-1433) — the agile point estimate + the time estimate the
   * **estimation gate** requires on EVERY leaf (subtask / childless bug/task).
   * They live HERE until materialize maps them onto the created WorkItem. Both
   * optional/nullable (a non-leaf `add` carries neither); validated at
   * `addProposals` / `updateProposal` the SAME way the create path validates
   * them (Fibonacci-range points, non-negative integer minutes).
   */
  storyPoints?: number | null;
  estimateMinutes?: number | null;
  /**
   * A leaf's DIFFICULTY (Story MOTIR-6095 · MOTIR-6133; `agent-authored-plans.md`
   * AMENDMENT 19) — how hard the work is to reason about, the column MOTIR-6016
   * shipped. It rides the `storyPoints` route on every op and every door (this
   * bag, the `modify` patch, the deepen and the correction), NOT `subject`'s
   * narrower add-only route: `subject` is pass provenance settled at the lay,
   * while difficulty is a property of the WORK, which a re-plan must be able to
   * change. A non-null value on a container kind is refused at append, deepen,
   * correct and approve (`lib/plans/validateProposedDifficulty.ts`). Absent →
   * materialize writes `null`.
   */
  difficulty?: WorkItemDifficultyDto | null;
  /**
   * AI-drafted explanation (Story 7.4 · MOTIR-850) — the "why this matters" prose
   * the `generate_tree` planner drafts when the project opts in
   * (`Project.aiGenerateExplanations`). Carried HERE through the proposal until
   * materialize maps it onto the created WorkItem's `explanationMd` /
   * `explanationSource`. `explanationSource` is normally `'ai_draft'` (the
   * generator's default); materialize also defaults it to `ai_draft` when an
   * `explanationMd` is present but no source is set. Both optional — a proposal
   * with explanations OFF carries neither. Item-link convention (Story 5.8): a
   * reference to another item in `explanationMd` is a link token —
   * `[label](motir:<workItemId>)` for an existing item, or
   * `[label](motir-ref:planItem:<planItemId>)` for another `add` in this plan,
   * rewritten to `motir:<id>` at materialize. The `planItem:` prefix is part of
   * the token: `motir-ref:<id>` without it is refused at every proposal door
   * (`lib/plans/validateProposedBodyRefs.ts`, bug MOTIR-6494).
   */
  explanationMd?: string | null;
  explanationSource?: string | null;
  /** The language each text field was written in (MOTIR-8743) — fixed at
   *  generation, never re-read from the setting. Stored here, inside the one
   *  place a proposal's fields live, so it survives edits to the row. */
  languages?: ProposalLanguages;
  /**
   * Native PLANNING provenance (Story MOTIR-1685) — motir-ai attaches how it
   * planned this item so `materialize` can stamp it (docs/decisions/work-item-provenance.md,
   * Decision 5). `source`/`harness` are constants for the native seam
   * (`native`/`Motir`); `model` is resolved from the run's `PlanningRun.model`.
   * OPTIONAL by contract: an older/absent producer just omits it and materialize
   * still stamps a valid native triple (`native · Motir · null`), so the
   * motir-ai producer (MOTIR-1690) and this consumer merge in any order.
   */
  planningProvenance?: {
    source?: string;
    harness?: string | null;
    model?: string | null;
  } | null;
  /**
   * WHICH REPO this item ships in (Story MOTIR-1775 · MOTIR-1884) — the producer
   * half of the multi-repo dispatch contract. A project now carries a repository
   * SET sized by its architecture (MOTIR-1780), and `resolveDispatchRepo` only
   * falls back to "the single repo" when there is exactly one: with two or more,
   * an item that carries no pin resolves to `null` and no agent is told where to
   * build. So the PLANNER pins each proposed item (the paired motir-ai card
   * MOTIR-1885), and the pin travels here until materialize maps it onto the
   * created WorkItem's `targetRepo`.
   *
   * Either the bare repo NAME (`motir-core`) or the `owner/name` ref form —
   * normalized to the bare name at materialize, exactly as the direct-write path
   * normalizes an authored pin. VALIDATED at approve against the PROJECT's set
   * (not the workspace's connected repos), including rows that are still
   * `proposed`: naming a repository the plan has decided on but not yet created
   * is ordinary, while a typo or a sibling project's repo is rejected.
   *
   * OPTIONAL by contract — a proposal that carries no pin materializes exactly as
   * it did before this field existed, so the single-repo projects the shipped
   * fallback already serves are unaffected and the two repos' halves may merge in
   * either order.
   */
  targetRepo?: string | null;
  /**
   * EVERY repository this item ships in, ORDERED (bug MOTIR-4904) — the
   * PROPOSAL-path twin of `create_work_item`'s `targetRepos`, and the field whose
   * absence meant a repository SET could not be PROPOSED at all.
   *
   * ⚠️ IT IS AN OMISSION BEING CLOSED, NOT A BOUNDARY BEING WIDENED. A work
   * item's repositories became a SET on the direct write path (Story MOTIR-2725 ·
   * MOTIR-2727) and the proposal path was never in that story's scope; MOTIR-3540
   * later gave the correction door the SINGULAR `targetRepo` because the singular
   * was what it was asked for. Nothing anywhere recorded a decision that a
   * proposal may not carry a set — and a planning pass may not use the direct door
   * at all (`_shared.md`'s *A PLANNING PASS PROPOSES*), so for a planner the set
   * was not merely awkward to express but INEXPRESSIBLE. The remedy on the record
   * was *approve it, then patch it*: a field the approver never saw, written into
   * a card they already approved, with a window in between where dispatch routes
   * on the WRONG pin.
   *
   * Element 0 is the PRIMARY — the repository dispatch routes to — and the item
   * does not complete until every element has a merged pull request of its own.
   * Bare names or the `owner/name` ref form, validated at approve against the
   * PROJECT's repository domain by the SAME resolver the direct path calls
   * (`resolveAuthoredRepoPinsInProject`), so the two doors cannot disagree about
   * what a pin means or which repositories exist.
   *
   * MUTUALLY EXCLUSIVE with {@link targetRepo} and {@link targetRepositories} —
   * they are one field in three forms, and supplying two is rejected at the
   * append rather than silently resolved (`assertSingleTargetRepoInput`, the
   * direct door's own guard, shared). `[]` is the empty set.
   */
  targetRepos?: string[];
  /**
   * The same axis as {@link targetRepos}, given as `project_repository` ROW IDS
   * (bug MOTIR-4904) — the reference-native form, ADR "Amendment 2026-08-18" §A4.
   *
   * Prefer it over names when the ids are in hand: a reference survives the
   * repository being renamed, and it can name one of two rows that share a role,
   * which a name cannot. Validated by `resolveAuthoredRepoRefsInProject`, the
   * direct path's own resolver; an id outside this project rejects the whole set.
   *
   * MUTUALLY EXCLUSIVE with both fields above.
   */
  targetRepositories?: string[];
  /**
   * WHICH ROLE of the project's repository set this item ships in (Story
   * MOTIR-1775 · MOTIR-1912) — the PORTABLE pin, and the one a fresh onboarding
   * generation can actually emit.
   *
   * ADR §5.2 calls this the load-bearing detail: at generation the repositories
   * **do not exist** (the set is DERIVED from the tree, and the user may rename
   * any row before it is created), so a NAME pinned then is stale the moment a row
   * is edited and meaningless before the row exists at all. A role is stable
   * across both.
   *
   * VALIDATED against the ROLE VOCABULARY (`PROJECT_REPO_ROLES` — `web` / `api` /
   * `mobile` / `shared` / `infra` / `other`), not against the project's set: a
   * closed enum needs no repository to exist, which is exactly what makes it
   * emittable this early. An unrecognised value is rejected at the append /
   * approve boundary (`PlanItemUnknownTargetRepoRoleError`); an explicit `null` is
   * "unpinned", not an error.
   *
   * NOT redundant with {@link targetRepo} — ADR §5.4: *"Role is the portable pin;
   * name is the settled one. Materialize accepts either."* A fresh generation
   * emits a role; a re-plan / augment / `expand_item` on a project whose repos
   * already exist may emit the name. When a proposal carries BOTH, the **name
   * wins** for `work_item.targetRepo` (it is the settled answer, and it already
   * survives the shipped set validation) and the role is still recorded, so the
   * two pins never disagree about the outcome.
   *
   * ⚠️ Materialize RESOLVES it to a repository REFERENCE (`proposalRepoRef` →
   * a `work_item_repo` row); it does NOT record the role on the item. ~~Materialize
   * only RECORDS it (onto `work_item.targetRepoRole`); resolving a role to a repo
   * name happens later, when that role's row becomes established (MOTIR-1913).~~
   * That column, and MOTIR-1913's resolution pass, are RETIRED (Story MOTIR-2732 ·
   * MOTIR-3040, ADR `work-item-repository-set.md` "Amendment 2026-08-18" §A3): a
   * row reference is stable before the repository exists AND across its rename, so
   * the role's reason to exist was discharged. The field REMAINS here — a plan
   * still pins by role before any row exists — but the work item has nowhere to
   * hold one, which is why the review diff for this key has no old side to read
   * (`planReviewService.buildChanges`, MOTIR-3868).
   */
  targetRepoRole?: ProjectRepoRoleDto | null;
  /**
   * WHICH `project_repository` ROW this item ships in, by id (Story MOTIR-2732 ·
   * MOTIR-3045) — the reference-native SINGULAR pin, and the one spelling that
   * lifts the repeated-role ceiling: a role resolves to NOTHING on a project where
   * two rows share it (by design — the label that distinguishes them is documented
   * as never a resolution key), and a NAME is meaningless before the row exists,
   * so on precisely the projects the row pin was built for the row pin is the ONLY
   * expressible one.
   *
   * It IS already the `project_repository` id, so {@link proposalRepoRef} needs no
   * lookup for it — only validation that the row belongs to this project. It sits
   * AHEAD of {@link targetRepoRole} in that ladder (a row reference is more
   * specific than a role), beside {@link targetRepo} (a name is the settled pin,
   * this is the stable one) and the set forms, and MUTUALLY EXCLUSIVE with all of
   * them at the append (`assertSingleTargetRepoInput`): one axis, five spellings,
   * never two on one proposal.
   *
   * ⚠️ motir-ai has EMITTED this field since MOTIR-3045 and motir-core READ NOTHING
   * off it until MOTIR-4924 — the pin was persisted onto the plan-item row and
   * dropped at approve, so a leaf pinned only by row ref materialized unrouted and
   * indistinguishable from a leaf the planner could not classify. The drift guard
   * in `tests/integration/plans/proposedRepoAxisDriftGuard.test.ts` holds this side
   * total against the keys the producer emits, so the next spelling to cross the
   * boundary unequally fails in the PR that creates it.
   */
  targetRepositoryRef?: string | null;
  /**
   * The card's ORDERED STEPS (Story MOTIR-3810 · MOTIR-4616) — a `manual` card's
   * to-do list, proposed with the card so the reviewer reads what approve will
   * write (`docs/decisions/agent-authored-plans.md` AMENDMENT 14 D1).
   *
   * Since MOTIR-8668 (AMENDMENT 27, which overturns AMENDMENT 14 D2) a `modify`
   * may carry it too — {@link PlanItemPatch.todos} REPLACES a committed card's
   * list at approve. D2 kept the list off the patch because ticked rows carry a
   * person's progress; AMENDMENT 27 keeps that cost VISIBLE instead of
   * forbidding it: the review's change row and `get_plan` both say how many
   * steps the replacement drops and how many of them were ticked.
   *
   * Validated at BOTH write boundaries against the STORE's own caps —
   * `lib/plans/validateProposedTodos.ts`, importing the three constants from
   * `lib/workItemTodos/limits.ts` and never a literal, so the proposal path can
   * never be looser than the list it feeds. Refused on a CONTAINER kind: a
   * story's steps are its children.
   *
   * OPTIONAL, and nothing here makes it mandatory on anything (AMENDMENT 14 D4).
   * That a `manual` card HAS one is a planning RULE, and it lives in the two rule
   * homes — `motir-meta`'s `type-manual.md` pack and `A_MANUAL_CARD_BAR` in
   * motir-ai's `SHARED_PLANNING_RULES` — not in this field's validator.
   */
  todos?: ProposedTodoInput[] | null;
  /**
   * WHICH SUBJECT MATTER the planner composed this card's rule packs from
   * (Story MOTIR-5062 · MOTIR-5065) — the FOURTH coordinate of
   * `pack(phase, kind, type, subject)`, DERIVED BY THE PLANNER AT `lay` and read
   * by an `author` session, so it is settled at the APPEND exactly as `type`,
   * `parentRef` and the repo pin are.
   *
   * ⚠️ TOP-LEVEL, NOT A MEMBER OF {@link planningProvenance}, and the parity
   * guard is the reason. `tests/dto/planReviewFieldParity.test.ts` reads this
   * interface's TOP-LEVEL keys and holds `PlanReviewItemDto` against them, so a
   * field tucked inside the provenance object is invisible to it. That file
   * records `planningProvenance` itself reaching the proposal and not the review
   * model with nothing going red — so nesting is not a hypothetical way to lose
   * this field, it is the documented one.
   *
   * ⚠️ SHAPE IS VALIDATED, MEMBERSHIP IS NOT (`lib/plans/subjectShape.ts`). A
   * member exists iff `prompts/plan-rules/subject-<name>.md` exists in the
   * corpus, so this repository never carries the list: a well-formed but
   * unrecognised value is ACCEPTED here and refused one hop later, at motir-ai's
   * `resolvePlanningRulePacks`. Deliberate — a closed enum here would put a
   * migration and a platform deploy in front of every new rule pack, and the
   * value's only producer is the system that owns the vocabulary.
   *
   * LEGAL ON EVERY KIND (MOTIR-5607). It was refused on a container, mirroring
   * `type`; that refusal is retired — a subject says what a work item is ABOUT,
   * and a container is about something exactly as much as a leaf is.
   *
   * OPTIONAL in BOTH directions — a proposal carrying none materializes exactly
   * as it did before this field existed, which is what makes the axis purely
   * additive.
   */
  subject?: string | null;
}

/**
 * The kinds a `modify` may RE-KIND its target to (bug MOTIR-8192 · AMENDMENT 25)
 * — exactly the set `change_kind` offers, and for its reason: an `epic` is
 * structural plan scaffolding the planner lays with an `add`, never a card an
 * existing work item is turned into.
 */
export const MODIFY_KIND_TARGETS = ['story', 'task', 'bug', 'subtask'] as const;

export type ModifyKindTarget = (typeof MODIFY_KIND_TARGETS)[number];

/**
 * The sparse patch of a `modify` PlanItem — only the CHANGED fields (the OLD
 * side of each diff is read live from the target at materialize). The edge
 * changes carry refs (a real work-item id or an intra-plan temp-ref).
 */
export interface PlanItemPatch {
  /** The language of each text field THIS patch sets (MOTIR-8743) — fixed at
   *  generation, never re-read from the setting. An ANNOTATION on the patch, not
   *  a change to the card: it is outside {@link PLAN_ITEM_PATCH_KEYS} and rides
   *  only beside the field it describes. */
  languages?: ProposalLanguages;
  title?: string;
  descriptionMd?: string | null;
  /**
   * REWRITE the target's WHY (MOTIR-3111) — the `modify` mirror of the `add`
   * path's {@link PlanItemProposedFields.explanationMd}, and the second half of
   * the two-body pair `descriptionMd` opens.
   *
   * Sparse like every key here: absent (`undefined`) leaves the existing
   * explanation untouched, an explicit `null` CLEARS it. Normalized through
   * `normalizeBodyRefs` in the SAME resolve as the patched description
   * (`applyModify`), so a bare `MOTIR-<n>` in a patched explanation chips
   * exactly as it does in a patched description and as it already does on the
   * `add` path.
   *
   * ⚠️ There is deliberately NO `explanationSource` twin. That column is not the
   * caller's to set — it defaults to `user_authored` and the service path
   * auto-transitions an `ai_draft` to `user_edited` — so a patch that could write
   * it would let a plan forge provenance. `applyModify` leaves it alone whatever
   * its prior value.
   *
   * Why it exists: THE REPLAN ACTION requires the surviving card's rationale to be
   * rewritten (*"a survivor keeps its OLD `explanationMd` unless you rewrite it,
   * and a stale WHY is worse than a null one"*), and since MOTIR-3047 a run's
   * re-plan writes through the PROPOSAL door. Without this key the runbook
   * mandates a patch the proposal API cannot express.
   */
  explanationMd?: string | null;
  priority?: string | null;
  type?: string | null;
  /**
   * RE-KIND the target (bug MOTIR-8192; `agent-authored-plans.md` AMENDMENT 25) —
   * the plan door's `change_kind`, so a re-plan that finds a committed `task` is
   * really a `story` can say so on the plan a person approves.
   *
   * One of `story` · `task` · `bug` · `subtask`, never `epic` — the set
   * `change_kind` offers, refused by name at the append and the correction. The
   * new kind is judged against the PROJECTED tree, at the append and again at
   * approve: its parent must admit it, it must admit every child it keeps, and
   * a container kind may not keep a `type` or a `difficulty` — the patch clears
   * them (`type: null`, `difficulty: null`) or the proposal is refused by name
   * (`type_on_container` / `difficulty_on_container`). The EXECUTOR has no patch
   * key (AMENDMENT 4 D3a); a re-kind to a container DERIVES it to `null` at
   * approve, and the review shows that change row. Applied by `applyModify` with
   * a `kind` revision diff cell, the one `workItemsService` records.
   */
  kind?: ModifyKindTarget;
  /**
   * Leaf sizing re-scope (MOTIR-1532) — the agile point + time estimate a
   * `modify` may change on the target, mirroring the `add` path's
   * `PlanItemProposedFields` sizing. Validated at the proposal boundary the SAME
   * way (`validateStoryPoints` / `validateEstimateMinutes`); applied by
   * `applyModify` with a `work_item_revision` diff cell. Both optional (a modify
   * that doesn't touch sizing carries neither); an explicit `null` CLEARS the
   * estimate. The `modify_node` generation tool offers both, so without them a
   * proposed re-scope would never apply on approve.
   */
  storyPoints?: number | null;
  estimateMinutes?: number | null;
  /**
   * Re-judge the target's DIFFICULTY (Story MOTIR-6095 · MOTIR-6133) — the
   * `modify` mirror of {@link PlanItemProposedFields.difficulty}, on the same
   * `storyPoints` route. Sparse: absent leaves it alone, an explicit `null`
   * CLEARS it. A non-null value is refused when the TARGET is a container (at
   * the append, the correction, and at approve as `difficulty_on_container`).
   * Applied by `applyModify` with a `difficulty` revision diff cell.
   */
  difficulty?: WorkItemDifficultyDto | null;
  /**
   * REPLACE the target's ORDERED STEPS (MOTIR-8668; `agent-authored-plans.md`
   * AMENDMENT 27, overturning AMENDMENT 14 D2) — the `modify` mirror of
   * {@link PlanItemProposedFields.todos}, so a re-plan of a `manual` card can
   * give it the steps the card is missing on the plan a person approves.
   *
   * A REPLACEMENT, never a merge: at approve the target's list becomes exactly
   * this array, in order, with no row ticked, and every prior row is deleted.
   * Sparse at the KEY: absent leaves the list untouched; an explicit `[]` or
   * `null` CLEARS it. Validated against the store's caps through
   * `validateProposedTodos`, and refused when the TARGET is (or is re-kinded
   * to) a container — at the append, the correction, and at approve as
   * `todos_on_container`. NOT a mark key: a `modify` of a `done` / `cancelled`
   * card that carries it is refused `PLAN_TARGET_IMMUTABLE`.
   *
   * The progress it discards is shown, not hidden: the review's `todos` change
   * row reads the live count, and `get_plan` prints how many steps the
   * replacement drops and how many of them were ticked.
   */
  todos?: ProposedTodoInput[] | null;
  /**
   * RE-PIN the target's repo (MOTIR-1884) — the `modify` mirror of the `add`
   * path's {@link PlanItemProposedFields.targetRepo}, so a re-plan that moves work
   * from one repo of the set to another can say so instead of leaving the item
   * pointed at the repo it was first planned into.
   *
   * Absent (`undefined`) leaves the pin untouched; an explicit `null` (or a blank
   * string, which normalizes to `null`) UNPINS the item. Validated at approve the
   * same way the `add` path's pin is — same project-scoped domain, same
   * normalization — so the two paths cannot disagree about what a pin means.
   */
  targetRepo?: string | null;
  /**
   * RE-PIN the target's whole repository SET (bug MOTIR-4904) — the `modify`
   * mirror of the `add` path's {@link PlanItemProposedFields.targetRepos}, so a
   * re-plan that discovers a card ships in two repositories can say so on the
   * plan a person approves rather than in an `update_work_item` afterwards.
   *
   * Sparse at the KEY, like every key here: absent leaves the axis untouched, and
   * an explicit `[]` UNPINS the card entirely. There is no `null` form — the empty
   * set IS the cleared set, which is the same contract the direct door states.
   *
   * MUTUALLY EXCLUSIVE with {@link targetRepo} and {@link targetRepositories} on
   * the SAME patch; the append refuses a patch describing the axis twice.
   */
  targetRepos?: string[];
  /**
   * The same axis as {@link targetRepos}, as `project_repository` ROW IDS (bug
   * MOTIR-4904) — the reference-native form, and mutually exclusive with both
   * fields above.
   */
  targetRepositories?: string[];
  /**
   * RE-PIN the target's repo ROLE (MOTIR-1912) — the `modify` mirror of the `add`
   * path's {@link PlanItemProposedFields.targetRepoRole}, so a re-plan that moves
   * work from one role of the set to another (the API half becoming a shared
   * package, say) can say so.
   *
   * Same sparse semantics as every other patch key, and deliberately identical to
   * the shipped `targetRepo` patch: absent (`undefined`) leaves the pin untouched;
   * an explicit `null` UNPINS. Validated against the role vocabulary the same way
   * the `add` path's is, so the two paths cannot disagree about what a role means.
   */
  targetRepoRole?: ProjectRepoRoleDto | null;
  /**
   * RE-PIN the target's repo ROW (Story MOTIR-2732 · MOTIR-3045, surfaced by
   * MOTIR-4924) — the `modify` mirror of the `add` path's
   * {@link PlanItemProposedFields.targetRepositoryRef}, so a re-plan that moves work
   * to a specific `project_repository` row (the case the role pin cannot serve on a
   * two-rows-share-a-role project) can say so on the plan a person approves.
   *
   * Same sparse semantics as {@link targetRepoRole}: absent (`undefined`) leaves the
   * pin untouched; an explicit `null` UNPINS. Validated at approve — the row must
   * belong to this project — the same way the `add` path's ref is, so the two paths
   * cannot disagree about which row a ref names.
   */
  targetRepositoryRef?: string | null;
  /**
   * RE-PARENT the target (MOTIR-3859) — the `modify` mirror of the `add` path's
   * {@link PlanItemDto.parentRef}, and the half of D3's `SITS or SHIPS` pair the
   * patch never had.
   *
   * ⚠️ THE PAIR CAME APART BY ACCIDENT, not by decision. `agent-authored-plans.md`
   * D3 draws the deepen line as *"a deepen may change what a card SAYS and who
   * ACTS on it; it may not change where the card SITS or SHIPS"* — and SHIPS was
   * then given to the patch twice (`targetRepo`, MOTIR-1884; `targetRepoRole`,
   * MOTIR-1912) while SITS was given to it never. Nothing anywhere argued it
   * should not be; the two halves were widened by different cards and only one of
   * them ran. AMENDMENT 11 records the completion.
   *
   * Sparse like every key here: absent (`undefined`) leaves the parent untouched,
   * an explicit `null` moves the target to the PROJECT ROOT (refused by the same
   * `assertValidParent(null, kind)` arm that refuses a root-level subtask).
   *
   * A real work-item id, a `folder:` placement, or — since AMENDMENT 18 §1
   * (MOTIR-6050) — a `planItem:` temp-ref naming an `add` already persisted on
   * the same plan, which moves a committed card under a card the plan creates.
   * AMENDMENT 11 D2 had refused the temp-ref because every guard was a question
   * about a LIVE row; the plan's own `add`s now answer them, read off the
   * projected chain (`validateProposals.ts` `assertReparentUnderProposalLegal`),
   * and `materialize` already creates every `add` before it applies any `modify`.

   * Validated at the APPEND (`plansService.addProposals`) and again at approve
   * (`validatePlanProposals`), through ONE pure function so the two cannot
   * disagree; applied by `applyModify` with a `parentId` revision diff cell, the
   * ancestor repo-set recompute on BOTH chains, and the `work-item/child-set.changed`
   * event `moveWorkItem` emits for the same reason.
   */
  parentRef?: string | null;
  blockedByAdd?: string[];
  blockedByRemove?: string[];
  /**
   * MARK the target as no longer true of the code (Story MOTIR-6577 · MOTIR-6629)
   * — the plan-path twin of the direct door's `obsolescence` (MOTIR-6574):
   * `outdated` (the text no longer describes what shipped) or `deprecated`
   * (retired or overturned on purpose). Sparse: absent leaves the mark alone, an
   * explicit `null` CLEARS it. Membership is checked at the append and at a
   * correction (`validateProposedObsolescence`), refused as `INVALID_PROPOSAL`.
   * Applied by `applyModify` with the same `obsolescence` revision diff cell
   * `workItemsService` writes.
   *
   * Kind- and status-agnostic, like the column: it is one of the
   * {@link PLAN_ITEM_MARK_PATCH_KEYS}, so a `modify` carrying ONLY mark keys is
   * legal on a `done` / `cancelled` target — marking finished work is what the
   * mark is for.
   */
  obsolescence?: WorkItemObsolescenceDto | null;
  /**
   * WHY the target is marked (Story MOTIR-6577 · MOTIR-6629) — the Markdown note
   * beside {@link obsolescence}, independent of it exactly as on the direct door
   * (clearing the mark keeps the note). Sparse: absent leaves it, `null` clears.
   * A mark key: legal on a terminal target in a mark-only `modify`.
   */
  obsolescenceNoteMd?: string | null;
  /**
   * `supersedes` EDGES with the target as the NEWER card (Story MOTIR-6577 ·
   * MOTIR-6630): each ref names an OLDER card the target replaces — a real
   * work-item id or a `planItem:` temp-ref naming an `add` persisted by an
   * EARLIER call. Approve writes one `supersedes` link per ref (from = the target,
   * to = the ref; an existing row is a no-op) and records it in the revision's
   * `links` cell. Checked like `blockedByAdd` (duplicate, self, folder, dangling)
   * plus a projected supersedes-CYCLE walk, and with NO level rule — `supersedes`
   * orders nothing and readiness never reads it. Unioned on merge, and cancelled
   * by the same ref in {@link supersedesRemove}.
   *
   * A mark key ({@link PLAN_ITEM_MARK_PATCH_KEYS}): legal on a terminal target.
   */
  supersedesAdd?: string[];
  /** The one `supersedes` row from the target to each ref, DELETED at approve; a
   *  row that does not exist is a no-op. A mark key. */
  supersedesRemove?: string[];
  /**
   * `supersedes` EDGES with the target as the OLDER card (MOTIR-6630): each ref
   * names a NEWER card that replaces the target. The SAME storage row as the
   * newer card's {@link supersedesAdd} spelled from the other end (from = the ref,
   * to = the target), so both spellings in one plan land as ONE row. A mark key —
   * marking a `done` card superseded by a proposed one is a legal mark-only
   * `modify`.
   */
  supersededByAdd?: string[];
  /** The one `supersedes` row from each ref to the target, DELETED at approve; a
   *  row that does not exist is a no-op. A mark key. */
  supersededByRemove?: string[];
}

/**
 * Every key a {@link PlanItemPatch} may carry — THE SINGLE DECLARED SOURCE, in
 * the interface's own declaration order (MOTIR-3868).
 *
 * ⚠️ It exists because a key added to the patch reaches SOME of its consumers
 * and not others, and nothing anywhere compares the two lists. Three times now:
 * `storyPoints` / `estimateMinutes` reached `buildChanges` and not the label
 * catalogs (MOTIR-3151); `explanationMd` / `targetRepo` / `targetRepoRole`
 * reached this patch and not motir-ai's mirror (MOTIR-3860); and `targetRepo` /
 * `targetRepoRole` reached `applyModify` and not the plan-REVIEW diff at all —
 * so the one field a re-pin changes was invisible on the surface that approves
 * it. Each was found by accident, months later.
 *
 * A runtime test cannot enumerate an interface's keys, so this array is what a
 * test can hold a consumer against — and the assertion below is what holds the
 * ARRAY to the interface, in both directions, at `tsc` time. Together they mean
 * the NEXT key added to `PlanItemPatch` fails in the pull request that adds it:
 * the compiler here, then `tests/dto/planReviewFieldParity.test.ts`, which
 * demands an explicit disposition for it against the review vocabulary.
 *
 * `motir-ai`'s `MODIFY_PATCH_KEYS` (`src/llm/treeGeneration.ts`) is the same
 * instrument for the same patch, one boundary over, and is what this mirrors.
 */
export const PLAN_ITEM_PATCH_KEYS = [
  'title',
  'descriptionMd',
  'explanationMd',
  'priority',
  'type',
  'kind',
  'storyPoints',
  'estimateMinutes',
  'difficulty',
  'todos',
  'targetRepo',
  'targetRepos',
  'targetRepositories',
  'targetRepoRole',
  'targetRepositoryRef',
  'parentRef',
  'blockedByAdd',
  'blockedByRemove',
  'obsolescence',
  'obsolescenceNoteMd',
  'supersedesAdd',
  'supersedesRemove',
  'supersededByAdd',
  'supersededByRemove',
] as const;

export type PlanItemPatchKey = (typeof PLAN_ITEM_PATCH_KEYS)[number];

/**
 * The patch keys a `modify` may carry onto a TERMINAL (`done` / `cancelled`)
 * target — THE SINGLE PLACE that names which keys are safe on finished work
 * (Story MOTIR-6577 · MOTIR-6629; `agent-authored-plans.md` step 4's carve-out).
 *
 * `validatePlanProposals` refuses every `modify` of a terminal target with
 * `PLAN_TARGET_IMMUTABLE` UNLESS every key its patch carries is listed here —
 * keyed on the PATCH'S KEYS, never on a flag the caller sets, so the refusal
 * cannot be talked around — and `applyModify` then leaves that target's status,
 * `sessionBranch` and rollup alone. A key belongs here only when writing it
 * changes a card's STANDING and never the work it describes, so a plan still
 * cannot re-open finished work by the back door. The gate and the write read it
 * through ONE predicate, `isMarkOnlyPatch` (`lib/plans/markOnlyPatch.ts`).
 *
 * Extend it by appending a member; every member must also be a
 * {@link PLAN_ITEM_PATCH_KEYS} member, which the `satisfies` below holds at
 * compile time. The four `supersedes` edge carriers (MOTIR-6630) are members: an
 * edge saying which card replaced this one is standing, not work, and it is what
 * a mark on a finished card most often needs beside it.
 */
export const PLAN_ITEM_MARK_PATCH_KEYS = [
  'obsolescence',
  'obsolescenceNoteMd',
  'supersedesAdd',
  'supersedesRemove',
  'supersededByAdd',
  'supersededByRemove',
] as const satisfies readonly PlanItemPatchKey[];

export type PlanItemMarkPatchKey = (typeof PLAN_ITEM_MARK_PATCH_KEYS)[number];

/** A `remove` proposal's reason, after trimming, is 1–this many characters
 *  (`agent-authored-plans.md` AMENDMENT 18 §3, MOTIR-6052). */
export const PLAN_ITEM_REASON_MAX = 2000;

/**
 * The COMPILE-TIME half of the drift guard: {@link PlanItemPatch}'s keys and
 * {@link PLAN_ITEM_PATCH_KEYS} are the same set, in both directions.
 *
 * Adding a field to the interface without adding it to the constant (or the
 * reverse) fails `pnpm build` before any test runs.
 */
// `languages` (MOTIR-8743) is the one member outside the constant, by design: it
// annotates the text keys beside it and changes nothing on the card by itself.
type PatchKeyMissingFromConstant = Exclude<keyof PlanItemPatch, PlanItemPatchKey | 'languages'>;
type PatchKeyMissingFromInterface = Exclude<PlanItemPatchKey, keyof PlanItemPatch>;
const _planItemPatchKeysAreExhaustive: [
  PatchKeyMissingFromConstant,
  PatchKeyMissingFromInterface,
] extends [never, never]
  ? true
  : never = true;
void _planItemPatchKeysAreExhaustive;

/** One proposed operation in a plan, as the API returns it. */
export interface PlanItemDto {
  id: string;
  op: PlanItemOpDto;
  /** `null` for an un-materialized `add`; the target/created id otherwise. */
  workItemId: string | null;
  proposedFields: PlanItemProposedFields | null;
  patch: PlanItemPatch | null;
  parentRef: string | null;
  blockedByRefs: string[];
  /** `add` only: the older cards the created card supersedes (MOTIR-6630);
   *  `[]` on every other op and on a plan item written before the column. */
  supersedesRefs: string[];
  baseRevision: string | null;
  /** `remove` only: why the card is removed (AMENDMENT 18 §3); null otherwise. */
  reason: string | null;
  createdAt: string;
}

/** The kind of step a running planner session is on (Story MOTIR-7820 · MOTIR-7822). */
export type PlanStepKindDto = 'settle' | 'lay' | 'author';

/**
 * The step ONE running planner session is on (Story MOTIR-7820 · MOTIR-7822).
 * `targetRef` is the ref exactly as the planner sent it — `planItem:<id>` or a
 * work-item id — and NULL for `settle`, and for the two UNTARGETED forms: a
 * `lay` of the project's top level, and an `author` of an item not yet on the
 * plan. Turning it into words is the progress derivation's job, not this shape's.
 */
export interface PlanStepDto {
  sessionKey: string;
  kind: PlanStepKindDto;
  targetRef: string | null;
  startedAt: string;
}

/**
 * One sentence a planner session wrote about its own work (Story MOTIR-8060 ·
 * MOTIR-8062) — the planner's NARRATION, kept as history. `seq` is the plan's
 * own order, gapless from 1; `sessionKey` names the session that wrote it.
 */
export interface PlanNarrationDto {
  id: string;
  sessionKey: string;
  seq: number;
  body: string;
  createdAt: string;
}

/**
 * One planner session's STEP WORDS on a plan (MOTIR-8062): the step it last
 * reported and the target's title as it read then — kept after the session ends,
 * so the chat panel can head that session's group with its real step. Both
 * `targetRef` and `targetTitle` are null on `settle`; `targetTitle` is also null
 * when the target could not be resolved.
 */
export interface PlanNarrationSessionDto {
  sessionKey: string;
  stepKind: PlanStepKindDto;
  targetRef: string | null;
  targetTitle: string | null;
  firstReportedAt: string;
  updatedAt: string;
}

/**
 * A window of a plan's narration sentences (MOTIR-8063): `entries` in ascending
 * `seq`, and how many sentences come BEFORE the first of them. `seq` is gapless
 * from 1, so `earlierCount` is the first entry's `seq − 1`, or `0` when
 * `entries` is empty.
 */
export interface PlanNarrationPageDto {
  entries: PlanNarrationDto[];
  earlierCount: number;
}

/**
 * The narration block the plan REVIEW read carries (MOTIR-8063): the newest
 * window of sentences plus EVERY session's step words. Sessions are never
 * windowed, so a sentence paged back to always has its group head here.
 */
export interface PlanNarrationReadDto extends PlanNarrationPageDto {
  /** Every session that reported a step, by `firstReportedAt` then id — running,
   *  finished, or with no sentence at all. */
  sessions: PlanNarrationSessionDto[];
}

/**
 * A plan as the API returns it (list row). The lifecycle timestamps + decider
 * ARE the history surface (when planned / when decided / by whom). `itemCount`
 * is the number of bundled PlanItems.
 */
export interface PlanDto {
  id: string;
  projectId: string;
  status: PlanStatusDto;
  title: string | null;
  summary: string | null;
  sourceJobId: string | null;
  /** The planning SESSION this plan belongs to (AMENDMENT 17 §5) — set at
   *  creation on every author path and never re-pointed. Null only on a row a
   *  pre-session build wrote during a rollout. */
  sessionId: string | null;
  /** WHY the plan was started — `user` (someone clicked) or `cadence` (the
   *  auto-plan watcher fired it). Set at submit; never changes. */
  origin: PlanOriginDto;
  /**
   * WHO ASKED for the plan (Story MOTIR-2982 · MOTIR-2986) — a THIRD party
   * beside {@link PlanDto.decidedById} (who approved it) and the authorship
   * triple below (which agent wrote it). Commonly three different people: a
   * teammate asks, an agent writes, a lead approves.
   *
   * NULL is a MEANING, not a gap: it is the `cadence` case. The auto-plan
   * watcher runs under the project OWNER's credential so its job has one, and
   * nobody clicked — so the requester is recorded ⟺ a person actually asked
   * (`origin === 'user'`), and a cadence plan is identified by its `origin`
   * rather than by a requester it would otherwise fabricate.
   */
  createdById: string | null;
  /**
   * WHO authored the plan (Story MOTIR-2982 · MOTIR-2986) — the
   * `source · harness · model` triple `docs/decisions/agent-authored-plans.md`
   * Q3 mirrors onto the plan from `work-item-provenance.md` Decision 2. Distinct
   * from `origin` (WHY it was started) and `sourceJobId` (WHICH job produced it):
   * an agent-authored plan and a Motir generation are BOTH `origin: 'user'`.
   *
   * `authorSource` is SERVER-SET at the write seam — `mcp` from the `create_plan`
   * MCP tool, never a caller field. `authorHarness` / `authorModel` are the
   * authoring agent's self-reported free text.
   *
   * All three null on every plan written by any path other than that tool,
   * INCLUDING Motir's own generator — which is deliberately not retrofitted here
   * (MOTIR-2996). So the Plans surface reads *Motir-generated* off
   * `sourceJobId != null`, and *unattributed* off both being null.
   */
  authorSource: PlanAuthorSourceDto | null;
  authorHarness: string | null;
  authorModel: string | null;
  itemCount: number;
  createdAt: string;
  plannedAt: string | null;
  decidedAt: string | null;
  decidedById: string | null;
  /**
   * WHY a `declined` plan ended (MOTIR-3189) — `reviewed`, `discarded` or
   * `abandoned`. Null on every other status, and on a `declined` row written
   * before the column existed, where it means *not recorded* rather than a
   * fourth kind of ending. See {@link PlanDecisionReasonDto}.
   */
  decisionReason: PlanDecisionReasonDto | null;
  /**
   * The requirement a Sharpen session SETTLED on this plan (Task MOTIR-1101 ·
   * MOTIR-8183), or null when nobody has sharpened it. Written whole by the
   * write-back door on every call, so it is always the cumulative state — a
   * session stopped halfway leaves exactly what was settled before the stop.
   */
  sharpenedRequirement: SharpenedRequirementDto | null;
}

/**
 * One assumption the PLANNER recorded for a question the person skipped or
 * answered "you decide" to (Task MOTIR-1101) — its own recommendation, kept
 * apart from the answers the person gave so a reader can tell the two apart.
 */
export interface PlannerAssumptionDto {
  question: string;
  recommendation: string;
}

/**
 * What a Sharpen session settled on a plan (Task MOTIR-1101 · MOTIR-8183): the
 * six parts of the settled requirement (`SubmittedRequirement`, every part
 * optional — a session settles some of them), the planner's marked assumptions,
 * and when the last write landed.
 */
export interface SharpenedRequirementDto extends SubmittedRequirement {
  plannerAssumptions: PlannerAssumptionDto[];
  /** ISO time of the write that stored this value. */
  settledAt: string;
}

/** Where a Sharpen write-back lands — a plan (the work-item scope is retired, MOTIR-9314). */
export type SharpeningScope = { planId: string };

/**
 * The body motir-ai's grilling session sends core's internal write-back door,
 * `PUT /api/internal/ai/plan-sharpening` (Task MOTIR-1101 — the store is
 * MOTIR-8183, the door MOTIR-8175, the sender MOTIR-8176). ONE contract for both
 * sides.
 *
 * Every call carries the CUMULATIVE state, never a delta: `requirement` holds
 * every answer settled so far and `plannerAssumptions` every assumption, so a
 * call after each answer and a single call at stop leave the same result.
 */
export interface SharpeningWriteBackInput {
  /** The motir-ai job sending it — the job token's own job. */
  jobId: string;
  scope: SharpeningScope;
  requirement: Partial<SubmittedRequirement>;
  plannerAssumptions: PlannerAssumptionDto[];
  /** Plan scope only — per-`add`-proposal acceptance criteria and assumptions. */
  perItem?: SharpeningPerItemInput[];
}

/** One `add` proposal's share of a plan-scope write-back. */
export interface SharpeningPerItemInput {
  planItemId: string;
  acceptance: string[];
  assumptions: string[];
}

/** What the write-back door answers: where it wrote, and when. */
export interface SharpeningWriteBackResult {
  scope: SharpeningScope;
  settledAt: string;
}

/** A plan plus its bundled proposal items (the detail view). */
export interface PlanWithItemsDto extends PlanDto {
  items: PlanItemDto[];
}

/** A cursor-paginated page of plans, newest first. */
export interface PlanListPageDto {
  plans: PlanDto[];
  /** Opaque cursor for the next page, or `null` when the last page is reached. */
  nextCursor: string | null;
}

/**
 * WHICH SESSION a new plan belongs to (AMENDMENT 17 §5): the conversation that
 * produced it, or a new session of the door's own origin (§4) — `targetKeys`
 * anchors that session (an expand is about its root item).
 */
export type PlanSessionRef =
  | { sessionId: string }
  | { origin: PlanSessionOriginDto; targetKeys?: readonly string[] };

/** Input to `plansService.createPlan`. */
export interface CreatePlanInput {
  /**
   * The session the plan belongs to. Every PRODUCTION author path passes it
   * explicitly (MOTIR-6022). When absent, `createPlan` still attaches one — a
   * new session whose origin it derives from the row (`mcp` for an MCP-authored
   * plan, `cadence` for a cadence plan, else `generation`) — so "every plan has
   * exactly one session" holds on every path, test fixtures included.
   */
  session?: PlanSessionRef;
  title?: string | null;
  summary?: string | null;
  sourceJobId?: string | null;
  /**
   * WHO ASKED for the plan (MOTIR-2986) — see {@link PlanDto.createdById}.
   *
   * EXPLICIT, never defaulted from the acting context, and that is the whole
   * point: `createPlan` always HAS a `ctx.userId`, and on the cadence path that
   * value is the project owner's, substituted so the job has a credential. A
   * default would therefore record a request the owner never made. Producers on
   * a request path pass it; the cadence watcher does not.
   */
  createdById?: string | null;
  /**
   * WHO authored the plan (MOTIR-2986) — see {@link PlanDto.authorSource}. All
   * three OPTIONAL: every shipped producer (generation, augment, expand, replan,
   * contextual, cadence) calls `createPlan` without them and stores nulls,
   * producing a row identical to one produced before this field existed.
   *
   * `authorSource` is passed by the WRITE SEAM, not by that seam's caller — the
   * `create_plan` MCP tool fixes `'mcp'` here the same way `create_work_item`
   * fixes `source: 'mcp'`, so an agent cannot claim `native`/`manual`. The
   * service does not validate it beyond the type: it is not caller input.
   */
  authorSource?: PlanAuthorSourceDto | null;
  /** The authoring agent's self-reported harness. Trimmed; empty → null. */
  authorHarness?: string | null;
  /** The authoring agent's self-reported model. Trimmed; empty → null. */
  authorModel?: string | null;
  /** Defaults to `user` when omitted — so every existing caller (and every
   *  request-path submit) keeps recording a human-initiated plan without
   *  passing anything. Only the cadence watcher passes `cadence`. */
  origin?: PlanOriginDto;
}

/**
 * A proposal's SECTIONS INPUT (Story MOTIR-9023 · MOTIR-9030) — the typed way a
 * planner hands a door a card's sections instead of composing headings inside
 * `descriptionMd`. An INPUT only: the door checks it against the registry for the
 * proposal's merged kind × type, refuses a missing / unknown / invalid section by
 * name, renders it, and stores ONLY the rendered `descriptionMd`. It is never
 * persisted, so {@link PlanItemProposedFields} gains no key.
 *
 * On an EDIT it is sparse at the section key: an omitted section is kept (read
 * back from the stored body), an explicit `null` clears that section, a list
 * REPLACES the list. Never sent beside `descriptionMd`.
 */
export type ProposalSectionsInput = {
  [K in keyof WorkItemSections]?: WorkItemSections[K] | null;
};

/** The fields of an `add` as a door RECEIVES them: the stored bag plus the
 *  optional sections input, which a door renders into `descriptionMd` and strips
 *  before anything is written. */
export type ProposedFieldsInput = PlanItemProposedFields & {
  sections?: ProposalSectionsInput;
};

/** A single proposed operation appended via `plansService.addProposals`. */
export interface ProposalInput {
  op: PlanItemOpDto;
  /** `modify` / `remove`: the existing target work-item id. Omitted for `add`. */
  workItemId?: string | null;
  /** `add` only. */
  proposedFields?: ProposedFieldsInput | null;
  /** `add` only: the language each proposed text field was written in
   *  (MOTIR-8743), beside `proposedFields` on the wire and copied INTO them on
   *  append. Fixed at generation, never re-read from the setting. */
  languages?: ProposalLanguages;
  /** `modify` only. */
  patch?: PlanItemPatch | null;
  /**
   * `add` / edge changes: the parent ref — a real work-item id, or an
   * intra-plan temp-ref `planItem:<planItemId>` pointing at another `add` in
   * this same plan (resolved at materialize).
   */
  parentRef?: string | null;
  /** `add` / edge changes: blocked-by refs (real ids or intra-plan temp-refs). */
  blockedByRefs?: string[];
  /**
   * `add` only: the OLDER work items the created card SUPERSEDES (Story
   * MOTIR-6577 · MOTIR-6630) — real ids or intra-plan temp-refs naming an `add`
   * persisted by an EARLIER call. Each becomes one `supersedes` link at approve
   * (from = the created card, to = the ref).
   */
  supersedesRefs?: string[];
  /** `modify` / `remove`: the target's revision the change was computed against. */
  baseRevision?: string | null;
  /**
   * `remove` ONLY: why the card is being removed (AMENDMENT 18 §3, MOTIR-6052).
   * Optional; trimmed, then 1–2000 characters. Refused by name on an `add` or a
   * `modify`. Written into the archived revision at approve.
   */
  reason?: string | null;
}

/**
 * The editable fields of a proposed `add` (the proposal-edit path, 7.21.6 ·
 * MOTIR-1370). A sparse patch over the `add`'s `proposedFields`: only the keys
 * present are changed; the rest (incl. `executor`) are left untouched. Only an
 * `add` proposal is editable — `modify`/`remove` target existing items. `title`,
 * when present, must be non-empty (the same invariant `addProposals` enforces).
 */
export interface UpdateProposalInput {
  title?: string;
  kind?: string;
  descriptionMd?: string | null;
  /**
   * The card's sections as an INPUT (Story MOTIR-9023 · MOTIR-9030) — rendered
   * into `descriptionMd`, never stored, never sent beside it. Sparse at the
   * section key over the stored body, which the service parses first. See
   * {@link ProposalSectionsInput}.
   */
  sections?: ProposalSectionsInput;
  type?: string | null;
  priority?: string | null;
  /** Leaf sizing (MOTIR-1433) — patchable on the proposal-edit / deepen path
   *  exactly like the other proposed fields; an explicit `null` clears the
   *  estimate, the same sparse-merge semantics the rest of this input uses. */
  storyPoints?: number | null;
  estimateMinutes?: number | null;
  /** A leaf's DIFFICULTY (MOTIR-6133) — deepenable and correctable like
   *  `storyPoints`, sparse the same way (`null` clears). Re-validated on the
   *  MERGED result, so a deepen that turns a proposal carrying one into a
   *  `story` without clearing it is refused. */
  difficulty?: WorkItemDifficultyDto | null;
  /** AI-drafted explanation (Story 7.4 · MOTIR-850) — deepenable on the
   *  proposal-edit / generation deepen path exactly like `descriptionMd`; an
   *  explicit `null` clears it. Sparse-merged into the `add`'s `proposedFields`
   *  (`mergeProposedFields`). `explanationSource` is not deepened here —
   *  materialize defaults it to `ai_draft` when an explanation is present. */
  explanationMd?: string | null;
  /**
   * WHO executes the leaf (`coding_agent` / `human`) — the ONE field the deepen
   * turn added to this set (`agent-authored-plans.md` AMENDMENT 4 D3a,
   * MOTIR-3089). It is here because `type` is deepenable and `executor` is
   * DERIVED from it, while `plansService.materialize` writes
   * `pf.executor ?? null` and never consults `defaultExecutorForType` — so a
   * titles-first proposal that gains its type on the deepen turn would otherwise
   * materialize unassignable. An explicit `null` clears it.
   *
   * ⚠️ The value is validated at the TRANSPORT, exactly as on the append path:
   * `add_plan_items` constrains `executor` with a zod enum in its own argument
   * schema and `validateProposal` does not check it, so the deepen tool
   * constrains it identically rather than growing a service-level rule the
   * append path does not have.
   *
   * The human review route (`PATCH /api/plans/[id]/items/[itemId]`) ENUMERATES
   * the keys it accepts and does not pick this one up — the same way it already
   * does not pick up `explanationMd` — so widening this interface leaves that
   * surface byte-identical (AMENDMENT 4 D3a).
   */
  executor?: string | null;
  /**
   * The card's ORDERED STEPS — DEEPENABLE, because a step list is what a card
   * SAYS (`docs/decisions/agent-authored-plans.md` AMENDMENT 14 D3).
   *
   * AMENDMENT 3 D3 fixed this set with a rule — *a deepen may change what a card
   * SAYS and who ACTS on it, never where it SITS or SHIPS* — and AMENDMENT 4 D3a
   * is the one widening it has taken, for `executor`, on exactly that reasoning.
   * A to-do list is the card's own words about the work at a finer grain than
   * `descriptionMd`, so it falls on the SAYS side; it says nothing about where
   * the card sits or which repository it ships in, so D3's excluded columns are
   * untouched.
   *
   * ⚠️ REPLACED WHOLE, never merged per row — a list has no meaningful partial
   * edit, the same reason {@link CorrectProposalInput.blockedByRefs} replaces its
   * set. Sparse at the KEY: absent leaves the proposal's list alone, an explicit
   * `[]` or `null` CLEARS it.
   *
   * Re-validated on the MERGED result, so a deepen that flips `kind` to a
   * container on a proposal already carrying steps is refused — the kind gate
   * reads the merge, not the patch alone.
   */
  todos?: ProposedTodoInput[] | null;
  /** The language of each text field this edit writes (MOTIR-8743) — merged per
   *  key, and a field this edit rewrites WITHOUT naming its language drops its
   *  recorded one. Fixed at generation, never re-read from the setting. */
  languages?: ProposalLanguages;
}

/**
 * The fields an explicit CORRECTION may change (Story MOTIR-3533 · Subtask
 * MOTIR-3540) — `UpdateProposalInput` plus the STRUCTURAL columns the deepen
 * turn excludes, and a `modify`'s `patch`.
 *
 * ⚠️ A SEPARATE INTERFACE, deliberately, and NOT a widening of
 * `UpdateProposalInput`. `agent-authored-plans.md` AMENDMENT 3 D3 fixed the
 * deepen turn's editable set with a rule — *a deepen may change what a card SAYS
 * and who ACTS on it, never where it SITS or SHIPS* — and that rule is still
 * right for a deepen. AMENDMENT 7 amends it for a CORRECTION, which is a
 * different act with a different trigger: the author has just discovered that
 * the structure it appended is wrong, and its only alternative is a whole new
 * plan. Two inputs is what keeps both true at once; widening the one would have
 * silently re-opened structure on the deepen path as well.
 *
 * Sparse, like its parent: an omitted key is left alone, an explicit `null`
 * clears. `blockedByRefs` is the one exception and cannot be otherwise — it is a
 * LIST, so a partial edit has no meaning; supplying it REPLACES the set, and
 * `[]` clears it.
 */
export interface CorrectProposalInput extends UpdateProposalInput {
  /** `add` only — a real work-item id, an intra-plan `planItem:` temp-ref, or
   *  `null` to make the proposal top-level. Re-validated by the same check the
   *  append runs, so a correction cannot introduce an unresolvable ref. */
  parentRef?: string | null;
  /** REPLACES the blocked-by set (see the note above); `[]` clears it. */
  blockedByRefs?: string[];
  /** `add` only — REPLACES the supersedes set (MOTIR-6630), exactly as
   *  {@link blockedByRefs} replaces its own; `[]` clears it. */
  supersedesRefs?: string[];
  /** `add` only — the repo pin, re-validated against the project's connected
   *  repositories exactly as approve does; `null` unpins. */
  targetRepo?: string | null;
  /**
   * `add` only — REPLACE the proposal's repository SET with these ordered NAMES
   * (bug MOTIR-4904). `[]` unpins.
   *
   * ⚠️ SUPPLYING ONE FORM OF THE AXIS CLEARS THE OTHER TWO on the corrected
   * proposal, rather than merging into a contradiction the append would have
   * refused. A correction is sparse per KEY, but the three repository fields are
   * one field in three spellings: leaving a stale `targetRepo` beside a new
   * `targetRepos` would store exactly the state `assertSingleTargetRepoInput`
   * exists to keep out, and approve would then have to invent a precedence rule.
   */
  targetRepos?: string[];
  /**
   * `add` only — the same axis as {@link targetRepos}, as `project_repository`
   * ROW IDS (bug MOTIR-4904). Clears the other two forms, for the reason above.
   */
  targetRepositories?: string[];
  /**
   * `add` only — the SINGULAR ROW-ID half of the pin (Story MOTIR-2732 ·
   * MOTIR-3045, surfaced by MOTIR-4924), as the mirror of {@link targetRepoRole}
   * below: a correction that could re-pin a specific row on a two-rows-share-a-role
   * project could not otherwise say which. `null` unpins.
   *
   * Clears the other spellings of the axis, exactly as the SET forms above do.
   */
  targetRepositoryRef?: string | null;
  /**
   * `add` only — RE-PIN the proposal's repo ROLE (MOTIR-3865), the portable half
   * of the pin beside {@link targetRepo}'s settled one. `null` unpins.
   *
   * It is here because a correction that could re-pin the repository NAME and not
   * its ROLE could not correct an ONBOARDING plan's pin at all: at generation the
   * repositories do not exist yet, so a fresh plan pins a ROLE and nothing else
   * (ADR §5.4 · `PlanItemProposedFields.targetRepoRole`). A `modify` proposal's
   * own patch has carried it since MOTIR-1912; the top-level correction did not,
   * so the one shape that always carries a role was the one a correction could
   * not reach.
   *
   * Validated against the closed role VOCABULARY (`PROJECT_REPO_ROLES`), not the
   * project's repository set — the same check the append and a `modify`'s patch
   * run, and the reason a role is emittable before any row exists.
   */
  targetRepoRole?: ProjectRepoRoleDto | null;
  /** `modify` only — REPLACES the patch. The op that carries a dependency edit,
   *  and the one no door could touch at all before this. */
  patch?: PlanItemPatch | null;
  /**
   * `add` only — the SUBJECT coordinate (Story MOTIR-5062 · MOTIR-5065); `null`
   * unpins it.
   *
   * ⚠️ IT IS A CORRECTION KEY AND NOT A DEEPEN KEY, and that split is AMENDMENT 3
   * D3's rule applied rather than an oversight. `subject` is settled at the `lay`,
   * beside `type`, `parentRef` and the repo pin — it says which RULES an authoring
   * pass reads, which is a fact about where the card SITS in the corpus rather
   * than about what it SAYS — so a deepen may not touch it and a correction may.
   *
   * Without this key a mis-derived subject would be unfixable short of a whole new
   * plan, which is precisely the cost AMENDMENT 8's doors exist to remove.
   * Re-validated by the same SHAPE check the append runs, so a correction cannot
   * introduce a subject the append would have refused. The container check that
   * stood beside it retired with MOTIR-5607, at both doors together.
   */
  subject?: string | null;
}

/**
 * The keys {@link UpdateProposalInput} declares — THE SINGLE DECLARED SOURCE
 * every transport onto the deepen / correction service derives from (MOTIR-3865).
 *
 * ⚠️ It exists because a key declared on an input type and read by NO transport
 * is invisible from both ends: the request succeeds, the response is a `200`, and
 * the proposal simply keeps the value it had. That happened three times to one
 * contract — `explanationMd` reached `PlanItemPatch` and not `modify_node`
 * (MOTIR-3860), then reached `UpdateProposalInput` and not the internal
 * correction route (this card) — each time in a change that was locally complete
 * and correct, because nothing anywhere compared the two lists.
 *
 * So every layer that has to agree DERIVES the set from here rather than
 * re-typing it: the compile-time assertion below holds the INTERFACES to it, and
 * `tests/integration/ai/planRevisionRoutes.test.ts` holds the internal route's
 * parser to it. A key added to either input with no transport carrying it fails
 * in the pull request that adds it. (The same guard shape as `MODIFY_PATCH_KEYS`
 * in motir-ai `src/llm/treeGeneration.ts`.)
 */
export const UPDATE_PROPOSAL_KEYS = [
  'title',
  'kind',
  'descriptionMd',
  // The sections INPUT (MOTIR-9030) — rendered into `descriptionMd`, never stored.
  'sections',
  'type',
  'priority',
  'storyPoints',
  'estimateMinutes',
  'difficulty',
  'explanationMd',
  'executor',
  'todos',
  // The language of each text field the edit writes (MOTIR-8743).
  'languages',
] as const;

export type UpdateProposalKey = (typeof UPDATE_PROPOSAL_KEYS)[number];

/**
 * The keys {@link CorrectProposalInput} declares — {@link UPDATE_PROPOSAL_KEYS}
 * plus the STRUCTURAL members a correction adds. Same guard, same reason.
 */
export const CORRECT_PROPOSAL_KEYS = [
  ...UPDATE_PROPOSAL_KEYS,
  'parentRef',
  'blockedByRefs',
  'supersedesRefs',
  'targetRepo',
  'targetRepos',
  'targetRepositories',
  'targetRepositoryRef',
  'targetRepoRole',
  'subject',
  'patch',
] as const;

export type CorrectProposalKey = (typeof CORRECT_PROPOSAL_KEYS)[number];

/**
 * The PLAN'S OWN heading — its `title` and `summary` (MOTIR-4637).
 *
 * ⚠️ NOT a proposal's fields. {@link CorrectProposalInput} above corrects one
 * card ON a plan; this corrects the two lines a reviewer reads ABOVE the tree,
 * before any card. They were write-once from `create_plan` until this input
 * existed, so a single wrong sentence — one the product itself tells an agent to
 * write dispositions into — could only be repaired by withdrawing every proposal
 * (which ENDS a `planned` plan, `declined` / `discarded`) and re-authoring the
 * whole thing under a new id.
 *
 * SPARSE, exactly like its siblings: a key you omit is left alone and an explicit
 * `null` clears it. Both fields are nullable on the row and both are nullable
 * here, so a summary written by mistake can be removed rather than only replaced.
 */
export interface CorrectPlanBriefInput {
  title?: string | null;
  summary?: string | null;
}

/**
 * The keys {@link CorrectPlanBriefInput} declares — the same DECLARED-SOURCE
 * discipline the two constants above are held to, and for the same reason: a key
 * on the input that no transport reads is invisible from both ends.
 */
export const CORRECT_PLAN_BRIEF_KEYS = ['title', 'summary'] as const;

export type CorrectPlanBriefKey = (typeof CORRECT_PLAN_BRIEF_KEYS)[number];

/**
 * The COMPILE-TIME half of the drift guard: each input's keys and its constant
 * are the same set, in BOTH directions.
 *
 * A runtime test cannot enumerate an interface's keys, so this is where the TYPE
 * is held to the constant — adding a field to either input without adding it to
 * its constant (or the reverse) fails `tsc`, before any test runs. The route test
 * then holds the TRANSPORT to the same constant, which is the half that was
 * missing: the interfaces and the parser were each internally consistent and had
 * never been compared.
 */
type UpdateKeyMissingFromConstant = Exclude<keyof UpdateProposalInput, UpdateProposalKey>;
type UpdateKeyMissingFromInterface = Exclude<UpdateProposalKey, keyof UpdateProposalInput>;
type CorrectKeyMissingFromConstant = Exclude<keyof CorrectProposalInput, CorrectProposalKey>;
type CorrectKeyMissingFromInterface = Exclude<CorrectProposalKey, keyof CorrectProposalInput>;
type BriefKeyMissingFromConstant = Exclude<keyof CorrectPlanBriefInput, CorrectPlanBriefKey>;
type BriefKeyMissingFromInterface = Exclude<CorrectPlanBriefKey, keyof CorrectPlanBriefInput>;
const _proposalInputKeysAreExhaustive: [
  UpdateKeyMissingFromConstant,
  UpdateKeyMissingFromInterface,
  CorrectKeyMissingFromConstant,
  CorrectKeyMissingFromInterface,
  BriefKeyMissingFromConstant,
  BriefKeyMissingFromInterface,
] extends [never, never, never, never, never, never]
  ? true
  : never = true;
void _proposalInputKeysAreExhaustive;

/** Options for `plansService.listPlans`. */
export interface ListPlansOptions {
  cursor?: string | null;
  limit?: number;
  /**
   * Narrow the page to ONE lifecycle status — the tabbed Plans list
   * (MOTIR-3241) asks for exactly one tab at a time — or to a SET of them
   * (MOTIR-4106), which is what a caller asking a QUESTION about the lifecycle
   * rather than rendering a tab needs: *which plans are pending?* spans more
   * than one status. **Omit it for the whole project**, which is what every
   * caller predating the tabs does and what keeps their pages byte-identical.
   *
   * Applied as a `where` predicate in the repository, never after the read: a
   * caller-side filter would take the cursor page and then shrink it, so a
   * `planned` page would come back short while `nextCursor` claimed there was
   * more. That is exactly why the SET is expressed here rather than by a caller
   * making one call per status and merging the pages.
   */
  status?: PlanStatusDto | readonly PlanStatusDto[] | null;
}

/** How many plans a project holds in EACH lifecycle status — the counts the
 *  tab strip renders beside its labels (MOTIR-3241).
 *
 *  TOTAL over `PlanStatusDto` by construction: a status with no rows reads `0`,
 *  never an absent key, so a caller cannot render `undefined` for the tab a
 *  project happens to have nothing in. */
export type PlanStatusCountsDto = Record<PlanStatusDto, number>;

// --- Plan staleness (Story 7.21 · MOTIR-1340) -------------------------------
// Computed at REVIEW time from the CURRENT work-item tree + the plan's
// `plannedAt`. The committed tree can change between when a plan is generated
// and when the user reviews it, so a proposed item can DRIFT: its parent was
// archived, a blocker it references was removed, or — for modify/remove — the
// target changed since the patch's `baseRevision`. A PURE READ that WARNS; it
// NEVER blocks approve. The 7.4.5 plan-detail (MOTIR-847) + 7.21.1 plans-list
// (MOTIR-1338) UIs bind to these.

/** The reason a proposed PlanItem is flagged stale. A REASON LIST (not a
 *  boolean) so a single item can carry several, and the set is EXTENSIBLE as
 *  the rule set grows — `add` items get the structural reasons; `modify`/`remove`
 *  items get `base_revision_drift`.
 *
 *  ⚠️ EVERY MEMBER IS KEYED ON SOMETHING THE PROPOSAL ITSELF NAMED (MOTIR-3777):
 *  its parent, its declared blockers, its modify/remove target. `siblings_added`
 *  — *the parent gained a child after `plannedAt`* — was the one member that was
 *  not, and it is RETIRED: it read the parent's child count rather than the
 *  proposal, so on a busy parent it fired within minutes of every plan, for
 *  reasons that were always about somebody else's work. A proposal that named
 *  nothing is self-contained, and nothing that happens beside it can make it
 *  wrong. A new member is welcome here — one keyed on the parent's traffic is
 *  not. */
export type StaleReasonCode = 'parent_removed' | 'blocker_removed' | 'base_revision_drift';

/** One staleness reason, carrying the specifics the review UI shows. */
export type StaleReason =
  /** `add`: the proposal's (real) parent is archived/deleted — it would be
   *  orphaned on approve. */
  | { code: 'parent_removed'; parentId: string }
  /** `add`: these (real) `blocked_by` targets of the proposal are now
   *  archived/deleted — a dangling dependency. */
  | { code: 'blocker_removed'; blockerIds: string[] }
  /** `modify`/`remove`: the target changed since the patch's `baseRevision`
   *  (`edited`), was `archived`, or is `missing` (hard-deleted) — applying the
   *  patch may conflict with a newer edit. */
  | { code: 'base_revision_drift'; change: 'edited' | 'archived' | 'missing' };

/** One proposed PlanItem's staleness verdict. `stale === reasons.length > 0`. */
export interface PlanItemStalenessDto {
  /** The PlanItem this verdict concerns — the stable key (an un-materialized
   *  `add` has no `workItemId`). */
  planItemId: string;
  /** The work item the verdict concerns; `null` only for an `add` that has not
   *  been materialized yet — a `modify` / `remove` always has a target, and an
   *  approved `add` names the card it became (MOTIR-3165). */
  workItemId: string | null;
  stale: boolean;
  reasons: StaleReason[];
}

/** A plan's staleness verdict — per-item reasons + a roll-up `stale` flag. A
 *  plan whose tree is unchanged since `plannedAt` returns all-clear
 *  (`stale: false`, every item with no reasons). */
export interface PlanStalenessDto {
  planId: string;
  stale: boolean;
  items: PlanItemStalenessDto[];
}

/**
 * Whether a WHOLE plan is finishable once it materializes (Subtask MOTIR-1550) —
 * the FOREST analogue of {@link import('./workItems').WorkItemValidityDto} (the
 * single-subtree rule) and {@link import('./sprints').SprintValidityDto} (the
 * sprint rule). The containing set is the ENTIRE projection (every projected node
 * under any projected root — real roots + `add`s with a null parentRef), so a
 * `blocked_by` edge that crosses two sibling roots (a story under epic B gated by
 * a story under epic A, both materializing together) is SATISFIED — the single-
 * subtree rule iterated per-root would false-positive it. VALID ⟺ for every
 * not-done node in the projected forest, every `blocked_by` dependency is IN the
 * forest, or (under `loose`) `done`; `blockers` names each residual gate — in
 * practice an out-of-projection (e.g. cross-project) not-done blocker, or a
 * `done`-but-out-of-forest one under `tight`. The `generate_tree` /replan worker
 * (MOTIR-1398) runs this as its pre-commit post-condition over the multi-root
 * epic forest it proposes.
 */
/**
 * One reason the approve button would REFUSE this plan (MOTIR-3575) — the
 * APPROVABILITY half of a plan's verdict, beside `blockers`' FINISHABILITY half.
 *
 * ⚠️ AT MOST ONE, and that is a property of the gate rather than of this type.
 * `validatePlanProposals` is FAIL-FAST by design: it runs before a write and
 * stops at the first reason, so a plan with two defects reports the more
 * specific one and the next is found after that one is fixed. Modelled as an
 * ARRAY anyway, so a caller writes the same loop whether the gate stays
 * fail-fast or is one day taught to collect.
 */
export interface PlanApprovabilityRejectionDto {
  /** The stable code the approve path raises — what a caller branches on. */
  code:
    | 'INVALID_PLAN_REF_GRAPH'
    | 'PLAN_GRAMMAR_VIOLATION'
    | 'PLAN_TARGET_IMMUTABLE'
    // A `modify` marking a target that is not finished (MOTIR-6663).
    | 'INVALID_PROPOSAL';
  /** The narrower reason where the code has one (`dangling` / `duplicate` /
   *  `cycle` / `illegal_parent` / `unknown_kind`); `null` for immutability and
   *  for `INVALID_PROPOSAL`, which each have exactly one shape here. */
  reason: string | null;
  /** The offending proposal, as `planItem:<id>` — the same form the blockers
   *  array uses for a proposed node, so both halves address a proposal alike. */
  item: string;
  /** The refusal in the words the approve path would use. */
  message: string;
}

/**
 * A plan's whole verdict. TWO independent questions, and a caller reading only
 * `valid` gets both:
 *
 *   * `blockers` — FINISHABILITY: can every item in the projected forest be
 *     finished once this plan materializes?
 *   * `rejections` — APPROVABILITY: would the approve button accept it at all?
 *
 * Before MOTIR-3575 only the first was asked, and `valid: true` was returned for
 * plans the button then refused — which is what made a bad plan safe to close.
 */
export interface PlanValidityDto {
  planId: string;
  /**
   * True only when all FOUR pass: finishable, approvable, every cross-parent edge
   * covered, and no edge crossing levels.
   */
  valid: boolean;
  blockers: SprintBlockerDto[];
  /** As on `WorkItemValidityDto.waits` (MOTIR-9021): the subset of `blockers` the plan does not own. */
  waits?: SprintBlockerDto[];
  rejections: PlanApprovabilityRejectionDto[];
  /**
   * Every same-level cross-parent `blocked_by` in the PROJECTION whose parents
   * carry no matching edge (MOTIR-6370) and which the PLAN introduces
   * (MOTIR-7727 — `planValidityService`'s `planOwnsEdge`). A validation verdict
   * only — neither the append nor approve refuses on it.
   */
  invalidEdges: InvalidEdgeDto[];
  /**
   * Every `blocked_by` in the PROJECTION that joins two levels (MOTIR-6509). A
   * proposed one is refused at the append (`INVALID_PLAN_REF_GRAPH` /
   * `cross_level`), so what reaches here is a COMMITTED edge the plan OWNS — one
   * whose end, or an ancestor of an end, the plan adds, re-parents, re-wires or
   * removes (MOTIR-7727) — a validation verdict, as on `validate_work_item`.
   */
  crossLevelEdges: CrossLevelEdgeDto[];
  /**
   * Per-card SECTION findings over the PROJECTED tree (MOTIR-9032) — every
   * added or modified not-done card whose projected body misses a required
   * section for its projected kind × type. ADVISORY: never changes `valid`.
   * Sorted by `item`.
   */
  sectionFindings: SectionFindingDto[];
}

// --- Auto-plan PAUSE state (Story 7.13 · MOTIR-1740) ------------------------
// The indicator half of MOTIR-916's pending-proposal gate. The cadence watcher
// SKIPS a project whose plan is still undecided, and nothing expires a plan
// (`declinePlan` is an explicit human act), so auto-plan can stay silent
// indefinitely. This is what the AI-planning settings page reads to SAY SO —
// the same predicate the trigger gates on, projected for the reader.

/**
 * Is auto-planning PAUSED for a project, and is the plan it is waiting on out of
 * date? Flat (not a union) so a caller reads `pending` and the rest follows: when
 * `pending` is false every other field is at its empty value.
 *
 * `stale` is the ROLLED-UP verdict of the shipped `planStalenessService`
 * (MOTIR-1340) — the indicator shows the count, never the per-item reason list
 * (that lives on the plan detail). Staleness WARNS; it gates nothing here.
 */
export interface AutoPlanPauseDto {
  /** True ⟺ the project has an undecided plan (`generating` / `planned`) — i.e.
   *  exactly when the cadence sweep skips it with `pending_proposal`. */
  pending: boolean;
  /** The waiting plan, so the indicator can LINK to it (`/plans/{id}`). */
  planId: string | null;
  /** When it finished generating; `null` while it is still `generating`. */
  plannedAt: string | null;
  /** How many items it proposes — the meta line's `aiPlanning.itemCount`. */
  itemCount: number;
  /** Whether ANY proposed item has drifted since the plan was drafted. */
  stale: boolean;
  /** How many have — the drift sentence's count. `0` when not stale. */
  staleCount: number;
}

// --- Plan-job OUTCOME (Story 7.9 · MOTIR-1825) ------------------------------
// The read a NON-INTERACTIVE client needs after it FIRES a plan-edit job and
// walks away. The browser surfaces stream the job (the planning workspace) and watch
// the plan appear; a CLI or agent has no stream to hold open — it submits,
// returns, and comes back later asking "what became of it?". These shapes are
// that answer.

/** Why a plan's job did not (or may not) finish — the service's typed error
 *  code + message, verbatim. */
export interface PlanJobFailureDto {
  code: string;
  message: string;
}

/**
 * The motir-ai job behind a plan, resolved ONLY while the plan is still
 * `generating` — a `planned` / `approved` / `declined` plan's job is already
 * known to have delivered, so there is nothing to ask.
 *
 * `reachable` disambiguates the two ways `failure` can be non-null: `true` means
 * the job itself failed (and `failure` is ITS error), `false` means motir-ai
 * could not be asked (and `failure` describes THAT). Without the flag a caller
 * cannot tell "your expansion died" from "we couldn't check".
 */
export interface PlanJobStateDto {
  /** The job's own state, or `null` when motir-ai could not be reached. */
  status: JobStatus | null;
  /** False ⟺ motir-ai could not be asked; `failure` then describes the outage. */
  reachable: boolean;
  failure: PlanJobFailureDto | null;
}

/**
 * What became of a submitted plan job — the companion read to every
 * `{ jobId, planId }` submit (`aiPlanEditsService.submitExpand` and friends).
 *
 * `status` is the PLAN's own status, verbatim — there is no synthetic "failed"
 * plan state, because a failed job leaves its plan sitting at `generating`
 * forever. That distinction lives in {@link PlanJobStateDto} instead, so the
 * plan substrate's four-state enum is not widened by a transport concern.
 *
 * `itemCount` is how many PROPOSALS the plan bundles — NOT how many work items
 * exist. Nothing here has touched the tree: `plansService.approvePlan` is the
 * only path from a proposal to a row.
 */
export interface PlanOutcomeDto {
  planId: string;
  projectId: string;
  status: PlanStatusDto;
  origin: PlanOriginDto;
  /** The motir-ai job that produced it (a plan is always bound to one here). */
  jobId: string | null;
  /** Proposals bundled in the plan — proposals, not created work items. */
  itemCount: number;
  createdAt: string;
  /** When generation finished; `null` while still `generating`. */
  plannedAt: string | null;
  /** When it was approved / declined; `null` while undecided. */
  decidedAt: string | null;
  /** The job's state — present ONLY while `status === 'generating'`. */
  job: PlanJobStateDto | null;
}

/**
 * The plan statuses the WORK-ITEM PAGE announces — a plan a person still has to
 * DECIDE about, that proposes to change or archive the card being read
 * (bug MOTIR-4197 · design MOTIR-4256 §5).
 *
 * ⚠️ NOT `AI_PENDING_PLAN_STATUSES`, and deliberately so. That set answers *is a
 * planning run in flight for this PROJECT?* (saturation, for a prompt) and is
 * `['generating', 'planned', 'stale']`. This one answers *is a decision pending
 * about THIS card?*, and the two come apart on exactly one member: a
 * `generating` plan is still being appended, so a `modify` naming this card may
 * not survive to `planned` — announcing it announces a claim nobody has finished
 * making. A predicate is classified by the QUESTION it asks (MOTIR-4129), so the
 * two are two constants rather than one with a caller-supplied filter.
 *
 * `stale` IS a member: the schema says it outright — *"NOT terminal and NOT
 * decided: the plan is live and awaiting action"* — and it is reachable only
 * from `planned`, so a plan wearing it has by construction already reached a
 * reviewer. The indicator shows it the same copy and the same link; whether a
 * plan has drifted is the PLAN's property, and `/plans` already says so.
 */
export const WORK_ITEM_PENDING_PLAN_STATUSES = [
  'planned',
  'stale',
] as const satisfies readonly PlanStatusDto[];

/** The statuses the work-item page says NOTHING for — the not-yet-closed one
 *  and the decided pair. Written as its own list so the two together are TOTAL
 *  over `PlanStatusDto`, which `tests/integration/plans/pendingPlanIndicator.test.ts`
 *  asserts: a sixth status lands in neither list and turns that assertion red
 *  instead of quietly falling out of the item page's predicate. */
export const WORK_ITEM_PENDING_PLAN_SILENT_STATUSES = [
  'generating',
  'approved',
  'declined',
] as const satisfies readonly PlanStatusDto[];

/** A plan status the work-item page announces. */
export type WorkItemPendingPlanStatusDto = (typeof WORK_ITEM_PENDING_PLAN_STATUSES)[number];

/**
 * What ONE undecided plan CLAIMS about ONE work item, as the item page reads it
 * (MOTIR-4197, widened by MOTIR-4365 · design MOTIR-4364 §A3).
 *
 * ⚠️ ONE ROW PER PLAN, AND THAT IS NOW LOAD-BEARING RATHER THAN INCIDENTAL. It
 * used to be a property of the substrate: `@@unique([planId, workItemId])` caps
 * a plan at one `modify` / `remove` per card, so one proposal WAS one plan and
 * `pendingPlanCountHeadline` could count rows and be right by accident. The
 * `parentRef` arm breaks that accident — a plan holding eight `add`s under this
 * card produces eight PlanItem rows — so the collapse is performed, in
 * `plansService.listPendingProposalsForWorkItem`, as an in-memory fold over a
 * set bounded by the proposals naming one card. It is NOT a second query.
 *
 * ⚠️ AND THE FIVE INHABITED SHAPES ARE THE COMPONENT'S TOTALITY. Postgres treats
 * NULLs as distinct, so N `add` rows (null target) coexist with one `modify` OR
 * one `remove`: `modify` · `remove` · `add` · `modify`+`add` · `remove`+`add`.
 * A sixth (`modify`+`remove`) is excluded by the unique constraint rather than
 * by choice. The invariant `op !== null || childCount > 0` is what makes those
 * five exhaustive — a row that claims nothing is not a row.
 *
 * Deliberately the POINTER and nothing more — the plan's id (the link), its
 * title (the link's name), and WHAT it claims. The proposed VALUES are read on
 * the plan-review surfaces; a third surface rendering them is the defect the
 * card exists to remove, not the fix. `childCount` is the one exception and it
 * is a magnitude, not a value: an `add` count IS the difference between a tweak
 * and a story about to gain a subtree, whereas a `modify`'s magnitude is not
 * knowable from the row at all (`patch` is a sparse blob).
 */
export interface WorkItemPendingProposalDto {
  planId: string;
  /** `Plan.title` is nullable; the page falls back to `planReview.untitledPlan`. */
  planTitle: string | null;
  planStatus: WorkItemPendingPlanStatusDto;
  /** What this plan proposes about THIS card. `null` when it only adds children
   *  — an `add` cannot TARGET an existing card, since its `workItemId` is null
   *  until materialize, so only the two targeting ops can ever appear here. */
  op: Exclude<PlanItemOpDto, 'add'> | null;
  /** How many `add`s in this plan name this card as their parent; `0` when none. */
  childCount: number;
}

/**
 * What ONE plan did — or proposed — to ONE work item, as the item page's PLAN
 * HISTORY reads it (Story MOTIR-5542 · MOTIR-5546).
 *
 * `op` is the plan's claim ON the card: `add` means *created this item* (the
 * `add` whose materialized id is this card, so only an approved plan carries
 * it), `modify` *changed it*, `remove` *archived it*. `@@unique([planId,
 * workItemId])` caps a plan at one of the three for a card. `childCount` is how
 * many `add`s in the plan are parented on the card, and may combine with any
 * `op`. The invariant `op !== null || childCount > 0` holds on every row: a plan
 * that did nothing to the card is not in its history.
 *
 * The TENSE is not here, deliberately: the same `modify` is *proposes to change*
 * on a `planned` plan and *changed* on an `approved` one, and that sentence is
 * the renderer's to build from `planStatus`.
 */
export interface WorkItemPlanHistoryRelationDto {
  op: PlanItemOpDto | null;
  childCount: number;
}

/**
 * The proposal ids behind a {@link WorkItemPlanHistoryRelationDto}, per
 * relation — `self` is the one `add` / `modify` / `remove` naming the card,
 * `children` the `add`s parented on it, in append order. A consumer comparing a
 * card against the plan that shaped it names the exact proposal with these,
 * without a second read.
 */
export interface WorkItemPlanHistoryProposalIdsDto {
  self: string | null;
  children: string[];
}

/**
 * ONE plan in a work item's PLAN HISTORY (Story MOTIR-5542 · MOTIR-5546) — every
 * status, not only the pending pair {@link WorkItemPendingProposalDto} covers, so
 * a DECLINED plan that proposed archiving the card is part of how the card came
 * to be. Deliberately a POINTER plus the relation: the proposed VALUES are read
 * on the plan's own page (`/plans/<planId>`).
 */
export interface WorkItemPlanHistoryEntryDto {
  planId: string;
  /** `Plan.title` is nullable; the page falls back to `planReview.untitledPlan`. */
  planTitle: string | null;
  planStatus: PlanStatusDto;
  createdAt: string;
  plannedAt: string | null;
  decidedAt: string | null;
  decidedById: string | null;
  /** The decider's display name, read on the same query through `Plan.decidedBy`.
   *  Null while undecided, and on a plan nobody decided (an abandoned plan the
   *  sweep ended carries no `decidedById`). */
  decidedByName: string | null;
  /** WHO authored the plan — see {@link PlanDto.authorSource}. All three null on a
   *  plan Motir's own generator wrote. */
  author: {
    source: PlanAuthorSourceDto | null;
    harness: string | null;
    model: string | null;
  };
  relation: WorkItemPlanHistoryRelationDto;
  proposalIds: WorkItemPlanHistoryProposalIdsDto;
}

/** One page of a work item's plan history, oldest plan first. */
export interface WorkItemPlanHistoryPageDto {
  items: WorkItemPlanHistoryEntryDto[];
  /** Opaque cursor for the next page, or `null` when this is the last. */
  nextCursor: string | null;
}

/** Options for `plansService.listPlanHistoryForWorkItem`. */
export interface PlanHistoryListOptions {
  /** A `nextCursor` a previous page returned; malformed → 400. */
  cursor?: string | null;
  /** Plans per page; clamped server-side. */
  limit?: number;
}

/**
 * AN UNDECIDED PLAN HOLDS THIS CARD (Story MOTIR-6017 · MOTIR-6265;
 * `docs/decisions/agent-authored-plans.md` AMENDMENT 21 §§1–2) — the one shape both
 * the up-front read (`planTargetLockService.readPlanHold`) and the refusal
 * (`PLAN_TARGET_HELD`'s `plan` field, on every door) carry, so a surface draws the
 * line and the Review plan door from either without a second read.
 *
 * `sessionId` + `planId` are `planRowDestination`'s whole input
 * (`lib/planning/planDestination.ts`): a plan WITH a session opens the planning
 * surface, one without opens `/plans/<planId>`.
 */
export type PlanHoldDTO = PlanHeldByPlanDTO | PlanHeldBySessionDTO;

/** An UNDECIDED PLAN holds the card (AMENDMENT 21 §1). */
export interface PlanHeldByPlanDTO {
  kind: 'plan';
  /** The held card's `KEY-n`. */
  itemKey: string;
  workItemId: string;
  /** The plan holding it. */
  planId: string;
  /** Only an UNDECIDED status holds — the second line's copy key. */
  planStatus: 'generating' | 'planned' | 'stale';
  /** The plan's session, or null when it has none. */
  sessionId: string | null;
  /** The plan's first anchor key (its session's `targetKeys[0]`), or null. */
  anchorKey: string | null;
}

/**
 * An OPEN planning SESSION holds the card (AMENDMENT 23 §5; MOTIR-7640) — before
 * any plan exists, or while its plan is still being written. `planId` and
 * `planStatus` are null by decision; the surfaces branch on `kind`.
 */
export interface PlanHeldBySessionDTO {
  kind: 'session';
  itemKey: string;
  workItemId: string;
  planId: null;
  planStatus: null;
  /** The holding session — the Open the session door's address. */
  sessionId: string;
  /** The session's first anchor key (`targetKeys[0]`), or null when project-wide. */
  anchorKey: string | null;
  /** Who started the session, so the line can say who is planning it; null for
   *  a departed starter (the line then reads "A teammate"). */
  holderId: string | null;
  holderName: string | null;
  /** Whether the READER started it — the line then says "You are planning it".
   *  False wherever the read has no reader (a background mover). */
  heldByViewer: boolean;
}

/** The key a hold is grouped by on a board: the plan, else the session. */
export function planHoldKey(hold: {
  kind?: PlanHoldDTO['kind'];
  planId: string | null;
  sessionId?: string | null;
}): string {
  return hold.kind === 'session' ? `session:${hold.sessionId}` : hold.planId!;
}

/**
 * Is this work item still what the last APPROVED plan approved? (Story
 * MOTIR-5544 · Subtask MOTIR-6225.) `no_plan` is a verdict, never an error: the
 * card was never shaped by an approved plan (untouched by any plan, or touched
 * only by plans still `generating` / `planned` / `stale`, or `declined`).
 */
export type ApprovedShapeVerdictDto = 'unchanged' | 'changed' | 'no_plan';

/**
 * The FIRST revision after the approving plan's `decidedAt` that changed what it
 * approved. `changedKeys` is every key of that revision's diff, not only the
 * shape-changing ones, so the reader sees the whole edit.
 */
export interface ApprovedShapeDivergingRevisionDto {
  id: string;
  changedAt: string;
  changedById: string;
  changeKind: string;
  changedKeys: string[];
}

/**
 * A CONTAINER's child set against the one its approving plan approved. Card ids,
 * each list sorted. `added` are children the container has now that the plan did
 * not approve; `removed` are approved children no longer (live) under it.
 */
export interface ApprovedShapeChildSetDto {
  verdict: 'unchanged' | 'changed';
  approvedChildIds: string[];
  currentChildIds: string[];
  added: string[];
  removed: string[];
}

/** ONE work item's verdict against the last approved plan that shaped it. */
export interface WorkItemApprovedShapeVerdictDto {
  workItemId: string;
  verdict: ApprovedShapeVerdictDto;
  /** The approving plan — all four null on `no_plan`. */
  planId: string | null;
  planTitle: string | null;
  decidedAt: string | null;
  /** The approving plan's proposal NAMING the card (`add` / `modify` / `remove`);
   *  null when that plan only added children under it. */
  proposalId: string | null;
  /** Null unless a REVISION diverged; a container can be `changed` by its child
   *  set alone, with no diverging revision. */
  divergingRevision: ApprovedShapeDivergingRevisionDto | null;
  /** Null for a leaf — a card with no children now and none approved. */
  childSet: ApprovedShapeChildSetDto | null;
}

/** The verdicts for a set of work items, in the order the ids were supplied. */
export interface WorkItemApprovedShapeVerdictPageDto {
  items: WorkItemApprovedShapeVerdictDto[];
}

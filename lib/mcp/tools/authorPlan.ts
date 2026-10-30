import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { plansService, PLAN_STEP_SESSION_KEY_MAX } from '@/lib/services/plansService';
import type {
  PlanDto,
  ProposalSectionsInput,
  ProposedFieldsInput,
  PlanWithItemsDto,
  ProposalLinkWarningDto,
  ProposalRescopeWarningDto,
  ProposalInput,
  UpdateProposalInput,
  CorrectProposalInput,
  CorrectPlanBriefInput,
  UpdateProposalKey,
  CorrectProposalKey,
  ProposedTodoInput,
  CorrectPlanBriefKey,
} from '@/lib/dto/plans';
import {
  MODIFY_KIND_TARGETS,
  PLAN_ITEM_REASON_MAX,
  PLANNER_RECORD_MAX_BYTES,
} from '@/lib/dto/plans';
import { PLAN_NARRATION_BATCH_MAX, PLAN_NARRATION_SENTENCE_MAX } from '@/lib/plans/planNarration';
import {
  TODO_COMMAND_MAX_LENGTH,
  TODO_NOTES_MAX_LENGTH,
  TODO_TEXT_MAX_LENGTH,
} from '@/lib/workItemTodos/limits';
import { InvalidPlanStepError, InvalidProposalError } from '@/lib/plans/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived, exempt } from '../payloads/define';
import {
  planAppendPayload,
  planPayload,
  presentMcpPlan,
  presentMcpPlanAppend,
} from '../payloads/workLoop';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
import { WORK_ITEM_DIFFICULTIES } from '@/lib/issues/difficulty';
import { WORK_ITEM_OBSOLESCENCES } from '@/lib/issues/obsolescence';
import type { WorkItemDifficultyDto } from '@/lib/dto/workItems';
import { isWorkItemKey, resolveCorrectionKeyRefs, resolveKeyRefs } from '@/lib/plans/keyRefs';
import { EDGE_REASON_MAX } from '@/lib/plans/edgeReasons';
import {
  REASON_CLASSIFIED_KIND,
  REVISION_REASON_BRANCHES,
  REVISION_REASON_EVIDENCE_MAX,
  type RevisionReasonBranch,
} from '@/lib/plans/revisionReason';
import { resolveWorkItemIdsByKeys } from './workItemRef';
import { projectKeyField } from './readyFilters';
import { GET_PLAN_TOOL_NAME } from './getPlan';

// `create_plan` + `add_plan_items` (Story MOTIR-2982 · Subtask MOTIR-2988) —
// the PAT-authed door onto the plan substrate, so an agent can AUTHOR the
// proposals a person then reviews.
//
// ── Why they exist ─────────────────────────────────────────────────────────
// Every planner Motir ships produces into the plan substrate: a `Plan` of
// `PlanItem` proposals somebody reviews and approves, where nothing becomes a
// work item until they decide. Every planner except an external agent on the
// MCP, which had exactly two write paths and neither authored a proposal —
// `create_work_item` writes a real row immediately (no proposal, no diff, no
// approval), and the plan-session tools reach a `Plan` only by handing a PROMPT
// to motir-ai, spending the owner's credits so Motir's generator can do the
// thinking. So the planner best placed to decompose the work — one already
// sitting in the repository with the code in front of it — could bypass the gate
// or delegate the thinking, and nothing else.
//
// ── These are TRANSPORTS, not a second write path ──────────────────────────
// Every gate, validation and transaction already lives in `plansService`:
// `createPlan` asserts edit access; `addProposals` locks the plan row, re-reads
// its status, refuses an append once the plan has left `generating`, validates
// each proposal's op/grammar/sizing, and rejects an intra-plan temp-ref cycle at
// the boundary. This module is zod argument schemas, three adapters and error
// mapping — the shape `planSession.ts` and `getPlan.ts` are built to.
//
// ── The TWO AUTHORING tools, and why not one (ADR Q1) ──────────────────────
// (A THIRD tool, `update_plan_item`, joined them in 2026-08-19's AMENDMENT 4 —
// see its own header below. Q1 is about how a tree is APPENDED; the deepen is a
// different act on a proposal that already landed, so it does not reopen this.)
// The shipped producer contract is `createPlan` → repeated `addProposals` →
// `markPlanned`, composed by `aiGenerationService.appendProposals` behind
// `POST /api/internal/ai/plan-proposals` — where `markPlanned` is reached by a
// `final: true` FLAG on the last append rather than by a second endpoint (that
// route's header says so in as many words). Two tools mirror that exactly.
//
// One `propose_plan(tree)` cannot work: `addProposals` returns the created
// PlanItem ids IN APPEND ORDER, and those ids ARE the intra-plan temp-refs a
// later batch passes as `parentRef` / `blockedByRefs` (`planItem:<id>`,
// `lib/plans/refs.ts`). A tree deeper than one level therefore needs a
// round-trip per layer, and a whole-tree call would have to invent a second ref
// vocabulary materialize does not understand.
//
// ── AUTHORSHIP is stamped, never accepted (ADR Q3/Q4) ──────────────────────
// `create_plan` fixes `authorSource: 'mcp'` SERVER-SIDE — the discipline
// `create_work_item` applies to `source: 'mcp'`, "so an agent cannot claim
// `manual`/`native`" — and takes only the harness/model as self-reported free
// text. `add_plan_items` then STAMPS each `add`'s `planningProvenance` from the
// plan's own triple and does not offer the field as an argument at all.
//
// That is what lets `docs/decisions/work-item-provenance.md` Decision 5's
// materialize PIN be lifted (MOTIR-2990) without weakening what it protected:
// materialize reads a value a Motir write seam wrote, never one a caller sent.
// It also means a plan's attribution and its items' attribution cannot disagree,
// because there is exactly one place either is written.
//
// ── ONE PROPOSAL PER EXISTING TARGET (MOTIR-3194) ──────────────────────
// `PlanItem @@unique([planId, workItemId])` admits at most one `modify`/`remove`
// per target work item, and MOTIR-3194 KEPT that rule after re-opening it —
// `DuplicatePlanTargetError` (`lib/plans/errors.ts`) argues the three upstream
// reasons on the record, the load-bearing one being that a plan stores only the
// NEW values and the review surface reads each diff's OLD side LIVE from the
// target, so two patches on one card cannot be rendered honestly.
//
// What that card actually FIXED is this file's contract: the rule used to
// announce itself as Prisma's own ``Invalid `prisma.planItem.create()`
// invocation: Unique constraint failed on the (not available)``, because
// `toToolError` re-throws what it does not recognise and the SDK renders a
// re-thrown message verbatim. The refusal is now typed, names the work item, and
// names both alternatives — and the whole append transaction is contained, so no
// OTHER ORM failure can take the route this one took.
//
// AMENDMENT 18 §2 (MOTIR-6051) narrowed it: a second `modify` of one card now
// MERGES into the one row, which keeps all three of MOTIR-3194's reasons true
// (one row, one old side, one base). Only a pairing with a `remove` refuses.
//
// ── NEITHER TOOL IS BILLABLE ───────────────────────────────────────────────
// `MCP_BILLABLE_TOOLS` (`lib/mcp/rateLimitGate.ts`) holds exactly the tools that
// make motir-ai run a model job. These spend no provider tokens and start no
// job — they are database writes, covered by the transport's own `mcp:call`
// limit like every other write tool. Adding them would cap plan authoring
// against the owner's GENERATION allowance for no reason.

// ── AND `update_plan_item` (Story MOTIR-3088 · Subtask MOTIR-3090) ─────────
// The THIRD tool, added 2026-08-19. `add_plan_items` is append-only, so a
// proposal was frozen the moment it landed — which forbade the one authoring
// strategy Motir's own generator uses. `motir-ai`'s issue-tree handler runs
// TITLES-FIRST (MOTIR-845): append title-only `add`s so the SHAPE of the tree is
// settled and reviewable early, then PATCH each card's bodies, type, priority
// and sizing one at a time, all before `markPlanned` closes the frontier.
//
// That deepen op has been shipped since MOTIR-1441 (`plansService.deepenProposal`)
// and was reachable ONLY over the §4 job token, so an external agent on the MCP
// was held to a strategy Motir abandoned for its own planner. This tool is the
// PAT-authed door onto it — and, like its two siblings, a TRANSPORT: the lock,
// the status gate, the add-only rule, the sparse merge and the sizing
// re-validation all already live in `editAddProposal`.
//
// ⚠️ IT RESOLVES BY `planId`, NOT BY `sourceJobId`. The internal seam's
// `aiGenerationService.patchProposal` finds its plan through the plan repository's
// `sourceJobId` lookup; an MCP-authored plan has NO generation job, so that
// lookup would throw `NoPlanForJobError` for every plan `create_plan` opened.
// This tool calls `plansService.deepenProposal(planId, …)` directly and adds no
// second resolution path to `aiGenerationService`. (MOTIR-3090's acceptance is a
// grep: nothing under `lib/mcp/` names that repository method, and this comment
// is deliberately written not to.)
//
// The CONTRACT is `docs/decisions/agent-authored-plans.md` AMENDMENT 4:
// D1 `generating` only (a plan in the review queue must hold still while a person
// reads it), D2 `ai:view_plan` (the key `editAddProposal` itself asserts),
// D3 the editable set gains `executor` and NOTHING else, D4 withdrawing a
// proposal is still unreachable and deferred.

export const CREATE_PLAN_TOOL_NAME = 'create_plan';
export const ADD_PLAN_ITEMS_TOOL_NAME = 'add_plan_items';
export const UPDATE_PLAN_ITEM_TOOL_NAME = 'update_plan_item';
export const UPDATE_PLAN_PROPOSAL_TOOL_NAME = 'update_plan_proposal';
export const WITHDRAW_PLAN_PROPOSAL_TOOL_NAME = 'withdraw_plan_proposal';
export const UPDATE_PLAN_TOOL_NAME = 'update_plan';
export const RECORD_PLAN_REVISION_REASON_TOOL_NAME = 'record_plan_revision_reason';
export const REPORT_PLAN_STEP_TOOL_NAME = 'report_plan_step';
export const HOLD_PLAN_REVISION_TOOL_NAME = 'hold_plan_revision';

// ─────────────────────────────────────────────────────────────────────────────
// Arguments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The self-reported half of the authorship triple.
 *
 * Named `plannedWithHarness` / `plannedWithModel` to match `create_work_item`,
 * which already publishes those two argument names for the identical fact
 * (`work-item-provenance.md` Decision 4). `create_plan` is that tool's
 * reviewable twin; an agent wiring both should pass the same values under the
 * same names (ADR Q1).
 */
const plannedWithHarnessField = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Optional: the harness/tool you are running as (e.g. "Claude Code", "Codex"). Shown to ' +
      'the person reviewing this plan, so they can see it was written by an agent rather ' +
      'than generated by Motir.',
  );

const plannedWithModelField = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Optional: the model you are running (e.g. "claude-opus-5"). Shown beside the harness.',
  );

const createPlanInputSchema = {
  projectKey: projectKeyField,
  title: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Optional short label for the plan — what it is proposing, in a line.'),
  summary: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Optional longer summary (Markdown) of what this plan proposes and why, shown to the ' +
        'reviewer above the tree. Not write-once: `update_plan` corrects it — and the title — ' +
        'after the fact, on a `generating` or `planned` plan, without touching a proposal.',
    ),
  plannedWithHarness: plannedWithHarnessField,
  plannedWithModel: plannedWithModelField,
};

/**
 * A proposed TO-DO row — the element of `todos` (Story MOTIR-3810 · MOTIR-4619).
 *
 * The shape is `ProposedTodoInput` (`lib/dto/plans.ts`) and the bar is the
 * STORE's, imported from `lib/workItemTodos/limits.ts` and never re-typed here:
 * the schema states the cap so an agent is told the number, and the service
 * enforces it so the two can never disagree about it.
 */
const proposedTodoSchema = z.object({
  text: z
    .string()
    .describe(
      `WHAT to do — ONE operation, at most ${TODO_TEXT_MAX_LENGTH} characters. ` +
        '"Change this one setting", "run this one command". Navigation is NOT an operation: ' +
        '"go to the dashboard and find the panel" belongs in `notesMd` of the row that then ' +
        'changes something.',
    ),
  notesMd: z
    .string()
    .nullable()
    .optional()
    .describe(
      `The INSTRUCTIONS for this one operation — Markdown, at most ${TODO_NOTES_MAX_LENGTH} ` +
        'characters. The HOW, where `text` is the WHAT.',
    ),
  commandText: z
    .string()
    .nullable()
    .optional()
    .describe(
      `The command this step runs, if it runs one — at most ${TODO_COMMAND_MAX_LENGTH} ` +
        'characters, and in this field rather than inside `text`, because this is what the ' +
        'reader copies.',
    ),
  executor: z
    .enum(['coding_agent', 'human'])
    .nullable()
    .optional()
    .describe(
      'Who this STEP is for, when it differs from the card’s. Omit it and the row inherits the ' +
        'proposal’s own `executor` at approve, falling back to `human`.',
    ),
});

/** The `todos` array, described once for the three doors that carry it. */
const TODOS_DESCRIPTION =
  'The card’s ORDERED STEPS, written as its to-do list. ARRAY ORDER IS LIST ORDER — the ' +
  'sequence they are performed in — and approving the plan writes one real to-do row per ' +
  'element, none ticked. A `manual` card’s steps belong HERE, not only in the description: ' +
  'the reviewer reads the list they will tick before they approve it, and the created card ' +
  'carries it from birth. Leaf kinds only — a container’s steps are its children.';

/**
 * A leaf's DIFFICULTY (MOTIR-6136), described once for every plan door that
 * carries it. The members come from `WORK_ITEM_DIFFICULTIES` — the field's single
 * source of truth — so a new level reaches the schema enum and this sentence with
 * no edit here. Membership is the schema's; leaf-only is the service's
 * (`validateProposedDifficulty`), answered as a typed `INVALID_PROPOSAL`.
 */
const DIFFICULTY_DESCRIPTION =
  'How hard the work is to REASON about, not how big it is (that is `storyPoints` / ' +
  '`estimateMinutes`): ' +
  WORK_ITEM_DIFFICULTIES.map((d) => `"${d}"`).join(', ') +
  ', easiest first. Leaf kinds only (task / bug / subtask): a non-null value on an epic or ' +
  'story is refused with INVALID_PROPOSAL naming `difficulty`, never silently dropped.';

/**
 * The card's SECTIONS INPUT (Story MOTIR-9023 · MOTIR-9030), described once for
 * every plan door that takes it. The schema is a LOOSE record on purpose: the
 * registry, not this schema, decides which sections a kind × type defines, so a
 * strict object here would duplicate it and its refusal would name a zod path
 * rather than the section. The service answers a typed `INVALID_PROPOSAL`
 * naming each missing, unknown or invalid section.
 */
const SECTIONS_INPUT_DESCRIPTION =
  'OPTIONAL. The card\u2019s sections as named values, instead of composing headings inside ' +
  '`descriptionMd`: the door checks them against the section set for the proposal\u2019s kind \u00d7 ' +
  'type, refuses a missing, unknown or invalid section BY NAME with INVALID_PROPOSAL, writes ' +
  'the headings itself and stores ONLY the rendered `descriptionMd` \u2014 `sections` itself is never ' +
  'stored. Never send it together with `descriptionMd` (refused, naming both). The section ' +
  'sets, their shapes and which are required are served by `get_section_sets`. On an EDIT it ' +
  'is sparse at the section key: the stored body is read back into its sections first, a ' +
  'section you omit is kept, an explicit `null` clears one, and a list REPLACES the list. ' +
  'Omit it to keep sending a plain `descriptionMd` exactly as before.';

const sectionsInputSchema = z.record(z.string(), z.unknown());

// ── The OBSOLESCENCE mark and its `supersedes` edges (Story MOTIR-6577 · MOTIR-6631) ──
// Described ONCE here for every plan door that carries them. The service is the
// only validator (`validateProposedObsolescence`, `assertMarkTargetIsFinished`,
// the ref passes and `assertSupersedesGraphAcyclic`); these sentences only have
// to make the rules and — above all — the DIRECTION of each edge list
// unmisreadable, because `supersedesAdd` and `supersededByAdd` are one storage
// row spelled from its two ends, and a model that swaps them marks the wrong card
// as replaced.

/** The rule every mark sentence repeats: finished work only, never a remove. */
const MARK_RULE =
  'A plan may SET a mark only on a FINISHED target — one whose status is in the `done` ' +
  'category (`done`, `cancelled`, or a custom done status). On a to-do or in-progress target ' +
  'it is refused with INVALID_PROPOSAL: "a plan may mark only a finished work item; <KEY> is ' +
  "at <status>. A work item nobody will finish is removed — send `{ op: 'remove', " +
  'workItemId, reason }` instead." (at the append, at `update_plan_proposal`, and again at ' +
  'approve, where `validate_plan` reports it). Clearing a mark (`null`) is legal on any target.';

/** Where the mark-only carve-out and "marking is not archiving" are said. */
const MARK_ONLY_CARVE_OUT =
  'A MARK-ONLY `modify` — a patch carrying nothing but `obsolescence`, `obsolescenceNoteMd` ' +
  'and the four supersedes lists — is the ONE change a plan may make to a `done` or ' +
  '`cancelled` card; approve writes it and leaves the card’s status alone. Add any other key ' +
  'and the target is refused PLAN_TARGET_IMMUTABLE. Marking is never archiving: the card stays ' +
  'in the tree, and a `remove` never marks anything.';

const OBSOLESCENCE_PATCH_DESCRIPTION =
  'MARK the target as no longer TRUE OF THE CODE: ' +
  WORK_ITEM_OBSOLESCENCES.map((m) => `"${m}"`).join(' or ') +
  ' — "outdated" when the text no longer describes what shipped (the capability lives on in ' +
  'another shape), "deprecated" when it was retired or overturned on purpose. An explicit ' +
  '`null` clears it; omit it to leave the mark alone. A value outside the enum is refused ' +
  'INVALID_PROPOSAL. ' +
  MARK_RULE +
  ' ' +
  MARK_ONLY_CARVE_OUT;

const OBSOLESCENCE_NOTE_PATCH_DESCRIPTION =
  'The Markdown note saying WHY the target is marked — what changed and what to read instead. ' +
  'Independent of `obsolescence` (clearing the mark keeps the note); an explicit `null` clears ' +
  'it. A mark key: legal in a mark-only `modify` of a `done` / `cancelled` card.';

/** The ref forms every supersedes list takes — the same three the blocker lists take. */
const SUPERSEDES_REF_FORMS =
  'Each entry is a work-item KEY ("ACME-7"), a real work-item id, or a `planItem:<id>` ref ' +
  'naming an `add` ALREADY on this plan (returned by an EARLIER call) — so a done card can be ' +
  'marked superseded by a card this plan creates. A key is resolved to its id here, and one ' +
  'that names nothing is refused `dangling` at this call. A `folder:<id>` ref, a ref listed ' +
  'twice, or the target itself is refused INVALID_PLAN_REF_GRAPH; so is an edge that closes a ' +
  'supersedes CYCLE (A replaces B replaces A). No level rule: any kind may supersede any kind.';

const SUPERSEDES_ADD_DESCRIPTION =
  'On the NEWER card: the target REPLACES each listed card. Each entry names an OLDER card; ' +
  'approve writes one `supersedes` link from the target to it. ' +
  SUPERSEDES_REF_FORMS +
  ' Unioned with an earlier `modify` of the same card; the same ref in `supersedesRemove` ' +
  'cancels it. A mark key.';

const SUPERSEDES_REMOVE_DESCRIPTION =
  'On the NEWER card: DELETE the `supersedes` link from the target to each listed (older) card ' +
  'at approve; a link that does not exist is a no-op. Same ref forms as `supersedesAdd`. ' +
  'A mark key.';

const SUPERSEDED_BY_ADD_DESCRIPTION =
  'On the OLD card: `supersededByAdd` names the card that REPLACES it. Each entry names a ' +
  'NEWER card; approve writes one `supersedes` link from it to the target — the same row the ' +
  'newer card’s `supersedesAdd` would write, so spelling one edge from both ends lands one ' +
  'link. This is the list a mark on a done card usually needs beside `obsolescence`. ' +
  SUPERSEDES_REF_FORMS +
  ' A mark key.';

const SUPERSEDED_BY_REMOVE_DESCRIPTION =
  'On the OLD card: DELETE the `supersedes` link from each listed (newer) card to the target at ' +
  'approve; a link that does not exist is a no-op. Same ref forms as `supersededByAdd`. ' +
  'A mark key.';

/** An `add`'s supersedes set — the created card is always the NEWER end. */
const SUPERSEDES_REFS_DESCRIPTION =
  '`add` only: the OLDER cards the created card REPLACES. Approve writes one `supersedes` link ' +
  'from the new card to each. ' +
  SUPERSEDES_REF_FORMS +
  ' Refused on a `modify` (it spells its edges on the patch: `supersedesAdd` / ' +
  '`supersededByAdd`) and on a `remove`. This does NOT mark the older card — to mark it ' +
  '`outdated`, send a mark-only `modify` of it with `supersededByAdd: ["planItem:<this add>"]` ' +
  'in a LATER call.';

/**
 * One proposed operation.
 *
 * A deliberate NARROWING of `ProposalInput`: `planningProvenance` is absent from
 * `proposedFields` because this tool stamps it (see the header), and everything
 * else mirrors the shipped internal seam field for field so the two producers
 * cannot mean different things by the same proposal.
 */
const proposedFieldsSchema = z
  .object({
    title: z.string().trim().min(1).describe('The proposed item’s title. Required on an `add`.'),
    kind: z
      .enum(['epic', 'story', 'task', 'bug', 'subtask'])
      .optional()
      .describe('The proposed kind. Defaults to `task` (a standalone leaf) when omitted.'),
    descriptionMd: z.string().optional().describe('Markdown body — WHAT to do.'),
    sections: sectionsInputSchema.optional().describe(SECTIONS_INPUT_DESCRIPTION),
    explanationMd: z.string().optional().describe('Markdown body — WHY it matters.'),
    type: z
      .enum(WORK_ITEM_TYPES)
      .optional()
      .describe(
        'Leaf work type. A CLOSED set: these fourteen members ARE the schema enum, so ' +
          'anything else is refused here rather than 500ing at approve.',
      ),
    priority: z.enum(['lowest', 'low', 'medium', 'high', 'highest']).optional(),
    executor: z.enum(['coding_agent', 'human']).optional(),
    storyPoints: z
      .number()
      .optional()
      .describe('Agile sizing. Validated at the boundary exactly as the create path validates it.'),
    estimateMinutes: z.number().int().optional().describe('Estimated minutes of work.'),
    difficulty: z
      .enum(WORK_ITEM_DIFFICULTIES)
      .optional()
      .describe(DIFFICULTY_DESCRIPTION + ' Omit it to leave the proposal without one.'),
    targetRepo: z
      .string()
      .optional()
      .describe('WHICH REPO the item ships in — validated against the project’s set at approve.'),
    targetRepos: z
      .array(z.string())
      .optional()
      .describe(
        'EVERY repository this item ships in, ORDERED — the first element is the PRIMARY dispatch ' +
          'routes to. The list does not decide completion: the item completes when every pull ' +
          'request LINKED to it has merged. Bare names or the `owner/name` form, validated against the PROJECT’s repository ' +
          'domain at approve by the same resolver `create_work_item` uses. MUTUALLY EXCLUSIVE with ' +
          '`targetRepo` and `targetRepositories` — one field, three spellings — and supplying two is ' +
          'rejected here rather than silently resolved. `[]` is the empty set.',
      ),
    targetRepositories: z
      .array(z.string())
      .optional()
      .describe(
        'The same axis as `targetRepos`, as the project’s repository ROW IDS, ORDERED. Prefer it ' +
          'when you have the ids: a reference survives a rename and can name one of two rows that ' +
          'share a role, which a name cannot. Mutually exclusive with the two fields above.',
      ),
    targetRepositoryRef: z
      .string()
      .optional()
      .describe(
        'The singular `project_repository` ROW-ID pin (Story MOTIR-2732 · MOTIR-3045, surfaced ' +
          'by MOTIR-4924) — the reference-native spelling for the proposal that ships in ONE ' +
          'repository named by row. It is the only pin that can name one of two rows sharing a ' +
          'role. MUTUALLY EXCLUSIVE with the other repository spellings on the same proposal.',
      ),
    targetRepoRole: z
      .string()
      .optional()
      .describe('The PORTABLE repo pin — a role of the project’s repository set.'),
    todos: z.array(proposedTodoSchema).optional().describe(TODOS_DESCRIPTION),
    subject: z
      .string()
      .optional()
      .describe(
        'WHICH SUBJECT MATTER to compose this leaf’s rule packs from — the FOURTH selector ' +
          'coordinate, `pack(phase, kind, type, subject)`. DERIVE IT AT `lay`, beside `type`, so ' +
          'the coordinate is written BEFORE an authoring pass composes its prompt: a value ' +
          'written afterwards is a default rather than a selector. OMIT IT when no member ' +
          'clearly fits — a wrong member composes rules whose situation cannot occur for this ' +
          'card while looking deliberate, and omission is the right answer far more often than ' +
          'the vocabulary suggests. A leaf has ONE subject: wanting two is a SPLIT signal, ' +
          'exactly as wanting two repositories is. MEMBERSHIP IS NOT VALIDATED HERE — the ' +
          'vocabulary is the rule-pack file set, so a well-formed unrecognised member is ' +
          'accepted and refused one hop later by the rule-pack resolver. Shape only: a ' +
          'lowercase slug of at most 32 characters. Legal on EVERY kind — a container carries one too.',
      ),
  })
  .describe('The proposed item’s fields. Required on an `add`, ignored otherwise.');

/**
 * The `modify` patch — the keys `PlanItemPatch` (`lib/dto/plans.ts`) declares,
 * named here rather than left to an opaque record (MOTIR-3111).
 *
 * This used to be `z.record(z.string(), z.unknown())`, which accepted everything
 * and DOCUMENTED nothing: an agent reading the tool could not tell that a patch
 * may carry a body at all, let alone which one. That mattered the moment the
 * runbook's REPLAN ACTION started routing through this door — it mandates
 * rewriting the survivor's `explanationMd`, and the only listing of what a patch
 * can hold was a sentence saying "the sparse patch".
 *
 * `.passthrough()` is load-bearing, not tidiness: an unrecognised key is passed
 * to the service UNCHANGED rather than stripped, so this schema can never become
 * the reason a field the service already understands stops arriving. Every key
 * below is typed no more narrowly than the boundary the service already enforces
 * (`validateStoryPoints` / `validateEstimateMinutes` reject a non-number today),
 * so nothing that used to reach `applyModify` is turned away here.
 *
 * ⚠️ PASSED THROUGH IS NOT ACCEPTED (bug MOTIR-6259). The service REFUSES a key
 * `PLAN_ITEM_PATCH_KEYS` does not list, naming it (`assertKnownPatchKeys`, at the
 * append and at a correction). Until then it was accepted here, dropped at the
 * merge and never applied — `patch.executor` came back as a success and the
 * approved card had no executor. The refusal lives in the SERVICE rather than as
 * a `.strict()` here so every door that appends a patch gets it, not only this one.
 */
/**
 * ONE entry of a `blocked_by` list (MOTIR-9827): a bare ref, or `{ ref, reason }`
 * — the ref in any form the list takes, and the reason ONE short line saying what
 * the waiting card consumes from that blocker. The cap and the one-line rule are
 * enforced by the service (`lib/plans/edgeReasons.ts`), which names the edge.
 */
const edgeEntry = (ref: z.ZodTypeAny) =>
  z.union([
    ref,
    z
      .object({
        ref,
        reason: z
          .string()
          .describe(
            `ONE short line (at most ${EDGE_REASON_MAX} characters) saying what the waiting card ` +
              'CONSUMES from this blocker — and when it consumes an INTERFACE, the interface ' +
              'itself: the secret names, the permissions, the endpoint, the file or the symbol ' +
              'the two cards must agree on (e.g. "consumes: the `AWS_ORG_ADMIN_*` secrets").',
          ),
      })
      .strict(),
  ]);

const EDGE_REASON_NOTE =
  ' Each entry may be `{ ref, reason }` instead of a bare ref: the reason is one short line ' +
  'saying what the waiting card consumes from that blocker. It is shown on the plan and ' +
  'written onto the link at approve, so the card says why it waits.';

const patchSchema = z
  .object({
    title: z.string().optional().describe('Re-title the target.'),
    descriptionMd: z
      .string()
      .nullable()
      .optional()
      .describe('Markdown body — WHAT to do. An explicit `null` clears it.'),
    explanationMd: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Markdown body — WHY it matters. An explicit `null` clears it. Patch it whenever a ' +
          're-scope moves the card’s rationale: a survivor keeps its OLD explanation unless you ' +
          'rewrite it, and a stale WHY is worse than a null one.',
      ),
    priority: z.enum(['lowest', 'low', 'medium', 'high', 'highest']).nullable().optional(),
    type: z
      .enum(WORK_ITEM_TYPES)
      .nullable()
      .optional()
      .describe(
        'Leaf work type. A CLOSED set: these fourteen members ARE the schema enum. An ' +
          'explicit `null` clears it.',
      ),
    kind: z
      .enum(MODIFY_KIND_TARGETS)
      .optional()
      .describe(
        'RE-KIND the target — the plan door’s `change_kind` (never `epic`). Judged against the ' +
          'PROJECTED tree: the parent must admit the new kind, the new kind must admit every ' +
          'child the target keeps, and re-kinding a leaf into a `story` must clear its leaf ' +
          'fields in the same patch (`type: null`, `difficulty: null`) or it is refused by ' +
          'name. The executor is not a patch key: a re-kind to a container clears it at approve.',
      ),
    storyPoints: z
      .number()
      .nullable()
      .optional()
      .describe('Re-scope the agile sizing. An explicit `null` clears it.'),
    estimateMinutes: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe('Re-scope the time estimate. An explicit `null` clears it.'),
    difficulty: z
      .enum(WORK_ITEM_DIFFICULTIES)
      .nullable()
      .optional()
      .describe(
        'Re-judge the target’s difficulty. ' +
          DIFFICULTY_DESCRIPTION +
          ' Judged on the target’s MERGED kind. An explicit `null` clears it.',
      ),
    todos: z
      .array(proposedTodoSchema)
      .nullable()
      .optional()
      .describe(
        'REPLACE the target’s ordered steps (its to-do list). Approve makes the list exactly ' +
          'this array, in order, none ticked, and DELETES every existing row — ticked ones ' +
          'included; the review and `get_plan` show how many steps that drops and how many ' +
          'were ticked. Omit the key to leave the list alone; `[]` or `null` clears it. Leaf ' +
          'kinds only (judged on the target’s MERGED kind). Not a mark key: a `modify` of a ' +
          'done or cancelled card that carries it is refused.',
      ),
    targetRepo: z
      .string()
      .nullable()
      .optional()
      .describe('RE-PIN which repo the item ships in. An explicit `null` unpins it.'),
    targetRepos: z
      .array(z.string())
      .optional()
      .describe(
        'RE-PIN the target’s WHOLE repository set, ordered, first element primary. Omit the key ' +
          'to leave it alone; `[]` unpins the card entirely. Mutually exclusive with `targetRepo` ' +
          'and `targetRepositories` on the same patch.',
      ),
    targetRepositories: z
      .array(z.string())
      .optional()
      .describe(
        'The same re-pin, as the project’s repository ROW IDS. Mutually exclusive with the two ' +
          'fields above.',
      ),
    targetRepositoryRef: z
      .string()
      .nullable()
      .optional()
      .describe(
        'RE-PIN the target’s repo ROW (Story MOTIR-2732 · MOTIR-3045, surfaced by MOTIR-4924) — ' +
          'the `modify` mirror of the `add` path’s row pin, for the re-plan that moves work to a ' +
          'specific row the role cannot name. An explicit `null` unpins it.',
      ),
    targetRepoRole: z
      .string()
      .nullable()
      .optional()
      .describe('RE-PIN the portable repo role. An explicit `null` unpins it.'),
    parentRef: z
      .string()
      .nullable()
      .optional()
      .describe(
        'RE-PARENT the target: a work-item KEY ("ACME-7") or a real work-item id — the card ' +
          'this one should hang under instead. An explicit `null` moves it to the PROJECT ROOT. ' +
          'Omit the key to leave the parent where it is. It may also be a `planItem:<id>` ref ' +
          'naming an `add` ALREADY on this plan (from an earlier call), to move an existing ' +
          'card under a card this plan creates; approve creates the `add` first, then moves ' +
          'the card. The move is checked against the tree the plan would produce — the ' +
          'kind-parent matrix, no cycle (never under a proposal this plan creates BELOW the ' +
          'card), the depth cap, and a refusal to hang new work under a FINISHED parent. ' +
          'Or `folder:<folderId>` to FILE the target into a folder of this project instead of ' +
          'under a work item — any kind may be filed, `subtask` included, and an unknown folder ' +
          'or another project’s is refused at the append.',
      ),
    blockedByAdd: z
      .array(edgeEntry(z.string()))
      .optional()
      .describe(
        'Dependency edges to ADD — work-item keys ("ACME-7"), real work-item ids, or ' +
          '`planItem:<id>` refs. Each joins the target to an item on the SAME LEVEL — the same ' +
          'depth below their nearest common ancestor — under any parent; a cross-level edge is ' +
          'refused `cross_level`. An epic is blocked only by another epic.' +
          EDGE_REASON_NOTE,
      ),
    blockedByRemove: z
      .array(z.string())
      .optional()
      .describe(
        'Dependency edges to REMOVE — work-item keys ("ACME-7"), real work-item ids, or ' +
          '`planItem:<id>` refs.',
      ),
    // The OBSOLESCENCE mark, its note and the four `supersedes` edge lists
    // (Story MOTIR-6577 · MOTIR-6631) — the six `PLAN_ITEM_MARK_PATCH_KEYS`.
    obsolescence: z
      .enum(WORK_ITEM_OBSOLESCENCES, {
        errorMap: () => ({
          message: `INVALID_PROPOSAL: obsolescence must be ${WORK_ITEM_OBSOLESCENCES.map((m) => `"${m}"`).join(' or ')}, or null to clear it.`,
        }),
      })
      .nullable()
      .optional()
      .describe(OBSOLESCENCE_PATCH_DESCRIPTION),
    obsolescenceNoteMd: z
      .string()
      .nullable()
      .optional()
      .describe(OBSOLESCENCE_NOTE_PATCH_DESCRIPTION),
    supersedesAdd: z.array(z.string()).optional().describe(SUPERSEDES_ADD_DESCRIPTION),
    supersedesRemove: z.array(z.string()).optional().describe(SUPERSEDES_REMOVE_DESCRIPTION),
    supersededByAdd: z.array(z.string()).optional().describe(SUPERSEDED_BY_ADD_DESCRIPTION),
    supersededByRemove: z.array(z.string()).optional().describe(SUPERSEDED_BY_REMOVE_DESCRIPTION),
  })
  .passthrough()
  .describe(
    '`modify` only: the SPARSE patch to apply to the target at approve. A key you omit is left ' +
      'untouched; an explicit `null` CLEARS a nullable field. Nothing is applied until someone ' +
      'approves the plan in Motir.',
  );

const proposalSchema = z.object({
  op: z.enum(['add', 'modify', 'remove']).describe('add a new item, modify one, or remove one.'),
  workItemId: z
    .string()
    .optional()
    .describe('`modify` / `remove` only: the existing target work item’s id.'),
  proposedFields: proposedFieldsSchema.optional(),
  patch: patchSchema.optional(),
  parentRef: z
    .string()
    .optional()
    .describe(
      'Where the proposed item hangs, in any of THREE forms: a work-item KEY ' +
        '("ACME-7", the identifier every other tool takes, case-insensitive); a real ' +
        'work-item id; or `planItem:<id>` naming another `add` in THIS plan — an id this ' +
        'tool returned in `planItemIds` on an earlier call. A key is resolved to its id when ' +
        'the proposal is appended, so the three are interchangeable; a key that names no work ' +
        'item in this workspace is refused HERE, not at approve. OR, instead of a work-item ' +
        'parent, `folder:<folderId>` FILES the item into a folder of this project: it is then a ' +
        'root, any kind may be filed (`subtask` included), and an unknown folder or another ' +
        'project’s is refused HERE.',
    ),
  blockedByRefs: z
    .array(edgeEntry(z.string()))
    .optional()
    .describe(
      'Dependency edges, in the same three forms as `parentRef`: work-item keys ("ACME-7"), ' +
        'real work-item ids, or `planItem:<id>` refs into this plan. A `folder:<id>` ref is ' +
        'refused here — a folder is a placement, it blocks nothing. An edge joins two items on ' +
        'the SAME LEVEL — the same depth below their nearest common ancestor, a folder adding ' +
        'none — and ' +
        'may cross parents; one between two levels is refused `INVALID_PLAN_REF_GRAPH` / ' +
        '`cross_level`. An epic is blocked only by another epic — an edge with an epic at ' +
        'either end is cross-level unless both ends are epics.' +
        EDGE_REASON_NOTE,
    ),
  supersedesRefs: z.array(z.string()).optional().describe(SUPERSEDES_REFS_DESCRIPTION),
  baseRevision: z
    .string()
    .optional()
    .describe(
      '`modify` / `remove` only: the target revision the change was computed against — the ' +
        '`revision` id `skeleton` returns for the target. Never a timestamp or a work-item id: ' +
        'a value that is not a revision of the target is refused INVALID_PROPOSAL. Omit it ' +
        'when you did not read one.',
    ),
  reason: z
    .string()
    .optional()
    .describe(
      '`remove` ONLY: WHY the card is being removed — shown to the reviewer beside the removal ' +
        'and written into the archived card’s history at approve. Trimmed, then 1–' +
        `${PLAN_ITEM_REASON_MAX} characters. Refused on an \`add\` or a \`modify\`, and refused ` +
        'when blank; omit it to send none.',
    ),
});

/**
 * ⚠️ `proposals` MAY BE EMPTY, and only when `final: true` (MOTIR-3193).
 *
 * It used to be `.min(1)`, which made the two-phase authoring path
 * `update_plan_item` shipped (MOTIR-3088) impossible to finish: the SKELETON
 * batches carry the structure, the DEEPEN turns write the cards, and the CLOSE
 * then has NOTHING left to append — while `final` is a flag on an append and the
 * only way to say "I am done". The two outs were both bad (hold one card back
 * out of the deepen phase, or invent a proposal a reviewer never meant), and
 * doing neither leaves the plan `generating`, where nothing can decide it
 * (MOTIR-3189).
 *
 * The internal producer seam has always accepted this shape —
 * `aiGenerationService.appendProposals` skips the append when the batch is empty
 * and calls `markPlanned` regardless — so this is the MCP door catching up with
 * the contract Motir's own generator already uses, not a new one.
 *
 * The EMPTY-and-not-final pair stays refused, in {@link runAddPlanItems}: a
 * cross-field rule cannot live in a `ZodRawShape` (which is what `registerTool`
 * takes), and it must not be answered with a silent success — an empty batch
 * with no `final` is a forgotten flag or a batch built from an empty list, and
 * both are worth telling the caller about.
 *
 * ⚠️ `revision` is AMENDMENT 12's opt-in, and it is the MCP half of AMENDMENT 10
 * D1 (MOTIR-4153). The service relaxation already shipped —
 * `plansService.addProposals` takes `opts.revision` and swaps its `generating`
 * assertion for `assertPlanProposalsEditable`, the same two-status gate
 * `correctProposal` uses — and this door is what was still holding an author to
 * two of the three verbs on a plan AMENDMENT 8 declared editable.
 *
 * It is DECLARED rather than inferred from the status, which is D1's own
 * condition: *"an append to a `planned` plan is permitted exactly when the append
 * DECLARES itself part of a revision"*. Inferring it would make the SAME call
 * mean *append to the tree I am writing* or *change a plan somebody is reading*
 * depending on a status the caller may not have re-read — and the second of those
 * is the one that should have to be typed.
 */
const addPlanItemsInputSchema = {
  planId: z.string().trim().min(1).describe('The plan id `create_plan` returned.'),
  proposals: z
    .array(proposalSchema)
    .describe(
      'The batch to append, in the order you want their ids back. MAY be empty — but ONLY ' +
        'together with `final: true`, which is how a titles-first pass CLOSES a plan it has ' +
        'finished writing.',
    ),
  final: z
    .boolean()
    .optional()
    .describe(
      'Set true on the LAST batch to close the plan (`generating` → `planned`), which is what ' +
        'puts it in front of a person for review. After that, an append needs `revision: true`. ' +
        'Send it with an EMPTY `proposals` array to close a plan you have nothing left to ' +
        'append to.',
    ),
  revision: z
    .boolean()
    .optional()
    .describe(
      'Set true to append to a plan you have ALREADY closed — a plan that is `planned` and in ' +
        'the review queue. Without it such an append is refused. The plan does NOT re-open: it ' +
        'is `planned` before, during and after, and the append is recorded on its timeline with ' +
        'the harness and model that made it, so the reviewer can see a card arrived after they ' +
        'started reading. It cannot be combined with `final` (the plan is already closed) and ' +
        'requires at least one proposal (there is nothing else it could mean). On a `generating` ' +
        'plan it is unnecessary and simply does nothing. `approved` and `declined` stay frozen.',
    ),
};

/**
 * `update_plan_item`'s arguments — the plan, the proposal, and a SPARSE patch.
 *
 * ⚠️ ABSENT ≠ NULL, and the schema must not blur them. `editAddProposal`'s whole
 * contract is that an absent key leaves the field untouched while an explicit
 * `null` clears it (`mergeProposedFields` tests `!== undefined`, key by key). A
 * zod `.default(null)` — or any coercion of `undefined` to `null` — would turn
 * every partial patch into a destructive one, silently. So every field below is
 * `.optional()` (may be missing) AND, where the underlying field is nullable,
 * `.nullable()` (may be explicitly cleared), and the adapter rebuilds the input
 * with `in` presence checks, the way the shipped review route
 * (`app/api/plans/[id]/items/[itemId]/route.ts`) does.
 *
 * `title` is `.trim().min(1)` to match `proposedFieldsSchema` above rather than
 * to substitute for the service's non-empty-title guard — the two doors must not
 * disagree about what a title is. It is the ONE non-nullable member: a proposal
 * with no title is not a proposal.
 *
 * `executor` is here because AMENDMENT 4 D3a put it in the editable set, and it
 * is constrained by the SAME enum `proposedFieldsSchema` uses. `targetRepo` /
 * `targetRepoRole`, `parentRef` and `blockedByRefs` are deliberately absent —
 * D3b and D3c argue both refusals on the record.
 */
const updatePlanItemInputSchema = {
  planId: z.string().trim().min(1).describe('The plan id `create_plan` returned.'),
  planItemId: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The proposal to deepen — one of the ids `add_plan_items` returned in `planItemIds`, ' +
        'in the order you sent them.',
    ),
  title: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Replace the proposed title. Cannot be blanked — a proposal needs a title.'),
  kind: z
    .enum(['epic', 'story', 'task', 'bug', 'subtask'])
    .optional()
    .describe('Replace the proposed kind.'),
  descriptionMd: z
    .string()
    .nullable()
    .optional()
    .describe('Markdown body — WHAT to do. Send `null` to clear it; omit to leave it as it is.'),
  sections: sectionsInputSchema.optional().describe(SECTIONS_INPUT_DESCRIPTION),
  explanationMd: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Markdown body — WHY it matters. Send `null` to clear it; omit to leave it as it is.',
    ),
  type: z
    .enum(WORK_ITEM_TYPES)
    .nullable()
    .optional()
    .describe(
      'Leaf work type. A CLOSED set: these fourteen members ARE the schema enum; `null` ' +
        'clears it.',
    ),
  priority: z
    .enum(['lowest', 'low', 'medium', 'high', 'highest'])
    .nullable()
    .optional()
    .describe('Priority; `null` clears it.'),
  executor: z
    .enum(['coding_agent', 'human'])
    .nullable()
    .optional()
    .describe(
      'WHO executes this leaf. Worth setting whenever you set `type`: approving a plan does ' +
        'NOT derive an executor from the type, so a proposal that never carried one ' +
        'materializes unassigned. `null` clears it.',
    ),
  storyPoints: z
    .number()
    .nullable()
    .optional()
    .describe(
      'Agile sizing, re-validated on the merged result exactly as at append; `null` clears it.',
    ),
  estimateMinutes: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe('Estimated minutes of work; `null` clears it.'),
  difficulty: z
    .enum(WORK_ITEM_DIFFICULTIES)
    .nullable()
    .optional()
    .describe(
      DIFFICULTY_DESCRIPTION +
        ' Judged on the MERGED kind. Send `null` to clear it; omit to leave it as it is.',
    ),
  todos: z
    .array(proposedTodoSchema)
    .nullable()
    .optional()
    .describe(
      TODOS_DESCRIPTION +
        ' REPLACES the list whole — a list has no sparse edit — so send the set you want; ' +
        '`[]` or `null` clears it, and omitting it leaves the proposal’s list alone.',
    ),
  revision: z
    .boolean()
    .optional()
    .describe(
      'Set true to edit a proposal on a plan you have ALREADY closed — a plan that is ' +
        '`planned` and in front of a reviewer. Without it such an edit is refused. The plan ' +
        'does NOT re-open: it is `planned` before, during and after, and the edit is recorded ' +
        'on its timeline with the harness and model that made it. This is how a card’s WORDS ' +
        'are corrected on a landed plan — the same card, same id and edges — rather than by ' +
        'withdrawing it and appending a copy. On a `generating` plan it is unnecessary and ' +
        'changes nothing. `approved` and `declined` stay frozen.',
    ),
};

// ── The CORRECTION door (Story MOTIR-3533 · Subtask MOTIR-3541) ────────────
// `update_plan_item` above is the DEEPEN turn and stays exactly as AMENDMENT 4
// fixed it. These two are a different act on a different set, and the ADR that
// separates them is AMENDMENT 8.
//
// ⚠️ WHY A SECOND TOOL RATHER THAN MORE ARGUMENTS ON THE FIRST. The deepen's
// contract — *a deepen may change what a card SAYS and who ACTS on it, never
// where it SITS or SHIPS* — is a rule an agent reads off the tool description
// and plans against. Growing `update_plan_item` a `parentRef` would make that
// sentence false for every caller, including motir-ai's own titles-first
// generator, in order to serve a caller correcting a mistake. Two tools keep
// both contracts sayable in one line each.
//
// Both are THIN: no logic lives here. The lock, the frozen-status gate, the ref
// re-validation, the sparse merge, the referrer check and the trail write are all
// `plansService.correctProposal` / `.withdrawProposal`.

const correctionRefField = z
  .string()
  .describe(
    'A work-item KEY ("ACME-7", the identifier every other tool takes, case-insensitive); a ' +
      'real work-item id; or a `planItem:<id>` ref naming another `add` on THIS plan. A key is ' +
      'resolved to its id by this call, exactly as `add_plan_items` resolves one, so the three ' +
      'are interchangeable (MOTIR-3934).',
  );

// `revision` is `update_plan_item`'s opt-in; the correction door is legal on a
// `planned` plan already and takes no such flag, so it is dropped from the spread.
const { revision: _updatePlanItemRevision, ...updatePlanItemFieldsSchema } =
  updatePlanItemInputSchema;

const updatePlanProposalInputSchema = {
  ...updatePlanItemFieldsSchema,
  planItemId: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The proposal to correct — one of the ids `add_plan_items` returned in `planItemIds`, ' +
        'in the order you sent them.',
    ),
  parentRef: correctionRefField
    .nullable()
    .optional()
    .describe(
      '`add` only: re-parent the proposal. A work-item KEY ("ACME-7"), a real work-item id, or ' +
        'a `planItem:<id>` ref naming another `add` on THIS plan; `folder:<folderId>` to file it ' +
        'into a folder of this project instead; `null` makes it top-level. ' +
        'Re-validated by the same checks the append runs, so a key or a ref naming nothing is ' +
        'refused here rather than at approve — and a ref to the proposal ITSELF is refused too.',
    ),
  blockedByRefs: z
    .array(edgeEntry(correctionRefField))
    .optional()
    .describe(
      'REPLACES the dependency edges wholesale — a list has no sparse edit, so send the set you ' +
        'want and `[]` to clear it. Same ref rules and same re-validation as `parentRef`. The ' +
        'edges’ reasons are replaced with them.' +
        EDGE_REASON_NOTE,
    ),
  supersedesRefs: z
    .array(correctionRefField)
    .optional()
    .describe(
      'REPLACES an `add`’s supersedes set wholesale — send the set you want, `[]` to clear it. ' +
        SUPERSEDES_REFS_DESCRIPTION +
        ' To change a `modify`’s supersedes edges, replace its `patch` instead.',
    ),
  targetRepo: z
    .string()
    .nullable()
    .optional()
    .describe(
      '`add` only: re-pin WHICH REPO this proposal ships in, validated against the project’s ' +
        'repository set (a repository connected to the workspace but not linked to the project ' +
        'is rejected); `null` unpins it.',
    ),
  targetRepos: z
    .array(z.string())
    .optional()
    .describe(
      '`add` only: REPLACE this proposal’s repository set with these ordered names; `[]` unpins ' +
        'it. ⚠️ The repository axis is REPLACED rather than merged — correcting one of ' +
        '`targetRepo` / `targetRepos` / `targetRepositories` CLEARS the other two, because they ' +
        'are one field in three spellings and a proposal carrying two would be a contradiction ' +
        'approve had to guess at.',
    ),
  targetRepositories: z
    .array(z.string())
    .optional()
    .describe(
      '`add` only: the same replacement, as the project’s repository ROW IDS. Clears the other ' +
        'two spellings, for the reason above.',
    ),
  targetRepositoryRef: z
    .string()
    .nullable()
    .optional()
    .describe(
      '`add` only: re-pin the SINGULAR ROW-ID half of the pin (Story MOTIR-2732 · MOTIR-3045, ' +
        'surfaced by MOTIR-4924) — the one spelling that names one of two rows sharing a role. ' +
        '`null` unpins it. Clears the other spellings, for the reason above.',
    ),
  targetRepoRole: z
    .string()
    .nullable()
    .optional()
    .describe(
      '`add` only: re-pin the PORTABLE half of the pin — a ROLE of the project’s repository set, ' +
        'validated against the closed role vocabulary rather than the project’s rows; `null` unpins ' +
        'it. This is the pin an ONBOARDING plan actually carries, because its repositories do not ' +
        'exist yet.',
    ),
  subject: z
    .string()
    .nullable()
    .optional()
    .describe(
      '`add` only: re-pin the SUBJECT coordinate — which rule packs an authoring pass composes ' +
        'for this leaf. An explicit `null` unpins it. Correctable here and NOT on the deepen ' +
        'turn, deliberately: a subject says where the card sits in the RULE CORPUS rather than ' +
        'what it says, so it is settled at the `lay` beside `type` and the repo pin. ' +
        'Re-validated by the same shape and container checks the append runs; membership is not ' +
        'checked here in either door.',
    ),
  patch: patchSchema
    .nullable()
    .optional()
    .describe(
      '`modify` only: REPLACES that proposal’s patch. This is the op no door could touch at ' +
        'all before — and the one that carries a dependency edit, so it is usually what a ' +
        'mistyped `planItem:` ref is sitting on. It is also how a `modify`’s MARK is corrected: ' +
        'the replacement patch’s `obsolescence`, `obsolescenceNoteMd` and four supersedes lists ' +
        'are re-checked exactly as the append checks them, including the finished-target rule.',
    ),
};

const withdrawPlanProposalInputSchema = {
  planId: z.string().trim().min(1).describe('The plan id `create_plan` returned.'),
  planItemId: z
    .string()
    .trim()
    .min(1)
    .describe('The proposal to take off the plan — one of the ids `add_plan_items` returned.'),
};

// ── AND `update_plan` (MOTIR-4637) ─────────────────────────────────────────
// The SIXTH tool, and the one that is not about a proposal at all. The five
// above reach every part of a plan under review except the two lines a reviewer
// reads FIRST: the plan's own `title` and `summary`, written once by
// `create_plan` and unreachable afterwards. So the cheapest possible mistake —
// one wrong sentence, in the field `create_plan` itself describes as "shown to
// the reviewer above the tree" — had the most expensive remedy in the surface:
// withdraw every proposal (which ENDS a `planned` plan as `declined` /
// `discarded`), re-create the plan, re-append every proposal with every
// `planItem:` ref rebuilt, re-close it.
//
// ⚠️ WHY A SIXTH TOOL AND NOT AN ARGUMENT ON `update_plan_proposal`. That tool's
// contract is addressed to ONE proposal — it takes a `planItemId` and every
// field on it patches that proposal's own body or structure. Growing it a pair
// of plan-level fields would make its `planItemId` conditionally meaningless and
// its one-line contract unsayable. The same argument AMENDMENT 8 made for not
// widening the deepen turn.
//
// THIN, like its siblings: the lock, the frozen-status gate and the trail write
// are all `plansService.correctPlanBrief`.

const updatePlanInputSchema = {
  planId: z.string().trim().min(1).describe('The plan id `create_plan` returned.'),
  title: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .optional()
    .describe(
      "The plan's own short label — what it is proposing, in a line. `null` clears it. Omit " +
        'it to leave it exactly as it is.',
    ),
  summary: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .optional()
    .describe(
      'The longer summary (Markdown) shown to the reviewer above the tree — the sentence they ' +
        'read before any card. `null` clears it. Omit it to leave it exactly as it is.',
    ),
  plannerRecord: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe(
      'YOUR OWN record on the plan, as data — machine state you keep between runs (e.g. the ' +
        'targets you settled and how each walk left them), which a reviewer never sees. A JSON ' +
        `object of at most ${PLANNER_RECORD_MAX_BYTES} bytes, REPLACED WHOLE; \`null\` clears it. ` +
        '`get_plan` returns it as `plannerRecord`. Keep it out of `summary`: the summary is ' +
        'prose a person reads and may correct. Omit it to leave it exactly as it is.',
    ),
};

interface UpdatePlanArgs {
  planId: string;
  title?: string | null;
  summary?: string | null;
  plannerRecord?: Record<string, unknown> | null;
}

// ── AND `record_plan_revision_reason` (Story MOTIR-5543 · MOTIR-6086) ────────
// The SEVENTH tool, and the only one that changes NOTHING about the plan. The
// six above all edit what the plan SAYS; this one records WHY it had to change.
//
// It exists because the planner-bug home is only as useful as its signal. The
// runbook used to file a planning bug on every re-plan, so a reviewer saying
// "I'd rather have a side panel" produced the same record as a plan that forgot
// to check whether its repository still exists — and several hundred records
// later a triager cannot tell the planner's real blind spots from ordinary
// conversation.
//
// ⚠️ THE ROW IS WRITTEN ON ALL FOUR BRANCHES, including the two that file
// nothing, and that is the point rather than a completeness flourish: a silent
// "no bug" is indistinguishable from a forgotten one, while a recorded
// "different solution, no bug" can be checked.
//
// ⚠️ AND NOTHING READS IT BACK HERE. The record is INTERNAL — Motir's own
// judgement about its own planner — so no tenant surface returns it and no MCP
// read exposes it. Epic 10 is the eventual reader.
//
// Gated on `ai:view_plan`, the key the other correction doors assert, so a
// CLI-minted token cannot reach it either: classifying a revision is part of
// revising a plan, and a run that may not revise one should not annotate one.
//
// THIN, like its siblings: the branch/bug agreement, the key resolution, the
// frozen-status gate and the trail write are all
// `plansService.recordRevisionClassification`.

const recordPlanRevisionReasonInputSchema = {
  planId: z.string().trim().min(1).describe('The plan id `create_plan` returned.'),
  branch: z
    .enum(REVISION_REASON_BRANCHES)
    .describe(
      'WHY this plan has to change. `new_ask` — the person now wants something the ' +
        'conversation that settled the plan never raised. `different_solution` — the plan ' +
        'answered what was asked and they prefer another answer. `rule_gap` — the plan missed ' +
        'a check and NO planning rule asks for it; its fix is a new rule. `rule_not_followed` ' +
        '— a rule requires the check and this pass did not apply it. The first two are about ' +
        'the person and file NO planning bug; the last two are about the planner and each file ' +
        'exactly one.',
    ),
  evidenceMd: z
    .string()
    .trim()
    .min(1)
    .max(REVISION_REASON_EVIDENCE_MAX)
    .describe(
      'WHY you chose that branch, in Markdown — required on every branch. For `new_ask` / ' +
        '`different_solution`, quote the turn that raised the thing or say that none did. For ' +
        'the two rule branches, quote the rule SEARCH: choosing between them, and ruling both ' +
        'out, is a search and not a judgement, and a gap asserted without one is an unverified ' +
        'negative.',
    ),
  planningBugKey: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'The planning bug you filed, by its key (`MOTIR-123`) — REQUIRED on `rule_gap` and ' +
        '`rule_not_followed`, and REFUSED on the other two. File it first with ' +
        '`create_work_item` into the project’s `Planning bugs` folder, then pass its key here ' +
        'so the classification points at the record it produced.',
    ),
};

interface RecordPlanRevisionReasonArgs {
  planId: string;
  branch: RevisionReasonBranch;
  evidenceMd: string;
  planningBugKey?: string;
}

// `report_plan_step` (Story MOTIR-7820 · Subtask MOTIR-7824) — the MCP planner's
// door onto the plan's in-flight STEPS: which step each running planner session
// is on, so a person following the plan sees what it is doing right now.
//
// ONE tool with a fourth step value, `end`, rather than a report tool and a clear
// tool: the internal route the hosted planner calls carries the same four values,
// so each emitter writes one call shape.
//
// Same grant as the other authoring doors, `ai:view_plan`, which the service
// asserts on the plan's project as its first act — so a `motir run` credential
// (`CLI_TOKEN_GRANT`) cannot reach it. A run executing one work item has no
// business reporting progress on a plan.
//
// THIN, and deliberately so: `target` is optional on EVERY step at the schema.
// Which steps take a target, which refs are legal, the `generating` guard and the
// clock all belong to `plansService.recordPlanStep`. A copy of "target required"
// here would refuse the two untargeted forms both walks really have — a lay of
// the project's top level, and an author session for an item not on the plan yet.
const PLAN_STEP_VALUES = ['settle', 'lay', 'author', 'end'] as const;
type PlanStepValue = (typeof PLAN_STEP_VALUES)[number];

const reportPlanStepInputSchema = {
  planId: z.string().trim().min(1).describe('The plan id `create_plan` returned.'),
  sessionKey: z
    .string()
    .trim()
    .min(1)
    .max(PLAN_STEP_SESSION_KEY_MAX)
    .describe(
      'A stable name for the planner SESSION reporting the step (at most ' +
        `${PLAN_STEP_SESSION_KEY_MAX} characters) — one per concurrently running session, so ` +
        'several sessions of one parallel level each hold their own step. A second report under ' +
        'the same key REPLACES that session’s step.',
    ),
  step: z
    .enum(PLAN_STEP_VALUES)
    .optional()
    .describe(
      'The step the session is starting: `settle` (settling the brief — never a target), ' +
        '`lay` (laying the children of `target`, or the project’s top level with no target), ' +
        '`author` (writing `target`, or an item not on the plan yet with no target), or `end` ' +
        '(the session finished — clears its step; never a target). A step report also records ' +
        'the words a person reads at the head of that session’s narration. Send exactly one ' +
        'of `step` or `narration`.',
    ),
  narration: z
    .array(z.string())
    .optional()
    .describe(
      'Instead of `step`: one or more plain-language sentences saying what the session is ' +
        'doing and why, appended in order to the plan’s kept narration under `sessionKey` ' +
        `(at most ${PLAN_NARRATION_BATCH_MAX} per call; whitespace is collapsed and a sentence ` +
        `longer than ${PLAN_NARRATION_SENTENCE_MAX} characters is cut with an ellipsis). ` +
        'Refused with PLAN_STEP_INVALID when sent with `step` or `target`, when a sentence is ' +
        'empty, or when the session has not reported `settle`, `lay` or `author` yet. Nothing ' +
        'is recorded on a refusal.',
    ),
  target: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'What the step works on: a `planItem:<id>` ref naming an `add` on THIS plan, or a ' +
        'committed work item in the plan’s project by its KEY (`MOTIR-123`) or id. Leave it ' +
        'out on `lay` for the project’s top level and on `author` for an item not yet on the ' +
        'plan. Refused on `settle` and `end`.',
    ),
};

interface ReportPlanStepArgs {
  planId: string;
  sessionKey: string;
  step?: PlanStepValue;
  target?: string;
  narration?: string[];
}

interface UpdatePlanProposalArgs extends UpdatePlanItemArgs {
  parentRef?: string | null;
  blockedByRefs?: string[];
  supersedesRefs?: string[];
  targetRepo?: string | null;
  targetRepos?: string[];
  targetRepositories?: string[];
  targetRepositoryRef?: string | null;
  targetRepoRole?: string | null;
  subject?: string | null;
  patch?: Record<string, unknown> | null;
}

interface WithdrawPlanProposalArgs {
  planId: string;
  planItemId: string;
}

interface CreatePlanArgs {
  projectKey: string;
  title?: string;
  summary?: string;
  plannedWithHarness?: string;
  plannedWithModel?: string;
}

interface AddPlanItemsArgs {
  planId: string;
  proposals: z.infer<typeof proposalSchema>[];
  final?: boolean;
  revision?: boolean;
}

interface UpdatePlanItemArgs {
  planId: string;
  planItemId: string;
  title?: string;
  kind?: string;
  descriptionMd?: string | null;
  sections?: ProposalSectionsInput;
  explanationMd?: string | null;
  type?: string | null;
  priority?: string | null;
  executor?: string | null;
  storyPoints?: number | null;
  estimateMinutes?: number | null;
  difficulty?: WorkItemDifficultyDto | null;
  todos?: ProposedTodoInput[] | null;
  revision?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Summaries
// ─────────────────────────────────────────────────────────────────────────────

/** ` · written by <harness> · <model>` — the agent half, when self-reported.
 *  The requester half is an id here and a NAME on the surfaces; a tool result
 *  hands back the id its caller can act on, not a display string. */
function attribution(plan: PlanDto): string {
  if (!plan.authorHarness && !plan.authorModel) return '';
  const parts = [plan.authorHarness, plan.authorModel].filter(Boolean);
  return ` · written by ${parts.join(' · ')}`;
}

/** The PROPOSAL GATE, in the words its siblings already use. */
const PROPOSAL_GATE =
  'These are PROPOSALS, not work items. Nothing exists in the tree yet: approving the plan ' +
  'in Motir is the only path from a proposal to a work item, and approval does not happen ' +
  'on this surface. Do not report proposed work as created.';

function summarizeCreate(plan: PlanDto, projectKey: string): string {
  return [
    `Opened plan ${plan.id} on ${projectKey} — ${plan.status}${attribution(plan)}.`,
    plan.title ? `Title: ${plan.title}` : null,
    '',
    `Append proposals with \`${ADD_PLAN_ITEMS_TOOL_NAME}\`, parents before children, and set ` +
      '`final: true` on the last batch to put the plan in front of a reviewer.',
    '',
    PROPOSAL_GATE,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * The CLOSE-ONLY summary (MOTIR-3193): a final batch that appended nothing.
 *
 * {@link summarizeAppend} would answer it with "Appended 0 proposal(s)" and an
 * empty id list — a description of the CALL, when the thing that happened to the
 * PLAN is that it closed. The text block is the half a human watching the
 * session reads, so it says what changed.
 */
function summarizeClose(plan: PlanWithItemsDto): string {
  // ⚠️ A CLOSE OVER NOTHING DOES NOT REACH THE REVIEW QUEUE (MOTIR-4124), so
  // this note must not say it did. `markPlanned` DISCARDS a plan holding zero
  // proposals — `declined` / `discarded` — because `planned` means somebody is
  // being asked to decide, and there is nothing here to decide. An agent
  // reading "it is in the review queue now" would report a plan as submitted
  // that nobody will ever be shown.
  if (plan.status !== 'planned') {
    return [
      `Closed plan ${plan.id} — ${plan.status}, and it proposed NOTHING. Nothing was appended ` +
        'by this call, and the plan held no proposals to close over.',
      '',
      'It was DISCARDED rather than queued for review: a plan with no proposals asks for a ' +
        'decision there is nothing to make, so it is recorded as ended instead of waiting on ' +
        'somebody. Nobody will be shown it. If you meant to propose something, open a NEW plan ' +
        `with \`${CREATE_PLAN_TOOL_NAME}\` and append before you close it.`,
      '',
      PROPOSAL_GATE,
    ].join('\n');
  }
  return [
    `Closed plan ${plan.id} — ${plan.status}, ${plan.itemCount} proposal(s) in total. ` +
      'Nothing was appended by this call.',
    '',
    'It is in the review queue now. `add_plan_items` is refused from here UNLESS it carries ' +
      '`revision: true` — which appends to the plan where it stands, keeps it `planned`, and ' +
      `records itself on the timeline; \`${UPDATE_PLAN_ITEM_TOOL_NAME}\` likewise needs ` +
      '`revision: true` to rewrite a card, and `update_plan_proposal` corrects where one sits. ' +
      `Read it back with ` +
      `\`${GET_PLAN_TOOL_NAME}\`.`,
    '',
    PROPOSAL_GATE,
  ].join('\n');
}

/**
 * ⚠️ THE THIRD ARM IS THE ONE THIS FUNCTION GAINED, AND THE OLD TWO WOULD BOTH
 * HAVE LIED ABOUT IT (MOTIR-4153).
 *
 * Until a revision could append, `status === 'planned'` here meant exactly one
 * thing — this call carried `final: true` and CLOSED the plan — so the line said
 * *"accepts no further proposals"*, which was true of every way of reaching it. A
 * revision reaches the same status having just disproved that sentence, so the
 * arms split on WHICH act closed the gap rather than on the status alone.
 */
/**
 * The item links a write KEPT that would ship dead (MOTIR-10104), as the lines a
 * caller reads under the summary — one per link, with the corrected link when the
 * server computed one. Empty when the write left none, so a clean write reads as
 * it always did.
 */
function linkWarningsText(warnings: readonly ProposalLinkWarningDto[] | undefined): string {
  if (!warnings || warnings.length === 0) return '';
  const lines = warnings.map(
    (w) =>
      `- ${w.proposal}, \`${w.field}\`: \`${w.link}\` — ${w.reason}. ` +
      (w.correctedLink
        ? `Write \`${w.correctedLink}\` instead.`
        : `Write ${(w.canonicalForms ?? []).map((f) => `\`${f}\``).join(' or ')}.`),
  );
  return (
    `\n\nWritten, with ${warnings.length} link(s) to fix — approve refuses the plan while a ` +
    `malformed one remains:\n${lines.join('\n')}`
  );
}

/**
 * The `modify`s a write KEPT that approve will send back from built work
 * (MOTIR-10106), as the lines a caller reads under the summary — one per card.
 * Empty when the write left none, so a clean write reads as it always did.
 */
export function rescopeWarningsText(
  warnings: readonly ProposalRescopeWarningDto[] | undefined,
): string {
  if (!warnings || warnings.length === 0) return '';
  return (
    `\n\nWritten, with ${warnings.length} card(s) approve will re-open:\n` +
    warnings.map((w) => `- ${w.proposal}: ${w.message}`).join('\n')
  );
}

function summarizeAppend(plan: PlanWithItemsDto, planItemIds: string[], revision: boolean): string {
  const closing = (): string => {
    if (revision)
      return (
        'This plan is `planned` — it is in front of a reviewer, and this append is on its ' +
        'timeline with the harness and model that made it, so they can see that a card arrived ' +
        'after they started reading. It did NOT re-open: the plan was `planned` before this ' +
        `call and is \`planned\` after it. Read it back with \`${GET_PLAN_TOOL_NAME}\`.`
      );
    if (plan.status === 'planned')
      return (
        'This plan is now `planned` — it is in the review queue. A further append needs ' +
        `\`revision: true\`, which keeps it \`planned\` and records itself on the timeline. ` +
        `Read it back with \`${GET_PLAN_TOOL_NAME}\`.`
      );
    return 'Still `generating` — send `final: true` on your last batch when the tree is complete.';
  };
  return [
    `Appended ${planItemIds.length} proposal(s) to plan ${plan.id} — ${plan.status}, ` +
      `${plan.itemCount} proposal(s) in total.`,
    '',
    'Ids of the proposals THIS call created, in the order you sent them:',
    ...planItemIds.map((id, index) => `  ${index}. ${id}`),
    '',
    'Use `planItem:<id>` with any of those as a `parentRef` or `blockedByRefs` entry on a ' +
      'LATER batch, to hang children off these proposals before they exist as work items.',
    '',
    closing(),
    '',
    PROPOSAL_GATE,
  ].join('\n');
}

/**
 * `update_plan_item`'s summary — say WHICH fields this call changed.
 *
 * The list is the ARGUMENT keys the caller sent, not a diff of the stored
 * proposal: an agent that patches `descriptionMd` to the value it already had has
 * still made that call, and a summary claiming otherwise would be answering a
 * question nobody asked. What it does buy is the absent-vs-null distinction being
 * VISIBLE in the transcript — a human watching a deepen pass can see that a call
 * touched two fields and not eight.
 */
function summarizeDeepen(
  plan: PlanWithItemsDto,
  planItemId: string,
  changed: readonly string[],
  revision = false,
): string {
  const closing =
    plan.status === 'planned'
      ? 'This plan is `planned` — it is in front of a reviewer, and this edit is on its ' +
        'timeline with the harness and model that made it. It did NOT re-open: the plan was ' +
        `\`planned\` before this call and is \`planned\` after it. Read it back with ` +
        `\`${GET_PLAN_TOOL_NAME}\`.`
      : `Still \`generating\` — deepen the rest, then send \`final: true\` on a last ` +
        `\`${ADD_PLAN_ITEMS_TOOL_NAME}\` batch to put the plan in front of a reviewer. ` +
        'After that this tool needs `revision: true`: a plan somebody is reading moves only ' +
        'by an edit that declares itself.';
  return [
    `${revision && plan.status === 'planned' ? 'Revised' : 'Deepened'} proposal ${planItemId} ` +
      `on plan ${plan.id} — ${plan.status}, ${plan.itemCount} proposal(s) in total.`,
    changed.length > 0
      ? `Fields set by this call: ${changed.join(', ')}. Every other field was left as it was.`
      : 'No fields were sent, so nothing changed.',
    '',
    closing,
    '',
    PROPOSAL_GATE,
  ].join('\n');
}

/**
 * The CORRECTION summary (MOTIR-3541). Deliberately NOT `summarizeDeepen`: the
 * two acts are legal in different statuses and their next steps differ, so the
 * line a caller reads after each has to differ too. A correction on a `planned`
 * plan is the case the whole story exists for, and the summary says what that
 * means — the plan is in front of a reviewer and the change is on its timeline.
 */
function summarizeCorrection(
  plan: PlanWithItemsDto,
  planItemId: string,
  changed: readonly string[],
): string {
  const structural = changed.filter((f) =>
    [
      'parentRef',
      'blockedByRefs',
      'targetRepo',
      'targetRepos',
      'targetRepositories',
      'targetRepositoryRef',
      'targetRepoRole',
      'patch',
    ].includes(f),
  );
  return [
    `Corrected proposal ${planItemId} on plan ${plan.id} — ${plan.status}, ` +
      `${plan.itemCount} proposal(s) in total.`,
    changed.length > 0
      ? `Fields set by this call: ${changed.join(', ')}. Every other field was left as it was.`
      : 'No fields were sent, so nothing changed.',
    structural.length > 0
      ? `Structural fields (${structural.join(', ')}) were re-validated against this plan's own ` +
        'proposals and against the workspace, so every ref you sent resolves — a `MOTIR-<n>` key ' +
        "was stored as the work item's id, exactly as `add_plan_items` stores one."
      : '',
    '',
    plan.status === 'planned'
      ? 'This plan is `planned` — it is in front of a reviewer, and your correction is on its ' +
        'timeline with the harness and model that made it, so they can see what changed after ' +
        'they started reading.'
      : `Still \`generating\` — send \`final: true\` on a last \`${ADD_PLAN_ITEMS_TOOL_NAME}\` ` +
        'batch to put the plan in front of a reviewer.',
    '',
    PROPOSAL_GATE,
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The adapter: resolve the project, open a `generating` plan, stamp the author.
 *
 * `projectsService.getByKey` applies the same browse gate the cookie routes'
 * `getActiveProject` does, so the 404-not-403 cross-tenant contract carries here
 * unchanged (`planSession.ts` documents the same resolution).
 */
export async function runCreatePlan(
  args: CreatePlanArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const projectKey = args.projectKey.trim().toUpperCase();
  const project = await projectsService.getByKey(projectKey, ctx);
  const plan = await plansService.createPlan(
    project.id,
    {
      title: args.title ?? null,
      summary: args.summary ?? null,
      // WHO ASKED (MOTIR-2986) — the TOKEN OWNER. An agent has no standing of
      // its own here: it acts on a credential a person minted and pointed at
      // this project, so that person is the requester, exactly as the person who
      // clicks Generate is on the browser path. Recording it is what stops an
      // agent-authored plan from reading as though nobody is accountable for it.
      createdById: ctx.userId,
      // SERVER-SET. Not an argument, not read from any caller field — the
      // property `materialize` now leans on (ADR Q4).
      authorSource: 'mcp',
      authorHarness: args.plannedWithHarness ?? null,
      authorModel: args.plannedWithModel ?? null,
      // Its own session, of origin `mcp`, owned by the token's user
      // (AMENDMENT 17 §4–§5; MOTIR-6022). The tool's INPUT schema is untouched.
      session: { origin: 'mcp' },
    },
    ctx,
  );
  return toolOk(
    summarizeCreate(plan, projectKey),
    derived(planPayload, presentMcpPlan({ ...plan, items: [] })),
  );
}

/**
 * Stamp one proposal's planning provenance from the plan's own authorship.
 *
 * Applied to every `add`, unconditionally: the tool's argument schema has no
 * `planningProvenance` member, so there is nothing a caller could have set and
 * nothing to preserve. `plansService.addProposals` still honours a provenance
 * the INTERNAL generator route supplies — that path is untouched.
 */
function stampProvenance(proposedFields: ProposedFieldsInput, plan: PlanDto): ProposedFieldsInput {
  return {
    ...proposedFields,
    planningProvenance: {
      source: plan.authorSource ?? 'mcp',
      harness: plan.authorHarness,
      model: plan.authorModel,
    },
  };
}

/**
 * The adapter: append the batch, optionally close the plan, return the ids the
 * caller needs for the next layer.
 *
 * `planItemIds` is the service's own `appendedItemIds` — one id per proposal,
 * in input order, the SURVIVING row's for a merged `modify` (AMENDMENT 18 §2) —
 * taken under the plan's ROW LOCK, so two concurrent appends serialize.
 */
export async function runAddPlanItems(
  args: AddPlanItemsArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  // The REVISION grammar (MOTIR-4153), same layer and same reason as the rule
  // below: two cross-field rules a `ZodRawShape` has nowhere to hang, both about
  // a call that would otherwise do something other than what it says.
  //
  // ⚠️ IT RUNS FIRST, and the order is the rule rather than tidiness. The
  // empty-batch refusal below is written for a `generating` plan and sends its
  // caller to `final: true`; reached by a REVISION it would answer an
  // already-closed plan by telling it to close, which is the one instruction
  // that pairing must never produce. First matching rule wins, so the more
  // specific one goes above.
  //
  //   · `revision` + `final` — `final` CLOSES a plan, and a revision's plan is
  //     already closed. `markPlanned` is deliberately NOT relaxed by AMENDMENT 10
  //     D1 ("a revision does not re-open a plan"), so the composed call would
  //     append and then throw from the close, having already written. Refusing it
  //     here is the difference between a refusal and a half-applied call.
  //   · `revision` + an EMPTY batch — a revision has no close to perform, so an
  //     empty one is the whole call doing nothing. The rule above already refuses
  //     empty-and-not-final, but its message is about `generating` and would send
  //     the caller to `final: true`, which is the one thing this pairing must not
  //     do.
  if (args.revision && args.final) {
    throw new InvalidProposalError(
      '`revision: true` and `final: true` cannot be combined. `final` CLOSES a plan ' +
        '(`generating` → `planned`), and a revision appends to a plan that is ALREADY closed — ' +
        'it stays `planned` before, during and after. Send the batch with `revision: true` ' +
        'alone; there is nothing left to close.',
    );
  }
  if (args.revision && args.proposals.length === 0) {
    throw new InvalidProposalError(
      '`revision: true` with an empty `proposals` array would append nothing to a plan that is ' +
        'already `planned`, and a revision has no close to perform. Send at least one proposal, ' +
        'or use `update_plan_proposal` / `withdraw_plan_proposal` to change what the plan ' +
        'already holds.',
    );
  }

  // The cross-field half of the argument grammar (MOTIR-3193). An EMPTY batch is
  // legal ONLY as a CLOSE; empty with no `final` would do nothing at all, and a
  // call that does nothing is a mistake the caller wants to hear about — a
  // forgotten flag, or a batch mapped from a list that turned out to be empty.
  // It lives here rather than in the zod shape because `registerTool` takes a
  // `ZodRawShape`, which has no place to hang a refinement across two keys.
  if (args.proposals.length === 0 && !args.final) {
    throw new InvalidProposalError(
      '`proposals` is empty and `final` is not set, so this call would append nothing and ' +
        'leave the plan `generating`. Send `final: true` with an empty batch to CLOSE the plan ' +
        '(`generating` → `planned`, the review queue), or send at least one proposal to append.',
    );
  }

  // Read the plan FIRST — its authorship is what each proposal is stamped with,
  // and the read applies the same browse gate every plan path applies (a
  // cross-tenant id 404s rather than 403s).
  const existing = await plansService.getPlan(args.planId, ctx);

  // An edge entry may carry its REASON (MOTIR-9827); `resolveKeyRefs` below
  // splits each `{ ref, reason }` into the bare ref and an `edgeReasons` entry.
  const proposals: ProposalInput[] = args.proposals.map(
    (p) =>
      ({
        op: p.op,
        workItemId: p.workItemId ?? null,
        proposedFields:
          p.op === 'add' && p.proposedFields
            ? stampProvenance(p.proposedFields as ProposedFieldsInput, existing)
            : null,
        patch: (p.patch ?? null) as ProposalInput['patch'],
        parentRef: p.parentRef ?? null,
        blockedByRefs: p.blockedByRefs ?? [],
        ...(p.supersedesRefs !== undefined ? { supersedesRefs: p.supersedesRefs } : {}),
        baseRevision: p.baseRevision ?? null,
        ...(p.reason !== undefined ? { reason: p.reason } : {}),
      }) as ProposalInput,
  );

  // KEY → ID, before the service sees them (MOTIR-3576). The plan substrate's
  // contract is unchanged: what reaches `addProposals`, and what lands in the
  // column, is an id or a `planItem:` temp-ref exactly as before.
  const resolved = await resolveKeyRefs(proposals, ctx);

  // An EMPTY batch still goes through `addProposals`: it creates nothing, and it
  // is what re-reads the plan under its row lock and refuses a plan that has
  // already left `generating` — the same refusal a non-empty close would get.
  //
  // ⚠️ The option is passed through VERBATIM, not derived from the plan this
  // adapter has already read (MOTIR-4153). `existing.status` is a PRE-lock read
  // and the service re-takes the decision under the plan row lock; deriving the
  // flag here would put a second, weaker status predicate in front of the real
  // one — which is exactly the duplication AMENDMENT 10 D1 rejected a second
  // append METHOD to avoid.
  const appended = await plansService.addProposals(args.planId, resolved, ctx, {
    revision: args.revision,
  });
  // The id each proposal ENDED AS, in input order — returned by the service
  // rather than sliced off the end of `items`, because a second `modify` of one
  // card now MERGES into the row the plan already holds (AMENDMENT 18 §2), so a
  // batch no longer adds exactly one row per proposal.
  const planItemIds = appended.appendedItemIds;

  // `final` composes exactly as the internal seam composes it: append, then
  // close. `markPlanned` re-locks and re-reads, so a racing append is refused
  // rather than silently landing on a `planned` plan.
  const plan = args.final
    ? { ...(await plansService.markPlanned(args.planId, ctx)), items: appended.items }
    : appended;

  return toolOk(
    args.proposals.length === 0
      ? summarizeClose(plan)
      : summarizeAppend(plan, planItemIds, args.revision === true) +
          linkWarningsText(appended.warnings) +
          rescopeWarningsText(appended.rescopeWarnings),
    derived(
      planAppendPayload,
      presentMcpPlanAppend(
        { ...plan, warnings: appended.warnings, rescopeWarnings: appended.rescopeWarnings },
        planItemIds,
      ),
    ),
  );
}

/**
 * The adapter: deepen ONE proposal on a `generating` plan.
 *
 * Three things it does and one it deliberately does not:
 *
 * 1. **Rebuild the patch with PRESENCE checks, never defaults.** `'key' in args`
 *    is the whole absent-vs-null contract — `mergeProposedFields` tests each key
 *    `!== undefined`, so a key this adapter invents as `null` CLEARS a field the
 *    caller never mentioned. This is the same shape the shipped review route
 *    (`app/api/plans/[id]/items/[itemId]/route.ts`) uses, for the same reason.
 * 2. **Resolve by `planId`.** `plansService.deepenProposal` takes the plan id
 *    directly; the internal seam's `sourceJobId` lookup is not reusable here
 *    because an MCP-authored plan has no generation job (module header).
 * 3. **Report which fields the CALL set** — see {@link summarizeDeepen}.
 *
 * It does NOT pre-read the plan. `add_plan_items` does, because it stamps each
 * `add`'s provenance from the plan's own authorship; a deepen stamps nothing, and
 * `editAddProposal` resolves, gates (`ai:view_plan`), locks and re-reads the plan
 * itself. A read here would add a round trip and a second, weaker existence check
 * in front of the real one.
 */
export async function runUpdatePlanItem(
  args: UpdatePlanItemArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const patchable = [
    'title',
    'kind',
    'descriptionMd',
    'sections',
    'explanationMd',
    'type',
    'priority',
    'executor',
    'storyPoints',
    'estimateMinutes',
    'difficulty',
    'todos',
  ] as const satisfies readonly UpdateProposalKey[];

  const input: UpdateProposalInput = {};
  const changed: string[] = [];
  for (const key of patchable) {
    // PRESENCE, then a belt-and-braces `undefined` skip. `mergeProposedFields`
    // tests each key `!== undefined`, so an `undefined` that slipped through
    // would merge as absent anyway — but it would still be COUNTED as changed,
    // and the summary would tell a reader this call touched a field it did not.
    // (`undefined` cannot arrive over JSON; this survives a zod version that
    // materializes missing optional keys.)
    if (!(key in args) || args[key] === undefined) continue;
    // The value is already narrowed by the zod schema to the member's own type;
    // the assignment is per-key so no `any` widens the input.
    (input as Record<string, unknown>)[key] = args[key];
    changed.push(key);
  }

  // ⚠️ The flag is passed through as the CHOICE of service method, not derived
  // from a status this adapter never read — the same reason `add_plan_items`
  // hands `revision` through verbatim (AMENDMENT 12): the service re-takes the
  // status decision under the plan row lock.
  const plan = args.revision
    ? await plansService.reviseProposal(args.planId, args.planItemId, input, ctx)
    : await plansService.deepenProposal(args.planId, args.planItemId, input, ctx);

  return toolOk(
    summarizeDeepen(plan, args.planItemId, changed, args.revision === true) +
      linkWarningsText(plan.warnings) +
      rescopeWarningsText(plan.rescopeWarnings),
    derived(planPayload, presentMcpPlan(plan)),
  );
}

/**
 * CORRECT a proposal on a `generating` or `planned` plan (MOTIR-3541) — a
 * transport over `plansService.correctProposal`, adding no logic of its own.
 *
 * The key gap between this and `runUpdatePlanItem` is the patchable list: it
 * carries the four STRUCTURAL members AMENDMENT 8 opened, and the same
 * presence-then-`undefined` discipline applies to every one of them so the
 * summary cannot claim a field this call did not touch.
 */
export async function runUpdatePlanProposal(
  args: UpdatePlanProposalArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const patchable = [
    'title',
    'kind',
    'descriptionMd',
    'sections',
    'explanationMd',
    'type',
    'priority',
    'executor',
    'storyPoints',
    'estimateMinutes',
    'difficulty',
    'todos',
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
  ] as const satisfies readonly CorrectProposalKey[];

  const input: CorrectProposalInput = {};
  const changed: string[] = [];
  for (const key of patchable) {
    if (!(key in args) || args[key] === undefined) continue;
    (input as Record<string, unknown>)[key] = args[key];
    changed.push(key);
  }

  // KEY → ID, before the service sees them (MOTIR-3934) — the same rewrite
  // `add_plan_items` applies, at the same layer, so the two doors cannot store
  // different things in one column. A key that names nothing is refused HERE,
  // where it is written, rather than at the approve button on a plan a reviewer
  // has already read.
  const resolved = await resolveCorrectionKeyRefs(input, ctx);

  const plan = await plansService.correctProposal(args.planId, args.planItemId, resolved, ctx);

  return toolOk(
    summarizeCorrection(plan, args.planItemId, changed) +
      linkWarningsText(plan.warnings) +
      rescopeWarningsText(plan.rescopeWarnings),
    derived(planPayload, presentMcpPlan(plan)),
  );
}

/**
 * WITHDRAW a proposal from a `generating` or `planned` plan (MOTIR-3541) — a
 * transport over `plansService.withdrawProposal`.
 */
export async function runWithdrawPlanProposal(
  args: WithdrawPlanProposalArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const plan = await plansService.withdrawProposal(args.planId, args.planItemId, ctx);

  // ⚠️ THE LAST WITHDRAWAL ENDS THE PLAN (MOTIR-4146), and the note has to SAY
  // so. "0 proposals left on the plan" is true and reads as *the plan is still
  // open and empty* — which is the state this fix removed. The status rides the
  // structured payload either way; an agent reading the prose gets it here.
  const ended = plan.status === 'declined';

  return toolOk(
    `Withdrew proposal ${args.planItemId} from plan ${plan.id}${attribution(plan)}. ` +
      (ended
        ? 'That was its last proposal, so the plan is now `declined` (`discarded`) — a plan proposing nothing is not something a person can be asked to decide. Open a new plan to propose again. '
        : `${plan.items.length} proposal${plan.items.length === 1 ? '' : 's'} left on the plan. `) +
      PROPOSAL_GATE,
    derived(planPayload, presentMcpPlan(plan)),
  );
}

/**
 * The BRIEF-correction summary (MOTIR-4637). Its own function for the same
 * reason `summarizeCorrection` is not `summarizeDeepen`: what a caller should do
 * next differs, and on a `planned` plan the thing that changed is the sentence a
 * reviewer is reading right now.
 */
function summarizeBriefCorrection(plan: PlanWithItemsDto, changed: readonly string[]): string {
  // The planner's record is no part of the heading, and its write is on no timeline (MOTIR-9978).
  const onTimeline = changed.some((key) => key !== 'plannerRecord');
  return [
    `Corrected plan ${plan.id}'s own ${changed.join(' and ')} — ${plan.status}, ` +
      `${plan.itemCount} proposal(s), every one of them untouched.`,
    !onTimeline
      ? 'Only your planner record changed: no reviewer sees it, and nothing was added to the ' +
        'plan’s timeline.'
      : plan.status === 'planned'
        ? 'This plan is `planned` — it is in front of a reviewer, and this edit is on its ' +
          'timeline with the harness and model that made it, so they can see the heading changed ' +
          'after they started reading.'
        : `Still \`generating\` — send \`final: true\` on a last \`${ADD_PLAN_ITEMS_TOOL_NAME}\` ` +
          'batch to put the plan in front of a reviewer.',
    '',
    PROPOSAL_GATE,
  ].join('\n');
}

/**
 * CORRECT the plan's own `title` / `summary` on a `generating` or `planned` plan
 * (MOTIR-4637) — a transport over `plansService.correctPlanBrief`, adding no
 * logic of its own.
 *
 * The presence-then-`undefined` discipline is its siblings': the summary may not
 * claim a field this call did not send, and `null` is a VALUE here (it clears)
 * rather than an absence.
 */
export async function runUpdatePlan(
  args: UpdatePlanArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const patchable = [
    'title',
    'summary',
    'plannerRecord',
  ] as const satisfies readonly CorrectPlanBriefKey[];

  const input: CorrectPlanBriefInput = {};
  const changed: string[] = [];
  for (const key of patchable) {
    if (!(key in args) || args[key] === undefined) continue;
    (input as Record<string, unknown>)[key] = args[key];
    changed.push(key);
  }

  const plan = await plansService.correctPlanBrief(args.planId, input, ctx);
  const plannerRecord = await plansService.getPlannerRecord(args.planId, ctx);

  return toolOk(
    summarizeBriefCorrection(plan, changed),
    derived(planPayload, { ...presentMcpPlan(plan), plannerRecord }),
  );
}

/**
 * RECORD the reason a re-plan was asked of an unapproved plan (Story MOTIR-5543
 * · MOTIR-6086) — a transport over
 * `plansService.recordRevisionClassification`, adding no logic of its own.
 *
 * It returns the EVENT, not the plan: nothing about the plan changed, so handing
 * back a whole `PlanWithItemsDto` would invite a reader to diff it for a
 * difference that is not there.
 */
export async function runRecordPlanRevisionReason(
  args: RecordPlanRevisionReasonArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const recorded = await plansService.recordRevisionClassification(
    {
      planId: args.planId,
      branch: args.branch,
      evidenceMd: args.evidenceMd,
      planningBugKey: args.planningBugKey ?? null,
    },
    ctx,
  );

  const filed = recorded.planningBugKey
    ? `Planning bug ${recorded.planningBugKey} is recorded against it.`
    : 'No planning bug: this branch is about what the person wants, not about the planner — ' +
      'and the judgement is ON THE RECORD, so it can be told from a forgotten one.';

  return toolOk(
    `Recorded \`${recorded.branch}\` on plan ${args.planId}. ${filed}\n\n` +
      'This is INTERNAL — Motir’s own record of why the plan had to change. No tenant-facing ' +
      'read returns it, and nothing about the plan itself changed: correct the plan with the ' +
      `correction doors (\`${UPDATE_PLAN_PROPOSAL_TOOL_NAME}\`, ` +
      `\`${WITHDRAW_PLAN_PROPOSAL_TOOL_NAME}\`, \`${UPDATE_PLAN_TOOL_NAME}\`, or ` +
      `\`${ADD_PLAN_ITEMS_TOOL_NAME}\` with \`revision: true\`) as a separate act.`,
    exempt(RECORD_PLAN_REVISION_REASON_TOOL_NAME, {
      kind: REASON_CLASSIFIED_KIND,
      revisionId: recorded.revisionId,
      planId: args.planId,
      branch: recorded.branch,
      planningBugKey: recorded.planningBugKey,
      // ⚠️ THE ROW'S OWN TIME, NOT THIS CALL'S. `recordRevisionClassification`
      // returns `at` from the written row precisely so this door does not have
      // to guess; `new Date()` here would report the moment the tool was ASKED,
      // which drifts from the moment the row exists at by however long the
      // transaction took. `planRevisionsService.recordRevision` returns the row
      // instead of its id for this one reason.
      at: recorded.at,
    }),
  );
}

/**
 * `report_plan_step` → ONE service call per the step: `recordPlanStep` for
 * `settle` / `lay` / `author`, `endPlanStep` for `end` (MOTIR-7824).
 *
 * The only work of its own is translating a KEY-form target to its id, because
 * every other plan door accepts a key and the store takes ids only. A key that
 * names nothing is the store's own refusal, `PLAN_STEP_INVALID`, so an emitter
 * matches one code for "this target is wrong" whichever spelling it sent.
 *
 * `startedAt` is the STORED row's, never this call's clock.
 */
export async function runReportPlanStep(
  args: ReportPlanStepArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  let targetRef: string | null = args.target ?? null;
  if (targetRef !== null && isWorkItemKey(targetRef)) {
    try {
      [targetRef] = (await resolveWorkItemIdsByKeys([targetRef], ctx)) as [string];
    } catch {
      throw new InvalidPlanStepError(
        `\`${args.target}\` names no work item in this workspace — check the key, or pass a ` +
          '`planItem:<id>` ref.',
      );
    }
  }

  const result = await plansService.reportPlanStep(
    args.planId,
    {
      sessionKey: args.sessionKey,
      targetRef,
      ...(args.step !== undefined ? { step: args.step } : {}),
      ...(args.narration !== undefined ? { narration: args.narration } : {}),
    },
    ctx,
  );
  if (result.kind === 'narration') {
    const n = result.narration.length;
    const payload = exempt(REPORT_PLAN_STEP_TOOL_NAME, {
      planId: args.planId,
      sessionKey: args.sessionKey,
      narration: result.narration.map((row) => ({ seq: row.seq, body: row.body })),
    });
    return toolOk(
      `Recorded ${n} narration sentence${n === 1 ? '' : 's'} for session ` +
        `\`${args.sessionKey}\` on plan ${args.planId}.`,
      payload,
    );
  }
  const stored = result.kind === 'step' ? result.step : null;
  const payload = exempt(REPORT_PLAN_STEP_TOOL_NAME, {
    planId: args.planId,
    sessionKey: stored?.sessionKey ?? args.sessionKey,
    step: args.step ?? null,
    targetRef: stored?.targetRef ?? null,
    startedAt: stored?.startedAt ?? null,
  });
  if (!stored) {
    return toolOk(`Cleared session \`${args.sessionKey}\`'s step on plan ${args.planId}.`, payload);
  }
  const on = stored.targetRef ? ` on \`${stored.targetRef}\`` : '';
  return toolOk(
    `Recorded \`${stored.kind}\`${on} for session \`${stored.sessionKey}\` on plan ` +
      `${args.planId}. Send \`step: 'end'\` under the same \`sessionKey\` when the session ` +
      'finishes.',
    payload,
  );
}

// `hold_plan_revision` (Bug MOTIR-7988) — the MCP planner's door onto the plan's
// REVISION LEASE, the hold the hosted revision has always taken through the in-app
// route (`aiPlanEditsService`) and an MCP-driven one could not take at all.
//
// Without it a `planned` plan revised over MCP (`prompts/plan.py --revise`) was a
// plain decidable question for the whole rewrite: listed in Waiting on you with a
// live Approve, so a press mid-revision materialized a proposal set that was
// neither the plan the reviewer read nor the one they asked for. Held, it leaves
// Waiting on you for Planning, and Approve / Decline are refused with
// `PLAN_REVISION_IN_FLIGHT` until the revision ends.
//
// ONE tool with three actions, the shape `report_plan_step` chose and for the same
// reason: one emitter, one call shape. `start` takes the lease (refused while
// another revision holds it, or once the plan is decided), `renew` is the heartbeat
// that keeps it while the planner thinks between writes (`renewed: false`, writing
// nothing, when it has already lapsed — take it again with `start`), and `end`
// releases it however the revision ended (idempotent).
//
// Same grant as the other authoring doors, `ai:view_plan`, which the service
// asserts on the plan's project first.
const HOLD_PLAN_REVISION_ACTIONS = ['start', 'renew', 'end'] as const;
type HoldPlanRevisionAction = (typeof HOLD_PLAN_REVISION_ACTIONS)[number];

const holdPlanRevisionInputSchema = {
  planId: z.string().trim().min(1).describe('The id of the plan you are revising.'),
  action: z
    .enum(HOLD_PLAN_REVISION_ACTIONS)
    .describe(
      "`start` before the revision's first write, `renew` every few minutes while it runs, " +
        'and `end` when it finishes, however it finishes.',
    ),
  harness: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'The agent harness you are running in, as its makers name it (e.g. "Claude Code") — ' +
        'what a refused Approve names as holding the plan.',
    ),
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('The model you are running on, by its id. Omit it when you do not know it.'),
};

interface HoldPlanRevisionArgs {
  planId: string;
  action: HoldPlanRevisionAction;
  harness?: string;
  model?: string;
}

/**
 * `hold_plan_revision` → ONE service call per action: `acquireRevisionLease` for
 * `start`, `renewRevisionLease` for `renew`, `closeRevision` for `end`.
 * The actor is the MCP agent itself, so the trail and a refused decision name it.
 */
export async function runHoldPlanRevision(
  args: HoldPlanRevisionArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const actor = {
    source: 'mcp' as const,
    harness: args.harness ?? null,
    model: args.model ?? null,
  };
  if (args.action === 'start') {
    const lease = await plansService.acquireRevisionLease(args.planId, ctx, actor);
    return toolOk(
      `Plan ${args.planId} is held for your revision until ${lease.expiresAt.toISOString()}: it ` +
        'is listed under Planning, and Approve / Decline are refused until you end it. Every ' +
        "write you make extends the hold; send `action: 'renew'` if you will go longer than a " +
        "few minutes without one, and `action: 'end'` when the revision finishes, however it " +
        'finishes.',
      exempt(HOLD_PLAN_REVISION_TOOL_NAME, {
        planId: args.planId,
        action: args.action,
        held: true,
        expiresAt: lease.expiresAt.toISOString(),
      }),
    );
  }
  if (args.action === 'renew') {
    const renewed = await plansService.renewRevisionLease(args.planId, ctx, actor);
    return toolOk(
      renewed.renewed
        ? `Renewed the hold on plan ${args.planId} until ${renewed.expiresAt!.toISOString()}.`
        : `Plan ${args.planId} is NOT held — the hold lapsed or was ended, and nothing was ` +
            "written. Take it again with `action: 'start'` before your next write.",
      exempt(HOLD_PLAN_REVISION_TOOL_NAME, {
        planId: args.planId,
        action: args.action,
        held: renewed.renewed,
        expiresAt: renewed.expiresAt?.toISOString() ?? null,
      }),
    );
  }
  // The END closes the plan the revision re-opened (Bug MOTIR-8208) — through the
  // same close a generation takes — and then gives the lease back.
  const released = await plansService.closeRevision(args.planId, ctx, actor, {
    trailDiff: { via: HOLD_PLAN_REVISION_TOOL_NAME },
  });
  return toolOk(
    released.status === 'declined'
      ? `Ended the revision of plan ${args.planId}: it holds no proposals, so it was discarded ` +
          'rather than put in front of a reviewer.'
      : released.released
        ? `Released plan ${args.planId}: it is back in Waiting on you and can be decided.`
        : `Plan ${args.planId} was not held; nothing was written.`,
    exempt(HOLD_PLAN_REVISION_TOOL_NAME, {
      planId: args.planId,
      action: args.action,
      held: false,
      expiresAt: null,
    }),
  );
}

export function registerAuthorPlan(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    CREATE_PLAN_TOOL_NAME,
    {
      title: 'Open a plan to propose into',
      description:
        'Open a PLAN on a project — the reviewable container you then fill with proposals ' +
        `using \`${ADD_PLAN_ITEMS_TOOL_NAME}\`. This is how an agent proposes work in Motir ` +
        'instead of writing it: `create_work_item` puts a real item in the tree immediately, ' +
        'whereas a plan is read, diffed and APPROVED by a person first. Reach for this one ' +
        'when you have decomposed work yourself and want somebody to sign off on the shape ' +
        'before it becomes real. Pass `plannedWithHarness` / `plannedWithModel` to say who ' +
        'is writing it — the reviewer sees that, and every work item the plan eventually ' +
        'creates records it too. ' +
        'IMPORTANT: this creates NO work item. Approving the plan in Motir is the only path ' +
        'from a proposal to a work item, and approval does not happen on this surface. Costs ' +
        'nothing and starts no job — no AI credits are spent.',
      inputSchema: createPlanInputSchema,
    },
    async (args, extra) => {
      try {
        return await runCreatePlan(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    ADD_PLAN_ITEMS_TOOL_NAME,
    {
      title: 'Append proposals to a plan',
      description:
        'Append a batch of proposals — `add` a new item, `modify` an existing one, `remove` ' +
        'one — to a plan you opened with ' +
        `\`${CREATE_PLAN_TOOL_NAME}\`. Returns \`planItemIds\`: the ids of the proposals THIS ` +
        'call created, IN THE ORDER YOU SENT THEM. That order is the contract you build a ' +
        'tree with: pass `planItem:<id>` as a later proposal’s `parentRef` or ' +
        '`blockedByRefs` entry to hang it under one of these, before any of them exists as a ' +
        'work item. So send a tree LAYER BY LAYER, parents before children, and set ' +
        '`final: true` on the last batch — that closes the plan (`generating` → `planned`) ' +
        'and puts it in the review queue. Appending to an already-closed plan is refused ' +
        'UNLESS the call carries `revision: true`: a REVISION appends to a `planned` plan ' +
        'where it stands — the plan does not re-open, and the append is recorded on its ' +
        'timeline with the harness and model that made it, so the reviewer sees that a card ' +
        'arrived after they started reading. That is the door to reach when a correction needs ' +
        'a card that is not there; `update_plan_proposal` and `withdraw_plan_proposal` change ' +
        'and remove what the plan already holds. `approved` and `declined` stay frozen. ' +
        'A TITLES-FIRST pass — append the shape, then fill each card in with ' +
        `\`${UPDATE_PLAN_ITEM_TOOL_NAME}\` — has nothing left to append when it is done, so ` +
        'CLOSE it by calling this with `proposals: []` and `final: true`. An empty batch is ' +
        'legal only that way: without `final` it would do nothing, and is refused. ' +
        'IMPORTANT: this creates NO work item. Approving the plan in Motir is the only path ' +
        'from a proposal to a work item, and approval does not happen on this surface — do ' +
        'not report proposed work as created. Costs nothing and starts no job. ' +
        'ONE PROPOSAL PER EXISTING TARGET: a plan holds at most one `modify` or ' +
        '`remove` for any given `workItemId`. A second `modify` of a card this plan ' +
        'already modifies — in a later call or in the same batch — MERGES into that ' +
        'one proposal: each patch key takes the later value (an explicit `null` still ' +
        'clears), `blockedByAdd` / `blockedByRemove` are unioned (a ref in both ' +
        'cancels), the first proposal’s `baseRevision` is kept, and `planItemIds` ' +
        'returns the SURVIVING proposal’s id at that position. A `modify` and a ' +
        '`remove` of one card, or two `remove`s, are still refused with ' +
        '`DUPLICATE_PLAN_TARGET` naming the item — withdraw the first ' +
        '(`withdraw_plan_proposal`) to change your mind. And when what you are ' +
        'recording is a dependency edge between two work items that ALREADY exist, ' +
        'use `link_work_items` instead — an edge between committed items needs no ' +
        'proposal at all. ' +
        'MARKING A CARD: a `modify` patch may carry the OBSOLESCENCE mark (`obsolescence`: ' +
        '"outdated" / "deprecated", `obsolescenceNoteMd`) and `supersedes` edges ' +
        '(`supersedesAdd` / `supersedesRemove` on the NEWER card, `supersededByAdd` / ' +
        '`supersededByRemove` on the OLD card); an `add` may carry `supersedesRefs`, the older ' +
        'cards it replaces. A key, an id or an earlier call’s `planItem:` ref works on all five; ' +
        'the four patch lists union on a merge like the blocker lists. A plan may set a mark ' +
        'only on a FINISHED (done-category) card — on a to-do or in-progress card it is refused ' +
        'INVALID_PROPOSAL ("a plan may mark only a finished work item; <KEY> is at <status>. A ' +
        "work item nobody will finish is removed — send `{ op: 'remove', workItemId, reason " +
        '}` instead."), because unfinished work nobody will do is REMOVED, not marked. A ' +
        'MARK-ONLY `modify` (only those six keys) is the one change legal on a `done` / ' +
        '`cancelled` card. A `remove` never marks anything.',
      inputSchema: addPlanItemsInputSchema,
    },
    async (args, extra) => {
      try {
        return await runAddPlanItems(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    UPDATE_PLAN_ITEM_TOOL_NAME,
    {
      title: 'Deepen a proposal you appended',
      description:
        'Fill in a proposal you already appended to a plan that is still being written — the ' +
        'SECOND phase of a titles-first author. Phase one: append title-only proposals with ' +
        `\`${ADD_PLAN_ITEMS_TOOL_NAME}\` so the SHAPE of the tree is settled and its parent / ` +
        'dependency edges are wired. Phase two: call this once per proposal to write its ' +
        'description and explanation, its work type, priority, executor and sizing — now that ' +
        'you can see every sibling you proposed. The patch is SPARSE: a field you omit is left ' +
        'exactly as it was, and an explicit `null` clears it. Address the proposal by the id ' +
        `\`${ADD_PLAN_ITEMS_TOOL_NAME}\` returned for it in \`planItemIds\`. While the plan ` +
        'is `generating` it just works. Once you send `final: true` it is in front of a ' +
        'reviewer, and an edit is refused UNLESS it carries `revision: true`: a REVISION ' +
        'rewrites the card where it stands — same id, same edges — keeps the plan `planned`, ' +
        'and is recorded on its timeline with the harness and model that made it. That is the ' +
        'door for correcting what a card SAYS on a landed plan; never withdraw a card and ' +
        'append a copy to change its words. `approved` and `declined` stay frozen. It cannot ' +
        're-parent a proposal, change its dependency edges or re-pin its repo: those are the ' +
        'shape you settled in phase one. ' +
        'IMPORTANT: this creates NO work item and changes nothing in the tree. Approving the ' +
        'plan in Motir is the only path from a proposal to a work item, and approval does not ' +
        'happen on this surface. Costs nothing and starts no job.',
      inputSchema: updatePlanItemInputSchema,
    },
    async (args, extra) => {
      try {
        return await runUpdatePlanItem(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    UPDATE_PLAN_PROPOSAL_TOOL_NAME,
    {
      title: 'Correct a proposal, including its structure',
      description:
        'Correct a proposal you already appended — the repair for a mistake you can see but ' +
        `could not fix. Unlike \`${UPDATE_PLAN_ITEM_TOOL_NAME}\`, this reaches the STRUCTURAL ` +
        'fields: `parentRef`, `blockedByRefs`, the repository axis (`targetRepo`, ' +
        '`targetRepos`, `targetRepositories`, the singular row pin `targetRepositoryRef`, ' +
        '`targetRepoRole`), and a `modify` ' +
        'proposal’s `patch` — which is where a mistyped dependency edge usually sits. Legal ' +
        'while the plan is ' +
        '`generating` AND after you have closed it with `final: true`, while it is `planned` ' +
        'and waiting for a reviewer. It is REFUSED once the plan is `approved` (its proposals ' +
        'have become work items, so `update_work_item` is the door — the refusal says so) or ' +
        '`declined` (a closed decision). The patch is SPARSE: a field you omit is left exactly ' +
        'as it was and an explicit `null` clears it — EXCEPT `blockedByRefs` and an `add`’s ' +
        '`supersedesRefs`, which are lists and REPLACE the set, so send the edges you want and ' +
        '`[]` to clear them. A `modify`’s obsolescence mark, its note and its four supersedes ' +
        'lists are corrected by replacing its `patch`; a replacement that SETS a mark on a card ' +
        'that is not finished is refused INVALID_PROPOSAL ("a plan may mark only a finished ' +
        'work item; <KEY> is at <status>. A work item nobody will finish is removed — send ' +
        "`{ op: 'remove', workItemId, reason }` instead.\"). Every " +
        'structural correction re-runs the append’s own ref check, so you cannot correct your ' +
        'way into a `planItem:` ref that names nothing, and a ref to the proposal itself is ' +
        'refused rather than stored. The correction appears on the plan’s timeline with the ' +
        'harness and model that made it, so a reviewer can see the tree changed under them. ' +
        'IMPORTANT: this creates NO work item and changes nothing in the tree. Approving the ' +
        'plan in Motir is the only path from a proposal to a work item, and approval does not ' +
        'happen on this surface. Costs nothing and starts no job.',
      inputSchema: updatePlanProposalInputSchema,
    },
    async (args, extra) => {
      try {
        return await runUpdatePlanProposal(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    WITHDRAW_PLAN_PROPOSAL_TOOL_NAME,
    {
      title: 'Take a proposal off a plan',
      description:
        'Remove one proposal from a plan you are writing, or one you have already closed for ' +
        'review — so a proposal you should not have appended does not have to be declined by a ' +
        'person along with everything around it. Legal while the plan is `generating` or ' +
        '`planned`; REFUSED once it is `approved` (its proposals have become work items — ' +
        'archive the work item instead) or `declined`. If another proposal on the plan still ' +
        'references this one through a `planItem:` ref, the call is REFUSED and names every ' +
        'referrer rather than leaving their refs pointing at nothing: correct or withdraw ' +
        'those first, then retry. Withdrawing a `modify` RELEASES its target work item, so you ' +
        'can append a corrected `modify` for that item where a second one was previously ' +
        'refused as a duplicate target. Withdrawing the LAST proposal of a `planned` plan ENDS ' +
        'that plan — it becomes `declined` with reason `discarded`, because a plan proposing ' +
        'nothing is not something a person can be asked to decide; open a new plan to propose ' +
        'again. On a `generating` plan it does not, since that pass has not finished writing. ' +
        'This is NOT the `remove` op, which PROPOSES deleting an ' +
        'existing work item from the tree at approve — this takes a proposal off the plan and ' +
        'nothing in the tree is touched either way. Costs nothing and starts no job.',
      inputSchema: withdrawPlanProposalInputSchema,
    },
    async (args, extra) => {
      try {
        return await runWithdrawPlanProposal(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    UPDATE_PLAN_TOOL_NAME,
    {
      title: "Correct a plan's own title and summary",
      description:
        'Correct the PLAN’S OWN title and summary — the heading a reviewer reads ABOVE the ' +
        'tree, before any card. This touches NO proposal: ' +
        `\`${UPDATE_PLAN_PROPOSAL_TOOL_NAME}\` is the door onto one of those, and this is the ` +
        'door onto the two fields `create_plan` writes once and nothing could reach afterwards. ' +
        'Reach for it when the summary says something that turned out to be wrong — a premise ' +
        'that was falsified, a decision that moved, a disposition you now have to restate — ' +
        'instead of withdrawing every proposal to rebuild the plan under a new id. The patch is ' +
        'SPARSE: a field you omit is left exactly as it was and an explicit `null` clears it, ' +
        'so send only what you are changing; a call sending none of them is refused. It also ' +
        'holds `plannerRecord`, YOUR machine state on the plan, which no reviewer sees and which ' +
        'puts nothing on the timeline. Legal while the ' +
        'plan is `generating` AND after you have closed it with `final: true`, while it is ' +
        '`planned` and waiting for a reviewer. It is REFUSED once the plan is `approved` (its ' +
        'proposals have become work items and the plan is the record of what was approved) or ' +
        '`declined` (a closed decision), and the refusal names the status. It changes NOTHING ' +
        'else: the plan keeps every proposal it had, its status, its planned-at time and its ' +
        'staleness flags. The edit appears on the plan’s timeline with the harness and model ' +
        'that made it, so a reviewer can see the heading changed under them. ' +
        'IMPORTANT: this creates NO work item and changes nothing in the tree. Approving the ' +
        'plan in Motir is the only path from a proposal to a work item, and approval does not ' +
        'happen on this surface. Costs nothing and starts no job.',
      inputSchema: updatePlanInputSchema,
    },
    async (args, extra) => {
      try {
        return await runUpdatePlan(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    RECORD_PLAN_REVISION_REASON_TOOL_NAME,
    {
      title: 'Record WHY a plan had to change',
      description:
        'Record WHY a change was asked of a plan that is NOT YET APPROVED — once per request, ' +
        'BEFORE you correct anything. Four branches, and only two of them are about the ' +
        'planner: `new_ask` (they now want something the conversation never raised) and ' +
        '`different_solution` (the plan answered what was asked and they prefer another ' +
        'answer) file NO planning bug; `rule_gap` (the plan missed a check and no planning ' +
        'rule asks for it) and `rule_not_followed` (a rule requires the check and this pass ' +
        'did not apply it) each file exactly ONE — create it first with `create_work_item` ' +
        'into the project’s `Planning bugs` folder and pass its key as `planningBugKey`. ' +
        'CHOOSING BETWEEN THE TWO RULE BRANCHES, AND RULING BOTH OUT, IS A SEARCH AND NOT A ' +
        'JUDGEMENT: search the planning rules and the lesson store for the check that was ' +
        'missed and quote what came back in `evidenceMd`, because a gap asserted without that ' +
        'search is an unverified negative. Call it on EVERY branch, including the two that ' +
        'file nothing — a silent "no bug" cannot be told from a forgotten one, and that is the ' +
        'whole reason this tool exists rather than you simply filing fewer bugs. Legal while ' +
        'the plan is `generating` or `planned`; REFUSED once it is `approved` or `declined`, ' +
        'naming the status. IT CHANGES NOTHING about the plan — not a proposal, not the ' +
        `heading, not the status: correct the plan with \`${UPDATE_PLAN_PROPOSAL_TOOL_NAME}\`, ` +
        `\`${WITHDRAW_PLAN_PROPOSAL_TOOL_NAME}\`, \`${UPDATE_PLAN_TOOL_NAME}\` or ` +
        `\`${ADD_PLAN_ITEMS_TOOL_NAME}\` with \`revision: true\` as a separate act. The record ` +
        'is INTERNAL to Motir and no read returns it. The RULE that decides which branch ' +
        'applies lives in the planning corpus, not in this description. Costs nothing and ' +
        'starts no job.',
      inputSchema: recordPlanRevisionReasonInputSchema,
    },
    async (args, extra) => {
      try {
        return await runRecordPlanRevisionReason(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    REPORT_PLAN_STEP_TOOL_NAME,
    {
      title: 'Report the step a planner session is on',
      description:
        'Say which step a planner SESSION is on while you write a plan, so a person following ' +
        'it sees what is being drafted right now and can tell a working plan from a stalled ' +
        'one. Call it as each session OPENS a step — `settle` while settling the brief, `lay` ' +
        'while laying the children of `target`, `author` while writing `target` — and with ' +
        "`step: 'end'` under the same `sessionKey` as the session closes, however it closes. " +
        'A second report under one `sessionKey` replaces that session’s step; `end` on a ' +
        'session with no step is a no-op success. Leave `target` OUT on `lay` for the ' +
        'project’s top level and on `author` for an item that is not on the plan yet; ' +
        '`target` is otherwise a `planItem:<id>` ref naming an `add` on this plan, or a ' +
        'committed work item by key or id. The server sets the time. Legal only while the ' +
        'plan is `generating`: once it is `planned`, `approved` or `declined` the call is ' +
        'refused with PLAN_NOT_GENERATING and nothing changes. Between steps, send ' +
        '`narration` (instead of `step`) with a few plain sentences on what the session is ' +
        'doing and why: a person reads them in the plan’s chat panel, and they are kept. ' +
        'IT IS ADVISORY: every refusal ' +
        'comes back as a code and a sentence, and a refused report should NOT stop you ' +
        'planning — carry on with the plan. It changes nothing about the plan’s proposals. ' +
        `Same grant as \`${ADD_PLAN_ITEMS_TOOL_NAME}\`. Costs nothing and starts no job.`,
      inputSchema: reportPlanStepInputSchema,
    },
    async (args, extra) => {
      try {
        return await runReportPlanStep(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    HOLD_PLAN_REVISION_TOOL_NAME,
    {
      title: 'Hold a plan while you revise it',
      description:
        'Hold a plan that is already up for review (`planned`) while you REVISE it, so nobody ' +
        "approves a half-rewritten plan. Call it with `action: 'start'` BEFORE the first " +
        `\`revision: true\` write (\`${ADD_PLAN_ITEMS_TOOL_NAME}\`, \`${UPDATE_PLAN_ITEM_TOOL_NAME}\`), ` +
        `\`${UPDATE_PLAN_PROPOSAL_TOOL_NAME}\` or \`${WITHDRAW_PLAN_PROPOSAL_TOOL_NAME}\`, and with ` +
        "`action: 'end'` when the revision finishes — however it finishes, including on a " +
        'failure. `start` RE-OPENS the plan (`planned` → `generating`), so your steps and notes ' +
        '(`report_plan_step`) land on it, and `end` closes it again through the same check a ' +
        'finished generation passes (it comes back `planned`, or is discarded if it holds no ' +
        'proposals). While held the plan is listed under Planning instead of Waiting on you, and ' +
        'Approve and Decline are refused with PLAN_REVISION_IN_FLIGHT. The hold lasts ten ' +
        'minutes from your latest write to the plan; if you may go longer than that without ' +
        "one, send `action: 'renew'` every few minutes. A renew on a hold that already lapsed " +
        "writes nothing and says so (`held: false`) — take it again with `action: 'start'`. " +
        '`start` is REFUSED with PLAN_REVISION_IN_FLIGHT while another revision holds the plan, ' +
        'and with PLAN_NOT_EDITABLE once it is approved or declined. `end` on a plan nobody ' +
        'holds is a no-op success. A revision that dies without `end` is given back to `planned` ' +
        'once the hold runs out. It changes nothing about the plan’s proposals. Same grant as ' +
        `\`${ADD_PLAN_ITEMS_TOOL_NAME}\`. Costs nothing and starts no job.`,
      inputSchema: holdPlanRevisionInputSchema,
    },
    async (args, extra) => {
      try {
        return await runHoldPlanRevision(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}

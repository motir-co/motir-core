import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod/v4';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import { WORK_ITEM_DIFFICULTIES } from '@/lib/issues/difficulty';
import { WORK_ITEM_OBSOLESCENCES } from '@/lib/issues/obsolescence';
import { locales } from '@/lib/i18n/locales';
import type {
  ExecutorDto,
  IssueDetailDto,
  WorkItemImplementationSourceDto,
  WorkItemKindDto,
  WorkItemDependencyEdgesDto,
  WorkItemDifficultyDto,
  WorkItemObsolescenceDto,
  WorkItemPlanningSourceDto,
  WorkItemPriorityDto,
  WorkItemSummaryDto,
  WorkItemTypeDto,
} from '@/lib/dto/workItems';
import type { LinkedPullRequestDto, WorkItemDeliveryDto } from '@/lib/dto/github';
import type {
  ApprovalGateAuthorityDTO,
  ApprovalGateDecisionDTO,
  ApprovalGateDecisionSourceDTO,
  ApprovalGateKindDTO,
  ApprovalGateRecordDTO,
  ApprovalGateRefusalVerdictDTO,
  ApprovalGateStateDTO,
  ApprovalGateSupersedeCauseDTO,
} from '@/lib/dto/approvalGate';

// The v1 WORK-ITEM resource, declared once (Story 11.2 · Subtask 11.2.2 —
// MOTIR-2040). Every sibling endpoint — list, detail, create, update,
// transition, archive, links — returns a shape defined HERE.
//
// ── A v1 response is a SCHEMA's output, never a service DTO ──────────────────
// Pinned by the ADR's Amendment 2. `IssueDetailDto` / `WorkItemListItemDto` are
// the web app's internal shapes and change whenever a page needs them to; ADR §8's
// additive-only promise cannot ride something nobody promised to keep still. The
// mappers below are that seam, and they shape FIELD BY FIELD — never a spread.
// `app/api/v1/me/route.ts` already refuses to spread a Prisma row for exactly this
// reason ("a public API must never leak one"); the same hazard applies one layer
// up, where a column a later migration adds would otherwise become public API by
// accident.
//
// ── Identifiers on the wire ─────────────────────────────────────────────────
// ADR §7: a WORK ITEM is named by its `MOTIR-<n>` key, never by its internal
// cuid. That holds absolutely here — not as `id`, not as a parent pointer, not
// as a link target. A cuid in a response body freezes the primary key as
// contract exactly as it would in a path.
//
// Three identifiers on this resource are NOT work items and so are NOT covered
// by that rule; each is a deliberate, recorded exception rather than a leak:
//   • `assigneeId` / `reporterId` — a USER has no `MOTIR-<n>` key, and its id is
//     the value `PATCH` accepts back (the shipped `UpdateWorkItemInput` takes
//     `assigneeId`). Omitting it would make assignment unreachable over the API.
//   • `sprintId` — likewise keyless; 11.3 owns the sprint resource.
// The guard in `tests/api/v1/story-gate.test.ts` asserts no WORK-ITEM cuid
// appears anywhere in a v1 body, which is the precise form of §7's rule.
//
// ── What is deliberately NOT here ───────────────────────────────────────────
// The card sketched `assignee`/`reporter` as `{ id, name }` objects. The shipped
// DTOs carry ids only (`WorkItemDto.assigneeId`, `WorkItemListItemDto.reporterId`
// — no joined name), so serving `{ id, name }` would require projecting a new
// field through the repository and service. That is precisely what this story's
// Scope BOUNDARY ("it changes no service, repository or DTO") and the ADR's
// Amendment 1 ("no new response field") forbid. Ids ship now; adding
// `assignee: { id, name }` later is ADDITIVE under §8 and therefore safe, whereas
// shipping a shape the data cannot fill is not.

// ─────────────────────────────────────────────────────────────────────────────
// Field vocabularies
// ─────────────────────────────────────────────────────────────────────────────

/** A `MOTIR-<n>` work-item key, as it appears in every reference on the wire. */
export const workItemKeySchema = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);

/** An ISO-8601 instant. The mappers emit strings; a `Date` is a schema failure. */
const isoDateTimeSchema = z.string().datetime();

// ── The closed vocabularies, kept TOTAL over their DTO unions ────────────────
//
// `z.enum` needs a literal tuple, so each set is spelled out — which is exactly
// the hand-maintained duplication that lets a wire vocabulary silently fall
// behind its source (MOTIR-2044's lesson, one layer down). Two guards per set
// close it, and both are COMPILE errors rather than test failures:
//
//   • `satisfies readonly <Dto>[]` — no member that is not a real DTO value.
//   • `AssertTotal<…>` — no DTO value missing from the tuple.
//
// A value added to a DTO union therefore breaks the build HERE, at the seam that
// decides what the public API says, instead of shipping as a response the schema
// rejects at runtime.

/** `true` only when `Union` is fully covered by `Covered`; otherwise `never`. */
type AssertTotal<Union, Covered> = [Exclude<Union, Covered>] extends [never] ? true : never;

const WORK_ITEM_KINDS = [
  'epic',
  'story',
  'task',
  'subtask',
  'bug',
] as const satisfies readonly WorkItemKindDto[];
const _kindsTotal: AssertTotal<WorkItemKindDto, (typeof WORK_ITEM_KINDS)[number]> = true;

const WORK_ITEM_PRIORITIES = [
  'lowest',
  'low',
  'medium',
  'high',
  'highest',
] as const satisfies readonly WorkItemPriorityDto[];
const _prioritiesTotal: AssertTotal<WorkItemPriorityDto, (typeof WORK_ITEM_PRIORITIES)[number]> =
  true;

const WORK_ITEM_TYPES = [
  'code',
  'design',
  'test',
  'content',
  'copy',
  'translate',
  'research',
  'review',
  'verification',
  'decision',
  'choice',
  'deploy',
  'manual',
  'legal',
  'chore',
] as const satisfies readonly WorkItemTypeDto[];
const _typesTotal: AssertTotal<WorkItemTypeDto, (typeof WORK_ITEM_TYPES)[number]> = true;

const EXECUTORS = ['coding_agent', 'human'] as const satisfies readonly ExecutorDto[];
const _executorsTotal: AssertTotal<ExecutorDto, (typeof EXECUTORS)[number]> = true;
// The difficulty scale (Story MOTIR-6016) is IMPORTED rather than re-declared:
// `lib/issues/difficulty.ts` is already the one list, asserted total against the
// Prisma enum, and this guard pins that the wire covers every DTO member.
const _difficultiesTotal: AssertTotal<
  WorkItemDifficultyDto,
  (typeof WORK_ITEM_DIFFICULTIES)[number]
> = true;
// The OBSOLESCENCE mark (Story MOTIR-6574 · MOTIR-6581) — imported for the same
// reason: `lib/issues/obsolescence.ts` is the one list the service validates
// against, so the wire and the service cannot disagree on the members.
const _obsolescencesTotal: AssertTotal<
  WorkItemObsolescenceDto,
  (typeof WORK_ITEM_OBSOLESCENCES)[number]
> = true;

/**
 * EXPORTED (MOTIR-2986) so the MCP plan payload's `authorSource` enum is THIS
 * list rather than a second copy of it — `docs/decisions/agent-authored-plans.md`
 * Q3 reuses the vocabulary precisely so there is one place a new member has to
 * be added. The `AssertTotal` directly below is what makes that safe: the list
 * cannot drift from `WorkItemPlanningSourceDto` without a compile error.
 */
export const PLANNING_SOURCES = [
  'native',
  'mcp',
  'manual',
  'api',
] as const satisfies readonly WorkItemPlanningSourceDto[];
const _planningTotal: AssertTotal<WorkItemPlanningSourceDto, (typeof PLANNING_SOURCES)[number]> =
  true;

const IMPLEMENTATION_SOURCES = [
  'hosted',
  'byok',
  'manual',
] as const satisfies readonly WorkItemImplementationSourceDto[];
const _implementationTotal: AssertTotal<
  WorkItemImplementationSourceDto,
  (typeof IMPLEMENTATION_SOURCES)[number]
> = true;

// The guards are type-level; reference them so `noUnusedLocals` stays happy and
// a reader can see they are load-bearing rather than leftovers.
void [
  _kindsTotal,
  _prioritiesTotal,
  _typesTotal,
  _executorsTotal,
  _difficultiesTotal,
  _obsolescencesTotal,
  _planningTotal,
  _implementationTotal,
];

const kindSchema = z.enum(WORK_ITEM_KINDS);
const prioritySchema = z.enum(WORK_ITEM_PRIORITIES);
const typeSchema = z.enum(WORK_ITEM_TYPES);
const executorSchema = z.enum(EXECUTORS);
const difficultySchema = z.enum(WORK_ITEM_DIFFICULTIES);
/**
 * Whether the card is still TRUE OF THE CODE (Story MOTIR-6574) — `outdated`
 * (the text no longer describes the code; the capability lives on in another
 * shape) or `deprecated` (retired or overturned on purpose — do not build on it).
 *
 * EXPORTED, and emitted as ONE named OpenAPI component (`WorkItemObsolescence`,
 * via `WORK_ITEM_SHARED_SCHEMAS` in `./operations.ts`) that every carrier —
 * the detail, the collection row, the ready row and both write bodies —
 * `$ref`s. The ready row imports THIS instance rather than re-declaring the
 * enum, because the emitter recognises the component by schema identity.
 */
export const obsolescenceSchema = z.enum(WORK_ITEM_OBSOLESCENCES);
const planningSourceSchema = z.enum(PLANNING_SOURCES);
const implementationSourceSchema = z.enum(IMPLEMENTATION_SOURCES);

/**
 * The relationship vocabulary on the wire — the shipped `work_item_link` set.
 * `blocked_by` is the edge the ready set reads. `supersedes` / `superseded_by`
 * (MOTIR-6580) are the two directions of the one `supersedes` edge: "A supersedes
 * B" means A is the NEWER item that replaces B. It gates nothing.
 */
export const relationshipSchema = z.enum([
  'blocked_by',
  'blocks',
  'relates_to',
  'duplicates',
  'clones',
  'supersedes',
  'superseded_by',
]);
export type V1Relationship = z.infer<typeof relationshipSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The resource shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A REFERENCE to a work item — what a nested position renders: an ancestor, a
 * child, a link target, an open blocker.
 *
 * Deliberately thinner than {@link workItemSummarySchema}, because the shipped
 * DTO behind it genuinely is: `WorkItemSummaryDto` carries no `type`, no
 * `reporterId`, no timestamps. Declaring one fat shape and emitting nulls into
 * it would be a schema that lies about what a read can know. Two shapes, each
 * honest about its source.
 */
export const workItemRefSchema = z.object({
  key: workItemKeySchema,
  kind: kindSchema,
  title: z.string(),
  status: z.string(),
  priority: prioritySchema,
  assigneeId: z.string().nullable(),
  estimateMinutes: z.number().int().nullable(),
  storyPoints: z.number().nullable(),
  parentKey: workItemKeySchema.nullable(),
  archived: z.boolean(),
});
export type WorkItemRef = z.infer<typeof workItemRefSchema>;

/**
 * One end of a dependency edge — the far item, named by its key.
 *
 * Declared HERE and imported by `lib/api/v1/ready/schema.ts`, which had its own
 * structurally identical copy: one declaration, so the ready row and the
 * work-item rows cannot drift — the same reason {@link workItemLinkSchema} is
 * shared between `GET …/links` and the detail aggregate (11.2.9).
 */
export const dependencyEdgeSchema = z.object({
  key: workItemKeySchema,
  title: z.string(),
  /** The far end's raw workflow status key. */
  status: z.string(),
});

/**
 * A row's dependency edges, in both directions (ADR Amendment 6 Q4).
 *
 * TOTAL by construction: a row with no edges gets two EMPTY arrays, never a
 * missing key, so a typed client never branches on presence. The key names match
 * `lib/mcp/dependencyEdges.ts` exactly — the two transports attach the same block
 * so one renderer can read both, which is the property `assignChildWaves` and
 * `renderSprintItems` depend on.
 */
export const dependencyEdgesSchema = z.object({
  blockedBy: z.array(dependencyEdgeSchema),
  blocks: z.array(dependencyEdgeSchema),
});
export type V1DependencyEdges = z.infer<typeof dependencyEdgesSchema>;

/**
 * The fields a work item carries wherever it is returned WHOLE — shared by the
 * collection row and the detail resource.
 *
 * Extracted so {@link workItemSummarySchema} can carry `dependencies` without
 * {@link workItemDetailSchema} inheriting it. The detail already publishes the
 * item's own edges as `links.blockedBy` / `links.blocks` — richer refs, and the
 * seven groups rather than two — so a second block there would be a redundant
 * field a client has to pick between. The detail's edge projection lands on its
 * CHILDREN ({@link workItemChildSchema}), which is the sub-graph nothing else
 * carries.
 */
const workItemFieldsSchema = z.object({
  key: workItemKeySchema,
  kind: kindSchema,
  type: typeSchema.nullable(),
  title: z.string(),
  status: z.string(),
  priority: prioritySchema,
  assigneeId: z.string().nullable(),
  reporterId: z.string(),
  dueDate: isoDateTimeSchema.nullable(),
  estimateMinutes: z.number().int().nullable(),
  storyPoints: z.number().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  /** The OBSOLESCENCE mark (Story MOTIR-6574 · MOTIR-6581) — `null` when the card
   *  is current. Carried on EVERY kind and EVERY status, a `done` card included:
   *  a finished card is exactly the one whose text the code can outgrow.
   *  ADDITIVE under §8; `V1_CONTRACT_VERSION` moves for it. */
  obsolescence: obsolescenceSchema.nullable(),
  /** Why the card is marked, in Markdown — `null` when there is no note. Stored
   *  independently of `obsolescence`: clearing the mark does not erase the note. */
  obsolescenceNoteMd: z.string().nullable(),
});

/**
 * The row every COLLECTION returns. Sourced from the flat List projection plus
 * the keyset read's `createdAt` — the position the cursor encodes, so it is part
 * of the page addressing rather than a new field on an existing read.
 *
 * `dependencies` is a §8 ADDITION (ADR Amendment 6 Q4), attached by a BOUNDED
 * page-level projection: one `getDependencyEdgesForItems` call for the whole
 * page, never one per row.
 */
export const workItemSummarySchema = workItemFieldsSchema.extend({
  dependencies: dependencyEdgesSchema,
});
export type WorkItemSummary = z.infer<typeof workItemSummarySchema>;

/**
 * How many work items match a filter — the answer to a question the COLLECTION
 * deliberately does not answer (ADR Amendment 14).
 *
 * A resource of its own rather than a `totalCount` on the page, because the
 * collection's read is a keyset walk that computes no count, and putting one on
 * the envelope would run a `COUNT` under an arbitrary filter on every page of
 * every caller — including the paging walks that want no count at all. As a
 * separate operation, the count is paid for exactly once, by the caller who
 * asked for it, and Amendment 3 Q2's two-envelope rule stays intact.
 *
 * EXACT, never capped: a "999+" would stop being true precisely when the number
 * starts to matter.
 */
export const workItemCountSchema = z.object({
  count: z.number().int().nonnegative(),
});
export type V1WorkItemCount = z.infer<typeof workItemCountSchema>;

/** One dependency / relationship edge, as both `GET …/links` and the detail
 *  aggregate render it — ONE declaration, so the two cannot drift (11.2.9). */
export const workItemLinkSchema = z.object({
  relationship: relationshipSchema,
  item: workItemRefSchema,
});
export type WorkItemLink = z.infer<typeof workItemLinkSchema>;

/** All seven edge groups. An empty group is `[]`, never an absent key — to a
 *  typed client those are different things. `supersedes` holds the OLDER items
 *  this one replaces, `supersededBy` the NEWER items that replace it
 *  (MOTIR-6580). */
export const workItemLinkGroupsSchema = z.object({
  blockedBy: z.array(workItemRefSchema),
  blocks: z.array(workItemRefSchema),
  relatesTo: z.array(workItemRefSchema),
  duplicates: z.array(workItemRefSchema),
  clones: z.array(workItemRefSchema),
  supersedes: z.array(workItemRefSchema),
  supersededBy: z.array(workItemRefSchema),
});
export type WorkItemLinkGroups = z.infer<typeof workItemLinkGroupsSchema>;

/**
 * The readiness verdict — whether every `blocked_by` blocker is terminal.
 *
 * `blockedByAncestorTitle` is a §8 ADDITION (ADR Amendment 6 Q4) and a pure
 * WIDENING: `IssueDetailDto.readiness.blockedByAncestor` is a full
 * `WorkItemSummaryDto` the mapper already holds and was discarding down to its
 * identifier. Nothing new is read. `blockedByAncestorKey` is published API and
 * stays exactly as it is — the title arrives ALONGSIDE it, never instead of it,
 * because the CLI's `renderReadinessLine` prints `blocked by ancestor <key> —
 * <title>` and needs both.
 *
 * The two are null together: there is no state in which an ancestor blocks the
 * item and its title is unknown.
 */
export const readinessSchema = z.object({
  ready: z.boolean(),
  openBlockers: z.array(workItemRefSchema),
  blockedByAncestorKey: workItemKeySchema.nullable(),
  blockedByAncestorTitle: z.string().nullable(),
});

// A label and a component are named by their NAME, not their cuid: the name is
// what the FilterAST's `lbl` / `cmp` facets match on, so it is the value a client
// can actually do something with. Their ids are internal and stay internal.
const labelSchema = z.object({ name: z.string() });
const componentSchema = z.object({ name: z.string() });

/**
 * A CHILD of the detail aggregate — a reference plus that child's own dependency
 * edges (ADR Amendment 6 Q4).
 *
 * The block rides the CHILD rows and not {@link workItemRefSchema} itself, which
 * is also an ancestor / link target / open blocker: widening the reference would
 * oblige every one of those positions to carry edges nothing reads, and force an
 * edge read on routes that have no use for one. The sibling sub-graph is what
 * makes the children's build ORDER derivable from this one call — the property
 * `packages/cli/src/render.ts`'s `assignChildWaves` computes its wave view from —
 * and it is exactly where `lib/mcp/tools/getWorkItem.ts` attaches it too.
 */
export const workItemChildSchema = workItemRefSchema.extend({
  dependencies: dependencyEdgesSchema,
});
export type WorkItemChild = z.infer<typeof workItemChildSchema>;

/**
 * ONE MEMBER of the DELIVERY SET (Story MOTIR-3655 · MOTIR-3697) — one pull request
 * that delivers this card.
 *
 * Declared in the v1 layer rather than imported from `lib/dto/github`, like every
 * other shape here: a change to the internal DTO must be a COMPILE error at the
 * presenter, not a silent change to the published contract.
 */
const workItemDeliverySchema = z.object({
  /** `owner/name`. */
  repo: z.string(),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  /** `merged` collapses the raw open/closed pair — a merged pull request is never
   *  reported as `closed`, which is what makes this field alone sufficient to say
   *  whether the delivery landed. */
  state: z.enum(['open', 'merged', 'closed']),
  /** The pull request's CI at its latest recorded commit, from `derivePrCiState` —
   *  the SAME verdict `ciPromotion` acts on and the Development pill shows. `null`
   *  is the absence of CI, which is not a state and not a failure. */
  ci: z.enum(['passing', 'failing', 'running']).nullable(),
  /** The branch the pull request TARGETS; null on a row mirrored before base
   *  branches were recorded. */
  baseRef: z.string().nullable(),
  /** THAT repository's default branch — never assume `main`. A merge onto anything
   *  else delivered nothing to the trunk. */
  defaultBranch: z.string(),
  /** The STANDING merge-queue failure on this pull request, or null (MOTIR-5720):
   *  its latest queue exit is a failure, not re-queued, at its current head. The
   *  server decides "standing", so a client holds no head logic. `ci` stays the
   *  pull request's OWN checks — a member reading `ci: 'passing'` with a set
   *  `queueExit` is RED in the queue, and a repair loop must treat it as red. */
  queueExit: z
    .object({
      /** GitHub's own reason — `CI_FAILURE`, `CI_TIMEOUT`, `MERGE_CONFLICT`, … */
      rawReason: z.string(),
      headSha: z.string(),
      /** The queue's failing check; both null when none is known (a conflict). */
      failingCheckName: z.string().nullable(),
      failingCheckUrl: z.string().nullable(),
    })
    .nullable(),
  /** The STANDING refusal the HOST gave when Motir pressed merge on this pull
   *  request, or null (Bug MOTIR-6735): not superseded by a later successful press,
   *  still at the pull request's current head, and the pull request still open.
   *  `reason` is the host's own message, verbatim — for `branch_protected` it is the
   *  only thing that names the setting that refused the merge. */
  mergeRefusal: z
    .object({
      /** The refusal code — `branch_protected`, `conflict`, `checks_not_green`, … */
      code: z.string(),
      /** The host's own message; null when it gave none. */
      reason: z.string().nullable(),
      headSha: z.string(),
      refusedAt: z.string(),
    })
    .nullable(),
});
export type WorkItemDelivery = z.infer<typeof workItemDeliverySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// LINKING a pull request (Task MOTIR-5048)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ADDRESS of a pull request, in the two forms a caller actually holds.
 *
 * Deliberately the SAME pair `link_pull_request` accepts, because the two doors
 * write the same row through the same service and a client that learned one
 * address form must not find the other door speaks a different one. The MCP
 * tool's `resolveCoordinate` is the shared parser — imported by the ROUTE rather
 * than re-implemented here would be the obvious move and is FORBIDDEN
 * (`tests/api/v1/story-gate.test.ts` refuses any v1 reach into `lib/mcp/tools/**`),
 * so the route re-derives the two regexes from this schema's own shape. The
 * identity that matters is behavioural and is pinned by a test asserting both
 * doors resolve one `url` to one row.
 *
 * ⚠️ NEITHER FORM IS RANKED. Supplying both is legal and they are CROSS-CHECKED;
 * a disagreement is a 422 rather than a silent pick, because picking one lands
 * the link on a real pull request that is not the one the caller meant, under a
 * success response.
 */
export const linkPullRequestBodySchema = z
  .object({
    /** `owner/name`, exactly as the repository is connected. With `number`. */
    repository: z.string().trim().min(1).optional(),
    /** The pull-request number. With `repository`. */
    number: z.number().int().positive().optional(),
    /** The full URL — the line `gh pr create` prints, passed through verbatim. */
    url: z.string().trim().min(1).optional(),
    /** The branch the pull request is FROM. Seeds the row when no webhook
     *  delivery has arrived; a later delivery overwrites it. */
    headRef: z.string().trim().min(1),
    /** The branch it TARGETS. Same rule as `headRef`. */
    baseRef: z.string().trim().min(1),
    /** The title, for the row this call may have to create. The first delivery
     *  supplies the real one either way. */
    title: z.string().trim().optional(),
  })
  .strict();
export type LinkPullRequestBody = z.infer<typeof linkPullRequestBodySchema>;

/**
 * What a link RESOLVED to.
 *
 * ⚠️ NO INTERNAL ID. `LinkedPullRequestDto` carries Motir's own cuid for the
 * pull-request row, and §7 keeps the cuid off the wire — v1 addresses things by
 * the names the world uses. A caller already holds the coordinate it sent, so
 * the id would buy it nothing it could legally use.
 *
 * `created` is the one fact the caller cannot derive: whether this call WROTE
 * the pull-request row because no webhook delivery had arrived yet. That is the
 * case the operation exists for, so it is reported rather than left implicit.
 */
export const linkedPullRequestSchema = z.object({
  key: workItemKeySchema,
  created: z.boolean(),
  pullRequest: z.object({
    repo: z.string(),
    number: z.number().int(),
    title: z.string(),
    url: z.string(),
    state: z.enum(['open', 'merged', 'closed']),
    ci: z.enum(['passing', 'failing', 'running']).nullable(),
  }),
});
export type LinkedPullRequest = z.infer<typeof linkedPullRequestSchema>;

/** Shape the service's result for the wire — field by field, never a spread. */
export function presentLinkedPullRequest(
  key: string,
  result: { link: LinkedPullRequestDto; created: boolean },
): LinkedPullRequest {
  return {
    key,
    created: result.created,
    pullRequest: {
      repo: result.link.repo,
      number: result.link.number,
      title: result.link.title,
      url: result.link.url,
      state: result.link.state,
      ci: result.link.ci,
    },
  };
}

/** A content-language code (Story MOTIR-7731 · MOTIR-8098) — one of the eleven
 *  locales, the one list in `lib/i18n/locales.ts`. */
export const languageSchema = z.enum(locales);

/** The recorded language of each work-text field — `null` when none was
 *  recorded (text written before content languages, and imported text). Never
 *  defaulted to `en`: a defaulted value could not be told from a real one. */
const workItemLanguagesSchema = z.object({
  title: languageSchema.nullable(),
  description: languageSchema.nullable(),
  explanation: languageSchema.nullable(),
});

/** The single-item READ: the work item's fields plus everything a detail adds. */
export const workItemDetailSchema = workItemFieldsSchema.extend({
  descriptionMd: z.string().nullable(),
  /** Each text field's recorded language (Story MOTIR-7731 · MOTIR-8098).
   *  ADDITIVE; `V1_CONTRACT_VERSION` moves for it. */
  languages: workItemLanguagesSchema,
  parentKey: workItemKeySchema.nullable(),
  /** The folder the item is FILED in — its OWN placement, beside `parentKey`
   *  (Story MOTIR-5310 · MOTIR-5412). Non-null exactly when the item is filed, and
   *  a filed item is always a root, so a story under a filed epic reads `null`:
   *  its ancestry already travels as keys. NOT the item page's EFFECTIVE folder
   *  (MOTIR-5375), which is a different field for a different reader. ADDITIVE;
   *  `V1_CONTRACT_VERSION` moves for it. */
  folderId: z.string().nullable(),
  /** The filed folder's name path, ROOT FIRST (`["Parked", "2025"]`). Non-null
   *  exactly when `folderId` is. */
  folderPath: z.array(z.string()).nullable(),
  ancestorKeys: z.array(workItemKeySchema),
  children: z.array(workItemChildSchema),
  links: workItemLinkGroupsSchema,
  readiness: readinessSchema,
  labels: z.array(labelSchema),
  components: z.array(componentSchema),
  commentCount: z.number().int(),
  sprintId: z.string().nullable(),
  targetRepo: z.string().nullable(),
  /** EVERY repository the item ships in (Story MOTIR-2725 · MOTIR-2728), ordered,
   *  element 0 the primary — which is exactly what `targetRepo` above holds.
   *
   *  ADDITIVE beside the scalar rather than replacing it: §8 of
   *  `docs/decisions/public-api-conventions.md` lists removing, renaming and
   *  retyping a published field as forbidden without a new major, and turning
   *  `targetRepo` into an array is all three. A client written against today's
   *  shape keeps reading the repository dispatch routes to; `V1_CONTRACT_VERSION`
   *  moves for the addition (Amendment 8). */
  targetRepos: z.array(z.string()),
  /** The same repositories as RESOLVED REFERENCES (Story MOTIR-2732 · MOTIR-3041,
   *  ADR "Amendment 2026-08-18" §A4) — one entry per `project_repository` row the
   *  item points at, in set order, `primary` on element 0.
   *
   *  ADDITIVE, so the two name fields above keep their shape and meaning: they are
   *  the NAMES these references resolve to, which is why a repository RENAME
   *  changes what every field displays and nothing about what the card points at.
   *  A client that never learns about this field under-reports rather than
   *  mis-reports, and §8's "a client MUST tolerate unknown fields" is the other
   *  half of the promise. `V1_CONTRACT_VERSION` moves for the addition. */
  targetRepositories: z.array(
    z.object({
      ref: z.string(),
      name: z.string(),
      role: z.string(),
      label: z.string().nullable(),
      state: z.string(),
      primary: z.boolean(),
    }),
  ),
  executor: executorSchema.nullable(),
  // How hard the leaf is to reason about (Story MOTIR-6016). `null` when unset,
  // and always `null` on an epic or story.
  difficulty: difficultySchema.nullable(),
  planningSource: planningSourceSchema.nullable(),
  planningHarness: z.string().nullable(),
  planningModel: z.string().nullable(),
  implementationSource: implementationSourceSchema.nullable(),
  implementationHarness: z.string().nullable(),
  implementationModel: z.string().nullable(),
  archivedAt: isoDateTimeSchema.nullable(),
  /** The DELIVERY SET (Story MOTIR-3655 · MOTIR-3697) — every pull request that
   *  delivers this card, oldest link first.
   *
   *  This is the only route a PAT-authenticated client has to a pull request's CI
   *  verdict: `derivePrCiState` is server-side and no v1 read exposed it, so a CLI
   *  that had to know whether its own pull request was green could only shell out
   *  to `gh pr checks` — a SECOND verdict, which would drift from the pill a person
   *  reads on the same card. The `ci` here is the first one.
   *
   *  ⚠️ EMPTY IS THE ORDINARY ANSWER, on an overwhelming majority of cards, and it
   *  means *nothing is recorded* — never *nothing has landed*. It is an array on
   *  every work item and never `null` or absent, so a client needs no branch.
   *
   *  ADDITIVE: a new field on an existing shape, §8's first allowed change; no
   *  declared field is removed, renamed or retyped. `V1_CONTRACT_VERSION` moves. */
  deliveries: z.array(workItemDeliverySchema),
});
export type WorkItemDetail = z.infer<typeof workItemDetailSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The mappers — field by field, never a spread
// ─────────────────────────────────────────────────────────────────────────────

/** What {@link presentWorkItemSummary} reads. Declared in the v1 layer rather
 *  than imported from `lib/dto`, so a change to an internal DTO is a COMPILE
 *  error at the seam instead of a silent change to the public contract. */
export interface WorkItemSummarySource {
  identifier: string;
  kind: WorkItemKindDto;
  type: WorkItemTypeDto | null;
  title: string;
  status: string;
  priority: WorkItemPriorityDto;
  assigneeId: string | null;
  reporterId: string;
  dueDate: string | null;
  estimateMinutes: number | null;
  storyPoints: number | null;
  createdAt: string;
  updatedAt: string;
  obsolescence: WorkItemObsolescenceDto | null;
  obsolescenceNoteMd: string | null;
}

/**
 * Map one row's dependency edges to the wire — field by field, never a spread.
 *
 * TOTAL: an id the batched read returned no entry for still gets two EMPTY
 * arrays. `getDependencyEdgesForItems` pre-seeds every id it is asked about, so
 * `undefined` is unreachable through the routes — the default is what makes the
 * promise hold at the SCHEMA rather than at each call site, which is the same
 * discipline `lib/mcp/dependencyEdges.ts`'s `attachEdges` applies to the MCP
 * transport.
 */
export function presentDependencyEdges(
  edges: WorkItemDependencyEdgesDto | undefined,
): V1DependencyEdges {
  return {
    blockedBy: (edges?.blockedBy ?? []).map((edge) => ({
      key: edge.key,
      title: edge.title,
      status: edge.status,
    })),
    blocks: (edges?.blocks ?? []).map((edge) => ({
      key: edge.key,
      title: edge.title,
      status: edge.status,
    })),
  };
}

/** The fields shared by the collection row and the detail resource. */
function presentWorkItemFields(
  source: WorkItemSummarySource,
): z.infer<typeof workItemFieldsSchema> {
  return {
    key: source.identifier,
    kind: source.kind,
    type: source.type,
    title: source.title,
    status: source.status,
    priority: source.priority,
    assigneeId: source.assigneeId,
    reporterId: source.reporterId,
    dueDate: source.dueDate,
    estimateMinutes: source.estimateMinutes,
    storyPoints: source.storyPoints,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    obsolescence: source.obsolescence,
    obsolescenceNoteMd: source.obsolescenceNoteMd,
  };
}

/**
 * Map a collection row to its wire shape.
 *
 * `edges` comes from the page's BATCHED projection — one call for the whole
 * page — and is a REQUIRED parameter so a caller cannot forget it and silently
 * publish "this row has no dependencies" for every row.
 */
export function presentWorkItemSummary(
  source: WorkItemSummarySource,
  edges: WorkItemDependencyEdgesDto | undefined,
): WorkItemSummary {
  return {
    ...presentWorkItemFields(source),
    dependencies: presentDependencyEdges(edges),
  };
}

/**
 * Map a nested work-item summary to a REFERENCE.
 *
 * `parentKey` needs the parent's KEY, but `WorkItemSummaryDto` carries only the
 * internal `parentId` — so the caller passes a resolver built from the ids it
 * already read. An id it cannot resolve becomes `null` rather than leaking the
 * cuid: an unresolvable parent is one outside what this read fetched, and §7
 * forbids naming it by cuid whatever the reason.
 */
export function presentWorkItemRef(
  source: WorkItemSummaryDto,
  keyOfId: (id: string) => string | undefined = () => undefined,
): WorkItemRef {
  return {
    key: source.identifier,
    kind: source.kind,
    title: source.title,
    status: source.status,
    priority: source.priority,
    assigneeId: source.assigneeId,
    estimateMinutes: source.estimateMinutes,
    storyPoints: source.storyPoints,
    parentKey: source.parentId === null ? null : (keyOfId(source.parentId) ?? null),
    archived: source.archivedAt !== null,
  };
}

/**
 * Map the detail aggregate to the wire resource.
 *
 * `commentCount` is passed in rather than read from the DTO: it is deliberately
 * NOT on `IssueDetailDto` (`lib/mcp/commentCounts.ts` records why — widening the
 * aggregate would break every exact-`toEqual` route-shape test that reads it
 * back), so the route reads it from `commentsService` and hands it here.
 *
 * `childEdges` arrives the same way and for the same reason — the CHILDREN's
 * dependency edges are not on `IssueDetailDto.children` either. It is keyed by
 * the child's internal id, exactly as `workItemsService.getDependencyEdgesForItems`
 * returns it, and REQUIRED so a route cannot forget the projection and publish an
 * edge-free sub-graph. Pass `{}` where the caller genuinely has no children to
 * describe (a create, or the links-only presenter).
 *
 * `deliveries` arrives the same way again (MOTIR-3697), and is REQUIRED for a
 * sharper version of the same reason: an omitted delivery set does not read as
 * missing, it reads as EMPTY, and an empty delivery set is a positive claim that
 * nothing delivers this card. A route that forgot it would publish that claim
 * about every work item it returns, and no client could tell. Pass `[]` only where
 * the answer is genuinely empty — a create, whose card cannot yet have one.
 */
export function presentWorkItemDetail(
  detail: IssueDetailDto,
  commentCount: number,
  childEdges: Readonly<Record<string, WorkItemDependencyEdgesDto>>,
  deliveries: readonly WorkItemDeliveryDto[],
  /** The filed item's folder path, root first — `workItemsService.getFolderPath`
   *  over `detail.folderId`. Read by the route and handed in, like the counts, so
   *  the presenter stays a pure mapping. Ignored for an unfiled item. */
  folderPath: readonly string[] = [],
): WorkItemDetail {
  const { item } = detail;

  // Every work item this read already resolved, so a `parentId` can be named by
  // its KEY. Built once and shared by every nested position.
  const keyById = new Map<string, string>([[item.id, item.identifier]]);
  for (const row of [
    ...detail.ancestors,
    ...detail.children,
    ...detail.readiness.openBlockers,
    ...[
      ...detail.blockedBy,
      ...detail.blocks,
      ...detail.relatesTo,
      ...detail.duplicates,
      ...detail.clones,
      ...detail.supersedes,
      ...detail.supersededBy,
    ].map((link) => link.item),
  ]) {
    keyById.set(row.id, row.identifier);
  }
  const keyOfId = (id: string): string | undefined => keyById.get(id);
  const ref = (source: WorkItemSummaryDto): WorkItemRef => presentWorkItemRef(source, keyOfId);

  return {
    ...presentWorkItemFields({
      identifier: item.identifier,
      kind: item.kind,
      type: item.type,
      title: item.title,
      status: item.status,
      priority: item.priority,
      assigneeId: item.assigneeId,
      reporterId: item.reporterId,
      dueDate: item.dueDate,
      estimateMinutes: item.estimateMinutes,
      storyPoints: item.storyPoints,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      obsolescence: item.obsolescence,
      obsolescenceNoteMd: item.obsolescenceNoteMd,
    }),
    descriptionMd: item.descriptionMd,
    languages: {
      title: item.languages.title,
      description: item.languages.description,
      explanation: item.languages.explanation,
    },
    parentKey: detail.parent === null ? null : detail.parent.identifier,
    folderId: detail.folderId,
    folderPath: detail.folderId === null ? null : [...folderPath],
    ancestorKeys: detail.ancestors.map((a) => a.identifier),
    children: detail.children.map((child) => ({
      ...ref(child),
      dependencies: presentDependencyEdges(childEdges[child.id]),
    })),
    links: {
      blockedBy: detail.blockedBy.map((link) => ref(link.item)),
      blocks: detail.blocks.map((link) => ref(link.item)),
      relatesTo: detail.relatesTo.map((link) => ref(link.item)),
      duplicates: detail.duplicates.map((link) => ref(link.item)),
      clones: detail.clones.map((link) => ref(link.item)),
      supersedes: detail.supersedes.map((link) => ref(link.item)),
      supersededBy: detail.supersededBy.map((link) => ref(link.item)),
    },
    readiness: {
      ready: detail.readiness.ready,
      openBlockers: detail.readiness.openBlockers.map(ref),
      blockedByAncestorKey: detail.readiness.blockedByAncestor?.identifier ?? null,
      blockedByAncestorTitle: detail.readiness.blockedByAncestor?.title ?? null,
    },
    labels: detail.labels.map((label) => ({ name: label.name })),
    components: detail.components.map((component) => ({ name: component.name })),
    commentCount,
    sprintId: item.sprintId,
    targetRepo: item.targetRepo,
    targetRepos: item.targetRepos,
    targetRepositories: item.targetRepositories ?? [],
    executor: item.executor,
    difficulty: item.difficulty,
    planningSource: item.planningSource,
    planningHarness: item.planningHarness,
    planningModel: item.planningModel,
    implementationSource: item.implementationSource,
    implementationHarness: item.implementationHarness,
    implementationModel: item.implementationModel,
    archivedAt: item.archivedAt,
    // Field by field, never a spread — the internal DTO nests the pull request and
    // the wire resource is flat, so the two shapes are deliberately different and a
    // change to either has to be made here on purpose.
    deliveries: deliveries.map((delivery) => ({
      repo: delivery.pullRequest.repo,
      number: delivery.pullRequest.number,
      title: delivery.pullRequest.title,
      url: delivery.pullRequest.url,
      state: delivery.pullRequest.state,
      ci: delivery.pullRequest.ci,
      baseRef: delivery.baseRef,
      defaultBranch: delivery.defaultBranch,
      queueExit:
        delivery.queueExit === null
          ? null
          : {
              rawReason: delivery.queueExit.rawReason,
              headSha: delivery.queueExit.headSha,
              failingCheckName: delivery.queueExit.failingCheckName,
              failingCheckUrl: delivery.queueExit.failingCheckUrl,
            },
      mergeRefusal:
        delivery.mergeRefusal === null
          ? null
          : {
              code: delivery.mergeRefusal.code,
              reason: delivery.mergeRefusal.reason,
              headSha: delivery.mergeRefusal.headSha,
              refusedAt: delivery.mergeRefusal.refusedAt,
            },
    })),
  };
}

/** Present the seven edge groups on their own — the `GET …/links` body (11.2.9),
 *  reusing the SAME declaration the detail resource nests. */
export function presentWorkItemLinkGroups(detail: IssueDetailDto): WorkItemLinkGroups {
  // No child edges and no deliveries: `links` is the item's OWN seven edge groups
  // and reads neither, so this presenter owes no projection of either.
  return presentWorkItemDetail(detail, 0, {}, []).links;
}

// ─────────────────────────────────────────────────────────────────────────────
// The ETag — one function owns BOTH directions
// ─────────────────────────────────────────────────────────────────────────────
//
// The detail read issues an `ETag`; `PATCH` accepts it back as `If-Match` and
// passes it to `updateWorkItem`'s shipped `expectedUpdatedAt` precondition
// (11.2.6). A validator produced by one card and parsed by another IS a
// contract, so it lives with the resource rather than being re-invented at the
// write.
//
// ⚠️ ENCRYPTED, not merely encoded. The requirement is that a client cannot read
// `updatedAt` back out of it — base64 of a JSON payload (the cursor's idiom)
// would be opaque to read but trivially decodable, which is a different and
// weaker property. AES-256-GCM gives BOTH directions from one secret plus
// tamper-evidence for free: a modified validator fails its auth tag and is
// rejected outright rather than decoding to a plausible-but-wrong instant.

const ETAG_ALGORITHM = 'aes-256-gcm';
const ETAG_IV_BYTES = 12;
const ETAG_TAG_BYTES = 16;

function etagKey(): Buffer {
  // Derived from the app secret, so a validator issued by one deployment is not
  // valid against another — the same containment `signingKey()` gives cursors.
  const secret = process.env['BETTER_AUTH_SECRET'];
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not set');
  return createHash('sha256').update(`${secret}:api-v1-work-item-etag`).digest();
}

/**
 * The opaque `ETag` for a work item at a given version.
 *
 * Quoted, per RFC 9110 — an `ETag` is a quoted-string and `If-Match` compares it
 * verbatim. A fresh random IV per call means the same `updatedAt` produces a
 * DIFFERENT validator each time, which is deliberate: it removes the last way a
 * client could correlate two validators and infer that a row had not moved.
 */
export function encodeWorkItemETag(updatedAt: string): string {
  const iv = randomBytes(ETAG_IV_BYTES);
  const cipher = createCipheriv(ETAG_ALGORITHM, etagKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(updatedAt, 'utf8'), cipher.final()]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  return `"${payload.toString('base64url')}"`;
}

/**
 * Decode an `If-Match` validator back to the instant it pins.
 *
 * Throws a 422 for anything that is not a validator we issued — malformed,
 * truncated, tampered, or from another deployment. It never degrades to
 * "no precondition": silently ignoring an `If-Match` a client sent would drop
 * the exact guarantee the client asked for, which is worse than refusing it.
 */
export function decodeWorkItemETag(raw: string): Date {
  const invalid = () =>
    new InvalidRequestError('INVALID_IF_MATCH', 'The `If-Match` header is not a valid ETag.');

  const unquoted = raw
    .trim()
    .replace(/^W\//, '')
    .replace(/^"(.*)"$/, '$1');
  let payload: Buffer;
  try {
    payload = Buffer.from(unquoted, 'base64url');
  } catch {
    throw invalid();
  }
  if (payload.length <= ETAG_IV_BYTES + ETAG_TAG_BYTES) throw invalid();

  const iv = payload.subarray(0, ETAG_IV_BYTES);
  const tag = payload.subarray(ETAG_IV_BYTES, ETAG_IV_BYTES + ETAG_TAG_BYTES);
  const ciphertext = payload.subarray(ETAG_IV_BYTES + ETAG_TAG_BYTES);

  let plaintext: string;
  try {
    const decipher = createDecipheriv(ETAG_ALGORITHM, etagKey(), iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw invalid();
  }

  const parsed = new Date(plaintext);
  if (Number.isNaN(parsed.getTime())) throw invalid();
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST schemas (Story 11.2 · Subtask 11.2.6 — MOTIR-2046)
// ─────────────────────────────────────────────────────────────────────────────
//
// These live beside the RESPONSE schemas deliberately: Story 11.4 emits the
// OpenAPI operations from this module, and an operation is a request shape AND a
// response shape. Splitting them would put half an operation in each of two
// places.
//
// ⚠️ ABSENT vs NULL is the commonest PATCH defect, so it is spelled out rather
// than left to zod's defaults: a field that is ABSENT is untouched; a field
// explicitly set to `null` CLEARS the column. `.optional()` models the first and
// `.nullable()` the second, and the pairing is what makes them distinguishable —
// `updateWorkItemBodySchema.parse({})` yields `{}`, not a patch full of nulls.

/** A story-point value, mirroring the shipped `validateStoryPoints` bounds. */
const storyPointsSchema = z.number().min(0).max(9999.99).nullable();
const estimateMinutesSchema = z.number().int().min(0).nullable();

/** `POST /api/v1/projects/{projectKey}/work-items`. */
export const createWorkItemBodySchema = z
  .object({
    kind: kindSchema,
    title: z.string().min(1),
    // A `MOTIR-<n>` key, never a cuid (ADR §7) — the route resolves it to the
    // internal parent id.
    parentKey: workItemKeySchema.nullish(),
    // The FOLDER to file the new item into (MOTIR-5412) — a folder id, since a
    // folder has no key. MUTUALLY EXCLUSIVE with `parentKey`: an item hangs under a
    // work item OR sits in a folder, never both, so supplying both raises
    // `PLACEMENT_CONFLICT` (422) rather than silently picking one.
    folderId: z.string().min(1).nullish(),
    descriptionMd: z.string().nullish(),
    // The card's sections as named values (MOTIR-9031) — rendered into
    // `descriptionMd` by the service. The wire checks ONLY that it is an object:
    // membership, required-ness and each value's shape are the registry's, so one
    // mistake is one `INVALID_SECTIONS` on every door. Beside `descriptionMd` it is
    // `SECTIONS_AND_DESCRIPTION_CONFLICT` (422). On PATCH it is sparse at the
    // section key (`null` clears one).
    sections: z.record(z.string(), z.unknown()).optional(),
    // The language the text is written in (Story MOTIR-7731 · MOTIR-8098):
    // `language` for every text field, `languages` per field (wins). Omitted, the
    // organisation's content language is recorded. Non-nullable — the service
    // decides; there is no "clear the language".
    language: languageSchema.optional(),
    languages: z
      .object({ title: languageSchema.optional(), description: languageSchema.optional() })
      .strict()
      .optional(),
    priority: prioritySchema.optional(),
    type: typeSchema.nullish(),
    executor: executorSchema.nullish(),
    // Leaf-only, as `type` is: a non-null value on an epic or story is refused
    // by the service as `DIFFICULTY_NOT_ALLOWED_ON_KIND` (422).
    difficulty: difficultySchema.nullish(),
    // The OBSOLESCENCE mark (MOTIR-6581): settable on ANY kind, with no kind
    // refusal, unlike `difficulty` — but only on a FINISHED card (MOTIR-6672): the
    // service refuses a mark on a status outside the done category as
    // `OBSOLESCENCE_REQUIRES_FINISHED` (422). `null` clears it. A value outside the
    // enum is `INVALID_OBSOLESCENCE` (422).
    obsolescence: obsolescenceSchema.nullish(),
    obsolescenceNoteMd: z.string().nullish(),
    storyPoints: storyPointsSchema.optional(),
    estimateMinutes: estimateMinutesSchema.optional(),
    targetRepo: z.string().nullish(),
    // The repository SET (MOTIR-2728). MUTUALLY EXCLUSIVE with `targetRepo`: the
    // scalar IS this list's first element, so supplying both describes one field
    // twice and the service raises `CONFLICTING_TARGET_REPO_INPUT` (422) rather
    // than silently picking a winner (ADR §3.4).
    targetRepos: z.array(z.string()).optional(),
    // The repository REFERENCES (MOTIR-3039) — `project_repository` row ids,
    // ordered, element 0 the primary. The reference-native form of the two fields
    // above and the AUTHORED state; the names are what they resolve to, so a
    // rename changes what a card displays and nothing about what it points at.
    // MUTUALLY EXCLUSIVE with BOTH of them (§3.4 widened to three): supplying two
    // raises `CONFLICTING_TARGET_REPO_INPUT` (422). An id outside the item's own
    // project raises `UNKNOWN_PROJECT_REPO_REF` (422).
    targetRepositories: z.array(z.string()).optional(),
    assigneeId: z.string().nullish(),
    dueDate: z.string().datetime().nullish(),
  })
  .strict();
export type CreateWorkItemBody = z.infer<typeof createWorkItemBodySchema>;

/**
 * `PATCH /api/v1/work-items/{key}` — the shipped `UpdateWorkItemInput` PATCH
 * keys, plus `parentKey` (re-file) and `kind` (re-classify), both of which the
 * ONE service method already validates against the kind-parent matrix.
 *
 * `.strict()` on both: an unknown property is a 422, not a silent no-op. A
 * client that misspells a field name has a bug, and telling them beats
 * pretending the write succeeded.
 */
export const updateWorkItemBodySchema = z
  .object({
    kind: kindSchema.optional(),
    title: z.string().min(1).optional(),
    descriptionMd: z.string().nullish(),
    // As on create (MOTIR-9031): sparse at the section key, judged on the item's
    // kind × type AFTER this PATCH.
    sections: z.record(z.string(), z.unknown()).optional(),
    explanationMd: z.string().nullish(),
    // As on create, plus `explanation`. Re-records only the fields this PATCH
    // edits; a language alone changes nothing.
    language: languageSchema.optional(),
    languages: z
      .object({
        title: languageSchema.optional(),
        description: languageSchema.optional(),
        explanation: languageSchema.optional(),
      })
      .strict()
      .optional(),
    parentKey: workItemKeySchema.nullish(),
    /** File the item into this folder, or take it out of its folder with `null`
     *  (MOTIR-5412). Applied atomically with every other field in the body, under
     *  the same `If-Match`. Mutually exclusive with `parentKey`, exactly as on
     *  create: both together is `PLACEMENT_CONFLICT` (422). */
    folderId: z.string().min(1).nullish(),
    priority: prioritySchema.optional(),
    type: typeSchema.nullish(),
    executor: executorSchema.nullish(),
    // Leaf-only, as `type` is: a non-null value on an epic or story is refused
    // by the service as `DIFFICULTY_NOT_ALLOWED_ON_KIND` (422).
    difficulty: difficultySchema.nullish(),
    // The OBSOLESCENCE mark (MOTIR-6581): settable on ANY kind, with no kind
    // refusal, unlike `difficulty` — but only on a FINISHED card (MOTIR-6672): the
    // service refuses a mark on a status outside the done category as
    // `OBSOLESCENCE_REQUIRES_FINISHED` (422). `null` clears it. A value outside the
    // enum is `INVALID_OBSOLESCENCE` (422).
    obsolescence: obsolescenceSchema.nullish(),
    obsolescenceNoteMd: z.string().nullish(),
    storyPoints: storyPointsSchema.optional(),
    estimateMinutes: estimateMinutesSchema.optional(),
    targetRepo: z.string().nullish(),
    /** Replace the repository SET wholesale, or clear it with `[]`. Mutually
     *  exclusive with `targetRepo`, exactly as on create — the patch surface is
     *  never looser than the create one. */
    targetRepos: z.array(z.string()).optional(),
    /** Replace the repository REFERENCES wholesale, or clear them with `[]`
     *  (MOTIR-3039). Mutually exclusive with BOTH name fields, exactly as on
     *  create — the patch surface is never looser than the create one. */
    targetRepositories: z.array(z.string()).optional(),
    assigneeId: z.string().nullish(),
    dueDate: z.string().datetime().nullish(),
  })
  .strict();
export type UpdateWorkItemBody = z.infer<typeof updateWorkItemBodySchema>;

/**
 * Body fields whose refusal carries a TYPED code of its own rather than the
 * generic `INVALID_BODY`, per body schema (MOTIR-6581).
 *
 * WHY. `obsolescence` is validated TWICE, by design: here, by the enum the
 * document publishes, and in the service, whose `InvalidObsolescenceError`
 * (`INVALID_OBSOLESCENCE`, 422) is the backstop for a caller that bypasses the
 * wire schema. Without this map the SAME mistake would answer two different
 * codes depending on which check caught it — and over v1 the schema always
 * catches it first, so the typed code would be unreachable. Mapping the schema's
 * refusal to the service's code makes one mistake one code on every door.
 *
 * Keyed by schema IDENTITY, so the mapping applies to exactly these two bodies
 * and never to an unrelated body that happens to have a field of the same name.
 * Only a refusal AT the field itself (path `[field]`) is re-coded; the status is
 * the same 422 either way.
 */
const TYPED_FIELD_REFUSALS = new WeakMap<z.ZodType, Readonly<Record<string, string>>>([
  [
    createWorkItemBodySchema,
    { obsolescence: 'INVALID_OBSOLESCENCE', sections: 'INVALID_SECTIONS' },
  ],
  [
    updateWorkItemBodySchema,
    { obsolescence: 'INVALID_OBSOLESCENCE', sections: 'INVALID_SECTIONS' },
  ],
]);

/**
 * Parse a request body against a schema, or raise the v1 422.
 *
 * Centralised so every write endpoint reports a validation failure with the
 * SAME code and the same envelope — the ADR's "two error shapes means every
 * client writes two parsers", applied to the request side.
 */
export async function parseV1Body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new InvalidRequestError('INVALID_BODY', 'The request body is not valid JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const at = first?.path.length ? ` at \`${first.path.join('.')}\`` : '';
    const field = first?.path.length === 1 ? String(first.path[0]) : undefined;
    const typedCode = field === undefined ? undefined : TYPED_FIELD_REFUSALS.get(schema)?.[field];
    throw new InvalidRequestError(
      typedCode ?? 'INVALID_BODY',
      `The request body is invalid${at}: ${first?.message ?? 'validation failed'}.`,
    );
  }
  return parsed.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// The TRANSITIONS sub-resource (Story 11.2 · Subtask 11.2.7 — MOTIR-2048)
// ─────────────────────────────────────────────────────────────────────────────

/** One status a work item may move to from where it is now. */
export const transitionTargetSchema = z.object({
  key: z.string(),
  label: z.string(),
  category: z.enum(['todo', 'in_progress', 'done']),
});
export type TransitionTarget = z.infer<typeof transitionTargetSchema>;

/** The `GET …/transitions` body. */
export const transitionListSchema = z.object({ transitions: z.array(transitionTargetSchema) });

/**
 * The refusal body for an illegal move: the pinned `{ code, error }` PLUS an
 * additive `allowedTransitions` array.
 *
 * ⚠️ The allowed targets are DATA, not prose. `transition_status` appends them to
 * its human message because an agent reads English; a machine client must not be
 * reduced to parsing a sentence. A new field on a response object is explicitly
 * allowed under ADR §8, and declaring its shape HERE is what lets `GET …/transitions`
 * and this refusal be proven to agree.
 */
export const illegalTransitionSchema = z.object({
  code: z.literal('ILLEGAL_TRANSITION'),
  error: z.string(),
  allowedTransitions: z.array(transitionTargetSchema),
});

/**
 * The refusal body for a move an approval gate holds (MOTIR-5526): the pinned
 * `{ code, error }` PLUS an additive `gate` object — the SAME payload the board
 * move, the status server action and MCP carry, so a client renders whose
 * decision it is without parsing the sentence.
 */
export const approvalGatePendingSchema = z.object({
  code: z.literal('APPROVAL_GATE_PENDING'),
  error: z.string(),
  gate: z.object({
    itemKey: z.string(),
    kind: z.string(),
    waitingOn: z.enum(['decision', 'merge']),
    gateRaised: z.boolean(),
    canDecide: z.boolean(),
    routedToLabel: z.string().nullable(),
  }),
});

/**
 * The refusal body for a move out of Planning while an UNDECIDED plan holds the
 * card (MOTIR-6265; `agent-authored-plans.md` AMENDMENT 21 §2): the pinned
 * `{ code, error }` PLUS an additive `plan` object — the SAME payload the board
 * move, the status server action and MCP carry, so a client can say which plan
 * holds the card and send a person where it is decided.
 */
export const planTargetHeldSchema = z.object({
  code: z.literal('PLAN_TARGET_HELD'),
  error: z.string(),
  // A PLAN's hold, or — since 1.63.0 (AMENDMENT 23 §5; MOTIR-7640) — an OPEN
  // SESSION's, told apart by `kind`. A session hold has no plan, so its
  // `planId` / `planStatus` are null.
  plan: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('plan'),
      itemKey: z.string(),
      workItemId: z.string(),
      planId: z.string(),
      planStatus: z.enum(['generating', 'planned', 'stale']),
      sessionId: z.string().nullable(),
      anchorKey: z.string().nullable(),
    }),
    z.object({
      kind: z.literal('session'),
      itemKey: z.string(),
      workItemId: z.string(),
      planId: z.null(),
      planStatus: z.null(),
      sessionId: z.string(),
      anchorKey: z.string().nullable(),
      holderId: z.string().nullable(),
      holderName: z.string().nullable(),
      heldByViewer: z.boolean(),
    }),
  ]),
});

/**
 * The refusal body for a mark SET on an unfinished card (MOTIR-6672 · MOTIR-6673):
 * the pinned `{ code, error }` PLUS an additive `item` — the card and the status
 * it is at, whose category is not `done`. Answered by `createWorkItem` and
 * `updateWorkItem`; the remedy is to archive a card nobody will finish.
 */
export const obsolescenceRequiresFinishedSchema = z.object({
  code: z.literal('OBSOLESCENCE_REQUIRES_FINISHED'),
  error: z.string(),
  item: z.object({
    key: z.string(),
    statusKey: z.string(),
    statusCategory: z.string().nullable(),
  }),
});

/**
 * The refusal body for REOPENING a marked card (MOTIR-6672 · MOTIR-6673): the
 * pinned `{ code, error }` PLUS an additive `mark` — the marked card (the PARENT,
 * when the refused write is a child created or moved under it), its mark, and the
 * refused target status (`null` for a child write). Answered by
 * `transitionWorkItem`, and by `createWorkItem` / `updateWorkItem` for a marked
 * parent; the remedy is to clear the mark first.
 */
export const markedCardCannotReopenSchema = z.object({
  code: z.literal('MARKED_CARD_CANNOT_REOPEN'),
  error: z.string(),
  mark: z.object({
    key: z.string(),
    obsolescence: z.enum(['outdated', 'deprecated']),
    toStatusKey: z.string().nullable(),
  }),
});

/**
 * The MINIMAL ACTOR a v1 collection row embeds (Amendment 10 Q1).
 *
 * Two fields and no more: the id a client acts on (it is what 11.2's PATCH takes
 * back) and the name a client displays. Deliberately NOT a user resource — it
 * has no endpoint, no collection, no expansion and cannot be queried — which is
 * the distinction the pre-Amendment-10 rationale collapsed.
 *
 * Declared HERE, beside the other cross-resource shapes, because two resource
 * modules now use it: the ready row (Amendment 10 Q1) and the comment author
 * (11.5.14). `ready/schema.ts` already imports from this module, so declaring it
 * there and importing back would invert the dependency.
 */
export const actorRefSchema = z.object({
  id: z.string(),
  name: z.string(),
});

/**
 * The statuses legal FROM `fromStatusKey`, presented from a project's workflow.
 *
 * ONE function, used by BOTH the `GET` and the refusal path, so the two surfaces
 * cannot disagree about what is legal — the property 11.2.11's seam test asserts
 * end to end.
 */
export function presentTransitionTargets(
  workflow: {
    statuses: ReadonlyArray<{ id: string; key: string; label: string; category: string }>;
    transitions: ReadonlyArray<{ fromStatusId: string; toStatusId: string }>;
    policyMode: string;
  },
  fromStatusKey: string,
): TransitionTarget[] {
  const byId = new Map(workflow.statuses.map((s) => [s.id, s]));
  const from = workflow.statuses.find((s) => s.key === fromStatusKey);

  // An `open` policy project permits ANY move, so every other status is a legal
  // target — read off the policy rather than off the edge list, which is empty
  // in that mode and would otherwise report "nowhere to go".
  const targets =
    workflow.policyMode === 'open'
      ? workflow.statuses.filter((s) => s.key !== fromStatusKey)
      : workflow.transitions
          .filter((t) => from !== undefined && t.fromStatusId === from.id)
          .map((t) => byId.get(t.toStatusId))
          .filter((s): s is NonNullable<typeof s> => s !== undefined);

  return targets.map((s) => ({
    key: s.key,
    label: s.label,
    category: s.category as TransitionTarget['category'],
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// The COMMENTS sub-resource (Story 11.2 · Subtask 11.2.8 — MOTIR-2049)
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ A comment's cuid IS its identifier on the wire, and that is a DECISION, not
// a leak. ADR §7's key-only rule governs WORK-ITEM references: a work item has a
// `MOTIR-<n>` key, so naming it by cuid would freeze the primary key as contract
// when a stable public name already exists. A comment has no such key — there is
// nothing else to call it, and a client that cannot name a comment cannot reply
// to one. The same reasoning covers a user id and a sprint id.

// Exported (MOTIR-2229) so `lib/mcp/payloads/` can DERIVE the MCP comment
// payload from this exact declaration rather than re-authoring a look-alike.
// An added export, not a shape change: no field, name or nullability moves.
export const commentSchema = z.object({
  id: z.string(),
  parentCommentId: z.string().nullable(),
  /**
   * The author's id — KEPT beside `author`, not replaced by it. Removing a
   * shipped field is a §8 violation, and it stays the cheaper read for a client
   * that only routes on identity. `author.id` is the same value; a test asserts
   * they cannot diverge.
   */
  authorId: z.string(),
  /** Who wrote it, for a client that renders a name (Amendment 10 Q1). */
  author: actorRefSchema,
  bodyMd: z.string(),
  createdAt: isoDateTimeSchema,
  editedAt: isoDateTimeSchema.nullable(),
  mentionedUserIds: z.array(z.string()),
});
export type V1Comment = z.infer<typeof commentSchema>;

/** A root comment with its single-level thread, as the service returns it. */
export const commentThreadSchema = commentSchema.extend({
  replies: z.array(commentSchema),
});
export type V1CommentThread = z.infer<typeof commentThreadSchema>;

/** What {@link presentComment} reads — the shipped `CommentDTO` fields it maps. */
export interface CommentSource {
  id: string;
  parentCommentId: string | null;
  author: { id: string; name: string };
  bodyMd: string;
  createdAt: string;
  editedAt: string | null;
  mentionedUserIds: string[];
}

/** Map one comment to the wire, field by field — never a spread. */
export function presentComment(source: CommentSource): V1Comment {
  return {
    id: source.id,
    parentCommentId: source.parentCommentId,
    // The author's ID and NAME. The name arrived with ADR Amendment 10 Q1
    // (MOTIR-2283), which overturned the rationale this comment used to state —
    // "a public API must not acquire a second, accidental user resource".
    // That fear is right about a user RESOURCE and wrong about an embedded,
    // minimal, read-only actor: it has no endpoint, no collection, no expansion
    // and cannot be queried. Without it no client can render a comment thread
    // showing who wrote what, because v1 has no user endpoint to resolve an id
    // against — and both mirror products embed one. `avatarUrl` stays off.
    authorId: source.author.id,
    author: { id: source.author.id, name: source.author.name },
    bodyMd: source.bodyMd,
    createdAt: source.createdAt,
    editedAt: source.editedAt,
    mentionedUserIds: source.mentionedUserIds,
  };
}

/**
 * One attachment on the wire (Story MOTIR-3000 · Subtask MOTIR-3057).
 *
 * A deliberately SMALLER projection than the panel's `AttachmentDTO`. Three
 * fields are dropped and each for its own reason: `isImage` / `isPdf` are a
 * PRESENTATION split the panel derives so its lightbox need not re-derive it —
 * a public client has `mimeType` and can decide for itself, and shipping our
 * preview taxonomy would freeze it as contract; and `uploader.image` is an
 * avatar URL, which the comment presenter deliberately withholds too
 * (ADR Amendment 10 Q1 embeds a minimal actor, never a user resource).
 *
 * `contentPath` is named for what it IS, unlike the panel DTO's historical
 * `blobUrl`, which has carried a content PATH rather than a blob URL since
 * MOTIR-1667. A new contract does not inherit an old field's misnomer.
 */
export const attachmentSchema = z.object({
  id: z.string(),
  workItemKey: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  source: z.enum(['editor', 'panel', 'api']),
  contentPath: z.string(),
  uploader: z.object({ id: z.string(), name: z.string() }),
  createdAt: z.string(),
});
export type V1Attachment = z.infer<typeof attachmentSchema>;

/** What {@link presentAttachment} reads — the shipped `AttachmentDTO` fields it maps. */
export interface AttachmentSource {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  source: 'editor' | 'panel' | 'api';
  blobUrl: string;
  uploader: { id: string; name: string };
  createdAt: string;
}

/** Map one attachment to the wire, field by field — never a spread. */
export function presentAttachment(source: AttachmentSource, workItemKey: string): V1Attachment {
  return {
    id: source.id,
    // The KEY, not the internal id: v1 addresses work items by `MOTIR-<n>`
    // everywhere, and a response that answered with a cuid would hand a client
    // an identifier no other v1 route accepts.
    workItemKey,
    filename: source.filename,
    mimeType: source.mimeType,
    sizeBytes: source.sizeBytes,
    source: source.source,
    contentPath: source.blobUrl,
    uploader: { id: source.uploader.id, name: source.uploader.name },
    createdAt: source.createdAt,
  };
}

/** Map a root comment and its replies. */
export function presentCommentThread(
  source: CommentSource & { replies: CommentSource[] },
): V1CommentThread {
  return { ...presentComment(source), replies: source.replies.map(presentComment) };
}

/**
 * The comment count for one item, from the batch a route already read.
 *
 * `commentsService.getCommentCountsForItems` SEEDS every requested id with `0`
 * before it reads, so a miss here is unreachable — but `noUncheckedIndexedAccess`
 * still demands a fallback, and a bare `!` would assert something the type system
 * cannot see. Owned in ONE place so the five endpoints that present a detail do
 * not each carry the same untestable branch.
 */
export function commentCountFor(counts: Record<string, number>, itemId: string): number {
  /* v8 ignore next -- the service pre-seeds every requested id, so the fallback is unreachable */
  return counts[itemId] ?? 0;
}

// ── DESIGN (Story MOTIR-5553 · Subtask MOTIR-5560) ─────────────────────────
//
// The wire shapes for the three design operations, over
// `designAccessService`'s DTOs. `docs/decisions/design-result.md` AMENDMENT 5
// Q2 and Q6 are what they encode — in particular the discriminated verdict,
// which is what lets a client tell *this design is approved* from each of the
// five ways there is no design, without inspecting an empty list.

/** One file of an approved design. `url` / `expiresAt` only on a SINGLE read. */
export const designAssetSchema = z.object({
  kind: z.enum(['mock', 'image', 'note_file']),
  sourcePath: z.string(),
  fileName: z.string(),
  contentType: z.string().nullable(),
  byteSize: z.number().int().nullable(),
  /**
   * `unavailable` is a NORMAL answer, not an error: only an approval pins a
   * version's bytes, and the orphan-GC reclaims what no pin holds, so an
   * approved design can legitimately have lost its files (AMENDMENT 5 Q6).
   */
  state: z.enum(['available', 'unavailable']),
  /** A short-lived download link. Present only on an `available` asset of a
   *  SINGLE-design read — a list never mints a presign per row. */
  url: z.string().optional(),
  /** When {@link url} stops working. Present exactly when `url` is. */
  expiresAt: z.string().optional(),
});
export type V1DesignAsset = z.infer<typeof designAssetSchema>;

/** One approved design — the version an approval named (AMENDMENT 5 Q2, Q3). */
export const approvedDesignSchema = z.object({
  designCardKey: z.string(),
  designCardTitle: z.string(),
  /** The VERSION: the design-evidence row id, whose content never changes. */
  evidenceId: z.string(),
  publishedAt: z.string(),
  /** Provenance. Null is ordinary — a design published from a tree with no
   *  commit behind it. */
  commitSha: z.string().nullable(),
  assets: z.array(designAssetSchema),
});
export type V1ApprovedDesign = z.infer<typeof approvedDesignSchema>;

/**
 * What one design card answers — approved, or WHY not.
 *
 * ⚠️ FIVE reasons rather than an empty result. A consumer that cannot tell
 * `withdrawn` from `no_result`, or `not_done` from `not_a_design_card`, reports
 * the same nothing for four different histories — and the agent reading it has
 * no way to know whether to wait, to stop, or to say the card is mis-wired.
 */
export const designVerdictSchema = z.object({
  verdict: z.enum(['approved', 'not_approved']),
  designCardKey: z.string(),
  designCardTitle: z.string(),
  /** Present exactly when `verdict` is `approved`. */
  design: approvedDesignSchema.optional(),
  /** Present exactly when `verdict` is `not_approved`. */
  reason: z
    .enum(['not_a_design_card', 'not_done', 'cancelled', 'withdrawn', 'no_result'])
    .optional(),
});
export type V1DesignVerdict = z.infer<typeof designVerdictSchema>;

/** The `…/designs` body: one verdict per design card the item waits on. */
export const workItemDesignsSchema = z.object({ designs: z.array(designVerdictSchema) });
export type V1WorkItemDesigns = z.infer<typeof workItemDesignsSchema>;

// ── THE APPROVAL-GATE DECISION RECORD (Bug MOTIR-6191) ──────────────────────
//
// The wire shape for `GET /api/v1/work-items/{key}/approval-gate`, and — through
// `lib/mcp/payloads/approvalGates.ts` — for the `get_approval_gate` tool, so the
// two agent doors publish ONE shape. `docs/decisions/approval-gates.md` §6a is
// what it encodes: the audit set a gate row carries *"read months later by
// someone who was not there"*.
//
// ⚠️ A READ ONLY. Nothing here decides a gate, and §2's *"the decide route is
// session-authed and no MCP tool or `/api/v1` operation asserts the key"* stays
// true word for word — `approval:decide_any` is not asserted, mentioned or
// reachable from this resource.

const APPROVAL_GATE_KIND_VALUES = [
  'design_result',
  'decision_approval',
  'pull_request_approval',
  'pull_request_merge',
  'acceptance_result',
  'decision_choice',
  'decision_confirmation',
  'plan_approval',
  'agent_review',
  'manual_work',
  'planning_session',
] as const satisfies readonly ApprovalGateKindDTO[];
const _gateKindsTotal: AssertTotal<
  ApprovalGateKindDTO,
  (typeof APPROVAL_GATE_KIND_VALUES)[number]
> = true;

const APPROVAL_GATE_STATE_VALUES = [
  'awaiting',
  'approved',
  'changes_requested',
  'superseded',
  'overturned',
  'declined',
] as const satisfies readonly ApprovalGateStateDTO[];
const _gateStatesTotal: AssertTotal<
  ApprovalGateStateDTO,
  (typeof APPROVAL_GATE_STATE_VALUES)[number]
> = true;

const APPROVAL_GATE_AUTHORITY_VALUES = [
  'assignee',
  'reporter',
  'admin',
  'github_review',
  'plan_permission',
  'review_agent',
  'project_setting',
] as const satisfies readonly ApprovalGateAuthorityDTO[];
const _gateAuthoritiesTotal: AssertTotal<
  ApprovalGateAuthorityDTO,
  (typeof APPROVAL_GATE_AUTHORITY_VALUES)[number]
> = true;

/** What a design REFUSAL meant (MOTIR-6421; ADR `approval-gates.md` §10d). */
const APPROVAL_GATE_REFUSAL_VERDICT_VALUES = [
  'revise',
  're_plan',
] as const satisfies readonly ApprovalGateRefusalVerdictDTO[];
const _gateRefusalVerdictsTotal: AssertTotal<
  ApprovalGateRefusalVerdictDTO,
  (typeof APPROVAL_GATE_REFUSAL_VERDICT_VALUES)[number]
> = true;

const APPROVAL_GATE_SOURCE_VALUES = [
  'ui',
  'api',
  'mcp',
  'github',
  'system',
] as const satisfies readonly ApprovalGateDecisionSourceDTO[];
const _gateSourcesTotal: AssertTotal<
  ApprovalGateDecisionSourceDTO,
  (typeof APPROVAL_GATE_SOURCE_VALUES)[number]
> = true;

const APPROVAL_GATE_SUPERSEDE_CAUSE_VALUES = [
  'republished',
  'withdrawn',
  'head_moved',
  'member_closed',
  'member_drafted',
  'conflict',
  'set_changed',
  'pulled_back',
  'ci_failed',
  'ci_rerunning',
  'unknown',
  'plan_stale',
  'plan_discarded',
  'queue_failed',
  'review_agent_disabled',
  'agent_changes_requested',
  'subject_gone',
  'no_longer_manual',
  'closed_without_decision',
  'not_ready',
  'replanned',
  'answered',
  'session_ended',
] as const satisfies readonly ApprovalGateSupersedeCauseDTO[];
const _gateCausesTotal: AssertTotal<
  ApprovalGateSupersedeCauseDTO,
  (typeof APPROVAL_GATE_SUPERSEDE_CAUSE_VALUES)[number]
> = true;

/** Which vocabulary of decision verbs a gate carries (ADR §1). */
export const approvalGateKindSchema = z.enum(APPROVAL_GATE_KIND_VALUES);
export const approvalGateStateSchema = z.enum(APPROVAL_GATE_STATE_VALUES);

/**
 * ONE gate's decision record.
 *
 * ⚠️ READ `state` FIRST AND THE AUDIT SET SECOND. Every audit field is nullable
 * on the wire because it is nullable in the column, and for the same reason: five
 * are written BY the decision, so a null is *not yet decided* and never *decided
 * by nobody* (§6b's amendment). `awaiting` means the question is still open;
 * `superseded` means it was withdrawn before anyone answered, and carries
 * `supersededCause` rather than a decider.
 */
export const approvalGateDecisionSchema = z.object({
  id: z.string(),
  kind: approvalGateKindSchema,
  state: approvalGateStateSchema,
  /** Why they said yes, or WHAT THEY SENT BACK. Null while `awaiting`. */
  noteMd: z.string().nullable(),
  decidedAt: isoDateTimeSchema.nullable(),
  /** WHO decided, as a label that survives their departure from the workspace. */
  decidedByLabel: z.string().nullable(),
  /** UNDER WHICH permission they acted, frozen at decision time. */
  decidedUnderAuthority: z.enum(APPROVAL_GATE_AUTHORITY_VALUES).nullable(),
  /** THROUGH WHICH surface it arrived — `ui` is a human at a browser. */
  decisionSource: z.enum(APPROVAL_GATE_SOURCE_VALUES).nullable(),
  /** WHAT was decided, immutably: the subject's version at decision time. */
  subjectVersion: z.string().nullable(),
  /** WHY the question was withdrawn — `superseded` only, and never an actor. */
  supersededCause: z.enum(APPROVAL_GATE_SUPERSEDE_CAUSE_VALUES).nullable(),
  /** WHAT it caused — a merge commit sha, a status key, a chosen option's id. */
  outcomeRef: z.string().nullable(),
  /** WHAT A REFUSAL MEANT — `revise` or `re_plan` — on a `design_result` gate, or a story
   *  run's `acceptance_result` gate, sent back from Motir (MOTIR-6421, MOTIR-6501). Null on
   *  every other kind, run shape, verb and source. */
  refusalVerdict: z.enum(APPROVAL_GATE_REFUSAL_VERDICT_VALUES).nullable(),
  /** WHETHER A REFUSAL OF THIS GATE ASKS FOR A VERDICT (MOTIR-6501) — true exactly where a
   *  Motir `request_changes` must carry one: a `design_result`, or an `acceptance_result`
   *  whose story has an open delivery of its own. False once the gate is decided. */
  offersRefusalVerdict: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type V1ApprovalGateDecision = z.infer<typeof approvalGateDecisionSchema>;

/**
 * The `…/approval-gate` body — the ENVELOPE, which stays each surface's own.
 *
 * `gate: null` is an ANSWER: the card has no gate of that kind, so nothing is
 * waiting and nothing was decided. A key that does not resolve, or a project the
 * caller may not browse, is the 404 instead.
 */
export const approvalGateRecordSchema = z.object({
  workItemKey: workItemKeySchema,
  workItemTitle: z.string(),
  kind: approvalGateKindSchema,
  gate: approvalGateDecisionSchema.nullable(),
  /** WHOSE decision it is waiting on, as a name — the LIVE routing answer, not
   *  the gate's frozen `routedToId` (§2). Null when it routes to nobody. */
  routedToLabel: z.string().nullable(),
});
export type V1ApprovalGateRecord = z.infer<typeof approvalGateRecordSchema>;

/** Service DTO → the wire shape, field by field (this file's own header rule). */
export function presentApprovalGateRecord(dto: ApprovalGateRecordDTO): V1ApprovalGateRecord {
  return {
    workItemKey: dto.workItemKey,
    workItemTitle: dto.workItemTitle,
    kind: dto.kind,
    gate: dto.gate === null ? null : presentApprovalGateDecision(dto.gate),
    routedToLabel: dto.routedToLabel,
  };
}

function presentApprovalGateDecision(gate: ApprovalGateDecisionDTO): V1ApprovalGateDecision {
  return {
    id: gate.id,
    kind: gate.kind,
    state: gate.state,
    noteMd: gate.noteMd,
    decidedAt: gate.decidedAt,
    decidedByLabel: gate.decidedByLabel,
    decidedUnderAuthority: gate.decidedUnderAuthority,
    decisionSource: gate.decisionSource,
    subjectVersion: gate.subjectVersion,
    supersededCause: gate.supersededCause,
    outcomeRef: gate.outcomeRef,
    refusalVerdict: gate.refusalVerdict,
    offersRefusalVerdict: gate.offersRefusalVerdict,
    createdAt: gate.createdAt,
    updatedAt: gate.updatedAt,
  };
}

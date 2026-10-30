import { z } from 'zod/v4';
import { locales } from '@/lib/i18n/locales';
import {
  commentSchema,
  dependencyEdgesSchema,
  attachmentSchema,
  obsolescenceSchema,
  presentAttachment,
  presentComment,
  workItemChildSchema,
  workItemKeySchema,
  workItemRefSchema,
  workItemSummarySchema,
} from '@/lib/api/v1/workItems/schema';
import {
  presentReadyContainer,
  readyContainerSchema,
  readyItemSchema,
} from '@/lib/api/v1/ready/schema';
import { presentWorkItemClaim, workItemClaimSchema } from '@/lib/api/v1/workLoop/schema';
import type { WorkItemClaimDto } from '@/lib/dto/claim';
import type {
  WorkItemDependencyEdgesDto,
  WorkItemDto,
  WorkItemListItemDto,
  WorkItemSummaryDto,
} from '@/lib/dto/workItems';
import type { ReadyContainerDto, ReadyItemDispatchDto, ReadyItemDto } from '@/lib/dto/ready';
import type { InFlightCodeDto, PlanTreeSkeletonItem } from '@/lib/dto/ai';
import type { AttachmentDTO } from '@/lib/dto/attachments';
import type { CommentDTO } from '@/lib/dto/comments';
import type { MonitorIssueLinkDto } from '@/lib/dto/monitorIssueLink';
import type { LatestRefusalDTO } from '@/lib/dto/approvalGate';
import { definePayload } from './define';
import { parsedSectionsSchema } from './parsedSectionsSchema';

// The WORK-ITEM payload shapes (Story 11.6 · Subtask 11.6.2 — MOTIR-2228).
//
// `get_work_item` is the proving tool, and it is the right one: it is the tool at
// the centre of the founding defect (MOTIR-1849) — the one that LACKED the
// `dependencies` block its two siblings carried, invisibly, until a card had been
// planned on the assumption all three agreed.
//
// ── What derives, and what does not ─────────────────────────────────────────
// Per ADR Amendment 7 Q6 the ENVELOPE stays MCP's own: `get_work_item` returns
// the `IssueDetailDto` aggregate (`{ item, ancestors, parent, children, blockedBy,
// …, readiness, workflow, watcherCount, … }`) because that is the shape an agent
// reads a card from, and v1's flat `workItemDetailSchema` is shaped for a
// different caller. What derives is the aggregate's RESOURCE-VALUED parts — here
// the CHILD rows, which are exactly where the founding defect lived and exactly
// what `packages/cli/src/render.ts`'s `assignChildWaves` reads.

/**
 * A CHILD of the detail aggregate: v1's {@link workItemChildSchema} WIDENED with
 * the fields the MCP aggregate has always carried.
 *
 * A `.extend` rather than a look-alike, so a change to the v1 base breaks this
 * loudly instead of leaving two shapes that quietly mean different things — the
 * distinction ADR Amendment 7 Q6 turns on, and the one that is invisible in a
 * diff.
 *
 * ⚠️ **`key` changes meaning here, and it is the ONE non-additive change in
 * Story 11.6** (ADR Amendment 7 Q6 addendum). It was the NUMERIC key on this row
 * and the `<KEY>-<n>` identifier on `/api/v1` — and on MCP's own `list_ready`
 * rows. It is now the identifier everywhere, and the numeric key is preserved as
 * `numericKey`, so nothing is lost. `@motir/cli` never read the numeric one
 * (`grep -rn "key: number" packages/cli/src/` → no matches; its `WorkItemSummary`
 * declares `identifier`, `kind`, `title`, `status` and no `key` at all).
 */
export const mcpWorkItemChildSchema = workItemChildSchema.extend({
  /** The internal row id — what `excludeIds` and the edge reader are keyed by. */
  id: z.string(),
  /** The numeric key. Was `key` before MOTIR-2228; renamed, never dropped. */
  numericKey: z.number().int(),
  /** The `<KEY>-<n>` identifier. Retained beside v1's `key`, which now holds the
   *  same value — every existing reader of `identifier` keeps working. */
  identifier: workItemKeySchema,
  /** The parent's internal id (v1 publishes `parentKey` instead; both ride). */
  parentId: z.string().nullable(),
  /** The fractional rank, which v1 does not publish. */
  position: z.string(),
  /** The archive timestamp; v1 narrows this to the boolean `archived`. */
  archivedAt: z.string().nullable(),
  /** The OBSOLESCENCE mark (Story MOTIR-6574 · MOTIR-6582) — `outdated` ·
   *  `deprecated`, or null while the child is still true of the code. v1's child
   *  ref does not carry it, so it is part of the MCP widening. Informational: a
   *  marked child is never dropped or re-ordered. */
  obsolescence: obsolescenceSchema.nullable(),
  /** The Markdown note saying WHY the child is marked; null when none. */
  obsolescenceNoteMd: z.string().nullable(),
});
export type McpWorkItemChild = z.infer<typeof mcpWorkItemChildSchema>;

/**
 * The `get_work_item` payload.
 *
 * The envelope is `catchall`-open on purpose: the aggregate carries `workflow`,
 * `labels`, `components`, `customFields`, `watcherCount`, `viewerIsWatching` and
 * the four other link groups, none of which v1 describes and none of which this
 * story is re-shaping. Declaring them here would fork a second description of
 * `IssueDetailDto` — the very thing being removed — so the schema pins the parts
 * that DERIVE and passes the rest through untouched.
 */
/**
 * One monitor link on a work item, as `get_work_item` returns it under
 * `errors` (Story MOTIR-5975 · Subtask MOTIR-5981) — `MonitorIssueLinkDto`, the
 * SAME row the item page's Errors section renders, read by the same
 * `monitorIssueService.listForWorkItem`. Declared so the parse at the tool
 * rejects a row that drifted from it: an `evidence` block is REQUIRED.
 */
const monitorEvidenceSchema = z.object({
  state: z.enum(['never_read', 'present', 'no_exception']),
  stale: z.boolean(),
  exception: z.object({ type: z.string().nullable(), message: z.string().nullable() }).nullable(),
  frames: z.array(
    z.object({
      filePath: z.string(),
      function: z.string().nullable(),
      lineNumber: z.number().nullable(),
      inApp: z.boolean().nullable(),
    }),
  ),
  tags: z.array(z.object({ key: z.string(), value: z.string() })),
  request: z.object({ method: z.string().nullable(), path: z.string() }).nullable(),
  eventId: z.string().nullable(),
  eventAt: z.string().nullable(),
  readAt: z.string().nullable(),
  lastFailedAt: z.string().nullable(),
});

export const mcpMonitorIssueLinkSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    level: z.string().nullable(),
    culprit: z.string().nullable(),
    permalink: z.string().nullable(),
    eventCount: z.number(),
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
    environment: z.string().nullable(),
    release: z.string().nullable(),
    connection: z.object({
      id: z.string(),
      orgSlug: z.string().nullable(),
      projectSlug: z.string(),
    }),
    evidence: monitorEvidenceSchema,
  })
  // The resolve-back and assignee notes ride through unchanged; the fields an
  // agent is TOLD to rely on are the ones named above.
  .catchall(z.unknown());

/** The recorded language of each work-text field (Story MOTIR-7731 · MOTIR-8098)
 *  — a locale code, or `null` when none was recorded (text written before
 *  content languages, and imported text). Never defaulted to `en`. */
const localeOrNull = z.enum(locales).nullable();
export const mcpWorkItemLanguagesSchema = z.object({
  title: localeOrNull,
  description: localeOrNull,
  explanation: localeOrNull,
});

/** `get_work_item`'s `latestRefusal` — {@link LatestRefusalDTO}, field for field. */
const mcpLatestRefusalSchema = z.object({
  gateId: z.string(),
  kind: z.string(),
  noteMd: z.string().nullable(),
  decidedByLabel: z.string().nullable(),
  decidedAt: z.string(),
  decisionSource: z.enum(['ui', 'api', 'mcp', 'github', 'system']).nullable(),
  refusalVerdict: z.enum(['revise', 're_plan']).nullable(),
  subjectVersion: z.string().nullable(),
});

/**
 * One `inFlightCode` entry on `get_work_item` (MOTIR-10069) — the same
 * `InFlightCodeDto` the hosted planner's item read carries (MOTIR-6618).
 */
const mcpInFlightCodeSchema = z.union([
  z.object({
    repo: z.string(),
    branch: z.string(),
    headSha: z.string().nullable(),
    prNumber: z.number(),
    prUrl: z.string(),
    draft: z.boolean(),
    baseRef: z.string().nullable(),
    source: z.literal('own'),
  }),
  z.object({
    repo: z.string(),
    branch: z.string(),
    headSha: z.string().nullable(),
    prNumber: z.number(),
    prUrl: z.string(),
    draft: z.boolean(),
    baseRef: z.string().nullable(),
    source: z.literal('inherited'),
    fromKey: z.string(),
  }),
]);

export const getWorkItemPayload = definePayload({
  schema: z
    .object({
      children: z.array(mcpWorkItemChildSchema),
      /**
       * The item's OWN folder placement (Story MOTIR-5310 · MOTIR-5413): the
       * folder it is filed in and that folder's path, names root-first — both
       * `null` for an unfiled item. The same vocabulary `/api/v1`'s detail read
       * publishes (MOTIR-5412). DECLARED here rather than left to the aggregate
       * spread, which used to leak the bare id with no path, and optional only
       * because the projected answer (`planId`) has no committed row to place.
       */
      folderId: z.string().nullable().optional(),
      folderPath: z.array(z.string()).nullable().optional(),
      /**
       * The work item's monitor links with their stored facts and EVIDENCE
       * (Story MOTIR-5975 · MOTIR-5981) — read from Motir's store, never live
       * from the monitor. `[]` for a work item with none; absent on the
       * projected answer, where a proposal has no link.
       */
      errors: z.array(mcpMonitorIssueLinkSchema).optional(),
      /**
       * The LATEST REFUSAL (Story MOTIR-6070 · MOTIR-6422) — present when the item's
       * most recently DECIDED gate, of any kind, is `changes_requested`; `null`
       * otherwise. Absent on the projected answer, where a proposal has no gate.
       */
      latestRefusal: mcpLatestRefusalSchema.nullable().optional(),
      /**
       * WHERE the item's UNMERGED code is (MOTIR-10069), per repository: its own
       * open pull request, else the nearest ancestor's (`inherited`, `fromKey`).
       * `[]` when none; absent on the projected answer, where a proposal has no
       * pull request.
       */
      inFlightCode: z.array(mcpInFlightCodeSchema).optional(),
      /** The repositories where the item's own delivery has merged (MOTIR-10069). */
      mergedRepos: z.array(z.string()).optional(),
      /**
       * The item itself — its columns ride through unchanged; DECLARED here is
       * `languages` (Story MOTIR-7731 · MOTIR-8098): each text field's recorded
       * language, `null` when none was recorded. Optional only for the
       * projected answer.
       */
      item: z
        .object({ languages: mcpWorkItemLanguagesSchema.optional() })
        .catchall(z.unknown())
        .optional(),
      /**
       * The OPTIONAL sections view (MOTIR-9033): the body parsed at read time,
       * present only when `includeSections` was asked for — on the committed
       * answer and on the projected one alike.
       */
      parsedSections: parsedSectionsSchema.optional(),
    })
    .catchall(z.unknown()) as unknown as z.ZodType<
    {
      children: McpWorkItemChild[];
      folderId?: string | null;
      folderPath?: string[] | null;
      errors?: MonitorIssueLinkDto[];
      latestRefusal?: LatestRefusalDTO | null;
      inFlightCode?: InFlightCodeDto[];
      mergedRepos?: string[];
      parsedSections?: z.infer<typeof parsedSectionsSchema>;
    } & Record<string, unknown>
  >,
  probes: [
    // The child rows, against v1's `WorkItemRef`. This is the comparison whose
    // absence started the story.
    { resource: 'WorkItemRef', select: (p) => p.children },
  ],
});

/**
 * Map one aggregate child + its edges to the MCP child row.
 *
 * Field by field, never a spread — the same discipline the v1 mappers use, and
 * for the same reason: a spread makes every future column of the DTO part of the
 * payload by accident.
 */
export function presentMcpWorkItemChild(
  child: WorkItemSummaryDto,
  edges: WorkItemDependencyEdgesDto | undefined,
  keyOfId: (id: string) => string | undefined,
): McpWorkItemChild {
  return {
    // v1's `workItemChildSchema` half
    key: child.identifier,
    kind: child.kind,
    title: child.title,
    status: child.status,
    priority: child.priority,
    assigneeId: child.assigneeId,
    estimateMinutes: child.estimateMinutes,
    storyPoints: child.storyPoints,
    parentKey: child.parentId === null ? null : (keyOfId(child.parentId) ?? null),
    archived: child.archivedAt !== null,
    // TOTAL by construction, exactly as `lib/mcp/dependencyEdges.ts` promises:
    // a child the reader returned nothing for still gets two EMPTY arrays.
    dependencies: edges ?? { blockedBy: [], blocks: [] },
    // the MCP widening
    id: child.id,
    numericKey: child.key,
    identifier: child.identifier,
    parentId: child.parentId,
    position: child.position,
    archivedAt: child.archivedAt,
    obsolescence: child.obsolescence,
    obsolescenceNoteMd: child.obsolescenceNoteMd,
  };
}

/** The edge block's own schema, re-exported so a family card can compose it
 *  without reaching across the seam into the v1 module. */
export { dependencyEdgesSchema };

// ─────────────────────────────────────────────────────────────────────────────
// The WORK-ITEM family (Story 11.6 · Subtask 11.6.3 — MOTIR-2229)
// ─────────────────────────────────────────────────────────────────────────────
//
// Three shapes cover fifteen tools, each a DECLARED derivation of a v1 schema:
//
//   mcpWorkItemSchema  every WRITE that returns the item it touched — a
//                      NARROWING (`.omit({ dependencies })`, since a write does
//                      not read the graph) widened with the aggregate columns.
//   mcpWorkItemRowSchema  the SEARCH row — a narrowing of the collection row
//                      (`.omit({ createdAt })`, which the MCP list projection
//                      does not read) plus the transport attachments.
//   mcpReadyRowSchema  the READY row and its dispatch superset.
//
// ⚠️ The narrowings are the subtle half. A `.omit` off the shared schema breaks
// LOUDLY when the base changes; a hand-built object that resembles the schema
// goes on compiling and quietly means something else. Those two look identical
// in a diff and are opposite in kind — which is the whole subject of this story.
//
// ⚠️ On the enum-valued MCP-ONLY extras (`executor`, `planningSource`, …) the
// schemas below are permissive strings. That is deliberate, not laziness: the
// SHARED half carries v1's exact enums through the base schema, and it is the
// only half with a second consumer. A runtime enum check on a field no other
// surface reads buys nothing the TypeScript type does not already give, and a
// second copy of a vocabulary is what this story exists to remove.

/** The columns every write-returning tool's `WorkItemDto` adds on top of the
 *  shared collection row. Declared once — fourteen tools return this shape. */
const workItemDtoExtras = {
  id: z.string(),
  projectId: z.string(),
  parentId: z.string().nullable(),
  /** The numeric key. Was `key` before MOTIR-2228; renamed, never dropped. */
  numericKey: z.number().int(),
  identifier: workItemKeySchema,
  descriptionMd: z.string().nullable(),
  explanationMd: z.string().nullable(),
  explanationSource: z.string(),
  languages: mcpWorkItemLanguagesSchema,
  executor: z.string().nullable(),
  /** How hard the leaf is to reason about (Story MOTIR-6016) — `low` | `medium`
   *  | `high`, or null (always null on an epic or story). */
  difficulty: z.string().nullable(),
  position: z.string(),
  sprintId: z.string().nullable(),
  backlogRank: z.string().nullable(),
  publicChildrenHidden: z.boolean(),
  sessionBranch: z.string().nullable(),
  targetRepo: z.string().nullable(),
  /** EVERY repository the item ships in (MOTIR-2728) — ordered, element 0 the
   *  primary, which is what `targetRepo` above holds. The ITEM shape gains the
   *  set; the DISPATCH shape below stays single-valued, because a dispatch routes
   *  an agent into ONE checkout (ADR §2). */
  targetRepos: z.array(z.string()),
  /** The same repositories as RESOLVED REFERENCES (MOTIR-3041) — `ref` is the
   *  identity an agent pins with (`targetRepositories` on the write tools), `name`
   *  is what it resolves to, and `state` is what tells a `proposed` row from a
   *  repository that exists. Additive: the two name fields above are unchanged. */
  targetRepositories: z
    .array(
      z.object({
        ref: z.string(),
        name: z.string(),
        role: z.string(),
        label: z.string().nullable(),
        state: z.string(),
        primary: z.boolean(),
      }),
    )
    .optional(),
  planningSource: z.string().nullable(),
  planningHarness: z.string().nullable(),
  planningModel: z.string().nullable(),
  implementationSource: z.string().nullable(),
  implementationHarness: z.string().nullable(),
  implementationModel: z.string().nullable(),
  archivedAt: z.string().nullable(),
};

/**
 * A whole work item, as every WRITE tool returns it.
 *
 * `.omit({ dependencies })` is the declared NARROWING: a write reports the row
 * it changed and does not read the dependency graph, so shipping two empty
 * arrays would be a claim the tool never checked.
 */
export const mcpWorkItemSchema = workItemSummarySchema
  .omit({ dependencies: true })
  .extend(workItemDtoExtras);
export type McpWorkItem = z.infer<typeof mcpWorkItemSchema>;

/** Map a `WorkItemDto` to the write-confirmation shape — field by field. */
export function presentMcpWorkItem(dto: WorkItemDto): McpWorkItem {
  return {
    // the shared half
    key: dto.identifier,
    kind: dto.kind,
    type: dto.type,
    title: dto.title,
    status: dto.status,
    priority: dto.priority,
    assigneeId: dto.assigneeId,
    reporterId: dto.reporterId,
    dueDate: dto.dueDate,
    estimateMinutes: dto.estimateMinutes,
    storyPoints: dto.storyPoints,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    // The obsolescence mark rides the SHARED half since MOTIR-6581 put it on the
    // v1 row this payload derives from; MOTIR-6582 documents it on every door.
    obsolescence: dto.obsolescence,
    obsolescenceNoteMd: dto.obsolescenceNoteMd,
    // the MCP widening
    id: dto.id,
    projectId: dto.projectId,
    parentId: dto.parentId,
    numericKey: dto.key,
    identifier: dto.identifier,
    descriptionMd: dto.descriptionMd,
    explanationMd: dto.explanationMd,
    explanationSource: dto.explanationSource,
    languages: {
      title: dto.languages.title,
      description: dto.languages.description,
      explanation: dto.languages.explanation,
    },
    executor: dto.executor,
    difficulty: dto.difficulty,
    position: dto.position,
    sprintId: dto.sprintId,
    backlogRank: dto.backlogRank,
    publicChildrenHidden: dto.publicChildrenHidden,
    sessionBranch: dto.sessionBranch,
    targetRepo: dto.targetRepo,
    targetRepos: dto.targetRepos,
    ...(dto.targetRepositories === undefined ? {} : { targetRepositories: dto.targetRepositories }),
    planningSource: dto.planningSource,
    planningHarness: dto.planningHarness,
    planningModel: dto.planningModel,
    implementationSource: dto.implementationSource,
    implementationHarness: dto.implementationHarness,
    implementationModel: dto.implementationModel,
    archivedAt: dto.archivedAt,
  };
}

/**
 * Where a work item sits after a PLACING write (Story MOTIR-5310 · MOTIR-5413):
 * its work-item parent by key, or the folder it is filed in with that folder's
 * path. At most one side is set — a filed item is a root.
 */
export const workItemPlacementSchema = z.object({
  parentKey: workItemKeySchema.nullable(),
  folderId: z.string().nullable(),
  folderPath: z.array(z.string()).nullable(),
});
export type WorkItemPlacement = z.infer<typeof workItemPlacementSchema>;

/**
 * The write confirmation for the two tools that PLACE an item —
 * `create_work_item` and `move_to_parent`. The shared {@link McpWorkItem} plus a
 * `placement` field on THIS payload only: `McpWorkItem` is returned by a dozen
 * other tools, and widening it would put a folder read on every one of them.
 */
export const workItemPlacementWritePayload = definePayload({
  schema: mcpWorkItemSchema.extend({ placement: workItemPlacementSchema }) as unknown as z.ZodType<
    McpWorkItem & { placement: WorkItemPlacement } & Record<string, unknown>
  >,
  // No probe, for the reason `workItemWritePayload` gives: a narrowing of the
  // summary row cannot satisfy `WorkItemSummary`.
  probes: [],
});

/** The bare write-confirmation payload — fourteen tools share it. */
export const workItemWritePayload = definePayload({
  schema: mcpWorkItemSchema as unknown as z.ZodType<McpWorkItem & Record<string, unknown>>,
  // No probe: this is a NARROWING (no `dependencies`), so it cannot satisfy
  // `WorkItemSummary` and must not claim to. The derivation is proven at the
  // TYPE level instead — `.omit` off the base breaks when the base does.
  probes: [],
});

/**
 * A SEARCH row.
 *
 * `.omit({ createdAt })` is the declared narrowing: the flat List projection
 * `search_work_items` reads does not carry it (v1's collection route sources it
 * from the keyset read's cursor position, which this tool has no equivalent of).
 * Everything else is the shared row, `dependencies` included — the block whose
 * absence on `get_work_item` started this story.
 */
export const mcpWorkItemRowSchema = workItemSummarySchema.omit({ createdAt: true }).extend({
  id: z.string(),
  numericKey: z.number().int(),
  identifier: workItemKeySchema,
  hasDescription: z.boolean(),
  commentCount: z.number().int(),
});
export type McpWorkItemRow = z.infer<typeof mcpWorkItemRowSchema>;

/** Map one list row + its transport attachments to the search row. */
export function presentMcpWorkItemRow(
  item: WorkItemListItemDto,
  edges: WorkItemDependencyEdgesDto | undefined,
  commentCount: number,
): McpWorkItemRow {
  return {
    key: item.identifier,
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
    updatedAt: item.updatedAt,
    obsolescence: item.obsolescence,
    obsolescenceNoteMd: item.obsolescenceNoteMd,
    dependencies: edges ?? { blockedBy: [], blocks: [] },
    id: item.id,
    numericKey: item.key,
    identifier: item.identifier,
    hasDescription: item.hasDescription,
    commentCount,
  };
}

/** The `search_work_items` page. */
export const searchWorkItemsPayload = definePayload({
  schema: z
    .object({
      items: z.array(mcpWorkItemRowSchema),
      total: z.number().int(),
      nextCursor: z.string().nullable(),
    })
    .catchall(z.unknown()) as unknown as z.ZodType<
    { items: McpWorkItemRow[]; total: number; nextCursor: string | null } & Record<string, unknown>
  >,
  // No probe for the same reason as the write shape: the row is a narrowing
  // (no `createdAt`). Its `dependencies` block still comes from the shared
  // schema, which is the property this card was written for.
  probes: [],
});

/**
 * A READY row.
 *
 * A pure WIDENING — every field `readyItemSchema` declares is present with the
 * same value, so a ready row VALIDATES against the v1 schema and the drift guard
 * has something real to compare. `assigneeId` is the one field the MCP row did
 * not carry (it had the fuller `assignee` object); it arrives ALONGSIDE, never
 * instead of, so nothing a caller reads today moves.
 */
export const mcpReadyRowSchema = readyItemSchema.extend({
  id: z.string(),
  assignee: z
    .object({ id: z.string(), name: z.string(), avatarUrl: z.string().nullable() })
    .nullable(),
  descriptionMd: z.string().nullable(),
  commentCount: z.number().int(),
  /**
   * The runnable container a LANE row groups under (MOTIR-6833), as the v1
   * `ReadyLaneItem` carries it — present on every `list_ready` / `next_ready`
   * row now that both read a lane, absent on `claim_next_ready`, which keeps the
   * unlaned set.
   */
  container: readyContainerSchema.nullable().optional(),
});
export type McpReadyRow = z.infer<typeof mcpReadyRowSchema>;

/**
 * A CONTAINERS-lane row (MOTIR-6833): the v1 `ReadyContainer`, widened with the
 * id an agent passes back in `excludeIds` and the parent-run command.
 */
export const mcpReadyContainerSchema = readyContainerSchema.extend({
  id: z.string(),
  runCommand: z.string(),
});
export type McpReadyContainer = z.infer<typeof mcpReadyContainerSchema>;

/** Map one containers-lane row. */
export function presentMcpReadyContainer(row: ReadyContainerDto): McpReadyContainer {
  return {
    key: row.key,
    kind: row.kind,
    title: row.title,
    priority: row.priority,
    assigneeId: row.assignee?.id ?? null,
    assignee: row.assignee === null ? null : { id: row.assignee.id, name: row.assignee.name },
    readyLeafCount: row.readyLeafCount,
    childCount: row.childCount,
    id: row.id,
    runCommand: `motir run ${row.key}`,
  };
}

/** The dispatch superset `next_ready` / `claim_next_ready` return. */
export const mcpReadyDispatchSchema = mcpReadyRowSchema.extend({
  contextRefs: z.array(z.string()),
  blockerKeys: z.array(z.string()),
  parentKey: z.string().nullable(),
  runCommand: z.string(),
  sessionBranch: z.string().nullable(),
  targetRepo: z.string().nullable(),
  targetRepoCloneUrl: z.string().nullable(),
  targetRepoDefaultBranch: z.string().nullable(),
});
export type McpReadyDispatch = z.infer<typeof mcpReadyDispatchSchema>;

/** The shared half of a ready row — reused by the dispatch mapper below. */
function readyRowFields(
  item: ReadyItemDto,
  edges: WorkItemDependencyEdgesDto | undefined,
  commentCount: number,
): McpReadyRow {
  return {
    key: item.key,
    kind: item.kind,
    title: item.title,
    priority: item.priority,
    status: { key: item.status.key, category: item.status.category },
    type: item.type,
    executor: item.executor,
    difficulty: item.difficulty,
    // Derived from the v1 ready row (MOTIR-6581), as every field here is.
    obsolescence: item.obsolescence,
    obsolescenceNoteMd: item.obsolescenceNoteMd,
    // The v1 field, derived from the object MCP already carried. Additive.
    assigneeId: item.assignee?.id ?? null,
    descriptionExcerpt: item.descriptionExcerpt,
    // Amendment 17's readiness qualifier, arriving here because this payload
    // DERIVES from the v1 row (Amendment 7). The dispatch superset below still
    // carries `sessionBranch` — the same value addressed as an instruction —
    // and the two coexist for the reason the ready schema records: one is a fact
    // about the item's dependencies, the other is what to do about it.
    inheritedSessionBranch: item.inheritedSessionBranch,
    dependencies: edges ?? { blockedBy: [], blocks: [] },
    id: item.id,
    assignee: item.assignee,
    descriptionMd: item.descriptionMd,
    commentCount,
    ...(item.container !== undefined
      ? {
          container: item.container === null ? null : presentReadyContainer(item.container),
        }
      : {}),
  };
}

/** Map one ready row + its transport attachments. */
export function presentMcpReadyRow(
  item: ReadyItemDto,
  edges: WorkItemDependencyEdgesDto | undefined,
  commentCount: number,
): McpReadyRow {
  return readyRowFields(item, edges, commentCount);
}

/** Map one DISPATCH row — the ready row plus what a runner needs to start. */
export function presentMcpReadyDispatch(
  item: ReadyItemDispatchDto,
  commentCount: number,
): McpReadyDispatch {
  return {
    ...readyRowFields(item, undefined, commentCount),
    contextRefs: item.contextRefs,
    blockerKeys: item.blockerKeys,
    parentKey: item.parentKey,
    runCommand: item.runCommand,
    sessionBranch: item.sessionBranch,
    targetRepo: item.targetRepo,
    targetRepoCloneUrl: item.targetRepoCloneUrl,
    targetRepoDefaultBranch: item.targetRepoDefaultBranch,
  };
}

/**
 * The `list_ready` page (MOTIR-6833: it reads a LANE). A `leaf` / `bug` page
 * holds ready rows, each carrying its `container`; a `container` page holds
 * container rows. `lane` says which, and the probes follow it.
 */
export const listReadyPayload = definePayload({
  schema: z
    .object({
      lane: z.enum(['leaf', 'container', 'bug']),
      items: z.array(z.union([mcpReadyContainerSchema, mcpReadyRowSchema])),
      nextCursor: z.string().nullable(),
    })
    .catchall(z.unknown()) as unknown as z.ZodType<
    {
      lane: 'leaf' | 'container' | 'bug';
      items: Array<McpReadyRow | McpReadyContainer>;
      nextCursor: string | null;
    } & Record<string, unknown>
  >,
  probes: [
    { resource: 'ReadyLaneItem', select: (p) => (p.lane === 'container' ? [] : p.items) },
    { resource: 'ReadyContainer', select: (p) => (p.lane === 'container' ? p.items : []) },
  ],
});

/**
 * The `next_ready` peek — the next row of a `leaf` / `bug` lane as `item`, or the
 * next runnable container as `container` (MOTIR-6833). Each is null when that
 * lane is exhausted or was not asked for.
 */
export const nextReadyPayload = definePayload({
  schema: z
    .object({
      lane: z.enum(['leaf', 'container', 'bug']),
      item: mcpReadyDispatchSchema.nullable(),
      container: mcpReadyContainerSchema.nullable(),
    })
    .catchall(z.unknown()) as unknown as z.ZodType<
    {
      lane: 'leaf' | 'container' | 'bug';
      item: McpReadyDispatch | null;
      container: McpReadyContainer | null;
    } & Record<string, unknown>
  >,
  probes: [
    { resource: 'ReadyLaneItem', select: (p) => (p.item ? [p.item] : []) },
    { resource: 'ReadyContainer', select: (p) => (p.container ? [p.container] : []) },
  ],
});

/** The `claim_next_ready` result — the same item plus the advisories block. */
export const claimNextReadyPayload = definePayload({
  schema: z
    .object({ item: mcpReadyDispatchSchema.nullable() })
    .catchall(z.unknown()) as unknown as z.ZodType<
    { item: McpReadyDispatch | null } & Record<string, unknown>
  >,
  probes: [{ resource: 'ReadyItem', select: (p) => (p.item ? [p.item] : []) }],
});

/**
 * The `claim_work_item` result (MOTIR-2961) — v1's `WorkItemClaim`, unchanged.
 *
 * Not a widening and not a narrowing: the two surfaces call ONE service method
 * and there is nothing an agent needs here that a client does not. Re-exporting
 * the v1 schema rather than restating it is what makes the probe below a real
 * check instead of a comparison of a shape against itself.
 */
export const mcpWorkItemClaimSchema = workItemClaimSchema;
export type McpWorkItemClaim = z.infer<typeof mcpWorkItemClaimSchema>;

/** Map the claim result for the MCP transport — through v1's own presenter, so
 *  the two surfaces cannot drift by construction. */
export function presentMcpWorkItemClaim(dto: WorkItemClaimDto): McpWorkItemClaim {
  return presentWorkItemClaim(dto);
}

/** The `claim_work_item` payload. The whole payload IS the shared resource, so
 *  the probe selects the payload itself. */
export const claimWorkItemPayload = definePayload({
  schema: mcpWorkItemClaimSchema.catchall(z.unknown()) as unknown as z.ZodType<
    McpWorkItemClaim & Record<string, unknown>
  >,
  probes: [{ resource: 'WorkItemClaim', select: (p) => [p] }],
});

/**
 * A COMMENT, as `add_comment` returns it — a pure WIDENING of v1's comment
 * shape, so the row validates against it unchanged.
 *
 * `authorId` is the field the MCP payload did not carry (it had the richer
 * `author` object, which the web app renders). It arrives ALONGSIDE, never
 * instead of — the additive rule of ADR Amendment 7 Q6.
 */
export const mcpCommentSchema = commentSchema.extend({
  workItemId: z.string(),
  author: z.object({ id: z.string(), name: z.string(), image: z.string().nullable() }),
});
export type McpComment = z.infer<typeof mcpCommentSchema>;

/** Map one `CommentDTO` — the shared half through v1's own presenter. */
export function presentMcpComment(dto: CommentDTO): McpComment {
  return {
    ...presentComment(dto),
    workItemId: dto.workItemId,
    author: dto.author,
  };
}

/**
 * An ATTACHMENT, as `attach_file` returns it — v1's attachment shape verbatim.
 *
 * No widening at all, deliberately. The v1 projection already carries everything
 * an agent needs to report what it attached (the id, the filename, the size, the
 * authenticated content path), and the two fields the PANEL's DTO has on top —
 * `isImage` / `isPdf` — are a presentation split, not data. A payload that
 * widened here would make the two doors describe one row differently.
 */
export const mcpAttachmentSchema = attachmentSchema;
export type McpAttachment = z.infer<typeof mcpAttachmentSchema>;

/** Map one `AttachmentDTO` through v1's own presenter — one shape, one mapper. */
export function presentMcpAttachment(dto: AttachmentDTO, workItemKey: string): McpAttachment {
  return presentAttachment(dto, workItemKey);
}

/** The `attach_file` confirmation. */
export const attachFilePayload = definePayload({
  schema: mcpAttachmentSchema as unknown as z.ZodType<McpAttachment & Record<string, unknown>>,
  probes: [{ resource: 'Attachment', select: (p) => [p] }],
});

/** The `add_comment` confirmation. */
export const addCommentPayload = definePayload({
  schema: mcpCommentSchema as unknown as z.ZodType<McpComment & Record<string, unknown>>,
  // No probe: `CommentThread` is the registered component and requires
  // `replies`, which a just-created comment has none of. The derivation is the
  // `.extend` off `commentSchema` plus `presentComment` — v1's own mapper.
  probes: [],
});

/**
 * One row of the plan-tree BREADTH projection — the shape `skeleton` returns
 * (Story MOTIR-3098 · Subtask MOTIR-3100).
 *
 * A declared NARROWING of v1's {@link workItemRefSchema}: `.pick`ing the five
 * fields `aiBoundaryService.readPlanTree` actually projects, so the shared half
 * cannot drift (a `kind` or `parentKey` that changes type on one surface breaks
 * the type here), and `.extend`ing the two anchors the MCP row carries that no
 * v1 shape does.
 *
 * `readPlanTree` reads `WorkItemSummaryDto` and drops `priority`, `assigneeId`,
 * `estimateMinutes`, `storyPoints` and `archived` on the way out — deliberately,
 * because this read exists to be CHEAP over a whole project. Widening it to
 * satisfy the full ref would change the two internal routes MOTIR-3100 is
 * explicitly not allowed to touch, so the narrowing is the honest description,
 * and it carries no probe for the same reason `searchWorkItemsPayload` does not.
 *
 * The two extensions are not decoration. `id` is the real work-item cuid that
 * `add_plan_items`' `parentRef` / `blockedByRefs` take (they refuse a
 * `<KEY>-<n>` key), and `revision` is the `baseRevision` a `modify` / `remove`
 * proposal anchors on. Both ride the row for the reason MOTIR-1531 folded them
 * onto the internal read: without them an agent orienting over the tree needs a
 * `get_work_item` per target before it can propose anything about one.
 */
export const mcpSkeletonRowSchema = workItemRefSchema
  .pick({ key: true, kind: true, title: true, status: true, parentKey: true })
  .extend({
    id: z.string(),
    revision: z.string().nullable(),
    // The folder the item is FILED in — its OWN placement, set only on a root
    // (Story MOTIR-5310 · MOTIR-5410). Without it a filed item reads as an
    // ordinary root and no agent orienting over the tree can tell where the team
    // put it. Resolve the id against the payload's `folders` for its name path.
    folderId: z.string().nullable(),
    // The OBSOLESCENCE mark (Story MOTIR-6574 · MOTIR-6582) — the mark only; the
    // note is a body, and bodies stay off the breadth read (`get_work_item` has it).
    obsolescence: obsolescenceSchema.nullable(),
  });
export type McpSkeletonRow = z.infer<typeof mcpSkeletonRowSchema>;

/** Map one plan-tree skeleton row. A pass-through — the projection is the DTO. */
export function presentMcpSkeletonRow(item: PlanTreeSkeletonItem): McpSkeletonRow {
  return {
    key: item.key,
    kind: item.kind,
    title: item.title,
    status: item.status,
    parentKey: item.parentKey,
    id: item.id,
    revision: item.revision,
    folderId: item.folderId,
    obsolescence: item.obsolescence,
  };
}

/**
 * One folder of the project as `skeleton` carries it (MOTIR-5410) — the same
 * four fields the internal tree read serves, `path` being the names ROOT FIRST.
 */
export const mcpSkeletonFolderSchema = z.object({
  id: z.string(),
  parentFolderId: z.string().nullable(),
  name: z.string(),
  path: z.array(z.string()),
});
export type McpSkeletonFolder = z.infer<typeof mcpSkeletonFolderSchema>;

/**
 * The `skeleton` response — the whole project's tree shape, plus the four
 * numbers that make its COMPLETENESS legible.
 *
 * `total` / `returned` / `truncated` / `limit` travel together on purpose. A
 * skeleton that silently stops at N reads as "this is the whole project", which
 * is the one way this tool can actively mislead an agent that is about to
 * propose work — so the bound is reported whether or not it bit.
 */
export const skeletonPayload = definePayload({
  schema: z
    .object({
      project: z.object({ projectId: z.string(), projectKey: z.string() }),
      items: z.array(mcpSkeletonRowSchema),
      total: z.number().int(),
      returned: z.number().int(),
      truncated: z.boolean(),
      limit: z.number().int(),
      // The project's folders, BESIDE the rows and never among them. The four
      // numbers above count WORK ITEMS only; the folder list has its own bound
      // and says so in `foldersTruncated`.
      folders: z.array(mcpSkeletonFolderSchema),
      foldersTruncated: z.boolean(),
    })
    .catchall(z.unknown()) as unknown as z.ZodType<
    {
      project: { projectId: string; projectKey: string };
      items: McpSkeletonRow[];
      total: number;
      returned: number;
      truncated: boolean;
      limit: number;
      folders: McpSkeletonFolder[];
      foldersTruncated: boolean;
    } & Record<string, unknown>
  >,
  // No probe: the row is a NARROWING of `WorkItemRef` (see above), so it cannot
  // satisfy that component and must not claim to. The derivation is proven at
  // the TYPE level instead — `.pick` off the base breaks when the base does.
  probes: [],
});

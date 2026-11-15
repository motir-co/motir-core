import { z } from 'zod/v4';
import { FILTER_PARAM } from '@/lib/filters/ast';
import { v1CursorSchema } from '@/lib/api/v1/openapi/envelopes';
import { defineOperation, type V1Operation } from '@/lib/api/v1/openapi/operation';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@/lib/api/v1/pagination';
import {
  approvalGateDecisionSchema,
  approvalGateKindSchema,
  approvalGateRecordSchema,
  approvedDesignSchema,
  attachmentSchema,
  commentThreadSchema,
  designAssetSchema,
  designVerdictSchema,
  createWorkItemBodySchema,
  linkPullRequestBodySchema,
  linkedPullRequestSchema,
  obsolescenceSchema,
  relationshipSchema,
  transitionListSchema,
  updateWorkItemBodySchema,
  workItemCountSchema,
  workItemDetailSchema,
  workItemKeySchema,
  workItemLinkGroupsSchema,
  workItemSummarySchema,
} from '@/lib/api/v1/workItems/schema';

// The WORK-ITEM operations (Story 11.4 · Subtask 11.4.4 — MOTIR-2185).
//
// Declared BESIDE the schemas they use, in the module ADR Amendment 2 gave the
// resource and Amendment 4 Q2 gave the operations: *"a per-resource
// `operations.ts` beside each `schema.ts` … assembled by one registry"*. The
// alternative — one central file listing every endpoint — is the file Amendment
// 2 refused for shapes, rebuilt for operations: a second place to update when a
// route changes, updated by someone other than whoever changed the route.
//
// ⚠️ The `scope` on each operation MUST equal the one its route file declares
// to `withV1Route`. It is written here so the DOCUMENT can state it; Subtask
// 11.4.6 asserts the equality against the route tree. Neither reads the other at
// request time.
//
// Paths are the OpenAPI templates a client calls, so `[key]` in the filesystem
// is `{key}` here.

/** The shared cursor + limit query parameters, on every collection. */
const pageParameters = [
  {
    name: 'cursor',
    in: 'query' as const,
    required: false,
    description:
      'An opaque page cursor from a previous response’s `nextCursor`. Omit for the first page. A cursor is signed and scoped to its collection — one issued elsewhere is a 422, never a silent reset.',
    schema: v1CursorSchema,
  },
  {
    name: 'limit',
    in: 'query' as const,
    required: false,
    description: `Rows per page. Defaults to ${DEFAULT_PAGE_LIMIT}; a larger value is CLAMPED to ${MAX_PAGE_LIMIT} rather than rejected.`,
    schema: z.number().int().positive(),
  },
];

/** The `{key}` path parameter every single-item work-item route takes. */
const keyParameter = {
  name: 'key',
  in: 'path' as const,
  required: true,
  description: 'The work item’s `MOTIR-<n>` key. Never its internal id (ADR §7).',
  schema: workItemKeySchema,
};

/** The `{projectKey}` path parameter the project-scoped collection takes. */
const projectKeyParameter = {
  name: 'projectKey',
  in: 'path' as const,
  required: true,
  description: 'The project’s key — the prefix of its work items’ keys, e.g. `MOTIR`.',
  schema: z.string().min(1),
};

/**
 * `If-Match`, the HTTP-native optimistic-concurrency guard on the one write
 * that has one. Omitting it is LEGAL and means last-write-wins.
 */
const ifMatchParameter = {
  name: 'If-Match',
  in: 'header' as const,
  required: false,
  description:
    'An `ETag` from a previous read of this work item. When present, the update is refused with 412 if the item moved since that read. Omitting it means last-write-wins.',
  schema: z.string().min(1),
};

/** Every work-item operation, in the order the reference lists them. */
export const WORK_ITEM_OPERATIONS: readonly V1Operation[] = [
  defineOperation({
    method: 'GET',
    path: '/api/v1/projects/{projectKey}/work-items',
    operationId: 'listProjectWorkItems',
    summary: 'List a project’s work items',
    description:
      'A cursor-paged collection of a project’s work items, optionally narrowed by a filter expression. Ordered by `(createdAt, id)` ascending — the position the cursor encodes.',
    permission: 'project:browse',
    parameters: [
      projectKeyParameter,
      ...pageParameters,
      {
        name: FILTER_PARAM,
        in: 'query',
        required: false,
        description:
          'A serialised filter expression, in the same form the product’s own list views use. An unknown field, operator or value is a 422 naming which.',
        schema: z.string().min(1),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'page', item: workItemSummarySchema },
      description: 'A page of work-item summaries.',
    },
    // The plain envelope: this collection reports no total, because the read
    // behind it does not compute one as a bounded aggregate (ADR Amendment 3 Q2).
    // The count lives at `…/work-items/count` instead — see the operation below
    // and ADR Amendment 14 for why it is a sibling rather than a field here.
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/projects/{projectKey}/work-items/count',
    operationId: 'countProjectWorkItems',
    summary: 'Count a project’s work items',
    description:
      'How many work items match a filter, in ONE request and without paging the match set. Takes the same `filter` the collection takes, and counts exactly what that collection would page. Exact, never capped.',
    permission: 'project:browse',
    // No `cursor` / `limit`: a count has no position and no page size, and
    // accepting either would invite a caller to believe it counts a WINDOW.
    parameters: [
      projectKeyParameter,
      {
        name: FILTER_PARAM,
        in: 'query',
        required: false,
        description:
          'A serialised filter expression, in the same form the collection takes. Omit to count every work item in the project. An unknown field, operator or value is a 422 naming which.',
        schema: z.string().min(1),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: workItemCountSchema },
      description: 'How many work items match.',
    },
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/projects/{projectKey}/work-items',
    operationId: 'createWorkItem',
    summary: 'Create a work item',
    description:
      'Create a work item in a project. The parent, if given, is named by its key and must be a kind-legal parent in the same project. Alternatively send `folderId` to file the new item into one of the project’s folders; naming both a parent and a folder is refused with `PLACEMENT_CONFLICT`. `obsolescence` (`outdated` / `deprecated`) and `obsolescenceNoteMd` may be set on any kind; a value outside the enum is refused with `INVALID_OBSOLESCENCE`. A MARK is a finished card’s state: a new item lands at the workflow’s initial status, so a mark on create is refused with `OBSOLESCENCE_REQUIRES_FINISHED` (422, `item`: the key and status) unless that status is in the done category — set it once the item is finished, and archive an item nobody will finish instead. A parent that carries a mark takes no new children: `MARKED_CARD_CANNOT_REOPEN` (422, `mark`: the parent’s key and mark). A parent still in Triage takes no children either: `WORK_ITEM_IN_TRIAGE` (409) until it is accepted in Triage. `sections` (an object of named sections, see `GET /api/v1/section-sets`) may be sent INSTEAD of `descriptionMd`: it is checked for the item’s kind and type, a missing, unknown or malformed section is refused with `INVALID_SECTIONS` (422, `sections`: the `missing`, `unknown` and `invalid` names), and the rendered text is stored as `descriptionMd` — nothing structured is stored. Both together is `SECTIONS_AND_DESCRIPTION_CONFLICT` (422); `descriptionMd` alone is stored as sent.',
    permission: 'work_item:edit',
    parameters: [projectKeyParameter],
    requestBody: {
      schema: createWorkItemBodySchema,
      description: 'The work item to create.',
    },
    response: {
      status: 201,
      body: { kind: 'object', schema: workItemDetailSchema },
      description: 'The created work item.',
    },
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/work-items/{key}',
    operationId: 'getWorkItem',
    summary: 'Read a work item',
    description:
      'The full work item: its own fields, its parent and children, its five link groups, its readiness verdict, its comment count and — when it is filed — its folder (`folderId` and the root-first `folderPath`). The response carries an `ETag` for use as an `If-Match` on a later update.',
    permission: 'project:browse',
    parameters: [keyParameter],
    response: {
      status: 200,
      body: { kind: 'object', schema: workItemDetailSchema },
      description: 'The work item.',
    },
    errorStatuses: [404],
  }),
  defineOperation({
    method: 'PATCH',
    path: '/api/v1/work-items/{key}',
    operationId: 'updateWorkItem',
    summary: 'Update a work item',
    description:
      'Patch any subset of a work item’s fields. A field that is ABSENT is untouched; a field explicitly set to `null` CLEARS it. Send `If-Match` to make the update conditional on the item not having moved. `folderId` files the item into a folder (or `null` takes it out), in the same write as every other field; setting `parentKey` on a filed item takes it out of its folder, and sending both is refused with `PLACEMENT_CONFLICT`. `obsolescence` and `obsolescenceNoteMd` mark the item as no longer true of the code on ANY kind, and `null` clears either; a value outside the enum is refused with `INVALID_OBSOLESCENCE`. A MARK is a FINISHED card’s state: setting `outdated` or `deprecated` on an item whose status is outside the done category is refused with `OBSOLESCENCE_REQUIRES_FINISHED` (422, `item`: the key, the status and its category) — archive an item nobody will finish instead. Clearing is always legal, and a patch that omits the mark never meets it. Re-parenting under a marked item (`parentKey`) is refused with `MARKED_CARD_CANNOT_REOPEN` (422, `mark`). An item still in Triage is not filed (`folderId`) or re-parented (`parentKey`), and nothing is re-parented under one: `WORK_ITEM_IN_TRIAGE` (409) until it is accepted in Triage; taking a triaged item out of a folder stays open. `sections` merges SPARSELY over the stored description (an omitted section is kept, `null` clears one, a list replaces the list), is checked for the item’s kind and type AFTER this PATCH, and is refused as on create (`INVALID_SECTIONS`, `SECTIONS_AND_DESCRIPTION_CONFLICT`); a PATCH with `descriptionMd` and no `sections` is stored as sent.',
    permission: 'work_item:edit',
    parameters: [keyParameter, ifMatchParameter],
    requestBody: {
      schema: updateWorkItemBodySchema,
      description: 'The fields to change.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: workItemDetailSchema },
      description: 'The updated work item.',
    },
    errorStatuses: [404, 412, 422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/work-items/{key}/transitions',
    operationId: 'listWorkItemTransitions',
    summary: 'List the statuses a work item can move to',
    description:
      'The workflow-legal targets from the item’s current status. An `open`-policy project permits every other status; a `restricted` one permits only the declared edges.',
    permission: 'project:browse',
    parameters: [keyParameter],
    response: {
      status: 200,
      body: { kind: 'object', schema: transitionListSchema },
      description: 'The legal transition targets.',
    },
    errorStatuses: [404],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/transitions',
    operationId: 'transitionWorkItem',
    summary: 'Move a work item to a new status',
    description:
      'Apply a workflow transition. A status the workflow does not define and a status not reachable from here are DIFFERENT errors, because a client can fix only one of them. A MARKED item (`obsolescence` set) stays finished: a move to any status outside the done category is refused with `MARKED_CARD_CANNOT_REOPEN` (422, `mark`: the key, the mark and the refused target) until the mark is cleared with `updateWorkItem`; a move within the done category (`done` ↔ `cancelled`) is not.',
    permission: 'work_item:edit',
    parameters: [keyParameter],
    requestBody: {
      schema: z.object({ status: z.string().min(1) }).strict(),
      description: 'The target status key.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: workItemDetailSchema },
      description: 'The work item at its new status.',
    },
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/work-items/{key}/links',
    operationId: 'listWorkItemLinks',
    summary: 'Read a work item’s relationship edges',
    description:
      'All seven edge groups. An empty group is `[]`, never an absent key — to a typed client those are different things. `supersedes` lists the older work items this one replaces; `supersededBy` the newer ones that replace it.',
    permission: 'project:browse',
    parameters: [keyParameter],
    response: {
      status: 200,
      body: { kind: 'object', schema: workItemLinkGroupsSchema },
      description: 'The seven edge groups.',
    },
    errorStatuses: [404],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/links',
    operationId: 'createWorkItemLink',
    summary: 'Create a relationship edge',
    description:
      'Link this work item to another by key. Creating an edge that already exists is a 409 — the body is valid, the state is not what the request assumed. `supersedes` records that this (newer) work item replaces `toKey`; `superseded_by` writes the same edge from the older end. Neither gates readiness — only `blocked_by` / `blocks` do.',
    permission: 'work_item:edit',
    parameters: [keyParameter],
    requestBody: {
      schema: z.object({ toKey: workItemKeySchema, relationship: relationshipSchema }).strict(),
      description: 'The other endpoint and the relationship.',
    },
    response: {
      status: 201,
      body: {
        kind: 'object',
        schema: z.object({ toKey: workItemKeySchema, relationship: relationshipSchema }),
      },
      description: 'The created edge.',
    },
    errorStatuses: [404, 409, 422],
  }),
  // ── LINKING a pull request (Task MOTIR-5048) ────────────────────────────
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/pull-requests',
    operationId: 'linkWorkItemPullRequest',
    summary: 'Declare which pull request delivers this work item',
    description:
      'DECLARE that a pull request delivers this work item — the only thing that associates the ' +
      'two. There is no title parse and no branch fallback: a pull request nobody links moves no ' +
      'work item when it merges, and carries a failing check saying so. ' +
      '⚠️ IT ADDS, IT DOES NOT MOVE. The link is a DELIVERY ROW, and calling this again ' +
      'naming a DIFFERENT work item leaves the first delivery exactly where it was and writes a ' +
      'second. Both directions are expressible — many pull requests to one work item (which is ' +
      'what holds a part-delivered one open) and one pull request to many work items — so the ' +
      'response reports no moved-from, because nothing moves. ' +
      'Address the pull request as `repository` + `number`, or as the `url` `gh pr create` printed; ' +
      'give both and they must AGREE. ' +
      'It works BEFORE any webhook delivery has arrived — the case it exists for — writing ' +
      'the row from the `headRef` / `baseRef` / `title` supplied, and `created` says whether it did. ' +
      'A later delivery refreshes those and leaves the links alone.',
    permission: 'work_item:edit',
    parameters: [keyParameter],
    requestBody: {
      schema: linkPullRequestBodySchema,
      description: 'The pull request’s address, and the refs the row is seeded from.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: linkedPullRequestSchema },
      description:
        'The work item, the pull request the link resolved to, and whether this call created its row.',
    },
    // 404 for an unknown or cross-workspace key, and for a repository that is not
    // connected to this workspace — neither is an existence oracle (§4). 422 for a
    // malformed key, an unparseable address, or two addresses that disagree.
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'DELETE',
    path: '/api/v1/work-items/{key}/links',
    operationId: 'deleteWorkItemLink',
    summary: 'Remove a relationship edge',
    description:
      'Remove the edge named by its ENDPOINTS — the same pair that created it. Idempotent: 204 whether or not an edge was there, because the post-condition holds either way.',
    permission: 'work_item:edit',
    parameters: [
      keyParameter,
      {
        name: 'toKey',
        in: 'query',
        required: true,
        description: 'The other endpoint’s key.',
        schema: workItemKeySchema,
      },
      {
        name: 'relationship',
        in: 'query',
        required: true,
        description: 'The relationship to remove.',
        schema: relationshipSchema,
      },
    ],
    response: { status: 204, body: { kind: 'empty' }, description: 'The edge does not exist.' },
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/work-items/{key}/comments',
    operationId: 'listWorkItemComments',
    summary: 'List a work item’s comments',
    description:
      'Root comments with their single-level reply threads, cursor-paged. This collection DOES report a total, because the shipped read computes it as a bounded aggregate.',
    permission: 'project:browse',
    parameters: [
      keyParameter,
      ...pageParameters,
      {
        name: 'order',
        in: 'query',
        required: false,
        description: 'Root-comment order — `asc` (oldest first, the default) or `desc`.',
        schema: z.enum(['asc', 'desc']),
      },
    ],
    response: {
      status: 200,
      // The RANKED envelope — the one carrying `totalCount`.
      body: { kind: 'rankedPage', item: commentThreadSchema },
      description: 'A page of comment threads, with the total behind it.',
    },
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/comments',
    operationId: 'createWorkItemComment',
    summary: 'Comment on a work item',
    description:
      'Add a root comment, or a reply by naming a root comment as its parent. Replies are single-level: a reply to a reply is a 422.',
    permission: 'comment:add',
    parameters: [keyParameter],
    requestBody: {
      schema: z
        .object({ bodyMd: z.string().min(1), parentCommentId: z.string().min(1).optional() })
        .strict(),
      description: 'The comment to add.',
    },
    response: {
      status: 201,
      body: { kind: 'object', schema: commentThreadSchema.omit({ replies: true }) },
      description: 'The created comment.',
    },
    errorStatuses: [403, 404, 422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/work-items/{key}/designs',
    operationId: 'listWorkItemDesigns',
    summary: 'The approved designs a work item waits on',
    description:
      'One verdict per work item this one is `blocked_by`, in key order — the design an agent is handed before it builds (`docs/decisions/design-result.md` AMENDMENT 5 Q4). A verdict is `approved` with the version an APPROVAL named, or `not_approved` with one of five reasons: the blocker is not a design card, the design card is not `done`, it was cancelled, its result was withdrawn, or it never published one. ⚠️ The approved design is NOT simply the card’s current result: a design card approved and then republished before its merge would otherwise hand back a version nobody approved (AMENDMENT 5 Q2). Every `available` asset of an `approved` verdict carries a short-lived `url` and its `expiresAt`; an `unavailable` asset — an approved version whose bytes the orphan-GC reclaimed — carries neither, and that is a real answer rather than a failure.',
    permission: 'project:browse',
    parameters: [keyParameter],
    response: {
      status: 200,
      body: { kind: 'object', schema: z.object({ designs: z.array(designVerdictSchema) }) },
      description: 'The design verdicts for every design card this item waits on.',
    },
    errorStatuses: [404],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/work-items/{key}/design',
    operationId: 'getWorkItemDesign',
    summary: 'One design card’s approved design',
    description:
      'The verdict for ONE design card, addressed by its own key — the read behind following a design a `…/designs` verdict named, and behind finding a delta mock’s amended base by its `sourcePath`. Same verdict rules and same link terms as `…/designs`.',
    permission: 'project:browse',
    parameters: [keyParameter],
    response: {
      status: 200,
      body: { kind: 'object', schema: designVerdictSchema },
      description: 'The design card’s verdict.',
    },
    errorStatuses: [404],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/projects/{projectKey}/designs',
    operationId: 'listProjectDesigns',
    summary: 'Browse a project’s approved designs',
    description:
      'A cursor-paged collection of the project’s APPROVED designs, newest first — what an agent browses when the design it was handed is not the one it needs. A design still under review is not listed: it is not something to build against. ⚠️ NO download links: a list would mint one presign per row, and every one of them would start expiring before the caller read the page. Take links from `GET /api/v1/work-items/{key}/design` on the design you actually want.',
    permission: 'project:browse',
    parameters: [
      projectKeyParameter,
      ...pageParameters,
      {
        name: 'pathPrefix',
        in: 'query' as const,
        required: false,
        description:
          'Return only designs holding an asset whose repository `sourcePath` starts with this prefix — how a delta mock’s amended base is found (AMENDMENT 5 Q6).',
        schema: z.string().min(1),
      },
      {
        name: 'query',
        in: 'query' as const,
        required: false,
        description: 'A case-insensitive substring of the design card’s title.',
        schema: z.string().min(1),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'page', item: approvedDesignSchema },
      description: 'A page of approved designs.',
    },
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/attachments',
    operationId: 'uploadWorkItemAttachment',
    summary: 'Attach a file to a work item',
    description:
      'Upload a file and attach it to the work item, as `multipart/form-data` with a single `file` part. This is the GENERAL door: it carries no artifact kind and belongs to no lifecycle, so any deliverable a work item produces — a research findings document, a review’s notes — can reach the item that commissioned it. A DESIGN asset does not use this endpoint; it has its own publisher, whose result renders in the Design result panel. ⚠️ Two size limits apply and the SMALLER one is not this API’s: the organization’s plan sets a per-file entitlement (10 MB, or 100 MB on a paid plan) and is what returns 413, while a direct upload is separately capped at roughly 4.5 MB by the serving platform and is refused before the request reaches Motir.',
    permission: 'work_item:edit',
    parameters: [keyParameter],
    requestBody: {
      contentType: 'multipart/form-data',
      // Zod has no file type, so the part is declared as a string the emitter
      // stamps `format: binary` — OpenAPI's own spelling of "bytes". The ROUTE
      // reads the multipart body; this describes it.
      schema: z.object({ file: z.string() }).strict(),
      description: 'The file to attach, in a `file` part. An empty part is a 422.',
    },
    response: {
      status: 201,
      body: { kind: 'object', schema: attachmentSchema },
      description: 'The created attachment.',
    },
    // 403 the project's `attachment:create` refusal · 404 an unknown or
    // out-of-workspace key · 413 over the plan's per-file limit · 415 a
    // disallowed media type · 422 a malformed or empty multipart body · 402 the
    // organization's total storage cap · 429 the per-user upload throttle.
    errorStatuses: [402, 403, 404, 413, 415, 422, 429],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/archive',
    operationId: 'archiveWorkItem',
    summary: 'Archive a work item',
    description:
      'A recoverable soft-remove. Does NOT cascade to children — the irreversible subtree delete is not exposed by this API at all (ADR §3).',
    permission: 'work_item:archive',
    parameters: [keyParameter],
    response: {
      status: 200,
      body: { kind: 'object', schema: workItemDetailSchema },
      description: 'The archived work item.',
    },
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/work-items/{key}/approval-gate',
    operationId: 'getWorkItemApprovalGate',
    summary: 'One gate’s decision record on a work item',
    description:
      'The DECISION a person made on one approval gate — its `state`, the `noteMd` they wrote, who wrote it, when, on which `subjectVersion`, under which authority and through which surface (`docs/decisions/approval-gates.md` §6a’s audit set). This is how an agent reads the answer to a question it raised: **Request changes** records its reason in `noteMd`, and before this read every door onto that column was session-authed, so the one gate kind whose author is always an agent — `decision_approval`, raised only on a `type: decision` + `executor: coding_agent` card — was the one kind whose refusal an agent could not read. ⚠️ `gate: null` is an ANSWER, not a miss: the card has no gate of that kind, so nothing is waiting and nothing was decided; a key that does not resolve is the 404 instead. Read `state` BEFORE the audit fields — five of them are written by the decision, so a null means *not yet decided* and never *decided by nobody*. ⚠️ A READ ONLY: nothing on this API decides a gate, and nothing here asserts `approval:decide_any` — deciding stays session-authed, deliberately (§1, §2).',
    permission: 'project:browse',
    parameters: [
      keyParameter,
      {
        name: 'kind',
        in: 'query' as const,
        required: true,
        description:
          'Which gate to read. A card carries at most one LIVE gate per kind, and this answers the one the approval frame shows: a live question wins over a decided one, and among decided ones the newest.',
        schema: approvalGateKindSchema,
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: approvalGateRecordSchema },
      description:
        'The gate’s decision record, or `gate: null` when the card has none of that kind.',
    },
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/restore',
    operationId: 'restoreWorkItem',
    summary: 'Restore an archived work item',
    description: 'The inverse of archiving. Idempotent on an item that is not archived.',
    permission: 'work_item:archive',
    parameters: [keyParameter],
    response: {
      status: 200,
      body: { kind: 'object', schema: workItemDetailSchema },
      description: 'The restored work item.',
    },
    errorStatuses: [404, 422],
  }),
];

/**
 * The named component schemas this resource contributes to the document.
 *
 * Registered so a shape used by several operations appears ONCE in
 * `components.schemas` and is `$ref`ed — which is what makes the emitted
 * document readable, and what a client generator turns into one named type
 * rather than N structural duplicates.
 */
export const WORK_ITEM_COMPONENTS: Readonly<Record<string, z.ZodType>> = {
  WorkItemSummary: workItemSummarySchema,
  WorkItemCount: workItemCountSchema,
  WorkItemDetail: workItemDetailSchema,
  WorkItemLinkGroups: workItemLinkGroupsSchema,
  CommentThread: commentThreadSchema,
  TransitionList: transitionListSchema,
  Attachment: attachmentSchema,
  // Story MOTIR-5553's design reads. NAMED components rather than inline
  // shapes, because the MCP tools derive their payloads from this document
  // (MOTIR-5561) — an inline schema has nothing to resolve against.
  DesignAsset: designAssetSchema,
  ApprovedDesign: approvedDesignSchema,
  DesignVerdict: designVerdictSchema,
  // Bug MOTIR-6191's gate read. A NAMED component for the design reads' reason
  // one line up — `get_approval_gate` derives its payload from this schema
  // (`lib/mcp/payloads/approvalGates.ts`), and an inline shape has nothing to
  // resolve against. The ENVELOPE around it (`approvalGateRecordSchema`, the
  // `{ workItemKey, kind, gate, routedToLabel }` body) is deliberately NOT a
  // component, for the reason the `WorkItemDesigns` note below gives.
  ApprovalGateDecision: approvalGateDecisionSchema,
  // ⚠️ `WorkItemDesigns` — the `{ designs: [...] }` body of `…/designs` — is
  // deliberately NOT a component. It is an ENVELOPE, and the payload seam's own
  // doctrine is that an envelope stays each surface's own (ADR Amendment 7 Q6):
  // registering it would make it a SHARED RESOURCE, and the MCP coverage guard
  // would then demand that MCP's transport shape equal v1's — which is exactly
  // the freedom that doctrine reserves. Its VERDICTS are shared, and they are
  // the component above.
};

/**
 * The named SHARED schemas this resource contributes (MOTIR-6581) — a field
 * vocabulary rather than a resource, so it is emitted as ONE component that every
 * carrier `$ref`s wherever the schema instance appears, and it is deliberately
 * NOT in {@link WORK_ITEM_COMPONENTS}: that map is the SHARED-RESOURCE set the
 * MCP payload guard derives from (`lib/mcp/payloads/sharedResources.ts`), and an
 * enum is not a resource any tool returns.
 *
 * `WorkItemObsolescence` rides the detail, the collection row, the ready row and
 * both write bodies — named once so a client generator produces one type for it.
 */
export const WORK_ITEM_SHARED_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  WorkItemObsolescence: obsolescenceSchema,
};

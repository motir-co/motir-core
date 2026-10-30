import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { commentsService } from '@/lib/services/commentsService';
import { monitorIssueService } from '@/lib/services/monitorIssueService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { inFlightCodeService } from '@/lib/services/inFlightCodeService';
import { projectedBodyOf, projectedWorkItem } from '@/lib/services/planProjectionService';
import type { ProjectedDetailDto, ProjectedRowDto } from '@/lib/services/planProjectionService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { IssueDetailDto } from '@/lib/dto/workItems';
import type { AiInFlightCodeFields } from '@/lib/dto/ai';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { CHILD_EDGE_BLOCK_DESCRIPTION } from '../dependencyEdges';
import { obsolescenceLines } from '../obsolescence';
import { renderInFlightCode } from '../inFlightCode';
import { derived } from '../payloads/define';
import { getWorkItemPayload, presentMcpWorkItemChild } from '../payloads/workItems';
import { isTempRef } from '@/lib/plans/refs';
import { parseSections } from '@/lib/workItems/sections/parse';
import type { IssueType } from '@/lib/issues/parentRules';
import type { SectionType } from '@/lib/workItems/sections/registry';
import type { ParsedBody } from '@/lib/workItems/sections/parse';
import {
  includeSectionsField,
  PARSED_SECTIONS_DESCRIPTION,
  sectionsSummary,
} from '../parsedSections';
import { TEMP_REF_HELP, normalizeProjectedTarget, planIdField } from './planRef';
import { renderFolderPath } from './placement';
import {
  attachCommentCounts,
  commentCountMarker,
  COMMENT_COUNT_DESCRIPTION,
  ITEM_ONLY_COMMENT_COUNT_NOTE,
} from '../commentCounts';

// `get_work_item` (Story 7.8 · Subtask 7.8.4) — read ONE work item by its
// `<KEY>-<n>` identifier, returned as the issue-detail aggregate (the same
// `getIssueDetail` shape the detail page reads: the item + parent + children +
// dependency links + readiness verdict). One service call, no business logic —
// the 6.4 browse gate + the 404-not-403 cross-tenant contract live in the
// service unchanged.
//
// `planId` (MOTIR-3096) answers over the PROJECTION instead — the project's live
// tree ⊕ that plan's proposals — so an agent can ask *"what does the tree look
// like WITH what I just proposed"* in one call, rather than merging `get_plan`
// against this read by hand on every turn. The target may then be a
// `planItem:<id>` temp-ref for a card the plan proposes, which has no key yet.
//
// ⚠️ THE PROJECTED ANSWER IS A DIFFERENT ENVELOPE, deliberately. It is not the
// committed aggregate with proposals slipped into it: `children` keeps holding
// only COMMITTED rows (the shape the payload seam derives from v1), the plan's
// own children ride `proposedChildren`, and every row carries `proposal` and a
// null `key` when it is one. A caller cannot mistake the two even by flattening
// the arrays — `docs/decisions/agent-authored-plans.md` AMENDMENT 3 Q7.
//
// PLUS the per-CHILD dependency block (7.9.16b / MOTIR-1848). The aggregate's
// `children` are `WorkItemSummaryDto[]` and carry no edges, so a client could not
// order them without an N+1 fan-out; `motir show`'s build-order WAVE view needs
// exactly that sibling sub-graph. It rides ONE extra batched call (two queries,
// any child count) and is attached at the TRANSPORT, following 7.9.0f's precedent
// — `IssueDetailDto` stays as-is for the web detail page.

export const GET_WORK_ITEM_TOOL_NAME = 'get_work_item';

const inputSchema = {
  key: z
    .string()
    .min(1)
    .describe(
      'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"), ' +
        "case-insensitive — or the work item's internal id, the form a plan names a " +
        'committed card by (`parentRef`, `blockedByRefs`, `workItemId`). With `planId`, this may instead be a `planItem:<id>` temp-ref ' +
        'naming an `add` in that plan (case-SENSITIVE, as `add_plan_items` returned it).',
    ),
  planId: planIdField,
  includeSections: includeSectionsField,
};

/**
 * Turn a work-item ID into its key (MOTIR-8940). A plan names committed cards by
 * id, and this door read every argument as `<KEY>-<n>`, so a bare id was taken
 * whole as a project key and refused `PROJECT_NOT_FOUND`. A key always carries a
 * dash, a cuid never does, and a `planItem:` temp-ref is left to the projection;
 * `getWorkItem` is the same workspace + browse gate the key path passes, so an
 * unknown or foreign id is the ordinary not-found.
 */
async function keyOfRef(raw: string, ctx: ServiceContext): Promise<string> {
  const ref = raw.trim();
  if (ref.includes('-') || isTempRef(ref)) return raw;
  return (await workItemsService.getWorkItem(ref, ctx)).identifier;
}

/** Derive the owning project key from an `ACME-7`-style identifier. */
function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

/** Compact human-readable summary of an issue-detail aggregate. */
function summarize(
  detail: IssueDetailDto,
  commentCount: number,
  folderPath: string[] | null,
  inFlight: AiInFlightCodeFields,
  parsed?: ParsedBody,
): string {
  const it = detail.item;
  const lines = [
    `${it.identifier} [${it.kind}${it.type ? `/${it.type}` : ''}] ${it.title}`,
    `Status: ${it.status} · Priority: ${it.priority} · Assignee: ${it.assigneeId ?? 'unassigned'}` +
      commentCountMarker(commentCount),
  ];
  if (detail.parent) lines.push(`Parent: ${detail.parent.identifier} ${detail.parent.title}`);
  if (folderPath !== null) lines.push(`Folder: ${renderFolderPath(folderPath)}`);
  lines.push(
    detail.readiness.ready
      ? 'Readiness: ready'
      : `Readiness: blocked by ${detail.readiness.openBlockers
          .map((b) => b.identifier)
          .join(', ')}`,
  );
  // The parsed sections view (MOTIR-9033) — printed ONLY when it was asked for,
  // so an unasked read's text is byte-identical to what it was.
  if (parsed) lines.push(sectionsSummary(parsed));
  // The SUPERSEDES pair (MOTIR-6580): which items this one replaces, and which
  // replace it — printed only when present, so an ordinary card reads as before.
  if (detail.supersedes.length > 0) {
    lines.push(`Supersedes: ${detail.supersedes.map((l) => l.item.identifier).join(', ')}`);
  }
  if (detail.supersededBy.length > 0) {
    lines.push(`Superseded by: ${detail.supersededBy.map((l) => l.item.identifier).join(', ')}`);
  }
  // The OBSOLESCENCE mark (MOTIR-6582): `obsolescence: outdated — superseded by …`
  // and the note's first line, on a MARKED card only — an unmarked card gains no
  // line, and nothing about the rest of the block changes.
  lines.push(
    ...obsolescenceLines({
      obsolescence: it.obsolescence,
      obsolescenceNoteMd: it.obsolescenceNoteMd,
      supersededByKeys: detail.supersededBy.map((l) => l.item.identifier),
    }),
  );
  // Where the item's UNMERGED code lives (MOTIR-10069) — before the body, so a
  // long description cannot push it out of a reader's view.
  lines.push(...renderInFlightCode(inFlight));
  if (it.descriptionMd) {
    lines.push('', it.descriptionMd);
  }
  return lines.join('\n');
}

/** One projected row as a compact line for the human-readable text block. The
 *  `proposal` / `key` split is the payload's job; this is what a person watching
 *  the session reads, so it says which kind of thing each row is in words. */
function projectedLine(row: ProjectedRowDto): string {
  const id = row.proposal ? `${row.tempRef} (PROPOSED)` : row.key;
  // `title` is always set — required on an `add`, and non-null on a stored row —
  // so it takes no fallback. `kind` genuinely may be absent: `proposedFields.kind`
  // is optional and materialize defaults it, so a proposal can legitimately not
  // have said one yet.
  const reason = row.edgeReason ? ` · waits for: ${row.edgeReason}` : '';
  return `  ${id} [${row.kind ?? '?'}] ${row.title} — ${row.status}${reason}`;
}

/** Compact human-readable summary of a PROJECTED detail. */
function summarizeProjected(detail: ProjectedDetailDto, parsed?: ParsedBody): string {
  const t = detail.target;
  const lines = [
    t.proposal
      ? `${t.tempRef} [${t.kind ?? '?'}] ${t.title} — a PROPOSAL in plan ${detail.planId}, not a work item. It has no key until the plan is approved in Motir.`
      : `${t.key} [${t.kind ?? '?'}] ${t.title} — as it would stand once plan ${detail.planId} materializes.`,
  ];
  if (t.pendingPatch) {
    lines.push(`This plan MODIFIES it: ${JSON.stringify(t.pendingPatch)}`);
  }
  if (t.status === 'removed_by_plan') {
    lines.push('⚠️ This plan REMOVES this card — it is gone from the projection.');
  }
  if (detail.parent) lines.push(`Parent:${projectedLine(detail.parent).slice(1)}`);
  if (detail.committedChildren.length > 0) {
    lines.push('Children (committed):', ...detail.committedChildren.map(projectedLine));
  }
  if (detail.proposedChildren.length > 0) {
    lines.push('Children this plan PROPOSES:', ...detail.proposedChildren.map(projectedLine));
  }
  if (detail.blockedBy.length > 0) {
    lines.push('Blocked by (projected):', ...detail.blockedBy.map(projectedLine));
  }
  if (parsed) lines.push(sectionsSummary(parsed));
  lines.push(
    'Nothing was created: approving the plan in Motir is the only path from a proposal to a work item.',
  );
  return lines.join('\n');
}

/** The adapter: resolve the project from the key, read the detail aggregate. */
export async function runGetWorkItem(
  args: { key: string; planId?: string; includeSections?: boolean },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const key = await keyOfRef(args.key, ctx);
  if (args.planId !== undefined) {
    // PROJECTED. No project lookup: `buildProjection` resolves the project FROM
    // the plan and asserts browse on it, and a `planItem:<id>` target has no
    // project-key prefix to derive one from anyway.
    const projected = await projectedWorkItem(args.planId, normalizeProjectedTarget(key), ctx);
    // ⚠️ The whole projected answer rides ONE clearly-named key, and `children`
    // — the committed aggregate's array, which the payload seam derives from the
    // shared v1 child schema — is EMPTY. That is not a gap: a keyless proposal
    // cannot satisfy that schema, and quietly widening it would put rows with no
    // key in the array every existing consumer reads committed children from.
    // A caller branches on `projection` being present, exactly as it does on
    // `search_work_items`.
    // The sections view of the card AS THE PLAN WOULD LEAVE IT (MOTIR-9033) —
    // parsed only when asked, from the projected body, kind and type.
    const body = args.includeSections
      ? await projectedBodyOf(args.planId, normalizeProjectedTarget(key), ctx)
      : null;
    const parsed = body
      ? parseSections(body.descriptionMd, body.kind as IssueType, body.type as SectionType)
      : undefined;
    return toolOk(
      summarizeProjected(projected, parsed),
      derived(getWorkItemPayload, {
        children: [],
        projection: projected,
        ...(parsed ? { parsedSections: parsed } : {}),
      }),
    );
  }
  const identifier = key.trim().toUpperCase();
  const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
  const detail = await workItemsService.getIssueDetail(project.id, identifier, ctx);
  // The children's dependency edges in TWO batched queries (MOTIR-1842's reader),
  // never one read per child — a 43-child story must stay a single round-trip.
  // `getIssueDetail` has already run the browse gate on the whole aggregate, so
  // the ids handed over are ones the caller may see.
  const edges = await workItemsService.getDependencyEdgesForItems(
    detail.children.map((c) => c.id),
    ctx,
  );
  // The DISCUSSION signal (MOTIR-2001), on the ITEM only — one extra query,
  // whatever the aggregate holds. The children deliberately do NOT carry it: a
  // child badge would tempt a client to render the whole subtree's discussion
  // state from a read whose job is this ONE card, and the list reads already
  // answer that question per row.
  const counts = await commentsService.getCommentCountsForItems([detail.item.id], ctx);
  const item = attachCommentCounts([detail.item], counts)[0]!;
  // Every row this read already resolved, so a child's `parentId` can be named
  // by its KEY — the same map `presentWorkItemDetail` builds, for the same
  // field. Built once and shared by every child.
  const keyById = new Map<string, string>([[detail.item.id, detail.item.identifier]]);
  for (const row of [...detail.ancestors, ...detail.children]) {
    keyById.set(row.id, row.identifier);
  }
  if (detail.parent) keyById.set(detail.parent.id, detail.parent.identifier);
  // The CHILD rows now DERIVE from v1's `workItemChildSchema` (MOTIR-2228) —
  // the sub-graph the founding defect lived in. The rest of the aggregate is the
  // envelope, which stays MCP's own (ADR Amendment 7 Q6).
  // The DELIVERY SET (Story MOTIR-3655 · MOTIR-3697) — every pull request that
  // delivers this card, with its CI verdict. An agent that has just opened a pull
  // request and called `link_pull_request` reads back HERE whether the card is
  // delivered by one branch or several, and whether the others are green. Empty
  // is the ordinary answer and means nothing is recorded, never that nothing has
  // landed. It rides the `catchall`-open envelope, so no payload schema widens.
  const deliveries = await workItemsService.listDeliverySet(detail.item.id, ctx);
  // The IN-FLIGHT CODE (MOTIR-10069) — where the card's UNMERGED code lives, per
  // repository: its own open pull request, else the NEAREST ANCESTOR's
  // (`source: 'inherited'`, `fromKey`), plus `mergedRepos`. `deliveries` above is
  // the card's OWN set only, so a child built onto its parent's pull request reads
  // `deliveries: []` — which looks like "no code yet". This is the same read the
  // hosted planner's `get_item` makes, so the two planners are handed one answer.
  const inFlight = await inFlightCodeService.readForItem(detail.item.id, project.id, ctx);
  // The item's OWN folder placement (Story MOTIR-5310 · MOTIR-5413), DECLARED on
  // the payload as `folderId` + `folderPath` — the `/api/v1` detail's vocabulary.
  // The path is the one read the quick view and `/api/v1` share; an unfiled item
  // makes no read and carries two nulls. `placementFolder` (MOTIR-5375) is the
  // work item PAGE's EFFECTIVE placement and is deliberately NOT published —
  // agents see the item's own placement only. `fixReason` / `fixDetail` (Story
  // MOTIR-6589) are likewise the item PAGE's — its To fix banner — and are not
  // published here: widening this payload is a decision of its own, not a side
  // effect of a page banner.
  const {
    placementFolder: _pagePlacementOnly,
    fixReason: _pageFixReasonOnly,
    fixDetail: _pageFixDetailOnly,
    fixGroup: _pageFixGroupOnly,
    ...publishedDetail
  } = detail;
  const folderPath =
    detail.folderId === null ? null : await workItemsService.getFolderPath(detail.folderId, ctx);
  // The work item's ERRORS (Story MOTIR-5975 · MOTIR-5981): every monitor link
  // with its stored facts and evidence, through the SAME read the item page's
  // Errors section renders — so the two surfaces cannot disagree, and neither
  // calls the monitor. `[]` is the ordinary answer for a work item with no link.
  const errors = await monitorIssueService.listForWorkItem(detail.item.id, ctx);
  // The LATEST REFUSAL (Story MOTIR-6070 · MOTIR-6422) — the SAME read the dispatched
  // prompt's CHANGES REQUESTED section renders, so a person following the runbook and
  // a dispatched agent are handed the same reason for the same card. `null` unless
  // the card's most recently decided gate, of any kind, is `changes_requested`.
  const latestRefusal = await approvalGatesService.latestRefusalFor(detail.item.id, ctx);
  // The parsed sections view (MOTIR-9033): one pure call on the body this read
  // already holds, attached at the transport like the comment counts, so
  // `IssueDetailDto` and the web page do not change. Absent unless asked for.
  const parsed = args.includeSections
    ? parseSections(
        detail.item.descriptionMd,
        detail.item.kind as IssueType,
        (detail.item.type ?? null) as SectionType,
      )
    : undefined;
  const structured = {
    ...publishedDetail,
    folderId: detail.folderId,
    folderPath,
    item,
    children: detail.children.map((child) =>
      presentMcpWorkItemChild(child, edges[child.id], (id) => keyById.get(id)),
    ),
    deliveries,
    inFlightCode: inFlight.inFlightCode,
    mergedRepos: inFlight.mergedRepos,
    errors,
    latestRefusal,
    ...(parsed ? { parsedSections: parsed } : {}),
  };
  return toolOk(
    summarize(detail, item.commentCount, folderPath, inFlight, parsed),
    derived(getWorkItemPayload, structured),
  );
}

export function registerGetWorkItem(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    GET_WORK_ITEM_TOOL_NAME,
    {
      title: 'Get work item',
      description:
        'Read a single work item by its identifier (e.g. "ACME-7") or its internal id: full detail including ' +
        'description, status, priority, assignee, parent/children, dependency links, and a ' +
        'readiness verdict. The link groups include `supersedes` (the older items this one ' +
        'replaces) and `supersededBy` (the newer items that replace it), beside `blockedBy` / ' +
        '`blocks` / `relatesTo` / `duplicates` / `clones`. Honors the same access checks as the ' +
        'UI. The payload declares the ' +
        "item's OWN folder placement as `folderId` + `folderPath` (names root-first) — both null " +
        'for an unfiled item, and for a child of a filed item, whose ancestry travels as keys. ' +
        CHILD_EDGE_BLOCK_DESCRIPTION +
        ' ' +
        COMMENT_COUNT_DESCRIPTION +
        ' ' +
        ITEM_ONLY_COMMENT_COUNT_NOTE +
        ' The item and every child row carry the OBSOLESCENCE mark — `obsolescence` ' +
        '(`outdated` · `deprecated`, null while the card is still true of the code) and ' +
        '`obsolescenceNoteMd` (why) — and the text block prints `obsolescence: <mark> — ' +
        'superseded by <keys>` plus the note’s first line on a marked card. Informational ' +
        'only: a marked child is never hidden or re-ordered.' +
        ' A committed item also carries `errors`: every monitor issue linked to it, with the ' +
        'facts and the latest event’s EVIDENCE Motir has stored — exception, stack frames, tags, ' +
        'request line — and `evidence.state` (`present`, `no_exception` or `never_read`, plus ' +
        '`stale`). It is read from Motir’s store, never live from the monitor; `[]` means none.' +
        ' A committed item also carries `latestRefusal`: when the item’s most recently DECIDED ' +
        'approval gate, of ANY kind, is `changes_requested`, it is `{ gateId, kind, noteMd, ' +
        'decidedByLabel, decidedAt, decisionSource, refusalVerdict, subjectVersion }` — the ' +
        'reason the last attempt was sent back (verbatim; `noteMd` null only on a GitHub review ' +
        'with no body), who refused and when, the refused version, and the verdict when set. It ' +
        'is `null` otherwise, including when a later approval answered it. It is the same ' +
        'refusal the dispatched prompt’s CHANGES REQUESTED section quotes: address that reason ' +
        'in the next attempt.' +
        ' A committed item also carries `inFlightCode`: WHERE its UNMERGED code is, one entry per ' +
        'repository — `{ repo, branch, headSha, prNumber, prUrl, draft, baseRef, source, fromKey? }` — ' +
        'its own open pull request (`source: "own"`), else the NEAREST ANCESTOR’s ' +
        '(`source: "inherited"`, `fromKey` the ancestor’s key: a child built onto its parent’s pull ' +
        'request has no delivery of its own, and its code is on the parent’s branch). Pass `repo` ' +
        'and `branch` to `list_changed_files` (as `repo` and `head`) and to `read_file` (as `repo` ' +
        'and `ref`). `mergedRepos` names the repositories where its own delivery has already merged ' +
        'to the default branch. Both are `[]` when nothing was delivered on the item or a parent; ' +
        '`deliveries` stays the item’s OWN pull requests only, and is not a statement about its ' +
        'code. The text block prints one `In-flight code:` line per entry.' +
        ' Each of the title, description and explanation has a recorded language in ' +
        '`item.languages` (`{ title, description, explanation }`); `null` means none was ' +
        'recorded — text written before content languages, and imported text.' +
        ' Pass `planId` to read the card as it would stand once that plan materializes — the ' +
        'live tree ⊕ the plan’s proposals, so you can see what you proposed without merging ' +
        '`get_plan` against this call yourself. ' +
        TEMP_REF_HELP +
        ' The projected answer rides a `projection` key — `{ planId, target, parent, ' +
        'committedChildren, proposedChildren, blockedBy }` — and the ordinary `children` array ' +
        'is EMPTY, because a proposal has no key and cannot sit in the array committed children ' +
        'use. Every projected row carries `proposal` and a null `key` when it is one; no key is ' +
        'ever invented for a proposal. Read-only: it creates nothing and persists nothing.' +
        PARSED_SECTIONS_DESCRIPTION,
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runGetWorkItem(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}

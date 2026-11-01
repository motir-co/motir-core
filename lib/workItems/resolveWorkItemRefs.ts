import type { WorkItem } from '@/generated/prisma/client';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workflowsService } from '@/lib/services/workflowsService';
import { userRepository } from '@/lib/repositories/userRepository';
import {
  toVisitorRefAssigneeDto,
  toWorkItemRefAssigneeDto,
  toWorkItemRefSummaryDto,
} from '@/lib/mappers/workItemMappers';
import { parseWorkItemTokenIds, type WorkItemRefs } from '@/lib/mentions/workItemRefs';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { isVisitorContext } from '@/lib/visitor/readScope';

/** The distinct non-null assignee ids of the rows a gate already admitted. */
export function distinctAssigneeIds(rows: Pick<WorkItem, 'assigneeId'>[]): string[] {
  return [...new Set(rows.map((r) => r.assigneeId).filter((id): id is string => id !== null))];
}

// Read-side resolution for work-item references (Story 5.8 · Subtask 5.8.6) —
// the parallel of the write-side `autoRelateWorkItemMentions` (5.8.3). Given the
// references parsed out of a body / title (token ids ∪ bare project keys), it
// resolves each to the LIVE summary the internal-link chip / title-linkify
// renders: current key · title · status · archived / accessible state. It
// REUSES the exact `projectAccessService.filterBrowsable` view gate `quickSearch`
// and auto-relate ride — NOT a new permission check:
//
//  - a token id that resolves to nothing (deleted / cross-workspace) is simply
//    ABSENT from the map → the chip degrades to a struck-through bare key;
//  - a target in a project the caller can't browse is marked
//    `{ accessible: false }` → the chip shows only the bare key (no title/status
//    leak), matching the picker's permission scope;
//  - an accessible target carries its current identifier · title · kind ·
//    archived flag + resolved status meta (label + category for the dot).
//
// Pure read (no `tx`): a read-only service path, so the repo reads use the `db`
// singleton. Keyed by BOTH the work-item id (the `motir:<id>` token the render
// layer looks up) and, for accessible targets, the current identifier (the bare
// `KEY-N` title path).
export async function resolveWorkItemRefSummaries(
  refs: WorkItemRefs,
  activeProjectId: string,
  ctx: ServiceContext | VisitorReadContext,
): Promise<WorkItemRefMap> {
  if (refs.ids.length === 0 && refs.keys.length === 0) return {};
  if (isVisitorContext(ctx)) return resolveVisitorRefSummaries(refs, ctx);

  // Same-project bare keys → rows (the key parser only matches the active
  // project's prefix, so resolution is project-scoped — like auto-relate); token
  // ids → rows within the workspace (includes archived; a cross-workspace /
  // deleted id simply doesn't come back).
  const [keyRows, idRows] = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    Promise.all([
      refs.keys.length
        ? workItemRepository.findByIdentifiers(activeProjectId, refs.keys, tx)
        : Promise.resolve<WorkItem[]>([]),
      refs.ids.length
        ? workItemRepository.findByIdsInWorkspace(refs.ids, ctx.workspaceId, tx)
        : Promise.resolve<WorkItem[]>([]),
    ]),
  );

  // Dedupe by id — a token id and a bare key can name the same item.
  const rowById = new Map<string, WorkItem>();
  for (const r of [...idRows, ...keyRows]) rowById.set(r.id, r);
  if (rowById.size === 0) return {};

  // View scope: the exact `filterBrowsable` gate `quickSearch` / auto-relate
  // ride (reused, not reinvented) — title/status only leak for browsable targets.
  const projects = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    projectRepository.findByWorkspace(ctx.workspaceId, tx),
  );
  const browsable = await projectAccessService.filterBrowsable(projects, ctx);
  const browsableProjectIds = new Set(browsable.map((p) => p.id));

  // Resolve the status meta (label + category for the dot) of the accessible
  // targets, batched across their projects (each project owns its workflow).
  const accessibleRows = [...rowById.values()].filter((r) => browsableProjectIds.has(r.projectId));
  const statusMeta = await workflowsService.getStatusMetaByProjects(
    accessibleRows.map((r) => r.projectId),
    ctx.workspaceId,
  );

  // ONE batched member read for the assignees of the rows the gate admitted —
  // none when nothing is assigned, never one per reference.
  const assignees = await userRepository.findByIds(distinctAssigneeIds(accessibleRows));

  const map: WorkItemRefMap = {};
  for (const row of rowById.values()) {
    if (!browsableProjectIds.has(row.projectId)) {
      // In-workspace but not viewable → bare key only (no title/status leak).
      map[row.id] = { accessible: false, id: row.id };
      continue;
    }
    const status = statusMeta.get(row.projectId)?.get(row.status) ?? null;
    const member = assignees.find((u) => u.id === row.assigneeId);
    const summary = toWorkItemRefSummaryDto(
      row,
      status,
      member ? toWorkItemRefAssigneeDto(member) : null,
    );
    // Keyed by id (token href) AND current identifier (bare-key / title path).
    map[row.id] = summary;
    map[row.identifier] = summary;
  }
  return map;
}

/** No bare keys are resolved, so no project is consulted. */
const NO_BARE_KEY_PROJECT = '';

/**
 * The work-item chips of ONE stored Markdown body (bug MOTIR-10020): every
 * `[KEY](motir:<id>)` in it, resolved for the reader through
 * {@link resolveWorkItemRefSummaries} — so a live card is a live chip, a deleted
 * one is absent (struck through) and one the reader cannot browse is the no-access
 * chip. A body that links nothing answers `{}` with no query.
 *
 * ⚠️ A SURFACE THAT HANDS `MarkdownView` A STORED BODY OWES IT THIS MAP. Without
 * one every chip in the body draws as deleted — the defect fixed one surface at a
 * time by MOTIR-9138 (page version view), MOTIR-9355 (proposal peek), MOTIR-9697
 * (plan summary) and MOTIR-10020 (decision port). A new surface calls this.
 */
export async function resolveMarkdownWorkItemRefs(
  markdown: string,
  ctx: ServiceContext | VisitorReadContext,
): Promise<WorkItemRefMap> {
  // Token ids only: a `motir:<id>` is resolved across the reader's workspace, so no
  // project scopes it — the active project scopes BARE keys alone, and a stored body's
  // chips are its tokens (the render layer chips nothing else).
  return resolveWorkItemRefSummaries(
    { ids: parseWorkItemTokenIds(markdown), keys: [] },
    NO_BARE_KEY_PROJECT,
    ctx,
  );
}

/**
 * {@link resolveMarkdownWorkItemRefs} over SEVERAL stored bodies a surface renders
 * together, in ONE read (bug MOTIR-10023) — a to-do list's notes, a gate's sections,
 * a triage item's description beside its thread. Absent bodies are skipped, and
 * when none of them links anything the answer is `{}` with no query.
 */
export async function resolveMarkdownBodiesWorkItemRefs(
  bodies: readonly (string | null | undefined)[],
  ctx: ServiceContext | VisitorReadContext,
): Promise<WorkItemRefMap> {
  return resolveMarkdownWorkItemRefs(
    bodies.filter((body): body is string => Boolean(body)).join('\n'),
    ctx,
  );
}

/**
 * A VISITOR's chip resolution (MOTIR-6652, `epic-privacy.md` §3). The only
 * project a Visitor can read is `ctx.project`, so a target anywhere else — or in
 * the private-epic hidden set — resolves to NOTHING: it is left out of the map
 * altogether, id and key alike, so the chip names neither. (The Visitor's
 * Markdown bodies have their withheld tokens redacted before they are sent;
 * this keeps a bare key typed in prose from resolving to a title.)
 */
async function resolveVisitorRefSummaries(
  refs: WorkItemRefs,
  ctx: VisitorReadContext,
): Promise<WorkItemRefMap> {
  const { id: projectId, workspaceId } = ctx.project;
  const [keyRows, idRows] = await withWorkspaceServiceContext(workspaceId, (tx) =>
    Promise.all([
      refs.keys.length
        ? workItemRepository.findByIdentifiers(projectId, refs.keys, tx)
        : Promise.resolve<WorkItem[]>([]),
      refs.ids.length
        ? workItemRepository.findByIdsInWorkspace(refs.ids, workspaceId, tx)
        : Promise.resolve<WorkItem[]>([]),
    ]),
  );
  const visible = [...idRows, ...keyRows].filter(
    (r) => r.projectId === projectId && !ctx.hiddenIds.has(r.id),
  );
  if (visible.length === 0) return {};
  const statusMeta = await workflowsService.getStatusMetaByProjects([projectId], workspaceId);
  const assignees = await userRepository.findByIds(distinctAssigneeIds(visible));
  const map: WorkItemRefMap = {};
  for (const row of visible) {
    const member = assignees.find((u) => u.id === row.assigneeId);
    const summary = toWorkItemRefSummaryDto(
      row,
      statusMeta.get(row.projectId)?.get(row.status) ?? null,
      member ? toVisitorRefAssigneeDto(member) : null,
    );
    map[row.id] = summary;
    map[row.identifier] = summary;
  }
  return map;
}

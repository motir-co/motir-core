import type { Prisma, WorkItem } from '@/generated/prisma/client';
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
import {
  canonicalWorkItemKey,
  parseWorkItemTokenIds,
  type WorkItemRefs,
} from '@/lib/mentions/workItemRefs';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { isVisitorContext } from '@/lib/visitor/readScope';

/** The distinct non-null assignee ids of the rows a gate already admitted. */
export function distinctAssigneeIds(rows: Pick<WorkItem, 'assigneeId'>[]): string[] {
  return [...new Set(rows.map((r) => r.assigneeId).filter((id): id is string => id !== null))];
}

/**
 * The token ids of `refs` split into real ids and the KEYS some were written as
 * (bug MOTIR-11281): `[MOTIR-9730](motir:MOTIR-9730)` puts a key where the id
 * belongs, and a body sealed for a decision cannot be re-saved to correct it.
 * `aliases` maps each canonical key to the token(s) that spelled it, so the
 * summary is also keyed by the href the render layer looks up.
 */
export function splitKeyTokens(ids: readonly string[]): {
  ids: string[];
  keys: string[];
  aliases: Map<string, string[]>;
} {
  const real: string[] = [];
  const aliases = new Map<string, string[]>();
  for (const id of ids) {
    const key = canonicalWorkItemKey(id);
    if (key === null) {
      real.push(id);
      continue;
    }
    aliases.set(key, [...(aliases.get(key) ?? []), id]);
  }
  return { ids: real, keys: [...aliases.keys()], aliases };
}

/** The rows the key-shaped tokens name, across the workspace — none when there are none. */
function findKeyTokenRows(
  keys: readonly string[],
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<WorkItem[]> {
  return keys.length
    ? workItemRepository.findByIdentifiersInWorkspace(keys, workspaceId, tx)
    : Promise.resolve<WorkItem[]>([]);
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
  // A token written with a KEY where the id belongs (MOTIR-11281) is resolved as
  // that key across the workspace — not only the active project — because a token
  // id is workspace-wide and a project identifier is workspace-unique.
  const tokens = splitKeyTokens(refs.ids);
  const [keyRows, idRows, keyTokenRows] = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    Promise.all([
      refs.keys.length
        ? workItemRepository.findByIdentifiers(activeProjectId, refs.keys, tx)
        : Promise.resolve<WorkItem[]>([]),
      tokens.ids.length
        ? workItemRepository.findByIdsInWorkspace(tokens.ids, ctx.workspaceId, tx)
        : Promise.resolve<WorkItem[]>([]),
      findKeyTokenRows(tokens.keys, ctx.workspaceId, tx),
    ]),
  );

  // Dedupe by id — a token id and a bare key can name the same item.
  const rowById = new Map<string, WorkItem>();
  for (const r of [...idRows, ...keyRows, ...keyTokenRows]) rowById.set(r.id, r);
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
    const spelled = tokens.aliases.get(row.identifier.toUpperCase()) ?? [];
    if (!browsableProjectIds.has(row.projectId)) {
      // In-workspace but not viewable → bare key only (no title/status leak).
      const noAccess = { accessible: false as const, id: row.id };
      map[row.id] = noAccess;
      for (const token of spelled) map[token] = noAccess;
      continue;
    }
    const status = statusMeta.get(row.projectId)?.get(row.status) ?? null;
    const member = assignees.find((u) => u.id === row.assigneeId);
    const summary = toWorkItemRefSummaryDto(
      row,
      status,
      member ? toWorkItemRefAssigneeDto(member) : null,
    );
    // Keyed by id (token href) AND current identifier (bare-key / title path),
    // and by every key-shaped token that named it, as written.
    map[row.id] = summary;
    map[row.identifier] = summary;
    for (const token of spelled) map[token] = summary;
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
  const tokens = splitKeyTokens(refs.ids);
  const [keyRows, idRows, keyTokenRows] = await withWorkspaceServiceContext(workspaceId, (tx) =>
    Promise.all([
      refs.keys.length
        ? workItemRepository.findByIdentifiers(projectId, refs.keys, tx)
        : Promise.resolve<WorkItem[]>([]),
      tokens.ids.length
        ? workItemRepository.findByIdsInWorkspace(tokens.ids, workspaceId, tx)
        : Promise.resolve<WorkItem[]>([]),
      findKeyTokenRows(tokens.keys, workspaceId, tx),
    ]),
  );
  const visible = [...idRows, ...keyRows, ...keyTokenRows].filter(
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
    for (const token of tokens.aliases.get(row.identifier.toUpperCase()) ?? [])
      map[token] = summary;
  }
  return map;
}

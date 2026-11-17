import {
  Executor,
  WorkItemDifficulty,
  WorkItemKind,
  WorkItemType,
} from '@/generated/prisma/client';
import type { WorkItem } from '@/generated/prisma/client';
import {
  workItemRepository,
  type BoardCardFilter,
  type BoardLanePredicate,
  type BoardLaneScalarField,
  type BoardLaneTag,
} from '@/lib/repositories/workItemRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { labelRepository } from '@/lib/repositories/labelRepository';
import { componentRepository } from '@/lib/repositories/componentRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { personName } from '@/lib/people/personLabel';
import { InvalidBoardLaneError } from '@/lib/boards/errors';
import {
  BOARD_SWIMLANE_NO_VALUE,
  type BoardSwimlaneDto,
  type BoardSwimlaneGroupByDto,
  type BoardSwimlaneKindDto,
} from '@/lib/dto/boards';

// The board's FIELD lanes (MOTIR-11585) — the swimlane group-bys over the
// work-item fields every card already carries, beside the three shipped ones
// (assignee, epic, priority) that `boardsService` keeps as they were.
//
// Two families, and they differ in one fact:
//
//   - SINGLE-VALUE fields (reporter, type, difficulty, executor, kind) are a
//     column of `work_item`, so a card is in exactly one lane. Reporter and kind
//     are never null; type, difficulty and executor are leaf-only, and a card
//     without one (an epic, a story, an untyped leaf) is in the catch-all.
//   - MULTI-VALUE fields (label, component, repository) are join tables, so a
//     card is in the lane of EACH of its values, and in the catch-all when it
//     has none. Each lane counts it once; the column totals (a separate count)
//     still count it once.
//
// Each function here mirrors the shipped trio's one: the lane condition
// (`resolveFieldLane` ↔ `resolveBoardLane`), each card's lane key
// (`resolveFieldLaneKeys` ↔ `resolveSwimlaneKeys`) and the ordered lane list
// (`buildFieldSwimlanes` ↔ `buildSwimlanes`), over the same filter, private-epic
// exclusion and scrum scope.

/** A single-value group-by's work-item column. */
const SCALAR_FIELD: Partial<Record<BoardSwimlaneGroupByDto, BoardLaneScalarField>> = {
  reporter: 'reporterId',
  type: 'type',
  difficulty: 'difficulty',
  executor: 'executor',
  kind: 'kind',
};

/** A multi-value group-by's join. */
const TAG_FIELD: Partial<Record<BoardSwimlaneGroupByDto, BoardLaneTag>> = {
  label: 'label',
  component: 'component',
  repository: 'repository',
};

/**
 * The enum fields' lane order — the enum's own declaration order (difficulty
 * trivial → high, kind epic → subtask), read from the generated client so a new
 * enum member takes its place without an edit here. Reporter is not an enum.
 */
const ENUM_ORDER: Partial<Record<BoardLaneScalarField, readonly string[]>> = {
  type: Object.values(WorkItemType),
  difficulty: Object.values(WorkItemDifficulty),
  executor: Object.values(Executor),
  kind: Object.values(WorkItemKind),
};

/** The catch-all lane's English label per nullable field (the client renders
 *  its own translated name by `kind`; this is the projection's plain label). */
const CATCH_ALL_LABEL: Partial<Record<BoardSwimlaneKindDto, string>> = {
  type: 'No type',
  difficulty: 'No difficulty',
  executor: 'No executor',
  label: 'No label',
  component: 'No component',
  repository: 'No repository',
};

/** Whether `groupBy` is one of the field lanes this module owns. */
export function isFieldGroupBy(groupBy: BoardSwimlaneGroupByDto): boolean {
  return SCALAR_FIELD[groupBy] !== undefined || TAG_FIELD[groupBy] !== undefined;
}

/**
 * Turn a lane key into the lane condition for a FIELD group-by — exactly as
 * {@link resolveFieldLaneKeys} keys a card. Refuses with `InvalidBoardLaneError`
 * a key the field cannot denote: the catch-all of a never-null field (reporter,
 * kind), or a value outside an enum field's members. An id it CAN denote that
 * holds no cards is not refused: its cell is simply empty.
 */
export function resolveFieldLane(
  groupBy: BoardSwimlaneGroupByDto,
  laneKey: string,
): BoardLanePredicate {
  const catchAll = laneKey === BOARD_SWIMLANE_NO_VALUE;
  const tag = TAG_FIELD[groupBy];
  if (tag) return { kind: 'tag', tag, valueId: catchAll ? null : laneKey };
  const field = SCALAR_FIELD[groupBy];
  if (!field) throw new InvalidBoardLaneError(laneKey, groupBy);
  if (catchAll) {
    if (field === 'reporterId' || field === 'kind')
      throw new InvalidBoardLaneError(laneKey, groupBy);
    return { kind: 'field', field, value: null };
  }
  const members = ENUM_ORDER[field];
  if (members && !members.includes(laneKey)) throw new InvalidBoardLaneError(laneKey, groupBy);
  return { kind: 'field', field, value: laneKey };
}

/** A loaded card's value of a single-value field, or null. */
function scalarValueOf(row: WorkItem, field: BoardLaneScalarField): string | null {
  return (row[field] as string | null) ?? null;
}

/**
 * Each loaded card's lane key under a FIELD group-by. A single-value field reads
 * straight off the row (no query). A multi-value field answers the card's FIRST
 * value in lane order — the lane a card that arrives outside any lane read (a
 * moved card's echo) is filed under — or the catch-all when it has none; ONE
 * batched read over the loaded ids, plus the lane-order read of those values.
 */
export async function resolveFieldLaneKeys(
  groupBy: BoardSwimlaneGroupByDto,
  projectId: string,
  rows: WorkItem[],
  workspaceId: string,
): Promise<Map<string, string>> {
  const keyByCard = new Map<string, string>();
  if (rows.length === 0) return keyByCard;
  const field = SCALAR_FIELD[groupBy];
  if (field) {
    for (const r of rows) keyByCard.set(r.id, scalarValueOf(r, field) ?? BOARD_SWIMLANE_NO_VALUE);
    return keyByCard;
  }
  const tag = TAG_FIELD[groupBy];
  if (!tag) return keyByCard;
  const pairs = await withWorkspaceServiceContext(workspaceId, (tx) =>
    workItemRepository.findLaneTagValues(
      tag,
      rows.map((r) => r.id),
      tx,
    ),
  );
  const meta = await loadTagLaneMeta(
    tag,
    pairs.map((p) => p.valueId),
    projectId,
    workspaceId,
  );
  const rankOf = (id: string) => meta.get(id)?.rank ?? Number.MAX_SAFE_INTEGER;
  for (const p of pairs) {
    const current = keyByCard.get(p.cardId);
    if (current === undefined || rankOf(p.valueId) < rankOf(current)) {
      keyByCard.set(p.cardId, p.valueId);
    }
  }
  for (const r of rows) if (!keyByCard.has(r.id)) keyByCard.set(r.id, BOARD_SWIMLANE_NO_VALUE);
  return keyByCard;
}

/** A multi-value lane's header label and its place in the lane order. */
interface TagLaneMeta {
  label: string;
  rank: number;
}

/**
 * The header label and lane rank of each value of a multi-value field: labels
 * and components by NAME (case-insensitive, the locale-aware compare the
 * assignee lanes use), repositories by the project repository SET's own order
 * (`position`) under their realized name when they have one.
 */
async function loadTagLaneMeta(
  tag: BoardLaneTag,
  ids: string[],
  projectId: string,
  workspaceId: string,
): Promise<Map<string, TagLaneMeta>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  if (tag === 'repository') {
    const repos = await withWorkspaceServiceContext(workspaceId, (tx) =>
      projectRepoRepository.listByProject(projectId, workspaceId, tx),
    );
    // `listByProject` is ordered by `position` — the set's own order.
    return new Map(
      repos.map((r, rank) => [r.id, { label: r.githubRepo?.name ?? r.name, rank }] as const),
    );
  }
  const named = await withWorkspaceServiceContext(workspaceId, (tx) =>
    tag === 'label'
      ? labelRepository.findByIds(unique, projectId, tx)
      : componentRepository.findByIds(unique, tx),
  );
  const sorted = [...named].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
  return new Map(sorted.map((row, rank) => [row.id, { label: row.name, rank }] as const));
}

/** The arguments every lane aggregate takes, in the shipped order. */
interface LaneScope {
  projectId: string;
  workspaceId: string;
  statusKeys: string[];
  sprintId?: string;
  laneFilter?: BoardCardFilter;
  /** A Visitor's lanes name people by display name only (MOTIR-6646). */
  nameOnly: boolean;
}

/**
 * The ordered lane list of a FIELD group-by, from ONE bounded grouped aggregate
 * (never a per-card fetch). Reporter lanes sort by display name, as the assignee
 * lanes do; enum fields in their enum order; labels and components by name;
 * repositories in the set's order. The catch-all sorts LAST, and like every
 * lane appears only when it holds a card.
 */
export async function buildFieldSwimlanes(
  groupBy: BoardSwimlaneGroupByDto,
  scope: LaneScope,
): Promise<BoardSwimlaneDto[]> {
  const field = SCALAR_FIELD[groupBy];
  if (field) return buildScalarSwimlanes(groupBy as BoardSwimlaneKindDto, field, scope);
  const tag = TAG_FIELD[groupBy];
  if (tag) return buildTagSwimlanes(groupBy as BoardSwimlaneKindDto, tag, scope);
  return [];
}

async function buildScalarSwimlanes(
  kind: BoardSwimlaneKindDto,
  field: BoardLaneScalarField,
  scope: LaneScope,
): Promise<BoardSwimlaneDto[]> {
  const rows = await withWorkspaceServiceContext(scope.workspaceId, (tx) =>
    workItemRepository.aggregateBoardLanesByField(
      field,
      scope.projectId,
      scope.workspaceId,
      scope.statusKeys,
      scope.sprintId,
      scope.laneFilter,
      tx,
    ),
  );
  const labelOf = field === 'reporterId' ? await reporterLabels(rows, scope.nameOnly) : null;
  const order = ENUM_ORDER[field];
  const lanes: BoardSwimlaneDto[] = rows
    .filter((r): r is { value: string; count: number } => r.value !== null)
    .map((r) => ({
      key: r.value,
      label: labelOf ? (labelOf.get(r.value) ?? 'Unknown user') : r.value,
      kind,
      count: r.count,
    }))
    .sort((a, b) =>
      order ? order.indexOf(a.key) - order.indexOf(b.key) : a.label.localeCompare(b.label),
    );
  const none = rows.find((r) => r.value === null);
  if (none) {
    lanes.push({
      key: BOARD_SWIMLANE_NO_VALUE,
      label: CATCH_ALL_LABEL[kind] ?? 'None',
      kind,
      count: none.count,
    });
  }
  return lanes;
}

/** Reporter lane labels — a member's `name || email`, a Visitor's name only. */
async function reporterLabels(
  rows: Array<{ value: string | null }>,
  nameOnly: boolean,
): Promise<Map<string, string>> {
  const ids = rows.map((r) => r.value).filter((id): id is string => id !== null);
  const users = await userRepository.findByIds(ids);
  return new Map(
    users.map((u) => [u.id, nameOnly ? personName(u.name) : u.name?.trim() || u.email]),
  );
}

async function buildTagSwimlanes(
  kind: BoardSwimlaneKindDto,
  tag: BoardLaneTag,
  scope: LaneScope,
): Promise<BoardSwimlaneDto[]> {
  const rows = await withWorkspaceServiceContext(scope.workspaceId, (tx) =>
    workItemRepository.aggregateBoardLanesByTag(
      tag,
      scope.projectId,
      scope.workspaceId,
      scope.statusKeys,
      scope.sprintId,
      scope.laneFilter,
      tx,
    ),
  );
  const valued = rows.filter((r): r is { valueId: string; count: number } => r.valueId !== null);
  const meta = await loadTagLaneMeta(
    tag,
    valued.map((r) => r.valueId),
    scope.projectId,
    scope.workspaceId,
  );
  const rankOf = (id: string) => meta.get(id)?.rank ?? Number.MAX_SAFE_INTEGER;
  const lanes: BoardSwimlaneDto[] = valued
    .map((r) => ({
      key: r.valueId,
      label: meta.get(r.valueId)?.label ?? r.valueId,
      kind,
      count: r.count,
    }))
    .sort((a, b) => rankOf(a.key) - rankOf(b.key) || a.label.localeCompare(b.label));
  const none = rows.find((r) => r.valueId === null);
  if (none) {
    lanes.push({
      key: BOARD_SWIMLANE_NO_VALUE,
      label: CATCH_ALL_LABEL[kind] ?? 'None',
      kind,
      count: none.count,
    });
  }
  return lanes;
}

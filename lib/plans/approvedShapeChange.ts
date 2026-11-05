// =================================================================
// THE CHANGE PREDICATE (Story MOTIR-5544 · Subtask MOTIR-6225) — is ONE
// `WorkItemRevision` a change to what an approved plan approved, or noise?
//
// Pure, and deliberately its own leaf: the verdict
// (`plansService.resolveApprovedShapeVerdict`) walks a card's revisions after
// the approving plan's `decidedAt` and stops at the FIRST one this module calls
// `'shape'`. Nothing here reads the database.
//
// ⚠️ THE KEY SPELLINGS ARE THE WRITERS', NOT THE CARD'S. Every set below was
// built by reading the code that writes `work_item_revision.diff`
// (`workItemRevisionsService.recordRevision` and its ~40 call sites), so a key
// here is a key some path really writes. The card's prose named two that do not
// exist on a work item:
//
//   * `targetRepoRole` — a PLAN-proposal field only; materialize resolves it to a
//     repository and records `targetRepo` / `targetRepos`. Those are the keys.
//   * "a blocked_by edge" / "a CHILD added or removed" — neither is a key of its
//     own. An edge is a `links: { added?, removed? }` cell whose entries carry a
//     `kind`; only `is_blocked_by` entries are a shape change (a mention's
//     `relates_to` is not). A child added under a container writes NO row on the
//     container at all (the child's own `created` / `parentId` row carries it),
//     so the child set is compared by the service, not here — except a child
//     PERMANENTLY deleted, which leaves `deleted` on the surviving parent.
//
// Both directions of error are expensive, which is why the IGNORED set is
// explicit rather than "everything else": a shape key wrongly ignored hides a
// real planner defect forever; an ignored key wrongly counted files a bug on
// every board drag. A key in NEITHER set is IGNORED (the safe side for a
// predicate that files bugs) — and `tests/plans/approvedShapeChange.test.ts`
// pins that every key a writer is known to emit is classified in one of them.
// =================================================================

/**
 * Revision-diff keys whose presence means the card no longer is what the plan
 * approved: its text, its sizing and routing, its placement, its kind.
 */
export const APPROVED_SHAPE_KEYS: ReadonlySet<string> = new Set([
  // text
  'title',
  'descriptionMd',
  'explanationMd',
  // shape of the work
  'kind',
  'type',
  'executor',
  'storyPoints',
  'estimateMinutes',
  'difficulty',
  'priority',
  // where it ships (the card's `targetRepoRole` is recorded as these two)
  'targetRepo',
  'targetRepos',
  // placement
  'parentId',
  'folderId',
  // a child permanently destroyed — written on the SURVIVING parent
  'deleted',
  // blocked_by edges — only `is_blocked_by` entries count; see classifyRevision
  'links',
  // archive — only an ARCHIVE counts (an unarchive restores); see classifyRevision
  'archivedAt',
]);

/**
 * Revision-diff keys a real writer emits that are NOT a change to what the plan
 * approved — workflow, scheduling, ownership, ordering and annotation.
 */
export const APPROVED_SHAPE_IGNORED_KEYS: ReadonlySet<string> = new Set([
  // a workflow transition (the transition path, the cascade, a status remap)
  'status',
  // backlog / sprint moves and ordering
  'sprintId',
  'backlogRank',
  'position',
  // ownership and dates
  'assigneeId',
  'dueDate',
  'reporterId',
  // metadata that rides an explanation edit (the edit itself is `explanationMd`)
  'explanationSource',
  // annotation, not shape
  'attachments',
  'labels',
  'components',
  'todos',
  'comment',
  // a hand link between a work item and a page (MOTIR-7567) — a cross-reference, not plan shape
  'pageLinks',
  // a plan `remove`'s archive reason (written inside the approve itself)
  'reason',
  // the provenance of a re-scope reset (MOTIR-5359, retired by MOTIR-5640) — it
  // rode a `status` cell on historic rows; the activity registry still reads it
  'statusReset',
  // the OBSOLESCENCE mark + note (MOTIR-6579) — a fact about the card's STANDING
  // (is it still true of the code?), written on done / archived cards by design;
  // marking an approved card is not a change to the work the plan approved
  'obsolescence',
  'obsolescenceNoteMd',
  // a review agent's verdict on the card's delivery (Story MOTIR-10327 · MOTIR-10333) —
  // a judgement of the work, recorded on the card's trail; it changes nothing the plan approved
  'agentVerdict',
  // identity columns only a `created` row carries
  'projectId',
  'key',
  'identifier',
]);

/** The dynamic `customFields.<key>` cell `customFieldValuesService` writes. */
const CUSTOM_FIELD_KEY_PREFIX = 'customFields.';

/** The one link kind that is part of a plan's approved shape. */
const BLOCKED_BY_LINK_KIND = 'is_blocked_by';

export type RevisionShapeClass = 'shape' | 'ignored';

export interface ClassifyRevisionOptions {
  /**
   * The approved state was ARCHIVED — the approving plan `remove`d the card. Then
   * it is the UNARCHIVE that departs from it, and a re-archive restores it.
   */
  approvedArchived?: boolean;
}

/** True when a `links` cell adds or removes at least one `is_blocked_by` edge. */
function touchesBlockedBy(cell: unknown): boolean {
  if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return false;
  const { added, removed } = cell as { added?: unknown; removed?: unknown };
  return [added, removed].some(
    (list) =>
      Array.isArray(list) &&
      list.some(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          (entry as { kind?: unknown }).kind === BLOCKED_BY_LINK_KIND,
      ),
  );
}

/** True when an `archivedAt` cell moves the card AWAY from the approved state. */
function archiveDeparts(cell: unknown, approvedArchived: boolean): boolean {
  if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return false;
  const nowArchived = (cell as { to?: unknown }).to != null;
  return nowArchived !== approvedArchived;
}

/** The keys of a revision diff that are a change to the approved shape. */
export function shapeChangingKeys(diff: unknown, options: ClassifyRevisionOptions = {}): string[] {
  if (!diff || typeof diff !== 'object' || Array.isArray(diff)) return [];
  const cells = diff as Record<string, unknown>;
  return Object.keys(cells).filter((key) => {
    if (!APPROVED_SHAPE_KEYS.has(key)) return false;
    if (key === 'links') return touchesBlockedBy(cells[key]);
    if (key === 'archivedAt') return archiveDeparts(cells[key], options.approvedArchived ?? false);
    return true;
  });
}

/**
 * Classify ONE revision's `diff`: `'shape'` when any key is a change to what the
 * plan approved, `'ignored'` otherwise — including an empty diff, a diff of only
 * right-column keys, and a key no known writer emits.
 */
export function classifyRevision(
  diff: unknown,
  options: ClassifyRevisionOptions = {},
): RevisionShapeClass {
  return shapeChangingKeys(diff, options).length > 0 ? 'shape' : 'ignored';
}

/** Whether a key is a known dynamic custom-field cell (always ignored). */
export function isCustomFieldKey(key: string): boolean {
  return key.startsWith(CUSTOM_FIELD_KEY_PREFIX);
}

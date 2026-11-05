// The diff-renderer registry (Story 5.5 · Subtask 5.5.1) — the single source
// of truth for what every `work_item_revision.diff` key means to the History
// feed. Per the mistake-#29 lesson the registry is TOTAL BY CONSTRUCTION over
// an OPEN key set: every key the codebase writes today has an explicit entry
// (renderable or suppressed — suppression is a decision, never an accident),
// and any key it doesn't know falls through to the generic renderer — a
// legible "changed <key>" entry, never a throw, never a silent drop. The
// totality-guard test (tests/work-items/activity-registry-totality.test.ts)
// scans the services' recordRevision call sites and fails when a sibling
// story lands a key with no explicit disposition, forcing the
// renderable-vs-suppressed decision instead of letting the fallback absorb it
// unnoticed.
//
// Two-phase contract (how the service keeps resolution batched, no N+1):
//   1. `collectDiffRefs` walks a page's diffs and gathers every referenced id
//      (users / status keys / sprints / issues) WITHOUT touching the DB.
//   2. The service resolves all refs in one batched lookup set, builds a
//      DisplayResolvers, and `buildEntryParts` renders each revision from the
//      in-memory maps.
// Renderers therefore do no I/O — they are pure (diff value, resolvers) →
// parts functions, unit-testable without a database.

import type { ActivityEntryPartDto, ActivityValueDto } from '@/lib/dto/activity';

/** The `{ from, to }` cell every scalar diff key carries. */
interface DiffCell {
  from: unknown;
  to: unknown;
}

/** Ids a page of diffs references, gathered before the batched lookups. */
export interface DiffRefs {
  users: Set<string>;
  statuses: Set<string>;
  sprints: Set<string>;
  issues: Set<string>;
  folders: Set<string>;
}

/** The user-shaped display value (narrowed so the actor needs no re-check). */
export type ActivityUserValue = Extract<ActivityValueDto, { type: 'user' }>;

/**
 * The in-memory resolution maps the service builds from ONE batched lookup
 * set per page. Each resolver returns the typed display value, degrading to
 * a null display field (stored id kept) when the referent no longer exists.
 */
export interface DisplayResolvers {
  user(id: string): ActivityUserValue;
  status(key: string): ActivityValueDto;
  sprint(id: string): ActivityValueDto;
  issue(id: string): ActivityValueDto;
  /** A folder, by name (MOTIR-5313); the placement a `folderId` diff records. */
  folder(id: string): ActivityValueDto;
}

type RefCollector = (value: unknown, refs: DiffRefs) => void;
type PartRenderer = (key: string, value: unknown, r: DisplayResolvers) => ActivityEntryPartDto[];

type RegistryEntry =
  | { disposition: 'suppressed' }
  | { disposition: 'renderable'; collectRefs?: RefCollector; render: PartRenderer };

// ---------------------------------------------------------------------------
// Value helpers — defensive by design. A diff value is attacker-shaped as far
// as the renderer is concerned (it round-trips through a JSON column and is
// written by call sites this subtask doesn't own), so every accessor
// tolerates a malformed shape and degrades to the generic form.
// ---------------------------------------------------------------------------

/** Cap for stringified unknown values so a pathological blob can't flood the feed. */
const MAX_GENERIC_LENGTH = 200;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A `{ from, to }` cell, or null when the value isn't one. */
function asCell(value: unknown): DiffCell | null {
  if (!isRecord(value)) return null;
  if (!('from' in value) || !('to' in value)) return null;
  return { from: value['from'], to: value['to'] };
}

/** Safe, bounded display string for an arbitrary JSON value. */
function safeString(v: unknown): string {
  let s: string;
  if (typeof v === 'string') s = v;
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
  else {
    try {
      s = JSON.stringify(v) ?? '';
    } catch {
      s = '';
    }
  }
  return s.length > MAX_GENERIC_LENGTH ? `${s.slice(0, MAX_GENERIC_LENGTH)}…` : s;
}

/** `null`/`undefined` → "None" side; everything else → bounded string. */
function safeStringOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : safeString(v);
}

function noneOr(v: unknown, build: (present: unknown) => ActivityValueDto): ActivityValueDto {
  return v === null || v === undefined ? { type: 'none' } : build(v);
}

function textValue(v: unknown): ActivityValueDto {
  return noneOr(v, (p) => ({ type: 'text', text: safeString(p) }));
}

/** A list, as the joined members — or `none` when it is empty or absent. */
function listValue(v: unknown): ActivityValueDto {
  if (!Array.isArray(v) || v.length === 0) return { type: 'none' };
  return { type: 'text', text: safeString(v.map((m) => safeString(m)).join(', ')) };
}

function dateValue(v: unknown): ActivityValueDto {
  return noneOr(v, (p) =>
    typeof p === 'string' ? { type: 'date', date: p } : { type: 'text', text: safeString(p) },
  );
}

/** The total fallback — ALSO the renderer behind unknown keys (mistake #29). */
function genericPart(key: string, value: unknown): ActivityEntryPartDto {
  const cell = asCell(value);
  if (cell) {
    return {
      kind: 'generic',
      key,
      from: safeStringOrNull(cell.from),
      to: safeStringOrNull(cell.to),
    };
  }
  return { kind: 'generic', key, from: null, to: safeStringOrNull(value) };
}

// ---------------------------------------------------------------------------
// Shared renderer shapes
// ---------------------------------------------------------------------------

/** Scalar field rendered with plain text values (title, priority, kind, …). */
function textField(): RegistryEntry {
  return {
    disposition: 'renderable',
    render: (key, value) => {
      const cell = asCell(value);
      if (!cell) return [genericPart(key, value)];
      return [{ kind: 'field', field: key, from: textValue(cell.from), to: textValue(cell.to) }];
    },
  };
}

/**
 * A LIST-valued scalar field — rendered as its members, joined, so the History
 * entry says WHAT the list became rather than `["a","b"]`.
 *
 * `textField()` would not be wrong here so much as illegible: `safeString`
 * JSON-stringifies a non-scalar, so a repository-set change would read
 * `["motir-core","motir-ai"] → ["motir-ai","motir-core"]` — which is exactly the
 * change a reader auditing a mis-routed dispatch needs to understand, rendered in
 * the form that makes it hardest to.
 *
 * The EMPTY list renders as `none`, the same "—" every nullable field uses when
 * it is cleared. An empty repository set and an unpinned card are one state
 * (`docs/decisions/work-item-repository-set.md` §1), and the History should not
 * invent a second way to say it.
 */
function listField(): RegistryEntry {
  return {
    disposition: 'renderable',
    render: (key, value) => {
      const cell = asCell(value);
      if (!cell) return [genericPart(key, value)];
      return [{ kind: 'field', field: key, from: listValue(cell.from), to: listValue(cell.to) }];
    },
  };
}

/** Body fields — "updated the Description", never the text itself. */
function editedField(): RegistryEntry {
  return {
    disposition: 'renderable',
    render: (key) => [{ kind: 'fieldEdited', field: key }],
  };
}

/** Date-valued scalar field (dueDate, archivedAt). */
function dateField(): RegistryEntry {
  return {
    disposition: 'renderable',
    render: (key, value) => {
      const cell = asCell(value);
      if (!cell) return [genericPart(key, value)];
      return [{ kind: 'field', field: key, from: dateValue(cell.from), to: dateValue(cell.to) }];
    },
  };
}

/** Field whose sides resolve through one of the batched lookup maps. */
function resolvedField(
  ref: keyof DiffRefs,
  resolve: (r: DisplayResolvers, id: string) => ActivityValueDto,
): RegistryEntry {
  const sideRefs = (cell: DiffCell): string[] =>
    [cell.from, cell.to].filter((s): s is string => typeof s === 'string');
  return {
    disposition: 'renderable',
    collectRefs: (value, refs) => {
      const cell = asCell(value);
      if (cell) for (const id of sideRefs(cell)) refs[ref].add(id);
    },
    render: (key, value, r) => {
      const cell = asCell(value);
      if (!cell) return [genericPart(key, value)];
      const side = (v: unknown): ActivityValueDto =>
        noneOr(v, (p) => (typeof p === 'string' ? resolve(r, p) : textValue(p)));
      return [{ kind: 'field', field: key, from: side(cell.from), to: side(cell.to) }];
    },
  };
}

/**
 * In-flight collection shape (attachments / labels / components — Stories
 * 5.2 / 5.4): `{ added: [...] }` / `{ removed: [...] }`. Elements render by
 * their `name` / `title` / `label` property when present, else the bounded
 * string form. Registered ahead of the sibling merges so the keys land with
 * a disposition; a shape mismatch degrades to the generic part.
 */
function collectionField(): RegistryEntry {
  const itemLabel = (el: unknown): string => {
    if (isRecord(el)) {
      for (const prop of ['name', 'title', 'label']) {
        const candidate = el[prop];
        if (typeof candidate === 'string') return candidate;
      }
    }
    return safeString(el);
  };
  return {
    disposition: 'renderable',
    render: (key, value) => {
      if (!isRecord(value)) return [genericPart(key, value)];
      const parts: ActivityEntryPartDto[] = [];
      for (const op of ['added', 'removed'] as const) {
        const items = value[op];
        if (Array.isArray(items) && items.length > 0) {
          parts.push({ kind: 'collection', field: key, op, items: items.map(itemLabel) });
        }
      }
      return parts.length > 0 ? parts : [genericPart(key, value)];
    },
  };
}

// ---------------------------------------------------------------------------
// The registry — every key of the plan-time call-site audit (2026-06-10),
// each with an explicit disposition.
// ---------------------------------------------------------------------------

/**
 * Keys that NEVER produce a feed entry (Jira shows no board-reorder noise in
 * History): pure `position` / `backlogRank` writes and the denormalised
 * `key` / `identifier` columns the create path snapshots. The trail keeps the
 * rows; the feed hides them. Living IN the registry keeps suppression total
 * — the count predicate (`countDisplayableByWorkItem`) and the page filter
 * read this same list, so they can never disagree.
 */
export const SUPPRESSED_DIFF_KEYS = ['position', 'backlogRank', 'key', 'identifier'] as const;

const suppressed: RegistryEntry = { disposition: 'suppressed' };

const linksEntry: RegistryEntry = {
  disposition: 'renderable',
  collectRefs: (value, refs) => {
    if (!isRecord(value)) return;
    for (const op of ['added', 'removed'] as const) {
      const items = value[op];
      if (!Array.isArray(items)) continue;
      for (const el of items) {
        if (isRecord(el) && typeof el['toId'] === 'string') refs.issues.add(el['toId']);
      }
    }
  },
  render: (key, value, r) => {
    if (!isRecord(value)) return [genericPart(key, value)];
    const parts: ActivityEntryPartDto[] = [];
    for (const op of ['added', 'removed'] as const) {
      const items = value[op];
      if (!Array.isArray(items)) continue;
      for (const el of items) {
        if (!isRecord(el) || typeof el['toId'] !== 'string') {
          parts.push(genericPart(key, el));
          continue;
        }
        parts.push({
          kind: 'link',
          op,
          linkKind: typeof el['kind'] === 'string' ? el['kind'] : 'relates_to',
          target: r.issue(el['toId']),
        });
      }
    }
    return parts.length > 0 ? parts : [genericPart(key, value)];
  },
};

/**
 * The 5.1.2 comment-deletion record (changeKind `comment_deleted`, diff
 * `{ comment: { from: { commentId, authorId, replyCount }, to: null } }`) —
 * who deleted whose comment + the reply count, NEVER the content (the
 * verified Jira rule: History shows deletions, content is gone).
 */
const commentEntry: RegistryEntry = {
  disposition: 'renderable',
  collectRefs: (value, refs) => {
    const cell = asCell(value);
    if (cell && isRecord(cell.from) && typeof cell.from['authorId'] === 'string') {
      refs.users.add(cell.from['authorId']);
    }
  },
  render: (key, value, r) => {
    const cell = asCell(value);
    if (!cell || !isRecord(cell.from) || typeof cell.from['authorId'] !== 'string') {
      return [genericPart(key, value)];
    }
    const replyCount = cell.from['replyCount'];
    return [
      {
        kind: 'commentDeleted',
        author: r.user(cell.from['authorId']),
        replyCount: typeof replyCount === 'number' ? replyCount : 0,
      },
    ];
  },
};

/**
 * The 2.8.2 work-item-deletion record (changeKind `deleted`, diff
 * `{ deleted: { from: '<identifier>: <title> (+N descendants)', to: null } }`)
 * — recorded on the PERMANENTLY-deleted item's SURVIVING PARENT, since the
 * deleted rows and their own revisions cascade away (the `comment_deleted`
 * shape, one level up). An EXPLICIT renderable disposition is mandatory here —
 * mistake #29 forbids letting the generic fallback absorb a real event — so the
 * deletion shows in the parent's History. It renders through the shared
 * `generic` part (the summary string carries the gone item + descendant count,
 * no ids to resolve); a dedicated visual entry is owned by the delete UI subtask
 * (2.8.4) / Story 5.5.
 */
const deletedEntry: RegistryEntry = {
  disposition: 'renderable',
  render: (key, value) => [genericPart(key, value)],
};

/**
 * An agent's review VERDICT (changeKind `agent_verdict`, diff
 * `{ agentVerdict: { from: null, to: AgentVerdictSnapshot } }`; Story MOTIR-10327 ·
 * MOTIR-10338) — the snapshot `reviewVerdictRecordService` wrote beside the record. The
 * notified assignee is the one reference to resolve; a malformed snapshot degrades to the
 * generic part rather than crash the feed.
 */
const OUTCOMES = new Set(['decided', 'recorded', 'late', 'second']);
const agentVerdictEntry: RegistryEntry = {
  disposition: 'renderable',
  collectRefs: (value, refs) => {
    const to = asCell(value)?.to;
    if (isRecord(to) && typeof to['notifiedUserId'] === 'string') {
      refs.users.add(to['notifiedUserId']);
    }
  },
  render: (key, value, r) => {
    const to = asCell(value)?.to;
    if (
      !isRecord(to) ||
      typeof to['recordId'] !== 'string' ||
      (to['verdict'] !== 'pass' && to['verdict'] !== 'changes_requested') ||
      typeof to['outcome'] !== 'string' ||
      !OUTCOMES.has(to['outcome']) ||
      typeof to['subjectVersion'] !== 'string'
    ) {
      return [genericPart(key, value)];
    }
    const text = (v: unknown) => (typeof v === 'string' ? v : '');
    return [
      {
        kind: 'agentVerdict',
        recordId: to['recordId'],
        verdict: to['verdict'],
        outcome: to['outcome'] as 'decided' | 'recorded' | 'late' | 'second',
        hosted: to['hosted'] === true,
        harness: text(to['harness']),
        model: text(to['model']),
        subjectVersion: to['subjectVersion'],
        findingsExcerpt: typeof to['findingsExcerpt'] === 'string' ? to['findingsExcerpt'] : null,
        notified: typeof to['notifiedUserId'] === 'string' ? r.user(to['notifiedUserId']) : null,
      },
    ];
  },
};

/**
 * A person DISMISSED the agent's review (changeKind `review_dismissed`, diff
 * `{ reviewDismissal: { from: null, to: ReviewDismissalSnapshot } }`; bug MOTIR-10434) — the
 * snapshot `reviewDismissalService` wrote beside the dismissal row. The actor is the revision's
 * own `changedById`, so there is no reference to resolve; a malformed snapshot degrades to the
 * generic part rather than crash the feed.
 */
const reviewDismissalEntry: RegistryEntry = {
  disposition: 'renderable',
  render: (key, value) => {
    const to = asCell(value)?.to;
    if (
      !isRecord(to) ||
      typeof to['dismissalId'] !== 'string' ||
      typeof to['subjectVersion'] !== 'string' ||
      typeof to['reasonMd'] !== 'string'
    ) {
      return [genericPart(key, value)];
    }
    return [
      {
        kind: 'reviewDismissed',
        dismissalId: to['dismissalId'],
        subjectVersion: to['subjectVersion'],
        reasonMd: to['reasonMd'],
      },
    ];
  },
};

/** Exact-match dispositions. */
const REGISTRY: Record<string, RegistryEntry> = {
  // -- suppressed (the explicit noise policy) ------------------------------
  position: suppressed,
  backlogRank: suppressed,
  key: suppressed,
  identifier: suppressed,
  // The RE-SCOPE RESET's reason (bug MOTIR-5359) — `{ planId, reason, arm }` on the
  // one revision an approved `modify` writes when it walks an in-progress card
  // back to To Do. Suppressed, not rendered: the `status` cell beside it already
  // reads "changed status Implemented → To Do" in the History, and this key is
  // the provenance behind that line (which plan, which arm) for a reader of the
  // trail, not a second visible change.
  statusReset: suppressed,
  // -- plain scalar fields -------------------------------------------------
  title: textField(),
  kind: textField(),
  priority: textField(),
  explanationSource: textField(),
  estimateMinutes: textField(),
  // Work-item type + executor (Story 2.7) — plain enum scalars, rendered like
  // kind/priority (a "changed type code → design" / "changed executor …" entry).
  type: textField(),
  executor: textField(),
  // Difficulty (Story MOTIR-6016) — a plain enum scalar, rendered the same way.
  difficulty: textField(),
  // The OBSOLESCENCE mark (Story MOTIR-6574 · MOTIR-6579) — a plain enum scalar,
  // rendered like difficulty ("changed obsolescence None → outdated").
  obsolescence: textField(),
  storyPoints: textField(),
  // The repo pin (Story 7.9 · MOTIR-1804) — a plain string scalar naming the repo
  // this item's work ships in. RENDERABLE, not suppressed: "which repo does this
  // ship in" is a real planning decision (one subtask = one repo = one PR), and a
  // reader auditing why a dispatch went to the wrong checkout needs to see it
  // change in the History.
  targetRepo: textField(),
  // The repository SET (Story MOTIR-2725 · MOTIR-2728) — renderable for the same
  // reason the pin above is, and a LIST rather than a text field so the entry
  // reads "motir-core → motir-ai, motir-core" instead of two JSON blobs. A
  // re-ORDER is a real change and shows as one: element 0 is the repository
  // dispatch routes to, so moving it moves where an agent runs.
  targetRepos: listField(),
  // ⚠️ UNDER THE REFERENCE MODEL THESE STILL STORE **NAMES**, and an old entry
  // renders VERBATIM (Story MOTIR-2732 · MOTIR-3041, ADR "Amendment 2026-08-18"
  // §A4.2). Deliberate, and the reason is the point of a History at all:
  //
  //   * A cuid tells a reader nothing, and this feed is read by someone auditing
  //     why a dispatch went to the wrong checkout.
  //   * A history entry records what was true THEN. Rendering a reference's
  //     CURRENT name would make an old entry assert something that was not true
  //     when it was written — worse than the staleness it would be fixing.
  //   * So no entry is migrated and none needs a special case: they already hold
  //     names, and they keep rendering exactly as they did.
  //
  // The rename property therefore stops at the History on purpose: a rename moves
  // every LIVE surface and moves nothing about the record of what was decided.
  // That asymmetry is the decision, not an oversight.
  projectId: textField(),
  // -- body fields: edit recorded, content never inlined --------------------
  descriptionMd: editedField(),
  explanationMd: editedField(),
  // The obsolescence NOTE (MOTIR-6579) is Markdown like the two bodies above, so
  // it is recorded as an edit with its content never inlined into the feed.
  obsolescenceNoteMd: editedField(),
  // -- resolved fields (batched display lookups) ----------------------------
  status: resolvedField('statuses', (r, key) => r.status(key)),
  assigneeId: resolvedField('users', (r, id) => r.user(id)),
  reporterId: resolvedField('users', (r, id) => r.user(id)),
  sprintId: resolvedField('sprints', (r, id) => r.sprint(id)),
  parentId: resolvedField('issues', (r, id) => r.issue(id)),
  // Filing into / out of a folder (Story MOTIR-5308 · MOTIR-5313).
  folderId: resolvedField('folders', (r, id) => r.folder(id)),
  // -- date fields ----------------------------------------------------------
  dueDate: dateField(),
  archivedAt: dateField(),
  // -- composite shapes ------------------------------------------------------
  links: linksEntry,
  comment: commentEntry,
  deleted: deletedEntry,
  // -- in-flight 5.2 / 5.4 collection shapes (registered ahead of merge) ----
  // A card's STEPS. Two writers, ONE shape: `workItemTodosService` for a row a
  // person adds by hand, and `plansService.buildAddDiff` for the rows approval
  // materializes from a proposal (Story MOTIR-3810 · MOTIR-4618). Both write
  // `{ added: [{ id, text }] }`, which is what makes the history read the same
  // whichever door the rows came through.
  todos: collectionField(),
  // The hand-made page links of a work item (MOTIR-9197): `{ added | removed:
  // [{ pageId, title }] }`, the page's title as it was at write time.
  pageLinks: collectionField(),
  attachments: collectionField(),
  labels: collectionField(),
  components: collectionField(),
  agentVerdict: agentVerdictEntry,
  reviewDismissal: reviewDismissalEntry,
};

/** Every exact-match key the registry holds a disposition for — the population
 * a reader of the feed must be able to NAME (the item page's field-name map is
 * held to it by `tests/work-items/activity-entry-row-field-names.test.tsx`). */
export const REGISTERED_DIFF_KEYS: readonly string[] = Object.keys(REGISTRY);

/**
 * Prefix-matched dispositions for dynamic key families. `customFields.<key>`
 * (Story 5.3, in flight) renders as a text field for now; the definition /
 * option-label resolution upgrades once the 5.3 reads merge — until then the
 * stored values display in their raw form, which is the documented fallback,
 * not a crash or a drop.
 */
const PREFIX_REGISTRY: ReadonlyArray<{ prefix: string; entry: RegistryEntry }> = [
  { prefix: 'customFields.', entry: textField() },
];

const GENERIC_ENTRY: RegistryEntry = {
  disposition: 'renderable',
  render: (key, value) => [genericPart(key, value)],
};

/**
 * The total lookup: exact entry, else prefix entry, else the generic
 * fallback. NEVER returns undefined — that is the registry's whole contract.
 */
export function dispositionFor(key: string): RegistryEntry {
  const exact = REGISTRY[key];
  if (exact) return exact;
  const byPrefix = PREFIX_REGISTRY.find((p) => key.startsWith(p.prefix));
  if (byPrefix) return byPrefix.entry;
  return GENERIC_ENTRY;
}

/** True when the key has an explicit (non-fallback) disposition. */
export function isRegisteredDiffKey(key: string): boolean {
  return key in REGISTRY || PREFIX_REGISTRY.some((p) => key.startsWith(p.prefix));
}

function isSuppressedKey(key: string): boolean {
  return dispositionFor(key).disposition === 'suppressed';
}

/** Anchor changeKinds that render regardless of (and instead of) the diff. */
const ANCHOR_KINDS = new Set(['created', 'archived', 'unarchived']);

function diffKeysOf(diff: unknown): string[] {
  return isRecord(diff) ? Object.keys(diff) : [];
}

/**
 * Whether a revision produces a feed entry at all. Anchor kinds always do;
 * anything else needs at least one non-suppressed diff key. MUST stay in
 * lockstep with `countDisplayableByWorkItem`'s SQL predicate — both read
 * their key lists from this module.
 */
export function isDisplayableRevision(changeKind: string, diff: unknown): boolean {
  if (ANCHOR_KINDS.has(changeKind)) return true;
  return diffKeysOf(diff).some((k) => !isSuppressedKey(k));
}

/** Phase 1 — gather every id a revision's diff references (no I/O). */
export function collectDiffRefs(changeKind: string, diff: unknown, refs: DiffRefs): void {
  if (ANCHOR_KINDS.has(changeKind)) return;
  if (!isRecord(diff)) return;
  for (const [key, value] of Object.entries(diff)) {
    const entry = dispositionFor(key);
    if (entry.disposition === 'renderable') entry.collectRefs?.(value, refs);
  }
}

export function emptyDiffRefs(): DiffRefs {
  return {
    users: new Set(),
    statuses: new Set(),
    sprints: new Set(),
    issues: new Set(),
    folders: new Set(),
  };
}

/**
 * Phase 2 — render a revision's parts from the resolved maps. `created` /
 * `archived` / `unarchived` render as their anchor part ("created the issue")
 * rather than a 17-field dump; every other kind walks the diff through the
 * registry, drops suppressed keys, and keeps the renderable remainder (mixed
 * diffs render partially). Returns [] only for a non-displayable revision.
 */
export function buildEntryParts(
  changeKind: string,
  diff: unknown,
  resolvers: DisplayResolvers,
): ActivityEntryPartDto[] {
  if (changeKind === 'created') return [{ kind: 'created' }];
  if (changeKind === 'archived') return [{ kind: 'archived' }];
  if (changeKind === 'unarchived') return [{ kind: 'unarchived' }];
  const parts: ActivityEntryPartDto[] = [];
  if (!isRecord(diff)) return parts;
  for (const [key, value] of Object.entries(diff)) {
    const entry = dispositionFor(key);
    if (entry.disposition === 'suppressed') continue;
    parts.push(...entry.render(key, value, resolvers));
  }
  return parts;
}

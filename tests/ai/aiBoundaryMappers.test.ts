import { describe, it, expect } from 'vitest';
import {
  toPlanTreeFolders,
  toPlanTreeSkeleton,
  toSkeletonRows,
  toSearchResultRows,
  toBlockingEdges,
  toSimilarWorkItemRows,
} from '@/lib/mappers/aiBoundaryMappers';
import type { WorkItemListItemDto, WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { WorkItemEmbeddingRankRow } from '@/lib/repositories/workItemEmbeddingRepository';

function summary(over: Partial<WorkItemSummaryDto>): WorkItemSummaryDto {
  return {
    id: 'id_x',
    parentId: null,
    kind: 'story',
    key: 1,
    identifier: 'MOTIR-1',
    title: 'T',
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    position: 'a0',
    estimateMinutes: null,
    storyPoints: null,
    archivedAt: null,
    obsolescence: null,
    obsolescenceNoteMd: null,
    ...over,
  };
}

describe('toPlanTreeSkeleton', () => {
  it('projects to {key, id, kind, title, status, parentKey, revision, folderId, decision, obsolescence} and resolves parentKey + revision', () => {
    const epic = summary({ id: 'id_e', identifier: 'MOTIR-1', kind: 'epic', parentId: null });
    const story = summary({
      id: 'id_s',
      identifier: 'MOTIR-2',
      kind: 'story',
      parentId: 'id_e',
      title: 'Story',
      status: 'in_progress',
    });
    // The batched revision map (MOTIR-1531): the epic has a latest revision, the
    // story has none → `revision: null`.
    const out = toPlanTreeSkeleton(
      [epic, story],
      new Map([['id_e', 'rev_e']]),
      new Map(),
      new Map(),
    );
    expect(out).toEqual([
      {
        key: 'MOTIR-1',
        id: 'id_e',
        kind: 'epic',
        title: 'T',
        status: 'todo',
        parentKey: null,
        revision: 'rev_e',
        folderId: null,
        decision: null,
        obsolescence: null,
      },
      {
        key: 'MOTIR-2',
        id: 'id_s',
        kind: 'story',
        title: 'Story',
        status: 'in_progress',
        parentKey: 'MOTIR-1',
        revision: null,
        folderId: null,
        decision: null,
        obsolescence: null,
      },
    ]);
  });

  it('maps an empty project to an empty skeleton', () => {
    expect(toPlanTreeSkeleton([], new Map(), new Map(), new Map())).toEqual([]);
  });

  it('yields parentKey=null for a parent outside the batch', () => {
    const orphan = summary({ id: 'id_o', identifier: 'MOTIR-9', parentId: 'id_missing' });
    expect(toPlanTreeSkeleton([orphan], new Map(), new Map(), new Map())[0]!.parentKey).toBeNull();
  });

  it('leaves revision null when the item has no entry in the batched map', () => {
    const item = summary({ id: 'id_o', identifier: 'MOTIR-9' });
    expect(toPlanTreeSkeleton([item], new Map(), new Map(), new Map())[0]!.revision).toBeNull();
  });

  // MOTIR-5410 — the item's OWN folder placement rides the row, from the batched
  // lookup; an item with no entry is not filed.
  it('carries folderId for a filed row and null for every other row', () => {
    const filed = summary({ id: 'id_f', identifier: 'MOTIR-3', kind: 'epic' });
    const loose = summary({ id: 'id_l', identifier: 'MOTIR-4', kind: 'epic' });
    const out = toPlanTreeSkeleton(
      [filed, loose],
      new Map(),
      new Map([['id_f', 'fold_1']]),
      new Map(),
    );
    expect(out.map((r) => [r.key, r.folderId])).toEqual([
      ['MOTIR-3', 'fold_1'],
      ['MOTIR-4', null],
    ]);
  });
});

describe('toSkeletonRows', () => {
  it('resolves folderId on depth-read rows through the same batched map', () => {
    const rows = toSkeletonRows(
      [
        {
          id: 'id_a',
          parentId: null,
          kind: 'story',
          identifier: 'MOTIR-7',
          title: 'A',
          status: 'todo',
          obsolescence: null,
        },
      ],
      new Map(),
      new Map([['id_a', 'fold_9']]),
      new Map(),
    );
    expect(rows[0]!.folderId).toBe('fold_9');
  });

  // MOTIR-5958 / MOTIR-10146 — a decision's deciding gate rides the row from the
  // batched map; every other row carries `decision: null`.
  it('carries the decision block for a decision row and null for every other row', () => {
    const block = {
      kind: 'decision_approval' as const,
      state: 'confirmed' as const,
      decidedAt: '2026-09-21T00:00:00.000Z',
      replanOwed: null,
      noteMd: null,
    };
    const rows = toSkeletonRows(
      [
        {
          id: 'id_d',
          parentId: null,
          kind: 'task',
          identifier: 'MOTIR-8',
          title: 'D',
          status: 'done',
          obsolescence: null,
        },
        {
          id: 'id_x',
          parentId: null,
          kind: 'task',
          identifier: 'MOTIR-9',
          title: 'X',
          status: 'todo',
          obsolescence: null,
        },
      ],
      new Map(),
      new Map(),
      new Map([['id_d', block]]),
    );
    expect(rows.map((r) => [r.key, r.decision])).toEqual([
      ['MOTIR-8', block],
      ['MOTIR-9', null],
    ]);
  });
});

// MOTIR-6582 — the OBSOLESCENCE mark rides every skeleton row, on the breadth read
// and the depth reads alike; the NOTE never does (bodies stay off the breadth read).
describe('the obsolescence mark on skeleton rows', () => {
  it('carries the mark on a marked row, null on an unmarked one, and never the note', () => {
    const marked = summary({
      id: 'id_m',
      identifier: 'MOTIR-5',
      obsolescence: 'outdated',
      obsolescenceNoteMd: 'Rewritten by MOTIR-6.',
    });
    const current = summary({ id: 'id_c', identifier: 'MOTIR-6' });
    const out = toPlanTreeSkeleton([marked, current], new Map(), new Map(), new Map());
    // Order is the input's — a marked row is neither dropped nor moved.
    expect(out.map((r) => [r.key, r.obsolescence])).toEqual([
      ['MOTIR-5', 'outdated'],
      ['MOTIR-6', null],
    ]);
    expect(Object.keys(out[0]!)).not.toContain('obsolescenceNoteMd');
  });
});

describe('toPlanTreeFolders', () => {
  it('projects exactly {id, parentFolderId, name, path} — the picker position does not cross', () => {
    const out = toPlanTreeFolders([
      { id: 'f1', parentFolderId: null, name: 'Parked', position: 'a0', path: ['Parked'] },
      { id: 'f2', parentFolderId: 'f1', name: '2025', position: 'a0', path: ['Parked', '2025'] },
    ]);
    expect(out).toEqual([
      { id: 'f1', parentFolderId: null, name: 'Parked', path: ['Parked'] },
      { id: 'f2', parentFolderId: 'f1', name: '2025', path: ['Parked', '2025'] },
    ]);
    expect(Object.keys(out[0]!).sort()).toEqual(['id', 'name', 'parentFolderId', 'path']);
  });
});

function listItem(over: Partial<WorkItemListItemDto>): WorkItemListItemDto {
  return {
    id: 'id_x',
    kind: 'task',
    type: 'code',
    key: 1,
    identifier: 'MOTIR-1',
    title: 'T',
    status: 'todo',
    ciState: null,
    fixReason: null,
    priority: 'medium',
    assigneeId: null,
    reporterId: 'u_1',
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    updatedAt: '2026-07-01T00:00:00.000Z',
    hasDescription: false,
    obsolescence: null,
    obsolescenceNoteMd: null,
    ...over,
  };
}

describe('toSearchResultRows', () => {
  it('projects the flat List row to {key, id, kind, type, title, status, priority, revision, obsolescence} — no parentKey, no note', () => {
    const rows = toSearchResultRows(
      [
        listItem({
          id: 'id_7',
          identifier: 'MOTIR-7',
          kind: 'task',
          type: 'code',
          title: 'Beta',
          status: 'in_progress',
          priority: 'high',
        }),
        listItem({
          id: 'id_8',
          identifier: 'MOTIR-8',
          kind: 'story',
          type: null,
          title: 'Gamma',
          status: 'todo',
          priority: 'low',
          obsolescence: 'deprecated',
          obsolescenceNoteMd: 'Replaced.',
        }),
      ],
      new Map([['id_7', 'rev_7']]),
    );
    expect(rows).toEqual([
      {
        key: 'MOTIR-7',
        id: 'id_7',
        kind: 'task',
        type: 'code',
        title: 'Beta',
        status: 'in_progress',
        priority: 'high',
        revision: 'rev_7',
        obsolescence: null,
      },
      {
        key: 'MOTIR-8',
        id: 'id_8',
        kind: 'story',
        type: null,
        title: 'Gamma',
        status: 'todo',
        priority: 'low',
        revision: null,
        obsolescence: 'deprecated',
      },
    ]);
  });

  it('maps an empty page to an empty list', () => {
    expect(toSearchResultRows([], new Map())).toEqual([]);
  });
});

// ── Story MOTIR-2694 · Subtask MOTIR-2698 ────────────────────────────────────
// The two projections this file did not reach. Both matter for the same reason
// the ones above do — they are the only place a boundary payload's SHAPE is
// decided — and until this card neither was in the coverage report at all:
// MOTIR-2696/2697 gated the five files they wrote whole and left this module,
// which they only ADDED to, un-included. It is gated from here (`vitest.config.ts`).

describe('toBlockingEdges', () => {
  it('maps both endpoints of an edge through the id→key map', () => {
    const idToKey = new Map([
      ['id_a', 'MOTIR-1'],
      ['id_b', 'MOTIR-2'],
    ]);
    expect(toBlockingEdges([{ blockedId: 'id_a', blockerId: 'id_b' }], idToKey)).toEqual([
      { blockedKey: 'MOTIR-1', blockerKey: 'MOTIR-2' },
    ]);
  });

  it('falls back to the raw id on EITHER endpoint the map does not carry', () => {
    // Never happens for a well-formed closure — every endpoint is the root or a
    // returned node — so this arm exists so a MALFORMED one degrades to an
    // unresolvable id rather than to `undefined` in the payload. Both endpoints
    // are exercised: the two `??` are separate branches, and a fallback that
    // worked on one side only would still emit `undefined` on the other.
    expect(
      toBlockingEdges(
        [
          { blockedId: 'ghost', blockerId: 'id_b' },
          { blockedId: 'id_b', blockerId: 'phantom' },
        ],
        new Map([['id_b', 'MOTIR-2']]),
      ),
    ).toEqual([
      { blockedKey: 'ghost', blockerKey: 'MOTIR-2' },
      { blockedKey: 'MOTIR-2', blockerKey: 'phantom' },
    ]);
  });

  it('maps an empty closure to no edges', () => {
    expect(toBlockingEdges([], new Map())).toEqual([]);
  });
});

describe('toSimilarWorkItemRows — THE keys-not-prose enforcement point (ADR §2)', () => {
  it('names exactly key / title / score, and converts distance to similarity once', () => {
    const rows: WorkItemEmbeddingRankRow[] = [
      { workItemId: 'id_1', identifier: 'MOTIR-1', title: 'Nearest', distance: 0 },
      { workItemId: 'id_2', identifier: 'MOTIR-2', title: 'Orthogonal', distance: 1 },
      { workItemId: 'id_3', identifier: 'MOTIR-3', title: 'Opposite', distance: 2 },
    ];
    // Two units, ONE conversion, in one named place: the repository ranks by
    // cosine DISTANCE (lower = closer) and the wire carries SIMILARITY (higher =
    // closer), so a caller filtering on `minScore` never has to remember which
    // way the number runs.
    expect(toSimilarWorkItemRows(rows)).toEqual([
      { key: 'MOTIR-1', title: 'Nearest', score: 1 },
      { key: 'MOTIR-2', title: 'Orthogonal', score: 0 },
      { key: 'MOTIR-3', title: 'Opposite', score: -1 },
    ]);
  });

  it('is INERT to a field added to the ranked row — the mapper is the choke point', () => {
    // `docs/decisions/plan-tree-embeddings.md` §2: a fourth content field on this
    // payload is a change to the ADR, not a change to the endpoint. The mechanism
    // that makes that true is HERE — the mapper names its three fields instead of
    // spreading the row, so the day someone adds a column to the ranking query
    // for a perfectly good internal reason, the wire shape does not follow it out
    // of the building. A spread would; this is that difference, exercised rather
    // than commented. (The same claim is proven over the whole route, against a
    // real Postgres, in `tests/integration/ai/semanticSearchStoryGate.test.ts`.)
    const widened = [
      {
        workItemId: 'id_1',
        identifier: 'MOTIR-1',
        title: 'Nearest',
        distance: 0,
        descriptionMd: 'PROSE THAT MUST NOT CROSS',
        snippet: 'nor this',
      } as unknown as WorkItemEmbeddingRankRow,
    ];
    const out = toSimilarWorkItemRows(widened);
    expect(Object.keys(out[0]!).sort()).toEqual(['key', 'score', 'title']);
    expect(JSON.stringify(out)).not.toContain('MUST NOT CROSS');
  });

  it('maps an empty ranking to an empty projection', () => {
    expect(toSimilarWorkItemRows([])).toEqual([]);
  });
});

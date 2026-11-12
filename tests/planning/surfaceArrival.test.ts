// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { arrivesInsideAnchor, surfaceArrivalTrail } from '@/lib/planning/surfaceArrival';
import type { WorkItemKindDto } from '@/lib/dto/workItems';
import { ISSUE_TYPES } from '@/lib/issues/parentRules';

// THE ARRIVAL RULE (MOTIR-6160, Story MOTIR-6154) — where the planning surface's
// canvas OPENS. The rule is one pure function precisely so it can be ruled on
// here once, rather than through three entrances' worth of component render.

const EPIC = { id: 'wi_1', identifier: 'MOTIR-1', title: 'Refine AI planning' };
const STORY = { id: 'wi_3', identifier: 'MOTIR-3', title: 'The story' };

function anchorOf(kind: WorkItemKindDto) {
  return { id: 'wi_7', identifier: 'MOTIR-7', title: 'The anchor', kind };
}

describe('surfaceArrivalTrail', () => {
  it('an anchor WITH children opens INSIDE it — ancestors ++ the anchor', () => {
    const trail = surfaceArrivalTrail({
      anchor: anchorOf('story'),
      ancestors: [EPIC],
      hasChildren: true,
    });

    expect(trail.map((c) => c.id)).toEqual(['wi_1', 'wi_7']);
    // The LAST crumb is the level the canvas loads, so it is the anchor itself.
    expect(trail.at(-1)).toEqual({
      id: 'wi_7',
      crumbKey: 'MOTIR-7',
      label: 'MOTIR-7 · The anchor',
    });
  });

  it('a `subtask` anchor stays BESIDE — ancestors only, the ring case', () => {
    // The one structural leaf: nothing may be parented to a subtask, so it has no
    // inside to open. This is MOTIR-2070's arrival, kept for exactly this kind.
    const trail = surfaceArrivalTrail({
      anchor: anchorOf('subtask'),
      ancestors: [EPIC, STORY],
      hasChildren: false,
    });

    expect(trail.map((c) => c.id)).toEqual(['wi_1', 'wi_3']);
  });

  it.each<WorkItemKindDto>(['epic', 'story', 'task', 'bug'])(
    'a `%s` anchor WITH children opens inside it',
    (kind) => {
      const trail = surfaceArrivalTrail({
        anchor: anchorOf(kind),
        ancestors: [EPIC],
        hasChildren: true,
      });
      expect(trail.map((c) => c.id)).toEqual(['wi_1', 'wi_7']);
      expect(arrivesInsideAnchor({ anchor: anchorOf(kind), hasChildren: true })).toBe(true);
    },
  );

  // MOTIR-7621 — the kind says whether an item CAN have children, not whether
  // it DOES. A childless story, task or bug opened inside landed on an empty
  // level with the item the conversation is about nowhere on screen.
  it.each<WorkItemKindDto>(['epic', 'story', 'task', 'bug'])(
    'a CHILDLESS `%s` anchor stays BESIDE — its own level, the ring case',
    (kind) => {
      const trail = surfaceArrivalTrail({
        anchor: anchorOf(kind),
        ancestors: [EPIC],
        hasChildren: false,
      });
      expect(trail.map((c) => c.id)).toEqual(['wi_1']);
      expect(arrivesInsideAnchor({ anchor: anchorOf(kind), hasChildren: false })).toBe(false);
    },
  );

  it('a childless ROOT anchor opens the project root, where it sits', () => {
    // A freshly filed bug with no parent: its own level IS the root.
    expect(
      surfaceArrivalTrail({ anchor: anchorOf('bug'), ancestors: [], hasChildren: false }),
    ).toEqual([]);
  });

  // The Plan button on a FILED, childless root story (MOTIR-10861) opened the
  // canvas on the project root, where only the folder's door is drawn. The
  // trail now walks through the anchor's placement folders first, as
  // `/roadmap?item=`'s `resolveArrivalTrail` does.
  it('a childless ROOT anchor FILED in a folder opens on that folder, where it sits', () => {
    const trail = surfaceArrivalTrail({
      anchor: anchorOf('story'),
      ancestors: [],
      hasChildren: false,
      folders: [
        { id: 'f_1', name: 'Later' },
        { id: 'f_2', name: 'To do' },
      ],
    });
    expect(trail).toEqual([
      { id: 'folder:f_1', label: 'Later' },
      { id: 'folder:f_2', label: 'To do' },
    ]);
  });

  it('the folder crumbs come BEFORE the work-item ancestors and the anchor', () => {
    const trail = surfaceArrivalTrail({
      anchor: anchorOf('story'),
      ancestors: [EPIC],
      hasChildren: true,
      folders: [{ id: 'f_2', name: 'To do' }],
    });
    expect(trail.map((c) => c.id)).toEqual(['folder:f_2', 'wi_1', 'wi_7']);
  });

  it('a NULL anchor drops the folder crumbs too', () => {
    expect(
      surfaceArrivalTrail({
        anchor: null,
        ancestors: [],
        hasChildren: false,
        folders: [{ id: 'f_2', name: 'To do' }],
      }),
    ).toEqual([]);
  });

  it('a NULL anchor opens the root — the no-existence-leak degradation', () => {
    // `fetchPlanningAnchor` answers `null` for a stale, deleted, foreign or
    // forbidden key alike, and all four must be indistinguishable from "no target
    // was named". The ancestors are dropped rather than kept: a trail with no
    // anchor is not a level anyone asked for.
    expect(
      surfaceArrivalTrail({ anchor: null, ancestors: [EPIC, STORY], hasChildren: true }),
    ).toEqual([]);
    expect(arrivesInsideAnchor({ anchor: null, hasChildren: true })).toBe(false);
  });

  it('a ROOT-LEVEL anchor with children opens on its own children, with a one-crumb trail', () => {
    // An epic has no ancestors, so the whole trail is the epic itself — the canvas
    // opens on its stories rather than on the project root.
    const trail = surfaceArrivalTrail({
      anchor: anchorOf('epic'),
      ancestors: [],
      hasChildren: true,
    });

    expect(trail.map((c) => c.id)).toEqual(['wi_7']);
  });

  it('a DEEP ancestor chain is carried root-first, in order', () => {
    const deep = [
      EPIC,
      STORY,
      { id: 'wi_5', identifier: 'MOTIR-5', title: 'A task' },
      { id: 'wi_6', identifier: 'MOTIR-6', title: 'A bug' },
    ];
    const trail = surfaceArrivalTrail({
      anchor: anchorOf('bug'),
      ancestors: deep,
      hasChildren: true,
    });

    expect(trail.map((c) => c.id)).toEqual(['wi_1', 'wi_3', 'wi_5', 'wi_6', 'wi_7']);
    expect(trail.map((c) => c.crumbKey)).toEqual([
      'MOTIR-1',
      'MOTIR-3',
      'MOTIR-5',
      'MOTIR-6',
      'MOTIR-7',
    ]);
  });

  it('every crumb carries the shared `identifier · title` label and its crumbKey', () => {
    // Not a second label format: `workItemCrumbLabel` is the one the roadmap, the
    // plan review and the plain canvas all render, so an arrival crumb and a
    // hand-drilled crumb are indistinguishable.
    const trail = surfaceArrivalTrail({
      anchor: anchorOf('story'),
      ancestors: [EPIC],
      hasChildren: true,
    });

    expect(trail[0]).toEqual({
      id: 'wi_1',
      crumbKey: 'MOTIR-1',
      label: 'MOTIR-1 · Refine AI planning',
    });
  });

  it('is pure — it does not mutate the ancestors it was handed', () => {
    const ancestors = [EPIC];
    surfaceArrivalTrail({ anchor: anchorOf('story'), ancestors, hasChildren: true });

    expect(ancestors).toHaveLength(1);
  });
});

describe('the rule reads CHILDREN, not KIND', () => {
  // ⚠️ THE POINT OF THIS BLOCK (MOTIR-7621). The rule used to be a
  // `Record<WorkItemKindDto, boolean>` that agreed with the kind matrix; that
  // answers "can it have children", which is the wrong question. Every kind is
  // ruled on here, taken from the matrix ITSELF so a new kind arrives in the
  // loop automatically: the answer must follow `hasChildren` and nothing else.
  const ALL_KINDS = ISSUE_TYPES as readonly WorkItemKindDto[];

  it('arrives inside exactly when the anchor has children, whatever its kind', () => {
    for (const kind of ALL_KINDS) {
      expect(arrivesInsideAnchor({ anchor: anchorOf(kind), hasChildren: true })).toBe(true);
      expect(arrivesInsideAnchor({ anchor: anchorOf(kind), hasChildren: false })).toBe(false);
    }
  });

  it('the trail and the predicate agree — the last crumb is the anchor iff inside', () => {
    for (const kind of ALL_KINDS) {
      for (const hasChildren of [true, false]) {
        const trail = surfaceArrivalTrail({
          anchor: anchorOf(kind),
          ancestors: [EPIC],
          hasChildren,
        });
        expect(trail.at(-1)?.id === 'wi_7').toBe(
          arrivesInsideAnchor({ anchor: anchorOf(kind), hasChildren }),
        );
      }
    }
  });
});

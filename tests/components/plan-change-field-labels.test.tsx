// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanItemNode } from '@/components/planning/PlanItemNode';
import { PLAN_ITEM_CHANGE_FIELDS } from '@/lib/dto/planReview';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';

// MOTIR-3151. `planReviewService.buildChanges` emits a change row per patched
// field and BOTH review surfaces name that row by interpolating the field into a
// message key (`field_<wire name>`). No compiler and no type can follow that, so
// MOTIR-1532 added the sizing rows, stopped at the producer, and the plan-review
// canvas rendered `planReview.field_storyPoints` to a human deciding whether to
// approve a plan — with nothing red anywhere.
//
// This file is the check that was missing: the wire vocabulary is a closed list
// (`PLAN_ITEM_CHANGE_FIELDS`), and every member of it owes copy in every catalog
// and a name in each of the hand-maintained maps that stand between a field and
// its label.
//
// ⚠️ MOTIR-6342 removed the canvas chrome's own map (`planChangeDiff`'s
// `FIELD_KEY`) and its `planningWorkspace.conversation.diff.field.*` copy with the
// level builder that rendered them (MOTIR-6299). The changed node now names a
// field through `PlanItemNode`'s DiffLine and the `planReview.field_*` labels, so
// the catalogue case above and the DiffLine cases below are what detect a field
// with no label.
//
// ⚠️ MOTIR-3242 added a FOURTH such surface — the plan detail's LIST body
// (`PlanProposalList`), which names a `modify`'s changed fields the same
// interpolated way. It is covered by EXTENDING this file rather than by a fifth
// copy of the idea, which is the whole reason the file exists. The DiffLine cases at the foot cover the other half —
// what a field with NO copy must degrade to, so the next gap is readable rather
// than a leaked key path.

afterEach(cleanup);

const CATALOGS = { en: enMessages, zh: zhMessages } as const;
// `planEdits` was the second namespace here until MOTIR-4261 retired it with
// `PlanEditsReviewDock`, the only surface that rendered it — and that dock's
// `FIELD_KEYS` map with it.
const NAMESPACES = ['planReview'] as const;
const LOCALES = Object.keys(CATALOGS) as (keyof typeof CATALOGS)[];

/** The catalogs are imported as their literal JSON types; every lookup here is
 *  by a computed key, so read them through one loose view rather than casting at
 *  each call site. */
type LooseCatalog = Record<string, unknown>;

function labels(locale: keyof typeof CATALOGS, path: readonly string[]): Record<string, string> {
  let node = CATALOGS[locale] as unknown as LooseCatalog;
  for (const segment of path) node = node[segment] as LooseCatalog;
  return node as Record<string, string>;
}

describe('the change-list field vocabulary', () => {
  const cases = NAMESPACES.flatMap((namespace) =>
    LOCALES.map((locale) => [namespace, locale] as const),
  );

  it.each(cases)('%s carries a %s label for every field the wire can name', (namespace, locale) => {
    const block = labels(locale, [namespace]);
    for (const field of PLAN_ITEM_CHANGE_FIELDS) {
      const key = `field_${field}`;
      // A key-path render is what a MISSING message looks like on screen, so the
      // absence is asserted per field rather than as a count — the count passes
      // when two fields are added and one label is.
      expect(block[key], `messages/${locale}.json ${namespace}.${key} is missing`).toBeTruthy();
    }
  });
});

function modifiedItem(changes: PlanReviewItemDto['changes']): PlanReviewItemDto {
  return {
    planItemId: 'pi_size',
    op: 'modify',
    nodeId: 'wi_size',
    parentNodeId: null,
    parentIdentifier: null,
    parentTitle: null,
    parentKind: null,
    parentTrail: [],
    // The FOLDER placement (MOTIR-5415) — none by default.
    folderId: null,
    folderPath: null,
    folderMissing: false,
    folderTrail: [],
    blockedByNodeIds: [],
    blockedByRemovedNodeIds: [],
    committedBlockedBy: [],
    blockerStubs: [],
    identifier: 'PROD-21',
    title: 'Seller onboarding',
    kind: 'subtask',
    priority: null,
    type: null,
    descriptionMd: null,
    explanationMd: null,
    explanationSource: null,
    storyPoints: null,
    estimateMinutes: null,
    difficulty: null,
    targetRepo: null,
    targetRepos: [],
    targetRepositories: null,
    targetRepositoryRef: null,
    targetRepoRole: null,
    executor: null,
    planningProvenance: null,
    subject: null,
    initRepositoryName: null,
    status: 'todo',
    statusLabel: null,
    statusCategory: null,
    hasChildren: false,
    changes,
    stale: false,
    staleReasons: [],
    revised: false,
    targetMissing: false,
    removeReason: null,
    todos: null,
    proposal: {
      op: 'add',
      identifier: null,
      changedFields: [],
      settableRailFields: [],
      todos: null,
    },
  };
}

describe('DiffLine', () => {
  it('renders the sizing labels in zh as well as en', () => {
    // The catalogue assertions above prove the KEYS exist; this proves the
    // surface reads them, in the locale that has no English to fall back on.
    renderWithIntl(
      <PlanItemNode item={modifiedItem([{ field: 'storyPoints', from: '3', to: '5' }])} />,
      { locale: 'zh', messages: zhMessages },
    );
    const line = screen.getByTestId('diff-line');
    expect(line.textContent).not.toContain('field_storyPoints');
    expect(line.textContent).toContain('故事点');
  });

  it('renders a field the catalog does not know as its WIRE NAME, never a key path', () => {
    // Deliberately absent from every catalog: this is the shape of the NEXT
    // field somebody teaches `buildChanges` to emit — and of a field a deployed
    // client's bundle simply predates. `PlanItemChangeDto.field` stays a plain
    // `string` so that case can be REPRESENTED here at all; the surface must
    // degrade rather than print `planReview.field_…`.
    const unknown = 'aFieldNoCatalogKnows';
    renderWithIntl(<PlanItemNode item={modifiedItem([{ field: unknown, from: 'a', to: 'b' }])} />);
    const line = screen.getByTestId('diff-line');
    expect(line.textContent).not.toContain('planReview.');
    expect(line.textContent).toContain(unknown);
  });
});

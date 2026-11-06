// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { planReviewItem } from '../helpers/planReview';
import {
  compileGlobals,
  resolveDeclarations,
  type UtilityCompiler,
} from '../helpers/tailwindCascade';
import { PlanItemNode } from '@/components/planning/PlanItemNode';
import {
  GhostAnchor,
  LevelGroupNode,
  WorkItemNode,
  type WorkItemNodeData,
} from '@/components/planning/WorkItemNode';

// MOTIR-5459 — canvas card titles CLAMP. Plan and roadmap nodes have a fixed
// height designed around a two-line title (one line for the ghost anchor's
// lines), and the clamp is what keeps a long title inside it.
//
// ⚠️ ASSERTED ON WHAT THE CLASS LIST RESOLVES TO, NEVER ON THE CLASS BEING PRESENT.
// Every one of these elements carried `line-clamp-*` while the clamp did nothing:
// each also carried `block`, which Tailwind emits AFTER `line-clamp-*`, so it took
// `display` back from `-webkit-box` and `-webkit-line-clamp` went inert. A
// `className` containing `line-clamp-1` — which `WorkItemNode.test.tsx` asserts —
// was true of the broken element. happy-dom applies no stylesheet, so the
// resolution is folded from the real compiled `app/globals.css`
// (`tests/helpers/tailwindCascade.ts`). The tree-wide half of this is
// `tests/theme/lineClampDisplayOverride.test.ts`.

afterEach(cleanup);

let compiler: UtilityCompiler;
beforeAll(async () => {
  compiler = await compileGlobals();
});

/** The `display` and line clamp an element's own utilities resolve to. */
function clampOf(el: Element | null) {
  expect(el, 'the clamped element rendered').not.toBeNull();
  const tokens = (el!.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  const resolved = resolveDeclarations(compiler.build(tokens), tokens);
  return { display: resolved.get('display'), lines: resolved.get('-webkit-line-clamp') };
}

const LONG_TITLE = Array.from(
  { length: 4 },
  () => 'A long, descriptive work item title that keeps going past its line budget',
).join(' ');

const workItem: WorkItemNodeData = {
  id: 'T1',
  identifier: 'MOTIR-1194',
  title: LONG_TITLE,
  kind: 'subtask',
  status: 'in_progress',
  assigneeName: 'Yue',
};

describe('PlanItemNode — the title clamps inside the box', () => {
  // The title-only body (MOTIR-10508) clamps at THREE lines when the card has no
  // footer — the room the old identifier line used to take.
  it.each(['add', 'remove'] as const)('a long `%s` title is a three-line -webkit-box', (op) => {
    renderWithIntl(<PlanItemNode item={planReviewItem({ op, title: LONG_TITLE })} />);
    expect(clampOf(screen.getByText(LONG_TITLE))).toEqual({ display: '-webkit-box', lines: '3' });
  });

  // MOTIR-5310 spends the bottom slot on a folder placement and drops the title
  // to ONE line with `truncate`, which needs the block box `.block` gives it — so
  // `block` rides with `truncate` on that branch and never beside the clamp.
  // Re-pinned on the case that still SPENDS the slot (Part XVIII decision 2: a
  // filed add no longer does — it sits on its folder's level). The rule is the
  // same one: a spent slot makes the title a one-line block ellipsis.
  it('a title whose bottom slot is spent (a deleted folder) is a one-line block ellipsis, not a clamp', () => {
    renderWithIntl(
      <PlanItemNode
        item={planReviewItem({
          title: LONG_TITLE,
          folderId: 'fold_1',
          folderPath: null,
          folderMissing: true,
        })}
      />,
    );
    const el = screen.getByText(LONG_TITLE);
    const tokens = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    const resolved = resolveDeclarations(compiler.build(tokens), tokens);
    expect(resolved.get('display')).toBe('block');
    expect(resolved.get('white-space')).toBe('nowrap');
    expect(resolved.get('text-overflow')).toBe('ellipsis');
    expect(resolved.has('-webkit-line-clamp')).toBe(false);
  });
});

describe('WorkItemNode — the title clamps at two lines', () => {
  it('a long title is a two-line -webkit-box', () => {
    const { container } = renderWithIntl(<WorkItemNode item={workItem} />);
    expect(clampOf(container.querySelector('[data-node-title]'))).toEqual({
      display: '-webkit-box',
      lines: '2',
    });
  });

  it('the level group node’s title is a two-line -webkit-box', () => {
    const { container } = renderWithIntl(<LevelGroupNode count={7} />);
    expect(clampOf(container.querySelector('[data-node-title]'))).toEqual({
      display: '-webkit-box',
      lines: '2',
    });
  });
});

describe('GhostAnchor — every text line clamps at one line', () => {
  it.each([
    ['in a parent', { parentTitle: LONG_TITLE }],
    ['out of sprint', { outOfSprint: true }],
    ['elsewhere', {}],
  ] as const)('%s: the title and the where-line are one-line -webkit-boxes', (_label, props) => {
    const { container } = renderWithIntl(
      <GhostAnchor identifier="PROD-42" title={LONG_TITLE} {...props} />,
    );
    const clamped = [...container.querySelectorAll('[class*="line-clamp-"]')];
    expect(clamped).toHaveLength(2);
    for (const el of clamped) expect(clampOf(el)).toEqual({ display: '-webkit-box', lines: '1' });
  });
});

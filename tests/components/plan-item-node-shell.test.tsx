// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanItemNode, isLockedProposal } from '@/components/planning/PlanItemNode';
import { KIND_TINT, WorkItemNode } from '@/components/planning/WorkItemNode';
import { PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// ONE CARD for a proposal and a committed work item (MOTIR-6296, absorbing bug
// MOTIR-6196; design Part XXIII §23.4). `PlanItemNode` is a LAYER over
// `WorkItemNode`'s shell: the two agree on footprint, radius, border weight,
// padding and shadow, share one `KIND_TINT`, draw one outcome spine, and a
// proposal draws `locked` only over a finished target.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function item(over: Partial<PlanReviewItemDto> = {}): PlanReviewItemDto {
  return {
    planItemId: 'pi_1',
    op: 'add',
    nodeId: 'pi_1',
    parentNodeId: null,
    parentIdentifier: null,
    parentTitle: null,
    parentKind: null,
    parentTrail: [],
    folderId: null,
    folderPath: null,
    folderMissing: false,
    folderTrail: [],
    blockedByNodeIds: [],
    blockedByRemovedNodeIds: [],
    committedBlockedBy: [],
    blockerStubs: [],
    identifier: null,
    title: 'A proposed item',
    kind: 'task',
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
    status: null,
    statusLabel: null,
    statusCategory: null,
    hasChildren: false,
    changes: [],
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
    ...over,
  };
}

/** A proposal over an EXISTING target, at the given status. */
function targeted(
  op: 'modify' | 'remove',
  status: string,
  statusLabel: string | null,
  statusCategory: PlanReviewItemDto['statusCategory'],
  over: Partial<PlanReviewItemDto> = {},
): PlanReviewItemDto {
  return item({
    op,
    identifier: 'MOTIR-42',
    title: 'An existing card',
    status,
    statusLabel,
    statusCategory,
    proposal: {
      op,
      identifier: 'MOTIR-42',
      changedFields: [],
      settableRailFields: [],
      todos: null,
    },
    ...over,
  });
}

function classes(el: Element): string[] {
  return (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

/** The shell's shared geometry — the footprint, radius, border weight, padding
 *  and the PRESENCE of an elevation token. */
function shellOf(el: HTMLElement) {
  const cls = classes(el);
  return {
    width: el.style.width,
    height: el.style.height,
    radius: cls.filter((c) => c.startsWith('rounded-')),
    borderWeight: cls.filter((c) => c === 'border' || /^border-\d/.test(c)),
    padding: cls.filter((c) => /^p[xytrbl]?-/.test(c)),
    shadowTokens: cls.filter((c) => c.startsWith('shadow-(--shadow-')).length,
  };
}

describe('ONE CARD — the shell both nodes render through', () => {
  it('WorkItemNode and PlanItemNode (add · modify · remove) agree on footprint, radius, border weight, padding and shadow', () => {
    const { container } = renderWithIntl(
      <WorkItemNode
        item={{
          id: 'w1',
          identifier: 'MOTIR-1',
          title: 'A committed card',
          kind: 'task',
          status: 'todo',
        }}
      />,
    );
    // The FRAME, not the wrapper the next-action button hangs from (MOTIR-10508).
    const committed = shellOf(container.querySelector('[data-node-state]') as HTMLElement);
    expect(committed).toEqual({
      width: '280px',
      height: '124px',
      radius: ['rounded-(--radius-card)'],
      borderWeight: ['border'],
      padding: ['p-(--spacing-card-padding-12)'],
      shadowTokens: 1,
    });
    cleanup();

    for (const proposal of [
      item({ op: 'add' }),
      targeted('modify', 'in_progress', 'In Progress', 'in_progress'),
      targeted('remove', 'todo', 'To Do', 'todo'),
    ]) {
      renderWithIntl(<PlanItemNode item={proposal} />);
      expect(shellOf(screen.getByTestId('plan-item-node')), proposal.op).toEqual(committed);
      cleanup();
    }
  });

  it('draws the kind tile through the ONE KIND_TINT on both cards', () => {
    const { container } = renderWithIntl(
      <>
        <WorkItemNode
          item={{
            id: 'w1',
            identifier: 'MOTIR-1',
            title: 'Committed',
            kind: 'bug',
            status: 'todo',
          }}
        />
        <PlanItemNode item={item({ kind: 'bug' })} />
      </>,
    );
    const tiles = [...container.querySelectorAll('span')].filter((s) =>
      s.classList.contains(KIND_TINT.bug),
    );
    expect(tiles).toHaveLength(2);
  });

  it('keeps Part VI’s op treatments — border style, colour and fill — on the shell', () => {
    const expected: Record<string, string[]> = {
      add: ['border-dashed', 'border-(--el-accent)', 'bg-(--el-tint-lavender)'],
      modify: ['border-(--el-border)', 'bg-(--el-surface)', 'ring-2', 'ring-(--el-info)'],
      remove: ['border-(--el-border-strong)', 'bg-(--el-muted)'],
    };
    for (const proposal of [
      item({ op: 'add' }),
      targeted('modify', 'in_progress', 'In Progress', 'in_progress'),
      targeted('remove', 'todo', 'To Do', 'todo'),
    ]) {
      renderWithIntl(<PlanItemNode item={proposal} />);
      const cls = classes(screen.getByTestId('plan-item-node'));
      for (const c of expected[proposal.op]!) expect(cls, `${proposal.op} ${c}`).toContain(c);
      cleanup();
    }
  });
});

// The guard is over the SOURCE, and it searches for the MEMBER VALUES as well as
// the symbol: a sweep over the symbol's callers is blind to a surface that
// re-implements the map under another name.
describe('ONE KIND_TINT', () => {
  const ROOT = join(__dirname, '..', '..', 'components');

  function tsxFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return tsxFiles(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it('declares exactly one `const KIND_TINT` under components/planning', () => {
    const hits = tsxFiles(join(ROOT, 'planning')).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .filter((line) => /\bconst KIND_TINT\b/.test(line))
        .map(() => relative(ROOT, f)),
    );
    expect(hits).toEqual(['planning/WorkItemNode.tsx']);
  });

  it('holds the kind → tint MEMBER VALUES in one file under components/', () => {
    // Escape EVERY regex metacharacter (backslash included), not only the
    // parentheses a tint class happens to contain today (CodeQL
    // js/incomplete-sanitization).
    const escaped = KIND_TINT.epic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const member = new RegExp(`\\bepic:\\s*'${escaped}'`);
    const hits = tsxFiles(ROOT)
      .filter((f) => member.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f));
    expect(hits).toEqual(['planning/WorkItemNode.tsx']);
  });
});

describe('ONE outcome spine', () => {
  it('a decided add through PlanReviewCanvas draws exactly one spine, and keeps the word', async () => {
    // No project key ⇒ no level read; the proposal renders alone.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no read expected'))),
    );
    const { container } = renderWithIntl(
      <PlanReviewCanvas
        items={[item({ title: 'An accepted add' })]}
        projectKey=""
        version={0}
        outcome="accepted"
      />,
    );
    await screen.findByText('An accepted add');
    expect(container.querySelectorAll('[data-testid$="outcome-spine"]')).toHaveLength(1);
    // The card still carries the outcome WORD, so the decided state is not
    // reduced to the spine's colour. (This limb was asserted on the planning
    // surface's own add frame until MOTIR-6299 deleted it; every pane with a
    // plan now draws through this canvas.)
    expect(screen.getByTestId('plan-item-outcome').textContent).toBe('accepted');
  });
});

describe('`locked` — only on a proposal over a finished target', () => {
  it('draws the hatch and aria-disabled on a modify of a done target', () => {
    renderWithIntl(<PlanItemNode item={targeted('modify', 'done', 'Done', 'done')} />);
    const node = screen.getByTestId('plan-item-node');
    expect(node.getAttribute('aria-disabled')).toBe('true');
    expect(node.getAttribute('data-locked')).toBe('true');
    const hatch = screen.getByTestId('plan-item-lock-hatch');
    expect(hatch.getAttribute('aria-hidden')).toBe('true');
    expect(classes(hatch)).toEqual(
      expect.arrayContaining(['pointer-events-none', 'absolute', 'inset-0']),
    );
    // Over the op's own frame, never instead of it.
    expect(classes(node)).toContain('ring-(--el-info)');
  });

  it('draws it on a remove of a CANCELLED target — terminal by category, not by key', () => {
    renderWithIntl(<PlanItemNode item={targeted('remove', 'cancelled', 'Cancelled', 'done')} />);
    expect(screen.getByTestId('plan-item-node').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('plan-item-lock-hatch')).toBeTruthy();
  });

  it('draws neither on an add', () => {
    renderWithIntl(<PlanItemNode item={item({ op: 'add' })} />);
    expect(screen.getByTestId('plan-item-node').hasAttribute('aria-disabled')).toBe(false);
    expect(screen.queryByTestId('plan-item-lock-hatch')).toBeNull();
  });

  it('draws neither on a modify of an unfinished target', () => {
    renderWithIntl(
      <PlanItemNode item={targeted('modify', 'in_progress', 'In Progress', 'in_progress')} />,
    );
    expect(screen.getByTestId('plan-item-node').hasAttribute('aria-disabled')).toBe(false);
    expect(screen.queryByTestId('plan-item-lock-hatch')).toBeNull();
  });

  it('a committed done card on the roadmap carries no hatch', () => {
    const { container } = renderWithIntl(
      <WorkItemNode
        item={{ id: 'w1', identifier: 'MOTIR-1', title: 'Finished', kind: 'task', status: 'done' }}
      />,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.hasAttribute('aria-disabled')).toBe(false);
    expect(container.querySelector('[data-testid$="lock-hatch"]')).toBeNull();
  });

  it('isLockedProposal is total over op × category', () => {
    for (const op of ['add', 'modify', 'remove'] as const) {
      for (const statusCategory of ['todo', 'in_progress', 'done', null] as const) {
        expect(isLockedProposal({ op, statusCategory }), `${op}/${statusCategory}`).toBe(
          op !== 'add' && statusCategory === 'done',
        );
      }
    }
  });
});

describe('the target’s status in the committed card’s vocabulary', () => {
  it('a modify over an in_progress target reads "In Progress"', () => {
    renderWithIntl(
      <PlanItemNode item={targeted('modify', 'in_progress', 'In Progress', 'in_progress')} />,
    );
    const chip = screen
      .getByTestId('plan-item-node')
      .querySelector('[data-status="in_progress"]') as HTMLElement;
    expect(chip.textContent).toBe('In Progress');
  });

  it('a modify over a CUSTOM status reads that status’s own statusLabel, not a default', () => {
    renderWithIntl(
      <PlanItemNode
        item={targeted('modify', 'awaiting_qa', 'Awaiting QA', 'in_progress', {
          title: 'Custom status target',
        })}
      />,
    );
    const chip = screen
      .getByTestId('plan-item-node')
      .querySelector('[data-status="awaiting_qa"]') as HTMLElement;
    expect(chip.textContent).toBe('Awaiting QA');
    expect(chip.textContent).not.toBe('To Do');
  });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { PageEditor, type PageEditorProps } from '../../src/editor/PageEditor';
import {
  inlineCommentsKey,
  partitionWashes,
  type PageInlineAnchorVerdicts,
  type PageInlineThreadView,
} from '../../src/editor/anchors';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { PAGE_FRAGMENT, anchorDocument, anchorFromSelection } from '../../src';
import { MESSAGES, stateFromMarkdown } from './fixtures';

// The Passage wash (MOTIR-10899): the partition on its own, then the decoration
// over a REAL editor bound to a REAL Yjs document built from a stored body
// state. Every case that resolves also asserts that drawing wrote nothing: the
// editor's document emits no update the pass did not get from the edit itself.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('partitionWashes', () => {
  const span = (id: string, from: number, to: number) => ({ id, from, to });

  it('keeps disjoint ranges apart', () => {
    expect(partitionWashes([span('b', 20, 30), span('a', 1, 5)])).toEqual([
      { from: 1, to: 5, ids: ['a'], stretches: [{ from: 1, to: 5, ids: ['a'] }] },
      { from: 20, to: 30, ids: ['b'], stretches: [{ from: 20, to: 30, ids: ['b'] }] },
    ]);
  });

  it('collapses overlapping ranges into one wash, the earlier start first', () => {
    expect(partitionWashes([span('b', 4, 12), span('a', 1, 8)])).toEqual([
      {
        from: 1,
        to: 12,
        ids: ['a', 'b'],
        stretches: [
          { from: 1, to: 4, ids: ['a'] },
          { from: 4, to: 8, ids: ['a', 'b'] },
          { from: 8, to: 12, ids: ['b'] },
        ],
      },
    ]);
  });

  it('joins touching ranges into one wash with no shared stretch', () => {
    const [wash, ...rest] = partitionWashes([span('a', 1, 5), span('b', 5, 9)]);
    expect(rest).toEqual([]);
    expect(wash).toEqual({
      from: 1,
      to: 9,
      ids: ['a', 'b'],
      stretches: [
        { from: 1, to: 5, ids: ['a'] },
        { from: 5, to: 9, ids: ['b'] },
      ],
    });
  });

  it('cuts a nested range out of the one around it', () => {
    expect(partitionWashes([span('outer', 0, 10), span('inner', 2, 5)])[0]!.stretches).toEqual([
      { from: 0, to: 2, ids: ['outer'] },
      { from: 2, to: 5, ids: ['outer', 'inner'] },
      { from: 5, to: 10, ids: ['outer'] },
    ]);
  });

  it('partitions three threads over one passage, and keeps a tie in input order', () => {
    const [wash] = partitionWashes([span('c', 3, 6), span('a', 0, 6), span('b', 0, 4)]);
    expect(wash!.ids).toEqual(['a', 'b', 'c']);
    expect(wash!.stretches).toEqual([
      { from: 0, to: 3, ids: ['a', 'b'] },
      { from: 3, to: 4, ids: ['a', 'b', 'c'] },
      { from: 4, to: 6, ids: ['a', 'c'] },
    ]);
  });

  it('gives two roots over one range one shared stretch, and drops empty ranges', () => {
    expect(partitionWashes([span('a', 0, 4), span('b', 0, 4), span('e', 7, 7)])).toEqual([
      { from: 0, to: 4, ids: ['a', 'b'], stretches: [{ from: 0, to: 4, ids: ['a', 'b'] }] },
    ]);
    expect(partitionWashes([])).toEqual([]);
  });
});

// ── The decoration over a real editor ───────────────────────────────────────

const BODY =
  'The first paragraph opens the page.\n\nThe second sentence is the one we discuss. It ends here.\n\nA closing line follows it.\n';

/** The ProseMirror range of `text` in the stored state, inside one text node. */
function rangeOf(state: Uint8Array, text: string): { from: number; to: number } {
  const { doc } = anchorDocument(state);
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found || !node.isText) return !found;
    const at = node.text!.indexOf(text);
    if (at >= 0) found = { from: pos + at, to: pos + at + text.length };
    return false;
  });
  if (!found) throw new Error(`"${text}" is not in the body`);
  return found;
}

/** A root anchored to `text` (or from `text`'s start to `until`'s end). */
function thread(
  state: Uint8Array,
  id: string,
  text: string,
  extra: Partial<PageInlineThreadView> & { until?: string } = {},
): PageInlineThreadView {
  const { until, ...rest } = extra;
  const head = rangeOf(state, text);
  const to = until ? rangeOf(state, until).to : head.to;
  const anchor = anchorFromSelection(state, head.from, to);
  if (!anchor) throw new Error(`"${text}" cannot be anchored`);
  return {
    id,
    anchor: anchor.bytes,
    quote: anchor.quote,
    authorName: 'Ann Lee',
    resolvedAt: null,
    ...rest,
  };
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
  });

function mount(overrides: Partial<PageEditorProps> = {}) {
  const initialState = overrides.initialState ?? stateFromMarkdown(BODY);
  const verdicts: PageInlineAnchorVerdicts[] = [];
  const onClick = vi.fn();
  const props: PageEditorProps = {
    initialState,
    editable: true,
    saveUpdate: async () => ({ revision: 2 }),
    uploadImage: async () => ({ url: 'https://cdn.test/x.png' }),
    messages: MESSAGES,
    theme: 'light',
    onInlineAnchorsResolved: (v) => verdicts.push(v),
    onInlineThreadClick: onClick,
    ...overrides,
  };
  const utils = render(<PageEditor {...props} />);
  const surface = screen.getByRole('textbox', { name: 'Page body' });
  const editor = (surface as HTMLElement & { editor: Editor }).editor;
  const doc = editor.extensionManager.extensions.find((e) => e.name === 'collaboration')!.options
    .document as Y.Doc;
  const updates: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => updates.push(u));
  const vector = () => Array.from(Y.encodeStateVector(doc));
  const washes = () => Array.from(surface.querySelectorAll<HTMLElement>('[data-wash-ids]'));
  /** The washed text, stretch by stretch, joined where one stretch runs into the next. */
  const washedText = () => washes().map((el) => el.textContent ?? '');
  const rerender = (next: Partial<PageEditorProps>) =>
    utils.rerender(<PageEditor {...props} {...next} />);
  return {
    ...utils,
    initialState,
    surface,
    editor,
    doc,
    updates,
    vector,
    washes,
    washedText,
    verdicts,
    onClick,
    rerender,
  };
}

/** The editor's position of `text` in its current document. */
function livePos(editor: Editor, text: string): number {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at >= 0 || !node.isText) return at < 0;
    const i = node.text!.indexOf(text);
    if (i >= 0) at = pos + i;
    return false;
  });
  if (at < 0) throw new Error(`"${text}" is not in the editor`);
  return at;
}

describe('the wash over a stored body', () => {
  it('washes exactly the passage, renders the text unchanged and writes nothing', async () => {
    const state = stateFromMarkdown(BODY);
    const root = thread(state, 'r1', 'second sentence is the one we discuss.');
    const h = mount({ initialState: state, inlineThreads: [root] });
    const before = h.vector();
    const text = h.surface.textContent;
    await flush();
    expect(h.washedText()).toEqual(['second sentence is the one we discuss.']);
    expect(h.washes()[0]!.dataset['washState']).toBe('rest');
    expect(h.washes()[0]!.className).toBe('motir-wash');
    expect(h.surface.textContent).toBe(text);
    expect(h.updates).toEqual([]);
    expect(h.vector()).toEqual(before);
    expect(h.verdicts.at(-1)).toEqual({ r1: rangeOf(state, root.quote) });
  });

  it('washes a passage across a paragraph boundary on both sides', async () => {
    const state = stateFromMarkdown(BODY);
    const root = thread(state, 'r1', 'opens the page.', { until: 'The second' });
    const h = mount({ initialState: state, inlineThreads: [root] });
    await flush();
    expect(h.washedText()).toEqual(['opens the page.', 'The second']);
    expect(h.washes().map((el) => el.dataset['washIds'])).toEqual(['r1', 'r1']);
    expect(h.updates).toEqual([]);
  });

  it('draws the same wash for a reader who may not edit', async () => {
    const state = stateFromMarkdown(BODY);
    const h = mount({
      initialState: state,
      editable: false,
      inlineThreads: [thread(state, 'r1', 'A closing line')],
    });
    await flush();
    expect(h.washedText()).toEqual(['A closing line']);
    expect(h.updates).toEqual([]);
  });

  it('creates no plugin and draws nothing without the inline-root prop', async () => {
    const h = mount();
    await flush();
    expect(inlineCommentsKey.getState(h.editor.state)).toBeUndefined();
    expect(h.washes()).toEqual([]);
    expect(h.verdicts).toEqual([]);
  });

  it('covers the passage as another member left it — a sentence before, a word changed inside', async () => {
    const state = stateFromMarkdown(BODY);
    const root = thread(state, 'r1', 'second sentence is the one we discuss.');
    // The other member's tab: insert before the passage, change a word in it.
    const other = mount({ initialState: state });
    act(() => {
      other.editor.commands.insertContentAt(livePos(other.editor, 'The second'), 'Context first. ');
    });
    act(() => {
      const at = livePos(other.editor, 'one we');
      other.editor.commands.insertContentAt({ from: at, to: at + 3 }, 'point');
    });
    const edited = Y.encodeStateAsUpdate(other.doc);
    cleanup();

    const h = mount({ initialState: edited, inlineThreads: [root] });
    await flush();
    expect(h.washedText()).toEqual(['second sentence is the point we discuss.']);
    expect(h.updates).toEqual([]);
  });
});

describe('the wash follows the reader’s own edits', () => {
  it('grows with typing inside, moves with typing before, and shrinks with a deletion inside', async () => {
    const state = stateFromMarkdown(BODY);
    const h = mount({
      initialState: state,
      inlineThreads: [thread(state, 'r1', 'one we discuss')],
    });
    await flush();
    expect(h.washedText()).toEqual(['one we discuss']);

    const edit = async (run: () => void) => {
      act(run);
      const written = h.updates.length;
      await flush();
      // The pass added nothing to what the edit wrote.
      expect(h.updates.length).toBe(written);
    };

    await edit(() => h.editor.commands.insertContentAt(livePos(h.editor, 'we discuss'), 'all '));
    expect(h.washedText()).toEqual(['one all we discuss']);

    await edit(() => h.editor.commands.insertContentAt(livePos(h.editor, 'The second'), 'Yes. '));
    expect(h.washedText()).toEqual(['one all we discuss']);
    expect(h.verdicts.at(-1)!['r1']!.from).toBe(livePos(h.editor, 'one all'));

    await edit(() => {
      const at = livePos(h.editor, 'all ');
      h.editor.commands.deleteRange({ from: at, to: at + 4 });
    });
    expect(h.washedText()).toEqual(['one we discuss']);
  });

  it('keeps typing at either edge outside the passage', async () => {
    const state = stateFromMarkdown(BODY);
    const h = mount({
      initialState: state,
      inlineThreads: [thread(state, 'r1', 'one we discuss')],
    });
    await flush();
    act(() => {
      h.editor.commands.insertContentAt(livePos(h.editor, 'one we'), '>');
    });
    await flush();
    act(() => {
      const at = livePos(h.editor, 'one we discuss') + 'one we discuss'.length;
      h.editor.commands.insertContentAt(at, '<');
    });
    await flush();
    expect(h.washedText()).toEqual(['one we discuss']);
    expect(h.surface.textContent).toContain('>one we discuss<');
  });

  it('dispatches nothing for a pass whose answer is what is drawn', async () => {
    const state = stateFromMarkdown(BODY);
    const h = mount({ initialState: state, inlineThreads: [thread(state, 'r1', 'The first')] });
    await flush();
    const seen: unknown[] = [];
    h.editor.on('transaction', ({ transaction }) =>
      seen.push(transaction.getMeta(inlineCommentsKey)),
    );
    // Typing AFTER the passage moves nothing the wash covers.
    act(() => {
      h.editor.commands.insertContentAt(h.editor.state.doc.content.size - 1, '!');
    });
    await flush();
    expect(seen).toEqual([undefined]);
    expect(h.washedText()).toEqual(['The first']);
  });

  it('draws nothing for a deleted passage, reports it gone, and draws it again on undo', async () => {
    const state = stateFromMarkdown(BODY);
    const h = mount({
      initialState: state,
      inlineThreads: [thread(state, 'r1', 'one we discuss')],
    });
    await flush();
    act(() => {
      const at = livePos(h.editor, 'one we discuss');
      h.editor.commands.deleteRange({ from: at, to: at + 'one we discuss'.length });
    });
    await flush();
    expect(h.washes()).toEqual([]);
    expect(h.verdicts.at(-1)).toEqual({ r1: null });

    act(() => {
      h.editor.commands.undo();
    });
    await flush();
    expect(h.washedText()).toEqual(['one we discuss']);
    expect(h.verdicts.at(-1)!['r1']).not.toBeNull();
  });

  it('draws nothing for a passage emptied to whitespace', async () => {
    const state = stateFromMarkdown(BODY);
    const h = mount({
      initialState: state,
      inlineThreads: [thread(state, 'r1', 'one we discuss')],
    });
    await flush();
    act(() => {
      const at = livePos(h.editor, 'one we discuss');
      h.editor.commands.insertContentAt({ from: at, to: at + 'one we discuss'.length }, '   ');
    });
    await flush();
    expect(h.washes()).toEqual([]);
    expect(h.verdicts.at(-1)).toEqual({ r1: null });
  });
});

describe('which threads draw', () => {
  it('draws nothing for a resolved root, and draws it again once reopened', async () => {
    const state = stateFromMarkdown(BODY);
    const open = thread(state, 'r1', 'A closing line');
    const resolved = { ...open, resolvedAt: '2026-11-10T10:00:00.000Z' };
    const h = mount({ initialState: state, inlineThreads: [resolved] });
    await flush();
    expect(h.washes()).toEqual([]);
    // Its verdict is still reported: it is an anchored root.
    expect(h.verdicts.at(-1)!['r1']).toEqual(rangeOf(state, 'A closing line'));
    h.rerender({ inlineThreads: [open] });
    await flush();
    expect(h.washedText()).toEqual(['A closing line']);
    expect(h.updates).toEqual([]);
  });

  it('reports an anchor it cannot read as gone and draws nothing for it', async () => {
    const state = stateFromMarkdown(BODY);
    const h = mount({
      initialState: state,
      inlineThreads: [
        { ...thread(state, 'bad', 'The first'), anchor: new Uint8Array([9, 9]) },
        thread(state, 'ok', 'A closing line'),
      ],
    });
    await flush();
    expect(h.verdicts.at(-1)).toEqual({ bad: null, ok: rangeOf(state, 'A closing line') });
    expect(h.washedText()).toEqual(['A closing line']);
  });

  it('reports every root gone on an empty body', async () => {
    const state = stateFromMarkdown(BODY);
    const root = thread(state, 'r1', 'The first');
    const h = mount({ initialState: Y.encodeStateAsUpdate(new Y.Doc()), inlineThreads: [root] });
    await flush();
    expect(h.verdicts.at(-1)).toEqual({ r1: null });
    expect(h.washes()).toEqual([]);
  });

  it('waits for the editor to hold the document it read, and gives up after a few ticks', async () => {
    const state = stateFromMarkdown(BODY);
    const h = mount({ initialState: state, inlineThreads: [thread(state, 'r1', 'The first')] });
    await flush();
    const before = h.verdicts.length;
    // A write under the binding's own lock, which it therefore does not render:
    // the document now holds a block the editor does not.
    const binding = (
      ySyncPluginKey.getState(h.editor.state) as { binding: { mux: (f: () => void) => void } }
    ).binding;
    act(() => {
      binding.mux(() => {
        h.doc.getXmlFragment(PAGE_FRAGMENT).insert(0, [new Y.XmlElement('paragraph')]);
      });
    });
    await act(async () => {
      for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
    // Nothing was re-drawn from a document the editor does not show.
    expect(h.verdicts.length).toBe(before);
    expect(h.washedText()).toEqual(['The first']);
  });

  it('draws two roots over one text as ONE wash carrying both ids, the earlier first', async () => {
    const state = stateFromMarkdown(BODY);
    const h = mount({
      initialState: state,
      inlineThreads: [
        thread(state, 'late', 'sentence is the one'),
        thread(state, 'early', 'second sentence is'),
      ],
    });
    await flush();
    expect(h.washes().map((el) => [el.textContent, el.dataset['washIds'], el.className])).toEqual([
      ['second ', 'early', 'motir-wash'],
      ['sentence is', 'early late', 'motir-wash is-overlap'],
      [' the one', 'late', 'motir-wash'],
    ]);
  });

  it('draws two roots over disjoint text as two washes', async () => {
    const state = stateFromMarkdown(BODY);
    const h = mount({
      initialState: state,
      inlineThreads: [thread(state, 'a', 'The first'), thread(state, 'b', 'A closing')],
    });
    await flush();
    expect(h.washes().map((el) => el.dataset['washIds'])).toEqual(['a', 'b']);
  });
});

describe('emphasis, click and the tooltip', () => {
  const twoThreads = (state: Uint8Array) => [
    thread(state, 'a', 'The first'),
    thread(state, 'b', 'A closing line'),
    thread(state, 'c', 'A closing', { authorName: 'Bo' }),
  ];

  it('emphasises the focused thread’s stretches, focusable, and leaves the rest at rest', async () => {
    const state = stateFromMarkdown(BODY);
    const h = mount({ initialState: state, inlineThreads: twoThreads(state) });
    await flush();
    expect(h.washes().map((el) => el.dataset['washState'])).toEqual(['rest', 'rest', 'rest']);
    h.rerender({ inlineThreads: twoThreads(state), focusedInlineThreadId: 'b' });
    await flush();
    expect(h.washes().map((el) => [el.dataset['washIds'], el.dataset['washState']])).toEqual([
      ['a', 'rest'],
      ['b c', 'emphasis'],
      ['b', 'emphasis'],
    ]);
    expect(h.washes()[1]!.getAttribute('tabindex')).toBe('-1');
    expect(h.washes()[0]!.hasAttribute('tabindex')).toBe(false);
    expect(h.updates).toEqual([]);
  });

  it('raises the click callback with the root whose range begins first, and opens nothing', async () => {
    const state = stateFromMarkdown(BODY);
    const h = mount({ initialState: state, inlineThreads: twoThreads(state) });
    await flush();
    fireEvent.click(h.washes()[1]!);
    expect(h.onClick).toHaveBeenCalledWith('b');
    fireEvent.click(h.surface.querySelector('p')!);
    expect(h.onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the Passage tooltip on hover — a name for one thread, a count for several — and Esc dismisses it', async () => {
    const state = stateFromMarkdown(BODY);
    const h = mount({ initialState: state, inlineThreads: twoThreads(state) });
    await flush();
    const text = h.surface.textContent;

    act(() => {
      fireEvent.mouseOver(h.washes()[0]!);
    });
    let tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe('Comment by Ann Lee');
    expect(tip.closest('[data-mention-anchor]')).not.toBeNull();
    expect(tip.querySelector('button, a, input')).toBeNull();
    expect(h.washes()[0]!.hasAttribute('data-wash-hover')).toBe(true);
    expect(h.surface.textContent).toBe(text);

    act(() => {
      fireEvent.mouseOver(h.washes()[1]!);
    });
    tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe('2 comments here');

    act(() => {
      fireEvent.keyDown(h.surface, { key: 'Escape' });
    });
    expect(screen.queryByRole('tooltip')).toBeNull();

    act(() => {
      fireEvent.mouseOver(h.washes()[0]!);
    });
    act(() => {
      fireEvent.mouseOver(h.surface.querySelector('p')!);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => {
      fireEvent.mouseOver(h.washes()[0]!);
    });
    act(() => {
      fireEvent.mouseLeave(h.surface);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(h.updates).toEqual([]);
  });

  it('shows the tooltip on keyboard focus and hides it when focus leaves', async () => {
    const state = stateFromMarkdown(BODY);
    const h = mount({
      initialState: state,
      inlineThreads: twoThreads(state),
      focusedInlineThreadId: 'a',
    });
    await flush();
    act(() => {
      fireEvent.focusIn(h.washes()[0]!);
    });
    expect(screen.getByRole('tooltip').textContent).toBe('Comment by Ann Lee');
    act(() => {
      fireEvent.focusOut(h.washes()[0]!);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
    // Focus or blur outside a wash changes nothing.
    act(() => {
      fireEvent.focusIn(h.surface);
      fireEvent.focusOut(h.surface);
      fireEvent.keyDown(h.surface, { key: 'Escape' });
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

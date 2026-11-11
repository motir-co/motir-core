// @vitest-environment jsdom
import { useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { PageEditor, type PageEditorProps } from '../../src/editor/PageEditor';
import {
  capturePassageAnchor,
  isPassageCommentKey,
  placeAction,
  placeComposer,
  readPassageSelection,
  selectionIsCommentable,
} from '../../src/editor/passageComment';
import type { PagePassageComposerRenderProps } from '../../src/editor/PassageCommentSurface';
import { anchorFromSelection, decodeAnchor, encodeAnchor } from '../../src';
import { MESSAGES, stateFromMarkdown } from './fixtures';

// Comment on a passage (MOTIR-10900): the headless half on its own, then the
// Selection action and the Inline composer over a REAL editor bound to a REAL
// Yjs document. The window's selection is set on the editor's own text nodes,
// the way a reader's drag leaves it.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.getSelection()?.removeAllRanges();
});

const rect = (left: number, top: number, right: number, bottom: number): DOMRect =>
  ({
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    toJSON() {},
  }) as DOMRect;

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

describe('isPassageCommentKey', () => {
  it('matches Mod-Shift-m with ⌘ or Ctrl, and nothing else', () => {
    expect(isPassageCommentKey(key({ code: 'KeyM', shiftKey: true, metaKey: true }))).toBe(true);
    expect(isPassageCommentKey(key({ code: 'KeyM', shiftKey: true, ctrlKey: true }))).toBe(true);
    expect(isPassageCommentKey(key({ code: 'KeyM', metaKey: true }))).toBe(false);
    expect(isPassageCommentKey(key({ code: 'KeyM', shiftKey: true }))).toBe(false);
    expect(
      isPassageCommentKey(key({ code: 'KeyM', shiftKey: true, metaKey: true, altKey: true })),
    ).toBe(false);
    expect(isPassageCommentKey(key({ code: 'KeyN', shiftKey: true, metaKey: true }))).toBe(false);
  });
});

describe('placement', () => {
  const box = rect(100, 50, 820, 1000);
  const wide = { width: 1440, height: 900 };
  const narrow = { width: 800, height: 900 };

  it('puts the action 4px under the end of the last line on a wide screen', () => {
    const lines = [rect(140, 100, 700, 120), rect(100, 124, 400, 144)];
    expect(placeAction(box, lines, wide)).toEqual({ left: 300, top: 98, side: 'below' });
  });

  it('puts the action 4px above the last line below 1280px', () => {
    const lines = [rect(140, 100, 700, 120), rect(100, 124, 400, 144)];
    expect(placeAction(box, lines, narrow)).toEqual({ left: 300, top: 70, side: 'above' });
  });

  it('falls back to the wrapper box when the range reports no lines', () => {
    expect(placeAction(box, [], wide)).toEqual({ left: 720, top: 954, side: 'below' });
  });

  it('opens the composer 8px under the passage, at its start, 380px wide', () => {
    const lines = [rect(140, 100, 700, 120), rect(100, 124, 400, 144)];
    expect(placeComposer(box, lines, wide)).toEqual({
      left: 40,
      top: 102,
      side: 'below',
      width: 380,
    });
  });

  it('keeps the composer inside the body, and flips it above a passage in the bottom third', () => {
    const lines = [rect(700, 700, 800, 720)];
    expect(placeComposer(box, lines, wide)).toEqual({
      left: 340,
      top: 642,
      side: 'above',
      width: 380,
    });
  });

  it('holds the composer to the body’s width below 1280px, and to a body narrower than 380px', () => {
    const lines = [rect(140, 100, 700, 120)];
    expect(placeComposer(box, lines, narrow)).toMatchObject({ left: 0, width: 720 });
    expect(placeComposer(rect(0, 0, 300, 500), lines, wide)).toMatchObject({ left: 0, width: 300 });
  });
});

// ── Over a real editor ──────────────────────────────────────────────────────

const BODY =
  'The first paragraph opens the page.\n\nThe second sentence is the one we discuss. It ends here.\n\nA closing line follows it.\n';

const frames = () =>
  act(async () => {
    for (let i = 0; i < 3; i += 1) await new Promise((r) => requestAnimationFrame(() => r(null)));
  });

/** The editor's text node holding `text`. */
function textNode(surface: HTMLElement, text: string): Text {
  const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node.textContent ?? '').includes(text)) return node as Text;
  }
  throw new Error(`"${text}" is not rendered`);
}

/** Select `text` (or from `text`'s start to `until`'s end) as a reader's drag would. */
function select(surface: HTMLElement, text: string, until?: string, backwards = false) {
  const head = textNode(surface, text);
  const tailText = until ?? text;
  const tail = textNode(surface, tailText);
  const from = head.textContent!.indexOf(text);
  const to = tail.textContent!.indexOf(tailText) + tailText.length;
  const selection = document.getSelection()!;
  if (backwards) selection.setBaseAndExtent(tail, to, head, from);
  else selection.setBaseAndExtent(head, from, tail, to);
  document.dispatchEvent(new Event('selectionchange'));
}

function mount(overrides: Partial<PageEditorProps> = {}) {
  const composed: PagePassageComposerRenderProps[] = [];
  const props: PageEditorProps = {
    initialState: stateFromMarkdown(BODY),
    editable: true,
    saveUpdate: async () => ({ revision: 2 }),
    uploadImage: async () => ({ url: 'https://cdn.test/x.png' }),
    messages: MESSAGES,
    theme: 'light',
    passageComment: {
      renderComposer: (composer) => {
        composed.push(composer);
        return (
          <div>
            <textarea aria-label="Your comment" />
            <button type="button" onClick={composer.close}>
              Cancel
            </button>
          </div>
        );
      },
    },
    ...overrides,
  };
  const utils = render(<PageEditor {...props} />);
  const surface = screen.getByRole('textbox', { name: 'Page body' });
  const editor = (surface as HTMLElement & { editor: Editor }).editor;
  const doc = editor.extensionManager.extensions.find((e) => e.name === 'collaboration')!.options
    .document as Y.Doc;
  const updates: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => updates.push(u));
  const action = () => screen.queryByRole('button', { name: 'Comment on the selected text' });
  const composer = () => screen.queryByRole('group', { name: 'Comment on this passage' });
  return { ...utils, props, surface, editor, doc, updates, composed, action, composer };
}

describe('the headless half over a real editor', () => {
  it('reads the window’s selection in order, and nothing outside the editor', async () => {
    const h = mount();
    await frames();
    const view = h.editor.view;
    expect(readPassageSelection(view)).toBeNull();
    select(h.surface, 'second sentence', 'discuss.', true);
    const range = readPassageSelection(view)!;
    expect(h.editor.state.doc.textBetween(range.from, range.to)).toBe(
      'second sentence is the one we discuss.',
    );
    // Collapsed.
    const node = textNode(h.surface, 'second sentence');
    document.getSelection()!.collapse(node, 3);
    expect(readPassageSelection(view)).toBeNull();
    // An end outside the editor.
    const outside = document.createElement('p');
    outside.textContent = 'elsewhere';
    document.body.append(outside);
    document.getSelection()!.setBaseAndExtent(node, 0, outside.firstChild!, 4);
    expect(readPassageSelection(view)).toBeNull();
    outside.remove();
  });

  it('answers nothing for a point ProseMirror cannot map, or with no selection object', () => {
    const dom = document.createElement('div');
    dom.textContent = 'text';
    document.body.append(dom);
    document.getSelection()!.setBaseAndExtent(dom.firstChild!, 0, dom.firstChild!, 3);
    const view = {
      dom,
      posAtDOM: () => {
        throw new Error('no position');
      },
    } as unknown as EditorView;
    expect(readPassageSelection(view)).toBeNull();
    const same = { dom, posAtDOM: () => 4 } as unknown as EditorView;
    expect(readPassageSelection(same)).toBeNull();
    const none = {
      dom: { ownerDocument: { getSelection: () => null } },
    } as unknown as EditorView;
    expect(readPassageSelection(none)).toBeNull();
    dom.remove();
  });

  it('tells text from whitespace, and rejects a range off the document', async () => {
    const h = mount();
    await frames();
    const doc = h.editor.state.doc;
    select(h.surface, 'second sentence');
    const range = readPassageSelection(h.editor.view)!;
    expect(selectionIsCommentable(doc, range)).toBe(true);
    // The two positions either side of a paragraph boundary hold no text.
    const end = range.from - 'The '.length - 1;
    expect(selectionIsCommentable(doc, { from: end - 1, to: end + 1 })).toBe(false);
    expect(selectionIsCommentable(doc, { from: -1, to: 4 })).toBe(false);
    expect(selectionIsCommentable(doc, { from: 4, to: doc.content.size + 1 })).toBe(false);
    expect(selectionIsCommentable(doc, { from: 4, to: 4 })).toBe(false);
  });

  it('reads a chip’s label and a break as text, an unlabelled leaf as its id', async () => {
    const h = mount();
    await frames();
    h.editor
      .chain()
      .setContent({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'workItemMention', attrs: { id: 'w1', label: 'MOTIR-1' } },
              { type: 'hardBreak' },
              { type: 'workItemMention', attrs: { id: 'w2', label: '' } },
            ],
          },
        ],
      })
      .run();
    const doc = h.editor.state.doc;
    expect(selectionIsCommentable(doc, { from: 1, to: 2 })).toBe(true);
    expect(selectionIsCommentable(doc, { from: 2, to: 3 })).toBe(false);
    expect(selectionIsCommentable(doc, { from: 3, to: 4 })).toBe(true);
  });

  it('captures the codec’s own anchor, as padded base64, and nothing for whitespace', async () => {
    const h = mount();
    await frames();
    select(h.surface, 'second sentence', 'discuss.');
    const range = readPassageSelection(h.editor.view)!;
    const captured = capturePassageAnchor(h.doc, range)!;
    const expected = anchorFromSelection(h.doc, range.from, range.to)!;
    expect(captured.quote).toBe('second sentence is the one we discuss.');
    const bytes = Uint8Array.from(atob(captured.bytes), (c) => c.charCodeAt(0));
    expect(encodeAnchor(decodeAnchor(bytes)!)).toEqual(expected.bytes);
    expect(captured.bytes).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(capturePassageAnchor(h.doc, { from: range.from, to: range.from })).toBeNull();
    expect(h.updates).toEqual([]);
  });
});

describe('the Selection action', () => {
  it('appears at the end of a commentable selection, in the body wrapper', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1440);
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([
      rect(40, 30, 380, 50),
    ] as unknown as DOMRectList);
    const h = mount();
    await frames();
    expect(h.action()).toBeNull();
    select(h.surface, 'second sentence', 'discuss.');
    await frames();
    const button = h.action()!;
    expect(button.textContent).toBe('Comment');
    expect(button.dataset['side']).toBe('below');
    expect(button.style.left).toBe('380px');
    expect(button.style.top).toBe('54px');
    expect(button.closest('[data-mention-anchor]')).not.toBeNull();
    // The press must not take focus, or the selection would collapse.
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  it('is drawn in the read-only body too, and above the selection below 1280px', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(800);
    const h = mount({ editable: false });
    await frames();
    select(h.surface, 'closing line');
    await frames();
    expect(h.action()!.dataset['side']).toBe('above');
  });

  it('is absent — never disabled — for a whitespace, collapsed or outside selection', async () => {
    const h = mount();
    await frames();
    select(h.surface, 'second sentence');
    await frames();
    expect(h.action()).not.toBeNull();
    const node = textNode(h.surface, 'second sentence');
    document.getSelection()!.collapse(node, 2);
    document.dispatchEvent(new Event('selectionchange'));
    await frames();
    expect(h.action()).toBeNull();
    // A space alone.
    const at = node.textContent!.indexOf(' sentence');
    document.getSelection()!.setBaseAndExtent(node, at, node, at + 1);
    document.dispatchEvent(new Event('selectionchange'));
    await frames();
    expect(h.action()).toBeNull();
  });

  it('is never offered without the capability', async () => {
    const h = mount({ passageComment: undefined });
    await frames();
    select(h.surface, 'second sentence');
    await frames();
    expect(h.action()).toBeNull();
    fireEvent.keyDown(document, { code: 'KeyM', shiftKey: true, metaKey: true });
    expect(h.composer()).toBeNull();
  });

  it('hides while the pointer is down and comes back when it is released', async () => {
    const h = mount();
    await frames();
    select(h.surface, 'second sentence');
    await frames();
    expect(h.action()).not.toBeNull();
    fireEvent.pointerDown(h.surface);
    select(h.surface, 'first paragraph');
    await frames();
    expect(h.action()).toBeNull();
    fireEvent.pointerUp(document);
    await frames();
    expect(h.action()).not.toBeNull();
    // A resize measures again.
    fireEvent(window, new Event('resize'));
    await frames();
    expect(h.action()).not.toBeNull();
  });
});

describe('the Inline composer', () => {
  it('opens from the action with the passage’s quote, its editor focused, and writes nothing', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1440);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(900);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 720, 900));
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([
      rect(40, 30, 380, 50),
    ] as unknown as DOMRectList);
    const h = mount();
    await frames();
    select(h.surface, 'second sentence', 'discuss.');
    await frames();
    fireEvent.click(h.action()!);
    await frames();
    const group = h.composer()!;
    expect(group.dataset['side']).toBe('below');
    expect(group.style.width).toBe('380px');
    expect(group.style.top).toBe('58px');
    expect(screen.getByTestId('passage-composer-quote').textContent).toBe(
      'second sentence is the one we discuss.',
    );
    expect(
      screen.getByRole('blockquote', {
        name: 'Quoted passage: second sentence is the one we discuss.',
      }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Your comment' }));
    // The action is gone while the composer is open.
    expect(h.action()).toBeNull();
    expect(h.composed.at(-1)!.anchor.quote).toBe('second sentence is the one we discuss.');
    expect(h.updates).toEqual([]);
  });

  it('keeps its passage when the selection collapses, and closes on Esc without posting', async () => {
    const h = mount();
    await frames();
    select(h.surface, 'closing line');
    await frames();
    fireEvent.click(h.action()!);
    await frames();
    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    await frames();
    expect(screen.getByTestId('passage-composer-quote').textContent).toBe('closing line');
    // Another key does nothing.
    fireEvent.keyDown(h.composer()!, { key: 'a' });
    expect(h.composer()).not.toBeNull();
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const textarea = screen.getByRole('textbox', { name: 'Your comment' });
    act(() => {
      textarea.dispatchEvent(esc);
    });
    expect(esc.defaultPrevented).toBe(true);
    expect(h.composer()).toBeNull();
    // Back in the body the writer was typing in.
    expect(document.activeElement).toBe(h.surface);
  });

  it('leaves an Esc another control already took, and closes on Close and on the host’s close', async () => {
    const h = mount({ editable: false });
    await frames();
    select(h.surface, 'closing line');
    await frames();
    fireEvent.click(h.action()!);
    await frames();
    const textarea = screen.getByRole('textbox', { name: 'Your comment' });
    textarea.addEventListener('keydown', (event) => event.preventDefault(), { once: true });
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(h.composer()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(h.composer()).toBeNull();
    // A reader's body takes no focus back.
    expect(document.activeElement).not.toBe(h.surface);
    select(h.surface, 'first paragraph');
    await frames();
    fireEvent.click(h.action()!);
    await frames();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.composer()).toBeNull();
  });

  it('opens from Mod-Shift-m on the current selection, and leaves the key alone otherwise', async () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(30);
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([
      rect(40, 30, 380, 50),
    ] as unknown as DOMRectList);
    const h = mount();
    await frames();
    const idle = new KeyboardEvent('keydown', {
      code: 'KeyM',
      shiftKey: true,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);
    expect(h.composer()).toBeNull();
    select(h.surface, 'second sentence');
    const taken = new KeyboardEvent('keydown', {
      code: 'KeyM',
      shiftKey: true,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    taken.preventDefault();
    document.dispatchEvent(taken);
    expect(h.composer()).toBeNull();
    const chord = new KeyboardEvent('keydown', {
      code: 'KeyM',
      shiftKey: true,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(chord);
    });
    expect(chord.defaultPrevented).toBe(true);
    // The passage ends in the viewport's bottom third: the composer opens above it.
    expect(h.composer()!.dataset['side']).toBe('above');
  });

  it('opens nothing when the selection cannot be anchored', async () => {
    const h = mount();
    await frames();
    select(h.surface, 'second sentence');
    await frames();
    const action = h.action()!;
    document.getSelection()!.removeAllRanges();
    fireEvent.click(action);
    expect(h.composer()).toBeNull();
  });

  it('moves focus into an editor that mounts late, however late', async () => {
    function LateEditor() {
      const [ready, setReady] = useState(false);
      useEffect(() => {
        const timer = setTimeout(() => setReady(true), 50);
        return () => clearTimeout(timer);
      }, []);
      return ready ? (
        <div contentEditable suppressContentEditableWarning aria-label="Late" />
      ) : null;
    }
    const h = mount({ passageComment: { renderComposer: () => <LateEditor /> } });
    await frames();
    select(h.surface, 'closing line');
    await frames();
    fireEvent.click(h.action()!);
    await frames();
    // Until the editor exists the frame holds focus, so the body has let go.
    expect(document.activeElement).toBe(h.composer());
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Late'));
  });

  it('leaves focus alone when the reader moved it before the editor mounted', async () => {
    function LateEditor() {
      const [ready, setReady] = useState(false);
      useEffect(() => {
        const timer = setTimeout(() => setReady(true), 50);
        return () => clearTimeout(timer);
      }, []);
      return ready ? (
        <div contentEditable suppressContentEditableWarning aria-label="Late" />
      ) : null;
    }
    const h = mount({ passageComment: { renderComposer: () => <LateEditor /> } });
    await frames();
    select(h.surface, 'closing line');
    await frames();
    fireEvent.click(h.action()!);
    await frames();
    const close = h.composer()!.querySelector<HTMLElement>('button')!;
    close.focus();
    await waitFor(() => expect(h.composer()!.querySelector('[aria-label="Late"]')).not.toBeNull());
    expect(document.activeElement).toBe(close);
  });

  it('lands focus on the frame when the host draws nothing editable', async () => {
    let tick = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      tick += 1;
      queueMicrotask(() => cb(tick));
      return tick;
    });
    const h = mount({ passageComment: { renderComposer: () => <p>Read only</p> } });
    await frames();
    select(h.surface, 'closing line');
    await frames();
    fireEvent.click(h.action()!);
    await frames();
    expect(document.activeElement).toBe(h.composer());
  });
});

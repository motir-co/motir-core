import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import {
  PAGE_ANCHOR_FORMAT_VERSION,
  PAGE_ANCHOR_QUOTE_MAX,
  PAGE_FRAGMENT,
  anchorDocument,
  anchorFromSelection,
  decodeAnchor,
  encodeAnchor,
  pageSchema,
  resolveAnchor,
  resolveAnchors,
  resolveStoredAnchor,
  sameAsQuote,
  type PageAnchorDocument,
  type PageAnchorRange,
} from '../../src';

// THE ANCHOR CODEC (Story MOTIR-10867 · MOTIR-10897), headless: every page body
// here is a real Yjs document or a stored state, and nothing renders an editor.

const text = (t: string): JSONContent => ({ type: 'text', text: t });
const para = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });
const body = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });

const PASSAGE = 'Brave new world.';
const SECOND = `Before the passage. ${PASSAGE} After it.`;

/** A live page document holding `json`, as the editor's binding would. */
function ydocOf(json: JSONContent): Y.Doc {
  const ydoc = new Y.Doc();
  prosemirrorJSONToYXmlFragment(pageSchema, json, ydoc.getXmlFragment(PAGE_FRAGMENT));
  return ydoc;
}

const stateOf = (ydoc: Y.Doc) => Y.encodeStateAsUpdate(ydoc);

/** A second member's copy of a document, and how their edits merge back. */
function copyOf(ydoc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, stateOf(ydoc));
  return copy;
}

/** The ProseMirror range of the first occurrence of `needle`, as a text selection holds it. */
function rangeOf(d: PageAnchorDocument, needle: string): PageAnchorRange {
  const size = d.doc.content.size;
  const inText = (pos: number) => d.doc.resolve(pos).parent.isTextblock;
  for (let from = 0; from + 1 <= size; from += 1) {
    if (!inText(from)) continue;
    for (let to = from + 1; to <= size; to += 1) {
      if (inText(to) && d.doc.textBetween(from, to, ' ') === needle) return { from, to };
    }
  }
  throw new Error(`"${needle}" is not in the page`);
}

/** The text a resolved range covers. */
const covered = (source: Y.Doc | Uint8Array, range: PageAnchorRange | null) =>
  range === null ? null : anchorDocument(source).doc.textBetween(range.from, range.to, ' ');

/** The XmlText of a block in the fragment (paragraphs hold one when unformatted). */
const textOf = (ydoc: Y.Doc, block: number): Y.XmlText =>
  (ydoc.getXmlFragment(PAGE_FRAGMENT).get(block) as Y.XmlElement).get(0) as Y.XmlText;

/** A two-paragraph page and an anchor on the passage in the second. */
function anchored() {
  const ydoc = ydocOf(body(para(text('An opening line.')), para(text(SECOND))));
  const d = anchorDocument(ydoc);
  const { from, to } = rangeOf(d, PASSAGE);
  const selection = anchorFromSelection(d, from, to)!;
  expect(selection).not.toBeNull();
  return { ydoc, from, to, selection };
}

describe('anchorFromSelection', () => {
  it('answers the pair, non-empty bytes and the selection’s text as its quote', () => {
    const { ydoc, from, to, selection } = anchored();
    expect(selection.quote).toBe(PASSAGE);
    expect(selection.bytes.length).toBeGreaterThan(0);
    expect(selection.bytes[0]).toBe(PAGE_ANCHOR_FORMAT_VERSION);
    expect(resolveAnchor(selection.pair, ydoc)).toEqual({ from, to });
  });

  it('joins two blocks with one space, and a mention or embed quotes its label, then its id', () => {
    const ydoc = ydocOf(
      body(
        para(text('First block ends')),
        para(
          text('see '),
          { type: 'workItemMention', attrs: { id: 'cm1', label: 'MOTIR-7' } },
          text(' and '),
          { type: 'workItemMention', attrs: { id: 'cm2', label: null } },
        ),
        { type: 'workItemEmbed', attrs: { id: 'cm3', label: 'MOTIR-9' } },
        para(text('last')),
      ),
    );
    const d = anchorDocument(ydoc);
    const selection = anchorFromSelection(d, 1, d.doc.content.size - 1)!;
    expect(selection.quote).toBe('First block ends see MOTIR-7 and cm2 MOTIR-9 last');
  });

  it('answers nothing, and never throws, for a degenerate or unconvertible range', () => {
    const ydoc = ydocOf(body(para(text('Some text   with spaces'))));
    const d = anchorDocument(ydoc);
    const spaces = rangeOf(d, '   ');
    for (const [from, to] of [
      [3, 3], // empty
      [5, 3], // reversed
      [spaces.from, spaces.to], // whitespace only
      [0, 5], // the start sits on the fragment's own child list, not in a block
      [-1, 3],
      [1, d.doc.content.size + 1],
      [1.5, 3],
    ] as const) {
      expect(anchorFromSelection(d, from, to)).toBeNull();
    }
    expect(anchorFromSelection(new Uint8Array(stateOf(ydocOf(body()))), 0, 0)).toBeNull();
  });

  it('caps the quote at PAGE_ANCHOR_QUOTE_MAX code points with the ellipsis inside, never splitting a pair', () => {
    const long = '😀'.repeat(PAGE_ANCHOR_QUOTE_MAX + 50);
    const ydoc = ydocOf(body(para(text(`  ${long}  `))));
    const d = anchorDocument(ydoc);
    const selection = anchorFromSelection(d, 1, d.doc.content.size - 1)!;
    const points = Array.from(selection.quote);
    expect(points).toHaveLength(PAGE_ANCHOR_QUOTE_MAX);
    expect(points.at(-1)).toBe('…');
    expect(points.slice(0, -1).every((p) => p === '😀')).toBe(true);
    // Trimmed at both ends, and an uncut quote has no ellipsis.
    const short = anchorDocument(ydocOf(body(para(text('  padded  ')))));
    expect(anchorFromSelection(short, 1, short.doc.content.size - 1)!.quote).toBe('padded');
  });
});

describe('encodeAnchor / decodeAnchor', () => {
  it('round-trip: the decoded pair resolves to the same range and re-encodes byte-identical', () => {
    const { ydoc, from, to, selection } = anchored();
    const decoded = decodeAnchor(selection.bytes)!;
    expect(resolveAnchor(decoded, ydoc)).toEqual({ from, to });
    expect([...encodeAnchor(decoded)]).toEqual([...selection.bytes]);
    expect(resolveStoredAnchor(selection.bytes, ydoc)).toEqual({ from, to });
  });

  it('answers nothing for bytes it cannot read, so a stored row degrades to page-level', () => {
    const { ydoc, selection } = anchored();
    const unknownVersion = Uint8Array.from(selection.bytes);
    unknownVersion[0] = 9;
    const zeroPart = Uint8Array.from([PAGE_ANCHOR_FORMAT_VERSION, 0, 0, 0, 0]);
    const undecodable = new Uint8Array([PAGE_ANCHOR_FORMAT_VERSION]);
    const garbage = Uint8Array.from([0, 0, 0, 1, 255]);
    const fourGarbage = new Uint8Array([
      ...undecodable,
      ...[1, 2, 3, 4].flatMap(() => [...garbage]),
    ]);
    for (const bytes of [
      new Uint8Array(),
      selection.bytes.subarray(0, selection.bytes.length - 2), // truncated
      selection.bytes.subarray(0, 3), // a length cut short
      new Uint8Array([...selection.bytes, 7]), // trailing bytes
      unknownVersion,
      zeroPart,
      fourGarbage, // four parts Yjs cannot decode
    ]) {
      expect(decodeAnchor(bytes)).toBeNull();
      expect(resolveStoredAnchor(bytes, ydoc)).toBeNull();
    }
  });
});

describe('resolveAnchor, after the page is edited', () => {
  it('follows a second member’s merged edits: a sentence before it and a word changed inside', () => {
    const { ydoc, selection } = anchored();
    const b = copyOf(ydoc);
    const t = textOf(b, 1);
    t.insert(0, 'A new first sentence. ');
    const word = t.toString().indexOf('new world');
    t.delete(word, 3);
    t.insert(word, 'old');
    const merged = new Uint8Array(stateOf(ydoc));
    const state = (() => {
      const a = new Y.Doc();
      Y.applyUpdate(a, merged);
      Y.applyUpdate(a, stateOf(b));
      return stateOf(a);
    })();
    const range = resolveStoredAnchor(selection.bytes, state)!;
    expect(covered(state, range)).toBe('Brave old world.');
  });

  it('moves with the reader’s own live edits, without a re-read of anything stored', () => {
    const { ydoc, selection } = anchored();
    textOf(ydoc, 1).insert(0, 'Typed now. ');
    expect(covered(ydoc, resolveAnchor(selection.pair, ydoc))).toBe(PASSAGE);
  });

  it('is unchanged by an insert after it, and an insert exactly at either edge lands outside', () => {
    const { ydoc, selection } = anchored();
    const t = textOf(ydoc, 1);
    const start = t.toString().indexOf(PASSAGE);
    t.insert(start + PASSAGE.length + 1, 'later ');
    expect(covered(ydoc, resolveAnchor(selection.pair, ydoc))).toBe(PASSAGE);
    t.insert(start + PASSAGE.length, 'END');
    t.insert(start, 'EDGE');
    expect(covered(ydoc, resolveAnchor(selection.pair, ydoc))).toBe(PASSAGE);
  });

  it('answers nothing for a deleted passage and for one emptied to whitespace — never a neighbour', () => {
    const deleted = anchored();
    const t = textOf(deleted.ydoc, 1);
    t.delete(t.toString().indexOf(PASSAGE), PASSAGE.length);
    expect(resolveAnchor(deleted.selection.pair, deleted.ydoc)).toBeNull();

    const emptied = anchored();
    const e = textOf(emptied.ydoc, 1);
    const at = e.toString().indexOf(PASSAGE);
    e.delete(at, PASSAGE.length);
    e.insert(at, '     ');
    expect(resolveAnchor(emptied.selection.pair, emptied.ydoc)).toBeNull();

    const block = anchored();
    block.ydoc.getXmlFragment(PAGE_FRAGMENT).delete(1, 1);
    expect(resolveAnchor(block.selection.pair, block.ydoc)).toBeNull();
  });

  it('resolves again once a deletion is undone and merged back into the stored state', () => {
    const { ydoc, selection } = anchored();
    const b = copyOf(ydoc);
    const undo = new Y.UndoManager(b.getXmlFragment(PAGE_FRAGMENT), { captureTimeout: 0 });
    const t = textOf(b, 1);
    t.delete(t.toString().indexOf(PASSAGE), PASSAGE.length);
    const afterDelete = new Y.Doc();
    Y.applyUpdate(afterDelete, stateOf(ydoc));
    Y.applyUpdate(afterDelete, stateOf(b));
    expect(resolveStoredAnchor(selection.bytes, stateOf(afterDelete), selection.quote)).toBeNull();

    undo.undo();
    // Live, in the document that undid it…
    expect(covered(b, resolveAnchor(selection.pair, b, selection.quote))).toBe(PASSAGE);
    // …and in a state merged from it, which no longer knows which items replaced which.
    Y.applyUpdate(afterDelete, stateOf(b));
    const restored = stateOf(afterDelete);
    expect(covered(restored, resolveStoredAnchor(selection.bytes, restored, selection.quote))).toBe(
      PASSAGE,
    );
  });

  it('never re-attaches a deleted passage to new text typed in its place', () => {
    const { ydoc, selection } = anchored();
    const t = textOf(ydoc, 1);
    const at = t.toString().indexOf(PASSAGE);
    t.delete(at, PASSAGE.length);
    t.insert(at, 'Totally different text.');
    expect(resolveAnchor(selection.pair, ydoc, selection.quote)).toBeNull();
    expect(resolveStoredAnchor(selection.bytes, stateOf(ydoc), selection.quote)).toBeNull();
  });

  it('never re-attaches a passage deleted at a paragraph’s end to a sentence appended there', () => {
    const ydoc = ydocOf(body(para(text(`Opening words. ${PASSAGE}`)), para(text('Next.'))));
    const d = anchorDocument(ydoc);
    const { from, to } = rangeOf(d, PASSAGE);
    const selection = anchorFromSelection(d, from, to)!;
    const t = textOf(ydoc, 0);
    t.delete(t.toString().indexOf(PASSAGE), PASSAGE.length);
    expect(resolveAnchor(selection.pair, ydoc, selection.quote)).toBeNull();
    t.insert(t.length, 'A brand new sentence.');
    expect(resolveAnchor(selection.pair, ydoc, selection.quote)).toBeNull();
  });

  it('brings back a restored passage that was edited after it was quoted', () => {
    const { ydoc, selection } = anchored();
    const t = textOf(ydoc, 1);
    const at = t.toString().indexOf(PASSAGE);
    t.delete(at, PASSAGE.length);
    // A version restore inserts the version's text as new items: here, the
    // passage as it read after an edit inside it.
    t.insert(at, 'Brave and new world.');
    expect(covered(ydoc, resolveAnchor(selection.pair, ydoc, selection.quote))).toBe(
      'Brave and new world.',
    );
    // Without the quote there is nothing to check the text against: gone.
    expect(resolveAnchor(selection.pair, ydoc)).toBeNull();
  });
});

describe('sameAsQuote', () => {
  it('holds for the quote itself, folded case and spacing, and a passage that kept half its words', () => {
    expect(sameAsQuote('Brave new world.', 'Brave new world.')).toBe(true);
    expect(sameAsQuote('  brave   NEW world ', 'Brave new world.')).toBe(true);
    expect(
      sameAsQuote('The rollout starts early from Monday', 'The rollout starts on Monday'),
    ).toBe(true);
  });

  it('fails for unrelated text, for text with no words, and for a lone shared word', () => {
    expect(sameAsQuote('Totally different text.', 'Brave new world.')).toBe(false);
    expect(sameAsQuote('— … —', 'Brave new world.')).toBe(false);
    expect(sameAsQuote('Brave', '…')).toBe(false);
    expect(sameAsQuote('A whole new paragraph about something else', 'Brave new world.')).toBe(
      false,
    );
  });

  it('splits scripts written without spaces into words', () => {
    expect(sameAsQuote('今日は良い天気です', '今日は良い天気です')).toBe(true);
    expect(sameAsQuote('明日は会議があります', '今日は良い天気です')).toBe(false);
  });

  it('compares a quote cut at the maximum with the same length of text', () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const quote = `${Array.from(long)
      .slice(0, PAGE_ANCHOR_QUOTE_MAX - 1)
      .join('')}…`;
    expect(Array.from(quote)).toHaveLength(PAGE_ANCHOR_QUOTE_MAX);
    // The tail past the cut is not counted against the passage.
    expect(sameAsQuote(`${long} and a long tail of new words`, quote)).toBe(true);
    expect(sameAsQuote(long.replace(/word/g, 'term'), quote)).toBe(false);
  });

  it('reads a cut that landed on a space, and so came out shorter than the maximum, as a cut', () => {
    const long = `${'a'.repeat(PAGE_ANCHOR_QUOTE_MAX - 2)} ${'tail words '.repeat(200)}`;
    const quote = `${Array.from(long)
      .slice(0, PAGE_ANCHOR_QUOTE_MAX - 1)
      .join('')
      .trimEnd()}…`;
    expect(Array.from(quote).length).toBeLessThan(PAGE_ANCHOR_QUOTE_MAX);
    expect(sameAsQuote(long, quote)).toBe(true);
  });
});

describe('resolution is headless, read-only and per page', () => {
  it('a stored bodyState answers exactly what the live document answers', () => {
    const { ydoc, from, to, selection } = anchored();
    textOf(ydoc, 0).insert(0, 'Edited. ');
    const live = resolveAnchor(selection.pair, ydoc);
    const stored = resolveAnchor(selection.pair, anchorDocument(stateOf(ydoc)));
    expect(stored).toEqual(live);
    expect(live).toEqual({ from: from + 'Edited. '.length, to: to + 'Edited. '.length });
  });

  it('emits no update and leaves the state vector unchanged', () => {
    const ydoc = ydocOf(body(para(text('An opening line.')), para(text(SECOND))));
    const before = Y.encodeStateVector(ydoc);
    let updates = 0;
    ydoc.on('update', () => {
      updates += 1;
    });
    const d = anchorDocument(ydoc);
    const { from, to } = rangeOf(d, PASSAGE);
    const selection = anchorFromSelection(ydoc, from, to)!;
    encodeAnchor(selection.pair);
    resolveAnchor(selection.pair, ydoc);
    resolveAnchors([selection.pair, selection.pair], ydoc);
    resolveStoredAnchor(selection.bytes, ydoc);
    expect(updates).toBe(0);
    expect([...Y.encodeStateVector(ydoc)]).toEqual([...before]);
  });

  it('answers nothing against another page’s body', () => {
    const { selection } = anchored();
    const other = ydocOf(body(para(text('An opening line.')), para(text(SECOND))));
    expect(resolveAnchor(selection.pair, other)).toBeNull();
  });

  it('skips a block the schema dropped, and answers nothing for a position the mapping cannot place', () => {
    const ydoc = ydocOf(body(para(text('One.')), para(text('Two.')), para(text('Three here.'))));
    const d = anchorDocument(ydoc);
    const { from, to } = rangeOf(d, 'Three');
    const selection = anchorFromSelection(d, from, to)!;
    // A block the page schema cannot hold: y-prosemirror drops it from the
    // derived document, so the passage's position there is unchanged.
    const unknown = new Y.XmlElement('notInTheSchema');
    unknown.insert(0, [new Y.XmlText('ghost')]);
    ydoc.getXmlFragment(PAGE_FRAGMENT).insert(1, [unknown]);
    expect(covered(ydoc, resolveAnchor(selection.pair, ydoc))).toBe('Three');
    // A position on a block's own child list, behind a child the mapping does
    // not know, cannot be converted at all.
    const block = new Y.XmlElement('paragraph');
    const stray = new Y.XmlElement('notInTheSchema');
    block.insert(0, [stray, new Y.XmlText('tail text')]);
    ydoc.getXmlFragment(PAGE_FRAGMENT).insert(0, [block]);
    const onList = Y.createRelativePositionFromTypeIndex(block, 2, 0);
    expect(
      resolveAnchor({ start: onList, end: onList, before: onList, after: onList }, ydoc),
    ).toBeNull();
  });

  it('resolves overlapping anchors, and resolveAnchors answers each pair as resolveAnchor does', () => {
    const { ydoc } = anchored();
    const d = anchorDocument(ydoc);
    const wide = rangeOf(d, `passage. ${PASSAGE}`);
    const narrow = rangeOf(d, 'new world');
    const pairs = [wide, narrow].map((r) => anchorFromSelection(d, r.from, r.to)!.pair);
    textOf(ydoc, 1).insert(0, 'Shift. ');
    const each = pairs.map((pair) => resolveAnchor(pair, ydoc));
    expect(resolveAnchors(pairs, ydoc)).toEqual(each);
    expect(each.map((r) => covered(ydoc, r))).toEqual([`passage. ${PASSAGE}`, 'new world']);
  });

  it('imports no app path, no React and no DOM', () => {
    const source = readFileSync(join(__dirname, '../../src/document/anchor.ts'), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['./schema', '@tiptap/pm/model', 'y-prosemirror', 'yjs']);
    expect(source).not.toMatch(/\b(?:document|window)\.[A-Za-z]/);
  });
});

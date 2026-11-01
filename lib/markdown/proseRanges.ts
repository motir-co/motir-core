import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

// Markdown-structure-aware text rewriting (bug MOTIR-2043). A write-side helper
// that rewrites tokens in a stored body — `normalizeWorkItemRefs`
// (lib/mentions/workItemRefs.ts) is the first — must only ever touch PROSE. A
// plain `String.replace` over the raw body is structure-BLIND: it rewrites just
// as happily inside an inline code span, a fenced block, or a link destination,
// where the author's text is documentation or a path and the rewrite is visible
// corruption (and, on the write path, a PERSISTED one — the original literal is
// gone).
//
// The durable fix is to let the Markdown parser decide what prose is. We parse
// with the SAME plugin set the render layer uses (remark-parse + remark-gfm, cf.
// lib/markdown/render.tsx) and rewrite only the source ranges covered by mdast
// `text` nodes. By construction that excludes every non-prose context:
//
//  - `inlineCode` (any backtick run length) and `code` (fenced AND indented)
//  - `html` — a raw HTML block is one opaque node
//  - a link / image DESTINATION and title — `link.url` is a node property, never
//    a `text` child, so it is not a range we can even see
//  - a link / image LABEL — a `text` node whose ancestor is link-like is skipped
//    explicitly (below), because Markdown has no nested links: rewriting there
//    would emit `[[KEY](motir:id)](/x)`, which renders as neither
//  - a GFM autolink literal (`https://…/KEY`) — remark-gfm parses it into a
//    `link`, so the URL falls under the same rule
//
// while prose in a paragraph, heading, list item, block quote, table cell, or
// emphasis stays rewritable, which is exactly the set that should chip.
//
// This is a PARSE, not a render: no react-markdown, no HTML, no sanitize
// schema — so it does not touch the single-source-of-truth render pipeline
// (tests/markdown/render-single-source.test.ts) and is safe on the server.

/**
 * The mdast shape this walker needs. Structural on purpose: `@types/mdast` is
 * not a direct dependency, and the walk only ever reads `type`, `children` and
 * the source offsets every remark-parsed node carries.
 */
interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  /** A literal's text (`text`, `inlineCode`, `code`, `html`). */
  value?: string;
  /** A `link` / `image` destination. */
  url?: string;
  /** An `image`'s alternative text. */
  alt?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/**
 * Node types whose `text` descendants are a LABEL, not prose. Markdown forbids a
 * link inside a link, so a rewrite that emits link syntax must skip these — the
 * old regex did not, which is how `[see KEY](https://x)` became a nested-bracket
 * mess. (`definition` and `footnoteReference` carry no rewritable text child at
 * all; they are listed so the intent survives a future mdast change.)
 */
const LABEL_ONLY_PARENTS = new Set([
  'link',
  'linkReference',
  'image',
  'imageReference',
  'definition',
  'footnoteReference',
]);

/**
 * The parser, built ONCE and frozen. `parse()` is pure — no processor state
 * crosses calls — so a module-level instance is safe and avoids re-building the
 * micromark extension set on every write.
 */
const parser = unified().use(remarkParse).use(remarkGfm).freeze();

/**
 * Apply `replace` to every stretch of `text` that Markdown considers PROSE,
 * splicing the results back into the original string and leaving every other
 * byte — code, HTML, link destinations, link labels — exactly as authored.
 *
 * `replace` receives the RAW source slice of one prose run (not the decoded
 * mdast value), so escapes and entities inside it round-trip untouched, and it
 * returns the rewritten slice. It is called once per run, never across a
 * boundary, so a pattern cannot match half in prose and half in code.
 *
 * Non-destructive by construction: the output is the input with only the
 * returned prose slices substituted. A body with nothing to rewrite (or one made
 * entirely of code) comes back byte-identical. Pure string work — no IO.
 */
export function replaceInProse(text: string, replace: (prose: string) => string): string {
  const tree = parser.parse(text) as unknown as MarkdownNode;

  let out = '';
  // The high-water mark in `text`: everything before it is already in `out`.
  // mdast children are in source order, so this only ever moves forward.
  let cursor = 0;

  const visit = (node: MarkdownNode, insideLabel: boolean): void => {
    if (node.type === 'text') {
      if (insideLabel) return;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined || start < cursor) return;
      out += text.slice(cursor, start) + replace(text.slice(start, end));
      cursor = end;
      return;
    }
    const childrenAreLabels = insideLabel || LABEL_ONLY_PARENTS.has(node.type);
    for (const child of node.children ?? []) visit(child, childrenAreLabels);
  };
  visit(tree, false);

  return out + text.slice(cursor);
}

/** One inline link as Markdown parses it: its destination and the text it shows. */
export interface MarkdownLink {
  url: string;
  /** The label as a reader sees it — the link's text content, markup stripped. */
  label: string;
}

/** A node's text content, the way mdast-util-to-string reads it. */
function textContent(node: MarkdownNode): string {
  if (typeof node.value === 'string') return node.value;
  if (typeof node.alt === 'string') return node.alt;
  return (node.children ?? []).map(textContent).join('');
}

/**
 * Every inline `link` node in `text`, in source order (bug MOTIR-9825). The read
 * side of the rule {@link replaceInProse} applies to writes: a scan that judges
 * links must judge exactly what renders as one, and a regex over the raw body
 * also matches link syntax quoted inside an inline code span or a code block,
 * which renders as literal text. Parsing with the render layer's own plugin set
 * makes `inlineCode` and `code` contain no links by construction.
 *
 * Only `link` nodes — the node the renderer turns into a work-item chip
 * (lib/markdown/render.tsx). Pure — no IO.
 */
export function markdownLinks(text: string): MarkdownLink[] {
  const tree = parser.parse(text) as unknown as MarkdownNode;
  const links: MarkdownLink[] = [];
  const visit = (node: MarkdownNode): void => {
    if (node.type === 'link' && typeof node.url === 'string') {
      links.push({ url: node.url, label: textContent(node) });
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return links;
}

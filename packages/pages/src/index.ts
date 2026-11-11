// `@motir/pages` — the pages module (Story MOTIR-5751 · MOTIR-5757), under
// `docs/decisions/pages.md` and `docs/decisions/app-shell-over-packages.md`.
//
// ⚠️ THIS BARREL IS THE PACKAGE'S WHOLE SURFACE. The app imports
// `@motir/pages`, never a path inside `src/`, which
// `tests/packages/importDirection.test.ts` asserts.
//
// It holds the page model types, the pure tree rules, the record's constants,
// and the page DOCUMENT: the one schema and the headless conversions between a
// stored Yjs state and its derived formats (MOTIR-7272), and the React page
// editor (MOTIR-7275), re-exported from its own `'use client'` entry.

export * from './constants';
export * from './types';
export * from './errors';
export * from './tree';
export * from './position';
export * from './document/extensions';
export * from './document/schema';
export { parseMarkdown, serializeMarkdown } from './document/markdown';
export * from './document/convert';
export * from './document/anchor';
export { extractLinks } from './document/links';
export * from './store';
export * from './save';
export * from './move';
export * from './versions';
export * from './archive';
export * from './delete';
export * from './comments';
export {
  PageEditor,
  type PageEditorMessages,
  type PageEditorProps,
  type PageEditorTheme,
  type SaveStatus,
  type PageAnchorStretch,
  type PageAnchorWash,
  type PageInlineAnchorVerdicts,
  type PageInlineThreadView,
  partitionWashes,
  PASSAGE_COMMENT_KEY,
  type PagePassageAnchor,
  type PagePassageCommentProps,
  type PagePassageComposerRenderProps,
  type AvailableWorkItemRefView,
  type WorkItemCandidate,
  type WorkItemRefView,
  type WorkItemStatusCategory,
  type EmbedCardContextValue,
  EmbedCardContext,
  EmbedCommands,
  WorkItemEmbedView,
  convertEmbedToMention,
  convertMentionToEmbed,
  defaultEmbedCard,
  insertWorkItemEmbed,
  workItemEmbedWithCard,
} from './editor';

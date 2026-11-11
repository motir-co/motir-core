'use client';

// The page editor's entry (Story MOTIR-5752 · MOTIR-7275). It is built as its
// OWN output (`dist/editor.js` / `dist/editor.cjs`) carrying the `'use client'`
// directive, and the barrel re-exports it from there, so a server module that
// imports `@motir/pages` for the schema or the save procedure gets a client
// REFERENCE for `PageEditor` rather than pulling React into a server bundle
// marked as client. See `tsup.config.ts`.

export { PageEditor, type PageEditorProps, type PageEditorTheme } from './PageEditor';
export type { PageEditorMessages } from './messages';
export type { SaveStatus } from './autosave';
export {
  createInlineComments,
  inlineCommentDecorations,
  inlineCommentsKey,
  partitionWashes,
  refreshInlineComments,
  type InlineCommentDecorationsOptions,
  type InlineCommentInputs,
  type InlineComments,
  type PageAnchorSpan,
  type PageAnchorStretch,
  type PageAnchorTarget,
  type PageAnchorWash,
  type PageInlineAnchorVerdicts,
  type PageInlineThreadView,
} from './anchors';
export {
  PASSAGE_COMMENT_KEY,
  PASSAGE_WIDE_MIN,
  capturePassageAnchor,
  isPassageCommentKey,
  placeAction,
  placeComposer,
  readPassageSelection,
  selectionIsCommentable,
  type PagePassageAnchor,
  type PagePassagePlacement,
  type PagePassageRange,
  type PagePassageViewport,
} from './passageComment';
export {
  PassageCommentAction,
  PassageCommentComposer,
  type PagePassageCommentProps,
  type PagePassageComposerRenderProps,
} from './PassageCommentSurface';
export type {
  AvailableWorkItemRefView,
  WorkItemCandidate,
  WorkItemRefView,
  WorkItemStatusCategory,
} from './workItemMention';
export {
  EmbedCardContext,
  EmbedCommands,
  WorkItemEmbedView,
  convertEmbedToMention,
  convertMentionToEmbed,
  defaultEmbedCard,
  insertWorkItemEmbed,
  workItemEmbedWithCard,
  type EmbedCardContextValue,
} from './workItemEmbed';

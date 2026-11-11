// The page editor's copy (Story MOTIR-5752 · MOTIR-7275).
//
// ⚠️ THE PACKAGE RENDERS NO STRING OF ITS OWN. Every word `<PageEditor>` puts on
// the screen — a label, a tooltip, a status, the refusal — arrives in this
// object, which the app's host (`components/pages/PageEditorHost.tsx`) fills from
// its `next-intl` catalogue in en and zh. So the package carries no i18n library
// and no locale.
//
// The shape mirrors the keys `design/pages/design-notes.md` § _Copy — the page_
// proposes under `pages.editor.*`: `pages.editor.toolbar.bold` is
// `messages.toolbar.bold`, `pages.editor.status.saved` is `messages.status.saved`.
// Two departures, both because one key in the notes carries two strings:
//
//  • the table group's text buttons each have a short visible label and a full
//    `aria-label` (`+ Row` / `Add row below`), so each key splits into
//    `addRow` + `addRowLabel`;
//  • the code block's Language field reuses the app's existing
//    `markdownEditor.codeLanguage`, which arrives here as `codeLanguage`.
//
// `bodyLabel` is the editing surface's accessible name. The notes give the body
// a placeholder but no name; a `role="textbox"` without one is an axe failure.

/** Every string `<PageEditor>` renders. */
export interface PageEditorMessages {
  /** The editing surface's accessible name (e.g. "Page body"). */
  bodyLabel: string;
  /** `pages.editor.bodyPlaceholder` — shown in an empty body. */
  bodyPlaceholder: string;
  /** `markdownEditor.codeLanguage` — the code block's Language field. */
  codeLanguage: string;
  /** `pages.editor.imageUploadFailed`. */
  imageUploadFailed: string;
  /** `pages.editor.toolbar.*`. */
  toolbar: {
    label: string;
    bold: string;
    italic: string;
    strike: string;
    heading: string;
    quote: string;
    codeBlock: string;
    bulletList: string;
    orderedList: string;
    taskList: string;
    link: string;
    linkPrompt: string;
    image: string;
    table: string;
    /** `pages.editor.toolbar.workItem` — the Work item button's visible label (MOTIR-7574). */
    workItem: string;
    /** `pages.editor.toolbar.workItemLabel` — its `aria-label`, and the picker's. */
    workItemLabel: string;
    /** `pages.editor.toolbar.workItemTip` — its tooltip, which teaches the `@` door. */
    workItemTip: string;
    /** `pages.editor.toolbar.workItemInCode` — its tooltip while disabled in a code block. */
    workItemInCode: string;
    /** `pages.editor.toolbar.embedWorkItem` — the Embed work item button's visible label (MOTIR-9182). */
    embedWorkItem: string;
    /** `pages.editor.toolbar.embedWorkItemLabel` — its `aria-label`, and the picker's in card placement. */
    embedWorkItemLabel: string;
    /** `pages.editor.toolbar.embedWorkItemTip` — its tooltip. */
    embedWorkItemTip: string;
    /** `pages.editor.toolbar.embedWorkItemInCode` — its tooltip while disabled in a code block. */
    embedWorkItemInCode: string;
  };
  /** `pages.editor.table.*` — the group shown while the caret is in a table. */
  table: {
    addRow: string;
    addRowLabel: string;
    addColumn: string;
    addColumnLabel: string;
    deleteRow: string;
    deleteRowLabel: string;
    deleteColumn: string;
    deleteColumnLabel: string;
    deleteTable: string;
  };
  /**
   * The work-item mention (Story MOTIR-5747 · MOTIR-7574), to
   * `design/pages/design-notes.md` § _Mention a work item_. The picker's copy is
   * the description editor's (`markdownEditor.mention*`, with the two strings
   * that section adds), and the unavailable chip's is `pages.mention.*`.
   */
  mention: {
    /** `markdownEditor.mentionWorkItems` — the picker's section label. */
    workItems: string;
    /** `markdownEditor.mentionTypeToSearch` — a query under two characters. */
    typeToSearch: string;
    /** `markdownEditor.mentionSearching`. */
    searching: string;
    /** `markdownEditor.mentionNoResults`, with the query filled in. */
    noResults: (query: string) => string;
    /** `markdownEditor.mentionSearchFailed`. */
    searchFailed: string;
    /** `markdownEditor.mentionRetry`. */
    retry: string;
    /** `pages.mention.unavailable` — the chip of a deleted or unreadable item. */
    unavailable: string;
    /** `pages.mention.unavailableTitle` — that chip's tooltip. */
    unavailableTitle: string;
  };
  /**
   * The embedded work-item card (Story MOTIR-7566 · MOTIR-9182), to
   * `design/pages/design-notes.md` § _Embed a work item_ — `pages.embed.*`.
   */
  embed: {
    /** `pages.embed.unavailable` — the card of a deleted or unreadable item. */
    unavailable: string;
    /** `pages.embed.unavailableTitle` — that card's tooltip. */
    unavailableTitle: string;
    /** `pages.embed.noStatus` — the status slot of an item whose status no longer resolves. */
    noStatus: string;
    /** `pages.embed.unassigned`. */
    unassigned: string;
    /** `pages.embed.archived`. */
    archived: string;
    /** `pages.embed.typeLabel`, with the type's own name filled in. */
    typeLabel: (type: string) => string;
    /** `pages.embed.cardLabel`, with the key filled in — the edit card's accessible name. */
    cardLabel: (key: string) => string;
    /** `pages.embed.open`. */
    open: string;
    /** `pages.embed.menu`. */
    menu: string;
    /** `pages.embed.toMention`. */
    toMention: string;
    /** `pages.embed.toCard`. */
    toCard: string;
    /** `pages.embed.remove`. */
    remove: string;
    /** `pages.embed.insertAs` — the picker band's label. */
    insertAs: string;
    /** `pages.embed.insertMention` — the band's first segment. */
    insertMention: string;
    /** `pages.embed.insertCard` — the band's second segment. */
    insertCard: string;
    /** `pages.embed.insertHint`. */
    insertHint: string;
  };
  /** `pages.editor.status.*` — the save indicator. */
  status: {
    saved: string;
    saving: string;
    offline: string;
    offlineDetail: string;
    tooLarge: string;
  };
  /** `pages.editor.tooLarge.*` — the refusal callout. */
  tooLarge: {
    title: string;
    body: string;
    reload: string;
    newPageNewTab: string;
  };
  /**
   * `pages.archive.refusal.editingArchived*` — the same callout when the page was
   * archived under this tab (MOTIR-7423). `status.tooLarge` ("Not saved") is the
   * indicator's word for both.
   */
  archived: {
    title: string;
    body: string;
    reload: string;
  };
  /**
   * `pages.discussion.inline.tooltip*` — the Passage tooltip over a commented
   * passage (MOTIR-10899, `design/pages/design-notes.md` § _Commenting on a
   * passage_): one thread names its author, an overlapped stretch counts them.
   */
  passage: {
    /** `inline.tooltipOne` — "Comment by {name}". */
    byAuthor: (name: string) => string;
    /** `inline.tooltipMany` — "{count} comments here". */
    overlapCount: (count: number) => string;
  };
  /**
   * `pages.discussion.inline.*` — the Selection action and the Inline composer's
   * frame (MOTIR-10900). The comment editor inside the frame is the host's, with
   * its own copy.
   */
  passageComment: {
    /** `inline.action` — the action's visible label ("Comment"). */
    action: string;
    /** `inline.actionLabel` — its accessible name ("Comment on the selected text"). */
    actionLabel: string;
    /** `inline.editorLabel` — the composer group's name ("Comment on this passage"). */
    composerLabel: string;
    /** `common.close` — the composer's close control. */
    close: string;
    /** `inline.quoteLabel` — the Quote slot's name, "Quoted passage: {quote}". */
    quoteLabel: (quote: string) => string;
  };
}

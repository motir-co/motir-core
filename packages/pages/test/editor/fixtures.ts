import * as Y from 'yjs';
import type { PageEditorMessages } from '../../src/editor/messages';
import { PAGE_FRAGMENT, applyUpdate, emptyState, markdownToUpdate, stateToText } from '../../src';

// Shared fixtures for the page editor's suites (MOTIR-7275).

/** A state holding `markdown`, built the way the markdown write door builds one. */
export function stateFromMarkdown(markdown: string): Uint8Array {
  const empty = emptyState();
  return applyUpdate(empty, markdownToUpdate(empty, markdown));
}

/** The plain text of `state` with every update in `updates` applied. */
export function textAfter(state: Uint8Array, ...updates: Uint8Array[]): string {
  return stateToText(updates.reduce((s, u) => applyUpdate(s, u), state));
}

/** A doc carrying `state`, with the page fragment ready. */
export function docFrom(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  doc.getXmlFragment(PAGE_FRAGMENT);
  return doc;
}

/** Labelled so a test can tell each string apart; the app supplies real copy. */
export const MESSAGES: PageEditorMessages = {
  bodyLabel: 'Page body',
  bodyPlaceholder: 'Start writing.',
  codeLanguage: 'Language',
  imageUploadFailed: 'Couldn’t upload the image. Try again.',
  toolbar: {
    label: 'Formatting',
    bold: 'Bold',
    italic: 'Italic',
    strike: 'Strikethrough',
    heading: 'Heading',
    quote: 'Quote',
    codeBlock: 'Code block',
    bulletList: 'Bulleted list',
    orderedList: 'Numbered list',
    taskList: 'Task list',
    link: 'Link',
    linkPrompt: 'Link URL',
    image: 'Insert image',
    table: 'Insert table',
    workItem: 'Work item',
    workItemLabel: 'Mention a work item',
    workItemTip: 'Mention a work item — or type @ in the text',
    workItemInCode: 'Work items can’t be mentioned inside a code block',
    embedWorkItem: 'Embed work item',
    embedWorkItemLabel: 'Embed a work item as a card',
    embedWorkItemTip: 'Embed a work item as a card',
    embedWorkItemInCode: 'A card can’t go in a code block',
  },
  embed: {
    unavailable: 'Work item unavailable',
    unavailableTitle: 'This work item was deleted, or you can’t view it',
    noStatus: 'No status',
    unassigned: 'Unassigned',
    archived: 'Archived',
    typeLabel: (type) => `Type: ${type}`,
    cardLabel: (key) => `Work item ${key}`,
    open: 'Open work item',
    menu: 'Card options',
    toMention: 'Show as inline mention',
    toCard: 'Show as card',
    remove: 'Remove card',
    insertAs: 'Insert as',
    insertMention: 'Inline mention',
    insertCard: 'Card',
    insertHint: 'Tab to switch · Enter to insert',
  },
  mention: {
    workItems: 'Work items',
    typeToSearch: 'Keep typing to search work items…',
    searching: 'Searching…',
    noResults: (query) => `No work items match “${query}”.`,
    searchFailed: 'Couldn’t search work items.',
    retry: 'Try again',
    unavailable: 'Unavailable work item',
    unavailableTitle: 'This work item was deleted, or you can’t see it.',
  },
  table: {
    addRow: '+ Row',
    addRowLabel: 'Add row below',
    addColumn: '+ Column',
    addColumnLabel: 'Add column to the right',
    deleteRow: '− Row',
    deleteRowLabel: 'Delete row',
    deleteColumn: '− Column',
    deleteColumnLabel: 'Delete column',
    deleteTable: 'Delete table',
  },
  status: {
    saved: 'Saved',
    saving: 'Saving…',
    offline: 'Offline — edits kept',
    offlineDetail: 'Your last save didn’t reach Motir.',
    tooLarge: 'Not saved',
  },
  tooLarge: {
    title: 'This page is too large to save',
    body: 'Your edits since the last save would take the page past its 2 MB limit.',
    reload: 'Reload saved version',
    newPageNewTab: 'New page in a new tab',
  },
  archived: {
    title: 'This page was archived',
    body: 'Someone archived it while you were editing.',
    reload: 'Reload page',
  },
  passage: {
    byAuthor: (name) => `Comment by ${name}`,
    overlapCount: (count) => `${count} comments here`,
  },
  passageComment: {
    action: 'Comment',
    actionLabel: 'Comment on the selected text',
    composerLabel: 'Comment on this passage',
    close: 'Close',
    quoteLabel: (quote) => `Quoted passage: ${quote}`,
  },
};

/** The rejection the host raises for the save route's 413. */
export function tooLargeError(): Error & { code: string } {
  return Object.assign(new Error('This page body is too large.'), {
    code: 'PAGE_BODY_TOO_LARGE',
  });
}

/** The rejection the host raises for the save route's 409 `PAGE_ARCHIVED` (MOTIR-7423). */
export function archivedError(): Error & { code: string } {
  return Object.assign(new Error('This page is archived.'), { code: 'PAGE_ARCHIVED' });
}

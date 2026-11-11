'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Collaboration } from '@tiptap/extension-collaboration';
import { Placeholder } from '@tiptap/extensions';
import { TriangleAlert } from 'lucide-react';
import * as Y from 'yjs';
import { pageExtensions } from '../document/extensions';
import { PAGE_FRAGMENT } from '../document/schema';
import {
  createInlineComments,
  refreshInlineComments,
  type PageAnchorTarget,
  type PageInlineAnchorVerdicts,
  type PageInlineThreadView,
} from './anchors';
import { startAutosave, type SaveStatus } from './autosave';
import { codeBlockLanguage } from './codeBlockLanguage';
import type { PageEditorMessages } from './messages';
import {
  capturePassageAnchor,
  isPassageCommentKey,
  placeAction,
  placeComposer,
  readPassageSelection,
  selectionIsCommentable,
  type PagePassageAnchor,
  type PagePassagePlacement,
} from './passageComment';
import {
  PassageCommentAction,
  PassageCommentComposer,
  type PagePassageCommentProps,
} from './PassageCommentSurface';
import { PageEditorToolbar } from './PageEditorToolbar';
import { SaveIndicator } from './SaveIndicator';
import { PAGE_EDITOR_CSS } from './styles';
import { WorkItemPicker, defaultPickerRow } from './WorkItemPicker';
import {
  EmbedCardContext,
  EmbedCommands,
  defaultEmbedCard,
  workItemEmbedWithCard,
  type EmbedCardContextValue,
} from './workItemEmbed';
import {
  MentionChipContext,
  candidateView,
  defaultChip,
  openMentionTrigger,
  workItemMentionWithChip,
  workItemSuggestion,
  type AvailableWorkItemRefView,
  type MentionChipContextValue,
  type MentionSuggestionState,
  type WorkItemCandidate,
  type WorkItemRefView,
} from './workItemMention';

// The page editor (Story MOTIR-5752 · MOTIR-7275), under
// `docs/decisions/pages.md` §2–§3 and drawn by `design/pages/page.mock.html`
// states 6–10.
//
// ⚠️ THE BODY IS A YJS DOCUMENT AND THE EDITOR SENDS UPDATES. `initialState` is
// the stored `Y.encodeStateAsUpdate(doc)`; it is applied to a fresh `Y.Doc`, and
// Tiptap's collaboration extension binds that doc's `default` fragment
// (`PAGE_FRAGMENT`) — the field a co-editing provider will attach to later
// without a migration. Every local change becomes a Yjs update, and
// `autosave.ts` sends them, merged, through `saveUpdate`.
//
// ⚠️ EVERY PIECE OF APP WIRING IS A PROP. The save route, the image upload, the
// copy and the theme all arrive from the host (`components/pages/PageEditorHost.tsx`,
// MOTIR-7280), so nothing here imports `@/…` and the component knows no URL.
//
// It grows from `components/ui/MarkdownEditor.tsx` by COPY (ADR §2): the same
// Tiptap 3 `useEditor` + `EditorContent`, `immediatelyRender: false` for SSR, the
// same paste / drop interception, the same toolbar. The extension list is the
// document card's `pageExtensions()` — the ONE schema the server reads — plus the
// React-side extensions only an editor needs: the collaboration binding, the
// placeholder and the code block's Language field.

/** The colour mode the host resolved; the package reads no theme context. */
export type PageEditorTheme = 'light' | 'dark';

export interface PageEditorProps<C extends WorkItemCandidate = WorkItemCandidate> {
  /** The stored body, `Y.encodeStateAsUpdate(doc)`. Read at mount. */
  initialState: Uint8Array;
  /**
   * Whether the reader may write. `false` is the read-only page: no toolbar, no
   * save indicator, no autosave subscription, and a body that cannot be edited.
   */
  editable: boolean;
  /**
   * Send ONE Yjs update to the page's save door. Reject with an error carrying
   * `code: 'PAGE_BODY_TOO_LARGE'` for the size refusal; any other rejection is
   * treated as a failure to reach the server and retried.
   */
  saveUpdate: (update: Uint8Array) => Promise<{ revision: number }>;
  /** Store an image filed under this page and resolve to its URL. */
  uploadImage: (file: File) => Promise<{ url: string }>;
  /** Every string the editor renders. */
  messages: PageEditorMessages;
  /** The colour mode, written as `data-color-mode` on the editor's root. */
  theme: PageEditorTheme;
  /** Told each time the save status changes. */
  onSaveStatusChange?: (status: SaveStatus) => void;
  /**
   * The refusal callout's reload (**Reload saved version**, or **Reload page**
   * for an archived page). The button is drawn only when the host supplies it
   * (a full reload is the host's to perform).
   */
  onReloadSaved?: () => void;
  /** The too-large callout's **New page in a new tab**, likewise. */
  onNewPage?: () => void;
  /**
   * The work-item search behind the mention picker (MOTIR-7574) — the page's
   * project only. Supplied → an editable page offers both doors (`@` and the
   * toolbar's **Work item**); omitted → neither. A rejection is the picker's
   * "search failed" state.
   */
  searchWorkItems?: (query: string) => Promise<C[]>;
  /**
   * The live summary of every work item the body mentions, by id, as the page
   * loaded with them. An id with no entry is a deleted item.
   */
  workItemRefs?: Record<string, WorkItemRefView>;
  /** Draws a live or archived chip; the unavailable chip is the package's. */
  renderWorkItemChip?: (view: AvailableWorkItemRefView) => ReactNode;
  /** Draws one picker row's content; the option around it is the package's. */
  renderPickerRow?: (candidate: C, active: boolean) => ReactNode;
  /** Draws a live or archived embedded card; the unavailable card is the package's. */
  renderWorkItemCard?: (view: AvailableWorkItemRefView) => ReactNode;
  /** Where the read-only card's anchor points, for a ⌘-click or a new tab. */
  workItemHref?: (view: AvailableWorkItemRefView) => string;
  /**
   * A plain click on a live chip in the read-only page, when the chip the host
   * rendered did not open the item itself.
   */
  onOpenWorkItem?: (id: string) => void;
  /**
   * Every anchored root of the page's inline threads (MOTIR-10899), resolved ones
   * included — the editor skips those. Supplied → the Passage wash is drawn over
   * each open thread's passage; omitted (the History column's version) → no
   * plugin exists at all. Whether it is supplied is read once, at mount.
   */
  inlineThreads?: readonly PageInlineThreadView[];
  /** The thread whose passage wears the emphasis state. */
  focusedInlineThreadId?: string | null;
  /** A click on a wash: the root whose range begins first over that stretch. */
  onInlineThreadClick?: (rootId: string) => void;
  /** After each resolve pass that changed the answer: every root's range, or `null` for gone. */
  onInlineAnchorsResolved?: (verdicts: PageInlineAnchorVerdicts) => void;
  /**
   * Comment on a passage (MOTIR-10900). Supplied → a commentable selection, in
   * the editable body and the read-only body alike, offers the Selection action
   * (and `Mod-Shift-m`), which opens the Inline composer; omitted → nothing is
   * offered, never a disabled action. The host supplies it only on a live page
   * to a reader holding `comment:add`.
   */
  passageComment?: PagePassageCommentProps;
}

const NO_REFS: Record<string, WorkItemRefView> = {};
const NO_THREADS: readonly PageInlineThreadView[] = [];

/** Where the Passage tooltip sits in the body wrapper, and what it says. */
interface PassageTip {
  readonly text: string;
  readonly left: number;
  readonly top: number;
}

/** The tooltip's place: 8px above the washed text's first line (the CSS lifts it). */
function tipPosition(element: HTMLElement): { left: number; top: number } {
  const wrapper = element.closest('[data-mention-anchor]');
  const line = element.getClientRects()[0] ?? element.getBoundingClientRect();
  const box = wrapper?.getBoundingClientRect();
  return {
    left: Math.round(line.left - (box?.left ?? 0)),
    top: Math.round(line.top - (box?.top ?? 0)),
  };
}

/** The open Inline composer: the passage it captured, and where it sits. */
interface OpenComposer {
  readonly anchor: PagePassageAnchor;
  readonly placement: PagePassagePlacement;
}

/** The window's selection, measured against the body wrapper — or `null`. */
function measureSelection(view: Editor['view'], wrapper: HTMLElement | null) {
  if (!wrapper) return null;
  const range = readPassageSelection(view);
  if (!range || !selectionIsCommentable(view.state.doc, range)) return null;
  const selection = view.dom.ownerDocument.getSelection();
  /* v8 ignore next -- readPassageSelection already proved a range exists */
  if (!selection || selection.rangeCount === 0) return null;
  const rects = Array.from(selection.getRangeAt(0).getClientRects());
  const win = view.dom.ownerDocument.defaultView;
  return {
    range,
    box: wrapper.getBoundingClientRect(),
    rects,
    viewport: { width: win?.innerWidth ?? 0, height: win?.innerHeight ?? 0 },
  };
}

/** The first image in a paste, drop or picker payload, if any. */
function pickImage(files: FileList | null | undefined): File | null {
  if (!files) return null;
  for (const file of Array.from(files)) {
    if (file.type.startsWith('image/')) return file;
  }
  return null;
}

function loadDoc(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  // No origin: this is the stored body arriving, not an edit of this tab's.
  Y.applyUpdate(doc, state);
  return doc;
}

export function PageEditor<C extends WorkItemCandidate = WorkItemCandidate>({
  initialState,
  editable,
  saveUpdate,
  uploadImage,
  messages,
  theme,
  onSaveStatusChange,
  onReloadSaved,
  onNewPage,
  searchWorkItems,
  workItemRefs = NO_REFS,
  renderWorkItemChip = defaultChip,
  renderWorkItemCard = defaultEmbedCard,
  workItemHref,
  renderPickerRow = defaultPickerRow,
  onOpenWorkItem,
  inlineThreads,
  focusedInlineThreadId = null,
  onInlineThreadClick,
  onInlineAnchorsResolved,
  passageComment,
}: PageEditorProps<C>) {
  // The document lives as long as the component; `initialState` is read once.
  const [doc] = useState(() => loadDoc(initialState));
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [uploadFailed, setUploadFailed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The latest callbacks, read through refs so a parent re-render never
  // re-creates the editor or restarts the autosave loop.
  const saveUpdateRef = useRef(saveUpdate);
  const uploadImageRef = useRef(uploadImage);
  const onStatusRef = useRef(onSaveStatusChange);
  useEffect(() => {
    saveUpdateRef.current = saveUpdate;
    uploadImageRef.current = uploadImage;
    onStatusRef.current = onSaveStatusChange;
  }, [saveUpdate, uploadImage, onSaveStatusChange]);

  const insertImage = useCallback(async (editor: Editor, file: File) => {
    try {
      const { url } = await uploadImageRef.current(file);
      setUploadFailed(false);
      editor.chain().setImage({ src: url, alt: file.name }).run();
    } catch {
      // Never drop the file silently.
      setUploadFailed(true);
    }
  }, []);

  // Autosave: subscribed only for a writer.
  //
  // ⚠️ A LAYOUT effect, declared BEFORE `useEditor`, and it must stay both. The
  // editor is created in `useEditor`'s passive effect, and binding it can WRITE
  // to the doc at once — a plugin's `appendTransaction` normalising the loaded
  // body is recorded in Yjs with the binding's own origin. (StarterKit's
  // trailing node did exactly that until `pageExtensions()` turned it off.)
  // Every later keystroke depends on such a write, so a loop that subscribed
  // after it would send updates the server could never integrate. Layout
  // effects run before passive ones, so the loop hears the first write.
  useLayoutEffect(() => {
    if (!editable) return;
    const autosave = startAutosave({
      doc,
      saveUpdate: (update) => saveUpdateRef.current(update),
      onStatusChange: (next) => {
        setStatus(next);
        onStatusRef.current?.(next);
      },
    });
    return () => autosave.dispose();
  }, [doc, editable]);

  // Created once; the paste / drop handlers reach the editor through this.
  const editorRef = useRef<Editor | null>(null);

  // ── Mention a work item (MOTIR-7574) ──────────────────────────────────────
  // The `@` suggestion reports here and the picker renders from this state. The
  // doors exist only on an editable page with a search wired; the extension list
  // is fixed per editor, so that is read once, at mount.
  const [mentionEnabled] = useState(() => editable && searchWorkItems !== undefined);
  // The card door exists when the composed list carries the card node too.
  const [embedEnabled] = useState(
    () => mentionEnabled && pageExtensions().some((e) => e.name === 'workItemEmbed'),
  );
  // Which form the open picker will place; the door that opened it sets the start.
  const [placement, setPlacement] = useState<'mention' | 'card'>('mention');
  const [suggestion, setSuggestion] = useState<
    (MentionSuggestionState & { position?: { left: number; top: number } }) | null
  >(null);
  // The chips inserted this session, shown from the picked candidate until the
  // page is read again.
  const [pickedRefs, setPickedRefs] = useState<Record<string, AvailableWorkItemRefView>>({});

  // ── The Passage wash (MOTIR-10899) ────────────────────────────────────────
  // The extension reads its inputs from a box of its own, so a new list or a new
  // focus never re-creates the editor; `refreshInlineComments` tells it they
  // moved. Whether the wash exists at all is read once, at mount.
  const [passageTip, setPassageTip] = useState<PassageTip | null>(null);
  const [inline] = useState(() => (inlineThreads === undefined ? null : createInlineComments(doc)));
  // A layout effect, so the inputs are current before the extension's first pass
  // (it runs in a microtask after the editor is created in a passive effect).
  useLayoutEffect(() => {
    const threads = inlineThreads ?? NO_THREADS;
    inline?.setInputs({
      threads,
      focusedThreadId: focusedInlineThreadId,
      onResolved: onInlineAnchorsResolved,
      onClick: onInlineThreadClick,
      onTarget: (target: PageAnchorTarget | null) => {
        if (target === null) {
          setPassageTip(null);
          return;
        }
        const author = threads.find((t) => t.id === target.ids[0])?.authorName ?? '';
        setPassageTip({
          text:
            target.ids.length > 1
              ? messages.passage.overlapCount(target.ids.length)
              : messages.passage.byAuthor(author),
          ...tipPosition(target.element),
        });
      },
    });
  }, [
    inline,
    inlineThreads,
    focusedInlineThreadId,
    onInlineAnchorsResolved,
    onInlineThreadClick,
    messages.passage,
  ]);

  const editor = useEditor({
    immediatelyRender: false,
    editable,
    extensions: [
      // The document's list, its mention node given the live chip.
      ...pageExtensions().map((extension) =>
        extension.name === 'workItemMention'
          ? workItemMentionWithChip()
          : extension.name === 'workItemEmbed'
            ? workItemEmbedWithCard()
            : extension,
      ),
      ...(editable ? [EmbedCommands] : []),
      // Read at creation only, like the rest of these options.
      ...(mentionEnabled
        ? [
            workItemSuggestion({
              // The picker sits 4px under the caret, inside the body's positioned
              // wrapper — never a body portal (`MentionList`'s placement).
              onChange: (next) => {
                const box = next.anchor?.getBoundingClientRect();
                setSuggestion({
                  ...next,
                  position:
                    next.rect && box
                      ? {
                          left: Math.round(next.rect.left - box.left),
                          top: Math.round(next.rect.bottom - box.top + 4),
                        }
                      : undefined,
                });
              },
              onClose: () => {
                setSuggestion(null);
                // The next opening starts in mention placement unless the toolbar's
                // Embed control asks for the card.
                setPlacement('mention');
              },
              onInsert: (candidate) =>
                setPickedRefs((prev) => ({ ...prev, [candidate.id]: candidateView(candidate) })),
            }),
          ]
        : []),
      Collaboration.configure({ document: doc, field: PAGE_FRAGMENT }),
      Placeholder.configure({ placeholder: messages.bodyPlaceholder }),
      codeBlockLanguage(messages.codeLanguage),
      ...(inline ? [inline.extension] : []),
    ],
    editorProps: {
      attributes: {
        class: 'motir-prose',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': messages.bodyLabel,
      },
      handlePaste: (_view, event) => {
        const file = pickImage(event.clipboardData?.files);
        const current = editorRef.current;
        if (!file || !current) return false;
        event.preventDefault();
        void insertImage(current, file);
        return true;
      },
      handleDrop: (_view, event) => {
        const file = pickImage(event.dataTransfer?.files);
        const current = editorRef.current;
        if (!file || !current) return false;
        event.preventDefault();
        void insertImage(current, file);
        return true;
      },
    },
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // ── Comment on a passage (MOTIR-10900) ────────────────────────────────────
  // The action follows the window's selection; it is measured after the press
  // ends (never mid-drag) and coalesced to one frame. The composer captures its
  // passage once, at open, and keeps it whatever the selection does after.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [passageAction, setPassageAction] = useState<PagePassagePlacement | null>(null);
  const [composer, setComposer] = useState<OpenComposer | null>(null);
  const mayCommentOnPassage = passageComment !== undefined;
  const composerOpen = composer !== null;

  const openComposer = useCallback(() => {
    const current = editorRef.current;
    if (!current || current.isDestroyed) return false;
    const measured = measureSelection(current.view, bodyRef.current);
    if (!measured) return false;
    const anchor = capturePassageAnchor(doc, measured.range);
    if (!anchor) return false;
    setPassageAction(null);
    setComposer({
      anchor,
      placement: placeComposer(measured.box, measured.rects, measured.viewport),
    });
    return true;
  }, [doc]);

  const closeComposer = useCallback(() => {
    setComposer(null);
    const current = editorRef.current;
    // Back to the body a writer was typing in; a reader's read-only body takes no focus.
    if (current && !current.isDestroyed && current.isEditable) current.view.focus();
  }, []);

  useEffect(() => {
    // Not offered, or the composer is open: the action is not drawn (see below).
    if (!editor || !mayCommentOnPassage || composerOpen) return;
    const ownerDocument = editor.view.dom.ownerDocument;
    const win = ownerDocument.defaultView;
    let pressed = false;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (pressed || editor.isDestroyed) return;
      const measured = measureSelection(editor.view, bodyRef.current);
      setPassageAction(
        measured ? placeAction(measured.box, measured.rects, measured.viewport) : null,
      );
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    const onPress = () => {
      pressed = true;
      setPassageAction(null);
    };
    const onRelease = () => {
      pressed = false;
      schedule();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPassageCommentKey(event) || event.defaultPrevented) return;
      if (openComposer()) event.preventDefault();
    };
    const dom = editor.view.dom;
    dom.addEventListener('pointerdown', onPress);
    ownerDocument.addEventListener('pointerup', onRelease);
    ownerDocument.addEventListener('selectionchange', schedule);
    ownerDocument.addEventListener('keydown', onKeyDown);
    win?.addEventListener('resize', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      dom.removeEventListener('pointerdown', onPress);
      ownerDocument.removeEventListener('pointerup', onRelease);
      ownerDocument.removeEventListener('selectionchange', schedule);
      ownerDocument.removeEventListener('keydown', onKeyDown);
      win?.removeEventListener('resize', schedule);
    };
  }, [editor, mayCommentOnPassage, composerOpen, openComposer]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  // A new list or a new focus: redraw the emphasis and resolve again.
  useEffect(() => {
    if (!editor || !inline || editor.isDestroyed) return;
    refreshInlineComments(editor.view, focusedInlineThreadId);
  }, [editor, inline, inlineThreads, focusedInlineThreadId]);

  const onPickImage = useCallback(() => fileInputRef.current?.click(), []);
  const onMentionWorkItem = useCallback(() => {
    if (editor) openMentionTrigger(editor);
  }, [editor]);

  const onEmbedWorkItem = useCallback(() => {
    if (!editor) return;
    // This door starts the picker in card placement; the band can still switch it.
    setPlacement('card');
    openMentionTrigger(editor);
  }, [editor]);

  const chipContext = useMemo<MentionChipContextValue>(
    () => ({
      lookup: (id) => pickedRefs[id] ?? workItemRefs[id],
      renderChip: renderWorkItemChip,
      messages: messages.mention,
      editable,
      onOpen: onOpenWorkItem,
      toCardLabel: embedEnabled ? messages.embed.toCard : undefined,
    }),
    [
      pickedRefs,
      workItemRefs,
      renderWorkItemChip,
      messages.mention,
      messages.embed.toCard,
      embedEnabled,
      editable,
      onOpenWorkItem,
    ],
  );
  const cardContext = useMemo<EmbedCardContextValue>(
    () => ({
      lookup: (id) => pickedRefs[id] ?? workItemRefs[id],
      renderCard: renderWorkItemCard,
      messages: messages.embed,
      editable,
      onOpen: onOpenWorkItem,
      hrefFor: workItemHref,
    }),
    [
      pickedRefs,
      workItemRefs,
      renderWorkItemCard,
      messages.embed,
      editable,
      onOpenWorkItem,
      workItemHref,
    ],
  );

  const onFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = pickImage(event.target.files);
      event.target.value = ''; // the same file can be picked again
      if (file && editor) void insertImage(editor, file);
    },
    [editor, insertImage],
  );

  // The two final refusals share base state 9's callout: the page passed its size
  // limit, or someone archived it under this tab (MOTIR-7423). Either way the
  // loop has stopped and the content stays here to be copied out.
  const refusal =
    !editable || (status !== 'too_large' && status !== 'archived')
      ? null
      : status === 'archived'
        ? {
            title: messages.archived.title,
            body: messages.archived.body,
            reload: messages.archived.reload,
            newPage: null,
          }
        : {
            title: messages.tooLarge.title,
            body: messages.tooLarge.body,
            reload: messages.tooLarge.reload,
            newPage: messages.tooLarge.newPageNewTab,
          };
  const onNewPageHere = refusal?.newPage ? onNewPage : undefined;

  return (
    // suppressHydrationWarning: the host may resolve the colour mode only on
    // the client, as `MarkdownEditor` does.
    <div className="motir-page-editor" data-color-mode={theme} suppressHydrationWarning>
      <style href="motir-page-editor" precedence="default">
        {PAGE_EDITOR_CSS}
      </style>
      {editable && editor ? (
        <PageEditorToolbar
          editor={editor}
          messages={messages}
          onInsertImage={onPickImage}
          onMentionWorkItem={mentionEnabled ? onMentionWorkItem : undefined}
          onEmbedWorkItem={embedEnabled ? onEmbedWorkItem : undefined}
          mentionOpen={suggestion !== null}
          trailing={<SaveIndicator status={status} messages={messages.status} />}
        />
      ) : null}
      {refusal ? (
        <div
          role="alert"
          data-refusal={status}
          className="mt-4 flex gap-3 rounded-(--radius-card) border border-(--el-danger) bg-(--el-danger-surface) p-(--spacing-card-padding) text-(--el-danger-surface-text)"
        >
          <TriangleAlert
            className="mt-px h-[18px] w-[18px] flex-none text-(--el-danger-on-surface)"
            aria-hidden
          />
          <div>
            <p className="text-sm font-semibold">{refusal.title}</p>
            <p className="mt-1 text-[13.5px] leading-normal">{refusal.body}</p>
            {onReloadSaved || onNewPageHere ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {onReloadSaved ? (
                  <button type="button" onClick={onReloadSaved} className={SECONDARY_BUTTON}>
                    {refusal.reload}
                  </button>
                ) : null}
                {onNewPageHere ? (
                  <button type="button" onClick={onNewPageHere} className={SECONDARY_BUTTON}>
                    {refusal.newPage}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {uploadFailed ? (
        <p role="alert" className="mt-2 text-xs text-(--el-danger-on-surface)">
          {messages.imageUploadFailed}
        </p>
      ) : null}
      <div ref={bodyRef} data-mention-anchor className="relative pt-4 pb-2">
        <MentionChipContext.Provider value={chipContext}>
          <EmbedCardContext.Provider value={cardContext}>
            {editor ? <EditorContent editor={editor} /> : null}
          </EmbedCardContext.Provider>
        </MentionChipContext.Provider>
        {suggestion && searchWorkItems ? (
          <div className="absolute z-50" style={suggestion.position}>
            <WorkItemPicker<C>
              query={suggestion.query}
              search={searchWorkItems}
              renderRow={renderPickerRow}
              onPick={suggestion.pick}
              label={messages.toolbar.workItemLabel}
              messages={messages.mention}
              band={
                embedEnabled
                  ? {
                      placement,
                      onPlacementChange: setPlacement,
                      onPickEmbed: suggestion.pickEmbed,
                      messages: messages.embed,
                    }
                  : undefined
              }
            />
          </div>
        ) : null}
        {passageTip ? (
          // The Passage tooltip: in the body's positioned wrapper like the
          // picker, out of the text's flow, and holding no control.
          <div
            role="tooltip"
            className="motir-passage-tip"
            style={{ left: passageTip.left, top: passageTip.top }}
          >
            {passageTip.text}
          </div>
        ) : null}
        {passageAction && passageComment && !composer ? (
          <PassageCommentAction
            placement={passageAction}
            messages={messages.passageComment}
            onChoose={() => void openComposer()}
          />
        ) : null}
        {composer && passageComment ? (
          <PassageCommentComposer
            // A new passage is a new composer: its editor starts empty.
            key={composer.anchor.bytes}
            anchor={composer.anchor}
            placement={composer.placement}
            messages={messages.passageComment}
            onClose={closeComposer}
            renderComposer={passageComment.renderComposer}
          />
        ) : null}
      </div>
      {editable ? (
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onFileChange}
          tabIndex={-1}
          aria-hidden
        />
      ) : null}
    </div>
  );
}

// `Button variant="secondary" size="sm"` from the design system, copied: the
// package does not depend on `@motir/design-system`.
const SECONDARY_BUTTON =
  'inline-flex h-(--height-btn-sm) items-center justify-center rounded-(--radius-btn) border border-(--el-button-border) bg-transparent px-(--spacing-btn-x-sm) text-xs font-medium text-(--el-text) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

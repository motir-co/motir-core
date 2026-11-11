'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  PageBodyTooLargeError,
  PageEditor,
  type AvailableWorkItemRefView,
  type PageCommentDto,
  type PageEditorMessages,
  type PageInlineAnchorVerdicts,
  type PageInlineThreadView,
  type PagePassageAnchor,
  type PagePassageCommentProps,
  type SaveStatus,
} from '@motir/pages';
import { CommentComposer } from '@/app/(authed)/items/[key]/_components/CommentComposer';
import type { MentionCandidate } from '@/components/ui/MarkdownEditor';
import { WorkItemEmbedCard } from '@/components/pages/WorkItemEmbedCard';
import { WorkItemRefChip } from '@/components/markdown/WorkItemRefChip';
import {
  WorkItemMentionRow,
  type WorkItemMentionCandidate,
} from '@/components/ui/markdownEditorMentions';
import { Tooltip } from '@/components/ui/Tooltip';
import { useOptionalTheme } from '@/lib/contexts/theme-context';
import type { WorkItemKindDto, WorkItemRefMap, WorkItemTypeDto } from '@/lib/dto/workItems';
import { searchWorkItemMentions } from '@/lib/mentions/workItemMentionSearch';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import '@/components/ui/markdown-editor.css';

// THE one client host for `@motir/pages`' editor (Story MOTIR-5752 · MOTIR-7280),
// `docs/decisions/pages.md` §2. `<PageEditor>` knows no URL, no locale and no
// theme context — every piece of app wiring arrives as a prop, and this file is
// where each one is bound:
//
//  • `saveUpdate` — one Yjs update as raw bytes to `POST /api/pages/<id>/updates`.
//    200 resolves `{ revision }`. 413 rejects with a `PageBodyTooLargeError`,
//    which carries `code: 'PAGE_BODY_TOO_LARGE'` — final (`too_large`). A 409
//    `PAGE_ARCHIVED` (the page was archived under this tab, MOTIR-7423) rejects
//    with `code: 'PAGE_ARCHIVED'` — final too (`archived`). Anything else (a
//    fetch that never reached the server, a 5xx) rejects as a plain error, which the editor reads as `offline`
//    and retries with backoff.
//  • `uploadImage` — multipart `POST /api/pages/<id>/images` → `{ url }`.
//  • `messages` — `pages.editor.*` from `next-intl`, plus the app's existing
//    `markdownEditor.codeLanguage`.
//  • `theme` — `useOptionalTheme()`'s resolved pattern, as `MarkdownEditor` reads it.
//  • `initialState` — the DTO's base64 Yjs state, decoded once.
//  • the PASSAGE WASH (MOTIR-10899): `inlineThreads` are the page's anchored
//    roots as the thread read answers them (`PageCommentDto`), mapped ONCE here
//    to the editor's view — the anchor's base64 decoded with this file's
//    `decodeBase64`, so the package holds bytes and the product keeps one decoder
//    for the value. Omitted (the History column's version) → no wash at all.
//  • the work-item MENTION (MOTIR-7574, `design/pages/design-notes.md`
//    § _Mention a work item_): `searchWorkItems` is the shipped mention search
//    narrowed to the page's project (and rejecting on a refused search, so the
//    picker can say it failed); `workItemRefs` is `PageDto.workItemRefs`; the
//    chip is the shipped `motir:` chip (`WorkItemRefChip`, the one
//    `lib/markdown/render.tsx` mounts) under a `{title} · {status}` tooltip; the
//    picker row is `MentionList`'s (`WorkItemMentionRow`); and a read-only chip
//    the shipped chip did not open itself opens the quick-view peek.
//
// ⚠️ IT IMPORTS NOTHING SERVER-ONLY. `@motir/pages` is imported from its barrel,
// whose editor entry carries `'use client'`; `@/lib/pages` (the server
// composition root, which binds the Prisma store) is never reached from here.
// `tests/packages/importDirection.test.ts` holds that `@motir/pages` is imported
// only here and under `lib/pages/`.
//
// THE LEAVE GUARD. The editor's offline buffer lives in this tab, so leaving the
// page while a save is in flight, offline or refused loses the writer's edits.
// While the status is anything but `saved`, a `beforeunload` prompt asks first
// (design-notes § Open questions — MOTIR-7280 decides it). The callout's own
// **Reload saved version** is the writer choosing to discard, so it lifts the
// guard before reloading.

/** Decode the DTO's base64 Yjs state. */
export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The save door's refusal, read from its 413 body. */
async function tooLargeFrom(res: Response): Promise<PageBodyTooLargeError> {
  let limit = 0;
  let size = 0;
  try {
    const body = (await res.json()) as { limit?: unknown; size?: unknown };
    if (typeof body.limit === 'number') limit = body.limit;
    if (typeof body.size === 'number') size = body.size;
  } catch {
    // The status alone is the refusal; the numbers are detail.
  }
  return new PageBodyTooLargeError(limit, size);
}

/** Send one update; resolve the new revision or reject as the editor expects. */
export async function sendPageUpdate(
  pageId: string,
  update: Uint8Array,
): Promise<{ revision: number }> {
  const res = await fetch(`/api/pages/${encodeURIComponent(pageId)}/updates`, {
    method: 'POST',
    // A copy over a plain `ArrayBuffer` — what `BodyInit` accepts.
    body: new Uint8Array(update),
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (res.status === 413) throw await tooLargeFrom(res);
  if (res.status === 409) {
    // Archived under this tab (MOTIR-7423): a FINAL refusal, carried by its code
    // so the editor stops instead of retrying. Any other 409 stays retryable.
    const body = (await res.json().catch(() => ({}))) as { code?: unknown };
    if (body.code === 'PAGE_ARCHIVED') {
      throw Object.assign(new Error('This page is archived.'), { code: 'PAGE_ARCHIVED' });
    }
  }
  if (!res.ok) throw new Error(`Page save failed with HTTP ${res.status}`);
  return (await res.json()) as { revision: number };
}

/** Upload one image filed under the page. */
export async function uploadPageImage(pageId: string, file: File): Promise<{ url: string }> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/pages/${encodeURIComponent(pageId)}/images`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(`Image upload failed with HTTP ${res.status}`);
  return (await res.json()) as { url: string };
}

/** The editor's copy, from the `pages.editor` catalogue. */
function usePageEditorMessages(): PageEditorMessages {
  const t = useTranslations('pages.editor');
  const tMarkdown = useTranslations('markdownEditor');
  const tArchive = useTranslations('pages.archive.refusal');
  const tMention = useTranslations('pages.mention');
  const tEmbed = useTranslations('pages.embed');
  const tInline = useTranslations('pages.discussion.inline');
  const tCommon = useTranslations('common');
  return useMemo(
    () => ({
      bodyLabel: t('bodyLabel'),
      bodyPlaceholder: t('bodyPlaceholder'),
      codeLanguage: tMarkdown('codeLanguage'),
      imageUploadFailed: t('imageUploadFailed'),
      toolbar: {
        label: t('toolbar.label'),
        bold: t('toolbar.bold'),
        italic: t('toolbar.italic'),
        strike: t('toolbar.strike'),
        heading: t('toolbar.heading'),
        quote: t('toolbar.quote'),
        codeBlock: t('toolbar.codeBlock'),
        bulletList: t('toolbar.bulletList'),
        orderedList: t('toolbar.orderedList'),
        taskList: t('toolbar.taskList'),
        link: t('toolbar.link'),
        linkPrompt: t('toolbar.linkPrompt'),
        image: t('toolbar.image'),
        table: t('toolbar.table'),
        workItem: t('toolbar.workItem'),
        workItemLabel: t('toolbar.workItemLabel'),
        workItemTip: t('toolbar.workItemTip'),
        workItemInCode: t('toolbar.workItemInCode'),
        embedWorkItem: t('toolbar.embedWorkItem'),
        embedWorkItemLabel: t('toolbar.embedWorkItemLabel'),
        embedWorkItemTip: t('toolbar.embedWorkItemTip'),
        embedWorkItemInCode: t('toolbar.embedWorkItemInCode'),
      },
      table: {
        addRow: t('table.addRow'),
        addRowLabel: t('table.addRowLabel'),
        addColumn: t('table.addColumn'),
        addColumnLabel: t('table.addColumnLabel'),
        deleteRow: t('table.deleteRow'),
        deleteRowLabel: t('table.deleteRowLabel'),
        deleteColumn: t('table.deleteColumn'),
        deleteColumnLabel: t('table.deleteColumnLabel'),
        deleteTable: t('table.deleteTable'),
      },
      status: {
        saved: t('status.saved'),
        saving: t('status.saving'),
        offline: t('status.offline'),
        offlineDetail: t('status.offlineDetail'),
        tooLarge: t('status.tooLarge'),
      },
      tooLarge: {
        title: t('tooLarge.title'),
        body: t('tooLarge.body'),
        reload: t('tooLarge.reload'),
        newPageNewTab: t('tooLarge.newPageNewTab'),
      },
      mention: {
        workItems: tMarkdown('mentionWorkItems'),
        typeToSearch: tMarkdown('mentionTypeToSearch'),
        searching: tMarkdown('mentionSearching'),
        noResults: (query: string) => tMarkdown('mentionNoResults', { query }),
        searchFailed: tMarkdown('mentionSearchFailed'),
        retry: tMarkdown('mentionRetry'),
        unavailable: tMention('unavailable'),
        unavailableTitle: tMention('unavailableTitle'),
      },
      embed: {
        unavailable: tEmbed('unavailable'),
        unavailableTitle: tEmbed('unavailableTitle'),
        noStatus: tEmbed('noStatus'),
        unassigned: tEmbed('unassigned'),
        archived: tEmbed('archived'),
        typeLabel: (type: string) => tEmbed('typeLabel', { type }),
        cardLabel: (key: string) => tEmbed('cardLabel', { key }),
        open: tEmbed('open'),
        menu: tEmbed('menu'),
        toMention: tEmbed('toMention'),
        toCard: tEmbed('toCard'),
        remove: tEmbed('remove'),
        insertAs: tEmbed('insertAs'),
        insertMention: tEmbed('insertMention'),
        insertCard: tEmbed('insertCard'),
        insertHint: tEmbed('insertHint'),
      },
      archived: {
        title: tArchive('editingArchived'),
        body: tArchive('editingArchivedBody'),
        reload: tArchive('reload'),
      },
      passage: {
        byAuthor: (name: string) => tInline('tooltipOne', { name }),
        overlapCount: (count: number) => tInline('tooltipMany', { count }),
      },
      passageComment: {
        action: tInline('action'),
        actionLabel: tInline('actionLabel'),
        composerLabel: tInline('editorLabel'),
        close: tCommon('close'),
        quoteLabel: (quote: string) => tInline('quoteLabel', { quote }),
      },
    }),
    [t, tMarkdown, tArchive, tMention, tEmbed, tInline, tCommon],
  );
}

/**
 * A page chip, live or archived: the shipped `motir:` chip under the hover
 * tooltip the notes draw — the full title and the status by name, so the status
 * is not carried by the dot's hue alone.
 */
export function renderPageWorkItemChip(view: AvailableWorkItemRefView) {
  const summary = {
    ...view,
    kind: view.kind as WorkItemKindDto,
    type: view.type as WorkItemTypeDto | null,
    status: view.status ? { ...view.status, key: view.status.key ?? '' } : null,
  };
  const tip = view.status ? `${view.title} · ${view.status.label}` : view.title;
  return (
    <Tooltip content={tip} side="bottom">
      <span>
        <WorkItemRefChip summary={summary} fallbackLabel={view.identifier} />
      </span>
    </Tooltip>
  );
}

/** A page's embedded card, live or archived: the app's card under the package's frame. */
export function renderPageWorkItemCard(view: AvailableWorkItemRefView) {
  return <WorkItemEmbedCard view={view} />;
}

/** The read-only card's anchor target — the item's page, for a ⌘-click or a new tab. */
export function pageWorkItemHref(view: AvailableWorkItemRefView): string {
  return `/items/${encodeURIComponent(view.identifier)}`;
}

/** One picker row: `MentionList`'s work-item row. */
export function renderPageMentionRow(candidate: WorkItemMentionCandidate, active: boolean) {
  return <WorkItemMentionRow item={candidate} active={active} />;
}

/**
 * Open a work item's quick-view peek (`?peek=<key>`, shallow), as the shipped
 * chip's own click does — for a chip that did not open it itself.
 */
export function openWorkItemPeek(identifier: string): void {
  const params = new URLSearchParams(window.location.search);
  params.set('peek', identifier);
  shallowPush(`${window.location.pathname}?${params.toString()}`);
}

/**
 * The page's anchored roots as the editor draws them: every root carrying an
 * anchor, resolved ones included (the editor skips those), its bytes decoded.
 */
export function toInlineThreadViews(roots: readonly PageCommentDto[]): PageInlineThreadView[] {
  return roots.flatMap((root) =>
    root.anchor === null
      ? []
      : [
          {
            id: root.id,
            anchor: decodeBase64(root.anchor.bytes),
            quote: root.anchor.quote,
            authorName: root.author.name,
            resolvedAt: root.resolvedAt,
          },
        ],
  );
}

/** A captured passage, `{ bytes: base64, quote }` — the create door's `anchor`. */
export type PagePassage = PagePassageAnchor;

/**
 * Comment on a passage (MOTIR-10900), handed by a page whose reader holds
 * `comment:add` on a live page — and only then, so a reader without it is offered
 * no action at all.
 */
export interface PageEditorHostPassageComment {
  /** The project's members for the composer's mention picker. */
  mentionCandidates: MentionCandidate[];
  /**
   * Start a thread on `anchor`. Resolve to the refusal line to show, or `null`
   * once the thread is posted (the composer then closes).
   */
  onSubmit: (anchor: PagePassage, bodyMd: string) => Promise<string | null>;
}

/** Each anchored root's range after a resolve pass, `null` when gone — for the page around it. */
export type PageAnchorVerdicts = PageInlineAnchorVerdicts;

/** The live editor's save status, for the page around it (`@motir/pages`' `SaveStatus`). */
export type PageSaveStatus = SaveStatus;

export interface PageEditorHostProps {
  pageId: string;
  /** `PageDto.bodyState` — the stored Yjs state, base64. */
  bodyState: string;
  /** `PageDto.canEdit`. */
  canEdit: boolean;
  /**
   * Told every save-status change, after the leave guard records it — so the
   * page can hold a restore while edits are unsaved (MOTIR-7388).
   */
  onSaveStatusChange?: (status: SaveStatus) => void;
  /**
   * `PageDto.projectId` — the one project the work-item picker searches. Without
   * it the editor offers no mention door at all, never a search across projects.
   */
  projectId?: string;
  /** `PageDto.workItemRefs` — the live summary of every work item the body mentions. */
  workItemRefs?: WorkItemRefMap;
  /**
   * The page's anchored thread roots (MOTIR-10899) — supplied only to the LIVE
   * editor, so the History column's version draws no wash.
   */
  inlineThreads?: readonly PageCommentDto[];
  /** The thread whose passage wears the emphasis state. */
  focusedInlineThreadId?: string | null;
  /** That thread was reached from the keyboard: its passage draws the focus ring and tooltip. */
  focusedInlineThreadRing?: boolean;
  /** A click on a passage's wash, with the thread it opens. */
  onInlineThreadClick?: (rootId: string) => void;
  /** Each anchored root's range after a resolve pass, `null` when its passage is gone. */
  onInlineAnchorsResolved?: (verdicts: PageInlineAnchorVerdicts) => void;
  /** Comment on a passage; omitted → the editor offers no Selection action. */
  passageComment?: PageEditorHostPassageComment;
}

const NO_REFS: WorkItemRefMap = {};

/**
 * The Inline composer's body: the shipped `CommentComposer` in its reply shape
 * (the editor open at once, Cancel and Comment) — the design's "shipped comment
 * editor", posting with the passage the frame captured.
 */
function PassageComposer({
  anchor,
  close,
  passage,
}: {
  anchor: PagePassage;
  close: () => void;
  passage: PageEditorHostPassageComment;
}) {
  const tInline = useTranslations('pages.discussion.inline');
  const tDiscussion = useTranslations('pages.discussion');
  return (
    <CommentComposer
      mode="reply"
      label={tInline('editorLabel')}
      submitLabel={tDiscussion('comment')}
      mentionCandidates={passage.mentionCandidates}
      onSubmit={async (bodyMd) => {
        const refusal = await passage.onSubmit(anchor, bodyMd);
        if (refusal === null) close();
        return refusal;
      }}
      onCancel={close}
    />
  );
}

export function PageEditorHost({
  pageId,
  bodyState,
  canEdit,
  onSaveStatusChange: onStatus,
  projectId,
  workItemRefs = NO_REFS,
  inlineThreads,
  focusedInlineThreadId,
  focusedInlineThreadRing,
  onInlineThreadClick,
  onInlineAnchorsResolved,
  passageComment,
}: PageEditorHostProps) {
  const messages = usePageEditorMessages();
  const theme = useOptionalTheme()?.resolvedPattern ?? 'light';
  // Read once: the editor reads `initialState` at mount and owns the doc after.
  const [initialState] = useState(() => decodeBase64(bodyState));

  const inlineThreadViews = useMemo(
    () => (inlineThreads === undefined ? undefined : toInlineThreadViews(inlineThreads)),
    [inlineThreads],
  );
  const saveUpdate = useCallback((update: Uint8Array) => sendPageUpdate(pageId, update), [pageId]);
  const uploadImage = useCallback((file: File) => uploadPageImage(pageId, file), [pageId]);
  const searchWorkItems = useMemo(
    () =>
      projectId
        ? (query: string) => searchWorkItemMentions(query, { projectId, throwOnError: true })
        : undefined,
    [projectId],
  );
  const onOpenWorkItem = useCallback(
    (id: string) => {
      const ref = workItemRefs[id];
      if (ref?.accessible) openWorkItemPeek(ref.identifier);
    },
    [workItemRefs],
  );

  const passageCommentProps = useMemo<PagePassageCommentProps | undefined>(
    () =>
      passageComment
        ? {
            renderComposer: ({ anchor, close }) => (
              <PassageComposer anchor={anchor} close={close} passage={passageComment} />
            ),
          }
        : undefined,
    [passageComment],
  );

  // ── The leave guard ───────────────────────────────────────────────────────
  const statusRef = useRef<SaveStatus>('saved');
  const discardingRef = useRef(false);
  const onStatusRef = useRef(onStatus);
  useEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);
  const onSaveStatusChange = useCallback((status: SaveStatus) => {
    statusRef.current = status;
    onStatusRef.current?.(status);
  }, []);
  useEffect(() => {
    if (!canEdit) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (discardingRef.current || statusRef.current === 'saved') return;
      event.preventDefault();
      // Older browsers read the prompt from `returnValue`; the text is ignored.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [canEdit]);

  const onReloadSaved = useCallback(() => {
    discardingRef.current = true;
    window.location.reload();
  }, []);

  // **New page in a new tab**: the tab is opened INSIDE the click so no popup
  // blocker refuses it, then pointed at the page once `POST /api/pages` answers.
  const onNewPage = useCallback(() => {
    const tab = window.open('about:blank', '_blank');
    void (async () => {
      try {
        const res = await fetch('/api/pages', { method: 'POST' });
        if (!res.ok) throw new Error(`Page create failed with HTTP ${res.status}`);
        const { id } = (await res.json()) as { id: string };
        if (tab) {
          tab.opener = null;
          tab.location.href = `/pages/${encodeURIComponent(id)}`;
        }
      } catch {
        tab?.close();
      }
    })();
  }, []);

  return (
    <PageEditor
      initialState={initialState}
      editable={canEdit}
      saveUpdate={saveUpdate}
      uploadImage={uploadImage}
      messages={messages}
      theme={theme}
      onSaveStatusChange={onSaveStatusChange}
      onReloadSaved={onReloadSaved}
      onNewPage={onNewPage}
      searchWorkItems={searchWorkItems}
      workItemRefs={workItemRefs}
      renderWorkItemChip={renderPageWorkItemChip}
      renderWorkItemCard={renderPageWorkItemCard}
      workItemHref={pageWorkItemHref}
      renderPickerRow={renderPageMentionRow}
      onOpenWorkItem={onOpenWorkItem}
      inlineThreads={inlineThreadViews}
      focusedInlineThreadId={focusedInlineThreadId}
      focusedInlineThreadRing={focusedInlineThreadRing}
      onInlineThreadClick={onInlineThreadClick}
      onInlineAnchorsResolved={onInlineAnchorsResolved}
      passageComment={passageCommentProps}
    />
  );
}

export default PageEditorHost;

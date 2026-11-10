'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Archive, CircleCheck, Eye, MessageSquare, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/ErrorState';
import { Segmented } from '@/components/ui/Segmented';
import type { MentionCandidate } from '@/components/ui/MarkdownEditor';
import type { PageCommentDto, PageCommentThreadDto } from '@/lib/pages';
import { CommentComposer } from '@/app/(authed)/items/[key]/_components/CommentComposer';
import {
  createPageComment,
  deletePageComment,
  editPageComment,
  listPageComments,
  reopenPageCommentThread,
  replyToPageComment,
  resolvePageCommentThread,
  type PageCommentRefusal,
  type PageCommentResult,
  type PageDiscussionCapabilities,
  type PageDiscussionList,
} from './pageCommentsClient';
import { PageCommentThread } from './PageCommentThread';

// The page's DISCUSSION PANEL (Story MOTIR-10866 · MOTIR-10874), drawn by
// `design/pages/page--discussion.mock.html` and specified in
// `design/pages/design-notes.md` § Discussion.
//
// ── ONE CLIENT ISLAND OWNS THE WINDOW ─────────────────────────────────────
// It holds both lists (Open, newest first by the root's `createdAt`; Resolved,
// newest first by `resolvedAt`), their cursors, both counts and the reader's
// `capabilities`, all from the list read. The Open list is read when the panel
// opens (a page opens with it closed); the Resolved list the first time it is
// shown. Every write applies the DTO its route returned IN PLACE — nothing calls
// `router.refresh()`: the page's server render reads nothing this panel changes.
//
// ── SEQUENCE GUARDS ───────────────────────────────────────────────────────
// A list read is stamped per list, so a Retry's answer wins over the read it
// replaced and a Load more that lands after a re-read is dropped. A write that
// REPLACES state — Resolve / Reopen per thread, Edit per comment — is stamped per
// target, and only the latest stamp's answer is applied, so two quick Resolve /
// Reopen presses end in the state of the last press. Resolve and Reopen move the
// thread at once (and back on a refusal), so the button under the pointer is the
// next press's. A write that ADDS or REMOVES a row (post, reply, delete) is
// applied by id, so no answer can duplicate or resurrect a row.
//
// ── WHO SEES WHAT ─────────────────────────────────────────────────────────
// Controls are present or absent, never disabled. `canComment` (from the list,
// false for a viewer and on an archived page) gives the composer, Reply, Resolve
// and Reopen; Edit / Delete are the author's, or anyone's with `canModerate`.
// The read-only line says why a reader has none. The server re-checks every
// write; a refusal shows as the write-failed line, never a crash.

type ListKind = 'open' | 'resolved';

interface ListState {
  kind: 'loading' | 'failed' | 'ready';
  threads: PageCommentThreadDto[];
  nextCursor: string | null;
  more: 'idle' | 'loading' | 'failed';
}

type Lists = Record<ListKind, ListState>;

const LOADING: ListState = { kind: 'loading', threads: [], nextCursor: null, more: 'idle' };
/** A list not read yet — it is read the first time it is shown. */
const UNREAD: ListState = { ...LOADING };

const SKELETON_THREADS = 3;

/** The write a refusal is reported for — the design's `writeFailed.*` keys. */
type WriteAction = 'post' | 'reply' | 'edit' | 'delete' | 'resolve' | 'reopen';

export interface PageDiscussionPanelProps {
  pageId: string;
  /** The page is archived: every thread reads, for everyone, with the archive line. */
  archived: boolean;
  /** The reader, so their own comments carry Edit / Delete. */
  currentUserId: string;
  /** The reader's display name — the composer's avatar and an optimistic resolver. */
  currentUserName: string;
  /** The project's members for the mention picker; empty for a reader who cannot comment. */
  mentionCandidates: MentionCandidate[];
  onClose: () => void;
  /** The open count changed — the Discussion control's chip follows it. */
  onOpenCountChange?: (count: number) => void;
}

/** The key a list is ordered by, newest first. */
function sortKey(thread: PageCommentThreadDto): string {
  return thread.resolvedAt ?? thread.createdAt;
}

/**
 * Put `thread` where its state says it lives: out of both lists, then into its
 * own list at its place — when that list is loaded, and the place is inside the
 * loaded window (past the window's end, Load more brings it).
 */
function placeThread(lists: Lists, thread: PageCommentThreadDto): Lists {
  const target: ListKind = thread.resolvedAt === null ? 'open' : 'resolved';
  const next = { ...lists };
  for (const kind of ['open', 'resolved'] as const) {
    const list = lists[kind];
    const threads = list.threads.filter((item) => item.id !== thread.id);
    if (kind === target && list.kind === 'ready') {
      const at = threads.findIndex((item) => sortKey(item) < sortKey(thread));
      if (at >= 0) threads.splice(at, 0, thread);
      else if (list.nextCursor === null) threads.push(thread);
    }
    next[kind] =
      threads.length === list.threads.length && kind !== target ? list : { ...list, threads };
  }
  return next;
}

/** Apply `update` to the one thread with this id, wherever it is listed. */
function mapThread(
  lists: Lists,
  id: string,
  update: (thread: PageCommentThreadDto) => PageCommentThreadDto | null,
): Lists {
  const next = { ...lists };
  for (const kind of ['open', 'resolved'] as const) {
    const list = lists[kind];
    if (!list.threads.some((thread) => thread.id === id)) continue;
    next[kind] = {
      ...list,
      threads: list.threads.flatMap((thread) => {
        if (thread.id !== id) return [thread];
        const changed = update(thread);
        return changed === null ? [] : [changed];
      }),
    };
  }
  return next;
}

export function PageDiscussionPanel({
  pageId,
  archived,
  currentUserId,
  currentUserName,
  mentionCandidates,
  onClose,
  onOpenCountChange,
}: PageDiscussionPanelProps) {
  const t = useTranslations('pages.discussion');
  const tc = useTranslations('comments');
  const tcommon = useTranslations('common');
  const [active, setActive] = useState<ListKind>('open');
  const [lists, setLists] = useState<Lists>({ open: LOADING, resolved: UNREAD });
  const [read, setRead] = useState<ReadonlySet<ListKind>>(() => new Set(['open']));
  /** Both counts, from the latest list read; `null` until the first one answers. */
  const [counts, setCounts] = useState<Record<ListKind, number> | null>(null);
  const [capabilities, setCapabilities] = useState<PageDiscussionCapabilities | null>(null);
  const [threadErrors, setThreadErrors] = useState<Readonly<Record<string, string>>>({});
  const closeRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const listSeq = useRef<Record<ListKind, number>>({ open: 0, resolved: 0 });
  const moreSeq = useRef<Record<ListKind, number>>({ open: 0, resolved: 0 });
  const targetSeq = useRef(new Map<string, number>());

  const stamp = (target: string) => {
    const seq = (targetSeq.current.get(target) ?? 0) + 1;
    targetSeq.current.set(target, seq);
    return seq;
  };
  const isLatest = (target: string, seq: number) =>
    alive.current && targetSeq.current.get(target) === seq;

  const failure = useCallback(
    (refusal: PageCommentRefusal, action: WriteAction): string => {
      switch (refusal.code) {
        case 'PAGE_ARCHIVED':
          return t('writeFailed.archived');
        case 'PAGE_COMMENT_REPLY_DEPTH_EXCEEDED':
          return t('writeFailed.replyDepth');
        case 'PAGE_COMMENT_BODY_EMPTY':
          return tc('errors.empty');
        case 'PAGE_COMMENT_NOT_FOUND':
          return tc('errors.notFound');
      }
      if (refusal.status === 403) return tc('errors.forbidden');
      return action === 'delete' ? tc('errors.generic') : t(`writeFailed.${action}`);
    },
    [t, tc],
  );

  // ── Reads ────────────────────────────────────────────────────────────────
  /** Apply a list read's answer, unless a newer read of that list replaced it. */
  const applyList = useCallback(
    (kind: ListKind, seq: number, res: PageCommentResult<PageDiscussionList>) => {
      if (!alive.current || seq !== listSeq.current[kind]) return;
      if (!res.ok) {
        setLists((prev) => ({ ...prev, [kind]: { ...prev[kind], kind: 'failed' } }));
        return;
      }
      setLists((prev) => ({
        ...prev,
        [kind]: {
          kind: 'ready',
          threads: [...res.data.threads],
          nextCursor: res.data.nextCursor,
          more: 'idle',
        },
      }));
      setCounts(res.data.counts);
      setCapabilities(res.data.capabilities);
    },
    [],
  );

  const fetchList = (kind: ListKind) => {
    const seq = ++listSeq.current[kind];
    void listPageComments(pageId, { status: kind, order: 'desc' }).then((res) =>
      applyList(kind, seq, res),
    );
  };

  // The Open list is read on open; focus moves into the panel.
  useEffect(() => {
    alive.current = true;
    closeRef.current?.focus();
    const seq = ++listSeq.current.open;
    void listPageComments(pageId, { status: 'open', order: 'desc' }).then((res) =>
      applyList('open', seq, res),
    );
    return () => {
      alive.current = false;
    };
  }, [pageId, applyList]);

  const reload = (kind: ListKind) => {
    setLists((prev) => ({ ...prev, [kind]: LOADING }));
    fetchList(kind);
  };

  const show = (kind: ListKind) => {
    setActive(kind);
    if (!read.has(kind)) {
      setRead((prev) => new Set(prev).add(kind));
      reload(kind);
    }
  };

  const loadMore = async (kind: ListKind, cursor: string) => {
    const generation = listSeq.current[kind];
    const seq = ++moreSeq.current[kind];
    setLists((prev) => ({ ...prev, [kind]: { ...prev[kind], more: 'loading' } }));
    const res = await listPageComments(pageId, { status: kind, order: 'desc', cursor });
    if (!alive.current || generation !== listSeq.current[kind] || seq !== moreSeq.current[kind]) {
      return;
    }
    if (!res.ok) {
      setLists((prev) => ({ ...prev, [kind]: { ...prev[kind], more: 'failed' } }));
      return;
    }
    setLists((prev) => {
      const list = prev[kind];
      const seen = new Set(list.threads.map((thread) => thread.id));
      return {
        ...prev,
        [kind]: {
          ...list,
          threads: [...list.threads, ...res.data.threads.filter((thread) => !seen.has(thread.id))],
          nextCursor: res.data.nextCursor,
          more: 'idle',
        },
      };
    });
    setCounts(res.data.counts);
    setCapabilities(res.data.capabilities);
  };

  // The control's chip follows the open count.
  const openCount = counts?.open ?? null;
  useEffect(() => {
    if (openCount !== null) onOpenCountChange?.(openCount);
  }, [openCount, onOpenCountChange]);

  // Esc closes the panel — unless something inside it takes that Esc first: a
  // composer (it cancels or collapses itself), the mention picker, the delete
  // confirm, or any dialog.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest(
          '[role="dialog"], [role="alertdialog"], [role="listbox"], [data-radix-popper-content-wrapper], [contenteditable="true"], textarea, input',
        )
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // ── Writes ───────────────────────────────────────────────────────────────
  /** Move the counts by a write; a write only happens once a read has answered them. */
  const adjustCounts = (delta: Partial<Record<ListKind, number>>) =>
    setCounts(
      (prev) =>
        prev && {
          open: Math.max(0, prev.open + (delta.open ?? 0)),
          resolved: Math.max(0, prev.resolved + (delta.resolved ?? 0)),
        },
    );

  const setThreadError = (id: string, message: string | null) =>
    setThreadErrors((prev) => {
      if (message === null) {
        if (!(id in prev)) return prev;
        const rest = { ...prev };
        delete rest[id];
        return rest;
      }
      return { ...prev, [id]: message };
    });

  async function submitComment(bodyMd: string): Promise<string | null> {
    const res = await createPageComment(pageId, bodyMd);
    if (!res.ok) return failure(res, 'post');
    const thread = res.data;
    setLists((prev) =>
      prev.open.threads.some((item) => item.id === thread.id)
        ? prev
        : { ...prev, open: { ...prev.open, threads: [thread, ...prev.open.threads] } },
    );
    adjustCounts({ open: 1 });
    return null;
  }

  async function submitReply(rootId: string, bodyMd: string): Promise<string | null> {
    const res = await replyToPageComment(pageId, rootId, bodyMd);
    if (!res.ok) return failure(res, 'reply');
    const reply = res.data;
    setLists((prev) =>
      mapThread(prev, rootId, (thread) =>
        thread.replies.some((item) => item.id === reply.id)
          ? thread
          : { ...thread, replies: [...thread.replies, reply] },
      ),
    );
    return null;
  }

  async function submitEdit(
    rootId: string,
    commentId: string,
    bodyMd: string,
  ): Promise<string | null> {
    const key = `edit:${commentId}`;
    const seq = stamp(key);
    const res = await editPageComment(pageId, commentId, bodyMd);
    if (!res.ok) return failure(res, 'edit');
    if (!isLatest(key, seq)) return null;
    const edited: PageCommentDto = res.data;
    setLists((prev) =>
      mapThread(prev, rootId, (thread) =>
        thread.id === edited.id
          ? { ...thread, ...edited, replies: thread.replies }
          : {
              ...thread,
              replies: thread.replies.map((reply) => (reply.id === edited.id ? edited : reply)),
            },
      ),
    );
    return null;
  }

  async function remove(thread: PageCommentThreadDto, commentId: string): Promise<string | null> {
    const res = await deletePageComment(pageId, commentId);
    if (!res.ok) return failure(res, 'delete');
    if (res.data.parentCommentId === null) {
      // A root takes one from the Open count: only an open thread offers Delete.
      setLists((prev) => mapThread(prev, thread.id, () => null));
      adjustCounts({ open: -1 });
      setThreadError(thread.id, null);
    } else {
      setLists((prev) =>
        mapThread(prev, thread.id, (item) => ({
          ...item,
          replies: item.replies.filter((reply) => reply.id !== commentId),
        })),
      );
    }
    return null;
  }

  async function move(thread: PageCommentThreadDto, to: ListKind) {
    const from: ListKind = to === 'resolved' ? 'open' : 'resolved';
    const key = `resolution:${thread.id}`;
    const seq = stamp(key);
    const optimistic: PageCommentThreadDto =
      to === 'resolved'
        ? {
            ...thread,
            resolvedAt: new Date().toISOString(),
            resolvedBy: { id: currentUserId, name: currentUserName, image: null },
          }
        : { ...thread, resolvedAt: null, resolvedBy: null };
    const shift = (a: ListKind, b: ListKind) => adjustCounts({ [a]: -1, [b]: 1 });
    setThreadError(thread.id, null);
    setLists((prev) => placeThread(prev, optimistic));
    shift(from, to);
    const res =
      to === 'resolved'
        ? await resolvePageCommentThread(pageId, thread.id)
        : await reopenPageCommentThread(pageId, thread.id);
    if (!isLatest(key, seq)) return;
    if (res.ok) {
      setLists((prev) => placeThread(prev, res.data));
      return;
    }
    // Refused: back where it was, with the reason at its foot.
    setLists((prev) => placeThread(prev, thread));
    shift(to, from);
    setThreadError(thread.id, failure(res, to === 'resolved' ? 'resolve' : 'reopen'));
  }

  // ── Render ───────────────────────────────────────────────────────────────
  const list = lists[active];
  const cursor = list.nextCursor;
  const known = capabilities !== null;
  const canWrite = !archived && capabilities?.canComment === true;
  const canModerate = capabilities?.canModerate === true;
  const trailing = (count: number | null) =>
    count === null ? undefined : <span className="tabular-nums">{count}</span>;

  return (
    <>
      <div
        aria-hidden
        data-testid="page-discussion-scrim"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-(--el-overlay-scrim) xl:hidden"
      />
      <aside
        id="page-discussion"
        aria-labelledby="page-discussion-title"
        className="fixed inset-y-0 right-0 z-50 flex w-[340px] max-w-full flex-col border-l border-(--el-border) bg-(--el-page-bg) shadow-(--shadow-modal) xl:sticky xl:top-0 xl:z-auto xl:max-h-dvh xl:shrink-0 xl:shadow-none"
      >
        <div className="flex flex-col gap-2.5 border-b border-(--el-border) px-4 py-3">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-(--el-text-secondary)" aria-hidden />
            <h2
              id="page-discussion-title"
              className="flex-1 text-sm font-semibold text-(--el-text)"
            >
              {t('title')}
            </h2>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label={t('close')}
              className="inline-flex items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-icon-muted) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <Segmented
            label={t('switchLabel')}
            value={active}
            onChange={show}
            options={[
              { value: 'open', label: t('listOpen'), trailing: trailing(counts?.open ?? null) },
              {
                value: 'resolved',
                label: t('listResolved'),
                trailing: trailing(counts?.resolved ?? null),
              },
            ]}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="flex flex-col">
            {known && !canWrite ? <ReadOnlyLine archived={archived} /> : null}
            {active === 'open' && canWrite && list.kind === 'ready' ? (
              <div className="pb-1">
                <CommentComposer
                  mode="new"
                  label={t('composerLabel')}
                  submitLabel={t('comment')}
                  authorName={currentUserName}
                  mentionCandidates={mentionCandidates}
                  onSubmit={submitComment}
                />
              </div>
            ) : null}
            {list.kind === 'loading' ? (
              <DiscussionSkeleton />
            ) : list.kind === 'failed' ? (
              <div className="py-4">
                <ErrorState
                  title={t('loadFailedTitle')}
                  description={t('loadFailedBody')}
                  retry={() => reload(active)}
                  retryLabel={tcommon('retry')}
                />
              </div>
            ) : list.threads.length === 0 ? (
              <Empty resolved={active === 'resolved'} />
            ) : (
              <div
                role="list"
                aria-label={active === 'open' ? t('openThreadsLabel') : t('resolvedThreadsLabel')}
                className="flex flex-col"
              >
                {list.threads.map((thread) => (
                  <div role="listitem" key={thread.id}>
                    <PageCommentThread
                      thread={thread}
                      canWrite={canWrite}
                      canModerate={canModerate}
                      currentUserId={currentUserId}
                      mentionCandidates={mentionCandidates}
                      error={threadErrors[thread.id] ?? null}
                      onReply={(bodyMd) => submitReply(thread.id, bodyMd)}
                      onEdit={(commentId, bodyMd) => submitEdit(thread.id, commentId, bodyMd)}
                      onDelete={(commentId) => remove(thread, commentId)}
                      onResolve={() => void move(thread, 'resolved')}
                      onReopen={() => void move(thread, 'open')}
                    />
                  </div>
                ))}
                {cursor === null ? null : list.more === 'failed' ? (
                  <div
                    role="alert"
                    className="flex items-center gap-2 px-(--spacing-control-x) py-(--spacing-control-y)"
                  >
                    <TriangleAlert
                      className="h-4 w-4 shrink-0 text-(--el-danger-on-surface)"
                      aria-hidden
                    />
                    <span className="flex-1 text-sm text-(--el-text)">{t('loadMoreFailed')}</span>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void loadMore(active, cursor)}
                    >
                      {tcommon('retry')}
                    </Button>
                  </div>
                ) : (
                  <div className="pt-3">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="w-full"
                      loading={list.more === 'loading'}
                      onClick={() => void loadMore(active, cursor)}
                    >
                      {list.more === 'loading' ? t('loadingMore') : t('loadMore')}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

/** Why this reader has no controls: their role, or the archived page. */
function ReadOnlyLine({ archived }: { archived: boolean }) {
  const t = useTranslations('pages.discussion');
  const Icon = archived ? Archive : Eye;
  return (
    <p className="mb-2 flex items-center gap-2 rounded-(--radius-control) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y-8) font-sans text-xs text-(--el-text-secondary)">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {archived ? t('readOnlyArchived') : t('readOnlyViewer')}
    </p>
  );
}

/** The first read: thread-shaped frames, one polite status line. */
function DiscussionSkeleton() {
  const t = useTranslations('pages.discussion');
  return (
    <>
      <p role="status" className="sr-only">
        {t('loading')}
      </p>
      <div
        aria-hidden
        data-testid="page-discussion-skeleton"
        className="flex animate-pulse flex-col gap-5 py-2"
      >
        {Array.from({ length: SKELETON_THREADS }, (_, index) => (
          <div key={index} className="flex items-start gap-2.5">
            <span className="h-[22px] w-[22px] shrink-0 rounded-full bg-(--el-muted)" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="h-3 w-2/5 rounded-(--radius-control) bg-(--el-muted)" />
              <span className="h-3 w-4/5 rounded-(--radius-control) bg-(--el-muted)" />
              {index % 2 === 0 ? (
                <span className="h-3 w-3/5 rounded-(--radius-control) bg-(--el-muted)" />
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function Empty({ resolved }: { resolved: boolean }) {
  const t = useTranslations('pages.discussion');
  const Icon = resolved ? CircleCheck : MessageSquare;
  return (
    <div className="flex flex-col items-center gap-1.5 px-2 py-8 text-center">
      <Icon className="h-[22px] w-[22px] text-(--el-text-faint)" aria-hidden />
      <p className="font-sans text-sm font-semibold text-(--el-text)">
        {resolved ? t('emptyResolvedTitle') : t('emptyTitle')}
      </p>
      <p className="font-sans text-[13px] text-(--el-text-secondary)">
        {resolved ? t('emptyResolvedBody') : t('emptyBody')}
      </p>
    </div>
  );
}

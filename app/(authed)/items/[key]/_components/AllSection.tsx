'use client';

import { useRef, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { History } from 'lucide-react';
import { ErrorState } from '@/components/ui/ErrorState';
import type { MentionCandidate } from '@/components/ui/MarkdownEditor';
import type { CommentAuthorDTO, CommentDTO, CommentThreadDTO } from '@/lib/dto/comments';
import type { ActivityAllEntryDto, ActivityAllPageDto } from '@/lib/dto/activity';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import { useCommentsSort } from '@/lib/hooks/useCommentsSort';
import { useActivityRevision } from '@/lib/hooks/useActivityRevision';
import { entriesDrawAgentVerdict, walkToAgentVerdict } from '@/lib/activity/anchorWalk';
import { agentVerdictRecordIdOfHash } from '@/lib/agentReview/verdictActivity';
import { ContentSectionCard } from './ContentSectionCard';
import { CommentComposer } from './CommentComposer';
import { CommentRow } from './CommentRow';
import { ActivityEntryRow, ActivitySkeleton } from './ActivityEntryRow';
import { addCommentAction } from '../commentActions';

// The All tab (Story 5.5 · Subtask 5.5.4) — comments and history entries
// interleaved in true timestamp order, per
// `design/work-items/activity-history.mock.html` panel 3: each entry keeps
// its NATIVE grammar — comments render the full 5.1.3 row (22px avatar, 14px
// body, quiet action row: Reply / Edit / Delete still work here) and history
// rows render the quieter 5.5.3 grammar (18px avatar, 13px secondary-ink
// sentence). The shared 22px grid column + the size/ink step-down keeps the
// two scannable: conversation loud, telemetry quiet.
//
// The read is the 5.5.2 bounded two-source merge behind a composite cursor
// (finding #57); the window is HELD newest-first and the shared sort order is
// a presentation flip (the 5.1.5 contract, generalised). A comment DELETION
// writes a `comment_deleted` revision the loaded window can't fabricate, so a
// delete reloads the first page instead of patching in place; replies and
// edits patch the thread entry in place like CommentsSection does.

interface ReplyTarget {
  rootId: string;
  author: CommentAuthorDTO;
}

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export function AllSection({
  workItemId,
  initialPage,
  headerControls,
  statusCategories,
  canComment,
  canModerate,
  currentUserId,
  mentionCandidates,
}: {
  workItemId: string;
  /** The server-rendered first page, or null when the server read failed. */
  initialPage: ActivityAllPageDto | null;
  /** The shared Activity filter + sort toggle (owned by ActivitySection). */
  headerControls: ReactNode;
  statusCategories: Readonly<Record<string, StatusCategoryDto>>;
  canComment: boolean;
  canModerate: boolean;
  currentUserId: string;
  mentionCandidates: MentionCandidate[];
}) {
  const t = useTranslations('activity');
  const tc = useTranslations('comments');
  const router = useRouter();

  const [entries, setEntries] = useState<ActivityAllEntryDto[]>(initialPage?.entries ?? []);
  const [totalComments, setTotalComments] = useState(initialPage?.totalComments ?? 0);
  const [totalChanges, setTotalChanges] = useState(initialPage?.totalChanges ?? 0);
  const [nextCursor, setNextCursor] = useState<string | null>(initialPage?.nextCursor ?? null);
  // Resolved `motir:` references across the loaded comment entries (Subtask
  // 5.8.6) — the comment bodies' internal-link chips render against it, exactly
  // like the dedicated Comments tab. Each fetched page merges in.
  const [workItemRefs, setWorkItemRefs] = useState<WorkItemRefMap>(initialPage?.workItemRefs ?? {});
  const [order] = useCommentsSort();
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(initialPage === null);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);

  async function fetchPage(cursor?: string): Promise<ActivityAllPageDto> {
    const params = new URLSearchParams({ order: 'desc' });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`/api/work-items/${workItemId}/activity/all?${params}`);
    if (!res.ok) throw new Error(`Activity read failed (${res.status})`);
    return (await res.json()) as ActivityAllPageDto;
  }

  // The window's continuation point, as the anchor walk last saw it: a walk whose window has
  // moved on meanwhile (a reload, a Show more, a refresh after a save) appends nothing.
  // Synced in an effect declared BEFORE the walk's, so the walk reads this render's window.
  const nextCursorRef = useRef(nextCursor);
  const entriesRef = useRef(entries);
  const failedRef = useRef(failed);
  useEffect(() => {
    nextCursorRef.current = nextCursor;
    entriesRef.current = entries;
    failedRef.current = failed;
  });

  // THE ANCHOR WALK (MOTIR-10463) — read the address fragment as an external store, so a later
  // hash change (a second verdict link on the same page) walks too.
  const hash = useSyncExternalStore(
    subscribeToHash,
    () => window.location.hash,
    /* v8 ignore next -- the server snapshot: a server render has no address hash. */
    () => '',
  );
  useEffect(() => {
    const recordId = agentVerdictRecordIdOfHash(hash);
    const startCursor = nextCursorRef.current;
    if (!recordId || failedRef.current || startCursor === null) return;
    if (entriesDrawAgentVerdict(entriesRef.current, recordId)) return;
    let cancelled = false;
    setLoadingMore(true);
    void walkToAgentVerdict({ recordId, cursor: startCursor, fetchPage }).then((reached) => {
      if (cancelled) return;
      setLoadingMore(false);
      if (!reached || nextCursorRef.current !== startCursor) return;
      setEntries((current) => [...current, ...reached.entries]);
      setTotalComments(reached.totalComments);
      setTotalChanges(reached.totalChanges);
      setNextCursor(reached.nextCursor);
      setWorkItemRefs((current) => ({ ...current, ...reached.workItemRefs }));
    });
    return () => {
      cancelled = true;
      setLoadingMore(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- walks once per address; the window is read through refs
  }, [hash]);

  // A field saved on this page recorded a revision (MOTIR-6101): re-read the
  // first page silently, so the merged feed shows it without a reload.
  const revision = useActivityRevision(workItemId);
  const seenRevision = useRef(revision);
  useEffect(() => {
    if (revision === seenRevision.current) return;
    seenRevision.current = revision;
    void fetchPage()
      .then((page) => {
        setEntries(page.entries);
        setTotalComments(page.totalComments);
        setTotalChanges(page.totalChanges);
        setNextCursor(page.nextCursor);
        setWorkItemRefs(page.workItemRefs ?? {});
        setFailed(false);
      })
      .catch(() => {
        // A failed refresh keeps the window it had; the next save retries.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchPage reads only workItemId
  }, [revision]);

  function reload() {
    setFailed(false);
    setLoading(true);
    void fetchPage()
      .then((page) => {
        setEntries(page.entries);
        setTotalComments(page.totalComments);
        setTotalChanges(page.totalChanges);
        setNextCursor(page.nextCursor);
        setWorkItemRefs(page.workItemRefs ?? {});
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }

  function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const scroller = document.scrollingElement;
    const prevHeight = scroller?.scrollHeight ?? 0;
    void fetchPage(nextCursor)
      .then((page) => {
        setEntries((current) => [...current, ...page.entries]);
        setTotalComments(page.totalComments);
        setTotalChanges(page.totalChanges);
        setNextCursor(page.nextCursor);
        setWorkItemRefs((current) => ({ ...current, ...(page.workItemRefs ?? {}) }));
        if (order === 'asc' && scroller) {
          requestAnimationFrame(() => {
            scroller.scrollTop += scroller.scrollHeight - prevHeight;
          });
        }
      })
      .catch(() => setFailed(true))
      .finally(() => setLoadingMore(false));
  }

  function patchThread(rootId: string, patch: (thread: CommentThreadDTO) => CommentThreadDTO) {
    setEntries((current) =>
      current.map((entry) =>
        entry.type === 'comment' && entry.thread.id === rootId
          ? { ...entry, thread: patch(entry.thread) }
          : entry,
      ),
    );
  }

  async function submitReply(rootId: string, bodyMd: string): Promise<string | null> {
    const res = await addCommentAction({ workItemId, bodyMd, parentCommentId: rootId });
    if (!res.ok) return res.error;
    patchThread(rootId, (thread) => ({ ...thread, replies: [...thread.replies, res.comment] }));
    setTotalComments((current) => current + 1);
    setReplyTarget(null);
    router.refresh();
    return null;
  }

  function handleEdited(updated: CommentDTO) {
    setEntries((current) =>
      current.map((entry) => {
        if (entry.type !== 'comment') return entry;
        if (entry.thread.id === updated.id)
          return { ...entry, thread: { ...entry.thread, ...updated } };
        if (entry.thread.id !== updated.parentCommentId) return entry;
        return {
          ...entry,
          thread: {
            ...entry.thread,
            replies: entry.thread.replies.map((reply) =>
              reply.id === updated.id ? updated : reply,
            ),
          },
        };
      }),
    );
    router.refresh();
  }

  // A delete also APPENDS a comment_deleted revision the window can't
  // fabricate locally — reload the merged first page so it shows up once,
  // as history (the verified rule).
  function handleDeleted() {
    setReplyTarget(null);
    router.refresh();
    reload();
  }

  const loadedCount = entries.reduce(
    (sum, entry) => sum + (entry.type === 'comment' ? 1 + entry.thread.replies.length : 1),
    0,
  );
  const olderCount = Math.max(0, totalComments + totalChanges - loadedCount);
  const displayEntries = order === 'asc' ? [...entries].reverse() : entries;
  const empty = !failed && !loading && entries.length === 0 && totalComments + totalChanges === 0;

  const showMore =
    nextCursor && !failed ? (
      <button
        type="button"
        onClick={loadMore}
        disabled={loadingMore}
        className="border-(--el-border-strong) bg-(--el-surface-soft) text-(--el-text-secondary) hover:text-(--el-text) h-(--height-control) w-full rounded-(--radius-control) border border-dashed px-(--spacing-control-x) font-sans text-xs focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      >
        {t('showMoreActivity', { count: olderCount })}
      </button>
    ) : null;

  const olderEdgeSkeleton = loadingMore ? <ActivitySkeleton rows={2} /> : null;

  function commentEntry(thread: CommentThreadDTO): ReactNode {
    return (
      <>
        <CommentRow
          comment={thread}
          workItemRefs={workItemRefs}
          replyCount={thread.replies.length}
          canComment={canComment}
          canModerate={canModerate}
          currentUserId={currentUserId}
          mentionCandidates={mentionCandidates}
          onStartReply={(author) => setReplyTarget({ rootId: thread.id, author })}
          onEdited={handleEdited}
          onDeleted={handleDeleted}
        />
        {thread.replies.length > 0 || replyTarget?.rootId === thread.id ? (
          <div className="border-(--el-border-soft) mt-3 ml-[11px] flex flex-col gap-4 border-l-2 pl-3.5">
            {thread.replies.length > 0 ? (
              <ul aria-label={tc('repliesAria')} className="flex list-none flex-col gap-4">
                {thread.replies.map((reply) => (
                  <li key={reply.id}>
                    <CommentRow
                      comment={reply}
                      workItemRefs={workItemRefs}
                      canComment={canComment}
                      canModerate={canModerate}
                      currentUserId={currentUserId}
                      mentionCandidates={mentionCandidates}
                      onStartReply={(author) => setReplyTarget({ rootId: thread.id, author })}
                      onEdited={handleEdited}
                      onDeleted={handleDeleted}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
            {replyTarget?.rootId === thread.id ? (
              <CommentComposer
                key={`${thread.id}:${replyTarget.author.id}`}
                mode="reply"
                label={tc('replyLabel')}
                submitLabel={tc('reply')}
                initialValue={`[@${replyTarget.author.name}](mention:${replyTarget.author.id}) `}
                mentionCandidates={mentionCandidates}
                onSubmit={(bodyMd) => submitReply(thread.id, bodyMd)}
                onCancel={() => setReplyTarget(null)}
              />
            ) : null}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <ContentSectionCard
      title={tc('title')}
      subtitle={
        failed ? undefined : t('allGloss', { comments: totalComments, changes: totalChanges })
      }
      headerRight={headerControls}
    >
      {failed ? (
        <ErrorState title={t('errorAllTitle')} description={t('errorDescription')} retry={reload} />
      ) : loading ? (
        <ActivitySkeleton rows={3} />
      ) : empty ? (
        <div className="flex flex-col items-center gap-1.5 py-6">
          <History className="text-(--el-text-faint) h-[22px] w-[22px]" aria-hidden />
          <p className="text-(--el-text-secondary) font-sans text-sm">{t('emptyHistory')}</p>
        </div>
      ) : (
        <ul aria-label={t('allAria')} className="flex list-none flex-col gap-4">
          {/* The OLDER edge — top in oldest-first display (panel 4). */}
          {order === 'asc' ? (
            <>
              {showMore ? <li>{showMore}</li> : null}
              {olderEdgeSkeleton ? <li>{olderEdgeSkeleton}</li> : null}
            </>
          ) : null}
          {displayEntries.map((entry) =>
            entry.type === 'comment' ? (
              <li key={`c:${entry.thread.id}`}>{commentEntry(entry.thread)}</li>
            ) : (
              entry.entry.parts.map((part, partIndex) => (
                <li key={`h:${entry.entry.id}:${partIndex}`}>
                  <ActivityEntryRow
                    entry={entry.entry}
                    part={part}
                    statusCategories={statusCategories}
                  />
                </li>
              ))
            ),
          )}
          {/* The OLDER edge — bottom in newest-first display (panel 4). */}
          {order === 'desc' ? (
            <>
              {olderEdgeSkeleton ? <li>{olderEdgeSkeleton}</li> : null}
              {showMore ? <li>{showMore}</li> : null}
            </>
          ) : null}
        </ul>
      )}
    </ContentSectionCard>
  );
}

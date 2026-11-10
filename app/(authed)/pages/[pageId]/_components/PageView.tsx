'use client';

import { lazy, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { History, Info, MessageSquare, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { MentionCandidate } from '@/components/ui/MarkdownEditor';
import { useToast } from '@/components/ui/Toast';
import type { PageSaveStatus } from '@/components/pages/PageEditorHost';
import {
  PageArchivedBanner,
  type ArchivedPageInfo,
} from '@/components/pages/archive/PageArchivedBanner';
import type { RestorePageVersionResultDto } from '@/lib/dto/pages';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import { IssueQuickViewController } from '@/app/(authed)/items/_components/IssueQuickViewController';
import { cn } from '@/lib/utils/cn';
import { HistoryNotice, PageHistoryPanel } from './PageHistoryPanel';
import { LinkedWorkItemsStrip } from './LinkedWorkItemsStrip';
import { PageActionsMenu } from './PageActionsMenu';
import { PageDiscussionPanel } from './PageDiscussionPanel';
import { PageVersionRestore, type RestoreRefusal } from './PageVersionRestore';
import { PageVersionView } from './PageVersionView';

const RESTORE_NOTE_ID = 'page-restore-note';

// The page at its own address (Story MOTIR-5752 · MOTIR-7280), drawn by
// `design/pages/page.mock.html` states 6–10: the title, then the editor. The
// "← Pages" link sits ABOVE this view in `page.tsx`, outside the boundary,
// because it is static (state 11).
//
// ⚠️ THE EDITOR IS LOADED LAZILY, and that is what the route's in-page
// `<Suspense>` waits on. The page's server read is its GATE — it decides
// existence, so it must settle before anything streams or a missing page would
// 404 under a 200 (CLAUDE.md § A `loading.tsx` may NOT sit above a route that
// decides existence). What is left to wait for after the gate is the editor's own
// code (Tiptap, ProseMirror and Yjs), so that is what the frame covers.
const PageEditorHost = lazy(() => import('@/components/pages/PageEditorHost'));

/** What the view needs of the page — `PageDto`, minus what it does not draw. */
export interface PageViewPage {
  id: string;
  title: string;
  /** The stored Yjs state, base64. */
  bodyState: string;
  canEdit: boolean;
  /**
   * The archive state (Story MOTIR-5755 · MOTIR-7423): set for an archived page,
   * which renders read-only under the archived banner. `null` / omitted: live.
   */
  archived?: (Omit<ArchivedPageInfo, 'id' | 'title'> & { subPageCount: number }) | null;
  /** Its parent's title (the breadcrumb's last page), for the restored-elsewhere reason. */
  parentTitle?: string | null;
  /** `PageDto.projectId` — the one project the work-item picker searches (MOTIR-7574). */
  projectId?: string;
  /** `PageDto.workItemRefs` — the live data of every work item the body mentions. */
  workItemRefs?: WorkItemRefMap;
  /**
   * `work_item:edit` on the page's project (MOTIR-9200) — the Linked work items strip's
   * own capability. NOT `canEdit` (that is `page:edit`): it decides whether the strip
   * paints before its read answers, and the write re-checks the pair.
   */
  canLinkWorkItems?: boolean;
}

export interface PageViewProps {
  page: PageViewPage;
  /** The reader's user id, so their own versions read "You" in the history. */
  viewerId: string;
  /** The reader's display name — the discussion composer's avatar. */
  viewerName?: string;
  /**
   * The mention picker's roster for the discussion (MOTIR-10874) — the project's
   * members, handed only to a reader who holds `comment:add` on a live page.
   */
  mentionCandidates?: MentionCandidate[];
  /** Open threads on the page, read on the server, for the Discussion control's chip. */
  openThreadCount?: number;
  /** `PAGE_TITLE_MAX_LENGTH`, handed down so this client file imports no package. */
  titleMaxLength: number;
}

/** Quiet before a title edit is sent (the card: "after 800 ms of quiet"). */
export const TITLE_RENAME_QUIET_MS = 800;

/** The heading's size and place, shared by the field and the read-only `<h1>`. */
const TITLE_CLASS = 'block w-full font-serif text-2xl leading-8 font-semibold text-(--el-text)';

/** No roster: the reader holds no `comment:add` here, or the page is archived. */
const EMPTY_ROSTER: MentionCandidate[] = [];

type RenameError = { kind: 'tooLong'; limit: number } | { kind: 'failed' } | null;

export function PageView({
  page,
  viewerId,
  viewerName = '',
  mentionCandidates = EMPTY_ROSTER,
  openThreadCount = 0,
  titleMaxLength,
}: PageViewProps) {
  const t = useTranslations('pages');
  const rootRef = useRef<HTMLDivElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const discussionButtonRef = useRef<HTMLButtonElement>(null);

  // ── History (Story MOTIR-5754 · MOTIR-7387) ──────────────────────────────
  // The panel's open state, the version shown in compare, and the "version is
  // gone" notice live here, because the title row's control, the compare split
  // and the panel all read them. A page opens with history closed; `page.tsx`
  // keys this view by page id, so navigating to another page closes it.
  // A link to ONE VERSION — `?version=<n>`, which the decision port's *Open page* and
  // *Compare with current* use (MOTIR-7436) — opens with History open on that version's
  // compare view, because the live page may have moved past what was decided.
  const searchParams = useSearchParams();
  const linkedVersion = (() => {
    const raw = Number(searchParams?.get('version'));
    return Number.isInteger(raw) && raw > 0 ? raw : null;
  })();
  const [historyOpen, setHistoryOpen] = useState(linkedVersion !== null);
  const [selected, setSelected] = useState<number | null>(linkedVersion);
  const [goneNumber, setGoneNumber] = useState<number | null>(null);
  const [listKey, setListKey] = useState(0);

  // ── Restore (MOTIR-7388) ─────────────────────────────────────────────────
  // The live editor's state and its GENERATION, the host's `key`: a restore
  // adopts the server's resulting state and bumps the generation, so the editor
  // REMOUNTS on the restored document instead of carrying on with a stale one.
  // The save status is what holds Restore while edits are unsaved.
  const { toast } = useToast();
  const [bodyState, setBodyState] = useState(page.bodyState);
  const [generation, setGeneration] = useState(0);
  const [saveStatus, setSaveStatus] = useState<PageSaveStatus>('saved');
  const [restoring, setRestoring] = useState(false);
  const [refusal, setRefusal] = useState<{
    kind: Exclude<RestoreRefusal, 'gone'>;
    number: number;
  } | null>(null);
  /** The row a restore just added, tinted until the next press. */
  const [freshNumber, setFreshNumber] = useState<number | null>(null);

  // ── Discussion (Story MOTIR-10866 · MOTIR-10874) ─────────────────────────
  // The panel shares History's right-hand column, and only one of the two is
  // open at a time: opening either closes the other. The control's open count
  // is owned here, seeded by the server's read, so the panel's writes move it.
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const [openCount, setOpenCount] = useState(openThreadCount);

  /** History closed, with its compare and notices — focus is the caller's. */
  const resetHistory = useCallback(() => {
    setHistoryOpen(false);
    setSelected(null);
    setGoneNumber(null);
    setRefusal(null);
    setFreshNumber(null);
  }, []);

  const closeHistory = useCallback(() => {
    resetHistory();
    historyButtonRef.current?.focus();
  }, [resetHistory]);

  const closeDiscussion = useCallback(() => {
    setDiscussionOpen(false);
    discussionButtonRef.current?.focus();
  }, []);

  const toggleHistory = () => {
    if (historyOpen) {
      closeHistory();
      return;
    }
    setDiscussionOpen(false);
    setHistoryOpen(true);
  };

  const toggleDiscussion = () => {
    if (discussionOpen) {
      closeDiscussion();
      return;
    }
    resetHistory();
    setDiscussionOpen(true);
  };

  const select = useCallback((number: number | null) => {
    setGoneNumber(null);
    setRefusal(null);
    setFreshNumber(null);
    setSelected(number);
  }, []);

  // A version pruned between listing and opening: say so, and re-read the list.
  const onGone = useCallback((number: number) => {
    setSelected(null);
    setGoneNumber(number);
    setListKey((k) => k + 1);
  }, []);

  const onRestored = useCallback(
    (result: RestorePageVersionResultDto, from: number) => {
      setBodyState(result.bodyState);
      setGeneration((g) => g + 1);
      setSaveStatus('saved');
      setSelected(null);
      setRefusal(null);
      setFreshNumber(result.version.number);
      setListKey((k) => k + 1);
      toast({
        variant: 'success',
        title: t('history.restored', { from, number: result.version.number }),
      });
    },
    [t, toast],
  );

  const onRefused = useCallback(
    (kind: RestoreRefusal, number: number) => {
      if (kind === 'gone') onGone(number);
      else setRefusal({ kind, number });
    },
    [onGone],
  );

  // Esc closes the innermost layer first: compare, then the panel. A dialog
  // (the restore confirm) handles its own Esc, so a key pressed inside one is
  // left to it.
  useEffect(() => {
    if (!historyOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="dialog"], [role="alertdialog"]')) return;
      if (selected !== null) setSelected(null);
      else closeHistory();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [historyOpen, selected, closeHistory]);

  const comparing = historyOpen && selected !== null;
  const archived = page.archived ?? null;
  const shownTitle = page.title || t('untitled');
  // An archived page's versions can be read, not restored (MOTIR-7418 refuses a
  // version restore with PAGE_ARCHIVED, so the button is not drawn — `canEdit` is
  // false). A reader who could restore the page is told why, and what to do.
  const archivedHistoryNote =
    archived && (archived.canRestore || archived.canDelete) ? (
      <p
        id={RESTORE_NOTE_ID}
        className="flex items-start gap-1.5 px-(--spacing-card-padding) pt-3 text-[12.5px] text-(--el-text-secondary)"
      >
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        {t('archive.history.readOnly')}
      </p>
    ) : null;

  return (
    <div
      ref={rootRef}
      data-side-panel-open={historyOpen || discussionOpen || undefined}
      className="flex gap-6"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        {archived ? (
          <div className="mt-3">
            <PageArchivedBanner
              page={{ id: page.id, title: shownTitle, ...archived }}
              subPageCount={archived.subPageCount}
              parentTitle={page.parentTitle}
            />
          </div>
        ) : null}
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {page.canEdit ? (
              <EditableTitle
                pageId={page.id}
                initialTitle={page.title}
                maxLength={titleMaxLength}
                onEnter={() =>
                  rootRef.current
                    ?.querySelector<HTMLElement>('.motir-page-editor [contenteditable]')
                    ?.focus()
                }
              />
            ) : (
              <h1 className={`mt-3 ${TITLE_CLASS}`}>{page.title || t('untitled')}</h1>
            )}
          </div>
          <Button
            ref={discussionButtonRef}
            variant="secondary"
            size="sm"
            leftIcon={<MessageSquare className="h-4 w-4" />}
            aria-expanded={discussionOpen}
            aria-controls="page-discussion"
            aria-label={
              openCount > 0
                ? `${t('discussion.open')}, ${t('discussion.openCount', { count: openCount })}`
                : undefined
            }
            onClick={toggleDiscussion}
            className={cn(
              'mt-3 shrink-0',
              discussionOpen && 'border-(--el-border-strong) bg-(--el-surface)',
            )}
          >
            {t('discussion.open')}
            {openCount > 0 ? (
              <span
                aria-hidden
                data-testid="page-discussion-count"
                className="ml-0.5 inline-flex min-w-5 items-center justify-center rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x-4) text-[11.5px] font-semibold text-(--el-text-secondary) tabular-nums"
              >
                {openCount}
              </span>
            ) : null}
          </Button>
          <Button
            ref={historyButtonRef}
            variant="secondary"
            size="sm"
            leftIcon={<History className="h-4 w-4" />}
            aria-expanded={historyOpen}
            aria-controls="page-history"
            onClick={toggleHistory}
            className={cn(
              'mt-3 shrink-0',
              historyOpen && 'border-(--el-border-strong) bg-(--el-surface)',
            )}
          >
            {t('history.open')}
          </Button>
          {page.canEdit ? (
            <div className="mt-3 shrink-0">
              <PageActionsMenu
                page={{ id: page.id, title: shownTitle }}
                parentTitle={page.parentTitle}
              />
            </div>
          ) : null}
        </div>
        {/* The Linked work items strip (MOTIR-9200): a LIVE page's hand links, above the
            editor and — in compare mode — above both columns, never inside either. An
            archived page mounts none and reads nothing. */}
        {archived ? null : (
          <LinkedWorkItemsStrip
            pageId={page.id}
            projectId={page.projectId}
            canLink={page.canLinkWorkItems ?? false}
          />
        )}
        {/* ⚠️ The live editor stays MOUNTED while a version is compared: it sits
            in the same slot of the same element either way, so compare never
            unmounts it — unsaved edits, the caret and the save indicator survive.
            The version column is the only thing compare adds. */}
        <div
          role={comparing ? 'region' : undefined}
          aria-label={comparing ? t('history.compare.label', { number: selected }) : undefined}
          className={cn('mt-3', comparing && 'grid gap-4 lg:grid-cols-2')}
        >
          <div className={cn('min-w-0', comparing && 'flex flex-col gap-2')}>
            {comparing ? (
              <span className="text-[13.5px] font-semibold text-(--el-text)">
                {t('history.compare.current')}
              </span>
            ) : null}
            <PageEditorHost
              key={generation}
              pageId={page.id}
              bodyState={bodyState}
              canEdit={page.canEdit}
              onSaveStatusChange={setSaveStatus}
              projectId={page.projectId}
              workItemRefs={page.workItemRefs}
            />
          </div>
          {comparing ? (
            <PageVersionView
              key={selected}
              pageId={page.id}
              number={selected}
              projectId={page.projectId}
              viewerId={viewerId}
              onClose={() => select(null)}
              onGone={onGone}
              restoreSlot={
                page.canEdit
                  ? (version) =>
                      version.isCurrent ? null : (
                        <PageVersionRestore
                          pageId={page.id}
                          version={version}
                          held={saveStatus !== 'saved'}
                          refused={
                            refusal?.kind === 'tooLarge' && refusal.number === version.number
                          }
                          describedBy={RESTORE_NOTE_ID}
                          onBusyChange={setRestoring}
                          onRestored={onRestored}
                          onRefused={onRefused}
                        />
                      )
                  : undefined
              }
              notice={
                refusal !== null ? (
                  <div id={RESTORE_NOTE_ID} className="px-(--spacing-card-padding) pt-3">
                    <HistoryNotice>
                      {refusal.kind === 'tooLarge'
                        ? t('history.refusal.tooLarge', { number: refusal.number })
                        : t('history.refusal.failed', { number: refusal.number })}
                    </HistoryNotice>
                  </div>
                ) : archivedHistoryNote ? (
                  archivedHistoryNote
                ) : page.canEdit && saveStatus !== 'saved' ? (
                  <p
                    id={RESTORE_NOTE_ID}
                    className="flex items-start gap-1.5 px-(--spacing-card-padding) pt-3 text-[12.5px] text-(--el-text-secondary)"
                  >
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    {t('history.unsavedHold')}
                  </p>
                ) : null
              }
            />
          ) : null}
        </div>
      </div>
      {historyOpen ? (
        <PageHistoryPanel
          pageId={page.id}
          viewerId={viewerId}
          selected={selected}
          onSelect={select}
          onClose={closeHistory}
          refreshKey={listKey}
          busy={restoring}
          freshNumber={freshNumber}
          notice={
            goneNumber !== null ? (
              <HistoryNotice>{t('history.refusal.gone', { number: goneNumber })}</HistoryNotice>
            ) : null
          }
        />
      ) : null}
      {discussionOpen ? (
        <PageDiscussionPanel
          pageId={page.id}
          archived={archived !== null}
          currentUserId={viewerId}
          currentUserName={viewerName}
          mentionCandidates={archived ? EMPTY_ROSTER : mentionCandidates}
          onClose={closeDiscussion}
          onOpenCountChange={setOpenCount}
        />
      ) : null}
      {/* A chip's click opens the item's quick-view peek (`?peek=<key>`), as it
          does on a description (MOTIR-7574) — the same controller /items, the
          board and the approvals room mount. */}
      <IssueQuickViewController />
    </div>
  );
}

function EditableTitle({
  pageId,
  initialTitle,
  maxLength,
  onEnter,
}: {
  pageId: string;
  initialTitle: string;
  maxLength: number;
  onEnter: () => void;
}) {
  const t = useTranslations('pages');
  const [title, setTitle] = useState(initialTitle);
  const [error, setError] = useState<RenameError>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** The title last sent (or loaded), so nothing is sent twice; null after a failure. */
  const sentRef = useRef<string | null>(initialTitle);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Stamps each rename so an older response never overwrites a newer one's verdict. */
  const seqRef = useRef(0);

  // A fresh page asks for its title first (state 6): focus lands in the field.
  useEffect(() => {
    if (initialTitle === '') inputRef.current?.focus();
    // Mount only: a later empty title is the writer's, not an arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const send = useCallback(
    async (next: string) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (next === sentRef.current) return;
      sentRef.current = next;
      const seq = ++seqRef.current;
      try {
        const res = await fetch(`/api/pages/${encodeURIComponent(pageId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: next }),
        });
        if (seq !== seqRef.current) return;
        if (res.ok) {
          setError(null);
          document.title = next || t('untitled');
          return;
        }
        // Not saved: let the next edit or blur try again.
        sentRef.current = null;
        if (res.status === 422) {
          const body = (await res.json().catch(() => ({}))) as { limit?: unknown };
          setError({
            kind: 'tooLong',
            limit: typeof body.limit === 'number' ? body.limit : maxLength,
          });
        } else {
          setError({ kind: 'failed' });
        }
      } catch {
        if (seq !== seqRef.current) return;
        sentRef.current = null;
        setError({ kind: 'failed' });
      }
    },
    [pageId, maxLength, t],
  );

  const onChange = (next: string) => {
    setTitle(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void send(next), TITLE_RENAME_QUIET_MS);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onEnter();
  };

  const errorId = `page-title-error-${pageId}`;
  return (
    <div className="mt-3">
      <input
        ref={inputRef}
        type="text"
        value={title}
        maxLength={maxLength}
        placeholder={t('untitled')}
        aria-label={t('page.titleLabel')}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => void send(title)}
        onKeyDown={onKeyDown}
        className={`${TITLE_CLASS} border-0 bg-transparent outline-none placeholder:text-(--el-text-muted)`}
      />
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-sm text-(--el-danger-on-surface)">
          {error.kind === 'tooLong'
            ? t('page.titleTooLong', { limit: error.limit })
            : t('page.renameFailed')}
        </p>
      ) : null}
    </div>
  );
}

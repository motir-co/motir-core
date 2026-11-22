'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { AtSign, Link2, NotebookText, Plus, Rows3, Tag, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { cn } from '@/lib/utils/cn';
import type {
  PageLinkSourceDto,
  WorkItemPageLinkRowDto,
  WorkItemPagesDto,
} from '@/lib/dto/pageLinks';
import type { PageMentionCandidateDto } from '@/lib/dto/pages';
import { fetchWorkItemPages, unlinkPageFromWorkItem } from '@/lib/workItems/pageLinksClient';
import { ContentSectionCard } from './ContentSectionCard';
import { PAGES_SECTION_ID } from './decisionAnchor';
import { LinkPageForm } from './LinkPageForm';
import { Place } from './PagePlace';
import { useRelativeTime } from '@/lib/hooks/useRelativeTime';

// THE PAGES SECTION on the work item page (Story MOTIR-7565 · MOTIR-7575), per
// `design/work-items/item--pages-section.mock.html` + design-notes § *The Pages
// section* (MOTIR-7569): which pages point at this work item, one row per page.
//
// WHERE: tier 3, the lower late half, first — between Plans and Attachments. It
// is mounted inside `LateLowerSections`, so it arrives with the late stack's one
// settle, and ONLY for a reader holding `page:view` who is not a Visitor: a
// withheld reader gets no section, no skeleton and no read (panel 6). The gate is
// the caller's; this component never asks.
//
// A CLIENT ISLAND because it owns its rows: it reads the first page on mount from
// `GET /api/work-items/<id>/pages` and Show more pages appends the next cursor's.
// Nothing another mutation on this page changes is read here (a page's links are
// written from the page), so no refetch tick is owed.
//
// THE ROW is `RelationshipsPanel`'s `LinkRow` grammar: an `li` holding the page's
// link, controls OUTSIDE the link (the Unlink slot MOTIR-7567 will fill renders
// nothing here and holds no space). The PLACE is `PageBreadcrumb`'s vocabulary as
// a LABEL — the whole row is a link and a link cannot nest in a link.
//
// THE LINK PAGE DOOR (Story MOTIR-7567 · MOTIR-9199) sits in the header slot for a
// reader holding `work_item:edit` and opens `LinkPageForm` INLINE at the top of the
// body. Unlink sits in the control slot the row reserves, on a hand link only.
// Rows are mutated LOCALLY after a write — a re-read would discard the pages the
// reader loaded with Show more — and the just-linked page is pinned at the top,
// drawn from the picker's candidate, until the next full read.
//
// A row's availability is the READ's `state` and nothing else: `live` renders the
// shipped link body, any other value (including one a later server adds) renders
// the unavailable arm — never an anchor, never a relative time, still an Unlink.

export interface PagesSectionProps {
  /** The item's id — the Pages route is keyed on it. */
  workItemId: string;
  /** The `PROD-N` key, for the list's accessible name. */
  identifier: string;
  /** The item's project — the Link page picker searches its live pages. */
  projectId: string;
  /** `work_item:edit`: the Link page door and Unlink follow it; absent, not disabled. */
  canEditWorkItem: boolean;
  /** Drawn beside the Link page door at the header's far end, when a caller supplies one. */
  headerAction?: ReactNode;
}

/** The sources in the design's fixed order: Mentioned, Embedded, Linked, then
 *  the work item's own tags (MOTIR-7696). */
const SOURCE_ORDER: readonly PageLinkSourceDto[] = [
  'mention',
  'embed',
  'manual',
  'description',
  'explanation',
];

type IssueViewsT = ReturnType<typeof useTranslations<'issueViews'>>;

/** A source's label and glyph — TOTAL over the closed union; a fourth source
 *  turns the `never` red. */
export function sourceChip(
  source: PageLinkSourceDto,
  t: IssueViewsT,
): { label: string; Icon: LucideIcon } {
  switch (source) {
    case 'mention':
      return { label: t('pagesSourceMention'), Icon: AtSign };
    case 'embed':
      return { label: t('pagesSourceEmbed'), Icon: Rows3 };
    case 'manual':
      return { label: t('pagesSourceManual'), Icon: Link2 };
    case 'description':
      return { label: t('pagesSourceDescription'), Icon: Tag };
    case 'explanation':
      return { label: t('pagesSourceExplanation'), Icon: Tag };
    /* v8 ignore next 4 -- the compile-time exhaustiveness arm; the union is closed */
    default: {
      const unreachable: never = source;
      return unreachable;
    }
  }
}

function SourceChips({ sources }: { sources: PageLinkSourceDto[] }) {
  const t = useTranslations('issueViews');
  return (
    <>
      {SOURCE_ORDER.filter((source) => sources.includes(source)).map((source) => {
        const { label, Icon } = sourceChip(source, t);
        return (
          <Pill key={source} tone="neutral">
            <Icon className="h-3 w-3 shrink-0" aria-hidden />
            {label}
          </Pill>
        );
      })}
    </>
  );
}

const ROW_BODY_CLASS =
  'group flex min-w-0 flex-1 items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y)';

function PageRow({ row }: { row: WorkItemPageLinkRowDto }) {
  const t = useTranslations('issueViews');
  const tPages = useTranslations('pages');
  const format = useFormatter();
  const relativeTime = useRelativeTime();
  const updated = new Date(row.updatedAt);
  // The read's flag is the only input: anything but `live` is the unavailable arm.
  const live = row.state === 'live';
  const inner = (
    <>
      <NotebookText
        className="mt-0.5 h-4 w-4 shrink-0 self-start text-(--el-icon-muted)"
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            'truncate text-sm',
            live && 'group-hover:underline',
            row.title
              ? live
                ? 'text-(--el-text)'
                : 'text-(--el-text-secondary)'
              : 'text-(--el-text-secondary) italic',
          )}
        >
          {row.title || tPages('untitled')}
        </span>
        <Place place={row.place} />
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <SourceChips sources={row.sources} />
        {live ? (
          <time
            dateTime={row.updatedAt}
            title={format.dateTime(updated, { dateStyle: 'medium', timeStyle: 'short' })}
            className="min-w-[5.5rem] text-right text-xs whitespace-nowrap text-(--el-text-secondary)"
          >
            {relativeTime(updated)}
          </time>
        ) : (
          <span className="min-w-[5.5rem] text-right text-xs whitespace-nowrap text-(--el-text-secondary)">
            {t('pagesUnavailable')}
          </span>
        )}
      </span>
    </>
  );
  return live ? (
    <Link
      href={`/pages/${encodeURIComponent(row.pageId)}`}
      className={cn(
        ROW_BODY_CLASS,
        'focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
      )}
    >
      {inner}
    </Link>
  ) : (
    <div data-testid="pages-row-unavailable" className={ROW_BODY_CLASS}>
      {inner}
    </div>
  );
}

/** Unlink — the quiet control in the row's reserved slot. A hand link only. */
function UnlinkControl({
  title,
  busy,
  onUnlink,
}: {
  title: string;
  busy: boolean;
  onUnlink: () => void;
}) {
  const t = useTranslations('issueViews');
  return (
    <button
      type="button"
      onClick={onUnlink}
      disabled={busy}
      aria-busy={busy}
      aria-label={title ? t('pagesUnlinkAria', { title }) : t('pagesUnlinkUnavailableAria')}
      className="shrink-0 rounded-(--radius-control) px-(--spacing-control-x-6) py-(--spacing-control-y-4) font-sans text-xs text-(--el-text-secondary) hover:text-(--el-text) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
    >
      {t('pagesUnlink')}
    </button>
  );
}

/** The initial read's pulse — `SectionCardSkeleton`'s two-bar body. */
function FirstReadSkeleton() {
  return (
    <div
      aria-busy="true"
      data-testid="pages-section-loading"
      className="flex animate-pulse flex-col gap-2"
    >
      <span className="block h-3 w-2/3 rounded-(--radius-control) bg-(--el-muted)" />
      <span className="block h-3 w-1/2 rounded-(--radius-control) bg-(--el-muted)" />
    </div>
  );
}

/** Show more pages' pending rows — row-shaped, after the rows already shown. */
function MoreSkeleton() {
  return (
    <div
      aria-busy="true"
      data-testid="pages-section-loading-more"
      className="mt-3 flex animate-pulse flex-col gap-3.5"
    >
      {[
        ['w-[55%]', 'w-[35%]'],
        ['w-[66%]', 'w-1/2'],
      ].map(([first, second]) => (
        <div key={first} className="flex items-center gap-3">
          <span className="h-4 w-4 shrink-0 rounded-(--radius-control) bg-(--el-muted)" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span className={cn('block h-2.5 rounded-(--radius-control) bg-(--el-muted)', first)} />
            <span
              className={cn('block h-2.5 rounded-(--radius-control) bg-(--el-muted)', second)}
            />
          </span>
        </div>
      ))}
    </div>
  );
}

type FirstRead = 'loading' | 'failed' | 'loaded';

/** The hand-made source, removed from a row's sources (a row left with none leaves the list). */
function withoutManual(rows: WorkItemPageLinkRowDto[], pageId: string): WorkItemPageLinkRowDto[] {
  return rows.flatMap((row) => {
    if (row.pageId !== pageId) return [row];
    const sources = row.sources.filter((source) => source !== 'manual');
    return sources.length === 0 ? [] : [{ ...row, sources }];
  });
}

export function PagesSection({
  workItemId,
  identifier,
  projectId,
  canEditWorkItem,
  headerAction,
}: PagesSectionProps) {
  const t = useTranslations('issueViews');
  const tCommon = useTranslations('common');
  const tPages = useTranslations('pages');

  const [rows, setRows] = useState<WorkItemPageLinkRowDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [firstRead, setFirstRead] = useState<FirstRead>('loading');
  const [retrying, setRetrying] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // The cursor whose page failed to load, so Try again re-reads exactly it.
  const [failedCursor, setFailedCursor] = useState<string | null>(null);
  // The Link page form, the just-linked pin, and the unlink outcomes.
  const [formOpen, setFormOpen] = useState(false);
  const [formWriting, setFormWriting] = useState(false);
  const [pinned, setPinned] = useState<PageMentionCandidateDto | null>(null);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const [unlinkFailed, setUnlinkFailed] = useState<string | null>(null);
  const [unlinkedLive, setUnlinkedLive] = useState<string | null>(null);
  const doorRef = useRef<HTMLButtonElement>(null);
  // Set when the form closes; the effect below spends it once the door has re-rendered.
  const restoreDoorFocus = useRef(false);
  // Sequence guard: a response that is no longer the latest request's never
  // clobbers newer state (CLAUDE.md § the app side).
  const seq = useRef(0);

  const readFirst = useCallback(() => {
    const mine = ++seq.current;
    return fetchWorkItemPages(workItemId, null)
      .then((page: WorkItemPagesDto) => {
        if (mine !== seq.current) return;
        setRows(page.rows);
        setNextCursor(page.nextCursor);
        // The next full read ends the pin: the read's own order is the truth again.
        setPinned(null);
        setFirstRead('loaded');
      })
      .catch(() => {
        if (mine === seq.current) setFirstRead('failed');
      });
  }, [workItemId]);

  useEffect(() => {
    void readFirst();
  }, [readFirst]);

  // `/items/<KEY>#pages`: the section streams in after the browser has looked for
  // the fragment, so it lands itself once, when it mounts.
  useEffect(() => {
    if (window.location.hash !== `#${PAGES_SECTION_ID}`) return;
    const el = document.getElementById(PAGES_SECTION_ID);
    el?.scrollIntoView({ block: 'start' });
    el?.focus({ preventScroll: true });
  }, []);

  function retryFirstRead() {
    setRetrying(true);
    void readFirst().finally(() => setRetrying(false));
  }

  function loadMore(cursor: string) {
    const mine = ++seq.current;
    setLoadingMore(true);
    setFailedCursor(null);
    void fetchWorkItemPages(workItemId, cursor)
      .then((page) => {
        if (mine !== seq.current) return;
        setRows((current) => {
          const seen = new Set(current.map((row) => row.pageId));
          return [...current, ...page.rows.filter((row) => !seen.has(row.pageId))];
        });
        setNextCursor(page.nextCursor);
      })
      .catch(() => {
        if (mine === seq.current) setFailedCursor(cursor);
      })
      .finally(() => {
        if (mine === seq.current) setLoadingMore(false);
      });
  }

  function closeForm() {
    setFormOpen(false);
    setFormWriting(false);
    // Focus returns to the door once it has re-rendered as "Link page" and is
    // enabled again — an effect, not a frame callback, because a frame can fire
    // before that commit and focus a button that is still disabled.
    restoreDoorFocus.current = true;
  }

  useEffect(() => {
    if (formOpen || !restoreDoorFocus.current) return;
    restoreDoorFocus.current = false;
    doorRef.current?.focus();
  }, [formOpen]);

  function onLinked(page: PageMentionCandidateDto) {
    // Local mutation only: the loaded pages and the cursor survive, and the
    // page's paged row (if loaded) is suppressed by id wherever it sits.
    setPinned(page);
    setUnlinkFailed(null);
    closeForm();
  }

  function unlink(pageId: string, title: string) {
    setUnlinking(pageId);
    setUnlinkFailed(null);
    setUnlinkedLive(null);
    const settle = () => {
      setRows((current) => withoutManual(current, pageId));
      setPinned((current) => (current?.id === pageId ? null : current));
      setUnlinkedLive(t('pagesUnlinkLive', { title: title || tPages('untitled') }));
    };
    unlinkPageFromWorkItem(workItemId, pageId)
      .then((result) => {
        if (
          result.ok ||
          // Another writer's removal: the requested end state already holds.
          (!result.ok &&
            (result.code === 'PAGE_LINK_NOT_FOUND' || result.code === 'PAGE_NOT_FOUND'))
        ) {
          settle();
        } else {
          setUnlinkFailed(pageId);
        }
      })
      .catch(() => setUnlinkFailed(pageId))
      .finally(() => setUnlinking((current) => (current === pageId ? null : current)));
  }

  const door = canEditWorkItem ? (
    <button
      ref={doorRef}
      type="button"
      disabled={formOpen && formWriting}
      onClick={() => (formOpen ? closeForm() : setFormOpen(true))}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x-6) py-(--spacing-control-y-4) font-sans text-sm font-semibold whitespace-nowrap hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60',
        formOpen ? 'text-(--el-text-secondary)' : 'text-(--el-link)',
      )}
    >
      {formOpen ? null : <Plus className="h-4 w-4" aria-hidden />}
      {formOpen ? t('pagesLinkCancel') : t('pagesLinkDoor')}
    </button>
  ) : null;
  const headerRight =
    door !== null || headerAction ? (
      <span className="inline-flex items-center gap-2">
        {door}
        {headerAction}
      </span>
    ) : undefined;

  const drawn = pinned === null ? rows : rows.filter((row) => row.pageId !== pinned.id);

  function rowItem(row: WorkItemPageLinkRowDto, index: number) {
    const hand = row.sources.includes('manual');
    return (
      <li
        key={row.pageId}
        className={cn(
          'rounded-(--radius-control) pr-(--spacing-control-x-4) hover:bg-(--el-surface)',
          index > 0 && 'border-t border-(--el-border-soft)',
        )}
      >
        <div className="flex items-center gap-1">
          <PageRow row={row} />
          {canEditWorkItem && hand ? (
            <UnlinkControl
              title={row.title}
              busy={unlinking === row.pageId}
              onUnlink={() => unlink(row.pageId, row.title)}
            />
          ) : null}
        </div>
        {unlinkFailed === row.pageId ? (
          <div
            role="status"
            className="flex flex-wrap items-center gap-3 px-(--spacing-control-x) pb-2"
          >
            <span className="text-[13px] text-(--el-text-secondary)">{t('pagesUnlinkFailed')}</span>
            <Button variant="secondary" size="sm" onClick={() => unlink(row.pageId, row.title)}>
              {tCommon('retry')}
            </Button>
          </div>
        ) : null}
      </li>
    );
  }

  const pinnedBlock =
    pinned === null ? null : (
      <div
        data-testid="pages-pinned"
        className="mb-2 flex items-center gap-2 rounded-(--radius-control) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y)"
      >
        <NotebookText
          className="mt-0.5 h-4 w-4 shrink-0 self-start text-(--el-icon-muted)"
          aria-hidden
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-(--el-text)">
            {pinned.title || tPages('untitled')}
          </span>
          <Place place={pinned.place} />
        </span>
        <Pill tone="neutral">{t('pagesJustLinked')}</Pill>
        <SourceChips sources={['manual']} />
        {canEditWorkItem ? (
          <UnlinkControl
            title={pinned.title}
            busy={unlinking === pinned.id}
            onUnlink={() => unlink(pinned.id, pinned.title)}
          />
        ) : null}
      </div>
    );

  let body: ReactNode;
  if (firstRead === 'loading') {
    body = <FirstReadSkeleton />;
  } else if (firstRead === 'failed') {
    // Panel 5: a flush line, NOT the `ErrorState` card (a card in the section
    // card). The section stays — hiding it would claim no page links here.
    body = (
      <div role="status" className="flex flex-wrap items-center gap-3">
        <span className="text-[13px] text-(--el-text-secondary)">{t('pagesError')}</span>
        <Button variant="secondary" size="sm" loading={retrying} onClick={retryFirstRead}>
          {tCommon('retry')}
        </Button>
      </div>
    );
  } else if (drawn.length === 0 && pinned === null) {
    // Panel 3: the section STAYS when empty, unlike Plans — "no" is an answer. It
    // means nothing links here at all (an unavailable link is a row, not nothing).
    body = <p className="m-0 text-sm text-(--el-text-secondary) italic">{t('pagesEmpty')}</p>;
  } else {
    body = (
      <>
        {pinnedBlock}
        {drawn.length > 0 ? (
          <ul
            aria-label={t('pagesListAria', { key: identifier })}
            className="-mx-(--spacing-control-x) my-0 flex list-none flex-col p-0"
          >
            {drawn.map(rowItem)}
          </ul>
        ) : null}
        {drawn.some((row) => !row.sources.includes('manual')) ? (
          <p className="mt-3 mb-0 text-xs text-(--el-text-secondary)">
            {t('pagesDerivedOnlyGloss')}
          </p>
        ) : null}
        {loadingMore ? <MoreSkeleton /> : null}
        {failedCursor !== null ? (
          <div
            role="status"
            className="mt-3 flex flex-wrap items-center gap-3 border-t border-(--el-border-soft) pt-3"
          >
            <span className="text-[13px] text-(--el-text-secondary)">
              {t('pagesLoadMoreError')}
            </span>
            <Button variant="secondary" size="sm" onClick={() => loadMore(failedCursor)}>
              {tCommon('retry')}
            </Button>
          </div>
        ) : nextCursor ? (
          <button
            type="button"
            onClick={() => loadMore(nextCursor)}
            disabled={loadingMore}
            className="mt-3 h-(--height-control) w-full rounded-(--radius-control) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) px-(--spacing-control-x) font-sans text-xs text-(--el-text-secondary) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('pagesShowMore')}
          </button>
        ) : null}
      </>
    );
  }

  return (
    <ContentSectionCard
      id={PAGES_SECTION_ID}
      title={t('pagesTitle')}
      subtitle={t('pagesGloss')}
      headerRight={headerRight}
    >
      {canEditWorkItem && formOpen ? (
        <LinkPageForm
          projectId={projectId}
          workItemId={workItemId}
          onLinked={onLinked}
          onClose={closeForm}
          onWritingChange={setFormWriting}
        />
      ) : null}
      {body}
      {unlinkedLive ? (
        <div role="status" className="sr-only">
          {unlinkedLive}
        </div>
      ) : null}
    </ContentSectionCard>
  );
}

import { cache, Suspense } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { memberPageContext, pageMembers, pageScope } from '@/lib/pages/projectPageContext';
import { pageCommentsService } from '@/lib/services/pageCommentsService';
import { pagesService } from '@/lib/services/pagesService';
import {
  PAGE_COMMENT_THREADS_MAX_LIMIT,
  PAGE_TITLE_MAX_LENGTH,
  PageNotFoundError,
  type PageCommentDto,
} from '@/lib/pages';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { PageDto, PageTrailDto, PageTreeLevelDto } from '@/lib/dto/pages';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { PageSkeleton } from '@/components/ui/PageSkeleton';
import { PageTree } from '@/components/pages/tree/PageTree';
import { parentOf } from '@/components/pages/tree/pageTreeRow';
import { PageBreadcrumb } from '@/components/pages/tree/PageBreadcrumb';
import { PageSidebarLayout } from '@/components/pages/tree/PageSidebarLayout';
import { PageView } from './_components/PageView';

// The page at its own address, `/pages/<id>` (Story MOTIR-5752 · MOTIR-7280),
// drawn by `design/pages/page.mock.html` states 6–12.
//
// ── THE GATE IS THE READ ──────────────────────────────────────────────────
// `memberPageContext()` resolves the reader and their ACTIVE project, then
// `pagesService.getPage` decides everything else in one transaction: whether
// the reader may browse the project (`page:view`), whether the page exists, and
// whether it lives in THIS project. Each refusal — `ProjectAccessDeniedError`
// (either kind), `PageNotFoundError` (an unknown id AND an id from another
// project), `ProjectNotFoundError` — calls `notFound()`, so the three cases the
// card names render the same screen under the same 404: the shared
// `app/(authed)/not-found.tsx`, unchanged (design-notes § State 12 — a
// page-specific message would itself be the leak, so no `not-found.tsx` is
// added under `pages/`). A page id from another project is never a silent
// project switch.
//
// ── THE FRAME IS AN IN-PAGE <Suspense>, AFTER THE GATE ────────────────────
// No `loading.tsx` above this route (it decides existence). The read settles the
// status first; the boundary below then covers the editor's code arriving
// (`PageView` loads it lazily). The breadcrumb is read with the gate, so it
// paints above the boundary; the frame draws the generic header pair and
// paragraph bars, and NO toolbar block — whether there is a toolbar is
// `canEdit`'s answer (state 11).
//
// ── THE PAGE'S PLACE (Story MOTIR-5753 · MOTIR-7375) ──────────────────────
// `design/pages/page--tree-sidebar.mock.html`: the breadcrumb (Pages › folders
// › parent pages › this page) replaces "← Pages", and a sidebar `PageTree`
// shows this page selected with its path open. Both come from
// `pagesService.getPageTrail`, read ALONGSIDE the gate's read (a trail for a
// page the gate refuses is never used) and on every request — so after a move,
// reopening the page shows the new trail in both. A trail that cannot be read
// is not a failure of the page: the breadcrumb falls back to Pages › page and
// the tree opens at its root. The sidebar's levels — the root and each level
// on the path — are read on the server behind their OWN in-page <Suspense>,
// also after the gate, so the path paints open with the page selected and the
// page itself never waits on them. A page that 404s renders neither (base
// state 12); the sidebar is navigation only, the same for every reader.
//
// ── AN ARCHIVED PAGE (Story MOTIR-5755 · MOTIR-7423) ──────────────────────
// It still opens here (design MOTIR-7416, surface 5): the read is the same, and
// `PageView` draws the archived banner and mounts the editor read-only
// (`canEdit` is false for an archived page). Its breadcrumb is the trail it was
// archived from — where a restore puts it back — and its sidebar is the live
// tree, which does not hold it.

type Params = { params: Promise<{ pageId: string }> };

/** The signed-in member's scope on their active project, resolved once per request. */
const loadContext = cache(memberPageContext);
const loadScope = cache(async () => pageScope(await loadContext()));

/** Read the page as the signed-in member, or `null` for every not-found case. */
const loadPage = cache(
  async (pageId: string): Promise<{ page: PageDto; viewerId: string } | null> => {
    const scope = await loadScope();
    try {
      const page = await pagesService.getPage(scope.service, {
        projectId: scope.projectId,
        pageId,
      });
      return { page, viewerId: scope.userId };
    } catch (err) {
      // ⚠️ BOTH kinds of `ProjectAccessDeniedError` are a not-found here (MOTIR-7281).
      // `getPage` asserts `page:view`, and a reader who may BROWSE the project but
      // does not hold it — a workspace custom role, which holds `page:view` only
      // when an admin ticks it — is refused with kind 'edit'. Rethrowing that sent
      // them to the error boundary, while `/pages` answers the same reader with its
      // `notFound()`. The page they cannot read is one they cannot see.
      if (
        err instanceof ProjectAccessDeniedError ||
        err instanceof PageNotFoundError ||
        err instanceof ProjectNotFoundError
      ) {
        return null;
      }
      throw err;
    }
  },
);

/** The page's trail, or `null` when it cannot be read (the breadcrumb then reads Pages › page). */
async function loadTrail(pageId: string): Promise<PageTrailDto | null> {
  const scope = await loadScope();
  try {
    return await pagesService.getPageTrail(scope.service, { projectId: scope.projectId, pageId });
  } catch (err) {
    // A refusal is the gate's to report; anything else costs the trail, not the page.
    if (
      !(
        err instanceof ProjectAccessDeniedError ||
        err instanceof PageNotFoundError ||
        err instanceof ProjectNotFoundError
      )
    ) {
      console.error('[pages] the page trail could not be read', err);
    }
    return null;
  }
}

/**
 * How many sub-pages left with an archived root — `0` when the count cannot be
 * read, which costs the banner one sentence, not the page.
 */
async function loadSubPageCount(pageId: string): Promise<number> {
  const scope = await loadScope();
  try {
    const set = await pagesService.describeArchiveSet(scope.service, {
      projectId: scope.projectId,
      pageId,
    });
    return set.subPageCount;
  } catch (err) {
    console.error('[pages] the archive set could not be read', err);
    return 0;
  }
}

/** The open threads' read: the Discussion chip's count and the anchored roots. */
interface InlineThreadsRead {
  openCount: number;
  /** Every OPEN root carrying an anchor, without its replies — the Passage wash's input. */
  inlineThreads: PageCommentDto[];
}

/**
 * The page's OPEN threads, read on the server (MOTIR-10874 · MOTIR-10899): the
 * count for the Discussion control's chip, and every anchored root for the
 * Passage wash, so a passage is washed on load without the panel being opened.
 * The list is followed to the end of its cursor — a highlight must not be missing
 * because its thread fell past the first page. A failed read costs the chip and
 * the washes, never the page. The panel reads its own lists when it opens.
 */
async function loadInlineThreads(pageId: string): Promise<InlineThreadsRead> {
  const scope = await loadScope();
  try {
    let openCount = 0;
    const inlineThreads: PageCommentDto[] = [];
    let cursor: string | undefined;
    do {
      const read = await pageCommentsService.listPageThreads(scope.service, {
        projectId: scope.projectId,
        pageId,
        status: 'open',
        cursor,
        limit: PAGE_COMMENT_THREADS_MAX_LIMIT,
      });
      openCount = read.counts.open;
      for (const thread of read.threads) {
        if (thread.anchor === null) continue;
        const { replies: _replies, ...root } = thread;
        inlineThreads.push(root);
      }
      cursor = read.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return { openCount, inlineThreads };
  } catch (err) {
    console.error('[pages] the open discussion could not be read', err);
    return { openCount: 0, inlineThreads: [] };
  }
}

/**
 * The discussion's mention roster (MOTIR-10874): the project's members as the
 * item page's composer takes them — and only for a reader who holds
 * `comment:add` on a LIVE page. Anyone else is handed none, so no roster of
 * people crosses the wire for a control they do not have (MOTIR-6646). A roster
 * that cannot be read costs the picker, not the page.
 */
async function loadMentionRoster(
  canComment: boolean,
): Promise<{ id: string; name: string; email: string }[]> {
  if (!canComment) return [];
  try {
    const members = await pageMembers(await loadScope());
    return members.map((m) => ({ id: m.userId, name: m.name, email: m.email }));
  } catch (err) {
    console.error('[pages] the mention roster could not be read', err);
    return [];
  }
}

/** The rows open on arrival, root-first: the trail's folders, then its pages. */
function expandedPathOf(trail: PageTrailDto | null): string[] {
  if (!trail) return [];
  return [...trail.folders.map((f) => `folder:${f.id}`), ...trail.pages.map((p) => `page:${p.id}`)];
}

/** The browser tab reads the page's title, or the untitled copy. */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { pageId } = await params;
  const loaded = await loadPage(pageId);
  if (!loaded) return {};
  const { page } = loaded;
  const t = await getTranslations('pages');
  return { title: page.title || t('untitled') };
}

export default async function PageAtItsAddress({ params }: Params) {
  const { pageId } = await params;
  // Both reads are SETTLED before either outcome is acted on, so a failed page
  // read never leaves the trail's read running behind the error boundary.
  const [read, trail] = await Promise.all([
    loadPage(pageId).then(
      (loaded) => ({ loaded }),
      (error: unknown) => ({ error }),
    ),
    loadTrail(pageId),
  ]);
  if ('error' in read) throw read.error;
  if (!read.loaded) notFound();
  const { page, viewerId } = read.loaded;
  // `work_item:edit`, for the Linked work items strip (MOTIR-9200): its own value, so
  // the strip can paint before its read answers. `page.canEdit` is `page:edit`. The
  // scope, the context and the reader's permissions settle in ONE wave — both
  // loaders are request-cached, so the context is read once (MOTIR-3449).
  const [scope, context, held] = await Promise.all([
    loadScope(),
    loadContext(),
    loadContext().then((c) => c.permissions()),
  ]);
  const canLinkWorkItems = page.archivedAt === null && held.has('work_item:edit');
  // An archived ROOT's banner says how many sub-pages left with it (MOTIR-7423);
  // read after the gate, and only for that case. A sub-page's banner names its
  // root instead, and a live page needs no count until someone asks to archive it.
  const archivedRoot =
    page.archivedAt !== null && (page.archiveRoot === null || page.archiveRoot.id === page.id);
  // `comment:add` on a LIVE page: the roster, and the editor's Selection action (MOTIR-10900).
  const mayComment = page.archivedAt === null && held.has('comment:add');
  const [subPageCount, openThreads, mentionCandidates] = await Promise.all([
    archivedRoot ? loadSubPageCount(page.id) : 0,
    loadInlineThreads(page.id),
    loadMentionRoster(mayComment),
  ]);

  return (
    <PageSidebarLayout
      tree={
        // Keyed on the archive state: archiving or restoring this page re-reads
        // the route, and the tree is a client island seeded once — the new key
        // remounts it on the server's fresh levels, so it drops or lists the page.
        <Suspense key={page.archivedAt ?? 'live'} fallback={<SidebarFrame />}>
          <PageSidebarTree
            service={scope.service}
            projectId={scope.projectId}
            projectKey={scope.project.identifier}
            pageId={page.id}
            trail={trail}
          />
        </Suspense>
      }
      breadcrumb={<PageBreadcrumb trail={trail} page={{ id: page.id, title: page.title }} />}
    >
      <Suspense fallback={<PageFrame />}>
        <PageView
          key={page.id}
          viewerId={viewerId}
          viewerName={context.actorName ?? ''}
          mentionCandidates={mentionCandidates}
          mayComment={mayComment}
          openThreadCount={openThreads.openCount}
          inlineThreads={openThreads.inlineThreads}
          page={{
            id: page.id,
            title: page.title,
            bodyState: page.bodyState,
            canEdit: page.canEdit,
            canLinkWorkItems,
            projectId: page.projectId,
            workItemRefs: page.workItemRefs,
            parentTitle: trail?.pages.at(-1)?.title ?? null,
            archived:
              page.archivedAt === null
                ? null
                : {
                    archivedAt: page.archivedAt,
                    archivedBy: page.archivedBy,
                    archiveRoot: page.archiveRoot,
                    canRestore: page.canRestore,
                    canDelete: page.canDelete,
                    subPageCount,
                  },
          }}
          titleMaxLength={PAGE_TITLE_MAX_LENGTH}
        />
      </Suspense>
    </PageSidebarLayout>
  );
}

/**
 * The sidebar's tree: the root and every level on the page's path, read in
 * parallel. A level that cannot be read is left to the tree, which reads it on
 * mount (and shows its own failed row if that read fails too).
 */
async function PageSidebarTree({
  service,
  projectId,
  projectKey,
  pageId,
  trail,
}: {
  service: ServiceContext;
  projectId: string;
  projectKey: string;
  pageId: string;
  trail: PageTrailDto | null;
}) {
  const path = expandedPathOf(trail);
  const readLevel = async (parent: string): Promise<PageTreeLevelDto | null> => {
    try {
      return await pagesService.listTreeLevel(service, {
        projectId,
        parent: parentOf(parent),
      });
    } catch (err) {
      console.error('[pages] a level of the page sidebar could not be read', err);
      return null;
    }
  };
  const [root, ...levels] = await Promise.all(['root', ...path].map(readLevel));
  const initialLevels: Record<string, PageTreeLevelDto> = {};
  path.forEach((key, i) => {
    const level = levels[i];
    if (level) initialLevels[key] = level;
  });
  return (
    <PageTree
      density="compact"
      canEdit={false}
      projectKey={projectKey}
      // A failed root read is left to the tree's own mount read.
      initialRoot={root ?? undefined}
      selectedPageId={pageId}
      expandedPath={path}
      initialLevels={initialLevels}
    />
  );
}

/** The sidebar's frame while its levels are read: compact row-shaped blocks. */
function SidebarFrame() {
  return (
    <div aria-hidden data-testid="page-sidebar-frame" className="flex animate-pulse flex-col">
      {['w-[70%]', 'w-[55%]', 'w-[80%]', 'w-[60%]', 'w-[45%]'].map((width) => (
        <div key={width} className="flex h-8 items-center px-2">
          <div className={`h-3 ${width} rounded-(--radius-control) bg-(--el-muted)`} />
        </div>
      ))}
    </div>
  );
}

/** State 11: the generic header pair and paragraph bars — no toolbar block. */
function PageFrame() {
  return (
    <div className="mt-3">
      <PageSkeleton>
        <div className="flex flex-col gap-2.5">
          <div className="h-3.5 w-[92%] rounded-(--radius-control) bg-(--el-muted)" />
          <div className="h-3.5 w-[86%] rounded-(--radius-control) bg-(--el-muted)" />
          <div className="h-3.5 w-[64%] rounded-(--radius-control) bg-(--el-muted)" />
          <div className="h-3.5 w-[90%] rounded-(--radius-control) bg-(--el-muted)" />
          <div className="h-3.5 w-[40%] rounded-(--radius-control) bg-(--el-muted)" />
        </div>
      </PageSkeleton>
    </div>
  );
}

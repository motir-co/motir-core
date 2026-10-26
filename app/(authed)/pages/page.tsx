import { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Archive } from 'lucide-react';
import { memberPageContext, pageScope } from '@/lib/pages/projectPageContext';
import { pagesService } from '@/lib/services/pagesService';
import { foldersService } from '@/lib/services/foldersService';
import type { PageTreeLevelDto } from '@/lib/dto/pages';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { FolderCommandsProvider } from '@/components/folders/FolderCommands';
import type { FolderCommandActions } from '@/components/folders/folderActions';
import {
  createFolderAction,
  deleteFolderAction,
  describeFolderDeletionAction,
  listProjectFoldersAction,
  moveFolderAction,
  renameFolderAction,
} from '../items/actions';
import { NewFolderButton } from './_components/NewFolderButton';
import { NewPageButton } from './_components/NewPageButton';
import { PagesIndex } from './_components/PagesIndex';
import { PagesIndexFrame } from './_components/PagesIndexFrame';
import { PagesSearch } from './_components/PagesSearch';

// THE PAGES INDEX, `/pages` (Story MOTIR-5752 · MOTIR-7300; a TREE since Story
// MOTIR-5753 · MOTIR-7373) — the project's folders and pages, drawn by
// `design/pages/pages--tree.mock.html` panels 1–8. Mirrors `/my-agents`: the
// gate, then the header, then an in-page <Suspense>.
//
// ── THE GATE FIRST ─────────────────────────────────────────────────────────
// `memberPageContext()` resolves the reader and their ACTIVE project; a reader
// without `page:view` — the key every `pagesService` read asserts — gets the
// page's `notFound()`, exactly as `/pages/<id>` refuses them, and the tree is
// never read. The rail and ⌘K drop the entry for that reader through the same
// key (`projectNavAccess.ts`), so nothing offers a door that answers 404.
//
// ── THEN THE FRAME, AN IN-PAGE <Suspense> — NEVER A `loading.tsx` ──────────
// Both page routes call `notFound()`, so a route-level boundary would flush a
// 200 before either decided (`CLAUDE.md` § A `loading.tsx` may NOT sit above a
// route that decides existence). The header is REAL and paints above the
// boundary — its strings are static and New page's key is already resolved —
// so the frame (panel 5) is the tree's shape alone: five row-shaped blocks in
// the same frame, so the tree settles with no vertical shift.
//
// ── THE ROOT LEVEL IS READ HERE, THE REST IN THE BROWSER ───────────────────
// `pagesService.listTreeLevel` reads the root (folders, then pages, the first
// 50); every deeper level is read by `PageTree` when its row is expanded. A
// failed root read is NOT a 500: the header and its New page still work —
// creating a page does not need the read — so the tree renders its first-level
// error state with Try again (panel 6), which re-reads through the route.
//
// ── THE FOLDER COMMANDS (MOTIR-7374) ───────────────────────────────────────
// Folders are the project's, shared with `/items`, and so are their writes: the
// `/items` server actions, handed to the client tree as props (`components/` may
// not import `app/`). The header's New folder reaches the tree through the
// shared `FolderCommandsProvider`, which wraps both. Folder writes assert
// `work_item:edit`, so the tree offers them only to a reader holding it too.
//
// ── THE ARCHIVE'S DOOR (Story MOTIR-5755 · MOTIR-7424) ─────────────────────
// The header's **Archived pages** link opens `/pages/archived` for every reader
// who reached this page — reading the archive is `page:view`, the key gated above.
//
// ── `?folder=<id>` — THE BREADCRUMB'S WAY INTO THE TREE (MOTIR-7375) ───────
// A page's breadcrumb links a folder segment here (`page--tree-sidebar.mock.html`
// panel 4): the tree opens with the path to that folder AND the folder itself
// expanded, read on the server like the root, and the folder scrolled into view
// holding the tree's focus. A folder that is unknown, in another project, or
// that this reader cannot browse is IGNORED — the tree opens at its root, never
// a 404 (design-notes § Open questions) — the roadmap's `?folder=` silence.
//
// ── THE SEARCH BOX (Story MOTIR-9491 · MOTIR-9638) ─────────────────────────
// `PagesSearch` wraps the <Suspense>: the box paints above the tree, and while
// a query is active its result list replaces the tree, which stays mounted
// under `hidden` so its expanded rows survive (`pages--tree--search.mock.html`).

/** The shipped folder writes, as the `/pages` tree receives them. */
const FOLDER_ACTIONS: FolderCommandActions = {
  createFolder: createFolderAction,
  renameFolder: renameFolderAction,
  moveFolder: moveFolderAction,
  listProjectFolders: listProjectFoldersAction,
  describeFolderDeletion: describeFolderDeletionAction,
  deleteFolder: deleteFolderAction,
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('pages.index');
  return { title: t('title') };
}

type SearchParams = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

export default async function PagesIndexPage({ searchParams }: SearchParams = {}) {
  const ctx = await memberPageContext();
  const [held, t] = await Promise.all([ctx.permissions(), getTranslations('pages')]);
  if (!held.has('page:view')) notFound();
  const scope = pageScope(ctx);
  const folderParam = (await searchParams)?.['folder'];
  const folderId = typeof folderParam === 'string' && folderParam ? folderParam : null;

  return (
    <FolderCommandsProvider>
      <div className="flex flex-col gap-6">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-serif text-2xl font-semibold text-(--el-text)">
              {t('index.title')}
            </h1>
            <p className="mt-1 text-sm text-(--el-text-secondary)">{t('tree.subtitle')}</p>
          </div>
          {/* Each New renders only for its keys — both read `useProjectAccess()`.
              Archived pages is every reader's: the list is `page:view` (MOTIR-7424). */}
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href="/pages/archived"
              className="inline-flex h-(--height-control) items-center gap-2 rounded-(--radius-btn) border border-transparent px-(--spacing-control-x-12) font-sans text-sm text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              <Archive className="h-4 w-4" aria-hidden />
              {t('archive.list.link')}
            </Link>
            <NewFolderButton />
            <NewPageButton />
          </div>
        </header>
        <PagesSearch projectId={scope.projectId}>
          <Suspense fallback={<PagesIndexFrame />}>
            <PagesIndexData
              service={scope.service}
              projectId={scope.projectId}
              projectKey={scope.project.identifier}
              canEdit={held.has('page:edit')}
              canEditFolders={held.has('work_item:edit')}
              folderId={folderId}
            />
          </Suspense>
        </PagesSearch>
      </div>
    </FolderCommandsProvider>
  );
}

async function PagesIndexData({
  service,
  projectId,
  projectKey,
  canEdit,
  canEditFolders,
  folderId = null,
}: {
  service: ServiceContext;
  projectId: string;
  projectKey: string;
  canEdit: boolean;
  canEditFolders: boolean;
  /** `?folder=<id>`: the folder to open the tree to. */
  folderId?: string | null;
}) {
  // The folder's chain, root-first — silently none for a folder this reader
  // cannot reach. Read alongside the root.
  const chainRead = folderId
    ? foldersService.getFolderTrail(projectId, folderId, service).catch(() => [])
    : Promise.resolve([]);
  const readRoot = pagesService
    .listTreeLevel(service, { projectId, parent: { kind: 'root' } })
    .catch((err: unknown) => {
      console.error('[pages] the root level of the page tree could not be read', err);
      return null;
    });
  const [root, chain] = await Promise.all([readRoot, chainRead]);

  // Every level on the chain, the folder's own included; one that cannot be
  // read is left to the tree's mount read.
  const expandedPath = chain.map((f) => `folder:${f.id}`);
  const levels = await Promise.all(
    chain.map((f) =>
      pagesService
        .listTreeLevel(service, { projectId, parent: { kind: 'folder', id: f.id } })
        .catch(() => null),
    ),
  );
  const initialLevels: Record<string, PageTreeLevelDto> = {};
  expandedPath.forEach((key, i) => {
    const level = levels[i];
    if (level) initialLevels[key] = level;
  });
  return (
    <PagesIndex
      root={root}
      projectKey={projectKey}
      canEdit={canEdit}
      canEditFolders={canEditFolders}
      folderActions={FOLDER_ACTIONS}
      expandedPath={expandedPath}
      initialLevels={initialLevels}
      revealKey={expandedPath[expandedPath.length - 1]}
    />
  );
}

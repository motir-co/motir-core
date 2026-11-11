import { Suspense, type ReactElement, type ReactNode } from 'react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRole } from '@/generated/prisma/client';

// The two SERVER pages of Story MOTIR-5752 — the `/pages` index (MOTIR-7300) and
// the page at its address (MOTIR-7280) — rendered with the RSC harness
// (`tests/helpers/serverPageHarness.tsx`) against real Postgres. Part of the
// story's coverage gate (MOTIR-7281): the index's `page:view` gate and its
// root-level tree read (MOTIR-7373), the page's one-read gate with every not-found case, and both pages'
// metadata. Story MOTIR-5753 · MOTIR-7375 adds the page's PLACE — the breadcrumb
// and the sidebar tree read from the trail, a move showing the new trail on the
// next open — and `/pages?folder=<id>` opening the tree to a folder.
//
// Mocked: the session and the active project (they need cookies), and the two
// framework calls a page makes that only a Next request can honour —
// `notFound()` / `redirect()` (made to throw, as Next's do) and the server half
// of `next-intl` (the harness's key-echoing `serverTranslations`).

class NotFound extends Error {}
class Redirect extends Error {}

interface Reader {
  userId: string;
  workspaceId: string;
  projectId: string;
  project: unknown;
}

const reader = vi.hoisted(() => ({ current: null as Reader | null }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () =>
    reader.current ? { user: { id: reader.current.userId, name: 'Reader' } } : null,
  ),
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: vi.fn(async () => reader.current),
}));
vi.mock('next/navigation', async () => ({
  ...(await import('../helpers/serverPageHarness')).navigationHooks(),
  notFound: () => {
    throw new NotFound('NEXT_NOT_FOUND');
  },
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock('next-intl/server', async () => ({
  getTranslations: (await import('../helpers/serverPageHarness')).serverTranslations,
}));

const IndexPage = await import('@/app/(authed)/pages/page');
const AddressPage = await import('@/app/(authed)/pages/[pageId]/page');
const ArchivedPage = await import('@/app/(authed)/pages/archived/page');
const { ArchivedPagesList } =
  await import('@/app/(authed)/pages/archived/_components/ArchivedPagesList');
const { ArchivedPagesFrame } =
  await import('@/app/(authed)/pages/archived/_components/ArchivedPagesFrame');
const { PagesIndex } = await import('@/app/(authed)/pages/_components/PagesIndex');
const { NewPageButton } = await import('@/app/(authed)/pages/_components/NewPageButton');
const { PagesIndexFrame } = await import('@/app/(authed)/pages/_components/PagesIndexFrame');
const { PageView } = await import('@/app/(authed)/pages/[pageId]/_components/PageView');
const { PageTree } = await import('@/components/pages/tree/PageTree');
const { PageBreadcrumb } = await import('@/components/pages/tree/PageBreadcrumb');
const { PageSidebarLayout } = await import('@/components/pages/tree/PageSidebarLayout');
const { foldersService } = await import('@/lib/services/foldersService');
const { PAGE_COMMENT_THREADS_MAX_LIMIT, PAGE_TITLE_MAX_LENGTH } = await import('@/lib/pages');
const { pagesService } = await import('@/lib/services/pagesService');
const { pageCommentsService } = await import('@/lib/services/pageCommentsService');
const { assignableMembersService } = await import('@/lib/services/assignableMembersService');
const { projectsService } = await import('@/lib/services/projectsService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { db } = await import('@/lib/db');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { createCustomRoleAs, setWorkspaceRoleFor } =
  await import('../helpers/workspaceRoleFixtures');
const { findAll, findFirst, renderTree, textOf } = await import('../helpers/serverPageHarness');

beforeEach(async () => {
  await truncateAuthTables();
  reader.current = null;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
async function makeUser(tag: string) {
  seq += 1;
  return usersService.createUser({
    email: `pages-rsc-${tag}-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `RSC ${tag}`,
  });
}

interface Fixture {
  workspaceId: string;
  manager: Reader;
  other: Reader;
}

async function makeFixture(): Promise<Fixture> {
  const owner = await makeUser('owner');
  const ws = await workspacesService.createWorkspace({ name: 'RSC', ownerUserId: owner.id });
  const workspaceId = ws.workspace.id;
  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'RSC',
    identifier: 'RSC',
  });
  const other = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Other',
    identifier: 'RSO',
  });
  return {
    workspaceId,
    manager: { userId: owner.id, workspaceId, projectId: project.id, project },
    other: { userId: owner.id, workspaceId, projectId: other.id, project: other },
  };
}

async function readerAs(f: Fixture, tag: string, role: WorkspaceRole): Promise<Reader> {
  const user = await makeUser(tag);
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: f.workspaceId, workspaceRole: role },
  });
  return { ...f.manager, userId: user.id };
}

/** A workspace member on a custom role that may browse the project and holds no page key. */
async function browserWithoutPageKeys(f: Fixture): Promise<Reader> {
  const r = await readerAs(f, 'browser', 'member');
  const role = await createCustomRoleAs({
    ctx: { userId: f.manager.userId, workspaceId: f.workspaceId },
    name: 'Browse only',
    permissions: ['project:browse'],
  });
  await setWorkspaceRoleFor(r.userId, f.workspaceId, role.id);
  return r;
}

const params = (pageId: string) => ({ params: Promise.resolve({ pageId }) });

/** Render the Suspense child (an async server component) the page streams. */
async function settle(el: ReactElement): Promise<ReactNode> {
  const render = el.type as (props: unknown) => Promise<ReactNode>;
  return render(el.props);
}

describe('/pages — the index', () => {
  it.each([
    ['manager', true],
    ['member', true],
    ['viewer', false],
  ] as const)(
    'a %s gets the header and the tree’s root level, in position order (canEdit %s)',
    async (role, canEdit) => {
      const f = await makeFixture();
      const first = await pagesService.createPage(f.manager, {
        projectId: f.manager.projectId,
        title: 'First',
      });
      const second = await pagesService.createPage(f.manager, {
        projectId: f.manager.projectId,
        title: 'Second',
      });
      // A sub-page sits one level down — not in the root level.
      await pagesService.createPage(f.manager, {
        projectId: f.manager.projectId,
        title: 'Under first',
        parent: { kind: 'page', id: first.id },
      });
      // A page in the OTHER project is never listed here.
      await pagesService.createPage(f.manager, {
        projectId: f.other.projectId,
        title: 'Elsewhere',
      });
      reader.current = role === 'manager' ? f.manager : await readerAs(f, role, role);

      const tree = await renderTree(IndexPage.default);
      expect(textOf(tree)).toContain('title');
      // The archive's door is every reader's (MOTIR-7424).
      expect(textOf(tree)).toContain('archive.list.link');
      expect(findFirst(tree, NewPageButton)).toBeDefined();
      const boundary = findFirst<{ fallback: ReactElement; children: ReactElement }>(
        tree,
        Suspense,
      )!;
      expect(boundary.props.fallback.type).toBe(PagesIndexFrame);

      const body = (await settle(boundary.props.children)) as ReactElement<{
        root: {
          rows: { kind: string; id: string; name?: string; hasChildren: boolean }[];
          nextCursor: null;
        };
        projectKey: string;
        canEdit: boolean;
      }>;
      expect(body.type).toBe(PagesIndex);
      expect(body.props.canEdit).toBe(canEdit);
      expect(body.props.projectKey).toBe('RSC');
      // Folders first — every project is created with its `Bugs` folder — then
      // the root's pages; the sub-page is only its parent's `hasChildren`.
      expect(
        body.props.root.rows.map((r) =>
          r.kind === 'folder' ? ['folder', r.name] : [r.id, r.hasChildren],
        ),
      ).toEqual([
        ['folder', 'Bugs'],
        [first.id, true],
        [second.id, false],
      ]);
      expect(body.props.root.nextCursor).toBeNull();
    },
  );

  it('a reader without `page:view` gets notFound() and the tree is never read', async () => {
    const f = await makeFixture();
    reader.current = await browserWithoutPageKeys(f);
    const list = vi.spyOn(pagesService, 'listTreeLevel');
    await expect(renderTree(IndexPage.default)).rejects.toBeInstanceOf(NotFound);
    expect(list).not.toHaveBeenCalled();
  });

  it('is titled from the catalogue', async () => {
    expect(await IndexPage.generateMetadata()).toEqual({ title: 'title' });
  });
});

describe('/pages/archived — the Archived pages list (MOTIR-7424)', () => {
  it.each([
    ['manager', true, true],
    ['member', true, false],
    ['viewer', false, false],
  ] as const)(
    'a %s gets the header and the archive roots behind the in-page frame (restore %s, delete %s)',
    async (role, canRestore, canDelete) => {
      const f = await makeFixture();
      const projectId = f.manager.projectId;
      const root = await pagesService.createPage(f.manager, { projectId, title: 'Old' });
      await pagesService.createPage(f.manager, {
        projectId,
        title: 'Old child',
        parent: { kind: 'page', id: root.id },
      });
      await pagesService.createPage(f.manager, { projectId, title: 'Live' });
      await pagesService.archivePage(f.manager, { projectId, pageId: root.id });
      const elsewhere = await pagesService.createPage(f.manager, {
        projectId: f.other.projectId,
        title: 'Elsewhere',
      });
      await pagesService.archivePage(f.manager, {
        projectId: f.other.projectId,
        pageId: elsewhere.id,
      });
      reader.current = role === 'manager' ? f.manager : await readerAs(f, role, role);

      const tree = await renderTree(ArchivedPage.default);
      for (const key of ['back', 'title', 'subtitle']) expect(textOf(tree)).toContain(key);
      const boundary = findFirst<{
        fallback: ReactElement<{ showActions: boolean }>;
        children: ReactElement;
      }>(tree, Suspense)!;
      expect(boundary.props.fallback.type).toBe(ArchivedPagesFrame);
      expect(boundary.props.fallback.props.showActions).toBe(canRestore || canDelete);

      const body = (await settle(boundary.props.children)) as ReactElement<{
        initial: { items: { id: string; subPageCount: number }[]; nextCursor: null };
        projectKey: string;
        canRestore: boolean;
        canDelete: boolean;
      }>;
      expect(body.type).toBe(ArchivedPagesList);
      // The root alone — its sub-page is its count; the other project's never.
      expect(body.props.initial.items.map((i) => [i.id, i.subPageCount])).toEqual([[root.id, 1]]);
      expect(body.props.initial.nextCursor).toBeNull();
      expect(body.props.projectKey).toBe('RSC');
      expect(body.props.canRestore).toBe(canRestore);
      expect(body.props.canDelete).toBe(canDelete);
    },
  );

  it('a reader without `page:view` gets notFound() and nothing is read', async () => {
    const f = await makeFixture();
    reader.current = await browserWithoutPageKeys(f);
    const list = vi.spyOn(pagesService, 'listArchivedPages');
    await expect(renderTree(ArchivedPage.default)).rejects.toBeInstanceOf(NotFound);
    expect(list).not.toHaveBeenCalled();
  });

  it('a first page that cannot be read is the list’s error state, never a 500', async () => {
    const f = await makeFixture();
    reader.current = f.manager;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(pagesService, 'listArchivedPages').mockRejectedValueOnce(new Error('down'));
    const tree = await renderTree(ArchivedPage.default);
    const boundary = findFirst<{ children: ReactElement }>(tree, Suspense)!;
    const body = (await settle(boundary.props.children)) as ReactElement<{ initial: unknown }>;
    expect(body.props.initial).toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it('is titled from the catalogue', async () => {
    expect(await ArchivedPage.generateMetadata()).toEqual({ title: 'title' });
  });
});

describe('/pages/<id> — the page at its address', () => {
  it('a member gets the page’s view, writable, behind the in-page frame', async () => {
    const f = await makeFixture();
    const page = await pagesService.createPage(f.manager, {
      projectId: f.manager.projectId,
      title: 'Runbook',
    });
    reader.current = await readerAs(f, 'member', 'member');

    const tree = await renderTree(AddressPage.default, params(page.id));
    const view = findFirst<{
      page: { id: string; title: string; bodyState: string; canEdit: boolean };
      titleMaxLength: number;
      viewerId: string;
    }>(tree, PageView)!;
    expect(view.props.page).toMatchObject({ id: page.id, title: 'Runbook', canEdit: true });
    expect(view.props.titleMaxLength).toBe(PAGE_TITLE_MAX_LENGTH);
    expect(view.props.viewerId).toBe(reader.current.userId);
    expect(typeof view.props.page.bodyState).toBe('string');

    // The frame draws the header pair and paragraph bars — and no toolbar. Two
    // in-page boundaries, both after the gate: the sidebar's levels and the page.
    const boundaries = findAll<{ fallback: ReactElement; children: ReactElement }>(tree, Suspense);
    expect(boundaries).toHaveLength(2);
    const pageBoundary = boundaries.find((b) => b.props.children.type === PageView)!;
    expect(await settle(pageBoundary.props.fallback)).toBeTruthy();

    expect(await AddressPage.generateMetadata(params(page.id))).toEqual({ title: 'Runbook' });
  });

  it('a viewer gets the same page read-only; an untitled page is titled with the untitled copy', async () => {
    const f = await makeFixture();
    const page = await pagesService.createPage(f.manager, { projectId: f.manager.projectId });
    reader.current = await readerAs(f, 'viewer', 'viewer');
    const tree = await renderTree(AddressPage.default, params(page.id));
    expect(findFirst<{ page: { canEdit: boolean } }>(tree, PageView)!.props.page.canEdit).toBe(
      false,
    );
    expect(await AddressPage.generateMetadata(params(page.id))).toEqual({ title: 'untitled' });
  });

  it('an archived root reads read-only with its archive state and its sub-page count (MOTIR-7423)', async () => {
    const f = await makeFixture();
    const projectId = f.manager.projectId;
    const parent = await pagesService.createPage(f.manager, { projectId, title: 'Handbook' });
    const root = await pagesService.createPage(f.manager, {
      projectId,
      title: 'Runbook',
      parent: { kind: 'page', id: parent.id },
    });
    const sub = await pagesService.createPage(f.manager, {
      projectId,
      title: 'Deploy',
      parent: { kind: 'page', id: root.id },
    });
    await pagesService.archivePage(f.manager, { projectId, pageId: root.id });
    reader.current = f.manager;

    type ViewProps = {
      page: {
        canEdit: boolean;
        parentTitle: string | null;
        archived: {
          archiveRoot: { id: string } | null;
          canRestore: boolean;
          canDelete: boolean;
          subPageCount: number;
        } | null;
      };
    };
    const rootView = findFirst<ViewProps>(
      await renderTree(AddressPage.default, params(root.id)),
      PageView,
    )!;
    expect(rootView.props.page.canEdit).toBe(false);
    expect(rootView.props.page.parentTitle).toBe('Handbook');
    expect(rootView.props.page.archived).toMatchObject({
      archiveRoot: { id: root.id },
      canRestore: true,
      canDelete: true,
      subPageCount: 1,
    });

    // A sub-page names its root; it carries no count of its own.
    const subView = findFirst<ViewProps>(
      await renderTree(AddressPage.default, params(sub.id)),
      PageView,
    )!;
    expect(subView.props.page.parentTitle).toBe('Runbook');
    expect(subView.props.page.archived).toMatchObject({
      archiveRoot: { id: root.id },
      subPageCount: 0,
    });

    // A count that cannot be read costs the sentence, not the page.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(pagesService, 'describeArchiveSet').mockRejectedValueOnce(new Error('set down'));
    const degraded = findFirst<ViewProps>(
      await renderTree(AddressPage.default, params(root.id)),
      PageView,
    )!;
    expect(degraded.props.page.archived!.subPageCount).toBe(0);
    expect(error).toHaveBeenCalled();
  });

  it('an unknown id, a page from another project and a non-browser all get notFound() — and no title', async () => {
    const f = await makeFixture();
    const elsewhere = await pagesService.createPage(f.manager, { projectId: f.other.projectId });
    const mine = await pagesService.createPage(f.manager, { projectId: f.manager.projectId });

    reader.current = f.manager;
    for (const id of ['no-such-page', elsewhere.id]) {
      await expect(renderTree(AddressPage.default, params(id))).rejects.toBeInstanceOf(NotFound);
      expect(await AddressPage.generateMetadata(params(id))).toEqual({});
    }

    // A workspace member outside a members-only project cannot browse it.
    await adminDb.project.update({
      where: { id: f.manager.projectId },
      data: { accessMode: 'members' },
    });
    reader.current = await readerAs(f, 'outsider', 'member');
    await expect(renderTree(AddressPage.default, params(mine.id))).rejects.toBeInstanceOf(NotFound);
  });

  it('a reader who may browse the project but holds no `page:view` gets notFound(), as the index refuses them', async () => {
    const f = await makeFixture();
    const page = await pagesService.createPage(f.manager, { projectId: f.manager.projectId });
    reader.current = await browserWithoutPageKeys(f);
    await expect(renderTree(AddressPage.default, params(page.id))).rejects.toBeInstanceOf(NotFound);
    expect(await AddressPage.generateMetadata(params(page.id))).toEqual({});
  });

  it('an error that is not a refusal is rethrown to the error boundary, never a 404', async () => {
    const f = await makeFixture();
    reader.current = f.manager;
    vi.spyOn(pagesService, 'getPage').mockRejectedValueOnce(new Error('database down'));
    await expect(renderTree(AddressPage.default, params('any'))).rejects.toThrow('database down');
  });

  it('an anonymous reader is sent to sign in', async () => {
    reader.current = null;
    await expect(renderTree(AddressPage.default, params('any'))).rejects.toBeInstanceOf(Redirect);
  });
});

describe('/pages/<id> — the discussion’s server reads (MOTIR-10874)', () => {
  type DiscussionProps = {
    viewerName: string;
    mentionCandidates: { id: string; name: string; email: string }[];
    openThreadCount: number;
    inlineThreads: { id: string; anchor: { bytes: string; quote: string }; replies?: unknown }[];
  };

  it('hands a member the roster and the open count; a viewer and an archived page no roster', async () => {
    const f = await makeFixture();
    const projectId = f.manager.projectId;
    const page = await pagesService.createPage(f.manager, { projectId, title: 'Runbook' });
    const one = await pageCommentsService.postPageComment(f.manager, {
      projectId,
      pageId: page.id,
      bodyMd: 'First',
    });
    await pageCommentsService.postPageComment(f.manager, {
      projectId,
      pageId: page.id,
      bodyMd: 'Second',
    });
    await pageCommentsService.resolvePageThread(f.manager, {
      projectId,
      pageId: page.id,
      commentId: one.id,
    });

    reader.current = await readerAs(f, 'member', 'member');
    const asMember = findFirst<DiscussionProps>(
      await renderTree(AddressPage.default, params(page.id)),
      PageView,
    )!;
    expect(asMember.props.openThreadCount).toBe(1);
    expect(asMember.props.viewerName).toBe('Reader');
    expect(asMember.props.mentionCandidates.map((m) => m.id)).toContain(f.manager.userId);
    expect(asMember.props.mentionCandidates[0]).toEqual({
      id: expect.any(String),
      name: expect.any(String),
      email: expect.stringContaining('@'),
    });

    reader.current = await readerAs(f, 'viewer', 'viewer');
    const asViewer = findFirst<DiscussionProps>(
      await renderTree(AddressPage.default, params(page.id)),
      PageView,
    )!;
    expect(asViewer.props.mentionCandidates).toEqual([]);
    expect(asViewer.props.openThreadCount).toBe(1);

    await pagesService.archivePage(f.manager, { projectId, pageId: page.id });
    reader.current = f.manager;
    const archived = findFirst<DiscussionProps>(
      await renderTree(AddressPage.default, params(page.id)),
      PageView,
    )!;
    expect(archived.props.mentionCandidates).toEqual([]);
    expect(archived.props.openThreadCount).toBe(1);
  });

  it('a count or roster that cannot be read costs the chip or the picker, not the page', async () => {
    const f = await makeFixture();
    const page = await pagesService.createPage(f.manager, {
      projectId: f.manager.projectId,
      title: 'Runbook',
    });
    reader.current = f.manager;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(pageCommentsService, 'listAnchoredRoots').mockRejectedValueOnce(new Error('down'));
    vi.spyOn(assignableMembersService, 'list').mockRejectedValueOnce(new Error('down'));
    const view = findFirst<DiscussionProps>(
      await renderTree(AddressPage.default, params(page.id)),
      PageView,
    )!;
    expect(view.props.openThreadCount).toBe(0);
    expect(view.props.inlineThreads).toEqual([]);
    expect(view.props.mentionCandidates).toEqual([]);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('hands down every OPEN anchored root, following the list past its first page (MOTIR-10899)', async () => {
    const f = await makeFixture();
    const projectId = f.manager.projectId;
    const page = await pagesService.createPage(f.manager, { projectId, title: 'Runbook' });
    const bytes = (n: number) => new Uint8Array([1, n, 2, 3]);
    const anchored: string[] = [];
    // More anchored threads than one page of the list holds, a page-level one,
    // and a resolved anchored one.
    for (let i = 0; i < PAGE_COMMENT_THREADS_MAX_LIMIT + 2; i += 1) {
      const root = await pageCommentsService.postPageComment(f.manager, {
        projectId,
        pageId: page.id,
        bodyMd: `Inline ${i}`,
        anchor: { bytes: bytes(i), quote: `passage ${i}` },
      });
      anchored.push(root.id);
    }
    const pageLevel = await pageCommentsService.postPageComment(f.manager, {
      projectId,
      pageId: page.id,
      bodyMd: 'About the page',
    });
    await pageCommentsService.postPageReply(f.manager, {
      projectId,
      pageId: page.id,
      parentCommentId: anchored[0]!,
      bodyMd: 'A reply',
    });
    const resolved = await pageCommentsService.postPageComment(f.manager, {
      projectId,
      pageId: page.id,
      bodyMd: 'Settled',
      anchor: { bytes: bytes(99), quote: 'settled passage' },
    });
    await pageCommentsService.resolvePageThread(f.manager, {
      projectId,
      pageId: page.id,
      commentId: resolved.id,
    });

    reader.current = await readerAs(f, 'viewer', 'viewer');
    const view = findFirst<DiscussionProps>(
      await renderTree(AddressPage.default, params(page.id)),
      PageView,
    )!;
    expect(view.props.openThreadCount).toBe(anchored.length + 1);
    const ids = view.props.inlineThreads.map((t) => t.id);
    expect([...ids].sort()).toEqual([...anchored].sort());
    expect(ids).not.toContain(pageLevel.id);
    const first = view.props.inlineThreads.find((t) => t.id === anchored[0])!;
    expect(first.anchor).toEqual({
      bytes: Buffer.from(bytes(0)).toString('base64'),
      quote: 'passage 0',
    });
    // The roots travel without their replies.
    expect(first.replies).toBeUndefined();
  });
});

describe('/pages/<id> — the page’s place (MOTIR-7375)', () => {
  type TreeProps = {
    density: string;
    canEdit: boolean;
    selectedPageId: string;
    expandedPath: string[];
    initialRoot?: { rows: { kind: string; id: string }[] };
    initialLevels: Record<string, { rows: { kind: string; id: string }[] }>;
  };

  /** folder › page › sub-page: Specs › Auth flow › Edge cases. */
  async function nested(f: Fixture) {
    const specs = await foldersService.createFolder(
      { projectId: f.manager.projectId, parentFolderId: null, name: 'Specs' },
      f.manager,
    );
    const auth = await pagesService.createPage(f.manager, {
      projectId: f.manager.projectId,
      title: 'Auth flow',
      parent: { kind: 'folder', id: specs.id },
    });
    const edge = await pagesService.createPage(f.manager, {
      projectId: f.manager.projectId,
      title: 'Edge cases',
      parent: { kind: 'page', id: auth.id },
    });
    return { specs, auth, edge };
  }

  async function place(pageId: string) {
    const tree = await renderTree(AddressPage.default, params(pageId));
    const layout = findFirst<{ tree: ReactElement; breadcrumb: ReactElement }>(
      tree,
      PageSidebarLayout,
    )!;
    const crumb = findFirst<{
      trail: { folders: { id: string; name: string }[]; pages: { id: string; title: string }[] };
      page: { id: string; title: string };
    }>(tree, PageBreadcrumb)!;
    const boundary = layout.props.tree as ReactElement<{
      fallback: ReactElement;
      children: ReactElement;
    }>;
    expect(boundary.type).toBe(Suspense);
    const sidebar = (await settle(boundary.props.children)) as ReactElement<TreeProps>;
    return { tree, crumb, sidebar, boundary };
  }

  it('the breadcrumb reads folder › parent page › page, and the sidebar opens the path to the page, selected', async () => {
    const f = await makeFixture();
    const { specs, auth, edge } = await nested(f);
    reader.current = await readerAs(f, 'member', 'member');

    const { crumb, sidebar, boundary } = await place(edge.id);
    expect(crumb.props.trail).toEqual({
      folders: [{ id: specs.id, name: 'Specs' }],
      pages: [{ id: auth.id, title: 'Auth flow' }],
    });
    expect(crumb.props.page).toEqual({ id: edge.id, title: 'Edge cases' });

    expect(sidebar.type).toBe(PageTree);
    expect(sidebar.props).toMatchObject({
      density: 'compact',
      canEdit: false,
      selectedPageId: edge.id,
      expandedPath: [`folder:${specs.id}`, `page:${auth.id}`],
    });
    // Every level on the path was read on the server, so the path paints open.
    expect(sidebar.props.initialRoot!.rows.some((r) => r.id === specs.id)).toBe(true);
    expect(sidebar.props.initialLevels[`folder:${specs.id}`]!.rows.map((r) => r.id)).toEqual([
      auth.id,
    ]);
    expect(sidebar.props.initialLevels[`page:${auth.id}`]!.rows.map((r) => r.id)).toEqual([
      edge.id,
    ]);
    // The sidebar's own frame while those levels are read.
    expect(await settle(boundary.props.fallback)).toBeTruthy();
  });

  it('after a move, reopening the page shows the new trail in both', async () => {
    const f = await makeFixture();
    const { auth, edge } = await nested(f);
    reader.current = f.manager;
    await pagesService.movePage(f.manager, {
      projectId: f.manager.projectId,
      pageId: edge.id,
      parent: { kind: 'root' },
    });
    void auth;
    const { crumb, sidebar } = await place(edge.id);
    expect(crumb.props.trail).toEqual({ folders: [], pages: [] });
    expect(sidebar.props.expandedPath).toEqual([]);
    expect(sidebar.props.initialRoot!.rows.some((r) => r.id === edge.id)).toBe(true);
  });

  it('a trail that cannot be read costs the trail, not the page: Pages › page, the tree at its root', async () => {
    const f = await makeFixture();
    const { edge } = await nested(f);
    reader.current = f.manager;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(pagesService, 'getPageTrail').mockRejectedValueOnce(new Error('trail down'));
    const { crumb, sidebar } = await place(edge.id);
    expect(crumb.props.trail).toBeNull();
    expect(sidebar.props.expandedPath).toEqual([]);
    expect(error).toHaveBeenCalled();
    expect(
      findFirst(await renderTree(AddressPage.default, params(edge.id)), PageView),
    ).toBeDefined();
  });

  it('a level the server cannot read is left to the tree, which reads it on mount', async () => {
    const f = await makeFixture();
    const { specs, edge } = await nested(f);
    reader.current = f.manager;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(pagesService, 'listTreeLevel').mockRejectedValue(new Error('level down'));
    const { sidebar } = await place(edge.id);
    expect(sidebar.props.initialRoot).toBeUndefined();
    expect(sidebar.props.initialLevels).toEqual({});
    expect(sidebar.props.expandedPath[0]).toBe(`folder:${specs.id}`);
  });

  it('a page that 404s renders no sidebar and no breadcrumb', async () => {
    const f = await makeFixture();
    reader.current = f.manager;
    const trail = vi.spyOn(pagesService, 'getPageTrail');
    await expect(renderTree(AddressPage.default, params('no-such-page'))).rejects.toBeInstanceOf(
      NotFound,
    );
    // The trail read ran beside the gate and was refused quietly — never rendered.
    expect(trail).toHaveBeenCalled();
  });
});

describe('/pages?folder=<id> — the breadcrumb’s way into the tree (MOTIR-7375)', () => {
  const search = (folder: string | string[]) => ({
    searchParams: Promise.resolve({ folder }),
  });
  async function body(args: ReturnType<typeof search>) {
    const tree = await renderTree(IndexPage.default, args);
    const boundary = findFirst<{ children: ReactElement }>(tree, Suspense)!;
    return (await settle(boundary.props.children)) as ReactElement<{
      expandedPath: string[];
      initialLevels: Record<string, { rows: { id: string }[] }>;
      revealKey?: string;
    }>;
  }

  it('opens the tree with the path to the folder and the folder itself expanded, revealing it', async () => {
    const f = await makeFixture();
    const specs = await foldersService.createFolder(
      { projectId: f.manager.projectId, parentFolderId: null, name: 'Specs' },
      f.manager,
    );
    const api = await foldersService.createFolder(
      { projectId: f.manager.projectId, parentFolderId: specs.id, name: 'API' },
      f.manager,
    );
    const inApi = await pagesService.createPage(f.manager, {
      projectId: f.manager.projectId,
      title: 'Auth flow',
      parent: { kind: 'folder', id: api.id },
    });
    reader.current = f.manager;

    const index = await body(search(api.id));
    expect(index.props.expandedPath).toEqual([`folder:${specs.id}`, `folder:${api.id}`]);
    expect(index.props.revealKey).toBe(`folder:${api.id}`);
    expect(index.props.initialLevels[`folder:${api.id}`]!.rows.map((r) => r.id)).toEqual([
      inApi.id,
    ]);
    expect(index.props.initialLevels[`folder:${specs.id}`]!.rows.map((r) => r.id)).toEqual([
      api.id,
    ]);
  });

  it('a folder that is unknown, another project’s, or not a single value is ignored — the root, never a 404', async () => {
    const f = await makeFixture();
    const elsewhere = await foldersService.createFolder(
      { projectId: f.other.projectId, parentFolderId: null, name: 'Elsewhere' },
      f.other,
    );
    reader.current = f.manager;
    for (const folder of ['no-such-folder', elsewhere.id, ['a', 'b'], '']) {
      const index = await body(search(folder));
      expect(index.props.expandedPath).toEqual([]);
      expect(index.props.revealKey).toBeUndefined();
    }
  });

  it('a folder level that cannot be read is left to the tree', async () => {
    const f = await makeFixture();
    const specs = await foldersService.createFolder(
      { projectId: f.manager.projectId, parentFolderId: null, name: 'Specs' },
      f.manager,
    );
    reader.current = f.manager;
    const real = pagesService.listTreeLevel.bind(pagesService);
    vi.spyOn(pagesService, 'listTreeLevel').mockImplementation(async (ctx, input) => {
      if (input.parent.kind === 'folder') throw new Error('level down');
      return real(ctx, input);
    });
    const index = await body(search(specs.id));
    expect(index.props.expandedPath).toEqual([`folder:${specs.id}`]);
    expect(index.props.initialLevels).toEqual({});
  });
});

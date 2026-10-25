import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { emptyState, markdownToUpdate, PageRevisionConflictError } from '@/lib/pages';
import type { PageEmbeddingRequestedData } from '@/lib/jobs/types';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { captureEventPayloads } from '../helpers/jobs';

// WHEN the page embedding job is enqueued (Story MOTIR-9490 · MOTIR-9571) — the
// emit, asserted from every page write door rather than from the job. Each door
// that can change a page's title, body or live-ness emits ONE
// `page/embedding.requested` per page it touched, carrying only ids, and only
// after its transaction committed: a refused save emits nothing.
//
// The one seam stubbed is the engine dispatch (tests/helpers/jobs.ts), which
// doubles as the assertion surface for the post-commit events.

let cap: { events: PageEmbeddingRequestedData[]; restore: () => void };

beforeEach(async () => {
  await truncateAuthTables();
  cap = captureEventPayloads<PageEmbeddingRequestedData>('page/embedding.requested');
});

afterEach(() => {
  cap.restore();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  workspaceId: string;
  projectId: string;
  ctx: ServiceContext;
}

async function makeFixture(): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: 'page-triggers@example.com',
    password: 'hunter2hunter2',
    name: 'Trigger',
  });
  const ws = await workspacesService.createWorkspace({ name: 'Pages', ownerUserId: owner.id });
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: owner.id,
    name: 'Pages',
    identifier: 'PTR',
  });
  return {
    workspaceId: ws.workspace.id,
    projectId: project.id,
    ctx: { userId: owner.id, workspaceId: ws.workspace.id },
  };
}

/** The events emitted by `act`, alone. */
async function emittedBy(act: () => Promise<unknown>): Promise<PageEmbeddingRequestedData[]> {
  const from = cap.events.length;
  await act();
  return cap.events.slice(from);
}

describe('the doors that change what a page says', () => {
  it('createPage emits one request, carrying only the ids', async () => {
    const f = await makeFixture();
    let id = '';
    const events = await emittedBy(async () => {
      id = (await pagesService.createPage(f.ctx, { projectId: f.projectId, title: 'New' })).id;
    });
    expect(events).toEqual([{ workspaceId: f.workspaceId, pageId: id }]);
  });

  it('createPageFromMarkdown emits one request', async () => {
    const f = await makeFixture();
    let id = '';
    const events = await emittedBy(async () => {
      id = (
        await pagesService.createPageFromMarkdown(f.ctx, {
          projectId: f.projectId,
          title: 'Imported',
          markdown: 'Body.',
        })
      ).id;
    });
    expect(events).toEqual([{ workspaceId: f.workspaceId, pageId: id }]);
  });

  it('renamePage, savePageMarkdown, savePageUpdate and restorePageVersion each emit one', async () => {
    const f = await makeFixture();
    const page = await pagesService.createPageFromMarkdown(f.ctx, {
      projectId: f.projectId,
      title: 'Edited',
      markdown: 'First.',
    });
    const ref = { projectId: f.projectId, pageId: page.id };
    const one = [{ workspaceId: f.workspaceId, pageId: page.id }];

    expect(
      await emittedBy(() => pagesService.renamePage(f.ctx, { ...ref, title: 'Renamed' })),
    ).toEqual(one);
    const current = await pagesService.getPageMarkdown(f.ctx, ref);
    expect(
      await emittedBy(() =>
        pagesService.savePageMarkdown(f.ctx, {
          ...ref,
          markdown: 'Second.',
          expectedRevision: current!.revision,
        }),
      ),
    ).toEqual(one);
    expect(
      await emittedBy(() =>
        pagesService.savePageUpdate(f.ctx, {
          ...ref,
          update: markdownToUpdate(emptyState(), 'Typed.'),
        }),
      ),
    ).toEqual(one);
    expect(
      await emittedBy(() => pagesService.restorePageVersion(f.ctx, { ...ref, number: 1 })),
    ).toEqual(one);
  });
});

describe('the doors that change whether a page is live', () => {
  it('archivePage and restorePage emit one request per page of the set', async () => {
    const f = await makeFixture();
    const parent = await pagesService.createPage(f.ctx, { projectId: f.projectId, title: 'P' });
    const child = await pagesService.createPage(f.ctx, {
      projectId: f.projectId,
      title: 'C',
      parent: { kind: 'page', id: parent.id },
    });
    const ref = { projectId: f.projectId, pageId: parent.id };
    const both = [
      { workspaceId: f.workspaceId, pageId: parent.id },
      { workspaceId: f.workspaceId, pageId: child.id },
    ];

    const archived = await emittedBy(() => pagesService.archivePage(f.ctx, ref));
    expect(archived).toHaveLength(2);
    expect(archived).toEqual(expect.arrayContaining(both));

    const restored = await emittedBy(() => pagesService.restorePage(f.ctx, ref));
    expect(restored).toHaveLength(2);
    expect(restored).toEqual(expect.arrayContaining(both));
  });

  it('deletePage emits nothing — the row goes with the page', async () => {
    const f = await makeFixture();
    const page = await pagesService.createPage(f.ctx, { projectId: f.projectId, title: 'Gone' });
    const ref = { projectId: f.projectId, pageId: page.id };
    await pagesService.archivePage(f.ctx, ref);

    expect(await emittedBy(() => pagesService.deletePage(f.ctx, ref))).toEqual([]);
  });
});

describe('a refused save', () => {
  it('emits nothing, because the emit runs only after the commit', async () => {
    const f = await makeFixture();
    const page = await pagesService.createPageFromMarkdown(f.ctx, {
      projectId: f.projectId,
      title: 'Conflicted',
      markdown: 'Body.',
    });

    const events = await emittedBy(() =>
      expect(
        pagesService.savePageMarkdown(f.ctx, {
          projectId: f.projectId,
          pageId: page.id,
          markdown: 'Stale.',
          expectedRevision: -1,
        }),
      ).rejects.toBeInstanceOf(PageRevisionConflictError),
    );
    expect(events).toEqual([]);
  });
});

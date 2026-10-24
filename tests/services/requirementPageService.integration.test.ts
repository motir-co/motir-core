import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { SystemPrincipalNotProvisionedError, motirSystemUserId } from '@/lib/ai/serviceAuth';
import { foldersService } from '@/lib/services/foldersService';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { requirementPageService } from '@/lib/services/requirementPageService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE REQUIREMENT PAGE WRITER over real Postgres (Story MOTIR-9430 · MOTIR-9433): the
// folder find-or-create, the page it files, who authored both, and the race between
// two confirms on a project with no folder yet.

let fx: WorkItemFixture;
let motirId: string;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The Motir account, provisioned the way the seed does, in a separate meta tenant it
 *  alone belongs to, so it holds NO membership in the project under test. */
async function provisionMotir() {
  const metaOwner = await usersService.createUser({
    email: 'meta-owner@example.com',
    password: 'hunter2hunter2',
    name: 'meta',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'moooon',
    ownerUserId: metaOwner.id,
  });
  const project = await projectsService.createProject({
    name: 'motir',
    identifier: 'MOTIR',
    workspaceId: workspace.id,
    actorUserId: metaOwner.id,
  });
  const seeded = await seedSystemPrincipal({ workspaceId: workspace.id, projectId: project.id });
  motirId = seeded.userId;
}

const REQUIREMENT = {
  outcome: 'A person plans a small feature from the overlay.',
  behaviour: 'The pane shows the requirement before Confirm.',
  scopeEdge: '',
  constraints: '',
  acceptance: 'Six headings appear.',
  assumptions: [{ id: 'r1', text: 'The pane replaces the canvas.' }],
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    requirement: REQUIREMENT,
    requestMd: 'Plan the requirement pane\nand more detail on a second line',
    conversationLabel: 'Plan the pane',
    at: new Date('2026-10-24T10:00:00Z'),
    locale: 'en' as const,
    ...overrides,
  };
}

// The project's own seeded `Bugs` folder is not this writer's concern.
const rootFolders = () =>
  adminDb.folder.findMany({
    where: { projectId: fx.projectId, parentFolderId: null, name: { not: 'Bugs' } },
    orderBy: { createdAt: 'asc' },
  });

describe('requirementPageService.write', () => {
  it('creates the root folder and one page in it, as the Motir account', async () => {
    await provisionMotir();
    const written = await requirementPageService.write(input());

    const folders = await rootFolders();
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({
      id: written.folderId,
      name: 'Requirements Docs',
      createdById: motirId,
    });
    expect(written.title).toBe('Plan the requirement pane');

    const page = await adminDb.page.findUniqueOrThrow({ where: { id: written.pageId } });
    expect(page).toMatchObject({ folderId: written.folderId, createdById: motirId });
    const versions = await adminDb.pageVersion.findMany({ where: { pageId: written.pageId } });
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.every((v) => v.authorId === motirId)).toBe(true);

    // No membership of the project's workspace was needed.
    expect(
      await adminDb.workspaceMembership.findUnique({
        where: { userId_workspaceId: { userId: motirId, workspaceId: fx.workspaceId } },
      }),
    ).toBeNull();
  });

  it('files the zh page in 需求文档', async () => {
    await provisionMotir();
    const written = await requirementPageService.write(input({ locale: 'zh' }));
    expect((await rootFolders())[0]!.name).toBe('需求文档');
    const read = await pagesService.getPageMarkdown(fx.ctx, {
      projectId: fx.projectId,
      pageId: written.pageId,
    });
    expect(read.markdown).toContain('成果');
  });

  it('reads back as the six sections and the provenance line', async () => {
    await provisionMotir();
    const written = await requirementPageService.write(input());
    const read = await pagesService.getPageMarkdown(fx.ctx, {
      projectId: fx.projectId,
      pageId: written.pageId,
    });
    expect(read.placement).toEqual({ parentPageId: null, folderId: written.folderId });
    for (const heading of [
      'Outcome',
      'Behaviour',
      'Scope edge',
      'Constraints',
      'Acceptance',
      'Assumptions',
    ]) {
      expect(read.markdown).toContain(`## ${heading}`);
    }
    // The page serializer escapes the bracket pair; the entry itself is intact.
    expect(read.markdown).toContain('- \\[r1\\] The pane replaces the canvas.');
    expect(read.markdown).toContain('Composed by Motir AI in the conversation "Plan the pane"');
    expect(read.markdown).toContain('2026-10-24');
  });

  it('reuses the folder on a second write, in either language', async () => {
    await provisionMotir();
    const first = await requirementPageService.write(input());
    const second = await requirementPageService.write(input({ locale: 'zh' }));
    expect(second.folderId).toBe(first.folderId);
    expect(await rootFolders()).toHaveLength(1);
    expect(await adminDb.page.count({ where: { folderId: first.folderId } })).toBe(2);
  });

  it('matches the folder name case-insensitively', async () => {
    await provisionMotir();
    const existing = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'requirements docs' },
      fx.ctx,
    );
    const written = await requirementPageService.write(input());
    expect(written.folderId).toBe(existing.id);
    expect(await rootFolders()).toHaveLength(1);
  });

  it('does not match a nested folder or a renamed one', async () => {
    await provisionMotir();
    const outer = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Archive' },
      fx.ctx,
    );
    const nested = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: outer.id, name: 'Requirements Docs' },
      fx.ctx,
    );
    const first = await requirementPageService.write(input());
    expect(first.folderId).not.toBe(nested.id);
    expect((await rootFolders()).map((f) => f.name).sort()).toEqual([
      'Archive',
      'Requirements Docs',
    ]);

    await foldersService.renameFolder(
      { projectId: fx.projectId, folderId: first.folderId, name: 'Specs' },
      fx.ctx,
    );
    const second = await requirementPageService.write(input());
    expect(second.folderId).not.toBe(first.folderId);
    expect((await rootFolders()).map((f) => f.name).sort()).toEqual([
      'Archive',
      'Requirements Docs',
      'Specs',
    ]);
  });

  it('ends with ONE folder holding both pages when two writes race', async () => {
    await provisionMotir();
    const [a, b] = await Promise.all([
      requirementPageService.write(input()),
      requirementPageService.write(input({ requestMd: 'Second request' })),
    ]);
    expect(a.folderId).toBe(b.folderId);
    expect(await rootFolders()).toHaveLength(1);
    expect(await adminDb.page.count({ where: { folderId: a.folderId } })).toBe(2);
  });

  it('rethrows a refused page write unchanged and leaves no page', async () => {
    await provisionMotir();
    await expect(
      requirementPageService.write(
        input({ requirement: { ...REQUIREMENT, outcome: 'x'.repeat(5_000_000) } }),
      ),
    ).rejects.toThrow();
    expect(await adminDb.page.count({ where: { projectId: fx.projectId } })).toBe(0);
  });

  it('throws before writing anything when the Motir account is not provisioned', async () => {
    await expect(requirementPageService.write(input())).rejects.toBeInstanceOf(
      SystemPrincipalNotProvisionedError,
    );
    expect(await rootFolders()).toHaveLength(0);
    await expect(motirSystemUserId()).rejects.toBeInstanceOf(SystemPrincipalNotProvisionedError);
  });
});

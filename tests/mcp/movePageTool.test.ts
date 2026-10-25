import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { V1PagePlacement } from '@/lib/api/v1/pages/schema';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { TOOL_ANNOTATIONS } from '@/lib/mcp/toolAnnotations';
import { CLI_TOKEN_GRANT, TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { foldersService } from '@/lib/services/foldersService';
import { pagesService } from '@/lib/services/pagesService';
import type { TokenGrant } from '@/lib/tokens/grant';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `move_page` (Story MOTIR-9487 · MOTIR-9556) over real Postgres, driven through
// `buildMcpServer` + an in-memory client. The tool is a thin adapter over
// `pagesService.movePage`: this asserts a page moves under a page, into a folder
// and to the root, a move to where it already is answers `moved: false`, every
// tree rule reaches the agent by its own code (cycle, archived), a destination
// in another project reads as missing,
// an unknown page and another project's page answer the same not-found, and
// the `page:edit` gate — which the token `motir login` mints already passes.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const EDIT: TokenGrant = ['project:browse', 'page:view', 'page:edit'];

async function connectClient(ctx: ServiceContext, grant: TokenGrant): Promise<Client> {
  const server = buildMcpServer(
    () => ctx,
    () => [...grant],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function textOf(res: unknown): string {
  const content = (res as CallToolResult).content ?? [];
  return content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

function structured<T>(res: unknown): T {
  return (res as CallToolResult).structuredContent as unknown as T;
}

async function seedPage(
  fx: { ctx: ServiceContext; projectId: string },
  title: string,
  parent?: { kind: 'page' | 'folder'; id: string },
) {
  return pagesService.createPageFromMarkdown(fx.ctx, {
    projectId: fx.projectId,
    title,
    parent,
    markdown: 'x',
  });
}

describe('move_page', () => {
  it('nests a page under another page, with its ancestors, and the row follows', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedPage(fx, 'Target');
    const page = await seedPage(fx, 'Mover');
    const client = await connectClient(fx.ctx, EDIT);

    const res = await client.callTool({
      name: 'move_page',
      arguments: { projectKey: 'PROD', pageId: page.id, parent: { kind: 'page', id: target.id } },
    });

    expect(res.isError, textOf(res)).toBeFalsy();
    expect(structured<V1PagePlacement>(res)).toMatchObject({
      id: page.id,
      parent: { kind: 'page', id: target.id },
      ancestorPageIds: [target.id],
      moved: true,
    });
    expect(textOf(res)).toContain(`Moved page ${page.id} under page ${target.id}.`);
    const row = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });
    expect(row.parentPageId).toBe(target.id);
    await client.close();
  });

  it('files a page into a folder, then back to the project root', async () => {
    const fx = await makeWorkItemFixture();
    const folder = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Decisions' },
      fx.ctx,
    );
    const page = await seedPage(fx, 'Mover');
    const client = await connectClient(fx.ctx, EDIT);

    const into = await client.callTool({
      name: 'move_page',
      arguments: { projectKey: 'PROD', pageId: page.id, parent: { kind: 'folder', id: folder.id } },
    });
    expect(into.isError, textOf(into)).toBeFalsy();
    expect(structured<V1PagePlacement>(into).parent).toMatchObject({
      kind: 'folder',
      id: folder.id,
    });
    expect(textOf(into)).toContain(`in folder ${folder.id}`);

    const out = await client.callTool({
      name: 'move_page',
      arguments: { projectKey: 'PROD', pageId: page.id, parent: { kind: 'root' } },
    });
    expect(out.isError, textOf(out)).toBeFalsy();
    expect(structured<V1PagePlacement>(out)).toMatchObject({
      parent: { kind: 'root' },
      moved: true,
    });
    const row = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });
    expect(row.folderId).toBeNull();
    expect(row.parentPageId).toBeNull();
    await client.close();
  });

  it('a move to where the page already is writes nothing and answers `moved: false`', async () => {
    const fx = await makeWorkItemFixture();
    const page = await seedPage(fx, 'Stay');
    const client = await connectClient(fx.ctx, EDIT);

    const res = await client.callTool({
      name: 'move_page',
      arguments: { projectKey: 'PROD', pageId: page.id, parent: { kind: 'root' } },
    });

    expect(res.isError, textOf(res)).toBeFalsy();
    expect(structured<V1PagePlacement>(res).moved).toBe(false);
    expect(textOf(res)).toContain('nothing moved');
    await client.close();
  });

  it('a page under its own sub-page is refused PAGE_CYCLE and stays put', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await seedPage(fx, 'Parent');
    const child = await seedPage(fx, 'Child', { kind: 'page', id: parent.id });
    const client = await connectClient(fx.ctx, EDIT);

    const res = await client.callTool({
      name: 'move_page',
      arguments: { projectKey: 'PROD', pageId: parent.id, parent: { kind: 'page', id: child.id } },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('PAGE_CYCLE');
    const row = await adminDb.page.findUniqueOrThrow({ where: { id: parent.id } });
    expect(row.parentPageId).toBeNull();
    await client.close();
  });

  it('a destination page in another project is refused PAGE_NOT_FOUND, as an unknown id is, and nothing moves', async () => {
    const fx = await makeWorkItemFixture();
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const elsewhere = await seedPage({ ctx: fx.ctx, projectId: other.id }, 'Elsewhere');
    const page = await seedPage(fx, 'Mover');
    const client = await connectClient(fx.ctx, EDIT);

    const res = await client.callTool({
      name: 'move_page',
      arguments: {
        projectKey: 'PROD',
        pageId: page.id,
        parent: { kind: 'page', id: elsewhere.id },
      },
    });

    // The project-narrowed context hides the foreign page, so the package's
    // CROSS_PROJECT_PAGE_PARENT is never reached: it reads as missing and says
    // nothing about the other project.
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('PAGE_NOT_FOUND');
    expect(textOf(res)).not.toContain('Elsewhere');
    const row = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });
    expect(row.parentPageId).toBeNull();
    await client.close();
  });

  it('an archived page is refused PAGE_ARCHIVED by name', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedPage(fx, 'Target');
    const page = await seedPage(fx, 'Archived');
    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: page.id });
    const client = await connectClient(fx.ctx, EDIT);

    const res = await client.callTool({
      name: 'move_page',
      arguments: { projectKey: 'PROD', pageId: page.id, parent: { kind: 'page', id: target.id } },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('PAGE_ARCHIVED');
    await client.close();
  });

  it('an unknown page and another project’s page answer the same PAGE_NOT_FOUND, naming no title', async () => {
    const fx = await makeWorkItemFixture();
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const foreign = await seedPage({ ctx: fx.ctx, projectId: other.id }, 'Secret plan');
    const client = await connectClient(fx.ctx, EDIT);

    const unknown = await client.callTool({
      name: 'move_page',
      arguments: { projectKey: 'PROD', pageId: 'page_missing', parent: { kind: 'root' } },
    });
    const wrongProject = await client.callTool({
      name: 'move_page',
      arguments: { projectKey: 'PROD', pageId: foreign.id, parent: { kind: 'root' } },
    });

    for (const res of [unknown, wrongProject]) {
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('PAGE_NOT_FOUND');
      expect(textOf(res)).not.toContain('Secret plan');
    }
    await client.close();
  });

  it('a `page` parent with no id is refused PAGE_PARENT_ID_REQUIRED', async () => {
    const fx = await makeWorkItemFixture();
    const page = await seedPage(fx, 'Mover');
    const client = await connectClient(fx.ctx, EDIT);

    const res = await client.callTool({
      name: 'move_page',
      arguments: { projectKey: 'PROD', pageId: page.id, parent: { kind: 'page' } },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('PAGE_PARENT_ID_REQUIRED');
    await client.close();
  });

  it('`page:view` without `page:edit` is refused, naming `page:edit`', async () => {
    const fx = await makeWorkItemFixture();
    const page = await seedPage(fx, 'Mover');
    const client = await connectClient(fx.ctx, ['project:browse', 'page:view']);

    const res = await client.callTool({
      name: 'move_page',
      arguments: { projectKey: 'PROD', pageId: page.id, parent: { kind: 'root' } },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(textOf(res)).toContain('page:edit');
    await client.close();
  });

  it('the token `motir login` mints reaches it', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedPage(fx, 'Target');
    const page = await seedPage(fx, 'Mover');
    const client = await connectClient(fx.ctx, [...CLI_TOKEN_GRANT]);

    const res = await client.callTool({
      name: 'move_page',
      arguments: { projectKey: 'PROD', pageId: page.id, parent: { kind: 'page', id: target.id } },
    });

    expect(res.isError, textOf(res)).toBeFalsy();
    await client.close();
  });

  it('asserts `page:edit` and is annotated an idempotent destructive write', () => {
    expect(TOOL_PERMISSIONS.move_page).toBe('page:edit');
    expect(CLI_TOKEN_GRANT).toContain('page:edit');
    expect(TOOL_ANNOTATIONS.move_page).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
  });
});

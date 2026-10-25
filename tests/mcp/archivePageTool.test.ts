import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ArchivePageResultDto, RestorePageResultDto } from '@/lib/dto/pages';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { TOOL_ANNOTATIONS } from '@/lib/mcp/toolAnnotations';
import { CLI_TOKEN_GRANT, TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { pagesService } from '@/lib/services/pagesService';
import type { TokenGrant } from '@/lib/tokens/grant';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `archive_page` (Story MOTIR-9487 · MOTIR-9557) over real Postgres, driven
// through `buildMcpServer` + an in-memory client. The tool is a thin adapter over
// `pagesService.archivePage` / `restorePage`: this asserts an archive takes the
// live sub-pages, a restore brings them back and says when the page landed
// somewhere else, each state refusal arrives by its own code, an unknown page and
// another project's page answer the same not-found, and the `page:edit` gate —
// which the token `motir login` mints already passes.

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

describe('archive_page', () => {
  it('archives a page with its live sub-pages, deleting nothing', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await seedPage(fx, 'Parent');
    const child = await seedPage(fx, 'Child', { kind: 'page', id: parent.id });
    const client = await connectClient(fx.ctx, EDIT);

    const res = await client.callTool({
      name: 'archive_page',
      arguments: { projectKey: 'PROD', pageId: parent.id },
    });

    expect(res.isError, textOf(res)).toBeFalsy();
    const out = structured<ArchivePageResultDto>(res);
    expect(out.rootId).toBe(parent.id);
    expect(out.archivedIds).toEqual([parent.id, child.id]);
    expect(out.subPageCount).toBe(1);
    expect(textOf(res)).toContain(`Archived page ${parent.id} with 1 sub-page.`);
    const rows = await adminDb.page.findMany({ where: { id: { in: [parent.id, child.id] } } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.archivedAt !== null)).toBe(true);
    await client.close();
  });

  it('restores an archive root with its sub-pages, where it was', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await seedPage(fx, 'Parent');
    const child = await seedPage(fx, 'Child', { kind: 'page', id: parent.id });
    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: parent.id });
    const client = await connectClient(fx.ctx, EDIT);

    const res = await client.callTool({
      name: 'archive_page',
      arguments: { projectKey: 'PROD', pageId: parent.id, action: 'restore' },
    });

    expect(res.isError, textOf(res)).toBeFalsy();
    const out = structured<RestorePageResultDto>(res);
    expect(new Set(out.restoredIds)).toEqual(new Set([parent.id, child.id]));
    expect(out.landing.kind).toBe('original');
    expect(textOf(res)).toContain('where it was');
    const row = await adminDb.page.findUniqueOrThrow({ where: { id: child.id } });
    expect(row.archivedAt).toBeNull();
    await client.close();
  });

  it('a restore whose parent is gone lands elsewhere, and the text says so', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await seedPage(fx, 'Parent');
    const child = await seedPage(fx, 'Child', { kind: 'page', id: parent.id });
    // The child leaves first, on its own; then its parent is archived without it.
    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: child.id });
    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: parent.id });
    const client = await connectClient(fx.ctx, EDIT);

    const res = await client.callTool({
      name: 'archive_page',
      arguments: { projectKey: 'PROD', pageId: child.id, action: 'restore' },
    });

    expect(res.isError, textOf(res)).toBeFalsy();
    const out = structured<RestorePageResultDto>(res);
    expect(out.landing.kind).not.toBe('original');
    expect(textOf(res)).toContain('because its parent');
    await client.close();
  });

  it('archiving an archived page is refused PAGE_ARCHIVED', async () => {
    const fx = await makeWorkItemFixture();
    const page = await seedPage(fx, 'Gone');
    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: page.id });
    const client = await connectClient(fx.ctx, EDIT);

    const res = await client.callTool({
      name: 'archive_page',
      arguments: { projectKey: 'PROD', pageId: page.id },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('PAGE_ARCHIVED');
    expect(textOf(res)).not.toContain('Gone');
    await client.close();
  });

  it('restoring a live page is refused PAGE_NOT_ARCHIVED', async () => {
    const fx = await makeWorkItemFixture();
    const page = await seedPage(fx, 'Live');
    const client = await connectClient(fx.ctx, EDIT);

    const res = await client.callTool({
      name: 'archive_page',
      arguments: { projectKey: 'PROD', pageId: page.id, action: 'restore' },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('PAGE_NOT_ARCHIVED');
    await client.close();
  });

  it('restoring a sub-page archived with its parent is refused PAGE_ARCHIVE_ROOT_REQUIRED', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await seedPage(fx, 'Parent');
    const child = await seedPage(fx, 'Child', { kind: 'page', id: parent.id });
    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: parent.id });
    const client = await connectClient(fx.ctx, EDIT);

    const res = await client.callTool({
      name: 'archive_page',
      arguments: { projectKey: 'PROD', pageId: child.id, action: 'restore' },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('PAGE_ARCHIVE_ROOT_REQUIRED');
    const row = await adminDb.page.findUniqueOrThrow({ where: { id: child.id } });
    expect(row.archivedAt).not.toBeNull();
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
      name: 'archive_page',
      arguments: { projectKey: 'PROD', pageId: 'page_missing' },
    });
    const wrongProject = await client.callTool({
      name: 'archive_page',
      arguments: { projectKey: 'PROD', pageId: foreign.id },
    });

    for (const res of [unknown, wrongProject]) {
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('PAGE_NOT_FOUND');
      expect(textOf(res)).not.toContain('Secret plan');
    }
    const row = await adminDb.page.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(row.archivedAt).toBeNull();
    await client.close();
  });

  it('`page:view` without `page:edit` is refused, naming `page:edit`', async () => {
    const fx = await makeWorkItemFixture();
    const page = await seedPage(fx, 'Notes');
    const client = await connectClient(fx.ctx, ['project:browse', 'page:view']);

    const res = await client.callTool({
      name: 'archive_page',
      arguments: { projectKey: 'PROD', pageId: page.id },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(textOf(res)).toContain('page:edit');
    await client.close();
  });

  it('the token `motir login` mints reaches it', async () => {
    const fx = await makeWorkItemFixture();
    const page = await seedPage(fx, 'Notes');
    const client = await connectClient(fx.ctx, [...CLI_TOKEN_GRANT]);

    const res = await client.callTool({
      name: 'archive_page',
      arguments: { projectKey: 'PROD', pageId: page.id },
    });

    expect(res.isError, textOf(res)).toBeFalsy();
    await client.close();
  });

  it('asserts `page:edit` and is annotated a non-idempotent destructive write', () => {
    expect(TOOL_PERMISSIONS.archive_page).toBe('page:edit');
    expect(TOOL_ANNOTATIONS.archive_page).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
  });
});

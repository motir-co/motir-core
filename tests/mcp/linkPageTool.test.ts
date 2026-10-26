import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { checkPayloadDrift } from '@/lib/mcp/payloads/driftGuard';
import { TOOL_PAYLOADS } from '@/lib/mcp/payloads/registry';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { TOOL_ANNOTATIONS } from '@/lib/mcp/toolAnnotations';
import { CLI_TOKEN_GRANT, TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { pageLinksService } from '@/lib/services/pageLinksService';
import { pagesService } from '@/lib/services/pagesService';
import type { TokenGrant } from '@/lib/tokens/grant';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `link_page` (Story MOTIR-9487 · MOTIR-9558) over real Postgres, driven through
// `buildMcpServer` + an in-memory client. The tool is a thin adapter over
// `pageLinksService.linkPageForWorkItem` / `unlinkPageForWorkItem` that owns three
// things the service does not: an idempotent link (`changed: false`), the
// cross-project check by name (`CROSS_PROJECT_LINK`, the page end only when the
// caller can see the page's project), and no title in any refusal.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const EDIT_LINK: TokenGrant = ['project:browse', 'page:view', 'page:edit', 'work_item:edit'];

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

interface LinkPayload {
  pageId: string;
  workItemId: string;
  source: string;
  action: string;
  changed: boolean;
}

async function manualRows(pageId: string, workItemId: string) {
  return adminDb.pageWorkItemLink.count({ where: { pageId, workItemId, source: 'manual' } });
}

describe('link_page', () => {
  it('links a page to a work item of its project, and the link shows on the work item', async () => {
    const fx = await makeWorkItemFixture();
    const page = await seedPage(fx, 'Spec');
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'A task' });
    const client = await connectClient(fx.ctx, EDIT_LINK);

    const res = await client.callTool({
      name: 'link_page',
      arguments: { projectKey: 'PROD', pageId: page.id, workItemKey: item.identifier },
    });

    expect(res.isError, textOf(res)).toBeFalsy();
    expect(structured<LinkPayload>(res)).toEqual({
      pageId: page.id,
      workItemId: item.id,
      source: 'manual',
      action: 'link',
      changed: true,
    });
    // The pair inside it IS v1's `PageLinkPair` (MOTIR-9604).
    expect(checkPayloadDrift(TOOL_PAYLOADS.link_page!, structured(res))).toEqual([]);
    expect(textOf(res)).toContain(`Linked page ${page.id} to ${item.identifier}.`);
    const strip = await pageLinksService.listPagesForWorkItem(fx.ctx, { workItemId: item.id });
    expect(strip.rows.map((r) => r.pageId)).toContain(page.id);
    await client.close();
  });

  it('linking the same pair again succeeds with `changed: false` and writes no second row', async () => {
    const fx = await makeWorkItemFixture();
    const page = await seedPage(fx, 'Spec');
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'A task' });
    const client = await connectClient(fx.ctx, EDIT_LINK);
    const args = { projectKey: 'PROD', pageId: page.id, workItemKey: item.identifier };

    await client.callTool({ name: 'link_page', arguments: args });
    const again = await client.callTool({ name: 'link_page', arguments: args });

    expect(again.isError, textOf(again)).toBeFalsy();
    expect(structured<LinkPayload>(again).changed).toBe(false);
    expect(checkPayloadDrift(TOOL_PAYLOADS.link_page!, structured(again))).toEqual([]);
    expect(textOf(again)).toContain('nothing changed');
    expect(await manualRows(page.id, item.id)).toBe(1);
    await client.close();
  });

  it('unlinks the hand link; unlinking again is refused PAGE_LINK_NOT_FOUND', async () => {
    const fx = await makeWorkItemFixture();
    const page = await seedPage(fx, 'Spec');
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'A task' });
    const client = await connectClient(fx.ctx, EDIT_LINK);
    const args = { projectKey: 'PROD', pageId: page.id, workItemKey: item.identifier };
    await client.callTool({ name: 'link_page', arguments: args });

    const res = await client.callTool({
      name: 'link_page',
      arguments: { ...args, action: 'unlink' },
    });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(structured<LinkPayload>(res)).toMatchObject({ action: 'unlink', changed: true });
    expect(await manualRows(page.id, item.id)).toBe(0);

    const again = await client.callTool({
      name: 'link_page',
      arguments: { ...args, action: 'unlink' },
    });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toContain('PAGE_LINK_NOT_FOUND');
    await client.close();
  });

  it('an archived page cannot be linked, but a link to one archived since can be removed', async () => {
    const fx = await makeWorkItemFixture();
    const linked = await seedPage(fx, 'Linked');
    const archived = await seedPage(fx, 'Archived');
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'A task' });
    const client = await connectClient(fx.ctx, EDIT_LINK);
    await client.callTool({
      name: 'link_page',
      arguments: { projectKey: 'PROD', pageId: linked.id, workItemKey: item.identifier },
    });
    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: linked.id });
    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: archived.id });

    const refused = await client.callTool({
      name: 'link_page',
      arguments: { projectKey: 'PROD', pageId: archived.id, workItemKey: item.identifier },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('PAGE_ARCHIVED');
    expect(textOf(refused)).not.toContain('Archived');

    const removed = await client.callTool({
      name: 'link_page',
      arguments: {
        projectKey: 'PROD',
        pageId: linked.id,
        workItemKey: item.identifier,
        action: 'unlink',
      },
    });
    expect(removed.isError, textOf(removed)).toBeFalsy();
    expect(await manualRows(linked.id, item.id)).toBe(0);
    await client.close();
  });

  it('a work item in another project is refused CROSS_PROJECT_LINK and nothing is written', async () => {
    const fx = await makeWorkItemFixture();
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const page = await seedPage(fx, 'Spec');
    const foreignItem = await createTestWorkItem(
      { ...fx, projectId: other.id, projectIdentifier: other.identifier },
      { kind: 'task', title: 'Foreign task' },
    );
    const client = await connectClient(fx.ctx, EDIT_LINK);

    const res = await client.callTool({
      name: 'link_page',
      arguments: { projectKey: 'PROD', pageId: page.id, workItemKey: foreignItem.identifier },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('CROSS_PROJECT_LINK');
    expect(textOf(res)).not.toContain('Foreign task');
    expect(await adminDb.pageWorkItemLink.count({ where: { workItemId: foreignItem.id } })).toBe(0);
    await client.close();
  });

  it('a page in another project the caller can view is refused CROSS_PROJECT_LINK', async () => {
    const fx = await makeWorkItemFixture();
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const foreignPage = await seedPage({ ctx: fx.ctx, projectId: other.id }, 'Foreign page');
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'A task' });
    const client = await connectClient(fx.ctx, EDIT_LINK);

    const res = await client.callTool({
      name: 'link_page',
      arguments: { projectKey: 'PROD', pageId: foreignPage.id, workItemKey: item.identifier },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('CROSS_PROJECT_LINK');
    expect(textOf(res)).not.toContain('Foreign page');
    await client.close();
  });

  it('a page the caller cannot see answers PAGE_NOT_FOUND, the same as an unknown id', async () => {
    const fx = await makeWorkItemFixture();
    const stranger = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    const hidden = await seedPage(stranger, 'Hidden plan');
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'A task' });
    const client = await connectClient(fx.ctx, EDIT_LINK);

    const unseen = await client.callTool({
      name: 'link_page',
      arguments: { projectKey: 'PROD', pageId: hidden.id, workItemKey: item.identifier },
    });
    const unknown = await client.callTool({
      name: 'link_page',
      arguments: { projectKey: 'PROD', pageId: 'page_missing', workItemKey: item.identifier },
    });

    for (const res of [unseen, unknown]) {
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('PAGE_NOT_FOUND');
      expect(textOf(res)).not.toContain('Hidden plan');
    }
    expect(textOf(unseen)).toBe(textOf(unknown).replace('page_missing', hidden.id));
    await client.close();
  });

  it('a work item the caller cannot browse is not found, naming no title', async () => {
    const fx = await makeWorkItemFixture();
    const stranger = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    const hiddenItem = await createTestWorkItem(stranger, { kind: 'task', title: 'Secret task' });
    const page = await seedPage(fx, 'Spec');
    const client = await connectClient(fx.ctx, EDIT_LINK);

    const res = await client.callTool({
      name: 'link_page',
      arguments: { projectKey: 'PROD', pageId: page.id, workItemKey: hiddenItem.identifier },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/NOT_FOUND/);
    expect(textOf(res)).not.toContain('Secret task');
    await client.close();
  });

  it('`page:view` without `page:edit` is refused, naming `page:edit`', async () => {
    const fx = await makeWorkItemFixture();
    const page = await seedPage(fx, 'Spec');
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'A task' });
    const client = await connectClient(fx.ctx, ['project:browse', 'page:view', 'work_item:edit']);

    const res = await client.callTool({
      name: 'link_page',
      arguments: { projectKey: 'PROD', pageId: page.id, workItemKey: item.identifier },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(textOf(res)).toContain('page:edit');
    await client.close();
  });

  it('the token `motir login` mints reaches it', async () => {
    const fx = await makeWorkItemFixture();
    const page = await seedPage(fx, 'Spec');
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'A task' });
    const client = await connectClient(fx.ctx, [...CLI_TOKEN_GRANT]);

    const res = await client.callTool({
      name: 'link_page',
      arguments: { projectKey: 'PROD', pageId: page.id, workItemKey: item.identifier },
    });

    expect(res.isError, textOf(res)).toBeFalsy();
    await client.close();
  });

  it('asserts `page:edit` and is annotated a non-idempotent destructive write', () => {
    expect(TOOL_PERMISSIONS.link_page).toBe('page:edit');
    expect(CLI_TOKEN_GRANT).toEqual(expect.arrayContaining(['page:edit', 'work_item:edit']));
    expect(TOOL_ANNOTATIONS.link_page).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
  });
});

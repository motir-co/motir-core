import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { mcpToolRows } from '@/lib/apiDocs/mcp';
import { MCP_TOOL_INPUT_SCHEMAS } from '@/lib/apiDocs/mcpToolSchemas';
import { db } from '@/lib/db';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { TOOL_ANNOTATIONS } from '@/lib/mcp/toolAnnotations';
import { CLI_TOKEN_GRANT, TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { foldersService } from '@/lib/services/foldersService';
import { pagesService } from '@/lib/services/pagesService';
import type { TokenGrant } from '@/lib/tokens/grant';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestProject } from '../../fixtures/projectFixtures';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE STORY GATE for Story MOTIR-9487 (MOTIR-9559) — `move_page`, `archive_page`
// and `link_page` as ONE assembled set.
//
// Each tool card tested its own tool (`tests/mcp/{move,archive,link}PageTool.test.ts`).
// This file drives the three TOGETHER through an in-memory MCP client over
// `buildMcpServer`, on real Postgres, so what only the set can break is caught:
//
//   1  AGREEMENT — every name is registered once and present in every home a tool
//      has (permission map, annotations, published catalogue, generated input
//      schema, `docs/mcp.md`); a missing home fails NAMING the home.
//   2  THE GRANT — a token holding only `CLI_TOKEN_GRANT` reaches all three.
//   3  BEHAVIOUR AND EVERY REFUSAL BY CODE — asserted on the code, not the prose.
//   4  NO LEAK — a sentinel page title and work item title appear in no refusal
//      text or structured content of any of the three tools.

const TOOLS = ['move_page', 'archive_page', 'link_page'] as const;
const PAGE_SENTINEL = 'ZZ-SENTINEL-PAGE-7f3a';
const ITEM_SENTINEL = 'ZZ-SENTINEL-ITEM-7f3a';
const EDIT: TokenGrant = ['project:browse', 'page:view', 'page:edit', 'work_item:edit'];

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function connectClient(ctx: ServiceContext, grant: TokenGrant): Promise<Client> {
  const server = buildMcpServer(
    () => ctx,
    () => [...grant],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'story-gate', version: '0.0.0' });
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

/** The code a refusal carries — the text's leading `CODE:`, the toolError shape. */
function codeOf(res: unknown): string | null {
  if (!(res as CallToolResult).isError) return null;
  return /^([A-Z][A-Z0-9_]+)\b/.exec(textOf(res))?.[1] ?? null;
}

/** Everything a result tells the caller, flattened, for the leak assertion. */
function everythingIn(res: unknown): string {
  return `${textOf(res)}\n${JSON.stringify((res as CallToolResult).structuredContent ?? null)}`;
}

function seedPage(
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

/** Two projects in one workspace, and a stranger workspace the caller cannot see. */
async function seedWorld() {
  const fx = await makeWorkItemFixture();
  const other = await createTestProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ownerId,
    identifier: 'OTHR',
  });
  const otherFx: WorkItemFixture = {
    ...fx,
    project: other,
    projectId: other.id,
    projectIdentifier: other.identifier,
  };
  const stranger = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
  return { fx, otherFx, stranger };
}

describe('Story MOTIR-9487 gate — the three page tools agree in every home', () => {
  it('lists move_page, archive_page and link_page once each, beside the page tools', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx, EDIT);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of [...TOOLS, 'get_page', 'create_page', 'update_page']) {
      expect(
        names.filter((n) => n === name),
        `${name} in tools/list`,
      ).toHaveLength(1);
    }
    await client.close();
  });

  it.each(TOOLS)('%s is in every home a tool has', (name) => {
    const docs = readFileSync(resolve(process.cwd(), 'docs/mcp.md'), 'utf8');
    const homes: Record<string, boolean> = {
      MCP_TOOL_NAMES: (MCP_TOOL_NAMES as readonly string[]).includes(name),
      'TOOL_PERMISSIONS (page:edit)': TOOL_PERMISSIONS[name] === 'page:edit',
      TOOL_ANNOTATIONS: TOOL_ANNOTATIONS[name] !== undefined,
      'published catalogue (mcpToolRows)': mcpToolRows().some((r) => r.name === name),
      MCP_TOOL_INPUT_SCHEMAS: MCP_TOOL_INPUT_SCHEMAS[name] !== undefined,
      'docs/mcp.md section': docs.includes(`#### \`${name}\``),
    };
    const missing = Object.entries(homes)
      .filter(([, present]) => !present)
      .map(([home]) => home);
    expect(missing, `${name} is missing from`).toEqual([]);
  });

  it('a token holding only CLI_TOKEN_GRANT reaches all three tools', async () => {
    expect(CLI_TOKEN_GRANT).toEqual(expect.arrayContaining(['page:edit', 'work_item:edit']));
    const fx = await makeWorkItemFixture();
    const target = await seedPage(fx, 'Target');
    const page = await seedPage(fx, 'Mover');
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'A task' });
    const client = await connectClient(fx.ctx, [...CLI_TOKEN_GRANT]);

    const results = [
      await client.callTool({
        name: 'move_page',
        arguments: { projectKey: 'PROD', pageId: page.id, parent: { kind: 'page', id: target.id } },
      }),
      await client.callTool({
        name: 'link_page',
        arguments: { projectKey: 'PROD', pageId: page.id, workItemKey: item.identifier },
      }),
      await client.callTool({
        name: 'archive_page',
        arguments: { projectKey: 'PROD', pageId: page.id },
      }),
    ];
    for (const res of results) expect(res.isError, textOf(res)).toBeFalsy();
    await client.close();
  });
});

describe('Story MOTIR-9487 gate — move_page', () => {
  it('moves under a page, into a folder and to the root; the same place again is moved: false', async () => {
    const { fx } = await seedWorld();
    const folder = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Specs' },
      fx.ctx,
    );
    const target = await seedPage(fx, 'Target');
    const page = await seedPage(fx, 'Mover');
    const client = await connectClient(fx.ctx, EDIT);
    const move = (parent: Record<string, string>) =>
      client.callTool({
        name: 'move_page',
        arguments: { projectKey: 'PROD', pageId: page.id, parent },
      });

    const under = await move({ kind: 'page', id: target.id });
    expect(structured<Record<string, unknown>>(under)).toMatchObject({
      id: page.id,
      parent: { kind: 'page', id: target.id },
      ancestorPageIds: [target.id],
      moved: true,
    });
    expect(typeof structured<{ position: string }>(under).position).toBe('string');
    expect(
      structured<Record<string, unknown>>(await move({ kind: 'folder', id: folder.id })),
    ).toMatchObject({
      parent: { kind: 'folder', id: folder.id },
      moved: true,
    });
    expect(structured<Record<string, unknown>>(await move({ kind: 'root' }))).toMatchObject({
      parent: { kind: 'root' },
      moved: true,
    });
    const again = await move({ kind: 'root' });
    expect(again.isError, textOf(again)).toBeFalsy();
    expect(structured<{ moved: boolean }>(again).moved).toBe(false);
    await client.close();
  });

  it('refuses a cycle, another project’s destination and an archived page, each by code', async () => {
    const { fx, otherFx } = await seedWorld();
    const parent = await seedPage(fx, 'Parent');
    const child = await seedPage(fx, 'Child', { kind: 'page', id: parent.id });
    const archived = await seedPage(fx, PAGE_SENTINEL);
    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: archived.id });
    const foreign = await seedPage(otherFx, PAGE_SENTINEL);
    const client = await connectClient(fx.ctx, EDIT);
    const move = (pageId: string, parentArg: Record<string, string>) =>
      client.callTool({
        name: 'move_page',
        arguments: { projectKey: 'PROD', pageId, parent: parentArg },
      });

    const cycle = await move(parent.id, { kind: 'page', id: child.id });
    const crossProject = await move(child.id, { kind: 'page', id: foreign.id });
    const archivedMove = await move(archived.id, { kind: 'root' });

    expect(codeOf(cycle)).toBe('PAGE_CYCLE');
    // The project-narrowed context hides the foreign page: it reads as missing,
    // the same as an unknown id (MOTIR-9556's recorded discrepancy).
    expect(codeOf(crossProject)).toBe('PAGE_NOT_FOUND');
    expect(codeOf(archivedMove)).toBe('PAGE_ARCHIVED');
    for (const res of [cycle, crossProject, archivedMove]) {
      expect(everythingIn(res)).not.toContain(PAGE_SENTINEL);
    }
    expect((await adminDb.page.findUniqueOrThrow({ where: { id: child.id } })).parentPageId).toBe(
      parent.id,
    );
    await client.close();
  });
});

describe('Story MOTIR-9487 gate — archive_page', () => {
  it('archives a page with its live sub-pages, then restores the root', async () => {
    const { fx } = await seedWorld();
    const parent = await seedPage(fx, 'Parent');
    const child = await seedPage(fx, 'Child', { kind: 'page', id: parent.id });
    const client = await connectClient(fx.ctx, EDIT);

    const archived = await client.callTool({
      name: 'archive_page',
      arguments: { projectKey: 'PROD', pageId: parent.id },
    });
    expect(structured<Record<string, unknown>>(archived)).toEqual({
      archivedIds: [parent.id, child.id],
      rootId: parent.id,
      subPageCount: 1,
    });

    const restored = await client.callTool({
      name: 'archive_page',
      arguments: { projectKey: 'PROD', pageId: parent.id, action: 'restore' },
    });
    const out = structured<{ restoredIds: string[]; landing: { kind: string } }>(restored);
    expect(new Set(out.restoredIds)).toEqual(new Set([parent.id, child.id]));
    expect(out.landing.kind).toBe('original');
    await client.close();
  });

  it('refuses archiving an archived page, restoring a live one and restoring a non-root, by code', async () => {
    const { fx } = await seedWorld();
    const parent = await seedPage(fx, PAGE_SENTINEL);
    const child = await seedPage(fx, PAGE_SENTINEL, { kind: 'page', id: parent.id });
    const live = await seedPage(fx, PAGE_SENTINEL);
    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: parent.id });
    const client = await connectClient(fx.ctx, EDIT);
    const call = (pageId: string, action: 'archive' | 'restore') =>
      client.callTool({ name: 'archive_page', arguments: { projectKey: 'PROD', pageId, action } });

    const twice = await call(parent.id, 'archive');
    const restoreLive = await call(live.id, 'restore');
    const restoreChild = await call(child.id, 'restore');

    expect(codeOf(twice)).toBe('PAGE_ARCHIVED');
    expect(codeOf(restoreLive)).toBe('PAGE_NOT_ARCHIVED');
    expect(codeOf(restoreChild)).toBe('PAGE_ARCHIVE_ROOT_REQUIRED');
    for (const res of [twice, restoreLive, restoreChild]) {
      expect(everythingIn(res)).not.toContain(PAGE_SENTINEL);
    }
    await client.close();
  });
});

describe('Story MOTIR-9487 gate — link_page', () => {
  it('links (changed: true), links again (changed: false, one row) and unlinks', async () => {
    const { fx } = await seedWorld();
    const page = await seedPage(fx, 'Spec');
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'A task' });
    const client = await connectClient(fx.ctx, EDIT);
    const args = { projectKey: 'PROD', pageId: page.id, workItemKey: item.identifier };

    const first = await client.callTool({ name: 'link_page', arguments: args });
    const second = await client.callTool({ name: 'link_page', arguments: args });
    expect(structured<{ changed: boolean }>(first).changed).toBe(true);
    expect(second.isError, textOf(second)).toBeFalsy();
    expect(structured<{ changed: boolean }>(second).changed).toBe(false);
    expect(
      await adminDb.pageWorkItemLink.count({
        where: { pageId: page.id, workItemId: item.id, source: 'manual' },
      }),
    ).toBe(1);

    const unlinked = await client.callTool({
      name: 'link_page',
      arguments: { ...args, action: 'unlink' },
    });
    expect(unlinked.isError, textOf(unlinked)).toBeFalsy();
    expect(
      await adminDb.pageWorkItemLink.count({ where: { pageId: page.id, workItemId: item.id } }),
    ).toBe(0);
    await client.close();
  });

  it('refuses an unlinked unlink and an archived link; a link archived since still unlinks', async () => {
    const { fx } = await seedWorld();
    const linked = await seedPage(fx, PAGE_SENTINEL);
    const archived = await seedPage(fx, PAGE_SENTINEL);
    const never = await seedPage(fx, PAGE_SENTINEL);
    const item = await createTestWorkItem(fx, { kind: 'task', title: ITEM_SENTINEL });
    const client = await connectClient(fx.ctx, EDIT);
    const call = (pageId: string, action: 'link' | 'unlink') =>
      client.callTool({
        name: 'link_page',
        arguments: { projectKey: 'PROD', pageId, workItemKey: item.identifier, action },
      });
    await call(linked.id, 'link');
    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: linked.id });
    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: archived.id });

    const notLinked = await call(never.id, 'unlink');
    const archivedLink = await call(archived.id, 'link');
    const archivedSince = await call(linked.id, 'unlink');

    expect(codeOf(notLinked)).toBe('PAGE_LINK_NOT_FOUND');
    expect(codeOf(archivedLink)).toBe('PAGE_ARCHIVED');
    expect(archivedSince.isError, textOf(archivedSince)).toBeFalsy();
    for (const res of [notLinked, archivedLink]) {
      expect(everythingIn(res)).not.toContain(PAGE_SENTINEL);
      expect(everythingIn(res)).not.toContain(ITEM_SENTINEL);
    }
    await client.close();
  });

  it('refuses another project’s work item and a visible page CROSS_PROJECT_LINK; an unseen page is PAGE_NOT_FOUND', async () => {
    const { fx, otherFx, stranger } = await seedWorld();
    const page = await seedPage(fx, 'Spec');
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'A task' });
    const foreignItem = await createTestWorkItem(otherFx, { kind: 'task', title: ITEM_SENTINEL });
    const foreignPage = await seedPage(otherFx, PAGE_SENTINEL);
    const unseenPage = await seedPage(stranger, PAGE_SENTINEL);
    const client = await connectClient(fx.ctx, EDIT);
    const link = (pageId: string, workItemKey: string) =>
      client.callTool({
        name: 'link_page',
        arguments: { projectKey: 'PROD', pageId, workItemKey },
      });

    const crossItem = await link(page.id, foreignItem.identifier);
    const crossPage = await link(foreignPage.id, item.identifier);
    const unseen = await link(unseenPage.id, item.identifier);
    const unknown = await link('page_missing', item.identifier);

    expect(codeOf(crossItem)).toBe('CROSS_PROJECT_LINK');
    expect(codeOf(crossPage)).toBe('CROSS_PROJECT_LINK');
    expect(codeOf(unseen)).toBe('PAGE_NOT_FOUND');
    expect(textOf(unseen)).toBe(textOf(unknown).replace('page_missing', unseenPage.id));
    for (const res of [crossItem, crossPage, unseen, unknown]) {
      expect(everythingIn(res)).not.toContain(PAGE_SENTINEL);
      expect(everythingIn(res)).not.toContain(ITEM_SENTINEL);
    }
    expect(await adminDb.pageWorkItemLink.count()).toBe(0);
    await client.close();
  });
});

describe('Story MOTIR-9487 gate — access, across all three tools', () => {
  it('a caller without page:edit is refused by every tool and nothing changes', async () => {
    const { fx } = await seedWorld();
    const page = await seedPage(fx, PAGE_SENTINEL);
    const item = await createTestWorkItem(fx, { kind: 'task', title: ITEM_SENTINEL });
    const client = await connectClient(fx.ctx, ['project:browse', 'page:view', 'work_item:edit']);

    const results = [
      await client.callTool({
        name: 'move_page',
        arguments: { projectKey: 'PROD', pageId: page.id, parent: { kind: 'root' } },
      }),
      await client.callTool({
        name: 'archive_page',
        arguments: { projectKey: 'PROD', pageId: page.id },
      }),
      await client.callTool({
        name: 'link_page',
        arguments: { projectKey: 'PROD', pageId: page.id, workItemKey: item.identifier },
      }),
    ];
    for (const res of results) {
      expect(codeOf(res)).toBe(PERMISSION_NOT_GRANTED_CODE);
      expect(textOf(res)).toContain('page:edit');
      expect(everythingIn(res)).not.toContain(PAGE_SENTINEL);
    }
    const row = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });
    expect(row.archivedAt).toBeNull();
    expect(await adminDb.pageWorkItemLink.count()).toBe(0);
    await client.close();
  });

  it.each(TOOLS)(
    '%s: a caller who cannot browse the project and an unknown id get the same not-found, with no title',
    async (name) => {
      const { fx, stranger } = await seedWorld();
      const page = await seedPage(fx, PAGE_SENTINEL);
      const item = await createTestWorkItem(fx, { kind: 'task', title: ITEM_SENTINEL });
      const args = (pageId: string): Record<string, unknown> => {
        const base = { projectKey: 'PROD', pageId };
        if (name === 'move_page') return { ...base, parent: { kind: 'root' } };
        if (name === 'link_page') return { ...base, workItemKey: item.identifier };
        return base;
      };
      const outsider = await connectClient(stranger.ctx, EDIT);
      const member = await connectClient(fx.ctx, EDIT);

      const noAccess = await outsider.callTool({ name, arguments: args(page.id) });
      const unknown = await member.callTool({ name, arguments: args('page_missing') });

      expect(noAccess.isError).toBe(true);
      expect(unknown.isError).toBe(true);
      expect(codeOf(noAccess)).toMatch(/NOT_FOUND$/);
      expect(codeOf(unknown)).toMatch(/NOT_FOUND$/);
      for (const res of [noAccess, unknown]) {
        expect(everythingIn(res)).not.toContain(PAGE_SENTINEL);
        expect(everythingIn(res)).not.toContain(ITEM_SENTINEL);
      }
      await outsider.close();
      await member.close();
    },
  );
});

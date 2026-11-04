import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import type { DecisionPagePublicationDto } from '@/lib/dto/decisionPage';
import { buildMcpServer } from '@/lib/mcp/registry';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
import { CLI_TOKEN_GRANT, TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { pagesService } from '@/lib/services/pagesService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { TokenGrant } from '@/lib/tokens/grant';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `publish_decision_page` (Story MOTIR-5761 · MOTIR-7434) over real Postgres,
// driven through `buildMcpServer` + an in-memory client. A thin door over
// `decisionPageService.publish` (whose own suite covers the transaction): this
// asserts the dispatched token can call it, the publication + gate id it
// returns, the `work_item:edit` gate, and every refusal surfacing by name.

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
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
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const textOf = (res: unknown) =>
  ((res as CallToolResult).content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
const publicationOf = (res: unknown) =>
  (res as CallToolResult).structuredContent as unknown as DecisionPagePublicationDto;
const codeOf = (res: unknown) =>
  ((res as CallToolResult).structuredContent as { error?: { code?: string } } | undefined)?.error
    ?.code ?? textOf(res);

async function card(type: 'decision' | 'code' = 'decision') {
  seq += 1;
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: `Decide ${seq}`,
      type,
      executor: 'coding_agent',
    },
    fx.ctx,
  );
}

const page = (markdown = '# Decision\n\nWe pick option A.') =>
  pagesService.createPageFromMarkdown(fx.ctx, {
    projectId: fx.projectId,
    title: 'Choice',
    markdown,
  });

describe('publish_decision_page', () => {
  it('is keyed `work_item:edit`, a key the dispatched token already carries', () => {
    expect(TOOL_PERMISSIONS.publish_decision_page).toBe('work_item:edit');
    expect(CLI_TOKEN_GRANT).toContain(TOOL_PERMISSIONS.publish_decision_page);
    expect(TOOL_SCOPES.publish_decision_page).toBe('work_items:write');
  });

  it('with the dispatched token, publishes the page and returns the version and the gate id', async () => {
    const item = await card();
    const p = await page();
    const client = await connectClient(fx.ctx, CLI_TOKEN_GRANT);

    const res = await client.callTool({
      name: 'publish_decision_page',
      arguments: { key: item.identifier, pageId: p.id },
    });

    expect(res.isError, textOf(res)).toBeFalsy();
    const dto = publicationOf(res);
    expect(dto).toMatchObject({
      workItemKey: item.identifier,
      pageId: p.id,
      versionNumber: 1,
      replayed: false,
    });
    const gate = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: item.id, kind: 'decision_approval', state: 'awaiting' },
    });
    expect(dto.gateId).toBe(gate.id);
    expect(textOf(res)).toContain('NOT finished');

    const again = await client.callTool({
      name: 'publish_decision_page',
      arguments: { key: item.identifier, pageId: p.id },
    });
    expect(publicationOf(again)).toMatchObject({ id: dto.id, replayed: true });
  });

  it('links the published page to the card, and get_work_item then names it as the decision (MOTIR-10315)', async () => {
    const item = await card();
    const p = await page();
    const client = await connectClient(fx.ctx, CLI_TOKEN_GRANT);

    const res = await client.callTool({
      name: 'publish_decision_page',
      arguments: { key: item.identifier, pageId: p.id },
    });
    expect(res.isError, textOf(res)).toBeFalsy();

    const links = await adminDb.pageWorkItemLink.findMany({ where: { workItemId: item.id } });
    expect(links).toEqual([expect.objectContaining({ pageId: p.id, source: 'manual' })]);

    const read = await client.callTool({
      name: 'get_work_item',
      arguments: { key: item.identifier },
    });
    expect(read.isError, textOf(read)).toBeFalsy();
    const pages = ((read as CallToolResult).structuredContent as { pages: unknown }).pages;
    expect(pages).toMatchObject({
      rows: [{ pageId: p.id, title: 'Choice', decision: { versionNumber: 1 } }],
      hasMore: false,
      decisionPage: { pageId: p.id, title: 'Choice', versionNumber: 1 },
    });
    expect(textOf(read)).toContain(`Decision page: Choice (${p.id}) — published version 1`);
  });

  it('is refused without `work_item:edit`, with nothing written', async () => {
    const item = await card();
    const p = await page();
    const client = await connectClient(fx.ctx, ['project:browse', 'page:view']);

    const res = await client.callTool({
      name: 'publish_decision_page',
      arguments: { key: item.identifier, pageId: p.id },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(await adminDb.decisionPagePublication.count()).toBe(0);
  });

  it('surfaces the service refusals by name', async () => {
    const client = await connectClient(fx.ctx, CLI_TOKEN_GRANT);
    const call = (key: string, pageId: string) =>
      client.callTool({ name: 'publish_decision_page', arguments: { key, pageId } });

    const code = await card('code');
    const p = await page();
    expect(codeOf(await call(code.identifier, p.id))).toContain('NOT_A_DECISION_CARD');

    const decision = await card();
    expect(codeOf(await call(decision.identifier, 'no-such-page'))).toContain('PAGE_NOT_FOUND');

    const blank = await pagesService.createPage(fx.ctx, {
      projectId: fx.projectId,
      title: 'Blank',
    });
    expect(codeOf(await call(decision.identifier, blank.id))).toContain('PAGE_IS_EMPTY');

    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: p.id });
    expect(codeOf(await call(decision.identifier, p.id))).toContain('PAGE_ARCHIVED');

    const fresh = await page();
    await adminDb.workItem.update({ where: { id: decision.id }, data: { status: 'done' } });
    expect(codeOf(await call(decision.identifier, fresh.id))).toContain('CARD_IS_FINISHED');
  });
});

import type { Page, Response } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { test, expect } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import type { PageMarkdownDto } from '@/lib/dto/pages';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { foldersService } from '@/lib/services/foldersService';
import { pageLinksService } from '@/lib/services/pageLinksService';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';

// AN AGENT AND A PERSON WRITE THE SAME PAGE — Story MOTIR-5760's journey
// (Subtask MOTIR-7414), as a regression spec in the main lane.
//
// An agent holding the token `motir login` mints writes a page over `/api/mcp`;
// a person opens it in the shipped editor at `/pages/<id>` and sees what the
// agent wrote; the person types; the agent's write from its stale read is refused
// by name and changes nothing; its write from a fresh read lands beside the
// person's paragraph.
//
// ── NO ACCEPTANCE VIDEO, and this is not the acceptance lane ────────────────
// The story adds no surface of its own: the editor and `/pages/<id>` are Story
// MOTIR-5752's, already accepted with a receipt. What this story adds is a door
// for agents, which is not something a person watches, so it records no paced
// video (the non-UI exemption) and declares no `acceptanceStory()`.
//
// ── THE AGENT ───────────────────────────────────────────────────────────────
// No `motir` binary: the agent is the real MCP SDK transport against the real
// route, carrying a token stored with `CLI_TOKEN_GRANT` IMPORTED from the app —
// the same `fixedGrant` the device flow mints with — so narrowing that constant
// fails this spec rather than a hand-built grant hiding it.
//
// ── THE WAITS (the coding convention § E2E tests wait on the AUTHORITATIVE signal) ──────
// Every agent step waits on its own tool result. The person's typing waits on
// its `POST /api/pages/<id>/updates` response, armed before the keys, and then
// on the save indicator reading Saved. Every page load waits on the editor's
// body textbox before reading it. There is no fixed sleep.

const PASSWORD = 'pages-agent-mcp-e2e-pass-123';
const EMAIL = 'pages-agent-mcp@example.com';
const FOLDER = 'Runbooks';

const AGENT_MARKDOWN = [
  '# Deploy runbook',
  '',
  '- Build the image',
  '  - Tag it with the commit',
  '- Roll it out',
  '',
  '```bash',
  'pnpm deploy --env prod',
  '```',
  '',
  '| Step | Owner |',
  '| --- | --- |',
  '| Rollout | Ana |',
  '',
  '- [x] Dry run done',
  '- [ ] Announce it',
  '',
  'See [the release notes](https://example.com/notes).',
].join('\n');

const PERSON_LINE = 'Ben checked the dashboards after the rollout.';
const AGENT_LINE = 'The agent confirmed the rollback plan.';

interface Seed {
  projectKey: string;
  projectId: string;
  ctx: { userId: string; workspaceId: string };
  folderId: string;
  token: string;
  staleGrantToken: string;
  /** Story MOTIR-9487 — the CLI grant minus `page:edit` (`page:view` kept). */
  noEditToken: string;
}

async function seed(): Promise<Seed> {
  const member = await usersService.createUser({
    email: EMAIL,
    password: PASSWORD,
    name: 'Ben Member',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Ops Workspace',
    ownerUserId: member.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: member.id,
    name: 'Ops',
    identifier: 'OPS',
  });
  await projectsService.setActiveProject({
    userId: member.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  const ctx = { userId: member.id, workspaceId: workspace.id };
  const folder = await foldersService.createFolder(
    { projectId: project.id, parentFolderId: null, name: FOLDER },
    ctx,
  );
  // Exactly what `motir login` stores (`cliDeviceService`'s `fixedGrant`).
  const cli = await apiTokensService.create(member.id, workspace.id, {
    label: 'CLI · agentbox',
    fixedGrant: CLI_TOKEN_GRANT,
  });
  // The device grant as it stood before the page keys joined it.
  const stale = await apiTokensService.create(member.id, workspace.id, {
    label: 'CLI · oldbox',
    fixedGrant: CLI_TOKEN_GRANT.filter((key) => key !== 'page:view' && key !== 'page:edit'),
  });
  // Story MOTIR-9487 — the grant with every key but the page write.
  const noEdit = await apiTokensService.create(member.id, workspace.id, {
    label: 'CLI · readbox',
    fixedGrant: CLI_TOKEN_GRANT.filter((key) => key !== 'page:edit'),
  });
  return {
    projectKey: project.identifier,
    projectId: project.id,
    ctx,
    folderId: folder.id,
    token: cli.token,
    staleGrantToken: stale.token,
    noEditToken: noEdit.token,
  };
}

async function agent(token: string, baseURL: string | undefined): Promise<Client> {
  if (!baseURL) throw new Error('no Playwright baseURL — the MCP transport has nowhere to go');
  const client = new Client({ name: 'pages-agent-mcp', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/api/mcp', baseURL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

async function tool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const textOf = (result: CallToolResult) =>
  (result.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');

/** A tool call that must succeed — a refusal fails the step with its own message. */
async function ok(client: Client, name: string, args: Record<string, unknown>) {
  const result = await tool(client, name, args);
  expect(result.isError ?? false, textOf(result).slice(0, 400)).toBe(false);
  return result.structuredContent as unknown as PageMarkdownDto;
}

const bodyOf = (page: Page) => page.getByRole('textbox', { name: 'Page body', exact: true });
const indicatorOf = (page: Page) =>
  page.getByRole('toolbar', { name: 'Formatting', exact: true }).getByRole('status');

/** Open the page and wait on the editor's body before anything reads it. */
async function openPage(page: Page, pageId: string): Promise<void> {
  await page.goto(`/pages/${pageId}`);
  await expect(bodyOf(page)).toBeVisible();
}

function bodySave(page: Page, pageId: string): Promise<Response> {
  return page.waitForResponse(
    (r) => r.url().endsWith(`/api/pages/${pageId}/updates`) && r.request().method() === 'POST',
  );
}

test('an agent writes a page over the MCP, a person edits it, and the agent rewrites it only from a fresh read', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await resetDatabase();
  const s = await seed();
  const client = await agent(s.token, baseURL);
  let pageId = '';
  let firstRevision = 0;

  await test.step('the agent creates a page from markdown in a folder', async () => {
    const created = await ok(client, 'create_page', {
      projectKey: s.projectKey,
      title: 'Deploy runbook',
      markdown: AGENT_MARKDOWN,
      parent: { kind: 'folder', id: s.folderId },
    });
    expect(created.placement.folderId).toBe(s.folderId);
    pageId = created.id;
    firstRevision = created.revision;
  });

  await test.step('the person opens it and sees what the agent wrote', async () => {
    await signIn(page, EMAIL, PASSWORD);
    await openPage(page, pageId);
    const body = bodyOf(page);
    await expect(body.getByRole('heading', { name: 'Deploy runbook' })).toBeVisible();
    await expect(body.getByText('Build the image')).toBeVisible();
    await expect(body.getByText('Tag it with the commit')).toBeVisible();
    await expect(body.getByText('pnpm deploy --env prod')).toBeVisible();
    await expect(body.getByRole('columnheader', { name: 'Owner' })).toBeVisible();
    await expect(body.getByRole('cell', { name: 'Ana' })).toBeVisible();
    // Exact: since tiptap 3.31 a task item's checkbox carries a hidden label
    // naming the item ("Task item checkbox for Dry run done"), MOTIR-7816.
    await expect(body.getByText('Dry run done', { exact: true })).toBeVisible();
    await expect(body.getByRole('checkbox').first()).toBeChecked();
    await expect(body.getByRole('link', { name: 'the release notes' })).toBeVisible();
  });

  await test.step('the person types a paragraph and it saves', async () => {
    const saved = bodySave(page, pageId);
    await bodyOf(page).getByText('See the release notes').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type(PERSON_LINE);
    expect((await saved).status()).toBe(200);
    await expect(indicatorOf(page)).toHaveText('Saved');
  });

  await test.step('the agent’s write from its stale read is refused by name', async () => {
    const stale = await tool(client, 'update_page', {
      projectKey: s.projectKey,
      pageId,
      markdown: `${AGENT_MARKDOWN}\n\n${AGENT_LINE}`,
      revision: firstRevision,
    });
    expect(stale.isError).toBe(true);
    const message = textOf(stale);
    expect(message).toContain('PAGE_REVISION_CONFLICT');
    expect(message).toContain(`you sent ${firstRevision}`);
    expect(message).toContain('call get_page');
    await openPage(page, pageId);
    await expect(bodyOf(page).getByText(PERSON_LINE)).toBeVisible();
    await expect(bodyOf(page).getByText(AGENT_LINE)).toHaveCount(0);
  });

  await test.step('the agent re-reads, writes from the fresh revision, and both lines show', async () => {
    const fresh = await ok(client, 'get_page', { projectKey: s.projectKey, pageId });
    expect(fresh.markdown).toContain(PERSON_LINE);
    expect(fresh.revision).toBeGreaterThan(firstRevision);
    const written = await ok(client, 'update_page', {
      projectKey: s.projectKey,
      pageId,
      markdown: `${fresh.markdown}\n\n${AGENT_LINE}`,
      revision: fresh.revision,
    });
    expect(written.revision).toBe(fresh.revision + 1);
    await openPage(page, pageId);
    await expect(bodyOf(page).getByText(PERSON_LINE)).toBeVisible();
    await expect(bodyOf(page).getByText(AGENT_LINE)).toBeVisible();
  });

  await test.step('a token from the pre-change device grant is refused, naming page:view', async () => {
    const old = await agent(s.staleGrantToken, baseURL);
    const refused = await tool(old, 'get_page', { projectKey: s.projectKey, pageId });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('page:view');
    await old.close();
  });

  await client.close();
});

// ── Story MOTIR-9487 (MOTIR-9560) — the agent moves, archives and links pages ──
//
// The story's verification recipe over the real `/api/mcp` route with the
// CLI-grant token: `move_page`, `archive_page` and `link_page` listed and called
// over the wire, every refusal asserted by its CODE (the text's leading `CODE:`),
// and a sentinel page / work item title in no refusal. No browser surface: the
// in-process gate (`tests/integration/pages/pageMcpToolsStoryGate.test.ts`) owns
// the cross-tool agreement, the grant derivation and the coverage floor; this
// proves only the transport, the bearer token and the stored grant.

const PAGE_SENTINEL = 'ZZ-SENTINEL-PAGE-9560';
const ITEM_SENTINEL = 'ZZ-SENTINEL-ITEM-9560';

/** The code a refusal carries — `toolError`'s `CODE: message` shape. */
function codeOf(result: CallToolResult): string | null {
  if (!result.isError) return null;
  return /^([A-Z][A-Z0-9_]+)\b/.exec(textOf(result))?.[1] ?? null;
}

const everythingIn = (result: CallToolResult) =>
  `${textOf(result)}\n${JSON.stringify(result.structuredContent ?? null)}`;

/** A tool call that must succeed, returning its structured payload. */
async function okData<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await tool(client, name, args);
  expect(result.isError ?? false, textOf(result).slice(0, 400)).toBe(false);
  return result.structuredContent as unknown as T;
}

test('an agent moves, archives and links pages over the MCP, refused by name across projects and without page:edit', async ({
  baseURL,
}) => {
  test.setTimeout(120_000);
  await resetDatabase();
  const s = await seed();
  const other = await projectsService.createProject({
    workspaceId: s.ctx.workspaceId,
    actorUserId: s.ctx.userId,
    name: 'Finance',
    identifier: 'FIN',
  });
  const opsItem = await workItemsService.createWorkItem(
    { projectId: s.projectId, kind: 'task', title: ITEM_SENTINEL },
    s.ctx,
  );
  const finItem = await workItemsService.createWorkItem(
    { projectId: other.id, kind: 'task', title: ITEM_SENTINEL },
    s.ctx,
  );
  const finPage = await pagesService.createPage(s.ctx, {
    projectId: other.id,
    title: PAGE_SENTINEL,
  });
  const client = await agent(s.token, baseURL);
  const k = s.projectKey;
  const ids = { a: '', b: '', c: '' };
  const linkedPageIds = async () =>
    (await pageLinksService.listPagesForWorkItem(s.ctx, { workItemId: opsItem.id })).rows.map(
      (r) => r.pageId,
    );

  await test.step('tools/list shows the three tools beside the page tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of [
      'move_page',
      'archive_page',
      'link_page',
      'get_page',
      'create_page',
      'update_page',
    ]) {
      expect(
        names.filter((n) => n === name),
        name,
      ).toHaveLength(1);
    }
  });

  await test.step('the agent creates A, B and B’s child C, and nests B under A', async () => {
    ids.a = (await ok(client, 'create_page', { projectKey: k, title: PAGE_SENTINEL })).id;
    ids.b = (await ok(client, 'create_page', { projectKey: k, title: PAGE_SENTINEL })).id;
    ids.c = (
      await ok(client, 'create_page', {
        projectKey: k,
        title: PAGE_SENTINEL,
        parent: { kind: 'page', id: ids.b },
      })
    ).id;
    const placed = await okData<Record<string, unknown>>(client, 'move_page', {
      projectKey: k,
      pageId: ids.b,
      parent: { kind: 'page', id: ids.a },
    });
    expect(placed).toMatchObject({
      id: ids.b,
      parent: { kind: 'page', id: ids.a },
      ancestorPageIds: [ids.a],
      moved: true,
    });
    expect(typeof placed.position).toBe('string');
    const read = await ok(client, 'get_page', { projectKey: k, pageId: ids.b });
    expect(read.placement.parentPageId).toBe(ids.a);
  });

  await test.step('B moves into the folder, to the root, and to the root again (moved: false)', async () => {
    const move = (parent: Record<string, string>) =>
      okData<{ parent: Record<string, string>; moved: boolean }>(client, 'move_page', {
        projectKey: k,
        pageId: ids.b,
        parent,
      });
    expect(await move({ kind: 'folder', id: s.folderId })).toMatchObject({
      parent: { kind: 'folder', id: s.folderId },
      moved: true,
    });
    expect(await move({ kind: 'root' })).toMatchObject({ parent: { kind: 'root' }, moved: true });
    expect((await move({ kind: 'root' })).moved).toBe(false);
  });

  await test.step('A under its own descendant is refused PAGE_CYCLE and nothing moves', async () => {
    await okData(client, 'move_page', {
      projectKey: k,
      pageId: ids.b,
      parent: { kind: 'page', id: ids.a },
    });
    const cycle = await tool(client, 'move_page', {
      projectKey: k,
      pageId: ids.a,
      parent: { kind: 'page', id: ids.c },
    });
    expect(codeOf(cycle)).toBe('PAGE_CYCLE');
    expect(everythingIn(cycle)).not.toContain(PAGE_SENTINEL);
    const a = await ok(client, 'get_page', { projectKey: k, pageId: ids.a });
    const b = await ok(client, 'get_page', { projectKey: k, pageId: ids.b });
    expect(a.placement.parentPageId).toBeNull();
    expect(b.placement.parentPageId).toBe(ids.a);
  });

  await test.step('B is archived with its child C', async () => {
    const archived = await okData<{ archivedIds: string[]; rootId: string; subPageCount: number }>(
      client,
      'archive_page',
      { projectKey: k, pageId: ids.b },
    );
    expect(archived).toEqual({ archivedIds: [ids.b, ids.c], rootId: ids.b, subPageCount: 1 });
  });

  await test.step('archive again, restore the child and move the archived page are refused by code', async () => {
    const again = await tool(client, 'archive_page', { projectKey: k, pageId: ids.b });
    const child = await tool(client, 'archive_page', {
      projectKey: k,
      pageId: ids.c,
      action: 'restore',
    });
    const moveArchived = await tool(client, 'move_page', {
      projectKey: k,
      pageId: ids.b,
      parent: { kind: 'root' },
    });
    expect(codeOf(again)).toBe('PAGE_ARCHIVED');
    expect(codeOf(child)).toBe('PAGE_ARCHIVE_ROOT_REQUIRED');
    expect(codeOf(moveArchived)).toBe('PAGE_ARCHIVED');
    for (const r of [again, child, moveArchived])
      expect(everythingIn(r)).not.toContain(PAGE_SENTINEL);
  });

  await test.step('B is restored with C; restoring it again is refused PAGE_NOT_ARCHIVED', async () => {
    const restored = await okData<{ restoredIds: string[]; landing: { kind: string } }>(
      client,
      'archive_page',
      { projectKey: k, pageId: ids.b, action: 'restore' },
    );
    expect(new Set(restored.restoredIds)).toEqual(new Set([ids.b, ids.c]));
    expect(restored.landing.kind).toBe('original');
    const live = await ok(client, 'get_page', { projectKey: k, pageId: ids.b });
    expect(live.placement.parentPageId).toBe(ids.a);
    const twice = await tool(client, 'archive_page', {
      projectKey: k,
      pageId: ids.b,
      action: 'restore',
    });
    expect(codeOf(twice)).toBe('PAGE_NOT_ARCHIVED');
  });

  await test.step('A is linked, relinked (changed: false), unlinked, and unlinked again (refused)', async () => {
    const args = { projectKey: k, pageId: ids.a, workItemKey: opsItem.identifier };
    const first = await okData<{ changed: boolean }>(client, 'link_page', args);
    expect(first.changed).toBe(true);
    expect(await linkedPageIds()).toContain(ids.a);
    const second = await okData<{ changed: boolean }>(client, 'link_page', args);
    expect(second.changed).toBe(false);
    expect((await linkedPageIds()).filter((id) => id === ids.a)).toHaveLength(1);
    await okData(client, 'link_page', { ...args, action: 'unlink' });
    expect(await linkedPageIds()).not.toContain(ids.a);
    const again = await tool(client, 'link_page', { ...args, action: 'unlink' });
    expect(codeOf(again)).toBe('PAGE_LINK_NOT_FOUND');
    expect(everythingIn(again)).not.toContain(ITEM_SENTINEL);
  });

  await test.step('another project’s work item, and another project’s page, are refused CROSS_PROJECT_LINK', async () => {
    const crossItem = await tool(client, 'link_page', {
      projectKey: k,
      pageId: ids.a,
      workItemKey: finItem.identifier,
    });
    const crossPage = await tool(client, 'link_page', {
      projectKey: k,
      pageId: finPage.id,
      workItemKey: opsItem.identifier,
    });
    expect(codeOf(crossItem)).toBe('CROSS_PROJECT_LINK');
    expect(codeOf(crossPage)).toBe('CROSS_PROJECT_LINK');
    for (const r of [crossItem, crossPage]) {
      expect(everythingIn(r)).not.toContain(PAGE_SENTINEL);
      expect(everythingIn(r)).not.toContain(ITEM_SENTINEL);
    }
    expect(await linkedPageIds()).toEqual([]);
  });

  await test.step('an unknown page and another project’s page answer the same not-found, naming no title', async () => {
    const unknownMove = await tool(client, 'move_page', {
      projectKey: k,
      pageId: 'page_missing',
      parent: { kind: 'root' },
    });
    const foreignMove = await tool(client, 'move_page', {
      projectKey: k,
      pageId: finPage.id,
      parent: { kind: 'root' },
    });
    const unknownArchive = await tool(client, 'archive_page', {
      projectKey: k,
      pageId: 'page_missing',
    });
    const foreignArchive = await tool(client, 'archive_page', {
      projectKey: k,
      pageId: finPage.id,
    });
    const unknownLink = await tool(client, 'link_page', {
      projectKey: k,
      pageId: 'page_missing',
      workItemKey: opsItem.identifier,
    });
    for (const r of [unknownMove, foreignMove, unknownArchive, foreignArchive, unknownLink]) {
      expect(codeOf(r)).toBe('PAGE_NOT_FOUND');
      expect(everythingIn(r)).not.toContain(PAGE_SENTINEL);
      expect(everythingIn(r)).not.toContain(ITEM_SENTINEL);
    }
    expect(textOf(foreignMove)).toBe(textOf(unknownMove).replace('page_missing', finPage.id));
  });

  await test.step('a token without page:edit, and the stale pre-page grant, are refused on all three tools', async () => {
    for (const token of [s.noEditToken, s.staleGrantToken]) {
      const narrowed = await agent(token, baseURL);
      const calls: [string, Record<string, unknown>][] = [
        ['move_page', { projectKey: k, pageId: ids.c, parent: { kind: 'root' } }],
        ['archive_page', { projectKey: k, pageId: ids.c }],
        ['link_page', { projectKey: k, pageId: ids.c, workItemKey: opsItem.identifier }],
      ];
      for (const [name, args] of calls) {
        const refused = await tool(narrowed, name, args);
        expect(refused.isError, `${name} must be refused`).toBe(true);
        expect(textOf(refused)).toContain('page:edit');
        expect(everythingIn(refused)).not.toContain(PAGE_SENTINEL);
      }
      await narrowed.close();
    }
    const c = await ok(client, 'get_page', { projectKey: k, pageId: ids.c });
    expect(c.placement.parentPageId).toBe(ids.b);
    expect(await linkedPageIds()).toEqual([]);
  });

  await client.close();
});

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asMinted } from '../helpers/devicePoll';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { User } from '@/generated/prisma/client';
import { CLI_TOKEN_GRANT, HOSTED_RUN_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { sortByCatalogOrder, type PermissionKey } from '@/lib/permissions/catalog';

// Same opt-out `cliDeviceService.test.ts` takes, for the same reason: every test
// here signs in for real, and under vitest all sign-ins share one rate-limit
// bucket. Set before the auth module is imported.
vi.hoisted(() => {
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

const { db } = await import('@/lib/db');
const { auth } = await import('@/lib/auth');
const { cliDeviceService } = await import('@/lib/services/cliDeviceService');
const { apiTokensService } = await import('@/lib/services/apiTokensService');
const { CLI_CLIENT_ID } = await import('@/lib/cliDevice/constants');
const { PERMISSION_NOT_GRANTED_CODE } = await import('@/lib/mcp/permissionGate');
const { createTestWorkspace } = await import('../fixtures/workspaceFixtures');
const { createTestProject } = await import('../fixtures/projectFixtures');
const { TEST_PASSWORD } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { adminDb } = await import('../helpers/adminDb');
const { mcpRouteFetch } = await import('../helpers/mcpRouteFetch');

// The page keys join the device grant (Story MOTIR-5760 · MOTIR-7412,
// `docs/decisions/pages.md` §5). Asserted from the CONSTANT and through the real
// device flow + the real `/api/mcp` route: a token `motir login` mints reaches
// `get_page`, `create_page` and `update_page`, and a token minted from the
// grant as it stood before does NOT — the proof that no read-forward was added.

const BASE_URL = 'http://localhost:3000';
const ENDPOINT = 'http://localhost/api/mcp';
const PAGE_KEYS: readonly PermissionKey[] = ['page:view', 'page:edit'];

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function signIn(user: User): Promise<Headers> {
  const res = await auth.api.signInEmail({
    body: { email: user.email, password: TEST_PASSWORD },
    headers: new Headers({ origin: BASE_URL }),
    asResponse: true,
  });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return new Headers({ cookie, origin: BASE_URL });
}

/** `motir login`, end to end: start, claim, approve, poll — the minted PAT. */
async function deviceLogin(owner: User, workspaceId: string): Promise<string> {
  const headers = await signIn(owner);
  const grant = await cliDeviceService.start({ hostname: 'agentbox' });
  await auth.api.deviceVerify({ query: { user_code: grant.user_code }, headers });
  await cliDeviceService.approve({
    userCode: grant.user_code,
    workspaceId,
    actorUserId: owner.id,
    headers,
  });
  const minted = await cliDeviceService.poll({
    deviceCode: grant.device_code,
    clientId: CLI_CLIENT_ID,
  });
  return asMinted(minted).access_token;
}

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: mcpRouteFetch(token),
  });
  const client = new Client({ name: 'cli-page-grant', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

function textOf(res: unknown): string {
  const content = (res as CallToolResult).content ?? [];
  return content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

describe('CLI_TOKEN_GRANT — the page keys', () => {
  it('holds page:view and page:edit, never page:delete, declared in catalog order', () => {
    for (const key of PAGE_KEYS) expect(CLI_TOKEN_GRANT).toContain(key);
    expect(CLI_TOKEN_GRANT).not.toContain('page:delete');
    // The device flow normalises the wire string to catalog order, so the
    // declared order IS the wire contract.
    expect([...CLI_TOKEN_GRANT]).toEqual(sortByCatalogOrder(CLI_TOKEN_GRANT));
  });

  it('leaves HOSTED_RUN_TOKEN_GRANT without the page keys, and still a strict subset', () => {
    // The run's repository door widened it by `repository:manage` (MOTIR-11055); never a page key.
    expect([...HOSTED_RUN_TOKEN_GRANT]).toEqual([
      'project:browse',
      'work_item:edit',
      'repository:manage',
    ]);
    expect(HOSTED_RUN_TOKEN_GRANT.every((key) => CLI_TOKEN_GRANT.includes(key))).toBe(true);
    expect(HOSTED_RUN_TOKEN_GRANT.length).toBeLessThan(CLI_TOKEN_GRANT.length);
  });
});

describe('the device-flow arm CARRIES the whole grant (MOTIR-11055)', () => {
  // A key in the constant is not a key on the token unless the mint path passes it through
  // unfiltered: `repository:manage` — the run's repository door's key — must survive it.
  it('a device-minted token verifies with CLI_TOKEN_GRANT verbatim, repository:manage included', async () => {
    const { owner, workspace } = await createTestWorkspace();
    await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    const token = await deviceLogin(owner, workspace.id);
    const verified = await apiTokensService.verify(token);
    expect([...verified.grant].sort()).toEqual([...CLI_TOKEN_GRANT].sort());
    expect(verified.grant).toContain('repository:manage');
  });
});

describe('a device-minted token over the real /api/mcp route', () => {
  it('reaches get_page, create_page and update_page without a permission refusal', async () => {
    const { owner, workspace } = await createTestWorkspace();
    await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    const token = await deviceLogin(owner, workspace.id);
    const verified = await apiTokensService.verify(token);
    expect([...verified.grant].sort()).toEqual([...CLI_TOKEN_GRANT].sort());
    const client = await connect(token);

    const created = await client.callTool({
      name: 'create_page',
      arguments: { projectKey: 'PROD', title: 'Agent notes', markdown: 'First.' },
    });
    expect(created.isError, textOf(created)).toBeFalsy();
    const page = (created as CallToolResult).structuredContent as { id: string; revision: number };

    const read = await client.callTool({
      name: 'get_page',
      arguments: { projectKey: 'PROD', pageId: page.id },
    });
    expect(read.isError, textOf(read)).toBeFalsy();

    const updated = await client.callTool({
      name: 'update_page',
      arguments: {
        projectKey: 'PROD',
        pageId: page.id,
        markdown: 'Second.',
        revision: page.revision,
      },
    });
    expect(updated.isError, textOf(updated)).toBeFalsy();
    await client.close();
  });

  it('a token minted from the PREVIOUS grant is refused get_page naming page:view (no read-forward)', async () => {
    const { owner, workspace } = await createTestWorkspace();
    await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    // What the device flow minted before this change: the same call, the
    // grant without the page keys.
    const previous = CLI_TOKEN_GRANT.filter((key) => !PAGE_KEYS.includes(key));
    const { token } = await apiTokensService.create(owner.id, workspace.id, {
      label: 'CLI · oldbox',
      fixedGrant: previous,
    });
    const verified = await apiTokensService.verify(token);
    for (const key of PAGE_KEYS) expect(verified.grant).not.toContain(key);
    const client = await connect(token);

    const res = await client.callTool({
      name: 'get_page',
      arguments: { projectKey: 'PROD', pageId: 'any-page' },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(textOf(res)).toContain('page:view');
    await client.close();
  });
});

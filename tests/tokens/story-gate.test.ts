import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { buildMcpServer } from '@/lib/mcp/registry';
import { grantFromExtra, contextFromExtra } from '@/lib/mcp/context';
import { verifyMcpToken } from '@/lib/mcp/auth';
import { authenticateApiToken } from '@/lib/apiTokens/routeAuth';
import { TOOL_PERMISSIONS, CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import {
  GRANTABLE_PERMISSIONS,
  RECORD_VIEW_PERMISSIONS,
  ROOM_VIEW_FORWARD_KEYS,
  isGrantable,
} from '@/lib/tokens/grant';
import { LEGACY_SCOPE_PERMISSIONS, LEGACY_TOKEN_SCOPES } from '@/lib/mcp/scopes';
import { PERMISSIONS, permissionSlug } from '@/lib/permissions/catalog';
import { V1_OPERATIONS } from '@/lib/api/v1/openapi/registry';
import { MCP_TOOL_NAMES, type McpToolName } from '@/lib/mcp/registry';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// The STORY gate for MOTIR-2572 (Subtask MOTIR-2585).
//
// Every card in this story shipped its own tests, and each mocks the half it
// does not own: the model's tests never touch Postgres, the service's never call
// a gate, the modal's never mint a real token. The bugs this story can actually
// produce all live in exactly those gaps — a field renamed on one side of the
// DTO, a legacy row that expands to the right keys and is then gated by a map
// that spells one of them differently.
//
// So this file drives REAL output through REAL consumers, and asserts the
// properties no single card owns.

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function mcpClientFor(token: string) {
  const info = await verifyMcpToken(new Request('http://localhost/api/mcp'), token);
  const extra = { authInfo: info } as Parameters<typeof contextFromExtra>[0];
  const server = buildMcpServer(
    () => contextFromExtra(extra),
    () => grantFromExtra(extra),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'gate', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function bearer(token: string) {
  return new Request('http://localhost/api/v1/x', {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('SEAM 1 — one grant, TWO gates, one answer', () => {
  it('a token minted through the service is admitted/refused identically at both seams', async () => {
    const fx = await makeWorkItemFixture();
    const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'both-seams',
      permissions: ['project:browse'],
      projectId: fx.projectId,
    });

    // MCP: a read passes, a write does not.
    const client = await mcpClientFor(token);
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Seam' },
      fx.ctx,
    );
    const read = await client.callTool({
      name: 'get_work_item',
      arguments: { key: item.identifier },
    });
    expect(read.isError).toBeFalsy();
    const write = await client.callTool({
      name: 'transition_status',
      arguments: { key: item.identifier, status: 'in_progress' },
    });
    expect(write.isError).toBe(true);
    await client.close();

    // /api/v1: the SAME grant, the same two answers, through the other gate.
    await expect(authenticateApiToken(bearer(token), 'project:browse')).resolves.toMatchObject({
      ok: true,
    });
    await expect(authenticateApiToken(bearer(token), 'work_item:edit')).resolves.toMatchObject({
      ok: false,
      reason: 'forbidden',
    });
  });
});

describe('SEAM 2 — the LEGACY-ROW promise, key by key, against real Postgres', () => {
  it('a row written with the six old strings permits exactly what it always did', async () => {
    const fx = await makeWorkItemFixture();
    const { token, dto } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'legacy',
      fixedGrant: ['project:browse'],
    });
    // Written the OLD way — the only way to produce a row `create` no longer can.
    await adminDb.apiToken.update({
      where: { id: dto.id },
      data: { scopes: [...LEGACY_TOKEN_SCOPES] },
    });

    const verified = await apiTokensService.verify(token);
    // MOTIR-6329 (`token-permissions.md` AMENDMENT 2): a FIXED grant that browses
    // is read forward into the Plans and Runs rooms' view keys, so it keeps the two
    // rooms once their reads assert them — the promise, carried, not broken.
    const expected = [
      ...new Set([
        ...LEGACY_TOKEN_SCOPES.flatMap((s) => LEGACY_SCOPE_PERMISSIONS[s]),
        ...ROOM_VIEW_FORWARD_KEYS,
      ]),
    ];
    expect([...verified.grant].sort()).toEqual([...expected].sort());

    // …and the gate agrees, tool by tool, rather than in aggregate.
    //
    // ⚠️ WITH ONE NAMED EXCEPTION, AND THE PROMISE IS UNBROKEN BY IT
    // (MOTIR-3361). This test's subject is that a legacy row "permits exactly
    // what it ALWAYS did" — a no-LOSS promise. `add_lesson` did not exist when
    // those six strings stopped being written, and `lesson:manage` was minted
    // years later, so a legacy row never had this tool and loses nothing by not
    // gaining it. Conferring it would be the opposite failure: a token issued
    // for work-item edits silently able to rewrite the standing instructions a
    // project's planner is given.
    //
    // The loop over EVERY tool was the right shape while every tool's key
    // predated the vocabulary; it over-states the promise the moment one does
    // not. Naming the exception keeps the check exhaustive — a SECOND one
    // appears here as a failure rather than joining an allowance — which is the
    // same discipline `tests/mcp/scopes.test.ts` applies with `KNOWN_LOSSES`.
    // MOTIR-3480 adds the SECOND, by the same rule and not as an allowance:
    // `search_lessons` asserts `lesson:view`, also minted long after these six
    // strings stopped being written, so a legacy row never had this tool and
    // loses nothing by not gaining it. `tests/mcp/scopes.test.ts`'s
    // `KNOWN_LOSSES` and `tests/tokens/grant.test.ts`'s `POSTDATE_THE_SCOPES`
    // name the same pair from their own ends.
    // MOTIR-3553 adds the THIRD, by the same rule and again not as an allowance:
    // `reinforce_lesson` asserts `lesson:reinforce`, minted in this very change
    // and therefore later than all three of the keys above. A legacy row never
    // had this tool and loses nothing by not gaining it; conferring it would let
    // a token issued years ago for work-item edits start writing to a project's
    // lesson corpus — the same shape as the two above, one door further in.
    const POSTDATES_THE_SIX: Partial<Record<McpToolName, true>> = {
      add_lesson: true,
      search_lessons: true,
      reinforce_lesson: true,
      // MOTIR-7410 — `get_page` asserts `page:view`, minted with pages (MOTIR-7277)
      // long after the six strings; a stale row must not start reading pages.
      get_page: true,
      // MOTIR-7411 — `page:edit`, the same: a stale row must not start writing pages.
      create_page: true,
      update_page: true,
      rename_page: true,
      // MOTIR-9553 — `page:view` again: a stale row must not start searching pages.
      search_pages: true,
    };
    for (const name of MCP_TOOL_NAMES) {
      const reachable = verified.grant.includes(TOOL_PERMISSIONS[name]);
      if (POSTDATES_THE_SIX[name]) {
        expect(
          reachable,
          `${name} postdates the six strings and must NOT be reachable by a legacy row`,
        ).toBe(false);
        continue;
      }
      expect(reachable, `${name} must stay reachable for an all-six legacy token`).toBe(true);
    }
  });

  it('an unrecognised stored value degrades DOWN, never to a default', async () => {
    const fx = await makeWorkItemFixture();
    const { token, dto } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'malformed',
      fixedGrant: ['project:browse'],
    });
    await adminDb.apiToken.update({
      where: { id: dto.id },
      data: { scopes: ['read', 'utter-nonsense'] },
    });
    const verified = await apiTokensService.verify(token);
    // `read` → browse, and browse reads forward into the two room view keys
    // (MOTIR-6329); the nonsense value still contributes NOTHING.
    expect(verified.grant).toEqual(['project:browse', 'plan:view_any', 'run:view_any']);
  });
});

describe('SEAM 3 — the DTO read BACK through its consumer', () => {
  it('the list DTO carries the resolved grant and the bound project, not the raw column', async () => {
    // A renamed field passes the service test and breaks the surface; reading
    // back through `listForUser` is what catches it.
    const fx = await makeWorkItemFixture();
    await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'dto',
      permissions: ['project:browse', 'work_item:edit'],
      projectId: fx.projectId,
    });
    const [row] = await apiTokensService.listForUser(fx.ownerId);
    expect(row!.permissions).toEqual(['project:browse', 'work_item:edit']);
    expect(row!.project?.id).toBe(fx.projectId);
    expect(row as unknown as Record<string, unknown>).not.toHaveProperty('scopes');
  });
});

describe('SEAM 4 — grant ∩ role, at BOTH gates', () => {
  it('a permission the OWNER’s role denies is refused even when granted', async () => {
    const fx = await makeWorkItemFixture();
    const u = await usersService.createUser({
      email: `viewer-gate-${Date.now()}@example.com`,
      password: 'correct-horse-battery-staple',
      name: 'Viewer',
    });
    await workspacesService.addMember({ userId: u.id, workspaceId: fx.workspaceId });
    await addToProjectAs({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: { userId: fx.ownerId, workspaceId: fx.workspaceId },
      targetUserId: u.id,
      role: 'viewer',
    });

    // The viewer cannot even be OFFERED work_item:edit — the cap is upstream of
    // the gate, which is the property MOTIR-2606 added.
    const offer = await apiTokensService.listGrantablePermissions(
      u.id,
      fx.workspaceId,
      fx.projectId,
    );
    expect(offer).not.toContain('work_item:edit');
    await expect(
      apiTokensService.create(u.id, fx.workspaceId, {
        label: 'over',
        permissions: ['work_item:edit'],
        projectId: fx.projectId,
      }),
    ).rejects.toMatchObject({ code: 'API_TOKEN_INVALID_PERMISSION' });
  });
});

describe('GUARDS — the properties no single card owns', () => {
  it('GRANTABLE_PERMISSIONS equals what the operation maps assert', () => {
    const asserted = new Set([
      ...Object.values(TOOL_PERMISSIONS),
      ...V1_OPERATIONS.map((o) => o.permission),
      'work_item:edit', // the acceptance publish
      // The record-view keys the plan / run reads consult after their door,
      // against the token's grant (MOTIR-6330 · `holdsRecordView`).
      ...RECORD_VIEW_PERMISSIONS,
    ]);
    for (const key of GRANTABLE_PERMISSIONS) expect(asserted.has(key)).toBe(true);
    for (const key of asserted) expect(GRANTABLE_PERMISSIONS).toContain(key);
  });

  it('TOOL_PERMISSIONS is total, and every v1 operation declares a grantable key', () => {
    expect(Object.keys(TOOL_PERMISSIONS).length).toBe(MCP_TOOL_NAMES.length);
    for (const name of MCP_TOOL_NAMES) expect(isGrantable(TOOL_PERMISSIONS[name])).toBe(true);
    for (const op of V1_OPERATIONS) expect(isGrantable(op.permission)).toBe(true);
  });

  it('no live import of the retired vocabulary survives outside the legacy table', () => {
    // Walked in-process rather than shelled out: spawning a child from a vitest
    // worker is a good way to lose the worker, and `readdirSync` is enough.
    const RETIRED = [
      'TOKEN_SCOPES',
      'TOOL_SCOPES',
      'DEFAULT_TOKEN_SCOPES',
      'CLI_TOKEN_SCOPES',
      'isTokenScope',
      'toolScope',
    ];
    // The legacy table itself, and the device flow's RFC 8628 `scope` wire
    // parameter — a PROTOCOL field, not our vocabulary.
    const ALLOWED = new Set(['lib/mcp/scopes.ts', 'lib/services/cliDeviceService.ts']);

    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
        } else if (/\.tsx?$/.test(entry.name)) {
          const rel = relative(process.cwd(), full);
          if (ALLOWED.has(rel)) continue;
          // Comments are STRIPPED first: this guard is about live references,
          // and several modules legitimately explain in prose what the retired
          // map used to do. Flagging that prose would push writers to delete the
          // explanation — the opposite of what the guard is for.
          const src = readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');
          if (RETIRED.some((name) => new RegExp(`\\b${name}\\b`).test(src))) hits.push(rel);
        }
      }
    };
    for (const root of ['lib', 'app', 'packages/cli/src']) walk(root);

    expect(hits, `retired vocabulary still referenced by: ${hits.join(', ')}`).toEqual([]);
    expect(readFileSync('lib/mcp/scopes.ts', 'utf8')).toContain('LEGACY_SCOPE_PERMISSIONS');
  });

  it('every grantable key has a shipped label AND description in BOTH locales', () => {
    for (const key of GRANTABLE_PERMISSIONS) {
      const slug = permissionSlug(key);
      for (const [name, m] of [
        ['en', enMessages],
        ['zh', zhMessages],
      ] as const) {
        const entry = (m.permissions as Record<string, { label?: string; description?: string }>)[
          slug
        ];
        expect(entry?.label, `${name}: permissions.${slug}.label`).toBeTruthy();
        expect(entry?.description, `${name}: permissions.${slug}.description`).toBeTruthy();
      }
    }
  });

  it('the CLI device grant is grantable and withholds the irreversible key', () => {
    for (const key of CLI_TOKEN_GRANT) expect(GRANTABLE_PERMISSIONS).toContain(key);
    expect(CLI_TOKEN_GRANT).not.toContain('work_item:delete');
  });

  it('no ungrantable catalog key can reach a token', () => {
    const grantable = new Set(GRANTABLE_PERMISSIONS);
    const ungrantable = PERMISSIONS.filter((k) => !grantable.has(k));
    expect(ungrantable.length).toBeGreaterThan(0);
    for (const key of ungrantable) expect(isGrantable(key)).toBe(false);
  });
});

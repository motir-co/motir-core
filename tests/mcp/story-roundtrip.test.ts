import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { plansService } from '@/lib/services/plansService';
import { pagesService } from '@/lib/services/pagesService';
import { toolPermission } from '@/lib/mcp/toolPermissions';
import { DEFAULT_TOKEN_GRANT, GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { MCP_TOOL_NAMES, type McpToolName } from '@/lib/mcp/registry';
import { decodeFilterEnvelope, FILTER_PARAM_VERSION } from '@/lib/filters/ast';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { mcpRouteFetch } from '../helpers/mcpRouteFetch';
import { mcpToolArgs } from '../helpers/mcpToolArgs';

// Story-CLOSING suite for the Motir MCP server (Story 7.7 · Subtask 7.7.12).
//
// The per-subtask vitest (auth.test.ts, tools.test.ts, write-tools.test.ts,
// search.test.ts, link-tools.test.ts, edit-archive-tools.test.ts,
// delete-tool.test.ts, sprint-tools.test.ts, scope-gate.test.ts, …) cover each
// tool handler in isolation, built with a FIXED-context resolver over an
// in-memory transport — the auth/bearer plumbing is bypassed there.
//
// THIS suite is the story's acceptance contract: it drives the ACTUAL
// `/api/mcp` route — the real `createMcpHandler` + `withMcpAuth` +
// `verifyMcpToken` + the production `contextFromExtra` / `grantFromExtra`
// resolvers — with the official `@modelcontextprotocol/sdk` CLIENT over a
// real bearer PAT, `initialize → tools/list → tools/call`. Real Postgres, no
// mocks (the repo testing contract). Three pillars:
//
//   1. AUTH MATRIX — valid / absent / malformed / unknown / revoked / expired
//      token × a representative tool, through the real transport gate.
//   2. PERMISSION PARITY — the SAME call under an owner token vs a NON-MEMBER
//      token; the non-member sees the 404-not-403 contract on EVERY tool. The
//      arg map LOOPS the registry (`MCP_TOOL_NAMES`) and a totality guard fails
//      the suite by construction if a future tool is added without an entry —
//      so a tool shipped without workspace scoping cannot pass unnoticed. The
//      non-member token carries the FULL scope set, so this isolates ROLE
//      permission from token-scope gating (the scope matrix is 7.7.20).
//   3. TOOL / UI PARITY — one assertion per tool FAMILY (read · write · search ·
//      link · edit/archive · delete · sprint): each MCP tool lands the SAME
//      effect as the service the UI route calls (the catalog is `docs/mcp.md`).

const ENDPOINT = 'http://localhost/api/mcp';

/** Connect an official MCP client to the real `/api/mcp` route over `token`. */
async function connect(token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: mcpRouteFetch(token),
  });
  const client = new Client({ name: 'story-roundtrip', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

/** Mint a PAT bound to the fixture's workspace with EVERY scope (delete too) —
 * so a parity/permission test isolates the ROLE check from scope gating. */
async function fullToken(fx: WorkItemFixture, label = 'full'): Promise<string> {
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label,
    fixedGrant: [...GRANTABLE_PERMISSIONS],
  });
  return token;
}

/** Mint a PAT bound to the fixture's workspace with EXACTLY `scopes` granted —
 * the lever for the scope matrix (a restricted set, the default set, a
 * delete-enabled set). The owner's ROLE is unchanged; only the token's
 * capability is narrowed, so a denial here isolates SCOPE from the 6.4 role. */
async function grantedToken(
  fx: WorkItemFixture,
  permissions: readonly PermissionKey[],
  label = 'granted',
): Promise<string> {
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label,
    fixedGrant: [...permissions],
  });
  return token;
}

/** Did the tool result come back as the typed scope-denied error? `callTool`'s
 * return is a union broader than `CallToolResult`, so read the fields off the
 * raw result (the same shape `structured` reads). */
function isScopeDenied(res: unknown): boolean {
  const r = res as { isError?: boolean; content?: unknown };
  return (
    r.isError === true && JSON.stringify(r.content ?? '').includes(PERMISSION_NOT_GRANTED_CODE)
  );
}

/** Create a task via the service (the create-modal write) and return its key. */
async function makeTask(fx: WorkItemFixture, title: string): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return dto.identifier;
}

/** The latest audit revision for a work item (by identifier). */
async function latestRevision(identifier: string) {
  const item = await adminDb.workItem.findFirstOrThrow({ where: { identifier } });
  return adminDb.workItemRevision.findFirstOrThrow({
    where: { workItemId: item.id },
    orderBy: { changedAt: 'desc' },
  });
}

// `client.callTool` returns a union broader than `CallToolResult` (the legacy
// `toolResult` shape), so read structuredContent off the raw result.
const structured = (res: unknown) =>
  (res as { structuredContent?: unknown }).structuredContent as Record<string, unknown>;

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ───────────────────────────── tools/list ──────────────────────────────────

describe('MCP story suite — real /api/mcp endpoint', () => {
  it('initialize → tools/list returns exactly the registered tool surface', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await fullToken(fx));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    for (const t of tools) expect(t.inputSchema).toBeTruthy();
    await client.close();
  });

  // ───────────────────────────── auth matrix ───────────────────────────────

  describe('auth matrix (representative tool: whoami, through the real bearer gate)', () => {
    /** Attempt initialize + a whoami call under `token`; resolve to whether it
     * executed. A rejected token never reaches a tool — `withMcpAuth` 401s the
     * request before dispatch, surfacing as a transport error here. */
    async function whoamiSucceeds(token?: string): Promise<boolean> {
      try {
        const client = await connect(token);
        const res = await client.callTool({ name: 'whoami', arguments: {} });
        await client.close();
        return res.isError !== true;
      } catch {
        return false;
      }
    }

    it('a VALID token executes; every invalid token state is rejected before dispatch', async () => {
      const fx = await makeWorkItemFixture();

      // valid
      expect(await whoamiSucceeds(await fullToken(fx))).toBe(true);

      // absent / malformed (no prefix) / unknown (well-formed prefix, no row)
      expect(await whoamiSucceeds(undefined)).toBe(false);
      expect(await whoamiSucceeds('not-a-motir-token')).toBe(false);
      expect(await whoamiSucceeds('motir_pat_deadbeefdeadbeefdeadbeef')).toBe(false);

      // revoked
      const revoked = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
        label: 'rev',
        fixedGrant: DEFAULT_TOKEN_GRANT,
      });
      await apiTokensService.deleteToken(fx.ownerId, revoked.dto.id);
      expect(await whoamiSucceeds(revoked.token)).toBe(false);

      // expired
      const expired = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
        label: 'exp',
        expiresAt: new Date(Date.now() - 60_000),
        fixedGrant: DEFAULT_TOKEN_GRANT,
      });
      expect(await whoamiSucceeds(expired.token)).toBe(false);
    });
  });

  // ───────────── permission parity — 404-not-403 over the registry ──────────

  describe('permission parity — a non-member is denied on EVERY tool (404-not-403)', () => {
    it('loops the registry: non-member calls are errors; the arg map is total over MCP_TOOL_NAMES', async () => {
      // Owner tenant A, fully seeded so every tool has a real target to aim at.
      const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
      const item1 = await makeTask(a, 'A-1');
      const item2 = await makeTask(a, 'A-2');
      // a planned sprint via the service the create-sprint tool calls
      const sprint = await sprintsService.createSprint(a.projectId, { name: 'S1' }, a.ctx);
      // A settled expansion plan of A's (MOTIR-1825) — the target `get_plan_status`
      // aims at. `planned`, so reading it never reaches out to motir-ai.
      const plan = await plansService.createPlan(
        a.projectId,
        { title: null, summary: null, sourceJobId: 'job_parity_a', createdById: a.ctx.userId },
        a.ctx,
      );
      await plansService.markPlanned(plan.id, a.ctx);

      // A NON-MEMBER: their own workspace + a DIFFERENT project key, full-scope
      // token. They can authenticate, but A's PROD project / items / sprint are
      // invisible — every targeted call must read as not-found, never a 403 leak
      // and never a success.
      const outsider = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
      const nonMemberToken = await fullToken(outsider, 'outsider');

      // The targeting arg for each tool, aimed at tenant A's resources. `whoami`
      // is the documented exception — it returns the CALLER's own identity, so a
      // non-member sees only themselves (no cross-tenant resource to deny).
      // A page of A's (MOTIR-7410) — the target `get_page` aims at.
      const page = await pagesService.createPage(a.ctx, { projectId: a.projectId });
      const argFor = mcpToolArgs({
        projectKey: 'PROD',
        item1,
        item2,
        sprintId: sprint.id,
        planId: plan.id,
        pageId: page.id,
      });

      // Totality guard — the arg map MUST cover the live registry. A tool added
      // to MCP_TOOL_NAMES without an entry here fails the suite by construction.
      expect(Object.keys(argFor).sort()).toEqual([...MCP_TOOL_NAMES].sort());

      // Four tools are SELF-SCOPED — they act only within the CALLER's own
      // workspace and take no cross-tenant resource key, so they are
      // structurally incapable of reaching A's data: `whoami` returns the
      // caller's own identity, `list_projects` (MOTIR-1879) the caller's own
      // workspace's projects, and `complete_session` matches a session branch
      // inside the caller's (empty) workspace → a no-op, not a 404. The
      // 404-not-403 denial applies to every RESOURCE-TARGETING tool.
      // `get_section_sets` (MOTIR-9029) is a product contract, the same for every tenant: it
      // reads no tenant data at all, so there is nothing for it to deny.
      const SELF_SCOPED = new Set<McpToolName>([
        'whoami',
        'list_projects',
        'complete_session',
        'get_section_sets',
      ]);

      const client = await connect(nonMemberToken);
      for (const name of MCP_TOOL_NAMES) {
        const res = await client.callTool({ name, arguments: argFor[name] });
        if (SELF_SCOPED.has(name)) {
          // Self-scoped: a no-op success against the caller's own workspace,
          // never A's data (the no-leak proof is the A-untouched check below).
          expect(res.isError, `${name} is self-scoped`).toBeFalsy();
        } else {
          // Every resource-targeting tool: denied as not-found (404-not-403),
          // never executed against A's data.
          expect(res.isError, `${name} must deny a non-member`).toBe(true);
        }
      }

      // whoami returned the NON-MEMBER's own identity — no cross-tenant leak.
      const whoami = await client.callTool({ name: 'whoami', arguments: {} });
      expect((structured(whoami).user as { email?: string }).email).toBe(outsider.owner.email);
      expect(JSON.stringify(whoami)).not.toContain('Acme');

      // Same proof for list_projects: the success above listed only the
      // OUTSIDER's own project (ZZZ) — A's PROD never appears.
      const projects = await client.callTool({ name: 'list_projects', arguments: {} });
      expect((structured(projects).projects as { key: string }[]).map((p) => p.key)).toEqual([
        'ZZZ',
      ]);
      expect(JSON.stringify(projects)).not.toContain('PROD');
      await client.close();

      // The non-member's writes had NO effect on A — the items are untouched.
      const stillThere = await workItemsService.getIssueDetail(a.projectId, item1, a.ctx);
      expect(stillThere.item.title).toBe('A-1');
      expect(stillThere.item.archivedAt).toBeNull();
    });
  });

  // ───────────────────── tool / UI parity, one per family ───────────────────

  describe('tool / UI parity — each tool lands the same effect as its UI counterpart', () => {
    it('read family — list_ready ≡ workItemsService.listReady; next_ready ≡ getNextReady', async () => {
      const fx = await makeWorkItemFixture();
      await makeTask(fx, 'R-1');
      await makeTask(fx, 'R-2');
      const client = await connect(await fullToken(fx));

      const listed = await client.callTool({
        name: 'list_ready',
        arguments: { projectKey: 'PROD' },
      });
      const direct = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
      // ReadyItemDto carries the PROD-<n> identifier as `key` (not `identifier`).
      const mcpKeys = (structured(listed).items as { key: string }[]).map((i) => i.key);
      expect(mcpKeys).toEqual(direct.items.map((i) => i.key));
      expect(mcpKeys).toHaveLength(2);
      expect(structured(listed).nextCursor).toEqual(direct.nextCursor);

      const next = await client.callTool({ name: 'next_ready', arguments: { projectKey: 'PROD' } });
      const directNext = await workItemsService.getNextReady(fx.projectId, {}, fx.ctx);
      expect((structured(next).item as { key: string }).key).toBe(directNext?.key);
      await client.close();
    });

    it('write family — create_work_item persists + reads back; add_comment writes a comment; transition_status writes the board-drag revision', async () => {
      const fx = await makeWorkItemFixture();
      const client = await connect(await fullToken(fx));

      // create ≡ the create modal write (workItemsService.createWorkItem)
      const created = await client.callTool({
        name: 'create_work_item',
        arguments: { projectKey: 'PROD', kind: 'task', title: 'Created via MCP' },
      });
      const key = (structured(created) as { identifier: string }).identifier;
      const readBack = await client.callTool({ name: 'get_work_item', arguments: { key } });
      expect((structured(readBack).item as { title: string }).title).toBe('Created via MCP');

      // add_comment ≡ the comment composer write (commentsService.addComment)
      const commented = await client.callTool({
        name: 'add_comment',
        arguments: { key, body: 'first comment' },
      });
      expect(commented.isError).toBeFalsy();
      expect((structured(commented) as { bodyMd: string }).bodyMd).toBe('first comment');
      const item = await adminDb.workItem.findFirstOrThrow({ where: { identifier: key } });
      const commentCount = await adminDb.comment.count({ where: { workItemId: item.id } });
      expect(commentCount).toBe(1);

      // transition_status ≡ the board drag — the SAME applyStatusTransition, so
      // an identical revision row. Prove it: drive item via MCP and a SECOND
      // item via the board's own service method, then compare the diffs.
      const viaMcpKey = await makeTask(fx, 'Move via MCP');
      const viaBoardKey = await makeTask(fx, 'Move via board service');
      await client.callTool({
        name: 'transition_status',
        arguments: { key: viaMcpKey, status: 'in_progress' },
      });
      const boardItem = await adminDb.workItem.findFirstOrThrow({
        where: { identifier: viaBoardKey },
      });
      await workItemsService.updateStatus(boardItem.id, 'in_progress', fx.ctx);

      const mcpRev = await latestRevision(viaMcpKey);
      const boardRev = await latestRevision(viaBoardKey);
      expect(mcpRev.changeKind).toBe('updated');
      expect(mcpRev.diff).toEqual({ status: { from: 'todo', to: 'in_progress' } });
      expect(mcpRev.diff).toEqual(boardRev.diff);
      expect(mcpRev.changeKind).toBe(boardRev.changeKind);
      await client.close();
    });

    it('search family — search_work_items ≡ the /items list service for the same FilterAST', async () => {
      const fx = await makeWorkItemFixture();
      await makeTask(fx, 'a task');
      await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'bug', title: 'a bug' },
        fx.ctx,
      );
      const client = await connect(await fullToken(fx));

      // The agent-facing envelope and the decoded AST the /items service runs.
      const envelope = {
        version: FILTER_PARAM_VERSION,
        combinator: 'and' as const,
        conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
      };
      const decoded = decodeFilterEnvelope({
        v: envelope.version,
        c: envelope.combinator,
        f: [['kind', 'is_any_of', ['bug']]],
      });
      if (!decoded.ok) throw new Error('fixture envelope failed to decode');

      const searched = await client.callTool({
        name: 'search_work_items',
        arguments: { projectKey: 'PROD', filter: envelope },
      });
      const direct = await workItemsService.getProjectIssuesList(
        fx.projectId,
        { sort: DEFAULT_SORT, filter: { ast: decoded.ast } },
        fx.ctx,
      );
      const mcpKeys = (structured(searched).items as { identifier: string }[]).map(
        (i) => i.identifier,
      );
      expect(mcpKeys).toEqual(direct.items.map((i) => i.identifier));
      // The filter actually bit — only the bug came back.
      expect(mcpKeys).toHaveLength(1);
      await client.close();
    });

    it('link family — link_work_items adds the is_blocked_by edge (holds the item out of ready); unlink restores it', async () => {
      const fx = await makeWorkItemFixture();
      const blockerKey = await makeTask(fx, 'Blocker');
      const blockedKey = await makeTask(fx, 'Blocked');
      const client = await connect(await fullToken(fx));

      const readyBefore = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
      expect(readyBefore.items.map((i) => i.key)).toContain(blockedKey);

      await client.callTool({
        name: 'link_work_items',
        arguments: { fromKey: blockedKey, toKey: blockerKey, relationship: 'blocked_by' },
      });
      const readyLinked = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
      expect(readyLinked.items.map((i) => i.key)).not.toContain(blockedKey);

      await client.callTool({
        name: 'unlink_work_items',
        arguments: { fromKey: blockedKey, toKey: blockerKey, relationship: 'blocked_by' },
      });
      const readyUnlinked = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
      expect(readyUnlinked.items.map((i) => i.key)).toContain(blockedKey);
      await client.close();
    });

    it('edit/archive family — update_work_item patches the inline-edit fields; archive drops from ready; unarchive restores', async () => {
      const fx = await makeWorkItemFixture();
      const key = await makeTask(fx, 'Editable');
      const client = await connect(await fullToken(fx));

      await client.callTool({
        name: 'update_work_item',
        arguments: { key, title: 'Edited title', priority: 'high' },
      });
      const detail = await workItemsService.getIssueDetail(fx.projectId, key, fx.ctx);
      expect(detail.item.title).toBe('Edited title');
      expect(detail.item.priority).toBe('high');

      await client.callTool({ name: 'archive_work_item', arguments: { key } });
      const archived = await workItemsService.getIssueDetail(fx.projectId, key, fx.ctx);
      expect(archived.item.archivedAt).not.toBeNull();
      const readyArchived = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
      expect(readyArchived.items.map((i) => i.key)).not.toContain(key);

      await client.callTool({ name: 'unarchive_work_item', arguments: { key } });
      const restored = await workItemsService.getIssueDetail(fx.projectId, key, fx.ctx);
      expect(restored.item.archivedAt).toBeNull();
      await client.close();
    });

    it('delete family — delete_work_item cascades the subtree (full scope); a default token is refused (SCOPE_NOT_GRANTED)', async () => {
      const fx = await makeWorkItemFixture();
      const story = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'Parent' },
        fx.ctx,
      );
      const child = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: 'Child', parentId: story.id },
        fx.ctx,
      );

      // A DEFAULT token (every scope EXCEPT work_items:delete) is gated BEFORE
      // the service runs — the cross-check on 7.7.17 scope enforcement.
      expect(DEFAULT_TOKEN_GRANT).not.toContain('work_item:delete');
      const defaultToken = (
        await apiTokensService.create(fx.ownerId, fx.workspaceId, {
          label: 'default',
          fixedGrant: DEFAULT_TOKEN_GRANT,
        })
      ).token;
      const defClient = await connect(defaultToken);
      const denied = await defClient.callTool({
        name: 'delete_work_item',
        arguments: { key: story.identifier },
      });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied.content)).toContain('PERMISSION_NOT_GRANTED');
      await defClient.close();
      // Nothing was deleted by the refused call.
      const workItemCount = await adminDb.workItem.count({
        where: { id: { in: [story.id, child.id] } },
      });
      expect(workItemCount).toBe(2);

      // A FULL-scope token deletes the whole subtree (the permanent-delete action).
      const fullClient = await connect(await fullToken(fx));
      const deleted = await fullClient.callTool({
        name: 'delete_work_item',
        arguments: { key: story.identifier },
      });
      expect(deleted.isError).toBeFalsy();
      await fullClient.close();
      const workItemCount2 = await adminDb.workItem.count({
        where: { id: { in: [story.id, child.id] } },
      });
      expect(workItemCount2).toBe(0);
    });

    it('sprint family — create → move_to_sprint → start → complete lands the same end state as the UI flow', async () => {
      const fx = await makeWorkItemFixture();
      const itemKey = await makeTask(fx, 'Sprint work');
      const client = await connect(await fullToken(fx));

      const created = await client.callTool({
        name: 'create_sprint',
        arguments: { projectKey: 'PROD', name: 'Sprint 1' },
      });
      const sprintId = (structured(created) as { id: string }).id;
      expect((structured(created) as { state: string }).state).toBe('planned');

      await client.callTool({
        name: 'move_to_sprint',
        arguments: { keys: [itemKey], sprintId },
      });
      const started = await client.callTool({ name: 'start_sprint', arguments: { sprintId } });
      expect((structured(started) as { state: string }).state).toBe('active');

      const completed = await client.callTool({
        name: 'complete_sprint',
        arguments: { sprintId, carryOverTo: 'backlog' },
      });
      expect((structured(completed) as { state: string }).state).toBe('complete');

      // The end state matches the UI flow: the sprint is closed in the DB.
      const row = await adminDb.sprint.findFirstOrThrow({ where: { id: sprintId } });
      expect(row.state).toBe('complete');
      await client.close();
    });
  });

  // ───────────── token scope matrix — scope gating end-to-end ────────────────
  //
  // The 4th pillar (Subtask 7.8.20). The permission-parity pillar above isolated
  // the 6.4 ROLE check by handing the non-member a FULL-scope token; this pillar
  // isolates the per-token SCOPE gate (Subtask 7.7.17) by handing the OWNER
  // (whose role allows everything) a token with a RESTRICTED scope set, and
  // drives it through the SAME real `/api/mcp` route + `grantFromExtra`
  // resolver. The pure decision + in-memory wiring live in `scope-gate.test.ts`
  // / `scopes.test.ts` (the totality + registry-loop guards that fail CI when a
  // tool is added without a scope); THIS proves the gate end-to-end over a real
  // bearer PAT, and that scope NARROWS but does not REPLACE the role.

  describe('token scope matrix — the scope gate over the real bearer PAT', () => {
    /** Seed a project with two items + a planned sprint, all in the CALLER's own
     * workspace, and return the arg map (keyed total over the registry) aimed at
     * them — so a GRANTED tool actually executes against reachable data and an
     * UNGRANTED one is gated before touching it. */
    async function ownArgMap(fx: WorkItemFixture): Promise<{
      argFor: Record<McpToolName, Record<string, unknown>>;
      item1: string;
      item2: string;
    }> {
      const item1 = await makeTask(fx, 'Scope-1');
      const item2 = await makeTask(fx, 'Scope-2');
      const sprint = await sprintsService.createSprint(
        fx.projectId,
        { name: 'Scope sprint' },
        fx.ctx,
      );
      // A `planned` expansion plan the caller ASKED FOR, in their own project, so
      // the read-only token's `get_plan_status` call actually EXECUTES — a token
      // without `plan:view_any` reads the plans that are its owner's (MOTIR-6330) (the loop asserts every
      // read-scoped tool succeeds) and never reaches out to motir-ai for a job.
      const plan = await plansService.createPlan(
        fx.projectId,
        { title: null, summary: null, sourceJobId: 'job_scope_own', createdById: fx.ctx.userId },
        fx.ctx,
      );
      await plansService.markPlanned(plan.id, fx.ctx);
      const argFor: Record<McpToolName, Record<string, unknown>> = {
        whoami: {},
        list_projects: {},
        // Read-scoped, aimed at the caller's OWN project — the read-only-token
        // loop asserts every `read` tool actually EXECUTES, and an unconfigured
        // project is exactly the well-formed "nothing configured" answer.
        get_project_state: { projectKey: 'PROD' },
        // MOTIR-7793 — a project with no repository set: `repos: []`, no boundary call.
        get_code_health: { projectKey: 'PROD' },
        // MOTIR-9083 — no repository set, so `repo_not_in_project`, a named non-error.
        get_coding_convention: { projectKey: 'PROD', repo: 'motir-core' },
        // MOTIR-7861 — no repository set, so `repo_not_in_project`: a named,
        // non-error outcome answered before any host call.
        read_file: { projectKey: 'PROD', repo: 'motir-core', path: 'README.md' },
        // MOTIR-10069 — no repository set, so `repo_not_in_project` before any host call.
        list_changed_files: { projectKey: 'PROD', repo: 'motir-core', head: 'feat/x' },
        // MOTIR-7862 — no repository set, so `no_repositories`, decided in core with
        // no motir-ai call.
        code_explore: { projectKey: 'PROD', query: 'readFile' },
        code_search: { projectKey: 'PROD', query: 'readFile' },
        skeleton: { projectKey: 'PROD' },
        // MOTIR-5409 — `list_folders` is a browse read that executes on the caller's own
        // project; the three writes are `work_item:edit`-gated, and a folder id that
        // names nothing is a not-found, never a scope denial.
        list_folders: { projectKey: 'PROD' },
        // MOTIR-9029 — the project-less section registry read: it executes for any token holding `project:browse`.
        get_section_sets: {},
        create_folder: { projectKey: 'PROD', name: 'scoped folder' },
        update_folder: { projectKey: 'PROD', folderId: 'fld_scoped', name: 'scoped rename' },
        delete_folder: { projectKey: 'PROD', folderId: 'fld_scoped' },
        // MOTIR-7410 — `page:view`-gated, so a `project:browse`-only token is
        // refused at the gate before the (unknown) page id is looked at.
        get_page: { projectKey: 'PROD', pageId: 'page_scoped' },
        create_page: { projectKey: 'PROD', markdown: 'scoped page' },
        update_page: { projectKey: 'PROD', pageId: 'page_scoped', markdown: 'x', revision: 1 },
        rename_page: { projectKey: 'PROD', pageId: 'page_scoped', title: 'x' },
        search_pages: { projectKey: 'PROD', q: 'scoped' },
        move_page: { projectKey: 'PROD', pageId: 'page_scoped', parent: { kind: 'root' } },
        archive_page: { projectKey: 'PROD', pageId: 'page_scoped' },
        link_page: { projectKey: 'PROD', pageId: 'page_scoped', workItemKey: 'PROD-1' },
        publish_decision_page: { key: item1, pageId: 'page_scoped' },
        get_work_item: { key: item1 },
        get_design: { key: item1 },
        list_designs: { projectKey: 'PROD' },
        // MOTIR-6191 — the gate read is item-keyed, so a non-member must read tenant
        // A's card as not-found rather than learn what was decided on it; on the
        // caller's own card it EXECUTES and answers `gate: null` (no such gate).
        get_approval_gate: { key: item1, kind: 'decision_approval' },
        get_work_item_activity: { key: item1 },
        list_ready: { projectKey: 'PROD' },
        next_ready: { projectKey: 'PROD' },
        claim_next_ready: { projectKey: 'PROD' },
        // The KEYED claim (MOTIR-2961) — item-keyed, so a non-member must read
        // tenant A's card as not-found rather than take it.
        claim_work_item: { key: item1 },
        dispatch_prompt: { key: item1 },
        get_plan_status: { planId: plan.id },
        get_plan: { planId: plan.id },
        create_plan: { projectKey: 'PROD', title: 'scoped plan' },
        add_plan_items: {
          planId: plan.id,
          proposals: [{ op: 'add', proposedFields: { title: 'scoped proposal' } }],
        },
        update_plan_item: { planId: plan.id, planItemId: 'pi_scoped', title: 'scoped deepen' },
        update_plan_proposal: {
          planId: plan.id,
          planItemId: 'pi_scoped',
          title: 'scoped correction',
        },
        withdraw_plan_proposal: { planId: plan.id, planItemId: 'pi_scoped' },
        update_plan: { planId: plan.id, summary: 'scoped brief correction' },
        record_plan_revision_reason: {
          planId: plan.id,
          branch: 'new_ask',
          evidenceMd: 'scoped classification',
        },
        report_plan_step: { planId: plan.id, sessionKey: 'scoped', step: 'settle' },
        hold_plan_revision: { planId: plan.id, action: 'end' },
        // MOTIR-6227 — the caller's OWN item. Gated on `ai:view_plan`, so the
        // read-only-token loop asserts it is REFUSED at the scope gate.
        get_approved_shape_verdict: { key: item1 },
        // MOTIR-6286 — the caller's OWN item. Gated on `work_item:edit`, so the
        // read-only-token loop asserts it is REFUSED at the scope gate.
        report_unbuildable_target: {
          projectKey: 'PROD',
          targetKey: item1,
          reason: 'scoped report',
        },
        // MOTIR-8657 — the caller's OWN item. Gated on `work_item:edit`, so the
        // read-only-token loop asserts it is REFUSED at the scope gate.
        record_run_discrepancy: {
          key: item1,
          points: [{ planAsked: 'scoped', built: 'scoped', why: 'scoped' }],
        },
        open_plan_session: { projectKey: 'PROD' },
        append_plan_turn: { projectKey: 'PROD', body: 'scoped turn' },
        submit_plan_session: { projectKey: 'PROD' },
        search_work_items: { projectKey: 'PROD' },
        // Read-scoped and aimed at the caller's OWN project. With no motir-ai
        // configured under test it answers `outcome: 'unavailable'` — a SUCCESS
        // result carrying a readable message, which is exactly the contract
        // Amendment 2 pins: "I could not search" is an answer, not an error.
        search_work_items_semantic: { projectKey: 'PROD', query: 'anything at all' },
        list_sprints: { projectKey: 'PROD' },
        validate_sprint: { projectKey: 'PROD', sprintId: sprint.id },
        validate_work_item: { key: item1 },
        // The caller's OWN plan — a read-scoped tool the loop asserts EXECUTES.
        validate_plan: { planId: plan.id },
        get_plan_authoring_state: { planId: plan.id },
        create_work_item: { projectKey: 'PROD', kind: 'task', title: 'scoped create' },
        expand_item: { key: item1 },
        update_work_item: { key: item1, title: 'scoped edit' },
        change_kind: { key: item1, kind: 'task' },
        transition_status: { key: item1, status: 'in_progress' },
        add_comment: { key: item1, body: 'scoped comment' },
        // MOTIR-5295 — comment:add-gated writes; the matrix asserts the GATE,
        // and an id that names no comment is a not-found, never a scope denial.
        edit_comment: { commentId: 'cmt_scoped', body: 'scoped edit' },
        delete_comment: { commentId: 'cmt_scoped' },
        // MOTIR-6725 — the caller's OWN card. The read executes (an empty list);
        // the two writes are `work_item:edit`, so the read-only-token loop
        // asserts both are REFUSED at the gate. A step id that names nothing is a
        // not-found, never a scope denial.
        list_work_item_todos: { key: item1 },
        add_work_item_todo: { key: item1, text: 'scoped step' },
        set_work_item_todo_done: { key: item1, todoId: 'tdo_scoped', done: true },
        // MOTIR-7306 — edit and delete are `work_item:edit` too: REFUSED at the gate.
        update_work_item_todo: { key: item1, todoId: 'tdo_scoped', text: 'scoped edit' },
        delete_work_item_todo: { key: item1, todoId: 'tdo_scoped' },
        // MOTIR-7556 — move is `work_item:edit` too: REFUSED at the gate.
        move_work_item_todo: { key: item1, todoId: 'tdo_scoped', toIndex: 0 },
        // MOTIR-6807 — the caller's OWN card; all three are `work_item:edit`, so
        // the read-only-token loop asserts each is REFUSED at the gate.
        claim_work_item_repair: { key: item1 },
        touch_work_item_repair: { key: item1, runId: 'run_scoped' },
        close_work_item_repair: { key: item1, runId: 'run_scoped', outcome: 'gave_up' },
        // MOTIR-7262 — the continue tools, the same three `work_item:edit` writes.
        claim_work_item_continue: { key: item1 },
        touch_work_item_continue: { key: item1, runId: 'run_scoped' },
        close_work_item_continue: { key: item1, runId: 'run_scoped', outcome: 'completed' },
        // MOTIR-7451 — the run tools, the same three `work_item:edit` writes.
        start_work_item_run: { key: item1, harness: 'Scoped Agent' },
        report_action: { key: item1, action: 'scoped step' },
        close_work_item_run: { key: item1, runId: 'run_scoped', outcome: 'completed' },
        // MOTIR-3361 — the caller's OWN project. A write-scoped tool, so the
        // read-only-token loop asserts it is REFUSED at the scope gate rather
        // than reaching motir-ai.
        add_lesson: {
          projectKey: 'PROD',
          title: 'Pin the repository on every card that ships code',
          body: 'A card with no repository pinned goes to whichever checkout is first.',
          why: 'It cost a day in the billing epic.',
          howToApply: 'Set the target repository before sealing the card.',
        },
        // MOTIR-3480 — the caller's OWN project. A READ-scoped tool, so the
        // read-only-token loop asserts it EXECUTES rather than being refused at
        // the scope gate; motir-ai is unconfigured in this suite, which is the
        // well-formed `unavailable` answer rather than a failure.
        search_lessons: {
          projectKey: 'PROD',
          query: 'pinning a repository on a card that ships code',
        },
        // MOTIR-3553 — the lesson WRITE. Same note as its search sibling above:
        // it is refused at the scope gate, and motir-ai is unconfigured in this
        // suite either way.
        reinforce_lesson: {
          projectKey: 'PROD',
          lessonId: 'les_whatever',
          occurrenceRef: 'MOTIR-1',
        },
        // MOTIR-3058. Aimed at tenant A's item like its neighbours: a
        // cross-tenant caller must read the key as not-found — never a 403 that
        // confirms it exists, and never a file landing in another workspace.
        attach_file: {
          key: item1,
          filename: 'findings.md',
          contentType: 'text/markdown',
          contentBase64: 'eA==',
        },
        // MOTIR-3782 — the caller's OWN item. A write-scoped tool, so the
        // read-only-token loop asserts it is REFUSED at the scope gate.
        publish_design_result: {
          key: item1,
          assets: [
            {
              kind: 'image',
              sourcePath: 'design/scoped/scoped.png',
              contentType: 'image/png',
              contentBase64: 'eA==',
            },
          ],
        },
        // MOTIR-4750 — the caller's OWN item. Minting a presigned write is a
        // WRITE even though it persists no row, so the read-only-token loop
        // asserts it is REFUSED at the scope gate.
        create_design_upload: {
          key: item1,
          files: [
            {
              kind: 'image',
              sourcePath: 'design/scoped/scoped.png',
              contentType: 'image/png',
            },
          ],
        },
        // MOTIR-4704 — the caller's OWN story. Write-scoped tools, so the
        // read-only-token loop asserts both are REFUSED at the scope gate.
        create_acceptance_upload: { key: item1 },
        publish_acceptance_result: {
          key: item1,
          videoPathname: 'acceptance/scoped/scoped.webm',
        },
        // MOTIR-5331 — the caller's OWN item. A write-scoped tool, so the
        // read-only-token loop asserts it is REFUSED at the scope gate.
        publish_test_instructions: {
          key: item1,
          bodyMd: 'scoped',
          repos: [{ repo: 'acme/web', commitSha: 'a'.repeat(40) }],
        },
        // MOTIR-3526 — the caller's OWN item. A write-scoped tool, so the
        // read-only-token loop asserts it is REFUSED at the scope gate; the
        // default-token loop asserts only that the GATE passes it, which it
        // does before the (unconnected) repository is ever resolved.
        link_pull_request: {
          key: item1,
          repository: 'acme/web',
          number: 7,
          headRef: 'subtask/scoped',
          baseRef: 'main',
        },
        // MOTIR-3756 — the caller's OWN item. A write-scoped tool like its
        // sibling, so the read-only-token loop asserts it is REFUSED at the scope
        // gate; the default-token loop asserts only that the GATE passes it,
        // which it does before the (unconnected) repository is ever resolved.
        unlink_pull_request: { key: item1, repository: 'acme/web', number: 7 },
        link_work_items: { fromKey: item1, toKey: item2, relationship: 'relates_to' },
        unlink_work_items: { fromKey: item1, toKey: item2, relationship: 'relates_to' },
        move_to_parent: { key: item1, parentKey: item2 },
        archive_work_item: { key: item2 },
        unarchive_work_item: { key: item2 },
        delete_work_item: { key: item2 },
        create_sprint: { projectKey: 'PROD', name: 'scoped sprint 2' },
        update_sprint: { sprintId: sprint.id, name: 'scoped renamed' },
        delete_sprint: { sprintId: sprint.id },
        move_to_sprint: { keys: [item1], sprintId: sprint.id },
        move_to_backlog: { keys: [item1] },
        start_sprint: { sprintId: sprint.id },
        complete_sprint: { sprintId: sprint.id, carryOverTo: 'backlog' },
        mark_integrated: { key: item1, sessionBranch: 'feat/scoped' },
        complete_session: { sessionBranch: 'feat/scoped' },
      };
      // Totality guard — a tool added to MCP_TOOL_NAMES without a scope-matrix
      // arg fails the suite by construction (the registry-loop guarantee the
      // acceptance criteria require, here at the real-route level too).
      expect(Object.keys(argFor).sort()).toEqual([...MCP_TOOL_NAMES].sort());
      return { argFor, item1, item2 };
    }

    it('a RESTRICTED (read-only) token: every read tool executes, every other tool is scope-denied', async () => {
      const fx = await makeWorkItemFixture();
      const { argFor, item1 } = await ownArgMap(fx);

      // A token granted ONLY `project:browse` — its owner is the workspace
      // owner, so the ROLE permits everything; only the grant narrows it.
      const client = await connect(await grantedToken(fx, ['project:browse'], 'read-only'));
      for (const name of MCP_TOOL_NAMES) {
        const res = await client.callTool({ name, arguments: argFor[name] });
        if (toolPermission(name) === 'project:browse') {
          // Granted: the gate lets it through and it executes successfully
          // against the caller's own reachable data.
          expect(res.isError, `read tool ${name} should execute`).toBeFalsy();
        } else {
          // Ungranted: rejected with the typed scope-denied error BEFORE the
          // service runs (not a 404, not a success).
          expect(isScopeDenied(res), `${name} must be scope-denied for a read-only token`).toBe(
            true,
          );
        }
      }
      await client.close();

      // The gate fired before every write: item1 is byte-for-byte untouched —
      // not renamed, not transitioned, not archived, no comment landed.
      const after = await workItemsService.getIssueDetail(fx.projectId, item1, fx.ctx);
      expect(after.item.title).toBe('Scope-1');
      expect(after.item.status).toBe('todo');
      expect(after.item.archivedAt).toBeNull();
      const itemRow = await adminDb.workItem.findFirstOrThrow({ where: { identifier: item1 } });
      const commentCount = await adminDb.comment.count({ where: { workItemId: itemRow.id } });
      expect(commentCount).toBe(0);
    });

    it('the DEFAULT token (all-minus-delete) passes the gate for every tool EXCEPT delete_work_item', async () => {
      const fx = await makeWorkItemFixture();
      const { argFor } = await ownArgMap(fx);

      // The default grant set (every scope except work_items:delete), minted by
      // OMITTING the scopes option — exactly what the create modal sends.
      expect(DEFAULT_TOKEN_GRANT).not.toContain('work_item:delete');
      const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
        label: 'default',
        fixedGrant: DEFAULT_TOKEN_GRANT,
      });
      const client = await connect(token);

      // The gate's verdict per tool: only delete_work_item is withheld. (We
      // assert the GATE decision — that downstream execution is correct is the
      // tool/UI-parity pillar's job — so this stays robust to mutation ordering.)
      // ⚠️ ARCHIVE LEAVES DELETE AGAIN (MOTIR-3629). This read "ARCHIVE JOINS
      // DELETE: under the six scopes archive was on by default (recoverable) and
      // delete off; both assert `work_item:delete` in shipped code, so one key
      // cannot hold them apart and 'all but the irreversible one' withholds all
      // three (ADR §8)." The key that holds them apart is `work_item:archive`
      // (ADR §10), so the default grant is back to withholding exactly the
      // irreversible tool — by the same derivation, with no arm added.
      const defaultOff = new Set(['delete_work_item']);
      for (const name of MCP_TOOL_NAMES) {
        const res = await client.callTool({ name, arguments: argFor[name] });
        if (defaultOff.has(name)) {
          expect(isScopeDenied(res), `${name} is default-off`).toBe(true);
        } else {
          expect(isScopeDenied(res), `${name} should pass the default token's gate`).toBe(false);
        }
      }
      await client.close();
    });

    it('a DEFAULT token DOES the non-delete work — write/sprint/integration AND archive succeed', async () => {
      const fx = await makeWorkItemFixture();
      const key = await makeTask(fx, 'Default does work');
      const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
        label: 'default-does',
        fixedGrant: DEFAULT_TOKEN_GRANT,
      });
      const client = await connect(token);

      // work_items:write — transition lands the board-drag revision.
      const moved = await client.callTool({
        name: 'transition_status',
        arguments: { key, status: 'in_progress' },
      });
      expect(moved.isError).toBeFalsy();
      // ⚠️ ARCHIVE IS DEFAULT-ON AGAIN (MOTIR-3629). This asserted the REFUSAL —
      // "archive is no longer default-on: it asserts `work_item:delete`, the one
      // key the default grant withholds (ADR §8)" — and that refusal was the
      // accepted cost of one key serving two operations. Archive asserts
      // `work_item:archive` now, so a default-minted token archives and still
      // cannot delete. The restore below returns the item to the state the
      // committed-effects assertions at the end of this test expect.
      const archived = await client.callTool({ name: 'archive_work_item', arguments: { key } });
      expect(archived.isError).toBeFalsy();
      const restored = await client.callTool({ name: 'unarchive_work_item', arguments: { key } });
      expect(restored.isError).toBeFalsy();
      // sprint:manage — create a sprint.
      const sprintRes = await client.callTool({
        name: 'create_sprint',
        arguments: { projectKey: 'PROD', name: 'Default sprint' },
      });
      expect(sprintRes.isError).toBeFalsy();
      // work_item:edit — mark the item integrated against a session branch.
      const integrated = await client.callTool({
        name: 'mark_integrated',
        arguments: { key, sessionBranch: 'feat/default' },
      });
      expect(integrated.isError).toBeFalsy();

      // The committed effects are real, not just gate-passed: the item moved off
      // todo and is unarchived, and mark_integrated landed it `implemented` with the
      // session branch stamped (its documented one-transaction effect). The
      // sprint was created too.
      const detail = await workItemsService.getIssueDetail(fx.projectId, key, fx.ctx);
      expect(detail.item.status).toBe('implemented');
      expect(detail.item.sessionBranch).toBe('feat/default');
      expect(detail.item.archivedAt).toBeNull();
      const sprintCount = await adminDb.sprint.count({ where: { projectId: fx.projectId } });
      expect(sprintCount).toBe(1);
      await client.close();
    });

    it('a DELETE-enabled token deletes a throwaway subtree (the one opt-in scope)', async () => {
      const fx = await makeWorkItemFixture();
      const story = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'Throwaway parent' },
        fx.ctx,
      );
      const child = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: 'Throwaway child', parentId: story.id },
        fx.ctx,
      );

      // A token granted the delete scope (+ read to resolve the key) — nothing
      // more. The owner's role reaches the subtree, so scope is the only gate.
      const client = await connect(
        await grantedToken(fx, ['project:browse', 'work_item:delete'], 'deleter'),
      );
      const deleted = await client.callTool({
        name: 'delete_work_item',
        arguments: { key: story.identifier },
      });
      expect(deleted.isError).toBeFalsy();
      await client.close();

      // The whole subtree is gone (the cascade), proving the delete-enabled token
      // actually performed the irreversible op.
      const workItemCount = await adminDb.workItem.count({
        where: { id: { in: [story.id, child.id] } },
      });
      expect(workItemCount).toBe(0);
    });

    it('scope ∩ role — a granted scope still 404s when the role denies; an allowed role still scope-denies when the scope is absent', async () => {
      // Tenant A owns the target item.
      const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
      const key = await makeTask(a, 'A-only');

      // (1) Permission GRANTED (full), role DENIES — an OUTSIDER's fully-granted token
      // aimed at A's item reads as not-found (the 404-not-403 contract), NOT a
      // permission error: the grant narrows the role, it cannot widen a role that can't
      // even see the resource.
      const outsider = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
      const crossTenant = await connect(await fullToken(outsider, 'outsider-full'));
      const roleDenied = await crossTenant.callTool({
        name: 'transition_status',
        arguments: { key, status: 'in_progress' },
      });
      expect(roleDenied.isError).toBe(true);
      expect(JSON.stringify(roleDenied.content)).toContain('NOT_FOUND');
      expect(isScopeDenied(roleDenied), 'role-denied is a 404, not a scope error').toBe(false);
      await crossTenant.close();

      // (2) Role ALLOWS (A's owner), permission ABSENT (browse-only) — the gate
      // fires FIRST and returns the denial, never reaching the role check.
      const scopeShort = await connect(await grantedToken(a, ['project:browse'], 'a-read-only'));
      const scopeDenied = await scopeShort.callTool({
        name: 'transition_status',
        arguments: { key, status: 'in_progress' },
      });
      expect(isScopeDenied(scopeDenied), 'scope-absent → scope-denied').toBe(true);
      await scopeShort.close();

      // The item never moved under either denied call.
      const after = await workItemsService.getIssueDetail(a.projectId, key, a.ctx);
      expect(after.item.status).toBe('todo');
    });
  });
});

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { CLI_TOKEN_GRANT, TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
import { EXEMPT_TOOLS } from '@/lib/mcp/payloads/exemptions';
import { isBillableTool } from '@/lib/mcp/rateLimitGate';
import { permissionDenial } from '@/lib/mcp/permissionGate';
import { REPORT_UNBUILDABLE_TARGET_TOOL_NAME } from '@/lib/mcp/tools/reportUnbuildableTarget';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { foldersService } from '@/lib/services/foldersService';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { mcpRouteFetch } from '../helpers/mcpRouteFetch';

// `report_unbuildable_target` (Story MOTIR-5544 · Subtask MOTIR-6286) — the
// dispatched runner's report that its card is unbuildable, over a real Postgres
// and the REAL `/api/mcp` route with a bearer token.
//
// The tool is a TRANSPORT over `runFoundReportService.reportUnbuildableTarget`,
// whose arms are proven in `tests/runFoundReportService.test.ts`. What is
// asserted HERE is what only the door can answer: the schema an agent sees,
// that the ONE caller it exists for (a token minted with exactly
// `CLI_TOKEN_GRANT`) reaches it, that the answer is the acknowledgement and
// nothing else on every arm, and its refusals. Its `docs/mcp.md` section is
// asserted in `tests/mcp/mcp-doc-guards.test.ts` (the docs-guard lane).

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8');

const ENDPOINT = 'http://localhost/api/mcp';
const REASON = 'The card names a table that does not exist.';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A client on the REAL route, authenticated by a token minted with `grant`. */
async function connectWithGrant(
  fx: WorkItemFixture,
  grant: readonly PermissionKey[],
): Promise<Client> {
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: 'report-unbuildable-target',
    fixedGrant: [...grant],
  });
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: mcpRouteFetch(token),
  });
  const client = new Client({ name: 'report-unbuildable-target', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

const cliClient = (fx: WorkItemFixture) => connectWithGrant(fx, CLI_TOKEN_GRANT);

async function report(
  client: Client,
  args: { projectKey: string; targetKey: string; reason?: string },
): Promise<CallToolResult> {
  return (await client.callTool({
    name: REPORT_UNBUILDABLE_TARGET_TOOL_NAME,
    arguments: { reason: REASON, ...args },
  })) as CallToolResult;
}

const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text?: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');

/** Motir's own tenant, with its planner-bug home and the system principal. */
async function makeMeta(): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture({ name: 'moooon', identifier: 'MOTIR' });
  const planning = await foldersService.createFolder(
    { projectId: fx.projectId, parentFolderId: null, name: 'Planning bugs' },
    fx.ctx,
  );
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { plannerBugDestinationFolderId: planning.id },
  });
  await seedSystemPrincipal({ workspaceId: fx.workspaceId, projectId: fx.projectId });
  return fx;
}

/** A card born of an approved NATIVE plan and never edited — the arm that files. */
async function nativeUnchanged(fx: WorkItemFixture): Promise<{ key: string; planId: string }> {
  const plan = await plansService.createPlan(
    fx.projectId,
    {
      title: 'A native plan',
      authorSource: 'native',
      authorHarness: 'Motir',
      authorModel: 'motir-planner',
    },
    fx.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'A planned card', kind: 'task' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  await plansService.approvePlan(plan.id, fx.ctx);
  const row = await adminDb.planItem.findFirstOrThrow({ where: { planId: plan.id, op: 'add' } });
  const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: row.workItemId! } });
  return { key: item.identifier, planId: plan.id };
}

/** A card no plan ever shaped. */
async function direct(fx: WorkItemFixture, title = 'Never planned'): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return item.identifier;
}

/** A running dispatch run whose legs for `keys` are OPEN. */
async function openLegs(fx: WorkItemFixture, keys: string[]): Promise<void> {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      cards: keys.map((key) => ({ key, disposition: 'queued' as const })),
    },
    fx.ctx,
  );
  await dispatchRunService.appendEvents(
    run.id,
    keys.map((key) => ({
      kind: 'card_claimed' as const,
      workItemKey: key,
      disposition: 'running' as const,
    })),
    fx.ctx,
  );
}

describe('registered, permissioned, declared (criteria 1, 2, 7)', () => {
  it('is in the registry, and every declaration home carries it', () => {
    expect(MCP_TOOL_NAMES).toContain(REPORT_UNBUILDABLE_TARGET_TOOL_NAME);
    expect(TOOL_PERMISSIONS[REPORT_UNBUILDABLE_TARGET_TOOL_NAME]).toBe('work_item:edit');
    expect(TOOL_SCOPES[REPORT_UNBUILDABLE_TARGET_TOOL_NAME]).toBe('work_items:write');
    expect(EXEMPT_TOOLS).toHaveProperty(REPORT_UNBUILDABLE_TARGET_TOOL_NAME);
    expect(read('design/mcp-server/build.py')).toContain(
      `"${REPORT_UNBUILDABLE_TARGET_TOOL_NAME}":`,
    );
  });

  it('is NOT billable — it starts no model job', () => {
    expect(isBillableTool(REPORT_UNBUILDABLE_TARGET_TOOL_NAME)).toBe(false);
  });

  it('CLI_TOKEN_GRANT reaches it — asserted FROM THE CONSTANT — and was not widened', () => {
    expect(CLI_TOKEN_GRANT.includes(TOOL_PERMISSIONS.report_unbuildable_target)).toBe(true);
    expect(permissionDenial(REPORT_UNBUILDABLE_TARGET_TOOL_NAME, [...CLI_TOKEN_GRANT])).toBeNull();
    // Byte-identical to the grant before MOTIR-6286: the tool rides a key the
    // grant already held. A change here is a widening, and it needs its own card.
    expect(JSON.stringify(CLI_TOKEN_GRANT)).toBe(
      JSON.stringify([
        'project:browse',
        'lesson:view',
        'lesson:reinforce',
        'work_item:edit',
        'comment:add',
        // MOTIR-6329 — the Plans and Runs rooms' view keys; the argument is at
        // the constant (a stated widening, not an unrelated one).
        'plan:view_any',
        'run:view_any',
        // MOTIR-7412 — the page keys, for `get_page` / `create_page` / `update_page`;
        // the argument is at the constant. `page:delete` stays out.
        'page:view',
        'page:edit',
        // MOTIR-11038 — `repository:manage`, for `create_project_repository`; the
        // argument is at the constant (a stated widening, not an unrelated one).
        'repository:manage',
        'ai:plan',
      ]),
    );
    expect(CLI_TOKEN_GRANT).not.toContain('ai:view_plan');
  });

  it('the tool module makes no Prisma call of its own', () => {
    const source = read('lib/mcp/tools/reportUnbuildableTarget.ts');
    expect(source).not.toMatch(/prisma\./);
    expect(source).not.toMatch(/from '@\/lib\/db'/);
    expect(source).not.toMatch(/lib\/repositories\//);
  });

  it('tools/list advertises it with { projectKey, targetKey, reason }, all required', async () => {
    const fx = await makeWorkItemFixture();
    const server = buildMcpServer(() => fx.ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'report-unbuildable-target', version: '0.0.0' });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === REPORT_UNBUILDABLE_TARGET_TOOL_NAME)!;
    expect(tool).toBeDefined();
    const schema = tool.inputSchema as {
      properties: Record<string, { type?: string }>;
      required?: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual(['projectKey', 'reason', 'targetKey']);
    expect([...(schema.required ?? [])].sort()).toEqual(['projectKey', 'reason', 'targetKey']);
    for (const field of ['projectKey', 'targetKey', 'reason']) {
      expect(schema.properties[field]!.type).toBe('string');
    }
    // It tells the runner what the record says, and nothing about what the
    // server does with the report.
    const description = tool.description ?? '';
    expect(description).toContain('spends nothing');
    expect(description).toContain('safe to repeat');
    expect(description).toContain('nothing to act on');
    expect(description).not.toMatch(/verdict|unchanged|native|planning bug|planner|classif/i);
    await client.close();
  });
});

describe('over the REAL /api/mcp with a token minted from EXACTLY CLI_TOKEN_GRANT (3, 4)', () => {
  it('on a card with an open leg it succeeds, and answers the acknowledgement only', async () => {
    const meta = await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await nativeUnchanged(fx);
    await openLegs(fx, [card.key]);
    const client = await cliClient(fx);

    const result = await report(client, { projectKey: 'CUST', targetKey: card.key });

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(Object.keys(result.structuredContent!).sort()).toEqual([
      'acknowledged',
      'recordedOnRun',
    ]);
    expect(result.structuredContent).toStrictEqual({ acknowledged: true, recordedOnRun: true });

    // The arm that FILES — and nothing of it reaches the runner.
    const bugs = await adminDb.workItem.findMany({
      where: { projectId: meta.projectId, kind: 'bug' },
    });
    expect(bugs).toHaveLength(1);
    const text = textOf(result);
    expect(text).toContain(card.key);
    expect(text).not.toContain(bugs[0]!.identifier);
    expect(text).not.toContain(card.planId);
    expect(text).not.toMatch(/unchanged|changed|no_plan|verdict|native|planning bug/i);
    await client.close();
  });

  it('the text is IDENTICAL on every leg arm — a filed bug and no plan read the same', async () => {
    await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const filed = await nativeUnchanged(fx);
    const noPlan = await direct(fx);
    await openLegs(fx, [filed.key, noPlan]);
    const client = await cliClient(fx);

    const a = await report(client, { projectKey: 'CUST', targetKey: filed.key });
    const b = await report(client, { projectKey: 'CUST', targetKey: noPlan.toLowerCase() });

    expect(a.structuredContent).toStrictEqual(b.structuredContent);
    expect(textOf(a).replace(filed.key, '<KEY>')).toBe(textOf(b).replace(noPlan, '<KEY>'));
    // Safe to repeat: the same acknowledgement, the same text.
    const again = await report(client, { projectKey: 'CUST', targetKey: filed.key });
    expect(again.structuredContent).toStrictEqual(a.structuredContent);
    expect(textOf(again)).toBe(textOf(a));
    await client.close();
  });

  it('with no open leg it answers recordedOnRun: false and nothing else', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const key = await direct(fx);
    const client = await cliClient(fx);

    const result = await report(client, { projectKey: 'CUST', targetKey: key });

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(Object.keys(result.structuredContent!).sort()).toEqual([
      'acknowledged',
      'recordedOnRun',
    ]);
    expect(result.structuredContent).toStrictEqual({ acknowledged: true, recordedOnRun: false });
    expect(textOf(result)).not.toMatch(/unchanged|changed|no_plan|verdict|native|planning bug/i);
    await client.close();
  });
});

describe('refusals (criterion 5)', () => {
  it('an empty reason and a 4001-character reason carry RUN_FOUND_REPORT_REASON_INVALID', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const key = await direct(fx);
    const client = await cliClient(fx);

    for (const reason of ['', '   ', 'x'.repeat(4001)]) {
      const result = await report(client, { projectKey: 'CUST', targetKey: key, reason });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^RUN_FOUND_REPORT_REASON_INVALID: /);
    }
    // The bound is inclusive at 4000.
    const edge = await report(client, {
      projectKey: 'CUST',
      targetKey: key,
      reason: 'x'.repeat(4000),
    });
    expect(edge.isError, textOf(edge)).toBeFalsy();
    await client.close();
  });

  it('an unknown key and another workspace’s key answer the SAME not-found', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const foreign = await direct(other, 'Someone else’s card');
    await openLegs(other, [foreign]);
    const client = await cliClient(fx);

    const unknown = await report(client, { projectKey: 'CUST', targetKey: 'CUST-999' });
    const crossTenant = await report(client, { projectKey: 'OTHR', targetKey: foreign });

    expect(unknown.isError).toBe(true);
    expect(crossTenant.isError).toBe(true);
    expect(textOf(unknown)).toMatch(/^WORK_ITEM_NOT_FOUND: /);
    expect(textOf(crossTenant).replace(foreign, '<KEY>')).toBe(
      textOf(unknown).replace('CUST-999', '<KEY>'),
    );
    // …and nothing was recorded on the other workspace's run.
    expect(await adminDb.runFoundReport.count()).toBe(0);
    await client.close();
  });
});

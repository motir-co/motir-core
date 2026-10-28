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
import { RECORD_RUN_DISCREPANCY_TOOL_NAME } from '@/lib/mcp/tools/recordRunDiscrepancy';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { mcpRouteFetch } from '../helpers/mcpRouteFetch';

// `record_run_discrepancy` (Story MOTIR-8651 · Subtask MOTIR-8657) — the runner's record of what
// it built differently from a plan that was wrong only about the HOW, over a real Postgres and
// the REAL `/api/mcp` route with a token minted from exactly `CLI_TOKEN_GRANT`.
//
// The tool is a TRANSPORT over `runDiscrepancyService.recordDiscrepancy`, whose arms are proven
// in `tests/runDiscrepancyService.test.ts`. What is asserted HERE is what only the door can
// answer: the schema an agent sees, that the ONE caller it exists for reaches it without a
// widened grant, the acknowledgement shape, and the refusals' codes.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8');

const ENDPOINT = 'http://localhost/api/mcp';
const POINT = {
  planAsked: 'Add a column.',
  built: 'Reused the existing one.',
  why: 'It was there.',
};

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function cliClient(fx: WorkItemFixture): Promise<Client> {
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: 'record-run-discrepancy',
    fixedGrant: [...CLI_TOKEN_GRANT],
  });
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: mcpRouteFetch(token),
  });
  const client = new Client({ name: 'record-run-discrepancy', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function record(
  client: Client,
  args: { key: string; points?: Record<string, string>[]; decisions?: Record<string, string>[] },
): Promise<CallToolResult> {
  return (await client.callTool({
    name: RECORD_RUN_DISCREPANCY_TOOL_NAME,
    arguments: args,
  })) as CallToolResult;
}

const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text?: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');

async function card(fx: WorkItemFixture): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Built through' },
    fx.ctx,
  );
  return item.identifier;
}

async function openLeg(fx: WorkItemFixture, key: string): Promise<void> {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      cards: [{ key, disposition: 'queued' as const }],
    },
    fx.ctx,
  );
  await dispatchRunService.appendEvents(
    run.id,
    [{ kind: 'card_claimed' as const, workItemKey: key, disposition: 'running' as const }],
    fx.ctx,
  );
}

describe('registered, permissioned, declared', () => {
  it('is in the registry, and every declaration home carries it', () => {
    expect(MCP_TOOL_NAMES).toContain(RECORD_RUN_DISCREPANCY_TOOL_NAME);
    expect(TOOL_PERMISSIONS[RECORD_RUN_DISCREPANCY_TOOL_NAME]).toBe('work_item:edit');
    expect(TOOL_SCOPES[RECORD_RUN_DISCREPANCY_TOOL_NAME]).toBe('work_items:write');
    expect(EXEMPT_TOOLS).toHaveProperty(RECORD_RUN_DISCREPANCY_TOOL_NAME);
    expect(read('design/mcp-server/build.py')).toContain(`"${RECORD_RUN_DISCREPANCY_TOOL_NAME}":`);
  });

  it('is NOT billable, and CLI_TOKEN_GRANT reaches it without being widened', () => {
    expect(isBillableTool(RECORD_RUN_DISCREPANCY_TOOL_NAME)).toBe(false);
    expect(CLI_TOKEN_GRANT.includes(TOOL_PERMISSIONS.record_run_discrepancy)).toBe(true);
    expect(permissionDenial(RECORD_RUN_DISCREPANCY_TOOL_NAME, [...CLI_TOKEN_GRANT])).toBeNull();
  });

  it('the tool module makes no Prisma call of its own', () => {
    const source = read('lib/mcp/tools/recordRunDiscrepancy.ts');
    expect(source).not.toMatch(/prisma\./);
    expect(source).not.toMatch(/from '@\/lib\/db'/);
    expect(source).not.toMatch(/lib\/repositories\//);
  });

  it('tools/list advertises it with { key, points, decisions }, only key required', async () => {
    const fx = await makeWorkItemFixture();
    const server = buildMcpServer(() => fx.ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'record-run-discrepancy', version: '0.0.0' });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === RECORD_RUN_DISCREPANCY_TOOL_NAME)!;
    expect(tool).toBeDefined();
    const schema = tool.inputSchema as { properties: Record<string, unknown>; required?: string[] };
    // `decisions` (MOTIR-10000) rides the same record, so `points` is no longer required.
    expect(Object.keys(schema.properties).sort()).toEqual(['decisions', 'key', 'points']);
    expect([...(schema.required ?? [])].sort()).toEqual(['key']);
    expect(tool.description).toContain('never ask the user');
    await client.close();
  });
});

describe('over the REAL /api/mcp with a token minted from EXACTLY CLI_TOKEN_GRANT', () => {
  it('on a card with an open leg it records, and answers { commentId, recorded: true }', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const key = await card(fx);
    await openLeg(fx, key);
    const client = await cliClient(fx);

    const result = await record(client, { key, points: [POINT] });

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(Object.keys(result.structuredContent!).sort()).toEqual(['commentId', 'recorded']);
    expect(result.structuredContent).toMatchObject({ recorded: true });
    await client.close();
  });

  it('with no open leg it still writes the comment and answers recorded: false', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const key = await card(fx);
    const client = await cliClient(fx);

    const result = await record(client, { key, points: [POINT] });

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ recorded: false });
    await client.close();
  });
});

describe('decisions (MOTIR-10000) — the same door, round-tripped', () => {
  const DECISION = {
    planSaid: 'Nothing: the card names no page size.',
    chose: 'Cursor pagination, 50 per page.',
    why: 'Every other list endpoint in the repository pages this way.',
  };

  it('decisions alone record on the open leg and land in the comment', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const key = await card(fx);
    await openLeg(fx, key);
    const client = await cliClient(fx);

    const result = await record(client, { key, decisions: [DECISION] });

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ recorded: true });
    expect(textOf(result)).toContain('the decisions you made');
    const comment = await adminDb.comment.findUniqueOrThrow({
      where: { id: (result.structuredContent as { commentId: string }).commentId },
    });
    expect(comment.bodyMd).toContain(DECISION.chose);
    const [finding] = await adminDb.dispatchRunEvent.findMany({
      where: { kind: 'discrepancy_recorded' },
    });
    expect(finding!.data).toMatchObject({ pointCount: 1, decisionCount: 1 });
    await client.close();
  });

  it('points and decisions in one call, and a decision with an empty field is refused', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const key = await card(fx);
    const client = await cliClient(fx);

    const both = await record(client, { key, points: [POINT], decisions: [DECISION] });
    expect(both.isError, textOf(both)).toBeFalsy();

    const empty = await record(client, { key, decisions: [{ ...DECISION, why: ' ' }] });
    expect(empty.isError).toBe(true);
    expect(textOf(empty)).toMatch(/^RUN_DISCREPANCY_INVALID: /);
    const none = await record(client, { key });
    expect(none.isError).toBe(true);
    expect(textOf(none)).toMatch(/^RUN_DISCREPANCY_INVALID: /);
    await client.close();
  });
});

describe('refusals', () => {
  it('a second call on the same leg carries DISCREPANCY_ALREADY_RECORDED', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const key = await card(fx);
    await openLeg(fx, key);
    const client = await cliClient(fx);

    await record(client, { key, points: [POINT] });
    const again = await record(client, { key, points: [POINT] });

    expect(again.isError).toBe(true);
    expect(textOf(again)).toMatch(/^DISCREPANCY_ALREADY_RECORDED: /);
    await client.close();
  });

  it('no points, and an empty field, carry RUN_DISCREPANCY_INVALID', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const key = await card(fx);
    const client = await cliClient(fx);

    for (const points of [
      [],
      [{ ...POINT, why: '   ' }],
      [{ ...POINT, built: 'x'.repeat(2001) }],
    ]) {
      const result = await record(client, { key, points });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^RUN_DISCREPANCY_INVALID: /);
    }
    await client.close();
  });

  it('an unknown key answers WORK_ITEM_NOT_FOUND', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const client = await cliClient(fx);

    const result = await record(client, { key: 'CUST-999', points: [POINT] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^WORK_ITEM_NOT_FOUND: /);
    await client.close();
  });
});

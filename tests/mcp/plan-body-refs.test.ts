import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  UPDATE_PLAN_ITEM_TOOL_NAME,
  UPDATE_PLAN_PROPOSAL_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { plansService } from '@/lib/services/plansService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A proposal body's item link WITHOUT the `planItem:` prefix is KEPT and WARNED
// at every plan door (bugs MOTIR-6494 · MOTIR-10104). `[label](motir-ref:<id>)`
// matches no reader, so approve would ship it as dead text; MOTIR-6494 refused
// the whole write over it, which threw away a body that was otherwise right.
// Each door now stores the body, says "written, with N links to fix" under its
// summary, and carries the warning — with the corrected link — on the
// structured payload. Each door is proven by CALLING it: the three MCP tools a
// plan author writes bodies through.
//
// Real Postgres, the real MCP server over the in-memory transport.

const ids = (r: CallToolResult) =>
  (r.structuredContent as unknown as { planItemIds: string[] }).planItemIds;
const text = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'plan-body-refs', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

async function openPlan(client: Client, fx: WorkItemFixture): Promise<string> {
  const result = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title: 'A plan whose cards link each other',
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5-5',
  });
  expect(result.isError).toBeFalsy();
  return (result.structuredContent as unknown as { id: string }).id;
}

/** Append one plain `add` and return its planItem id — the sibling a body links to. */
async function appendSibling(client: Client, planId: string): Promise<string> {
  const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    proposals: [{ op: 'add', proposedFields: { title: 'The sibling', kind: 'task' } }],
  });
  expect(appended.isError).toBeFalsy();
  return ids(appended)[0]!;
}

interface Warning {
  planItemId: string;
  field: string;
  link: string;
  correctedLink: string | null;
}
const warnings = (r: CallToolResult) =>
  (r.structuredContent as unknown as { warnings?: Warning[] }).warnings;

/** The write landed, and it says which link to fix and how. */
function expectWrittenAndWarned(result: CallToolResult, token: string, corrected: string): void {
  expect(result.isError).toBeFalsy();
  expect(text(result)).toContain('Written, with 1 link(s) to fix');
  expect(text(result)).toContain(token);
  expect(text(result)).toContain(`Write \`${corrected}\` instead.`);
  expect(warnings(result)).toEqual([
    expect.objectContaining({ link: token, correctedLink: corrected }),
  ]);
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('add_plan_items — the APPEND door', () => {
  it('keeps an `add` whose descriptionMd links a sibling without `planItem:`, warning with the canonical token', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const sibling = await appendSibling(client, planId);
    const token = `[the sibling](motir-ref:${sibling})`;

    const result = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Links it', kind: 'task', descriptionMd: `Needs ${token}.` },
        },
      ],
    });
    expectWrittenAndWarned(result, token, `[the sibling](motir-ref:planItem:${sibling})`);
    expect(warnings(result)![0]!.field).toBe('descriptionMd');
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(2);
    await client.close();
  });

  it('keeps the same form in an `add`’s explanationMd and in a `modify`’s patch, warning on each', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const sibling = await appendSibling(client, planId);
    const token = `[x](motir-ref:${sibling})`;
    const target = await createTestWorkItem(fx, { title: 'A committed leaf', kind: 'task' });

    const onExplanation = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'add', proposedFields: { title: 'Why', kind: 'task', explanationMd: token } },
      ],
    });
    expectWrittenAndWarned(onExplanation, token, `[x](motir-ref:planItem:${sibling})`);
    expect(warnings(onExplanation)![0]!.field).toBe('explanationMd');

    const onPatch = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'modify', workItemId: target.id, patch: { descriptionMd: `Now after ${token}.` } },
      ],
    });
    expectWrittenAndWarned(onPatch, token, `[x](motir-ref:planItem:${sibling})`);
    await client.close();
  });

  it('accepts the canonical form, and approve rewrites it to the created sibling’s `motir:<id>`', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const sibling = await appendSibling(client, planId);

    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      final: true,
      proposals: [
        {
          op: 'add',
          proposedFields: {
            title: 'Links it',
            kind: 'task',
            // A link inside inline code is literal text, not a link, so it is not warned.
            descriptionMd: `Needs [the sibling](motir-ref:planItem:${sibling}). Syntax: \`[x](motir-ref:<id>)\`.`,
          },
        },
      ],
    });
    expect(appended.isError).toBeFalsy();
    expect(warnings(appended)).toBeUndefined();
    expect(text(appended)).not.toContain('link(s) to fix');

    await plansService.approvePlan(planId, fx.ctx);
    const [created, linker] = await Promise.all([
      adminDb.workItem.findFirstOrThrow({
        where: { projectId: fx.projectId, title: 'The sibling' },
      }),
      adminDb.workItem.findFirstOrThrow({ where: { projectId: fx.projectId, title: 'Links it' } }),
    ]);
    expect(linker.descriptionMd).toBe(
      `Needs [the sibling](motir:${created.id}). Syntax: \`[x](motir-ref:<id>)\`.`,
    );
    await client.close();
  });
});

describe('update_plan_item — the DEEPEN door', () => {
  it('keeps a deepen whose body links a sibling without `planItem:`, and warns with the canonical token', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const sibling = await appendSibling(client, planId);
    const token = `[the sibling](motir-ref:${sibling})`;

    const result = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId: sibling,
      explanationMd: `Matters because of ${token}.`,
    });
    expectWrittenAndWarned(result, token, `[the sibling](motir-ref:planItem:${sibling})`);
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: sibling } });
    expect((row.proposedFields as { explanationMd?: string }).explanationMd).toBe(
      `Matters because of ${token}.`,
    );
    await client.close();
  });
});

describe('update_plan_proposal — the CORRECTION door', () => {
  it('keeps a correction of an `add` and of a `modify`’s patch on a CLOSED plan, warning on each — and approve refuses until it is fixed', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const target = await createTestWorkItem(fx, { title: 'A committed leaf', kind: 'task' });
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      final: true,
      proposals: [
        { op: 'add', proposedFields: { title: 'Correct me', kind: 'task' } },
        { op: 'modify', workItemId: target.id, patch: { priority: 'low' } },
      ],
    });
    const [addId, modifyId] = ids(appended);
    const token = `[the add](motir-ref:${addId})`;

    const onAdd = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: addId!,
      descriptionMd: `See ${token}.`,
    });
    const corrected = `[the add](motir-ref:planItem:${addId})`;
    expectWrittenAndWarned(onAdd, token, corrected);

    const onModify = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: modifyId!,
      patch: { priority: 'low', descriptionMd: `After ${token}.` },
    });
    expectWrittenAndWarned(onModify, token, corrected);

    // The kept link stops approve, naming the same correction.
    await expect(plansService.approvePlan(planId, fx.ctx)).rejects.toThrow(corrected);
    await client.close();
  });
});

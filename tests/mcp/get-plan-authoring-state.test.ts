import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { isBillableTool } from '@/lib/mcp/rateLimitGate';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  REPORT_PLAN_STEP_TOOL_NAME,
  UPDATE_PLAN_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { GET_PLAN_AUTHORING_STATE_TOOL_NAME } from '@/lib/mcp/tools/getPlanAuthoringState';
import type { PlanAuthoringStateDto } from '@/lib/services/planAuthoringStateService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `get_plan_authoring_state` (MOTIR-9821) through the real MCP transport and the
// real step rows `report_plan_step` writes. The derivation's every branch is
// `tests/unit/plans/authoringState.test.ts`; what only the transport and the store
// can answer is asserted here:
//
//   1. THE TOOL EXISTS, as a free `project:browse` read.
//   2. A card whose `author` step is LIVE reads `authoring`; once its session
//      `end`s it reads `authored` — the narration-session row outlives the step.
//   3. A title-only card nobody has opened reads `not_started`, and a card the
//      append landed COMPLETE reads `authored` with no session at all.
//   4. (MOTIR-10001) A COMMITTED card the lay listed — by a title `modify`, or in
//      the plan's `plannerRecord.walkListed` — reads its authoring state; one the
//      plan does not author, named in `workItems` by key, reads `not_in_walk`.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'get-plan-authoring-state', version: '0.0.0' });
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

const read = async (client: Client, planId: string) => {
  const res = await call(client, GET_PLAN_AUTHORING_STATE_TOOL_NAME, { planId });
  expect(res.isError).toBeFalsy();
  const dto = res.structuredContent as unknown as PlanAuthoringStateDto;
  return new Map(dto.proposals.map((p) => [p.ref, p.state]));
};

describe('the tool is registered, permissioned and free', () => {
  it('is in the registry as a `project:browse` read that bills nothing', () => {
    expect(MCP_TOOL_NAMES).toContain(GET_PLAN_AUTHORING_STATE_TOOL_NAME);
    expect(TOOL_PERMISSIONS[GET_PLAN_AUTHORING_STATE_TOOL_NAME]).toBe('project:browse');
    expect(isBillableTool(GET_PLAN_AUTHORING_STATE_TOOL_NAME)).toBe(false);
  });
});

describe('driven through the real transport', () => {
  it('reads not_started, then authoring while the step is live, then authored after `end`', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const created = await call(client, CREATE_PLAN_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
      title: 'Being written',
    });
    const planId = (created.structuredContent as unknown as { id: string }).id;
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'add', proposedFields: { title: 'Writes the picker', kind: 'story' } },
        { op: 'add', proposedFields: { title: 'Writes the list', kind: 'story' } },
        {
          op: 'add',
          proposedFields: {
            title: 'Arrives whole',
            kind: 'epic',
            sections: { framing: 'What the epic is for.', scopeBoundary: 'Stops at the list.' },
            explanationMd: 'Why it matters.',
          },
        },
      ],
    });
    expect(appended.isError).toBeFalsy();
    const [picker, list, whole] = (
      appended.structuredContent as unknown as { planItemIds: string[] }
    ).planItemIds.map((id) => `planItem:${id}`);

    const before = await read(client, planId);
    expect(before.get(picker!)).toBe('not_started');
    expect(before.get(list!)).toBe('not_started');
    // A card the append landed COMPLETE never gets an author session, and reads
    // `authored` all the same — read sessions-only it would be `not_started` for ever.
    expect(before.get(whole!)).toBe('authored');

    await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'author-picker',
      step: 'author',
      target: picker,
    });
    const during = await read(client, planId);
    expect(during.get(picker!)).toBe('authoring');
    expect(during.get(list!)).toBe('not_started');

    await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'author-picker',
      step: 'end',
    });
    const after = await read(client, planId);
    // The session ended with the card still title-only — it is AUTHORED all the same:
    // nobody will open a second session on it, so it never reads a boundary again.
    expect(after.get(picker!)).toBe('authored');
    expect(after.get(list!)).toBe('not_started');
  });
});

describe('committed cards (MOTIR-10001)', () => {
  it('answers lay-listed committed cards with their state and an unlisted one as `not_in_walk`', async () => {
    const fx = await makeWorkItemFixture();
    const retitled = await createTestWorkItem(fx, { kind: 'story', title: 'Old title' });
    const recorded = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'Recorded by the driver',
    });
    const outside = await createTestWorkItem(fx, { kind: 'story', title: 'Never re-written' });
    const client = await connectClient(fx.ctx);
    const created = await call(client, CREATE_PLAN_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
      title: 'Re-plan',
    });
    const planId = (created.structuredContent as unknown as { id: string }).id;
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: retitled.id, patch: { title: 'New title' } }],
    });
    expect(appended.isError).toBeFalsy();
    const recordedWrite = await call(client, UPDATE_PLAN_TOOL_NAME, {
      planId,
      plannerRecord: { walkListed: [recorded.id] },
    });
    expect(recordedWrite.isError).toBeFalsy();

    const ask = async () => {
      const res = await call(client, GET_PLAN_AUTHORING_STATE_TOOL_NAME, {
        planId,
        workItems: [outside.identifier, 'PROD-99999'],
      });
      expect(res.isError).toBeFalsy();
      return res.structuredContent as unknown as PlanAuthoringStateDto;
    };
    const before = await ask();
    expect(before.proposals).toEqual([]);
    const byId = new Map(before.committed.map((c) => [c.ref, c]));
    expect(byId.get(retitled.id)).toMatchObject({ inWalk: true, state: 'not_started' });
    expect(byId.get(recorded.id)).toMatchObject({
      key: recorded.identifier,
      inWalk: true,
      state: 'not_started',
    });
    expect(byId.get(outside.id)).toMatchObject({
      key: outside.identifier,
      inWalk: false,
      state: 'not_in_walk',
    });
    expect(before.unresolved).toEqual(['PROD-99999']);

    await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'author-recorded',
      step: 'author',
      target: recorded.id,
    });
    const during = new Map((await ask()).committed.map((c) => [c.ref, c.state]));
    expect(during.get(recorded.id)).toBe('authoring');
    expect(during.get(retitled.id)).toBe('not_started');

    await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'author-recorded',
      step: 'end',
    });
    const after = new Map((await ask()).committed.map((c) => [c.ref, c.state]));
    expect(after.get(recorded.id)).toBe('authored');
    expect(after.get(outside.id)).toBe('not_in_walk');
  });
});

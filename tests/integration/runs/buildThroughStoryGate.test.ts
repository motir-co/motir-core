import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { CLAIM_WORK_ITEM_TOOL_NAME } from '@/lib/mcp/tools/claimWorkItem';
import { RECORD_RUN_DISCREPANCY_TOOL_NAME } from '@/lib/mcp/tools/recordRunDiscrepancy';
import { REPORT_UNBUILDABLE_TARGET_TOOL_NAME } from '@/lib/mcp/tools/reportUnbuildableTarget';
import { START_WORK_ITEM_RUN_TOOL_NAME } from '@/lib/mcp/tools/workItemRun';
import { assembleDispatchPrompt, type DispatchPromptSource } from '@/lib/dispatch/promptTemplate';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { foldersService } from '@/lib/services/foldersService';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { mcpRouteFetch } from '../../helpers/mcpRouteFetch';

// THE BUILD-THROUGH STORY'S INTEGRATION GATE (Story MOTIR-8651 · Subtask MOTIR-8662,
// decision page MOTIR-8654) — the server side of "a run builds through a wrong HOW and
// records it", assembled, over a real Postgres and the REAL `/api/mcp` route with tokens
// minted from EXACTLY `CLI_TOKEN_GRANT`.
//
// Each piece has its own suite, and NOT re-proven here: the service's arms
// (`tests/runDiscrepancyService.test.ts`), the tool's declaration homes and schema
// (`tests/mcp/record-run-discrepancy.test.ts`), the prompt's wording
// (`tests/dispatch/promptTemplate.test.ts`), the strip's rendering
// (`tests/components/RunFindings.test.tsx`). What only this file sees is the three kinds of
// run leg meeting the one door and the one detail read, and STOP's verdict gate sitting
// beside a build-through on the same data.
//
// ⚠️ Two places where the SHIPPED code and the card's wording differ, and the shipped code
// (the decision page) is asserted: the invalid-input refusal is `RUN_DISCREPANCY_INVALID`,
// and an event's `reportedBy` follows the RUN's reporter (`cli` for a CLI run, `agent` for
// an agent-reported one — decision page §8.2), so only the agent-reported leg reads `agent`.

const ENDPOINT = 'http://localhost/api/mcp';

const POINTS = [1, 2, 3].map((n) => ({
  planAsked: `PLAN-ASKED-${n}`,
  built: `BUILT-${n}`,
  why: `WHY-${n}`,
}));
const POINT_TEXTS = POINTS.flatMap((p) => [p.planAsked, p.built, p.why]);

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function connectWithGrant(
  fx: WorkItemFixture,
  grant: readonly PermissionKey[] = CLI_TOKEN_GRANT,
): Promise<Client> {
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: 'build-through-gate',
    fixedGrant: [...grant],
  });
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: mcpRouteFetch(token),
  });
  const client = new Client({ name: 'build-through-gate', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text?: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');

const record = (client: Client, key: string, points: unknown[] = POINTS) =>
  client.callTool({
    name: RECORD_RUN_DISCREPANCY_TOOL_NAME,
    arguments: { key, points },
  }) as Promise<CallToolResult>;

const unbuildable = (client: Client, projectKey: string, targetKey: string) =>
  client.callTool({
    name: REPORT_UNBUILDABLE_TARGET_TOOL_NAME,
    arguments: { projectKey, targetKey, reason: 'The card names a table that does not exist.' },
  }) as Promise<CallToolResult>;

async function task(fx: WorkItemFixture, title: string, parentId?: string): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
  return item.identifier;
}

/** A CLI run whose legs for `keys` are OPEN, as the CLI's run ingest leaves them. */
async function openCliLegs(
  fx: WorkItemFixture,
  keys: string[],
  scopeKey?: string,
): Promise<string> {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      ...(scopeKey ? { scopeKey } : {}),
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
  return run.id;
}

const discrepancyEvents = (runId: string) =>
  adminDb.dispatchRunEvent.findMany({
    where: { dispatchRunId: runId, kind: 'discrepancy_recorded' },
    orderBy: { seq: 'asc' },
  });

const commentsOn = (key: string) =>
  adminDb.comment.findMany({
    where: { workItem: { identifier: key } },
    orderBy: { createdAt: 'asc' },
  });

// Since MOTIR-11996 the door's write on the CARD is the record, never a comment.
const recordsOn = (key: string) =>
  adminDb.runDiscrepancyRecord.findMany({
    where: { workItem: { identifier: key } },
    include: { entries: { orderBy: [{ kind: 'asc' }, { position: 'asc' }] } },
  });

async function legId(runId: string, key: string): Promise<string> {
  const leg = await adminDb.dispatchRunCard.findFirstOrThrow({
    where: { dispatchRunId: runId, workItem: { identifier: key } },
  });
  return leg.id;
}

describe('the three kinds of leg, each from a CLI_TOKEN_GRANT token (cases 1–3)', () => {
  it('1 · a CLI leg: one record, no comment, one event, the pointer only, reportedBy "cli"', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const key = await task(fx, 'Built through');
    const runId = await openCliLegs(fx, [key]);
    const client = await connectWithGrant(fx);

    const result = await record(client, key);

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(Object.keys(result.structuredContent!).sort()).toEqual(['recordId', 'recorded']);
    expect(result.structuredContent).toMatchObject({ recorded: true });

    expect(await commentsOn(key)).toHaveLength(0);
    const records = await recordsOn(key);
    expect(records).toHaveLength(1);
    const texts = records[0]!.entries.flatMap((e) => [e.planText, e.outcomeText, e.why]);
    for (const t of POINT_TEXTS) expect(texts).toContain(t);

    const events = await discrepancyEvents(runId);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toStrictEqual({
      recordId: (result.structuredContent as { recordId: string }).recordId,
      pointCount: 3,
      dispatchRunCardId: await legId(runId, key),
    });
    expect(events[0]!.reportedBy).toBe('cli');
    await client.close();
  });

  it('2 · an agent-reported leg: opened by start_work_item_run, the same answer and record', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const key = await task(fx, 'Built by the skill');
    const client = await connectWithGrant(fx);
    const claimed = (await client.callTool({
      name: CLAIM_WORK_ITEM_TOOL_NAME,
      arguments: { key },
    })) as CallToolResult;
    expect(claimed.isError, textOf(claimed)).toBeFalsy();
    const started = (await client.callTool({
      name: START_WORK_ITEM_RUN_TOOL_NAME,
      arguments: { key, harness: 'Claude Code', model: 'claude-opus-5' },
    })) as CallToolResult;
    expect(started.isError, textOf(started)).toBeFalsy();
    const runId = (started.structuredContent as { runId: string }).runId;

    const result = await record(client, key);

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(Object.keys(result.structuredContent!).sort()).toEqual(['recordId', 'recorded']);
    expect(result.structuredContent).toMatchObject({ recorded: true });
    const events = await discrepancyEvents(runId);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toStrictEqual({
      recordId: (result.structuredContent as { recordId: string }).recordId,
      pointCount: 3,
      dispatchRunCardId: await legId(runId, key),
    });
    // Decision page §8.2: the record follows the run's own reporter.
    expect(events[0]!.reportedBy).toBe('agent');
    expect(await recordsOn(key)).toHaveLength(1);
    expect(await commentsOn(key)).toHaveLength(0);
    await client.close();
  });

  it("3 · a parent run's child legs: each call lands on its own child, never the parent", async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const parent = (
      await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'The story' },
        fx.ctx,
      )
    ).identifier;
    const a = await task(fx, 'Child A');
    const b = await task(fx, 'Child B');
    const parentRow = await adminDb.workItem.findFirstOrThrow({ where: { identifier: parent } });
    await adminDb.workItem.updateMany({
      where: { projectId: fx.projectId, identifier: { in: [a, b] } },
      data: { parentId: parentRow.id },
    });
    const runId = await openCliLegs(fx, [parent, a, b], parent);
    const client = await connectWithGrant(fx);

    expect((await record(client, a)).isError).toBeFalsy();
    expect((await record(client, b)).isError).toBeFalsy();

    const events = await discrepancyEvents(runId);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.dispatchRunCardId).sort()).toEqual(
      [await legId(runId, a), await legId(runId, b)].sort(),
    );
    const parentLeg = await legId(runId, parent);
    expect(events.some((e) => e.dispatchRunCardId === parentLeg)).toBe(false);
    expect(await recordsOn(a)).toHaveLength(1);
    expect(await recordsOn(b)).toHaveLength(1);
    expect(await recordsOn(parent)).toHaveLength(0);
    await client.close();
  });
});

describe('one record per leg (cases 4–5)', () => {
  it('4 · a second call is DISCREPANCY_ALREADY_RECORDED and writes nothing', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const key = await task(fx, 'Once only');
    const runId = await openCliLegs(fx, [key]);
    const client = await connectWithGrant(fx);

    await record(client, key);
    const again = await record(client, key);

    expect(again.isError).toBe(true);
    expect(textOf(again)).toMatch(/^DISCREPANCY_ALREADY_RECORDED: /);
    expect(await recordsOn(key)).toHaveLength(1);
    expect(await discrepancyEvents(runId)).toHaveLength(1);
    await client.close();
  });

  it('5 · two clients racing the same leg: exactly one wins', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const key = await task(fx, 'Raced');
    const runId = await openCliLegs(fx, [key]);
    const [one, two] = await Promise.all([connectWithGrant(fx), connectWithGrant(fx)]);

    const settled = await Promise.allSettled([record(one, key), record(two, key)]);

    const results = settled.map((s) => {
      expect(s.status).toBe('fulfilled');
      return (s as PromiseFulfilledResult<CallToolResult>).value;
    });
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    const refused = results.filter((r) => r.isError);
    expect(refused).toHaveLength(1);
    expect(textOf(refused[0]!)).toMatch(/^DISCREPANCY_ALREADY_RECORDED: /);
    expect(await recordsOn(key)).toHaveLength(1);
    expect(await discrepancyEvents(runId)).toHaveLength(1);
    await Promise.all([one.close(), two.close()]);
  });
});

describe('a card with no open leg (case 6)', () => {
  it('6 · answers recorded: false, writes the record and no comment, and no event anywhere', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const key = await task(fx, 'Never run');
    const client = await connectWithGrant(fx);

    const result = await record(client, key);

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ recorded: false });
    expect(await recordsOn(key)).toHaveLength(1);
    expect(await commentsOn(key)).toHaveLength(0);
    expect(await adminDb.dispatchRunEvent.count({ where: { kind: 'discrepancy_recorded' } })).toBe(
      0,
    );
    await client.close();
  });
});

describe('the composed read (case 7)', () => {
  it('7 · the run detail carries the pointer-only event and the leg key, and no point text', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const key = await task(fx, 'Read back');
    const runId = await openCliLegs(fx, [key]);
    const client = await connectWithGrant(fx);
    await record(client, key);

    const detail = await dispatchRunService.getRunDetail(runId, fx.ctx);
    const leg = await legId(runId, key);

    const events = await dispatchRunService.readStreamPage(runId, 0, 100, fx.ctx);
    const found = events.events.filter((e) => e.kind === 'discrepancy_recorded');
    expect(found).toHaveLength(1);
    expect(found[0]!.cardId).toBe(leg);
    expect(Object.keys(found[0]!.data as object).sort()).toEqual([
      'dispatchRunCardId',
      'pointCount',
      'recordId',
    ]);
    expect(detail.cards.find((c) => c.id === leg)?.key).toBe(key);

    const serialized = JSON.stringify({ detail, events });
    for (const text of POINT_TEXTS) expect(serialized).not.toContain(text);
    await client.close();
  });
});

describe('STOP and build-through on one leg (case 8)', () => {
  it('8 · a discrepancy then a STOP report leaves both; so does the reverse order', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const forward = await task(fx, 'Built through, then stopped');
    const reverse = await task(fx, 'Stopped, then recorded');
    const runId = await openCliLegs(fx, [forward, reverse]);
    const client = await connectWithGrant(fx);

    expect((await record(client, forward)).isError).toBeFalsy();
    expect((await unbuildable(client, 'CUST', forward)).isError).toBeFalsy();
    expect((await unbuildable(client, 'CUST', reverse)).isError).toBeFalsy();
    expect((await record(client, reverse)).isError).toBeFalsy();

    for (const key of [forward, reverse]) {
      const kinds = (
        await adminDb.dispatchRunEvent.findMany({
          where: { dispatchRunId: runId, dispatchRunCardId: await legId(runId, key) },
        })
      ).map((e) => e.kind);
      expect(kinds).toContain('discrepancy_recorded');
      expect(kinds).toContain('unbuildable_reported');
    }
    await client.close();
  });
});

describe('a build-through files no planning bug; STOP still does, on unchanged only (case 9)', () => {
  async function makeMeta(): Promise<WorkItemFixture> {
    const meta = await makeWorkItemFixture({ name: 'moooon', identifier: 'MOTIR' });
    const planning = await foldersService.createFolder(
      { projectId: meta.projectId, parentFolderId: null, name: 'Planning bugs' },
      meta.ctx,
    );
    await adminDb.project.update({
      where: { id: meta.projectId },
      data: { plannerBugDestinationFolderId: planning.id },
    });
    await seedSystemPrincipal({ workspaceId: meta.workspaceId, projectId: meta.projectId });
    return meta;
  }

  async function nativeUnchanged(fx: WorkItemFixture, title: string): Promise<string> {
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
      [{ op: 'add', proposedFields: { title, kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);
    const row = await adminDb.planItem.findFirstOrThrow({ where: { planId: plan.id, op: 'add' } });
    const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: row.workItemId! } });
    return item.identifier;
  }

  it('9 · the folder gains nothing on a build-through, one on STOP/unchanged, none on no_plan', async () => {
    const meta = await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const builtThrough = await nativeUnchanged(fx, 'Built through');
    const stopped = await nativeUnchanged(fx, 'Stopped');
    const unplanned = await task(fx, 'Never planned');
    await openCliLegs(fx, [builtThrough, stopped, unplanned]);
    const client = await connectWithGrant(fx);
    const planningBugs = () =>
      adminDb.workItem.count({ where: { projectId: meta.projectId, kind: 'bug' } });

    expect((await record(client, builtThrough)).isError).toBeFalsy();
    expect(await planningBugs()).toBe(0);

    expect((await unbuildable(client, 'CUST', stopped)).isError).toBeFalsy();
    expect(await planningBugs()).toBe(1);

    expect((await unbuildable(client, 'CUST', unplanned)).isError).toBeFalsy();
    expect(await planningBugs()).toBe(1);
    await client.close();
  });
});

describe('refusals and tenancy (cases 10–11)', () => {
  it('10 · bad input, an unknown key, another workspace’s key and a missing grant write nothing', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const key = await task(fx, 'Refused');
    const foreign = await task(other, 'Not yours');
    const client = await connectWithGrant(fx);

    const longField = 'x'.repeat(2001);
    const tooMany = Array.from({ length: 21 }, () => POINTS[0]!);
    for (const points of [
      [],
      tooMany,
      [{ ...POINTS[0]!, why: '   ' }],
      [{ ...POINTS[0]!, built: longField }],
    ]) {
      const result = await record(client, key, points);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^RUN_DISCREPANCY_INVALID: /);
    }

    const unknown = await record(client, 'CUST-9999');
    const crossTenant = await record(client, foreign);
    expect(textOf(unknown)).toMatch(/^WORK_ITEM_NOT_FOUND: /);
    expect(textOf(crossTenant)).toMatch(/^WORK_ITEM_NOT_FOUND: /);

    const noEdit = await connectWithGrant(
      fx,
      CLI_TOKEN_GRANT.filter((p) => p !== 'work_item:edit'),
    );
    const denied = await record(noEdit, key);
    expect(denied.isError).toBe(true);

    expect(await adminDb.runDiscrepancyRecord.count()).toBe(0);
    expect(await adminDb.dispatchRunEvent.count({ where: { kind: 'discrepancy_recorded' } })).toBe(
      0,
    );
    await Promise.all([client.close(), noEdit.close()]);
  });

  it("11 · the record lands in the card's own workspace and nowhere else", async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const key = await task(fx, 'Mine');
    await openCliLegs(fx, [key]);
    const client = await connectWithGrant(fx);

    expect((await record(client, key)).isError).toBeFalsy();

    expect(
      await adminDb.runDiscrepancyRecord.count({ where: { workspaceId: fx.workspaceId } }),
    ).toBe(1);
    expect(
      await adminDb.runDiscrepancyRecord.count({ where: { workspaceId: other.workspaceId } }),
    ).toBe(0);
    expect(
      await adminDb.dispatchRunEvent.count({
        where: { kind: 'discrepancy_recorded', workspaceId: other.workspaceId },
      }),
    ).toBe(0);
    await client.close();
  });
});

describe('the grant (case 12)', () => {
  it('12 · CLI_TOKEN_GRANT is its four-plus members as before — this story widened nothing', () => {
    expect(CLI_TOKEN_GRANT).toEqual(
      expect.arrayContaining(['work_item:edit', 'comment:add', 'project:browse', 'run:view_any']),
    );
    expect(CLI_TOKEN_GRANT).not.toContain('work_item:delete');
  });
});

describe('the dispatch prompt’s two branches, story-wide (case 13)', () => {
  const base: DispatchPromptSource = {
    key: 'PROD-7',
    title: 'Add the ready-set filter bar',
    kind: 'subtask',
    type: 'code',
    executor: 'coding_agent',
    difficulty: null,
    priority: 'high',
    storyPoints: 5,
    estimateMinutes: 90,
    descriptionMd: 'Build the bar.\n\n## Acceptance criteria\n\n- It filters.',
    blockerKeys: [],
    openDependentKeys: [],
    errorEvidence: [],
    parent: { key: 'PROD-2', title: 'Ready surface' },
    projectName: 'Motir',
    projectKey: 'PROD',
    targetRepo: 'motir-core',
    sessionBranch: null,
  };
  const LANES: [string, Partial<DispatchPromptSource>][] = [
    ['code', {}],
    ['code with a session branch', { sessionBranch: 'motir/auto-1' }],
    ['decision page', { type: 'decision' }],
  ];
  const POLICIES = [true, false];

  for (const [lane, over] of LANES) {
    for (const replan of POLICIES) {
      it(`${lane}, re-plan ${replan}: the test, BUILD THROUGH, STOP, FOUND A DEFECT, in order`, () => {
        const { prompt } = assembleDispatchPrompt({
          ...base,
          ...over,
          findingsPolicy: { logBug: true, replan, autoApproveReplan: false },
        } as DispatchPromptSource);
        const flat = prompt.replace(/\s+/g, ' ');
        const at = [
          flat.indexOf('reachable by this run alone?'),
          flat.indexOf('BUILD THROUGH — the WHAT holds'),
          flat.indexOf('STOP — the WHAT itself breaks'),
          flat.indexOf('FOUND A DEFECT — your card is fine'),
        ];
        expect(
          at.every((n) => n > -1),
          JSON.stringify(at),
        ).toBe(true);
        expect([...at].sort((a, b) => a - b)).toEqual(at);

        const buildThrough = flat.slice(at[1]!, at[2]!);
        expect(buildThrough).toContain(RECORD_RUN_DISCREPANCY_TOOL_NAME);
        expect(flat.slice(at[2]!, at[3]!)).toContain(REPORT_UNBUILDABLE_TARGET_TOOL_NAME);
        for (const forbidden of ['submit_plan_session', 'append_plan_turn']) {
          expect(buildThrough).not.toContain(forbidden);
        }
      });
    }
  }
});

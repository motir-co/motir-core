import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
import { TOOL_ANNOTATIONS } from '@/lib/mcp/toolAnnotations';
import { EXEMPT_TOOLS } from '@/lib/mcp/payloads/exemptions';
import { MCP_UNREACHABLE_RESOURCES } from '@/lib/mcp/payloads/sharedResources';
import {
  GET_RUN_RECORD_TOOL_NAME,
  SEARCH_RUN_RECORDS_TOOL_NAME,
  renderRunRecord,
} from '@/lib/mcp/tools/runRecords';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { runDiscrepancyService } from '@/lib/services/runDiscrepancyService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `search_run_records` / `get_run_record` (MOTIR-10240) over real Postgres,
// driven through `buildMcpServer` + an in-memory client: registered and
// declared, the project key resolved inside the token's workspace, every
// absence a NON-error outcome, and the agent-written text quoted verbatim.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function call(
  ctx: ServiceContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'run-records-test', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

const textOf = (r: CallToolResult) => (r.content[0] as { text: string }).text;
const structured = (r: CallToolResult) => {
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  return r.structuredContent as Record<string, unknown>;
};

async function card(title: string) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return item.identifier;
}

async function openRun(keys: string[]): Promise<string> {
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
  return run.id;
}

describe('the run-record tools — registered and declared', () => {
  it('tools/list names both, titled and read-only; every declaration home carries them', async () => {
    const server = buildMcpServer(() => fx.ctx);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(c);
    const { tools } = await client.listTools();
    await client.close();
    for (const [name, title] of [
      [SEARCH_RUN_RECORDS_TOOL_NAME, 'Search run records'],
      [GET_RUN_RECORD_TOOL_NAME, 'Get run record'],
    ] as const) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeTruthy();
      expect(tool!.title).toBe(title);
      expect(tool!.annotations?.readOnlyHint).toBe(true);
      expect(tool!.annotations?.openWorldHint).toBe(false);
      expect(MCP_TOOL_NAMES).toContain(name);
      expect(TOOL_PERMISSIONS[name]).toBe('project:browse');
      expect(TOOL_SCOPES[name]).toBe('read');
      expect(TOOL_ANNOTATIONS[name]).toEqual({ readOnlyHint: true, openWorldHint: false });
      expect(EXEMPT_TOOLS).toHaveProperty(name);
    }
  });

  it('the DispatchRun reason no longer says no MCP tool reads a run', () => {
    const reason = MCP_UNREACHABLE_RESOURCES.DispatchRun!;
    expect(reason).not.toMatch(/No MCP tool READS a dispatch run/);
    expect(reason).toContain('search_run_records');
    expect(reason).toContain('get_run_record');
  });
});

describe('search_run_records', () => {
  it('lists the project’s runs and pages; nothing matched is a non-error outcome', async () => {
    const empty = await call(fx.ctx, SEARCH_RUN_RECORDS_TOOL_NAME, { projectKey: 'prod' });
    expect(structured(empty)).toEqual({ outcome: 'nothing_matched', runs: [], nextCursor: null });
    expect(textOf(empty)).toBe(`No run of ${fx.projectIdentifier} matched.`);

    const a = await card('A');
    const older = await openRun([a]);
    const newer = await openRun([a]);
    const res = await call(fx.ctx, SEARCH_RUN_RECORDS_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
      workItemKey: a,
      limit: 1,
    });
    const out = structured(res);
    expect(out['outcome']).toBe('found');
    expect((out['runs'] as { id: string }[]).map((r) => r.id)).toEqual([newer]);
    expect(out['nextCursor']).toBe(newer);
    expect(textOf(res)).toContain(`1 run of ${fx.projectIdentifier}, newest first:`);
    expect(textOf(res)).toContain('1 card (1 running)');
    expect(textOf(res)).toContain(`cursor "${newer}"`);

    const next = await call(fx.ctx, SEARCH_RUN_RECORDS_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
      workItemKey: a,
      limit: 1,
      cursor: newer,
    });
    expect((structured(next)['runs'] as { id: string }[]).map((r) => r.id)).toEqual([older]);

    const filteredOut = await call(fx.ctx, SEARCH_RUN_RECORDS_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
      workItemKey: a,
      statuses: ['failed'],
      limit: 1,
    });
    expect(structured(filteredOut)).toMatchObject({
      outcome: 'nothing_matched',
      nextCursor: newer,
    });
    expect(textOf(filteredOut)).toContain('More runs');
  });

  it('a closed run renders its stop reason and end; two filters at once are refused', async () => {
    const a = await card('A');
    const runId = await openRun([a]);
    await dispatchRunService.close(runId, { stopReason: 'drained' }, fx.ctx);
    const res = await call(fx.ctx, SEARCH_RUN_RECORDS_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
    });
    expect(textOf(res)).toContain('succeeded / drained');
    expect(textOf(res)).toContain('ended ');
    expect(textOf(res)).toContain('No more runs.');

    const both = await call(fx.ctx, SEARCH_RUN_RECORDS_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
      workItemKey: a,
      scopeWorkItemKey: a,
    });
    expect(both.isError).toBe(true);
    expect(textOf(both)).toContain('RUN_RECORD_QUERY_INVALID');
  });

  it('a key from another workspace is the same PROJECT_NOT_FOUND as search_pages', async () => {
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    for (const [name, extra] of [
      [SEARCH_RUN_RECORDS_TOOL_NAME, {}],
      [GET_RUN_RECORD_TOOL_NAME, { runId: 'x' }],
    ] as const) {
      const res = await call(fx.ctx, name, { projectKey: rival.projectIdentifier, ...extra });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('PROJECT_NOT_FOUND');
    }
    const pages = await call(fx.ctx, 'search_pages', {
      projectKey: rival.projectIdentifier,
      q: 'x',
    });
    expect(textOf(pages)).toContain('PROJECT_NOT_FOUND');
  });
});

describe('get_run_record', () => {
  it('reads how a run ended and the discrepancy body, quoted verbatim', async () => {
    const a = await card('A');
    const b = await card('B');
    const runId = await openRun([a, b]);
    await runDiscrepancyService.recordDiscrepancy(
      {
        key: a,
        points: [{ planAsked: 'SENT-ASKED', built: 'SENT-BUILT', why: 'SENT-WHY' }],
      },
      fx.ctx,
    );
    const res = await call(fx.ctx, GET_RUN_RECORD_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
      runId,
    });
    const out = structured(res);
    expect(out['outcome']).toBe('found');
    const run = out['run'] as { legs: { key: string; discrepancy: unknown }[] };
    expect(run.legs[0]).toMatchObject({ key: a, discrepancy: { pointCount: 1, decisionCount: 0 } });
    expect(run.legs[1]).toMatchObject({ key: b, discrepancy: null });
    const text = textOf(res);
    expect(text).toContain(`Run ${runId} in ${fx.projectIdentifier}: run (local), running`);
    expect(text).toContain('not ended');
    expect(text).toContain('recorded 1 difference (0 decisions)');
    expect(text).toContain('Record (recorded by the run, verbatim):');
    expect(text).toContain('SENT-BUILT');
    expect(text).toContain(`${b} · running · exit none · no discrepancy record`);
  });

  it('an unknown run is a non-error not_found', async () => {
    const res = await call(fx.ctx, GET_RUN_RECORD_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
      runId: 'run_unknown',
    });
    expect(structured(res)).toEqual({ outcome: 'not_found' });
    expect(textOf(res)).toContain('No run "run_unknown"');
  });

  it('renders a hosted end, a cut text, a skipped leg and a vanished comment', () => {
    const text = renderRunRecord('ACME', {
      id: 'r1',
      command: 'run',
      origin: 'hosted',
      status: 'failed',
      stopReason: 'halted',
      startedAt: 's',
      endedAt: 'e',
      hostedEnd: { outcome: null, detail: 'stalled', detailTruncated: true, exitCode: null },
      legs: [
        {
          key: null,
          disposition: 'skipped',
          skipReason: 'needs_human',
          exitCode: 3,
          discrepancy: {
            commentId: 'c',
            pointCount: 2,
            decisionCount: 1,
            bodyMd: null,
            bodyTruncated: false,
          },
        },
        {
          key: 'ACME-2',
          disposition: 'failed',
          skipReason: null,
          exitCode: 1,
          discrepancy: {
            commentId: 'd',
            pointCount: 1,
            decisionCount: 1,
            bodyMd: 'body',
            bodyTruncated: true,
          },
        },
      ],
    });
    expect(text).toContain('failed / halted, started s, ended e.');
    expect(text).toContain('End: outcome not recorded, exit code none.');
    expect(text).toContain('End line (recorded by the run, verbatim, cut):\nstalled');
    expect(text).toContain(
      '(deleted card) · skipped (needs_human) · exit 3 · recorded 2 differences (1 decision)',
    );
    expect(text).toContain('The record’s comment no longer exists.');
    expect(text).toContain('Record (recorded by the run, verbatim, cut):\nbody');
    const noDetail = renderRunRecord('ACME', {
      id: 'r2',
      command: 'run',
      origin: 'hosted',
      status: 'succeeded',
      stopReason: null,
      startedAt: 's',
      endedAt: null,
      hostedEnd: { outcome: 'exited', detail: null, detailTruncated: false, exitCode: 0 },
      legs: [],
    });
    expect(noDetail).toContain('End: outcome exited, exit code 0.');
    expect(noDetail).not.toContain('End line');
  });
});

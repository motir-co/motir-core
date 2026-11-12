import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, test } from '@playwright/test';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import {
  MCP_TOOL_ATTR,
  MCP_TOOL_SPAN,
  MCP_TOOL_TAG,
  mcpToolRootName,
  mcpToolSpanName,
} from '@/lib/mcp/toolTracing';
import { ADD_PLAN_ITEMS_TOOL_NAME, CREATE_PLAN_TOOL_NAME } from '@/lib/mcp/tools/authorPlan';
import { MOVE_TO_PARENT_TOOL_NAME } from '@/lib/mcp/tools/moveToParent';
import { REQUEST_DB_TIMING_METRICS } from '@/lib/monitoring/requestDbTiming';
import { TRANSACTION_ATTR, TRANSACTION_SPAN } from '@/lib/monitoring/transactionSpan';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { resetDatabase } from './_helpers/db-reset';
import {
  OBSERVABILITY_CAPTURE_FILE,
  OBSERVABILITY_FARGATE_ENV,
  OBSERVABILITY_TASK_ID,
  OBSERVABILITY_METRICS_PORT,
} from './_helpers/observability-const';
import { readCaptured, readCapturedText } from './_helpers/sentry-capture';
import { signIn } from './_helpers/shell-session';

// A SLOW REQUEST NAMES ITS SLOW QUERY — PROVEN ON THE SHIPPED ARTIFACT
// (Story MOTIR-8537 · Subtask MOTIR-8557).
//
// One `next start` production server (playwright.observability.config.ts) runs
// the REAL Sentry SDK at trace rate 1 with its DSN pointed at a local ingest,
// the instance env Fly injects, and the private metrics port. This spec drives
// the hot routes and two MCP tools, then reads back what the server emitted:
//   - the CAPTURED ENVELOPES — the bytes the SDK would have sent to sentry.io;
//   - `/metrics` — the every-request recorder, sampled or not.
//
// What only the built server can show, and each case below can fail on: Next's
// route instrumentation naming a route by its pattern; the transaction spans
// nesting under the route's and the tool's spans across the real request async
// context; the request label and the metrics registry surviving the bundle's
// separate module instances (MOTIR-7007); statement spans attaching to the
// bundled `pg`; and nothing bound leaking through the real transport.
//
// ⚠️ THE WAITS. The SDK sends an envelope after its request ends, asynchronously,
// so every read of the capture is an `expect.poll` with a bound. Every write
// waits on its own answer (the MCP result, the HTTP status). The SSE stream's
// transaction ends only when the response ends, so case 2 navigates away first.

const METRICS_URL = `http://127.0.0.1:${OBSERVABILITY_METRICS_PORT}/metrics`;
const PASSWORD = 'observability-e2e-pass-123';
const CAPTURE_TIMEOUT = 30_000;
const M = REQUEST_DB_TIMING_METRICS;

// ── The capture ─────────────────────────────────────────────────────────────

interface Span {
  span_id: string;
  parent_span_id?: string;
  description?: string;
  op?: string;
  start_timestamp: number;
  timestamp: number;
  data?: Record<string, unknown>;
}
interface TransactionEvent {
  transaction?: string;
  tags?: Record<string, string>;
  contexts?: { trace?: { trace_id?: string; span_id?: string; data?: Record<string, unknown> } };
  spans?: Span[];
}

function transactions(): TransactionEvent[] {
  return readCaptured(OBSERVABILITY_CAPTURE_FILE)
    .filter((item) => item.type === 'transaction')
    .map((item) => item.payload as TransactionEvent);
}

/** Poll the capture until a transaction matching `match` arrives. */
async function awaitTransaction(
  what: string,
  match: (event: TransactionEvent) => boolean,
): Promise<TransactionEvent> {
  let found: TransactionEvent | undefined;
  await expect
    .poll(
      () => {
        found = transactions().find(match);
        return found
          ? 'captured'
          : `none yet among: ${transactions()
              .map((e) => e.transaction)
              .join(' | ')}`;
      },
      { message: `a captured transaction for ${what}`, timeout: CAPTURE_TIMEOUT },
    )
    .toBe('captured');
  return found!;
}

function descendants(spans: Span[], id: string): Span[] {
  return spans
    .filter((s) => s.parent_span_id === id)
    .flatMap((s) => [s, ...descendants(spans, s.span_id)]);
}

/**
 * The `db.transaction` shape under `rootId` (the event's own root, or a tool
 * span): at least one transaction span, each with exactly one wait and one hold,
 * hold starting no earlier than wait ends. Returns the statement spans found
 * under every hold.
 */
function assertTransactionSpans(event: TransactionEvent, rootId: string, what: string): Span[] {
  const spans = event.spans ?? [];
  const txSpans = descendants(spans, rootId).filter(
    (s) => s.description === TRANSACTION_SPAN.transaction,
  );
  expect(txSpans.length, `${what}: db.transaction spans`).toBeGreaterThanOrEqual(1);
  const statements: Span[] = [];
  for (const tx of txSpans) {
    const children = spans.filter((s) => s.parent_span_id === tx.span_id);
    const wait = children.filter((s) => s.description === TRANSACTION_SPAN.wait);
    const hold = children.filter((s) => s.description === TRANSACTION_SPAN.hold);
    expect(wait, `${what}: one wait per db.transaction`).toHaveLength(1);
    expect(hold, `${what}: one hold per db.transaction`).toHaveLength(1);
    expect(hold[0]!.start_timestamp, `${what}: hold starts after wait ends`).toBeGreaterThanOrEqual(
      wait[0]!.timestamp,
    );
    expect(typeof tx.data?.[TRANSACTION_ATTR.context]).toBe('string');
    statements.push(
      ...descendants(spans, hold[0]!.span_id).filter((s) => s.op === TRANSACTION_SPAN.statementOp),
    );
  }
  return statements;
}

/** At least one placeholder-form statement span (`$1`). */
function assertPlaceholderStatements(statements: Span[], what: string): void {
  expect(statements.length, `${what}: statement spans under hold`).toBeGreaterThanOrEqual(1);
  expect(
    statements.some((s) => (s.description ?? '').includes('$1')),
    `${what}: a statement span with $1 — saw ${statements.map((s) => s.description).join(' | ')}`,
  ).toBe(true);
}

function assertInstanceTags(event: TransactionEvent): void {
  expect(event.tags?.['instance.machine']).toBe(OBSERVABILITY_TASK_ID);
  expect(event.tags?.['instance.process_group']).toBe(
    OBSERVABILITY_FARGATE_ENV.MONITORING_CLOUDWATCH_SERVICE,
  );
  expect(event.tags?.['instance.region']).toBe(OBSERVABILITY_FARGATE_ENV.AWS_REGION);
}

// ── /metrics ────────────────────────────────────────────────────────────────

/** `db_tx_hold_seconds_count` summed over every series carrying `labels`. */
async function holdCount(labels: Record<string, string>): Promise<number> {
  const res = await fetch(METRICS_URL);
  expect(res.status).toBe(200);
  const text = await res.text();
  let total = 0;
  for (const line of text.split('\n')) {
    const m = new RegExp(`^${M.hold}_count\\{([^}]*)\\} (\\S+)$`).exec(line);
    if (!m) continue;
    const series = Object.fromEntries(
      [...m[1]!.matchAll(/(\w+)="([^"]*)"/g)].map((p) => [p[1], p[2]]),
    );
    if (Object.entries(labels).every(([k, v]) => series[k] === v)) total += Number(m[2]);
  }
  return total;
}

async function expectHoldGrowth(labels: Record<string, string>, before: number): Promise<void> {
  await expect
    .poll(() => holdCount(labels), { message: `hold count ${JSON.stringify(labels)}` })
    .toBeGreaterThan(before);
}

// ── The tenant ──────────────────────────────────────────────────────────────

interface Seed {
  email: string;
  projectKey: string;
  storyKey: string;
  newParentKey: string;
  token: string;
}

async function seed(sentinel: string): Promise<Seed> {
  const email = `owner-${sentinel}@example.com`;
  const owner = await usersService.createUser({ email, password: PASSWORD, name: 'Obs Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Observability',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Observability',
    identifier: 'OBS',
  });
  await projectsService.setActiveProject({
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  const ctx = { userId: owner.id, workspaceId: workspace.id };
  const make = (kind: 'epic' | 'story', title: string, parentId: string | null) =>
    workItemsService.createWorkItem({ projectId: project.id, kind, title, parentId }, ctx);
  const epicA = await make('epic', 'Epic A', null);
  const epicB = await make('epic', 'Epic B', null);
  const story = await make('story', `Moved ${sentinel}`, epicA.id);
  const minted = await apiTokensService.create(owner.id, workspace.id, {
    label: 'observability-e2e',
    projectId: project.id,
    permissions: [...CLI_TOKEN_GRANT, 'ai:view_plan'],
  });
  return {
    email,
    projectKey: project.identifier,
    storyKey: story.identifier,
    newParentKey: epicB.identifier,
    token: minted.token,
  };
}

async function mcpCall(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  expect(result.isError ?? false, JSON.stringify(result.content).slice(0, 400)).toBe(false);
  return result;
}

/** A W3C-sized trace id and span id, as an upstream `sentry-trace` carries. */
const traceId = () => randomBytes(16).toString('hex');
const spanId = () => randomBytes(8).toString('hex');

// ── The journey ─────────────────────────────────────────────────────────────

/** The plan `create_plan` opened in case 5, read by cases 3, 7 and 8. */
let planId = '';
/** The stream request's trace, whose post-response polls case 6 checks. */
let streamTraceId = '';

test('the hot routes and the MCP tools are traced by name, split into wait and hold, and every request is recorded', async ({
  page,
  baseURL,
}) => {
  await resetDatabase();
  const SENTINEL = `obs8557-${randomUUID()}`;
  const s = await seed(SENTINEL);
  const seen: TransactionEvent[] = [];

  await test.step('1. /workbench renders under a /workbench transaction', async () => {
    const before = await holdCount({ route: 'workbench' });
    await signIn(page, s.email, PASSWORD);
    const event = await awaitTransaction(
      '/workbench',
      (e) => /\/workbench$/.test(e.transaction ?? '') && (e.spans ?? []).length > 0,
    );
    expect(event.transaction).not.toMatch(/stream/);
    const statements = assertTransactionSpans(event, event.contexts!.trace!.span_id!, '/workbench');
    assertPlaceholderStatements(statements, '/workbench');
    seen.push(event);
    await expectHoldGrowth({ route: 'workbench' }, before);
  });

  await test.step('2. /api/workbench/stream, once the stream has ended', async () => {
    const before = await holdCount({ route: 'workbench_stream' });
    // The page opened the stream in case 1; leaving it ends the response, and
    // with it the transaction, which covers the stream's whole life.
    await page.goto('about:blank');
    const event = await awaitTransaction('/api/workbench/stream', (e) =>
      (e.transaction ?? '').endsWith('/api/workbench/stream'),
    );
    assertTransactionSpans(event, event.contexts!.trace!.span_id!, '/api/workbench/stream');
    seen.push(event);
    streamTraceId = event.contexts!.trace!.trace_id!;
    await expectHoldGrowth({ route: 'workbench_stream' }, before);
    // A poll that runs after this transaction was sent is NOT sent as one of
    // its own; case 6 asserts that over the whole capture (MOTIR-8567).
  });

  if (!baseURL) throw new Error('no Playwright baseURL');
  const client = new Client({ name: 'observability-e2e', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/api/mcp', baseURL), {
      requestInit: { headers: { Authorization: `Bearer ${s.token}` } },
    }),
  );

  for (const [n, tool, run] of [
    [
      '4',
      MOVE_TO_PARENT_TOOL_NAME,
      () =>
        mcpCall(client, MOVE_TO_PARENT_TOOL_NAME, { key: s.storyKey, parentKey: s.newParentKey }),
    ],
    [
      '5',
      ADD_PLAN_ITEMS_TOOL_NAME,
      async () => {
        const created = await mcpCall(client, CREATE_PLAN_TOOL_NAME, {
          projectKey: s.projectKey,
          title: `Plan ${SENTINEL}`,
        });
        planId = (created.structuredContent as { id: string }).id;
        return mcpCall(client, ADD_PLAN_ITEMS_TOOL_NAME, {
          planId,
          proposals: [
            { op: 'add', proposedFields: { title: `Proposal ${SENTINEL}`, kind: 'epic' } },
          ],
        });
      },
    ],
  ] as const) {
    await test.step(`${n}. MCP ${tool} is one named trace with the tool span over its transactions`, async () => {
      const labels = { route: 'mcp', tool };
      const before = await holdCount(labels);
      await run();
      const event = await awaitTransaction(
        mcpToolRootName(tool),
        (e) => e.transaction === mcpToolRootName(tool),
      );
      expect(event.tags?.[MCP_TOOL_TAG]).toBe(tool);
      const toolSpan = (event.spans ?? []).find((sp) => sp.description === mcpToolSpanName(tool));
      expect(toolSpan, `the ${mcpToolSpanName(tool)} span`).toBeDefined();
      expect(toolSpan!.op).toBe(MCP_TOOL_SPAN.op);
      expect(toolSpan!.data?.[MCP_TOOL_ATTR.outcome]).toBe('ok');
      assertTransactionSpans(event, toolSpan!.span_id, tool);
      seen.push(event);
      await expectHoldGrowth(labels, before);
    });
  }
  await client.close();

  await test.step('3. GET /api/plans/[id] is named by its pattern, never the id', async () => {
    const before = await holdCount({ route: 'plan_get' });
    const res = await page.request.get(`/api/plans/${planId}`);
    expect(res.status()).toBe(200);
    const event = await awaitTransaction('GET /api/plans/[id]', (e) =>
      (e.transaction ?? '').endsWith('/api/plans/[id]'),
    );
    expect(event.transaction).not.toContain(planId);
    const statements = assertTransactionSpans(
      event,
      event.contexts!.trace!.span_id!,
      '/api/plans/[id]',
    );
    assertPlaceholderStatements(statements, '/api/plans/[id]');
    seen.push(event);
    await expectHoldGrowth({ route: 'plan_get' }, before);
  });

  await test.step('6. every captured transaction names its instance', async () => {
    expect(seen).toHaveLength(5);
    for (const event of seen) assertInstanceTags(event);
    // …and nothing was sent for a span that outlived its request: the stream's
    // trace holds its one transaction, and no transaction anywhere is a span the
    // exporter sent after its parent (MOTIR-8567).
    const all = transactions();
    expect(all.filter((e) => e.contexts?.trace?.trace_id === streamTraceId)).toHaveLength(1);
    expect(
      all.filter((e) => e.contexts?.trace?.data?.['sentry.parent_span_already_sent'] === true),
    ).toEqual([]);
  });

  await test.step('7. no bound value reaches an envelope', async () => {
    // Positive control: the sentinel IS in what the server returned for the plan,
    // so it was bound into the reads the traces describe.
    const plan = await page.request.get(`/api/plans/${planId}`);
    expect(await plan.text()).toContain(SENTINEL);
    const raw = readCapturedText(OBSERVABILITY_CAPTURE_FILE);
    expect(raw.length).toBeGreaterThan(0);
    expect(raw).not.toContain(SENTINEL);
    expect(raw).not.toContain(s.email);
  });

  await test.step('8. an upstream "do not sample" request is still recorded, and sends nothing', async () => {
    const before = await holdCount({ route: 'plan_get' });
    const unsampled = traceId();
    const res = await page.request.get(`/api/plans/${planId}`, {
      headers: { 'sentry-trace': `${unsampled}-${spanId()}-0` },
    });
    expect(res.status()).toBe(200);
    await expectHoldGrowth({ route: 'plan_get' }, before);

    // A SAMPLED request after it is the barrier: once its transaction has
    // arrived, an envelope for the unsampled one would have arrived too.
    const sampled = traceId();
    const barrier = await page.request.get(`/api/plans/${planId}`, {
      headers: { 'sentry-trace': `${sampled}-${spanId()}-1` },
    });
    expect(barrier.status()).toBe(200);
    await awaitTransaction('the sampled barrier', (e) => e.contexts?.trace?.trace_id === sampled);
    expect(transactions().filter((e) => e.contexts?.trace?.trace_id === unsampled)).toEqual([]);
  });
});

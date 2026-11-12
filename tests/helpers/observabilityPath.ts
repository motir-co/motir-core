import * as Sentry from '@sentry/nextjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, vi } from 'vitest';
import { buildMcpServer } from '@/lib/mcp/registry';
import { MCP_TOOL_ATTR, MCP_TOOL_SPAN, MCP_TOOL_TAG } from '@/lib/mcp/toolTracing';
import { requestDbTimingRegistry } from '@/lib/monitoring/requestDbTiming';
import { serverSentryInitOptions } from '@/lib/monitoring/serverInit';
import { TRANSACTION_ATTR, TRANSACTION_SPAN } from '@/lib/monitoring/transactionSpan';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';

// MOTIR-8556 — the shared pieces of the assembled observability-path tests
// (`tests/integration/monitoring/observabilityPath*.test.ts`). The Sentry SDK is
// REAL; the only test-owned piece is the TRANSPORT, which keeps each envelope in
// memory instead of sending it.
//
// Each test file runs in its own process (vitest forks + isolate), and that is
// load-bearing: a second `Sentry.init` in one process keeps the FIRST init's
// sampler, so a rate can be chosen once per file and never changed.

/** The Fargate task the assembled path says it runs on (MOTIR-10962). */
export const FARGATE_TASK_ID = '85568556855685568556855685568556';
export const FARGATE = {
  AWS_EXECUTION_ENV: 'AWS_ECS_FARGATE',
  AWS_REGION: 'us-east-1',
  ECS_CONTAINER_METADATA_URI_V4: `http://169.254.170.2/v4/${FARGATE_TASK_ID}-1234567890`,
  MONITORING_CLOUDWATCH_SERVICE: 'web',
} as const;
export const DSN = 'https://key@o1.ingest.us.sentry.io/2';

export type CapturedSpan = {
  span_id: string;
  parent_span_id?: string;
  description?: string;
  op?: string;
  start_timestamp: number;
  timestamp: number;
  data?: Record<string, unknown>;
};
export type CapturedTransaction = {
  type?: string;
  transaction?: string;
  tags?: Record<string, string>;
  contexts?: { trace?: { span_id?: string; op?: string; data?: Record<string, unknown> } };
  spans?: CapturedSpan[];
};

/** Every envelope the client tried to send. */
export const envelopes: unknown[] = [];
/** How many transports the SDK built — one per `Sentry.init`. */
export const transportsCreated = { count: 0 };

export function captureTransport() {
  transportsCreated.count += 1;
  return {
    send: async (envelope: unknown) => {
      envelopes.push(envelope);
      return { statusCode: 200 };
    },
    flush: async () => true,
  };
}

/** The transaction events among the captured envelopes. */
export function transactions(): CapturedTransaction[] {
  const out: CapturedTransaction[] = [];
  for (const envelope of envelopes as [unknown, [{ type: string }, unknown][]][]) {
    for (const [header, payload] of envelope[1]) {
      if (header.type === 'transaction') out.push(payload as CapturedTransaction);
    }
  }
  return out;
}

/** JSON of a value, cycles cut. */
export function serialize(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[cycle]';
      seen.add(v);
    }
    return v;
  });
}

type Value = { labels: Record<string, string>; value: number; metricName?: string };

export async function histogramCount(
  name: string,
  labels: Record<string, string>,
): Promise<number> {
  const metric = requestDbTimingRegistry().getSingleMetric(name);
  if (!metric) return 0;
  const values = (await metric.get()).values as Value[];
  return values
    .filter(
      (v) =>
        v.metricName === `${name}_count` &&
        Object.entries(labels).every(([k, want]) => v.labels[k] === want),
    )
    .reduce((sum, v) => sum + v.value, 0);
}

export async function connect(fx: WorkItemFixture): Promise<Client> {
  const server = buildMcpServer(() => fx.ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'observability-path', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** One MCP request: the tool call inside the root span Next would open. */
export async function request(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return Sentry.startSpan(
    { name: 'POST /api/mcp', op: 'http.server', forceTransaction: true },
    async () => (await client.callTool({ name, arguments: args })) as CallToolResult,
  );
}

export interface Seeded {
  fx: WorkItemFixture;
  storyKey: string;
  newParentKey: string;
  planId: string;
}

/** Two epics, a story under the first, and an open plan — all outside any trace. */
export async function seed(storyTitle = 'Movable story'): Promise<Seeded> {
  const fx = await makeWorkItemFixture();
  const make = (kind: 'epic' | 'story', title: string, parentId: string | null) =>
    workItemsService.createWorkItem({ projectId: fx.projectId, kind, title, parentId }, fx.ctx);
  const epicA = await make('epic', 'Epic A', null);
  const epicB = await make('epic', 'Epic B', null);
  const story = await make('story', storyTitle, epicA.id);
  const plan = await plansService.createPlan(fx.projectId, { title: 'Observability plan' }, fx.ctx);
  return { fx, storyKey: story.identifier, newParentKey: epicB.identifier, planId: plan.id };
}

export function stubMonitoringEnv(overrides: Record<string, string>): void {
  for (const name of [
    'SENTRY_DSN',
    'SENTRY_ENVIRONMENT',
    'SENTRY_TRACES_SAMPLE_RATE',
    'MONITORING_METRICS_PORT',
    ...Object.keys(FARGATE),
  ]) {
    vi.stubEnv(name, overrides[name] ?? '');
  }
}

/** Initialise the REAL SDK the way the web server does, at `rate`. */
export async function initSentry(rate: string): Promise<void> {
  await Sentry.flush(2000);
  stubMonitoringEnv({ SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: rate, ...FARGATE });
  const options = serverSentryInitOptions({ traces: true });
  if (!options) throw new Error('serverSentryInitOptions returned null with a DSN set');
  Sentry.init({ ...options, transport: captureTransport });
}

export interface TraceReading {
  event: CapturedTransaction;
  txSpans: CapturedSpan[];
  holds: number;
}

/** Assert case B's shape for one captured request, and return its counts. */
export function assertTraceShape(event: CapturedTransaction, tool: string): TraceReading {
  expect(event.transaction).toBe(`MCP tools/call ${tool}`);
  expect(event.tags?.[MCP_TOOL_TAG]).toBe(tool);
  expect(event.tags?.['instance.machine']).toBe(FARGATE_TASK_ID);
  expect(event.tags?.['instance.process_group']).toBe(FARGATE.MONITORING_CLOUDWATCH_SERVICE);
  expect(event.tags?.['instance.region']).toBe(FARGATE.AWS_REGION);

  const spans = event.spans ?? [];
  const toolSpan = spans.find((s) => s.description === `tools/call ${tool}`);
  expect(toolSpan, 'the tools/call span').toBeDefined();
  expect(toolSpan!.op).toBe(MCP_TOOL_SPAN.op);
  expect(toolSpan!.data?.[MCP_TOOL_ATTR.outcome]).toBe('ok');

  const below = (id: string): CapturedSpan[] =>
    spans.filter((s) => s.parent_span_id === id).flatMap((s) => [s, ...below(s.span_id)]);
  const txSpans = below(toolSpan!.span_id).filter(
    (s) => s.description === TRANSACTION_SPAN.transaction,
  );
  expect(txSpans.length, 'db.transaction spans under the tool span').toBeGreaterThanOrEqual(1);
  // No db.transaction span escaped the tool span.
  expect(spans.filter((s) => s.description === TRANSACTION_SPAN.transaction)).toHaveLength(
    txSpans.length,
  );

  let holds = 0;
  for (const tx of txSpans) {
    const children = spans.filter((s) => s.parent_span_id === tx.span_id);
    const waits = children.filter((s) => s.description === TRANSACTION_SPAN.wait);
    const hold = children.filter((s) => s.description === TRANSACTION_SPAN.hold);
    expect(waits).toHaveLength(1);
    expect(hold).toHaveLength(1);
    expect(waits[0]!.timestamp).toBeLessThanOrEqual(hold[0]!.start_timestamp);

    const data = tx.data ?? {};
    expect(typeof data[TRANSACTION_ATTR.context]).toBe('string');
    expect([1, 2]).toContain(data[TRANSACTION_ATTR.attempt]);
    expect(data[TRANSACTION_ATTR.outcome]).toBe('committed');
    // The real pool is registered, so occupancy is a reading — never the zeros an
    // unread pool would fake. `unmeasured` would be the honest alternative.
    if (data[TRANSACTION_ATTR.poolCount] !== 'unmeasured') {
      expect(data[TRANSACTION_ATTR.poolCount]).toBeGreaterThanOrEqual(1);
      expect(data[TRANSACTION_ATTR.poolMax]).toBeGreaterThanOrEqual(1);
      expect(typeof data[TRANSACTION_ATTR.poolTotal]).toBe('number');
      expect(typeof data[TRANSACTION_ATTR.poolIdle]).toBe('number');
      expect(typeof data[TRANSACTION_ATTR.poolWaiting]).toBe('number');
    }
    if (typeof data[TRANSACTION_ATTR.holdMs] === 'number') holds += 1;

    // Statement spans: Prisma's own, attached in-process (MOTIR-8550 chose the
    // SDK's Prisma integration, which reaches the client through a globalThis
    // hook). The body's statements nest under HOLD, with durations and `$n` text.
    const statements = below(hold[0]!.span_id).filter((s) => s.op === TRANSACTION_SPAN.statementOp);
    expect(statements.length, 'statement spans under hold').toBeGreaterThanOrEqual(1);
    for (const s of statements) {
      expect(s.timestamp).toBeGreaterThanOrEqual(s.start_timestamp);
      expect(s.data?.[TRANSACTION_ATTR.statement]).toBe(s.description);
    }
    expect(statements.some((s) => /\$\d/.test(s.description ?? ''))).toBe(true);
  }
  return { event, txSpans, holds };
}

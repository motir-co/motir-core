import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { startMetricsServer } from '@/lib/monitoring/metricsServer';
import {
  registerRequestDbTimingListener,
  REQUEST_DB_TIMING_METRICS as M,
  requestDbTimingRegistry,
  resetRequestDbTimingForTests,
} from '@/lib/monitoring/requestDbTiming';
import { serverSentryInitOptions } from '@/lib/monitoring/serverInit';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { spyOnJobDispatch } from '../../helpers/jobs';
import {
  assertTraceShape,
  connect,
  envelopes,
  FARGATE,
  histogramCount,
  initSentry,
  request,
  seed,
  serialize,
  stubMonitoringEnv,
  transactions,
  transportsCreated,
} from '../../helpers/observabilityPath';

// MOTIR-8556 — THE ASSEMBLED OBSERVABILITY PATH, in one Node process, with
// nothing between the pieces mocked.
//
// An MCP `tools/call` enters the registry's trace wrapper (MOTIR-8551), opens
// transactions through the `with*Context` helpers, which are measured at
// `retryOnceBeforeBody` (MOTIR-8550). Each measurement becomes Sentry spans when
// the request is sampled AND a recorder histogram observation always
// (MOTIR-8553), on an init built by `serverSentryInitOptions({ traces: true })`
// (MOTIR-8549).
//
// ⚠️ THE SENTRY SDK IS REAL. There is no `vi.mock('@sentry/…')` in this file and
// nothing replaces `startSpan`: every card's own unit test already mocks Sentry,
// and a mocked seam says nothing about the seam. The only test-owned piece is the
// TRANSPORT, which keeps each envelope in memory instead of sending it.
//
// ⚠️ THE ROOT SPAN STANDS IN FOR NEXT'S `http.server` SPAN. In production the
// request's root is the span Next opens for `POST /api/mcp`, and the trace
// wrapper renames it after the tool. There is no Next server here, so each call
// runs inside a `forceTransaction` span named the way Next names it; that span is
// the only thing this file adds, and the rename is asserted on it.

//
// The rate-0 case is `observabilityPathUnsampled.test.ts`: a second init in this
// process would keep this file's rate-1 sampler.

/** The move_to_parent transactions case C counted with no SDK at all. */
let unsampledMoveCount = 0;

beforeEach(async () => {
  envelopes.length = 0;
  resetRequestDbTimingForTests();
  await truncateAuthTables();
  spyOnJobDispatch();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRequestDbTimingForTests();
});

afterAll(async () => {
  await Sentry.close(2000);
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── C. NO DSN MEANS NO INIT — first, before anything in this file initialises ──

describe('with no SENTRY_DSN, on the assembled path', () => {
  it('no init, no transport, nothing captured — the call is unchanged and the histograms still record', async () => {
    stubMonitoringEnv({ SENTRY_TRACES_SAMPLE_RATE: '1', ...FARGATE });

    // The three init entry points, the way `sentry-init-gate.test.ts` drives them:
    // the server and Edge configs by import, and the worker's gate, which is
    // `serverSentryInitOptions()` returning null (the worker calls `init` only
    // past `if (!options) return;`, which that test pins).
    //
    // ⚠️ "`init` was never called" is OBSERVED, not spied: the SDK's ESM
    // namespace cannot be spied on, and mocking the module is what this file
    // exists not to do. Every `Sentry.init` binds a client to the global scope,
    // so a process with no client is a process where `init` never ran — and no
    // client means no transport was ever built.
    vi.resetModules();
    await import('@/sentry.server.config');
    await import('@/sentry.edge.config');
    expect(serverSentryInitOptions()).toBeNull();
    expect(serverSentryInitOptions({ traces: true })).toBeNull();
    expect(Sentry.getClient()).toBeUndefined();

    // No port either.
    expect(startMetricsServer()).toBeNull();

    registerRequestDbTimingListener();
    const { fx, storyKey, newParentKey } = await seed();
    const client = await connect(fx);
    const result = await request(client, 'move_to_parent', {
      key: storyKey,
      parentKey: newParentKey,
    });
    await client.close();

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { identifier: string }).identifier).toBe(storyKey);
    expect(Sentry.getClient()).toBeUndefined();
    expect(transportsCreated.count).toBe(0);
    expect(envelopes).toHaveLength(0);
    unsampledMoveCount = await histogramCount(M.wait, { route: 'mcp', tool: 'move_to_parent' });
    expect(unsampledMoveCount).toBeGreaterThanOrEqual(1);
  });
});

// ── B + E. The real SDK, sampled ─────────────────────────────────────────────

describe('sampled: the seam → the spans → the sink, for move_to_parent and add_plan_items', () => {
  it('each call is one named trace whose transaction spans the histograms count exactly — and no bound value leaks', async () => {
    await initSentry('1');
    expect(transportsCreated.count).toBeGreaterThan(0);
    registerRequestDbTimingListener();

    const SENTINEL = `sentinel-8556-${randomUUID()}`;
    const { fx, storyKey, newParentKey, planId } = await seed(`Moved ${SENTINEL}`);
    const client = await connect(fx);

    for (const [tool, args] of [
      ['move_to_parent', { key: storyKey, parentKey: newParentKey }],
      [
        'add_plan_items',
        {
          planId,
          proposals: [{ op: 'add', proposedFields: { title: SENTINEL, kind: 'epic' } }],
        },
      ],
    ] as const) {
      envelopes.length = 0;
      const labels = { route: 'mcp', tool };
      const waitBefore = await histogramCount(M.wait, labels);
      const holdBefore = await histogramCount(M.hold, labels);

      const result = await request(client, tool, args);
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      await Sentry.flush(2000);

      const events = transactions();
      expect(events, `one transaction event for ${tool}`).toHaveLength(1);
      const { txSpans, holds } = assertTraceShape(events[0]!, tool);

      // THE SINK AGREES WITH THE TRACE.
      expect((await histogramCount(M.wait, labels)) - waitBefore).toBe(txSpans.length);
      expect((await histogramCount(M.hold, labels)) - holdBefore).toBe(holds);
      // …and with the C case: tracing changes nothing about what is opened.
      if (tool === 'move_to_parent') expect(txSpans.length).toBe(unsampledMoveCount);
    }
    await client.close();

    // E. The bound value. POSITIVE CONTROL FIRST: the sentinel really was bound
    // into a write, and is in the database.
    const items = await adminDb.planItem.findMany({ where: { planId } });
    expect(serialize(items)).toContain(SENTINEL);
    // …and nowhere it must not be.
    expect(serialize(envelopes)).not.toContain(SENTINEL);
    expect(await requestDbTimingRegistry().metrics()).not.toContain(SENTINEL);
  });
});

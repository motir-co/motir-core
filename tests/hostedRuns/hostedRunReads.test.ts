import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE HOSTED RUN'S READS for its run panel (Story MOTIR-683 · MOTIR-691), on real
// Postgres:
//   · the run detail's `hostedEnd` — the end path's closing line and the legs'
//     exit code, READ off the record, never stored;
//   · `GET /api/dispatch-runs/[id]/machine-time` — billable seconds and settled,
//     never a money figure, 404 across workspaces.

const workspaceCtx = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => workspaceCtx.current };
});

const { GET: getMachineTime } = await import('@/app/api/dispatch-runs/[id]/machine-time/route');
const { dispatchRunService } = await import('@/lib/services/dispatchRunService');
const { workItemsService } = await import('@/lib/services/workItemsService');

let fixture: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fixture = await makeWorkItemFixture();
  workspaceCtx.current = { userId: fixture.ownerId, workspaceId: fixture.workspaceId };
  // motir-ai is not configured here, so the detail's cost read answers null.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function openRun(origin: 'local' | 'hosted'): Promise<{ runId: string; key: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: fixture.projectId, kind: 'task', title: 'a card' },
    fixture.ctx,
  );
  const { run } = await dispatchRunService.open(
    {
      projectKey: fixture.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      origin,
      model: origin === 'hosted' ? 'claude-sonnet-5' : undefined,
      cards: [{ key: item.identifier, disposition: 'queued' }],
    },
    fixture.ctx,
  );
  return { runId: run.id, key: item.identifier };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (id: string) =>
  new Request(`http://localhost:3000/api/dispatch-runs/${id}/machine-time`);

describe('the run detail carries a hosted run’s END, read off the record', () => {
  it('the end path’s closing line — its outcome and its detail, verbatim — and the leg’s exit code', async () => {
    const { runId, key } = await openRun('hosted');
    await dispatchRunService.appendEvents(
      runId,
      [
        { kind: 'agent_exited', workItemKey: key, exitCode: 1 },
        {
          kind: 'log',
          body: '[motir] Motir agent run ended (stalled): stalled: no agent output for 15 minutes\n',
          data: { end: 'stall' },
        },
      ],
      fixture.ctx,
    );
    const detail = await dispatchRunService.getRunDetail(runId, fixture.ctx);
    expect(detail.hostedEnd).toEqual({
      outcome: 'stall',
      detail: 'stalled: no agent output for 15 minutes',
      exitCode: 1,
    });
  });

  // MOTIR-11176 renamed the closing line; a run that ended before it keeps the
  // old prefix on its record, and its detail still reads without it.
  it('a closing line written before the rename (`[motir] hosted run ended`) still reads', async () => {
    const { runId } = await openRun('hosted');
    await dispatchRunService.appendEvents(
      runId,
      [
        {
          kind: 'log',
          body: '[motir] hosted run ended (backstop): reached the 12-hour limit\n',
          data: { end: 'backstop' },
        },
      ],
      fixture.ctx,
    );
    const detail = await dispatchRunService.getRunDetail(runId, fixture.ctx);
    expect(detail.hostedEnd).toEqual({
      outcome: 'backstop',
      detail: 'reached the 12-hour limit',
      exitCode: null,
    });
  });

  it('an ordinary log line is not an end line', async () => {
    const { runId } = await openRun('hosted');
    await dispatchRunService.appendEvents(
      runId,
      [{ kind: 'log', body: 'opencode: reading the card\n', data: { stream: 'stdout' } }],
      fixture.ctx,
    );
    const detail = await dispatchRunService.getRunDetail(runId, fixture.ctx);
    expect(detail.hostedEnd).toEqual({ outcome: null, detail: null, exitCode: null });
  });

  it('a LOCAL run carries no hostedEnd at all', async () => {
    const { runId } = await openRun('local');
    const detail = await dispatchRunService.getRunDetail(runId, fixture.ctx);
    expect('hostedEnd' in detail).toBe(false);
  });
});

describe('GET /api/dispatch-runs/[id]/machine-time', () => {
  it('a run with no container yet answers zero seconds, unsettled — and no money figure', async () => {
    const { runId } = await openRun('hosted');
    const res = await getMachineTime(req(runId), params(runId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ billableSeconds: 0, settled: false });
    expect(JSON.stringify(body)).not.toMatch(/cost|usd/i);
  });

  it('404 for a run in another workspace — never 403', async () => {
    const { runId } = await openRun('hosted');
    const other = await makeWorkItemFixture();
    workspaceCtx.current = { userId: other.ownerId, workspaceId: other.workspaceId };
    const res = await getMachineTime(req(runId), params(runId));
    expect(res.status).toBe(404);
  });

  it('404 for a run that does not exist', async () => {
    const res = await getMachineTime(req('no-such-run'), params('no-such-run'));
    expect(res.status).toBe(404);
  });
});

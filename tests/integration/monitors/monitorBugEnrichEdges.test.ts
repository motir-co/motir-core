import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The bug-ENRICHMENT surface's EDGE arms (Story MOTIR-4930 · Subtask MOTIR-5852) —
// the states the main suites do not reach on their own: an item gone before the
// job ran, a binding gone, a stamped bug whose connection vanished, a project the
// binder can no longer read, a credential with no organisation, and every
// "anything else is re-thrown" arm, so a transport fault is never mistaken for a
// value. Real Postgres; motir-ai faked at its client.

vi.mock('@/lib/ai/motirAiClient', () => ({ submitJob: vi.fn(), getJob: vi.fn() }));
vi.mock('@/lib/ai/tenantOrg', () => ({ resolveTenantOrg: vi.fn() }));
vi.mock('@/lib/workspaces/tenantRead', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces/tenantRead')>();
  return { ...actual, readProject: vi.fn(actual.readProject) };
});
vi.mock('@/lib/ai/authoredBug', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/authoredBug')>();
  return { ...actual, parseAuthoredBug: vi.fn(actual.parseAuthoredBug) };
});

import { db } from '@/lib/db';
import { getJob, submitJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { parseAuthoredBug } from '@/lib/ai/authoredBug';
import { readProject } from '@/lib/workspaces/tenantRead';
import { monitorBugEnrichOnCreated } from '@/lib/jobs/definitions/monitorBugEnrich';
import type { WorkItemCreatedData } from '@/lib/jobs/types';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
  type FakeMonitorIssue,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { monitorBugEnrichmentService } from '@/lib/services/monitorBugEnrichmentService';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { monitorCredentialService } from '@/lib/services/monitorCredentialService';
import {
  monitorIngestionService,
  type MonitorReconcileConnection,
} from '@/lib/services/monitorIngestionService';
import { workItemsService } from '@/lib/services/workItemsService';
import { StaleWorkItemError } from '@/lib/workItems/errors';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { captureJobEvents, JobTestEngine, type CapturedJobEvent } from '../../helpers/jobs';

let cap: { events: CapturedJobEvent[]; restore: () => void };

const ANSWER = {
  descriptionMd:
    'Broken.\n\n## Acceptance criteria\n\n- It works.\n\n## Context refs\n\n- `lib/a.ts`',
  explanationMd: 'It matters.',
  type: 'code',
  executor: 'coding_agent',
  storyPoints: 1,
  estimateMinutes: 20,
  contextRefs: ['lib/a.ts'],
  candidateMechanisms: [],
  grounded: true,
  groundingReason: 'indexed',
};

beforeEach(async () => {
  await truncateAuthTables();
  resetFakeMonitorProvider();
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
  vi.clearAllMocks();
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.example');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.mocked(resolveTenantOrg).mockResolvedValue({
    organizationId: 'org_1',
    isMeta: false,
    internalBilling: false,
  });
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_edge' });
  vi.mocked(getJob).mockResolvedValue({
    jobId: 'job_edge',
    status: 'succeeded',
    result: {
      envelopeVersion: 'v1',
      jobKind: 'author_bug',
      summary: 's',
      usage: { model: null, inputTokens: 0, outputTokens: 0 },
      authoredBug: ANSWER,
    },
    error: null,
  });
  cap = captureJobEvents();
});

afterEach(() => {
  cap.restore();
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function seed(): Promise<{ fx: WorkItemFixture; target: MonitorReconcileConnection }> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `Edge ${n}`, identifier: `EDG${n}` });
  await monitorConnectionService.completeGrant(
    {
      provider: 'sentry',
      providerInstallationId: `pi-edge-${n}`,
      code: 'valid-code',
      projectId: fx.projectId,
    },
    fx.ctx,
  );
  const dto = await monitorConnectionService.bindProject(
    fx.projectId,
    { externalProjectId: 'fake-web', externalProjectSlug: 'web' },
    fx.ctx,
  );
  return {
    fx,
    target: {
      id: dto.id,
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
      boundByUserId: fx.ctx.userId,
      externalProjectSlug: 'web',
    },
  };
}

async function file(target: MonitorReconcileConnection, externalId: string) {
  const issue: FakeMonitorIssue = {
    externalId,
    title: `Error ${externalId}`,
    culprit: null,
    level: 'error',
    eventCount: 1,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    permalink: null,
    assignee: null,
  };
  fakeMonitorState().issues = [issue];
  const from = cap.events.length;
  const { workItemId } = await monitorIngestionService.reconcileIssue(target, issue, null);
  const event = cap.events.slice(from).find((e) => e.name === 'work-item/created')!
    .data as WorkItemCreatedData;
  return { workItemId: workItemId!, event };
}

describe('DISPATCH edges', () => {
  it('an item DELETED before the job ran is not-a-bug; any other read failure is re-thrown', async () => {
    const { target } = await seed();
    const { workItemId, event } = await file(target, 'gone-1');
    await adminDb.workItem.delete({ where: { id: workItemId } });
    await expect(monitorBugEnrichmentService.dispatchEnrichment(event)).resolves.toEqual({
      dispatched: false,
      reason: 'not-a-bug',
    });
    vi.spyOn(workItemsService, 'getWorkItem').mockRejectedValueOnce(new Error('db down'));
    await expect(monitorBugEnrichmentService.dispatchEnrichment(event)).rejects.toThrow('db down');
  });

  it('a stamped bug whose CONNECTION is gone is no-monitor-link (a value), never a retry', async () => {
    const { fx, target } = await seed();
    const from = cap.events.length;
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'bug', title: 'Orphaned stamp' },
      { ...fx.ctx, viaMonitorConnectionId: 'a-connection-that-was-deleted' },
    );
    const event = cap.events.slice(from).find((e) => e.name === 'work-item/created')!
      .data as WorkItemCreatedData;
    void target;
    await expect(monitorBugEnrichmentService.dispatchEnrichment(event)).resolves.toEqual({
      dispatched: false,
      reason: 'no-monitor-link',
    });
  });

  it('a project the binder can no longer read dispatches nothing', async () => {
    const { target } = await seed();
    const { event } = await file(target, 'noproject-1');
    vi.mocked(readProject).mockResolvedValueOnce(null);
    await expect(monitorBugEnrichmentService.dispatchEnrichment(event)).resolves.toEqual({
      dispatched: false,
      reason: 'not-a-bug',
    });
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('a credential with NO organisation slug still reads the event, with an empty org', async () => {
    const { target } = await seed();
    const { event } = await file(target, 'noorg-1');
    const read = vi.spyOn(fakeMonitorProvider, 'getIssueContext');
    vi.spyOn(monitorCredentialService, 'withFreshCredential').mockImplementationOnce(
      async (_id, fn) =>
        fn({
          installationRowId: 'x',
          workspaceId: target.workspaceId,
          provider: 'sentry',
          orgSlug: null,
          token: 't',
          expiresAt: new Date(Date.now() + 60_000),
        }),
    );
    await expect(monitorBugEnrichmentService.dispatchEnrichment(event)).resolves.toMatchObject({
      dispatched: true,
      framesRead: true,
    });
    expect(read.mock.calls[0]![0]).toMatchObject({ orgSlug: '' });
  });

  it('the JOB function forwards an event with NO provenance and stops at the dispatch value', async () => {
    const { fx } = await seed();
    const from = cap.events.length;
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'bug', title: 'By hand' },
      fx.ctx,
    );
    const event = cap.events.slice(from).find((e) => e.name === 'work-item/created')!
      .data as WorkItemCreatedData;
    const outcome = await new JobTestEngine({
      function: monitorBugEnrichOnCreated,
      events: [{ name: 'work-item/created', data: event }],
    }).execute();
    expect(outcome.result).toEqual({ dispatch: { dispatched: false, reason: 'no-monitor-link' } });
  });
});

describe('triggerForFiledBug — the trigger rebuilt from the link row', () => {
  it('rebuilds exactly the event the reconciler’s create emitted', async () => {
    const { target } = await seed();
    const { workItemId, event } = await file(target, 'trigger-1');
    await expect(
      monitorBugEnrichmentService.triggerForFiledBug(workItemId, target.workspaceId),
    ).resolves.toEqual({
      workspaceId: event.workspaceId,
      projectId: event.projectId,
      workItemId: event.workItemId,
      actorId: event.actorId,
      viaMonitorConnectionId: event.viaMonitorConnectionId,
    });
  });

  it('is null for another workspace, for a bug no binding filed, and for a binding with no binder', async () => {
    const { fx, target } = await seed();
    const { workItemId } = await file(target, 'trigger-2');
    await expect(
      monitorBugEnrichmentService.triggerForFiledBug(workItemId, 'another-workspace'),
    ).resolves.toBeNull();
    const byHand = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'bug', title: 'By hand' },
      fx.ctx,
    );
    await expect(
      monitorBugEnrichmentService.triggerForFiledBug(byHand.id, target.workspaceId),
    ).resolves.toBeNull();
    await adminDb.monitorConnection.update({
      where: { id: target.id },
      data: { boundByUserId: null },
    });
    await expect(
      monitorBugEnrichmentService.triggerForFiledBug(workItemId, target.workspaceId),
    ).resolves.toBeNull();
  });
});

describe('APPLY edges', () => {
  it('no provenance, or a binding with no binder, is bug-gone', async () => {
    const { target } = await seed();
    const { event } = await file(target, 'apply-nobinder-1');
    const { viaMonitorConnectionId: _stamp, ...unstamped } = event;
    await expect(
      monitorBugEnrichmentService.applyAuthoredBug(unstamped, 'job_edge'),
    ).resolves.toEqual({
      status: 'skipped',
      reason: 'bug-gone',
    });
    await adminDb.monitorConnection.update({
      where: { id: target.id },
      data: { boundByUserId: null },
    });
    await expect(monitorBugEnrichmentService.applyAuthoredBug(event, 'job_edge')).resolves.toEqual({
      status: 'skipped',
      reason: 'bug-gone',
    });
  });

  it('a non-transport failure reading the job is re-thrown, not swallowed as ai-unreachable', async () => {
    const { target } = await seed();
    const { event } = await file(target, 'apply-throw-1');
    vi.mocked(getJob).mockRejectedValueOnce(new TypeError('a programming error'));
    await expect(monitorBugEnrichmentService.applyAuthoredBug(event, 'job_edge')).rejects.toThrow(
      'a programming error',
    );
  });

  it('a parser fault that is not a validation refusal is re-thrown', async () => {
    const { target } = await seed();
    const { event } = await file(target, 'apply-parse-1');
    vi.mocked(parseAuthoredBug).mockImplementationOnce(() => {
      throw new RangeError('unexpected');
    });
    await expect(monitorBugEnrichmentService.applyAuthoredBug(event, 'job_edge')).rejects.toThrow(
      'unexpected',
    );
  });

  it('a bug DELETED before the answer landed is bug-gone; any other read failure is re-thrown', async () => {
    const { target } = await seed();
    const { workItemId, event } = await file(target, 'apply-gone-1');
    vi.spyOn(workItemsService, 'getWorkItem').mockRejectedValueOnce(new Error('db down'));
    await expect(monitorBugEnrichmentService.applyAuthoredBug(event, 'job_edge')).rejects.toThrow(
      'db down',
    );
    await adminDb.workItem.delete({ where: { id: workItemId } });
    await expect(monitorBugEnrichmentService.applyAuthoredBug(event, 'job_edge')).resolves.toEqual({
      status: 'skipped',
      reason: 'bug-gone',
    });
  });

  it('an edit landing between the read and the write (StaleWorkItemError) is card-changed; any other write failure is re-thrown', async () => {
    const { target } = await seed();
    const { event } = await file(target, 'apply-stale-1');
    const update = vi.spyOn(workItemsService, 'updateWorkItem');
    update.mockRejectedValueOnce(new StaleWorkItemError());
    await expect(monitorBugEnrichmentService.applyAuthoredBug(event, 'job_edge')).resolves.toEqual({
      status: 'skipped',
      reason: 'card-changed',
    });
    update.mockRejectedValueOnce(new Error('write failed'));
    await expect(monitorBugEnrichmentService.applyAuthoredBug(event, 'job_edge')).rejects.toThrow(
      'write failed',
    );
  });
});

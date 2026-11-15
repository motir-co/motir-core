import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { derived } from '@/lib/mcp/payloads/define';
import { getWorkItemPayload } from '@/lib/mcp/payloads/workItems';
import { runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { monitorIssueLinkService } from '@/lib/services/monitorIssueLinkService';
import { monitorIssueService } from '@/lib/services/monitorIssueService';
import { plansService } from '@/lib/services/plansService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { card, monitorLinkScenario } from '../integration/monitors/_monitorLinkFixtures';

// `get_work_item` returns the work item's ERRORS (Story MOTIR-5975 · Subtask
// MOTIR-5981) — every monitor link with its stored facts and evidence, through
// the SAME `monitorIssueService.listForWorkItem` the item page renders, with no
// provider call. On real Postgres against the fake provider.

beforeEach(async () => {
  await truncateAuthTables();
  resetFakeMonitorProvider();
  fakeMonitorState().issues = [];
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
});

afterEach(() => {
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const EVENT_AT = new Date('2026-09-20T18:04:11.000Z');

async function linkedCard() {
  const s = await monitorLinkScenario('Get errors');
  const item = await card(s.fx, 'A bug with an error');
  fakeMonitorState().issues = [
    {
      externalId: 'e1',
      title: 'PrismaClientKnownRequestError: expired transaction',
      culprit: 'lib/services/githubWebhookService.ts',
      level: 'error',
      eventCount: 112,
      firstSeenAt: new Date('2026-09-19T00:00:00.000Z'),
      lastSeenAt: new Date('2026-09-20T18:04:11.000Z'),
      permalink: 'https://fake.invalid/issues/e1',
      assignee: null,
      externalProjectId: 'fake-web',
      environment: 'production',
      release: '2026.09.20-1',
      frames: [
        {
          filePath: 'lib/services/githubWebhookService.ts',
          function: 'handle',
          lineNumber: 88,
          inApp: true,
        },
      ],
      exception: { type: 'PrismaClientKnownRequestError', message: 'expired transaction' },
      rawTags: [
        { key: 'transaction', value: 'POST /api/github/webhook' },
        { key: 'user.email', value: 'someone@example.com' },
      ],
      requestMethod: 'POST',
      requestUrl: 'https://app.example/api/github/webhook?x=1',
      eventId: 'ev-1',
      eventAt: EVENT_AT,
    },
  ];
  await monitorIssueLinkService.linkIssue(
    item.id,
    { connectionId: s.webConnectionId, externalIssueId: 'e1', move: false },
    s.fx.ctx,
  );
  return { s, item };
}

describe('get_work_item — errors', () => {
  it('a work item with one link returns ONE row equal to the page’s read, evidence included', async () => {
    const { s, item } = await linkedCard();
    const page = await monitorIssueService.listForWorkItem(item.id, s.fx.ctx);

    const result = await runGetWorkItem({ key: item.identifier }, s.fx.ctx);

    expect(result.isError).toBeFalsy();
    const errors = (result.structuredContent as { errors: unknown[] }).errors;
    expect(errors).toEqual(JSON.parse(JSON.stringify(page)));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      title: 'PrismaClientKnownRequestError: expired transaction',
      evidence: {
        state: 'present',
        stale: false,
        exception: { type: 'PrismaClientKnownRequestError', message: 'expired transaction' },
        tags: [{ key: 'transaction', value: 'POST /api/github/webhook' }],
        request: { method: 'POST', path: '/api/github/webhook' },
        eventId: 'ev-1',
        eventAt: EVENT_AT.toISOString(),
      },
    });
    // The user-identifying tag never reached the store, so it cannot reach here.
    expect(JSON.stringify(result.structuredContent)).not.toContain('someone@example.com');
  });

  it('makes NO call on any MonitorProvider method', async () => {
    const { s, item } = await linkedCard();
    const spies = (Object.keys(fakeMonitorProvider) as (keyof typeof fakeMonitorProvider)[])
      .filter((key) => typeof fakeMonitorProvider[key] === 'function')
      .map((key) => vi.spyOn(fakeMonitorProvider, key as never));

    await runGetWorkItem({ key: item.identifier }, s.fx.ctx);

    expect(spies.length).toBeGreaterThan(5);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('a work item with no link answers errors: []', async () => {
    const s = await monitorLinkScenario('Get no errors');
    const item = await card(s.fx, 'No error here');

    const result = await runGetWorkItem({ key: item.identifier }, s.fx.ctx);

    expect((result.structuredContent as { errors: unknown[] }).errors).toEqual([]);
  });

  it('the PROJECTED answer for a PROPOSAL carries no errors key and is otherwise unchanged', async () => {
    const { s } = await linkedCard();
    const plan = await plansService.createPlan(s.fx.projectId, { title: 'Plan' }, s.fx.ctx);
    const withAdd = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Proposed', kind: 'task' } }],
      s.fx.ctx,
    );

    const result = await runGetWorkItem(
      { key: `planItem:${withAdd.items[0]!.id}`, planId: plan.id },
      s.fx.ctx,
    );

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).not.toHaveProperty('errors');
    expect(structured).toHaveProperty('projection');
    expect(structured['children']).toEqual([]);
  });

  it('a COMMITTED key read through a plan keeps its errors (MOTIR-11340)', async () => {
    const { s, item } = await linkedCard();
    const plan = await plansService.createPlan(s.fx.projectId, { title: 'Plan' }, s.fx.ctx);

    const result = await runGetWorkItem({ key: item.identifier, planId: plan.id }, s.fx.ctx);

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toHaveProperty('errors');
    expect(structured).toHaveProperty('projection');
  });
});

describe('getWorkItemPayload DECLARES errors', () => {
  it('a row that lacks evidence fails the payload’s own validation', () => {
    const row = {
      id: 'mi',
      title: 'T',
      level: null,
      culprit: null,
      permalink: null,
      eventCount: 1,
      firstSeenAt: '2026-09-01T00:00:00.000Z',
      lastSeenAt: '2026-09-02T00:00:00.000Z',
      environment: null,
      release: null,
      connection: { id: 'c', orgSlug: null, projectSlug: 'web' },
    };
    expect(() => derived(getWorkItemPayload, { children: [], errors: [row as never] })).toThrow();
    expect(() =>
      derived(getWorkItemPayload, {
        children: [],
        errors: [
          {
            ...row,
            evidence: {
              state: 'never_read',
              stale: false,
              exception: null,
              frames: [],
              tags: [],
              request: null,
              eventId: null,
              eventAt: null,
              readAt: null,
              lastFailedAt: null,
            },
          } as never,
        ],
      }),
    ).not.toThrow();
  });
});

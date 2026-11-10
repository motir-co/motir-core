import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { classifyApiV1Error } from '@/lib/api/v1/errors';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { RUN_TOKEN_ROUTES } from '@/lib/hostedRuns/runTokenRoutes';
import { projectsService } from '@/lib/services/projectsService';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  TestInstructionsCapExceededError,
  TestInstructionsConflictError,
  TestInstructionsWorkItemNotFoundError,
} from '@/lib/testInstructions/errors';
import { bearer } from './fixtures/apiV1Fixtures';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// MOTIR-10877 — the RUN door for a tool-less agent's HOW TO TEST, against a real Postgres:
// `POST /api/v1/dispatch-runs/{id}/how-to-test`. A hosted run's agent and an agent-instance
// run's agent hold no Motir token and `/api/mcp` refuses the run token, so the CLI publishes
// the How to test the agent wrote into `$MOTIR_AGENT_REPORT`, with the RUN's own credential.
// Every call here is made with that credential, through the route, on a server-opened run of
// each origin; every assertion reads the rows the call left.

beforeEach(async () => {
  await truncateAuthTables();
  resetRateLimitStore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Card {
  id: string;
  key: string;
}

/** A card created directly and taken to In Progress, as a run's claim leaves it. */
async function inProgressCard(fx: WorkItemFixture, title = 'A card'): Promise<Card> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  return { id: item.id, key: item.identifier };
}

/** A server-opened run over `card` — `hosted`, or `instance` naming an agent — with its leg
 *  OPEN, and the run's own bearer credential. */
async function serverRunOver(
  fx: WorkItemFixture,
  card: Card,
  origin: 'hosted' | 'instance',
): Promise<{ runId: string; headers: Record<string, string> }> {
  let agentInstanceId: string | null = null;
  if (origin === 'instance') {
    const ws = await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } });
    const agent = await adminDb.agentInstance.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: ws.organizationId,
        projectId: fx.projectId,
        ownerId: fx.ownerId,
        name: 'my-agent',
        profileId: 'claude-code',
        imageTag: 'latest',
        imageDigest: 'sha256:test',
        region: 'iad',
        state: 'running',
      },
    });
    agentInstanceId = agent.id;
  }
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      command: 'run',
      origin,
      agentInstanceId,
      createdById: fx.ownerId,
      cards: {
        create: [
          {
            workspaceId: fx.workspaceId,
            workItemId: card.id,
            workItemKey: card.key,
            position: 0,
            disposition: 'running',
            startedAt: new Date(),
          },
        ],
      },
    },
  });
  const { token } = await runCredentialService.mintRunCredential({
    dispatchRunId: run.id,
    dispatcherUserId: fx.ownerId,
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
  return { runId: run.id, headers: bearer(token) };
}

async function post(
  runId: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  const { POST } = await import('@/app/api/v1/dispatch-runs/[id]/how-to-test/route');
  return POST(
    new Request(`http://localhost:3000/api/v1/dispatch-runs/${runId}/how-to-test`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: runId }) },
  );
}

const records = (card: Card) =>
  adminDb.testInstructions.findMany({
    where: { workItemId: card.id },
    orderBy: { createdAt: 'asc' },
  });

const BODY = '## Locally\n\nSENTINEL-HOW-TO-TEST\n\n```sh\npnpm test\n```';

async function codeOf(res: Response): Promise<string> {
  return ((await res.json()) as { code: string }).code;
}

describe('the door is on the run-token list, bound to its own run, called by the CLI', () => {
  it('publishDispatchRunHowToTest', () => {
    expect(RUN_TOKEN_ROUTES).toContainEqual({
      operationId: 'publishDispatchRunHowToTest',
      method: 'POST',
      path: '/api/v1/dispatch-runs/{id}/how-to-test',
      binding: 'own_run',
      calledBy: 'cli',
    });
  });
});

describe('a tool-less agent’s How to test, published by its run', () => {
  it.each(['hosted', 'instance'] as const)(
    'a %s run publishes it on the card, attributed to THIS run, and a re-publish supersedes',
    async (origin) => {
      const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
      const card = await inProgressCard(fx);
      const { runId, headers } = await serverRunOver(fx, card, origin);

      const res = await post(runId, headers, {
        key: card.key.toLowerCase(),
        bodyMd: BODY,
        previewPath: '/items/CUST-1',
      });
      expect(res.status).toBe(200);
      const ack = (await res.json()) as { testInstructionsId: string; created: boolean };
      expect(ack.created).toBe(true);

      const [written] = await records(card);
      expect(written).toMatchObject({
        id: ack.testInstructionsId,
        dispatchRunId: runId,
        previewPath: '/items/CUST-1',
        isCurrent: true,
      });
      expect(written!.bodyMd).toContain('SENTINEL-HOW-TO-TEST');

      // The whole corrected text again — a new version; the old one stays as history.
      const again = await post(runId, headers, { key: card.key, bodyMd: `${BODY}\n\nfixed` });
      expect(again.status).toBe(200);
      const all = await records(card);
      expect(all).toHaveLength(2);
      expect(all.map((r) => r.isCurrent)).toEqual([false, true]);
    },
  );

  it('a run token naming ANOTHER run is refused 403, and nothing is written', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await inProgressCard(fx);
    const other = await inProgressCard(fx, 'Other');
    const mine = await serverRunOver(fx, card, 'hosted');
    const theirs = await serverRunOver(fx, other, 'hosted');

    const res = await post(theirs.runId, mine.headers, { key: other.key, bodyMd: BODY });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('DISPATCH_RUN_TOKEN_OUT_OF_SCOPE');
    expect(await records(other)).toHaveLength(0);
  });

  it('a card off the run is out of its credential’s reach, and an ENDED leg is refused 422', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await inProgressCard(fx);
    const elsewhere = await inProgressCard(fx, 'Not on this run');
    const { runId, headers } = await serverRunOver(fx, card, 'hosted');

    // The run credential reaches only the run's own cards (`runTokenScopeService`).
    const res = await post(runId, headers, { key: elsewhere.key, bodyMd: BODY });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('DISPATCH_RUN_TOKEN_OUT_OF_SCOPE');
    expect(await records(elsewhere)).toHaveLength(0);

    // A leg the run already ENDED is no longer the run's to publish on.
    await adminDb.dispatchRunCard.updateMany({
      where: { dispatchRunId: runId },
      data: { endedAt: new Date(), disposition: 'implemented' },
    });
    const ended = await post(runId, headers, { key: card.key, bodyMd: BODY });
    expect(ended.status).toBe(422);
    expect(await codeOf(ended)).toBe('UNKNOWN_DISPATCH_RUN_CARD');
    expect(await records(card)).toHaveLength(0);
  });

  it('a run that is no longer running is refused 409, and nothing is written', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await inProgressCard(fx);
    const { runId, headers } = await serverRunOver(fx, card, 'hosted');
    await adminDb.dispatchRun.update({
      where: { id: runId },
      data: { status: 'succeeded', stopReason: 'completed', endedAt: new Date() },
    });

    const res = await post(runId, headers, { key: card.key, bodyMd: BODY });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('DISPATCH_RUN_TERMINAL');
    expect(await records(card)).toHaveLength(0);
  });

  it('an unknown card, or an unknown project, is a 404', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await inProgressCard(fx);
    const { runId, headers } = await serverRunOver(fx, card, 'hosted');

    for (const key of ['CUST-999', 'NOPE-1', 'NODASH']) {
      const res = await post(runId, headers, { key, bodyMd: BODY });
      expect(res.status, key).toBe(404);
    }
  });

  it('a project read that fails for any other reason is not dressed up as a 404', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await inProgressCard(fx);
    const { runId, headers } = await serverRunOver(fx, card, 'hosted');
    const spy = vi.spyOn(projectsService, 'getByKey').mockRejectedValueOnce(new Error('db down'));
    try {
      const res = await post(runId, headers, { key: card.key, bodyMd: BODY });
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await records(card)).toHaveLength(0);
  });

  it('the record’s own refusals are 422s that write nothing', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await inProgressCard(fx);
    const { runId, headers } = await serverRunOver(fx, card, 'hosted');
    const sha = 'abc1234def5678abc1234def5678abc1234def56';

    const cases: [unknown, string | null][] = [
      // The project has no connected repository called that.
      [
        { key: card.key, bodyMd: BODY, repos: [{ repo: 'acme/elsewhere', commitSha: sha }] },
        'TEST_INSTRUCTIONS_REPO_NOT_IN_PROJECT',
      ],
      // A preview path is a path on the preview host.
      [
        { key: card.key, bodyMd: BODY, previewPath: 'items/CUST-1' },
        'TEST_INSTRUCTIONS_INVALID_FIELD',
      ],
      // The body schema itself: an empty body, an unknown field.
      [{ key: card.key, bodyMd: '' }, null],
      [{ key: card.key, bodyMd: BODY, commitSha: sha }, null],
    ];
    for (const [body, code] of cases) {
      const res = await post(runId, headers, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      if (code) expect(await codeOf(res)).toBe(code);
    }
    expect(await records(card)).toHaveLength(0);
  });
});

describe('the writer’s run guard, called directly', () => {
  it('an unknown run, and another operator’s run, answer the same not-found', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await inProgressCard(fx);
    const someoneElse = await adminDb.user.create({
      data: { email: 'someone-else@example.com', name: 'Someone Else' },
    });
    const theirs = await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'run',
        createdById: someoneElse.id,
      },
    });

    for (const forRunId of ['run_does_not_exist', theirs.id]) {
      await expect(
        testInstructionsService.publish({ workItemId: card.id, bodyMd: BODY, forRunId }, fx.ctx),
      ).rejects.toMatchObject({ code: 'DISPATCH_RUN_NOT_FOUND' });
    }
    expect(await records(card)).toHaveLength(0);
  });
});

describe('every refusal the record can raise has its v1 status', () => {
  it.each([
    [new TestInstructionsWorkItemNotFoundError('wi_1'), 404],
    [new TestInstructionsCapExceededError('bodyMd', 32768, 'bytes'), 422],
    [new TestInstructionsConflictError('wi_1'), 409],
  ])('%s', (err, status) => {
    expect(classifyApiV1Error(err)?.status).toBe(status);
  });
});

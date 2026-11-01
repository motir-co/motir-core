import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { composeStopComment } from '@/lib/dispatchRuns/stopComment';
import { RUN_TOKEN_ROUTES } from '@/lib/hostedRuns/runTokenRoutes';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { workItemsService } from '@/lib/services/workItemsService';
import { bearer } from './fixtures/apiV1Fixtures';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// MOTIR-8722 — the RUN doors for what the dispatch prompt asks an agent to tell Motir, against a
// real Postgres: `POST /api/v1/dispatch-runs/{id}/discrepancy` (a build-through) and
// `POST /api/v1/dispatch-runs/{id}/stop` (a STOP). A hosted run's agent and an agent-instance
// run's agent hold no Motir token and `/api/mcp` refuses the run token, so the CLI posts both
// with the RUN's own credential from what the agent wrote into `$MOTIR_AGENT_REPORT`. Every
// call here is made with that credential, through the route, on a server-opened run of each
// origin; every assertion reads the rows the call left.

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
  door: 'discrepancy' | 'stop',
  runId: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  const { POST } =
    door === 'discrepancy'
      ? await import('@/app/api/v1/dispatch-runs/[id]/discrepancy/route')
      : await import('@/app/api/v1/dispatch-runs/[id]/stop/route');
  return POST(
    new Request(`http://localhost:3000/api/v1/dispatch-runs/${runId}/${door}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: runId }) },
  );
}

const comments = (card: Card) =>
  adminDb.comment.findMany({ where: { workItemId: card.id }, orderBy: { createdAt: 'asc' } });

const statusOf = async (card: Card) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).status;

const POINT = {
  planAsked: 'SENTINEL-ASKED: edit lib/foo.ts',
  built: 'SENTINEL-BUILT: edited lib/bar.ts',
  why: 'SENTINEL-WHY: lib/foo.ts does not exist',
};

describe('both doors are on the run-token list, bound to their own run, called by the CLI', () => {
  it.each([
    ['recordDispatchRunDiscrepancy', '/api/v1/dispatch-runs/{id}/discrepancy'],
    ['reportDispatchRunStop', '/api/v1/dispatch-runs/{id}/stop'],
  ])('%s', (operationId, path) => {
    expect(RUN_TOKEN_ROUTES).toContainEqual({
      operationId,
      method: 'POST',
      path,
      binding: 'own_run',
      calledBy: 'cli',
    });
  });
});

describe('a BUILD-THROUGH, recorded by the run on the leg and the card', () => {
  it.each(['hosted', 'instance'] as const)(
    'a %s run records its points: one comment, one finding on THIS run’s leg, one per leg',
    async (origin) => {
      const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
      const card = await inProgressCard(fx);
      const { runId, headers } = await serverRunOver(fx, card, origin);

      const res = await post('discrepancy', runId, headers, { key: card.key, points: [POINT] });
      expect(res.status).toBe(200);
      const ack = (await res.json()) as { commentId: string; recorded: boolean };
      expect(ack.recorded).toBe(true);

      const written = await comments(card);
      expect(written).toHaveLength(1);
      expect(written[0]!.id).toBe(ack.commentId);
      for (const sentinel of Object.values(POINT)) {
        expect(written[0]!.bodyMd).toContain(sentinel);
      }
      const events = await adminDb.dispatchRunEvent.findMany({
        where: { dispatchRunId: runId, kind: 'discrepancy_recorded' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.data).toMatchObject({ commentId: ack.commentId, pointCount: 1 });

      // ONE record per leg — the agent's own call, or a retry, writes nothing more.
      const again = await post('discrepancy', runId, headers, { key: card.key, points: [POINT] });
      expect(again.status).toBe(409);
      expect(((await again.json()) as { code: string }).code).toBe('DISCREPANCY_ALREADY_RECORDED');
      expect(await comments(card)).toHaveLength(1);
    },
  );

  it('a run token naming ANOTHER run is refused 403, and nothing is written', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await inProgressCard(fx);
    const other = await inProgressCard(fx, 'Other');
    const mine = await serverRunOver(fx, card, 'hosted');
    const theirs = await serverRunOver(fx, other, 'hosted');

    const res = await post('discrepancy', theirs.runId, mine.headers, {
      key: other.key,
      points: [POINT],
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('DISPATCH_RUN_TOKEN_OUT_OF_SCOPE');
    expect(await comments(other)).toHaveLength(0);
  });

  it('a card that is not a leg of the run is refused, and nothing is written', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await inProgressCard(fx);
    const elsewhere = await inProgressCard(fx, 'Not on this run');
    const { runId, headers } = await serverRunOver(fx, card, 'hosted');

    const res = await post('discrepancy', runId, headers, { key: elsewhere.key, points: [POINT] });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('UNKNOWN_DISPATCH_RUN_CARD');
    expect(await comments(elsewhere)).toHaveLength(0);
  });

  it('no points, or a field over 2000 characters, is a 422 that writes nothing', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await inProgressCard(fx);
    const { runId, headers } = await serverRunOver(fx, card, 'hosted');

    for (const points of [[], [{ ...POINT, why: 'w'.repeat(2001) }]]) {
      const res = await post('discrepancy', runId, headers, { key: card.key, points });
      expect(res.status).toBe(422);
    }
    expect(await comments(card)).toHaveLength(0);
  });

  it('DECISIONS ride the same record (MOTIR-10000): alone, counted, and bounded', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await inProgressCard(fx);
    const { runId, headers } = await serverRunOver(fx, card, 'hosted');
    const DECISION = {
      planSaid: 'SENTINEL-SAID: nothing',
      chose: 'SENTINEL-CHOSE: a partial unique index',
      why: 'SENTINEL-WHY: the schema enforces every other invariant in the database',
      alternatives: 'SENTINEL-ALT: an application-level check',
    };

    for (const body of [
      { key: card.key, decisions: [{ ...DECISION, chose: '' }] },
      { key: card.key, decisions: [{ ...DECISION, extra: 'x' }] },
      { key: card.key, points: [], decisions: [] },
      { key: card.key },
    ]) {
      const res = await post('discrepancy', runId, headers, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(await comments(card)).toHaveLength(0);

    const res = await post('discrepancy', runId, headers, { key: card.key, decisions: [DECISION] });
    expect(res.status).toBe(200);
    const [written] = await comments(card);
    for (const sentinel of Object.values(DECISION)) expect(written!.bodyMd).toContain(sentinel);
    const events = await adminDb.dispatchRunEvent.findMany({
      where: { dispatchRunId: runId, kind: 'discrepancy_recorded' },
    });
    expect(events[0]!.data).toMatchObject({ pointCount: 1, decisionCount: 1 });
  });
});

const FINDING = 'SENTINEL-FINDING: the table the card names does not exist (prisma/schema.prisma)';
const BRIEF = {
  outcome: 'SENTINEL-OUTCOME',
  behaviour: 'SENTINEL-BEHAVIOUR',
  scopeEdge: '',
  acceptance: 'SENTINEL-ACCEPTANCE',
};

describe('a STOP, written by the run: the comment, Planning, and the brief kept on the card', () => {
  it.each(['hosted', 'instance'] as const)(
    'a %s run that re-plans leaves the card commented, at Planning, with the brief and the unsubmitted re-plan said',
    async (origin) => {
      const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
      const card = await inProgressCard(fx);
      const { runId, headers } = await serverRunOver(fx, card, origin);

      const res = await post('stop', runId, headers, {
        key: card.key,
        comment: FINDING,
        toPlanning: true,
        requirement: BRIEF,
      });
      expect(res.status).toBe(200);
      const ack = (await res.json()) as { commentId: string; movedToPlanning: boolean };
      expect(ack.movedToPlanning).toBe(true);
      expect(await statusOf(card)).toBe('planning');

      const written = await comments(card);
      expect(written).toHaveLength(1);
      expect(written[0]!.id).toBe(ack.commentId);
      expect(written[0]!.bodyMd).toContain(FINDING);
      expect(written[0]!.bodyMd).toContain('re-plan was NOT submitted');
      for (const value of ['SENTINEL-OUTCOME', 'SENTINEL-BEHAVIOUR', 'SENTINEL-ACCEPTANCE']) {
        expect(written[0]!.bodyMd).toContain(value);
      }
      // No plan was started: the run's credential cannot plan.
      expect(await adminDb.plan.count({ where: { projectId: fx.projectId } })).toBe(0);
    },
  );

  it('a run launched without re-planning comments the card and leaves it In Progress', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await inProgressCard(fx);
    const { runId, headers } = await serverRunOver(fx, card, 'hosted');

    const res = await post('stop', runId, headers, {
      key: card.key,
      comment: FINDING,
      toPlanning: false,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ movedToPlanning: false });
    expect(await statusOf(card)).toBe('in_progress');
    const written = await comments(card);
    expect(written).toHaveLength(1);
    expect(written[0]!.bodyMd).toBe(FINDING);
  });

  it('a refused move to Planning writes nothing — not even the comment', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await inProgressCard(fx);
    // A project whose workflow has no edge into Planning (the project may customise it).
    const planning = await adminDb.workflowStatus.findFirstOrThrow({
      where: { projectId: fx.projectId, key: 'planning' },
    });
    await adminDb.workflowTransition.deleteMany({
      where: { projectId: fx.projectId, toStatusId: planning.id },
    });
    const { runId, headers } = await serverRunOver(fx, card, 'hosted');

    const res = await post('stop', runId, headers, {
      key: card.key,
      comment: FINDING,
      toPlanning: true,
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('ILLEGAL_TRANSITION');
    expect(await statusOf(card)).toBe('in_progress');
    expect(await comments(card)).toHaveLength(0);
  });

  it('a run token naming another run, or a card its run does not hold, is refused and writes nothing', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await inProgressCard(fx);
    const other = await inProgressCard(fx, 'Other');
    const mine = await serverRunOver(fx, card, 'hosted');
    const theirs = await serverRunOver(fx, other, 'hosted');

    const crossRun = await post('stop', theirs.runId, mine.headers, {
      key: other.key,
      comment: FINDING,
      toPlanning: true,
    });
    expect(crossRun.status).toBe(403);
    // The run token's `run_cards` binding refuses a card outside its run.
    const crossCard = await post('stop', mine.runId, mine.headers, {
      key: other.key,
      comment: FINDING,
      toPlanning: true,
    });
    expect(crossCard.status).toBe(403);
    expect(await statusOf(other)).toBe('in_progress');
    expect(await comments(other)).toHaveLength(0);
  });

  it('an empty finding is a 422 that writes nothing', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await inProgressCard(fx);
    const { runId, headers } = await serverRunOver(fx, card, 'hosted');

    const res = await post('stop', runId, headers, {
      key: card.key,
      comment: '  ',
      toPlanning: true,
    });
    expect(res.status).toBe(422);
    expect(await statusOf(card)).toBe('in_progress');
    expect(await comments(card)).toHaveLength(0);
  });
});

describe('composeStopComment', () => {
  it('without Planning is the finding alone', () => {
    expect(composeStopComment({ comment: ' x ', toPlanning: false, requirement: null })).toBe('x');
  });

  it('with Planning and no brief says the re-plan was not submitted and there is no brief', () => {
    const body = composeStopComment({ comment: 'x', toPlanning: true, requirement: null });
    expect(body).toContain('re-plan was NOT submitted');
    expect(body).toContain('The agent wrote no brief');
  });

  it('renders the brief in the canonical field order, an empty field as an answer', () => {
    const body = composeStopComment({
      comment: 'x',
      toPlanning: true,
      requirement: { acceptance: 'A', outcome: 'O', scopeEdge: '' },
    });
    expect(body.indexOf('**Outcome:** O')).toBeGreaterThan(-1);
    expect(body.indexOf('**Scope edge:** _none_')).toBeGreaterThan(body.indexOf('**Outcome:**'));
    expect(body.indexOf('**Acceptance:** A')).toBeGreaterThan(body.indexOf('**Scope edge:**'));
    expect(body).not.toContain('Behaviour');
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { isRunAlive } from '@/lib/runs/runLiveness';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { scopeClaimService } from '@/lib/services/scopeClaimService';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { dispatchRunSweepService } from '@/lib/services/dispatchRunSweepService';
import { usersService } from '@/lib/services/usersService';
import { workItemContinueService } from '@/lib/services/workItemContinueService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { startMcpHttpServer, type McpTestServer } from '../helpers/mcpHttpServer';
import { randomToken } from '../helpers/random';
import { setStatus } from '../helpers/repairFixtures';
import { warmPool } from '../helpers/warmPool';

// THE STORY GATE (Story MOTIR-6526 · MOTIR-6537) — the heartbeat → lapse → died →
// continue chain, ASSEMBLED, over real Postgres and a real socket.
//
// Each card tested its own half: the liveness card the rule and the sweep, the
// claim card its refusals, the prompt card its CONTINUE block. What none of them
// could test alone is the chain a person relies on — a run goes quiet, every part
// of Motir agrees it is dead at the SAME instant, exactly one person carries it on,
// and nothing moves the card. Every request below goes over HTTP to the real
// `/api/v1` route modules (`startMcpHttpServer({ v1Routes: true })`), with each
// person's own project-bound token, exactly as the CLI sends it.
//
// Beside this file: `runDiedContinueCliLane.test.ts` (the CLI's command against
// the same server) and `tests/runs/runDiedContracts.test.ts` (the three guards).

let server: McpTestServer;

beforeAll(async () => {
  server = await startMcpHttpServer({ v1Routes: true });
});

afterAll(async () => {
  await server.close();
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

interface Person {
  user: User;
  ctx: ServiceContext;
  token: string;
}

async function tokenFor(fx: WorkItemFixture, userId: string): Promise<string> {
  const { token } = await apiTokensService.create(userId, fx.workspaceId, {
    label: `story-gate-${randomToken()}`,
    projectId: fx.projectId,
    // The CLI's grant, less the lesson store's (not grantable where lessons are
    // off, and nothing in this chain reads a lesson).
    // …and less `repository:manage` (MOTIR-11038): a member's role cannot confer it,
    // and nothing in this chain creates a repository.
    permissions: CLI_TOKEN_GRANT.filter(
      (p) => !p.startsWith('lesson:') && p !== 'repository:manage',
    ),
  });
  return token;
}

async function member(fx: WorkItemFixture, name: string): Promise<Person> {
  const user = await usersService.createUser({
    email: `${name.toLowerCase().replace(/\W/g, '')}+${randomToken()}@example.com`,
    password: 'hunter2hunter2',
    name,
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return {
    user,
    ctx: { userId: user.id, workspaceId: fx.workspaceId },
    token: await tokenFor(fx, user.id),
  };
}

/** One v1 call over the socket; returns the status and the parsed body. */
async function v1(
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(`${server.url}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

/** An In Progress task assigned to `owner` — where a card sits once a run claimed it. */
async function inProgressCard(fx: WorkItemFixture, ownerId: string) {
  const card = await createTestWorkItem(fx, { kind: 'task', title: 'a card a run is working' });
  await setStatus(card.id, 'in_progress');
  await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: ownerId } });
  return card;
}

/** A local run over `key`, opened, annotated and heartbeated over HTTP as the reporter does. */
async function startRun(token: string, fx: WorkItemFixture, key: string, branch: string) {
  const opened = await v1(token, 'POST', '/dispatch-runs', {
    projectKey: fx.projectIdentifier,
    command: 'run',
    cards: [{ key, disposition: 'queued' }],
  });
  expect(opened.status).toBe(201);
  const runId = (opened.body!['run'] as { id: string }).id;
  const appended = await v1(token, 'POST', `/dispatch-runs/${runId}/events`, {
    events: [
      { kind: 'checkout_ready', workItemKey: key, disposition: 'running', data: { branch } },
    ],
  });
  expect(appended.status).toBe(200);
  expect((await v1(token, 'POST', `/dispatch-runs/${runId}/heartbeat`)).status).toBe(204);
  return runId;
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const lapse = (runId: string, minutesAgo: number) =>
  adminDb.dispatchRun.update({
    where: { id: runId },
    data: { lastHeartbeatAt: new Date(Date.now() - minutesAgo * 60_000) },
  });

describe('the seam, end to end on the real store', () => {
  it('alive for claim and view → dead for both at once → swept abandoned → continued on the same branch the prompt names; status never moves', async () => {
    const fx = await makeWorkItemFixture();
    const ada: Person = { user: fx.owner, ctx: fx.ctx, token: await tokenFor(fx, fx.ownerId) };
    const ben = await member(fx, 'Ben Builder');
    const card = await inProgressCard(fx, ada.user.id);
    const branch = `subtask/${card.identifier}-work`;

    // ── ALIVE: the heartbeat route's write is what both readers see.
    const runId = await startRun(ada.token, fx, card.identifier, branch);
    expect((await workItemContinueService.getContinueView(card.id, ada.ctx)).state).toBe('alive');
    const early = await v1(ben.token, 'POST', `/work-items/${card.identifier}/continue`);
    expect(early.body).toMatchObject({ outcome: 'not_continuable', reason: 'run_alive' });
    expect(await statusOf(card.id)).toBe('in_progress');

    // ── DEAD, for both, at the same instant — no sweep has run.
    await lapse(runId, 6);
    const now = new Date();
    const view = await workItemContinueService.getContinueView(card.id, ada.ctx, now);
    expect(view).toMatchObject({ state: 'died', reason: 'lapsed', branch, refusal: null });
    const row = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe('running');
    expect(isRunAlive(row, now)).toBe(false);

    // ── SWEPT: the lapse reap closes the row `abandoned`; the view still says died.
    const swept = await dispatchRunSweepService.reapLapsed(new Date());
    expect(swept.runsReaped).toBeGreaterThanOrEqual(1);
    expect(await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      status: 'timed_out',
      stopReason: 'abandoned',
    });
    expect((await workItemContinueService.getContinueView(card.id, ada.ctx)).state).toBe('died');
    expect(await statusOf(card.id)).toBe('in_progress');

    // ── CONTINUED: Ben's claim opens the `continue` run on the dead run's branch.
    const claimed = await v1(ben.token, 'POST', `/work-items/${card.identifier}/continue`);
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({ outcome: 'claimed', branch, mode: 'card' });
    const continueRun = await adminDb.dispatchRun.findUniqueOrThrow({
      where: { id: claimed.body!['runId'] as string },
    });
    expect(continueRun).toMatchObject({ command: 'continue', status: 'running' });
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.status).toBe('in_progress');
    expect(after.assigneeId).toBe(ben.user.id);
    expect((await workItemContinueService.getContinueView(card.id, ada.ctx)).state).toBe(
      'continuing',
    );

    // ── THE PROMPT names the branch the claim returned — over the route and the service.
    const prompt = await v1(
      ben.token,
      'GET',
      `/work-items/${card.identifier}/dispatch-prompt?continueFrom=${runId}`,
    );
    expect(prompt.status).toBe(200);
    expect(String(prompt.body!['prompt'])).toContain(branch);
    const direct = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      ben.ctx,
      { continueFrom: runId },
    );
    expect(direct.prompt).toContain(`CONTINUE`);
    expect(direct.prompt).toContain(branch);
    expect(await statusOf(card.id)).toBe('in_progress');
  });
});

describe('the claim under real concurrency', () => {
  it('two claims over two sockets on one card: one `claimed`, one `taken` naming the winner', async () => {
    const fx = await makeWorkItemFixture();
    const ada = await tokenFor(fx, fx.ownerId);
    const card = await inProgressCard(fx, fx.ownerId);
    const runId = await startRun(ada, fx, card.identifier, `subtask/${card.identifier}-race`);
    await lapse(runId, 6);
    const a = await member(fx, 'Racer A');
    const b = await member(fx, 'Racer B');

    // A cold pool would hand both racers one connection and pass without the lock.
    await warmPool(4);
    const results = await Promise.all(
      [a, b].map((p) => v1(p.token, 'POST', `/work-items/${card.identifier}/continue`)),
    );

    const outcomes = results.map((r) => r.body!['outcome']).sort();
    expect(outcomes).toEqual(['claimed', 'taken']);
    const winner = results.find((r) => r.body!['outcome'] === 'claimed')!.body!;
    const loser = results.find((r) => r.body!['outcome'] === 'taken')!.body!;
    expect(loser['runId']).toBe(winner['runId']);
    expect(loser['branch']).toBeNull();
    expect(
      await adminDb.dispatchRun.count({
        where: { command: 'continue', cards: { some: { workItemId: card.id } } },
      }),
    ).toBe(1);
    expect(await statusOf(card.id)).toBe('in_progress');
  });
});

describe('the populations the rule keeps apart', () => {
  async function openLocal(fx: WorkItemFixture) {
    const card = await inProgressCard(fx, fx.ownerId);
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: card.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    return { card, runId: run.id };
  }

  const HOUR = 60 * 60_000;

  it('a HOSTED open run is never closed by the liveness sweep, however long silent', async () => {
    const fx = await makeWorkItemFixture();
    const { card, runId } = await openLocal(fx);
    await adminDb.dispatchRun.update({
      where: { id: runId },
      data: { origin: 'hosted', lastHeartbeatAt: new Date(Date.now() - 2 * HOUR) },
    });

    await dispatchRunSweepService.reapLapsed(new Date());

    const row = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe('running');
    expect(isRunAlive(row)).toBe(true);
    expect((await workItemContinueService.getContinueView(card.id, fx.ctx)).state).toBe('alive');
  });

  it('a LEGACY local run (no heartbeat ever) under 12 h is alive — neither reap closes it', async () => {
    const fx = await makeWorkItemFixture();
    const { card, runId } = await openLocal(fx);
    await adminDb.dispatchRun.update({
      where: { id: runId },
      data: { startedAt: new Date(Date.now() - 11 * HOUR), lastHeartbeatAt: null },
    });

    await dispatchRunSweepService.reapLapsed(new Date());
    await dispatchRunSweepService.sweep(new Date());

    const row = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe('running');
    expect(isRunAlive(row)).toBe(true);
    expect((await workItemContinueService.getContinueView(card.id, fx.ctx)).state).toBe('alive');
  });

  it('a HEARTBEATING run of any age is alive — the 12-hour age reap skips it', async () => {
    const fx = await makeWorkItemFixture();
    const { card, runId } = await openLocal(fx);
    await adminDb.dispatchRun.update({
      where: { id: runId },
      data: { startedAt: new Date(Date.now() - 30 * HOUR), lastHeartbeatAt: new Date() },
    });

    await dispatchRunSweepService.reapLapsed(new Date());
    await dispatchRunSweepService.sweep(new Date());

    const row = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe('running');
    expect(isRunAlive(row)).toBe(true);
    expect((await workItemContinueService.getContinueView(card.id, fx.ctx)).state).toBe('alive');
    expect(await statusOf(card.id)).toBe('in_progress');
  });
});

describe('the scope claim a resumed parent run makes (`exceptLanded`)', () => {
  it('a landed child refuses a fresh claim, and is left out — untouched — of a resume', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Refunds' });
    const landed = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'landed',
      parentId: story.id,
    });
    const fresh = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'never started',
      parentId: story.id,
    });
    await setStatus(landed.id, 'implemented');
    await setStatus(fresh.id, 'todo');
    // Where a dead parent run leaves its container once the continue claim took it:
    // In Progress, and the continuer's.
    await setStatus(story.id, 'in_progress');
    await adminDb.workItem.update({ where: { id: story.id }, data: { assigneeId: fx.ownerId } });
    const input = {
      kind: 'work_item' as const,
      projectId: fx.projectId,
      identifier: story.identifier,
    };

    const freshBefore = await statusOf(fresh.id);

    // A FRESH run is refused, exactly as before this story — nothing moved.
    const refused = await scopeClaimService.claimScope(input, fx.ctx);
    expect(refused).toMatchObject({ claimed: false, outcome: 'not_claimable' });
    expect(await statusOf(fresh.id)).toBe(freshBefore);

    // A RESUME no longer trips on the landed child: the container is already the
    // continuer's, so the answer is `mine` — the one a resumed scoped run proceeds
    // on — and the landed child is where it was.
    const resumed = await scopeClaimService.claimScope({ ...input, exceptLanded: true }, fx.ctx);
    expect(resumed.outcome).toBe('mine');
    expect(resumed.offender?.key).toBe(story.identifier);
    expect(await statusOf(landed.id)).toBe('implemented');
  });
});

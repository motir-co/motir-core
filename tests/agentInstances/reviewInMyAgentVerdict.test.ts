import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { db } from '@/lib/db';
import { ownDeliverySetVersion } from '@/lib/agentReview/ownVersion';
import { RUN_TOKEN_ROUTES } from '@/lib/hostedRuns/runTokenRoutes';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { reviewInMyAgentService } from '@/lib/services/reviewInMyAgentService';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { bearer } from '../fixtures/apiV1Fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';
import { randomToken } from '../helpers/random';
import { fleet, fx, seedRepo, setUpHarness, tearDownHarness } from './_harness';

// *REVIEW IN MY AGENT* — the verdict half (Story MOTIR-11941 · MOTIR-11953;
// `approval-gates.md` §12.18). A review in the person's own agent answers through the
// USER-TOKEN verdict door with its RUN token, as the person who started it. Over the real
// services, database and bearer path:
//   - the door admits exactly a RUNNING own-agent review run's token, for its own card;
//   - it refuses a hosted review's token, an ended review's and a build run's
//     (`RUN_TOKEN_NOT_ALLOWED`), and a card that is not the run's leg (the run-scope 403),
//     storing nothing;
//   - the hosted door (`…/agent-review`) refuses the own-agent token, while the prompt read
//     (`…/review-prompt`) still answers it;
//   - the run read names what the run reviews (`review`).

const verdictRoute = () => import('@/app/api/v1/work-items/[key]/review-verdict/route');
const agentReviewRoute = () => import('@/app/api/v1/work-items/[key]/agent-review/route');
const promptRoute = () => import('@/app/api/v1/work-items/[key]/review-prompt/route');
const runRoute = () => import('@/app/api/v1/dispatch-runs/[id]/route');

const BASE = 'http://localhost:3000/api/v1';
type Handler = (
  req: Request,
  args: { params: Promise<Record<string, string>> },
) => Promise<Response>;

async function call(
  loader: () => Promise<Record<string, unknown>>,
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string>,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Response> {
  const handler = (await loader())[method] as Handler;
  return handler(
    new Request(`${BASE}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve(params) },
  );
}

const codeOf = async (res: Response) =>
  ((await res.clone().json()) as { code?: string }).code ?? null;

beforeEach(async () => {
  await setUpHarness();
  await truncateJobRuns();
  resetRateLimitStore();
  vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', 'm'.repeat(48));
  fleet.setExecResponder((command) => ({
    exitCode: 0,
    stdout: command.includes('signin') ? '{"profile":"claude","state":"signed_in"}\n' : '',
    stderr: '',
  }));
  await seedRepo('acme', 'web');
});
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** An item In review, delivered by one green pull request; Review on raises its gate. */
async function reviewable(reviewOn: boolean) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: `review me ${randomToken(4)}` },
    fx.ctx,
  );
  await setStatus(item.id, 'in_review');
  const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
  await deliveredPr(fx, item.id, repo, {
    headRef: `subtask/${item.identifier}`,
    checks: { Vitest: 'success' },
  });
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { reviewAgentEnabled: reviewOn },
  });
  const version = (await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    ownDeliverySetVersion(item, fx.workspaceId, tx),
  ))!;
  const gate = reviewOn
    ? await adminDb.approvalGate.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: item.id,
          kind: 'agent_review',
          subjectId: item.id,
          subjectVersion: version,
          state: 'awaiting',
        },
      })
    : null;
  return { item, version, gate };
}

async function tokenFor(runId: string): Promise<Record<string, string>> {
  const { token } = await runCredentialService.mintRunCredential({
    dispatchRunId: runId,
    dispatcherUserId: fx.ownerId,
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
  return bearer(token);
}

/** A review started through *Review in my agent*, and its run's token. */
async function ownReview(reviewOn: boolean) {
  const subject = await reviewable(reviewOn);
  const agentId = (
    await lifecycle.create(
      fx.projectIdentifier,
      { name: `a-${randomToken(4)}`, profileId: 'claude' },
      fx.ctx,
    )
  ).id;
  const started = await reviewInMyAgentService.start(
    subject.item.identifier,
    { agentInstanceId: agentId },
    fx.ctx,
  );
  return {
    ...subject,
    runId: started.dispatchRunId,
    headers: await tokenFor(started.dispatchRunId),
  };
}

const verdict = (version: string, over: Record<string, unknown> = {}) => ({
  verdict: 'approved',
  subjectVersion: version,
  summaryMd: 'Meets the card.',
  findingsMd: null,
  checklist: [],
  harness: 'Claude Code',
  model: 'claude-self-report',
  ...over,
});

const postVerdict = (key: string, headers: Record<string, string>, body: unknown) =>
  call(verdictRoute, 'POST', `/work-items/${key}/review-verdict`, { key }, headers, body);

const records = (workItemId: string) =>
  adminDb.reviewVerdictRecord.findMany({ where: { workItemId } });

describe('the verdict door admits an own-agent review run’s token, for its own card', () => {
  it('Review on: decides the awaiting gate as the person, with the agent’s harness and model', async () => {
    const { item, gate, version, headers, runId } = await ownReview(true);
    const res = await postVerdict(item.identifier, headers, verdict(version));
    expect(res.status, String(await codeOf(res))).toBe(200);
    // The run that answered is closing itself: its own verdict does not cancel it.
    const run = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('running');
    expect(await res.json()).toMatchObject({
      key: item.identifier,
      outcome: 'decided',
      verdict: 'approved',
      subjectVersion: version,
      gateId: gate!.id,
    });
    const after = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate!.id } });
    expect(after.state).toBe('approved');
    const [row] = await records(item.id);
    expect(row).toMatchObject({
      harness: 'Claude Code',
      model: 'claude-self-report',
      submittedById: fx.ownerId,
    });
  });

  it('Review off: the verdict is recorded on the item, deciding no gate', async () => {
    const { item, version, headers } = await ownReview(false);
    const res = await postVerdict(
      item.identifier,
      headers,
      verdict(version, { verdict: 'changes_requested', findingsMd: '- breaks AC1' }),
    );
    expect(res.status, String(await codeOf(res))).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'recorded', gateId: null });
    expect(await records(item.id)).toHaveLength(1);
  });

  it('the run read names what the run reviews; a build run reads `review: null`', async () => {
    const { runId, gate, version, headers } = await ownReview(true);
    const res = await call(runRoute, 'GET', `/dispatch-runs/${runId}`, { id: runId }, headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      command: 'review',
      origin: 'instance',
      review: { gateId: gate!.id, subjectVersion: version },
    });
  });

  it('the prompt read still answers the own-agent token; the hosted door refuses it', async () => {
    const { item, version, headers } = await ownReview(true);
    const prompt = await call(
      promptRoute,
      'GET',
      `/work-items/${item.identifier}/review-prompt`,
      { key: item.identifier },
      headers,
    );
    expect(prompt.status, String(await codeOf(prompt))).toBe(200);
    expect(await prompt.json()).toMatchObject({ subjectVersion: version });

    const hosted = await call(
      agentReviewRoute,
      'POST',
      `/work-items/${item.identifier}/agent-review`,
      { key: item.identifier },
      headers,
      { subjectVersion: version, verdict: 'pass', summaryMd: 'ok', findingsMd: null },
    );
    expect(hosted.status).toBe(403);
    expect(await records(item.id)).toEqual([]);
  });
});

describe('every other run token is refused, storing nothing', () => {
  it('a card that is not the run’s leg: the run-scope 403, before the door is reached', async () => {
    const { headers } = await ownReview(true);
    const other = await reviewable(true);
    const res = await postVerdict(other.item.identifier, headers, verdict(other.version));
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('DISPATCH_RUN_TOKEN_OUT_OF_SCOPE');
    expect(await records(other.item.id)).toEqual([]);
  });

  it('an ended own-agent review', async () => {
    const { item, version, runId, headers } = await ownReview(true);
    await adminDb.dispatchRun.update({
      where: { id: runId },
      data: { status: 'succeeded', endedAt: new Date() },
    });
    const res = await postVerdict(item.identifier, headers, verdict(version));
    expect([401, 403]).toContain(res.status);
    expect(await records(item.id)).toEqual([]);
  });

  it('a hosted review run’s token, and a build run’s', async () => {
    const { item, version, gate } = await reviewable(true);
    for (const shape of [
      { command: 'review' as const, origin: 'hosted' as const },
      { command: 'run' as const, origin: 'instance' as const },
    ]) {
      const run = await adminDb.dispatchRun.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          ...shape,
          idempotencyKey: `t-${gate!.id}-${shape.command}-${shape.origin}`,
          createdById: fx.ownerId,
          cards: {
            create: {
              workspaceId: fx.workspaceId,
              workItemId: item.id,
              workItemKey: item.identifier,
              position: 0,
            },
          },
        },
      });
      const res = await postVerdict(item.identifier, await tokenFor(run.id), verdict(version));
      expect(res.status, `${shape.origin} ${shape.command}`).toBe(403);
      expect(await codeOf(res)).toBe('RUN_TOKEN_NOT_ALLOWED');
    }
    expect(await records(item.id)).toEqual([]);
  });
});

describe('the run-token route table names the door', () => {
  it('lists POST …/review-verdict, bound to the run’s cards and called by the CLI', () => {
    expect(
      RUN_TOKEN_ROUTES.find((r) => r.operationId === 'submitWorkItemReviewVerdict'),
    ).toMatchObject({
      method: 'POST',
      path: '/api/v1/work-items/{key}/review-verdict',
      binding: 'run_cards',
      calledBy: 'cli',
    });
  });
});

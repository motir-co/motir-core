import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { workItemRepairClaimSchema } from '@/lib/api/v1/workLoop/schema';
import { findV1Operation } from '@/lib/api/v1/openapi/registry';
import { createTestWorkItem } from '../../fixtures';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { connectRepairRepo, deliveredPr, setStatus } from '../../helpers/repairFixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// POST /api/v1/work-items/{key}/repair (Story MOTIR-5460 · MOTIR-5464) — the
// repair claim `motir fix <key>` makes.
//
// The route's own contract: the resource PARSES against its declared schema, a
// refusal is a 200 rather than an error status, the permission is the one the
// operation declares, and a foreign key is refused exactly as the keyed claim
// refuses it. The lock and the refusal matrix are asserted one layer down, in
// `tests/ready/claimWorkItemRepair.test.ts`.

const BASE = 'http://localhost:3000/api/v1/work-items';

async function repair(key: string, caller: { headers: Record<string, string> }): Promise<Response> {
  const { POST } = await import('@/app/api/v1/work-items/[key]/repair/route');
  return POST(
    new Request(`${BASE}/${encodeURIComponent(key)}/repair`, {
      method: 'POST',
      headers: caller.headers,
    }),
    { params: Promise.resolve({ key }) },
  );
}

async function redCard(fixture: WorkItemFixture, title: string) {
  const card = await createTestWorkItem(fixture, { kind: 'task', title });
  await setStatus(card.id, 'implemented');
  const repo = await connectRepairRepo(fixture, 'web');
  await deliveredPr(fixture, card.id, repo, {
    headRef: 'subtask/red',
    checks: { Vitest: 'failure' },
  });
  return card;
}

describe('POST /api/v1/work-items/{key}/repair', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
  });

  it('claims a red implemented card and the body PARSES against the declared schema', async () => {
    const card = await redCard(caller.fixture, 'Fix me');

    const res = await repair(card.identifier.toLowerCase(), caller);

    expect(res.status).toBe(200);
    const parsed = workItemRepairClaimSchema.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    expect(parsed.data).toMatchObject({
      key: card.identifier,
      outcome: 'claimed',
      reason: null,
      holder: { id: caller.fixture.ownerId },
    });
    expect(parsed.data?.runId).toEqual(expect.any(String));
    expect(parsed.data?.pullRequests).toEqual([
      expect.objectContaining({
        repo: 'acme/web',
        headRef: 'subtask/red',
        ci: 'failing',
        conflicted: false,
        outOfDate: false,
      }),
    ]);
  });

  it('an EJECTED card whose own checks are green is claimed, and `queueExit` PARSES (MOTIR-5719)', async () => {
    const card = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Ejected' });
    await setStatus(card.id, 'implemented');
    const repo = await connectRepairRepo(caller.fixture, 'web');
    const pr = await deliveredPr(caller.fixture, card.id, repo, {
      headRef: 'subtask/ejected',
      checks: { Vitest: 'success' },
    });
    await adminDb.githubPullRequestQueueExit.create({
      data: {
        pullRequestId: pr.id,
        deliveryId: 'guid-route-ejected',
        rawReason: 'MERGE_CONFLICT',
        disposition: 'failure',
        headSha: 'c'.repeat(40),
        exitedAt: new Date('2026-09-18T10:00:00.000Z'),
      },
    });

    const res = await repair(card.identifier, caller);

    expect(res.status).toBe(200);
    const parsed = workItemRepairClaimSchema.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    expect(parsed.data?.outcome).toBe('claimed');
    expect(parsed.data?.pullRequests).toEqual([
      expect.objectContaining({
        headRef: 'subtask/ejected',
        ci: 'passing',
        queueExit: {
          rawReason: 'MERGE_CONFLICT',
          exitedAt: '2026-09-18T10:00:00.000Z',
          headSha: 'c'.repeat(40),
          failingCheckName: null,
          failingCheckUrl: null,
        },
      }),
    ]);
  });

  it('a GREEN member behind or conflicting with its base says so on the wire, and PARSES (Bug MOTIR-12095)', async () => {
    const card = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Stale base' });
    await setStatus(card.id, 'implemented');
    const repo = await connectRepairRepo(caller.fixture, 'web');
    const head = 'c'.repeat(40);
    const behind = await deliveredPr(caller.fixture, card.id, repo, {
      headRef: 'subtask/behind',
      checks: { Vitest: 'success' },
    });
    const conflicted = await deliveredPr(caller.fixture, card.id, repo, {
      headRef: 'subtask/conflicted',
      checks: { Vitest: 'success' },
    });
    await adminDb.githubPullRequest.update({
      where: { id: behind.id },
      data: { mergeableState: 'behind', mergeableStateHeadSha: head },
    });
    await adminDb.githubPullRequest.update({
      where: { id: conflicted.id },
      data: { mergeableState: 'dirty', mergeableStateHeadSha: head },
    });

    const res = await repair(card.identifier, caller);

    expect(res.status).toBe(200);
    const parsed = workItemRepairClaimSchema.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    expect(parsed.data?.outcome).toBe('claimed');
    const byRef = Object.fromEntries(
      (parsed.data?.pullRequests ?? []).map((pr) => [
        pr.headRef,
        {
          ci: pr.ci,
          failingChecks: pr.failingChecks,
          queueExit: pr.queueExit,
          conflicted: pr.conflicted,
          outOfDate: pr.outOfDate,
        },
      ]),
    );
    expect(byRef).toEqual({
      'subtask/behind': {
        ci: 'passing',
        failingChecks: [],
        queueExit: null,
        conflicted: false,
        outOfDate: true,
      },
      'subtask/conflicted': {
        ci: 'passing',
        failingChecks: [],
        queueExit: null,
        conflicted: true,
        outOfDate: false,
      },
    });
  });

  it('a refusal is a 200 with its reason — and a card at a status no workflow defines is not_implemented, not a 404', async () => {
    // `createTestWorkItem` leaves the row at the column's legacy `open` default.
    const orphan = await createTestWorkItem(caller.fixture, {
      kind: 'task',
      title: 'Off-workflow',
    });

    const res = await repair(orphan.identifier, caller);

    expect(res.status).toBe(200);
    const parsed = workItemRepairClaimSchema.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    expect(parsed.data).toMatchObject({ outcome: 'not_repairable', reason: 'not_implemented' });
  });

  it('a second call by the same caller is `mine` at 200', async () => {
    const card = await redCard(caller.fixture, 'Resume me');
    const first = (await (await repair(card.identifier, caller)).json()) as { runId: string };

    const res = await repair(card.identifier, caller);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ outcome: 'mine', runId: first.runId });
  });

  it('an acceptance sent back with RE-RUN is claimed on the wire with its class and reason, and PARSES (MOTIR-6502)', async () => {
    // A story run whose checks are GREEN — only the standing Re-run admits it.
    const fx = caller.fixture;
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Exports list' });
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'The empty state',
      parentId: story.id,
    });
    await setStatus(child.id, 'implemented');
    await setStatus(story.id, 'in_review');
    const repo = await connectRepairRepo(fx, 'web');
    await deliveredPr(fx, story.id, repo, {
      headRef: 'parent/exports-list',
      checks: { Vitest: 'success' },
    });
    const receipt = await adminDb.acceptanceEvidence.create({
      data: { workspaceId: fx.workspaceId, workItemId: story.id, status: 'changes_requested' },
    });
    const decidedAt = new Date('2026-09-26T10:00:00Z');
    await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: story.id,
        kind: 'acceptance_result',
        subjectId: receipt.id,
        subjectVersion: 'c'.repeat(40),
        state: 'changes_requested',
        decidedById: fx.ownerId,
        decidedAt,
        decidedByLabel: 'Yue Zhu',
        decisionSource: 'ui',
        decidedUnderAuthority: 'assignee',
        noteMd: 'The empty board should say how to add the first card.',
        refusalVerdict: 'revise',
      },
    });

    const res = await repair(story.identifier, caller);

    expect(res.status).toBe(200);
    const parsed = workItemRepairClaimSchema.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    expect(parsed.data).toMatchObject({
      key: story.identifier,
      outcome: 'claimed',
      repairClass: 'acceptance_rerun',
      acceptanceRefusal: {
        reasonMd: 'The empty board should say how to add the first card.',
        decidedByLabel: 'Yue Zhu',
        decidedAt: decidedAt.toISOString(),
      },
    });
    expect(parsed.data?.pullRequests).toEqual([
      expect.objectContaining({ repo: 'acme/web', headRef: 'parent/exports-list', ci: 'passing' }),
    ]);
  });

  it('a MALFORMED key is 422', async () => {
    const res = await repair('not-a-key', caller);
    expect(res.status).toBe(422);
  });

  it('a key in ANOTHER workspace is 404, and nothing is claimed on the way', async () => {
    const other = await createV1ProjectCaller({
      workspaceName: 'Rival Co',
      identifier: 'ZZZ',
      scopes: ['read', 'work_items:write'],
    });
    const theirs = await redCard(other.fixture, 'Private');

    expect((await repair(theirs.identifier, caller)).status).toBe(404);
    await expect((await repair(theirs.identifier, other)).json()).resolves.toMatchObject({
      outcome: 'claimed',
    });
  });

  it('a token WITHOUT the declared permission is refused before anything is read', async () => {
    const readOnly = await createV1ProjectCaller({ scopes: ['read'] });
    const card = await redCard(readOnly.fixture, 'Read only');

    expect((await repair(card.identifier, readOnly)).status).toBe(403);
  });

  it('the declared operation names the permission the route enforces', () => {
    const operation = findV1Operation('POST', '/api/v1/work-items/{key}/repair');
    expect(operation?.permission).toBe('work_item:edit');
    expect(operation?.operationId).toBe('claimWorkItemRepair');
  });
});

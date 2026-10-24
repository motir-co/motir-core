import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { handlerFor, isRegisteredGateKind } from '@/lib/approvalGates/registry';
import {
  deliverySetVersion,
  pullRequestApprovalGateHandler,
} from '@/lib/approvalGates/pullRequestApprovalHandler';
import { summarizeGateSubjects } from '@/lib/approvalGates/subjectSummary';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import { expectEachHopAnnounced } from './helpers/transitionedEvents';

// THE `pull_request_approval` KIND, REGISTERED (Story MOTIR-4909 · MOTIR-5481), against a
// REAL Postgres. The handler over a card's delivery SET: approving writes `approved`, the
// decision names the exact commits, a workflow without `approved` moves nothing, and the
// queue summarises every gate of the kind in one repository read.

const HEAD_WEB = '9840d00ea1b2c3d4e5f60718293a4b5c6d7e8f90';
const HEAD_API = '1111111111111111111111111111111111111111';

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let repoSeq = 0;

/** A repository with one pull request whose latest check ran at `head`, delivered by `item`. */
async function deliver(
  item: { id: string },
  opts: { name: string; number: number; head: string; merged?: boolean },
) {
  repoSeq += 1;
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: `inst-5481-${repoSeq}`,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      installationId: installation.id,
      repoId: `repo-5481-${repoSeq}`,
      owner: 'acme',
      name: opts.name,
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number: opts.number,
      title: `Change in ${opts.name}`,
      state: opts.merged ? 'closed' : 'open',
      merged: opts.merged ?? false,
      headRef: 'parent/ACME-12-throttle',
      baseRef: 'main',
      provider: 'github',
    },
  });
  await adminDb.githubCheckRun.create({
    data: {
      pullRequestId: pr.id,
      commitSha: opts.head,
      checkName: 'Vitest',
      conclusion: 'success',
    },
  });
  await adminDb.workItemDelivery.create({
    data: {
      workspaceId: fx.workspaceId,
      workItemId: item.id,
      githubPullRequestId: pr.id,
      repoId: repo.id,
    },
  });
  return pr;
}

/** A story in review with an awaiting approve-and-merge gate over its delivery set. */
async function storyWithGate(opts: { deliveries?: boolean } = {}) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Throttle the public API' },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
  if (opts.deliveries !== false) {
    await deliver(item, { name: 'web', number: 7, head: HEAD_WEB });
    await deliver(item, { name: 'api', number: 12, head: HEAD_API });
  }
  const gate = await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind: 'pull_request_approval',
        subjectId: item.id,
      },
      tx,
    ),
  );
  return { item, gate };
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

describe('the kind is REGISTERED, carrying the full contract (MOTIR-5481)', () => {
  it('dispatches to its handler — the design gate’s floor, and `approved` as its transition', () => {
    expect(isRegisteredGateKind('pull_request_approval')).toBe(true);
    const handler = handlerFor('pull_request_approval');
    expect(handler).toBe(pullRequestApprovalGateHandler);
    expect(handler.permission).toBe('work_item:edit');
    expect(handler.statusIntent).toEqual({ key: 'approved', category: 'in_progress' });
  });

  it('routes to the assignee, and to the reporter when there is none', () => {
    const route = (assigneeId: string | null) =>
      pullRequestApprovalGateHandler.routeTo({
        item: { assigneeId, reporterId: 'reporter-1' } as WorkItem,
        ctx: fx.ctx,
        tx: undefined as never,
      });
    expect(route('assignee-1')).toBe('assignee-1');
    expect(route(null)).toBe('reporter-1');
  });
});

describe('deciding the gate', () => {
  it('APPROVE moves an in-review card to `approved` and names the exact commits approved', async () => {
    const { item, gate } = await storyWithGate();

    // The `approved` it writes is announced after the commit (Bug MOTIR-9415).
    const { result, hops } = await expectEachHopAnnounced(
      item.id,
      { workspaceId: fx.workspaceId, actorId: fx.ownerId },
      () =>
        approvalGatesService.decide(
          { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
          fx.ctx,
        ),
    );
    expect(hops).toEqual([{ fromStatusKey: 'in_review', toStatusKey: 'approved' }]);

    expect(result.gate.state).toBe('approved');
    expect(result.effect.statusWritten).toBe('approved');
    expect(result.gate.outcomeRef).toBe('approved');
    expect(await statusOf(item.id)).toBe('approved');
    // Sorted, comma-joined — `acme/api` before `acme/web` whatever the rows' order.
    expect(result.gate.subjectVersion).toBe(`acme/api#12@${HEAD_API},acme/web#7@${HEAD_WEB}`);
  });

  it('on a workflow with NO `approved` status, writes no status — never the category fallback', async () => {
    const { item, gate } = await storyWithGate();
    // A project whose admin removed `approved`: `resolveStatusKey` now falls back to the
    // `in_progress` CATEGORY and answers some other in-progress status. Writing it would
    // move an approved card back to In Progress.
    const approved = await adminDb.workflowStatus.findMany({
      where: { projectId: fx.projectId, key: 'approved' },
    });
    const ids = approved.map((s) => s.id);
    expect(ids).toHaveLength(1);
    await adminDb.workflowTransition.deleteMany({
      where: { OR: [{ fromStatusId: { in: ids } }, { toStatusId: { in: ids } }] },
    });
    await adminDb.workflowStatus.deleteMany({ where: { id: { in: ids } } });

    const result = await approvalGatesService.decide(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    expect(result.gate.state).toBe('approved');
    expect(result.effect).toEqual({
      statusWritten: null,
      statusDeferredReason: 'no_status_in_target_category',
    });
    expect(result.gate.outcomeRef).toBeNull();
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('REQUEST CHANGES records the decision and leaves the card where it is', async () => {
    const { item, gate } = await storyWithGate();

    const result = await approvalGatesService.decide(
      {
        stamp: DECIDED_WITHOUT_A_READER,
        gateId: gate.id,
        decision: 'request_changes',
        noteMd: 'Needs changes.',
        source: 'ui',
      },
      fx.ctx,
    );

    expect(result.gate.state).toBe('changes_requested');
    expect(result.effect.statusDeferredReason).toBe('request_changes_moves_nothing');
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('a card that delivers nothing has no subject, and the decision records a null version', async () => {
    const { gate } = await storyWithGate({ deliveries: false });

    const resolved = await withWorkspaceContext(fx.ctx, async (tx) => {
      const args = {
        gate,
        item: await adminDb.workItem.findUniqueOrThrow({ where: { id: gate.workItemId! } }),
        ctx: fx.ctx,
        tx,
        resolvedStatusKey: 'approved',
        refusalVerdict: null,
      };
      return {
        subject: await pullRequestApprovalGateHandler.resolveSubject(args),
        version: await pullRequestApprovalGateHandler.subjectVersion(args),
      };
    });

    expect(resolved).toEqual({ subject: null, version: null });
  });
});

describe('the set version is CANONICAL (decision 2)', () => {
  it('is identical for the same set in any row order', () => {
    const members = ['acme/web#7@aaa', 'acme/api#12@bbb', 'acme/gateway#3@ccc'];
    const expected = 'acme/api#12@bbb,acme/gateway#3@ccc,acme/web#7@aaa';
    const shuffles = [
      members,
      [...members].reverse(),
      [members[1]!, members[2]!, members[0]!],
      [members[2]!, members[0]!, members[1]!],
    ];
    for (const order of shuffles) expect(deliverySetVersion(order)).toBe(expected);
  });

  it('is null for an empty set, and for a set with a member whose head is unknown', () => {
    expect(deliverySetVersion([])).toBeNull();
    expect(deliverySetVersion(['acme/web#7@aaa', null])).toBeNull();
  });
});

describe('the Approvals queue summarises the set', () => {
  it('returns every member for each gate of the kind, in ONE repository read per call', async () => {
    const first = await storyWithGate();
    const second = await storyWithGate({ deliveries: false });
    await deliver(second.item, { name: 'gateway', number: 3, head: HEAD_WEB, merged: true });
    const spy = vi.spyOn(workItemDeliveryRepository, 'listByWorkItemsWithChecks');

    const summaries = await withWorkspaceContext(fx.ctx, (tx) =>
      summarizeGateSubjects([first.gate, second.gate], tx),
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(summaries.get(first.gate.id)).toEqual({
      kind: 'pull_request_approval',
      members: [
        { repo: 'acme/api', number: 12, headSha: HEAD_API, state: 'open' },
        { repo: 'acme/web', number: 7, headSha: HEAD_WEB, state: 'open' },
      ],
    });
    expect(summaries.get(second.gate.id)).toEqual({
      kind: 'pull_request_approval',
      members: [{ repo: 'acme/gateway', number: 3, headSha: HEAD_WEB, state: 'merged' }],
    });
  });

  it('names a CLOSED member and one no check has reported on, in canonical order however they were delivered (MOTIR-5486)', async () => {
    const { item, gate } = await storyWithGate({ deliveries: false });
    // Delivered out of canonical order: `web`, then `api`, then `admin`.
    await deliver(item, { name: 'web', number: 7, head: HEAD_WEB });
    const closed = await deliver(item, { name: 'api', number: 12, head: HEAD_API });
    const unchecked = await deliver(item, { name: 'admin', number: 2, head: HEAD_API });
    await adminDb.githubPullRequest.update({ where: { id: closed.id }, data: { state: 'closed' } });
    await adminDb.githubCheckRun.deleteMany({ where: { pullRequestId: unchecked.id } });

    const summaries = await withWorkspaceContext(fx.ctx, (tx) => summarizeGateSubjects([gate], tx));

    expect(summaries.get(gate.id)).toEqual({
      kind: 'pull_request_approval',
      members: [
        { repo: 'acme/admin', number: 2, headSha: null, state: 'open' },
        { repo: 'acme/api', number: 12, headSha: HEAD_API, state: 'closed' },
        { repo: 'acme/web', number: 7, headSha: HEAD_WEB, state: 'open' },
      ],
    });
  });

  it('a gate whose card delivers nothing summarises as NULL — the subject no longer resolves', async () => {
    const { gate } = await storyWithGate({ deliveries: false });

    const summaries = await withWorkspaceContext(fx.ctx, (tx) => summarizeGateSubjects([gate], tx));

    expect(summaries.get(gate.id)).toBeNull();
  });
});

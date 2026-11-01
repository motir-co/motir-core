import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import { getWorkItemPayload } from '@/lib/mcp/payloads/workItems';
import { NO_IN_FLIGHT_CODE_MESSAGE, renderInFlightLine } from '@/lib/mcp/inFlightCode';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';

// `get_work_item` names the card's IN-FLIGHT CODE (MOTIR-10069) — where its
// UNMERGED code lives, per repository: its own open pull request, else the
// nearest ancestor's (`inherited`, `fromKey`), plus `mergedRepos`. Before this,
// the MCP read returned only the card's OWN `deliveries`, so a child built by
// `motir run <parent>` — whose code rides its parent's pull request — read
// `deliveries: []`, "no code yet", while the hosted planner's `get_item` was
// handed the parent's branch. On real Postgres, through the real delivery rows.

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "work_item" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function addRepo(fx: WorkItemFixture, name: string): Promise<{ id: string }> {
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}` },
    create: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  return adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: `repo-${randomToken(8)}`,
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
    select: { id: true },
  });
}

let nextPrNumber = 3781;

async function addPr(
  repoId: string,
  opts: { headRef: string; merged?: boolean; draft?: boolean },
): Promise<{ id: string; number: number }> {
  const number = nextPrNumber++;
  const row = await adminDb.githubPullRequest.create({
    data: {
      repoId,
      number,
      state: opts.merged ? 'closed' : 'open',
      merged: opts.merged ?? false,
      headRef: opts.headRef,
      baseRef: 'main',
      draft: opts.draft ?? null,
      provider: 'github',
    },
    select: { id: true },
  });
  return { id: row.id, number };
}

async function deliver(fx: WorkItemFixture, workItemId: string, prId: string, repoId: string) {
  await withWorkspaceContext(fx.ctx, (tx) =>
    workItemDeliveryRepository.add(
      { workspaceId: fx.workspaceId, workItemId, githubPullRequestId: prId, repoId },
      tx,
    ),
  );
}

async function storyWithChild(fx: WorkItemFixture) {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Run the fleet on AWS' },
    fx.ctx,
  );
  const child = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', title: 'AWS adapter', parentId: story.id },
    fx.ctx,
  );
  return { story, child };
}

const textOf = (r: CallToolResult) => (r.content[0] as { text: string }).text;
function structuredOf(r: CallToolResult): Record<string, unknown> {
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  return r.structuredContent as Record<string, unknown>;
}

describe('get_work_item — inFlightCode', () => {
  it('a child with NO delivery of its own reads its parent’s open pull request as inherited, fromKey = the parent', async () => {
    const fx = await makeWorkItemFixture();
    const { story, child } = await storyWithChild(fx);
    const repo = await addRepo(fx, 'motir-core');
    const pr = await addPr(repo.id, { headRef: `parent/${story.identifier}-aws`, draft: true });
    await deliver(fx, story.id, pr.id, repo.id);

    const res = await runGetWorkItem({ key: child.identifier }, fx.ctx);
    const out = structuredOf(res);
    // The defect: the card's OWN deliveries are empty, and that alone read as "no code".
    expect(out['deliveries']).toEqual([]);
    expect(out['inFlightCode']).toEqual([
      {
        repo: 'moooon/motir-core',
        branch: `parent/${story.identifier}-aws`,
        headSha: null,
        prNumber: pr.number,
        prUrl: `https://github.com/moooon/motir-core/pull/${pr.number}`,
        draft: true,
        baseRef: 'main',
        source: 'inherited',
        fromKey: story.identifier,
      },
    ]);
    expect(out['mergedRepos']).toEqual([]);
    expect(textOf(res)).toContain(
      `In-flight code: moooon/motir-core — branch parent/${story.identifier}-aws · PR #${pr.number} (draft) · base main · inherited from ${story.identifier}`,
    );
    // The payload validates against the declared seam.
    expect(getWorkItemPayload.schema.safeParse(out).success).toBe(true);
  });

  it('a card with its OWN open pull request reads source own, with the head commit', async () => {
    const fx = await makeWorkItemFixture();
    const { story, child } = await storyWithChild(fx);
    const repo = await addRepo(fx, 'motir-core');
    const storyPr = await addPr(repo.id, { headRef: `parent/${story.identifier}-aws` });
    const ownPr = await addPr(repo.id, { headRef: `subtask/${child.identifier}-own` });
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: ownPr.id,
        commitSha: '0328041d1152db8ae77652d1618a02e57f745f17',
        checkName: 'build',
        checkSuiteId: '',
        conclusion: 'success',
      },
    });
    await deliver(fx, story.id, storyPr.id, repo.id);
    await deliver(fx, child.id, ownPr.id, repo.id);

    const res = await runGetWorkItem({ key: child.identifier }, fx.ctx);
    const out = structuredOf(res);
    // Own first: the parent's branch in the same repository does not override it.
    expect(out['inFlightCode']).toEqual([
      expect.objectContaining({
        repo: 'moooon/motir-core',
        branch: `subtask/${child.identifier}-own`,
        headSha: '0328041d1152db8ae77652d1618a02e57f745f17',
        prNumber: ownPr.number,
        source: 'own',
      }),
    ]);
    expect((out['inFlightCode'] as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      'fromKey',
    );
    expect(textOf(res)).toContain(
      `branch subtask/${child.identifier}-own @ 0328041 · PR #${ownPr.number} · base main · this item's own pull request`,
    );
  });

  it('a card whose OWN delivery merged reads it in mergedRepos, nothing in flight', async () => {
    const fx = await makeWorkItemFixture();
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Landed' },
      fx.ctx,
    );
    const repo = await addRepo(fx, 'motir-core');
    const pr = await addPr(repo.id, { headRef: 'subtask/landed', merged: true });
    await deliver(fx, card.id, pr.id, repo.id);

    const res = await runGetWorkItem({ key: card.identifier }, fx.ctx);
    const out = structuredOf(res);
    expect(out['inFlightCode']).toEqual([]);
    expect(out['mergedRepos']).toEqual(['moooon/motir-core']);
    expect(textOf(res)).toContain('Merged to default branch: moooon/motir-core');
    expect(textOf(res)).not.toContain('In-flight code:');
  });

  it('nothing delivered on the card or a parent: two empty arrays and the one empty sentence', async () => {
    const fx = await makeWorkItemFixture();
    const { child } = await storyWithChild(fx);

    const res = await runGetWorkItem({ key: child.identifier }, fx.ctx);
    const out = structuredOf(res);
    expect(out['inFlightCode']).toEqual([]);
    expect(out['mergedRepos']).toEqual([]);
    expect(textOf(res)).toContain(NO_IN_FLIGHT_CODE_MESSAGE);
  });

  it('is the SAME answer the hosted planner’s get_item is handed for the same card', async () => {
    const fx = await makeWorkItemFixture();
    const { story, child } = await storyWithChild(fx);
    const core = await addRepo(fx, 'motir-core');
    const ai = await addRepo(fx, 'motir-ai');
    const storyPr = await addPr(core.id, { headRef: `parent/${story.identifier}-aws` });
    const ownPr = await addPr(ai.id, { headRef: `subtask/${child.identifier}-ai` });
    await deliver(fx, story.id, storyPr.id, core.id);
    await deliver(fx, child.id, ownPr.id, ai.id);

    const mcp = structuredOf(await runGetWorkItem({ key: child.identifier }, fx.ctx));
    const hosted = await aiBoundaryService.getItem(fx.projectId, child.identifier, fx.ctx);
    expect(mcp['inFlightCode']).toEqual(hosted.item.inFlightCode);
    expect(mcp['mergedRepos']).toEqual(hosted.item.mergedRepos);
    expect((mcp['inFlightCode'] as Array<{ source: string }>).map((e) => e.source)).toEqual([
      'own',
      'inherited',
    ]);
  });

  it('reads the card and its ancestors in ONE batched delivery read', async () => {
    const fx = await makeWorkItemFixture();
    const { story, child } = await storyWithChild(fx);
    const batched = vi.spyOn(workItemDeliveryRepository, 'listByWorkItemsWithChecks');
    try {
      await runGetWorkItem({ key: child.identifier }, fx.ctx);
      expect(batched).toHaveBeenCalledTimes(1);
      expect([...batched.mock.calls[0]![0]].sort()).toEqual([story.id, child.id].sort());
    } finally {
      batched.mockRestore();
    }
  });

  it('the projected answer (planId) carries no in-flight fields — a proposal has no pull request', async () => {
    const fx = await makeWorkItemFixture();
    const { child } = await storyWithChild(fx);
    const plan = await plansService.createPlan(fx.projectId, { title: 'Plan' }, fx.ctx);
    const res = await runGetWorkItem({ key: child.identifier, planId: plan.id }, fx.ctx);
    const out = structuredOf(res);
    expect(out).not.toHaveProperty('inFlightCode');
    expect(out).not.toHaveProperty('mergedRepos');
  });
});

describe('renderInFlightLine — the hosted twin’s wording', () => {
  it('omits the PR and base parts it has no value for, and keeps the rest', () => {
    expect(
      renderInFlightLine({
        repo: 'acme/web',
        branch: 'feat/x',
        headSha: null,
        prNumber: 0,
        prUrl: '',
        draft: false,
        baseRef: null,
        source: 'own',
      }),
    ).toBe("In-flight code: acme/web — branch feat/x · this item's own pull request");
  });
});

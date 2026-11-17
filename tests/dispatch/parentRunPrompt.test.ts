import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  assembleDispatchPrompt,
  namesDeliveryFileRoute,
  parentRunOf,
  type DispatchPromptSource,
} from '@/lib/dispatch/promptTemplate';
import { dispatchPromptService, parentRunFrom } from '@/lib/services/dispatchPromptService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type { InFlightCodeDto } from '@/lib/dto/ai';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkProjectRepo } from '../helpers/projectRepoLink';

// A CHILD OF A PARENT RUN IS TOLD TO LINK NOTHING TO ITSELF (Bug MOTIR-11624). The per-item
// GIT WORKFLOW ended in "LINK it … with key <child>", and a parent run that followed it
// linked the child to the story's pull request — which then asked the merge question on
// the CHILD. When the item's nearest ancestor already has an open pull request in its
// repository, the prompt now sends the commit onto that branch and names the ancestor as
// the only key the pull request is linked to. The pure grammar first, then the service's
// read of the ancestor's pull request on real Postgres.

const PARENT = {
  key: 'PROD-2',
  branch: 'parent/PROD-2-ready-surface',
  pullRequestUrl: 'https://github.com/moooon/motir-core/pull/4286',
};

function source(over: Partial<DispatchPromptSource> = {}): DispatchPromptSource {
  return {
    key: 'PROD-7',
    title: 'Add the ready-set filter bar',
    kind: 'subtask',
    type: 'code',
    executor: 'coding_agent',
    difficulty: null,
    priority: 'high',
    storyPoints: 5,
    estimateMinutes: 90,
    descriptionMd: 'Build the filter bar.\n\n## Acceptance criteria\n\n- It filters.',
    blockerKeys: [],
    openDependentKeys: [],
    errorEvidence: [],
    parent: { key: 'PROD-2', title: 'Ready surface' },
    projectName: 'Motir',
    projectKey: 'PROD',
    targetRepo: 'motir-core',
    sessionBranch: null,
    ...over,
  };
}

const flat = (prompt: string) => prompt.replace(/\s*\n\s*/g, ' ');

describe('the per-item GIT WORKFLOW for a child of a parent run', () => {
  const assembled = assembleDispatchPrompt(source({ parentRun: PARENT }));
  const prompt = flat(assembled.prompt);

  it('checks the parent’s branch out, commits onto it and opens no pull request', () => {
    expect(prompt).toContain(
      `whose pull request already delivers this repository: ${PARENT.pullRequestUrl}`,
    );
    expect(prompt).toContain(`git worktree add ../motir-core-prod-2 ${PARENT.branch}`);
    expect(prompt).toContain(`git push -u origin ${PARENT.branch}`);
    expect(prompt).toContain(
      '5. Do NOT open a pull request, and do NOT call link_pull_request with key PROD-7.',
    );
    expect(prompt).not.toContain('git worktree add ../motir-core-prod-7');
    expect(prompt).not.toContain('Push the branch and open a pull request against main');
  });

  it('never tells the agent to link the child — only the parent, if the link is missing', () => {
    expect(prompt).not.toContain('link_pull_request tool with key PROD-7');
    expect(prompt).not.toContain('link it with the link_pull_request tool (key PROD-7');
    expect(prompt).toContain('link it with key PROD-2 — never with key PROD-7');
    expect(prompt).toContain('4. do NOT link it to PROD-7: PROD-2 carries the link');
  });

  it('opens no pull request in FINISHED, publishes How to test on the parent’s run, and still moves the child', () => {
    expect(prompt).toContain(
      'FINISHED — the work is done, committed and PUSHED onto the pull request:',
    );
    expect(prompt).toContain(`2. push ${PARENT.branch}`);
    expect(prompt).toContain(
      `3. do NOT open a pull request: your commit rides ${PARENT.pullRequestUrl}`,
    );
    expect(prompt).toContain('4b. do NOT publish How to test for PROD-7');
    expect(prompt).toContain("once, onto PROD-2, by the run's close-out step.");
    expect(prompt).toContain('5. move PROD-7 to Implemented with the transition_status tool');
  });

  it('names the parent’s branch as the branch to work on', () => {
    expect(assembled.branch).toBe(PARENT.branch);
    expect(assembled.workBranch).toBe(PARENT.branch);
    expect(assembled.workflowMode).toBe('per_item_pr');
  });

  it('offers no delivery file route, because the child opens no pull request', () => {
    const delivering = source({
      parentRun: PARENT,
      runnerPostsAgentReport: true,
      runnerPostsDelivery: true,
    });
    expect(namesDeliveryFileRoute(delivering, null)).toBe(false);
    expect(namesDeliveryFileRoute({ ...delivering, parentRun: null }, null)).toBe(true);
  });
});

describe('parentRunOf — only the single-repository per-item grammar takes the parent run', () => {
  it('a session lineage, a continue and a repository set keep their own grammar', () => {
    expect(parentRunOf(source({ parentRun: PARENT }), null)).toEqual(PARENT);
    expect(parentRunOf(source({ parentRun: PARENT }), 'session/x')).toBeNull();
    expect(parentRunOf(source({ parentRun: null }), null)).toBeNull();
    expect(
      parentRunOf(
        source({
          parentRun: PARENT,
          continueFrom: {
            deadRunId: 'r1',
            endedHow: 'the run stopped reporting (no heartbeat)',
            lastHeardAt: '2026-11-17T04:00:00.000Z',
            dispatcherName: null,
            branch: 'subtask/PROD-7-x',
            pullRequest: null,
          },
        }),
        null,
      ),
    ).toBeNull();
    expect(
      parentRunOf(
        source({
          parentRun: PARENT,
          targetRepos: [
            { name: 'motir-core', defaultBranch: 'main' },
            { name: 'motir-ai', defaultBranch: 'main' },
          ],
        }),
        null,
      ),
    ).toBeNull();
  });

  it('without a parent run the per-item grammar is byte-identical', () => {
    expect(assembleDispatchPrompt(source({ parentRun: null })).prompt).toBe(
      assembleDispatchPrompt(source()).prompt,
    );
    expect(assembleDispatchPrompt(source()).prompt).toContain(
      'LINK it: call the link_pull_request tool with key PROD-7',
    );
  });
});

describe('parentRunFrom — the inherited in-flight entry for the item’s repository', () => {
  const entry = (over: Partial<InFlightCodeDto>): InFlightCodeDto =>
    ({
      repo: 'moooon/motir-core',
      branch: PARENT.branch,
      headSha: null,
      prNumber: 4286,
      prUrl: PARENT.pullRequestUrl,
      draft: true,
      baseRef: 'main',
      source: 'inherited',
      fromKey: 'PROD-2',
      ...over,
    }) as InFlightCodeDto;

  it('answers the ancestor’s pull request, matching the repository name case-insensitively', () => {
    expect(parentRunFrom([entry({ repo: 'Moooon/Motir-Core' })], 'motir-core')).toEqual(PARENT);
  });

  it('answers null for its OWN pull request, another repository, nothing in flight or no repository', () => {
    expect(
      parentRunFrom([entry({ source: 'own' } as Partial<InFlightCodeDto>)], 'motir-core'),
    ).toBeNull();
    expect(parentRunFrom([entry({ repo: 'moooon/motir-ai' })], 'motir-core')).toBeNull();
    expect(parentRunFrom([], 'motir-core')).toBeNull();
    expect(parentRunFrom([entry({})], null)).toBeNull();
  });
});

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function connectRepo(fx: WorkItemFixture, name: string) {
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
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: `repo-${name}`,
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  await linkProjectRepo({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    githubRepoId: repo.id,
    name,
  });
  return repo;
}

async function deliver(
  fx: WorkItemFixture,
  workItemId: string,
  repoId: string,
  headRef: string,
  number: number,
) {
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId,
      number,
      state: 'open',
      merged: false,
      headRef,
      baseRef: 'main',
      provider: 'github',
    },
    select: { id: true },
  });
  await withWorkspaceContext(fx.ctx, (tx) =>
    workItemDeliveryRepository.add(
      { workspaceId: fx.workspaceId, workItemId, githubPullRequestId: pr.id, repoId },
      tx,
    ),
  );
}

describe('dispatchPromptService — a child whose story already has an open pull request', () => {
  it('is dispatched onto the story’s branch, linked to nothing of its own', async () => {
    const fx = await makeWorkItemFixture();
    const repo = await connectRepo(fx, 'motir-core');
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Ready surface' },
      fx.ctx,
    );
    const child = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'subtask',
        type: 'code',
        title: 'Filter bar',
        parentId: story.id,
      },
      fx.ctx,
    );
    const headRef = `parent/${story.identifier}-ready`;
    await deliver(fx, story.id, repo.id, headRef, 4286);

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      child.identifier,
      fx.ctx,
    );

    expect(dto.branch).toBe(headRef);
    const prompt = flat(dto.prompt);
    expect(prompt).toContain(
      `whose pull request already delivers this repository: https://github.com/moooon/motir-core/pull/4286, from ${headRef}.`,
    );
    expect(prompt).not.toContain(`link_pull_request tool with key ${child.identifier}`);
  });

  it('a child whose story delivers nothing keeps the per-item grammar', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Ready surface' },
      fx.ctx,
    );
    const child = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'subtask',
        type: 'code',
        title: 'Filter bar',
        parentId: story.id,
      },
      fx.ctx,
    );

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      child.identifier,
      fx.ctx,
    );

    expect(flat(dto.prompt)).toContain(
      `LINK it: call the link_pull_request tool with key ${child.identifier}`,
    );
  });
});

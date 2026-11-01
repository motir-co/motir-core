import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// MOTIR-7180 — A CONTAINER WHOSE REPOSITORY SHIPPED THROUGH A DONE HUMAN CARD,
// with no pull request, completes on its last merge.
//
// The repository-set gate (MOTIR-2729) marked a repository satisfied ONLY when a
// linked change request merged onto its default branch. A story that cuts a
// release by pushing a tag — MOTIR-6976's `motir-skills` — carries that
// repository in its set through a human leaf that correctly never opens a pull
// request, so nothing would ever merge there: every later merge re-held the
// story at `deferred_incomplete_repo_set`, and only a person moving the status
// by hand got it out.
//
// Real Postgres, the real webhook service, no mocks. Pinned here:
//
//   1. The card's reproduction: c1 (web) delivered by a merge linked to the
//      story, c2 (api, human) Done with no pull request → the merge COMPLETES it.
//   2. ⚠️ SINCE MOTIR-10135 THE MERGE NO LONGER READS THE REPOSITORY SET AT ALL:
//      completion counts the story's own linked pull requests, so c2 not yet
//      Done, or Done beside a closed pull request of its own, no longer holds the
//      story — its merge completes it, and the cascade closes c2. These were
//      HOLDS; they are pinned as completions so the accepted trade-off is a
//      decision on record rather than a silent change.
//   3. The item panel still reads `delivered_without_change_request` — the
//      classification this card added, which the panel and the event-free
//      re-check of an item with no landed delivery still use.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-shipped-without-pr';
const CORE = { name: 'motir-core', providerRepoId: '9701', defaultBranch: 'main' };
const AI = { name: 'motir-ai', providerRepoId: '9702', defaultBranch: 'trunk' };

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

/** A project with two REALIZED repository rows, a story, and its two leaves:
 *  `webHalf` on motir-core and `apiHalf` — a human card — on motir-ai. */
async function scenario(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  const web = await projectRepoSetService.addRow(project.id, { role: 'web', name: CORE.name }, ctx);
  const api = await projectRepoSetService.addRow(project.id, { role: 'api', name: AI.name }, ctx);

  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [CORE, AI].map((r) => ({
      providerRepoId: r.providerRepoId,
      owner: 'moooon',
      name: r.name,
      defaultBranch: r.defaultBranch,
      archived: false,
    })),
  });
  // Realized rows, as a real two-repository project has — a `proposed` row is
  // `unestablished` and holds for a reason of its own.
  for (const [row, repo] of [
    [web, CORE],
    [api, AI],
  ] as const) {
    const mirrored = await withWorkspaceServiceContext(workspace.id, (tx) =>
      githubRepoRepository.findConnectedByWorkspaceAndName(workspace.id, 'moooon', repo.name, tx),
    );
    await projectRepoSetService.attachRealizedRepoRow(row.id, mirrored!.id, ctx);
  }

  const story = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: 'Ships code and cuts a release' },
    ctx,
  );
  const webHalf = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'subtask',
      title: 'The code change',
      parentId: story.id,
      targetRepositories: [web.id],
    },
    ctx,
  );
  const apiHalf = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'subtask',
      title: 'Release v1.0.0 by pushing a tag',
      parentId: story.id,
      type: 'deploy',
      executor: 'human',
      targetRepositories: [api.id],
    },
    ctx,
  );
  const storyRow = await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } });
  expect(storyRow.targetRepos.slice().sort()).toEqual([AI.name, CORE.name]);

  await workItemsService.updateStatus(story.id, 'in_progress', ctx);
  await workItemsService.updateStatus(webHalf.id, 'in_progress', ctx);
  await workItemsService.updateStatus(webHalf.id, 'implemented', ctx);
  await workItemsService.updateStatus(apiHalf.id, 'in_progress', ctx);
  // A deploy card records what it published before it may close — the tag.
  await commentsService.addComment(apiHalf.id, { bodyMd: 'Released v1.0.0 (tag pushed).' }, ctx);
  return { ctx, story: storyRow, webHalf, apiHalf };
}

const event = (
  action: string,
  identifier: string,
  repo: typeof CORE,
  number: number,
  merged: boolean,
) =>
  githubWebhookService.handleEvent('pull_request', {
    action,
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(repo.providerRepoId) },
    pull_request: {
      number,
      state: merged ? 'closed' : 'open',
      merged,
      title: `Change (${identifier})`,
      head: { ref: `parent/${identifier}` },
      base: { ref: repo.defaultBranch },
      user: { id: 4242 },
    },
  });

/** Link a pull request to `identifier`, open it, and merge it. */
async function deliver(identifier: string, repo: typeof CORE, number: number) {
  await linkPrByIdentifier({
    identifier,
    owner: 'moooon',
    name: repo.name,
    number,
    headRef: `parent/${identifier}`,
    baseRef: repo.defaultBranch,
  });
  await event('opened', identifier, repo, number, false);
  return event('closed', identifier, repo, number, true);
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

describe('a repository shipped through a Done card with no pull request', () => {
  it('COMPLETES the story on its last merge — the card’s reproduction', async () => {
    const fx = await scenario('shipped@example.com');
    // The human card released by tag and was closed by hand — no pull request.
    await workItemsService.updateStatus(fx.apiHalf.id, 'done', fx.ctx);

    expect(await deliver(fx.story.identifier, CORE, 1)).toMatchObject({
      outcome: 'transitioned',
      toStatus: 'done',
    });
    expect(await statusOf(fx.story.id)).toBe('done');
  });

  it('completes even while that card is not Done — the list no longer holds the story (MOTIR-10135)', async () => {
    const fx = await scenario('not-done@example.com');
    await workItemsService.updateStatus(fx.apiHalf.id, 'implemented', fx.ctx);

    expect(await deliver(fx.story.identifier, CORE, 1)).toMatchObject({
      outcome: 'transitioned',
      toStatus: 'done',
    });
    expect(await statusOf(fx.story.id)).toBe('done');
  });

  it('completes when that Done card carries a closed pull request of its own (MOTIR-10135)', async () => {
    const fx = await scenario('has-pr@example.com');
    // A pull request in motir-ai, linked to the leaf and closed UNMERGED: the
    // work there did not ship without one, whatever the leaf's status says.
    await linkPrByIdentifier({
      identifier: fx.apiHalf.identifier,
      owner: 'moooon',
      name: AI.name,
      number: 7,
      headRef: `subtask/${fx.apiHalf.identifier}`,
      baseRef: AI.defaultBranch,
    });
    await event('opened', fx.apiHalf.identifier, AI, 7, false);
    await githubWebhookService.handleEvent('pull_request', {
      action: 'closed',
      installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
      repository: { id: Number(AI.providerRepoId) },
      pull_request: {
        number: 7,
        state: 'closed',
        merged: false,
        title: `Change (${fx.apiHalf.identifier})`,
        head: { ref: `subtask/${fx.apiHalf.identifier}` },
        base: { ref: AI.defaultBranch },
        user: { id: 4242 },
      },
    });
    await workItemsService.updateStatus(fx.apiHalf.id, 'done', fx.ctx);

    // The leaf's pull request is linked to the LEAF, not the story, so the
    // story's own delivery set is the one merge below.
    expect(await deliver(fx.story.identifier, CORE, 1)).toMatchObject({
      outcome: 'transitioned',
      toStatus: 'done',
    });
    expect(await statusOf(fx.story.id)).toBe('done');
  });

  it('the item panel reads the same answer the gate acts on', async () => {
    const fx = await scenario('panel@example.com');
    await workItemsService.updateStatus(fx.apiHalf.id, 'done', fx.ctx);

    const rows = await workItemsService.listRepoDelivery(fx.story.id, fx.story.targetRepos, fx.ctx);
    expect(Object.fromEntries(rows.map((r) => [r.repo, r.state]))).toEqual({
      [CORE.name]: 'awaiting',
      [AI.name]: 'delivered_without_change_request',
    });
  });
});

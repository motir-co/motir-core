import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { workItemRepoRepository } from '@/lib/repositories/workItemRepoRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// MOTIR-8811 — A CONTAINER WHOSE REPOSITORY WAS DELIVERED BY A CHILD'S OWN
// MERGED PULL REQUEST completes on its last merge.
//
// The standard cross-repository story is one subtask per repository, each with a
// pull request linked to THAT subtask. The repository-set gate (MOTIR-2729) read
// only the container's own linked deliveries, and its one escape (MOTIR-7180)
// settled a leaf only when it carried NO delivery at all — so a repository
// delivered through a child's merged pull request was `awaiting` for ever, and
// every merge re-held the story at `deferred_incomplete_repo_set` (MOTIR-8699
// sat at Approved with eleven children at Implemented until moved by hand).
//
// Real Postgres, the real webhook service, no mocks. Pinned here:
//
//   1. The card's reproduction: c1 (web) delivered by a merge linked to the
//      story, c2 (api) Done through its OWN merged pull request → COMPLETES.
//   2. ⚠️ SINCE MOTIR-10135 THE MERGE NO LONGER READS THE REPOSITORY SET AT ALL:
//      completion counts the story's OWN linked pull requests, so c2's pull
//      request being open, closed unmerged or merged onto a non-default base no
//      longer holds the story — it is linked to c2, not to the story. These were
//      HOLDS; they are pinned as completions so the accepted trade-off is a
//      decision on record rather than a silent change. The panel still reads
//      `delivered_by_child` (case 4).
//   3. An abandoned closed attempt beside the merge that shipped does not hold.
//   4. The item panel reads the same answer the gate acted on.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-delivered-by-child';
const CORE = { name: 'motir-core', providerRepoId: '9711', defaultBranch: 'main' };
const AI = { name: 'motir-ai', providerRepoId: '9712', defaultBranch: 'trunk' };

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

/** A project with two REALIZED repository rows, a story, and its two per-repo
 *  leaves: `webHalf` on motir-core and `apiHalf` on motir-ai — each a coding
 *  card that ships through a pull request of its own. */
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
    { projectId: project.id, kind: 'story', title: 'Ships one change in two repositories' },
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
      title: 'The motir-ai half',
      parentId: story.id,
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
  await workItemsService.updateStatus(apiHalf.id, 'implemented', ctx);
  return { ctx, story: storyRow, webHalf, apiHalf };
}

const event = (
  action: string,
  identifier: string,
  repo: typeof CORE,
  number: number,
  merged: boolean,
  opts: { base?: string; closed?: boolean } = {},
) =>
  githubWebhookService.handleEvent('pull_request', {
    action,
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(repo.providerRepoId) },
    pull_request: {
      number,
      state: merged || opts.closed ? 'closed' : 'open',
      merged,
      title: `Change (${identifier})`,
      head: { ref: `parent/${identifier}` },
      base: { ref: opts.base ?? repo.defaultBranch },
      user: { id: 4242 },
    },
  });

/** Link a pull request to `identifier` and open it, targeting `base`. */
async function open(identifier: string, repo: typeof CORE, number: number, base?: string) {
  await linkPrByIdentifier({
    identifier,
    owner: 'moooon',
    name: repo.name,
    number,
    headRef: `parent/${identifier}`,
    baseRef: base ?? repo.defaultBranch,
  });
  return event('opened', identifier, repo, number, false, { base });
}

/** Link a pull request to `identifier`, open it, and merge it onto `base`. */
async function deliver(identifier: string, repo: typeof CORE, number: number, base?: string) {
  await open(identifier, repo, number, base);
  return event('closed', identifier, repo, number, true, { base });
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

describe('a repository delivered by a child’s OWN merged pull request', () => {
  it('COMPLETES the story on its last merge — the card’s reproduction', async () => {
    const fx = await scenario('by-child@example.com');
    // c2's pull request is linked to c2 — not to the story — and merges onto
    // motir-ai's default branch. The merge itself closes c2.
    await deliver(fx.apiHalf.identifier, AI, 5);
    expect(await statusOf(fx.apiHalf.id)).toBe('done');

    expect(await deliver(fx.story.identifier, CORE, 1)).toMatchObject({
      outcome: 'transitioned',
      toStatus: 'done',
    });
    expect(await statusOf(fx.story.id)).toBe('done');
  });

  it('completes while that child’s pull request is OPEN (MOTIR-10135)', async () => {
    const fx = await scenario('child-open@example.com');
    await open(fx.apiHalf.identifier, AI, 5);
    // The status door refuses Done while the card's own pull request is open, so
    // write it underneath that door — a status that says Done beside a pull
    // request that says the work has not landed. The story merge no longer reads it.
    await adminDb.workItem.update({ where: { id: fx.apiHalf.id }, data: { status: 'done' } });

    expect(await deliver(fx.story.identifier, CORE, 1)).toMatchObject({
      outcome: 'transitioned',
      toStatus: 'done',
    });
    expect(await statusOf(fx.story.id)).toBe('done');
  });

  it('completes when that child’s pull request was CLOSED UNMERGED (MOTIR-10135)', async () => {
    const fx = await scenario('child-closed@example.com');
    await open(fx.apiHalf.identifier, AI, 5);
    await event('closed', fx.apiHalf.identifier, AI, 5, false, { closed: true });
    await workItemsService.updateStatus(fx.apiHalf.id, 'done', fx.ctx);

    expect(await deliver(fx.story.identifier, CORE, 1)).toMatchObject({
      outcome: 'transitioned',
      toStatus: 'done',
    });
    expect(await statusOf(fx.story.id)).toBe('done');
  });

  it('completes when that child’s pull request merged onto a NON-DEFAULT base (MOTIR-10135)', async () => {
    const fx = await scenario('child-side-branch@example.com');
    // Merged onto a side branch: `merged: true` for ever, and never on the trunk.
    await deliver(fx.apiHalf.identifier, AI, 5, 'release/next');
    await workItemsService.updateStatus(fx.apiHalf.id, 'done', fx.ctx);

    expect(await deliver(fx.story.identifier, CORE, 1)).toMatchObject({
      outcome: 'transitioned',
      toStatus: 'done',
    });
    expect(await statusOf(fx.story.id)).toBe('done');
  });

  it('an abandoned closed attempt beside the merged one does not hold it', async () => {
    const fx = await scenario('child-retried@example.com');
    // A first attempt closed unmerged, then the pull request that shipped — the
    // completion gate ignores an abandoned attempt on the story's own set, and
    // a child's set is read the same way.
    await open(fx.apiHalf.identifier, AI, 4);
    await event('closed', fx.apiHalf.identifier, AI, 4, false, { closed: true });
    await deliver(fx.apiHalf.identifier, AI, 5);
    expect(await statusOf(fx.apiHalf.id)).toBe('done');

    expect(await deliver(fx.story.identifier, CORE, 1)).toMatchObject({
      outcome: 'transitioned',
      toStatus: 'done',
    });
  });

  it('the item panel reads the same answer the gate acts on — delivered by a child, not awaiting', async () => {
    const fx = await scenario('by-child-panel@example.com');
    await deliver(fx.apiHalf.identifier, AI, 5);

    const rows = await workItemsService.listRepoDelivery(fx.story.id, fx.story.targetRepos, fx.ctx);
    expect(Object.fromEntries(rows.map((r) => [r.repo, r.state]))).toEqual({
      [CORE.name]: 'awaiting',
      [AI.name]: 'delivered_by_child',
    });
  });

  it('the settlement read counts a leaf settled by its own merge, and says which way', async () => {
    const fx = await scenario('by-child-repo@example.com');
    await deliver(fx.apiHalf.identifier, AI, 5);

    const rows = await withWorkspaceServiceContext(fx.ctx.workspaceId, (tx) =>
      workItemRepoRepository.listLeafSettlementForContainer(fx.story.id, fx.ctx.workspaceId, tx),
    );
    const byRepo = await adminDb.projectRepo.findMany({ select: { id: true, name: true } });
    const name = new Map(byRepo.map((r) => [r.id, r.name]));
    expect(
      Object.fromEntries(rows.map((r) => [name.get(r.projectRepoId), { ...r, projectRepoId: 0 }])),
    ).toEqual({
      // c1 is Implemented — not settled.
      [CORE.name]: { projectRepoId: 0, leaves: 1, settled: 0, settledByChangeRequest: 0 },
      // c2 is Done through its own merge onto motir-ai's default branch.
      [AI.name]: { projectRepoId: 0, leaves: 1, settled: 1, settledByChangeRequest: 1 },
    });
  });
});

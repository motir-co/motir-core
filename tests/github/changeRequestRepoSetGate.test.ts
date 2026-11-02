import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkWorkspaceReposToProject } from '../helpers/projectRepoLink';
import { linkPrByIdentifier } from '../helpers/prLink';

// COMPLETION COUNTS THE LINKED PULL REQUESTS, NOT THE REPOSITORY LIST (MOTIR-10135).
//
// MOTIR-2729 built a third completion gate on the item's repository SET: every
// repository on `targetRepos` had to have a merged linked pull request before a
// merge could complete the item. The list is a planning guess about where work
// may land, and runs routinely find one listed repository needs nothing — so the
// gate held items at In Review after every real pull request had merged
// (MOTIR-7180, MOTIR-8811, MOTIR-9235, and MOTIR-10135's own MOTIR-10106). The
// merge sync no longer reads the list; the delivery-set gate (MOTIR-3659), the
// open-PR gate (MOTIR-1604) and the default-branch check (MOTIR-1873) decide.
//
// Real Postgres, the real webhook service, the real provider seam — no mocks (the
// motir-core convention). What is pinned here:
//
//   1. A three-repository item with linked pull requests in two of them completes
//      on the second merge, with no repository-set hold and no "Still outstanding"
//      note — the card's acceptance case, and the reproduction of MOTIR-10106.
//   2. A two-repository item with one linked pull request completes on its merge:
//      the other repository needed no change, and nothing waits for it.
//   3. The same item stays held while a linked pull request is still OPEN, or when
//      one merged onto a NON-default base — the gates that count pull requests
//      that EXIST are unchanged. A merged row with an UNKNOWN base still holds.
//   4. An empty set and a one-repository set complete exactly as before.
//   5. A hold posts its note ONCE per merge however often the host redelivers.
//   6. The mirror still records the base branch — the column those gates read.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-repo-set';

interface RepoSpec {
  name: string;
  providerRepoId: string;
  defaultBranch?: string;
}

const CORE: RepoSpec = { name: 'motir-core', providerRepoId: '7001', defaultBranch: 'main' };
const AI: RepoSpec = { name: 'motir-ai', providerRepoId: '7002', defaultBranch: 'trunk' };
const META: RepoSpec = { name: 'motir-meta', providerRepoId: '7003', defaultBranch: 'main' };

/** A workspace + project + a work item, plus a mirrored installation carrying
 *  every repo in `repos`. The item is left at `in_progress` unless a delivery
 *  moves it. */
async function makeScenario(email: string, repos: RepoSpec[], targetRepos: string[]) {
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

  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: repos.map((r) => ({
      providerRepoId: r.providerRepoId,
      owner: 'moooon',
      name: r.name,
      defaultBranch: r.defaultBranch ?? 'main',
      archived: false,
    })),
  });
  await linkWorkspaceReposToProject({
    workspaceId: workspace.id,
    projectId: project.id,
    names: repos.map((repo) => repo.name),
  });

  const item = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'task',
      title: 'A change that ships in more than one repository',
      ...(targetRepos.length > 0 ? { targetRepos } : {}),
    },
    ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', ctx);
  return { user, workspace, project, item, ctx };
}

function prPayload(opts: {
  action: string;
  identifier: string;
  repo: RepoSpec;
  baseRef?: string;
  number: number;
  state?: 'open' | 'closed';
  merged?: boolean;
}) {
  return {
    action: opts.action,
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(opts.repo.providerRepoId) },
    pull_request: {
      number: opts.number,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      title: `Some change (${opts.identifier})`,
      head: { ref: `subtask/${opts.identifier}-a-change` },
      base: { ref: opts.baseRef ?? opts.repo.defaultBranch ?? 'main' },
      user: { id: 4242 },
    },
  };
}

const open = async (identifier: string, repo: RepoSpec, number: number, baseRef?: string) => {
  // MOTIR-3674 — the link is the only association a pull request has; the key in
  // the branch is a label. A run writes it the moment `gh pr create` returns,
  // which is before the `opened` delivery lands.
  await linkPrByIdentifier({
    identifier,
    owner: 'moooon',
    name: repo.name,
    number,
    headRef: `subtask/${identifier}-a-change`,
    baseRef: baseRef ?? repo.defaultBranch ?? 'main',
    title: `Some change (${identifier})`,
  });
  return githubWebhookService.handleEvent(
    'pull_request',
    prPayload({ action: 'opened', identifier, repo, number, baseRef }),
  );
};

const merge = (identifier: string, repo: RepoSpec, number: number, baseRef?: string) =>
  githubWebhookService.handleEvent(
    'pull_request',
    prPayload({
      action: 'closed',
      identifier,
      repo,
      number,
      baseRef,
      state: 'closed',
      merged: true,
    }),
  );

async function statusOf(workItemId: string): Promise<string> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
}

async function commentBodies(workItemId: string): Promise<string[]> {
  const rows = await adminDb.comment.findMany({
    where: { workItemId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((c) => c.bodyMd);
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('completion counts the LINKED pull requests, not the repository list (MOTIR-10135)', () => {
  it('completes a three-repository item when its two linked pull requests have merged', async () => {
    const { item } = await makeScenario(
      'set-three@example.com',
      [CORE, AI, META],
      ['motir-core', 'motir-ai', 'motir-meta'],
    );
    await open(item.identifier, CORE, 1);
    await open(item.identifier, AI, 2);

    const first = await merge(item.identifier, CORE, 1);
    // The sibling is still OPEN, so the delivery-set gate holds — unchanged.
    expect(first).toMatchObject({ outcome: 'deferred_incomplete_delivery_set' });
    expect(await statusOf(item.id)).toBe('implemented');

    // `trunk`, not `main` — the mirrored default branch, never a hard-coded guess.
    const second = await merge(item.identifier, AI, 2, 'trunk');

    // motir-meta has no pull request at all, and nothing waits for it.
    expect(second).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(item.id)).toBe('done');
    const bodies = await commentBodies(item.id);
    expect(bodies.some((b) => b.includes('Still outstanding'))).toBe(false);
    expect(bodies.some((b) => b.includes('motir-meta'))).toBe(false);
  });

  it('completes a two-repository item on the merge of its ONE linked pull request', async () => {
    const { item } = await makeScenario(
      'set-one-linked@example.com',
      [CORE, AI],
      ['motir-core', 'motir-ai'],
    );
    await open(item.identifier, CORE, 1);
    // motir-ai's pull request was never opened — the run found it needed no
    // change. Before MOTIR-10135 this merge held the item and named motir-ai.
    const result = await merge(item.identifier, CORE, 1);

    expect(result).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(item.id)).toBe('done');
    expect(await commentBodies(item.id)).toEqual([]);
  });
});

describe('the gates that count pull requests that EXIST still hold', () => {
  it('holds while a linked pull request in another repository is still OPEN', async () => {
    const { item } = await makeScenario(
      'set-order-open@example.com',
      [CORE, AI, META],
      ['motir-core', 'motir-ai', 'motir-meta'],
    );
    await open(item.identifier, CORE, 1);
    await open(item.identifier, AI, 2);
    const result = await merge(item.identifier, CORE, 1);

    // `deferred_incomplete_delivery_set` names the still-open pull request and
    // says what would complete the item (`work-item-delivery-links.md` Q3).
    expect(result).toMatchObject({ outcome: 'deferred_incomplete_delivery_set' });
    expect((await commentBodies(item.id)).at(-1)).toContain('Still open');
    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('holds when a linked pull request merged onto a NON-default branch', async () => {
    // The composition of MOTIR-1873 and MOTIR-1604: motir-ai's change request
    // merged, truthfully, onto a branch that is not its trunk. `merged: true`
    // forever, no path to `trunk`.
    const { item } = await makeScenario(
      'set-stranded@example.com',
      [CORE, AI, META],
      ['motir-core', 'motir-ai', 'motir-meta'],
    );
    await open(item.identifier, AI, 2, 'feature/stack-base');
    const stranded = await merge(item.identifier, AI, 2, 'feature/stack-base');
    expect(stranded).toMatchObject({ outcome: 'deferred_non_default_base' });

    await open(item.identifier, CORE, 1);
    const result = await merge(item.identifier, CORE, 1);

    expect(result).toMatchObject({ outcome: 'deferred_incomplete_delivery_set' });
    expect(await statusOf(item.id)).toBe('implemented');
    expect((await commentBodies(item.id)).at(-1)).toContain('Merged, but not onto the trunk');
  });

  it('holds on a merged row whose base is UNKNOWN, and says that rather than naming a branch', async () => {
    const { item } = await makeScenario(
      'set-unknown@example.com',
      [CORE, AI],
      ['motir-core', 'motir-ai'],
    );
    await open(item.identifier, AI, 2);
    await open(item.identifier, CORE, 1);
    // motir-core is still open, so this merge is held whatever its base says.
    await merge(item.identifier, AI, 2, 'trunk');
    // Put the row back into the shape a PR mirrored BEFORE `base_ref` existed has.
    await adminDb.githubPullRequest.updateMany({
      where: { number: 2 },
      data: { baseRef: null },
    });

    const result = await merge(item.identifier, CORE, 1);

    expect(result).toMatchObject({ outcome: 'deferred_incomplete_delivery_set' });
    expect(await statusOf(item.id)).toBe('implemented');
    const note = (await commentBodies(item.id)).at(-1)!;
    // UNKNOWN in both directions: it must not claim the work is outstanding (the
    // merge may well have reached the trunk), and it must not claim a branch.
    expect(note).toContain('No record of which branch');
    expect(note).toContain('motir-ai');
    expect(note).not.toContain('Still outstanding');
  });

  it('a NON-default merge still reports deferred_non_default_base', async () => {
    const { item } = await makeScenario(
      'set-order-base@example.com',
      [CORE, AI],
      ['motir-core', 'motir-ai'],
    );
    await open(item.identifier, CORE, 1, 'release/1.x');
    const result = await merge(item.identifier, CORE, 1, 'release/1.x');

    // A merge with no path to the trunk is not completion at all.
    expect(result).toMatchObject({ outcome: 'deferred_non_default_base' });
    expect(await statusOf(item.id)).toBe('implemented');
  });
});

describe('an empty or one-repository set behaves exactly as before', () => {
  it('an item carrying NO repositories completes on the first merge', async () => {
    const { item } = await makeScenario('set-empty@example.com', [CORE], []);
    await open(item.identifier, CORE, 1);
    const result = await merge(item.identifier, CORE, 1);

    expect(result).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(item.id)).toBe('done');
    expect(await commentBodies(item.id)).toEqual([]);
  });

  it('an item carrying ONE repository completes on that repository’s merge', async () => {
    const { item } = await makeScenario('set-one@example.com', [CORE], ['motir-core']);
    await open(item.identifier, CORE, 1);
    const result = await merge(item.identifier, CORE, 1);

    expect(result).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(item.id)).toBe('done');
  });
});

describe('a hold is idempotent under redelivery', () => {
  it('posts its note ONCE per merge, however many times the host redelivers', async () => {
    const { item } = await makeScenario(
      'set-redeliver@example.com',
      [CORE, AI],
      ['motir-core', 'motir-ai'],
    );
    await open(item.identifier, CORE, 1);
    await open(item.identifier, AI, 2);
    await merge(item.identifier, CORE, 1);
    await merge(item.identifier, CORE, 1);
    const third = await merge(item.identifier, CORE, 1);

    expect(third).toMatchObject({ outcome: 'deferred_incomplete_delivery_set' });
    expect(await commentBodies(item.id)).toHaveLength(1);
    expect(await statusOf(item.id)).toBe('implemented');
  });
});

describe('the mirror RECORDS the base — the column the gates read', () => {
  it('persists the base branch of every delivery, on open and on merge', async () => {
    const { item } = await makeScenario('set-baseref@example.com', [CORE, AI], ['motir-core']);
    await open(item.identifier, CORE, 1);
    expect((await adminDb.githubPullRequest.findFirst({ where: { number: 1 } }))?.baseRef).toBe(
      'main',
    );

    await open(item.identifier, AI, 2, 'feature/stack');
    expect((await adminDb.githubPullRequest.findFirst({ where: { number: 2 } }))?.baseRef).toBe(
      'feature/stack',
    );
  });
});

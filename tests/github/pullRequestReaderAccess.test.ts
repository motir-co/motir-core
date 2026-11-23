import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectRepoAccessService } from '@/lib/services/projectRepoAccessService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import { projectRepoCollaboratorRepository } from '@/lib/repositories/projectRepoCollaboratorRepository';
import { presentWorkItemDetail } from '@/lib/api/v1/workItems/schema';
import { withUserContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { LinkedPullRequestDto } from '@/lib/dto/github';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { setWorkspaceRoleFor } from '../helpers/workspaceRoleFixtures';

// THE PULL-REQUEST ROW'S READER ACCESS (Story MOTIR-4881 · MOTIR-12115; design
// `design/github/design-notes.md` § 35), on a REAL Postgres.
//
// A READ ONLY: which access fact each row carries for the CURRENT reader, from BOTH row
// reads (`listLinkedPullRequests` and `listDeliverySet`). Non-null only on a repository
// Motir created for the card's project (an invitable `created` row whose repository is
// still there); null for a connected repository, one outside the set, a reader outside
// the candidate set, and a read that throws — and never an error.

const MOTIR_ORG = 'motir-projects';
const INVITATION_URL = `https://github.com/${MOTIR_ORG}/shop-web/invitations`;

let fx: WorkItemFixture;
let seq = 0;
let installationId: string;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  seq += 1;
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: `inst-12115-${seq}`,
      accountLogin: MOTIR_ORG,
      accountType: 'Organization',
      provider: 'github',
    },
  });
  installationId = installation.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A mirrored GitHub repository of the fixture's organisation. */
async function mirror(owner: string, name: string) {
  seq += 1;
  return adminDb.githubRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      installationId,
      repoId: `repo-12115-${seq}`,
      owner,
      name,
      defaultBranch: 'main',
      provider: 'github',
    },
  });
}

/** A set row of the fixture's project: `connected` (the customer's own) or `created`
 *  (Motir made it). */
async function setRow(repo: { id: string; name: string }, state: 'connected' | 'created') {
  const row = await linkProjectRepo({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    githubRepoId: repo.id,
    name: repo.name,
  });
  if (state === 'created') {
    await adminDb.projectRepo.update({ where: { id: row.id }, data: { state: 'created' } });
  }
  return row;
}

/** A card with one linked pull request per repository given, linked through BOTH the
 *  delivery set and the pull request's own row. */
async function card(repos: readonly { id: string }[]) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Review the change' },
    fx.ctx,
  );
  const prs: { id: string }[] = [];
  for (const repo of repos) {
    seq += 1;
    const pr = await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number: 400 + seq,
        title: `Change ${seq}`,
        state: 'open',
        headRef: `subtask/PROD-${seq}`,
        baseRef: 'main',
        provider: 'github',
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
    prs.push({ id: pr.id });
  }
  return { item, prs };
}

async function connectGithub(userId: string, login: string): Promise<void> {
  seq += 1;
  await withUserContext(userId, (tx) =>
    githubIdentityRepository.upsertForUser(
      {
        userId,
        githubUserId: `gh-12115-${seq}`,
        githubLogin: login,
        avatarUrl: null,
        accessTokenEncrypted: 'encrypted-not-read-here',
      },
      tx,
    ),
  );
}

/** A workspace member at `role`, as a reader context. */
async function member(role: 'member' | 'viewer'): Promise<ServiceContext> {
  seq += 1;
  const user = await adminDb.user.create({
    data: { name: `reader${seq}`, email: `reader${seq}@example.com`, emailVerified: true },
  });
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
  });
  await setWorkspaceRoleFor(user.id, fx.workspaceId, role);
  return { userId: user.id, workspaceId: fx.workspaceId };
}

async function record(
  projectRepoId: string,
  userId: string,
  o: { invited?: boolean; accepted?: boolean },
) {
  return adminDb.projectRepoCollaborator.create({
    data: {
      workspaceId: fx.workspaceId,
      projectRepoId,
      userId,
      githubLogin: 'stored-login',
      permission: 'push',
      invitedAt: o.invited || o.accepted ? new Date() : null,
      acceptedAt: o.accepted ? new Date() : null,
      invitationUrl: o.accepted ? null : o.invited ? INVITATION_URL : null,
    },
  });
}

/** Both reads, as `id → readerAccess`, asserting they agree on every shared row. */
async function bothReads(workItemId: string, ctx: ServiceContext = fx.ctx) {
  const linked = await workItemsService.listLinkedPullRequests(workItemId, ctx);
  const set = await workItemsService.listDeliverySet(workItemId, ctx);
  const fromLinked = new Map(linked.map((pr) => [pr.id, pr.readerAccess]));
  const fromSet = new Map(set.map((d) => [d.pullRequest.id, d.pullRequest.readerAccess]));
  expect(fromSet).toEqual(fromLinked);
  return { linked, set, access: fromLinked };
}

/** A Motir-created repository on a card, ready for a reader. */
async function createdRepoCard() {
  const repo = await mirror(MOTIR_ORG, 'shop-web');
  const row = await setRow(repo, 'created');
  const { item, prs } = await card([repo]);
  return { repo, row, item, pr: prs[0]! };
}

describe('a pull request on a Motir-created repository carries the reader’s access', () => {
  it('reads no_github_identity for an eligible reader with no connected account, state from the record', async () => {
    const { row, item, pr } = await createdRepoCard();

    const none = await bothReads(item.id);
    expect(none.access.get(pr.id)).toEqual({
      state: 'not_invited',
      reason: 'no_github_identity',
      invitationUrl: null,
    });

    await record(row.id, fx.ownerId, { invited: true });
    const invited = await bothReads(item.id);
    // The reason and the state are independent: the record's state is kept.
    expect(invited.access.get(pr.id)).toEqual({
      state: 'invited',
      reason: 'no_github_identity',
      invitationUrl: INVITATION_URL,
    });
  });

  it('keeps the accepted state and sets role_cannot_edit for a reader whose role cannot edit', async () => {
    const { row, item, pr } = await createdRepoCard();
    const viewer = await member('viewer');
    await connectGithub(viewer.userId, 'viewer-gh');
    await record(row.id, viewer.userId, { accepted: true });

    const { access } = await bothReads(item.id, viewer);
    expect(access.get(pr.id)).toEqual({
      state: 'accepted',
      reason: 'role_cannot_edit',
      invitationUrl: null,
    });
  });

  it('reads invited (with the stored link), not_invited and accepted for an eligible connected reader', async () => {
    const { row, item, pr } = await createdRepoCard();
    await connectGithub(fx.ownerId, 'owner-gh');

    expect((await bothReads(item.id)).access.get(pr.id)).toEqual({
      state: 'not_invited',
      reason: null,
      invitationUrl: null,
    });

    const rec = await record(row.id, fx.ownerId, { invited: true });
    expect((await bothReads(item.id)).access.get(pr.id)).toEqual({
      state: 'invited',
      reason: null,
      invitationUrl: INVITATION_URL,
    });

    await adminDb.projectRepoCollaborator.update({
      where: { id: rec.id },
      data: { acceptedAt: new Date(), invitationUrl: null },
    });
    expect((await bothReads(item.id)).access.get(pr.id)).toEqual({
      state: 'accepted',
      reason: null,
      invitationUrl: null,
    });
  });

  it('answers only the reader’s own record, never another member’s', async () => {
    const { row, item, pr } = await createdRepoCard();
    await connectGithub(fx.ownerId, 'owner-gh');
    const teammate = await member('member');
    await record(row.id, teammate.userId, { accepted: true });

    expect((await bothReads(item.id)).access.get(pr.id)).toEqual({
      state: 'not_invited',
      reason: null,
      invitationUrl: null,
    });
  });

  it('matches the repository case-insensitively', async () => {
    const repo = await mirror('Motir-Projects', 'Shop-Web');
    await setRow(repo, 'created');
    const { item, prs } = await card([repo]);
    await connectGithub(fx.ownerId, 'owner-gh');

    expect((await bothReads(item.id)).access.get(prs[0]!.id)).toMatchObject({
      state: 'not_invited',
    });
  });
});

describe('readerAccess is null where there is no access fact', () => {
  it('is null for a connected repository, one outside the set, and a created row whose repository is gone', async () => {
    const customer = await mirror('acme', 'shop-api');
    await setRow(customer, 'connected');
    const outside = await mirror('acme', 'design-tokens');
    // A `created` row whose mirror has since been deleted: the set row survives with no
    // realized repository. Its pull requests live on another mirror row of the same name.
    const gone = await mirror(MOTIR_ORG, 'old-web');
    const goneRow = await setRow(gone, 'created');
    await adminDb.projectRepo.update({ where: { id: goneRow.id }, data: { githubRepoId: null } });
    await connectGithub(fx.ownerId, 'owner-gh');

    const { item, prs } = await card([customer, outside, gone]);
    const { linked, access } = await bothReads(item.id);

    for (const pr of prs) expect(access.get(pr.id)).toBeNull();
    // Every other field is the row exactly as it was: `url` is the mapper's own.
    for (const row of linked) {
      expect(row.url).toBe(`https://github.com/${row.repo}/pull/${row.number}`);
      expect(row.preview).toBeNull();
    }
  });

  it('makes no collaborator, identity or can-edit read when every pull request is on a connected repository', async () => {
    const a = await mirror('acme', 'shop-api');
    const b = await mirror('acme', 'shop-admin');
    await setRow(a, 'connected');
    await setRow(b, 'connected');
    const { item } = await card([a, b]);

    const collaborators = vi.spyOn(projectRepoCollaboratorRepository, 'listByProjectRepoIds');
    const identities = vi.spyOn(githubIdentityRepository, 'findLoginsByUserIds');
    const canEdit = vi.spyOn(projectAccessService, 'resolveCanEditForUsers');
    const members = vi.spyOn(assignableMembersService, 'list');

    const { access } = await bothReads(item.id);
    expect([...access.values()]).toEqual([null, null]);
    expect(collaborators).not.toHaveBeenCalled();
    expect(identities).not.toHaveBeenCalled();
    expect(canEdit).not.toHaveBeenCalled();
    expect(members).not.toHaveBeenCalled();
  });

  it('resolves the reader ONCE per read call for several pull requests on one created repository', async () => {
    const repo = await mirror(MOTIR_ORG, 'shop-web');
    const row = await setRow(repo, 'created');
    const { item, prs } = await card([repo, repo, repo]);
    await connectGithub(fx.ownerId, 'owner-gh');
    await record(row.id, fx.ownerId, { invited: true });

    const collaborators = vi.spyOn(projectRepoCollaboratorRepository, 'listByProjectRepoIds');
    const identities = vi.spyOn(githubIdentityRepository, 'findLoginsByUserIds');
    const canEdit = vi.spyOn(projectAccessService, 'resolveCanEditForUsers');

    await workItemsService.listLinkedPullRequests(item.id, fx.ctx);
    expect(collaborators).toHaveBeenCalledTimes(1);
    expect(identities).toHaveBeenCalledTimes(1);
    expect(canEdit).toHaveBeenCalledTimes(1);
    // …narrowed to the reader: the identity and can-edit reads ask about ONE user.
    expect(identities.mock.calls[0]![0]).toEqual([fx.ownerId]);
    expect(canEdit.mock.calls[0]![1]).toEqual([fx.ownerId]);

    const set = await workItemsService.listDeliverySet(item.id, fx.ctx);
    expect(collaborators).toHaveBeenCalledTimes(2);
    for (const d of set) expect(d.pullRequest.readerAccess).toMatchObject({ state: 'invited' });
    expect(set.map((d) => d.pullRequest.id).sort()).toEqual(prs.map((p) => p.id).sort());
  });

  it('is null on every row for a reader outside the access candidate set', async () => {
    const { item, pr } = await createdRepoCard();
    await connectGithub(fx.ownerId, 'owner-gh');
    // The candidate enumeration is the shipped scope chokepoint; a reader it does not
    // return (an organisation manager outside the workspace's member list, say) is
    // simulated by filtering them out of its real answer.
    const real = assignableMembersService.list.bind(assignableMembersService);
    vi.spyOn(assignableMembersService, 'list').mockImplementation(async (input) =>
      (await real(input)).filter((m) => m.userId !== fx.ownerId),
    );

    const { linked, access } = await bothReads(item.id);
    expect(access.get(pr.id)).toBeNull();
    expect(linked).toHaveLength(1);
  });

  it('is null — and the rows are returned unchanged — when the access read throws, and the failure is logged', async () => {
    const { item, pr } = await createdRepoCard();
    const before = await workItemsService.listLinkedPullRequests(item.id, fx.ctx);
    const beforeSet = await workItemsService.listDeliverySet(item.id, fx.ctx);

    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(projectRepoAccessService, 'readReaderAccessForRepos').mockRejectedValue(
      new Error('collaborator read failed'),
    );

    const { linked, set, access } = await bothReads(item.id);
    expect(access.get(pr.id)).toBeNull();
    const strip = (rows: LinkedPullRequestDto[]) =>
      rows.map(({ readerAccess: _ignored, ...rest }) => rest);
    expect(strip(linked)).toEqual(strip(before));
    expect(strip(set.map((d) => d.pullRequest))).toEqual(
      strip(beforeSet.map((d) => d.pullRequest)),
    );
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[0]![0])).toContain(item.id);
    expect(String(log.mock.calls[0]![0])).toContain(fx.projectId);
  });

  it('makes no access read at all for a card with no pull requests', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Nothing linked' },
      fx.ctx,
    );
    const access = vi.spyOn(projectRepoAccessService, 'readReaderAccessForRepos');
    expect(await workItemsService.listLinkedPullRequests(item.id, fx.ctx)).toEqual([]);
    expect(await workItemsService.listDeliverySet(item.id, fx.ctx)).toEqual([]);
    expect(access).not.toHaveBeenCalled();
  });
});

describe('the narrowed read itself', () => {
  it('reads invited with a null link when GitHub returned no invitation address', async () => {
    const { row, item, pr } = await createdRepoCard();
    await connectGithub(fx.ownerId, 'owner-gh');
    const rec = await record(row.id, fx.ownerId, { invited: true });
    await adminDb.projectRepoCollaborator.update({
      where: { id: rec.id },
      data: { invitationUrl: null },
    });
    // The row card draws this as the invitedNoLink variant (design § 35).
    expect((await bothReads(item.id)).access.get(pr.id)).toEqual({
      state: 'invited',
      reason: null,
      invitationUrl: null,
    });
  });

  it('answers an empty map for no repositories without reading the set', async () => {
    const setRead = vi.spyOn(projectRepoSetService, 'listByProject');
    const out = await projectRepoAccessService.readReaderAccessForRepos(fx.projectId, [], fx.ctx);
    expect(out.size).toBe(0);
    expect(setRead).not.toHaveBeenCalled();
  });

  it('reads a work item’s project id, and null for an unknown id', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Scoped' },
      fx.ctx,
    );
    await withWorkspaceContext(fx.ctx, async (tx) => {
      expect(await workItemRepository.findProjectIdById(item.id, tx)).toBe(fx.projectId);
      expect(await workItemRepository.findProjectIdById('missing-item', tx)).toBeNull();
    });
  });
});

describe('the hops past the two reads', () => {
  it('reaches the delivery view whole, and the v1 detail’s deliveries do not gain it', async () => {
    const { item, pr } = await createdRepoCard();
    await connectGithub(fx.ownerId, 'owner-gh');

    const view = await workItemsService.getDeliveryView(item.id, ['motir-core'], fx.ctx);
    const delivered = view.deliveries.find((d) => d.pullRequest.id === pr.id)!;
    expect(delivered.pullRequest.readerAccess).toEqual({
      state: 'not_invited',
      reason: null,
      invitationUrl: null,
    });

    const detail = await workItemsService.getIssueDetail(fx.projectId, item.identifier, fx.ctx);
    const published = presentWorkItemDetail(detail, 0, {}, view.deliveries);
    expect(published.deliveries).toHaveLength(1);
    expect(Object.keys(published.deliveries[0]!)).not.toContain('readerAccess');
    expect(JSON.stringify(published)).not.toContain('readerAccess');
  });
});

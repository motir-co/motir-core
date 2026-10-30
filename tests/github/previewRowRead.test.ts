import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { previewDeploymentRepository } from '@/lib/repositories/previewDeploymentRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { countDelegateCalls } from '../helpers/countDelegateCalls';

// THE DEVELOPMENT ROW'S PREVIEW READ (Story MOTIR-5766 · MOTIR-10099; design
// `design/github/design-notes.md` § 31), on a REAL Postgres.
//
// A READ ONLY: which preview record a row carries, the address composed for it,
// that a card's whole set costs ONE query rather than one per row, and that the
// read is bound — a record stamped with another workspace never reaches the row.

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A card with `count` linked pull requests, each in its own repository. */
async function card(count = 1) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Preview the pull request' },
    fx.ctx,
  );
  const prs: { id: string; repoId: string; number: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    seq += 1;
    const installation = await adminDb.githubInstallation.create({
      data: {
        workspaceId: fx.workspaceId,
        installationId: `inst-10099-${seq}`,
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
        repoId: `repo-10099-${seq}`,
        owner: 'acme',
        name: `svc-${seq}`,
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    const pr = await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number: 40 + seq,
        title: `Change ${seq}`,
        state: 'open',
        headRef: `subtask/ACME-${seq}`,
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
    prs.push({ id: pr.id, repoId: repo.id, number: pr.number });
  }
  return { item, prs };
}

async function preview(
  pr: { repoId: string; number: number },
  o: { state?: 'building' | 'starting' | 'ready' | 'failed' | 'closed'; reason?: string } = {},
  workspaceId = fx.workspaceId,
) {
  return adminDb.previewDeployment.create({
    data: {
      workspaceId,
      repoId: pr.repoId,
      pullRequestNumber: pr.number,
      headSha: 'a'.repeat(40),
      host: `pr-${pr.number}--acme-svc.preview.motir.site`,
      state: o.state ?? 'ready',
      failureReason: o.reason ?? null,
    },
  });
}

const rowsFor = (workItemId: string) => workItemsService.listLinkedPullRequests(workItemId, fx.ctx);
const setFor = (workItemId: string) => workItemsService.listDeliverySet(workItemId, fx.ctx);

describe('a Development row carries its preview (MOTIR-10099)', () => {
  it('carries the record’s state, host, reason and composed address', async () => {
    const { item, prs } = await card();
    await preview(prs[0]!);

    const [row] = await rowsFor(item.id);
    expect(row!.preview).toEqual({
      state: 'ready',
      host: `pr-${prs[0]!.number}--acme-svc.preview.motir.site`,
      failureReason: null,
      url: `https://pr-${prs[0]!.number}--acme-svc.preview.motir.site`,
    });
  });

  it('is null for a pull request with no preview record — absence is not a state', async () => {
    const { item } = await card();
    const [row] = await rowsFor(item.id);
    expect(row!.preview).toBeNull();
  });

  it('pairs each record with its own pull request, and passes a failed reason through', async () => {
    const { item, prs } = await card(3);
    await preview(prs[0]!, { state: 'building' });
    await preview(prs[2]!, { state: 'failed', reason: 'The preview could not start.' });

    const byId = new Map((await rowsFor(item.id)).map((row) => [row.id, row.preview]));
    expect(byId.get(prs[0]!.id)).toMatchObject({ state: 'building', failureReason: null });
    expect(byId.get(prs[1]!.id)).toBeNull();
    expect(byId.get(prs[2]!.id)).toMatchObject({
      state: 'failed',
      failureReason: 'The preview could not start.',
    });
  });

  it('the delivery set carries the same preview on each member', async () => {
    const { item, prs } = await card(2);
    await preview(prs[1]!, { state: 'closed' });

    const members = await setFor(item.id);
    const byId = new Map(members.map((m) => [m.pullRequest.id, m.pullRequest.preview]));
    expect(byId.get(prs[0]!.id)).toBeNull();
    expect(byId.get(prs[1]!.id)).toMatchObject({ state: 'closed' });
    // …and it is the value the Development read hands the same row.
    const rows = await rowsFor(item.id);
    expect(rows.find((r) => r.id === prs[1]!.id)!.preview).toEqual(byId.get(prs[1]!.id));
  });

  it('composes the address with the lane’s scheme when one is set', async () => {
    vi.stubEnv('MOTIR_PREVIEW_SCHEME', 'http');
    const { item, prs } = await card();
    await preview(prs[0]!);
    const [row] = await rowsFor(item.id);
    expect(row!.preview!.url).toBe(`http://pr-${prs[0]!.number}--acme-svc.preview.motir.site`);
  });
});

describe('the read is batched and bound', () => {
  it('reads a card’s previews in ONE query, on both reads', async () => {
    const { item, prs } = await card(3);
    for (const pr of prs) await preview(pr);

    const rows = await countDelegateCalls('previewDeployment', 'findMany', () => rowsFor(item.id));
    expect(rows.queries).toBe(1);
    expect(rows.result.every((row) => row.preview?.state === 'ready')).toBe(true);

    const set = await countDelegateCalls('previewDeployment', 'findMany', () => setFor(item.id));
    expect(set.queries).toBe(1);
    expect(set.result.every((m) => m.pullRequest.preview?.state === 'ready')).toBe(true);
  });

  it('asks nothing for a card with no pull request', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Nothing linked' },
      fx.ctx,
    );
    const rows = await countDelegateCalls('previewDeployment', 'findMany', () => rowsFor(item.id));
    expect(rows.queries).toBe(0);
    expect(rows.result).toEqual([]);
  });

  it('is bound: another workspace’s reader never sees this workspace’s preview', async () => {
    const { item, prs } = await card();
    await preview(prs[0]!);
    const other = await makeWorkItemFixture();
    const pair = [{ repoId: prs[0]!.repoId, pullRequestNumber: prs[0]!.number }];

    // This workspace's reader sees the record…
    expect(await rowsFor(item.id)).toEqual([
      expect.objectContaining({ preview: expect.objectContaining({ state: 'ready' }) }),
    ]);
    // …another organisation's reader, asking for the very same pair, sees nothing.
    const seen = await withWorkspaceContext(other.ctx, (tx) =>
      previewDeploymentRepository.listForPullRequests(pair, tx),
    );
    expect(seen).toEqual([]);
  });

  it('pairs by repository: the same number on another workspace’s repository is not ours', async () => {
    const { item, prs } = await card();
    const other = await makeWorkItemFixture();
    const otherFx = fx;
    fx = other;
    const theirs = await card();
    fx = otherFx;
    // Their pull request carries a preview; ours, with no record, still draws none.
    await preview({ repoId: theirs.prs[0]!.repoId, number: prs[0]!.number }, {}, other.workspaceId);

    const [row] = await rowsFor(item.id);
    expect(row!.preview).toBeNull();
  });

  it('the repository answers [] for an empty set without querying', async () => {
    const counted = await countDelegateCalls('previewDeployment', 'findMany', () =>
      db.$transaction((tx) => previewDeploymentRepository.listForPullRequests([], tx)),
    );
    expect(counted.queries).toBe(0);
    expect(counted.result).toEqual([]);
  });
});

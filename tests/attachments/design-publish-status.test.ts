import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { shaFor } from '../helpers/commitShaFixtures';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPr } from '../helpers/prLink';
import { expectEachHopAnnounced, transitionedEventsFor } from '../helpers/transitionedEvents';

// PUBLISHING A DESIGN RESULT HANDS THE CARD TO A PERSON — so the publish moves
// it to In Review, and ONLY when nothing else owns its status (Bug MOTIR-6009).
//
// The defect: both `motir run` paths wrote `implemented` after publishing, and
// `implemented` means *the branch is pushed, CI decides when it is reviewable*.
// A design card opens no pull request, so no CI verdict ever arrives and the
// card sat in the Implemented column while its own approval gate waited on a
// reviewer.
//
// ⚠️ THE DISCRIMINATOR IS THE OPEN DELIVERY, and it is the SAME question
// `designResultHandler.approve` already asks at decision time
// (`countOpenByWorkItem`): with an open pull request the PR lifecycle owns the
// status — `implemented` on push, `in_review` on green, `done` on merge — and
// this publish writes nothing. Without one there is nothing else to move the
// card, which is exactly why the publish must.
//
// Real Postgres. The object store is the one mocked external, as in
// `design-card-closed.test.ts`, whose fixture shape this mirrors.

const store = new Map<string, { contentType: string; size: number }>();

vi.mock('@/lib/blob/uploader', () => ({
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  putPrivateAttachment: vi.fn(async (pathname: string, bytes: Buffer, contentType: string) => {
    store.set(pathname, { contentType, size: bytes.byteLength });
    return { pathname };
  }),
  signedDownloadUrl: vi.fn(async (pathname: string) => `https://blob.example/signed/${pathname}`),
  deleteAttachmentBlob: vi.fn(async () => {}),
  mintPrivateUploadToken: vi.fn(async () => 'test-token'),
}));

const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { makeWorkWaitOn } = await import('../helpers/designWaits');
const { designEvidenceRepository } = await import('@/lib/repositories/designEvidenceRepository');

const INSTALLATION = '6009001';

/** A design card under a story, with an open dependent so a publish is allowed.
 *
 *  ⚠️ Through `workItemsService`, never the raw fixture helper: a card created
 *  directly starts at a status the workflow has no edges out of, so the ladder
 *  below is unwalkable and every case here fails before it has begun. */
async function makeDesignCard(fx: WorkItemFixture, status: string) {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Parent story' },
    fx.ctx,
  );
  const card = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'subtask',
      parentId: story.id,
      title: 'Design — the confirm port',
      type: 'design',
    },
    fx.ctx,
  );
  await makeWorkWaitOn(card.id, fx);
  // Walk the real ladder rather than writing the column: the statuses a card can
  // hold are the workflow's, and a hand-written one could be unreachable.
  await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);
  for (const hop of LADDER[status] ?? []) await workItemsService.updateStatus(card.id, hop, fx.ctx);
  return card;
}

/** The hops after `in_progress` that reach each status this suite uses. */
const LADDER: Record<string, string[]> = {
  in_progress: [],
  implemented: ['implemented'],
  in_review: ['in_review'],
  approved: ['in_review', 'approved'],
};

function publish(fx: WorkItemFixture, workItemId: string, name: string) {
  const prefix = designPrefix(fx.ctx.workspaceId, workItemId);
  store.set(`${prefix}${name}`, { contentType: 'text/html', size: 2048 });
  store.set(`${prefix}${name}.notes.md`, { contentType: 'text/markdown', size: 512 });
  return designEvidenceService.recordFromPathnames(
    {
      workItemId,
      assets: [
        { kind: 'mock' as const, sourcePath: `design/x/${name}`, pathname: `${prefix}${name}` },
        {
          kind: 'note_file' as const,
          sourcePath: 'design/x/design-notes.md',
          pathname: `${prefix}${name}.notes.md`,
        },
      ],
      commitSha: shaFor(name),
    },
    fx.ctx,
  );
}

/** Publish, asserting every status hop it wrote was announced once (Bug MOTIR-9416). */
async function publishAnnounced(fx: WorkItemFixture, workItemId: string, name: string) {
  const { hops } = await expectEachHopAnnounced(
    workItemId,
    { workspaceId: fx.ctx.workspaceId, actorId: fx.ctx.userId },
    () => publish(fx, workItemId, name),
  );
  return hops;
}

async function statusOf(workItemId: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } })).status;
}

async function awaitingDesignGates(workItemId: string): Promise<number> {
  return adminDb.approvalGate.count({
    where: { workItemId, kind: 'design_result', state: 'awaiting' },
  });
}

/** Link an OPEN pull request to the card, the way a run does. */
async function giveItAnOpenPullRequest(fx: WorkItemFixture, workItemId: string, number: number) {
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.ctx.workspaceId,
      installationId: `${INSTALLATION}${number}`,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  await adminDb.githubRepo.create({
    data: {
      workspaceId: fx.ctx.workspaceId,
      organizationId: fx.workspace.organizationId,
      installationId: installation.id,
      repoId: `6009${number}`,
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  await linkPr(
    {
      workItemId,
      projectId: fx.projectId,
      owner: 'acme',
      name: 'web',
      number,
      headRef: `design/MOTIR-6009-${number}`,
    },
    fx.ctx,
  );
}

beforeEach(async () => {
  store.clear();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "design_asset", "design_evidence", "attachment" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a design card with NO open pull request', () => {
  it('is moved to In Review by the publish, with its gate awaiting', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx, 'in_progress');

    // Each hop of the walk is announced once the publish commits, with its revision
    // (Bug MOTIR-9416): the parent rollup, the bell and automation rules all read the
    // event, not the row.
    expect(await publishAnnounced(fx, card.id, 'v1.mock.html')).toEqual([
      { fromStatusKey: 'in_progress', toStatusKey: 'in_review' },
    ]);

    expect(await statusOf(card.id)).toBe('in_review');
    // The status and the question commit together: the card is in review BECAUSE
    // somebody has been asked, so a card at `in_review` with no awaiting gate
    // would be the same lie one rung up.
    expect(await awaitingDesignGates(card.id)).toBe(1);
  });

  it('is moved to In Review from Implemented — the status the runs used to write', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx, 'implemented');

    expect(await publishAnnounced(fx, card.id, 'v1.mock.html')).toEqual([
      { fromStatusKey: 'implemented', toStatusKey: 'in_review' },
    ]);

    expect(await statusOf(card.id)).toBe('in_review');
  });

  it('leaves a card already at In Review where it is', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx, 'in_review');

    // A walk that moves nothing announces nothing.
    expect(await publishAnnounced(fx, card.id, 'v1.mock.html')).toEqual([]);

    expect(await statusOf(card.id)).toBe('in_review');
  });

  // ⚠️ THE ONE MOVE THAT WOULD BE A DEMOTION. `approved` outranks In Review, and
  // a republish there is the revise loop working — it must not drag the card
  // back down a rung on its way.
  it('never pulls a card at Approved back to In Review', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx, 'approved');

    // A walk that moves nothing announces nothing.
    expect(await publishAnnounced(fx, card.id, 'v1.mock.html')).toEqual([]);

    expect(await statusOf(card.id)).toBe('approved');
  });
  // ⚠️ THE EMIT WAITS FOR THE COMMIT. A publish that fails after the walk rolls the
  // hop back, and an event already sent for it would tell every consumer about a
  // move that never happened.
  it('announces nothing when the publish rolls back after the walk', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx, 'in_progress');
    const before = await transitionedEventsFor(card.id);
    // The re-read that closes the publish's transaction, after the walk has written.
    const reread = vi
      .spyOn(designEvidenceRepository, 'findById')
      .mockRejectedValueOnce(new Error('the publish fails after the walk'));

    try {
      await expect(publish(fx, card.id, 'v1.mock.html')).rejects.toThrow(
        'the publish fails after the walk',
      );
    } finally {
      reread.mockRestore();
    }

    expect(await statusOf(card.id)).toBe('in_progress');
    expect(await transitionedEventsFor(card.id)).toEqual(before);
  });
});

describe('a design card WITH an open linked pull request', () => {
  it('keeps the status the pull-request lifecycle gave it — the publish writes none', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx, 'implemented');
    await giveItAnOpenPullRequest(fx, card.id, 61);

    expect(await publishAnnounced(fx, card.id, 'v1.mock.html')).toEqual([]);

    // Implemented is TRUE here: a branch is pushed and CI decides when it is
    // reviewable. The whole defect was writing it on the card that has no such
    // branch, so the fix must not now take it off the card that does.
    expect(await statusOf(card.id)).toBe('implemented');
    expect(await awaitingDesignGates(card.id)).toBe(1);
  });

  it('leaves an In-Progress card alone — CI still owns the rungs above it', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx, 'in_progress');
    await giveItAnOpenPullRequest(fx, card.id, 62);

    expect(await publishAnnounced(fx, card.id, 'v1.mock.html')).toEqual([]);

    expect(await statusOf(card.id)).toBe('in_progress');
  });
});

// A pull request linked AFTER the publish (Bug MOTIR-6009's ordering case). The
// publish has already moved the card to In Review; the link hands the status
// back to the pull-request lifecycle, and it does so WITHOUT a second writer —
// linking moves nothing by itself, and the merge then closes the card through
// the status sync exactly as it closes any other In-Review card.
describe('a pull request linked after the publish', () => {
  it('changes nothing on its own, leaving the card where the sync expects it', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx, 'in_progress');

    await publish(fx, card.id, 'v1.mock.html');
    expect(await statusOf(card.id)).toBe('in_review');

    await giveItAnOpenPullRequest(fx, card.id, 63);

    // In Review is where a card with an open pull request sits between a green
    // check and its merge, so the card is already in the state the sync's
    // merge → `done` hop reads. Nothing was written twice to get there.
    expect(await statusOf(card.id)).toBe('in_review');
  });
});

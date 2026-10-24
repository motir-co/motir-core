import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { shaFor } from './helpers/commitShaFixtures';
import { ensureWorkWaitsOn } from '@/tests/helpers/designWaits';
import { truncateAuthTables } from './helpers/db';
import { transitionedEventsFor } from './helpers/transitionedEvents';

// THE DESIGN-APPROVAL SWITCH (Story MOTIR-693 · MOTIR-697;
// `docs/decisions/hosted-design-rerun-and-design-approval-switch.md` §2), against a
// REAL Postgres and the REAL publish path.
//
// What is asserted, and why each is its own case:
//
//   · ON (the default) is exactly `main`: an `awaiting` gate, routed to a person, the
//     card at In Review. A switch that silently changed the default would pass every
//     OFF test.
//   · OFF with no open pull request: the gate is still RAISED (a row exists) and is
//     APPROVED in the publish's own transaction with §2c's shape — no actor, no label,
//     routed to nobody, `system` + `project_setting` — the version PINNED (§6c), and
//     the card at `done`, which is what releases a dependent.
//   · OFF with an open pull request: the same approval, and the status effect a
//     person's approval has on that arm — nothing written (`merge_writes_done`); the
//     merge still follows `prMergeMode` (§2g).
//   · The switch is read at RAISE time (§2f): turning it off decides nothing already
//     waiting, and turning it back on affects only the next publish.
//
// ⚠️ ONE `vi.mock` — `@/lib/blob/uploader`, the one external every design-publish
// test stubs. Nothing about the gate, the switch or the approval is stubbed.

const store = new Map<string, { contentType: string; size: number }>();

vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { workItemsService } = await import('@/lib/services/workItemsService');

let fx: WorkItemFixture;
let card: WorkItem;

beforeEach(async () => {
  store.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Switch design approval off' },
    fx.ctx,
  );
  const subtask = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Draw the frame' },
    fx.ctx,
  );
  await workItemsService.updateStatus(subtask.id, 'in_progress', fx.ctx);
  card = await adminDb.workItem.findUniqueOrThrow({ where: { id: subtask.id } });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function setSwitch(designApprovalGate: boolean) {
  await adminDb.project.update({ where: { id: fx.projectId }, data: { designApprovalGate } });
}

/** Publish one design version through the real path; returns its evidence id. */
async function publish(label: string): Promise<string> {
  const pathname = `${designPrefix(fx.workspaceId, card.id)}${label}.mock.html`;
  store.set(pathname, { contentType: 'text/html', size: 2048 });
  const notePathname = `${designPrefix(fx.workspaceId, card.id)}${label}.design-notes.md`;
  store.set(notePathname, { contentType: 'text/markdown', size: 512 });
  await ensureWorkWaitsOn(card.id, fx);
  const evidence = await designEvidenceService.recordFromPathnames(
    {
      workItemId: card.id,
      assets: [
        { kind: 'mock', sourcePath: `design/work-items/${label}.mock.html`, pathname },
        {
          kind: 'note_file',
          sourcePath: 'design/work-items/design-notes.md',
          pathname: notePathname,
        },
      ],
      commitSha: shaFor(label),
    },
    fx.ctx,
  );
  return evidence.id;
}

async function gateFor(evidenceId: string) {
  return adminDb.approvalGate.findFirstOrThrow({
    where: { subjectId: evidenceId, kind: 'design_result' },
  });
}

async function cardStatus(): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).status;
}

/** Link an OPEN pull request to the card — Workflow B (ADR §8). */
async function openPullRequest() {
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: 'inst-697',
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
      repoId: 'repo-697',
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number: 697,
      title: 'draw the frame',
      state: 'open',
      headRef: 'design/frame',
      baseRef: 'main',
      provider: 'github',
    },
  });
  await adminDb.workItemDelivery.create({
    data: {
      workspaceId: fx.workspaceId,
      workItemId: card.id,
      githubPullRequestId: pr.id,
      repoId: repo.id,
    },
  });
}

describe('design approval ON (the default) — unchanged from main', () => {
  it('defaults every project to ON', async () => {
    const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(project.designApprovalGate).toBe(true);
  });

  it('raises an awaiting gate routed to a person, and the card waits in review', async () => {
    const gate = await gateFor(await publish('frame'));
    expect(gate.state).toBe('awaiting');
    expect(gate.decisionSource).toBeNull();
    expect(gate.routedToId).not.toBeNull();
    expect(await cardStatus()).toBe('in_review');
  });
});

describe('design approval OFF — the gate is raised AND approved by the system, on the record', () => {
  it('with no open pull request: §2c row, the version pinned, the card done', async () => {
    await setSwitch(false);
    const evidenceId = await publish('frame');

    const gate = await gateFor(evidenceId);
    expect(gate.state).toBe('approved');
    expect(gate.decidedById).toBeNull();
    expect(gate.decidedByLabel).toBeNull();
    expect(gate.routedToId).toBeNull();
    expect(gate.decisionSource).toBe('system');
    expect(gate.decidedUnderAuthority).toBe('project_setting');
    expect(gate.decidedAt).not.toBeNull();
    expect(gate.noteMd).toBeNull();
    expect(gate.subjectVersion).toBe(shaFor('frame'));
    expect(gate.outcomeRef).toBe('done');

    // §6c: an approval keeps the bytes it was given on.
    const evidence = await adminDb.designEvidence.findUniqueOrThrow({ where: { id: evidenceId } });
    expect(evidence.pinnedAt).not.toBeNull();

    expect(await cardStatus()).toBe('done');

    // The system approval's `done` is announced once the publish commits, with the
    // revision it wrote (Bug MOTIR-9415). Only that hop is asserted: the publish's own
    // walk to review is a different writer.
    const [doneHop] = await adminDb.workItemRevision.findMany({
      where: { workItemId: card.id, diff: { path: ['status', 'to'], equals: 'done' } },
    });
    const announced = (await transitionedEventsFor(card.id)).filter(
      (event) => event.toStatusKey === 'done',
    );
    expect(announced).toEqual([
      expect.objectContaining({
        workspaceId: fx.workspaceId,
        workItemId: card.id,
        actorId: fx.ctx.userId,
        fromStatusKey: 'in_review',
        revisionId: doneHop!.id,
      }),
    ]);
  });

  it('with an open pull request: approved, and no status written — the merge writes done', async () => {
    await setSwitch(false);
    await openPullRequest();
    const gate = await gateFor(await publish('frame'));

    expect(gate.state).toBe('approved');
    expect(gate.decisionSource).toBe('system');
    expect(gate.decidedUnderAuthority).toBe('project_setting');
    // The arm a person's approval takes when a merge is coming (designResultHandler):
    // it records the decision and writes no status.
    expect(gate.outcomeRef).toBeNull();
    expect(await cardStatus()).not.toBe('done');
  });

  it('never leaves an awaiting design gate behind', async () => {
    await setSwitch(false);
    await publish('frame');
    const awaiting = await adminDb.approvalGate.count({
      where: { workItemId: card.id, kind: 'design_result', state: 'awaiting' },
    });
    expect(awaiting).toBe(0);
  });
});

describe('the switch is read at RAISE time (§2f)', () => {
  it('turning it OFF decides nothing already waiting', async () => {
    const gate = await gateFor(await publish('frame'));
    await setSwitch(false);

    const reread = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(reread.state).toBe('awaiting');
    expect(await cardStatus()).toBe('in_review');
  });

  it('turning it back ON makes the next publish wait for a person again', async () => {
    await setSwitch(false);
    await publish('v1');
    // v1 was approved, so the card is done; reopen it as a person would before a
    // revised design can be published (a closed card takes no new version).
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'in_progress' } });
    await setSwitch(true);

    const gate = await gateFor(await publish('v2'));
    expect(gate.state).toBe('awaiting');
    expect(gate.decisionSource).toBeNull();
  });
});

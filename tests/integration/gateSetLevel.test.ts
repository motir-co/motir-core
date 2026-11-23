import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { shaFor } from '../helpers/commitShaFixtures';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';
import { makeWorkWaitOn } from '@/tests/helpers/designWaits';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';

// THE LEVEL'S ASSEMBLED GATE (Bug MOTIR-5652 · Subtask MOTIR-5668), on a REAL
// Postgres through the real webhook, publish and status doors.
//
// ⚠️ IT VERIFIES WHAT NO SINGLE CHILD CAN: the COMPOSITION. Each code child
// covers its own change; the original defect lived between two of them —
// independently-correct pieces that only produced a hole together. Read the
// report's own list: CI green, card promoted to In Review, pull request linked
// and clean, design rendered on the page. Every automated signal agreed the card
// was fine. The only thing that disagreed was a person looking for a button.
//
// ⚠️ AND THE FIXTURE WAS ASSERTED RED FIRST, on a worktree at the merge base
// (`525616391`), with this file's parent-run block copied in verbatim:
//
//     × the child holds TWO gates — the design PRIMARY, its merge gate beside it
//       AssertionError: expected [] to deeply equal [ 'design_result', …(1) ]
//     × and the run target is still the ANCESTOR — the gate is raised DESPITE it
//       AssertionError: expected [] to include 'pull_request_approval'
//
// **ZERO gates**, which is the defect. A test written after a fix proves the code
// does what its author just wrote; the same test against the broken tree proves it
// would have caught what got past everyone.
//
// The container-gate case PASSED on both trees, and that is the other half worth
// recording: the parent being held below `implemented` by its open child is the
// container gate WORKING, not part of what this level changes.

const store = new Map<string, { contentType: string; size: number }>();
const sent: Array<{ name: string; data: Record<string, unknown> }> = [];

vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { resolveRunTargetFor } = await import('@/lib/services/runTarget');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-level-gate';
const REPO_PROVIDER_ID = '667';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function makeScenario(email: string) {
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
  // These cases pin a child asked about its OWN pull request; with "Complete children when
  // a parent is done" on, a link also writes it on the story (MOTIR-11835). Off, so the
  // child keeps a set of its own.
  await adminDb.project.update({
    where: { id: project.id },
    data: { autoCompleteChildrenOnParentDone: false },
  });
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: REPO_PROVIDER_ID,
        owner: 'moooon',
        name: 'acme',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { user, workspace, project, ctx: { userId: user.id, workspaceId: workspace.id } };
}

const ci = (opts: {
  conclusion: string | null;
  headSha: string;
  number: number;
  status?: string;
}) =>
  githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: opts.headSha,
      head_branch: null,
      status: opts.status ?? 'completed',
      conclusion: opts.conclusion,
      app: { slug: 'github-actions' },
      pull_requests: [{ number: opts.number }],
    },
  });

async function openLinked(identifier: string, number: number, headRef: string) {
  await linkPrByIdentifier({ identifier, owner: 'moooon', name: 'acme', number, headRef });
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: `A change (${headRef})`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

async function publish(s: Scenario, itemId: string, label: string) {
  const prefix = designPrefix(s.workspace.id, itemId);
  store.set(`${prefix}${label}.mock.html`, { contentType: 'text/html', size: 2048 });
  store.set(`${prefix}${label}.design-notes.md`, { contentType: 'text/markdown', size: 512 });
  return designEvidenceService.recordFromPathnames(
    {
      workItemId: itemId,
      assets: [
        {
          kind: 'mock',
          sourcePath: `design/work-items/${label}.mock.html`,
          pathname: `${prefix}${label}.mock.html`,
        },
        {
          kind: 'note_file',
          sourcePath: 'design/work-items/design-notes.md',
          pathname: `${prefix}${label}.design-notes.md`,
        },
      ],
      commitSha: shaFor(label),
    },
    s.ctx,
  );
}

const gatesOf = (workItemId: string) =>
  adminDb.approvalGate.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });

const awaitingKinds = async (workItemId: string) =>
  (await gatesOf(workItemId)).filter((g) => g.state === 'awaiting').map((g) => g.kind);

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

beforeEach(async () => {
  store.clear();
  sent.length = 0;
  await truncateAuthTables();
  _resetInstallationTokenCache();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('THE PARENT-RUN FIXTURE — the shape MOTIR-5652 was found in', () => {
  /**
   * A container run with a design stopper, built exactly as the bug describes:
   *
   *  · a CONTAINER with two children, one still below `implemented` — so
   *    `ContainerHasOpenChildrenError` skips the container's own promotion;
   *  · the How-to-test record written ONCE onto the container — so every child's
   *    run target resolves to `{ kind: 'ancestor' }`;
   *  · a child `design` card with a published result AND an open linked pull
   *    request, green.
   *
   * The shape is ORDINARY, which is the point: a design merges early precisely so
   * the rest of the story can be built, which makes it the commonest way a design
   * card ever meets an open pull request — and it was the one combination nobody
   * had written down.
   */
  async function parentRunWithDesignStopper(email: string) {
    const s = await makeScenario(email);
    const story = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'story', title: 'The story' },
      s.ctx,
    );
    const design = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Draw the frame', parentId: story.id },
      s.ctx,
    );
    const sibling = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Build to it', parentId: story.id },
      s.ctx,
    );
    // The sibling stays at `todo`, below `implemented` — the container gate.
    await workItemsService.updateStatus(design.id, 'in_progress', s.ctx);
    await makeWorkWaitOn(design.id, { projectId: s.project.id, ctx: s.ctx });

    // ONE How-to-test record, on the PARENT. This is what makes every child's run
    // target an ancestor — and what the merge gate used to refuse on.
    await adminDb.testInstructions.create({
      data: {
        workspaceId: s.workspace.id,
        projectId: s.project.id,
        workItemId: story.id,
        bodyMd: '## Open the page',
      },
    });

    await openLinked(design.identifier, 71, `parent/${story.identifier}-work`);
    const evidence = await publish(s, design.id, 'v1');
    await ci({ conclusion: 'success', headSha: 'sha-green', number: 71 });
    return { s, story, design, sibling, evidence };
  }

  it('the child holds TWO gates — the design PRIMARY, its merge gate beside it', async () => {
    const { design, evidence } = await parentRunWithDesignStopper('level-parent@example.com');

    // ⚠️ THE ASSERTION THAT WAS ZERO BEFORE THIS LEVEL. Two independently-reasoned
    // refusals produced it: the design gate was suppressed because the merge gate
    // would carry the decision (AMENDMENT 4 Q8), and the merge gate then refused
    // because the card was not the run target.
    expect(await awaitingKinds(design.id)).toEqual(['design_result', 'pull_request_approval']);

    const [designGate, mergeGate] = await gatesOf(design.id);
    // The design gate's subject is the EVIDENCE; the merge gate's is the CARD.
    expect(designGate).toMatchObject({ subjectId: evidence.id, subjectVersion: shaFor('v1') });
    expect(mergeGate).toMatchObject({
      subjectId: design.id,
      subjectVersion: 'moooon/acme#71@sha-green',
    });
  });

  it('and the run target is still the ANCESTOR — the gate is raised DESPITE it', async () => {
    // `resolveRunTargetFor` answers *whose How to test is this*, which is true and
    // useful. It was never an answer to *does this card have something to decide*,
    // and using it as one is half of MOTIR-5652.
    const { s, story, design } = await parentRunWithDesignStopper('level-target@example.com');

    const target = await withWorkspaceContext(s.ctx, async (tx) =>
      resolveRunTargetFor(await tx.workItem.findUniqueOrThrow({ where: { id: design.id } }), tx),
    );

    expect(target).toMatchObject({ kind: 'ancestor', holder: { id: story.id } });
    expect(await awaitingKinds(design.id)).toContain('pull_request_approval');
  });

  it('the CONTAINER itself is still held below `implemented` by its open child', async () => {
    // The other half of the original hole: the ancestor cannot absorb the question
    // either, because its own promotion is skipped while a child is unimplemented.
    // That is the container gate WORKING — it is not what this level changes.
    const { story, sibling } = await parentRunWithDesignStopper('level-container@example.com');

    expect(await statusOf(sibling.id)).toBe('todo');
    expect(await statusOf(story.id)).not.toBe('in_review');
    expect(await awaitingKinds(story.id)).toEqual([]);
  });
});

describe('THE SIX DEFECTS, as states this level makes unreachable', () => {
  // Not a re-test of the six fixes — each was fixed at a call site, and this
  // level's claim is that each is now unreachable because the answer comes from
  // ONE place. Each case is a card STATE, and names the defect it came from.

  async function cardWithPr(email: string, number: number) {
    const s = await makeScenario(email);
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await openLinked(item.identifier, number, `subtask/${item.identifier}-${number}`);
    return { s, item };
  }

  it('MOTIR-5574 — a WITHDRAWN design result leaves nothing asking about it', async () => {
    const s = await makeScenario('level-5574@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A design' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await makeWorkWaitOn(item.id, { projectId: s.project.id, ctx: s.ctx });
    await publish(s, item.id, 'v1');
    expect(await awaitingKinds(item.id)).toEqual(['design_result']);

    await designEvidenceService.withdrawCurrentForWorkItem({ workItemId: item.id }, s.ctx);

    expect(await awaitingKinds(item.id)).toEqual([]);
    expect((await gatesOf(item.id)).map((g) => g.supersededCause)).toEqual(['withdrawn']);
  });

  it('MOTIR-5586 / MOTIR-5651 — every superseded row carries a cause; no live path writes none', async () => {
    // The two bugs are the same false sentence on two surfaces, and both were
    // repaired by making the sentence vaguer — the only repair available while the
    // row was silent. The claim now is stronger than any one sentence: no live path
    // can leave a withdrawal unexplained, because the argument is REQUIRED.
    const { s, item } = await cardWithPr('level-5586@example.com', 72);
    await ci({ conclusion: 'success', headSha: 'sha-a', number: 72 });
    await githubWebhookService.handleEvent('pull_request', {
      action: 'synchronize',
      installation: INSTALLATION,
      repository: { id: Number(REPO_PROVIDER_ID) },
      pull_request: {
        number: 72,
        state: 'open',
        merged: false,
        title: 'A change',
        head: { ref: `subtask/${item.identifier}-72`, sha: 'sha-b' },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);

    const superseded = (await gatesOf(item.id)).filter((g) => g.state === 'superseded');
    expect(superseded.length).toBeGreaterThan(0);
    for (const gate of superseded) {
      expect(`${gate.kind}: ${gate.supersededCause}`).not.toBe(`${gate.kind}: null`);
    }
  });

  it('MOTIR-5603 — no card state produces TWO merge gates', async () => {
    const { item } = await cardWithPr('level-5603@example.com', 73);
    await ci({ conclusion: 'success', headSha: 'sha-a', number: 73 });
    // Every occasion that could raise one, back to back: a redelivered verdict, a
    // late check row at the same head, and a status move inside the band.
    await ci({ conclusion: 'success', headSha: 'sha-a', number: 73 });
    await ci({ conclusion: 'success', headSha: 'sha-a', number: 73 });

    const merge = (await gatesOf(item.id)).filter((g) => g.kind === 'pull_request_approval');
    expect(merge.filter((g) => g.state === 'awaiting')).toHaveLength(1);
    expect(merge).toHaveLength(1);
  });

  it('MOTIR-5604 — a push then a green leaves exactly ONE fresh merge gate', async () => {
    const { item } = await cardWithPr('level-5604@example.com', 74);
    await ci({ conclusion: 'success', headSha: 'sha-a', number: 74 });
    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-b', number: 74 });
    expect(await awaitingKinds(item.id)).toEqual([]);

    await ci({ conclusion: 'success', headSha: 'sha-b', number: 74 });

    const merge = (await gatesOf(item.id)).filter((g) => g.kind === 'pull_request_approval');
    expect(merge.map((g) => [g.state, g.subjectVersion])).toEqual([
      ['superseded', 'moooon/acme#74@sha-a'],
      ['awaiting', 'moooon/acme#74@sha-b'],
    ]);
  });

  it('MOTIR-5632 — the same commits are never asked about twice', async () => {
    const { s, item } = await cardWithPr('level-5632@example.com', 75);
    await ci({ conclusion: 'success', headSha: 'sha-a', number: 75 });
    const [gate] = await gatesOf(item.id);
    const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
    await approvalGatesService.decide(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate!.id, decision: 'approve', source: 'ui' },
      s.ctx,
    );

    // A later green at the SAME head, which is what an approved card in the merge
    // queue produces. It must not re-ask about what a person has just answered.
    await ci({ conclusion: 'success', headSha: 'sha-a', number: 75 });

    expect(await awaitingKinds(item.id)).toEqual([]);
    expect((await gatesOf(item.id)).map((g) => g.state)).toEqual(['approved']);
  });
});

describe("THE TRIGGER SEQUENCE — MOTIR-4910 / PR #2935's shape, with NO new CI delivery", () => {
  it('a card green before it was eligible gets its gate on the transition alone', async () => {
    // ⚠️ AND THE CARD THIS WAS WRITTEN FROM IS NOT AN INSTANCE OF A DEFECT. PR
    // #2935 was read as a live failure and it is not: a `manual` child still `todo`
    // correctly holds its parent below `implemented`, so having no *To approve*
    // record there is the container gate working. What is driven here is what
    // happens AFTER that child lands and the parent flips — which is the state
    // MOTIR-5670 measured, and the residual it found.
    const s = await makeScenario('level-trigger@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Green before eligible' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await openLinked(item.identifier, 76, `subtask/${item.identifier}-76`);
    // Since MOTIR-12094 a green landing on `in_progress` promotes, so the verdict lands
    // while the card waits at `blocked`; the row is put back as a fixture, no door.
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'blocked' } });
    await ci({ conclusion: 'success', headSha: 'sha-early', number: 76 });
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'in_progress' } });
    expect(await awaitingKinds(item.id)).toEqual([]);

    // The flip, by hand, straight to review — the rung the CI-green latch does not
    // watch. No CI delivery of any kind between here and the assertion.
    await workItemsService.updateStatus(item.id, 'in_review', s.ctx);

    const [gate] = await gatesOf(item.id);
    expect(gate).toMatchObject({
      kind: 'pull_request_approval',
      state: 'awaiting',
      subjectVersion: 'moooon/acme#76@sha-early',
    });
  });

  it('and a card no event will ever reach is repaired by ONE reconcile pass', async () => {
    // The mirror: the backstop. A LOST delivery costs a card its gate exactly as it
    // costs it a merge, and nothing else ever asks again.
    const s = await makeScenario('level-sweep@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Nobody will ask again' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await openLinked(item.identifier, 77, `subtask/${item.identifier}-77`);
    // The green verdict arrived and its gate did not — a state no door produces,
    // which is what makes this a repair rather than a raise.
    const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 77 } });
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: pr.id,
        commitSha: 'sha-lost',
        checkName: 'ci / vitest',
        conclusion: 'success',
      },
    });
    await adminDb.approvalGate.deleteMany({ where: { workItemId: item.id } });
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'in_review' } });
    expect(await gatesOf(item.id)).toEqual([]);

    const { reconcileGatesFor } = await import('@/lib/services/gateSetFor');
    const raised = await withWorkspaceContext(s.ctx, async (tx) =>
      reconcileGatesFor(await tx.workItem.findUniqueOrThrow({ where: { id: item.id } }), tx),
    );

    expect(raised).toEqual(['pull_request_approval']);
    expect(await awaitingKinds(item.id)).toEqual(['pull_request_approval']);
  });
});

describe('THE WRITER → CONSUMER SEAM — a real supersede, through the cause column, into the DTO', () => {
  it('the cause a service wrote is the cause the surfaces read', async () => {
    const { toApprovalGateDto } = await import('@/lib/mappers/approvalGateMappers');
    const s = await makeScenario('level-seam@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A design' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await makeWorkWaitOn(item.id, { projectId: s.project.id, ctx: s.ctx });
    const v1 = await publish(s, item.id, 'v1');

    await publish(s, item.id, 'v2');

    const withdrawn = await adminDb.approvalGate.findFirstOrThrow({ where: { subjectId: v1.id } });
    // The whole chain in one assertion: the publish path chose `republished`, the
    // required argument carried it, the column stored it, and the mapper puts it on
    // the wire as a value rather than collapsing it to a null.
    expect(toApprovalGateDto(withdrawn)).toMatchObject({
      state: 'superseded',
      supersededCause: 'republished',
    });
  });
});

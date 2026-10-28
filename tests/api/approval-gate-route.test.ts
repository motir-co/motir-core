import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { shaFor } from '../helpers/commitShaFixtures';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { UNREGISTERED_GATE_KINDS } from '@/lib/approvalGates/registry';
import { TWO_FACTOR_REQUIRED_PATH } from '@/lib/auth/twoFactorGate';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { ensureWorkWaitsOn } from '@/tests/helpers/designWaits';
import { truncateAuthTables } from '../helpers/db';
import { setWorkspaceRoleFor } from '../helpers/workspaceRoleFixtures';
import { projectAccessData, setProjectAccess } from '@/tests/helpers/projectAccess';

// MOTIR-5223 — `GET /api/work-items/approval-gate?key=&kind=`, the read the
// approval OVERLAY (MOTIR-5214) makes from the browser.
//
// Against REAL Postgres and the real services, in the shape
// `tests/api/planning-anchor-route.test.ts` uses: the only stubs are the two
// context resolvers a Vitest process cannot supply through cookies, plus the ONE
// external the design-publish path touches — `@/lib/blob/uploader`, the same
// narrow mock `tests/approval-gate-decided-read.test.ts` records — so a
// `design_result` gate here is raised by a REAL publish, not hand-written.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getSession: async () => session.current };
});
vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return { ...actual, getActiveProject: async () => activeCtx.current };
});

const store = new Map<string, { contentType: string; size: number }>();
vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { GET: gateRoute } = await import('@/app/api/work-items/approval-gate/route');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { approvalGateRepository } = await import('@/lib/repositories/approvalGateRepository');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { acceptanceEvidenceService } = await import('@/lib/services/acceptanceEvidenceService');

let fx: WorkItemFixture;

beforeEach(async () => {
  store.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  session.current = null;
  activeCtx.current = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Actor = { id: string; email: string };

/** Sign `actor` in with `on`'s project active — the fixture's own by default. */
function signIn(actor: Actor, on: WorkItemFixture = fx, access?: 'members') {
  session.current = { user: { id: actor.id, email: actor.email, name: 'Ada Lovelace' } };
  activeCtx.current = {
    userId: actor.id,
    workspaceId: on.workspaceId,
    projectId: on.projectId,
    project: { ...on.project, ...(access ? projectAccessData(access) : {}) },
  } as ProjectContext;
}

function gateViaRoute(params: { key?: string; kind?: string }): Promise<Response> {
  const qs = new URLSearchParams();
  if (params.key !== undefined) qs.set('key', params.key);
  if (params.kind !== undefined) qs.set('kind', params.kind);
  return gateRoute(new Request(`http://localhost:3000/api/work-items/approval-gate?${qs}`));
}

/** A design subtask sitting where a published design waits: In Review. */
async function designCard(): Promise<WorkItem> {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Decide it full screen' },
    fx.ctx,
  );
  const subtask = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Draw the overlay' },
    fx.ctx,
  );
  await workItemsService.updateStatus(subtask.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(subtask.id, 'in_review', fx.ctx);
  return adminDb.workItem.findUniqueOrThrow({ where: { id: subtask.id } });
}

/** A REAL publish — it raises the card's `awaiting` design gate itself. */
async function publish(card: WorkItem) {
  const pathname = `${designPrefix(fx.workspaceId, card.id)}overlay.mock.html`;
  store.set(pathname, { contentType: 'text/html', size: 2048 });
  const notePathname = `${designPrefix(fx.workspaceId, card.id)}overlay.design-notes.md`;
  store.set(notePathname, { contentType: 'text/markdown', size: 512 });
  // AMENDMENT 4: a result is the mock plus ONE note file, published only while
  // an open work item is `blocked_by` the card.
  await ensureWorkWaitsOn(card.id, fx);
  return designEvidenceService.recordFromPathnames(
    {
      workItemId: card.id,
      assets: [
        { kind: 'mock', sourcePath: 'design/workbench/overlay.mock.html', pathname },
        {
          kind: 'note_file',
          sourcePath: 'design/workbench/design-notes.md',
          pathname: notePathname,
        },
      ],
      commitSha: shaFor('overlay'),
    },
    fx.ctx,
  );
}

/**
 * A STORY in review with a published acceptance RECEIPT — a REAL publish through the
 * mint-then-register door, so the story's `awaiting` acceptance gate is raised by the
 * product rather than written here (Story MOTIR-4949 · Subtask MOTIR-5792).
 */
async function storyWithReceipt() {
  const created = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Hold a basket for fifteen minutes' },
    fx.ctx,
  );
  await workItemsService.updateStatus(created.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(created.id, 'in_review', fx.ctx);
  const story = await adminDb.workItem.findUniqueOrThrow({ where: { id: created.id } });
  const tokens = await acceptanceEvidenceService.createUploadTokens(
    { workItemId: story.id, hasTrace: false },
    fx.ctx,
  );
  store.set(tokens.video.pathname, { contentType: 'video/webm', size: 4096 });
  const receipt = await acceptanceEvidenceService.recordFromPathnames(
    {
      workItemId: story.id,
      videoPathname: tokens.video.pathname,
      chapters: [{ label: 'Open the story', tSeconds: 0 }],
      commitSha: shaFor('receipt'),
    },
    fx.ctx,
  );
  return { story, receipt };
}

/** A gate row written directly, for the shapes no shipped path creates yet. */
async function rawGate(card: WorkItem, kind: string, subjectId: string) {
  return withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: card.id,
        kind: kind as 'design_result',
        subjectId,
      },
      tx,
    ),
  );
}

let repoSeq = 0;

/**
 * A repository with one pull request whose latest check ran green, DELIVERED by
 * `item` — the seed `tests/approval-gate-pull-request-approval-kind.test.ts` uses.
 */
async function deliver(item: { id: string }, opts: { name: string; number: number }) {
  repoSeq += 1;
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: `inst-5439-${repoSeq}`,
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
      repoId: `repo-5439-${repoSeq}`,
      owner: 'acme',
      name: opts.name,
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number: opts.number,
      title: `Change in ${opts.name}`,
      state: 'open',
      merged: false,
      headRef: 'parent/ACME-12-throttle',
      baseRef: 'main',
      provider: 'github',
    },
  });
  await adminDb.githubCheckRun.create({
    data: {
      pullRequestId: pr.id,
      commitSha: `${opts.name}-head-${repoSeq}`.padEnd(40, '0'),
      checkName: 'Vitest',
      conclusion: 'success',
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
  return pr;
}

/** A story in review whose run delivered to TWO repositories. */
async function twoRepoStory(): Promise<WorkItem> {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Throttle the public API' },
    fx.ctx,
  );
  await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(story.id, 'in_review', fx.ctx);
  await deliver(story, { name: 'web', number: 7 });
  await deliver(story, { name: 'api', number: 12 });
  return adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } });
}

/** A workspace member with no administrative role and no relationship to the card. */
async function plainMember(): Promise<Actor> {
  const user = await createTestUser();
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
  });
  return { id: user.id, email: user.email };
}

const owner = (): Actor => ({ id: fx.owner.id, email: fx.owner.email });

describe('GET /api/work-items/approval-gate · the four subject answers', () => {
  it('a published design: the gate, canDecide, the waiting-on name and the RESOLVED subject', async () => {
    const card = await designCard();
    const evidence = await publish(card);
    signIn(owner());

    const res = await gateViaRoute({ key: card.identifier, kind: 'design_result' });
    expect(res.status).toBe(200);
    const body = await res.json();

    // The card's status and, for a design, its parent — the header chip and where a
    // Re-plan opens (MOTIR-6427). This fixture's card sits under a story.
    expect(body.workItem).toMatchObject({
      id: card.id,
      identifier: card.identifier,
      title: card.title,
      status: card.status,
    });
    const story = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.parentId! } });
    expect(body.workItem.parentIdentifier).toBe(story.identifier);
    // The project's workflow, to label the chip before and after a press (MOTIR-6427).
    expect(body.statuses).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'todo', isInitial: true })]),
    );
    expect(body.gate).toMatchObject({
      workItemId: card.id,
      kind: 'design_result',
      state: 'awaiting',
      subjectId: evidence.id,
    });
    // The fixture owner REPORTED the card and nobody is assigned — §2's
    // reporter arm, so this reader may press the verbs.
    expect(body.canDecide).toBe(true);
    // The owner may plan on a live card — a refused decision's record would offer
    // Re-plan with AI (MOTIR-6211), the same condition `WorkItemPlanEntrance` draws under.
    expect(body.canReplan).toBe(true);
    expect(typeof body.routedToLabel).toBe('string');
    // The overlay's copy of the merge gate's spent approval (MOTIR-5863): always on the
    // wire — JSON drops an `undefined`, so a route that forgot it answers undefined here —
    // and null for any gate that is not a re-asked merge question.
    expect(body.earlierApproval).toBeNull();
    expect(body.subject.state).toBe('resolved');
    expect(body.subject.kind).toBe('design_result');
    expect(body.subject.evidence.id).toBe(evidence.id);
    // Only an approval pins; an awaiting version keeps nothing yet.
    expect(body.subject.filesKept).toBe(false);
  });

  it('a card with NO gate of that kind is a 200 saying so — not a 404', async () => {
    const card = await designCard();
    signIn(owner());

    const res = await gateViaRoute({ key: card.identifier, kind: 'design_result' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.gate).toBeNull();
    expect(body.canDecide).toBe(false);
    expect(body.subject).toEqual({ state: 'no_gate' });
  });

  it('a gate whose subject no longer resolves is GONE — distinct from no gate', async () => {
    const card = await designCard();
    const gate = await rawGate(card, 'design_result', 'design-evidence-that-was-reclaimed');
    signIn(owner());

    const body = await (await gateViaRoute({ key: card.identifier, kind: 'design_result' })).json();
    expect(body.gate.id).toBe(gate.id);
    expect(body.subject).toEqual({ state: 'gone' });
  });

  it('a subject belonging to a DIFFERENT card is gone too — the cross-card guard holds', async () => {
    const other = await designCard();
    const foreign = await publish(other);
    const card = await designCard();
    await rawGate(card, 'design_result', foreign.id);
    signIn(owner());

    const body = await (await gateViaRoute({ key: card.identifier, kind: 'design_result' })).json();
    expect(body.subject).toEqual({ state: 'gone' });
  });

  // `plan_approval` WAS listed here as unregistered-but-card-less and filtered out; MOTIR-6035
  // registered it, so the constant no longer holds it and the filter went with it. Its
  // card-less case below is unchanged.
  it.each(UNREGISTERED_GATE_KINDS)(
    'an UNREGISTERED kind (%s) returns the gate and the not-built-yet answer — never a throw',
    async (kind) => {
      const card = await designCard();
      const gate = await rawGate(card, kind, `subject-${kind}`);
      signIn(owner());

      const res = await gateViaRoute({ key: card.identifier, kind });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.gate).toMatchObject({ id: gate.id, kind });
      expect(body.subject).toEqual({ state: 'kind_not_built' });
      // No handler to route by, so §2's shared rule names the reporter.
      expect(typeof body.routedToLabel).toBe('string');
    },
  );

  it('`plan_approval` answers `kind_not_built` on any card — the overlay is never its surface (MOTIR-6034, §11.5b)', async () => {
    // A plan gate belongs to NO card, so an address naming a card can never find one;
    // `no_gate` would tell the reader the card simply has nothing to decide. A real
    // card-less plan gate in the project must not leak into this card's frame either.
    const card = await designCard();
    await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: null,
        kind: 'plan_approval',
        subjectId: 'plan-1',
        routedToId: fx.ownerId,
      },
    });
    signIn(owner());

    const res = await gateViaRoute({ key: card.identifier, kind: 'plan_approval' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.gate).toBeNull();
    expect(body.canDecide).toBe(false);
    expect(body.subject).toEqual({ state: 'kind_not_built' });
  });

  it('the REGISTERED merge kind returns its gate and the not-built answer — its port is MOTIR-4909s (MOTIR-4793)', async () => {
    // `pull_request_merge` has a handler now, so it is no longer in
    // `UNREGISTERED_GATE_KINDS` above. The overlay still has no PORT for it, and the
    // route says so with the same state rather than inventing a resolved subject.
    const card = await designCard();
    const gate = await rawGate(card, 'pull_request_merge', 'subject-merge');
    signIn(owner());

    const res = await gateViaRoute({ key: card.identifier, kind: 'pull_request_merge' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.gate).toMatchObject({ id: gate.id, kind: 'pull_request_merge' });
    expect(body.subject).toEqual({ state: 'kind_not_built' });
  });

  it('a MANUAL card resolves to its to-do list, read-only, and whether a merge writes Done (MOTIR-7478)', async () => {
    const { workItemTodosService } = await import('@/lib/services/workItemTodosService');
    const created = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Create the production Stripe account',
        type: 'manual',
        executor: 'human',
      },
      fx.ctx,
    );
    const card = await adminDb.workItem.findUniqueOrThrow({ where: { id: created.id } });
    const first = await workItemTodosService.addTodo(card.id, { text: 'Sign in' }, fx.ctx);
    await workItemTodosService.addTodo(card.id, { text: 'Turn on live mode' }, fx.ctx);
    await workItemTodosService.setTodoDone(first.todo.id, true, fx.ctx);
    const gate = await rawGate(card, 'manual_work', card.id);
    signIn(owner());

    const res = await gateViaRoute({ key: card.identifier, kind: 'manual_work' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.gate).toMatchObject({ id: gate.id, kind: 'manual_work' });
    expect(body.subject).toMatchObject({
      state: 'resolved',
      kind: 'manual_work',
      manualWork: { progress: { done: 1, total: 2 }, mergeWritesDone: false },
    });
    expect(
      body.subject.manualWork.todos.map((t: { text: string; done: boolean }) => [t.text, t.done]),
    ).toEqual([
      ['Sign in', true],
      ['Turn on live mode', false],
    ]);
  });

  it('the APPROVE-TO-MERGE gate resolves to the Development block: both pull requests, the delivery set and How to test (MOTIR-5439)', async () => {
    const story = await twoRepoStory();
    // The approve-and-merge gate's subject is the card's delivery set, so its
    // `subjectId` is the work item's own id (`pullRequestApprovalHandler`).
    const gate = await rawGate(story, 'pull_request_approval', story.id);
    signIn(owner());

    const res = await gateViaRoute({ key: story.identifier, kind: 'pull_request_approval' });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.gate).toMatchObject({
      id: gate.id,
      kind: 'pull_request_approval',
      state: 'awaiting',
    });
    expect(body.canDecide).toBe(true);
    expect(body.subject.state).toBe('resolved');
    expect(body.subject.kind).toBe('pull_request_approval');
    // Both repositories' pull requests, in the shape the item page's Development
    // section reads — the SAME service call, so the two surfaces cannot disagree.
    expect(
      body.subject.pullRequests
        .map((pr: { number: number }) => pr.number)
        .sort((a: number, b: number) => a - b),
    ).toEqual([7, 12]);
    expect(body.subject.pullRequests).toEqual(
      JSON.parse(JSON.stringify(await workItemsService.listLinkedPullRequests(story.id, fx.ctx))),
    );
    expect(body.subject.deliveries).toHaveLength(2);
    const view = await workItemsService.getDeliveryView(story.id, story.targetRepos, fx.ctx);
    expect(body.subject.repoDelivery).toEqual(JSON.parse(JSON.stringify(view.repos)));
    // No run wrote How to test here: the DTO's own answer, not an error.
    expect(body.subject.howToTest.state).toBe('record_missing');
    expect(body.subject.designEvidence).toBeNull();
    expect(body.subject.isDesignCard).toBe(false);
    // Awaiting: nothing has merged, so there is nothing a reload knows per member.
    expect(body.subject.members).toEqual([]);
  });

  it('an AGENT REVIEW is ported by the Development block, with the review’s own state beside it (§12.3)', async () => {
    // The overlay is where *Continue without the review* is decided (MOTIR-6323's rule), so
    // an `agent_review` address resolves: the delivery set it reviewed, and the review's
    // state read by the SAME service the item page reads it with — never `kind_not_built`.
    const story = await twoRepoStory();
    const gate = await rawGate(story, 'agent_review', story.id);
    await adminDb.approvalGate.update({
      where: { id: gate.id },
      data: { reviewUnavailableReason: 'hosted_run_out_of_credits' },
    });
    signIn(owner());

    const res = await gateViaRoute({ key: story.identifier, kind: 'agent_review' });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.gate).toMatchObject({ id: gate.id, kind: 'agent_review', state: 'awaiting' });
    expect(body.subject).toMatchObject({ state: 'resolved', kind: 'pull_request_approval' });
    expect(
      body.subject.pullRequests
        .map((pr: { number: number }) => pr.number)
        .sort((a: number, b: number) => a - b),
    ).toEqual([7, 12]);
    expect(body.subject.agentReview).toMatchObject({
      gate: { id: gate.id, kind: 'agent_review' },
      reviewUnavailableReason: 'hosted_run_out_of_credits',
    });
    const { agentReviewViewService } = await import('@/lib/services/agentReviewViewService');
    expect(body.subject.agentReview).toEqual(
      JSON.parse(JSON.stringify(await agentReviewViewService.readForWorkItem(story.id, fx.ctx))),
    );
  });

  it('the approve-and-merge gate carries the review that PASSED its version, and only that one (MOTIR-1626)', async () => {
    // `design/github` § 30 Panels 2a/2b: *Reviewed by the review agent · Passed* sits above
    // Approve and merge in the overlay too — read by the same service the item page uses.
    const story = await twoRepoStory();
    const version = 'acme/web#7@aaa,acme/api#12@bbb';
    const review = await rawGate(story, 'agent_review', story.id);
    await adminDb.approvalGate.update({
      where: { id: review.id },
      data: {
        state: 'approved',
        subjectVersion: version,
        decidedAt: new Date(),
        decidedByLabel: 'Review agent',
        decidedUnderAuthority: 'review_agent',
        decisionSource: 'ui',
        noteMd: 'Meets every criterion.',
      },
    });
    const merge = await rawGate(story, 'pull_request_approval', story.id);
    await adminDb.approvalGate.update({
      where: { id: merge.id },
      data: { subjectVersion: version },
    });
    signIn(owner());

    const res = await gateViaRoute({ key: story.identifier, kind: 'pull_request_approval' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subject).toMatchObject({ state: 'resolved', kind: 'pull_request_approval' });
    expect(body.subject.agentReview).toMatchObject({
      gate: { id: review.id, state: 'approved', subjectVersion: version },
    });

    // The merge question moves on to other commits: that review is not about them.
    await adminDb.approvalGate.update({
      where: { id: merge.id },
      data: { subjectVersion: 'acme/web#7@ccc,acme/api#12@bbb' },
    });
    const moved = await (
      await gateViaRoute({ key: story.identifier, kind: 'pull_request_approval' })
    ).json();
    expect(moved.subject.agentReview ?? null).toBeNull();
  });

  it('a DECISION gate is ported by the Development block with the document read server-side (MOTIR-5678)', async () => {
    const story = await twoRepoStory();
    const gate = await rawGate(story, 'decision_approval', story.id);
    const { decisionDocumentService } = await import('@/lib/services/decisionDocumentService');
    const document = {
      outcome: 'resolved' as const,
      repo: 'acme/web',
      number: 7,
      path: 'docs/decisions/page-body.md',
      blobSha: 'blob-1',
      headSha: 'head-1',
      markdown: '# ADR: Page body',
      workItemRefs: {},
      hostUrl: 'https://github.com/acme/web/blob/head-1/docs/decisions/page-body.md',
    };
    const read = vi
      .spyOn(decisionDocumentService, 'readViewForWorkItem')
      .mockResolvedValue(document);
    signIn(owner());

    const res = await gateViaRoute({ key: story.identifier, kind: 'decision_approval' });
    const body = await res.json();

    expect(body.gate).toMatchObject({ id: gate.id, kind: 'decision_approval' });
    expect(body.subject).toMatchObject({ state: 'resolved', kind: 'pull_request_approval' });
    expect(body.subject.decision).toEqual({ document });
    expect(read).toHaveBeenCalledWith(story.id, expect.anything());
    read.mockRestore();
  });

  it('a DECISION published as a PAGE resolves over an EMPTY delivery set — no pull request is its normal shape (MOTIR-5761)', async () => {
    const created = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Decide how a page stores its body' },
      fx.ctx,
    );
    const story = await adminDb.workItem.findUniqueOrThrow({ where: { id: created.id } });
    const gate = await rawGate(story, 'decision_approval', story.id);
    const { decisionDocumentService } = await import('@/lib/services/decisionDocumentService');
    const document = {
      outcome: 'page' as const,
      pageId: 'page-1',
      versionId: 'version-1',
      versionNumber: 1,
      title: 'How a page stores its body',
      markdown: '# How a page stores its body',
      workItemRefs: {},
      pageUrl: '/pages/page-1',
      versionUrl: '/pages/page-1?version=1',
      compareUrl: '/pages/page-1?history=open&version=1',
      authorName: 'Ada Lovelace',
      savedAt: '2026-10-03T10:00:00.000Z',
      frozen: false,
      changedSince: false,
    };
    const read = vi
      .spyOn(decisionDocumentService, 'readViewForWorkItem')
      .mockResolvedValue(document);
    signIn(owner());

    const body = await (
      await gateViaRoute({ key: story.identifier, kind: 'decision_approval' })
    ).json();

    expect(body.gate).toMatchObject({ id: gate.id, kind: 'decision_approval', state: 'awaiting' });
    expect(body.subject).toMatchObject({
      state: 'resolved',
      kind: 'pull_request_approval',
      deliveries: [],
      pullRequests: [],
    });
    expect(body.subject.decision).toEqual({ document });
    read.mockRestore();
  });

  it('a DECISION gate whose document read FAILS still ports the block — the slot says it cannot be read', async () => {
    const story = await twoRepoStory();
    await rawGate(story, 'decision_approval', story.id);
    const { decisionDocumentService } = await import('@/lib/services/decisionDocumentService');
    const read = vi
      .spyOn(decisionDocumentService, 'readViewForWorkItem')
      .mockRejectedValue(new Error('host down'));
    signIn(owner());

    const res = await gateViaRoute({ key: story.identifier, kind: 'decision_approval' });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.subject.state).toBe('resolved');
    expect(body.subject.decision).toEqual({ document: null });
    read.mockRestore();
  });

  it('on a DESIGN card, the approve-to-merge subject carries the current design result beside its pull request (MOTIR-5439, AMENDMENT 4 Q8)', async () => {
    const card = await designCard();
    const evidence = await publish(card);
    await deliver(card, { name: 'core', number: 31 });
    await rawGate(card, 'pull_request_approval', card.id);
    signIn(owner());

    const body = await (
      await gateViaRoute({ key: card.identifier, kind: 'pull_request_approval' })
    ).json();
    expect(body.subject.state).toBe('resolved');
    expect(body.subject.pullRequests).toHaveLength(1);
    expect(body.subject.designEvidence.id).toBe(evidence.id);
  });

  it('a DESIGN gate that carries an awaiting merge gate is ported by the Development block — the reader sees what one press merges (MOTIR-5712)', async () => {
    // The To-approve queue lists this card by its design gate ONLY, and its row opens
    // this overlay — so the port is the one place that reader meets the pull requests
    // the press will merge (AMENDMENT 6 Q1; the item page's frame, MOTIR-5667).
    const card = await designCard();
    const evidence = await publish(card);
    await deliver(card, { name: 'core', number: 31 });
    await rawGate(card, 'pull_request_approval', card.id);
    signIn(owner());

    const body = await (await gateViaRoute({ key: card.identifier, kind: 'design_result' })).json();

    // The GATE is still the design gate — it is what the frame presses.
    expect(body.gate).toMatchObject({ kind: 'design_result', state: 'awaiting' });
    expect(body.stamp).not.toBeNull();
    // The PORT is the Development block, with the design result first in it.
    expect(body.subject.state).toBe('resolved');
    expect(body.subject.kind).toBe('pull_request_approval');
    expect(body.subject.pullRequests.map((pr: { number: number }) => pr.number)).toEqual([31]);
    expect(body.subject.designEvidence.id).toBe(evidence.id);
    expect(body.subject.isDesignCard).toBe(false);
    expect(body.subject.members).toEqual([]);
  });

  it('a DESIGN gate whose merge gate is NOT awaiting keeps its own design port', async () => {
    const card = await designCard();
    const evidence = await publish(card);
    await deliver(card, { name: 'core', number: 31 });
    const merge = await rawGate(card, 'pull_request_approval', card.id);
    await adminDb.approvalGate.update({ where: { id: merge.id }, data: { state: 'superseded' } });
    signIn(owner());

    const body = await (await gateViaRoute({ key: card.identifier, kind: 'design_result' })).json();

    expect(body.subject).toMatchObject({ state: 'resolved', kind: 'design_result' });
    expect(body.subject.evidence.id).toBe(evidence.id);
  });

  it('an ACCEPTANCE gate beside an awaiting merge gate is ported by the Development block — the reader sees what one press merges (MOTIR-5790)', async () => {
    // A STORY RUN: the story's own pull requests are what the acceptance press merges, so
    // the port is the Development block with the recording leading it — the design arm's
    // rule, one kind over (§1's MOTIR-5787 amendment, point 2).
    const { story, receipt } = await storyWithReceipt();
    await deliver(story, { name: 'core', number: 41 });
    await rawGate(story, 'pull_request_approval', story.id);
    signIn(owner());

    const body = await (
      await gateViaRoute({ key: story.identifier, kind: 'acceptance_result' })
    ).json();

    // The GATE is still the acceptance gate — it is what the frame presses.
    expect(body.gate).toMatchObject({ kind: 'acceptance_result', state: 'awaiting' });
    expect(body.subject.kind).toBe('pull_request_approval');
    expect(body.subject.pullRequests.map((pr: { number: number }) => pr.number)).toEqual([41]);
    expect(body.subject.acceptanceEvidence.id).toBe(receipt.id);
    expect(body.subject.acceptanceGate.kind).toBe('acceptance_result');
  });

  it('an ACCEPTANCE-led port reads its members against the MERGE gate and hands back that gate’s version (MOTIR-6079)', async () => {
    // The acceptance gate is versioned by its RECORDING's commit and its id owns no member
    // facts, so a port read against it counts nothing — the overlay's frame named no pull
    // request and a reload drew no per-row fact. The item page reads both off the merge
    // gate (`LateSections`' `mergeSubjectVersion`, `r.mergeGate.members`); so does this.
    const { story } = await storyWithReceipt();
    await deliver(story, { name: 'core', number: 41 });
    const merge = await rawGate(story, 'pull_request_approval', story.id);
    const setVersion = `acme/core#41@${'a'.repeat(40)}`;
    await adminDb.approvalGate.update({
      where: { id: merge.id },
      data: { subjectVersion: setVersion },
    });
    signIn(owner());

    const body = await (
      await gateViaRoute({ key: story.identifier, kind: 'acceptance_result' })
    ).json();

    expect(body.gate).toMatchObject({ kind: 'acceptance_result', state: 'awaiting' });
    expect(body.subject.kind).toBe('pull_request_approval');
    expect(body.subject.mergeSubjectVersion).toBe(setVersion);
    expect(body.subject.members).toHaveLength(1);
    expect(body.subject.members[0]).toMatchObject({ subjectVersion: setVersion });
  });

  it('a DESIGN-led port reads its members against the MERGE gate and hands back that gate’s version (MOTIR-6080)', async () => {
    // The design gate is versioned by its PUBLISHED COMMIT — not a delivery set — so a frame
    // counting members out of it counts none, the acceptance arm's defect one kind over.
    const card = await designCard();
    await publish(card);
    await deliver(card, { name: 'core', number: 31 });
    const merge = await rawGate(card, 'pull_request_approval', card.id);
    const setVersion = `acme/core#31@${'b'.repeat(40)}`;
    await adminDb.approvalGate.update({
      where: { id: merge.id },
      data: { subjectVersion: setVersion },
    });
    signIn(owner());

    const body = await (await gateViaRoute({ key: card.identifier, kind: 'design_result' })).json();

    expect(body.gate).toMatchObject({ kind: 'design_result', state: 'awaiting' });
    expect(body.subject.kind).toBe('pull_request_approval');
    expect(body.subject.mergeSubjectVersion).toBe(setVersion);
    expect(body.subject.members).toHaveLength(1);
    expect(body.subject.members[0]).toMatchObject({ subjectVersion: setVersion });
  });

  it('a DECISION-led port reads its members against the MERGE gate and hands back that gate’s version (MOTIR-6080)', async () => {
    // A decision gate is versioned `owner/name:path@blob` — the document, not the set — and
    // its id owns no member facts. The item page reads both off the merge gate; so does this.
    const story = await twoRepoStory();
    await rawGate(story, 'decision_approval', story.id);
    const merge = await rawGate(story, 'pull_request_approval', story.id);
    const setVersion = `acme/web#7@${'c'.repeat(40)}`;
    await adminDb.approvalGate.update({
      where: { id: merge.id },
      data: { subjectVersion: setVersion },
    });
    const { decisionDocumentService } = await import('@/lib/services/decisionDocumentService');
    const read = vi.spyOn(decisionDocumentService, 'readViewForWorkItem').mockResolvedValue(null);
    signIn(owner());

    const body = await (
      await gateViaRoute({ key: story.identifier, kind: 'decision_approval' })
    ).json();

    expect(body.gate).toMatchObject({ kind: 'decision_approval' });
    expect(body.subject.kind).toBe('pull_request_approval');
    expect(body.subject.mergeSubjectVersion).toBe(setVersion);
    expect(body.subject.members).toHaveLength(1);
    expect(body.subject.members[0]).toMatchObject({ subjectVersion: setVersion });
    read.mockRestore();
  });

  it('a DECISION gate with no merge question reads no merge version — the frame keeps its own', async () => {
    const story = await twoRepoStory();
    await rawGate(story, 'decision_approval', story.id);
    const { decisionDocumentService } = await import('@/lib/services/decisionDocumentService');
    const read = vi.spyOn(decisionDocumentService, 'readViewForWorkItem').mockResolvedValue(null);
    signIn(owner());

    const body = await (
      await gateViaRoute({ key: story.identifier, kind: 'decision_approval' })
    ).json();

    expect(body.subject.kind).toBe('pull_request_approval');
    expect(body.subject.mergeSubjectVersion).toBeUndefined();
    read.mockRestore();
  });

  it('an ACCEPTANCE gate with NO awaiting merge question keeps its own port — the recording alone', async () => {
    // A SINGLE-CARD run: the story delivers nothing of its own, so there is nothing for
    // the press to merge and the port is the receipt (point 3).
    const { story, receipt } = await storyWithReceipt();
    signIn(owner());

    const body = await (
      await gateViaRoute({ key: story.identifier, kind: 'acceptance_result' })
    ).json();

    expect(body.subject).toMatchObject({ state: 'resolved', kind: 'acceptance_result' });
    expect(body.subject.evidence.id).toBe(receipt.id);
    expect(body.subject.evidence.chapters).toHaveLength(1);
  });

  it('an ACCEPTANCE gate whose recording no longer resolves is GONE — the cross-subject guard holds', async () => {
    const { story } = await storyWithReceipt();
    // A gate pointing at a receipt that is not this story's current one — what a reader
    // meets after the bytes behind a superseded version have been reclaimed.
    await adminDb.approvalGate.deleteMany({ where: { workItemId: story.id } });
    await rawGate(story, 'acceptance_result', 'acceptance-evidence-that-was-reclaimed');
    signIn(owner());

    const body = await (
      await gateViaRoute({ key: story.identifier, kind: 'acceptance_result' })
    ).json();

    expect(body.subject).toEqual({ state: 'gone' });
  });

  it('an approve-to-merge gate whose delivery set has EMPTIED is gone — the handler answers null for it', async () => {
    const card = await designCard();
    await rawGate(card, 'pull_request_approval', card.id);
    signIn(owner());

    const body = await (
      await gateViaRoute({ key: card.identifier, kind: 'pull_request_approval' })
    ).json();
    expect(body.gate.kind).toBe('pull_request_approval');
    expect(body.subject).toEqual({ state: 'gone' });
  });

  it('a reader who may see but not decide gets the approve-to-merge port with canDecide false', async () => {
    const story = await twoRepoStory();
    await rawGate(story, 'pull_request_approval', story.id);
    signIn(await plainMember());

    const body = await (
      await gateViaRoute({ key: story.identifier, kind: 'pull_request_approval' })
    ).json();
    expect(body.subject.state).toBe('resolved');
    expect(body.subject.pullRequests).toHaveLength(2);
    expect(body.canDecide).toBe(false);
  });

  it('never serves a cached gate — its state changes under the reader by design', async () => {
    const card = await designCard();
    signIn(owner());
    const res = await gateViaRoute({ key: card.identifier, kind: 'design_result' });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

describe('GET /api/work-items/approval-gate · a CHOICE (Story MOTIR-4914)', () => {
  const BODY = [
    '## Question',
    'Where do exports live?',
    '## Why this is a choice',
    '**Situation:** two workflows',
    'The requirement forks.',
    '## Options',
    '### Managed storage',
    '**Best if you want:** less to operate',
    'A.',
    '### Our Postgres',
    '**Best if you want:** more cost-effective',
    'B.',
    '## What this choice gates',
    'The export story.',
  ].join('\n');

  async function choiceCard(): Promise<WorkItem> {
    const created = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Choose',
        type: 'choice',
        executor: 'human',
        descriptionMd: BODY,
      },
      fx.ctx,
    );
    return adminDb.workItem.findUniqueOrThrow({ where: { id: created.id } });
  }

  it('a complete body answers RESOLVED, with the parsed options', async () => {
    const card = await choiceCard();
    signIn(owner());
    const body = await (
      await gateViaRoute({ key: card.identifier, kind: 'decision_choice' })
    ).json();
    expect(body.subject).toMatchObject({ state: 'resolved', kind: 'decision_choice' });
    expect(body.subject.choice.options.map((o: { id: string }) => o.id)).toEqual([
      'managed-storage',
      'our-postgres',
    ]);
  });

  it('a body that stopped parsing under a waiting gate answers GONE — nothing to pick from', async () => {
    const card = await choiceCard();
    // Written behind the service's back, so the gate still waits over a broken body.
    await adminDb.workItem.update({ where: { id: card.id }, data: { descriptionMd: 'broken' } });
    signIn(owner());
    const body = await (
      await gateViaRoute({ key: card.identifier, kind: 'decision_choice' })
    ).json();
    expect(body.subject).toEqual({ state: 'gone' });
  });
});

describe('GET /api/work-items/approval-gate · seeing is not deciding', () => {
  it('a reader who may BROWSE but not DECIDE gets the gate and the subject with canDecide false', async () => {
    const card = await designCard();
    await publish(card);
    const bystander = await plainMember();
    signIn(bystander);

    const res = await gateViaRoute({ key: card.identifier, kind: 'design_result' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.gate.state).toBe('awaiting');
    expect(body.subject.state).toBe('resolved');
    expect(body.canDecide).toBe(false);
  });
});

describe('GET /api/work-items/approval-gate · the permission floor (MOTIR-5445)', () => {
  it('a project VIEWER who is the ASSIGNEE sees the resolved gate with canDecide false', async () => {
    // Routed the gate, and held out of deciding it by the kind's
    // `work_item:edit` floor — which the door asserts, and which this read
    // skipped until MOTIR-5445, so the overlay drew verbs the door refused.
    const card = await designCard();
    await publish(card);
    const viewer = await plainMember();
    await adminDb.projectMembership.deleteMany({
      where: { userId: viewer.id, projectId: fx.projectId },
    });
    await adminDb.projectMembership.create({
      data: {
        userId: viewer.id,
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
      },
    });
    await setWorkspaceRoleFor(viewer.id, fx.workspaceId, 'viewer');
    await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: viewer.id } });
    signIn(viewer);

    const res = await gateViaRoute({ key: card.identifier, kind: 'design_result' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.gate.state).toBe('awaiting');
    expect(body.subject.state).toBe('resolved');
    expect(body.canDecide).toBe(false);
    // …and a viewer may not plan either, so no Re-plan with AI door (MOTIR-6211).
    expect(body.canReplan).toBe(false);
  });
});

describe('GET /api/work-items/approval-gate · `canReplan` (MOTIR-6211)', () => {
  it('an ARCHIVED card offers no re-plan, even to its owner', async () => {
    const card = await designCard();
    await publish(card);
    await adminDb.workItem.update({ where: { id: card.id }, data: { archivedAt: new Date() } });
    signIn(owner());

    const res = await gateViaRoute({ key: card.identifier, kind: 'design_result' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canReplan).toBe(false);
  });
});

describe('GET /api/work-items/approval-gate · the refusals', () => {
  it('no active project → 401, and the 2FA hold does NOT pre-empt it', async () => {
    await adminDb.workspace.update({
      where: { id: fx.workspaceId },
      data: { requiresTwoFactor: true },
    });
    session.current = { user: { id: fx.owner.id, email: fx.owner.email, name: 'Ada Lovelace' } };
    activeCtx.current = null;

    const res = await gateViaRoute({ key: 'PROD-1', kind: 'design_result' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED' });
  });

  it('a member held by the 2FA policy is refused 403 with the typed body', async () => {
    const card = await designCard();
    signIn(owner());
    await adminDb.workspace.update({
      where: { id: fx.workspaceId },
      data: { requiresTwoFactor: true },
    });

    const res = await gateViaRoute({ key: card.identifier, kind: 'design_result' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
      tier: 'workspace',
      enrolAt: TWO_FACTOR_REQUIRED_PATH,
    });
  });

  it('a missing or blank `key` → 400', async () => {
    signIn(owner());
    expect((await gateViaRoute({ kind: 'design_result' })).status).toBe(400);
    const blank = await gateViaRoute({ key: '   ', kind: 'design_result' });
    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual({ code: 'BAD_REQUEST', error: '`key` is required.' });
  });

  it('a missing, unknown or prototype-named `kind` → 400', async () => {
    const card = await designCard();
    signIn(owner());
    for (const kind of [undefined, '', 'merge', 'toString', 'constructor']) {
      const res = await gateViaRoute({ key: card.identifier, kind });
      expect(res.status, `kind=${String(kind)}`).toBe(400);
      expect((await res.json()).code).toBe('BAD_REQUEST');
    }
  });

  it('the scoping is real: a gate that RESOLVES for its reader is a 404 for an outsider, byte-identical to an unknown key', async () => {
    // The actor's view and the true population DIFFER here: the gate exists and
    // resolves for its own workspace, and must not for anybody else's. A test
    // whose actor could see everything could not tell a scoped read from an
    // unscoped one.
    const card = await designCard();
    await publish(card);
    signIn(owner());
    expect((await gateViaRoute({ key: card.identifier, kind: 'design_result' })).status).toBe(200);

    const home = fx;
    const outsiderFx = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    signIn({ id: outsiderFx.owner.id, email: outsiderFx.owner.email }, outsiderFx);

    const forbidden = await gateViaRoute({ key: card.identifier, kind: 'design_result' });
    const unknown = await gateViaRoute({ key: 'ELSE-99999', kind: 'design_result' });
    expect(forbidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    const [a, b] = [await forbidden.text(), await unknown.text()];
    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual({ code: 'NOT_FOUND', error: 'Work item not available.' });

    // …and the gate is still there for its own reader afterwards.
    signIn(owner(), home);
    expect((await gateViaRoute({ key: card.identifier, kind: 'design_result' })).status).toBe(200);
  });

  it('an approve-to-merge gate that RESOLVES for its reader is the same 404 for an outsider (MOTIR-5439)', async () => {
    // The reader's view and the true population differ: the gate and both pull
    // requests exist and resolve in their own workspace, and must not elsewhere.
    const story = await twoRepoStory();
    await rawGate(story, 'pull_request_approval', story.id);
    signIn(owner());
    const own = await gateViaRoute({ key: story.identifier, kind: 'pull_request_approval' });
    expect(own.status).toBe(200);
    expect((await own.json()).subject.pullRequests).toHaveLength(2);

    const outsiderFx = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    signIn({ id: outsiderFx.owner.id, email: outsiderFx.owner.email }, outsiderFx);
    const forbidden = await gateViaRoute({ key: story.identifier, kind: 'pull_request_approval' });
    const unknown = await gateViaRoute({ key: 'ELSE-99999', kind: 'pull_request_approval' });
    expect(forbidden.status).toBe(404);
    expect(await forbidden.text()).toBe(await unknown.text());
  });

  it('a key in a project this reader may NOT BROWSE is the same 404', async () => {
    const card = await designCard();
    await publish(card);
    const outsider = await plainMember();
    await setProjectAccess(adminDb, fx.projectId, 'members');
    signIn(outsider, fx, 'members');

    const res = await gateViaRoute({ key: card.identifier, kind: 'design_result' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'NOT_FOUND', error: 'Work item not available.' });
  });
});

describe('guard · the handler stays a THIN HTTP layer', () => {
  const source = readFileSync(
    join(process.cwd(), 'app/api/work-items/approval-gate/route.ts'),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  it('imports no `db`, no repository, and opens no transaction (the 4-layer rule)', () => {
    expect(code).not.toMatch(/from '@\/lib\/db'/);
    expect(code).not.toMatch(/lib\/repositories/);
    expect(code).not.toMatch(/\$transaction/);
    expect(code).not.toMatch(/prisma/i);
  });

  it('composes exactly the shipped service reads — the approve-to-merge port reuses the item page’s — and adds none', () => {
    // MOTIR-5439 added the Development block's reads, which are `lateReads.ts`'s own
    // calls verbatim; a NEW service method here would be a second read of the block.
    const calls = [...new Set(code.match(/\w+Service\.\w+/g) ?? [])].sort();
    expect(calls).toEqual([
      // MOTIR-4950 — the acceptance port's read, the receipt twin of
      // `designEvidenceService.getForGateSubject`: read by the gate's own subject id.
      // MOTIR-5790 — a story run's receipt, the Development block's subject when acceptance
      // leads; the same read the item page's late stack makes.
      'acceptanceEvidenceService.getCurrentForStory',
      'acceptanceEvidenceService.getForGateSubject',
      // The agent review's state beside its port (§12.3) — the same read `lateReads.ts`
      // makes for the item page's Development frame.
      'agentReviewViewService.readForWorkItem',
      'approvalGatesService.getForWorkItem',
      // NOT A READ, and the one call here that is not (MOTIR-7146): an AWAITING gate whose
      // port answered `gone` is withdrawn `subject_gone` before the route answers, so the
      // overlay draws state G rather than a dead Panel 4b. Its own transaction, after the
      // read, and it never fails the read (ADR `approval-gates.md` §6 amendment).
      'approvalGatesService.withdrawGoneQuestionsOnWorkItem',
      // The choice port's parsed options (MOTIR-5891) — the same parse the item page reads.
      'choiceGateService.readPort',
      // The confirm port's parsed decision (MOTIR-5954) — the same parse the item page reads.
      'decisionConfirmationGateService.readPort',
      // The decision port's document (MOTIR-5678) — the same read the item page makes.
      'decisionDocumentService.readViewForWorkItem',
      'designEvidenceService.getCurrentForWorkItem',
      'designEvidenceService.getForGateSubject',
      'howToTestService.getForWorkItem',
      // The reader's project permissions (MOTIR-6211) — the item page's own `canEdit` read,
      // which decides whether a refused decision's record offers Re-plan with AI.
      'projectAccessService.getPermissions',
      'pullRequestMergeService.listApprovalMembers',
      // `motir fix`, beside the row whose reason a person cannot act on (MOTIR-5806) —
      // the same read `lateReads.ts` makes for the item page's own Development block.
      'workItemRepairService.getRepairView',
      // The manual-work port (MOTIR-7478): the card's to-do list, the same read the item
      // page's To-do section makes.
      'workItemTodosService.listTodos',
      'workItemsService.getDeliveryView',
      // A design's PARENT — where its Re-plan opens the planner (MOTIR-6427, §10h).
      'workItemsService.getWorkItem',
      'workItemsService.getWorkItemByIdentifier',
      // The manual-work port's consequence line (MOTIR-7478): whether an open delivering
      // pull request means the merge, not the press, writes Done (ADR §4).
      'workItemsService.listDeliverySet',
      'workItemsService.listLinkedPullRequests',
      // The project's workflow — the overlay header's status chip (MOTIR-6427).
      'workflowsService.listStatusesByProject',
    ]);
    const lateReads = readFileSync(
      join(process.cwd(), 'app/(authed)/items/[key]/_components/lateReads.ts'),
      'utf8',
    );
    // The item page's body is `_view.tsx`, and its permission set is read through
    // the page context (MOTIR-6643) — together they are the item page's reads.
    const page = ['app/(authed)/items/[key]/_view.tsx', 'lib/pages/projectPageContext.ts']
      .map((f) => readFileSync(join(process.cwd(), f), 'utf8'))
      .join('\n');
    // The approve-to-merge port's reads, each one the item page already makes.
    for (const call of [
      'agentReviewViewService.readForWorkItem',
      'decisionDocumentService.readViewForWorkItem',
      'projectAccessService.getPermissions',
      'designEvidenceService.getCurrentForWorkItem',
      'howToTestService.getForWorkItem',
      'pullRequestMergeService.listApprovalMembers',
      'workItemRepairService.getRepairView',
      'workItemsService.getDeliveryView',
      'workItemsService.listLinkedPullRequests',
    ]) {
      expect(`${lateReads}\n${page}`, `${call} is not one the item page makes`).toContain(call);
    }

    // ⚠️ AND BOTH READ THE MEMBERS FOR AN **AWAITING** GATE (Story MOTIR-5799 ·
    // MOTIR-5806; § 4 FOURTH AMENDMENT, point 4). The re-asked gate is awaiting, and its
    // member facts are the whole of what the row draws: the class pill, the verb whose
    // press decides that gate, and the reason band. MOTIR-5806 widened the ROUTE and left
    // `lateReads.ts` on `state === 'approved'`, so the OVERLAY drew the re-ask and the
    // ITEM PAGE drew a plain *Checks passing* row on a card Motir had just asked again —
    // with `motir fix` beside it saying the pull request had left the merge queue. Caught
    // by MOTIR-5808's acceptance run, and pinned here because the two reads are supposed
    // to be the same set and only a comparison says so.
    for (const [name, source] of [
      ['the route', code],
      ['the item page’s late stack', lateReads],
    ] as const) {
      const guard = new RegExp(
        String.raw`state === 'approved' \|\| \S*\s*state === 'awaiting'[\s\S]{0,200}?listApprovalMembers`,
      );
      expect(source, `${name} reads the members for an awaiting gate too`).toMatch(guard);
    }
  });

  it('holds the 2FA gate AFTER the no-project arm and BEFORE the parameter arms', () => {
    const gate = code.indexOf('refuseIfNonCompliant(');
    expect(gate).toBeGreaterThan(-1);
    expect(code.indexOf('getActiveProject(')).toBeLessThan(gate);
    expect(code.indexOf('UNAUTHENTICATED')).toBeLessThan(gate);
    expect(gate).toBeLessThan(code.indexOf('BAD_REQUEST'));
  });
});

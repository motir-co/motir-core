import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import type { PullRequestFiles } from '@/lib/github/pullRequestFiles';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { settleGreenVerdict } from '@/lib/services/mergeGates';
import { reconcileGatesFor } from '@/lib/services/gateSetFor';
import { repoFileReadService } from '@/lib/services/repoFileReadService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPr } from '../helpers/prLink';

// THE DECISION GATE'S STORY GATE (Story MOTIR-4907 · Subtask MOTIR-5680). Each code card
// tests its own piece; this file tests that the pieces MEET — on real Postgres, with the
// host stubbed only at the file list and the merge.
//
// What each card already covers is NOT re-covered here (the capture's four outcomes:
// `decisionDocumentCapture.test.ts`; the gate set's rules: `gateSetDecision.test.ts`; the
// merge holds door by door and the one press: `decisionGateSet.test.ts`; the resolver
// swap: `decisionApprovalHandler.test.ts` — "raises, decides and refuses identically under
// the production resolver and a fake one"). What is here is the seam end to end, and the
// guards a coverage percentage cannot see.

const listFiles = vi.hoisted(() => vi.fn<() => Promise<PullRequestFiles>>());
vi.mock('@/lib/github/pullRequestFiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/pullRequestFiles')>()),
  listPullRequestFiles: listFiles,
}));
vi.mock('@/lib/jobs/sendEvent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/jobs/sendEvent')>()),
  sendEvent: vi.fn(async () => undefined),
}));

const github = getGitProvider('github') as Required<GitProvider>;
const HEAD = 'c1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const HEAD_2 = 'd1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const INSTALLATION = 'inst-decision-story-gate';
const DOC = 'docs/decisions/page-model.md';
const version = (blob: string) => `acme/web:${DOC}@${blob}`;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  listFiles.mockReset();
  vi.spyOn(github, 'mintInstallationToken').mockResolvedValue({
    token: 'ghs_story_gate',
    expiresAt: new Date(Date.now() + 3_600_000),
  } as never);
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function headFiles(blob: string | null, head = HEAD): PullRequestFiles {
  const files = [
    ...(blob ? [{ path: DOC, sha: blob, status: 'added' }] : []),
    { path: 'lib/pages/model.ts', sha: 'code-blob', status: 'modified' },
  ];
  return { paths: files.map((f) => f.path), truncated: false, files, headSha: head };
}

async function repo() {
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: INSTALLATION,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  await adminDb.githubRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      installationId: installation.id,
      repoId: '5680',
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
}

/** A `decision` card, its executor as given, with one pull request linked. */
async function card(opts: {
  executor: 'coding_agent' | 'human';
  mode?: 'manual' | 'auto';
  blob?: string | null;
}) {
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { prMergeMode: opts.mode ?? 'manual', prMergeModeDecidedAt: new Date() },
  });
  const item = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: 'Decide the page model',
      type: 'decision',
      executor: opts.executor,
    },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: fx.ownerId } });
  await repo();
  listFiles.mockResolvedValue(headFiles(opts.blob === undefined ? 'blob-1' : opts.blob));
  await linkPr(
    {
      workItemId: item.id,
      projectId: fx.projectId,
      owner: 'acme',
      name: 'web',
      number: 31,
      headRef: 'docs/MOTIR-1-page-model',
    },
    fx.ctx,
  );
  const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 31 } });
  return { item, pr };
}

const decisionGates = (workItemId: string) =>
  adminDb.approvalGate.findMany({
    where: { workItemId, kind: 'decision_approval' },
    orderBy: { createdAt: 'asc' },
  });

function pullRequestEvent(
  action: 'synchronize' | 'closed',
  head: string,
  merged = false,
): Record<string, unknown> {
  return {
    action,
    installation: { id: INSTALLATION, account: { login: 'acme', type: 'Organization' } },
    repository: { id: 5680 },
    pull_request: {
      number: 31,
      state: merged ? 'closed' : 'open',
      merged,
      merged_at: merged ? new Date().toISOString() : null,
      title: 'Decide the page model',
      head: { ref: 'docs/MOTIR-1-page-model', sha: head },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  };
}

async function green(prId: string, head = HEAD) {
  await adminDb.githubCheckRun.create({
    data: { pullRequestId: prId, commitSha: head, checkName: 'Vitest', conclusion: 'success' },
  });
}

async function reconcile(itemId: string) {
  await withWorkspaceContext(fx.ctx, async (tx) =>
    reconcileGatesFor(await tx.workItem.findUniqueOrThrow({ where: { id: itemId } }), tx),
  );
}

async function settle(itemId: string, pullRequestId: string) {
  return withWorkspaceContext(fx.ctx, async (tx) =>
    settleGreenVerdict(
      {
        item: await tx.workItem.findUniqueOrThrow({ where: { id: itemId } }),
        pullRequestIds: [pullRequestId],
      },
      fx.ctx,
      tx,
    ),
  );
}

describe('THE SEAM — capture → gate set → decide → merge carry → done', () => {
  it('each hop, in order, on real Postgres', async () => {
    // Hop 0 — the card, its pull request opened on a head that carries NO document yet.
    const { item, pr } = await card({ executor: 'coding_agent', blob: null });
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);

    // Hop 1 — a SYNCHRONIZE webhook whose head writes the document: the capture lands on
    // the pull-request mirror, read off the (stubbed) host file list.
    listFiles.mockResolvedValue(headFiles('blob-1', HEAD));
    await githubWebhookService.handlePullRequest(pullRequestEvent('synchronize', HEAD));
    expect(
      await adminDb.githubPullRequest.findUniqueOrThrow({ where: { id: pr.id } }),
    ).toMatchObject({
      decisionDocOutcome: 'one',
      decisionDocPath: DOC,
      decisionDocBlobSha: 'blob-1',
      decisionDocHeadSha: HEAD,
      decisionDocPaths: [DOC],
    });

    // Hop 2 — the gate set raises the decision question as the PRIMARY, over the BLOB.
    const asked = (await decisionGates(item.id)).find((g) => g.state === 'awaiting');
    expect(asked).toMatchObject({ subjectId: item.id, subjectVersion: version('blob-1') });

    // Hop 3 — a person approves through the decide door: the decision is recorded and NO
    // status is written (the merge is the single writer of `done`).
    const before = (await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status;
    await approvalGatesService.decide(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: asked!.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      before,
    );

    // Hop 4 — the NEXT GREEN carries the approval into a merge, with no second press.
    await green(pr.id);
    await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
    expect(await settle(item.id, pr.id)).toEqual([{ pullRequestId: pr.id, headSha: HEAD }]);

    // Hop 5 — the merge webhook writes `done`.
    await githubWebhookService.handlePullRequest(pullRequestEvent('closed', HEAD, true));
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'done',
    );
  });

  it('a push that CHANGES the document supersedes the gate; one that does not leaves it decided', async () => {
    const { item } = await card({ executor: 'coding_agent' });
    const [first] = await decisionGates(item.id);
    await approvalGatesService.decide(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: first!.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );

    // Untouched document at a new head: the answer stands.
    listFiles.mockResolvedValue(headFiles('blob-1', HEAD_2));
    await githubWebhookService.handlePullRequest(pullRequestEvent('synchronize', HEAD_2));
    expect((await decisionGates(item.id)).map((g) => g.state)).toEqual(['approved']);

    // A changed document: a NEW question, the approved one kept as the record it is.
    listFiles.mockResolvedValue(headFiles('blob-2', HEAD));
    await githubWebhookService.handlePullRequest(pullRequestEvent('synchronize', HEAD));
    expect((await decisionGates(item.id)).map((g) => [g.state, g.subjectVersion])).toEqual([
      ['approved', version('blob-1')],
      ['awaiting', version('blob-2')],
    ]);
  });
});

describe('GUARD — a HUMAN decision card never gets a decision gate, on every raise path', () => {
  it('link, synchronize, entering review and a green reconcile all raise nothing', async () => {
    // Raise path 1 — the link (which captures for an agent's card).
    const { item, pr } = await card({ executor: 'human' });
    expect(await decisionGates(item.id)).toEqual([]);

    // Raise path 2 — a synchronize webhook.
    listFiles.mockResolvedValue(headFiles('blob-2', HEAD_2));
    await githubWebhookService.handlePullRequest(pullRequestEvent('synchronize', HEAD_2));
    expect(await decisionGates(item.id)).toEqual([]);

    // Raise path 3 — entering review.
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
    expect(await decisionGates(item.id)).toEqual([]);

    // Raise path 4 — the reconcile a green verdict runs.
    await green(pr.id, HEAD_2);
    await reconcile(item.id);
    expect(await decisionGates(item.id)).toEqual([]);
    // Nothing was captured either: a person choosing is not this gate's question.
    expect(
      (await adminDb.githubPullRequest.findUniqueOrThrow({ where: { id: pr.id } }))
        .decisionDocOutcome,
    ).toBeNull();
  });
});

describe('GUARD — an AUTO project never merges a decision nobody accepted', () => {
  it.each([
    ['awaiting', 'blob-1'],
    ['unresolvable (no document)', null],
  ] as const)('%s: a green verdict dispatches NOTHING', async (_state, blob) => {
    const { item, pr } = await card({ executor: 'coding_agent', mode: 'auto', blob });
    await green(pr.id);
    const [gate] = await decisionGates(item.id);
    expect(gate?.state).toBe('awaiting');
    expect(await settle(item.id, pr.id)).toEqual([]);
  });
});

describe('GUARD — no host call inside a gate transaction', () => {
  it('the gate set raises, and the door decides, with every host read failing', async () => {
    const { item } = await card({ executor: 'coding_agent' });
    // From here on ANY host read fails — the file list, the token, the file content.
    // (The link above captured through the file list — that read is the capture's, made
    // outside any gate transaction; the record starts HERE.)
    listFiles.mockClear();
    listFiles.mockRejectedValue(new Error('host called inside a gate transaction'));
    vi.spyOn(github, 'mintInstallationToken').mockRejectedValue(
      new Error('host called inside a gate transaction'),
    );
    const fileRead = vi
      .spyOn(repoFileReadService, 'readFile')
      .mockRejectedValue(new Error('host called inside a gate transaction'));

    // The gate-set call: withdraw by pulling back, then ask again on entering review.
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
    await reconcile(item.id);
    const live = (await decisionGates(item.id)).find((g) => g.state === 'awaiting');
    expect(live?.subjectVersion).toBe(version('blob-1'));

    // And the decide door, which reads the identity from the capture alone.
    await approvalGatesService.decide(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: live!.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );
    expect(listFiles).not.toHaveBeenCalled();
    expect(fileRead).not.toHaveBeenCalled();
  });
});

describe('GUARD — no new table beyond the capture columns', () => {
  it("the story's migrations add columns to github_pull_request and create no table", () => {
    const dir = join(process.cwd(), 'prisma/migrations');
    const story = readdirSync(dir).filter(
      (name) =>
        name.endsWith('_add_pull_request_decision_doc_capture') ||
        name.endsWith('_add_pull_request_decision_doc_paths'),
    );
    expect(story).toHaveLength(2);
    for (const name of story) {
      const sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');
      expect(sql, name).not.toMatch(/CREATE\s+TABLE/i);
      expect(sql, name).toMatch(/ALTER TABLE "github_pull_request"/);
    }
  });
});

describe('the coverage floor — the capture and the read arms no card test reaches', () => {
  it('a pull request delivering a decision card AND a code card asks only the decision card', async () => {
    const { item } = await card({ executor: 'coding_agent' });
    const code = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Build the page model', type: 'code' },
      fx.ctx,
    );
    await linkPr(
      {
        workItemId: code.id,
        projectId: fx.projectId,
        owner: 'acme',
        name: 'web',
        number: 31,
        headRef: 'docs/MOTIR-1-page-model',
      },
      fx.ctx,
    );

    listFiles.mockResolvedValue(headFiles('blob-2', HEAD_2));
    await githubWebhookService.handlePullRequest(pullRequestEvent('synchronize', HEAD_2));

    expect((await decisionGates(item.id)).map((g) => [g.state, g.subjectVersion])).toEqual([
      ['superseded', version('blob-1')],
      ['awaiting', version('blob-2')],
    ]);
    expect(await decisionGates(code.id)).toEqual([]);
  });

  it('a question asked with NO version (the review-entry re-ask) is not retired by a capture', async () => {
    const { item } = await card({ executor: 'coding_agent' });
    // Withdraw the capture-raised question, then write the review-entry shape: awaiting,
    // no version — the door stamps it at decision time.
    await adminDb.approvalGate.updateMany({
      where: { workItemId: item.id, kind: 'decision_approval', state: 'awaiting' },
      data: { state: 'superseded', supersededCause: 'pulled_back' },
    });
    const unversioned = await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind: 'decision_approval',
        subjectId: item.id,
        subjectVersion: null,
        routedToId: fx.ownerId,
      },
    });

    listFiles.mockResolvedValue(headFiles('blob-1', HEAD_2));
    await githubWebhookService.handlePullRequest(pullRequestEvent('synchronize', HEAD_2));

    expect(
      (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: unversioned.id } })).state,
    ).toBe('awaiting');
  });

  it('the PORT reads the document through the production resolver — the repository read', async () => {
    const { item } = await card({ executor: 'coding_agent' });
    const read = vi.spyOn(repoFileReadService, 'readFile').mockResolvedValue({
      outcome: 'found',
      repoRef: 'acme/web',
      path: DOC,
      ref: HEAD,
      text: '# ADR: The page model\n\nBody.',
      bytes: 27,
    } as never);

    const { decisionDocumentService } = await import('@/lib/services/decisionDocumentService');
    const view = await decisionDocumentService.readViewForWorkItem(item.id, fx.ctx);

    expect(read).toHaveBeenCalledWith(expect.anything(), 'acme/web', DOC, HEAD);
    expect(view).toMatchObject({
      outcome: 'resolved',
      path: DOC,
      blobSha: 'blob-1',
      markdown: '# ADR: The page model\n\nBody.',
      hostUrl: `https://github.com/acme/web/blob/${HEAD}/${DOC}`,
    });
  });
});

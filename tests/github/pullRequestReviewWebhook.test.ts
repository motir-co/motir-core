import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import { ProviderPermissionReadError } from '@/lib/git/errors';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import * as reviewSync from '@/lib/services/pullRequestReviewSync';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Motir's own App bots (MOTIR-10335): the two logins the Apps would answer for themselves.
vi.mock('@/lib/github/appBotLogins', () => ({
  motirAppBotLogins: async () => ({
    logins: new Set(['motir-studio[bot]', 'motir-integration[bot]']),
    complete: true,
  }),
}));

// THE WEBHOOK ARM (Story MOTIR-4910 · MOTIR-5598;
// `docs/decisions/approval-gates.md` §8 FOURTH AMENDMENT, decisions 2, 6 and 9), against a
// REAL Postgres, through the real `githubWebhookService.handleEvent` — the door a GitHub
// delivery walks. The bodies are the recorded `pull_request_review` fixtures, re-pointed at
// this fixture's rows.
//
// ⚠️ THE PROPERTY UNDER TEST IS THAT NOTHING HERE 500s. Every edge a review can arrive on —
// an unknown installation, an unlinked pull request, a permission read that failed, an
// evaluation that threw — is a 2xx with a named outcome, because a non-2xx asks GitHub to
// redeliver something that will never resolve.

const HEAD = 'a'.repeat(40);
const INSTALLATION_ID = 'inst-review-arm';
const REPO_PROVIDER_ID = '9911';
const github = getGitProvider('github') as Required<GitProvider>;

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  // The permission read is the one thing that leaves the process.
  vi.spyOn(github, 'getRepositoryPermission').mockResolvedValue('write');
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function fixtureBody(name: string): Record<string, unknown> {
  const file = join(process.cwd(), 'tests/fixtures/github/pull-request-review', `${name}.json`);
  return (JSON.parse(readFileSync(file, 'utf8')) as { payload: Record<string, unknown> }).payload;
}

/** A recorded body, re-pointed at this fixture's installation, repository and pull request. */
function delivery(
  name: string,
  o: {
    number?: number;
    reviewId?: number;
    commitSha?: string;
    login?: string;
    userId?: number;
  } = {},
): Record<string, unknown> {
  const body = structuredClone(fixtureBody(name));
  const review = body['review'] as Record<string, unknown>;
  const pr = body['pull_request'] as Record<string, unknown>;
  if (o.reviewId !== undefined) review['id'] = o.reviewId;
  review['commit_id'] = o.commitSha ?? HEAD;
  review['user'] = {
    login: o.login ?? 'ada-l',
    id: o.userId ?? 4242,
    type: 'User',
  };
  pr['number'] = o.number ?? 131;
  pr['head'] = { ...(pr['head'] as Record<string, unknown>), sha: HEAD };
  return {
    ...body,
    review,
    pull_request: pr,
    installation: { id: INSTALLATION_ID },
    repository: {
      id: Number(REPO_PROVIDER_ID),
      name: 'acme',
      full_name: 'moooon/acme',
      owner: { login: 'moooon', id: 55, type: 'Organization' },
    },
  };
}

const send = (body: Record<string, unknown>) =>
  githubWebhookService.handleEvent('pull_request_review', body, `d-${(seq += 1)}`);

/** The installation + repository this fixture's deliveries name. */
async function connectRepo(): Promise<{ id: string }> {
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  return adminDb.githubRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      installationId: installation.id,
      repoId: REPO_PROVIDER_ID,
      owner: 'moooon',
      name: 'acme',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
}

/** A mirrored pull request, optionally delivering a card that holds an awaiting gate. */
async function pullRequest(opts: { linked?: boolean; withGate?: boolean; number?: number } = {}) {
  const repo = await connectRepo();
  const number = opts.number ?? 131;
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number,
      title: 'Rate-limit the public API per key',
      state: 'open',
      headRef: 'subtask/ACME-131',
      baseRef: 'main',
      provider: 'github',
    },
  });
  await adminDb.githubCheckRun.create({
    data: { pullRequestId: pr.id, commitSha: HEAD, checkName: 'Vitest', conclusion: 'success' },
  });

  let item = null;
  let gate = null;
  if (opts.linked) {
    item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Throttle the public API' },
      fx.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: item.id,
        githubPullRequestId: pr.id,
        repoId: repo.id,
      },
    });
    if (opts.withGate) {
      gate = await withWorkspaceContext(fx.ctx, (tx) =>
        approvalGateRepository.create(
          {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            workItemId: item!.id,
            kind: 'pull_request_approval',
            subjectId: item!.id,
            subjectVersion: `moooon/acme#${number}@${HEAD}`,
          },
          tx,
        ),
      );
    }
  }
  return { repo, pr, item, gate };
}

const reviewRows = (pullRequestId: string) =>
  adminDb.githubPullRequestReview.findMany({ where: { githubPullRequestId: pullRequestId } });

describe('the arm EXISTS (MOTIR-5598)', () => {
  it('no longer answers unhandled_event', async () => {
    const result = await send(delivery('submitted-approved'));
    expect(result).not.toMatchObject({
      event: 'ignored',
      reason: 'unhandled_event:pull_request_review',
    });
  });
});

describe('recording a review (MOTIR-5598)', () => {
  it('records the reviewer, state, commit and permission, and decides the gate', async () => {
    const { pr, gate } = await pullRequest({ linked: true, withGate: true });

    const result = await send(delivery('submitted-approved'));

    expect(result).toEqual({ event: 'pull_request_review', outcome: 'decided_approved' });
    const [row] = await reviewRows(pr.id);
    expect(row).toMatchObject({
      reviewerLogin: 'ada-l',
      reviewerGithubUserId: '4242',
      state: 'approved',
      commitSha: HEAD,
      reviewerPermission: 'write',
    });
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate!.id } })).state).toBe(
      'approved',
    );
  });

  it('records what a changes-requested review SAID, and that text is the gate’s reason (MOTIR-6074)', async () => {
    const { pr, gate } = await pullRequest({ linked: true, withGate: true });

    const result = await send(delivery('submitted-changes-requested'));

    expect(result).toEqual({ event: 'pull_request_review', outcome: 'decided_changes_requested' });
    const [row] = await reviewRows(pr.id);
    expect(row!.body).toBe('Looks right to me.');
    expect(await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate!.id } })).toMatchObject(
      {
        state: 'changes_requested',
        noteMd: 'Looks right to me.',
        decisionSource: 'github',
      },
    );
  });

  it('is IDEMPOTENT on the review id — the same delivery twice leaves one row', async () => {
    const { pr } = await pullRequest({ linked: true, withGate: true });
    const body = delivery('submitted-approved');

    const first = await send(body);
    const second = await send(body);

    expect(await reviewRows(pr.id)).toHaveLength(1);
    expect(first).toMatchObject({ outcome: 'decided_approved' });
    // The gate is no longer awaiting, so the redelivery finds nothing left to answer.
    expect(['already_decided', 'no_awaiting_gate']).toContain(
      (second as { outcome: string }).outcome,
    );
  });

  it('records a DISMISSED review, and a late submitted redelivery does not resurrect it', async () => {
    const { pr } = await pullRequest({ linked: true, withGate: true });

    await send(delivery('dismissed', { reviewId: 777 }));
    expect((await reviewRows(pr.id))[0]!.state).toBe('dismissed');

    // GitHub promises no order between `submitted` and `dismissed`.
    await send(delivery('submitted-approved', { reviewId: 777 }));

    const rows = await reviewRows(pr.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('dismissed');
  });

  it('records a review of an UNLINKED pull request and says so, with 2xx', async () => {
    const { pr } = await pullRequest({ linked: false });

    const result = await send(delivery('submitted-approved'));

    // The row stays, so a later link and raise can still count it (decision 8).
    expect(result).toEqual({ event: 'pull_request_review', outcome: 'recorded_unlinked' });
    expect(await reviewRows(pr.id)).toHaveLength(1);
  });
});

describe('what writes NOTHING (MOTIR-5598)', () => {
  it('ignores an `edited` delivery', async () => {
    const { pr } = await pullRequest({ linked: true, withGate: true });
    const result = await send(delivery('edited'));
    expect(result).toEqual({ event: 'pull_request_review', outcome: 'ignored_action' });
    expect(await reviewRows(pr.id)).toHaveLength(0);
  });

  it('answers a malformed body without throwing', async () => {
    const result = await send({ action: 'submitted' });
    expect(result).toEqual({ event: 'pull_request_review', outcome: 'malformed' });
  });

  it('answers unknown_installation with 2xx and writes nothing', async () => {
    const result = await send(delivery('submitted-approved'));
    expect(result).toEqual({ event: 'pull_request_review', outcome: 'unknown_installation' });
    expect(await adminDb.githubPullRequestReview.count()).toBe(0);
  });

  it('answers unknown_repo with 2xx and writes nothing', async () => {
    // The installation is connected; the repository the delivery names is not.
    await adminDb.githubInstallation.create({
      data: {
        workspaceId: fx.workspaceId,
        installationId: INSTALLATION_ID,
        accountLogin: 'moooon',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const result = await send(delivery('submitted-approved'));
    expect(result).toEqual({ event: 'pull_request_review', outcome: 'unknown_repo' });
    expect(await adminDb.githubPullRequestReview.count()).toBe(0);
  });

  it('answers unknown_pull_request when the repository is connected but the row is not mirrored', async () => {
    await connectRepo();
    const result = await send(delivery('submitted-approved'));
    expect(result).toEqual({ event: 'pull_request_review', outcome: 'unknown_pull_request' });
    expect(await adminDb.githubPullRequestReview.count()).toBe(0);
  });
});

describe('the failure paths are all 2xx (MOTIR-5598)', () => {
  it('records `unknown` when the permission read fails, and that review decides nothing', async () => {
    const { pr, gate } = await pullRequest({ linked: true, withGate: true });
    vi.spyOn(github, 'getRepositoryPermission').mockRejectedValue(
      new ProviderPermissionReadError('github', 'unexpected_status', { status: 403 }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await send(delivery('submitted-approved'));

    expect((await reviewRows(pr.id))[0]!.reviewerPermission).toBe('unknown');
    // `unknown` counts for nothing — the safe direction, since the person can still
    // approve in Motir.
    expect(result).toEqual({ event: 'pull_request_review', outcome: 'pending' });
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate!.id } })).state).toBe(
      'awaiting',
    );
    expect(warn).toHaveBeenCalled();
  });

  it('COMMITS the row and returns 2xx when the evaluation throws', async () => {
    const { pr } = await pullRequest({ linked: true, withGate: true });
    vi.spyOn(reviewSync, 'evaluateForPullRequest').mockRejectedValue(new Error('evaluation boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await send(delivery('submitted-approved'));

    // The row IS the retry: the next review on that set, or the post-raise evaluation,
    // picks it up. There is no dead-letter, and that is the reason.
    expect(result).toEqual({
      event: 'pull_request_review',
      outcome: 'recorded_evaluation_failed',
    });
    expect(await reviewRows(pr.id)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('evaluation failed after recording'),
      expect.objectContaining({ pullRequestId: pr.id }),
    );
  });
});

describe("Motir's own App bots are not reviewers (MOTIR-10335)", () => {
  const asBot = (body: Record<string, unknown>, login: string) => {
    (body['review'] as Record<string, unknown>)['user'] = { login, id: 777, type: 'Bot' };
    return body;
  };

  it.each(['motir-studio[bot]', 'motir-integration[bot]'])(
    '%s: a Request changes and its dismissal are ignored_bot, stored nowhere and decide nothing',
    async (login) => {
      const { pr, gate } = await pullRequest({ linked: true, withGate: true });

      const submitted = await send(asBot(delivery('submitted-changes-requested'), login));
      const dismissed = await send(asBot(delivery('dismissed'), login));

      expect(submitted).toEqual({ event: 'pull_request_review', outcome: 'ignored_bot' });
      expect(dismissed).toEqual({ event: 'pull_request_review', outcome: 'ignored_bot' });
      expect(await reviewRows(pr.id)).toEqual([]);
      expect(
        (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate!.id } })).state,
      ).toBe('awaiting');
    },
  );

  it('a human approval at the head still decides the gate after a bot review was ignored', async () => {
    const { pr, gate } = await pullRequest({ linked: true, withGate: true });
    await send(
      asBot(delivery('submitted-changes-requested', { reviewId: 1 }), 'motir-studio[bot]'),
    );

    const result = await send(delivery('submitted-approved', { reviewId: 2 }));

    expect(result).toEqual({ event: 'pull_request_review', outcome: 'decided_approved' });
    expect((await reviewRows(pr.id)).map((r) => r.reviewerLogin)).toEqual(['ada-l']);
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate!.id } })).state).toBe(
      'approved',
    );
  });
});

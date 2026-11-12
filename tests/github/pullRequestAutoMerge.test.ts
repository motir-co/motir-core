import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/jobs/sendEvent')>();
  return {
    ...actual,
    sendEvent: async (name: string, data: Record<string, unknown>) => {
      sent.push({ name, data });
    },
  };
});

import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import { MergeChangeRequestError } from '@/lib/git/errors';
import type { MergeChangeRequestResult } from '@/lib/git/types';
import type { JobContext } from '@/lib/jobs/defineJob';
import {
  AUTO_MERGE_MAX_ATTEMPTS,
  pullRequestAutoMerge,
} from '@/lib/jobs/definitions/pullRequestAutoMerge';
import { jobDefinitions } from '@/lib/jobs/registry';
import { jobServices } from '@/lib/jobs/services';
import type { PullRequestAutoMergeRequestedData } from '@/lib/jobs/types';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { promoteDeliveredCardsOnGreen } from '@/lib/services/ciPromotion';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { JobTestEngine } from '../helpers/jobs';
import { linkPrByIdentifier } from '../helpers/prLink';

// AUTO MODE (Story MOTIR-4882 · MOTIR-5518), against a REAL Postgres through the real
// webhook service. The promotion's dispatch is captured at `sendEvent` (the emit seam);
// the job is then driven in-process with the merge seam stubbed — the one call that
// leaves the process.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-auto-merge';
const REPO_PROVIDER_ID = '992';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };
const EVENT = 'pull-request/auto-merge.requested';
const github = getGitProvider('github') as Required<GitProvider>;

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function makeScenario(email: string, mode: 'auto' | 'manual') {
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
  await adminDb.project.update({
    where: { id: project.id },
    data: { prMergeMode: mode, prMergeModeDecidedAt: new Date() },
  });
  const ctx = { userId: user.id, workspaceId: workspace.id };
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
  return { user, workspace, project, ctx };
}

const ci = (conclusion: string, headSha: string, number: number) =>
  githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: headSha,
      head_branch: null,
      status: 'completed',
      conclusion,
      app: { slug: 'github-actions' },
      pull_requests: [{ number }],
    },
  });

async function cardWithPrs(s: Scenario, numbers: number[]) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'Auto' },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  for (const number of numbers) {
    const headRef = `subtask/${item.identifier}-${number}`;
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme',
      number,
      headRef,
    });
    await githubWebhookService.handleEvent('pull_request', {
      action: 'opened',
      installation: INSTALLATION,
      repository: { id: Number(REPO_PROVIDER_ID) },
      pull_request: {
        number,
        state: 'open',
        merged: false,
        title: 'Auto',
        head: { ref: headRef },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });
  }
  return item;
}

const autoMerges = () =>
  sent
    .filter((e) => e.name === EVENT)
    .map((e) => e.data as unknown as PullRequestAutoMergeRequestedData);
const prRow = (number: number) => adminDb.githubPullRequest.findFirstOrThrow({ where: { number } });
/** The comments an auto merge posted — the card also carries CI's own feedback comment,
 *  which is not this card's to count. */
const commentsOn = async (workItemId: string) =>
  (await adminDb.comment.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } })).filter(
    (c) => c.bodyMd.startsWith('**Motir could not'),
  );

function stubSeam(...answers: Array<MergeChangeRequestResult | Error>) {
  const spy = vi.spyOn(github, 'mergeChangeRequest');
  for (const answer of answers) {
    if (answer instanceof Error) spy.mockRejectedValueOnce(answer);
    else spy.mockResolvedValueOnce(answer);
  }
  return spy;
}

/** Run the job for one dispatched event, on the given ZERO-INDEXED attempt. */
async function runJob(data: PullRequestAutoMergeRequestedData, attempt = 0) {
  if (attempt === 0) {
    return new JobTestEngine({
      function: pullRequestAutoMerge,
      events: [{ name: EVENT, data }],
    }).execute();
  }
  const ctx = {
    event: { name: EVENT, data },
    step: { run: async (_id: string, fn: () => unknown) => fn(), sleep: async () => undefined },
    runId: 'test-run-auto-merge',
    attempt,
  } as unknown as JobContext;
  try {
    return { result: await pullRequestAutoMerge.handler(ctx, jobServices) };
  } catch (err) {
    return { error: err as Error };
  }
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  _resetInstallationTokenCache();
  sent.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('AUTO — a green run target is merged with no gate, and the pull request says the setting authorised it', () => {
  it('two green pull requests: in_review, no gate row, TWO jobs dispatched after commit, both recorded auto_mode', async () => {
    const s = await makeScenario('am-two@example.com', 'auto');
    const item = await cardWithPrs(s, [11, 12]);
    const gatesBefore = await adminDb.approvalGate.count();

    await ci('success', 'sha-a', 11);
    expect(autoMerges()).toEqual([]);
    await ci('success', 'sha-b', 12);

    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'in_review',
    );
    const dispatched = autoMerges();
    expect(dispatched).toHaveLength(2);
    expect(dispatched.map((d) => [d.headSha, d.idempotencyKey, d.workItemId]).sort()).toEqual([
      ['sha-a', `${(await prRow(11)).id}:sha-a`, item.id],
      ['sha-b', `${(await prRow(12)).id}:sha-b`, item.id],
    ]);

    stubSeam(
      { outcome: 'merged', commitSha: 'merge-11' },
      { outcome: 'merged', commitSha: 'merge-12' },
    );
    for (const data of dispatched) expect((await runJob(data)).error).toBeUndefined();

    const rows = [await prRow(11), await prRow(12)];
    expect(rows.map((r) => [r.mergeAuthority, r.mergeOutcomeRef]).sort()).toEqual([
      ['auto_mode', 'merge-11'],
      ['auto_mode', 'merge-12'],
    ]);
    // No synthetic approval — the gate table holds only decisions people made.
    expect(await adminDb.approvalGate.count()).toBe(gatesBefore);
    expect(gatesBefore).toBe(0);
  });

  it('enqueued: merge_outcome_ref reads queue:<entryId>', async () => {
    const s = await makeScenario('am-queue@example.com', 'auto');
    await cardWithPrs(s, [11]);
    await ci('success', 'sha-a', 11);
    stubSeam({ outcome: 'enqueued', entryId: 'MQE_7' });

    await runJob(autoMerges()[0]!);

    expect((await prRow(11)).mergeOutcomeRef).toBe('queue:MQE_7');
  });

  it('a MANUAL project dispatches no merge job', async () => {
    const s = await makeScenario('am-manual@example.com', 'manual');
    await cardWithPrs(s, [11]);
    await ci('success', 'sha-a', 11);
    expect(autoMerges()).toEqual([]);
  });

  it('one pull request RED dispatches nothing', async () => {
    const s = await makeScenario('am-red@example.com', 'auto');
    await cardWithPrs(s, [11, 12]);
    await ci('success', 'sha-a', 11);
    await ci('failure', 'sha-b', 12);
    expect(autoMerges()).toEqual([]);
  });
});

describe('one head is attempted once', () => {
  it('a redelivered verdict dispatches the SAME key, and the engine enqueues it once', async () => {
    const s = await makeScenario('am-dedup@example.com', 'auto');
    const item = await cardWithPrs(s, [11]);
    await ci('success', 'sha-a', 11);
    const [first] = autoMerges();

    // The card is now in review; the same verdict arrives again.
    await promoteDeliveredCardsOnGreen({
      changeRequestId: (await prRow(11)).id,
      workspaceId: s.workspace.id,
      actorUserId: s.user.id,
    });
    const keys = autoMerges().map((d) => d.idempotencyKey);
    expect(keys).toEqual([first!.idempotencyKey, first!.idempotencyKey]);

    // Through the REAL emit path: two sends of one key, one queued run.
    const { sendEvent: realSendEvent } =
      await vi.importActual<typeof import('@/lib/jobs/sendEvent')>('@/lib/jobs/sendEvent');
    await realSendEvent(EVENT, first!);
    await realSendEvent(EVENT, first!);
    expect(
      await adminDb.jobQueueRun.count({
        where: { jobId: EVENT, idempotencyKey: first!.idempotencyKey },
      }),
    ).toBe(1);
    expect(item.id).toBe(first!.workItemId);
  });

  it('a head that moved before the job ran is skipped without a host call', async () => {
    const s = await makeScenario('am-moved@example.com', 'auto');
    await cardWithPrs(s, [11]);
    await ci('success', 'sha-a', 11);
    const [data] = autoMerges();
    await ci('success', 'sha-a2', 11);
    const seam = vi.spyOn(github, 'mergeChangeRequest');

    const { result } = await runJob(data!);

    expect(result).toEqual({ outcome: 'skipped', reason: 'head_moved' });
    expect(seam).not.toHaveBeenCalled();
  });
});

describe('nobody is watching an auto merge, so a failure is never silent', () => {
  it('a REFUSAL writes no record and posts ONE comment naming the pull request and the refusal', async () => {
    const s = await makeScenario('am-refused@example.com', 'auto');
    const item = await cardWithPrs(s, [11]);
    await ci('success', 'sha-a', 11);
    stubSeam({ outcome: 'refused', refusal: { code: 'conflict' } });

    const { result } = await runJob(autoMerges()[0]!);

    expect(result).toEqual({ outcome: 'refused', code: 'conflict' });
    expect(await prRow(11)).toMatchObject({ mergeAuthority: null, mergeOutcomeRef: null });
    const comments = await commentsOn(item.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.bodyMd).toContain('moooon/acme#11');
    expect(comments[0]!.bodyMd).toContain('This pull request conflicts with its base branch.');
    expect(comments[0]!.authorId).toBe(s.user.id);
  });

  it('a host that does not answer is retried quietly, and the FINAL attempt posts one comment; in_review stands', async () => {
    const s = await makeScenario('am-timeout@example.com', 'auto');
    const item = await cardWithPrs(s, [11]);
    await ci('success', 'sha-a', 11);
    const [data] = autoMerges();
    expect(AUTO_MERGE_MAX_ATTEMPTS).toBe(3);

    stubSeam(
      new MergeChangeRequestError('github', 'timeout'),
      new MergeChangeRequestError('github', 'timeout'),
      new MergeChangeRequestError('github', 'timeout'),
    );
    for (let attempt = 0; attempt < AUTO_MERGE_MAX_ATTEMPTS; attempt += 1) {
      const outcome = await runJob(data!, attempt);
      expect(outcome.error).toBeInstanceOf(MergeChangeRequestError);
      const expected = attempt + 1 === AUTO_MERGE_MAX_ATTEMPTS ? 1 : 0;
      expect(await commentsOn(item.id)).toHaveLength(expected);
    }

    expect((await commentsOn(item.id))[0]!.bodyMd).toContain('Motir could not reach GitHub');
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'in_review',
    );
    expect(await prRow(11)).toMatchObject({ mergeAuthority: null });
  });
});

describe('the job is registered', () => {
  it('joins the job registry with its dedup key and the transient retry budget', () => {
    expect(jobDefinitions).toContain(pullRequestAutoMerge);
    expect(pullRequestAutoMerge).toMatchObject({
      id: EVENT,
      trigger: EVENT,
      idempotency: 'event.data.idempotencyKey',
      maxAttempts: AUTO_MERGE_MAX_ATTEMPTS,
    });
  });
});

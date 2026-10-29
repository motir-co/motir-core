import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import type { WorkItemRepairRefusal } from '@/lib/dto/workItemRepair';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { warmPool } from '../helpers/warmPool';

// STORY GATE — MOTIR-5460 "hand a red pull request to an agent" (MOTIR-5467).
//
// The units each prove their own piece: the claim (tests/ready/claimWorkItemRepair),
// the command (packages/cli/test/fixCommand), the page (tests/components/repair-fix-part).
// What only an ASSEMBLED test shows is that they agree, over real Postgres and the
// real webhook path:
//
//   1. claim → run → page: a claim is what the Development block reads as *being
//      fixed*, and closing the run clears it;
//   2. fix → green → In Review: the build, through the shipped `ciPromotion` latch,
//      is the only writer of the card's status — the claim wrote none;
//   3. give-up → callout again: a failed run is read as a give-up, and a new claim
//      is admitted;
//
// plus the guards: the race (settled, so a thrown request would show), and the
// refusal matrix as one table that asserts no run AND no card write per reason.

const INSTALLATION_ID = 'inst-repair-gate';
const REPO_PROVIDER_ID = '5460';

async function makeScenario(email: string) {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Owner' });
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
type Scenario = Awaited<ReturnType<typeof makeScenario>>;

const ci = (conclusion: string | null, headSha: string, number: number) =>
  githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: headSha,
      head_branch: null,
      status: conclusion === null ? 'in_progress' : 'completed',
      conclusion,
      app: { slug: 'github-actions' },
      pull_requests: [{ number }],
    },
  });

/** A card whose run ended with its pull request open, at `implemented`. */
async function implementedCard(s: Scenario, title: string, number: number) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  const headRef = `subtask/${item.identifier}-work`;
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'moooon',
    name: 'acme',
    number,
    headRef,
    title,
  });
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
  expect(await statusOf(item.id)).toBe('implemented');
  return item;
}

/** …and its build went RED after the run ended. */
async function redCard(s: Scenario, title: string, number: number) {
  const item = await implementedCard(s, title, number);
  await ci('failure', `sha-${number}-red`, number);
  expect(await statusOf(item.id)).toBe('implemented');
  return item;
}

async function statusOf(id: string) {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}
const fixRuns = (workItemId: string) =>
  adminDb.dispatchRun.findMany({ where: { command: 'fix', cards: { some: { workItemId } } } });
const cardSnapshot = async (id: string) => {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  const revisions = await adminDb.workItemRevision.count({ where: { workItemId: id } });
  return { status: row.status, assigneeId: row.assigneeId, updatedAt: row.updatedAt, revisions };
};

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('seam 1 — claim → run → page', () => {
  it('a claim is what the page reads as being fixed, with its actor and start; closing it clears it', async () => {
    const s = await makeScenario('repair-seam1@example.com');
    const card = await redCard(s, 'Seam one', 101);

    expect(await workItemRepairService.getRepairView(card.id, s.ctx)).toMatchObject({
      state: 'offer',
      lastGaveUp: null,
    });

    const claim = await workItemRepairService.claimRepair(s.project.id, card.identifier, s.ctx);
    expect(claim.outcome).toBe('claimed');
    const run = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: claim.runId! } });
    expect(run).toMatchObject({ command: 'fix', status: 'running', createdById: s.user.id });

    expect(await workItemRepairService.getRepairView(card.id, s.ctx)).toEqual({
      state: 'in_progress',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing: [
        {
          repo: 'moooon/acme',
          number: 101,
          ci: 'failing',
          queueExit: null,
          conflict: null,
          outOfDate: null,
        },
      ],
      holder: { id: s.user.id, name: 'Owner' },
      byViewer: true,
      startedAt: run.startedAt.toISOString(),
      // The open run itself — a local `motir fix`, so no hosted run link (MOTIR-6930).
      run: { id: run.id, label: expect.stringMatching(/^motir fix · .+ UTC$/), hosted: false },
    });

    await dispatchRunService.close(claim.runId!, { stopReason: 'interrupted' }, s.ctx);
    expect(await workItemRepairService.getRepairView(card.id, s.ctx)).toMatchObject({
      state: 'offer',
      lastGaveUp: null,
    });
  });
});

describe('seam 2 — fix → green → In Review', () => {
  it('the build promotes the card through the shipped latch, and the claim wrote no status', async () => {
    const s = await makeScenario('repair-seam2@example.com');
    const card = await redCard(s, 'Seam two', 102);
    const before = await cardSnapshot(card.id);

    const claim = await workItemRepairService.claimRepair(s.project.id, card.identifier, s.ctx);
    expect(claim.outcome).toBe('claimed');
    // The claim itself wrote NOTHING to the card.
    expect(await cardSnapshot(card.id)).toEqual(before);

    // The agent pushed; CI goes green on the new head.
    const res = await ci('success', 'sha-102-fixed', 102);
    expect(res).toMatchObject({ outcome: 'verified', ciState: 'passing' });
    expect(await statusOf(card.id)).toBe('in_review');

    // The ONLY status write after the claim is the promotion.
    const writes = await adminDb.workItemRevision.findMany({
      where: { workItemId: card.id, changedAt: { gt: before.updatedAt } },
      orderBy: { changedAt: 'asc' },
    });
    const statusWrites = writes.filter((w) => JSON.stringify(w).includes('in_review'));
    expect(statusWrites).toHaveLength(1);
    expect(writes).toHaveLength(1);

    // With nothing failing any more, the page shows no fix part.
    await dispatchRunService.close(claim.runId!, { stopReason: 'completed' }, s.ctx);
    expect(await workItemRepairService.getRepairView(card.id, s.ctx)).toEqual({
      state: 'hidden',
    });
  });
});

describe('seam 3 — give-up → callout again', () => {
  it('a run closed as failed reads as a give-up with its count, and a new claim is admitted', async () => {
    const s = await makeScenario('repair-seam3@example.com');
    const card = await redCard(s, 'Seam three', 103);
    const first = await workItemRepairService.claimRepair(s.project.id, card.identifier, s.ctx);
    await dispatchRunService.appendEvents(
      first.runId!,
      [
        {
          kind: 'ci_gave_up',
          workItemKey: card.identifier,
          data: { kind: 'gave_up', attempts: 5, failing: [] },
        },
      ],
      s.ctx,
    );
    const closed = await dispatchRunService.close(first.runId!, { stopReason: 'halted' }, s.ctx);
    expect(closed.status).toBe('failed');

    expect(await workItemRepairService.getRepairView(card.id, s.ctx)).toEqual({
      state: 'offer',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing: [
        {
          repo: 'moooon/acme',
          number: 103,
          ci: 'failing',
          queueExit: null,
          conflict: null,
          outOfDate: null,
        },
      ],
      lastGaveUp: { attempts: 5, endedAt: closed.endedAt },
    });

    const second = await workItemRepairService.claimRepair(s.project.id, card.identifier, s.ctx);
    expect(second.outcome).toBe('claimed');
    expect(second.runId).not.toBe(first.runId);
  });
});

describe('guard — the race', () => {
  it('concurrent claims on one card: exactly one claimed, the rest taken naming it, one run, no errors', async () => {
    const s = await makeScenario('repair-race@example.com');
    const card = await redCard(s, 'Race', 104);
    const rivals = await Promise.all(
      [1, 2, 3].map(async (i) => {
        const u = await usersService.createUser({
          email: `rival-${i}@example.com`,
          password: 'hunter2hunter2',
          name: `Rival ${i}`,
        });
        await workspacesService.addMember({ userId: u.id, workspaceId: s.workspace.id });
        return { userId: u.id, workspaceId: s.workspace.id };
      }),
    );
    const contexts = [s.ctx, ...rivals];

    await warmPool(contexts.length + 2);
    const settled = await Promise.allSettled(
      contexts.map((ctx) => workItemRepairService.claimRepair(s.project.id, card.identifier, ctx)),
    );

    expect(settled.filter((r) => r.status === 'rejected')).toEqual([]);
    const results = settled.map((r) => (r as PromiseFulfilledResult<never>).value) as Awaited<
      ReturnType<typeof workItemRepairService.claimRepair>
    >[];
    const winner = results.filter((r) => r.outcome === 'claimed');
    expect(winner).toHaveLength(1);
    const losers = results.filter((r) => r.outcome === 'taken');
    expect(losers).toHaveLength(contexts.length - 1);
    for (const loser of losers) expect(loser.holder).toEqual(winner[0]!.holder);
    expect(await fixRuns(card.id)).toHaveLength(1);
  });
});

describe('guard — the refusal matrix', () => {
  it('every reason leaves zero runs and an unchanged card', async () => {
    const s = await makeScenario('repair-matrix@example.com');
    const matrix: {
      name: string;
      reason: WorkItemRepairRefusal;
      make: () => Promise<{ id: string; identifier: string }>;
    }[] = [
      {
        name: 'todo',
        reason: 'not_implemented',
        make: () =>
          workItemsService.createWorkItem(
            { projectId: s.project.id, kind: 'task', title: 'todo' },
            s.ctx,
          ),
      },
      {
        // An In Review card is evaluated for a merge-queue ejection now (MOTIR-5803);
        // with none standing and its set GREEN it waits on review, and nothing is failing.
        // (A RED card hand-moved to In Review is claimed since MOTIR-7491 — it used to be
        // this row, and refusing it left the card in no queue.)
        name: 'in_review',
        reason: 'not_failing',
        make: async () => {
          const c = await implementedCard(s, 'in review', 201);
          await ci('success', 'sha-201-green', 201);
          expect(await statusOf(c.id)).toBe('in_review');
          return c;
        },
      },
      {
        name: 'archived',
        reason: 'not_implemented',
        make: async () => {
          const c = await redCard(s, 'archived', 202);
          await adminDb.workItem.update({ where: { id: c.id }, data: { archivedAt: new Date() } });
          return c;
        },
      },
      {
        name: 'a child of a run target',
        reason: 'repair_on_run_target',
        make: async () => {
          const story = await workItemsService.createWorkItem(
            { projectId: s.project.id, kind: 'story', title: 'the target' },
            s.ctx,
          );
          const child = await workItemsService.createWorkItem(
            { projectId: s.project.id, kind: 'subtask', title: 'child', parentId: story.id },
            s.ctx,
          );
          await workItemsService.updateStatus(child.id, 'in_progress', s.ctx);
          await workItemsService.updateStatus(child.id, 'implemented', s.ctx);
          const repo = await adminDb.githubRepo.findFirstOrThrow({ where: { name: 'acme' } });
          await linkProjectRepo({
            workspaceId: s.workspace.id,
            projectId: s.project.id,
            githubRepoId: repo.id,
            name: 'acme',
          });
          await testInstructionsService.publish(
            {
              workItemId: story.id,
              bodyMd: '## Precondition\n\nSign in.',
              previewPath: null,
              repos: [{ repoId: repo.id, commitSha: 'c'.repeat(40) }],
            },
            s.ctx,
          );
          return child;
        },
      },
      {
        name: 'no pull requests',
        reason: 'no_pull_requests',
        make: async () => {
          const c = await workItemsService.createWorkItem(
            { projectId: s.project.id, kind: 'task', title: 'no PRs' },
            s.ctx,
          );
          await workItemsService.updateStatus(c.id, 'in_progress', s.ctx);
          await workItemsService.updateStatus(c.id, 'implemented', s.ctx);
          return c;
        },
      },
      {
        name: 'CI still running',
        reason: 'ci_running',
        make: async () => {
          const c = await implementedCard(s, 'running', 203);
          await ci(null, 'sha-203', 203);
          return c;
        },
      },
      {
        name: 'nothing failing',
        reason: 'not_failing',
        make: async () => {
          // Green CI would promote it out of `implemented`, so "nothing failing"
          // is the card whose pull request has reported no CI at all.
          return implementedCard(s, 'no CI', 204);
        },
      },
    ];

    for (const row of matrix) {
      const card = await row.make();
      const before = await cardSnapshot(card.id);

      const result = await workItemRepairService.claimRepair(s.project.id, card.identifier, s.ctx);

      expect({ name: row.name, outcome: result.outcome, reason: result.reason }).toEqual({
        name: row.name,
        outcome: 'not_repairable',
        reason: row.reason,
      });
      expect(await fixRuns(card.id), row.name).toHaveLength(0);
      expect(await cardSnapshot(card.id), row.name).toEqual(before);
    }
  });
});

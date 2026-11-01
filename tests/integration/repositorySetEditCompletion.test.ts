import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { plansService } from '@/lib/services/plansService';
import { projectsService } from '@/lib/services/projectsService';
import { repoSetCompletionService } from '@/lib/services/repoSetCompletionService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import { adminDb } from '../helpers/adminDb';
import { linkPrByIdentifier } from '../helpers/prLink';
import { truncateAuthTables } from '../helpers/db';
import { linkWorkspaceReposToProject } from '../helpers/projectRepoLink';

// THE REPOSITORY-SET EDIT re-runs the completion gate (Bug MOTIR-9235).
//
// THE DEFECT, IN ONE SENTENCE: a card carrying `[A, B]` whose run found B needed
// no change merged its one pull request in A and was held, correctly — and when
// the person then did what the merge comment told them to and removed B, nothing
// happened, because the gate runs on a DELIVERY and an edit is not one. The card
// waited for an operator to run `pnpm db:reevaluate:repo-set` against production.
//
// Everything below is real from the service down — webhook deliveries, the
// delivery rows, the gate, the workflow, RLS — and every assertion reads the
// item's status out of the database after `updateWorkItem` returned. The edit is
// the ONLY event between the held state and the asserted one.
//
// ⚠️ SINCE MOTIR-10135 A MERGE NO LONGER PRODUCES THAT HELD STATE: completion
// counts the item's linked pull requests, so the merge of A's one pull request
// completes the card. The held state still EXISTS — every card the old rule held
// before the fix shipped sits in it (MOTIR-10106) — so the fixture writes it the
// way it arose: the merge recorded on the mirror, and no delivery deciding it.
// The re-check, asked by the edit or by an operator, is what completes such a
// card now, and the last block pins that it asks the merge's own question.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-repo-set-edit';
const CORE = { name: 'motir-core', providerRepoId: '8101', defaultBranch: 'main' };
const AI = { name: 'motir-ai', providerRepoId: '8102', defaultBranch: 'main' };
const META = { name: 'motir-meta', providerRepoId: '8103', defaultBranch: 'main' };

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function scenario(email: string, targetRepos: string[] = [CORE.name, AI.name]) {
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
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [CORE, AI, META].map((r) => ({
      providerRepoId: r.providerRepoId,
      owner: 'moooon',
      name: r.name,
      defaultBranch: r.defaultBranch,
      archived: false,
    })),
  });
  await linkWorkspaceReposToProject({
    workspaceId: workspace.id,
    projectId: project.id,
    names: [CORE.name, AI.name, META.name],
  });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  const item = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'task',
      title: 'Ships in two repositories, needed one',
      targetRepos,
    },
    ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', ctx);
  return { project, ctx, item };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

function pr(
  s: Scenario,
  repo: typeof CORE,
  number: number,
  action: 'opened' | 'closed',
  merged = false,
) {
  return githubWebhookService.handleEvent('pull_request', {
    action,
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(repo.providerRepoId) },
    pull_request: {
      number,
      state: action === 'closed' ? 'closed' : 'open',
      merged,
      title: `Some change (${s.item.identifier})`,
      head: { ref: `subtask/${s.item.identifier}-change` },
      base: { ref: repo.defaultBranch },
      user: { id: 4242 },
    },
  });
}

/** Link and open a pull request on `repo` — the run's `link_pull_request`. */
async function openLinked(s: Scenario, repo: typeof CORE, number: number) {
  await linkPrByIdentifier({
    identifier: s.item.identifier,
    owner: 'moooon',
    name: repo.name,
    number,
    headRef: `subtask/${s.item.identifier}-change`,
    baseRef: repo.defaultBranch,
  });
  await pr(s, repo, number, 'opened');
}

/** Record pull request `number` on the mirror as closed — merged onto `baseRef`
 *  when given — WITHOUT a delivery: the state a merge the old rule held left
 *  behind (MOTIR-10135). */
async function recordClosed(number: number, merge?: { baseRef: string }) {
  await adminDb.githubPullRequest.updateMany({
    where: { number },
    data: { state: 'closed', merged: merge !== undefined, ...(merge ?? {}) },
  });
}

/** The MOTIR-9190 shape: A's pull request merged, B has none, the card HELD —
 *  as the repository-set gate left it before MOTIR-10135 (see the header). */
async function heldOnTheOtherRepository(email: string) {
  const s = await scenario(email);
  await openLinked(s, CORE, 1);
  await recordClosed(1, { baseRef: CORE.defaultBranch });
  expect(await statusOf(s.item.id)).toBe('implemented');
  return s;
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

describe('the repository-set EDIT re-runs the completion gate', () => {
  it('removing the repository that needed no change COMPLETES the card, with no other event', async () => {
    const s = await heldOnTheOtherRepository('complete@example.com');

    const dto = await workItemsService.updateWorkItem(
      s.item.id,
      { targetRepos: [CORE.name] },
      s.ctx,
    );

    expect(await statusOf(s.item.id)).toBe('done');
    // The answer names the status the edit led to, not the one it left.
    expect(dto.status).toBe('done');
    expect(dto.targetRepos).toEqual([CORE.name]);
  });

  it('an edit that leaves the set UNCHANGED re-runs nothing', async () => {
    const s = await heldOnTheOtherRepository('unchanged@example.com');
    const spy = vi.spyOn(repoSetCompletionService, 'reevaluateItem');

    await workItemsService.updateWorkItem(
      s.item.id,
      { targetRepos: [CORE.name, AI.name], title: 'Renamed' },
      s.ctx,
    );

    expect(spy).not.toHaveBeenCalled();
    expect(await statusOf(s.item.id)).toBe('implemented');
  });

  it('a set edit on a card with NO delivery moves nothing', async () => {
    const s = await scenario('undelivered@example.com');

    await workItemsService.updateWorkItem(s.item.id, { targetRepos: [CORE.name] }, s.ctx);

    expect(await statusOf(s.item.id)).toBe('in_progress');
  });
});

describe('the edit completes nothing the gate would not (the outcomes still apply)', () => {
  it('an EMPTY set abstains — clearing the repositories does not complete the card', async () => {
    const s = await heldOnTheOtherRepository('empty@example.com');
    const spy = vi.spyOn(repoSetCompletionService, 'reevaluateItem');

    await workItemsService.updateWorkItem(s.item.id, { targetRepos: [] }, s.ctx);

    expect(await spy.mock.results[0]!.value).toMatchObject({ outcome: 'abstained_no_repo_set' });
    expect(await statusOf(s.item.id)).toBe('implemented');
  });

  it('an OPEN linked pull request holds it', async () => {
    const s = await heldOnTheOtherRepository('open@example.com');
    // The second repository's pull request is open and linked — the run has not
    // finished there — when the person removes that repository.
    await openLinked(s, AI, 2);
    const spy = vi.spyOn(repoSetCompletionService, 'reevaluateItem');

    await workItemsService.updateWorkItem(s.item.id, { targetRepos: [CORE.name] }, s.ctx);

    expect(await spy.mock.results[0]!.value).toMatchObject({
      outcome: 'held_open_change_request',
    });
    expect(await statusOf(s.item.id)).not.toBe('done');
  });

  it('an UNDECIDED plan hold keeps it at Planning', async () => {
    const s = await heldOnTheOtherRepository('plan-held@example.com');
    const plan = await plansService.createPlan(s.project.id, { title: 'Re-plan' }, s.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: s.item.id, patch: { descriptionMd: 'Re-scoped.' } }],
      s.ctx,
    );
    await plansService.markPlanned(plan.id, s.ctx);
    expect(await statusOf(s.item.id)).toBe(PLANNING_STATUS_KEY);
    // `open` so `planning → done` is a legal edge and ONLY the hold can refuse —
    // the restricted graph would answer `illegal_transition` first.
    await adminDb.project.update({
      where: { id: s.project.id },
      data: { workflowPolicyMode: 'open' },
    });
    const spy = vi.spyOn(repoSetCompletionService, 'reevaluateItem');

    await workItemsService.updateWorkItem(s.item.id, { targetRepos: [CORE.name] }, s.ctx);

    expect(await spy.mock.results[0]!.value).toMatchObject({ outcome: 'plan_held' });
    expect(await statusOf(s.item.id)).toBe(PLANNING_STATUS_KEY);
  });

  it('a re-check that THROWS never fails the edit it follows', async () => {
    const s = await heldOnTheOtherRepository('throws@example.com');
    vi.spyOn(repoSetCompletionService, 'reevaluateItem').mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const dto = await workItemsService.updateWorkItem(
      s.item.id,
      { targetRepos: [CORE.name] },
      s.ctx,
    );

    expect(dto.targetRepos).toEqual([CORE.name]);
    expect(dto.status).toBe('implemented');
  });
});

describe('the re-check asks the merge’s question — the linked pull requests (MOTIR-10135)', () => {
  /** A card listing three repositories, with linked pull requests in two. */
  async function threeRepositoriesTwoLinked(email: string) {
    const s = await scenario(email, [CORE.name, AI.name, META.name]);
    await openLinked(s, CORE, 1);
    await openLinked(s, AI, 2);
    expect(await statusOf(s.item.id)).toBe('implemented');
    return s;
  }

  it('COMPLETES a card whose linked pull requests have all merged, whatever else it lists', async () => {
    const s = await threeRepositoriesTwoLinked('reeval-complete@example.com');
    await recordClosed(1, { baseRef: CORE.defaultBranch });
    await recordClosed(2, { baseRef: AI.defaultBranch });

    const verdict = await repoSetCompletionService.reevaluateItem(s.item.id);

    // motir-meta has no pull request, and nothing waits for it.
    expect(verdict).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(verdict.shortfall.outstanding).toEqual([]);
    expect(await statusOf(s.item.id)).toBe('done');
  });

  it('HOLDS while a linked pull request is still open', async () => {
    const s = await threeRepositoriesTwoLinked('reeval-open@example.com');
    await recordClosed(1, { baseRef: CORE.defaultBranch });

    const verdict = await repoSetCompletionService.reevaluateItem(s.item.id);

    expect(verdict).toMatchObject({ outcome: 'held_open_change_request' });
    expect(await statusOf(s.item.id)).toBe('implemented');
  });

  it('HOLDS when a linked pull request merged onto a NON-default base, and names it', async () => {
    const s = await threeRepositoriesTwoLinked('reeval-stranded@example.com');
    await recordClosed(1, { baseRef: CORE.defaultBranch });
    await recordClosed(2, { baseRef: 'feature/stack-base' });

    const verdict = await repoSetCompletionService.reevaluateItem(s.item.id);

    expect(verdict).toMatchObject({
      outcome: 'held_incomplete_delivery_set',
      deliveryShortfall: { outstanding: [], strandedBase: ['moooon/motir-ai#2'], unknownBase: [] },
    });
    expect(await statusOf(s.item.id)).toBe('implemented');
  });

  it('a dry run DECIDES the same hold and writes nothing', async () => {
    const s = await threeRepositoriesTwoLinked('reeval-dry@example.com');
    await recordClosed(1, { baseRef: CORE.defaultBranch });
    await recordClosed(2, { baseRef: 'feature/stack-base' });

    const verdict = await repoSetCompletionService.reevaluateItem(s.item.id, { dryRun: true });

    expect(verdict.outcome).toBe('held_incomplete_delivery_set');
    expect(await statusOf(s.item.id)).toBe('implemented');
  });

  it('with NO landed delivery it still asks the repository set — nothing shipped', async () => {
    // Both pull requests were closed unmerged: no evidence the work happened, so
    // the list is still read and the card is held on it.
    const s = await threeRepositoriesTwoLinked('reeval-none-landed@example.com');
    await recordClosed(1);
    await recordClosed(2);

    const verdict = await repoSetCompletionService.reevaluateItem(s.item.id);

    expect(verdict).toMatchObject({ outcome: 'held_incomplete_repo_set' });
    expect(verdict.shortfall.outstanding).toEqual([CORE.name, AI.name, META.name]);
    expect(verdict.deliveryShortfall).toBeUndefined();
    expect(await statusOf(s.item.id)).toBe('implemented');
  });
});

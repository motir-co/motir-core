import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { promoteIfCiAlreadyGreen } from '@/lib/services/ciPromotion';
import {
  STALE_PENDING_MS,
  shaToReReadFromHost,
  stalePendingSha,
} from '@/lib/services/checkSetReconcile';
import type { ReportedCheckRun } from '@/lib/github/checkRuns';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// MOTIR-5838 — A LOST CHECK COMPLETION STRANDS A GREEN PULL REQUEST AT
// `ci: running` FOR EVER.
//
// The observed instance: PR #2994, head `7bf7511e3`, linked to MOTIR-5782. On
// GitHub at 21:35Z every check run was `completed` — 22 `success`, 8 `skipped`,
// ZERO pending — and the combined commit status was `success`. Motir's delivery
// row for the same head read `ci: "running"`. The card sat at `implemented`
// from 20:20:41; the 21:00 and 21:30 reconcile ticks both passed with no
// change, and re-firing the latch by hand (`implemented → in_progress →
// implemented`) did not repair it either.
//
// ── WHY EVERY PATH DECLINED ─────────────────────────────────────────────────
// `derivePrCiState` folds any live `pending` row at the head to `running`, so
// `running` means *we hold rows for this head and at least one still says
// pending*. Then:
//
//   1. the CI-green latch asks `reconcileClaimedCompleteDeliveries`, which
//      MOTIR-4199 scoped to members whose recorded set claims COMPLETENESS —
//      its own comment states the exclusion: "A member with a live pending row
//      is already `running` and already withholds, so there is no claim to
//      check." A stuck-pending set is precisely the excluded case;
//   2. the 30-minute tick replays lost CLOSES and re-raises missing GATES. It
//      does not re-read the check set, and while the card is not promotable no
//      gate is owed, so it raises nothing — correctly, and for ever;
//   3. the webhook is the only writer that would clear the row, and it is the
//      delivery that was lost.
//
// The asymmetry is the defect: MOTIR-4199 taught the latch to distrust a set
// claiming *I am whole* and left the set claiming *I am still running* trusted
// absolutely, even when it has claimed it for hours.
//
// ── WHY THE CLOCK IS INJECTED AND NEVER SLEPT ON ───────────────────────────
// The threshold is the whole of criterion 3 — a FRESH pending row must not be
// re-read, which is the no-cost property MOTIR-4199 paid for. Both sides are
// pinned by placing the row's `updatedAt` either side of an injected `now`, so
// the assertion measures the PREDICATE and never elapsed time. A timing
// assertion on a shared runner is a flake generator.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-stale-pending';
const REPO_PROVIDER_ID = '5838';
const SUITE_ID = '87626130999';
const HEAD_SHA = '7bf7511e3f774e6f067c1e8bfdc029b9c48e4a89';

/** The fixture's three lanes: two that reported, and the one whose completion
 *  event was lost. */
const REPORTED_LANES = ['TypeScript build', 'Prettier'];
const LOST_LANE = 'Vitest';

/** A `now` far enough past the seeded rows that the pending one is stale, and a
 *  `now` at which it is still fresh. Both are derived from ONE base so the two
 *  sides of the threshold cannot drift apart. */
const ROW_WRITTEN_AT = new Date('2026-09-19T20:20:41.000Z');
const LONG_AFTER = new Date(ROW_WRITTEN_AT.getTime() + STALE_PENDING_MS + 60_000);
const MOMENTS_AFTER = new Date(ROW_WRITTEN_AT.getTime() + 60_000);

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
  const installation = (await adminDb.githubInstallation.findFirst({
    where: { installationId: INSTALLATION_ID },
  }))!;
  const repo = (await adminDb.githubRepo.findFirst({
    where: { installationId: installation.id, repoId: REPO_PROVIDER_ID },
  }))!;
  return { user, workspace, project, ctx, installation, repo };
}

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

/** A card at `implemented` with its own linked, OPEN pull request — the shape
 *  MOTIR-5782 was in when its PR went green and nothing moved. */
async function cardWithPr(s: Scenario, title: string, number: number) {
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
    title: `A change (${headRef})`,
  });
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
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
  expect(await statusOf(item.id)).toBe('implemented');
  return item;
}

function reported(
  entries: [name: string, conclusion: 'success' | 'failure' | 'pending'][],
): ReportedCheckRun[] {
  return entries.map(([checkName, conclusion]) => ({
    checkName,
    checkSuiteId: SUITE_ID,
    conclusion,
    rawConclusion: conclusion === 'pending' ? null : conclusion,
    url: null,
    completedAt: null,
  }));
}

/**
 * Seed the STRANDED state directly: two settled rows and one still reading
 * `pending`, all stamped at a chosen moment.
 *
 * ⚠️ `updatedAt` IS WRITTEN EXPLICITLY, and it has to be. The column is
 * `@updatedAt`, so Prisma stamps it `now()` on a create — which would make
 * every seeded row fresh by construction and the stale arm unreachable. The row
 * is created and then back-dated with `updateMany`, which Prisma's
 * `@updatedAt` does not override when the field is supplied.
 */
async function seedStrandedRows(prNumber: number, writtenAt: Date): Promise<void> {
  const pr = (await adminDb.githubPullRequest.findFirst({ where: { number: prNumber } }))!;
  await adminDb.githubCheckRun.createMany({
    data: [
      ...REPORTED_LANES.map((checkName) => ({
        pullRequestId: pr.id,
        commitSha: HEAD_SHA,
        checkName,
        checkSuiteId: SUITE_ID,
        conclusion: 'success',
      })),
      {
        pullRequestId: pr.id,
        commitSha: HEAD_SHA,
        checkName: LOST_LANE,
        checkSuiteId: SUITE_ID,
        conclusion: 'pending',
      },
    ],
  });
  await adminDb.githubCheckRun.updateMany({
    where: { pullRequestId: pr.id, commitSha: HEAD_SHA },
    data: { createdAt: writtenAt, updatedAt: writtenAt },
  });
}

async function statusOf(workItemId: string): Promise<string> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
}

async function conclusionOf(prNumber: number, checkName: string): Promise<string> {
  const pr = (await adminDb.githubPullRequest.findFirst({ where: { number: prNumber } }))!;
  const row = (await adminDb.githubCheckRun.findFirst({
    where: { pullRequestId: pr.id, commitSha: HEAD_SHA, checkName },
  }))!;
  return row.conclusion;
}

async function approvalGatesOn(workItemId: string) {
  return adminDb.approvalGate.findMany({ where: { workItemId, kind: 'pull_request_approval' } });
}

/** Every check run the host holds for the commit: all three complete, which is
 *  what GitHub answered for `7bf7511e3` while Motir held one row at `pending`. */
const HOST_SAYS_ALL_GREEN = () =>
  reported([...REPORTED_LANES, LOST_LANE].map((n) => [n, 'success'] as [string, 'success']));

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('MOTIR-5838 — a stale `pending` row is re-read from the host', () => {
  describe('the predicate', () => {
    const rows = (conclusion: string, updatedAt: Date) => [
      {
        commitSha: HEAD_SHA,
        checkName: LOST_LANE,
        checkSuiteId: SUITE_ID,
        conclusion,
        conclusionAt: null,
        createdAt: ROW_WRITTEN_AT,
        updatedAt,
      },
    ];

    it('names the head sha when a pending row is older than the threshold', () => {
      expect(stalePendingSha(rows('pending', ROW_WRITTEN_AT), LONG_AFTER)).toBe(HEAD_SHA);
    });

    it('names NOTHING while that same row is still fresh — the no-cost property', () => {
      expect(stalePendingSha(rows('pending', ROW_WRITTEN_AT), MOMENTS_AFTER)).toBeNull();
    });

    it('is exact at the threshold rather than approximate either side of it', () => {
      const atCutoff = new Date(ROW_WRITTEN_AT.getTime() + STALE_PENDING_MS);
      const justInside = new Date(atCutoff.getTime() - 1);
      expect(stalePendingSha(rows('pending', ROW_WRITTEN_AT), atCutoff)).toBe(HEAD_SHA);
      expect(stalePendingSha(rows('pending', ROW_WRITTEN_AT), justInside)).toBeNull();
    });

    it('names nothing for a row that is not pending, however old', () => {
      expect(stalePendingSha(rows('success', ROW_WRITTEN_AT), LONG_AFTER)).toBeNull();
    });

    it('still names a set that claims COMPLETENESS — MOTIR-4199 is not narrowed', () => {
      // A fresh, terminal set: stale-pending says nothing, and the combined
      // question must still return the sha on MOTIR-4199's own arm.
      expect(shaToReReadFromHost(rows('success', ROW_WRITTEN_AT), MOMENTS_AFTER)).toBe(HEAD_SHA);
    });
  });

  it('REPRODUCTION — the stranded card is promoted and its gate raised once the host is re-asked', async () => {
    const s = await makeScenario('stranded@example.com');
    const card = await cardWithPr(s, 'the planning canvases never draw a folder', 2994);
    await seedStrandedRows(2994, ROW_WRITTEN_AT);

    // The state as observed: the card is at `implemented` and nothing has a
    // question on it.
    expect(await statusOf(card.id)).toBe('implemented');
    expect(await approvalGatesOn(card.id)).toHaveLength(0);

    const asked: string[] = [];
    const promoted = await promoteIfCiAlreadyGreen(
      card.id,
      s.ctx,
      async (args) => {
        asked.push(args.commitSha);
        return HOST_SAYS_ALL_GREEN();
      },
      LONG_AFTER,
    );

    // Criterion 1 — the host was asked at the head, and what it reported was
    // recorded over the row that was stuck.
    expect(asked).toEqual([HEAD_SHA]);
    expect(await conclusionOf(2994, LOST_LANE)).toBe('success');

    // Criterion 2 — the repaired set is green, so the card reaches In Review
    // and the approve-to-merge gate exists: it appears in To approve.
    expect(promoted).toBe(true);
    expect(await statusOf(card.id)).toBe('in_review');
    expect(await approvalGatesOn(card.id)).toHaveLength(1);
  });

  it('CRITERION 3 — a genuinely FRESH pending row is not re-read and nothing moves', async () => {
    const s = await makeScenario('fresh@example.com');
    const card = await cardWithPr(s, 'a lane that really is still running', 2995);
    await seedStrandedRows(2995, ROW_WRITTEN_AT);

    const asked: string[] = [];
    const promoted = await promoteIfCiAlreadyGreen(
      card.id,
      s.ctx,
      async (args) => {
        asked.push(args.commitSha);
        return HOST_SAYS_ALL_GREEN();
      },
      MOMENTS_AFTER,
    );

    // The host is not asked at all — the round trip MOTIR-4199 avoided for the
    // ordinary pull request is still avoided.
    expect(asked).toEqual([]);
    expect(promoted).toBe(false);
    expect(await statusOf(card.id)).toBe('implemented');
    expect(await conclusionOf(2995, LOST_LANE)).toBe('pending');
  });

  it('the host still reporting it PENDING settles nothing and promotes nothing', async () => {
    // The lane is genuinely slow rather than lost. Asking costs a round trip
    // and changes no row — the verdict is unchanged and correct.
    const s = await makeScenario('really-running@example.com');
    const card = await cardWithPr(s, 'a genuinely slow lane', 2996);
    await seedStrandedRows(2996, ROW_WRITTEN_AT);

    const promoted = await promoteIfCiAlreadyGreen(
      card.id,
      s.ctx,
      async () =>
        reported([
          ...REPORTED_LANES.map((n) => [n, 'success'] as [string, 'success']),
          [LOST_LANE, 'pending'],
        ]),
      LONG_AFTER,
    );

    expect(promoted).toBe(false);
    expect(await statusOf(card.id)).toBe('implemented');
    expect(await conclusionOf(2996, LOST_LANE)).toBe('pending');
  });

  it('a lost FAILURE is recorded as a failure, and the card is not promoted', async () => {
    // The mirror case, and the one that proves the re-read writes the HOST's
    // conclusion rather than assuming the happy answer.
    const s = await makeScenario('lost-failure@example.com');
    const card = await cardWithPr(s, 'the lost completion was red', 2997);
    await seedStrandedRows(2997, ROW_WRITTEN_AT);

    const promoted = await promoteIfCiAlreadyGreen(
      card.id,
      s.ctx,
      async () =>
        reported([
          ...REPORTED_LANES.map((n) => [n, 'success'] as [string, 'success']),
          [LOST_LANE, 'failure'],
        ]),
      LONG_AFTER,
    );

    expect(promoted).toBe(false);
    expect(await statusOf(card.id)).toBe('implemented');
    expect(await conclusionOf(2997, LOST_LANE)).toBe('failure');
  });

  it('never overwrites a TERMINAL row with a staler snapshot', async () => {
    // `createMissing`'s safety property, kept. The recorded row has already
    // been settled `failure` by a delivery; a snapshot that still believes the
    // check succeeded must not move it, because the settle is guarded on the
    // row reading `pending` in its own statement.
    const s = await makeScenario('no-clobber@example.com');
    const card = await cardWithPr(s, 'a delivery landed first', 2998);
    const pr = (await adminDb.githubPullRequest.findFirst({ where: { number: 2998 } }))!;
    await adminDb.githubCheckRun.createMany({
      data: [...REPORTED_LANES, LOST_LANE].map((checkName) => ({
        pullRequestId: pr.id,
        commitSha: HEAD_SHA,
        checkName,
        checkSuiteId: SUITE_ID,
        conclusion: checkName === LOST_LANE ? 'failure' : 'success',
      })),
    });
    await adminDb.githubCheckRun.updateMany({
      where: { pullRequestId: pr.id, commitSha: HEAD_SHA },
      data: { createdAt: ROW_WRITTEN_AT, updatedAt: ROW_WRITTEN_AT },
    });

    const promoted = await promoteIfCiAlreadyGreen(
      card.id,
      s.ctx,
      async () => HOST_SAYS_ALL_GREEN(),
      LONG_AFTER,
    );

    expect(promoted).toBe(false);
    expect(await conclusionOf(2998, LOST_LANE)).toBe('failure');
    expect(await statusOf(card.id)).toBe('implemented');
  });
});

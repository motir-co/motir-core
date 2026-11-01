import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// Story 7.10 · MOTIR-1579 — the Development surface's READ PATH, as an
// integration SEAM test: what the webhook ingestion WRITES (PR rows + title +
// check rows, MOTIR-892/894 + this card's captures) is read BACK through the
// next consumers' DTOs — `getQuickView().pullRequests` (the peek) and
// `listLinkedPullRequests` (the detail page) — so a key/shape drift between
// writer and reader fails here, not in the browser. Real Postgres.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-dev-surface';
const REPO_PROVIDER_ID = '888';

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
  return { user, workspace, project, ctx };
}

function prEvent(opts: {
  number: number;
  headBranch: string;
  title: string;
  state?: string;
  merged?: boolean;
  action?: string;
}) {
  return {
    action: opts.action ?? 'opened',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: opts.number,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      title: opts.title,
      head: { ref: opts.headBranch },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  };
}

function checkRunEvent(opts: {
  conclusion: string | null;
  status?: string;
  name: string;
  headSha: string;
  prNumber: number;
}) {
  return {
    action: 'completed',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_run: {
      head_sha: opts.headSha,
      status: opts.status ?? 'completed',
      conclusion: opts.conclusion,
      name: opts.name,
      check_suite: { head_branch: null },
      pull_requests: [{ number: opts.prNumber }],
    },
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('getQuickView().pullRequests — the Development surface read path (MOTIR-1579)', () => {
  it('an item with no linked PR reads back an empty list (the EmptyState case)', async () => {
    const s = await makeScenario('dev-empty@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Nothing linked' },
      s.ctx,
    );
    const peek = await workItemsService.getQuickView(
      s.project.id,
      item.identifier,
      s.project.accessMode,
      s.ctx,
      'en',
    );
    expect(peek.pullRequests).toEqual([]);
  });

  it('reads back the ingested PR display-ready: captured title, repo meta, state, per-PR CI, URL', async () => {
    const s = await makeScenario('dev-populated@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A tracked change' },
      s.ctx,
    );
    // Link the pull request, then ingest it OPEN, then a pending + a success
    // check at the same head sha → 'running' wins. (MOTIR-3674: the branch names
    // the item as a label; the LINK is what puts it on this surface.)
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme',
      number: 41,
      headRef: `feat/${item.identifier}-work`,
      title: 'Throttle burst traffic',
    });
    await githubWebhookService.handleEvent(
      'pull_request',
      prEvent({
        number: 41,
        headBranch: `feat/${item.identifier}-work`,
        title: 'Throttle burst traffic',
      }),
    );
    await githubWebhookService.handleEvent(
      'check_run',
      checkRunEvent({ conclusion: 'success', name: 'lint', headSha: 'sha1', prNumber: 41 }),
    );
    await githubWebhookService.handleEvent(
      'check_run',
      checkRunEvent({
        conclusion: null,
        status: 'in_progress',
        name: 'build',
        headSha: 'sha1',
        prNumber: 41,
      }),
    );

    const peek = await workItemsService.getQuickView(
      s.project.id,
      item.identifier,
      s.project.accessMode,
      s.ctx,
      'en',
    );
    expect(peek.pullRequests).toEqual([
      {
        // MOTIR-5005: the row's own cuid, which the REMOVE control addresses the
        // delivery by. `expect.any(String)` rather than a literal because it is
        // generated — but it stays inside `toEqual`, so the key must be PRESENT.
        // Loosening this to `toMatchObject` would retire the exact-shape guard
        // these two assertions exist to be.
        id: expect.any(String),
        title: 'Throttle burst traffic',
        repo: 'moooon/acme',
        number: 41,
        state: 'open',
        ci: 'running',
        // MOTIR-5691: the head the CI pill is formed over — the approve-to-merge frame
        // names a moved member by it. Both checks reported at `sha1`.
        headSha: 'sha1',
        url: 'https://github.com/moooon/acme/pull/41',
        // MOTIR-5602: what this pull request's review on GitHub says. Null here because
        // nobody has reviewed it — absence of a countable review is not a state, exactly
        // as `ci: null` draws no pill. It stays inside `toEqual` for the same reason `id`
        // does: the key must be PRESENT.
        githubReview: null,
        // MOTIR-10099: no preview record, so the row draws no preview line.
        preview: null,
        // MOTIR-5916: the branch it targets, and whether the host reports it conflicted AT
        // its head — nothing has read its mergeability, so it is not.
        baseRef: 'main',
        conflicted: false,
      },
    ]);

    // The detail page's read (same service method) returns the identical shape.
    const itemRow = await adminDb.workItem.findFirst({ where: { title: 'A tracked change' } });
    const detailPrs = await workItemsService.listLinkedPullRequests(itemRow!.id, s.ctx);
    expect(detailPrs).toEqual(peek.pullRequests);
  });

  it('a merged PR reads back state "merged", and a pre-capture row (null title) falls back to its head branch', async () => {
    const s = await makeScenario('dev-merged@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A merged change' },
      s.ctx,
    );
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme',
      number: 7,
      headRef: `feat/${item.identifier}-done`,
      title: 'Ship it',
    });
    await githubWebhookService.handleEvent(
      'pull_request',
      prEvent({
        number: 7,
        headBranch: `feat/${item.identifier}-done`,
        title: 'Ship it',
        action: 'closed',
        state: 'closed',
        merged: true,
      }),
    );
    // Simulate a row ingested BEFORE title capture (MOTIR-892-era data).
    await adminDb.githubPullRequest.updateMany({ where: { number: 7 }, data: { title: null } });

    const peek = await workItemsService.getQuickView(
      s.project.id,
      item.identifier,
      s.project.accessMode,
      s.ctx,
      'en',
    );
    expect(peek.pullRequests).toEqual([
      {
        id: expect.any(String), // MOTIR-5005 — see the sibling case above
        title: `feat/${item.identifier}-done`, // headRef fallback
        repo: 'moooon/acme',
        number: 7,
        state: 'merged',
        ci: null, // no check rows → no CI pill
        headSha: null, // …and no check rows → no known head (MOTIR-5691)
        url: 'https://github.com/moooon/acme/pull/7',
        githubReview: null, // MOTIR-5602 — nobody reviewed it
        preview: null,
        baseRef: 'main', // MOTIR-5916 — see the sibling case above
        conflicted: false,
      },
    ]);
  });
});

// ── Q8 (Story MOTIR-5488 · MOTIR-5498) ───────────────────────────────────────
// The peek draws a design result inside its Development block only when a linked
// pull request is OPEN, so its read carries the current result in exactly that
// case and nothing otherwise.
describe('getQuickView().designEvidence — the Development slot read (Q8)', () => {
  async function designCardWithPr(email: string, prState: 'open' | 'merged') {
    const s = await makeScenario(email);
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: `Design with a ${prState} PR` },
      s.ctx,
    );
    const row = await adminDb.workItem.findFirstOrThrow({ where: { id: item.id } });
    await adminDb.designEvidence.create({
      data: {
        workspaceId: s.workspace.id,
        workItemId: row.id,
        producedByKey: item.identifier,
        commitSha: 'cafe1234567',
      },
    });
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme',
      number: prState === 'open' ? 91 : 92,
      headRef: `design/${item.identifier}`,
      title: 'Design it',
    });
    if (prState === 'merged') {
      await adminDb.githubPullRequest.updateMany({
        where: { number: 92 },
        data: { state: 'closed', merged: true },
      });
    }
    return workItemsService.getQuickView(
      s.project.id,
      item.identifier,
      s.project.accessMode,
      s.ctx,
      'en',
    );
  }

  it('carries the current design result when a linked pull request is open', async () => {
    const peek = await designCardWithPr('dev-q8-open@example.com', 'open');
    expect(peek.pullRequests.map((pr) => pr.state)).toEqual(['open']);
    expect(peek.designEvidence?.producedByKey).toBe(peek.identifier);
  });

  it('carries nothing when every linked pull request is merged', async () => {
    const peek = await designCardWithPr('dev-q8-merged@example.com', 'merged');
    expect(peek.pullRequests.map((pr) => pr.state)).toEqual(['merged']);
    expect(peek.designEvidence).toBeNull();
  });
});

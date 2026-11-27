import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { PullRequestReadError } from '@/lib/github/pullRequestRead';
import type { CodeGraphForwardData } from '@/lib/jobs/types';
import { codeGraphForwardLiveStateService } from '@/lib/services/codeGraphForwardLiveStateService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { seedIndexWorkspace } from '../helpers/indexFleet';
import { handoffWorld, livePullRequest, stubIndexHandoff } from '../helpers/indexHandoff';

// THE LIVE READ BEHIND A RE-SENT OPEN REPORT (MOTIR-12321) — what GitHub says about a
// pull request NOW, read through the organisation's connected repository row and its
// installation token, over a real Postgres with GitHub stubbed at the HTTP boundary
// (`stubIndexHandoff`: `/access_tokens` and `/pulls/<number>`).

type PullRequestState = Extract<CodeGraphForwardData, { kind: 'pull_request_state' }>;

async function seededOpenReport(
  slug: string,
  fields: Partial<PullRequestState> = {},
): Promise<PullRequestState> {
  const seeded = await seedIndexWorkspace(slug, 1);
  const workspace = await adminDb.workspace.findUniqueOrThrow({
    where: { id: seeded.workspaceId },
    select: { organizationId: true },
  });
  return {
    kind: 'pull_request_state',
    coreOrganizationId: workspace.organizationId,
    repoRef: 'moooon/motir-core',
    ref: 'feature-x',
    pullRequestNumber: 7,
    state: 'open',
    reportedAt: '2026-11-22T10:00:00Z',
    ...fields,
  };
}

/** A closed pull request as GitHub's single read returns it. */
const closedPullRequest = (fields: Record<string, unknown> = {}) => ({
  ...livePullRequest({ state: 'closed' }),
  merged: false,
  merged_at: null,
  updated_at: '2026-11-22T11:00:00Z',
  ...fields,
});

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  stubIndexHandoff();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('codeGraphForwardLiveStateService.read', () => {
  it('an open pull request reads open, through the repository installation', async () => {
    const report = await seededOpenReport('live-open');
    handoffWorld.pullRequest = livePullRequest();
    expect(await codeGraphForwardLiveStateService.read(report)).toEqual({ kind: 'open' });
    expect(handoffWorld.pullRequestReads).toEqual([7]);
  });

  it('a closed pull request reads ended closed, at its updated_at', async () => {
    const report = await seededOpenReport('live-closed');
    handoffWorld.pullRequest = closedPullRequest();
    expect(await codeGraphForwardLiveStateService.read(report)).toEqual({
      kind: 'ended',
      state: 'closed',
      reportedAt: '2026-11-22T11:00:00Z',
    });
  });

  it('a merged pull request reads ended merged, with its merged_at', async () => {
    const report = await seededOpenReport('live-merged');
    handoffWorld.pullRequest = closedPullRequest({
      merged: true,
      merged_at: '2026-11-22T10:59:00Z',
    });
    expect(await codeGraphForwardLiveStateService.read(report)).toEqual({
      kind: 'ended',
      state: 'merged',
      mergedAt: '2026-11-22T10:59:00Z',
      reportedAt: '2026-11-22T11:00:00Z',
    });
  });

  it.each([[404], [410]])('a pull request the host answers %i for reads gone', async (status) => {
    const report = await seededOpenReport(`live-gone-${String(status)}`);
    handoffWorld.pullRequest = { status };
    expect(await codeGraphForwardLiveStateService.read(report)).toEqual({ kind: 'gone' });
  });

  it('a repository the organisation has not connected reads not_connected, and asks GitHub nothing', async () => {
    const report = await seededOpenReport('live-other-repo', { repoRef: 'moooon/elsewhere' });
    expect(await codeGraphForwardLiveStateService.read(report)).toEqual({
      kind: 'not_connected',
    });
    const otherOrg = await seededOpenReport('live-other-org', {
      coreOrganizationId: 'org_not_this_one',
    });
    expect(await codeGraphForwardLiveStateService.read(otherOrg)).toEqual({
      kind: 'not_connected',
    });
    expect(handoffWorld.pullRequestReads).toEqual([]);
  });

  it.each([['no-slash'], ['/motir-core'], ['moooon/']])(
    'a repoRef that is not owner/name (%s) reads not_connected',
    async (repoRef) => {
      const report = await seededOpenReport(`live-bad-${repoRef.length}`, { repoRef });
      expect(await codeGraphForwardLiveStateService.read(report)).toEqual({
        kind: 'not_connected',
      });
    },
  );

  it('a repository connected through a non-GitHub installation reads not_connected', async () => {
    const report = await seededOpenReport('live-gitlab');
    await adminDb.githubInstallation.updateMany({
      where: { installationId: 'inst-live-gitlab' },
      data: { provider: 'gitlab' },
    });
    expect(await codeGraphForwardLiveStateService.read(report)).toEqual({
      kind: 'not_connected',
    });
    expect(handoffWorld.pullRequestReads).toEqual([]);
  });

  it('a host that keeps failing throws PullRequestReadError', async () => {
    const report = await seededOpenReport('live-down');
    handoffWorld.pullRequest = { status: 422 };
    const error = await codeGraphForwardLiveStateService.read(report).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PullRequestReadError);
  });

  it.each([
    ['an unknown state', { state: 'draft' }, 'has no readable state or updated_at'],
    ['no updated_at', { updated_at: null }, 'has no readable state or updated_at'],
    ['an unparseable updated_at', { updated_at: 'yesterday' }, 'has no readable state'],
    ['merged with no merged_at', { merged: true, merged_at: null }, 'is merged with no merged_at'],
  ])('a closed body with %s throws, naming the pull request', async (_label, fields, message) => {
    const report = await seededOpenReport(`live-bad-body-${_label.length}`);
    handoffWorld.pullRequest = closedPullRequest(fields);
    await expect(codeGraphForwardLiveStateService.read(report)).rejects.toThrow(
      `code-graph forward: moooon/motir-core#7 ${message}`,
    );
  });
});

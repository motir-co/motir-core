import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import * as forwardModule from '@/lib/jobs/codeGraphForward';
import type { CodeGraphForwardData } from '@/lib/jobs/types';
import { githubCodeGraphForwardService } from '@/lib/services/githubCodeGraphForwardService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import {
  GITHUB_WEBHOOK_HANDLED_EVENTS,
  githubWebhookService,
} from '@/lib/services/githubWebhookService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { dispatchedEvents, spyOnJobDispatch } from '../helpers/jobs';

// THE GITHUB → CODE-GRAPH FORWARD (MOTIR-12056 · story MOTIR-11870), through
// `githubWebhookService.handleEvent` over a real Postgres. The engine's dispatch is
// spied (`spyOnJobDispatch`), so every event a delivery enqueues — the forward, the
// push refresh, the base-moved re-read — is recorded and none runs.
//
// Each case asserts what was forwarded AND that the delivery's own answer and side
// effects are what they are with the forward switched off.

const INSTALLATION_ID = 'inst-fwd';
const REPO_ID = 555;
const OTHER_REPO_ID = 777;
const UPDATED_AT = '2026-11-22T10:00:00Z';
const MERGED_AT = '2026-11-22T11:00:00Z';
const HEAD = 'a'.repeat(40);

let seq = 0;

/** A workspace with the installation and ONE held repository, `moooon/acme`, default `main`. */
async function scenario() {
  seq += 1;
  const user = await usersService.createUser({
    email: `fwd-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
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
        providerRepoId: String(REPO_ID),
        owner: 'moooon',
        name: 'acme',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const row = await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
  return { workspaceId: workspace.id, organizationId: row.organizationId };
}

function prPayload(
  opts: {
    action?: string;
    number?: number | null;
    headRef?: string | null;
    headRepoId?: number | null;
    merged?: boolean;
    mergedAt?: string | null;
    updatedAt?: string | null;
    installationId?: string;
    repoId?: number;
  } = {},
) {
  const pr: Record<string, unknown> = {
    state: opts.action === 'closed' ? 'closed' : 'open',
    merged: opts.merged ?? false,
    title: 'A change',
    head: {
      ...(opts.headRef === null ? {} : { ref: opts.headRef ?? 'feature-x' }),
      sha: HEAD,
      repo: opts.headRepoId === null ? null : { id: opts.headRepoId ?? REPO_ID },
    },
    base: { ref: 'main' },
    user: { id: 4242 },
  };
  if (opts.number !== null) pr['number'] = opts.number ?? 7;
  if (opts.updatedAt !== null) pr['updated_at'] = opts.updatedAt ?? UPDATED_AT;
  if (opts.mergedAt !== null && opts.mergedAt !== undefined) pr['merged_at'] = opts.mergedAt;
  return {
    action: opts.action ?? 'opened',
    installation: { id: opts.installationId ?? INSTALLATION_ID },
    repository: { id: opts.repoId ?? REPO_ID, full_name: 'moooon/acme' },
    pull_request: pr,
  };
}

function pushPayload(
  opts: { ref?: string; deleted?: boolean; installationId?: string; repoId?: number } = {},
) {
  return {
    ref: opts.ref ?? 'refs/heads/feature-x',
    after: opts.deleted ? '0'.repeat(40) : HEAD,
    ...(opts.deleted !== undefined ? { deleted: opts.deleted } : {}),
    repository: { id: opts.repoId ?? REPO_ID, full_name: 'moooon/acme' },
    installation: { id: opts.installationId ?? INSTALLATION_ID },
  };
}

type Delivery = ['pull_request' | 'push', Record<string, unknown>];

/** Run one delivery in a fresh world; what it answered and enqueued, and the repo row after. */
async function deliver([eventType, body]: Delivery, opts: { forward?: 'on' | 'off' } = {}) {
  await truncateAuthTables();
  const world = await scenario();
  const dispatch = spyOnJobDispatch();
  dispatch.mockClear();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  if (opts.forward === 'off') {
    vi.spyOn(githubCodeGraphForwardService, 'onPullRequest').mockResolvedValue('ignored_action');
    vi.spyOn(githubCodeGraphForwardService, 'onPush').mockResolvedValue('ignored_ref');
  }
  const result = await githubWebhookService.handleEvent(eventType, structuredClone(body));
  const events = dispatchedEvents(dispatch);
  const repo = await adminDb.githubRepo.findFirstOrThrow({
    where: { owner: 'moooon', name: 'acme' },
    select: { defaultBranchHeadSha: true },
  });
  const warnings = warn.mock.calls.map((c) => String(c[0]));
  vi.restoreAllMocks();
  return {
    world,
    warnings,
    result,
    forwards: events
      .filter((e) => e.name === 'system.code-graph-forward')
      .map((e) => e.data as CodeGraphForwardData),
    others: events.filter((e) => e.name !== 'system.code-graph-forward').map((e) => e.name),
    headSha: repo.defaultBranchHeadSha,
  };
}

/** The delivery with the forward on, and the same delivery with it off, side by side. */
async function compare(delivery: Delivery) {
  const off = await deliver(delivery, { forward: 'off' });
  const on = await deliver(delivery);
  expect(on.result).toEqual(off.result);
  expect(on.others).toEqual(off.others);
  expect(on.headSha).toEqual(off.headSha);
  return on;
}

beforeEach(() => {
  _resetInstallationTokenCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a pull request on a held repository forwards ONE state report', () => {
  it.each(['opened', 'reopened'])('%s → state open, exactly the seven fields', async (action) => {
    const { world, forwards } = await compare(['pull_request', prPayload({ action })]);
    expect(forwards).toEqual([
      {
        kind: 'pull_request_state',
        coreOrganizationId: world.organizationId,
        repoRef: 'moooon/acme',
        ref: 'feature-x',
        pullRequestNumber: 7,
        state: 'open',
        reportedAt: UPDATED_AT,
      },
    ]);
  });

  it('closed, not merged → state closed, no mergedAt, no retire', async () => {
    const { forwards } = await compare(['pull_request', prPayload({ action: 'closed' })]);
    expect(forwards).toHaveLength(1);
    expect(forwards[0]).toMatchObject({ kind: 'pull_request_state', state: 'closed' });
    expect(forwards[0]).not.toHaveProperty('mergedAt');
  });

  it('closed and merged → state merged with mergedAt = merged_at, no retire', async () => {
    const { world, forwards } = await compare([
      'pull_request',
      prPayload({ action: 'closed', merged: true, mergedAt: MERGED_AT }),
    ]);
    expect(forwards).toEqual([
      {
        kind: 'pull_request_state',
        coreOrganizationId: world.organizationId,
        repoRef: 'moooon/acme',
        ref: 'feature-x',
        pullRequestNumber: 7,
        state: 'merged',
        mergedAt: MERGED_AT,
        reportedAt: UPDATED_AT,
      },
    ]);
  });

  it.each([[null], ['not a time']])(
    'merged with merged_at %j forwards nothing and warns',
    async (mergedAt) => {
      const { forwards, warnings } = await compare([
        'pull_request',
        prPayload({ action: 'closed', merged: true, mergedAt }),
      ]);
      expect(forwards).toEqual([]);
      expect(warnings).toContain(
        '[githubCodeGraphForward] pull_request for moooon/acme forwarded nothing: merged with no merged_at',
      );
    },
  );

  it('a head on the default branch is forwarded like any other', async () => {
    const { forwards } = await compare(['pull_request', prPayload({ headRef: 'main' })]);
    expect(forwards).toHaveLength(1);
    expect(forwards[0]).toMatchObject({ ref: 'main', state: 'open' });
  });
});

describe('a branch-deleting push forwards ONE retire', () => {
  it('refs/heads/<branch> deleted → retire <branch>; handlePush still answers ignored_ref', async () => {
    const { world, result, forwards } = await compare([
      'push',
      pushPayload({ ref: 'refs/heads/feature/with-slash', deleted: true }),
    ]);
    expect(result).toEqual({ event: 'push', outcome: 'ignored_ref' });
    expect(forwards).toEqual([
      {
        kind: 'retire',
        coreOrganizationId: world.organizationId,
        repoRef: 'moooon/acme',
        ref: 'feature/with-slash',
      },
    ]);
  });

  it('deleting the stored default branch is forwarded too: the service decides', async () => {
    const { forwards } = await compare([
      'push',
      pushPayload({ ref: 'refs/heads/main', deleted: true }),
    ]);
    expect(forwards).toEqual([expect.objectContaining({ kind: 'retire', ref: 'main' })]);
  });

  it('a default-branch push still enqueues its refresh and stamps its head, and forwards nothing', async () => {
    const { result, forwards, others, headSha } = await compare([
      'push',
      pushPayload({ ref: 'refs/heads/main' }),
    ]);
    expect(result).toEqual({ event: 'push', outcome: 'refresh_enqueued' });
    expect(others).toContain('system.code-graph-refresh');
    expect(others).toContain('pull-request/base-moved');
    expect(headSha).toBe(HEAD);
    expect(forwards).toEqual([]);
  });
});

describe('forwards nothing', () => {
  it.each<[string, Delivery]>([
    ['a fork head', ['pull_request', prPayload({ headRepoId: OTHER_REPO_ID })]],
    ['a deleted fork (head.repo null)', ['pull_request', prPayload({ headRepoId: null })]],
    ...(
      ['synchronize', 'edited', 'ready_for_review', 'labeled', 'dequeued', 'enqueued'] as const
    ).map((action): [string, Delivery] => [
      `action ${action}`,
      ['pull_request', prPayload({ action })],
    ]),
    ['an unknown installation (PR)', ['pull_request', prPayload({ installationId: 'nope' })]],
    [
      'a repository with no row (PR)',
      ['pull_request', prPayload({ repoId: OTHER_REPO_ID, headRepoId: OTHER_REPO_ID })],
    ],
    ['no head.ref', ['pull_request', prPayload({ headRef: null })]],
    ['no number', ['pull_request', prPayload({ number: null })]],
    ['no updated_at', ['pull_request', prPayload({ updatedAt: null })]],
    ['an unparseable updated_at', ['pull_request', prPayload({ updatedAt: 'yesterday' })]],
    ['a deleted tag', ['push', pushPayload({ ref: 'refs/tags/v1.0.0', deleted: true })]],
    ['a non-deleting branch push', ['push', pushPayload({ ref: 'refs/heads/feature-x' })]],
    [
      'an unknown installation (push)',
      ['push', pushPayload({ deleted: true, installationId: 'nope' })],
    ],
    [
      'a repository with no row (push)',
      ['push', pushPayload({ deleted: true, repoId: OTHER_REPO_ID })],
    ],
  ])('%s', async (_label, delivery) => {
    const { forwards } = await compare(delivery);
    expect(forwards).toEqual([]);
  });
});

describe('the forward can never change the delivery', () => {
  it.each<[string, Delivery]>([
    [
      'pull_request',
      ['pull_request', prPayload({ action: 'closed', merged: true, mergedAt: MERGED_AT })],
    ],
    ['push', ['push', pushPayload({ deleted: true })]],
  ])(
    '%s: a throwing enqueue is logged once, and the answer is unchanged',
    async (event, delivery) => {
      const off = await deliver(delivery, { forward: 'off' });
      await truncateAuthTables();
      await scenario();
      const dispatch = spyOnJobDispatch();
      vi.spyOn(forwardModule, 'enqueueCodeGraphForward').mockRejectedValue(new Error('queue down'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await githubWebhookService.handleEvent(
        delivery[0],
        structuredClone(delivery[1]),
      );
      expect(result).toEqual(off.result);
      expect(
        dispatchedEvents(dispatch)
          .map((e) => e.name)
          .filter((n) => n !== 'system.code-graph-forward'),
      ).toEqual(off.others);
      const lines = error.mock.calls.filter((c) =>
        String(c[0]).startsWith('[githubCodeGraphForward]'),
      );
      expect(lines).toEqual([
        [`[githubCodeGraphForward] ${event} for moooon/acme forwarded nothing:`, 'queue down'],
      ]);
    },
  );

  it('a throwing organisation read is logged, and the answer is unchanged', async () => {
    const delivery: Delivery = ['pull_request', prPayload()];
    const off = await deliver(delivery, { forward: 'off' });
    await truncateAuthTables();
    await scenario();
    spyOnJobDispatch();
    vi.spyOn(workspaceRepository, 'findByIdInTx').mockRejectedValue('db gone');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await githubWebhookService.handleEvent(
      delivery[0],
      structuredClone(delivery[1]),
    );
    expect(result).toEqual(off.result);
    expect(error).toHaveBeenCalledWith(
      '[githubCodeGraphForward] pull_request for moooon/acme forwarded nothing:',
      'db gone',
    );
  });

  it('a repository row whose workspace reads null forwards nothing', async () => {
    await truncateAuthTables();
    await scenario();
    spyOnJobDispatch();
    vi.spyOn(workspaceRepository, 'findByIdInTx').mockResolvedValue(null);
    await expect(
      githubCodeGraphForwardService.onPush(pushPayload({ deleted: true })),
    ).resolves.toBe('unknown_repo');
  });

  it('a payload with no repository id or installation answers without resolving', async () => {
    await expect(
      githubCodeGraphForwardService.onPush({ ref: 'refs/heads/x', deleted: true, repository: {} }),
    ).resolves.toBe('malformed');
    await expect(
      githubCodeGraphForwardService.onPush({ ref: 'refs/heads/', deleted: true }),
    ).resolves.toBe('ignored_ref');
    await expect(
      githubCodeGraphForwardService.onPullRequest({
        ...prPayload(),
        installation: undefined,
        repository: { id: REPO_ID },
      }),
    ).resolves.toBe('unknown_installation');
  });

  it('GITHUB_WEBHOOK_HANDLED_EVENTS still lists pull_request and push, unchanged', () => {
    expect(GITHUB_WEBHOOK_HANDLED_EVENTS).toContain('pull_request');
    expect(GITHUB_WEBHOOK_HANDLED_EVENTS).toContain('push');
  });
});

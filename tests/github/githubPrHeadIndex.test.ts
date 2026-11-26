import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import * as indexEnqueue from '@/lib/github/indexEnqueue';
import { codeGraphPrHeadIndex } from '@/lib/jobs/definitions/codeGraphPrHeadIndex';
import { githubWebhookDelivery } from '@/lib/jobs/definitions/githubWebhookDelivery';
import type { CodeGraphPrHeadIndexData } from '@/lib/jobs/types';
import '@/lib/jobs/registry';
import { githubPrHeadIndexService } from '@/lib/services/githubPrHeadIndexService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubProvider } from '@/lib/git/providers/github';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { seedIndexWorkspace, stubAppCredentials } from '../helpers/indexFleet';
import {
  HANDOFF_HEAD,
  handoffWorld,
  livePullRequest,
  stubIndexHandoff,
} from '../helpers/indexHandoff';
import {
  JobTestEngine,
  captureJobEvents,
  dispatchedEvents,
  spyOnJobDispatch,
} from '../helpers/jobs';

// THE PULL-REQUEST HEAD INDEX LISTENER (MOTIR-12257 · story MOTIR-12250), through
// `githubWebhookService.handleEvent` over a real Postgres, and then a signed delivery
// POSTed to the real webhook route for each of `opened`, `reopened` and `synchronize`,
// whose enqueued run is driven through the real job to the handoff.

const PR_HEAD = 'system.code-graph-pr-head-index';
const SECRET = 'test-webhook-secret';
/** The delivery's own head sha — deliberately NOT what the run hands off. */
const DELIVERED_SHA = 'd'.repeat(40);

/** A seeded workspace holding `moooon/motir-core` (default `main`), and its ids. */
async function seeded(slug: string) {
  const world = await seedIndexWorkspace(slug, 1);
  const row = await adminDb.githubRepo.findFirstOrThrow({
    where: { owner: 'moooon', name: 'motir-core' },
    select: { repoId: true },
  });
  return { ...world, repoId: Number(row.repoId) };
}

type World = Awaited<ReturnType<typeof seeded>>;

function prPayload(
  w: World,
  opts: {
    action?: string;
    state?: string;
    number?: number | null;
    headRef?: string | null;
    baseRef?: string | null;
    headRepoId?: number | null;
    installationId?: string;
    repoId?: number;
  } = {},
): Record<string, unknown> {
  const repoId = opts.repoId ?? w.repoId;
  const pr: Record<string, unknown> = {
    state: opts.state ?? 'open',
    merged: false,
    updated_at: '2026-11-26T10:00:00Z',
    title: 'A change',
    draft: false,
    head: {
      ...(opts.headRef === null ? {} : { ref: opts.headRef ?? 'feature-x' }),
      sha: DELIVERED_SHA,
      repo: opts.headRepoId === null ? null : { id: opts.headRepoId ?? repoId },
    },
    base: {
      ...(opts.baseRef === null ? {} : { ref: opts.baseRef ?? 'main' }),
      repo: { id: repoId },
    },
    user: { id: 4242, login: 'someone' },
  };
  if (opts.number !== null) pr['number'] = opts.number ?? 7;
  return {
    action: opts.action ?? 'opened',
    installation: { id: opts.installationId ?? w.installationId },
    repository: { id: repoId, full_name: 'moooon/motir-core' },
    pull_request: pr,
  };
}

/** The handling's GitHub reads (changed paths etc.) answered empty; motir-ai unreachable. */
function stubDeliveryFetch() {
  stubAppCredentials();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname.endsWith('/access_tokens')) {
        return new Response(
          JSON.stringify({ token: 'ghs_t', expires_at: new Date(Date.now() + 3_600_000) }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.hostname === 'api.github.com') {
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected request while handling the delivery: ${url.href}`);
    }),
  );
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  _resetInstallationTokenCache();
  vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);
  stubDeliveryFetch();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
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

/** Deliver through `handleEvent`; the answer and every event it enqueued. */
async function handle(eventType: string, body: Record<string, unknown>) {
  const dispatch = spyOnJobDispatch();
  dispatch.mockClear();
  const result = await githubWebhookService.handleEvent(eventType, structuredClone(body));
  const events = dispatchedEvents(dispatch);
  dispatch.mockRestore();
  return {
    result,
    prHeads: events
      .filter((e) => e.name === PR_HEAD)
      .map((e) => e.data as CodeGraphPrHeadIndexData),
    names: events.map((e) => e.name),
  };
}

describe('opened, reopened and synchronize enqueue ONE pull-request head index', () => {
  it.each(['opened', 'reopened', 'synchronize'])(
    '%s → exactly one run, no sha carried, and the same answer as with the listener off',
    async (action) => {
      const w = await seeded(`prl-${action}`);
      const body = prPayload(w, { action });
      const on = await handle('pull_request', body);
      vi.spyOn(githubPrHeadIndexService, 'onPullRequest').mockResolvedValue('ignored_action');
      const off = await handle('pull_request', body);

      expect(on.prHeads).toEqual([
        {
          installationId: w.installationId,
          workspaceId: w.workspaceId,
          repoOwner: 'moooon',
          repoName: 'motir-core',
          defaultBranch: 'main',
          pullRequestNumber: 7,
          headRef: 'feature-x',
          baseRef: 'main',
        },
      ]);
      expect(JSON.stringify(on.prHeads)).not.toContain(DELIVERED_SHA);
      expect(on.result).toEqual(off.result);
      expect(on.names.filter((n) => n !== PR_HEAD)).toEqual(off.names);
    },
  );
});

describe('enqueues nothing', () => {
  it.each<[string, Parameters<typeof prPayload>[1], string]>([
    ['a fork head', { headRepoId: 999_999 }, 'fork_head'],
    ['a deleted fork (head.repo null)', { headRepoId: null }, 'fork_head'],
    ['a closed pull request', { action: 'synchronize', state: 'closed' }, 'not_open'],
    ['the default branch as head', { headRef: 'main' }, 'default_branch_head'],
    ['no head ref', { headRef: null }, 'malformed'],
    ['no base ref', { baseRef: null }, 'malformed'],
    ['no number', { number: null }, 'malformed'],
    ['an unknown installation', { installationId: 'inst-nope' }, 'unknown_installation'],
    ['a repository with no row', { repoId: 424_242, headRepoId: 424_242 }, 'unknown_repo'],
    ...(['closed', 'edited', 'labeled', 'ready_for_review'] as const).map(
      (action): [string, Parameters<typeof prPayload>[1], string] => [
        `action ${action}`,
        { action },
        'ignored_action',
      ],
    ),
  ])('%s', async (_label, opts, outcome) => {
    const w = await seeded(`prl-skip-${outcome}-${String(Math.random()).slice(2, 7)}`);
    const body = prPayload(w, opts);
    await expect(githubPrHeadIndexService.onPullRequest(structuredClone(body))).resolves.toBe(
      outcome,
    );
    const { prHeads } = await handle('pull_request', body);
    expect(prHeads).toEqual([]);
  });

  it('a push to a branch with no pull request still answers ignored_ref and enqueues no index', async () => {
    const w = await seeded('prl-push');
    const { result, names } = await handle('push', {
      ref: 'refs/heads/feature-x',
      before: 'c'.repeat(40),
      after: DELIVERED_SHA,
      deleted: false,
      repository: { id: w.repoId, full_name: 'moooon/motir-core' },
      installation: { id: w.installationId },
    });
    expect(result).toEqual({ event: 'push', outcome: 'ignored_ref' });
    expect(names).not.toContain(PR_HEAD);
    expect(names).not.toContain('system.code-graph-index');
    expect(names).not.toContain('system.code-graph-refresh');
  });

  it('a throwing enqueue is logged and answered failed; the delivery’s answer is unchanged', async () => {
    const w = await seeded('prl-throw');
    const body = prPayload(w);
    const off = await (async () => {
      vi.spyOn(githubPrHeadIndexService, 'onPullRequest').mockResolvedValue('ignored_action');
      const r = await handle('pull_request', body);
      vi.mocked(githubPrHeadIndexService.onPullRequest).mockRestore();
      return r;
    })();
    vi.spyOn(indexEnqueue, 'enqueueCodeGraphPrHeadIndex').mockRejectedValue(
      new Error('queue down'),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(githubPrHeadIndexService.onPullRequest(structuredClone(body))).resolves.toBe(
      'failed',
    );
    expect(error).toHaveBeenCalledWith(
      '[githubPrHeadIndex] pull_request for moooon/motir-core indexed nothing:',
      'queue down',
    );
    const on = await handle('pull_request', body);
    expect(on.result).toEqual(off.result);
  });

  it('a non-Error throw is logged as text', async () => {
    const w = await seeded('prl-throw-text');
    vi.spyOn(indexEnqueue, 'enqueueCodeGraphPrHeadIndex').mockRejectedValue('gone');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(githubPrHeadIndexService.onPullRequest(prPayload(w))).resolves.toBe('failed');
    expect(error).toHaveBeenCalledWith(
      '[githubPrHeadIndex] pull_request for moooon/motir-core indexed nothing:',
      'gone',
    );
  });

  it('a body with no repository id or action answers without resolving', async () => {
    await expect(githubPrHeadIndexService.onPullRequest({})).resolves.toBe('ignored_action');
    await expect(
      githubPrHeadIndexService.onPullRequest({ action: 'opened', pull_request: {} }),
    ).resolves.toBe('fork_head');
  });
});

// ── a signed delivery, end to end through the real route and both jobs ───────

function sign(raw: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
}

async function post(body: Record<string, unknown>, deliveryId: string): Promise<Response> {
  const { POST } = await import('@/app/api/github/webhook/route');
  const raw = JSON.stringify(body);
  return POST(
    new NextRequest('http://localhost:3000/api/github/webhook', {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sign(raw),
      },
      body: raw,
    }),
  );
}

describe('a delivery POSTed to the webhook route hands the LIVE head off', () => {
  it.each(['opened', 'reopened', 'synchronize'])('%s', async (action) => {
    const w = await seeded(`prl-route-${action}`);
    await adminDb.githubRepo.updateMany({
      where: { owner: 'moooon', name: 'motir-core' },
      data: { indexedHeadSha: null },
    });

    const captured = captureJobEvents();
    let enqueued: { name: string; data?: unknown }[];
    try {
      const res = await post(prPayload(w, { action }), `prl-route-${action}`);
      expect(res.status).toBeLessThan(300);
      const deliveries = captured.events.filter((e) => e.name === 'system.github-webhook-delivery');
      expect(deliveries).toHaveLength(1);
      const handled = await new JobTestEngine({
        function: githubWebhookDelivery,
        events: [deliveries[0]!],
      }).execute();
      expect(handled.error).toBeUndefined();
      enqueued = captured.events.filter((e) => e.name === PR_HEAD);
    } finally {
      captured.restore();
    }
    expect(enqueued).toHaveLength(1);

    // The run: GitHub's live read answers the CURRENT head, not the delivered sha.
    vi.unstubAllGlobals();
    stubIndexHandoff();
    handoffWorld.pullRequest = livePullRequest({ repoId: w.repoId });
    const listing = vi.spyOn(githubProvider, 'listChangedFiles');
    const run = await new JobTestEngine({ function: codeGraphPrHeadIndex }).execute({
      events: [{ ...enqueued[0]!, name: PR_HEAD }],
    });
    expect(run.error).toBeUndefined();
    expect(listing).not.toHaveBeenCalled();
    expect(handoffWorld.handoffs).toHaveLength(1);
    expect(handoffWorld.handoffs[0]).toMatchObject({
      kind: 'first_index',
      isDefaultBranch: false,
      ref: 'feature-x',
      commitSha: HANDOFF_HEAD,
    });
    expect(handoffWorld.tarballRefs).toEqual([HANDOFF_HEAD]);
    expect(JSON.stringify(handoffWorld.handoffs)).not.toContain(DELIVERED_SHA);
  });
});

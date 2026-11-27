import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { JobQueueRun } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import * as forwardModule from '@/lib/jobs/codeGraphForward';
import { codeGraphForward } from '@/lib/jobs/definitions/codeGraphForward';
import { githubWebhookDelivery } from '@/lib/jobs/definitions/githubWebhookDelivery';
import { executeWithLedger, recordEngineTerminalFailure } from '@/lib/jobs/engine/ledger';
import { JobWorker } from '@/lib/jobs/engine/worker';
import * as jobDispatcher from '@/lib/jobs/engine/dispatcher';
import type { CodeGraphForwardData } from '@/lib/jobs/types';
import '@/lib/jobs/registry';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { openPullRequestReportService } from '@/lib/services/openPullRequestReportService';
import { previewLifecycleService } from '@/lib/services/previewLifecycleService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { JobTestEngine, captureJobEvents, type CapturedJobEvent } from '../helpers/jobs';

// THE STORY GATE FOR MOTIR-11870's motir-core half (MOTIR-12059).
//
// A signed GitHub delivery POSTed to the real `app/api/github/webhook/route.ts`, stored
// in the inbox, processed by the real `githubWebhookDelivery` job, whose handling
// enqueues the real `system.code-graph-forward` job, whose request leaves for motir-ai
// and is caught by a stubbed `fetch`. The one-time open-pull-request report runs the
// same way. Real Postgres throughout.
//
// The only doubles are at the edges: `fetch` (motir-ai's two routes and GitHub's REST
// API, including the single pull-request read a held open report makes before each
// re-send — MOTIR-12321), the App's installation-token mint (it needs a private key the test env does
// not carry), and the engine's dispatch, which `captureJobEvents` records so each
// enqueued event is run by its real job. No fixture builds a forward event: every one
// run here is the one the handling built.

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

const SECRET = 'test-webhook-secret';
const AI = 'https://ai.example.test';
const FORWARD = 'system.code-graph-forward';
const DELIVERY = 'system.github-webhook-delivery';
const INSTALLATION_ID = 'inst-fwd-gate';
const REPO_ID = 11870;
const OTHER_REPO_ID = 11871;
const UPDATED_AT = '2026-11-22T10:00:00Z';
const MERGED_AT = '2026-11-22T11:00:00Z';
const HEAD = 'b'.repeat(40);

/** The union's fields per motir-ai path — nothing else may leave motir-core. */
const ALLOWED_KEYS: Record<string, readonly string[]> = {
  '/v1/code-graph/pull-request-state': [
    'coreOrganizationId',
    'repoRef',
    'ref',
    'pullRequestNumber',
    'state',
    'mergedAt',
    'reportedAt',
  ],
  '/v1/code-graph/retire': ['coreOrganizationId', 'repoRef', 'ref'],
};

// ── the stubbed edges ─────────────────────────────────────────────────────────

type AiAnswer = { status: number; body?: unknown } | 'transport';

interface AiRequest {
  path: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

/** Every request this test sent to motir-ai, and the answers it is to get, in order. */
let aiRequests: AiRequest[];
let aiAnswers: AiAnswer[];
/** GitHub's open-pull-request listing, by `owner/name`, as pages. */
let githubOpenPulls: Record<string, unknown[][]>;
/**
 * What GitHub's single pull-request read answers now (MOTIR-12321): the
 * `pull_request` object of a delivery, open unless a case closes it.
 */
let githubLivePull: Record<string, unknown>;
/** Every single pull-request read, as `owner/name#number`. */
let githubPullReads: string[];

const settled = (outcome: string): AiAnswer => ({ status: 200, body: { ref: 'x', outcome } });
const problem = (code: string, status: number): AiAnswer => ({
  status,
  body: { type: `https://motir.co/errors/${code}`, title: code, status, code },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

async function routedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.origin === AI) {
    aiRequests.push({
      path: url.pathname,
      authorization: new Headers(init?.headers).get('authorization'),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    // Once the script runs out, motir-ai settles with its path's ordinary outcome.
    const answer =
      aiAnswers.shift() ??
      settled(url.pathname === '/v1/code-graph/retire' ? 'retired' : 'recorded');
    if (answer === 'transport') throw new TypeError('fetch failed');
    return json(answer.body, answer.status);
  }
  if (url.hostname === 'api.github.com') {
    const listing = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(url.pathname);
    if (listing && url.searchParams.get('state') === 'open') {
      const pages = githubOpenPulls[`${listing[1]}/${listing[2]}`];
      if (!pages) return json({ message: 'Not Found' }, 404);
      return json(pages[Number(url.searchParams.get('page')) - 1] ?? []);
    }
    const single = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(url.pathname);
    if (single) {
      githubPullReads.push(`${single[1]}/${single[2]}#${single[3]}`);
      return json(githubLivePull);
    }
    // Every other GitHub read the handling makes (the changed-path capture): empty.
    return json([]);
  }
  throw new Error(`unexpected request in the story gate: ${url.href}`);
}

// ── the world ─────────────────────────────────────────────────────────────────

let seq = 0;

/** A workspace holding the installation and ONE repository, `moooon/acme`. */
async function world(): Promise<{ workspaceId: string; organizationId: string }> {
  seq += 1;
  const user = await usersService.createUser({
    email: `fwd-gate-${seq}@example.com`,
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

async function freshWorld() {
  await truncateAuthTables();
  await truncateJobRuns();
  return world();
}

// ── deliveries ────────────────────────────────────────────────────────────────

function pullRequest(
  opts: {
    action?: string;
    number?: number;
    headRef?: string;
    headRepoId?: number | null;
    merged?: boolean;
    updatedAt?: string;
    installationId?: string;
    repoId?: number;
  } = {},
): Record<string, unknown> {
  const action = opts.action ?? 'opened';
  const merged = opts.merged ?? false;
  return {
    action,
    installation: { id: opts.installationId ?? INSTALLATION_ID },
    repository: { id: opts.repoId ?? REPO_ID, full_name: 'moooon/acme' },
    pull_request: {
      number: opts.number ?? 7,
      state: action === 'closed' ? 'closed' : 'open',
      merged,
      ...(merged ? { merged_at: MERGED_AT } : {}),
      updated_at: opts.updatedAt ?? UPDATED_AT,
      title: 'A change',
      draft: false,
      head: {
        ref: opts.headRef ?? 'feature-x',
        sha: HEAD,
        repo: opts.headRepoId === null ? null : { id: opts.headRepoId ?? REPO_ID },
      },
      base: { ref: 'main', repo: { id: opts.repoId ?? REPO_ID } },
      user: { id: 4242, login: 'someone' },
    },
  };
}

function push(
  opts: { ref?: string; deleted?: boolean; installationId?: string; repoId?: number } = {},
) {
  return {
    ref: opts.ref ?? 'refs/heads/feature-x',
    before: 'c'.repeat(40),
    after: opts.deleted ? '0'.repeat(40) : HEAD,
    deleted: opts.deleted ?? false,
    repository: { id: opts.repoId ?? REPO_ID, full_name: 'moooon/acme' },
    installation: { id: opts.installationId ?? INSTALLATION_ID },
  };
}

type Delivery = ['pull_request' | 'push', Record<string, unknown>];

function sign(raw: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
}

/** POST one signed delivery to the real webhook route. */
async function post([event, payload]: Delivery, deliveryId: string): Promise<Response> {
  const { POST } = await import('@/app/api/github/webhook/route');
  const raw = JSON.stringify(payload);
  return POST(
    new NextRequest('http://localhost:3000/api/github/webhook', {
      method: 'POST',
      headers: {
        'x-github-event': event,
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sign(raw),
      },
      body: raw,
    }),
  );
}

/** Ids a fresh world mints differently every time, and the clock, read out. */
function normalized(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value ?? null)
      .replace(/c[a-z0-9]{24}/g, '<id>')
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<now>'),
  ) as unknown;
}

interface Delivered {
  status: number;
  answer: unknown;
  inbox: { state: string; result: unknown; lastError: string | null };
  /** The forwards the handling enqueued, as it built them. */
  forwards: CapturedJobEvent[];
  /** Everything else the delivery enqueued, normalized. */
  others: unknown;
  headSha: string | null;
  preview: unknown[][];
}

/**
 * One delivery, end to end up to the forward: the route, the inbox, the real
 * delivery job. `forward: 'off'` stubs `enqueueCodeGraphForward` to a no-op, which is
 * what `main` does for this delivery.
 */
async function deliver(
  delivery: Delivery,
  opts: { forward?: 'on' | 'off'; deliveryId?: string } = {},
): Promise<Delivered> {
  const deliveryId = opts.deliveryId ?? `gate-${delivery[0]}-${seq}`;
  const captured = captureJobEvents();
  const preview = vi.spyOn(previewLifecycleService, 'onPullRequest');
  const enqueue =
    opts.forward === 'off'
      ? vi.spyOn(forwardModule, 'enqueueCodeGraphForward').mockResolvedValue(undefined)
      : null;
  try {
    const res = await post(delivery, deliveryId);
    const answer = (await res.json()) as unknown;
    const runs = captured.events.filter((e) => e.name === DELIVERY);
    expect(runs).toHaveLength(1);
    const outcome = await new JobTestEngine({
      function: githubWebhookDelivery,
      events: [runs[0]!],
    }).execute();
    expect(outcome.error).toBeUndefined();
    const inbox = await adminDb.githubWebhookDelivery.findUniqueOrThrow({
      where: { deliveryId },
      select: { state: true, result: true, lastError: true },
    });
    const repo = await adminDb.githubRepo.findFirst({
      where: { owner: 'moooon', name: 'acme' },
      select: { defaultBranchHeadSha: true },
    });
    return {
      status: res.status,
      answer,
      inbox,
      forwards: captured.events.filter((e) => e.name === FORWARD),
      others: normalized(captured.events.filter((e) => e.name !== FORWARD && e.name !== DELIVERY)),
      headSha: repo?.defaultBranchHeadSha ?? null,
      preview: preview.mock.calls as unknown[][],
    };
  } finally {
    captured.restore();
    preview.mockRestore();
    enqueue?.mockRestore();
  }
}

/** The delivery with forwarding stubbed out, then the same delivery for real, each in a fresh world. */
async function compareWithMain(delivery: Delivery) {
  await freshWorld();
  const main = await deliver(delivery, { forward: 'off', deliveryId: 'gate-compare' });
  const w = await freshWorld();
  const now = await deliver(delivery, { deliveryId: 'gate-compare' });
  expect(now.status).toBe(main.status);
  expect(now.answer).toEqual(main.answer);
  expect(now.inbox).toEqual(main.inbox);
  expect(now.others).toEqual(main.others);
  expect(now.headSha).toEqual(main.headSha);
  return { world: w, main, now };
}

/** Run one enqueued forward through the real job, re-entered while it defers. */
async function runForward(event: CapturedJobEvent) {
  const outcome = await new JobTestEngine({
    function: codeGraphForward,
    events: [event],
  }).execute();
  const runs = await adminDb.jobRun.findMany({ where: { functionId: FORWARD } });
  return { outcome, runs };
}

/** A real worker running each claimed run through the ledger, as `scripts/worker.ts` does. */
function worker(): JobWorker {
  const eventOf = async (run: JobQueueRun) =>
    run.eventId ? await adminDb.jobEvent.findUnique({ where: { id: run.eventId } }) : null;
  return new JobWorker({
    workerId: 'code-graph-forward-gate',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    execute: async (run) => {
      await executeWithLedger(run, (await eventOf(run))?.data ?? {});
    },
    onTerminalFailure: async (run, error) => {
      await recordEngineTerminalFailure(run, error, (await eventOf(run))?.data ?? {});
    },
  });
}

/** Every public table's row count. */
async function rowCounts(): Promise<Record<string, number>> {
  const rows = await adminDb.$queryRawUnsafe<{ t: string; n: number }[]>(`
    SELECT table_name AS t,
           (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text::int AS n
      FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
  return Object.fromEntries(rows.map((r) => [r.t, r.n]));
}

/** Make the forward row `id` due and run one claim of it; the row after. */
async function onePass(w: JobWorker, id: string): Promise<JobQueueRun> {
  await adminDb.jobQueueRun.update({
    where: { id },
    data: { runAt: new Date(Date.now() - 1_000) },
  });
  expect(await w.tick()).toBe(1);
  await w.settled();
  return adminDb.jobQueueRun.findUniqueOrThrow({ where: { id } });
}

/** Enqueue the handling's own forward event for real, and park its row. */
async function enqueueForReal(event: CapturedJobEvent): Promise<string> {
  const before = await adminDb.jobQueueRun.findMany({
    where: { jobId: FORWARD },
    select: { id: true },
  });
  await forwardModule.enqueueCodeGraphForward(event.data as CodeGraphForwardData);
  const row = await adminDb.jobQueueRun.findFirstOrThrow({
    where: { jobId: FORWARD, id: { notIn: before.map((r) => r.id) } },
  });
  await adminDb.jobQueueRun.update({
    where: { id: row.id },
    data: { runAt: new Date(Date.now() + 3_600_000) },
  });
  return row.id;
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  _resetInstallationTokenCache();
  vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);
  vi.stubEnv('MOTIR_AI_URL', AI);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  aiRequests = [];
  aiAnswers = [];
  githubOpenPulls = {};
  githubLivePull = pullRequest({ action: 'opened' })['pull_request'] as Record<string, unknown>;
  githubPullReads = [];
  vi.stubGlobal('fetch', vi.fn(routedFetch));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  // THE PAYLOAD GUARD, over every request every case sent: no field beyond the union.
  for (const request of aiRequests) {
    expect(Object.keys(ALLOWED_KEYS), request.path).toContain(request.path);
    for (const key of Object.keys(request.body)) {
      expect(ALLOWED_KEYS[request.path], `${request.path} carried ${key}`).toContain(key);
    }
    expect(request.authorization).toBe('Bearer svc-token');
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── the forwarded deliveries ──────────────────────────────────────────────────

describe('a delivery on a held repository reaches motir-ai as exactly one request', () => {
  it.each<[string, Delivery, Record<string, unknown>]>([
    ['opened', ['pull_request', pullRequest({ action: 'opened' })], { state: 'open' }],
    [
      'reopened',
      ['pull_request', pullRequest({ action: 'reopened', updatedAt: '2026-11-22T12:30:00Z' })],
      { state: 'open', reportedAt: '2026-11-22T12:30:00Z' },
    ],
    [
      'closed, not merged',
      ['pull_request', pullRequest({ action: 'closed' })],
      { state: 'closed' },
    ],
    [
      'closed and merged',
      ['pull_request', pullRequest({ action: 'closed', merged: true })],
      { state: 'merged', mergedAt: MERGED_AT },
    ],
  ])('pull_request %s → one pull-request-state request', async (_label, delivery, expected) => {
    const { world: w, now } = await compareWithMain(delivery);
    expect(now.forwards).toHaveLength(1);
    const { outcome, runs } = await runForward(now.forwards[0]!);
    expect(outcome.error).toBeUndefined();
    expect(aiRequests).toEqual([
      {
        path: '/v1/code-graph/pull-request-state',
        authorization: 'Bearer svc-token',
        body: {
          coreOrganizationId: w.organizationId,
          repoRef: 'moooon/acme',
          ref: 'feature-x',
          pullRequestNumber: 7,
          reportedAt: UPDATED_AT,
          ...expected,
        },
      },
    ]);
    if (!('mergedAt' in expected)) expect(aiRequests[0]!.body).not.toHaveProperty('mergedAt');
    expect(runs.map((r) => r.status)).toEqual(['succeeded']);
  });

  it('a branch-deleting push → one retire request for the branch; the push answer stays ignored_ref', async () => {
    const { world: w, now } = await compareWithMain([
      'push',
      push({ ref: 'refs/heads/feature-x', deleted: true }),
    ]);
    expect(now.inbox.result).toEqual({ event: 'push', outcome: 'ignored_ref' });
    expect(now.forwards).toHaveLength(1);
    await runForward(now.forwards[0]!);
    expect(aiRequests.map((r) => [r.path, r.body])).toEqual([
      [
        '/v1/code-graph/retire',
        { coreOrganizationId: w.organizationId, repoRef: 'moooon/acme', ref: 'feature-x' },
      ],
    ]);
  });
});

// ── nothing forwarded ─────────────────────────────────────────────────────────

describe('forwards nothing', () => {
  it.each<[string, Delivery]>([
    ['a fork head, opened', ['pull_request', pullRequest({ headRepoId: OTHER_REPO_ID })]],
    [
      'a fork head, closed',
      ['pull_request', pullRequest({ action: 'closed', headRepoId: OTHER_REPO_ID })],
    ],
    ['a deleted fork', ['pull_request', pullRequest({ headRepoId: null })]],
    ['a deleted tag', ['push', push({ ref: 'refs/tags/v1', deleted: true })]],
    ['action synchronize', ['pull_request', pullRequest({ action: 'synchronize' })]],
    ['action edited', ['pull_request', pullRequest({ action: 'edited' })]],
    ['action labeled', ['pull_request', pullRequest({ action: 'labeled' })]],
    ['an unknown installation', ['pull_request', pullRequest({ installationId: 'inst-nobody' })]],
    [
      'an installed but unconnected repository',
      ['pull_request', pullRequest({ repoId: OTHER_REPO_ID, headRepoId: OTHER_REPO_ID })],
    ],
    [
      'a branch delete on an unconnected repository',
      ['push', push({ deleted: true, repoId: OTHER_REPO_ID })],
    ],
  ])('%s: no forward event and no request to motir-ai', async (_label, delivery) => {
    const { now } = await compareWithMain(delivery);
    expect(now.forwards).toEqual([]);
    expect(aiRequests).toEqual([]);
  });
});

// ── motir-ai's answers ────────────────────────────────────────────────────────

/** The forward event a real delivery of `delivery` builds, in a fresh world. */
async function forwardOf(delivery: Delivery): Promise<CapturedJobEvent> {
  await freshWorld();
  const { forwards } = await deliver(delivery);
  expect(forwards).toHaveLength(1);
  return forwards[0]!;
}

const OPENED: Delivery = ['pull_request', pullRequest({ action: 'opened' })];
const DELETED: Delivery = ['push', push({ deleted: true })];
const CLOSED: Delivery = ['pull_request', pullRequest({ action: 'closed' })];

describe('a settled answer ends the forward after one call, succeeded', () => {
  it.each<[string, Delivery, AiAnswer]>([
    ['recorded', OPENED, settled('recorded')],
    ['stale', OPENED, settled('stale')],
    ['unknown_ref (closed)', CLOSED, settled('unknown_ref')],
    ['default_branch (state)', OPENED, settled('default_branch')],
    ['retired', DELETED, settled('retired')],
    ['already_done', DELETED, settled('already_done')],
    ['default_branch (retire)', DELETED, settled('default_branch')],
    ['a 409', OPENED, problem('conflict', 409)],
    ['a 400', OPENED, problem('validation_error', 400)],
    ['a 404', DELETED, problem('not_found', 404)],
    ['a 422', OPENED, problem('unprocessable', 422)],
  ])('%s', async (_label, delivery, answer) => {
    const event = await forwardOf(delivery);
    aiAnswers = [answer];
    const { outcome, runs } = await runForward(event);
    expect(outcome.error).toBeUndefined();
    expect(aiRequests).toHaveLength(1);
    expect(runs.map((r) => r.status)).toEqual(['succeeded']);
  });

  // MOTIR-12299: the open report lands seconds before its branch's head publishes, so
  // an `unknown_ref` on it is the branch not indexed YET — re-sent, never settled.
  it('unknown_ref on an opened report is re-sent with the identical body until recorded', async () => {
    const event = await forwardOf(OPENED);
    aiAnswers = [settled('unknown_ref'), settled('unknown_ref'), settled('recorded')];
    const { outcome, runs } = await runForward(event);
    expect(outcome.error).toBeUndefined();
    expect(aiRequests).toHaveLength(3);
    expect(new Set(aiRequests.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect(aiRequests[0]!.body).toMatchObject({ state: 'open' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'succeeded', output: { outcome: 'recorded' } });
    // MOTIR-12321: each RE-SEND first read the pull request live; the first send did not.
    expect(githubPullReads).toEqual(['moooon/acme#7', 'moooon/acme#7']);
  });

  // MOTIR-12321: closed before its head publishes, the close report settles on its
  // first `unknown_ref`; the held open report then reads the pull request live and
  // reports it merged, so no open state is ever recorded for a closed pull request.
  it('an opened report held while the pull request merges is re-sent as merged, never as open', async () => {
    const opened = await forwardOf(OPENED);
    const mergedDelivery = pullRequest({ action: 'closed', merged: true, updatedAt: MERGED_AT });
    const closed = await deliver(['pull_request', mergedDelivery], {
      deliveryId: 'gate-merged-while-held',
    });
    const openId = await enqueueForReal(opened);
    const closeId = await enqueueForReal(closed.forwards[0]!);
    aiAnswers = [settled('unknown_ref'), settled('unknown_ref'), settled('recorded')];
    const w = worker();
    expect((await onePass(w, openId)).state).toBe('pending');
    expect((await onePass(w, closeId)).state).toBe('succeeded');
    // The head publishes; GitHub now has the pull request merged.
    githubLivePull = mergedDelivery['pull_request'] as Record<string, unknown>;
    expect((await onePass(w, openId)).state).toBe('succeeded');
    expect(aiRequests.map((r) => [r.body['state'], r.body['reportedAt']])).toEqual([
      ['open', UPDATED_AT],
      ['merged', MERGED_AT],
      ['merged', MERGED_AT],
    ]);
    expect(aiRequests[2]!.body).toMatchObject({ mergedAt: MERGED_AT });
    expect(githubPullReads).toEqual(['moooon/acme#7']);
    const runs = await adminDb.jobRun.findMany({
      where: { functionId: FORWARD, status: 'succeeded' },
    });
    expect(runs.map((r) => r.output)).toContainEqual({
      kind: 'pull_request_state',
      outcome: 'recorded',
      reportedAs: 'merged',
    });
  });

  it('a 401 ends the forward as a failed run on the real worker', async () => {
    const event = await forwardOf(DELETED);
    const id = await enqueueForReal(event);
    aiAnswers = Array.from({ length: 10 }, () => problem('service_unauthorized', 401));
    const w = worker();
    let row = await onePass(w, id);
    for (let pass = 0; pass < 10 && row.state === 'pending'; pass += 1) row = await onePass(w, id);
    expect(row.state).toBe('failed');
    const runs = await adminDb.jobRun.findMany({ where: { functionId: FORWARD } });
    expect(runs.some((r) => r.status === 'succeeded')).toBe(false);
  });
});

describe('an unavailable motir-ai defers the forward until a settled answer', () => {
  const OUTAGE: AiAnswer[] = [
    problem('codegraph_unavailable', 503),
    problem('internal_error', 500),
    problem('rate_limited', 429),
    'transport',
    settled('recorded'),
  ];

  it('503, 500, 429 and a transport failure re-enter the job, which sends the identical body and ends on recorded', async () => {
    const event = await forwardOf(OPENED);
    aiAnswers = [...OUTAGE];
    const { outcome, runs } = await runForward(event);
    expect(outcome.error).toBeUndefined();
    expect(aiRequests).toHaveLength(5);
    expect(new Set(aiRequests.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'succeeded', output: { outcome: 'recorded' } });
  });

  it('on the real worker each deferred pass refunds its attempt', async () => {
    const event = await forwardOf(OPENED);
    const id = await enqueueForReal(event);
    aiAnswers = [...OUTAGE];
    const w = worker();
    for (let pass = 1; pass <= 4; pass += 1) {
      const row = await onePass(w, id);
      expect(row.state, `pass ${pass}`).toBe('pending');
      expect(row.attempts, `pass ${pass}`).toBe(0);
    }
    expect((await onePass(w, id)).state).toBe('succeeded');
    expect(new Set(aiRequests.map((r) => JSON.stringify(r.body))).size).toBe(1);
    const runs = await adminDb.jobRun.findMany({ where: { functionId: FORWARD } });
    expect(runs.some((r) => r.status === 'failed')).toBe(false);
  });

  it('two closed reports retried out of order each keep their own reportedAt', async () => {
    await freshWorld();
    const older = await deliver(
      ['pull_request', pullRequest({ action: 'closed', updatedAt: '2026-11-22T10:00:00Z' })],
      { deliveryId: 'gate-older' },
    );
    const newer = await deliver(
      [
        'pull_request',
        pullRequest({ action: 'closed', merged: true, updatedAt: '2026-11-22T10:05:00Z' }),
      ],
      { deliveryId: 'gate-newer' },
    );
    const olderId = await enqueueForReal(older.forwards[0]!);
    const newerId = await enqueueForReal(newer.forwards[0]!);
    aiAnswers = ['transport', settled('recorded'), settled('stale')];
    const w = worker();
    expect((await onePass(w, olderId)).state).toBe('pending');
    expect((await onePass(w, newerId)).state).toBe('succeeded');
    expect((await onePass(w, olderId)).state).toBe('succeeded');
    expect(aiRequests.map((r) => [r.body['state'], r.body['reportedAt']])).toEqual([
      ['closed', '2026-11-22T10:00:00Z'],
      ['merged', '2026-11-22T10:05:00Z'],
      ['closed', '2026-11-22T10:00:00Z'],
    ]);
  });
});

// ── the delivery is never the forward's to fail ───────────────────────────────

describe('the ack and the delivery job are unchanged whatever the forward does', () => {
  it('a queue write that fails for the forward: the route answers as on main and the inbox row ends processed', async () => {
    await freshWorld();
    const main = await deliver(OPENED, { forward: 'off', deliveryId: 'gate-q' });
    await freshWorld();
    // Every dispatch is recorded, and the forward's alone is refused — the queue write
    // `sendSystemEvent` swallows.
    const captured = captureJobEvents();
    const recorded = captured.events;
    vi.mocked(jobDispatcher.dispatchEventToEngine).mockImplementation(async (name, data) => {
      if (name === FORWARD) throw new Error('queue write refused');
      recorded.push({ name, data });
      return { eventId: null, enqueued: [], alreadyEnqueued: [], skipped: [] } as never;
    });
    const res = await post(OPENED, 'gate-q');
    expect(res.status).toBe(main.status);
    expect(await res.json()).toEqual(main.answer);
    const run = captured.events.find((e) => e.name === DELIVERY)!;
    expect(
      (await new JobTestEngine({ function: githubWebhookDelivery, events: [run] }).execute()).error,
    ).toBeUndefined();
    captured.restore();
    const inbox = await adminDb.githubWebhookDelivery.findUniqueOrThrow({
      where: { deliveryId: 'gate-q' },
      select: { state: true, result: true, lastError: true },
    });
    expect(inbox).toEqual(main.inbox);
    expect(inbox.state).toBe('processed');
  });

  it('an enqueue that throws: the inbox row ends processed with main’s result', async () => {
    await freshWorld();
    const main = await deliver(OPENED, { forward: 'off', deliveryId: 'gate-t' });
    await freshWorld();
    vi.spyOn(forwardModule, 'enqueueCodeGraphForward').mockRejectedValue(new Error('door broke'));
    const now = await deliver(OPENED, { deliveryId: 'gate-t' });
    expect(now.inbox).toEqual(main.inbox);
    expect(now.inbox.state).toBe('processed');
    expect(now.answer).toEqual(main.answer);
  });

  it('motir-ai down for the whole run: the delivery is processed, and only the forward is left retrying', async () => {
    await freshWorld();
    const main = await deliver(OPENED, { forward: 'off', deliveryId: 'gate-down' });
    await freshWorld();
    const now = await deliver(OPENED, { deliveryId: 'gate-down' });
    expect(now.inbox).toEqual(main.inbox);
    const id = await enqueueForReal(now.forwards[0]!);
    aiAnswers = Array.from({ length: 5 }, () => problem('codegraph_unavailable', 503));
    const w = worker();
    for (let pass = 0; pass < 3; pass += 1) {
      expect(await onePass(w, id)).toMatchObject({ state: 'pending', attempts: 0 });
    }
    expect(
      await adminDb.githubWebhookDelivery.findUniqueOrThrow({
        where: { deliveryId: 'gate-down' },
        select: { state: true },
      }),
    ).toEqual({ state: 'processed' });
  });
});

describe('existing handling is unchanged', () => {
  it('a default-branch push still answers refresh_enqueued, enqueues the same refresh and base-moved, stamps the head, and forwards nothing', async () => {
    const { main, now } = await compareWithMain(['push', push({ ref: 'refs/heads/main' })]);
    expect(now.inbox.result).toEqual({ event: 'push', outcome: 'refresh_enqueued' });
    const names = (now.others as CapturedJobEvent[]).map((e) => e.name);
    expect(names).toContain('system.code-graph-refresh');
    expect(names).toContain('pull-request/base-moved');
    expect(now.others).toEqual(main.others);
    expect(now.headSha).toBe(HEAD);
    expect(now.forwards).toEqual([]);
  });

  it.each<[string, Delivery]>([
    ['opened', ['pull_request', pullRequest({ action: 'opened' })]],
    ['reopened', ['pull_request', pullRequest({ action: 'reopened' })]],
    ['closed', ['pull_request', pullRequest({ action: 'closed' })]],
    ['merged', ['pull_request', pullRequest({ action: 'closed', merged: true })]],
    ['a fork', ['pull_request', pullRequest({ headRepoId: OTHER_REPO_ID })]],
  ])(
    'pull_request %s still runs the preview lifecycle once with the body, and the status sync answers as on main',
    async (_label, delivery) => {
      const { main, now } = await compareWithMain(delivery);
      expect(now.preview).toEqual([[delivery[1]]]);
      expect(main.preview).toEqual([[delivery[1]]]);
      // The stored result is `handleEvent`'s answer, which is `handlePullRequest`'s.
      expect(now.inbox.result).toEqual(main.inbox.result);
    },
  );
});

// ── the one-time report ───────────────────────────────────────────────────────

function openPull(number: number, headRepoId: number | null) {
  return {
    number,
    state: 'open',
    updated_at: `2026-11-${String(10 + (number % 10)).padStart(2, '0')}T08:00:00Z`,
    head: { ref: `branch-${number}`, repo: headRepoId === null ? null : { id: headRepoId } },
    base: { ref: 'main' },
  };
}

describe('the one-time open-pull-request report', () => {
  /** Two connected repositories: acme with three pages (100, 100, 3) holding two fork heads, and acme-two with two. */
  async function twoRepositories() {
    const w = await freshWorld();
    const install = await adminDb.githubInstallation.findFirstOrThrow({
      where: { installationId: INSTALLATION_ID },
    });
    await adminDb.githubRepo.create({
      data: {
        installationId: install.id,
        workspaceId: w.workspaceId,
        organizationId: w.organizationId,
        repoId: '11872',
        owner: 'moooon',
        name: 'acme-two',
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    const pages = [
      Array.from({ length: 100 }, (_, i) => openPull(i + 1, i === 49 ? OTHER_REPO_ID : REPO_ID)),
      Array.from({ length: 100 }, (_, i) => openPull(i + 101, REPO_ID)),
      [openPull(201, REPO_ID), openPull(202, null), openPull(203, REPO_ID)],
    ];
    githubOpenPulls['moooon/acme'] = pages;
    githubOpenPulls['moooon/acme-two'] = [[openPull(1, 11872), openPull(2, 11872)]];
    return { w, pages };
  }

  /** Run the report with its enqueues captured, then each forward through the real job. */
  async function report() {
    const captured = captureJobEvents();
    const summary = await openPullRequestReportService.reportOpenPullRequests({ dryRun: false });
    captured.restore();
    const forwards = captured.events.filter((e) => e.name === FORWARD);
    const start = aiRequests.length;
    for (const event of forwards) {
      expect((await runForward(event)).outcome.error).toBeUndefined();
    }
    return { summary, forwards, requests: aiRequests.slice(start) };
  }

  it('reports every open same-repository pull request once, as open, with the listed updated_at; never a fork', async () => {
    const { w, pages } = await twoRepositories();
    const { summary, requests } = await report();

    const expected = [
      ...pages
        .flat()
        .filter((p) => p.head.repo?.id === REPO_ID)
        .map((p) => ['moooon/acme', p.number, p.head.ref, p.updated_at]),
      ['moooon/acme-two', 1, 'branch-1', openPull(1, 0).updated_at],
      ['moooon/acme-two', 2, 'branch-2', openPull(2, 0).updated_at],
    ];
    expect(requests).toHaveLength(203);
    expect(
      requests.map((r) => [
        r.body['repoRef'],
        r.body['pullRequestNumber'],
        r.body['ref'],
        r.body['reportedAt'],
      ]),
    ).toEqual(expect.arrayContaining(expected));
    for (const r of requests) {
      expect(r.path).toBe('/v1/code-graph/pull-request-state');
      expect(r.body).toMatchObject({ coreOrganizationId: w.organizationId, state: 'open' });
      expect(r.body).not.toHaveProperty('mergedAt');
    }
    const acme = summary.repos.find((r) => r.repoRef === 'moooon/acme')!;
    expect(acme).toMatchObject({ pages: 3, scanned: 203, forwarded: 201, skippedForks: 2 });
    expect(summary.totals).toMatchObject({ repos: 2, failed: 0, forwarded: 203, skippedForks: 2 });
  });

  it('a second run sends the identical set of requests and writes no row of its own', async () => {
    await twoRepositories();
    const first = await report();
    const before = await rowCounts();
    const captured = captureJobEvents();
    await openPullRequestReportService.reportOpenPullRequests({ dryRun: false });
    captured.restore();
    expect(await rowCounts()).toEqual(before);
    expect(normalized(captured.events.filter((e) => e.name === FORWARD))).toEqual(
      normalized(first.forwards),
    );
  });
});

import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import {
  GITHUB_WEBHOOK_HANDLED_EVENTS,
  githubWebhookService,
} from '@/lib/services/githubWebhookService';
import {
  GITHUB_WEBHOOK_INBOX_FAILED_RETENTION_MS,
  GITHUB_WEBHOOK_INBOX_PROCESSED_RETENTION_MS,
  GITHUB_WEBHOOK_INBOX_STALE_MS,
  githubWebhookInboxService,
} from '@/lib/services/githubWebhookInboxService';
import {
  applyCiStatusFeedback,
  type CiFeedbackContextResolution,
} from '@/lib/services/changeRequestCiFeedback';
import { promoteIfCiAlreadyGreen } from '@/lib/services/ciPromotion';
import { refreshFeedbackComments } from '@/lib/services/ciFeedbackComments';
import { changeRequestChecksUrl } from '@/lib/git/checksUrl';
import {
  githubWebhookDelivery,
  githubWebhookInboxSweep,
} from '@/lib/jobs/definitions/githubWebhookDelivery';
import { jobDefinitions } from '@/lib/jobs/registry';
import { defineJob } from '@/lib/jobs/defineJob';
import { executeWithLedger } from '@/lib/jobs/engine/ledger';
import { JobWorker } from '@/lib/jobs/engine/worker';
import type { ReportedCheckRun } from '@/lib/github/checkRuns';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { JobTestEngine, captureJobEvents } from '../helpers/jobs';
import { linkPrByIdentifier } from '../helpers/prLink';

// Bug MOTIR-10425 — GITHUB GAVE UP ON CI WEBHOOK DELIVERIES.
//
// GitHub waits ten seconds for a delivery's response and never redelivers one it
// gave up on. The route used to run the whole CI-feedback consumer before it
// answered, behind a three-slot in-process gate, so at the end of a workflow — the
// last job's `check_run completed` and the suite's `check_suite completed` landing
// together with every other suite's — a delivery waited past ten seconds for a slot
// and was lost. Its roll-up row stayed `pending`, its card stayed Implemented, and
// its comment read "87 of 88" until the reconcile tick re-read the host.
//
// What this suite pins, against real Postgres and the real webhook service:
//
//   1. the route answers a verified delivery at once, whatever is queued behind
//      the gate, and stores nothing for a bad signature;
//   2. the delivery is stored before the answer and processed by a job, and a
//      second processing of it changes nothing;
//   3. a processing that throws is recorded `failed` and retried;
//   4. the end-of-workflow burst ends with the roll-up terminal and the card in
//      review, without the reconcile tick;
//   5. when the reconcile tick settles a row or promotes a card, the comment is
//      re-rendered from the recorded set;
//   6. on the REAL worker, a burst of CI deliveries waiting on the gate leaves the
//      pool free for an unrelated job, and still ends with every delivery processed
//      and the roll-up terminal (Bug MOTIR-10457);
//   7. a drain that releases deliveries parked on the gate never processes them in
//      the draining process: their inbox rows stay `received` and their queue rows
//      as the release wrote them, and the next worker processes each once (Bug
//      MOTIR-10462).

const SECRET = 'test-webhook-secret';
const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-webhook-inbox';
const REPO_PROVIDER_ID = '10425';
const SHA = '10425abc';
const CI_SUITE = '104250001';

const envelope = {
  installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
  repository: { id: Number(REPO_PROVIDER_ID) },
};

function sign(rawBody: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
}

async function importRoute() {
  return (await import('@/app/api/github/webhook/route')).POST;
}

/** POST one delivery to the real route, signed unless `signature` overrides it. */
async function postDelivery(
  event: string,
  payload: unknown,
  opts: { deliveryId?: string | null; signature?: string } = {},
): Promise<Response> {
  const POST = await importRoute();
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'x-github-event': event,
    'x-hub-signature-256': opts.signature ?? sign(raw),
  };
  const deliveryId = opts.deliveryId === undefined ? randomUUID() : opts.deliveryId;
  if (deliveryId !== null) headers['x-github-delivery'] = deliveryId;
  return POST(
    new NextRequest('http://localhost:3000/api/github/webhook', {
      method: 'POST',
      headers,
      body: raw,
    }),
  );
}

function checkRunPayload(name: string, status: 'in_progress' | 'completed', conclusion?: string) {
  return {
    action: status === 'completed' ? 'completed' : 'created',
    ...envelope,
    check_run: {
      head_sha: SHA,
      status,
      conclusion: conclusion ?? null,
      name,
      check_suite: { id: Number(CI_SUITE), head_branch: null },
      pull_requests: [{ number: 7 }],
    },
  };
}

function checkSuitePayload(status: 'in_progress' | 'completed', conclusion?: string) {
  return {
    action: status === 'completed' ? 'completed' : 'requested',
    ...envelope,
    check_suite: {
      id: Number(CI_SUITE),
      head_sha: SHA,
      head_branch: null,
      status,
      conclusion: conclusion ?? null,
      app: { slug: 'github-actions' },
      pull_requests: [{ number: 7 }],
    },
  };
}

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

/** A card at Implemented with pull request #7 linked and open. */
async function cardWithPr(s: Awaited<ReturnType<typeof makeScenario>>) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'A change' },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  const headRef = `subtask/${item.identifier}-work`;
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'moooon',
    name: 'acme',
    number: 7,
    headRef,
    title: `A change (${headRef})`,
  });
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    ...envelope,
    pull_request: {
      number: 7,
      state: 'open',
      merged: false,
      title: `A change (${headRef})`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
  return item;
}

async function statusOf(workItemId: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } })).status;
}

async function commentsOn(workItemId: string): Promise<string[]> {
  const rows = await adminDb.comment.findMany({ where: { workItemId } });
  return rows.map((row) => row.bodyMd);
}

async function checkRows() {
  return adminDb.githubCheckRun.findMany({
    orderBy: { checkName: 'asc' },
    select: { checkName: true, conclusion: true, suiteAggregate: true },
  });
}

/** Store one delivery straight into the inbox (no route) and answer its ref. */
async function store(event: string, payload: unknown) {
  const deliveryId = randomUUID();
  const receipt = await githubWebhookInboxService.receive({ event, payload, deliveryId });
  expect(receipt).toEqual({ kind: 'accepted', deliveryId });
  return { deliveryId, generation: 0 };
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  _resetInstallationTokenCache();
  vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the handled-event list', () => {
  it('names exactly the cases of handleEvent’s switch', () => {
    // A case added to the switch and not to the list would be IGNORED by the route —
    // answered 200 and never processed — so the two are held equal from the source.
    const source = readFileSync('lib/services/githubWebhookService.ts', 'utf8');
    const start = source.indexOf('switch (eventType) {');
    const end = source.indexOf('default:', start);
    expect(start).toBeGreaterThan(-1);
    const cases = [...source.slice(start, end).matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]);
    expect(new Set(cases)).toEqual(GITHUB_WEBHOOK_HANDLED_EVENTS);
  });

  it('registers both jobs, the delivery job on its own event with the idempotent budget', () => {
    expect(jobDefinitions).toContain(githubWebhookDelivery);
    expect(jobDefinitions).toContain(githubWebhookInboxSweep);
    expect(githubWebhookDelivery).toMatchObject({
      trigger: 'system.github-webhook-delivery',
      retryPolicy: 'idempotent',
      maxAttempts: 5,
    });
    expect(githubWebhookInboxSweep).toMatchObject({ cron: '*/5 * * * *', catchUp: 'latest' });
  });
});

describe('the checks link a re-render builds without a delivery', () => {
  it('points at a pull request’s Checks tab and a merge request’s Pipelines tab', () => {
    const repo = { owner: 'moooon', name: 'acme' };
    expect(changeRequestChecksUrl('github', repo, 7)).toBe(
      'https://github.com/moooon/acme/pull/7/checks',
    );
    vi.stubEnv('GITLAB_BASE_URL', 'https://gitlab.example.com/');
    expect(changeRequestChecksUrl('gitlab', repo, 7)).toBe(
      'https://gitlab.example.com/moooon/acme/-/merge_requests/7/pipelines',
    );
  });
});

describe('POST /api/github/webhook — ack first', () => {
  it('answers 202 and stores the delivery without running a handler', async () => {
    const handleEvent = vi.spyOn(githubWebhookService, 'handleEvent');
    const deliveryId = randomUUID();
    const res = await postDelivery('check_run', checkRunPayload('TypeScript', 'in_progress'), {
      deliveryId,
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, receipt: 'accepted', deliveryId });
    expect(handleEvent).not.toHaveBeenCalled();
    const row = await githubWebhookInboxService.findDelivery(deliveryId);
    expect(row).toMatchObject({ event: 'check_run', state: 'received', attempts: 0 });
    // …and its processing is enqueued, keyed on the delivery and its generation.
    const queued = await adminDb.jobEvent.findMany({
      where: { name: 'system.github-webhook-delivery' },
    });
    expect(queued.map((e) => e.idempotencyKey)).toEqual([`${deliveryId}:0`]);
  });

  it('answers within a second while the CI gate is saturated', async () => {
    // Hold all three gate slots on deliveries that cannot finish — the burst that
    // used to push a delivery past GitHub's ten seconds.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked = async (): Promise<CiFeedbackContextResolution> => {
      await held;
      return { kind: 'unknown_repo' };
    };
    const pending = {
      providerRepoId: REPO_PROVIDER_ID,
      commitSha: SHA,
      conclusion: 'success' as const,
      prNumbers: [],
      headBranch: null,
      suiteId: CI_SUITE,
    };
    const holders = [1, 2, 3].map((n) =>
      applyCiStatusFeedback({ ...pending, context: `holder ${n}` }, blocked),
    );

    try {
      const started = Date.now();
      const res = await postDelivery('check_suite', checkSuitePayload('completed', 'success'));
      expect(res.status).toBe(202);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      release();
      await Promise.all(holders);
    }
  });

  it('rejects a bad signature 401 and stores nothing', async () => {
    const deliveryId = randomUUID();
    const res = await postDelivery('check_run', checkRunPayload('TypeScript', 'in_progress'), {
      deliveryId,
      signature: 'sha256=deadbeef',
    });
    expect(res.status).toBe(401);
    expect(await githubWebhookInboxService.findDelivery(deliveryId)).toBeNull();
    expect(await adminDb.githubWebhookDelivery.count()).toBe(0);
  });

  it('answers an unhandled event 200 ignored and stores nothing', async () => {
    const res = await postDelivery('star', { action: 'created' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      result: { event: 'ignored', reason: 'unhandled_event:star' },
    });
    expect(await adminDb.githubWebhookDelivery.count()).toBe(0);
  });

  it('answers a handled event with no delivery GUID 400', async () => {
    const res = await postDelivery('check_run', checkRunPayload('TypeScript', 'in_progress'), {
      deliveryId: null,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'GITHUB_WEBHOOK_MISSING_DELIVERY_ID' });
    expect(await adminDb.githubWebhookDelivery.count()).toBe(0);
  });

  it('answers a non-object body 200 ignored', async () => {
    const res = await postDelivery('check_run', [1, 2]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: { reason: 'malformed_body' } });
  });

  it('answers a copy of a delivery already in hand 202 duplicate, enqueuing nothing new', async () => {
    const deliveryId = randomUUID();
    const payload = checkRunPayload('TypeScript', 'in_progress');
    await postDelivery('check_run', payload, { deliveryId });
    const again = await postDelivery('check_run', payload, { deliveryId });

    expect(again.status).toBe(202);
    expect(await again.json()).toMatchObject({ receipt: 'duplicate', deliveryId });
    expect(
      await adminDb.jobEvent.count({ where: { name: 'system.github-webhook-delivery' } }),
    ).toBe(1);
  });
});

describe('processing a stored delivery', () => {
  it('runs the handler, records its answer and drops the body', async () => {
    const s = await makeScenario('inbox-process@example.com');
    const card = await cardWithPr(s);
    const ref = await store('check_run', checkRunPayload('TypeScript', 'in_progress'));

    const outcome = await githubWebhookInboxService.processDelivery(ref);

    expect(outcome).toEqual({ outcome: 'processed', event: 'check_run' });
    const row = await adminDb.githubWebhookDelivery.findUniqueOrThrow({
      where: { deliveryId: ref.deliveryId },
    });
    expect(row).toMatchObject({ state: 'processed', attempts: 1, payload: null, lastError: null });
    expect(row.result).toMatchObject({ event: 'ci' });
    expect(row.processedAt).not.toBeNull();
    expect(await checkRows()).toEqual([
      { checkName: 'TypeScript', conclusion: 'pending', suiteAggregate: false },
    ]);
    expect(await statusOf(card.id)).toBe('implemented');
  });

  it('a second run of the same delivery leaves the same rows, comment and status', async () => {
    const s = await makeScenario('inbox-twice@example.com');
    const card = await cardWithPr(s);
    const ref = await store('check_run', checkRunPayload('TypeScript', 'completed', 'failure'));

    await githubWebhookInboxService.processDelivery(ref);
    const rowsOnce = await checkRows();
    const commentsOnce = await commentsOn(card.id);
    const statusOnce = await statusOf(card.id);

    expect(await githubWebhookInboxService.processDelivery(ref)).toEqual({
      outcome: 'skipped',
      reason: 'already_processed',
    });
    // Even with the inbox guard out of the way — the handler run twice on the same
    // body, which is what a hand redelivery of a processed delivery amounts to —
    // the state converges.
    await githubWebhookService.handleEvent(
      'check_run',
      checkRunPayload('TypeScript', 'completed', 'failure'),
      ref.deliveryId,
    );

    expect(await checkRows()).toEqual(rowsOnce);
    expect(await commentsOn(card.id)).toEqual(commentsOnce);
    expect(commentsOnce).toHaveLength(1);
    expect(await statusOf(card.id)).toBe(statusOnce);
  });

  it('records a throw as failed and rethrows it, and the retry processes it', async () => {
    const ref = await store('check_run', checkRunPayload('TypeScript', 'in_progress'));
    const spy = vi
      .spyOn(githubWebhookService, 'handleEvent')
      .mockRejectedValueOnce(new Error('database went away'));

    // Through the real job definition, as the worker runs it: the throw surfaces
    // as the run's error, which is what the worker retries on its backoff.
    const engine = new JobTestEngine({
      function: githubWebhookDelivery,
      events: [
        {
          name: 'system.github-webhook-delivery',
          data: { ...ref, idempotencyKey: `${ref.deliveryId}:0`, workspaceId: null },
        },
      ],
    });
    const first = await engine.execute();
    expect(first.error?.message).toBe('database went away');
    const failed = await githubWebhookInboxService.findDelivery(ref.deliveryId);
    expect(failed).toMatchObject({ state: 'failed', attempts: 1, lastError: 'database went away' });

    spy.mockRestore();
    const second = await engine.execute();
    expect(second.error).toBeUndefined();
    expect(second.result).toEqual({ outcome: 'processed', event: 'check_run' });
    expect(await githubWebhookInboxService.findDelivery(ref.deliveryId)).toMatchObject({
      state: 'processed',
      attempts: 2,
      lastError: null,
    });
  });

  it('a GitHub redelivery of a FAILED delivery re-arms it under a new generation', async () => {
    const ref = await store('check_run', checkRunPayload('TypeScript', 'in_progress'));
    vi.spyOn(githubWebhookService, 'handleEvent').mockRejectedValueOnce(new Error('boom'));
    await expect(githubWebhookInboxService.processDelivery(ref)).rejects.toThrow('boom');

    const receipt = await githubWebhookInboxService.receive({
      event: 'check_run',
      payload: checkRunPayload('TypeScript', 'in_progress'),
      deliveryId: ref.deliveryId,
    });
    expect(receipt).toEqual({ kind: 'rearmed', deliveryId: ref.deliveryId });
    expect(await githubWebhookInboxService.findDelivery(ref.deliveryId)).toMatchObject({
      state: 'received',
      generation: 1,
      lastError: null,
    });

    // The old generation's retry stands down; the new one owns the row.
    expect(await githubWebhookInboxService.processDelivery(ref)).toEqual({
      outcome: 'skipped',
      reason: 'superseded',
    });
    expect(await githubWebhookInboxService.processDelivery({ ...ref, generation: 1 })).toEqual({
      outcome: 'processed',
      event: 'check_run',
    });
  });

  it('a run for a row that is gone is skipped', async () => {
    expect(
      await githubWebhookInboxService.processDelivery({ deliveryId: randomUUID(), generation: 0 }),
    ).toEqual({ outcome: 'skipped', reason: 'missing' });
  });
});

describe('the end-of-workflow burst (the observed loss)', () => {
  it('ends with the roll-up terminal and the card in review, without the reconcile tick', async () => {
    const s = await makeScenario('inbox-burst@example.com');
    const card = await cardWithPr(s);
    // The workflow is running: its suite and its last job are both pending.
    await githubWebhookService.handleEvent('check_suite', checkSuitePayload('in_progress'));
    await githubWebhookService.handleEvent(
      'check_run',
      checkRunPayload('TypeScript', 'in_progress'),
    );
    expect(await statusOf(card.id)).toBe('implemented');

    // The burst: the last job's completion and the suite's, both through the route,
    // both answered at once — and then processed together, as the worker does.
    const captured = captureJobEvents();
    const runRes = await postDelivery(
      'check_run',
      checkRunPayload('TypeScript', 'completed', 'success'),
    );
    const suiteRes = await postDelivery('check_suite', checkSuitePayload('completed', 'success'));
    captured.restore();
    expect([runRes.status, suiteRes.status]).toEqual([202, 202]);
    const runs = captured.events.filter((e) => e.name === 'system.github-webhook-delivery');
    expect(runs).toHaveLength(2);

    const outcomes = await Promise.all(
      runs.map((e) =>
        new JobTestEngine({ function: githubWebhookDelivery, events: [e] }).execute(),
      ),
    );
    expect(outcomes.map((o) => o.error)).toEqual([undefined, undefined]);

    expect(await checkRows()).toEqual([
      { checkName: 'TypeScript', conclusion: 'success', suiteAggregate: false },
      { checkName: 'github-actions', conclusion: 'success', suiteAggregate: true },
    ]);
    expect(await statusOf(card.id)).toBe('in_review');
    const comments = await commentsOn(card.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('CI passing');
  });
});

const CHECKS = Array.from({ length: 12 }, (_, i) => `job ${String(i + 1).padStart(2, '0')}`);

/** Poll an authoritative read until it holds — never a fixed sleep. */
async function until(predicate: () => Promise<boolean>, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/**
 * Fill the real CI-feedback gate with three deliveries from elsewhere that cannot
 * finish until `open()` — the three a burst leaves inside it.
 */
function holdCiGateShut(): { open: () => Promise<void> } {
  let release!: () => void;
  const shut = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holders = [1, 2, 3].map((n) =>
    applyCiStatusFeedback(
      {
        providerRepoId: REPO_PROVIDER_ID,
        commitSha: SHA,
        conclusion: 'success' as const,
        prNumbers: [],
        headBranch: null,
        suiteId: CI_SUITE,
        context: `holder ${n}`,
      },
      async (): Promise<CiFeedbackContextResolution> => {
        await shut;
        return { kind: 'unknown_repo' };
      },
    ),
  );
  return {
    open: async () => {
      release();
      await Promise.all(holders);
    },
  };
}

/** Post every check's completion, then the suite's, through the route; answer the queued runs. */
async function postCompletionBurst(): Promise<{ id: string }[]> {
  for (const name of CHECKS) {
    const res = await postDelivery('check_run', checkRunPayload(name, 'completed', 'success'));
    expect(res.status).toBe(202);
  }
  expect(
    (await postDelivery('check_suite', checkSuitePayload('completed', 'success'))).status,
  ).toBe(202);
  const deliveries = await adminDb.jobQueueRun.findMany({
    where: { jobId: 'system.github-webhook-delivery' },
    select: { id: true },
  });
  expect(deliveries).toHaveLength(CHECKS.length + 1);
  return deliveries;
}

/** A real worker running each claimed run through the ledger, as `scripts/worker.ts` does. */
function deliveryWorker(
  workerId: string,
  timings: ConstructorParameters<typeof JobWorker>[0]['timings'] = {},
): JobWorker {
  return new JobWorker({
    workerId,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    timings: { idleMaxMs: 200, ...timings },
    execute: async (run) => {
      const event = run.eventId
        ? await adminDb.jobEvent.findUnique({ where: { id: run.eventId } })
        : null;
      await executeWithLedger(run, event?.data ?? {});
    },
  });
}

describe('a burst of CI deliveries on the real worker (Bug MOTIR-10457)', () => {
  // Every delivery is a `system.github-webhook-delivery` run, and a CI one waits on
  // the three-slot CI-feedback gate. A run waiting there used to hold one of the
  // worker's ten pool slots, so a push's burst filled the pool with waiters and an
  // unrelated job — `email.send`, a scheduled fire, a supervisor step — waited for
  // the whole backlog. Here the gate is held shut from outside while more CI
  // deliveries than the pool has slots are queued, then one unrelated run.

  it('an unrelated job is claimed while the burst waits, and every delivery is processed', async () => {
    const s = await makeScenario('inbox-worker-burst@example.com');
    const card = await cardWithPr(s);
    await githubWebhookService.handleEvent('check_suite', checkSuitePayload('in_progress'));
    for (const name of CHECKS) {
      await githubWebhookService.handleEvent('check_run', checkRunPayload(name, 'in_progress'));
    }

    // The gate is full: three CI deliveries from elsewhere that cannot finish yet.
    const gate = holdCiGateShut();

    // The burst — every check's completion, then the suite's — through the route,
    // so each becomes a queued delivery run; then one unrelated job, due after all
    // of them, which the claim (by `run_at`) reaches last.
    const deliveries = await postCompletionBurst();

    const unrelatedJob = defineJob({ id: 'test.inbox-unrelated' as never }, () => ({ sent: true }));
    const unrelated = await adminDb.jobQueueRun.create({
      data: {
        jobId: unrelatedJob.id,
        eventName: unrelatedJob.id,
        runAt: new Date(Date.now() + 10),
        maxAttempts: 3,
      },
    });

    const worker = deliveryWorker('inbox-burst-worker');
    worker.start();
    try {
      // AC 1 — the unrelated job is claimed and finished while every delivery of
      // the burst is still waiting on the gate.
      //
      // Both halves wait on their CONDITION, never on a fixed budget (MOTIR-11270).
      // The gate stays shut for the whole block, so before the fix the unrelated
      // run could never be claimed — the burst's waiters held every pool slot — and the
      // first `until` times out however long it is given. And the park count is
      // polled rather than read once: the unrelated run is claimed in the same
      // batch as the burst's last deliveries, and it can finish while those are
      // still on their way to the gate (loading the event, opening the ledger
      // row). On a loaded CI shard a single read caught 11 of 13 parked.
      try {
        await until(
          async () =>
            (await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: unrelated.id } })).state ===
            'succeeded',
          'the unrelated job to settle while the CI gate is shut',
        );
        await until(
          async () => worker.parkedCount === CHECKS.length + 1,
          'every delivery of the burst to park on the shut CI gate',
        );
        expect(await adminDb.githubWebhookDelivery.count({ where: { state: 'processed' } })).toBe(
          0,
        );
      } finally {
        await gate.open();
      }

      // AC 2 — the burst ends with every delivery processed and the roll-up terminal.
      await until(
        async () =>
          (await adminDb.jobQueueRun.count({
            where: { id: { in: deliveries.map((d) => d.id) }, state: 'succeeded' },
          })) === deliveries.length,
        'every delivery run to succeed once the gate opens',
      );
    } finally {
      await worker.shutdown();
    }
    expect(await adminDb.githubWebhookDelivery.count({ where: { state: 'processed' } })).toBe(
      CHECKS.length + 1,
    );
    expect(await checkRows()).toEqual([
      { checkName: 'github-actions', conclusion: 'success', suiteAggregate: true },
      ...CHECKS.map((checkName) => ({ checkName, conclusion: 'success', suiteAggregate: false })),
    ]);
    expect(await statusOf(card.id)).toBe('in_review');
  });
});

describe('a drain that releases deliveries parked on the gate (Bug MOTIR-10462)', () => {
  // A deploy during a burst: the drain times out with deliveries parked in the CI
  // gate's line, and releases them so another machine can take them at once. Before
  // the fix the gate later admitted them HERE, so their `handleEvent` ran in the
  // draining process while the rows were claimable elsewhere, and a check's
  // `in_progress` could land after its `completed` and pull the row back.
  it('leaves their rows as the release wrote them, and the next worker processes each once', async () => {
    const s = await makeScenario('inbox-drain-parked@example.com');
    const card = await cardWithPr(s);
    await githubWebhookService.handleEvent('check_suite', checkSuitePayload('in_progress'));
    for (const name of CHECKS) {
      await githubWebhookService.handleEvent('check_run', checkRunPayload(name, 'in_progress'));
    }
    const pendingRows = await checkRows();
    const gate = holdCiGateShut();
    const deliveries = await postCompletionBurst();
    const ids = deliveries.map((d) => d.id);

    const draining = deliveryWorker('inbox-drain-old', { drainTimeoutMs: 100 });
    draining.start();
    try {
      await until(
        async () => draining.parkedCount === deliveries.length,
        'every delivery of the burst to park on the CI gate',
      );
      await draining.shutdown(); // times out on the parked deliveries and releases them
    } finally {
      // The gate frees after the release — the draining process is still alive.
      await gate.open();
    }
    await draining.settled();

    // AC 1 — nothing was processed in the draining process…
    const inbox = await adminDb.githubWebhookDelivery.findMany({
      select: { state: true, lastError: true },
    });
    expect(inbox).toHaveLength(deliveries.length);
    expect(inbox.every((row) => row.state === 'received' && row.lastError === null)).toBe(true);
    expect(await checkRows()).toEqual(pendingRows);
    // AC 2 — …and the queue rows are as the release wrote them.
    const queued = await adminDb.jobQueueRun.findMany({ where: { id: { in: ids } } });
    expect(queued.map((r) => [r.state, r.claimedBy, r.attempts])).toEqual(
      ids.map(() => ['pending', null, 0]),
    );

    // The next claimant processes each delivery once, and the roll-up ends terminal.
    const next = deliveryWorker('inbox-drain-next');
    next.start();
    try {
      await until(
        async () =>
          (await adminDb.jobQueueRun.count({ where: { id: { in: ids }, state: 'succeeded' } })) ===
          ids.length,
        'the next worker to process every released delivery',
      );
    } finally {
      await next.shutdown();
    }
    const settledRuns = await adminDb.jobQueueRun.findMany({ where: { id: { in: ids } } });
    expect(settledRuns.every((r) => r.attempts === 1)).toBe(true);
    expect(await adminDb.githubWebhookDelivery.count({ where: { state: 'processed' } })).toBe(
      deliveries.length,
    );
    expect(await checkRows()).toEqual([
      { checkName: 'github-actions', conclusion: 'success', suiteAggregate: true },
      ...CHECKS.map((checkName) => ({ checkName, conclusion: 'success', suiteAggregate: false })),
    ]);
    expect(await statusOf(card.id)).toBe('in_review');
  });
});

describe('the reconcile backstop re-renders the comment (AC 5)', () => {
  function hostSays(conclusion: 'success' | 'failure'): ReportedCheckRun[] {
    return [
      {
        checkName: 'TypeScript',
        checkSuiteId: CI_SUITE,
        conclusion,
        rawConclusion: conclusion,
        url: null,
        completedAt: null,
      },
      {
        checkName: 'github-actions',
        checkSuiteId: CI_SUITE,
        conclusion,
        rawConclusion: conclusion,
        url: null,
        completedAt: null,
        suiteAggregate: true,
      },
    ];
  }

  it('settles the lost suite delivery, promotes, and the comment stops reading "1 of 2"', async () => {
    const s = await makeScenario('inbox-reconcile@example.com');
    const card = await cardWithPr(s);
    await githubWebhookService.handleEvent('check_suite', checkSuitePayload('in_progress'));
    await githubWebhookService.handleEvent(
      'check_run',
      checkRunPayload('TypeScript', 'completed', 'success'),
    );
    // The suite's `completed` delivery is LOST: the comment is interim and the card waits.
    expect(await commentsOn(card.id)).toEqual([expect.stringContaining('1 of 2 checks complete')]);
    expect(await statusOf(card.id)).toBe('implemented');

    // The reconcile tick, past the stale-pending threshold, re-reads the host.
    const later = new Date(Date.now() + 60 * 60_000);
    const promoted = await promoteIfCiAlreadyGreen(
      card.id,
      s.ctx,
      async () => hostSays('success'),
      later,
    );

    expect(promoted).toBe(true);
    expect(await statusOf(card.id)).toBe('in_review');
    const comments = await commentsOn(card.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('CI passing');
    expect(comments[0]).toContain('all 2 checks');
  });

  it('re-renders after settling a row even when nothing is promoted', async () => {
    const s = await makeScenario('inbox-reconcile-red@example.com');
    const card = await cardWithPr(s);
    await githubWebhookService.handleEvent('check_suite', checkSuitePayload('in_progress'));
    await githubWebhookService.handleEvent(
      'check_run',
      checkRunPayload('TypeScript', 'in_progress'),
    );

    const later = new Date(Date.now() + 60 * 60_000);
    const promoted = await promoteIfCiAlreadyGreen(
      card.id,
      s.ctx,
      async () => hostSays('failure'),
      later,
    );

    expect(promoted).toBe(false);
    expect(await statusOf(card.id)).toBe('implemented');
    const comments = await commentsOn(card.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('CI failed');
    expect(comments[0]).toContain('`TypeScript`');
  });

  it('a comment that fails to render does not fail the reconcile or the promotion', async () => {
    const s = await makeScenario('inbox-reconcile-throw@example.com');
    const card = await cardWithPr(s);
    await githubWebhookService.handleEvent('check_suite', checkSuitePayload('in_progress'));
    await githubWebhookService.handleEvent(
      'check_run',
      checkRunPayload('TypeScript', 'completed', 'success'),
    );
    const { commentsService } = await import('@/lib/services/commentsService');
    vi.spyOn(commentsService, 'editComment').mockRejectedValue(new Error('comment store down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const promoted = await promoteIfCiAlreadyGreen(
      card.id,
      s.ctx,
      async () => hostSays('success'),
      new Date(Date.now() + 60 * 60_000),
    );

    expect(promoted).toBe(true);
    expect(await statusOf(card.id)).toBe('in_review');
    expect(warn).toHaveBeenCalledWith(
      '[ciPromotion] could not re-render the CI feedback comment',
      expect.objectContaining({ error: 'comment store down' }),
    );
  });

  it('refreshFeedbackComments skips a pull request it cannot render onto', async () => {
    const s = await makeScenario('inbox-refresh-skip@example.com');
    expect(
      await refreshFeedbackComments({
        pullRequestId: 'missing',
        commitSha: SHA,
        workspaceId: s.workspace.id,
      }),
    ).toEqual({ outcome: 'skipped', reason: 'no_pull_request' });

    // A pull request whose head ref names no card links nothing.
    await githubWebhookService.handleEvent('pull_request', {
      action: 'opened',
      ...envelope,
      pull_request: {
        number: 8,
        state: 'open',
        merged: false,
        title: 'An unlinked change',
        head: { ref: 'chore/unlinked' },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });
    const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 8 } });
    expect(
      await refreshFeedbackComments({
        pullRequestId: pr.id,
        commitSha: SHA,
        workspaceId: s.workspace.id,
      }),
    ).toEqual({ outcome: 'skipped', reason: 'no_linked_card' });
  });
});

describe('the inbox sweep', () => {
  it('re-enqueues a row still received past the threshold, under its own key', async () => {
    const now = new Date();
    const stale = randomUUID();
    const fresh = randomUUID();
    await adminDb.githubWebhookDelivery.createMany({
      data: [
        {
          deliveryId: stale,
          event: 'check_run',
          payload: {},
          receivedAt: new Date(now.getTime() - GITHUB_WEBHOOK_INBOX_STALE_MS - 1_000),
        },
        { deliveryId: fresh, event: 'check_run', payload: {}, receivedAt: now },
      ],
    });

    const summary = await githubWebhookInboxService.sweep(now);

    expect(summary).toEqual({ reenqueued: 1, prunedProcessed: 0, prunedFailed: 0 });
    const queued = await adminDb.jobEvent.findMany({
      where: { name: 'system.github-webhook-delivery' },
    });
    expect(queued.map((e) => e.idempotencyKey)).toEqual([`${stale}:0`]);
  });

  it('prunes processed and failed rows past their retention, and nothing younger', async () => {
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms - 1_000);
    await adminDb.githubWebhookDelivery.createMany({
      data: [
        {
          deliveryId: 'old-processed',
          event: 'push',
          state: 'processed',
          receivedAt: ago(GITHUB_WEBHOOK_INBOX_PROCESSED_RETENTION_MS),
        },
        { deliveryId: 'new-processed', event: 'push', state: 'processed', receivedAt: now },
        {
          deliveryId: 'old-failed',
          event: 'push',
          state: 'failed',
          receivedAt: ago(GITHUB_WEBHOOK_INBOX_FAILED_RETENTION_MS),
        },
        // Past the processed retention, inside the failed one.
        {
          deliveryId: 'young-failed',
          event: 'push',
          state: 'failed',
          receivedAt: ago(GITHUB_WEBHOOK_INBOX_PROCESSED_RETENTION_MS),
        },
      ],
    });

    const result = await new JobTestEngine({ function: githubWebhookInboxSweep }).execute();

    expect(result.result).toEqual({ reenqueued: 0, prunedProcessed: 1, prunedFailed: 1 });
    const left = await adminDb.githubWebhookDelivery.findMany({ orderBy: { deliveryId: 'asc' } });
    expect(left.map((r) => r.deliveryId)).toEqual(['new-processed', 'young-failed']);
  });

  it('logs an enqueue that fails and still answers the route 202', async () => {
    const dispatcher = await import('@/lib/jobs/engine/dispatcher');
    vi.spyOn(dispatcher, 'dispatchEventToEngine').mockRejectedValue(new Error('queue down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await postDelivery('check_run', checkRunPayload('TypeScript', 'in_progress'));

    expect(res.status).toBe(202);
    expect(error).toHaveBeenCalledWith(
      '[githubWebhookInbox] enqueue failed; the inbox sweep will retry it',
      expect.objectContaining({ error: 'queue down' }),
    );
    expect(await adminDb.githubWebhookDelivery.count({ where: { state: 'received' } })).toBe(1);
  });
});

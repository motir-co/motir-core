// GitHub-integration E2E seed + signed-webhook helpers (Story 7.10 · MOTIR-897).
//
// The spec simulates GitHub two ways, both landing on REAL shipped paths:
//
//   * The App INSTALLATION is seeded through `githubInstallationService
//     .persistInstallation` — the exact function the post-install setup flow
//     (MOTIR-1588) and the webhook grant-mirror both call — because the real
//     binding round-trip runs on GitHub's servers (App JWT → installation-token
//     → repo fetch) and cannot execute against a synthetic installation. This
//     is the sanctioned server-side service import the other seed helpers use
//     (see work-item-setup.ts's projectsService precedent).
//
//   * PR / CI deliveries are POSTed to the REAL `/api/github/webhook` route as
//     SIGNED payloads (HMAC-SHA256 over the raw body with the same
//     GITHUB_WEBHOOK_SECRET playwright.config.ts hands the dev server), so the
//     7.10.4 signature gate + the full service path run end-to-end — the
//     assertion is on Motir's observable behavior, not on GitHub.

import { createHmac, randomUUID } from 'node:crypto';
import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookInboxService } from '@/lib/services/githubWebhookInboxService';
import type { GithubInstallationDTO } from '@/lib/dto/github';
import {
  E2E_GITHUB_USER,
  E2E_GITHUB_WEBHOOK_SECRET,
  E2E_INSTALLATION_ACCOUNT,
  E2E_INSTALLATION_ID,
  E2E_REPO,
} from './github-const';

/** Bind the synthetic App installation (+ its one selected repo) to a
 *  workspace — the state the real setup redirect leaves behind. Idempotent. */
export async function seedGithubInstallation(
  workspaceId: string,
  /** Extra repositories to mirror onto the same installation (MOTIR-2730). The
   *  default keeps every existing caller byte-identical — a multi-repo fixture
   *  is opt-in, so no shipped spec's connected set changes underneath it. */
  extraRepos: readonly {
    providerRepoId: string;
    owner: string;
    name: string;
    defaultBranch: string;
    archived: boolean;
  }[] = [],
): Promise<GithubInstallationDTO> {
  return githubInstallationService.persistInstallation({
    workspaceId,
    installation: {
      installationId: E2E_INSTALLATION_ID,
      accountLogin: E2E_INSTALLATION_ACCOUNT.login,
      accountType: E2E_INSTALLATION_ACCOUNT.type,
    },
    repos: [{ ...E2E_REPO }, ...extraRepos.map((r) => ({ ...r }))],
  });
}

/** GitHub's `X-Hub-Signature-256` over the exact raw body. */
export function signWebhook(rawBody: string): string {
  return `sha256=${createHmac('sha256', E2E_GITHUB_WEBHOOK_SECRET).update(rawBody).digest('hex')}`;
}

/** How long {@link postSignedWebhook} waits for the inbox job to process a delivery —
 *  past the delivery job's whole retry budget (five attempts on a 1·2·4·8 s backoff). */
const DELIVERY_PROCESSED_TIMEOUT_MS = 60_000;
const DELIVERY_POLL_MS = 100;

/** What {@link postSignedWebhook} answers once the delivery has been processed: the
 *  answer the route gave before MOTIR-10425 — `200 { ok, result }` — or, for a
 *  delivery whose processing kept failing, `500` with the error, so a spec asserting
 *  `status() === 200` fails on the real cause. */
function processedResponse(raw: APIResponse, status: number, body: unknown): APIResponse {
  const text = JSON.stringify(body);
  return Object.assign(Object.create(raw) as APIResponse, {
    status: () => status,
    ok: () => status >= 200 && status < 300,
    statusText: () => (status === 200 ? 'OK' : 'Internal Server Error'),
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
    body: async () => Buffer.from(text),
  });
}

/** POST one signed delivery to the real webhook route, and wait for it to be
 *  PROCESSED. `payload` is serialized ONCE and signed over those exact bytes (a
 *  re-serialized body would not match the HMAC).
 *
 *  ⚠️ THE ROUTE ANSWERS BEFORE THE WORK RUNS since Bug MOTIR-10425: it stores the
 *  delivery and returns `202`, and the `system.github-webhook-delivery` job processes
 *  it in the lane's job worker. Every caller asserts what the delivery DID, so this
 *  waits on the inbox row — the authoritative completion signal, never a sleep — and
 *  answers as the route used to: `200 { ok: true, result }`. Any other answer from the
 *  route (a `200` for an ignored event, a `401`, a `400`) is returned as it came.
 *
 *  The delivery GUID is random, as GitHub's is: the inbox is keyed on it, so a GUID
 *  repeated across specs or runs would be a duplicate that never runs. */
export async function postSignedWebhook(
  request: Page['request'] | APIRequestContext,
  event: string,
  payload: unknown,
): Promise<APIResponse> {
  const rawBody = JSON.stringify(payload);
  const deliveryId = randomUUID();
  const res = await request.post('/api/github/webhook', {
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-hub-signature-256': signWebhook(rawBody),
      'x-github-delivery': deliveryId,
    },
    data: rawBody,
  });
  if (res.status() !== 202) return res;

  const deadline = Date.now() + DELIVERY_PROCESSED_TIMEOUT_MS;
  let last: Awaited<ReturnType<typeof githubWebhookInboxService.findDelivery>> = null;
  while (Date.now() < deadline) {
    last = await githubWebhookInboxService.findDelivery(deliveryId);
    if (last?.state === 'processed') {
      return processedResponse(res, 200, { ok: true, result: last.result });
    }
    // Spent: the job runner has dead-lettered it.
    if (last?.state === 'failed' && last.attempts >= 5) break;
    await new Promise((resolve) => setTimeout(resolve, DELIVERY_POLL_MS));
  }
  if (last?.state === 'failed') {
    return processedResponse(res, 500, {
      code: 'GITHUB_WEBHOOK_PROCESSING_FAILED',
      deliveryId,
      error: last.lastError,
    });
  }
  throw new Error(
    `[github-seed] ${event} delivery ${deliveryId} was not processed within ` +
      `${DELIVERY_PROCESSED_TIMEOUT_MS} ms (inbox state: ${last?.state ?? 'missing'}) — ` +
      "is the lane's job worker running?",
  );
}

/** A minimal `pull_request` delivery carrying every field the provider seam's
 *  `parseChangeRequestEvent` + the webhook service read (installation id, repo
 *  id, PR number/state/merged/head-ref/BASE-ref/title, author id). `baseRef`
 *  defaults to the seeded repo's default branch — a merge onto anything else is
 *  held at In Review by the trunk gate (MOTIR-1873). */
export function pullRequestPayload(args: {
  action: 'opened' | 'reopened' | 'closed';
  number: number;
  title: string;
  headRef: string;
  state: 'open' | 'closed';
  merged: boolean;
  baseRef?: string;
  /** WHICH repository the delivery is for (MOTIR-2730). Defaults to
   *  {@link E2E_REPO}, so every existing caller produces the same payload it
   *  always did; a two-repository spec passes the second one explicitly. */
  repo?: { providerRepoId: string; defaultBranch: string };
}): Record<string, unknown> {
  const repo = args.repo ?? E2E_REPO;
  return {
    action: args.action,
    installation: { id: Number(E2E_INSTALLATION_ID) },
    repository: { id: Number(repo.providerRepoId) },
    pull_request: {
      number: args.number,
      state: args.state,
      merged: args.merged,
      title: args.title,
      head: { ref: args.headRef },
      base: { ref: args.baseRef ?? repo.defaultBranch },
      user: { id: E2E_GITHUB_USER.id },
    },
  };
}

/** A minimal `pull_request_review` delivery — every field the provider seam's
 *  `parseReviewEvent` reads (Story MOTIR-4910 · MOTIR-5601).
 *
 *  ⚠️ `commitSha` IS THE HEAD THE REVIEW WAS GIVEN AT, and it is separate from the pull
 *  request's current head on purpose: the two differing is exactly the stale-review case, so
 *  a helper that derived one from the other could not express it.
 *
 *  ⚠️ `reviewId` IS GITHUB'S OWN REVIEW ID and the idempotency key — a spec that posts the
 *  same review twice passes the same id, and one that posts two reviews passes two. */
export function pullRequestReviewPayload(args: {
  number: number;
  headSha: string;
  /** The commit the REVIEW names; defaults to the pull request's head. */
  commitSha?: string;
  reviewId: number;
  state: 'approved' | 'changes_requested' | 'commented';
  action?: 'submitted' | 'dismissed' | 'edited';
  reviewer: { login: string; id: number };
  headRef?: string;
  repo?: { providerRepoId: string; owner?: string; name?: string; defaultBranch: string };
}): Record<string, unknown> {
  const repo = args.repo ?? E2E_REPO;
  return {
    action: args.action ?? 'submitted',
    installation: { id: Number(E2E_INSTALLATION_ID) },
    repository: {
      id: Number(repo.providerRepoId),
      name: 'name' in repo ? repo.name : undefined,
      owner: { login: 'owner' in repo ? repo.owner : undefined },
    },
    pull_request: {
      number: args.number,
      state: 'open',
      head: { ref: args.headRef ?? `review/${args.number}`, sha: args.headSha },
      base: { ref: repo.defaultBranch },
    },
    review: {
      id: args.reviewId,
      state: args.state,
      commit_id: args.commitSha ?? args.headSha,
      submitted_at: new Date().toISOString(),
      html_url: `https://github.com/x/y/pull/${args.number}#pullrequestreview-${args.reviewId}`,
      user: { id: args.reviewer.id, login: args.reviewer.login, type: 'User' },
    },
  };
}

/** A minimal `check_suite` delivery (the CI feedback path — 7.10.6): the
 *  aggregate for a commit, linked to its PR by number.
 *
 *  Terminal by default — `{ status: 'completed', conclusion }` — which is every
 *  existing caller, byte for byte. A suite that has NOT finished is expressed by
 *  passing `status: 'in_progress'` with a `null` conclusion (MOTIR-3009): the
 *  lifecycle story needs the state where checks are RUNNING, because "a card
 *  does not move while the build is still going" is a claim only a non-terminal
 *  aggregate can make. */
export function checkSuitePayload(args: {
  conclusion: 'success' | 'failure' | null;
  headSha: string;
  prNumber: number;
  headBranch: string;
  status?: 'queued' | 'in_progress' | 'completed';
  /** WHICH repository the suite ran in (MOTIR-5487) — defaults to {@link E2E_REPO}, so
   *  every existing caller produces the payload it always did. */
  repo?: { providerRepoId: string };
}): Record<string, unknown> {
  return {
    action: 'completed',
    installation: { id: Number(E2E_INSTALLATION_ID) },
    repository: { id: Number((args.repo ?? E2E_REPO).providerRepoId) },
    check_suite: {
      status: args.status ?? 'completed',
      conclusion: args.conclusion,
      head_sha: args.headSha,
      head_branch: args.headBranch,
      pull_requests: [{ number: args.prNumber }],
      app: { slug: 'e2e-ci' },
    },
  };
}

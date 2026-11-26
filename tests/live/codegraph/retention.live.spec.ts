// THE STORY'S VERIFICATION RECIPE, ACROSS THE THREE REAL SERVICES
// (MOTIR-12260 · story MOTIR-12250). Run by `pnpm test:live:codegraph` (`lane.mjs`).
//
// Code-graph copies are kept only where they are read: a default-branch commit a
// push left goes after the default-branch window, an open same-repository pull
// request's head is indexed as a delta on its base and goes after the pull-request
// window with no push, a merged or closed branch goes when that is reported, and a
// read at a retired commit answers at the current head with a moved marker. Each
// repository proves its own part with the others stubbed; this suite is the one
// place the three run together, entered as production enters them: a signed GitHub
// delivery posted to motir-core's real webhook route.
//
// ── THE BOUNDARIES, AND THE SEAM THAT ANSWERS EACH ───────────────────────────────
//
//   motir-core → motir-ai        REAL. `MOTIR_AI_URL` on motir-core's app server and
//                                job worker points at the motir-ai the lane started.
//   motir-ai → motir-codegraph   REAL. motir-ai's own code-graph settings, which
//                                its `serve-with-local-codegraph` script mints
//                                through codegraph's operator calls; this lane
//                                never holds them.
//   the three worker processes   REAL. motir-core's job worker (`.worker/worker.mjs`,
//                                the shipped bundle) runs the delivery, handoff and
//                                forward jobs; motir-ai's worker runs in its server
//                                process; motir-codegraph's worker indexes, sweeps
//                                and releases, with the windows set ON IT.
//   GitHub: installation token,  `githubFake.preload.mjs`, loaded with `--import` into
//   pull-request head, changed   motir-core's JOB WORKER process — the process that
//   paths, archive redirect      calls GitHub — answering api.github.com from the
//                                scratch repository file (`scenario.mjs`).
//   GitHub: the source archive   `archiveHost.mjs`, a TLS host in its own process that
//                                motir-codegraph's worker downloads from, as it would
//                                from codeload.
//
// Nothing is stubbed in this runner's process: it only posts deliveries, writes the
// scratch repository file, and reads (codegraph's read API, motir-core's MCP route,
// the three databases).
//
// ── WAITS ────────────────────────────────────────────────────────────────────────
//
// Every wait ends on an authoritative signal: the inbox row (`postSignedWebhook`),
// a motir-core job's queue row reaching `succeeded`, a published layer in
// codegraph's database, a release job settling, or — after a window — a
// `retention sweep pass` line the codegraph worker logged whose `startedAt` is past
// the window. There is no fixed sleep.

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import pg from 'pg';
import { postSignedWebhook } from '../../e2e/_helpers/github-seed';
import { createTestPerson } from '../../e2e/_helpers/testPerson';
import { adminDb } from '@/tests/helpers/adminDb';
import { linkProjectRepo } from '@/tests/helpers/projectRepoLink';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { projectsService } from '@/lib/services/projectsService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  addCommit,
  readScenario,
  writeScenario,
  type PullRequest,
  type Scenario,
} from './scenario.mjs';

test.describe.configure({ mode: 'serial' });

const env = (name: string): string => process.env[name]!;
const DEFAULT_WINDOW_MS = Number(env('LIVE_DEFAULT_BRANCH_WINDOW_MS'));
const REF_WINDOW_MS = Number(env('LIVE_REF_WINDOW_MS'));
const SWEEP_INTERVAL_MS = Number(env('LIVE_SWEEP_INTERVAL_MS'));
const CODEGRAPH = env('LIVE_CODEGRAPH_URL');
const SCENARIO = env('LIVE_SCENARIO');

const INSTALLATION_ID = '99012260';
const REPO = {
  providerRepoId: '88012260',
  owner: 'motir-live',
  name: 'scratch',
  defaultBranch: 'main',
  archived: false,
} as const;
const REPO_REF = `${REPO.owner}/${REPO.name}`;
/** A fork of the scratch repository: another repository id, nothing else needed. */
const FORK_REPO_ID = 88012999;

const PR_HEAD_JOB = 'system.code-graph-pr-head-index';
const REFRESH_JOB = 'system.code-graph-refresh';
const FORWARD_JOB = 'system.code-graph-forward';
const INDEX_JOBS = [PR_HEAD_JOB, REFRESH_JOB, 'system.code-graph-index'];

// ── the scratch repository ────────────────────────────────────────────────────

function edit(fn: (s: Scenario) => void): void {
  const scenario = readScenario(SCENARIO);
  fn(scenario);
  writeScenario(SCENARIO, scenario);
}

const source = (name: string) => `export function ${name}(): string {\n  return '${name}';\n}\n`;

/** Commit two files only `label` adds onto `ref`'s head (or `from`), and move the ref. */
function commit(ref: string, label: string, from?: string): string {
  let sha = '';
  edit((s) => {
    const parent = from ?? s.refs[ref] ?? null;
    sha = addCommit(s, parent, {
      [`src/${label}.ts`]: source(`${label}Only`),
      [`src/${label}Also.ts`]: source(`${label}AlsoOnly`),
    });
    s.refs[ref] = sha;
  });
  return sha;
}

function setPull(pr: PullRequest): void {
  edit((s) => {
    s.pulls[String(pr.number)] = pr;
  });
}

// ── deliveries ─────────────────────────────────────────────────────────────────

const repository = (id = Number(REPO.providerRepoId)) => ({
  id,
  name: REPO.name,
  full_name: REPO_REF,
  default_branch: REPO.defaultBranch,
  owner: { login: REPO.owner },
});

function pushPayload(branch: string, after: string, before: string | null) {
  return {
    ref: `refs/heads/${branch}`,
    before: before ?? '0'.repeat(40),
    after,
    created: before === null,
    deleted: false,
    installation: { id: Number(INSTALLATION_ID) },
    // The STORED provider id, as the refresh-engine spec does: a mismatch is an
    // asserted `unknown_repo`, never a silent one.
    repository: repository(),
  };
}

function pullRequestPayload(args: {
  action: 'opened' | 'synchronize' | 'closed';
  pr: PullRequest;
  headSha: string;
}) {
  const now = new Date().toISOString();
  return {
    action: args.action,
    number: args.pr.number,
    installation: { id: Number(INSTALLATION_ID) },
    repository: repository(),
    pull_request: {
      number: args.pr.number,
      state: args.pr.state,
      merged: args.pr.merged,
      merged_at: args.pr.merged ? now : null,
      updated_at: now,
      draft: false,
      title: `Pull request ${args.pr.number}`,
      head: {
        ref: args.pr.headRef,
        sha: args.headSha,
        repo: args.pr.headRepoId === null ? null : { id: args.pr.headRepoId },
      },
      base: { ref: args.pr.baseRef, repo: { id: Number(REPO.providerRepoId) } },
      user: { id: 4242, login: 'live-lane' },
    },
  };
}

type JobRow = { id: string; eventId: string | null; state: string };

const jobRows = (jobId: string) =>
  adminDb.jobQueueRun.findMany({
    where: { jobId },
    select: { id: true, eventId: true, state: true },
  }) as Promise<JobRow[]>;

/** Every index handoff job row motir-core holds, by id — to prove a delivery made none. */
async function indexJobIds(): Promise<Set<string>> {
  const rows = await adminDb.jobQueueRun.findMany({
    where: { jobId: { in: INDEX_JOBS } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/**
 * Post one delivery, assert the inbox processed it, and wait for each job it must
 * have enqueued (`jobs`) to SUCCEED in motir-core's worker. Answers the inbox
 * result and each job's ledger output.
 */
async function deliver(
  request: Parameters<typeof postSignedWebhook>[0],
  event: 'push' | 'pull_request',
  payload: unknown,
  jobs: readonly string[] = [],
): Promise<{ result: Record<string, unknown>; outputs: Record<string, Record<string, unknown>> }> {
  const before = new Map<string, Set<string>>();
  for (const job of jobs) before.set(job, new Set((await jobRows(job)).map((r) => r.id)));
  const res = await postSignedWebhook(request, event, payload);
  expect(res.status(), await res.text()).toBe(200);
  const { result } = (await res.json()) as { result: Record<string, unknown> };

  const outputs: Record<string, Record<string, unknown>> = {};
  for (const job of jobs) {
    let row: JobRow | undefined;
    await expect
      .poll(
        async () => {
          row = (await jobRows(job)).find((r) => !before.get(job)!.has(r.id));
          if (row?.state === 'failed' || row?.state === 'cancelled') {
            throw new Error(`${job} ${row.id} ended ${row.state}`);
          }
          return row?.state ?? 'missing';
        },
        {
          message: `${job} enqueued by this ${event} delivery succeeds`,
          timeout: 180_000,
          intervals: [250],
        },
      )
      .toBe('succeeded');
    const ledger = await adminDb.jobRun.findFirst({
      where: { functionId: job, eventId: row!.eventId!, status: 'succeeded' },
      orderBy: { startedAt: 'desc' },
    });
    outputs[job] = (ledger?.output ?? {}) as Record<string, unknown>;
  }
  return { result, outputs };
}

// ── motir-codegraph: its read API and its database ──────────────────────────────

const cgDb = new pg.Pool({ connectionString: env('LIVE_CODEGRAPH_DATABASE_URL'), max: 2 });
const aiDb = new pg.Pool({ connectionString: env('LIVE_AI_DATABASE_URL'), max: 1 });

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await cgDb.query(sql, params)).rows as T[];
}

let scope: { tenantId: string; repositoryId: string } | null = null;

/** The codegraph tenant and repository motir-ai registered the scratch repository as. */
async function codegraphScope() {
  if (scope) return scope;
  const { rows: found } = await aiDb.query(
    `SELECT t."tenantId", r."repositoryId"
       FROM codegraph_repository_map r
       JOIN codegraph_tenant_map t ON t."aiOrganizationId" = r."aiOrganizationId"
      WHERE r."repoRef" = $1 AND r."repositoryId" IS NOT NULL AND t."tenantId" IS NOT NULL`,
    [REPO_REF],
  );
  expect(found, `motir-ai registered ${REPO_REF} with motir-codegraph`).toHaveLength(1);
  const found0 = found[0] as { tenantId: string; repositoryId: string };
  // The suite reads as its own client (the lane minted it); grant it the tenant motir-ai
  // registered, through the operator call, before the first read.
  const grant = await fetch(`${CODEGRAPH}/v1/operator/grants`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env('LIVE_CODEGRAPH_OPERATOR_TOKEN')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      clientId: env('LIVE_CODEGRAPH_READ_CLIENT_ID'),
      tenantId: found0.tenantId,
    }),
  });
  expect(grant.status, `granting the suite's reader: ${await grant.text()}`).toBe(200);
  scope = found0;
  return scope;
}

type Read = {
  status: number;
  commit: string | null;
  moved: unknown;
  body: Record<string, unknown>;
};

async function search(params: Record<string, string>): Promise<Read> {
  const { tenantId, repositoryId } = await codegraphScope();
  const qs = new URLSearchParams({ query: 'Only', ...params });
  const res = await fetch(
    `${CODEGRAPH}/v1/tenants/${tenantId}/repositories/${repositoryId}/graph/search?${qs}`,
    { headers: { authorization: `Bearer ${env('LIVE_CODEGRAPH_READ_TOKEN')}` } },
  );
  const text = await res.text();
  return {
    status: res.status,
    commit: res.headers.get('x-graph-commit'),
    moved: JSON.parse(res.headers.get('x-graph-moved') ?? 'null'),
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
}

/** A search at `sha` answers 200 AS ITSELF: at that commit, no moved marker, with hits. */
async function expectAnswersAsItself(sha: string): Promise<void> {
  // The search index of a just-published layer is built behind it; a read before
  // then answers graph_warming, so this polls the read itself.
  await expect
    .poll(async () => (await search({ commit: sha })).status, {
      message: `a search at ${sha} answers`,
      timeout: 120_000,
      intervals: [500],
    })
    .toBe(200);
  const answer = await search({ commit: sha });
  expect(answer.commit).toBe(sha);
  expect(answer.moved).toBeNull();
  expect((answer.body['items'] as unknown[]).length).toBeGreaterThan(0);
}

/** A search at a RETIRED `sha` no longer answers as itself (the read fallback moves it). */
async function expectNoLongerItself(sha: string): Promise<Read> {
  const answer = await search({ commit: sha });
  expect(answer.commit, `a read at ${sha} answers at another commit`).not.toBe(sha);
  if (answer.status === 200) expect(answer.moved).toMatchObject({ from: sha });
  return answer;
}

type Layer = {
  id: string;
  commit_sha: string;
  kind: string;
  parent_layer_id: string | null;
  superseded_at: Date | null;
};

const layers = async () =>
  rows<Layer>(
    `SELECT id, commit_sha, kind, parent_layer_id, superseded_at FROM codegraph.commit_layers
      WHERE repository_id = $1 ORDER BY id`,
    [(await codegraphScope()).repositoryId],
  );

const currentLayers = async (sha: string) =>
  (await layers()).filter((l) => l.commit_sha === sha && l.superseded_at === null);

const refNames = async () =>
  (
    await rows<{ ref_name: string }>(
      'SELECT ref_name FROM codegraph.ref_heads WHERE repository_id = $1 ORDER BY ref_name',
      [(await codegraphScope()).repositoryId],
    )
  ).map((r) => r.ref_name);

/** Wait until codegraph holds a PUBLISHED, current layer for `sha`; fail fast on a failed index job. */
async function indexed(sha: string): Promise<Layer> {
  await expect
    .poll(
      async () => {
        const { repositoryId } = await codegraphScope();
        const failed = await rows<{ failure_message: string }>(
          `SELECT failure_message FROM codegraph.index_jobs
            WHERE repository_id = $1 AND commit_sha = $2 AND state = 'failed'`,
          [repositoryId, sha],
        );
        if (failed.length > 0)
          throw new Error(`codegraph's index of ${sha} failed: ${failed[0]!.failure_message}`);
        return (
          await rows(
            `SELECT 1 FROM codegraph.commit_layers WHERE repository_id = $1 AND commit_sha = $2
                AND state = 'published' AND superseded_at IS NULL`,
            [repositoryId, sha],
          )
        ).length;
      },
      { message: `motir-codegraph indexes ${sha}`, timeout: 240_000, intervals: [500] },
    )
    .toBe(1);
  await expectAnswersAsItself(sha);
  return (await currentLayers(sha))[0]!;
}

/** The ids of every layer on the chain of a live ref head. */
async function liveChains(): Promise<Set<string>> {
  const found = await rows<{ id: string }>(
    `WITH RECURSIVE chain(id, parent) AS (
       SELECT l.id, l.parent_layer_id FROM codegraph.ref_heads r
         JOIN codegraph.commit_layers l ON l.id = r.layer_id
        WHERE r.repository_id = $1
       UNION
       SELECT p.id, p.parent_layer_id FROM chain c
         JOIN codegraph.commit_layers p ON p.id = c.parent)
     SELECT id FROM chain`,
    [(await codegraphScope()).repositoryId],
  );
  return new Set(found.map((r) => r.id));
}

/** The database's clock: every window is measured on it, as the sweep measures it. */
async function dbNow(): Promise<Date> {
  return (await rows<{ now: Date }>('SELECT now() AS now'))[0]!.now;
}

/**
 * Wait for a `retention sweep pass` the codegraph WORKER logged whose `startedAt`
 * is past `after`. The pass is logged when it ends, with its counts.
 */
async function sweepPassAfter(after: Date): Promise<Record<string, unknown>> {
  const timeout = Math.max(0, after.getTime() - Date.now()) + SWEEP_INTERVAL_MS * 4;
  let pass: Record<string, unknown> | undefined;
  await expect
    .poll(
      () => {
        const lines = readFileSync(env('LIVE_CODEGRAPH_WORKER_LOG'), 'utf8').split('\n');
        pass = lines
          .filter((l) => l.includes('"retention sweep pass"'))
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .find((p) => new Date(p['startedAt'] as string).getTime() > after.getTime());
        return pass !== undefined;
      },
      { message: `a sweep pass starts after ${after.toISOString()}`, timeout, intervals: [1000] },
    )
    .toBe(true);
  return pass!;
}

/** Wait until no release job of the repository is queued or running, and none failed. */
async function releasesSettled(): Promise<void> {
  const { repositoryId } = await codegraphScope();
  await expect
    .poll(
      async () =>
        (
          await rows<{ state: string }>(
            `SELECT state FROM codegraph.index_jobs WHERE repository_id = $1 AND kind = 'release'
                AND state <> 'succeeded'`,
            [repositoryId],
          )
        ).map((r) => r.state),
      {
        message: 'every release job of the repository succeeds',
        timeout: 120_000,
        intervals: [500],
      },
    )
    .toEqual([]);
}

// ── motir-core's MCP route ───────────────────────────────────────────────────────

let mcpToken = '';
let projectKey = '';

async function codeSearch(baseURL: string, args: Record<string, unknown>): Promise<string> {
  const client = new Client({ name: 'live-codegraph-lane', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/api/mcp', baseURL), {
      requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
    }),
  );
  try {
    const result = (await client.callTool({
      name: 'code_search',
      arguments: { projectKey, ...args },
    })) as CallToolResult;
    return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  } finally {
    await client.close();
  }
}

// ── the walk ─────────────────────────────────────────────────────────────────────

const state = {
  m1: '',
  m2: '',
  a1: '',
  a2: '',
  a3: '',
  b1: '',
  c1: '',
  c2: '',
  m2Layer: null as Layer | null,
};
const PR_A: PullRequest = {
  number: 1,
  state: 'open',
  merged: false,
  headRef: 'feature-a',
  baseRef: 'main',
  headRepoId: Number(REPO.providerRepoId),
};
const PR_B: PullRequest = { ...PR_A, number: 2, headRef: 'feature-b' };
const PR_C: PullRequest = { ...PR_A, number: 3, headRef: 'feature-c' };
const PR_FORK: PullRequest = {
  ...PR_A,
  number: 4,
  headRef: 'fork-feature',
  headRepoId: FORK_REPO_ID,
};

test.beforeAll(async () => {
  writeScenario(SCENARIO, {
    owner: REPO.owner,
    name: REPO.name,
    id: Number(REPO.providerRepoId),
    defaultBranch: REPO.defaultBranch,
    commits: {},
    refs: {},
    pulls: {},
    archiveOrigin: env('LIVE_ARCHIVE_ORIGIN'),
  });
  const stamp = Date.now();
  const person = await createTestPerson({
    email: `live-codegraph-${stamp}@example.test`,
    password: `live-codegraph-${stamp}`,
    name: 'Lane Planner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Live code graph',
    ownerUserId: person.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: person.id,
    name: 'Live code graph',
    identifier: 'LCG',
  });
  // The connected repository, through the function the App's setup flow calls.
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: REPO.owner,
      accountType: 'Organization',
    },
    repos: [{ ...REPO }],
  });
  const row = await adminDb.githubRepo.findFirstOrThrow({ where: { repoId: REPO.providerRepoId } });
  await linkProjectRepo({
    workspaceId: workspace.id,
    projectId: project.id,
    githubRepoId: row.id,
    name: row.name,
  });
  const cli = await apiTokensService.create(person.id, workspace.id, {
    label: 'CLI · live lane',
    fixedGrant: CLI_TOKEN_GRANT,
  });
  mcpToken = cli.token;
  projectKey = project.identifier;
});

test.afterAll(async () => {
  await cgDb.end();
  await aiDb.end();
  await adminDb.$disconnect();
});

test('recipe 1: a main push is handed off and indexed, and a search at main answers at its sha', async ({
  request,
}) => {
  state.m1 = commit('main', 'm1', undefined);
  const { result } = await deliver(request, 'push', pushPayload('main', state.m1, null), [
    REFRESH_JOB,
  ]);
  expect(result).toMatchObject({ outcome: 'refresh_enqueued' });
  await indexed(state.m1);
  const atMain = await search({ branch: 'main' });
  expect(atMain.status).toBe(200);
  expect(atMain.commit).toBe(state.m1);
});

test('recipe 2: the commit a second main push left answers inside the window, and not after a sweep past it', async ({
  request,
}) => {
  state.m2 = commit('main', 'm2');
  const { result } = await deliver(request, 'push', pushPayload('main', state.m2, state.m1), [
    REFRESH_JOB,
  ]);
  expect(result).toMatchObject({ outcome: 'refresh_enqueued' });
  state.m2Layer = await indexed(state.m2);

  // Inside the window: the left commit still answers as itself.
  const [left] = await rows<{ left_at: Date }>(
    `SELECT GREATEST(unheaded_at, default_left_at) AS left_at FROM codegraph.commit_layers
      WHERE repository_id = $1 AND commit_sha = $2 AND superseded_at IS NULL`,
    [(await codegraphScope()).repositoryId, state.m1],
  );
  expect(left?.left_at, 'main left m1').toBeTruthy();
  expect(Date.now() - left!.left_at.getTime()).toBeLessThan(DEFAULT_WINDOW_MS);
  await expectAnswersAsItself(state.m1);

  // A sweep that started past the window retires it.
  const pass = await sweepPassAfter(new Date(left!.left_at.getTime() + DEFAULT_WINDOW_MS));
  expect(pass['commitsRetired']).toBeGreaterThanOrEqual(1);
  const moved = await expectNoLongerItself(state.m1);
  expect(moved.status).toBe(200);
  expect(moved.moved).toEqual({ from: state.m1, to: state.m2, ref: 'main' });
  // No CURRENT layer for it; its layer stays, superseded, while main's head's chain names it.
  expect(await currentLayers(state.m1)).toEqual([]);
  const chains = await liveChains();
  for (const l of (await layers()).filter((x) => x.commit_sha === state.m1)) {
    expect(l.superseded_at).not.toBeNull();
    expect(chains.has(l.id), "m1's superseded layer is on main's head's chain").toBe(true);
  }
  await expectAnswersAsItself(state.m2);
});

test('recipe 3: a push to a branch with no pull request hands nothing off and leaves nothing in codegraph', async ({
  request,
}) => {
  const sha = commit('no-pr', 'nopr', state.m2);
  const jobsBefore = await indexJobIds();
  const { result } = await deliver(request, 'push', pushPayload('no-pr', sha, null));
  expect(result).toMatchObject({ outcome: 'ignored_ref' });
  expect(await indexJobIds()).toEqual(jobsBefore);
  expect(await refNames()).not.toContain('no-pr');
  expect((await layers()).filter((l) => l.commit_sha === sha)).toEqual([]);
});

test("recipe 4: pull requests A and B are indexed as deltas over main's indexed head", async ({
  request,
}) => {
  state.a1 = commit('feature-a', 'a1', state.m2);
  state.b1 = commit('feature-b', 'b1', state.m2);
  for (const [pr, head] of [
    [PR_A, state.a1],
    [PR_B, state.b1],
  ] as const) {
    setPull(pr);
    const { outputs } = await deliver(
      request,
      'pull_request',
      pullRequestPayload({ action: 'opened', pr, headSha: head }),
      [PR_HEAD_JOB, FORWARD_JOB],
    );
    expect(outputs[PR_HEAD_JOB]).toMatchObject({
      handed: true,
      pullRequestNumber: pr.number,
      commitSha: head,
      kind: 'push',
    });
    const layer = await indexed(head);
    expect(layer, `${pr.headRef}'s head is a delta over main's indexed head`).toMatchObject({
      kind: 'delta',
      parent_layer_id: state.m2Layer!.id,
    });
  }
  expect(await refNames()).toEqual(['feature-a', 'feature-b', 'main']);
});

test("recipe 5: a push to A indexes its new head and retires A's previous head at once", async ({
  request,
}) => {
  state.a2 = commit('feature-a', 'a2');
  const { outputs } = await deliver(
    request,
    'pull_request',
    pullRequestPayload({ action: 'synchronize', pr: PR_A, headSha: state.a2 }),
    [PR_HEAD_JOB],
  );
  expect(outputs[PR_HEAD_JOB]).toMatchObject({ handed: true, commitSha: state.a2 });
  await indexed(state.a2);
  // Right after the move — no window waited on.
  await expectNoLongerItself(state.a1);
  expect(await currentLayers(state.a1)).toEqual([]);
});

test("recipe 6: a cursor cut on A before a push pages through motir-core's MCP read at A's new head, with the moved line", async ({
  request,
  baseURL,
}) => {
  const first = await search({ branch: 'feature-a', pageSize: '1' });
  expect(first.status).toBe(200);
  expect(first.commit).toBe(state.a2);
  const cursor = first.body['nextCursor'] as string;
  expect(cursor, 'a page-1 cursor').toEqual(expect.any(String));

  state.a3 = commit('feature-a', 'a3');
  await deliver(
    request,
    'pull_request',
    pullRequestPayload({ action: 'synchronize', pr: PR_A, headSha: state.a3 }),
    [PR_HEAD_JOB],
  );
  await indexed(state.a3);

  const text = await codeSearch(baseURL!, { query: 'Only', repo: REPO_REF, cursor });
  expect(text).toContain(
    `The code moved: commit ${state.a2} is no longer kept, so this answers at ${state.a3}, the current head of feature-a, starting a fresh result.`,
  );
  // State ok: an answer, never the stale-cursor refusal.
  expect(text).not.toContain('The cursor is stale');
  expect(text).toMatch(/Only/);
});

test('recipe 7: A merged is retired once reported, without a window', async ({ request }) => {
  const merged: PullRequest = { ...PR_A, state: 'closed', merged: true };
  setPull(merged);
  const { outputs } = await deliver(
    request,
    'pull_request',
    pullRequestPayload({ action: 'closed', pr: merged, headSha: state.a3 }),
    [FORWARD_JOB],
  );
  expect(outputs[FORWARD_JOB]).toBeDefined();
  await expect
    .poll(refNames, { message: 'feature-a is retired on the merged report' })
    .not.toContain('feature-a');
  await expectNoLongerItself(state.a3);
  expect(await currentLayers(state.a3)).toEqual([]);
});

test('recipe 8: B closed unmerged is retired once reported', async ({ request }) => {
  const closed: PullRequest = { ...PR_B, state: 'closed', merged: false };
  setPull(closed);
  await deliver(
    request,
    'pull_request',
    pullRequestPayload({ action: 'closed', pr: closed, headSha: state.b1 }),
    [FORWARD_JOB],
  );
  await expect
    .poll(refNames, { message: 'feature-b is retired on the closed report' })
    .not.toContain('feature-b');
  await expectNoLongerItself(state.b1);
  expect(await currentLayers(state.b1)).toEqual([]);
});

test('recipe 9: pull request C idle past the window is retired while open, and its next push indexes it again', async ({
  request,
}) => {
  state.c1 = commit('feature-c', 'c1', state.m2);
  setPull(PR_C);
  await deliver(
    request,
    'pull_request',
    pullRequestPayload({ action: 'opened', pr: PR_C, headSha: state.c1 }),
    [PR_HEAD_JOB, FORWARD_JOB],
  );
  await indexed(state.c1);

  const [head] = await rows<{ last_pushed_at: Date }>(
    'SELECT last_pushed_at FROM codegraph.ref_heads WHERE repository_id = $1 AND ref_name = $2',
    [(await codegraphScope()).repositoryId, 'feature-c'],
  );
  expect(head, 'feature-c is held').toBeDefined();
  const pass = await sweepPassAfter(new Date(head!.last_pushed_at.getTime() + REF_WINDOW_MS));
  expect(pass['refsRetired']).toBeGreaterThanOrEqual(1);
  expect(await refNames()).not.toContain('feature-c');
  await expectNoLongerItself(state.c1);
  expect(await currentLayers(state.c1)).toEqual([]);
  // Still open: the pull request was never closed.
  expect(readScenario(SCENARIO).pulls['3']!.state).toBe('open');

  state.c2 = commit('feature-c', 'c2');
  await deliver(
    request,
    'pull_request',
    pullRequestPayload({ action: 'synchronize', pr: PR_C, headSha: state.c2 }),
    [PR_HEAD_JOB],
  );
  await indexed(state.c2);
  expect(await refNames()).toContain('feature-c');
});

test('recipe 10: a fork pull request hands nothing off and leaves nothing in codegraph', async ({
  request,
}) => {
  const sha = commit('fork-feature', 'fork', state.m2);
  const jobsBefore = await indexJobIds();
  const forwardsBefore = (await jobRows(FORWARD_JOB)).length;
  await deliver(
    request,
    'pull_request',
    pullRequestPayload({ action: 'opened', pr: PR_FORK, headSha: sha }),
  );
  expect(await indexJobIds()).toEqual(jobsBefore);
  expect((await jobRows(FORWARD_JOB)).length).toBe(forwardsBefore);
  expect(await refNames()).not.toContain('fork-feature');
  expect((await layers()).filter((l) => l.commit_sha === sha)).toEqual([]);
});

test("recipe 11: after the last sweep and its release, every layer left is on a live head's chain", async () => {
  await sweepPassAfter(await dbNow());
  await releasesSettled();

  expect(await refNames()).toEqual(['feature-c', 'main']);
  const chains = await liveChains();
  const all = await layers();
  for (const l of all)
    expect(chains.has(l.id), `the layer of ${l.commit_sha} is on a live head's chain`).toBe(true);
  // One current layer per live head: main's head and one delta per open pull request.
  const current = all.filter((l) => l.superseded_at === null);
  expect(new Set(current.map((l) => l.commit_sha))).toEqual(new Set([state.m2, state.c2]));
  expect(current.find((l) => l.commit_sha === state.c2)).toMatchObject({ kind: 'delta' });
  // No current layer for a main commit left more than the window ago.
  const leftLongAgo = await rows<{ commit_sha: string }>(
    `SELECT commit_sha FROM codegraph.commit_layers
      WHERE repository_id = $1 AND superseded_at IS NULL AND default_left_at IS NOT NULL
        AND default_left_at < now() - ($2::bigint * interval '1 millisecond')`,
    [(await codegraphScope()).repositoryId, DEFAULT_WINDOW_MS],
  );
  expect(leftLongAgo).toEqual([]);
  expect(current.map((l) => l.commit_sha)).not.toContain(state.m1);
});

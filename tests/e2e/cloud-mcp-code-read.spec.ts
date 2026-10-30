import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { createTestPerson } from './_helpers/testPerson';
import { seedGithubInstallation } from './_helpers/github-seed';
import { E2E_PROVISIONING_ORG } from './_helpers/github-const';
import { adminDb } from '@/tests/helpers/adminDb';
import { linkProjectRepo } from '@/tests/helpers/projectRepoLink';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { projectsService } from '@/lib/services/projectsService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  e2eRefSha,
  type GithubMergeCall,
  type GithubMergeControl,
} from '@/lib/test-github-merge-mock';
import type {
  CodeGraphReadFixture,
  CodeGraphReadJournalLine,
} from '@/lib/test-code-graph-read-mock';

// A PLANNING AGENT READS CODE OVER THE MCP — Story MOTIR-7858's journey (Subtask
// MOTIR-7866), as a regression spec in the CLOUD-ON lane.
//
// The agent is the real MCP SDK `Client` over `StreamableHTTPClientTransport`
// against the real `/api/mcp` route of the separately spawned server, holding a
// token stored with `CLI_TOKEN_GRANT` IMPORTED from the app — the grant
// `motir login` mints — so if that constant ever loses `ai:plan`, this spec goes
// red rather than a hand-built grant hiding it.
//
// ── WHY THIS LANE ──────────────────────────────────────────────────────────
// The main lane sets no `MOTIR_AI_URL`, so `code_explore` would have no motir-ai
// to call, and turning it cloud-on breaks the specs that assert the OFF posture.
// The story has no user-observable surface, so it owes no receipt and does not
// belong in the acceptance lane either.
//
// ── THE TWO SEAMS (both inside the server process) ─────────────────────────
//   * motir-ai's `POST /v1/code-graph/read` — lib/test-code-graph-read-mock.ts,
//     answered from a FIXTURE this spec writes, every request JOURNALLED;
//   * GitHub's contents API — lib/test-github-merge-mock.ts, whose contents key
//     is REF-qualified (`owner/name@ref:path`) so a default-branch read and a
//     branch read return different text, journalled with the query they sent.
// The installation-token mint is the repos seam's, with the Studio App the lane
// carries — which is why the repositories belong to the provisioning org.
//
// ── THE WAITS ──────────────────────────────────────────────────────────────
// Every step awaits its own `client.callTool` result; the journals are read only
// after that result has come back. There is no fixed wait.

const PASSWORD = 'mcp-code-read-e2e-pass-7866';
const EMAIL = 'mcp-code-read@example.com';
const OWNER = E2E_PROVISIONING_ORG;

const CORE = {
  providerRepoId: '78660001',
  owner: OWNER,
  name: 'core',
  defaultBranch: 'main',
  archived: false,
} as const;
const UNINDEXED = {
  providerRepoId: '78660002',
  owner: OWNER,
  name: 'unindexed',
  defaultBranch: 'main',
  archived: false,
} as const;
const CORE_REF = `${OWNER}/core`;
const UNINDEXED_REF = `${OWNER}/unindexed`;
const SET = [CORE_REF, UNINDEXED_REF];

// The service token `playwright.cloud.config.ts` hands the server (webServer.env
// MOTIR_AI_SERVICE_TOKEN). The runner does not see that env, so it is restated.
const LANE_SERVICE_TOKEN = 'e2e-billing-placeholder-token';

const MAIN_TEXT = 'export const hello = "MAIN TEXT";\n';
const BRANCH_TEXT = 'export const hello = "BRANCH TEXT";\n';

const PAGE_1 =
  '3 symbols (page 1 of 2):\n[1] readFile · function · src/hello.ts:1\n' +
  '— page 1 of 2 · next: cursor: "c-2"';
const PAGE_2 = '3 symbols (page 2 of 2):\n[3] readFileAtRef · function · src/read.ts:9';

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — run this spec in playwright.cloud.config.ts`);
  return value;
};
const GRAPH_FIXTURE = () => env('MOTIR_AI_CODE_GRAPH_READ_FIXTURE_PATH');
const GRAPH_JOURNAL = () => env('MOTIR_AI_CODE_GRAPH_READ_JOURNAL_PATH');
const MERGE_CONTROL = () => env('MOTIR_GITHUB_MERGE_CONTROL_PATH');
const MERGE_JOURNAL = () => env('MOTIR_GITHUB_MERGE_JOURNAL_PATH');

function readJsonl<T>(path: string): T[] {
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

const contentsReads = () =>
  readJsonl<GithubMergeCall>(MERGE_JOURNAL()).filter(
    (c) => c.method === 'GET' && c.path.includes('/contents/'),
  );
const graphReads = () => readJsonl<CodeGraphReadJournalLine>(GRAPH_JOURNAL());

interface Seed {
  token: string;
  projectKey: string;
  projectId: string;
  workspaceId: string;
}

async function seed(): Promise<Seed> {
  const person = await createTestPerson({ email: EMAIL, password: PASSWORD, name: 'Pia Planner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Code read E2E',
    ownerUserId: person.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: person.id,
    name: 'Code read',
    identifier: 'CRD',
  });
  await seedGithubInstallation(workspace.id, [CORE, UNINDEXED]);
  // Only these two are the project's set, in this order — sequentially, because
  // concurrent appends race on the position key.
  for (const repo of [CORE, UNINDEXED]) {
    const row = await adminDb.githubRepo.findFirstOrThrow({
      where: { repoId: repo.providerRepoId },
    });
    await linkProjectRepo({
      workspaceId: workspace.id,
      projectId: project.id,
      githubRepoId: row.id,
      name: row.name,
    });
  }
  // `core` is indexed at its head; `unindexed` never was.
  await adminDb.githubRepo.updateMany({
    where: { repoId: CORE.providerRepoId },
    data: { indexedHeadSha: 'a'.repeat(40), defaultBranchHeadSha: 'a'.repeat(40) },
  });
  // Exactly what `motir login` stores (`cliDeviceService`'s `fixedGrant`).
  const cli = await apiTokensService.create(person.id, workspace.id, {
    label: 'CLI · planner',
    fixedGrant: CLI_TOKEN_GRANT,
  });
  return {
    token: cli.token,
    projectKey: project.identifier,
    projectId: project.id,
    workspaceId: workspace.id,
  };
}

async function agent(token: string, baseURL: string | undefined): Promise<Client> {
  if (!baseURL) throw new Error('no Playwright baseURL — the MCP transport has nowhere to go');
  const client = new Client({ name: 'cloud-mcp-code-read', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/api/mcp', baseURL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: CallToolResult; text: string; data: Record<string, unknown> }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = (result.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  expect(result.isError ?? false, text.slice(0, 400)).toBe(false);
  return { result, text, data: (result.structuredContent ?? {}) as Record<string, unknown> };
}

let s: Seed;
let client: Client;

test.beforeEach(async ({ baseURL }) => {
  await resetDatabase();
  const control: GithubMergeControl = {
    repositories: SET,
    fileContents: {
      [`${CORE_REF}@main:src/hello.ts`]: MAIN_TEXT,
      [`${CORE_REF}@feature/x:src/hello.ts`]: BRANCH_TEXT,
    },
  };
  writeFileSync(MERGE_CONTROL(), JSON.stringify(control));
  const fixture: CodeGraphReadFixture = [
    {
      match: { tool: 'code_explore', repos: [CORE_REF], cursor: null },
      answer: { state: 'ok', text: PAGE_1 },
    },
    {
      match: { tool: 'code_explore', repos: [CORE_REF], cursor: 'c-2' },
      answer: { state: 'ok', text: PAGE_2 },
    },
    {
      match: { tool: 'code_explore', repos: [UNINDEXED_REF] },
      answer: { state: 'not_indexed', repoRef: UNINDEXED_REF },
    },
  ];
  writeFileSync(GRAPH_FIXTURE(), JSON.stringify(fixture));
  rmSync(MERGE_JOURNAL(), { force: true });
  rmSync(GRAPH_JOURNAL(), { force: true });
  s = await seed();
  client = await agent(s.token, baseURL);
});

test.afterEach(async () => {
  await client?.close();
});

test('a planning agent lists the code-read tools and reads a file at the default branch and at a branch', async () => {
  await test.step('tools/list names read_file, code_explore and code_search, each read-only', async () => {
    const { tools } = await client.listTools();
    for (const name of ['read_file', 'code_explore', 'code_search']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `${name} is not listed for a planning token`).toBeTruthy();
      expect(tool!.annotations?.readOnlyHint).toBe(true);
    }
  });

  await test.step('no ref reads the repository row’s default branch', async () => {
    const { text, data } = await call(client, 'read_file', {
      projectKey: s.projectKey,
      repo: 'core',
      path: 'src/hello.ts',
    });
    expect(data['outcome']).toBe('found');
    expect(data['ref']).toBe('main');
    // The ref is resolved to a commit and the read is made AT it (MOTIR-10122).
    const mainSha = e2eRefSha(CORE_REF, 'main');
    expect(data['commitSha']).toBe(mainSha);
    expect(text).toContain('MAIN TEXT');
    expect(text).toContain(`main (commit ${mainSha})`);
    const reads = contentsReads();
    expect(reads).toHaveLength(1);
    expect(reads[0]!.path).toBe(`/repos/${CORE_REF}/contents/src/hello.ts?ref=${mainSha}`);
  });

  await test.step('a branch ref reads that branch’s text, and the ref reaches the host', async () => {
    const { text, data } = await call(client, 'read_file', {
      projectKey: s.projectKey,
      repo: 'core',
      path: 'src/hello.ts',
      ref: 'feature/x',
    });
    const branchSha = e2eRefSha(CORE_REF, 'feature/x');
    expect(data).toMatchObject({ outcome: 'found', ref: 'feature/x', commitSha: branchSha });
    expect(text).toContain('BRANCH TEXT');
    expect(text).not.toContain('MAIN TEXT');
    const reads = contentsReads();
    expect(reads).toHaveLength(2);
    expect(reads[1]!.path).toBe(`/repos/${CORE_REF}/contents/src/hello.ts?ref=${branchSha}`);
  });

  await test.step('a missing file is the named not_found, not an error', async () => {
    const { text, data } = await call(client, 'read_file', {
      projectKey: s.projectKey,
      repo: 'core',
      path: 'src/absent.ts',
    });
    expect(data['outcome']).toBe('not_found');
    expect(text).toContain('src/absent.ts');
  });
});

test('a planning agent pages code_explore through the graph-read route and reads an unindexed repo as a named state', async () => {
  await test.step('page 1 comes back byte-equal to the route’s text', async () => {
    const { text, data } = await call(client, 'code_explore', {
      projectKey: s.projectKey,
      repo: 'core',
      query: 'readFile',
    });
    expect(data['state']).toBe('ok');
    expect(text).toBe(PAGE_1);
  });

  await test.step('its cursor reads page 2, byte-equal', async () => {
    const { text } = await call(client, 'code_explore', {
      projectKey: s.projectKey,
      repo: 'core',
      query: 'readFile',
      cursor: 'c-2',
    });
    expect(text).toBe(PAGE_2);

    const reads = graphReads();
    expect(reads).toHaveLength(2);
    for (const [i, read] of reads.entries()) {
      expect(read.body.tool).toBe('code_explore');
      expect(read.body.coreProjectId).toBe(s.projectId);
      expect(read.body.coreWorkspaceId).toBe(s.workspaceId);
      expect(read.body.repoRefs).toEqual(SET);
      expect(read.body.args.repos).toEqual([CORE_REF]);
      expect(read.body.args.query).toBe('readFile');
      if (i === 0) expect(read.body.args).not.toHaveProperty('cursor');
      else expect(read.body.args.cursor).toBe('c-2');
    }
  });

  await test.step('an unindexed repository is not_indexed, enriched from core', async () => {
    const { text, data } = await call(client, 'code_explore', {
      projectKey: s.projectKey,
      repo: 'unindexed',
      query: 'readFile',
    });
    expect(data).toMatchObject({ state: 'not_indexed', repoRef: UNINDEXED_REF });
    for (const field of ['indexState', 'commitsBehind', 'refreshFailing']) {
      expect(data).toHaveProperty(field);
    }
    expect(text).toContain(UNINDEXED_REF);
  });

  await test.step('no credential crossed: only the service bearer and five body keys', async () => {
    const reads = graphReads();
    expect(reads).toHaveLength(3);
    for (const read of reads) {
      expect(read.authorization).toBe(`Bearer ${LANE_SERVICE_TOKEN}`);
      expect(Object.keys(read.body).sort()).toEqual(
        ['args', 'coreProjectId', 'coreWorkspaceId', 'repoRefs', 'tool'].sort(),
      );
    }
  });
});

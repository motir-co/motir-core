import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { CLI_TOKEN_GRANT, TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { TOOL_ANNOTATIONS } from '@/lib/mcp/toolAnnotations';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { mcpCatalogue } from '@/lib/apiDocs/mcp';
import { projectRepositorySchema } from '@/lib/api/v1/projects/repositories';
import { createProjectRepositoryPayload } from '@/lib/mcp/payloads/projectRepositories';
import {
  CREATE_PROJECT_REPOSITORY_TOOL_NAME,
  runCreateProjectRepository,
} from '@/lib/mcp/tools/createProjectRepository';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectRepoProvisioningService } from '@/lib/services/projectRepoProvisioningService';
import {
  _resetProvisioningInstallationCache,
  _setReadinessPollForTests,
} from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import {
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_PLATFORM_STARTER,
} from '@/lib/projectRepos/vocabulary';
import {
  AiPlanRequiredError,
  AiPlanUnknownError,
  ProjectRepoInvalidFieldError,
  ProjectRepoLinkConflictError,
  ProjectRepoNameTakenError,
  ProjectRepoSeedRefusedError,
  ProjectRepoStateTransitionError,
  RealizedRepoAlreadyClaimedError,
} from '@/lib/projectRepos/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { TokenGrant } from '@/lib/tokens/grant';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { ORIGINAL_SEED_KEYS, withOnlyOriginalSeeds } from '../helpers/seedRegistryShipped';
import { truncateAuthTables } from '../helpers/db';
import { createRunnerGroupFake, type RunnerGroupFake } from '../helpers/runnerGroupFake';
import {
  createActionsVariableFake,
  type ActionsVariableFake,
} from '../helpers/actionsVariableFake';
import {
  createRepositoryActionsConfigFake,
  type RepositoryActionsConfigFake,
} from '../helpers/repositoryActionsConfigFake';
import { spyOnJobDispatch } from '../helpers/jobs';

// `create_project_repository` over real Postgres (Story MOTIR-10162 · MOTIR-11038).
//
// Driven through the TOOL ADAPTER, so the adapter and the creation service are
// exercised together, and — for the permission criteria — through the MCP
// dispatch seam with a real grant. The only fake is `fetch`, the GitHub HTTP
// boundary, in the shape `tests/projectRepos/projectRepoProvisioningService.test.ts`
// sets.

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '556677';

let existingRepos: Map<string, number>;
let generateCalls: number;
let nextRepoId: number;
let runnerGroups: RunnerGroupFake;
let actionsVariables: ActionsVariableFake;
let repoActions: RepositoryActionsConfigFake;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installGitHub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      if (u.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
        return json(200, { id: Number(INSTALLATION_ID) });
      }
      if (u.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      const group = await runnerGroups.handle(u, method, body);
      if (group) return group;
      const variable = actionsVariables.handle(u, method, body);
      if (variable) return variable;
      const repoConfig = await repoActions.handle(
        u,
        method,
        typeof init?.body === 'string' ? init.body : null,
      );
      if (repoConfig) return repoConfig;
      if (
        method === 'POST' &&
        (u.includes('/generate') || u.endsWith(`/orgs/${MOTIR_ORG}/repos`))
      ) {
        if (u.includes('/generate')) generateCalls++;
        const name = String(body?.['name']);
        if (existingRepos.has(name)) {
          return json(422, {
            message: 'Repository creation failed.',
            errors: [
              {
                resource: 'Repository',
                field: 'name',
                message: 'name already exists on this account',
              },
            ],
            status: '422',
          });
        }
        const id = nextRepoId++;
        existingRepos.set(name, id);
        return json(201, { id, name, owner: { login: MOTIR_ORG } });
      }
      const branch = /\/repos\/[^/]+\/([^/]+)\/branches\/[^/]+$/.exec(u);
      if (method === 'GET' && branch) {
        const name = branch[1]!;
        if (!existingRepos.has(name)) return json(404, { message: 'Branch not found' });
        return json(200, { name: 'main', commit: { sha: `seed-${name}` } });
      }
      if (method === 'GET' && u.includes(`/repos/${MOTIR_ORG}/`)) {
        const name = u.split('/').pop()!;
        const id = existingRepos.get(name);
        if (!id) return json(404, { message: 'Not Found' });
        return json(200, { id, name, owner: { login: MOTIR_ORG }, default_branch: 'main' });
      }
      if (method === 'PUT') return json(201, { content: {} });
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }),
  );
}

beforeEach(async () => {
  await truncateAuthTables();
  existingRepos = new Map();
  generateCalls = 0;
  nextRepoId = 700_001;
  actionsVariables = createActionsVariableFake(MOTIR_ORG);
  repoActions = createRepositoryActionsConfigFake();
  runnerGroups = createRunnerGroupFake(MOTIR_ORG);
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  _setReadinessPollForTests({ attempts: 2, delayMs: 0 });
  installGitHub();
  spyOnJobDispatch();
});

withOnlyOriginalSeeds();

afterEach(async () => {
  await adminDb.seedRegistryEntry.deleteMany({ where: { key: { notIn: ORIGINAL_SEED_KEYS } } });
  await adminDb.seedRegistryEntry.updateMany({ data: { status: 'active' } });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _setReadinessPollForTests(null);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Structured = {
  outcome: string;
  repository: { id: string; name: string | null; role: string; seedSource: string; state: string };
  establish: { outcome: string; failureCode: string | null; failureReason: string | null };
};

function structured(result: CallToolResult): Structured {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as unknown as Structured;
}

function errorCode(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  const text = (result.content[0] as { text: string }).text;
  return text.slice(0, text.indexOf(':'));
}

function textOf(result: CallToolResult): string {
  return JSON.stringify(result.content);
}

function call(
  fx: WorkItemFixture,
  args: { name: string; role: 'web' | 'api' | 'infra' | 'other'; starterKey?: string },
  projectKey = fx.projectIdentifier,
): Promise<CallToolResult> {
  return runCreateProjectRepository({ projectKey, ...args }, fx.ctx);
}

async function rowSnapshot(rowId: string) {
  const row = await adminDb.projectRepo.findUniqueOrThrow({ where: { id: rowId } });
  return {
    state: row.state,
    role: row.role,
    seedSource: row.seedSource,
    name: row.name,
    githubRepoId: row.githubRepoId,
    updatedAt: row.updatedAt,
  };
}

describe('registration', () => {
  it('joins every registry a tool must join', () => {
    expect(MCP_TOOL_NAMES).toContain(CREATE_PROJECT_REPOSITORY_TOOL_NAME);
    expect(TOOL_PERMISSIONS.create_project_repository).toBe('repository:manage');
    expect(TOOL_ANNOTATIONS.create_project_repository).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
    const group = mcpCatalogue().find((g) => g.permission === 'repository:manage');
    expect(group?.tools.map((t) => t.name)).toEqual([CREATE_PROJECT_REPOSITORY_TOOL_NAME]);
    expect(group?.tools[0]?.summary).toBeTruthy();
  });

  it('lists a title within the cap and a description naming the outcomes and refusals', async () => {
    const client = await connect(
      { userId: 'x', workspaceId: 'x' } as ServiceContext,
      CLI_TOKEN_GRANT,
    );
    const { tools } = await client.listTools();
    await client.close();
    const tool = tools.find((t) => t.name === CREATE_PROJECT_REPOSITORY_TOOL_NAME)!;
    expect(tool.title!.length).toBeLessThanOrEqual(40);
    for (const word of [
      'created',
      'adopted',
      'already_settled',
      'REPLAY-SAFE',
      'REPO_EXISTS_WITH_OTHER_SPEC',
      'REPO_ESTABLISH_BUSY',
      'REPO_NAME_TAKEN_ON_HOST',
      'ai_plan_required',
    ]) {
      expect(tool.description).toContain(word);
    }
    expect(tool.description).toContain('#tool-create_project_repository');
  });
});

async function connect(ctx: ServiceContext, grant: TokenGrant): Promise<Client> {
  const server = buildMcpServer(
    () => ctx,
    () => [...grant],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('the CLI grant reaches the handler', () => {
  it('holds repository:manage exactly once, in catalog order', () => {
    expect(CLI_TOKEN_GRANT.filter((k) => k === 'repository:manage')).toHaveLength(1);
    const at = CLI_TOKEN_GRANT.indexOf('repository:manage');
    expect(CLI_TOKEN_GRANT[at - 1]).toBe('page:edit');
    expect(CLI_TOKEN_GRANT[at + 1]).toBe('ai:plan');
  });

  it('dispatches with EXACTLY the CLI grant, and refuses before the handler without the key', async () => {
    const fx = await makeWorkItemFixture();
    const args = { projectKey: fx.projectIdentifier, name: 'acme-infra', role: 'infra' };

    const narrowed = await connect(
      fx.ctx,
      CLI_TOKEN_GRANT.filter((k) => k !== 'repository:manage'),
    );
    const denied = (await narrowed.callTool({
      name: CREATE_PROJECT_REPOSITORY_TOOL_NAME,
      arguments: args,
    })) as CallToolResult;
    await narrowed.close();
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(await adminDb.projectRepo.count()).toBe(0);

    const client = await connect(fx.ctx, CLI_TOKEN_GRANT);
    const ok = (await client.callTool({
      name: CREATE_PROJECT_REPOSITORY_TOOL_NAME,
      arguments: args,
    })) as CallToolResult;
    await client.close();
    expect(structured(ok).outcome).toBe('created');
    expect(await adminDb.projectRepo.count()).toBe(1);
  });
});

describe('outcomes', () => {
  it('creates a row from an ACTIVE starter and settles it', async () => {
    const fx = await makeWorkItemFixture();
    const answer = structured(
      await call(fx, { name: 'acme-web', role: 'web', starterKey: SEED_SOURCE_PLATFORM_STARTER }),
    );

    expect(answer.outcome).toBe('created');
    expect(answer.repository).toMatchObject({
      name: 'acme-web',
      role: 'web',
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: 'created',
    });
    expect(answer.establish).toEqual({
      outcome: 'created',
      failureCode: null,
      failureReason: null,
    });
    const rows = await adminDb.projectRepo.findMany({ where: { projectId: fx.projectId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.githubRepoId).not.toBeNull();
    expect(generateCalls).toBe(1);
    const listed = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(listed.map((r) => r.id)).toEqual([answer.repository.id]);
  });

  it('answers a repository that IS v1’s ProjectRepository, through the payload’s probe', async () => {
    const fx = await makeWorkItemFixture();
    const answer = structured(await call(fx, { name: 'acme-infra', role: 'infra' }));
    const [probe] = createProjectRepositoryPayload.probes;
    expect(probe!.resource).toBe('ProjectRepository');
    const parts = probe!.select(answer as never);
    expect(parts).toHaveLength(1);
    expect(projectRepositorySchema.safeParse(parts[0]).success).toBe(true);
    expect(answer.repository).toMatchObject({ name: 'acme-infra', established: true });
  });

  it('an omitted starter is an EMPTY base, never the role default', async () => {
    const fx = await makeWorkItemFixture();
    // `web` defaults to the platform starter — a defaulted call fails here.
    const answer = structured(await call(fx, { name: 'acme-web', role: 'web' }));
    expect(answer.repository.seedSource).toBe(SEED_SOURCE_INITIALISED);
    const row = await adminDb.projectRepo.findFirstOrThrow({ where: { projectId: fx.projectId } });
    expect(row.seedSource).toBe(SEED_SOURCE_INITIALISED);
    expect(generateCalls).toBe(0);
  });

  it('a replay writes nothing and answers already_settled', async () => {
    const fx = await makeWorkItemFixture();
    const first = structured(await call(fx, { name: 'acme-infra', role: 'infra' }));
    const repoCount = await adminDb.githubRepo.count();
    const before = await rowSnapshot(first.repository.id);

    const again = structured(await call(fx, { name: 'acme-infra', role: 'infra' }));
    expect(again.outcome).toBe('already_settled');
    expect(again.repository.id).toBe(first.repository.id);
    expect(await adminDb.projectRepo.count()).toBe(1);
    expect(await adminDb.githubRepo.count()).toBe(repoCount);
    expect(existingRepos.size).toBe(1);
    expect(await rowSnapshot(first.repository.id)).toEqual(before);
  });

  it('matches the existing row case-insensitively', async () => {
    const fx = await makeWorkItemFixture();
    const first = structured(await call(fx, { name: 'acme-infra', role: 'infra' }));
    const again = structured(await call(fx, { name: 'ACME-Infra', role: 'infra' }));
    expect(again.outcome).toBe('already_settled');
    expect(again.repository.id).toBe(first.repository.id);
  });

  it.each(['proposed', 'failed'] as const)(
    'adopts a %s row with the same base and role, without a second row',
    async (state) => {
      const fx = await makeWorkItemFixture();
      const row = await projectRepoSetService.addRow(
        fx.projectId,
        { name: 'acme-api', role: 'api', seedSource: SEED_SOURCE_INITIALISED },
        fx.ctx,
      );
      if (state === 'failed') {
        await adminDb.projectRepo.update({
          where: { id: row.id },
          data: { state: 'failed', failureReason: 'earlier' },
        });
      }

      const answer = structured(await call(fx, { name: 'acme-api', role: 'api' }));
      expect(answer.outcome).toBe('adopted');
      expect(answer.repository.id).toBe(row.id);
      expect(answer.repository.state).toBe('created');
      expect(await adminDb.projectRepo.count()).toBe(1);
    },
  );

  it.each(['created', 'connected', 'skipped'] as const)(
    'a %s row answers already_settled and is left byte-identical',
    async (state) => {
      const fx = await makeWorkItemFixture();
      const row = await projectRepoSetService.addRow(
        fx.projectId,
        { name: 'acme-api', role: 'api', seedSource: SEED_SOURCE_INITIALISED },
        fx.ctx,
      );
      await adminDb.projectRepo.update({ where: { id: row.id }, data: { state } });
      const before = await rowSnapshot(row.id);

      const answer = structured(await call(fx, { name: 'acme-api', role: 'api' }));
      expect(answer.outcome).toBe('already_settled');
      expect(answer.establish.outcome).toBe('already_settled');
      expect(await rowSnapshot(row.id)).toEqual(before);
      expect(existingRepos.size).toBe(0);
    },
  );
});

describe('refusals', () => {
  it.each([
    ['seedSource', { name: 'acme-web', role: 'web' as const }],
    [
      'role',
      { name: 'acme-web', role: 'other' as const, starterKey: SEED_SOURCE_PLATFORM_STARTER },
    ],
  ])('a row with a different %s is refused and untouched', async (field, args) => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { name: 'acme-web', role: 'web', seedSource: SEED_SOURCE_PLATFORM_STARTER },
      fx.ctx,
    );
    const before = await rowSnapshot(row.id);

    const result = await call(fx, args);
    expect(errorCode(result)).toBe('REPO_EXISTS_WITH_OTHER_SPEC');
    expect(textOf(result)).toContain(field);
    if (field === 'seedSource') {
      expect(textOf(result)).toContain(SEED_SOURCE_PLATFORM_STARTER);
      expect(textOf(result)).toContain(SEED_SOURCE_INITIALISED);
    } else {
      expect(textOf(result)).toContain('web');
      expect(textOf(result)).toContain('other');
    }
    expect(await rowSnapshot(row.id)).toEqual(before);
    expect(await adminDb.projectRepo.count()).toBe(1);
  });

  it('a creating row is busy and nothing is written', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { name: 'acme-api', role: 'api', seedSource: SEED_SOURCE_INITIALISED },
      fx.ctx,
    );
    await projectRepoSetService.markCreating(row.id, fx.ctx);
    const before = await rowSnapshot(row.id);

    expect(errorCode(await call(fx, { name: 'acme-api', role: 'api' }))).toBe(
      'REPO_ESTABLISH_BUSY',
    );
    expect(await rowSnapshot(row.id)).toEqual(before);
    expect(existingRepos.size).toBe(0);
  });

  it('a lost claim (not_attempted) is busy too', async () => {
    const fx = await makeWorkItemFixture();
    vi.spyOn(projectRepoProvisioningService, 'establishSet').mockImplementation(
      async (projectId, _ctx, options) => ({
        projectId,
        rows: [{ rowId: options!.rowId!, name: 'acme-api', outcome: 'not_attempted', row: null }],
      }),
    );
    expect(errorCode(await call(fx, { name: 'acme-api', role: 'api' }))).toBe(
      'REPO_ESTABLISH_BUSY',
    );
  });

  it('a failed row with no recorded code still answers a readable, resumable failure', async () => {
    const fx = await makeWorkItemFixture();
    vi.spyOn(projectRepoProvisioningService, 'establishSet').mockImplementation(
      async (projectId, _ctx, options) => ({
        projectId,
        rows: [{ rowId: options!.rowId!, name: 'acme-api', outcome: 'failed', row: null }],
      }),
    );
    const result = await call(fx, { name: 'acme-api', role: 'api' });
    expect(errorCode(result)).toBe('REPO_ESTABLISH_FAILED');
    expect(textOf(result)).toContain('resumable');
  });

  it('a host name collision is the row’s own failure, left failed and resumable', async () => {
    // Another tenant holds `acme-api` on the host already.
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    structured(await call(other, { name: 'acme-api', role: 'api' }));

    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACM' });
    const result = await call(fx, { name: 'acme-api', role: 'api' });
    expect(errorCode(result)).toBe('REPO_NAME_TAKEN_ON_HOST');
    expect(textOf(result)).toContain('acme-api');
    const row = await adminDb.projectRepo.findFirstOrThrow({ where: { projectId: fx.projectId } });
    expect(row.state).toBe('failed');

    // A repeat re-attempts THAT row rather than appending another.
    const establish = vi.spyOn(projectRepoProvisioningService, 'establishSet');
    expect(errorCode(await call(fx, { name: 'acme-api', role: 'api' }))).toBe(
      'REPO_NAME_TAKEN_ON_HOST',
    );
    expect(establish).toHaveBeenCalledWith(fx.projectId, fx.ctx, { rowId: row.id });
    expect(await adminDb.projectRepo.count({ where: { projectId: fx.projectId } })).toBe(1);
  });

  it('an unknown project key, and another workspace’s, are not-found and write no row', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    expect(errorCode(await call(fx, { name: 'x', role: 'api' }, 'NOPE'))).toBe('PROJECT_NOT_FOUND');
    expect(errorCode(await call(fx, { name: 'x', role: 'api' }, other.projectIdentifier))).toBe(
      'PROJECT_NOT_FOUND',
    );
    expect(await adminDb.projectRepo.count()).toBe(0);
  });

  it.each([
    ['PROJECT_REPO_NAME_TAKEN', () => new ProjectRepoNameTakenError('acme', 'p')],
    ['PROJECT_REPO_INVALID_FIELD', () => new ProjectRepoInvalidFieldError('name', 'bad')],
    ['PROJECT_REPO_LINK_CONFLICT', () => new ProjectRepoLinkConflictError('p', 'acme', null)],
    [
      'PROJECT_REPO_ILLEGAL_TRANSITION',
      () => new ProjectRepoStateTransitionError('r', 'created', 'creating', []),
    ],
    [
      'PROJECT_REPO_SEED_REFUSED',
      () => new ProjectRepoSeedRefusedError('unknown', 'nope', 'no such starter'),
    ],
    ['REALIZED_REPO_ALREADY_CLAIMED', () => new RealizedRepoAlreadyClaimedError('g')],
    ['ai_plan_required', () => new AiPlanRequiredError('needs a plan')],
    ['plan_unknown', () => new AiPlanUnknownError('plan unreadable')],
  ])('%s reaches the caller with its own code', async (code, make) => {
    const fx = await makeWorkItemFixture();
    vi.spyOn(projectRepoSetService, 'addRow').mockRejectedValue(make());
    expect(errorCode(await call(fx, { name: 'acme-api', role: 'api' }))).toBe(code);
  });
});

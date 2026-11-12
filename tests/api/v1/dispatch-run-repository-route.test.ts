import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  // The establish pass's design-choice read never fails a run; with no motir-ai here it
  // reads as "no choice", which is what this suite wants.
  getPreplanState: vi.fn(async () => {
    throw new Error('no motir-ai in this suite');
  }),
}));

import { classifyApiV1Error } from '@/lib/api/v1/errors';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { dispatchRunRepositorySchema } from '@/lib/api/v1/workLoop/dispatchRunRepository';
import { db } from '@/lib/db';
import {
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_PLATFORM_STARTER,
} from '@/lib/projectRepos/vocabulary';
import { repoProvisioningClient, type ProvisionedRepo } from '@/lib/github/repoProvisioning';
import { HOSTED_RUN_TOKEN_GRANT, TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { aiPlanGateService } from '@/lib/services/aiPlanGateService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { fleetGithubOrgAssignmentService } from '@/lib/services/fleetGithubOrgAssignmentService';
import { fleetRunnerVariableService } from '@/lib/services/fleetRunnerVariableService';
import { previewEnablementService } from '@/lib/services/previewEnablementService';
import { productionEnablementService } from '@/lib/services/productionEnablementService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectRunnerGroupService } from '@/lib/services/projectRunnerGroupService';
import { runCredentialService } from '@/lib/services/runCredentialService';
import {
  RunCardNotInitCardError,
  RunRepositoryNameMismatchError,
  runRepositoryCreationService,
} from '@/lib/services/runRepositoryCreationService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { bearer, createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';

// Story MOTIR-10162 · Subtask MOTIR-11055 — `POST /api/v1/dispatch-runs/{id}/repository`,
// the run's own repository door, driven end to end through `withV1Route` with a run
// credential minted by the shipped mint path, against real Postgres.
//
// Real route, binding, run read, card read, creation sequence, set service and establish
// pass. Only the boundaries that leave the process are stubbed: the git host's create call
// (`repoProvisioningClient.provisionRepository` — "the lane's fake host"), the paid-plan
// read, the hosted-org assignment and the quiet fleet / preview / production passes.

/** What a device-minted token and a PAT carry for this door: the keys it asserts. */
const KEYED: PermissionKey[] = ['project:browse', 'work_item:edit', 'repository:manage'];

let caller: V1ProjectCaller;
let provision: ReturnType<typeof vi.spyOn>;
let nextProviderId = 810_000;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  resetRateLimitStore();
  caller = await createV1ProjectCaller({ permissions: KEYED });
  vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValue(true);
  vi.spyOn(fleetGithubOrgAssignmentService, 'ensureHostedGithubOrg').mockResolvedValue({
    outcome: 'unconfigured',
  } as never);
  vi.spyOn(fleetGithubOrgAssignmentService, 'readHostedGithubOrg').mockResolvedValue(null);
  vi.spyOn(projectRunnerGroupService, 'syncQuietly').mockResolvedValue(undefined as never);
  vi.spyOn(fleetRunnerVariableService, 'ensureQuietly').mockResolvedValue(undefined as never);
  vi.spyOn(previewEnablementService, 'enableQuietly').mockResolvedValue(undefined as never);
  vi.spyOn(productionEnablementService, 'enableQuietly').mockResolvedValue(undefined as never);
  provision = vi.spyOn(repoProvisioningClient, 'provisionRepository').mockImplementation(
    async (input: { name: string }): Promise<ProvisionedRepo> =>
      ({
        installationId: '551100',
        providerRepoId: String(nextProviderId++),
        owner: 'motir-projects',
        name: input.name,
        defaultBranch: 'main',
        adopted: false,
        seedHeadSha: 'seed-head',
      }) as ProvisionedRepo,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Card {
  id: string;
  key: string;
}

/** A card in the caller's project, claimed (`in_progress`), with the subject and name given. */
async function card(
  subject: string | null,
  initRepositoryName: string | null,
  on: V1ProjectCaller = caller,
): Promise<Card> {
  const item = await workItemsService.createWorkItem(
    { projectId: on.fixture.projectId, kind: 'task', title: 'Create the infra repository' },
    on.fixture.ctx,
  );
  await adminDb.workItem.update({
    where: { id: item.id },
    data: { subject, initRepositoryName, status: 'in_progress' },
  });
  return { id: item.id, key: item.identifier };
}

/** A RUNNING run over `c`, opened by `createdById` (the caller's owner by default). */
async function run(
  c: Card,
  opts: {
    on?: V1ProjectCaller;
    createdById?: string;
    status?: 'running' | 'succeeded';
  } = {},
): Promise<string> {
  const on = opts.on ?? caller;
  const created = await adminDb.dispatchRun.create({
    data: {
      workspaceId: on.fixture.workspaceId,
      projectId: on.fixture.projectId,
      command: 'run',
      origin: 'hosted',
      status: opts.status ?? 'running',
      ...(opts.status && opts.status !== 'running'
        ? { stopReason: 'completed', endedAt: new Date() }
        : {}),
      createdById: opts.createdById ?? on.fixture.ownerId,
      cards: {
        create: [
          {
            workspaceId: on.fixture.workspaceId,
            workItemId: c.id,
            workItemKey: c.key,
            position: 0,
            disposition: 'running',
            startedAt: new Date(),
          },
        ],
      },
    },
  });
  return created.id;
}

async function runToken(runId: string): Promise<Record<string, string>> {
  const { token } = await runCredentialService.mintRunCredential({
    dispatchRunId: runId,
    dispatcherUserId: caller.fixture.ownerId,
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
  return bearer(token);
}

async function post(
  runId: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  const { POST } = await import('@/app/api/v1/dispatch-runs/[id]/repository/route');
  return POST(
    new Request(`http://localhost:3000/api/v1/dispatch-runs/${runId}/repository`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: runId }) },
  );
}

async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { code?: string }).code;
}

/** The project's repository set, as the database holds it — the byte-identical check. */
const repoRows = (projectId = caller.fixture.projectId) =>
  adminDb.projectRepo.findMany({ where: { projectId }, orderBy: { id: 'asc' } });

describe('a run credential creates its init card’s repository', () => {
  it('carries repository:manage in its verified grant, by the shipped mint path', async () => {
    const c = await card('init', 'acme-infra');
    const runId = await run(c);
    const { token } = await runCredentialService.mintRunCredential({
      dispatchRunId: runId,
      dispatcherUserId: caller.fixture.ownerId,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    const verified = await apiTokensService.verify(token);
    expect(verified.grant).toContain('repository:manage');
    expect([...verified.grant].sort()).toEqual([...HOSTED_RUN_TOKEN_GRANT].sort());
  });

  it('appends ONE row, settles it with its mirror id, and answers created with the pass’s own result', async () => {
    const c = await card('init', 'acme-infra');
    const runId = await run(c);
    expect(await repoRows()).toHaveLength(0);

    const res = await post(runId, await runToken(runId), {
      key: c.key,
      name: 'acme-infra',
      role: 'infra',
    });
    expect(res.status).toBe(200);
    const body = dispatchRunRepositorySchema.parse(await res.json());
    expect(body.outcome).toBe('created');
    expect(body.establish).toEqual({ outcome: 'created', failureCode: null, failureReason: null });

    const rows = await repoRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('acme-infra');
    expect(rows[0]!.state).toBe('created');
    expect(rows[0]!.githubRepoId).not.toBeNull();
    expect(body.repository.id).toBe(rows[0]!.id);
    expect(body.repository.state).toBe('created');
    expect(body.repository.seedSource).toBe(rows[0]!.seedSource);

    // The project's set read returns it afterwards.
    const set = await projectRepoSetService.listByProject(
      caller.fixture.projectId,
      caller.fixture.ctx,
    );
    expect(set.map((r) => r.id)).toEqual([rows[0]!.id]);
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it('a replay of the identical call writes nothing and answers already_settled', async () => {
    const c = await card('init', 'acme-infra');
    const runId = await run(c);
    const headers = await runToken(runId);
    const request = { key: c.key, name: 'acme-infra', role: 'infra' };
    expect((await post(runId, headers, request)).status).toBe(200);
    const [first] = await repoRows();

    const res = await post(runId, headers, request);
    expect(res.status).toBe(200);
    const body = dispatchRunRepositorySchema.parse(await res.json());
    expect(body.outcome).toBe('already_settled');
    expect(body.establish.outcome).toBe('already_settled');
    const rows = await repoRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first!.id);
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it('keeps an optional starter key as the row’s base, and an omitted one is an EMPTY base', async () => {
    const c = await card('init', null);
    const runId = await run(c);
    const headers = await runToken(runId);
    const started = await post(runId, headers, {
      key: c.key,
      name: 'acme-web',
      role: 'web',
      starterKey: SEED_SOURCE_PLATFORM_STARTER,
    });
    expect(started.status).toBe(200);
    expect(dispatchRunRepositorySchema.parse(await started.json()).repository.seedSource).toBe(
      SEED_SOURCE_PLATFORM_STARTER,
    );
    const empty = await post(runId, headers, { key: c.key, name: 'acme-api', role: 'api' });
    expect(empty.status).toBe(200);
    expect(dispatchRunRepositorySchema.parse(await empty.json()).repository.seedSource).toBe(
      SEED_SOURCE_INITIALISED,
    );
  });
});

describe('the binding — three arms that look alike from the caller’s side', () => {
  it('a run credential naming ANOTHER run is refused 403 DISPATCH_RUN_TOKEN_OUT_OF_SCOPE', async () => {
    const own = await card('init', 'acme-infra');
    const other = await card('init', 'acme-infra');
    const ownRun = await run(own);
    const otherRun = await run(other);
    const res = await post(otherRun, await runToken(ownRun), {
      key: other.key,
      name: 'acme-infra',
      role: 'infra',
    });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('DISPATCH_RUN_TOKEN_OUT_OF_SCOPE');
    expect(await repoRows()).toHaveLength(0);
  });

  it('a credential whose grant does not hold repository:manage is refused 403 before the handler', async () => {
    const c = await card('init', 'acme-infra');
    const runId = await run(c);
    const narrow = await createV1ProjectCaller({
      permissions: ['project:browse', 'work_item:edit'],
      workspaceName: 'Narrow',
      identifier: 'NAR',
    });
    const service = vi.spyOn(runRepositoryCreationService, 'createRunRepository');
    const res = await post(runId, narrow.headers, {
      key: c.key,
      name: 'acme-infra',
      role: 'infra',
    });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('INSUFFICIENT_PERMISSION');
    expect(service).not.toHaveBeenCalled();
    expect(await repoRows()).toHaveLength(0);
  });

  it('the same request by the operator’s own token holding the key is admitted', async () => {
    const c = await card('init', 'acme-infra');
    const runId = await run(c);
    const res = await post(runId, caller.headers, {
      key: c.key,
      name: 'acme-infra',
      role: 'infra',
    });
    expect(res.status).toBe(200);
    expect(dispatchRunRepositorySchema.parse(await res.json()).outcome).toBe('created');
    expect(await repoRows()).toHaveLength(1);
  });
});

describe('the run read', () => {
  it('an unknown run answers 404 and writes no row', async () => {
    const c = await card('init', 'acme-infra');
    const res = await post('run_does_not_exist', caller.headers, {
      key: c.key,
      name: 'acme-infra',
      role: 'infra',
    });
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe('DISPATCH_RUN_NOT_FOUND');
    expect(await repoRows()).toHaveLength(0);
  });

  it('a run in ANOTHER workspace answers 404 and leaves both sets byte-identical', async () => {
    const elsewhere = await createV1ProjectCaller({
      permissions: KEYED,
      workspaceName: 'Elsewhere',
      identifier: 'ELS',
    });
    const theirCard = await card('init', 'acme-infra', elsewhere);
    const theirRun = await run(theirCard, { on: elsewhere });
    const c = await card('init', 'acme-infra');
    const before = await repoRows(elsewhere.fixture.projectId);

    const res = await post(theirRun, caller.headers, {
      key: c.key,
      name: 'acme-infra',
      role: 'infra',
    });
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe('DISPATCH_RUN_NOT_FOUND');
    expect(await repoRows()).toHaveLength(0);
    expect(await repoRows(elsewhere.fixture.projectId)).toEqual(before);
  });

  it('another operator’s run answers 404 and writes no row', async () => {
    const someoneElse = await adminDb.user.create({
      data: { email: 'someone-else@example.com', name: 'Someone Else' },
    });
    const c = await card('init', 'acme-infra');
    const theirs = await run(c, { createdById: someoneElse.id });
    const res = await post(theirs, caller.headers, {
      key: c.key,
      name: 'acme-infra',
      role: 'infra',
    });
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe('DISPATCH_RUN_NOT_FOUND');
    expect(await repoRows()).toHaveLength(0);
  });

  it('a closed run answers 409 and writes no row', async () => {
    const c = await card('init', 'acme-infra');
    const closed = await run(c, { status: 'succeeded' });
    const res = await post(closed, caller.headers, {
      key: c.key,
      name: 'acme-infra',
      role: 'infra',
    });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('DISPATCH_RUN_TERMINAL');
    expect(await repoRows()).toHaveLength(0);
  });

  it('a card that is not an open leg of the run is refused 422 UNKNOWN_DISPATCH_RUN_CARD', async () => {
    const onRun = await card('init', 'acme-infra');
    const offRun = await card('init', 'acme-infra');
    const runId = await run(onRun);
    const res = await post(runId, caller.headers, {
      key: offRun.key,
      name: 'acme-infra',
      role: 'infra',
    });
    expect(res.status).toBe(422);
    expect(await codeOf(res)).toBe('UNKNOWN_DISPATCH_RUN_CARD');
    expect(await repoRows()).toHaveLength(0);
  });

  it('an unknown card, and a key with no number, answer 404 WORK_ITEM_NOT_FOUND', async () => {
    const c = await card('init', 'acme-infra');
    const runId = await run(c);
    for (const key of ['NOPE-1', 'NOKEY']) {
      const res = await post(runId, caller.headers, { key, name: 'acme-infra', role: 'infra' });
      expect(res.status, key).toBe(404);
      expect(await codeOf(res)).toBe('WORK_ITEM_NOT_FOUND');
    }
    expect(await repoRows()).toHaveLength(0);
  });
});

describe('this door’s two refusals', () => {
  it.each([
    ['carrying no subject', null],
    ['carrying a different member', 'data'],
  ])('a card %s is refused 422 RUN_CARD_NOT_INIT_CARD', async (_label, subject) => {
    const c = await card(subject, null);
    const runId = await run(c);
    const res = await post(runId, await runToken(runId), {
      key: c.key,
      name: 'acme-infra',
      role: 'infra',
    });
    expect(res.status).toBe(422);
    expect(await codeOf(res)).toBe('RUN_CARD_NOT_INIT_CARD');
    expect(await repoRows()).toHaveLength(0);
  });

  it('a request naming another repository than the card declares is refused, naming both', async () => {
    const c = await card('init', 'acme-infra');
    const runId = await run(c);
    const res = await post(runId, await runToken(runId), {
      key: c.key,
      name: 'acme-web',
      role: 'infra',
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('RUN_REPOSITORY_NAME_MISMATCH');
    expect(body.error).toContain('acme-infra');
    expect(body.error).toContain('acme-web');
    expect(await repoRows()).toHaveLength(0);
  });

  it('the declared name in any casing is accepted, keeping the request’s casing', async () => {
    const c = await card('init', 'acme-infra');
    const runId = await run(c);
    const res = await post(runId, await runToken(runId), {
      key: c.key,
      name: 'ACME-Infra',
      role: 'infra',
    });
    expect(res.status).toBe(200);
    const rows = await repoRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('ACME-Infra');
  });

  it('a card that declares no name accepts the requested one', async () => {
    const c = await card('init', null);
    const runId = await run(c);
    const res = await post(runId, await runToken(runId), {
      key: c.key,
      name: 'whatever-they-asked',
      role: 'other',
    });
    expect(res.status).toBe(200);
    expect((await repoRows()).map((r) => r.name)).toEqual(['whatever-they-asked']);
  });

  it('a card declaring a name but carrying no subject is still an init card', async () => {
    const c = await card(null, 'acme-infra');
    const runId = await run(c);
    const res = await post(runId, await runToken(runId), {
      key: c.key,
      name: 'acme-infra',
      role: 'infra',
    });
    expect(res.status).toBe(200);
  });

  it('both refusals map to 422 by code', () => {
    expect(classifyApiV1Error(new RunCardNotInitCardError('A-1'))?.status).toBe(422);
    expect(classifyApiV1Error(new RunRepositoryNameMismatchError('A-1', 'x', 'y'))?.status).toBe(
      422,
    );
  });
});

describe('a malformed body is refused 422 INVALID_BODY and writes no row', () => {
  it.each([
    ['a missing name', { role: 'infra' }],
    ['a blank name', { name: '   ', role: 'infra' }],
    ['a role outside PROJECT_REPO_ROLES', { name: 'acme-infra', role: 'database' }],
    ['a blank starterKey', { name: 'acme-infra', role: 'infra', starterKey: '  ' }],
  ])('%s', async (_label, partial) => {
    const c = await card('init', 'acme-infra');
    const runId = await run(c);
    const res = await post(runId, await runToken(runId), { key: c.key, ...partial });
    expect(res.status).toBe(422);
    expect(await codeOf(res)).toBe('INVALID_BODY');
    expect(await repoRows()).toHaveLength(0);
  });
});

describe('the creation sequence’s own refusals keep their status through this door', () => {
  it.each([
    ['REPO_EXISTS_WITH_OTHER_SPEC', 409],
    ['REPO_ESTABLISH_BUSY', 409],
    ['PROJECT_REPO_NAME_TAKEN', 409],
    ['PROJECT_REPO_INVALID_FIELD', 422],
    ['PROJECT_REPO_SEED_REFUSED', 422],
    ['ai_plan_required', 402],
    ['plan_unknown', 503],
  ])('%s → %i', (code, status) => {
    expect(classifyApiV1Error(Object.assign(new Error(code), { code }))?.status).toBe(status);
  });

  it('a row of this name with another role is refused 409 and left unchanged', async () => {
    const c = await card('init', 'acme-infra');
    const runId = await run(c);
    const headers = await runToken(runId);
    expect(
      (await post(runId, headers, { key: c.key, name: 'acme-infra', role: 'infra' })).status,
    ).toBe(200);
    const before = await repoRows();
    const res = await post(runId, headers, { key: c.key, name: 'acme-infra', role: 'web' });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('REPO_EXISTS_WITH_OTHER_SPEC');
    expect(await repoRows()).toEqual(before);
  });
});

describe('the MCP surface gains no door', () => {
  it('the one MCP tool asserting repository:manage is the shipped creation tool', () => {
    const asserting = Object.entries(TOOL_PERMISSIONS)
      .filter(([, key]) => key === 'repository:manage')
      .map(([tool]) => tool);
    expect(asserting).toEqual(['create_project_repository']);
  });
});

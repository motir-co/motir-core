import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY the motir-ai boundary client — the `server-only` pre-plan read approve's
// propose step reaches when a project's set is empty. Everything else is the real
// chain against real Postgres, with `fetch` faked at the GitHub HTTP boundary (the
// convention `repositorySetStoryGate.test.ts` records for the establish suites).
vi.mock('@/lib/ai/motirAiClient', () => ({ getPreplanState: vi.fn() }));

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { getPreplanState } from '@/lib/ai/motirAiClient';
import type { RawPreplanStateResponse } from '@/lib/ai/types';
import type { ProposalInput } from '@/lib/dto/plans';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { GithubRepoNotFoundError } from '@/lib/github/errors';
import {
  _resetProvisioningInstallationCache,
  _setReadinessPollForTests,
} from '@/lib/github/repoProvisioning';
import { runCreateProjectRepository } from '@/lib/mcp/tools/createProjectRepository';
import {
  PlanItemUnknownTargetRepoRoleError,
  PlanItemUnresolvableTargetRepoRoleError,
} from '@/lib/plans/errors';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { workItemRepoRepository } from '@/lib/repositories/workItemRepoRepository';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { plansService } from '@/lib/services/plansService';
import { projectRepoInitRoutingService } from '@/lib/services/projectRepoInitRoutingService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { resolveDispatchRepoForItem } from '@/lib/workItems/dispatchRepo';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { createTestProject } from '../../fixtures/projectFixtures';
import {
  createTestLink,
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures/workItemFixtures';
import {
  createActionsVariableFake,
  type ActionsVariableFake,
} from '../../helpers/actionsVariableFake';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { organizationIdOf } from '../../helpers/organizationOf';
import {
  createRepositoryActionsConfigFake,
  type RepositoryActionsConfigFake,
} from '../../helpers/repositoryActionsConfigFake';
import { createRunnerGroupFake, type RunnerGroupFake } from '../../helpers/runnerGroupFake';
import { ORIGINAL_SEED_KEYS, withOnlyOriginalSeeds } from '../../helpers/seedRegistryShipped';

// ─────────────────────────────────────────────────────────────────────────────
// The INTEGRATION GATE over the motir-core doors of Story MOTIR-10162 (MOTIR-11048):
// the creation tool (MOTIR-11038), the plan door's role refusal (MOTIR-11039), the
// adoption a pull-request link makes (MOTIR-11040), the routing pass (MOTIR-11042)
// and the declaration it matches on (MOTIR-11051).
//
// Each of those ships its own suite over the real datastore. This file re-asserts
// none of their cases; it owns the JOINTS between them, where one card's stored
// fact becomes another card's input:
//
//   1. the row the TOOL settled is the row the project's SET reports and the row the
//      ROUTING pass gives a waiting card — one id, read three ways, and dispatched;
//   2. that routing is by row identity, never by a name another project shares;
//   3. a replay of the tool is silent across the joint;
//   4. a creation the host refused strands nobody;
//   5. a row a LINK adopted resolves a role pin at the PLAN door — one proposal body,
//      two answers, decided by the set alone — and the empty-set exemption beside it.
//
// HARNESS. Real Postgres through the shipped fixtures. The GitHub HTTP boundary is
// the global `fetch`, faked below with the shipped runner-group, actions-variable
// and repository-actions fakes; the provisioning cache and readiness poll are reset
// as the establish convention does. The admin client SEEDS what no product door
// writes (an init card's declaration, which only materialize writes) and every
// assertion is read off a product read. The only module mock is the motir-ai client.
// ─────────────────────────────────────────────────────────────────────────────

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '667788';

let existingRepos: Map<string, number>;
let createRequests: string[];
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
        const name = String(body?.['name']);
        createRequests.push(name);
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
      // The link door's post-commit check refresh — best-effort, not under test.
      if (u.includes('/check-runs') || u.includes('/commits/')) {
        return json(200, { id: 1, check_runs: [] });
      }
      if (method === 'PUT') return json(201, { content: {} });
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }),
  );
}

const EMPTY_PREPLAN: RawPreplanStateResponse = {
  session: { platform: null } as RawPreplanStateResponse['session'],
  docs: [],
  catalog: null,
};

beforeEach(async () => {
  await truncateAuthTables();
  existingRepos = new Map();
  createRequests = [];
  nextRepoId = 800_001;
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
  vi.mocked(getPreplanState).mockResolvedValue(EMPTY_PREPLAN);
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

// ── helpers ─────────────────────────────────────────────────────────────────

interface ProjectHandle {
  projectId: string;
  projectKey: string;
  ctx: ServiceContext;
  fx: WorkItemFixture;
}

function handleOf(fx: WorkItemFixture): ProjectHandle {
  return { projectId: fx.projectId, projectKey: fx.projectIdentifier, ctx: fx.ctx, fx };
}

type Answer = {
  outcome: string;
  repository: { id: string; name: string | null; role: string; state: string };
  establish: { outcome: string; failureCode: string | null; failureReason: string | null };
};

function answerOf(result: CallToolResult): Answer {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as unknown as Answer;
}

function errorCodeOf(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  const text = (result.content[0] as { text: string }).text;
  return text.slice(0, text.indexOf(':'));
}

function createRepo(p: ProjectHandle, name: string, role: 'infra' | 'web' = 'infra') {
  return runCreateProjectRepository(
    { projectKey: p.projectKey, name, role, starterKey: SEED_SOURCE_PLATFORM_STARTER },
    p.ctx,
  );
}

/**
 * An init card declaring `name` and one childless open leaf blocked by it. The
 * declaration is SEEDED through the admin client: no create or update door takes
 * it, and materialize is its only product writer.
 */
async function initCardWithWaiter(p: ProjectHandle, name: string) {
  const projectFx = { ...p.fx, projectId: p.projectId };
  const init = await createTestWorkItem(projectFx, { kind: 'task', title: `Create ${name}` });
  await adminDb.workItem.update({
    where: { id: init.id },
    data: { subject: 'init', initRepositoryName: name },
  });
  const waiter = await createTestWorkItem(projectFx, { kind: 'task', title: `Use ${name}` });
  await createTestLink({
    workspaceId: p.fx.workspaceId,
    fromId: waiter.id,
    toId: init.id,
    kind: 'is_blocked_by',
    createdById: p.fx.ownerId,
  });
  return { init, waiter };
}

/** The card's references, through the shipped read. */
function referencesOf(p: ProjectHandle, workItemId: string) {
  return withWorkspaceContext(p.ctx, (tx) =>
    workItemRepoRepository.listByWorkItems([workItemId], tx),
  );
}

/** The card's edges and status, for byte-identity across a joint. */
async function edgesAndStatus(workItemId: string) {
  const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } });
  const edges = await adminDb.workItemLink.findMany({
    where: { fromId: workItemId },
    orderBy: { id: 'asc' },
  });
  return { status: item.status, edges };
}

/** A connected mirror the organisation holds, outside any project's set. */
async function orgRepo(fx: WorkItemFixture, name: string) {
  const installationId = `inst-${fx.workspaceId}-github`;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId: fx.workspaceId,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  return adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: await organizationIdOf(fx.workspaceId),
      repoId: `${name}-host`,
      owner: 'acme',
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
}

function link(fx: WorkItemFixture, workItemId: string, name: string, number = 1) {
  return githubPullRequestService.linkPullRequestByCoordinates(
    {
      workItemId,
      projectId: fx.projectId,
      owner: 'acme',
      name,
      number,
      headRef: `feat/${number}`,
      baseRef: 'main',
      title: `PR ${number}`,
    },
    fx.ctx,
  );
}

function addCard(title: string, targetRepoRole: string): ProposalInput {
  return {
    op: 'add',
    proposedFields: { title, kind: 'task', targetRepoRole } as ProposalInput['proposedFields'],
  };
}

async function refusedAt(promise: Promise<unknown>) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PlanItemUnresolvableTargetRepoRoleError);
  return err as PlanItemUnresolvableTargetRepoRoleError;
}

/** Append the body, mark the plan planned, approve, and return the card it made. */
async function appendAndApprove(fx: WorkItemFixture, planId: string, body: ProposalInput) {
  await plansService.addProposals(planId, [body], fx.ctx);
  await plansService.markPlanned(planId, fx.ctx);
  await plansService.approvePlan(planId, fx.ctx);
  const title = (body.proposedFields as { title: string }).title;
  return adminDb.workItem.findFirstOrThrow({ where: { projectId: fx.projectId, title } });
}

// ── 1 · the tool's row is the set's row is the routed card's row ────────────

describe('the creation tool → the set read → the routing pass → dispatch', () => {
  it('settles exactly one row, and the set read reports that same row', async () => {
    const p = handleOf(await makeWorkItemFixture());

    const answer = answerOf(await createRepo(p, 'acme-infra'));

    const set = await projectRepoSetService.listByProject(p.projectId, p.ctx);
    expect(set).toHaveLength(1);
    expect(set[0]).toMatchObject({
      id: answer.repository.id,
      name: 'acme-infra',
      role: 'infra',
      state: 'created',
    });
    const row = await adminDb.projectRepo.findUniqueOrThrow({ where: { id: set[0]!.id } });
    expect(row.githubRepoId).not.toBeNull();
  });

  it('routes the waiter onto that same id, keeps its edge, and dispatches it into that checkout', async () => {
    const p = handleOf(await makeWorkItemFixture());
    const answer = answerOf(await createRepo(p, 'acme-infra'));
    const { init, waiter } = await initCardWithWaiter(p, 'acme-infra');
    const before = await edgesAndStatus(waiter.id);
    expect(before.edges.map((e) => e.toId)).toEqual([init.id]);

    await projectRepoInitRoutingService.routeInitCardDependents(answer.repository.id, p.ctx);

    const [setRow] = await projectRepoSetService.listByProject(p.projectId, p.ctx);
    const refs = await referencesOf(p, waiter.id);
    expect(refs.map((r) => [r.projectRepoId, r.position])).toEqual([[answer.repository.id, 0]]);
    expect(setRow!.id).toBe(answer.repository.id);
    expect(await edgesAndStatus(waiter.id)).toEqual(before);

    const routed = await adminDb.workItem.findUniqueOrThrow({ where: { id: waiter.id } });
    const dispatch = await resolveDispatchRepoForItem(routed, p.ctx);
    expect(dispatch?.name).toBe('acme-infra');
    expect(dispatch?.cloneUrl).toContain(`${MOTIR_ORG}/acme-infra`);
  });

  it('routes by row identity: a second project declaring the same name is left alone', async () => {
    const fx = await makeWorkItemFixture();
    const first = handleOf(fx);
    const otherProject = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Second',
      identifier: 'SEC',
    });
    const second: ProjectHandle = {
      ...first,
      projectId: otherProject.id,
      projectKey: otherProject.identifier,
    };
    const { waiter: mine } = await initCardWithWaiter(first, 'acme-infra');
    const { waiter: theirs } = await initCardWithWaiter(second, 'acme-infra');
    const theirsBefore = await edgesAndStatus(theirs.id);

    const answer = answerOf(await createRepo(first, 'acme-infra'));
    await projectRepoInitRoutingService.routeInitCardDependents(answer.repository.id, first.ctx);

    expect((await referencesOf(first, mine.id)).map((r) => r.projectRepoId)).toEqual([
      answer.repository.id,
    ]);
    expect(await referencesOf(second, theirs.id)).toEqual([]);
    expect(await edgesAndStatus(theirs.id)).toEqual(theirsBefore);
  });

  it('a replay creates nothing, asks the host once, and re-points no routed card', async () => {
    const p = handleOf(await makeWorkItemFixture());
    const first = answerOf(await createRepo(p, 'acme-infra'));
    const { waiter } = await initCardWithWaiter(p, 'acme-infra');
    await projectRepoInitRoutingService.routeInitCardDependents(first.repository.id, p.ctx);
    const refsBefore = await referencesOf(p, waiter.id);

    const again = answerOf(await createRepo(p, 'acme-infra'));

    expect(again.outcome).toBe('already_settled');
    expect(again.repository.id).toBe(first.repository.id);
    expect(await projectRepoSetService.listByProject(p.projectId, p.ctx)).toHaveLength(1);
    expect(createRequests).toEqual(['acme-infra']);
    const refsAfter = await referencesOf(p, waiter.id);
    expect(refsAfter.map((r) => [r.id, r.position])).toEqual(
      refsBefore.map((r) => [r.id, r.position]),
    );
  });

  it('a creation the host refuses strands nobody', async () => {
    // Another tenant already holds `acme-infra` on the host. A bare name on the
    // host that no tenant claims would be ADOPTED, which is the tool's own case.
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    answerOf(await createRepo(handleOf(other), 'acme-infra'));
    const p = handleOf(await makeWorkItemFixture({ name: 'Acme', identifier: 'ACM' }));
    const { waiter } = await initCardWithWaiter(p, 'acme-infra');
    const before = await edgesAndStatus(waiter.id);

    const result = await createRepo(p, 'acme-infra');

    expect(errorCodeOf(result)).toBe('REPO_NAME_TAKEN_ON_HOST');
    const set = await projectRepoSetService.listByProject(p.projectId, p.ctx);
    expect(set).toHaveLength(1);
    expect(set[0]!.state).toBe('failed');
    expect(set[0]!.failureReason).toContain('acme-infra');
    const routed = await projectRepoInitRoutingService.routeInitCardDependents(set[0]!.id, p.ctx);
    expect(routed.routedWorkItemIds).toEqual([]);
    expect(await referencesOf(p, waiter.id)).toEqual([]);
    expect(await edgesAndStatus(waiter.id)).toEqual(before);
  });
});

// ── 2 · the plan door, the link's adopted row, and the empty-set exemption ───

describe('the plan door resolves a role against the set as it stands', () => {
  it('a body refused for `other` is accepted once a link adopted a repository, and pins that row', async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);
    const plan = await plansService.createPlan(fx.projectId, { title: 'Pin it' }, fx.ctx);
    const body = addCard('Wire the tooling', 'other');

    const err = await refusedAt(plansService.addProposals(plan.id, [body], fx.ctx));
    expect(err.role).toBe('other');
    expect(err.message).toContain('Wire the tooling');
    expect(await adminDb.planItem.count({ where: { planId: plan.id } })).toBe(0);

    await orgRepo(fx, 'acme-tools');
    const shipping = await createTestWorkItem(fx, { kind: 'task', title: 'Ship it' });
    await link(fx, shipping.id, 'acme-tools');
    const adopted = (await projectRepoSetService.listByProject(fx.projectId, fx.ctx)).find(
      (r) => r.name === 'acme-tools',
    );
    expect(adopted).toMatchObject({
      state: 'connected',
      seedSource: 'organization',
      role: 'other',
    });
    const card = await appendAndApprove(fx, plan.id, body);

    const refs = await referencesOf(handleOf(fx), card.id);
    expect(refs.map((r) => [r.projectRepoId, r.position])).toEqual([[adopted!.id, 0]]);
  });

  it('a body refused for `infra` is accepted once an infra row is added, and pins that row', async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);
    const plan = await plansService.createPlan(fx.projectId, { title: 'Pin it' }, fx.ctx);
    const body = addCard('Stand up the infra', 'infra');

    const err = await refusedAt(plansService.addProposals(plan.id, [body], fx.ctx));
    expect(err.role).toBe('infra');
    expect(await adminDb.planItem.count({ where: { planId: plan.id } })).toBe(0);

    const infra = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'infra', name: 'acme-infra' },
      fx.ctx,
    );
    const card = await appendAndApprove(fx, plan.id, body);

    const refs = await referencesOf(handleOf(fx), card.id);
    expect(refs.map((r) => [r.projectRepoId, r.position])).toEqual([[infra.id, 0]]);
  });

  it('the same body on a project recording no repositories is exempt, and approves onto the proposed row', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Pin it' }, fx.ctx);
    const body = addCard('Stand up the infra', 'infra');

    await plansService.addProposals(plan.id, [body], fx.ctx);
    expect(await adminDb.planItem.count({ where: { planId: plan.id } })).toBe(1);
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const infra = (await projectRepoSetService.listByProject(fx.projectId, fx.ctx)).find(
      (r) => r.role === 'infra',
    );
    expect(infra).toBeDefined();
    const card = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, title: 'Stand up the infra' },
    });
    const refs = await referencesOf(handleOf(fx), card.id);
    expect(refs.map((r) => [r.projectRepoId, r.position])).toEqual([[infra!.id, 0]]);
  });

  it('the vocabulary refusal still answers an unknown role word, beside the set refusal', async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);
    const plan = await plansService.createPlan(fx.projectId, { title: 'Pin it' }, fx.ctx);

    await expect(
      plansService.addProposals(plan.id, [addCard('Odd card', 'mainframe')], fx.ctx),
    ).rejects.toBeInstanceOf(PlanItemUnknownTargetRepoRoleError);
    await refusedAt(plansService.addProposals(plan.id, [addCard('Infra card', 'infra')], fx.ctx));
    expect(await adminDb.planItem.count({ where: { planId: plan.id } })).toBe(0);
  });

  it('a link on a repository the organisation does not hold leaves the set byte-identical', async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);
    const shipping = await createTestWorkItem(fx, { kind: 'task', title: 'Ship it' });
    const before = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);

    await expect(link(fx, shipping.id, 'not-ours')).rejects.toBeInstanceOf(GithubRepoNotFoundError);

    expect(await projectRepoSetService.listByProject(fx.projectId, fx.ctx)).toEqual(before);
  });
});

// ── 3 · the suite's own substitutions ───────────────────────────────────────

describe('this gate substitutes only the boundaries it names', () => {
  it('mocks only the motir-ai client and stubs only the global fetch', () => {
    const source = readFileSync(new URL(import.meta.url), 'utf8');
    const mocked = [...source.matchAll(/vi\.(?:mock|doMock)\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(mocked).toEqual(['@/lib/ai/motirAiClient']);
    const stubbed = [...source.matchAll(/vi\.stubGlobal\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(stubbed).toEqual(['fetch']);
    // No spy replaces a product module either: the gate drives the real chain.
    expect(source).not.toMatch(/vi\.spyOn\(/);
  });
});

import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectRepoProvisioningService } from '@/lib/services/projectRepoProvisioningService';
import { fleetGithubOrgAssignmentService } from '@/lib/services/fleetGithubOrgAssignmentService';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { listConnectedRepoNames } from '@/lib/workItems/targetRepo';
import {
  _resetProvisioningInstallationCache,
  _setReadinessPollForTests,
} from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { MOTIR_RUNNER_LABEL, MOTIR_RUNNER_VARIABLE } from '@/lib/ciFleet/config';
import { SEED_SOURCE_INITIALISED } from '@/lib/projectRepos/vocabulary';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { ORIGINAL_SEED_KEYS, withOnlyOriginalSeeds } from '../helpers/seedRegistryShipped';
import { truncateAuthTables } from '../helpers/db';
import { createRunnerGroupFake, type RunnerGroupFake } from '../helpers/runnerGroupFake';
import {
  createActionsVariableFake,
  type ActionsVariableFake,
} from '../helpers/actionsVariableFake';
import { spyOnJobDispatch, dispatchedEvents } from '../helpers/jobs';
import * as jobDispatcher from '@/lib/jobs/engine/dispatcher';
import {
  aiPlanGateService,
  AI_PLAN_REQUIRED_ESTABLISH_MESSAGE,
  PLAN_UNKNOWN_ESTABLISH_MESSAGE,
} from '@/lib/services/aiPlanGateService';
import { AiPlanRequiredError, AiPlanUnknownError } from '@/lib/projectRepos/errors';

// The repo-CREATION primitive over real Postgres (Story MOTIR-1775 · MOTIR-1781).
//
// The card's own framing is the test plan: "the interesting engineering is no
// longer the create call, it is what happens when row 2 of 3 fails." So what is
// pinned here is per-ROW independence, honesty and resumability — each proved by
// running the failure, never reasoned about:
//
//   1. A ONE-row set produces one repository, seeded from the starter, associated
//      with the project, mirrored, and visible to its own tenant.
//   2. A TWO-row (`web` + `api`) set produces TWO, each seeded PER ROLE — the api
//      repo honestly initialised, not seeded with a web starter.
//   3. Row 2 of 3 failing leaves row 1 `created`, row 2 `failed` WITH ITS REASON,
//      and row 3 still attempted — and a RE-RUN completes only the unresolved one.
//   4. A re-run never creates a second repository: the 422 path adopts.
//   5. The index enqueue happens through the EXISTING chokepoint, per repo, and
//      nothing is added to the webhook → reconcile → index chain.
//   6. No long transaction wraps the host calls — each row's outcome is committed
//      as it resolves, which is what makes 3 and 4 possible at all.
//
// Real Postgres; the ONLY fake is `fetch` (the GitHub HTTP boundary — the shipped
// convention for these suites). Tests connect as the superuser, so RLS is inert
// here by design; the shared-installation tenancy itself is proved in
// `tests/github/sharedInstallationTenancy.test.ts`.

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '556677';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[];
/** Repo names the fake GitHub "already has" — how a re-run's 422 is staged. */
let existingRepos: Map<string, number>;
/** Repo names the fake GitHub refuses to create, and with which status. */
let refusals: Map<string, number>;
/** Repo names whose default-branch head the fake GitHub will not serve. */
let unreadableHeads: Set<string>;
/** Template coordinates (`owner/repo`) the fake GitHub no longer serves — `/generate` 404s. */
let missingTemplates: Set<string>;
let nextRepoId: number;
/** The project's own GitHub runner group (MOTIR-1972) — establishing a
 *  repository now syncs it, so this suite's GitHub serves those endpoints too. */
let runnerGroups: RunnerGroupFake;
let actionsVariables: ActionsVariableFake;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A GitHub good enough to be worth asserting against: it resolves the
 * provisioning installation, mints a token, creates repositories (org + template),
 * remembers them, 422s a name it already has (in the ORG endpoint's shape — the
 * generic `message` plus the phrase inside `errors[]`), and serves reads.
 */
function installGitHub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ url: u, method, body });

      if (u.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
        return json(200, { id: Number(INSTALLATION_ID) });
      }
      if (u.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      // The project's own RUNNER GROUP (MOTIR-1972) — establishing a repository
      // now syncs it, so this suite's GitHub has to know about those endpoints.
      // What the group ends up holding is asserted in
      // `tests/ciFleet/projectRunnerGroupService.test.ts`; here it just has to be
      // REAL, so the establish path under test runs the code it really runs.
      const group = await runnerGroups.handle(u, method, body);
      if (group) return group;

      // The org's FLEET RUNNER VARIABLE (MOTIR-2015) — establishing a repository
      // now ensures `MOTIR_RUNNER`, so this suite's GitHub has to know about those
      // endpoints too. The service swallows its own failures by contract, so an
      // unfaked call here would be INVISIBLE rather than loud: green, silent, and
      // no longer describing what the product does.
      const variable = actionsVariables.handle(u, method, body);
      if (variable) return variable;
      // Create — either endpoint. The template endpoint names the NEW repo in the
      // body, exactly as the real one does.
      const generate = /\/repos\/([^/]+)\/([^/]+)\/generate$/.exec(u);
      if (method === 'POST' && generate && missingTemplates.has(`${generate[1]}/${generate[2]}`)) {
        return json(404, { message: 'Not Found' });
      }
      if (
        method === 'POST' &&
        (u.includes('/generate') || u.endsWith(`/orgs/${MOTIR_ORG}/repos`))
      ) {
        const name = String(body?.['name']);
        const refusal = refusals.get(name);
        if (refusal) {
          return json(refusal, { message: 'Organization has disabled repository creation' });
        }
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
      // The default branch's head once seeding finished (MOTIR-4589) — the seed
      // head the row records. `unreadableHeads` stages a head GitHub will not serve.
      const branch = /\/repos\/[^/]+\/([^/]+)\/branches\/[^/]+$/.exec(u);
      if (method === 'GET' && branch) {
        const name = branch[1]!;
        if (!existingRepos.has(name) || unreadableHeads.has(name)) {
          return json(404, { message: 'Branch not found' });
        }
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

async function addRow(
  fx: WorkItemFixture,
  role: 'web' | 'api' | 'infra',
  name: string,
): Promise<string> {
  const row = await projectRepoSetService.addRow(fx.projectId, { role, name }, fx.ctx);
  return row.id;
}

/** A SECOND project in the SAME workspace — the case where the cross-tenant
 *  guard cannot help and only the `github_repo_id` unique index can. */
async function createSecondProject(fx: WorkItemFixture): Promise<string> {
  const project = await createTestProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ownerId,
    name: 'Second',
    identifier: 'SEC',
  });
  return project.id;
}

async function readState(rowId: string, fx: WorkItemFixture) {
  const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
  return rows.find((r) => r.id === rowId)!;
}

beforeEach(async () => {
  await truncateAuthTables();
  calls = [];
  existingRepos = new Map();
  refusals = new Map();
  unreadableHeads = new Set();
  missingTemplates = new Set();
  nextRepoId = 900_001;
  actionsVariables = createActionsVariableFake(MOTIR_ORG);
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

// These scenarios prove provisioning from the two original seeds, a non-web row
// initialised; seeding a non-web row from its shipped foundation is
// MOTIR-713's integration suite. So MOTIR-9813's four starter entries are set
// aside for this file.
withOnlyOriginalSeeds();

afterEach(async () => {
  // The registry is migration-seeded platform data, not truncated: drop only
  // what a test registered.
  await adminDb.seedRegistryEntry.deleteMany({
    where: { key: { notIn: ORIGINAL_SEED_KEYS } },
  });
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

describe('a ONE-row set', () => {
  it('produces one repository, seeded from the starter, associated and in the installation', async () => {
    const fx = await makeWorkItemFixture();
    const rowId = await addRow(fx, 'web', 'acme-web');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ rowId, outcome: 'created' });

    // ASSOCIATED with the project — the row is settled and realized.
    const row = await readState(rowId, fx);
    expect(row).toMatchObject({ state: 'created', established: true });
    expect(row.realizedRepo).toMatchObject({ owner: MOTIR_ORG, name: 'acme-web' });

    // IN THE INSTALLATION — the mirror row exists under the SHARED provisioning
    // installation, which is bound to NO workspace, while the repo row carries
    // the creating project's tenancy (MOTIR-1931).
    const installation = await adminDb.githubInstallation.findUniqueOrThrow({
      where: { installationId: INSTALLATION_ID },
    });
    expect(installation).toMatchObject({ workspaceId: null, accountLogin: MOTIR_ORG });
    const mirrored = await adminDb.githubRepo.findFirstOrThrow({ where: { name: 'acme-web' } });
    expect(mirrored).toMatchObject({
      installationId: installation.id,
      workspaceId: fx.workspaceId,
      owner: MOTIR_ORG,
      defaultBranch: 'main',
    });

    // And it is real to the rest of the product: a dispatchable target-repo name.
    await expect(listConnectedRepoNames(fx.ctx)).resolves.toMatchObject([{ name: 'acme-web' }]);

    // Seeded from the STARTER — the template endpoint, with the template in the
    // path and Motir's org as the owner.
    const generate = calls.find((c) => c.url.includes('/generate'))!;
    // The template comes from the registry ENTRY's source (MOTIR-708).
    expect(generate.url).toContain('/repos/motir-co/nextjs-prisma-serverless-starter/generate');
    expect(generate.body).toMatchObject({ owner: MOTIR_ORG, name: 'acme-web', private: true });
  });
});

describe('a TWO-row set is seeded PER ROLE', () => {
  it('creates both, templates the web row, and honestly initialises the api row', async () => {
    const fx = await makeWorkItemFixture();
    const webId = await addRow(fx, 'web', 'acme-web');
    const apiId = await addRow(fx, 'api', 'acme-api');

    // The api row's seed source came from ADR §2's table, not from the web one.
    expect((await readState(apiId, fx)).seedSource).toBe(SEED_SOURCE_INITIALISED);

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    expect(result.rows.map((r) => r.outcome)).toEqual(['created', 'created']);

    // TWO repositories, each associated under ITS OWN role.
    const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(rows.map((r) => [r.role, r.name, r.state, r.established])).toEqual([
      ['web', 'acme-web', 'created', true],
      ['api', 'acme-api', 'created', true],
    ]);
    expect(rows[0]!.realizedRepo!.id).not.toBe(rows[1]!.realizedRepo!.id);
    expect(webId).not.toBe(apiId);

    // Each in the installation, each tenanted to this workspace.
    const mirrored = await adminDb.githubRepo.findMany({ orderBy: { name: 'asc' } });
    expect(mirrored.map((r) => r.name)).toEqual(['acme-api', 'acme-web']);
    expect(new Set(mirrored.map((r) => r.workspaceId))).toEqual(new Set([fx.workspaceId]));

    // The api repo is NOT seeded with the web starter: it goes to the ORG create
    // with `auto_init` + a licence + a `.gitignore`, and gets the CI stub.
    const generates = calls.filter((c) => c.url.includes('/generate'));
    expect(generates).toHaveLength(1);
    expect(generates[0]!.body).toMatchObject({ name: 'acme-web' });

    const orgCreate = calls.find(
      (c) => c.method === 'POST' && c.url.endsWith(`/orgs/${MOTIR_ORG}/repos`),
    )!;
    expect(orgCreate.body).toMatchObject({
      name: 'acme-api',
      private: true,
      auto_init: true,
      license_template: 'mit',
      gitignore_template: 'Node',
    });
    // ADR §2 — the README GitHub writes names the project and the ROW'S ROLE.
    expect(String(orgCreate.body!['description'])).toContain('api');
    expect(String(orgCreate.body!['description'])).toContain(fx.project.name);

    // …scoped to the CONTENTS PUT: the runner-group access-list write
    // (MOTIR-1972) is a PUT too, and it comes first.
    const stub = calls.find((c) => c.method === 'PUT' && c.url.includes('/contents/'))!;
    expect(stub.url).toContain('/contents/.github/workflows/ci.yml');
    expect(stub.url).toContain('acme-api');
  });
});

describe('PARTIAL FAILURE is the main event', () => {
  it('row 2 of 3 fails: row 1 keeps its repo, row 2 records WHY, row 3 is still attempted', async () => {
    const fx = await makeWorkItemFixture();
    const oneId = await addRow(fx, 'web', 'acme-web');
    const twoId = await addRow(fx, 'api', 'acme-api');
    const threeId = await addRow(fx, 'infra', 'acme-infra');
    refusals.set('acme-api', 403);

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows.map((r) => [r.rowId, r.outcome])).toEqual([
      [oneId, 'created'],
      [twoId, 'failed'],
      [threeId, 'created'],
    ]);

    // Nothing rolled back — row 1's repository is a real artifact and stays one.
    expect(await readState(oneId, fx)).toMatchObject({ state: 'created', established: true });
    expect(await readState(threeId, fx)).toMatchObject({ state: 'created', established: true });
    const githubRepoCount = await adminDb.githubRepo.count();
    expect(githubRepoCount).toBe(2);

    // Row 2 is `failed` WITH ITS REASON — a failed row that cannot say why is the
    // whole defect the state carries a reason to prevent.
    const failed = await readState(twoId, fx);
    expect(failed.state).toBe('failed');
    expect(failed.failureReason).toBeTruthy();
    expect(failed.established).toBe(false);
    // Typed + RENDERABLE: a whole sentence carrying the status and GitHub's own
    // short `message`, which is the actionable half ("your org has disabled repo
    // creation" is what the user must act on). What must not escape is the raw
    // PAYLOAD — the body is never stringified into the row.
    expect(result.rows[1]!.failureCode).toBe('REPO_PROVISIONING_FAILED');
    expect(failed.failureReason).toContain('403');
    expect(failed.failureReason).toContain('disabled repository creation');
    expect(failed.failureReason).not.toContain('{');
  });

  it('a RE-RUN completes ONLY the unresolved row, and creates no second repository', async () => {
    const fx = await makeWorkItemFixture();
    const oneId = await addRow(fx, 'web', 'acme-web');
    const twoId = await addRow(fx, 'api', 'acme-api');
    refusals.set('acme-api', 403);
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    const createsBefore = calls.filter(
      // Runner-group creates (MOTIR-1972) and the fleet runner VARIABLE's create
      // (MOTIR-2015) are POSTs too, and neither is a repository create — the count
      // this asserts is about repositories.
      (c) =>
        c.method === 'POST' &&
        !c.url.includes('access_tokens') &&
        !c.url.includes('/actions/runner-groups') &&
        !c.url.includes('/actions/variables'),
    );
    expect(createsBefore).toHaveLength(2); // web ok, api refused

    // GitHub recovers; re-run.
    refusals.clear();
    const rerun = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(rerun.rows.map((r) => [r.rowId, r.outcome])).toEqual([
      [oneId, 'already_settled'], // untouched — a settled row is never re-attempted
      [twoId, 'created'],
    ]);
    // Exactly ONE more create call: the settled row was not asked for again.
    const createsAfter = calls.filter(
      // Runner-group creates (MOTIR-1972) and the fleet runner VARIABLE's create
      // (MOTIR-2015) are POSTs too, and neither is a repository create — the count
      // this asserts is about repositories.
      (c) =>
        c.method === 'POST' &&
        !c.url.includes('access_tokens') &&
        !c.url.includes('/actions/runner-groups') &&
        !c.url.includes('/actions/variables'),
    );
    expect(createsAfter).toHaveLength(3);
    const githubRepoCount = await adminDb.githubRepo.count();
    expect(githubRepoCount).toBe(2);
    // The retried row's stale failure reason is cleared by the settle.
    expect(await readState(twoId, fx)).toMatchObject({
      state: 'created',
      established: true,
      failureReason: null,
    });
  });

  it('ADOPTS rather than renaming when the repository already exists (crash-after-create)', async () => {
    const fx = await makeWorkItemFixture();
    const rowId = await addRow(fx, 'api', 'acme-api');
    // Stage exactly the crash the resume path exists for: the repository was
    // created by a previous attempt, but the row never got attached.
    existingRepos.set('acme-api', 424242);

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows[0]).toMatchObject({ rowId, outcome: 'adopted' });
    const row = await readState(rowId, fx);
    // The row carries the SAME name it always did — nothing was renamed — and it
    // realizes the repository that already existed.
    expect(row).toMatchObject({ name: 'acme-api', state: 'created', established: true });
    expect(row.realizedRepo).toMatchObject({ name: 'acme-api' });
    expect(
      await adminDb.githubRepo.findFirstOrThrow({ where: { name: 'acme-api' } }),
    ).toMatchObject({
      repoId: '424242',
    });
    // Exactly one repository, and one create ATTEMPT — the 422 was the answer.
    const githubRepoCount = await adminDb.githubRepo.count();
    expect(githubRepoCount).toBe(1);
  });

  it('refuses to adopt (and MOVE) a repository another tenant already holds', async () => {
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const otherRowId = await addRow(other, 'api', 'acme-api');
    await projectRepoProvisioningService.establishSet(other.projectId, other.ctx);
    expect(await readState(otherRowId, other)).toMatchObject({ state: 'created' });

    // A second tenant proposes a row with the SAME name. GitHub 422s (the repo
    // exists), and the existing repository is not theirs to take.
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACM' });
    const rowId = await addRow(fx, 'api', 'acme-api');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows[0]).toMatchObject({
      outcome: 'failed',
      failureCode: 'REPO_NAME_TAKEN_ON_HOST',
    });
    expect(await readState(rowId, fx)).toMatchObject({ state: 'failed', established: false });
    // The critical assertion: the first tenant's repo was NOT re-stamped onto the
    // second workspace. `upsert` re-stamps `workspace_id`, so mirroring another
    // tenant's repo would not merely mis-record it — it would MOVE it.
    const mirrored = await adminDb.githubRepo.findFirstOrThrow({ where: { name: 'acme-api' } });
    expect(mirrored.workspaceId).toBe(other.workspaceId);
    const githubRepoCount = await adminDb.githubRepo.count();
    expect(githubRepoCount).toBe(1);
  });
});

describe('the fleet runner variable (MOTIR-2015)', () => {
  it('ensures MOTIR_RUNNER on the ORG before any repository exists', async () => {
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // The variable a scaffolded repo's `runs-on` reads. Without it every
    // `${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}` resolves to `ubuntu-latest`,
    // no queued job's labels name the fleet, and `isMotirFleetJob` refuses every
    // job that will ever exist — the defect this card was filed for.
    expect(actionsVariables.variables.get(MOTIR_RUNNER_VARIABLE)).toEqual({
      name: MOTIR_RUNNER_VARIABLE,
      value: MOTIR_RUNNER_LABEL,
      visibility: 'private',
    });

    // BEFORE the repository, not after: an initialised row's CI-stub commit is a
    // push, which queues a job seconds after the repo appears. A variable written
    // afterwards would leave a project's very first job on GitHub-hosted.
    const firstVariableCall = calls.findIndex((c) => c.url.includes('/actions/variables'));
    const firstRepoCreate = calls.findIndex(
      (c) => c.method === 'POST' && (c.url.includes('/generate') || c.url.endsWith('/repos')),
    );
    expect(firstVariableCall).toBeGreaterThanOrEqual(0);
    expect(firstVariableCall).toBeLessThan(firstRepoCreate);
  });

  it('is ORG-scoped, never per repository — the property the handover rests on', async () => {
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');
    await addRow(fx, 'api', 'acme-api');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // A REPOSITORY variable would travel with the repo through MOTIR-711's
    // transfer and take precedence over the org's, leaving a handed-over repo
    // asking for a runner nobody will boot — every job queued until GitHub expires
    // it at 24h. Two rows, and still not one repo-scoped variable call.
    const variableCalls = calls.filter((c) => c.url.includes('/actions/variables'));
    expect(variableCalls.length).toBeGreaterThan(0);
    for (const call of variableCalls) {
      expect(call.url).toContain(`/orgs/${MOTIR_ORG}/actions/variables`);
      expect(call.url).not.toContain('/repos/');
    }
    // ...and it is ensured once for the RUN, not once per row.
    expect(actionsVariables.writeCalls()).toHaveLength(1);
  });

  it('a GitHub refusal never fails an establishment — the repository still lands', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');
    actionsVariables.failWith(403, 5);

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // ADR §4.2: a created repository cannot be rolled back, so nothing about the
    // fleet may turn a settled row into a failed one. Its CI simply runs
    // GitHub-hosted — exactly what the `|| 'ubuntu-latest'` fallback is for — until
    // a later establishment re-runs the ensure.
    expect(result.rows[0]).toMatchObject({ outcome: 'created' });
    expect(result.rows[0]!.row?.state).toBe('created');
  });
});

describe('the shipped chain is used, not extended', () => {
  it('indexes NOTHING at creation — a created repo holds only its seed (MOTIR-4589)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fx = await makeWorkItemFixture();
    const webId = await addRow(fx, 'web', 'acme-web');
    const apiId = await addRow(fx, 'api', 'acme-api');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // A repository Motir just seeded holds exactly its template, so its graph
    // would be the template's graph. No index is enqueued for either row...
    const send = vi.mocked(jobDispatcher.dispatchEventToEngine);
    expect(dispatchedEvents(send).map((e) => e.name)).not.toContain('system.code-graph-index');
    // ...and each row records the head its seed left, which is what a later push
    // is compared with. Read AFTER the CI stub, so the stub counts as seed.
    const rows = await adminDb.projectRepo.findMany({
      where: { id: { in: [webId, apiId] } },
      orderBy: { name: 'asc' },
      select: { name: true, seedHeadSha: true },
    });
    expect(rows).toEqual([
      { name: 'acme-api', seedHeadSha: 'seed-acme-api' },
      { name: 'acme-web', seedHeadSha: 'seed-acme-web' },
    ]);
    const stubAt = calls.findIndex((c) => c.method === 'PUT' && c.url.includes('acme-api'));
    const headAt = calls.findIndex((c) =>
      c.url.endsWith('/repos/motir-projects/acme-api/branches/main'),
    );
    expect(stubAt).toBeGreaterThanOrEqual(0);
    expect(headAt).toBeGreaterThan(stubAt);
    // The skip is legible: "not indexed yet", never an index failure.
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      expect.stringContaining('not indexed yet: no commit beyond the template'),
      `${MOTIR_ORG}/acme-web`,
      'seed-acme-web',
    );
  });

  it('enqueues the index through the EXISTING chokepoint when the seed head is unknown', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = await makeWorkItemFixture();
    const rowId = await addRow(fx, 'web', 'acme-web');
    unreadableHeads.add('acme-web');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // Unknown is never a reason to withhold an index: the row records no seed
    // head and the repository indexes as every repository did before MOTIR-4589 —
    // the same event name and payload shape `enqueueNewlyAddedRepos` produces.
    const row = await adminDb.projectRepo.findUniqueOrThrow({ where: { id: rowId } });
    expect(row.seedHeadSha).toBeNull();
    const sent = dispatchedEvents(vi.mocked(jobDispatcher.dispatchEventToEngine));
    expect(sent.map((e) => e.name)).toEqual(['system.code-graph-index']);
    expect(sent[0]!.data).toMatchObject({
      installationId: INSTALLATION_ID,
      workspaceId: fx.workspaceId,
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      defaultBranch: 'main',
    });
  });

  it('a queue blip never costs the repository — the enqueue is best-effort', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(jobDispatcher.dispatchEventToEngine).mockRejectedValue(new Error('queue down'));
    const fx = await makeWorkItemFixture();
    const rowId = await addRow(fx, 'web', 'acme-web');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows[0]).toMatchObject({ outcome: 'created' });
    expect(await readState(rowId, fx)).toMatchObject({ state: 'created', established: true });
  });

  it('never reconciles the shared installation — no other tenant’s repo is pruned', async () => {
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    await addRow(other, 'web', 'other-web');
    await projectRepoProvisioningService.establishSet(other.projectId, other.ctx);

    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACM' });
    await addRow(fx, 'web', 'acme-web');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // Both survive behind the ONE installation. A reconcile (`deleteExcept`) here
    // would have deleted the repos it did not fetch and leaked the ones it did.
    const rows = await adminDb.githubRepo.findMany({ orderBy: { name: 'asc' } });
    expect(rows.map((r) => [r.name, r.workspaceId])).toEqual([
      ['acme-web', fx.workspaceId],
      ['other-web', other.workspaceId],
    ]);
    // Never a call to the installation-repositories listing — the read a reconcile
    // would have to make.
    expect(calls.some((c) => c.url.includes('/installation/repositories'))).toBe(false);
  });
});

describe('the establish run is honest about what it did NOT do', () => {
  it('leaves a `creating` row to the run that claimed it', async () => {
    const fx = await makeWorkItemFixture();
    const rowId = await addRow(fx, 'web', 'acme-web');
    await projectRepoSetService.markCreating(rowId, fx.ctx);

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows[0]).toMatchObject({ outcome: 'not_attempted' });
    // It did not touch GitHub for that row at all.
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('repos'))).toBe(false);
    expect(await readState(rowId, fx)).toMatchObject({ state: 'creating' });
  });

  it('reports a `skipped` row as already settled and never creates for it', async () => {
    const fx = await makeWorkItemFixture();
    const skippedId = await addRow(fx, 'infra', 'acme-infra');
    await projectRepoSetService.skipRow(skippedId, fx.ctx);
    const liveId = await addRow(fx, 'web', 'acme-web');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows.map((r) => [r.rowId, r.outcome])).toEqual([
      [skippedId, 'already_settled'],
      [liveId, 'created'],
    ]);
    const githubRepoCount = await adminDb.githubRepo.count();
    expect(githubRepoCount).toBe(1);
  });

  it('fails every row, without throwing, when provisioning is not configured', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', '');
    const fx = await makeWorkItemFixture();
    const rowId = await addRow(fx, 'web', 'acme-web');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows[0]).toMatchObject({
      outcome: 'failed',
      failureCode: 'REPO_PROVISIONING_NOT_CONFIGURED',
    });
    // Resumable, not terminal: the row is `failed`, so wiring the deployment and
    // re-running completes it.
    expect(await readState(rowId, fx)).toMatchObject({ state: 'failed' });
  });

  it('LOSES the claim race deterministically: a row claimed after the read is not attempted', async () => {
    const fx = await makeWorkItemFixture();
    const oneId = await addRow(fx, 'web', 'acme-web');
    const twoId = await addRow(fx, 'api', 'acme-api');

    // The exact TOCTOU the claim closes, staged rather than raced: row 2 is
    // `proposed` when the set is READ, and another run claims it before this run
    // reaches its `markCreating`. The hop is legality-checked under the row's
    // lock, so this run loses it and backs off — WITHOUT having asked GitHub for
    // a repository.
    //
    // Deliberately not two concurrent `establishSet` calls: which one wins there
    // is a timing question, so the branch under test would only sometimes run.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        if (body?.['name'] === 'acme-web') await projectRepoSetService.markCreating(twoId, fx.ctx);
        return realFetch(url, init);
      }),
    );

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows.map((r) => [r.rowId, r.outcome])).toEqual([
      [oneId, 'created'],
      [twoId, 'not_attempted'],
    ]);
    // The loser left the row exactly as the winner holds it, and never created.
    expect(await readState(twoId, fx)).toMatchObject({ state: 'creating' });
    expect(existingRepos.has('acme-api')).toBe(false);
    const githubRepoCount = await adminDb.githubRepo.count();
    expect(githubRepoCount).toBe(1);
  });

  it('two runs racing the same set: one creates, the other backs off — never two repositories', async () => {
    const fx = await makeWorkItemFixture();
    const rowId = await addRow(fx, 'web', 'acme-web');

    // The same guard under a REAL race. Which run wins is timing, so this asserts
    // only the invariant that must hold either way; the branch itself is pinned
    // deterministically by the test above.
    const [a, b] = await Promise.all([
      projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx),
      projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx),
    ]);

    const outcomes = [a.rows[0]!.outcome, b.rows[0]!.outcome].sort();
    // The loser either never saw the row as claimable (`already_settled` on a
    // re-read) or lost the transition (`not_attempted`) — both are correct, and
    // both mean it did NOT create.
    expect(outcomes.filter((o) => o === 'created')).toHaveLength(1);
    expect(await readState(rowId, fx)).toMatchObject({ state: 'created', established: true });
    // The one assertion that matters: ONE repository.
    const githubRepoCount = await adminDb.githubRepo.count();
    expect(githubRepoCount).toBe(1);
    expect(existingRepos.size).toBe(1);
  });

  it('records an honest reason when the row is REMOVED while its repository is created', async () => {
    const fx = await makeWorkItemFixture();
    const rowId = await addRow(fx, 'web', 'acme-web');

    // A genuine concurrent edit: the user drops the row from the set while the
    // establish step is mid-flight. The repository still gets created — it is not
    // deleted to tidy the record (ADR §4.2) — and the run does not throw.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const res = await realFetch(url, init);
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        if (body?.['name'] === 'acme-web') await projectRepoSetService.removeRow(rowId, fx.ctx);
        return res;
      }),
    );

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows[0]).toMatchObject({
      outcome: 'failed',
      failureCode: 'PROJECT_REPO_NOT_FOUND',
    });
    expect(result.rows[0]!.failureReason).toContain('was created');
    expect(result.rows[0]!.row).toBeNull();
    // The repository exists and is mirrored; only the row is gone.
    const githubRepoCount = await adminDb.githubRepo.count();
    expect(githubRepoCount).toBe(1);
  });

  it('skips a row REMOVED before its claim, and still finishes the siblings', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = await makeWorkItemFixture();
    const oneId = await addRow(fx, 'web', 'acme-web');
    const twoId = await addRow(fx, 'api', 'acme-api');

    // The user drops row 2 while row 1 is still being created. Row 2 is then
    // unclaimable — and, being still `proposed`, it has no legal edge to `failed`
    // either, so the only honest answer is "not attempted", never an exception
    // that would abandon whatever came after it.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        if (body?.['name'] === 'acme-web') await projectRepoSetService.removeRow(twoId, fx.ctx);
        return realFetch(url, init);
      }),
    );

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows.map((r) => [r.rowId, r.outcome])).toEqual([
      [oneId, 'created'],
      [twoId, 'not_attempted'],
    ]);
    // A non-race claim failure is a real defect signal, so it is logged.
    expect(logged).toHaveBeenCalled();
    // Row 1 still got its repository; row 2 never reached GitHub.
    const githubRepoCount = await adminDb.githubRepo.count();
    expect(githubRepoCount).toBe(1);
    expect(existingRepos.has('acme-api')).toBe(false);
  });

  // ⚠️ INVERTED, NOT DELETED (Story MOTIR-4669 · MOTIR-4648). This case was
  // titled *"refuses to hand one repository to a SECOND project of the same
  // workspace"* and asserted `outcome: 'failed'` with
  // `failureCode: 'REALIZED_REPO_ALREADY_CLAIMED'`, on the reasoning: *"two
  // projects in ONE workspace, so the cross-tenant guard cannot fire and the
  // `github_repo_id` unique index is what has to hold the line."*
  //
  // There is no line to hold any more. A repository belongs to the ORGANISATION
  // and which projects use it is visibility configuration, so a second project
  // taking up an existing repository is THE FEATURE — and the old assertion, left
  // standing, would pin the product to refusing it. The previous contract is kept
  // above so a reader meeting the inversion can see what it replaced.
  it('lets a SECOND project of the same workspace take up the same repository, with no second repo', async () => {
    const fx = await makeWorkItemFixture();
    const first = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'shared-api' },
      fx.ctx,
    );
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    expect(await readState(first.id, fx)).toMatchObject({ state: 'created' });

    const second = await createSecondProject(fx);
    const rowId = (
      await projectRepoSetService.addRow(second, { role: 'api', name: 'shared-api' }, fx.ctx)
    ).id;

    const result = await projectRepoProvisioningService.establishSet(second, fx.ctx);

    // It ADOPTS the repository that already exists rather than failing on it.
    expect(result.rows[0]).toMatchObject({ rowId, outcome: 'adopted' });
    const rows = await projectRepoSetService.listByProject(second, fx.ctx);
    expect(rows.find((r) => r.id === rowId)).toMatchObject({ state: 'created', established: true });

    // The first project keeps it — neither takes it from the other.
    expect(await readState(first.id, fx)).toMatchObject({ state: 'created', established: true });

    // ⚠️ AND THERE IS STILL EXACTLY ONE `GithubRepo`. This assertion is the one
    // that survived the inversion unchanged, and it is the story's whole promise:
    // a second project picking up a repository costs nothing, because there is no
    // second repository and therefore no second index.
    expect(await adminDb.githubRepo.count()).toBe(1);
  });

  it('reports honestly when the actor loses ACCESS mid-run — the repository still exists', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = await makeWorkItemFixture();
    const rowId = await addRow(fx, 'web', 'acme-web');

    // The actor is removed from the workspace while their repository is being
    // created. Every write after that point is refused — including the one that
    // would record the failure — and the repository on GitHub is NOT deleted to
    // make the record tidy (ADR §4.2).
    //
    // ⚠️ The actor here created the workspace, which makes them the ORG OWNER, and
    // the Owner reaches every workspace of the org member or not (MOTIR-6308). So
    // dropping the workspace membership alone no longer revokes anything: the
    // actor leaves the ORGANIZATION as well, which ends every reach.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        if (body?.['name'] === 'acme-web') {
          await adminDb.workspaceMembership.deleteMany({
            where: { userId: fx.ownerId, workspaceId: fx.workspaceId },
          });
          const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
            where: { id: fx.workspaceId },
            select: { organizationId: true },
          });
          await adminDb.organizationMembership.deleteMany({
            where: { userId: fx.ownerId, organizationId },
          });
        }
        return realFetch(url, init);
      }),
    );

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // An unclassifiable failure gets the generic sentence and the `UNEXPECTED`
    // code; the detail goes to the log, never to the row.
    expect(result.rows[0]).toMatchObject({
      rowId,
      outcome: 'failed',
      failureCode: 'UNEXPECTED',
    });
    expect(result.rows[0]!.failureReason).toContain('acme-web');
    // The failure could not even be written to the row — which is logged and
    // survived, not thrown.
    expect(result.rows[0]!.row).toBeNull();
    expect(logged).toHaveBeenCalled();
    // The repository exists and is mirrored. Read raw: the actor can no longer
    // read through the service at all.
    const githubRepoCount = await adminDb.githubRepo.count();
    expect(githubRepoCount).toBe(1);
    await expect(
      adminDb.projectRepo.findUniqueOrThrow({ where: { id: rowId } }),
    ).resolves.toMatchObject({ state: 'creating' });
  });

  it('returns an empty result for a project with no set at all', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx),
    ).resolves.toEqual({ projectId: fx.projectId, rows: [] });
  });
});

describe('no long transaction wraps the external calls', () => {
  it('commits each row’s outcome as it resolves, so a crash mid-set is readable', async () => {
    const fx = await makeWorkItemFixture();
    const oneId = await addRow(fx, 'web', 'acme-web');
    const twoId = await addRow(fx, 'api', 'acme-api');

    // Observe the DB from OUTSIDE the run, at the moment row 2 reaches GitHub. If
    // any transaction spanned the host calls, row 1's `created` would be
    // invisible here — which is exactly the property ADR §4.2 requires, and the
    // only reason the resume path above can work.
    let seenDuringRowTwo: { state: string; established: boolean } | null = null;
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        if (body?.['name'] === 'acme-api' && (init?.method ?? 'GET') === 'POST') {
          const rows = await withWorkspaceContext(
            { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
            (tx) => githubRepoRepository.listByWorkspace(fx.workspaceId, tx),
          );
          const row = await readState(oneId, fx);
          seenDuringRowTwo = {
            state: row.state,
            established: row.established && rows.some((r) => r.name === 'acme-web'),
          };
        }
        return realFetch(url, init);
      }),
    );

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(seenDuringRowTwo).toEqual({ state: 'created', established: true });
    expect(await readState(twoId, fx)).toMatchObject({ state: 'created' });
  });
});

// ── THE PAID-AI-PLAN GATE (MOTIR-6906 · MOTIR-6909) ─────────────────────────
// Motir-hosted repositories are paid-AI-plan only. The refusal lands BEFORE any
// GitHub call, so an unpaid org never gets a repository, a runner group or a
// variable. (The plan read itself is tested in `tests/ciFleet/aiPlanGate.test.ts`;
// off-cloud, which the rest of this file runs as, the gate passes everyone.)
describe('the paid-AI-plan gate at establish', () => {
  it('refuses ai_plan_required, with the §4 words, before touching GitHub', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'true');
    const hasPaid = vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValue(false);
    const fx = await makeWorkItemFixture();
    const rowId = await addRow(fx, 'web', 'acme-web');

    const attempt = projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    await expect(attempt).rejects.toBeInstanceOf(AiPlanRequiredError);
    await expect(attempt).rejects.toThrow(AI_PLAN_REQUIRED_ESTABLISH_MESSAGE);
    expect(hasPaid).toHaveBeenCalledWith(fx.workspace.organizationId);
    expect(calls).toEqual([]);
    expect((await readState(rowId, fx)).established).toBe(false);
  });

  it('refuses plan_unknown when the plan cannot be read, before touching GitHub', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'true');
    vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValue('unknown');
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'web', 'acme-web');

    const attempt = projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    await expect(attempt).rejects.toBeInstanceOf(AiPlanUnknownError);
    await expect(attempt).rejects.toThrow(PLAN_UNKNOWN_ESTABLISH_MESSAGE);
    expect(calls).toEqual([]);
  });

  it('creates the repository for a paid org', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'true');
    vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValue(true);
    const fx = await makeWorkItemFixture();
    const rowId = await addRow(fx, 'web', 'acme-web');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows[0]).toMatchObject({ rowId, outcome: 'created' });
  });
});

// THE TENANT'S ASSIGNED GITHUB ORG (Story MOTIR-8953 · MOTIR-8966). A GitHub that
// serves TWO orgs — the fallback org and a second Motir-owned org named by an
// active fleet account — so where each call lands can be asserted, and the
// installation every token was minted for.
describe('an organisation hosted in its assigned GitHub org (MOTIR-8966)', () => {
  const HOST_ORG = 'motir-host-a';
  const HOST_INSTALLATION = '7788';
  let hostGroups: RunnerGroupFake;
  let hostVariables: ActionsVariableFake;
  let mintedFor: string[];
  let failingInstallations: Set<string>;
  let createdIn: Map<string, Map<string, number>>;

  function installTwoOrgGitHub(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const u = String(url);
        const method = init?.method ?? 'GET';
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        calls.push({ url: u, method, body });

        if (u.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
          return json(200, { id: Number(INSTALLATION_ID) });
        }
        const token = /\/app\/installations\/([^/]+)\/access_tokens$/.exec(u);
        if (token) {
          mintedFor.push(token[1]!);
          if (failingInstallations.has(token[1]!)) return json(401, { message: 'Bad credentials' });
          return json(200, {
            token: `ghs_${token[1]}`,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          });
        }
        for (const fake of [runnerGroups, hostGroups]) {
          const group = await fake.handle(u, method, body);
          if (group) return group;
        }
        for (const fake of [actionsVariables, hostVariables]) {
          const variable = fake.handle(u, method, body);
          if (variable) return variable;
        }
        const create = /\/orgs\/([^/]+)\/repos$/.exec(u);
        if (method === 'POST' && (create || u.includes('/generate'))) {
          const org = create ? create[1]! : String(body?.['owner']);
          const name = String(body?.['name']);
          const id = nextRepoId++;
          const repos = createdIn.get(org) ?? new Map<string, number>();
          repos.set(name, id);
          createdIn.set(org, repos);
          return json(201, { id, name, owner: { login: org } });
        }
        const read = /\/repos\/([^/]+)\/([^/]+)$/.exec(u);
        if (method === 'GET' && read) {
          const id = createdIn.get(read[1]!)?.get(read[2]!);
          if (!id) return json(404, { message: 'Not Found' });
          return json(200, {
            id,
            name: read[2],
            owner: { login: read[1] },
            default_branch: 'main',
            private: true,
          });
        }
        if (method === 'PUT') return json(201, { content: {} });
        throw new Error(`unexpected fetch: ${method} ${u}`);
      }),
    );
  }

  async function hostAccount(): Promise<void> {
    await adminDb.fleetShard.create({
      data: {
        name: `acct-${HOST_ORG}`,
        fleetKind: 'ci_runner',
        provider: 'fly',
        state: 'active',
        githubOrg: HOST_ORG,
        githubInstallationId: HOST_INSTALLATION,
        flyOrg: 'motir',
        flyApp: 'motir-ci-host-a',
        flyRegion: 'iad',
        machineLimit: 10,
        credentialRef: 'FLEET_SHARD_TEST_TOKEN',
        githubRegistrationsPer5Min: 3_100,
      },
    });
  }

  async function hostedOf(fx: WorkItemFixture): Promise<string | null> {
    const org = await adminDb.organization.findUniqueOrThrow({
      where: { id: fx.workspace.organizationId },
    });
    return org.hostedGithubOrg;
  }

  beforeEach(async () => {
    await adminDb.fleetShard.deleteMany({});
    hostGroups = createRunnerGroupFake(HOST_ORG);
    hostVariables = createActionsVariableFake(HOST_ORG);
    mintedFor = [];
    failingInstallations = new Set();
    createdIn = new Map();
    installTwoOrgGitHub();
  });

  it('with no account naming a GitHub org, everything lands in the fallback org as before', async () => {
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'api', 'acme-api');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows[0]).toMatchObject({ outcome: 'created' });
    expect(createdIn.get(MOTIR_ORG)?.has('acme-api')).toBe(true);
    expect(await hostedOf(fx)).toBeNull();
    expect(hostGroups.groups.size).toBe(0);
    expect(hostVariables.calls).toHaveLength(0);
  });

  it('the first establish assigns the org and makes the group, the variable and the repo THERE', async () => {
    await hostAccount();
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'api', 'acme-api');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows[0]).toMatchObject({ outcome: 'created' });
    expect(await hostedOf(fx)).toBe(HOST_ORG);

    // The repo: created through the assigned org's endpoint and installation.
    const create = calls.findIndex(
      (c) => c.method === 'POST' && c.url.endsWith(`/orgs/${HOST_ORG}/repos`),
    );
    expect(create).toBeGreaterThanOrEqual(0);
    expect(createdIn.get(MOTIR_ORG)).toBeUndefined();
    expect(mintedFor).toContain(HOST_INSTALLATION);
    expect(result.rows[0]!.row?.realizedRepo).toMatchObject({ owner: HOST_ORG, name: 'acme-api' });
    const installation = await adminDb.githubInstallation.findFirstOrThrow({
      where: { accountLogin: HOST_ORG },
    });
    expect(installation.installationId).toBe(HOST_INSTALLATION);

    // The group: in the assigned org BEFORE the first repository, stored keyed by
    // that org; and no group made in the fallback org for this project.
    const groupCreate = calls.findIndex(
      (c) => c.method === 'POST' && c.url.endsWith(`/orgs/${HOST_ORG}/actions/runner-groups`),
    );
    expect(groupCreate).toBeGreaterThanOrEqual(0);
    expect(groupCreate).toBeLessThan(create);
    const stored = await adminDb.projectRunnerGroup.findFirstOrThrow({
      where: { projectId: fx.projectId },
    });
    expect(stored).toMatchObject({ org: HOST_ORG, installationId: HOST_INSTALLATION });
    expect(runnerGroups.groups.size).toBe(0);
    expect(
      (await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } })).runnerGroupId,
    ).toBeNull();

    // The variable: the fleet label, in the assigned org, before the repository.
    expect(hostVariables.variables.get(MOTIR_RUNNER_VARIABLE)?.value).toBe(MOTIR_RUNNER_LABEL);
    const variableCall = calls.findIndex((c) =>
      c.url.includes(`/orgs/${HOST_ORG}/actions/variables`),
    );
    expect(variableCall).toBeLessThan(create);
    expect(actionsVariables.calls).toHaveLength(0);
  });

  it('an organisation already hosted in the fallback org stays there (existing_hosting)', async () => {
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'api', 'acme-api');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    await hostAccount();
    await addRow(fx, 'infra', 'acme-infra');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows.find((r) => r.name === 'acme-infra')).toMatchObject({ outcome: 'created' });
    expect(createdIn.get(MOTIR_ORG)?.has('acme-infra')).toBe(true);
    expect(createdIn.get(HOST_ORG)).toBeUndefined();
    expect(await hostedOf(fx)).toBeNull();
  });

  it('a failed mint for the assigned org fails the row, and nothing reaches the fallback org', async () => {
    await hostAccount();
    failingInstallations.add(HOST_INSTALLATION);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'api', 'acme-api');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows[0]).toMatchObject({
      outcome: 'failed',
      failureCode: 'REPO_HOST_ORG_UNAVAILABLE',
    });
    expect(result.rows[0]!.row?.state).toBe('failed');
    expect(createdIn.size).toBe(0);
    expect(calls.filter((c) => c.method !== 'GET' && c.url.includes(`/${MOTIR_ORG}/`))).toEqual([]);
  });

  it('an assigned org no account names any more fails every row, and nothing is created', async () => {
    vi.spyOn(fleetGithubOrgAssignmentService, 'ensureHostedGithubOrg').mockResolvedValue({
      outcome: 'already_assigned',
      githubOrg: 'motir-host-gone',
      target: null,
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'api', 'acme-api');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows[0]).toMatchObject({
      outcome: 'failed',
      failureCode: 'REPO_HOST_ORG_UNAVAILABLE',
    });
    expect(createdIn.size).toBe(0);
  });

  it('an organisation already assigned an org with an account row is hosted there', async () => {
    const target = {
      org: HOST_ORG,
      installationId: HOST_INSTALLATION,
      role: 'provisioning' as const,
    };
    vi.spyOn(fleetGithubOrgAssignmentService, 'ensureHostedGithubOrg').mockResolvedValue({
      outcome: 'already_assigned',
      githubOrg: HOST_ORG,
      target,
    });
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'api', 'acme-api');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows[0]).toMatchObject({ outcome: 'created' });
    expect(createdIn.get(HOST_ORG)?.has('acme-api')).toBe(true);
  });

  // A run that will create nothing READS the assignment and never makes one.
  it.each([
    ['no assignment', null],
    ['an assignment no account names', { githubOrg: 'motir-host-gone', target: null }],
    [
      'an assignment with its account',
      {
        githubOrg: HOST_ORG,
        target: { org: HOST_ORG, installationId: HOST_INSTALLATION, role: 'provisioning' as const },
      },
    ],
  ])('a run with nothing to create reads %s and assigns nothing', async (_label, current) => {
    const read = vi
      .spyOn(fleetGithubOrgAssignmentService, 'readHostedGithubOrg')
      .mockResolvedValue(current);
    const ensure = vi.spyOn(fleetGithubOrgAssignmentService, 'ensureHostedGithubOrg');
    const fx = await makeWorkItemFixture();
    const skippedId = await addRow(fx, 'infra', 'acme-infra');
    await projectRepoSetService.skipRow(skippedId, fx.ctx);

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows.map((r) => r.outcome)).toEqual(['already_settled']);
    expect(read).toHaveBeenCalledWith(fx.workspace.organizationId);
    expect(ensure).not.toHaveBeenCalled();
    expect(createdIn.size).toBe(0);
  });

  it('a single-row run decides from THAT row alone', async () => {
    const read = vi
      .spyOn(fleetGithubOrgAssignmentService, 'readHostedGithubOrg')
      .mockResolvedValue(null);
    const fx = await makeWorkItemFixture();
    const skippedId = await addRow(fx, 'infra', 'acme-infra');
    await projectRepoSetService.skipRow(skippedId, fx.ctx);
    const liveId = await addRow(fx, 'web', 'acme-web');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx, {
      rowId: skippedId,
    });

    expect(result.rows.map((r) => [r.rowId, r.outcome])).toEqual([
      [skippedId, 'already_settled'],
      [liveId, 'not_attempted'],
    ]);
    expect(read).toHaveBeenCalled();
  });
});

// ── MOTIR-708 — every seed RESOLVES through the registry ────────────────────
describe('seeds resolve through the seed registry (MOTIR-708)', () => {
  const TEST_TEMPLATE = { owner: 'motir-co', repo: 'acme-test-template' };

  async function registerTemplate(key: string, status: 'active' | 'retired' = 'active') {
    await adminDb.seedRegistryEntry.create({
      data: {
        key,
        role: 'web',
        stack: 'nextjs',
        label: 'Test starter',
        templateOwner: TEST_TEMPLATE.owner,
        templateRepo: TEST_TEMPLATE.repo,
        useCases: ['mvp'],
        sizes: ['small'],
        hostingTargets: ['fly'],
        status,
      },
    });
  }

  async function rowWithSeed(fx: WorkItemFixture, seedSource: string): Promise<string> {
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web', seedSource },
      fx.ctx,
    );
    return row.id;
  }

  const creates = () =>
    calls.filter(
      (c) =>
        c.method === 'POST' &&
        (c.url.includes('/generate') || c.url.endsWith(`/orgs/${MOTIR_ORG}/repos`)),
    );

  it('a row still storing the OLD starter key establishes exactly as before, from the renamed template', async () => {
    const fx = await makeWorkItemFixture();
    const rowId = await rowWithSeed(fx, 'nextjs-prisma-vercel-starter');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows.map((r) => r.outcome)).toEqual(['created']);
    const [generate] = creates();
    expect(generate!.url).toBe(
      'https://api.github.com/repos/motir-co/nextjs-prisma-serverless-starter/generate',
    );
    expect(generate!.body).toEqual({
      owner: MOTIR_ORG,
      name: 'acme-web',
      description: `The web repository for ${fx.project.name}. Created by Motir.`,
      private: true,
      include_all_branches: false,
    });
    // The row keeps what it stored; establish resolves, it does not rewrite.
    expect((await readState(rowId, fx)).seedSource).toBe('nextjs-prisma-vercel-starter');
  });

  it('an ACTIVE template entry is generated from THAT entry’s owner/repo', async () => {
    const fx = await makeWorkItemFixture();
    await registerTemplate('acme-test-starter');
    await rowWithSeed(fx, 'acme-test-starter');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows.map((r) => r.outcome)).toEqual(['created']);
    expect(creates().map((c) => c.url)).toEqual([
      'https://api.github.com/repos/motir-co/acme-test-template/generate',
    ]);
  });

  it('an UNKNOWN key fails the row naming it, creates nothing, and a retry succeeds once the entry exists', async () => {
    const fx = await makeWorkItemFixture();
    const rowId = await rowWithSeed(fx, 'acme-test-starter');

    const first = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    expect(first.rows[0]).toMatchObject({ outcome: 'failed', failureCode: 'SEED_ENTRY_UNKNOWN' });
    const failed = await readState(rowId, fx);
    expect(failed.state).toBe('failed');
    expect(failed.failureReason).toContain('acme-test-starter');
    // No repository from a guessed default.
    expect(creates()).toEqual([]);

    await registerTemplate('acme-test-starter');
    const retry = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    expect(retry.rows.map((r) => r.outcome)).toEqual(['created']);
    expect(creates().map((c) => c.url)).toEqual([
      'https://api.github.com/repos/motir-co/acme-test-template/generate',
    ]);
  });

  it('a RETIRED entry fails the row naming it, and a retry succeeds once it is active again', async () => {
    const fx = await makeWorkItemFixture();
    await registerTemplate('acme-test-starter', 'retired');
    const rowId = await rowWithSeed(fx, 'acme-test-starter');

    const first = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    expect(first.rows[0]).toMatchObject({ outcome: 'failed', failureCode: 'SEED_ENTRY_RETIRED' });
    expect((await readState(rowId, fx)).failureReason).toContain('acme-test-starter');
    expect(creates()).toEqual([]);

    await adminDb.seedRegistryEntry.update({
      where: { key: 'acme-test-starter' },
      data: { status: 'active' },
    });
    const retry = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    expect(retry.rows.map((r) => r.outcome)).toEqual(['created']);
  });

  it('a template GitHub REFUSES fails the row naming the entry, and a retry succeeds once it is fixed', async () => {
    const fx = await makeWorkItemFixture();
    await registerTemplate('acme-test-starter');
    missingTemplates.add(`${TEST_TEMPLATE.owner}/${TEST_TEMPLATE.repo}`);
    const rowId = await rowWithSeed(fx, 'acme-test-starter');

    const first = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    expect(first.rows[0]).toMatchObject({
      outcome: 'failed',
      failureCode: 'SEED_TEMPLATE_UNAVAILABLE',
    });
    const failed = await readState(rowId, fx);
    expect(failed.failureReason).toContain('acme-test-starter');
    expect(failed.failureReason).toContain('motir-co/acme-test-template');
    // Never an initialised repository instead.
    expect(calls.some((c) => c.url.endsWith(`/orgs/${MOTIR_ORG}/repos`))).toBe(false);

    missingTemplates.clear();
    const retry = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    expect(retry.rows.map((r) => r.outcome)).toEqual(['created']);
  });
});

describe('the project’s stored design choice reaches a design-system repo (MOTIR-1529)', () => {
  const CHOICE = { styleId: 'neo-brutalism', paletteId: 'cobalt', typeId: 'grotesk' };
  const MANIFEST = `${JSON.stringify({ styleId: 'warm-editorial', paletteId: 'motir', typeId: 'motir' }, null, 2)}\n`;

  /** Put a design-system starter and motir-ai in front of the suite's GitHub:
   *  the template carries the manifest, the git data API accepts one commit, and
   *  `GET /v1/preplan` answers `preplan` (or fails when it is null). */
  function wearDesignSystem(preplan: Response | null): void {
    vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc');
    const github = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.startsWith('https://ai.test/v1/preplan')) {
        calls.push({ url: u, method, body: null });
        if (!preplan) return json(503, { type: 'about:blank', title: 'down', status: 503 });
        return preplan;
      }
      if (u.includes('/contents/motir.design.json')) {
        return json(200, { content: Buffer.from(MANIFEST).toString('base64') });
      }
      if (u.includes('/contents/DESIGN.md')) return json(404, { message: 'Not Found' });
      if (u.endsWith('/git/ref/heads/main')) return json(200, { object: { sha: 'head1' } });
      if (u.endsWith('/git/commits/head1')) return json(200, { tree: { sha: 'tree1' } });
      if (u.includes('/git/')) {
        calls.push({
          url: u,
          method,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        });
        return json(method === 'PATCH' ? 200 : 201, { sha: `${method}-sha` });
      }
      return github(url as string, init);
    });
  }

  function writtenManifest(): unknown {
    const tree = calls.find((c) => c.url.endsWith('/git/trees'))!;
    const entries = tree.body?.['tree'] as { path: string; content: string }[];
    return JSON.parse(entries.find((e) => e.path === 'motir.design.json')!.content);
  }

  it('reads the choice from the pre-plan session and commits it to the web row', async () => {
    wearDesignSystem(
      json(200, { session: { designChoice: CHOICE }, docs: [], revisions: [], diffs: [] }),
    );
    const fx = await makeWorkItemFixture();
    const rowId = await addRow(fx, 'web', 'acme-web');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows[0]).toMatchObject({ rowId, outcome: 'created' });
    const read = calls.find((c) => c.url.startsWith('https://ai.test/v1/preplan'))!;
    expect(read.url).toContain(`coreProjectId=${fx.projectId}`);
    expect(writtenManifest()).toEqual(CHOICE);
    expect(calls.filter((c) => c.url.endsWith('/git/commits') && c.method === 'POST')).toHaveLength(
      1,
    );
  });

  it('an unreachable motir-ai means the registry defaults, and the row is still created', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    wearDesignSystem(null);
    const fx = await makeWorkItemFixture();
    const rowId = await addRow(fx, 'web', 'acme-web');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows[0]).toMatchObject({ rowId, outcome: 'created' });
    expect(writtenManifest()).toEqual({
      styleId: 'warm-editorial',
      paletteId: 'motir',
      typeId: 'motir',
    });
  });

  it('a failed design commit fails the row with its reason', async () => {
    wearDesignSystem(json(200, { session: { designChoice: CHOICE }, docs: [] }));
    const designed = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) =>
      String(url).endsWith('/git/refs/heads/main')
        ? json(500, { message: 'boom' })
        : designed(url as string, init),
    );
    const fx = await makeWorkItemFixture();
    const rowId = await addRow(fx, 'web', 'acme-web');

    const result = await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(result.rows[0]).toMatchObject({
      rowId,
      outcome: 'failed',
      failureCode: 'DESIGN_CHOICE_NOT_APPLIED',
    });
    expect((await readState(rowId, fx)).state).toBe('failed');
  });

  it('a row seeded with no template makes no design call and no extra commit', async () => {
    wearDesignSystem(json(200, { session: { designChoice: CHOICE }, docs: [] }));
    const fx = await makeWorkItemFixture();
    await addRow(fx, 'api', 'acme-api');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    expect(calls.some((c) => c.url.includes('/git/'))).toBe(false);
  });
});

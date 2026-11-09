import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import type { ProjectStateDto } from '@/lib/dto/projectState';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
import { GET_PROJECT_STATE_TOOL_NAME } from '@/lib/mcp/tools/getProjectState';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { organizationContentLanguageService } from '@/lib/services/organizationContentLanguageService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { organizationIdOf } from '../helpers/organizationOf';

// `get_project_state` (MOTIR-1968) over real Postgres — the project-CONFIGURATION
// read a planning agent needs to VERIFY a tenant precondition instead of
// asserting one.
//
// The assertions, in order of what would hurt most if it broke:
//  1. TENANCY — a context bound to workspace A cannot read workspace B's project
//     state, and `projectKey` is not a way around the binding. This is the whole
//     reason the tool takes a key at all rather than a workspace.
//  2. "NOTHING CONFIGURED" IS AN ANSWER — an unconfigured project returns a
//     well-formed, fully-populated verdict, never an error and never an omitted
//     field. A planner has to be able to tell "no code" from "could not look";
//     that distinction is the card's whole point.
//  3. THE INDEX VERDICT IS THE LEDGER'S — indexed vs queued per repo, including
//     the MOTIR-1961 case (a repo connected before the index feature shipped has
//     no succeeded run and must report `queued`, which is what was twice
//     asserted away).
//  4. THE ESTABLISHED VERDICT IS `resolvePlanningHostGate`'s — proven by moving
//     the marker and watching the reported verdict follow, not by re-deriving it.
//  5. NO N+1 — the ledger is read ONCE regardless of how many repos are granted.
//
// Built with a FIXED-context resolver over the in-memory transport (the
// list-projects.test.ts pattern): the bearer plumbing is auth.test.ts's job and
// the scope narrowing is scope-gate.test.ts's, so this file exercises the tool.

/** Connect an in-memory MCP client to a server bound to `ctx` (no scope gate). */
async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'get-project-state-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** Call the tool through the transport and return the raw tool result. */
async function callTool(ctx: ServiceContext, projectKey: string): Promise<CallToolResult> {
  const client = await connectClient(ctx);
  try {
    return (await client.callTool({
      name: GET_PROJECT_STATE_TOOL_NAME,
      arguments: { projectKey },
    })) as CallToolResult;
  } finally {
    await client.close();
  }
}

/** The state DTO out of a successful result. */
function stateOf(res: CallToolResult): ProjectStateDto {
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return res.structuredContent as unknown as ProjectStateDto;
}

/** Seed ONE GitHub connection for the fixture's ORGANISATION (one per workspace —
 *  repos meant to be visible together MUST share it).
 *
 *  ⚠️ `organizationId` is set because production sets it: `persistInstallation`
 *  resolves it from the workspace row (MOTIR-4649), and the connection is read at
 *  the ORGANISATION tier (MOTIR-4838). A fixture that leaves it null is not
 *  describing the system — it is describing the state the column's nullability
 *  permits for exactly ONE row, Motir's shared provisioning installation, which
 *  is owned by no tenant. Same reason `organizationIdOf` exists for
 *  `github_repo`. */
async function seedInstallation(fx: WorkItemFixture) {
  const rand = randomToken(6);
  return adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${rand}`,
      workspaceId: fx.workspaceId,
      organizationId: await organizationIdOf(fx.workspaceId),
      accountLogin: 'moooon-B-V',
      accountType: 'Organization',
    },
  });
}

/** Seed a repo under an existing installation; returns its `owner/name` ref. */
async function seedRepo(
  inst: { id: string; workspaceId: string | null },
  owner: string,
  name: string,
): Promise<string> {
  if (!inst.workspaceId) throw new Error('seedRepo needs a workspace-bound installation');
  const rand = randomToken(6);
  await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: inst.workspaceId,
      organizationId: await organizationIdOf(inst.workspaceId),
      repoId: `repo-${rand}`,
      owner,
      name,
      defaultBranch: 'main',
      archived: false,
    },
  });
  return `${owner}/${name}`;
}

/** Seed a SUCCEEDED `system.code-graph-index` run for a repo (the ledger row the
 *  `indexed` verdict is read from). */
async function seedSucceededIndexJob(fx: WorkItemFixture, repoRef: string) {
  await adminDb.jobRun.create({
    data: {
      workspaceId: fx.workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'system.code-graph-index',
      eventId: `evt-${randomToken()}`,
      lane: 'engine',
      attempt: 0,
      status: 'succeeded',
      finishedAt: new Date(),
      output: { indexed: true, repoRef, projectsIndexed: 1 },
    },
  });
}

/** Seed a RUNNING index run — no `repoRef` (the job writes `output` only on
 *  success), which is why in-flight is a set-level flag and not per-repo. */
async function seedRunningIndexJob(fx: WorkItemFixture) {
  await adminDb.jobRun.create({
    data: {
      workspaceId: fx.workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'system.code-graph-index',
      eventId: `evt-${randomToken()}`,
      lane: 'engine',
      attempt: 0,
      status: 'running',
      output: {},
    },
  });
}

beforeEach(async () => {
  await truncateJobRuns();
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('get_project_state — registration', () => {
  it('is advertised with an input schema and is a `read`-scoped tool', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();

    const tool = tools.find((t) => t.name === GET_PROJECT_STATE_TOOL_NAME);
    expect(tool, 'get_project_state is not registered').toBeTruthy();
    expect(tool!.inputSchema).toBeTruthy();
    // Carried in the exported list, so the scope map's totality guard covers it.
    expect(MCP_TOOL_NAMES).toContain(GET_PROJECT_STATE_TOOL_NAME);
    expect(TOOL_SCOPES[GET_PROJECT_STATE_TOOL_NAME]).toBe('read');
    await client.close();
  });
});

describe('get_project_state — a project with NOTHING configured', () => {
  it('answers in full: no installation, no repos, no set, no onboarding run — and no error', async () => {
    const fx = await makeWorkItemFixture();

    const state = stateOf(await callTool(fx.ctx, fx.projectIdentifier));

    // The project half identifies what was read, marker included.
    expect(state.project).toEqual({
      key: fx.projectIdentifier,
      id: fx.projectId,
      name: fx.project.name,
      onboardingRanAt: null,
    });
    // Never onboarded → the gate says onboarding still owns this project.
    expect(state.planningGate).toBe('onboarding');
    // EVERY field present. "No code" is reported, not omitted — a planner must
    // be able to distinguish it from "the read failed".
    expect(state.code).toEqual({
      installed: false,
      index: {
        repos: [],
        indexedCount: 0,
        failedCount: 0,
        total: 0,
        hasRunning: false,
        allIndexed: false,
      },
    });
    expect(state.repoSet).toEqual([]);
    expect(state.onboarding).toBeNull();
    // `allIndexed` is false for an empty set: "every one of zero repos is
    // indexed" is true and useless, and a planner reading it as a green light
    // would be exactly wrong.
    expect(state.code.index.allIndexed).toBe(false);
  });

  it('an installation whose grant covers NO repos is distinguishable from no installation', async () => {
    const fx = await makeWorkItemFixture();
    await seedInstallation(fx);

    const state = stateOf(await callTool(fx.ctx, fx.projectIdentifier));
    // The two states have different fixes — widen the grant vs. install the App
    // — so they must not collapse to one answer.
    expect(state.code.installed).toBe(true);
    expect(state.code.index.total).toBe(0);
  });

  it('an unknown key is a clean not-found tool error, not a crash', async () => {
    const fx = await makeWorkItemFixture();
    const res = await callTool(fx.ctx, 'NOPE');
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('PROJECT_NOT_FOUND');
  });
});

describe('get_project_state — the onboarding verdict follows `resolvePlanningHostGate`', () => {
  it('stamping the marker flips the reported gate from `onboarding` to `workspace`', async () => {
    const fx = await makeWorkItemFixture();

    expect(stateOf(await callTool(fx.ctx, fx.projectIdentifier)).planningGate).toBe('onboarding');

    // Move the ONE input the gate keys on — the marker `markOnboardingRan`
    // writes — and the reported verdict must follow it, because it IS the gate's
    // verdict rather than a re-derivation that could drift from it.
    await withWorkspaceContext(fx.ctx, async (tx) => {
      await projectRepository.markOnboardingRan(fx.projectId, new Date(), tx);
    });

    const after = stateOf(await callTool(fx.ctx, fx.projectIdentifier));
    expect(after.planningGate).toBe('workspace');
    expect(after.project.onboardingRanAt).toBeTruthy();
  });
});

describe('get_project_state — the index verdict is the ledger`s', () => {
  it('reports indexed vs queued per repo, with the aggregate in-flight flag', async () => {
    const fx = await makeWorkItemFixture();
    const inst = await seedInstallation(fx);
    const indexed = await seedRepo(inst, 'moooon-B-V', 'motir-core');
    const pending = await seedRepo(inst, 'moooon-B-V', 'motir-ai');
    await seedSucceededIndexJob(fx, indexed);
    await seedRunningIndexJob(fx);

    const state = stateOf(await callTool(fx.ctx, fx.projectIdentifier));

    expect(state.code.installed).toBe(true);
    expect(state.code.index.repos).toEqual(
      expect.arrayContaining([
        { provider: 'github', repoRef: indexed, status: 'indexed' },
        { provider: 'github', repoRef: pending, status: 'queued' },
      ]),
    );
    expect(state.code.index.indexedCount).toBe(1);
    expect(state.code.index.total).toBe(2);
    // A running row carries no repoRef, so in-flight is a SET-level fact.
    expect(state.code.index.hasRunning).toBe(true);
    expect(state.code.index.allIndexed).toBe(false);
  });

  it('a repo connected BEFORE the index feature shipped reports `queued`, not indexed (MOTIR-1961)', async () => {
    const fx = await makeWorkItemFixture();
    const inst = await seedInstallation(fx);
    // Connected, granted, present in the mirror — and with no index run of any
    // kind, ever. This is the exact state five live repos sat in while the plan
    // twice asserted "the code graph follows from the grant".
    await seedRepo(inst, 'moooon-B-V', 'motir-meta');

    const state = stateOf(await callTool(fx.ctx, fx.projectIdentifier));
    expect(state.code.index.repos).toEqual([
      { provider: 'github', repoRef: 'moooon-B-V/motir-meta', status: 'queued' },
    ]);
    expect(state.code.index.indexedCount).toBe(0);
    expect(state.code.index.allIndexed).toBe(false);
    expect(state.code.index.hasRunning).toBe(false);
  });

  it('every repo indexed sets `allIndexed`', async () => {
    const fx = await makeWorkItemFixture();
    const inst = await seedInstallation(fx);
    const only = await seedRepo(inst, 'moooon-B-V', 'motir-core');
    await seedSucceededIndexJob(fx, only);

    const state = stateOf(await callTool(fx.ctx, fx.projectIdentifier));
    expect(state.code.index.allIndexed).toBe(true);
    expect(state.code.index.hasRunning).toBe(false);
  });

  it('a succeeded run that indexed NOTHING does not count as an index', async () => {
    const fx = await makeWorkItemFixture();
    const inst = await seedInstallation(fx);
    const repoRef = await seedRepo(inst, 'moooon-B-V', 'motir-core');
    // The `{ indexed: false, reason }` shape a run writes when the workspace had
    // nothing to index: succeeded, but carrying no repoRef.
    await adminDb.jobRun.create({
      data: {
        workspaceId: fx.workspaceId,
        functionId: 'system.code-graph-index',
        eventName: 'system.code-graph-index',
        eventId: `evt-${randomToken()}`,
        lane: 'engine',
        attempt: 0,
        status: 'succeeded',
        finishedAt: new Date(),
        output: { indexed: false, reason: 'no projects' },
      },
    });

    const state = stateOf(await callTool(fx.ctx, fx.projectIdentifier));
    expect(state.code.index.repos).toEqual([{ provider: 'github', repoRef, status: 'queued' }]);
  });
});

describe('get_project_state — a REFRESH claim counts as running (bug MOTIR-10821)', () => {
  /** A code-graph REFRESH run the repository's claim names, as `claimIndexingRepo` stamps it. */
  async function claimWithRefresh(
    fx: WorkItemFixture,
    name: string,
    status: 'running' | 'succeeded' | 'failed' | 'abandoned',
  ) {
    const run = await adminDb.jobRun.create({
      data: {
        workspaceId: fx.workspaceId,
        functionId: 'system.code-graph-refresh',
        eventName: 'system.code-graph-refresh',
        eventId: `evt-${randomToken()}`,
        lane: 'engine',
        attempt: 0,
        status,
        ...(status === 'running' ? {} : { finishedAt: new Date() }),
        output: {},
      },
    });
    await adminDb.githubRepo.updateMany({ where: { name }, data: { indexingRunId: run.id } });
  }

  it('a running refresh reads `indexing`; a settled one reads what it read before', async () => {
    const fx = await makeWorkItemFixture();
    const inst = await seedInstallation(fx);
    const running = await seedRepo(inst, 'moooon-B-V', 'refresh-running');
    const succeeded = await seedRepo(inst, 'moooon-B-V', 'refresh-succeeded');
    const failed = await seedRepo(inst, 'moooon-B-V', 'refresh-failed');
    const abandoned = await seedRepo(inst, 'moooon-B-V', 'refresh-abandoned');
    await claimWithRefresh(fx, 'refresh-running', 'running');
    await claimWithRefresh(fx, 'refresh-succeeded', 'succeeded');
    await claimWithRefresh(fx, 'refresh-failed', 'failed');
    await claimWithRefresh(fx, 'refresh-abandoned', 'abandoned');

    const state = stateOf(await callTool(fx.ctx, fx.projectIdentifier));
    const byRef = new Map(state.code.index.repos.map((r) => [r.repoRef, r.status]));
    expect(byRef.get(running)).toBe('indexing');
    expect(byRef.get(succeeded)).toBe('queued');
    expect(byRef.get(failed)).toBe('failed');
    expect(byRef.get(abandoned)).toBe('failed');
  });
});

describe('get_project_state — the project repository SET and the onboarding run', () => {
  it('reports the project`s own repo set, distinct from the workspace`s connected set', async () => {
    const fx = await makeWorkItemFixture();
    const inst = await seedInstallation(fx);
    // The workspace's CONNECTED repo — a different question from the project's set.
    await seedRepo(inst, 'moooon-B-V', 'motir-core');
    // The PROJECT's set, proposed through the shipped service.
    await projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'motir-core' }, fx.ctx);

    const state = stateOf(await callTool(fx.ctx, fx.projectIdentifier));
    expect(state.repoSet).toHaveLength(1);
    expect(state.repoSet[0]).toMatchObject({ name: 'motir-core', role: 'api' });
    // The connected set is reported separately and answers a different question.
    expect(state.code.index.total).toBe(1);
  });

  it('reports the latest migrate-onboarding run, and `null` for a project that never had one', async () => {
    const fx = await makeWorkItemFixture();
    expect(stateOf(await callTool(fx.ctx, fx.projectIdentifier)).onboarding).toBeNull();

    await adminDb.migrateOnboarding.create({
      data: {
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
        kind: 'migrate',
        step: 'index',
        status: 'active',
        codeGraphReady: false,
      },
    });

    const state = stateOf(await callTool(fx.ctx, fx.projectIdentifier));
    expect(state.onboarding).toMatchObject({
      projectId: fx.projectId,
      step: 'index',
      status: 'active',
      codeGraphReady: false,
      conventionApprovedAt: null,
    });
  });
});

describe('get_project_state — cross-tenant isolation', () => {
  it('a context bound to workspace A cannot read workspace B`s project state by key', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const b = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
    // B is fully configured — an installation, a granted repo, an indexed graph.
    // If the binding leaked, this is precisely what would come back.
    const inst = await seedInstallation(b);
    const secret = await seedRepo(inst, 'rival-corp', 'secret-service');
    await seedSucceededIndexJob(b, secret);

    // A's context aiming at B's key: not-found, with no existence leak and no
    // hint that B is configured at all.
    const denied = await callTool(a.ctx, b.projectIdentifier);
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).not.toContain('rival-corp');
    expect(JSON.stringify(denied)).not.toContain('secret-service');

    // And A's OWN key returns A's state — empty, not B's.
    const own = stateOf(await callTool(a.ctx, a.projectIdentifier));
    expect(own.project.id).toBe(a.projectId);
    expect(own.code.installed).toBe(false);
    expect(own.code.index.repos).toEqual([]);
  });

  it('B`s own context still reads B`s state — the denial is the binding, not a broken read', async () => {
    const b = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
    const inst = await seedInstallation(b);
    const repoRef = await seedRepo(inst, 'rival-corp', 'secret-service');
    await seedSucceededIndexJob(b, repoRef);

    const state = stateOf(await callTool(b.ctx, b.projectIdentifier));
    expect(state.code.index.repos).toEqual([{ provider: 'github', repoRef, status: 'indexed' }]);
  });
});

describe('get_project_state — cost does not grow with the repo count (no N+1)', () => {
  it('reads the succeeded-index ledger ONCE for one repo and for five', async () => {
    const fx = await makeWorkItemFixture();
    const inst = await seedInstallation(fx);
    await seedRepo(inst, 'moooon-B-V', 'repo-1');

    async function measure(): Promise<{
      ledgerCalls: number;
      perRepoCalls: number;
      total: number;
    }> {
      const ledgerSpy = vi.spyOn(jobRunRepository, 'listSucceededCodeGraphIndexRepoRefs');
      // The per-repo lookup the migrate wizard's poll uses. This read must NOT
      // reach for it at all — that is the N+1 the acceptance criteria forbid.
      const perRepoSpy = vi.spyOn(jobRunRepository, 'findSucceededCodeGraphIndex');
      try {
        const state = stateOf(await callTool(fx.ctx, fx.projectIdentifier));
        return {
          ledgerCalls: ledgerSpy.mock.calls.length,
          perRepoCalls: perRepoSpy.mock.calls.length,
          total: state.code.index.total,
        };
      } finally {
        ledgerSpy.mockRestore();
        perRepoSpy.mockRestore();
      }
    }

    const one = await measure();
    expect(one.total).toBe(1);

    for (const n of [2, 3, 4, 5]) await seedRepo(inst, 'moooon-B-V', `repo-${n}`);
    const five = await measure();
    expect(five.total).toBe(5);

    // Constant, and constant at ONE — not "one per repo", and not the per-repo
    // helper at all.
    expect(five.ledgerCalls).toBe(one.ledgerCalls);
    expect(five.ledgerCalls).toBe(1);
    expect(one.perRepoCalls).toBe(0);
    expect(five.perRepoCalls).toBe(0);
  });
});

describe('get_project_state — the human summary', () => {
  it('names the unconfigured state in words, not just in the DTO', async () => {
    const fx = await makeWorkItemFixture();
    const res = await callTool(fx.ctx, fx.projectIdentifier);
    const text = JSON.stringify(res.content);
    expect(text).toContain('NOT established');
    expect(text).toContain('no GitHub App installation');
    expect(text).toContain('none recorded');
    expect(text).toContain('never ran the migrate wizard');
  });

  it('summarizes a configured project: the gate, the index tally, the set, the run', async () => {
    const fx = await makeWorkItemFixture();
    await withWorkspaceContext(fx.ctx, async (tx) => {
      await projectRepository.markOnboardingRan(fx.projectId, new Date(), tx);
    });
    const inst = await seedInstallation(fx);
    const indexed = await seedRepo(inst, 'moooon-B-V', 'motir-core');
    await seedRepo(inst, 'moooon-B-V', 'motir-ai');
    await seedSucceededIndexJob(fx, indexed);
    await seedRunningIndexJob(fx);
    await projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'motir-core' }, fx.ctx);
    await adminDb.migrateOnboarding.create({
      data: {
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
        kind: 'migrate',
        step: 'index',
        status: 'active',
        codeGraphReady: false,
      },
    });

    const res = await callTool(fx.ctx, fx.projectIdentifier);
    const text = JSON.stringify(res.content);
    expect(text).toContain('established');
    expect(text).toContain('1/2 repos indexed');
    expect(text).toContain('an index is running');
    expect(text).toContain('moooon-B-V/motir-ai · queued');
    expect(text).toContain('Repository set: motir-core');
    expect(text).toContain('step index');
  });

  it('a lower-case key resolves the same project as its canonical upper-case form', async () => {
    const fx = await makeWorkItemFixture();
    const state = stateOf(await callTool(fx.ctx, fx.projectIdentifier.toLowerCase()));
    expect(state.project.key).toBe(fx.projectIdentifier);
  });
});

describe('get_project_state — the organisation’s content language (MOTIR-8746)', () => {
  async function inLanguage(language: string): Promise<WorkItemFixture> {
    const fx = await makeWorkItemFixture();
    await adminDb.organization.update({
      where: { id: await organizationIdOf(fx.workspaceId) },
      data: { contentLanguage: language },
    });
    return fx;
  }

  it.each([['en'], ['ja'], ['zh']])(
    'an `%s` organisation reports its code in the DTO and the summary',
    async (language) => {
      const fx = await inLanguage(language);
      const res = await callTool(fx.ctx, fx.projectIdentifier);
      expect(stateOf(res).contentLanguage).toBe(language);
      expect(JSON.stringify(res.content)).toContain(`Content language: ${language}`);
    },
  );

  it('after the organisation’s language changes, the next read reports the new value', async () => {
    const fx = await inLanguage('en');
    expect(stateOf(await callTool(fx.ctx, fx.projectIdentifier)).contentLanguage).toBe('en');
    await organizationContentLanguageService.changeContentLanguage({
      organizationId: await organizationIdOf(fx.workspaceId),
      actorUserId: fx.ctx.userId,
      language: 'ja',
    });
    expect(stateOf(await callTool(fx.ctx, fx.projectIdentifier)).contentLanguage).toBe('ja');
  });

  it('the tool description mentions the content language', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    await client.close();
    const tool = tools.find((t) => t.name === GET_PROJECT_STATE_TOOL_NAME);
    expect(tool!.description).toContain('CONTENT LANGUAGE');
  });
});

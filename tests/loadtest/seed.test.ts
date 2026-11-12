import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Story MOTIR-8538 · MOTIR-8673 — the load-test seed, over real Postgres.
//
// The seed and the reset run IN-PROCESS through `runSeed` / `runReset` (the
// commands' own bodies) against the test database; every assertion reads back
// through the shipped services, Better-Auth's own session read and the real
// `/api/mcp` route — nothing about a seeded row is taken on the seed's word.
//
// Two ENVIRONMENT shims stand in for the Next.js request scope, exactly as
// `tests/integration/i18n/languageStoryGate.test.ts` argues for them: `next/headers`
// answers the request's own headers, and `next-intl/server` is next-intl's own
// react-server build. Neither is under test.

vi.hoisted(() => {
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

const request = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('next/headers', () => ({
  headers: async () => request.headers,
  cookies: async () => ({
    get: () => undefined,
    set: () => {},
  }),
}));

const { db } = await import('@/lib/db');
const { auth, readSession } = await import('@/lib/auth');
const authRoute = await import('@/app/api/auth/[...all]/route');
const { apiTokensService } = await import('@/lib/services/apiTokensService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { plansService } = await import('@/lib/services/plansService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { twoFactorPolicyService } = await import('@/lib/services/twoFactorPolicyService');
const { CLI_TOKEN_GRANT } = await import('@/lib/mcp/toolPermissions');
const { GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER } = await import('@/lib/tokens/grant');
const { WORKSPACE_COOKIE_NAME } = await import('@/lib/workspaces/middleware');
const { createTestPerson } = await import('@/tests/e2e/_helpers/testPerson');
const { mcpRouteFetch } = await import('../helpers/mcpRouteFetch');
const { settleServerWork } = await import('../helpers/serverWork');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

const { runSeed, OPTIONS: SEED_OPTIONS } = await import('@/loadtest/seed/seed');
const { runReset, OPTIONS: RESET_OPTIONS } = await import('@/loadtest/seed/reset');
const { readManifest, manifestCardIds } = await import('@/loadtest/seed/manifest');
const { assertSeedTarget, missingSeedEnv } = await import('@/loadtest/seed/guard');
const { seedTenants, TwoFactorHoldError, runTokenGrant } = await import('@/loadtest/seed/tenants');
const { SMOKE_SHAPE, validateSeedShape, InvalidSeedShapeError, agentCount, agentsPerUser } =
  await import('@/loadtest/seed/shape');
const { endpointHost } = await import('@/loadtest/lib/endpointHost');

type Manifest = Awaited<ReturnType<typeof readManifest>>;

const BASE = 'http://localhost:3000';
const TAG = 'seedtest';

/** The seed's environment: the test database, admitted by the guard as `localhost`. */
function seedEnv(over: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: process.env['DATABASE_URL'],
    DATABASE_URL_UNPOOLED: process.env['DATABASE_URL_UNPOOLED'] ?? process.env['DATABASE_URL'],
    BETTER_AUTH_SECRET: process.env['BETTER_AUTH_SECRET'],
    GOOGLE_CLIENT_ID: process.env['GOOGLE_CLIENT_ID'],
    GOOGLE_CLIENT_SECRET: process.env['GOOGLE_CLIENT_SECRET'],
    MOTIR_BASE_URL: BASE,
    NODE_ENV: 'production',
    LOADTEST_ALLOWED_DB_HOST: endpointHost(process.env['DATABASE_URL']) ?? 'localhost',
    LOADTEST_PRODUCTION_DB_HOSTS: 'ep-prod-1.eu-central-1.aws.neon.tech',
    ...over,
  };
}

let dir: string;
let manifestPath: string;
let manifest: Manifest;
const lines: string[] = [];
const log = (line: string) => lines.push(line);

async function syntheticUserCount(): Promise<number> {
  return adminDb.user.count({ where: { email: { endsWith: '@loadtest.invalid' } } });
}

beforeAll(async () => {
  await truncateAuthTables();
  dir = await mkdtemp(join(tmpdir(), 'loadtest-seed-'));
  manifestPath = join(dir, 'manifest.json');
  const signIn = vi.spyOn(auth.api, 'signInEmail');
  expect(await runSeed(['--tag', TAG, '--out', manifestPath], seedEnv(), log)).toBe(0);
  expect(signIn).not.toHaveBeenCalled();
  signIn.mockRestore();
  manifest = await readManifest(manifestPath);
}, 120_000);

afterAll(async () => {
  await settleServerWork();
  await rm(dir, { recursive: true, force: true });
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── MCP over the real route ─────────────────────────────────────────────────

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'loadtest-seed-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/api/mcp', BASE), { fetch: mcpRouteFetch(token) }),
  );
  return client;
}

const textOf = (r: CallToolResult) =>
  r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

const ownerCtx = (workspaceId: string) => ({
  userId: manifest.workspaces.find((w) => w.id === workspaceId)!.ownerUserId,
  workspaceId,
});

// ── The smoke seed ──────────────────────────────────────────────────────────

describe('pnpm loadtest:seed (smoke shape)', () => {
  it('writes a 0600 manifest with the counts the shape asks for', async () => {
    expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
    const s = SMOKE_SHAPE;
    expect(manifest.shape).toEqual(s);
    expect(manifest.users).toHaveLength(s.users);
    expect(manifest.workspaces).toHaveLength(s.workspaces);
    expect(manifest.workspaces.length).toBeGreaterThanOrEqual(2);
    expect(manifest.projects).toHaveLength(s.workspaces * s.projectsPerWorkspace);
    expect(manifest.agents).toHaveLength(s.users * s.workspacesPerUser * agentsPerUser(s));
    for (const role of ['read', 'write', 'claim', 'run'] as const) {
      expect(manifest.agents.filter((a) => a.role === role)).toHaveLength(agentCount(s, role));
    }
    // Per user per workspace, by role.
    for (const u of manifest.users) {
      for (const ws of u.workspaceIds) {
        const mine = manifest.agents.filter((a) => a.userId === u.id && a.workspaceId === ws);
        expect(mine).toHaveLength(agentsPerUser(s));
      }
    }
    for (const w of manifest.workspaces) {
      expect(w.agentCounts.total).toBe(
        manifest.agents.filter((a) => a.workspaceId === w.id).length,
      );
    }
    for (const p of manifest.projects) {
      expect(p.content.stories).toHaveLength(s.content.stories);
      expect(p.content.subtasks).toHaveLength(s.content.stories * s.content.subtasksPerStory);
      expect(p.pools.claim).toHaveLength(s.pools.claim);
      expect(p.pools.run).toHaveLength(s.pools.run);
      expect(p.pools.write).toHaveLength(s.pools.write);
    }
    const burst = manifest.agents.filter((a) => a.burst);
    expect(burst).toHaveLength(s.burstAgents);
    for (const a of burst) {
      expect(a.role).toBe('write');
      expect(a.burst!.cards).toHaveLength(s.burstSize);
      expect(a.burst!.parents).toHaveLength(2);
    }
    const writers = manifest.agents.filter((a) => a.role === 'write');
    expect(writers.flatMap((a) => a.scratchPlanIds)).toHaveLength(writers.length * s.scratchPlans);
    expect(manifest.sessionLifetimeSeconds).toBeGreaterThan(24 * 3600);
  });

  it('every seeded email is non-deliverable, and nothing secret reached the log', () => {
    for (const u of manifest.users) expect(u.email).toMatch(/@loadtest\.invalid$/);
    const out = lines.join('\n');
    for (const a of manifest.agents) expect(out).not.toContain(a.token);
    for (const u of manifest.users) expect(out).not.toContain(u.cookieHeader.split('; ')[0]!);
  });

  it('each burst agent owns its pool and its parent pair; read plans are planned', async () => {
    const seen = new Set<string>();
    for (const a of manifest.agents.filter((x) => x.burst)) {
      for (const c of [...a.burst!.cards, ...a.burst!.parents]) {
        expect(seen.has(c.id), `${c.key} is shared between burst agents`).toBe(false);
        seen.add(c.id);
      }
    }
    for (const w of manifest.workspaces) {
      const readPlans = manifest.projects
        .filter((p) => p.workspaceId === w.id)
        .flatMap((p) => p.readPlanIds);
      expect(readPlans).toHaveLength(SMOKE_SHAPE.readPlansPerWorkspace);
      for (const id of readPlans) {
        const plan = await plansService.getPlan(id, ownerCtx(w.id));
        expect(plan.status).toBe('planned');
        expect(manifest.agents.flatMap((a) => a.scratchPlanIds)).not.toContain(id);
      }
    }
  });
});

// ── Sessions ────────────────────────────────────────────────────────────────

describe('minted sessions', () => {
  it('the cookie name equals the one a real sign-in sets', async () => {
    const person = await createTestPerson({
      email: 'real-sign-in@example.com',
      password: 'loadtest-real-sign-in-7',
      name: 'Real',
    });
    expect(person.id).toBeTruthy();
    const res = await authRoute.POST(
      new Request(`${BASE}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({ email: person.email, password: 'loadtest-real-sign-in-7' }),
      }),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const names = res.headers.getSetCookie().map((c) => c.split('=')[0]);
    for (const u of manifest.users) expect(names).toContain(u.cookieName);
  });

  it('the cookie header signs a reader in, pinned to its workspace and active project', async () => {
    for (const u of manifest.users) {
      const session = await readSession(new Headers({ cookie: u.cookieHeader }));
      expect(session?.user.id).toBe(u.id);
      const pinned = u.cookieHeader
        .split('; ')
        .find((c) => c.startsWith(`${WORKSPACE_COOKIE_NAME}=`))!
        .slice(WORKSPACE_COOKIE_NAME.length + 1);
      expect(pinned).toBe(u.readerWorkspaceId);
      expect(await workspacesService.resolveActiveWorkspace(u.id, pinned)).toBe(
        u.readerWorkspaceId,
      );
      expect((await projectsService.getActiveProject(u.id, u.readerWorkspaceId))?.id).toBe(
        u.readerProjectId,
      );
    }
  });

  it('refuses a user the two-factor policy holds, and passes a required-but-compliant one', async () => {
    const spy = vi.spyOn(twoFactorPolicyService, 'resolveRequirement');
    try {
      spy.mockResolvedValue({
        required: true,
        compliant: true,
        mandatedBy: { tier: 'enterprise', name: 'Enterprise' },
      } as never);
      await expect(
        seedTenants(SMOKE_SHAPE, { runTag: TAG, databaseHost: 'localhost' }),
      ).resolves.toBeDefined();
      spy.mockResolvedValue({
        required: true,
        compliant: false,
        mandatedBy: { tier: 'enterprise', name: 'Enterprise' },
      } as never);
      const err = await seedTenants(SMOKE_SHAPE, { runTag: TAG, databaseHost: 'localhost' }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(TwoFactorHoldError);
      expect((err as Error).message).toMatch(/lt-seedtest-u\d+@loadtest\.invalid/);
    } finally {
      spy.mockRestore();
    }
    // Both runs above minted fresh tokens; re-seed once more so the manifest
    // the rest of this file reads holds live credentials.
    expect(await runSeed(['--tag', TAG, '--out', manifestPath], seedEnv(), log)).toBe(0);
    manifest = await readManifest(manifestPath);
  }, 120_000);
});

// ── Agents ──────────────────────────────────────────────────────────────────

describe('agents', () => {
  it('every token answers initialize + tools/list as its own user in its own workspace', async () => {
    for (const a of manifest.agents) {
      const verified = await apiTokensService.verify(a.token);
      expect(verified.user.id).toBe(a.userId);
      expect(verified.workspaceId).toBe(a.workspaceId);
      expect(verified.projectId).toBe(a.projectId);
      const client = await mcpClient(a.token);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      await client.close();
    }
  }, 120_000);

  it('a read token cannot read a card in another seeded workspace', async () => {
    const reader = manifest.agents.find((a) => a.role === 'read')!;
    const foreign = manifest.projects.find((p) => p.workspaceId !== reader.workspaceId)!;
    const client = await mcpClient(reader.token);
    const res = (await client.callTool({
      name: 'get_work_item',
      arguments: { key: foreign.content.subtasks[0]!.key },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain(foreign.content.subtasks[0]!.key + ' ·');
    await client.close();
  });

  it('a run token holds CLI_TOKEN_GRANT, narrowed only to what its holder can confer', async () => {
    const owners = new Set(manifest.workspaces.map((w) => `${w.ownerUserId}:${w.id}`));
    let ownerChecked = false;
    let memberChecked = false;
    for (const run of manifest.agents.filter((a) => a.role === 'run')) {
      const { scopes } = await apiTokensService.verify(run.token);
      const grant = scopes.filter((s) => s !== GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER);
      const grantable = await apiTokensService.listGrantablePermissions(
        run.userId,
        run.workspaceId,
        run.projectId,
      );
      expect([...grant].sort()).toEqual([...runTokenGrant(grantable)].sort());
      expect(grant).not.toContain('ai:view_plan');
      const missing = CLI_TOKEN_GRANT.filter((k) => !grant.includes(k));
      if (owners.has(`${run.userId}:${run.workspaceId}`)) {
        // The workspace owner can confer every key `motir run` holds.
        expect(missing).toEqual([]);
        ownerChecked = true;
      } else {
        // A workspace MEMBER does not hold the lesson keys or `repository:manage`
        // (the built-in `member` role names its keys and gains none of them,
        // lib/permissions/builtinRoles.ts), so it cannot confer them, and its run
        // token lacks exactly those three.
        expect(missing.sort()).toEqual(['lesson:reinforce', 'lesson:view', 'repository:manage']);
        memberChecked = true;
      }
    }
    expect(ownerChecked && memberChecked).toBe(true);
  });

  it('the default grant carries work_item:edit and ai:view_plan, and a write token appends', async () => {
    const writer = manifest.agents.find((a) => a.role === 'write' && !a.burst)!;
    const { grant } = await apiTokensService.verify(writer.token);
    expect(grant).toEqual(expect.arrayContaining(['work_item:edit', 'ai:view_plan']));
    const client = await mcpClient(writer.token);
    const res = (await client.callTool({
      name: 'add_plan_items',
      arguments: {
        planId: writer.scratchPlanIds[0],
        proposals: [{ op: 'add', proposedFields: { title: 'appended by the seed test' } }],
      },
    })) as CallToolResult;
    expect(res.isError, textOf(res)).toBeFalsy();
    await client.close();
  });
});

// ── Pools and the reset ─────────────────────────────────────────────────────

describe('pools and pnpm loadtest:seed:reset', () => {
  it('claim-pool cards are ready, unassigned and todo', async () => {
    for (const p of manifest.projects) {
      for (const c of p.pools.claim) {
        const ctx = ownerCtx(p.workspaceId);
        const item = await workItemsService.getWorkItem(c.id, ctx);
        expect(item.status).toBe('todo');
        expect(item.assigneeId).toBeNull();
        expect((await workItemsService.getReadiness(c.id, ctx)).ready).toBe(true);
      }
    }
  });

  it('a reset returns claimed cards, a moved burst card and a grown scratch plan', async () => {
    const claimer = manifest.agents.find((a) => a.role === 'claim')!;
    const project = manifest.projects.find((p) => p.id === claimer.projectId)!;
    const client = await mcpClient(claimer.token);
    for (const c of project.pools.claim.slice(0, 2)) {
      const res = (await client.callTool({
        name: 'claim_work_item',
        arguments: { key: c.key },
      })) as CallToolResult;
      expect(res.isError, textOf(res)).toBeFalsy();
    }
    await client.close();
    const ctx = ownerCtx(project.workspaceId);
    const claimed = await workItemsService.getWorkItem(project.pools.claim[0]!.id, ctx);
    expect(claimed.status).not.toBe('todo');
    expect(claimed.assigneeId).toBe(claimer.userId);

    const bursty = manifest.agents.find((a) => a.burst)!;
    const bctx = ownerCtx(bursty.workspaceId);
    const moved = bursty.burst!.cards[0]!;
    await workItemsService.moveWorkItem(
      moved.id,
      { newParentId: bursty.burst!.parents[1].id },
      bctx,
    );

    // The scratch plan the write test grew above.
    const grownOwner = manifest.agents.find((a) => a.role === 'write' && !a.burst)!;
    const grownPlan = grownOwner.scratchPlanIds[0]!;

    expect(await runReset(['--manifest', manifestPath], seedEnv(), log)).toBe(0);
    const after = await readManifest(manifestPath);

    for (const c of project.pools.claim) {
      const item = await workItemsService.getWorkItem(c.id, ctx);
      expect(item.status).toBe('todo');
      expect(item.assigneeId).toBeNull();
      expect(item.parentId).toBe(project.pools.parents.claim.id);
    }
    expect((await workItemsService.getWorkItem(moved.id, bctx)).parentId).toBe(
      bursty.burst!.parents[0].id,
    );
    const replacedOwner = after.agents.find((a) => a.tokenId === grownOwner.tokenId)!;
    expect(replacedOwner.scratchPlanIds[0]).not.toBe(grownPlan);
    const wctx = ownerCtx(grownOwner.workspaceId);
    expect((await plansService.getPlan(grownPlan, wctx)).status).toBe('declined');
    const fresh = await plansService.getPlan(replacedOwner.scratchPlanIds[0]!, wctx);
    expect(fresh.status).toBe('generating');
    expect(fresh.items).toHaveLength(0);
    // Every id the rewritten manifest names still resolves.
    const ids = manifestCardIds(after);
    expect(await adminDb.workItem.count({ where: { id: { in: ids }, archivedAt: null } })).toBe(
      new Set(ids).size,
    );
    manifest = after;
  }, 120_000);

  it('a reset with no manifest exits non-zero before any write and names the re-seed', async () => {
    const before = await syntheticUserCount();
    const out: string[] = [];
    const code = await runReset(['--manifest', join(dir, 'gone.json')], seedEnv(), (l) =>
      out.push(l),
    );
    expect(code).not.toBe(0);
    expect(out.join('\n')).toMatch(/Re-seed/);
    expect(await syntheticUserCount()).toBe(before);
  });
});

// ── Re-seeding ──────────────────────────────────────────────────────────────

describe('re-seeding the same tag', () => {
  it('creates no duplicate users or workspaces and replaces every token', async () => {
    const users = await syntheticUserCount();
    const workspaces = await adminDb.workspace.count({
      where: { name: { startsWith: `Loadtest ${TAG} ` } },
    });
    const old = manifest;
    expect(await runSeed(['--tag', TAG, '--out', manifestPath], seedEnv(), log)).toBe(0);
    const fresh = await readManifest(manifestPath);
    expect(await syntheticUserCount()).toBe(users);
    expect(
      await adminDb.workspace.count({ where: { name: { startsWith: `Loadtest ${TAG} ` } } }),
    ).toBe(workspaces);
    expect(fresh.users.map((u) => u.id)).toEqual(old.users.map((u) => u.id));
    expect(fresh.workspaces.map((w) => w.id)).toEqual(old.workspaces.map((w) => w.id));
    for (const a of old.agents) await expect(apiTokensService.verify(a.token)).rejects.toThrow();
    for (const a of fresh.agents) {
      expect((await apiTokensService.verify(a.token)).user.id).toBe(a.userId);
    }
    manifest = fresh;
  }, 120_000);
});

// ── The guard ───────────────────────────────────────────────────────────────

describe('the target guard', () => {
  const refusals: [string, Record<string, string | undefined>][] = [
    ['LOADTEST_ALLOWED_DB_HOST unset', { LOADTEST_ALLOWED_DB_HOST: undefined }],
    [
      'LOADTEST_ALLOWED_DB_HOST not the target',
      { LOADTEST_ALLOWED_DB_HOST: 'ep-staging.neon.tech' },
    ],
    ['LOADTEST_PRODUCTION_DB_HOSTS unset', { LOADTEST_PRODUCTION_DB_HOSTS: undefined }],
    [
      'the target is a production host',
      {
        LOADTEST_PRODUCTION_DB_HOSTS: `ep-prod.neon.tech,${endpointHost(process.env['DATABASE_URL'])}`,
      },
    ],
  ];
  for (const [name, over] of refusals) {
    it(`both commands exit non-zero before any write: ${name}`, async () => {
      const before = await syntheticUserCount();
      expect(
        await runSeed(['--tag', 'guarded', '--out', join(dir, 'g.json')], seedEnv(over), log),
      ).not.toBe(0);
      expect(await runReset(['--manifest', manifestPath], seedEnv(over), log)).not.toBe(0);
      expect(await syntheticUserCount()).toBe(before);
    });
  }

  it('admits a pooled host whose endpoint host is the allowed one', () => {
    const env = {
      ...seedEnv(),
      DATABASE_URL: 'postgresql://u:p@ep-calm-sky-123-pooler.eu-central-1.aws.neon.tech/db',
      DATABASE_URL_UNPOOLED: 'postgresql://u:p@ep-calm-sky-123.eu-central-1.aws.neon.tech/db',
      LOADTEST_ALLOWED_DB_HOST: 'ep-calm-sky-123.eu-central-1.aws.neon.tech',
    };
    expect(assertSeedTarget(env)).toBe('ep-calm-sky-123.eu-central-1.aws.neon.tech');
  });

  it('names every missing secret in one message', async () => {
    expect(
      missingSeedEnv(
        seedEnv({
          BETTER_AUTH_SECRET: undefined,
          GOOGLE_CLIENT_ID: '',
          GOOGLE_CLIENT_SECRET: undefined,
        }),
      ),
    ).toEqual(['BETTER_AUTH_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    const out: string[] = [];
    const code = await runSeed(
      [],
      seedEnv({
        BETTER_AUTH_SECRET: undefined,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
      }),
      (l) => out.push(l),
    );
    expect(code).not.toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET/);
  });
});

// ── The shape and the CLI contract ──────────────────────────────────────────

describe('the shape and the CLI contract', () => {
  it('refuses a non-smoke shape with fewer than 6 agent workspaces, naming the field', () => {
    const err = (() => {
      try {
        validateSeedShape({ ...SMOKE_SHAPE, smoke: false, workspaces: 5, users: 10 });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InvalidSeedShapeError);
    expect((err as Error).message).toMatch(/workspaces must be ≥ 6/);
    expect(() =>
      validateSeedShape({ ...SMOKE_SHAPE, workspaces: 1, users: 4, workspacesPerUser: 1 }),
    ).toThrow(/workspaces must be ≥ 2/);
    expect(
      validateSeedShape({ ...SMOKE_SHAPE, smoke: false, workspaces: 6, users: 12 }).workspaces,
    ).toBe(6);
  });

  it('names every missing shape field', () => {
    expect(() => validateSeedShape({ smoke: false })).toThrow(/users[\s\S]*burstSize/);
  });

  it('seed and reset export OPTIONS, and endpointHost strips only -pooler', () => {
    expect(Object.values(SEED_OPTIONS).map((o) => o.flag)).toEqual(['--shape', '--tag', '--out']);
    expect(Object.values(RESET_OPTIONS).map((o) => o.flag)).toEqual(['--manifest']);
    expect(endpointHost('ep-a-pooler.x.neon.tech')).toBe('ep-a.x.neon.tech');
    expect(endpointHost('ep-a-pooler-b.x.neon.tech')).toBe('ep-a-pooler-b.x.neon.tech');
    expect(endpointHost('ep-a.x-pooler.neon.tech')).toBe('ep-a.x-pooler.neon.tech');
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asMinted } from '../helpers/devicePoll';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { User } from '@/generated/prisma/client';

// Better-Auth's rate limiter buckets /sign-in per IP (window 10s, max 3) and
// every test here signs in for real to obtain the session the plugin's claim /
// approve endpoints read. Under vitest there is no client IP, so all of them land
// in ONE bucket and the fourth sign-in of a run would 429 — a flake with nothing
// to do with the code under test. Set in `vi.hoisted` so it lands BEFORE the auth
// module is imported and its config is frozen (the same opt-in flag
// `cliDeviceService.test.ts` uses; production never sets it).
vi.hoisted(() => {
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

const { db } = await import('@/lib/db');
const { adminDb } = await import('../helpers/adminDb');
const { auth } = await import('@/lib/auth');
const { cliDeviceService } = await import('@/lib/services/cliDeviceService');
const { apiTokensService } = await import('@/lib/services/apiTokensService');
const { CLI_TOKEN_GRANT } = await import('@/lib/mcp/toolPermissions');
const { isGrantable } = await import('@/lib/tokens/grant');
const { PERMISSION_NOT_GRANTED_CODE } = await import('@/lib/mcp/permissionGate');
const { CLI_CLIENT_ID } = await import('@/lib/cliDevice/constants');
const { mcpRouteFetch } = await import('../helpers/mcpRouteFetch');
const { makeWorkItemFixture } = await import('../fixtures/workItemFixtures');
const { TEST_PASSWORD } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { startMcpHttpServer } = await import('../helpers/mcpHttpServer');
const { makeCliWorkspace } = await import('../helpers/cliHarness');

import type { WorkItemFixture } from '../fixtures/workItemFixtures';
import type { McpTestServer } from '../helpers/mcpHttpServer';
import type { CliWorkspace } from '../helpers/cliHarness';

// STORY-CLOSING vitest GATE for "Connect the CLI" (Story MOTIR-1863 · Subtask
// MOTIR-1870) — the three-tier login, the device grant, and the credential it
// mints.
//
// WHAT THE PER-SUBTASK FLOOR ALREADY PROVES, and is deliberately NOT repeated
// here (notes.html #69 / #102 / #125 — a story gate that re-lists its subtasks'
// own cases is duplicated coverage, not a gate):
//   • `tests/cli/cliDeviceService.test.ts` — the five poll states, the approve
//     gates, `describe`'s claim, the mint's label / scopes / expiry / binding,
//     single-use, AND the two real-concurrency races (two simultaneous polls mint
//     exactly ONE token; two simultaneous approvals mint none) against a warmed
//     pool. That file IS this story's "one approval ⇒ one `api_token` row" guard.
//   • `tests/cli/cli-device-routes.test.ts` — the RFC 8628 error shapes.
//   • `packages/cli/test/login.test.ts` — the command's own branches, in-process.
//
// WHAT ONLY A STORY-LEVEL SUITE CAN PROVE — the seams BETWEEN those pieces, which
// every one of them mocks or stops short of:
//
//   1. GRANT → MINT → BEARER. The plaintext the mint returns is read back through
//      the CONSUMER — the real `/api/mcp` route's `withMcpAuth` + `verifyMcpToken`
//      — not through the producer's own DTO. A key-drift bug between the two is
//      invisible to both sides' units.
//   2. THE SCOPE SEAM. The ADR claims the narrowed grant is exactly sufficient for
//      the CLI's work. Asserted BOTH ways: statically, every tool the shipped
//      client calls maps into `CLI_TOKEN_GRANT`; and dynamically, a real
//      `work_items:write` call succeeds on a device-minted token while the three
//      scopes the ADR withholds are denied by the real route.
//   3. THE BUILT BINARY. `motir login --no-browser`, spawned as a child process,
//      against the REAL `/api/cli/device/*` routes over a real socket, approved
//      out-of-band, ending in `motir ready` succeeding with the credential that
//      login just minted. Terminal → browser grant → bearer → work, in one test.
//   4. ARCHITECTURE GUARDS a coverage percentage cannot see: the table's tenancy
//      asserted against the MIGRATED DATABASE rather than the migration's prose,
//      a device-minted token being an ORDINARY token (it lists, and revoke is the
//      only kill switch), and cross-tenant isolation of the bound workspace.
//
// Real Postgres, real Better-Auth, real routes. The only `vi.*` in this file is
// the hoisted rate-limit flag above.
//
// THE GATE'S THIRD JOB — the coverage floor — is not in this file, deliberately.
// Measuring the story's merged surface as a whole surfaced branch residue in four
// files, and each top-up went in beside its own siblings (where a reader looking
// for "the poll's unbound state" or "the 410 approve" will actually look):
// `cliDeviceService.test.ts`, `cli-device-routes.test.ts`, and
// `tests/components/device-approval.test.tsx`, each under a "story gate's residue"
// heading naming this subtask. The whole surface is then enrolled in the per-file
// ≥90% gate in `vitest.config.ts`, which is what keeps it there.

// The binary case builds `packages/cli` and spawns it against a socket; 15s is
// the root lane's default and too tight for that under a loaded CI shard.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const BASE_URL = 'http://localhost:3000';
const MCP_ENDPOINT = 'http://localhost/api/mcp';

let server: McpTestServer;

beforeAll(async () => {
  // The device endpoints are served too — this is the ONE suite whose subject
  // speaks them (see tests/helpers/mcpHttpServer.ts).
  server = await startMcpHttpServer({ cliDeviceRoutes: true, v1Routes: true });
});

afterAll(async () => {
  await server.close();
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

// ── the browser half, driven for real ───────────────────────────────────────

/** Sign in for real and return the headers a browser would send next — the only
 *  way to exercise the plugin's session-gated endpoints. */
async function signIn(user: User): Promise<Headers> {
  const res = await auth.api.signInEmail({
    body: { email: user.email, password: TEST_PASSWORD },
    headers: new Headers({ origin: BASE_URL }),
    asResponse: true,
  });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return new Headers({ cookie, origin: BASE_URL });
}

/**
 * Do what the human does at `/device`: claim the code with a signed-in session,
 * then approve it for `workspaceId`. Goes through the real plugin + the real
 * service, exactly as the page's two calls do.
 */
async function approveAtBrowser(input: {
  user: User;
  userCode: string;
  workspaceId: string;
}): Promise<void> {
  const headers = await signIn(input.user);
  await auth.api.deviceVerify({ query: { user_code: input.userCode }, headers });
  await cliDeviceService.approve({
    userCode: input.userCode,
    workspaceId: input.workspaceId,
    actorUserId: input.user.id,
    headers,
  });
}

/** Run the whole grant for `fx` and return the credential the CLI would hold. */
async function loginAsDevice(fx: WorkItemFixture, hostname = 'workbox'): Promise<string> {
  const grant = await cliDeviceService.start({ hostname });
  await approveAtBrowser({
    user: fx.owner,
    userCode: grant.user_code,
    workspaceId: fx.workspaceId,
  });
  const granted = await cliDeviceService.poll({
    deviceCode: grant.device_code,
    clientId: CLI_CLIENT_ID,
  });
  return asMinted(granted).access_token;
}

// ── the consumer side: the REAL /api/mcp route ──────────────────────────────

async function connectMcp(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_ENDPOINT), {
    fetch: mcpRouteFetch(token),
  });
  const client = new Client({ name: 'cli-connect-story', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

/** `callTool`'s return is a union broader than `CallToolResult`; read the fields
 *  off the raw result the way the SDK's own consumers do. */
function structured(res: unknown): Record<string, unknown> {
  return (res as { structuredContent: Record<string, unknown> }).structuredContent;
}

function isScopeDenied(res: unknown): boolean {
  const r = res as { isError?: boolean; content?: unknown };
  return (
    r.isError === true && JSON.stringify(r.content ?? '').includes(PERMISSION_NOT_GRANTED_CODE)
  );
}

describe('the grant → mint → bearer seam, read back through the CONSUMER', () => {
  it('a device-approved credential is a working bearer on the real /api/mcp route', async () => {
    const fx = await makeWorkItemFixture();
    const token = await loginAsDevice(fx);

    // THE SEAM. Everything before this line is the producer's word for it; this
    // is the consumer — the shipped transport gate — accepting the plaintext.
    const client = await connectMcp(token);
    try {
      const who = structured(await client.callTool({ name: 'whoami', arguments: {} }));
      expect(who['user']).toMatchObject({ id: fx.ownerId, email: fx.owner.email });
      expect(who['workspace']).toMatchObject({ id: fx.workspaceId });

      // …and it can do the CLI's actual work, not merely authenticate.
      const created = await client.callTool({
        name: 'create_work_item',
        arguments: {
          projectKey: fx.projectIdentifier,
          kind: 'task',
          title: 'Created over CLI PAT',
        },
      });
      const identifier = structured(created)['identifier'] as string;
      const row = await adminDb.workItem.findFirstOrThrow({ where: { identifier } });
      expect(row.title).toBe('Created over CLI PAT');
      // Written AS the approver, into the workspace the approval bound — not the
      // owner's default workspace.
      expect(row.reporterId).toBe(fx.ownerId);
      expect(row.workspaceId).toBe(fx.workspaceId);
    } finally {
      await client.close();
    }
  });
});

describe('the scope seam — the narrowed grant is EXACTLY sufficient', () => {
  // ⚠️ THE SEAM GUARD RETIRED HERE (MOTIR-2214 · 11.5.6), and where it went.
  //
  // This described the ADR's central claim — every MCP tool `packages/cli` calls
  // is gated by a scope the device grant carries — by reading the shipped client
  // and checking each tool name against `CLI_TOKEN_GRANT`, with a floor so a
  // regex that stopped matching could not pass vacuously. The floor fell once
  // per porting card (14, 12, 7, 6, 1) until MOTIR-2398 moved the last method
  // and it was INVERTED to assert the absence: the client names no tool at all.
  //
  // 11.5.6 then removed `@modelcontextprotocol/sdk` from `packages/cli`
  // outright, which subsumes it — a client that cannot import the SDK cannot
  // name a tool, whatever a regex over its source says. The property now lives
  // in `packages/cli/test/noSdk.test.ts`, next to the manifest it reads and
  // failing in the package's own suite rather than in a repo-level one three
  // directories away. The scope tests below stay: they are about the GRANT and
  // the server's MCP surface, both of which are untouched.

  it('every scope in the grant is a real scope, and the destructive ones are withheld', () => {
    for (const key of CLI_TOKEN_GRANT) expect(isGrantable(key), key).toBe(true);
    expect(CLI_TOKEN_GRANT).not.toContain('work_items:archive');
    expect(CLI_TOKEN_GRANT).not.toContain('work_items:delete');
    expect(CLI_TOKEN_GRANT).not.toContain('sprints:write');
  });

  it('the real route lets a device token WRITE work items and denies the three withheld scopes', async () => {
    const fx = await makeWorkItemFixture();
    const token = await loginAsDevice(fx);
    const client = await connectMcp(token);

    try {
      const created = await client.callTool({
        name: 'create_work_item',
        arguments: { projectKey: fx.projectIdentifier, kind: 'task', title: 'scoped write' },
      });
      expect((created as { isError?: boolean }).isError).not.toBe(true);
      const key = structured(created)['identifier'] as string;

      // The grant is NARROW: each of these is a tool the CLI never calls, and the
      // gate must refuse it on the token's scopes alone — the owner's ROLE would
      // permit all three.
      const archived = await client.callTool({
        name: 'archive_work_item',
        arguments: { key },
      });
      expect(isScopeDenied(archived), 'archive_work_item must be scope-denied').toBe(true);

      const deleted = await client.callTool({ name: 'delete_work_item', arguments: { key } });
      expect(isScopeDenied(deleted), 'delete_work_item must be scope-denied').toBe(true);

      const sprint = await client.callTool({
        name: 'create_sprint',
        arguments: { projectKey: fx.projectIdentifier, name: 'S1' },
      });
      expect(isScopeDenied(sprint), 'create_sprint must be scope-denied').toBe(true);

      // Denied means denied — nothing was archived on the way out.
      const item = await adminDb.workItem.findFirstOrThrow({ where: { identifier: key } });
      expect(item.archivedAt).toBeNull();
    } finally {
      await client.close();
    }
  });
});

describe('architecture guards — asserted against the migrated database, not the prose', () => {
  it('device_code is IDENTITY-scoped: no RLS, no policy, and a nullable workspace binding', async () => {
    const [table] = await adminDb.$queryRaw<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'device_code'`;
    expect(table, 'the device_code table must exist in the migrated schema').toBeDefined();
    // The ADR's tenancy decision: the row exists BEFORE a workspace is chosen and
    // is read PRE-AUTH on every poll, so a workspace policy would hide it from its
    // only legitimate reader.
    expect(table!.relrowsecurity).toBe(false);
    expect(table!.relforcerowsecurity).toBe(false);

    const policies = await adminDb.$queryRaw<{ policyname: string }[]>`
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'device_code'`;
    expect(policies).toEqual([]);

    // Not a vacuous query: a workspace-scoped table in the SAME database DOES
    // carry forced RLS, so the assertions above are discriminating.
    const [sprint] = await adminDb.$queryRaw<{ relforcerowsecurity: boolean }[]>`
      SELECT c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'sprint'`;
    expect(sprint!.relforcerowsecurity).toBe(true);

    const columns = await adminDb.$queryRaw<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'device_code'
         AND column_name IN ('workspace_id', 'user_id', 'device_code', 'user_code')`;
    const nullable = Object.fromEntries(columns.map((c) => [c.column_name, c.is_nullable]));
    // Both bindings are written LATER (claim, then approval) — a NOT NULL tenant
    // discriminator is not available at insert time, which is the first of the
    // migration's three reasons for identity scoping.
    expect(nullable['workspace_id']).toBe('YES');
    expect(nullable['user_id']).toBe('YES');
    // The CODES are the capability, so both are non-null and unique.
    expect(nullable['device_code']).toBe('NO');
    expect(nullable['user_code']).toBe('NO');

    const uniques = await adminDb.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'device_code' AND indexdef LIKE '%UNIQUE%'`;
    const defs = uniques.map((u) => u.indexdef).join('\n');
    expect(defs).toContain('(device_code)');
    expect(defs).toContain('(user_code)');

    // Every FK CASCADEs: deleting a user or a workspace drops grants that would
    // mint into them (short-lived auth substrate, not audit), and deleting a token
    // — which is what a revoke does — drops the `motir auth refresh` grant that
    // would have updated it (MOTIR-10189's `update_token_id`).
    const fks = await adminDb.$queryRaw<{ conname: string; confdeltype: string }[]>`
      SELECT conname, confdeltype::text AS confdeltype FROM pg_constraint
       WHERE conrelid = 'public.device_code'::regclass AND contype = 'f'`;
    expect(fks).toHaveLength(3);
    for (const fk of fks) expect(fk.confdeltype, `${fk.conname} must ON DELETE CASCADE`).toBe('c');
  });

  it('a device-minted token is an ORDINARY token: it lists, and revoke is the only kill switch', async () => {
    const fx = await makeWorkItemFixture();
    const token = await loginAsDevice(fx, 'workbox');

    // It appears in the same Settings → Account → Tokens list every other PAT
    // does — which is what makes "disconnect that machine" a complete action, and
    // proves there is no second, device-only registry.
    const listed = await apiTokensService.listForUser(fx.ownerId);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.label).toBe('CLI · workbox');
    expect([...listed[0]!.permissions].sort()).toEqual([...CLI_TOKEN_GRANT].sort());

    // The grant itself left nothing behind — the single-use row is gone, so the
    // token row is the ONLY artifact of the login.
    expect(await adminDb.deviceCode.count()).toBe(0);

    const working = await connectMcp(token);
    expect(
      (await working.callTool({ name: 'whoami', arguments: {} })) as { isError?: boolean },
    ).not.toHaveProperty('isError', true);
    await working.close();

    await apiTokensService.deleteToken(fx.ownerId, listed[0]!.id);

    // Revocation kills it at the REAL gate, not merely in the service: the
    // transport refuses the bearer outright, so the SDK cannot even connect.
    await expect(connectMcp(token)).rejects.toThrow();
  });

  it('the bound workspace is a boundary: a token approved for A cannot reach B', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const b = await makeWorkItemFixture({ name: 'Beta', identifier: 'BETA' });
    const token = await loginAsDevice(a);

    const client = await connectMcp(token);
    try {
      // Only A's project is reachable — the token binds to ONE workspace (ADR Q3).
      const projects = structured(await client.callTool({ name: 'list_projects', arguments: {} }));
      const keys = (projects['projects'] as { key: string }[]).map((p) => p.key);
      expect(keys).toEqual([a.projectIdentifier]);

      // And B's data answers as absent (the 404-not-403 contract), never as its
      // contents.
      const denied = await client.callTool({
        name: 'create_work_item',
        arguments: { projectKey: b.projectIdentifier, kind: 'task', title: 'cross-tenant' },
      });
      expect((denied as { isError?: boolean }).isError).toBe(true);
      expect(await adminDb.workItem.count({ where: { workspaceId: b.workspaceId } })).toBe(0);
    } finally {
      await client.close();
    }
  });
});

describe('the BUILT binary — terminal → browser grant → bearer → work', () => {
  /** Wait for the grant the spawned `motir login` opened to land in Postgres —
   *  the deterministic signal that the child reached the real start endpoint. */
  async function pendingUserCode(): Promise<string> {
    let userCode: string | undefined;
    await expect
      .poll(
        async () => {
          const row = await adminDb.deviceCode.findFirst({ where: { status: 'pending' } });
          userCode = row?.userCode;
          return userCode ?? null;
        },
        { timeout: 30_000, interval: 200 },
      )
      .not.toBeNull();
    return userCode as string;
  }

  it('`motir login --no-browser` mints a credential the built binary then WORKS with', async () => {
    const fx = await makeWorkItemFixture();
    const ws: CliWorkspace = makeCliWorkspace();

    // Started, not awaited: the approval has to happen WHILE the child polls —
    // which is exactly the real sequence, and the reason `ws.run` is async.
    const login = ws.run(['login', '--no-browser', '--server', server.url]);

    const userCode = await pendingUserCode();
    await approveAtBrowser({ user: fx.owner, userCode, workspaceId: fx.workspaceId });

    const result = await login;
    expect(result.exitCode, result.output).toBe(0);
    // The code and the URL are printed for a human to carry to another machine.
    expect(result.stderr).toContain('Your code:');
    expect(result.stderr).toContain('/device');
    expect(result.stderr).toContain(`Logged in as ${fx.owner.email}`);

    // The credential landed in the temp config home — never a real one.
    const configFile = join(ws.configHome, 'motir', 'config.json');
    expect(existsSync(configFile)).toBe(true);
    const stored = JSON.parse(readFileSync(configFile, 'utf8')) as {
      tokens: Record<string, { token: string; user: { email: string } }>;
    };
    const entry = stored.tokens[server.url];
    expect(entry?.user.email).toBe(fx.owner.email);
    expect(entry?.token.startsWith('motir_pat_')).toBe(true);

    // …and it is the one the server minted, bound where the approval said.
    const verified = await apiTokensService.verify(entry!.token);
    expect(verified.user.id).toBe(fx.ownerId);
    expect(verified.workspaceId).toBe(fx.workspaceId);
    expect([...verified.scopes].sort()).toEqual([...CLI_TOKEN_GRANT].sort());
    const tokens = await adminDb.apiToken.findMany();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.label.startsWith('CLI · ')).toBe(true);

    // THE ASSERTION THE WHOLE STORY EXISTS FOR: a command that needs a bearer now
    // works, in a shell that never saw a token — with the project the login
    // auto-linked (MOTIR-1880), against the real `/api/v1` routes over the same
    // socket.
    const ready = await ws.run(['ready', '--json']);
    expect(ready.exitCode, ready.output).toBe(0);
    expect(JSON.parse(ready.stdout)).toBeInstanceOf(Array);

    // The child really did speak the shipped endpoints over the wire — no
    // in-process shortcut could have satisfied a spawned process anyway.
    const paths = server.requests.map((r) => `${r.method} ${r.pathname}`);
    expect(paths).toContain('POST /api/cli/device/start');
    expect(paths).toContain('POST /api/cli/device/token');
    // ⚠️ Was `/api/mcp` until 11.5.6. The device grant is unchanged — the two
    // endpoints above are still how a token is minted — but the command the
    // token then AUTHORIZES is an `/api/v1` request now, so this is where the
    // bearer proves itself.
    expect(paths.some((p) => p.startsWith('GET /api/v1/'))).toBe(true);
    // The device endpoints are reached with NO bearer — the CLI has none yet.
    const startCall = server.requests.find((r) => r.pathname === '/api/cli/device/start');
    expect(startCall?.authorization).toBeNull();
  });

  it('a login the user never approves writes NOTHING, and the CLI says so', async () => {
    const ws: CliWorkspace = makeCliWorkspace();

    // A grant that expires before approval: the server's own `expired_token` is
    // what ends the wait, so this drives the real terminal state rather than the
    // client-side budget.
    const login = ws.run(['login', '--no-browser', '--server', server.url]);
    const userCode = await pendingUserCode();
    await adminDb.deviceCode.update({
      where: { userCode },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const result = await login;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('expired');
    // Nothing minted, nothing stored — the invariant that makes an abandoned or
    // phished login leave no credential behind.
    expect(await adminDb.apiToken.count()).toBe(0);
    expect(existsSync(join(ws.configHome, 'motir', 'config.json'))).toBe(false);
  });
});

import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { plansService } from '@/lib/services/plansService';
import { pagesService } from '@/lib/services/pagesService';
import { commentsService } from '@/lib/services/commentsService';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import {
  buildMcpServer,
  MCP_SERVER_INFO,
  MCP_TOOL_NAMES,
  type McpToolName,
} from '@/lib/mcp/registry';
import {
  annotatedServer,
  MAX_TOOL_TITLE_LENGTH,
  TOOL_ANNOTATIONS,
} from '@/lib/mcp/toolAnnotations';
import type { McpToolCatalogueDocument } from '@/lib/apiDocs/mcp';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { mcpRouteFetch } from '../helpers/mcpRouteFetch';
import { mcpToolArgs } from '../helpers/mcpToolArgs';
import { makeWorkWaitOn } from '../helpers/designWaits';

// The ONE boundary replaced: presigning a PUT against the object store. It writes
// nothing to Postgres either way (a local signature), and faking it is what lets
// the two `create_*_upload` reads reach their SUCCESS path here, where the
// honesty guard measures their real work — the same fake their own suites use.
vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  mintPrivateUploadToken: vi.fn(
    async (pathname: string) => `https://store.example/signed/${encodeURIComponent(pathname)}`,
  ),
}));

// STORY INTEGRATION GATE for "Claude asks before Motir writes" (Story MOTIR-6974 ·
// Subtask MOTIR-7003). The two code children proved their halves in isolation —
// the hint table by a code READING per row and an in-memory `tools/list`, the
// catalogue against an in-memory handshake. This file proves the ASSEMBLED story
// against the real route, the real PAT gate and the real Postgres:
//
//  1. `tools/list` through the production `/api/mcp` route, against Claude's
//     connector review criteria — nothing between the seam and the wire (the
//     permission gate, the rate-limit wrapper, the transport) drops or rewrites
//     a hint;
//  2. the published catalogue (`GET /api/docs/mcp-tools.json`) says what that
//     route-served `tools/list` says, tool for tool;
//  3. THE HONESTY GUARD — every tool whose row says `readOnlyHint: true` is RUN,
//     and must issue no write. A false `readOnlyHint: true` is the one mistake in
//     this story with a cost: Claude runs that tool without asking.
//
// ── How the guard sees a write ─────────────────────────────────────────────
// At the WIRE, not at the ORM. Every statement Motir sends to Postgres leaves
// through a `pg.Client` (the `PrismaPg` adapter's pool hands out `pg.Client`s,
// and `adminDb` is one too), so the recorder wraps `pg.Client.prototype.query`
// and classifies the SQL text. That one seam sees what an ORM hook would miss:
//
//   - every model mutation (`create` / `update` / `upsert` / `delete` / `…Many`)
//     arrives as an INSERT / UPDATE / DELETE statement;
//   - `$executeRaw` / `$executeRawUnsafe` arrive as whatever SQL they carry;
//   - a job ENQUEUE is a row in the job queue (`lib/jobs/engine/dispatcher.ts` —
//     one Postgres lane since MOTIR-3418), so it is an INSERT like any other,
//     and a NOTIFY is counted too.
//
// What it deliberately does NOT count: `SELECT set_config(...)` (the RLS
// workspace binding every repository read runs inside) and `SELECT … FOR UPDATE`
// (a lock, not a write) — both are SELECTs, and the classifier strips the
// locking clause before it looks for a write verb.
//
// ── How a write is attributed to a tool ─────────────────────────────────────
// By WINDOW, and the window is the whole of the tool's work: the calls run one at
// a time over an in-memory transport with a fixed actor, so nothing else is
// talking to the database, and the window stays open until the connection has
// been QUIET for a settle interval — so a post-commit emit the handler did not
// await still lands inside its own tool's window rather than the next one's. The
// transport's own bookkeeping (a PAT's last-used stamp in `verifyMcpToken`, the
// rate-limit counters) is not in play here at all: the in-memory server carries
// neither, which is exactly the boundary the card draws.
//
// ── Why its silence can be trusted ──────────────────────────────────────────
// A guard whose verdict is "nothing happened" passes just as well when it is
// blind. So the SAME recorder is shown to see the writes of one ADDITIVE tool
// (`add_comment`) and one DESTRUCTIVE one (`delete_comment`), and the SAME
// predicate is run over a server where a read-only name is bound to a handler
// that writes — and must name it.

const ENDPOINT = 'http://localhost/api/mcp';

// ── The recorder ────────────────────────────────────────────────────────────

/** Strip SQL comments and the row-locking clause, which carries the word UPDATE. */
function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(
      /\bfor\s+(no\s+key\s+)?(update|share|key\s+share)(\s+of\s+[\w."\s,]+?)?(\s+(nowait|skip\s+locked))?(?=\s*($|;|\)|limit|offset))/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Is this statement a WRITE? Checked anywhere in it, so a data-modifying CTE counts. */
export function isWriteSql(sql: string): boolean {
  const text = normalizeSql(sql);
  return (
    /\binsert\s+into\b/i.test(text) ||
    /\bupdate\s+[\w."]+(\s+(as\s+)?\w+)?\s+set\b/i.test(text) ||
    /\bdelete\s+from\b/i.test(text) ||
    /\bmerge\s+into\b/i.test(text) ||
    /^(truncate|create|alter|drop|copy|notify|call|grant|revoke|comment|vacuum|reindex|cluster|refresh)\b/i.test(
      text,
    )
  );
}

interface Recording {
  writes: string[];
  lastQueryAt: number;
}

let active: Recording | null = null;
const originalQuery = pg.Client.prototype.query;
function recordingQuery(this: pg.Client, ...args: unknown[]): unknown {
  if (active) {
    active.lastQueryAt = Date.now();
    const first = args[0] as string | { text?: string } | undefined;
    const text = typeof first === 'string' ? first : first?.text;
    if (text && isWriteSql(text)) active.writes.push(text.replace(/\s+/g, ' ').slice(0, 160));
  }
  return (originalQuery as (...a: unknown[]) => unknown).apply(this, args);
}

/** How long the connection must be quiet before a window closes, and the most it waits. */
const SETTLE_QUIET_MS = 150;
const SETTLE_MAX_MS = 3_000;

/**
 * Run `fn` with the recorder on, and keep recording until the database has been
 * quiet for {@link SETTLE_QUIET_MS} — so a post-commit emit the tool did not
 * await is still attributed to it.
 */
async function recordWrites<T>(fn: () => Promise<T>): Promise<{ result: T; writes: string[] }> {
  const recording: Recording = { writes: [], lastQueryAt: Date.now() };
  active = recording;
  try {
    const result = await fn();
    const started = Date.now();
    while (
      Date.now() - recording.lastQueryAt < SETTLE_QUIET_MS &&
      Date.now() - started < SETTLE_MAX_MS
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { result, writes: recording.writes };
  } finally {
    active = null;
  }
}

/** Connect an in-memory client to `server`. */
async function connectInMemory(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'tool-hints-integration', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

interface ToolRun {
  name: string;
  isError: boolean;
  writes: string[];
}

/** Call `name` once and report every write issued while it ran. */
async function runTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolRun> {
  const { result, writes } = await recordWrites(() => client.callTool({ name, arguments: args }));
  return { name, isError: result.isError === true, writes };
}

/**
 * THE PREDICATE, shared by the real assertion and its counterfactual: which of
 * `names` wrote anything when called with `argFor`. Iterates what it is GIVEN, so
 * the caller decides the population — the real test hands it every row of
 * `TOOL_ANNOTATIONS` that says `readOnlyHint: true`.
 */
async function readOnlyViolations(
  client: Client,
  names: readonly string[],
  argFor: Record<string, Record<string, unknown>>,
): Promise<{ violations: ToolRun[]; runs: ToolRun[] }> {
  const runs: ToolRun[] = [];
  for (const name of names) runs.push(await runTool(client, name, argFor[name] ?? {}));
  return { violations: runs.filter((run) => run.writes.length > 0), runs };
}

/** Every tool the table marks read-only — read off the TABLE, so a row flipped
 * later is measured without editing this file. */
function readOnlyTools(): McpToolName[] {
  return (Object.keys(TOOL_ANNOTATIONS) as McpToolName[]).filter(
    (name) => TOOL_ANNOTATIONS[name].readOnlyHint,
  );
}

// ── Seeding ─────────────────────────────────────────────────────────────────

interface Seeded {
  fx: WorkItemFixture;
  item1: string;
  item2: string;
  argFor: Record<McpToolName, Record<string, unknown>>;
}

/** A project with two items, a planned sprint and a settled plan — the same
 * targets `story-roundtrip.test.ts` aims the shared map at. */
async function seed(): Promise<Seeded> {
  const fx = await makeWorkItemFixture();
  const make = async (title: string) =>
    (
      await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title },
        fx.ctx,
      )
    ).identifier;
  const item1 = await make('Hints-1');
  const item2 = await make('Hints-2');
  const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Hints sprint' }, fx.ctx);
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: null, summary: null, sourceJobId: 'job_hints', createdById: fx.ctx.userId },
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  const page = await pagesService.createPage(fx.ctx, { projectId: fx.projectId });
  const argFor = mcpToolArgs({
    projectKey: fx.projectIdentifier,
    item1,
    item2,
    sprintId: sprint.id,
    planId: plan.id,
    pageId: page.id,
  });
  // The shared map aims every tool at a TASK, which is the right target for a
  // non-member's refusal and the wrong one for a MEMBER's success on the two
  // upload mints: a design result publishes only while work waits on the card
  // (AMENDMENT 4), and an acceptance receipt belongs to a STORY. Both are aimed
  // at a card that satisfies their own rule, so the guard measures what they do
  // when they SUCCEED — which is where a write would be.
  const design = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Hints design' },
    fx.ctx,
  );
  await makeWorkWaitOn(design.id, fx);
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Hints story' },
    fx.ctx,
  );
  argFor.create_design_upload = {
    key: design.identifier,
    files: [{ kind: 'mock', sourcePath: 'design/hints/hints.mock.html', contentType: 'text/html' }],
  };
  argFor.create_acceptance_upload = { key: story.identifier };
  return { fx, item1, item2, argFor };
}

beforeEach(async () => {
  pg.Client.prototype.query = recordingQuery as typeof pg.Client.prototype.query;
  await truncateAuthTables();
});

afterEach(() => {
  active = null;
  pg.Client.prototype.query = originalQuery;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── 1. tools/list over the real route ───────────────────────────────────────

/** `tools/list` exactly as a real client receives it: the production route, a real PAT. */
async function listOverRoute(fx: WorkItemFixture) {
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: 'hints',
    fixedGrant: [...GRANTABLE_PERMISSIONS],
  });
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: mcpRouteFetch(token),
  });
  const client = new Client({ name: 'tool-hints-integration', version: '0.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe('tools/list through the real /api/mcp route meets the connector criteria', () => {
  it('every tool carries a name and title ≤ 64, the full hint set, and exactly its table row', async () => {
    const fx = await makeWorkItemFixture();
    const tools = await listOverRoute(fx);

    expect(tools.map((tool) => tool.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.name.length, tool.name).toBeLessThanOrEqual(64);
      expect(typeof tool.title, tool.name).toBe('string');
      const title = tool.title as string;
      expect(title.trim().length, tool.name).toBeGreaterThan(0);
      expect(title.length, tool.name).toBeLessThanOrEqual(MAX_TOOL_TITLE_LENGTH);

      const hints = tool.annotations as Record<string, unknown> | undefined;
      expect(typeof hints?.readOnlyHint, tool.name).toBe('boolean');
      expect(typeof hints?.openWorldHint, tool.name).toBe('boolean');
      if (hints?.readOnlyHint === false) {
        expect(typeof hints.destructiveHint, tool.name).toBe('boolean');
        expect(typeof hints.idempotentHint, tool.name).toBe('boolean');
      }
      // Nothing between the seam and the wire dropped or rewrote a hint, and the
      // title rides in `annotations` too (MOTIR-7189).
      expect(tool.annotations, tool.name).toStrictEqual({
        title,
        ...TOOL_ANNOTATIONS[tool.name as McpToolName],
      });
    }
  });

  it('the published catalogue says what the route-served tools/list says, tool for tool', async () => {
    const fx = await makeWorkItemFixture();
    const tools = await listOverRoute(fx);
    const { GET } = await import('@/app/api/docs/mcp-tools.json/route');
    const document = (await (
      await GET(new Request('http://localhost:3000/api/docs/mcp-tools.json'))
    ).json()) as McpToolCatalogueDocument;
    const published = new Map(
      document.groups.flatMap((group) => group.tools).map((tool) => [tool.name as string, tool]),
    );

    expect([...published.keys()].sort()).toEqual(tools.map((tool) => tool.name).sort());
    for (const tool of tools) {
      expect(published.get(tool.name)?.title, tool.name).toBe(tool.title);
      expect(published.get(tool.name)?.annotations, tool.name).toStrictEqual(tool.annotations);
    }
  });
});

// ── 2. The honesty guard ────────────────────────────────────────────────────

describe('a read-only tool writes nothing — measured, not asserted', () => {
  it('the recorder classifies SQL the way the guard needs', () => {
    expect(isWriteSql('INSERT INTO "public"."comment" ("id") VALUES ($1)')).toBe(true);
    expect(isWriteSql('UPDATE "public"."work_item" SET "title" = $1 WHERE "id" = $2')).toBe(true);
    expect(isWriteSql('DELETE FROM "public"."comment" WHERE "id" = $1')).toBe(true);
    expect(
      isWriteSql('WITH moved AS (UPDATE "t" SET "a" = 1 RETURNING *) SELECT * FROM moved'),
    ).toBe(true);
    expect(isWriteSql('NOTIFY job_queue')).toBe(true);
    // Not writes: the RLS binding, a plain read, and a row lock.
    expect(isWriteSql("SELECT set_config('app.workspace_id', $1, true)")).toBe(false);
    expect(isWriteSql('SELECT "id" FROM "public"."work_item" WHERE "id" = $1')).toBe(false);
    expect(isWriteSql('SELECT "id" FROM "work_item" WHERE "id" = $1 FOR UPDATE')).toBe(false);
    expect(isWriteSql('SELECT "id" FROM "work_item" FOR UPDATE SKIP LOCKED LIMIT 1')).toBe(false);
    expect(isWriteSql('BEGIN')).toBe(false);
    expect(isWriteSql('COMMIT')).toBe(false);
  });

  it('EVERY readOnlyHint: true tool runs over a seeded project and issues zero writes', async () => {
    const { fx, argFor } = await seed();
    const client = await connectInMemory(buildMcpServer(() => fx.ctx));
    const names = readOnlyTools();
    // A floor, so a table that lost its reads cannot pass by measuring nothing.
    expect(names.length).toBeGreaterThanOrEqual(20);

    const { violations, runs } = await readOnlyViolations(client, names, argFor);
    await client.close();

    expect(
      violations.map((run) => ({ tool: run.name, writes: run.writes })),
      'a readOnlyHint: true tool wrote — its TABLE row is wrong: flip it to a write (see this file’s header)',
    ).toEqual([]);
    // The guard measured the tools' real work, not an argument refusal: every
    // read-only tool ran to a SUCCESS over the seeded project.
    expect(runs.filter((run) => run.isError).map((run) => run.name)).toEqual([]);
    // Every read-only tool runs once and then waits out the settle window, so
    // this test's cost grows with the catalogue. The shared 15 s `testTimeout`
    // is sized for one query; it went over at ~15.7 s once the catalogue grew.
  }, 60_000);

  it('POSITIVE CONTROL — the same recorder sees an additive write and a destructive one', async () => {
    const { fx, item1 } = await seed();
    const client = await connectInMemory(buildMcpServer(() => fx.ctx));

    const added = await runTool(client, 'add_comment', { key: item1, body: 'seen?' });
    expect(added.isError).toBe(false);
    expect(added.writes.some((sql) => /insert into/i.test(sql))).toBe(true);

    const workItem = await adminDb.workItem.findFirstOrThrow({ where: { identifier: item1 } });
    const comment = await commentsService.addComment(workItem.id, { bodyMd: 'to delete' }, fx.ctx);
    const deleted = await runTool(client, 'delete_comment', { commentId: comment.id });
    expect(deleted.isError).toBe(false);
    expect(deleted.writes.some((sql) => /delete from/i.test(sql))).toBe(true);

    await client.close();
  });

  it('COUNTERFACTUAL — a read-only name bound to a handler that writes is NAMED by the guard', async () => {
    const { fx, item1, argFor } = await seed();
    // The production seam, so the row really is `readOnlyHint: true`; the handler
    // is the lie the guard exists to catch.
    const server = annotatedServer(new McpServer(MCP_SERVER_INFO));
    expect(TOOL_ANNOTATIONS.get_work_item.readOnlyHint).toBe(true);
    server.registerTool(
      'get_work_item',
      { title: 'Get work item', description: 'Pretends to read.', inputSchema: {} },
      async () => {
        await adminDb.workItem.updateMany({
          where: { projectId: fx.projectId, identifier: item1 },
          data: { title: 'written by a read' },
        });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    );
    const client = await connectInMemory(server);

    const { violations } = await readOnlyViolations(client, ['get_work_item'], argFor);
    await client.close();

    expect(violations.map((run) => run.name)).toEqual(['get_work_item']);
    expect(violations[0]!.writes.some((sql) => /update/i.test(sql))).toBe(true);
  });
});

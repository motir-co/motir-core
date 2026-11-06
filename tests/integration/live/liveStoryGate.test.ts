import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import type { WorkbenchWatermarkDto } from '@/lib/dto/workbench';
import { LIVE_SIGNAL_TABLES, type LiveSignalTable } from '@/lib/live/liveSignalTables';
import { LIVE_SIGNAL_CHANNEL } from '@/lib/live/liveNotification';
import { LIVE_SIGNAL_IDLE_CLOSE_MS } from '@/lib/live/liveSignalHub';
import { buildMcpServer } from '@/lib/mcp/registry';
import { ADD_PLAN_ITEMS_TOOL_NAME } from '@/lib/mcp/tools/authorPlan';
import { MOVE_TO_PARENT_TOOL_NAME } from '@/lib/mcp/tools/moveToParent';
import { statusDerivationOnRequested } from '@/lib/jobs/definitions/statusDerivation';
import { foldersService } from '@/lib/services/foldersService';
import { plansService } from '@/lib/services/plansService';
import { projectsService } from '@/lib/services/projectsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { watchersService } from '@/lib/services/watchersService';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  WORKBENCH_STREAM_COALESCE_MS,
  WORKBENCH_STREAM_READ_CONCURRENCY,
  getWorkbenchStreamCoalescer,
} from '@/lib/workbench/workbenchStreamCoalescer';
import {
  WORKBENCH_STREAM_BACKSTOP_MS,
  WORKBENCH_STREAM_RECONNECT_JITTER_MS,
  createWorkbenchStreamSession,
  type WorkbenchStreamActor,
} from '@/lib/workbench/workbenchStreamSession';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestUser } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { JobTestEngine, spyOnJobDispatch } from '../../helpers/jobs';
import {
  commitToFrame,
  expectPlanFrameShape,
  heldVersion,
  isPlan,
  isWatermark,
  makeLiveFixture,
  manualTimers,
  movedTab,
  p95,
  planFrameFor,
  rawId,
  streamOpener,
  until,
  type Latency,
  type LiveFixture,
  type OpenStream,
  type Reader,
  type StreamFrame,
} from './liveStoryFixtures';

// THE LIVE-PUSH STORY GATE (Story MOTIR-8542 · Subtask MOTIR-8733).
//
// Every card of the story proved its own piece against a fake: the triggers
// against a raw LISTEN client, the hub against its own session, the route and
// the plan frames against a fake hub and fake timers, the browser source and the
// hook against a stubbed fetch. Nothing ran them TOGETHER. This file does, on the
// worker's real Postgres: a committed write fires the real trigger, the
// process's one real hub hears it, the real coalescer and read limiter schedule
// the re-read, the reader's own watermark / plan read runs under their own
// context, and the SHIPPED route writes — or does not write — a frame.
//
// Only the cookie resolver is stubbed (the test environment has no cookies), and
// motir-ai's preplan read, which an MCP plan author consults and no live path
// touches. Cases 6 and 7 build the session directly: its injected `timers` seam
// is the point of those two, and it is the only place time is simulated.

const workspaceCtx = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => workspaceCtx.current };
});
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  getPreplanState: vi.fn(async () => ({ session: null, docs: [], catalog: null })),
}));

const { GET } = await import('@/app/api/workbench/stream/route');
const { WORKBENCH_STREAM_HEARTBEAT_MS } = await import('@/app/api/workbench/stream/route');
const { getLiveSignalHub } = await import('@/lib/live/liveSignalHub');
const { workbenchWatermarkService } = await import('@/lib/services/workbenchWatermarkService');

const T = { timeout: 120_000 };

const open = streamOpener(GET, (reader) => {
  workspaceCtx.current = reader;
});

let lf: LiveFixture;
const streams: OpenStream[] = [];

async function stream(reader: Reader, opts?: Parameters<typeof open>[1]): Promise<OpenStream> {
  const s = await open(reader, opts);
  expect(s.status).toBe(200);
  streams.push(s);
  // The opening frame is written even when nothing moved; wait for it so every
  // later frame is the answer to a write.
  await s.next(isWatermark, 'the opening frame');
  return s;
}

beforeEach(async () => {
  spyOnJobDispatch();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "watcher", "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  lf = await makeLiveFixture();
});

afterEach(async () => {
  await Promise.all(streams.splice(0).map((s) => s.close()));
  vi.restoreAllMocks();
});

afterAll(async () => {
  await getLiveSignalHub().stop();
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Wait until the process's listener is LISTENING, so a write takes the push path, not the catch-up. */
async function listening(): Promise<void> {
  await until(() => getLiveSignalHub().connected, 'the live-signal listener to connect');
}

async function mcp(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'live-story-gate', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function tool(client: Client, name: string, args: Record<string, unknown>): Promise<void> {
  const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = (res.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  expect(res.isError, `${name}: ${text}`).toBeFalsy();
}

async function card(
  title: string,
  extra: { kind?: 'task' | 'story' | 'subtask'; parentId?: string; assigneeId?: string } = {},
) {
  return workItemsService.createWorkItem(
    {
      projectId: lf.fx.projectId,
      kind: extra.kind ?? 'task',
      title,
      ...(extra.parentId ? { parentId: extra.parentId } : {}),
      ...(extra.assigneeId ? { assigneeId: extra.assigneeId } : {}),
    },
    lf.fx.ctx,
  );
}

/** A card the SECOND member files — so the reader neither reports nor auto-watches it. */
async function membersCard(title: string) {
  return workItemsService.createWorkItem(
    { projectId: lf.fx.projectId, kind: 'task', title },
    lf.member,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 1 · every writer is heard ───────────────────────────────────────────────

describe('1 · every writer is heard, on every tab and on a generating plan', () => {
  it(
    'service, job, MCP and raw SQL writes each reach the open stream; p95 ≤ 2000 ms',
    T,
    async () => {
      const { fx, reader, planG } = lf;
      // Set-up writes, all BEFORE the stream opens.
      const toWatch = await membersCard('Somebody else’s card');
      const story = await card('A story', { kind: 'story' });
      const child = await card('Its child', { kind: 'subtask', parentId: story.id });
      await adminDb.$executeRaw`UPDATE "work_item" SET "status" = 'in_progress' WHERE "id" = ${child.id}`;
      const toFinish = await card('A card about to finish');
      const toFile = await card('A card to file');
      const folder = await foldersService.createFolder(
        { projectId: fx.projectId, parentFolderId: null, name: 'Filed' },
        fx.ctx,
      );
      const proposed = await plansService.createPlan(fx.projectId, { title: 'To review' }, fx.ctx);
      const client = await mcp(fx.ctx);

      const g0 = await heldVersion(planG, reader);
      const s = await stream(reader, { watch: [{ planId: planG, version: g0 }] });
      await listening();
      const latencies: Latency[] = [];

      // SERVICE — files a card: To do.
      latencies.push(
        await commitToFrame(
          s,
          'service: file a card',
          () => card('Filed by the service'),
          movedTab('toDo'),
        ),
      );
      // SERVICE — watches a card: Watching.
      latencies.push(
        await commitToFrame(
          s,
          'service: watch a card',
          () => watchersService.watch(toWatch.id, fx.ctx),
          movedTab('watching'),
        ),
      );
      // JOB — the status rollup moves the story up to In progress.
      latencies.push(
        await commitToFrame(
          s,
          'job: status rollup',
          async () => {
            const { error } = await new JobTestEngine({
              function: statusDerivationOnRequested,
              events: [
                {
                  name: 'work-item/derivation.requested',
                  data: {
                    workspaceId: fx.workspaceId,
                    parentId: story.id,
                    workItemId: child.id,
                    reason: 'imported-status-pinned',
                  },
                },
              ],
            }).execute();
            expect(error).toBeUndefined();
          },
          movedTab('inProgress'),
        ),
      );
      // MCP — move_to_parent files a card into a folder: To do.
      latencies.push(
        await commitToFrame(
          s,
          'mcp: move_to_parent',
          () =>
            tool(client, MOVE_TO_PARENT_TOOL_NAME, { key: toFile.identifier, folderId: folder.id }),
          movedTab('toDo'),
        ),
      );
      // MCP — add_plan_items closing a plan raises its review gate: Waiting on you.
      latencies.push(
        await commitToFrame(
          s,
          'mcp: add_plan_items (final)',
          () =>
            tool(client, ADD_PLAN_ITEMS_TOOL_NAME, {
              planId: proposed.id,
              proposals: [{ op: 'add', proposedFields: { title: 'Reviewed card', kind: 'task' } }],
              final: true,
            }),
          movedTab('approvals'),
        ),
      );
      // MCP — add_plan_items on the WATCHED generating plan: a plan frame.
      const planFrom = s.frames.length;
      latencies.push(
        await commitToFrame(
          s,
          'mcp: add_plan_items (generating)',
          () =>
            tool(client, ADD_PLAN_ITEMS_TOOL_NAME, {
              planId: planG,
              proposals: [{ op: 'add', proposedFields: { title: 'A new proposal', kind: 'task' } }],
            }),
          planFrameFor(planG),
        ),
      );
      const planFrame = await s.next(planFrameFor(planG), 'the plan frame', { from: planFrom });
      expectPlanFrameShape(planFrame, planG, g0);
      // RAW SQL — a card finishes outside every service: Recently finished.
      latencies.push(
        await commitToFrame(
          s,
          'raw sql: finish a card',
          () =>
            adminDb.$executeRaw`UPDATE "work_item" SET "status" = 'done', "completedAt" = now(), "updatedAt" = now() WHERE "id" = ${toFinish.id}`,
          movedTab('recentlyFinished'),
        ),
      );

      // Every Workbench tab the story names was moved by one of the writers above.
      const moved = new Set(s.frames.filter(isWatermark).flatMap((f) => f.data.moved));
      for (const tab of ['toDo', 'inProgress', 'recentlyFinished', 'approvals', 'watching']) {
        expect(moved, `tab ${tab}`).toContain(tab);
      }
      for (const l of latencies) expect(l.ms, l.label).toBeLessThanOrEqual(5_000);
      expect(p95(latencies), JSON.stringify(latencies)).toBeLessThanOrEqual(2_000);
    },
  );
});

// ── 2 · table coverage through the live path ───────────────────────────────

describe('2 · every table in LIVE_SIGNAL_TABLES is heard end to end', () => {
  it('a raw write to each one produces a frame on the open stream', T, async () => {
    const { fx, reader, planG } = lf;
    const w = fx.workspaceId;
    const p = fx.projectId;
    const r = reader.userId;
    const mine = await card('Mine');
    const watched = await membersCard('To be watched');
    // An approve-and-merge row on the reader's To approve, and the pull request its review
    // rows hang off (Bug MOTIR-10504) — set up before the stream opens. None of
    // `github_installation`, `github_repo` or `github_pull_request` is heard.
    const merging = await card('Awaiting its merge');
    const installation = rawId('gi');
    const repo = rawId('gr');
    const pr = rawId('gpr');
    const record = rawId('rvr');
    await adminDb.$executeRaw`INSERT INTO "approval_gate" ("id","workspace_id","project_id","work_item_id","kind","subject_id","subject_version","updated_at") VALUES (${rawId('ag')},${w},${p},${merging.id},'pull_request_approval',${merging.id},'moooon/acme#1@sha-a',now())`;
    await adminDb.$executeRaw`INSERT INTO "github_installation" ("id","installation_id","workspace_id","account_login","account_type","updated_at") VALUES (${installation},${rawId('inst')},${w},'moooon','Organization',now())`;
    await adminDb.$executeRaw`INSERT INTO "github_repo" ("id","installation_id","workspace_id","organization_id","repo_id","owner","name","default_branch","updated_at") SELECT ${repo},${installation},ws."id",ws."organizationId",${rawId('repo')},'moooon','acme','main',now() FROM "workspace" ws WHERE ws."id" = ${w}`;
    await adminDb.$executeRaw`INSERT INTO "github_pull_request" ("id","repo_id","number","state","head_ref","updated_at") VALUES (${pr},${repo},1,'open','subtask/merging',now())`;

    // One raw write per table, each with the frame it must produce.
    const writes: Record<
      LiveSignalTable,
      { run: () => Promise<unknown>; frame: (f: StreamFrame) => boolean }
    > = {
      work_item: {
        run: () =>
          adminDb.$executeRaw`UPDATE "work_item" SET "title" = 'Renamed', "updatedAt" = now() WHERE "id" = ${mine.id}`,
        frame: movedTab('toDo'),
      },
      watcher: {
        run: () =>
          adminDb.$executeRaw`INSERT INTO "watcher" ("id","work_item_id","user_id") VALUES (${rawId('wt')},${watched.id},${r})`,
        frame: movedTab('watching'),
      },
      approval_gate: {
        run: () =>
          adminDb.$executeRaw`INSERT INTO "approval_gate" ("id","workspace_id","project_id","kind","subject_id","routed_to_id","updated_at") VALUES (${rawId('ag')},${w},${p},'plan_approval',${rawId('subject')},${r},now())`,
        frame: movedTab('approvals'),
      },
      plan_change_session: {
        run: () => {
          const id = rawId('pcs');
          return adminDb.$executeRaw`INSERT INTO "plan_change_session" ("id","workspace_id","project_id","scope_key","created_by_id","failed_at","failure_reason","updated_at") VALUES (${id},${w},${p},${id},${r},now(),'rate_limited',now())`;
        },
        frame: movedTab('toResume'),
      },
      plan: {
        run: () =>
          adminDb.$executeRaw`UPDATE "plan" SET "title" = 'Retitled' WHERE "id" = ${planG}`,
        frame: planFrameFor(planG),
      },
      plan_item: {
        run: () =>
          adminDb.$executeRaw`INSERT INTO "plan_item" ("id","workspace_id","plan_id","op") VALUES (${rawId('pi')},${w},${planG},'add')`,
        frame: planFrameFor(planG),
      },
      plan_revision: {
        run: () =>
          adminDb.$executeRaw`INSERT INTO "plan_revision" ("id","plan_id","change_kind","diff") VALUES (${rawId('pr')},${planG},'edit','{}'::jsonb)`,
        frame: planFrameFor(planG),
      },
      plan_step: {
        run: () =>
          adminDb.$executeRaw`INSERT INTO "plan_step" ("id","plan_id","session_key","kind","started_at") VALUES (${rawId('ps')},${planG},'s1','lay',now())`,
        frame: planFrameFor(planG),
      },
      plan_narration: {
        run: () =>
          adminDb.$executeRaw`INSERT INTO "plan_narration" ("id","plan_id","session_key","seq","body") VALUES (${rawId('pn')},${planG},'s1',1,'Laying the plan')`,
        frame: planFrameFor(planG),
      },
      // The review rows behind the To approve row (Bug MOTIR-10504), each heard on the
      // tab the row is on.
      review_verdict_record: {
        run: () =>
          adminDb.$executeRaw`INSERT INTO "review_verdict_record" ("id","workspace_id","project_id","work_item_id","subject_version","verdict","outcome","harness","model") VALUES (${record},${w},${p},${merging.id},'moooon/acme#1@sha-a','changes_requested','recorded','Claude Code','claude-opus-5-5')`,
        frame: movedTab('approvals'),
      },
      review_dismissal: {
        run: () =>
          adminDb.$executeRaw`INSERT INTO "review_dismissal" ("id","workspace_id","project_id","work_item_id","review_verdict_record_id","subject_version","reason_md") VALUES (${rawId('rd')},${w},${p},${merging.id},${record},'moooon/acme#1@sha-a','Reviewed by hand.')`,
        frame: movedTab('approvals'),
      },
      work_item_delivery: {
        run: () =>
          adminDb.$executeRaw`INSERT INTO "work_item_delivery" ("id","workspace_id","work_item_id","github_pull_request_id","repo_id") VALUES (${rawId('wid')},${w},${merging.id},${pr},${repo})`,
        frame: movedTab('approvals'),
      },
      github_pull_request_review: {
        run: () =>
          adminDb.$executeRaw`INSERT INTO "github_pull_request_review" ("id","github_review_id","github_pull_request_id","reviewer_github_user_id","reviewer_login","reviewer_type","state","commit_sha","reviewer_permission","submitted_at","updated_at") VALUES (${rawId('gprr')},${rawId('review')},${pr},'77','octo','User','approved','sha-a','write',now(),now())`,
        frame: movedTab('approvals'),
      },
      plan_narration_session: {
        run: () =>
          adminDb.$executeRaw`INSERT INTO "plan_narration_session" ("id","plan_id","session_key","step_kind","updated_at") VALUES (${rawId('pns')},${planG},'s1','lay',now())`,
        frame: planFrameFor(planG),
      },
    };

    const s = await stream(reader, {
      watch: [{ planId: planG, version: await heldVersion(planG, reader) }],
    });
    await listening();
    // The list is IMPORTED: a table added to it without a write here fails by name.
    for (const table of Object.keys(LIVE_SIGNAL_TABLES) as LiveSignalTable[]) {
      const write = writes[table];
      expect(write, `no raw write for ${table}`).toBeDefined();
      await commitToFrame(s, `raw write to ${table}`, write.run, write.frame);
    }
  });
});

// ── 3 · the leak fixture ────────────────────────────────────────────────────

describe('3 · a reader is told nothing about what they cannot see', () => {
  it(
    'the second member hears nothing of the reader’s card or the closed plan, and still hears their own',
    T,
    async () => {
      const { fx, reader, member, planB } = lf;
      const readersCard = await card('Assigned to the reader', { assigneeId: reader.userId });
      const b0 = await heldVersion(planB, reader);

      const m1 = await stream(reader, { watch: [{ planId: planB, version: b0 }] });
      const m2 = await stream(member, { watch: [{ planId: planB, version: null }] });
      await listening();
      expect(m2.frames).toHaveLength(1);

      const m1From = m1.frames.length;
      await adminDb.$executeRaw`UPDATE "work_item" SET "title" = 'Moved', "updatedAt" = now() WHERE "id" = ${readersCard.id}`;
      await plansService.addProposals(
        planB,
        [
          {
            op: 'add' as const,
            proposedFields: { title: 'Behind closed doors', kind: 'task' as const },
          },
        ],
        fx.ctx,
      );
      await m1.next(movedTab('toDo'), 'the reader’s card frame', { from: m1From });
      await m1.next(planFrameFor(planB), 'the reader’s plan frame', { from: m1From });

      // Two coalescing windows and the reads behind them: still only the opening frame.
      await sleep(WORKBENCH_STREAM_COALESCE_MS * 2 + 750);
      expect(m2.frames, 'the second member received a frame').toHaveLength(1);
      expect(m2.frames.some(isPlan)).toBe(false);

      // …and the stream is alive, not broken: a write the member CAN see is heard.
      await card('Assigned to the member', { assigneeId: member.userId });
      await m2.next(movedTab('toDo'), 'the member’s own frame', { from: 1 });
      expect(m2.frames.some(isPlan)).toBe(false);
    },
  );
});

// ── 4 · burst coalescing ────────────────────────────────────────────────────

describe('4 · a burst of 189 MCP writes', () => {
  it(
    'costs each stream at most one read per window, within the limiter, and ends on the final state',
    T,
    async () => {
      const { fx, reader } = lf;
      const others: Reader[] = [lf.member];
      const u = await createTestUser({ email: 'burst@ex.com', name: 'Third member' });
      await workspacesService.addMember({ userId: u.id, workspaceId: fx.workspaceId });
      others.push({ userId: u.id, workspaceId: fx.workspaceId });
      await projectsService.setActiveProject({ ...others[1]!, projectId: fx.projectId });
      const target = await card('Shuttled between folders');
      const folders = await Promise.all(
        ['Left', 'Right'].map((name) =>
          foldersService.createFolder(
            { projectId: fx.projectId, parentFolderId: null, name },
            fx.ctx,
          ),
        ),
      );
      const client = await mcp(fx.ctx);

      const readers = [reader, ...others];
      const opened = [];
      for (const r of readers) opened.push(await stream(r));
      await listening();

      // Spy the reader's own watermark read, per stream (per reader), with its start time.
      const real = workbenchWatermarkService.read.bind(workbenchWatermarkService);
      const calls = new Map<string, number[]>();
      let active = 0;
      let maxActive = 0;
      let maxLimiter = 0;
      vi.spyOn(workbenchWatermarkService, 'read').mockImplementation(async (ctx, since) => {
        const list = calls.get(ctx.userId) ?? [];
        list.push(Date.now());
        calls.set(ctx.userId, list);
        active += 1;
        maxActive = Math.max(maxActive, active);
        maxLimiter = Math.max(maxLimiter, getWorkbenchStreamCoalescer().activeReads);
        try {
          return await real(ctx, since);
        } finally {
          active -= 1;
        }
      });

      const started = Date.now();
      for (let i = 0; i < 189; i++) {
        await tool(client, MOVE_TO_PARENT_TOOL_NAME, {
          key: target.identifier,
          folderId: folders[i % 2]!.id,
        });
      }
      const elapsed = Date.now() - started;
      // Let the last window close and its reads land.
      await sleep(WORKBENCH_STREAM_COALESCE_MS * 4);
      await until(() => active === 0, 'the last reads to settle');

      // A window per key is ≥ COALESCE_MS long, and each closed window asks each
      // stream for ONE read — so no stream can have read more often than that.
      const windows = Math.ceil((Date.now() - started) / WORKBENCH_STREAM_COALESCE_MS) + 1;
      for (const r of readers) {
        const n = calls.get(r.userId)?.length ?? 0;
        expect(n, `reads for ${r.userId} over ${elapsed} ms`).toBeGreaterThan(0);
        expect(n).toBeLessThanOrEqual(windows);
        // Fewer reads than writes, always. "FAR below" is a claim about a burst,
        // and only holds when the writes came faster than the window: on a loaded
        // runner a single write can outlast it, and then each window honestly
        // holds one write — the `windows` bound above is the invariant.
        expect(n, 'fewer reads than writes').toBeLessThan(189);
        if (elapsed / 189 < WORKBENCH_STREAM_COALESCE_MS / 3) {
          expect(n, 'far below one read per write').toBeLessThan(189 / 3);
        }
      }
      expect(maxActive).toBeLessThanOrEqual(WORKBENCH_STREAM_READ_CONCURRENCY);
      expect(maxLimiter).toBeLessThanOrEqual(WORKBENCH_STREAM_READ_CONCURRENCY);

      // The reader ended on the FINAL state: its last cursor names nothing moved.
      vi.restoreAllMocks();
      const last = opened[0]!.frames.filter(isWatermark).at(-1)!;
      const fresh = await stream(reader, { since: last.data.cursor });
      const opening = fresh.frames.find(isWatermark)!;
      expect(opening.data.moved).toEqual([]);
    },
  );
});

// ── 5 · one LISTEN session ──────────────────────────────────────────────────

interface Backend {
  pid: number;
  usename: string;
  state: string | null;
  query: string;
  application_name: string;
}

async function backends(): Promise<Backend[]> {
  return adminDb.$queryRaw<Backend[]>`
    SELECT pid, usename, state, query, application_name
      FROM pg_stat_activity
     WHERE datname = current_database() AND pid <> pg_backend_pid()`;
}

const isListener = (b: Backend) => b.query === `LISTEN ${LIVE_SIGNAL_CHANNEL}`;

describe('5 · one LISTEN session per process', () => {
  it(
    '25 open streams share ONE listening backend, hold no transaction, and it closes after the last',
    T,
    async () => {
      const { reader } = lf;
      const many: OpenStream[] = [];
      for (let i = 0; i < 25; i++) many.push(await stream(reader));
      await listening();

      const all = await backends();
      const listeners = all.filter(isListener);
      expect(listeners, JSON.stringify(all)).toHaveLength(1);
      // On the direct URL's role — the one the hub resolves first.
      const url = new URL(process.env['DATABASE_URL_UNPOOLED'] ?? process.env['DATABASE_URL']!);
      expect(listeners[0]!.usename).toBe(decodeURIComponent(url.username));
      // No stream holds a transaction open between reads.
      expect(all.filter((b) => (b.state ?? '').startsWith('idle in transaction'))).toEqual([]);

      await Promise.all(many.map((s) => s.close()));
      streams.length = 0;
      await until(() => getLiveSignalHub().subscriberCount === 0, 'every stream to unsubscribe');
      await sleep(LIVE_SIGNAL_IDLE_CLOSE_MS + 500);
      await until(() => !getLiveSignalHub().connected, 'the hub to close its session');
      let gone = false;
      for (let i = 0; i < 50 && !gone; i++) {
        gone = (await backends()).filter(isListener).length === 0;
        if (!gone) await sleep(100);
      }
      expect(gone, 'the listening backend is gone').toBe(true);
    },
  );
});

// ── 6 · the missed-notification backstop ────────────────────────────────────

function actorOf(reader: Reader): WorkbenchStreamActor {
  return { ...reader, projectId: lf.fx.projectId };
}

describe('6 · a listener that drops', () => {
  it(
    'logs one warn and one info, catches up on reconnect, and the backstop alone also converges',
    T,
    async () => {
      const { reader } = lf;
      const warn = vi.spyOn(console, 'warn');
      const info = vi.spyOn(console, 'info');
      const timers = manualTimers();
      const written: WorkbenchWatermarkDto[] = [];
      const reads: number[] = [];
      const session = createWorkbenchStreamSession({
        actor: actorOf(reader),
        hub: getLiveSignalHub(),
        read: async (actor, cursor) => {
          reads.push(Date.now());
          return workbenchWatermarkService.read(actor, cursor);
        },
        write: (reading) => written.push(reading),
        timers,
        random: () => 0.5,
      });
      await session.start(null);
      await listening();
      // The hub's first connect announces itself too: drain that catch-up first.
      timers.fire((ms) => ms < WORKBENCH_STREAM_RECONNECT_JITTER_MS);
      await until(() => timers.pending().length === 1, 'the opening catch-up to settle');
      expect(timers.pending()).toEqual([WORKBENCH_STREAM_BACKSTOP_MS]);
      warn.mockClear();
      info.mockClear();

      // Kill the listening backend, then commit while the hub is down.
      const [listener] = (await backends()).filter(isListener);
      await adminDb.$queryRaw`SELECT pg_terminate_backend(${listener!.pid}::int)`;
      await until(() => !getLiveSignalHub().connected, 'the hub to notice it is down');
      await card('Written while nobody listened');
      expect(written).toHaveLength(0);

      // Reconnect: one recovery line, and a catch-up read scheduled on the seam.
      await until(() => getLiveSignalHub().connected, 'the hub to reconnect', 15_000);
      const downLines = warn.mock.calls.filter((c) =>
        String(c[0]).startsWith('[live-signal] listener down'),
      );
      const upLines = info.mock.calls.filter((c) =>
        String(c[0]).startsWith('[live-signal] listener recovered'),
      );
      expect(downLines).toHaveLength(1);
      expect(upLines).toHaveLength(1);
      expect(timers.pending()).toContain(Math.floor(0.5 * WORKBENCH_STREAM_RECONNECT_JITTER_MS));

      // The catch-up runs BEFORE the backstop, and it is what converges.
      const readsBefore = reads.length;
      expect(timers.fire((ms) => ms < WORKBENCH_STREAM_RECONNECT_JITTER_MS)).toBe(1);
      await until(() => written.length === 1, 'the catch-up frame');
      expect(reads.length).toBe(readsBefore + 1);
      expect(written[0]!.moved).toContain('toDo');
      session.close();
    },
  );

  it('with every notification missed, ONE backstop interval converges the page', T, async () => {
    const { reader } = lf;
    const timers = manualTimers();
    const written: WorkbenchWatermarkDto[] = [];
    // A hub that never delivers: every notification is lost.
    const deaf = { subscribe: () => () => {} };
    const session = createWorkbenchStreamSession({
      actor: actorOf(reader),
      hub: deaf,
      read: (actor, cursor) => workbenchWatermarkService.read(actor, cursor),
      write: (reading) => written.push(reading),
      timers,
    });
    await session.start(null);
    await card('Nobody heard this');
    await sleep(WORKBENCH_STREAM_COALESCE_MS * 2);
    expect(written).toHaveLength(0);

    expect(timers.fire((ms) => ms === WORKBENCH_STREAM_BACKSTOP_MS)).toBe(1);
    await until(() => written.length === 1, 'the backstop frame');
    expect(written[0]!.moved).toContain('toDo');
    session.close();
  });
});

// ── 7 · a quiet stream costs nothing ────────────────────────────────────────

describe('7 · a quiet stream', () => {
  it(
    'reads once at open and at most once per backstop over five minutes, and writes no frame',
    T,
    async () => {
      const { reader } = lf;
      const timers = manualTimers();
      // A notification an EARLIER case's write raised can still be on its way to
      // the process hub when this case opens, and it costs one read here. That
      // read is the stream doing its job, not the quiet stream's cost, so each
      // read is attributed: to the backstop that was just fired, or to a signal.
      let backstopFired = false;
      let backstopReads = 0;
      let reads = 0;
      let active = 0;
      const written: WorkbenchWatermarkDto[] = [];
      const session = createWorkbenchStreamSession({
        actor: actorOf(reader),
        hub: getLiveSignalHub(),
        read: async (actor, cursor) => {
          reads += 1;
          if (backstopFired) backstopReads += 1;
          backstopFired = false;
          active += 1;
          try {
            return await workbenchWatermarkService.read(actor, cursor);
          } finally {
            active -= 1;
          }
        },
        write: (reading) => written.push(reading),
        timers,
      });
      await session.start(null);
      expect(reads).toBe(1);
      const armed = () => active === 0 && timers.pending().includes(WORKBENCH_STREAM_BACKSTOP_MS);
      // Five simulated minutes: the backstop is re-armed after each read.
      for (let minute = 0; minute < 5; minute++) {
        await until(armed, `the backstop armed for minute ${minute + 1}`);
        backstopFired = true;
        expect(timers.fire((ms) => ms === WORKBENCH_STREAM_BACKSTOP_MS)).toBe(1);
        await until(() => !backstopFired, `the backstop read of minute ${minute + 1}`);
      }
      await until(armed, 'the last backstop read to settle');
      expect(backstopReads).toBe(5);
      expect(written).toEqual([]);
      session.close();
    },
  );

  it('a silent route stream writes a `:` heartbeat comment, never a frame', T, async () => {
    const s = await stream(lf.reader);
    // Real time: the heartbeat is the route's own timer, and nothing else may run here.
    await until(
      () => s.comments.length > 0,
      'the heartbeat',
      WORKBENCH_STREAM_HEARTBEAT_MS + 5_000,
    );
    expect(s.comments[0]).toMatch(/^:/);
    expect(s.frames).toHaveLength(1);
  });
});

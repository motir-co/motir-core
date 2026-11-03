import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The ONE mock: the motir-ai HTTP client — the external service boundary
// (CLAUDE.md's sanctioned carve-out, same as the sibling plan-edit suites,
// e.g. tests/mcp/expand-item.test.ts). Everything below it is real: a real
// Postgres, the real MCP server + transport, the real `planChangeSessionsService`
// (its row-locked `seq` allocation, its accumulated-intent build, its submit
// transaction) and the real Plan rows. So what these tests assert about the
// thread and the Plan is what production actually writes.
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { getJob, streamJob, submitJob } from '@/lib/ai/motirAiClient';
import { MotirAiOutOfCreditsError } from '@/lib/ai/errors';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { toolPermission } from '@/lib/mcp/toolPermissions';
import { GRANTABLE_PERMISSIONS, type TokenGrant } from '@/lib/tokens/grant';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import {
  APPEND_PLAN_TURN_TOOL_NAME,
  OPEN_PLAN_SESSION_TOOL_NAME,
  SUBMIT_PLAN_SESSION_TOOL_NAME,
} from '@/lib/mcp/tools/planSession';
import {
  buildAccumulatedIntent,
  planChangeSessionsService,
} from '@/lib/services/planChangeSessionsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import {
  AI_REQUIREMENT_FIELDS,
  AI_REQUIREMENT_REQUIRED_NON_EMPTY,
  completeRequirement,
  satisfiesBuildRequirement,
} from '../fixtures/settledRequirement';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addressOf, openTestSession } from '../helpers/planSession';

// The plan-change CONVERSATION over MCP (Story 7.9 · MOTIR-1832) — the
// mechanism `motir plan` talks through, and the thing that makes terminal
// planning a dialogue rather than a one-shot prompt.
//
// The four contracts these lock, in the order a caller meets them:
//
//   1. ONE THREAD PER SCOPE, RESUMED — not forked. Re-opening a project (or the
//      same anchor set, in any order or case) returns the SAME row with its
//      turns; a DIFFERENT anchor set is a different conversation.
//   2. THE SAME THREAD THE WEB PANEL SEES. A turn added over MCP is on the row
//      the cookie routes read, and vice versa — asserted in BOTH directions
//      against the real Postgres, because "one substrate" is only true if the
//      two surfaces cannot drift apart.
//   3. ACCUMULATE ≠ SUBMIT. Appending starts no job. Submitting sends EVERY turn
//      as one intent (`buildAccumulatedIntent`'s numbered framing for N, byte-
//      identical pass-through for one), and an empty thread refuses with the
//      typed error rather than firing an empty job.
//   4. SUBMIT AND RETURN, AND IT PROPOSES. `{ jobId, planId }` comes back the
//      instant motir-ai accepts (asserted NEGATIVELY too — nothing streamed,
//      nothing polled), the marker turn records the job, and a FAILED submit
//      leaves the thread whole with no orphan Plan.
//
// Built with a FIXED-context resolver over the in-memory transport (the
// tools.test.ts pattern), plus one scope-gated server for the read-only-token
// matrix. The bearer/auth plumbing is the story-roundtrip suite's job.

const struct = (r: CallToolResult) => r.structuredContent as Record<string, unknown>;
const session = (r: CallToolResult) => r.structuredContent as unknown as PlanChangeSessionDto;
const text = (r: CallToolResult) => JSON.stringify(r.content);

/** Connect an in-memory client to a server bound to `ctx` (no permission gate). */
async function connectClient(ctx: ServiceContext, grant?: TokenGrant): Promise<Client> {
  const server = grant
    ? buildMcpServer(
        () => ctx,
        () => [...grant],
      )
    : buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'plan-session', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** The ProjectContext the cookie routes hand the service — the "web panel" side. */
function projectCtx(fx: WorkItemFixture): ProjectContext {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "comment", "plan_change_turn", "plan_change_session", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAll();
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_plan_1' } as Awaited<
    ReturnType<typeof submitJob>
  >);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('plan-session tools — registration + permission + advertised contracts', () => {
  it('all three are registered and all three ask for ai:plan', () => {
    expect(MCP_TOOL_NAMES).toContain(OPEN_PLAN_SESSION_TOOL_NAME);
    expect(MCP_TOOL_NAMES).toContain(APPEND_PLAN_TURN_TOOL_NAME);
    expect(MCP_TOOL_NAMES).toContain(SUBMIT_PLAN_SESSION_TOOL_NAME);
    // ⚠️ THE SPLIT MOVED, deliberately (MOTIR-2576; ADR §3, §5). Under the six
    // scopes these were `read` / `work_items:write` / `work_items:write` — and
    // the `read` on OPEN was WRONG relative to its own gate:
    // `planChangeSessionsService.getOrCreateForScope` asserts `ai:plan`, so a
    // read-only token only ever got as far as a role check. The map now names
    // what the services actually assert, which withdraws opening from a
    // browse-only grant and — the point of the story — lets a token that files
    // work items withhold all three.
    expect(toolPermission(OPEN_PLAN_SESSION_TOOL_NAME)).toBe('ai:plan');
    expect(toolPermission(APPEND_PLAN_TURN_TOOL_NAME)).toBe('ai:plan');
    expect(toolPermission(SUBMIT_PLAN_SESSION_TOOL_NAME)).toBe('ai:plan');
  });

  it('the descriptions carry BOTH load-bearing contracts in as many words', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const append = tools.find((t) => t.name === APPEND_PLAN_TURN_TOOL_NAME);
    const submit = tools.find((t) => t.name === SUBMIT_PLAN_SESSION_TOOL_NAME);

    // (a) Appending does NOT submit — an agent that assumes otherwise polls a
    // job that was never created.
    expect(append?.description).toMatch(/does NOT submit/i);
    expect(append?.description).toMatch(new RegExp(SUBMIT_PLAN_SESSION_TOOL_NAME));
    // (b) A submit PROPOSES — approval in Motir is the only path to a work item.
    expect(submit?.description).toMatch(/does NOT create work items/i);
    expect(submit?.description).toMatch(/approv/i);
    await client.close();
  });
});

describe('open_plan_session — one thread per scope, resumed not forked', () => {
  it('opens the project thread, and a second open RESUMES it with its turns', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);

    const first = await call(client, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });
    expect(first.isError).toBeFalsy();
    const opened = session(first);
    expect(opened.turnCount).toBe(0);
    expect(opened.targetKeys).toEqual([]);
    expect(opened.lastSubmittedAt).toBeNull();
    expect(text(first)).toContain('Opened planning conversation');

    await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      body: 'Add a billing epic.',
    });

    // Re-opening is the resume: the SAME row, carrying the turn already on it —
    // which is what lets a terminal client render the thread it is rejoining.
    const again = session(await call(client, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' }));
    expect(again.id).toBe(opened.id);
    expect(again.turnCount).toBe(1);
    expect(again.turns.map((t) => t.body)).toEqual(['Add a billing epic.']);
    const planChangeSessionCount = await adminDb.planChangeSession.count();
    expect(planChangeSessionCount).toBe(1);
    await client.close();
  });

  it('a distinct anchor set is a distinct thread; the SAME set — any order or case — resumes it', async () => {
    const fx = await makeWorkItemFixture();
    const a = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story A' },
      fx.ctx,
    );
    const b = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story B' },
      fx.ctx,
    );
    const c = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story C' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);

    // ⚠️ The sets here are DISJOINT — {A} and {B,C}, not {A} and {A,B} — because
    // MOTIR-2787 made an overlapping open a REFUSAL rather than a second thread.
    // The subject of this case is scope-key IDENTITY, which is unchanged; the
    // overlap is its own case below.
    const wide = session(await call(client, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' }));
    const onA = session(
      await call(client, OPEN_PLAN_SESSION_TOOL_NAME, {
        projectKey: 'PROD',
        targetKeys: [a.identifier],
      }),
    );
    const onBC = session(
      await call(client, OPEN_PLAN_SESSION_TOOL_NAME, {
        projectKey: 'PROD',
        targetKeys: [b.identifier, c.identifier],
      }),
    );

    // Three anchor sets → three conversations. The project-wide thread is not
    // the {A} thread, and {A} is not {B,C}.
    expect(new Set([wide.id, onA.id, onBC.id]).size).toBe(3);
    expect(onA.targetKeys).toEqual([a.identifier]);
    expect(onBC.targetKeys).toEqual([b.identifier, c.identifier].sort());

    // The anchor SET is the identity: reversed, lower-cased and duplicated, it
    // is the same conversation — a CLI must not fork a second thread about the
    // same items just because it listed them differently. And re-opening it is a
    // RESUME even though its targets are locked, because the lock is held by this
    // very thread: an idempotent re-open refreshes the lease rather than refusing.
    const resumed = session(
      await call(client, OPEN_PLAN_SESSION_TOOL_NAME, {
        projectKey: 'prod',
        targetKeys: [c.identifier.toLowerCase(), b.identifier, c.identifier],
      }),
    );
    expect(resumed.id).toBe(onBC.id);
    const planChangeSessionCount = await adminDb.planChangeSession.count();
    expect(planChangeSessionCount).toBe(3);
    await client.close();
  });

  it('an OVERLAPPING anchor set from the SAME caller takes them back to their session (AMENDMENT 23 §3)', async () => {
    // REVERSED by AMENDMENT 23 §3 (MOTIR-7639). This used to assert the same
    // caller was REFUSED, on the reasoning that one agent holding two
    // conversations about one item builds the same strange tree as two agents.
    // The amendment keeps that outcome impossible a different way: an open on a
    // card the caller's own open session holds RETURNS that session, so there is
    // still only one conversation about the item, and nothing is refused or
    // taken over. Another person is still refused (`PLAN_TARGET_LOCKED`, with who
    // and when it frees) — `planningTargetLockGate.test.ts` drives that race.
    const fx = await makeWorkItemFixture();
    const a = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story A' },
      fx.ctx,
    );
    const b = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story B' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);

    const onA = session(
      await call(client, OPEN_PLAN_SESSION_TOOL_NAME, {
        projectKey: 'PROD',
        targetKeys: [a.identifier],
      }),
    );

    const overlapping = await call(client, OPEN_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'PROD',
      targetKeys: [a.identifier, b.identifier],
    });

    expect(overlapping.isError).toBeFalsy();
    expect(session(overlapping).id).toBe(onA.id);
    // No second thread, and B is untouched and still plannable on its own.
    expect(await adminDb.planChangeSession.count()).toBe(1);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('todo');
    const onB = session(
      await call(client, OPEN_PLAN_SESSION_TOOL_NAME, {
        projectKey: 'PROD',
        targetKeys: [b.identifier],
      }),
    );
    expect(onB.targetKeys).toEqual([b.identifier]);
    await client.close();
  });

  it('an anchor the caller cannot see 404s — it never becomes a scope key', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const theirs = await workItemsService.createWorkItem(
      { projectId: a.projectId, kind: 'story', title: 'Acme story' },
      a.ctx,
    );
    const outsider = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
    const client = await connectClient(outsider.ctx);

    // Another tenant's item, aimed at the outsider's OWN project: resolution
    // runs through the 6.4 authority, so it is a not-found, not a silent anchor.
    const res = await call(client, OPEN_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'ZZZ',
      targetKeys: [theirs.identifier],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('NOT_FOUND');
    const planChangeSessionCount = await adminDb.planChangeSession.count();
    expect(planChangeSessionCount).toBe(0);

    // And the project itself: a project outside the caller's workspace is a
    // not-found, never a 403 leak.
    const foreign = await call(client, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });
    expect(foreign.isError).toBe(true);
    expect(text(foreign)).toContain('NOT_FOUND');
    await client.close();
  });
});

describe('append_plan_turn — accumulation, and the SAME thread the web panel sees', () => {
  it('appends without submitting: turns pile up, no job is fired', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);

    const first = await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      body: 'Add auth to the billing epic.',
    });
    expect(first.isError).toBeFalsy();
    // A first turn opens the thread on its own — a terminal client has no mount
    // step, so it must not need a separate open call to say something.
    expect(session(first).turnCount).toBe(1);
    expect(text(first)).toContain('NOT submitted');

    const second = session(
      await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
        projectKey: 'PROD',
        body: 'Keep every subtask under 3 points.',
      }),
    );
    expect(second.turns.map((t) => t.seq)).toEqual([0, 1]);
    expect(second.turns.every((t) => t.role === 'user')).toBe(true);
    // Nothing left for the planner, and the thread reports itself unsubmitted.
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
    expect(second.lastJobId).toBeNull();
    expect(second.lastSubmittedAt).toBeNull();
    const planCount = await adminDb.plan.count();
    expect(planCount).toBe(0);
    await client.close();
  });

  it('an empty body is refused with the service’s typed error', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const res = await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      body: '   ',
    });
    expect(res.isError).toBe(true);
    await client.close();
  });

  it('MCP turns and web-panel turns land on ONE row — asserted in both directions', async () => {
    const fx = await makeWorkItemFixture();
    const pctx = projectCtx(fx);
    const client = await connectClient(fx.ctx);

    // Web panel first (exactly what the cookie routes call), then MCP.
    const fromPanel = await openTestSession(pctx);
    await planChangeSessionsService.appendTurn('Typed in the browser.', pctx, addressOf(fromPanel));
    const fromCli = session(
      await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
        projectKey: 'PROD',
        body: 'Typed in the terminal.',
      }),
    );

    // Same row, and the CLI sees the browser's turn.
    expect(fromCli.id).toBe(fromPanel.id);
    expect(fromCli.turns.map((t) => t.body)).toEqual([
      'Typed in the browser.',
      'Typed in the terminal.',
    ]);

    // …and the browser sees the CLI's — one `(project_id, scope_key)` row, not
    // two surfaces with two conversations.
    const backInPanel = await openTestSession(pctx);
    expect(backInPanel.id).toBe(fromPanel.id);
    expect(backInPanel.turns.map((t) => t.body)).toEqual([
      'Typed in the browser.',
      'Typed in the terminal.',
    ]);
    const planChangeSessionCount = await adminDb.planChangeSession.count();
    expect(planChangeSessionCount).toBe(1);
    await client.close();
  });
});

describe('submit_plan_session — one job for the whole thread', () => {
  it('sends N turns as ONE accumulated intent, and returns { jobId, planId } without waiting', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      body: 'Add auth to the billing epic.',
    });
    await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      body: 'Keep every subtask under 3 points.',
    });

    const res = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });
    expect(res.isError).toBeFalsy();
    const out = struct(res) as unknown as {
      jobId: string;
      planId: string;
      session: PlanChangeSessionDto;
    };
    expect(out.jobId).toBe('job_plan_1');
    expect(out.planId).toBeTruthy();

    // ONE job, of the SHIPPED augment kind, carrying the ACCUMULATED intent —
    // the numbered framing that tells the engine later turns REFINE earlier ones.
    expect(vi.mocked(submitJob)).toHaveBeenCalledTimes(1);
    const [kind, , context] = vi.mocked(submitJob).mock.calls[0]!;
    expect(kind).toBe('plan');
    const prompt = (context as { prompt: string }).prompt;
    expect(prompt).toBe(
      buildAccumulatedIntent([
        { role: 'user', body: 'Add auth to the billing epic.' },
        { role: 'user', body: 'Keep every subtask under 3 points.' },
      ]),
    );
    expect(prompt).toContain('1. Add auth to the billing epic.');
    expect(prompt).toContain('2. Keep every subtask under 3 points.');
    expect(prompt).toMatch(/REFINE/);

    // Submit-and-return, asserted negatively: nothing streamed, nothing polled.
    expect(vi.mocked(streamJob)).not.toHaveBeenCalled();
    expect(vi.mocked(getJob)).not.toHaveBeenCalled();

    // The submission is recorded ON the thread: a `system` marker turn carrying
    // the job id, plus the stamps a resumed client re-attaches from.
    const marker = out.session.turns.at(-1)!;
    expect(marker.role).toBe('system');
    expect(marker.jobId).toBe('job_plan_1');
    expect(marker.body).toBe(prompt);
    expect(out.session.lastJobId).toBe('job_plan_1');
    expect(out.session.lastSubmittedAt).toBeTruthy();

    // The proposal sink is open and bound to the job (MOTIR-1743) — and it is a
    // PLAN: the tree is untouched.
    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: out.planId } });
    expect(plan.status).toBe('generating');
    expect(plan.sourceJobId).toBe('job_plan_1');
    const workItemCount = await adminDb.workItem.count({ where: { projectId: fx.projectId } });
    expect(workItemCount).toBe(0);
    await client.close();
  });

  it('a SINGLE turn passes through verbatim — no framing is added to a one-shot change', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      body: 'Split the onboarding story.',
    });

    await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });
    const [, , context] = vi.mocked(submitJob).mock.calls[0]!;
    expect((context as { prompt: string }).prompt).toBe('Split the onboarding story.');
    await client.close();
  });

  it('an ANCHORED thread submits contextually — the thread’s own scope decides', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Anchor me' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);
    await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      targetKeys: [story.identifier],
      body: 'Re-plan this story into smaller subtasks.',
    });
    await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'PROD',
      targetKeys: [story.identifier],
    });

    // Still ONE job kind and one submit surface — the anchor set rides along as
    // context, and motir-ai classifies expand / augment / replan against it.
    expect(vi.mocked(submitJob)).toHaveBeenCalledTimes(1);
    const [, , context] = vi.mocked(submitJob).mock.calls[0]!;
    expect((context as { targetKeys?: string[] }).targetKeys).toEqual([story.identifier]);
    await client.close();
  });

  it('an EMPTY thread refuses with the typed error, and fires nothing', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    await call(client, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });

    const res = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('PLAN_CHANGE_EMPTY_INTENT');
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
    const planCount = await adminDb.plan.count();
    expect(planCount).toBe(0);
    await client.close();
  });

  it('a thread that was never opened refuses with the typed not-found', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const res = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('PLAN_CHANGE_SESSION_NOT_FOUND');
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
    await client.close();
  });

  it('a FAILED submit leaves the thread intact and opens NO orphan plan', async () => {
    const fx = await makeWorkItemFixture();
    vi.mocked(submitJob).mockRejectedValue(new MotirAiOutOfCreditsError('balance 0'));
    const client = await connectClient(fx.ctx);
    await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      body: 'Add the reporting epic.',
    });

    const res = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });
    expect(res.isError).toBe(true);
    // The distinct, non-retryable code — an agent must not read this as a
    // generic outage and retry forever.
    expect(text(res)).toContain('MOTIR_AI_OUT_OF_CREDITS');
    // The plan is opened only AFTER a successful submit, so a refused job leaves
    // nothing behind…
    const planCount = await adminDb.plan.count();
    expect(planCount).toBe(0);
    // …and the user's words survive: the thread is re-submittable as it stands.
    const after = session(await call(client, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' }));
    expect(after.turns.map((t) => t.body)).toEqual(['Add the reporting epic.']);
    expect(after.lastJobId).toBeNull();
    expect(after.lastSubmittedAt).toBeNull();
    await client.close();
  });
});

// The composed WHAT reaching the wire (Story MOTIR-3942 · MOTIR-4172) — the
// carrier between the engine that ACCEPTS a settled first phase (MOTIR-4082)
// and the agent that COMPOSES one (MOTIR-4083). Nothing carried it between
// them, and the two halves had assumed different shapes (MOTIR-4168), so each
// would have passed its own tests while the feature did not exist.
//
// The last point in THIS repository where the value is observable is the
// envelope `submitJob` is called with, so that is where these assert — not at
// the tool, whose return says nothing about what went out.
describe('submit_plan_session — the requirement reaches context.requirement', () => {
  /** The context bag the one `submitJob` call went out with. */
  function sentContext(): Record<string, unknown> {
    expect(vi.mocked(submitJob)).toHaveBeenCalledTimes(1);
    return vi.mocked(submitJob).mock.calls[0]![2] as unknown as Record<string, unknown>;
  }

  async function threadWithOneTurn(): Promise<Client> {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      body: 'This card is wrong.',
    });
    return client;
  }

  it('a complete requirement lands on the envelope and SATISFIES the far side', async () => {
    const client = await threadWithOneTurn();
    const requirement = completeRequirement();
    const res = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'PROD',
      requirement,
    });
    expect(res.isError).toBeFalsy();

    // Landed, at the envelope — and DEEP-equal, so a re-ordered or re-built
    // object would not pass.
    expect(sentContext().requirement).toEqual(requirement);

    // …and it is what motir-ai's own validator accepts. This is the half a
    // round-trip assertion cannot give: `toEqual` above is true of ANY object,
    // and MOTIR-4168 was two halves that each passed exactly that test.
    expect(satisfiesBuildRequirement(sentContext().requirement)).toBe(true);
    await client.close();
  });

  it('the six field names and their order are the CONTRACT, not this repo’s choice', async () => {
    const client = await threadWithOneTurn();
    await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'PROD',
      requirement: completeRequirement(),
    });

    // The keys that reached the envelope ARE motir-ai's field list, in ITS
    // order. Drop one, rename one, or reorder either side and this fails HERE.
    expect(Object.keys(sentContext().requirement as object)).toEqual([...AI_REQUIREMENT_FIELDS]);

    // The advertised schema teaches the same set, and marks the three that must
    // be non-empty at the far end. The tool description is the surface an agent
    // composing one actually reads, so it is asserted rather than assumed.
    const tools = (await client.listTools()).tools;
    const submit = tools.find((t) => t.name === SUBMIT_PLAN_SESSION_TOOL_NAME)!;
    const advertised = (submit.inputSchema.properties as Record<string, unknown>).requirement as {
      properties: Record<string, unknown>;
    };
    const props = Object.keys(advertised.properties);
    expect(props).toEqual([...AI_REQUIREMENT_FIELDS]);
    // The tool description names all six, so an agent reading only the summary
    // still learns the shape it is being asked to compose.
    for (const field of AI_REQUIREMENT_FIELDS) {
      expect(submit.description).toContain(field);
    }

    // …and each field's OWN description says which of the two kinds it is.
    // Asserted per FIELD rather than by matching a phrase against the whole
    // description, which would pass on any prose that happened to contain both
    // words somewhere.
    const describes = (field: string) =>
      (advertised.properties[field] as { description?: string }).description ?? '';
    for (const field of AI_REQUIREMENT_FIELDS) {
      const required = (AI_REQUIREMENT_REQUIRED_NON_EMPTY as readonly string[]).includes(field);
      expect(describes(field).includes('non-empty')).toBe(required);
      // The other three say the empty string is an ANSWER — the distinction the
      // far side's per-field validation exists to preserve.
      if (!required) expect(describes(field)).toContain('""');
    }
    await client.close();
  });

  it('the schema is PERMISSIVE — a requirement missing a REQUIRED field still submits', async () => {
    const client = await threadWithOneTurn();
    // `outcome` is one of the three the far side demands. This surface does not
    // care: refusing a card must never become conditional on composing well.
    const partial = { ...completeRequirement(), outcome: '' };
    const res = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'PROD',
      requirement: partial,
    });
    expect(res.isError).toBeFalsy();
    expect(sentContext().requirement).toEqual(partial);
    // It reached the envelope AS SENT — and the far side is the one that will
    // decline to treat it as settled, which is the whole division of labour.
    expect(satisfiesBuildRequirement(sentContext().requirement)).toBe(false);
    await client.close();
  });

  it('the schema is PERMISSIVE — a requirement carrying ONLY `outcome` still submits', async () => {
    const client = await threadWithOneTurn();
    const res = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'PROD',
      requirement: { outcome: 'Only this much is known.' },
    });
    expect(res.isError).toBeFalsy();
    // No completeness check ⇒ no invented keys either. What arrives is what was
    // sent, missing keys included.
    expect(sentContext().requirement).toEqual({ outcome: 'Only this much is known.' });
    await client.close();
  });

  it('THE VALUE IS UNCHANGED END TO END — long prose, newlines, backticks, quotes', async () => {
    const client = await threadWithOneTurn();
    // A trim or a cap anywhere on this chain silently clips the planner's only
    // grounding, which is the quiet version of not sending it at all. So the
    // fields here carry every character class that tempts a normalizer.
    const behaviour = [
      '  Leading and trailing whitespace is CONTENT, not noise.  ',
      '',
      'A second paragraph, with `backticks`, "double quotes", \'single\' and $dollar.',
      'A tab\there, a backslash \\ there, and a unicode em dash — plus 中文.',
      '',
      `${'A long clause that keeps going. '.repeat(120)}`,
    ].join('\n');
    const requirement = { ...completeRequirement(), behaviour, scopeEdge: '   ' };

    await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD', requirement });
    const landed = sentContext().requirement as Record<string, string>;
    // Byte for byte, including the whitespace-only `scopeEdge` — trimming that
    // to `''` would be a different ANSWER, not a tidier one.
    expect(landed).toEqual(requirement);
    expect(landed.behaviour).toBe(behaviour);
    expect(landed.behaviour!.length).toBe(behaviour.length);
    expect(landed.scopeEdge).toBe('   ');
    await client.close();
  });

  it('an ANCHORED submit carries it too — the arm a dispatched re-plan actually takes', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Anchor me' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);
    await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      targetKeys: [story.identifier],
      body: 'This card is wrong.',
    });
    const requirement = completeRequirement();
    await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'PROD',
      targetKeys: [story.identifier],
      requirement,
    });
    // Both halves ride together: the anchor set AND the WHAT.
    expect(sentContext().targetKeys).toEqual([story.identifier]);
    expect(sentContext().requirement).toEqual(requirement);
    await client.close();
  });

  it('a submit with NO requirement is unchanged — asserted by ABSENCE, not by null', async () => {
    const client = await threadWithOneTurn();
    await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });
    const context = sentContext();
    // This card's risk is an optional field quietly becoming mandatory. Absence
    // already means "nobody supplied one" for every other hole in this bag, and
    // the consumer's reading of it — open the conversation — is exactly right;
    // `null` or `{}` would be a third state neither side has a reading for.
    expect('requirement' in context).toBe(false);
    expect(context.requirement).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain('requirement');
    await client.close();
  });

  it('the door is the TOOL, so `--requirement` in a turn body is just prose', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    // `motir plan` never grew this option (tests/mcp/submit-requirement-door.test.ts
    // asserts that by absence). The consequence a user can actually see is here:
    // a turn that TALKS about the flag is a turn, and it reaches the thread
    // verbatim rather than being eaten as an argument.
    const body = 'Pass --requirement ./what.json — or rather, do not: it is a tool argument now.';
    await call(client, APPEND_PLAN_TURN_TOOL_NAME, { projectKey: 'PROD', body });

    const reopened = session(
      await call(client, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' }),
    );
    expect(reopened.turns.map((t) => t.body)).toEqual([body]);

    await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });
    expect(sentContext().prompt).toBe(body);
    await client.close();
  });

  it('a REJECTED argument creates NO job and spends NO credits — the one safe retry', async () => {
    const client = await threadWithOneTurn();
    // A mis-typed field: the six are strings, and zod refuses this BEFORE the
    // handler runs. That is what makes this the single legitimate exception to
    // "submit exactly once" — the agent's one shot survives it.
    const res = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'PROD',
      requirement: { outcome: 42 },
    });
    expect(res.isError).toBe(true);
    // Asserted on the JOB COUNT, not on the error message: what matters is that
    // nothing was spent, not how the refusal was worded.
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
    expect(await adminDb.plan.count()).toBe(0);

    // …and the retry the description promises actually works.
    const retry = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });
    expect(retry.isError).toBeFalsy();
    expect(vi.mocked(submitJob)).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it('the prose TURN still rides append_plan_turn — composed once, delivered TWICE', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    // Neither delivery is a summary of the other: the turn lands on the shared
    // thread where a person reads it, the struct lands on the envelope where
    // the planner reads it. An append THEN a submit, both on one thread.
    await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      body: 'The card names a CLI door that is not the agent’s surface.',
    });
    const requirement = completeRequirement();
    const res = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'PROD',
      requirement,
    });

    const out = struct(res) as unknown as { session: PlanChangeSessionDto };
    const bodies = out.session.turns.map((t) => t.body);
    expect(bodies).toContain('The card names a CLI door that is not the agent’s surface.');
    expect(sentContext().prompt).toBe('The card names a CLI door that is not the agent’s surface.');
    expect(sentContext().requirement).toEqual(requirement);

    // The thread records the INTENT that went out, not the struct — persisting
    // the requirement onto the session is a different seam (MOTIR-4159), and a
    // second copy here would be free to diverge.
    const reopened = session(
      await call(client, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' }),
    );
    expect(JSON.stringify(reopened)).not.toContain(requirement.outcome);
    await client.close();
  });
});

// MOTIR-10233 — THE RUN MARKER. A run that stopped on a card says so with `fromRun`, and
// names the comment it left with `runCommentId`; motir-ai keys its question-free session
// on `context.runReplan`. The cases a lazy implementation would pass under a broken one:
// the marker must be ABSENT (not `false`, not `{}`) on a person's submit, the comment id
// must be RESOLVED against the anchors rather than passed through, a reply must resolve
// to its thread's root, and a malformed pair must spend nothing.
describe('submit_plan_session — a RUN marks its re-plan (MOTIR-10233)', () => {
  function sentContext(): Record<string, unknown> {
    expect(vi.mocked(submitJob)).toHaveBeenCalledTimes(1);
    return vi.mocked(submitJob).mock.calls[0]![2] as unknown as Record<string, unknown>;
  }

  async function anchoredThread() {
    const fx = await makeWorkItemFixture();
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Stopped on' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);
    await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      targetKeys: [card.identifier],
      body: 'The card names a service that does not exist.',
    });
    return { fx, card, client };
  }

  it('`fromRun: true` puts `runReplan` on the envelope, with a null comment when none is named', async () => {
    const { card, client } = await anchoredThread();
    const res = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'PROD',
      targetKeys: [card.identifier],
      fromRun: true,
    });
    expect(res.isError).toBeFalsy();
    expect(sentContext().runReplan).toEqual({ commentId: null });
    await client.close();
  });

  it('a person’s submit carries NO marker — asserted by absence', async () => {
    const { card, client } = await anchoredThread();
    await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'PROD',
      targetKeys: [card.identifier],
    });
    expect('runReplan' in sentContext()).toBe(false);
    await client.close();
  });

  it('`runCommentId` resolves to its root, and a reply resolves to its root', async () => {
    const { fx, card, client } = await anchoredThread();
    const root = await adminDb.comment.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: card.id,
        authorId: fx.ownerId,
        bodyMd: 'Stopped: the service does not exist.',
      },
    });
    const reply = await adminDb.comment.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: card.id,
        authorId: fx.ownerId,
        parentCommentId: root.id,
        bodyMd: 'More evidence.',
      },
    });
    const res = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'PROD',
      targetKeys: [card.identifier],
      fromRun: true,
      runCommentId: reply.id,
    });
    expect(res.isError).toBeFalsy();
    expect(sentContext().runReplan).toEqual({ commentId: root.id });
    await client.close();
  });

  it('THE WIDER LANE: a comment on a card outside `targetKeys` is kept, and the re-plan goes', async () => {
    const { fx, card, client } = await anchoredThread();
    const other = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'The card the run stopped on' },
      fx.ctx,
    );
    const elsewhere = await adminDb.comment.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: other.id,
        authorId: fx.ownerId,
        bodyMd: 'Stopped here.',
      },
    });
    const res = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'PROD',
      targetKeys: [card.identifier],
      fromRun: true,
      runCommentId: elsewhere.id,
    });
    expect(res.isError).toBeFalsy();
    expect(sentContext().runReplan).toEqual({ commentId: elsewhere.id });
    expect(text(res)).not.toContain('did not resolve');
    await client.close();
  });

  it('A BAD POINTER costs the reply, never the re-plan, and the run is told', async () => {
    const { card, client } = await anchoredThread();
    const res = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'PROD',
      targetKeys: [card.identifier],
      fromRun: true,
      runCommentId: 'cm_no_such_comment',
    });
    expect(res.isError).toBeFalsy();
    expect(sentContext().runReplan).toEqual({ commentId: null });
    expect(text(res)).toContain('`runCommentId` did not resolve');
    await client.close();
  });

  it('NO TARGET with a comment: the comment is the anchor, and the re-plan goes', async () => {
    const { fx, card, client } = await anchoredThread();
    const comment = await adminDb.comment.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: card.id,
        authorId: fx.ownerId,
        bodyMd: 'A precondition no card names.',
      },
    });
    await call(client, 'append_plan_turn', {
      projectKey: 'PROD',
      body: 'A precondition no card names is missing.',
    });
    const res = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'PROD',
      fromRun: true,
      runCommentId: comment.id,
    });
    expect(res.isError).toBeFalsy();
    expect(sentContext().runReplan).toEqual({ commentId: comment.id });
    await client.close();
  });

  it('NO TARGET and no comment that resolves: refused, nothing submitted, and the run told how', async () => {
    const { client } = await anchoredThread();
    for (const args of [{}, { runCommentId: 'cm_no_such_comment' }]) {
      const res = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, {
        projectKey: 'PROD',
        fromRun: true,
        ...args,
      });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('RUN_REPLAN_NO_ANCHOR');
      expect(text(res)).toContain('`targetKeys`');
    }
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
    await client.close();
  });

  it('`runCommentId` without `fromRun` is refused BEFORE anything is read or spent', async () => {
    const { card, client } = await anchoredThread();
    const res = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'PROD',
      targetKeys: [card.identifier],
      runCommentId: 'cm_whatever',
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('RUN_COMMENT_WITHOUT_RUN');
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
    expect(await adminDb.plan.count()).toBe(0);
    await client.close();
  });
});

describe('plan-session tools — grant narrowing', () => {
  it('a grant WITHOUT ai:plan can reach none of the three, even to open', async () => {
    const fx = await makeWorkItemFixture();
    // Seed a turn through a fully-granted client so the denied opens have
    // something they WOULD have resumed — and so "no write happened" has a
    // baseline.
    const full = await connectClient(fx.ctx, GRANTABLE_PERMISSIONS);
    await call(full, APPEND_PLAN_TURN_TOOL_NAME, { projectKey: 'PROD', body: 'Seeded turn.' });
    await full.close();

    // Everything a token can hold EXCEPT planning — the shape someone wires for
    // an agent that files work items and must not spend their AI credits.
    const noPlanning = await connectClient(
      fx.ctx,
      GRANTABLE_PERMISSIONS.filter((k) => k !== 'ai:plan'),
    );

    // ⚠️ Each tool is called with ITS OWN valid arguments, not one shared bag.
    // `body` belongs to `append_plan_turn` alone, and since bug MOTIR-3342 an
    // unknown argument is REFUSED at input validation — which the SDK runs
    // BEFORE the tool callback the permission gate wraps. Sending `body` to
    // `open_plan_session` therefore fails on the schema and never reaches the
    // gate this test is about, which is a strictly less interesting failure
    // than the one it is asserting.
    const argsFor: Record<string, Record<string, unknown>> = {
      [OPEN_PLAN_SESSION_TOOL_NAME]: { projectKey: 'PROD' },
      [APPEND_PLAN_TURN_TOOL_NAME]: { projectKey: 'PROD', body: 'sneaky' },
      [SUBMIT_PLAN_SESSION_TOOL_NAME]: { projectKey: 'PROD' },
    };
    for (const name of [
      OPEN_PLAN_SESSION_TOOL_NAME,
      APPEND_PLAN_TURN_TOOL_NAME,
      SUBMIT_PLAN_SESSION_TOOL_NAME,
    ]) {
      const denied = await call(noPlanning, name, argsFor[name]!);
      expect(denied.isError, `${name} must be permission-denied`).toBe(true);
      expect(text(denied)).toContain(PERMISSION_NOT_GRANTED_CODE);
      expect(text(denied)).toContain('ai:plan');
    }

    // The gate fired BEFORE the service: no second turn, no job, no plan.
    const after = await openTestSession(projectCtx(fx));
    expect(after.turnCount).toBe(1);
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
    const planCount = await adminDb.plan.count();
    expect(planCount).toBe(0);
    await noPlanning.close();
  });

  it('a grant WITH ai:plan can open, extend and fire', async () => {
    const fx = await makeWorkItemFixture();
    const planner = await connectClient(fx.ctx, ['project:browse', 'ai:plan']);
    const opened = await call(planner, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });
    expect(opened.isError).toBeFalsy();
    expect(session(opened).turnCount).toBe(0);

    const appended = await call(planner, APPEND_PLAN_TURN_TOOL_NAME, {
      projectKey: 'PROD',
      body: 'A real turn.',
    });
    expect(appended.isError).toBeFalsy();
    await planner.close();
  });
});

describe('the conversation addressed BY ID (MOTIR-6028)', () => {
  const THREE_HOURS = 3 * 60 * 60 * 1000;

  /** Two OPEN conversations of one (project-wide) scope: the OLDER one gone
   *  quiet, and a NEWER one written directly — an open session is resumed at any
   *  age (AMENDMENT 23 §3), so the doors never start this sibling themselves. */
  async function twoConversations(client: Client) {
    const older = session(
      await call(client, APPEND_PLAN_TURN_TOOL_NAME, { projectKey: 'PROD', body: 'older' }),
    );
    const row = await adminDb.planChangeSession.update({
      where: { id: older.id },
      data: { lastActivityAt: new Date(Date.now() - THREE_HOURS) },
    });
    const newer = await adminDb.planChangeSession.create({
      data: {
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        createdById: row.createdById,
        scopeKey: row.scopeKey,
        targetKeys: row.targetKeys,
      },
    });
    expect(newer.id).not.toBe(older.id);
    return { older, newer };
  }

  it('open returns the session id, in structuredContent and in the text', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);

    const opened = await call(client, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' });

    expect(opened.isError).toBeFalsy();
    expect(session(opened).id).toBeTruthy();
    expect(text(opened)).toContain(session(opened).id);
    await client.close();
  });

  it('append and submit given an id land on THAT session, even with a newer one in the scope', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { older, newer } = await twoConversations(client);

    const appended = session(
      await call(client, APPEND_PLAN_TURN_TOOL_NAME, {
        projectKey: 'PROD',
        sessionId: older.id,
        body: 'and more',
      }),
    );
    expect(appended.id).toBe(older.id);
    expect(appended.turns.map((t) => t.body)).toEqual(['older', 'and more']);

    const submitted = await call(client, SUBMIT_PLAN_SESSION_TOOL_NAME, {
      projectKey: 'PROD',
      sessionId: older.id,
    });
    expect(submitted.isError).toBeFalsy();
    const rows = await adminDb.planChangeSession.findMany({
      where: { id: { in: [older.id, newer.id] } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(older.id)!.lastJobId).toBe('job_plan_1');
    expect(byId.get(newer.id)!.lastJobId).toBeNull();
    expect(byId.get(newer.id)!.turnCount).toBe(0);
    await client.close();
  });

  it('WITHOUT an id: the first turn starts a conversation and the next call resumes it', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);

    const first = session(
      await call(client, APPEND_PLAN_TURN_TOOL_NAME, { projectKey: 'PROD', body: 'start' }),
    );
    const reopened = session(
      await call(client, OPEN_PLAN_SESSION_TOOL_NAME, { projectKey: 'PROD' }),
    );
    expect(reopened.id).toBe(first.id);
    expect(await adminDb.planChangeSession.count()).toBe(1);
    await client.close();
  });

  it('refuses a session id from another project with the typed not-found, on every tool', async () => {
    const theirs = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    const foreign = await openTestSession(projectCtx(theirs));
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);

    for (const [name, extra] of [
      [OPEN_PLAN_SESSION_TOOL_NAME, {}],
      [APPEND_PLAN_TURN_TOOL_NAME, { body: 'stray' }],
      [SUBMIT_PLAN_SESSION_TOOL_NAME, {}],
    ] as const) {
      const res = await call(client, name, { projectKey: 'PROD', sessionId: foreign.id, ...extra });
      expect(res.isError, `${name} must refuse`).toBe(true);
      expect(text(res)).toContain('PLAN_SESSION_NOT_FOUND');
    }
    expect(submitJob).not.toHaveBeenCalled();
    await client.close();
  });
});

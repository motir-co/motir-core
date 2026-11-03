import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@/generated/prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { buildMcpServer } from '@/lib/mcp/registry';
import { runCreateWorkItem } from '@/lib/mcp/tools/createWorkItem';
import { runTransitionStatus } from '@/lib/mcp/tools/transitionStatus';
import { runAddComment } from '@/lib/mcp/tools/addComment';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { captureJobEvents } from '../helpers/jobs';

// MCP write tools (Subtask 7.8.5) over real Postgres. `create_work_item`,
// `transition_status`, `add_comment` — each a thin adapter over an
// already-shipped service. We assert: attribution to the token's user, the
// kind-parent matrix, the legal-vs-illegal transition (incl. the allowed-
// targets enrichment + the revision row shape), the comment mention + job
// event, and the 404-not-403 cross-tenant contract on every tool.
//
// The server is built with a fixed-context resolver (the bearer auth gate is
// tested in auth.test.ts), so these exercise the tool surface directly. Inngest
// is spied so the post-commit events never reach the network AND so the comment
// event is assertable (the commentsService.test.ts pattern).

interface CapturedEvent {
  name: string;
  data: Record<string, unknown>;
}

function captureEvents(): CapturedEvent[] {
  return captureJobEvents().events as CapturedEvent[];
}

let events: CapturedEvent[];

beforeEach(async () => {
  await truncateAuthTables();
  events = captureEvents();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Connect an in-memory MCP client to a server bound to `ctx`. */
async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** Add a fresh workspace member to `fx`, returning the user. */
async function addMember(fx: WorkItemFixture, email: string, name: string): Promise<User> {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return user;
}

const mentionToken = (u: User) => `[@${u.name}](mention:${u.id})`;

describe('create_work_item', () => {
  it('creates a task via the client round-trip with the token owner as reporter', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);

    const res = await client.callTool({
      name: 'create_work_item',
      arguments: { projectKey: 'PROD', kind: 'task', title: 'Wire the MCP', priority: 'high' },
    });
    expect(res.isError).toBeFalsy();
    const dto = res.structuredContent as {
      identifier: string;
      kind: string;
      reporterId: string;
      priority: string;
      status: string;
    };
    expect(dto.kind).toBe('task');
    expect(dto.reporterId).toBe(fx.ownerId);
    expect(dto.priority).toBe('high');
    // Lands in the workflow's initial status, like any UI create.
    expect(dto.status).toBe('todo');

    // It is readable back through the tree (it actually persisted).
    const list = await workItemsService.listWorkItems(fx.projectId, {}, fx.ctx);
    expect(list.map((i) => i.identifier)).toContain(dto.identifier);
    await client.close();
  });

  it('logs a bug under a story with the reporter set (the bug-logging protocol)', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'A story' },
      fx.ctx,
    );

    const res = await runCreateWorkItem(
      {
        projectKey: 'PROD',
        kind: 'bug',
        title: 'It crashes on save',
        parentKey: story.identifier,
        descriptionMd: 'Steps: …',
      },
      fx.ctx,
    );
    expect(res.isError).toBeFalsy();
    const dto = res.structuredContent as { kind: string; parentId: string; reporterId: string };
    expect(dto.kind).toBe('bug');
    expect(dto.parentId).toBe(story.id);
    expect(dto.reporterId).toBe(fx.ownerId);
  });

  it('rejects an illegal kind/parent pair with the typed error', async () => {
    const fx = await makeWorkItemFixture();
    const task = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'A task' },
      fx.ctx,
    );
    // A story may not be parented to a task (matrix: task → [bug, subtask]).
    const res = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'story', title: 'Nope', parentKey: task.identifier },
      fx.ctx,
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('ILLEGAL_PARENT_TYPE');
  });

  // Epic creation over the MCP (MOTIR-1345) — the planner generates the whole
  // tree, epics included, so the agent surface must be able to create a
  // top-level epic. The service is already total over `epic`; the tool only
  // widened its input enum.
  it('creates a top-level epic with no parent', async () => {
    const fx = await makeWorkItemFixture();
    const res = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'epic', title: 'A brand-new capability area' },
      fx.ctx,
    );
    expect(res.isError).toBeFalsy();
    const dto = res.structuredContent as {
      identifier: string;
      kind: string;
      parentId: string | null;
      reporterId: string;
    };
    expect(dto.kind).toBe('epic');
    expect(dto.parentId).toBeNull();
    expect(dto.reporterId).toBe(fx.ownerId);

    // It persisted and reads back through the tree as a root item.
    const list = await workItemsService.listWorkItems(fx.projectId, {}, fx.ctx);
    expect(list.map((i) => i.identifier)).toContain(dto.identifier);
  });

  it('rejects a parented epic with the typed kind-parent error (epic is root-only)', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'A story' },
      fx.ctx,
    );
    // No kind may parent an epic (matrix: epic → root only).
    const res = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'epic', title: 'Nested epic', parentKey: story.identifier },
      fx.ctx,
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('ILLEGAL_PARENT_TYPE');
  });

  // Story points on create (Subtask 7.8.21) — born with a points value, and the
  // shared validation rejects a malformed one before a key is burned.
  it('creates an item with storyPoints set', async () => {
    const fx = await makeWorkItemFixture();
    const res = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'task', title: 'Sized', storyPoints: 8 },
      fx.ctx,
    );
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { storyPoints: number | null }).storyPoints).toBe(8);
  });

  it('rejects an out-of-range storyPoints on create with a typed validation error', async () => {
    const fx = await makeWorkItemFixture();
    const res = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'task', title: 'Too big', storyPoints: 10000 },
      fx.ctx,
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('INVALID_ESTIMATE');
  });

  // Leaf-authoring fields on create (MOTIR-1081) — a subtask is born
  // fully-specified (estimate + type + executor) in one call, no follow-up
  // update_work_item patch.
  it('creates a subtask fully-specified with estimate, type, and executor in one call', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Parent story' },
      fx.ctx,
    );
    const res = await runCreateWorkItem(
      {
        projectKey: 'PROD',
        kind: 'subtask',
        title: 'Fully specified',
        parentKey: story.identifier,
        estimateMinutes: 90,
        type: 'code',
        executor: 'coding_agent',
        storyPoints: 3,
      },
      fx.ctx,
    );
    expect(res.isError).toBeFalsy();
    const dto = res.structuredContent as {
      estimateMinutes: number | null;
      type: string | null;
      executor: string | null;
      storyPoints: number | null;
    };
    expect(dto.estimateMinutes).toBe(90);
    expect(dto.type).toBe('code');
    expect(dto.executor).toBe('coding_agent');
    expect(dto.storyPoints).toBe(3);
  });

  it('seeds the executor from the type default when type is set without an executor', async () => {
    const fx = await makeWorkItemFixture();
    const res = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'task', title: 'Typed only', type: 'code' },
      fx.ctx,
    );
    expect(res.isError).toBeFalsy();
    const dto = res.structuredContent as { type: string | null; executor: string | null };
    expect(dto.type).toBe('code');
    // `code` defaults to a coding-agent executor (defaultExecutorForType).
    expect(dto.executor).toBe('coding_agent');
  });

  // Planning provenance (MOTIR-1685) — an MCP-created item is stamped
  // `source = mcp` server-side, carrying the agent's self-reported harness+model.
  it('stamps planning provenance mcp + self-reported harness/model', async () => {
    const fx = await makeWorkItemFixture();
    const res = await runCreateWorkItem(
      {
        projectKey: 'PROD',
        kind: 'task',
        title: 'Agent-planned',
        plannedWithHarness: 'Claude Code',
        plannedWithModel: 'claude-opus-4-8',
      },
      fx.ctx,
    );
    expect(res.isError).toBeFalsy();
    const dto = res.structuredContent as {
      planningSource: string | null;
      planningHarness: string | null;
      planningModel: string | null;
      implementationSource: string | null;
    };
    expect(dto.planningSource).toBe('mcp');
    expect(dto.planningHarness).toBe('Claude Code');
    expect(dto.planningModel).toBe('claude-opus-4-8');
    // No implementation provenance from a create.
    expect(dto.implementationSource).toBeNull();
  });

  it('stamps planning provenance mcp with null harness/model when not supplied', async () => {
    const fx = await makeWorkItemFixture();
    const res = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'task', title: 'Agent, no harness reported' },
      fx.ctx,
    );
    expect(res.isError).toBeFalsy();
    const dto = res.structuredContent as {
      planningSource: string | null;
      planningHarness: string | null;
      planningModel: string | null;
    };
    expect(dto.planningSource).toBe('mcp');
    expect(dto.planningHarness).toBeNull();
    expect(dto.planningModel).toBeNull();
  });

  it('rejects a type on a non-leaf kind (story) with the typed leaf-only error', async () => {
    const fx = await makeWorkItemFixture();
    const res = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'story', title: 'No type on a story', type: 'code' },
      fx.ctx,
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('TYPE_NOT_ALLOWED_ON_KIND');
  });
});

describe('transition_status', () => {
  it('makes a legal move by key AND by display name, writing the revision row', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Movable' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);

    // By status KEY.
    const res = await client.callTool({
      name: 'transition_status',
      arguments: { key: item.identifier, status: 'in_progress' },
    });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { status: string }).status).toBe('in_progress');

    // The revision row is shaped exactly like the board drag's (status from→to).
    const revisions = await workItemsService.listRevisions(item.id, fx.ctx);
    const statusRev = revisions.find((r) => r.diff.status)!;
    expect(statusRev.changeKind).toBe('updated');
    expect(statusRev.diff.status).toEqual({ from: 'todo', to: 'in_progress' });
    expect(statusRev.changedById).toBe(fx.ownerId);

    // By display NAME ("In Progress" is current; move to "Blocked").
    const byName = await client.callTool({
      name: 'transition_status',
      arguments: { key: item.identifier, status: 'Blocked' },
    });
    expect(byName.isError).toBeFalsy();
    expect((byName.structuredContent as { status: string }).status).toBe('blocked');

    // The transitioned event fired (post-commit, best-effort).
    expect(events.some((e) => e.name === 'work-item/transitioned')).toBe(true);
    await client.close();
  });

  it('surfaces the allowed targets on an illegal transition', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Stuck' },
      fx.ctx,
    );
    // todo → done is not a legal transition in the default (restricted) workflow.
    const res = await runTransitionStatus({ key: item.identifier, status: 'done' }, fx.ctx);
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toContain('ILLEGAL_TRANSITION');
    // The legal targets from "To Do" are listed so the agent self-corrects.
    expect(text).toContain('in_progress');
    expect(text).toContain('blocked');
  });

  it('an unknown status surfaces UnknownStatusError', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'X' },
      fx.ctx,
    );
    const res = await runTransitionStatus({ key: item.identifier, status: 'nonsense' }, fx.ctx);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('UNKNOWN_STATUS');
  });
});

describe('add_comment', () => {
  it('posts a comment as the token owner and fires the mention + job event', async () => {
    const fx = await makeWorkItemFixture();
    const mentionee = await addMember(fx, 'mentionee@ex.com', 'Mention Target');
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Discuss me' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);

    const res = await client.callTool({
      name: 'add_comment',
      arguments: { key: item.identifier, body: `Looks good ${mentionToken(mentionee)}` },
    });
    expect(res.isError).toBeFalsy();
    const dto = res.structuredContent as {
      id: string;
      author: { id: string };
      mentionedUserIds: string[];
    };
    expect(dto.author.id).toBe(fx.ownerId);
    expect(dto.mentionedUserIds).toContain(mentionee.id);
    // A run needs the id for its submit, and may only read the text (MOTIR-10233).
    expect(JSON.stringify(res.content)).toContain(`comment id: ${dto.id}`);

    // The post-commit comment.created event fired with the parsed mention.
    const created = events.find((e) => e.name === 'work-item/comment.created');
    expect(created).toBeTruthy();
    expect(created!.data.authorId).toBe(fx.ownerId);
    expect(created!.data.mentionedUserIds).toContain(mentionee.id);
    await client.close();
  });

  it('rejects an empty comment body with the typed error', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Y' },
      fx.ctx,
    );
    const res = await runAddComment({ key: item.identifier, body: '   ' }, fx.ctx);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('EMPTY_COMMENT_BODY');
  });

  // MOTIR-10233 — `parentCommentId` makes the comment a REPLY. The planner answers a
  // run's re-plan it cannot plan as a reply to the run's own comment, so the door has
  // to land the row UNDER that comment, and refuse what the item page's reply box
  // refuses: a parent on another item, and a reply to a reply.
  it('replies to a top-level comment on the same item when `parentCommentId` is given', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Threaded' },
      fx.ctx,
    );
    const root = await runAddComment({ key: item.identifier, body: 'the run said this' }, fx.ctx);
    expect(root.isError).toBeFalsy();
    const rootId = (root.structuredContent as { id: string }).id;

    const reply = await runAddComment(
      { key: item.identifier, body: 'and the planner answers', parentCommentId: rootId },
      fx.ctx,
    );
    expect(reply.isError).toBeFalsy();
    const replyId = (reply.structuredContent as { id: string }).id;
    const row = await adminDb.comment.findUniqueOrThrow({ where: { id: replyId } });
    expect(row.parentCommentId).toBe(rootId);
    expect(row.workItemId).toBe(item.id);

    // A reply to the reply is one level too deep.
    const deeper = await runAddComment(
      { key: item.identifier, body: 'too deep', parentCommentId: replyId },
      fx.ctx,
    );
    expect(deeper.isError).toBe(true);
    expect(JSON.stringify(deeper.content)).toContain('REPLY_DEPTH_EXCEEDED');

    // A parent on another item is refused, never re-homed.
    const other = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Elsewhere' },
      fx.ctx,
    );
    const foreign = await runAddComment(
      { key: other.identifier, body: 'wrong thread', parentCommentId: rootId },
      fx.ctx,
    );
    expect(foreign.isError).toBe(true);
    expect(await adminDb.comment.count({ where: { workItemId: other.id } })).toBe(0);
  });
});

describe('cross-tenant — every write tool is 404-not-403', () => {
  it('a non-member context cannot create / transition / comment on another tenant', async () => {
    const a = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: a.projectId, kind: 'task', title: 'Tenant A secret' },
      a.ctx,
    );
    // A second, independent tenant whose context will probe tenant A's project.
    const b = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHER' });

    const create = await runCreateWorkItem(
      { projectKey: 'PROD', kind: 'task', title: 'sneaky' },
      b.ctx,
    );
    expect(create.isError).toBe(true);
    expect(JSON.stringify(create.content)).toContain('PROJECT_NOT_FOUND');

    const move = await runTransitionStatus({ key: item.identifier, status: 'in_progress' }, b.ctx);
    expect(move.isError).toBe(true);
    expect(JSON.stringify(move.content)).toContain('PROJECT_NOT_FOUND');

    const comment = await runAddComment({ key: item.identifier, body: 'hi' }, b.ctx);
    expect(comment.isError).toBe(true);
    expect(JSON.stringify(comment.content)).toContain('PROJECT_NOT_FOUND');
  });
});

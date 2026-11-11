import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notification } from '@/generated/prisma/client';
import type { EmailSendData, PageCommentCreatedData } from '@/lib/jobs/types';
import type { NotificationData } from '@/lib/dto/notifications';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { db } from '@/lib/db';
import { jobDefinitions } from '@/lib/jobs/registry';
import { verifyMcpToken } from '@/lib/mcp/auth';
import { contextFromAuthInfo } from '@/lib/mcp/context';
import { pageCommentsService } from '@/lib/services/pageCommentsService';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withTokenFor } from '../fixtures/apiV1Fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { JobTestEngine, captureJobEvents } from '../helpers/jobs';

// AN AGENT-AUTHORED PAGE COMMENT NOTIFIES EXACTLY LIKE A MEMBER'S (Story MOTIR-10868
// · MOTIR-10932), on real Postgres.
//
// NO PAGE-COMMENT MCP TOOL EXISTS YET. The MCP directory carries the work-item
// comment tools and the page's own tools, and nothing that writes a page comment.
// So this suite does not drive a door that is not there: it drives the one
// service every page-comment write goes through, `pageCommentsService`, with the
// context that door WILL hand it — a personal access token minted on the shipped
// token service (`withTokenFor`), verified against Postgres by `verifyMcpToken`
// and lifted by `contextFromAuthInfo`, the same two calls the MCP request path
// makes. No context object is written by hand for the agent.
//
// "Who is writing changes nothing" is a COMPARISON claim, so the first block
// writes the same comment through the session-shaped context every route builds
// and through the token context, and compares event, rows and sends field by
// field, naming each id it excludes. The binding case measures the axis on which
// the two contexts genuinely differ, so that sameness is not sameness of inputs.
//
// The consumers are the registry's, filtered on the trigger, and run in process;
// the enqueue is swallowed by the capture helper and nothing leaves the process.

const PAGE_EVENT = 'page/comment.created';

let captured: ReturnType<typeof captureJobEvents>;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  captured = captureJobEvents();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── fixture ────────────────────────────────────────────────────────────────

interface Person {
  userId: string;
  workspaceId: string;
  email: string;
  name: string;
}

interface Tenant {
  workspaceId: string;
  projectId: string;
  projectKey: string;
  pageId: string;
  /** The workspace owner — the person the agent's token belongs to. */
  a: Person;
  b: Person;
  c: Person;
  /** A workspace member holding no role in the project. */
  outsider: Person;
}

let seq = 0;
async function user(tag: string) {
  seq += 1;
  return usersService.createUser({
    email: `agent-page-${tag}-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Agent ${tag.toUpperCase()}${seq}`,
  });
}

async function makeTenant(): Promise<Tenant> {
  const owner = await user('a');
  const ws = await workspacesService.createWorkspace({ name: 'Agent', ownerUserId: owner.id });
  const workspaceId = ws.workspace.id;
  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Agent',
    identifier: 'APC',
  });
  const a = { userId: owner.id, workspaceId, email: owner.email, name: owner.name };
  const page = await pagesService.createPage(a, { projectId: project.id, title: 'Draft' });
  await adminDb.page.update({ where: { id: page.id }, data: { title: 'Runbook' } });
  // A real member: in the workspace's organization (which gates every workspace
  // door, the token service's included) and in the workspace itself.
  const member = async (tag: string, accessScope: 'full' | 'limited' = 'full') => {
    const u = await user(tag);
    await adminDb.organizationMembership.create({
      data: { organizationId: ws.workspace.organizationId, userId: u.id },
    });
    await adminDb.workspaceMembership.create({
      data: { userId: u.id, workspaceId, workspaceRole: 'member', accessScope },
    });
    return { userId: u.id, workspaceId, email: u.email, name: u.name };
  };
  return {
    workspaceId,
    projectId: project.id,
    projectKey: project.identifier,
    pageId: page.id,
    a,
    b: await member('b'),
    c: await member('c'),
    outsider: await member('out', 'limited'),
  };
}

/** The context every route builds from a cookie session: the user and the workspace. */
const sessionOf = (p: Person): ServiceContext => ({ userId: p.userId, workspaceId: p.workspaceId });

/**
 * The context the MCP request path hands a tool for `p`'s own token: minted with
 * an explicit grant carrying `comment:add`, verified, then lifted. `projectId`
 * binds the token to one project; without it the token is workspace-scoped (the
 * only kind a person who cannot enter any project can mint).
 */
async function agentOf(p: Person, projectId?: string): Promise<ServiceContext> {
  const [u, w] = await Promise.all([
    adminDb.user.findUniqueOrThrow({ where: { id: p.userId } }),
    adminDb.workspace.findUniqueOrThrow({ where: { id: p.workspaceId } }),
  ]);
  const { token } = await withTokenFor(u, w, {
    permissions: ['page:view', 'comment:add'],
    ...(projectId ? { projectId } : {}),
    label: 'agent token',
  });
  const authInfo = await verifyMcpToken(
    new Request('http://localhost/api/mcp', { method: 'POST' }),
    token,
  );
  if (!authInfo) throw new Error('the fixture PAT did not verify');
  return contextFromAuthInfo(authInfo);
}

const token = (p: Person) => `[@${p.name}](mention:${p.userId})`;
const on = (t: Tenant, pageId = t.pageId) => ({ projectId: t.projectId, pageId });

// ── the joined path ────────────────────────────────────────────────────────

const consumersOf = (event: string) => jobDefinitions.filter((d) => d.trigger === event);

const pageEvents = () =>
  captured.events.filter((e) => e.name === PAGE_EVENT).map((e) => e.data as PageCommentCreatedData);
const lastPageEvent = () => pageEvents().at(-1)!;

function sends(from = 0): EmailSendData[] {
  return captured.events
    .slice(from)
    .filter((e) => e.name === 'email.send')
    .map((e) => e.data as EmailSendData);
}

/** Run every registered consumer of the page event; the sends they queued. */
async function dispatchPage(event: PageCommentCreatedData) {
  const from = captured.events.length;
  for (const fn of consumersOf(PAGE_EVENT)) {
    await new JobTestEngine({
      function: fn as never,
      events: [{ name: PAGE_EVENT, data: event } as never],
    }).execute();
  }
  return sends(from);
}

const rowsFor = (where: { recipientUserId?: string; pageId?: string }): Promise<Notification[]> =>
  adminDb.notification.findMany({ where, orderBy: { createdAt: 'asc' } });

const dataOf = (row: Notification) => row.data as unknown as NotificationData;

/** Rows per recipient for one comment, by its thread root and the event's comment. */
async function countsFor(commentId: string, pageId: string) {
  const rows = (await rowsFor({ pageId })).filter((r) => r.dedupeKey.includes(commentId));
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.recipientUserId, (counts.get(r.recipientUserId) ?? 0) + 1);
  return counts;
}

/**
 * Field-by-field equality of two records, recursing into nested objects, with
 * the excluded paths NAMED: a divergence fails on the path that differed.
 */
function expectSameExcept(
  label: string,
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  excluded: readonly string[],
  prefix = '',
) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const k of keys) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (excluded.includes(path)) continue;
    const l = left[k];
    const r = right[k];
    const nested = (v: unknown) =>
      v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
    if (nested(l) && nested(r)) {
      expectSameExcept(
        label,
        l as Record<string, unknown>,
        r as Record<string, unknown>,
        excluded,
        path,
      );
    } else {
      expect(r, `${label}: ${path} differs between the session and the token run`).toEqual(l);
    }
  }
}

/** Write through `ctx` and answer the refusal, failing if it was not refused. */
async function refused(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the write to be refused');
}

// ── the registry seam ──────────────────────────────────────────────────────

describe('the registry seam', () => {
  it('exactly two definitions consume the page comment event, and every case runs through them', () => {
    const ids = consumersOf(PAGE_EVENT).map((d) => d.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

// ── the differential ───────────────────────────────────────────────────────

describe('the same comment through the session context and the token context', () => {
  // Excluded by construction, and named so nothing else can hide behind them:
  // the comment's own id and the thread root that carries it (on a root comment
  // they are the same id), the row's id / dedupe key / creation time, and the
  // send's idempotency key and thread address (both carry the comment id).
  const EVENT_EXCLUDED = ['commentId', 'threadRootCommentId'] as const;
  const ROW_EXCLUDED = ['id', 'dedupeKey', 'createdAt', 'data.threadRootId'] as const;
  const SEND_EXCLUDED = ['idempotencyKey', 'data.threadUrl'] as const;

  async function bothRuns() {
    const t = await makeTenant();
    const agent = await agentOf(t.a, t.projectId);
    const body = `Please review the rollback step, ${token(t.b)}.`;

    const sRoot = await pageCommentsService.postPageComment(sessionOf(t.a), {
      ...on(t),
      bodyMd: body,
    });
    const sEvent = lastPageEvent();
    const sSends = await dispatchPage(sEvent);
    const sRows = (await rowsFor({ recipientUserId: t.b.userId })).filter((r) =>
      r.dedupeKey.includes(sRoot.id),
    );

    const tRoot = await pageCommentsService.postPageComment(agent, { ...on(t), bodyMd: body });
    const tEvent = lastPageEvent();
    const tSends = await dispatchPage(tEvent);
    const tRows = (await rowsFor({ recipientUserId: t.b.userId })).filter((r) =>
      r.dedupeKey.includes(tRoot.id),
    );

    return { t, sRoot, sEvent, sSends, sRows, tRoot, tEvent, tSends, tRows };
  }

  it('publishes two events that differ only in the comment id and its thread root', async () => {
    const { t, sRoot, sEvent, tRoot, tEvent } = await bothRuns();
    expect(pageEvents()).toHaveLength(2);
    expect(sEvent.commentId).toBe(sRoot.id);
    expect(tEvent.commentId).toBe(tRoot.id);
    expect(tEvent.commentId).not.toBe(sEvent.commentId);
    expect(tEvent.threadRootCommentId).toBe(tRoot.id);

    expectSameExcept('event', { ...sEvent }, { ...tEvent }, EVENT_EXCLUDED);
    // And the shared fields are the real values, not two matching blanks.
    expect(tEvent).toMatchObject({
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      pageId: t.pageId,
      authorId: t.a.userId,
      mentionedUserIds: [t.b.userId],
      isReply: false,
    });
  });

  it('the token run writes exactly one row for the teammate, matching the session run’s, and none for the author', async () => {
    const { t, sRows, tRows, tRoot } = await bothRuns();

    expect(sRows).toHaveLength(1);
    expect(tRows).toHaveLength(1);
    const [row] = tRows;
    expect(row).toMatchObject({
      type: 'mentioned',
      category: 'direct',
      actorId: t.a.userId,
      pageId: t.pageId,
      workItemId: null,
    });
    const data = dataOf(row!);
    expect(data).toMatchObject({
      kind: 'page_mentioned',
      pageId: t.pageId,
      pageTitle: 'Runbook',
      projectKey: t.projectKey,
      threadRootId: tRoot.id,
    });
    expect((data as { excerpt: string | null }).excerpt).toBeTruthy();

    expectSameExcept('row', { ...sRows[0]! }, { ...row! }, ROW_EXCLUDED);
    expect(await rowsFor({ recipientUserId: t.a.userId })).toEqual([]);
  });

  it('the token run queues exactly one mention send for the teammate, as the session run did, and nothing for the author', async () => {
    const { t, sSends, tSends, tRoot } = await bothRuns();

    expect(sSends).toHaveLength(1);
    expect(tSends).toHaveLength(1);
    const [send] = tSends;
    expect(send!.to).toBe(t.b.email);
    expect(send!.data).toMatchObject({ variant: 'mention', pageTitle: 'Runbook' });
    expect((send!.data as { excerpt: string | null }).excerpt).toBeTruthy();
    const url = new URL((send!.data as { threadUrl: string }).threadUrl);
    expect(url.pathname).toBe(`/pages/${t.pageId}`);
    expect(url.searchParams.get('thread')).toBe(tRoot.id);

    expectSameExcept(
      'send',
      { ...sSends[0]! } as Record<string, unknown>,
      { ...send! } as Record<string, unknown>,
      SEND_EXCLUDED,
    );
    expect([...sSends, ...tSends].some((s) => s.to === t.a.email)).toBe(false);
  });
});

// ── what a differential cannot reach on its own ────────────────────────────

describe('an agent writing on a page', () => {
  it('an agent’s reply reaches the thread’s starter and earlier replier, never the replying agent', async () => {
    const t = await makeTenant();
    const root = await pageCommentsService.postPageComment(sessionOf(t.b), {
      ...on(t),
      bodyMd: 'Is the rollback step still right?',
    });
    await pageCommentsService.postPageReply(sessionOf(t.c), {
      ...on(t),
      parentCommentId: root.id,
      bodyMd: 'I think so.',
    });
    const agent = await agentOf(t.a, t.projectId);
    const agentReply = await pageCommentsService.postPageReply(agent, {
      ...on(t),
      parentCommentId: root.id,
      bodyMd: 'Confirmed against the latest deploy.',
    });
    const event = lastPageEvent();
    expect(event).toMatchObject({ commentId: agentReply.id, isReply: true, authorId: t.a.userId });

    const queued = await dispatchPage(event);

    const counts = await countsFor(agentReply.id, t.pageId);
    expect(Object.fromEntries(counts)).toEqual({ [t.b.userId]: 1, [t.c.userId]: 1 });
    for (const who of [t.b, t.c]) {
      const [row] = (await rowsFor({ recipientUserId: who.userId })).filter((r) =>
        r.dedupeKey.includes(agentReply.id),
      );
      expect(row!.type).toBe('commented');
      const data = dataOf(row!);
      expect(data).toMatchObject({ kind: 'page_replied', threadRootId: root.id });
      expect((data as { excerpt: string }).excerpt).toContain(
        'Confirmed against the latest deploy',
      );
    }
    expect(queued.map((s) => s.to).sort()).toEqual([t.b.email, t.c.email].sort());
    expect(queued.every((s) => (s.data as { variant: string }).variant === 'reply')).toBe(true);
  });

  it('an agent mentioning its own owner notifies only the teammate, and the event still carries both ids', async () => {
    const t = await makeTenant();
    const agent = await agentOf(t.a, t.projectId);
    const root = await pageCommentsService.postPageComment(agent, {
      ...on(t),
      bodyMd: `${token(t.a)} and ${token(t.b)}: the runbook is updated.`,
    });
    const event = lastPageEvent();
    expect([...event.mentionedUserIds].sort()).toEqual([t.a.userId, t.b.userId].sort());

    const queued = await dispatchPage(event);

    const counts = await countsFor(root.id, t.pageId);
    expect(counts.get(t.a.userId) ?? 0).toBe(0);
    expect(counts.get(t.b.userId) ?? 0).toBe(1);
    expect(queued.map((s) => s.to)).toEqual([t.b.email]);
  });

  it('an agent naming a member outside the project keeps the token in the body and notifies only the project member', async () => {
    const t = await makeTenant();
    const agent = await agentOf(t.a, t.projectId);
    const root = await pageCommentsService.postPageComment(agent, {
      ...on(t),
      bodyMd: `${token(t.outsider)} and ${token(t.b)}, please look.`,
    });
    const stored = await adminDb.pageComment.findUniqueOrThrow({ where: { id: root.id } });
    expect(stored.bodyMd).toContain(`mention:${t.outsider.userId}`);

    const queued = await dispatchPage(lastPageEvent());

    expect(await rowsFor({ recipientUserId: t.outsider.userId })).toEqual([]);
    expect(queued.some((s) => s.to === t.outsider.email)).toBe(false);
    expect((await countsFor(root.id, t.pageId)).get(t.b.userId)).toBe(1);
    expect(queued.map((s) => s.to)).toEqual([t.b.email]);
  });

  it('a person with no role in the project is refused alike through both contexts, and nobody is notified', async () => {
    const t = await makeTenant();
    const agent = await agentOf(t.outsider);
    const write = (ctx: ServiceContext) =>
      pageCommentsService.postPageComment(ctx, { ...on(t), bodyMd: `cc ${token(t.b)}` });

    const sessionErr = await refused(write(sessionOf(t.outsider)));
    const tokenErr = await refused(write(agent));

    expect((tokenErr as Error).constructor).toBe((sessionErr as Error).constructor);
    expect({ ...(tokenErr as object) }).toEqual({ ...(sessionErr as object) });
    expect((tokenErr as Error).message).toBe((sessionErr as Error).message);
    expect(pageEvents()).toEqual([]);
    expect(await adminDb.notification.count()).toBe(0);
    expect(sends()).toEqual([]);
  });

  it('an agent’s edit adding a mention notifies only the added person once; a word-only edit publishes nothing', async () => {
    const t = await makeTenant();
    const agent = await agentOf(t.a, t.projectId);
    const root = await pageCommentsService.postPageComment(agent, {
      ...on(t),
      bodyMd: `Hello ${token(t.b)}`,
    });
    await dispatchPage(lastPageEvent());
    const eventsBefore = pageEvents().length;
    const sendsBefore = sends().length;

    await pageCommentsService.editPageCommentBody(agent, {
      ...on(t),
      commentId: root.id,
      bodyMd: `Hello ${token(t.b)} and ${token(t.c)}`,
    });
    expect(pageEvents()).toHaveLength(eventsBefore + 1);
    const refire = lastPageEvent();
    expect(refire).toMatchObject({ commentId: root.id, mentionedUserIds: [t.c.userId] });
    const added = await dispatchPage(refire);

    expect(Object.fromEntries(await countsFor(root.id, t.pageId))).toEqual({
      [t.b.userId]: 1,
      [t.c.userId]: 1,
    });
    expect(added.map((s) => s.to)).toEqual([t.c.email]);
    expect(added[0]!.idempotencyKey).toContain(root.id);
    expect(sends()).toHaveLength(sendsBefore + 1);

    const countsAfterAdd = Object.fromEntries(await countsFor(root.id, t.pageId));
    const eventsAfterAdd = pageEvents().length;
    const sendsAfterAdd = sends().length;
    await pageCommentsService.editPageCommentBody(agent, {
      ...on(t),
      commentId: root.id,
      bodyMd: `Hi ${token(t.b)} and ${token(t.c)}`,
    });
    expect(pageEvents()).toHaveLength(eventsAfterAdd);
    expect(sends()).toHaveLength(sendsAfterAdd);
    expect(Object.fromEntries(await countsFor(root.id, t.pageId))).toEqual(countsAfterAdd);
  });

  it('a token bound to another project is refused on this page, while the same person’s session writes there', async () => {
    const t = await makeTenant();
    const other = await projectsService.createProject({
      workspaceId: t.workspaceId,
      actorUserId: t.a.userId,
      name: 'Other',
      identifier: 'APO',
    });
    const boundElsewhere = await agentOf(t.a, other.id);
    expect(boundElsewhere.tokenProjectId).toBe(other.id);
    const body = `cc ${token(t.b)}`;

    const err = await refused(
      pageCommentsService.postPageComment(boundElsewhere, { ...on(t), bodyMd: body }),
    );
    expect(err).toBeInstanceOf(Error);
    expect(pageEvents()).toEqual([]);
    expect(await adminDb.pageComment.count({ where: { pageId: t.pageId } })).toBe(0);
    expect(sends()).toEqual([]);

    const root = await pageCommentsService.postPageComment(sessionOf(t.a), {
      ...on(t),
      bodyMd: body,
    });
    expect(pageEvents()).toHaveLength(1);
    expect(lastPageEvent().commentId).toBe(root.id);
    expect(await adminDb.pageComment.count({ where: { pageId: t.pageId } })).toBe(1);
    const queued = await dispatchPage(lastPageEvent());
    expect(queued.map((s) => s.to)).toEqual([t.b.email]);
  });
});

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { plannabilityService } from '@/lib/services/plannabilityService';
import type { WorkItemDto } from '@/lib/dto/workItems';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// MOTIR-10544 — `GET /api/work-items/plannability?key=`, the pre-check the
// roadmap canvas card's Plan button makes before it opens the planning overlay
// (design MOTIR-10543).
//
// Against REAL Postgres and the real services, in the shape
// `tests/api/planning-anchor-route.test.ts` uses for its twin: the only stubs are
// the two context resolvers a Vitest process cannot supply through cookies. The
// edges, the child counts, the workflow categories and the access gate are the
// shipped ones.

const PASSWORD = 'hunter2hunter2';

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getSession: async () => session.current };
});
vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return { ...actual, getActiveProject: async () => activeCtx.current };
});

const { GET: plannabilityRoute } = await import('@/app/api/work-items/plannability/route');

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  activeCtx.current = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function makeScenario(slug: string) {
  const email = `plannable-${slug}-${++seq}@example.com`;
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Ada Lovelace' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug} ${seq}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: `Project ${slug}`,
  });
  return {
    user,
    email,
    workspace,
    project,
    ctx: { userId: user.id, workspaceId: workspace.id },
  };
}

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

function signIn(s: Scenario) {
  session.current = { user: { id: s.user.id, email: s.email, name: 'Ada Lovelace' } };
  activeCtx.current = {
    userId: s.user.id,
    workspaceId: s.workspace.id,
    projectId: s.project.id,
    project: s.project,
  };
}

function checkViaRoute(key?: string): Promise<Response> {
  const qs = key === undefined ? '' : `?key=${encodeURIComponent(key)}`;
  return plannabilityRoute(new Request(`http://localhost:3000/api/work-items/plannability${qs}`));
}

async function item(
  s: Scenario,
  kind: 'epic' | 'story' | 'task' | 'bug' | 'subtask',
  title: string,
  parentId?: string,
): Promise<WorkItemDto> {
  return workItemsService.createWorkItem(
    { projectId: s.project.id, kind, title, ...(parentId ? { parentId } : {}) },
    s.ctx,
  );
}

async function blockedBy(s: Scenario, card: WorkItemDto, blocker: WorkItemDto) {
  await workItemsService.linkWorkItems(
    { fromId: card.id, toId: blocker.id, kind: 'is_blocked_by' },
    s.ctx,
  );
}

async function setStatus(target: WorkItemDto, status: string) {
  await adminDb.workItem.update({ where: { id: target.id }, data: { status } });
}

async function answerFor(key: string) {
  const res = await checkViaRoute(key);
  expect(res.status).toBe(200);
  return res.json();
}

describe('GET /api/work-items/plannability · the rule', () => {
  it('a story with no open blockers is plannable', async () => {
    const s = await makeScenario('free');
    signIn(s);
    const card = await item(s, 'story', 'Export a sprint report');

    expect(await answerFor(card.identifier)).toEqual({ plannable: true, reasons: [] });
  });

  it('a story blocked by an open story with no children is NOT plannable, and names it', async () => {
    const s = await makeScenario('held');
    signIn(s);
    const card = await item(s, 'story', 'Export a sprint report');
    const blocker = await item(s, 'story', 'Store each sprint report as a snapshot');
    await blockedBy(s, card, blocker);

    expect(await answerFor(card.identifier)).toEqual({
      plannable: false,
      reasons: [
        {
          kind: 'blocker_has_no_subtasks',
          blockers: [{ identifier: blocker.identifier, title: blocker.title, toPlan: true }],
        },
      ],
    });
  });

  it('two such blockers are both listed, in key order', async () => {
    const s = await makeScenario('two');
    signIn(s);
    const first = await item(s, 'story', 'First blocker');
    const second = await item(s, 'story', 'Second blocker');
    const card = await item(s, 'story', 'Export a sprint report');
    // Linked in the reverse order: the answer is ordered by key, not by edge.
    await blockedBy(s, card, second);
    await blockedBy(s, card, first);

    const answer = await answerFor(card.identifier);
    expect(answer.plannable).toBe(false);
    expect(answer.reasons).toHaveLength(1);
    expect(answer.reasons[0].blockers.map((b: { identifier: string }) => b.identifier)).toEqual([
      first.identifier,
      second.identifier,
    ]);
  });

  it('an In Progress childless blocker still holds, but is not To plan (no per-line Plan)', async () => {
    const s = await makeScenario('in-progress');
    signIn(s);
    const card = await item(s, 'story', 'Export a sprint report');
    const blocker = await item(s, 'story', 'Someone holds this one');
    await setStatus(blocker, 'in_progress');
    await blockedBy(s, card, blocker);

    const answer = await answerFor(card.identifier);
    expect(answer.plannable).toBe(false);
    expect(answer.reasons[0].blockers).toEqual([
      { identifier: blocker.identifier, title: blocker.title, toPlan: false },
    ]);
  });

  it('a blocker in a done-CATEGORY status never holds — done and cancelled alike', async () => {
    const s = await makeScenario('done');
    signIn(s);
    const card = await item(s, 'story', 'Export a sprint report');
    const done = await item(s, 'story', 'Finished');
    const cancelled = await item(s, 'story', 'Dropped');
    await setStatus(done, 'done');
    // `cancelled` is the default workflow's SECOND done-category status: a rule
    // keyed on the `done` key would wrongly hold on it.
    await setStatus(cancelled, 'cancelled');
    await blockedBy(s, card, done);
    await blockedBy(s, card, cancelled);

    expect(await answerFor(card.identifier)).toEqual({ plannable: true, reasons: [] });
  });

  it('a status the workflow cannot classify is NOT finished, so the blocker still holds', async () => {
    const s = await makeScenario('unclassified');
    signIn(s);
    const card = await item(s, 'story', 'Export a sprint report');
    const blocker = await item(s, 'story', 'In a status nobody defined');
    await setStatus(blocker, 'not_a_workflow_status');
    await blockedBy(s, card, blocker);

    const answer = await answerFor(card.identifier);
    expect(answer.plannable).toBe(false);
    expect(answer.reasons[0].blockers[0].toPlan).toBe(false);
  });

  it('an ARCHIVED blocker never holds', async () => {
    const s = await makeScenario('archived');
    signIn(s);
    const card = await item(s, 'story', 'Export a sprint report');
    const blocker = await item(s, 'story', 'Set aside');
    await blockedBy(s, card, blocker);
    await workItemsService.archiveWorkItem(blocker.id, s.ctx);

    expect(await answerFor(card.identifier)).toEqual({ plannable: true, reasons: [] });
  });

  it('a blocker story that HAS children leaves the card plannable', async () => {
    const s = await makeScenario('planned');
    signIn(s);
    const card = await item(s, 'story', 'Export a sprint report');
    const blocker = await item(s, 'story', 'Already broken down');
    await item(s, 'subtask', 'Its first subtask', blocker.id);
    await blockedBy(s, card, blocker);

    expect(await answerFor(card.identifier)).toEqual({ plannable: true, reasons: [] });
  });

  it('a blocker whose only children are ARCHIVED has no live children, so it holds', async () => {
    const s = await makeScenario('archived-child');
    signIn(s);
    const card = await item(s, 'story', 'Export a sprint report');
    const blocker = await item(s, 'story', 'Its subtasks were set aside');
    const child = await item(s, 'subtask', 'Set aside', blocker.id);
    await workItemsService.archiveWorkItem(child.id, s.ctx);
    await blockedBy(s, card, blocker);

    expect((await answerFor(card.identifier)).plannable).toBe(false);
  });

  it('a childless TASK or BUG blocker does not hold — the rule covers story blockers only', async () => {
    const s = await makeScenario('leaf-blockers');
    signIn(s);
    const card = await item(s, 'story', 'Export a sprint report');
    const task = await item(s, 'task', 'A childless task');
    const bug = await item(s, 'bug', 'A childless bug');
    await blockedBy(s, card, task);
    await blockedBy(s, card, bug);

    expect(await answerFor(card.identifier)).toEqual({ plannable: true, reasons: [] });
  });

  it('reads the edges at CLICK time: planning the blocker frees the card', async () => {
    const s = await makeScenario('live');
    signIn(s);
    const card = await item(s, 'story', 'Export a sprint report');
    const blocker = await item(s, 'story', 'Planned in the meantime');
    await blockedBy(s, card, blocker);
    expect((await answerFor(card.identifier)).plannable).toBe(false);

    await item(s, 'subtask', 'Laid by a planning run', blocker.id);
    expect((await answerFor(card.identifier)).plannable).toBe(true);
  });

  it('never serves a cached answer', async () => {
    const s = await makeScenario('cache');
    signIn(s);
    const card = await item(s, 'story', 'Export a sprint report');

    const res = await checkViaRoute(card.identifier);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

describe('GET /api/work-items/plannability · the refusals', () => {
  it('no active project → 401', async () => {
    const res = await checkViaRoute('MOTIR-1');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED' });
  });

  it('a member held by the 2FA policy is refused 403 before anything is read', async () => {
    const s = await makeScenario('2fa');
    signIn(s);
    const card = await item(s, 'story', 'Export a sprint report');
    await adminDb.workspace.update({
      where: { id: s.workspace.id },
      data: { requiresTwoFactor: true },
    });

    const res = await checkViaRoute(card.identifier);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });
  });

  it('a missing or blank `key` → 400', async () => {
    const s = await makeScenario('no-key');
    signIn(s);
    expect((await checkViaRoute()).status).toBe(400);
    expect((await checkViaRoute('   ')).status).toBe(400);
  });

  it('an unknown key and a key in a project the actor may not browse are one 404', async () => {
    const owner = await makeScenario('private-owner');
    signIn(owner);
    const card = await item(owner, 'story', 'Private story');
    const unknown = await checkViaRoute(`${owner.project.identifier}-99999`);
    expect(unknown.status).toBe(404);

    const outsiderEmail = `plannable-outsider-${++seq}@example.com`;
    const outsider = await usersService.createUser({
      email: outsiderEmail,
      password: PASSWORD,
      name: 'Grace Hopper',
    });
    await adminDb.project.update({
      where: { id: owner.project.id },
      data: projectAccessData('members'),
    });
    await adminDb.workspaceMembership.create({
      data: { userId: outsider.id, workspaceId: owner.workspace.id, workspaceRole: 'member' },
    });
    session.current = { user: { id: outsider.id, email: outsiderEmail, name: 'Grace Hopper' } };
    activeCtx.current = {
      userId: outsider.id,
      workspaceId: owner.workspace.id,
      projectId: owner.project.id,
      project: { ...owner.project, ...projectAccessData('members') },
    };

    const forbidden = await checkViaRoute(card.identifier);
    expect(forbidden.status).toBe(404);
    expect(await forbidden.text()).toBe(await unknown.text());
  });

  it('a project VIEWER, who may browse but not plan, is refused ai:plan with 403', async () => {
    const owner = await makeScenario('viewer');
    const card = await item(owner, 'story', 'Export a sprint report');
    await projectMembersService.setAccessMode({
      key: owner.project.identifier,
      actorUserId: owner.user.id,
      ctx: owner.ctx,
      mode: 'members',
    });
    const viewerEmail = `plannable-viewer-${++seq}@example.com`;
    const viewer = await usersService.createUser({
      email: viewerEmail,
      password: PASSWORD,
      name: 'Viewer',
    });
    await workspacesService.addMember({
      userId: viewer.id,
      workspaceId: owner.workspace.id,
      workspaceRole: 'viewer',
    });
    await addToProjectAs({
      key: owner.project.identifier,
      actorUserId: owner.user.id,
      ctx: owner.ctx,
      targetUserId: viewer.id,
      role: 'viewer',
    });
    session.current = { user: { id: viewer.id, email: viewerEmail, name: 'Viewer' } };
    activeCtx.current = {
      userId: viewer.id,
      workspaceId: owner.workspace.id,
      projectId: owner.project.id,
      project: { ...owner.project, ...projectAccessData('members') },
    };

    const res = await checkViaRoute(card.identifier);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'PERMISSION_DENIED', permission: 'ai:plan' });
  });
});

describe('plannabilityService · a blocker in ANOTHER project', () => {
  it('still holds, but is never To plan — the planning overlay is the active project’s', async () => {
    const s = await makeScenario('cross');
    const other = await projectsService.createProject({
      workspaceId: s.workspace.id,
      actorUserId: s.user.id,
      name: 'Other project',
    });
    const card = await item(s, 'story', 'Export a sprint report');
    const foreign = await workItemsService.createWorkItem(
      { projectId: other.id, kind: 'story', title: 'A story over there' },
      s.ctx,
    );
    await blockedBy(s, card, foreign);

    const answer = await plannabilityService.checkPlannable(s.project.id, card.identifier, s.ctx);
    expect(answer.plannable).toBe(false);
    expect(answer.reasons[0]!.blockers).toEqual([
      { identifier: foreign.identifier, title: foreign.title, toPlan: false },
    ]);
  });
});

describe('guard · the handler stays a THIN HTTP layer', () => {
  const source = readFileSync(
    join(process.cwd(), 'app/api/work-items/plannability/route.ts'),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  it('imports no `db`, opens no transaction and makes ONE service call', () => {
    expect(code).not.toMatch(/from '@\/lib\/db'/);
    expect(code).not.toMatch(/\$transaction/);
    expect(code.match(/plannabilityService\.\w+/g)).toEqual(['plannabilityService.checkPlannable']);
  });
});

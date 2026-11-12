import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { foldersService } from '@/lib/services/foldersService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { TWO_FACTOR_REQUIRED_PATH } from '@/lib/auth/twoFactorGate';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// MOTIR-4727 — `GET /api/work-items/planning-anchor?key=`, the anchor read the
// planning-workspace OVERLAY (MOTIR-4725) makes from the browser.
//
// Against REAL Postgres and the real services, in the shape
// `tests/work-items/quick-view-story-gate.test.ts` uses for the peek route: the
// only stubs are the two context resolvers a Vitest process cannot supply
// through cookies. The access gate, the lineage CTE and the 2FA policy are all
// the shipped ones, so a change to any of them surfaces here.

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

const { GET: anchorRoute } = await import('@/app/api/work-items/planning-anchor/route');

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
  const email = `anchor-${slug}-${++seq}@example.com`;
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Ada Lovelace' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
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

function anchorViaRoute(key?: string): Promise<Response> {
  const qs = key === undefined ? '' : `?key=${encodeURIComponent(key)}`;
  return anchorRoute(new Request(`http://localhost:3000/api/work-items/planning-anchor${qs}`));
}

/** epic → story → subtask, so the trail has two rungs above the leaf. */
async function makeTree(s: Scenario) {
  const epic = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'epic', title: 'Epic 8: Launch readiness' },
    s.ctx,
  );
  const story = await workItemsService.createWorkItem(
    {
      projectId: s.project.id,
      kind: 'story',
      title: 'The workspace is an overlay',
      parentId: epic.id,
    },
    s.ctx,
  );
  const leaf = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'subtask', title: 'The anchor read', parentId: story.id },
    s.ctx,
  );
  return { epic, story, leaf };
}

describe('GET /api/work-items/planning-anchor · the happy path', () => {
  it('returns the anchor and its ancestors ROOT→PARENT for a browsable item', async () => {
    const s = await makeScenario('trail');
    signIn(s);
    const { epic, story, leaf } = await makeTree(s);

    const res = await anchorViaRoute(leaf.identifier);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.anchor).toEqual({
      id: leaf.id,
      identifier: leaf.identifier,
      title: 'The anchor read',
      kind: 'subtask',
    });
    // Root first, the anchor's own parent last — the LAST crumb is the level the
    // canvas loads, which is what puts it on the anchor's OWN level.
    expect(body.ancestors).toEqual([
      { id: epic.id, identifier: epic.identifier, title: 'Epic 8: Launch readiness' },
      { id: story.id, identifier: story.identifier, title: 'The workspace is an overlay' },
    ]);
  });

  it('says whether the anchor has CHILDREN — the arrival rule reads it (MOTIR-7621)', async () => {
    // The kind cannot answer this: a story with children and a story without are
    // the same kind. The canvas opens INSIDE only the first.
    const s = await makeScenario('children');
    signIn(s);
    const { epic, story, leaf } = await makeTree(s);
    const bare = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'story', title: 'Not broken down yet', parentId: epic.id },
      s.ctx,
    );

    expect((await (await anchorViaRoute(story.identifier)).json()).hasChildren).toBe(true);
    expect((await (await anchorViaRoute(epic.identifier)).json()).hasChildren).toBe(true);
    expect((await (await anchorViaRoute(bare.identifier)).json()).hasChildren).toBe(false);
    expect((await (await anchorViaRoute(leaf.identifier)).json()).hasChildren).toBe(false);
  });

  it("carries the anchor's placement FOLDER chain, root first (MOTIR-10861)", async () => {
    // A filed card sits behind its folder's door on the canvas, so the arrival
    // trail must walk through these folders or it lands on the root, where the
    // anchor is not drawn. Only a root is filed; a child inherits its root's.
    const s = await makeScenario('folders');
    signIn(s);
    const { epic, story } = await makeTree(s);
    const later = await foldersService.createFolder(
      { projectId: s.project.id, parentFolderId: null, name: 'Later' },
      s.ctx,
    );
    const todo = await foldersService.createFolder(
      { projectId: s.project.id, parentFolderId: later.id, name: 'To do' },
      s.ctx,
    );
    const loose = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'story', title: 'Filed, no children' },
      s.ctx,
    );
    await foldersService.fileWorkItem(loose.id, { folderId: todo.id }, s.ctx);

    const chain = [
      { id: later.id, name: 'Later' },
      { id: todo.id, name: 'To do' },
    ];
    expect((await (await anchorViaRoute(loose.identifier)).json()).folders).toEqual(chain);
    // Unfiled: an empty chain, not a missing one.
    expect((await (await anchorViaRoute(story.identifier)).json()).folders).toEqual([]);

    await foldersService.fileWorkItem(epic.id, { folderId: todo.id }, s.ctx);
    expect((await (await anchorViaRoute(story.identifier)).json()).folders).toEqual(chain);
  });

  it('an ARCHIVED child does not count — the level it would open on is empty', async () => {
    const s = await makeScenario('archived-child');
    signIn(s);
    const { story, leaf } = await makeTree(s);
    await workItemsService.archiveWorkItem(leaf.id, s.ctx);

    expect((await (await anchorViaRoute(story.identifier)).json()).hasChildren).toBe(false);
  });

  it('a ROOT-level item has an empty ancestor list, not a missing one', async () => {
    const s = await makeScenario('root');
    signIn(s);
    const { epic } = await makeTree(s);

    const res = await anchorViaRoute(epic.identifier);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.anchor.identifier).toBe(epic.identifier);
    expect(body.ancestors).toEqual([]);
  });

  it('matches the key EXACTLY — a lower-cased key is the ordinary 404', async () => {
    // Recorded rather than assumed. `workItemRepository.findByIdentifier` is a
    // `findUnique` on `(projectId, identifier)`, so this read is case-SENSITIVE —
    // unlike `planningTargets.sameItem`, whose own comment says identifiers are
    // case-insensitive "everywhere else in the API". Every shipped door writes
    // the item's real identifier into the address, so the overlay never meets
    // this; a hand-edited address does, and it degrades to the project
    // conversation at the root, which is the right answer for a key that names
    // nothing. Out of MOTIR-4727's scope to change — the guard is here so a later
    // card changes it deliberately.
    const s = await makeScenario('case');
    signIn(s);
    const { leaf } = await makeTree(s);

    const res = await anchorViaRoute(leaf.identifier.toLowerCase());
    expect(res.status).toBe(404);
    expect((await anchorViaRoute(leaf.identifier)).status).toBe(200);
  });

  it('never serves a cached anchor — the title and the trail are live item state', async () => {
    const s = await makeScenario('cache');
    signIn(s);
    const { leaf } = await makeTree(s);

    const res = await anchorViaRoute(leaf.identifier);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

describe('GET /api/work-items/planning-anchor · the refusals', () => {
  it('no active project → 401, and the 2FA hold does NOT pre-empt it', async () => {
    const s = await makeScenario('no-project');
    // A held member with no active project: the no-project arm keeps its own
    // answer, which is the ORDER this route inherits from the peek. A 403 here
    // would mean the hold had been placed above it.
    await adminDb.workspace.update({
      where: { id: s.workspace.id },
      data: { requiresTwoFactor: true },
    });
    session.current = { user: { id: s.user.id, email: s.email, name: 'Ada Lovelace' } };
    activeCtx.current = null;

    const res = await anchorViaRoute('MOTIR-1');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED' });
  });

  it('a member held by the 2FA policy is refused 403 with the typed body', async () => {
    const s = await makeScenario('held');
    signIn(s);
    const { leaf } = await makeTree(s);
    await adminDb.workspace.update({
      where: { id: s.workspace.id },
      data: { requiresTwoFactor: true },
    });

    const res = await anchorViaRoute(leaf.identifier);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
      tier: 'workspace',
      enrolAt: TWO_FACTOR_REQUIRED_PATH,
    });
  });

  it('a missing `key` → 400, before anything is read', async () => {
    const s = await makeScenario('no-key');
    signIn(s);

    const res = await anchorViaRoute();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'BAD_REQUEST', error: '`key` is required.' });

    // A blank / whitespace `key` is the same answer — `?key=` is a present
    // parameter carrying nothing, which is the shape a stripped address has.
    const blank = await anchorViaRoute('   ');
    expect(blank.status).toBe(400);
  });

  it('a FORBIDDEN key and an UNKNOWN key are byte-identical — no existence leak', async () => {
    const owner = await makeScenario('leak-owner');
    signIn(owner);
    const { leaf } = await makeTree(owner);

    const outsider = await makeScenario('leak-outsider');
    signIn(outsider);
    // The outsider's own project is active. The foreign item exists and they may
    // not see it; the unknown key never existed. A 403 on the first would
    // confirm existence, so both answers must be the same bytes.
    const forbidden = await anchorViaRoute(leaf.identifier);
    const unknown = await anchorViaRoute(`${outsider.project.identifier}-99999`);

    expect(forbidden.status).toBe(unknown.status);
    expect(forbidden.status).toBe(404);
    const [a, b] = [await forbidden.text(), await unknown.text()];
    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual({ code: 'NOT_FOUND', error: 'Work item not available.' });
  });

  it('a key in a project the actor may NOT BROWSE is the same 404', async () => {
    // The OTHER arm of the no-existence-leak contract, and a different code path:
    // above, the item is absent from the actor's project; here it IS the active
    // project's item and `assertCanBrowse` refuses. Both must be one answer —
    // a 403 would say "it exists but you can't see it", which is the leak.
    const owner = await makeScenario('private-owner');
    signIn(owner);
    const { leaf } = await makeTree(owner);

    // A second workspace member who was never added to the project, and a
    // project that does not admit non-members.
    const outsiderEmail = `anchor-outsider-${++seq}@example.com`;
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
      data: {
        userId: outsider.id,
        workspaceId: owner.workspace.id,
        workspaceRole: 'member',
      },
    });

    // The outsider signs in with the OWNER's project active — the shape a stale
    // cookie or a removed membership leaves behind.
    session.current = { user: { id: outsider.id, email: outsiderEmail, name: 'Grace Hopper' } };
    activeCtx.current = {
      userId: outsider.id,
      workspaceId: owner.workspace.id,
      projectId: owner.project.id,
      project: { ...owner.project, ...projectAccessData('members') },
    };

    const res = await anchorViaRoute(leaf.identifier);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'NOT_FOUND', error: 'Work item not available.' });
  });

  it('a DELETED key is the same 404', async () => {
    const s = await makeScenario('gone');
    signIn(s);
    const { leaf } = await makeTree(s);
    await workItemsService.deleteWorkItem(leaf.id, s.ctx);

    const res = await anchorViaRoute(leaf.identifier);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'NOT_FOUND', error: 'Work item not available.' });
  });

  it('an ARCHIVED key still RESOLVES — the same answer the retiring page gave', async () => {
    // ⚠️ MOTIR-4727's criterion said an archived key is a 404. It is not, and
    // this test records the shipped contract rather than inventing a divergence:
    // `workItemRepository.findByIdentifier` is a `findUnique` on
    // `(projectId, identifier)` with no archived predicate, so
    // `getWorkItemWithAncestors` resolves an archived item — for THIS route, for
    // `app/(planning)/planning/page.tsx` (which this replaces) and for
    // `/roadmap?item=` alike. Filtering here would make the overlay disagree with
    // the page it is replacing about the same key. The criterion is amended on
    // the card; see the pull-request body.
    const s = await makeScenario('archived');
    signIn(s);
    const { leaf } = await makeTree(s);
    await workItemsService.archiveWorkItem(leaf.id, s.ctx);

    const res = await anchorViaRoute(leaf.identifier);
    expect(res.status).toBe(200);
    expect((await res.json()).anchor.identifier).toBe(leaf.identifier);
  });
});

describe('guard · the handler stays a THIN HTTP layer', () => {
  const source = readFileSync(
    join(process.cwd(), 'app/api/work-items/planning-anchor/route.ts'),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  it('imports no `db` and opens no transaction (the 4-layer rule)', () => {
    expect(code).not.toMatch(/from '@\/lib\/db'/);
    expect(code).not.toMatch(/\$transaction/);
    expect(code).not.toMatch(/prisma/i);
  });

  it('reads through the service and adds no second read', () => {
    const calls = code.match(/workItemsService\.\w+/g) ?? [];
    expect(calls).toEqual(['workItemsService.getPlanningAnchor']);
  });

  it('holds the 2FA gate AFTER the no-project arm', () => {
    // Indexed on the CALL, not the identifier: the import line names
    // `refuseIfNonCompliant` at the top of the file, so a bare substring search
    // reports it first no matter where the gate actually sits.
    const gate = code.indexOf('refuseIfNonCompliant(');
    expect(gate).toBeGreaterThan(-1);
    expect(code.indexOf('getActiveProject(')).toBeLessThan(gate);
    expect(code.indexOf('UNAUTHENTICATED')).toBeLessThan(gate);
    // …and the `key` arm is AFTER the gate, so a held caller cannot probe for a
    // 400-vs-404 difference.
    expect(gate).toBeLessThan(code.indexOf('BAD_REQUEST'));
  });
});

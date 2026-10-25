import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { DEFAULT_SORT, ISSUE_LIST_PAGE_SIZE } from '@/lib/issues/issueListView';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { isGrantable } from '@/lib/tokens/grant';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  auditV1RouteSource,
  declaredPermissionByMethod,
  readRouteSource,
  v1RouteFiles,
} from '../../helpers/v1RouteAudit';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// The Story 11.2 vitest GATE (Subtask 11.2.11 — MOTIR-2053).
//
// It measures the story's REAL merged surface, so it runs AFTER the feature
// cards. Its job is the three things their own suites structurally cannot do:
//
//   1. Cover the seams BETWEEN cards — a mapper and a read that drift apart
//      while every unit still passes.
//   2. Drive one card's REAL output through the next card's REAL consumer.
//   3. Assert the CONTRACT guarantees a coverage percentage cannot see.

const REPO_ROOT = process.cwd();

/** Every work-item route this story ships, named EXPLICITLY so a deleted route
 *  is a failing test rather than a silently smaller sweep. */
const STORY_ROUTES = [
  'app/api/v1/projects/[projectKey]/work-items/route.ts',
  'app/api/v1/work-items/[key]/route.ts',
  'app/api/v1/work-items/[key]/transitions/route.ts',
  'app/api/v1/work-items/[key]/comments/route.ts',
  'app/api/v1/work-items/[key]/links/route.ts',
  'app/api/v1/work-items/[key]/archive/route.ts',
  'app/api/v1/work-items/[key]/restore/route.ts',
] as const;

type Handler = (
  req: Request,
  args: { params: Promise<Record<string, string>> },
) => Promise<Response>;

async function route(path: string, method: string): Promise<Handler> {
  const mod = (await import(/* @vite-ignore */ `@/${path.replace(/\.ts$/, '')}`)) as Record<
    string,
    Handler
  >;
  const handler = mod[method];
  if (!handler) throw new Error(`${path} exports no ${method}`);
  return handler;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Contract guards — what a coverage percentage cannot see
// ─────────────────────────────────────────────────────────────────────────────

describe('gate — the work-item route surface exists and is clean', () => {
  it('names every route this story ships (a sweep over zero files proves nothing)', () => {
    const files = v1RouteFiles(REPO_ROOT);
    for (const expected of STORY_ROUTES) {
      expect(files, `${expected} must be in the tree`).toContain(expected);
    }
    expect(files.length).toBeGreaterThanOrEqual(STORY_ROUTES.length + 2);
  });

  it('EVERY v1 route passes every architecture guard', () => {
    const violations = v1RouteFiles(REPO_ROOT).flatMap((file) =>
      auditV1RouteSource(file, readRouteSource(REPO_ROOT, file)),
    );

    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('no v1 route imports lib/mcp/tools — the two surfaces align through SCHEMAS', () => {
    for (const file of v1RouteFiles(REPO_ROOT)) {
      expect(readRouteSource(REPO_ROOT, file), `${file}`).not.toMatch(
        /from\s+['"]@\/lib\/mcp\/tools\//,
      );
    }
  });

  // ⚠️ The ADR's own CONDITION for leaving the cascade delete out of v1.
  it('the cascade delete is UNREACHABLE through any /api/v1 route', () => {
    for (const file of v1RouteFiles(REPO_ROOT)) {
      const source = readRouteSource(REPO_ROOT, file);
      expect(source, `${file} must not reach deleteWorkItem`).not.toMatch(/\bdeleteWorkItem\s*\(/);
      expect(source, `${file} must not declare work_items:delete`).not.toMatch(
        /scope\s*:\s*['"]work_items:delete['"]/,
      );
    }
  });

  // Table-driven over the WHOLE tree, so a new endpoint cannot pick its own gate.
  it('every VERB declares the permission the operation→permission table assigns it', () => {
    /**
     * The table from `docs/decisions/token-permissions.md` §3, as a predicate per
     * verb — expressed in the PERMISSION vocabulary (MOTIR-2577).
     *
     * Where a shipped map already answers, the expectation is READ OFF IT rather
     * than restated, so a future move of an operation drags this guard along
     * instead of putting it in contradiction.
     */
    const expectedPermission = (file: string, method: string): string => {
      // The page resource (MOTIR-9493): `pagesService` gates its doors on the
      // PAGE keys, read off the MCP page tools that call the same doors.
      if (/\/pages\//.test(file)) {
        return method === 'GET' ? TOOL_PERMISSIONS.get_page : TOOL_PERMISSIONS.create_page;
      }
      if (method === 'GET') return 'project:browse';
      // Archive and restore assert `work_item:archive` — the REVERSIBLE,
      // non-cascading soft-remove, which MOTIR-3629 split out of
      // `work_item:delete` (ADR §10). The old split the six scopes carried was
      // right after all; what it lacked was a catalog key to land on.
      if (/\/(archive|restore)\//.test(file)) return TOOL_PERMISSIONS.archive_work_item;
      // Sprint + backlog writes, keyed on the SPRINT: every write under a
      // `sprints` or `backlog` segment takes `sprint:manage`, including the
      // membership move that happens to end in `/work-items`.
      if (/\bsprints\b/.test(file) || /\bbacklog\b/.test(file)) return 'sprint:manage';
      // The comment POST is the one work-item write that is NOT `work_item:edit`:
      // `commentsService` gates it on `canComment`. Under the six scopes it hid
      // inside `work_items:write`; withholding it is now expressible.
      if (/\/comments\/route\.ts$/.test(file)) return TOOL_PERMISSIONS.add_comment;
      // The two close-out writes and the provenance report, read off the shipped
      // map rather than re-derived from the verb.
      if (/\/integration\//.test(file)) return TOOL_PERMISSIONS.mark_integrated;
      if (/\/sessions\//.test(file)) return TOOL_PERMISSIONS.complete_session;
      if (/\/implementation\//.test(file)) return TOOL_PERMISSIONS.mark_integrated;
      // The planning surface. The MOUNT no longer disagrees with its neighbours:
      // `getOrCreateForScope` asserts `ai:plan`, so all of open / append / submit
      // — and the expansion submit — name the permission that actually gates them
      // (ADR §5 records the legacy read-only token this narrows).
      if (/\/plan-session\//.test(file)) return TOOL_PERMISSIONS.open_plan_session;
      if (/\/expansions\//.test(file)) return TOOL_PERMISSIONS.expand_item;
      // Plan APPROVAL (MOTIR-3021 / MOTIR-3023). `ai:decide_plan` — the key
      // `plansService.approvePlan` itself asserts. It is NOT read off
      // `TOOL_PERMISSIONS` like its neighbours above, for the reason the
      // operation exists at all: approval is deliberately not an MCP tool, so
      // there is no row to read (`docs/decisions/run-findings-protocol.md` Q2).
      // Naming the key here rather than inventing a default is the same
      // discipline — the expectation still comes from the gate that runs.
      //
      // ⚠️ It was `ai:view_plan` until MOTIR-3188, which split that key: it
      // gated no view and held AUTHOR and DECIDE together. The route followed
      // its service, which is the rule this whole map applies.
      if (/\/plan-approval\//.test(file)) return 'ai:decide_plan';
      return 'work_item:edit';
    };

    let verbsChecked = 0;
    for (const file of v1RouteFiles(REPO_ROOT)) {
      const byMethod = declaredPermissionByMethod(readRouteSource(REPO_ROOT, file));
      for (const [method, permission] of byMethod) {
        verbsChecked += 1;
        expect(permission, `${file} ${method} declares a readable permission`).toBeDefined();
        expect(isGrantable(permission), `${file} ${method} declares "${permission}"`).toBe(true);
        expect(permission, `${file} ${method} — the operation→permission table`).toBe(
          expectedPermission(file, method),
        );
      }
    }
    // The sweep really covered the surface, not a subset of it.
    expect(verbsChecked).toBeGreaterThanOrEqual(12);
  });

  it('every work-item route shapes its response through the SCHEMA module', () => {
    // What makes 11.4's "single schema source" true rather than aspirational: a
    // route that hand-shapes a body inline has no schema for the spec to emit.
    for (const file of STORY_ROUTES) {
      const source = readRouteSource(REPO_ROOT, file);
      expect(source, `${file} must import the work-item schema module`).toMatch(
        /from\s+['"]@\/lib\/api\/v1\/workItems\/schema['"]/,
      );
      expect(source, `${file} must use a presenter`).toMatch(/present[A-Z]\w+\(/);
    }
  });

  // ⚠️ Every new guard gets a deliberately-VIOLATING fixture. A guard that has
  // never been shown to fail is indistinguishable from no guard.
  describe('the new guards actually fail when violated', () => {
    it('catches a route importing the MCP tool layer', () => {
      const bad = `
        import { withV1Route } from '@/lib/api/v1/route';
        import { getWorkItem } from '@/lib/mcp/tools/getWorkItem';
        export const GET = withV1Route({ permission: 'project:browse' }, async () => Response.json({}));
      `;
      expect(auditV1RouteSource('bad/route.ts', bad).map((v) => v.rule)).toContain(
        'imports-mcp-tools',
      );
    });

    it('catches a route reaching the cascade delete', () => {
      const bad = `
        import { withV1Route } from '@/lib/api/v1/route';
        import { workItemsService } from '@/lib/services/workItemsService';
        export const DELETE = withV1Route({ permission: 'work_item:edit' }, async (ctx) => {
          await workItemsService.deleteWorkItem(ctx.params.id, ctx.service);
          return new Response(null, { status: 204 });
        });
      `;
      expect(auditV1RouteSource('bad/route.ts', bad).map((v) => v.rule)).toContain(
        'reaches-cascade-delete',
      );
    });

    it('catches ANY route declaring the irreversible permission', () => {
      const bad = `
        import { withV1Route } from '@/lib/api/v1/route';
        export const POST = withV1Route({ permission: 'work_item:delete' }, async () => Response.json({}));
      `;
      expect(auditV1RouteSource('bad/route.ts', bad).map((v) => v.rule)).toContain(
        'declares-unexposed-permission',
      );
    });

    // ⚠️ INVERTED BY MOTIR-3629, and the inversion is this card's machine-checkable
    // deliverable. This case used to be "does NOT fire on the archive/restore
    // routes, which legitimately declare it": archive and delete shared
    // `work_item:delete`, v1 exposes archive and not delete, and the permission
    // could no longer express the difference — so the audit admitted the two
    // archive PATHS by name. A path allow-list standing in for a permission is a
    // missing vocabulary item announcing itself. With the key split there is
    // nothing left to except.
    it('fires on the ARCHIVE path too — the carve-out is gone, not merely unused', () => {
      const stillDeclaringDelete = `
        import { withV1Route } from '@/lib/api/v1/route';
        export const POST = withV1Route({ permission: 'work_item:delete' }, async () => Response.json({}));
      `;
      const rules = auditV1RouteSource(
        'app/api/v1/work-items/[key]/archive/route.ts',
        stillDeclaringDelete,
      ).map((v) => v.rule);
      expect(rules).toContain('declares-unexposed-permission');
    });

    it('passes an archive route declaring its own key', () => {
      const archive = `
        import { withV1Route } from '@/lib/api/v1/route';
        export const POST = withV1Route({ permission: 'work_item:archive' }, async () => Response.json({}));
      `;
      const rules = auditV1RouteSource('app/api/v1/work-items/[key]/archive/route.ts', archive).map(
        (v) => v.rule,
      );
      expect(rules).not.toContain('declares-unexposed-permission');
      // …and so does one at any OTHER path, which is the point of keying on the
      // permission: a new route reaching archive gets the property for free.
      expect(
        auditV1RouteSource('app/api/v1/somewhere/else/route.ts', archive).map((v) => v.rule),
      ).not.toContain('declares-unexposed-permission');
    });

    it('reads a per-verb permission map that distinguishes a GET from its sibling POST', () => {
      const source = `
        export const GET = withV1Route<{ key: string }>({ permission: 'project:browse' }, async () => x);
        export const POST = withV1Route<{ key: string }>({ permission: 'work_item:edit' }, async () => x);
      `;
      const byMethod = declaredPermissionByMethod(source);
      expect(byMethod.get('GET')).toBe('project:browse');
      expect(byMethod.get('POST')).toBe('work_item:edit');
    });

    it('records an unreadable permission as UNDEFINED rather than dropping the verb', () => {
      // A silently skipped route is a hole in a guard that still reads as
      // coverage, so the map keeps the verb and the assertion fails on it.
      const source = `export const PATCH = withV1Route(OPTIONS, async () => x);`;
      expect(declaredPermissionByMethod(source).has('PATCH')).toBe(true);
      expect(declaredPermissionByMethod(source).get('PATCH')).toBeUndefined();
    });

    it('does NOT fire on prose — a comment naming deleteWorkItem is not a violation', () => {
      const good = `
        // This route deliberately does NOT call deleteWorkItem( — see ADR §3.
        import { withV1Route } from '@/lib/api/v1/route';
        export const GET = withV1Route({ permission: 'project:browse' }, async () => Response.json({}));
      `;
      expect(auditV1RouteSource('good/route.ts', good)).toEqual([]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Integration seams — the tests that span TWO cards
// ─────────────────────────────────────────────────────────────────────────────

describe('gate — seams across the work-item endpoints', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({
      scopes: ['read', 'work_items:write', 'work_items:archive'],
    });
  });

  const base = 'http://localhost:3000/api/v1';

  async function createItem(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const POST = await route(STORY_ROUTES[0], 'POST');
    const res = await POST(
      new Request(`${base}/projects/${caller.projectKey}/work-items`, {
        method: 'POST',
        headers: { ...caller.headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ projectKey: caller.projectKey }) },
    );
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as Record<string, unknown>;
  }

  async function readItem(key: string): Promise<Response> {
    const GET = await route(STORY_ROUTES[1], 'GET');
    return GET(new Request(`${base}/work-items/${key}`, { headers: caller.headers }), {
      params: Promise.resolve({ key }),
    });
  }

  async function listItems(query = '?limit=100'): Promise<Array<Record<string, unknown>>> {
    const GET = await route(STORY_ROUTES[0], 'GET');
    const res = await GET(
      new Request(`${base}/projects/${caller.projectKey}/work-items${query}`, {
        headers: caller.headers,
      }),
      { params: Promise.resolve({ projectKey: caller.projectKey }) },
    );
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    return body.items;
  }

  // ── WRITE → READ round trip ───────────────────────────────────────────────
  it('a created item agrees FIELD-FOR-FIELD across create, list and detail', async () => {
    const created = await createItem({
      kind: 'task',
      title: 'Round trip',
      type: 'code',
      priority: 'high',
      storyPoints: 5,
      estimateMinutes: 90,
    });
    const key = created['key'] as string;

    const detail = (await (await readItem(key)).json()) as Record<string, unknown>;
    const row = (await listItems()).find((i) => i['key'] === key);
    expect(row, 'the created item is findable through the LIST endpoint').toBeDefined();

    // The seam where a mapper and a read drift and no unit notices: three
    // different code paths, one truth.
    for (const field of [
      'key',
      'kind',
      'type',
      'title',
      'status',
      'priority',
      'storyPoints',
      'estimateMinutes',
      'assigneeId',
      'reporterId',
      'createdAt',
      'updatedAt',
    ]) {
      expect(row?.[field], `list vs create disagree on ${field}`).toEqual(created[field]);
      expect(detail[field], `detail vs create disagree on ${field}`).toEqual(created[field]);
    }
  });

  it('an all-NULL item and an all-SET item both survive the list AND detail schemas', async () => {
    // The null-shape case unit fixtures usually miss.
    const bare = await createItem({ kind: 'task', title: 'Bare' });
    const full = await createItem({
      kind: 'task',
      title: 'Full',
      descriptionMd: 'body',
      type: 'design',
      executor: 'human',
      priority: 'lowest',
      storyPoints: 1,
      estimateMinutes: 15,
      dueDate: new Date('2026-12-01T00:00:00.000Z').toISOString(),
    });

    const { workItemDetailSchema, workItemSummarySchema } =
      await import('@/lib/api/v1/workItems/schema');
    for (const key of [bare['key'], full['key']] as string[]) {
      const detail = await (await readItem(key)).json();
      expect(workItemDetailSchema.safeParse(detail).success, `detail ${key}`).toBe(true);
    }
    for (const row of await listItems()) {
      expect(workItemSummarySchema.safeParse(row).success, `summary ${String(row['key'])}`).toBe(
        true,
      );
    }
  });

  // ── ETag × PATCH ──────────────────────────────────────────────────────────
  it('the validator the READ issues is the one the WRITE accepts, and a write invalidates it', async () => {
    const created = await createItem({ kind: 'task', title: 'Versioned' });
    const key = created['key'] as string;

    const issued = (await readItem(key)).headers.get('etag') as string;
    expect(issued).toBeTruthy();

    const PATCH = await route(STORY_ROUTES[1], 'PATCH');
    const patch = async (title: string, etag: string): Promise<Response> =>
      PATCH(
        new Request(`${base}/work-items/${key}`, {
          method: 'PATCH',
          headers: { ...caller.headers, 'content-type': 'application/json', 'if-match': etag },
          body: JSON.stringify({ title }),
        }),
        { params: Promise.resolve({ key }) },
      );

    expect((await patch('Accepted', issued)).status).toBe(200);
    // One function owns both directions — and the write invalidated the old one.
    expect((await patch('Replayed', issued)).status).toBe(412);
  });

  // ── Transition × workflow ─────────────────────────────────────────────────
  it('GET …/transitions and a refusal report the SAME set for the same item', async () => {
    const created = await createItem({ kind: 'task', title: 'Movable' });
    const key = created['key'] as string;

    const listed = (await (
      await (
        await route(STORY_ROUTES[2], 'GET')
      )(new Request(`${base}/work-items/${key}/transitions`, { headers: caller.headers }), {
        params: Promise.resolve({ key }),
      })
    ).json()) as { transitions: Array<{ key: string }> };

    const refused = await (
      await route(STORY_ROUTES[2], 'POST')
    )(
      new Request(`${base}/work-items/${key}/transitions`, {
        method: 'POST',
        headers: { ...caller.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      }),
      { params: Promise.resolve({ key }) },
    );
    const body = (await refused.json()) as { allowedTransitions: Array<{ key: string }> };

    expect(refused.status).toBe(422);
    // Produced by different code paths; they must not disagree.
    expect(body.allowedTransitions.map((t) => t.key).sort()).toEqual(
      listed.transitions.map((t) => t.key).sort(),
    );
  });

  // ── Links × detail ────────────────────────────────────────────────────────
  it('an edge written through …/links appears in BOTH the sub-resource and the detail', async () => {
    const a = await createItem({ kind: 'task', title: 'A' });
    const b = await createItem({ kind: 'task', title: 'B' });
    const key = a['key'] as string;

    await (
      await route(STORY_ROUTES[4], 'POST')
    )(
      new Request(`${base}/work-items/${key}/links`, {
        method: 'POST',
        headers: { ...caller.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ toKey: b['key'], relationship: 'relates_to' }),
      }),
      { params: Promise.resolve({ key }) },
    );

    const sub = await (
      await (
        await route(STORY_ROUTES[4], 'GET')
      )(new Request(`${base}/work-items/${key}/links`, { headers: caller.headers }), {
        params: Promise.resolve({ key }),
      })
    ).json();
    const detail = (await (await readItem(key)).json()) as { links: unknown };

    expect(sub).toEqual(detail.links);
  });

  // ── Archive × list, across a paged walk ───────────────────────────────────
  it('an archived item leaves the list and the cursor walk stays correct across the change', async () => {
    const keys: string[] = [];
    for (let i = 0; i < 7; i++) {
      keys.push((await createItem({ kind: 'task', title: `Item ${i}` }))['key'] as string);
    }

    // Walk with a small page, archiving mid-scan. The collection MUTATING
    // mid-walk is the normal case here, not an edge case.
    const seen: string[] = [];
    let cursor: string | null = null;
    let page = 0;
    do {
      const GET = await route(STORY_ROUTES[0], 'GET');
      const res = await GET(
        new Request(
          `${base}/projects/${caller.projectKey}/work-items?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          { headers: caller.headers },
        ),
        { params: Promise.resolve({ projectKey: caller.projectKey }) },
      );
      const body = (await res.json()) as {
        items: Array<{ key: string }>;
        nextCursor: string | null;
      };
      seen.push(...body.items.map((i) => i.key));
      cursor = body.nextCursor;

      if (page === 0) {
        // Archive an item on a LATER page — it must simply not appear.
        const victim = keys[keys.length - 1] as string;
        await (
          await route(STORY_ROUTES[5], 'POST')
        )(
          new Request(`${base}/work-items/${victim}/archive`, {
            method: 'POST',
            headers: caller.headers,
          }),
          { params: Promise.resolve({ key: victim }) },
        );
      }
      page += 1;
    } while (cursor && page < 20);

    expect(new Set(seen).size, 'no row seen twice across the mutating walk').toBe(seen.length);
    expect(seen).not.toContain(keys[keys.length - 1]);

    // …and it comes back on restore.
    const victim = keys[keys.length - 1] as string;
    await (
      await route(STORY_ROUTES[6], 'POST')
    )(
      new Request(`${base}/work-items/${victim}/restore`, {
        method: 'POST',
        headers: caller.headers,
      }),
      { params: Promise.resolve({ key: victim }) },
    );
    expect((await listItems()).map((i) => i['key'])).toContain(victim);
  });

  // ── Filter parity, end to end ─────────────────────────────────────────────
  it('the same FilterAST yields the same key set through v1 and through the /items read', async () => {
    await createItem({ kind: 'task', title: 'A task' });
    await createItem({ kind: 'bug', title: 'A defect' });
    await createItem({ kind: 'bug', title: 'Another defect' });

    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
    };

    const viaApi = (
      await listItems(`?limit=100&filter=${encodeURIComponent(encodeFilterParam(ast))}`)
    )
      .map((i) => i['key'] as string)
      .sort();
    const viaList = (
      await workItemsService.getProjectIssuesList(
        caller.fixture.projectId,
        { sort: DEFAULT_SORT, filter: { ast }, page: 1, pageSize: ISSUE_LIST_PAGE_SIZE },
        caller.ctx,
      )
    ).items
      .map((i) => i.identifier)
      .sort();

    expect(viaApi).toHaveLength(2);
    expect(viaApi).toEqual(viaList);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Coverage top-up — the branches no single card's tests reach
// ─────────────────────────────────────────────────────────────────────────────
//
// "Already covered by the per-subtask floor" is the EXPECTED normal here; what
// this section tops up is what falls BETWEEN the cards, plus the defensive arms
// a happy-path route never takes.

describe('gate — coverage top-up: the schema module', () => {
  it('presentWorkItemRef degrades a parent to null when given no resolver', async () => {
    const { presentWorkItemRef } = await import('@/lib/api/v1/workItems/schema');

    // The DEFAULT `keyOfId` — used by any caller that presents a reference
    // outside a detail read, where no id→key map has been built.
    const ref = presentWorkItemRef({
      id: 'cmsdw87oz000004kvypsh8m9n',
      parentId: 'cmsdw87oz000004kvypsh8unk',
      kind: 'subtask',
      key: 3,
      identifier: 'PROD-3',
      title: 'Orphan',
      status: 'todo',
      priority: 'medium',
      assigneeId: null,
      position: 'a0',
      estimateMinutes: null,
      storyPoints: null,
      archivedAt: null,
      obsolescence: null,
      obsolescenceNoteMd: null,
    });

    expect(ref.parentKey).toBeNull();
    expect(ref.archived).toBe(false);
  });

  it('presentTransitionTargets reports EVERY other status under an `open` policy', async () => {
    const { presentTransitionTargets } = await import('@/lib/api/v1/workItems/schema');

    // An `open`-policy project permits any move and therefore stores NO edges —
    // read off the edge list alone it would report "nowhere to go", which is
    // exactly backwards.
    const workflow = {
      policyMode: 'open',
      statuses: [
        { id: 's1', key: 'todo', label: 'To Do', category: 'todo' },
        { id: 's2', key: 'doing', label: 'Doing', category: 'in_progress' },
        { id: 's3', key: 'done', label: 'Done', category: 'done' },
      ],
      transitions: [],
    };

    expect(presentTransitionTargets(workflow, 'todo').map((t) => t.key)).toEqual(['doing', 'done']);
  });

  it('the ETag decoder rejects a validator whose plaintext is not a date', async () => {
    const { encodeWorkItemETag, decodeWorkItemETag } =
      await import('@/lib/api/v1/workItems/schema');

    // Correctly signed and decryptable — but not an instant. Only reachable by
    // encrypting deliberate garbage, which is why no card-level test hit it.
    const wellFormedNonsense = encodeWorkItemETag('not-a-date-at-all');

    expect(() => decodeWorkItemETag(wellFormedNonsense)).toThrowError(/valid ETag/);
  });

  it('the ETag key refuses to be derived without the app secret', async () => {
    const { encodeWorkItemETag } = await import('@/lib/api/v1/workItems/schema');
    const saved = process.env['BETTER_AUTH_SECRET'];
    delete process.env['BETTER_AUTH_SECRET'];
    try {
      // Failing loudly beats minting a validator under a predictable key.
      expect(() => encodeWorkItemETag(new Date().toISOString())).toThrowError(/BETTER_AUTH_SECRET/);
    } finally {
      if (saved !== undefined) process.env['BETTER_AUTH_SECRET'] = saved;
    }
  });

  it('parseV1Body reports a ROOT-level failure without a field path', async () => {
    const { parseV1Body, createWorkItemBodySchema } = await import('@/lib/api/v1/workItems/schema');

    // A body that is not an object at all: the zod issue carries an EMPTY path,
    // so the message must not read "invalid at ``".
    const rootLevelFailure = (): Request =>
      new Request('http://localhost/x', { method: 'POST', body: '"a string"' });

    await expect(parseV1Body(rootLevelFailure(), createWorkItemBodySchema)).rejects.toMatchObject({
      code: 'INVALID_BODY',
    });

    // A fresh request per call — a consumed body cannot be cloned.
    let thrown: Error | undefined;
    try {
      await parseV1Body(rootLevelFailure(), createWorkItemBodySchema);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message).not.toContain('at ``');
    expect(thrown?.message).toContain('invalid');
  });

  it('parseV1Body rejects a body that is not JSON at all', async () => {
    const { parseV1Body, createWorkItemBodySchema } = await import('@/lib/api/v1/workItems/schema');
    const req = new Request('http://localhost/x', { method: 'POST', body: '{not json' });

    await expect(parseV1Body(req, createWorkItemBodySchema)).rejects.toMatchObject({
      code: 'INVALID_BODY',
    });
  });
});

describe('gate — coverage top-up: key resolution', () => {
  it('treats a key with no hyphen as its own project key', async () => {
    const { projectKeyOfWorkItemKey } = await import('@/lib/api/v1/workItems/resolveKey');

    // Defensive: such a key never passes the pattern gate, but the derivation
    // must not slice past the start of the string on the way to rejecting it.
    expect(projectKeyOfWorkItemKey('NODASH')).toBe('NODASH');
    expect(projectKeyOfWorkItemKey('-7')).toBe('-7');
  });

  it('422s a MISSING key segment rather than throwing on undefined', async () => {
    const { resolveWorkItemKey } = await import('@/lib/api/v1/workItems/resolveKey');

    // Next.js will not route without the segment, but the handler is also called
    // directly — by the route-tree sweep, and by any future composition — and a
    // bare 500 would hide a caller's mistake behind "something went wrong".
    await expect(
      resolveWorkItemKey(undefined, { userId: 'u', workspaceId: 'w' }),
    ).rejects.toMatchObject({ code: 'INVALID_WORK_ITEM_KEY' });
  });
});

describe('gate — coverage top-up: the detail presenter across every link group', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
  });

  it('maps ALL FIVE groups, plus labels, components and a cascade-blocked ancestor', async () => {
    // Every card exercises one or two groups; nothing exercises all five, nor
    // the label/component mappers, nor the blocked-by-ANCESTOR arm.
    const base = 'http://localhost:3000/api/v1';
    const create = async (kind: string, title: string, parentKey?: string) => {
      const POST = await route(STORY_ROUTES[0], 'POST');
      const res = await POST(
        new Request(`${base}/projects/${caller.projectKey}/work-items`, {
          method: 'POST',
          headers: { ...caller.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ kind, title, ...(parentKey ? { parentKey } : {}) }),
        }),
        { params: Promise.resolve({ projectKey: caller.projectKey }) },
      );
      return (await res.json()) as { key: string };
    };

    const story = await create('story', 'Parent story');
    const item = await create('subtask', 'The item', story.key);
    const link = async (fromKey: string, toKey: string, relationship: string) => {
      const POST = await route(STORY_ROUTES[4], 'POST');
      const res = await POST(
        new Request(`${base}/work-items/${fromKey}/links`, {
          method: 'POST',
          headers: { ...caller.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ toKey, relationship }),
        }),
        { params: Promise.resolve({ key: fromKey }) },
      );
      expect(res.status, await res.clone().text()).toBe(201);
    };

    // Siblings of the item, so its blocked_by / blocks edges join one level
    // (MOTIR-6411: the level is position — a ROOT task is one level up).
    const blocker = await create('task', 'Blocks it', story.key);
    const blocked = await create('task', 'Is blocked by it', story.key);
    const dup = await create('task', 'A duplicate');
    const clone = await create('task', 'A clone');
    const related = await create('task', 'Related');

    await link(item.key, blocker.key, 'blocked_by');
    await link(item.key, blocked.key, 'blocks');
    await link(item.key, related.key, 'relates_to');
    await link(item.key, dup.key, 'duplicates');
    await link(item.key, clone.key, 'clones');

    // A blocker on the PARENT — the cascade arm `blockedByAncestorKey` reports.
    const ancestorBlocker = await create('task', 'Blocks the parent');
    await link(story.key, ancestorBlocker.key, 'blocked_by');

    const GET = await route(STORY_ROUTES[1], 'GET');
    const detail = (await (
      await GET(new Request(`${base}/work-items/${item.key}`, { headers: caller.headers }), {
        params: Promise.resolve({ key: item.key }),
      })
    ).json()) as {
      links: Record<string, Array<{ key: string; parentKey: string | null }>>;
      readiness: { ready: boolean; blockedByAncestorKey: string | null };
      parentKey: string;
    };

    expect(detail.links['blockedBy']?.map((r) => r.key)).toEqual([blocker.key]);
    expect(detail.links['blocks']?.map((r) => r.key)).toEqual([blocked.key]);
    expect(detail.links['relatesTo']?.map((r) => r.key)).toEqual([related.key]);
    expect(detail.links['duplicates']?.map((r) => r.key)).toEqual([dup.key]);
    expect(detail.links['clones']?.map((r) => r.key)).toEqual([clone.key]);
    expect(detail.parentKey).toBe(story.key);
    expect(detail.readiness.ready).toBe(false);
  });
});

import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// motir-ai is STUBBED, and only motir-ai. Story 11.7's expansion submit is the
// one operation in the registry that reaches outside this process, and the
// alternative to a stub is an `UNDRIVABLE` excuse — i.e. a declared operation
// whose real response nothing validates, which is precisely the hole this suite
// exists to close. The stub replaces the network hop and nothing else: the
// route, the service, the Plan row it opens and the response it shapes are all
// real, against real Postgres.
// The attachment upload writes a blob. Mocking the STORE (never the service) is
// what lets the general door be DRIVEN here rather than excused: the gates, the
// row write and the link/revision transaction all run for real, and only the
// bytes stop at the boundary this suite has no business crossing.
vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  putPrivateAttachment: vi.fn(async (pathname: string) => ({ pathname })),
  deleteAttachmentBlob: vi.fn(async () => {}),
}));

const { jobSeq } = vi.hoisted(() => ({ jobSeq: { n: 0 } }));

vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  // ⚠️ A DISTINCT job id PER SUBMIT, which is what the real planner returns and
  // what this suite now depends on: a plan binds to its job through
  // `sourceJobId`, and the plan-change session that submitted it binds through
  // `lastJobId` — so two submits sharing one id make the plan→conversation
  // lookup `approvePlan`'s anchor check walks ambiguous, and it resolves to
  // whichever session was found first (MOTIR-3021).
  submitJob: vi.fn(async () => ({ jobId: `job_drift_guard_${++jobSeq.n}` })),
}));
import { z } from 'zod/v4';
import { V1_OPERATIONS, findV1Operation } from '@/lib/api/v1/openapi/registry';
import { defineOperation, operationKey, type V1Operation } from '@/lib/api/v1/openapi/operation';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { workItemDetailSchema } from '@/lib/api/v1/workItems/schema';
import { plansService } from '@/lib/services/plansService';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { adminDb } from '../../helpers/adminDb';
import { LEGACY_SCOPE_PERMISSIONS } from '@/lib/mcp/scopes';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { connectAndLinkRepo } from '../../fixtures/codeContextFixtures';
import { truncateAuthTables } from '../../helpers/db';
import { v1RouteFiles } from '../../helpers/v1RouteAudit';
import {
  findSpecDrift,
  responseSchemaFor,
  shippedRouteMethods,
  staleUndrivableEntries,
  syntheticRouteFile,
  unexercisedOperations,
} from '../../helpers/v1SpecConformance';

// The route↔spec CONFORMANCE GUARD (Story 11.4 · Subtask 11.4.6 — MOTIR-2187).
//
// Everything before this card produces a document that is correct TODAY. This
// is what stops it quietly becoming wrong, and it is the only deliverable in
// the story whose absence would not be noticed for months.
//
// Three drifts, each proven by DELIBERATELY INTRODUCING IT:
//
//   1. A `/api/v1` route with no operation — a "complete" reference that is
//      partial, undetectable from the document alone.
//   2. An operation naming no route — worse: a client builds against it and
//      gets a 404.
//   3. A REAL response that no longer validates against its declared schema —
//      the drift that makes the other two look fine.
//
// ⚠️ Drift 3 is driven against a REAL request and a REAL response through the
// shipped fixtures and real Postgres. Validating a fixture generated from the
// schema under test would test the fixture.
//
// ⚠️ NO SILENT CAPS. `UNDRIVABLE` below is the complete list of operations this
// suite does not exercise, each with a written reason, and
// `unexercisedOperations` FAILS on an operation that is neither driven nor
// excused. A quietly-skipped operation reads exactly like a covered one.

const REPO_ROOT = process.cwd();
const ORIGIN = 'http://localhost:3000';

/**
 * Operations this suite cannot drive in process, each with its reason.
 *
 * EMPTY, deliberately: every declared operation is reachable through the
 * shipped in-process harness. It exists as a named, asserted mechanism rather
 * than as a convention, so the day one genuinely cannot be driven the excuse
 * has to be written down instead of silently omitted.
 */
const UNDRIVABLE: Readonly<Record<string, string>> = {};

/** Every route file's source, keyed the way the drift rules expect. */
function realRouteSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const file of v1RouteFiles(REPO_ROOT)) {
    sources.set(file, readFileSync(join(REPO_ROOT, file), 'utf8'));
  }
  return sources;
}

// ─────────────────────────────────────────────────────────────────────────────
// Drifts 1 and 2 — the tree against the registry
// ─────────────────────────────────────────────────────────────────────────────

describe('the route tree and the document agree', () => {
  it('passes against the real tree and the real registry', () => {
    const drift = findSpecDrift(shippedRouteMethods(realRouteSources()), V1_OPERATIONS);
    expect(drift, JSON.stringify(drift, null, 2)).toEqual([]);
  });

  it('is not vacuous — the walk finds routes and the registry has operations', () => {
    // A rule run over two empty sets agrees perfectly and proves nothing.
    expect(shippedRouteMethods(realRouteSources()).length).toBeGreaterThan(15);
    expect(V1_OPERATIONS.length).toBeGreaterThan(15);
  });

  it('DRIFT 1 FAILS: a route with an exported handler and no operation', () => {
    const sources = realRouteSources();
    sources.set(
      syntheticRouteFile('widgets'),
      `export const GET = withV1Route({ permission: 'project:browse' }, async () => {});`,
    );

    const drift = findSpecDrift(shippedRouteMethods(sources), V1_OPERATIONS);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.rule).toBe('route-without-operation');
    expect(drift[0]?.subject).toBe('GET /api/v1/widgets');
  });

  it('DRIFT 2 FAILS: an operation whose path matches no route file', () => {
    const orphan: V1Operation = defineOperation({
      method: 'GET',
      path: '/api/v1/widgets',
      operationId: 'listWidgets',
      summary: 'A resource that does not exist',
      description: 'Renamed or removed, and still advertised.',
      permission: 'project:browse',
      parameters: [],
      response: { status: 200, body: { kind: 'empty' }, description: 'nothing' },
      errorStatuses: [],
    });

    const drift = findSpecDrift(shippedRouteMethods(realRouteSources()), [
      ...V1_OPERATIONS,
      orphan,
    ]);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.rule).toBe('operation-without-route');
    expect(drift[0]?.subject).toBe('GET /api/v1/widgets');
    expect(drift[0]?.detail).toContain('listWidgets');
  });

  it('a PERMISSION mismatch fails too — the document may not lie about a permission', () => {
    const real = findV1Operation('GET', '/api/v1/work-items/{key}');
    expect(real).toBeDefined();
    const widened: V1Operation = { ...real!, permission: 'work_item:edit' };
    const operations = V1_OPERATIONS.map((op) => (op === real ? widened : op));

    const drift = findSpecDrift(shippedRouteMethods(realRouteSources()), operations);
    expect(drift.map((d) => d.rule)).toEqual(['permission-mismatch']);
    expect(drift[0]?.detail).toContain('work_item:edit');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Drift 3 — a real response against its declared schema
// ─────────────────────────────────────────────────────────────────────────────

/** What one driven operation produced. */
interface Driven {
  operationId: string;
  status: number;
  body: unknown;
}

describe('every operation’s REAL response validates against its declared schema', () => {
  let caller: V1ProjectCaller;
  const driven = new Map<string, Driven>();

  /** Call a route handler the way Next.js does, and record what came back. */
  async function drive(
    operationId: string,
    load: () => Promise<Record<string, unknown>>,
    request: Request,
    params: Record<string, string> = {},
  ): Promise<Driven> {
    const operation = V1_OPERATIONS.find((op) => op.operationId === operationId);
    expect(operation, `no operation named ${operationId}`).toBeDefined();

    const mod = await load();
    const handler = mod[operation!.method] as (
      req: Request,
      args?: { params: Promise<Record<string, string>> },
    ) => Promise<Response>;
    const res = await handler(request, { params: Promise.resolve(params) });

    const status = res.status;
    const body: unknown = status === 204 ? undefined : await res.json();
    const record = { operationId, status, body };
    driven.set(operationId, record);
    return record;
  }

  /**
   * Call a route WITHOUT recording it as a driven operation — for the calls that
   * SET UP another operation's preconditions rather than being the thing under
   * test. Recording them would be wrong twice: an operation would be marked
   * exercised by a request made for a different purpose, and a second record for
   * an already-driven id would overwrite the one that matters.
   */
  async function handlerFor(
    load: () => Promise<Record<string, unknown>>,
    method: string,
    request: Request,
    params: Record<string, string> = {},
  ): Promise<Response> {
    const mod = await load();
    const handler = mod[method] as (
      req: Request,
      args?: { params: Promise<Record<string, string>> },
    ) => Promise<Response>;
    return handler(request, { params: Promise.resolve(params) });
  }

  function get(path: string): Request {
    return new Request(`${ORIGIN}${path}`, { headers: caller.headers });
  }

  function send(path: string, method: string, body?: unknown): Request {
    return new Request(`${ORIGIN}${path}`, {
      method,
      headers: { ...caller.headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /**
   * A `multipart/form-data` request carrying one file part — the only
   * non-JSON body in the v1 surface (MOTIR-3057).
   *
   * The content-type header is deliberately NOT set: `FormData` makes the
   * runtime write it, boundary and all, and a hand-written one would not match
   * the body it labels.
   */
  function upload(path: string, filename: string, type: string, bytes: string): Request {
    const form = new FormData();
    form.set('file', new File([bytes], filename, { type }));
    return new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: caller.headers,
      body: form,
    });
  }

  /** Create a work item through the REAL route, returning its key. */
  async function createItem(title: string): Promise<string> {
    const { POST } = await import('@/app/api/v1/projects/[projectKey]/work-items/route');
    const res = await POST(
      send(`/api/v1/projects/${caller.projectKey}/work-items`, 'POST', { kind: 'task', title }),
      { params: Promise.resolve({ projectKey: caller.projectKey }) },
    );
    expect(res.status, `seeding "${title}"`).toBe(201);
    return ((await res.json()) as { key: string }).key;
  }

  beforeAll(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    // The legacy five, PLUS the one key no legacy scope can confer.
    //
    // ⚠️ THE `permissions` ARM IS WHY THIS IS SPELLED OUT (MOTIR-3188). The
    // fixture's `scopes` arm expands through `LEGACY_SCOPE_PERMISSIONS`, and the
    // whole point of driving the suite that way is that it exercises the
    // compatibility promise on every run. But `approveWorkItemPlan` is gated by
    // `ai:decide_plan`, which NO legacy scope expands to — deliberately: that key
    // gates plan APPROVAL, whose only token entrance was created in 2026, long
    // after those six strings stopped being written, and a legacy row may never
    // WIDEN access (`docs/decisions/token-permissions.md` §5, amended).
    //
    // So the caller is expressed in the modern vocabulary: the legacy five
    // expanded through the shipped map — so the compatibility path is still
    // exercised and every other operation's grant is byte-identical to before —
    // plus the one key added by name. Handing it `DEFAULT_TOKEN_GRANT` instead
    // would have been shorter and wrong: that set omits `work_item:delete`, which
    // `work_items:archive` confers and this suite's archive/delete operations
    // need.
    //
    // ⚠️ AND THE PREVIOUS GREEN WAS ITSELF THE BUG. Until this change the route
    // was gated on `ai:view_plan`, which `work_items:write` DOES expand to — so a
    // legacy-scoped token could approve a proposed subtree into somebody's tree,
    // and this guard passed because of it. The 403 that replaced it is the fix
    // reporting itself.
    caller = await createV1ProjectCaller({
      permissions: [
        ...new Set(
          (
            [
              'read',
              'work_items:write',
              'work_items:archive',
              'sprints:write',
              'integration',
            ] as const
          ).flatMap((s) => LEGACY_SCOPE_PERMISSIONS[s]),
        ),
        'ai:decide_plan',
        // The page resource (MOTIR-9493) — no legacy scope expands to a page key.
        'page:view',
        'page:edit',
      ],
    });
    const pk = caller.projectKey;

    // ── Identity + discovery ────────────────────────────────────────────────
    await drive('getMe', () => import('@/app/api/v1/me/route'), get('/api/v1/me'));
    await drive(
      'getSectionSets',
      () => import('@/app/api/v1/section-sets/route'),
      get('/api/v1/section-sets'),
    );
    await drive(
      'listWorkspaces',
      () => import('@/app/api/v1/workspaces/route'),
      get('/api/v1/workspaces'),
    );
    await drive(
      'listProjects',
      () => import('@/app/api/v1/projects/route'),
      get('/api/v1/projects'),
    );
    await drive(
      'getProject',
      () => import('@/app/api/v1/projects/[projectKey]/route'),
      get(`/api/v1/projects/${pk}`),
      { projectKey: pk },
    );

    // ── Work items ──────────────────────────────────────────────────────────
    // ⚠️ Seeded through the REAL create route, NOT `createTestWorkItem`. That
    // fixture writes a zero-padded `position` ("000001"), which is not a valid
    // fractional-index key, so the next TOP-LEVEL create in the same project
    // fails in `keyForAppend` with `invalid order key head: 0` and surfaces as a
    // bare 500. `scripts/plan-seed/seed.ts` already carries that warning in
    // prose; the fixture does not. Filed as MOTIR-2196 — this suite simply does
    // not depend on it.
    const created = await drive(
      'createWorkItem',
      () => import('@/app/api/v1/projects/[projectKey]/work-items/route'),
      send(`/api/v1/projects/${pk}/work-items`, 'POST', {
        kind: 'story',
        title: 'A story',
        obsolescenceNoteMd: 'Kept for the drift guard.',
      }),
      { projectKey: pk },
    );
    const key = (created.body as { key: string }).key;
    // MARKED (MOTIR-6581), so the reads below — the collection row, the detail and
    // the dispatch prompt — validate a NON-null obsolescence against the `$ref`'d
    // `WorkItemObsolescence` component, not only the `null` branch. Seeded as a
    // LEGACY row: no door marks an unfinished card since MOTIR-6672, and this one
    // must stay open for the transition below, which clears the mark first.
    await adminDb.workItem.updateMany({
      where: { identifier: key },
      data: { obsolescence: 'outdated' },
    });
    // A second item, so the link endpoints have both endpoints to name.
    const otherKey = await createItem('Another');

    await drive(
      'listProjectWorkItems',
      () => import('@/app/api/v1/projects/[projectKey]/work-items/route'),
      get(`/api/v1/projects/${pk}/work-items`),
      { projectKey: pk },
    );
    // The COUNT, driven beside the collection it counts (ADR Amendment 14).
    await drive(
      'countProjectWorkItems',
      () => import('@/app/api/v1/projects/[projectKey]/work-items/count/route'),
      get(`/api/v1/projects/${pk}/work-items/count`),
      { projectKey: pk },
    );
    await drive(
      'getWorkItem',
      () => import('@/app/api/v1/work-items/[key]/route'),
      get(`/api/v1/work-items/${key}`),
      { key },
    );
    // The work-loop read (Story 11.7). Driven HERE, beside the detail read, so
    // the assembled prompt is validated against its declared schema on a real
    // item rather than on a fixture.
    await drive(
      'getWorkItemDispatchPrompt',
      () => import('@/app/api/v1/work-items/[key]/dispatch-prompt/route'),
      get(`/api/v1/work-items/${key}/dispatch-prompt`),
      { key },
    );
    await drive(
      'updateWorkItem',
      () => import('@/app/api/v1/work-items/[key]/route'),
      // Clears the legacy mark too: a marked card cannot be reopened (MOTIR-6672),
      // and the transition below moves this one to in_progress.
      send(`/api/v1/work-items/${key}`, 'PATCH', { title: 'A story, renamed', obsolescence: null }),
      { key },
    );
    await drive(
      'listWorkItemTransitions',
      () => import('@/app/api/v1/work-items/[key]/transitions/route'),
      get(`/api/v1/work-items/${key}/transitions`),
      { key },
    );
    await drive(
      'transitionWorkItem',
      () => import('@/app/api/v1/work-items/[key]/transitions/route'),
      send(`/api/v1/work-items/${key}/transitions`, 'POST', { status: 'in_progress' }),
      { key },
    );
    await drive(
      'listWorkItemLinks',
      () => import('@/app/api/v1/work-items/[key]/links/route'),
      get(`/api/v1/work-items/${key}/links`),
      { key },
    );
    await drive(
      'createWorkItemLink',
      () => import('@/app/api/v1/work-items/[key]/links/route'),
      // `superseded_by` (MOTIR-6580) — the newest relationship member, driven so
      // its request AND the echoed response are validated against the spec.
      send(`/api/v1/work-items/${key}/links`, 'POST', {
        toKey: otherKey,
        relationship: 'superseded_by',
      }),
      { key },
    );
    await drive(
      'deleteWorkItemLink',
      () => import('@/app/api/v1/work-items/[key]/links/route'),
      send(
        `/api/v1/work-items/${key}/links?toKey=${otherKey}&relationship=superseded_by`,
        'DELETE',
      ),
      { key },
    );
    // MOTIR-5048 — the delivery LINK. Its one precondition is a repository
    // CONNECTED to the workspace, which is a different thing from the project's
    // repo-SET row added below: the link resolves `owner/name` against the
    // installation mirror, so a proposed set row would not satisfy it.
    // `connectAndLinkRepo` writes the installation and the established row
    // together, which is what the fixture exists for.
    const { repoRef } = await connectAndLinkRepo(caller.fixture);
    await drive(
      'linkWorkItemPullRequest',
      () => import('@/app/api/v1/work-items/[key]/pull-requests/route'),
      send(`/api/v1/work-items/${key}/pull-requests`, 'POST', {
        repository: repoRef,
        number: 4242,
        headRef: 'subtask/drift-guard',
        baseRef: 'main',
      }),
      { key },
    );
    await drive(
      'createWorkItemComment',
      () => import('@/app/api/v1/work-items/[key]/comments/route'),
      send(`/api/v1/work-items/${key}/comments`, 'POST', { bodyMd: 'A comment.' }),
      { key },
    );
    await drive(
      'uploadWorkItemAttachment',
      () => import('@/app/api/v1/work-items/[key]/attachments/route'),
      upload(`/api/v1/work-items/${key}/attachments`, 'findings.png', 'image/png', 'PNGBYTES'),
      { key },
    );
    await drive(
      'listWorkItemComments',
      () => import('@/app/api/v1/work-items/[key]/comments/route'),
      get(`/api/v1/work-items/${key}/comments`),
      { key },
    );

    // ── Designs (Story MOTIR-5553) ──────────────────────────────────────────
    // Driven on a card with NO design blocker and on a card that is not a
    // design card, so the responses validate the NOT-approved arm of the
    // verdict — which is the shape most likely to drift, because it is the one
    // an agent meets when something is wrong.
    await drive(
      'listWorkItemDesigns',
      () => import('@/app/api/v1/work-items/[key]/designs/route'),
      get(`/api/v1/work-items/${key}/designs`),
      { key },
    );
    await drive(
      'getWorkItemDesign',
      () => import('@/app/api/v1/work-items/[key]/design/route'),
      get(`/api/v1/work-items/${key}/design`),
      { key },
    );
    await drive(
      'listProjectDesigns',
      () => import('@/app/api/v1/projects/[projectKey]/designs/route'),
      get(`/api/v1/projects/${pk}/designs`),
      { projectKey: pk },
    );

    // ── The approval-gate read (Bug MOTIR-6191) ─────────────────────────────
    // Driven on a card with NO gate of the kind asked for, so what validates is
    // the `gate: null` arm — an ANSWER rather than a 404, and the arm most
    // likely to drift because it is the one an agent meets when the question it
    // is asking about was never raised.
    await drive(
      'getWorkItemApprovalGate',
      () => import('@/app/api/v1/work-items/[key]/approval-gate/route'),
      get(`/api/v1/work-items/${key}/approval-gate?kind=decision_approval`),
      { key },
    );

    // ── Planning ────────────────────────────────────────────────────────────
    await drive(
      'getProjectBacklog',
      () => import('@/app/api/v1/projects/[projectKey]/backlog/route'),
      get(`/api/v1/projects/${pk}/backlog`),
      { projectKey: pk },
    );
    await drive(
      'getProjectReadyLeaves',
      () => import('@/app/api/v1/projects/[projectKey]/ready/leaves/route'),
      get(`/api/v1/projects/${pk}/ready/leaves`),
      { projectKey: pk },
    );
    await drive(
      'getProjectReadyContainers',
      () => import('@/app/api/v1/projects/[projectKey]/ready/containers/route'),
      get(`/api/v1/projects/${pk}/ready/containers`),
      { projectKey: pk },
    );
    await drive(
      'getProjectReadyBugs',
      () => import('@/app/api/v1/projects/[projectKey]/ready/bugs/route'),
      get(`/api/v1/projects/${pk}/ready/bugs`),
      { projectKey: pk },
    );
    await drive(
      'listProjectSprints',
      () => import('@/app/api/v1/projects/[projectKey]/sprints/route'),
      get(`/api/v1/projects/${pk}/sprints`),
      { projectKey: pk },
    );
    // The repository SET (MOTIR-3586). Seeded as an UNESTABLISHED row on
    // purpose: every coordinate on the resource is nullable, and a row with a
    // realized repository would satisfy a declaration that forgot to say so
    // while this one cannot. The non-null half is asserted in
    // `project-repositories-route.test.ts`, which owns the endpoint.
    await projectRepoSetService.addRow(
      caller.fixture.projectId,
      { role: 'web', name: 'acme-web' },
      caller.fixture.ctx,
    );
    await drive(
      'listProjectRepositories',
      () => import('@/app/api/v1/projects/[projectKey]/repositories/route'),
      get(`/api/v1/projects/${pk}/repositories`),
      { projectKey: pk },
    );
    const sprint = await drive(
      'createSprint',
      () => import('@/app/api/v1/projects/[projectKey]/sprints/route'),
      send(`/api/v1/projects/${pk}/sprints`, 'POST', { name: 'Sprint 1' }),
      { projectKey: pk },
    );
    const sprintId = (sprint.body as { id: string }).id;

    await drive(
      'getSprint',
      () => import('@/app/api/v1/sprints/[sprintId]/route'),
      get(`/api/v1/sprints/${sprintId}`),
      { sprintId },
    );
    await drive(
      'updateSprint',
      () => import('@/app/api/v1/sprints/[sprintId]/route'),
      send(`/api/v1/sprints/${sprintId}`, 'PATCH', { goal: 'Ship the spec.' }),
      { sprintId },
    );
    await drive(
      'moveWorkItemsToSprint',
      () => import('@/app/api/v1/sprints/[sprintId]/work-items/route'),
      send(`/api/v1/sprints/${sprintId}/work-items`, 'POST', { workItemKeys: [otherKey] }),
      { sprintId },
    );
    await drive(
      'listSprintWorkItems',
      () => import('@/app/api/v1/sprints/[sprintId]/work-items/route'),
      get(`/api/v1/sprints/${sprintId}/work-items`),
      { sprintId },
    );
    await drive(
      'moveWorkItemsToBacklog',
      () => import('@/app/api/v1/projects/[projectKey]/backlog/work-items/route'),
      send(`/api/v1/projects/${pk}/backlog/work-items`, 'POST', { workItemKeys: [otherKey] }),
      { projectKey: pk },
    );
    // Start before complete: `completeSprint` needs an ACTIVE sprint, and the
    // ordering is the real lifecycle rather than a test convenience.
    await drive(
      'startSprint',
      () => import('@/app/api/v1/sprints/[sprintId]/start/route'),
      send(`/api/v1/sprints/${sprintId}/start`, 'POST', {}),
      { sprintId },
    );
    await drive(
      'completeSprint',
      () => import('@/app/api/v1/sprints/[sprintId]/complete/route'),
      send(`/api/v1/sprints/${sprintId}/complete`, 'POST', {}),
      { sprintId },
    );

    // ── Archive LAST, so every read above ran against a live item ───────────
    await drive(
      'archiveWorkItem',
      () => import('@/app/api/v1/work-items/[key]/archive/route'),
      send(`/api/v1/work-items/${key}/archive`, 'POST'),
      { key },
    );
    await drive(
      'restoreWorkItem',
      () => import('@/app/api/v1/work-items/[key]/restore/route'),
      send(`/api/v1/work-items/${key}/restore`, 'POST'),
      { key },
    );

    // ── The keyed CLAIM (MOTIR-2961) ────────────────────────────────────────
    // On its OWN item, and deliberately not the shared one: a claim moves the
    // card to `in_progress` and assigns it, which would change the state the
    // drives above asserted against.
    const claimable = await createItem('An item to claim');
    await drive(
      'claimWorkItem',
      () => import('@/app/api/v1/work-items/[key]/claim/route'),
      send(`/api/v1/work-items/${claimable}/claim`, 'POST'),
      { key: claimable },
    );

    // ── The REPAIR claim (MOTIR-5464) ───────────────────────────────────────
    // On its OWN item. A to-do card is refused as `not_repairable` — a 200 in the
    // SAME declared shape as a claim, which is what this guard checks; the
    // claimed arm is parsed against the schema in `work-item-repair-route.test.ts`.
    const repairable = await createItem('An item nobody may repair yet');
    await drive(
      'claimWorkItemRepair',
      () => import('@/app/api/v1/work-items/[key]/repair/route'),
      send(`/api/v1/work-items/${repairable}/repair`, 'POST'),
      { key: repairable },
    );

    // ── The CONTINUE claim (MOTIR-6532) ─────────────────────────────────────
    // On its OWN never-run item: refused `not_continuable` — a 200 in the SAME
    // declared shape as a claim; the claimed arm is `claimWorkItemContinue.test.ts`'s.
    const continuable = await createItem('An item with no dead run');
    await drive(
      'claimWorkItemContinue',
      () => import('@/app/api/v1/work-items/[key]/continue/route'),
      send(`/api/v1/work-items/${continuable}/continue`, 'POST'),
      { key: continuable },
    );

    // ── The SCOPE claim (MOTIR-3049) ────────────────────────────────────────
    // On its OWN container, for the same reason the keyed claim above takes its
    // own item: a scope claim moves EVERY member to `in_progress` and assigns
    // them, which would change the state the drives above asserted against.
    const scopeRoot = await createItem('A container to claim as a scope');
    await drive(
      'claimScope',
      () => import('@/app/api/v1/scope-claims/route'),
      send('/api/v1/scope-claims', 'POST', { kind: 'work_item', key: scopeRoot }),
    );

    // ── HOW TO TEST (Story MOTIR-4906 · MOTIR-5358) ───────────────────────────
    // On an item no run has published to: `record: null` is the answer shape a
    // CLI most often reads, and it still has to parse.
    //
    // ⚠️ THE WINDOW IS RESET HERE. This suite drives every operation through ONE
    // token inside one rate-limit window, and the operation count has reached
    // the per-window budget: without a reset, the LAST drive (the activity read)
    // answers 429 and fails a schema check it has nothing to do with. What this
    // file asserts is response SHAPES, not the limiter, which has its own suite.
    resetRateLimitStore();
    const howToTestItem = await createItem('An item nobody wrote How to test for');
    await drive(
      'getWorkItemHowToTest',
      () => import('@/app/api/v1/work-items/[key]/how-to-test/route'),
      send(`/api/v1/work-items/${howToTestItem}/how-to-test`, 'GET'),
      { key: howToTestItem },
    );

    // ── The DISPATCH RUN ingest (Story MOTIR-1789 · MOTIR-1792) ────────────
    // All three in ORDER on ONE run, because they are a lifecycle rather than
    // three independent endpoints: the append needs an open run and the close
    // needs an un-closed one. The card they name is its OWN item — the open
    // records the SET but moves no status, so it could safely share, and giving
    // it its own leaves the run page's fixture legible to whoever reads this next.
    const runCard = await createItem('An item a dispatch run owns');
    const opened = await drive(
      'openDispatchRun',
      () => import('@/app/api/v1/dispatch-runs/route'),
      send('/api/v1/dispatch-runs', 'POST', {
        projectKey: caller.projectKey,
        command: 'run_scope',
        agent: 'claude',
        model: 'claude-opus-5',
        idempotencyKey: 'drift-guard-run-1',
        // A SCOPE, so the close-out prompt below has a run target (MOTIR-5357).
        scopeKey: runCard,
        cards: [{ key: runCard, disposition: 'queued' }],
      }),
    );
    const runId = (opened.body as { run: { id: string } }).run.id;

    await drive(
      'appendDispatchRunEvents',
      () => import('@/app/api/v1/dispatch-runs/[id]/events/route'),
      send(`/api/v1/dispatch-runs/${runId}/events`, 'POST', {
        events: [
          { kind: 'run_opened', data: { command: 'run_scope' } },
          { kind: 'card_claimed', workItemKey: runCard, disposition: 'running' },
        ],
      }),
      { id: runId },
    );

    // The READ a CLI adopting a server-opened hosted run makes (MOTIR-6558).
    await drive(
      'getDispatchRun',
      () => import('@/app/api/v1/dispatch-runs/[id]/route'),
      send(`/api/v1/dispatch-runs/${runId}`, 'GET'),
      { id: runId },
    );

    await drive(
      'getDispatchRunCloseOutPrompt',
      () => import('@/app/api/v1/dispatch-runs/[id]/close-out-prompt/route'),
      send(`/api/v1/dispatch-runs/${runId}/close-out-prompt`, 'GET'),
      { id: runId },
    );

    // The RUN-FOUND REPORT (MOTIR-8698) — the run's leg on `runCard` is open (the
    // append above claimed it). No plan shaped the card, so it is recorded on the
    // leg and nothing is filed; the answer is the acknowledgement either way.
    await drive(
      'reportDispatchRunUnbuildable',
      () => import('@/app/api/v1/dispatch-runs/[id]/unbuildable/route'),
      send(`/api/v1/dispatch-runs/${runId}/unbuildable`, 'POST', {
        targetKey: runCard,
        reason: 'The card names a table that does not exist.',
      }),
      { id: runId },
    );

    // The run's DISCREPANCY record and its STOP report (MOTIR-8722), on the same open leg.
    // The STOP leaves the card where it is (`toPlanning: false`), so the steps after it
    // drive the run unchanged.
    await drive(
      'recordDispatchRunDiscrepancy',
      () => import('@/app/api/v1/dispatch-runs/[id]/discrepancy/route'),
      send(`/api/v1/dispatch-runs/${runId}/discrepancy`, 'POST', {
        key: runCard,
        points: [{ planAsked: 'Edit a.ts', built: 'Edited b.ts', why: 'a.ts does not exist' }],
      }),
      { id: runId },
    );
    await drive(
      'reportDispatchRunStop',
      () => import('@/app/api/v1/dispatch-runs/[id]/stop/route'),
      send(`/api/v1/dispatch-runs/${runId}/stop`, 'POST', {
        key: runCard,
        comment: 'The card names a table that does not exist.',
        toPlanning: false,
      }),
      { id: runId },
    );

    // The HEARTBEAT (MOTIR-6528) — before the close, while the run is open: 204.
    await drive(
      'heartbeatDispatchRun',
      () => import('@/app/api/v1/dispatch-runs/[id]/heartbeat/route'),
      send(`/api/v1/dispatch-runs/${runId}/heartbeat`, 'POST'),
      { id: runId },
    );

    await drive(
      'closeDispatchRun',
      () => import('@/app/api/v1/dispatch-runs/[id]/close/route'),
      send(`/api/v1/dispatch-runs/${runId}/close`, 'POST', { stopReason: 'completed' }),
      { id: runId },
    );

    // ── A hosted run's git credentials (MOTIR-6538) ─────────────────────────
    // Driven with the run's OWN credential — the only caller the route answers —
    // on a hosted run over the project's connected repository (`acme/web`, linked
    // above). GitHub is stubbed at the HTTP seam for this one drive; nothing
    // reaches github.com, and the stubs are removed straight after.
    const hostedCard = await createItem('An item a hosted run builds');
    const hostedOpen = await handlerFor(
      () => import('@/app/api/v1/dispatch-runs/route'),
      'POST',
      send('/api/v1/dispatch-runs', 'POST', {
        projectKey: caller.projectKey,
        command: 'run',
        origin: 'hosted',
        idempotencyKey: 'drift-guard-hosted-1',
        cards: [{ key: hostedCard, disposition: 'queued' }],
      }),
    );
    expect(hostedOpen.status, 'seeding the hosted run').toBe(201);
    const hostedRunId = ((await hostedOpen.json()) as { run: { id: string } }).run.id;
    const { token: runToken } = await runCredentialService.mintRunCredential({
      dispatchRunId: hostedRunId,
      dispatcherUserId: caller.fixture.owner.id,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs1', format: 'pem' })
      .toString();
    vi.stubEnv('GITHUB_APP_ID', '222');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', pem);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? 'GET';
        const json = (status: number, payload: unknown) =>
          new Response(JSON.stringify(payload), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        if (/\/repos\/acme\/web\/installation$/.test(url) && method === 'GET') {
          return json(200, {
            id: 42,
            account: { login: 'acme' },
            permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
            suspended_at: null,
            html_url: 'https://github.com/organizations/acme/settings/installations/42',
          });
        }
        if (/\/app\/installations\/42\/access_tokens$/.test(url) && method === 'POST') {
          return json(201, {
            token: 'ghs_drift_guard',
            expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          });
        }
        if (url.endsWith('/app') && method === 'GET')
          return json(200, { slug: 'motir-integration' });
        if (/\/users\/.+$/.test(url) && method === 'GET') {
          return json(200, { id: 2002, login: 'motir-integration[bot]' });
        }
        throw new Error(`unexpected fetch in the drift guard: ${method} ${url}`);
      }),
    );
    try {
      await drive(
        'issueDispatchRunGitCredentials',
        () => import('@/app/api/v1/dispatch-runs/[id]/git-credential/route'),
        new Request(`${ORIGIN}/api/v1/dispatch-runs/${hostedRunId}/git-credential`, {
          method: 'POST',
          headers: { authorization: `Bearer ${runToken}` },
        }),
        { id: hostedRunId },
      );
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }

    // ── A hosted REVIEW run's prompt and verdict (MOTIR-6821) ───────────────
    // Driven with a `review` run's OWN credential — the only caller either route answers
    // — over a card holding an awaiting `agent_review` gate at its delivery set's version.
    // The gate is SEEDED rather than raised by a green verdict: the raise is MOTIR-6819's
    // and has its own suite; here only the two responses' shapes are under test. The
    // verdict is `changes_requested` so its decision has no merge-side effect to settle.
    const reviewCard = await createItem('An item a review run reviews');
    {
      const res = await handlerFor(
        () => import('@/app/api/v1/work-items/[key]/pull-requests/route'),
        'POST',
        send(`/api/v1/work-items/${reviewCard}/pull-requests`, 'POST', {
          repository: repoRef,
          number: 4343,
          headRef: 'subtask/drift-guard-review',
          baseRef: 'main',
        }),
        { key: reviewCard },
      );
      expect(res.status, 'seeding the reviewed pull request').toBe(200);
    }
    const reviewItem = await adminDb.workItem.findFirstOrThrow({
      where: { identifier: reviewCard, projectId: caller.fixture.projectId },
    });
    const reviewedPr = await adminDb.githubPullRequest.findFirstOrThrow({
      where: { number: 4343, deliveries: { some: { workItemId: reviewItem.id } } },
    });
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: reviewedPr.id,
        commitSha: 'drift-review-head',
        checkName: 'ci',
        conclusion: 'success',
      },
    });
    const reviewedVersion = `${repoRef}#4343@drift-review-head`;
    await adminDb.approvalGate.create({
      data: {
        workspaceId: caller.fixture.workspace.id,
        projectId: caller.fixture.projectId,
        workItemId: reviewItem.id,
        kind: 'agent_review',
        subjectId: reviewItem.id,
        subjectVersion: reviewedVersion,
        routedToId: caller.fixture.owner.id,
      },
    });
    const reviewRun = await adminDb.dispatchRun.create({
      data: {
        workspaceId: caller.fixture.workspace.id,
        projectId: caller.fixture.projectId,
        command: 'review',
        origin: 'hosted',
        createdById: caller.fixture.owner.id,
        cards: {
          create: [
            {
              workspaceId: caller.fixture.workspace.id,
              workItemId: reviewItem.id,
              workItemKey: reviewCard,
              position: 0,
            },
          ],
        },
      },
    });
    const { token: reviewToken } = await runCredentialService.mintRunCredential({
      dispatchRunId: reviewRun.id,
      dispatcherUserId: caller.fixture.owner.id,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    await drive(
      'getWorkItemReviewPrompt',
      () => import('@/app/api/v1/work-items/[key]/review-prompt/route'),
      new Request(`${ORIGIN}/api/v1/work-items/${reviewCard}/review-prompt`, {
        headers: { authorization: `Bearer ${reviewToken}` },
      }),
      { key: reviewCard },
    );
    await drive(
      'submitWorkItemAgentReview',
      () => import('@/app/api/v1/work-items/[key]/agent-review/route'),
      new Request(`${ORIGIN}/api/v1/work-items/${reviewCard}/agent-review`, {
        method: 'POST',
        headers: { authorization: `Bearer ${reviewToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          subjectVersion: reviewedVersion,
          verdict: 'changes_requested',
          summaryMd: 'One criterion is unmet.',
          findingsMd: '- `a.ts:1` — breaks the first criterion; change it.',
        }),
      }),
      { key: reviewCard },
    );

    // ── Session close-out (Story 11.7) ──────────────────────────────────────
    // On a DEDICATED item, and last: `recordWorkItemIntegration` moves it to
    // `in_review` and `completeSession` then closes it, so driving them on the
    // item every other operation shares would change the state those drives
    // asserted against.
    const closing = await createItem('An item to integrate');
    {
      const { POST } = await import('@/app/api/v1/work-items/[key]/transitions/route');
      const res = await POST(
        send(`/api/v1/work-items/${closing}/transitions`, 'POST', { status: 'in_progress' }),
        { params: Promise.resolve({ key: closing }) },
      );
      expect(res.status, 'seeding the integration item').toBe(200);
    }
    // BEFORE the integration drive, deliberately: this operation records
    // provenance and asserts nothing about state (MOTIR-2421), so it neither
    // needs the item integrated nor disturbs what the next drive asserts.
    await drive(
      'reportWorkItemImplementation',
      () => import('@/app/api/v1/work-items/[key]/implementation/route'),
      send(`/api/v1/work-items/${closing}/implementation`, 'POST', {
        implementationSource: 'byok',
        implementationHarness: 'claude',
      }),
      { key: closing },
    );
    await drive(
      'recordWorkItemIntegration',
      () => import('@/app/api/v1/work-items/[key]/integration/route'),
      send(`/api/v1/work-items/${closing}/integration`, 'POST', {
        sessionBranch: 'session/drift-guard',
      }),
      { key: closing },
    );
    await drive(
      'completeSession',
      () => import('@/app/api/v1/sessions/complete/route'),
      send('/api/v1/sessions/complete', 'POST', { sessionBranch: 'session/drift-guard' }),
    );

    // ── Expansion + the two plan reads (Story 11.7) ─────────────────────────
    // The submit is driven on the STORY (a container — a leaf cannot be
    // expanded) and its `planId` addresses both reads, so all three validate
    // against one real chain rather than three fixtures.
    const submitted = await drive(
      'submitWorkItemExpansion',
      () => import('@/app/api/v1/work-items/[key]/expansions/route'),
      send(`/api/v1/work-items/${key}/expansions`, 'POST'),
      { key },
    );
    const planId = (submitted.body as { planId: string }).planId;
    await drive(
      'getPlanStatus',
      () => import('@/app/api/v1/plans/[planId]/status/route'),
      get(`/api/v1/plans/${planId}/status`),
      { planId },
    );
    await drive(
      'getPlan',
      () => import('@/app/api/v1/plans/[planId]/route'),
      get(`/api/v1/plans/${planId}`),
      { planId },
    );

    // ── The planning conversation (Story 11.7) ──────────────────────────────
    // Ordered: open, append (a submit on an empty thread is refused), submit.
    await drive(
      'openPlanSession',
      () => import('@/app/api/v1/projects/[projectKey]/plan-session/route'),
      send(`/api/v1/projects/${pk}/plan-session`, 'POST', {}),
      { projectKey: pk },
    );
    await drive(
      'appendPlanTurn',
      () => import('@/app/api/v1/projects/[projectKey]/plan-session/turns/route'),
      send(`/api/v1/projects/${pk}/plan-session/turns`, 'POST', {
        body: 'keep every leaf under three points',
      }),
      { projectKey: pk },
    );
    await drive(
      'submitPlanSession',
      () => import('@/app/api/v1/projects/[projectKey]/plan-session/submissions/route'),
      send(`/api/v1/projects/${pk}/plan-session/submissions`, 'POST', {}),
      { projectKey: pk },
    );

    // ── Automatic plan approval (MOTIR-3021) ────────────────────────────────
    // DRIVEN, not excused. It needs a shape the project-wide thread above does
    // not have: the endpoint only approves a plan ANCHORED to the card it is
    // approving for, so this opens a SECOND, anchored conversation on `key` and
    // submits it. The plan then has to reach `planned` — the route approves a
    // decided plan, and only a planner's appends close one — so the two service
    // calls that a real planner's job would make are made here directly. Both
    // are seeding; the ROUTE and its response are entirely real.
    const anchored = { targetKeys: [key] };
    await handlerFor(
      () => import('@/app/api/v1/projects/[projectKey]/plan-session/turns/route'),
      'POST',
      send(`/api/v1/projects/${pk}/plan-session/turns`, 'POST', {
        body: 'this card cannot be built as written',
        ...anchored,
      }),
      { projectKey: pk },
    );
    const anchoredSubmit = await handlerFor(
      () => import('@/app/api/v1/projects/[projectKey]/plan-session/submissions/route'),
      'POST',
      send(`/api/v1/projects/${pk}/plan-session/submissions`, 'POST', anchored),
      { projectKey: pk },
    );
    // The plan id is read HERE only to seed it into `planned` — the route itself
    // never takes one, which is the point of addressing by the card.
    const anchoredPlanId = ((await anchoredSubmit.json()) as { planId: string }).planId;
    await plansService.addProposals(
      anchoredPlanId,
      [{ op: 'add', proposedFields: { title: 'the corrected card', kind: 'task' } }],
      caller.ctx,
    );
    await plansService.markPlanned(anchoredPlanId, caller.ctx);
    // MOTIR-4085 — the READ comes first, because it is what a caller does first:
    // look at the plan, decide whether it may be approved unattended, and only
    // then POST. Driven on the SAME card, so the two really do resolve one plan.
    await drive(
      'getWorkItemPlan',
      () => import('@/app/api/v1/work-items/[key]/plan-approval/route'),
      get(`/api/v1/work-items/${key}/plan-approval`),
      { key },
    );
    await drive(
      'approveWorkItemPlan',
      () => import('@/app/api/v1/work-items/[key]/plan-approval/route'),
      send(`/api/v1/work-items/${key}/plan-approval`, 'POST'),
      { key },
    );

    // ── The folder resource (Story MOTIR-5310 · MOTIR-5408) ──────────────────
    // Create two, list the root, read and rename one, then delete the other —
    // each response validated against its declaration below.
    const folder = await drive(
      'createFolder',
      () => import('@/app/api/v1/projects/[projectKey]/folders/route'),
      send(`/api/v1/projects/${pk}/folders`, 'POST', { name: 'Parked' }),
      { projectKey: pk },
    );
    const folderId = (folder.body as { id: string }).id;
    const spare = await handlerFor(
      () => import('@/app/api/v1/projects/[projectKey]/folders/route'),
      'POST',
      send(`/api/v1/projects/${pk}/folders`, 'POST', { name: 'Spare' }),
      { projectKey: pk },
    );
    const spareId = ((await spare.json()) as { id: string }).id;
    await drive(
      'listFolders',
      () => import('@/app/api/v1/projects/[projectKey]/folders/route'),
      get(`/api/v1/projects/${pk}/folders`),
      { projectKey: pk },
    );
    await drive(
      'getFolder',
      () => import('@/app/api/v1/folders/[folderId]/route'),
      get(`/api/v1/folders/${folderId}`),
      { folderId },
    );
    await drive(
      'updateFolder',
      () => import('@/app/api/v1/folders/[folderId]/route'),
      send(`/api/v1/folders/${folderId}`, 'PATCH', { name: 'Parked ideas' }),
      { folderId },
    );
    await drive(
      'deleteFolder',
      () => import('@/app/api/v1/folders/[folderId]/route'),
      send(`/api/v1/folders/${spareId}`, 'DELETE'),
      { folderId: spareId },
    );

    // ── The page resource (Story MOTIR-9486 · MOTIR-9493) ────────────────────
    // Create one in the folder above with a markdown body, read it back, then
    // replace its body at the revision the create returned and move it to the root.
    const page = await drive(
      'createPage',
      () => import('@/app/api/v1/projects/[projectKey]/pages/route'),
      send(`/api/v1/projects/${pk}/pages`, 'POST', {
        title: 'Runbook',
        markdown: '# Runbook\n\nRestart the worker.',
        parent: { kind: 'folder', id: folderId },
      }),
      { projectKey: pk },
    );
    const pageId = (page.body as { id: string }).id;
    await drive(
      'getPage',
      () => import('@/app/api/v1/pages/[pageId]/route'),
      get(`/api/v1/pages/${pageId}`),
      { pageId },
    );
    await drive(
      'updatePage',
      () => import('@/app/api/v1/pages/[pageId]/route'),
      send(`/api/v1/pages/${pageId}`, 'PATCH', {
        markdown: '# Runbook\n\nRestart the worker, then the queue.',
        revision: (page.body as { revision: number }).revision,
      }),
      { pageId },
    );
    await drive(
      'movePage',
      () => import('@/app/api/v1/pages/[pageId]/placement/route'),
      send(`/api/v1/pages/${pageId}/placement`, 'PATCH', { parent: { kind: 'root' } }),
      { pageId },
    );
    await drive(
      'searchPages',
      () => import('@/app/api/v1/projects/[projectKey]/pages/search/route'),
      get(`/api/v1/projects/${pk}/pages/search?q=worker`),
      { projectKey: pk },
    );

    // ── The activity read (Story 11.7) ──────────────────────────────────────
    // Driven on the item that has BOTH a comment and a change trail by now, so
    // the `all` view's union validates against real entries of both types.
    await drive(
      'getWorkItemActivity',
      () => import('@/app/api/v1/work-items/[key]/activity/route'),
      get(`/api/v1/work-items/${key}/activity`),
      { key },
    );
  }, 120_000);

  it('every driven call SUCCEEDED at the status its operation declares', () => {
    // A 4xx would validate against nothing and make the schema checks below
    // vacuous, so the status is asserted before the shape.
    for (const [operationId, record] of driven) {
      const operation = V1_OPERATIONS.find((op) => op.operationId === operationId);
      expect(record.status, `${operationId} → ${JSON.stringify(record.body)}`).toBe(
        operation?.response.status,
      );
    }
  });

  it('DRIFT 3: every real response validates against its declared schema', () => {
    for (const [operationId, record] of driven) {
      const operation = V1_OPERATIONS.find((op) => op.operationId === operationId)!;
      const schema = responseSchemaFor(operation);
      if (schema === undefined) {
        // A 204 declares no body, so the assertion is that there ISN'T one.
        expect(record.body, `${operationId} declares no body`).toBeUndefined();
        continue;
      }
      const parsed = schema.safeParse(record.body);
      expect(
        parsed.success,
        `${operationId}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
      ).toBe(true);
    }
  });

  it('DRIFT 3 FAILS: a declared schema mutated away from the real response', () => {
    // The negative proof. The response is the one the route really returned;
    // only the DECLARATION moves — which is exactly the drift this guards
    // against, since a schema is edited far more often than a route.
    const real = driven.get('getWorkItem');
    expect(real).toBeDefined();

    const mutated = defineOperation({
      ...findV1Operation('GET', '/api/v1/work-items/{key}')!,
      response: {
        status: 200,
        body: {
          kind: 'object',
          schema: workItemDetailSchema.extend({ estimatedVelocity: z.number() }),
        },
        description: 'drifted',
      },
    });

    const parsed = responseSchemaFor(mutated)!.safeParse(real!.body);
    expect(parsed.success).toBe(false);
    // Naming the offending field is the point: "the shape is wrong" sends the
    // next reader to diff two hundred lines by eye.
    expect(parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'))).toContain(
      'estimatedVelocity',
    );
  });

  it('exercised EVERY operation, or excused it with a written reason', () => {
    const unexercised = unexercisedOperations(V1_OPERATIONS, new Set(driven.keys()), UNDRIVABLE);
    expect(unexercised, `operations neither driven nor excused: ${unexercised.join(', ')}`).toEqual(
      [],
    );
  });

  it('carries no STALE excuse for an operation that no longer exists', () => {
    expect(staleUndrivableEntries(V1_OPERATIONS, UNDRIVABLE)).toEqual([]);
  });

  it('would FAIL if an operation were silently skipped', () => {
    // The bookkeeping proven against a violation: drop one from the exercised
    // set with no excuse and the check must name it.
    const short = new Set(driven.keys());
    short.delete('getWorkItem');
    expect(unexercisedOperations(V1_OPERATIONS, short, UNDRIVABLE)).toEqual(['getWorkItem']);
    // …and an excuse with an EMPTY reason is not an excuse.
    expect(unexercisedOperations(V1_OPERATIONS, short, { getWorkItem: '   ' })).toEqual([
      'getWorkItem',
    ]);
    expect(
      unexercisedOperations(V1_OPERATIONS, short, { getWorkItem: 'needs a real browser' }),
    ).toEqual([]);
  });

  it('drove every operation the registry declares — no more, no less', () => {
    expect([...driven.keys()].sort()).toEqual(V1_OPERATIONS.map((op) => op.operationId).sort());
    expect(driven.size).toBe(new Set(V1_OPERATIONS.map(operationKey)).size);
  });
});

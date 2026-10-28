import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';
import type { WorkspaceContext } from '@/lib/workspaces';

import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { truncateAuthTables } from '../../helpers/db';

// The repository-SET HTTP surface the establish step consumes (Story MOTIR-1775 ·
// MOTIR-1782). Real Postgres; every call runs the real route → service →
// repository → Prisma chain. The services' own semantics are covered in
// `projectRepos/*`; what these tests own is the TRANSPORT contract:
//
//   * the session gate (401 with no workspace context),
//   * the wire VALIDATION each route does before the service sees it — a closed
//     vocabulary (`role`, `to`, `direction`) rejected as a 422 naming the field,
//     rather than reaching Prisma as a raw enum error,
//   * the partial-patch forwarding — an absent key is untouched, `label: null`
//     clears,
//   * the typed-error → status mapping (`mapProjectRepoError`), including the
//     no-existence-leak 404 on a cross-workspace key,
//   * the one field the wire may NOT set: `proposalSignal` records what MOTIR
//     inferred, so a client-supplied one must not be attributed to Motir.
//
// Only `getWorkspaceContext` is stubbed — the session+active-workspace resolver
// the test env cannot supply (no cookies). The mock is PARTIAL, so the real
// `withWorkspaceContext` (the RLS-binding transaction) is preserved.

const ctxRef = { current: null as WorkspaceContext | null };

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const { GET, POST: ADD } = await import('@/app/api/projects/[key]/repositories/route');
const { PATCH, DELETE } = await import('@/app/api/projects/[key]/repositories/[rowId]/route');
const { POST: STATE } = await import('@/app/api/projects/[key]/repositories/[rowId]/state/route');
const { POST: MOVE } = await import('@/app/api/projects/[key]/repositories/[rowId]/move/route');
const { POST: ESTABLISH } = await import('@/app/api/projects/[key]/repositories/establish/route');
const { projectRepoSetService } = await import('@/lib/services/projectRepoSetService');

const BASE = 'http://localhost:3000/api/projects';

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function signInAs(fx: WorkItemFixture, userId = fx.ownerId) {
  ctxRef.current = { userId, workspaceId: fx.workspaceId };
}

const keyParams = (key: string) => ({ params: Promise.resolve({ key }) });
const rowParams = (rowId: string) => ({ params: Promise.resolve({ rowId }) });

function json(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('GET /api/projects/[key]/repositories', () => {
  it('401s with no workspace context — the session gate, before anything is read', async () => {
    const res = await GET(new Request(`${BASE}/PROD/repositories`), keyParams('PROD'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED' });
  });

  it('returns the whole step read model — the set plus both GitHub facts', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);

    const res = await GET(
      new Request(`${BASE}/${fx.projectIdentifier}/repositories`),
      keyParams(fx.projectIdentifier),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.set.rows.map((r: { name: string }) => r.name)).toEqual(['acme-web']);
    expect(body.githubLogin).toBeNull();
    expect(body.hasInstallation).toBe(false);
    expect(body.connectCandidates).toEqual([]);
  });

  it('404s on a project in ANOTHER workspace — indistinguishable from one that never existed', async () => {
    const a = await makeWorkItemFixture();
    // A DISTINCT identifier, or the key would resolve to the actor's OWN project
    // and prove nothing: the tenancy claim is that b's key is invisible from a.
    const b = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    signInAs(a);

    const foreign = await GET(
      new Request(`${BASE}/${b.projectIdentifier}/repositories`),
      keyParams(b.projectIdentifier),
    );
    expect(foreign.status).toBe(404);

    // …and a key that never existed reads the same way — same status, same code.
    // (Each message echoes the key the CALLER supplied, which tells them nothing
    // they did not already type.)
    const unknown = await GET(new Request(`${BASE}/NOPE/repositories`), keyParams('NOPE'));
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).code).toBe((await foreign.json()).code);
  });
});

describe('POST /api/projects/[key]/repositories', () => {
  it('appends a row and answers 201 with it', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);

    const res = await ADD(
      json(`${BASE}/${fx.projectIdentifier}/repositories`, 'POST', {
        role: 'api',
        name: 'acme-api',
      }),
      keyParams(fx.projectIdentifier),
    );

    expect(res.status).toBe(201);
    const row = await res.json();
    expect(row).toMatchObject({ role: 'api', name: 'acme-api', state: 'proposed' });
  });

  it('422s on a role outside the closed vocabulary, rather than letting it reach Prisma', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);

    for (const body of [null, {}, { role: 'backend', name: 'x' }]) {
      const res = await ADD(
        json(`${BASE}/${fx.projectIdentifier}/repositories`, 'POST', body),
        keyParams(fx.projectIdentifier),
      );
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('PROJECT_REPO_INVALID_FIELD');
    }
  });

  it('IGNORES a client-supplied proposalSignal — a hand-added row is nobody’s inference', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);

    const res = await ADD(
      json(`${BASE}/${fx.projectIdentifier}/repositories`, 'POST', {
        role: 'web',
        name: 'acme-web',
        proposalSignal: 'plan-item-role',
      }),
      keyParams(fx.projectIdentifier),
    );

    expect((await res.json()).proposalSignal).toBeNull();
  });

  it('409s on a name the set already holds', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme' }, fx.ctx);

    const res = await ADD(
      json(`${BASE}/${fx.projectIdentifier}/repositories`, 'POST', { role: 'api', name: 'ACME' }),
      keyParams(fx.projectIdentifier),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PROJECT_REPO_NAME_TAKEN');
  });

  it('401s with no workspace context', async () => {
    const res = await ADD(
      json(`${BASE}/PROD/repositories`, 'POST', { role: 'web', name: 'x' }),
      keyParams('PROD'),
    );
    expect(res.status).toBe(401);
  });
});

describe('PATCH / DELETE /api/projects/[key]/repositories/[rowId]', () => {
  it('renames a row, leaving every field the patch omits alone', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'old', label: 'billing' },
      fx.ctx,
    );

    const res = await PATCH(
      json(`${BASE}/${fx.projectIdentifier}/repositories/${row.id}`, 'PATCH', { name: 'new' }),
      rowParams(row.id),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'new', role: 'api', label: 'billing' });
  });

  it('forwards `label: null` as an explicit clear, not as an omission', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'a', label: 'billing' },
      fx.ctx,
    );

    const res = await PATCH(
      json(`${BASE}/${fx.projectIdentifier}/repositories/${row.id}`, 'PATCH', { label: null }),
      rowParams(row.id),
    );
    expect((await res.json()).label).toBeNull();
  });

  it('422s on a bad body or an unknown role, 404s on an unknown row, 401s unauthenticated', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);

    const noBody = await PATCH(
      new Request(`${BASE}/PROD/repositories/x`, { method: 'PATCH' }),
      rowParams('x'),
    );
    expect(noBody.status).toBe(422);

    const badRole = await PATCH(
      json(`${BASE}/PROD/repositories/x`, 'PATCH', { role: 'backend' }),
      rowParams('x'),
    );
    expect(badRole.status).toBe(422);

    const missing = await PATCH(
      json(`${BASE}/PROD/repositories/nope`, 'PATCH', { name: 'x' }),
      rowParams('nope'),
    );
    expect(missing.status).toBe(404);

    ctxRef.current = null;
    expect(
      (await PATCH(json(`${BASE}/PROD/repositories/x`, 'PATCH', {}), rowParams('x'))).status,
    ).toBe(401);
  });

  it('removes a row with a 204, and a second remove is still 204 (idempotent)', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'a' },
      fx.ctx,
    );

    expect(
      (
        await DELETE(
          json(`${BASE}/${fx.projectIdentifier}/repositories/${row.id}`, 'DELETE'),
          rowParams(row.id),
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await DELETE(
          json(`${BASE}/${fx.projectIdentifier}/repositories/${row.id}`, 'DELETE'),
          rowParams(row.id),
        )
      ).status,
    ).toBe(204);
    expect(await projectRepoSetService.listByProject(fx.projectId, fx.ctx)).toEqual([]);

    ctxRef.current = null;
    expect(
      (await DELETE(json(`${BASE}/PROD/repositories/x`, 'DELETE'), rowParams('x'))).status,
    ).toBe(401);
  });
});

describe('PATCH seedSource — a person re-points a row’s seed (MOTIR-709)', () => {
  // The registry is migration-seeded platform data no truncate reaches: every
  // entry a test registers is removed again.
  const FLY = 'nextjs-prisma-fly-starter';

  afterEach(async () => {
    await adminDb.seedRegistryEntry.deleteMany({
      where: { key: { notIn: ['nextjs-prisma-serverless-starter', 'initialised'] } },
    });
  });

  async function registerFly() {
    await adminDb.seedRegistryEntry.create({
      data: {
        key: FLY,
        role: 'web',
        stack: 'nextjs',
        label: 'Next.js · Fly',
        templateOwner: 'motir-co',
        templateRepo: FLY,
        useCases: ['mvp'],
        sizes: ['small'],
        hostingTargets: ['fly'],
      },
    });
  }

  async function webRow(fx: WorkItemFixture) {
    return projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme' }, fx.ctx);
  }

  const repoint = (rowId: string, seedSource: string) =>
    PATCH(json(`${BASE}/P/repositories/${rowId}`, 'PATCH', { seedSource }), rowParams(rowId));

  const stored = (id: string) =>
    adminDb.projectRepo.findUniqueOrThrow({
      where: { id },
      select: { seedSource: true, seedMatch: true },
    });

  it('stores a compatible entry and clears the recorded match result', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const row = await webRow(fx);
    await adminDb.projectRepo.update({ where: { id: row.id }, data: { seedMatch: 'no_target' } });
    await registerFly();

    const res = await repoint(row.id, FLY);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ seedSource: FLY, seedMatch: null });
    expect(await stored(row.id)).toEqual({ seedSource: FLY, seedMatch: null });
  });

  it('stores the CURRENT key when the person names a legacy one', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const row = await webRow(fx);
    await adminDb.projectRepo.update({
      where: { id: row.id },
      data: { seedSource: 'initialised' },
    });

    const res = await repoint(row.id, 'nextjs-prisma-vercel-starter');
    expect(res.status).toBe(200);
    expect((await stored(row.id)).seedSource).toBe('nextjs-prisma-serverless-starter');
  });

  it.each([
    ['unknown', 'no-such-starter', async () => {}],
    [
      'retired',
      FLY,
      async () => {
        await registerFly();
        await adminDb.seedRegistryEntry.update({
          where: { key: FLY },
          data: { status: 'retired' },
        });
      },
    ],
  ] as const)(
    'refuses an %s entry with a 422 naming it, and stores nothing',
    async (refusal, key, arrange) => {
      const fx = await makeWorkItemFixture();
      signInAs(fx);
      const row = await webRow(fx);
      await arrange();
      const before = await stored(row.id);

      const res = await repoint(row.id, key);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ code: 'PROJECT_REPO_SEED_REFUSED', refusal });
      expect(await stored(row.id)).toEqual(before);
    },
  );

  it('refuses another role’s entry as role_mismatch', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api' },
      fx.ctx,
    );
    const before = await stored(row.id);

    const res = await repoint(row.id, 'nextjs-prisma-serverless-starter');
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ refusal: 'role_mismatch' });
    expect(await stored(row.id)).toEqual(before);
  });

  it('refuses a starter that does not deploy to the row’s target as target_mismatch', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const row = await webRow(fx);
    await adminDb.projectRepo.update({ where: { id: row.id }, data: { hostingTarget: 'aws' } });
    await registerFly();
    const before = await stored(row.id);

    const res = await repoint(row.id, FLY);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ refusal: 'target_mismatch' });
    expect(await stored(row.id)).toEqual(before);

    // `initialised` fits every row: it is what the matching answers when nothing does.
    expect((await repoint(row.id, 'initialised')).status).toBe(200);
  });

  it('refuses a row past proposed / failed with a 409, and admits a failed row', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const row = await webRow(fx);
    await adminDb.projectRepo.update({ where: { id: row.id }, data: { state: 'creating' } });
    const before = await stored(row.id);

    const res = await repoint(row.id, 'initialised');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ refusal: 'not_editable' });
    expect(await stored(row.id)).toEqual(before);

    await adminDb.projectRepo.update({ where: { id: row.id }, data: { state: 'failed' } });
    expect((await repoint(row.id, 'initialised')).status).toBe(200);
  });

  it('refuses the organisation’s own repository as organization_row', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const row = await webRow(fx);
    await adminDb.projectRepo.update({
      where: { id: row.id },
      data: { seedSource: SEED_SOURCE_ORGANIZATION },
    });

    const res = await repoint(row.id, 'initialised');
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ refusal: 'organization_row' });
    expect((await stored(row.id)).seedSource).toBe(SEED_SOURCE_ORGANIZATION);
  });
});

describe('POST …/[rowId]/state — the three moves the step offers', () => {
  it('skips a row', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'a' },
      fx.ctx,
    );

    const res = await STATE(
      json(`${BASE}/P/repositories/${row.id}/state`, 'POST', { to: 'skipped' }),
      rowParams(row.id),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe('skipped');
  });

  it('re-plans a skipped row back into a fresh proposal', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'a' },
      fx.ctx,
    );
    await projectRepoSetService.skipRow(row.id, fx.ctx);

    const res = await STATE(
      json(`${BASE}/P/repositories/${row.id}/state`, 'POST', { to: 'proposed' }),
      rowParams(row.id),
    );
    expect(res.status).toBe(200);
    const fresh = await res.json();
    expect(fresh.state).toBe('proposed');
    expect(fresh.id).not.toBe(row.id);
  });

  it('connects an existing repository, and 422s when the repo id is missing', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'a' },
      fx.ctx,
    );
    const inst = await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-${fx.workspaceId}`,
        workspaceId: fx.workspaceId,
        accountLogin: 'acme-inc',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const repo = await adminDb.githubRepo.create({
      data: {
        installationId: inst.id,
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        repoId: 'r-1',
        owner: 'acme-inc',
        name: 'booking-service',
        defaultBranch: 'main',
        archived: false,
        provider: 'github',
      },
    });

    const missingId = await STATE(
      json(`${BASE}/P/repositories/${row.id}/state`, 'POST', { to: 'connected' }),
      rowParams(row.id),
    );
    expect(missingId.status).toBe(422);

    const res = await STATE(
      json(`${BASE}/P/repositories/${row.id}/state`, 'POST', {
        to: 'connected',
        githubRepoId: repo.id,
      }),
      rowParams(row.id),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe('connected');
  });

  it('422s on a state the client may not write, and 409s on an illegal hop', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'a' },
      fx.ctx,
    );

    // `created` would let a client claim a repository exists that does not — the
    // one thing a row's state must never be able to lie about.
    for (const body of [null, {}, { to: 'created' }, { to: 'creating' }]) {
      const res = await STATE(
        json(`${BASE}/P/repositories/${row.id}/state`, 'POST', body),
        rowParams(row.id),
      );
      expect(res.status).toBe(422);
    }

    // A settled row has no legal hop — the self-correcting 409.
    await projectRepoSetService.skipRow(row.id, fx.ctx);
    const illegal = await STATE(
      json(`${BASE}/P/repositories/${row.id}/state`, 'POST', { to: 'skipped' }),
      rowParams(row.id),
    );
    expect(illegal.status).toBe(409);
    expect((await illegal.json()).code).toBe('PROJECT_REPO_ILLEGAL_TRANSITION');
  });

  it('401s with no workspace context', async () => {
    const res = await STATE(
      json(`${BASE}/P/repositories/x/state`, 'POST', { to: 'skipped' }),
      rowParams('x'),
    );
    expect(res.status).toBe(401);
  });
});

describe('POST …/[rowId]/move', () => {
  it('reorders the set, and is a 200 no-op at the edge', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const a = await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'a' }, fx.ctx);
    const b = await projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'b' }, fx.ctx);

    expect(
      (
        await MOVE(
          json(`${BASE}/P/repositories/${b.id}/move`, 'POST', { direction: 'up' }),
          rowParams(b.id),
        )
      ).status,
    ).toBe(200);
    expect(
      (await projectRepoSetService.listByProject(fx.projectId, fx.ctx)).map((r) => r.name),
    ).toEqual(['b', 'a']);

    const edge = await MOVE(
      json(`${BASE}/P/repositories/${b.id}/move`, 'POST', { direction: 'up' }),
      rowParams(b.id),
    );
    expect(edge.status).toBe(200);
    expect(a.id).toBeTruthy();
  });

  it('422s on a direction that is not up or down, 404s on an unknown row, 401s unauthenticated', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);

    expect(
      (
        await MOVE(
          json(`${BASE}/P/repositories/x/move`, 'POST', { direction: 'sideways' }),
          rowParams('x'),
        )
      ).status,
    ).toBe(422);
    expect(
      (await MOVE(new Request(`${BASE}/P/repositories/x/move`, { method: 'POST' }), rowParams('x')))
        .status,
    ).toBe(422);
    expect(
      (
        await MOVE(
          json(`${BASE}/P/repositories/nope/move`, 'POST', { direction: 'up' }),
          rowParams('nope'),
        )
      ).status,
    ).toBe(404);

    ctxRef.current = null;
    expect(
      (
        await MOVE(
          json(`${BASE}/P/repositories/x/move`, 'POST', { direction: 'up' }),
          rowParams('x'),
        )
      ).status,
    ).toBe(401);
  });
});

describe('POST …/repositories/establish', () => {
  it('runs the set and reports per row — with no provisioning credentials, each attempted row FAILS honestly', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'a' },
      fx.ctx,
    );

    const res = await ESTABLISH(
      json(`${BASE}/${fx.projectIdentifier}/repositories/establish`, 'POST', {}),
      keyParams(fx.projectIdentifier),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ rowId: row.id, outcome: 'failed' });
    // The reason is PERSISTED on the row, which is what makes the run resumable.
    const after = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(after[0]!.state).toBe('failed');
    expect(after[0]!.failureReason).toBeTruthy();
  });

  it('narrows to ONE row when the body names it', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const a = await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'a' }, fx.ctx);
    const b = await projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'b' }, fx.ctx);

    const res = await ESTABLISH(
      json(`${BASE}/${fx.projectIdentifier}/repositories/establish`, 'POST', { rowId: b.id }),
      keyParams(fx.projectIdentifier),
    );

    const body = await res.json();
    expect(body.rows.find((r: { rowId: string }) => r.rowId === a.id).outcome).toBe(
      'not_attempted',
    );
    expect(body.rows.find((r: { rowId: string }) => r.rowId === b.id).outcome).toBe('failed');
  });

  it('accepts a request with no body at all — “establish everything” is the default', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);

    const res = await ESTABLISH(
      new Request(`${BASE}/${fx.projectIdentifier}/repositories/establish`, { method: 'POST' }),
      keyParams(fx.projectIdentifier),
    );
    expect(res.status).toBe(200);
  });

  it('404s on another workspace’s project, and 401s with no workspace context', async () => {
    const a = await makeWorkItemFixture();
    const b = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    signInAs(a);
    expect(
      (
        await ESTABLISH(
          json(`${BASE}/${b.projectIdentifier}/repositories/establish`, 'POST', {}),
          keyParams(b.projectIdentifier),
        )
      ).status,
    ).toBe(404);

    ctxRef.current = null;
    expect(
      (await ESTABLISH(json(`${BASE}/PROD/repositories/establish`, 'POST', {}), keyParams('PROD')))
        .status,
    ).toBe(401);
  });
});

describe('the transport’s two remaining contracts', () => {
  it('treats an UNPARSEABLE body as “no body”, not as a crash', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'a' },
      fx.ctx,
    );

    const garbage = (url: string) =>
      new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      });

    // Each route falls back to its own default: a 422 where the body carried the
    // decision, a full-set run where it only narrowed one.
    expect(
      (
        await ADD(
          garbage(`${BASE}/${fx.projectIdentifier}/repositories`),
          keyParams(fx.projectIdentifier),
        )
      ).status,
    ).toBe(422);
    expect(
      (await STATE(garbage(`${BASE}/P/repositories/${row.id}/state`), rowParams(row.id))).status,
    ).toBe(422);
    expect(
      (await MOVE(garbage(`${BASE}/P/repositories/${row.id}/move`), rowParams(row.id))).status,
    ).toBe(422);
    expect(
      (
        await ESTABLISH(
          garbage(`${BASE}/${fx.projectIdentifier}/repositories/establish`),
          keyParams(fx.projectIdentifier),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await PATCH(
          new Request(`${BASE}/P/repositories/${row.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: '{',
          }),
          rowParams(row.id),
        )
      ).status,
    ).toBe(422);
  });

  it('forwards the optional CREATE fields, and treats a non-string name as blank', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);

    const res = await ADD(
      json(`${BASE}/${fx.projectIdentifier}/repositories`, 'POST', {
        role: 'infra',
        name: 'acme-infra',
        label: 'eu-west',
        seedSource: 'initialised',
      }),
      keyParams(fx.projectIdentifier),
    );
    expect(await res.json()).toMatchObject({
      label: 'eu-west',
      seedSource: 'initialised',
      role: 'infra',
    });

    // A non-string name normalizes to blank, which the service rejects by SHAPE —
    // a 422 naming the field, not a Prisma error about a null column.
    const blank = await ADD(
      json(`${BASE}/${fx.projectIdentifier}/repositories`, 'POST', { role: 'web', name: 42 }),
      keyParams(fx.projectIdentifier),
    );
    expect(blank.status).toBe(422);
  });

  it('RETHROWS an unmapped failure from the collection READ too', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const { projectRepoEstablishService } =
      await import('@/lib/services/projectRepoEstablishService');
    const spy = vi
      .spyOn(projectRepoEstablishService, 'getEstablishView')
      .mockRejectedValue(new Error('nope'));

    await expect(
      GET(
        new Request(`${BASE}/${fx.projectIdentifier}/repositories`),
        keyParams(fx.projectIdentifier),
      ),
    ).rejects.toThrow('nope');
    spy.mockRestore();
  });

  it('PATCHES a role and a seed source, not just a name', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'a' },
      fx.ctx,
    );

    const res = await PATCH(
      json(`${BASE}/P/repositories/${row.id}`, 'PATCH', {
        role: 'infra',
        seedSource: 'initialised',
      }),
      rowParams(row.id),
    );
    expect(await res.json()).toMatchObject({ role: 'infra', seedSource: 'initialised' });
  });

  it('RETHROWS an error it has no mapping for, rather than dressing a 500 up as a 4xx', async () => {
    // The map's null return is what makes this true, and it matters: telling a
    // client "your request was wrong" when the database went away sends them
    // looking in the wrong place. Forced with a spy on OUR OWN service — the
    // failure has no natural trigger, and swallowing it is the defect.
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const boom = new Error('the database went away');
    const spy = vi.spyOn(projectRepoSetService, 'addRow').mockRejectedValue(boom);

    await expect(
      ADD(
        json(`${BASE}/${fx.projectIdentifier}/repositories`, 'POST', { role: 'web', name: 'a' }),
        keyParams(fx.projectIdentifier),
      ),
    ).rejects.toThrow('the database went away');

    spy.mockRestore();
  });

  it('RETHROWS an unmapped failure from every other route too', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'a' },
      fx.ctx,
    );
    const boom = new Error('nope');

    const cases: [() => ReturnType<typeof vi.spyOn>, () => Promise<unknown>][] = [
      [
        () => vi.spyOn(projectRepoSetService, 'patchRow').mockRejectedValue(boom),
        () =>
          PATCH(
            json(`${BASE}/P/repositories/${row.id}`, 'PATCH', { name: 'b' }),
            rowParams(row.id),
          ),
      ],
      [
        () => vi.spyOn(projectRepoSetService, 'removeRow').mockRejectedValue(boom),
        () => DELETE(json(`${BASE}/P/repositories/${row.id}`, 'DELETE'), rowParams(row.id)),
      ],
      [
        () => vi.spyOn(projectRepoSetService, 'skipRow').mockRejectedValue(boom),
        () =>
          STATE(
            json(`${BASE}/P/repositories/${row.id}/state`, 'POST', { to: 'skipped' }),
            rowParams(row.id),
          ),
      ],
      [
        () => vi.spyOn(projectRepoSetService, 'moveRow').mockRejectedValue(boom),
        () =>
          MOVE(
            json(`${BASE}/P/repositories/${row.id}/move`, 'POST', { direction: 'up' }),
            rowParams(row.id),
          ),
      ],
    ];

    for (const [arrange, act] of cases) {
      const spy = arrange();
      await expect(act()).rejects.toThrow('nope');
      spy.mockRestore();
    }
  });

  it('RETHROWS an unmapped failure from the establish run', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const { projectRepoProvisioningService } =
      await import('@/lib/services/projectRepoProvisioningService');
    const spy = vi
      .spyOn(projectRepoProvisioningService, 'establishSet')
      .mockRejectedValue(new Error('nope'));

    await expect(
      ESTABLISH(
        json(`${BASE}/${fx.projectIdentifier}/repositories/establish`, 'POST', {}),
        keyParams(fx.projectIdentifier),
      ),
    ).rejects.toThrow('nope');
    spy.mockRestore();
  });
});

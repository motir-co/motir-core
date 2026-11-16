import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformRole } from '@/generated/prisma/client';
import type { RawPlannerFindingRecord } from '@/lib/ai/motirAiClient';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { platformPlanRepository } from '@/lib/repositories/platformPlanRepository';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { DEFAULT_TOKEN_GRANT } from '@/lib/tokens/grant';
import { createTestUser } from '../fixtures/userFixtures';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// LINKING PLANNING BUGS TO A PLANNER FINDING RECORD (Story MOTIR-11455 ·
// MOTIR-11504), over real Postgres, the real gate, real tokens, the real audit
// transaction and the real `work_item` lookup. What is stubbed: `getSession()`
// and motir-ai, which is another service — here as a small STATEFUL store, so a
// link written through one request is what the next request reads back.
//
//  - the `work_item` platform_staff arm: one SELECT arm, and the lookup it makes
//    answer for a PRIVATE project (so the public-project arm cannot be what
//    answers), and nothing outside a platform context;
//  - the writes: a link and an unlink that changed the set append exactly one
//    row; every refusal and a no-op unlink append none, and leave the set as it
//    was; a key is resolved in the RECORD's project only;
//  - the race: two staff members removing one key — one change, one no-op;
//  - the read level: a support principal reads a record and cannot write.

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));

/** motir-ai's record store, as far as these routes reach it. */
const store = vi.hoisted(() => {
  const records = new Map<string, Record<string, unknown> & { linkedBugKeys: string[] }>();
  const conflict = () =>
    import('@/lib/ai/errors').then(
      ({ MotirAiConflictError }) => new MotirAiConflictError('key already linked'),
    );
  const read = (id: string) => {
    const record = records.get(id);
    if (!record) throw new Error(`no record ${id}`);
    return { ...record, linkedBugKeys: [...record.linkedBugKeys] };
  };
  const readRecord = async (id: string) => ({ record: read(id), findings: [] });
  return {
    records,
    readRecord,
    getPlannerFindingRecord: vi.fn(readRecord),
    addPlannerFindingRecordLink: vi.fn(async (id: string, key: string) => {
      const record = records.get(id)!;
      if (record.linkedBugKeys.includes(key)) throw await conflict();
      record.linkedBugKeys.push(key);
      return { record: read(id), changed: true };
    }),
    removePlannerFindingRecordLink: vi.fn(async (id: string, key: string) => {
      const record = records.get(id)!;
      const changed = record.linkedBugKeys.includes(key);
      record.linkedBugKeys = record.linkedBugKeys.filter((k) => k !== key);
      return { record: read(id), changed };
    }),
  };
});

vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  getPlannerFindingRecord: store.getPlannerFindingRecord,
  addPlannerFindingRecordLink: store.addPlannerFindingRecordLink,
  removePlannerFindingRecordLink: store.removePlannerFindingRecordLink,
}));

beforeEach(async () => {
  vi.resetModules();
  currentSession = null;
  store.records.clear();
  store.getPlannerFindingRecord.mockReset().mockImplementation(store.readRecord);
  store.addPlannerFindingRecordLink.mockClear();
  store.removePlannerFindingRecordLink.mockClear();
  await adminDb.platformAuditLog.deleteMany();
  await truncateAuthTables();
});

afterAll(async () => {
  await adminDb.platformAuditLog.deleteMany();
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
const NOW = '2026-11-17T09:00:00.000Z';

async function staff(role: PlatformRole | null) {
  const { owner, workspace } = await createTestWorkspace({ name: `Link staff ${++seq}` });
  if (role) await adminDb.user.update({ where: { id: owner.id }, data: { platformRole: role } });
  const { token, dto } = await apiTokensService.create(owner.id, workspace.id, {
    label: 'motir-check-plan',
    fixedGrant: DEFAULT_TOKEN_GRANT,
  });
  return { owner, workspace, token, tokenId: dto.id };
}

/** A tenant whose project the staff member is NOT a member of, with one bug in it. */
async function tenant(identifier = 'PROD') {
  const fx = await makeWorkItemFixture({ name: `Tenant ${++seq}`, identifier });
  const bug = await createTestWorkItem(fx, { kind: 'bug', title: 'A planning bug' });
  const second = await createTestWorkItem(fx, { kind: 'bug', title: 'Another planning bug' });
  return { fx, bug, second };
}

function seedRecord(
  fx: WorkItemFixture,
  over: Partial<RawPlannerFindingRecord> = {},
): RawPlannerFindingRecord {
  const record: RawPlannerFindingRecord = {
    id: `rec_${++seq}`,
    source: 'check_plan',
    planner: 'plan_py',
    coreOrganizationId: fx.workspace.organizationId,
    coreWorkspaceId: fx.workspaceId,
    coreProjectId: fx.projectId,
    aiProjectId: 'aip_1',
    planId: 'plan_1',
    planSessionId: null,
    jobId: null,
    planTitle: 'Ship the export',
    authorModel: null,
    baselineBranch: null,
    baselineCommit: null,
    verdictState: 'attributed',
    verdictBy: 'u_v',
    verdictAt: NOW,
    runThroughAnswer: null,
    runThroughStopCards: [],
    linkedBugKeys: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
  store.records.set(record.id, { ...record, linkedBugKeys: [...record.linkedBugKeys] });
  return record;
}

async function routes() {
  const [links, remove, one] = await Promise.all([
    import('@/app/api/platform/planner-findings/records/[id]/links/route'),
    import('@/app/api/platform/planner-findings/records/[id]/links/remove/route'),
    import('@/app/api/platform/planner-findings/records/[id]/route'),
  ]);
  return { links, remove, one };
}

function post(path: string, token: string | null, body: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost/api/platform/planner-findings${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function get(path: string, token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost/api/platform/planner-findings${path}`, { headers });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function json(res: Response) {
  return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') };
}

async function link(token: string | null, id: string, key: string) {
  return json(
    await (await routes()).links.POST(post(`/records/${id}/links`, token, { key }), ctx(id)),
  );
}

async function unlink(token: string | null, id: string, key: string) {
  return json(
    await (
      await routes()
    ).remove.POST(post(`/records/${id}/links/remove`, token, { key }), ctx(id)),
  );
}

async function readBack(token: string | null, id: string) {
  return json(await (await routes()).one.GET(get(`/records/${id}`, token), ctx(id)));
}

async function writeRows() {
  return adminDb.platformAuditLog.findMany({
    where: { action: { in: ['planner_finding.link', 'planner_finding.unlink'] } },
    orderBy: { seq: 'asc' },
  });
}

// ── The arm ─────────────────────────────────────────────────────────────────

describe('the `work_item` platform_staff arm', () => {
  it('is ONE permissive SELECT arm bound to `app.platform_staff` alone', async () => {
    const rows = await adminDb.$queryRaw<
      {
        policyname: string;
        cmd: string;
        permissive: string;
        qual: string;
        with_check: string | null;
      }[]
    >`
      SELECT "policyname", "cmd", "permissive", "qual", "with_check"
      FROM pg_policies
      WHERE "tablename" = 'work_item'
        AND ("qual" LIKE '%app.platform_staff%' OR "with_check" LIKE '%app.platform_staff%')
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      policyname: 'work_item_platform_staff_read',
      cmd: 'SELECT',
      permissive: 'PERMISSIVE',
      with_check: null,
    });
    expect(rows[0]!.qual).not.toContain('app.workspace_id');
    expect(rows[0]!.qual).not.toContain('app.system_admin');
  });

  it("finds a PRIVATE project's work item inside a platform read, and nothing outside one", async () => {
    const { fx, bug } = await tenant();
    const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(project.accessMode).not.toBe('public');
    const user = await createTestUser({ email: `ops+wi-arm-${++seq}@moooon.net` });
    await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'operator' } });
    const operator: PlatformPrincipal = { userId: user.id, email: user.email, role: 'operator' };

    const inside = await withPlatformRead(
      operator,
      { action: 'estate.read', targetKind: 'platform', targetId: bug.id },
      (tx) => platformPlanRepository.findWorkItemByIdentifier(bug.identifier, fx.projectId, tx),
    );
    expect(inside).toEqual({ id: bug.id, identifier: bug.identifier });

    const outside = await db.$transaction((tx) =>
      platformPlanRepository.findWorkItemByIdentifier(bug.identifier, fx.projectId, tx),
    );
    expect(outside).toBeNull();
  });
});

// ── The writes ──────────────────────────────────────────────────────────────

describe('POST .../links — link a key to an attributed record', () => {
  it('links a key resolved in the record project, read back on the record, with one row', async () => {
    const { token, tokenId } = await staff('operator');
    const { fx, bug } = await tenant();
    const record = seedRecord(fx);

    const res = await link(token, record.id, `  ${bug.identifier.toLowerCase()} `);
    expect(res.status).toBe(200);
    expect(res.cache).toBe('no-store');
    expect(res.body).toMatchObject({ changed: true, record: { linkedBugKeys: [bug.identifier] } });
    expect(store.addPlannerFindingRecordLink).toHaveBeenCalledWith(record.id, bug.identifier);
    expect((await readBack(token, record.id)).body.record.linkedBugKeys).toEqual([bug.identifier]);

    const rows = await writeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'planner_finding.link',
      targetKind: 'platform',
      targetId: record.id,
      organizationId: fx.workspace.organizationId,
      reason: expect.stringMatching(/\S/),
      metadata: {
        recordId: record.id,
        key: bug.identifier,
        credential: { kind: 'token', apiTokenId: tokenId },
      },
    });
  });

  it('keeps both keys after two links, with no duplicate', async () => {
    const { token } = await staff('operator');
    const { fx, bug, second } = await tenant();
    const record = seedRecord(fx);
    expect((await link(token, record.id, bug.identifier)).status).toBe(200);
    expect((await link(token, record.id, second.identifier)).status).toBe(200);
    const keys = (await readBack(token, record.id)).body.record.linkedBugKeys as string[];
    expect([...keys].sort()).toEqual([bug.identifier, second.identifier].sort());
  });

  it('answers a console session as well, naming the session on its row', async () => {
    const { owner } = await staff('operator');
    currentSession = { user: { id: owner.id } };
    const { fx, bug } = await tenant();
    const record = seedRecord(fx);
    expect((await link(null, record.id, bug.identifier)).status).toBe(200);
    expect((await writeRows())[0]!.metadata).toMatchObject({ credential: { kind: 'session' } });
  });
});

describe('every refusal is its own answer, changes nothing and writes no row', () => {
  it('a link or an unlink on an open record answers 409 record_open, before any lookup', async () => {
    const { token } = await staff('operator');
    const { fx, bug } = await tenant();
    const record = seedRecord(fx, { verdictState: 'open', verdictBy: null, verdictAt: null });

    for (const res of [
      await link(token, record.id, bug.identifier),
      await unlink(token, record.id, bug.identifier),
    ]) {
      expect(res).toEqual({
        status: 409,
        body: { code: 'LINK_REFUSED', reason: 'record_open' },
        cache: 'no-store',
      });
    }
    expect(store.addPlannerFindingRecordLink).not.toHaveBeenCalled();
    expect(store.removePlannerFindingRecordLink).not.toHaveBeenCalled();
    expect((await readBack(token, record.id)).body.record.linkedBugKeys).toEqual([]);
    expect(await writeRows()).toEqual([]);
  });

  it('a key naming no work item, or one in another project or tenant, is not_a_work_item', async () => {
    const { token } = await staff('operator');
    const { fx } = await tenant();
    const record = seedRecord(fx);
    // Another project in the SAME workspace, and another tenant entirely.
    const sibling = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'SIB',
    });
    const siblingBug = await createTestWorkItem(
      { ...fx, project: sibling, projectId: sibling.id, projectIdentifier: sibling.identifier },
      { kind: 'bug', title: 'Elsewhere in the workspace' },
    );
    const { bug: foreignBug } = await tenant('FRGN');

    for (const key of ['PROD-999', siblingBug.identifier, foreignBug.identifier]) {
      expect(await link(token, record.id, key)).toEqual({
        status: 400,
        body: { code: 'LINK_REFUSED', reason: 'not_a_work_item' },
        cache: 'no-store',
      });
    }
    expect(store.addPlannerFindingRecordLink).not.toHaveBeenCalled();
    expect(store.records.get(record.id)!.linkedBugKeys).toEqual([]);
    expect(await writeRows()).toEqual([]);
  });

  it('an already-linked key answers 409 already_linked with the set unchanged', async () => {
    const { token } = await staff('operator');
    const { fx, bug, second } = await tenant();
    const record = seedRecord(fx, { linkedBugKeys: [second.identifier, bug.identifier] });
    expect(await link(token, record.id, bug.identifier.toLowerCase())).toEqual({
      status: 409,
      body: { code: 'LINK_REFUSED', reason: 'already_linked' },
      cache: 'no-store',
    });
    expect(store.records.get(record.id)!.linkedBugKeys).toEqual([
      second.identifier,
      bug.identifier,
    ]);
    expect(await writeRows()).toEqual([]);
  });

  it("the store's conflict, when another admin linked the key first, is already_linked", async () => {
    const { token } = await staff('operator');
    const { fx, bug } = await tenant();
    const record = seedRecord(fx);
    // The record read answers the set before the other admin's add lands.
    store.getPlannerFindingRecord.mockImplementationOnce(async (id: string) => {
      const before = { ...store.records.get(id)!, linkedBugKeys: [] as string[] };
      store.records.get(id)!.linkedBugKeys.push(bug.identifier);
      return { record: before as never, findings: [] };
    });
    expect((await link(token, record.id, bug.identifier)).body).toEqual({
      code: 'LINK_REFUSED',
      reason: 'already_linked',
    });
    expect(store.records.get(record.id)!.linkedBugKeys).toEqual([bug.identifier]);
    expect(await writeRows()).toEqual([]);
  });

  it('motir-ai failing the add is an outage, with no row and no key', async () => {
    const { token } = await staff('operator');
    const { fx, bug } = await tenant();
    const record = seedRecord(fx);
    const { MotirAiUnavailableError } = await import('@/lib/ai/errors');
    store.addPlannerFindingRecordLink.mockRejectedValueOnce(new MotirAiUnavailableError('down'));
    expect(await link(token, record.id, bug.identifier)).toEqual({
      status: 503,
      body: { code: 'UPSTREAM_UNAVAILABLE' },
      cache: 'no-store',
    });
    expect(store.records.get(record.id)!.linkedBugKeys).toEqual([]);
    expect(await writeRows()).toEqual([]);
  });

  it('the service refuses a read to an actor with no platform role, gate or no gate', async () => {
    const { plannerFindingRecordsService } = await import('@/lib/services/plannerFindingsService');
    const { NotPlatformStaffError } = await import('@/lib/platform/errors');
    const actor = {
      userId: 'u_none',
      email: 'none@example.com',
      role: null as never,
      credential: { kind: 'session' as const },
    };
    await expect(plannerFindingRecordsService.getRecord(actor, 'rec_1')).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
    expect(store.getPlannerFindingRecord).not.toHaveBeenCalled();
  });

  it('a malformed body is a 400 naming the key, before any read', async () => {
    const { token } = await staff('operator');
    const { fx } = await tenant();
    const record = seedRecord(fx);
    for (const body of [{}, { key: '   ' }, { key: 'X'.repeat(65) }, { key: 'PROD-1', extra: 1 }]) {
      const res = await json(
        await (
          await routes()
        ).links.POST(post(`/records/${record.id}/links`, token, body), ctx(record.id)),
      );
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_REQUEST');
    }
    expect(store.getPlannerFindingRecord).not.toHaveBeenCalled();
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });
});

describe('POST .../links/remove — unlink, idempotently', () => {
  it('two adds and one remove leave exactly three rows, and the remaining key', async () => {
    const { token } = await staff('operator');
    const { fx, bug, second } = await tenant();
    const record = seedRecord(fx);
    await link(token, record.id, bug.identifier);
    await link(token, record.id, second.identifier);
    const removed = await unlink(token, record.id, bug.identifier.toLowerCase());
    expect(removed).toMatchObject({
      status: 200,
      body: { changed: true, record: { linkedBugKeys: [second.identifier] } },
    });
    expect(
      (await writeRows()).map((row) => [row.action, (row.metadata as { key: string }).key]),
    ).toEqual([
      ['planner_finding.link', bug.identifier],
      ['planner_finding.link', second.identifier],
      ['planner_finding.unlink', bug.identifier],
    ]);
  });

  it('a key the record no longer carries answers it as it stands, writing nothing', async () => {
    const { token } = await staff('operator');
    const { fx, bug, second } = await tenant();
    const record = seedRecord(fx, { linkedBugKeys: [second.identifier] });
    expect(await unlink(token, record.id, bug.identifier)).toEqual({
      status: 200,
      body: {
        changed: false,
        record: expect.objectContaining({ linkedBugKeys: [second.identifier] }),
      },
      cache: 'no-store',
    });
    expect(store.removePlannerFindingRecordLink).not.toHaveBeenCalled();
    expect(await writeRows()).toEqual([]);
  });

  it('two staff members removing one key: one change, one no-op, one row, no error', async () => {
    const { token } = await staff('operator');
    const { token: other } = await staff('superadmin');
    const { fx, bug } = await tenant();
    const record = seedRecord(fx, { linkedBugKeys: [bug.identifier] });
    // Both reads answer the key before either write lands: platform contexts
    // serialize on the audit chain, so the race is the second read seeing the
    // set as it stood before the first write, which is what these two answer.
    const stale = { ...store.records.get(record.id)!, linkedBugKeys: [bug.identifier] };
    store.getPlannerFindingRecord
      .mockResolvedValueOnce({ record: { ...stale } as never, findings: [] })
      .mockResolvedValueOnce({ record: { ...stale } as never, findings: [] });

    const answers = await Promise.all([
      unlink(token, record.id, bug.identifier),
      unlink(other, record.id, bug.identifier),
    ]);
    expect(answers.map((a) => a.status)).toEqual([200, 200]);
    expect(answers.map((a) => a.body.changed).sort()).toEqual([false, true]);
    for (const a of answers) expect(a.body.record.linkedBugKeys).toEqual([]);
    expect(store.removePlannerFindingRecordLink).toHaveBeenCalledTimes(2);
    expect((await writeRows()).map((row) => row.action)).toEqual(['planner_finding.unlink']);
  });
});

describe('the writes touch no work item', () => {
  it('a link and an unlink leave every work item exactly as it was', async () => {
    const { token } = await staff('operator');
    const { fx, bug } = await tenant();
    const record = seedRecord(fx);
    const before = await adminDb.workItem.findMany({
      where: { projectId: fx.projectId },
      orderBy: { id: 'asc' },
    });
    await link(token, record.id, bug.identifier);
    await unlink(token, record.id, bug.identifier);
    expect(
      await adminDb.workItem.findMany({
        where: { projectId: fx.projectId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(before);
  });
});

describe('the read level', () => {
  it.each([
    ['a support token', async () => (await staff('support')).token],
    [
      'a support session',
      async () => {
        const { owner } = await staff('support');
        currentSession = { user: { id: owner.id } };
        return null;
      },
    ],
  ])(
    '%s reads the record and its keys, and is refused both writes with the gate 404',
    async (_n, arrange) => {
      const { fx, bug } = await tenant();
      const record = seedRecord(fx, { linkedBugKeys: [bug.identifier] });
      const bearer = await arrange();

      const read = await readBack(bearer, record.id);
      expect(read.status).toBe(200);
      expect(read.body.record.linkedBugKeys).toEqual([bug.identifier]);
      for (const res of [
        await link(bearer, record.id, bug.identifier),
        await unlink(bearer, record.id, bug.identifier),
      ]) {
        expect(res).toEqual({ status: 404, body: { code: 'NOT_FOUND' }, cache: 'no-store' });
      }
      expect(store.addPlannerFindingRecordLink).not.toHaveBeenCalled();
      expect(store.removePlannerFindingRecordLink).not.toHaveBeenCalled();
      expect(await writeRows()).toEqual([]);
    },
  );
});

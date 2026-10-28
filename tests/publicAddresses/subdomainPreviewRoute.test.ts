import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE DATED PREVIEW ROUTE — Story MOTIR-4528 · Subtask MOTIR-9510.
//
// `GET /api/workspaces/{id}/public-subdomain/preview` answers what a rename or
// release would do right now. Driven through the ROUTE against real Postgres,
// so the handler, the service, the RLS binding a request establishes and the
// error mapping are proved to agree. Only `getWorkspaceContext` is stubbed (no
// cookies in a test), partially, so the real `withWorkspaceContext` stays.

const ctxRef = { current: null as { userId: string; workspaceId: string } | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const { db } = await import('@/lib/db');
const { GET } = await import('@/app/api/workspaces/[workspaceId]/public-subdomain/preview/route');
const { publicSubdomainService } = await import('@/lib/services/publicSubdomainService');
const { createTestWorkspace, createTestUser } = await import('../fixtures');

const BASE = 'motir.example';
const DAY = 24 * 60 * 60 * 1000;

let workspaceId: string;
let ownerId: string;

const params = () => ({ params: Promise.resolve({ workspaceId }) });
const req = () => new Request('https://app.motir.co/x');

beforeEach(async () => {
  await truncateAuthTables();
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_PUBLIC_TENANT_DOMAIN'] = BASE;
  const { workspace, owner } = await createTestWorkspace({ name: 'Acme' });
  workspaceId = workspace.id;
  ownerId = owner.id;
  ctxRef.current = { userId: ownerId, workspaceId };
});

afterEach(() => {
  ctxRef.current = null;
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_PUBLIC_TENANT_DOMAIN'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('GET …/public-subdomain/preview', () => {
  it('answers what a release would free right now, and writes nothing', async () => {
    await publicSubdomainService.claim(workspaceId, 'acme', ownerId);

    const res = await GET(req(), params());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      host: `acme.${BASE}`,
      outcome: 'return_now',
      returnsAt: null,
      changeAllowed: true,
      nextChangeAllowedAt: null,
    });
    expect(await adminDb.publicHostnameReservation.count()).toBe(0);
    expect(await adminDb.publicSubdomainChange.count()).toBe(0);
    expect(await adminDb.publicAddress.count({ where: { workspaceId } })).toBe(1);
  });

  it('dates the hold of a label held more than a day, the same date the service computes', async () => {
    await publicSubdomainService.claim(workspaceId, 'acme', ownerId);
    await adminDb.publicAddress.updateMany({
      where: { workspaceId },
      data: { createdAt: new Date(Date.now() - 2 * DAY) },
    });

    const before = Date.now();
    const body = (await (await GET(req(), params())).json()) as {
      outcome: string;
      returnsAt: string;
    };
    const after = Date.now();

    expect(body.outcome).toBe('quarantine');
    const returnsAt = new Date(body.returnsAt).getTime();
    expect(returnsAt).toBeGreaterThanOrEqual(before + 90 * DAY);
    expect(returnsAt).toBeLessThanOrEqual(after + 90 * DAY);
  });

  it('says a change is not allowed yet, and when it will be, inside the 30-day limit', async () => {
    await publicSubdomainService.claim(workspaceId, 'acme', ownerId);
    const changedAt = new Date();
    await publicSubdomainService.rename(workspaceId, 'acme-inc', ownerId, changedAt);

    expect(await (await GET(req(), params())).json()).toMatchObject({
      host: `acme-inc.${BASE}`,
      changeAllowed: false,
      nextChangeAllowedAt: new Date(changedAt.getTime() + 30 * DAY).toISOString(),
    });
  });

  it('answers 404 when there is no subdomain to change', async () => {
    const res = await GET(req(), params());
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'SUBDOMAIN_NOT_FOUND' });
  });

  it('answers 401 with no session, 403 to a plain member, 404 to a stranger', async () => {
    await publicSubdomainService.claim(workspaceId, 'acme', ownerId);

    ctxRef.current = null;
    expect((await GET(req(), params())).status).toBe(401);

    const member = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: member.id, workspaceId, workspaceRole: 'member' },
    });
    ctxRef.current = { userId: member.id, workspaceId };
    expect((await GET(req(), params())).status).toBe(403);

    const stranger = await createTestUser();
    ctxRef.current = { userId: stranger.id, workspaceId };
    expect((await GET(req(), params())).status).toBe(404);
  });
});

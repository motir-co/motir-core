import { NextResponse } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { HandoverEmailCodeRefusedError } from '@/lib/hosting/tenantHandoverErrors';
import {
  badHandoverRequest,
  mapTenantHandoverError,
  readHandoverBody,
} from '@/lib/hosting/tenantHandoverErrorResponse';
import { tenantAccountHandoverService } from '@/lib/services/tenantAccountHandoverService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  GITHUB_OWNER,
  OWNER_EMAIL,
  seedHandoverWorld,
  type HandoverWorld,
} from '../helpers/tenantHandoverFixtures';

// The takeover handover's four routes (Story MOTIR-9800 · MOTIR-12131) over
// real Postgres. The compliance gate is the one stub (a route test has no
// cookie jar); the service, the organisation-admin gate and the typed-error
// mapping are the shipped path. No call here reaches AWS: each either refuses
// before the boundary or writes only Motir's own rows.

const { requireCompliantSession } = vi.hoisted(() => ({ requireCompliantSession: vi.fn() }));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantSession }));

const root = await import('@/app/api/organizations/[orgId]/hosting/aws-handover/route');
const emailCode =
  await import('@/app/api/organizations/[orgId]/hosting/aws-handover/email-code/route');
const recheck = await import('@/app/api/organizations/[orgId]/hosting/aws-handover/recheck/route');
const retry = await import('@/app/api/organizations/[orgId]/hosting/aws-handover/retry/route');

let world: HandoverWorld;

function signInAs(userId: string) {
  requireCompliantSession.mockResolvedValue({
    ok: true,
    session: { user: { id: userId, email: `${userId}@example.test` } },
  });
}

const url = (orgId: string, path = '', query = '') =>
  `http://localhost:3000/api/organizations/${orgId}/hosting/aws-handover${path}${query}`;
const params = (orgId: string) => ({ params: Promise.resolve({ orgId }) });

function post(
  handler: (req: Request, p: ReturnType<typeof params>) => Promise<Response>,
  orgId: string,
  path: string,
  body: unknown,
) {
  return handler(
    new Request(url(orgId, path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    params(orgId),
  );
}

const startBody = { ownerEmail: OWNER_EMAIL, githubOwner: GITHUB_OWNER };
const startIt = (orgId = world.organizationId, body: unknown = startBody) =>
  post(root.POST, orgId, '', body);
const getIt = (orgId: string, tenantAccountId?: string) =>
  root.GET(
    new Request(url(orgId, '', tenantAccountId ? `?tenantAccountId=${tenantAccountId}` : '')),
    params(orgId),
  );

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAuthTables();
  world = await seedHandoverWorld();
  signInAs(world.fx.ownerId);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('POST …/aws-handover', () => {
  it('starts the handover: 201 with eight pending steps and no owner email in the body', async () => {
    const res = await startIt();
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(OWNER_EMAIL);
    const { handover } = JSON.parse(text);
    expect(handover).toMatchObject({
      tenantAccountId: world.tenantAccountId,
      state: 'handing_over',
    });
    expect(handover.steps).toHaveLength(8);
  });

  it('answers 400 for a body without the owner email and GitHub owner, or not JSON', async () => {
    expect((await startIt(world.organizationId, { ownerEmail: OWNER_EMAIL })).status).toBe(400);
    expect((await startIt(world.organizationId, 'not json')).status).toBe(400);
    expect((await startIt(world.organizationId, '[1]')).status).toBe(400);
  });

  it('answers 400 for an address that is not one', async () => {
    const res = await startIt(world.organizationId, { ...startBody, ownerEmail: 'nope' });
    expect(res.status).toBe(400);
  });

  it('answers 409 when it has already started', async () => {
    await startIt();
    expect((await startIt()).status).toBe(409);
  });

  it('answers 403 for a member who is not an admin, 404 for a stranger', async () => {
    const member = await createTestUser();
    await adminDb.organizationMembership.create({
      data: { organizationId: world.organizationId, userId: member.id, role: 'member' },
    });
    signInAs(member.id);
    expect((await startIt()).status).toBe(403);
    signInAs((await createTestUser()).id);
    expect((await startIt()).status).toBe(404);
  });

  it('returns the gate’s own response when the session is not compliant', async () => {
    const refused = NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
    requireCompliantSession.mockResolvedValue({ ok: false, response: refused });
    expect((await startIt()).status).toBe(401);
    for (const handler of [emailCode.POST, recheck.POST, retry.POST]) {
      const res = await post(handler, world.organizationId, '', {});
      expect(res.status).toBe(401);
    }
    expect((await getIt(world.organizationId, world.tenantAccountId)).status).toBe(401);
  });
});

describe('GET …/aws-handover', () => {
  it('reads the checklist', async () => {
    await startIt();
    const res = await getIt(world.organizationId, world.tenantAccountId);
    expect(res.status).toBe(200);
    expect((await res.json()).handover.steps.map((s: { status: string }) => s.status)).toEqual(
      Array(8).fill('pending'),
    );
  });

  it('answers 400 without a tenant account id', async () => {
    expect((await getIt(world.organizationId)).status).toBe(400);
  });

  it('answers 404 for an account read through another organisation', async () => {
    const other = await seedHandoverWorld({ domain: 'shop.other.example' });
    signInAs(other.fx.ownerId);
    expect((await getIt(other.organizationId, world.tenantAccountId)).status).toBe(404);
  });
});

describe('POST …/email-code, …/recheck, …/retry', () => {
  beforeEach(async () => {
    await startIt();
  });

  it('answers 400 without the fields each needs', async () => {
    const id = { tenantAccountId: world.tenantAccountId };
    expect((await post(emailCode.POST, world.organizationId, '/email-code', id)).status).toBe(400);
    expect((await post(recheck.POST, world.organizationId, '/recheck', {})).status).toBe(400);
    expect((await post(retry.POST, world.organizationId, '/retry', {})).status).toBe(400);
  });

  it('answers 409 when no step waits on what the call carries', async () => {
    const id = { tenantAccountId: world.tenantAccountId };
    const code = await post(emailCode.POST, world.organizationId, '/email-code', {
      ...id,
      code: '123456',
    });
    expect(code.status).toBe(409);
    expect(await code.text()).not.toContain('123456');
    expect((await post(recheck.POST, world.organizationId, '/recheck', id)).status).toBe(409);
    expect((await post(retry.POST, world.organizationId, '/retry', id)).status).toBe(409);
  });

  it('retries a failed step: 200, the step pending again', async () => {
    await adminDb.hostingTenantHandoverStep.update({
      where: {
        tenantAccountId_step: { tenantAccountId: world.tenantAccountId, step: 'destroy_previews' },
      },
      data: { status: 'failed', lastError: 'FAKE: refused' },
    });
    const res = await post(retry.POST, world.organizationId, '/retry', {
      tenantAccountId: world.tenantAccountId,
    });
    expect(res.status).toBe(200);
    const { handover } = await res.json();
    expect(handover.steps[0]).toMatchObject({ step: 'destroy_previews', status: 'pending' });
  });

  it('answers 404 for another organisation’s account', async () => {
    const other = await seedHandoverWorld({ domain: 'shop.other.example' });
    signInAs(other.fx.ownerId);
    const id = { tenantAccountId: world.tenantAccountId };
    for (const [handler, path, body] of [
      [emailCode.POST, '/email-code', { ...id, code: '1' }],
      [recheck.POST, '/recheck', id],
      [retry.POST, '/retry', id],
    ] as const) {
      expect((await post(handler, other.organizationId, path, body)).status).toBe(404);
    }
  });
});

describe('the error mapping', () => {
  it('answers 422 when AWS refuses the code, and null for an error it does not know', async () => {
    const res = mapTenantHandoverError(new HandoverEmailCodeRefusedError('expired'));
    expect(res?.status).toBe(422);
    expect(mapTenantHandoverError(new Error('boom'))).toBeNull();
  });

  it('reads a JSON object body and refuses anything else', async () => {
    const req = (body: string) => new Request('http://x', { method: 'POST', body });
    expect(await readHandoverBody(req('{"a":1}'))).toEqual({ a: 1 });
    expect(await readHandoverBody(req('null'))).toBeNull();
    expect(badHandoverRequest('x').status).toBe(400);
  });
});

describe('an error the mapping does not know', () => {
  it('is rethrown by every route, so it is a 500', async () => {
    const boom = new Error('boom');
    for (const method of [
      'start',
      'status',
      'submitEmailCode',
      'recheckStandalone',
      'retry',
    ] as const) {
      vi.spyOn(tenantAccountHandoverService, method).mockRejectedValue(boom);
    }
    const id = { tenantAccountId: world.tenantAccountId };
    await expect(startIt()).rejects.toBe(boom);
    await expect(getIt(world.organizationId, world.tenantAccountId)).rejects.toBe(boom);
    await expect(
      post(emailCode.POST, world.organizationId, '/email-code', { ...id, code: '1' }),
    ).rejects.toBe(boom);
    await expect(post(recheck.POST, world.organizationId, '/recheck', id)).rejects.toBe(boom);
    await expect(post(retry.POST, world.organizationId, '/retry', id)).rejects.toBe(boom);
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { RawSubscriptionResponse } from '@/lib/ai/types';
import { adminDb } from '../helpers/adminDb';

// The Fleet use read's route (Story MOTIR-9368 · MOTIR-9661):
// GET /api/organizations/[orgId]/billing/fleet-use. It proves the session gate,
// Billing & plans' view gate (owner and admin 200, a member 403, a non-member,
// another org and off-cloud 404) and that the 200 body is the service's answer.
// Real Postgres; the sanctioned mocks are `getSession` and motir-ai's
// subscription read.

const session = { current: null as { user: { id: string; email: string } } | null };
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));
const getOrgSubscriptionMock = vi.fn<(q: unknown) => Promise<RawSubscriptionResponse>>();
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  getOrgSubscription: (q: unknown) => getOrgSubscriptionMock(q),
}));

const { GET } = await import('@/app/api/organizations/[orgId]/billing/fleet-use/route');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { orgPlanFiguresService } = await import('@/lib/services/orgPlanFiguresService');
const { _resetPlanCapsCache } = await import('@/lib/services/planCapsService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');

interface Org {
  organizationId: string;
  owner: { id: string; email: string };
  admin: { id: string; email: string };
  member: { id: string; email: string };
}

async function makeOrg(): Promise<Org> {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  const organizationId = workspace.organizationId;
  const admin = await createTestUser();
  await organizationsService.addMember({
    organizationId,
    userId: admin.id,
    role: 'admin',
    actorUserId: owner.id,
  });
  const member = await createTestUser();
  await organizationsService.addMember({
    organizationId,
    userId: member.id,
    role: 'member',
    actorUserId: owner.id,
  });
  return { organizationId, owner, admin, member };
}

function get(orgId: string) {
  return GET(new Request(`http://localhost:3000/api/organizations/${orgId}/billing/fleet-use`), {
    params: Promise.resolve({ orgId }),
  });
}

function signInAs(user: { id: string; email: string } | null) {
  session.current = user ? { user: { id: user.id, email: user.email } } : null;
}

let org: Org;

beforeEach(async () => {
  await truncateAuthTables();
  _resetPlanCapsCache();
  getOrgSubscriptionMock.mockReset();
  getOrgSubscriptionMock.mockResolvedValue({
    status: 'active',
    currentPeriodEnd: null,
    priceId: null,
    planTier: { key: 'pro', name: 'Pro', monthlyCreditAllotment: 1 },
  });
  vi.stubEnv('MOTIR_CLOUD', 'true');
  org = await makeOrg();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  session.current = null;
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('GET fleet-use', () => {
  it.each(['owner', 'admin'] as const)(
    'as the %s of a Pro org: 200 with the plan figures',
    async (who) => {
      signInAs(org[who]);
      const res = await get(org.organizationId);
      expect(res.status).toBe(200);
      const { fleetUse } = await res.json();
      _resetPlanCapsCache();
      const figures = await orgPlanFiguresService.figuresFor(org.organizationId);
      if (figures.kind !== 'capped') throw new Error('expected capped');
      expect(fleetUse.plan).toEqual({
        kind: 'limited',
        planKey: 'pro',
        planName: 'Pro',
        noFleet: false,
      });
      expect(fleetUse.figures.agentRunsInParallel.figure).toBe(figures.agentRunsInParallel);
      expect(fleetUse.figures.agentsRunningInOrg.figure).toBe(figures.agentsRunningPerOrg);
      expect(fleetUse.figures.agentsPerPerson.figure).toBe(figures.agentsPerUser);
      expect(fleetUse.figures.ciJobsInFlight.figure).toBe(figures.ciBurstCap);
      const text = JSON.stringify(fleetUse);
      for (const id of [org.organizationId, org.owner.id, org.admin.id, org.owner.email]) {
        expect(text).not.toContain(id);
      }
    },
  );

  it('a plain member gets 403 and the plan is never read', async () => {
    const spy = vi.spyOn(orgPlanFiguresService, 'figuresFor');
    signInAs(org.member);
    expect((await get(org.organizationId)).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a signed-in non-member gets 404', async () => {
    signInAs(await createTestUser());
    expect((await get(org.organizationId)).status).toBe(404);
  });

  it('an admin of org A asking with org B’s id gets 404', async () => {
    const other = await makeOrg();
    signInAs(org.admin);
    expect((await get(other.organizationId)).status).toBe(404);
  });

  it('off-cloud: 404', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    signInAs(org.owner);
    expect((await get(org.organizationId)).status).toBe(404);
  });

  it('an unauthenticated call gets the session gate’s refusal', async () => {
    signInAs(null);
    expect((await get(org.organizationId)).status).toBe(401);
  });
});

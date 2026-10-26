import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';

// The org admin's Request more capacity route (Story MOTIR-9368 · MOTIR-9662):
// POST /api/organizations/[orgId]/billing/fleet-use/capacity-requests. It proves
// the session gate, the body shape (400 before any service call), the billing
// gate (owner and admin may, a member is 403, a non-member and off-cloud 404),
// the kind → own-account resolution (the merged account answers both its kinds),
// the typed refusals' statuses and codes, cross-org isolation, and that no AWS
// account id, shard id, quota code, org id or user id crosses in any body.
// Real Postgres; the sanctioned mocks are `getSession` and Sentry (the alert).

const session = { current: null as { user: { id: string; email: string } } | null };
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const { POST } =
  await import('@/app/api/organizations/[orgId]/billing/fleet-use/capacity-requests/route');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { fleetShardService } = await import('@/lib/services/fleetShardService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');

const CI_ACCOUNT = '410000000001';
const MERGED_ACCOUNT = '410000000003';
const OTHER_ACCOUNT = '410000000009';

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
  const organizationId = (
    await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
  ).organizationId;
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

let accountSeq = 0;
async function ownAccount(orgId: string, fleetKind: string, awsAccountId: string, granted = 64) {
  accountSeq += 1;
  return fleetShardService.createShard({
    name: `own-${fleetKind}-${accountSeq}`.replace(/_/g, '-'),
    fleetKind,
    provider: 'aws',
    role: 'org_owned',
    ownerOrganizationId: orgId,
    state: 'active',
    githubOrg: 'motir-fleet-use1-1',
    githubInstallationId: '9001',
    awsAccountId,
    awsRegion: 'us-east-1',
    credentialRef: `FLEET_SHARD_OWN_${accountSeq}`,
    limits: { vcpuQuota: granted },
  });
}

function post(orgId: string, body: unknown) {
  return POST(
    new Request(
      `http://localhost:3000/api/organizations/${orgId}/billing/fleet-use/capacity-requests`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ orgId }) },
  );
}

function signInAs(user: { id: string; email: string } | null) {
  session.current = user ? { user: { id: user.id, email: user.email } } : null;
}

const REASON = 'Our nightly CI fans out to two hundred jobs and waits an hour.';
const askCi = { fleetKind: 'ci_runner', desiredVcpu: 200, reason: REASON };

let host: Org;
let shardIds: string[];
const responses: string[] = [];

async function send(orgId: string, body: unknown) {
  const res = await post(orgId, body);
  const text = await res.clone().text();
  responses.push(text);
  return { status: res.status, json: JSON.parse(text) as Record<string, unknown> };
}

const rows = (organizationId: string) =>
  adminDb.fleetCapacityRequest.findMany({ where: { organizationId } });

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetCapacityRequest.deleteMany({});
  sentry.captureException.mockReset();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  host = await makeOrg();
  const ci = await ownAccount(host.organizationId, 'ci_runner', CI_ACCOUNT);
  const index = await ownAccount(host.organizationId, 'code_graph_index', MERGED_ACCOUNT, 120);
  const hoster = await ownAccount(host.organizationId, 'agent_instance', MERGED_ACCOUNT, 120);
  shardIds = [ci.id, index.id, hoster.id];
});

afterEach(() => {
  vi.unstubAllEnvs();
  session.current = null;
});

afterAll(async () => {
  // Nothing tenant-unsafe in ANY body this file produced.
  const all = responses.join('\n');
  for (const secret of [CI_ACCOUNT, MERGED_ACCOUNT, OTHER_ACCOUNT, 'L-1216C47A']) {
    expect(all).not.toContain(secret);
  }
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

function expectNoInternals(json: Record<string, unknown>, extra: string[] = []) {
  const text = JSON.stringify(json);
  for (const value of [
    CI_ACCOUNT,
    MERGED_ACCOUNT,
    OTHER_ACCOUNT,
    'L-1216C47A',
    host.organizationId,
    host.owner.id,
    host.admin.id,
    ...shardIds,
    ...extra,
  ]) {
    expect(text).not.toContain(value);
  }
}

describe('an owner or admin of a Host org', () => {
  it.each(['owner', 'admin'] as const)(
    'as the %s: 200, one open row on the org’s own CI account',
    async (who) => {
      signInAs(host[who]);
      const { status, json } = await send(host.organizationId, askCi);

      expect(status).toBe(200);
      expect(json.request).toMatchObject({
        fleetKind: 'ci_runner',
        desiredVcpu: 200,
        reasonMd: REASON,
        status: 'open',
        outcome: null,
      });
      expectNoInternals(json);
      const stored = await rows(host.organizationId);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        shardId: shardIds[0],
        status: 'open',
        requestedByUserId: host[who].id,
      });
      expect(sentry.captureException).toHaveBeenCalledTimes(1);
    },
  );

  it('the merged account answers both its kinds with one request; another figure is 409', async () => {
    signInAs(host.owner);
    const first = await send(host.organizationId, {
      fleetKind: 'code_graph_index',
      desiredVcpu: 240,
      reason: REASON,
    });
    const second = await send(host.organizationId, {
      fleetKind: 'agent_instance',
      desiredVcpu: 240,
      reason: REASON,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const id = (first.json.request as { id: string }).id;
    expect((second.json.request as { id: string }).id).toBe(id);

    const refused = await send(host.organizationId, {
      fleetKind: 'agent_instance',
      desiredVcpu: 320,
      reason: REASON,
    });
    expect(refused).toEqual({
      status: 409,
      json: { code: 'FLEET_CAPACITY_REQUEST_OPEN', requestId: id },
    });
    expect(await rows(host.organizationId)).toHaveLength(1);
  });
});

describe('who may not', () => {
  it.each([
    ['a plain member', () => host.member, 403],
    ['a signed-in non-member', null, 404],
  ] as const)('%s gets %i, and nothing is written or alerted', async (_, who, expected) => {
    signInAs(who ? who() : await createTestUser());
    const { status } = await send(host.organizationId, askCi);
    expect(status).toBe(expected);
    expect(await rows(host.organizationId)).toHaveLength(0);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('an unauthenticated call gets the session gate’s refusal', async () => {
    signInAs(null);
    const res = await post(host.organizationId, askCi);
    expect(res.status).toBe(401);
    expect(await rows(host.organizationId)).toHaveLength(0);
  });

  it('off-cloud: 404', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    signInAs(host.owner);
    const { status } = await send(host.organizationId, askCi);
    expect(status).toBe(404);
    expect(await rows(host.organizationId)).toHaveLength(0);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('an admin of org A posting to org B’s id gets 404 and B is unchanged', async () => {
    const other = await makeOrg();
    await ownAccount(other.organizationId, 'ci_runner', OTHER_ACCOUNT);
    signInAs(host.admin);
    const { status } = await send(other.organizationId, askCi);
    expect(status).toBe(404);
    expect(await rows(other.organizationId)).toHaveLength(0);
  });
});

describe('the kind and the account', () => {
  it('a kind the org owns no account of (a Pro org) is 404 and writes nothing', async () => {
    const pro = await makeOrg();
    signInAs(pro.owner);
    const { status, json } = await send(pro.organizationId, askCi);
    expect(status).toBe(404);
    expect(json).toEqual({ code: 'FLEET_CAPACITY_REQUEST_NOT_OWNED' });
    expect(await rows(pro.organizationId)).toHaveLength(0);
  });

  it('a Host org before that account exists is 404', async () => {
    await adminDb.fleetShard.deleteMany({ where: { id: shardIds[0] } });
    signInAs(host.owner);
    expect((await send(host.organizationId, askCi)).status).toBe(404);
  });

  it('a fleetKind outside the fleet kinds is 400 naming the field, never 404', async () => {
    signInAs(host.owner);
    expect(await send(host.organizationId, { ...askCi, fleetKind: 'gpu_farm' })).toEqual({
      status: 400,
      json: { code: 'FLEET_POOL_VALUE_INVALID', field: 'fleetKind' },
    });
  });
});

describe('the figure and the reason', () => {
  it.each([
    ['a non-integer figure', { desiredVcpu: 120.5 }, 'desiredVcpu'],
    ['a non-positive figure', { desiredVcpu: 0 }, 'desiredVcpu'],
    ['a figure not above the granted one', { desiredVcpu: 64 }, 'desiredVcpu'],
    ['an empty reason', { reason: '   ' }, 'reason'],
    ['an over-long reason', { reason: 'x'.repeat(2001) }, 'reason'],
  ] as const)('%s is 400 naming %s', async (_, over, field) => {
    signInAs(host.owner);
    expect(await send(host.organizationId, { ...askCi, ...over })).toEqual({
      status: 400,
      json: { code: 'FLEET_POOL_VALUE_INVALID', field },
    });
    expect(await rows(host.organizationId)).toHaveLength(0);
  });

  it.each([
    ['not JSON', '{not json', 'body'],
    ['a missing fleetKind', { desiredVcpu: 200, reason: REASON }, 'fleetKind'],
    [
      'a string figure',
      { fleetKind: 'ci_runner', desiredVcpu: '200', reason: REASON },
      'desiredVcpu',
    ],
    ['a missing reason', { fleetKind: 'ci_runner', desiredVcpu: 200 }, 'reason'],
  ] as const)(
    'a body with %s is 400 INVALID_BODY without calling the service',
    async (_, body, field) => {
      const { fleetCapacityRequestService } =
        await import('@/lib/services/fleetCapacityRequestService');
      const spy = vi.spyOn(fleetCapacityRequestService, 'requestForOrganization');
      signInAs(host.owner);
      expect(await send(host.organizationId, body)).toEqual({
        status: 400,
        json: { code: 'INVALID_BODY', field },
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    },
  );
});

// Top-up (MOTIR-9664's coverage lane): the body that is no object at all, and an
// error the route does not map.
describe('a body it cannot read, and an error it does not map', () => {
  it.each([
    ['a non-JSON body', 'not json'],
    ['a JSON array', []],
    ['JSON null', null],
  ] as const)('%s is 400 naming the body', async (_, body) => {
    signInAs(host.owner);
    const res = await post(host.organizationId, body === null ? 'null' : body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'INVALID_BODY', field: 'body' });
  });

  it('an unmapped error is rethrown, never turned into a 4xx', async () => {
    const { fleetCapacityRequestService } =
      await import('@/lib/services/fleetCapacityRequestService');
    const spy = vi
      .spyOn(fleetCapacityRequestService, 'requestForOrganization')
      .mockRejectedValue(new Error('database gone'));
    signInAs(host.owner);
    await expect(post(host.organizationId, askCi)).rejects.toThrow('database gone');
    spy.mockRestore();
  });
});

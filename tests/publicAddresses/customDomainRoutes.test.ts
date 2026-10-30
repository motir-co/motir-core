import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EntitlementExceededError } from '@/lib/billing/errors';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  AddressNotFoundError,
  HostnameTakenError,
  InvalidHostnameError,
  NotACustomerDomainError,
  PublicAddressesUnavailableError,
  SubdomainForbiddenError,
  WorkspaceNotVisibleError,
} from '@/lib/publicAddresses/errors';
import {
  CertificateProviderNotConfiguredError,
  CertificateProviderUnavailableError,
} from '@/lib/publicAddresses/certificateProvider';

// THE CUSTOMER-DOMAIN ROUTES AND THEIR ERROR MAPPER (Story MOTIR-3878 ·
// MOTIR-4223, over MOTIR-4216's routes).
//
// ⚠️ THESE FILES HAD NO TEST AT ALL, AND THE GAP HAD ALREADY COST SOMETHING.
// The gate's coverage pass measured all four route files and both mappers at
// **0%** — nothing in the repository exercised them. That is how a
// `PermissionDeniedError` arm went missing from `mapCustomDomainError` and every
// refusal on these routes answered **500 instead of 403**, until
// `tests/permissions/storyGate.test.ts` guard 3 found it by walking the tree.
// A route-shaped hole is invisible to a SERVICE test by construction: the
// service raised the right error the whole time, and only the route knows the
// mapper.
//
// The service is stubbed here on purpose. What a route owns is exactly three
// things — the gate, ONE service call, and the mapping — and every one of them
// is a decision the service cannot make. The real service is driven end to end
// by the seam tests beside this file.

const list = vi.fn();
const add = vi.fn();
const verify = vi.fn();
const remove = vi.fn();
vi.mock('@/lib/services/customDomainService', () => ({
  customDomainService: { list, add, verify, remove },
}));

const getWorkspaceContext = vi.fn();
vi.mock('@/lib/workspaces', () => ({ getWorkspaceContext }));

const refuseIfNonCompliant = vi.fn();
vi.mock('@/lib/auth/requireCompliantSession', () => ({ refuseIfNonCompliant }));

const { GET, POST } = await import('@/app/api/projects/[key]/public-addresses/route');
const { DELETE } = await import('@/app/api/projects/[key]/public-addresses/[addressId]/route');
const { POST: VERIFY } =
  await import('@/app/api/projects/[key]/public-addresses/[addressId]/verify/route');

const CTX = { userId: 'u_1', workspaceId: 'ws_1' };
const req = (body?: unknown) =>
  new Request('https://app.motir.co/api/projects/PROD/public-addresses', {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const keyParams = { params: Promise.resolve({ key: 'PROD' }) };
const addressParams = { params: Promise.resolve({ key: 'PROD', addressId: 'addr_1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  getWorkspaceContext.mockResolvedValue(CTX);
  refuseIfNonCompliant.mockResolvedValue(null);
});

describe('the gate runs before the service, on every route', () => {
  it.each([
    ['GET list', () => GET(new Request('https://app.motir.co/x'), keyParams)],
    ['POST add', () => POST(req({ hostname: 'a.example' }), keyParams)],
    ['POST verify', () => VERIFY(new Request('https://app.motir.co/x'), addressParams)],
    ['DELETE remove', () => DELETE(new Request('https://app.motir.co/x'), addressParams)],
  ])('%s answers 401 with no session, and calls nothing', async (_label, call) => {
    getWorkspaceContext.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(401);
    for (const fn of [list, add, verify, remove]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe('the happy paths hand through exactly one service call', () => {
  it('GET lists, POST adds with the hostname from the body', async () => {
    list.mockResolvedValue([]);
    expect((await GET(new Request('https://app.motir.co/x'), keyParams)).status).toBe(200);
    expect(list).toHaveBeenCalledWith({ key: 'PROD', actorUserId: 'u_1', ctx: CTX });

    add.mockResolvedValue({ id: 'addr_1' });
    const res = await POST(req({ hostname: 'roadmap.acme.com' }), keyParams);
    expect(res.status).toBe(201);
    expect(add).toHaveBeenCalledWith({
      key: 'PROD',
      hostname: 'roadmap.acme.com',
      actorUserId: 'u_1',
      ctx: CTX,
    });
  });

  it('DELETE answers 204 with NO body', async () => {
    remove.mockResolvedValue(undefined);
    const removed = await DELETE(new Request('https://app.motir.co/x'), addressParams);
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe('');
    // The key reaches the service: it is the permission gate (MOTIR-9523).
    expect(remove).toHaveBeenCalledWith({
      key: 'PROD',
      addressId: 'addr_1',
      actorUserId: 'u_1',
      ctx: CTX,
    });
  });

  it('refuses a POST with no hostname before reaching the service', async () => {
    expect((await POST(req({}), keyParams)).status).toBe(400);
    expect((await POST(req('not an object'), keyParams)).status).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });

  it('refuses a POST whose body is not JSON at all', async () => {
    const res = await POST(
      new Request('https://app.motir.co/x', { method: 'POST', body: '{oops' }),
      keyParams,
    );
    expect(res.status).toBe(400);
  });
});

describe('THE MAPPER — every typed refusal reaches its own status', () => {
  // ⚠️ THE TABLE IS THE POINT. Each row is a decision recorded in
  // `lib/publicAddresses/errorResponse.ts`, and a status that silently becomes
  // 500 is the failure this whole file exists for.
  it.each([
    // The two the GATE itself raises — and the pair that was MISSING.
    [new ProjectNotFoundError('PROD'), 404],
    [new PermissionDeniedError('proj_1', 'project:manage_access'), 403],
    // 404 for off-cloud and for a workspace the actor cannot see: the same code
    // for two reasons, so a caller cannot tell a self-hosted build from a
    // workspace they may not know exists.
    [new PublicAddressesUnavailableError(), 404],
    [new WorkspaceNotVisibleError(), 404],
    [new AddressNotFoundError(), 404],
    // 403 for a member who is not an admin: they can SEE the workspace, so
    // saying the control is admin-only leaks nothing.
    [new SubdomainForbiddenError(), 403],
    [new HostnameTakenError('roadmap.acme.com'), 409],
    [new InvalidHostnameError('not a host'), 422],
    [new NotACustomerDomainError('acme.motir.site'), 422],
    // The billing surface's own shape, so one refusal does not render two ways.
    [new EntitlementExceededError('custom_domains', { limit: 0, usage: 0 }), 402],
    // Ours to retry, never the caller's to fix.
    [new CertificateProviderUnavailableError('fly'), 503],
    [new CertificateProviderNotConfiguredError(['FLY_CERTS_TOKEN']), 503],
  ])('%s', async (error, status) => {
    verify.mockRejectedValue(error);
    const res = await VERIFY(new Request('https://app.motir.co/x'), addressParams);
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toContain('application/json');
    // Every refusal on this surface answers `{ code }` — a consumer that had to
    // parse two error shapes off one surface would parse neither reliably.
    expect(await res.json()).toHaveProperty('code');
  });

  it('an UNKNOWN error is RETHROWN, so the platform logs a genuine 500', async () => {
    // A mapper that swallowed everything would turn a database outage into a
    // 422 the customer is invited to fix by editing their hostname.
    remove.mockRejectedValue(new Error('the database fell over'));
    await expect(DELETE(new Request('https://app.motir.co/x'), addressParams)).rejects.toThrow(
      'the database fell over',
    );
  });

  it('and the mapper is shared, so the same error answers alike on every route', async () => {
    // The lifecycle mapper falls through to the subdomain one for everything
    // that surface already maps — two mappers answering one typed error two
    // ways is the drift this arrangement prevents.
    const statuses: number[] = [];
    for (const call of [
      () => POST(req({ hostname: 'a.example' }), keyParams),
      () => VERIFY(new Request('https://app.motir.co/x'), addressParams),
      () => DELETE(new Request('https://app.motir.co/x'), addressParams),
    ]) {
      for (const fn of [add, verify, remove]) {
        fn.mockRejectedValue(new SubdomainForbiddenError());
      }
      statuses.push((await call()).status);
    }
    expect(statuses).toEqual([403, 403, 403]);
  });
});

describe('the compliance hold', () => {
  it('stops a WRITE before the service, and never a read', async () => {
    // `refuseIfNonCompliant` is the re-consent hold. A read is not a write, so
    // the list keeps answering while a hold is in force.
    refuseIfNonCompliant.mockResolvedValue(
      new Response(null, { status: 451 }) as unknown as Response,
    );
    expect((await POST(req({ hostname: 'a.example' }), keyParams)).status).toBe(451);
    expect(add).not.toHaveBeenCalled();

    list.mockResolvedValue([]);
    expect((await GET(new Request('https://app.motir.co/x'), keyParams)).status).toBe(200);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HostnameTakenError,
  NameQuarantinedError,
  NoSubdomainClaimedError,
  ReservedLabelError,
  SubdomainChangeLimitError,
  SubdomainForbiddenError,
  SubdomainNotFoundError,
  WorkspaceNotVisibleError,
} from '@/lib/publicAddresses/errors';
import { TenantDomainNotConfiguredError } from '@/lib/publicAddresses/tenantDomain';

// THE SUBDOMAIN ROUTE (Story MOTIR-3878 · MOTIR-4223, over MOTIR-4215's route).
//
// ⚠️ ANOTHER FILE AT 0%. The gate's coverage pass found this route untested
// alongside the four lifecycle ones — and it is the one carrying the story's
// most unusual decision: ONE verb that CLAIMS or RENAMES depending on server
// state. That branch cannot be tested from the service, which keeps the two
// acts distinct internally; only the route decides which one a `PUT` becomes.

const getForWorkspace = vi.fn();
const claim = vi.fn();
const rename = vi.fn();
const release = vi.fn();
vi.mock('@/lib/services/publicSubdomainService', () => ({
  publicSubdomainService: { getForWorkspace, claim, rename, release },
  roleMayManageAddress: () => true,
}));

const getWorkspaceContext = vi.fn();
vi.mock('@/lib/workspaces', () => ({ getWorkspaceContext }));

const refuseIfNonCompliant = vi.fn();
vi.mock('@/lib/auth/requireCompliantSession', () => ({ refuseIfNonCompliant }));

const { GET, PUT, DELETE } =
  await import('@/app/api/workspaces/[workspaceId]/public-subdomain/route');

const CTX = { userId: 'u_1', workspaceId: 'ws_1' };
const params = { params: Promise.resolve({ workspaceId: 'ws_1' }) };
const put = (body?: unknown) =>
  new Request('https://app.motir.co/x', {
    method: 'PUT',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const DTO = {
  label: 'acme',
  hostname: 'acme.motir.site',
  url: 'https://acme.motir.site',
  claimedAt: '2026-09-01T00:00:00.000Z',
  nextChangeAllowedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  getWorkspaceContext.mockResolvedValue(CTX);
  refuseIfNonCompliant.mockResolvedValue(null);
});

describe('GET', () => {
  it('answers the DTO, and `null` for a workspace that has never claimed one', async () => {
    // ⚠️ `null` IS AN ANSWER, NOT AN ABSENCE. The pane renders its unclaimed
    // state from it; a 404 here would make "no subdomain yet" look like "no such
    // workspace", which is a different thing with a different next action.
    getForWorkspace.mockResolvedValue(null);
    const res = await GET(new Request('https://app.motir.co/x'), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it('carries the next-change date, so the pane can say when a change is allowed', async () => {
    getForWorkspace.mockResolvedValue({ ...DTO, nextChangeAllowedAt: '2026-11-27T00:00:00.000Z' });
    expect(await (await GET(new Request('https://app.motir.co/x'), params)).json()).toMatchObject({
      nextChangeAllowedAt: '2026-11-27T00:00:00.000Z',
    });
  });

  it('401s with no session and asks the service nothing', async () => {
    getWorkspaceContext.mockResolvedValue(null);
    expect((await GET(new Request('https://app.motir.co/x'), params)).status).toBe(401);
    expect(getForWorkspace).not.toHaveBeenCalled();
  });
});

describe('PUT — ONE verb, two acts, decided by server state', () => {
  it('CLAIMS with 201 when the workspace has none', async () => {
    getForWorkspace.mockResolvedValue(null);
    claim.mockResolvedValue(DTO);

    const res = await PUT(put({ label: 'acme' }), params);

    expect(res.status).toBe(201);
    expect(claim).toHaveBeenCalledWith('ws_1', 'acme', 'u_1');
    expect(rename).not.toHaveBeenCalled();
  });

  it('RENAMES with 200 when it already has one', async () => {
    // The status code is the observable difference, and it is the honest one: a
    // rename creates nothing.
    getForWorkspace.mockResolvedValue(DTO);
    rename.mockResolvedValue({ ...DTO, label: 'acme-inc' });

    const res = await PUT(put({ label: 'acme-inc' }), params);

    expect(res.status).toBe(200);
    expect(rename).toHaveBeenCalledWith('ws_1', 'acme-inc', 'u_1');
    expect(claim).not.toHaveBeenCalled();
  });

  it('refuses a body with no label before deciding anything', async () => {
    for (const body of [{}, { label: 42 }, 'nope']) {
      expect((await PUT(put(body), params)).status).toBe(400);
    }
    expect(
      (await PUT(new Request('https://app.motir.co/x', { method: 'PUT', body: '{' }), params))
        .status,
    ).toBe(400);
    expect(getForWorkspace).not.toHaveBeenCalled();
  });

  it('passes the two DATED refusals through with their dates', async () => {
    getForWorkspace.mockResolvedValue(DTO);
    rename.mockRejectedValue(new SubdomainChangeLimitError(new Date('2026-11-27T00:00:00Z')));
    const limited = await PUT(put({ label: 'acme-inc' }), params);
    expect(limited.status).toBe(409);
    expect(await limited.json()).toMatchObject({ nextAllowedAt: '2026-11-27T00:00:00.000Z' });

    getForWorkspace.mockResolvedValue(null);
    claim.mockRejectedValue(
      new NameQuarantinedError('held.motir.site', new Date('2027-01-26T00:00:00Z')),
    );
    const held = await PUT(put({ label: 'held' }), params);
    expect(held.status).toBe(409);
    expect(await held.json()).toMatchObject({ returnsAt: '2027-01-26T00:00:00.000Z' });
  });

  it('is held by the compliance gate before it reads anything', async () => {
    refuseIfNonCompliant.mockResolvedValue(new Response(null, { status: 451 }));
    expect((await PUT(put({ label: 'acme' }), params)).status).toBe(451);
    expect(getForWorkspace).not.toHaveBeenCalled();
  });
});

describe('the mapper, on this surface', () => {
  it.each([
    [new WorkspaceNotVisibleError(), 404],
    [new SubdomainForbiddenError(), 403],
    [new HostnameTakenError('acme.motir.site'), 409],
    [new NoSubdomainClaimedError(), 409],
    [new ReservedLabelError('admin', 'reserved'), 422],
    [new NameQuarantinedError('acme.motir.site', new Date('2027-01-01T00:00:00Z')), 409],
    [new SubdomainChangeLimitError(new Date('2026-11-01T00:00:00Z')), 409],
    // An OPERATOR problem, never the caller's — and the one case here where
    // retrying later may work.
    [new TenantDomainNotConfiguredError(), 503],
  ])('%s', async (error, status) => {
    getForWorkspace.mockRejectedValue(error);
    const res = await GET(new Request('https://app.motir.co/x'), params);
    expect(res.status).toBe(status);
    expect(await res.json()).toHaveProperty('code');
  });

  it('carries the REFUSAL DISCRIMINATOR out to the caller', async () => {
    // The pane maps `refusal` to completely different copy — telling someone
    // `Admin` is "reserved" sends them looking for a name they do not need.
    // Dropping it at the route would make the wire honest and the pane wrong.
    getForWorkspace.mockRejectedValue(new ReservedLabelError('Admin', 'bad_grammar'));
    const res = await GET(new Request('https://app.motir.co/x'), params);
    expect(await res.json()).toMatchObject({ code: 'RESERVED_LABEL', refusal: 'bad_grammar' });
  });

  it('and the two DATED refusals carry their dates as ISO strings', async () => {
    // A refusal that ends on a known date says when (§8 Amendment 3). Dropping
    // the date at the route would leave the pane able to say only "no".
    getForWorkspace.mockRejectedValue(
      new NameQuarantinedError('acme.motir.site', new Date('2027-01-01T00:00:00Z')),
    );
    expect(await (await GET(new Request('https://app.motir.co/x'), params)).json()).toMatchObject({
      code: 'NAME_QUARANTINED',
      hostname: 'acme.motir.site',
      returnsAt: '2027-01-01T00:00:00.000Z',
    });
    getForWorkspace.mockRejectedValue(
      new SubdomainChangeLimitError(new Date('2026-11-01T00:00:00Z')),
    );
    expect(await (await GET(new Request('https://app.motir.co/x'), params)).json()).toMatchObject({
      code: 'SUBDOMAIN_CHANGE_LIMIT',
      nextAllowedAt: '2026-11-01T00:00:00.000Z',
    });
  });

  it('rethrows what it does not know, so a real fault is a real 500', async () => {
    getForWorkspace.mockRejectedValue(new Error('the database fell over'));
    await expect(GET(new Request('https://app.motir.co/x'), params)).rejects.toThrow(
      'the database fell over',
    );
  });
});

// ── DELETE — RELEASE (Story MOTIR-4451 · Subtask MOTIR-4454, ADR §8 Am. 2) ──

describe('DELETE', () => {
  const del = () => new Request('https://app.motir.co/x', { method: 'DELETE' });

  it('answers 200 with the date the name returns, and calls release exactly once', async () => {
    // The pane states the date (story rule 5), and once the row is gone GET has
    // nothing to read it from — so DELETE carries it.
    release.mockResolvedValue({ returnsAt: '2027-01-26T00:00:00.000Z' });
    const res = await DELETE(del(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ returnsAt: '2027-01-26T00:00:00.000Z' });
    expect(release).toHaveBeenCalledExactlyOnceWith('ws_1', 'u_1');
  });

  it('answers `returnsAt: null` when the name returned at once', async () => {
    release.mockResolvedValue({ returnsAt: null });
    expect(await (await DELETE(del(), params)).json()).toEqual({ returnsAt: null });
  });

  it('answers 404 when the workspace has no subdomain — NOT the rename path 409', async () => {
    // Two typed errors, two statuses, one mapping each. A `DELETE` names a
    // resource, so absent is 404; `PUT`'s rename refuses a premise, so 409.
    release.mockRejectedValue(new SubdomainNotFoundError());
    const res = await DELETE(del(), params);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'SUBDOMAIN_NOT_FOUND' });

    rename.mockRejectedValue(new NoSubdomainClaimedError());
    getForWorkspace.mockResolvedValue(DTO);
    expect((await PUT(put({ label: 'acme' }), params)).status).toBe(409);
  });

  it('refuses a member who may not manage addresses, exactly as PUT does', async () => {
    release.mockRejectedValue(new SubdomainForbiddenError());
    expect((await DELETE(del(), params)).status).toBe(403);
  });

  it('answers 404 to a NON-MEMBER, leaking no existence', async () => {
    release.mockRejectedValue(new WorkspaceNotVisibleError());
    expect((await DELETE(del(), params)).status).toBe(404);
  });

  it('401s with no session and asks the service nothing', async () => {
    getWorkspaceContext.mockResolvedValue(null);
    expect((await DELETE(del(), params)).status).toBe(401);
    expect(release).not.toHaveBeenCalled();
  });

  it('is held by the compliance gate before it releases anything', async () => {
    refuseIfNonCompliant.mockResolvedValue(new Response(null, { status: 451 }));
    expect((await DELETE(del(), params)).status).toBe(451);
    expect(release).not.toHaveBeenCalled();
  });

  it('rethrows what it does not know, so a real fault is a real 500', async () => {
    release.mockRejectedValue(new Error('boom'));
    await expect(DELETE(del(), params)).rejects.toThrow('boom');
  });
});

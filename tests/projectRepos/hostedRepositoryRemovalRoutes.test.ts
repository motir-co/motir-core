import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HostedRepositoryCheckFailedError,
  HostedRepositoryDeletionError,
  ProjectRepoRemovalBlockedError,
} from '@/lib/projectRepos/errors';

// The two doors of a hosted delete (MOTIR-11981; design repository-set §19) — the
// TRANSPORT contract only: the session gate, the service each calls, and the
// typed-error → status mapping the confirm reads. The service itself is pinned in
// `hostedRepositoryRemovalService.test.ts` over real Postgres.

const { requireCompliantWorkspaceContext, service } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
  service: { getRemovalImpact: vi.fn(), remove: vi.fn() },
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));
vi.mock('@/lib/services/hostedRepositoryRemovalService', () => ({
  hostedRepositoryRemovalService: service,
}));

const { GET } = await import('@/app/api/projects/[key]/repositories/[rowId]/removal/route');
const { DELETE } = await import('@/app/api/projects/[key]/repositories/[rowId]/route');

const ctx = { userId: 'u1', workspaceId: 'w1' };
const params = { params: Promise.resolve({ rowId: 'row1' }) };
const req = (method: string) =>
  new Request('http://localhost/api/projects/PROD/repositories/row1/removal', { method });

beforeEach(() => {
  requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx });
});
afterEach(() => vi.clearAllMocks());

describe('GET …/repositories/[rowId]/removal', () => {
  it('answers the gate’s own response with no session, reading nothing', async () => {
    requireCompliantWorkspaceContext.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    });
    expect((await GET(req('GET'), params)).status).toBe(401);
    expect(service.getRemovalImpact).not.toHaveBeenCalled();
  });

  it('returns the blast radius the service reads', async () => {
    const impact = {
      repository: 'motir',
      production: null,
      previews: 0,
      environmentValues: 1,
      openWorkItems: 0,
      destructive: true,
    };
    service.getRemovalImpact.mockResolvedValue(impact);
    const res = await GET(req('GET'), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(impact);
    expect(service.getRemovalImpact).toHaveBeenCalledWith('row1', ctx);
  });

  it('maps a GitHub that cannot answer to 502 and a hand-off in flight to 409', async () => {
    service.getRemovalImpact.mockRejectedValueOnce(new HostedRepositoryCheckFailedError('boom'));
    const failed = await GET(req('GET'), params);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ code: 'HOSTED_REPOSITORY_CHECK_FAILED' });

    service.getRemovalImpact.mockRejectedValueOnce(new ProjectRepoRemovalBlockedError('row1'));
    const blocked = await GET(req('GET'), params);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: 'PROJECT_REPO_REMOVAL_BLOCKED' });
  });

  it('rethrows an error it has no mapping for', async () => {
    service.getRemovalImpact.mockRejectedValueOnce(new Error('unmapped'));
    await expect(GET(req('GET'), params)).rejects.toThrow('unmapped');
  });
});

describe('DELETE …/repositories/[rowId]', () => {
  it('runs the hosted delete and answers 204', async () => {
    service.remove.mockResolvedValue(undefined);
    expect((await DELETE(req('DELETE'), params)).status).toBe(204);
    expect(service.remove).toHaveBeenCalledWith('row1', ctx);
  });

  it('answers 502 naming the unfinished delete when a step fails', async () => {
    service.remove.mockRejectedValueOnce(new HostedRepositoryDeletionError('repository', '403'));
    const res = await DELETE(req('DELETE'), params);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'HOSTED_REPOSITORY_DELETION_UNFINISHED' });
  });
});

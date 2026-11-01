// MOTIR-5779 — the preview gate's database half on real Postgres: who
// preview-access admits (the `project:browse` PERMISSION, resolved by the shipped
// resolver — a custom role that carries it is let in, roles that lack it are
// not), the admission working once, where a ready preview's requests go, and
// what a non-ready preview's page shows.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { resetHostingFakes } from '@/lib/orchestrator/hosting';
import {
  ADMISSION_TTL_MS,
  PREVIEW_AUTH_PATH,
  mintAdmission,
  verifyGatePass,
} from '@/lib/preview/gate';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { projectMembersService } from '@/lib/services/projectMembersService';
import {
  PREVIEW_ROUTE_CACHE_MS,
  previewAccessUrl,
  previewGateService,
  resetPreviewRouteCache,
} from '@/lib/services/previewGateService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { CUSTOM_WORKSPACE_ROLE_TIER } from '@/lib/workspaces/roles';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { PREVIEW_HOST, makePreviewGateFixture } from '../helpers/previewGateFixture';

const KEY = 'test-gate-signing-key';

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.previewGateAdmission.deleteMany();
  resetHostingFakes();
  resetPreviewRouteCache();
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_PREVIEW_DOMAIN', 'preview.motir.site');
  vi.stubEnv('MOTIR_HOSTING_GATE_SIGNING_KEY', KEY);
  vi.stubEnv('MOTIR_BASE_URL', 'https://app.motir.co');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function user(tag: string) {
  return usersService.createUser({ email: `${tag}@ex.com`, password: 'hunter2hunter2', name: tag });
}

/** Put a workspace member on a brand-new workspace custom role. */
async function onCustomRole(workspaceId: string, userId: string, permissions: string[]) {
  const definition = await adminDb.workspaceRoleDefinition.create({
    data: { workspaceId, name: `Role ${permissions.join('+') || 'none'}`, permissions },
  });
  await adminDb.$transaction((tx) =>
    workspaceMembershipRepository.setWorkspaceRole(
      userId,
      workspaceId,
      { workspaceRole: CUSTOM_WORKSPACE_ROLE_TIER, roleDefinitionId: definition.id },
      tx,
    ),
  );
}

function tokenOf(url: string): string {
  return new URL(url).searchParams.get('token')!;
}

describe('admit — preview-access lets in exactly who holds project:browse', () => {
  it('admits a user whose CUSTOM role carries project:browse, with a token for this host', async () => {
    const p = await makePreviewGateFixture();
    const contractor = await user('contractor');
    await workspacesService.addMember({ userId: contractor.id, workspaceId: p.fx.workspaceId });
    await onCustomRole(p.fx.workspaceId, contractor.id, ['project:browse']);

    const result = await previewGateService.admit({
      userId: contractor.id,
      host: PREVIEW_HOST,
      returnPath: '/invoices?status=open',
    });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    const url = new URL(result.url);
    expect(url.origin).toBe(`https://${PREVIEW_HOST}`);
    expect(url.pathname).toBe(PREVIEW_AUTH_PATH);
    expect(url.searchParams.get('return')).toBe('/invoices?status=open');
    // The token is redeemable here once.
    const consumed = await previewGateService.consumeAdmission(tokenOf(result.url), PREVIEW_HOST);
    expect(consumed.ok).toBe(true);
  });

  it('refuses a signed-in workspace member whose custom role LACKS project:browse', async () => {
    const p = await makePreviewGateFixture();
    const commenter = await user('commenter');
    await workspacesService.addMember({ userId: commenter.id, workspaceId: p.fx.workspaceId });
    await onCustomRole(p.fx.workspaceId, commenter.id, ['comment:add']);
    expect(
      await previewGateService.admit({ userId: commenter.id, host: PREVIEW_HOST, returnPath: '/' }),
    ).toEqual({ admitted: false });
  });

  it('refuses a built-in workspace member not added to a members-only project', async () => {
    const p = await makePreviewGateFixture();
    await projectMembersService.setAccessMode({
      key: p.fx.projectIdentifier,
      actorUserId: p.fx.ownerId,
      ctx: p.fx.ctx,
      mode: 'members',
    });
    const outsider = await user('outsider');
    await workspacesService.addMember({ userId: outsider.id, workspaceId: p.fx.workspaceId });
    expect(
      await previewGateService.admit({ userId: outsider.id, host: PREVIEW_HOST, returnPath: '/' }),
    ).toEqual({ admitted: false });
    // …while the project's owner, who browses it, is let in.
    expect(
      (
        await previewGateService.admit({
          userId: p.fx.ownerId,
          host: PREVIEW_HOST,
          returnPath: '/',
        })
      ).admitted,
    ).toBe(true);
  });

  it('refuses the member of a DIFFERENT project and workspace, and a stranger', async () => {
    await makePreviewGateFixture();
    const elsewhere = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const stranger = await user('stranger');
    for (const userId of [elsewhere.ownerId, stranger.id]) {
      expect(
        await previewGateService.admit({ userId, host: PREVIEW_HOST, returnPath: '/' }),
      ).toEqual({ admitted: false });
    }
  });

  it('refuses a host that holds no preview and one that is not a preview host, alike', async () => {
    const p = await makePreviewGateFixture();
    for (const host of ['pr-99--portal.preview.motir.site', 'app.motir.co', 'evil.example', '']) {
      expect(
        await previewGateService.admit({ userId: p.fx.ownerId, host, returnPath: '/' }),
        host,
      ).toEqual({ admitted: false });
    }
  });

  it('carries only a safe return path into the admission URL', async () => {
    const p = await makePreviewGateFixture();
    for (const returnPath of ['https://evil.example/x', '//evil.example', '/%2F%2Fevil.example']) {
      const result = await previewGateService.admit({
        userId: p.fx.ownerId,
        host: PREVIEW_HOST,
        returnPath,
      });
      expect(result.admitted && new URL(result.url).searchParams.get('return')).toBe('/');
    }
  });
});

describe('consumeAdmission — the admission works once', () => {
  it('sets a pass for this host, and refuses the same admission the second time', async () => {
    const now = new Date();
    const { token } = mintAdmission({ host: PREVIEW_HOST, sub: 'user-1' }, KEY, now);
    const first = await previewGateService.consumeAdmission(token, PREVIEW_HOST, now);
    expect(first.ok).toBe(true);
    expect(first.ok && verifyGatePass(first.cookie, PREVIEW_HOST, KEY, now)).toMatchObject({
      sub: 'user-1',
    });
    expect(await previewGateService.consumeAdmission(token, PREVIEW_HOST, now)).toEqual({
      ok: false,
      refusal: 'consumed',
    });
  });

  it('refuses another host’s, an expired and a tampered admission without recording them', async () => {
    const now = new Date();
    const { token } = mintAdmission({ host: PREVIEW_HOST, sub: 'u' }, KEY, now);
    expect(
      await previewGateService.consumeAdmission(token, 'pr-15--portal.preview.motir.site', now),
    ).toEqual({ ok: false, refusal: 'other_host' });
    expect(
      await previewGateService.consumeAdmission(
        token,
        PREVIEW_HOST,
        new Date(now.getTime() + ADMISSION_TTL_MS),
      ),
    ).toEqual({ ok: false, refusal: 'expired' });
    expect(await previewGateService.consumeAdmission(`${token}x`, PREVIEW_HOST, now)).toEqual({
      ok: false,
      refusal: 'tampered',
    });
    expect(await adminDb.previewGateAdmission.count()).toBe(0);
  });

  it('deletes the records of admissions that have expired', async () => {
    await adminDb.previewGateAdmission.create({
      data: { jti: 'old', host: PREVIEW_HOST, expiresAt: new Date(Date.now() - 1000) },
    });
    const { token } = mintAdmission({ host: PREVIEW_HOST, sub: 'u' }, KEY);
    await previewGateService.consumeAdmission(token, PREVIEW_HOST);
    expect((await adminDb.previewGateAdmission.findMany()).map((r) => r.jti)).not.toContain('old');
    expect(await adminDb.previewGateAdmission.count()).toBe(1);
  });
});

describe('route — where a ready preview’s requests go', () => {
  it('names the release’s address and its origin secret, and caches it briefly', async () => {
    const p = await makePreviewGateFixture();
    const route = await previewGateService.route(PREVIEW_HOST, 1_000);
    expect(route).toMatchObject({ state: 'ready', target: 'fly' });
    expect(route?.upstream?.origin).toBe(`https://${p.appRef}.fake.invalid`);
    expect(route?.upstream?.credential).toBe('origin_secret');
    expect(Object.keys(route?.upstream?.headers ?? {})).toEqual(['X-Motir-Origin-Secret']);

    await adminDb.previewDeployment.update({
      where: { id: p.previewId },
      data: { state: 'closed' },
    });
    expect(
      (await previewGateService.route(PREVIEW_HOST, 1_000 + PREVIEW_ROUTE_CACHE_MS - 1))?.state,
    ).toBe('ready');
    expect(
      (await previewGateService.route(PREVIEW_HOST, 1_000 + PREVIEW_ROUTE_CACHE_MS))?.state,
    ).toBe('closed');
  });

  it('has no upstream for a row that is not ready, and no route for a missing host', async () => {
    await makePreviewGateFixture({ state: 'building' });
    expect(await previewGateService.route(PREVIEW_HOST)).toEqual({
      state: 'building',
      target: 'fly',
      upstream: null,
    });
    expect(await previewGateService.route('pr-99--portal.preview.motir.site')).toBeNull();
  });
});

describe('view — what a non-ready preview’s page shows', () => {
  it('names the pull request, and the work item it delivers when one is linked', async () => {
    const p = await makePreviewGateFixture({ state: 'building' });
    expect(await previewGateService.view(PREVIEW_HOST)).toMatchObject({
      host: PREVIEW_HOST,
      state: 'building',
      repository: 'motir-projects/portal',
      pullRequestNumber: 14,
      pullRequestUrl: 'https://github.com/motir-projects/portal/pull/14',
      workItem: null,
      closedReason: null,
    });

    const workItem = await createTestWorkItem(p.fx, {
      kind: 'task',
      title: 'Let customers export invoices as CSV',
    });
    const pull = await adminDb.githubPullRequest.create({
      data: {
        repoId: p.githubRepoId,
        number: 14,
        state: 'open',
        merged: false,
        headRef: 'feature',
      } as never,
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: p.fx.workspaceId,
        workItemId: workItem.id,
        githubPullRequestId: pull.id,
        repoId: p.githubRepoId,
      },
    });
    const view = await previewGateService.view(PREVIEW_HOST);
    expect(view?.workItem).toEqual({
      identifier: workItem.identifier,
      title: workItem.title,
      url: `https://app.motir.co/items/${workItem.identifier}`,
    });
  });

  it('derives why a closed preview closed: merged, closed, taken over, or unknown', async () => {
    const p = await makePreviewGateFixture({ state: 'closed' });
    expect((await previewGateService.view(PREVIEW_HOST))?.closedReason).toBe('unknown');

    await adminDb.projectRepo.update({
      where: { id: p.projectRepoId },
      data: { takeoverState: 'done' },
    });
    expect((await previewGateService.view(PREVIEW_HOST))?.closedReason).toBe('takenOver');

    const pull = await adminDb.githubPullRequest.create({
      data: {
        repoId: p.githubRepoId,
        number: 14,
        state: 'closed',
        merged: false,
        headRef: 'f',
      } as never,
    });
    expect((await previewGateService.view(PREVIEW_HOST))?.closedReason).toBe('closed');
    await adminDb.githubPullRequest.update({ where: { id: pull.id }, data: { merged: true } });
    expect((await previewGateService.view(PREVIEW_HOST))?.closedReason).toBe('merged');
  });

  it('shows the failure reason only on a failed row, and nothing for a missing host', async () => {
    await makePreviewGateFixture({
      state: 'failed',
      failureReason: 'The preview started but failed its health check.',
    });
    expect((await previewGateService.view(PREVIEW_HOST))?.failureReason).toBe(
      'The preview started but failed its health check.',
    );
    expect(await previewGateService.view('pr-99--portal.preview.motir.site')).toBeNull();
  });
});

describe('a preview whose repository row is gone', () => {
  it('routes nowhere and still has a page, naming nothing it cannot read', async () => {
    const p = await makePreviewGateFixture();
    await adminDb.projectRepo.delete({ where: { id: p.projectRepoId } });
    expect(await previewGateService.route(PREVIEW_HOST)).toEqual({
      state: 'ready',
      target: null,
      upstream: null,
    });
    expect(await previewGateService.view(PREVIEW_HOST)).toMatchObject({
      state: 'ready',
      repository: '/',
      closedReason: null,
    });
    expect(
      await previewGateService.admit({ userId: p.fx.ownerId, host: PREVIEW_HOST, returnPath: '/' }),
    ).toEqual({ admitted: false });
  });

  it('a ready row whose release is gone has no upstream', async () => {
    const p = await makePreviewGateFixture();
    await adminDb.previewDeployment.update({
      where: { id: p.previewId },
      data: { flyAppName: 'mh-nothing-here' },
    });
    expect((await previewGateService.route(PREVIEW_HOST))?.upstream).toBeNull();
  });
});

describe('previewAccessUrl', () => {
  it('points at app.motir.co with the host and a safe return', () => {
    const url = new URL(previewAccessUrl(PREVIEW_HOST, '//evil.example'));
    expect(url.origin).toBe('https://app.motir.co');
    expect(url.pathname).toBe('/preview-access');
    expect(url.searchParams.get('host')).toBe(PREVIEW_HOST);
    expect(url.searchParams.get('return')).toBe('/');
  });
});

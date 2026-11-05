import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { safeEnvironmentUrl } from '@/lib/services/repoDeploymentService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { githubWebhookInboxService } from '@/lib/services/githubWebhookInboxService';
import { spyOnJobDispatch } from '../helpers/jobs';

// Preview deployments are INGESTED (Story MOTIR-4906 · MOTIR-5329) — a
// `deployment_status` delivery through the real route and service, on real
// Postgres. The cases are the ones a plausible implementation gets wrong:
// out-of-order delivery (a late `in_progress` overwriting `success`), a
// `javascript:` URL stored and later rendered as a link, and an ingestion path
// that quietly calls GitHub back.

const SECRET = 'test-webhook-secret';
const INSTALLATION_ID = 'inst-deploy';
const REPO_PROVIDER_ID = '777';
const SHA = 'd'.repeat(40);

function deliveryBody(over: {
  deploymentId?: number;
  state?: string;
  environment?: string;
  url?: string | null;
  at?: string;
  sha?: string;
  ref?: string;
  repoId?: number;
  installationId?: string;
}) {
  return {
    action: 'created',
    deployment_status: {
      id: Math.floor(Math.random() * 1e9),
      state: over.state ?? 'success',
      environment: over.environment ?? 'Preview',
      environment_url: over.url === undefined ? 'https://acme-git-feat.vercel.app' : over.url,
      target_url: 'https://vercel.com/logs/1',
      created_at: over.at ?? '2026-09-13T10:00:00Z',
      updated_at: over.at ?? '2026-09-13T10:00:00Z',
    },
    deployment: {
      id: over.deploymentId ?? 1,
      sha: over.sha ?? SHA,
      ref: over.ref ?? 'feat/MOTIR-7-change',
      environment: over.environment ?? 'Preview',
    },
    repository: { id: over.repoId ?? Number(REPO_PROVIDER_ID) },
    installation: { id: over.installationId ?? INSTALLATION_ID },
  };
}

const DELIVERY_ID = 'deployment-status-route-delivery';

function signedPost(body: unknown): NextRequest {
  const raw = JSON.stringify(body);
  return new NextRequest('http://localhost/api/github/webhook', {
    method: 'POST',
    body: raw,
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'deployment_status',
      'x-github-delivery': DELIVERY_ID,
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`,
    },
  });
}

async function connectedWorkspace() {
  const user = await usersService.createUser({
    email: 'owner@ex.com',
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: REPO_PROVIDER_ID,
        owner: 'moooon',
        name: 'acme',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const repo = await adminDb.githubRepo.findFirstOrThrow({ where: { repoId: REPO_PROVIDER_ID } });
  return { user, workspace, repo, ctx: { userId: user.id, workspaceId: workspace.id } };
}

/** Any outbound HTTP on the ingestion path is a defect — fail loudly and record it. */
const fetchSpy = vi.fn(async () => {
  throw new Error('ingestion made an outbound HTTP call');
});

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function deployments() {
  return adminDb.repoDeployment.findMany({ orderBy: { createdAt: 'asc' } });
}

describe('POST /api/github/webhook — deployment_status', () => {
  it('writes a repo_deployment row for a connected repository, through the signed route', async () => {
    const { repo, workspace } = await connectedWorkspace();
    const { POST } = await import('@/app/api/github/webhook/route');
    // The inbox's enqueue is swallowed: this suite drives the processing itself, and a
    // real system event would outlive the workspace cascade into the next file.
    const swallowed = spyOnJobDispatch();

    const res = await POST(signedPost(deliveryBody({})));
    // Stored and answered 202; the inbox job records it (Bug MOTIR-10425).
    expect(res.status).toBe(202);
    await githubWebhookInboxService.processDelivery({ deliveryId: DELIVERY_ID, generation: 0 });
    swallowed.mockRestore();
    expect((await githubWebhookInboxService.findDelivery(DELIVERY_ID))?.result).toEqual({
      event: 'deployment_status',
      outcome: 'recorded',
    });

    const rows = await deployments();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: workspace.id,
      repoId: repo.id,
      provider: 'github',
      providerDeploymentId: '1',
      commitSha: SHA,
      ref: 'feat/MOTIR-7-change',
      environment: 'Preview',
      state: 'success',
      environmentUrl: 'https://acme-git-feat.vercel.app',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('githubWebhookService.handleDeploymentStatus', () => {
  it('the same delivery twice leaves ONE row, unchanged', async () => {
    await connectedWorkspace();
    const body = deliveryBody({});
    await githubWebhookService.handleEvent('deployment_status', body);
    const before = await deployments();
    await githubWebhookService.handleEvent('deployment_status', body);
    const after = await deployments();
    expect(after).toHaveLength(1);
    expect(after[0]!.state).toBe(before[0]!.state);
    expect(after[0]!.occurredAt).toEqual(before[0]!.occurredAt);
  });

  it('an OLDER status arriving after a newer one is a stale no-op', async () => {
    await connectedWorkspace();
    await githubWebhookService.handleEvent(
      'deployment_status',
      deliveryBody({ state: 'success', at: '2026-09-13T10:05:00Z' }),
    );
    const late = await githubWebhookService.handleEvent(
      'deployment_status',
      deliveryBody({ state: 'in_progress', at: '2026-09-13T10:01:00Z', url: null }),
    );
    expect(late).toEqual({ event: 'deployment_status', outcome: 'stale' });

    const [row] = await deployments();
    expect(row!.state).toBe('success');
    expect(row!.environmentUrl).toBe('https://acme-git-feat.vercel.app');
  });

  it('a NEWER status replaces the stored one', async () => {
    await connectedWorkspace();
    await githubWebhookService.handleEvent(
      'deployment_status',
      deliveryBody({ state: 'in_progress', at: '2026-09-13T10:01:00Z', url: null }),
    );
    await githubWebhookService.handleEvent(
      'deployment_status',
      deliveryBody({ state: 'success', at: '2026-09-13T10:05:00Z' }),
    );
    const rows = await deployments();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('success');
  });

  it('a delivery for a repository no workspace connected is ignored and writes nothing', async () => {
    await connectedWorkspace();
    await expect(
      githubWebhookService.handleEvent('deployment_status', deliveryBody({ repoId: 999999 })),
    ).resolves.toEqual({ event: 'deployment_status', outcome: 'unknown_repo' });
    await expect(
      githubWebhookService.handleEvent(
        'deployment_status',
        deliveryBody({ installationId: 'inst-nobody' }),
      ),
    ).resolves.toEqual({ event: 'deployment_status', outcome: 'unknown_installation' });
    expect(await deployments()).toHaveLength(0);
  });

  it('a malformed body is refused without a write', async () => {
    await connectedWorkspace();
    await expect(
      githubWebhookService.handleEvent('deployment_status', { action: 'created' }),
    ).resolves.toEqual({ event: 'deployment_status', outcome: 'malformed' });
    expect(await deployments()).toHaveLength(0);
  });

  it.each([
    ['javascript:alert(1)', null],
    ['/relative/path', null],
    ['not a url', null],
    ['http://preview.example/x', 'http://preview.example/x'],
  ])('stores environment_url %s as %s', async (url, expected) => {
    await connectedWorkspace();
    await githubWebhookService.handleEvent('deployment_status', deliveryBody({ url }));
    const [row] = await deployments();
    expect(row!.environmentUrl).toBe(expected);
    expect(safeEnvironmentUrl(url)).toBe(expected);
  });

  it('makes NO outbound HTTP call on any path', async () => {
    await connectedWorkspace();
    await githubWebhookService.handleEvent('deployment_status', deliveryBody({}));
    await githubWebhookService.handleEvent('deployment_status', deliveryBody({ repoId: 1 }));
    await githubWebhookService.handleEvent(
      'deployment_status',
      deliveryBody({ at: '2020-01-01T00:00:00Z' }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

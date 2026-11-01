import type { PreviewDeploymentState } from '@/generated/prisma/client';
import type { HostingDeployPort, FakeHostingControls } from '@motir/orchestrator';
import { getHostingDeployPort } from '@/lib/orchestrator/hosting';
import { keyForAppend } from '@/lib/workItems/positioning';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from './adminDb';

// A preview of one pull request, as the preview GATE reads it (MOTIR-5779): a
// workspace and project, a Motir-created repository hosted on Fly, a running
// release on the orchestrator's fake deploy port, and the `preview_deployment`
// row naming it. Needs `MOTIR_FLEET_ORCHESTRATOR=fake` stubbed by the caller.

export const PREVIEW_HOST = 'pr-14--portal.preview.motir.site';
export const PREVIEW_PR = 14;

export interface PreviewGateFixture {
  fx: WorkItemFixture;
  projectRepoId: string;
  githubRepoId: string;
  previewId: string;
  appRef: string;
  host: string;
}

let installationSeq = 0;

export async function makePreviewGateFixture(
  options: {
    state?: PreviewDeploymentState;
    host?: string;
    failureReason?: string | null;
    fx?: WorkItemFixture;
  } = {},
): Promise<PreviewGateFixture> {
  const fx = options.fx ?? (await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' }));
  installationSeq += 1;
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: String(880_000 + installationSeq),
      workspaceId: fx.workspaceId,
      accountLogin: 'motir-projects',
      accountType: 'Organization',
    },
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: String(770_000 + installationSeq),
      owner: 'motir-projects',
      name: 'portal',
      defaultBranch: 'main',
      archived: false,
    },
  });
  const last = await adminDb.projectRepo.findFirst({
    where: { projectId: fx.projectId },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  const projectRepo = await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      githubRepoId: mirror.id,
      role: 'web',
      name: 'portal',
      seedSource: 'blank',
      state: 'created',
      position: keyForAppend(last?.position ?? null),
      hostingTarget: 'fly',
    },
  });

  const port = getHostingDeployPort('fly') as HostingDeployPort & FakeHostingControls;
  const environment = { kind: 'preview' as const, pullRequest: PREVIEW_PR };
  const app = await port.ensureApp({ repositoryId: projectRepo.id, environment });
  const handle = await port.deploy({
    appRef: app.appRef,
    environment,
    artifact: { kind: 'image', ref: `registry.fly.io/${app.appRef}:${'a'.repeat(40)}` },
    runtime: {
      port: 3000,
      healthCheck: { path: '/api/health' },
      startCommand: 'node server.js',
      database: { kind: 'none' },
    },
    env: [],
    idle: { mode: 'suspend', idleSeconds: 300 },
  });
  port.setHealth(app.appRef, 'healthy');

  const state = options.state ?? 'ready';
  const row = await adminDb.previewDeployment.create({
    data: {
      workspaceId: fx.workspaceId,
      repoId: mirror.id,
      pullRequestNumber: PREVIEW_PR,
      headSha: 'a'.repeat(40),
      host: options.host ?? PREVIEW_HOST,
      state,
      failureReason: options.failureReason ?? null,
      flyAppName: app.appRef,
      flyMachineId: handle.providerRef,
      closedAt: state === 'closed' ? new Date() : null,
    },
  });
  return {
    fx,
    projectRepoId: projectRepo.id,
    githubRepoId: mirror.id,
    previewId: row.id,
    appRef: app.appRef,
    host: row.host,
  };
}

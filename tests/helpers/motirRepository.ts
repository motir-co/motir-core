import type { ProjectRepoState, ProjectRepoTakeoverState } from '@/generated/prisma/client';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { keyForAppend } from '@/lib/workItems/positioning';

import { adminDb } from './adminDb';

/**
 * Give a workspace a repository row MOTIR CREATED — the fact §8 Amendment 5
 * makes the precondition of claiming or renaming a tenant subdomain
 * (MOTIR-11285, `projectRepoRepository.hasMotirRepositoryInWorkspace`).
 *
 * The defaults are the ELIGIBLE shape: a starter seed source, state `created`,
 * no takeover. Override `state`, `takeoverState` or `seedSource` to build the
 * shapes the rule treats as "no Motir repository" (proposed, failed, skipped,
 * connected, transferred, imported).
 *
 * The row needs a project. Pass `projectId` when the test already has one;
 * otherwise the workspace's oldest project is used, and a bare one is created
 * when the workspace has none — so a fixture that only ever built a workspace
 * gains eligibility in one line.
 *
 * ⚠️ A REAL FRACTIONAL POSITION, as `linkProjectRepo` writes: the column is a
 * fractional index and a later `addRow` appends against the last key, so a
 * synthetic key would make the next real append throw.
 */
export async function seedMotirRepository(opts: {
  workspaceId: string;
  projectId?: string;
  name?: string;
  seedSource?: string;
  state?: ProjectRepoState;
  takeoverState?: ProjectRepoTakeoverState | null;
}) {
  const projectId = opts.projectId ?? (await projectFor(opts.workspaceId));
  const last = await adminDb.projectRepo.findFirst({
    where: { projectId },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  return adminDb.projectRepo.create({
    data: {
      workspaceId: opts.workspaceId,
      projectId,
      role: 'web',
      // `(project_id, name)` is unique, so a default name never repeats.
      name: opts.name ?? `motir-app-${crypto.randomUUID().slice(0, 8)}`,
      seedSource: opts.seedSource ?? SEED_SOURCE_PLATFORM_STARTER,
      state: opts.state ?? 'created',
      takeoverState: opts.takeoverState ?? null,
      position: keyForAppend(last?.position ?? null),
    },
  });
}

/** The workspace's oldest project, or a bare one created for the row to hang on. */
async function projectFor(workspaceId: string): Promise<string> {
  const existing = await adminDb.project.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (existing) return existing.id;
  const suffix = Math.random().toString(36).slice(2, 8);
  const created = await adminDb.project.create({
    data: {
      workspaceId,
      name: 'Motir app',
      slug: `motir-app-${suffix}`,
      identifier: `MA${suffix.toUpperCase().replace(/[^A-Z]/g, 'X')}`,
    },
    select: { id: true },
  });
  return created.id;
}

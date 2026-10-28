import { db } from './db-reset';
import { SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { setWorkspaceRoleFor } from '../../helpers/workspaceRoleFixtures';

// Seed for Story MOTIR-9795's E2E + acceptance recording (Subtask MOTIR-9968).
//
// The state the journey STARTS from and nothing further: a project with one
// repository Motir hosts and one the customer imported (organisation-seeded), an
// ADMINISTRATOR and a MEMBER. No environment entry is seeded — the spec's point
// is that the screen creates them.
//
// ⚠️ The administrator is a workspace ADMIN, never the owner. The owner rides the
// always-pass rail, so a read-only assertion on a member would be the only thing
// telling the two roles apart; an admin holds `repository:manage` through the
// built-in role, which is the key the room's write gate actually reads.

export const ENVIRONMENT_PASSWORD = 'environment-e2e-pass-9795';
export const ENVIRONMENT_PROJECT_KEY = 'ENV';

export interface EnvironmentSeed {
  workspaceId: string;
  projectId: string;
  /** The project's key — how the environment routes are addressed. */
  projectKey: string;
  adminEmail: string;
  memberEmail: string;
  password: string;
  /** The repository Motir hosts — the room's subject. */
  motirRepoId: string;
  motirRepoName: string;
  /** The customer's imported repository — never offered, never addressable. */
  customerRepoId: string;
  customerRepoName: string;
}

export async function seedEnvironmentRoom(slug: string): Promise<EnvironmentSeed> {
  const owner = await usersService.createUser({
    email: `env-owner-${slug}@example.com`,
    password: ENVIRONMENT_PASSWORD,
    name: 'Olivia Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Environment Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Acme Shop',
    identifier: ENVIRONMENT_PROJECT_KEY,
  });
  const ownerCtx = { userId: owner.id, workspaceId: workspace.id };

  const motir = await projectRepoSetService.addRow(
    project.id,
    { role: 'web', name: 'acme-shop-web' },
    ownerCtx,
  );
  const customer = await projectRepoSetService.addRow(
    project.id,
    { role: 'api', name: 'their-billing-api' },
    ownerCtx,
  );
  await db.projectRepo.update({
    where: { id: customer.id },
    data: { seedSource: SEED_SOURCE_ORGANIZATION },
  });

  async function persona(label: string, role: 'admin' | 'member') {
    const email = `env-${label}-${slug}@example.com`;
    const user = await usersService.createUser({
      email,
      password: ENVIRONMENT_PASSWORD,
      name: label === 'admin' ? 'Ada Admin' : 'Max Member',
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    await db.projectMembership.create({
      data: { userId: user.id, projectId: project.id, workspaceId: workspace.id },
    });
    await setWorkspaceRoleFor(user.id, workspace.id, role);
    await db.workspaceMembership.update({
      where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
    return email;
  }

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    adminEmail: await persona('admin', 'admin'),
    memberEmail: await persona('member', 'member'),
    password: ENVIRONMENT_PASSWORD,
    motirRepoId: motir.id,
    motirRepoName: motir.name,
    customerRepoId: customer.id,
    customerRepoName: customer.name,
  };
}

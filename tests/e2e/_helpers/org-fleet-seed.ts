import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { organizationsService } from '@/lib/services/organizationsService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb, db } from './db-reset';
import { E2E_PROVISIONING_ORG } from './github-const';
import { SHELL_PASSWORD } from './shell-session';

/**
 * THE ORG FLEET PAGE's seeded fleet (Story MOTIR-10363 · MOTIR-10372), for the
 * story's acceptance walk (`acceptance-org-fleet.spec.ts`).
 *
 * Everything is a ROW, in the shape the writer that owns it leaves it, because
 * the lane boots no container and runs no admission a browser could start. The
 * shapes are `fleet-use-seed.ts`'s, which seeds the same tables for the Fleet use
 * story, plus the three this story adds to the read:
 *  - a hosted run in flight is a `hosted` dispatch run holding the
 *    `hosted_agent` slot `hostedRunService` reserves (`hostedRunDispatchId`);
 *  - a CI job is a provisioning intent, `running` with its container in flight,
 *    `pending` with the `waiting_reason` the CI gate records;
 *  - an agent instance is the row `agentInstanceLifecycleService.create` leaves
 *    once its machine is up, `running`. It carries NO machine id: the lane's
 *    persistent fake has no machine for a seeded row, so a stop never confirms
 *    and the instance stays `hibernating` — which is exactly what an agent whose
 *    provider did not confirm the stop looks like, and what the walk's partial
 *    failure is;
 *  - an index job is the `code_graph_index` slot the indexer claims;
 *  - a Motir stop is the `fleet_machine_kill` row the attribution reconciler
 *    writes when it destroys a machine.
 *
 * ⚠️ THE LANE'S PASSES ARE HELD OFF FOR THE WALK (`fleet-use-seed.ts`'s
 * `holdFleetPasses`, plus the CI sweep and the agent-instance sweep the spec
 * holds with `holdScheduledJob`). Each would rewrite these rows mid-walk.
 */

const MIN = 60_000;
let seq = 0;

export interface FleetPerson {
  id: string;
  email: string;
  name: string;
}

export interface OrgFleetSeed {
  organizationId: string;
  workspaceId: string;
  projectId: string;
  projectName: string;
  admin: FleetPerson;
  member: FleetPerson;
  plainMember: FleetPerson;
}

/** A person who can sign in and lands on the org's workbench. */
async function person(
  org: { organizationId: string; workspaceId: string; projectId: string; ownerId: string },
  role: 'admin' | 'member',
  email: string,
  name: string,
): Promise<FleetPerson> {
  const user = await usersService.createUser({ email, password: SHELL_PASSWORD, name });
  await organizationsService.addMember({
    organizationId: org.organizationId,
    userId: user.id,
    role: role === 'admin' ? ORGANIZATION_ROLE.admin : ORGANIZATION_ROLE.member,
    actorUserId: org.ownerId,
  });
  await db.workspaceMembership.create({
    data: {
      workspaceId: org.workspaceId,
      userId: user.id,
      workspaceRole: 'member',
      activeProjectId: org.projectId,
    },
  });
  return { id: user.id, email, name };
}

/** The org's admin, the member whose agent the admin hibernates, and a plain member. */
export async function seedFleetPeople(
  org: { organizationId: string; workspaceId: string; projectId: string; ownerId: string },
  stamp: string,
): Promise<Pick<OrgFleetSeed, 'admin' | 'member' | 'plainMember'>> {
  return {
    admin: await person(org, 'admin', `acc-fleet-admin-${stamp}@example.com`, 'Ada Admin'),
    member: await person(org, 'member', `acc-fleet-mira-${stamp}@example.com`, 'Mira Member'),
    plainMember: await person(org, 'member', `acc-fleet-paul-${stamp}@example.com`, 'Paul Plain'),
  };
}

/** One `hosted` run in flight: the run and the slot admission reserved for it. */
export async function seedLiveHostedRun(
  org: { organizationId: string; workspaceId: string; projectId: string },
  createdById: string,
): Promise<string> {
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: org.workspaceId,
      projectId: org.projectId,
      command: 'run',
      origin: 'hosted',
      status: 'running',
      createdById,
      startedAt: new Date(Date.now() - 4 * MIN),
    },
  });
  await adminDb.fleetInFlightSlot.create({
    data: {
      workload: 'hosted_agent',
      ref: hostedRunDispatchId(run.id),
      organizationId: org.organizationId,
      workspaceId: org.workspaceId,
      containerProvider: 'fake',
      containerId: `fake-e2e-org-fleet-${run.id}`,
      expiresAt: new Date(Date.now() + 60 * MIN),
    },
  });
  return run.id;
}

/** One CI job: `running` with its container, or `pending` behind the plan limit. */
export async function seedCiJob(
  org: { organizationId: string; workspaceId: string; projectId: string },
  status: 'running' | 'pending',
): Promise<string> {
  seq += 1;
  const now = Date.now();
  const row = await adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: org.workspaceId,
      organizationId: org.organizationId,
      projectId: org.projectId,
      installationId: '556677',
      runId: `e2e-org-fleet-run-${seq}`,
      runAttempt: 1,
      jobId: String(97_100_000 + seq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: E2E_PROVISIONING_ORG,
      repoName: 'org-fleet-e2e',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: new Date(now - 2 * MIN),
      status,
      ...(status === 'running'
        ? {
            startedAt: new Date(now - MIN),
            containerProvider: 'fake',
            containerId: `fake-e2e-org-fleet-ci-${seq}`,
            containerRegion: 'iad',
            bootedAt: new Date(now - 70_000),
          }
        : { waitingReason: 'plan_limit', waitingSince: new Date(now - MIN) }),
    },
  });
  return row.id;
}

/** One `running` agent instance of `ownerId`, as create leaves it once it is up. */
export async function seedRunningAgent(
  org: { organizationId: string; workspaceId: string; projectId: string },
  ownerId: string,
  name: string,
): Promise<string> {
  const row = await adminDb.agentInstance.create({
    data: {
      workspaceId: org.workspaceId,
      organizationId: org.organizationId,
      projectId: org.projectId,
      ownerId,
      name,
      profileId: 'claude',
      imageTag: 'ghcr.io/motir-co/motir-sandbox:claude',
      imageDigest: 'sha256:seed',
      region: 'iad',
      state: 'running',
      stateChangedAt: new Date(Date.now() - 20 * MIN),
    },
  });
  return row.id;
}

/** One index job: the `code_graph_index` slot the indexer claims. */
export async function seedIndexJob(org: {
  organizationId: string;
  workspaceId: string;
}): Promise<string> {
  seq += 1;
  const ref = `e2e-org-fleet-index-${seq}`;
  await adminDb.fleetInFlightSlot.create({
    data: {
      workload: 'code_graph_index',
      ref,
      organizationId: org.organizationId,
      workspaceId: org.workspaceId,
      containerProvider: 'fake',
      containerId: `fake-e2e-org-fleet-index-${seq}`,
      expiresAt: new Date(Date.now() + 60 * MIN),
    },
  });
  return ref;
}

/** One machine Motir stopped for the org: the reconciler's kill row. */
export async function seedMotirStop(organizationId: string, decidedAt: Date): Promise<void> {
  seq += 1;
  await adminDb.fleetMachineKill.create({
    data: {
      app: `motir-ci-e2e-${seq}`,
      machineId: `e2e-org-fleet-kill-${seq}`,
      reason: 'record_ended',
      action: 'destroyed',
      workload: 'ci_runner',
      recordRef: `e2e-org-fleet-kill-ref-${seq}`,
      organizationId,
      ageSeconds: 600,
      decidedAt,
      completedAt: decidedAt,
    },
  });
}

/**
 * A SECOND organisation with work of its own, so the walk can see that none of
 * it reaches the first org's page. Its agent and its run carry names the walk
 * looks for.
 */
export async function seedOtherOrg(
  stamp: string,
): Promise<{ agentName: string; owner: FleetPerson }> {
  const owner = await usersService.createUser({
    email: `acc-fleet-other-${stamp}@example.com`,
    password: SHELL_PASSWORD,
    name: 'Otto Other',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Other org',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Other project',
    identifier: 'OTHR',
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  const org = {
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
    projectId: project.id,
  };
  const agentName = `other-agent-${stamp}`;
  await seedLiveHostedRun(org, owner.id);
  await seedCiJob(org, 'running');
  await seedRunningAgent(org, owner.id, agentName);
  await seedIndexJob(org);
  return { agentName, owner: { id: owner.id, email: owner.email, name: 'Otto Other' } };
}

/** Clear the rows that hang off no workspace (slots, kills) — `resetDatabase()` keeps them. */
export async function clearOrgFleetRows(): Promise<void> {
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetMachineKill.deleteMany({
    where: { machineId: { startsWith: 'e2e-org-fleet-' } },
  });
}

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fakePersistentOrchestrator } from '@motir/orchestrator';
import { fakeDigestFor } from '@/lib/agentInstances/imageCatalog';
import { pinnedImageReference } from '@/lib/agentInstances/imageDigest';
import { sandboxImageTag } from '@/lib/agentInstances/profiles';
import { adminDb, db } from './db-reset';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestPerson } from './testPerson';
import { writeHostedRunFixture } from './hosted-run-boundary';
import { grantPaidAiPlanIfBilled } from './billing';

// MY AGENTS — the acceptance seed (Story MOTIR-6860 · MOTIR-6877).
//
// One owner with an active project (member and above hold `instance:use`), and a
// VIEWER on the same project who does not. The credit pre-flight and the machine
// debit are answered by the lane's motir-ai mock (`lib/test-hosted-run-mock.ts`),
// driven by the same fixture file the hosted-run spec uses; the fleet is the
// persistent fake, shared with the webServer through `MOTIR_FAKE_PERSISTENT_STATE_PATH`.

export const MY_AGENTS_PASSWORD = 'correct-horse-battery-staple-9';

export interface MyAgentsSeed {
  email: string;
  viewerEmail: string;
  password: string;
  userId: string;
  workspaceId: string;
  organizationId: string;
  projectId: string;
  projectIdentifier: string;
}

export async function seedMyAgents(
  tag: string,
  opts: {
    /** `false` seeds a tracker-only org — no paid AI plan (MOTIR-6924's first case). */
    paidAiPlan?: boolean;
  } = {},
): Promise<MyAgentsSeed> {
  fakePersistentOrchestrator.reset();
  setCredits(true);
  const owner = await createTestPerson({
    email: `agents-${tag}@example.com`,
    password: MY_AGENTS_PASSWORD,
    name: 'Yue Agents',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Agents',
    ownerUserId: owner.id,
  });
  // Agents are an AI-plan feature (MOTIR-6918): create and wake ask the plan first.
  if (opts.paidAiPlan !== false) grantPaidAiPlanIfBilled(workspace.organizationId);
  const identifier = `AG${tag.slice(-4).toUpperCase()}`;
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Agents',
    identifier,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  const viewer = await createTestPerson({
    email: `agents-viewer-${tag}@example.com`,
    password: MY_AGENTS_PASSWORD,
    name: 'Vera Viewer',
  });
  await db.workspaceMembership.create({
    data: {
      workspaceId: workspace.id,
      userId: viewer.id,
      workspaceRole: 'viewer',
      activeProjectId: project.id,
    },
  });
  return {
    email: `agents-${tag}@example.com`,
    viewerEmail: `agents-viewer-${tag}@example.com`,
    password: MY_AGENTS_PASSWORD,
    userId: owner.id,
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
    // The stored key, not the requested one: `createProject` normalises it (5 characters).
    projectIdentifier: project.identifier,
  };
}

/** Whether the organisation's credits can start a machine (the mock's pre-flight answer). */
export function setCredits(mayRun: boolean): void {
  writeHostedRunFixture({ mayRun });
}

/** Arm the next provision to fail — the webServer meets it through the shared sidecar. */
export function failNextProvision(detail: string): void {
  fakePersistentOrchestrator.failNextProvision(detail);
}

/** Seed `count` live agents for the owner directly — for the personal-limit refusal. */
export async function seedAgents(seed: MyAgentsSeed, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await adminDb.agentInstance.create({
      data: {
        workspaceId: seed.workspaceId,
        organizationId: seed.organizationId,
        projectId: seed.projectId,
        ownerId: seed.userId,
        name: `seeded-${i}`,
        profileId: 'claude',
        imageTag: 'ghcr.io/motir-co/motir-sandbox:claude',
        imageDigest: 'sha256:seed',
        region: 'iad',
        state: 'hibernated',
      },
    });
  }
}

// ── THE IMAGE UPDATE (Story MOTIR-6862 · MOTIR-6955) ─────────────────────────
// The catalog's fake answers live in `MOTIR_FAKE_IMAGE_CATALOG_PATH`, which the
// lane's webServer re-reads on every call; the fleet's image, liveness and home
// seams live in the persistent fake's shared state file.

interface FakeCatalog {
  newest: Record<string, string>;
  unavailable: boolean;
}

function catalogPath(): string {
  const path = process.env['MOTIR_FAKE_IMAGE_CATALOG_PATH'];
  if (!path)
    throw new Error('MOTIR_FAKE_IMAGE_CATALOG_PATH is not set — run on the acceptance lane');
  return path;
}

function readCatalog(): FakeCatalog {
  try {
    return { newest: {}, unavailable: false, ...JSON.parse(readFileSync(catalogPath(), 'utf8')) };
  } catch {
    return { newest: {}, unavailable: false };
  }
}

function writeCatalog(next: FakeCatalog): void {
  mkdirSync(dirname(catalogPath()), { recursive: true });
  writeFileSync(catalogPath(), JSON.stringify(next), 'utf8');
}

/** "Publish" `version` as the newest image of a profile. */
export function publishImage(profileId: string, version: string): void {
  const catalog = readCatalog();
  writeCatalog({ ...catalog, newest: { ...catalog.newest, [profileId]: version } });
}

/** Make the registry unreachable (true) or reachable again (false). */
export function setCatalogUnavailable(unavailable: boolean): void {
  writeCatalog({ ...readCatalog(), unavailable });
}

/** Start the catalog clean: nothing published beyond the fake base, reachable. */
export function resetCatalog(): void {
  writeCatalog({ newest: {}, unavailable: false });
}

const imageRefOf = (profileId: string, version: string) =>
  pinnedImageReference(sandboxImageTag(profileId), fakeDigestFor(profileId, version));

/** Make `version` of a profile fail its liveness check on the fake fleet. */
export function markVersionFailing(profileId: string, version: string): void {
  fakePersistentOrchestrator.markImageFailing(imageRefOf(profileId, version));
}

/** Pin an existing agent to `version` — its record and its fake machine — as if created then. */
export async function pinAgentToVersion(agentId: string, version: string): Promise<void> {
  const row = await adminDb.agentInstance.findUniqueOrThrow({ where: { id: agentId } });
  await adminDb.agentInstance.update({
    where: { id: agentId },
    data: { imageDigest: fakeDigestFor(row.profileId, version), imageVersion: version },
  });
  await fakePersistentOrchestrator.moveImage(
    {
      provider: 'fake',
      app: row.flyApp!,
      machineId: row.machineId!,
      volumeId: row.volumeId!,
      region: row.region!,
      createdAt: row.createdAt,
    },
    imageRefOf(row.profileId, version),
    { launch: false },
  );
}

/** Write a file into an agent's home, through the fake fleet's volume. */
export async function writeAgentHomeFile(agentId: string, path: string, content: string) {
  const row = await adminDb.agentInstance.findUniqueOrThrow({ where: { id: agentId } });
  fakePersistentOrchestrator.writeHomeFile(row.volumeId!, path, content);
}

/** Read a file from an agent's home, through the fake fleet's volume. */
export async function readAgentHomeFile(agentId: string, path: string): Promise<string | null> {
  const row = await adminDb.agentInstance.findUniqueOrThrow({ where: { id: agentId } });
  return fakePersistentOrchestrator.readHomeFile(row.volumeId!, path);
}

/**
 * Record a RUNNING run against an agent on the shared run record (the run story's
 * `origin: instance`) — what Update's run refusal reads. Returns the card's key.
 */
export async function recordRunInAgent(seed: MyAgentsSeed, agentId: string): Promise<string> {
  const ctx = { userId: seed.userId, workspaceId: seed.workspaceId };
  const item = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'task', title: 'Fix the flaky login test' },
    ctx,
  );
  await dispatchRunService.open(
    {
      projectKey: seed.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      origin: 'instance',
      agentInstanceId: agentId,
      agent: 'claude',
      cards: [{ key: item.identifier, disposition: 'queued' }],
    },
    ctx,
  );
  return item.identifier;
}

// ── THE BOOT'S CLONES (Story MOTIR-7393 · MOTIR-7402) ────────────────────────
// The terminal host answers every clone exec at once unless a repository is
// scripted in `MOTIR_E2E_CLONE_SCRIPT_PATH` (`agent-terminal/host.ts`'s
// `runClone`): HELD, its exec stays open until released, so the step is seen in
// progress; REFUSED, it exits 128 with the given words on stderr.

interface CloneScript {
  hold?: boolean;
  refuse?: string;
}

function cloneScriptPath(): string {
  const path = process.env['MOTIR_E2E_CLONE_SCRIPT_PATH'];
  if (!path) throw new Error('MOTIR_E2E_CLONE_SCRIPT_PATH is not set — run on the acceptance lane');
  return path;
}

function writeCloneScript(repository: string, script: CloneScript | null): void {
  let all: Record<string, CloneScript> = {};
  try {
    all = JSON.parse(readFileSync(cloneScriptPath(), 'utf8')) as Record<string, CloneScript>;
  } catch {
    // No sidecar yet: nothing scripted.
  }
  if (script) all[repository] = script;
  else delete all[repository];
  mkdirSync(dirname(cloneScriptPath()), { recursive: true });
  writeFileSync(cloneScriptPath(), JSON.stringify(all), 'utf8');
}

/** Keep `repository`'s (`owner/name`) clone running until {@link releaseClone}. */
export function holdClone(repository: string): void {
  writeCloneScript(repository, { hold: true });
}

/** Let `repository`'s clone finish (and every later one succeed). */
export function releaseClone(repository: string): void {
  writeCloneScript(repository, null);
}

/** Make `repository`'s clone fail with git's `words`. */
export function refuseClone(repository: string, words: string): void {
  writeCloneScript(repository, { refuse: words });
}

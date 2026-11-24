import { vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { adminDb } from './adminDb';
import { linkWorkspaceReposToProject } from './projectRepoLink';

// THE `system.code-graph-index` TEST WORLD'S SEED (Story MOTIR-1981 · MOTIR-1992)
// — the workspace, installation, projects and events the index-job suites drive
// the REAL job through, against a REAL Postgres.
//
// ⚠️ THE CONTAINER WORLD LEFT WITH THE INDEXER FLEET (MOTIR-12036). This file
// used to also stub the fake orchestrator, motir-ai's run-credential mint, the
// run-verdict read and the tarball-body trap for the container dispatch. Both
// jobs hand the build off to motir-codegraph now, and that world is
// `tests/helpers/indexHandoff.ts`'s `stubIndexHandoff()`. What stays here is the
// part every index suite still shares: the seed, the motir-ai address and token
// the handoff world answers on, and the event builders.

const PASSWORD = 'hunter2hunter2';

export const INDEX_AI_URL = 'https://ai.example.test';
export const INDEX_SERVICE_TOKEN = 'svc-token-must-never-reach-a-container';
/** The repo `seedIndexWorkspace` connects by default. */
export const INDEX_REPO_REF = 'moooon/motir-core';

/** One repo to connect under the seeded installation. */
export interface IndexRepoSeed {
  owner: string;
  name: string;
}

const DEFAULT_REPOS: IndexRepoSeed[] = [{ owner: 'moooon', name: 'motir-core' }];

/** A real RSA key pair, so `appAuth` can actually sign the App JWT. */
export function stubAppCredentials(): void {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
}

export interface SeededIndexWorkspace {
  workspaceId: string;
  ownerUserId: string;
  projectIds: string[];
  installationId: string;
  /** The connected repos' `owner/name` refs, in seed order. */
  repoRefs: string[];
}

/**
 * Seed a workspace with `projectCount` projects and the given connected repos
 * (default: the single `moooon/motir-core`).
 *
 * All repos share ONE installation on purpose: `resolveCodeContext` reads a
 * single installation per workspace, so repos meant to be visible together —
 * which is exactly what the onboarding wizard's per-repo rows read — must hang
 * off the same grant.
 */
/** A stable numeric repo-id base for a slug, distinct across the slugs a file seeds. */
function repoIdBaseForSlug(slug: string): number {
  let hash = 0;
  for (const ch of slug) hash = (hash * 31 + ch.charCodeAt(0)) % 1_000_000;
  return 77 + hash * 100;
}

export async function seedIndexWorkspace(
  slug: string,
  projectCount: number,
  repos: IndexRepoSeed[] = DEFAULT_REPOS,
): Promise<SeededIndexWorkspace> {
  const user = await usersService.createUser({
    email: `${slug}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: user.id,
  });
  // Drop any auto-seeded project so the count is exactly what the test asked for.
  // FIXTURE teardown (MOTIR-2792) → the admin client: a cross-tenant delete is
  // exactly what the policies exist to refuse.
  await adminDb.project.deleteMany({ where: { workspaceId: workspace.id } });
  const projectIds: string[] = [];
  for (let i = 0; i < projectCount; i += 1) {
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: `P${i}`,
      identifier: `PRJ${i}${slug.slice(-1).toUpperCase()}`,
    });
    projectIds.push(project.id);
  }
  const installationId = `inst-${slug}`;
  // ⚠️ REPO IDS ARE PER SLUG (MOTIR-8218). Every seeded workspace gets its own
  // organisation, and a provider repository belongs to ONE organisation
  // (`trg_github_repo_one_organization`), so two workspaces seeded with the same
  // numeric ids would be two orgs claiming one repository — refused as P2002.
  const repoIdBase = repoIdBaseForSlug(slug);
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: { installationId, accountLogin: 'moooon', accountType: 'Organization' },
    repos: repos.map((repo, i) => ({
      providerRepoId: `${repoIdBase + i}`,
      owner: repo.owner,
      name: repo.name,
      defaultBranch: 'main',
      archived: false,
    })),
  });
  // ⚠️ EACH PROJECT IS ALSO GIVEN THE REPOSITORIES (MOTIR-4653). Connecting them
  // to the WORKSPACE used to be enough for a project to see them: the code-context
  // resolver read the installation grant. It reads the PROJECT's configured set
  // now, so a fixture that stops at `persistInstallation` leaves every project
  // code-BLIND — and the suites downstream of this helper (the first-audit
  // trigger above all) then report `0 submits` rather than a missing link.
  //
  // Every project gets every repo, which is what these fixtures have always
  // MEANT: `seedIndexWorkspace(slug, N, repos)` describes a workspace of N
  // projects that all work on the same repositories.
  //
  // ⚠️ THROUGH `linkWorkspaceReposToProject`, which is `main`'s helper and not
  // this card's hand-rolled `addRow` + realize pair. It lands the row in an
  // ESTABLISHED state, which is what `resolveProjectCodeContext` now filters on —
  // a fixture that only realized the row would leave every project code-blind
  // again, one layer down, with the same silent `0 submits` as the symptom.
  for (const projectId of projectIds) {
    await linkWorkspaceReposToProject({
      workspaceId: workspace.id,
      projectId,
      names: repos.map((repo) => repo.name),
    });
  }
  return {
    workspaceId: workspace.id,
    ownerUserId: user.id,
    projectIds,
    installationId,
    repoRefs: repos.map((repo) => `${repo.owner}/${repo.name}`),
  };
}

/**
 * The step ids a run passed through, FIRST-SEEN ORDER, de-duplicated.
 *
 * ⚠️ THE DE-DUPLICATION ARRIVED WITH THE SELF-RESCHEDULING SHAPE (MOTIR-3828)
 * and it is what keeps these assertions meaning what they meant. A supervision
 * is a state machine over runs now: every pass re-enters the handler from the
 * top and CALLS each earlier step id again, taking the memo. So
 * `ctx.step.run.mock.calls` holds one entry per call rather than one per step,
 * and a 30-poll supervision would report `index-boot:<pid>` thirty times.
 *
 * What the suites using this actually assert is the set of steps a run RECORDS —
 * one `job_step` row each — which is exactly this list.
 */
export function indexStepIds(ctx: { step: { run: { mock: { calls: unknown[][] } } } }): string[] {
  return [...new Set(ctx.step.run.mock.calls.map((call) => String(call[0])))];
}

/**
 * One `system.code-graph-index` event.
 *
 * ⚠️ THE EVENT ID IS PINNED. `JobTestEngine` mints a FRESH one (and a fresh
 * runId) per execution, and `defineJob` correlates its ledger row by
 * (functionId, eventId) — so a generated id makes a two-execution assertion read
 * two different runs, and two repos dispatched in one test collide unless the id
 * carries the repo.
 */
export function indexEventFor(args: {
  installationId: string;
  workspaceId: string;
  repoOwner?: string;
  repoName?: string;
  eventId?: string;
}) {
  const repoOwner = args.repoOwner ?? 'moooon';
  const repoName = args.repoName ?? 'motir-core';
  return {
    name: 'system.code-graph-index' as const,
    id: args.eventId ?? `evt-${args.installationId}-${repoOwner}-${repoName}`,
    data: {
      installationId: args.installationId,
      workspaceId: args.workspaceId,
      repoOwner,
      repoName,
      defaultBranch: 'main',
    },
  };
}

/**
 * One `system.code-graph-refresh` event — a default-branch push.
 *
 * The payload is the index event's (`CodeGraphRefreshData = CodeGraphIndexData`),
 * which is WHY the two jobs share `runIndexHandoffSteps`. The event id is pinned
 * for the reason above.
 */
export function refreshEventFor(args: {
  installationId: string;
  workspaceId: string;
  repoOwner?: string;
  repoName?: string;
  eventId?: string;
}) {
  const indexEvent = indexEventFor(args);
  return { ...indexEvent, name: 'system.code-graph-refresh' as const };
}

/** The `system.code-graph-index` ledger rows, newest last. */
export async function indexJobRuns() {
  return adminDb.jobRun.findMany({
    where: { functionId: 'system.code-graph-index' },
    orderBy: { startedAt: 'asc' },
  });
}

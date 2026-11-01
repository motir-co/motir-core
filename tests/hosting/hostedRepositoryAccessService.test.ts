// MOTIR-10030 — how motir-core reaches a hosted repository on GitHub, and the
// manifest read a production release makes at its exact commit. The GitHub and
// database edges are stubbed at their module seams: this suite pins the
// resolution order (Motir's own org, then the org assigned to the workspace,
// else a refusal) and the manifest read's three exits.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const own = vi.hoisted(() => ({ org: null as string | null }));
const facts = vi.hoisted(() => ({
  row: null as null | { workspaceId: string; githubRepo: { owner: string; name: string } | null },
}));
const hosted = vi.hoisted(() => ({ target: null as null | { org: string } }));
const manifest = vi.hoisted(() => ({ text: '', refs: [] as string[] }));

vi.mock('@/lib/ciMetering/config', () => ({ provisioningOrgLogin: () => own.org }));
vi.mock('@/lib/github/repoProvisioning', () => ({
  provisioningAuth: async () => ({ token: 'own-token' }),
}));
vi.mock('@/lib/github/orgTarget', () => ({
  resolveOrgAuth: async (target: { org: string }) => ({ token: `assigned-${target.org}` }),
}));
vi.mock('@/lib/services/fleetGithubOrgAssignmentService', () => ({
  fleetGithubOrgAssignmentService: { hostedTargetForWorkspace: async () => hosted.target },
}));
vi.mock('@/lib/workspaces/context', () => ({
  withSystemContext: async (fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock('@/lib/repositories/projectRepoRepository', () => ({
  projectRepoRepository: { findDeployFactsInTx: async () => facts.row },
}));
vi.mock('@/lib/github/seedPromotion', () => ({
  seedPromotionGithub: {
    readHostingManifest: async (access: { token: string }, ref: string) => {
      manifest.refs.push(`${access.token}@${ref}`);
      return manifest.text;
    },
  },
}));

const { hostedRepositoryAccessService: service } =
  await import('@/lib/services/hostedRepositoryAccessService');
const { ApplicationNotFoundError, HostingManifestMissingError } =
  await import('@/lib/hosting/errors');

const SHA = 'a'.repeat(40);
const repoFacts = { workspaceId: 'ws_1', githubRepo: { owner: 'Motir-Projects', name: 'shop' } };

beforeEach(() => {
  own.org = 'motir-projects';
  hosted.target = null;
  facts.row = repoFacts;
  manifest.text = readFileSync('tests/fixtures/hosting/motir.hosting.json', 'utf8');
  manifest.refs = [];
});

describe('hostedRepositoryAccessService.accessFor', () => {
  it("uses Motir's own credential for a repository in Motir's own org, case-insensitively", async () => {
    await expect(service.accessFor(repoFacts)).resolves.toEqual({
      owner: 'Motir-Projects',
      repo: 'shop',
      token: 'own-token',
    });
  });

  it("uses the assigned org's credential for a repository in the workspace's hosted org", async () => {
    own.org = null;
    hosted.target = { org: 'motir-projects' };
    await expect(service.accessFor(repoFacts)).resolves.toMatchObject({
      token: 'assigned-motir-projects',
    });
  });

  it('refuses a repository in an org Motir holds no credential for', async () => {
    hosted.target = { org: 'someone-else' };
    await expect(
      service.accessFor({ workspaceId: 'ws_1', githubRepo: { owner: 'acme', name: 'shop' } }),
    ).rejects.toThrow('acme/shop is not in a GitHub organisation Motir holds');
  });
});

describe('hostedRepositoryAccessService.readManifestAt', () => {
  it('reads and parses the manifest at the given commit', async () => {
    const parsed = await service.readManifestAt('repo_1', SHA);
    expect(parsed).toMatchObject({ port: 8080, database: { kind: 'none' } });
    expect(manifest.refs).toEqual([`own-token@${SHA}`]);
  });

  it('refuses an unknown repository', async () => {
    facts.row = null;
    await expect(service.readManifestAt('repo_x', SHA)).rejects.toBeInstanceOf(
      ApplicationNotFoundError,
    );
  });

  it('reports a missing manifest for a repository that is not on GitHub', async () => {
    facts.row = { workspaceId: 'ws_1', githubRepo: null };
    await expect(service.readManifestAt('repo_1', SHA)).rejects.toBeInstanceOf(
      HostingManifestMissingError,
    );
    expect(manifest.refs).toEqual([]);
  });
});

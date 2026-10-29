import { provisioningOrgLogin } from '@/lib/ciMetering/config';
import { resolveOrgAuth } from '@/lib/github/orgTarget';
import { provisioningAuth } from '@/lib/github/repoProvisioning';
import { seedPromotionGithub, type GithubRepoAccess } from '@/lib/github/seedPromotion';
import { ApplicationNotFoundError, HostingManifestMissingError } from '@/lib/hosting/errors';
import {
  HOSTING_MANIFEST_FILE_NAME,
  parseHostingManifest,
  type HostingManifest,
} from '@/lib/hosting/manifest';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { fleetGithubOrgAssignmentService } from '@/lib/services/fleetGithubOrgAssignmentService';
import { withSystemContext } from '@/lib/workspaces/context';

// How motir-core reaches a HOSTED repository on GitHub (Story MOTIR-9797): the
// credential for Motir's own org, or for the org Motir assigned the workspace's
// organisation (MOTIR-8966) — the resolution seed promotion uses. Shared by
// production enablement (MOTIR-10027), which writes the repository's Actions
// configuration, and the release service (MOTIR-10030), which reads the hosting
// manifest of the exact commit it releases.

/** The facts of a repository row the resolution reads. */
export interface HostedRepositoryFacts {
  workspaceId: string;
  githubRepo: { owner: string; name: string };
}

async function accessFor(facts: HostedRepositoryFacts): Promise<GithubRepoAccess> {
  const { owner, name } = facts.githubRepo;
  const ownOrg = provisioningOrgLogin();
  if (ownOrg !== null && owner.toLowerCase() === ownOrg.toLowerCase()) {
    return { owner, repo: name, token: (await provisioningAuth()).token };
  }
  const hosted = await fleetGithubOrgAssignmentService.hostedTargetForWorkspace(facts.workspaceId);
  if (hosted && hosted.org.toLowerCase() === owner.toLowerCase()) {
    return { owner, repo: name, token: (await resolveOrgAuth(hosted)).token };
  }
  throw new Error(`${owner}/${name} is not in a GitHub organisation Motir holds`);
}

/** The repository's hosting manifest at `ref` (a commit sha or a branch),
 *  parsed. Throws `HostingManifestMissingError` / `HostingManifestInvalidError`. */
async function readManifestAt(projectRepositoryId: string, ref: string): Promise<HostingManifest> {
  const facts = await withSystemContext((tx) =>
    projectRepoRepository.findDeployFactsInTx(projectRepositoryId, tx),
  );
  if (!facts) throw new ApplicationNotFoundError(projectRepositoryId);
  if (!facts.githubRepo) throw new HostingManifestMissingError(HOSTING_MANIFEST_FILE_NAME);
  const access = await hostedRepositoryAccessService.accessFor({
    workspaceId: facts.workspaceId,
    githubRepo: facts.githubRepo,
  });
  return parseHostingManifest(await seedPromotionGithub.readHostingManifest(access, ref));
}

export const hostedRepositoryAccessService = { accessFor, readManifestAt };

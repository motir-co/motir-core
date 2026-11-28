import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  withSystemContext,
  withWorkspaceServiceContext,
  type TransactionBudget,
} from '@/lib/workspaces/context';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { hostInstallationIdOf } from '@/lib/services/projectRepoTakeoverService';
import {
  repositoryActionsConfigClient,
  type RepositoryCoordinates,
} from '@/lib/github/repositoryActionsConfig';
import { isMotirHostedOwner } from '@/lib/git/hostOwnership';
import { motirOwnedOrgLogins } from '@/lib/ciMetering/ownedOrgs';
import {
  listCodeGraphUploadCredentials,
  mintCodeGraphUploadCredential,
  revokeCodeGraphUploadCredential,
  type CodeGraphUploadCredentialScope,
} from '@/lib/ai/motirAiClient';
import {
  MotirAiBadRequestError,
  MotirAiCodeGraphRefusedError,
  MotirAiUnavailableError,
} from '@/lib/ai/errors';
import {
  CODEGRAPH_REPOSITORY_ID_VARIABLE,
  CODEGRAPH_UPLOAD_URL_VARIABLE,
  SCIP_UPLOAD_TOKEN_SECRET,
  SCIP_UPLOAD_VARIABLES,
} from '@/lib/codeGraph/scipUploadActionsNames';
import {
  ProjectRepoInvalidFieldError,
  ProjectRepoNotFoundError,
  ScipUploadActionsWriteError,
  ScipUploadCredentialRefusedError,
} from '@/lib/projectRepos/errors';
import type {
  MintedScipUploadCredentialDto,
  RevokedScipUploadCredentialDto,
  ScipUploadCredentialDto,
} from '@/lib/dto/scipUploadCredentials';

// A REPOSITORY'S SCIP UPLOAD CREDENTIALS (Story MOTIR-12262 · MOTIR-12339; design
// `design/repository-set/design-notes.md` §20).
//
// A person who manages a project's repositories mints a named upload credential for
// one row of the Repositories room, so that repository's own CI can upload its SCIP
// index straight to the code graph. motir-core only ever calls motir-ai for it (its
// three `/v1/code-graph/upload-credentials` routes): it never holds the code graph's
// operator token and never sees an upload's bytes. The token passes through ONCE, in
// the mint's answer, and is written to no row and no log line.
//
// On a MOTIR-HOSTED row the mint also installs the token in the repository's own
// Actions — the secret and two variables of `scipUploadActionsNames` — through the
// provisioning App. Three systems are written in turn (the code graph's issue,
// GitHub's secret, the row's installed id), so the ORDER is the design:
//
//   mint    → the code graph issues FIRST, outside any transaction: a refusal there
//             writes nothing anywhere. Then, under the row lock, the secret; the
//             row's installed id is set in the same transaction only once the secret
//             holds the new token, so the two always name the same credential, and a
//             second mint on the row waits for the first. The two variables come
//             after, outside the lock: they hold the repository id and the upload
//             host, which are the same for every credential of the repository, so no
//             interleaving can make them wrong. A failed GitHub write answers
//             `installFailed` and does NOT revoke the credential — the person has the
//             token and can paste it in by hand or mint again.
//   revoke  → under the row lock, the repository's secret and variables go FIRST
//             (only when this is the installed credential) and the id is cleared;
//             only then is the code graph asked to revoke. A failed revoke leaves no
//             secret behind, and a retry skips the deletes.
//   list    → the code graph's own list on every call; the row only says which one is
//             installed.
//
// On an IMPORTED row (an organisation repository, reached through motir-integration)
// nothing is written into the repository.

/**
 * The transaction that holds the row lock across the GitHub secret write.
 *
 * It does network work on purpose — the lock is what keeps the secret and the
 * recorded installed id naming the same credential under concurrent mints — so the
 * Prisma default (5 s) is not a budget it can live in: one secret write is two GitHub
 * calls (the public key, then the PUT), and a revoke three deletes. 45 s covers a slow
 * GitHub with room; a second mint on the same row waits for the first, never longer.
 */
const ACTIONS_WRITE_BUDGET: TransactionBudget = { timeoutMs: 45_000, maxWaitMs: 10_000 };

/** The row as the three calls need it. */
interface CredentialRow {
  id: string;
  projectId: string;
  workspaceId: string;
  scipUploadInstalledCredentialId: string | null;
  githubRepo: { installationId: string; owner: string; name: string } | null;
}

/** What a call needs to know about the row's repository. */
interface RepositoryTarget {
  row: CredentialRow;
  scope: CodeGraphUploadCredentialScope;
  /** True when Motir hosts the repository, so its Actions are Motir's to write. */
  hosted: boolean;
}

/** Translate motir-ai's answers into the room's refusals; everything else rethrows. */
function refusalOf(err: unknown): unknown {
  if (err instanceof MotirAiCodeGraphRefusedError) {
    return new ScipUploadCredentialRefusedError(err.problemCode);
  }
  if (err instanceof MotirAiUnavailableError) {
    return new ScipUploadCredentialRefusedError('codegraph_unavailable');
  }
  return err;
}

async function callAi<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw refusalOf(err);
  }
}

/** Read the row, assert `repository:manage` on its project, and resolve its
 *  repository. A row with no realized repository is the not-registered refusal,
 *  answered here with no motir-ai call. */
async function targetOf(rowId: string, ctx: ServiceContext): Promise<RepositoryTarget> {
  const found = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
    const row = await projectRepoRepository.findById(rowId, ctx.workspaceId, tx);
    if (!row) return null;
    const organizationId = await workspaceRepository.findOrganizationId(row.workspaceId, tx);
    return { row, organizationId };
  });
  if (!found) throw new ProjectRepoNotFoundError(rowId);
  const { row, organizationId } = found;
  await projectAccessService.assertPermission(row.projectId, ctx, 'repository:manage');
  if (!row.githubRepo || !organizationId) {
    throw new ScipUploadCredentialRefusedError('codegraph_repository_not_registered');
  }
  return {
    row,
    scope: {
      coreOrganizationId: organizationId,
      repoRef: `${row.githubRepo.owner}/${row.githubRepo.name}`,
    },
    hosted: isMotirHostedOwner(row.githubRepo.owner, await motirOwnedOrgLogins()),
  };
}

async function coordinatesOf(
  githubRepo: NonNullable<CredentialRow['githubRepo']>,
): Promise<RepositoryCoordinates> {
  return {
    installationId: await hostInstallationIdOf(githubRepo.installationId),
    owner: githubRepo.owner,
    repo: githubRepo.name,
  };
}

/** Delete the secret and both variables. Each delete is `absent` on a 404, so a
 *  repeat is free. */
async function deleteFromActions(coordinates: RepositoryCoordinates): Promise<void> {
  await repositoryActionsConfigClient.deleteSecret(coordinates, SCIP_UPLOAD_TOKEN_SECRET);
  for (const name of SCIP_UPLOAD_VARIABLES) {
    await repositoryActionsConfigClient.deleteVariable(coordinates, name);
  }
}

/**
 * Install a minted credential in a hosted repository's Actions. Answers whether the
 * row now names it, and whether any GitHub write failed. Never throws a GitHub
 * failure: the credential exists either way.
 */
async function install(
  target: RepositoryTarget,
  minted: { credentialId: string; token: string; repositoryId: string; uploadUrl: string },
): Promise<{ installed: boolean; failed: boolean }> {
  let coordinates: RepositoryCoordinates;
  try {
    coordinates = await coordinatesOf(target.row.githubRepo!);
  } catch {
    return { installed: false, failed: true };
  }

  let installed = false;
  try {
    installed = await withWorkspaceServiceContext(
      target.row.workspaceId,
      async (tx) => {
        const locked = await projectRepoRepository.findForScipUploadUpdate(target.row.id, tx);
        if (!locked) return false;
        try {
          await repositoryActionsConfigClient.putSecret(
            coordinates,
            SCIP_UPLOAD_TOKEN_SECRET,
            minted.token,
          );
        } catch {
          return false;
        }
        await projectRepoRepository.setScipUploadInstalledCredential(
          target.row.id,
          minted.credentialId,
          tx,
        );
        return true;
      },
      ACTIONS_WRITE_BUDGET,
    );
  } catch {
    // The transaction did not commit. If the secret was written its token is the
    // new credential's while the row may still name an older one — so say the
    // install failed, and the person mints again or pastes it in.
    return { installed: false, failed: true };
  }
  // The row went away, or GitHub refused the secret: the row names nothing new.
  if (!installed) return { installed: false, failed: true };

  try {
    await repositoryActionsConfigClient.ensureVariable(
      coordinates,
      CODEGRAPH_REPOSITORY_ID_VARIABLE,
      minted.repositoryId,
    );
    await repositoryActionsConfigClient.ensureVariable(
      coordinates,
      CODEGRAPH_UPLOAD_URL_VARIABLE,
      minted.uploadUrl,
    );
  } catch {
    return { installed: true, failed: true };
  }
  return { installed: true, failed: false };
}

export const scipUploadCredentialService = {
  /**
   * Mint ONE named upload credential for the row's repository, and on a hosted row
   * install it in the repository's Actions. The answer carries the token once.
   *
   * @throws ProjectRepoInvalidFieldError for a blank or refused name (422).
   * @throws ScipUploadCredentialRefusedError for the three refusals; nothing written.
   */
  async mint(
    rowId: string,
    input: { name: string },
    ctx: ServiceContext,
  ): Promise<MintedScipUploadCredentialDto> {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new ProjectRepoInvalidFieldError('name', 'the credential needs a name');
    }
    const target = await targetOf(rowId, ctx);

    let minted;
    try {
      minted = await mintCodeGraphUploadCredential({ ...target.scope, name });
    } catch (err) {
      // motir-ai's bound on the name (its length) is its own; its refusal is the
      // room's invalid-field answer, not a 500.
      if (
        err instanceof MotirAiBadRequestError &&
        !(err instanceof MotirAiCodeGraphRefusedError) &&
        (err.httpStatus === 400 || err.httpStatus === 422)
      ) {
        throw new ProjectRepoInvalidFieldError('name', err.detail);
      }
      throw refusalOf(err);
    }
    // motir-ai's mint answers no creation time; the credential was made inside this
    // request, so the moment its answer arrived stands for it until the next list
    // reads the code graph's own.
    const createdAt = new Date().toISOString();

    const outcome = target.hosted
      ? await install(target, minted)
      : { installed: false, failed: false };

    return {
      credentialId: minted.credentialId,
      name: minted.name,
      displayPrefix: minted.displayPrefix,
      createdAt,
      revokedAt: null,
      installedInActions: outcome.installed,
      token: minted.token,
      repositoryId: minted.repositoryId,
      uploadUrl: minted.uploadUrl,
      installFailed: outcome.failed,
    };
  },

  /** The row's credentials as the code graph lists them, each marked whether it is
   *  the one installed in the repository's Actions. */
  async list(rowId: string, ctx: ServiceContext): Promise<ScipUploadCredentialDto[]> {
    const target = await targetOf(rowId, ctx);
    const credentials = await callAi(() => listCodeGraphUploadCredentials(target.scope));
    const installedId = target.hosted ? target.row.scipUploadInstalledCredentialId : null;
    return credentials.map((credential) => ({
      credentialId: credential.credentialId,
      name: credential.name,
      displayPrefix: credential.displayPrefix,
      createdAt: credential.createdAt,
      revokedAt: credential.revokedAt,
      installedInActions: installedId !== null && credential.credentialId === installedId,
    }));
  },

  /**
   * Revoke one credential. When it is the one installed in a hosted repository's
   * Actions, the secret and both variables are deleted, and the row's installed id
   * cleared, BEFORE the code graph is asked — so a failed revoke leaves no secret.
   *
   * @throws ScipUploadActionsWriteError when GitHub refused a delete; nothing was
   *   revoked and a retry repeats the deletes.
   * @throws ScipUploadCredentialRefusedError for the refusals.
   */
  async revoke(
    rowId: string,
    credentialId: string,
    ctx: ServiceContext,
  ): Promise<RevokedScipUploadCredentialDto> {
    const target = await targetOf(rowId, ctx);
    if (target.hosted && target.row.scipUploadInstalledCredentialId === credentialId) {
      const coordinates = await coordinatesOf(target.row.githubRepo!);
      await withWorkspaceServiceContext(
        target.row.workspaceId,
        async (tx) => {
          const locked = await projectRepoRepository.findForScipUploadUpdate(target.row.id, tx);
          // Re-read under the lock: a mint that landed meanwhile installed another
          // credential, whose secret this revoke must leave alone.
          if (!locked || locked.scipUploadInstalledCredentialId !== credentialId) return;
          try {
            await deleteFromActions(coordinates);
          } catch (err) {
            throw new ScipUploadActionsWriteError(
              err instanceof Error ? err.message : 'GitHub refused the delete',
            );
          }
          await projectRepoRepository.setScipUploadInstalledCredential(target.row.id, null, tx);
        },
        ACTIONS_WRITE_BUDGET,
      );
    }
    const answer = await callAi(() =>
      revokeCodeGraphUploadCredential({ ...target.scope, credentialId }),
    );
    return { credentialId: answer.credentialId, revoked: answer.revoked };
  },

  /**
   * The takeover saga's step (MOTIR-12339): before the transfer, while the
   * provisioning App still reaches the repository, delete the secret and both
   * variables — unconditionally, each idempotent — and clear the installed id. The
   * credential itself is NOT revoked at the code graph: the person taking the
   * repository over may move the token they were shown into their own secret.
   * A row with no realized repository, or one Motir does not host, has nothing here.
   */
  async removeFromRepository(rowId: string): Promise<void> {
    const subject = await withSystemContext((tx) =>
      projectRepoRepository.findScipUploadSubjectInTx(rowId, tx),
    );
    if (!subject?.githubRepo) return;
    if (!isMotirHostedOwner(subject.githubRepo.owner, await motirOwnedOrgLogins())) return;
    await deleteFromActions(await coordinatesOf(subject.githubRepo));
    await withWorkspaceServiceContext(subject.workspaceId, (tx) =>
      projectRepoRepository.setScipUploadInstalledCredential(subject.id, null, tx),
    );
  },
};

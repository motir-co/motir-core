import { repoRefOf } from '@/lib/github/indexEnqueue';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';

// THE GITHUB DELIVERY → STORED SCOPE READ, shared by the webhook's code-graph
// listeners (MOTIR-12056 forward, MOTIR-12257 pull-request head index).
//
// A delivery names an installation and a repository by GitHub's numeric ids. This
// resolves them to the stored installation → repository row → workspace →
// organisation, or says which link is missing. Moved verbatim out of
// `githubCodeGraphForwardService.ts`, which keeps calling it.
//
// ⚠️ THE ORGANISATION READ BINDS THE WORKSPACE FIRST, like
// `codeGraphIndexService.resolveIndexTarget`: `workspace`'s policies key on
// `app.workspace_id`, so an unbound read returns null and raises nothing.

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A GitHub numeric id, as the string the mirror stores it as. */
export function readId(value: unknown): string | null {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : null;
}

export const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value !== '';

/** The repository's name for the log: `owner/name` from the payload, never a token or URL. */
export function logRef(body: Record<string, unknown>): string {
  const fullName = asRecord(body['repository'])?.['full_name'];
  return typeof fullName === 'string' ? fullName : '(unknown repository)';
}

/** The stored repository a delivery resolved to. */
export interface ResolvedDeliveryScope {
  kind: 'resolved';
  coreOrganizationId: string;
  /** `owner/name`, as the index ledger records it. */
  repoRef: string;
  /** GitHub's numeric installation id, as the delivery named it — the token-minting key. */
  installationId: string;
  workspaceId: string;
  owner: string;
  name: string;
  /** The default branch as the repository row stores it. */
  defaultBranch: string;
}

/** The stored installation → repository row → workspace → organisation, or why not. */
export async function resolveDeliveryScope(
  body: Record<string, unknown>,
  providerRepoId: string,
): Promise<ResolvedDeliveryScope | { kind: 'unknown_installation' | 'unknown_repo' }> {
  const installationId = readId(asRecord(body['installation'])?.['id']);
  if (!installationId) return { kind: 'unknown_installation' };
  return withSystemContext(async (tx) => {
    const installation = await githubInstallationRepository.findByInstallationId(
      installationId,
      tx,
    );
    if (!installation) return { kind: 'unknown_installation' as const };
    const repo = await githubRepoRepository.findByInstallationAndRepoId(
      installation.id,
      providerRepoId,
      tx,
    );
    if (!repo) return { kind: 'unknown_repo' as const };
    await bindWorkspaceContext(tx, repo.workspaceId);
    const workspace = await workspaceRepository.findByIdInTx(repo.workspaceId, tx);
    // A repository row whose workspace is gone holds nothing to act for.
    if (!workspace) return { kind: 'unknown_repo' as const };
    return {
      kind: 'resolved' as const,
      coreOrganizationId: workspace.organizationId,
      repoRef: repoRefOf({ owner: repo.owner, name: repo.name }),
      installationId,
      workspaceId: repo.workspaceId,
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
    };
  });
}

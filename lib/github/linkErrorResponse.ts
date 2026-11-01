import { NextResponse } from 'next/server';
import {
  GithubIdentityRefusedError,
  InstallationNotAccessibleError,
  InstallationNotLinkableError,
  RepoSelectionRequiredError,
  RepositoryNotVisibleError,
  RepositoryOwnedByOtherOrganizationError,
} from '@/lib/github/errors';

// Typed-error → HTTP response for the organisation's GitHub connect routes
// (Story MOTIR-8216 · MOTIR-8220). Returns null for anything else so the route
// hands it on (to `mapOrgError`, then a real 500). No body names another
// organisation, workspace or project: a conflict lists the repository only.
export function mapGithubLinkError(err: unknown): NextResponse | null {
  if (err instanceof RepositoryOwnedByOtherOrganizationError) {
    return NextResponse.json(
      { code: 'repository_owned_by_other_organization', repos: err.repositories },
      { status: 409 },
    );
  }
  if (err instanceof RepoSelectionRequiredError) {
    return NextResponse.json({ code: 'repo_selection_required' }, { status: 422 });
  }
  if (err instanceof RepositoryNotVisibleError) {
    return NextResponse.json(
      { code: 'repository_not_visible', repoIds: err.repoIds },
      { status: 422 },
    );
  }
  if (
    err instanceof InstallationNotAccessibleError ||
    err instanceof InstallationNotLinkableError
  ) {
    return NextResponse.json({ code: 'installation_not_accessible' }, { status: 403 });
  }
  // The actor's own GitHub sign-in is dead (Bug MOTIR-8984): a fact about the
  // person, not the account, so it is told apart from the 403 above by its code.
  if (err instanceof GithubIdentityRefusedError) {
    return NextResponse.json({ code: 'github_identity_refused' }, { status: 409 });
  }
  return null;
}

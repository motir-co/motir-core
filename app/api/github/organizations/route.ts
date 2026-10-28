import { NextResponse } from 'next/server';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { GithubUserOrgsError } from '@/lib/github/userOrgs';
import { GithubIdentityRefusedError } from '@/lib/github/errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// The acting member's GitHub ORGANIZATIONS (Story MOTIR-1775 · MOTIR-1939) — the
// takeover picker's "Your organizations" group.
//
//   GET → 200 { organizations: [{ login, avatarUrl }] }
//       → 502 { code: 'GITHUB_ORGS_UNAVAILABLE' } when GitHub could not answer
//       → 409 { code: 'github_identity_refused' } when the member's GitHub
//         sign-in is dead and could not be renewed (Bugs MOTIR-8984 · MOTIR-10021)
//
// ⚠️ THE FAILURE IS A FIRST-CLASS ANSWER, NOT A 500. Nothing stores an
// organization list, so this is a live `GET /user/orgs` that can be slow or
// refused — and the picker is REQUIRED to keep working when it is, with the
// personal account still selectable (design/repository-set §14.5). A typed 502
// is what lets the surface render "Motir couldn't reach your GitHub
// organizations just now" and stay usable, instead of an unhandled error the
// client can only show as a broken dialog.
//
// A member with NO connected identity gets an empty list, not an error: the
// surface answers that case with MOTIR-1900's connect prompt long before the
// picker renders.

export async function GET(): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  try {
    const organizations = await githubIdentityService.listOrganizations(ctx.userId);
    return NextResponse.json({ organizations });
  } catch (err) {
    if (err instanceof GithubUserOrgsError) {
      return NextResponse.json({ code: 'GITHUB_ORGS_UNAVAILABLE' }, { status: 502 });
    }
    // A refused renewal is a dead sign-in, not an unreachable GitHub — the same
    // code the organisation connect routes answer it with (`mapGithubLinkError`).
    if (err instanceof GithubIdentityRefusedError) {
      return NextResponse.json({ code: 'github_identity_refused' }, { status: 409 });
    }
    throw err;
  }
}

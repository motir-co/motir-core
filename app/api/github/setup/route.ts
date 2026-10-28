import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { resolveTwoFactorHold } from '@/lib/auth/requireCompliantSession';
import {
  decodeInstallStateResult,
  type InstallReturnContext,
  type InstallStateResult,
} from '@/lib/github/installState';
import type { GithubBannerStatus } from '@/lib/github/bannerStatus';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { organizationRepoService } from '@/lib/services/organizationRepoService';
import { workspacesService } from '@/lib/services/workspacesService';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import {
  githubReturnLocation,
  resolveReturnPath,
  type GithubReturnSurfaceId,
} from '@/lib/github/returnSurface';
import { onboardingReturnContextParams } from '@/lib/planning/onboardingHandoff';
import {
  InstallationNotAccessibleError,
  InstallationNotLinkableError,
  RepoSelectionRequiredError,
  RepositoryOwnedByOtherOrganizationError,
} from '@/lib/github/errors';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import {
  OrganizationClosingError,
  OrganizationNotFoundError,
  OrgForbiddenError,
} from '@/lib/organizations/errors';

// GET /api/github/setup (Story 7.10 · MOTIR-1588) — the GitHub App's **Setup URL**.
// After a user installs the App, GitHub redirects here with `installation_id` +
// `setup_action` (+ the signed `state` the install link carried). This route
// establishes the installation → workspace binding the webhook (MOTIR-892)
// deliberately does NOT create, then bounces to the settings page.
//
// Routes are HTTP-only (CLAUDE.md): read the session, verify the signed state,
// authorize the actor, call ONE service method, redirect. The binding write, the
// account/repo fetch through the provider seam, and the persist all live in
// `githubInstallationService.bindInstallationForWorkspace`.

// WHERE THIS HANDLER RETURNS TO (MOTIR-4676 · MOTIR-8471). The install starts
// from a bare github.com URL, so no cookie can carry the origin — it rides
// INSIDE the signed install state, covered by the same HMAC as the workspace and
// the user, and is narrowed back to a known surface id on decode. Beside it
// rides the starting step's own query (`context`), re-narrowed by its owner and
// re-appended, so the person lands on the address they left from plus
// `github=<status>`.
//
// Every outcome reached once the state VERIFIES for the acting user returns
// there — including an organisation-approval request, and including an
// EXPIRED state, whose signature verified even though it may no longer bind.
// Every outcome reached without one (no state, an unreadable state, another
// user's state) falls back to `DEFAULT_RETURN_PATH`.
interface ReturnTarget {
  origin?: GithubReturnSurfaceId;
  context?: InstallReturnContext;
}

function settingsRedirect(
  status: GithubBannerStatus,
  target?: ReturnTarget | null,
  installationId?: string,
): NextResponse {
  // `select_repos` names the installation, so the room opens its repo picker.
  return NextResponse.redirect(
    `${resolveBaseUrlTrimmed()}${githubReturnLocation(
      resolveReturnPath(target?.origin ?? null),
      status,
      {
        context: onboardingReturnContextParams(target?.context),
        ...(installationId ? { installationId } : {}),
      },
    )}`,
  );
}

/** The return target a decoded state may name for THIS actor, or null. */
function returnTargetOf(decoded: InstallStateResult, actorUserId: string): ReturnTarget | null {
  if (decoded.ok) {
    if (decoded.state.userId !== actorUserId) return null;
    return { origin: decoded.state.origin, context: decoded.state.context };
  }
  if (decoded.reason === 'expired') return { origin: decoded.origin, context: decoded.context };
  return null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const session = await getSession();
  if (!session) {
    // Preserve the return target so a fresh sign-in lands back on this handler
    // with GitHub's install params intact.
    const next = encodeURIComponent(`${req.nextUrl.pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(`${resolveBaseUrlTrimmed()}/sign-in?next=${next}`);
  }

  // The 2FA hold (MOTIR-3653), shaped as a REDIRECT rather than the 403 the
  // other 85 routes return: GitHub sends the person here in the ADDRESS BAR, so
  // a JSON body would be rendered as text. The return target rides along for the
  // same reason it does above — enrol, come back, and the installation still
  // binds instead of being lost.
  const hold = await resolveTwoFactorHold(session.user.id);
  if (hold) {
    const next = encodeURIComponent(`${req.nextUrl.pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(`${resolveBaseUrlTrimmed()}${hold.enrolAt}?next=${next}`);
  }

  const params = req.nextUrl.searchParams;
  const installationId = params.get('installation_id');
  const setupAction = params.get('setup_action');
  const state = params.get('state');

  // `request` (org approval) and any other non-install action carry nothing to
  // bind, and nothing is bound. A `request` is its OWN outcome (MOTIR-8471):
  // a member of a GitHub organisation who is not one of its owners started the
  // install, GitHub sent the request to an owner, and nothing is installed until
  // one approves — so `installed`, which this answered before, said the
  // opposite of what happened. Its state (GitHub echoes it on a request too)
  // still names where the person started, so they go back there.
  if (setupAction && setupAction !== 'install' && setupAction !== 'update') {
    const target = state ? returnTargetOf(decodeInstallStateResult(state), session.user.id) : null;
    return settingsRedirect(
      setupAction === 'request' ? 'install_requested' : 'install_unbound',
      target,
    );
  }

  // NO STATE AT ALL — the round trip did not START in Motir, so there was never
  // a state to lose and nothing has failed (MOTIR-3755). A state is minted only
  // by an install link Motir hands out, so a request arriving without one came
  // from github.com.
  //
  // The overwhelmingly common case is editing the installation's REPOSITORY
  // SELECTION from the App's own settings on GitHub: it redirects here with
  // `setup_action=update` and no state, and the repository really is connected —
  // the repository set is maintained by the `installation_repositories` webhook,
  // not by this handler, and the installation → workspace binding this route
  // exists to write ALREADY EXISTS. Reporting `install_error` there told the
  // person the opposite of what happened and invited them to re-run an install
  // that had already succeeded.
  //
  // A bare `install` with no state is a DIFFERENT outcome and keeps its own
  // message: the App was installed from GitHub rather than from Motir, so no
  // binding was written and there IS something left to do.
  if (!state) {
    return settingsRedirect(setupAction === 'update' ? 'repos_updated' : 'install_unbound');
  }

  // The state is present, so it is verified exactly as before — MOTIR-3755
  // changed what a MISSING state means, never what a present one is trusted for.
  const decoded = decodeInstallStateResult(state);
  const target = returnTargetOf(decoded, session.user.id);
  if (!decoded.ok) {
    // An EXPIRED state is not a failure either: the person started from Motir
    // and spent longer than the 10-minute TTL on GitHub's repository picker. Its
    // remedy (start again) is the opposite of the tampered case's, so the two
    // must not share a banner. Its target is honoured; the binding is not.
    return settingsRedirect(
      decoded.reason === 'expired' ? 'install_expired' : 'install_error',
      target,
    );
  }
  // A state minted for a different user — the acting session must be the one
  // that started the install. `target` is null here, so this falls back.
  if (decoded.state.userId !== session.user.id) return settingsRedirect('install_error');
  if (!installationId) return settingsRedirect('install_error', target);

  // From here the state has VERIFIED, so its origin is ours and every remaining
  // outcome returns the person to the surface they started from (`target`).

  // THE ORGANISATION BRANCH (Story MOTIR-8216 · MOTIR-8220). A state that names
  // an organisation was minted by the Git room's "Install on another account",
  // and one GitHub account can now serve several organisations — so it goes
  // through the per-organisation link: the actor must ADMINISTER that
  // organisation (not merely belong to a workspace), the state's workspace must
  // belong to it, and the actor must be able to see the installation on GitHub.
  // `repoIds` is omitted, so a first link of an unshared account and a refresh
  // of an already-linked one behave as before, and a new link beside another
  // organisation sends the person to choose instead of taking anything.
  //
  // THE PROJECT ROOM (Bug MOTIR-9828). A state that ALSO names a project was
  // minted by a Repositories room's `Connect a new one`, which promises the
  // organisation connection AND the project link in one act. The same org link
  // runs, and then the repositories this round trip connected are linked into
  // that project — so the person lands back in the room with the new rows in it,
  // rather than on the org's inventory with half the job done.
  const organizationId = decoded.state.organizationId;
  if (organizationId) {
    const projectKey =
      decoded.state.origin === 'projectRepositories' ? decoded.state.projectKey : undefined;
    try {
      if (projectKey) {
        await organizationRepoService.linkInstallReturnIntoProject({
          projectKey,
          organizationId,
          installationId,
          since: new Date(decoded.issuedAt * 1000),
          ctx: { userId: session.user.id, workspaceId: decoded.state.workspaceId },
        });
      } else {
        await githubInstallationService.linkExistingInstallation({
          organizationId,
          actorUserId: session.user.id,
          installationId,
          via: 'install_return',
          workspaceIdHint: decoded.state.workspaceId,
          requireHintInOrganization: true,
        });
      }
    } catch (err) {
      const status = orgBranchOutcome(err);
      return settingsRedirect(
        status,
        target,
        status === 'select_repos' ? installationId : undefined,
      );
    }
    return settingsRedirect('installed', target);
  }

  // Authorize: the acting user must be a member of the target workspace — no
  // cross-workspace binding even with a validly-signed state.
  const role = await workspacesService.getMemberRole(session.user.id, decoded.state.workspaceId);
  if (!role) return settingsRedirect('install_forbidden', target);

  try {
    await githubInstallationService.bindInstallationForWorkspace({
      workspaceId: decoded.state.workspaceId,
      installationId,
    });
  } catch (err) {
    // Another organisation already uses this account (MOTIR-8219): nothing was
    // written, and the person picks their repositories instead.
    if (err instanceof RepoSelectionRequiredError) {
      return settingsRedirect('select_repos', target, installationId);
    }
    // Provider/config failure (e.g. GITHUB_APP_ID/PRIVATE_KEY unset) — surface a
    // clean banner, never a 500.
    return settingsRedirect('install_provider_error', target);
  }

  return settingsRedirect('installed', target);
}

/** Which banner an organisation-branch refusal returns to. */
function orgBranchOutcome(err: unknown): GithubBannerStatus {
  if (err instanceof RepoSelectionRequiredError) return 'select_repos';
  if (err instanceof RepositoryOwnedByOtherOrganizationError) return 'repo_unavailable';
  if (
    err instanceof InstallationNotAccessibleError ||
    err instanceof InstallationNotLinkableError
  ) {
    return 'installation_not_accessible';
  }
  if (
    err instanceof OrgForbiddenError ||
    err instanceof OrganizationNotFoundError ||
    err instanceof OrganizationClosingError ||
    // The project half (MOTIR-9828): the project the state names is gone, or
    // the actor may no longer manage its repositories.
    err instanceof ProjectNotFoundError ||
    err instanceof ProjectAccessDeniedError ||
    err instanceof PermissionDeniedError
  ) {
    return 'install_forbidden';
  }
  return 'install_provider_error';
}

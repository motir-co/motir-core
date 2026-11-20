import { githubFetch } from '@/lib/github/githubFetch';
import { ownedOrgTargetFor } from '@/lib/ciMetering/ownedOrgs';
import { resolveOrgAuth } from '@/lib/github/orgTarget';
import { RepoProvisioningError } from '@/lib/github/repoProvisioning';

// The COLLABORATOR boundary (Story MOTIR-1775 · MOTIR-1900) — the one module that
// talks to GitHub about who may reach a repository Motir owns.
//
// It is the sibling of `repoProvisioning.ts` and follows its shape exactly:
// everything above it (`projectRepoAccessService`) is plain orchestration over the
// set's rows, everything below it is `fetch`, and that line is where the tests
// fake. It authenticates in the REPOSITORY'S OWN org (MOTIR-8974): a repository in
// a fleet account's org through that account's installation, one in the
// provisioning org through `provisioningAuth()` exactly as before — so an invite
// can never be sent against a different org than the repository was created in.
// A fleet account whose token cannot be minted raises `OrgTargetAuthError`; it is
// never retried against the provisioning org.
//
// ⚠️ NO NEW PERMISSION IS REQUIRED. Collaborator management is part of
// `Administration: write`, which the provisioning credential (MOTIR-1779) already
// holds because it is what creates repositories. The user-facing App is untouched
// — nothing in this flow asks the user to grant anything, which is what lets the
// establish step stay GitHub-free (ADR §3 amendment).
//
// THE TWO MECHANICS, and why each endpoint was chosen:
//
//   * `PUT /repos/{owner}/{repo}/collaborators/{username}` is BOTH the invite and
//     the re-send: GitHub treats a repeat call on a pending invitation as an
//     update of that invitation rather than a second one, so "Resend invitation"
//     needs no separate endpoint and cannot produce a duplicate. It answers `201`
//     with the invitation (which carries the `html_url` the user must open) or
//     `204` when the account ALREADY has access — an org member, or someone who
//     accepted earlier. `204` is therefore not a failure: it is the accepted
//     state, arriving without an invitation to accept.
//
//   * `GET /repos/{owner}/{repo}/collaborators/{username}` is the ACCEPTANCE read
//     — `204` when the user is a collaborator, `404` when they are not. A pending
//     invitee is NOT yet a collaborator, so this cleanly separates "accepted" from
//     "still pending" without listing invitations and matching ids. GitHub owns
//     acceptance and sends Motir nothing when it happens, so a read is the only
//     honest way to learn it.

const GITHUB_API = 'https://api.github.com';

/**
 * The permission granted — PER INVITEE, not one value for the product
 * (MOTIR-1910; `docs/decisions/project-repository-set.md` §3 Q2).
 *
 * `admin` was originally the only level, justified by the TAKEOVER path: the
 * repository is the approving user's in every sense but the account it sits
 * under, so they get the rights they would have had if it had been created in
 * their own — including the settings needed to take it over later (MOTIR-711).
 * That reasoning is OWNER-shaped, and only the owner walks a transfer.
 *
 * A TEAMMATE gets `push`: clone, branch, push — everything the work needs, and
 * nothing that could transfer, rename or delete the project's repositories.
 */
export type CollaboratorPermission = 'push' | 'admin';

/** Any GitHub refusal or transport failure while granting or reading access.
 *  Carries the STATUS and a short detail, never the raw body — the same contract
 *  `RepoProvisioningApiError` holds, and it extends the same base so a caller can
 *  handle every host failure of this Story with one `instanceof`. */
export class RepoCollaboratorApiError extends RepoProvisioningError {
  readonly code = 'REPO_COLLABORATOR_FAILED' as const;
  constructor(
    readonly status: number | null,
    detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached while granting access to the repository (${detail}).`
        : `GitHub refused to grant access to the repository (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
  }
}

/** What one invite call produced. */
export interface CollaboratorInviteResult {
  /** TRUE when the account ALREADY had access (`204`) — there is no invitation to
   *  accept, so the row is `accepted` outright rather than `invited`. */
  alreadyHasAccess: boolean;
  /** GitHub's `html_url` for the pending invitation — where **Open the
   *  invitation** points. Null on the `alreadyHasAccess` path. */
  invitationUrl: string | null;
}

export interface CollaboratorTarget {
  /** The repository's owner as GitHub spells it — the realized repo's own value,
   *  not the configured org, so a repository that moved still resolves. */
  owner: string;
  /** The repository name in GitHub's casing. */
  repo: string;
  /** The GitHub LOGIN to invite — always a connected identity's, never typed. */
  login: string;
}

/** A {@link CollaboratorTarget} plus what to grant it — the invite's full input. */
export interface CollaboratorInvite extends CollaboratorTarget {
  permission: CollaboratorPermission;
}

async function request(
  url: string,
  init: { method: string; token: string; body?: string },
): Promise<Response> {
  try {
    return await githubFetch('repoCollaborators', url, {
      method: init.method,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'motir',
        authorization: `Bearer ${init.token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
    });
  } catch (err) {
    throw new RepoCollaboratorApiError(null, err instanceof Error ? err.message : 'unknown');
  }
}

/** GitHub's `message`, trimmed to a short developer detail. No raw body escapes. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    const message =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['message']
        : null;
    return typeof message === 'string' ? message.slice(0, 200) : '';
  } catch {
    return '';
  }
}

/** The provisioning credential in the repository's own org. */
async function authFor(target: CollaboratorTarget): Promise<{ token: string }> {
  return resolveOrgAuth(await ownedOrgTargetFor(target.owner));
}

function path(target: CollaboratorTarget): string {
  return (
    `${GITHUB_API}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}` +
    `/collaborators/${encodeURIComponent(target.login)}`
  );
}

export const repoCollaboratorClient = {
  /**
   * Invite `login` to `owner/repo` at `permission` — and RE-invite by the same
   * call, which is why "Resend invitation" needs nothing of its own.
   *
   * IDEMPOTENT. A repeat on a pending invitation updates it rather than creating a
   * second; a call for an account that already has access answers `204` and is
   * reported as {@link CollaboratorInviteResult.alreadyHasAccess}. So a retry
   * after a crash between the GitHub call and the row write costs one request and
   * converges on the same state. Re-sending at a DIFFERENT permission also
   * converges — GitHub updates the pending invitation's level rather than adding
   * one — which is what makes a role change safe to re-apply.
   */
  async invite(target: CollaboratorInvite): Promise<CollaboratorInviteResult> {
    const { token } = await authFor(target);
    const res = await request(path(target), {
      method: 'PUT',
      token,
      body: JSON.stringify({ permission: target.permission }),
    });

    // 204: already a collaborator (an org member, or an earlier invitation they
    // have since accepted). Nothing was created and nothing is pending.
    if (res.status === 204) return { alreadyHasAccess: true, invitationUrl: null };
    if (!res.ok) throw new RepoCollaboratorApiError(res.status, await errorDetail(res));

    // 201: a pending invitation. Its `html_url` is the ONLY way back to it — the
    // invitation is a GitHub object, not something reconstructible from the repo
    // coordinates — but a body that omits it is not worth failing an otherwise
    // successful invite over, so it degrades to null and the row simply offers no
    // "Open the invitation" link.
    let invitationUrl: string | null = null;
    try {
      const body: unknown = await res.json();
      const raw =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)['html_url']
          : null;
      if (typeof raw === 'string' && raw.length > 0) invitationUrl = raw;
    } catch {
      /* a non-JSON 201 is still an invitation — just one with no door */
    }
    return { alreadyHasAccess: false, invitationUrl };
  },

  /**
   * Has `login` ACCEPTED — i.e. are they a collaborator on `owner/repo` right now?
   *
   * `204` yes, `404` no. A pending invitee reads `404`, which is correct: they
   * cannot clone yet. Every other status is the typed error, because "GitHub is
   * refusing to answer" must not be silently reported to the user as "not
   * accepted" — the caller keeps the state it already had.
   */
  async hasAccepted(target: CollaboratorTarget): Promise<boolean> {
    const { token } = await authFor(target);
    const res = await request(path(target), { method: 'GET', token });
    if (res.status === 204) return true;
    if (res.status === 404) return false;
    throw new RepoCollaboratorApiError(res.status, await errorDetail(res));
  },
};

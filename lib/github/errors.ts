// Typed errors for the GitHub integration (Story 7.10 · MOTIR-1498). Kept in
// their own file so route handlers can import them without pulling in the
// Prisma client or the service. Each carries a discriminating `code` the route
// layer maps to an HTTP redirect status query.

/**
 * The GitHub OAuth app credentials (`GITHUB_APP_CLIENT_ID` /
 * `GITHUB_APP_CLIENT_SECRET`) are not configured on this deployment. Read at
 * call time (not module load), so a self-hosted instance that never wires
 * GitHub simply can't reach the flow rather than crashing on boot.
 */
export class GithubOAuthNotConfiguredError extends Error {
  readonly code = 'GITHUB_OAUTH_NOT_CONFIGURED' as const;
  constructor() {
    super('GitHub OAuth is not configured. Set GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET.');
    this.name = 'GithubOAuthNotConfiguredError';
  }
}

/**
 * The user-identity grant failed at GitHub: the code→token exchange returned
 * no token, or the `GET /user` read failed. Never carries the raw GitHub error
 * body (which can echo the code) — just a stable code the callback turns into a
 * redirect the settings UI renders as "couldn't connect, try again".
 */
export class GithubOAuthExchangeError extends Error {
  readonly code = 'GITHUB_OAUTH_EXCHANGE_FAILED' as const;
  constructor(detail: string) {
    super(`GitHub OAuth identity grant failed: ${detail}`);
    this.name = 'GithubOAuthExchangeError';
  }
}

/**
 * The inbound-webhook shared secret (`GITHUB_WEBHOOK_SECRET`) is not configured
 * on this deployment (Story 7.10 · MOTIR-892). Read at call time, so a
 * self-hosted instance that never wires GitHub can't reach the webhook path
 * rather than crashing on boot. A server MISCONFIG (→ 500), distinct from a bad
 * signature (→ 401): without a secret we can neither trust nor reject a delivery.
 */
export class GithubWebhookNotConfiguredError extends Error {
  readonly code = 'GITHUB_WEBHOOK_NOT_CONFIGURED' as const;
  constructor() {
    super('GitHub webhooks are not configured. Set GITHUB_WEBHOOK_SECRET.');
    this.name = 'GithubWebhookNotConfiguredError';
  }
}

/**
 * A webhook delivery's `X-Hub-Signature-256` is missing or does not match the
 * HMAC we recompute over the raw body with `GITHUB_WEBHOOK_SECRET` (Story 7.10 ·
 * MOTIR-892). The route rejects it 401 BEFORE parsing the body — an unauthentic
 * delivery is never processed. Carries no detail (nothing to leak to an attacker
 * probing the endpoint).
 */
export class GithubWebhookSignatureError extends Error {
  readonly code = 'GITHUB_WEBHOOK_INVALID_SIGNATURE' as const;
  constructor() {
    super('GitHub webhook signature verification failed.');
    this.name = 'GithubWebhookSignatureError';
  }
}

/**
 * The workspace has no GitHub App installation (Story 7.10 · MOTIR-1596). The
 * explicit item→PR link picker can offer no candidates — design/github Panel 5c's
 * disconnected-workspace banner. The two grants are independent, so this means
 * the installation grant is absent, regardless of the per-user identity grant.
 */
export class GithubNotConnectedError extends Error {
  readonly code = 'GITHUB_NOT_CONNECTED' as const;
  constructor() {
    super('GitHub is not connected for this workspace.');
    this.name = 'GithubNotConnectedError';
  }
}

/**
 * The target PR does not exist in the caller's workspace (Story 7.10 ·
 * MOTIR-1596): an unknown id OR a cross-workspace probe — collapsed to ONE error
 * so existence never leaks (the no-leak convention). Surfaced in the explicit-
 * link form's rose banner.
 */
export class GithubPullRequestNotFoundError extends Error {
  readonly code = 'GITHUB_PR_NOT_FOUND' as const;
  constructor(id: string) {
    super(`GitHub pull request not found: ${id}`);
    this.name = 'GithubPullRequestNotFoundError';
  }
}

/**
 * The named REPOSITORY does not exist in the caller's organisation (Story
 * MOTIR-3525 · MOTIR-3526): an unknown `owner/name` OR a cross-organisation probe —
 * collapsed to ONE error so existence never leaks, exactly as
 * {@link GithubPullRequestNotFoundError} does for a pull request.
 *
 * Raised by the coordinate-addressed link path, which resolves the repository
 * from the REPO ROW (MOTIR-1931) rather than through its installation — under
 * Motir's shared provisioning installation the installation names no workspace
 * at all, so the older join would have made this permanently not-found for every
 * repository Motir created — and at the ORGANISATION tier (MOTIR-5188), so the
 * message names the organisation: saying "this workspace" would describe a
 * narrower gate than the one that refused.
 */
export class GithubRepoNotFoundError extends Error {
  readonly code = 'GITHUB_REPO_NOT_FOUND' as const;
  constructor(coordinate: string) {
    super(
      `GitHub repository not connected to this workspace's organisation: ${coordinate}. ` +
        'Name it as "owner/name" exactly as the repository is connected.',
    );
    this.name = 'GithubRepoNotFoundError';
  }
}

/** One repository a claim was refused for — the host id and `owner/name` the
 *  claimant can already see on GitHub. Never anything about the owner. */
export interface ConflictingRepository {
  repoId: string;
  fullName: string;
}

/**
 * A claim named a repository another Motir organisation already owns (Story
 * MOTIR-8216 · MOTIR-8219). A repository belongs to ONE organisation, so the
 * whole claim is refused and nothing is written. Carries the conflicting
 * repositories only: neither the payload nor the message names the other
 * organisation, its workspaces or its projects.
 */
export class RepositoryOwnedByOtherOrganizationError extends Error {
  readonly code = 'GITHUB_REPO_OWNED_BY_OTHER_ORGANIZATION' as const;
  constructor(readonly repositories: ConflictingRepository[]) {
    super(
      `Already connected to another Motir organisation: ${repositories
        .map((repo) => repo.fullName)
        .join(', ')}. A repository can belong to only one organisation.`,
    );
    this.name = 'RepositoryOwnedByOtherOrganizationError';
  }
}

/**
 * A NEW link to an installation another organisation is already linked to,
 * with no repositories chosen (MOTIR-8219). Taking every visible repository
 * would grab the other organisation's choices, so the caller must choose.
 */
export class RepoSelectionRequiredError extends Error {
  readonly code = 'GITHUB_REPO_SELECTION_REQUIRED' as const;
  constructor() {
    super('Choose which repositories this organisation should use from this GitHub account.');
    this.name = 'RepoSelectionRequiredError';
  }
}

/** A chosen repository the GitHub App cannot see on this installation
 *  (MOTIR-8219) — not selected on GitHub, or no longer there. */
export class RepositoryNotVisibleError extends Error {
  readonly code = 'GITHUB_REPO_NOT_VISIBLE' as const;
  constructor(readonly repoIds: string[]) {
    super(
      `The Motir GitHub App cannot see ${repoIds.length === 1 ? 'this repository' : 'these repositories'} on this account: ${repoIds.join(', ')}.`,
    );
    this.name = 'RepositoryNotVisibleError';
  }
}

/** The installation is Motir's own shared provisioning installation
 *  (MOTIR-1931), which belongs to no tenant and is never linked to one
 *  (MOTIR-8219). */
export class InstallationNotLinkableError extends Error {
  readonly code = 'GITHUB_INSTALLATION_NOT_LINKABLE' as const;
  constructor() {
    super('This GitHub installation cannot be connected to an organisation.');
    this.name = 'InstallationNotLinkableError';
  }
}

/** The actor cannot see this installation on GitHub (Story MOTIR-8216 ·
 *  MOTIR-8220) — it is not among the installations their linked GitHub identity
 *  can access, they have no linked identity to ask with, or it is Motir's own
 *  shared provisioning installation. Trusting an `installation_id` from a URL or
 *  a body is exactly what this refuses, signed state or not. */
export class InstallationNotAccessibleError extends Error {
  readonly code = 'GITHUB_INSTALLATION_NOT_ACCESSIBLE' as const;
  constructor() {
    super('You cannot access this GitHub account on GitHub, so it cannot be linked.');
    this.name = 'InstallationNotAccessibleError';
  }
}

/** GitHub REFUSED the actor's stored user token (HTTP 401 Bad credentials) —
 *  the sign-in was revoked, replaced or has expired (Bug MOTIR-8984). It is a
 *  dead credential, not an unreachable GitHub: retrying cannot work, and the
 *  only remedy is the member reconnecting their account. Every surface answers
 *  it with a reconnect prompt, never "couldn't reach GitHub". */
export class GithubIdentityRefusedError extends Error {
  readonly code = 'GITHUB_IDENTITY_REFUSED' as const;
  constructor() {
    super('GitHub no longer accepts your linked GitHub sign-in. Reconnect your GitHub account.');
    this.name = 'GithubIdentityRefusedError';
  }
}

/** Renewing the actor's expiring GitHub user token could not be done just now
 *  (Bug MOTIR-10021): GitHub's token endpoint did not answer, timed out or
 *  answered 5xx. Unlike {@link GithubIdentityRefusedError} the sign-in is NOT
 *  known to be dead, and the next call tries the renewal again — so every
 *  surface answers it as "couldn't reach GitHub", which is true. */
export class GithubIdentityRefreshUnavailableError extends Error {
  readonly code = 'GITHUB_IDENTITY_REFRESH_UNAVAILABLE' as const;
  constructor(detail: string) {
    super(`Motir couldn't renew your GitHub sign-in just now: ${detail}`);
    this.name = 'GithubIdentityRefreshUnavailableError';
  }
}

/** The organisation is not linked to this GitHub installation (Story MOTIR-8216
 *  · MOTIR-8222) — it was never connected, it has already disconnected, or it is
 *  Motir's own shared provisioning installation, which no organisation is linked
 *  to. Names nothing about any other organisation. */
export class InstallationNotLinkedError extends Error {
  readonly code = 'GITHUB_INSTALLATION_NOT_LINKED' as const;
  constructor() {
    super('This GitHub account is not connected to this organisation.');
    this.name = 'InstallationNotLinkedError';
  }
}

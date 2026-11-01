import { mintInstallationToken } from '@/lib/github/appAuth';

// The Actions-PERMISSIONS boundary (Story MOTIR-1775 · MOTIR-1907) — the one
// module that tells GitHub whether a repository may run workflows at all.
//
// It is the sibling of `lib/github/repoProvisioning.ts` and follows its shape
// deliberately: all of the host mechanics live here, none of the row bookkeeping
// does, and the line between them is where the tests fake. Services import it
// directly; routes never do (a LEAF PRIMITIVE, in the `appAuth.ts` sense).
//
// ⚠️ WHY PER-REPOSITORY AND NOT THE ORG-LEVEL CALL. ADR §A weighed both and
// chose `PUT /repos/{owner}/{repo}/actions/permissions`:
//
//   * It needs **Repository permissions → "Administration" write**, which the
//     provisioning App (MOTIR-1779) ALREADY carries — creating a repository
//     requires it. So this card adds NO new App permission, which is what makes
//     it deployable without a re-consent from every installation.
//   * `PUT /orgs/{org}/actions/permissions` with `enabled_repositories: selected`
//     was rejected on two independent grounds: it needs ORGANIZATION-level
//     "Administration", a DIFFERENT permission the App does not hold; and it is
//     ONE shared mutable list across every tenant in Motir's org — a write
//     contention point with an org-wide blast radius. Per-repo is per-tenant by
//     construction.
//
// ⚠️ THIS IS NOT ON THE `GitProvider` SEAM, for the same reason repo creation is
// not (§5.6): Motir only ever disables Actions on repositories IT created, which
// exist only in its own GitHub org. There is no second host to dispatch to and
// no stored `provider` discriminator to dispatch on.

const GITHUB_API = 'https://api.github.com';

/** Every failure this module raises. `reason` is the human-readable sentence the
 *  caller logs; no raw GitHub body ever escapes. */
export class ActionsPermissionsError extends Error {
  readonly code = 'ACTIONS_PERMISSIONS_FAILED' as const;
  constructor(
    readonly status: number | null,
    readonly detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached while setting Actions permissions (${detail}).`
        : `GitHub refused to set Actions permissions (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'ActionsPermissionsError';
  }
}

export interface SetActionsEnabledInput {
  /** GitHub's numeric installation id the repository lives in — for a
   *  Motir-created repo, the PROVISIONING installation. It is the installation's
   *  own `GithubInstallation.installationId`, NOT the mirror row's
   *  `installationId`: that column is the foreign key to `GithubInstallation.id`,
   *  a cuid GitHub never issued (MOTIR-10062). */
  installationId: string;
  owner: string;
  repo: string;
  /** The DESIRED state. `false` disables workflows; `true` re-enables them. */
  enabled: boolean;
}

export const actionsPermissionsClient = {
  /**
   * Set one repository's Actions permission to `enabled`.
   *
   * IDEMPOTENT BY CONSTRUCTION, and that is the whole reason this is a `PUT` of a
   * desired state rather than a pair of enable/disable verbs: GitHub returns
   * `204` for "disable an already-disabled repo" exactly as it does for a real
   * change. The card's "disabling twice is a no-op, not an error" criterion is
   * therefore a property of the API, and the caller needs no read-before-write
   * (which would only add a race between the read and the write).
   *
   * A `404` is treated as SUCCESS, deliberately. The repository is gone — deleted
   * by the user, or transferred out of Motir's org by MOTIR-711's handoff. In
   * both cases Motir no longer pays for its Actions and there is nothing left to
   * disable, so the intent IS satisfied. Retrying such a row forever (the
   * alternative) would keep a permanently-failing entry in every sweep.
   */
  async setActionsEnabled(input: SetActionsEnabledInput): Promise<void> {
    const token = await mintToken(input.installationId);
    const url =
      `${GITHUB_API}/repos/${encodeURIComponent(input.owner)}/` +
      `${encodeURIComponent(input.repo)}/actions/permissions`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'PUT',
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'motir',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ enabled: input.enabled }),
      });
    } catch (err) {
      throw new ActionsPermissionsError(null, err instanceof Error ? err.message : 'unknown');
    }

    // 204 is the documented success. 404 is the repo-is-gone case above.
    if (res.status === 204 || res.status === 404) return;
    throw new ActionsPermissionsError(res.status, await errorDetail(res));
  },
};

/** Mint the provisioning installation token. An unwired Studio App surfaces as
 *  the same typed error as any other refusal — the caller's contract is "this
 *  row did not settle", and WHY is a log detail, not a second branch. */
async function mintToken(installationId: string): Promise<string> {
  try {
    const { token } = await mintInstallationToken(installationId, 'provisioning');
    return token;
  } catch (err) {
    throw new ActionsPermissionsError(null, err instanceof Error ? err.message : 'unknown');
  }
}

/** GitHub's `message`, trimmed to a short developer detail — never the payload. */
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

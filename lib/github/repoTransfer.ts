import { mintInstallationToken } from '@/lib/github/appAuth';

// The repository-TRANSFER boundary (Story MOTIR-1775 · MOTIR-711) — the one module
// that hands a Motir-owned repository to its new owner on GitHub.
//
// It is the sibling of `lib/github/actionsPermissions.ts` and `repoProvisioning.ts`
// and follows their shape deliberately: all of the host mechanics live here, none
// of the row bookkeeping does, and the line between them is where the tests fake.
// Services import it directly; routes never do (a LEAF PRIMITIVE, in the
// `appAuth.ts` sense).
//
// ⚠️ IT NEEDS NO NEW APP PERMISSION. `POST /repos/{owner}/{repo}/transfer` runs
// under Repository → "Administration" write, which the provisioning App
// (MOTIR-1779) ALREADY carries because CREATING a repository requires it. That is
// what makes the takeover deployable without a re-consent from every installation
// — the same argument `actionsPermissions.ts` records for the per-repo Actions
// call, and the reason the repo-set ADR's 2026-07-30 amendment could promote the
// handoff from an escape hatch to the standard path.
//
// ⚠️ THE CALL IS ASYNCHRONOUS AND MAY NOT BE FINISHED WHEN IT RETURNS. GitHub
// answers `202 Accepted`, and for a PERSONAL-ACCOUNT target the new owner must
// ACCEPT the transfer on github.com before the repository actually moves. So a
// `202` means "GitHub took the request", never "the repo is theirs" — which is
// exactly why the caller records `transfer_pending` and waits for the `repository`
// `transferred` delivery instead of assuming.
//
// ⚠️ THIS IS NOT ON THE `GitProvider` SEAM, for the same reason repo creation and
// the Actions call are not (ADR §5.6): Motir only ever transfers repositories IT
// created, which exist only in its own GitHub org. There is no second host to
// dispatch to and no stored `provider` discriminator to dispatch on.

const GITHUB_API = 'https://api.github.com';

/** Every failure this module raises. `detail` is the human-readable sentence the
 *  caller records as the row's failure reason; no raw GitHub body ever escapes. */
export class RepoTransferError extends Error {
  readonly code = 'REPO_TRANSFER_FAILED' as const;
  constructor(
    readonly status: number | null,
    readonly detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached while transferring the repository (${detail}).`
        : `GitHub refused the repository transfer (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'RepoTransferError';
  }
}

export interface TransferRepoInput {
  /** GitHub's numeric installation id the repository CURRENTLY lives in — for a
   *  Motir-created repo, the PROVISIONING installation. It is the installation's
   *  own `GithubInstallation.installationId`, NOT the mirror row's
   *  `installationId` (the foreign key to `GithubInstallation.id`, a cuid GitHub
   *  never issued — MOTIR-10062). Read before the transfer, because afterwards
   *  this installation no longer reaches the repository at all. */
  installationId: string;
  /** The owner the repository is being moved FROM (Motir's provisioning org). */
  owner: string;
  repo: string;
  /** The GitHub login it is being moved TO — a personal account or an org. */
  newOwner: string;
}

/** What GitHub's answer told us about where the repository now is. */
export interface TransferRepoResult {
  /**
   * `true` when the response says the repository ALREADY sits under `newOwner` —
   * an org target that needed no acceptance, or a redelivery of a transfer that
   * already completed. `false` means it is awaiting the new owner's accept.
   *
   * Derived from the response body's `owner.login` rather than from the status
   * code, because `202` is returned in BOTH cases: GitHub accepts the request
   * identically whether or not a human still has to confirm it.
   */
  completed: boolean;
}

export const repoTransferClient = {
  /**
   * Ask GitHub to transfer one repository to `newOwner`.
   *
   * IDEMPOTENT ENOUGH TO RETRY, which matters because the caller re-issues this
   * when a `failed` takeover is retried: transferring a repository to the owner it
   * already has answers with that owner, which this reports as `completed` rather
   * than as an error, so a retry after a lost response converges instead of
   * wedging.
   *
   * A `404` is NOT swallowed here, unlike in `actionsPermissions.ts`. There, a
   * missing repository means the intent (don't run workflows) is satisfied by its
   * absence; here it means the thing we were asked to hand over cannot be found,
   * which is a real failure the row must record rather than report as a successful
   * handoff.
   */
  async transferRepo(input: TransferRepoInput): Promise<TransferRepoResult> {
    const token = await mintToken(input.installationId);
    const url =
      `${GITHUB_API}/repos/${encodeURIComponent(input.owner)}/` +
      `${encodeURIComponent(input.repo)}/transfer`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'motir',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ new_owner: input.newOwner }),
      });
    } catch (err) {
      throw new RepoTransferError(null, err instanceof Error ? err.message : 'unknown');
    }

    // 202 Accepted is the documented success; 200 is accepted defensively because
    // the distinction is not load-bearing — the BODY is what says where the repo is.
    if (res.status !== 202 && res.status !== 200) {
      throw new RepoTransferError(res.status, await errorDetail(res));
    }

    return { completed: ownerMatches(await readOwnerLogin(res), input.newOwner) };
  },
};

/** Mint the provisioning installation token. An unwired App surfaces as the same
 *  typed error as any other refusal — the caller's contract is "this row did not
 *  settle", and WHY is a log detail, not a second branch. */
async function mintToken(installationId: string): Promise<string> {
  try {
    const { token } = await mintInstallationToken(installationId, 'provisioning');
    return token;
  } catch (err) {
    throw new RepoTransferError(null, err instanceof Error ? err.message : 'unknown');
  }
}

/** The response body's `owner.login`, or null when the body is absent/unparseable.
 *  Null is the SAFE answer — it reads as "not completed", so the saga waits for the
 *  webhook rather than declaring a handoff that may not have happened. */
async function readOwnerLogin(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return null;
    const owner = (body as Record<string, unknown>)['owner'];
    if (typeof owner !== 'object' || owner === null) return null;
    const login = (owner as Record<string, unknown>)['login'];
    return typeof login === 'string' ? login : null;
  } catch {
    return null;
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

/** GitHub logins are case-insensitive; the payload's casing need not match what
 *  the caller asked for. */
function ownerMatches(a: string | null, b: string): boolean {
  return typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

import { githubFetch } from '@/lib/github/githubFetch';
import { createAppJwt } from '@/lib/github/appAuth';
import { errorDetail } from '@/lib/github/repoDeletion';

// The App-INSTALLATION boundary (Story MOTIR-6306 · MOTIR-6397) — uninstalling
// Motir's GitHub App from a customer's account when their organization is erased,
// so Motir keeps no access to a GitHub it no longer serves.
//
// ⚠️ IT UNINSTALLS; IT NEVER TOUCHES A REPOSITORY. A customer's own repositories
// stay exactly where they are — `DELETE /app/installations/{id}` removes the
// App's grant and nothing else.
//
// Authenticated as the APP (a JWT), not as an installation: an installation token
// cannot remove its own installation. The role defaults to the user-facing App,
// which is the one customers install; the provisioning App is installed on
// Motir's own org and is never passed here.
//
// IDEMPOTENT: a `404` is SUCCESS — the customer may have uninstalled it already.

const GITHUB_API = 'https://api.github.com';

export class AppUninstallError extends Error {
  readonly code = 'GITHUB_APP_UNINSTALL_FAILED' as const;
  constructor(
    readonly status: number | null,
    readonly detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached while uninstalling the App (${detail}).`
        : `GitHub refused the App uninstall (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'AppUninstallError';
  }
}

export const appInstallationsClient = {
  /** Uninstall the user-facing App from installation `installationId`. Resolves
   *  `'uninstalled'` on `204`, `'absent'` on `404`; throws {@link AppUninstallError}. */
  async uninstallInstallation(installationId: string): Promise<'uninstalled' | 'absent'> {
    let jwt: string;
    try {
      jwt = createAppJwt(undefined, 'user-facing');
    } catch (err) {
      throw new AppUninstallError(null, err instanceof Error ? err.message : 'unknown');
    }
    let res: Response;
    try {
      res = await githubFetch(
        'app.uninstall',
        `${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}`,
        {
          method: 'DELETE',
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'motir',
            authorization: `Bearer ${jwt}`,
          },
        },
      );
    } catch (err) {
      throw new AppUninstallError(null, err instanceof Error ? err.message : 'unknown');
    }
    if (res.status === 204) return 'uninstalled';
    if (res.status === 404) return 'absent';
    throw new AppUninstallError(res.status, await errorDetail(res));
  },
};

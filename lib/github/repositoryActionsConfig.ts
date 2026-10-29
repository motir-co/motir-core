import sodium from 'libsodium-wrappers';
import { mintInstallationToken } from '@/lib/github/appAuth';

// The REPOSITORY Actions-configuration boundary (Story MOTIR-5766 · MOTIR-5775) —
// the one module that writes a repository's Actions SECRETS and VARIABLES, the
// values the starter's `preview-image` workflow reads (decision MOTIR-5769 §11:
// `MOTIR_FLY_PREVIEW_PUSH_TOKEN`, `MOTIR_HOSTING_TARGET`,
// `MOTIR_HOSTING_IMAGE_PREVIEW`, `MOTIR_HOSTING_AWS_PREVIEW_ROLE_ARN`).
//
// ⚠️ WHAT IS WRITTEN HERE TRAVELS WITH THE REPOSITORY. Unlike the ORG variables
// `lib/github/actionsVariables.ts` writes — which a repository stops resolving the
// moment MOTIR-711's takeover moves it out of Motir's org, and which that module
// therefore keeps to organization scope on purpose — a repository secret or
// variable is a property of the repository and survives the transfer. So every
// writer here has its deleter beside it, and the takeover saga calls them BEFORE
// the transfer, while the provisioning App still reaches the repository
// (`previewEnablementService.disable`). A push token left behind would let a
// repository Motir no longer owns push into Motir's registry.
//
// Authenticated as the PROVISIONING App (Motir Studio, `secrets: write` and
// `variables: write` per MOTIR-5770) through the repository's own installation —
// GitHub's numeric installation id, never the mirror's internal cuid.
//
// ⚠️ A SECRET'S VALUE NEVER LEAVES THIS MODULE IN THE CLEAR. It is sealed with the
// repository's public key (libsodium `crypto_box_seal`, the encryption GitHub
// documents) before the request is built, and no error here carries a value or a
// response body — only a status and GitHub's short `message`.

const GITHUB_API = 'https://api.github.com';

/** Which repository, through which installation. */
export interface RepositoryCoordinates {
  /** GitHub's numeric installation id the repository lives in. */
  installationId: string;
  owner: string;
  repo: string;
}

/** Any GitHub refusal or transport failure while configuring a repository's
 *  Actions. Never carries a secret value or a raw body. */
export class RepositoryActionsConfigError extends Error {
  readonly code = 'REPOSITORY_ACTIONS_CONFIG_FAILED' as const;
  constructor(
    readonly status: number | null,
    detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached while configuring repository Actions (${detail}).`
        : `GitHub refused a repository Actions call (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'RepositoryActionsConfigError';
  }
}

/** What {@link repositoryActionsConfigClient.ensureVariable} had to do. */
export type EnsureRepositoryVariableOutcome = 'created' | 'updated' | 'unchanged';

// ── Plumbing ────────────────────────────────────────────────────────────────

function base(coordinates: RepositoryCoordinates): string {
  return (
    `${GITHUB_API}/repos/${encodeURIComponent(coordinates.owner)}/` +
    `${encodeURIComponent(coordinates.repo)}/actions`
  );
}

async function tokenFor(installationId: string): Promise<string> {
  try {
    return (await mintInstallationToken(installationId, 'provisioning')).token;
  } catch (err) {
    throw new RepositoryActionsConfigError(null, err instanceof Error ? err.message : 'unknown');
  }
}

async function request(
  url: string,
  init: { method: string; token: string; body?: unknown },
): Promise<Response> {
  try {
    return await fetch(url, {
      method: init.method,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'motir',
        authorization: `Bearer ${init.token}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (err) {
    throw new RepositoryActionsConfigError(null, err instanceof Error ? err.message : 'unknown');
  }
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function refused(res: Response): Promise<RepositoryActionsConfigError> {
  const message = (await readJson(res))?.['message'];
  return new RepositoryActionsConfigError(
    res.status,
    typeof message === 'string' ? message.slice(0, 200) : '',
  );
}

/** Seal `value` for the holder of `publicKey` (base64, as GitHub returns it). */
export async function sealForRepository(value: string, publicKey: string): Promise<string> {
  await sodium.ready;
  const key = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), key);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

// ── The client ──────────────────────────────────────────────────────────────

export const repositoryActionsConfigClient = {
  /**
   * Write the repository Actions secret `name`. GitHub's `PUT` is an upsert, so a
   * re-write (a re-minted token) needs no read first; the public key is read on
   * every write because GitHub may rotate it, and a value sealed to a stale key is
   * refused.
   */
  async putSecret(
    coordinates: RepositoryCoordinates,
    name: string,
    value: string,
  ): Promise<'created' | 'updated'> {
    const token = await tokenFor(coordinates.installationId);
    const keyRes = await request(`${base(coordinates)}/secrets/public-key`, {
      method: 'GET',
      token,
    });
    if (!keyRes.ok) throw await refused(keyRes);
    const keyBody = await readJson(keyRes);
    const keyId = keyBody?.['key_id'];
    const key = keyBody?.['key'];
    if (typeof keyId !== 'string' || typeof key !== 'string') {
      throw new RepositoryActionsConfigError(keyRes.status, 'public key response had no key');
    }
    const encrypted = await sealForRepository(value, key);
    const res = await request(`${base(coordinates)}/secrets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      token,
      body: { encrypted_value: encrypted, key_id: keyId },
    });
    if (res.status === 201) return 'created';
    if (res.status === 204 || res.ok) return 'updated';
    throw await refused(res);
  },

  /** Delete the repository secret `name`. A 404 is `'absent'`: no secret is the
   *  end state wanted, whoever reached it. */
  async deleteSecret(
    coordinates: RepositoryCoordinates,
    name: string,
  ): Promise<'deleted' | 'absent'> {
    const token = await tokenFor(coordinates.installationId);
    const res = await request(`${base(coordinates)}/secrets/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      token,
    });
    if (res.status === 404) return 'absent';
    if (res.ok) return 'deleted';
    throw await refused(res);
  },

  /**
   * Make the repository variable `name` hold `value`. Read-then-write for the
   * reason `actionsVariableClient.ensureOrgVariable` gives: `POST` is create-only
   * and `PATCH` update-only, and the read makes the common case one GET. A 409 on
   * the create is a concurrent ensure that won, so it falls through to the PATCH.
   */
  async ensureVariable(
    coordinates: RepositoryCoordinates,
    name: string,
    value: string,
  ): Promise<EnsureRepositoryVariableOutcome> {
    const token = await tokenFor(coordinates.installationId);
    const url = `${base(coordinates)}/variables/${encodeURIComponent(name)}`;
    const current = await request(url, { method: 'GET', token });
    if (current.ok) {
      if ((await readJson(current))?.['value'] === value) return 'unchanged';
    } else if (current.status !== 404) {
      throw await refused(current);
    } else {
      const created = await request(`${base(coordinates)}/variables`, {
        method: 'POST',
        token,
        body: { name, value },
      });
      if (created.ok) return 'created';
      if (created.status !== 409) throw await refused(created);
    }
    const patched = await request(url, { method: 'PATCH', token, body: { name, value } });
    if (patched.ok) return 'updated';
    throw await refused(patched);
  },

  /** Delete the repository variable `name`; a 404 is `'absent'`. */
  async deleteVariable(
    coordinates: RepositoryCoordinates,
    name: string,
  ): Promise<'deleted' | 'absent'> {
    const token = await tokenFor(coordinates.installationId);
    const res = await request(`${base(coordinates)}/variables/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      token,
    });
    if (res.status === 404) return 'absent';
    if (res.ok) return 'deleted';
    throw await refused(res);
  },
};

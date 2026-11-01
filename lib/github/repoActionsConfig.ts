import 'server-only';

import sodium from 'libsodium-wrappers';
import { RepoProvisioningApiError, provisioningTransport } from '@/lib/github/repoProvisioning';
import type { GithubRepoAccess } from '@/lib/github/seedPromotion';

// A REPOSITORY's Actions configuration (Story MOTIR-9797 · MOTIR-10027): an
// environment with a deployment-branch rule, an ENVIRONMENT secret, and
// REPOSITORY variables — what production enablement writes into a Motir
// repository so the starter's production-image workflow can push.
//
// ⚠️ ITS OWN MODULE, NOT `lib/github/actionsVariables.ts`. That module is
// organisation-scope only on purpose: a repository variable survives a transfer,
// which for the runner variable would strand a transferred repository's jobs.
// The hosting ADR (MOTIR-5769 §11) is what requires repository-scope writes
// here, and the takeover decision (MOTIR-9802) owns what happens to them when the
// repository leaves. Keeping them apart keeps that guarantee one module wide.
//
// Every request goes through `provisioningTransport`, so tests stub it at the
// same `fetch` boundary as establish. A LEAF PRIMITIVE: services import it,
// routes never do. Nothing here logs, and no error carries a secret value.

const GITHUB_API = 'https://api.github.com';

const { request, readJson, asRecord, errorDetail } = provisioningTransport;

function repoPath(access: Pick<GithubRepoAccess, 'owner' | 'repo'>): string {
  return `${GITHUB_API}/repos/${encodeURIComponent(access.owner)}/${encodeURIComponent(access.repo)}`;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function refuse(res: Response): Promise<never> {
  throw new RepoProvisioningApiError(res.status, errorDetail(await readJson(res)));
}

/**
 * Seal `value` for a repository's Actions public key — libsodium's sealed box
 * (`crypto_box_seal`), the encryption GitHub requires for a secret value. Only
 * the holder of the repository's private key (GitHub) can open it.
 */
export async function sealForGithub(value: string, publicKeyBase64: string): Promise<string> {
  await sodium.ready;
  const key = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), key);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

export const repoActionsConfig = {
  /**
   * Ensure environment `environment` exists and only `branch` may deploy to it:
   * custom branch policies on, exactly one policy naming `branch`, any other one
   * removed. Every call converges, so it is safe to repeat.
   */
  async ensureBranchOnlyEnvironment(
    access: GithubRepoAccess,
    environment: string,
    branch: string,
  ): Promise<void> {
    const envPath = `${repoPath(access)}/environments/${encodeURIComponent(environment)}`;
    const put = await request(envPath, {
      method: 'PUT',
      headers: authHeaders(access.token),
      body: JSON.stringify({
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      }),
    });
    if (!put.ok) await refuse(put);

    const policiesPath = `${envPath}/deployment-branch-policies`;
    const listed = await request(`${policiesPath}?per_page=100`, {
      method: 'GET',
      headers: authHeaders(access.token),
    });
    if (!listed.ok) await refuse(listed);
    const body = await readJson(listed);
    const policies = Array.isArray(body?.['branch_policies']) ? body['branch_policies'] : [];
    let hasBranch = false;
    for (const raw of policies) {
      const policy = asRecord(raw);
      const isBranch = policy?.['name'] === branch && (policy?.['type'] ?? 'branch') === 'branch';
      if (isBranch) {
        hasBranch = true;
        continue;
      }
      const deleted = await request(`${policiesPath}/${String(policy?.['id'])}`, {
        method: 'DELETE',
        headers: authHeaders(access.token),
      });
      if (!deleted.ok && deleted.status !== 404) await refuse(deleted);
    }
    if (hasBranch) return;
    const created = await request(policiesPath, {
      method: 'POST',
      headers: authHeaders(access.token),
      body: JSON.stringify({ name: branch, type: 'branch' }),
    });
    if (!created.ok) await refuse(created);
  },

  /** Create or replace an ENVIRONMENT secret, sealed with the repository's
   *  environment public key before it leaves the process. */
  async putEnvironmentSecret(
    access: GithubRepoAccess,
    environment: string,
    name: string,
    value: string,
  ): Promise<void> {
    const base = `${repoPath(access)}/environments/${encodeURIComponent(environment)}/secrets`;
    const keyRes = await request(`${base}/public-key`, {
      method: 'GET',
      headers: authHeaders(access.token),
    });
    if (!keyRes.ok) await refuse(keyRes);
    const keyBody = await readJson(keyRes);
    const keyId = keyBody?.['key_id'];
    const key = keyBody?.['key'];
    if (typeof keyId !== 'string' || typeof key !== 'string') {
      throw new RepoProvisioningApiError(keyRes.status, 'public key read returned no key');
    }
    const put = await request(`${base}/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: authHeaders(access.token),
      body: JSON.stringify({ encrypted_value: await sealForGithub(value, key), key_id: keyId }),
    });
    if (!put.ok) await refuse(put);
  },

  /** Create a REPOSITORY variable, or update it when its value differs. A value
   *  already right writes nothing. */
  async setRepositoryVariable(
    access: GithubRepoAccess,
    name: string,
    value: string,
  ): Promise<void> {
    const base = `${repoPath(access)}/actions/variables`;
    const read = await request(`${base}/${encodeURIComponent(name)}`, {
      method: 'GET',
      headers: authHeaders(access.token),
    });
    if (read.status === 404) {
      const created = await request(base, {
        method: 'POST',
        headers: authHeaders(access.token),
        body: JSON.stringify({ name, value }),
      });
      if (!created.ok) await refuse(created);
      return;
    }
    if (!read.ok) await refuse(read);
    if ((await readJson(read))?.['value'] === value) return;
    const patched = await request(`${base}/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: authHeaders(access.token),
      body: JSON.stringify({ name, value }),
    });
    if (!patched.ok) await refuse(patched);
  },
};
